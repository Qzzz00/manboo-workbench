import { describe, it, expect } from 'vitest';
import {
  clampClock, defaultPersist, derivePet, levelForXp, loadPet, localDayOf, savePet,
  applyTap, applyFeed, applyCall, tryGreet,
  type PetPersist, type PetStorage,
} from './petState.ts';

const H = 3600_000;
// 2026-07-30 12:00 本地时间（用本地构造，避免时区把「困」测出歧义）
const NOON = new Date(2026, 6, 30, 12, 0, 0).getTime();
const NIGHT = new Date(2026, 6, 30, 23, 30, 0).getTime();

function memStorage(): PetStorage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return { map, getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v) };
}

describe('levelForXp', () => {
  it('阈值 0/50/150/400/1000 → Lv1..Lv5，边界含等号', () => {
    expect(levelForXp(0)).toBe(1);
    expect(levelForXp(49)).toBe(1);
    expect(levelForXp(50)).toBe(2);
    expect(levelForXp(150)).toBe(3);
    expect(levelForXp(400)).toBe(4);
    expect(levelForXp(999)).toBe(4);
    expect(levelForXp(1000)).toBe(5);
    expect(levelForXp(99999)).toBe(5);
  });
});

describe('derivePet', () => {
  it('饿：<3h 饱 / ≤8h 正常 / >8h 有点饿，到底就停', () => {
    const base = defaultPersist(NOON);
    expect(derivePet({ ...base, lastFeedAt: NOON - 1 * H }, NOON).hunger).toBe('full');
    expect(derivePet({ ...base, lastFeedAt: NOON - 5 * H }, NOON).hunger).toBe('ok');
    expect(derivePet({ ...base, lastFeedAt: NOON - 9 * H }, NOON).hunger).toBe('hungry');
    expect(derivePet({ ...base, lastFeedAt: NOON - 100 * H }, NOON).hunger).toBe('hungry');
  });
  it('从没喂过（lastFeedAt=0）不算饿，算正常', () => {
    expect(derivePet(defaultPersist(NOON), NOON).hunger).toBe('ok');
  });
  it('困：23:00~06:00', () => {
    expect(derivePet(defaultPersist(NIGHT), NIGHT).sleepy).toBe(true);
    expect(derivePet(defaultPersist(NOON), NOON).sleepy).toBe(false);
  });
  it('无聊时长 = now - lastTouchAt，非负', () => {
    const p = { ...defaultPersist(NOON), lastTouchAt: NOON - 50 * 60_000 };
    expect(derivePet(p, NOON).boredMs).toBe(50 * 60_000);
    expect(derivePet({ ...p, lastTouchAt: NOON + H }, NOON).boredMs).toBe(0);
  });
});

describe('clampClock', () => {
  it('时间回跳：未来时间戳全部拉回 now', () => {
    const p: PetPersist = {
      ...defaultPersist(NOON),
      lastFeedAt: NOON + H, lastTouchAt: NOON + H,
      feedLog: [NOON - H, NOON + H], tapLog: [{ t: NOON - H, xp: 2 }, { t: NOON + H, xp: 1 }],
    };
    const c = clampClock(p, NOON);
    expect(c.lastFeedAt).toBe(NOON);
    expect(c.lastTouchAt).toBe(NOON);
    expect(c.feedLog.every((t) => t <= NOON)).toBe(true);
    expect(c.tapLog.every((e) => e.t <= NOON)).toBe(true);
  });
});

describe('loadPet / savePet', () => {
  it('存了再读，往返一致（含 clampClock）', () => {
    const st = memStorage();
    const p = { ...defaultPersist(NOON), xp: 77 };
    savePet('hijiki', p, st);
    expect(loadPet('hijiki', NOON, st)).toEqual(p);
  });
  it('坏 JSON / 版本不对 / 空 → 默认档', () => {
    const st = memStorage();
    st.map.set('aiboo:radio-pet:hijiki', '{oops');
    expect(loadPet('hijiki', NOON, st).xp).toBe(0);
    st.map.set('aiboo:radio-pet:hijiki', JSON.stringify({ v: 99, xp: 5 }));
    expect(loadPet('hijiki', NOON, st).xp).toBe(0);
    expect(loadPet('ghostie', NOON, st).xp).toBe(0);
  });
  it('storage 为 null（node/隐私模式）→ 默认档且不抛', () => {
    expect(loadPet('hijiki', NOON, null).xp).toBe(0);
    expect(() => savePet('hijiki', defaultPersist(NOON), null)).not.toThrow();
  });
  it('每只角色一份档案，互不串', () => {
    const st = memStorage();
    savePet('hijiki', { ...defaultPersist(NOON), xp: 10 }, st);
    savePet('ghostie', { ...defaultPersist(NOON), xp: 20 }, st);
    expect(loadPet('hijiki', NOON, st).xp).toBe(10);
    expect(loadPet('ghostie', NOON, st).xp).toBe(20);
  });
  it('tapLog 含坏项（缺 t/xp）→ 防御过滤，保留有效项或回落 []', () => {
    const st = memStorage();
    // 存档 tapLog 含坏项
    st.map.set('aiboo:radio-pet:hijiki', JSON.stringify({
      v: 1, xp: 10, tapLog: [
        { t: NOON - 1000, xp: 2 },
        { t: NOON - 500 }, // 缺 xp
        { xp: 2 }, // 缺 t
        { t: NOON - 100, xp: 1 },
      ],
    }));
    const loaded = loadPet('hijiki', NOON, st);
    expect(Array.isArray(loaded.tapLog)).toBe(true);
    expect(loaded.tapLog.length).toBe(2); // 只保留两个有效项
    expect(loaded.tapLog[0]).toEqual({ t: NOON - 1000, xp: 2 });
    expect(loaded.tapLog[1]).toEqual({ t: NOON - 100, xp: 1 });
  });
});

describe('localDayOf', () => {
  it('YYYY-MM-DD 补零', () => {
    expect(localDayOf(new Date(2026, 0, 5).getTime())).toBe('2026-01-05');
  });
});

describe('applyTap', () => {
  it('摸头 +2 / 戳 +1，计数与 lastTouchAt 更新', () => {
    let p = defaultPersist(NOON - H);
    p = applyTap(p, 'head', NOON);
    expect(p.xp).toBe(2);
    p = applyTap(p, 'body', NOON + 1);
    expect(p.xp).toBe(3);
    expect(p.counters.taps).toBe(2);
    expect(p.lastTouchAt).toBe(NOON + 1);
  });
  it('真滚动窗（60s）vs 固定桶：边界后爆发连击判别性测试', () => {
    let p = defaultPersist(NOON);
    // 阶段1: 初始 5 连 head（t=0..400ms）打到 +10 封顶
    // t=0ms: 摸 +2
    p = applyTap(p, 'head', NOON);
    expect(p.xp).toBe(2);
    // t=100,200,300,400ms: 各摸 +2
    for (let i = 1; i < 5; i += 1) p = applyTap(p, 'head', NOON + i * 100);
    expect(p.xp).toBe(10); // 5×2=10，达封顶
    expect(p.tapLog.length).toBe(5);

    // 阶段2: 窗内还在等待时摸一下，gain=0（因已封顶）
    p = applyTap(p, 'head', NOON + 59_500);
    expect(p.xp).toBe(10); // 不涨

    // 阶段3: 边界突破后爆发连击（t=60_001..60_005）
    // 这是判别点：新滚动窗 vs 旧固定桶
    // 新算法: t=60_001 时滤窗 → 60_001-0=60_001≥60_000(失) 60_001-100=59_901<60_000(保)...
    //        保留 t=100,200,300,400 四条，used=8，剩余 2，5 连摸只 +2（首摸 +2，余摸 +0）
    // 旧算法: t=60_001 时窗重置={start:60001,xp:0}，5 连摸 +10，再加之前步骤 = +20
    for (let i = 0; i < 5; i += 1) p = applyTap(p, 'head', NOON + 60_001 + i);
    expect(p.xp).toBe(12); // 新滚动窗：+2 only（旧桶会是 +20，所以这是判别点）

    // 验证此后只剩 t=60_001..60_005 的 2 点额度在窗内
    // t=120_001 时那 5 条都过期，窗口清空，可重新积累
    p = applyTap(p, 'head', NOON + 120_001);
    expect(p.xp).toBe(14); // 新窗新额度，+2
  });
});

describe('applyFeed', () => {
  it('正常 +10，饱腹 +2，对口再 +2；lastFeedAt/计数更新', () => {
    const r1 = applyFeed(defaultPersist(NOON), { favorite: false, sated: false }, NOON);
    expect(r1.gained).toBe(10);
    const r2 = applyFeed(defaultPersist(NOON), { favorite: true, sated: false }, NOON);
    expect(r2.gained).toBe(12);
    const r3 = applyFeed(defaultPersist(NOON), { favorite: false, sated: true }, NOON);
    expect(r3.gained).toBe(2);
    expect(r1.next.lastFeedAt).toBe(NOON);
    expect(r1.next.counters.feeds).toBe(1);
  });
  it('每小时只有前 3 次计 XP，第 4 次 gained=0 但 lastFeedAt 照更新', () => {
    let p = defaultPersist(NOON);
    for (let i = 0; i < 3; i += 1) p = applyFeed(p, { favorite: false, sated: false }, NOON + i).next;
    const r4 = applyFeed(p, { favorite: true, sated: false }, NOON + 10);
    expect(r4.gained).toBe(0);
    expect(r4.next.lastFeedAt).toBe(NOON + 10);
    // 1h 后窗口滑走，重新计
    const r5 = applyFeed(r4.next, { favorite: false, sated: false }, NOON + H + 20);
    expect(r5.gained).toBe(10);
  });
});

describe('applyCall / tryGreet', () => {
  it('通话每句 +3', () => {
    const p = applyCall(defaultPersist(NOON), NOON);
    expect(p.xp).toBe(3);
    expect(p.counters.calls).toBe(1);
  });
  it('每日首见 +5，同日第二次不触发', () => {
    const r1 = tryGreet(defaultPersist(NOON), NOON);
    expect(r1.greeted).toBe(true);
    expect(r1.next.xp).toBe(5);
    const r2 = tryGreet(r1.next, NOON + 60_000);
    expect(r2.greeted).toBe(false);
    const r3 = tryGreet(r1.next, NOON + 24 * H);
    expect(r3.greeted).toBe(true);
  });
});
