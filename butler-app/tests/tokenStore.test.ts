import { describe, expect, it } from 'vitest';
import { createTokenStore, type KeyValueStore } from '../src/api/tokenStore';

function memoryStore(): KeyValueStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    async get(key) { return data.get(key) ?? null; },
    async set(key, value) { data.set(key, value); },
    async remove(key) { data.delete(key); },
  };
}

describe('tokenStore:设备令牌与配对地址', () => {
  it('没配过就是 null', async () => {
    const store = createTokenStore(memoryStore());
    expect(await store.load()).toBeNull();
  });
  it('存了就能整份读回来(令牌 + 地址 + 设备 id)', async () => {
    const kv = memoryStore();
    const store = createTokenStore(kv);
    await store.save({ token: 'abc', host: '10.0.0.2', port: 8791, deviceId: 'd1' });
    expect(await store.load()).toEqual({ token: 'abc', host: '10.0.0.2', port: 8791, deviceId: 'd1' });
    // 令牌不落在明文可枚举的键名里以外的地方,也不进日志——这里只验证它只写了一个键
    expect([...kv.data.keys()]).toEqual(['butler.pairing']);
  });
  it('清掉后回到 null', async () => {
    const store = createTokenStore(memoryStore());
    await store.save({ token: 'abc', host: 'h', port: 1, deviceId: 'd' });
    await store.clear();
    expect(await store.load()).toBeNull();
  });
  it('存储里是坏 JSON 或缺字段 → 当没配过,不抛', async () => {
    const kv = memoryStore();
    kv.data.set('butler.pairing', '{oops');
    expect(await createTokenStore(kv).load()).toBeNull();
    kv.data.set('butler.pairing', JSON.stringify({ token: 'x' }));
    expect(await createTokenStore(kv).load()).toBeNull();
  });
  it('底层存储抛错时读为 null、写不抛', async () => {
    const broken: KeyValueStore = {
      async get() { throw new Error('boom'); },
      async set() { throw new Error('boom'); },
      async remove() { throw new Error('boom'); },
    };
    const store = createTokenStore(broken);
    expect(await store.load()).toBeNull();
    await expect(store.save({ token: 't', host: 'h', port: 1, deviceId: 'd' })).resolves.toBeUndefined();
    await expect(store.clear()).resolves.toBeUndefined();
  });
});
