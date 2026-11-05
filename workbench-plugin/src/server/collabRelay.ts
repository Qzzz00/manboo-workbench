/**
 * 协作区的跨机那一半(2026-10-21):座机服务替界面去问中转。界面只认本机 `/collab/relay/*`,不直连中转。
 * 中转客户端在 `relayInbox.ts`,口径见 `docs/交接-1021-协作区中转底座.md`。
 *
 * - 工作室(建 / 邀请 / 加入 / 改成员)用账号会话令牌,其余用设备令牌;**令牌只进请求头**,不进回包、日志、文件、URL。
 * - 用别人的 Agent:请求方发 `agent.dispatch`,记「请求号 → 便签」;主人那台收到记成一条待批(落盘,重启还在),
 *   主人点批才建便签、派出去、回结果。中转只管排队,批不批永远是主人自己点。
 * - 请求队列里的 `task.create`(频道 / 企微一句话)建便签,**验收没写就空着**(便签角上显示缺),不替人编;
 *   `timer.fire`(定时派活的回调地址被打)跑那条定时;不认得的 op 回 rejected 说清。
 * - 两条长轮询只在加入了工作室时跑;410 = 本地游标不可信,重取频道快照后拨游标。出错退避 5s 起翻倍封顶 60s。
 * - `tickCount` 是「中转那边有变化」的计数,进 /state 的 `relay_tick`,界面拿它当该重读的信号。
 */
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type {
  AgentCard,
  AgentCardData,
  CollabChannelRef,
  CollabChannelSnapshot,
  CollabObjectView,
  CollabWecomBinding,
  InboxEvent,
  InboxRequest,
  InboxRequestResultPayload,
  TaskAssignee,
  TaskStatus,
  WorkspaceMe,
  WorkspaceRole,
} from '../protocol.ts'
import { UNSORTED_GOAL_ID, isTaskAssigneeValue, statusPathTo } from '../protocol.ts'
import type { RelayInboxCall, RelayInboxConn, RelaySyncOutcome } from './relayInbox.ts'
import {
  channelSnapshot,
  createWebhook,
  createWecomBindCode,
  createWorkspace,
  createWorkspaceInvite,
  defaultRelayInboxFile,
  fetchWorkspaceMe,
  joinWorkspace,
  listCollabObjects,
  listWebhooks,
  listWecomBindings,
  newRelayRequestId,
  postChannelMessage,
  postInboxResult,
  readRelayInboxState,
  removeWecomBinding,
  removeWorkspaceMember,
  resetRelayInboxCursor,
  rotateWebhook,
  sendInboxRequest,
  setWorkspaceMemberRole,
  syncInboxEvents,
  syncInboxRequests,
  upsertCollabObject,
  writeRelayInboxState,
} from './relayInbox.ts'
import { NO_RELAY_NOTE } from './modelConfig.ts'
import { cardDispatchFamily } from './dispatchRun.ts'
import type { TasksService } from './tasks.ts'

export interface RelayLink {
  relayUrl: string
  deviceToken?: string
  sessionToken?: string
}

/** 回界面的答案。`status` 是要回给界面的 HTTP 码(连不上中转 = 502)。 */
export type RelayAnswer<T> =
  | { ok: true, value: T }
  | { ok: false, status: number, error: string, code?: string, owner_account?: string, owner_epoch?: number }

export type RelayStudioView =
  | { state: 'unwired', why: string }
  | { state: 'offline', why: string }
  | { state: 'none' }
  | {
    state: 'joined'
    me: Extract<WorkspaceMe, { me: unknown }>['me']
    workspace: Extract<WorkspaceMe, { me: unknown }>['workspace']
    members: Extract<WorkspaceMe, { me: unknown }>['members']
    channels: Extract<WorkspaceMe, { me: unknown }>['channels']
  }

/** 别人想用我的 Agent,等我点批的一条。 */
export interface RelayAsk {
  request_id: string
  from_account: string
  from_nick?: string
  card_id: string
  card_name: string
  title: string
  acceptance: readonly string[]
  repos?: readonly string[]
  budget_per_day?: number
  at: string
}

interface BorrowFile {
  version: 1
  /** 我发出去的借用:请求号 → 便签。 */
  borrows: Record<string, { note_id: string, at: string }>
  asks: RelayAsk[]
  /** 主人点过、结果还没回成中转的(下一拍重回)。 */
  unsent: { request_id: string, state: 'done' | 'rejected', result: Record<string, unknown> }[]
}

export interface CollabRelayDeps {
  link: () => Promise<RelayLink | undefined>
  fetchImpl?: typeof fetch
  inboxFile?: string
  /** `~/.dsh/workbench/collab-borrows.json`。 */
  borrowFile?: string
  tasks: Pick<TasksService, 'list' | 'create' | 'comment' | 'move' | 'saveTimer'>
  /**
   * 主人批了之后派出去(接 http.ts 的 dispatchItem)。名片那一路 `family` 传**名片 id**
   * (2026-10-22 卡「名片编辑表单重排」:hand 语义变了,不再是登记表 id;用哪一家由派活那一层
   * 按名片解析,dispatchRun.startNow 一处说了算)。
   */
  dispatch: (noteId: string, family: string, text: string) => Promise<unknown>
  canDispatch?: (family: string) => boolean
  /** 定时派活「现在跑一次」。 */
  runTimer: (timerId: string) => Promise<{ ok: boolean, note_id?: string, why?: string }>
  onChanged?: () => void
  now?: () => Date
  /** 退避等待(用例里换掉)。 */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
  log?: (line: string) => void
  /** 名片头像跨机那一份:内置 id 或小图 data URL(原图不进中转、不进事件)。没设 = undefined。 */
  avatarOf?: (owner: string) => Promise<{ preset: string } | { thumb: string } | undefined>
}

export interface CollabRelay {
  studio: () => Promise<RelayStudioView>
  createStudio: (input: { name: string, nick: string }) => Promise<RelayAnswer<unknown>>
  invite: () => Promise<RelayAnswer<{ code: string, expires_at: string }>>
  join: (input: { code: string, nick: string }) => Promise<RelayAnswer<unknown>>
  setRole: (input: { account_id: string, role: WorkspaceRole }) => Promise<RelayAnswer<unknown>>
  removeMember: (input: { account_id: string }) => Promise<RelayAnswer<unknown>>
  channel: (id?: string) => Promise<RelayAnswer<CollabChannelSnapshot>>
  say: (input: { channel_id: string, text: string, refs?: readonly CollabChannelRef[] }) => Promise<RelayAnswer<unknown>>
  agents: () => Promise<RelayAnswer<{ cards: readonly CollabObjectView[] }>>
  shareAgent: (cardId: string) => Promise<RelayAnswer<{ object: CollabObjectView }>>
  borrow: (input: { object_id: string, owner_account: string, owner_epoch?: number, note_id: string }) => Promise<RelayAnswer<{ request_id: string }>>
  asks: () => Promise<readonly RelayAsk[]>
  askCount: () => Promise<number>
  answer: (requestId: string, approve: boolean) => Promise<RelayAnswer<{ note_id?: string }>>
  webhook: (timerId: string, rotate: boolean) => Promise<RelayAnswer<{ url: string }>>
  wecomCode: (channelId: string) => Promise<RelayAnswer<{ code: string, expires_at: string }>>
  wecomBindings: () => Promise<RelayAnswer<{ bindings: readonly CollabWecomBinding[], configured: boolean }>>
  wecomRemove: (chatid: string) => Promise<RelayAnswer<unknown>>
  /** 「中转那边有变化」的计数。 */
  tickCount: () => number
  /** 手动驱动一拍(用例用;两条队列各补一次,不挂等)。 */
  tick: () => Promise<{ requests?: RelaySyncOutcome, events?: RelaySyncOutcome }>
  start: () => void
  stop: () => void
}

const NOT_LINKED = '这台还没登录中转账号'
/** 这台没接中转(零服务器档)时工作室那一句:不是「没登录」,是这一份构建 / 这台电脑压根没有中转。 */
export const COLLAB_NO_RELAY = `${NO_RELAY_NOTE},工作室用不了 —— 工作室要一台中转把几台电脑连起来`
const NEED_SESSION = '先在设置里登录账号,再管工作室'
const BACKOFF_MIN = 5_000
const BACKOFF_MAX = 60_000
const IDLE_MS = 60_000

const strList = (value: unknown): string[] => (Array.isArray(value) ? value.filter((one): one is string => typeof one === 'string' && one.trim() !== '').map(one => one.trim()) : [])
const str = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined)

function failOf<T>(call: Extract<RelayInboxCall<T>, { ok: false }>): Extract<RelayAnswer<never>, { ok: false }> {
  const owner = call.detail?.owner_account
  const epoch = call.detail?.owner_epoch
  return {
    ok: false,
    status: call.status === 0 ? 502 : call.status,
    error: call.status === 0 ? `中转连不上:${call.error}` : call.error,
    ...(call.code === undefined ? {} : { code: call.code }),
    ...(typeof owner === 'string' ? { owner_account: owner } : {}),
    ...(typeof epoch === 'number' ? { owner_epoch: epoch } : {}),
  }
}

function answerOf<T, U = T>(call: RelayInboxCall<T>, pick?: (value: T) => U): RelayAnswer<U> {
  if (!call.ok) return failOf(call)
  return { ok: true, value: pick === undefined ? call.value as unknown as U : pick(call.value) }
}

/** 本机名片 → 目录里的 Agent 对象。「指定成员」= 全工作室可见 + 名单;「只自己」= 只主人看得见。 */
export function agentObjectOf(card: AgentCard) {
  const shared: NonNullable<AgentCardData['shared']> = {
    to: card.shared.to === 'none' ? 'none' : 'workspace',
    // 本机名单记的是 `member:<账号>`,中转认账号本身。
    ...(card.shared.to === 'members' ? { allowed_members: (card.shared.members ?? []).map(one => one.replace(/^member:/, '')) } : {}),
    ...(card.shared.repos === undefined ? {} : { repos: card.shared.repos }),
    ...(card.shared.budget_per_day === undefined ? {} : { budget_per_day: card.shared.budget_per_day }),
  }
  const data: AgentCardData = {
    hand: card.hand,
    ...(card.good_at === undefined ? {} : { good_at: card.good_at }),
    ...(card.skills === undefined ? {} : { skills: card.skills }),
    ...(card.budget === undefined ? {} : { budget: card.budget }),
    shared,
  }
  return {
    object_id: card.id,
    kind: 'agent' as const,
    title: card.name,
    visibility: card.shared.to === 'none' ? 'owner' as const : 'workspace' as const,
    data,
  }
}

export function createCollabRelay(deps: CollabRelayDeps): CollabRelay {
  const now = deps.now ?? (() => new Date())
  const inboxFile = deps.inboxFile ?? defaultRelayInboxFile()
  const borrowFile = deps.borrowFile ?? join(process.env.HOME ?? '', '.dsh', 'workbench', 'collab-borrows.json')
  const log = deps.log ?? (() => {})
  let ticks = 0
  let nicks = new Map<string, string>()
  let workspaceChannel: string | undefined
  let abort: AbortController | undefined

  function bump(): void {
    ticks += 1
    deps.onChanged?.()
  }

  // —— 借用 / 待批文件(只有便签号与请求号,不带令牌) ——
  let fileQueue: Promise<unknown> = Promise.resolve()
  /** 待批几条:/state 每拍都问,记在内存里,改文件时跟着改。 */
  let asksCached: number | undefined
  async function readBorrows(): Promise<BorrowFile> {
    try {
      const raw = JSON.parse(await readFile(borrowFile, 'utf8')) as Partial<BorrowFile>
      return {
        version: 1,
        borrows: raw.borrows !== null && typeof raw.borrows === 'object' ? raw.borrows : {},
        asks: Array.isArray(raw.asks) ? raw.asks : [],
        unsent: Array.isArray(raw.unsent) ? raw.unsent : [],
      }
    }
    catch { return { version: 1, borrows: {}, asks: [], unsent: [] } }
  }
  function editBorrows<T>(fn: (data: BorrowFile) => T): Promise<T> {
    const run = fileQueue.then(async () => {
      const data = await readBorrows()
      const out = fn(data)
      asksCached = data.asks.length
      await mkdir(dirname(borrowFile), { recursive: true })
      const tmp = `${borrowFile}.tmp`
      await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 })
      await chmod(tmp, 0o600)
      await rename(tmp, borrowFile)
      return out
    })
    fileQueue = run.catch(() => {})
    return run
  }

  /** 没接中转:link 在、地址是空的。这时设备 / 会话两条路都不走(循环也就一个包都不发)。 */
  async function noRelay(): Promise<boolean> {
    const link = await deps.link()
    return link !== undefined && link.relayUrl.trim() === ''
  }
  async function deviceConn(): Promise<RelayInboxConn | undefined> {
    const link = await deps.link()
    if (link?.deviceToken === undefined || link.relayUrl.trim() === '') return undefined
    return { relayUrl: link.relayUrl, token: link.deviceToken, ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }) }
  }
  async function sessionConn(): Promise<RelayInboxConn | undefined> {
    const link = await deps.link()
    if (link?.sessionToken === undefined || link.relayUrl.trim() === '') return undefined
    return { relayUrl: link.relayUrl, token: link.sessionToken, ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }) }
  }
  const noDevice = { ok: false as const, status: 409, error: `${NOT_LINKED}。` }
  const noSession = { ok: false as const, status: 409, error: `${NEED_SESSION}。` }

  const noRelayAnswer = { ok: false as const, status: 409, error: COLLAB_NO_RELAY }

  async function withDevice<T>(fn: (conn: RelayInboxConn) => Promise<RelayAnswer<T>>): Promise<RelayAnswer<T>> {
    const conn = await deviceConn()
    if (conn === undefined) return await noRelay() ? noRelayAnswer : noDevice
    return await fn(conn)
  }
  async function withSession<T>(fn: (conn: RelayInboxConn) => Promise<RelayAnswer<T>>): Promise<RelayAnswer<T>> {
    const conn = await sessionConn()
    if (conn === undefined) return await noRelay() ? noRelayAnswer : noSession
    return await fn(conn)
  }

  async function studio(): Promise<RelayStudioView> {
    if (await noRelay()) return { state: 'unwired', why: COLLAB_NO_RELAY }
    const conn = await deviceConn()
    if (conn === undefined) return { state: 'unwired', why: NOT_LINKED }
    const me = await fetchWorkspaceMe(conn)
    if (!me.ok) {
      if (me.status === 0) return { state: 'offline', why: me.error }
      if (me.status === 401) return { state: 'unwired', why: me.error }
      return { state: 'offline', why: me.error }
    }
    const value = me.value
    if (value.workspace === null) { workspaceChannel = undefined; return { state: 'none' } }
    nicks = new Map(value.members.map(one => [one.account_id, one.nick]))
    workspaceChannel = value.channels.find(one => one.kind === 'workspace')?.id
    return { state: 'joined', me: value.me, workspace: value.workspace, members: value.members, channels: value.channels }
  }

  async function comment(noteId: string, text: string): Promise<void> {
    try { await deps.tasks.comment(noteId, { by: 'butler', text }) }
    catch (error) { log(`协作区中转:便签留言没留上(${error instanceof Error ? error.message : String(error)})`) }
  }

  async function moveTo(noteId: string, to: TaskStatus): Promise<void> {
    const note = (await deps.tasks.list()).tasks.find(one => one.id === noteId)
    if (note === undefined) return
    for (const step of statusPathTo(note.status, to) ?? []) {
      const moved = await deps.tasks.move(noteId, step)
      if (!moved.ok) return
    }
  }

  /** 请求方:主人那边回了结果。 */
  async function onResult(payload: InboxRequestResultPayload): Promise<boolean> {
    const borrow = (await readBorrows()).borrows[payload.request_id]
    if (borrow === undefined) return false
    if (payload.state === 'done') {
      await comment(borrow.note_id, '主人批了,开工了。')
      await moveTo(borrow.note_id, 'doing')
    }
    else {
      const reason = str(payload.result?.reason)
      await comment(borrow.note_id, `主人没批${reason === undefined ? '' : `:${reason}`}。`)
      await moveTo(borrow.note_id, 'todo')
    }
    await editBorrows((data) => { delete data.borrows[payload.request_id] })
    return true
  }

  async function applyEvents(events: readonly InboxEvent[]): Promise<void> {
    let changed = false
    for (const event of events) {
      if (event.kind === 'request.result') changed = (await onResult(event.payload as unknown as InboxRequestResultPayload)) || changed
      else if (event.kind === 'channel.message' || event.kind === 'workspace.member' || event.kind === 'channel.created') changed = true
    }
    if (changed) bump()
  }

  /** 这条请求做出来的便签已经有了(重放)就回那张。 */
  async function noteOfRequest(requestId: string): Promise<string | undefined> {
    return (await deps.tasks.list()).tasks.find(one => one.from?.ref === `relay:${requestId}`)?.id
  }

  async function handleRequest(request: InboxRequest): Promise<{ state: 'done' | 'rejected', result?: Record<string, unknown> } | undefined> {
    if (request.op === 'agent.dispatch') {
      const cards = (await deps.tasks.list()).agent_cards ?? []
      const card = cards.find(one => one.id === request.object_id)
      if (card === undefined) return { state: 'rejected', result: { reason: '这张名片在主人电脑上已经没有了' } }
      const known = (await readBorrows()).asks.some(one => one.request_id === request.request_id)
      if (known) return undefined
      const nick = nicks.get(request.from_account)
      const ask: RelayAsk = {
        request_id: request.request_id,
        from_account: request.from_account,
        ...(nick === undefined ? {} : { from_nick: nick }),
        card_id: card.id,
        card_name: card.name,
        title: str(request.args.title) ?? str(request.args.desc)?.slice(0, 40) ?? '(没写标题)',
        acceptance: strList(request.args.acceptance).slice(0, 3),
        ...(card.shared.repos === undefined ? {} : { repos: card.shared.repos }),
        ...(card.shared.budget_per_day === undefined ? {} : { budget_per_day: card.shared.budget_per_day }),
        at: request.at,
      }
      await editBorrows((data) => { data.asks.push(ask) })
      bump()
      return undefined
    }
    if (request.op === 'task.create') {
      const existing = await noteOfRequest(request.request_id)
      if (existing !== undefined) return { state: 'done', result: { note_id: existing } }
      const desc = str(request.args.desc)
      const title = str(request.args.title) ?? desc?.slice(0, 40)
      if (title === undefined) return { state: 'rejected', result: { reason: '没有可记的内容' } }
      const assignee = isTaskAssigneeValue(request.args.assignee) ? request.args.assignee as TaskAssignee : undefined
      const acceptance = strList(request.args.acceptance).slice(0, 3)
      const created = await deps.tasks.create({
        title,
        ...(desc === undefined || desc === title ? {} : { desc }),
        goalId: str(request.args.goal_id) ?? UNSORTED_GOAL_ID,
        from: { kind: 'channel', ref: `relay:${request.request_id}`, ...(desc === undefined ? {} : { quote: desc }) },
        ...(acceptance.length === 0 ? {} : { acceptance }),
        ...(assignee === undefined ? {} : { assignee }),
      })
      if (!created.ok || created.id === undefined) return { state: 'rejected', result: { reason: created.reason ?? '便签没建成', title } }
      bump()
      return { state: 'done', result: { note_id: created.id, title } }
    }
    if (request.op === 'timer.fire') {
      const target = request.args.target as Record<string, unknown> | undefined
      const timerId = str(target?.timer_id) ?? str(request.args.timer_id)
      if (timerId === undefined) return { state: 'rejected', result: { reason: '回调地址没指明是哪条定时派活' } }
      const ran = await deps.runTimer(timerId)
      bump()
      return ran.ok
        ? { state: 'done', result: { ...(ran.note_id === undefined ? {} : { note_id: ran.note_id }) } }
        : { state: 'rejected', result: { reason: ran.why ?? '没跑成', ...(ran.note_id === undefined ? {} : { note_id: ran.note_id }) } }
    }
    return { state: 'rejected', result: { reason: `这台电脑还不认得「${request.op}」这种请求` } }
  }

  async function flushUnsent(conn: RelayInboxConn): Promise<void> {
    const { unsent } = await readBorrows()
    for (const one of unsent) {
      const posted = await postInboxResult(conn, one)
      if (!posted.ok && posted.status === 0) return
      await editBorrows((data) => { data.unsent = data.unsent.filter(item => item.request_id !== one.request_id) })
    }
  }

  /** 410:重取工作室频道快照,拿它的游标续。请求队列的 410 从头补(办过的有去重)。 */
  async function resyncEvents(conn: RelayInboxConn): Promise<void> {
    if (workspaceChannel === undefined) await studio()
    if (workspaceChannel === undefined) return
    const snap = await channelSnapshot(conn, workspaceChannel, { limit: 1 })
    if (snap.ok) await resetRelayInboxCursor(inboxFile, snap.value.cursor)
    bump()
  }
  async function resyncRequests(): Promise<void> {
    const state = await readRelayInboxState(inboxFile)
    await writeRelayInboxState(inboxFile, { ...state, last_request_cursor: 0 })
  }

  async function passRequests(conn: RelayInboxConn, wait: number, signal?: AbortSignal): Promise<RelaySyncOutcome> {
    await flushUnsent(conn)
    const out = await syncInboxRequests(conn, { file: inboxFile, handle: handleRequest, wait, ...(signal === undefined ? {} : { signal }) })
    if (!out.ok && out.resync) await resyncRequests()
    return out
  }
  async function passEvents(conn: RelayInboxConn, wait: number, signal?: AbortSignal): Promise<RelaySyncOutcome> {
    const out = await syncInboxEvents(conn, { file: inboxFile, apply: applyEvents, wait, ...(signal === undefined ? {} : { signal }) })
    if (!out.ok && out.resync) await resyncEvents(conn)
    return out
  }

  const defaultSleep = (ms: number, signal: AbortSignal): Promise<void> => new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
  })
  const sleep = deps.sleep ?? defaultSleep

  async function loop(signal: AbortSignal, pass: (conn: RelayInboxConn, wait: number, signal: AbortSignal) => Promise<RelaySyncOutcome>, name: string): Promise<void> {
    let backoff = BACKOFF_MIN
    while (!signal.aborted) {
      try {
        const conn = await deviceConn()
        const view = conn === undefined ? undefined : await studio()
        if (conn === undefined || view?.state !== 'joined') { await sleep(IDLE_MS, signal); continue }
        const out = await pass(conn, 25, signal)
        if (out.ok || out.resync) { backoff = BACKOFF_MIN; continue }
        if (signal.aborted) return
        log(`协作区中转:${name}没拉成(${out.status} ${out.error}),${backoff / 1000} 秒后再试`)
      }
      catch (error) {
        log(`协作区中转:${name}出错(${error instanceof Error ? error.message : String(error)})`)
      }
      await sleep(backoff, signal)
      backoff = Math.min(backoff * 2, BACKOFF_MAX)
    }
  }

  return {
    studio,
    createStudio: input => withSession(async conn => answerOf(await createWorkspace(conn, input))),
    invite: () => withSession(async conn => answerOf(await createWorkspaceInvite(conn), value => ({ code: value.code, expires_at: value.expires_at }))),
    join: input => withSession(async (conn) => {
      const out = answerOf(await joinWorkspace(conn, input))
      if (out.ok) bump()
      return out
    }),
    setRole: input => withSession(async conn => answerOf(await setWorkspaceMemberRole(conn, input))),
    removeMember: input => withSession(async (conn) => {
      const out = answerOf(await removeWorkspaceMember(conn, input))
      if (out.ok) bump()
      return out
    }),

    channel: id => withDevice(async (conn) => {
      let channelId = id
      if (channelId === undefined) {
        const view = await studio()
        if (view.state !== 'joined') return { ok: false, status: 409, error: view.state === 'none' ? '还没加入工作室。' : view.why }
        channelId = workspaceChannel
      }
      if (channelId === undefined) return { ok: false, status: 404, error: '工作室里没有频道。' }
      return answerOf(await channelSnapshot(conn, channelId))
    }),
    say: input => withDevice(async conn => answerOf(await postChannelMessage(conn, input.channel_id, {
      request_id: newRelayRequestId(now()),
      text: input.text,
      ...(input.refs === undefined ? {} : { refs: input.refs }),
    }))),

    agents: () => withDevice(async conn => answerOf(await listCollabObjects(conn, 'agent'), value => ({ cards: value.objects }))),
    shareAgent: cardId => withDevice(async (conn) => {
      const card = ((await deps.tasks.list()).agent_cards ?? []).find(one => one.id === cardId)
      if (card === undefined) return { ok: false, status: 404, error: '没有这张名片。' }
      let avatar: { preset: string } | { thumb: string } | undefined
      try { avatar = await deps.avatarOf?.(card.id) } catch { avatar = undefined }
      const object = agentObjectOf(card)
      return answerOf(await upsertCollabObject(conn, avatar === undefined ? object : { ...object, data: { ...object.data, avatar } }))
    }),

    borrow: input => withDevice(async (conn) => {
      const note = (await deps.tasks.list()).tasks.find(one => one.id === input.note_id)
      if (note === undefined) return { ok: false, status: 404, error: '没有这张便签。' }
      const requestId = newRelayRequestId(now())
      const sent = await sendInboxRequest(conn, {
        request_id: requestId,
        to_account: input.owner_account,
        op: 'agent.dispatch',
        object_id: input.object_id,
        ...(input.owner_epoch === undefined ? {} : { expected_owner_epoch: input.owner_epoch }),
        args: {
          title: note.title,
          acceptance: note.acceptance ?? [],
          ...(note.from === undefined ? {} : { from: { kind: note.from.kind, ...(note.from.quote === undefined ? {} : { quote: note.from.quote }) } }),
        },
      })
      if (!sent.ok) return failOf(sent)
      await editBorrows((data) => { data.borrows[requestId] = { note_id: note.id, at: now().toISOString() } })
      await comment(note.id, '请求已发到主人那里,等主人点批。')
      deps.onChanged?.()
      return { ok: true, value: { request_id: requestId } }
    }),

    asks: async () => (await readBorrows()).asks,
    askCount: async () => {
      if (asksCached === undefined) asksCached = (await readBorrows()).asks.length
      return asksCached
    },
    answer: async (requestId, approve) => {
      const ask = (await readBorrows()).asks.find(one => one.request_id === requestId)
      if (ask === undefined) return { ok: false, status: 404, error: '没有这条待批(可能已经处理过了)。' }
      let result: { state: 'done' | 'rejected', result: Record<string, unknown> }
      let noteId: string | undefined
      if (!approve) result = { state: 'rejected', result: { reason: '主人没批', title: ask.title } }
      else {
        const card = ((await deps.tasks.list()).agent_cards ?? []).find(one => one.id === ask.card_id)
        if (card === undefined) result = { state: 'rejected', result: { reason: '这张名片已经没有了', title: ask.title } }
        else {
          // 2026-10-22(卡「名片补四样与Kimi命令行手」B):负责人保留名片 id,不折成家名 ——
          // 用哪一家 / 在哪个仓库 / 带哪个模型由派活那一层按这张名片解析(一处的那个决定)。
          const assignee = card.id
          const created = await deps.tasks.create({
            title: ask.title,
            goalId: UNSORTED_GOAL_ID,
            from: { kind: 'channel', ref: `relay:${ask.request_id}`, quote: `${ask.from_nick ?? ask.from_account} 借用「${ask.card_name}」` },
            ...(ask.acceptance.length === 0 ? {} : { acceptance: ask.acceptance }),
            assignee,
          })
          if (!created.ok || created.id === undefined) return { ok: false, status: 500, error: created.reason ?? '便签没建成' }
          noteId = created.id
          let why: string | undefined
          if (ask.acceptance.length === 0) why = '没写验收,便签建了没派'
          else {
            // 这台能不能派,按名片解析出的那家核(hand 已是 cli/window,不再代表家);解析不出(老卡也没有
            // 命令行家)就交给派活那一层按名片如实挡。
            const family = cardDispatchFamily(card)
            if (family !== undefined && deps.canDispatch?.(family) === false) why = `「${family}」这台电脑上派不了,便签建了没派`
            else {
              try { await deps.dispatch(created.id, card.id, ask.title) }
              catch (error) { why = `派出去时出错:${error instanceof Error ? error.message : String(error)}` }
            }
          }
          if (why !== undefined) await comment(created.id, why)
          result = { state: 'done', result: { note_id: created.id, title: ask.title, ...(why === undefined ? {} : { note: why }) } }
        }
      }
      const conn = await deviceConn()
      const posted = conn === undefined ? undefined : await postInboxResult(conn, { request_id: requestId, ...result })
      await editBorrows((data) => {
        data.asks = data.asks.filter(one => one.request_id !== requestId)
        if (posted === undefined || (!posted.ok && posted.status === 0)) data.unsent.push({ request_id: requestId, ...result })
      })
      bump()
      return { ok: true, value: noteId === undefined ? {} : { note_id: noteId } }
    },

    // 整串地址本身就是钥匙:只在这一下回给页面,存进定时(会进 /state)的只留前几位。
    webhook: (timerId, rotate) => withDevice(async (conn) => {
      const timer = ((await deps.tasks.list()).timers ?? []).find(one => one.id === timerId)
      if (timer === undefined) return { ok: false, status: 404, error: '没有这条定时派活。' }
      let url: string
      if (rotate) {
        const list = await listWebhooks(conn)
        if (!list.ok) return failOf(list)
        const hook = list.value.webhooks.find(one => one.target.timer_id === timerId && one.revoked_at === undefined)
        if (hook === undefined) return { ok: false, status: 404, error: '这条还没开过回调地址。' }
        const rotated = await rotateWebhook(conn, hook.id)
        if (!rotated.ok) return failOf(rotated)
        url = rotated.value.url
      }
      else {
        const made = await createWebhook(conn, { label: timer.name, target: { timer_id: timerId } })
        if (!made.ok) return failOf(made)
        url = made.value.url
      }
      const saved = await deps.tasks.saveTimer({ id: timerId, trigger: { kind: 'webhook', url: maskHookUrl(url) } })
      if (!saved.ok) return { ok: false, status: 500, error: saved.reason ?? '地址没存上' }
      deps.onChanged?.()
      return { ok: true, value: { url } }
    }),

    wecomCode: channelId => withDevice(async conn => answerOf(await createWecomBindCode(conn, { channel_id: channelId }), value => ({ code: value.code, expires_at: value.expires_at }))),
    wecomBindings: () => withDevice(async conn => answerOf(await listWecomBindings(conn))),
    wecomRemove: chatid => withDevice(async conn => answerOf(await removeWecomBinding(conn, { chatid }))),

    tickCount: () => ticks,
    async tick() {
      const conn = await deviceConn()
      if (conn === undefined) return {}
      await studio()
      return { requests: await passRequests(conn, 0), events: await passEvents(conn, 0) }
    },
    start() {
      if (abort !== undefined) return
      abort = new AbortController()
      const signal = abort.signal
      void loop(signal, passRequests, '请求队列')
      void loop(signal, passEvents, '事件')
    },
    stop() {
      abort?.abort()
      abort = undefined
    },
  }
}

/** 回调地址遮住尾巴:路径最后一段只留前 4 位。 */
export function maskHookUrl(url: string): string {
  const cut = url.lastIndexOf('/')
  return `${url.slice(0, cut + 1)}${url.slice(cut + 1, cut + 5)}…`
}
