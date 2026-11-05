export type HandheldPage = 'home' | 'games' | 'apps';
export type HandheldSurface = HandheldPage | 'settings';
export type SwipeDirection = 'left' | 'right';
export type SettingsOrigin = 'home' | 'game';
export type HandheldTouchPoint = {
  identifier: number;
  clientX: number;
  clientY: number;
};
export type HandheldSwipeSession = {
  identifier: number;
  start: { x: number; y: number };
};

export type HandheldNavigation =
  | { kind: 'page'; page: HandheldPage }
  | { kind: 'settings'; origin: SettingsOrigin }
  | { kind: 'close-settings' }
  | { kind: 'none' };

const MIN_SWIPE_X_PX = 56;
const HORIZONTAL_DOMINANCE = 1.25;

/**
 * 只把明确的横向拖动解释成页面导航；纵向 ROM/App 列表仍交给浏览器滚动。
 */
export function classifyHorizontalSwipe(dx: number, dy: number): SwipeDirection | null {
  const absX = Math.abs(dx);
  if (absX < MIN_SWIPE_X_PX || absX < Math.abs(dy) * HORIZONTAL_DOMINANCE) return null;
  return dx < 0 ? 'left' : 'right';
}

/** 页面链保持可逆：设置 ← 首页 ↔ 游戏 ↔ 应用。 */
export function navigationForSwipe(surface: HandheldSurface, direction: SwipeDirection): HandheldNavigation {
  if (surface === 'settings' && direction === 'left') return { kind: 'close-settings' };
  if (surface === 'home' && direction === 'left') return { kind: 'page', page: 'games' };
  if (surface === 'home' && direction === 'right') return { kind: 'settings', origin: 'home' };
  if (surface === 'games' && direction === 'left') return { kind: 'page', page: 'apps' };
  if (surface === 'games' && direction === 'right') return { kind: 'page', page: 'home' };
  if (surface === 'apps' && direction === 'right') return { kind: 'page', page: 'games' };
  return { kind: 'none' };
}

/**
 * 在 move 阶段就根据位移产生命令。游戏/应用页是纵向滚动容器，旧 WebView 可能在
 * pointerup 之前发 pointercancel；等到结束才识别会出现“首页能滑，列表页不能滑”。
 */
export function navigationForSwipeProgress(
  surface: HandheldSurface,
  start: { x: number; y: number },
  current: { x: number; y: number },
): HandheldNavigation {
  const direction = classifyHorizontalSwipe(current.x - start.x, current.y - start.y);
  return direction ? navigationForSwipe(surface, direction) : { kind: 'none' };
}

/**
 * Android WebView 的可滚动列表会在 pointerup 前取消 PointerEvent；原生 TouchEvent
 * 仍会带着最初那根手指的 identifier。只跟踪该手指，避免多点触控时跳到另一根手指。
 */
export function navigationForTrackedTouch(
  surface: HandheldSurface,
  session: HandheldSwipeSession,
  touches: ArrayLike<HandheldTouchPoint>,
): HandheldNavigation {
  for (let i = 0; i < touches.length; i += 1) {
    const touch = touches[i];
    if (touch?.identifier === session.identifier) {
      return navigationForSwipeProgress(
        surface,
        session.start,
        { x: touch.clientX, y: touch.clientY },
      );
    }
  }
  return { kind: 'none' };
}

export function settingsClosePolicy(origin: SettingsOrigin) {
  return origin === 'game'
    ? ({ destination: 'game', keepStrip: true } as const)
    : ({ destination: 'home', keepStrip: false } as const);
}
