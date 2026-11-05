/**
 * **一条引擎**(2026-10-02,卡「引擎核心」;设计 `docs/设计-一条引擎替八条管线-2026-10-02.md` 第三节)。
 *
 * 这一份钉的是引擎**自己**那五件事,一条真壳都不碰(适配器全是假的):
 * 挑通道 → 过闸 → 重试 → 换路 → 落账,以及「三种结局原样回」。
 *
 * 维护者 10-02:「不要拿着打补丁的心态」「从底层机制出发」。所以反过来的几条也钉在这儿:
 * - 闸**只接在引擎一处**:收场了的那一件,适配器一次都不许被调到;
 * - 闸拦下的那一下**不许换路**(旧代码里 `handBlocked` 防的就是这个漏);
 * - `RetryableError` 之外的失败**一回都不重试**;
 * - `unconfirmed` 一个字都不说成送到了(原样回)。
 */
import { describe, expect, it } from 'vitest'
import { createActionGate } from '../src/server/actionGate.ts'
import type { JobPhase } from '../src/server/actionGate.ts'
import { createJobLog } from '../src/server/jobLog.ts'
import type { Adapter, AdapterCapabilities, Job, JobResult } from '../src/server/engine/adapter.ts'
import { ENGINE_MAX_RETRIES, RetryableError } from '../src/server/engine/adapter.ts'
import { JOB_GATE_ACTION, UNCONFIRMED_WHY, createEngine, engineJobKey, jobActionText } from '../src/server/engine/engine.ts'
import { createRegistry } from '../src/server/engine/registry.ts'
import { sessionJobId } from '../src/server/jobKey.ts'

const ALL_CAPS: AdapterCapabilities = { open: true, send: true, read: true, press: true, approve: true, writeAsk: true, stop: true, openSession: true }

/** 一条假通道:会哪几样、每一回回什么(回一个 `JobResult`,或者抛)。 */
function fakeAdapter(input: {
  family?: string
  via?: JobResult['via']
  caps?: Partial<AdapterCapabilities>
  answers?: readonly ((job: Job, at: number) => JobResult)[]
  answer?: (job: Job, at: number) => JobResult
}): Adapter & { calls: () => number } {
  let calls = 0
  return {
    family: input.family ?? 'claude',
    via: input.via ?? 'protocol',
    capabilities: () => Promise.resolve({ ...ALL_CAPS, ...input.caps }),
    run: (job) => {
      const at = calls
      calls += 1
      const one = input.answers?.[at] ?? input.answer
      if (one === undefined) throw new Error('这条假通道没给第 ' + (at + 1) + ' 回的答案')
      return Promise.resolve(one(job, at))
    },
    calls: () => calls,
  }
}

function jobOf(over: Partial<Job> = {}): Job {
  return {
    id: 'j-1',
    family: 'claude',
    kind: 'answer',
    target: { kind: 'session', sessionId: 's-1' },
    text: '只回复两个字:收到',
    expect: 'ack',
    ...over,
  }
}

function engineWith(adapters: readonly Adapter[], options: { phase?: JobPhase, maxTries?: number } = {}) {
  const clock = { value: 1_000_000 }
  const now = (): Date => new Date(clock.value)
  const log = createJobLog({ now })
  const gate = createActionGate({
    phaseOf: () => options.phase ?? 'open',
    log,
    now,
    name: family => (family === 'claude' ? 'Claude' : family),
  })
  const registry = createRegistry({ now })
  for (const one of adapters) registry.register(one)
  const slept: number[] = []
  const engine = createEngine({
    registry,
    gate,
    log,
    now,
    name: family => (family === 'claude' ? 'Claude' : family),
    // 睡一下就把表往前拨 —— 闸的「太密」判据与重试的等待用的是同一个时钟。
    sleep: (ms) => { slept.push(ms); clock.value += ms; return Promise.resolve() },
    warn: () => {},
    ...(options.maxTries === undefined ? {} : { maxTries: options.maxTries }),
  })
  return { engine, log, gate, registry, slept, clock }
}

describe('引擎 · 三种结局原样回', () => {
  it('确证:回话、送到哪一段、哪种证据、哪条通道,一格不改', async () => {
    const reply: JobResult = {
      delivered: 'confirmed', reply: '收到', sessionId: 'thread-9', evidence: 'receipt', via: 'protocol',
    }
    const { engine } = engineWith([fakeAdapter({ answer: () => reply })])
    expect(await engine.run(jobOf({ expect: 'reply' }))).toEqual(reply)
  })

  it('未确证:原样回,一个字都不说成送到了', async () => {
    const out: JobResult = { delivered: 'unconfirmed', via: 'window', evidence: 'none', why: '按了发送,记录文件里没等到那条' }
    const { engine } = engineWith([fakeAdapter({ via: 'window', answer: () => out })])
    const got = await engine.run(jobOf())
    expect(got).toEqual(out)
    expect(got.delivered).not.toBe('confirmed')
  })

  it('没送:why 原样交上去', async () => {
    const out: JobResult = { delivered: 'not_sent', via: 'window', evidence: 'none', why: '一扇标准窗口都没有' }
    const { engine } = engineWith([fakeAdapter({ via: 'window', answer: () => out })])
    expect(await engine.run(jobOf())).toEqual(out)
  })
})

describe('引擎 · 过闸(闸只接在这一处)', () => {
  it('这件收场了:适配器一次都不许被调到,回闸那句人话', async () => {
    const adapter = fakeAdapter({ answer: () => ({ delivered: 'confirmed', via: 'protocol' }) })
    const { engine, log } = engineWith([adapter], { phase: 'settled' })
    const got = await engine.run(jobOf())
    expect(adapter.calls()).toBe(0)
    expect(got.delivered).toBe('not_sent')
    expect(got.why).toContain('已经收场')
    const key = sessionJobId('claude', 's-1')
    const steps = log.events(key).map(one => one.step)
    expect(steps).toContain('gate_block')
    // 闸自己记过了 —— 引擎不再补一条「没送」,不然四步表上会多一个不是事实的收场。
    expect(steps).not.toContain('unreadable')
  })

  it('闸拦下的那一下不许换路:同一家还有第二条通道也不走', async () => {
    const protocol = fakeAdapter({ via: 'protocol', answer: () => ({ delivered: 'confirmed', via: 'protocol' }) })
    const window = fakeAdapter({ via: 'window', answer: () => ({ delivered: 'confirmed', via: 'window' }) })
    const { engine } = engineWith([protocol, window], { phase: 'settled' })
    await engine.run(jobOf())
    expect(protocol.calls()).toBe(0)
    expect(window.calls()).toBe(0)
  })

  it('同一件事到顶了:第四回拦下(派活那一样上限 3 回)', async () => {
    const adapter = fakeAdapter({ answer: () => ({ delivered: 'confirmed', via: 'protocol' }) })
    const { engine } = engineWith([adapter])
    const job = jobOf({ kind: 'dispatch', target: { kind: 'new' } })
    for (let at = 0; at < 3; at += 1) expect((await engine.run(job)).delivered).toBe('confirmed')
    const fourth = await engine.run(job)
    expect(fourth.delivered).toBe('not_sent')
    expect(fourth.why).toContain('到顶')
    expect(adapter.calls()).toBe(3)
  })

  /**
   * ★ **一次 run 只过一次闸**:重试与换路都在闸**里面**。
   *
   * 为什么不是「每动那一家一下就问一次」:点选项 / 批准 / 停止 / 捎话那几样的间隔是 1~1.5 秒
   * (`GATE_LIMITS`),而换路那两下相隔只有几毫秒 —— 每下都问一次,换路会被「离上一回太密」拦死。
   * 同一条理由写在 `GATE_LIMITS` 里 `dispatch_send` 间隔为 0 那条注释上(换包那两下)。
   * 一次 run 里面那几下由引擎自己封顶(重试 3 回、换路换到队尾)。
   */
  it('一次 run 只过一次闸:重试三回,账上只有一条放行', async () => {
    const adapter = fakeAdapter({ answer: () => { throw new RetryableError('一扇窗都没露出来', 10) } })
    const { engine, log, slept } = engineWith([adapter])
    const got = await engine.run(jobOf({ itemId: 't-gate' }))
    expect(adapter.calls()).toBe(ENGINE_MAX_RETRIES)
    expect(slept).toEqual([10, 10])
    expect(log.events('t-gate').filter(one => one.step === 'gate_pass')).toHaveLength(1)
    expect(got.delivered).toBe('not_sent')
  })

  it('换路那一下不会被「太密」拦住(点选项那一样间隔 1.5 秒)', async () => {
    const protocol = fakeAdapter({ via: 'protocol', answer: () => ({ delivered: 'not_sent', via: 'protocol', unsupported: true, why: 'socket 只能发话' }) })
    const window = fakeAdapter({ via: 'window', answer: () => ({ delivered: 'confirmed', via: 'window', evidence: 'window' }) })
    const { engine } = engineWith([protocol, window])
    const got = await engine.run(jobOf({ kind: 'press', text: '允许一次', expect: 'none' }))
    expect(got.delivered).toBe('confirmed')
    expect(got.via).toBe('window')
  })
})

describe('引擎 · 重试(只有 RetryableError 才重试)', () => {
  it('可重试的失败:等它说的那个 waitMs,再来一回就成了', async () => {
    const adapter = fakeAdapter({
      answers: [
        () => { throw new RetryableError('窗口还没露出来', 1200) },
        () => ({ delivered: 'confirmed', via: 'window', evidence: 'window' }),
      ],
      via: 'window',
    })
    const { engine, slept } = engineWith([adapter])
    expect((await engine.run(jobOf())).delivered).toBe('confirmed')
    expect(adapter.calls()).toBe(2)
    expect(slept).toEqual([1200])
  })

  it('一直可重试:到上限就停(跑 ENGINE_MAX_RETRIES 回),如实回没送', async () => {
    const adapter = fakeAdapter({
      via: 'window',
      answer: () => { throw new RetryableError('一扇窗都没露出来', 5) },
      caps: { openSession: false },
    })
    const { engine, slept } = engineWith([adapter])
    const got = await engine.run(jobOf({ kind: 'dispatch', target: { kind: 'new' } }))
    expect(adapter.calls()).toBe(ENGINE_MAX_RETRIES)
    expect(slept).toHaveLength(ENGINE_MAX_RETRIES - 1)
    expect(got.delivered).toBe('not_sent')
    expect(got.evidence).toBe('none')
    expect(got.why).toContain(`${ENGINE_MAX_RETRIES} 回`)
    expect(got.why).toContain('Claude')
  })

  it('别的失败:一回都不重试,把它那句原话交上去', async () => {
    const adapter = fakeAdapter({ answer: () => { throw new Error('壳没连上') } })
    const { engine, slept } = engineWith([adapter])
    const got = await engine.run(jobOf())
    expect(adapter.calls()).toBe(1)
    expect(slept).toEqual([])
    expect(got).toEqual({ delivered: 'not_sent', via: 'protocol', evidence: 'none', why: '壳没连上' })
  })
})

describe('引擎 · 换路(unsupported 才换)', () => {
  it('协议这条做不了按键 → 换窗口那条(Claude 的 press)', async () => {
    const protocol = fakeAdapter({ via: 'protocol', answer: () => ({ delivered: 'not_sent', via: 'protocol', unsupported: true, why: 'socket 只能发话' }) })
    const window = fakeAdapter({ via: 'window', answer: () => ({ delivered: 'confirmed', via: 'window', evidence: 'window' }) })
    const { engine, log } = engineWith([protocol, window])
    const got = await engine.run(jobOf({ kind: 'press', text: '允许一次', expect: 'none' }))
    expect(got.delivered).toBe('confirmed')
    expect(got.via).toBe('window')
    expect(protocol.calls()).toBe(1)
    expect(window.calls()).toBe(1)
    // 换过路看得出来:账上两条「指派」。
    const key = sessionJobId('claude', 's-1')
    expect(log.events(key).filter(one => one.step === 'assigned')).toHaveLength(2)
  })

  it('没有第二条通道:如实回没送 + unsupported,人话里有「哪一样」', async () => {
    const protocol = fakeAdapter({ via: 'protocol', answer: () => ({ delivered: 'not_sent', via: 'protocol', unsupported: true, why: 'socket 只能发话' }) })
    const { engine } = engineWith([protocol])
    const got = await engine.run(jobOf({ kind: 'stop', text: '', expect: 'none' }))
    expect(got.delivered).toBe('not_sent')
    expect(got.unsupported).toBe(true)
    expect(got.why).toContain(jobActionText('stop'))
    expect(got.why).toContain('socket 只能发话')
  })

  it('一条会这一样的通道都没登记:不调任何适配器,如实说', async () => {
    const protocol = fakeAdapter({ via: 'protocol', caps: { stop: false }, answer: () => ({ delivered: 'confirmed', via: 'protocol' }) })
    const { engine } = engineWith([protocol])
    const got = await engine.run(jobOf({ kind: 'stop', text: '', expect: 'none' }))
    expect(protocol.calls()).toBe(0)
    expect(got.delivered).toBe('not_sent')
    expect(got.unsupported).toBe(true)
    expect(got.why).toContain('没有一条能')
  })

  it('这一家一条通道都没有:绝不抛,如实回没送', async () => {
    const { engine } = engineWith([])
    const got = await engine.run(jobOf({ family: 'doubao' }))
    expect(got.delivered).toBe('not_sent')
    expect(got.unsupported).toBe(true)
  })
})

describe('引擎 · 落账(四步查得回来)', () => {
  it('确证 + 回话:指派 → 投递(看见了)→ 回了,证据记在账上', async () => {
    const { engine, log } = engineWith([fakeAdapter({
      answer: () => ({ delivered: 'confirmed', reply: '收到', via: 'protocol', evidence: 'receipt' }),
    })])
    await engine.run(jobOf({ itemId: 't-7', expect: 'reply' }))
    const trace = log.trace('t-7')
    expect(trace.assigned?.step).toBe('assigned')
    expect(trace.delivered?.step).toBe('seen')
    expect(trace.finished?.step).toBe('replied')
    expect(trace.assigned?.family).toBe('claude')
    expect(trace.delivered?.action).toBe(JOB_GATE_ACTION.answer)
    expect(trace.delivered?.why).toContain('回执')
  })

  it('未确证:投递那一格记成 sent,why 写明没核上', async () => {
    const { engine, log } = engineWith([fakeAdapter({ answer: () => ({ delivered: 'unconfirmed', via: 'window' }) })])
    await engine.run(jobOf({ itemId: 't-8' }))
    const trace = log.trace('t-8')
    expect(trace.delivered?.step).toBe('sent')
    expect(trace.delivered?.why).toBe(UNCONFIRMED_WHY)
    expect(trace.finished).toBeUndefined()
  })

  it('没送:账上记一条「没送」,why 是适配器那句人话', async () => {
    const { engine, log } = engineWith([fakeAdapter({
      answer: () => ({ delivered: 'not_sent', via: 'window', why: '一扇标准窗口都没有' }),
    })])
    await engine.run(jobOf({ itemId: 't-9' }))
    const trace = log.trace('t-9')
    /*
     * ★ 2026-10-02(卡「引擎接线与删复制品」):这一步从前**暂借** `unreadable` 记
     * (交接「引擎核心」第六节第 3 条留的那个口子),于是账上分不出「那扇窗读不到」与
     * 「这一家压根没这条通道 / 壳没连上」。`jobLog` 加了一步 `not_sent`,这里记它。
     */
    expect(trace.finished?.step).toBe('not_sent')
    expect(trace.finished?.why).toBe('一扇标准窗口都没有')
  })

  it('账上没有她的话:每一条事件里都不出现送进去的正文', async () => {
    const { engine, log } = engineWith([fakeAdapter({
      answer: () => ({ delivered: 'confirmed', reply: '收到', via: 'protocol', evidence: 'receipt' }),
    })])
    const job = jobOf({ itemId: 't-10', text: '这句是她的原话,一个字都不许进账', expect: 'reply' })
    await engine.run(job)
    for (const one of log.all()) expect(JSON.stringify(one)).not.toContain('她的原话')
  })

  it('键只有一处定法:有事项用事项 id,没有用会话键,新开一条用这件自己的 id', () => {
    expect(engineJobKey(jobOf({ itemId: 't-1' }))).toBe('t-1')
    expect(engineJobKey(jobOf())).toBe(sessionJobId('claude', 's-1'))
    expect(engineJobKey(jobOf({ target: { kind: 'new' } }))).toBe('j-1')
  })

  it('账上记的是真动了的那个包', async () => {
    const adapter = fakeAdapter({ family: 'doubao', via: 'window', answer: () => ({ delivered: 'confirmed', via: 'window', evidence: 'window' }) })
    const clock = { value: 0 }
    const now = (): Date => new Date(clock.value)
    const log = createJobLog({ now })
    const gate = createActionGate({ phaseOf: () => 'open', log, now })
    const registry = createRegistry({ now, installed: () => [{ bundle_id: 'com.work.pc.doubao' }] })
    registry.register(adapter)
    const engine = createEngine({ registry, gate, log, now, warn: () => {} })
    await engine.run(jobOf({ family: 'doubao', itemId: 't-11', target: { kind: 'new' }, kind: 'dispatch' }))
    expect(log.trace('t-11').assigned?.bundle_id).toBe('com.work.pc.doubao')
  })
})
