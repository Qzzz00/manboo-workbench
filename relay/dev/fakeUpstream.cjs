'use strict';

// 假上游:一个会说 OpenAI 方言的最小服务器。
//
// 两处在用:
//   1. relay/tests/http.test.mjs —— 流式/非流式/429 全部对着它跑,不碰真的 api.deepseek.com
//      (跑测试要花真钱、要真 Key、还得联网,三条都不该是跑一次测试的前提);
//   2. 本机手工验收 —— 「工人 → 中转 → 假上游」那一条链路(交接文档第二节)。
//
// 它**不是**模型:回的话是写死的。要验的是「字有没有一路流到底、usage 有没有被数对」,
// 不是模型说得好不好。

const http = require('node:http');

function sse(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/**
 * 起一个假上游。
 *
 * @param expectedKey 只认这个 Bearer(用来验中转确实把上游 Key 换上去了)。undefined = 谁都认。
 * @param reply       非流式时回的整句话 / 流式时按字切开发。
 * @param usage       回包里的 usage。想验「上游没回 usage」就传 null。
 * @param failWith    传了就一律回这个状态码 + 一句错(验中转的错误转发)。
 * @param holdAfterFirstMs 流式时:**第一个字发出去之后先停这么久**再发其余的。
 *   2026-09-23 加的,只为回答一个问题:**中转自己在首字上加了多少毫秒**。
 *   真上游的首字延迟(deepseek 那 1.3~1.5 秒)量不到也不该在测试里量,
 *   但「中转收到第一个字之后,客户端多久看得见」是纯本机的、可重复的 ——
 *   这一条就是给 relay/tests/http.test.mjs 里那个「不攒 buffer」的用例用的。
 * @returns { url, port, close(), requests } —— requests 里是每一次收到的 { headers, body }。
 */
function startFakeUpstream({
  expectedKey,
  reply = '好的,我记下了。',
  usage = { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
  failWith,
  holdAfterFirstMs = 0,
  port = 0,
} = {}) {
  const requests = [];

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      let body;
      try { body = raw === '' ? undefined : JSON.parse(raw); }
      catch { body = undefined; }
      requests.push({ method: req.method, url: req.url, headers: req.headers, body });

      const auth = req.headers.authorization ?? '';
      if (expectedKey !== undefined && auth !== `Bearer ${expectedKey}`) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'bad upstream key', type: 'authentication_error' } }));
        return;
      }

      if (failWith !== undefined) {
        res.writeHead(failWith, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'upstream said no', type: 'server_error' } }));
        return;
      }

      // 图片生成(2026-09-22)。回一份最小的 OpenAI 形状,**不带 usage**——
      // 真的图片接口就是不回 token 数,中转那边"只加一次 requests"的行为要能验到。
      if (req.method === 'POST' && req.url.endsWith('/images/generations')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ created: 1, data: [{ url: 'https://example.invalid/fake.png' }] }));
        return;
      }

      if (req.method === 'GET' && req.url.endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          object: 'list',
          data: [{ id: 'deepseek-chat', object: 'model' }, { id: 'deepseek-v4-flash', object: 'model' }],
        }));
        return;
      }

      // 结尾认路径,不按 /v1 开头认:**火山方舟的路是 `/api/v3/chat/completions`**,
      // 按开头认的话豆包那一条会掉进下面的 404,而那正是这一版要验的路由。
      if (req.method === 'POST' && req.url.endsWith('/chat/completions')) {
        const model = body?.model ?? 'deepseek-chat';
        if (body?.stream === true) {
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
          const chars = [...reply];
          const chunkOf = (char) => sse({ id: 'fake', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: { content: char } }] });
          const rest = () => {
            for (const char of chars.slice(holdAfterFirstMs > 0 ? 1 : 0)) res.write(chunkOf(char));
            res.write(sse({ id: 'fake', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }));
            // 只有请求里带了 include_usage 才发这一块 —— 与真上游同一条规矩,
            // 这样测试才能验出中转确实把那个开关补上了。
            if (body?.stream_options?.include_usage === true && usage !== null) {
              res.write(sse({ id: 'fake', object: 'chat.completion.chunk', model, choices: [], usage }));
            }
            res.write('data: [DONE]\n\n');
            res.end();
          };
          if (holdAfterFirstMs > 0 && chars.length > 0) {
            // 第一个字先出门,其余的等一会儿 —— 这样「客户端多久看见第一个字」才量得出来。
            res.write(chunkOf(chars[0]));
            setTimeout(rest, holdAfterFirstMs);
            return;
          }
          rest();
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          id: 'fake', object: 'chat.completion', model,
          choices: [{ index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' }],
          ...(usage === null ? {} : { usage }),
        }));
        return;
      }

      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'no such path', type: 'invalid_request_error' } }));
    });
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const actual = server.address().port;
      resolve({
        url: `http://127.0.0.1:${actual}`,
        port: actual,
        requests,
        close: () => new Promise(done => server.close(done)),
      });
    });
  });
}

module.exports = { startFakeUpstream };

// 直接 `node dev/fakeUpstream.cjs` 起一个,给手工验收用。
if (require.main === module) {
  const port = Number.parseInt(process.env.FAKE_UPSTREAM_PORT ?? '8796', 10);
  startFakeUpstream({ port, reply: process.env.FAKE_UPSTREAM_REPLY ?? '好的,我记下了,这是假上游。' })
    .then(h => console.log(`[fake-upstream] ${h.url}`));
}
