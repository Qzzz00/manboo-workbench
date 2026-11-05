/**
 * 凭据清空之后,额度面板不许再显示上一次采样(2026-09-18,Ben 真机)。
 *
 * 他的原话对应的现象:清空凭据后 DeepSeek 仍显示 ¥2.26、今日 2.26。
 * 真机上查出来的两条路都能造出那个数字:
 *
 * 1. **走了中转还在报官方余额**。`~/.dsh/workbench/model.json` 是 `mode:'relay'` 且已经
 *    领到令牌,但 `~/.dsh/.env` 里还留着一把私人 DeepSeek Key —— 采集循环照样拿它去问
 *    官方余额,于是面板上那笔钱既不是中转的用量,也不是他此刻在花的账户。
 * 2. **宽限把已经作废的数字留住了**。单家取不到数时有 GRACE_ROUNDS 轮宽限(防网络抖动),
 *    而"凭据没配"根本不是抖动,是一个确定的结论 —— 被宽限留住的那个数字是用一把
 *    已经不在的 Key 取的。
 *
 * 所以这一份守的是同一句话的两半:**该显示的换成中转用量,不该显示的当场作废**。
 */
import { describe, expect, it, vi } from 'vitest'
import type { AgentId, QuotaEntry } from '../src/protocol.ts'
import { AGENT_IDS } from '../src/protocol.ts'
import type { CollectQuotaOptions, CollectQuotaResult } from '../src/quota/collect.ts'
import { collectQuota } from '../src/quota/collect.ts'
import { startQuotaCollector } from '../src/quota/collector.ts'
import type { FetchLike } from '../src/quota/deepseek.ts'
import { relayQuotaEntry } from '../src/quota/relay.ts'
import { createWorkbenchService } from '../src/server/service.ts'

const FAKE_KEY = 'sk-test-fake-key-not-real'

const noCodex = { listSessionFiles: async () => [], readFile: async () => '' }
const noClaudeDesktop = { readFile: async () => { throw new Error('没有这个文件') } }
const noCodexAppServer = { readRateLimits: async () => { throw new Error('codex app-server 没起来') } }

/** 官方余额那条路的桩。**同时记下它被打了没有** —— relay 下它一次都不该被打。 */
function balanceFetch(total = '2.26'): FetchLike & { calls: string[] } {
  const calls: string[] = []
  const impl = (async (url: string) => {
    calls.push(url)
    return {
      ok: true,
      status: 200,
      json: async () => ({
        is_available: true,
        balance_infos: [{ currency: 'CNY', total_balance: total, granted_balance: '0.00', topped_up_balance: total }],
      }),
      text: async () => '',
    }
  }) as FetchLike & { calls: string[] }
  impl.calls = calls
  return impl
}

const BASE = {
  codexAppServerIo: noCodexAppServer,
  codexIo: noCodex,
  claudeDesktopIo: noClaudeDesktop,
} satisfies Partial<CollectQuotaOptions>

const RELAY_USAGE = { day: '2026-09-18', used_tokens: 3800, daily_token_limit: 10_000, remaining_tokens: 6200 }

describe('DeepSeek 那一格:三条路各说各的话', () => {
  it('★凭据没配、也没走中转 → unknown「还没接 DeepSeek」,而且**标明不许留旧数**', async () => {
    const { quota } = await collectQuota({ ...BASE, env: {}, fetch: balanceFetch() })

    expect(quota.dsh?.kind).toBe('unknown')
    expect(quota.dsh).toMatchObject({ no_stale: true, note: expect.stringContaining('还没接 DeepSeek') })
  })

  it('★走中转(领到令牌)→ 报中转的今日用量,**一次都不去问官方余额**', async () => {
    const fetchImpl = balanceFetch()
    const { quota } = await collectQuota({
      ...BASE,
      // 真机上正是这个组合:.env 里还有一把私人 Key,但人已经在用工作台的中转。
      env: { DEEPSEEK_API_KEY: FAKE_KEY },
      fetch: fetchImpl,
      relay: { ready: true, usage: async () => ({ ok: true, usage: RELAY_USAGE }) },
    })

    expect(fetchImpl.calls).toEqual([])
    // `as_of`:卡 QA 起每一家取到的数都带截至时刻(中转那条是现问的接口,就是这一刻)。
    expect(quota.dsh).toMatchObject({ kind: 'quota', windows: [{ label: '今日', left_pct: 62 }] })
    expect(Date.parse((quota.dsh as { as_of: string }).as_of)).toBeGreaterThan(0)
  })

  it('★走中转但用量取不到,而上一轮显示的是官方余额 → 当场作废,不留那笔钱', async () => {
    const { quota } = await collectQuota({
      ...BASE,
      env: { DEEPSEEK_API_KEY: FAKE_KEY },
      fetch: balanceFetch(),
      dsh: { kind: 'balance', currency: 'CNY', total: '2.26', available: true },
      relay: { ready: true, usage: async () => ({ ok: false, error: '中转没能给出用量(HTTP 404)' }) },
    })

    expect(quota.dsh).toMatchObject({ kind: 'unknown', no_stale: true })
    expect(quota.dsh?.kind === 'unknown' ? quota.dsh.note : '').toContain('HTTP 404')
  })

  it('走中转、用量这一轮取不到,但上一轮也是中转的数 → 照旧交给宽限(同一条源,不算作废)', async () => {
    const { quota } = await collectQuota({
      ...BASE,
      env: {},
      fetch: balanceFetch(),
      dsh: { kind: 'quota', windows: [{ label: '今日', left_pct: 62 }] },
      relay: { ready: true, usage: async () => ({ ok: false, error: '连不上模型服务' }) },
    })

    expect(quota.dsh?.kind).toBe('unknown')
    expect(quota.dsh).not.toMatchObject({ no_stale: true })
  })

  it('中转没给今日上限 → 不编一个百分比,如实说算不出来', async () => {
    const { quota } = await collectQuota({
      ...BASE,
      env: {},
      fetch: balanceFetch(),
      relay: { ready: true, usage: async () => ({ ok: true, usage: { ...RELAY_USAGE, daily_token_limit: 0 } }) },
    })

    expect(quota.dsh?.kind).toBe('unknown')
  })

  it('自己的 Key 还在(没走中转)→ 照旧显示账号余额', async () => {
    const { quota } = await collectQuota({
      ...BASE,
      env: {},
      fetch: balanceFetch('218.40'),
      credentials: { deepseek: FAKE_KEY },
      relay: { ready: false },
    })

    expect(quota.dsh).toMatchObject({ kind: 'balance', total: '218.40' })
  })
})

describe('Kimi:没登录也是一个确定的结论,不是抖动', () => {
  it('★没有 kimi_web 凭据 → unknown 且标明不许留旧数', async () => {
    const { quota } = await collectQuota({ ...BASE, env: {}, fetch: balanceFetch() })

    expect(quota.kimi).toMatchObject({ kind: 'unknown', no_stale: true })
  })
})

describe('relayQuotaEntry:中转用量 → 那一格', () => {
  it('剩余算成百分比(条长＝剩余,跟别家一个方向)', () => {
    expect(relayQuotaEntry({ ok: true, usage: RELAY_USAGE }))
      .toEqual({ kind: 'quota', windows: [{ label: '今日', left_pct: 62 }] })
  })

  it('★ 中转给了元就按元算剩余(2026-09-23),token 撞没撞老上限不管', () => {
    expect(relayQuotaEntry({
      ok: true,
      usage: { ...RELAY_USAGE, remaining_tokens: 0, used_cny: 1, daily_cost_limit_cny: 5, remaining_cny: 4 },
    })).toEqual({ kind: 'quota', windows: [{ label: '今日', left_pct: 80 }] })
  })

  it('用超了也不给负数(界面上 -12% 只会让人以为程序坏了)', () => {
    expect(relayQuotaEntry({ ok: true, usage: { ...RELAY_USAGE, remaining_tokens: -1200 } }))
      .toEqual({ kind: 'quota', windows: [{ label: '今日', left_pct: 0 }] })
  })

  it('取不到就把中转给的那句原因带上,不编数', () => {
    const entry = relayQuotaEntry({ ok: false, error: '连不上模型服务' })
    expect(entry.kind).toBe('unknown')
    expect(entry.kind === 'unknown' ? entry.note : '').toContain('连不上模型服务')
  })
})

/** 四家都给一条余额,方便断言"是这一轮的数"。 */
function resultWith(entry: QuotaEntry): CollectQuotaResult {
  return {
    quota: Object.fromEntries(AGENT_IDS.map(agent => [agent, entry])) as Record<AgentId, QuotaEntry>,
  }
}

const BALANCE: QuotaEntry = { kind: 'balance', currency: 'CNY', total: '2.26', available: true }

describe('采集循环:宽限只保抖动,不保已经作废的数', () => {
  it('★no_stale 的 unknown 当场写进去 —— 上一轮那个 ¥2.26 一秒都不该多留', async () => {
    const service = createWorkbenchService()
    let round = 0
    const collect = vi.fn(async () => {
      round += 1
      return resultWith(round === 1 ? BALANCE : { kind: 'unknown', note: '还没接 DeepSeek', no_stale: true })
    })

    const collector = startQuotaCollector({ service, collect, intervalMs: 0, claudeIntervalMs: 0, readCredentials: async () => ({}) })
    await collector.collectOnce()
    expect(service.getState().quota.dsh).toMatchObject({ kind: 'balance' })
    await collector.collectOnce()
    collector.stop()

    expect(service.getState().quota.dsh).toEqual({ kind: 'unknown', note: '还没接 DeepSeek', no_stale: true })
  })

  it('普通的取不到(网络抖)照旧宽限 —— 这条老纪律一个字不改', async () => {
    const service = createWorkbenchService()
    let round = 0
    const collect = vi.fn(async () => {
      round += 1
      return resultWith(round === 1 ? BALANCE : { kind: 'unknown', note: 'fetch failed' })
    })

    const collector = startQuotaCollector({ service, collect, intervalMs: 0, claudeIntervalMs: 0, readCredentials: async () => ({}) })
    await collector.collectOnce()
    await collector.collectOnce()
    collector.stop()

    expect(service.getState().quota.dsh).toMatchObject({ kind: 'balance', total: '2.26' })
  })

  it('★作废那一刻「额度不足」也要跟着去掉(那是用已经不在的账户算出来的结论)', async () => {
    const service = createWorkbenchService()
    const marks: [AgentId, boolean][] = []
    const spied = {
      ...service,
      setQuotaExhausted: (agent: AgentId, exhausted: boolean) => {
        marks.push([agent, exhausted])
        service.setQuotaExhausted(agent, exhausted)
      },
    }
    let round = 0
    const collect = vi.fn(async () => {
      round += 1
      return resultWith(round === 1
        // 余额 0 → 第一轮就会被打上「额度不足」。
        ? { kind: 'balance', currency: 'CNY', total: '0.00', available: true }
        : { kind: 'unknown', note: '还没接 DeepSeek', no_stale: true })
    })

    const collector = startQuotaCollector({ service: spied, collect, intervalMs: 0, claudeIntervalMs: 0, readCredentials: async () => ({}) })
    await collector.collectOnce()
    expect(marks).toContainEqual(['dsh', true])
    await collector.collectOnce()
    collector.stop()

    expect(service.getState().quota.dsh).toMatchObject({ kind: 'unknown' })
    expect(marks.filter(([agent]) => agent === 'dsh').at(-1)).toEqual(['dsh', false])
  })

  it('每轮把 model.json 现读一遍并传给取数层 —— Ben 在设置里切完,下一轮就换说法', async () => {
    const service = createWorkbenchService()
    const collect = vi.fn(async (_options: CollectQuotaOptions) => resultWith(BALANCE))
    const readRelay = vi.fn(async () => ({ ready: true }))

    const collector = startQuotaCollector({
      service, collect, intervalMs: 0, claudeIntervalMs: 0, readCredentials: async () => ({}), readRelay,
    })
    await collector.collectOnce()
    collector.stop()

    expect(readRelay).toHaveBeenCalledTimes(1)
    expect(collect.mock.calls[0]?.[0]?.relay).toMatchObject({ ready: true })
  })

  it('上一轮那一格要传回取数层(它据此判断"旧数还能不能代表现在")', async () => {
    const service = createWorkbenchService()
    const collect = vi.fn(async (_options: CollectQuotaOptions) => resultWith(BALANCE))

    const collector = startQuotaCollector({ service, collect, intervalMs: 0, claudeIntervalMs: 0, readCredentials: async () => ({}) })
    await collector.collectOnce()
    await collector.collectOnce()
    collector.stop()

    expect(collect.mock.calls[1]?.[0]?.dsh).toMatchObject({ kind: 'balance', total: '2.26' })
  })
})

describe('清空某一家的凭据 → 那一家的采样当场作废', () => {
  it('★DeepSeek:内存里的上一次采样立刻变成「还没接」', async () => {
    const service = createWorkbenchService()
    const collect = vi.fn(async () => resultWith(BALANCE))
    const collector = startQuotaCollector({ service, collect, intervalMs: 0, claudeIntervalMs: 0, readCredentials: async () => ({}) })
    await collector.collectOnce()

    collector.forgetCredential('deepseek')
    collector.stop()

    const entry = service.getState().quota.dsh
    expect(entry).toMatchObject({ kind: 'unknown', no_stale: true })
    expect(entry?.kind === 'unknown' ? entry.note : '').toContain('还没接 DeepSeek')
  })

  it('★Kimi:同样当场作废', async () => {
    const service = createWorkbenchService()
    const collect = vi.fn(async () => resultWith(BALANCE))
    const collector = startQuotaCollector({ service, collect, intervalMs: 0, claudeIntervalMs: 0, readCredentials: async () => ({}) })
    await collector.collectOnce()

    collector.forgetCredential('kimi_web')
    collector.stop()

    expect(service.getState().quota.kimi).toMatchObject({ kind: 'unknown', no_stale: true })
  })

  it('★Claude 的那把 token 不算:它的百分比来自本机客户端的记录,跟这把 token 无关', async () => {
    const service = createWorkbenchService()
    const collect = vi.fn(async () => resultWith({ kind: 'quota', windows: [{ label: '周', left_pct: 29 }] }))
    const collector = startQuotaCollector({ service, collect, intervalMs: 0, claudeIntervalMs: 0, readCredentials: async () => ({}) })
    await collector.collectOnce()

    collector.forgetCredential('claude_api')
    collector.stop()

    // 删掉实时源那把 token 只是"不实时了",不是"没有数" —— 把它抹成未接入才是编。
    expect(service.getState().quota.claude).toMatchObject({ kind: 'quota' })
  })

  it('作废之后紧接着的那一轮取不到数,也不会被宽限把旧数捞回来', async () => {
    const service = createWorkbenchService()
    let round = 0
    const collect = vi.fn(async () => {
      round += 1
      return resultWith(round === 1 ? BALANCE : { kind: 'unknown', note: 'fetch failed' })
    })
    const collector = startQuotaCollector({ service, collect, intervalMs: 0, claudeIntervalMs: 0, readCredentials: async () => ({}) })
    await collector.collectOnce()
    collector.forgetCredential('deepseek')
    await collector.collectOnce()
    collector.stop()

    expect(service.getState().quota.dsh?.kind).toBe('unknown')
  })

  it('落盘那份(last-quota.json)里同一家的记录也跟着删', async () => {
    const service = createWorkbenchService()
    const forgot: AgentId[] = []
    const collect = vi.fn(async () => resultWith(BALANCE))
    const collector = startQuotaCollector({
      service,
      collect,
      intervalMs: 0,
      claudeIntervalMs: 0,
      readCredentials: async () => ({}),
      forgetLastQuota: (agent) => { forgot.push(agent) },
    })
    await collector.collectOnce()
    collector.forgetCredential('deepseek')
    collector.stop()

    expect(forgot).toEqual(['dsh'])
  })
})
