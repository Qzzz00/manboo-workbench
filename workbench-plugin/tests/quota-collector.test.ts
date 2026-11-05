import { describe, expect, it, vi } from 'vitest'
import type { AgentId, QuotaEntry } from '../src/protocol.ts'
import { AGENT_IDS } from '../src/protocol.ts'
import type { CollectQuotaOptions, CollectQuotaResult } from '../src/quota/collect.ts'
import { startQuotaCollector } from '../src/quota/collector.ts'
import type { WorkbenchService } from '../src/server/service.ts'
import { createWorkbenchService } from '../src/server/service.ts'

/**
 * 四家都出一条的采集结果，balance 值可指定，方便断言"是这一轮的数"。
 *
 * total 是字符串、available 必填——照 BalanceQuota 的真实形状来。
 * 原来这里写的是 number 且缺 available，靠 `as QuotaEntry` 压住了，typecheck 过不去。
 */
function resultWith(balance: number, spend?: { day: string, startedAt: number }): CollectQuotaResult {
  const quota = Object.fromEntries(
    AGENT_IDS.map(agent => [agent, {
      kind: 'balance', currency: 'CNY', total: String(balance), available: true,
    } satisfies QuotaEntry]),
  ) as Record<AgentId, QuotaEntry>
  return spend === undefined ? { quota } : { quota, spend: spend as never }
}

describe('额度采集接入（把 collectQuota 的结果送进 service）', () => {
  it('采一次就把拉取型的三家写进 service，/state 立刻能读到', async () => {
    const service = createWorkbenchService()
    const collect = vi.fn(async () => resultWith(100))

    const collector = startQuotaCollector({ service, collect, intervalMs: 0, readCredentials: async () => ({}) })
    await collector.collectOnce()
    collector.stop()

    const quota = service.getState().quota
    // claude 不在其中：那一格改由 Claude Code 的 statusLine 推上来（POST /statusline），
    // 循环若跟着写会把刚推的真值覆盖成 unknown。原来这里断言的是四家，
    // 那是 statusLine 这条路存在之前的假设。
    for (const agent of AGENT_IDS.filter(id => id !== 'claude')) {
      expect(quota[agent]).toEqual({ kind: 'balance', currency: 'CNY', total: '100', available: true })
    }
  })

  it('今日消耗账本要在两轮之间传下去，否则每轮都从零重建基线、"今日已花"永远是 0', async () => {
    const service = createWorkbenchService()
    const spend = { day: '2026-08-19', startedAt: 42 }
    // 显式标注入参类型：不写的话 vi.fn 把参数推成零元组，取 calls[1][0] 过不了类型检查。
    const collect = vi.fn(async (_options: CollectQuotaOptions) => resultWith(100, spend))

    const collector = startQuotaCollector({ service, collect, intervalMs: 0, readCredentials: async () => ({}) })
    await collector.collectOnce()
    await collector.collectOnce()
    collector.stop()

    expect(collect.mock.calls[0]?.[0]?.spend).toBeUndefined()
    expect(collect.mock.calls[1]?.[0]?.spend).toEqual(spend)
  })

  it('采集抛错不能把服务带崩，也不能把上一轮已知的额度抹掉', async () => {
    const service = createWorkbenchService()
    let round = 0
    const collect = vi.fn(async () => {
      round += 1
      if (round === 2) throw new Error('网络炸了')
      return resultWith(88)
    })

    const collector = startQuotaCollector({ service, collect, intervalMs: 0, readCredentials: async () => ({}) })
    await collector.collectOnce()
    await expect(collector.collectOnce()).resolves.toBeUndefined()
    collector.stop()

    // 第二轮失败，界面应继续显示最后一次已知值，而不是变成 unknown 或 0。
    expect(service.getState().quota.dsh).toEqual({ kind: 'balance', currency: 'CNY', total: '88', available: true })
  })

  it('stop 之后不再采集——插件卸载后别留一个定时器继续打接口', async () => {
    vi.useFakeTimers()
    try {
      const service = createWorkbenchService()
      const collect = vi.fn(async () => resultWith(1))

      const collector = startQuotaCollector({ service, collect, intervalMs: 1000, readCredentials: async () => ({}) })
      await vi.advanceTimersByTimeAsync(1000)
      const afterFirst = collect.mock.calls.length
      expect(afterFirst).toBeGreaterThan(0)

      collector.stop()
      await vi.advanceTimersByTimeAsync(5000)
      expect(collect.mock.calls.length).toBe(afterFirst)
    }
    finally {
      vi.useRealTimers()
    }
  })
})

describe('startQuotaCollector 与 statusLine 的分工', () => {
  /** 只实现本组用得到的两个方法：写额度、读当前快照。 */
  function stubService(known: Record<string, unknown> = {}) {
    const written: string[] = []
    const quota: Record<string, unknown> = {
      dsh: { kind: 'unknown' as const },
      codex: { kind: 'unknown' as const },
      kimi: { kind: 'unknown' as const },
      claude: { kind: 'unknown' as const },
      ...known,
    }
    const service = {
      setQuota: (agent: string, entry: unknown) => { written.push(agent); quota[agent] = entry },
      getState: () => ({ quota }),
    } as unknown as WorkbenchService
    return { service, written, quota }
  }

  const fourUnknown = {
    dsh: { kind: 'unknown' as const },
    codex: { kind: 'unknown' as const },
    kimi: { kind: 'unknown' as const },
    claude: { kind: 'unknown' as const },
  }

  it('四家都写，claude 也在内 —— 桌面端从不触发 statusLine，只等推送那一格会常年空着', async () => {
    const { service, written } = stubService()

    const collector = startQuotaCollector({
      service,
      intervalMs: 0,
      readCredentials: async () => ({}),
      collect: async () => ({ quota: fourUnknown }),
    })

    await collector.collectOnce()
    collector.stop()

    expect(written.sort()).toEqual(['claude', 'codex', 'dsh', 'kimi'])
  })

  const good = { kind: 'quota' as const, windows: [{ label: '总', left_pct: 5.1 }] }

  function collectorWith(
    service: WorkbenchService,
    quota: Record<string, unknown>,
    extra: Record<string, unknown> = {},
  ) {
    return startQuotaCollector({
      service,
      intervalMs: 0,
      readCredentials: async () => ({}),
      collect: async () => ({ quota: quota as never }),
      ...extra,
    })
  }

  it('一次抖动不把已知值打成未接入 —— Kimi 的接口偶尔一次 fetch failed，看板不该跟着闪', async () => {
    const { service, quota } = stubService({ kimi: good })

    const collector = collectorWith(service, {
      ...fourUnknown,
      kimi: { kind: 'unknown' as const, note: 'Kimi 续期失败：fetch failed' },
    })
    await collector.collectOnce()
    collector.stop()

    expect(quota.kimi).toEqual(good)
  })

  it('连续失败超过宽限就如实标未接入 —— 真掉线、登录态失效必须浮出来', async () => {
    const { service, quota } = stubService({ kimi: good })
    const failed = { kind: 'unknown' as const, note: 'Kimi 登录态已失效' }

    const collector = collectorWith(service, { ...fourUnknown, kimi: failed })
    await collector.collectOnce()
    await collector.collectOnce()
    expect(quota.kimi).toEqual(good)

    await collector.collectOnce()
    collector.stop()

    expect(quota.kimi).toEqual(failed)
  })

  it('取到数就重置宽限计数，抖动不会累积成"用完了"', async () => {
    const { service, quota } = stubService({ kimi: good })
    let ok = false

    const collector = startQuotaCollector({
      service,
      intervalMs: 0,
      readCredentials: async () => ({}),
      collect: async () => ({
        quota: {
          ...fourUnknown,
          kimi: (ok ? good : { kind: 'unknown' as const, note: '抖了一下' }),
        } as never,
      }),
    })

    await collector.collectOnce()
    await collector.collectOnce()
    ok = true
    await collector.collectOnce()
    ok = false
    await collector.collectOnce()
    await collector.collectOnce()
    collector.stop()

    expect(quota.kimi).toEqual(good)
  })

  it('本来就没有已知值时照写 unknown —— 既没数字又没原因最难查', async () => {
    const { service, quota } = stubService()

    const collector = collectorWith(service, {
      ...fourUnknown,
      kimi: { kind: 'unknown' as const, note: '未登录 Kimi' },
    })
    await collector.collectOnce()
    collector.stop()

    expect(quota.kimi).toMatchObject({ note: '未登录 Kimi' })
  })

  it('statusLine 刚推过就不让拉取覆盖 —— 推送是实时的，还带重置时间', async () => {
    const pushed = { kind: 'quota' as const, windows: [{ label: '5h', left_pct: 3, reset_at: 'x' }] }
    const { service, quota } = stubService({ claude: pushed })

    const collector = collectorWith(
      service,
      { ...fourUnknown, claude: { kind: 'quota' as const, windows: [{ label: '5h', left_pct: 8 }] } },
      { claudePushedAt: () => Date.now() },
    )
    await collector.collectOnce()
    collector.stop()

    expect(quota.claude).toEqual(pushed)
  })

  it('推送太旧就让拉取接管 —— 重启后恢复的那份没有时间，一律算旧', async () => {
    const stale = { kind: 'quota' as const, windows: [{ label: '5h', left_pct: 76.5 }] }
    const fresh = { kind: 'quota' as const, windows: [{ label: '5h', left_pct: 8 }] }
    const { service, quota } = stubService({ claude: stale })

    const collector = collectorWith(
      service,
      { ...fourUnknown, claude: fresh },
      { claudePushedAt: () => undefined },
    )
    await collector.collectOnce()
    collector.stop()

    expect(quota.claude).toEqual(fresh)
  })

  it('把当前已知的 claude 额度传进 collect —— 拉不到时它才有得退，不会把真值降级成未接入', async () => {
    const known = { kind: 'quota' as const, windows: [{ label: '5h', left_pct: 27 }] }
    const { service } = stubService({ claude: known })
    let seen: unknown

    const collector = startQuotaCollector({
      service,
      intervalMs: 0,
      readCredentials: async () => ({}),
      collect: async (options) => {
        seen = options.claude
        return { quota: fourUnknown }
      },
    })

    await collector.collectOnce()
    collector.stop()

    expect(seen).toEqual(known)
  })
})

describe('峰谷时段接进采集循环(2026-09-09)', () => {
  it('把当前时间表传给取数层——Ben 在设置里改完,下一轮就按新表分账', async () => {
    const service = createWorkbenchService()
    const collect = vi.fn(async (_options: CollectQuotaOptions) => resultWith(100))
    let schedule = { periods: [{ start: '08:58', end: '12:02' }] }

    const collector = startQuotaCollector({
      service, collect, intervalMs: 0, readCredentials: async () => ({}),
      peakSchedule: () => schedule,
    })
    await collector.collectOnce()
    schedule = { periods: [{ start: '09:00', end: '11:00' }] }
    await collector.collectOnce()
    collector.stop()

    expect(collect.mock.calls[0]?.[0]?.peakSchedule).toEqual({ periods: [{ start: '08:58', end: '12:02' }] })
    expect(collect.mock.calls[1]?.[0]?.peakSchedule).toEqual({ periods: [{ start: '09:00', end: '11:00' }] })
  })

  it('每轮把账本记进落盘账簿——日结要靠它拿到昨天的两笔', async () => {
    const service = createWorkbenchService()
    const spend = { date: '2026-09-09', lastCents: 21000, spentCents: 840, spent: '8.40', peak: '8.40' }
    const collect = vi.fn(async (_options: CollectQuotaOptions) => ({ ...resultWith(100), spend } as never))
    const recorded: unknown[] = []

    const collector = startQuotaCollector({
      service, collect, intervalMs: 0, readCredentials: async () => ({}),
      spendLedger: { record: state => recorded.push(state), resume: () => undefined },
    })
    await collector.collectOnce()
    collector.stop()

    expect(recorded).toEqual([spend])
  })

  it('重启后接着记当天的账:第一轮就把落盘账本当作上一轮传进去', async () => {
    const service = createWorkbenchService()
    const collect = vi.fn(async (_options: CollectQuotaOptions) => resultWith(100))
    const resumed = { date: '2026-09-09', lastCents: 21000, spentCents: 840, spent: '8.40' }

    const collector = startQuotaCollector({
      service, collect, intervalMs: 0, readCredentials: async () => ({}),
      spendLedger: { record: () => {}, resume: () => resumed },
    })
    await collector.collectOnce()
    collector.stop()

    expect(collect.mock.calls[0]?.[0]?.spend).toEqual(resumed)
  })
})
