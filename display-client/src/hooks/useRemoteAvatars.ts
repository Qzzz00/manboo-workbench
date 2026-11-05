/**
 * 远端角色形象库同步。
 *
 * 登录后只做「轻量检查」：拉 catalog 元数据与本地 index 比对（id + version + checksum），
 * 算出 updateAvailable / pendingCount，**不在检查阶段下载 zip**（不产生流量）。
 *
 * 下载只能由用户点击加号页面的总更新按钮触发（startAvatarLibraryDownload），
 * 支持暂停 / 继续 / 失败重试，进度按「已完成数量 / 总数量」上报。
 *
 * 行为约束：
 * - 不阻塞首屏：检查以 effect 形式后台执行，UI 不等待结果；
 * - catalog 拉取失败时回退到本地索引或空数组，绝不把异常抛到 UI；
 * - 单个角色下载 / 校验失败只跳过该角色，不影响其它角色与本地索引落盘；
 * - 暂停只中止未完成的下载，已下载并安装成功的角色保留，本地 index 不被污染。
 */

import { useEffect } from 'react';
import { Capacitor } from '@capacitor/core';
import { App as CapacitorApp } from '@capacitor/app';
import {
  diffCatalog,
  emptyIndex,
  fetchCatalog,
  loadLocalIndex,
  saveLocalIndex,
  capacitorAvatarStore,
  type AvatarFileStore,
  type CatalogEntry,
  type RemoteAvatarIndex,
  type RemoteAvatarIndexEntry,
} from '../features/live2d/remoteAvatarRegistry.ts';
import { installAvatar, type AssetTransport } from '../features/live2d/avatarDownloader.ts';
import { applyRemoteOverrides, avatars } from '../features/live2d/avatarManifest.ts';
import { checkOverrideParamCompat, cdi3PathForModelEntry } from '../features/live2d/overrideCompat.ts';
import { initLocalAvatarRoot } from '../features/live2d/avatarData.ts';
import {
  setRemoteAvatarStatus,
  setAvatarLibraryUpdateState,
  useAvatarLibraryUpdate,
  type AvatarLibraryUpdateState,
} from '../features/live2d/remoteAvatarSyncStore.ts';
import type { RemoteAvatarManifest } from '../features/live2d/types.ts';

export type RemoteAvatarSyncDeps = {
  store?: AvatarFileStore;
  catalogTransport?: CatalogTransport;
  assetTransport?: AssetTransport;
  now?: () => number;
};

export type RemoteAvatarSyncResult = {
  /** 同步后的完整本地索引条目 */
  entries: RemoteAvatarIndexEntry[];
  /** 本轮成功新下载 / 更新的角色 id */
  downloaded: string[];
  /** 本轮失败的角色及原因 */
  failed: { id: string; error: string }[];
  /** catalog 请求失败、已回退本地索引 */
  catalogFailed: boolean;
};

export type CatalogTransport = () => Promise<unknown>;

/**
 * 将本地索引条目转换为远端 manifest，供 applyRemoteOverrides 使用。
 * 顺带读包内 manifest.json 的 files 清单：覆盖包自带的动作/表情文件据此优先于内置兜底。
 */
async function indexEntryToManifest(
  entry: RemoteAvatarIndexEntry,
  store: AvatarFileStore,
): Promise<RemoteAvatarManifest | null> {
  if (!entry.localPath || !entry.modelEntry) return null;
  let files: string[] | undefined;
  try {
    const raw = await store.readText(`${entry.localPath}/manifest.json`);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { files?: unknown }).files)) {
      files = (parsed as { files: unknown[] }).files.filter((f): f is string => typeof f === 'string');
    }
  } catch {
    files = undefined;
  }
  return {
    id: entry.id,
    name: entry.name,
    summary: entry.summary,
    model_entry: entry.modelEntry.replace(`${entry.localPath}/`, ''),
    version: entry.version,
    localDir: entry.localPath,
    files,
    lorebook: entry.lorebook,
    prompt_template: entry.prompt_template,
  };
}

/** 把已落盘的本地索引推给 applyRemoteOverrides，让角色列表立即可见（参数兼容性门）。 */
async function applyInstalledAvatars(nextIndex: RemoteAvatarIndex, store: AvatarFileStore): Promise<void> {
  const manifests = (
    await Promise.all(nextIndex.entries.map((entry) => indexEntryToManifest(entry, store)))
  ).filter((m): m is RemoteAvatarManifest => m !== null);
  // 参数兼容性门：覆盖模型缺少内置同名角色换装表情引用的参数时拒绝该覆盖，
  // 回退内置模型——否则换装触发"执行成功但画面无变化"（v3 轻量模型包事故）。
  const compatible: RemoteAvatarManifest[] = [];
  for (const manifest of manifests) {
    const base = avatars[manifest.id];
    const result = await checkOverrideParamCompat(base?.expressions, () =>
      store.readText(`${manifest.localDir}/${cdi3PathForModelEntry(manifest.model_entry)}`),
    );
    if (!result.ok) {
      console.warn('[remote-avatar] override rejected: model missing params', { id: manifest.id, missing: result.missing });
      continue;
    }
    compatible.push(manifest);
  }
  if (compatible.length > 0) {
    // 先解析 Directory.Data 基址，确保 manifest 的 modelJson 是可加载的绝对 URL
    await initLocalAvatarRoot();
    applyRemoteOverrides(compatible);
  }
}

/**
 * 执行一轮远端角色同步。**永不 reject** —— 所有错误都被收敛进返回值，
 * 方便在 effect 中直接调用。
 *
 * 注意：这是「检查 + 全量下载」的兼容入口，供测试 / 一次性全量同步使用；
 * 日常 UI 走 checkAvatarLibraryUpdate + startAvatarLibraryDownload 两段式。
 */
export async function runRemoteAvatarSync(
  deps: RemoteAvatarSyncDeps = {},
): Promise<RemoteAvatarSyncResult> {
  const store = deps.store ?? capacitorAvatarStore;

  let index: RemoteAvatarIndex;
  try {
    index = await loadLocalIndex(store);
  } catch {
    index = emptyIndex();
  }

  let catalog: CatalogEntry[] | null = null;
  try {
    catalog = await fetchCatalog(deps.catalogTransport);
  } catch {
    catalog = null;
  }

  if (!catalog) {
    // 无网 / 拉取失败：回退到本地索引（可能为空数组）。
    return { entries: index.entries, downloaded: [], failed: [], catalogFailed: true };
  }

  const diff = diffCatalog(catalog, index);
  const merged = new Map(index.entries.map((entry) => [entry.id, entry] as const));
  const downloaded: string[] = [];
  const failed: { id: string; error: string }[] = [];

  // 全量标 pending（供抽屉占位）；已装好的直接标 ready
  for (const entry of catalog) {
    setRemoteAvatarStatus(entry.id, entry.name, 'pending');
  }
  for (const entry of diff.unchanged) {
    setRemoteAvatarStatus(entry.id, entry.name, 'ready');
  }

  for (const entry of diff.toDownload) {
    setRemoteAvatarStatus(entry.id, entry.name, 'installing');
    try {
      const installed = await installAvatar(entry, {
        store,
        assetTransport: deps.assetTransport,
        now: deps.now,
      });
      merged.set(installed.id, installed);
      downloaded.push(installed.id);
      setRemoteAvatarStatus(entry.id, entry.name, 'ready');
    } catch (error) {
      // 单角色失败不阻断其它角色；该角色保留旧索引条目（若有），不更新。
      failed.push({ id: entry.id, error: error instanceof Error ? error.message : String(error) });
      setRemoteAvatarStatus(entry.id, entry.name, 'failed');
    }
  }

  const nextIndex: RemoteAvatarIndex = { version: index.version, entries: [...merged.values()] };

  if (downloaded.length > 0) {
    try {
      await saveLocalIndex(nextIndex, store);
    } catch {
      // 落盘失败不影响本轮已下载的内存结果。
    }
  }

  // 把本地已下载的角色索引推给 applyRemoteOverrides，让角色列表感知
  await applyInstalledAvatars(nextIndex, store);

  return { entries: nextIndex.entries, downloaded, failed, catalogFailed: false };
}

// ── 两段式：轻量检查（自动） + 用户触发下载 ──────────────────────

export type AvatarLibraryCheckResult = {
  updateAvailable: boolean;
  pendingCount: number;
  /** 本轮差异里需要下载的项（新角色 + 新版本 + checksum 变化） */
  toDownload: CatalogEntry[];
  catalogFailed: boolean;
};

/**
 * 轻量检查更新：只拉 catalog 元数据并与本地 index 比对，**不下载任何 zip**。
 * 结果写入 remoteAvatarSyncStore，供总更新按钮渲染红点 / 文案。
 */
export async function checkAvatarLibraryUpdate(
  deps: RemoteAvatarSyncDeps = {},
): Promise<AvatarLibraryCheckResult> {
  // 下载进行中不并发检查：避免把 downloading/paused 状态冲掉。
  if (activeRun) {
    return {
      updateAvailable: true,
      pendingCount: Math.max(0, activeRun.total - activeRun.completed),
      toDownload: [...activeRun.remaining],
      catalogFailed: false,
    };
  }

  setAvatarLibraryUpdateState({ downloadState: 'checking' });

  const store = deps.store ?? capacitorAvatarStore;

  let index: RemoteAvatarIndex;
  try {
    index = await loadLocalIndex(store);
  } catch {
    index = emptyIndex();
  }

  // 老用户升级后必须把已安装角色重新应用进角色列表，否则重启/重登后已下载角色消失
  // （兼容旧本地 index；只读本地 manifest，不产生任何下载）。
  await applyInstalledAvatars(index, store);

  let catalog: CatalogEntry[] | null = null;
  try {
    catalog = await fetchCatalog(deps.catalogTransport);
  } catch (error) {
    catalog = null;
    console.warn('[remote-avatar] catalog 拉取失败', { error: error instanceof Error ? error.message : String(error) });
  }

  if (!catalog) {
    // 无网 / 未登录 / 拉取失败：不提示有更新，避免误导用户。
    setAvatarLibraryUpdateState({
      downloadState: 'idle',
      updateAvailable: false,
      pendingCount: 0,
      progress: { completed: 0, total: 0, percent: 0 },
      failedItems: [],
      catalogFailed: true,
    });
    return { updateAvailable: false, pendingCount: 0, toDownload: [], catalogFailed: true };
  }

  const diff = diffCatalog(catalog, index);
  const updateAvailable = diff.toDownload.length > 0;
  setAvatarLibraryUpdateState({
    downloadState: updateAvailable ? 'available' : 'done',
    updateAvailable,
    pendingCount: diff.toDownload.length,
    failedItems: [],
    catalogFailed: false,
  });
  return {
    updateAvailable,
    pendingCount: diff.toDownload.length,
    toDownload: diff.toDownload,
    catalogFailed: false,
  };
}

// ── 下载协调器（仅用户点击总更新按钮触发） ──────────────────────

type DownloadRun = {
  controller: AbortController;
  /** 尚未处理完的待下载项 */
  remaining: CatalogEntry[];
  completed: number;
  total: number;
  failed: string[];
};

let activeRun: DownloadRun | null = null;
let pausedRun: DownloadRun | null = null;

function percentFor(completed: number, total: number): number {
  return total <= 0 ? 0 : Math.round((completed / total) * 100);
}

/**
 * 开始（或继续）下载 catalog diff 中的所有待更新项。
 * - 存在未完成且被暂停的 run 时从断点继续；
 * - 否则先做一次轻量检查拿到最新 diff 再下载；
 * - 已下载并安装成功的角色保留；失败项留在待更新里，可再次点击重试。
 */
export async function startAvatarLibraryDownload(
  deps: RemoteAvatarSyncDeps = {},
): Promise<void> {
  if (activeRun) return;

  const store = deps.store ?? capacitorAvatarStore;

  let items: CatalogEntry[];
  let completed: number;
  let failed: string[];

  if (pausedRun) {
    items = pausedRun.remaining;
    completed = pausedRun.completed;
    failed = pausedRun.failed;
    pausedRun = null;
  } else {
    const check = await checkAvatarLibraryUpdate(deps);
    if (check.catalogFailed || check.toDownload.length === 0) return;
    items = check.toDownload;
    completed = 0;
    failed = [];
  }

  const run: DownloadRun = {
    controller: new AbortController(),
    remaining: [...items],
    completed,
    total: completed + items.length,
    failed: [...failed],
  };
  activeRun = run;

  setAvatarLibraryUpdateState({
    downloadState: 'downloading',
    updateAvailable: true,
    pendingCount: run.total - run.completed,
    progress: { completed: run.completed, total: run.total, percent: percentFor(run.completed, run.total) },
    failedItems: [...run.failed],
    catalogFailed: false,
  });

  let index: RemoteAvatarIndex;
  try {
    index = await loadLocalIndex(store);
  } catch {
    index = emptyIndex();
  }
  const merged = new Map(index.entries.map((entry) => [entry.id, entry] as const));
  const downloaded: string[] = [];

  while (run.remaining.length > 0 && !run.controller.signal.aborted) {
    const entry = run.remaining[0];
    setRemoteAvatarStatus(entry.id, entry.name, 'installing');
    try {
      const installed = await installAvatar(entry, {
        store,
        assetTransport: deps.assetTransport,
        now: deps.now,
        signal: run.controller.signal,
      });
      merged.set(installed.id, installed);
      downloaded.push(installed.id);
      run.completed += 1;
      setRemoteAvatarStatus(entry.id, entry.name, 'ready');
      // 每成功一个就增量落盘：暂停/中断后已安装角色不会丢，未完成项不污染 index。
      try {
        await saveLocalIndex({ version: index.version, entries: [...merged.values()] }, store);
      } catch {
        // 落盘失败不影响本轮已下载的内存结果，最终结束时还会再写一次。
      }
    } catch (error) {
      // 暂停（abort）不算失败：break 后统一走 paused 分支。
      if (run.controller.signal.aborted) break;
      // 单角色失败不影响其它角色；该角色保留旧索引条目（若有），不更新。
      run.failed.push(entry.id);
      setRemoteAvatarStatus(entry.id, entry.name, 'failed');
      // 失败原因必须留痕：此前静默吞掉导致服务端 404 排查时要抓包才能定位。
      console.warn('[remote-avatar] 下载失败', { id: entry.id, error: error instanceof Error ? error.message : String(error) });
    }
    run.remaining.shift();
    setAvatarLibraryUpdateState({
      progress: { completed: run.completed, total: run.total, percent: percentFor(run.completed, run.total) },
      pendingCount: Math.max(0, run.total - run.completed),
      failedItems: [...run.failed],
    });
  }

  if (run.controller.signal.aborted) {
    // 可能已被 pauseAvatarLibraryDownload 提前接管（activeRun 已清），这里幂等收尾。
    if (activeRun === run) {
      activeRun = null;
      pausedRun = run;
      setAvatarLibraryUpdateState({ downloadState: 'paused' });
    }
    return;
  }

  if (downloaded.length > 0) {
    try {
      await saveLocalIndex({ version: index.version, entries: [...merged.values()] }, store);
    } catch {
      // 落盘失败不影响本轮已下载的内存结果。
    }
  }

  const nextIndex: RemoteAvatarIndex = { version: index.version, entries: [...merged.values()] };
  // 下载完成后刷新角色列表，让新角色立即可见。
  await applyInstalledAvatars(nextIndex, store);

  if (activeRun === run) activeRun = null;
  pausedRun = null;

  if (run.failed.length > 0) {
    setAvatarLibraryUpdateState({
      downloadState: 'failed',
      updateAvailable: true,
      pendingCount: run.failed.length,
      progress: { completed: run.completed, total: run.total, percent: percentFor(run.completed, run.total) },
      failedItems: [...run.failed],
    });
  } else {
    setAvatarLibraryUpdateState({
      downloadState: 'done',
      updateAvailable: false,
      pendingCount: 0,
      progress: { completed: run.total, total: run.total, percent: 100 },
      failedItems: [],
    });
  }
}

/**
 * 暂停当前下载：中止进行中的请求。已下载并安装成功的角色保留，
 * 未完成项会在下次 startAvatarLibraryDownload 时继续/重新下载，不污染本地 index。
 */
export function pauseAvatarLibraryDownload(): void {
  const run = activeRun;
  if (!run) return;
  run.controller.abort();
  activeRun = null;
  pausedRun = run;
  setAvatarLibraryUpdateState({ downloadState: 'paused' });
}

/** 清空下载协调器状态（登出 / 测试清理用）。 */
export function resetAvatarLibraryDownload(): void {
  if (activeRun) activeRun.controller.abort();
  activeRun = null;
  pausedRun = null;
}

/**
 * 总更新按钮 hook：登录后 / App 回到前台时自动做轻量检查（不下载），
 * 返回角色库整体更新状态供加号页面渲染红点、文案与进度。
 */
export function useRemoteAvatars(options: { enabled?: boolean } = {}): AvatarLibraryUpdateState {
  const { enabled = true } = options;
  const state = useAvatarLibraryUpdate();

  // 登录后立即轻量检查一次。
  useEffect(() => {
    if (!enabled) return;
    void checkAvatarLibraryUpdate();
  }, [enabled]);

  // App 回到前台时轻量复查（浏览器 visibilitychange + 原生 appStateChange 双保险）。
  useEffect(() => {
    if (!enabled) return;
    let appListener: { remove(): Promise<void> } | null = null;
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void checkAvatarLibraryUpdate();
    };
    document.addEventListener('visibilitychange', onVisibility);
    if (Capacitor.isNativePlatform()) {
      void CapacitorApp.addListener('appStateChange', ({ isActive }) => {
        if (isActive) void checkAvatarLibraryUpdate();
      }).then((listener) => {
        appListener = listener;
      });
    }
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      void appListener?.remove();
    };
  }, [enabled]);

  return state;
}
