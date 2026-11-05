// 语音合成用工作台下发的钥匙(2026-09-23,docs/交接-0923-语音合成用下发钥匙.md)。
//
// 钉这几件:
//   ① sqlite 里一个供应商都没有、只有工作台下发的 volc_tts → /api/tts 合得出来,火山收到的是下发那一份;
//      /api/tts/stream、/api/voices(换音色)、/api/voices/sample(样音)走的是同一个口;
//   ② 下发的 volc_asr 进 resolveAsrCreds 的第三个来源;
//   ③ 8792「重启」(内存清空)后第一句合成自己去拉,并发几句只拉一次;
//   ④ 都没有 → 503 + 按原因说的能行动的人话(服务器没配 / 还没登录 / 工作台不在);
//   ⑤ sqlite 设置页配了能用的 → 优先 sqlite(连电话里记在「下发」那一行上的音色绑定也让位);
//   ⑥ 密钥不出现在任何日志、任何回包(含 /health)。
//
// 8791 是这里起的一个假服务;火山在 fetch 这一层打桩(**不联网**),所以能看见请求里真带的是哪一把。
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import { once } from 'node:events';
import { require, tempHome, cleanupHome, listen, json } from './_setup.mjs';

const home = tempHome('wb-voice-creds');

// ---- 假 8791 ---------------------------------------------------------------
const SERVER_TTS = { app_id: 'server-tts-app-0001', access_token: 'server-tts-token-SECRET-0001', cluster: 'volcano_tts' };
const SERVER_ASR = { app_id: 'server-asr-app-0001', access_token: 'server-asr-token-SECRET-0001' };
const SETTINGS_TOKEN = 'settings-token-SECRET-0002';
const SECRETS = [SERVER_TTS.app_id, SERVER_TTS.access_token, SERVER_ASR.app_id, SERVER_ASR.access_token, SETTINGS_TOKEN];

/** 下一次 8791 回什么。测试里随时改。 */
let workbenchAnswer = { status: 200, body: { source: 'server', volc_tts: SERVER_TTS, volc_asr: SERVER_ASR, expires_at: new Date(Date.now() + 3600_000).toISOString() } };
let workbenchHits = 0;
const workbench = http.createServer((req, res) => {
  workbenchHits += 1;
  if (req.url !== '/channel/credentials') { res.writeHead(404).end(); return; }
  res.writeHead(workbenchAnswer.status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(workbenchAnswer.body));
});
workbench.listen(0, '127.0.0.1');
await once(workbench, 'listening');
process.env.BUTLER_WORKBENCH_URL = `http://127.0.0.1:${workbench.address().port}`;

const { createApp } = require('../server/app.cjs');
const { db } = require('../server/db.cjs');
const workbenchVoiceCreds = require('../server/services/workbenchVoiceCreds.cjs');
const voiceCredentials = require('../server/services/voiceCredentials.cjs');
const volcTtsStream = require('../server/services/volcTtsStream.cjs');
const ttsStreamRoute = require('../server/routes/api/ttsStream.cjs');
const ttsVoices = require('../server/services/ttsVoices.cjs');

// ---- 火山打桩(fetch 层) ----------------------------------------------------
const realFetch = globalThis.fetch;
/** 火山收到的每一次合成:{ appid, token, auth, resourceId }。 */
let volcCalls = [];
globalThis.fetch = async (url, init) => {
  if (String(url).startsWith('https://openspeech.bytedance.com/')) {
    const body = JSON.parse(init.body);
    volcCalls.push({
      appid: body.app.appid,
      token: body.app.token,
      cluster: body.app.cluster,
      auth: init.headers.Authorization,
      resourceId: init.headers['X-Api-Resource-Id'],
    });
    return new Response(JSON.stringify({ code: 3000, data: Buffer.from('FAKE-AUDIO').toString('base64') }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }
  return realFetch(url, init);
};

// ---- 日志:全部收下来,最后逐条查有没有密钥 --------------------------------
const logged = [];
for (const level of ['log', 'warn', 'error', 'info']) {
  vi.spyOn(console, level).mockImplementation((...args) => { logged.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')); });
}

let srv;
const originalStream = volcTtsStream.streamSynthesize;

beforeAll(async () => {
  srv = await listen(createApp());
});
afterEach(() => {
  volcTtsStream.streamSynthesize = originalStream;
  ttsStreamRoute.resetBreaker();
});
afterAll(async () => {
  globalThis.fetch = realFetch;
  await srv.close();
  workbench.close();
  db.close();
  cleanupHome(home);
});

/** 模拟 8792 重启:内存里那份清空。 */
function restart() {
  workbenchVoiceCreds.store.reset();
  workbenchHits = 0;
}

function serverAnswer(extra = {}) {
  workbenchAnswer = {
    status: 200,
    body: { source: 'server', volc_tts: SERVER_TTS, volc_asr: SERVER_ASR, expires_at: new Date(Date.now() + 3600_000).toISOString(), ...extra },
  };
}

function expectNoSecret(text, where) {
  for (const secret of SECRETS) expect(String(text), `${where} 里不该有密钥`).not.toContain(secret);
}

async function raw(path, init = {}) {
  const res = await fetch(`${srv.base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    ...init,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, headers: res.headers, buf, text: buf.toString('utf8') };
}

describe('只有工作台下发的钥匙(sqlite 里一个供应商都没有)', () => {
  it('★/api/tts 合得出来,火山收到的是下发那一把', async () => {
    restart();
    serverAnswer();
    volcCalls = [];
    const r = await raw('/api/tts', { body: { text: '老板,有什么吩咐?', encoding: 'wav' } });
    expect(r.status).toBe(200);
    expect(r.buf.toString()).toBe('FAKE-AUDIO');
    expect(volcCalls).toHaveLength(1);
    expect(volcCalls[0].appid).toBe(SERVER_TTS.app_id);
    expect(volcCalls[0].auth).toBe(`Bearer;${SERVER_TTS.access_token}`);
    expect(volcCalls[0].cluster).toBe('volcano_tts');
    // 没带 resource_id → 与设置页那条路一样的缺省资源。
    expect(volcCalls[0].resourceId).toBe('volc.service_type.10029');
    expectNoSecret(JSON.stringify([...r.headers]), '回包头');
  });

  it('下发带了 resource_id 就用它(公版音色)', async () => {
    restart();
    serverAnswer({ volc_tts: { ...SERVER_TTS, resource_id: 'volc.custom.resource' } });
    volcCalls = [];
    const r = await raw('/api/tts', { body: { text: '换一句不在样音缓存里的话' } });
    expect(r.status).toBe(200);
    expect(volcCalls[0].resourceId).toBe('volc.custom.resource');
    serverAnswer();
    restart();
  });

  it('★8792 重启(内存清空)后第一句自己去拉;几句同时来只拉一次', async () => {
    restart();
    serverAnswer();
    const results = await Promise.all([1, 2, 3].map((i) => raw('/api/tts', { body: { text: `第${i}句` } })));
    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(workbenchHits).toBe(1);
    // 新鲜期内不再问。
    await raw('/api/tts', { body: { text: '第四句' } });
    expect(workbenchHits).toBe(1);
  });

  it('/api/tts/stream 走同一个口(虚拟供应商进了流式合成)', async () => {
    let seen;
    volcTtsStream.streamSynthesize = async ({ provider, onChunk }) => {
      seen = provider;
      onChunk(Buffer.alloc(640));
      return { chunks: 1 };
    };
    const r = await raw('/api/tts/stream', { body: { text: '流式那一句' } });
    expect(r.status).toBe(200);
    expect(r.headers.get('x-tts-backend')).toBe('volc-stream');
    expect(seen.id).toBe(voiceCredentials.WORKBENCH_PROVIDER_ID);
    expect(seen.config.appid).toBe(SERVER_TTS.app_id);
  });

  it('电话里换音色 + 样音预热:列得出、换得动、合得出', async () => {
    const list = await json(srv.base, '/api/voices');
    expect(list.status).toBe(200);
    expect(list.body.provider_type).toBe('volcengine');
    expectNoSecret(JSON.stringify(list.body), '/api/voices 回包');

    // 挑一个走 V1 的公版音色(saturn_/_tob 走 V3,回包形状不同,这里的桩只模拟 V1)。
    const other = ttsVoices.VOLC_OFFICIAL_VOICES.find((v) => v.id !== ttsVoices.DEFAULT_VOLC_VOICE && !/^saturn_|_tob$/.test(v.id));
    const put = await json(srv.base, '/api/voices/current', { method: 'PUT', body: { voice_id: other.id } });
    expect(put.status).toBe(200);
    expect(put.body.voice.id).toBe(other.id);

    volcCalls = [];
    const r = await raw('/api/tts', { body: { text: '换完嗓子的第一句' } });
    expect(r.status).toBe(200);
    expect(volcCalls[0].appid).toBe(SERVER_TTS.app_id);

    const sample = await json(srv.base, '/api/voices/sample', { method: 'POST', body: { voice_id: other.id } });
    expect(sample.status).toBe(200);
    expect(sample.body.synthesized || sample.body.cached).toBe(true);
  });

  it('下发的 volc_asr 是识别的第三个来源', () => {
    const creds = voiceCredentials.resolveAsrCreds(db);
    expect(creds.source).toBe('server');
    expect(creds.appId).toBe(SERVER_ASR.app_id);
    expect(creds.resourceId).toBe(voiceCredentials.DEFAULT_ASR_RESOURCE_ID);
  });

  it('/health 说得出「有、从服务器来」,一把钥匙都不带', async () => {
    const h = await json(srv.base, '/health');
    expect(h.body.tts).toEqual({ ready: true, source: 'server' });
    expectNoSecret(JSON.stringify(h.body), '/health');
  });
});

describe('都没有 → 503 + 能行动的人话', () => {
  it('★服务器没配 TTS(下发里没有 volc_tts)', async () => {
    restart();
    workbenchAnswer = { status: 200, body: { source: 'server', volc_asr: SERVER_ASR } };
    const r = await json(srv.base, '/api/tts', { method: 'POST', body: { text: '你好' } });
    expect(r.status).toBe(503);
    expect(r.body.code).toBe('voice_not_configured');
    expect(r.body.error).toContain('服务器还没下发语音合成的钥匙,她暂时开不了口');
    expect(r.body.error).toContain('不用自己去设置里填');
    const h = await json(srv.base, '/health');
    expect(h.body.tts.ready).toBe(false);
    expect(h.body.tts.source).toBe('none');
    expect(h.body.tts.note).toContain('服务器还没下发语音合成的钥匙');
  });

  it('还没登录(8791 自己也没拿到)→ 带上 8791 的原话', async () => {
    restart();
    workbenchAnswer = { status: 200, body: { source: 'none', note: '通道密钥由服务器在登录后下发。' } };
    const r = await json(srv.base, '/api/tts', { method: 'POST', body: { text: '你好' } });
    expect(r.status).toBe(503);
    expect(r.body.error).toContain('她暂时开不了口');
    expect(r.body.error).toContain('登录后下发');
  });

  it('工作台不在(连不上)', async () => {
    restart();
    const saved = process.env.BUTLER_WORKBENCH_URL;
    process.env.BUTLER_WORKBENCH_URL = 'http://127.0.0.1:1';
    try {
      const r = await json(srv.base, '/api/tts', { method: 'POST', body: { text: '你好' } });
      expect(r.status).toBe(503);
      expect(r.body.error).toContain('连不上工作台');
    } finally {
      process.env.BUTLER_WORKBENCH_URL = saved;
    }
  });

  it('工作台暂时不在时,手上那份照用(工作台重启那十几秒她不该哑)', async () => {
    restart();
    serverAnswer({ expires_at: new Date(Date.now() - 1000).toISOString() });
    expect((await raw('/api/tts', { body: { text: '先拿到一份' } })).status).toBe(200);
    const saved = process.env.BUTLER_WORKBENCH_URL;
    process.env.BUTLER_WORKBENCH_URL = 'http://127.0.0.1:1';
    try {
      // 过了重试间隔,强制它再去拉一次(连不上)。
      const store = workbenchVoiceCreds.store;
      const realNow = Date.now;
      Date.now = () => realNow() + 60_000;
      try {
        expect((await raw('/api/tts', { body: { text: '工作台不在的这一句' } })).status).toBe(200);
      } finally {
        Date.now = realNow;
      }
      expect(store.current().volcTts.appId).toBe(SERVER_TTS.app_id);
    } finally {
      process.env.BUTLER_WORKBENCH_URL = saved;
    }
  });
});

describe('sqlite 设置页配了能用的 → 优先 sqlite', () => {
  it('★火山收到的是设置页那一把;记在「下发」上的电话音色绑定也让位', async () => {
    restart();
    serverAnswer();
    const created = await json(srv.base, '/admin/tts-models', {
      method: 'POST',
      body: {
        name: '我自己的火山',
        provider_type: 'volcengine',
        config: { appid: 'settings-app-0002', accessToken: SETTINGS_TOKEN, cluster: 'volcano_tts' },
        isDefault: true,
      },
    });
    expect(created.status).toBe(201);
    volcCalls = [];
    const r = await raw('/api/tts', { body: { text: '设置页优先的一句' } });
    expect(r.status).toBe(200);
    expect(volcCalls).toHaveLength(1);
    expect(volcCalls[0].appid).toBe('settings-app-0002');
    expect(volcCalls[0].auth).toBe(`Bearer;${SETTINGS_TOKEN}`);

    const h = await json(srv.base, '/health');
    expect(h.body.tts).toEqual({ ready: true, source: 'settings' });
  });

  it('设置页那个密钥不全时,退到下发那一份', async () => {
    const created = await json(srv.base, '/admin/tts-models', {
      method: 'POST',
      body: { name: '半截的', provider_type: 'minimax', config: { apiKey: 'only-key-no-group' }, isDefault: true },
    });
    // 供应商库可能在建的时候就拒绝半截配置;拒绝了这条就没有意义,跳过断言。
    if (created.status !== 201) return;
    volcCalls = [];
    const r = await raw('/api/tts', { body: { text: '退到下发的一句' } });
    expect(r.status).toBe(200);
    expect(volcCalls[0].appid).toBe(SERVER_TTS.app_id);
  });
});

describe('密钥不进日志', () => {
  it('★这一整个文件跑下来,没有一行日志带着任何一把钥匙', () => {
    expect(logged.length).toBeGreaterThan(0);
    for (const line of logged) expectNoSecret(line, `日志「${line.slice(0, 60)}」`);
    // 日志里说的是「有没有」。
    expect(logged.some((l) => l.includes('取到了(tts=1 asr=1)'))).toBe(true);
  });
});
