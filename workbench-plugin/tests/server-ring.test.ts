import { describe, expect, it } from 'vitest'
import { RING_AFTER_SEC, RING_COOLDOWN_SEC } from '../src/protocol.ts'
import type { RingCandidate } from '../src/server/ring.ts'
import { collectRings, shouldRing } from '../src/server/ring.ts'

const T0 = 1_755_500_000

function candidate(patch: Partial<RingCandidate> = {}): RingCandidate {
  return {
    agent: 'dsh',
    session_id: 'a7c1',
    status: 'waiting',
    reason: 'permission_prompt',
    elapsed_sec: RING_AFTER_SEC + 1,
    ...patch,
  }
}

describe('shouldRing（PRD §7.2 三条硬要求）', () => {
  it('等审批且超时才响', () => {
    expect(shouldRing(candidate(), undefined, T0)).toBe(true)
  })

  it('「等你下一句」不响，只有 permission_prompt 才响', () => {
    const noReason: RingCandidate = {
      agent: 'dsh',
      session_id: 'a7c1',
      status: 'waiting',
      elapsed_sec: RING_AFTER_SEC + 1,
    }

    expect(shouldRing(candidate({ reason: 'idle_prompt' }), undefined, T0)).toBe(false)
    expect(shouldRing(noReason, undefined, T0)).toBe(false)
  })

  it('完成永不响铃，哪怕挂了很久', () => {
    expect(shouldRing(
      candidate({ status: 'done', reason: 'stop', elapsed_sec: 86_400 }),
      undefined,
      T0,
    )).toBe(false)
  })

  it('在跑 / 出错 / 掉线都不响', () => {
    expect(shouldRing(candidate({ status: 'running' }), undefined, T0)).toBe(false)
    expect(shouldRing(candidate({ status: 'error', reason: 'error' }), undefined, T0)).toBe(false)
    expect(shouldRing(candidate({ status: 'offline', reason: 'offline' }), undefined, T0)).toBe(false)
  })

  it('没到时长不响，超过才响', () => {
    expect(shouldRing(candidate({ elapsed_sec: RING_AFTER_SEC - 1 }), undefined, T0)).toBe(false)
    expect(shouldRing(candidate({ elapsed_sec: RING_AFTER_SEC }), undefined, T0)).toBe(false)
    expect(shouldRing(candidate({ elapsed_sec: RING_AFTER_SEC + 1 }), undefined, T0)).toBe(true)
  })

  it('同一会话两次响铃间隔不小于冷却时间', () => {
    const lastRing = T0
    expect(shouldRing(candidate(), lastRing, T0 + RING_COOLDOWN_SEC - 1)).toBe(false)
    expect(shouldRing(candidate(), lastRing, T0 + RING_COOLDOWN_SEC)).toBe(true)
  })
})

describe('collectRings', () => {
  it('挑出该响的会话并记下响铃时刻', () => {
    const { rings, ringLog } = collectRings(
      [
        candidate({ session_id: 'w1' }),
        candidate({ session_id: 'w2', reason: 'idle_prompt' }),
        candidate({ session_id: 'd1', status: 'done', reason: 'stop' }),
      ],
      {},
      T0,
    )

    expect(rings).toEqual([{ agent: 'dsh', session_id: 'w1' }])
    expect(ringLog['dsh:w1']).toBe(T0)
  })

  it('冷却期内的下一次 tick 不再响', () => {
    const first = collectRings([candidate()], {}, T0)
    const second = collectRings([candidate()], first.ringLog, T0 + 1)

    expect(first.rings).toHaveLength(1)
    expect(second.rings).toHaveLength(0)
    expect(second.ringLog['dsh:a7c1']).toBe(T0)
  })

  it('冷却结束后可以再响一次', () => {
    const first = collectRings([candidate()], {}, T0)
    const second = collectRings([candidate()], first.ringLog, T0 + RING_COOLDOWN_SEC)

    expect(second.rings).toHaveLength(1)
    expect(second.ringLog['dsh:a7c1']).toBe(T0 + RING_COOLDOWN_SEC)
  })

  it('不改动传入的 ringLog', () => {
    const ringLog = {}
    collectRings([candidate()], ringLog, T0)

    expect(ringLog).toEqual({})
  })
})
