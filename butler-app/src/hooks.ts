import { useEffect, useState, useSyncExternalStore } from 'react';
import type { StateFeed, FeedSnapshot } from './api/stateFeed';
import type { AppearanceFeed, AppearanceState } from './swarm/appearance';
import { clockOf, type NowRef } from './clock';

export function useFeed(feed: StateFeed): FeedSnapshot {
  return useSyncExternalStore((cb) => feed.subscribe(cb), () => feed.get(), () => feed.get());
}

const noFeedSubscribe = (): (() => void) => () => {};

/**
 * 「多人协作区」总开关(2026-11-09):电脑那边 /state.collab_enabled 说了算,手机不自己猜。
 * 老工作台 / 掉线 / 开源版关着时一律 false —— 入口整块收起(fail-closed)。
 * 订阅状态流:开关随快照到达或改变时,这一格当场跟着变,不用重启 App。
 */
export function useCollabEnabled(feed: StateFeed | undefined): boolean {
  return useSyncExternalStore(
    feed === undefined ? noFeedSubscribe : (cb) => feed.subscribe(cb),
    () => feed?.get().state.collab_enabled === true,
    () => false,
  );
}

export function useAppearance(feed: AppearanceFeed): AppearanceState {
  return useSyncExternalStore((cb) => feed.subscribe(cb), () => feed.get(), () => feed.get());
}

/** 横屏 = 展示台。折叠屏展开是「宽竖屏」,不算横屏,由 CSS 断点处理并排。 */
export function useLandscape(): boolean {
  const query = '(orientation: landscape)';
  const [landscape, setLandscape] = useState(() => (typeof window === 'undefined' ? false : window.matchMedia(query).matches));
  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = () => setLandscape(mql.matches);
    mql.addEventListener('change', onChange);
    onChange();
    return () => mql.removeEventListener('change', onChange);
  }, []);
  return landscape;
}

/**
 * 折叠屏展开 / 平板竖屏:事项一栏常驻左边(2026-09-24,卡 fix/phone-nav-back)。
 * 断点与 styles.css 末尾那段 `@media (orientation: portrait) and (min-width: 600px)` 同一个 ——
 * 返回键要知道哪几格此刻看得见(nav/navModel.ts 的 paneShown);排布本身仍只由 CSS 定。
 */
export function usePortraitSplit(): boolean {
  const query = '(orientation: portrait) and (min-width: 600px)';
  const [split, setSplit] = useState(() => (typeof window === 'undefined' ? false : window.matchMedia(query).matches));
  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = () => setSplit(mql.matches);
    mql.addEventListener('change', onChange);
    onChange();
    return () => mql.removeEventListener('change', onChange);
  }, []);
  return split;
}

/**
 * 一行上那个时刻:`/state.now` **那一天**只写「21:30」,别的日子写「10-01 21:30」。
 *
 * `now` 是 2026-10-02(卡 claude/phone-clock)加的,而且**是必填的** —— 原来这里判
 * 「是不是今天」用的是手机自己的墙钟,于是同一屏上「办完 · 今天」那个抬头按电脑的钟写,
 * 底下每张卡写不写日期按手机的钟定,两处可能对不上(根因与拍板见 src/clock.ts)。
 * 必填是为了让 tsc 替人把关:少传一处就红,没有哪一处能偷偷退回手机的墙钟。
 * 读不出 `now`(还没连上那一瞬是空串)才退回手机的钟,见 {@link clockOf}。
 */
export function formatClock(iso: string | undefined, now: NowRef): string {
  if (iso === undefined) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const today = clockOf(now);
  const sameDay = d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate();
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return sameDay ? hm : `${d.getMonth() + 1}-${String(d.getDate()).padStart(2, '0')} ${hm}`;
}
