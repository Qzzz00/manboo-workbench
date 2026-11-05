import { describe, it, expect } from 'vitest';
import { decideIdle, initSchedule, markReaction, type ScheduleCtx } from './petSchedule.ts';

const T0 = 1_000_000_000;
const MIN = 60_000;
const baseCtx = (over: Partial<ScheduleCtx> = {}): ScheduleCtx => ({
  now: T0, page: 'radio', blocked: false, playing: false,
  hunger: 'ok', sleepy: false, level: 3, boredMs: 0, avatarId: 'ghostpuppy', ...over,
});
// 到点的状态（nextIdleAt 已过、20s 安静窗也过）
const due = () => ({ ...initSchedule(T0 - 10 * MIN, () => 0), lastReactionAt: T0 - MIN });

describe('安静规则一票否决', () => {
  it('非 DJ 页 / blocked / 距上次反应 <20s → 不发且顺延', () => {
    for (const ctx of [baseCtx({ page: 'home' }), baseCtx({ blocked: true })]) {
      const r = decideIdle(due(), ctx, () => 0);
      expect(r.behavior).toBeNull();
      expect(r.next.nextIdleAt).toBeGreaterThan(T0); // 顺延，不烧掉这一发
    }
    const quiet = { ...due(), lastReactionAt: T0 - 10_000 };
    expect(decideIdle(quiet, baseCtx(), () => 0).behavior).toBeNull();
  });
  it('没到点不发', () => {
    const st = initSchedule(T0, () => 0.5); // nextIdleAt 在未来
    expect(decideIdle(st, baseCtx(), () => 0).behavior).toBeNull();
  });
});

describe('行为选择', () => {
  it('饿 + 提醒冷却过 → hungryRemind（rand<0.5）', () => {
    const r = decideIdle(due(), baseCtx({ hunger: 'hungry' }), () => 0.1);
    expect(r.behavior).toBe('hungryRemind');
    expect(r.next.lastRemindAt).toBe(T0);
  });
  it('提醒 30min 冷却内不再提醒', () => {
    const st = { ...due(), lastRemindAt: T0 - 10 * MIN };
    const r = decideIdle(st, baseCtx({ hunger: 'hungry' }), () => 0.1);
    expect(r.behavior).not.toBe('hungryRemind');
  });
  it('播放中 + dance 冷却过 + 概率命中 → dance；10min 冷却内不重复', () => {
    const r = decideIdle(due(), baseCtx({ playing: true }), () => 0.1);
    expect(r.behavior).toBe('dance');
    const r2 = decideIdle({ ...due(), lastDanceAt: T0 - 5 * MIN }, baseCtx({ playing: true }), () => 0.1);
    expect(r2.behavior).not.toBe('dance');
  });
  it('困 → nap 且 napping=true；猫深夜不困（夜里精神）→ 不 nap', () => {
    const r = decideIdle(due(), baseCtx({ sleepy: true }), () => 0.9);
    expect(r.behavior).toBe('nap');
    expect(r.next.napping).toBe(true);
    const cat = decideIdle(due(), baseCtx({ sleepy: true, avatarId: 'hijiki' }), () => 0.9);
    expect(cat.behavior).toBe('attention');
  });
  it('默认求关注；Lv1 还不熟 → 安静跳过但照样重排下一发', () => {
    const r = decideIdle(due(), baseCtx(), () => 0.9);
    expect(r.behavior).toBe('attention');
    const shyR = decideIdle(due(), baseCtx({ level: 1 }), () => 0.9);
    expect(shyR.behavior).toBeNull();
    expect(shyR.next.nextIdleAt).toBeGreaterThan(T0);
  });
  it('发过后 nextIdleAt 落在 2~6min；无聊(>45min)时 1.5~4min', () => {
    const r = decideIdle(due(), baseCtx(), () => 0.5);
    expect(r.next.nextIdleAt - T0).toBeGreaterThanOrEqual(2 * MIN);
    expect(r.next.nextIdleAt - T0).toBeLessThanOrEqual(6 * MIN);
    const b = decideIdle(due(), baseCtx({ boredMs: 50 * MIN }), () => 0.5);
    expect(b.next.nextIdleAt - T0).toBeGreaterThanOrEqual(1.5 * MIN);
    expect(b.next.nextIdleAt - T0).toBeLessThanOrEqual(4 * MIN);
  });
});

describe('markReaction', () => {
  it('清 napping、记 lastReactionAt', () => {
    const st = { ...initSchedule(T0, () => 0), napping: true };
    const m = markReaction(st, T0 + 5);
    expect(m.napping).toBe(false);
    expect(m.lastReactionAt).toBe(T0 + 5);
  });
});
