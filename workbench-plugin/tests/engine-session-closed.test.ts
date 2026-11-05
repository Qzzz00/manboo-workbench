// @vitest-environment node
/**
 * ★ **往一条没开着的桌面会话捎话:留言等它醒**(2026-10-23,卡「捎话到没开着的会话留言等它醒」)。
 *
 * 07:36 那三下过了闸、协议手回「那条 Claude 会话没开着」—— 桌面端让那条会话闲了一夜后进程没了。
 * 这一份钉的是引擎与那本队自己的几件事(适配器全是假的,一条真 socket 都不碰):
 *
 * ① 协议手回 `sessionClosed`(没开着)→ **排进队** + 账上 `assigned → waiting`(**不是 `not_sent`**),
 *    那句人话换成「那条会话没开着,这句我留着,它一开就送进去」;
 * ② 排不上(没接那本队 / 点键那几样)→ 照旧记 `not_sent`,话也不许说成「我留着」;
 * ③ 同一句两次 → 只排一条;
 * ④ **醒来重送**:登记表出现 socket 的那条会话才送(`drainLockQueue` 的 `shouldSend`),别的留着;
 *    送成了账上接着 `assigned → seen`;
 * ⑤ 排太久自己过期:作废并**记一句**(「那句留言放了 12 小时它都没开,没送,你再说一遍」);
 * ⑥ 锁着屏那一路的旧用例一条不改(那边排的不带 `reason:'closed'`,过期不记这一句)。
 */
import { describe, expect, it } from 'vitest'
import { createActionGate } from '../src/server/actionGate.ts'
import { createJobLog } from '../src/server/jobLog.ts'
import type { Adapter, AdapterCapabilities, Job, JobResult } from '../src/server/engine/adapter.ts'
import { CLAUDE_NOT_OPEN_WHY } from '../src/server/engine/adapters/claude.ts'
import { createEngine, engineJobKey, jobGateActionOf } from '../src/server/engine/engine.ts'
import { createLockQueue, drainLockQueue } from '../src/server/engine/lockQueue.ts'
import { createRegistry } from '../src/server/engine/registry.ts'
import { SESSION_CLOSED_EXPIRED_SAY, SESSION_CLOSED_QUEUED_SAY } from '../src/server/sessionClosed.ts'
import { SESSION_AWAKE_LOG } from '../src/server/sessionAwakeWatch.ts'

const ALL_CAPS: AdapterCapabilities = { open: true, send: true, read: true, press: true, approve: true, writeAsk: true, stop: true, openSession: true }

const NAMES: Readonly<Record<string, string>> = { claude: 'Claude' }

function adapterOf(input: {
  family: string
  via: JobResult['via']
  answer: (job: Job, at: number) => JobResult
}): Adapter & { calls: () => number } {
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

/** 协议手回「那条会话没开着」的那个回包(与 `adapters/claude.ts` 真回的那一份同形)。 */
const CLOSED: JobResult = {
  delivered: 'not_sent',
  via: 'protocol',
  evidence: 'none',
  sessionClosed: true,
  why: CLAUDE_NOT_OPEN_WHY,
}

const SENT: JobResult = { delivered: 'confirmed', via: 'protocol', evidence: 'receipt' }

function harness(options: {
  adapters: readonly Adapter[]
  makeQueue?: (h: { log: ReturnType<typeof createJobLog>, clock: { value: number }, now: () => Date }) => ReturnType<typeof createLockQueue>
}) {
  const clock = { value: Date.parse('2026-10-23T07:36:00.000Z') }
  const now = (): Date => new Date(clock.value)
  const log = createJobLog({ now })
  const gate = createActionGate({ phaseOf: () => 'open', log, now, name: family => NAMES[family] ?? family })
  const registry = createRegistry({ now })
  for (const one of options.adapters) registry.register(one)
  const lines: string[] = []
  const queue = options.makeQueue?.({ log, clock, now })
  const engine = createEngine({
    registry,
    gate,
    log,
    now,
    name: family => NAMES[family] ?? family,
    sleep: (ms) => { clock.value += ms; return Promise.resolve() },
    warn: line => lines.push(line),
    ...(queue === undefined ? {} : { lockQueue: { add: (job, reason) => queue.add(job, reason) } }),
  })
  return { engine, log, gate, registry, lines, clock, queue }
}

/** 账上这一件走过的那几步(闸自己记的 `gate_pass` / `gate_block` 不算 —— 这里看的是引擎那几步)。 */
function stepsOf(log: ReturnType<typeof createJobLog>, job: Job): string[] {
  return log.events(engineJobKey(job)).map(one => one.step).filter(one => one !== 'gate_pass' && one !== 'gate_block')
}

function jobOf(over: Partial<Job> = {}): Job {
  return {
    id: 'j-0736',
    family: 'claude',
    kind: 'relay',
    target: { kind: 'session', sessionId: 'local_1' },
    text: '现在到哪了',
    expect: 'ack',
    ...over,
  }
}

describe('① 那条会话没开着 + 排上队', () => {
  it('★★账上是 assigned → waiting(**不是 not_sent**:记了收场,它一开重送会被闸拦下)', async () => {
    const h = harness({ adapters: [adapterOf({ family: 'claude', via: 'protocol', answer: () => CLOSED })], makeQueue: () => createLockQueue() })
    const job = jobOf()
    await h.engine.run(job)
    const steps = stepsOf(h.log, job)
    expect(steps).toEqual(['assigned', 'waiting'])
    expect(steps).not.toContain('not_sent')
  })

  it('★★真排进了队(它一开就送)', async () => {
    const h = harness({ adapters: [adapterOf({ family: 'claude', via: 'protocol', answer: () => CLOSED })], makeQueue: () => createLockQueue() })
    await h.engine.run(jobOf())
    expect(h.queue?.list().map(one => one.job.id)).toEqual(['j-0736'])
    // 排着的那一条认得出来是「等它醒」排的(作废时据此记那一句;锁屏那一路不带这一格)。
    expect(h.queue?.list()[0]?.reason).toBe('closed')
  })

  it('★★那句人话:排上了才说「这句我留着,它一开就送进去」', async () => {
    const h = harness({ adapters: [adapterOf({ family: 'claude', via: 'protocol', answer: () => CLOSED })], makeQueue: () => createLockQueue() })
    const out = await h.engine.run(jobOf())
    expect(out.sessionClosed).toBe(true)
    expect(out.delivered).toBe('not_sent')
    expect(out.lockQueued).toBe(true)
    expect(out.why).toBe(SESSION_CLOSED_QUEUED_SAY)
  })

  it('★「这句我留着」日志里看得见(07:36 那一回只能靠对比日志才看出是没开着)', async () => {
    const h = harness({ adapters: [adapterOf({ family: 'claude', via: 'protocol', answer: () => CLOSED })], makeQueue: () => createLockQueue() })
    await h.engine.run(jobOf())
    expect(h.lines.some(one => one.includes('waiting'))).toBe(true)
    expect(h.lines.some(one => one.includes(SESSION_CLOSED_QUEUED_SAY))).toBe(true)
  })
})

describe('② 排不上的那几种:照旧 not_sent,话也不许说成「我留着」', () => {
  it('★点键那几样不排队(隔几小时那条会话开了,那个框早就不在了)', async () => {
    const h = harness({ adapters: [adapterOf({ family: 'claude', via: 'protocol', answer: () => CLOSED })], makeQueue: () => createLockQueue() })
    const job = jobOf({ id: 'j-press', kind: 'press', text: '允许这一次' })
    const out = await h.engine.run(job)
    expect(h.queue?.list()).toEqual([])
    expect(out.sessionClosed).toBe(true)
    expect(out.lockQueued).toBeUndefined()
    expect(out.why).toContain('打开它再说一次')
    expect(stepsOf(h.log, job)).toEqual(['assigned', 'not_sent'])
  })

  it('★这台没接那本队(老宿主 / 用例)→ 行为与这张卡之前一样:如实说没送', async () => {
    const h = harness({ adapters: [adapterOf({ family: 'claude', via: 'protocol', answer: () => CLOSED })] })
    const job = jobOf()
    const out = await h.engine.run(job)
    expect(out.delivered).toBe('not_sent')
    expect(out.sessionClosed).toBe(true)
    expect(out.lockQueued).toBeUndefined()
    expect(out.why).toBe(CLAUDE_NOT_OPEN_WHY)
    expect(stepsOf(h.log, job)).toEqual(['assigned', 'not_sent'])
  })
})

describe('③ 同一句两次 → 只排一条', () => {
  it('★★同一件事 · 同一句原话第二次到引擎:不再排第二条(手机那一侧有幂等重试)', async () => {
    const h = harness({ adapters: [adapterOf({ family: 'claude', via: 'protocol', answer: () => CLOSED })], makeQueue: () => createLockQueue() })
    const job = jobOf({ text: '同一句' })
    await h.engine.run(job)
    await h.engine.run({ ...job })
    expect(h.queue?.list()).toHaveLength(1)
  })
})

describe('④ 登记表出现 socket → 只重送那条会话的留言', () => {
  it('★★醒来那条送成:账上接着 assigned → seen;别的还睡着 → 留着不送', async () => {
    const awake = new Set<string>()
    const h = harness({
      adapters: [adapterOf({
        family: 'claude',
        via: 'protocol',
        answer: (job) => (awake.has((job.target as { sessionId: string }).sessionId) ? SENT : CLOSED),
      })],
      makeQueue: () => createLockQueue(),
    })
    const jobA = jobOf({ id: 'a', target: { kind: 'session', sessionId: 'a' } })
    const jobB = jobOf({ id: 'b', target: { kind: 'session', sessionId: 'b' } })
    await h.engine.run(jobA)
    await h.engine.run(jobB)
    expect(h.queue?.list()).toHaveLength(2)

    // 登记表里只有 a 的 socket 在了:b 还睡着,不许把 b 也送一遍(送了只会再撞「没开着」)。
    awake.add('a')
    // 醒了是几分钟后的事(07:36 留言,进程 07:37 才起)—— 把钟拨过闸那 1 秒的「太密 / 同句」窗口。
    h.clock.value += 60_000
    const report = await drainLockQueue({
      queue: h.queue as ReturnType<typeof createLockQueue>,
      run: async one => await h.engine.run(one),
      shouldSend: async job => awake.has((job.target as { sessionId: string }).sessionId),
      log: SESSION_AWAKE_LOG,
      warn: line => h.lines.push(line),
    })
    expect(report).toEqual({ sent: 1, kept: 1, failed: 0 })
    expect(h.queue?.list().map(one => one.job.id)).toEqual(['b'])
    expect(stepsOf(h.log, jobA)).toEqual(['assigned', 'waiting', 'assigned', 'seen'])
    expect(stepsOf(h.log, jobB)).toEqual(['assigned', 'waiting'])
    // 巡登记表那一拍记的那一行,排障看得见
    expect(h.lines.some(one => one.includes(SESSION_AWAKE_LOG))).toBe(true)
  })

  it('★还撞上「没开着」(那一下又没了 / socket 刚没了)→ 留着,不算送不出去', async () => {
    const h = harness({ adapters: [adapterOf({ family: 'claude', via: 'protocol', answer: () => CLOSED })], makeQueue: () => createLockQueue() })
    const job = jobOf()
    await h.engine.run(job)
    // 醒来重送也是几分钟后的事,把钟拨过闸那 1 秒的窗口(不然这一下会被「同句刚捎过」当重复吞掉)。
    h.clock.value += 60_000
    // shouldSend 说醒了,可送那一刻又没了 → 重送撞上 sessionClosed → 留在队里(下一拍再来)
    const report = await drainLockQueue({
      queue: h.queue as ReturnType<typeof createLockQueue>,
      run: async one => await h.engine.run(one),
      shouldSend: async () => true,
      log: SESSION_AWAKE_LOG,
      warn: () => {},
    })
    expect(report).toEqual({ sent: 0, kept: 1, failed: 0 })
    expect(h.queue?.list()).toHaveLength(1)
  })
})

describe('⑤ 排太久自己过期:作废并记一句', () => {
  it('★过了 TTL 排着的那条作废:账上记 not_sent + 那句「放了 12 小时它都没开」', async () => {
    const h = harness({
      adapters: [adapterOf({ family: 'claude', via: 'protocol', answer: () => CLOSED })],
      makeQueue: ({ log, clock, now }) => createLockQueue({
        now,
        ttlMs: 60_000,
        onDrop: (row, why) => {
          if (row.reason === 'closed' && why === 'expired') {
            log.append({
              job: engineJobKey(row.job),
              step: 'not_sent',
              family: row.job.family,
              action: jobGateActionOf(row.job),
              why: SESSION_CLOSED_EXPIRED_SAY,
            })
          }
        },
      }),
    })
    const job = jobOf()
    await h.engine.run(job)
    expect(h.queue?.list()).toHaveLength(1)
    h.clock.value += 61_000
    h.queue?.list() // 这一下过期(作废那一条从队里拿掉)
    expect(h.queue?.list()).toEqual([])
    expect(stepsOf(h.log, job)).toEqual(['assigned', 'waiting', 'not_sent'])
    const events = h.log.events(engineJobKey(job))
    expect(events[events.length - 1]?.why).toBe(SESSION_CLOSED_EXPIRED_SAY)
  })

  it('★锁着屏那一路排的不带 reason:closed → 过期不记这一句(老行为一字不变)', async () => {
    const h = harness({
      adapters: [adapterOf({ family: 'claude', via: 'protocol', answer: () => CLOSED })],
      makeQueue: ({ clock, now }) => createLockQueue({
        now,
        ttlMs: 60_000,
        onDrop: (row, why) => {
          // 生产 onDrop 只在 reason === 'closed' 时记这一句;这里验证队列没给锁屏那一路贴这个标签。
          if (row.reason === 'closed' && why === 'expired') throw new Error('不该把锁着屏那一路当「等它醒」')
        },
      }),
    })
    // 锁着屏那一路排队时不传 reason(引擎 `locked()` 只调 add(job))—— 这里直接照它 add。
    h.queue?.add(jobOf({ id: 'kimi-locked', family: 'kimi' }))
    h.clock.value += 61_000
    h.queue?.list()
    expect(h.queue?.list()).toEqual([])
  })
})
