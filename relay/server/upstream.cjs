'use strict';

// 往上游(默认 api.deepseek.com)发,把回来的东西原样转给客户端。
//
// ## 三条纪律
//
// 1. **上游 Key 只出现在这一个文件的一个 header 里。** 客户端发来的 Authorization 在
//    app.cjs 那层就被摘掉换成中转令牌校验,到这里一律重写成上游 Key。
// 2. **不改内容。** 除了 `stream_options.include_usage`(见下)与鉴权头,请求体与回包
//    一个字节都不动:改了就会变成「我们家的模型跟官方不一样」,那是最难查的一类问题。
// 3. **不留底。** 不记 messages、不记回答。要的只有 usage 里那几个数字。
//
// ## 为什么要强制打开 include_usage
//
// 流式回包默认不带 usage,不带就没法计量,不计量额度就是摆设。所以流式请求一律补上
// `stream_options: { include_usage: true }`——哪怕客户端显式写了 false。代价写在
// sse.cjs 的注释与交接文档的「限制」一节里。

const { createUsageSniffer } = require('./sse.cjs');

/** 转给上游时要带的头。客户端的 authorization / host / content-length 一律不带。 */
function upstreamHeaders(upstreamKey) {
  return {
    'authorization': `Bearer ${upstreamKey}`,
    'content-type': 'application/json',
    'accept': 'application/json',
    /**
     * **不收压缩**(2026-09-27)。node 的 fetch 默认带 `accept-encoding: gzip, deflate`,
     * 而压缩流是按块攒的:上游把第一个字发出来,压缩层完全可以先把它留在缓冲区里 ——
     * 流式回包要的恰恰是「第一个字立刻看得见」,SSE 那几 KB 省下来的流量换这个不值。
     * 非流式那条路也一起不收:整段一次性回来,压不压没区别,两条路的头保持一份好读。
     */
    'accept-encoding': 'identity',
  };
}

/** 流式请求补上计量开关。非流式原样返回(它本来就带 usage)。 */
function withUsageOptions(body) {
  if (body?.stream !== true) return body;
  return { ...body, stream_options: { ...(body.stream_options ?? {}), include_usage: true } };
}

/**
 * 回包里哪些头值得转出去。**白名单**,不是黑名单:
 * 上游的 `set-cookie`、`content-encoding`(fetch 已经解过码了,再转出去客户端会解第二遍)
 * 这类东西转出去只会出事。
 */
const PASS_THROUGH_HEADERS = ['content-type', 'x-request-id'];

function passThroughHeaders(response) {
  const out = {};
  for (const name of PASS_THROUGH_HEADERS) {
    const value = response.headers.get(name);
    if (value !== null) out[name] = value;
  }
  return out;
}

/**
 * 非流式:发、收、原样转。返回 `{ status, headers, text, usage }`。
 * usage 解析失败(上游报错、回的不是 JSON)就是 undefined——照转不误,只是这一次不计 token。
 */
async function forwardJson({ url, upstreamKey, body, fetchImpl = fetch, signal }) {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: upstreamHeaders(upstreamKey),
    body: JSON.stringify(body),
    ...(signal === undefined ? {} : { signal }),
  });
  const text = await response.text();
  let usage;
  try { usage = JSON.parse(text)?.usage ?? undefined; }
  catch { usage = undefined; }
  return { status: response.status, headers: passThroughHeaders(response), text, usage };
}

/**
 * 流式:一边转一边嗅 usage。
 *
 * `onHead(status, headers)` 在拿到响应头时叫一次(调用方这时才 writeHead),
 * `onChunk(bytes)` 每块叫一次,返回值是整条流结束后嗅到的 usage。
 *
 * **先转再记**:哪怕记账那一步炸了,用户的字也已经出去了。
 */
async function forwardStream({ url, upstreamKey, body, fetchImpl = fetch, signal, onHead, onChunk }) {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { ...upstreamHeaders(upstreamKey), accept: 'text/event-stream' },
    body: JSON.stringify(body),
    ...(signal === undefined ? {} : { signal }),
  });

  // 上游直接报错(401 / 429 / 5xx)时回的是 JSON,不是 SSE。原样转,不假装成流。
  if (!response.ok || response.body === null) {
    const text = await response.text();
    onHead(response.status, passThroughHeaders(response));
    onChunk(Buffer.from(text, 'utf8'));
    return undefined;
  }

  onHead(response.status, {
    'content-type': response.headers.get('content-type') ?? 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    'connection': 'keep-alive',
    /**
     * 「别替我缓冲」(2026-09-27)。Caddy 看见 `text/event-stream` 会自己逐块冲,
     * 这一行是给**将来**前面摆了一层 nginx / 某个云厂的网关时留的 —— 它们默认会攒。
     */
    'x-accel-buffering': 'no',
  });

  const sniffer = createUsageSniffer();
  const decoder = new TextDecoder();
  for await (const chunk of response.body) {
    const bytes = Buffer.from(chunk);
    onChunk(bytes);
    sniffer.push(decoder.decode(bytes, { stream: true }));
  }
  sniffer.end();
  return sniffer.usage();
}

/** `GET /v1/models`:拿上游的目录。回的是 `{ status, text }`,照转。 */
async function fetchModels({ url, upstreamKey, fetchImpl = fetch }) {
  const response = await fetchImpl(url, { method: 'GET', headers: upstreamHeaders(upstreamKey) });
  return { status: response.status, text: await response.text() };
}

module.exports = {
  upstreamHeaders,
  withUsageOptions,
  passThroughHeaders,
  forwardJson,
  forwardStream,
  fetchModels,
  PASS_THROUGH_HEADERS,
};
