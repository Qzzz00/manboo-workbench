import { apiGet } from './apiClient.ts';
import { API_JOURNEY_CURRENT_BEAT } from './apiConfig.ts';
import type { JourneyNotification, JourneyLifeSigns, CurrentBeat } from '../types/journey.ts';

export { startJourney } from './proactiveApi.ts';
export type { StartJourneyResult } from './proactiveApi.ts';

const STORAGE_KEY = 'aiboo-journey-state';

/** 同窗口内生命迹象变化事件名；journeyStore 写操作时派发，供 hook 零延迟刷新。 */
export const LIFE_SIGNS_CHANGE_EVENT = 'aiboo-life-signs-changed';

/** 同窗口内当前节拍变化事件名。 */
export const CURRENT_BEAT_CHANGE_EVENT = 'aiboo-current-beat-changed';

export interface JourneyState {
  notifications: JourneyNotification[];
  lifeSigns: JourneyLifeSigns;
  pausedNotifications: boolean;
  /** 按 avatarId 记录的未读消息数（画外消息横幅错过时的兜底红点）。 */
  unread?: Record<string, number>;
  /** 按 avatarId 缓存的当前剧情节拍。 */
  currentBeats?: Record<string, CurrentBeat | null>;
  /** 按 avatarId 记录节拍最近一次成功拉取的时间戳（ms），用于判定缓存是否 stale。 */
  currentBeatFetchedAt?: Record<string, number>;
}

function readState(): JourneyState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as JourneyState;
      if (!parsed.unread) parsed.unread = {};
      if (!parsed.currentBeats) parsed.currentBeats = {};
      if (!parsed.currentBeatFetchedAt) parsed.currentBeatFetchedAt = {};
      return parsed;
    }
  } catch {
    // ignore
  }
  return { notifications: [], lifeSigns: {}, pausedNotifications: false, unread: {}, currentBeats: {}, currentBeatFetchedAt: {} };
}

function writeState(state: JourneyState) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // ignore
  }
}

export function addNotification(notification: JourneyNotification) {
  const state = readState();
  if (state.pausedNotifications && notification.type !== 'farewell') return;
  state.notifications.unshift(notification);
  if (state.notifications.length > 50) state.notifications.pop();
  writeState(state);
}

export function listNotifications(): JourneyNotification[] {
  return readState().notifications;
}

export function clearNotifications() {
  const state = readState();
  state.notifications = [];
  writeState(state);
}

const lifeSignsListeners = new Set<(lifeSigns: JourneyLifeSigns) => void>();

function emitLifeSignsChanged(lifeSigns: JourneyLifeSigns) {
  for (const listener of lifeSignsListeners) {
    try {
      listener(lifeSigns);
    } catch {
      // ignore listener errors
    }
  }
  try {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent(LIFE_SIGNS_CHANGE_EVENT, { detail: lifeSigns }));
    }
  } catch {
    // ignore
  }
}

export function setLifeSigns(lifeSigns: JourneyLifeSigns) {
  const state = readState();
  state.lifeSigns = lifeSigns;
  writeState(state);
  emitLifeSignsChanged(lifeSigns);
}

export function getLifeSigns(): JourneyLifeSigns {
  return readState().lifeSigns;
}

/** 订阅生命迹象变化（同窗口 setLifeSigns 触发）。返回取消订阅函数。 */
export function subscribeLifeSigns(listener: (lifeSigns: JourneyLifeSigns) => void) {
  lifeSignsListeners.add(listener);
  return () => {
    lifeSignsListeners.delete(listener);
  };
}

const currentBeatListeners = new Set<(avatarId: string, beat: CurrentBeat | null) => void>();

function emitCurrentBeatChanged(avatarId: string, beat: CurrentBeat | null) {
  for (const listener of currentBeatListeners) {
    try {
      listener(avatarId, beat);
    } catch {
      // ignore listener errors
    }
  }
  try {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent(CURRENT_BEAT_CHANGE_EVENT, { detail: { avatarId, beat } }));
    }
  } catch {
    // ignore
  }
}

export function setCurrentBeat(avatarId: string, beat: CurrentBeat | null) {
  const state = readState();
  state.currentBeats = state.currentBeats ?? {};
  state.currentBeats[avatarId] = beat;
  writeState(state);
  emitCurrentBeatChanged(avatarId, beat);
}

export function getCurrentBeat(avatarId: string): CurrentBeat | null {
  return readState().currentBeats?.[avatarId] ?? null;
}

/** 清除指定角色的缓存节拍（例如角色切换或旅程结束时）。 */
export function clearCurrentBeat(avatarId: string) {
  setCurrentBeat(avatarId, null);
}

/** 记录指定角色节拍的最近一次成功拉取时间戳（ms）。 */
function markCurrentBeatFetched(avatarId: string) {
  const state = readState();
  state.currentBeatFetchedAt = state.currentBeatFetchedAt ?? {};
  state.currentBeatFetchedAt[avatarId] = Date.now();
  writeState(state);
}

/** 返回指定角色节拍最近一次成功拉取的时间戳（ms）；从未拉过返回 null。 */
export function getCurrentBeatFetchedAt(avatarId: string): number | null {
  return readState().currentBeatFetchedAt?.[avatarId] ?? null;
}

/** 从服务端拉取当前角色的当前节拍并缓存；无进行中的旅程实例时缓存为 null。 */
export async function fetchCurrentBeat(avatarId: string): Promise<CurrentBeat | null> {
  try {
    const data = (await apiGet(`${API_JOURNEY_CURRENT_BEAT}?avatar_id=${encodeURIComponent(avatarId)}`)) as {
      beat: CurrentBeat | null;
    };
    const beat = data?.beat ?? null;
    setCurrentBeat(avatarId, beat);
    // 仅在成功拉取后记录时间戳：失败时不更新，下一次仍视为 stale 会重试，也不会误清缓存。
    markCurrentBeatFetched(avatarId);
    return beat;
  } catch (e) {
    console.warn('[journeyStore] fetchCurrentBeat failed', e);
    return getCurrentBeat(avatarId);
  }
}

/**
 * 节拍缓存的懒刷新：距上次成功拉取超过 maxAgeMs（或从未拉过）时才发请求，否则直接返回缓存。
 * 用于「用户发消息前」路径，避免每条消息都打 current-beat 接口。
 * 拉取失败由 fetchCurrentBeat 静默降级到旧缓存，绝不返回意外 null 让 prompt 里节拍消失。
 */
export async function fetchCurrentBeatIfStale(avatarId: string, maxAgeMs = 60_000): Promise<CurrentBeat | null> {
  const fetchedAt = getCurrentBeatFetchedAt(avatarId);
  if (fetchedAt !== null && Date.now() - fetchedAt <= maxAgeMs) {
    return getCurrentBeat(avatarId);
  }
  return fetchCurrentBeat(avatarId);
}

/** 订阅当前节拍变化（同窗口 setCurrentBeat/fetchCurrentBeat 触发）。返回取消订阅函数。 */
export function subscribeCurrentBeat(listener: (avatarId: string, beat: CurrentBeat | null) => void) {
  currentBeatListeners.add(listener);
  return () => {
    currentBeatListeners.delete(listener);
  };
}

export function setPausedNotifications(paused: boolean) {
  const state = readState();
  state.pausedNotifications = paused;
  writeState(state);
}

const unreadListeners = new Set<() => void>();

function emitUnreadChanged() {
  for (const listener of unreadListeners) {
    try {
      listener();
    } catch {
      // ignore listener errors
    }
  }
}

/** 画外角色消息未读计数 +1（横幅错过时的兜底）。 */
export function addUnread(avatarId: string) {
  const state = readState();
  const unread = state.unread ?? {};
  unread[avatarId] = (unread[avatarId] ?? 0) + 1;
  state.unread = unread;
  writeState(state);
  emitUnreadChanged();
}

/** 清除指定角色的未读计数（用户点开该角色时调用）。 */
export function clearUnread(avatarId: string) {
  const state = readState();
  const unread = state.unread ?? {};
  if (unread[avatarId]) {
    delete unread[avatarId];
    state.unread = unread;
    writeState(state);
    emitUnreadChanged();
  }
}

/** 全部角色未读数合计，驱动个人主页圆钮红点显隐。 */
export function getUnreadCount(): number {
  const unread = readState().unread ?? {};
  return Object.values(unread).reduce((sum, n) => sum + n, 0);
}

/** 订阅未读计数变化（同窗口 addUnread/clearUnread 触发）。返回取消订阅函数。 */
export function subscribeUnread(listener: () => void) {
  unreadListeners.add(listener);
  return () => {
    unreadListeners.delete(listener);
  };
}

