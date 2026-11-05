/**
 * 远端角色资源包下载与落盘。
 *
 * 流程：下载 zip → 计算 sha256 校验 checksum → 用 `@zip.js/zip.js` 解压
 * → 写入 `Directory.Data/avatars/<id>/v<version>/` → 落地 `manifest.json`。
 *
 * 校验失败会抛出 {@link ChecksumMismatchError}，调用方应捕获并跳过该角色，
 * 不写入本地索引（见 `useRemoteAvatars.ts` 的 `runRemoteAvatarSync`）。
 */

import { Uint8ArrayReader, Uint8ArrayWriter, ZipReader } from '@zip.js/zip.js';
import { apiGetArrayBuffer } from '../../lib/apiClient.ts';
import { apiAvatarAssetPath } from '../../lib/apiConfig.ts';
import {
  AVATARS_ROOT,
  capacitorAvatarStore,
  type AvatarFileStore,
  type CatalogEntry,
  type RemoteAvatarIndexEntry,
} from './remoteAvatarRegistry.ts';

export class ChecksumMismatchError extends Error {
  constructor(
    public avatarId: string,
    public expected: string,
    public actual: string,
  ) {
    super(`角色 ${avatarId} 资源校验失败：期望 ${expected}，实际 ${actual}`);
    this.name = 'ChecksumMismatchError';
  }
}

export type ExtractedFile = {
  /** zip 内归一化后的相对路径 */
  path: string;
  data: Uint8Array;
};

export type AssetTransport = (entry: CatalogEntry, signal?: AbortSignal) => Promise<ArrayBuffer>;

const defaultAssetTransport: AssetTransport = (entry, signal) =>
  apiGetArrayBuffer(apiAvatarAssetPath(entry.id, entry.version), { signal });

// ── checksum ──────────────────────────────────────

/** 计算 ArrayBuffer 的 sha256，返回小写 hex 字符串。 */
export async function sha256Hex(buffer: ArrayBuffer): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

/** 去掉 `sha256:` / `sha256-` 前缀并归一化为小写 hex。 */
function normalizeChecksum(value: string): string {
  return value.trim().replace(/^sha-?256[:-]/i, '').toLowerCase();
}

export async function verifyChecksum(
  buffer: ArrayBuffer,
  expected: string,
): Promise<boolean> {
  const actual = await sha256Hex(buffer);
  return actual === normalizeChecksum(expected);
}

// ── 下载与解压 ────────────────────────────────────

export function downloadAvatarAsset(
  entry: CatalogEntry,
  transport: AssetTransport = defaultAssetTransport,
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  return transport(entry, signal);
}

function normalizeZipPath(filename: string): string {
  return filename.replace(/\\/g, '/').replace(/^\.?\//, '').replace(/^\/+/, '');
}

/** 解压 zip ArrayBuffer，返回所有文件（跳过目录项）。 */
export async function extractZip(buffer: ArrayBuffer): Promise<ExtractedFile[]> {
  const reader = new ZipReader(new Uint8ArrayReader(new Uint8Array(buffer)));
  try {
    const entries = await reader.getEntries();
    const files: ExtractedFile[] = [];
    for (const entry of entries) {
      if (entry.directory || !entry.getData) continue;
      const data = await entry.getData(new Uint8ArrayWriter());
      files.push({ path: normalizeZipPath(entry.filename), data });
    }
    return files;
  } finally {
    await reader.close();
  }
}

/** 在解压结果里寻找模型入口 `*.model3.json`，优先取路径最浅的一个。 */
function findModelEntry(files: ExtractedFile[]): string | undefined {
  const candidates = files
    .map((file) => file.path)
    .filter((path) => /\.model3\.json$/i.test(path))
    .sort((a, b) => a.split('/').length - b.split('/').length);
  return candidates[0];
}

export function avatarVersionDir(id: string, version: string | number): string {
  return `${AVATARS_ROOT}/${id}/v${version}`;
}

function parentDir(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx <= 0 ? '' : path.slice(0, idx);
}

export type InstallAvatarOptions = {
  store?: AvatarFileStore;
  assetTransport?: AssetTransport;
  now?: () => number;
  /** 外部中止信号：下载中被 abort 时抛出 AbortError，调用方据此暂停/重试。 */
  signal?: AbortSignal;
};

/**
 * 下载 + 校验 + 解压 + 落盘单个角色，返回可写入本地索引的条目。
 *
 * checksum 不一致时抛出 {@link ChecksumMismatchError}，且不会写入任何文件，
 * 从而保证「校验失败不更新 index」。
 */
export async function installAvatar(
  entry: CatalogEntry,
  options: InstallAvatarOptions = {},
): Promise<RemoteAvatarIndexEntry> {
  const store = options.store ?? capacitorAvatarStore;
  const now = options.now ?? Date.now;

  const buffer = await downloadAvatarAsset(entry, options.assetTransport, options.signal);

  const actual = await sha256Hex(buffer);
  if (actual !== normalizeChecksum(entry.checksum)) {
    throw new ChecksumMismatchError(entry.id, normalizeChecksum(entry.checksum), actual);
  }

  const files = await extractZip(buffer);
  const dir = avatarVersionDir(entry.id, entry.version);

  await store.mkdirp(dir);
  const writtenDirs = new Set<string>([dir]);
  for (const file of files) {
    const target = `${dir}/${file.path}`;
    const parent = parentDir(target);
    if (parent && !writtenDirs.has(parent)) {
      await store.mkdirp(parent);
      writtenDirs.add(parent);
    }
    await store.writeBinary(target, file.data);
  }

  const modelEntry = findModelEntry(files);
  const indexEntry: RemoteAvatarIndexEntry = {
    ...entry,
    localPath: dir,
    modelEntry: modelEntry ? `${dir}/${modelEntry}` : undefined,
    lastDownloadedAt: now(),
  };

  await store.writeText(
    `${dir}/manifest.json`,
    JSON.stringify({ ...indexEntry, files: files.map((file) => file.path) }, null, 2),
  );

  return indexEntry;
}
