import { describe, expect, it, vi } from 'vitest';
import { createApiClient } from '../src/api/client';

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

const pairing = { token: 'tok-1', host: '10.0.0.2', port: 8791, deviceId: 'd1' };

describe('api client:每个请求带 Bearer,401 回到配对页', () => {
  it('GET 带 Authorization 头,地址拼在 http://host:port 上', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { now: 'x' }));
    const client = createApiClient({ pairing, fetchImpl, onUnauthorized: () => {} });
    const result = await client.json<{ now: string }>('/state');
    expect(result).toEqual({ ok: true, status: 200, data: { now: 'x' } });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://10.0.0.2:8791/state');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer tok-1');
  });

  it('POST JSON 带 content-type 与 body', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { ok: true, id: 't-1' }));
    const client = createApiClient({ pairing, fetchImpl, onUnauthorized: () => {} });
    await client.json('/butler/item', { method: 'POST', body: { text: '你好' } });
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.method).toBe('POST');
    expect(new Headers(init.headers).get('content-type')).toBe('application/json');
    expect(init.body).toBe(JSON.stringify({ text: '你好' }));
  });

  it('401 → 调 onUnauthorized 一次,并把服务端那句话原样带回', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(401, { error: '需要设备令牌:先在工作台设置里配对' }));
    const onUnauthorized = vi.fn();
    const client = createApiClient({ pairing, fetchImpl, onUnauthorized });
    const a = await client.json('/state');
    const b = await client.json('/state');
    expect(a).toEqual({ ok: false, status: 401, kind: 'unauthorized', error: '需要设备令牌:先在工作台设置里配对' });
    expect(b.ok).toBe(false);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it('503 → kind=unavailable(本机没配语音那类),不算掉线', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(503, { error: '本机后端没有配语音' }));
    const client = createApiClient({ pairing, fetchImpl, onUnauthorized: () => {} });
    expect(await client.json('/butler/proxy/api/tts', { method: 'POST', body: { text: 'x' } }))
      .toEqual({ ok: false, status: 503, kind: 'unavailable', error: '本机后端没有配语音' });
  });

  it('网络错误 → kind=network,文案说清是连不上工作台', async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
    const client = createApiClient({ pairing, fetchImpl, onUnauthorized: () => {} });
    const result = await client.json('/state');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe('network');
      expect(result.error).toContain('连不上工作台');
    }
  });

  it('其它 4xx/5xx → kind=http,body 没有 error 时给状态码', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 500 }));
    const client = createApiClient({ pairing, fetchImpl, onUnauthorized: () => {} });
    expect(await client.json('/state')).toEqual({ ok: false, status: 500, kind: 'http', error: '请求失败(500)' });
  });

  it('blob():拿音频这类二进制,同样带令牌、同样认 401/503', async () => {
    const fetchImpl = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'audio/mpeg' } }));
    const client = createApiClient({ pairing, fetchImpl, onUnauthorized: () => {} });
    const result = await client.blob('/butler/proxy/api/tts', { method: 'POST', body: { text: '你好' } });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.type).toBe('audio/mpeg');
      expect(result.data.size).toBe(3);
    }
  });

  it('令牌不出现在 URL 里', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, {}));
    const client = createApiClient({ pairing, fetchImpl, onUnauthorized: () => {} });
    await client.json('/state');
    const [url] = fetchImpl.mock.calls[0] as unknown as [string];
    expect(url).not.toContain('tok-1');
  });
});
