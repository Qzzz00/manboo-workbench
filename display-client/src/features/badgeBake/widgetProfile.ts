import type { BakeProfile, BakeView } from './bakeProfiles.ts';

/**
 * 桌面组件烤帧档（纯函数层，node 可测）：半身构图 320×427（2×3 竖卡 3:4），12fps。
 * 运行时烤帧在 widgetBake.ts（依赖 DOM/PIXI，不能进 node 测试的 import 链）。
 */

/** 半身变焦（1=badge 全身同景别）；构图常量真机看图后可调。 */
const ZOOM = 1.35;
const BASE = 466; // bake 舞台基准方形

const SCALE = (427 / BASE) * ZOOM;

export const WIDGET_VIEW: BakeView = {
  w: 320,
  h: 427,
  stageScale: SCALE,
  stageOffsetX: -(BASE * SCALE - 320) / 2,
  // 上移让头肩落在画幅上 2/3（半身）；负=上移
  stageOffsetY: -(BASE * SCALE * 0.06),
};

/** MIUI launcher 的 ViewFlipper 子类有 ~80ms 间隔地板（50ms 设定实测被钳到 12.9fps 且带抖动；
 * 83ms 忠实执行）——帧率天花板 ≈12fps，是平台墙。墙内最优：12fps 规律节拍 + 慢摆动（
 * 摆动烤半程 2s 后乒乓回放拼环=结构性零接缝，不依赖物理收敛（预热 6 圈可安全保留）。 */
export const WIDGET_SWAY_PERIOD_S = 2;
/** 摆幅倍率：默认摆动在 320px 小卡上是亚像素级（真凶复盘：环=静止+眨眼快照），拉到肉眼可见。 */
export const WIDGET_SWAY_AMP = 2.5;
const FRAME_BUDGET = 48;
const FPS_MAX = 12;
const FPS_MIN = 10;

/** 按环时长自适应帧率：短环给满 20fps，长环降帧保 48 帧预算（低于 10 交给 capFrames 兜底）。 */
export function widgetFpsFor(durationS: number): number {
  if (!Number.isFinite(durationS) || durationS <= 0) return FPS_MAX;
  return Math.max(FPS_MIN, Math.min(FPS_MAX, Math.floor(FRAME_BUDGET / durationS)));
}

/** motionUrl=null → Tier B 自然摆动驱动（无闭环 motion 的角色，如 yumi 只有一次性手势）。 */
export function widgetProfileFor(motionUrl: string | null, durationS: number = WIDGET_SWAY_PERIOD_S): BakeProfile {
  return {
    fps: widgetFpsFor(durationS),
    driver: motionUrl
      ? { kind: 'motion', url: motionUrl, wobble: true, loopMult: 1 }
      : { kind: 'wobble', periodS: durationS, ampScale: WIDGET_SWAY_AMP, blink: false },
    view: WIDGET_VIEW,
    warmupMaxCycles: 6,
  };
}

/** 帧数上限保护：>max 时隔帧取样并将 fps 减半，循环直到 ≤max。纯函数。 */
export function capFrames<T>(frames: T[], fps: number, max = 56): { frames: T[]; fps: number } {
  let out = frames;
  let f = fps;
  while (out.length > max) {
    out = out.filter((_, i) => i % 2 === 0);
    f = Math.max(1, Math.floor(f / 2));
  }
  return { frames: out, fps: f };
}
