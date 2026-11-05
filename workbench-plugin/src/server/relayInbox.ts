/**
 * 协作区跨机底座的客户端(2026-10-21,中转卡):工作室、收件箱、对象目录、频道、定时派活回调、企微群绑定。
 * 中转那一侧在 `relay/server/collabRoutes.cjs`;形状在 `protocol.ts` 的「协作区跨机底座」一段。
 *
 * **只导出函数与类型,不接线**:界面与座机服务的收发由协作区本机那张卡接。
 *
 * 几条口径:
 * - 看、发、拉用**设备令牌**(`model.json` 的 `relay_token`);建工作室、邀请、加入、改成员用**账号会话令牌**。
 *   两种令牌都只出现在请求头里,不进日志、不进回包、不进 URL。
 * - 「读到哪」落在 `~/.dsh/workbench/relay-inbox.json`(不动 `model.json`),只记游标,不进账、不做业务判断。
 * - 消费顺序「先写账、后推游标」:`syncEvents` 先把一页交给 `apply`,`apply` 落完盘才写游标;
 *   中途崩了重启会重放游标之后的那几条,靠事件里的 `origin` / 消息 `id` 去重。
 * - 410(`cursor_expired` 离开超过 30 天 / `cursor_ahead` 中转换过库)= 本地副本不可信:
 *   重取频道快照(`channelSnapshot`),再用快照带回的 `cursor` 调 `resetInboxCursor` 续。
 */

import { randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type {
  CollabChannelMessage,
  CollabChannelMessageSend,
  CollabChannelSnapshot,
  CollabChannelView,
  CollabObjectKind,
  CollabObjectUpsert,
  CollabObjectView,
  CollabWebhookView,
  CollabWecomBinding,
  InboxEvent,
  InboxEventsPage,
  InboxRequest,
  InboxRequestSend,
  InboxRequestSent,
  InboxRequestsPage,
  RelayInboxState,
  WorkspaceInvite,
  WorkspaceMe,
  WorkspaceRole,
  WorkspaceView,
} from '../protocol.ts'

/** 怎么连中转。`token` 是设备令牌或会话令牌(看接口要哪一种)。 */
export interface RelayInboxConn {
  relayUrl: string
  token: string
  fetchImpl?: typeof fetch
}

/**
 * 每次调用的回答。`status: 0` = 根本没连上(网络不通 / 回的不是 JSON);
 * 其余是中转认真回的错,`code` 是中转的错误码(`wrong_owner`、`cursor_expired`……),`error` 是它那句人话,
 * `detail` 是错误里多带的格子(比如 409 wrong_owner 带回的 `owner_account` / `owner_epoch`)。
 */
export type RelayInboxCall<T> =
  | { ok: true, value: T }
  | { ok: false, status: number, code?: string, error: string, detail?: Record<string, unknown> }

/** 长轮询最多挂多久(秒),与中转同一个数。 */
export const RELAY_INBOX_WAIT_MAX_S = 25

/** `~/.dsh/workbench/relay-inbox.json`。 */
export function defaultRelayInboxFile(home = process.env.HOME ?? ''): string {
  return join(home, '.dsh', 'workbench', 'relay-inbox.json')
}

/** 客户端生成的请求号 / 消息号:时间在前(大致有序)+ 随机。 */
export function newRelayRequestId(now: Date = new Date()): string {
  return `${now.getTime().toString(36).padStart(9, '0')}${randomBytes(8).toString('hex')}`
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, '')
}

async function call<T>(
  conn: RelayInboxConn,
  path: string,
  init: { method?: 'GET' | 'POST', body?: unknown, signal?: AbortSignal, headers?: Record<string, string> } = {},
): Promise<RelayInboxCall<T>> {
  const fetchImpl = conn.fetchImpl ?? fetch
  let res: Response
  try {
    res = await fetchImpl(`${trimSlash(conn.relayUrl)}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        authorization: `Bearer ${conn.token}`,
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...init.headers,
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      ...(init.signal === undefined ? {} : { signal: init.signal }),
    })
  }
  catch {
    // 底层那句话可能带出地址、代理细节,一律换成自己的措辞。
    return { ok: false, status: 0, error: '连不上中转(网络不通,或者被取消了)。' }
  }
  let body: unknown
  try { body = await res.json() }
  catch {
    return { ok: false, status: res.ok ? 0 : res.status, error: res.ok ? '中转回的内容看不懂。' : `中转拒绝了这次请求(HTTP ${res.status})。` }
  }
  if (!res.ok) {
    const raw = (body as { error?: Record<string, unknown> } | null)?.error ?? {}
    const { message, code, type: _type, ...detail } = raw
    return {
      ok: false,
      status: res.status,
      ...(typeof code === 'string' ? { code } : {}),
      error: typeof message === 'string' ? message : `中转拒绝了这次请求(HTTP ${res.status})。`,
      ...(Object.keys(detail).length === 0 ? {} : { detail }),
    }
  }
  return { ok: true, value: body as T }
}

const enc = encodeURIComponent

function waitOf(wait: number | undefined): number {
  if (wait === undefined || !Number.isFinite(wait) || wait <= 0) return 0
  return Math.min(Math.floor(wait), RELAY_INBOX_WAIT_MAX_S)
}

function pageQuery(since: number, wait?: number, limit?: number): string {
  const parts = [`since=${Math.max(0, Math.floor(since))}`]
  const w = waitOf(wait)
  if (w > 0) parts.push(`wait=${w}`)
  if (limit !== undefined) parts.push(`limit=${Math.floor(limit)}`)
  return parts.join('&')
}

// ───────────────────────── 游标文件 ─────────────────────────

const EMPTY_STATE: RelayInboxState = { version: 1, last_cursor: 0, last_request_cursor: 0 }

function cursorValue(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0
}

/** 读游标。文件不在 / 写坏了 → 从 0 起(从头补齐比漏掉安全:事件靠 id 去重)。 */
export async function readRelayInboxState(file: string): Promise<RelayInboxState> {
  try {
    const raw = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>
    return {
      version: 1,
      last_cursor: cursorValue(raw.last_cursor),
      last_request_cursor: cursorValue(raw.last_request_cursor),
      ...(typeof raw.updated_at === 'string' ? { updated_at: raw.updated_at } : {}),
    }
  }
  catch {
    return { ...EMPTY_STATE }
  }
}

/** 写游标:先写临时文件再改名,写到一半断电不会留下半个 JSON。 */
export async function writeRelayInboxState(file: string, state: RelayInboxState, now: Date = new Date()): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  const next: RelayInboxState = { version: 1, last_cursor: cursorValue(state.last_cursor), last_request_cursor: cursorValue(state.last_request_cursor), updated_at: now.toISOString() }
  await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
  await chmod(tmp, 0o600)
  await rename(tmp, file)
}

/** 410 之后重取了快照:把事件游标拨到快照带回的那个数。 */
export async function resetRelayInboxCursor(file: string, cursor: number): Promise<void> {
  const state = await readRelayInboxState(file)
  await writeRelayInboxState(file, { ...state, last_cursor: cursorValue(cursor) })
}

// ───────────────────────── 账号组(会话令牌) ─────────────────────────

export function createWorkspace(conn: RelayInboxConn, input: { name: string, nick: string }) {
  return call<{ workspace: WorkspaceView, member: { account_id: string, nick: string, role: WorkspaceRole }, channel: CollabChannelView }>(
    conn, '/v1/workspace', { method: 'POST', body: input },
  )
}

export function createWorkspaceInvite(conn: RelayInboxConn) {
  return call<WorkspaceInvite>(conn, '/v1/workspace/invite', { method: 'POST', body: {} })
}

export function joinWorkspace(conn: RelayInboxConn, input: { code: string, nick: string }) {
  return call<{ workspace: WorkspaceView, member: { account_id: string, nick: string, role: WorkspaceRole } }>(
    conn, '/v1/workspace/join', { method: 'POST', body: input },
  )
}

export function setWorkspaceMemberRole(conn: RelayInboxConn, input: { account_id: string, role: WorkspaceRole }) {
  return call<{ member: { account_id: string, nick: string, role: WorkspaceRole } }>(conn, '/v1/workspace/members/role', { method: 'POST', body: input })
}

/** 移除成员;`account_id` 是自己 = 退出工作室。 */
export function removeWorkspaceMember(conn: RelayInboxConn, input: { account_id: string }) {
  return call<{ removed: true, account_id: string }>(conn, '/v1/workspace/members/remove', { method: 'POST', body: input })
}

/** 我在哪个工作室、成员、每台设备最后在线、频道清单。设备令牌或会话令牌都行。 */
export function fetchWorkspaceMe(conn: RelayInboxConn) {
  return call<WorkspaceMe>(conn, '/v1/workspace/me')
}

// ───────────────────────── 收件箱(设备令牌) ─────────────────────────

/** 拉事件。`wait` 秒内没有新的就挂着(长轮询,最多 25)。410 → `code: 'cursor_expired' | 'cursor_ahead'`。 */
export function pullInboxEvents(conn: RelayInboxConn, input: { since: number, wait?: number, limit?: number, signal?: AbortSignal }) {
  return call<InboxEventsPage>(conn, `/v1/inbox/events?${pageQuery(input.since, input.wait, input.limit)}`, input.signal === undefined ? {} : { signal: input.signal })
}

/** 拉请求(只有本账号的电脑能拉;拉到的 `queued` 会被标成 `delivered`)。 */
export function pullInboxRequests(conn: RelayInboxConn, input: { since: number, wait?: number, limit?: number, signal?: AbortSignal }) {
  return call<InboxRequestsPage>(conn, `/v1/inbox/requests?${pageQuery(input.since, input.wait, input.limit)}`, input.signal === undefined ? {} : { signal: input.signal })
}

/** 发请求。409 `wrong_owner` 时 `detail.owner_account` 是目录里的现任,按它重发。 */
export function sendInboxRequest(conn: RelayInboxConn, input: InboxRequestSend) {
  return call<InboxRequestSent>(conn, '/v1/inbox/requests', { method: 'POST', body: input })
}

/** 记这台设备读到哪(中转那份书签;只进不退)。拉的时候不带 since 就从书签续。 */
export function ackInbox(conn: RelayInboxConn, input: { queue: 'events' | 'requests', last_acked: number }) {
  return call<{ queue: 'events' | 'requests', last_acked: number }>(conn, '/v1/inbox/ack', { method: 'POST', body: input })
}

/** 权威写入方回结果;发起者的事件队列里会多一条 `request.result`。 */
export function postInboxResult(conn: RelayInboxConn, input: { request_id: string, state: 'done' | 'rejected', result?: Record<string, unknown> }) {
  return call<InboxRequestSent>(conn, '/v1/inbox/requests/result', { method: 'POST', body: input })
}

// ───────────────────────── 对象目录 ─────────────────────────

export function listCollabObjects(conn: RelayInboxConn, kind?: Exclude<CollabObjectKind, 'channel'>) {
  return call<{ objects: readonly CollabObjectView[] }>(conn, `/v1/objects${kind === undefined ? '' : `?kind=${enc(kind)}`}`)
}

/** 查一个对象(看不见一律 404)。 */
export function getCollabObject(conn: RelayInboxConn, objectId: string) {
  return call<{ object: CollabObjectView }>(conn, `/v1/objects?id=${enc(objectId)}`)
}

/**
 * 交接(现任那台电脑发):`owner_epoch` +1。换了账号时,旧主人名下没办的请求退回发起者
 * (`request.result`,`result.code === 'owner_changed'`),由发起者按目录重投。
 */
export function transferCollabObject(conn: RelayInboxConn, input: { object_id: string, to_account: string, to_device: string, expected_owner_epoch: number }) {
  return call<{ object: CollabObjectView }>(conn, '/v1/objects/transfer', { method: 'POST', body: input })
}

export function upsertCollabObject(conn: RelayInboxConn, input: CollabObjectUpsert) {
  return call<{ object: CollabObjectView }>(conn, '/v1/objects', { method: 'POST', body: input })
}

/** 推一条对象事件(只有主人能推);同一个 `origin_seq` 重推不占新号(`duplicate: true`)。 */
export function pushObjectEvent(
  conn: RelayInboxConn,
  objectId: string,
  input: { origin_seq: number, object_version?: number, payload?: Record<string, unknown> },
) {
  return call<{ duplicate: boolean, cursor: number }>(conn, `/v1/objects/${enc(objectId)}/events`, { method: 'POST', body: input })
}

// ───────────────────────── 频道 ─────────────────────────

export function listChannels(conn: RelayInboxConn) {
  return call<{ channels: readonly CollabChannelView[] }>(conn, '/v1/channels')
}

/** 项目主人建项目频道(项目要先以 `visibility: 'workspace'` 登记);再来一次回已有那条。 */
export function createProjectChannel(conn: RelayInboxConn, input: { project_object_id: string }) {
  return call<{ channel: CollabChannelView }>(conn, '/v1/channels', { method: 'POST', body: input })
}

export function archiveChannel(conn: RelayInboxConn, channelId: string) {
  return call<{ channel: CollabChannelView }>(conn, `/v1/channels/${enc(channelId)}/archive`, { method: 'POST', body: {} })
}

/** 发消息;同频道同 `request_id` 重发回存着的那条(`duplicate: true`)。 */
export function postChannelMessage(conn: RelayInboxConn, channelId: string, input: CollabChannelMessageSend) {
  return call<{ message: CollabChannelMessage, duplicate: boolean }>(conn, `/v1/channels/${enc(channelId)}/messages`, { method: 'POST', body: input })
}

/** 撤回自己发的一条(中转不删原行,快照里折成「已撤回」)。 */
export function retractChannelMessage(conn: RelayInboxConn, channelId: string, messageId: string, input: { request_id: string }) {
  return call<{ message: CollabChannelMessage, duplicate: boolean }>(
    conn, `/v1/channels/${enc(channelId)}/messages/${enc(messageId)}/retract`, { method: 'POST', body: input },
  )
}

/** 频道快照:`before`(不含)之前最多 `limit` 条,按 seq 升序。 */
export function channelSnapshot(conn: RelayInboxConn, channelId: string, input: { before?: number, limit?: number } = {}) {
  const parts: string[] = []
  if (input.before !== undefined) parts.push(`before=${Math.floor(input.before)}`)
  if (input.limit !== undefined) parts.push(`limit=${Math.floor(input.limit)}`)
  return call<CollabChannelSnapshot>(conn, `/v1/channels/${enc(channelId)}/messages${parts.length === 0 ? '' : `?${parts.join('&')}`}`)
}

// ───────────────────────── 定时派活的回调地址(电脑) ─────────────────────────

/** 开一个回调地址。**`url` 整串只在这一次回包里**,存进本机凭据,丢了就轮换。 */
export function createWebhook(conn: RelayInboxConn, input: { label: string, target: Record<string, unknown> }) {
  return call<{ webhook: CollabWebhookView, url: string }>(conn, '/v1/webhooks', { method: 'POST', body: input })
}

export function listWebhooks(conn: RelayInboxConn) {
  return call<{ webhooks: readonly CollabWebhookView[] }>(conn, '/v1/webhooks')
}

export function rotateWebhook(conn: RelayInboxConn, id: string) {
  return call<{ webhook: CollabWebhookView, url: string }>(conn, `/v1/webhooks/${enc(id)}/rotate`, { method: 'POST', body: {} })
}

export function revokeWebhook(conn: RelayInboxConn, id: string) {
  return call<{ revoked: true }>(conn, `/v1/webhooks/${enc(id)}/revoke`, { method: 'POST', body: {} })
}

// ───────────────────────── 企业微信群绑定 ─────────────────────────

/** 生成绑定码(30 分钟);在企微群里 @机器人 发 `say` 那一句即绑上。 */
export function createWecomBindCode(conn: RelayInboxConn, input: { channel_id: string }) {
  return call<{ code: string, expires_at: string, say: string }>(conn, '/v1/wecom/bindings', { method: 'POST', body: input })
}

export function listWecomBindings(conn: RelayInboxConn) {
  return call<{ bindings: readonly CollabWecomBinding[], configured: boolean }>(conn, '/v1/wecom/bindings')
}

export function removeWecomBinding(conn: RelayInboxConn, input: { chatid: string }) {
  return call<{ removed: true }>(conn, '/v1/wecom/bindings/remove', { method: 'POST', body: input })
}

// ───────────────────────── 补齐循环 ─────────────────────────

export type RelaySyncOutcome =
  | { ok: true, applied: number, cursor: number }
  /** 410:本地副本不可信,重取快照后 `resetRelayInboxCursor`。 */
  | { ok: false, resync: true, code: string, error: string, applied: number, cursor: number }
  | { ok: false, resync: false, status: number, code?: string, error: string, applied: number, cursor: number }

/**
 * 从游标文件记的位置起把事件补齐:一页交给 `apply`(落完本地账再返回),然后推游标、写文件;`more` 就接着拉。
 * `wait` 只用在第一页(没有新事件时挂着等);补齐过程中不等。
 */
export async function syncInboxEvents(
  conn: RelayInboxConn,
  input: { file: string, apply: (events: readonly InboxEvent[]) => Promise<void> | void, wait?: number, limit?: number, signal?: AbortSignal },
): Promise<RelaySyncOutcome> {
  const state = await readRelayInboxState(input.file)
  let cursor = state.last_cursor
  let applied = 0
  let wait = input.wait
  for (;;) {
    const page = await pullInboxEvents(conn, { since: cursor, ...(wait === undefined ? {} : { wait }), ...(input.limit === undefined ? {} : { limit: input.limit }), ...(input.signal === undefined ? {} : { signal: input.signal }) })
    wait = undefined
    if (!page.ok) {
      if (page.status === 410) return { ok: false, resync: true, code: page.code ?? 'cursor_expired', error: page.error, applied, cursor }
      return { ok: false, resync: false, status: page.status, ...(page.code === undefined ? {} : { code: page.code }), error: page.error, applied, cursor }
    }
    if (page.value.events.length > 0) {
      await input.apply(page.value.events)
      applied += page.value.events.length
      cursor = page.value.next_cursor
      const latest = await readRelayInboxState(input.file)
      await writeRelayInboxState(input.file, { ...latest, last_cursor: cursor })
    }
    if (!page.value.more) return { ok: true, applied, cursor }
  }
}

/**
 * 座机服务这一侧:把请求队列补齐。每条没办完的交给 `handle`;
 * `handle` 回 `{state, result}` 就当场回结果,回 `undefined` = 「我记下了,稍后自己用 postInboxResult 回」。
 * 游标在 `handle` 返回之后才推(先落账、后推游标)。
 */
export async function syncInboxRequests(
  conn: RelayInboxConn,
  input: {
    file: string
    handle: (request: InboxRequest) => Promise<{ state: 'done' | 'rejected', result?: Record<string, unknown> } | undefined> | { state: 'done' | 'rejected', result?: Record<string, unknown> } | undefined
    wait?: number
    limit?: number
    signal?: AbortSignal
  },
): Promise<RelaySyncOutcome> {
  const state = await readRelayInboxState(input.file)
  let cursor = state.last_request_cursor
  let applied = 0
  let wait = input.wait
  for (;;) {
    const page = await pullInboxRequests(conn, { since: cursor, ...(wait === undefined ? {} : { wait }), ...(input.limit === undefined ? {} : { limit: input.limit }), ...(input.signal === undefined ? {} : { signal: input.signal }) })
    wait = undefined
    if (!page.ok) {
      if (page.status === 410) return { ok: false, resync: true, code: page.code ?? 'cursor_ahead', error: page.error, applied, cursor }
      return { ok: false, resync: false, status: page.status, ...(page.code === undefined ? {} : { code: page.code }), error: page.error, applied, cursor }
    }
    for (const request of page.value.requests) {
      if (request.state !== 'done' && request.state !== 'rejected') {
        const answer = await input.handle(request)
        if (answer !== undefined) {
          const posted = await postInboxResult(conn, { request_id: request.request_id, state: answer.state, ...(answer.result === undefined ? {} : { result: answer.result }) })
          if (!posted.ok) return { ok: false, resync: false, status: posted.status, ...(posted.code === undefined ? {} : { code: posted.code }), error: posted.error, applied, cursor }
        }
        applied += 1
      }
      cursor = request.cursor
      const latest = await readRelayInboxState(input.file)
      await writeRelayInboxState(input.file, { ...latest, last_request_cursor: cursor })
    }
    if (!page.value.more) return { ok: true, applied, cursor: page.value.next_cursor > cursor ? page.value.next_cursor : cursor }
  }
}
