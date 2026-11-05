import type { V2Profile } from './v2Types.ts';

type DiffField = 'kind' | 'emotion' | 'intensity' | 'hint' | 'slot' | 'triggerEnabled';

export interface ProfilePairDiff {
  /** shuangsheng 有但 shuangsheng-dj 没有的 id */
  missingInDj: string[];
  /** shuangsheng-dj 有但 shuangsheng 没有的 id */
  missingInBase: string[];
  /** 同 id 条目字段不一致 */
  fieldMismatch: Array<{
    id: string;
    field: DiffField;
    base: unknown;
    dj: unknown;
  }>;
}

const DIFF_FIELDS: DiffField[] = ['kind', 'emotion', 'intensity', 'hint', 'slot', 'triggerEnabled'];

interface Identifiable {
  id: string;
}

function diffChannelItems<T extends Identifiable>(
  baseItems: T[],
  djItems: T[],
  mismatches: ProfilePairDiff['fieldMismatch'],
): Pick<ProfilePairDiff, 'missingInDj' | 'missingInBase'> {
  const baseMap = new Map(baseItems.map((item) => [item.id, item]));
  const djMap = new Map(djItems.map((item) => [item.id, item]));

  const missingInDj = baseItems.filter((item) => !djMap.has(item.id)).map((item) => item.id);
  const missingInBase = djItems.filter((item) => !baseMap.has(item.id)).map((item) => item.id);

  for (const [id, baseItem] of baseMap) {
    const djItem = djMap.get(id);
    if (!djItem) continue;
    const baseRecord = baseItem as unknown as Record<string, unknown>;
    const djRecord = djItem as unknown as Record<string, unknown>;
    for (const field of DIFF_FIELDS) {
      const base = baseRecord[field];
      const dj = djRecord[field];
      if (base !== dj) {
        mismatches.push({ id, field, base, dj });
      }
    }
  }

  return { missingInDj, missingInBase };
}

/**
 * 比较 shuangsheng（base）与 shuangsheng-dj（dj）两个 v3 profile。
 * 仅返回差异结构，不抛错、不阻塞。
 */
export function diffShuangshengPair(base: V2Profile, dj: V2Profile): ProfilePairDiff {
  const fieldMismatch: ProfilePairDiff['fieldMismatch'] = [];
  const motionDiff = diffChannelItems(base.motion.items, dj.motion.items, fieldMismatch);
  const expressionDiff = diffChannelItems(base.expression.items, dj.expression.items, fieldMismatch);

  return {
    missingInDj: [...motionDiff.missingInDj, ...expressionDiff.missingInDj],
    missingInBase: [...motionDiff.missingInBase, ...expressionDiff.missingInBase],
    fieldMismatch,
  };
}
