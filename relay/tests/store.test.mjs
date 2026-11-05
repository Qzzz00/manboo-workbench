import { beforeEach, describe, expect, it } from 'vitest';

import { openRelayDb } from '../server/db.cjs';
import { activeTokenCount, findToken, hashToken, issueToken, revokeByPrefix } from '../server/tokens.cjs';
import { dayKey, recordUsage, usageOfDay, usageReport } from '../server/usage.cjs';

let db;
beforeEach(() => { db = openRelayDb(':memory:'); });

describe('令牌表', () => {
  it('发出来的令牌认得出来,别的认不出来', () => {
    const issued = issueToken(db, { account: 'ben', deviceId: 'mac-1', dailyTokenLimit: 100 });
    expect(findToken(db, issued.token)?.account).toBe('ben');
    expect(findToken(db, 'wb_不存在的')).toBeUndefined();
    expect(findToken(db, 'sk-别人家的')).toBeUndefined();
    expect(findToken(db, undefined)).toBeUndefined();
  });

  it('库里只有哈希,没有明文', () => {
    const issued = issueToken(db, { account: 'ben', deviceId: 'mac-1', dailyTokenLimit: 100 });
    const rows = db.prepare('SELECT * FROM tokens').all();
    expect(rows[0].token_hash).toBe(hashToken(issued.token));
    // 整张表序列化之后都不该出现那一串。
    expect(JSON.stringify(rows)).not.toContain(issued.token);
  });

  it('同一台设备重领:换新的,旧的当场作废,设备数不涨', () => {
    const first = issueToken(db, { account: 'ben', deviceId: 'mac-1', dailyTokenLimit: 100 });
    const second = issueToken(db, { account: 'ben', deviceId: 'mac-1', dailyTokenLimit: 100 });
    expect(findToken(db, first.token)).toBeUndefined();
    expect(findToken(db, second.token)?.account).toBe('ben');
    expect(activeTokenCount(db, 'ben')).toBe(1);
  });

  it('两台设备各算一把钥匙', () => {
    issueToken(db, { account: 'ben', deviceId: 'mac-1', dailyTokenLimit: 100 });
    issueToken(db, { account: 'ben', deviceId: 'phone-1', dailyTokenLimit: 100 });
    expect(activeTokenCount(db, 'ben')).toBe(2);
    expect(activeTokenCount(db, '别人')).toBe(0);
  });

  it('按 prefix 吊销', () => {
    const issued = issueToken(db, { account: 'ben', deviceId: 'mac-1', dailyTokenLimit: 100 });
    expect(revokeByPrefix(db, issued.prefix)).toBe(1);
    expect(findToken(db, issued.token)).toBeUndefined();
    // 再吊一次不报错,只是 0 行。
    expect(revokeByPrefix(db, issued.prefix)).toBe(0);
  });
});

describe('用量表', () => {
  it('没记过就是一行全 0', () => {
    expect(usageOfDay(db, 'h', '2026-09-17')).toEqual({
      requests: 0, prompt_tokens: 0, completion_tokens: 0, total_tokens: 0,
      cache_hit_tokens: 0, cache_miss_tokens: 0, cost_micro_cny: 0, cost_cny: 0,
    });
  });

  it('同一天累加,不同天分开', () => {
    recordUsage(db, 'h', '2026-09-17', { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 });
    recordUsage(db, 'h', '2026-09-17', { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 });
    recordUsage(db, 'h', '2026-09-18', { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 });
    expect(usageOfDay(db, 'h', '2026-09-17')).toMatchObject({
      requests: 2, prompt_tokens: 11, completion_tokens: 22, total_tokens: 33,
    });
    expect(usageOfDay(db, 'h', '2026-09-18').total_tokens).toBe(10);
  });

  it('上游没回 usage 时只涨次数,token 加 0(不估、不编)', () => {
    recordUsage(db, 'h', '2026-09-17', undefined);
    expect(usageOfDay(db, 'h', '2026-09-17')).toEqual({
      requests: 1, prompt_tokens: 0, completion_tokens: 0, total_tokens: 0,
      cache_hit_tokens: 0, cache_miss_tokens: 0, cost_micro_cny: 0, cost_cny: 0,
    });
  });

  it('只给了 prompt/completion 时 total 自己算出来', () => {
    recordUsage(db, 'h', '2026-09-17', { prompt_tokens: 4, completion_tokens: 6 });
    expect(usageOfDay(db, 'h', '2026-09-17').total_tokens).toBe(10);
  });

  it('报表带账号与 prefix,不带明文令牌;没用过的令牌也在里面(0)', () => {
    const a = issueToken(db, { account: 'ben', deviceId: 'mac-1', dailyTokenLimit: 100 });
    const b = issueToken(db, { account: '小李', deviceId: 'mac-2', dailyTokenLimit: 100 });
    const day = dayKey(new Date('2026-09-17T02:00:00Z'), 480);
    recordUsage(db, findToken(db, a.token).token_hash, day, { total_tokens: 42 });
    const rows = usageReport(db, day);
    expect(rows.map(r => r.account)).toEqual(['ben', '小李']);
    expect(rows[0].total_tokens).toBe(42);
    expect(rows[1].total_tokens).toBe(0);
    expect(JSON.stringify(rows)).not.toContain(a.token);
    expect(JSON.stringify(rows)).not.toContain(b.token);
  });
});
