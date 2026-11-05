/**
 * Sticker image cache — client-side persistent storage for sticker images.
 *
 * - Mobile (Capacitor): uses @capacitor/filesystem via mediaSandbox store
 * - Web: uses IndexedDB via mediaSandbox store
 *
 * Stickers are keyed by sticker ID. LRU eviction keeps memory/disk bounded:
 *   - max 50 entries
 *   - max ~20 MB total
 *
 * Consumers should load the blob, create an object URL, display it, and revoke
 * the object URL when unmounting. The cache owns the persistent copy.
 */

import {
  getDefaultMediaStore,
  type MediaFileStore,
} from './mediaSandbox.ts';

const STICKER_DIR = 'media/stickers';
const INDEX_KEY = `${STICKER_DIR}/__index__`;
const MAX_ENTRIES = 50;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
const DEFAULT_MIME_TYPE = 'image/png';

type StickerIndexEntry = {
  id: string;
  size: number;
  accessedAt: number;
  mimeType?: string;
};

type StickerIndex = {
  entries: StickerIndexEntry[];
};

function stickerPath(id: string): string {
  return `${STICKER_DIR}/${id}`;
}

async function readIndex(store: MediaFileStore): Promise<StickerIndex> {
  try {
    const data = await store.readBinary(INDEX_KEY);
    if (!data) return { entries: [] };
    const text = new TextDecoder().decode(data);
    const parsed = JSON.parse(text) as StickerIndex;
    if (parsed && Array.isArray(parsed.entries)) return parsed;
  } catch (error) {
    console.warn('[stickerCache] failed to read index', error);
  }
  return { entries: [] };
}

async function writeIndex(store: MediaFileStore, index: StickerIndex): Promise<void> {
  const text = JSON.stringify(index);
  const data = new TextEncoder().encode(text);
  await store.writeBinary(INDEX_KEY, data);
}

function touchEntry(index: StickerIndex, id: string, size?: number, mimeType?: string): void {
  const now = Date.now();
  const existing = index.entries.find((entry) => entry.id === id);
  if (existing) {
    existing.accessedAt = now;
    if (typeof size === 'number') existing.size = size;
    if (mimeType) existing.mimeType = mimeType;
  } else if (typeof size === 'number') {
    index.entries.push({ id, size, accessedAt: now, mimeType });
  }
}

async function evictIfNeeded(store: MediaFileStore, index: StickerIndex): Promise<void> {
  // Sort oldest first for eviction.
  index.entries.sort((a, b) => a.accessedAt - b.accessedAt);

  while (
    index.entries.length > 0 &&
    (index.entries.length > MAX_ENTRIES ||
      index.entries.reduce((sum, entry) => sum + entry.size, 0) > MAX_TOTAL_BYTES)
  ) {
    const oldest = index.entries.shift();
    if (!oldest) break;
    try {
      await store.delete(stickerPath(oldest.id));
    } catch (error) {
      console.warn('[stickerCache] eviction failed', oldest.id, error);
    }
  }
}

export async function loadStickerBlob(
  id: string,
  store: MediaFileStore = getDefaultMediaStore(),
): Promise<Blob | null> {
  if (!id) return null;

  const data = await store.readBinary(stickerPath(id));
  if (!data) return null;

  const index = await readIndex(store);
  const entry = index.entries.find((e) => e.id === id);
  touchEntry(index, id);
  await writeIndex(store, index);

  return new Blob([data], { type: entry?.mimeType || DEFAULT_MIME_TYPE });
}

export async function saveStickerBlob(
  id: string,
  blob: Blob,
  store: MediaFileStore = getDefaultMediaStore(),
): Promise<void> {
  if (!id) return;

  const arrayBuffer = await blob.arrayBuffer();
  await store.writeBinary(stickerPath(id), new Uint8Array(arrayBuffer));

  const index = await readIndex(store);
  touchEntry(index, id, blob.size, blob.type || DEFAULT_MIME_TYPE);
  await evictIfNeeded(store, index);
  await writeIndex(store, index);
}

/**
 * Fetch a sticker from the network and cache it. Returns the blob.
 * If the network request fails, returns null instead of throwing so that the
 * UI can fall back to a placeholder or the raw remote URL.
 */
export async function fetchAndCacheSticker(
  id: string,
  url: string,
  store: MediaFileStore = getDefaultMediaStore(),
): Promise<Blob | null> {
  if (!id || !url) return null;

  const cached = await loadStickerBlob(id, store);
  if (cached) return cached;

  try {
    const response = await fetch(url, { method: 'GET' });
    if (!response.ok) {
      console.warn('[stickerCache] fetch failed', url, response.status);
      return null;
    }
    const blob = await response.blob();
    await saveStickerBlob(id, blob, store);
    return blob;
  } catch (error) {
    console.warn('[stickerCache] fetch error', url, error);
    return null;
  }
}

export async function hasStickerBlob(
  id: string,
  store: MediaFileStore = getDefaultMediaStore(),
): Promise<boolean> {
  if (!id) return false;
  return store.exists(stickerPath(id));
}

export async function clearStickerCache(
  store: MediaFileStore = getDefaultMediaStore(),
): Promise<void> {
  const index = await readIndex(store);
  await Promise.all(
    index.entries.map((entry) =>
      store.delete(stickerPath(entry.id)).catch(() => {}),
    ),
  );
  await store.delete(INDEX_KEY).catch(() => {});
}
