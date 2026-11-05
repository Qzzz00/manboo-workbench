/**
 * 形象队列与左右滑(2026-10-01,docs/设计-形象切换与形象包-2026-10-01.md 第一节)。
 *
 * 队列 = 粒子球 + 这台手机上已有的形象(内置 + 下载过的),按目录顺序。粒子球永远在第一位、永远在 ——
 * 维护者:「我还是可以通过左右滑或者陈列中选择粒子球搞回来的」。没下载的不进队列:左右滑不会滑到一个要等下载的形象上。
 */

/** 粒子球在队列里的 id。 */
export const PARTICLES = 'particles';

export interface QueueItem { id: string; name: string }

export function buildQueue(catalog: readonly QueueItem[], installed: ReadonlySet<string>): QueueItem[] {
  return [{ id: PARTICLES, name: '粒子球' }, ...catalog.filter((c) => installed.has(c.id)).map((c) => ({ id: c.id, name: c.name }))];
}

export type Swipe = 'next' | 'prev';

/** 向左滑 = 下一个,向右滑 = 上一个,首尾相接。当前那个不在队列里时从粒子球算起。 */
export function stepQueue(ids: readonly string[], current: string, dir: Swipe): string {
  if (ids.length === 0) return PARTICLES;
  const at = Math.max(0, ids.indexOf(current));
  const next = dir === 'next' ? at + 1 : at - 1;
  return ids[(next + ids.length) % ids.length];
}

/** 最小横向位移(px)。 */
export const SWIPE_MIN_PX = 40;

/** 横向位移 ≥ 40 且明显大于纵向(1.5 倍)才算滑动:竖屏首页还要能上下滚。向左滑(dx < 0)= 下一个。 */
export function swipeDirection(dx: number, dy: number): Swipe | null {
  if (Math.abs(dx) < SWIPE_MIN_PX || Math.abs(dx) < Math.abs(dy) * 1.5) return null;
  return dx < 0 ? 'next' : 'prev';
}

/** 名字条:「赛车场 · 3/5」。 */
export function queueLabel(queue: readonly QueueItem[], current: string): string {
  const at = queue.findIndex((q) => q.id === current);
  if (at < 0) return queue[0]?.name ?? '';
  return `${queue[at].name} · ${at + 1}/${queue.length}`;
}
