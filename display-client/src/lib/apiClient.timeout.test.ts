import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { apiFetch, ApiNetworkError, setBaseUrl } from './apiClient.ts';

/**
 * 让 mock fetch 返回一个「永不 resolve，但监听 signal」的响应。
 * 当传入的 AbortSignal 被 abort 时，reject 一个 name==='AbortError' 的错误，
 * 模拟真实 fetch 在 abort 时的行为。
 */
function makeHangingFetch() {
  return vi.fn((_url: string, init?: RequestInit) => {
    return new Promise((_resolve, reject) => {
      const signal = init?.signal;
      if (signal) {
        if (signal.aborted) {
          const err = new Error('The operation was aborted.');
          err.name = 'AbortError';
          reject(err);
          return;
        }
        signal.addEventListener('abort', () => {
          const err = new Error('The operation was aborted.');
          err.name = 'AbortError';
          reject(err);
        });
      }
      // 否则永不 settle
    });
  });
}

describe('apiFetch 超时', () => {
  beforeEach(() => {
    // 配置一个 baseUrl，避免走「后端地址未配置」分支
    setBaseUrl('http://test.local');
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('fetch 永不 resolve 时，默认 60s 超时后 reject 为 ApiNetworkError 且消息含「超时」', async () => {
    vi.stubGlobal('fetch', makeHangingFetch());

    const promise = apiFetch('/api/anything');
    // 立即挂上 catch，避免 unhandled rejection
    const caught = promise.catch((e) => e);

    // 推进到默认超时之后
    await vi.advanceTimersByTimeAsync(60000);

    const err = await caught;
    expect(err).toBeInstanceOf(ApiNetworkError);
    expect(String((err as Error).message)).toContain('超时');
  });

  it('传入的 timeoutMs 生效（自定义较短超时）', async () => {
    vi.stubGlobal('fetch', makeHangingFetch());

    const caught = apiFetch('/api/anything', { timeoutMs: 1000 }).catch((e) => e);

    // 未到超时前，仍 pending —— 推进 999ms 不应触发
    await vi.advanceTimersByTimeAsync(999);
    // 再推进 1ms 越过阈值
    await vi.advanceTimersByTimeAsync(1);

    const err = await caught;
    expect(err).toBeInstanceOf(ApiNetworkError);
    expect(String((err as Error).message)).toContain('超时');
  });

  it('timeoutMs: 0 时不因超时中断（长时间推进后仍 pending）', async () => {
    vi.stubGlobal('fetch', makeHangingFetch());

    let settled = false;
    apiFetch('/api/stream', { timeoutMs: 0 }).then(
      () => { settled = true; },
      () => { settled = true; },
    );

    // 推进远超默认超时，仍不应 settle
    await vi.advanceTimersByTimeAsync(600000);
    expect(settled).toBe(false);
  });

  it('正常快速返回时不受超时影响', async () => {
    const fastFetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ hello: 'world' }),
    }));
    vi.stubGlobal('fetch', fastFetch);

    const data = await apiFetch('/api/ok');
    expect(data).toEqual({ hello: 'world' });
  });
});
