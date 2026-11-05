/**
 * 账的契约类型。字段名与评审稿 v3 §5.2.1 的身份表一一对应。
 */

/** 谁做的:人、设备、哪一家(手)。 */
export interface Actor {
  person?: string
  device?: string
  family?: string
}

/** 一条已提交的事件。seq 是本机单调序号,object_version 是这条事件把对象推到的版本。 */
export interface LedgerEvent {
  seq: number
  /** 毫秒时刻。 */
  ts: number
  /** 'object'(落在某个工作对象上)、'job'(v1 捎话轻账那类对不上卡的)、'system'。 */
  topic: string
  object_id: string | null
  object_version: number | null
  kind: string
  actor: Actor
  /** 证据等级(谁说的、看没看见);导入的旧账记 'v1-import'。 */
  evidence: string | null
  /** 由哪条请求引起。 */
  request_id: string | null
  payload: unknown
  /** 跨机去重用:哪台座机服务、它那边的 seq。本机写的就是本机 + 本 seq。 */
  origin: { device: string; seq: number }
}

export interface EventInput {
  kind: string
  object_id?: string | null
  topic?: string
  actor: Actor
  evidence?: string | null
  payload?: unknown
  /** 只给导入旧账用:沿用原时刻。 */
  ts?: number
}

export interface ObjectView {
  object_id: string
  owner: string
  owner_epoch: number
  version: number
  status: string | null
  data: Record<string, unknown>
  /** v1 tasks.json 里的卡 id(导入与双写镜像对账用)。 */
  legacy_id: string | null
  created_seq: number
  updated_seq: number
}

export interface DeliveryView {
  /** object_id + '.d' + 序号。 */
  delivery_id: string
  object_id: string
  n: number
  family: string
  channel: string | null
  target: Record<string, unknown> | null
  /** 第几次执行:重发、换路、手重启各 +1。 */
  attempt_id: number
  status: string
  data: Record<string, unknown>
  updated_seq: number
}

export interface AskTarget {
  family?: string
  session_id?: string
  turn_id?: string
  tool_call_id?: string
  [k: string]: unknown
}

export type AskStatus = 'open' | 'answered' | 'expired' | 'cancelled' | 'superseded'

export interface AskAnswer {
  option: string
  by: Actor
  at: number
  request_id: string
}

export interface AskView {
  ask_id: string
  object_id: string
  delivery_id: string
  attempt_id: number
  ask_version: number
  content_hash: string
  /** 开问时对象的负责人与 epoch(「名下」)。 */
  owner: string
  owner_epoch: number
  target: AskTarget
  kind: string
  options: string[]
  expires_at: number
  status: AskStatus
  answer: AskAnswer | null
  closed_reason: string | null
  opened_seq: number
  updated_seq: number
}

export interface Views {
  objects: ObjectView[]
  deliveries: DeliveryView[]
  asks: AskView[]
}

export interface Snapshot extends Views {
  /** 取快照那一刻已提交的最大 seq;续流从 since = snapshot_seq 开始。 */
  snapshot_seq: number
}

export interface RejectInfo {
  code: string
  detail?: unknown
}

export type RequestOutcome<R> =
  | { request_id: string; ok: true; result: R; seq: number | null; replayed: boolean; events: readonly LedgerEvent[] }
  | { request_id: string; ok: false; error: RejectInfo; seq: null; replayed: boolean; events: readonly LedgerEvent[] }

export interface RequestMeta {
  request_id: string
  /** 操作名;同一 request_id 换了操作名会被拒(request_id_conflict)。 */
  op?: string
  device_id?: string
  person?: string
}

/** 请求处理函数拿到的事务句柄。处理函数必须是同步的。 */
export interface Tx {
  readonly now: number
  readonly request_id: string | null
  newObjectId(): string
  newAskId(): string
  object(id: string): ObjectView | undefined
  objectByLegacyId(legacy_id: string): ObjectView | undefined
  delivery(id: string): DeliveryView | undefined
  deliveriesOf(object_id: string): DeliveryView[]
  ask(id: string): AskView | undefined
  asksOf(filter: { object_id?: string; delivery_id?: string; status?: AskStatus }): AskView[]
  /** 写一条事件并更新视图;返回带 seq / object_version 的事件。 */
  emit(input: EventInput): LedgerEvent
  /**
   * 改状态类请求的门:对象在、expected_owner_epoch 等于当前 epoch(否则 stale_owner)、
   * 带了 expected_version 就要等于当前版本(否则 stale_version)。不过就抛 Reject。
   */
  requireOwner(object_id: string, expected_owner_epoch: unknown, expected_version?: unknown): ObjectView
}

export interface CommitRecord {
  request_id?: string
  op?: string
  events: readonly EventInput[]
  result?: unknown
}

export interface CommitOutcomeNoRequest {
  request_id: null
  ok: true
  result: unknown
  seq: number | null
  replayed: false
  events: readonly LedgerEvent[]
}

export type CommitOutcome = RequestOutcome<unknown> | CommitOutcomeNoRequest

export interface LedgerStats {
  events: number
  requests: number
  objects: number
  deliveries: number
  asks: number
  open_asks: number
}

export interface OutboxCursor {
  destination: string
  last_acked_seq: number
  updated_ts: number
}

// ---- 领域操作的入参 ----

export interface CreateObjectInput {
  request_id: string
  actor: Actor
  owner: string
  status?: string | null
  data?: Record<string, unknown>
  legacy_id?: string
}

export interface UpdateObjectInput {
  request_id: string
  actor: Actor
  object_id: string
  expected_owner_epoch: number
  expected_version?: number
  status?: string | null
  /** 浅合并;值为 null 的键删掉。 */
  data?: Record<string, unknown>
}

export interface AppendInput {
  request_id: string
  actor: Actor
  object_id: string
  /** 评论、材料、交接申请……不许用 object. / delivery. / ask. 开头的保留种类。 */
  kind: string
  payload?: unknown
  evidence?: string
}

export interface TransferInput {
  request_id: string
  actor: Actor
  object_id: string
  new_owner: string
  expected_owner_epoch: number
}

export interface TransferResult {
  owner_epoch: number
  version: number
  cancelled_asks: string[]
}

export interface CreateDeliveryInput {
  request_id: string
  actor: Actor
  object_id: string
  expected_owner_epoch: number
  family: string
  channel?: string
  target?: Record<string, unknown>
  status?: string
  data?: Record<string, unknown>
}

export type AttemptReason = 'resend' | 'reroute' | 'hand_restart'

export interface NewAttemptInput {
  request_id: string
  actor: Actor
  delivery_id: string
  expected_owner_epoch: number
  reason: AttemptReason
  target?: Record<string, unknown>
}

export interface UpdateDeliveryInput {
  request_id: string
  actor: Actor
  delivery_id: string
  expected_owner_epoch: number
  status?: string
  target?: Record<string, unknown> | null
  data?: Record<string, unknown>
}

export interface OpenAskInput {
  request_id: string
  actor: Actor
  delivery_id: string
  /** 手以为自己在第几次执行;给了且不等于委派当前的 attempt_id → stale_attempt。 */
  attempt_id?: number
  target: AskTarget
  kind: string
  options: readonly string[]
  content_hash: string
  expires_at: number
}

export interface ReviseAskInput {
  request_id: string
  actor: Actor
  ask_id: string
  content_hash: string
  options?: readonly string[]
  expires_at?: number
}

export interface AnswerInput {
  request_id: string
  ask_id: string
  ask_version: number
  content_hash: string
  option: string
  by: Actor
  /** 手那边的目标此刻还活着吗(会话 / 回合 / 工具调用)。由调用方判定。 */
  targetAlive: (target: AskTarget, ask: AskView) => boolean
  /** 答复者此刻有没有权。不给就按「答复者是对象当前负责人」判。 */
  canAnswer?: (ctx: { ask: AskView; object: ObjectView; by: Actor }) => boolean
}

export interface AnswerResult {
  ask_id: string
  option: string
  target: AskTarget
  delivery_id: string
  attempt_id: number
}

export interface CancelAskInput {
  request_id: string
  actor: Actor
  ask_id: string
  reason: string
  expected_owner_epoch?: number
}
