/**
 * 宠物档案：每只 DJ 一份（localStorage 键含 djId），派生状态（等级/饿/困/无聊）
 * 全部「读时懒计算」，零后台计时器。佛系铁律：XP 只涨不掉，状态到底就停。
 * 纯函数 + 可注入 storage（vitest 跑在 node，没有 localStorage）。
 */

export type Hunger = 'full' | 'ok' | 'hungry';
export type PetCounters = { taps: number; feeds: number; calls: number };
export type PetPersist = {
  v: 1;
  xp: number;
  lastFeedAt: number;   // 0 = 从没喂过
  lastTouchAt: number;  // 最近一次任意互动（摸/喂/通话）
  lastGreetDay: string; // 'YYYY-MM-DD'，每日问候去重
  feedLog: number[];    // 最近 1h 内「计了 XP」的喂食时间戳（每小时前 3 次计）
  tapLog: { t: number; xp: number }[]; // 最近 60s 内「计了 XP」的摸/戳记录（真滚动窗防刷）
  counters: PetCounters;
};
export type PetDerived = { level: 1 | 2 | 3 | 4 | 5; hunger: Hunger; sleepy: boolean; boredMs: number };

export const LEVEL_THRESHOLDS = [0, 50, 150, 400, 1000] as const;
const HOUR = 3600_000;
const FULL_MS = 3 * HOUR;
const HUNGRY_AFTER_MS = 8 * HOUR;

export function defaultPersist(now = 0): PetPersist {
  return {
    v: 1, xp: 0, lastFeedAt: 0, lastTouchAt: now, lastGreetDay: '',
    feedLog: [], tapLog: [],
    counters: { taps: 0, feeds: 0, calls: 0 },
  };
}

export function levelForXp(xp: number): 1 | 2 | 3 | 4 | 5 {
  let lv: 1 | 2 | 3 | 4 | 5 = 1;
  for (let i = 1; i < LEVEL_THRESHOLDS.length; i += 1) {
    if (xp >= LEVEL_THRESHOLDS[i]) lv = (i + 1) as 2 | 3 | 4 | 5;
  }
  return lv;
}

export function localDayOf(now: number): string {
  const d = new Date(now);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/** 时钟回跳（改时间/时区）防御：任何「未来」时间戳拉回 now，派生值绝不为负。 */
export function clampClock(p: PetPersist, now: number): PetPersist {
  return {
    ...p,
    lastFeedAt: Math.min(p.lastFeedAt, now),
    lastTouchAt: Math.min(p.lastTouchAt, now),
    feedLog: p.feedLog.map((t) => Math.min(t, now)),
    tapLog: p.tapLog.map((e) => ({ ...e, t: Math.min(e.t, now) })),
  };
}

export function derivePet(p: PetPersist, now: number): PetDerived {
  const sinceFeed = now - p.lastFeedAt;
  const hunger: Hunger =
    p.lastFeedAt <= 0 ? 'ok'
      : sinceFeed < FULL_MS ? 'full'
        : sinceFeed <= HUNGRY_AFTER_MS ? 'ok'
          : 'hungry';
  const h = new Date(now).getHours();
  return {
    level: levelForXp(p.xp),
    hunger,
    sleepy: h >= 23 || h < 6,
    boredMs: Math.max(0, now - p.lastTouchAt),
  };
}

export type PetStorage = Pick<Storage, 'getItem' | 'setItem'>;
const KEY_PREFIX = 'aiboo:radio-pet:';

function defaultStorage(): PetStorage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null; // 隐私模式/被禁 → 内存降级（调用方拿默认档，只是不记忆）
  }
}

export function loadPet(djId: string, now = Date.now(), storage: PetStorage | null = defaultStorage()): PetPersist {
  if (!storage) return defaultPersist(now);
  try {
    const raw = storage.getItem(KEY_PREFIX + djId);
    if (!raw) return defaultPersist(now);
    const parsed = JSON.parse(raw) as Partial<PetPersist> | null;
    if (!parsed || parsed.v !== 1 || typeof parsed.xp !== 'number') return defaultPersist(now);
    const base = defaultPersist(now);
    return clampClock({
      ...base,
      ...parsed,
      v: 1,
      feedLog: Array.isArray(parsed.feedLog) ? parsed.feedLog.filter((t): t is number => typeof t === 'number') : [],
      tapLog: Array.isArray(parsed.tapLog)
        ? parsed.tapLog.filter((e): e is { t: number; xp: number } =>
            typeof e === 'object' && e !== null && typeof e.t === 'number' && typeof e.xp === 'number')
        : [],
      counters: { ...base.counters, ...(parsed.counters ?? {}) },
    }, now);
  } catch {
    return defaultPersist(now);
  }
}

export function savePet(djId: string, p: PetPersist, storage: PetStorage | null = defaultStorage()): void {
  if (!storage) return;
  try { storage.setItem(KEY_PREFIX + djId, JSON.stringify(p)); } catch { /* 存不了不影响本次会话 */ }
}

const TAP_XP_WINDOW_MS = 60_000;
const TAP_XP_CAP = 10;
const FEED_XP_TIMES_PER_HOUR = 3;

/** 摸头 +2 / 戳 +1，真滚动窗（60s）封顶 +10（防刷）。计数与 lastTouchAt 总是更新。 */
export function applyTap(p: PetPersist, zone: 'head' | 'body', now: number): PetPersist {
  const want = zone === 'head' ? 2 : 1;
  const log = p.tapLog.filter((e) => now - e.t < TAP_XP_WINDOW_MS);
  const used = log.reduce((s, e) => s + e.xp, 0);
  const gain = Math.min(want, Math.max(0, TAP_XP_CAP - used));
  if (gain > 0) log.push({ t: now, xp: gain });
  return {
    ...p,
    xp: p.xp + gain,
    tapLog: log,
    lastTouchAt: now,
    counters: { ...p.counters, taps: p.counters.taps + 1 },
  };
}

/** 喂食：正常 +10 / 饱腹 +2，对口再 +2；每小时前 3 次计 XP（之后 0 但照吃）。 */
export function applyFeed(
  p: PetPersist,
  opts: { favorite: boolean; sated: boolean },
  now: number,
): { next: PetPersist; gained: number } {
  const log = p.feedLog.filter((t) => now - t < 3600_000);
  let gained = 0;
  if (log.length < FEED_XP_TIMES_PER_HOUR) {
    gained = (opts.sated ? 2 : 10) + (opts.favorite ? 2 : 0);
    log.push(now);
  }
  return {
    next: {
      ...p,
      xp: p.xp + gained,
      feedLog: log,
      lastFeedAt: now,
      lastTouchAt: now,
      counters: { ...p.counters, feeds: p.counters.feeds + 1 },
    },
    gained,
  };
}

/** 通话每句 +3（onHeard 时机，ASR 出词）。 */
export function applyCall(p: PetPersist, now: number): PetPersist {
  return { ...p, xp: p.xp + 3, lastTouchAt: now, counters: { ...p.counters, calls: p.counters.calls + 1 } };
}

/** 每日首见 +5：lastGreetDay 换日才触发。 */
export function tryGreet(p: PetPersist, now: number): { next: PetPersist; greeted: boolean } {
  const day = localDayOf(now);
  if (p.lastGreetDay === day) return { next: p, greeted: false };
  return { next: { ...p, xp: p.xp + 5, lastGreetDay: day }, greeted: true };
}
