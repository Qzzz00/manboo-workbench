/* 吧唧工坊·模型目录（UI 层，不碰 badgeBake 机制）：把「模型自己带什么」翻译成搭配区候选。
 *
 * Ben 2026-07-08 验收反馈驱动：动作/表情必须读模型本身的文件，不能只挑名字带 idle 的。
 *
 * - probeLoopMotions：枚举 manifest.motions ∪ model3 FileReferences.Motions 全部动作，
 *   Meta.Loop!==false 且全曲线闭合（f(0)≈f(T)）才上架——闭合是无缝循环的硬前提，
 *   一次性手势（Loop=false 或不闭合）诚实不出现。时长不落 10fps 网格（帧数非整）的
 *   闭合动作用「时间重映射」救回：周期取最近网格值，求值时把 [0,T'] 线性映回 [0,T]
 *   （双生实测 5.47s→5.5s 等 ≤0.6% 慢放，肉眼不可辨；闭合性精确保持）。
 * - buildMotionDriver：候选 → BakeDriverConfig。正网格走 kind:'motion'（机制自带
 *   paramBand 呼吸钉）；重映射走 kind:'custom' 逃生口（bakeProfiles 预留的调用方自带
 *   求值闭包），驱动语义与 motionDriverFrom 对齐：呼吸钉半开静态、眼参数走 evalEyes。
 * - resolveExpressionPins：把选中表情（exp3/preset）折算成绝对参数 pins。烘焙时 ticker
 *   停了，引擎的表情 overlay（每帧平滑写）不跑——表情必须转成 pins 走 beforeModelUpdate
 *   终审位才穿透烘焙。折算复刻引擎 buildMixedParameters 语义（weight=1）：Overwrite=值、
 *   Add=基线+值、Multiply=基线×值，基线=参数默认值（无默认用当前值）。
 */
import { evalMotionCurve, evalMotionParams, parseMotion3 } from '../tools/badgeExport/motionCurves.ts';
import type { AvatarExpression } from '../features/live2d/types.ts';
import type { BakeDriverConfig } from '../features/badgeBake/bakeProfiles.ts';

export type LoopMotionOption = {
  key: string;
  url: string;
  /** 动作原始时长（秒） */
  durationS: number;
  /** 吧唧 fps 网格化后的烘焙周期；与 durationS 不同即需要时间重映射 */
  gridPeriodS: number;
};

const defaultFetchJson = async (url: string): Promise<unknown> => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
};

type Model3Payload = {
  FileReferences?: { Motions?: Record<string, Array<{ File?: string }>> };
};

/** 枚举模型全部可无缝循环的动作（manifest 声明 ∪ model3 自带），闭合+可上网格才算数。 */
export async function probeLoopMotions(
  manifest: { modelJson?: string; motions?: Record<string, { file: string }> },
  fps: number,
  fetchJson: (url: string) => Promise<unknown> = defaultFetchJson,
): Promise<LoopMotionOption[]> {
  const sources = new Map<string, string>();   // url -> key
  for (const [key, binding] of Object.entries(manifest.motions ?? {})) {
    if (binding?.file) sources.set(binding.file, key);
  }
  // model3 FileReferences.Motions 兜底（如 Estella 的 Scene1）：路径相对 model3 所在目录
  if (manifest.modelJson) {
    try {
      const model3 = (await fetchJson(manifest.modelJson)) as Model3Payload;
      const dir = manifest.modelJson.replace(/[^/]*$/, '');
      for (const group of Object.values(model3.FileReferences?.Motions ?? {})) {
        for (const entry of group ?? []) {
          if (!entry?.File) continue;
          const url = dir + entry.File;
          if (![...sources.keys()].includes(url)) {
            sources.set(url, entry.File.replace(/^motions\//, '').replace(/\.motion3\.json$/, ''));
          }
        }
      }
    } catch { /* model3 拉取失败：只用 manifest 声明 */ }
  }

  const out: LoopMotionOption[] = [];
  for (const [url, key] of sources) {
    try {
      const raw = (await fetchJson(url)) as { Meta?: { Loop?: boolean } };
      if (raw?.Meta?.Loop === false) continue;   // 作者标注一次性动作：不上架
      const motion = parseMotion3(raw);
      const closed = motion.curves.every(
        (c) => Math.abs(evalMotionCurve(c.segments, 0) - evalMotionCurve(c.segments, motion.duration)) < 1e-3,
      );
      if (!closed) continue;
      const n = Math.round(motion.duration * fps);
      if (n < 2) continue;                       // 短于 2 帧没有循环意义
      const gridPeriodS = n / fps;
      // 重映射慢放/快放超 2% 会看出来：这类奇异时长诚实放弃
      if (Math.abs(gridPeriodS - motion.duration) / motion.duration > 0.02) continue;
      out.push({ key, url, durationS: motion.duration, gridPeriodS });
    } catch { /* 单个动作拉取/解析失败：跳过 */ }
  }
  return out;
}

/** 候选 → 烘焙驱动。网格吻合走机制自带的 motion 驱动；差网格走 custom 时间重映射。 */
export async function buildMotionDriver(
  option: LoopMotionOption,
  fetchJson: (url: string) => Promise<unknown> = defaultFetchJson,
): Promise<BakeDriverConfig> {
  const BREATH_BAND = { ParamBreath: { center: 0.5, scale: 0 } };   // 呼吸钉半开静态（机制层实证配方）
  if (Math.abs(option.gridPeriodS - option.durationS) < 1e-9) {
    return { kind: 'motion', url: option.url, wobble: false, loopMult: 1, paramBand: BREATH_BAND };
  }
  const motion = parseMotion3(await fetchJson(option.url));
  const T = option.gridPeriodS;
  const remap = (tSec: number) => {
    const m = tSec % T;
    return ((m < 0 ? m + T : m) / T) * motion.duration;   // [0,T') 线性映回 [0,duration)
  };
  return {
    kind: 'custom',
    periodS: T,
    evalParams: (tSec) => {
      const t = remap(tSec);
      const out: Array<[string, number]> = [];
      for (const [id, v] of evalMotionParams(motion, t)) {
        if (id === 'ParamEyeLOpen' || id === 'ParamEyeROpen') continue;   // 眼走 evalEyes
        out.push(id === 'ParamBreath'
          ? [id, BREATH_BAND.ParamBreath.center + (v - BREATH_BAND.ParamBreath.center) * BREATH_BAND.ParamBreath.scale]
          : [id, v]);
      }
      return out;
    },
    evalEyes: (tSec) => evalMotionParams(motion, remap(tSec))
      .filter(([id]) => id === 'ParamEyeLOpen' || id === 'ParamEyeROpen'),
  };
}

/** 动作观感化命名：已知 key 查表，未知按时长给气质名（重名由调用方加序号）。 */
export const MOTION_NAMES: Record<string, string> = {
  idle: '轻柔摇曳',
  idle2: '活泼灵动',
  idle3: '俏皮探身',
  shake: '轻轻摇头',
  shy: '害羞扭捏',
  greeting: '招手问好',
  happy: '开心雀跃',
  nod: '轻轻点头',
  panic: '慌张小剧场',
  surprised: '惊喜一跳',
  swing: '摇摇摆摆',
  cradle: '怀抱轻摇',
  giggle: '咯咯轻笑',
  sleepy: '昏昏欲睡',
  stretch: '伸个懒腰',
  think: '若有所思',
  look_around: '左顾右盼',
  ear_perk: '竖耳倾听',
  dance: '随节奏摇摆',
  scene1: '日常一幕',
};

/** 表情观感化命名：模型清单里的拼音/英文 id 翻成人话；没命中的用 manifest label 兜底。 */
export const EXPRESSION_NAMES: Record<string, string> = {
  neutral: '素颜',
  aixin: '爱心眼',
  baisi: '白丝',
  baowawa: '抱娃娃',
  changge: '拿麦唱歌',
  heilian: '黑脸',
  huanzhuang: '换装',
  jiyan: '眨眼卖萌',
  lianhong: '脸红',
  tousi: '透视',
  waitao: '披外套',
  yanlei: '含泪',
  yun: '晕乎乎',
};

// —— 表情 → 烘焙 pins ——

type ExpressionFilePayload = {
  Parameters?: Array<{ Id?: string; Value?: number; Blend?: string }>;
};

/** 把选中的表情折算成绝对参数 pins（顺序折叠：后选的覆盖先选的同参数）。
 * baseline=参数默认值表（面板从 getRuntimeParameterSnapshot 构建；注入便于测试）。 */
export async function resolveExpressionPins(
  baseline: ReadonlyMap<string, number>,
  expressions: AvatarExpression[],
  selectedIds: string[],
  fetchJson: (url: string) => Promise<unknown> = defaultFetchJson,
): Promise<Array<[string, number]>> {
  const byId = new Map(expressions.map((e) => [e.id, e]));
  const folded = new Map<string, number>();
  const base = (id: string) => folded.get(id) ?? baseline.get(id) ?? 0;
  for (const selId of selectedIds) {
    const expr = byId.get(selId);
    if (!expr) continue;
    if (expr.binding.mode === 'preset') {
      for (const [id, value] of Object.entries(expr.binding.params)) folded.set(id, value);
      continue;
    }
    try {
      // dev 下 url-import 的表情路径带 /public/ 前缀，直接 fetch 会拿到 SPA 兜底 HTML
      // （json 解析必炸）；剥前缀重试。prod 构建是 hashed 资产路径，首试即中。
      let payload: ExpressionFilePayload;
      try {
        payload = (await fetchJson(expr.binding.file)) as ExpressionFilePayload;
      } catch (err) {
        if (!/^\/public\//.test(expr.binding.file)) throw err;
        payload = (await fetchJson(expr.binding.file.replace(/^\/public/, ''))) as ExpressionFilePayload;
      }
      for (const p of payload.Parameters ?? []) {
        if (!p.Id || typeof p.Value !== 'number') continue;
        const blend = p.Blend ?? 'Add';
        if (blend === 'Overwrite') folded.set(p.Id, p.Value);
        else if (blend === 'Multiply') folded.set(p.Id, base(p.Id) * p.Value);
        else folded.set(p.Id, base(p.Id) + p.Value);   // Add（exp3 缺省）
      }
    } catch { /* 单个表情文件拉取失败：跳过该层 */ }
  }
  return [...folded.entries()];
}
