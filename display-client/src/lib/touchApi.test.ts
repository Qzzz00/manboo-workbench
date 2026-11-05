import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchClientFlags, postCallResult } from './touchApi.ts';

// 测试环境 environment:'node' 下无 window，apiClient.setBaseUrl 是 no-op、
// getBaseUrl 恒回退到默认云端地址（见 apiClient.timeout.test.ts 同款处理）。
// 因此这里只断言路径后缀，不假设具体 baseURL。

describe('fetchClientFlags', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('GET /api/sessions/client-flags 并原样返回 inAppTouch', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ inAppTouch: true }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchClientFlags();

    expect(result).toEqual({ inAppTouch: true });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/api\/sessions\/client-flags$/);
    expect(init.method).toBe('GET');
  });

  it('网络异常时静默返回 {inAppTouch:false}', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down');
      }),
    );

    const result = await fetchClientFlags();

    expect(result).toEqual({ inAppTouch: false });
  });

  it('后端返回非 2xx 时同样静默返回 {inAppTouch:false}', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 500,
        json: async () => ({ error: 'boom' }),
      })),
    );

    const result = await fetchClientFlags();

    expect(result).toEqual({ inAppTouch: false });
  });
});

describe('postCallResult', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('POST /api/sessions/:avatarId/call-result 携带 {id,result}', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    await postCallResult('avatar-1', 'msg-1', 'accepted');

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/api\/sessions\/avatar-1\/call-result$/);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ id: 'msg-1', result: 'accepted' });
  });

  it('avatarId 做 URI 编码', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    await postCallResult('a b', 'id1', 'declined');

    const [url] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/api\/sessions\/a%20b\/call-result$/);
  });

  it('网络异常时静默吞掉错误，不抛出', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down');
      }),
    );

    await expect(postCallResult('avatar-1', 'msg-1', 'timeout')).resolves.toBeUndefined();
  });

  it('后端返回非 2xx 时同样静默', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 404,
        json: async () => ({ error: 'not found' }),
      })),
    );

    await expect(postCallResult('avatar-1', 'msg-1', 'declined')).resolves.toBeUndefined();
  });
});
