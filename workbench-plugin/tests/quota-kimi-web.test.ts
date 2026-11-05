import { describe, expect, it } from 'vitest'
import type { FetchLike } from '../src/quota/deepseek.ts'
import { fetchKimiWebUsage, fetchKimiWebUsageWithRefresh, refreshKimiToken } from '../src/quota/kimiWeb.ts'

const AUTH = 'Bearer not-a-real-token'

function reply(body: unknown, ok = true, status = 200): FetchLike {
  return async () => ({ ok, status, json: async () => body, text: async () => '' })
}

/** 2026-08-20 从他登录着的网页端实抓的响应结构（值已换成同形状的假数据）。 */
const real = {
  ratelimitCode5h: { ratio: 0.011, enabled: true, resetTime: '2026-08-20T08:21:37.890847624Z' },
  ratelimitCode7d: { ratio: 0.5287, enabled: true, resetTime: '2026-08-20T12:21:37.890847624Z' },
  subscriptionBalance: {
    amountUsedRatio: 0.9463,
    kimiCodeUsedRatio: 0.5057,
    expireTime: '2026-08-30T00:00:00Z',
  },
}

describe('fetchKimiWebUsage', () => {
  it('三档都按剩余显示，总量排最前——它才是先见底的那个', async () => {
    const quota = await fetchKimiWebUsage({ authorization: AUTH, fetch: reply(real) })

    expect(quota.windows.map(w => w.label)).toEqual(['总', '5h', '周'])
    expect(quota.windows[0]?.left_pct).toBe(5.4)
    expect(quota.windows[1]?.left_pct).toBe(98.9)
    expect(quota.windows[2]?.left_pct).toBe(47.1)
  })

  it('重置时间原样带出来，界面据此说"何时恢复"', async () => {
    const quota = await fetchKimiWebUsage({ authorization: AUTH, fetch: reply(real) })

    expect(quota.windows[0]?.reset_at).toBe('2026-08-30T00:00:00Z')
    expect(quota.windows[1]?.reset_at).toBe('2026-08-20T08:21:37.890847624Z')
  })

  it('打到 MembershipService 那个口子，带 authorization 与 connect 协议头', async () => {
    let url = ''
    let headers: Record<string, string> = {}
    await fetchKimiWebUsage({
      authorization: AUTH,
      fetch: async (u, init) => {
        url = u
        headers = (init?.headers ?? {}) as Record<string, string>
        return reply(real)(u, init)
      },
    })

    expect(url).toContain('MembershipService/GetSubscriptionStats')
    expect(headers.authorization).toBe(AUTH)
    expect(headers['connect-protocol-version']).toBe('1')
  })

  it('登录态过期回 401 时说人话，且不回显 token', async () => {
    await expect(fetchKimiWebUsage({ authorization: AUTH, fetch: reply({}, false, 401) }))
      .rejects.toThrow(/登录/)
    await expect(fetchKimiWebUsage({ authorization: AUTH, fetch: reply({}, false, 401) }))
      .rejects.not.toThrow(/not-a-real-token/)
  })

  it('认不出的结构报顶层字段名，绝不带值', async () => {
    const weird = { data: { secret: 'MUST-NOT-LEAK' }, code: 0 }

    await expect(fetchKimiWebUsage({ authorization: AUTH, fetch: reply(weird) }))
      .rejects.toThrow(/data|code/)
    await expect(fetchKimiWebUsage({ authorization: AUTH, fetch: reply(weird) }))
      .rejects.not.toThrow(/MUST-NOT-LEAK/)
  })

  it('某一档缺失时给出剩下的，不整条作废', async () => {
    const quota = await fetchKimiWebUsage({
      authorization: AUTH,
      fetch: reply({ subscriptionBalance: { amountUsedRatio: 0.5 } }),
    })

    expect(quota.windows).toHaveLength(1)
    expect(quota.windows[0]).toMatchObject({ label: '总', left_pct: 50 })
  })

  it('缺哪一档要留痕——一栏静默消失和"接口改了"在界面上分不出来', async () => {
    // 真机上「周」在 20:21 重置之后就从响应里消失了，界面凭空少一栏，
    // 结果往"接口是不是变了"的方向白查了一轮。
    const quota = await fetchKimiWebUsage({
      authorization: AUTH,
      fetch: reply({ subscriptionBalance: { amountUsedRatio: 0.5 } }),
    })

    expect(quota.note).toContain('5h')
    expect(quota.note).toContain('周')
    expect(quota.note).toContain('顶层没有 ratelimitCode5h')
  })

  it('没有 ratio 且对象里再无数字 = 这一轮没用量，补成剩 100%', async () => {
    // 真机实测：窗口没用量时上游干脆不给 ratio，只留 enabled 和 resetTime。
    const quota = await fetchKimiWebUsage({
      authorization: AUTH,
      fetch: reply({
        ...real,
        ratelimitCode7d: { enabled: true, resetTime: '2026-08-27T00:00:00Z' },
      }),
    })

    expect(quota.windows).toContainEqual({
      label: '周',
      left_pct: 100,
      reset_at: '2026-08-27T00:00:00Z',
    })
    expect(quota.note).toBeUndefined()
  })

  it('对象里还有别的数字就不认——那更像接口改了名，猜错方向等于在见底时报平安', async () => {
    const quota = await fetchKimiWebUsage({
      authorization: AUTH,
      fetch: reply({
        ...real,
        ratelimitCode7d: { enabled: true, usedRatio: 0.93, resetTime: '2026-08-27T00:00:00Z' },
      }),
    })

    expect(quota.windows.some(w => w.label === '周')).toBe(false)
    expect(quota.note).toContain('周(ratelimitCode7d 里有：enabled, usedRatio, resetTime)')
  })

  it('留痕只记字段名，不记值——响应里夹带账号 id 之类的东西', async () => {
    const quota = await fetchKimiWebUsage({
      authorization: AUTH,
      fetch: reply({ subscriptionBalance: { amountUsedRatio: 0.5 }, userId: 'ben-12345' }),
    })

    expect(quota.note).toContain('ratelimitCode5h')
    expect(quota.note).not.toContain('ben-12345')
  })

  it('三档齐全时不留痕，别拿废话占地方', async () => {
    const quota = await fetchKimiWebUsage({ authorization: AUTH, fetch: reply(real) })

    expect(quota.note).toBeUndefined()
  })

  it('ratio 为 0 不算缺失——归零是合法数字，不该被当成没返回', async () => {
    const quota = await fetchKimiWebUsage({
      authorization: AUTH,
      fetch: reply({ ...real, ratelimitCode7d: { ratio: 0, resetTime: '2026-08-27T00:00:00Z' } }),
    })

    expect(quota.windows).toContainEqual(
      expect.objectContaining({ label: '周', left_pct: 100 }),
    )
    expect(quota.note).toBeUndefined()
  })

  it('结果里不出现 token', async () => {
    const quota = await fetchKimiWebUsage({ authorization: AUTH, fetch: reply(real) })

    expect(JSON.stringify(quota)).not.toContain('not-a-real-token')
  })
})

/**
 * 续期。
 *
 * 接口、请求体、响应体都是 2026-08-20 从他登录着的网页端**实抓**的（值换成同形状的假数据）：
 *   POST https://auth.kimi.com/api/account.gateway.v1.AuthService/RefreshToken
 *   请求 { refresh_token }   ← snake_case
 *   响应 { accessToken, refreshToken }   ← camelCase
 * 这个不对称正是不能靠猜的理由。
 */
const REFRESH = 'not-a-real-refresh-token'
const REFRESHED = { accessToken: 'fresh-access', refreshToken: 'rotated-refresh' }

describe('refreshKimiToken', () => {
  it('打到 auth.kimi.com 的 RefreshToken，请求体用 snake_case，带 connect 协议头且不带 authorization', async () => {
    let url = ''
    let init: { headers?: Record<string, string>, body?: string } = {}
    await refreshKimiToken({
      refreshToken: REFRESH,
      fetch: async (u, i) => {
        url = u
        init = (i ?? {}) as typeof init
        return reply(REFRESHED)(u, i)
      },
    })

    expect(url).toBe('https://auth.kimi.com/api/account.gateway.v1.AuthService/RefreshToken')
    expect(JSON.parse(init.body ?? '{}')).toEqual({ refresh_token: REFRESH })
    expect(init.headers?.['connect-protocol-version']).toBe('1')
    expect(init.headers?.authorization).toBeUndefined()
  })

  it('响应的 camelCase 两个字段都取出来', async () => {
    const got = await refreshKimiToken({ refreshToken: REFRESH, fetch: reply(REFRESHED) })

    expect(got).toEqual({ accessToken: 'fresh-access', refreshToken: 'rotated-refresh' })
  })

  it('续期失败时说人话，且不回显 refresh token', async () => {
    await expect(refreshKimiToken({ refreshToken: REFRESH, fetch: reply({}, false, 401) }))
      .rejects.toThrow(/登录/)
    await expect(refreshKimiToken({ refreshToken: REFRESH, fetch: reply({}, false, 401) }))
      .rejects.not.toThrow(/not-a-real-refresh-token/)
  })

  it('响应缺字段时报错，不返回半份凭证', async () => {
    await expect(refreshKimiToken({ refreshToken: REFRESH, fetch: reply({ accessToken: 'x' }) }))
      .rejects.toThrow()
  })
})

describe('fetchKimiWebUsageWithRefresh', () => {
  /** 先续期、再取数：按调用顺序把两次请求都记下来。 */
  function twoStep(statsBody: unknown = real) {
    const calls: { url: string, headers: Record<string, string>, body?: string | undefined }[] = []
    const fetchImpl: FetchLike = async (u, i) => {
      const init = (i ?? {}) as { headers?: Record<string, string>, body?: string }
      calls.push({ url: u, headers: init.headers ?? {}, body: init.body })
      return u.includes('RefreshToken')
        ? reply(REFRESHED)(u, i)
        : reply(statsBody)(u, i)
    }
    return { calls, fetchImpl }
  }

  it('★先续期再取数：15 分钟的 access token 不再当长期凭据存', async () => {
    const { calls, fetchImpl } = twoStep()

    await fetchKimiWebUsageWithRefresh({ refreshToken: REFRESH, fetch: fetchImpl })

    expect(calls).toHaveLength(2)
    expect(calls[0]?.url).toContain('RefreshToken')
    expect(calls[1]?.url).toContain('GetSubscriptionStats')
  })

  it('取数用刚换来的 access token，拼成 Bearer', async () => {
    const { calls, fetchImpl } = twoStep()

    await fetchKimiWebUsageWithRefresh({ refreshToken: REFRESH, fetch: fetchImpl })

    expect(calls[1]?.headers.authorization).toBe('Bearer fresh-access')
  })

  it('★轮换出来的新 refresh token 必须回存，否则下次就用不了了', async () => {
    const { fetchImpl } = twoStep()
    const saved: string[] = []

    await fetchKimiWebUsageWithRefresh({
      refreshToken: REFRESH,
      fetch: fetchImpl,
      onRefreshed: token => { saved.push(token) },
    })

    expect(saved).toEqual(['rotated-refresh'])
  })

  it('额度还是那三档，续期这一层不改变结果', async () => {
    const { fetchImpl } = twoStep()

    const quota = await fetchKimiWebUsageWithRefresh({ refreshToken: REFRESH, fetch: fetchImpl })

    expect(quota.windows.map(w => w.label)).toEqual(['总', '5h', '周'])
  })

  it('结果与报错都不带 refresh token', async () => {
    const { fetchImpl } = twoStep()

    const quota = await fetchKimiWebUsageWithRefresh({ refreshToken: REFRESH, fetch: fetchImpl })

    expect(JSON.stringify(quota)).not.toContain('not-a-real-refresh-token')
    expect(JSON.stringify(quota)).not.toContain('rotated-refresh')
  })
})
