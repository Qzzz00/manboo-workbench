// 流式合成(2026-09-23,冲着通道层那条 `tts_first_ms` 1441/1559ms 去的)。
//
// 这一组钉五件:
//   ① 火山 v1 的**帧编解码**(没有密钥也验得到底:这是唯一能在本机验完的一层);
//   ② V3 单向流式的 **NDJSON 边收边解**(一行一块音频,不等整条流读完);
//   ③ `/api/tts/stream` 的**分包**:一块音频一帧,末尾一定有「完了」;
//   ④ **回退**:流式失败(一包都没发出去)→ 当场走非流式,调用方照样拿得到声音;
//   ⑤ **熔断**:回退过一次就先不再试(不然每句都要白试一次 = 比从前更慢)。
//
// 上游(火山)在测试里全部打桩,**不联网、不碰密钥**。真接火山要密钥,这台机器上没有 ——
// 那一段如实记在 docs/交接-0923-合成首包与模型首字.md 的「遗留」里。
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { require, tempHome, cleanupHome, listen, json, buildLive2dZip, zipForm } from './_setup.mjs';

const home = tempHome('tts-stream');
const { createApp } = require('../server/app.cjs');
const { db } = require('../server/db.cjs');
const ttsSynthesizer = require('../server/services/ttsSynthesizer.cjs');
const volcTtsStream = require('../server/services/volcTtsStream.cjs');
const ttsStreamRoute = require('../server/routes/api/ttsStream.cjs');
const ttsVoices = require('../server/services/ttsVoices.cjs');

const { FRAME_AUDIO, FRAME_END, FRAME_ERROR } = ttsStreamRoute;
const VOICE = ttsVoices.VOLC_OFFICIAL_VOICES[0].id;

let srv;
let avatarId;
const originalSynthesize = ttsSynthesizer.synthesize;
const originalStream = volcTtsStream.streamSynthesize;

beforeAll(async () => {
  srv = await listen(createApp());
  const r = await json(srv.base, '/admin/avatars', {
    method: 'POST',
    body: zipForm(buildLive2dZip(), { name: '沉稳', summary: 's', persona: {}, transform: {} }),
  });
  avatarId = r.body.avatar.id;
  expect((await json(srv.base, `/admin/avatars/${avatarId}/publish`, { method: 'POST', body: {} })).status).toBe(200);
  // 配一把假的火山密钥:这一组测的是「拿到密钥之后怎么走」,上游全部打桩。
  const p = await json(srv.base, '/admin/tts-models', {
    method: 'POST',
    body: { name: '火山', provider_type: 'volcengine', config: { appid: 'test-appid', accessToken: 'test-token', cluster: 'volcano_tts' }, isDefault: true },
  });
  expect(p.status).toBe(201);
  const bind = await json(srv.base, `/admin/avatars/${avatarId}/voice-bindings/chat`, {
    method: 'PUT',
    body: { providerId: p.body.model.id, voiceId: VOICE },
  });
  expect(bind.status).toBe(200);
});
afterAll(async () => {
  await srv.close();
  db.close();
  cleanupHome(home);
});
afterEach(() => {
  ttsSynthesizer.synthesize = originalSynthesize;
  volcTtsStream.streamSynthesize = originalStream;
  ttsStreamRoute.resetBreaker();
  delete process.env.TTS_STREAM;
});

/** 把回包读成帧数组。 */
function framesOf(buf) {
  const out = [];
  let p = 0;
  while (p + 5 <= buf.length) {
    const type = buf.readUInt8(p);
    const size = buf.readUInt32BE(p + 1);
    out.push({ type, payload: buf.subarray(p + 5, p + 5 + size) });
    p += 5 + size;
  }
  return out;
}

async function postStream(body) {
  const res = await fetch(`${srv.base}/api/tts/stream`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const buf = Buffer.from(await res.arrayBuffer());
  return { res, frames: framesOf(buf), raw: buf };
}

describe('火山 v1 的帧编解码', () => {
  it('请求帧:version/headerSize、消息类型、JSON+gzip,长度对得上', () => {
    const frame = volcTtsStream.buildTtsFrame({ hello: '你好' });
    expect(frame[0]).toBe(0x11); // version=1, headerSize=1(4 字节)
    expect(frame[1]).toBe(0x10); // 完整客户端请求,无 flags
    expect(frame[2]).toBe(0x11); // JSON + gzip
    expect(frame.readUInt32BE(4)).toBe(frame.length - 8);
    const { gunzipSync } = require('node:zlib');
    expect(JSON.parse(gunzipSync(frame.subarray(8)).toString('utf8'))).toEqual({ hello: '你好' });
  });

  it('音频帧:带正序号的不是最后一包,负序号的是', () => {
    const audio = Buffer.from([1, 2, 3, 4]);
    const make = (sequence) => {
      const head = Buffer.from([0x11, (0b1011 << 4) | 0b0001, 0x00, 0x00]);
      const seq = Buffer.alloc(4); seq.writeInt32BE(sequence, 0);
      const size = Buffer.alloc(4); size.writeUInt32BE(audio.length, 0);
      return Buffer.concat([head, seq, size, audio]);
    };
    expect(volcTtsStream.parseTtsFrame(make(1))).toEqual({ kind: 'audio', audio, last: false });
    expect(volcTtsStream.parseTtsFrame(make(-3))).toEqual({ kind: 'audio', audio, last: true });
  });

  it('不带序号的确认帧没有音频', () => {
    const head = Buffer.from([0x11, (0b1011 << 4) | 0b0000, 0x00, 0x00]);
    const size = Buffer.alloc(4);
    expect(volcTtsStream.parseTtsFrame(Buffer.concat([head, size])).kind).toBe('ack');
  });

  it('错误帧:code 与人话都读得出来', () => {
    const msg = Buffer.from('quota exceeded for types: concurrency', 'utf8');
    const head = Buffer.from([0x11, (0b1111 << 4) | 0b0000, 0x00, 0x00]);
    const code = Buffer.alloc(4); code.writeUInt32BE(3001, 0);
    const size = Buffer.alloc(4); size.writeUInt32BE(msg.length, 0);
    const parsed = volcTtsStream.parseTtsFrame(Buffer.concat([head, code, size, msg]));
    expect(parsed.kind).toBe('error');
    expect(parsed.code).toBe(3001);
    expect(parsed.message).toContain('concurrency');
  });

  it('坏字节绝不抛 —— 网上来的一帧不该把整句话带走', () => {
    expect(volcTtsStream.parseTtsFrame(Buffer.alloc(0)).kind).toBe('none');
    expect(volcTtsStream.parseTtsFrame(Buffer.from([0xff, 0xff, 0xff])).kind).toBe('none');
    expect(volcTtsStream.parseTtsFrame('不是 Buffer').kind).toBe('none');
  });

  it('请求体与非流式同源:S_ 复刻音色走 volcano_icl,公版走 volcano_tts,operation 是 submit', () => {
    const cloned = volcTtsStream.v1RequestOf({ config: { appid: 'a', accessToken: 't' }, text: '你好', voice: 'S_abc' });
    expect(cloned.body.app.cluster).toBe('volcano_icl');
    expect(cloned.resourceId).toBe('volc.megatts.default');
    const official = volcTtsStream.v1RequestOf({ config: { appid: 'a', accessToken: 't' }, text: '你好', voice: VOICE });
    expect(official.body.app.cluster).toBe('volcano_tts');
    expect(official.resourceId).toBe('volc.service_type.10029');
    expect(official.body.request.operation).toBe('submit');
    // 流式只出裸 PCM:mp3 要攒够一帧才解得开,wav 的头里写着长度。
    expect(official.body.audio.encoding).toBe('pcm');
    expect(official.body.audio.rate).toBe(24000);
  });
});

describe('V3 单向流式的 NDJSON 边收边解', () => {
  it('一行一块音频,行被切开也拼得回来', () => {
    const reader = volcTtsStream.createNdjsonAudioReader();
    const line = `${JSON.stringify({ code: 0, data: Buffer.from('第一块').toString('base64') })}\n`;
    expect(reader.push(line.slice(0, 10))).toEqual([]);
    const out = reader.push(line.slice(10));
    expect(out).toHaveLength(1);
    expect(out[0].toString('utf8')).toBe('第一块');
  });

  it('心跳行 / 解不动的行一律跳过,不当成音频', () => {
    const reader = volcTtsStream.createNdjsonAudioReader();
    expect(reader.push('\n不是 JSON\n{"code":0}\n')).toEqual([]);
  });

  it('带错误码的行记下来', () => {
    const reader = volcTtsStream.createNdjsonAudioReader();
    reader.push('{"code":45000000,"message":"concurrency"}\n');
    expect(reader.error).toContain('45000000');
  });

  it('最后一行没有换行也收得了尾', () => {
    const reader = volcTtsStream.createNdjsonAudioReader();
    expect(reader.push(JSON.stringify({ data: Buffer.from('尾巴').toString('base64') }))).toEqual([]);
    expect(reader.end().map(b => b.toString('utf8'))).toEqual(['尾巴']);
  });
});

describe('POST /api/tts/stream', () => {
  it('一块音频一帧,末尾一定有「完了」', async () => {
    volcTtsStream.streamSynthesize = async ({ onChunk }) => {
      onChunk(Buffer.from([1, 2, 3, 4]));
      onChunk(Buffer.from([5, 6]));
      return { chunks: 2 };
    };
    const { res, frames } = await postStream({ text: '你好,我是事务官。', avatarId });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/vnd.butler.tts-stream');
    expect(res.headers.get('x-tts-sample-rate')).toBe('24000');
    expect(res.headers.get('x-tts-backend')).toBe('volc-stream');
    expect(frames.map(f => f.type)).toEqual([FRAME_AUDIO, FRAME_AUDIO, FRAME_END]);
    expect(frames[0].payload).toEqual(Buffer.from([1, 2, 3, 4]));
  });

  it('空 text / 不认识的 scene 一律 400,不去惊动火山', async () => {
    let called = 0;
    volcTtsStream.streamSynthesize = async () => { called += 1; return { chunks: 0 }; };
    expect((await postStream({ text: '  ', avatarId })).res.status).toBe(400);
    expect((await postStream({ text: '你好', scene: '乱写的', avatarId })).res.status).toBe(400);
    expect(called).toBe(0);
  });

  it('流式一包都没发出去就失败 → 当场回退非流式,声音照样有', async () => {
    volcTtsStream.streamSynthesize = async () => { throw new Error('volcengine TTS 流式连接失败(ECONNREFUSED)'); };
    ttsSynthesizer.synthesize = async () => ({ buffer: Buffer.from([9, 9, 9]), contentType: 'audio/pcm' });
    const { res, frames } = await postStream({ text: '你好。', avatarId });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-tts-backend')).toBe('oneshot');
    expect(frames.map(f => f.type)).toEqual([FRAME_AUDIO, FRAME_END]);
    expect(frames[0].payload).toEqual(Buffer.from([9, 9, 9]));
  });

  it('回退过一次就熔断:接下来那几句直接走非流式,不再白试', async () => {
    let streamTries = 0;
    volcTtsStream.streamSynthesize = async () => { streamTries += 1; throw new Error('走不通'); };
    ttsSynthesizer.synthesize = async () => ({ buffer: Buffer.from([1]), contentType: 'audio/pcm' });
    for (const text of ['第一句。', '第二句。', '第三句。']) {
      expect((await postStream({ text, avatarId })).res.status).toBe(200);
    }
    expect(streamTries).toBe(1);
    expect(ttsStreamRoute.streamAllowed()).toBe(false);
  });

  it('已经发出音频之后才断 → 补一个「断了」帧,**不**回退(重播会结巴)', async () => {
    let oneshot = 0;
    volcTtsStream.streamSynthesize = async ({ onChunk }) => {
      onChunk(Buffer.from([1, 2]));
      throw new Error('火山中途断了');
    };
    ttsSynthesizer.synthesize = async () => { oneshot += 1; return { buffer: Buffer.from([0]), contentType: 'audio/pcm' }; };
    const { frames } = await postStream({ text: '你好。', avatarId });
    expect(frames.map(f => f.type)).toEqual([FRAME_AUDIO, FRAME_ERROR]);
    expect(frames[1].payload.toString('utf8')).toContain('合成中途断了');
    expect(oneshot).toBe(0);
  });

  it('流式没抛错却一包音频都没给 → 照样回退,不回一条空的流', async () => {
    volcTtsStream.streamSynthesize = async () => ({ chunks: 0 });
    ttsSynthesizer.synthesize = async () => ({ buffer: Buffer.from([4, 5]), contentType: 'audio/pcm' });
    const { res, frames } = await postStream({ text: '你好。', avatarId });
    expect(res.headers.get('x-tts-backend')).toBe('oneshot');
    expect(frames.map(f => f.type)).toEqual([FRAME_AUDIO, FRAME_END]);
    expect(frames[0].payload).toEqual(Buffer.from([4, 5]));
  });

  it('TTS_STREAM=off:一次都不试,行为逐字回到非流式', async () => {
    process.env.TTS_STREAM = 'off';
    let streamTries = 0;
    volcTtsStream.streamSynthesize = async () => { streamTries += 1; return { chunks: 0 }; };
    ttsSynthesizer.synthesize = async () => ({ buffer: Buffer.from([7]), contentType: 'audio/pcm' });
    const { res, frames } = await postStream({ text: '你好。', avatarId });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-tts-backend')).toBe('oneshot');
    expect(streamTries).toBe(0);
    expect(frames.map(f => f.type)).toEqual([FRAME_AUDIO, FRAME_END]);
  });

  it('两条路都不行 → 502 带上游原话,**不编假音频**', async () => {
    volcTtsStream.streamSynthesize = async () => { throw new Error('流式走不通'); };
    ttsSynthesizer.synthesize = async () => { throw new Error('volcengine TTS HTTP 429 code=3001 quota exceeded for types: concurrency'); };
    const res = await fetch(`${srv.base}/api/tts/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '你好。', avatarId }),
    });
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.code).toBe('tts_failed');
    expect(body.detail).toContain('concurrency');
  });

  it('不是火山的供应商 → 415 如实说「这条路没有你」,不把 mp3 贴上 PCM 的标签', async () => {
    const avatarVoiceStore = require('../server/services/avatarVoiceStore.cjs');
    const original = avatarVoiceStore.resolveVoice;
    avatarVoiceStore.resolveVoice = () => ({
      source: 'binding', voiceId: 'female-tianmei',
      provider: { provider_type: 'minimax', config: { apiKey: 'k', groupId: 'g' } },
    });
    try {
      const res = await fetch(`${srv.base}/api/tts/stream`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: '你好。', avatarId }),
      });
      expect(res.status).toBe(415);
      expect((await res.json()).code).toBe('stream_unsupported');
    }
    finally { avatarVoiceStore.resolveVoice = original; }
  });

  it('老的 /api/tts 一个字节都没变(还是整段音频,不是帧流)', async () => {
    ttsSynthesizer.synthesize = async () => ({ buffer: Buffer.from([1, 2, 3]), contentType: 'audio/wav' });
    const res = await fetch(`${srv.base}/api/tts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '你好。', avatarId, encoding: 'wav' }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('audio/wav');
    expect(Buffer.from(await res.arrayBuffer())).toEqual(Buffer.from([1, 2, 3]));
  });
});
