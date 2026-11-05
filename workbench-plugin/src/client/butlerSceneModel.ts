import { businessExecutionView } from './businessExecutionModel.ts'
import type { AgentEntryView, AgentSessionView, ButlerInboxItem, OwnerAsk, SessionChildView, SessionView, TaskProgressView, TaskView, WorkbenchState } from '../protocol.ts'
import {
  AGENT_NEUTRAL_COLOR, SESSION_ACTIVITY_UNKNOWN, WAIT_REASON_TITLES, ownerAskOf,
  isItemExecuting, isItemPending, isTrackedItem, sessionActivityLine, sessionBusy, sessionDisplayTitle,
} from '../protocol.ts'
// 「执行 n」全工作台一份 + 「这条会话是他的吗」(2026-09-25,卡 V,src/running.ts)。
import { isHisSession, runningOf, unlinkedBusySessions } from '../running.ts'
// 卡上那一问怎么说(「等你选:…」)与「等你」那一堆同一份措辞(src/waiting.ts)。
import { SESSION_ASK_HEAD } from '../waiting.ts'
// 「这条会话」这件事的键只有一处定法(2026-10-03,卡「两条接缝」),见 server/jobKey.ts 文件头。
import { sessionJobId } from '../server/jobKey.ts'
import { agentName, registryEntries, type RegistryState } from './agentRegistryView.ts'
import { inboxCard, mineCard, proposalCard, type StackCard } from './orb.ts'
import { callOutLine } from './callOutLine.ts'
import type { Proposal } from './proposals.ts'

/** 台上一张卡挂着的那条会话:与 `SessionView` 同形,只是 `agent` 按字符串(登记表里的 id)。 */
export type SceneSession = Omit<SessionView, 'agent'> & { agent: string }

export type ParticleNotice = 'neutral' | 'confirmation' | 'completed' | 'failed'
export type SceneGroup = 'working' | 'queued' | 'confirmation' | 'completed' | 'attention' | 'canceled'
export type SceneRead = Readonly<Record<string, string>>
export interface SceneItem extends StackCard {
  group: SceneGroup
  notice: ParticleNotice
  version: string
  unread: boolean
  /** Active execution is independent of attention grouping; queued/terminal tasks never count. */
  executing: boolean
  /**
   * 这一件此刻**卡住了**(2026-10-04,运营同学交回的那一版:卡住的那几件要数出来,不要染红主球)。
   *
   * 判据与 `group === 'attention'` 里事项那一支逐字相同(卡上标「阻塞」那几种:
   * `task.status === 'blocked'`、出错、在等某家回来),所以球下「受阻 N」与台上那几张卡永远对得上。
   * 不是事项的那几张(收件箱事件、提议、别家会话卡)一律 `false` —— 它们该不该计入由各自的
   * `notice === 'failed'` 说了算(见 {@link ButlerSceneModel.blocked})。
   */
  blocked: boolean
  /**
   * 排队(2026-09-16):建好了、会话还没开出来的那几秒(protocol.ts 的 isItemPending)。
   * 台上画一条虚线、标「排队」;不算执行。窗口一过或卡上有话(「会话未开」)就只是一张待办。
   */
  pending: boolean
  /** 交付物里那条回答(2026-09-16):会话答完时服务端挂上的 `reply`。有就在聚焦详情里给他看。 */
  reply?: string
  /**
   * 「打过电话:已接 14:03」(2026-09-21,座机主动来电)。**只转述 /state.call_out 的台账**,
   * 不自己判断(见 client/callOutLine.ts)。没打过 / 还排着 / 这台机器没接主动来电都不写字。
   */
  callOut?: string
  description?: string
  executors: { id: string, label: string, session?: SceneSession, offline: boolean }[]
  /**
   * 这一张不是事务官的事项,是**某家客户端里此刻在跑的一条会话**(2026-09-25,维护者:
   * 「codex 和 Claude 都有会话在跑,它说 0 执行」)。它照样摆在球周围、照样数进「执行 n」;
   * 点开只看得到那条会话的标题与进度,没有「打开对话」(那条会话不在 DSH 里)。
   */
  external?: {
    /** 登记表里的 id(按字符串,运行时新接上的一家也在这里)。 */
    agent: string
    session_id: string
    /** 那一家叫什么(登记表里的名字)。 */
    name: string
    /** 这条会话从哪一路来:专门的会话记录,还是读它的窗口(读窗口的没有「最近几轮」)。 */
    via?: AgentSessionView['via']
  }
  /**
   * 卡上标题下面那一行:在做什么(2026-09-25,卡 P;维护者:「事务官中并没有显示会话的标题和内容」)。
   * 挂着的那条会话最近在做什么 · 几分钟前;读不到就「读不到它在做什么」——**不写占位话**
   * (以前写死「等待下一次进度回传」)。组装时就用 /state.now 算好,台上的卡与点开的详情同一句。
   */
  progress: string
  /**
   * 证据里冒出来的下一步(2026-09-25 卡 N):进度核对建成的「待排」卡,在「待确认」里问「要加上吗」。
   * 有它就画「加上 / 不要」,不画「确认」。
   */
  proposalTaskId?: string
  /**
   * 要本人拍板的四类请求(2026-10-26,卡「事务官页接管队列」):**只有带它的事项才给「确认」键**;
   * 章在「等我确认」、没带它的是事务官待核验队列,只摆「事务官核验中」。与卡上 `owner_ask` 同一份。
   */
  ownerAsk?: OwnerAsk
  /**
   * 这件事现在到哪 · 依据 · 什么时候看的(卡 N 进度核对,按证据核的;与上面卡 P 那一行「会话在做什么」是两件事)。没核过缺席。
   */
  evidence?: TaskProgressView
  /**
   * 这条会话底下的后台任务(2026-09-25,卡 Q;维护者:「一张卡片里有后台任务的说明,就是多一层的意思」)。
   * 卡上多一行「内含 N 项后台任务 · 在跑 x · 等你 y」,点开详情才一项一行;它们**不单独成卡、不单独算执行**。
   */
  children?: readonly SessionChildView[]
  /**
   * 台上这张卡画的是**一条会话**(2026-09-26,卡 ST)。
   *
   * 维护者 09-26 19:10:「Grok Bot 的标题显示不全,Muse 那个待确认的也不在上面显示,我发的任务随机抽查
   * 大部分都没变成卡片在事务官那一页展示出来」;19:20 拍板:「机器上正在跑的、我安排的事,不管是通过
   * 事务官发的还是直接在那家客户端里说的,就是一张卡。」—— 所以台上的卡按**会话**画,事项板上有没有登记不影响它成卡。
   *
   * 有这一格的卡由 {@link sessionStageCard} 造;事项那几张卡没有这一格(它们照旧按事项画,状态字还是「进行中 · n 分钟」)。
   */
  sessionCard?: StageSessionCard
}

/** 台上一张「会话卡」上写什么(2026-09-26,卡 ST)。 */
export interface StageSessionCard {
  /** 登记表里那一家的 id。 */
  agent: string
  /** 那一家叫什么(登记表里的名字)。 */
  name: string
  /** 它的 logo 取到了没(取到画 `AgentIcon`,没取到退回卡通小头像)。 */
  icon: boolean
  /** 那一家自己的颜色。 */
  tint: string
  /** 状态字:在跑 / 等你 / 做完 · 未读 / 出错 / 空闲。 */
  status: string
  /** 状态那一档(染色、读屏用)。 */
  tone: 'running' | 'ask' | 'unread' | 'failed' | 'idle'
  /** 这条会话最后一句(**整句**,界面上折两行、点「展开」摊开;窗口那一路本来就只存 120 字)。 */
  latest?: string
  /** 停着在等他的那一问:「等你选」+ 那一句(整句)。 */
  ask?: { head: string, question: string, quote?: string }
  /** 挂在哪张事项上 —— 挂了才有(事项只是**挂件**,没挂的照样是卡)。 */
  item?: { id: string, title: string }
  /** 文件型的会话,还是窗口型的一条对话。 */
  via?: AgentSessionView['via']
}

export interface ButlerSceneModel {
  items: SceneItem[]
  groups: Record<SceneGroup, SceneItem[]>
  /**
   * 台上要画的那几张卡(2026-09-26,卡 ST):**在办 / 排队的事项** + **每一条会话各一张**
   * (文件型 `/state.sessions` 每条 + 窗口型每条对话)。挂在台上某张事项上的会话不再单独成卡 ——
   * 那张事项卡就是它这一张(否则同一件事两张卡)。
   *
   * 「正在执行 n」那行数字**不数这一份**:它读 `/state.running` / `waiting`(见 {@link ButlerSceneModel.running})。
   */
  stage: SceneItem[]
  running: number | undefined
  notice: ParticleNotice
  /**
   * 「受阻 N」那个数(2026-10-04):卡住 / 没做成的那几件有多少。
   *
   * 这一版之前,历史上出过错的那几件会让主球**一直红着** —— 她早上开机看见一颗红球,
   * 点进去是上周那件已经放下的事。维护者 10-04 拍板:红只留给**此刻台上正在执行的那件出错**
   * (见 {@link orbNoticeOf}),历史阻塞改成球下那一行的一个数,看得见、但不占实时警报色。
   */
  blocked: number
  frozen: boolean
}
export function readSceneItem(read: SceneRead, item: SceneItem): SceneRead { return { ...read, [item.id]: item.version } }

/**
 * 台上哪几张会话卡**卡面上已经写着那一问**(2026-09-27,卡 DD:同一件「等你」只摆一处,拍板留球旁的卡)。
 *
 * 回来的键与「等你」那一堆里会话那几条的键同形(`jobKey.sessionJobId` 那一种,见 server/jobKey.ts),
 * 所以球下那一区拿它一减就知道哪一件已经在屏幕上出现过。**只认会话卡**:
 *   - 事项卡没有 `sessionCard`(卡面写的是「进行中 · n 分钟」,不写那一问)—— 那一问还没出现过,球下照旧摆;
 *   - 台上摆不下、被 {@link STAGE_SESSION_CARDS_MAX} 截掉的那几条不在 `stage` 里,自然也不在这一份里。
 */
export function stageAskKeys(stage: readonly SceneItem[]): ReadonlySet<string> {
  return new Set(stage.filter(item => item.sessionCard?.ask !== undefined).map(item => item.id))
}
const sessionKey = (reference: { agent: string, session_id: string }) => JSON.stringify([reference.agent, reference.session_id])
/** Stable output evidence only: polling clocks and read markers cannot create a new notification. */
const sessionVersion = (session: SceneSession | undefined) => session && [session.updated_at, session.status, session.wait_reason, session.reason, session.title, session.summary]

/**
 * 那一家叫什么(球周围那张卡上写「Codex · …」):**Agent 登记表里的名字**(2026-09-25,卡 Q);
 * 不在表里就原样用它的 id(卡 P 定的规矩:按字符串处理、不收窄成固定几家)。界面里不再有名字表。
 */
export function agentTitle(agent: string, state?: RegistryState): string {
  return agentName(state, agent)
}

/**
 * 一张卡「在做什么」那一行(2026-09-25,卡 P)。按可信度:
 * 1. 还没开出会话 →「会话开启中」;
 * 2. 挂着的会话里**在跑的那条**最近在做什么(有就用,带「· 几分钟前」);
 * 3. 这张是某家客户端里的一条会话 → 它最近在做什么;读不到就「读不到它在做什么」;
 * 4. 事项自己的:会话最后那段回答 / 事项描述 / 卡上的话;都没有也写「读不到它在做什么」。
 */
export function sceneProgressLine(item: Pick<SceneItem, 'pending' | 'executors' | 'external' | 'description' | 'note'>, now: string): string {
  if (item.pending) return '会话开启中'
  const running = item.executors.find(executor => executor.session?.status === 'running' && executor.session.activity !== undefined)?.session
  if (running?.activity !== undefined) return sessionActivityLine(running.activity, now)
  if (item.external !== undefined) return sessionActivityLine(item.executors[0]?.session?.activity, now)
  const withActivity = item.executors.find(executor => executor.session?.activity !== undefined)?.session
  if (withActivity?.activity !== undefined) return sessionActivityLine(withActivity.activity, now)
  return item.executors.find(executor => executor.session?.summary)?.session?.summary ?? item.description ?? item.note ?? SESSION_ACTIVITY_UNKNOWN
}

/**
 * 各家客户端里**此刻在跑**、又**没挂在任何一张事项上**的会话(2026-09-25)。**哪几家 = Agent 登记表**(卡 Q):
 * 读窗口读出来的那几家(Muse、Manus、豆包……)与有会话记录的那几家走同一条路,都数进「执行 n」。
 *
 * - 只数 `running`:等你 / 跑完 / 出错的不算「正在办」(它们在各家标签的角标上)。
 * - 不数 dsh:事务官自己的会话都是某张事项底下那一段(一事项一会话),挂在事项上才算数。
 * - 去重只认**事项**(isTrackedItem:他交给事务官的、看板上写了负责人的)卡上的 `links` 与 `conversation`:
 *   派出去、在那家跑着的同一件事只数一次(与卡 F 对齐,派活记录把那条会话 links 进事项卡)。没写负责人的看板卡挂着的会话
 *   不算「挂上了」—— 那张卡不在事务官这一屏上,不单独摆出来就等于看不见。
 */
export function externalRunningSessions(state: WorkbenchState): (SceneSession & { via?: AgentSessionView['via'] })[] {
  /**
   * 筛法**只有一处**(2026-09-25,卡 V):`src/running.ts` 的 `unlinkedBusySessions` ——
   * 在办(`sessionBusy`:子任务不单独数)+ 是他的(`isHisSession`:探针不算)+ 没挂在事项上(`isTrackedItem`)。
   * 服务端拼 `/state.running` 时过的是同一个筛子,所以舞台这几张卡与那个数永远对得上。
   */
  return unlinkedBusySessions(state, registryEntries(state)
    .filter(entry => entry.self !== true && entry.id !== 'dsh')
    .flatMap(entry => entry.sessions))
}

/**
 * 一条会话在台上那张卡的状态字与那一档(2026-09-26,卡 ST)。
 *
 * `ask` 排在「做完 · 未读」前面:按内容判出来的那一问**只挂 `ask` 不改运行状态**(09-26 的口径,卡 V / WS),
 * 所以 Muse / Grok Bot 在问他的那两条在会话流里是 `done`;设计 F 要它们「在舞台上同时是卡(卡上带琥珀状态)」。
 * 在跑排最前:它在跑是关于这条会话最要紧的事实。
 */
export function stageSessionStatus(session: Pick<SceneSession, 'status' | 'reason' | 'unread' | 'ask' | 'children'>): { status: string, tone: StageSessionCard['tone'] } {
  if (session.status === 'running' || (session.status !== 'waiting' && sessionBusy(session))) return { status: '在跑', tone: 'running' }
  if (session.ask !== undefined || session.status === 'waiting') return { status: '等你', tone: 'ask' }
  if (session.status === 'error') return session.reason === 'interrupted' ? { status: '已停下', tone: 'idle' } : { status: '出错', tone: 'failed' }
  if (session.status === 'done' && session.unread) return { status: '做完 · 未读', tone: 'unread' }
  return { status: '空闲', tone: 'idle' }
}

const STAGE_TONE_ORDER: readonly StageSessionCard['tone'][] = ['running', 'ask', 'unread', 'failed', 'idle']

/** 台上一张会话卡上那几样(名字、logo、颜色从登记表来 —— 界面里没有名字表)。 */
function stageSessionCard(
  entry: Pick<AgentEntryView, 'id' | 'name' | 'icon' | 'color'>,
  session: SceneSession & { via?: AgentSessionView['via'] },
  item: { id: string, title: string } | undefined,
): StageSessionCard {
  const { status, tone } = stageSessionStatus(session)
  const ask = session.ask
  return {
    agent: entry.id,
    name: entry.name,
    icon: entry.icon === true,
    tint: entry.color ?? AGENT_NEUTRAL_COLOR,
    status,
    tone,
    ...(session.summary === undefined ? {} : { latest: session.summary }),
    ...(ask === undefined ? {} : { ask: { head: SESSION_ASK_HEAD[ask.kind].replace(/^在/, ''), question: ask.question, ...(ask.quote === undefined ? {} : { quote: ask.quote }) } }),
    ...(item === undefined ? {} : { item }),
    ...(session.via === undefined ? {} : { via: session.via }),
  }
}

/** 这条会话挂在哪张事项上(挂了卡上多一行「这件事:…」)。认的与去重同一套:事项卡的 `links` 与 `conversation`。 */
function itemOfSession(state: Pick<WorkbenchState, 'tasks'>, session: Pick<SceneSession, 'agent' | 'session_id'>): { id: string, title: string } | undefined {
  const key = sessionKey(session)
  for (const task of state.tasks?.tasks ?? []) {
    if (!isTrackedItem(task)) continue
    const keys = (task.links ?? []).map(sessionKey)
    if (task.conversation) keys.push(sessionKey(task.conversation))
    if (keys.includes(key)) return { id: task.id, title: task.title }
  }
  return undefined
}

/**
 * 台上最多摆几张会话卡(2026-09-26,卡 ST)。分页一页 6 张,所以这是 4 页。
 * 有上限是为了不让某一家侧栏里几十条老对话把台占满;排序按「在跑 → 等你 → 做完未读 → 出错 → 空闲」,
 * 所以被截掉的一定是最不要紧的那几条空闲对话。
 */
export const STAGE_SESSION_CARDS_MAX = 24

/** 这条会话从哪一刻起在跑:`now - elapsed_sec`;算不出就退回它最后一次更新的时刻。 */
function runningSince(now: string, session: Pick<SessionView, 'elapsed_sec' | 'updated_at'>): string {
  const at = Date.parse(now)
  if (Number.isNaN(at) || !Number.isFinite(session.elapsed_sec)) return session.updated_at
  return new Date(at - Math.max(0, session.elapsed_sec) * 1000).toISOString()
}

/** Frontend projection only. Reading never moves a task. */
/** 证据里冒出来、还在待排的下一步(卡 N):「加上 / 不要」只挂在这种卡上。协作区详情同用这一条。 */
export function isEvidenceProposal(task: Pick<TaskView, 'origin' | 'status'>): boolean {
  return task.origin === 'evidence' && task.status === 'backlog'
}

export function buildButlerScene(state: WorkbenchState, read: SceneRead = {}, proposals: readonly Proposal[] = []): ButlerSceneModel {
  const items: SceneItem[] = [], inbox = state.butler_inbox?.items ?? []
  const includedEvents = new Set<ButlerInboxItem>()
  const sessions = new Map(state.sessions.map(session => [sessionKey(session), session]))
  // 选题建议那一档(2026-09-22)也要进版本号:同一条资讯换了一句「为什么现在做」之后
  // 它就是新的一条,未读标记该跟着回来。
  const eventVersion = (event: ButlerInboxItem) => [event.id, event.kind, event.at, event.status, event.title, event.note, event.wait_reason, event.topic?.feed_id, event.conversation && sessionVersion(sessions.get(sessionKey(event.conversation)))]
  for (const task of state.tasks?.tasks ?? []) {
    // A session link alone must not promote an ordinary board card into a Butler item.
    // 一件事一份(2026-09-25 卡 N):看板上写了负责人的卡就是一件事项,与他交给事务官的同摆(isTrackedItem)。
    if (!isTrackedItem(task) && !inbox.some(item => item.task_id === task.id)) continue
    const references = new Set((task.links ?? []).map(sessionKey))
    if (task.conversation) references.add(sessionKey(task.conversation))
    // Keep explicit task receipts ahead of session context when choosing the card note.
    const events = inbox.filter(item => item.task_id === task.id).concat(inbox.filter(item => !item.task_id && item.kind === 'session' && item.conversation && references.has(sessionKey(item.conversation))))
    for (const event of events) includedEvents.add(event)
    const links = new Map((task.links ?? []).map(link => [`${link.agent}:${link.session_id}`, link]))
    const executors = [...links].map(([id, link]) => {
      const session = state.sessions.find(s => s.agent === link.agent && s.session_id === link.session_id)
      const agent = state.agents.find(a => a.id === link.agent)
      const source = task.execution_sources?.find(one => one.agent === link.agent && one.session_id === link.session_id)
      return { id, label: `${link.agent} / ${link.session_id}`, ...(session ? { session } : {}),
        offline: state.stale || (source === undefined ? session?.status === 'offline' || agent?.online === false : source.state === 'unknown') }
    })
    const terminal = ['done', 'canceled', 'confirm'].includes(task.status)
    // 口径唯一(2026-09-16):与服务端 butler_inbox.executing、汇报条「运行会话 n 个」同一个函数。
    const executing = state.running === undefined ? isItemExecuting(task, state) : !state.stale && businessExecutionView(state).ids.includes(task.id)
    const pending = isItemPending(task, state.now)
    const reply = [...(task.deliverables ?? [])].reverse().find(one => one.kind === 'reply')?.ref
    // 红色只用于**真错误、还没处理**(2026-09-25 晚,统筹:「有真失败且还没处理才红,待确认琥珀,其余中性」):
    // 还开着的事卡在出错上、挂的会话出错、或者派给别家没派出去 / 没做成。取消了 / 办完了 / 等验收的(terminal)一律不红,
    // 未接来电从来不进这里。手机首页 swarm/orbState.isOpenFailure 同一条判据。
    // 2026-09-25(卡 O):他按的停止(外层「停掉这一件」/ 到上限先停下来)在会话流里是 error + interrupted —— 那不是出错,不染红。
    const failed = !terminal && (task.block_reason === 'error' || executors.some(e => e.session?.status === 'error' && e.session.reason !== 'interrupted')
      || task.client_dispatch?.status === 'failed' || (task.dispatch?.status === 'failed' && task.dispatch.stopped === undefined))
    // 快照冻结时读不到各家此刻的样子:不算「在等某家」(掉线不是受阻;与 src/orbCell.ts 的 blockedOf 同一条)。
    const waiting = !terminal && !state.stale && executors.some(e => e.offline || e.session?.status === 'waiting')
    // 证据里冒出来的下一步(卡 N):「待排」卡,放「待确认」问他要不要加。
    const proposed = isEvidenceProposal(task)
    // 「待排」那几张是**提议**,不是等他验收(2026-09-27,卡 WY):不进「等你确认」那一组、卡上不画琥珀。
    const group: SceneGroup = executing && terminal ? 'working' : task.status === 'confirm' ? 'confirmation' : task.status === 'done' ? 'completed' : task.status === 'canceled' ? 'canceled' : task.status === 'blocked' || failed || waiting ? 'attention' : task.status === 'doing' ? 'working' : 'queued'
    // 到上限先停下来、在等他说继续还是停(卡 O):与等他批同一档(琥珀),是一件要他回话的事。
    const approval = !terminal && (task.block_reason === 'approval' || task.budget?.state === 'paused' || executors.some(e => e.session?.wait_reason === 'approval') || events.some(e => e.wait_reason === 'approval'))
    const notice: ParticleNotice = group === 'confirmation' ? 'confirmation' : group === 'completed' ? 'completed' : failed ? 'failed' : approval ? 'confirmation' : 'neutral'
    // 进度那一句变了也是新的一版(早报只念变了的,台上未读也跟着它回来);「几点看的」不算(同一句重核一遍不算新消息)。
    const version = JSON.stringify([task.status, task.updated_at, task.block_reason, task.deliverables, events.map(eventVersion), executors.map(e => [e.id, sessionVersion(e.session)]), task.progress?.line])
    const waitingSession = executors.find(e => e.session?.wait_reason)?.session
    const card = mineCard(task, state.projects?.projects)
    // 「打过电话:已接 / 未接」(2026-09-21)。只转述 /state.call_out 的台账,见 client/callOutLine.ts。
    const taskCallOut = callOutLine(state, task.id)
    if (links.size > 0 && task.conversation === undefined) delete card.note
    // 「确认」键只挂在带四类拍板请求的卡上(2026-10-26,卡「事务官页接管队列」);没带的标「事务官核验中」。
    const ownerAsk = executing ? undefined : ownerAskOf(task)
    const built = { ...card, ...(proposed ? { label: '要不要加', proposalTaskId: task.id } : {}), ...(events[0]?.note ? { note: events[0].note } : {}), ...(task.desc ? { description: task.desc } : {}), ...(waitingSession?.wait_reason && !task.block_reason ? { waitLabel: WAIT_REASON_TITLES[waitingSession.wait_reason] } : {}), ...(ownerAsk !== undefined ? { confirmTaskId: task.id, ownerAsk } : {}), ...(executing ? { label: '正在执行' } : task.status === 'confirm' && ownerAsk === undefined ? { label: '事务官核验中' } : {}), ...(reply === undefined ? {} : { reply }), ...(taskCallOut === undefined ? {} : { callOut: taskCallOut }), ...(task.progress === undefined ? {} : { evidence: task.progress }), group, notice, version, unread: read[task.id] !== version, executors, executing, pending, blocked: task.status === 'blocked' || failed || waiting }
    items.push({ ...built, progress: sceneProgressLine(built, state.now) })
  }
  for (const event of inbox) {
    if (includedEvents.has(event)) continue
    const id = event.task_id ?? event.id
    if (items.some(item => item.id === id)) continue
    const eventCallOut = callOutLine(state, event.task_id ?? event.id)
    const group: SceneGroup = event.kind === 'confirm' ? 'confirmation' : 'attention'
    // 那件事已经收场了(取消 / 办完):它当初那条「出错」不再染红(同上面那条规矩;正常情况下它已经挂在那张事项上了)。
    const settled = event.task_id !== undefined && (state.tasks?.tasks ?? []).some(one => one.id === event.task_id && (one.status === 'canceled' || one.status === 'done'))
    const notice: ParticleNotice = event.kind === 'confirm' || event.wait_reason === 'approval' ? 'confirmation' : event.wait_reason === 'error' && !settled ? 'failed' : 'neutral'
    const version = JSON.stringify(eventVersion(event))
    const built = { ...inboxCard(event), id, ...(eventCallOut === undefined ? {} : { callOut: eventCallOut }), group, notice, version, unread: read[id] !== version, executors: [], executing: false, pending: false, blocked: false }
    items.push({ ...built, progress: sceneProgressLine(built, state.now) })
  }
  for (const proposal of proposals) {
    const card = proposalCard(proposal), version = proposal.text
    const built = { ...card, group: 'attention' as const, notice: 'neutral' as const, version, unread: read[card.id] !== version, executors: [], executing: false, pending: false, blocked: false }
    items.push({ ...built, progress: sceneProgressLine(built, state.now) })
  }
  // 各家客户端里此刻在跑、又没挂在任何一张事项上的会话(2026-09-25)。挂在事项上的已经作为那张事项数过了。
  if (!state.stale) {
    for (const session of externalRunningSessions(state)) {
      const id = sessionJobId(session.agent, session.session_id)
      const version = JSON.stringify(sessionVersion(session))
      const name = agentTitle(session.agent, state)
      const external = { agent: session.agent, session_id: session.session_id, name, ...(session.via === undefined ? {} : { via: session.via }) }
      const executors = [{ id: `${session.agent}:${session.session_id}`, label: `${session.agent} / ${session.session_id}`, session, offline: false }]
      const entry = registryEntries(state).find(one => one.id === session.agent)
      items.push({
        // 卡 ST:这一张本来就是「一条会话」,与下面 `stage` 里那几张同一个长相(家的 logo、整句标题、最后一句、状态字)。
        ...(entry === undefined ? {} : { sessionCard: stageSessionCard(entry, session, itemOfSession(state, session)) }),
        // 标题:那家自己的标题;读不到才「Claude 的一条会话」(电脑与手机同一个说法,protocol.ts sessionDisplayTitle)。
        id, kind: 'mine', title: sessionDisplayTitle(session, name),
        // 「进行中 · n 分钟」从它进入 running 那一刻算(elapsed_sec),不是从最后一次输出算。
        dot: 'white', label: '进行中', at: runningSince(state.now, session),
        ...(session.project === '' ? {} : { context: session.project }),
        ...(session.summary === undefined ? {} : { description: session.summary }),
        group: 'working', notice: 'neutral', version, unread: false, blocked: false,
        executors,
        executing: true, pending: false,
        external,
        progress: sceneProgressLine({ pending: false, executors, external }, state.now),
        ...(session.children === undefined || session.children.length === 0 ? {} : { children: session.children }),
      })
    }
  }
  const groups: ButlerSceneModel['groups'] = { working: [], queued: [], confirmation: [], completed: [], attention: [], canceled: [] }
  for (const item of items) groups[item.group].push(item)
  /*
   * 台上那几张卡(2026-09-26,卡 ST)。维护者 19:20 拍板:「机器上正在跑的、我安排的事,不管是通过事务官发的
   * 还是直接在那家客户端里说的,就是一张卡。」所以:
   *   ① 在办 / 排队的**事项**照旧各一张(它们就是「通过事务官发的」那一路);
   *   ② 别家客户端里的**每一条会话**各一张(文件型 /state.sessions 每条 + 窗口型每条对话)——
   *      「直接在那家客户端里说的」那一路。事项板上有没有登记不影响它成卡;挂上了事项的卡多一行事项名。
   * 已经有事项卡承接的来源留在事项详情，不再单独成卡(同一件事只有一张卡);`offline`(那家 App 没开)的不摆 ——
   * 那不是「机器上正在跑的」,它的去处是顶栏那一句「Muse 没开」。
   */
  const stage: SceneItem[] = items.filter(item => item.executing || item.pending)
  const representedSessions = new Set(items.flatMap(item => item.executors.map(executor => executor.id)))
  if (!state.stale) {
    const cards: { card: SceneItem, tone: number, at: string }[] = []
    for (const entry of registryEntries(state)) {
      if (entry.self === true || entry.id === 'dsh') continue
      for (const session of entry.sessions) {
        if (!isHisSession(session) || session.status === 'offline') continue
        if (representedSessions.has(`${session.agent}:${session.session_id}`)) continue
        const id = sessionJobId(session.agent, session.session_id)
        if (stage.some(item => item.id === id)) continue
        const sessionCard = stageSessionCard(entry, session, itemOfSession(state, session))
        // 空闲的老对话不上台(2026-09-26 晚,维护者:「多了好多乱七八糟,感觉好久之前的任务啊」)——
        // 台上只摆此刻在动 / 在等他 / 做完他还没看 / 出错的;空闲那几条在各家标签与会话列表里。
        if (sessionCard.tone === 'idle') continue
        const executors = [{ id: `${session.agent}:${session.session_id}`, label: `${session.agent} / ${session.session_id}`, session, offline: false }]
        const external = { agent: session.agent, session_id: session.session_id, name: entry.name, ...(session.via === undefined ? {} : { via: session.via }) }
        const version = JSON.stringify(sessionVersion(session))
        const card: SceneItem = {
          id, kind: 'mine', title: sessionDisplayTitle(session, entry.name),
          dot: sessionCard.tone === 'ask' ? 'yellow' : sessionCard.tone === 'running' ? 'white' : sessionCard.tone === 'unread' ? 'blue' : 'gray',
          label: sessionCard.status, at: session.updated_at,
          ...(session.project === '' ? {} : { context: session.project }),
          ...(session.summary === undefined ? {} : { description: session.summary }),
          group: 'working', notice: sessionCard.tone === 'ask' ? 'confirmation' : sessionCard.tone === 'failed' ? 'failed' : 'neutral',
          version, unread: false, blocked: false, executors, executing: false, pending: false, external, sessionCard,
          progress: sceneProgressLine({ pending: false, executors, external }, state.now),
          ...(session.children === undefined || session.children.length === 0 ? {} : { children: session.children }),
        }
        cards.push({ card, tone: STAGE_TONE_ORDER.indexOf(sessionCard.tone), at: session.updated_at })
      }
    }
    cards.sort((a, b) => a.tone - b.tone || b.at.localeCompare(a.at))
    for (const one of cards.slice(0, STAGE_SESSION_CARDS_MAX)) stage.push(one.card)
  }
  // 舞台、球下、汇报与手机首页读公共业务事项数；窗口槽另标各家运行会话数。
  // 老服务没给公共事实时沿用原来的本地口径。
  const running = state.running === undefined ? runningOf(state).count : businessExecutionView(state).count
  const notice = (['failed', 'confirmation', 'completed'] as const).find(n => items.some(i => i.unread && i.notice === n)) ?? 'neutral'
  // 「受阻 N」(2026-10-04):卡住的那几件事项 + 出错的那几条会话卡。读屏与球下那一行同一个数。
  const blocked = items.filter(item => item.blocked || item.notice === 'failed').length
  return { items, groups, stage, running, notice, blocked, frozen: state.stale }
}

/*
 * ── 球的提示色怎么定(2026-10-04,运营同学交回的那一版,维护者当天拍板)────────────────
 *
 * 病症:`ButlerSceneModel.notice` 是「所有**未读**的事项里,有没有一件出错 / 待确认 / 办完」,
 * 历史上出过错又一直没点开的那一件于是把球**永久染红**。她早上开机看见红球,点进去是上周的事。
 *
 * 拍板:
 * - **红**只认「此刻台上**正在执行**的那件出错」(下面的 {@link activeFailureOf});
 *   历史阻塞改成球下那一行的「受阻 N」(见 {@link ButlerSceneModel.blocked});
 * - **通话中**(来电在响 / 接通还没挂)与等她回话同一档:**琥珀**;
 * - 其余照现状 —— **执行中的颜色与形态一个字不改**(维护者硬规矩「球不要蓝」,
 *   执行中就是莫比乌斯环那个样子,不另给一档青色 `working` 提示色);
 *   `completed` 也照现有约定走(`client/particleScene.ts` 把它折成 `neutral`)。
 *
 * 三个判据都是纯函数,用例直接喂数据(tests/client-orb-notice-20261004.test.ts)。
 *
 * **2026-10-04 晚(卡「球的颜色一处算」):这一套的主人搬到了服务端** —— `src/orbCell.ts` 的 `orbCellOf`
 * 把同一套判据算进 `/state.orb`,电脑与手机都只显示那一格(维护者 10-04:「手机的粒子球和电脑上粒子球
 * 两个的状态不一样」的根子是两端各自推算)。下面这三个函数**只剩老兼容那一路**:
 * `/state.orb` 缺席(老服务端)时 `ButlerInbox.tsx` 还用它们就地算,行为与 0.4.96 一字不差。
 * 要改判据改 `src/orbCell.ts`,不要改这里。
 */

/** 此刻台上**正在执行**的那几张里,有没有一张是出错的。历史上出过错的不在 `stage` 里,自然不算。 */
export function activeFailureOf(stage: readonly Pick<SceneItem, 'executing' | 'notice'>[]): boolean {
  return stage.some(item => item.executing && item.notice === 'failed')
}

/**
 * 此刻在通话里吗(来电在响 / 已接通还没挂 / 她刚按的试铃)。
 *
 * 读的全是现成的那几格:`/state.ringing`(真响铃,2026-08-25 起进快照)、`/state.test_ringing`
 * (试铃,真相在服务端)、`/state.call_out.entries`(座机主动来电的台账)。**不自己记状态。**
 */
export function callingNowOf(state: Pick<WorkbenchState, 'ringing' | 'test_ringing' | 'call_out'>): boolean {
  if ((state.ringing ?? []).length > 0) return true
  if (state.test_ringing === true) return true
  return (state.call_out?.entries ?? []).some(entry =>
    entry.state === 'ringing' || (entry.state === 'answered' && entry.ended_at === undefined))
}

/**
 * 球此刻该是哪个提示色。`base` 是现状那一份(`ButlerSceneModel.notice`)。
 *
 * 优先级:当前故障(红)> 等她回话 / 通话中(琥珀)> 其余照 `base`。
 * `base` 里的 `failed` 在这里被**按下去** —— 那一份数的是「未读里有没有出过错的」,
 * 正是永久红球的来源;它要表达的东西现在由球下的「受阻 N」说。
 */
export function orbNoticeOf(input: {
  activeFailure: boolean
  waitingOnUser: boolean
  calling: boolean
  base: ParticleNotice
}): ParticleNotice {
  if (input.activeFailure) return 'failed'
  if (input.waitingOnUser || input.calling) return 'confirmation'
  return input.base === 'failed' ? 'neutral' : input.base
}

/**
 * 球下那一行。「受阻 N」**只在 N>0 时出现** —— 一切正常的时候那一行不该多一个零
 * (维护者硬规矩:没有的东西不占位)。前三个数照旧,口径见 `ButlerInbox.tsx` 里 `countsLine` 那几条注释。
 */
export function orbCountsLine(counts: { running: number, queued: number, waiting: number, blocked: number }): string {
  const tail = counts.blocked > 0 ? ` · 受阻 ${counts.blocked}` : ''
  return `执行 ${counts.running} · 排队 ${counts.queued} · 等你 ${counts.waiting}${tail}`
}
