// @vitest-environment node
/**
 * access token 过期时的自动续期(2026-08-26)——四道保险。
 *
 * 背景:access token 只活 8 小时,而 Claude Code CLI 只在它自己要发请求时才续期,
 * 于是 08-25 那次过期后整整 17.6 小时没人续,Fable 那一栏也就消失了 17.6 小时。
 *
 * 做法照抄已上线同类工具的共识(pi-claude-auth / opencode-claude-auth /
 * claude-oauth-refresher):refresh token 每用一次换一张,所以**换完必须写回**;
 * 懒续期;写回带并发护栏。这份测试把四道保险逐条钉死。
 *
 * **全程用桩,一次都不碰真实 keychain。**
 */
import { describe, expect, it, vi } from 'vitest'
import { collectQuota } from '../src/quota/collect.ts'
import { createClaudeScopedGate } from '../src/quota/claudeScopedGate.ts'
import { createClaudeRenewGate } from '../src/quota/claudeRenewGate.ts'
import type { WindowQuota } from '../src/protocol.ts'

const NOW = 1_800_000_000_000
const EXPIRED_AT = NOW - 3_600_000
const LIVE_AT = NOW + 3_600_000

const HEADERS = {
  'anthropic-ratelimit-unified-5h-utilization': '0.2',
  'anthropic-ratelimit-unified-5h-reset': '1787670000',
  'anthropic-ratelimit-unified-7d-utilization': '0.65',
  'anthropic-ratelimit-unified-7d-reset': '1787673600',
}
const SCOPED_BODY = {
  limits: [{
    kind: 'weekly_scoped', percent: 80,
    resets_at: '2026-09-01T00:00:00.000Z',
    scope: { model: { display_name: 'Fable' } },
  }],
}

function cred(accessToken: string, expiresAt: number, refreshToken = 'rt-1'): string {
  return JSON.stringify({
    claudeAiOauth: { accessToken, refreshToken, expiresAt, scopes: ['user:profile'], subscriptionType: 'max' },
  })
}

/** 一个假的 keychain:记下每次写入,读回的永远是最后写进去的那份。 */
function fakeKeychain(initial: string) {
  const state = { raw: initial, writes: [] as string[], backups: [] as string[] }
  return {
    state,
    io: {
      readKeychain: async () => state.raw,
      readVersions: async () => ['2.1.241'],
      writeKeychain: async (raw: string) => { state.writes.push(raw); state.raw = raw },
      backupKeychain: async (raw: string) => { state.backups.push(raw); return '/tmp/backup.json' },
    },
  }
}

/** /v1/messages 恒成功;usage 端点按传入决定;oauth/token 按传入决定。 */
function fetchStub(opts: {
  refresh?: { status: number, body?: unknown }
  usage?: { status: number, body?: unknown }
  seenAuth?: string[]
} = {}) {
  return vi.fn(async (url: string, init?: { headers?: Record<string, string> }) => {
    const target = String(url)
    if (target.includes('/oauth/token')) {
      const step = opts.refresh ?? { status: 200, body: { access_token: 'at-2', refresh_token: 'rt-2', expires_in: 28800 } }
      return { ok: step.status < 400, status: step.status, json: async () => step.body ?? {}, text: async (): Promise<string> => '' }
    }
    if (target.includes('/api/oauth/usage')) {
      opts.seenAuth?.push(String(init?.headers?.Authorization ?? ''))
      const step = opts.usage ?? { status: 200, body: SCOPED_BODY }
      return {
        ok: step.status < 400, status: step.status,
        json: async () => step.body ?? {}, text: async (): Promise<string> => '',
        headers: { get: () => null },
      }
    }
    return {
      ok: true, status: 200, json: async () => ({}), text: async (): Promise<string> => '',
      headers: { get: (n: string) => (HEADERS as Record<string, string>)[n.toLowerCase()] ?? null },
    }
  }) as never
}

function options(io: unknown, fetchImpl: unknown) {
  return {
    env: {},
    credentials: { claude_api: 'tok-inference' },
    fetch: fetchImpl as never,
    claudeScopedIo: io as never,
    claudeScopedGate: createClaudeScopedGate({ minIntervalMs: 0, now: () => NOW }),
    codexAppServerIo: { readRateLimits: async () => { throw new Error('本用例不打 codex') } },
    codexIo: { listSessionFiles: async () => [], readFile: async () => { throw new Error('不读') } },
    only: ['claude' as const],
  }
}

describe('Claude access token 过期时的自动续期', () => {
  it('★过期 → 自动换新 → 写回 keychain → 用新 token 取到 Fable', async () => {
    const kc = fakeKeychain(cred('at-1', EXPIRED_AT))
    const seenAuth: string[] = []
    const result = await collectQuota(options(kc.io, fetchStub({ seenAuth })))

    expect((result.quota.claude as WindowQuota).windows.map(w => w.label)).toEqual(['5h', '周', 'Fable'])
    expect(seenAuth).toEqual(['Bearer at-2']) // 用的是换来的新 token
    // 写回的内容:三项换新,其余字段原样。
    const written = JSON.parse(kc.state.writes[0]!)
    expect(written.claudeAiOauth.accessToken).toBe('at-2')
    expect(written.claudeAiOauth.refreshToken).toBe('rt-2') // 轮换后的必须写回
    expect(written.claudeAiOauth.subscriptionType).toBe('max') // 不该动的没动
  })

  it('★保险1:没有写回能力就根本不续期——换了不写回等于把 CLI 踢下线', async () => {
    const kc = fakeKeychain(cred('at-1', EXPIRED_AT))
    const noWrite = { readKeychain: kc.io.readKeychain, readVersions: kc.io.readVersions }
    const fetchImpl = fetchStub()
    const result = await collectQuota(options(noWrite, fetchImpl))

    const claude = result.quota.claude as WindowQuota
    expect(claude.windows.map(w => w.label)).toEqual(['5h', '周'])
    expect(claude.alert).toContain('claude auth login')
    const hitRefresh = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .some(c => String(c[0]).includes('/oauth/token'))
    expect(hitRefresh).toBe(false)
  })

  it('★保险2:CLI 已经抢先续过了 → 直接用它的,自己一次都不续', async () => {
    const kc = fakeKeychain(cred('at-cli', LIVE_AT)) // 读到时已经是新鲜的
    const seenAuth: string[] = []
    const fetchImpl = fetchStub({ seenAuth })
    // 让第一次读拿到过期值、第二次(续期前重读)拿到 CLI 换好的新值。
    let first = true
    kc.io.readKeychain = async () => {
      if (first) { first = false; return cred('at-old', EXPIRED_AT) }
      return kc.state.raw
    }
    await collectQuota(options(kc.io, fetchImpl))

    expect(seenAuth).toEqual(['Bearer at-cli'])
    expect(kc.state.writes).toHaveLength(0) // 没写回
    const hitRefresh = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .some(c => String(c[0]).includes('/oauth/token'))
    expect(hitRefresh).toBe(false)
  })

  it('★保险3:CAS —— 续期期间 CLI 的续期抢先落地,认它的、绝不覆盖', async () => {
    const kc = fakeKeychain(cred('at-1', EXPIRED_AT))
    const seenAuth: string[] = []
    let reads = 0
    kc.io.readKeychain = async () => {
      reads += 1
      // 第 1、2 次:出发时那份(过期)。第 3 次(CAS 校验)已被 CLI 换成别的。
      return reads >= 3 ? cred('at-cli-won', LIVE_AT, 'rt-cli') : cred('at-1', EXPIRED_AT)
    }
    await collectQuota(options(kc.io, fetchStub({ seenAuth })))

    expect(kc.state.writes).toHaveLength(0) // 一个字都没写
    expect(seenAuth).toEqual(['Bearer at-cli-won']) // 用对方的
  })

  it('★保险4:写回自检没通过 → 还原备份,并在 alert 里说清楚', async () => {
    const kc = fakeKeychain(cred('at-1', EXPIRED_AT))
    // 写进去了但读回来还是旧的(模拟 keychain 写入被系统吞掉)
    kc.io.writeKeychain = async (raw: string) => { kc.state.writes.push(raw) }
    const result = await collectQuota(options(kc.io, fetchStub()))

    const claude = result.quota.claude as WindowQuota
    expect(claude.windows.map(w => w.label)).toEqual(['5h', '周'])
    expect(claude.alert).toContain('claude auth login')
    expect(claude.alert).toContain('自检')
    // 备份做过,还原也写了一次(第二次写的是原值)
    expect(kc.state.backups).toHaveLength(1)
    expect(kc.state.writes[1]).toBe(cred('at-1', EXPIRED_AT))
  })

  it('★refresh token 也失效了(400 invalid_grant)→ 如实说要重新登录,不重试不换地址', async () => {
    const kc = fakeKeychain(cred('at-1', EXPIRED_AT))
    const fetchImpl = fetchStub({ refresh: { status: 400, body: { error: 'invalid_grant' } } })
    const result = await collectQuota(options(kc.io, fetchImpl))

    const claude = result.quota.claude as WindowQuota
    expect(claude.windows.map(w => w.label)).toEqual(['5h', '周'])
    expect(claude.alert).toContain('claude auth login')
    expect(kc.state.writes).toHaveLength(0)
    const refreshCalls = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .filter(c => String(c[0]).includes('/oauth/token'))
    expect(refreshCalls).toHaveLength(1) // 只试了一次
  })

  it('token 没过期时完全不走续期这条路', async () => {
    const kc = fakeKeychain(cred('at-live', LIVE_AT))
    const seenAuth: string[] = []
    const fetchImpl = fetchStub({ seenAuth })
    await collectQuota(options(kc.io, fetchImpl))

    expect(seenAuth).toEqual(['Bearer at-live'])
    expect(kc.state.writes).toHaveLength(0)
    expect(kc.state.backups).toHaveLength(0)
  })
})

/**
 * 续期退避(2026-09-02 真机:面板 alert 停在「自动续期没成功:Claude 续期失败(HTTP 429)」)。
 *
 * 根因:续期这条路是**无状态**的——过期 token 每轮都会触发一次续期尝试,60 秒一轮。
 * 429 是"你敲太快了",而我们的反应是下一分钟接着敲,于是永远待在惩罚里出不来
 * (与 claudeScopedGate 顶部记的那次事故同一形状,只是这次落在 oauth/token 上)。
 * 修法同款:失败进退避,期间不再发续期请求,alert 如实说明在等什么。
 */
describe('续期失败的退避(2026-09-02)', () => {
  function renewGateOptions(io: unknown, fetchImpl: unknown, gate: unknown, now: () => number) {
    return {
      ...options(io, fetchImpl),
      claudeScopedGate: createClaudeScopedGate({ minIntervalMs: 0, now }),
      claudeRenewGate: gate as never,
    }
  }

  it('★429 → 退避窗口内的后续轮次一次都不再打 oauth/token', async () => {
    const kc = fakeKeychain(cred('at-1', EXPIRED_AT))
    const fetchImpl = fetchStub({ refresh: { status: 429 } })
    const gate = createClaudeRenewGate({ minIntervalMs: 600_000 })
    let nowMs = NOW

    const first = await collectQuota(renewGateOptions(kc.io, fetchImpl, gate, () => nowMs))
    const callsAfterFirst = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .filter(call => String(call[0]).includes('/oauth/token')).length
    expect(callsAfterFirst).toBe(1)
    expect((first.quota.claude as WindowQuota).alert ?? '').toContain('429')

    // 下一轮(60 秒后)还在退避窗口内:不再打续期端点,alert 仍如实说明。
    nowMs += 60_000
    const second = await collectQuota(renewGateOptions(kc.io, fetchImpl, gate, () => nowMs))
    const callsAfterSecond = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .filter(call => String(call[0]).includes('/oauth/token')).length
    expect(callsAfterSecond).toBe(1) // 一次都没多打
    // 退避期内照旧如实说明:要重新登录,且复述上次失败原因(不假装什么都没发生)。
    const secondAlert = (second.quota.claude as WindowQuota).alert ?? ''
    expect(secondAlert).toContain('claude auth login')
    expect(secondAlert).toContain('退避中')
    expect(secondAlert).toContain('429')

    // 退避到期后允许再试一次。
    nowMs += 600_000
    await collectQuota(renewGateOptions(kc.io, fetchImpl, gate, () => nowMs))
    const callsAfterThird = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .filter(call => String(call[0]).includes('/oauth/token')).length
    expect(callsAfterThird).toBe(2)
  })

  it('★退避按次数递增(429 越撞越久),成功后清零', async () => {
    const gate = createClaudeRenewGate({ minIntervalMs: 600_000 })
    gate.onFailure(NOW, 'Claude 续期失败(HTTP 429)')
    const afterFirst = gate.nextAllowedAtMs()
    gate.onFailure(NOW, 'Claude 续期失败(HTTP 429)')
    expect(gate.nextAllowedAtMs()).toBeGreaterThan(afterFirst) // 第二次退得更久

    gate.onSuccess(NOW)
    expect(gate.shouldTry(NOW)).toBe(true) // 成功即清零,下一次过期能立刻续
  })

  it('续期成功的路不受闸门影响(不给正常路径添堵)', async () => {
    const kc = fakeKeychain(cred('at-1', EXPIRED_AT))
    const gate = createClaudeRenewGate({ minIntervalMs: 600_000 })
    const result = await collectQuota(renewGateOptions(kc.io, fetchStub({}), gate, () => NOW))
    expect((result.quota.claude as WindowQuota).windows.map(w => w.label)).toEqual(['5h', '周', 'Fable'])
    expect(gate.shouldTry(NOW)).toBe(true)
  })
})
