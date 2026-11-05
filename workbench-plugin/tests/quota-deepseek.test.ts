import { describe, expect, it } from 'vitest'
import { fetchDeepSeekBalance, type FetchLike } from '../src/quota/deepseek.ts'

const FAKE_KEY = 'sk-test-fake-key-not-real'

/** 造一个只回放固定响应的 fetch，测试绝不允许打真实网络。 */
function stubFetch(
  response: { status?: number, body?: unknown, throws?: Error },
  calls: { url?: string, init?: RequestInit }[] = [],
): FetchLike {
  return async (url, init) => {
    calls.push({ url: String(url), ...(init ? { init } : {}) })
    if (response.throws) throw response.throws
    const status = response.status ?? 200
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => response.body,
      text: async () => JSON.stringify(response.body ?? ''),
    }
  }
}

const OK_BODY = {
  is_available: true,
  balance_infos: [
    { currency: 'CNY', total_balance: '218.40', granted_balance: '10.00', topped_up_balance: '208.40' },
    { currency: 'USD', total_balance: '30.11', granted_balance: '0.00', topped_up_balance: '30.11' },
  ],
}

describe('fetchDeepSeekBalance', () => {
  it('用 Bearer 头请求官方 GET /user/balance', async () => {
    const calls: { url?: string, init?: RequestInit }[] = []
    await fetchDeepSeekBalance({ apiKey: FAKE_KEY, fetch: stubFetch({ body: OK_BODY }, calls) })

    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('https://api.deepseek.com/user/balance')
    expect(calls[0]?.init?.method).toBe('GET')
    const headers = calls[0]?.init?.headers as Record<string, string>
    expect(headers.Authorization).toBe(`Bearer ${FAKE_KEY}`)
  })

  it('产出 BalanceQuota：币种 + 总余额 + 可用标志', async () => {
    const quota = await fetchDeepSeekBalance({ apiKey: FAKE_KEY, fetch: stubFetch({ body: OK_BODY }) })

    expect(quota).toEqual({
      kind: 'balance',
      currency: 'CNY',
      total: '218.40',
      available: true,
    })
  })

  it('按 preferredCurrency 选择币种，取不到就退回第一条', async () => {
    const usd = await fetchDeepSeekBalance({
      apiKey: FAKE_KEY,
      fetch: stubFetch({ body: OK_BODY }),
      preferredCurrency: 'USD',
    })
    expect(usd.currency).toBe('USD')
    expect(usd.total).toBe('30.11')

    const fallback = await fetchDeepSeekBalance({
      apiKey: FAKE_KEY,
      fetch: stubFetch({ body: OK_BODY }),
      preferredCurrency: 'JPY',
    })
    expect(fallback.currency).toBe('CNY')
  })

  it('is_available 为 false 时如实标记不可用', async () => {
    const quota = await fetchDeepSeekBalance({
      apiKey: FAKE_KEY,
      fetch: stubFetch({
        body: { is_available: false, balance_infos: [{ currency: 'CNY', total_balance: '0.00' }] },
      }),
    })

    expect(quota.available).toBe(false)
    expect(quota.total).toBe('0.00')
  })

  it('没有 balance_infos 时不编造余额，直接报错', async () => {
    await expect(fetchDeepSeekBalance({
      apiKey: FAKE_KEY,
      fetch: stubFetch({ body: { is_available: true, balance_infos: [] } }),
    })).rejects.toThrow(/balance_infos/)
  })

  it('HTTP 失败时抛错，且错误信息里不出现 API Key', async () => {
    const error = await fetchDeepSeekBalance({
      apiKey: FAKE_KEY,
      fetch: stubFetch({ status: 401, body: { error: 'unauthorized' } }),
    }).catch((err: unknown) => err as Error) as Error

    expect(error).toBeInstanceOf(Error)
    expect(error.message).toContain('401')
    expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain(FAKE_KEY)
  })

  it('网络异常向上抛出，且不泄漏 API Key', async () => {
    const error = await fetchDeepSeekBalance({
      apiKey: FAKE_KEY,
      fetch: stubFetch({ throws: new Error('connect ECONNREFUSED') }),
    }).catch((err: unknown) => err as Error) as Error

    expect(error.message).not.toContain(FAKE_KEY)
  })
})
