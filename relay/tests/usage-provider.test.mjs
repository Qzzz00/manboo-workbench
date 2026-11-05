// 用量按家分开记(2026-09-22)。
//
// 两件事要钉死:
// 1. **存量库能原地升上来**:服务器上那张 usage_daily 里已经有 Ben 那台 Mac 的账,
//    这一版给它加一列 provider,老行一律算 DeepSeek(它们本来就只可能是 DeepSeek);
// 2. **额度仍按总数算**:三家加起来跟上限比。分家只是"看得见花在谁身上",
//    不是三份各自独立的额度 —— 那会变成"今天的钱没用完但这家用完了"这种没人懂的状态。
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';

import { migrate, openRelayDb, usageDailyHasProvider } from '../server/db.cjs';
import { recordUsage, usageByProvider, usageOfDay, usageReport } from '../server/usage.cjs';

/** 这一版之前的那张表,逐字照抄(PK 只有两列、没有 provider)。 */
const LEGACY_SCHEMA = `
CREATE TABLE usage_daily (
  token_hash        TEXT NOT NULL,
  day               TEXT NOT NULL,
  requests          INTEGER NOT NULL DEFAULT 0,
  prompt_tokens     INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (token_hash, day)
);
CREATE TABLE tokens (
  token_hash TEXT PRIMARY KEY, prefix TEXT NOT NULL, account TEXT NOT NULL,
  device_id TEXT NOT NULL, daily_token_limit INTEGER NOT NULL,
  created_at TEXT NOT NULL, revoked_at TEXT
);
`;

function legacyDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(LEGACY_SCHEMA);
  db.prepare('INSERT INTO usage_daily (token_hash, day, requests, prompt_tokens, completion_tokens, total_tokens)'
    + ' VALUES (?, ?, ?, ?, ?, ?)').run('hash-ben', '2026-09-21', 3, 100, 50, 150);
  return db;
}

describe('存量库升级', () => {
  it('★ 老行一个都不丢,provider 一律补成 deepseek', () => {
    const db = legacyDb();
    expect(usageDailyHasProvider(db)).toBe(false);
    migrate(db);
    expect(usageDailyHasProvider(db)).toBe(true);
    const rows = db.prepare('SELECT * FROM usage_daily').all();
    expect(rows).toHaveLength(1);
    expect(rows[0].provider).toBe('deepseek');
    expect(Number(rows[0].total_tokens)).toBe(150);
    expect(Number(rows[0].requests)).toBe(3);
  });

  it('幂等:连跑三次,表还是一张、行还是那一行', () => {
    const db = legacyDb();
    migrate(db);
    migrate(db);
    migrate(db);
    expect(db.prepare('SELECT COUNT(*) AS n FROM usage_daily').get().n).toBe(1);
    // 中间那张临时表不许留在库里。
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
    expect(tables).not.toContain('usage_daily_new');
  });

  it('升完之后同一天能同时记下三家(老 PK 只有两列,不升就插不进第二家)', () => {
    const db = legacyDb();
    migrate(db);
    recordUsage(db, 'hash-ben', '2026-09-21', { total_tokens: 20 }, 'openai');
    recordUsage(db, 'hash-ben', '2026-09-21', { total_tokens: 5 }, 'doubao');
    expect(db.prepare('SELECT COUNT(*) AS n FROM usage_daily').get().n).toBe(3);
  });

  it('新库(没有存量)直接就是新形状', () => {
    expect(usageDailyHasProvider(openRelayDb(':memory:'))).toBe(true);
  });
});

describe('记账与读账', () => {
  const day = '2026-09-22';
  function db3() {
    const db = openRelayDb(':memory:');
    recordUsage(db, 'h1', day, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }, 'deepseek');
    recordUsage(db, 'h1', day, { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 }, 'openai');
    recordUsage(db, 'h1', day, { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 }, 'openai');
    recordUsage(db, 'h1', day, { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }, 'doubao');
    return db;
  }

  it('★ usageOfDay 是三家的和 —— 额度拿它跟上限比,口径一个字没变', () => {
    const used = usageOfDay(db3(), 'h1', day);
    expect(used.total_tokens).toBe(77);
    expect(used.requests).toBe(4);
    expect(used.prompt_tokens).toBe(51);
    expect(used.completion_tokens).toBe(26);
  });

  it('usageByProvider 按家分开,顺序固定(deepseek → openai → doubao)', () => {
    const rows = usageByProvider(db3(), 'h1', day);
    expect(rows.map(r => r.provider)).toEqual(['deepseek', 'openai', 'doubao']);
    expect(rows.map(r => r.total_tokens)).toEqual([15, 60, 2]);
    expect(rows.map(r => r.requests)).toEqual([1, 2, 1]);
  });

  it('★ 一次都没用过的那一家也在表里,回 0 —— 界面上「今天没用过 GPT」要显示得出来', () => {
    const db = openRelayDb(':memory:');
    recordUsage(db, 'h1', day, { total_tokens: 15 }, 'deepseek');
    const rows = usageByProvider(db, 'h1', day);
    expect(rows).toHaveLength(3);
    expect(rows.find(r => r.provider === 'openai').total_tokens).toBe(0);
  });

  it('没给 provider 时按 deepseek 记(老调用方一个字不用改)', () => {
    const db = openRelayDb(':memory:');
    recordUsage(db, 'h1', day, { total_tokens: 9 });
    expect(usageByProvider(db, 'h1', day).find(r => r.provider === 'deepseek').total_tokens).toBe(9);
  });

  it('认不出的 provider 归 deepseek —— 不往库里写一个没人认识的值', () => {
    const db = openRelayDb(':memory:');
    recordUsage(db, 'h1', day, { total_tokens: 9 }, '火星');
    expect(usageByProvider(db, 'h1', day).find(r => r.provider === 'deepseek').total_tokens).toBe(9);
  });

  it('上游没回 usage 时只加一次数、token 加 0(不猜不估)', () => {
    const db = openRelayDb(':memory:');
    recordUsage(db, 'h1', day, undefined, 'openai');
    const row = usageByProvider(db, 'h1', day).find(r => r.provider === 'openai');
    expect(row.requests).toBe(1);
    expect(row.total_tokens).toBe(0);
  });

  it('管理面那张报表仍是一个令牌一行(三家求和),另带分家明细', () => {
    const db = openRelayDb(':memory:');
    db.prepare('INSERT INTO tokens (token_hash, prefix, account, device_id, daily_token_limit, created_at)'
      + " VALUES ('h1', 'wb_aaa', 'ben', 'mac-1', 500, '2026-09-20T00:00:00Z')").run();
    recordUsage(db, 'h1', day, { total_tokens: 15 }, 'deepseek');
    recordUsage(db, 'h1', day, { total_tokens: 30 }, 'openai');
    const rows = usageReport(db, day);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].total_tokens)).toBe(45);
    expect(rows[0].prefix).toBe('wb_aaa');
  });
});
