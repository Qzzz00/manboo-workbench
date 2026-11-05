import { readFileSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { foldEvents, Gone, openLedger, Reject, type Ledger } from '../index.ts'
import { ALICE, ALICE_OLD_PHONE, BOB, clock, DAY, tmpDb } from './helpers.ts'

let cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.reverse()) c()
  cleanups = []
})

function fresh(opts: Parameters<typeof openLedger>[1] = {}): { ledger: Ledger; path: string } {
  const db = tmpDb()
  const ledger = openLedger(db.path, { origin: 'mac-a', ...opts })
  cleanups.push(db.cleanup, () => { try { ledger.close() } catch { /* 已关 */ } })
  return { ledger, path: db.path }
}

function createTodo(ledger: Ledger, request_id: string, title = '剪片子'): string {
  const out = ledger.objects.create({ request_id, actor: ALICE, owner: 'alice', status: 'todo', data: { title } })
  if (!out.ok) throw new Error(out.error.code)
  return out.result.object_id
}

describe('打开与表结构', () => {
  it('新库是 WAL、表齐,对象 id 带来源前缀 + ulid', () => {
    const { ledger, path } = fresh()
    const id = createTodo(ledger, 'r1')
    expect(id).toMatch(/^mac-a\.[0-9A-HJKMNP-TV-Z]{26}$/)

    const raw = new DatabaseSync(path, { readOnly: true })
    const mode = raw.prepare('PRAGMA journal_mode').get() as { journal_mode: string }
    expect(mode.journal_mode).toBe('wal')
    const tables = (raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((r) => r.name)
    for (const t of ['events', 'request_log', 'objects', 'deliveries', 'asks', 'outbox', 'meta']) expect(tables).toContain(t)
    raw.close()
  })

  it('同一个库换来源前缀打开 → 拒绝(身份不许中途改)', () => {
    const db = tmpDb()
    cleanups.push(db.cleanup)
    openLedger(db.path, { origin: 'mac-a' }).close()
    expect(() => openLedger(db.path, { origin: 'mac-b' })).toThrow(/origin/)
    const again = openLedger(db.path)
    expect(again.origin).toBe('mac-a')
    again.close()
  })

  it('新库不给来源前缀 → 拒绝', () => {
    const db = tmpDb()
    cleanups.push(db.cleanup)
    expect(() => openLedger(db.path)).toThrow(/origin/)
  })

  it('读坏了的文件不当空账:打开即抛,原文件一个字节不动', () => {
    const db = tmpDb()
    cleanups.push(db.cleanup)
    const junk = 'not a ledger '.repeat(400)
    writeFileSync(db.path, junk)
    expect(() => openLedger(db.path, { origin: 'mac-a' })).toThrow()
    expect(readFileSync(db.path, 'utf8')).toBe(junk)
  })

  it('只读打开不能写', () => {
    const { ledger, path } = fresh()
    createTodo(ledger, 'r1')
    const ro = openLedger(path, { readOnly: true })
    cleanups.push(() => ro.close())
    expect(ro.snapshot().objects).toHaveLength(1)
    expect(() => createTodo(ro, 'r2')).toThrow()
  })
})

describe('一次提交 = 一个事务', () => {
  it('commit:几条事件 + 请求结果一起落,事件 seq 连号、对象版本逐条 +1', () => {
    const { ledger } = fresh()
    const id = createTodo(ledger, 'r1')
    const out = ledger.commit({
      request_id: 'r2',
      events: [
        { kind: 'object.updated', object_id: id, actor: ALICE, payload: { status: 'doing' } },
        { kind: 'comment', object_id: id, actor: BOB, payload: { text: '素材在网盘' } },
      ],
      result: { note: 'ok' },
    })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.events.map((e) => e.seq)).toEqual([2, 3])
    expect(out.events.map((e) => e.object_version)).toEqual([2, 3])
    expect(out.events.every((e) => e.request_id === 'r2')).toBe(true)
    expect(out.events[0]?.origin).toEqual({ device: 'mac-a', seq: 2 })
    expect(ledger.objects.get(id)).toMatchObject({ status: 'doing', version: 3, owner: 'alice', owner_epoch: 1 })
  })

  it('handler 中途抛错(不是拒绝):事件、视图、请求表一样都不留,同一 request_id 还能重来', () => {
    const { ledger } = fresh()
    const id = createTodo(ledger, 'r1')
    const before = ledger.stats()
    expect(() =>
      ledger.request('r2', (tx) => {
        tx.emit({ kind: 'object.updated', object_id: id, actor: ALICE, payload: { status: 'doing' } })
        throw new Error('手那边炸了')
      }),
    ).toThrow('手那边炸了')
    expect(ledger.stats()).toEqual(before)
    expect(ledger.objects.get(id)?.status).toBe('todo')

    const retry = ledger.request('r2', (tx) => {
      tx.emit({ kind: 'object.updated', object_id: id, actor: ALICE, payload: { status: 'doing' } })
      return 'done'
    })
    expect(retry).toMatchObject({ ok: true, replayed: false, result: 'done' })
  })

  it('handler 写了事件之后才拒绝:这次写的全部回滚,拒绝结果照样进请求表', () => {
    const { ledger } = fresh()
    const id = createTodo(ledger, 'r1')
    const before = ledger.stats()
    const out = ledger.request({ request_id: 'r2', op: 'test.late-reject' }, (tx) => {
      tx.emit({ kind: 'object.updated', object_id: id, actor: ALICE, payload: { status: 'doing' } })
      tx.emit({ kind: 'comment', object_id: id, actor: ALICE, payload: { text: '先写了一条' } })
      throw new Reject('hand_refused', { why: '手那边说不行' })
    })
    expect(out).toMatchObject({ ok: false, replayed: false, seq: null, events: [], error: { code: 'hand_refused', detail: { why: '手那边说不行' } } })
    expect(ledger.stats()).toEqual({ ...before, requests: before.requests + 1 })
    expect(ledger.objects.get(id)).toMatchObject({ status: 'todo', version: 1 })
    expect(ledger.request({ request_id: 'r2', op: 'test.late-reject' }, () => 'x')).toMatchObject({ ok: false, replayed: true, error: { code: 'hand_refused' } })
  })

  it('广播只在提交后:订阅者收到时库里已经读得到;被拒与重发不广播', () => {
    const { ledger, path } = fresh()
    const seen: number[] = []
    let visibleFromOtherConnection = -1
    ledger.subscribe((events) => {
      seen.push(...events.map((e) => e.seq))
      const raw = new DatabaseSync(path, { readOnly: true })
      const row = raw.prepare('SELECT MAX(seq) AS m FROM events').get() as { m: number }
      visibleFromOtherConnection = row.m
      raw.close()
    })
    const id = createTodo(ledger, 'r1')
    expect(seen).toEqual([1])
    expect(visibleFromOtherConnection).toBe(1)

    createTodo(ledger, 'r1') // 重发
    const stale = ledger.objects.update({ request_id: 'r3', actor: ALICE, object_id: id, expected_owner_epoch: 9, status: 'done' })
    expect(stale.ok).toBe(false)
    expect(seen).toEqual([1])
  })
})

describe('请求去重(request_log)', () => {
  it('同一 request_id 重发:只回存着的结果,不再执行 handler、不再写事件', () => {
    const { ledger, path } = fresh()
    let calls = 0
    const run = () =>
      ledger.request({ request_id: 'dup-1', op: 'test.create', device_id: 'alice-mac', person: 'alice' }, (tx) => {
        calls += 1
        const ev = tx.emit({ kind: 'object.created', object_id: tx.newObjectId(), actor: ALICE, payload: { owner: 'alice', status: 'todo', data: {} } })
        return { object_id: ev.object_id, at: calls }
      })
    const first = run()
    const seqAfter = ledger.maxSeq()
    const second = run()
    expect(calls).toBe(1)
    expect(first).toMatchObject({ ok: true, replayed: false })
    expect(second).toMatchObject({ ok: true, replayed: true })
    if (!first.ok || !second.ok) return
    expect(second.result).toEqual(first.result)
    expect(second.seq).toBe(first.seq)
    expect(ledger.maxSeq()).toBe(seqAfter)
    ledger.close()

    // 重启之后照样认得
    const reopened = openLedger(path)
    cleanups.push(() => reopened.close())
    const third = reopened.request('dup-1', () => { calls += 1; return { object_id: 'x', at: -1 } })
    expect(calls).toBe(1)
    expect(third).toMatchObject({ ok: true, replayed: true, result: first.result })
    expect(reopened.maxSeq()).toBe(seqAfter)
  })

  it('同一 request_id 换了操作名 → request_id_conflict,不覆盖存着的结果', () => {
    const { ledger } = fresh()
    createTodo(ledger, 'same')
    const clash = ledger.request({ request_id: 'same', op: 'objects.update' }, () => 'x')
    expect(clash).toMatchObject({ ok: false, error: { code: 'request_id_conflict' } })
    expect(createTodo(ledger, 'same')).toBeTruthy()
  })
})

describe('唯一权威写入方与交接(owner_epoch)', () => {
  it('旧 owner_epoch 的改状态请求被拒 stale_owner(结果进请求表),附加类请求照写', () => {
    const { ledger } = fresh()
    const id = createTodo(ledger, 'c1')
    const handed = ledger.transfer({ request_id: 't1', actor: ALICE, object_id: id, new_owner: 'bob', expected_owner_epoch: 1 })
    expect(handed).toMatchObject({ ok: true, result: { owner_epoch: 2 } })
    const seqAfterTransfer = ledger.maxSeq()

    // 交接前那台旧手机带着 epoch 1 回来改状态
    const stale = ledger.objects.update({ request_id: 'u-old', actor: ALICE_OLD_PHONE, object_id: id, expected_owner_epoch: 1, status: 'done' })
    expect(stale).toMatchObject({ ok: false, replayed: false, error: { code: 'stale_owner', detail: { owner: 'bob', owner_epoch: 2 } } })
    expect(ledger.maxSeq()).toBe(seqAfterTransfer)
    expect(ledger.objects.get(id)?.status).toBe('todo')
    // 重发同一条:回的还是那次拒绝
    const staleAgain = ledger.objects.update({ request_id: 'u-old', actor: ALICE_OLD_PHONE, object_id: id, expected_owner_epoch: 1, status: 'done' })
    expect(staleAgain).toMatchObject({ ok: false, replayed: true, error: { code: 'stale_owner' } })

    // 附加类(评论)不核 epoch,由权威写入方按到达顺序写
    const comment = ledger.objects.append({ request_id: 'a1', actor: ALICE_OLD_PHONE, object_id: id, kind: 'comment', payload: { text: '我手上还有一版' } })
    expect(comment).toMatchObject({ ok: true })
    expect(ledger.maxSeq()).toBe(seqAfterTransfer + 1)
    const last = ledger.objectEvents(id).at(-1)
    expect(last).toMatchObject({ kind: 'comment', request_id: 'a1', actor: ALICE_OLD_PHONE })

    // 现任带着新 epoch 改状态 → 过
    const fresh2 = ledger.objects.update({ request_id: 'u-new', actor: BOB, object_id: id, expected_owner_epoch: 2, status: 'doing' })
    expect(fresh2).toMatchObject({ ok: true })
    expect(ledger.objects.get(id)).toMatchObject({ owner: 'bob', owner_epoch: 2, status: 'doing' })
  })

  it('交接事件是「负责人变了」:epoch +1、对象版本 +1,旧负责人的交接请求再来被拒', () => {
    const { ledger } = fresh()
    const id = createTodo(ledger, 'c1')
    ledger.transfer({ request_id: 't1', actor: ALICE, object_id: id, new_owner: 'bob', expected_owner_epoch: 1 })
    const ev = ledger.objectEvents(id).at(-1)
    expect(ev).toMatchObject({ kind: 'object.owner_changed', object_version: 2, payload: { from: 'alice', to: 'bob', owner_epoch: 2 } })
    const again = ledger.transfer({ request_id: 't2', actor: ALICE_OLD_PHONE, object_id: id, new_owner: 'carol', expected_owner_epoch: 1 })
    expect(again).toMatchObject({ ok: false, error: { code: 'stale_owner' } })
  })

  it('改状态请求不带 expected_owner_epoch → 拒;expected_version 对不上 → stale_version', () => {
    const { ledger } = fresh()
    const id = createTodo(ledger, 'c1')
    const missing = ledger.objects.update({ request_id: 'u1', actor: ALICE, object_id: id, status: 'doing' } as never)
    expect(missing).toMatchObject({ ok: false, error: { code: 'expected_owner_epoch_required' } })
    const lock = ledger.objects.update({ request_id: 'u2', actor: ALICE, object_id: id, expected_owner_epoch: 1, expected_version: 7, status: 'doing' })
    expect(lock).toMatchObject({ ok: false, error: { code: 'stale_version', detail: { version: 1 } } })
    const ok = ledger.objects.update({ request_id: 'u3', actor: ALICE, object_id: id, expected_owner_epoch: 1, expected_version: 1, status: 'doing', data: { title: '剪片子 v2', cut: 2 } })
    expect(ok).toMatchObject({ ok: true, result: { version: 2 } })
    expect(ledger.objects.get(id)?.data).toEqual({ title: '剪片子 v2', cut: 2 })
  })

  it('附加类请求不许冒用改状态的事件种类', () => {
    const { ledger } = fresh()
    const id = createTodo(ledger, 'c1')
    const sneaky = ledger.objects.append({ request_id: 'a1', actor: BOB, object_id: id, kind: 'object.updated', payload: { status: 'done' } })
    expect(sneaky).toMatchObject({ ok: false, error: { code: 'reserved_kind' } })
    expect(ledger.objects.get(id)?.status).toBe('todo')
  })
})

describe('快照与续流', () => {
  it('快照回已提交最大 seq + 视图;视图等于把 ≤ snapshot_seq 的事件折一遍', () => {
    const { ledger } = fresh()
    const a = createTodo(ledger, 'c1')
    createTodo(ledger, 'c2', '写脚本')
    ledger.objects.update({ request_id: 'u1', actor: ALICE, object_id: a, expected_owner_epoch: 1, status: 'doing' })
    const snap = ledger.snapshot()
    expect(snap.snapshot_seq).toBe(3)
    expect(snap.objects).toHaveLength(2)
    const folded = foldEvents(ledger.events(0))
    expect({ objects: snap.objects, deliveries: snap.deliveries, asks: snap.asks }).toEqual(folded)

    ledger.objects.update({ request_id: 'u2', actor: ALICE, object_id: a, expected_owner_epoch: 1, status: 'done' })
    const tail = ledger.events(snap.snapshot_seq)
    expect(tail.map((e) => e.seq)).toEqual([4])
    expect(foldEvents(tail, snap)).toEqual(foldEvents(ledger.events(0)))
  })

  it('since 早于保留窗 → Gone(410);窗内照常;since 超前也 Gone', () => {
    const c = clock()
    const { ledger } = fresh({ now: c.now })
    createTodo(ledger, 'old')
    c.advance(31 * DAY)
    createTodo(ledger, 'new')
    let caught: unknown
    try { ledger.events(0) } catch (e) { caught = e }
    expect(caught).toBeInstanceOf(Gone)
    expect(caught).toMatchObject({ status: 410, reason: 'expired' })
    expect(ledger.events(1).map((e) => e.seq)).toEqual([2])
    expect(ledger.events(2)).toEqual([])
    expect(() => ledger.events(9)).toThrow(Gone)
  })

  it('保留窗可配', () => {
    const c = clock()
    const { ledger } = fresh({ now: c.now, retentionDays: 7 })
    createTodo(ledger, 'old')
    c.advance(6 * DAY)
    expect(ledger.events(0)).toHaveLength(1)
    c.advance(2 * DAY)
    expect(() => ledger.events(0)).toThrow(Gone)
  })
})

describe('出站队列', () => {
  it('按目的地记 last_acked,重启后保留;只进不退;不许超过已提交的 seq', () => {
    const { ledger, path } = fresh()
    createTodo(ledger, 'c1')
    createTodo(ledger, 'c2')
    createTodo(ledger, 'c3')
    expect(ledger.outbox.cursor('relay')).toBe(0)
    expect(ledger.outbox.pending('relay').map((e) => e.seq)).toEqual([1, 2, 3])
    ledger.outbox.ack('relay', 2)
    ledger.outbox.ack('relay', 1)
    ledger.outbox.ack('phone:alice', 3)
    expect(() => ledger.outbox.ack('relay', 99)).toThrow()
    ledger.close()

    const reopened = openLedger(path)
    cleanups.push(() => reopened.close())
    expect(reopened.outbox.cursor('relay')).toBe(2)
    expect(reopened.outbox.cursor('phone:alice')).toBe(3)
    expect(reopened.outbox.pending('relay').map((e) => e.seq)).toEqual([3])
    expect(reopened.outbox.list().map((o) => o.destination).sort()).toEqual(['phone:alice', 'relay'])
  })
})

describe('导出与重建', () => {
  it('exportJsonl(object_id):只含该对象的事件,按 seq 一行一条', () => {
    const { ledger } = fresh()
    const a = createTodo(ledger, 'c1')
    createTodo(ledger, 'c2')
    ledger.objects.append({ request_id: 'a1', actor: BOB, object_id: a, kind: 'comment', payload: { text: '好' } })
    const lines = ledger.exportJsonl(a).trimEnd().split('\n').map((l) => JSON.parse(l))
    expect(lines.map((e) => [e.seq, e.kind])).toEqual([[1, 'object.created'], [3, 'comment']])
    expect(ledger.exportJsonl().trimEnd().split('\n')).toHaveLength(3)
  })

  it('rebuildViews 从事件重建出一模一样的视图', () => {
    const { ledger } = fresh()
    const a = createTodo(ledger, 'c1')
    ledger.deliveries.create({ request_id: 'd1', actor: ALICE, object_id: a, expected_owner_epoch: 1, family: 'claude', channel: 'socket', target: { family: 'claude', session_id: 's1' } })
    ledger.transfer({ request_id: 't1', actor: ALICE, object_id: a, new_owner: 'bob', expected_owner_epoch: 1 })
    const before = ledger.snapshot()
    ledger.rebuildViews()
    expect(ledger.snapshot()).toEqual(before)
  })

  it('stats 数得出事件、请求、对象、委派、ask', () => {
    const { ledger } = fresh()
    const a = createTodo(ledger, 'c1')
    ledger.deliveries.create({ request_id: 'd1', actor: ALICE, object_id: a, expected_owner_epoch: 1, family: 'codex' })
    expect(ledger.stats()).toEqual({ events: 2, requests: 2, objects: 1, deliveries: 1, asks: 0, open_asks: 0 })
  })
})
