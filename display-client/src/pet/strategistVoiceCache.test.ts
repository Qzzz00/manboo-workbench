import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CACHED_LINES,
  FILLERS,
  GREETING,
  getCached,
  pickFiller,
  warmVoiceCache,
} from './strategistVoiceCache.ts';

// 测试环境是 node（非 jsdom），全局无 localStorage —— 同 handheldLaunchStore.test.ts 打内存版 stub。
function installLocalStorageStub() {
  const store = new Map<string, string>();
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => {
      store.set(k, v);
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
    clear: () => {
      store.clear();
    },
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() {
      return store.size;
    },
  } as Storage;
}

const EP = () => ({ baseUrl: 'http://aiboo', token: 'jwt' });

function fakeTts(spy?: string[]) {
  return vi.fn(async (_ep: unknown, p: { text: string; avatarId?: string }) => {
    spy?.push(`${p.avatarId}|${p.text}`);
    return { audioBase64: 'QQ==', mime: 'audio/mpeg' };
  });
}

beforeEach(() => installLocalStorageStub());

describe('warmVoiceCache', () => {
  it('把开场白与全部垫词都烤上', async () => {
    const calls: string[] = [];
    await warmVoiceCache(EP, 'shuangsheng', { ttsImpl: fakeTts(calls) as never });

    expect(calls.length).toBe(CACHED_LINES.length);
    expect(getCached('shuangsheng', GREETING)).not.toBeNull();
    for (const f of FILLERS) expect(getCached('shuangsheng', f)).not.toBeNull();
  });

  it('已缓存的跳过，不重复花钱', async () => {
    await warmVoiceCache(EP, 'shuangsheng', { ttsImpl: fakeTts() as never });
    const second = fakeTts();
    await warmVoiceCache(EP, 'shuangsheng', { ttsImpl: second as never });

    expect(second).not.toHaveBeenCalled();
  });

  it('★缓存按角色分开——换角色时招呼不能还是上一只的声音', async () => {
    await warmVoiceCache(EP, 'shuangsheng', { ttsImpl: fakeTts() as never });

    expect(getCached('shuangsheng', GREETING)).not.toBeNull();
    expect(getCached('rattan', GREETING)).toBeNull(); // 另一只没烤过，不能串用
  });

  it('合成失败不抛——预热是 fire-and-forget，失败不该有任何可见后果', async () => {
    const boom = vi.fn(async () => {
      throw new Error('HTTP_401');
    });
    await expect(warmVoiceCache(EP, 'x', { ttsImpl: boom as never })).resolves.toBeUndefined();
    expect(getCached('x', GREETING)).toBeNull();
  });
});

describe('pickFiller', () => {
  it('一句都没缓存时返回 null（调用方跳过播报即可）', () => {
    expect(pickFiller('shuangsheng')).toBeNull();
  });

  it('缓存好了就能挑出来，且挑的是垫词不是开场白', async () => {
    await warmVoiceCache(EP, 'shuangsheng', { ttsImpl: fakeTts() as never });
    expect(pickFiller('shuangsheng', () => 0)).not.toBeNull();
  });

  it('随机数取到边界 1 也不越界', async () => {
    await warmVoiceCache(EP, 'shuangsheng', { ttsImpl: fakeTts() as never });
    expect(pickFiller('shuangsheng', () => 0.999999)).not.toBeNull();
    expect(pickFiller('shuangsheng', () => 1)).not.toBeNull();
  });
});
