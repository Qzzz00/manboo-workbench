import { describe, it, expect, beforeEach } from 'vitest';
import { isSoullinkEmotionEnabled, setSoullinkEmotionEnabled } from './emotionFlag.ts';

/**
 * 测试环境为 node（非 jsdom），全局无 localStorage，需自行打一个内存版 polyfill，
 * 以验证开关的读写语义（与 emotionFlag 里的 localStorage 用法一致）。
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
    key: () => null,
    length: 0,
  } as Storage;
}

describe('emotionFlag', () => {
  beforeEach(() => installLocalStorageStub());
  it('默认关', () => expect(isSoullinkEmotionEnabled()).toBe(false));
  it('可开可关', () => {
    setSoullinkEmotionEnabled(true);
    expect(isSoullinkEmotionEnabled()).toBe(true);
    setSoullinkEmotionEnabled(false);
    expect(isSoullinkEmotionEnabled()).toBe(false);
  });
});
