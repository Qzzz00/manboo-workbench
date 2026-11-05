/* 驱动求值（纯函数层）：把 profile.driver 解析成统一的 ResolvedDriver。
 *
 * 三种驱动统一成同一形状：evalParams(t)（afterMotionUpdate 写，物理之前吃到周期输入）
 * 与 evalEyes(t)（眼参数只认 beforeModelUpdate burst 位——库会在 afterMotionUpdate 后把眼
 * 恢复默认睁，吧唧 W3 与魔力卡 A1 两次踩实的硬知识）。全部驱动满足 f(t)≡f(t mod periodS)
 * 且逐分量 f(0)≡f(periodS)（数学闭环），物理收敛证书才有意义。
 */
import { evalMotionCurve, evalMotionParams, evalNaturalWobble, parseMotion3, type ParsedMotion3 } from '../../tools/badgeExport/motionCurves.ts';
import type { BakeDriverConfig } from './bakeProfiles.ts';

export type ResolvedDriver = {
  periodS: number;
  evalParams: (tSec: number) => Array<[string, number]>;
  evalEyes: (tSec: number) => Array<[string, number]>;
};

/* —— 吧唧 F2 sine 配方（真机验证冻结版，勿调）——
 * 来源：idleBadgeCurves.ts 的 F2 状态（魔力卡实验改动前的 git 基线）。周期 2.6s@10fps=26帧。
 * E13/F2 结论：翅膀刚性挂躯干不挂头 → 头角度=生气来源（可放大），躯干近零+breath 0.04=翅膀
 * 近静（去卡）。耳抽动=小面积事件点缀（错峰双耳）。眨眼 1 次/循环（2.6s≈真人静息眨眼率）。 */
const F2_PERIOD_S = 2.6;
const F2_SINES: Array<{ id: string; cycles: number; amp: number; offset: number; phase: number }> = [
  { id: 'ParamBreath', cycles: 1, amp: 0.04, offset: 0.5, phase: 0.75 },
  { id: 'ParamAngleX', cycles: 1, amp: 3.3, offset: 0, phase: 0.15 },
  { id: 'ParamAngleY', cycles: 1, amp: 2.3, offset: 0, phase: 0.55 },
  { id: 'ParamAngleZ', cycles: 1, amp: 2.6, offset: 0, phase: 0.35 },
  { id: 'ParamBodyAngleX', cycles: 1, amp: 0.3, offset: 0, phase: 0.25 },
  { id: 'ParamBodyAngleZ', cycles: 1, amp: 0.25, offset: 0, phase: 0.7 },
];
const F2_EVENTS: Array<{ id: string; t0: number; t1: number; amp: number }> = [
  { id: 'Param62', t0: 0.4, t1: 0.9, amp: 0.6 },   // 左耳 twitch（窗完全落在 (0,T) 内不跨缝）
  { id: 'Param63', t0: 1.3, t1: 1.8, amp: 0.6 },   // 右耳 twitch（错峰）
];
const F2_BLINK = { t0: 1.0, t1: 1.4 };             // 升余弦 1→0→1，窗外恒睁

function mod(t: number, T: number): number {
  const m = t % T;
  return m < 0 ? m + T : m;
}

export function sineBadgeF2Driver(): ResolvedDriver {
  const T = F2_PERIOD_S;
  return {
    periodS: T,
    evalParams: (tSec) => {
      const t = mod(tSec, T);
      const out: Array<[string, number]> = F2_SINES.map((c) => [
        c.id,
        c.offset + c.amp * Math.sin((2 * Math.PI * c.cycles * t) / T + 2 * Math.PI * c.phase),
      ]);
      for (const e of F2_EVENTS) {
        if (t <= e.t0 || t >= e.t1) { out.push([e.id, 0]); continue; }
        const u = (t - e.t0) / (e.t1 - e.t0);
        const env = 0.5 * (1 - Math.cos(2 * Math.PI * u));       // 升余弦包络（窗缘 C1 平滑）
        out.push([e.id, e.amp * env * Math.sin(2 * Math.PI * u)]); // 单圈来回抖
      }
      return out;
    },
    evalEyes: (tSec) => {
      const t = mod(tSec, T);
      let open = 1;
      if (t > F2_BLINK.t0 && t < F2_BLINK.t1) {
        const u = (t - F2_BLINK.t0) / (F2_BLINK.t1 - F2_BLINK.t0);
        open = 1 - 0.5 * (1 - Math.cos(2 * Math.PI * u));
      }
      return [['ParamEyeLOpen', open], ['ParamEyeROpen', open]];
    },
  };
}

/** motion+wobble 驱动（魔力卡 M10/M11 配方）：动作按自身时长循环求值（authored 闭合无内缝），
 * 自然摆动层按整窗（duration×loopMult）求值——两遍动作叠不同摆动相位，重复感被打散。 */
export function motionDriverFrom(motion: ParsedMotion3, wobble: boolean, loopMult: number, paramBand?: Record<string, { center: number; scale: number }>): ResolvedDriver {
  const T = motion.duration * Math.max(1, Math.round(loopMult));
  return {
    periodS: T,
    evalParams: (tSec) => {
      const t = mod(tSec, T);
      const values = new Map<string, number>();
      for (const [id, v] of evalMotionParams(motion, t % motion.duration)) {
        if (id === 'ParamEyeLOpen' || id === 'ParamEyeROpen') continue;   // 眼走 evalEyes
        values.set(id, v);
      }
      if (wobble) {
        for (const [id, dv] of evalNaturalWobble(t, T)) values.set(id, (values.get(id) ?? 0) + dv);
      }
      if (paramBand) {
        for (const [id, band] of Object.entries(paramBand)) {
          const v = values.get(id);
          if (v !== undefined) values.set(id, band.center + (v - band.center) * band.scale);
        }
      }
      return [...values.entries()];
    },
    evalEyes: (tSec) => {
      const t = mod(tSec, T) % motion.duration;
      return evalMotionParams(motion, t).filter(([id]) => id === 'ParamEyeLOpen' || id === 'ParamEyeROpen');
    },
  };
}

/** Tier B 摆动驱动：自然摆动层单独驱动 + 程序化眨眼（每 ~4s 一次，窗不跨缝）。
 * 呼吸以 0.5 为中位（摆动是加性偏移，独立驱动时需要基线让翅膀在中段起伏）。
 * 省预算参（spec 2026-07-10 预算内烘焙，fps/周期锁死后的唯二杠杆）：
 * - ampScale：所有摆动分量幅度 × 系数（呼吸只缩起伏不缩 0.5 基线）；
 * - localized：运动局部化——钉躯干（ParamBodyAngle*→0）与呼吸（0.5 恒定），保留头三轴
 *   与眨眼（F2 真机哲学「头=生气来源，躯干近零」；动的像素面积是 delta 预算大头）。 */
export function wobbleDriver(periodS: number, opts: { ampScale?: number; localized?: boolean; blink?: boolean } = {}): ResolvedDriver {
  const T = periodS;
  const amp = opts.ampScale ?? 1;
  const localized = opts.localized ?? false;
  const blinkCount = Math.max(1, Math.round(T / 4));
  const blinks = Array.from({ length: blinkCount }, (_, i) => {
    const center = ((i + 0.55) * T) / blinkCount;
    return { t0: center - 0.2, t1: center + 0.2 };
  });
  return {
    periodS: T,
    evalParams: (tSec) => {
      const t = mod(tSec, T);
      return evalNaturalWobble(t, T).map(([id, dv]) => {
        if (localized && id.startsWith('ParamBodyAngle')) return [id, 0] as [string, number];
        if (id === 'ParamBreath') return [id, 0.5 + (localized ? 0 : dv * amp)] as [string, number];
        return [id, dv * amp] as [string, number];
      });
    },
    evalEyes: (tSec) => {
      if (opts.blink === false) return [];   // 组件档：眨眼在低帧小卡上=突兀快照，整环禁写眼参
      const t = mod(tSec, T);
      let open = 1;
      for (const b of blinks) {
        if (t > b.t0 && t < b.t1) {
          const u = (t - b.t0) / (b.t1 - b.t0);
          open = 1 - 0.5 * (1 - Math.cos(2 * Math.PI * u));
          break;
        }
      }
      return [['ParamEyeLOpen', open], ['ParamEyeROpen', open]];
    },
  };
}

export type IdleMotionOption = { key: string; url: string; durationS: number };

/** 枚举该模型全部可用的 loop 闭合待机动作（面板「待机动作」下拉的数据源）。
 * 判定：motions 键含 idle/待机 → 拉文件解析 → 全曲线 |f(0)-f(T)|<1e-3 才算闭合可用。 */
export async function probeIdleMotions(
  manifest: { motions?: Record<string, { file: string }> },
): Promise<IdleMotionOption[]> {
  const candidates = Object.entries(manifest.motions ?? {}).filter(([key]) => /idle|待机/i.test(key));
  const out: IdleMotionOption[] = [];
  for (const [key, binding] of candidates) {
    if (!binding?.file) continue;
    try {
      const res = await fetch(binding.file);
      if (!res.ok) continue;
      const motion = parseMotion3(await res.json());
      const closed = motion.curves.every(
        (c) => Math.abs(evalMotionCurve(c.segments, 0) - evalMotionCurve(c.segments, motion.duration)) < 1e-3,
      );
      if (closed) out.push({ key, url: binding.file, durationS: motion.duration });
    } catch { /* 拉取/解析失败 → 跳过 */ }
  }
  return out;
}

/** 按角色探测吧唧驱动档（spec §2 驱动分层）：manifest.motions 里找 idle 键 → 拉文件验
 * loop 闭合（全曲线 |f(0)-f(T)|<1e-3）→ Tier A 动作驱动；否则 Tier B 摆动驱动（8s）。 */
export async function resolveBadgeDriverConfig(
  manifest: { motions?: Record<string, { file: string }> },
): Promise<BakeDriverConfig> {
  const idle = Object.entries(manifest.motions ?? {}).find(([key]) => /idle/i.test(key));
  if (idle?.[1]?.file) {
    try {
      const res = await fetch(idle[1].file);
      if (res.ok) {
        const motion = parseMotion3(await res.json());
        const closed = motion.curves.every(
          (c) => Math.abs(evalMotionCurve(c.segments, 0) - evalMotionCurve(c.segments, motion.duration)) < 1e-3,
        );
        if (closed) {
          return {
            kind: 'motion', url: idle[1].file, wobble: false, loopMult: 1,
            // 呼吸钉半开静态（scale 0）：①authored 全幅呼吸把翅膀 delta 撑爆预算（8.9MB）；
            // ②弱驱动（0.12 带）更糟——翅膀链准自由游走，接缝变彩票（残差 0.2~0.75 看第 60
            // 圈落哪，三烤两过一挂实测）。无强迫→链衰减到不动点=确定性收敛。F2 真机的
            // 0.04 幅度本≈静态，10fps 下胸口起伏不可见，观感无损。
            paramBand: { ParamBreath: { center: 0.5, scale: 0 } },
          };
        }
      }
    } catch { /* 拉取/解析失败 → Tier B */ }
  }
  return { kind: 'wobble', periodS: 8 };
}

/** 解析 profile.driver → ResolvedDriver（motion 走网络加载；fetchJson 可注入便于测试）。 */
export async function resolveDriver(
  config: BakeDriverConfig,
  fetchJson: (url: string) => Promise<unknown> = async (url) => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`动作文件加载失败 HTTP ${res.status}`);
    return res.json();
  },
): Promise<ResolvedDriver> {
  if (config.kind === 'sineBadgeF2') return sineBadgeF2Driver();
  if (config.kind === 'wobble') return wobbleDriver(config.periodS, { ampScale: config.ampScale, localized: config.localized, blink: config.blink });
  if (config.kind === 'motion') {
    const motion = parseMotion3(await fetchJson(config.url));
    return motionDriverFrom(motion, config.wobble, config.loopMult, config.paramBand);
  }
  return { periodS: config.periodS, evalParams: config.evalParams, evalEyes: config.evalEyes };
}
