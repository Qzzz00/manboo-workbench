export interface ParallaxOffset {
  x: number;
  y: number;
}

/**
 * 计算视差位移：根据正规化倾斜角度([-1,1])与最大位移 px，输出视差偏移量。
 *
 * 公式：
 *   offset_x = clamp(nx, -1, 1) × maxPx
 *   offset_y = clamp(ny, -1, 1) × maxPx
 *
 * @param nx 正规化 X 倾斜（-1 ~ 1，越界会被钳制）
 * @param ny 正规化 Y 倾斜（-1 ~ 1，越界会被钳制）
 * @param maxPx 最大位移像素（近层 14px，远层 6px）
 * @returns 视差位移 { x, y }
 */
export function parallaxOffset(
  nx: number,
  ny: number,
  maxPx: number
): ParallaxOffset {
  const clampedNx = Math.max(-1, Math.min(1, nx));
  const clampedNy = Math.max(-1, Math.min(1, ny));

  return {
    x: clampedNx * maxPx,
    y: clampedNy * maxPx,
  };
}
