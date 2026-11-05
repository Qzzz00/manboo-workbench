/**
 * 视图怎么从事件长出来 —— 一处定义。
 *
 * 账里的 objects / deliveries / asks 三张表只是事件折出来的物化视图:写入时在同一个事务里
 * 用这里的 applyEvent 算出新行;rebuildViews 与 foldEvents 也用同一个函数从事件重算。
 * 所以「视图与事件对得上」可以随时验:把 ≤ snapshot_seq 的事件折一遍,应当等于快照。
 */
import type { Actor, AskStatus, AskView, DeliveryView, LedgerEvent, ObjectView, Views } from './types.ts'

/** 这些前缀的事件会改视图,只能由账自己的操作写;附加类请求不许冒用。 */
const RESERVED_PREFIXES = ['object.', 'delivery.', 'ask.'] as const

export const KINDS = {
  objectCreated: 'object.created',
  objectUpdated: 'object.updated',
  ownerChanged: 'object.owner_changed',
  deliveryCreated: 'delivery.created',
  deliveryUpdated: 'delivery.updated',
  deliveryAttempt: 'delivery.attempt',
  askOpened: 'ask.opened',
  askRevised: 'ask.revised',
  askAnswered: 'ask.answered',
  askClosed: 'ask.closed',
} as const

const KNOWN = new Set<string>(Object.values(KINDS))

export function isReservedKind(kind: string): boolean {
  return RESERVED_PREFIXES.some((p) => kind.startsWith(p))
}

export interface ViewReader {
  object(id: string): ObjectView | undefined
  delivery(id: string): DeliveryView | undefined
  ask(id: string): AskView | undefined
}

export interface ViewChanges {
  object?: ObjectView
  delivery?: DeliveryView
  ask?: AskView
}

/** 写之前算这条事件会把对象推到第几版。不落在对象上的事件没有版本。 */
export function nextObjectVersion(prev: ObjectView | undefined, kind: string, object_id: string | null): number | null {
  if (object_id === null) {
    if (isReservedKind(kind)) throw new Error(`ledger: ${kind} 必须落在对象上`)
    return null
  }
  if (kind === KINDS.objectCreated) {
    if (prev) throw new Error(`ledger: 对象 ${object_id} 已存在`)
    return 1
  }
  if (!prev) throw new Error(`ledger: 没有对象 ${object_id}`)
  return prev.version + 1
}

/** 一条事件 → 它改动的视图行(纯函数,不碰库)。 */
export function applyEvent(r: ViewReader, ev: LedgerEvent): ViewChanges {
  if (ev.object_id === null) {
    if (isReservedKind(ev.kind)) throw new Error(`ledger: ${ev.kind} 必须落在对象上`)
    return {}
  }
  if (isReservedKind(ev.kind) && !KNOWN.has(ev.kind)) throw new Error(`ledger: 不认识的保留事件种类 ${ev.kind}`)
  const version = ev.object_version
  if (version === null) throw new Error(`ledger: 对象事件缺 object_version(seq ${ev.seq})`)
  const p = rec(ev.payload)

  if (ev.kind === KINDS.objectCreated) {
    if (r.object(ev.object_id)) throw new Error(`ledger: 对象 ${ev.object_id} 已存在`)
    return {
      object: {
        object_id: ev.object_id,
        owner: str(p.owner, 'owner'),
        owner_epoch: 1,
        version,
        status: optStr(p.status),
        data: { ...rec(p.data) },
        legacy_id: optStr(p.legacy_id),
        created_seq: ev.seq,
        updated_seq: ev.seq,
      },
    }
  }

  const prev = r.object(ev.object_id)
  if (!prev) throw new Error(`ledger: 没有对象 ${ev.object_id}`)
  const obj: ObjectView = { ...prev, data: { ...prev.data }, version, updated_seq: ev.seq }
  const out: ViewChanges = { object: obj }

  switch (ev.kind) {
    case KINDS.objectUpdated:
      if ('status' in p) obj.status = optStr(p.status)
      if (p.data !== undefined) obj.data = mergePatch(obj.data, rec(p.data))
      break
    case KINDS.ownerChanged:
      obj.owner = str(p.to, 'to')
      obj.owner_epoch = prev.owner_epoch + 1
      break
    case KINDS.deliveryCreated: {
      const id = str(p.delivery_id, 'delivery_id')
      if (r.delivery(id)) throw new Error(`ledger: 委派 ${id} 已存在`)
      out.delivery = {
        delivery_id: id,
        object_id: ev.object_id,
        n: int(p.n, 'n'),
        family: str(p.family, 'family'),
        channel: optStr(p.channel),
        target: p.target == null ? null : { ...rec(p.target) },
        attempt_id: 1,
        status: optStr(p.status) ?? 'pending',
        data: { ...rec(p.data) },
        updated_seq: ev.seq,
      }
      break
    }
    case KINDS.deliveryUpdated: {
      const d = deliveryOf(r, p, ev.object_id)
      if ('status' in p) d.status = str(p.status, 'status')
      if ('target' in p) d.target = p.target == null ? null : { ...rec(p.target) }
      if (p.data !== undefined) d.data = mergePatch(d.data, rec(p.data))
      d.updated_seq = ev.seq
      out.delivery = d
      break
    }
    case KINDS.deliveryAttempt: {
      const d = deliveryOf(r, p, ev.object_id)
      const attempt = int(p.attempt_id, 'attempt_id')
      if (attempt !== d.attempt_id + 1) throw new Error(`ledger: 委派 ${d.delivery_id} 的 attempt 应为 ${d.attempt_id + 1},收到 ${attempt}`)
      d.attempt_id = attempt
      if ('target' in p) d.target = p.target == null ? null : { ...rec(p.target) }
      d.updated_seq = ev.seq
      out.delivery = d
      break
    }
    case KINDS.askOpened: {
      const id = str(p.ask_id, 'ask_id')
      if (r.ask(id)) throw new Error(`ledger: ask ${id} 已存在`)
      out.ask = {
        ask_id: id,
        object_id: ev.object_id,
        delivery_id: str(p.delivery_id, 'delivery_id'),
        attempt_id: int(p.attempt_id, 'attempt_id'),
        ask_version: int(p.ask_version, 'ask_version'),
        content_hash: str(p.content_hash, 'content_hash'),
        owner: str(p.owner, 'owner'),
        owner_epoch: int(p.owner_epoch, 'owner_epoch'),
        target: { ...rec(p.target) },
        kind: str(p.kind, 'kind'),
        options: strArray(p.options, 'options'),
        expires_at: int(p.expires_at, 'expires_at'),
        status: 'open',
        answer: null,
        closed_reason: null,
        opened_seq: ev.seq,
        updated_seq: ev.seq,
      }
      break
    }
    case KINDS.askRevised: {
      const a = askOf(r, p, ev.object_id)
      a.ask_version = int(p.ask_version, 'ask_version')
      a.content_hash = str(p.content_hash, 'content_hash')
      if (p.options !== undefined) a.options = strArray(p.options, 'options')
      if (p.expires_at !== undefined) a.expires_at = int(p.expires_at, 'expires_at')
      a.updated_seq = ev.seq
      out.ask = a
      break
    }
    case KINDS.askAnswered: {
      const a = askOf(r, p, ev.object_id)
      a.status = 'answered'
      a.answer = { option: str(p.option, 'option'), by: { ...rec(p.by) } as Actor, at: ev.ts, request_id: str(p.request_id, 'request_id') }
      a.updated_seq = ev.seq
      out.ask = a
      break
    }
    case KINDS.askClosed: {
      const a = askOf(r, p, ev.object_id)
      a.status = closedStatus(p.status)
      a.closed_reason = optStr(p.reason)
      a.updated_seq = ev.seq
      out.ask = a
      break
    }
    default:
      // 附加类(评论、材料、job.*……):只推对象版本
      break
  }
  return out
}

/** 把事件依次折到视图上(可从一份快照起折)。结果按 id 排序,与 snapshot() 同序。 */
export function foldEvents(events: readonly LedgerEvent[], initial?: Partial<Views>): Views {
  const objects = new Map<string, ObjectView>()
  const deliveries = new Map<string, DeliveryView>()
  const asks = new Map<string, AskView>()
  for (const o of initial?.objects ?? []) objects.set(o.object_id, structuredClone(o))
  for (const d of initial?.deliveries ?? []) deliveries.set(d.delivery_id, structuredClone(d))
  for (const a of initial?.asks ?? []) asks.set(a.ask_id, structuredClone(a))
  const reader: ViewReader = { object: (id) => objects.get(id), delivery: (id) => deliveries.get(id), ask: (id) => asks.get(id) }
  for (const ev of events) {
    const ch = applyEvent(reader, ev)
    if (ch.object) objects.set(ch.object.object_id, ch.object)
    if (ch.delivery) deliveries.set(ch.delivery.delivery_id, ch.delivery)
    if (ch.ask) asks.set(ch.ask.ask_id, ch.ask)
  }
  return sortViews({ objects: [...objects.values()], deliveries: [...deliveries.values()], asks: [...asks.values()] })
}

export function byId(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

export function sortViews(v: Views): Views {
  return {
    objects: [...v.objects].sort((a, b) => byId(a.object_id, b.object_id)),
    deliveries: [...v.deliveries].sort((a, b) => byId(a.delivery_id, b.delivery_id)),
    asks: [...v.asks].sort((a, b) => byId(a.ask_id, b.ask_id)),
  }
}

// ---- 小工具 ----

type Rec = Record<string, unknown>

function rec(v: unknown): Rec {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : {}
}

function str(v: unknown, what: string): string {
  if (typeof v !== 'string' || v === '') throw new Error(`ledger: 事件缺 ${what}`)
  return v
}

function optStr(v: unknown): string | null {
  return typeof v === 'string' ? v : null
}

function int(v: unknown, what: string): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v)) throw new Error(`ledger: 事件的 ${what} 不是整数`)
  return v
}

function strArray(v: unknown, what: string): string[] {
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) throw new Error(`ledger: 事件的 ${what} 不是字符串数组`)
  return [...v]
}

function mergePatch(base: Rec, patch: Rec): Rec {
  const out: Rec = { ...base }
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k]
    else out[k] = v
  }
  return out
}

function deliveryOf(r: ViewReader, p: Rec, object_id: string): DeliveryView {
  const id = str(p.delivery_id, 'delivery_id')
  const d = r.delivery(id)
  if (!d || d.object_id !== object_id) throw new Error(`ledger: 对象 ${object_id} 下没有委派 ${id}`)
  return { ...d, data: { ...d.data } }
}

function askOf(r: ViewReader, p: Rec, object_id: string): AskView {
  const id = str(p.ask_id, 'ask_id')
  const a = r.ask(id)
  if (!a || a.object_id !== object_id) throw new Error(`ledger: 对象 ${object_id} 下没有 ask ${id}`)
  return { ...a, options: [...a.options] }
}

function closedStatus(v: unknown): AskStatus {
  if (v === 'expired' || v === 'cancelled' || v === 'superseded') return v
  throw new Error(`ledger: ask.closed 的 status 只能是 expired / cancelled / superseded,收到 ${String(v)}`)
}
