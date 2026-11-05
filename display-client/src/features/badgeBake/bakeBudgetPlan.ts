/* 预算档位规划（纯函数层，零重依赖——可在 node 单测；编排在 bakeBudget.ts）。
 * spec: docs/superpowers/specs/2026-07-10-badge-budget-aware-bake-design.md §1/§2 */

/** 出货体积预算（KB）：flash 流式播放（2026-07-10 拆墙，patch 0006）后约束=abp **文件体积**
 * 而非 PSRAM 预载——真实上限=min(abp 分区 26624KB, 上传通道 25765KB[express 32mb JSON
 * ÷ base64 4/3 - meta])，留 ~1.2MB 边 → 24MB（22MB 首版被双生全配置 20fps=22.3MB 压线
 * 打脸，边留肥了）。旧 PSRAM 墙 3417KB 已成历史（preloadKbOf 口径保留作诊断参考）。 */
export const ABP_SHIP_BUDGET_KB = 24576;

export type TierBRung = {
  key: 'R1' | 'R2' | 'R3' | 'R4';
  /** 用户可见档位名（进度/证书文案直接用） */
  label: string;
  wobble: { ampScale?: number; localized?: boolean };
};

/** Tier B 降档梯子（fps=10/周期 8s 锁死后的全部空间；R4 仍超=诚实失败）。 */
export const TIER_B_RUNGS: TierBRung[] = [
  { key: 'R1', label: '全身摆动', wobble: {} },
  { key: 'R2', label: '轻幅摆动', wobble: { ampScale: 0.6 } },
  { key: 'R3', label: '头部微动', wobble: { localized: true } },
  { key: 'R4', label: '头部微动·轻幅', wobble: { localized: true, ampScale: 0.7 } },
];

/** 各档相对 R1 的预载衰减系数（保守估计；delta 字节≈动的面积×幅度，实测说了算）。 */
const RUNG_FACTOR = [1, 0.5, 0.35, 0.25];

/** 实测超预算后选下一档：预测能进预算（≤95% 留安全边）的最高档直接跳，省中间档整轮
 * 重烤；预测全不达标仍顺降一档（系数可能失手）。梯子耗尽返回 null。 */
export function planNextRungIdx(measuredKb: number, currentIdx: number, budgetKb: number = ABP_SHIP_BUDGET_KB): number | null {
  const base = measuredKb / RUNG_FACTOR[currentIdx];   // 归一化回 R1 当量
  for (let i = currentIdx + 1; i < TIER_B_RUNGS.length; i += 1) {
    if (base * RUNG_FACTOR[i] <= budgetKb * 0.95) return i;
  }
  return currentIdx + 1 < TIER_B_RUNGS.length ? currentIdx + 1 : null;
}

export type BudgetProgress =
  | { phase: 'attempt'; rungLabel: string; attempt: number }
  | { phase: 'overBudget'; measuredKb: number; nextRungLabel: string | null };
