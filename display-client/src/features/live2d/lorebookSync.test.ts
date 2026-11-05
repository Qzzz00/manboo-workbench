import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  reconcileLorebook,
  resetLorebookSyncer,
  type LorebookCache,
  type LorebookStore,
} from './lorebookSync.ts';
import { getAvatarById } from './avatarData.ts';
import type { ManifestLorebook } from './types.ts';
import { installTestAvatars } from './testAvatars.ts';

// 仓库不带模型(10-21),内置表是空的:这份用例拿当年那份清单当输入。
installTestAvatars();

const AVATAR = 'shuangsheng';

const lorebookV1: ManifestLorebook = {
  enabled: true,
  token_budget: 1024,
  default_scan_depth: 4,
  entries: [
    {
      id: 'e1',
      keys: ['魔法'],
      content: '她会魔法',
      constant: false,
      insertion_order: 0,
      priority: 10,
      position: 'before_char',
    },
  ],
};

class MemoryLorebookStore implements LorebookStore {
  data = new Map<string, string>();
  failWrites = false;

  async read(avatarId: string) {
    const raw = this.data.get(avatarId);
    if (!raw) return null;
    return JSON.parse(raw) as LorebookCache;
  }

  async write(avatarId: string, cache: LorebookCache) {
    if (this.failWrites) throw new Error('disk full');
    this.data.set(avatarId, JSON.stringify(cache));
  }
}

function cached(store: MemoryLorebookStore) {
  const raw = store.data.get(AVATAR);
  return raw ? (JSON.parse(raw) as LorebookCache) : null;
}

describe('reconcileLorebook', () => {
  beforeEach(() => {
    resetLorebookSyncer();
  });

  it('version 一致 → changed:false，不重写 lorebook（store 与 manifest 均保持旧值）', async () => {
    const store = new MemoryLorebookStore();
    store.data.set(AVATAR, JSON.stringify({ version: 'fp-1', lorebook: lorebookV1 }));
    const transport = vi.fn(async () => ({ version: 'fp-1', changed: false }));

    const result = await reconcileLorebook(AVATAR, {
      source: 'dialogue',
      store,
      transport,
      isLoggedIn: () => true,
    });

    expect(result.applied).toBe(false);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport).toHaveBeenCalledWith('fp-1');
    const cache = cached(store);
    expect(cache?.version).toBe('fp-1');
    expect(cache?.lorebook).toEqual(lorebookV1);
    expect(getAvatarById(AVATAR)?.lorebook).toBeUndefined();
  });

  it('version 变化 → 拉取并写回 manifest、store 缓存更新', async () => {
    const store = new MemoryLorebookStore();
    store.data.set(AVATAR, JSON.stringify({ version: 'fp-old' }));
    const transport = vi.fn(async () => ({ version: 'fp-new', changed: true, lorebook: lorebookV1 }));

    const result = await reconcileLorebook(AVATAR, {
      source: 'dialogue',
      store,
      transport,
      isLoggedIn: () => true,
    });

    expect(result.applied).toBe(true);
    expect(transport).toHaveBeenCalledWith('fp-old');
    const cache = cached(store);
    expect(cache?.version).toBe('fp-new');
    expect(cache?.lorebook).toEqual(lorebookV1);
    expect(getAvatarById(AVATAR)?.lorebook).toEqual(lorebookV1);
  });

  it('changed:true 但 lorebook 为 null（服务端禁用世界书）→ 清空 manifest 世界书并更新版本', async () => {
    const store = new MemoryLorebookStore();
    store.data.set(AVATAR, JSON.stringify({ version: 'fp-old', lorebook: lorebookV1 }));
    const transport = vi.fn(async () => ({ version: 'fp-new', changed: true, lorebook: null }));

    const result = await reconcileLorebook(AVATAR, {
      source: 'switch',
      store,
      transport,
      isLoggedIn: () => true,
    });

    expect(result.applied).toBe(true);
    expect(getAvatarById(AVATAR)?.lorebook).toBeUndefined();
    expect(cached(store)?.version).toBe('fp-new');
  });

  it('网络失败 / 404 / 401 → 静默保留旧缓存，不抛错', async () => {
    const store = new MemoryLorebookStore();
    const original = { version: 'fp-1', lorebook: lorebookV1 };
    store.data.set(AVATAR, JSON.stringify(original));
    const transport = vi.fn(async () => {
      throw new Error('network down');
    });

    const result = await reconcileLorebook(AVATAR, {
      source: 'dialogue',
      store,
      transport,
      isLoggedIn: () => true,
    });

    expect(result.applied).toBe(false);
    expect(cached(store)).toEqual(original);
    expect(getAvatarById(AVATAR)?.lorebook).toBeUndefined();
  });

  it('非法 JSON 载荷（非对象 / 缺 changed 字段）→ 静默保留旧缓存', async () => {
    for (const bad of ['oops', null, 42, { version: 'x' }, { changed: 'yes' }]) {
      const store = new MemoryLorebookStore();
      const original = { version: 'fp-1', lorebook: lorebookV1 };
      store.data.set(AVATAR, JSON.stringify(original));
      const transport = vi.fn(async () => bad);

      const result = await reconcileLorebook(AVATAR, {
        source: 'dialogue',
        store,
        transport,
        isLoggedIn: () => true,
      });

      expect(result.applied).toBe(false);
      expect(cached(store)).toEqual(original);
    }
  });

  it('双击 5 分钟节流：同角色 5 分钟内只对账一次；dialogue/switch/foreground 不节流', async () => {
    const store = new MemoryLorebookStore();
    let t = 0;
    const now = () => t;
    const transport = vi.fn(async () => ({ version: 'fp', changed: false }));

    await reconcileLorebook(AVATAR, { source: 'doubletap', store, transport, now, isLoggedIn: () => true });
    expect(transport).toHaveBeenCalledTimes(1);

    t = 4 * 60 * 1000;
    await reconcileLorebook(AVATAR, { source: 'doubletap', store, transport, now, isLoggedIn: () => true });
    expect(transport).toHaveBeenCalledTimes(1);

    t = 5 * 60 * 1000;
    await reconcileLorebook(AVATAR, { source: 'doubletap', store, transport, now, isLoggedIn: () => true });
    expect(transport).toHaveBeenCalledTimes(2);

    for (const source of ['dialogue', 'switch', 'foreground'] as const) {
      await reconcileLorebook(AVATAR, { source, store, transport, now, isLoggedIn: () => true });
    }
    expect(transport).toHaveBeenCalledTimes(5);
  });

  it('在途去重：同一角色并发只发一次请求', async () => {
    const store = new MemoryLorebookStore();
    const transport = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { version: 'fp', changed: false };
    });

    const [r1, r2] = await Promise.all([
      reconcileLorebook(AVATAR, { source: 'doubletap', store, transport, isLoggedIn: () => true }),
      reconcileLorebook(AVATAR, { source: 'dialogue', store, transport, isLoggedIn: () => true }),
    ]);

    expect(transport).toHaveBeenCalledTimes(1);
    expect(r1.applied).toBe(false);
    expect(r2.applied).toBe(false);
  });

  it('store 落盘写失败 → 静默兜底不抛错，仍写回 manifest', async () => {
    const store = new MemoryLorebookStore();
    store.failWrites = true;
    const transport = vi.fn(async () => ({ version: 'fp-new', changed: true, lorebook: lorebookV1 }));

    const result = await reconcileLorebook(AVATAR, {
      source: 'dialogue',
      store,
      transport,
      isLoggedIn: () => true,
    });

    expect(result.applied).toBe(true);
    expect(getAvatarById(AVATAR)?.lorebook).toEqual(lorebookV1);
  });

  it('游客 / 未登录 → 不触发任何请求（四个来源均静默跳过）', async () => {
    const store = new MemoryLorebookStore();
    const transport = vi.fn();

    for (const source of ['doubletap', 'dialogue', 'switch', 'foreground'] as const) {
      const result = await reconcileLorebook(AVATAR, {
        source,
        store,
        transport,
        isLoggedIn: () => false,
      });
      expect(result.applied).toBe(false);
    }

    expect(transport).not.toHaveBeenCalled();
  });
});
