/**
 * 事项收件箱里「事务官交给我」那一半的派生(2026-09-10)。
 *
 * Ben 2026-09-10 定的事项模型(docs/设计-事务官形态-Siri式与手机.md §六 6.1):用户体感里
 * 没有「会话」,交互单位是**事项**,只有两个方向——我交给事务官 / 事务官交给我。
 * 「我交给事务官」是真实数据(任务卡上的 `direction:'mine'`,落盘在 tasks.json);
 * **「事务官交给我」是这个文件现拼出来的**,五个来源:
 *
 * | 来源 | 事实源 | 为什么算"事务官在找我" |
 * |---|---|---|
 * | 等我确认的卡 | tasks.json 里 status=confirm | 七态里这一格的定义就是「等 Ben 验收」 |
 * | 等着的 DSH 会话 | /state.sessions(agent=dsh, waiting) | 会话卡在那儿,不点它就不往下走 |
 * | 哨兵命中 | sentinel.json 里 last_fired_at 有值 | 盯着的事变了,那句话就是要说给他听的 |
 * | 排期赶不上 | 项目行上服务端算好的 risk=late | 要出事,而且他不知道 |
 * | 派活没做成 | tasks.json 里 dispatch.status=failed | 他让 Codex 做的那件事停了,要他定「我自己来还是算了」 |
 * | 选题建议 | feed.json 里提炼出 topic 的那几条 | 按她账号的定位提炼出来的选题,等她点「加入选题池」还是「不要」 |
 *
 * **为什么不落盘**:这五样各有各的事实源,再存一份就要有人负责同步,而那个同步一定会漏
 * ——漏掉之后收件箱开始展示一件早就处理完的事,那比不显示更坏(同 RepoSignals、
 * session_usage 的纪律:现算不落盘)。
 *
 * **纯函数,不碰 I/O**:composeState 把已经取好的那几块喂进来(见 server/http.ts),
 * 取不到的那块就是 undefined,对应的那一档一条都不出——绝不为了凑数编一条(D13)。
 */
import type {
  AgentRegistryView,
  AgentView,
  ButlerInboxItem,
  ButlerInboxView,
  EvolveNoticeView, EvolveProposalView,
  HabitView,
  MeetingView,
  MeetingsView,
  RoutineRun,
  RoutinesView,
  SentinelWatch,
  SessionView,
  TasksState,
  WorkbenchProject,
} from '../protocol.ts'
import { AGENT_NEVER_READ, AGENT_READ_SCOPE, BUTLER_NO_SESSION_NOTE, BUTLER_SESSION_OFFLINE_NOTE, DISPATCH_FAMILY_TITLES, ROUTINE_TITLES, isItemExecuting, scheduleRiskText } from '../protocol.ts'
import { localDateStr } from './brief.ts'
import { MEETING_DEMO_TAG } from './meetingDemoCases.ts'
import type { FeedItem } from './feed.ts'
import type { SelfShipFollowUp } from './selfShipFollowUp.ts'

export interface ButlerInboxInput {
  /** 任务看板整块。没接任务板服务时缺省,「等我确认」那一档整档不出。 */
  tasks?: TasksState | undefined
  /** 当前会话表(service.getState().sessions)。 */
  sessions: readonly SessionView[]
  /** 各家在线状态(service.getState().agents)。数「执行中」要看那家还活着没;缺席按在线算。 */
  agents?: readonly AgentView[] | undefined
  /** 快照冻结(Agent 层掉线,C1)。冻结时「执行中」缺省——最后已知状态不等于此刻真在动。 */
  stale?: boolean | undefined
  /** 哨兵的监视项。没接哨兵时缺省。 */
  sentinel?: readonly SentinelWatch[] | undefined
  /** 项目行(已经叠过 risk 的那一份)。没接项目区时缺省。 */
  projects?: readonly WorkbenchProject[] | undefined
  /** 例程的最近一次(2026-09-15)。没接例程服务时缺省,那一档整档不出。 */
  routines?: RoutinesView | undefined
  /**
   * 会议(2026-09-21)。没接会议服务(或没配工作目录)时缺省,那一档整档不出。
   * **只取最近那一场**:收件箱的价值在于短,把历次会议都铺出来就成了第二个文件夹。
   */
  meetings?: MeetingsView | undefined
  /** 「今天」的判据(state.now,ISO)。缺席用本机现在。例程条目只在它那天(lint 是那一周)露面。 */
  now?: string | undefined
  /**
   * 今天的资讯里「要跟进」的那些(2026-09-21,server/feed.ts 的 followUps)。
   * 没接资讯服务、或今天一条都没搜到,这一档整档不出。
   *
   * **这一档是建议,不是事项**:它不落 tasks.json、不占看板的格子。Ben 在收件箱里看见,
   * 点了才由他自己建成事项。理由写在 feed.ts 的纪律②。
   */
  feed?: readonly FeedItem[] | undefined
  /**
   * 今天的**选题建议**(2026-09-22,server/feed.ts 的 topicSuggestions)。运营模板下才有:
   * 资讯按账号定位提炼成「选题 + 一句为什么现在做」之后的那几条,一天最多 10 条。
   *
   * 与 `feed` 分成两个入口而不是共用一个:那一档是"顺带看看"的一条新闻,
   * 这一档点下去会**在她的盘上建一条选题**。同一条资讯不会同时出现在两档里
   * (feed.ts 的 followUps 把已提炼的那几条剔掉了)。
   *
   * 没接资讯服务、不是运营模板、今天一条都没提炼出来 → 这一档整档不出。
   */
  topics?: readonly FeedItem[] | undefined
  /**
   * 等她点头的固化提议（2026-09-22，卡 ⑥ 进化循环）。没接这条链路、或一条候选都没攒够时，
   * 这一档整档不出。
   *
   * **这一档也是建议，不是事项**（同 `feed` 的纪律②）：它不落 tasks.json、不占看板的格子。
   * 一个每天自动往看板里塞「我建议改一下自己」的东西，一周之后就没人看收件箱了。
   */
  evolve?: readonly EvolveProposalView[] | undefined
  /**
   * 偏好那一截的提示(2026-09-23):记下了一条 / 见效保留了 / 没见效撤了。**至多两条**,
   * 由 `evolve.view().notices` 给(过期的那边已经滤掉)。它们**没有按钮**:这一档只是
   * "让她知道我替她记住了什么、又改回了什么",要撤走 `/evolve/revert`。
   */
  evolve_notices?: readonly EvolveNoticeView[] | undefined
  /**
   * 上一次「改自己」重启之后那一句收尾(2026-09-23,`selfShipFollowUp.ts`)。
   *
   * 两种结局都会到这里:**已生效**(她该知道自己点的那一下真的落地了)与
   * **没生效**(那更该知道)。没有上一版待确认时整档不出 —— 这一档只在
   * "上一次真的按过更新"之后那一次启动说话。
   *
   * 与 `self_ship` 停在某一步那一档(①.6)分开:那一档说的是"这条路走不下去了",
   * 这一档说的是"走完了,这台电脑现在是哪一版"。
   */
  shipFollowUp?: SelfShipFollowUp | undefined
  /**
   * 最近的传输流水(2026-09-25,卡 J;deviceDirectory.transfers(),**新的在前**)。
   * 只取**收进来的、成了的、24 小时内的**最近两条,成一档 `file`:手机上点了「发文件」之后,
   * 他回到电脑前得在首页看见「收到了什么、在哪」,而不是去翻 `~/Documents/事务官/收件`。
   * 统一输入框的附件(`by: 'attachment'`)不算 —— 那几张图已经挂在那条事项上了。
   */
  transfers?: readonly IncomingTransferLike[] | undefined
  /**
   * Agent 登记表(2026-09-25,卡 Q;`agentDiscovery.view()`)。成一档 `agent`:拿不准的那一家问一句
   * 「XX 像是个 Agent,要接上吗?」,新接上的那一家说一句「新接上一家:XX」(带「这不是 Agent」好撤回)。
   */
  agentRegistry?: Pick<AgentRegistryView, 'notices'> | undefined
  /**
   * 新开始试用、还没告诉过她的那几条习惯(2026-10-10;`habits.notices()`)。成一档 `habit`:
   * 「新学到一条:…,正在试用」+ 依据摘要,点开能撤。不按种类写死 —— 什么种类都是这一句。
   */
  habits?: readonly HabitView[] | undefined
  /**
   * 剩余额度告警那几条(2026-10-23,卡 t-8e617888;`quotaAlerts.itemsFor(agent_quota 同一份视图)`)。
   * 成一档 `quota`:只是工作台消息,**同 habit 的纪律** —— 不进「等你」、不触发来电;条目由消费方现摆,
   * 这一层只是把它们铺进同一条流(判级与去重全在 `server/quotaAlerts.ts`)。
   */
  quotaAlerts?: readonly ButlerInboxItem[] | undefined
  /**
   * 额度活用建议那几条(2026-10-28,卡 t-f68365f6;`quotaSpendTips.itemsFor(agent_quota 同一份视图 + 看板)`)。
   * 成一档 `spend`:重置前 6 小时还剩一半以上 → 列板上「待排」的研发活,**只提议不自动派**。
   * 同 quotaAlerts 的纪律 —— 只是工作台消息,不进「等你」、不触发来电;判重与内容全在
   * `server/quotaSpendTips.ts`,这一层只是铺进同一条流。
   */
  quotaSpendTips?: readonly ButlerInboxItem[] | undefined
}

/** 传输流水里这一档要看的那几样(与 deviceDirectory.TransferEntry 同形,这里只声明用到的)。 */
export interface IncomingTransferLike {
  at: string
  direction: 'out' | 'in'
  peer: string
  name: string
  bytes: number
  ok: boolean
  by?: string
}

/** 「收到的文件」那一档留多久、最多几条。 */
export const INBOX_FILE_WINDOW_MS = 24 * 60 * 60 * 1000
export const INBOX_FILE_MAX = 2

function humanBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '大小不详'
  if (bytes < 1024) return `${bytes} 字节`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** 最近收进来的文件 → 「事务官交给我」里的几条(见 {@link ButlerInboxInput.transfers})。 */
export function incomingFileItems(transfers: readonly IncomingTransferLike[], nowMs: number): ButlerInboxItem[] {
  const items: ButlerInboxItem[] = []
  for (const record of transfers) {
    if (items.length >= INBOX_FILE_MAX) break
    if (record.direction !== 'in' || !record.ok || record.by === 'attachment') continue
    const at = Date.parse(record.at)
    if (!Number.isFinite(at) || nowMs - at > INBOX_FILE_WINDOW_MS || at - nowMs > 60_000) continue
    items.push({
      id: `file:${record.at}:${record.name}`,
      kind: 'file',
      title: `收到${record.peer}发来的「${record.name}」`,
      note: `${humanBytes(record.bytes)} · 在「事务官 / 收件」文件夹里`,
      at: record.at,
    })
  }
  return items
}

/**
 * 会话 id 里那两个**投影前缀**。带这两个前缀的会话不是真的有人在等回话:
 * `sentinel:` 是哨兵自己写进会话桶的一行(见 server/sentinel.ts),
 * `schedule:` 是排期风险的一行(见 http.ts 的 pumpRisk)。
 * 它们各自在这份收件箱里已经有一档(sentinel / risk),放进「等着的会话」就是同一件事数两遍
 * ——先例:client/butler.ts 的结论里同样把 `schedule:` 跳过。
 */
const PROJECTION_PREFIXES = ['sentinel:', 'schedule:'] as const

function isProjection(sessionId: string): boolean {
  return PROJECTION_PREFIXES.some(prefix => sessionId.startsWith(prefix))
}

/** 「等我确认」的卡上有几件可验收的东西。一件都没有时如实说,与 TaskView.deliverables 的注释同一句话。 */
function deliverableNote(count: number): string {
  return count === 0 ? '没有可验收的东西' : `${count} 件交付物`
}

/**
 * 拼出「事务官交给我」的全部条目。
 *
 * **顺序即优先级**,按"这条不动它会卡住什么"排:
 * ① 等着的会话——活正卡在那一步,不理它谁也往下走不了;
 * ② 等我确认的卡——活干完了,等验收,晚一点只是晚一点;
 * ③ 哨兵命中——是通知,不是阻塞;
 * ④ 排期赶不上——最重要但也最不急于这一分钟,而且天天在那儿,放最前会天天占着头一条。
 */
/**
 * 一次例程 → 一条「事务官交给我」。跳过/失败的不进收件箱(它们在 /state.routines.last 里,设置那节看);
 * 会话开不出来的**照样进**,标「会话未开」——三句汇报本身不需要模型,Ben 该看到。
 */
function routineItem(run: RoutineRun): ButlerInboxItem | undefined {
  if (run.status !== 'ok' && run.status !== 'no_session') return undefined
  const noSession = run.status === 'no_session'
  let title: string
  let note: string | undefined
  if (run.name === 'morning') {
    title = ROUTINE_TITLES.morning
    note = run.report
  }
  else if (run.name === 'evening') {
    title = ROUTINE_TITLES.evening
    note = run.note
  }
  else {
    title = `${ROUTINE_TITLES.lint}(待拍板)`
    note = run.report === undefined ? undefined : `提议写在 ${run.report},只提议不改文件`
  }
  // 哪一种 no_session:DSH 根本不在线(2026-10-13,只有早报走这一支)说清这一份只有程序那半,别的说「会话未开」。
  const mark = run.session_offline === true ? BUTLER_SESSION_OFFLINE_NOTE : BUTLER_NO_SESSION_NOTE
  if (noSession) note = note === undefined ? mark : `${note} · ${mark}`
  return {
    id: `routine:${run.name}:${run.date}`,
    kind: 'routine',
    title,
    ...(note === undefined ? {} : { note }),
    at: run.started_at,
    ...(run.conversation === undefined ? {} : { conversation: run.conversation }),
  }
}

/** 例程条目露面多久:开工汇报与下班例程只在当天;知识 lint 一周(下一次 lint 之前都算「本周待拍板」)。 */
function routineVisible(run: RoutineRun, today: string): boolean {
  if (run.name !== 'lint') return run.date === today
  const cutoff = localDateStr(Date.parse(`${today}T00:00:00`) - 6 * 86_400_000)
  return run.date >= cutoff && run.date <= today
}

/**
 * 「执行中」的事项数。口径是 protocol.ts 的 isItemExecuting——客户端球下「执行 n」数的也是它,两边永远相等。
 * 任务板没接上、快照冻结时缺省(D13:不知道就不填 0)。
 */
export function executingItemCount(input: Pick<ButlerInboxInput, 'tasks' | 'sessions' | 'agents' | 'stale'>): number | undefined {
  if (input.tasks === undefined || input.stale === true) return undefined
  const snapshot = { sessions: input.sessions, agents: input.agents ?? [], stale: false }
  return input.tasks.tasks.filter(task => isItemExecuting(task, snapshot)).length
}

/**
 * 最近一次会议 → 一条「事务官交给我」。
 *
 * 还在录的那一场**不进来**:人就在会上,收件箱里蹦一条没有意义。
 * 转写/梳理中的进来(他能看见进度);done 与 failed 都进来 —— 失败那条尤其要进来,
 * 「录了一小时结果什么都没有」不能只活在手机上。
 */
export function meetingItem(meeting: MeetingView): ButlerInboxItem | undefined {
  if (meeting.status === 'recording' || meeting.status === 'planned') return undefined
  const left = meeting.todos.filter(todo => todo.task_id === undefined).length
  let title: string
  let note: string | undefined
  if (meeting.status === 'transcribing') { title = `会议「${meeting.title}」正在转写`; note = meeting.segments === 0 ? undefined : `${meeting.segments} 段录音` }
  else if (meeting.status === 'summarizing') { title = `会议「${meeting.title}」正在梳理`; }
  else if (meeting.status === 'failed') { title = `会议「${meeting.title}」没整理成`; note = meeting.error }
  else {
    title = `会议「${meeting.title}」的纪要好了`
    // D13:一条待办都没梳理出来时如实说,**不写「0 条待办」那种数着像有活的话**。
    note = left === 0
      ? (meeting.todos.length === 0 ? '没梳理出待办' : '待办都建成卡了')
      : `${left} 条待办等你挑`
  }
  // 失败那条也带上 error,除非上面已经把它当成 note 用了。
  if (note === undefined && meeting.error !== undefined) note = meeting.error
  // 演示用那几场(2026-10-13):台上与事后都要看得出这不是一场真会。
  if (meeting.demo === true) note = note === undefined ? MEETING_DEMO_TAG : `${MEETING_DEMO_TAG} · ${note}`
  return {
    id: `meeting:${meeting.id}`,
    kind: 'meeting',
    title,
    meeting: {
      id: meeting.id,
      ...(meeting.retryable === true ? { retryable: true as const } : {}),
      // 会后那一句(2026-10-10):登记时说过要定什么、她还没回定下来没有,就在这一档问一句。
      ...(meeting.status === 'done' && meeting.prep?.goal !== undefined && meeting.outcome === undefined ? { ask_outcome: meeting.prep.goal.value } : {}),
    },
    ...(note === undefined ? {} : { note }),
    ...(meeting.ended_at === undefined ? {} : { at: meeting.ended_at }),
  }
}

export function deriveButlerInbox(input: ButlerInboxInput): ButlerInboxView {
  const items: ButlerInboxItem[] = []
  const executing = executingItemCount(input)
  // 会话 → 最近一句(2026-09-15)。**只从会话表抄**,不另存一份:手机上念的、/state.sessions[] 里给的,
  // 必须是同一个字符串——两个来源迟早对不上。
  const summaryOf = new Map<string, string>()
  for (const session of input.sessions) {
    if (session.agent === 'dsh' && session.summary !== undefined && session.summary !== '') {
      summaryOf.set(session.session_id, session.summary)
    }
  }

  // ⓪ 例程开口(2026-09-15)。放最前:开工汇报是当天第一句,问的是「今天先做哪件」——
  // 下面几档都是它"在盯什么"的明细。顺序 morning → evening → lint(一天里出现的先后)。
  const parsedNow = input.now === undefined ? NaN : Date.parse(input.now)
  const today = localDateStr(Number.isNaN(parsedNow) ? Date.now() : parsedNow)
  for (const name of ['morning', 'evening', 'lint'] as const) {
    const run = input.routines?.last[name]
    if (run === undefined || !routineVisible(run, today)) continue
    const item = routineItem(run)
    if (item !== undefined) items.push(item)
  }

  // ① 等着的 DSH 会话。**只认 dsh**:事务官就是 DSH,别家(Claude/Codex/Kimi)的窗口
  // 在会话区自己有黄点,收件箱替它们再说一遍只会把"事务官在找我"这件事冲淡。
  for (const session of input.sessions) {
    if (session.agent !== 'dsh' || session.status !== 'waiting') continue
    if (isProjection(session.session_id)) continue
    items.push({
      // 收件箱这一行的 id 是**它自己那一套**(`inbox.items[].id`),不是 `jobKey` 那个会话键 ——
      // 串长得像,但从不与「等你」那一行的 key、座机台账的 item_id 互相比对(2026-10-03 查过调用点)。
      id: `session:${session.session_id}`,
      kind: 'session',
      // 标题还没生成出来时(session/title 要几秒)不编一个,退回一句中性的实话。
      title: session.title ?? '事务官的一段对话',
      ...(session.project === '' ? {} : { note: session.project }),
      ...(session.wait_reason === undefined ? {} : { wait_reason: session.wait_reason }),
      conversation: { agent: 'dsh', session_id: session.session_id },
      ...(summaryOf.has(session.session_id) ? { summary: summaryOf.get(session.session_id) as string } : {}),
    })
  }

  // ①.5 派给别家的活**没做成**(2026-09-21)。排在「等我确认」之前:
  // 这条不动它,活就停在那儿谁也不往下走 —— 跟「等着的会话」是同一类阻塞,
  // 而「等我确认」那一档是活已经干完了,晚一点只是晚一点。
  //
  // **只有 failed 才进来**:进行中的那次派活在卡面上有小标(TaskCard 的「派给 X · 进行中」),
  // 收件箱再说一遍就是把"事务官在找我"这件事冲淡(同哨兵「在盯着 ≠ 有事找我」的取舍)。
  for (const task of input.tasks?.tasks ?? []) {
    const handoff = task.dispatch
    if (handoff?.status !== 'failed') continue
    // 他停的 / 到时长上限先停下来的(卡 O):不是没做成,不问「要我自己来吗」(到上限那一件卡上另有三颗键在问)。
    if (handoff.stopped !== undefined) continue
    // 那件事已经取消 / 办完了:失败那一下已经处理过,不再挂成「要我自己来吗?」(2026-09-25 晚,统筹:已取消的失败项不算)。
    if (task.status === 'canceled' || task.status === 'done') continue
    const who = DISPATCH_FAMILY_TITLES[handoff.family]
    const why = handoff.note === undefined || handoff.note.trim() === '' ? '没拿到原因' : handoff.note.trim()
    items.push({
      // id 里带上这次派活的开始时刻:同一条事项重派一次(再失败)时 id 要变,
      // 否则界面会把新的一条当成旧的那条、把它当已读收起来。
      id: `dispatch:${task.id}:${handoff.started_at}`,
      kind: 'dispatch',
      title: `${who} 没做成:${task.title}`,
      // 那一问就在这里。**措辞是固定的**,不经模型 —— 这一句是他点「好」之前唯一看得见的凭据。
      note: `${why} · 要我自己来吗?`,
      // 等待原因标「出错」:事务官那颗球据此把这条画成 failed 那一档(butlerSceneModel 第 79 行),
      // 而不是跟哨兵通知一样的中性色。派活没做成不是一条通知,是一件停在那儿的活。
      wait_reason: 'error',
      ...(handoff.ended_at === undefined ? {} : { at: handoff.ended_at }),
      status: task.status,
      task_id: task.id,
      ...(task.conversation === undefined ? {} : { conversation: task.conversation }),
      ...(task.conversation !== undefined && summaryOf.has(task.conversation.session_id)
        ? { summary: summaryOf.get(task.conversation.session_id) as string }
        : {}),
    })
  }

  // ①.6 「改工作台自己」那条闭环**停在某一步了**(2026-09-23,断点 C)。
  //
  // 排在这里(在「等我确认」之前)的理由与 ①.5 同一条:它停在那儿谁也不往下走。
  // 但它比 ①.5 更急一档 —— 那一档是别家的一件活没做成,这一档动的是 main 与发版链,
  // 停在第 3 步(合并冲突)与停在第 7 步(更新超时)要做的事完全不同。
  //
  // **只有 failed 才进来**:跑着的那一次在卡上看得见(`self_ship.status === 'running'`),
  // 收件箱再说一遍只会把"事务官在找我"这件事冲淡(同 ①.5 逐字)。
  for (const task of input.tasks?.tasks ?? []) {
    const ship = task.self_ship
    if (ship?.status !== 'failed') continue
    // 同 ①.5:取消 / 办完了的那件不再挂出来。
    if (task.status === 'canceled' || task.status === 'done') continue
    const step = ship.steps?.find(one => one.id === ship.stopped_at)
    const where = step?.title ?? ship.stopped_at ?? '某一步'
    items.push({
      // 同 ①.5:id 里带上这一次的开始时刻,重来一次(再失败)时 id 要变。
      id: `ship:${task.id}:${ship.started_at}`,
      kind: 'ship',
      title: `改自己这条路停在「${where}」:${task.title}`,
      // **原话**,不概括:她看到的这一句就是那一步失败时的输出。
      note: ship.note === undefined || ship.note.trim() === '' ? '没拿到原因' : ship.note.trim(),
      wait_reason: 'error',
      ...(ship.ended_at === undefined ? {} : { at: ship.ended_at }),
      status: task.status,
      task_id: task.id,
      ...(task.conversation === undefined ? {} : { conversation: task.conversation }),
      ...(task.conversation !== undefined && summaryOf.has(task.conversation.session_id)
        ? { summary: summaryOf.get(task.conversation.session_id) as string }
        : {}),
    })
  }

  /**
   * ①.7 上一次「改自己」**重启之后**的那一句收尾(2026-09-23)。
   *
   * 她在手机上点「通过」之后,界面上最后看到的是「已触发热更新,重启后见」——
   * 那句话必须有下文。这一条就是那个下文,而且**两种结局都出**:
   * 生效了她才知道自己点的那一下真的落地了,没生效则是这条路上最该被说出来的一件事。
   *
   * 排在 ①.6 后面:那一档是"这条路停住了,等你来看",比这一档急。
   * `wait_reason` 只在**没生效**时给 `error` —— 生效了不是一件要人处理的事。
   */
  const followUp = input.shipFollowUp
  if (followUp !== undefined) {
    items.push({
      // id 里带上版本号:同一版在两拍之间是同一条,换了一版才是新的一条(界面不闪)。
      id: `ship:followup:${followUp.version}`,
      kind: 'ship',
      title: followUp.ok ? `上一版已生效:${followUp.version}` : `更新没生效:还不是 ${followUp.version}`,
      // **原话**,不概括(同 ①.6)。
      note: followUp.note,
      ...(followUp.ok ? {} : { wait_reason: 'error' as const }),
      at: followUp.at,
    })
  }

  // ② 等我确认的卡。七态里这一格的定义就是「等 Ben 验收」,不另立判据。
  //    2026-10-26(卡「事务官页接管队列」):带上事务官标好的四类拍板请求,界面据此分出
  //    「等你拍板」(给确认键)与「事务官核验中」(只看不批);与卡上 owner_ask 同一份,不另存。
  for (const task of input.tasks?.tasks ?? []) {
    if (task.status !== 'confirm') continue
    items.push({
      id: `confirm:${task.id}`,
      kind: 'confirm',
      title: task.title,
      note: deliverableNote(task.deliverables?.length ?? 0),
      status: task.status,
      ...(task.updated_at === '' ? {} : { at: task.updated_at }),
      task_id: task.id,
      ...(task.owner_ask === undefined ? {} : { owner_ask: task.owner_ask }),
      ...(task.conversation === undefined ? {} : { conversation: task.conversation }),
      ...(task.conversation !== undefined && summaryOf.has(task.conversation.session_id)
        ? { summary: summaryOf.get(task.conversation.session_id) as string }
        : {}),
    })
  }

  /*
   * ②′ 证据里冒出来的下一步(2026-09-25,卡 N):进度核对从会话 / 交回来的话里认出的「还差 X」,建成「待排」卡、
   * `origin:'evidence'` —— 在「等你确认」里问他要不要加(他点「加上」挪「待办」,「不要」改取消)。
   * 与上面那一档同 kind(手机「等你确认」那一格就读 confirm),`status` 是 backlog,界面据此画「加上 / 不要」而不是「通过」。
   */
  for (const task of input.tasks?.tasks ?? []) {
    if (task.origin !== 'evidence' || task.status !== 'backlog') continue
    items.push({
      id: `confirm:${task.id}`,
      kind: 'confirm',
      // 标题只许**名词短语**(2026-09-27,卡 WY / 设计第五节 B):问句放在「问」里,不放进标题 ——
      // 从前这里写成「要加上吗:…」,它又同 kind 走 `confirm`,于是提议被当成「办完了等你验收」摆进「等你」。
      title: task.title,
      note: '对话里提到还要做的 · 要不要加',
      status: task.status,
      ...(task.updated_at === '' ? {} : { at: task.updated_at }),
      task_id: task.id,
    })
  }

  // ③ 哨兵命中。**没命中过的不进来**:「在盯着」不等于「有事找我」,
  // 把在盯的十几条全铺出来,真正变了的那条就淹了。
  const fired = [...(input.sentinel ?? [])]
    .filter((watch): watch is SentinelWatch & { last_fired_at: string } => typeof watch.last_fired_at === 'string')
    .sort((a, b) => b.last_fired_at.localeCompare(a.last_fired_at))
  for (const watch of fired) {
    items.push({
      id: `sentinel:${watch.id}`,
      kind: 'sentinel',
      // 监视项自己那句 note 就是"触发时对人说的那一句话"(见 SentinelWatch.note),原样用。
      title: watch.note,
      ...(watch.last_change === undefined ? {} : { note: watch.last_change }),
      at: watch.last_fired_at,
      // **不给 conversation**:哨兵那条会话是投影,DSH 里没有这条会话,点开会落空。
    })
  }

  // ④ 排期赶不上。判断本身是服务端别处算好的(scheduleRisk.ts),这里只转述,不自己再算一遍。
  for (const project of input.projects ?? []) {
    if (project.risk?.level !== 'late') continue
    items.push({
      id: `risk:${project.id}`,
      kind: 'risk',
      title: `${project.name} 排期赶不上`,
      note: scheduleRiskText(project.risk),
    })
  }

  // ⑤ 今天的资讯里值得跟进的那些(2026-09-21)。**放在最后那一档**:它是"顺带看看"的东西,
  // 排在等确认的卡与在等的会话前面会把真正堵着的事挤下去。用户自己点过「跟进」的排前面。
  const follow = [...(input.feed ?? [])].sort((a, b) => {
    const mine = Number(b.feedback === 'follow') - Number(a.feedback === 'follow')
    return mine !== 0 ? mine : b.score - a.score
  })
  for (const item of follow) {
    items.push({
      id: `feed:${item.id}`,
      kind: 'feed',
      title: item.title,
      // 一句「跟你这个项目有什么关系」+ 出处。两样都是模型/搜索给的事实,不是我们编的。
      note: `${item.project_name}·${item.why}${item.source === undefined ? '' : `(${item.source})`}`,
      url: item.url,
    })
  }

  // ⑤.5 今天的选题建议(2026-09-22 卡 ③)。**紧跟在资讯那一档后面**:它们是同一条
  // 管线的两个出口,而这一档比上一档更接近"能直接做的事"(标题就是她能拿去写的那句话)。
  // 分数高的在前(topicSuggestions 已经排好),这里不再排第二遍。
  for (const item of input.topics ?? []) {
    const topic = item.topic
    if (topic === undefined) continue
    items.push({
      id: `topic:${item.id}`,
      kind: 'topic',
      // 标题就是选题本身 —— 早报里念的也是这一句(feed.ts 的 morningLines)。
      title: topic.title,
      // 一句「为什么现在做」+ 账号名 + 出处。三样都是事实,没有一样是这里编的。
      note: `${item.project_name}·${topic.why_now}${item.source === undefined ? '' : `(${item.source})`}`,
      url: item.url,
      topic: { feed_id: item.id, project_id: item.project_id, project_name: item.project_name },
    })
  }

  // ⑤.5 固化提议（2026-09-22，卡 ⑥）。**排在会议之前、资讯之后**：它比"顺带看看的资讯"更像
  // 一件要她拍板的事（点了头就会往她的仓库里写文件），但它一条都不阻塞——今天不理它，
  // 明天那几次重复还在，提议照样在。
  //
  // **只摆问句，不摆动作**：三颗键（做 / 不要 / 以后再说）在输入框上方那张 EvolveAsk 卡上。
  // 这一档存在的理由是让那件事出现在"事务官交给我"的同一条流里——她不必去别处找它。
  for (const proposal of input.evolve ?? []) {
    items.push({
      id: proposal.id,
      kind: 'evolve',
      title: proposal.ask,
      // 「它准备怎么做、会碰什么」那一段（设计文档 §五 2 点名要的）。默认那条路的那一份。
      note: proposal.plans[proposal.suggested_way],
      at: proposal.created_at,
    })
  }
  // 偏好那一截的提示(2026-09-23):同一档、同一种卡,只是没有问句 —— 它不等她点头,
  // 记下 / 保留 / 撤 都已经发生了,这里只是让她看见。
  for (const notice of input.evolve_notices ?? []) {
    items.push({ id: notice.id, kind: 'evolve', title: notice.title, note: notice.note, at: notice.at })
  }

  // ⑥ 最近一次会议(2026-09-21)。放最后:它不阻塞任何人,但纪要梳理完那一刻
  // 「待办等你挑」这件事他必须看得见 —— 不看的话那几条待办就烂在手机里了。
  const meeting = input.meetings?.recent[0]
  const meetingEntry = meeting === undefined ? undefined : meetingItem(meeting)
  if (meetingEntry !== undefined) items.push(meetingEntry)

  // ⑦ 手机发来的文件(2026-09-25,卡 J)。放最后:不阻塞任何事,只是让他看见收到了什么、在哪。
  if (input.transfers !== undefined) {
    const nowMs = input.now === undefined ? Date.now() : Date.parse(input.now)
    items.push(...incomingFileItems(input.transfers, Number.isFinite(nowMs) ? nowMs : Date.now()))
  }

  // ⑧ Agent 登记表(2026-09-25,卡 Q):新接上的那一家说一句(带撤回)。放最后:不阻塞别的事。
  // 拿不准的那一家「要接上吗」不在这里:那一问挂在卡 M 的提问经纪人上(state.questions → 「等你」那一堆)。
  if (input.agentRegistry !== undefined) items.push(...agentItems(input.agentRegistry))

  // ⑨ 新学到一条(2026-10-10):只是让她知道,放最后;不进「等你」那一堆,也不触发来电(来电只看看板与例程)。
  if (input.habits !== undefined) items.push(...habitItems(input.habits))

  // ⑩ 剩余额度告警(2026-10-23,卡 t-8e617888):同样「只是让她知道」—— 不进「等你」、不触发来电。
  if (input.quotaAlerts !== undefined) items.push(...input.quotaAlerts)

  // ⑪ 额度活用建议(2026-10-28,卡 t-f68365f6):同一纪律 —— 只是工作台消息,只提议不自动派。
  if (input.quotaSpendTips !== undefined) items.push(...input.quotaSpendTips)

  return { items, ...(executing === undefined ? {} : { executing }) }
}

/**
 * 「新接上一家:XX」底下那行小字(2026-09-25,卡 Q;统筹:第一次接上一家时用一句人话说清读了什么、没读什么,
 * 「这不是 Agent」要好找)。读的范围与顶栏小灯点开那一张、「要接上吗」那一问是同一句(protocol 的 AGENT_READ_SCOPE)。
 */
export const AGENT_NOTICE_NOTE = `从现在起${AGENT_READ_SCOPE}${AGENT_NEVER_READ}判错了就点「这不是 Agent」;以后在顶上它那颗灯上点一下也有。`

/**
 * 登记表那一档:新接上的那一家只说一句(「知道了」收掉、「这不是 Agent」撤回)。
 * **不进「等你」那一堆**:它已经接上了,不是非他不可的事。拿不准要问他的那一问走卡 M 的提问经纪人(server/agentAsk.ts)。
 */
export function agentItems(agents: Pick<AgentRegistryView, 'notices'>): ButlerInboxItem[] {
  return agents.notices
    .filter(one => one.agent !== undefined)
    .map((one): ButlerInboxItem => ({
      id: `agent:new:${one.id}`,
      kind: 'agent',
      title: one.text,
      note: AGENT_NOTICE_NOTE,
      at: one.at,
      agent: { id: one.agent as string, notice_id: one.id },
    }))
}

/** 「新学到一条」那一句的开头(电脑、手机、用例都认这一处)。 */
export const HABIT_NOTICE_HEAD = '新学到一条:'
/** 依据摘几条(最近的几条;多了说一共几条)。 */
const HABIT_NOTICE_EVIDENCE = 2

/**
 * 新学到一条那一档(2026-10-10,维护者 10-09 拍板):「新学到一条:<人话>,正在试用」,底下依据摘要、怎么撤。
 * 按通用形状拼(`text` + `evidence[]`),不按种类写死;原话(`said`)有就引。
 */
export function habitItems(habits: readonly HabitView[]): ButlerInboxItem[] {
  return habits.map((habit): ButlerInboxItem => {
    const recent = habit.evidence.slice(-HABIT_NOTICE_EVIDENCE)
      .map(one => (one.said === undefined || one.said === '' ? one.what : `${one.what}(你的原话「${one.said}」)`))
    const more = habit.evidence.length > recent.length ? `等,共 ${String(habit.evidence.length)} 条` : ''
    const why = recent.length === 0 ? '' : `依据:${recent.join(';')}${more}。`
    return {
      id: `habit:${habit.id}`,
      kind: 'habit',
      title: `${HABIT_NOTICE_HEAD}${habit.text},正在试用`,
      note: `${why}下一次同类的事你没纠正就留下;不对就点「撤掉」。`,
      at: habit.adopted_at,
      habit: { id: habit.id },
    }
  })
}
