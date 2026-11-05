export type PetVisualMode = {
  stripOn: boolean;
  bgOn: boolean;
  chibi: boolean;
};

/** 浮窗需要柔边防截肢；游戏底条固定在屏幕边缘，应保留完整轮廓。 */
export function shouldFadePetBottom({ stripOn, bgOn, chibi }: PetVisualMode): boolean {
  return !stripOn && !bgOn && !chibi;
}

/**
 * 原生 SurfaceView 位于 WebView 之上，DOM 的 z-index 无法盖住它。
 * 游戏底条要让角色从底栏上方探出来，因此保持完整 alpha；普通浮窗才需要柔边防截肢。
 */
export function nativePetBottomMask(mode: PetVisualMode): { start: number; end: number } | null {
  if (mode.stripOn) return null;
  return shouldFadePetBottom(mode) ? { start: 0.76, end: 0.98 } : null;
}
