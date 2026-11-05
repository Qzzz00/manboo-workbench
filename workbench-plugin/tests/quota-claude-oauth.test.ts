// @vitest-environment node
/**
 * Claude OAuth 续期(2026-08-26)。
 *
 * 做法不是我拍脑袋定的:先查了同类已上线工具(pi-claude-auth / opencode-claude-auth /
 * claude-oauth-refresher),三家共识是「refresh token 每用一次就换一张、换完必须写回、
 * 懒续期、写回带并发护栏」。这份测试把其中属于本模块的部分钉住。
 */
import { describe, expect, it, vi } from 'vitest'
import {
  CLAUDE_CODE_CLIENT_ID,
  mergeRefreshedCredential,
  parseRefreshResponse,
  pickOauthRefreshToken,
  refreshClaudeOauth,
} from '../src/quota/claudeOauth.ts'

const NOW = 1_800_000_000_000
const OK_BODY = { access_token: 'new-at', refresh_token: 'new-rt', expires_in: 28800 }

function stub(steps: readonly { status: number, body?: unknown }[], seen: unknown[] = []) {
  let i = 0
  const fetchImpl = vi.fn(async (url: string, init?: { body?: string }) => {
    const step = steps[Math.min(i, steps.length - 1)]!
    i += 1
    seen.push({ url: String(url), body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) })
    return {
      ok: step.status < 400,
      status: step.status,
      json: async () => step.body ?? {},
      text: async () => JSON.stringify(step.body ?? {}),
    }
  })
  return { fetchImpl: fetchImpl as never, seen }
}

describe('parseRefreshResponse:严格解析,缺一样就不敢写回', () => {
  it('★正常响应换算成绝对到期时刻(expires_in 秒 → 毫秒时刻)', () => {
    expect(parseRefreshResponse(OK_BODY, NOW)).toEqual({
      accessToken: 'new-at', refreshToken: 'new-rt', expiresAtMs: NOW + 28_800_000,
    })
  })

  it('★没回新的 refresh token 就整条作废——它是轮换的,拿不到新的说明我们理解错了接口', () => {
    expect(parseRefreshResponse({ access_token: 'a', expires_in: 100 }, NOW)).toBeUndefined()
    expect(parseRefreshResponse({ access_token: 'a', refresh_token: '', expires_in: 100 }, NOW)).toBeUndefined()
  })

  it('缺 access_token / expires_in 不合法 / 根本不是对象,一律 undefined,不拿缺省值凑', () => {
    expect(parseRefreshResponse({ refresh_token: 'r', expires_in: 100 }, NOW)).toBeUndefined()
    expect(parseRefreshResponse({ access_token: 'a', refresh_token: 'r', expires_in: 0 }, NOW)).toBeUndefined()
    expect(parseRefreshResponse({ access_token: 'a', refresh_token: 'r', expires_in: 'soon' }, NOW)).toBeUndefined()
    expect(parseRefreshResponse(null, NOW)).toBeUndefined()
  })
})

describe('refreshClaudeOauth', () => {
  it('★按 refresh_token grant 打,带上 Claude Code 的 client_id', async () => {
    const seen: unknown[] = []
    const { fetchImpl } = stub([{ status: 200, body: OK_BODY }], seen)
    const tokens = await refreshClaudeOauth({
      refreshToken: 'old-rt', fetch: fetchImpl, now: () => NOW,
      endpoints: ['https://platform.claude.com/v1/oauth/token'],
    })

    expect(tokens.accessToken).toBe('new-at')
    expect(tokens.refreshToken).toBe('new-rt')
    expect((seen[0] as { body: Record<string, unknown> }).body).toEqual({
      grant_type: 'refresh_token', refresh_token: 'old-rt', client_id: CLAUDE_CODE_CLIENT_ID,
    })
  })

  it('★端点搬家(404)才换下一个地址', async () => {
    const seen: unknown[] = []
    const { fetchImpl } = stub([{ status: 404 }, { status: 200, body: OK_BODY }], seen)
    const tokens = await refreshClaudeOauth({
      refreshToken: 'old-rt', fetch: fetchImpl, now: () => NOW,
      endpoints: ['https://a.example/token', 'https://b.example/token'],
    })

    expect(tokens.accessToken).toBe('new-at')
    expect((seen as { url: string }[]).map(s => s.url)).toEqual(['https://a.example/token', 'https://b.example/token'])
  })

  it('★400(refresh token 已被 CLI 抢先换掉)当场停手,不拿废掉的 token 到处撞', async () => {
    const seen: unknown[] = []
    const { fetchImpl } = stub([{ status: 400, body: { error: 'invalid_grant' } }], seen)
    await expect(refreshClaudeOauth({
      refreshToken: 'old-rt', fetch: fetchImpl, now: () => NOW,
      endpoints: ['https://a.example/token', 'https://b.example/token'],
    })).rejects.toThrow(/400/)

    expect(seen).toHaveLength(1) // 只打了第一个地址
  })

  it('★错误信息里绝不出现 token', async () => {
    const { fetchImpl } = stub([{ status: 500 }])
    await expect(refreshClaudeOauth({
      refreshToken: 'super-secret-refresh-token', fetch: fetchImpl, now: () => NOW,
      endpoints: ['https://a.example/token'],
    })).rejects.toThrow(/^(?!.*super-secret-refresh-token).*$/s)
  })

  it('响应缺字段时宁可整条失败,也不写回一份残缺凭据', async () => {
    const { fetchImpl } = stub([{ status: 200, body: { access_token: 'a' } }])
    await expect(refreshClaudeOauth({
      refreshToken: 'old-rt', fetch: fetchImpl, now: () => NOW,
      endpoints: ['https://a.example/token'],
    })).rejects.toThrow(/缺字段/)
  })
})

describe('mergeRefreshedCredential:只动该动的三项', () => {
  const FRESH = { accessToken: 'at2', refreshToken: 'rt2', expiresAtMs: 999 }

  it('★其余字段一个不动——scopes/subscriptionType 这些不是我们有资格决定的', () => {
    const raw = JSON.stringify({
      claudeAiOauth: {
        accessToken: 'at1', refreshToken: 'rt1', expiresAt: 1,
        scopes: ['user:profile'], subscriptionType: 'max', rateLimitTier: 'x',
        refreshTokenExpiresAt: 42,
      },
      somethingElse: { keep: true },
    })
    const merged = JSON.parse(mergeRefreshedCredential(raw, FRESH)!)

    expect(merged.claudeAiOauth).toEqual({
      accessToken: 'at2', refreshToken: 'rt2', expiresAt: 999,
      scopes: ['user:profile'], subscriptionType: 'max', rateLimitTier: 'x',
      refreshTokenExpiresAt: 42,
    })
    expect(merged.somethingElse).toEqual({ keep: true })
  })

  it('形状不认识就返回 undefined,绝不写一份自己没看懂的凭据', () => {
    expect(mergeRefreshedCredential('not json', FRESH)).toBeUndefined()
    expect(mergeRefreshedCredential('{"mcpOAuth":{}}', FRESH)).toBeUndefined()
    expect(mergeRefreshedCredential('null', FRESH)).toBeUndefined()
  })
})

describe('pickOauthRefreshToken', () => {
  it('取出 refreshToken;空串/形状不对当没有', () => {
    expect(pickOauthRefreshToken('{"claudeAiOauth":{"refreshToken":"rt"}}')).toBe('rt')
    expect(pickOauthRefreshToken('{"claudeAiOauth":{"refreshToken":""}}')).toBeUndefined()
    expect(pickOauthRefreshToken('{"mcpOAuth":{}}')).toBeUndefined()
    expect(pickOauthRefreshToken('')).toBeUndefined()
  })
})
