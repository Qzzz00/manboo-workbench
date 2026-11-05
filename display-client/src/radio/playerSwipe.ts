// 播放条左右滑切歌的判定纯函数。判据与 RadioApp 的切页手势完全同款
// （|dx|≥45、横向优先 1.2 倍、700ms 内），保证两种滑动的手感一致；
// 方向语义按音乐 App 通用约定：左滑（dx<0）=下一首，右滑=上一首。
export type PlayerSwipeAction = 'next' | 'prev';

export function decidePlayerSwipe(dx: number, dy: number, elapsedMs: number): PlayerSwipeAction | null {
  if (elapsedMs > 700) return null;
  if (Math.abs(dx) < 45 || Math.abs(dx) < Math.abs(dy) * 1.2) return null;
  return dx < 0 ? 'next' : 'prev';
}
