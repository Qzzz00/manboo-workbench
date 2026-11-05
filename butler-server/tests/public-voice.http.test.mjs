// 手机用的语音接口(2026-09-14):
//   POST /api/tts        { text, avatarId?, voiceId?, scene?, encoding? } → 音频
//   POST /api/asr        { audio: base64 wav } 或 audio/wav 裸 body → { text }
//   POST /api/rtc/token  → 火山 RTC 房间与进房 token;/api/rtc/start|stop 通话记录按 X-Workbench-Device 落
// 没有密钥 → 503 带人话(RTC 仍是「未配置语音供应商密钥」;TTS/ASR 2026-09-23 起按原因说),不编假音频。上游(火山/MiniMax)在测试里全部打桩,不联网。
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { require, tempHome, cleanupHome, listen, json, buildLive2dZip, zipForm } from './_setup.mjs';

const home = tempHome('public-voice');
const { createApp } = require('../server/app.cjs');
const { db } = require('../server/db.cjs');
const ttsSynthesizer = require('../server/services/ttsSynthesizer.cjs');
const volcAsr = require('../server/services/volcAsr.cjs');
const volcengineRtc = require('../server/services/volcengineRtc.cjs');
const ttsVoices = require('../server/services/ttsVoices.cjs');

const NO_KEY = '未配置语音供应商密钥';
// 2026-09-23 起 TTS / ASR 没钥匙时说的是能行动的人话(测试里工作台下发那条关着,原因是「还没拿到」)。
const NO_TTS_KEY = '还没拿到服务器下发的语音合成钥匙,她暂时开不了口;登录之后会自己拿到。';
const NO_ASR_KEY = '还没拿到服务器下发的语音识别钥匙,她暂时听不懂;登录之后会自己拿到。';
const VOICE = ttsVoices.VOLC_OFFICIAL_VOICES[0].id;
const VOICE_2 = ttsVoices.VOLC_OFFICIAL_VOICES[1].id;

let srv;
let avatarId;
const originalSynthesize = ttsSynthesizer.synthesize;
const originalTranscribe = volcAsr.transcribe;

beforeAll(async () => {
  srv = await listen(createApp());
  const r = await json(srv.base, '/admin/avatars', {
    method: 'POST',
    body: zipForm(buildLive2dZip(), { name: '沉稳', summary: 's', persona: {}, transform: {} }),
  });
  avatarId = r.body.avatar.id;
  expect((await json(srv.base, `/admin/avatars/${avatarId}/publish`, { method: 'POST', body: {} })).status).toBe(200);
});
afterAll(async () => {
  await srv.close();
  db.close();
  cleanupHome(home);
});
afterEach(() => {
  ttsSynthesizer.synthesize = originalSynthesize;
  volcAsr.transcribe = originalTranscribe;
});

function wav(pcm) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24);
  header.writeUInt32LE(32000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

describe('没有密钥时', () => {
  it('POST /api/tts → 503 + 人话,不编音频', async () => {
    const r = await json(srv.base, '/api/tts', { method: 'POST', body: { text: '你好', avatarId } });
    expect(r.status).toBe(503);
    expect(r.body).toEqual({ code: 'voice_not_configured', error: NO_TTS_KEY });
  });

  it('POST /api/asr → 503 + 人话', async () => {
    const r = await json(srv.base, '/api/asr', { method: 'POST', body: { audio: wav(Buffer.alloc(3200)).toString('base64') } });
    expect(r.status).toBe(503);
    expect(r.body.error).toBe(NO_ASR_KEY);
  });

  it('POST /api/rtc/token 与 /start /stop → 503 + 人话', async () => {
    for (const p of ['/api/rtc/token', '/api/rtc/start', '/api/rtc/stop']) {
      const r = await json(srv.base, p, { method: 'POST', body: { roomId: 'r', taskId: 't', userId: 'u' } });
      expect(r.status, p).toBe(503);
      expect(r.body.error, p).toBe(NO_KEY);
    }
  });

  it('参数不对先回 400(与有没有密钥无关)', async () => {
    expect((await json(srv.base, '/api/tts', { method: 'POST', body: {} })).status).toBe(400);
    expect((await json(srv.base, '/api/asr', { method: 'POST', body: {} })).status).toBe(400);
    expect((await json(srv.base, '/api/asr', { method: 'POST', body: { audio: '' } })).status).toBe(400);
  });
});

describe('配了火山 TTS 之后', () => {
  let ttsId;
  it('新增默认火山供应商', async () => {
    const r = await json(srv.base, '/admin/tts-models', {
      method: 'POST',
      body: { name: '火山', provider_type: 'volcengine', config: { appid: 'app-1', accessToken: 'secret-token-1234', cluster: 'volcano_tts' }, isDefault: true },
    });
    expect(r.status).toBe(201);
    ttsId = r.body.model.id;
  });

  it('POST /api/tts 按形象绑定的音色合成,回 audio/mpeg', async () => {
    expect((await json(srv.base, `/admin/avatars/${avatarId}/voice-bindings/chat`, { method: 'PUT', body: { providerId: ttsId, voiceId: VOICE } })).status).toBe(200);
    const calls = [];
    ttsSynthesizer.synthesize = async (args) => {
      calls.push(args);
      return { buffer: Buffer.from('ID3fake-mp3'), contentType: 'audio/mpeg' };
    };
    const res = await fetch(`${srv.base}/api/tts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // 客户端传的 voiceId 不算数:绑定权威。
      body: JSON.stringify({ text: '早上好', avatarId, voiceId: VOICE_2 }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('audio/mpeg');
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe('ID3fake-mp3');
    expect(calls).toHaveLength(1);
    expect(calls[0].voice).toBe(VOICE);
    expect(calls[0].text).toBe('早上好');
    expect(calls[0].provider.provider_type).toBe('volcengine');
    expect(calls[0].provider.config.accessToken).toBe('secret-token-1234');
  });

  it('没绑定的形象 / 没给 avatarId:客户端 voiceId 生效,再不行用供应商默认音色', async () => {
    const calls = [];
    ttsSynthesizer.synthesize = async (args) => { calls.push(args); return { buffer: Buffer.from('x'), contentType: 'audio/mpeg' }; };
    expect((await json(srv.base, '/api/tts', { method: 'POST', body: { text: '嗯', voiceId: VOICE_2 } })).status).toBe(200);
    expect(calls[0].voice).toBe(VOICE_2);
    expect((await json(srv.base, '/api/tts', { method: 'POST', body: { text: '嗯' } })).status).toBe(200);
    expect(calls[1].voice).toBe(ttsVoices.DEFAULT_VOLC_VOICE);
  });

  it('上游失败 → 502,错误信息不带密钥', async () => {
    ttsSynthesizer.synthesize = async () => { throw new Error('volcengine 403 token=secret-token-1234'); };
    const r = await json(srv.base, '/api/tts', { method: 'POST', body: { text: '嗯', avatarId } });
    expect(r.status).toBe(502);
    expect(JSON.stringify(r.body)).not.toContain('secret-token');
  });

  /**
   * 串行队列(2026-09-20,决策记录「②补」)。通道层的工人把一段回复按句切开之后是
   * **并发**送来合成的 —— 四小块 = 同一瞬间四条 /api/tts,撞了火山按账号算的并发配额
   * (`HTTP 429 code=3001 quota exceeded for types: concurrency`)。
   * 门设在这里而不是只设在工人那边:这台服务不止一个调用方。
   */
  it('四条同时打进来,火山那头同一时刻只被叫一次', async () => {
    let active = 0;
    let peak = 0;
    ttsSynthesizer.synthesize = async () => {
      active += 1; peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
      return { buffer: Buffer.from('audio'), contentType: 'audio/mpeg' };
    };
    const results = await Promise.all(['一', '二', '三', '四'].map((text) =>
      json(srv.base, '/api/tts', { method: 'POST', body: { text, avatarId } })));
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200]);
    expect(peak).toBe(1);
  });

  /**
   * detail:上游原话带给调用方(2026-09-20,Ben 真机第二轮「十分钟断线」)。
   *
   * 那一通里通道层工人的日志只有「合成失败(502)」,真正的原因躺在这台进程自己的 stderr:
   *   `volcengine TTS HTTP 429 code=3001 quota exceeded for types: concurrency`
   * 两份日志对不上时间就等于没有证据。脱敏口径不变(同一个 redact)。
   */
  it('502 带上游原话 detail,而且照样不带密钥', async () => {
    ttsSynthesizer.synthesize = async () => {
      throw new Error('volcengine TTS HTTP 429 code=3001 quota exceeded for types: concurrency;token=secret-token-1234');
    };
    const r = await json(srv.base, '/api/tts', { method: 'POST', body: { text: '嗯', avatarId } });
    expect(r.status).toBe(502);
    expect(r.body.code).toBe('tts_failed');
    expect(r.body.detail).toContain('quota exceeded for types: concurrency');
    expect(r.body.detail).toContain('429');
    expect(JSON.stringify(r.body)).not.toContain('secret-token');
    expect(r.body.detail).toContain('[已隐去]');
  });

  /**
   * encoding 透传(2026-09-17 通道层)。通道层的工人要 wav:LiveKit 吃 PCM,
   * mp3 还得再解一次码。默认仍是 mp3 —— 手机与管理台拿到的东西一个字节都没变。
   */
  it('encoding=wav 透传给供应商,content-type 跟着变;不传时还是 mp3', async () => {
    const calls = [];
    ttsSynthesizer.synthesize = async (args) => {
      calls.push(args);
      return args.encoding === 'wav'
        ? { buffer: Buffer.from('RIFFfake-wav'), contentType: 'audio/wav' }
        : { buffer: Buffer.from('ID3fake-mp3'), contentType: 'audio/mpeg' };
    };
    const asWav = await fetch(`${srv.base}/api/tts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '好,记下了。', encoding: 'wav' }),
    });
    expect(asWav.status).toBe(200);
    expect(asWav.headers.get('content-type')).toBe('audio/wav');
    expect(calls[0].encoding).toBe('wav');

    expect((await json(srv.base, '/api/tts', { method: 'POST', body: { text: '好' } })).status).toBe(200);
    // 不传时路由自己补 'mp3' —— 与下游原来的默认是同一个值,老调用方拿到的东西一个字节都没变。
    expect(calls[1].encoding).toBe('mp3');
  });

  it('不认识的 encoding → 400,不去猜他想要什么容器', async () => {
    const r = await json(srv.base, '/api/tts', { method: 'POST', body: { text: '好', encoding: 'opus' } });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('invalid_encoding');
  });

  it('文本超长 → 400', async () => {
    const r = await json(srv.base, '/api/tts', { method: 'POST', body: { text: '好'.repeat(2001) } });
    expect(r.status).toBe(400);
  });

  it('ASR 凭证回落到默认火山 TTS 的 appid/accessToken:POST /api/asr 回文字', async () => {
    const calls = [];
    volcAsr.transcribe = async (buffer, creds, hotwords) => { calls.push({ buffer, creds, hotwords }); return '明天上午开会'; };
    const audio = wav(Buffer.alloc(6400, 1));
    const r = await json(srv.base, '/api/asr', { method: 'POST', body: { audio: `data:audio/wav;base64,${audio.toString('base64')}` } });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ text: '明天上午开会' });
    expect(calls[0].buffer.equals(audio)).toBe(true);
    expect(calls[0].creds).toMatchObject({ appId: 'app-1', accessToken: 'secret-token-1234', resourceId: 'volc.bigasr.sauc.duration' });
  });

  it('裸 audio/wav body 也收', async () => {
    volcAsr.transcribe = async () => '收到';
    const res = await fetch(`${srv.base}/api/asr`, { method: 'POST', headers: { 'content-type': 'audio/wav' }, body: wav(Buffer.alloc(3200)) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: '收到' });
  });

  it('webm/opus 不支持 → 415 说清楚要 wav', async () => {
    volcAsr.transcribe = async () => { throw new Error('should not be called'); };
    const res = await fetch(`${srv.base}/api/asr`, { method: 'POST', headers: { 'content-type': 'audio/webm' }, body: Buffer.from('\x1aE\xdf\xa3webm', 'binary') });
    expect(res.status).toBe(415);
    expect((await res.json()).error).toContain('wav');
    // base64 里塞 webm 一样拒。
    const r = await json(srv.base, '/api/asr', { method: 'POST', body: { audio: Buffer.from('\x1aE\xdf\xa3webm', 'binary').toString('base64') } });
    expect(r.status).toBe(415);
  });

  it('超过 60 秒 → 400', async () => {
    volcAsr.transcribe = async () => 'x';
    const r = await json(srv.base, '/api/asr', { method: 'POST', body: { audio: wav(Buffer.alloc(16000 * 2 * 61)).toString('base64') } });
    expect(r.status).toBe(400);
  });

  it('没听清 → 422;上游错 → 502 且不带密钥', async () => {
    volcAsr.transcribe = async () => { throw new Error('EMPTY_TRANSCRIPT'); };
    expect((await json(srv.base, '/api/asr', { method: 'POST', body: { audio: wav(Buffer.alloc(320)).toString('base64') } })).status).toBe(422);
    volcAsr.transcribe = async () => { throw new Error('火山 ASR 连接失败: secret-token-1234'); };
    const r = await json(srv.base, '/api/asr', { method: 'POST', body: { audio: wav(Buffer.alloc(320)).toString('base64') } });
    expect(r.status).toBe(502);
    expect(JSON.stringify(r.body)).not.toContain('secret-token');
  });
});

describe('配了火山 RTC 之后', () => {
  const APP_ID = 'a'.repeat(24);
  let restore;
  const openApiCalls = [];
  beforeAll(async () => {
    const r = await json(srv.base, '/admin/rtc-providers', {
      method: 'POST',
      body: {
        name: '火山通话', provider_type: 'volcengine_rtc', isDefault: true,
        config: { appId: APP_ID, appKey: 'app-key-secret', accessKeyId: 'ak', secretAccessKey: 'sk-xyz', asrAppId: 'asr-app', asrAccessToken: 'asr-token', ttsAppId: 'app-1', arkEndpointId: 'ep-1' },
      },
    });
    expect(r.status).toBe(201);
    restore = volcengineRtc.__setOpenAPI(async (action, body) => { openApiCalls.push({ action, body }); return { Result: 'ok' }; });
  });
  afterAll(() => restore && restore());

  it('POST /api/rtc/token 回 appId/roomId/userId/token;userId 带设备 id;appKey 不出口', async () => {
    const r = await json(srv.base, '/api/rtc/token', { method: 'POST', body: {}, headers: { 'x-workbench-device': 'dev_phone1' } });
    expect(r.status).toBe(200);
    expect(r.body.appId).toBe(APP_ID);
    expect(r.body.roomId).toMatch(/^room_/);
    expect(r.body.userId).toMatch(/^user_dev_phone1_/);
    expect(volcengineRtc.parseToken(r.body.token)).toMatchObject({ appID: APP_ID, roomID: r.body.roomId, userID: r.body.userId });
    expect(JSON.stringify(r.body)).not.toContain('app-key-secret');
  });

  it('ASR 凭证优先取 RTC 供应商的 asrAppId/asrAccessToken', async () => {
    const calls = [];
    volcAsr.transcribe = async (buffer, creds) => { calls.push(creds); return '好'; };
    expect((await json(srv.base, '/api/asr', { method: 'POST', body: { audio: wav(Buffer.alloc(320)).toString('base64') } })).status).toBe(200);
    expect(calls[0]).toMatchObject({ appId: 'asr-app', accessToken: 'asr-token' });
  });

  it('start 落一条通话记录(按 X-Workbench-Device),stop 结算;重复 stop 幂等', async () => {
    const start = await json(srv.base, '/api/rtc/start', {
      method: 'POST',
      headers: { 'x-workbench-device': 'dev_phone1' },
      body: { roomId: 'room_1', userId: 'user_dev_phone1_x', avatarId, voice: VOICE, systemMessage: '你是事务官' },
    });
    expect(start.status).toBe(200);
    expect(start.body.taskId).toMatch(/^task_/);
    expect(openApiCalls.at(-1).action).toBe('StartVoiceChat');
    expect(openApiCalls.at(-1).body.Config.TTSConfig.ProviderParams.audio.voice_type).toBe(VOICE);
    const row = db.prepare('SELECT * FROM call_records WHERE task_id = ?').get(start.body.taskId);
    expect(row).toMatchObject({ device_id: 'dev_phone1', avatar_id: avatarId, room_id: 'room_1', ended_at: null });

    const stop = await json(srv.base, '/api/rtc/stop', { method: 'POST', body: { roomId: 'room_1', taskId: start.body.taskId } });
    expect(stop.status).toBe(200);
    expect(stop.body.stopped).toBe(true);
    expect(db.prepare('SELECT end_reason FROM call_records WHERE task_id = ?').get(start.body.taskId).end_reason).toBe('normal');

    const again = await json(srv.base, '/api/rtc/stop', { method: 'POST', body: { roomId: 'room_1', taskId: start.body.taskId } });
    expect(again.body.alreadySettled).toBe(true);
    expect(openApiCalls.filter((c) => c.action === 'StopVoiceChat')).toHaveLength(1);
  });

  it('没带设备头(本机回环)记成 local', async () => {
    const start = await json(srv.base, '/api/rtc/start', { method: 'POST', body: { roomId: 'room_2', userId: 'u', voice: VOICE } });
    expect(start.status).toBe(200);
    expect(db.prepare('SELECT device_id FROM call_records WHERE task_id = ?').get(start.body.taskId).device_id).toBe('local');
  });

  it('未发布的形象不能通话 → 409', async () => {
    const r = await json(srv.base, '/admin/avatars', { method: 'POST', body: zipForm(buildLive2dZip(), { name: '草', summary: '', persona: {}, transform: {} }) });
    const start = await json(srv.base, '/api/rtc/start', { method: 'POST', body: { roomId: 'r', userId: 'u', avatarId: r.body.avatar.id, voice: VOICE } });
    expect(start.status).toBe(409);
  });
});
