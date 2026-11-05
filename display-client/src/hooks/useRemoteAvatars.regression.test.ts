import { afterEach, describe, expect, it } from 'vitest';
import { TextReader, Uint8ArrayWriter, ZipWriter } from '@zip.js/zip.js';
import { checkAvatarLibraryUpdate, resetAvatarLibraryDownload } from './useRemoteAvatars.ts';
import { resetAvatarLibraryUpdate, resetRemoteAvatarSync } from '../features/live2d/remoteAvatarSyncStore.ts';
import { sha256Hex } from '../features/live2d/avatarDownloader.ts';
import { clearRemoteOverrides, getAvatarById } from '../features/live2d/avatarData.ts';
import type { AvatarFileStore, CatalogEntry } from '../features/live2d/remoteAvatarRegistry.ts';

afterEach(() => {
  resetAvatarLibraryDownload();
  resetAvatarLibraryUpdate();
  resetRemoteAvatarSync();
  clearRemoteOverrides();
});

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

describe('regression: 老用户已安装角色重启后仍在角色列表', () => {
  it('登录轻量检查后，已安装角色仍被应用进角色列表（兼容旧本地 index）', async () => {
    const { store } = memStore();
    const zip = await buildZip({ 'char.model3.json': '{}' });
    const checksum = await sha256Hex(zip);
    await store.writeText(
      'avatars/avatars-index.json',
      JSON.stringify({
        version: 1,
        entries: [
          {
            id: 'newbie',
            name: 'newbie',
            summary: '',
            version: 1,
            checksum,
            size_bytes: 0,
            updated_at: '2026-06-04T00:00:00Z',
            localPath: 'avatars/newbie/v1',
            modelEntry: 'avatars/newbie/v1/char.model3.json',
            lastDownloadedAt: 1,
          },
        ],
      }),
    );
    await store.writeText('avatars/newbie/v1/manifest.json', JSON.stringify({ id: 'newbie' }));

    await checkAvatarLibraryUpdate({
      store,
      catalogTransport: async () => [catalogEntry({ id: 'newbie', version: 1, checksum })],
      assetTransport: async () => zip,
    });

    expect(getAvatarById('newbie')).toBeDefined();
  });
});
