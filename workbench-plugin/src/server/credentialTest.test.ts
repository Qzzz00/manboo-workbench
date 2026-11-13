import { describe, expect, it, vi } from 'vitest';
import {
  CREDENTIAL_TEST_COPY, credentialTestWords, testDeepSeekKey,
} from './credentialTest.ts';

function response(status: number): Response {
  return { status, ok: status >= 200 && status < 300 } as Response;
}

describe('测试连接:状态码翻成人话', () => {
  it('401 说「Key 不对或没复制全」,402 说「余额不足」,两者不混', () => {
    const unauthorized = credentialTestWords(401);
    const poor = credentialTestWords(402);
    expect(unauthorized.ok).toBe(false);
    expect(unauthorized.message).toBe(CREDENTIAL_TEST_COPY.invalidKey);
    expect(unauthorized.message).toContain('复制');
    expect(poor.message).toBe(CREDENTIAL_TEST_COPY.noBalance);
    expect(poor.message).toContain('余额不足');
    expect(poor.message).not.toBe(unauthorized.message);
  });

  it('2xx 一律算接上', () => {
    expect(credentialTestWords(200).ok).toBe(true);
    expect(credentialTestWords(201).ok).toBe(true);
    expect(credentialTestWords(200).message).toBe(CREDENTIAL_TEST_COPY.ok);
  });

  it('其余常见码各有说法,不出现原始状态码', () => {
    for (const status of [400, 403, 422, 429, 500, 503, 418]) {
      const result = credentialTestWords(status);
      expect(result.ok).toBe(false);
      expect(result.message).not.toContain(String(status));
      expect(result.message.length).toBeGreaterThan(4);
    }
    expect(credentialTestWords(429).message).toBe(CREDENTIAL_TEST_COPY.tooMany);
    expect(credentialTestWords(503).message).toBe(CREDENTIAL_TEST_COPY.upstreamBusy);
    expect(credentialTestWords(418).message).toBe(CREDENTIAL_TEST_COPY.unknown);
  });

  it('连不上 / 超时说「检查网络」,不抛底层错误', () => {
    const result = credentialTestWords('network');
    expect(result.ok).toBe(false);
    expect(result.message).toBe(CREDENTIAL_TEST_COPY.network);
    expect(result.status).toBe('network');
  });
});

describe('测试连接:发一次最小请求', () => {
  it('空 Key 不发请求', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const result = await testDeepSeekKey({ key: '   ', fetchImpl });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
  });

  it('用预置的地址与模型名,Key 只放在 Authorization 里', async () => {
    const calls: { url: string, init: RequestInit }[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init: init ?? {} });
      return response(200);
    }) as unknown as typeof fetch;

    const result = await testDeepSeekKey({ key: '  sk-abc123  ', fetchImpl });
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.deepseek.com/v1/chat/completions');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer sk-abc123');
    const body = JSON.parse(String(calls[0]!.init.body)) as { model: string, max_tokens: number, messages: unknown[] };
    expect(body.model).toBe('deepseek-v4-flash');
    expect(body.max_tokens).toBe(1);
    expect(body.messages).toHaveLength(1);
    // 请求体里不许出现 Key 本身
    expect(String(calls[0]!.init.body)).not.toContain('sk-abc123');
  });

  it('401 / 402 从上游一路翻成人话', async () => {
    const unauthorized = vi.fn(async () => response(401)) as unknown as typeof fetch;
    expect((await testDeepSeekKey({ key: 'sk-bad', fetchImpl: unauthorized })).message)
      .toBe(CREDENTIAL_TEST_COPY.invalidKey);
    const poor = vi.fn(async () => response(402)) as unknown as typeof fetch;
    expect((await testDeepSeekKey({ key: 'sk-good', fetchImpl: poor })).message)
      .toBe(CREDENTIAL_TEST_COPY.noBalance);
  });

  it('网络异常收敛成「连不上」,且不带出底层错误文本', async () => {
    const broken = vi.fn(async () => { throw new Error('fetch failed sk-leaked') }) as unknown as typeof fetch;
    const result = await testDeepSeekKey({ key: 'sk-leaked', fetchImpl: broken });
    expect(result.message).toBe(CREDENTIAL_TEST_COPY.network);
    expect(result.message).not.toContain('sk-leaked');
  });

  it('地址末尾有斜杠不会拼出 //chat', async () => {
    let seen = '';
    const fetchImpl = vi.fn(async (url: string) => { seen = url; return response(200) }) as unknown as typeof fetch;
    await testDeepSeekKey({ key: 'sk-x', baseUrl: 'https://api.deepseek.com/v1/', fetchImpl });
    expect(seen).toBe('https://api.deepseek.com/v1/chat/completions');
  });
});
