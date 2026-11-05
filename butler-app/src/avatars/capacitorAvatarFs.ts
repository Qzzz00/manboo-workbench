/**
 * 形象库在真机上的那一半(2026-10-01,docs/设计-形象切换与形象包-2026-10-01.md 2.3)。
 *
 *   · 下载不在这儿:10-21 起形象只从电脑上的 butler-server 来,经配对会话取 zip(serverSource.ts);
 *   · 解压:`@zip.js/zip.js`(依赖里本来就有,会议录音打包用的那个);
 *   · 落盘:`Data/avatars/<id>/v<version>/`;
 *   · 地址:`Capacitor.convertFileSrc` → `http://localhost/_capacitor_file_/…`,与 App 同源,展示台 iframe 直接读。
 */
import { Capacitor } from '@capacitor/core';
import { Directory, Filesystem } from '@capacitor/filesystem';
import { Uint8ArrayReader, Uint8ArrayWriter, ZipReader } from '@zip.js/zip.js';
import type { AvatarFs } from './library';

const ROOT = 'avatars';

function toBase64(bytes: Uint8Array): string {
  let out = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) out += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(out);
}

export function capacitorAvatarFs(): AvatarFs {
  return {
    async write(id, version, files) {
      for (const f of files) {
        await Filesystem.writeFile({ path: `${ROOT}/${id}/v${version}/${f.path}`, data: toBase64(f.data), directory: Directory.Data, recursive: true });
      }
    },
    async remove(id) {
      try { await Filesystem.rmdir({ path: `${ROOT}/${id}`, directory: Directory.Data, recursive: true }); } catch { /* 本来就没有 */ }
    },
    async baseUrl(id, version) {
      const { uri } = await Filesystem.getUri({ path: `${ROOT}/${id}/v${version}`, directory: Directory.Data });
      return `${Capacitor.convertFileSrc(uri).replace(/\/$/, '')}/`;
    },
  };
}

export async function unzipAll(data: Uint8Array): Promise<{ path: string; data: Uint8Array }[]> {
  const reader = new ZipReader(new Uint8ArrayReader(data));
  try {
    const out: { path: string; data: Uint8Array }[] = [];
    for (const entry of await reader.getEntries()) {
      if (entry.directory || entry.getData === undefined) continue;
      const path = entry.filename.replace(/^\.\//, '');
      if (path.includes('..')) continue;
      out.push({ path, data: await entry.getData(new Uint8ArrayWriter()) });
    }
    return out;
  } finally {
    await reader.close();
  }
}

export async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data as unknown as ArrayBuffer);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** WebView 的 NetworkInformation:'wifi' / 'ethernet' 算 Wi-Fi,'cellular' 不算,读不到 null。 */
export function onWifiNow(): boolean | null {
  const c = (navigator as unknown as { connection?: { type?: string } }).connection;
  if (c === undefined || typeof c.type !== 'string' || c.type === 'unknown' || c.type === '') return null;
  if (c.type === 'cellular') return false;
  return c.type === 'wifi' || c.type === 'ethernet' ? true : null;
}
