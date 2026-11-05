import { describe, it, expect, beforeEach } from 'vitest';
import { addUnread, clearUnread, getUnreadCount, subscribeUnread } from './journeyStore.ts';

/**
 * 测试环境为 node（非 jsdom），全局无 localStorage，需自行打一个内存版 polyfill，
 * 以便验证 journeyStore 现有的「localStorage 持久化」语义（同 readState/writeState 一致）。
 */
function installLocalStorageStub() {
  const store = new Map<string, string>();
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => {
      store.clear();
    },
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    get length() {
      return store.size;
    },
  } as Storage;
}

describe('journeyStore 未读计数', () => {
  beforeEach(() => {
    installLocalStorageStub();
  });

  it('addUnread 对同一 avatarId 累加计数', () => {
    addUnread('rattan');
    addUnread('rattan');
    expect(getUnreadCount()).toBe(2);
  });

  it('addUnread 对不同 avatarId 分别计数，getUnreadCount 返回全部角色总和', () => {
    addUnread('rattan');
    addUnread('yumi');
    addUnread('yumi');
    expect(getUnreadCount()).toBe(3);
  });

  it('clearUnread 只清除指定 avatarId 的未读，不影响其他角色', () => {
    addUnread('rattan');
    addUnread('yumi');
    clearUnread('rattan');
    expect(getUnreadCount()).toBe(1);
  });

  it('初始状态 getUnreadCount 为 0', () => {
    expect(getUnreadCount()).toBe(0);
  });

  it('clearUnread 对没有未读的 avatarId 调用不报错，且不影响其他计数', () => {
    addUnread('yumi');
    expect(() => clearUnread('unknown-avatar')).not.toThrow();
    expect(getUnreadCount()).toBe(1);
  });

  it('subscribeUnread 在 addUnread 时触发监听回调', () => {
    let calls = 0;
    const unsubscribe = subscribeUnread(() => {
      calls += 1;
    });
    addUnread('rattan');
    expect(calls).toBe(1);
    unsubscribe();
  });

  it('subscribeUnread 在 clearUnread 时触发监听回调', () => {
    addUnread('rattan');
    let calls = 0;
    const unsubscribe = subscribeUnread(() => {
      calls += 1;
    });
    clearUnread('rattan');
    expect(calls).toBe(1);
    unsubscribe();
  });

  it('取消订阅后不再收到通知', () => {
    let calls = 0;
    const unsubscribe = subscribeUnread(() => {
      calls += 1;
    });
    unsubscribe();
    addUnread('rattan');
    expect(calls).toBe(0);
  });
});
