/**
 * 自己判定双击，不用浏览器的 dblclick。
 *
 * ★为什么不用 onDoubleClick：Chrome 61 的 WebView 要等「会不会有第三次点击」才派发
 * dblclick，触摸屏上还叠一层 300ms 点击延迟，手感就是 Ben 说的「响应有点奇怪」。
 * 这里在 pointerup 上自己数两下，窗口内且位移小就算双击——立即触发，不等浏览器。
 */
import { useRef, type PointerEvent as ReactPointerEvent } from 'react';
import { djTrace } from '../screensaver/lib/djClient';

/**
 * 两次点击的最大间隔与最大位移。触摸屏上 40px 足够容忍手抖。
 * ★窗口 400 → 800ms：真机打点实测，事件本身到得好好的（tap[…] target=app-shell 都有），
 * 判不中纯粹是间隔超窗。这台机器有 300ms 点击延迟，WebView 一忙 pointerup 还会迟到，
 * 正常两下很容易被算成 >400ms。展示台没有别的点击语义，800ms 不会误触发。
 */
const WINDOW_MS = 800;
const MOVE_PX = 40;

export function useDoubleTap(onDoubleTap: () => void, label = '?') {
  const last = useRef<{ t: number; x: number; y: number } | null>(null);

  return (e: ReactPointerEvent<HTMLElement>) => {
    const now = Date.now();
    const prev = last.current;
    // 打点：这条链断在哪一环全靠它。真机上 CDP 不可用，只能走 logcat。
    djTrace('tap[' + label + '] x=' + Math.round(e.clientX) + ' y=' + Math.round(e.clientY)
      + ' dt=' + (prev ? now - prev.t : -1)
      + ' target=' + ((e.target as HTMLElement)?.className || '?').toString().slice(0, 28));
    if (
      prev !== null
      && now - prev.t <= WINDOW_MS
      && Math.abs(e.clientX - prev.x) <= MOVE_PX
      && Math.abs(e.clientY - prev.y) <= MOVE_PX
    ) {
      last.current = null; // 用掉这一对，避免三连击触发两次
      djTrace('tap[' + label + '] → 双击命中');
      onDoubleTap();
      return;
    }
    last.current = { t: now, x: e.clientX, y: e.clientY };
  };
}
