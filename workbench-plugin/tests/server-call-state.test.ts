// @vitest-environment node
/**
 * 「现在在不在通话」(卡 Q,`server/callState.ts`):同通话护栏的 `inCall` 口径,两道兜底同 loadGuard。
 */
import { describe, expect, it } from 'vitest'
import { CALL_STATE_MAX_MS, CALL_STATE_TTL_MS, createCallState } from '../src/server/callState.ts'

describe('callState', () => {
  it('报在通话 → 在;报挂了 → 不在', () => {
    let t = 1_000_000
    const call = createCallState({ now: () => t })
    expect(call.inCall()).toBe(false)
    call.report(true)
    expect(call.inCall()).toBe(true)
    expect(call.view().in_call).toBe(true)
    t += 10_000
    call.report(false)
    expect(call.inCall()).toBe(false)
  })

  it('★工人崩了没报挂断:过了 TTL 自己回来(巡检最多停一分半)', () => {
    let t = 0
    const call = createCallState({ now: () => t })
    call.report(true)
    t += CALL_STATE_TTL_MS - 1
    expect(call.inCall()).toBe(true)
    t += 2
    expect(call.inCall()).toBe(false)
  })

  it('★一通最多算 90 分钟(同通话护栏):「通话状态」卡住了巡检也不会一直停', () => {
    let t = 0
    const call = createCallState({ now: () => t })
    call.report(true)
    while (t < CALL_STATE_MAX_MS) {
      t += 30_000
      call.report(true)
    }
    t += 30_000
    call.report(true)
    expect(call.inCall()).toBe(false)
  })
})
