// @vitest-environment node
/**
 * 按模型周窗口(Fable/Opus)那条路的限频闸门。
 *
 * 2026-08-26 真机根因:这个端点被工作台每 60 秒打一次(collectClaudeOnce 跑的是整轮采集),
 * 而它的惩罚窗口实测 retry-after=161 秒——60 秒就再问一次等于永远待在惩罚里出不来,
 * 于是 429 恒定,Fable 那一栏静默消失。claudeScoped.ts 自己的注释早写着"这个端点不是
 * 给高频轮询用的",只是没人给它装闸门。
 *
 * 闸门要同时办两件事,缺一不可:
 * - **限频**:周窗口一周才变一次,十几分钟问一次绰绰有余。
 * - **缓存**:限频期间必须继续交出上次取到的窗口。否则采集器每分钟跑一轮、
 *   十五轮里十四轮拿不到窗口,那一栏会每分钟闪断一次,比现在更糟。
 */
import { describe, expect, it } from 'vitest'
import { createClaudeScopedGate } from '../src/quota/claudeScopedGate.ts'
import type { QuotaWindow } from '../src/protocol.ts'

const MIN = 60_000
const FABLE: QuotaWindow[] = [{ label: 'Fable', left_pct: 20, reset_at: '2026-09-01T00:00:00.000Z' }]

function gate(minIntervalMs = 15 * MIN) {
  return createClaudeScopedGate({ minIntervalMs })
}

describe('createClaudeScopedGate:限频 + 缓存', () => {
  it('第一次就放行——冷启动不该先等一个间隔', () => {
    expect(gate().shouldFetch(0)).toBe(true)
  })

  it('★成功之后进入限频期:期间不再打端点,但窗口照常交出(不闪断)', () => {
    const g = gate()
    expect(g.shouldFetch(1_000_000)).toBe(true)
    const fresh = g.onSuccess(1_000_000, FABLE)
    expect(fresh.windows).toEqual(FABLE)

    // 采集器一分钟后又跑一轮:不许再打端点,但必须还能交出 Fable。
    expect(g.shouldFetch(1_000_000 + MIN)).toBe(false)
    expect(g.cached().windows).toEqual(FABLE)
    expect(g.cached().note).toBeUndefined()

    // 过了 15 分钟才允许再打一次。
    expect(g.shouldFetch(1_000_000 + 15 * MIN)).toBe(true)
  })

  it('★429 按 retry-after 退避,且不短于限频间隔', () => {
    const g = gate()
    g.onSuccess(0, FABLE)
    // retry-after 161 秒 < 15 分钟间隔 → 取更长的那个,别刚解禁就又去撞。
    g.onFailure(15 * MIN, { retryAfterSec: 161 })
    expect(g.shouldFetch(15 * MIN + 161_000)).toBe(false)
    expect(g.shouldFetch(15 * MIN + 15 * MIN)).toBe(true)
  })

  it('retry-after 比限频间隔还长时听端点的,别自作主张早去', () => {
    const g = gate()
    g.onFailure(0, { retryAfterSec: 3600 })
    expect(g.shouldFetch(30 * MIN)).toBe(false)
    expect(g.shouldFetch(3_600_000)).toBe(true)
  })

  it('★一个窗口都交不出时第一次失败就出声——那一栏是真空了,不许无声', () => {
    // 真机实测 retry-after 会一路涨到 2730 秒(45 分钟)。攒两轮再报＝让人对着
    // 一栏空白干等三刻钟,那正是这次事故里最难查的部分。
    const g = gate()
    const first = g.onFailure(0, { retryAfterSec: 2730 })
    expect(first.windows).toEqual([])
    expect(first.note).toContain('Fable')
  })

  it('★还能交出上次窗口时不算"少一栏",攒够两轮才提示可能陈旧', () => {
    const g = gate()
    g.onSuccess(0, FABLE)

    const first = g.onFailure(60 * MIN, {})
    expect(first.windows).toEqual(FABLE)
    expect(first.note).toBeUndefined() // 栏还在,抖一下不吓人

    const second = g.onFailure(120 * MIN, {})
    expect(second.windows).toEqual(FABLE)
    expect(second.note).toContain('Fable')
  })

  it('★限频期间也要一直带着那句诊断,不能只在真打端点那一轮才出现', () => {
    const g = gate()
    g.onFailure(0, {})
    expect(g.cached().note).toBeTruthy()
  })

  it('失败时保住上次取到的窗口——周窗口陈旧几分钟无所谓,整栏消失才是问题', () => {
    const g = gate()
    g.onSuccess(0, FABLE)
    const failed = g.onFailure(60 * MIN, { retryAfterSec: 161 })
    expect(failed.windows).toEqual(FABLE)
  })

  it('403 那种"要重新登录"的话术当场就报,不用等第二轮', () => {
    const g = gate()
    const out = g.onFailure(0, { note: 'Claude 用量端点 403：需要重新跑 claude auth login' })
    expect(out.note).toContain('claude auth login')
  })

  it('重新取到之后诊断话术要消失,失败计数归零', () => {
    const g = gate()
    g.onFailure(0, {})
    expect(g.cached().note).toBeTruthy()

    const ok = g.onSuccess(120 * MIN, FABLE)
    expect(ok.note).toBeUndefined()
    expect(g.cached().note).toBeUndefined()
    expect(g.cached().windows).toEqual(FABLE)
  })
})
