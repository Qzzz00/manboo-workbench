/**
 * ★ **引擎里动窗口的每一下都走那一家自己的通道**(2026-10-21,卡「派活按家隔离」)。
 *
 * 引擎是所有路(派活 / 捎话 / 替她答 / 电话里再派)动别家窗口的唯一一处,所以通道接在这里:
 * 窗口那一条通道的 `read` / `run` 有硬上限、按家排队;协议 / 命令行 / 接口不进窗口通道。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createActionGate } from '../src/server/actionGate.ts'
import { createJobLog } from '../src/server/jobLog.ts'
import type { Adapter, AdapterCapabilities, AdapterReadResult, Job, JobResult } from '../src/server/engine/adapter.ts'
import { createEngine } from '../src/server/engine/engine.ts'
import { createRegistry } from '../src/server/engine/registry.ts'
import { LANE_STEP_TEXT, createFamilyLanes } from '../src/server/familyLanes.ts'

const ALL_CAPS: AdapterCapabilities = { open: true, send: true, read: true, press: true, approve: true, writeAsk: true, stop: true, openSession: true }

function adapter(input: {
  family: string
  via: JobResult['via']
  run?: (job: Job) => Promise<JobResult>
  read?: (job: Job) => Promise<AdapterReadResult>
}): Adapter {
  return {
    family: input.family,
    via: input.via,
    capabilities: () => Promise.resolve(ALL_CAPS),
    run: input.run ?? (() => Promise.resolve({ delivered: 'confirmed', via: input.via, evidence: 'window' })),
    ...(input.read === undefined ? {} : { read: input.read }),
  }
}

const NAMES: Record<string, string> = { doubao: '豆包', kimi: 'Kimi', codex: 'Codex' }

function setup(adapters: readonly Adapter[]) {
  const now = (): Date => new Date()
  const log = createJobLog({ now })
  const gate = createActionGate({ phaseOf: () => 'open', log, now })
  const registry = createRegistry({ now })
  for (const one of adapters) registry.register(one)
  const lanes = createFamilyLanes({ now, name: f => NAMES[f] ?? f, readCapMs: 20_000, runCapMs: 120_000, probeEveryMs: 15_000 })
  const engine = createEngine({ registry, gate, log, now, name: f => NAMES[f] ?? f, warn: () => {}, lanes, sleep: () => Promise.resolve() })
  return { engine, log, lanes }
}

function readJob(family: string, id = `job-${family}`): Job {
  return { id, itemId: id, family, kind: 'dispatch', target: { kind: 'current' }, text: '派活', marks: ['记号'], expect: 'reply' }
}

const hang = <T>() => new Promise<T>(() => {})

describe('引擎 · 窗口通道按家隔离', () => {
  beforeEach(() => { vi.useFakeTimers({ now: new Date('2026-10-21T08:00:00Z') }) })
  afterEach(() => { vi.useRealTimers() })

  it('豆包读窗挂死:Kimi 照常读回;豆包到上限回「通道堵了」,不说成「它还没回」', async () => {
    const { engine, log } = setup([
      adapter({ family: 'doubao', via: 'window', read: () => hang() }),
      adapter({ family: 'kimi', via: 'window', read: () => Promise.resolve({ via: 'window', evidence: 'window', reply: '好的' }) }),
    ])
    const doubao = engine.read(readJob('doubao'))
    await expect(engine.read(readJob('kimi'))).resolves.toMatchObject({ reply: '好的', evidence: 'window' })
    await vi.advanceTimersByTimeAsync(20_000)
    const out = await doubao
    expect(out.jammed).toBe(true)
    expect(out.reply).toBeUndefined()
    expect(out.why).toContain('豆包')
    expect(out.why).toContain(LANE_STEP_TEXT.read)
    expect(log.all().some(one => one.step === 'jammed' && one.family === 'doubao' && one.job === 'job-doubao')).toBe(true)
  })

  it('堵着的那一家:下一拍一个壳 op 都不发、闸也不扣次数', async () => {
    const read = vi.fn((): Promise<AdapterReadResult> => hang())
    const { engine, log } = setup([adapter({ family: 'doubao', via: 'window', read })])
    void engine.read(readJob('doubao'))
    await vi.advanceTimersByTimeAsync(20_000)
    const passes = log.all().filter(one => one.step === 'gate_pass').length
    const again = await engine.read(readJob('doubao'))
    expect(again).toMatchObject({ jammed: true })
    expect(read).toHaveBeenCalledTimes(1)
    expect(log.all().filter(one => one.step === 'gate_pass').length).toBe(passes)
  })

  it('派活送话挂死:到上限算没送(带「通道堵了」),接着试后面的通道(接口)', async () => {
    const { engine, log } = setup([
      adapter({ family: 'doubao', via: 'window', run: () => hang() }),
      adapter({ family: 'doubao', via: 'api', run: () => Promise.resolve({ delivered: 'confirmed', via: 'api', evidence: 'receipt', reply: '接口回来了' }) }),
    ])
    const job: Job = { ...readJob('doubao'), id: 'd-1', itemId: 'd-1' }
    const sent = engine.run(job)
    await vi.advanceTimersByTimeAsync(120_000)
    const out = await sent
    expect(out).toMatchObject({ delivered: 'confirmed', via: 'api', reply: '接口回来了' })
    const jam = log.all().find(one => one.step === 'jammed')
    expect(jam).toMatchObject({ job: 'd-1', family: 'doubao' })
    expect(jam?.why).toContain(LANE_STEP_TEXT.send)
  })

  it('协议那一条不进窗口通道:同一家的窗口挂死时,协议照常', async () => {
    const { engine, lanes } = setup([
      adapter({ family: 'codex', via: 'protocol', read: () => Promise.resolve({ via: 'protocol', evidence: 'receipt', reply: '协议回来了' }) }),
    ])
    // 先把 codex 的窗口通道占住(一下挂死的读窗):协议那一条照样当场回来。
    void lanes.run('codex', 'read', () => hang())
    expect(lanes.view('codex').busy).toBe(true)
    await expect(engine.read(readJob('codex'))).resolves.toMatchObject({ reply: '协议回来了' })
  })
})
