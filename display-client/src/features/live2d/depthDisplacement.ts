/**
 * 位移驱动纯函数：陀螺仪倾角 → DisplacementFilter 位移强度
 *
 * 语义：手机倾斜 → DisplacementFilter 位移强度，营造 2.5D 景深。
 * 方向按真机手感标定（2026-07-04 Pixel 实测）：同向映射，手机右倾/前倾 → 正位移。
 * @param nx 标准化倾向（通常 [-1, 1]），超出自动钳制
 * @param ny 标准化倾向（通常 [-1, 1]），超出自动钳制
 * @param maxScale 位移强度上限
 * @returns {{ sx: number; sy: number }} 位移向量（同向：正倾→正位移）
 */
export function depthDisplacement(
  nx: number,
  ny: number,
  maxScale: number
): { sx: number; sy: number } {
  // 钳制到 [-1, 1]
  const clampedNx = Math.max(-1, Math.min(1, nx));
  const clampedNy = Math.max(-1, Math.min(1, ny));

  // 同向语义（真机标定）：手机右倾(+nx) → 正位移(+sx)
  const sx = clampedNx * maxScale;
  const sy = clampedNy * maxScale;
  return {
    sx: sx === 0 ? 0 : sx, // 消除 -0
    sy: sy === 0 ? 0 : sy,
  };
}
