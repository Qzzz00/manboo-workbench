import { afterEach, describe, expect, it, vi } from 'vitest';
import { TextReader, Uint8ArrayWriter, ZipWriter } from '@zip.js/zip.js';
import {
  checkAvatarLibraryUpdate,
  pauseAvatarLibraryDownload,
  resetAvatarLibraryDownload,
  startAvatarLibraryDownload,
} from './useRemoteAvatars.ts';
import {
  getAvatarLibraryUpdateState,
  resetAvatarLibraryUpdate,
  resetRemoteAvatarSync,
} from '../features/live2d/remoteAvatarSyncStore.ts';
import {
  sha256Hex,
} from '../features/live2d/avatarDownloader.ts';
import type {
  AvatarFileStore,
  CatalogEntry,
} from '../features/live2d/remoteAvatarRegistry.ts';

afterEach(() => {
  resetAvatarLibraryDownload();
  resetAvatarLibraryUpdate();
  resetRemoteAvatarSync();
});

// ── helpers ──────────────────────────────────────

function memStore() {
  const files = new Map<string, string | Uint8Array>();
  const store: AvatarFileStore = {
    async readText(path) {
      const value = files.get(path);
      return typeof value === 'string' ? value : null;
    },
    async writeText(path, data) {
      files.set(path, data);
    },
    async writeBinary(path, data) {
      files.set(path, data);
    },
    async mkdirp() {},
  };
  return { store, files };
}

async function buildZip(entries: Record<string, string>): Promise<ArrayBuffer> {
  const writer = new ZipWriter(new Uint8ArrayWriter());
  for (const [name, content] of Object.entries(entries)) {
    await writer.add(name, new TextReader(content));
  }
  const bytes = await writer.close();
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function catalogEntry(overrides: Partial<CatalogEntry> & { id: string }): CatalogEntry {
  return {
    name: overrides.id,
    summary: '',
    version: '1',
    checksum: 'deadbeef',
    size_bytes: 0,
    updated_at: '2026-06-04T00:00:00Z',
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * 轮询等待条件成立，而不是假设「几个 tick 就能跑完」。
 * 单个角色的安装要过 crypto.subtle 摘要（libuv 线程池）与 zip.js 解压，
 * 跑完需要几个事件循环轮次随机器负载浮动（空载 2 轮、全量并行跑时 3~6 轮），
 * 写死 tick 数会在满负载下随机失败。
 */
async function waitFor(label: string, predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`等待超时：${label}`);
    await tick();
  }
}

// ── checkAvatarLibraryUpdate（轻量检查，不下载） ──

describe('checkAvatarLibraryUpdate', () => {
  it('reports available for a new role without downloading any zip', async () => {
    const { store } = memStore();
    const zip = await buildZip({ 'char.model3.json': '{}' });
    const checksum = await sha256Hex(zip);
    const transport = vi.fn(async () => zip);

    const result = await checkAvatarLibraryUpdate({
      store,
      catalogTransport: async () => [catalogEntry({ id: 'newbie', version: 1, checksum })],
      assetTransport: transport,
    });

    expect(result.updateAvailable).toBe(true);
    expect(result.pendingCount).toBe(1);
    expect(result.catalogFailed).toBe(false);
    const state = getAvatarLibraryUpdateState();
    expect(state.downloadState).toBe('available');
    expect(state.updateAvailable).toBe(true);
    expect(state.pendingCount).toBe(1);
    // 检查阶段绝不下载 zip
    expect(transport).not.toHaveBeenCalled();
  });

  it('reports done when local index already matches the catalog', async () => {
    const { store, files } = memStore();
    await store.writeText(
      'avatars/avatars-index.json',
      JSON.stringify({
        version: 1,
        entries: [{ ...catalogEntry({ id: 'a', version: 2, checksum: 'same' }), localPath: 'avatars/a/v2' }],
      }),
    );
    const spy = vi.fn(async () => new ArrayBuffer(8));

    const result = await checkAvatarLibraryUpdate({
      store,
      catalogTransport: async () => [catalogEntry({ id: 'a', version: 2, checksum: 'same' })],
      assetTransport: spy,
    });

    expect(result.updateAvailable).toBe(false);
    expect(result.pendingCount).toBe(0);
    expect(getAvatarLibraryUpdateState().downloadState).toBe('done');
    expect(getAvatarLibraryUpdateState().updateAvailable).toBe(false);
    expect(spy).not.toHaveBeenCalled();
    // 本地索引未被改动
    expect(files.get('avatars/avatars-index.json')).toBeTruthy();
  });

  it('hides update and flags catalogFailed when catalog fetch fails', async () => {
    const result = await checkAvatarLibraryUpdate({
      store: memStore().store,
      catalogTransport: () => Promise.reject(new Error('network')),
    });

    expect(result.catalogFailed).toBe(true);
    expect(result.updateAvailable).toBe(false);
    const state = getAvatarLibraryUpdateState();
    expect(state.downloadState).toBe('idle');
    expect(state.updateAvailable).toBe(false);
  });
});

// ── startAvatarLibraryDownload（用户点击后下载） ──

describe('startAvatarLibraryDownload', () => {
  it('downloads all pending items, saves index and reaches done', async () => {
    const { store, files } = memStore();
    const zip = await buildZip({ 'char.model3.json': '{}' });
    const checksum = await sha256Hex(zip);
    const catalog = [
      catalogEntry({ id: 'newbie', version: 1, checksum }),
      catalogEntry({ id: 'upgraded', version: 2, checksum }),
    ];

    await startAvatarLibraryDownload({
      store,
      catalogTransport: async () => catalog,
      assetTransport: async () => zip,
    });

    const state = getAvatarLibraryUpdateState();
    expect(state.downloadState).toBe('done');
    expect(state.updateAvailable).toBe(false);
    expect(state.pendingCount).toBe(0);
    expect(state.progress).toEqual({ completed: 2, total: 2, percent: 100 });
    expect(state.failedItems).toEqual([]);

    const raw = files.get('avatars/avatars-index.json');
    expect(typeof raw).toBe('string');
    const index = JSON.parse(raw as string);
    expect(index.entries.map((e: { id: string }) => e.id)).toEqual(['newbie', 'upgraded']);
  });

  it('keeps failed items out of the index but still installs the rest', async () => {
    const { store, files } = memStore();
    const zip = await buildZip({ 'char.model3.json': '{}' });
    const checksum = await sha256Hex(zip);
    const catalog = [
      catalogEntry({ id: 'good', version: 1, checksum }),
      catalogEntry({ id: 'bad', version: 1, checksum: 'wrong' }),
    ];

    await startAvatarLibraryDownload({
      store,
      catalogTransport: async () => catalog,
      assetTransport: (entry) =>
        entry.id === 'good' ? Promise.resolve(zip) : Promise.resolve(new ArrayBuffer(0)),
    });

    const state = getAvatarLibraryUpdateState();
    expect(state.downloadState).toBe('failed');
    expect(state.updateAvailable).toBe(true);
    expect(state.failedItems).toEqual(['bad']);
    expect(state.progress.completed).toBe(1);

    const index = JSON.parse(files.get('avatars/avatars-index.json') as string);
    expect(index.entries.map((e: { id: string }) => e.id)).toEqual(['good']);
  });

  it('reports per-item progress, then pauses and resumes from where it left off', async () => {
    const { store, files } = memStore();
    const zip = await buildZip({ 'char.model3.json': '{}' });
    const checksum = await sha256Hex(zip);
    const catalog = [
      catalogEntry({ id: 'a', version: 1, checksum }),
      catalogEntry({ id: 'b', version: 1, checksum }),
    ];
    const gates = new Map<string, ReturnType<typeof deferred<ArrayBuffer>>>();
    const transport = (entry: CatalogEntry, signal?: AbortSignal) => {
      const gate = deferred<ArrayBuffer>();
      gates.set(entry.id, gate);
      signal?.addEventListener('abort', () => gate.reject(new DOMException('aborted', 'AbortError')));
      return gate.promise;
    };

    const firstRun = startAvatarLibraryDownload({
      store,
      catalogTransport: async () => catalog,
      assetTransport: transport,
    });
    await waitFor('a 的下载请求已发出', () => gates.has('a'));
    expect(getAvatarLibraryUpdateState().downloadState).toBe('downloading');
    expect(getAvatarLibraryUpdateState().progress).toEqual({ completed: 0, total: 2, percent: 0 });

    // a 完成 → 进度 1/2
    gates.get('a')!.resolve(zip);
    await waitFor('a 安装完成', () => getAvatarLibraryUpdateState().progress.completed === 1);
    expect(getAvatarLibraryUpdateState().progress).toEqual({ completed: 1, total: 2, percent: 50 });

    // b 进行中 → 暂停 → b 被 abort，留在待更新里
    await waitFor('b 的下载请求已发出', () => gates.has('b'));
    const abortedGateB = gates.get('b');
    pauseAvatarLibraryDownload();
    await firstRun;
    expect(getAvatarLibraryUpdateState().downloadState).toBe('paused');
    expect(getAvatarLibraryUpdateState().progress.completed).toBe(1);

    // 再次点击 → 继续下载 b
    const secondRun = startAvatarLibraryDownload({
      store,
      catalogTransport: async () => catalog,
      assetTransport: transport,
    });
    // 必须等到 b 被重新发起（新的 gate），否则 resolve 的是暂停时已 reject 的旧 gate，
    // 新请求永远等不到结果 → 整个用例挂到超时。
    await waitFor('b 重新发起下载', () => gates.get('b') !== undefined && gates.get('b') !== abortedGateB);
    gates.get('b')!.resolve(zip);
    await secondRun;

    const state = getAvatarLibraryUpdateState();
    expect(state.downloadState).toBe('done');
    expect(state.progress).toEqual({ completed: 2, total: 2, percent: 100 });
    expect(state.updateAvailable).toBe(false);

    const index = JSON.parse(files.get('avatars/avatars-index.json') as string);
    expect(index.entries.map((e: { id: string }) => e.id)).toEqual(['a', 'b']);
  });

  it('ignores a second start while a download is already running', async () => {
    const { store } = memStore();
    const zip = await buildZip({ 'char.model3.json': '{}' });
    const checksum = await sha256Hex(zip);
    const catalog = [catalogEntry({ id: 'a', version: 1, checksum })];
    const gate = deferred<ArrayBuffer>();
    const transport = (_entry: CatalogEntry, signal?: AbortSignal) => {
      signal?.addEventListener('abort', () => gate.reject(new DOMException('aborted', 'AbortError')));
      return gate.promise;
    };

    const firstRun = startAvatarLibraryDownload({
      store,
      catalogTransport: async () => catalog,
      assetTransport: transport,
    });
    await tick();
    await startAvatarLibraryDownload({
      store,
      catalogTransport: async () => catalog,
      assetTransport: transport,
    });
    expect(getAvatarLibraryUpdateState().downloadState).toBe('downloading');

    pauseAvatarLibraryDownload();
    await firstRun;
    expect(getAvatarLibraryUpdateState().downloadState).toBe('paused');
  });

  it('does not clobber downloading state when a check races in', async () => {
    const { store } = memStore();
    const zip = await buildZip({ 'char.model3.json': '{}' });
    const checksum = await sha256Hex(zip);
    const catalog = [catalogEntry({ id: 'a', version: 1, checksum })];
    const gate = deferred<ArrayBuffer>();
    const transport = (_entry: CatalogEntry, signal?: AbortSignal) => {
      signal?.addEventListener('abort', () => gate.reject(new DOMException('aborted', 'AbortError')));
      return gate.promise;
    };
    const catalogSpy = vi.fn(async () => catalog);

    const run = startAvatarLibraryDownload({
      store,
      catalogTransport: catalogSpy,
      assetTransport: transport,
    });
    await tick();

    await checkAvatarLibraryUpdate({ store, catalogTransport: catalogSpy, assetTransport: transport });

    expect(getAvatarLibraryUpdateState().downloadState).toBe('downloading');
    // 下载中的检查直接早退，不再拉取 catalog
    expect(catalogSpy).toHaveBeenCalledTimes(1);

    pauseAvatarLibraryDownload();
    await run;
  });
});
