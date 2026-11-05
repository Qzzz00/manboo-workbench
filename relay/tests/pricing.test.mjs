// 额度按钱算(2026-09-23)。
//
// 要钉死的:
//   ① 缓存命中 / 未命中 / 输出三档各自计价(DeepSeek 官方口径);
//   ② 上游没给 hit/miss 字段时整段输入按未命中算(宁可多算);
//   ③ 价格表从 env 读,写坏了回落缺省并说一句;RELAY_DAILY_TOKEN_LIMIT 已废弃要说出来;
//   ④ 老库原地加上成本列,老行记 0 元、一行不丢;
//   ⑤ 对着假上游真跑:带 hit/miss 的回包按便宜的那档记账。
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';

import { startFakeUpstream } from '../dev/fakeUpstream.cjs';
import { createApp } from '../server/app.cjs';
import { relayConfigOf } from '../server/config.cjs';
import { migrate, openRelayDb } from '../server/db.cjs';
import {
  costMicroOf, DEFAULT_PRICES_CNY, formatCny, parsePrice, priceTierOf, relayPricesConfigOf, splitUsage,
} from '../server/pricing.cjs';
import { issueToken } from '../server/tokens.cjs';
import { recordUsage, usageOfDay } from '../server/usage.cjs';

const FLASH = { hit: 0.04, miss: 2, output: 8 };

describe('拆三档', () => {
  it('★ DeepSeek 的 hit/miss 字段原样用', () => {
    expect(splitUsage({
      prompt_tokens: 1000, prompt_cache_hit_tokens: 900, prompt_cache_miss_tokens: 100, completion_tokens: 50, total_tokens: 1050,
    })).toEqual({ hit: 900, miss: 100, completion: 50 });
  });

  it('★ 没有 hit/miss 字段 → 整段输入按未命中算', () => {
    expect(splitUsage({ prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 })).toEqual({ hit: 0, miss: 11, completion: 7 });
  });

  it('只给了命中,未命中用 prompt 减出来', () => {
    expect(splitUsage({ prompt_tokens: 100, prompt_cache_hit_tokens: 30, completion_tokens: 1 })).toEqual({ hit: 30, miss: 70, completion: 1 });
  });

  it('OpenAI 形状的 cached_tokens 当命中', () => {
    expect(splitUsage({ prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 64 }, completion_tokens: 5 }))
      .toEqual({ hit: 64, miss: 36, completion: 5 });
  });

  it('usage 缺席 / 坏的 → 全 0,不抛', () => {
    expect(splitUsage(undefined)).toEqual({ hit: 0, miss: 0, completion: 0 });
    expect(splitUsage({ prompt_tokens: 'x', completion_tokens: -3 })).toEqual({ hit: 0, miss: 0, completion: 0 });
  });
});

describe('计价', () => {
  it('★ 缓存命中比未命中便宜五十倍:那天 34 万命中只值 1 分多钱', () => {
    // 34 万命中 + 18.6 万未命中(输出另算 0):
    const micro = costMicroOf({ hit: 340_000, miss: 186_000, completion: 0 }, FLASH);
    expect(micro).toBe(340_000 * 0.04 + 186_000 * 2); // 13,600 + 372,000 微元
    expect(micro / 1e6).toBeCloseTo(0.3856, 6);
    // 同样的 token 全按未命中算要贵出 0.66 元 —— 按 token 一刀切就是这么把额度撞满的。
    expect(costMicroOf({ hit: 0, miss: 526_000, completion: 0 }, FLASH) / 1e6).toBeCloseTo(1.052, 6);
  });

  it('向上取整到 1 微元,但不被浮点尾巴多收', () => {
    expect(costMicroOf({ hit: 1, miss: 0, completion: 0 }, FLASH)).toBe(1); // 0.04 → 1
    expect(costMicroOf({ hit: 300, miss: 0, completion: 0 }, FLASH)).toBe(12); // 0.04×300 = 12.000…002
    expect(costMicroOf({ hit: 0, miss: 0, completion: 0 }, FLASH)).toBe(0);
  });

  it('模型名 → 价档:只有写了 flash 的按 Flash,其余 DeepSeek 按 Pro;别家各一档', () => {
    expect(priceTierOf('deepseek', 'deepseek-v4-flash')).toBe('deepseek-flash');
    expect(priceTierOf('deepseek', 'deepseek-flash')).toBe('deepseek-flash');
    expect(priceTierOf('deepseek', 'deepseek-v4-pro')).toBe('deepseek-pro');
    expect(priceTierOf('deepseek', 'deepseek-chat')).toBe('deepseek-pro');
    expect(priceTierOf('deepseek', undefined)).toBe('deepseek-pro');
    expect(priceTierOf('openai', 'gpt-4o')).toBe('openai');
    expect(priceTierOf('doubao', 'doubao-pro-32k')).toBe('doubao');
  });

  it('缺省价就是 2026-09-23 核对的 DeepSeek 官方高峰价', () => {
    expect(DEFAULT_PRICES_CNY['deepseek-flash']).toEqual([0.04, 2, 8]);
    expect(DEFAULT_PRICES_CNY['deepseek-pro']).toEqual([0.3, 9, 27]);
  });

  it('formatCny:上限写干净、已花写到分', () => {
    expect(formatCny(5)).toBe('5');
    expect(formatCny(0.5)).toBe('0.5');
    expect(formatCny(2.345, { cents: true })).toBe('2.35');
  });
});

describe('价格表与额度的配置', () => {
  it('env 覆盖某一档;写坏的回落缺省并留一句话', () => {
    expect(parsePrice('0.02, 1, 4')).toEqual({ hit: 0.02, miss: 1, output: 4 });
    expect(parsePrice('1,2')).toBeUndefined();
    const out = relayPricesConfigOf({ RELAY_PRICE_DEEPSEEK_FLASH_CNY: '0.02,1,4', RELAY_PRICE_OPENAI_CNY: '坏的' });
    expect(out.tiers['deepseek-flash']).toEqual({ hit: 0.02, miss: 1, output: 4 });
    expect(out.tiers.openai).toEqual({ hit: 20, miss: 20, output: 120 });
    expect(out.warnings.join('\n')).toContain('RELAY_PRICE_OPENAI_CNY');
  });

  it('★ 每日上限缺省 5 元;写 0、负数、非数字都回落 5', () => {
    expect(relayConfigOf({}).dailyCostLimitCny).toBe(5);
    expect(relayConfigOf({ RELAY_DAILY_COST_LIMIT_CNY: '8.5' }).dailyCostLimitCny).toBe(8.5);
    for (const bad of ['0', '-1', '五块']) expect(relayConfigOf({ RELAY_DAILY_COST_LIMIT_CNY: bad }).dailyCostLimitCny).toBe(5);
  });

  it('★ .env 里还写着 RELAY_DAILY_TOKEN_LIMIT → 明说已废弃、被忽略(不静默)', () => {
    expect(relayConfigOf({}).warnings).toEqual([]);
    const warnings = relayConfigOf({ RELAY_DAILY_TOKEN_LIMIT: '500000' }).warnings;
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('RELAY_DAILY_TOKEN_LIMIT 已废弃');
    expect(warnings[0]).toContain('RELAY_DAILY_COST_LIMIT_CNY');
  });
});

describe('库:成本列', () => {
  it('★ 升到 09-22 形状(有 provider)的老库原地补三列,老行记 0 元一行不丢', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(`
      CREATE TABLE tokens (token_hash TEXT PRIMARY KEY, prefix TEXT NOT NULL, account TEXT NOT NULL,
        device_id TEXT NOT NULL, daily_token_limit INTEGER NOT NULL, created_at TEXT NOT NULL, revoked_at TEXT);
      CREATE TABLE usage_daily (token_hash TEXT NOT NULL, day TEXT NOT NULL, provider TEXT NOT NULL DEFAULT 'deepseek',
        requests INTEGER NOT NULL DEFAULT 0, prompt_tokens INTEGER NOT NULL DEFAULT 0,
        completion_tokens INTEGER NOT NULL DEFAULT 0, total_tokens INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (token_hash, day, provider));
      INSERT INTO usage_daily (token_hash, day, provider, requests, prompt_tokens, completion_tokens, total_tokens)
        VALUES ('h', '2026-09-23', 'deepseek', 40, 500000, 26000, 526000);
    `);
    migrate(db);
    migrate(db); // 幂等
    const used = usageOfDay(db, 'h', '2026-09-23');
    expect(used.total_tokens).toBe(526000);
    expect(used.cost_micro_cny).toBe(0);
    recordUsage(db, 'h', '2026-09-23', { prompt_tokens: 100, prompt_cache_hit_tokens: 100, prompt_cache_miss_tokens: 0, completion_tokens: 0 }, 'deepseek', { model: 'deepseek-v4-flash' });
    expect(usageOfDay(db, 'h', '2026-09-23').cost_micro_cny).toBe(4);
  });

  it('更老的库(连 provider 都没有)也一路升上来,成本列不被重建那一步吃掉', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(`
      CREATE TABLE tokens (token_hash TEXT PRIMARY KEY, prefix TEXT NOT NULL, account TEXT NOT NULL,
        device_id TEXT NOT NULL, daily_token_limit INTEGER NOT NULL, created_at TEXT NOT NULL, revoked_at TEXT);
      CREATE TABLE usage_daily (token_hash TEXT NOT NULL, day TEXT NOT NULL, requests INTEGER NOT NULL DEFAULT 0,
        prompt_tokens INTEGER NOT NULL DEFAULT 0, completion_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (token_hash, day));
      INSERT INTO usage_daily VALUES ('h', '2026-09-21', 3, 100, 50, 150);
    `);
    migrate(db);
    const names = db.prepare('PRAGMA table_info(usage_daily)').all().map(r => r.name);
    expect(names).toEqual(expect.arrayContaining(['provider', 'cache_hit_tokens', 'cache_miss_tokens', 'cost_micro_cny']));
    expect(usageOfDay(db, 'h', '2026-09-21')).toMatchObject({ total_tokens: 150, cost_micro_cny: 0 });
  });

  it('recordUsage 用调用方带进来的价格表', () => {
    const db = openRelayDb(':memory:');
    const prices = relayPricesConfigOf({ RELAY_PRICE_DEEPSEEK_FLASH_CNY: '0.02,1,4' }).tiers;
    recordUsage(db, 'h', 'd', { prompt_tokens: 1000, completion_tokens: 100 }, 'deepseek', { model: 'deepseek-v4-flash', prices });
    expect(usageOfDay(db, 'h', 'd').cost_micro_cny).toBe(1000 * 1 + 100 * 4);
  });
});

describe('对着假上游真跑', () => {
  let upstream;
  let server;

  afterEach(async () => {
    if (server !== undefined) await new Promise(done => server.close(done));
    if (upstream !== undefined) await upstream.close();
    server = undefined;
    upstream = undefined;
  });

  async function start(usage, overrides = {}) {
    upstream = await startFakeUpstream({ expectedKey: 'sk-fake', usage });
    const db = openRelayDb(':memory:');
    const config = { ...relayConfigOf({}), upstreamUrl: upstream.url, upstreamKey: 'sk-fake', ...overrides };
    server = await new Promise((resolve) => {
      const s = createApp({ db, config }).listen(0, '127.0.0.1', () => resolve(s));
    });
    const token = issueToken(db, { account: 'ben', deviceId: 'mac-1', dailyTokenLimit: 500_000 }).token;
    return { base: `http://127.0.0.1:${server.address().port}`, token };
  }

  const chat = (base, token, stream) => fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ model: 'deepseek-v4-flash', stream, messages: [{ role: 'user', content: '嗨' }] }),
  });

  for (const stream of [false, true]) {
    it(`★ 缓存命中按命中价记(${stream ? '流式' : '非流式'})`, async () => {
      const { base, token } = await start({
        prompt_tokens: 10_000, prompt_cache_hit_tokens: 9_000, prompt_cache_miss_tokens: 1_000,
        completion_tokens: 100, total_tokens: 10_100,
      });
      const res = await chat(base, token, stream);
      await res.text();
      const usage = await (await fetch(`${base}/v1/usage`, { headers: { authorization: `Bearer ${token}` } })).json();
      // 9000×0.04 + 1000×2 + 100×8 = 360 + 2000 + 800 = 3160 微元
      expect(usage.used_cny).toBeCloseTo(0.00316, 9);
      expect(usage.cache_hit_tokens).toBe(9_000);
      expect(usage.cache_miss_tokens).toBe(1_000);
      expect(usage.by_provider[0].cost_cny).toBeCloseTo(0.00316, 9);
    });
  }

  it('★ 50 万 token 的命中不再把额度撞满(那天的场景,上限 5 元)', async () => {
    const { base, token } = await start({
      prompt_tokens: 526_000, prompt_cache_hit_tokens: 340_000, prompt_cache_miss_tokens: 186_000,
      completion_tokens: 0, total_tokens: 526_000,
    });
    expect((await chat(base, token, false)).status).toBe(200);
    expect((await chat(base, token, false)).status).toBe(200);
  });

  it('/health 说出每日上限与注意事项', async () => {
    const { base } = await start(undefined, { warnings: ['RELAY_DAILY_TOKEN_LIMIT 已废弃并被忽略'] });
    const health = await (await fetch(`${base}/health`)).json();
    expect(health.daily_cost_limit_cny).toBe(5);
    expect(health.warnings).toEqual(['RELAY_DAILY_TOKEN_LIMIT 已废弃并被忽略']);
  });
});
