// @vitest-environment node
/**
 * ★ **派活进锁屏等待队列**(2026-10-12,卡「锁屏派活排队」;交接 `docs/交接-1012-锁屏派活排队.md`)。
 *
 * 10-03 那张卡没让派活排队,理由是「另一只手成了就会派两遍」。这一份钉的是补上的那几样:
 *
 * ① 派活按**这件事**去重(事项 id + 派给哪家),不按那句话 —— 同一件事再派一次是**换掉**排着的那条,不排第二条;
 * ② 窗口那只手撞上锁屏,**不靠窗口的手(接口 / 命令行)接着试**;成了就不排;
 * ③ 排着的时候同一件事经别的手送成了 → 排着那条**撤掉**并记一行;
 * ④ 解锁重送之前问一句「这件事还在等吗」,不在等了就撤掉、不送;
 * ⑤ 只有带 `waitUnlock` 且有事项 id 的派活才排(接得住「解锁后回到正常流程」的只有派活那一条路)。
 */
import { describe, expect, it } from 'vitest'
import { createActionGate } from '../src/server/actionGate.ts'
import { createJobLog } from '../src/server/jobLog.ts'
import type { Adapter, AdapterCapabilities, Job, JobResult } from '../src/server/engine/adapter.ts'
import { createEngine, engineJobKey, LOCK_QUEUE_KINDS, LOCK_WITHDRAW_LOG } from '../src/server/engine/engine.ts'
import { createLockQueue, drainLockQueue, lockQueueKey } from '../src/server/engine/lockQueue.ts'
import { createRegistry } from '../src/server/engine/registry.ts'
import { SCREEN_LOCK_MARK, screenLockedSay } from '../src/server/screenLock.ts'

const ALL_CAPS: AdapterCapabilities = { open: true, send: true, read: true, press: true, approve: true, writeAsk: true, stop: true, openSession: true }
const NAMES: Readonly<Record<string, string>> = { doubao: '豆包', kimi: 'Kimi' }

function adapterOf(input: { family: string, via: JobResult['via'], answer: (job: Job, at: number) => JobResult }): Adapter & { calls: () => number } {
  let calls = 0
  return {
    family: input.family,
    via: input.via,
    capabilities: () => Promise.resolve(ALL_CAPS),
    run: (job) => {
      const at = calls
      calls += 1
      return Promise.resolve(input.answer(job, at))
    },
    calls: () => calls,
  }
}

const LOCKED: JobResult = { delivered: 'not_sent', via: 'none', evidence: 'none', screenLocked: true, why: `${SCREEN_LOCK_MARK},窗口型的家这会儿送不进` }
const API_OK: JobResult = { delivered: 'confirmed', via: 'api', evidence: 'receipt', reply: '好的,三版封面思路如下' }
const API_DOWN: JobResult = { delivered: 'not_sent', via: 'api', evidence: 'none', why: '接口这会儿连不上' }
const WINDOW_OK: JobResult = { delivered: 'confirmed', via: 'window', evidence: 'transcript' }

function harness(adapters: readonly Adapter[], queue = createLockQueue()) {
  const now = (): Date => new Date('2026-10-12T01:00:00.000Z')
  const log = createJobLog({ now })
  const gate = createActionGate({ phaseOf: () => 'open', log, now, name: family => NAMES[family] ?? family })
  const registry = createRegistry({ now })
  for (const one of adapters) registry.register(one)
  const lines: string[] = []
  const engine = createEngine({
    registry,
    gate,
    log,
    now,
    name: family => NAMES[family] ?? family,
    sleep: () => Promise.resolve(),
    warn: line => lines.push(line),
    lockQueue: { add: job => queue.add(job), withdraw: job => queue.withdraw(job) },
  })
  return { engine, log, queue, lines }
}

function dispatchOf(over: Partial<Job> = {}): Job {
  return {
    id: 't-cover',
    itemId: 't-cover',
    family: 'doubao',
    kind: 'dispatch',
    target: { kind: 'new' },
    text: '【派活 t-cover】帮我把这篇的封面做三版',
    expect: 'ack',
    waitUnlock: true,
    ...over,
  }
}

function stepsOf(log: ReturnType<typeof createJobLog>, job: Job): string[] {
  return log.events(engineJobKey(job)).map(one => one.step).filter(one => one !== 'gate_pass' && one !== 'gate_block')
}

describe('① 派活按「这件事」去重(事项 id + 派给哪家)', () => {
  it('派活进了排队的那几种;点键那几样照旧不排', () => {
    expect(LOCK_QUEUE_KINDS).toContain('dispatch')
    for (const kind of ['press', 'write_ask', 'stop'] as const) expect(LOCK_QUEUE_KINDS).not.toContain(kind)
  })

  it('★同一件事、同一家:那句话变了也是同一个键(重派时提示词里的记号会变)', () => {
    const a = dispatchOf()
    const b = dispatchOf({ text: '【派活 t-cover 重派】帮我把这篇的封面做三版', id: 'other-id' })
    expect(lockQueueKey(a)).toBe(lockQueueKey(b))
    expect(lockQueueKey(dispatchOf({ family: 'kimi' }))).not.toBe(lockQueueKey(a))
    expect(lockQueueKey(dispatchOf({ itemId: 't-other' }))).not.toBe(lockQueueKey(a))
  })

  it('★★同一件事再排一次 = **换掉**那一条(不排第二条,回「排着」;排进来的时刻与重送回数不变)', () => {
    const queue = createLockQueue({ now: () => new Date('2026-10-12T01:00:00.000Z') })
    expect(queue.add(dispatchOf())).toBe(true)
    queue.retried(lockQueueKey(dispatchOf()))
    expect(queue.add(dispatchOf({ text: '换了一句' }))).toBe(true)
    const rows = queue.list()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.job.text).toBe('换了一句')
    expect(rows[0]?.tries).toBe(1)
    expect(rows[0]?.at).toBe('2026-10-12T01:00:00.000Z')
  })

  it('withdraw:拿掉同一件事那一条,回拿没拿;别家 / 别的事不动', () => {
    const queue = createLockQueue()
    queue.add(dispatchOf())
    queue.add(dispatchOf({ family: 'kimi' }))
    expect(queue.withdraw(dispatchOf({ text: '别的说法' }))).toBe(true)
    expect(queue.withdraw(dispatchOf())).toBe(false)
    expect(queue.list().map(one => one.job.family)).toEqual(['kimi'])
  })

  it('替她答那几样的去重一字不变(同一句话排两次 → 第二次回 false)', () => {
    const queue = createLockQueue()
    const answer: Job = { id: 'session:kimi/x', family: 'kimi', kind: 'answer', target: { kind: 'session', sessionId: 'x' }, text: '好', expect: 'ack' }
    expect(queue.add(answer)).toBe(true)
    expect(queue.add(answer)).toBe(false)
  })
})

describe('② 窗口那只手撞上锁屏:不改走 App 之外的路,排队等解锁(维护者 10-12 拍板)', () => {
  it('★★豆包 window + api:窗口锁着 → **接口一次都不调**,排进队(答案要进她豆包 App 里那段对话)', async () => {
    const window = adapterOf({ family: 'doubao', via: 'window', answer: () => LOCKED })
    const api = adapterOf({ family: 'doubao', via: 'api', answer: () => API_OK })
    const h = harness([window, api])
    const out = await h.engine.run(dispatchOf())
    expect(out.screenLocked).toBe(true)
    expect(out.lockQueued).toBe(true)
    expect(api.calls()).toBe(0)
    expect(h.queue.list().map(one => one.job.itemId)).toEqual(['t-cover'])
  })

  it('★★窗口锁着、接口也没成 → 排进队、账上最后一步是 waiting、回包带 lockQueued、那句话说「解锁了我就把这件派出去」', async () => {
    const h = harness([
      adapterOf({ family: 'doubao', via: 'window', answer: () => LOCKED }),
      adapterOf({ family: 'doubao', via: 'api', answer: () => API_DOWN }),
    ])
    const job = dispatchOf()
    const out = await h.engine.run(job)
    expect(out.screenLocked).toBe(true)
    expect(out.lockQueued).toBe(true)
    expect(out.why).toContain('解锁了我就把这件派出去')
    expect(h.queue.list().map(one => one.job.itemId)).toEqual(['t-cover'])
    expect(stepsOf(h.log, job).at(-1)).toBe('waiting')
  })

  it('只有窗口一只手(Kimi)→ 排进队', async () => {
    const h = harness([adapterOf({ family: 'kimi', via: 'window', answer: () => LOCKED })])
    const out = await h.engine.run(dispatchOf({ family: 'kimi' }))
    expect(out.lockQueued).toBe(true)
    expect(h.queue.list()).toHaveLength(1)
  })

  it('★没带 waitUnlock(界面上点「送进窗口」、返工打回)→ 不排,如实说「解锁了再叫我一次」', async () => {
    const h = harness([adapterOf({ family: 'kimi', via: 'window', answer: () => LOCKED })])
    const { waitUnlock: _drop, ...rest } = dispatchOf({ family: 'kimi' })
    void _drop
    const out = await h.engine.run(rest)
    expect(out.lockQueued).toBeUndefined()
    expect(out.why).toContain('解锁了再叫我一次')
    expect(h.queue.list()).toEqual([])
  })

  it('★没有事项 id(电话里新开一条)→ 不排(去重靠事项,没有就不排,不靠时间猜)', async () => {
    const h = harness([adapterOf({ family: 'kimi', via: 'window', answer: () => LOCKED })])
    const { itemId: _drop, ...rest } = dispatchOf({ family: 'kimi' })
    void _drop
    const out = await h.engine.run(rest)
    expect(out.lockQueued).toBeUndefined()
    expect(h.queue.list()).toEqual([])
  })

  it('替她答照旧:撞上锁屏就停,后面那条一次都不调(换条通道不是同一段对话)', async () => {
    // 替她答的通道次序是 VIA_ORDER(… file > window):先走的那条撞上锁屏,后面那条留着看调没调。
    const first = adapterOf({ family: 'kimi', via: 'file', answer: () => LOCKED })
    const second = adapterOf({ family: 'kimi', via: 'window', answer: () => ({ delivered: 'confirmed', via: 'window', evidence: 'window' }) })
    const h = harness([first, second])
    await h.engine.run({ id: 'session:kimi/x', family: 'kimi', kind: 'answer', target: { kind: 'session', sessionId: 'x' }, text: '好', expect: 'ack' })
    expect(second.calls()).toBe(0)
  })
})

describe('③ 另一只手成了,就把排着的那条撤掉', () => {
  it('★★排着一条;解锁后同一件事又派了一次、窗口送成 → 排着那条撤掉,记一行', async () => {
    let locked = true
    const h = harness([
      adapterOf({ family: 'doubao', via: 'window', answer: () => (locked ? LOCKED : WINDOW_OK) }),
      adapterOf({ family: 'doubao', via: 'api', answer: () => API_DOWN }),
    ])
    await h.engine.run(dispatchOf())
    expect(h.queue.list()).toHaveLength(1)
    locked = false
    const out = await h.engine.run(dispatchOf({ text: '【派活 t-cover】再派一次' }))
    expect(out.delivered).toBe('confirmed')
    expect(h.queue.list()).toEqual([])
    expect(h.lines.some(line => line.includes(LOCK_WITHDRAW_LOG))).toBe(true)
  })

  it('派给别家送成了,不动排着的那一家(键里有家名)', async () => {
    const h = harness([
      adapterOf({ family: 'kimi', via: 'window', answer: () => LOCKED }),
      adapterOf({ family: 'doubao', via: 'api', answer: () => API_OK }),
    ])
    await h.engine.run(dispatchOf({ family: 'kimi' }))
    await h.engine.run(dispatchOf({ family: 'doubao' }))
    expect(h.queue.list().map(one => one.job.family)).toEqual(['kimi'])
  })

  it('★反过来:排着那条解锁后送成了 → 从队里拿掉,再解锁一次不会再送', async () => {
    let locked = true
    const window = adapterOf({ family: 'kimi', via: 'window', answer: () => (locked ? LOCKED : { delivered: 'confirmed', via: 'window', evidence: 'window' }) })
    const h = harness([window])
    await h.engine.run(dispatchOf({ family: 'kimi' }))
    locked = false
    const first = await drainLockQueue({ queue: h.queue, run: job => h.engine.run(job), gapMs: 0, warn: () => {} })
    expect(first.sent).toBe(1)
    const again = await drainLockQueue({ queue: h.queue, run: job => h.engine.run(job), gapMs: 0, warn: () => {} })
    expect(again.sent).toBe(0)
    expect(window.calls()).toBe(2)
  })
})

describe('④ 解锁重送之前问一句:这件事还在等吗', () => {
  it('★★不在等了(换给别家 / 收了卡 / 别的手已经派出去)→ 撤掉、一下都不送、记一行', async () => {
    const queue = createLockQueue()
    queue.add(dispatchOf())
    const runs: Job[] = []
    const lines: string[] = []
    const report = await drainLockQueue({
      queue,
      run: async (job) => { runs.push(job); return API_OK },
      stillWanted: async () => '这件事已经派给 Kimi 了',
      gapMs: 0,
      warn: line => lines.push(line),
    })
    expect(runs).toEqual([])
    expect(queue.list()).toEqual([])
    expect(report).toEqual({ sent: 0, kept: 0, failed: 0, withdrawn: 1 })
    expect(lines.some(line => line.includes(LOCK_WITHDRAW_LOG) && line.includes('这件事已经派给 Kimi 了'))).toBe(true)
  })

  it('还在等 → 照常送', async () => {
    const queue = createLockQueue()
    queue.add(dispatchOf())
    const report = await drainLockQueue({ queue, run: async () => API_OK, stillWanted: async () => undefined, gapMs: 0, warn: () => {} })
    expect(report).toEqual({ sent: 1, kept: 0, failed: 0 })
  })
})

describe('那一句话', () => {
  it('派活排上了:说「这件派出去」,不说「这句送进去」', () => {
    const say = screenLockedSay({ agentName: '豆包', queued: true, what: 'dispatch' })
    expect(say).toContain('解锁了我就把这件派出去')
    expect(say).not.toContain('这句送进去')
    expect(screenLockedSay({ agentName: '豆包', queued: true })).toContain('解锁了我就把这句送进去')
  })
})
