import { pullSync, pushSync, type SyncCategory, type SyncPayload } from './syncClient.ts';

const SYNC_DEBOUNCE_MS = 3000;
const SYNC_RETRY_MS = 10000;

const pendingCategories = new Set<SyncCategory>();
let pushTimer: ReturnType<typeof setTimeout> | null = null;
let isOnline = navigator.onLine;
let isPulling = false;

export type SyncChangeListener = () => void;
const listeners: SyncChangeListener[] = [];

function emitChange() {
  for (const cb of listeners) {
    try { cb(); } catch { /* ignore */ }
  }
}

export function onSyncChange(cb: SyncChangeListener) {
  listeners.push(cb);
  return () => {
    const idx = listeners.indexOf(cb);
    if (idx >= 0) listeners.splice(idx, 1);
  };
}

function getLocalUpdatedAt(category: SyncCategory): number {
  try {
    const raw = localStorage.getItem(`llm-live2d:sync-at:${category}`);
    return raw ? Number(raw) : 0;
  } catch { return 0; }
}

function setLocalUpdatedAt(category: SyncCategory, ts: number) {
  try {
    localStorage.setItem(`llm-live2d:sync-at:${category}`, String(ts));
  } catch { /* ignore */ }
}

export function markLocalChanged(category: SyncCategory) {
  const now = Date.now();
  setLocalUpdatedAt(category, now);
  pendingCategories.add(category);
  schedulePush();
}

function schedulePush() {
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    void executePush();
  }, SYNC_DEBOUNCE_MS);
}

async function executePush() {
  if (!navigator.onLine || pendingCategories.size === 0) return;

  const payload: Partial<SyncPayload> = {};
  for (const category of pendingCategories) {
    const data = readLocalData(category);
    const updatedAt = getLocalUpdatedAt(category);
    payload[category] = { data, updatedAt };
  }

  try {
    const result = await pushSync(payload);
    for (const category of pendingCategories) {
      const serverItem = result[category];
      if (serverItem) {
        setLocalUpdatedAt(category, serverItem.updatedAt);
      }
    }
    pendingCategories.clear();
    emitChange();
  } catch (e) {
    console.warn('[sync] push failed, will retry', e);
    setTimeout(() => schedulePush(), SYNC_RETRY_MS);
  }
}

function readLocalData(category: SyncCategory): unknown {
  try {
    switch (category) {
      case 'diary': {
        const raw = localStorage.getItem('llm-live2d:diary');
        return raw ? JSON.parse(raw) : {};
      }
      case 'relationships': {
        const raw = localStorage.getItem('llm-live2d:relationships');
        return raw ? JSON.parse(raw) : {};
      }
      case 'characterSettings': {
        const result: Record<string, unknown> = {};
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (key?.startsWith('llm-live2d:char-settings:')) {
            const avatarId = key.slice('llm-live2d:char-settings:'.length);
            const raw = localStorage.getItem(key);
            if (raw) result[avatarId] = JSON.parse(raw);
          }
        }
        return result;
      }
      case 'bubbleStyle': {
        const raw = localStorage.getItem('llm-live2d:chat-bubble-style');
        return raw || 'light';
      }
      case 'chatSummaries': {
        const raw = localStorage.getItem('llm-live2d:chat-summaries');
        return raw ? JSON.parse(raw) : {};
      }
    }
  } catch (e) {
    console.error('[sync] readLocalData error', category, e);
  }
  return null;
}

function writeLocalData(category: SyncCategory, data: unknown) {
  try {
    switch (category) {
      case 'diary': {
        localStorage.setItem('llm-live2d:diary', JSON.stringify(data));
        break;
      }
      case 'relationships': {
        localStorage.setItem('llm-live2d:relationships', JSON.stringify(data));
        break;
      }
      case 'characterSettings': {
        if (data && typeof data === 'object') {
          for (const [avatarId, settings] of Object.entries(data as Record<string, unknown>)) {
            localStorage.setItem(`llm-live2d:char-settings:${avatarId}`, JSON.stringify(settings));
          }
        }
        break;
      }
      case 'bubbleStyle': {
        const style = typeof data === 'string' ? data : 'light';
        localStorage.setItem('llm-live2d:chat-bubble-style', style);
        break;
      }
      case 'chatSummaries': {
        localStorage.setItem('llm-live2d:chat-summaries', JSON.stringify(data));
        break;
      }
    }
  } catch (e) {
    console.error('[sync] writeLocalData error', category, e);
  }
}

export async function executePull(): Promise<void> {
  if (!navigator.onLine || isPulling) return;
  isPulling = true;

  try {
    const serverData = await pullSync();
    let hasChange = false;

    const categories: SyncCategory[] = ['diary', 'relationships', 'characterSettings', 'bubbleStyle', 'chatSummaries'];
    for (const category of categories) {
      const serverItem = serverData[category];
      if (!serverItem) continue;

      const localAt = getLocalUpdatedAt(category);
      if (serverItem.updatedAt > localAt) {
        writeLocalData(category, serverItem.data);
        setLocalUpdatedAt(category, serverItem.updatedAt);
        hasChange = true;
      } else if (localAt > serverItem.updatedAt) {
        // Local is newer, queue for push
        pendingCategories.add(category);
      }
    }

    if (hasChange) {
      emitChange();
    }
    if (pendingCategories.size > 0) {
      schedulePush();
    }
  } catch (e) {
    console.warn('[sync] pull failed', e);
  } finally {
    isPulling = false;
  }
}

export function setupNetworkListeners() {
  function handleOnline() {
    if (!isOnline) {
      isOnline = true;
      console.log('[sync] network online, retrying sync');
      void executePull();
      if (pendingCategories.size > 0) schedulePush();
    }
  }

  function handleOffline() {
    isOnline = false;
    console.log('[sync] network offline');
  }

  window.addEventListener('online', handleOnline);
  window.addEventListener('offline', handleOffline);

  return () => {
    window.removeEventListener('online', handleOnline);
    window.removeEventListener('offline', handleOffline);
  };
}

export function getPendingCategories(): SyncCategory[] {
  return Array.from(pendingCategories);
}

export function isSyncEngineOnline(): boolean {
  return isOnline;
}
