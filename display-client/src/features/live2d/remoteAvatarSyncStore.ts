import { useSyncExternalStore } from 'react';

export type RemoteAvatarSyncStatus = 'pending' | 'installing' | 'ready' | 'failed';

export type RemoteAvatarSyncEntry = {
  id: string;
  name: string;
  status: RemoteAvatarSyncStatus;
};

// ── 角色库总更新按钮状态机 ─────────────────────────
//
// 与上面的逐角色占位 store 平行：这个 store 描述「角色库」整体的更新状态，
// 供加号页面的总更新按钮消费（红点 / 圆环进度 / 暂停继续 / 失败可重试）。

export type AvatarLibraryDownloadState =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'paused'
  | 'failed'
  | 'done';

export type AvatarLibraryProgress = {
  completed: number;
  total: number;
  percent: number;
};

export type AvatarLibraryUpdateState = {
  /** 总更新按钮所处状态机状态 */
  downloadState: AvatarLibraryDownloadState;
  /** 是否存在待下载的新角色 / 新版本 */
  updateAvailable: boolean;
  /** 待下载项数量 */
  pendingCount: number;
  /** 本轮下载进度（已完成数量 / 总数量） */
  progress: AvatarLibraryProgress;
  /** 本轮下载失败的角色 id，可重试 */
  failedItems: string[];
  /** 最近一次 catalog 拉取失败（无网 / 未登录），此时不应提示有更新 */
  catalogFailed: boolean;
};

export const INITIAL_AVATAR_LIBRARY_STATE: AvatarLibraryUpdateState = {
  downloadState: 'idle',
  updateAvailable: false,
  pendingCount: 0,
  progress: { completed: 0, total: 0, percent: 0 },
  failedItems: [],
  catalogFailed: false,
};

let libraryState: AvatarLibraryUpdateState = INITIAL_AVATAR_LIBRARY_STATE;
const libraryListeners = new Set<() => void>();

function notifyLibrary() {
  for (const listener of libraryListeners) listener();
}

/** 局部更新总更新按钮状态。coordinator 每次变更都应收敛完整状态后再调用。 */
export function setAvatarLibraryUpdateState(patch: Partial<AvatarLibraryUpdateState>): void {
  libraryState = { ...libraryState, ...patch };
  notifyLibrary();
}

export function getAvatarLibraryUpdateState(): AvatarLibraryUpdateState {
  return libraryState;
}

export function subscribeAvatarLibraryUpdate(listener: () => void): () => void {
  libraryListeners.add(listener);
  return () => {
    libraryListeners.delete(listener);
  };
}

export function resetAvatarLibraryUpdate(): void {
  libraryState = INITIAL_AVATAR_LIBRARY_STATE;
  notifyLibrary();
}

/** 加号页面总更新按钮消费的响应式状态。 */
export function useAvatarLibraryUpdate(): AvatarLibraryUpdateState {
  return useSyncExternalStore(
    subscribeAvatarLibraryUpdate,
    getAvatarLibraryUpdateState,
    getAvatarLibraryUpdateState,
  );
}

let entries: RemoteAvatarSyncEntry[] = [];
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

export function setRemoteAvatarStatus(id: string, name: string, status: RemoteAvatarSyncStatus): void {
  const idx = entries.findIndex((e) => e.id === id);
  const next: RemoteAvatarSyncEntry = { id, name, status };
  if (idx >= 0) {
    const current = entries[idx];
    if (current.status === status && current.name === name) return;
    entries = [...entries.slice(0, idx), next, ...entries.slice(idx + 1)];
  } else {
    entries = [...entries, next];
  }
  notify();
}

export function resetRemoteAvatarSync(): void {
  if (entries.length === 0) return;
  entries = [];
  notify();
}

export function getRemoteAvatarSyncEntries(): RemoteAvatarSyncEntry[] {
  return entries;
}

export function subscribeRemoteAvatarSync(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 抽屉占位 = 尚未就绪（pending/installing）且还没进入 avatarList 的角色。 */
export function selectPendingPlaceholders(
  readyIds: Set<string>,
  list: RemoteAvatarSyncEntry[],
): RemoteAvatarSyncEntry[] {
  return list.filter(
    (e) => (e.status === 'pending' || e.status === 'installing') && !readyIds.has(e.id),
  );
}

export function useRemoteAvatarSync(): RemoteAvatarSyncEntry[] {
  return useSyncExternalStore(subscribeRemoteAvatarSync, getRemoteAvatarSyncEntries, getRemoteAvatarSyncEntries);
}
