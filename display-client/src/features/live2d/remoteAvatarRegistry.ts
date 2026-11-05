/**
 * 远端角色形象库 —— catalog 拉取、本地索引读写与差异比对。
 *
 * 该模块只负责「目录层」的逻辑：
 * - 从后端拉取角色 catalog 并归一化；
 * - 读写持久化到 Capacitor `Directory.Data` 的本地索引 `avatars-index.json`；
 * - 比对远端 catalog 与本地索引，算出需要下载 / 无变化的角色。
 *
 * 实际的 zip 下载、解压与落盘见 `avatarDownloader.ts`。
 * 所有涉及文件系统的函数都接受可注入的 {@link AvatarFileStore}，
 * 默认走 Capacitor，单测可传入内存实现。
 */

import { apiGet } from '../../lib/apiClient.ts';
import { API_AVATAR_CATALOG } from '../../lib/apiConfig.ts';
import type { ContextTemplate, ManifestLorebook } from './types.ts';

// ── 数据结构 ──────────────────────────────────────

export type CatalogEntry = {
  id: string;
  name: string;
  summary: string;
  version: string | number;
  checksum: string;
  size_bytes: number;
  updated_at: string;
  /** 服务端 catalog 已透传的世界书配置 */
  lorebook?: ManifestLorebook;
  /** 服务端 catalog 已透传的角色级 prompt 模板 */
  prompt_template?: ContextTemplate;
};

export type RemoteAvatarIndexEntry = CatalogEntry & {
  /** 角色资源解压后的目录，如 `avatars/<id>/v<version>` */
  localPath?: string;
  /** 模型入口文件路径（`*.model3.json`），供渲染层加载 */
  modelEntry?: string;
  /** 最近一次成功下载的时间戳（ms） */
  lastDownloadedAt?: number;
};

export type RemoteAvatarIndex = {
  version: number;
  entries: RemoteAvatarIndexEntry[];
};

export type CatalogDiff = {
  /** 本地缺失、版本更高或校验值不一致，需要下载 */
  toDownload: CatalogEntry[];
  /** 版本与校验值都一致，无需处理 */
  unchanged: RemoteAvatarIndexEntry[];
};

// ── 文件系统抽象 ──────────────────────────────────

/** 所有路径相对 `Directory.Data` 根。 */
export interface AvatarFileStore {
  readText(path: string): Promise<string | null>;
  writeText(path: string, data: string): Promise<void>;
  writeBinary(path: string, data: Uint8Array): Promise<void>;
  mkdirp(path: string): Promise<void>;
}

export const AVATARS_ROOT = 'avatars';
export const LOCAL_INDEX_PATH = `${AVATARS_ROOT}/avatars-index.json`;
export const INDEX_SCHEMA_VERSION = 1;

export function emptyIndex(): RemoteAvatarIndex {
  return { version: INDEX_SCHEMA_VERSION, entries: [] };
}

// ── Capacitor 实现（默认 store）──────────────────

type FilesystemModule = typeof import('@capacitor/filesystem');
let filesystemModule: Promise<FilesystemModule> | null = null;

function loadFilesystem() {
  if (!filesystemModule) {
    filesystemModule = import('@capacitor/filesystem');
  }
  return filesystemModule;
}

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** 基于 Capacitor Filesystem + `Directory.Data` 的默认存储实现。 */
export const capacitorAvatarStore: AvatarFileStore = {
  async readText(path) {
    const { Filesystem, Directory, Encoding } = await loadFilesystem();
    try {
      const result = await Filesystem.readFile({
        path,
        directory: Directory.Data,
        encoding: Encoding.UTF8,
      });
      return typeof result.data === 'string' ? result.data : await result.data.text();
    } catch {
      return null;
    }
  },
  async writeText(path, data) {
    const { Filesystem, Directory, Encoding } = await loadFilesystem();
    await Filesystem.writeFile({
      path,
      data,
      directory: Directory.Data,
      encoding: Encoding.UTF8,
      recursive: true,
    });
  },
  async writeBinary(path, data) {
    const { Filesystem, Directory } = await loadFilesystem();
    await Filesystem.writeFile({
      path,
      data: uint8ToBase64(data),
      directory: Directory.Data,
      recursive: true,
    });
  },
  async mkdirp(path) {
    const { Filesystem, Directory } = await loadFilesystem();
    try {
      await Filesystem.mkdir({ path, directory: Directory.Data, recursive: true });
    } catch {
      // 目录已存在时 mkdir 会抛错，忽略。
    }
  },
};

// ── 本地索引读写 ──────────────────────────────────

export async function loadLocalIndex(
  store: AvatarFileStore = capacitorAvatarStore,
): Promise<RemoteAvatarIndex> {
  const raw = await store.readText(LOCAL_INDEX_PATH);
  if (!raw) return emptyIndex();
  try {
    const parsed = JSON.parse(raw) as Partial<RemoteAvatarIndex>;
    if (!parsed || !Array.isArray(parsed.entries)) return emptyIndex();
    return {
      version: typeof parsed.version === 'number' ? parsed.version : INDEX_SCHEMA_VERSION,
      entries: parsed.entries.filter((entry): entry is RemoteAvatarIndexEntry =>
        Boolean(entry && typeof entry.id === 'string'),
      ),
    };
  } catch {
    // 索引文件损坏时按空索引处理，下一轮同步会重建。
    return emptyIndex();
  }
}

export async function saveLocalIndex(
  index: RemoteAvatarIndex,
  store: AvatarFileStore = capacitorAvatarStore,
): Promise<void> {
  await store.mkdirp(AVATARS_ROOT);
  await store.writeText(LOCAL_INDEX_PATH, JSON.stringify(index, null, 2));
}

// ── Catalog 拉取 ──────────────────────────────────

export type CatalogTransport = () => Promise<unknown>;

const defaultCatalogTransport: CatalogTransport = () => apiGet(API_AVATAR_CATALOG);

function isCatalogEntry(value: unknown): value is CatalogEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.id === 'string' &&
    (typeof entry.version === 'string' || typeof entry.version === 'number') &&
    typeof entry.checksum === 'string'
  );
}

/** 兼容后端返回 `[]` / `{ avatars: [] }` / `{ catalog: [] }` 三种结构。 */
function normalizeCatalog(payload: unknown): CatalogEntry[] {
  const list = Array.isArray(payload)
    ? payload
    : Array.isArray((payload as { avatars?: unknown })?.avatars)
      ? (payload as { avatars: unknown[] }).avatars
      : Array.isArray((payload as { catalog?: unknown })?.catalog)
        ? (payload as { catalog: unknown[] }).catalog
        : [];
  return list.filter(isCatalogEntry);
}

/**
 * 拉取远端 catalog。请求或解析失败时向上抛出，由调用方决定是否回退到本地索引。
 */
export async function fetchCatalog(
  transport: CatalogTransport = defaultCatalogTransport,
): Promise<CatalogEntry[]> {
  const payload = await transport();
  return normalizeCatalog(payload);
}

// ── 版本比对与 diff ──────────────────────────────

/** 整数版本比较。后端 version 为 INTEGER，直接按数字比较。 */
export function compareVersions(a: string | number, b: string | number): number {
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) {
    if (na === nb) return 0;
    return na > nb ? 1 : -1;
  }
  // fallback: string comparison
  const sa = String(a);
  const sb = String(b);
  if (sa === sb) return 0;
  return sa > sb ? 1 : -1;
}

/**
 * 比对远端 catalog 与本地索引：
 * - 本地缺失或未成功落盘（无 localPath）→ toDownload；
 * - 远端版本更高 → toDownload；
 * - 版本一致且 checksum 一致 → unchanged；
 * - 版本一致但 checksum 不一致（或版本更低）→ toDownload（修复 / 回滚）。
 */
export function diffCatalog(
  catalog: CatalogEntry[],
  index: RemoteAvatarIndex,
): CatalogDiff {
  const localById = new Map(index.entries.map((entry) => [entry.id, entry] as const));
  const toDownload: CatalogEntry[] = [];
  const unchanged: RemoteAvatarIndexEntry[] = [];

  for (const entry of catalog) {
    const local = localById.get(entry.id);
    if (!local || !local.localPath) {
      toDownload.push(entry);
      continue;
    }
    const cmp = compareVersions(entry.version, local.version);
    if (cmp === 0 && entry.checksum === local.checksum) {
      unchanged.push(local);
      continue;
    }
    toDownload.push(entry);
  }

  return { toDownload, unchanged };
}
