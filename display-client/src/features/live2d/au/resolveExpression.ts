// resolver：把 solver 输出的 SelectedExpression 转成 ① 情绪层（合成器）入口所需的
// { expressionMix, parameterOverrides }。
//
//  - native_triggers（nativeRef = exp3 文件名）→ expressionMix:[{key,weight}]
//    key 取法对齐 avatarManifest 的 expression key 约定：去掉路径 + 去掉 .exp3.json，
//    再走 toExpressionId（小写、空格/连字符→下划线、非字母数字→下划线、去首尾下划线）。
//  - semantic_targets（action+value）→ 经该角色 semanticBindings[action].paramId
//    映射成 parameterOverrides:[{id:paramId, value}]；没绑定的 action 跳过。

import type { ExpressionLayer, ParameterOverride } from '../types.ts';
import type { AUProfile, SelectedExpression } from './types';

/**
 * 把 exp3 nativeRef 归一成 avatarManifest 的 expression key。
 * 与 avatarManifest.ts 的 normalizeExpressionFileName + toExpressionId 等价，
 * 但去掉了路径前缀（au-profile 里 rattan 的 nativeRef 形如 'exp/1.exp3.json'）。
 */
export function nativeRefToExpressionKey(nativeRef: string): string {
  const s = String(nativeRef);
  const slash = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  const base = slash >= 0 ? s.slice(slash + 1) : s;
  const noExt = base.replace(/\.exp3\.json$/i, '').trim();
  const normalized = noExt
    .toLowerCase()
    .replace(/[\s-]+/g, '_')
    .replace(/[^\p{L}\p{N}_]+/gu, '_')
    .replace(/^_+|_+$/g, '');
  return normalized || 'expression';
}

export interface ResolvedEmotionLayer {
  expressionMix: ExpressionLayer[];
  parameterOverrides: ParameterOverride[];
}

/**
 * SelectedExpression → ① 情绪层入口。
 * @param selected solver 输出
 * @param profile  该角色的 AUProfile（提供 semanticBindings）
 */
export function resolveExpression(
  selected: SelectedExpression,
  profile: AUProfile,
): ResolvedEmotionLayer {
  // native triggers → expressionMix（去重，权重 1）。
  const seenKeys = new Set<string>();
  const expressionMix: ExpressionLayer[] = [];
  for (const trigger of selected.nativeTriggers) {
    const key = nativeRefToExpressionKey(trigger.nativeRef);
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    expressionMix.push({ key, weight: 1 });
  }

  // semantic targets → parameterOverrides（按 paramId 去重，后者覆盖前者）。
  const byParam = new Map<string, number>();
  for (const target of selected.semanticTargets) {
    const binding = profile.semanticBindings?.[target.action];
    if (!binding?.paramId) continue; // 该角色没绑定这个 action → 跳过
    byParam.set(binding.paramId, target.value);
  }
  const parameterOverrides: ParameterOverride[] = [...byParam.entries()].map(([id, value]) => ({
    id,
    value,
  }));

  return { expressionMix, parameterOverrides };
}
