import { describe, it, expect } from 'vitest';
import { diffShuangshengPair } from './shuangshengPairDiff';
import type { V2Profile } from './v2Types';

function buildProfile(overrides?: {
  motionHints?: Record<string, string>;
  removeMotionIds?: string[];
  expressionHints?: Record<string, string>;
}): V2Profile {
  const motionItems = [
    { id: 'idle', file: 'motions/idle.motion3.json', group: 'idle', loop: true, hint: '待机' },
    { id: 'dance', file: 'motions/dance.motion3.json', group: 'dance', loop: false, hint: '跳舞', keywords: ['跳舞'] },
  ].filter((item) => !overrides?.removeMotionIds?.includes(item.id));

  const expressionItems = [
    { id: 'aixin', file: 'aixin.exp3.json', category: 'prop' as const, hint: '爱心', keywords: ['爱心'] },
    { id: 'baisi', file: 'baisi.exp3.json', category: 'costume' as const, slot: 'legwear' as const, hint: '白丝' },
  ];

  return {
    role: 'shuangsheng',
    motion: {
      role: 'shuangsheng',
      kind: 'motion',
      version: 'v3',
      items: motionItems.map((item) => ({
        ...item,
        hint: overrides?.motionHints?.[item.id] ?? item.hint,
      })),
    },
    expression: {
      role: 'shuangsheng',
      kind: 'expression',
      version: 'v3',
      items: expressionItems.map((item) => ({
        ...item,
        hint: overrides?.expressionHints?.[item.id] ?? item.hint,
      })),
    },
  };
}

describe('diffShuangshengPair', () => {
  it('完全相同的两个 profile → diff 三项都是空', () => {
    const base = buildProfile();
    const dj = buildProfile();
    const diff = diffShuangshengPair(base, dj);
    expect(diff.missingInDj).toEqual([]);
    expect(diff.missingInBase).toEqual([]);
    expect(diff.fieldMismatch).toEqual([]);
  });

  it('单条 hint 不同 → fieldMismatch 有一项', () => {
    const base = buildProfile();
    const dj = buildProfile({ motionHints: { dance: '跳舞（dj 版）' } });
    const diff = diffShuangshengPair(base, dj);
    expect(diff.missingInDj).toEqual([]);
    expect(diff.missingInBase).toEqual([]);
    expect(diff.fieldMismatch).toEqual([
      { id: 'dance', field: 'hint', base: '跳舞', dj: '跳舞（dj 版）' },
    ]);
  });

  it('一支 id 在 dj 里缺 → missingInDj 有该 id', () => {
    const base = buildProfile();
    const dj = buildProfile({ removeMotionIds: ['dance'] });
    const diff = diffShuangshengPair(base, dj);
    expect(diff.missingInDj).toEqual(['dance']);
    expect(diff.missingInBase).toEqual([]);
    expect(diff.fieldMismatch).toEqual([]);
  });
});
