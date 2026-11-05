import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { CurrentBeat } from '../types/journey.ts';

// journeyStore 只从 apiClient 取 apiGet；用 mock 拦截网络，验证懒刷新的请求次数与容错行为。
vi.mock('./apiClient.ts', () => ({ apiGet: vi.fn() }));

import { apiGet } from './apiClient.ts';
import {
  fetchCurrentBeatIfStale,
  getCurrentBeat,
  getCurrentBeatFetchedAt,
} from './journeyStore.ts';

const mockedApiGet = vi.mocked(apiGet);

/**
 * 测试环境为 node（非 jsdom），全局无 localStorage，需自行打一个内存版 polyfill，
 * 与 journeyStore 的 readState/writeState 语义一致（否则 fetchedAt 无法持久化，dedup 失效）。
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

function makeBeat(id: string): CurrentBeat {
  return { id, name: `beat-${id}`, emotion_state: 'calm', status: 'in_progress' };
}

describe('journeyStore 节拍懒刷新 fetchCurrentBeatIfStale', () => {
  beforeEach(() => {
    installLocalStorageStub();
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-15T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('缓存新鲜时不发请求（60s 内复用缓存）', async () => {
    mockedApiGet.mockResolvedValue({ beat: makeBeat('b1') });

    await fetchCurrentBeatIfStale('yumi');
    expect(mockedApiGet).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(30_000); // 30s < 60s，仍新鲜
    await fetchCurrentBeatIfStale('yumi');
    expect(mockedApiGet).toHaveBeenCalledTimes(1);
  });

  it('缓存过期时重新发请求，成功后 fetchedAt 更新', async () => {
    mockedApiGet.mockResolvedValue({ beat: makeBeat('b1') });

    await fetchCurrentBeatIfStale('yumi');
    const firstFetchedAt = getCurrentBeatFetchedAt('yumi');
    expect(firstFetchedAt).not.toBeNull();

    vi.advanceTimersByTime(61_000); // 超过 60s，缓存过期
    await fetchCurrentBeatIfStale('yumi');
    expect(mockedApiGet).toHaveBeenCalledTimes(2);

    const secondFetchedAt = getCurrentBeatFetchedAt('yumi');
    expect(secondFetchedAt).not.toBeNull();
    expect(secondFetchedAt!).toBeGreaterThan(firstFetchedAt!);
  });

  it('网络失败时返回旧缓存，不清空', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockedApiGet.mockResolvedValueOnce({ beat: makeBeat('b1') });

    await fetchCurrentBeatIfStale('yumi');
    expect(getCurrentBeat('yumi')).toEqual(makeBeat('b1'));

    vi.advanceTimersByTime(61_000);
    mockedApiGet.mockRejectedValueOnce(new Error('network down'));

    const beat = await fetchCurrentBeatIfStale('yumi');
    expect(beat).toEqual(makeBeat('b1')); // 静默降级到旧缓存
    expect(getCurrentBeat('yumi')).toEqual(makeBeat('b1')); // 缓存未被清空
  });
});
