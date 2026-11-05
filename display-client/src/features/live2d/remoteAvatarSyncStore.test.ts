import { afterEach, describe, expect, it } from 'vitest';
import {
  getRemoteAvatarSyncEntries,
  resetRemoteAvatarSync,
  selectPendingPlaceholders,
  setRemoteAvatarStatus,
} from './remoteAvatarSyncStore.ts';
import {
  getAvatarLibraryUpdateState,
  resetAvatarLibraryUpdate,
  setAvatarLibraryUpdateState,
} from './remoteAvatarSyncStore.ts';

afterEach(() => {
  resetRemoteAvatarSync();
  resetAvatarLibraryUpdate();
});

describe('remoteAvatarSyncStore', () => {
  it('records and updates a status by id', () => {
    setRemoteAvatarStatus('a', '希斯', 'pending');
    setRemoteAvatarStatus('a', '希斯', 'installing');
    const entries = getRemoteAvatarSyncEntries();
    expect(entries).toEqual([{ id: 'a', name: '希斯', status: 'installing' }]);
  });

  it('resets to empty', () => {
    setRemoteAvatarStatus('a', 'A', 'ready');
    resetRemoteAvatarSync();
    expect(getRemoteAvatarSyncEntries()).toEqual([]);
  });

  it('selectPendingPlaceholders keeps only not-yet-ready, not-already-listed entries', () => {
    setRemoteAvatarStatus('ready1', 'R', 'ready');
    setRemoteAvatarStatus('dl', '下载', 'installing');
    setRemoteAvatarStatus('wait', '等待', 'pending');
    setRemoteAvatarStatus('boom', 'X', 'failed');
    const readyIds = new Set(['ready1', 'dl']); // dl already entered avatarList
    const result = selectPendingPlaceholders(readyIds, getRemoteAvatarSyncEntries());
    expect(result.map((e) => e.id)).toEqual(['wait']);
  });
});

describe('avatarLibraryUpdate store（总更新按钮状态机）', () => {
  it('defaults to idle with no update', () => {
    const state = getAvatarLibraryUpdateState();
    expect(state.downloadState).toBe('idle');
    expect(state.updateAvailable).toBe(false);
    expect(state.pendingCount).toBe(0);
    expect(state.progress).toEqual({ completed: 0, total: 0, percent: 0 });
    expect(state.failedItems).toEqual([]);
  });

  it('tracks available → downloading → paused transitions (red dot / ring inputs)', () => {
    setAvatarLibraryUpdateState({
      downloadState: 'available',
      updateAvailable: true,
      pendingCount: 2,
    });
    expect(getAvatarLibraryUpdateState().downloadState).toBe('available');
    expect(getAvatarLibraryUpdateState().updateAvailable).toBe(true);

    setAvatarLibraryUpdateState({
      downloadState: 'downloading',
      progress: { completed: 1, total: 2, percent: 50 },
    });
    let state = getAvatarLibraryUpdateState();
    expect(state.downloadState).toBe('downloading');
    expect(state.progress.percent).toBe(50);
    // 下载中 UI 转圆环：updateAvailable 保留但红点由组件按 downloadState 隐藏
    expect(state.updateAvailable).toBe(true);

    setAvatarLibraryUpdateState({ downloadState: 'paused' });
    state = getAvatarLibraryUpdateState();
    expect(state.downloadState).toBe('paused');
  });

  it('records failed items so the button can show retry', () => {
    setAvatarLibraryUpdateState({
      downloadState: 'failed',
      updateAvailable: true,
      pendingCount: 1,
      failedItems: ['bad'],
    });
    const state = getAvatarLibraryUpdateState();
    expect(state.downloadState).toBe('failed');
    expect(state.failedItems).toEqual(['bad']);
    expect(state.updateAvailable).toBe(true);
  });

  it('reset returns to the initial idle state', () => {
    setAvatarLibraryUpdateState({ downloadState: 'done', updateAvailable: true, pendingCount: 3 });
    resetAvatarLibraryUpdate();
    expect(getAvatarLibraryUpdateState()).toEqual({
      downloadState: 'idle',
      updateAvailable: false,
      pendingCount: 0,
      progress: { completed: 0, total: 0, percent: 0 },
      failedItems: [],
      catalogFailed: false,
    });
  });
});
