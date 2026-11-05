import { afterEach, describe, expect, it } from 'vitest';
import { runRemoteAvatarSync } from './useRemoteAvatars.ts';
import {
  getRemoteAvatarSyncEntries,
  resetRemoteAvatarSync,
} from '../features/live2d/remoteAvatarSyncStore.ts';

afterEach(() => resetRemoteAvatarSync());

// 内存 store，避免触碰 Capacitor Filesystem
function memStore() {
  const files = new Map<string, string | Uint8Array>();
  return {
    async readText(p: string) {
      const v = files.get(p);
      if (typeof v !== 'string') throw new Error('miss');
      return v;
    },
    async writeText(p: string, d: string) { files.set(p, d); },
    async writeBinary(p: string, d: Uint8Array) { files.set(p, d); },
    async mkdirp() {},
  };
}

const CK = '0'.repeat(64); // 占位 checksum，install 内部重新校验会失败 → failed 分支

describe('runRemoteAvatarSync → sync store', () => {
  it('marks a freshly attempted avatar as failed when checksum mismatches', async () => {
    const catalog = [{ id: 'heath', name: '希斯', summary: '', version: 1, checksum: CK }];
    const result = await runRemoteAvatarSync({
      store: memStore(),
      catalogTransport: async () => ({ avatars: catalog }),
      assetTransport: async () => new ArrayBuffer(8),
    });
    expect(result.failed.map((f) => f.id)).toContain('heath');
    const statuses = Object.fromEntries(getRemoteAvatarSyncEntries().map((e) => [e.id, e.status]));
    expect(statuses.heath).toBe('failed');
  });

  it('moves every catalog entry to a terminal status after sync', async () => {
    const catalog = [{ id: 'a', name: 'A', summary: '', version: 1, checksum: CK }];
    await runRemoteAvatarSync({
      store: memStore(),
      catalogTransport: async () => ({ avatars: catalog }),
      assetTransport: async () => new ArrayBuffer(8),
    });
    const statuses = Object.fromEntries(getRemoteAvatarSyncEntries().map((e) => [e.id, e.status]));
    expect(['failed', 'ready']).toContain(statuses.a);
  });
});
