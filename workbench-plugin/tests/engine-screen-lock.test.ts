// @vitest-environment node
/**
 * ★ **引擎这一层撞上锁屏:排队、落账、换那句人话**(2026-10-03,卡「锁屏时窗口型的家送不进」)。
 *
 * 这一份钉的是引擎自己那几件事(适配器全是假的,一条真壳都不碰):
 *
 * ① 窗口那一层回 `screenLocked` → **排进队** + 账上 `assigned → waiting`(**不是 `not_sent`**),
 *    那句人话换成「解锁了我就把这句送进去」+「要现在就办走不靠窗口的那几家」(名字**现查**);
 * ② 排不上(点键那几种 / 这台没接那本队)→ 照旧记 `not_sent`,话也不许说成「我会送」;
 * ③ **一条替代的路都不走**:锁屏时不许换通道(换了一样撞锁屏);
 * ④ **协议型那两家不受影响**(Claude socket / Codex app-server 不经窗口);
 * ⑤ 解锁重送:账上接着 `assigned → sent`,而且**闸不许拦下**(`waiting` 不算收场)。
 */
import { describe, expect, it } from 'vitest'
import { createActionGate } from '../src/server/actionGate.ts'
import { createJobLog } from '../src/server/jobLog.ts'
import type { Adapter, AdapterCapabilities, Job, JobResult } from '../src/server/engine/adapter.ts'
import { createEngine, engineJobKey } from '../src/server/engine/engine.ts'
import { createLockQueue, drainLockQueue } from '../src/server/engine/lockQueue.ts'
import { createRegistry } from '../src/server/engine/registry.ts'
import { SCREEN_LOCK_MARK } from '../src/server/screenLock.ts'

const ALL_CAPS: AdapterCapabilities = { open: true, send: true, read: true, press: true, approve: true, writeAsk: true, stop: true, openSession: true }

const NAMES: Readonly<Record<string, string>> = { kimi: 'Kimi', claude: 'Claude', codex: 'Codex' }

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

/** 窗口那一层撞上锁屏的那个回包(与 `engine/adapters/window.ts` 真回的那一份同形)。 */
const LOCKED: JobResult = {
  delivered: 'not_sent',
  via: 'none',
  evidence: 'none',
  screenLocked: true,
  why: `${SCREEN_LOCK_MARK},窗口型的家这会儿送不进 —— Kimi 还在跑…`,
}

const SENT: JobResult = { delivered: 'confirmed', via: 'window', evidence: 'window' }

function harness(options: { adapters: readonly Adapter[], queue?: ReturnType<typeof createLockQueue> }) {
  const clock = { value: Date.parse('2026-10-03T01:04:00.000Z') }
  const now = (): Date => new Date(clock.value)
  const log = createJobLog({ now })
  const gate = createActionGate({ phaseOf: () => 'open', log, now, name: family => NAMES[family] ?? family })
  const registry = createRegistry({ now })
  for (const one of options.adapters) registry.register(one)
  const lines: string[] = []
  const engine = createEngine({
    registry,
    gate,
    log,
    now,
    name: family => NAMES[family] ?? family,
    sleep: (ms) => { clock.value += ms; return Promise.resolve() },
    warn: line => lines.push(line),
    ...(options.queue === undefined ? {} : { lockQueue: { add: job => (options.queue as ReturnType<typeof createLockQueue>).add(job) } }),
  })
  return { engine, log, gate, registry, lines, clock }
}

/** 账上这一件走过的那几步(闸自己记的 `gate_pass` / `gate_block` 不算 —— 这里看的是引擎那几步)。 */
function stepsOf(log: ReturnType<typeof createJobLog>, job: Job): string[] {
  return log.events(engineJobKey(job)).map(one => one.step).filter(one => one !== 'gate_pass' && one !== 'gate_block')
}

function jobOf(over: Partial<Job> = {}): Job {
  return {
    id: 'j-0904',
    family: 'kimi',
    kind: 'answer',
    target: { kind: 'session', sessionId: 'window:825f1900' },
    text: '就按第二个方案来,封面用那张海边的',
    expect: 'ack',
    ...over,
  }
}

describe('① 锁着屏 + 排上队', () => {
  it('★★账上是 assigned → waiting(**不是 not_sent**:记了收场,解锁重送会被闸拦下)', async () => {
    const queue = createLockQueue()
    const h = harness({ adapters: [adapterOf({ family: 'kimi', via: 'window', answer: () => LOCKED })], queue })
    const job = jobOf()
    await h.engine.run(job)
    const steps = stepsOf(h.log, job)
    expect(steps).toEqual(['assigned', 'waiting'])
    expect(steps).not.toContain('not_sent')
  })

  it('★★真排进了队(她一解锁就送)', async () => {
    const queue = createLockQueue()
    const h = harness({ adapters: [adapterOf({ family: 'kimi', via: 'window', answer: () => LOCKED })], queue })
    await h.engine.run(jobOf())
    expect(queue.list().map(one => one.job.id)).toEqual(['j-0904'])
  })

  it('★★那句人话:排上了才说「解锁了我就把这句送进去」', async () => {
    const queue = createLockQueue()
    const h = harness({ adapters: [adapterOf({ family: 'kimi', via: 'window', answer: () => LOCKED })], queue })
    const out = await h.engine.run(jobOf())
    expect(out.screenLocked).toBe(true)
    expect(out.delivered).toBe('not_sent')
    expect(out.why).toContain(SCREEN_LOCK_MARK)
    expect(out.why).toContain('解锁了我就把这句送进去')
  })

  it('★★那句话的最后半句:**不靠窗口的那几家名字是现查的**(代码里一个 App 名都不写死)', async () => {
    const queue = createLockQueue()
    const h = harness({
      adapters: [
        adapterOf({ family: 'kimi', via: 'window', answer: () => LOCKED }),
        adapterOf({ family: 'claude', via: 'protocol', answer: () => SENT }),
        adapterOf({ family: 'codex', via: 'protocol', answer: () => SENT }),
      ],
      queue,
    })
    const out = await h.engine.run(jobOf())
    expect(out.why).toContain('Claude')
    expect(out.why).toContain('Codex')
    expect(out.why).toContain('不靠窗口')
    // 这一家自己不算进去(它正撞在锁屏上)
    expect(out.why).not.toContain('只能Kimi')
  })

  it('★一家不靠窗口的都没有 → 那半句不说(不编一条她走不通的路)', async () => {
    const queue = createLockQueue()
    const h = harness({ adapters: [adapterOf({ family: 'kimi', via: 'window', answer: () => LOCKED })], queue })
    const out = await h.engine.run(jobOf())
    expect(out.why).not.toContain('不靠窗口')
  })

  it('★「它在等解锁」这件事日志里看得见(09:04 那一回只能靠对比三次日志才看出来)', async () => {
    const queue = createLockQueue()
    const h = harness({ adapters: [adapterOf({ family: 'kimi', via: 'window', answer: () => LOCKED })], queue })
    await h.engine.run(jobOf())
    expect(h.lines.some(one => one.includes('waiting'))).toBe(true)
    expect(h.lines.some(one => one.includes(SCREEN_LOCK_MARK))).toBe(true)
  })
})

describe('② 排不上的那几种:照旧 not_sent,话也不许说成「我会送」', () => {
  it('★★点键那几样不排队(隔半小时解锁再按,那个框早就不在了)', async () => {
    const queue = createLockQueue()
    const h = harness({ adapters: [adapterOf({ family: 'kimi', via: 'window', answer: () => LOCKED })], queue })
    const job = jobOf({ id: 'j-press', kind: 'press', text: '允许这一次' })
    const out = await h.engine.run(job)
    expect(queue.list()).toEqual([])
    expect(out.why).toContain('解锁了再叫我一次')
    expect(out.why).not.toContain('我就把这句送进去')
    expect(stepsOf(h.log, job)).toEqual(['assigned', 'not_sent'])
  })

  it('★★没带 waitUnlock、没有事项 id 的派活不排队(2026-10-12 起派活排队只走 dispatchRun 那一条;见 engine-lock-queue-dispatch)', async () => {
    const queue = createLockQueue()
    const h = harness({ adapters: [adapterOf({ family: 'kimi', via: 'window', answer: () => LOCKED })], queue })
    const job = jobOf({ id: 'j-dispatch', kind: 'dispatch', target: { kind: 'new' } })
    const out = await h.engine.run(job)
    expect(queue.list()).toEqual([])
    expect(out.screenLocked).toBe(true)
    expect(out.why).toContain('解锁了再叫我一次')
    expect(stepsOf(h.log, job)).toEqual(['assigned', 'not_sent'])
  })

  it('★这台没接那本队(老宿主 / 用例)→ 行为与 2026-10-03 之前一样:如实说没送', async () => {
    const h = harness({ adapters: [adapterOf({ family: 'kimi', via: 'window', answer: () => LOCKED })] })
    const job = jobOf()
    const out = await h.engine.run(job)
    expect(out.delivered).toBe('not_sent')
    expect(out.why).toContain('解锁了再叫我一次')
    expect(stepsOf(h.log, job)).toEqual(['assigned', 'not_sent'])
  })

})

describe('③④ 一条替代的路都不走;协议型不受影响', () => {
  it('★★锁屏时**不换通道**(换一条一样撞锁屏;同闸拦下那一下的纪律)', async () => {
    const queue = createLockQueue()
    /*
     * 队的次序是「通道从稳到脆」(`comparePicks`:协议 > 命令行 > 文件 > 窗口),
     * 所以这里把**先走的那一条**(`file`)设成撞上锁屏的那一个,后面还留着一条 ——
     * 要钉的是:引擎见了 `screenLocked` 就到此为止,队里后面那一条**一次都不调**。
     */
    const first = adapterOf({ family: 'kimi', via: 'file', answer: () => LOCKED })
    const second = adapterOf({ family: 'kimi', via: 'window', answer: () => SENT })
    const h = harness({ adapters: [first, second], queue })
    const out = await h.engine.run(jobOf())
    expect(out.screenLocked).toBe(true)
    expect(first.calls()).toBe(1)
    expect(second.calls()).toBe(0)
  })

  it('★★协议型那两家照旧送得进(Claude socket / Codex app-server 不经窗口)', async () => {
    const queue = createLockQueue()
    const claude = adapterOf({ family: 'claude', via: 'protocol', answer: () => ({ delivered: 'confirmed', via: 'protocol', evidence: 'receipt' }) })
    const h = harness({ adapters: [claude], queue })
    const out = await h.engine.run(jobOf({ id: 'j-claude', family: 'claude', target: { kind: 'session', sessionId: 'local_1' } }))
    expect(out.delivered).toBe('confirmed')
    expect(out.screenLocked).toBeUndefined()
    expect(queue.list()).toEqual([])
  })
})

describe('⑤ 解锁重送:接着记 assigned → sent,闸不许拦下', () => {
  it('★★同一件事:锁屏那一下 waiting,解锁那一下 sent(闸没把它当收场)', async () => {
    const queue = createLockQueue()
    let locked = true
    const windowed = adapterOf({
      family: 'kimi',
      via: 'window',
      answer: () => (locked ? LOCKED : { delivered: 'unconfirmed', via: 'window', evidence: 'none', why: '按了发送,没当场核上' }),
    })
    const h = harness({ adapters: [windowed], queue })
    const job = jobOf()
    await h.engine.run(job)
    expect(queue.list()).toHaveLength(1)

    locked = false
    h.clock.value += 5000
    const report = await drainLockQueue({ queue, run: async one => await h.engine.run(one), warn: () => {} })
    expect(report).toEqual({ sent: 1, kept: 0, failed: 0 })
    expect(queue.list()).toEqual([])
    expect(stepsOf(h.log, job)).toEqual(['assigned', 'waiting', 'assigned', 'sent'])
  })

  it('★★重启之后那本队还在(落盘),解锁照样送', async () => {
    const files = new Map<string, string>()
    const io = {
      read: async (file: string) => files.get(file),
      write: async (file: string, text: string) => { files.set(file, text) },
    }
    const first = createLockQueue({ file: '/q.json', io })
    const h1 = harness({ adapters: [adapterOf({ family: 'kimi', via: 'window', answer: () => LOCKED })], queue: first })
    await h1.engine.run(jobOf())
    await first.flush()

    // 工作台重启(launchd / 热更新):新的一本队、新的引擎,盘上那一条读回来
    const after = createLockQueue({ file: '/q.json', io })
    await after.load()
    expect(after.list().map(one => one.job.id)).toEqual(['j-0904'])
    const h2 = harness({ adapters: [adapterOf({ family: 'kimi', via: 'window', answer: () => SENT })], queue: after })
    const report = await drainLockQueue({ queue: after, run: async one => await h2.engine.run(one), warn: () => {} })
    expect(report.sent).toBe(1)
    expect(after.list()).toEqual([])
  })
})
