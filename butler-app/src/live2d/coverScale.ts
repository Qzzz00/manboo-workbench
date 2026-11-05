// 来源:Aiboo origin/main 7c55ce12 src/features/live2d/coverScale.ts
/**
 * 计算 cover 背景纹理填充舞台所需的缩放系数
 * 纹理被缩放填满舞台，然后乘以 overscan 余量系数避免位移时边缘露白
 *
 * @param texW 纹理宽度
 * @param texH 纹理高度
 * @param screenW 舞台宽度
 * @param screenH 舞台高度
 * @param overscan 余量系数（默认 1，无额外缩放）
 * @returns 缩放系数
 */
export function computeCoverScale(
  texW: number,
  texH: number,
  screenW: number,
  screenH: number,
  overscan: number = 1,
): number {
  const safeW = Math.max(texW, 1);
  const safeH = Math.max(texH, 1);
  const scaleByWidth = screenW / safeW;
  const scaleByHeight = screenH / safeH;
  const coverScale = Math.max(scaleByWidth, scaleByHeight);
  return coverScale * overscan;
}
