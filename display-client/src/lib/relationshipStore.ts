import { markLocalChanged } from './syncEngine.ts';

export type CharacterMeta = {
  favorability: number;
  lastChatTime: string;
  relationship: string;
};

const STORAGE_KEY = 'llm-live2d:relationships';


export function loadRelationships(): Record<string, CharacterMeta> {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
  } catch {
    return {};
  }
}

function getRelationshipLabel(favorability: number): string {
  if (favorability >= 80) return '挚友';
  if (favorability >= 50) return '密友';
  if (favorability >= 20) return '朋友';
  if (favorability >= 5) return '相识';
  return '初遇';
}

export function getCharacterMeta(avatarId: string): CharacterMeta {
  const all = loadRelationships();
  const existing = all[avatarId];
  if (existing) return existing;
  return { favorability: 0, lastChatTime: '', relationship: '初遇' };
}

export function addFavorability(avatarId: string, amount = 1): CharacterMeta {
  const all = loadRelationships();
  const current = all[avatarId] || { favorability: 0, lastChatTime: '', relationship: '初遇' };
  const favorability = current.favorability + amount;
  const meta: CharacterMeta = {
    favorability,
    lastChatTime: new Date().toLocaleString('zh-CN'),
    relationship: getRelationshipLabel(favorability),
  };
  all[avatarId] = meta;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  markLocalChanged('relationships');
  return meta;
}

export function getTotalFavorability(): number {
  const all = loadRelationships();
  return Object.values(all).reduce((sum, rel) => sum + (rel.favorability || 0), 0);
}
