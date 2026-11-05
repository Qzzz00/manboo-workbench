// @vitest-environment node
/**
 * ★ **闸的计数落盘、带过期**(2026-10-21,卡「派活按家隔离」第 3 条)。
 *
 * 从前计数只在内存:一件卡住后同一家被闸拦到重启,而重启又顺手清掉了它 —— 「重启」成了唯一的清通道办法。
 * 现在:重启不丢(落盘)、也不永久封(过期自动清),「重置这一家」清那一家的计数。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { GATE_KEEP_MS, createActionGate, createGateFileStore } from '../src/server/actionGate.ts'

const dirs: string[] = []
afterEach(() => { while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true }) })

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'wb-gate-persist-'))
  dirs.push(dir)
  const clock = { value: Date.parse('2026-10-21T08:00:00Z') }
  const file = join(dir, 'action-gate.json')
  const gateNow = () => createActionGate({ phaseOf: () => 'open', now: () => new Date(clock.value), store: createGateFileStore(file), saveDelayMs: 0 })
  return { clock, file, gateNow }
}

const send = { job: 't-1', family: 'doubao', action: 'dispatch_send' as const }

describe('闸的计数落盘、带过期', () => {
  it('★重启不丢:到顶的那一件,换一个进程照样拦', async () => {
    const { gateNow } = setup()
    const before = gateNow()
    for (let i = 0; i < 3; i += 1) expect(before.allow(send).ok).toBe(true)
    expect(before.allow(send)).toMatchObject({ ok: false, why: 'too_many' })
    await before.flush()
    const after = gateNow()
    expect(after.allow(send)).toMatchObject({ ok: false, why: 'too_many', tried: 3 })
  })

  it('★不永久封:过了保留时长自动清,从头数', async () => {
    const { clock, gateNow } = setup()
    const gate = gateNow()
    for (let i = 0; i < 3; i += 1) gate.allow(send)
    await gate.flush()
    clock.value += GATE_KEEP_MS + 1
    const later = gateNow()
    expect(later.allow(send)).toMatchObject({ ok: true, tried: 1 })
    // 同一个进程里也一样(不靠重启)。
    for (let i = 0; i < 2; i += 1) later.allow(send)
    clock.value += GATE_KEEP_MS + 1
    expect(later.allow(send)).toMatchObject({ ok: true, tried: 1 })
  })

  it('★重置这一家:只清这一家的计数,别家照算;落盘也清', async () => {
    const { gateNow } = setup()
    const gate = gateNow()
    for (let i = 0; i < 3; i += 1) { gate.allow(send); gate.allow({ ...send, family: 'kimi' }) }
    expect(gate.forgetFamily('doubao')).toBe(1)
    expect(gate.allow(send)).toMatchObject({ ok: true, tried: 1 })
    expect(gate.allow({ ...send, family: 'kimi' })).toMatchObject({ ok: false, why: 'too_many' })
    await gate.flush()
    const after = gateNow()
    expect(after.allow({ ...send, family: 'kimi' })).toMatchObject({ ok: false, why: 'too_many' })
    expect(after.allow(send)).toMatchObject({ ok: true, tried: 2 })
  })

  it('坏文件不挡路:当成一条都没有', async () => {
    const { file, gateNow } = setup()
    const { writeFileSync } = await import('node:fs')
    writeFileSync(file, '{坏的')
    expect(gateNow().allow(send)).toMatchObject({ ok: true, tried: 1 })
  })
})
