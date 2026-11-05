/**
 * 真进程、真文件:子进程写库,父进程 SIGKILL 它 / 在它写的同时取快照续流。
 * 子进程脚本见 fixtures/writer.ts。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { foldEvents, openLedger, type LedgerEvent, type Snapshot } from '../index.ts'
import { ALICE, tmpDb } from './helpers.ts'

const WRITER = fileURLToPath(new URL('./fixtures/writer.ts', import.meta.url))

interface Round { i: number; object_id: string; seq: number }

let cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.reverse()) c()
  cleanups = []
})

function startWriter(path: string, args: string[]): { child: ChildProcess; rounds: Round[]; stderr: () => string; waitFor: (n: number) => Promise<void>; exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }> } {
  const child = spawn(process.execPath, ['--no-warnings', WRITER, path, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
  cleanups.push(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') })
  const rounds: Round[] = []
  let buf = ''
  let err = ''
  const waiters: Array<{ n: number; resolve: () => void; reject: (e: Error) => void }> = []
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on('exit', (code, signal) => {
      for (const w of waiters) w.reject(new Error(`writer exited (${code ?? signal}) after ${rounds.length} rounds: ${err}`))
      resolve({ code, signal })
    })
  })
  child.stdout?.setEncoding('utf8')
  child.stdout?.on('data', (chunk: string) => {
    buf += chunk
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      const m = /^ok (\d+) (\S+) (\d+)$/.exec(line)
      if (m) rounds.push({ i: Number(m[1]), object_id: m[2] as string, seq: Number(m[3]) })
    }
    for (const w of [...waiters]) {
      if (rounds.length >= w.n) {
        waiters.splice(waiters.indexOf(w), 1)
        w.resolve()
      }
    }
  })
  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', (chunk: string) => { err += chunk })
  const waitFor = (n: number) =>
    rounds.length >= n ? Promise.resolve() : new Promise<void>((resolve, reject) => waiters.push({ n, resolve, reject }))
  return { child, rounds, stderr: () => err, waitFor, exited }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('写后进程被杀(SIGKILL)', () => {
  it('再打开:打印过的每一轮都在,没有半条记录;去重表认得它们;视图可从事件重建;出站游标保留', async () => {
    const db = tmpDb()
    cleanups.push(db.cleanup)
    const w = startWriter(db.path, ['kill'])
    await w.waitFor(40)
    w.child.kill('SIGKILL')
    const { signal } = await w.exited
    expect(signal).toBe('SIGKILL')
    const printed = [...w.rounds]
    expect(printed.length).toBeGreaterThanOrEqual(40)

    const ledger = openLedger(db.path, { origin: 'mac-a' })
    cleanups.push(() => ledger.close())
    expect(ledger.integrityCheck()).toBe('ok')

    // 一条请求 = 两条事件 + 一行请求表,一起落或一起不落
    const stats = ledger.stats()
    expect(stats.events).toBe(stats.requests * 2)
    expect(stats.objects).toBe(stats.requests)
    // 打印过的一定提交了(可能还多一轮:提交了、没来得及打印)
    expect(stats.requests).toBeGreaterThanOrEqual(printed.length)
    expect(stats.requests).toBeLessThanOrEqual(printed.length + 1)

    // 视图与事件对得上,重建后一模一样
    const snap = ledger.snapshot()
    expect(snap.snapshot_seq).toBe(stats.events)
    expect({ objects: snap.objects, deliveries: snap.deliveries, asks: snap.asks }).toEqual(foldEvents(ledger.events(0)))
    ledger.rebuildViews()
    expect(ledger.snapshot()).toEqual(snap)

    // 出站游标:至少到最后打印的那一轮(ack 在打印之前)
    const lastPrinted = printed.at(-1) as Round
    expect(ledger.outbox.cursor('relay')).toBeGreaterThanOrEqual(lastPrinted.seq)

    // 重发被杀前提交过的请求:只回存着的结果,不再写事件
    for (const r of [printed[0] as Round, lastPrinted]) {
      const again = ledger.request({ request_id: `req-${r.i}`, op: 'writer.round' }, () => {
        throw new Error('不该再执行')
      })
      expect(again).toMatchObject({ ok: true, replayed: true, result: { object_id: r.object_id, seq: r.seq } })
    }
    expect(ledger.stats()).toEqual(stats)

    // 被杀之后接着写,seq 接着排
    const next = ledger.objects.create({ request_id: 'after-kill', actor: ALICE, owner: 'alice', status: 'todo', data: {} })
    expect(next).toMatchObject({ ok: true, seq: stats.events + 1 })
  })
})

describe('快照与续流交错(另一个进程在写)', () => {
  it('写的同时取快照,再 since=snapshot_seq 续流:不漏不重,快照 + 续流 = 最终', async () => {
    const db = tmpDb()
    cleanups.push(db.cleanup)
    const total = 300
    const w = startWriter(db.path, ['stream', String(total)])
    await w.waitFor(20)

    const reader = openLedger(db.path, { readOnly: true })
    cleanups.push(() => reader.close())
    const snap = reader.snapshot()
    const writerStillRunning = w.child.exitCode === null
    expect(snap.snapshot_seq).toBeGreaterThanOrEqual(40)

    // 边写边续
    const tail: LedgerEvent[] = []
    let since = snap.snapshot_seq
    let done = false
    void w.exited.then(() => { done = true })
    for (;;) {
      const finished = done
      const batch = reader.events(since, { limit: 50 })
      tail.push(...batch)
      if (batch.length > 0) since = (batch.at(-1) as LedgerEvent).seq
      else if (finished) break
      else await sleep(3)
    }
    const { code } = await w.exited
    expect(code, w.stderr()).toBe(0)
    expect(writerStillRunning).toBe(true)
    expect(snap.snapshot_seq).toBeLessThan(total * 2)

    // 不漏不重:续流的 seq 正好是 snapshot_seq+1 … 最终
    expect(tail.map((e) => e.seq)).toEqual(Array.from({ length: total * 2 - snap.snapshot_seq }, (_, k) => snap.snapshot_seq + 1 + k))

    // 快照本身与 ≤ snapshot_seq 的事件一致;快照 + 续流 = 最终视图
    const all = reader.events(0)
    expect({ objects: snap.objects, deliveries: snap.deliveries, asks: snap.asks }).toEqual(foldEvents(all.filter((e) => e.seq <= snap.snapshot_seq)))
    const final = reader.snapshot()
    expect(final.snapshot_seq).toBe(total * 2)
    expect(foldEvents(tail, snap)).toEqual({ objects: final.objects, deliveries: final.deliveries, asks: final.asks })
  })

  it('写得很密时反复取快照:每一份的视图都正好等于 ≤ snapshot_seq 的事件(读在一条读事务里)', async () => {
    const db = tmpDb()
    cleanups.push(db.cleanup)
    const total = 3000
    const w = startWriter(db.path, ['stream', String(total), 'fast'])
    await w.waitFor(5)
    const reader = openLedger(db.path, { readOnly: true })
    cleanups.push(() => reader.close())

    let done = false
    void w.exited.then(() => { done = true })
    const snaps: Snapshot[] = []
    while (!done) {
      snaps.push(reader.snapshot())
      await new Promise((r) => setImmediate(r))
    }
    const { code } = await w.exited
    expect(code, w.stderr()).toBe(0)
    const distinct = new Set(snaps.map((s) => s.snapshot_seq))
    expect(distinct.size, `只取到 ${distinct.size} 个不同的 snapshot_seq`).toBeGreaterThanOrEqual(10)

    const all = reader.events(0)
    let state = foldEvents([])
    let at = 0
    for (const s of [...snaps].sort((a, b) => a.snapshot_seq - b.snapshot_seq)) {
      state = foldEvents(all.slice(at, s.snapshot_seq), state)
      at = s.snapshot_seq
      expect({ objects: s.objects, deliveries: s.deliveries, asks: s.asks }, `snapshot_seq=${s.snapshot_seq}`).toEqual(state)
    }
  })
})
