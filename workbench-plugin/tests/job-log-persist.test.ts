/**
 * **任务日志落盘:只追加、坏了就说、重启还查得到、不截还没收场的**(2026-10-02,卡 AG2)。
 *
 * 卡 AG 那一版账在内存里,工作台一重启就空了 —— 于是「这件事走到哪一步」在最需要的时候(她重启之后
 * 发现那一家又被动了)恰好查不到。这一份守四条:
 * ① **只追加**:一行一条 JSON,写进去的那一条不改不删;
 * ② **写盘失败不许吞**(设计根子 3「回电台账落盘失败被吞」那条教训):记一行日志 + `persistError()`
 *    一直说得出 + `flush()` 直接抛;
 * ③ **重启还查得到**:`load()` 读回来,读不懂的那一行单独丢掉(数得出丢了几行);
 * ④ **体量有上限,但不截还没收场的**:满了只丢已收场那几件的事件。
 */
import { describe, expect, it } from 'vitest'
import {
  JOB_LOG_PERSIST_FAILED_LOG,
  createJobLog,
  parseJobEventLine,
  trimJobEvents,
} from '../src/server/jobLog.ts'
import type { JobEvent, JobLogIo } from '../src/server/jobLog.ts'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function at(seconds: number): string {
  return new Date(Date.UTC(2026, 9, 2, 10, 0, seconds)).toISOString()
}

/** 盘上那一本的替身:记下每一次写了什么,想让它坏就让它坏。 */
function fakeIo(options: { fail?: boolean } = {}) {
  const appended: string[] = []
  let text = ''
  const io: JobLogIo = {
    append: async (_file, line) => {
      if (options.fail === true) throw new Error('盘满了')
      appended.push(line)
      text += line
    },
    rewrite: async (_file, whole) => {
      if (options.fail === true) throw new Error('盘满了')
      text = whole
    },
    read: async () => text,
  }
  return { io, appended, read: () => text, seed: (whole: string) => { text = whole } }
}

describe('只追加:一行一条 JSON', () => {
  it('每记一条就往末尾追加一行,不重写整本', async () => {
    const fake = fakeIo()
    const log = createJobLog({ file: '/x/jobs.jsonl', io: fake.io, now: () => new Date(at(1)) })
    log.append({ job: 't-1', step: 'assigned', family: 'doubao' })
    log.append({ job: 't-1', step: 'sent', family: 'doubao', bundle_id: 'com.work.pc.doubao' })
    await log.flush()
    expect(fake.appended).toHaveLength(2)
    const lines = fake.read().trim().split('\n').map(one => JSON.parse(one) as JobEvent)
    expect(lines.map(one => one.step)).toEqual(['assigned', 'sent'])
    expect(lines[1]?.bundle_id).toBe('com.work.pc.doubao')
  })

  it('账上那一行里没有她的话(只有时刻、事项、哪一家、哪个包、什么动作、为什么)', async () => {
    const fake = fakeIo()
    const log = createJobLog({ file: '/x/jobs.jsonl', io: fake.io })
    log.append({ job: 't-1', step: 'gate_block', family: 'doubao', action: 'reply_watch', why: '这件已经收场,不再动那一家' })
    await log.flush()
    const one = JSON.parse(fake.read().trim()) as Record<string, unknown>
    expect(Object.keys(one).sort()).toEqual(['action', 'at', 'family', 'job', 'step', 'why'])
  })
})

describe('写盘失败:不吞', () => {
  it('★坏了记一行日志、`persistError` 说得出、`flush` 抛出来', async () => {
    const fake = fakeIo({ fail: true })
    const warned: string[] = []
    const log = createJobLog({ file: '/x/jobs.jsonl', io: fake.io, warn: line => warned.push(line) })
    log.append({ job: 't-1', step: 'assigned', family: 'doubao' })
    log.append({ job: 't-1', step: 'sent', family: 'doubao' })
    await expect(log.flush()).rejects.toThrow('盘满了')
    expect(log.persistError()).toContain('盘满了')
    // 连着坏只记第一行(刷满一屏日志帮不了任何人),但那一行一定有。
    expect(warned).toEqual([JOB_LOG_PERSIST_FAILED_LOG])
    // 内存里那两条照旧在(账落不了盘不等于这件事没发生)。
    expect(log.events('t-1')).toHaveLength(2)
  })

  it('不接文件的那一份(用例 / 老宿主)一个字都不写、也不报错', async () => {
    const log = createJobLog()
    log.append({ job: 't-1', step: 'assigned' })
    await log.flush()
    expect(log.persistError()).toBeUndefined()
  })
})

describe('重启还查得到', () => {
  it('按事项索引与全账在追加、裁剪和重启后始终一致，读者不能改写账内事件', async () => {
    const fake = fakeIo()
    const first = createJobLog({ file: '/x/jobs.jsonl', io: fake.io, max: 4 })
    for (let index = 0; index < 12; index++) first.append({ job: index < 4 ? 'settled' : 'active',
      step: index === 3 ? 'done' : 'updated', at: at(index) })
    await first.flush()
    const check = (log: ReturnType<typeof createJobLog>) => {
      for (const job of ['settled', 'active']) expect(log.events(job)).toEqual(log.all().filter(one => one.job === job))
    }
    check(first)
    first.events('active')[0]!.step = 'done'
    check(first)
    const again = createJobLog({ file: '/x/jobs.jsonl', io: fake.io, max: 4 })
    await again.load()
    check(again)
    again.append({ job: 'active', step: 'updated', at: at(13) })
    check(again)
  })
  it('超出裁剪预算仍保留的来源事件，重启后按同一来源键去重', async () => {
    const fake = fakeIo()
    const first = createJobLog({ file: '/x/jobs.jsonl', io: fake.io, max: 2 })
    const sourceEvent = (id: number) => ({ job: 't-source', step: 'updated' as const,
      session_id: 'session-a', source_round: 'round-1', source_event_id: `event-${id}`, at: at(1) })
    for (let id = 0; id < 8; id++) first.append(sourceEvent(id))
    await first.flush()
    expect(first.events('t-source')).toHaveLength(8)
    const again = createJobLog({ file: '/x/jobs.jsonl', io: fake.io, max: 2 })
    await again.load()
    again.append(sourceEvent(0))
    again.append(sourceEvent(7))
    await again.flush()
    expect(again.events('t-source')).toHaveLength(8)
    expect(fake.appended).toHaveLength(8)
  })

  it('★真落盘、真读回来:四步照样数得出来', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wb-joblog-'))
    try {
      const file = join(dir, 'jobs.jsonl')
      const first = createJobLog({ file })
      first.append({ job: 't-1', step: 'assigned', family: 'doubao' })
      first.append({ job: 't-1', step: 'sent', family: 'doubao' })
      first.append({ job: 't-1', step: 'replied', family: 'doubao' })
      await first.flush()
      // 换一个进程(= 换一本空账)读回来。
      const again = createJobLog({ file })
      expect(again.events('t-1')).toHaveLength(0)
      await again.load()
      const trace = again.trace('t-1')
      expect(trace.assigned?.family).toBe('doubao')
      expect(trace.delivered?.step).toBe('sent')
      expect(trace.finished?.step).toBe('replied')
      // 读回来之后接着追加,盘上是四行(只追加:老的三行一个字都没动)。
      again.append({ job: 't-1', step: 'called', family: 'doubao' })
      await again.flush()
      expect((await readFile(file, 'utf8')).trim().split('\n')).toHaveLength(4)
    }
    finally { await rm(dir, { recursive: true, force: true }) }
  })

  it('读不懂的那一行单独丢掉,数得出丢了几行(整本账不受它带累)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wb-joblog-'))
    try {
      const file = join(dir, 'jobs.jsonl')
      await writeFile(file, [
        JSON.stringify({ at: at(1), job: 't-1', step: 'assigned' }),
        '{这不是 JSON',
        JSON.stringify({ at: at(2), job: 't-1', step: '乱写的一步' }),
        JSON.stringify({ at: at(3), job: 't-1', step: 'sent' }),
        '',
      ].join('\n'), 'utf8')
      const log = createJobLog({ file })
      await log.load()
      expect(log.events('t-1').map(one => one.step)).toEqual(['assigned', 'sent'])
      expect(log.unreadable()).toBe(2)
    }
    finally { await rm(dir, { recursive: true, force: true }) }
  })

  it('没有这个文件 = 空账(第一次起服务),不报错', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wb-joblog-'))
    try {
      const log = createJobLog({ file: join(dir, 'nope.jsonl') })
      await log.load()
      expect(log.all()).toHaveLength(0)
      expect(log.persistError()).toBeUndefined()
    }
    finally { await rm(dir, { recursive: true, force: true }) }
  })

  it('一行读得懂的判据写在一处(认得的那几步 + 必须有时刻与事项)', () => {
    expect(parseJobEventLine(JSON.stringify({ at: at(1), job: 't-1', step: 'sent' }))?.step).toBe('sent')
    expect(parseJobEventLine(JSON.stringify({ job: 't-1', step: 'sent' }))).toBeUndefined()
    expect(parseJobEventLine(JSON.stringify({ at: at(1), step: 'sent' }))).toBeUndefined()
    expect(parseJobEventLine('')).toBeUndefined()
  })
})

describe('体量有上限,但不截还没收场的', () => {
  it('★满了只丢已收场那几件的事件;还没收场的一条都不丢', () => {
    const events: JobEvent[] = [
      // 已收场的那一件(账上有 replied)。
      { at: at(1), job: 't-done', step: 'assigned' },
      { at: at(2), job: 't-done', step: 'sent' },
      { at: at(3), job: 't-done', step: 'replied' },
      // 还在办的那一件。
      { at: at(4), job: 't-open', step: 'assigned' },
      { at: at(5), job: 't-open', step: 'sent' },
    ]
    const kept = trimJobEvents(events, 3)
    expect(kept.map(one => one.job)).toEqual(['t-done', 't-open', 't-open'])
    // 丢的是**最老**的那几条已收场事件。
    expect(kept[0]?.at).toBe(at(3))
  })

  it('还没收场的占满了上限 → 一条已收场的都不留,还没收场的照样全留着', () => {
    const events: JobEvent[] = [
      { at: at(1), job: 't-done', step: 'done' },
      { at: at(2), job: 't-a', step: 'assigned' },
      { at: at(3), job: 't-b', step: 'assigned' },
      { at: at(4), job: 't-c', step: 'assigned' },
    ]
    expect(trimJobEvents(events, 2).map(one => one.job)).toEqual(['t-a', 't-b', 't-c'])
  })

  it('超时 / 读不到 / 她自己收了也算收场(四步表那一格同一份判据)', () => {
    for (const step of ['timeout', 'unreadable', 'done'] as const) {
      const events: JobEvent[] = [
        { at: at(1), job: 't-x', step: 'assigned' },
        { at: at(2), job: 't-x', step },
        { at: at(3), job: 't-open', step: 'assigned' },
      ]
      expect(trimJobEvents(events, 1).map(one => one.job)).toEqual(['t-open'])
    }
  })

  /*
   * 收一次要把整本重写一遍,所以**涨过上限的四分之一才收**(一满就收 = 每记一条重写一次;
   * 盯窗那几条路 4~8 秒一拍,一小时上千条)。这一条顺手守住那个余量。
   */
  it('账满了丢掉过几条说得出来,而且丢过之后盘上那一本也跟着收', async () => {
    const fake = fakeIo()
    const log = createJobLog({ file: '/x/jobs.jsonl', io: fake.io, max: 4 })
    log.append({ job: 't-done', step: 'assigned' })
    log.append({ job: 't-done', step: 'sent' })
    log.append({ job: 't-done', step: 'done' })
    // 到这儿是 4 条 = 上限,余量还没用完 —— 一条都不丢。
    log.append({ job: 't-open', step: 'assigned' })
    await log.flush()
    expect(log.dropped()).toBe(0)
    // 第 6 条压过余量(4 + 1)→ 收一次,只丢已收场那一件的、最老的那两条。
    log.append({ job: 't-open', step: 'sent' })
    log.append({ job: 't-open', step: 'seen' })
    await log.flush()
    expect(log.dropped()).toBe(2)
    expect(log.all().map(one => one.job)).toEqual(['t-done', 't-open', 't-open', 't-open'])
    expect(fake.read().trim().split('\n')).toHaveLength(4)
  })
})

/**
 * 读坏了不盖原本(2026-10-21,与 tasks.json 同一类坑):收账时整本重写,写的只是内存里那几条 ——
 * 读不出来的那本、读不懂的那几行,一重写就没了。
 */
describe('读坏了不盖原本', () => {
  function unreadableIo() {
    const rewrites: string[] = []
    const appended: string[] = []
    const io: JobLogIo = {
      append: async (_file, line) => { appended.push(line) },
      rewrite: async (_file, whole) => { rewrites.push(whole) },
      read: async () => { throw new Error('EACCES: 读不了') },
    }
    return { io, rewrites, appended }
  }

  it('整本读不出来:之后满了也只追加,不整本重写', async () => {
    const fake = unreadableIo()
    const log = createJobLog({ file: '/x/jobs.jsonl', io: fake.io, max: 2, now: () => new Date(at(1)) })
    await log.load()
    for (let i = 0; i < 6; i += 1) log.append({ job: `t-${i}`, step: 'done' })
    await log.flush()
    expect(fake.rewrites).toEqual([])
    expect(fake.appended).toHaveLength(6)
  })

  it('有读不懂的行:重写之前先另存一份原本', async () => {
    const fake = fakeIo()
    const kept: string[] = []
    const io: JobLogIo = { ...fake.io, keep: async (_file, text) => { kept.push(text) } }
    const original = `${JSON.stringify({ at: at(1), job: 't-a', step: 'done' })}\n{"at":"半行\n`
    fake.seed(original)
    const log = createJobLog({ file: '/x/jobs.jsonl', io, max: 1, now: () => new Date(at(2)) })
    await log.load()
    expect(log.unreadable()).toBe(1)
    for (let i = 0; i < 4; i += 1) log.append({ job: `t-${i}`, step: 'done' })
    await log.flush()
    expect(kept).toEqual([original])
  })

  it('真盘:另存成 jobs.jsonl.corrupt-<时间>,内容与原本一字不差', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'job-log-corrupt-'))
    try {
      const file = join(dir, 'jobs.jsonl')
      const original = '{"at":"半行\n'
      await writeFile(file, original)
      const log = createJobLog({ file, max: 1, now: () => new Date(at(2)) })
      await log.load()
      for (let i = 0; i < 4; i += 1) log.append({ job: `t-${i}`, step: 'done' })
      await log.flush()
      const copies = (await readdir(dir)).filter(name => name.startsWith('jobs.jsonl.corrupt-'))
      expect(copies).toHaveLength(1)
      expect(await readFile(join(dir, copies[0] as string), 'utf8')).toBe(original)
    }
    finally { await rm(dir, { recursive: true, force: true }) }
  })
})
