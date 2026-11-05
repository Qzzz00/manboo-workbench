// 三家上游,对着三个假上游**真跑**(2026-09-22,派活走接口那只手)。
//
// 「真跑」的定义与 http.test.mjs 同一条:真起 http 服务器、真 fetch。
// 这一份要钉死的是四件事:
//   ① 模型名决定去哪一家,**Key 换成那一家的**;
//   ② 没配那一家 → 503,而且**一个字节都没发出去**(绝不改发给别家);
//   ③ 用量记在那一家名下,`/v1/usage` 回得出分家明细,额度仍按总数算;
//   ④ 豆包的模型名换成接入点 id,并且路径上**没有** /v1。
import { afterEach, describe, expect, it } from 'vitest';

import { startFakeUpstream } from '../dev/fakeUpstream.cjs';
import { createApp } from '../server/app.cjs';
import { relayConfigOf } from '../server/config.cjs';
import { openRelayDb } from '../server/db.cjs';
import { issueToken } from '../server/tokens.cjs';

// 只能是 ASCII:HTTP 头的值不允许非 ASCII(理由见 http.test.mjs 开头那条)。
const DS_KEY = 'sk-fake-deepseek';
const OA_KEY = 'sk-fake-openai';
const DB_KEY = 'sk-fake-doubao';

let servers = [];
let db;
let base;
let ups = {};

async function start({ openai = true, doubao = true, endpoints, dailyCostLimitCny } = {}) {
  ups.deepseek = await startFakeUpstream({ expectedKey: DS_KEY, reply: '我是 DeepSeek' });
  if (openai) ups.openai = await startFakeUpstream({ expectedKey: OA_KEY, reply: '我是 GPT' });
  if (doubao) ups.doubao = await startFakeUpstream({ expectedKey: DB_KEY, reply: '我是豆包' });
  db = openRelayDb(':memory:');
  const config = {
    ...relayConfigOf({
      ...(openai ? { RELAY_OPENAI_KEY: OA_KEY, RELAY_OPENAI_BASE: ups.openai.url } : {}),
      ...(doubao ? { RELAY_DOUBAO_KEY: DB_KEY, RELAY_DOUBAO_BASE: ups.doubao.url } : {}),
      ...(endpoints === undefined ? {} : { RELAY_DOUBAO_ENDPOINTS: endpoints }),
    }),
    upstreamUrl: ups.deepseek.url,
    upstreamKey: DS_KEY,
    ...(dailyCostLimitCny === undefined ? {} : { dailyCostLimitCny }),
  };
  const app = createApp({ db, config });
  const server = await new Promise(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  servers.push(server);
  base = `http://127.0.0.1:${server.address().port}`;
}

function grantToken(limit = 50_000) {
  return issueToken(db, { account: 'ben', deviceId: 'mac-1', dailyTokenLimit: limit }).token;
}

const post = (token, body) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
  body: JSON.stringify(body),
});

const chat = (token, model) => fetch(`${base}/v1/chat/completions`, post(token, { model, messages: [{ role: 'user', content: '嗨' }] }));

afterEach(async () => {
  for (const server of servers) await new Promise(done => server.close(done));
  servers = [];
  for (const up of Object.values(ups)) await up.close();
  ups = {};
});

describe('按模型名分家', () => {
  it('gpt-4o 发到 OpenAI 那台,带的是 OpenAI 的 Key', async () => {
    await start();
    const token = grantToken();
    const res = await chat(token, 'gpt-4o');
    expect(res.status).toBe(200);
    expect((await res.json()).choices[0].message.content).toBe('我是 GPT');
    expect(ups.openai.requests).toHaveLength(1);
    expect(ups.openai.requests[0].headers.authorization).toBe(`Bearer ${OA_KEY}`);
    // ★ 别家一个字节都没收到。
    expect(ups.deepseek.requests).toHaveLength(0);
    expect(ups.doubao.requests).toHaveLength(0);
  });

  it('o3-mini 也归 OpenAI', async () => {
    await start();
    await chat(grantToken(), 'o3-mini');
    expect(ups.openai.requests).toHaveLength(1);
  });

  it('doubao-pro-32k 发到豆包那台,路径上没有 /v1(方舟的 base 自带 /api/v3)', async () => {
    await start();
    const res = await chat(grantToken(), 'doubao-pro-32k');
    expect(res.status).toBe(200);
    expect(ups.doubao.requests).toHaveLength(1);
    expect(ups.doubao.requests[0].url).toBe('/chat/completions');
    expect(ups.doubao.requests[0].headers.authorization).toBe(`Bearer ${DB_KEY}`);
  });

  it('deepseek-chat 与认不出的名字都走老那条(现状一个字没变)', async () => {
    await start();
    const token = grantToken();
    await chat(token, 'deepseek-chat');
    await chat(token, '随便写的');
    expect(ups.deepseek.requests).toHaveLength(2);
    expect(ups.deepseek.requests[0].url).toBe('/v1/chat/completions');
    expect(ups.deepseek.requests[0].headers.authorization).toBe(`Bearer ${DS_KEY}`);
  });

  it('流式那条也分家,而且 include_usage 照样补上', async () => {
    await start();
    const res = await fetch(`${base}/v1/chat/completions`, post(grantToken(), { model: 'gpt-4o', messages: [], stream: true }));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('[DONE]');
    expect(ups.openai.requests[0].body.stream_options.include_usage).toBe(true);
    expect(ups.deepseek.requests).toHaveLength(0);
  });
});

describe('没配那一家', () => {
  it('★ 503 + 「服务器没配 …」,而且一个字节都没发给别家', async () => {
    await start({ openai: false });
    const res = await chat(grantToken(), 'gpt-4o');
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error.code).toBe('openai_not_configured');
    expect(body.error.message).toContain('服务器没配');
    // 错误里带变量名:看到它的人下一步就是去 .env 里加那一行。
    expect(body.error.message).toContain('RELAY_OPENAI_KEY');
    // ★ 最要紧的一条:没有静默改发给 DeepSeek。
    expect(ups.deepseek.requests).toHaveLength(0);
  });

  it('豆包没配也是同一套说法', async () => {
    await start({ doubao: false });
    const body = await (await chat(grantToken(), 'doubao-pro-32k')).json();
    expect(body.error.code).toBe('doubao_not_configured');
    expect(body.error.message).toContain('RELAY_DOUBAO_KEY');
  });

  it('没配那一家不影响别家照发', async () => {
    await start({ openai: false });
    expect((await chat(grantToken(), 'deepseek-chat')).status).toBe(200);
  });

  it('/health 回三家各自配了没有(只有布尔,没有 Key、没有地址)', async () => {
    await start({ doubao: false });
    const health = await (await fetch(`${base}/health`)).json();
    expect(health.providers).toEqual({ deepseek: true, openai: true, doubao: false });
    expect(JSON.stringify(health)).not.toContain(OA_KEY);
    expect(JSON.stringify(health)).not.toContain('api.openai.com');
  });
});

describe('豆包的接入点映射', () => {
  it('配了映射就把模型名换成 ep-…', async () => {
    await start({ endpoints: 'doubao-pro-32k=ep-20260922-abcde' });
    await chat(grantToken(), 'doubao-pro-32k');
    expect(ups.doubao.requests[0].body.model).toBe('ep-20260922-abcde');
  });

  it('没映射到就原样发过去(让方舟自己说没这个模型)', async () => {
    await start({ endpoints: 'doubao-pro-32k=ep-1' });
    await chat(grantToken(), 'doubao-lite-4k');
    expect(ups.doubao.requests[0].body.model).toBe('doubao-lite-4k');
  });

  it('别家的模型名一个字不动', async () => {
    await start({ endpoints: 'gpt-4o=ep-不该生效' });
    await chat(grantToken(), 'gpt-4o');
    expect(ups.openai.requests[0].body.model).toBe('gpt-4o');
  });
});

describe('用量分家', () => {
  it('★ 各记各的,总数仍是三家之和', async () => {
    await start();
    const token = grantToken();
    await chat(token, 'deepseek-chat');
    await chat(token, 'gpt-4o');
    await chat(token, 'gpt-4o');
    await chat(token, 'doubao-pro-32k');
    const usage = await (await fetch(`${base}/v1/usage`, { headers: { authorization: `Bearer ${token}` } })).json();
    // 假上游每次回 18 个 token。
    expect(usage.used_tokens).toBe(4 * 18);
    expect(usage.requests).toBe(4);
    const by = Object.fromEntries(usage.by_provider.map(row => [row.provider, row]));
    expect(by.deepseek.total_tokens).toBe(18);
    expect(by.openai.total_tokens).toBe(36);
    expect(by.doubao.total_tokens).toBe(18);
    expect(by.openai.requests).toBe(2);
  });

  it('一次都没用过的那一家在清单里回 0,不缺席', async () => {
    await start();
    const token = grantToken();
    await chat(token, 'deepseek-chat');
    const usage = await (await fetch(`${base}/v1/usage`, { headers: { authorization: `Bearer ${token}` } })).json();
    expect(usage.by_provider.map(row => row.provider)).toEqual(['deepseek', 'openai', 'doubao']);
    expect(usage.by_provider.find(row => row.provider === 'openai').total_tokens).toBe(0);
  });

  it('★ 额度是一本总账:DeepSeek 上用完了,发 gpt 也一样被拦', async () => {
    await start({ dailyCostLimitCny: 0.0001 });
    const token = grantToken(); // 假上游一次 11+7 token,按 Flash 以外的价第一次就冲过 100 微元
    await chat(token, 'deepseek-chat');
    const res = await chat(token, 'gpt-4o');
    expect(res.status).toBe(429);
    expect((await res.json()).error.code).toBe('daily_quota_exceeded');
    expect(ups.openai.requests).toHaveLength(0);
  });

  it('老路径 /usage 也带上分家明细(同一个 handler)', async () => {
    await start();
    const token = grantToken();
    const usage = await (await fetch(`${base}/usage`, { headers: { authorization: `Bearer ${token}` } })).json();
    expect(usage.by_provider).toHaveLength(3);
  });
});

describe('模型目录', () => {
  it('不带 provider 就是 DeepSeek(老客户端一个字不用改)', async () => {
    await start();
    const res = await fetch(`${base}/v1/models`, { headers: { authorization: `Bearer ${grantToken()}` } });
    expect(res.status).toBe(200);
    expect(ups.deepseek.requests[0].url).toBe('/v1/models');
  });

  it('?provider=openai 问的是 OpenAI 那台', async () => {
    await start();
    await fetch(`${base}/v1/models?provider=openai`, { headers: { authorization: `Bearer ${grantToken()}` } });
    expect(ups.openai.requests).toHaveLength(1);
    expect(ups.deepseek.requests).toHaveLength(0);
  });

  it('认不出的家名当场 400(不悄悄按缺省走)', async () => {
    await start();
    const res = await fetch(`${base}/v1/models?provider=火星`, { headers: { authorization: `Bearer ${grantToken()}` } });
    expect(res.status).toBe(400);
  });
});

describe('图片生成', () => {
  it('转到 OpenAI 的 /v1/images/generations,记一次请求、0 token', async () => {
    await start();
    const token = grantToken();
    const res = await fetch(`${base}/v1/images`, post(token, { model: 'gpt-image-1', prompt: '一只猫' }));
    expect(res.status).toBe(200);
    expect((await res.json()).data[0].url).toContain('fake.png');
    expect(ups.openai.requests[0].url).toBe('/v1/images/generations');
    expect(ups.openai.requests[0].headers.authorization).toBe(`Bearer ${OA_KEY}`);
    const usage = await (await fetch(`${base}/v1/usage`, { headers: { authorization: `Bearer ${token}` } })).json();
    const openai = usage.by_provider.find(row => row.provider === 'openai');
    expect(openai.requests).toBe(1);
    expect(openai.total_tokens).toBe(0);
  });

  it('没配 OpenAI 时 503,说的是同一句人话', async () => {
    await start({ openai: false });
    const res = await fetch(`${base}/v1/images`, post(grantToken(), { prompt: '一只猫' }));
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe('openai_not_configured');
  });

  it('不带令牌就是 401,配没配一个字都不透露', async () => {
    await start({ openai: false });
    const res = await fetch(`${base}/v1/images`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    expect(res.status).toBe(401);
  });
});
