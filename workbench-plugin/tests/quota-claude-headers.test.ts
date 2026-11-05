// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { fetchClaudeHeaderQuota, parseUnifiedRateLimitHeaders } from '../src/quota/claudeHeaders.ts'

/** 真机 2026-08-21 11:31 抓到的那一组头，值原样保留——它已经和客户端逐条核对过。 */
const REAL = {
  'anthropic-ratelimit-unified-status': 'allowed',
  'anthropic-ratelimit-unified-5h-status': 'allowed',
  'anthropic-ratelimit-unified-5h-reset': '1787292000',
  'anthropic-ratelimit-unified-5h-utilization': '0.8',
  'anthropic-ratelimit-unified-7d-status': 'allowed',
  'anthropic-ratelimit-unified-7d-reset': '1787644800',
  'anthropic-ratelimit-unified-7d-utilization': '0.19',
  'anthropic-ratelimit-unified-representative-claim': 'five_hour',
}

function headersOf(map: Record<string, string>): { get: (n: string) => string | null } {
  return { get: (name: string) => map[name.toLowerCase()] ?? null }
}

function responseOf(map: Record<string, string>, status = 200): unknown {
  return { ok: status < 400, status, headers: headersOf(map), json: async () => ({}), text: async () => '' }
}

describe('parseUnifiedRateLimitHeaders', () => {
  it('真机那一组头翻出来要和客户端对得上：5h 已用 80%、周已用 19%', () => {
    const quota = parseUnifiedRateLimitHeaders(headersOf(REAL))
    expect(quota.windows).toEqual([
      { label: '5h', left_pct: 20, reset_at: new Date(1787292000_000).toISOString() },
      { label: '周', left_pct: 81, reset_at: new Date(1787644800_000).toISOString() },
    ])
  })

  it('留痕只记头名不记值', () => {
    const quota = parseUnifiedRateLimitHeaders(headersOf(REAL))
    expect(quota.note).toContain('anthropic-ratelimit-unified-5h-utilization')
    expect(quota.note).not.toContain('0.8')
  })

  it('少一个窗口也照样给——少一栏总比整格空掉强', () => {
    const { 'anthropic-ratelimit-unified-7d-utilization': _drop, ...rest } = REAL
    const quota = parseUnifiedRateLimitHeaders(headersOf(rest))
    expect(quota.windows.map(w => w.label)).toEqual(['5h'])
  })

  it('一个窗口都没有就抛错，不猜数', () => {
    expect(() => parseUnifiedRateLimitHeaders(headersOf({}))).toThrow()
  })

  it('比例超出 0–1 就当没有——上游哪天改成 0–100，不能把 80% 读成 0.8%', () => {
    expect(() => parseUnifiedRateLimitHeaders(headersOf({
      'anthropic-ratelimit-unified-5h-utilization': '80',
    }))).toThrow()
  })

  it('reset 缺了也给窗口，只是不带 reset_at', () => {
    const quota = parseUnifiedRateLimitHeaders(headersOf({
      'anthropic-ratelimit-unified-5h-utilization': '0.5',
    }))
    expect(quota.windows[0]).toEqual({ label: '5h', left_pct: 50 })
  })
})

describe('fetchClaudeHeaderQuota', () => {
  it('拿到头就返回，只发一次请求', async () => {
    const fetchImpl = vi.fn(async () => responseOf(REAL) as never)
    const quota = await fetchClaudeHeaderQuota({ token: 'T', fetch: fetchImpl })
    expect(quota.windows).toHaveLength(2)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('model 下架就换下一个——id 会随版本变', async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const model = JSON.parse(String(init?.body)).model as string
      return (model === 'A' ? responseOf({}, 404) : responseOf(REAL)) as never
    })
    const quota = await fetchClaudeHeaderQuota({ token: 'T', fetch: fetchImpl, models: ['A', 'B'] })
    expect(quota.windows).toHaveLength(2)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('429 也要把数字读出来——限流头在失败响应上也在，那时恰恰最该看', async () => {
    const fetchImpl = vi.fn(async () => responseOf(REAL, 429) as never)
    const quota = await fetchClaudeHeaderQuota({ token: 'T', fetch: fetchImpl })
    expect(quota.windows[0]?.left_pct).toBe(20)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('token 绝不出现在错误信息里', async () => {
    const fetchImpl = vi.fn(async () => responseOf({}, 401) as never)
    const error = await fetchClaudeHeaderQuota({ token: 'SECRET-abc', fetch: fetchImpl }).catch((e: Error) => e)
    expect(String(error)).not.toContain('SECRET-abc')
  })

  it('请求发不出去时也不把 fetch 的原始错误抛出去（可能带着头）', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('connect ECONNREFUSED Bearer SECRET-abc') })
    const error = await fetchClaudeHeaderQuota({ token: 'SECRET-abc', fetch: fetchImpl as never }).catch((e: Error) => e)
    expect(String(error)).not.toContain('SECRET-abc')
  })

  it('只要 1 个输出 token —— 测量本身不该吃额度', async () => {
    let sent: RequestInit | undefined
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      sent = init
      return responseOf(REAL) as never
    })
    await fetchClaudeHeaderQuota({ token: 'T', fetch: fetchImpl })
    expect(JSON.parse(String(sent?.body)).max_tokens).toBe(1)
  })
})
