import { describe, it, expect } from 'vitest';
import { expressionMixForEmotion } from './emotionExpression.ts';
// 仓库不带模型(10-21),内置表是空的:拿当年那份清单当输入。
import { TEST_AVATARS as avatars } from './testAvatars.ts';
import type { AvatarManifest } from './types.ts';

const stub = (over: Partial<AvatarManifest>): AvatarManifest => ({
  ...avatars.ghostpuppy,
  ...over,
}) as AvatarManifest;

describe('expressionMixForEmotion', () => {
  it('按角色的 emotionExpressions 表把情绪映射成单层 expressionMix', () => {
    expect(expressionMixForEmotion(avatars.ghostpuppy, 'angry')).toEqual([
      { key: 'grumpy', weight: 1 },
    ]);
    expect(expressionMixForEmotion(avatars.ghostpuppy, 'excited')).toEqual([
      { key: 'excited_full', weight: 1 },
    ]);
  });

  it('没配表的角色返回空数组（绝不凭空造表情）', () => {
    expect(expressionMixForEmotion(avatars.hijiki, 'happy')).toEqual([]);
    expect(expressionMixForEmotion(avatars.ghostie, 'sad')).toEqual([]);
  });

  it('neutral 走角色的中立表情（回中而不是保持上一个情绪）', () => {
    expect(expressionMixForEmotion(avatars.ghostpuppy, 'neutral')).toEqual([
      { key: 'neutral', weight: 1 },
    ]);
  });

  it('表里点名了但角色实际没有这个 exp3 → 空（脏配置不下发）', () => {
    const dirty = stub({ emotionExpressions: { happy: 'not_a_real_expression' } });
    expect(expressionMixForEmotion(dirty, 'happy')).toEqual([]);
  });

  it('表里没覆盖到的情绪 → 空（保持当前表情，不乱动）', () => {
    const partial = stub({ emotionExpressions: { happy: 'brows_up' } });
    expect(expressionMixForEmotion(partial, 'shy')).toEqual([]);
  });

  it('ghostpuppy 表里的每个表情 id 都真实存在于清单里', () => {
    const ids = avatars.ghostpuppy.expressions.map((e) => e.id);
    for (const [emotion, id] of Object.entries(avatars.ghostpuppy.emotionExpressions ?? {})) {
      expect(ids, `${emotion} → ${id}`).toContain(id);
    }
  });
});
