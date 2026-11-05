// 中转的整条路,对着假上游真跑:流式、非流式、额度、鉴权、管理面。
//
// 「真跑」= 真起两个 http 服务器、用真 fetch 说话。不 mock fetch:
// 流式那一条最容易出问题的地方恰恰在 socket 与 chunk 边界上,mock 掉就验不到了。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { startFakeUpstream } from '../dev/fakeUpstream.cjs';
import { createApp } from '../server/app.cjs';
import { relayConfigOf } from '../server/config.cjs';
import { openRelayDb } from '../server/db.cjs';
import { issueToken } from '../server/tokens.cjs';
import { dayKey } from '../server/usage.cjs';

// 只能是 ASCII:HTTP 头的值不允许非 ASCII 字符,写成中文的话请求还没发出去就被 undici 拒了
// (第一版真这么写过,现象是每一条都 502「连不上上游」,查了一圈才发现在头上)。
const UPSTREAM_KEY = 'sk-fake-upstream-0917';

let upstream;
let server;
let db;
let base;

async function startRelay(overrides = {}, upstreamOptions = {}) {
  upstream = await startFakeUpstream({ expectedKey: UPSTREAM_KEY, ...upstreamOptions });
  db = openRelayDb(':memory:');
  const config = {
    ...relayConfigOf({}),
    upstreamUrl: upstream.url,
    upstreamKey: UPSTREAM_KEY,
    ...overrides,
  };
  const app = createApp({ db, config, ...(overrides.now === undefined ? {} : { now: overrides.now }) });
  server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  base = `http://127.0.0.1:${server.address().port}`;
  return config;
}

function grantToken(limit = 50_000) {
  return issueToken(db, { account: 'ben', deviceId: 'mac-1', dailyTokenLimit: limit }).token;
}

const json = (token, body) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(token === undefined ? {} : { authorization: `Bearer ${token}` }) },
  body: JSON.stringify(body),
});

afterEach(async () => {
  if (server !== undefined) await new Promise(done => server.close(done));
  if (upstream !== undefined) await upstream.close();
  server = undefined;
  upstream = undefined;
});

describe('非流式', () => {
  beforeEach(async () => { await startRelay(); });

  it('原样转回上游的回答,并把 usage 记上', async () => {
    const token = grantToken();
    const res = await fetch(`${base}/v1/chat/completions`, json(token, {
      model: 'deepseek-chat', messages: [{ role: 'user', content: '在吗' }],
    }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.choices[0].message.content).toBe('好的,我记下了。');

    const usage = await (await fetch(`${base}/usage`, { headers: { authorization: `Bearer ${token}` } })).json();
    expect(usage.used_tokens).toBe(18);
    expect(usage.requests).toBe(1);
    expect(usage.remaining_tokens).toBe(50_000 - 18);
  });

  it('发给上游的是上游 Key,不是中转令牌', async () => {
    const token = grantToken();
    await fetch(`${base}/v1/chat/completions`, json(token, { model: 'x', messages: [] }));
    const seen = upstream.requests.at(-1);
    expect(seen.headers.authorization).toBe(`Bearer ${UPSTREAM_KEY}`);
    // 中转令牌一个字都不该漏到上游去。
    expect(JSON.stringify(seen.headers)).not.toContain(token);
  });

  it('请求体原样转(除了鉴权头)', async () => {
    const token = grantToken();
    await fetch(`${base}/v1/chat/completions`, json(token, {
      model: 'deepseek-v4-flash', messages: [{ role: 'user', content: '你好' }], temperature: 0.3,
    }));
    const seen = upstream.requests.at(-1);
    expect(seen.body).toEqual({
      model: 'deepseek-v4-flash', messages: [{ role: 'user', content: '你好' }], temperature: 0.3,
    });
  });
});

describe('流式', () => {
  beforeEach(async () => { await startRelay(); });

  it('字一路流到底,[DONE] 收尾,usage 记上', async () => {
    const token = grantToken();
    const res = await fetch(`${base}/v1/chat/completions`, json(token, {
      model: 'deepseek-chat', messages: [{ role: 'user', content: '在吗' }], stream: true,
    }));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    let text = '';
    for await (const chunk of res.body) text += new TextDecoder().decode(chunk);
    expect(text.endsWith('data: [DONE]\n\n')).toBe(true);

    // 把 delta 拼回来,验证一个字都没丢。
    const content = text.split('\n')
      .filter(line => line.startsWith('data: ') && !line.includes('[DONE]'))
      .map(line => JSON.parse(line.slice(6)))
      .map(chunk => chunk.choices?.[0]?.delta?.content ?? '')
      .join('');
    expect(content).toBe('好的,我记下了。');

    const usage = await (await fetch(`${base}/usage`, { headers: { authorization: `Bearer ${token}` } })).json();
    expect(usage.used_tokens).toBe(18);
  });

  /**
   * **中转自己在首字上加了多少毫秒**(2026-09-23,通道层那张「合成首包与模型首字」的卡)。
   *
   * 背景:Ben 真机第一批里 `llm_first_ms` 是 1274~1545ms。那一段里有三样东西 ——
   * deepseek 自己的首字、网络、以及中转这一跳。前两样在测试里量不到也不该量(要真钱、要联网),
   * 但**中转这一跳**是纯本机的、可重复的:上游把第一个字发出来之后,客户端多久看得见。
   *
   * 这个用例让假上游发完第一个字就停 400ms。中转如果在攒 buffer,客户端要等满那 400ms;
   * 不攒的话第一个字立刻就到。判据取 200ms(远小于 400,也远大于本机的真实开销)。
   */
  it('不攒 buffer:上游第一个字一出来,客户端立刻就看得见', async () => {
    await startRelay({}, { holdAfterFirstMs: 400 });
    const token = grantToken();
    const t0 = Date.now();
    const res = await fetch(`${base}/v1/chat/completions`, json(token, {
      model: 'deepseek-v4-flash', messages: [{ role: 'user', content: '在吗' }], stream: true,
    }));
    const reader = res.body.getReader();
    const first = await reader.read();
    const firstMs = Date.now() - t0;
    expect(new TextDecoder().decode(first.value)).toContain('"content":"好"');
    expect(firstMs).toBeLessThan(200);
    await reader.cancel();
  });

  /**
   * 2026-09-27(卡 fix/voice-onboarding-latency)。那天查「语音引导 34 秒才出声」时,
   * 工人日志里那行「模型首段 85 字」把人指向了「中转在攒 buffer」——
   * 查到底发现 85 字根本不是模型吐的(是固定开场白整句推进了同一个切分器),
   * 同一份日志里模型那一轮的首段是 2 字,中转的流式一直是好的(上面那个用例一直在钉它)。
   *
   * 既然查到了这里,就把**将来可能攒起来**的两处一起钉上:
   *   · 向上游**不收压缩**(`accept-encoding: identity`)。node 的 fetch 默认会带 gzip,
   *     压缩流一旦按块缓冲,首字就会被攒在上游那一端 —— SSE 那点字省不下什么,不值得赌;
   *   · 回包带 `x-accel-buffering: no`。Caddy 见 `text/event-stream` 会自己逐块冲,
   *     但将来若有人在前面摆一层 nginx,这一行就是唯一拦得住它攒 buffer 的东西。
   */
  it('不给将来留攒 buffer 的余地:向上游不收压缩,回包明说「别缓冲」', async () => {
    const token = grantToken();
    const res = await fetch(`${base}/v1/chat/completions`, json(token, {
      model: 'deepseek-chat', messages: [{ role: 'user', content: '在吗' }], stream: true,
    }));
    expect(res.headers.get('x-accel-buffering')).toBe('no');
    await res.text();
    expect(upstream.requests.at(-1).headers['accept-encoding']).toBe('identity');
  });

  it('客户端没开 include_usage,中转也会替它开(否则流式等于不计量)', async () => {
    const token = grantToken();
    const res = await fetch(`${base}/v1/chat/completions`, json(token, {
      model: 'x', messages: [], stream: true, stream_options: { include_usage: false },
    }));
    await res.text();
    expect(upstream.requests.at(-1).body.stream_options).toEqual({ include_usage: true });
  });
});

describe('额度(2026-09-23 起按元算)', () => {
  // 假上游每次回 prompt 11 / completion 7、**不带** hit/miss 字段 → 整段输入按未命中算。
  // 模型名 'x' 认不出 → 按 DeepSeek Pro 高峰价(9 / 27 元每百万):11×9 + 7×27 = 288 微元。
  const ONE_CALL_MICRO = 288;

  it('超了回 429,文案说钱,code 仍是 daily_quota_exceeded', async () => {
    await startRelay({ dailyCostLimitCny: 0.0001 }); // 100 微元:第一次 288 就冲过去了
    const token = grantToken();
    // 第一次放行(事前只看「已经花了多少」,这时是 0)。
    expect((await fetch(`${base}/v1/chat/completions`, json(token, { model: 'x', messages: [] }))).status).toBe(200);

    const res = await fetch(`${base}/v1/chat/completions`, json(token, { model: 'x', messages: [] }));
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error.code).toBe('daily_quota_exceeded');
    expect(body.error.type).toBe('rate_limit_exceeded');
    expect(body.error.message).toContain('今天工作台提供的模型额度(0 元)用完了');
    expect(body.error.message).toContain('已花 ¥0.00');
    expect(body.error.message).toContain('自己的 DeepSeek Key');
    // 拦下来的那一次不该真的打到上游。
    expect(upstream.requests.filter(r => r.method === 'POST').length).toBe(1);
  });

  it('★ 缺省上限 5 元,文案里写的就是 5 元', async () => {
    await startRelay();
    const token = grantToken();
    const hash = db.prepare('SELECT token_hash FROM tokens').get().token_hash;
    // 直接往库里记一笔 5 元整,模拟今天已经花满。
    db.prepare('INSERT INTO usage_daily (token_hash, day, provider, requests, cost_micro_cny) VALUES (?, ?, ?, 1, ?)')
      .run(hash, dayKey(new Date(), 8 * 60), 'deepseek', 5_000_000);
    const res = await fetch(`${base}/v1/chat/completions`, json(token, { model: 'x', messages: [] }));
    expect(res.status).toBe(429);
    expect((await res.json()).error.message).toContain('今天工作台提供的模型额度(5 元)用完了,已花 ¥5.00');
  });

  it('★ token 再多、钱没到就不拦(那天 52.6 万 token 大半是缓存命中,只花了几毛钱)', async () => {
    await startRelay();
    const token = grantToken(10); // 老的 token 上限写 10 也不再拦
    for (let i = 0; i < 3; i += 1) {
      expect((await fetch(`${base}/v1/chat/completions`, json(token, { model: 'x', messages: [] }))).status).toBe(200);
    }
  });

  it('额度用完之后 /usage 照样能看,而且带着元', async () => {
    await startRelay({ dailyCostLimitCny: 0.0001 });
    const token = grantToken();
    await fetch(`${base}/v1/chat/completions`, json(token, { model: 'x', messages: [] }));
    const usage = await (await fetch(`${base}/usage`, { headers: { authorization: `Bearer ${token}` } })).json();
    expect(usage.used_tokens).toBe(18);
    expect(usage.used_cny).toBeCloseTo(ONE_CALL_MICRO / 1e6, 9);
    expect(usage.daily_cost_limit_cny).toBe(0.0001);
    expect(usage.remaining_cny).toBe(0);
    expect(usage.cache_miss_tokens).toBe(11);
    expect(usage.cache_hit_tokens).toBe(0);
  });

  it('/v1/usage 回的上限缺省是 5 元', async () => {
    await startRelay();
    const token = grantToken();
    const usage = await (await fetch(`${base}/v1/usage`, { headers: { authorization: `Bearer ${token}` } })).json();
    expect(usage.daily_cost_limit_cny).toBe(5);
    expect(usage.used_cny).toBe(0);
    expect(usage.remaining_cny).toBe(5);
  });

  it('换一天就清零', async () => {
    let clock = new Date('2026-09-17T02:00:00Z');
    await startRelay({ dailyCostLimitCny: 0.0001, now: () => clock });
    const token = grantToken();
    await fetch(`${base}/v1/chat/completions`, json(token, { model: 'x', messages: [] }));
    expect((await fetch(`${base}/v1/chat/completions`, json(token, { model: 'x', messages: [] }))).status).toBe(429);
    clock = new Date('2026-09-18T02:00:00Z');
    expect((await fetch(`${base}/v1/chat/completions`, json(token, { model: 'x', messages: [] }))).status).toBe(200);
  });

  it('/admin/usage 每行带花了多少元,顶上带上限', async () => {
    await startRelay();
    const token = grantToken();
    await fetch(`${base}/v1/chat/completions`, json(token, { model: 'x', messages: [] }));
    const report = await (await fetch(`${base}/admin/usage`)).json();
    expect(report.daily_cost_limit_cny).toBe(5);
    expect(report.rows[0].cost_micro_cny).toBe(ONE_CALL_MICRO);
    expect(report.rows[0].cost_cny).toBeCloseTo(ONE_CALL_MICRO / 1e6, 9);
  });
});

describe('鉴权', () => {
  beforeEach(async () => { await startRelay(); });

  it('没令牌 / 令牌不认识 / 别家的 Key,都是 401 同一句话', async () => {
    for (const token of [undefined, 'wb_no-such-token', 'sk-someone-elses-key']) {
      const res = await fetch(`${base}/v1/chat/completions`, json(token, { model: 'x', messages: [] }));
      expect(res.status).toBe(401);
      expect((await res.json()).error.code).toBe('invalid_relay_token');
    }
    expect(upstream.requests.filter(r => r.method === 'POST').length).toBe(0);
  });

  it('/v1/models 也要令牌', async () => {
    expect((await fetch(`${base}/v1/models`)).status).toBe(401);
    const token = grantToken();
    const res = await fetch(`${base}/v1/models`, { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    expect((await res.json()).data.map(m => m.id)).toContain('deepseek-chat');
  });
});

// 这一节每条自己起 —— 限速与设备数两条要的闸门大小不一样,共用一个 beforeEach 的话
// 验设备数上限时会先撞上限速(第一版就是这么红的)。
describe('领令牌', () => {
  it('领到的令牌当场就能用', async () => {
    await startRelay({ registerPerHour: 3, maxDevicesPerAccount: 2 });
    const res = await fetch(`${base}/register-device`, json(undefined, { account: 'ben', device_id: 'mac-1' }));
    expect(res.status).toBe(201);
    const issued = await res.json();
    expect(issued.token.startsWith('wb_')).toBe(true);
    const chat = await fetch(`${base}/v1/chat/completions`, json(issued.token, { model: 'x', messages: [] }));
    expect(chat.status).toBe(200);
  });

  it('缺 device_id 回 400', async () => {
    await startRelay({ registerPerHour: 3, maxDevicesPerAccount: 2 });
    expect((await fetch(`${base}/register-device`, json(undefined, { account: 'ben' }))).status).toBe(400);
  });

  // 2026-09-21 起这里的答案变了:既没有账号会话、body 里也没有老式 account,
  // 那不是"字段填错了",而是"你还没登录"。401 + 一句指路的话。
  it('既没会话也没老式 account 时回 401,让人先登录', async () => {
    await startRelay({ registerPerHour: 3, maxDevicesPerAccount: 2 });
    const res = await fetch(`${base}/register-device`, json(undefined, { account: '', device_id: 'x' }));
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe('account_session_required');
  });

  it('同一个 IP 领太多次会被拦', async () => {
    await startRelay({ registerPerHour: 3, maxDevicesPerAccount: 2 });
    for (let i = 0; i < 3; i += 1) {
      expect((await fetch(`${base}/register-device`, json(undefined, { account: `a${i}`, device_id: 'd' }))).status).toBe(201);
    }
    const res = await fetch(`${base}/register-device`, json(undefined, { account: 'a4', device_id: 'd' }));
    expect(res.status).toBe(429);
    expect((await res.json()).error.code).toBe('register_rate_limited');
  });

  it('一个账号的设备数封顶,但同一台设备重领不算新设备', async () => {
    // 限速开大,要验的是设备数那道闸。
    await startRelay({ registerPerHour: 100, maxDevicesPerAccount: 2 });
    await fetch(`${base}/register-device`, json(undefined, { account: 'ben', device_id: 'mac-1' }));
    await fetch(`${base}/register-device`, json(undefined, { account: 'ben', device_id: 'mac-2' }));
    // 重领 mac-1:换新钥匙,不占新名额。
    expect((await fetch(`${base}/register-device`, json(undefined, { account: 'ben', device_id: 'mac-1' }))).status).toBe(201);
    const res = await fetch(`${base}/register-device`, json(undefined, { account: 'ben', device_id: 'mac-3' }));
    expect(res.status).toBe(429);
    expect((await res.json()).error.code).toBe('too_many_devices');
  });
});

describe('管理面', () => {
  beforeEach(async () => { await startRelay(); });

  it('本机能发令牌、能看用量、能吊销', async () => {
    const issued = await (await fetch(`${base}/admin/tokens`, json(undefined, { account: '小李', daily_token_limit: 123 }))).json();
    expect(issued.daily_token_limit).toBe(123);

    await fetch(`${base}/v1/chat/completions`, json(issued.token, { model: 'x', messages: [] }));
    const report = await (await fetch(`${base}/admin/usage`)).json();
    expect(report.rows[0]).toMatchObject({ account: '小李', prefix: issued.prefix, total_tokens: 18 });
    // 报表里不该出现明文令牌。
    expect(JSON.stringify(report)).not.toContain(issued.token);

    expect((await (await fetch(`${base}/admin/tokens/revoke`, json(undefined, { prefix: issued.prefix }))).json()).revoked).toBe(1);
    expect((await fetch(`${base}/v1/chat/completions`, json(issued.token, { model: 'x', messages: [] }))).status).toBe(401);
  });

  it('带着反代头就不算本机 —— Caddy 也是从 127.0.0.1 连过来的', async () => {
    const res = await fetch(`${base}/admin/usage`, { headers: { 'x-forwarded-for': '1.2.3.4' } });
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('admin_loopback_only');
  });
});

describe('上游出事时', () => {
  it('没配上游 Key:503 + 一句人话,不是 500', async () => {
    await startRelay({ upstreamKey: undefined });
    const token = grantToken();
    const res = await fetch(`${base}/v1/chat/completions`, json(token, { model: 'x', messages: [] }));
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe('upstream_not_configured');
  });

  it('上游自己报错:状态码与内容照转,并且记了一次请求(token 算 0)', async () => {
    await startRelay({}, { failWith: 503 });
    const token = grantToken();
    const res = await fetch(`${base}/v1/chat/completions`, json(token, { model: 'x', messages: [] }));
    expect(res.status).toBe(503);
    const usage = await (await fetch(`${base}/usage`, { headers: { authorization: `Bearer ${token}` } })).json();
    expect(usage.requests).toBe(1);
    expect(usage.used_tokens).toBe(0);
  });

  it('上游连不上:502 + 一句人话,错误细节不外泄', async () => {
    await startRelay();
    const token = grantToken();
    await upstream.close();
    const res = await fetch(`${base}/v1/chat/completions`, json(token, { model: 'x', messages: [] }));
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error.code).toBe('upstream_unreachable');
    expect(body.error.message).not.toContain('127.0.0.1');
  });

  it('上游流式但不回 usage:字照样到,只是这一次不计 token', async () => {
    await startRelay({}, { usage: null });
    const token = grantToken();
    const res = await fetch(`${base}/v1/chat/completions`, json(token, { model: 'x', messages: [], stream: true }));
    const text = await res.text();
    expect(text).toContain('[DONE]');
    const usage = await (await fetch(`${base}/usage`, { headers: { authorization: `Bearer ${token}` } })).json();
    expect(usage.requests).toBe(1);
    expect(usage.used_tokens).toBe(0);
  });
});

describe('/health', () => {
  it('说得出活着、上游配没配,但不含任何密钥', async () => {
    await startRelay();
    grantToken();
    const body = await (await fetch(`${base}/health`)).json();
    expect(body).toMatchObject({ ok: true, name: 'model-relay', upstream_configured: true, active_tokens: 1 });
    expect(JSON.stringify(body)).not.toContain(UPSTREAM_KEY);
  });
});

/**
 * 用量接口的路径(2026-09-18)。Ben 真机上这条一直回 404 —— 挡住的不是中转,是 Caddy:
 * `api.aibooo.cn` 只反代 /v1/*、/register-device、/health、/updates/*,`/usage` 到不了中转。
 * 所以这条挪进了 /v1(已经放行的前缀),老路径原样留着给还没升级的工作台。
 */
describe('用量接口的两条路径', () => {
  beforeEach(async () => { await startRelay(); });

  it('/v1/usage 与 /usage 是同一份答案', async () => {
    const token = grantToken();
    await fetch(`${base}/v1/chat/completions`, json(token, { model: 'x', messages: [] }));
    const head = { headers: { authorization: `Bearer ${token}` } };
    const v1 = await (await fetch(`${base}/v1/usage`, head)).json();
    const old = await (await fetch(`${base}/usage`, head)).json();
    expect(v1).toEqual(old);
    expect(v1.used_tokens).toBe(18);
    expect(v1.requests).toBe(1);
  });

  it('/v1/usage 没令牌一样 401,而且不会被当成一次聊天打到上游', async () => {
    const res = await fetch(`${base}/v1/usage`);
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe('invalid_relay_token');
    expect(upstream.requests.length).toBe(0);
  });

  it('额度用完之后 /v1/usage 照样能看', async () => {
    await startRelay({ dailyTokenLimit: 10 });
    const token = grantToken(10);
    await fetch(`${base}/v1/chat/completions`, json(token, { model: 'x', messages: [] }));
    const usage = await (await fetch(`${base}/v1/usage`, { headers: { authorization: `Bearer ${token}` } })).json();
    expect(usage.remaining_tokens).toBe(0);
  });
});
