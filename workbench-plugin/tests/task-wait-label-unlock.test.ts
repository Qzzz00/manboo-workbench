// @vitest-environment node
/**
 * 卡上「卡在哪」那一格(2026-10-12,卡「锁屏派活排队」):排着等电脑解锁的派活说「等你解锁电脑(解锁就送)」,
 * 别的照 `block_reason`。电脑卡片(`TaskCard`)与总览球(`orb`)都只取 `taskWaitLabel` 这一处。
 */
import { describe, expect, it } from 'vitest'
import { taskWaitLabel, UNLOCK_WAIT_LABEL } from '../src/protocol.ts'
import { sanitizeDispatchBlock } from '../src/server/tasks.ts'

describe('taskWaitLabel', () => {
  it('★挂着 unlock → 等你解锁电脑', () => {
    expect(taskWaitLabel({ block_reason: 'input', dispatch_block: { unlock: true } })).toBe(UNLOCK_WAIT_LABEL)
  })
  it('没挂 → 照 block_reason;都没有 → 不标', () => {
    expect(taskWaitLabel({ block_reason: 'input' })).toBe('等你输入')
    expect(taskWaitLabel({})).toBeUndefined()
  })
  it('看板落盘那一道留得住 unlock(别的值不认)', () => {
    const base = { family: 'doubao', kind: 'chat', why: '电脑锁着屏', at: '2026-10-12T01:00:00.000Z' }
    expect(sanitizeDispatchBlock({ ...base, unlock: true })?.unlock).toBe(true)
    expect(sanitizeDispatchBlock({ ...base, unlock: 'yes' })?.unlock).toBeUndefined()
  })
})
