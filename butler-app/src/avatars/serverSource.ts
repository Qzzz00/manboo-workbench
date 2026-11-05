/**
 * 形象库的来源:电脑上的 butler-server(2026-10-21 起唯一的来源)。
 *
 * 经配对会话的语音接口走(`/butler/proxy/api/avatars`,8791 认设备令牌后转给 butler-server):局域网直连或房间,
 * 由 routedClient 自己挑路。列表里只有已发布的;版本号、zip 大小、sha256 原样带上(butler-server routes/api/avatars.cjs)。
 */
import type { VoiceApi } from '../api/voice';
import type { AvatarSource, ServerAvatar } from './library';

/** Blob 的字节。老 WebView(Chrome < 76)与测试里的 jsdom 没有 `arrayBuffer()`,退回 FileReader(同 channelClient.ts)。 */
async function blobBytes(blob: Blob): Promise<Uint8Array> {
  if (typeof blob.arrayBuffer === 'function') return new Uint8Array(await blob.arrayBuffer());
  return await new Promise<Uint8Array>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => { resolve(new Uint8Array(reader.result as ArrayBuffer)); };
    reader.onerror = () => { reject(reader.error ?? new Error('形象包读不出来')); };
    reader.readAsArrayBuffer(blob);
  });
}

function versionOf(v: unknown): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isInteger(n) && n > 0 ? n : 1;
}

export function avatarSourceOf(voice: Pick<VoiceApi, 'listAvatars' | 'fetchBundle'>): AvatarSource {
  return {
    async list() {
      const r = await voice.listAvatars();
      if (!r.ok) return null;
      return r.avatars.map((a): ServerAvatar => ({
        id: a.id,
        name: a.name,
        version: versionOf(a.version),
        ...(typeof a.size_bytes === 'number' && a.size_bytes > 0 ? { zipBytes: a.size_bytes } : {}),
        ...(typeof a.checksum === 'string' && a.checksum !== '' ? { sha256: a.checksum } : {}),
      }));
    },
    async fetchZip(id) {
      const r = await voice.fetchBundle(id);
      if (!r.ok) throw new Error(r.error);
      return await blobBytes(r.data);
    },
  };
}
