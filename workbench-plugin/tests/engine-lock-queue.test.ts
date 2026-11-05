// @vitest-environment node
/**
 * ★ **锁着屏时排的那本队 + 解锁重送**(2026-10-03,卡「锁屏时窗口型的家送不进」)。
 *
 * 09:04 那一句话之所以「没了」,是因为那一下只有一个结局:失败。这一本把它改成「等着」——
 * 所以这里钉的全是**不许丢、不许乱序、不许骗她**:
 *
 * ① 落盘(重启不丢)、原顺序、一件事只排一条;
 * ② 解锁重送:送到了就拿掉 + 补上送完那一下(回电);
 * ③ 还锁着 → 留着(到顶才丢);别的失败(那扇窗上的事实)→ 拿掉,不每次解锁都重撞;
 * ④ 排太久的自己过期,**而且数得出丢了几条**(不装作送了)。
 */
import { describe, expect, it } from 'vitest'
import type { Job, JobResult } from '../src/server/engine/adapter.ts'
import {
  LOCK_DRAIN_LOG,
  createLockQueue,
  LOCK_DRAIN_GAP_MS,
  defaultLockQueueFile,
  drainLockQueue,
  lockQueueKey,
  parseLockQueue,
} from '../src/server/engine/lockQueue.ts'

function jobOf(id: string, text = '就按第二个方案来'): Job {
  return {
    id,
    family: 'kimi',
    kind: 'answer',
    target: { kind: 'session', sessionId: 'window:825f1900' },
    text,
    expect: 'ack',
  }
}

/** 一本内存里的盘(用例里就是一个字符串)。 */
function fakeDisk() {
  const files = new Map<string, string>()
  return {
    files,
    io: {
      read: async (file: string) => files.get(file),
      write: async (file: string, text: string) => { files.set(file, text) },
    },
  }
}

describe('① 落盘、原顺序、一件事一条', () => {
  it('★排进去的顺序就是她说话的顺序', () => {
    const queue = createLockQueue()
    expect(queue.add(jobOf('a'))).toBe(true)
    queue.add(jobOf('b'))
    queue.add(jobOf('c'))
    expect(queue.list().map(one => one.job.id)).toEqual(['a', 'b', 'c'])
  })

  it('★★同一句话只排一条(手机那一侧有幂等重试)', () => {
    const queue = createLockQueue()
    expect(queue.add(jobOf('a'))).toBe(true)
    expect(queue.add(jobOf('a'))).toBe(false)
    expect(queue.list()).toHaveLength(1)
  })

  it('★★★同一条会话里**连答两句**要排两条 —— 按 `Job.id` 去重会把她第二句话丢掉', () => {
    const queue = createLockQueue()
    /*
     * 会话那几条路的 `Job.id` 是 `jobKey.sessionJobId`(`session:<家>/<会话 id>`)——
     * 她往同一条 Kimi 会话里答第一句、再捎一句,两件活的 `id` **一模一样**。
     * 这一条就是 2026-10-03 写这本队时真踩到的那个坑(用例先红的)。
     */
    const same = 'session:kimi/window:825f1900'
    expect(queue.add({ ...jobOf(same, '就按第二个方案来') })).toBe(true)
    expect(queue.add({ ...jobOf(same, '再加一句:别用竖版'), kind: 'relay' })).toBe(true)
    expect(queue.list().map(one => one.job.text)).toEqual(['就按第二个方案来', '再加一句:别用竖版'])
  })

  it('★去重的键 = 哪一条 · 哪一种 · 哪一句', () => {
    const base = jobOf('session:kimi/x', '同一句')
    expect(lockQueueKey(base)).toBe(lockQueueKey({ ...base }))
    expect(lockQueueKey(base)).not.toBe(lockQueueKey({ ...base, kind: 'relay' }))
    expect(lockQueueKey(base)).not.toBe(lockQueueKey({ ...base, text: '另一句' }))
  })

  it('★★落了盘、重启读得回来(重启不丢 —— 这是这本队存在的理由之一)', async () => {
    const disk = fakeDisk()
    const first = createLockQueue({ file: '/q.json', io: disk.io })
    first.add(jobOf('a', '第一句'))
    first.add(jobOf('b', '第二句'))
    await first.flush()
    expect(disk.files.get('/q.json')).toBeDefined()

    const after = createLockQueue({ file: '/q.json', io: disk.io })
    await after.load()
    expect(after.list().map(one => one.job.id)).toEqual(['a', 'b'])
    expect(after.list()[0]?.job.text).toBe('第一句')
  })

  it('★盘上读不懂的那几条丢掉,整本不受带累', () => {
    const rows = parseLockQueue(JSON.stringify({
      queue: [
        { at: '2026-10-03T01:04:00.000Z', job: jobOf('ok') },
        { at: '2026-10-03T01:04:00.000Z', job: { id: '', family: 'kimi', kind: 'answer', text: '', target: {} } },
        { at: '2026-10-03T01:04:00.000Z' },
        'not an object',
      ],
    }))
    expect(rows.map(one => one.job.id)).toEqual(['ok'])
  })

  it('★那本队落在哪:与账、看板同一个目录', () => {
    expect(defaultLockQueueFile('/Users/x')).toBe('/Users/x/.dsh/workbench/lock-queue.json')
  })

  it('★写盘坏了**不吞**:`flush` 抛、`persistError` 说得出(不许装作排上了)', async () => {
    const queue = createLockQueue({
      file: '/q.json',
      io: { read: async () => undefined, write: async () => { throw new Error('盘满了') } },
    })
    queue.add(jobOf('a'))
    await expect(queue.flush()).rejects.toThrow('盘满了')
    expect(queue.persistError()).toBe('盘满了')
  })

  it('★满了丢**最老的**(她最近说的那几句更要紧),而且数得出丢了几条', () => {
    const queue = createLockQueue({ max: 2 })
    queue.add(jobOf('a'))
    queue.add(jobOf('b'))
    queue.add(jobOf('c'))
    expect(queue.list().map(one => one.job.id)).toEqual(['b', 'c'])
    expect(queue.dropped()).toBe(1)
  })
})

describe('④ 排太久就不送了(隔一天再送比不送更糟),丢了就说', () => {
  it('★过了上限的那几条不再出现在队里,`dropped` 数得出', () => {
    let nowMs = Date.parse('2026-10-03T01:04:00.000Z')
    const queue = createLockQueue({ now: () => new Date(nowMs), ttlMs: 60_000 })
    queue.add(jobOf('a'))
    nowMs += 61_000
    queue.add(jobOf('b'))
    expect(queue.list().map(one => one.job.id)).toEqual(['b'])
    expect(queue.dropped()).toBe(1)
  })
})

describe('②③ 解锁了:按原顺序重送', () => {
  it('★★原顺序、一条一条(她说话的次序不许乱)', async () => {
    const queue = createLockQueue()
    queue.add(jobOf('a', '第一句'))
    queue.add(jobOf('b', '第二句'))
    queue.add(jobOf('c', '第三句'))
    const sent: string[] = []
    const report = await drainLockQueue({
      gapMs: 0,
      queue,
      run: async (job) => { sent.push(job.text); return { delivered: 'confirmed', via: 'window', evidence: 'window' } },
      warn: () => {},
    })
    expect(sent).toEqual(['第一句', '第二句', '第三句'])
    expect(report).toEqual({ sent: 3, kept: 0, failed: 0 })
    expect(queue.list()).toEqual([])
  })

  it('★★送到了之后那一下(捎话要登记回电)—— 送成了才做', async () => {
    const queue = createLockQueue()
    queue.add(jobOf('a'))
    const after: string[] = []
    await drainLockQueue({
      gapMs: 0,
      queue,
      run: async () => ({ delivered: 'unconfirmed', via: 'window', evidence: 'none', why: '按了发送,没核上' }),
      after: async (job) => { after.push(job.id) },
      warn: () => {},
    })
    // `unconfirmed` 也算送出去了(按了发送)—— 它多半已经收到了,回电照登记
    expect(after).toEqual(['a'])
  })

  it('★那一下抛了错不影响「已经送出去」这件事,只记一行', async () => {
    const queue = createLockQueue()
    queue.add(jobOf('a'))
    const lines: string[] = []
    const report = await drainLockQueue({
      gapMs: 0,
      queue,
      run: async () => ({ delivered: 'confirmed', via: 'window', evidence: 'window' }),
      after: async () => { throw new Error('台账写不进去') },
      warn: line => lines.push(line),
    })
    expect(report.sent).toBe(1)
    expect(lines.some(one => one.includes('台账写不进去'))).toBe(true)
  })

  it('★★还锁着(她又锁上了 / 刚解锁那一瞬)→ **留着**,不丢', async () => {
    const queue = createLockQueue()
    queue.add(jobOf('a'))
    const report = await drainLockQueue({
      gapMs: 0,
      queue,
      run: async () => ({ delivered: 'not_sent', via: 'none', evidence: 'none', screenLocked: true, why: '电脑锁着屏…' }),
      warn: () => {},
    })
    expect(report).toEqual({ sent: 0, kept: 1, failed: 0 })
    expect(queue.list().map(one => one.job.id)).toEqual(['a'])
    expect(queue.list()[0]?.tries).toBe(1)
  })

  it('★老撞上锁屏到顶了就丢(不无限重送),而且数得出', async () => {
    const queue = createLockQueue({ maxTries: 2 })
    queue.add(jobOf('a'))
    const locked = async (): Promise<JobResult> => ({ delivered: 'not_sent', via: 'none', evidence: 'none', screenLocked: true })
    await drainLockQueue({ gapMs: 0, queue, run: locked, warn: () => {} })
    expect(queue.list()).toHaveLength(1)
    const last = await drainLockQueue({ gapMs: 0, queue, run: locked, warn: () => {} })
    expect(last).toEqual({ sent: 0, kept: 0, failed: 1 })
    expect(queue.list()).toEqual([])
    expect(queue.dropped()).toBe(1)
  })

  it('★★别的失败(那扇窗上的事实)→ 拿掉:不许每次解锁都重撞一遍', async () => {
    const queue = createLockQueue()
    queue.add(jobOf('a'))
    const report = await drainLockQueue({
      gapMs: 0,
      queue,
      run: async () => ({ delivered: 'not_sent', via: 'window', evidence: 'none', why: '输入框没接住这段话' }),
      warn: () => {},
    })
    expect(report).toEqual({ sent: 0, kept: 0, failed: 1 })
    expect(queue.list()).toEqual([])
  })

  it('★引擎真抛了(按契约不该抛)也不把这一件丢掉', async () => {
    const queue = createLockQueue()
    queue.add(jobOf('a'))
    const report = await drainLockQueue({
      gapMs: 0,
      queue,
      run: async () => { throw new Error('引擎炸了') },
      warn: () => {},
    })
    expect(report.kept).toBe(1)
    expect(queue.list()).toHaveLength(1)
  })

  it('★★★被闸拦下的那一下**留着**,不许当成「送不出去」丢掉', async () => {
    /*
     * 她往同一条会话里连答两句:两件活在闸上是**同一个键**(`jobKey.sessionJobId`),
     * 而「替她答」的间隔是 1.5 秒(`GATE_LIMITS.answer_send`)—— 一条接一条地重送,
     * 第二句必然撞上「离上一回太密」(`blocked`)。丢掉它就等于把她第二句话丢了。
     */
    const queue = createLockQueue()
    queue.add(jobOf('session:kimi/x', '第一句'))
    queue.add({ ...jobOf('session:kimi/x', '第二句'), kind: 'relay' })
    let at = 0
    const report = await drainLockQueue({
      gapMs: 0,
      queue,
      run: async () => {
        at += 1
        return at === 1
          ? { delivered: 'confirmed', via: 'window', evidence: 'window' }
          : { delivered: 'not_sent', via: 'window', evidence: 'none', blocked: true, why: '离上一回太密' }
      },
      warn: () => {},
    })
    expect(report).toEqual({ sent: 1, kept: 1, failed: 0 })
    expect(queue.list().map(one => one.job.text)).toEqual(['第二句'])
  })

  it('★★两条之间隔开再送(闸的间隔是 1.5 秒,一条接一条会被自己拦下)', async () => {
    const queue = createLockQueue()
    queue.add(jobOf('a', '第一句'))
    queue.add(jobOf('b', '第二句'))
    const slept: number[] = []
    await drainLockQueue({
      queue,
      run: async () => ({ delivered: 'confirmed', via: 'window', evidence: 'window' }),
      sleep: async (ms) => { slept.push(ms) },
      warn: () => {},
    })
    // 第一条不等,第二条之前等一下(缺省值 ≥ 闸那 1.5 秒)
    expect(slept).toEqual([LOCK_DRAIN_GAP_MS])
    expect(LOCK_DRAIN_GAP_MS).toBeGreaterThan(1500)
  })

  it('★空队:一行都不记、一下都不跑', async () => {
    const lines: string[] = []
    const report = await drainLockQueue({
      gapMs: 0,
      queue: createLockQueue(),
      run: async () => { throw new Error('不该被调到') },
      warn: line => lines.push(line),
    })
    expect(report).toEqual({ sent: 0, kept: 0, failed: 0 })
    expect(lines).toEqual([])
  })

  it('★有东西要重送时记一行(真机排障要看得见这件事)', async () => {
    const queue = createLockQueue()
    queue.add(jobOf('a'))
    const lines: string[] = []
    await drainLockQueue({
      gapMs: 0,
      queue,
      run: async () => ({ delivered: 'confirmed', via: 'window', evidence: 'window' }),
      warn: line => lines.push(line),
    })
    expect(lines[0]).toContain(LOCK_DRAIN_LOG)
  })
})
