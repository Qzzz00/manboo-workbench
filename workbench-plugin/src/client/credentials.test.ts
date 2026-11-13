/**
 * 浏览器侧凭据数据层里新增的「一键测试连接」(2026-11-12)。
 *
 * 这一层只做两件事:把草稿 Key 送到本机的 /credentials/test、把「成没成 + 一句人话」
 * 带回来。任何底层异常都换成本文件自己的话 —— 底层错误可能把请求体(含 Key)带出来。
 */
import { describe, expect, it, vi } from 'vitest';
import { fetchAiSourceConfigured, testCredentialConnection } from './credentials.ts';

const BASE = 'http://127.0.0.1:8791';
const KEY = 'sk-draft-123456';

function response(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as Response;
}

describe('测试连接:只送草稿 Key,只认回包里的人话', () => {
  it('POST 到 /credentials/test,请求体只有 key', async () => {
    const fetchImpl = vi.fn(async () => response({ ok: true, message: '接上了' })) as unknown as typeof fetch;
    const result = await testCredentialConnection(BASE, KEY, fetchImpl);
    expect(result).toEqual({ ok: true, message: '接上了' });
    const [url, init] = vi.mocked(fetchImpl).mock.calls[0]!;
    expect(url).toBe(`${BASE}/credentials/test`);
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ key: KEY });
  });

  it('连不上工作台服务:说人话,不带底层错误', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error(`boom ${KEY}`) }) as unknown as typeof fetch;
    const result = await testCredentialConnection(BASE, KEY, fetchImpl);
    expect(result.ok).toBe(false);
    expect(result.message).not.toContain(KEY);
    expect(result.message).not.toContain('boom');
  });

  it('接口非 2xx / 回包不是 JSON / 回包缺字段,一律收敛成一句能照着做的话', async () => {
    const cases: (typeof fetch)[] = [
      vi.fn(async () => response({}, false, 500)) as unknown as typeof fetch,
      vi.fn(async () => ({ ok: true, status: 200, json: async () => { throw new Error('bad json') } })) as unknown as typeof fetch,
      vi.fn(async () => response({ ok: 'yes', message: 123 })) as unknown as typeof fetch,
    ];
    for (const fetchImpl of cases) {
      const result = await testCredentialConnection(BASE, KEY, fetchImpl);
      expect(result.ok).toBe(false);
      expect(result.message.length).toBeGreaterThan(4);
      expect(result.message).not.toContain(KEY);
    }
  });

  it('服务端说没成(401 / 402 已翻好):把那句人话原样交给界面', async () => {
    const fetchImpl = vi.fn(async () => response({ ok: false, message: '账户余额不足' })) as unknown as typeof fetch;
    const result = await testCredentialConnection(BASE, KEY, fetchImpl);
    expect(result).toEqual({ ok: false, message: '账户余额不足' });
  });
});

/**
 * 启动探测(2026-11-13)的严格口径:只认长得像凭据状态的回包。
 * 这一层是拦路的,「问不到」绝不能当成「没配」。
 */
describe('启动探测:没配 / 配了 / 问不到,三种结论不混', () => {
  it('明确没配:回 false', async () => {
    const fetchImpl = vi.fn(async () => response({ deepseek: { configured: false } })) as unknown as typeof fetch;
    expect(await fetchAiSourceConfigured(BASE, fetchImpl)).toBe(false);
  });

  it('明确配了:回 true', async () => {
    const fetchImpl = vi.fn(async () => response({ deepseek: { configured: true } })) as unknown as typeof fetch;
    expect(await fetchAiSourceConfigured(BASE, fetchImpl)).toBe(true);
  });

  it('只 GET /credentials,不带任何请求体、不碰 Key', async () => {
    const fetchImpl = vi.fn(async () => response({ deepseek: { configured: true } })) as unknown as typeof fetch;
    await fetchAiSourceConfigured(BASE, fetchImpl);
    const [url, init] = vi.mocked(fetchImpl).mock.calls[0]!;
    expect(url).toBe(`${BASE}/credentials`);
    expect(init?.method ?? 'GET').toBe('GET');
    expect(init?.body).toBeUndefined();
  });

  it('问不到一律 undefined:服务没起 / 非 2xx / JSON 坏 / 结构不对 / 测试桩回状态快照', async () => {
    const cases: (typeof fetch)[] = [
      vi.fn(async () => { throw new Error('ECONNREFUSED') }) as unknown as typeof fetch,
      vi.fn(async () => response({}, false, 502)) as unknown as typeof fetch,
      vi.fn(async () => ({ ok: true, status: 200, json: async () => { throw new Error('bad json') } })) as unknown as typeof fetch,
      vi.fn(async () => response({ agents: [], sessions: [], now: '2026-11-13' })) as unknown as typeof fetch,
      vi.fn(async () => response({ deepseek: true })) as unknown as typeof fetch,
      vi.fn(async () => response({ deepseek: { configured: 'yes' } })) as unknown as typeof fetch,
      vi.fn(async () => response(null)) as unknown as typeof fetch,
    ];
    for (const fetchImpl of cases) {
      expect(await fetchAiSourceConfigured(BASE, fetchImpl)).toBeUndefined();
    }
  });

  it('和宽松版不同:宽松版服务没起回全 false,这一版回 undefined', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('offline') }) as unknown as typeof fetch;
    expect(await fetchAiSourceConfigured(BASE, fetchImpl)).toBeUndefined();
  });
});
