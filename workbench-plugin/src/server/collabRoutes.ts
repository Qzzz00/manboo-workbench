/**
 * 协作区的那几条 8791 路由(2026-10-21,阶段一 · 一个人的板)。
 *
 * **接缝**:8791 接口(主人 = 统筹)。全部是新路径(`/collab/*`、`/token/personal*`),老路径一条没改;
 * 改便签本身仍走老的 `/task/*`(那几条在 http.ts,多认了几格字段)—— 不开第二条能改便签的路。
 *
 * | 路由 | 做什么 |
 * |---|---|
 * | `GET  /collab/presence` | 板上此刻的小鼠标(不进快照) |
 * | `GET/POST /collab/canvas` | 读 / 存板的摆法(`<工作目录>/协作区/板.canvas`,只存位置与分组) |
 * | `GET/POST /collab/types` | 读 / 存事项类型表(`<工作目录>/协作区/事项类型.json`;`{ types: [{ id, title, icon, color: { dark, light } }] }`,整张换) |
 * | `POST /collab/goal/create`、`/collab/goal/update` | 目标(没有删除,不要了改 `dropped`) |
 * | `POST /collab/goal/condition/save`、/remove、/verify、/deliver;`GET /collab/goal/board` | 目标能力条件与动态验收(2026-10-24 契约 §1;board 现算不落盘) |
 * | `POST /collab/note/message`;`GET /collab/note/activity?id=` | 留言 / 邀请 / 活动流(2026-10-24 契约 §2;client_msg_id 幂等,delivery 受理读取侧现算) |
 * | `POST /collab/relation/save`、/remove;`GET /collab/relations?task_id=` | 任务关系(2026-10-24 契约 §3;depends_on 拒环,stale 现算) |
 * | `GET /collab/runs?task_id=`(或 `?goal_id=`;不带参数 = 全部未结卡)、`GET /collab/capacity` | 时间与容量事实(2026-10-24 契约 §4;只读 jobLog 现算,limit 取不到 = 'unknown') |
| `GET /collab/trace?goal_id=` | 目标下每件事项的执行轨迹(2026-10-27;纯逻辑在 collabTrace.ts,只取真实记录) |
 * | `GET/POST /collab/lan/identity`、`GET /collab/lan/members?refresh=1`、`POST /collab/lan/members/remember`、`GET /collab/lan/hello` | 局域网身份与成员(2026-10-24 契约 §5;按需 refresh 不是后台扫描,hello 放 trusted 闸前给未配对对端 ping) |
 * | `POST /collab/sprint/save` | 可选的冲刺 |
 * | `POST /collab/agent/save` | 登记 / 改一张 Agent 名片 |
 * | `POST /collab/session/attach`、`/dismiss`、`/placed` | 他直接开的会话:放进目标 / 不进看板 / 直接放进去之后换目标、撤掉、看过 |
 * | `POST /collab/migrate`、`/collab/migrate/rollback` | 老冲刺 → 目标的迁移与回退 |
 * | `GET /token/personal`、`POST /token/personal/issue`、`/token/personal/revoke` | 个人访问令牌(只认本机页面) |
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { DeviceView, AgentCard, AgentId, CollabGoal, GoalBoardSummary, GoalTraceView, GoalConditionState, NoteMessage, RunSegment, TaskView } from '../protocol.ts'
import {
  AGENT_IDS, GOAL_CONDITION_STATES, RUN_ACTIVE_STALE_MS, RUN_STALE_MS, TASK_RELATION_KINDS, TASK_STATUSES, UNSORTED_GOAL_ID, checkWorkTypes,
  conditionStateOf, executionRoleOf, goalIdOf, isTaskAssigneeValue, isTaskRelationKind,
} from '../protocol.ts'
import type { JobEvent, JobLog } from './jobLog.ts'
import { isFinishStep } from './jobLog.ts'
// 「收场只有一张表」(2026-10-02)的那一份:/collab/runs 无参读法数「未结卡」照它,不另写判法。
import { SETTLED_TASK_STATUS } from './jobKey.ts'
import { createLanTransport } from './collabLanTransport.ts'
import { taskTraceOf } from './collabTrace.ts'
import { createChannelSourcePublisher } from './collabChannelSources.ts'
import type { FeedService } from './feed.ts'
import { LAN_CHANNEL_CATEGORIES } from './collabStore.ts'
import { pingLanMember } from './collabLan.ts'
import type { TasksService } from './tasks.ts'
import type { PresenceBoard } from './collabPresence.ts'
import type { PersonalTokens } from './personalToken.ts'
import { canvasFileOf, parseLayout, readBoardLayout, writeBoardLayout } from './collabCanvas.ts'
import type { WorkTypesStore } from './collabTypes.ts'
import type { GitHubDevice } from './githubDevice.ts'
import { githubRepoOf } from './githubDevice.ts'
import type { McpSecrets } from './mcpSecrets.ts'
import { SECRET_NAME } from './collabStore.ts'
import { deliverInvitations } from './collabDelivery.ts'
import { staleRelation, staleUpstreamTasks } from './collabRelations.ts'
import type { InvitationDispatch } from './collabDelivery.ts'
import type { TimerRunner } from './collabTimers.ts'

export interface CollabRouteContext {
  req: IncomingMessage
  res: ServerResponse
  path: string
  device?: DeviceView
  /** 本机 / 配对过的设备 / 带令牌的模块。 */
  trusted: boolean
  /** 降权之后的本机回环。 */
  loopback: boolean
  /** 这一条是工作台页面(壳 / 浏览器)点的,不是程序。 */
  page: boolean
  sendJson: (res: ServerResponse, status: number, payload: unknown) => void
  readJsonBody: (req: IncomingMessage, res: ServerResponse) => Promise<Record<string, unknown> | undefined>
  /** 授权表的写门(程序来源没放开 `write_api` 时回一句拒绝)。 */
  writeDenied: () => Promise<string | undefined>
}

export interface CollabRoutesDeps {
  tasks?: TasksService
  presence: PresenceBoard
  /** 板的文件在哪(`<工作目录>/协作区/板.canvas`)。 */
  canvasFile: () => Promise<string>
  tokens?: PersonalTokens
  /** 改完之后推一份快照。 */
  changed: () => Promise<void>
  github?: GitHubDevice
  mcpSecrets?: McpSecrets
  timers?: TimerRunner
  /** 事项类型表(2026-10-22)。缺席 = 这台服务没接,两条路由都 404。 */
  workTypes?: WorkTypesStore
  /**
   * 派活技能库名单(2026-10-22,卡「用户层技能生效」B):本体 ∪ 用户层。`/collab/agent/save` 校验
   * 「勾的技能存在」时两边都查。缺席 = 不校验(老行为)。
   */
  skillNames?: () => Promise<readonly string[]>
  /** 任务日志(2026-10-24 契约 §4):运行片段与容量只读它,不重写 dispatch 写在卡上的字段。缺席 = runs/capacity 的 running 事实缺席(如实)。 */
  jobLog?: JobLog
  now?: () => number
  dispatch?: InvitationDispatch
  lanPeerFile?: () => Promise<string>
  feed?: Pick<FeedService, 'view'>
}

const str = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined)
/** null = 清掉,undefined = 不动。 */
const nullable = (value: unknown): string | null | undefined => (value === null ? null : typeof value === 'string' ? value : undefined)

/** 形状不对的哨兵(与 http.ts 的 parseNullable 同写法)。 */
const INVALID: unique symbol = Symbol('invalid')

/** `runtime` 输入:undefined = 不动,null = 清掉,对象 = 换新;别的形状回 INVALID。 */
function cardRuntimeInput(value: unknown): AgentCard['runtime'] | null | undefined | typeof INVALID {
  if (value === undefined) return undefined
  if (value === null) return null
  if (typeof value !== 'object') return INVALID
  const raw = value as Record<string, unknown>
  if (str(raw.family) === undefined) return INVALID
  return { family: str(raw.family) as string, ...(str(raw.bin) === undefined ? {} : { bin: str(raw.bin) as string }) }
}

/** `project` 输入:同 {@link cardRuntimeInput} 的三态。 */
function cardProjectInput(value: unknown): AgentCard['project'] | null | undefined | typeof INVALID {
  if (value === undefined) return undefined
  if (value === null) return null
  if (typeof value !== 'object') return INVALID
  if (str((value as Record<string, unknown>).repo) === undefined) return INVALID
  return { repo: str((value as Record<string, unknown>).repo) as string }
}

/** `model` 输入:同 {@link cardRuntimeInput} 的三态;effort 只认三档。 */
function cardModelInput(value: unknown): AgentCard['model'] | null | undefined | typeof INVALID {
  if (value === undefined) return undefined
  if (value === null) return null
  if (typeof value !== 'object') return INVALID
  const raw = value as Record<string, unknown>
  const name = raw.name === undefined ? undefined : str(raw.name)
  if (raw.name !== undefined && name === undefined) return INVALID
  const effort = raw.effort === undefined ? undefined : raw.effort === 'low' || raw.effort === 'medium' || raw.effort === 'high' ? raw.effort : INVALID
  if (effort === INVALID) return INVALID
  return {
    ...(name === undefined ? {} : { name }),
    ...(effort === undefined ? {} : { effort }),
  }
}

/** `budget` 输入(2026-10-23 卡「派活给名片的四处」③):同 {@link cardRuntimeInput} 的三态;minutes 1..1440。 */
function cardBudgetInput(value: unknown): AgentCard['budget'] | null | undefined | typeof INVALID {
  if (value === undefined) return undefined
  if (value === null) return null
  if (typeof value !== 'object') return INVALID
  const minutes = (value as Record<string, unknown>).minutes
  if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes < 1 || minutes > 24 * 60) return INVALID
  return { minutes: Math.round(minutes) }
}

/** `goal_id` 用现成的;没有就照 `new_goal_title`(可带 `project_id`)新建一个。都没带 = 不放进目标。 */
async function goalFor(tasks: TasksService, body: Record<string, unknown>): Promise<{ ok: true, id?: string } | { ok: false, error: string }> {
  const goalId = str(body.goal_id)
  if (goalId !== undefined) return { ok: true, id: goalId }
  const newGoal = str(body.new_goal_title)
  if (newGoal === undefined) return { ok: true }
  const made = await tasks.createGoal({ title: newGoal, ...(str(body.project_id) === undefined ? {} : { projectId: str(body.project_id) as string }) })
  return made.ok && made.id !== undefined ? { ok: true, id: made.id } : { ok: false, error: made.reason ?? '新目标没建成' }
}

/**
 * 把一条他直接开的会话放进一个目标 = 建一张在做的便签:负责人是开那条会话的那一家、连上那条会话,
 * 验收他之后在详情里补(便签角上会标「没写做到什么算完」)。已经有便签连着它就原样回那张。
 * 他点「放进去」(`/collab/session/attach`)与只有一个目标时直接放(http.ts)走的是同一个函数。
 */
export async function placeSession(
  tasks: TasksService,
  input: { agent: AgentId, sessionId: string, body: Record<string, unknown> },
): Promise<{ ok: true, id: string, goalId?: string, already?: boolean } | { ok: false, error: string }> {
  const { agent, sessionId, body } = input
  const key = `${agent}:${sessionId}`
  const state = await tasks.list()
  // ★ 删过不再登(2026-10-23,卡「待排的卡不许被派出去」④):这条会话记录回流建的便签
  // 被他删过 → 不再登一张(删过的小表落盘,重启后仍有效)。要留痕请他重新贴一张。
  const removed = await tasks.removedSessionCards().catch(() => [] as string[])
  if (removed.includes(key)) return { ok: false, error: '这条会话的便签被删过了,不再登 —— 要留的话重新贴一张' }
  const already = state.tasks.find((one: TaskView) => (one.links ?? []).some(link => link.agent === agent && link.session_id === sessionId))
  if (already !== undefined) return { ok: true, id: already.id, already: true }
  const goal = await goalFor(tasks, body)
  if (!goal.ok) return goal
  const goalId = goal.id ?? UNSORTED_GOAL_ID
  const givenTitle = str(body.title)
  const title = givenTitle ?? `${agent} 的会话`
  const assignee = isTaskAssigneeValue(agent) ? agent : undefined
  const created = await tasks.create({
    title,
    // ★ 卡名来源(2026-10-23,卡 A):带著名建的卡,名是借这条会话的 —— 会话改名,卡跟着改;
    // 没著名的(空标题会话)不借名:会话以后借卡名(211d 那一条)照旧,互不打架。
    ...(givenTitle === undefined ? {} : { titleFrom: 'session' as const }),
    status: 'doing',
    ...(str(body.project_id) === undefined ? {} : { projectId: str(body.project_id) as string }),
    goalId,
    from: { kind: 'session', ref: key },
    ...(assignee === undefined ? {} : { assignee }),
    links: [{ agent, session_id: sessionId }],
    source: { kind: 'session', ref: key },
  })
  if (!created.ok || created.id === undefined) return { ok: false, error: created.reason ?? '没放进去' }
  return { ok: true, id: created.id, goalId }
}

/**
 * 目标汇总投影(2026-10-24 契约 §1):list() 时现算,不落盘。
 * 任务数量只回答工作分布,目标进度只按条件状态算;父组有子卡时父卡不重复计,取消单列。
 */
function goalBoardSummary(goal: CollabGoal, tasks: readonly TaskView[], jobLog?: JobLog, nowMs = Date.now(), staleTasks: ReadonlySet<string> = new Set()): GoalBoardSummary {
  const taskById = new Map(tasks.map(one => [one.id, one]))
  const conditions = goal.conditions ?? []
  const byState = Object.fromEntries(GOAL_CONDITION_STATES.map(state => [state, 0])) as Record<GoalConditionState, number>
  const items = conditions.map((condition) => {
    const task = condition.task_id === undefined ? undefined : taskById.get(condition.task_id)
    const segment = task === undefined || jobLog === undefined ? undefined : runSegmentsOf(task.id, jobLog.events(task.id), nowMs).at(-1)
    const execution = segment?.status === 'running' || segment?.status === 'dispatched' || segment?.status === 'unknown' ? segment.status : undefined
    const state = task !== undefined && task.status !== 'canceled' && staleTasks.has(task.id) ? 'rework' : conditionStateOf(condition, task, execution)
    byState[state] += 1
    return {
      id: condition.id,
      text: condition.text,
      state,
      ...(condition.task_id === undefined ? {} : { task_id: condition.task_id }),
      ...(task?.assignee === undefined ? {} : { assignee: task.assignee }),
      ...(task?.receipt === undefined ? {} : { last_receipt_at: task.receipt.at }),
      // 受阻时给原因:卡上的真实回执(standing 是 /state 组装时现算的格,这里取得到就用)。
      ...(state === 'blocked' && task !== undefined
        ? { blocker: { ...(task.receipt?.text === undefined ? {} : { reason: task.receipt.text }) } }
        : {}),
    }
  })
  const inGoal = tasks.filter(one => goalIdOf(one) === goal.id)
  const parentIds = new Set(inGoal.filter(one => (one.children ?? []).length > 0).map(one => one.id))
  const counted = inGoal.filter(one => !parentIds.has(one.id))
  const canceled = counted.filter(one => one.status === 'canceled')
  const active = counted.filter(one => one.status !== 'canceled')
  const byStatus = Object.fromEntries(TASK_STATUSES.map(status => [status, 0])) as Record<TaskView['status'], number>
  for (const one of active) byStatus[one.status] += 1
  return {
    goal_id: goal.id,
    scope: `目标「${goal.title}」;条件状态由服务端按承接任务事实现算;任务统计不含父组卡(有子卡只计子卡),取消单列。`,
    conditions: { total: conditions.length, by_state: byState, items },
    tasks: {
      total: active.length,
      by_status: byStatus,
      canceled: canceled.length,
      unscheduled: byState.pending,
    },
  }
}

/**
 * 本条邀请的受理只认精确子事项的活动或 message_id 回执;无关回执不外推。
 */
function deliveriesWithAcceptance(message: NoteMessage, task: TaskView, tasks: readonly TaskView[], jobLog?: JobLog, nowMs = Date.now()): NoteMessage['deliveries'] {
  return message.deliveries?.map(one => {
    const { error: _oldError, ...delivered } = one
    const execution = one.task_id === undefined ? task : tasks.find(t => t.id === one.task_id)
    const receipt = execution?.receipt
    if (receipt?.by === one.to && receipt.message_id !== undefined && (receipt.message_id === message.id || receipt.message_id === message.client_msg_id)) {
      return { ...delivered, status: 'accepted' as const, at: receipt.at, receipt }
    }
    if (one.task_id !== undefined && execution?.dispatch?.status === 'failed') return { ...one, status: 'failed' as const, error: execution.dispatch.note ?? execution.note ?? '执行未完成' }
    const run = one.task_id === undefined ? undefined : runSegmentsOf(one.task_id, jobLog?.events(one.task_id) ?? [], nowMs).at(-1)
    if (run?.status === 'running') return { ...delivered, status: 'accepted' as const }
    // finishInvitation 前进程中断:沿准确 child 的运输事实恢复投递,不把 PID/assigned 当受理。
    if (one.task_id !== undefined && (execution?.client_dispatch?.status === 'sent' || execution?.dispatch !== undefined && execution.dispatch.status !== 'failed')) return { ...delivered, status: 'delivered' as const }
    if (one.task_id !== undefined && execution?.status === 'blocked' && execution.note !== undefined) return { ...one, error: execution.note }
    return one
  })
}

/** 活动流(契约 §2):message / comment / receipt / transition 按 at 升序合一(run 段由 E 切片补)。 */
function activityItems(task: TaskView, runs: readonly RunSegment[], tasks: readonly TaskView[], jobLog?: JobLog, nowMs = Date.now()) {
  const messages = (task.messages ?? []).map(message => ({ ...message, deliveries: deliveriesWithAcceptance(message, task, tasks, jobLog, nowMs) }))
  return [
    ...messages.map(message => ({ type: 'message' as const, at: message.at, message })),
    ...(task.comments ?? []).map(comment => ({ type: 'comment' as const, at: comment.at, comment })),
    ...(task.receipt === undefined ? [] : [{ type: 'receipt' as const, at: task.receipt.at, receipt: task.receipt }]),
    ...(task.transitions ?? []).map(transition => ({ type: 'transition' as const, at: transition.at, from: transition.from, to: transition.to })),
    ...runs.map(segment => ({ type: 'run' as const, at: segment.finished_at ?? segment.started_at, segment })),
  ].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
}

/* —— 时间与容量事实(2026-10-24 契约 §4):只读 jobLog 现算,不落盘、不重写 dispatch 写在卡上的字段。 —— */

/** 中途这三种 = 等待(等待不算运行);最后一条是它们之一,这段就算 paused。 */
const RUN_PAUSE_STEPS: readonly JobEvent['step'][] = ['waiting', 'budget_stop', 'jammed']
/** 收场里的这两种 = 干成了;其余收场步(timeout / unreadable / not_sent)= 失败。 */
const RUN_DONE_STEPS: readonly JobEvent['step'][] = ['replied', 'ended', 'done']

/**
 * 一张卡的事件 → 运行片段(纯函数):以 assigned 为界,相邻 assigned 各起一段(再一次 assigned = 重派,开新段)。
 * assigned 之前的散事件(sent 先于指派)不构成一段 —— 一段就是「assigned→收场步」,没有指派就没有运行记录。
 * 来源取段里第一条真实 family,缺席 'unknown'。
 */
export function runSegmentsOf(taskId: string, events: readonly JobEvent[], nowMs: number, task?: TaskView): RunSegment[] {
  const sorted = [...events].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
  const buckets: JobEvent[][] = []
  const sourceBuckets = new Map<string, JobEvent[]>()
  const latestSourceRound = new Map<string, string>()
  let current: JobEvent[] | undefined
  for (const event of sorted) {
    if (event.session_id !== undefined && event.source_round !== undefined) {
      const key = `${event.agent ?? 'unknown'}\u0000${event.session_id}\u0000${event.source_round}`
      const bucket = sourceBuckets.get(key) ?? []
      bucket.push(event)
      sourceBuckets.set(key, bucket)
      latestSourceRound.set(`${event.agent ?? 'unknown'}\u0000${event.session_id}`, event.source_round)
      continue
    }
    if (event.step !== 'assigned') {
      if (current !== undefined) current.push(event)
      continue
    }
    if (current !== undefined) buckets.push(current)
    current = [event]
  }
  if (current !== undefined) buckets.push(current)
  buckets.push(...sourceBuckets.values())
  buckets.sort((a, b) => Date.parse(a[0]?.at ?? '') - Date.parse(b[0]?.at ?? ''))
  return buckets.map((bucket): RunSegment => {
    const finish = bucket.find(one => isFinishStep(one.step))
    const lastPause = bucket.filter(one => RUN_PAUSE_STEPS.includes(one.step)).at(-1)
    const last = bucket.at(-1) as JobEvent
    const source = bucket.find(one => one.family !== undefined && one.family !== '')?.family ?? 'unknown'
    const startedAt = bucket[0]?.at ?? last.at
    // 原事件的at是本机核实时间,不是模型内部时钟;首次观察不被后续started心跳替换。
    const observed = finish === undefined ? bucket : bucket.slice(0, bucket.indexOf(finish) + 1)
    const validObservedTime = (event: JobEvent): boolean => {
      const observedAt = event.observed_at ?? event.at
      return Number.isFinite(Date.parse(observedAt)) && Date.parse(observedAt) >= Date.parse(startedAt) && Date.parse(observedAt) <= nowMs
    }
    const executionStart = observed.find(one => one.step === 'started' && validObservedTime(one))
    const executionFinish = finish?.step === 'replied' && validObservedTime(finish) ? finish : undefined
    let status: RunSegment['status']
    if (last.step === 'source_unknown') status = 'unknown'
    else if (last.step === 'source_observed') status = last.source_state === 'running' ? 'running'
      : last.source_state === 'returned' || last.source_state === 'ended' ? 'done' : 'unknown'
    else if (finish !== undefined) status = RUN_DONE_STEPS.includes(finish.step) ? 'done' : 'failed'
    else if (RUN_PAUSE_STEPS.includes(last.step)) status = 'paused'
    else {
      const started = bucket.filter(one => one.step === 'started').at(-1)
      const activity = bucket.filter(one => one.step === 'started' || one.step === 'updated').at(-1)
      /*
       * 卡上 dispatch 那一份是派发口同一拍写下的运行态(2026-10-29 改口,任务书「在跑的事项…」):
       * 命令行起进程那一刻 `dispatch.status='running'` + pid 与账里 `started` 是同一事实的两格,
       * 账里缺席(老卡 / 账被裁)或活动断档(在等模型)时以卡上运行态为见证。收场仍以账为准 —
       * dispatch 写了 `ended_at` 就是收场了:账里有收场步照旧认账;账里缺席时按回执判
       * (卡上这一轮有回执 = done,没有 = failed)。
       */
      const dispatch = task?.dispatch
      const dispatchLive = dispatch?.status === 'running' && dispatch.ended_at === undefined && dispatch.pid !== undefined
      if (started === undefined) {
        if (dispatch?.ended_at !== undefined) {
          const receipt = (task?.receipts ?? []).find(one => (one.task_round ?? 1) === (task?.round ?? 1)) ?? task?.receipt
          status = receipt === undefined ? 'failed' : 'done'
        }
        else if (dispatchLive) status = 'running'
        else status = nowMs - Date.parse(last.at) <= RUN_STALE_MS ? 'dispatched' : 'unknown'
      }
      else status = nowMs - Date.parse(activity?.at ?? started.at) <= RUN_ACTIVE_STALE_MS || dispatchLive ? 'running' : 'unknown'
    }
    const origin = bucket[0]
    const currentSource = origin?.session_id === undefined ? undefined : latestSourceRound.get(`${origin.agent ?? 'unknown'}\u0000${origin.session_id}`) === origin.source_round
    if (currentSource === false && finish === undefined) status = 'unknown'
    return {
      task_id: taskId,
      source,
      ...(task === undefined ? {} : (() => {
        const role = origin?.session_id === undefined ? executionRoleOf(task)
          : task.links?.find(link => link.agent === origin.agent && link.session_id === origin.session_id)?.execution_role ?? executionRoleOf(task)
        return { role: role.kind, role_origin: role.origin }
      })()),
      ...(origin?.task_round === undefined ? {} : { task_round: origin.task_round }),
      ...(currentSource === undefined ? {} : { current: currentSource,
        execution_state: status === 'running' ? 'running' : status === 'unknown' ? 'unknown'
          : finish?.why === 'receipt:blocked' || finish?.why === '回执:blocked' ? 'blocked'
            : finish?.step === 'replied' ? 'awaiting_review' : 'unknown' }),
      ...(bucket[0]?.session_id === undefined ? {} : { session_id: bucket[0].session_id }),
      ...(bucket[0]?.agent === undefined ? {} : { agent: bucket[0].agent }),
      ...(bucket[0]?.source_round === undefined ? {} : { source_round: bucket[0].source_round }),
      status,
      started_at: startedAt,
      ...(finish === undefined ? {} : { finished_at: finish.at, outcome: finish.step }),
      ...(executionStart === undefined ? {} : { execution_started_observed_at: executionStart.observed_at ?? executionStart.at }),
      ...(executionFinish === undefined ? {} : { execution_finished_observed_at: executionFinish.observed_at ?? executionFinish.at }),
      ...(lastPause?.why === undefined || lastPause.why === '' ? {} : { pause_reason: lastPause.why }),
    }
  })
}

export function createCollabRoutes(deps: CollabRoutesDeps) {
  const now = deps.now ?? Date.now
  const lan = deps.tasks === undefined || deps.lanPeerFile === undefined ? undefined : createLanTransport(deps.tasks, deps.lanPeerFile)
  const sources = deps.tasks === undefined || lan === undefined ? undefined : createChannelSourcePublisher({ tasks: deps.tasks, now,
    ...(deps.feed === undefined ? {} : { feed: deps.feed }), ...(deps.jobLog === undefined ? {} : { jobLog: deps.jobLog }),
    publish: (material, recipients) => lan.publishSource(material, recipients), changed: deps.changed })

  async function handle(ctx: CollabRouteContext): Promise<boolean> {
    const { req, res, path, sendJson } = ctx
    if (!path.startsWith('/collab/') && path !== '/token/personal' && !path.startsWith('/token/personal/')) return false

    // —— 个人访问令牌:**只认本机页面**(程序不许给自己发令牌;手机上不发)。 ——
    if (path === '/token/personal' || path.startsWith('/token/personal/')) {
      if (deps.tokens === undefined) { sendJson(res, 404, { error: '个人访问令牌没接上' }); return true }
      if (!ctx.loopback) { sendJson(res, 403, { error: '个人访问令牌只能在这台电脑的设置页里发' }); return true }
      if (path === '/token/personal' && req.method === 'GET') {
        sendJson(res, 200, { tokens: await deps.tokens.list(), ...(await deps.tokens.status()) })
        return true
      }
      if (req.method !== 'POST') { sendJson(res, 405, { error: '只收 POST' }); return true }
      if (!ctx.page) { sendJson(res, 403, { error: '令牌要在设置页里点着发,程序不能替自己发' }); return true }
      const body = await ctx.readJsonBody(req, res)
      if (body === undefined) return true
      if (path === '/token/personal/issue') {
        const purpose = str(body.purpose)
        if (purpose === undefined) { sendJson(res, 400, { error: '先写这枚令牌拿去做什么(purpose)' }); return true }
        const issued = await deps.tokens.issueWith(purpose)
        // 明文只在这一次回包里出现。
        sendJson(res, 200, { ok: true, token: issued.token, view: issued.view, tokens: await deps.tokens.list() })
        return true
      }
      if (path === '/token/personal/revoke') {
        const id = str(body.id)
        if (id === undefined) { sendJson(res, 400, { error: '撤哪一枚(id)' }); return true }
        const gone = await deps.tokens.revoke(id)
        sendJson(res, gone ? 200 : 404, gone ? { ok: true, tokens: await deps.tokens.list() } : { error: '没有这一枚' })
        return true
      }
      sendJson(res, 404, { error: '没有这个路径' })
      return true
    }

    /*
     * —— 局域网对端探测口(2026-10-24 契约 §5):**故意放在 trusted 闸前** ——
     * refresh=1 要 ping 的远端成员多半还没配对,过了闸它们永远 ping 不通。
     * 只回 member_id + 展示名:这就是见面时要交换的两样,不多给一个字。
     */
    if (path === '/collab/lan/hello' && req.method === 'GET') {
      if (deps.tasks === undefined) { sendJson(res, 404, { error: '任务看板未启用' }); return true }
      const identity = await deps.tasks.lanIdentity()
      sendJson(res, 200, { member_id: identity.member_id, name: identity.name })
      return true
    }

    if (!ctx.trusted) { sendJson(res, 403, { error: '只能在本机或已配对的手机上用协作区' }); return true }

    if (path === '/collab/presence' && req.method === 'GET') {
      sendJson(res, 200, { presence: deps.presence.list() })
      return true
    }

    const tasks = deps.tasks
    if (tasks === undefined) { sendJson(res, 404, { error: '任务看板未启用' }); return true }

    // —— GitHub(只认本机):设备码登录、PR 列表、PR 挂到便签。令牌只在本机,一个字都不回界面。 ——
    if (path.startsWith('/collab/github')) {
      if (deps.github === undefined) { sendJson(res, 404, { error: 'GitHub 登录没接上' }); return true }
      if (!ctx.loopback) { sendJson(res, 403, { error: 'GitHub 只能在这台电脑上连' }); return true }
      if (path === '/collab/github' && req.method === 'GET') { sendJson(res, 200, await deps.github.view()); return true }
      if (path === '/collab/github/pulls' && req.method === 'GET') {
        const projectId = new URL(req.url ?? '/', 'http://x').searchParams.get('project_id') ?? ''
        const meta = (await tasks.list()).project_meta
        const repos = meta
          .filter(one => projectId === '' || one.project_id === projectId)
          .flatMap(one => (one.repos ?? []).map(repo => githubRepoOf(repo.remote_url)))
          .filter((one): one is { owner: string, repo: string } => one !== undefined)
        const pulls = await deps.github.pulls(repos)
        if (pulls === undefined) { sendJson(res, 409, { error: '还没连 GitHub' }); return true }
        sendJson(res, 200, { pulls, repos: repos.map(one => `${one.owner}/${one.repo}`) })
        return true
      }
      if (req.method !== 'POST') { sendJson(res, 404, { error: '没有这个路径' }); return true }
      const denied = await ctx.writeDenied()
      if (denied !== undefined) { sendJson(res, 403, { error: denied }); return true }
      const body = await ctx.readJsonBody(req, res)
      if (body === undefined) return true
      if (path === '/collab/github/start') { sendJson(res, 200, await deps.github.start()); return true }
      if (path === '/collab/github/disconnect') { await deps.github.disconnect(); sendJson(res, 200, await deps.github.view()); return true }
      if (path === '/collab/github/attach') {
        const pr = str(body.pr)
        const noteId = str(body.note_id)
        if (pr === undefined || !/^[\w.-]+\/[\w.-]+#\d+$/.test(pr) || noteId === undefined) { sendJson(res, 400, { error: 'pr 写成 <owner>/<repo>#<号>,还要 note_id' }); return true }
        const note = (await tasks.list()).tasks.find(one => one.id === noteId)
        if (note === undefined) { sendJson(res, 404, { error: '没有这张便签' }); return true }
        await tasks.update(noteId, { pullRequests: [...new Set([...(note.pull_requests ?? []), pr])] })
        await deps.changed()
        sendJson(res, 200, { ok: true })
        return true
      }
      sendJson(res, 404, { error: '没有这个路径' })
      return true
    }

    if (path === '/collab/types' && req.method === 'GET') {
      if (deps.workTypes === undefined) { sendJson(res, 404, { error: '事项类型表没接上' }); return true }
      sendJson(res, 200, { scope: 'local', types: await deps.workTypes.read() })
      return true
    }

    if (path === '/collab/canvas' && req.method === 'GET') {
      const file = await deps.canvasFile()
      sendJson(res, 200, { file, layout: await readBoardLayout(file) })
      return true
    }

    // —— 目标汇总投影(契约 §1):现算不落盘;带 goal_id 回单个,不带回全部。 ——
    if (path === '/collab/goal/board' && req.method === 'GET') {
      const goalId = new URL(req.url ?? '/', 'http://x').searchParams.get('goal_id')
      const state = await tasks.list()
      const goals = state.goals ?? []
      const stale = staleUpstreamTasks(state.tasks, await tasks.listRelations())
      if (goalId !== null && goalId !== '') {
        const goal = goals.find(one => one.id === goalId)
        if (goal === undefined) { sendJson(res, 404, { error: '没有这个目标' }); return true }
        sendJson(res, 200, { summary: goalBoardSummary(goal, state.tasks, deps.jobLog, now(), stale) })
        return true
      }
      sendJson(res, 200, { summaries: goals.map(one => goalBoardSummary(one, state.tasks, deps.jobLog, now(), stale)) })
      return true
    }

    // —— 活动流(契约 §2):message / comment / receipt / transition / run 按 at 升序合一。 ——
    if (path === '/collab/note/activity' && req.method === 'GET') {
      // 8791 第六轮第 3 轮:这条读路不再触发对账,只读上一次对账快照。
      const id = new URL(req.url ?? '/', 'http://x').searchParams.get('id') ?? ''
      const state = await tasks.list()
      const task = state.tasks.find(one => one.id === id)
      if (task === undefined) { sendJson(res, 404, { error: '没有这张便签' }); return true }
      const runs = deps.jobLog === undefined ? [] : runSegmentsOf(id, deps.jobLog.events(id), now(), task)
      sendJson(res, 200, { items: activityItems(task, runs, state.tasks, deps.jobLog, now()) })
      return true
    }

    // —— 任务关系(契约 §3):stale 现算(来源卡轮次涨过 = 上游重开,下游别拿旧交接当数),不落盘。 ——
    if (path === '/collab/relations' && req.method === 'GET') {
      const taskId = new URL(req.url ?? '/', 'http://x').searchParams.get('task_id') ?? ''
      const state = await tasks.list()
      const roundOf = new Map(state.tasks.map(one => [one.id, one.round ?? 1]))
      const relations = (await tasks.listRelations())
        .filter(one => one.from_id === taskId || one.to_id === taskId)
        .map(one => ({
          ...one,
          stale: staleRelation(one, roundOf),
        }))
      sendJson(res, 200, { relations })
      return true
    }

    // —— 运行片段(契约 §4):assigned→收场步为一段;无事件 = 空数组,不编一段。 ——
    /*
     * 三种读法(2026-10-29,任务书「在跑的事项要数到命令行真在跑的活」洞 2):
     * `?task_id=` 一张卡;`?goal_id=` 一整个目标;**不带参数 = 全部未结卡**(一次请求)——
     * 悬浮球要数「在跑的事项」,而板上没归目标的卡 `goal_id` 是空的,按目标逐个查永远查不到它们。
     * 「未结」照「收场只有一张表」那张表(`jobKey.SETTLED_TASK_STATUS`),不另写一份判法。
     */
    if (path === '/collab/runs' && req.method === 'GET') {
      // 8791 第六轮第 3 轮:这条读路不再触发对账,只读上一次对账快照。
      if (deps.jobLog === undefined) { sendJson(res, 404, { error: '任务日志没接上,运行事实缺席' }); return true }
      const params = new URL(req.url ?? '/', 'http://x').searchParams
      const taskId = params.get('task_id')
      const goalId = params.get('goal_id')
      const state = await tasks.list()
      const taskIds = taskId !== null && taskId !== ''
        ? [taskId]
        : goalId !== null && goalId !== ''
          ? state.tasks.filter(one => goalIdOf(one) === goalId).map(one => one.id)
          : state.tasks.filter(one => !SETTLED_TASK_STATUS.includes(one.status)).map(one => one.id)
      const nowMs = now()
      const runs = taskIds.flatMap(id => runSegmentsOf(id, deps.jobLog?.events(id) ?? [], nowMs, state.tasks.find(one => one.id === id)))
      sendJson(res, 200, { runs })
      return true
    }

    // —— 执行轨迹(2026-10-27):目标下每件事项一条,节点只取真实记录;没接任务日志就只用卡上自己的留痕。 ——
    if (path === '/collab/trace' && req.method === 'GET') {
      // 8791 第六轮第 3 轮:这条读路不再触发对账,只读上一次对账快照。
      const goalId = new URL(req.url ?? '/', 'http://x').searchParams.get('goal_id')
      if (goalId === null || goalId === '') { sendJson(res, 400, { error: '要带 goal_id' }); return true }
      const state = await tasks.list()
      const relations = await tasks.listRelations()
      const conditions = (state.goals ?? []).find(one => one.id === goalId)?.conditions ?? []
      const titles = new Map(state.tasks.map(one => [one.id, one.title]))
      const nowMs = now()
      const traces = state.tasks.filter(one => goalIdOf(one) === goalId).map(task => {
        const events = deps.jobLog?.events(task.id) ?? []
        const runs = runSegmentsOf(task.id, events, nowMs, task)
        return taskTraceOf(task, events, relations, conditions, runs, nowMs, titles)
      })
      const view: GoalTraceView = { goal_id: goalId, traces }
      sendJson(res, 200, view)
      return true
    }

    // —— 容量(契约 §4):在线 / 手上几件 / 未收场几件 / 上限,四个事实分开给;取不到上限 = 'unknown',不编。 ——
    if (path === '/collab/capacity' && req.method === 'GET') {
      // 8791 第六轮第 3 轮:这条读路不再触发对账,只读上一次对账快照。
      const state = await tasks.list()
      const online = new Set(deps.presence.list().map(one => one.actor.kind === 'agent' ? one.actor.id : `member:${one.actor.account}`))
      // 未收场片段按 source 数卡数(jobLog 现算;没有这本账,这一格如实缺席为 0 —— 由在线与 doing 两格撑着)。
      const openBySource = new Map<string, number>()
      if (deps.jobLog !== undefined) {
        const byJob = new Map<string, JobEvent[]>()
        for (const event of deps.jobLog.all()) {
          byJob.set(event.job, [...(byJob.get(event.job) ?? []), event])
        }
        for (const [job, events] of byJob) {
          const task = state.tasks.find(t => t.id === job)
          for (const segment of runSegmentsOf(job, events, now(), task)) {
            if (segment.status !== 'running' || segment.role !== 'business') continue
            const owner = task?.assignee ?? segment.source
            openBySource.set(owner, (openBySource.get(owner) ?? 0) + 1)
          }
        }
      }
      const items = [
        'me',
        ...(state.agent_cards ?? []).map(one => one.id),
      ].map(id => ({
        id,
        online: online.has(id),
        active_jobs: state.tasks.filter(one => one.status === 'doing' && one.assignee === id && executionRoleOf(one).kind === 'business').length,
        running_jobs: openBySource.get(id) ?? 0,
        limit: 'unknown' as const,
      }))
      sendJson(res, 200, { items })
      return true
    }

    // —— 本机局域网身份(契约 §5):第一次读时现场发一个,以后改名不换 member_id。 ——
    if (path === '/collab/lan/identity' && req.method === 'GET') {
      sendJson(res, 200, { identity: await tasks.lanIdentity() })
      return true
    }

    // —— 成员注册表(契约 §5):refresh=1 时逐个按需 ping(2 秒超时),不是后台扫描。 ——
    if (path === '/collab/lan/members' && req.method === 'GET') {
      const refresh = new URL(req.url ?? '/', 'http://x').searchParams.get('refresh') === '1'
      const members = await tasks.lanMembers()
      if (!refresh) { sendJson(res, 200, { members }); return true }
      const at = new Date(now()).toISOString()
      const refreshed = await Promise.all(members.map(async (one): Promise<typeof one> => {
        const hello = (await lan?.ping(one.member_id)) ?? await pingLanMember(one)
        // ping 通 → reachable:true + 盖上 last_seen;不通如实 false,last_seen 不动(还没 ping 通过)。
        return hello === undefined || hello.member_id !== one.member_id ? { ...one, reachable: false } : { ...one, name: hello.name, reachable: true, last_seen: at }
      }))
      await tasks.saveLanMembers(refreshed)
      sendJson(res, 200, { members: refreshed })
      return true
    }

    if (path === '/collab/lan/channel' && req.method === 'GET') {
      const params = new URL(req.url ?? '/', 'http://x').searchParams, project = params.get('project_id') ?? ''
      const category = params.get('category'), topic = params.get('topic_id'), source = params.get('source_id')
      if (category !== null && category !== 'unknown' && !LAN_CHANNEL_CATEGORIES.includes(category as typeof LAN_CHANNEL_CATEGORIES[number])) { sendJson(res, 400, { error: '未知频道分类' }); return true }
      const messages = (await tasks.lanChannel(project)).filter(m => (category === null || (category === 'unknown' ? m.category === undefined : m.category === category))
        && (topic === null || m.topic?.id === topic) && (source === null || m.source?.id === source))
      sendJson(res, 200, { messages, transport: 'lan', scope: 'known-paired-members', ...(sources === undefined ? {} : { source_scope: await sources.scope(project) }) })
      return true
    }

    if (req.method !== 'POST') { sendJson(res, 404, { error: '没有这个路径' }); return true }
    const denied = await ctx.writeDenied()
    if (denied !== undefined) { sendJson(res, 403, { error: denied }); return true }
    const body = await ctx.readJsonBody(req, res)
    if (body === undefined) return true

    if (path === '/collab/lan/channel/source-policy' || path === '/collab/lan/channel/publish') {
      if (!ctx.loopback) { sendJson(res, 403, { error: '来源发布策略与触发只在本机装配,频道人类只读' }); return true }
      if (sources === undefined || lan === undefined) { sendJson(res, 404, { error: '局域网来源发布未接入' }); return true }
      const project = str(body.project_id)
      if (project === undefined) { sendJson(res, 400, { error: '需要准确项目ID' }); return true }
      if (path.endsWith('/publish')) {
        if (Object.keys(body).some(key => key !== 'project_id')) { sendJson(res, 400, { error: '发布只读取真实来源,不接受正文或来源覆盖' }); return true }
        const result = await sources.publish(project)
        sendJson(res, result.status, result)
        return true
      }
      if (typeof body.enabled !== 'boolean' || !Number.isInteger(body.expected_version) || (body.expected_version as number) < 0 || !Array.isArray(body.recipients) || !Array.isArray(body.categories)
        || body.recipients.some(id => typeof id !== 'string' || id.trim() === '') || body.categories.some(c => !LAN_CHANNEL_CATEGORIES.includes(c as typeof LAN_CHANNEL_CATEGORIES[number]))) { sendJson(res, 400, { error: '需要开关、精确接收者、类别与当前策略版本' }); return true }
      const recipients = body.recipients.map(id => (id as string).trim()), paired = await lan.pairedMemberIds()
      if (recipients.some(id => !paired.includes(id))) { sendJson(res, 409, { error: '发布范围只能是本机已明确配对的成员,旧策略保留' }); return true }
      const result = await tasks.saveLanSourcePolicy({ project_id: project, enabled: body.enabled, expected_version: body.expected_version as number, recipients, categories: body.categories as (typeof LAN_CHANNEL_CATEGORIES[number])[] })
      if (result.ok) await deps.changed()
      sendJson(res, result.ok ? 200 : 409, result)
      return true
    }

    if (path.startsWith('/collab/lan/') && (path === '/collab/lan/connect' || path === '/collab/lan/receive' || path === '/collab/lan/channel/send')) {
      if (lan === undefined) { sendJson(res, 404, { error: '局域网传输未接入' }); return true }
      const got = path === '/collab/lan/connect'
        ? ctx.loopback ? await lan.connect(body) : { status: 403, error: '只能在本机页面配对协作成员' }
        : path === '/collab/lan/receive' ? await lan.receive(body, ctx.device) : await lan.send(body)
      await deps.changed()
      sendJson(res, got.status, got)
      return true
    }

    if (path === '/collab/types') {
      if (deps.workTypes === undefined) { sendJson(res, 404, { error: '事项类型表没接上' }); return true }
      const got = checkWorkTypes(body.types)
      if (!got.ok) { sendJson(res, 400, { error: got.error }); return true }
      try { await deps.workTypes.write(got.types) }
      catch (error) { sendJson(res, 500, { error: `类型表没存上:${error instanceof Error ? error.message : String(error)}` }); return true }
      await deps.changed()
      sendJson(res, 200, { ok: true, scope: 'local', types: got.types })
      return true
    }

    if (path === '/collab/canvas') {
      const layout = parseLayout(body.layout)
      const file = await deps.canvasFile()
      const state = await tasks.list()
      const goals = [...(state.goals ?? []).map(one => ({ id: one.id, title: one.title })), { id: UNSORTED_GOAL_ID, title: '未归目标' }]
      try { await writeBoardLayout(file, canvasFileOf(layout, { goals, notes: state.tasks.map(one => ({ id: one.id, title: one.title })) })) }
      catch (error) { sendJson(res, 500, { error: `板的摆法没存上:${error instanceof Error ? error.message : String(error)}` }); return true }
      sendJson(res, 200, { ok: true, file })
      return true
    }

    if (path === '/collab/goal/create') {
      const title = str(body.title)
      if (title === undefined) { sendJson(res, 400, { error: '目标要有一句话(title)' }); return true }
      const conditions = Array.isArray(body.conditions)
        ? body.conditions.flatMap((one): { text: string, taskId?: string, evidence?: string[] }[] => {
            if (typeof one !== 'object' || one === null) return []
            const raw = one as Record<string, unknown>
            const text = str(raw.text)
            if (text === undefined) return []
            return [{
              text,
              ...(str(raw.task_id) === undefined ? {} : { taskId: str(raw.task_id) as string }),
              ...(Array.isArray(raw.evidence) ? { evidence: raw.evidence.filter((item): item is string => typeof item === 'string') } : {}),
            }]
          })
        : undefined
      const made = await tasks.createGoal({
        title,
        ...(str(body.why) === undefined ? {} : { why: str(body.why) as string }),
        ...(str(body.due) === undefined ? {} : { due: str(body.due) as string }),
        ...(str(body.project_id) === undefined ? {} : { projectId: str(body.project_id) as string }),
        ...(str(body.version) === undefined ? {} : { version: str(body.version) as string }),
        ...(conditions === undefined ? {} : { conditions }),
      })
      if (!made.ok) { sendJson(res, made.reason?.includes('条件') === true ? 409 : 400, { error: made.reason ?? '没建成' }); return true }
      await deps.changed()
      sendJson(res, 200, { ok: true, id: made.id })
      return true
    }

    if (path === '/collab/goal/update') {
      const id = str(body.id)
      if (id === undefined) { sendJson(res, 400, { error: 'id 必须是非空字符串' }); return true }
      const status = body.status === 'open' || body.status === 'reached' || body.status === 'dropped' ? body.status : undefined
      if (body.status !== undefined && status === undefined) { sendJson(res, 400, { error: 'status 要是 open / reached / dropped(目标没有删除,不要了就 dropped)' }); return true }
      const ok = await tasks.updateGoal(id, {
        ...(typeof body.title === 'string' ? { title: body.title } : {}),
        ...(status === undefined ? {} : { status }),
        ...(nullable(body.why) === undefined ? {} : { why: nullable(body.why) as string | null }),
        ...(nullable(body.due) === undefined ? {} : { due: nullable(body.due) as string | null }),
        ...(nullable(body.project_id) === undefined ? {} : { projectId: nullable(body.project_id) as string | null }),
        ...(nullable(body.version) === undefined ? {} : { version: nullable(body.version) as string | null }),
      })
      if (!ok) { sendJson(res, 404, { error: '没有这个目标,或标题是空的' }); return true }
      await deps.changed()
      sendJson(res, 200, { ok: true })
      return true
    }

    // —— 目标能力条件与动态验收(2026-10-24 契约 §1;条件状态不落盘,读侧现算)。 ——
    if (path === '/collab/goal/condition/save') {
      const goalId = str(body.goal_id)
      // text 原样透传:空白由 service 拒(409),不是形状问题(400)。
      const text = typeof body.text === 'string' ? body.text : undefined
      if (goalId === undefined || text === undefined) { sendJson(res, 400, { error: 'goal_id 与 text 都要带' }); return true }
      if (body.task_id !== undefined && body.task_id !== null && typeof body.task_id !== 'string') { sendJson(res, 400, { error: 'task_id 要是字符串或 null(解绑)' }); return true }
      const saved = await tasks.saveGoalCondition({
        goalId, text,
        ...(str(body.id) === undefined ? {} : { id: str(body.id) as string }),
        ...(body.task_id === undefined ? {} : { taskId: body.task_id === null ? '' : (body.task_id as string).trim() }),
        ...(Array.isArray(body.evidence) ? { evidence: body.evidence.filter((one): one is string => typeof one === 'string') } : {}),
      })
      if (!saved.ok) { sendJson(res, saved.reason === undefined ? 404 : 409, { error: saved.reason ?? '没有这个目标' }); return true }
      await deps.changed()
      sendJson(res, 200, { ok: true, id: saved.id })
      return true
    }
    if (path === '/collab/goal/condition/remove') {
      const ok = await tasks.removeGoalCondition(str(body.goal_id) ?? '', str(body.condition_id) ?? '')
      if (!ok) { sendJson(res, 404, { error: '没有这个目标或这条条件' }); return true }
      await deps.changed()
      sendJson(res, 200, { ok: true })
      return true
    }
    if (path === '/collab/goal/condition/verify') {
      const goalId = str(body.goal_id)
      const conditionId = str(body.condition_id)
      const by = str(body.by)
      if (goalId === undefined || conditionId === undefined || by === undefined || typeof body.pass !== 'boolean') {
        sendJson(res, 400, { error: 'goal_id / condition_id / by / pass(布尔)都要带' })
        return true
      }
      const verified = await tasks.verifyGoalCondition(goalId, conditionId, { by, pass: body.pass, ...(str(body.note) === undefined ? {} : { note: str(body.note) as string }) })
      if (!verified.ok) { sendJson(res, verified.reason === undefined ? 404 : 409, { error: verified.reason ?? '没有这条条件' }); return true }
      await deps.changed()
      sendJson(res, 200, { ok: true })
      return true
    }
    if (path === '/collab/goal/condition/deliver') {
      const goalId = str(body.goal_id)
      const conditionId = str(body.condition_id)
      if (goalId === undefined || conditionId === undefined) { sendJson(res, 400, { error: 'goal_id 与 condition_id 都要带' }); return true }
      const delivered = await tasks.deliverGoalCondition(goalId, conditionId)
      if (!delivered.ok) { sendJson(res, delivered.reason === undefined ? 404 : 409, { error: delivered.reason ?? '没有这条条件' }); return true }
      await deps.changed()
      sendJson(res, 200, { ok: true })
      return true
    }

    // —— 留言 / 邀请(2026-10-24 契约 §2;client_msg_id 幂等,断网重发不重复派活)。 ——
    if (path === '/collab/note/message') {
      const taskId = str(body.task_id)
      const text = str(body.text)
      const intent = body.intent === 'ask' ? 'ask' : body.intent === 'record' ? 'record' : undefined
      if (taskId === undefined || text === undefined || intent === undefined) { sendJson(res, 400, { error: 'task_id / text / intent(record|ask)都要带' }); return true }
      const said = await tasks.message(taskId, {
        by: str(body.by) ?? 'me',
        text,
        intent,
        ...(str(body.client_msg_id) === undefined ? {} : { clientMsgId: str(body.client_msg_id) as string }),
        ...(Array.isArray(body.mentions) ? { mentions: body.mentions.filter((one): one is string => typeof one === 'string') } : {}),
        ...(str(body.reply_to) === undefined ? {} : { replyTo: str(body.reply_to) as string }),
      })
      if (!said.ok) { sendJson(res, said.reason === undefined ? 404 : 409, { error: said.reason ?? '没有这张便签' }); return true }
      // 幂等重发什么都没发生,不推快照。
      if (said.duplicated !== true && said.message !== undefined) {
        await deliverInvitations(tasks, taskId, said.message, deps.dispatch)
        const task = (await tasks.list()).tasks.find(t => t.id === taskId)
        const members = (said.message.deliveries ?? []).filter(d => d.to.startsWith('member:') && d.status === 'pending')
        if (members.length > 0) {
          const sent = lan === undefined || task?.project_id === undefined
            ? { status: 409, error: '没有同项目局域网投递路径' }
            : await lan.send({ id: said.message.id, client_msg_id: `${said.message.id}:lan`, project_id: task.project_id, text, recipients: members.map(d => d.to.slice('member:'.length)) })
          for (const delivery of members) {
            const outcome = 'message' in sent ? sent.message.deliveries?.find(d => `member:${d.to}` === delivery.to) : undefined
            await tasks.finishInvitation(taskId, said.message.id, delivery.to, { ok: outcome?.status === 'delivered', note: outcome?.error ?? ('error' in sent ? sent.error : undefined) ?? '投递结果未知' })
          }
        }
        await deps.changed()
      }
      sendJson(res, 200, { ok: true, message: (await tasks.list()).tasks.find(t => t.id === taskId)?.messages?.find(m => m.id === said.message?.id) ?? said.message, ...(said.duplicated === true ? { duplicated: true } : {}) })
      return true
    }

    // —— 任务关系(2026-10-24 契约 §3;画了线不自动执行)。 ——
    if (path === '/collab/relation/save') {
      const fromId = str(body.from_id)
      const toId = str(body.to_id)
      if (fromId === undefined || toId === undefined || !isTaskRelationKind(body.kind)) {
        sendJson(res, 400, { error: `from_id / to_id / kind 都要带,kind 是 ${TASK_RELATION_KINDS.join(' / ')} 之一` })
        return true
      }
      const saved = await tasks.saveRelation({ fromId, toId, kind: body.kind, ...(str(body.note) === undefined ? {} : { note: str(body.note) as string }) })
      if (!saved.ok) { sendJson(res, saved.reason === undefined ? 404 : 409, { error: saved.reason ?? '两张卡都要在账上' }); return true }
      await deps.changed()
      sendJson(res, 200, { ok: true, id: saved.id })
      return true
    }
    if (path === '/collab/relation/remove') {
      const ok = await tasks.removeRelation(str(body.id) ?? '')
      if (!ok) { sendJson(res, 404, { error: '没有这条关系' }); return true }
      await deps.changed()
      sendJson(res, 200, { ok: true })
      return true
    }

    // —— 本机局域网身份(契约 §5):归一查重、乐观并发、成员列表不完整不让你改。 ——
    if (path === '/collab/lan/identity') {
      const name = str(body.name)
      if (name === undefined) { sendJson(res, 400, { error: 'name 必须是非空字符串' }); return true }
      const saved = await tasks.saveLanIdentity({
        name,
        ...(body.avatar === undefined ? {} : { avatar: nullable(body.avatar) as string | null }),
        ...(typeof body.expected_version === 'number' && Number.isInteger(body.expected_version) ? { expectedVersion: body.expected_version } : {}),
        ...(body.members_refreshed === true ? { membersRefreshed: true } : {}),
      })
      if (!saved.ok) {
        sendJson(res, 409, {
          error: saved.reason ?? '没存上',
          ...(saved.conflict_with === undefined ? {} : { conflict_with: saved.conflict_with }),
          ...(saved.identity === undefined ? {} : { identity: saved.identity }),
          ...(saved.availability === undefined ? {} : { availability: saved.availability }),
        })
        return true
      }
      await deps.changed()
      sendJson(res, 200, { ok: true, identity: saved.identity })
      return true
    }

    // —— 成员登记(契约 §5):按 member_id 归并,稳定 id 不因改名丢关联。 ——
    if (path === '/collab/lan/members/remember') {
      const memberId = str(body.member_id)
      const name = str(body.name)
      const host = str(body.host)
      const port = typeof body.port === 'number' && Number.isInteger(body.port) && body.port >= 1 && body.port <= 65535 ? body.port : undefined
      if (memberId === undefined || name === undefined || host === undefined || port === undefined) {
        sendJson(res, 400, { error: 'member_id / name / host / port(1–65535 的整数)都要带' })
        return true
      }
      const ok = await tasks.rememberLanMember({ memberId, name, host, port })
      if (!ok) { sendJson(res, 400, { error: '成员的字段不对,没登记上' }); return true }
      await deps.changed()
      sendJson(res, 200, { ok: true })
      return true
    }

    if (path === '/collab/sprint/save') {
      const saved = await tasks.saveGoalSprint({
        ...(str(body.id) === undefined ? {} : { id: str(body.id) as string }),
        ...(typeof body.title === 'string' ? { title: body.title } : {}),
        ...(nullable(body.start) === undefined ? {} : { start: nullable(body.start) as string | null }),
        ...(nullable(body.end) === undefined ? {} : { end: nullable(body.end) as string | null }),
        ...(Array.isArray(body.goal_ids) ? { goalIds: body.goal_ids.filter((one): one is string => typeof one === 'string') } : {}),
      })
      if (!saved.ok) { sendJson(res, 400, { error: saved.reason ?? '没存上' }); return true }
      await deps.changed()
      sendJson(res, 200, { ok: true, id: saved.id })
      return true
    }

    if (path === '/collab/agent/save') {
      const shared = typeof body.shared === 'object' && body.shared !== null ? body.shared as Record<string, unknown> : undefined
      // 四样(2026-10-22,卡「名片补四样与Kimi命令行手」):命令行 / 仓库 / 模型与强度 / 智能体文件。
      // 形状不对回 400 + 原话(与现有字段同样写法);null = 清掉这一格。
      const runtime = cardRuntimeInput(body.runtime)
      if (runtime === INVALID) { sendJson(res, 400, { error: 'runtime 要是 { family: 哪家命令行, bin?: 可执行文件 } 那样,bin 缺省自动找' }); return true }
      const project = cardProjectInput(body.project)
      if (project === INVALID) { sendJson(res, 400, { error: 'project 要是 { repo: 仓库本地路径 } 那样' }); return true }
      const model = cardModelInput(body.model)
      if (model === INVALID) { sendJson(res, 400, { error: 'model 要是 { name?: 模型名, effort?: low / medium / high } 那样' }); return true }
      const instructions = nullable(body.instructions)
      if (body.instructions !== undefined && instructions === undefined) { sendJson(res, 400, { error: 'instructions 要是字符串(智能体文件,相对仓库;缺省 docs/卡/agents/kimi-coder.md)' }); return true }
      const cardBudget = cardBudgetInput(body.budget)
      if (cardBudget === INVALID) { sendJson(res, 400, { error: 'budget 要是 { minutes: 1 到 1440 之间的分钟数 } 那样(命令行家缺省 120,空着不填就不限到缺省)' }); return true }
      // 勾的技能存在(2026-10-22,卡「用户层技能生效」B):本体 ∪ 用户层,两边都没有的当场 400。
      if (deps.skillNames !== undefined && Array.isArray(body.skills)) {
        const picked = body.skills.filter((one): one is string => typeof one === 'string').map(one => one.trim()).filter(one => one !== '')
        if (picked.length > 0) {
          const known = await deps.skillNames()
          const unknown = picked.filter(one => !known.includes(one))
          if (unknown.length > 0) { sendJson(res, 400, { error: `不认得的技能:${unknown.join('、')}(能勾的是 ${known.join(' / ')})` }); return true }
        }
      }
      const saved = await tasks.saveAgentCard({
        ...(str(body.id) === undefined ? {} : { id: str(body.id) as string }),
        ...(typeof body.name === 'string' ? { name: body.name } : {}),
        ...(typeof body.hand === 'string' ? { hand: body.hand } : {}),
        ...(runtime === undefined ? {} : { runtime }),
        ...(project === undefined ? {} : { project }),
        ...(model === undefined ? {} : { model }),
        ...(instructions === undefined ? {} : { instructions }),
        ...(cardBudget === undefined ? {} : { budget: cardBudget }),
        ...(nullable(body.good_at) === undefined ? {} : { goodAt: nullable(body.good_at) as string | null }),
        ...(Array.isArray(body.skills) ? { skills: body.skills.filter((one): one is string => typeof one === 'string') } : {}),
        ...(Array.isArray(body.mcp) ? { mcp: body.mcp.filter((one): one is string => typeof one === 'string') } : {}),
        ...(shared === undefined
          ? {}
          : {
              shared: {
                to: shared.to === 'workspace' ? 'workspace' : shared.to === 'members' ? 'members' : 'none',
                ...(Array.isArray(shared.members) ? { members: shared.members.filter((one): one is string => typeof one === 'string') } : {}),
                ...(Array.isArray(shared.repos) ? { repos: shared.repos.filter((one): one is string => typeof one === 'string') } : {}),
                ...(typeof shared.budget_per_day === 'number' ? { budget_per_day: shared.budget_per_day } : {}),
              } satisfies AgentCard['shared'],
            }),
      })
      if (!saved.ok) { sendJson(res, 400, { error: saved.reason ?? '没登记上' }); return true }
      await deps.changed()
      sendJson(res, 200, { ok: true, id: saved.id })
      return true
    }

    if (path === '/collab/session/attach' || path === '/collab/session/dismiss' || path === '/collab/session/placed') {
      const agent = typeof body.agent === 'string' && (AGENT_IDS as readonly string[]).includes(body.agent) ? body.agent as AgentId : undefined
      const sessionId = str(body.session_id)
      if (agent === undefined || sessionId === undefined) { sendJson(res, 400, { error: 'agent 与 session_id 都要带' }); return true }
      const key = `${agent}:${sessionId}`
      if (path === '/collab/session/dismiss') {
        await tasks.dismissProposal(key)
        await deps.changed()
        sendJson(res, 200, { ok: true })
        return true
      }
      /*
       * 直接放进去的那一条(10-22 第三轮 4,维护者定):「等你」里那行已办说明的三颗键。
       *   move   换目标:便签改到另一个目标(或新建目标),说明划掉;
       *   remove 不进看板:撤掉这张便签,这条会话以后不再问;
       *   ack    他点开看过:只划掉说明。
       */
      if (path === '/collab/session/placed') {
        const action = body.action
        if (action !== 'move' && action !== 'remove' && action !== 'ack') { sendJson(res, 400, { error: 'action 只认 move / remove / ack' }); return true }
        const placed = (await tasks.list()).tasks.find((one: TaskView) => (one.links ?? []).some(link => link.agent === agent && link.session_id === sessionId))
        if (action === 'move') {
          if (placed === undefined) { sendJson(res, 404, { error: '那张便签已经不在了' }); return true }
          const goalId = await goalFor(tasks, body)
          if (!goalId.ok) { sendJson(res, 400, { error: goalId.error }); return true }
          if (!(await tasks.update(placed.id, { goalId: goalId.id ?? null }))) { sendJson(res, 400, { error: '没换成' }); return true }
        }
        if (action === 'remove') {
          if (placed !== undefined) await tasks.remove(placed.id)
          await tasks.dismissProposal(key)
        }
        await tasks.setPlacedNotice(key, false)
        await deps.changed()
        sendJson(res, 200, { ok: true })
        return true
      }
      const placed = await placeSession(tasks, { agent, sessionId, body })
      if (!placed.ok) { sendJson(res, 400, { error: placed.error }); return true }
      if (placed.already !== true) await deps.changed()
      sendJson(res, 200, { ok: true, id: placed.id, ...(placed.already === true ? { already: true } : {}), ...(placed.goalId === undefined ? {} : { goal_id: placed.goalId }) })
      return true
    }

    // —— 小队 ——
    if (path === '/collab/squad/save') {
      const saved = await tasks.saveSquad({
        ...(str(body.id) === undefined ? {} : { id: str(body.id) as string }),
        ...(typeof body.name === 'string' ? { name: body.name } : {}),
        ...(typeof body.leader === 'string' ? { leader: body.leader } : {}),
        ...(Array.isArray(body.members) ? { members: body.members.filter((one): one is string => typeof one === 'string') } : {}),
      })
      if (!saved.ok) { sendJson(res, 400, { error: saved.reason ?? '没存上' }); return true }
      await deps.changed()
      sendJson(res, 200, { ok: true, id: saved.id })
      return true
    }
    if (path === '/collab/squad/remove') {
      const ok = await tasks.removeSquad(str(body.id) ?? '')
      if (!ok) { sendJson(res, 404, { error: '没有这个小队' }); return true }
      await deps.changed()
      sendJson(res, 200, { ok: true })
      return true
    }

    // —— 定时派活 ——
    if (path === '/collab/timer/save') {
      const tpl = typeof body.template === 'object' && body.template !== null ? body.template as Record<string, unknown> : undefined
      const saved = await tasks.saveTimer({
        ...(str(body.id) === undefined ? {} : { id: str(body.id) as string }),
        ...(typeof body.name === 'string' ? { name: body.name } : {}),
        ...(typeof body.trigger === 'object' && body.trigger !== null ? { trigger: body.trigger as never } : {}),
        ...(typeof body.assignee === 'string' ? { assignee: body.assignee } : {}),
        ...(tpl === undefined
          ? {}
          : {
              template: {
                title: typeof tpl.title === 'string' ? tpl.title : '',
                ...(str(tpl.goal_id) === undefined ? {} : { goal_id: str(tpl.goal_id) as string }),
                acceptance: Array.isArray(tpl.acceptance) ? tpl.acceptance.filter((one): one is string => typeof one === 'string') : [],
              },
            }),
        ...(typeof body.enabled === 'boolean' ? { enabled: body.enabled } : {}),
      })
      if (!saved.ok) { sendJson(res, 400, { error: saved.reason ?? '没存上' }); return true }
      await deps.changed()
      sendJson(res, 200, { ok: true, id: saved.id })
      return true
    }
    if (path === '/collab/timer/remove') {
      const ok = await tasks.removeTimer(str(body.id) ?? '')
      if (!ok) { sendJson(res, 404, { error: '没有这条定时派活' }); return true }
      await deps.changed()
      sendJson(res, 200, { ok: true })
      return true
    }
    if (path === '/collab/timer/run') {
      if (deps.timers === undefined) { sendJson(res, 404, { error: '定时派活没接上' }); return true }
      const ran = await deps.timers.runNow(str(body.id) ?? '')
      await deps.changed()
      sendJson(res, ran.ok ? 200 : 409, ran.ok ? { ok: true, note_id: ran.note_id } : { error: ran.why ?? '没跑成', ...(ran.note_id === undefined ? {} : { note_id: ran.note_id }) })
      return true
    }

    // —— 工作室 MCP 库:条目进账,密钥值只在本机(只认本机页面填) ——
    if (path === '/collab/mcp/save') {
      const saved = await tasks.saveMcp({
        ...(str(body.id) === undefined ? {} : { id: str(body.id) as string }),
        ...(typeof body.name === 'string' ? { name: body.name } : {}),
        ...(typeof body.url_template === 'string' ? { url_template: body.url_template } : {}),
        ...(Array.isArray(body.secret_names) ? { secret_names: body.secret_names.filter((one): one is string => typeof one === 'string') } : {}),
      })
      if (!saved.ok) { sendJson(res, 400, { error: saved.reason ?? '没存上' }); return true }
      await deps.changed()
      sendJson(res, 200, { ok: true, id: saved.id })
      return true
    }
    if (path === '/collab/mcp/remove') {
      const ok = await tasks.removeMcp(str(body.id) ?? '')
      if (!ok) { sendJson(res, 404, { error: '没有这一条' }); return true }
      await deps.changed()
      sendJson(res, 200, { ok: true })
      return true
    }
    if (path === '/collab/mcp/secret') {
      if (deps.mcpSecrets === undefined) { sendJson(res, 404, { error: '本机密钥存放没接上' }); return true }
      if (!ctx.loopback || !ctx.page) { sendJson(res, 403, { error: '密钥只能在这台电脑的页面上填' }); return true }
      const name = str(body.name)
      if (name === undefined || !SECRET_NAME.test(name)) { sendJson(res, 400, { error: '密钥名只许字母、数字、下划线' }); return true }
      await deps.mcpSecrets.set(name, typeof body.value === 'string' ? body.value : null)
      await deps.changed()
      // 只回填没填,不回值。
      sendJson(res, 200, { ok: true, filled: (await deps.mcpSecrets.names()).has(name) })
      return true
    }

    if (path === '/collab/migrate') {
      const ran = await tasks.migrateToGoals()
      await deps.changed()
      sendJson(res, 200, ran)
      return true
    }
    if (path === '/collab/migrate/rollback') {
      const back = await tasks.rollbackGoals()
      if (!back.ok) { sendJson(res, 409, { error: '没迁过,或者已经回退过了', ...back }); return true }
      await deps.changed()
      sendJson(res, 200, back)
      return true
    }

    sendJson(res, 404, { error: `不认识的协作区操作:${path}` })
    return true
  }
  return { handle, pumpSources: async () => { await sources?.pump() } }
}
