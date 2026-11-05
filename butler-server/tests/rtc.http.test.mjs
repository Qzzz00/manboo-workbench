// 手机通话模式的后端链路(2026-09-17,交接-0917-手机通话模式):
//   GET  /api/rtc/status          配了通话供应商没有——只回一个 true/false,不回任何密钥字段
//   POST /api/rtc/token           进房 token(appKey 只在服务端)
//   POST /api/rtc/start           智能体进房;工作台给的 systemMessage / tools / functionCalling 原样下发
//   POST /api/rtc/stop            挂断并结算通话记录,回时长
//   POST /api/rtc/function-result 通话中把工具结果回填给智能体(火山 UpdateVoiceChat Command='function')
//
// 火山那一侧整段用 volcengineRtc.__setOpenAPI 假掉:这里验的是我们发出去的请求体长什么样、
// 通话记录有没有落、密钥有没有漏,不是火山会不会答应。
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { require, tempHome, cleanupHome, listen, json } from './_setup.mjs';

const home = tempHome('rtc');
const { createApp } = require('../server/app.cjs');
const { db } = require('../server/db.cjs');
const rtcProviderStore = require('../server/services/rtcProviderStore.cjs');
const callRecordStore = require('../server/services/callRecordStore.cjs');
const volcengineRtc = require('../server/services/volcengineRtc.cjs');

// 24 位假 AppId(生成 token 时长度会被校验),其余全是一眼假的占位值。
const FAKE = {
  appId: 'a'.repeat(24),
  appKey: 'fake-app-key-0000',
  accessKeyId: 'fake-ak',
  secretAccessKey: 'fake-sk-0000',
  asrAppId: 'fake-asr-app',
  asrAccessToken: 'fake-asr-token-0000',
  ttsAppId: 'fake-tts-app',
  ttsCluster: 'volcano_tts',
  arkEndpointId: 'ep-fake-0000',
};

let srv;
let restore;
/** 每次 startVoiceChat / stopVoiceChat 发给火山的 (action, body)。 */
let calls = [];

beforeAll(async () => {
  srv = await listen(createApp());
  restore = volcengineRtc.__setOpenAPI((action, body) => {
    calls.push({ action, body });
    return Promise.resolve({ ok: true, action });
  });
});
afterAll(async () => {
  restore();
  await srv.close();
  db.close();
  cleanupHome(home);
});
beforeEach(() => { calls = []; });

function addProvider(overrides = {}) {
  return rtcProviderStore.create(db, {
    name: '火山 RTC(测试)',
    provider_type: 'volcengine_rtc',
    config: { ...FAKE, ...overrides },
    isDefault: true,
  });
}

function removeAllProviders() {
  for (const p of rtcProviderStore.list(db)) rtcProviderStore.remove(db, p.id);
}

describe('没配供应商', () => {
  it('GET /api/rtc/status 回 configured:false 与一句人话,不是错误栈', async () => {
    removeAllProviders();
    const r = await json(srv.base, '/api/rtc/status');
    expect(r.status).toBe(200);
    expect(r.body.configured).toBe(false);
    expect(typeof r.body.reason).toBe('string');
    expect(r.body.reason).not.toBe('');
  });

  it('POST /api/rtc/token 回 503 + 人话', async () => {
    removeAllProviders();
    const r = await json(srv.base, '/api/rtc/token', { method: 'POST', body: {} });
    expect(r.status).toBe(503);
    expect(r.body.code).toBe('voice_not_configured');
  });
});

describe('token → start → stop 全链路(火山已假掉)', () => {
  let provider;
  beforeEach(() => {
    removeAllProviders();
    provider = addProvider();
  });

  it('status 回 configured:true,且一个密钥字段都不出现在回包里', async () => {
    const r = await json(srv.base, '/api/rtc/status');
    expect(r.status).toBe(200);
    expect(r.body.configured).toBe(true);
    const text = JSON.stringify(r.body);
    for (const secret of [FAKE.appKey, FAKE.secretAccessKey, FAKE.asrAccessToken]) {
      expect(text).not.toContain(secret);
    }
  });

  it('token 回 appId/roomId/userId/token;appKey 不在回包里;userId 带设备 id', async () => {
    const r = await json(srv.base, '/api/rtc/token', {
      method: 'POST', body: {}, headers: { 'x-workbench-device': 'dev-77' },
    });
    expect(r.status).toBe(200);
    expect(r.body.appId).toBe(FAKE.appId);
    expect(r.body.roomId).toMatch(/^room_/);
    expect(r.body.userId).toContain('dev-77');
    expect(typeof r.body.token).toBe('string');
    expect(JSON.stringify(r.body)).not.toContain(FAKE.appKey);
  });

  it('start 把工作台给的 systemMessage 原样下发,并落一条通话记录;stop 结算并回时长', async () => {
    const tk = await json(srv.base, '/api/rtc/token', {
      method: 'POST', body: {}, headers: { 'x-workbench-device': 'dev-77' },
    });
    const started = await json(srv.base, '/api/rtc/start', {
      method: 'POST',
      headers: { 'x-workbench-device': 'dev-77' },
      body: {
        roomId: tk.body.roomId,
        userId: tk.body.userId,
        voice: 'zh_female_test',
        systemMessage: '你是 Ben 的事务官,名字叫周到。',
        welcomeMessage: '在呢。',
      },
    });
    expect(started.status).toBe(200);
    expect(started.body.taskId).toMatch(/^task_/);
    expect(started.body.botUserId).toMatch(/^bot_/);

    expect(calls).toHaveLength(1);
    expect(calls[0].action).toBe('StartVoiceChat');
    const body = calls[0].body;
    expect(body.RoomId).toBe(tk.body.roomId);
    expect(body.Config.LLMConfig.SystemMessages).toEqual(['你是 Ben 的事务官,名字叫周到。']);
    expect(body.Config.TTSConfig.ProviderParams.audio.voice_type).toBe('zh_female_test');
    // 打断:InterruptMode 0 = 用户说话可以打断她。通话模式全靠它。
    expect(body.Config.InterruptMode).toBe(0);
    // 没给回调就不下发 FunctionCallingConfig(本机没有公网地址时的默认形态)。
    expect(body.Config.FunctionCallingConfig).toBeUndefined();
    expect(body.Config.LLMConfig.Tools).toBeUndefined();

    const record = callRecordStore.getByTaskId(db, started.body.taskId);
    expect(record).not.toBeNull();
    expect(record.device_id).toBe('dev-77');
    expect(record.ended_at).toBeNull();

    const stopped = await json(srv.base, '/api/rtc/stop', {
      method: 'POST', body: { roomId: tk.body.roomId, taskId: started.body.taskId },
    });
    expect(stopped.status).toBe(200);
    expect(stopped.body.stopped).toBe(true);
    expect(typeof stopped.body.durationSeconds).toBe('number');
    expect(calls[1].action).toBe('StopVoiceChat');
    expect(calls[1].body.TaskId).toBe(started.body.taskId);

    // 重复 stop 幂等:不再打火山。
    const again = await json(srv.base, '/api/rtc/stop', {
      method: 'POST', body: { roomId: tk.body.roomId, taskId: started.body.taskId },
    });
    expect(again.status).toBe(200);
    expect(again.body.alreadySettled).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it('start 带 tools + functionCalling(工作台配了公网回调)→ 两段都下发给火山', async () => {
    const tk = await json(srv.base, '/api/rtc/token', { method: 'POST', body: {} });
    const tools = [{ type: 'function', function: { name: 'wb_remember_item', description: '记一件事项', parameters: { type: 'object', properties: {} } } }];
    const r = await json(srv.base, '/api/rtc/start', {
      method: 'POST',
      body: {
        roomId: tk.body.roomId,
        userId: tk.body.userId,
        voice: 'zh_female_test',
        systemMessage: '人设',
        tools,
        functionCalling: { serverMessageUrl: 'https://example.invalid/butler/rtc/callback', serverMessageSignature: 'sig-123' },
      },
    });
    expect(r.status).toBe(200);
    const body = calls[0].body;
    expect(body.Config.LLMConfig.Tools).toEqual(tools);
    expect(body.Config.FunctionCallingConfig).toEqual({
      ServerMessageUrl: 'https://example.invalid/butler/rtc/callback',
      ServerMessageSignature: 'sig-123',
    });
  });

  it('functionCalling 只给了一半(缺签名)→ 不下发 FunctionCallingConfig', async () => {
    const tk = await json(srv.base, '/api/rtc/token', { method: 'POST', body: {} });
    await json(srv.base, '/api/rtc/start', {
      method: 'POST',
      body: {
        roomId: tk.body.roomId, userId: tk.body.userId, voice: 'zh_female_test',
        functionCalling: { serverMessageUrl: 'https://example.invalid/x' },
      },
    });
    expect(calls[0].body.Config.FunctionCallingConfig).toBeUndefined();
  });

  it('POST /api/rtc/function-result 把工具结果回填给智能体', async () => {
    const r = await json(srv.base, '/api/rtc/function-result', {
      method: 'POST',
      body: { roomId: 'room_x', taskId: 'task_x', toolCallId: 'call_9', content: '记下了' },
    });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].action).toBe('UpdateVoiceChat');
    expect(calls[0].body.Command).toBe('function');
    expect(JSON.parse(calls[0].body.Message)).toEqual({ ToolCallID: 'call_9', Content: '记下了' });
  });

  it('start 缺 roomId → 400,火山一次都没被打', async () => {
    const r = await json(srv.base, '/api/rtc/start', { method: 'POST', body: { userId: 'u' } });
    expect(r.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('上游抛错 → 502,且错误里不含任何密钥', async () => {
    const restoreThrow = volcengineRtc.__setOpenAPI(() => {
      throw new Error(`火山拒绝了,AppKey=${FAKE.appKey} SK=${FAKE.secretAccessKey}`);
    });
    try {
      const tk = await json(srv.base, '/api/rtc/token', { method: 'POST', body: {} });
      const r = await json(srv.base, '/api/rtc/start', {
        method: 'POST',
        body: { roomId: tk.body.roomId, userId: tk.body.userId, voice: 'zh_female_test' },
      });
      expect(r.status).toBe(502);
      const text = JSON.stringify(r.body);
      expect(text).not.toContain(FAKE.appKey);
      expect(text).not.toContain(FAKE.secretAccessKey);
    } finally {
      restoreThrow();
    }
  });

  it('provider 存在但 appId/appKey 空 → status 也是 false', async () => {
    removeAllProviders();
    rtcProviderStore.create(db, {
      name: '半配',
      provider_type: 'volcengine_rtc',
      config: { ...FAKE, appId: 'x' },
      isDefault: true,
    });
    // appId 非空但不是 24 位:status 只看配没配(appId/appKey 都在),token 签发才报长度。
    const s = await json(srv.base, '/api/rtc/status');
    expect(s.body.configured).toBe(true);
    const t = await json(srv.base, '/api/rtc/token', { method: 'POST', body: {} });
    expect(t.status).toBe(502);
    expect(JSON.stringify(t.body)).not.toContain(FAKE.appKey);
    void provider;
  });
});
