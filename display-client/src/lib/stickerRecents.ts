import type { Sticker } from './stickerTypes.ts';

const RECENTS_KEY = 'aiboo:sticker-recents';
const MAX_RECENTS = 20;

type RecentSticker = {
  sticker: Sticker;
  usedAt: number;
};

function readRecents(): RecentSticker[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(RECENTS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return parsed as RecentSticker[];
  } catch {
    // 解析失败时清空，避免脏数据累积
    localStorage.removeItem(RECENTS_KEY);
  }
  return [];
}

function writeRecents(recents: RecentSticker[]) {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(RECENTS_KEY, JSON.stringify(recents));
  } catch {
    // localStorage 写满时静默失败
  }
}

/** 获取最近使用过的 sticker 列表（按最近使用时间倒序） */
export function getRecentStickers(): Sticker[] {
  return readRecents()
    .sort((a, b) => b.usedAt - a.usedAt)
    .map((entry) => entry.sticker);
}

/** 记录一次 sticker 使用 */
export function recordStickerUsed(sticker: Sticker) {
  const recents = readRecents();
  const withoutCurrent = recents.filter((entry) => entry.sticker.id !== sticker.id);
  withoutCurrent.unshift({ sticker, usedAt: Date.now() });
  writeRecents(withoutCurrent.slice(0, MAX_RECENTS));
}

/** 清空最近使用 */
export function clearRecentStickers() {
  writeRecents([]);
}
