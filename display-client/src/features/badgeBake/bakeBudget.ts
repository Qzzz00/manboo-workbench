/* 预算内烘焙编排（spec 2026-07-10-badge-budget-aware-bake-design.md）。
 *
 * 原则：预算（PSRAM 预载墙）是烤前已知常量，必须是烘焙的硬出货条件——烤出装不进吧唧的
 * 素材=bug（Ben 2026-07-10 定性）。出货条件=像素门 ✓ + 预载 ≤ 预算 ✓ 双绿。
 *
 * 约束（Ben 锁死）：fps=10、周期 8s、466 分辨率全不许动 ⇒ 帧数恒 80，唯二杠杆=
 * 动的像素面积（运动局部化）与动的幅度（幅度带）——只有 Tier B（wobble）有这两根杠杆，
 * Tier A（authored 动作）时长不可腰斩、单档，超了诚实失败请用户换动作。
 *
 * 流程：烤 → 空帧守卫（合成前！合成后 alpha 全不透明守卫失效）→ 背景合成（测的=投的
 * 字节）→ 真打包实测 → 超了按衰减系数预测直达档跳档重烤（每档完整重走预热/对齐/质检，
 * 不为预算放水像素门）→ 梯子耗尽诚实失败带实测数字。
 */
import { bakeIdle, type BakeResult, type BakeRuntime, type BakeProgress } from './bakeIdle.ts';
import { packBakedBadge, type AbpPackResult } from './abpPack.ts';
import type { BakeProfile } from './bakeProfiles.ts';
import { planNextRungIdx, ABP_SHIP_BUDGET_KB, TIER_B_RUNGS, type BudgetProgress, type TierBRung } from './bakeBudgetPlan.ts';

export { planNextRungIdx, ABP_SHIP_BUDGET_KB, TIER_B_RUNGS } from './bakeBudgetPlan.ts';
export type { BudgetProgress, TierBRung } from './bakeBudgetPlan.ts';

export type BudgetBakeOutcome =
  | { kind: 'fit'; baked: BakeResult; abp: AbpPackResult; sizeKb: number; rung: TierBRung }
  | { kind: 'overBudget'; bestSizeKb: number; lastRung: TierBRung; tier: 'A' | 'B' }
  | { kind: 'aborted'; reason: string };

export async function bakeWithinBudget(args: {
  runtime: BakeRuntime;
  profile: BakeProfile;
  characterId: string;
  /** 空帧/冻结守卫（UI 层语义），在背景合成前对原始帧跑；非 null=整体中止（环境问题，
   * 换档重烤无意义） */
  validate: (baked: BakeResult) => string | null;
  /** 背景合成（打包/回放共用的最终画面）；预算实测用合成后的字节=投放的字节 */
  finalize: (frames: HTMLCanvasElement[]) => HTMLCanvasElement[];
  onProgress?: (p: BakeProgress) => void;
  onBudget?: (b: BudgetProgress) => void;
}): Promise<BudgetBakeOutcome> {
  const { runtime, profile, characterId, validate, finalize, onProgress, onBudget } = args;
  const hasLadder = profile.driver.kind === 'wobble';
  let idx = 0;
  let attempt = 0;
  for (;;) {
    attempt += 1;
    const rung = TIER_B_RUNGS[idx];
    const driver = hasLadder && profile.driver.kind === 'wobble'
      ? { ...profile.driver, ...rung.wobble }
      : profile.driver;
    onBudget?.({ phase: 'attempt', rungLabel: rung.label, attempt });
    const baked = await bakeIdle(runtime, { ...profile, driver }, onProgress);
    const veto = validate(baked);
    if (veto) return { kind: 'aborted', reason: veto };
    baked.frames = finalize(baked.frames);
    const abp = packBakedBadge(baked, characterId);
    // 出货体积口径（流式播放后）：约束=abp 文件大小（分区容量+上传通道），非 PSRAM 预载
    const sizeKb = Math.round(abp.buffer.length / 1024);
    if (!baked.certificate.pass) {
      // 像素门没过：预算无从谈起，按既有语义原样交回（UI 显示质检未过+重烤入口）
      return { kind: 'fit', baked, abp, sizeKb, rung };
    }
    if (sizeKb <= ABP_SHIP_BUDGET_KB) return { kind: 'fit', baked, abp, sizeKb, rung };
    if (!hasLadder) return { kind: 'overBudget', bestSizeKb: sizeKb, lastRung: rung, tier: 'A' };
    const next = planNextRungIdx(sizeKb, idx);
    onBudget?.({ phase: 'overBudget', measuredKb: sizeKb, nextRungLabel: next === null ? null : TIER_B_RUNGS[next].label });
    if (next === null) return { kind: 'overBudget', bestSizeKb: sizeKb, lastRung: rung, tier: 'B' };
    // 换档重烤前释放本轮成品画布（160帧≈139MB，等 GC 会叠两轮内存——20fps 档 OOM 教训）
    for (const f of baked.frames) { f.width = 0; f.height = 0; }
    idx = next;
  }
}
