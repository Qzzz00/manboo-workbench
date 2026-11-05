/**
 * 三个入口各怎么打,以及「这一句跑完多了哪几张卡」怎么取。只认一台工作台服务的网址(隔离实例的 8893),
 * 不认识实例怎么起(那是 instance.ts)。
 *
 * - 电脑对话框:`POST /butler/item`,请求体照 `client/ButlerInbox.tsx` 的 `submit`(`itemBody` + `can_meeting_plan`),
 *   带页面的 `Origin`;回执按 receipts.ts 拼成她在框下看到的那一句。
 * - 手机文字:`POST /butler/item`,请求体照 `butler-app/src/chat/useSendItem.ts`(`can_file_ask`、`can_meeting_plan`、
 *   待发箱的 `client_key`),带设备令牌;气泡按手机自己的 `chatModel.ts` 算(卡回来之后显示什么)。
 * - 电话:假手机进房说话(fakePhone.ts),或工人的文字回合测试口(`/say`,把字塞在识别定稿那一格)。
 */
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import type { CardFact, TurnFact } from './judge.ts'
import { type ItemAnswer, deskReceiptOf, phonePendingOf } from './receipts.ts'

export interface TaskLike {
  id: string
  title: string
  status: string
  desc?: string
  assignee?: string
  conversation?: { session_id?: string }
  dispatch?: unknown
  client_dispatch?: unknown
  dispatch_block?: unknown
  links?: readonly unknown[]
  created_at?: string
  kind?: string
  planned_at?: string
}

export interface StateLike {
  now?: string
  tasks?: { tasks?: readonly TaskLike[] }
  sessions?: readonly { session_id: string, agent?: string, status?: string }[]
  approvals?: readonly { id: string, task_id?: string }[]
  questions?: readonly { id: string, task_id?: string }[]
  [key: string]: unknown
}

export async function readState(base: string, headers: Record<string, string> = {}): Promise<StateLike> {
  const res = await fetch(`${base}/state`, { headers })
  if (!res.ok) throw new Error(`/state 回了 ${res.status}`)
  return await res.json() as StateLike
}

export const tasksOf = (state: StateLike): readonly TaskLike[] => state.tasks?.tasks ?? []

export function cardFactOf(task: TaskLike): CardFact {
  const session = task.conversation !== undefined
  const dispatched = task.status === 'doing' || task.status === 'confirm' || task.status === 'done' || task.status === 'blocked'
    || session || task.dispatch !== undefined || task.client_dispatch !== undefined || task.dispatch_block !== undefined
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    ...(task.assignee === undefined ? {} : { assignee: String(task.assignee) }),
    ...(task.desc === undefined ? {} : { desc: task.desc }),
    session,
    dispatched,
    ...(task.kind === undefined ? {} : { kind: task.kind }),
    ...(task.planned_at === undefined ? {} : { plannedAt: task.planned_at }),
  }
}

/** 前后两份 `/state` 之间多出来的卡、多出来的「等她批 / 等她回答」。 */
export function diffState(before: StateLike, after: StateLike): { newTasks: TaskLike[], asksAdded: number } {
  const had = new Set(tasksOf(before).map(t => t.id))
  const newTasks = tasksOf(after).filter(t => !had.has(t.id))
  const asked = new Set([...(before.approvals ?? []), ...(before.questions ?? [])].map(a => a.id))
  const asksAdded = [...(after.approvals ?? []), ...(after.questions ?? [])].filter(a => !asked.has(a.id)).length
  return { newTasks, asksAdded }
}

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

/**
 * 等看板安静下来:卡数与各卡状态连着 `quietMs` 没变。电脑 / 手机那一句回包回来时,派活、审批可能还在后面落。
 */
export async function settle(base: string, headers: Record<string, string> = {}, quietMs = 3000, maxMs = 20_000): Promise<StateLike> {
  const end = Date.now() + maxMs
  let last = ''
  let since = Date.now()
  let state = await readState(base, headers)
  while (Date.now() < end) {
    const sig = JSON.stringify([tasksOf(state).map(t => [t.id, t.status, t.title]), (state.approvals ?? []).length, (state.questions ?? []).length])
    if (sig !== last) { last = sig; since = Date.now() }
    else if (Date.now() - since >= quietMs) return state
    await sleep(700)
    state = await readState(base, headers)
  }
  return state
}

/**
 * 等这一句开出来的事务官会话收住:这几句里有的会开一条 DSH 会话(「派出去办」),会话在后台接着干,
 * 过一阵自己再建几张卡(10-22 基线第一遍里,电脑那句「记三条」的会话事后拆成三张,落进了手机那一列的差集)。
 * 所以一句跑完先等:这一句之后新出现的会话、以及新卡上挂的会话,连着 `quietMs` 没有一条在跑,才取最后那份 `/state`。
 * 等到 `maxMs` 还在跑就照取,并回 `stillRunning` 让报告写明「之后再建的没算进来」。
 */
export async function settleSessions(base: string, before: StateLike, quietMs = 6000, maxMs = 120_000): Promise<{ state: StateLike, waitedMs: number, stillRunning: number }> {
  const t0 = Date.now()
  const had = new Set((before.sessions ?? []).map(one => one.session_id))
  let since = Date.now()
  let state = await readState(base)
  let running = 0
  while (true) {
    const mine = new Set([
      ...(state.sessions ?? []).filter(one => !had.has(one.session_id)).map(one => one.session_id),
      ...diffState(before, state).newTasks.map(t => t.conversation?.session_id).filter((id): id is string => id !== undefined),
    ])
    running = (state.sessions ?? []).filter(one => mine.has(one.session_id) && one.status === 'running').length
    if (running > 0) since = Date.now()
    if (running === 0 && Date.now() - since >= quietMs) break
    if (Date.now() - t0 >= maxMs) break
    await sleep(1500)
    state = await readState(base)
  }
  return { state: await settle(base, {}, 2000, 15_000), waitedMs: Date.now() - t0, stillRunning: running }
}

/** 电脑对话框:页面那一下。 */
export async function sayAtDesk(base: string, text: string): Promise<{ turn: TurnFact, answer: ItemAnswer }> {
  const t0 = Date.now()
  const res = await fetch(`${base}/butler/item`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ text, orientation: 'portrait', can_meeting_plan: true }),
  })
  let answer: ItemAnswer = {}
  try { answer = await res.json() as ItemAnswer } catch { /* 读不懂就按没建成 */ }
  return {
    answer,
    turn: { said: text, reply: deskReceiptOf(answer, res.ok), ...(answer.note === undefined ? {} : { raw: answer.note }), ms: Date.now() - t0 },
  }
}

/** 手机文字:带设备令牌,与待发箱同一个请求体。 */
export async function sayOnPhone(base: string, token: string, text: string): Promise<{ answer: ItemAnswer, ms: number, ok: boolean }> {
  const t0 = Date.now()
  const res = await fetch(`${base}/butler/item`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ text, can_file_ask: true, can_meeting_plan: true, client_key: randomUUID() }),
  })
  let answer: ItemAnswer = {}
  try { answer = await res.json() as ItemAnswer } catch { /* 同上 */ }
  return { answer, ms: Date.now() - t0, ok: res.ok }
}

interface PhoneChatModel {
  buildThread: (state: never) => { taskId?: string, localId?: string, butler: { text: string } }[]
  mergePending: (thread: never, pending: never) => { taskId?: string, localId?: string, butler: { text: string } }[]
}

let phoneModel: PhoneChatModel | undefined
let meetingWhere = ''

/**
 * 手机自己的 `chatModel.ts`(它的 import 不带后缀,Node 直接载不了,所以 run.ts 先挂一个补后缀的解析钩子)。
 * 载不了就退回只看刚送到那一下的气泡,并在备注里写明。
 */
export async function loadPhoneModel(repo: string): Promise<string | undefined> {
  try {
    phoneModel = await import(pathToFileURL(join(repo, 'butler-app/src/chat/chatModel.ts')).href) as PhoneChatModel
    const send = await import(pathToFileURL(join(repo, 'butler-app/src/chat/useSendItem.ts')).href).catch(() => undefined) as { MEETING_PLAN_WHERE?: string } | undefined
    meetingWhere = send?.MEETING_PLAN_WHERE ?? ''
    return undefined
  }
  catch (err) {
    return `手机的 chatModel.ts 载不进来(${(err as Error).message}),手机那一列的回话只到「刚送到」那一下`
  }
}

/** 手机上这一句底下最后显示什么:卡回来了按卡算(手机的 `replyOf`),没卡按刚送到那一下。 */
export function phoneBubble(answer: ItemAnswer, ok: boolean, state: StateLike): string {
  if (!ok) return answer.error ?? '电脑那边没收下这一句'
  const pending = phonePendingOf(answer, meetingWhere)
  if (pending.fileAsk === true) return '(摆了一张「找到了什么」的卡)'
  const localId = randomUUID()
  if (phoneModel !== undefined) {
    const thread = phoneModel.mergePending(phoneModel.buildThread(state as never) as never, [{ localId, text: '', at: state.now ?? '', ...pending }] as never)
    const mine = pending.taskId === undefined ? thread.find(m => m.localId === localId) : thread.find(m => m.taskId === pending.taskId)
    if (mine !== undefined) return mine.butler.text
  }
  return pending.note ?? (pending.taskId === undefined ? '发送中…' : '已交给事务官')
}

/** 工人的文字回合测试口(`channel-worker/src/textTurn.ts`)。 */
export async function sayToTextTurn(port: number, token: string, text: string): Promise<{ said: string[], tools: { name: string, result?: string }[], ms: number, error?: string, timedOut?: boolean }> {
  const res = await fetch(`http://127.0.0.1:${port}/say`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-workbench-text-turn': token },
    body: JSON.stringify({ text }),
  })
  const body = await res.json() as { said?: string[], tools?: { name: string, result?: string }[], ms?: number, error?: string, timedOut?: boolean }
  return {
    said: body.said ?? [],
    tools: body.tools ?? [],
    ms: body.ms ?? 0,
    ...(body.error === undefined ? {} : { error: body.error }),
    ...(body.timedOut === true ? { timedOut: true } : {}),
  }
}

export async function hangupTextTurn(port: number, token: string): Promise<void> {
  await fetch(`http://127.0.0.1:${port}/hangup`, { method: 'POST', headers: { 'x-workbench-text-turn': token } }).catch(() => undefined)
}

/** 一句跑完把它建的卡删掉(开了会话的先停掉)、挂着的单子拒掉,免得下一句被「看板上已有同一件」「接着上一件说」接走。 */
export async function cleanup(base: string, state: StateLike, ids: readonly string[]): Promise<void> {
  const mine = new Set(ids)
  for (const a of state.approvals ?? []) {
    if (a.task_id !== undefined && mine.has(a.task_id)) {
      await fetch(`${base}/approvals/answer`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ id: a.id, allow: false }) }).catch(() => undefined)
    }
  }
  // 开了会话的先停掉那条会话(「停掉这一件」),不然它在后台接着干、过一阵又建卡,落进下一句的差集。
  const page = { 'content-type': 'application/json', origin: base }
  for (const t of tasksOf(state)) {
    if (mine.has(t.id) && t.conversation !== undefined) {
      await fetch(`${base}/butler/item/stop`, { method: 'POST', headers: page, body: JSON.stringify({ id: t.id }) }).catch(() => undefined)
    }
  }
  for (const id of ids) {
    await fetch(`${base}/task/delete`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ id }) }).catch(() => undefined)
  }
}
