import { describe, expect, it, vi } from 'vitest'
import type { AgentId, QuotaEntry } from '../src/protocol.ts'
import { AGENT_IDS } from '../src/protocol.ts'
import type { CollectQuotaResult } from '../src/quota/collect.ts'
import { startQuotaCollector } from '../src/quota/collector.ts'
import { createWorkbenchService } from '../src/server/service.ts'

/** 四家一份结果，claude 那格可单独指定。 */
function resultWith(claude: QuotaEntry): CollectQuotaResult {
  const quota = Object.fromEntries(
    AGENT_IDS.map(agent => [agent, {
      kind: 'balance', currency: 'CNY', total: '100', available: true,
    } satisfies QuotaEntry]),
  ) as Record<AgentId, QuotaEntry>
  quota.claude = claude
  return { quota }
}

const GOOD: QuotaEntry = { kind: 'quota', windows: [{ label: '5h', left_pct: 20 }] }
const NEWER: QuotaEntry = { kind: 'quota', windows: [{ label: '5h', left_pct: 12 }] }
const NONE: QuotaEntry = { kind: 'unknown', note: '取不到' }

function start(collect: () => Promise<CollectQuotaResult>, extra = {}) {
  const service = createWorkbenchService()
  const collector = startQuotaCollector({
    service, collect, intervalMs: 0, claudeIntervalMs: 0,
    readCredentials: async () => ({}), ...extra,
  })
  return { service, collector }
}

describe('collectClaudeOnce（60 秒的快节奏那条）', () => {
  it('只动 claude 一格——另外三家的上游是慢变量，跟着提频只会白打接口', async () => {
    const { service, collector } = start(async () => resultWith(GOOD))
    await collector.collectClaudeOnce()
    collector.stop()

    expect(service.getState().quota.claude).toEqual(GOOD)
    // 另外三家保持 service 的初始值（kind: 'unknown'），说明这条路没碰它们
    for (const agent of AGENT_IDS.filter(id => id !== 'claude')) {
      expect(service.getState().quota[agent]?.kind).toBe('unknown')
    }
  })

  it('拿到新数就覆盖', async () => {
    let entry: QuotaEntry = GOOD
    const { service, collector } = start(async () => resultWith(entry))
    await collector.collectClaudeOnce()
    entry = NEWER
    await collector.collectClaudeOnce()
    collector.stop()

    expect(service.getState().quota.claude).toEqual(NEWER)
  })

  it('单轮失败要走宽限——保住上次已知值，绝不把好数字打成"未接入"', async () => {
    let entry: QuotaEntry = GOOD
    const { service, collector } = start(async () => resultWith(entry))
    await collector.collectClaudeOnce()
    entry = NONE

    // GRACE_ROUNDS 是 2：前两轮失败保住旧值
    await collector.collectClaudeOnce()
    expect(service.getState().quota.claude).toEqual(GOOD)
    await collector.collectClaudeOnce()
    expect(service.getState().quota.claude).toEqual(GOOD)

    // 第三轮就该如实标未接入了——真的掉线不能一直藏着
    await collector.collectClaudeOnce()
    expect(service.getState().quota.claude).toEqual(NONE)
    collector.stop()
  })

  it('statusLine 刚推过就不覆盖——终端里那条带 resets_at，比什么都准', async () => {
    const { service, collector } = start(async () => resultWith(GOOD), {
      claudePushedAt: () => Date.now(),
    })
    await collector.collectClaudeOnce()
    collector.stop()

    // 没被写成 GOOD，仍是初始的 unknown
    expect(service.getState().quota.claude?.kind).toBe('unknown')
  })

  it('采完要推快照，否则展示台得等重连才看得到新数字', async () => {
    const onUpdated = vi.fn()
    const { collector } = start(async () => resultWith(GOOD), { onUpdated })
    await collector.collectClaudeOnce()
    collector.stop()

    expect(onUpdated).toHaveBeenCalled()
  })

  it('collect 抛错时什么都不动，也不把错抛给调用方', async () => {
    let entry: QuotaEntry = GOOD
    const { service, collector } = start(async () => {
      if (entry === NONE) throw new Error('炸了')
      return resultWith(entry)
    })
    await collector.collectClaudeOnce()
    entry = NONE

    await expect(collector.collectClaudeOnce()).resolves.toBeUndefined()
    expect(service.getState().quota.claude).toEqual(GOOD)
    collector.stop()
  })

  it('★真的只采 Claude 一家:要带 only 告诉取数层别打另外三家的接口(2026-08-26)', async () => {
    // 上面那条老用例只断言了"另外三家没写进 state"——可它们的接口**照样被打了**。
    // 60 秒一轮 × 四家,DeepSeek/Kimi/Codex 全程陪跑;Claude 那条更要命,
    // 里头还有个"不是给高频轮询用的"usage 端点,一分钟一次直接把自己打进限流。
    const seen: unknown[] = []
    const collect = vi.fn(async (options: unknown) => {
      seen.push((options as { only?: unknown }).only)
      return resultWith(GOOD)
    })
    const { collector } = start(collect as never)

    await collector.collectClaudeOnce()
    expect(seen).toEqual([['claude']])

    // 五分钟那轮是全量,不带 only——否则 DeepSeek 余额和今日消耗账本会停摆。
    await collector.collectOnce()
    expect(seen[1]).toBeUndefined()
    collector.stop()
  })

  it('★Kimi 换发的新 refresh token 必须有人接:60 秒那条路不采 Kimi,就不会再把它换掉又丢掉', async () => {
    // collect 收到 only:['claude'] 时不会走 Kimi,那条"每分钟换一个新 refresh token
    // 又不存盘"的隐患自然消失。这里锁住"60 秒那条不碰 Kimi"这个前提。
    const seen: unknown[] = []
    const collect = vi.fn(async (options: unknown) => {
      seen.push(options)
      return resultWith(GOOD)
    })
    const { collector } = start(collect as never)

    await collector.collectClaudeOnce()
    const only = (seen[0] as { only?: readonly string[] }).only
    expect(only).toEqual(['claude'])
    expect(only).not.toContain('kimi')
    collector.stop()
  })

  it('stop 之后定时器不再触发', async () => {
    vi.useFakeTimers()
    try {
      const collect = vi.fn(async () => resultWith(GOOD))
      const service = createWorkbenchService()
      const collector = startQuotaCollector({
        service, collect, intervalMs: 0, claudeIntervalMs: 1000,
        readCredentials: async () => ({}),
      })
      await vi.advanceTimersByTimeAsync(2500)
      const before = collect.mock.calls.length
      expect(before).toBeGreaterThan(0)

      collector.stop()
      await vi.advanceTimersByTimeAsync(5000)
      expect(collect.mock.calls.length).toBe(before)
    }
    finally {
      vi.useRealTimers()
    }
  })
})
