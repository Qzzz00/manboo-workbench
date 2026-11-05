/**
 * 世界书（lorebook）版本对账模块（ALL-440 任务包② 客户端）。
 *
 * 双击 / 进对话 / 切角色 / App 回前台四个触发点共用同一套逻辑：
 * 用本地缓存的版本号向后端「问一句」——变了才拉世界书全文并写回 manifest + 落盘缓存，
 * 没变近零流量、lorebook 不重写。内部自带在途去重（同角色并发只发一次请求）与
 * 双击 5 分钟节流（其余触发点不节流）。
 *
 * 设计约束：
 * - 纯逻辑模块，transport / store / 时钟 / 登录判定均可注入，便于单测；
 * - 永不抛错：游客 / 未登录 / 网络失败 / 404 / 401 / 非法 JSON 一律静默降级，
 *   保留旧缓存，不弹提示、不影响调用方；
 * - 默认 transport 走 apiGet + skipAuthHandler（同 fetchAvatarConfig，避免 401 全局登出）；
 * - 默认 store 走 Capacitor Filesystem（Directory.Data）落盘，重启后缓存仍在。
 */

import { apiGet, getBaseUrl } from '../../lib/apiClient.ts';
import { apiAvatarLorebook } from '../../lib/apiConfig.ts';
import { getStoredToken, isLocalGuest } from '../../lib/authStore.ts';
import { normalizeAvatarConfig } from './avatarConfigSync.ts';
import { applyLorebookConfig } from './avatarData.ts';
import { capacitorAvatarStore, AVATARS_ROOT } from './remoteAvatarRegistry.ts';
import type { ManifestLorebook } from './types.ts';

export type LorebookSyncSource = 'doubletap' | 'dialogue' | 'switch' | 'foreground';

/** 落盘缓存：对账用的本地版本号 + 世界书全文。 */
export type LorebookCache = {
  version?: string;
  lorebook?: ManifestLorebook;
};

/** 世界书缓存读写抽象（默认 Capacitor 落盘；单测传内存实现）。 */
export interface LorebookStore {
  read(avatarId: string): Promise<LorebookCache | null>;
  write(avatarId: string, cache: LorebookCache): Promise<void>;
}

export type LorebookTransport = (localVersion: string | undefined) => Promise<unknown>;

export type LorebookSyncOptions = {
  source: LorebookSyncSource;
  /** 注入用（测试 / 自定义请求）；默认走 apiGet。 */
  transport?: LorebookTransport;
  /** 注入用（测试）；默认 Capacitor Filesystem 落盘。 */
  store?: LorebookStore;
  /** 注入时钟（双击节流用）；默认 Date.now。 */
  now?: () => number;
  /** 注入登录判定；默认「非本地游客且有 token 且后端地址已配置」。 */
  isLoggedIn?: () => boolean;
};

export type LorebookSyncResult = { applied: boolean };

const DOUBLETAP_THROTTLE_MS = 5 * 60 * 1000;

const inFlight = new Map<string, Promise<LorebookSyncResult>>();
const lastDoubleTapAt = new Map<string, number>();

function lorebookCachePath(avatarId: string) {
  return `${AVATARS_ROOT}/${encodeURIComponent(avatarId)}/lorebook-cache.json`;
}

/** Capacitor Filesystem（Directory.Data）落盘实现，与 remoteAvatarRegistry 的 store 对齐。 */
export const capacitorLorebookStore: LorebookStore = {
  async read(avatarId) {
    const raw = await capacitorAvatarStore.readText(lorebookCachePath(avatarId));
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as Partial<LorebookCache>;
      if (!parsed || typeof parsed !== 'object') return null;
      return {
        version: typeof parsed.version === 'string' ? parsed.version : undefined,
        lorebook: parsed.lorebook,
      };
    } catch {
      return null;
    }
  },
  async write(avatarId, cache) {
    await capacitorAvatarStore.mkdirp(`${AVATARS_ROOT}/${encodeURIComponent(avatarId)}`);
    await capacitorAvatarStore.writeText(lorebookCachePath(avatarId), JSON.stringify(cache));
  },
};

function defaultIsLoggedIn(): boolean {
  try {
    return !isLocalGuest() && !!getStoredToken() && !!getBaseUrl();
  } catch {
    return false;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function defaultTransport(avatarId: string): LorebookTransport {
  return (localVersion) =>
    apiGet(apiAvatarLorebook(avatarId, localVersion), { skipAuthHandler: true });
}

async function runReconcile(
  avatarId: string,
  opts: LorebookSyncOptions,
): Promise<LorebookSyncResult> {
  const store = opts.store ?? capacitorLorebookStore;
  const transport = opts.transport ?? defaultTransport(avatarId);

  let cache: LorebookCache | null = null;
  try {
    cache = await store.read(avatarId);
  } catch {
    // 读缓存失败视同无缓存，继续对账。
  }

  let payload: unknown;
  try {
    payload = await transport(cache?.version);
  } catch {
    return { applied: false };
  }

  if (!isObject(payload)) return { applied: false };

  const version = typeof payload.version === 'string' ? payload.version : undefined;

  if (payload.changed === false) {
    // 版本一致：仅更新本地记录的版本号（若有字段变化），不重写世界书。
    if (version && version !== cache?.version) {
      try {
        await store.write(avatarId, { ...(cache ?? {}), version });
      } catch {
        // 写失败静默兜底。
      }
    }
    return { applied: false };
  }

  // 非显式 changed:true（如非法载荷）视作无变化，保留旧缓存。
  if (payload.changed !== true) return { applied: false };

  // 版本变了：解析世界书。服务端未启用时 lorebook 为 null → 清空 manifest 世界书。
  const lorebook = isObject(payload.lorebook)
    ? normalizeAvatarConfig({ lorebook: payload.lorebook })?.lorebook
    : undefined;
  try {
    await store.write(avatarId, { version, lorebook });
  } catch {
    // 写失败静默兜底。
  }
  return { applied: applyLorebookConfig(avatarId, lorebook) };
}

/**
 * 触发一次世界书对账。同一角色在途时返回既有请求（只发一次），
 * `source === 'doubletap'` 时做同一角色 5 分钟节流。永不 reject。
 */
export function reconcileLorebook(
  avatarId: string,
  opts: LorebookSyncOptions,
): Promise<LorebookSyncResult> {
  const isLoggedIn = opts.isLoggedIn ?? defaultIsLoggedIn;
  if (!isLoggedIn()) return Promise.resolve({ applied: false });

  if (opts.source === 'doubletap') {
    const now = opts.now ?? Date.now;
    const last = lastDoubleTapAt.get(avatarId) ?? Number.NEGATIVE_INFINITY;
    if (now() - last < DOUBLETAP_THROTTLE_MS) return Promise.resolve({ applied: false });
    lastDoubleTapAt.set(avatarId, now());
  }

  const existing = inFlight.get(avatarId);
  if (existing) return existing;

  const promise = runReconcile(avatarId, opts).finally(() => {
    inFlight.delete(avatarId);
  });
  inFlight.set(avatarId, promise);
  return promise;
}

/** 仅供单测重置模块级在途 / 节流状态。 */
export function resetLorebookSyncer() {
  inFlight.clear();
  lastDoubleTapAt.clear();
}
