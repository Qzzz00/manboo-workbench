import { describe, expect, it, vi } from 'vitest';
import {
  WORKBENCH_TOKEN_KEY,
  claimWorkbenchToken,
  isLoopbackWorkbench,
  resolveWorkbenchToken,
  withWorkbenchToken,
  workbenchHttpBase,
  type StorageLike,
} from './workbenchToken';

function memoryStorage(initial: Record<string, string> = {}): StorageLike & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    getItem: (key) => (key in data ? data[key]! : null),
    setItem: (key, value) => { data[key] = value; },
    removeItem: (key) => { delete data[key]; },
  };
}

describe('展示台的工作台令牌(2026-09-11)', () => {
  it('URL ?token= 优先,并存进 localStorage;没有就读存储;都没有是 null', () => {
    const storage = memoryStorage();
    expect(resolveWorkbenchToken('?token=abc&scale=0.9', storage)).toBe('abc');
    expect(storage.data[WORKBENCH_TOKEN_KEY]).toBe('abc');
    expect(resolveWorkbenchToken('', storage)).toBe('abc');
    expect(resolveWorkbenchToken('', memoryStorage())).toBeNull();
    expect(resolveWorkbenchToken('?token=', memoryStorage({ [WORKBENCH_TOKEN_KEY]: '' }))).toBeNull();
    expect(resolveWorkbenchToken('', undefined)).toBeNull();
  });

  it('存储抛错(隐私模式)不炸', () => {
    const broken: StorageLike = {
      getItem: () => { throw new Error('denied'); },
      setItem: () => { throw new Error('denied'); },
      removeItem: () => { throw new Error('denied'); },
    };
    expect(resolveWorkbenchToken('?token=x', broken)).toBe('x');
    expect(resolveWorkbenchToken('', broken)).toBeNull();
  });

  it('回环地址不带令牌(服务端也不看);局域网地址挂到 ?token=', () => {
    expect(isLoopbackWorkbench('ws://127.0.0.1:8791/live')).toBe(true);
    expect(isLoopbackWorkbench('ws://localhost:8791/live')).toBe(true);
    expect(isLoopbackWorkbench('ws://10.86.37.27:8791/live')).toBe(false);
    expect(withWorkbenchToken('ws://127.0.0.1:8791/live', 'abc')).toBe('ws://127.0.0.1:8791/live');
    expect(withWorkbenchToken('ws://10.86.37.27:8791/live', 'abc')).toBe('ws://10.86.37.27:8791/live?token=abc');
    expect(withWorkbenchToken('ws://10.86.37.27:8791/live', null)).toBe('ws://10.86.37.27:8791/live');
    expect(withWorkbenchToken('not a url', 'abc')).toBe('not a url');
  });

  it('ws 地址换算成 http 基址', () => {
    expect(workbenchHttpBase('ws://10.86.37.27:8791/live')).toBe('http://10.86.37.27:8791');
    expect(workbenchHttpBase('wss://mac.local:8791/live?x=1')).toBe('https://mac.local:8791');
  });

  it('claim:成功拿到令牌;失败原样转达服务端的话;连不上说人话', async () => {
    const okFetch = vi.fn(async () => ({
      ok: true, status: 200, json: async () => ({ ok: true, token: 'tok', device_id: 'd1' }),
    })) as unknown as typeof fetch;
    expect(await claimWorkbenchToken(okFetch, 'ws://10.86.37.27:8791/live', ' 004217 ', '展示台')).toEqual({ ok: true, token: 'tok', deviceId: 'd1' });
    const call = (okFetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(call[0]).toBe('http://10.86.37.27:8791/pair/claim');
    expect(JSON.parse(String(call[1].body))).toEqual({ code: '004217', device_name: '展示台', platform: 'android' });

    const badFetch = vi.fn(async () => ({
      ok: false, status: 401, json: async () => ({ error: '配对码不对或已失效' }),
    })) as unknown as typeof fetch;
    expect(await claimWorkbenchToken(badFetch, 'ws://10.86.37.27:8791/live', '1', 'x')).toEqual({ ok: false, error: '配对码不对或已失效' });

    const downFetch = vi.fn(async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch;
    expect((await claimWorkbenchToken(downFetch, 'ws://10.86.37.27:8791/live', '1', 'x')).ok).toBe(false);
  });
});
