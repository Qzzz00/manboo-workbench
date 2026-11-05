/* 烘焙证书（纯函数）：无缝的数字验收，「不抽卡」的机制保证。
 *
 * ★判决=像素门（wrapMad ≤ 1.3×medianMad：接缝转移与普通帧间转移同量级——用户看的就是
 * 像素）；粒子残差/亚谐波=预警不否决。两次实证定的形：M9（2T 亚谐波、残差 0.103，像素门
 * 1.07/1.11 照过）与吧唧呼吸衰减带（翅膀弱驱动准振荡钉在残差 0.20，像素门 1.086 优秀）——
 * 粒子级微振荡对屏幕不可见时，拿它否决是「过严假阴性」。确定性由规范初始化保证（同配置
 * 同产物），预警照实入档（meta 带 warnings，回溯有据）。
 */

export type BakeCertificate = {
  warmupCycles: number;
  residual: number;
  subharmonic: number;
  wrapMad: number;
  medianMad: number;
  /** wrapMad / medianMad（medianMad=0 时为 Infinity；两者都≈0 视为静态素材放行） */
  ratio: number;
  /** 像素门判决 */
  pass: boolean;
  /** 仅像素门失败时给出 */
  reason?: string;
  /** 非否决预警（粒子残差未收敛/亚谐波），随 meta 入档 */
  warnings: string[];
};

export const CERT_RESIDUAL_EPS = 0.01;
export const CERT_WRAP_RATIO = 1.3;

export function computeCertificate(
  mads: number[],
  warmup: { cycles: number; residual: number; subharmonic: number },
): BakeCertificate {
  const wrapMad = mads[0] ?? 0;
  const mid = mads.slice(1).filter((m) => Number.isFinite(m)).sort((a, b) => a - b);
  const medianMad = mid.length ? mid[Math.floor(mid.length / 2)] : 0;
  const ratio = medianMad > 0 ? wrapMad / medianMad : (wrapMad === 0 ? 0 : Number.POSITIVE_INFINITY);

  const warnings: string[] = [];
  if (!Number.isFinite(warmup.residual) || warmup.residual >= CERT_RESIDUAL_EPS) {
    warnings.push(`粒子残差未收敛（${Number.isFinite(warmup.residual) ? warmup.residual.toFixed(3) : '未测'} ≥ ${CERT_RESIDUAL_EPS}，弱驱动摆链准振荡常见）`);
  }
  if (warmup.subharmonic > 0) {
    warnings.push(`物理锁入 ${warmup.subharmonic}T 亚谐波轨道`);
  }
  const reason = ratio > CERT_WRAP_RATIO
    ? `接缝超标（回卷MAD ${wrapMad.toFixed(2)} > ${CERT_WRAP_RATIO}×中位 ${medianMad.toFixed(2)}）`
    : undefined;

  return {
    warmupCycles: warmup.cycles,
    residual: warmup.residual,
    subharmonic: warmup.subharmonic,
    wrapMad,
    medianMad,
    ratio,
    pass: reason === undefined,
    reason,
    warnings,
  };
}
