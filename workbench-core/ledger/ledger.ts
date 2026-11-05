/**
 * 账:一个 node:sqlite 库(WAL),一次提交 = 一个事务。契约见评审稿 v3 §5.2。
 *
 * - 写只在 BEGIN IMMEDIATE 的事务里:事件 + 视图 + 请求结果一起落,synchronous=FULL(macOS 再加 F_FULLFSYNC)。
 * - 提交返回之后才回结果、才通知订阅者(广播 / 出站都挂在订阅上),所以外面看到的一定已落盘。
 * - 请求按 request_id 去重:请求表里有就回存着的结果,不再执行、不再写事件。
 * - 一个库只许一个写进程(座机服务);别的进程用 readOnly 打开读。
 * - 处理函数必须同步;node:sqlite 是同步接口,事务里不许 await。
 */
import { existsSync, statSync } from 'node:fs'
import { DatabaseSync, type StatementSync } from 'node:sqlite'
import { Gone, LedgerCorrupt, Reject } from './errors.ts'
import { assertOrigin, ulid } from './ids.ts'
import { applyEvent, isReservedKind, KINDS, nextObjectVersion, sortViews, type ViewChanges, type ViewReader } from './reduce.ts'
import { DDL, SCHEMA_VERSION } from './schema.ts'
import type {
  Actor,
  AnswerInput,
  AnswerResult,
  AppendInput,
  AskStatus,
  AskView,
  CancelAskInput,
  CommitOutcome,
  CommitRecord,
  CreateDeliveryInput,
  CreateObjectInput,
  DeliveryView,
  EventInput,
  LedgerEvent,
  LedgerStats,
  NewAttemptInput,
  ObjectView,
  OpenAskInput,
  OutboxCursor,
  RejectInfo,
  RequestMeta,
  RequestOutcome,
  ReviseAskInput,
  Snapshot,
  TransferInput,
  TransferResult,
  Tx,
  UpdateDeliveryInput,
  UpdateObjectInput,
} from './types.ts'

export interface LedgerOptions {
  /** 来源座机服务前缀(进每个 object_id / ask_id)。新库必填;旧库给了就必须与库里一致。 */
  origin?: string
  /** since 的保留窗,默认 30 天。 */
  retentionDays?: number
  /** 钟(毫秒)。测试用。 */
  now?: () => number
  /** 只读打开:不建表、不能写。给读进程用。 */
  readOnly?: boolean
  /** macOS 上 fsync 不落盘缓存,默认开 F_FULLFSYNC(每次提交约 3 毫秒)。 */
  fullfsync?: boolean
  /** 等别的连接放锁的上限,默认 5000 毫秒。 */
  busyTimeoutMs?: number
  /** 订阅者抛错时(不影响已提交的结果)。默认打到 stderr。 */
  onListenerError?: (err: unknown) => void
}

export interface Ledger {
  readonly path: string
  readonly origin: string
  /** 直接提交几条事件(系统写入、导入)。带 request_id 时按请求去重。不核 epoch。 */
  commit(record: CommitRecord): CommitOutcome
  /** 按 request_id 去重地执行一次处理:有存着的结果就回它;没有就在事务里跑 handler。 */
  request<R>(meta: RequestMeta | string, handler: (tx: Tx) => R): RequestOutcome<R>
  /** 一条读事务里取已提交最大 seq + 视图。 */
  snapshot(): Snapshot
  /** seq > since 的事件。since 早于保留窗或超前 → 抛 Gone(调用方回 410)。 */
  events(since: number, opts?: { limit?: number }): LedgerEvent[]
  objectEvents(object_id: string): LedgerEvent[]
  maxSeq(): number
  objects: {
    create(input: CreateObjectInput): RequestOutcome<{ object_id: string; version: number }>
    update(input: UpdateObjectInput): RequestOutcome<{ version: number }>
    append(input: AppendInput): RequestOutcome<{ version: number }>
    get(object_id: string): ObjectView | undefined
    byLegacyId(legacy_id: string): ObjectView | undefined
    list(): ObjectView[]
  }
  /** 交接:owner_epoch +1,事件「负责人变了」,旧负责人名下 open 的 ask 全部 cancelled。 */
  transfer(input: TransferInput): RequestOutcome<TransferResult>
  deliveries: {
    create(input: CreateDeliveryInput): RequestOutcome<{ delivery_id: string; n: number; attempt_id: number }>
    /** 重发 / 换路 / 手重启:attempt_id +1,这条委派下 open 的 ask 全部 superseded。 */
    newAttempt(input: NewAttemptInput): RequestOutcome<{ attempt_id: number; superseded_asks: string[] }>
    update(input: UpdateDeliveryInput): RequestOutcome<{ version: number }>
    get(delivery_id: string): DeliveryView | undefined
    ofObject(object_id: string): DeliveryView[]
  }
  asks: {
    open(input: OpenAskInput): RequestOutcome<{ ask_id: string; ask_version: number }>
    /** 同一工具再问:内容哈希变了 → ask_version +1;没变 → 原样。 */
    revise(input: ReviseAskInput): RequestOutcome<{ ask_version: number }>
    answer(input: AnswerInput): RequestOutcome<AnswerResult>
    /** 把到点的 open ask 记成 expired,回它们的 id。 */
    expire(): string[]
    cancel(input: CancelAskInput): RequestOutcome<{ ask_id: string }>
    get(ask_id: string): AskView | undefined
    list(filter?: { object_id?: string; delivery_id?: string; status?: AskStatus }): AskView[]
  }
  outbox: {
    /** 目的地确认收到 ≤ seq 的事件。只进不退;不许超过已提交的最大 seq。 */
    ack(destination: string, seq: number): number
    cursor(destination: string): number
    pending(destination: string, opts?: { limit?: number }): LedgerEvent[]
    list(): OutboxCursor[]
  }
  /** 人读副本:一行一条事件(给了 object_id 就只导那个对象)。 */
  exportJsonl(object_id?: string): string
  /** 清掉三张视图,从事件重新折一遍。 */
  rebuildViews(): void
  /** 提交后收到这次提交的事件(被拒、重发不通知)。回退订函数。 */
  subscribe(listener: (events: readonly LedgerEvent[]) => void): () => void
  stats(): LedgerStats
  integrityCheck(): string
  close(): void
}

const DAY_MS = 86_400_000
const ATTEMPT_REASONS = new Set(['resend', 'reroute', 'hand_restart'])

type Row = Record<string, unknown>
type StoredBody = { ok: true; result: unknown; seq: number | null } | { ok: false; error: RejectInfo; seq: null }

export function openLedger(path: string, opts: LedgerOptions = {}): Ledger {
  const clock = opts.now ?? Date.now
  const retentionMs = (opts.retentionDays ?? 30) * DAY_MS
  const readOnly = opts.readOnly === true
  if (opts.origin !== undefined) assertOrigin(opts.origin)
  const isNew = !existsSync(path) || statSync(path).size === 0
  if (isNew && readOnly) throw new Error(`ledger: ${path} 不存在,只读打不开`)
  if (isNew && !opts.origin) throw new Error('ledger: 新库必须给 origin(来源座机服务前缀)')

  const db = readOnly ? new DatabaseSync(path, { readOnly: true }) : new DatabaseSync(path)
  const closeQuietly = () => { try { db.close() } catch { /* 已关 */ } }

  let origin: string
  try {
    db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(opts.busyTimeoutMs ?? 5000))}`)
    checkReadable(db, path)
    origin = readOnly ? readMetaOrigin(db, opts.origin) : initWritable(db, opts)
  } catch (e) {
    closeQuietly()
    throw e
  }

  // ---- 语句缓存与行转换 ----
  const cache = new Map<string, StatementSync>()
  const q = (sql: string): StatementSync => {
    let s = cache.get(sql)
    if (!s) {
      s = db.prepare(sql)
      cache.set(sql, s)
    }
    return s
  }
  const one = (sql: string, ...args: Array<string | number | null>): Row | undefined => q(sql).get(...args) as Row | undefined
  const all = (sql: string, ...args: Array<string | number | null>): Row[] => q(sql).all(...args) as Row[]

  const reader: ViewReader = {
    object: (id) => { const r = one('SELECT * FROM objects WHERE object_id = ?', id); return r ? toObject(r) : undefined },
    delivery: (id) => { const r = one('SELECT * FROM deliveries WHERE delivery_id = ?', id); return r ? toDelivery(r) : undefined },
    ask: (id) => { const r = one('SELECT * FROM asks WHERE ask_id = ?', id); return r ? toAsk(r) : undefined },
  }
  const objectByLegacyId = (legacy_id: string): ObjectView | undefined => {
    const r = one('SELECT * FROM objects WHERE legacy_id = ?', legacy_id)
    return r ? toObject(r) : undefined
  }
  const deliveriesOf = (object_id: string): DeliveryView[] => all('SELECT * FROM deliveries WHERE object_id = ? ORDER BY n', object_id).map(toDelivery)
  const asksOf = (filter: { object_id?: string; delivery_id?: string; status?: AskStatus } = {}): AskView[] => {
    const where: string[] = []
    const args: string[] = []
    if (filter.object_id !== undefined) { where.push('object_id = ?'); args.push(filter.object_id) }
    if (filter.delivery_id !== undefined) { where.push('delivery_id = ?'); args.push(filter.delivery_id) }
    if (filter.status !== undefined) { where.push('status = ?'); args.push(filter.status) }
    return all(`SELECT * FROM asks${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY opened_seq`, ...args).map(toAsk)
  }
  const maxSeqRaw = (): number => (one('SELECT COALESCE(MAX(seq), 0) AS m FROM events')?.m as number) ?? 0

  // ---- 事务 ----
  let inTx = false
  const listeners = new Set<(events: readonly LedgerEvent[]) => void>()

  function writeTx<T>(fn: () => T): T {
    if (readOnly) throw new Error('ledger: 只读打开,不能写')
    if (inTx) throw new Error('ledger: 不支持嵌套事务(处理函数里别再调账的操作,用 tx)')
    inTx = true
    try {
      db.exec('BEGIN IMMEDIATE')
      try {
        const out = fn()
        db.exec('COMMIT')
        return out
      } catch (e) {
        try { db.exec('ROLLBACK') } catch { /* 已回滚 */ }
        throw e
      }
    } finally {
      inTx = false
    }
  }

  function readTx<T>(fn: () => T): T {
    if (inTx) throw new Error('ledger: 事务里不能再开读事务')
    inTx = true
    try {
      db.exec('BEGIN')
      try {
        const out = fn()
        db.exec('COMMIT')
        return out
      } catch (e) {
        try { db.exec('ROLLBACK') } catch { /* 已回滚 */ }
        throw e
      }
    } finally {
      inTx = false
    }
  }

  function notify(events: readonly LedgerEvent[]): void {
    if (events.length === 0) return
    const batch = [...events]
    for (const l of listeners) {
      try {
        l(batch)
      } catch (err) {
        if (opts.onListenerError) opts.onListenerError(err)
        else console.error('[ledger] 订阅者出错(提交不受影响):', err)
      }
    }
  }

  // ---- 写一条事件 ----
  function nextSeq(): number {
    const r = one("SELECT seq FROM sqlite_sequence WHERE name = 'events'")
    return ((r?.seq as number | undefined) ?? 0) + 1
  }

  function insertEvent(ev: LedgerEvent): void {
    q(`INSERT INTO events (seq, ts, topic, object_id, object_version, kind, actor, evidence, request_id, payload, origin_device, origin_seq)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      ev.seq, ev.ts, ev.topic, ev.object_id, ev.object_version, ev.kind, JSON.stringify(ev.actor), ev.evidence, ev.request_id,
      JSON.stringify(ev.payload), ev.origin.device, ev.origin.seq,
    )
  }

  function writeChanges(ch: ViewChanges): void {
    const o = ch.object
    if (o) {
      q(`INSERT OR REPLACE INTO objects (object_id, owner, owner_epoch, version, status, data, legacy_id, created_seq, updated_seq)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        o.object_id, o.owner, o.owner_epoch, o.version, o.status, JSON.stringify(o.data), o.legacy_id, o.created_seq, o.updated_seq,
      )
    }
    const d = ch.delivery
    if (d) {
      q(`INSERT OR REPLACE INTO deliveries (delivery_id, object_id, n, family, channel, target, attempt_id, status, data, updated_seq)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        d.delivery_id, d.object_id, d.n, d.family, d.channel, d.target === null ? null : JSON.stringify(d.target), d.attempt_id, d.status,
        JSON.stringify(d.data), d.updated_seq,
      )
    }
    const a = ch.ask
    if (a) {
      q(`INSERT OR REPLACE INTO asks (ask_id, object_id, delivery_id, attempt_id, ask_version, content_hash, owner, owner_epoch, target, kind,
           options, expires_at, status, answer, closed_reason, opened_seq, updated_seq)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        a.ask_id, a.object_id, a.delivery_id, a.attempt_id, a.ask_version, a.content_hash, a.owner, a.owner_epoch, JSON.stringify(a.target),
        a.kind, JSON.stringify(a.options), a.expires_at, a.status, a.answer === null ? null : JSON.stringify(a.answer), a.closed_reason,
        a.opened_seq, a.updated_seq,
      )
    }
  }

  function emitIn(input: EventInput, now: number, request_id: string | null, emitted: LedgerEvent[]): LedgerEvent {
    if (typeof input.kind !== 'string' || input.kind === '') throw new Error('ledger: 事件缺 kind')
    const ts = input.ts ?? now
    if (!Number.isSafeInteger(ts)) throw new Error(`ledger: 事件时刻不是整数毫秒:${ts}`)
    const object_id = input.object_id ?? null
    const prev = object_id === null ? undefined : reader.object(object_id)
    const object_version = nextObjectVersion(prev, input.kind, object_id)
    const seq = nextSeq()
    const ev: LedgerEvent = {
      seq,
      ts,
      topic: input.topic ?? (object_id === null ? 'system' : 'object'),
      object_id,
      object_version,
      kind: input.kind,
      actor: normalize(input.actor ?? {}) as Actor,
      evidence: input.evidence ?? null,
      request_id,
      payload: normalize(input.payload ?? {}),
      origin: { device: origin, seq },
    }
    const changes = applyEvent(reader, ev)
    insertEvent(ev)
    writeChanges(changes)
    emitted.push(ev)
    return ev
  }

  function requireOwner(object_id: string, expected_owner_epoch: unknown, expected_version?: unknown): ObjectView {
    const obj = reader.object(object_id)
    if (!obj) throw new Reject('object_not_found', { object_id })
    if (typeof expected_owner_epoch !== 'number' || !Number.isSafeInteger(expected_owner_epoch)) throw new Reject('expected_owner_epoch_required')
    if (expected_owner_epoch !== obj.owner_epoch) throw new Reject('stale_owner', { owner: obj.owner, owner_epoch: obj.owner_epoch, version: obj.version })
    if (expected_version !== undefined && expected_version !== null && expected_version !== obj.version) {
      throw new Reject('stale_version', { version: obj.version, owner_epoch: obj.owner_epoch })
    }
    return obj
  }

  function makeTx(now: number, request_id: string | null, emitted: LedgerEvent[]): Tx {
    return {
      now,
      request_id,
      newObjectId: () => `${origin}.${ulid(now)}`,
      newAskId: () => `${origin}.${ulid(now)}`,
      object: reader.object,
      objectByLegacyId,
      delivery: reader.delivery,
      deliveriesOf,
      ask: reader.ask,
      asksOf,
      emit: (input) => emitIn(input, now, request_id, emitted),
      requireOwner,
    }
  }

  // ---- 请求 ----
  function request<R>(metaIn: RequestMeta | string, handler: (tx: Tx) => R): RequestOutcome<R> {
    const meta: RequestMeta = typeof metaIn === 'string' ? { request_id: metaIn } : metaIn
    const request_id = meta.request_id
    if (typeof request_id !== 'string' || request_id === '') throw new Error('ledger: request_id 必填')
    const emitted: LedgerEvent[] = []
    const out = writeTx((): RequestOutcome<R> => {
      const hit = one('SELECT * FROM request_log WHERE request_id = ?', request_id)
      if (hit) {
        if (meta.op !== undefined && hit.op !== null && hit.op !== meta.op) {
          return { request_id, ok: false, error: { code: 'request_id_conflict', detail: { op: hit.op } }, seq: null, replayed: false, events: [] }
        }
        const stored = JSON.parse(hit.result as string) as unknown
        return hit.ok === 1
          ? { request_id, ok: true, result: stored as R, seq: (hit.seq as number | null) ?? null, replayed: true, events: [] }
          : { request_id, ok: false, error: stored as RejectInfo, seq: null, replayed: true, events: [] }
      }
      const now = clock()
      const tx = makeTx(now, request_id, emitted)
      db.exec('SAVEPOINT handler')
      let body: StoredBody
      try {
        const result = handler(tx)
        if (result !== null && typeof result === 'object' && typeof (result as { then?: unknown }).then === 'function') {
          throw new Error('ledger: 处理函数必须是同步的')
        }
        db.exec('RELEASE handler')
        body = { ok: true, result: normalize(result), seq: emitted.at(-1)?.seq ?? null }
      } catch (e) {
        if (!(e instanceof Reject)) throw e
        db.exec('ROLLBACK TO handler')
        db.exec('RELEASE handler')
        emitted.length = 0
        body = { ok: false, error: rejectInfo(e), seq: null }
      }
      q('INSERT INTO request_log (request_id, op, device_id, person, ok, result, seq, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
        request_id, meta.op ?? null, meta.device_id ?? null, meta.person ?? null, body.ok ? 1 : 0,
        JSON.stringify(body.ok ? body.result : body.error), body.seq, now,
      )
      return body.ok
        ? { request_id, ok: true, result: body.result as R, seq: body.seq, replayed: false, events: [...emitted] }
        : { request_id, ok: false, error: body.error, seq: null, replayed: false, events: [] }
    })
    notify(emitted)
    return out
  }

  function commit(record: CommitRecord): CommitOutcome {
    if (!Array.isArray(record.events)) throw new Error('ledger: commit 需要 events 数组')
    const run = (tx: Tx): unknown => {
      for (const e of record.events) tx.emit(e)
      return record.result ?? null
    }
    if (record.request_id !== undefined) {
      return request(record.op !== undefined ? { request_id: record.request_id, op: record.op } : { request_id: record.request_id }, run)
    }
    const emitted: LedgerEvent[] = []
    const result = writeTx(() => run(makeTx(clock(), null, emitted)))
    notify(emitted)
    return { request_id: null, ok: true, result: normalize(result), seq: emitted.at(-1)?.seq ?? null, replayed: false, events: [...emitted] }
  }

  /** 系统自己写(扫过期等),不进请求表。 */
  function systemWrite<T>(fn: (tx: Tx) => T): T {
    const emitted: LedgerEvent[] = []
    const out = writeTx(() => fn(makeTx(clock(), null, emitted)))
    notify(emitted)
    return out
  }

  // ---- 读 ----
  function snapshot(): Snapshot {
    return readTx(() => {
      const snapshot_seq = maxSeqRaw()
      const views = sortViews({
        objects: all('SELECT * FROM objects').map(toObject),
        deliveries: all('SELECT * FROM deliveries').map(toDelivery),
        asks: all('SELECT * FROM asks').map(toAsk),
      })
      return { snapshot_seq, ...views }
    })
  }

  function events(since: number, o: { limit?: number } = {}): LedgerEvent[] {
    if (!Number.isSafeInteger(since) || since < 0) throw new RangeError(`ledger: since 必须是非负整数,收到 ${since}`)
    const limit = o.limit ?? -1
    return readTx(() => {
      const max = maxSeqRaw()
      if (since > max) throw new Gone('ahead', since, max)
      if (since === max) return []
      const first = one('SELECT seq, ts FROM events WHERE seq > ? ORDER BY seq LIMIT 1', since)
      if (!first || first.seq !== since + 1 || (first.ts as number) < clock() - retentionMs) throw new Gone('expired', since, max)
      return all('SELECT * FROM events WHERE seq > ? ORDER BY seq LIMIT ?', since, limit).map(toEvent)
    })
  }

  // ---- 领域操作 ----
  const objects: Ledger['objects'] = {
    create: (input) =>
      request(metaOf(input.request_id, 'objects.create', input.actor), (tx) => {
        const owner = needStr(input.owner, 'owner')
        if (input.legacy_id !== undefined) {
          const taken = tx.objectByLegacyId(input.legacy_id)
          if (taken) throw new Reject('legacy_id_taken', { object_id: taken.object_id })
        }
        const object_id = tx.newObjectId()
        tx.emit({
          kind: KINDS.objectCreated,
          object_id,
          actor: input.actor,
          payload: { owner, status: input.status ?? null, data: input.data ?? {}, ...(input.legacy_id !== undefined ? { legacy_id: input.legacy_id } : {}) },
        })
        return { object_id, version: 1 }
      }),
    update: (input) =>
      request(metaOf(input.request_id, 'objects.update', input.actor), (tx) => {
        tx.requireOwner(input.object_id, input.expected_owner_epoch, input.expected_version)
        const payload: Record<string, unknown> = {}
        if ('status' in input) payload.status = input.status ?? null
        if (input.data !== undefined) payload.data = input.data
        if (Object.keys(payload).length === 0) throw new Reject('nothing_to_update')
        const ev = tx.emit({ kind: KINDS.objectUpdated, object_id: input.object_id, actor: input.actor, payload })
        return { version: ev.object_version as number }
      }),
    append: (input) =>
      request(metaOf(input.request_id, 'objects.append', input.actor), (tx) => {
        const kind = needStr(input.kind, 'kind')
        if (isReservedKind(kind)) throw new Reject('reserved_kind', { kind })
        if (!tx.object(input.object_id)) throw new Reject('object_not_found', { object_id: input.object_id })
        const ev = tx.emit({ kind, object_id: input.object_id, actor: input.actor, payload: input.payload ?? {}, evidence: input.evidence ?? null })
        return { version: ev.object_version as number }
      }),
    get: (id) => reader.object(id),
    byLegacyId: objectByLegacyId,
    list: () => all('SELECT * FROM objects ORDER BY created_seq').map(toObject),
  }

  const transfer: Ledger['transfer'] = (input) =>
    request(metaOf(input.request_id, 'transfer', input.actor), (tx) => {
      const obj = tx.requireOwner(input.object_id, input.expected_owner_epoch)
      const to = needStr(input.new_owner, 'new_owner')
      if (to === obj.owner) throw new Reject('same_owner', { owner: obj.owner })
      const owner_epoch = obj.owner_epoch + 1
      let last = tx.emit({ kind: KINDS.ownerChanged, object_id: obj.object_id, actor: input.actor, payload: { from: obj.owner, to, owner_epoch } })
      const cancelled_asks: string[] = []
      for (const a of tx.asksOf({ object_id: obj.object_id, status: 'open' })) {
        if (a.owner !== obj.owner) continue
        last = tx.emit({ kind: KINDS.askClosed, object_id: obj.object_id, actor: input.actor, payload: { ask_id: a.ask_id, status: 'cancelled', reason: 'transferred' } })
        cancelled_asks.push(a.ask_id)
      }
      return { owner_epoch, version: last.object_version as number, cancelled_asks }
    })

  const deliveries: Ledger['deliveries'] = {
    create: (input) =>
      request(metaOf(input.request_id, 'deliveries.create', input.actor), (tx) => {
        const obj = tx.requireOwner(input.object_id, input.expected_owner_epoch)
        const family = needStr(input.family, 'family')
        const n = tx.deliveriesOf(obj.object_id).reduce((m, d) => Math.max(m, d.n), 0) + 1
        const delivery_id = `${obj.object_id}.d${n}`
        tx.emit({
          kind: KINDS.deliveryCreated,
          object_id: obj.object_id,
          actor: input.actor,
          payload: { delivery_id, n, family, channel: input.channel ?? null, target: input.target ?? null, status: input.status ?? 'pending', data: input.data ?? {} },
        })
        return { delivery_id, n, attempt_id: 1 }
      }),
    newAttempt: (input) =>
      request(metaOf(input.request_id, 'deliveries.newAttempt', input.actor), (tx) => {
        const d = tx.delivery(input.delivery_id)
        if (!d) throw new Reject('delivery_not_found', { delivery_id: input.delivery_id })
        tx.requireOwner(d.object_id, input.expected_owner_epoch)
        if (!ATTEMPT_REASONS.has(input.reason)) throw new Reject('invalid_input', { field: 'reason' })
        const attempt_id = d.attempt_id + 1
        tx.emit({
          kind: KINDS.deliveryAttempt,
          object_id: d.object_id,
          actor: input.actor,
          payload: { delivery_id: d.delivery_id, attempt_id, reason: input.reason, ...(input.target !== undefined ? { target: input.target } : {}) },
        })
        const superseded_asks: string[] = []
        for (const a of tx.asksOf({ delivery_id: d.delivery_id, status: 'open' })) {
          tx.emit({ kind: KINDS.askClosed, object_id: d.object_id, actor: input.actor, payload: { ask_id: a.ask_id, status: 'superseded', reason: input.reason } })
          superseded_asks.push(a.ask_id)
        }
        return { attempt_id, superseded_asks }
      }),
    update: (input) =>
      request(metaOf(input.request_id, 'deliveries.update', input.actor), (tx) => {
        const d = tx.delivery(input.delivery_id)
        if (!d) throw new Reject('delivery_not_found', { delivery_id: input.delivery_id })
        tx.requireOwner(d.object_id, input.expected_owner_epoch)
        const payload: Record<string, unknown> = { delivery_id: d.delivery_id }
        if (input.status !== undefined) payload.status = needStr(input.status, 'status')
        if (input.target !== undefined) payload.target = input.target
        if (input.data !== undefined) payload.data = input.data
        if (Object.keys(payload).length === 1) throw new Reject('nothing_to_update')
        const ev = tx.emit({ kind: KINDS.deliveryUpdated, object_id: d.object_id, actor: input.actor, payload })
        return { version: ev.object_version as number }
      }),
    get: (id) => reader.delivery(id),
    ofObject: deliveriesOf,
  }

  const asks: Ledger['asks'] = {
    open: (input) =>
      request(metaOf(input.request_id, 'asks.open', input.actor), (tx) => {
        const d = tx.delivery(input.delivery_id)
        if (!d) throw new Reject('delivery_not_found', { delivery_id: input.delivery_id })
        if (input.attempt_id !== undefined && input.attempt_id !== d.attempt_id) throw new Reject('stale_attempt', { attempt_id: d.attempt_id })
        const obj = tx.object(d.object_id) as ObjectView
        const options = needOptions(input.options)
        const content_hash = needStr(input.content_hash, 'content_hash')
        const kind = needStr(input.kind, 'kind')
        if (!Number.isSafeInteger(input.expires_at) || input.expires_at <= tx.now) throw new Reject('invalid_input', { field: 'expires_at' })
        if (input.target === null || typeof input.target !== 'object') throw new Reject('invalid_input', { field: 'target' })
        const ask_id = tx.newAskId()
        tx.emit({
          kind: KINDS.askOpened,
          object_id: d.object_id,
          actor: input.actor,
          payload: {
            ask_id, delivery_id: d.delivery_id, attempt_id: d.attempt_id, ask_version: 1, content_hash,
            owner: obj.owner, owner_epoch: obj.owner_epoch, target: input.target, kind, options, expires_at: input.expires_at,
          },
        })
        return { ask_id, ask_version: 1 }
      }),
    revise: (input) =>
      request(metaOf(input.request_id, 'asks.revise', input.actor), (tx) => {
        const a = openAskOrReject(tx, input.ask_id)
        const content_hash = needStr(input.content_hash, 'content_hash')
        if (content_hash === a.content_hash && input.options === undefined && input.expires_at === undefined) return { ask_version: a.ask_version }
        const ask_version = a.ask_version + 1
        tx.emit({
          kind: KINDS.askRevised,
          object_id: a.object_id,
          actor: input.actor,
          payload: {
            ask_id: a.ask_id, ask_version, content_hash,
            ...(input.options !== undefined ? { options: needOptions(input.options) } : {}),
            ...(input.expires_at !== undefined ? { expires_at: input.expires_at } : {}),
          },
        })
        return { ask_version }
      }),
    answer: (input) =>
      request(metaOf(input.request_id, 'asks.answer', input.by), (tx): AnswerResult => {
        const a = openAskOrReject(tx, input.ask_id)
        if (tx.now >= a.expires_at) throw new Reject('ask_expired', { expires_at: a.expires_at })
        if (input.ask_version !== a.ask_version) throw new Reject('ask_version_mismatch', { ask_version: a.ask_version })
        if (input.content_hash !== a.content_hash) throw new Reject('ask_content_mismatch')
        const object = tx.object(a.object_id) as ObjectView
        const allowed = input.canAnswer
          ? input.canAnswer({ ask: a, object, by: input.by })
          : input.by.person !== undefined && input.by.person === object.owner && a.owner_epoch === object.owner_epoch
        if (!allowed) throw new Reject('answerer_not_allowed')
        if (!a.options.includes(input.option)) throw new Reject('invalid_option', { options: a.options })
        if (!input.targetAlive(a.target, a)) throw new Reject('target_gone')
        tx.emit({
          kind: KINDS.askAnswered,
          object_id: a.object_id,
          actor: input.by,
          payload: { ask_id: a.ask_id, ask_version: a.ask_version, option: input.option, by: input.by, request_id: input.request_id },
        })
        return { ask_id: a.ask_id, option: input.option, target: a.target, delivery_id: a.delivery_id, attempt_id: a.attempt_id }
      }),
    expire: () =>
      systemWrite((tx) => {
        const due = all("SELECT * FROM asks WHERE status = 'open' AND expires_at <= ? ORDER BY opened_seq", tx.now).map(toAsk)
        for (const a of due) {
          tx.emit({ kind: KINDS.askClosed, object_id: a.object_id, actor: { device: origin }, payload: { ask_id: a.ask_id, status: 'expired', reason: 'expired' } })
        }
        return due.map((a) => a.ask_id)
      }),
    cancel: (input) =>
      request(metaOf(input.request_id, 'asks.cancel', input.actor), (tx) => {
        const a = openAskOrReject(tx, input.ask_id)
        if (input.expected_owner_epoch !== undefined) tx.requireOwner(a.object_id, input.expected_owner_epoch)
        const reason = needStr(input.reason, 'reason')
        tx.emit({ kind: KINDS.askClosed, object_id: a.object_id, actor: input.actor, payload: { ask_id: a.ask_id, status: 'cancelled', reason } })
        return { ask_id: a.ask_id }
      }),
    get: (id) => reader.ask(id),
    list: (filter) => asksOf(filter),
  }

  const outbox: Ledger['outbox'] = {
    ack: (destination, seq) => {
      if (typeof destination !== 'string' || destination === '') throw new Error('outbox: destination 必填')
      if (!Number.isSafeInteger(seq) || seq < 0) throw new RangeError(`outbox: seq 必须是非负整数,收到 ${seq}`)
      writeTx(() => {
        const max = maxSeqRaw()
        if (seq > max) throw new RangeError(`outbox: ack ${seq} 超过已提交的最大 seq ${max}`)
        q(`INSERT INTO outbox (destination, last_acked_seq, updated_ts) VALUES (?, ?, ?)
           ON CONFLICT(destination) DO UPDATE SET last_acked_seq = MAX(last_acked_seq, excluded.last_acked_seq), updated_ts = excluded.updated_ts`).run(destination, seq, clock())
      })
      return outbox.cursor(destination)
    },
    cursor: (destination) => (one('SELECT last_acked_seq FROM outbox WHERE destination = ?', destination)?.last_acked_seq as number | undefined) ?? 0,
    pending: (destination, o = {}) => all('SELECT * FROM events WHERE seq > ? ORDER BY seq LIMIT ?', outbox.cursor(destination), o.limit ?? -1).map(toEvent),
    list: () =>
      all('SELECT * FROM outbox ORDER BY destination').map((r) => ({
        destination: r.destination as string,
        last_acked_seq: r.last_acked_seq as number,
        updated_ts: r.updated_ts as number,
      })),
  }

  return {
    path,
    origin,
    commit,
    request,
    snapshot,
    events,
    objectEvents: (object_id) => all('SELECT * FROM events WHERE object_id = ? ORDER BY seq', object_id).map(toEvent),
    maxSeq: maxSeqRaw,
    objects,
    transfer,
    deliveries,
    asks,
    outbox,
    exportJsonl: (object_id) => {
      const rows = object_id === undefined ? all('SELECT * FROM events ORDER BY seq') : all('SELECT * FROM events WHERE object_id = ? ORDER BY seq', object_id)
      return rows.map((r) => `${JSON.stringify(toEvent(r))}\n`).join('')
    },
    rebuildViews: () =>
      writeTx(() => {
        db.exec('DELETE FROM objects; DELETE FROM deliveries; DELETE FROM asks;')
        let after = 0
        for (;;) {
          const batch = all('SELECT * FROM events WHERE seq > ? ORDER BY seq LIMIT 500', after).map(toEvent)
          if (batch.length === 0) break
          for (const ev of batch) writeChanges(applyEvent(reader, ev))
          after = (batch.at(-1) as LedgerEvent).seq
        }
      }),
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    stats: () => {
      const n = (sql: string) => (one(sql)?.n as number) ?? 0
      return {
        events: n('SELECT COUNT(*) AS n FROM events'),
        requests: n('SELECT COUNT(*) AS n FROM request_log'),
        objects: n('SELECT COUNT(*) AS n FROM objects'),
        deliveries: n('SELECT COUNT(*) AS n FROM deliveries'),
        asks: n('SELECT COUNT(*) AS n FROM asks'),
        open_asks: n("SELECT COUNT(*) AS n FROM asks WHERE status = 'open'"),
      }
    },
    integrityCheck: () => (q('PRAGMA integrity_check').all() as Row[]).map((r) => String(Object.values(r)[0])).join('\n'),
    close: () => {
      listeners.clear()
      cache.clear()
      db.close()
    },
  }
}

// ---- 打开时的检查与初始化 ----

function checkReadable(db: DatabaseSync, path: string): void {
  let rows: Row[]
  try {
    rows = db.prepare('PRAGMA quick_check').all() as Row[]
  } catch (e) {
    throw new LedgerCorrupt(`ledger: ${path} 读不懂(不是账的库文件?)`, { cause: e })
  }
  const verdict = rows.map((r) => String(Object.values(r)[0])).join('; ')
  if (verdict !== 'ok') throw new LedgerCorrupt(`ledger: ${path} 校验不过:${verdict}`)
}

function initWritable(db: DatabaseSync, opts: LedgerOptions): string {
  const mode = db.prepare('PRAGMA journal_mode = WAL').get() as Row | undefined
  if (mode?.journal_mode !== 'wal') throw new Error(`ledger: 开不了 WAL(journal_mode=${String(mode?.journal_mode)})`)
  db.exec('PRAGMA synchronous = FULL')
  if (opts.fullfsync !== false) db.exec('PRAGMA fullfsync = ON; PRAGMA checkpoint_fullfsync = ON')
  db.exec('BEGIN IMMEDIATE')
  try {
    db.exec(DDL)
    const meta = readMeta(db)
    let origin: string
    if (meta.schema_version === undefined) {
      if (!opts.origin) throw new Error('ledger: 新库必须给 origin(来源座机服务前缀)')
      origin = opts.origin
      const put = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)')
      put.run('schema_version', String(SCHEMA_VERSION))
      put.run('origin', origin)
    } else {
      checkSchemaVersion(meta.schema_version)
      origin = checkOrigin(meta.origin, opts.origin)
    }
    db.exec('COMMIT')
    return origin
  } catch (e) {
    try { db.exec('ROLLBACK') } catch { /* 已回滚 */ }
    throw e
  }
}

function readMetaOrigin(db: DatabaseSync, wanted: string | undefined): string {
  const hasMeta = db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get()
  if (!hasMeta) throw new Error('ledger: 这个库没有 meta 表,不是账')
  const meta = readMeta(db)
  if (meta.schema_version === undefined) throw new Error('ledger: 这个库还没初始化')
  checkSchemaVersion(meta.schema_version)
  return checkOrigin(meta.origin, wanted)
}

function readMeta(db: DatabaseSync): Record<string, string> {
  const out: Record<string, string> = {}
  for (const r of db.prepare('SELECT key, value FROM meta').all() as Row[]) out[r.key as string] = r.value as string
  return out
}

function checkSchemaVersion(v: string): void {
  if (Number(v) > SCHEMA_VERSION) throw new Error(`ledger: 库的表结构版本 ${v} 比代码(${SCHEMA_VERSION})新,别用旧代码打开`)
}

function checkOrigin(stored: string | undefined, wanted: string | undefined): string {
  if (!stored) throw new Error('ledger: 库里没有 origin')
  if (wanted !== undefined && wanted !== stored) throw new Error(`ledger: 这个库的 origin 是 ${stored},不能用 ${wanted} 打开`)
  return stored
}

// ---- 行 → 类型 ----

function toEvent(r: Row): LedgerEvent {
  return {
    seq: r.seq as number,
    ts: r.ts as number,
    topic: r.topic as string,
    object_id: (r.object_id as string | null) ?? null,
    object_version: (r.object_version as number | null) ?? null,
    kind: r.kind as string,
    actor: JSON.parse(r.actor as string) as Actor,
    evidence: (r.evidence as string | null) ?? null,
    request_id: (r.request_id as string | null) ?? null,
    payload: JSON.parse(r.payload as string) as unknown,
    origin: { device: r.origin_device as string, seq: r.origin_seq as number },
  }
}

function toObject(r: Row): ObjectView {
  return {
    object_id: r.object_id as string,
    owner: r.owner as string,
    owner_epoch: r.owner_epoch as number,
    version: r.version as number,
    status: (r.status as string | null) ?? null,
    data: JSON.parse(r.data as string) as Record<string, unknown>,
    legacy_id: (r.legacy_id as string | null) ?? null,
    created_seq: r.created_seq as number,
    updated_seq: r.updated_seq as number,
  }
}

function toDelivery(r: Row): DeliveryView {
  return {
    delivery_id: r.delivery_id as string,
    object_id: r.object_id as string,
    n: r.n as number,
    family: r.family as string,
    channel: (r.channel as string | null) ?? null,
    target: r.target === null ? null : (JSON.parse(r.target as string) as Record<string, unknown>),
    attempt_id: r.attempt_id as number,
    status: r.status as string,
    data: JSON.parse(r.data as string) as Record<string, unknown>,
    updated_seq: r.updated_seq as number,
  }
}

function toAsk(r: Row): AskView {
  return {
    ask_id: r.ask_id as string,
    object_id: r.object_id as string,
    delivery_id: r.delivery_id as string,
    attempt_id: r.attempt_id as number,
    ask_version: r.ask_version as number,
    content_hash: r.content_hash as string,
    owner: r.owner as string,
    owner_epoch: r.owner_epoch as number,
    target: JSON.parse(r.target as string) as AskView['target'],
    kind: r.kind as string,
    options: JSON.parse(r.options as string) as string[],
    expires_at: r.expires_at as number,
    status: r.status as AskStatus,
    answer: r.answer === null ? null : (JSON.parse(r.answer as string) as AskView['answer']),
    closed_reason: (r.closed_reason as string | null) ?? null,
    opened_seq: r.opened_seq as number,
    updated_seq: r.updated_seq as number,
  }
}

// ---- 小工具 ----

function normalize(v: unknown): unknown {
  return v === undefined ? null : (JSON.parse(JSON.stringify(v)) as unknown)
}

function rejectInfo(e: Reject): RejectInfo {
  return e.detail === undefined ? { code: e.code } : { code: e.code, detail: normalize(e.detail) }
}

function metaOf(request_id: string, op: string, actor: Actor | undefined): RequestMeta {
  const m: RequestMeta = { request_id, op }
  if (actor?.device !== undefined) m.device_id = actor.device
  if (actor?.person !== undefined) m.person = actor.person
  return m
}

function needStr(v: unknown, field: string): string {
  if (typeof v !== 'string' || v === '') throw new Reject('invalid_input', { field })
  return v
}

function needOptions(v: unknown): string[] {
  if (!Array.isArray(v) || v.length === 0 || !v.every((x) => typeof x === 'string' && x !== '')) throw new Reject('invalid_input', { field: 'options' })
  return [...(v as string[])]
}

const CLOSED_CODE: Record<Exclude<AskStatus, 'open'>, string> = {
  answered: 'ask_answered',
  expired: 'ask_expired',
  cancelled: 'ask_cancelled',
  superseded: 'ask_superseded',
}

function openAskOrReject(tx: Tx, ask_id: string): AskView {
  const a = tx.ask(ask_id)
  if (!a) throw new Reject('ask_not_found', { ask_id })
  if (a.status !== 'open') throw new Reject(CLOSED_CODE[a.status], { status: a.status, closed_reason: a.closed_reason })
  return a
}
