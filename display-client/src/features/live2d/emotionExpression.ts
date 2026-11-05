// 情绪 → 表情（exp3）直连回落。
//
// 为什么需要它：表情正常走 AU solver（按角色目录下的 au-profile.json 解算出 expressionMix），
// 但电台那三只 DJ 都没有 profile → solver 恒出空，而通话/电台的 performCallUtterance
// 本来就传 expressionMix:[]，于是 exp3 挂在清单里从来没人触发（幽灵狗 8 个表情全是摆设）。
// 这里给「没 profile 的角色」补一条最朴素的路：判出情绪就点名一个 exp3 下发。
//
// 边界（都在 emotionExpression.test.ts 里钉住）：
//  - 角色没声明 emotionExpressions → 返回 []，上层保持当前表情不动（宁可不动不要乱动）；
//  - 表里点名的 id 不在该角色 expressions 里 → 也返回 []（脏配置不下发，避免引擎去 fetch 不存在的文件）；
//  - neutral 走角色自己的中立表情 id，语义是「回中」，与「拿不准所以不动」区分开。

import type { Emotion } from '../../lib/emotion.ts';
import type { AvatarManifest, ExpressionLayer } from './types.ts';
import { hasAvatarExpression, getAvatarNeutralExpressionId } from './avatarManifest.ts';

export function expressionMixForEmotion(
  avatar: AvatarManifest,
  emotion: Emotion,
): ExpressionLayer[] {
  const table = avatar.emotionExpressions;
  if (!table) return [];

  const key = emotion === 'neutral'
    ? (table.neutral ?? getAvatarNeutralExpressionId(avatar))
    : table[emotion];
  if (!key || !hasAvatarExpression(avatar, key)) return [];

  // 单层、权重 1：exp3 是 Blend=Add 的开关型（眉/耳/舌/腮），按强度打折只会让表情"没做完"，
  // 情绪强度改由动作（findEmotionMotion）体现，不在这里掺。
  return [{ key, weight: 1 }];
}
