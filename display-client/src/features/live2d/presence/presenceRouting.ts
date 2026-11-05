import type { UnifiedAction } from '../types.ts';

/**
 * 把一条统一动作（UnifiedAction）归到形象合成器的四层之一：
 *  - 'emotion'  ① 临时情绪
 *  - 'apparel'  ② 持久服饰/换装（穿戴类 costume）
 *  - 'morph'    ③ 持久形态（变小/变大/chibi/giant 等尺寸形态类 costume）
 *  - 'gesture'  ④ 一次性动作（motion / other）
 *
 * costume 需进一步区分穿戴 vs 形态：形态类（含尺寸/变身 token）→ morph；其余 → apparel。
 * 注意只看 UnifiedActionKind + 名称 token，不改 avatarManifest 的 kind 推断（那是 P3 的事）。
 */
export type PresenceLayerKind = 'emotion' | 'apparel' | 'morph' | 'gesture';

// 形态/尺寸变身 token（COSTUME_TOKENS 的子集）。整词或剥末尾数字后命中即判为 morph。
const MORPH_TOKENS = new Set([
  'smaller', 'bigger', 'small', 'tiny', 'giant', 'shrink', 'chibi', 'huge', 'grow',
]);

function tokenize(value: string): string[] {
  return value
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[\s_-]+/)
    .filter(Boolean);
}

function isMorphName(value: string): boolean {
  for (const token of tokenize(value)) {
    const base = token.replace(/\d+$/, '');
    if (MORPH_TOKENS.has(token) || MORPH_TOKENS.has(base)) return true;
  }
  return false;
}

export function classifyPresenceLayer(action: UnifiedAction): PresenceLayerKind {
  if (action.kind === 'emotion') return 'emotion';
  if (action.kind === 'costume') {
    if (isMorphName(action.id) || isMorphName(action.ref) || isMorphName(action.label)) {
      return 'morph';
    }
    return 'apparel';
  }
  // 'action' / 'other' → 一次性
  return 'gesture';
}
