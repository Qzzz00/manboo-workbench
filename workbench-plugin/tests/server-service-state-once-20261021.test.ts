/**
 * 会话表**同一拍只算一份**(2026-10-21 急修「8791 空转」)。
 *
 * 一次 `/state` 里,派活对象表、登记表、「在等你」各自回头问会话表,一层套一层:
 * 每家 × 每条会话 × 再问一次 `getState()`,每一次都把会话表连「在等你」那一层重算一遍 ——
 * 真机采样里光这一处就占了 `composeState` 一半的时间。
 *
 * 钉四件事:
 *   ① 同一段同步执行、同一秒、会话表没改过 → 同一份(叠层只算一次);
 *   ② 中间改了会话表(上报 / 已读 / 补标题 / 额度见底 / 上游掉线)→ 立刻是新的;
 *   ③ 换了一秒 → 新的;
 *   ④ 过了一个微任务 → 新的(「在等你」那一层是异步判完的,下一拍要看得见)。
 */
import { describe, expect, it } from 'vitest'
import type { SessionView } from '../src/protocol.ts'
import { createWorkbenchService } from '../src/server/service.ts'

const T0 = 1_755_500_000

function bench() {
  let now = T0
  let overlays = 0
  const service = createWorkbenchService({
    now: () => now,
    overlay: (views: readonly SessionView[]) => { overlays += 1; return views },
  })
  return { service, advance: (sec: number) => { now += sec }, overlays: () => overlays }
}

describe('会话表同一拍只算一份', () => {
  it('★同一段同步执行里连问三次:同一份,叠层只算一次', () => {
    const { service, overlays } = bench()
    service.applyEvent({ agent: 'claude', session_id: 's1', type: 'running' })
    const first = service.getState()
    expect(service.getState()).toBe(first)
    expect(service.getState()).toBe(first)
    expect(overlays()).toBe(1)
  })

  it('★中间改了会话表 → 立刻是新的', () => {
    const { service } = bench()
    service.applyEvent({ agent: 'claude', session_id: 's1', type: 'running' })
    const before = service.getState()
    service.applyEvent({ agent: 'claude', session_id: 's2', type: 'waiting', reason: 'permission_prompt' })
    const after = service.getState()
    expect(after).not.toBe(before)
    expect(after.sessions.map(one => one.session_id).sort()).toEqual(['s1', 's2'])

    service.applyEvent({ agent: 'claude', session_id: 's3', type: 'done' })
    const done = service.getState()
    expect(service.markRead('claude', 's3')).toBe(true)
    expect(service.getState()).not.toBe(done)

    const titled = service.getState()
    expect(service.setSessionDetail('claude', 's1', { title: '新标题' })).toBe(true)
    expect(service.getState()).not.toBe(titled)
    expect(service.getState().sessions.find(one => one.session_id === 's1')?.title).toBe('新标题')

    const metered = service.getState()
    service.setSessionMetrics('claude', 's1', { context_tokens: 42 })
    expect(service.getState()).not.toBe(metered)

    const quota = service.getState()
    service.setQuotaExhausted('claude', true)
    expect(service.getState()).not.toBe(quota)

    const online = service.getState()
    service.markUpstreamOffline()
    expect(service.getState()).not.toBe(online)
    expect(service.getState().stale).toBe(true)
  })

  it('一分钟一收的会话表真丢了几条 → 新的', () => {
    const { service, advance } = bench()
    service.applyEvent({ agent: 'claude', session_id: 'old', type: 'done' })
    advance(8 * 86_400)
    service.applyEvent({ agent: 'claude', session_id: 'new', type: 'running' })
    const before = service.getState()
    expect(before.sessions.map(one => one.session_id).sort()).toEqual(['new', 'old'])
    service.tick()
    const after = service.getState()
    expect(after).not.toBe(before)
    expect(after.sessions.map(one => one.session_id)).toEqual(['new'])
  })

  it('换了一秒 → 新的(在跑的秒数跟着走)', () => {
    const { service, advance } = bench()
    service.applyEvent({ agent: 'claude', session_id: 's1', type: 'running' })
    const first = service.getState()
    advance(5)
    const later = service.getState()
    expect(later).not.toBe(first)
    expect(later.now).not.toBe(first.now)
  })

  it('过了一个微任务 → 新的(异步判完的「在等你」下一拍看得见)', async () => {
    const { service, overlays } = bench()
    const first = service.getState()
    await Promise.resolve()
    expect(service.getState()).not.toBe(first)
    expect(overlays()).toBe(2)
  })
})
