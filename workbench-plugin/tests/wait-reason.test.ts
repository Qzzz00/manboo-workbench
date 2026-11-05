// @vitest-environment node
/**
 * 「等待原因」分类(2026-09-09 傍晚拍板第 4 条):等审批 / 等你输入 / 额度不足 / 出错。
 *
 * 纪律(D13):**能可靠判定才填,判不出就不填**。这份测试钉死三件事:
 * ① 协议层四个稳定 id 与中文名;
 * ② 会话状态机原样携带、状态一变就重算(不沿用上一条的原因);
 * ③ 额度不足由采集器给会话打标,而且**响铃规则不变**——仍只有等审批(permission_prompt)响。
 */
import { describe, expect, it, vi } from 'vitest'
import type { QuotaEntry, SessionView } from '../src/protocol.ts'
import type { CollectQuotaResult } from '../src/quota/collect.ts'
import { RING_AFTER_SEC, WAIT_REASONS, WAIT_REASON_TITLES } from '../src/protocol.ts'
import { quotaExhausted, startQuotaCollector } from '../src/quota/collector.ts'
import { shouldRing } from '../src/server/ring.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { applyEvent, applyQuotaOverlay, emptySessionStore, toSessionViews } from '../src/server/sessions.ts'

const T0 = 1_755_500_000

describe('协议层:四个稳定 id', () => {
  it('id 固定四个,中文名是 Ben 拍板的四个词', () => {
    expect(WAIT_REASONS).toEqual(['approval', 'input', 'quota', 'error'])
    expect(WAIT_REASON_TITLES).toEqual({
      approval: '等审批',
      input: '等你输入',
      quota: '额度不足',
      error: '出错',
    })
  })
})

describe('会话状态机:wait_reason 原样带上,状态一变就重算', () => {
  it('上报带 wait_reason → 视图里有;不带 → 视图里没有这个字段(不填 0、不填默认值)', () => {
    let store = emptySessionStore()
    store = applyEvent(store, {
      agent: 'claude', session_id: 'a', type: 'waiting', reason: 'permission_prompt', wait_reason: 'approval',
    }, T0)
    store = applyEvent(store, { agent: 'kimi', session_id: 'b', type: 'waiting' }, T0)

    const views = toSessionViews(store, T0)
    expect(views.find(v => v.session_id === 'a')?.wait_reason).toBe('approval')
    expect(views.find(v => v.session_id === 'b')).not.toHaveProperty('wait_reason')
  })

  it('下一条状态不带 wait_reason 就清掉——原因是「此刻为什么停」,不是会话的属性', () => {
    let store = emptySessionStore()
    store = applyEvent(store, {
      agent: 'dsh', session_id: 'a', type: 'waiting', reason: 'permission_prompt', wait_reason: 'approval',
    }, T0)
    store = applyEvent(store, { agent: 'dsh', session_id: 'a', type: 'running' }, T0 + 5)

    expect(toSessionViews(store, T0 + 5)[0]).not.toHaveProperty('wait_reason')
  })
})

function view(over: Partial<SessionView>): SessionView {
  return {
    agent: 'dsh', session_id: 'x', project: 'p', status: 'waiting',
    elapsed_sec: 1, unread: false, updated_at: '2026-09-09T00:00:00.000Z', ...over,
  }
}

describe('额度不足的叠加(applyQuotaOverlay)', () => {
  it('那一家额度见底 → 它的 waiting / error / done 会话标「额度不足」;running / offline 不碰', () => {
    const out = applyQuotaOverlay([
      view({ session_id: 'w', status: 'waiting' }),
      view({ session_id: 'e', status: 'error', wait_reason: 'error' }),
      view({ session_id: 'd', status: 'done' }),
      view({ session_id: 'r', status: 'running' }),
      view({ session_id: 'o', status: 'offline' }),
    ], new Set(['dsh']))
    const by = Object.fromEntries(out.map(v => [v.session_id, v.wait_reason]))
    expect(by).toEqual({ w: 'quota', e: 'quota', d: 'quota', r: undefined, o: undefined })
  })

  it('来源自己判出的「等审批 / 等你输入」是直接证据,不被额度覆盖', () => {
    const out = applyQuotaOverlay([
      view({ session_id: 'a', wait_reason: 'approval' }),
      view({ session_id: 'i', wait_reason: 'input' }),
    ], new Set(['dsh']))
    expect(out.map(v => v.wait_reason)).toEqual(['approval', 'input'])
  })

  it('别家额度见底与我无关;没有一家见底时返回同一个数组引用', () => {
    const views = [view({ agent: 'claude', session_id: 'a' })]
    expect(applyQuotaOverlay(views, new Set(['kimi']))[0]).not.toHaveProperty('wait_reason')
    expect(applyQuotaOverlay(views, new Set())).toBe(views)
  })
})

describe('采集器:什么算「额度见底」(quotaExhausted)', () => {
  it('余额型:不可用、或余额 ≤ 0', () => {
    expect(quotaExhausted({ kind: 'balance', currency: 'CNY', total: '0.00', available: true })).toBe(true)
    expect(quotaExhausted({ kind: 'balance', currency: 'CNY', total: '12.5', available: false })).toBe(true)
    expect(quotaExhausted({ kind: 'balance', currency: 'CNY', total: '12.5', available: true })).toBe(false)
  })

  it('窗口型:整家共用的窗口(5h / 周 / 总)剩 0 才算;按模型的窗口归零不算——那只挡一个模型', () => {
    expect(quotaExhausted({ kind: 'quota', windows: [{ label: '5h', left_pct: 0 }, { label: '周', left_pct: 40 }] })).toBe(true)
    expect(quotaExhausted({ kind: 'quota', windows: [{ label: '总', left_pct: 0 }] })).toBe(true)
    expect(quotaExhausted({ kind: 'quota', windows: [{ label: '5h', left_pct: 3 }, { label: 'Claude Fable 5.1', left_pct: 0 }] })).toBe(false)
    expect(quotaExhausted({ kind: 'quota', windows: [] })).toBe(false)
  })

  it('unknown 不算——取不到数不等于没额度(D13)', () => {
    expect(quotaExhausted({ kind: 'unknown' })).toBe(false)
  })

  it('★采一轮:DeepSeek 余额归零 → DSH 的等待会话标额度不足;下一轮回血就摘掉', async () => {
    let now = T0
    const service = createWorkbenchService({ now: () => now })
    service.applyEvent({ agent: 'dsh', session_id: 'a', type: 'error', reason: 'error', wait_reason: 'error' })
    service.applyEvent({ agent: 'kimi', session_id: 'k', type: 'waiting' })

    let balance = '0.00'
    // 只有 dsh 出数,另外三家这一轮取不到(unknown)——正是要证明"没见底的那几家不被牵连"。
    const collect = vi.fn(async (): Promise<CollectQuotaResult> => ({
      quota: {
        dsh: { kind: 'balance', currency: 'CNY', total: balance, available: balance !== '0.00' },
        claude: { kind: 'unknown' },
        codex: { kind: 'unknown' },
        kimi: { kind: 'unknown' },
      },
    }))
    const collector = startQuotaCollector({ service, collect, intervalMs: 0, readCredentials: async () => ({}) })

    await collector.collectOnce()
    let sessions = service.getState().sessions
    expect(sessions.find(s => s.session_id === 'a')?.wait_reason).toBe('quota')
    // Kimi 的额度没见底,它的等待会话不被牵连。
    expect(sessions.find(s => s.session_id === 'k')).not.toHaveProperty('wait_reason')

    balance = '30.00'
    now += 60
    await collector.collectOnce()
    sessions = service.getState().sessions
    // 回血后回到来源自己判的原因。
    expect(sessions.find(s => s.session_id === 'a')?.wait_reason).toBe('error')
    collector.stop()
  })
})

describe('响铃规则不变:仍只有等审批响', () => {
  const late = RING_AFTER_SEC + 1
  it('permission_prompt 照响;wait_reason 是什么都不影响', () => {
    expect(shouldRing({ agent: 'dsh', session_id: 'a', status: 'waiting', reason: 'permission_prompt', wait_reason: 'approval', elapsed_sec: late }, undefined, T0)).toBe(true)
    expect(shouldRing({ agent: 'dsh', session_id: 'a', status: 'waiting', reason: 'permission_prompt', wait_reason: 'quota', elapsed_sec: late }, undefined, T0)).toBe(true)
  })

  it('额度不足 / 出错 / 等你输入 都不响——它们不是 permission_prompt', () => {
    for (const wait_reason of ['quota', 'error', 'input'] as const) {
      expect(shouldRing({ agent: 'claude', session_id: 'a', status: 'waiting', reason: 'idle_prompt', wait_reason, elapsed_sec: late }, undefined, T0)).toBe(false)
      expect(shouldRing({ agent: 'claude', session_id: 'a', status: 'error', reason: 'error', wait_reason, elapsed_sec: late }, undefined, T0)).toBe(false)
    }
  })

  it('service.tick 走的也是同一条判定:额度见底不会让一条等你输入的会话响起来', () => {
    let now = T0
    const service = createWorkbenchService({ now: () => now })
    service.applyEvent({ agent: 'claude', session_id: 'a', type: 'waiting', reason: 'idle_prompt', wait_reason: 'input' })
    service.setQuotaExhausted('claude', true)
    now += late
    expect(service.tick()).toEqual([])
  })
})
