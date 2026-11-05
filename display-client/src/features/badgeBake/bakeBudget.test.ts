import { describe, expect, it } from 'vitest';
import { planNextRungIdx, ABP_SHIP_BUDGET_KB, TIER_B_RUNGS } from './bakeBudgetPlan.ts';

/* 档位规划器（spec 2026-07-10 预算内烘焙 §2）：实测超预算后，用衰减系数预测能进预算的
 * 最高档直接跳过去（省中间档的整轮重烤）；预测全不达标仍顺降一档——系数是保守估计，
 * 实测说了算。 */
describe('planNextRungIdx', () => {
  it('预算常量=出货体积 24MB（流式后=min(分区26624,上传通道25765)留1.2MB边）', () => {
    expect(ABP_SHIP_BUDGET_KB).toBe(24576);
    expect(TIER_B_RUNGS.length).toBe(4);
    expect(TIER_B_RUNGS[0].wobble).toEqual({});
  });
  it('阿虎实况：R1 实测 8636 → 预测跳 R3（8636×0.35=3023 ≤ 3417×0.95）', () => {
    expect(planNextRungIdx(8636, 0, 3417)).toBe(2);
  });
  it('轻度超标：R1 实测 4000 → R2 预测 2000 达标 → 跳 R2', () => {
    expect(planNextRungIdx(4000, 0, 3417)).toBe(1);
  });
  it('梯子耗尽返回 null', () => {
    expect(planNextRungIdx(9999, 3, 3417)).toBe(null);
  });
  it('预测全不达标仍顺降一档（保守系数可能失手）', () => {
    expect(planNextRungIdx(60000, 0, 3417)).toBe(1);
  });
  it('R2 实测后归一化预测：R2 实测 3800（实际系数 0.5）→ R3 预测 3800/0.5×0.35=2660 ✓ 跳 R3', () => {
    expect(planNextRungIdx(3800, 1, 3417)).toBe(2);
  });
});
