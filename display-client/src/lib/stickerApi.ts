import { apiGet } from './apiClient.ts';
import { API_STICKERS } from './apiConfig.ts';
import type { Sticker, StickerCacheEntry } from './stickerTypes.ts';

const CACHE_KEY = 'aiboo:sticker-cache';
const CACHE_TTL_MS = 1000 * 60 * 60; // 1 小时

const MOCK_STICKERS: Sticker[] = [
  { id: 'mock-1', name: '开心', url: '/stickers/mock-1.png', sticker_type: 'daily' },
  { id: 'mock-2', name: '难过', url: '/stickers/mock-2.png', sticker_type: 'daily' },
  { id: 'mock-3', name: '生气', url: '/stickers/mock-3.png', sticker_type: 'daily' },
  { id: 'mock-4', name: '惊讶', url: '/stickers/mock-4.png', sticker_type: 'daily' },
  { id: 'mock-5', name: '爱心', url: '/stickers/mock-5.png', sticker_type: 'daily' },
  { id: 'mock-6', name: '晚安', url: '/stickers/mock-6.png', sticker_type: 'daily' },
  { id: 'mock-7', name: '早安', url: '/stickers/mock-7.png', sticker_type: 'daily' },
  { id: 'mock-8', name: '谢谢', url: '/stickers/mock-8.png', sticker_type: 'daily' },
  { id: 'mock-9', name: '加油', url: '/stickers/mock-9.png', sticker_type: 'meme' },
  { id: 'mock-10', name: '摸鱼', url: '/stickers/mock-10.png', sticker_type: 'meme' },
  { id: 'mock-11', name: '干饭', url: '/stickers/mock-11.png', sticker_type: 'meme' },
  { id: 'mock-12', name: '社死', url: '/stickers/mock-12.png', sticker_type: 'meme' },
];

const LOCAL_LABELS_URL = '/stickers/labels.json';
const CDN_FALLBACK_HOST = 'https://cdn.aiboo.app';

/**
 * 把后端/CDN 的 sticker URL 归一化为应用内可加载的相对路径。
 * - 不可达的 cdn.aiboo.app 地址会被映射到本地打包的 /stickers/...
 * - 后端 /uploads/stickers/... 也映射到 /stickers/...
 */
export function resolveStickerUrl(url: string): string {
  if (!url) return url;

  if (url.startsWith(`${CDN_FALLBACK_HOST}/stickers/`)) {
    return url.slice(CDN_FALLBACK_HOST.length);
  }
  if (url.startsWith('/uploads/stickers/')) {
    return `/stickers/${url.slice('/uploads/stickers/'.length)}`;
  }
  if (url.startsWith('http://') || url.startsWith('https://')) {
    return url;
  }
  if (url.startsWith('/stickers/')) {
    return url;
  }
  if (url.startsWith('stickers/')) {
    return `/${url}`;
  }
  return url;
}

type LocalStickerLabel = {
  sticker_id: string;
  filename: string;
  cdn_url: string;
  sticker_type: 'daily' | 'meme';
  emotion_tags: string[];
  meme_tags: string[];
  scene_tags: string[];
  meme_explanation: string | null;
  source_note?: string;
};

/** 从打包在本地的 /stickers/labels.json 加载兜底表情包列表。 */
async function fetchLocalStickers(): Promise<Sticker[]> {
  const res = await fetch(LOCAL_LABELS_URL, { method: 'GET' });
  if (!res.ok) {
    throw new Error(`local labels fetch failed: ${res.status}`);
  }
  const labels = (await res.json()) as LocalStickerLabel[];
  return labels.map((label) => {
    const url = `/stickers/${label.sticker_type}/${label.filename}`;
    return {
      id: label.sticker_id,
      name: label.source_note || label.sticker_id,
      url,
      thumb_url: url,
      sticker_type: label.sticker_type,
      active: true,
    };
  });
}

function readCache(): StickerCacheEntry | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as StickerCacheEntry;
  } catch {
    localStorage.removeItem(CACHE_KEY);
    return null;
  }
}

function writeCache(stickers: Sticker[]) {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ stickers, fetchedAt: Date.now() }));
  } catch {
    // localStorage 写满时静默失败
  }
}

function isCacheValid(entry: StickerCacheEntry | null): entry is StickerCacheEntry {
  if (!entry) return false;
  return Date.now() - entry.fetchedAt < CACHE_TTL_MS && Array.isArray(entry.stickers);
}

export type FetchStickersOptions = {
  /** 强制跳过缓存重新拉取 */
  force?: boolean;
  /** 失败时是否返回 mock 数据（默认 true） */
  fallbackToMock?: boolean;
};

export type FetchStickersResult = {
  stickers: Sticker[];
  /** 数据来源 */
  source: 'network' | 'cache' | 'local' | 'mock';
  /** 网络请求是否失败（即使 fallbackToMock 返回了数据） */
  networkError?: Error;
};

/**
 * 拉取 sticker 列表。
 * 优先读本地缓存；缓存过期或 force=true 时调后端；后端失败可回落到 mock 数据。
 */
export async function fetchStickers(options: FetchStickersOptions = {}): Promise<FetchStickersResult> {
  const { force = false, fallbackToMock = true } = options;

  const cached = readCache();
  if (!force && isCacheValid(cached)) {
    return { stickers: cached.stickers, source: 'cache' };
  }

  let networkError: Error | undefined;

  try {
    const data = await apiGet(`${API_STICKERS}?active=true`) as { stickers?: Sticker[] };
    const stickers = Array.isArray(data?.stickers) ? data.stickers : [];
    if (stickers.length > 0) {
      const resolved = stickers.map((s) => ({ ...s, url: resolveStickerUrl(s.url), thumb_url: resolveStickerUrl(s.thumb_url || s.url) }));
      writeCache(resolved);
      return { stickers: resolved, source: 'network' };
    }
  } catch (error) {
    networkError = error instanceof Error ? error : new Error(String(error));

    if (!force && isCacheValid(cached)) {
      return { stickers: cached.stickers, source: 'cache', networkError };
    }
  }

  try {
    const local = await fetchLocalStickers();
    if (local.length > 0) {
      return { stickers: local, source: 'local', networkError };
    }
  } catch (error) {
    networkError = networkError || (error instanceof Error ? error : new Error(String(error)));
  }

  if (fallbackToMock) {
    return { stickers: MOCK_STICKERS, source: 'mock', networkError };
  }

  throw networkError || new Error('Failed to load stickers');
}

/** 主动把 sticker 列表写入缓存 */
export function cacheStickers(stickers: Sticker[]) {
  writeCache(stickers);
}
