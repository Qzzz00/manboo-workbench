/**
 * 哼唱演出帧——纯函数，从 useSinging.ts 的 onFrame 回调里提出来的两块逻辑：
 *  1) beatPhase → parameterOverrides 的构造（swayOverridesFor）。
 *  2) 演出帧节流判定（shouldEmitSwayFrame）。
 *
 * ★生死线：swayOverridesFor 绝不能输出 ParamMouthOpenY（或任何嘴部开合参数）——
 *   哼鸣是闭口鼻音，嘴不该动。这条原来只由 useSinging.ts 里一行注释守着，
 *   现在提成纯函数，能直接钉成 vitest 回归测试（humSway.test.ts）。
 *
 * 节流的原因：onFrame 由 humVoice.ts 的 rAF tick 驱动，不节流的话每帧都会
 *  setState → App 全量重渲染 → Live2DStage 的 [avatar, parameterOverrides, nativeActive]
 *  effect 每帧重跑 → 原生路径每次 flattenExpressionState + 过 Capacitor 桥，
 *  没有任何节流（对照 nativeStage.ts 的口型 66ms / 朝向 100ms 节流，这条是唯一的漏网之鱼）。
 *  而且高频换不来观感：引擎对 ParamAngle 系列/ParamBodyAngle 系列参数用 factor=0.14 的
 *  easeTowards 一阶平滑，按拍频（本曲库 84–104bpm，约 1.4–1.7Hz）算幅频响应，
 *  60fps 下 |H|≈0.69，12fps 低端机上只剩 |H|≈0.19——低端机付出最大代价、拿到最小效果。
 *  16Hz 节流之后波形形状不丢（每拍仍有 ~9–12 个采样点），且量级对齐既有节流惯例。
 */
import type { ParameterOverride } from '../live2d/types.ts';
import { isMouthParam } from '../live2d/mouthParams.ts';

/** 摇摆幅度（Live2D 参数单位，ParamAngleZ 满量程 ±30）。 */
export const SWAY_HEAD_DEG = 5;
export const SWAY_BODY_DEG = 3;
/** 哼歌时的嘴角上扬（ParamMouthForm 满量程 -1..1）。 */
export const SMILE_FORM = 0.3;

/** 演出帧节流间隔（秒）——16Hz，落在 15–20Hz 区间内，量级对齐 nativeStage 的 66ms 口型节流。 */
export const SWAY_FRAME_MIN_INTERVAL_SEC = 1 / 16;

/**
 * 由拍内相位构造本帧的演出参数：头/身随拍轻摇 + 嘴角上扬。
 * ★不写任何嘴部开合参数（ParamMouthOpenY 等）——哼鸣期间嘴必须保持不动。
 */
export function swayOverridesFor(beatPhase: number): ParameterOverride[] {
  const wave = Math.sin(beatPhase * Math.PI * 2);
  return [
    { id: 'ParamAngleZ', value: wave * SWAY_HEAD_DEG },
    { id: 'ParamBodyAngleZ', value: wave * SWAY_BODY_DEG },
    { id: 'ParamMouthForm', value: SMILE_FORM },
  ];
}

/**
 * 演出帧节流判定：距上次发送是否已达最小间隔。
 * lastEmitSec=null 表示还没发过第一帧，此时总是放行。
 * 时间单位与 humVoice.ts 的 HumFrame.elapsedSec 一致（秒，音频时钟驱动，
 * 不受 setTimeout/rAF 抖动影响，比 Date.now() 更适合做节流判定的输入）。
 */
export function shouldEmitSwayFrame(
  lastEmitSec: number | null,
  nowSec: number,
  minIntervalSec: number = SWAY_FRAME_MIN_INTERVAL_SEC,
): boolean {
  if (lastEmitSec === null) return true;
  return nowSec - lastEmitSec >= minIntervalSec;
}

/**
 * 合并「常规 parameterOverrides」与「哼唱摇摆」，再按口型同步状态做最终裁剪。
 * 从 App.tsx 的 stageParameterOverrides memo 里提出来——它是本分支唯一一处
 * 「能算的东西没落在可测纯函数里」的破例，而这条不变式在实施过程中真断过一次。
 *
 * 三条不变式，humSway.test.ts 逐条钉死：
 *  1) ★生死线延长段：mouthSyncActive 时输出**零个**嘴部参数（T4B）。裁剪必须在合并
 *     **之后**对最终结果做一次——sway 里的 ParamMouthForm 本身就是 isMouthParam，
 *     若只筛 base 再 append sway，等于把刚筛掉的嘴部参数原样带回来。
 *  2) 同名去重由本函数显式完成（sway 胜出），不依赖引擎的写入顺序语义。
 *  3) ★「没在哼且没在同步口型」这条快路必须原样返回 base 的**同一个数组引用**——
 *     Live2DStage 的 [avatar, parameterOverrides, nativeActive] effect 按引用相等
 *     判定是否重跑（Live2DStage.tsx:401），返回新数组会让原生桥每次渲染都重推一遍。
 */
export function mergeStageOverrides(
  base: ParameterOverride[],
  sway: ParameterOverride[],
  mouthSyncActive: boolean,
): ParameterOverride[] {
  let merged = base;
  if (sway.length > 0) {
    const swayIds = new Set(sway.map((o) => o.id));
    merged = [...merged.filter((po) => !swayIds.has(po.id)), ...sway];
  }
  return mouthSyncActive ? merged.filter((po) => !isMouthParam(po.id)) : merged;
}
