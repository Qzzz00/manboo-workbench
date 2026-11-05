/* motion3.json 曲线求值器（烘焙用，绕开引擎动作管理器）。
 *
 * 为什么不用 motionManager 播 idle.motion3：管理器带 fadeIn/内部 loop 融合/wall-clock 相位，
 * 采集窗相对相位不可控（idleBadgeCurves.ts 头注列过五个干扰源）。这里把动作文件当**纯函数**
 * f(t) 用：解析曲线段，任意 t 直接求值——相位由烘焙侧的合成时间轴全权掌控，天然确定性。
 *
 * 用途（魔力卡待机烘焙）：模型自带的 idle.motion3 是 loop-authored（Loop:true、全曲线首尾
 * 值相等）——它就是"正统的首尾归位循环 idle"。以它为严格周期驱动输入喂物理，预热收敛后
 * 采集恰好一个周期 = authored 自然度 + 数学无缝，替代手搓正弦（频谱太糙，60fps 下甩头发）。
 *
 * 段格式（Cubism motion3 规范）：Curves[].Segments 扁平数组 = [t0, v0, (段型, ...点)*]，
 * 段型 0=线性(t,v) / 1=贝塞尔(c1t,c1v,c2t,c2v,t,v) / 2=阶跃(t,v) / 3=逆阶跃(t,v)。
 * 贝塞尔按官方 AreBeziersRestricted 路径求值：u = 时间线性占比，对 (t,v) 四点 de Casteljau
 * ——与运行时渲染完全同一语义（渲染才是烘焙的 ground truth）。
 */

export type MotionCurve = {
  target: string;
  id: string;
  segments: number[];
};

export type ParsedMotion3 = {
  duration: number;
  fps: number;
  loop: boolean;
  curves: MotionCurve[];
};

type Motion3Json = {
  Version?: number;
  Meta?: { Duration?: number; Fps?: number; Loop?: boolean };
  Curves?: Array<{ Target?: string; Id?: string; Segments?: number[] }>;
};

export function parseMotion3(json: unknown): ParsedMotion3 {
  const data = json as Motion3Json;
  const duration = data.Meta?.Duration;
  if (typeof duration !== 'number' || !(duration > 0)) throw new Error('motion3.json 缺 Meta.Duration');
  const curves: MotionCurve[] = [];
  for (const c of data.Curves ?? []) {
    if (!c.Id || !Array.isArray(c.Segments) || c.Segments.length < 2) continue;
    curves.push({ target: c.Target ?? 'Parameter', id: c.Id, segments: c.Segments });
  }
  if (!curves.length) throw new Error('motion3.json 无有效曲线');
  return { duration, fps: data.Meta?.Fps ?? 30, loop: data.Meta?.Loop ?? false, curves };
}

function lerp(a: number, b: number, u: number): number {
  return a + (b - a) * u;
}

/** 单条曲线在 t（秒，须在 [0, duration]）的值。段外（t 超末点）取末点值。 */
export function evalMotionCurve(segments: number[], t: number): number {
  let pt = segments[0];
  let pv = segments[1];
  if (t <= pt) return pv;
  let i = 2;
  while (i < segments.length) {
    const type = segments[i];
    if (type === 1) {
      // 贝塞尔：控制点2 + 终点1
      const c1v = segments[i + 2];   // 控制点时间分量在 restricted 求值中不参与（u=时间线性占比）
      const c2v = segments[i + 4];
      const nt = segments[i + 5]; const nv = segments[i + 6];
      if (t <= nt) {
        const u = nt === pt ? 0 : (t - pt) / (nt - pt);
        // de Casteljau on (t,v) 四点，取 value 分量（官方 restricted 路径）
        const v01 = lerp(pv, c1v, u);
        const v12 = lerp(c1v, c2v, u);
        const v23 = lerp(c2v, nv, u);
        return lerp(lerp(v01, v12, u), lerp(v12, v23, u), u);
      }
      pt = nt; pv = nv; i += 7;
    } else {
      const nt = segments[i + 1];
      const nv = segments[i + 2];
      if (t <= nt) {
        if (type === 2) return pv;                     // 阶跃：保持段首值
        if (type === 3) return nv;                     // 逆阶跃：立刻取段末值
        const u = nt === pt ? 0 : (t - pt) / (nt - pt); // 线性
        return lerp(pv, nv, u);
      }
      pt = nt; pv = nv; i += 3;
    }
  }
  return pv;
}

/** 全部 Parameter 曲线在 t 的值表（t 由调用方先 mod 到 [0, duration)）。 */
export function evalMotionParams(motion: ParsedMotion3, t: number): Array<[string, number]> {
  const out: Array<[string, number]> = [];
  for (const c of motion.curves) {
    if (c.target !== 'Parameter') continue;
    out.push([c.id, evalMotionCurve(c.segments, t)]);
  }
  return out;
}

/** 库「自然摆动层」的有理化重构。
 *
 * pixi-live2d-display 的 Cubism4InternalModel 默认挂一组 CubismBreath：
 * value += weight·(offset + peak·sin(2π·t/cycle))，五分量（AngleX 0/15/6.5345/0.5、
 * AngleY 0/8/3.5345/0.5、AngleZ 0/10/5.5345/0.5、BodyAngleX 0/4/15.5345/0.5、
 * Breath 0/0.5/3.2345/0.5）。预览里的「活气」大半来自它——AngleX ±7.5° 比 authored idle
 * 本身（±2.5°）还大。但周期全为无理数，与任何烘焙窗不通约=闭环必破，烘焙时被 patch 掉，
 * 观感随之变木（M8 vs 预览的差距实锤=这层）。
 *
 * 有理化：每分量周期凑成烘焙窗 T 的整数分频（k=round(T/cycle)≥1），幅度=peak×weight 原样。
 * T=16s（2×idle 时长）时周期误差 ≤9%：8.0/3.2/5.33/16.0/3.2 vs 6.53/3.53/5.53/15.53/3.23。
 * 观感等价，数学上 f(0)≡f(T) 精确闭环。相位取固定散列值——避免全部分量在接缝同时过零
 * （那等于接缝处一瞬回中性=死点，Tukey 包络的老毛病）。叠加方式与库一致：加在动作曲线值上。 */
const NATURAL_WOBBLE: Array<{ id: string; amp: number; cycle: number; phase: number }> = [
  { id: 'ParamAngleX', amp: 7.5, cycle: 6.5345, phase: 0.13 },
  { id: 'ParamAngleY', amp: 4, cycle: 3.5345, phase: 0.41 },
  { id: 'ParamAngleZ', amp: 5, cycle: 5.5345, phase: 0.67 },
  { id: 'ParamBodyAngleX', amp: 2, cycle: 15.5345, phase: 0.29 },
  { id: 'ParamBreath', amp: 0.25, cycle: 3.2345, phase: 0.83 },
];

/** 自然摆动层在 t 的加性偏移表（t、periodS 单位秒；调用方把返回值加在动作曲线值上）。 */
export function evalNaturalWobble(tSec: number, periodS: number): Array<[string, number]> {
  return NATURAL_WOBBLE.map((w) => {
    const k = Math.max(1, Math.round(periodS / w.cycle));
    const value = w.amp * Math.sin((2 * Math.PI * k * tSec) / periodS + 2 * Math.PI * w.phase);
    return [w.id, value] as [string, number];
  });
}

export type MotionCurveStat = {
  id: string;
  min: number;
  max: number;
  /** 首尾值差（loop 闭合度；authored loop 动作应≈0） */
  wrapGap: number;
  /** 峰值速度（单位/秒）与峰值加速度（单位/秒²）：驱动物理的"猛烈程度"，
   * 甩头发的直接物理量是加速度（欠阻尼摆链吃的是支点加速度）。 */
  maxVel: number;
  maxAcc: number;
};

/** 逐曲线统计（hz 采样数值微分）。用于对比 authored idle 与手搓正弦的激励猛烈度。 */
export function motionCurveStats(motion: ParsedMotion3, hz = 120): MotionCurveStat[] {
  const dt = 1 / hz;
  const steps = Math.max(2, Math.round(motion.duration * hz));
  return motion.curves
    .filter((c) => c.target === 'Parameter')
    .map((c) => {
      let min = Number.POSITIVE_INFINITY;
      let max = Number.NEGATIVE_INFINITY;
      let maxVel = 0;
      let maxAcc = 0;
      let prev = evalMotionCurve(c.segments, 0);
      let prevVel = 0;
      for (let s = 1; s <= steps; s += 1) {
        const t = Math.min(motion.duration, s * dt);
        const v = evalMotionCurve(c.segments, t);
        const vel = (v - prev) / dt;
        const acc = (vel - prevVel) / dt;
        if (v < min) min = v;
        if (v > max) max = v;
        if (Math.abs(vel) > maxVel) maxVel = Math.abs(vel);
        if (s > 1 && Math.abs(acc) > maxAcc) maxAcc = Math.abs(acc);
        prev = v;
        prevVel = vel;
      }
      const first = evalMotionCurve(c.segments, 0);
      const last = evalMotionCurve(c.segments, motion.duration);
      return { id: c.id, min: Math.min(min, first), max: Math.max(max, first), wrapGap: Math.abs(last - first), maxVel, maxAcc };
    });
}
