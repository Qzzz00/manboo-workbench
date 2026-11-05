/**
 * 形象库的来源 = 电脑上的 butler-server(2026-10-21):经配对会话(局域网直连或房间)、带设备令牌,
 * 走 8791 的 /butler/proxy/api/avatars。列表里的版本号、zip 大小、sha256 原样带上,拿不到就说拿不到。
 */
import { describe, expect, it } from 'vitest';
import { avatarSourceOf } from '../src/avatars/serverSource';
import type { VoiceApi } from '../src/api/voice';

function voice(over: Partial<VoiceApi>): VoiceApi {
  const never = () => { throw new Error('不该调'); };
  return { listAvatars: never, getAvatar: never, fetchBundle: never, tts: never, asr: never, rtcToken: never, ...over } as VoiceApi;
}

describe('avatarSourceOf', () => {
  it('★列表:id / 名字 / 版本 / zip 大小 / sha256;版本缺了或写成字符串也认', async () => {
    const src = avatarSourceOf(voice({
      async listAvatars() {
        return { ok: true, avatars: [
          { id: 'a1', name: '日和', version: 3, size_bytes: 4_000_000, checksum: 'abc' },
          { id: 'a2', name: 'B', version: '2' },
          { id: 'a3', name: 'C' },
        ] };
      },
    }));
    expect(await src.list()).toEqual([
      { id: 'a1', name: '日和', version: 3, zipBytes: 4_000_000, sha256: 'abc' },
      { id: 'a2', name: 'B', version: 2 },
      { id: 'a3', name: 'C', version: 1 },
    ]);
  });
  it('列表拿不到(电脑不在线 / 形象服务没起来)→ null', async () => {
    const src = avatarSourceOf(voice({ async listAvatars() { return { ok: false, kind: 'unavailable', error: '本机后端没起来' } as never; } }));
    expect(await src.list()).toBeNull();
  });
  it('取 zip:回字节;没成就抛那一句原话', async () => {
    const ok = avatarSourceOf(voice({ async fetchBundle(id) { expect(id).toBe('a1'); return { ok: true, status: 200, data: new Blob([new Uint8Array([7, 8])]) }; } }));
    expect(Array.from(await ok.fetchZip('a1'))).toEqual([7, 8]);
    const bad = avatarSourceOf(voice({ async fetchBundle() { return { ok: false, kind: 'network', error: '连不上电脑' } as never; } }));
    await expect(bad.fetchZip('a1')).rejects.toThrow('连不上电脑');
  });
});

describe('getAvatar 拆掉 butler-server 的 { avatar } 外壳(10-21)', () => {
  it('★model_entry / transform 读得到;老样子(不带外壳)照认', async () => {
    const { createVoiceApi } = await import('../src/api/voice');
    const reply = (data: unknown) => ({ json: async () => ({ ok: true as const, status: 200, data }) }) as unknown as Parameters<typeof createVoiceApi>[0];
    const wrapped = await createVoiceApi(reply({ avatar: { id: 'a1', name: '日和', model_entry: 'm/m.model3.json', transform: { scaleMultiplier: 1.2 } } })).getAvatar('a1');
    expect(wrapped.ok && wrapped.data.model_entry).toBe('m/m.model3.json');
    expect(wrapped.ok && wrapped.data.transform).toEqual({ scaleMultiplier: 1.2 });
    const bare = await createVoiceApi(reply({ id: 'a1', name: '日和', model_entry: 'x.model3.json' })).getAvatar('a1');
    expect(bare.ok && bare.data.model_entry).toBe('x.model3.json');
  });
});
