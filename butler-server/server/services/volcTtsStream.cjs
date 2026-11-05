'use strict';

// 火山 TTS 的**流式**合成(2026-09-23)。
//
// ## 为什么要这一份
//
// Ben 2026-09-23 真机第一批数(`GET /channel/latency`,毫秒):
//   round 2: tts_first 1441   round 3: tts_first 1559
// `tts_first` 量的是「向 8792 发出 POST → 第一句的音频到手」。现在这一段里发生的是:
// 8792 向火山发一次**非流式** HTTP(`/api/v1/tts` 的 `operation: 'query'`),
// 火山把**整句**合完、base64 塞进一个 JSON 回来,8792 再把整段 body 发给工人。
// 也就是说「第一个字的声音」要等「最后一个字合完」——一句话越长等得越久,
// 而这一整段全压在他说完之后。1.4~1.6 秒里绝大部分是这么来的。
//
// 流式合成不一样:火山边合边推,第一包音频通常 200~400ms 就到。这个文件就是那条路。
//
// ## 两条路,与非流式**完全同源的路由规则**
//
//   · `saturn_*` / `*_tob` 角色扮演音色 → V3 单向流式 HTTP(`/api/v3/tts/unidirectional`)。
//     那条接口本来就是 chunked NDJSON,非流式那份只是 `await resp.text()` 把它读成了整段;
//     这里改成**边收边解**,一行一块音频。
//   · 其余(公版大模型音色、S_ 复刻音色) → V1 **WebSocket 二进制**(`/api/v1/tts/ws_binary`),
//     `operation: 'submit'`。cluster / X-Api-Resource-Id / 情绪 与 volcengine.cjs 的
//     非流式那条**用同一个函数算**(needsV3Voice / resolveVolcEmotion / clampSpeed 从那边出口),
//     抄一份的下场是「非流式能出声、流式换了个音色」,那种分叉最难查。
//
// ## 容器只有 PCM
//
// 流式的意义就是「先出声」,而 mp3 要攒够一帧才解得开、wav 的头里写着长度。
// 所以这条路一律 `encoding: 'pcm'`、`rate: 24000`,裸 16 位小端单声道 ——
// 工人拿到就能直接切帧进房,一次解码都不用。
//
// ## 纪律
//
//   · **帧编解码是纯函数**(buildTtsFrame / parseTtsFrame / createNdjsonAudioReader),
//     没有密钥也验得到底(tests/ttsStream.test.mjs)。真接火山要密钥,这台机器上没有,
//     那一段如实记「没跑过真的」——调用方(routes/api/ttsStream.cjs)因此带着回退与熔断。
//   · **绝不打印密钥**:错误信息里只有火山的 code/message,accessToken 一个字符都不出口。
//   · 失败就抛;重试与排队在 ttsQueue.cjs,这里不管。

const crypto = require('node:crypto');
const { gzipSync, gunzipSync } = require('node:zlib');
const WebSocket = require('ws');
const { needsV3Voice, resolveVolcEmotion, clampSpeed, TTS_V3_URL } = require('./volcengine.cjs');

/** V1 流式合成的 WebSocket 地址。 */
// 地址可换,见 lib/endpoints.cjs。
const TTS_WS_URL = require('../lib/endpoints.cjs').volcTtsWsUrl();

/** 流式只出这一种:裸 16 位小端单声道 PCM。 */
const STREAM_ENCODING = 'pcm';
/** 采样率。与 channel-worker 的 TTS_SAMPLE_RATE 一致(它按这个数切 20ms 一帧)。 */
const STREAM_SAMPLE_RATE = 24000;

/** 整条合成的兜底超时(毫秒)。到点还没完就断,交给调用方回退。 */
const STREAM_TIMEOUT_MS = 20_000;
/** **第一包**的超时。流式的全部意义就在这一包上,它迟到就不如回退去走非流式。 */
const FIRST_CHUNK_TIMEOUT_MS = 6_000;

// ── 火山 v1 二进制帧(与 volcAsr.cjs 同一族协议)────────────────────────────
const MSG_FULL_CLIENT = 0b0001;
const MSG_FULL_SERVER = 0b1001;
const MSG_AUDIO_SERVER = 0b1011;
const MSG_SERVER_ERROR = 0b1111;
const SER_JSON = 0b0001;
const SER_RAW = 0b0000;
const COMP_NONE = 0b0000;
const COMP_GZIP = 0b0001;

/**
 * 拼一帧「完整客户端请求」。`[4B header][4B payloadSize][payload]`,payload 是 gzip 过的 JSON。
 * header = version=1/headerSize=1、messageType/flags、serialization/compression、保留位。
 */
function buildTtsFrame(json) {
  const payload = gzipSync(Buffer.from(JSON.stringify(json), 'utf8'));
  const header = Buffer.from([
    (0b0001 << 4) | 0b0001,
    (MSG_FULL_CLIENT << 4) | 0b0000,
    (SER_JSON << 4) | COMP_GZIP,
    0x00,
  ]);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(payload.length, 0);
  return Buffer.concat([header, size, payload]);
}

/** gzip 过就解开;不是 gzip(裸 PCM)原样返回。**绝不抛**。 */
function maybeGunzip(buf, compression) {
  if (compression !== COMP_GZIP) return buf;
  if (buf.length < 2 || buf[0] !== 0x1f || buf[1] !== 0x8b) return buf;
  try { return gunzipSync(buf); }
  catch { return buf; }
}

/**
 * 解一帧服务端回包。**绝不抛** —— 网上来的字节,一帧坏掉不该把整句话带走。
 *
 * 回 `{ kind, audio?, last?, code?, message? }`:
 *   · `kind:'audio'` 音频块(`last` 为真表示这一句到头了);
 *   · `kind:'error'` 火山报错(带 code 与人话);
 *   · `kind:'ack'`   不带音频的确认帧(V1 会先回一个),什么都不用做;
 *   · `kind:'none'`  解不动 / 不认识的帧。
 */
function parseTtsFrame(buf) {
  const none = { kind: 'none' };
  if (!Buffer.isBuffer(buf) || buf.length < 8) return none;
  try {
    const headerSize = (buf[0] & 0x0f) * 4;
    const messageType = (buf[1] >> 4) & 0x0f;
    const flags = buf[1] & 0x0f;
    const compression = buf[2] & 0x0f;
    let offset = headerSize;

    if (messageType === MSG_SERVER_ERROR) {
      const code = buf.readUInt32BE(offset);
      offset += 4;
      const size = buf.readUInt32BE(offset);
      offset += 4;
      const raw = maybeGunzip(buf.subarray(offset, offset + size), compression);
      return { kind: 'error', code, message: raw.toString('utf8').slice(0, 300) };
    }

    if (messageType === MSG_AUDIO_SERVER) {
      // flags === 0:不带序号的确认帧,没有音频。
      if (flags === 0) return { kind: 'ack' };
      const sequence = buf.readInt32BE(offset);
      offset += 4;
      const size = buf.readUInt32BE(offset);
      offset += 4;
      const audio = maybeGunzip(buf.subarray(offset, offset + size), compression);
      return { kind: 'audio', audio, last: sequence < 0 };
    }

    if (messageType === MSG_FULL_SERVER) {
      const size = buf.readUInt32BE(offset);
      offset += 4;
      const raw = maybeGunzip(buf.subarray(offset, offset + size), compression);
      let json = null;
      try { json = JSON.parse(raw.toString('utf8')); }
      catch { json = null; }
      const code = json && (json.code ?? json?.header?.code);
      // 3000 / 0 / 20000000 都是「没问题」;别的当成错误如实报出去。
      if (code !== undefined && code !== null && code !== 3000 && code !== 0 && code !== 20000000) {
        return { kind: 'error', code, message: String((json && (json.message ?? json?.header?.message)) || '').slice(0, 300) };
      }
      return { kind: 'ack' };
    }

    return none;
  }
  catch {
    return none;
  }
}

/**
 * V3 单向流式的 NDJSON 读法:**一行一解**,不等整条流读完。
 *
 * 纯状态机:`push(chunk)` 回这一块里解出来的音频数组,`end()` 收尾最后一行。
 * 解不动的行原样丢掉(火山会插心跳行);带错误码的行记在 `error` 上。
 */
function createNdjsonAudioReader() {
  let buffered = '';
  let error;
  const take = (line) => {
    const s = line.trim();
    if (s === '') return undefined;
    let j;
    try { j = JSON.parse(s); }
    catch { return undefined; }
    const code = j.code ?? j?.header?.code;
    if (code !== undefined && code !== null && code !== 0 && code !== 20000000) {
      error = `code=${code} ${String(j.message ?? j?.header?.message ?? '')}`.trim();
      return undefined;
    }
    if (typeof j.data === 'string' && j.data !== '') return Buffer.from(j.data, 'base64');
    return undefined;
  };
  return {
    push(text) {
      buffered += text;
      const out = [];
      let nl = buffered.indexOf('\n');
      while (nl >= 0) {
        const audio = take(buffered.slice(0, nl));
        if (audio !== undefined) out.push(audio);
        buffered = buffered.slice(nl + 1);
        nl = buffered.indexOf('\n');
      }
      return out;
    },
    end() {
      const out = [];
      const audio = take(buffered);
      if (audio !== undefined) out.push(audio);
      buffered = '';
      return out;
    },
    get error() { return error; },
  };
}

/**
 * V1 那条路的请求体。与 volcengine.cjs 的非流式**同一套规则**,只差 operation。
 *
 * 2026-10-02:`emotion` 这一格现在也可能来自**语气**(tone → ttsTone.cjs 翻出来的那个值)。
 * V1 **没有** `context_texts`(那是 2.0 音色专有),所以那一句自然语言指令在这条路上会被丢掉 ——
 * 如实丢,不在这儿编一个等效的参数。哪些音色走哪条路见 needsV3Voice。
 */
function v1RequestOf({ config, text, voice, speed, emotion }) {
  const { appid, accessToken } = config || {};
  const isCloned = typeof voice === 'string' && voice.startsWith('S_');
  const cluster = isCloned ? 'volcano_icl' : (config.cluster || 'volcano_tts');
  // config.resourceId 只有服务器下发那一份会带(2026-09-23),与 volcengine.cjs 同一条规矩。
  const resourceId = isCloned
    ? (process.env.VOLC_TTS_CLONE_RESOURCE_ID || 'volc.megatts.default')
    : (config.resourceId || 'volc.service_type.10029');
  const volcEmotion = isCloned ? null : resolveVolcEmotion(emotion);
  return {
    resourceId,
    accessToken,
    body: {
      app: { appid, token: accessToken, cluster },
      user: { uid: 'aiboo' },
      audio: {
        voice_type: voice,
        encoding: STREAM_ENCODING,
        rate: STREAM_SAMPLE_RATE,
        speed_ratio: clampSpeed(speed),
        ...(volcEmotion ? { emotion: volcEmotion, enable_emotion: true } : {}),
      },
      request: { reqid: crypto.randomUUID(), text, text_type: 'plain', operation: 'submit' },
    },
  };
}

/** V1 WebSocket 流式。每来一块音频就 `onChunk(buffer)`,结束 resolve,出错 reject。 */
function streamV1({ config, text, voice, speed, emotion, onChunk, WebSocketImpl = WebSocket, wsUrl = TTS_WS_URL }) {
  const { appid, accessToken } = config || {};
  if (!appid || !accessToken) return Promise.reject(new Error('volcengine TTS: appid/accessToken missing'));
  if (!text || !voice) return Promise.reject(new Error('volcengine TTS: text/voice required'));
  const { resourceId, body } = v1RequestOf({ config, text, voice, speed, emotion });

  return new Promise((resolve, reject) => {
    let settled = false;
    let got = 0;
    const ws = new WebSocketImpl(wsUrl, {
      headers: {
        Authorization: `Bearer;${accessToken}`,
        'X-Api-Resource-Id': resourceId,
      },
    });
    const timers = [];
    const done = (err) => {
      if (settled) return;
      settled = true;
      for (const t of timers) clearTimeout(t);
      try { ws.close(); } catch { /* 已经关了 */ }
      if (err) reject(err);
      else resolve({ chunks: got });
    };
    timers.push(setTimeout(() => done(new Error(`volcengine TTS 流式超时(${STREAM_TIMEOUT_MS}ms)`)), STREAM_TIMEOUT_MS));
    timers.push(setTimeout(() => {
      if (got === 0) done(new Error(`volcengine TTS 流式首包超时(${FIRST_CHUNK_TIMEOUT_MS}ms)`));
    }, FIRST_CHUNK_TIMEOUT_MS));

    ws.on('open', () => {
      try { ws.send(buildTtsFrame(body)); }
      catch (err) { done(new Error(`volcengine TTS 流式发不出请求(${err.message})`)); }
    });
    ws.on('message', (data) => {
      const frame = parseTtsFrame(Buffer.isBuffer(data) ? data : Buffer.from(data));
      if (frame.kind === 'error') {
        done(new Error(`volcengine TTS 流式失败 code=${frame.code} ${frame.message}`.trim()));
        return;
      }
      if (frame.kind !== 'audio') return;
      if (frame.audio.length > 0) {
        got += 1;
        try { onChunk(frame.audio); }
        catch (err) { done(new Error(`volcengine TTS 流式下游写不进去(${err.message})`)); return; }
      }
      if (frame.last) done(null);
    });
    ws.on('error', (err) => done(new Error(`volcengine TTS 流式连接失败(${err.message})`)));
    ws.on('close', () => {
      if (got > 0) done(null);
      else done(new Error('volcengine TTS 流式连接关了,一包音频都没收到'));
    });
  });
}

/**
 * V3 那条路的请求体(2026-10-02 单独提出来,为的是**没有密钥也验得到底**:
 * 语气那三格到底有没有拼进去,tests/tts-tone.test.mjs 直接比这个对象)。
 *
 * 语气三格(卡「声音与形象跟着话走」第 2 件):
 *   · `audio_params.emotion` + `audio_params.emotion_scale`(1–5,火山缺省 4);
 *   · `req_params.additions`:**一个 JSON 序列化后的字符串**,里头 `context_texts` 是
 *     一句自然语言的语气指令(数组,只有第一条算数)。
 *
 * ⚠️ `additions` 要的是**字符串**不是对象 —— 传对象上去火山会静默忽略整段语气设置
 * (火山公开文档 + 实测博文都点名这是最容易犯的错)。这台机器上没有密钥,
 * **一次真的火山都没跑过**:待真机核,见 docs/交接-1002-语气跟着话走.md。
 *
 * 语气缺席时这个对象与 10-01 **逐字相同** —— 没有对应就退回中性那条纪律落在这里。
 */
function v3RequestOf({ text, voice, speed, tone }) {
  const emotion = tone && typeof tone.emotion === 'string' && tone.emotion !== '' ? tone.emotion : undefined;
  const scale = emotion === undefined ? undefined : tone.emotionScale;
  const contextText = tone && typeof tone.contextText === 'string' && tone.contextText !== '' ? tone.contextText : undefined;
  return {
    user: { uid: 'aiboo' },
    req_params: {
      text,
      speaker: voice,
      audio_params: {
        format: STREAM_ENCODING,
        sample_rate: STREAM_SAMPLE_RATE,
        speed_ratio: clampSpeed(speed),
        ...(emotion === undefined ? {} : { emotion }),
        ...(scale === undefined ? {} : { emotion_scale: scale }),
      },
      ...(contextText === undefined ? {} : { additions: JSON.stringify({ context_texts: [contextText] }) }),
    },
  };
}

/** V3 单向流式 HTTP。边收边解 NDJSON,每块音频立刻 `onChunk`。 */
async function streamV3({ config, text, voice, speed, tone, onChunk, fetchImpl = fetch }) {
  const { appid, accessToken } = config || {};
  if (!appid || !accessToken) throw new Error('volcengine TTS: appid/accessToken missing');
  if (!text || !voice) throw new Error('volcengine TTS: text/voice required');

  const resp = await fetchImpl(TTS_V3_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Api-App-Id': appid,
      'X-Api-Access-Key': accessToken,
      'X-Api-Resource-Id': 'seed-tts-2.0',
      'X-Api-Request-Id': crypto.randomUUID(),
    },
    body: JSON.stringify(v3RequestOf({ text, voice, speed, tone })),
  });
  if (!resp.ok || resp.body === null) {
    const text0 = await resp.text().catch(() => '');
    throw new Error(`volcengine TTS V3 流式 HTTP ${resp.status} ${text0.slice(0, 200)}`.trim());
  }

  const reader = createNdjsonAudioReader();
  const decoder = new TextDecoder();
  let got = 0;
  for await (const chunk of resp.body) {
    for (const audio of reader.push(decoder.decode(Buffer.from(chunk), { stream: true }))) {
      if (audio.length === 0) continue;
      got += 1;
      onChunk(audio);
    }
  }
  for (const audio of reader.end()) {
    if (audio.length === 0) continue;
    got += 1;
    onChunk(audio);
  }
  if (reader.error !== undefined && got === 0) throw new Error(`volcengine TTS V3 流式失败 ${reader.error}`);
  if (got === 0) throw new Error('volcengine TTS V3 流式一包音频都没给');
  return { chunks: got };
}

/**
 * 流式合成一句话。音色决定走哪条路(与非流式同源)。
 * 每块音频调一次 `onChunk(Buffer)`,全部是裸 16 位小端单声道 PCM @ 24000Hz。
 */
async function streamSynthesize({ provider, text, voice, speed, emotion, tone, onChunk, deps = {} }) {
  if (!provider || provider.provider_type !== 'volcengine') {
    throw new Error(`流式合成只支持火山,这台配的是 ${provider && provider.provider_type ? provider.provider_type : '(没配)'}`);
  }
  const config = provider.config || {};
  if (needsV3Voice(voice)) return streamV3({ config, text, voice, speed, tone, onChunk, ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}) });
  /**
   * V1 这条路上**语气只剩那一个枚举**(2026-10-02):`tone.emotion` 盖掉调用方直接传的 `emotion`
   * —— 两格同时在的时候「这一句的语气」比「这一通的缺省情绪」更该算数。
   * 那一句自然语言指令在这条路上没有去处,如实丢掉(见 v1RequestOf 的注释)。
   */
  const v1Emotion = tone && typeof tone.emotion === 'string' && tone.emotion !== '' ? tone.emotion : emotion;
  return streamV1({ config, text, voice, speed, emotion: v1Emotion, onChunk, ...(deps.WebSocketImpl ? { WebSocketImpl: deps.WebSocketImpl } : {}), ...(deps.wsUrl ? { wsUrl: deps.wsUrl } : {}) });
}

module.exports = {
  streamSynthesize,
  streamV1,
  streamV3,
  buildTtsFrame,
  parseTtsFrame,
  createNdjsonAudioReader,
  v1RequestOf,
  v3RequestOf,
  TTS_WS_URL,
  STREAM_ENCODING,
  STREAM_SAMPLE_RATE,
  STREAM_TIMEOUT_MS,
  FIRST_CHUNK_TIMEOUT_MS,
  MSG_AUDIO_SERVER,
  MSG_SERVER_ERROR,
  MSG_FULL_SERVER,
  SER_RAW,
  COMP_NONE,
  COMP_GZIP,
};
