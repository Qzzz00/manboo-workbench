/**
 * 语气 → 那张脸(2026-10-02,卡「声音与形象跟着话走」第 4 件)。
 *
 * ## 为什么要它
 *
 * 查实(docs/设计-活人感标准与前端差距-2026-10-02 第三节):手机的 Live2D 有表情清单,
 * 但**通话里没有任何东西驱动表情** —— 她说什么、它都是一张脸,只有嘴在动。
 * 而工人从这一版起会在每条字幕上带一格 `tone`(短列表的主人是
 * channel-worker/src/tts/tone.ts),那一格正是「这一句该是什么脸」。
 *
 * ## 为什么是 expression 不是 action
 *
 * `live2dEngine.playAction` 走的是 `avatar.actions`,而**手机这一侧的清单里没有 actions**
 * (bundleLoader.manifestFromBundle 只从 model3.json 的 `FileReferences.Expressions`
 * 造出 `expressions`)。拿 playAction 去放一个找不到的 id,它会**清掉情绪回到中性** ——
 * 看上去「有时候会变脸、有时候不会」,最难查的那一类。所以这里只认 expression,
 * 应用走 `applyExpressionMix`。
 *
 * ## 两条纪律
 *
 *   ① **映射放配置**(toneExpressions.json),不写死。形象包里的表情名是美术起的 ——
 *      `happy` / `exp_happy` / `微笑` 都见过,所以配置里给的是**一串候选名**。
 *   ② **没有对应就不动**。一个候选都没命中 → 回 `undefined`,调用方一个参数都不写。
 *      随便挑一张「最像的」表情比不动更糟:那是她脸上出现一个与话无关的神情。
 *
 * 纯函数:不认识 DOM、不认识 live2dEngine 的运行时。
 */
import table from './toneExpressions.json' with { type: 'json' };
import type { AvatarManifest } from './types.ts';

interface ToneExpressionTable {
  hold_ms?: number;
  neutral?: string[];
  tones?: Record<string, string[]>;
}

const TABLE = table as unknown as ToneExpressionTable;

/**
 * 一个语气的表情停多久,到点回中性(「说完回中性」那一条)。
 * 与 live2dEngine 的 `DEFAULT_EMOTION_HOLD_MS` 同一个数量级 —— 一句话大致就这么长。
 */
export const TONE_HOLD_MS: number = typeof TABLE.hold_ms === 'number' && TABLE.hold_ms > 0 ? TABLE.hold_ms : 3200;

/** 这张表认得哪几个语气(给用例与诊断看)。 */
export function knownToneKeys(): string[] {
  return Object.keys(TABLE.tones ?? {}).sort();
}

/**
 * 一串候选名 → 形象清单里真的有的那个 expression id。
 * 先逐字比(不计大小写),再看 id 里含不含这个名。都不中回 undefined。
 */
function matchExpression(avatar: AvatarManifest, candidates: readonly string[]): string | undefined {
  const ids = avatar.expressions.map((item) => item.id).filter((id) => typeof id === 'string' && id !== '');
  for (const candidate of candidates) {
    const want = candidate.trim().toLowerCase();
    if (want === '') continue;
    const exact = ids.find((id) => id.toLowerCase() === want);
    if (exact !== undefined) return exact;
  }
  for (const candidate of candidates) {
    const want = candidate.trim().toLowerCase();
    if (want === '') continue;
    const loose = ids.find((id) => id.toLowerCase().includes(want));
    if (loose !== undefined) return loose;
  }
  return undefined;
}

/**
 * 这个语气在这个形象上是哪张表情。**没有对应就 undefined(脸不动)**。
 */
export function resolveToneExpression(avatar: AvatarManifest, tone: string | undefined): string | undefined {
  if (typeof tone !== 'string') return undefined;
  const key = tone.trim().toLowerCase();
  if (key === '') return undefined;
  const candidates = (TABLE.tones ?? {})[key];
  if (!Array.isArray(candidates) || candidates.length === 0) return undefined;
  return matchExpression(avatar, candidates);
}

/**
 * 回中性时用哪张表情。形象里压根没有中性那一张 → undefined
 * (调用方据此把情绪层清空就好,不去点一张不存在的表情)。
 */
export function resolveNeutralExpression(avatar: AvatarManifest): string | undefined {
  const candidates = TABLE.neutral ?? [];
  return matchExpression(avatar, candidates);
}
