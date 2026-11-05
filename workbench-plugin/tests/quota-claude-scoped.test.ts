// @vitest-environment node
/**
 * Claude 按模型分的周窗口（Fable / Opus / Sonnet …）。
 *
 * 这一栏在**响应头里没有**（claudeHeaders.ts 那条路只有统一的 5h/7d），
 * 在桌面端的 plan-usage-history.json 里也没有（那份只写 five_hour/seven_day）。
 * 它只在 `GET /api/oauth/usage` 的 `limits[]` 里，正是 Claude Code 自己
 * `/usage` 命令里「Current week (Fable)」那一栏的来源。
 */
import { describe, expect, it, vi } from 'vitest'
import {
  claudeCodeUserAgent,
  fetchClaudeScopedWeekly,
  parseScopedWeeklyWindows,
  pickOauthAccessToken,
  oauthTokenExpiry,
} from '../src/quota/claudeScoped.ts'

/**
 * 响应形状取自 Claude Code 2.1.237 二进制里的解析代码与桌面端 app.asar 的 schema：
 * `limits[]` 元素是 { kind, group, percent, severity?, resets_at?, scope?: { model?: { display_name } } }。
 * 这里的数字对齐 Ben 2026-08-25 的真机截图：All models 周 65% 已用、Fable 周 80% 已用。
 */
const REAL = {
  five_hour: { utilization: 20, resets_at: '2026-08-25T15:00:00.000Z' },
  seven_day: { utilization: 65, resets_at: '2026-08-25T16:00:00.000Z' },
  limits: [
    { kind: 'session', group: 'session', percent: 20, resets_at: '2026-08-25T15:00:00.000Z' },
    { kind: 'weekly', group: 'weekly', percent: 65, resets_at: '2026-08-25T16:00:00.000Z' },
    {
      kind: 'weekly_scoped',
      group: 'weekly',
      percent: 80,
      resets_at: '2026-08-25T16:00:00.000Z',
      scope: { model: { display_name: 'Fable' } },
    },
  ],
}

describe('parseScopedWeeklyWindows', () => {
  it('★挑出按模型的周窗口，标签用接口自己给的 display_name', () => {
    expect(parseScopedWeeklyWindows(REAL)).toEqual([
      { label: 'Fable', left_pct: 20, reset_at: '2026-08-25T16:00:00.000Z' },
    ])
  })

  it('不按模型分的窗口一概不要——统一的 5h/周 由响应头那条路负责，重复了会在界面上多两条', () => {
    const windows = parseScopedWeeklyWindows(REAL)
    expect(windows.map(w => w.label)).not.toContain('weekly')
    expect(windows).toHaveLength(1)
  })

  it('多个模型就多条，顺序按接口给的来', () => {
    const many = {
      limits: [
        { kind: 'weekly_scoped', percent: 80, scope: { model: { display_name: 'Fable' } } },
        { kind: 'weekly_scoped', percent: 12, scope: { model: { display_name: 'Opus' } } },
      ],
    }
    expect(parseScopedWeeklyWindows(many).map(w => w.label)).toEqual(['Fable', 'Opus'])
  })

  it('没有 limits[]、或一条按模型的都没有，就是空数组（不是报错——它是可选的一栏）', () => {
    expect(parseScopedWeeklyWindows({})).toEqual([])
    expect(parseScopedWeeklyWindows({ limits: [{ kind: 'weekly', percent: 65 }] })).toEqual([])
  })

  it('★percent 只认 0–100。上游哪天改成 0–1，要当场丢掉而不是把 0.8 显示成「还剩 99.2%」', () => {
    const ratio = {
      limits: [{ kind: 'weekly_scoped', percent: 0.8, scope: { model: { display_name: 'Fable' } } }],
    }
    expect(parseScopedWeeklyWindows(ratio)).toEqual([])
  })

  it('没有 resets_at 也照样给百分比——少个时刻总比整条不显示强', () => {
    const noReset = {
      limits: [{ kind: 'weekly_scoped', percent: 80, scope: { model: { display_name: 'Fable' } } }],
    }
    expect(parseScopedWeeklyWindows(noReset)).toEqual([{ label: 'Fable', left_pct: 20 }])
  })

  it('scope 里没有 model（比如按 surface 分的）不算按模型窗口', () => {
    const bySurface = {
      limits: [{ kind: 'weekly_scoped', percent: 30, scope: { surface: { display_name: 'Cowork' } } }],
    }
    expect(parseScopedWeeklyWindows(bySurface)).toEqual([])
  })
})

describe('pickOauthAccessToken', () => {
  it('取出 keychain 那份 JSON 里的 accessToken', () => {
    expect(pickOauthAccessToken('{"claudeAiOauth":{"accessToken":"tok-1"}}')).toBe('tok-1')
  })

  it('★空串当「没有」——本机就是这个坑：条目在、值是空串，直接发出去会变成 Bearer 加空格', () => {
    expect(pickOauthAccessToken('{"claudeAiOauth":{"accessToken":""}}')).toBeUndefined()
  })

  it('条目退化成只有 mcpOAuth（社区实测 2.1.x 出现过）也当没有，不许下标炸掉', () => {
    expect(pickOauthAccessToken('{"mcpOAuth":{}}')).toBeUndefined()
  })

  it('不是 JSON、空输入都当没有', () => {
    expect(pickOauthAccessToken('')).toBeUndefined()
    expect(pickOauthAccessToken('not json')).toBeUndefined()
  })
})

describe('oauthTokenExpiry:本地就能看出 token 死没死', () => {
  it('★读出 expiresAt——过期的 token 不该再拿去撞端点', () => {
    expect(oauthTokenExpiry('{"claudeAiOauth":{"accessToken":"t","expiresAt":1787655517108}}'))
      .toBe(1787655517108)
  })

  it('没有 expiresAt / 形状不对 / 不是数字 → undefined,当作"不知道",照常去打(不猜它已死)', () => {
    expect(oauthTokenExpiry('{"claudeAiOauth":{"accessToken":"t"}}')).toBeUndefined()
    expect(oauthTokenExpiry('{"claudeAiOauth":{"accessToken":"t","expiresAt":"soon"}}')).toBeUndefined()
    expect(oauthTokenExpiry('not json')).toBeUndefined()
    expect(oauthTokenExpiry('')).toBeUndefined()
  })
})

describe('claudeCodeUserAgent', () => {
  it('★从装着的版本目录动态取——UA 不是 claude-code/<semver> 会掉进凶狠限流桶（429 的真因）', () => {
    expect(claudeCodeUserAgent(['2.1.212', '2.1.237'])).toBe('claude-code/2.1.237')
  })

  it('按版本号排序，不是按字典序（2.1.9 不能压过 2.1.237）', () => {
    expect(claudeCodeUserAgent(['2.1.9', '2.1.237'])).toBe('claude-code/2.1.237')
  })

  it('目录里有杂项就跳过；一个像样的都没有则返回 undefined，由调用方决定别发请求', () => {
    expect(claudeCodeUserAgent(['.DS_Store', 'latest'])).toBeUndefined()
    expect(claudeCodeUserAgent([])).toBeUndefined()
  })
})

describe('fetchClaudeScopedWeekly', () => {
  function fetchStub(
    status: number,
    body: unknown,
    seen: { url?: string | undefined, headers?: Record<string, string> | undefined },
  ) {
    return vi.fn(async (url: string, init?: { headers?: Record<string, string> }) => {
      seen.url = String(url)
      seen.headers = init?.headers
      return { ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) }
    }) as never
  }

  it('打对端点、带对 UA 与 beta 头，返回按模型窗口', async () => {
    const seen: { url?: string, headers?: Record<string, string> } = {}
    const windows = await fetchClaudeScopedWeekly({
      token: 'tok-1',
      userAgent: 'claude-code/2.1.237',
      fetch: fetchStub(200, REAL, seen),
    })

    expect(seen.url).toBe('https://api.anthropic.com/api/oauth/usage')
    expect(seen.headers?.['User-Agent']).toBe('claude-code/2.1.237')
    expect(seen.headers?.['anthropic-beta']).toBe('oauth-2025-04-20')
    expect(windows).toEqual([{ label: 'Fable', left_pct: 20, reset_at: '2026-08-25T16:00:00.000Z' }])
  })

  it('★403 说缺 user:profile 时要明说「要重新 claude auth login」，不许悄悄降级成没数', async () => {
    const seen = {}
    await expect(fetchClaudeScopedWeekly({
      token: 'tok-1',
      userAgent: 'claude-code/2.1.237',
      fetch: fetchStub(403, { error: { message: 'OAuth token does not meet scope requirement user:profile' } }, seen),
    })).rejects.toThrow(/claude auth login/)
  })

  it('★错误信息里绝不出现 token', async () => {
    const seen = {}
    await expect(fetchClaudeScopedWeekly({
      token: 'super-secret-token',
      userAgent: 'claude-code/2.1.237',
      fetch: fetchStub(500, {}, seen),
    })).rejects.toThrow(/^(?!.*super-secret-token).*$/s)
  })

  it('★401(access token 过期)要明说「要重新登录」——它不会自己好', async () => {
    // 2026-08-26 真机:这正是 Fable 那栏消失的真因。端点原话是
    // "OAuth access token has expired. Re-authenticate to continue."。
    // 401 以前掉进通用的 HTTP 4xx 分支,被调用方归进"下一轮自己会好"那一档——
    // 可它永远不会自己好,只会每分钟再撞一次,直到把自己撞进限流。
    const seen = {}
    await expect(fetchClaudeScopedWeekly({
      token: 'tok-expired',
      userAgent: 'claude-code/2.1.237',
      fetch: fetchStub(401, {
        error: { type: 'authentication_error', message: 'OAuth access token has expired. Re-authenticate to continue.' },
      }, seen),
    })).rejects.toThrow(/claude auth login/)
  })

  it('429 抛错让调用方退避——这个端点不是给高频轮询用的', async () => {
    const seen = {}
    await expect(fetchClaudeScopedWeekly({
      token: 'tok-1',
      userAgent: 'claude-code/2.1.237',
      fetch: fetchStub(429, {}, seen),
    })).rejects.toThrow(/429/)
  })
})
