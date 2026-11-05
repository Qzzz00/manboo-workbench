/**
 * 「此刻有几件在跑」—— 全工作台只有这一个函数数它(2026-09-25,卡 V;做法照卡 M 的 `waiting.ts`)。
 *
 * 维护者 09-25 21:00 的原话:「实际一个会话在跑,从事务官的卡片,再到气泡,都不对」。
 * 五处各数各的:
 *   - 舞台「正在执行 n」/ 球下「执行 n」:`buildButlerScene` 里 `items.filter(item => item.executing).length`;
 *   - 窗口槽 Claude 标签上的白色气泡:`DockTabBar.tabBadges` 自己 `sessions.filter(s => s.status === 'running')`;
 *   - 汇报条「运行会话 n 个」:转述球下那个数;
 *   - 手机首页「正在办」:再数一遍。
 * 探针一进来,按 `status === 'running'` 过滤那两处多数两个,而按事项数的那一处不多 —— 同一刻两个数。
 *
 * 现在:**服务端拼 /state 时用这个函数算好放进 `state.running`**,上面五处都读那一格。
 *
 * 数的是什么(两类,合起来不重不漏):
 * 1. **事务官的事项**里真有人在动的(`isItemExecuting`,2026-09-16 定的口径:`direction:'mine'`、
 *    `doing`、挂的会话里至少一条 `running`、那家在线、快照没冻结);
 * 2. **各家客户端里在跑、又没挂在任何一张事项上**的会话(2026-09-25 卡 P 的 `externalRunningSessions` 口径)。
 *
 * 不数的:
 * - `agent === 'dsh'` 的散会话(事务官自己的会话都是某张事项底下那一段,挂在事项上才算数);
 * - **工作台自己起的会话**(`session.selfcheck`:能力体检、派活探针、统筹自测)—— 卡 V 的正题;
 * - 等你 / 跑完 / 出错 / 中断的(它们在各家标签的别的档上)。
 *
 * 放在 `src/` 根上(不在 client/ 里):服务端 import 不了客户端(同 `waiting.ts` / `protocol.ts` 的理由)。
 */
import { isItemExecuting, isTrackedItem, sessionBusy, type RunningItemView, type RunningView, type SelfcheckView, type SessionChildView, type SessionStatus, type WorkbenchState } from './protocol.ts'
// 「这条会话」这件事的键只有一处定法(2026-10-03,卡「两条接缝」):`server/jobKey.ts` 是纯叶子
// (只有一个 type import),两半都 import 得起。
import { sessionJobId } from './server/jobKey.ts'

export type RunningSource = Pick<WorkbenchState, 'sessions' | 'agents' | 'tasks' | 'butler_inbox' | 'stale'> & Pick<Partial<WorkbenchState>, 'agent_registry' | 'execution'>

const keyOf = (reference: { agent: string, session_id: string }): string => JSON.stringify([reference.agent, reference.session_id])

/**
 * 这条会话该被他看见吗(2026-09-25,卡 V)。**工作台自己起的不算他的** ——
 * 舞台、会话列表、气泡、「执行」都按这一条筛。要看自检记录去设置里那一格。
 */
export function isHisSession(session: { selfcheck?: SelfcheckView | undefined }): boolean {
  return session.selfcheck === undefined
}

/**
 * 「在办」要看的一条会话最少得有这几格。写成这样是为了**电脑与手机、登记表与老会话流共用同一个筛子**。
 * `agent` 是 `string` 而不是固定那几家(卡 P 的规矩:哪一家按字符串处理 —— 卡 Q 自动发现的新家也要数得到)。
 */
export interface BusySession {
  agent: string
  session_id: string
  status: SessionStatus
  updated_at: string
  selfcheck?: SelfcheckView | undefined
  children?: readonly Pick<SessionChildView, 'status'>[] | undefined
}

/**
 * **各家的会话**(2026-09-25,卡 Q 的 Agent 登记表;老服务端没有登记表时退回会话流)。
 * 事务官自己(`dsh` / `self`)的不算 —— 她的会话都是某张事项底下那一段,挂在事项上才算数。
 *
 * 与 `client/agentRegistryView.ts` 的 `registrySessions` 同一个意思。这里再写一遍**不是重复**:
 * 服务端(拼 `/state` 的那一半)import 不了 `client/`(同 `waiting.ts` / `protocol.ts` 的理由),
 * 而「执行 n」必须由服务端算好一份给两端读。筛子只有下面 `unlinkedBusySessions` 一个。
 */
function agentSessionsOf(state: RunningSource): readonly BusySession[] {
  const entries = state.agent_registry?.entries
  if (entries === undefined) return state.sessions.filter(session => session.agent !== 'dsh')
  return entries.filter(entry => entry.self !== true && entry.id !== 'dsh').flatMap(entry => entry.sessions)
}

/**
 * 各家客户端里此刻**在办**、又没挂在任何一张事项上的会话 —— **全工作台唯一的那个筛子**。
 *
 * 三条判据合起来:
 * - **在办**(卡 Q 的 `sessionBusy`):它自己在跑,或者底下有后台任务在跑 / 在等你。
 *   **子任务不单独数** —— 主会话只算这一次(维护者:「一张卡片里有后台任务的说明,就是多一层的意思」);
 * - **是他的**(卡 V 的 `isHisSession`):能力体检 / 派活探针 / 统筹自测那几条不算;
 * - **没挂在事项上**:去重认**事项**(`isTrackedItem`:他交给事务官的、看板上写了负责人的 —— 卡 N)卡上的
 *   `links` 与 `conversation` —— 派出去、在那家跑着的同一件事只数一次。没写负责人的看板卡挂着的会话
 *   不算「挂上了」:那张卡不在事务官这一屏上,不单独摆出来就等于看不见。
 *
 * `sessions` 由调用方给(电脑舞台给登记表摊平的那一份,服务端给 `agentSessionsOf` 的那一份)——
 * **筛法只有这一处**,免得两边各写一遍再走漂。
 */
export function unlinkedBusySessions<T extends BusySession>(state: Pick<RunningSource, 'tasks'>, sessions: readonly T[]): T[] {
  const linked = new Set<string>()
  for (const task of state.tasks?.tasks ?? []) {
    if (!isTrackedItem(task)) continue
    for (const link of task.links ?? []) linked.add(keyOf(link))
    if (task.conversation) linked.add(keyOf(task.conversation))
  }
  return sessions
    .filter(session => sessionBusy(session) && isHisSession(session) && !linked.has(keyOf(session)))
    .slice()
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
}

/** 服务端那一份:登记表摊平之后过同一个筛子。 */
export function unlinkedRunningSessions(state: RunningSource): readonly BusySession[] {
  return unlinkedBusySessions(state, agentSessionsOf(state))
}

/** 一条会话在气泡里那一行:标题(没有就那家的 id)。这里不带时长 —— 时长各处的写法不同,由界面加。 */
function sessionText(session: BusySession & { title?: string }): string {
  return session.title ?? `${session.agent} 的一条会话`
}

/**
 * 算「此刻有几件在跑」。数不出来时 `count` 缺席(不填 0):
 * 快照冻结(`stale`)、或者任务板 / 收件箱这一轮没给 —— 与 `ButlerInboxView.executing` 同一条纪律。
 */
export function runningNow(state: RunningSource): RunningView {
  if (state.execution !== undefined) {
    const present = (item: typeof state.execution.items[number]): RunningItemView => {
      const source = item.sources.find(one => one.role === 'business' && one.state === 'running') ?? item.sources.find(one => one.state === 'running')
      return { key: `task:${item.task_id}`, task_id: item.task_id, text: item.title,
        role: item.role, role_origin: item.role_origin, execution_state: item.state, sources: item.sources,
        agent: source?.provider ?? 'unknown', ...(source === undefined ? {} : { session_id: source.session_id }) }
    }
    const items = state.execution.items.filter(item => item.role === 'business' && item.state === 'running').map(present)
    const excluded = state.execution.items.filter(item => item.role !== 'business' && item.state !== 'completed' && item.state !== 'canceled').map(present)
    return { scope: 'classified_business_tasks', observed_count: items.length, excluded,
      ...(state.execution.complete && !state.stale ? { count: items.length } : {}), items }
  }
  const items: RunningItemView[] = []
  const countable = !state.stale && state.tasks !== undefined && state.butler_inbox !== undefined
  for (const task of state.tasks?.tasks ?? []) {
    if (!isItemExecuting(task, state)) continue
    // 这件事底下在跑的那条会话(拿第一条:「几件在跑」数的是事,不是会话)。
    const link = (task.links ?? []).find((one) => {
      const session = state.sessions.find(s => s.agent === one.agent && s.session_id === one.session_id)
      return session?.status === 'running'
    })
    items.push({
      key: `task:${task.id}`,
      agent: link?.agent ?? 'dsh',
      ...(link === undefined ? {} : { session_id: link.session_id }),
      task_id: task.id,
      text: task.title,
    })
  }
  for (const session of unlinkedRunningSessions(state)) {
    items.push({ key: sessionJobId(session.agent, session.session_id), agent: session.agent, session_id: session.session_id, text: sessionText(session) })
  }
  return { ...(countable ? { count: items.length } : {}), items }
}

/** 两端读的那一份:服务端给了就用它(手机与电脑同一份),老服务没给就用同一个函数就地算。 */
export function runningOf(state: RunningSource & Pick<WorkbenchState, 'running'>): RunningView {
  return state.running ?? runningNow(state)
}
