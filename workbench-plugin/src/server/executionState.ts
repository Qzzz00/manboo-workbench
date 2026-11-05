import { createHash } from 'node:crypto'
import type { ExecutionItem, ExecutionOverview, RunSegment, SessionView, TaskExecutionSource, TasksState, TaskView } from '../protocol.ts'
import { executionRoleOf, isTrackedItem, receiptStatus, statusPathTo } from '../protocol.ts'
import { readLinkedCodexExecutions, type CodexExecutionDeps, type CodexExecutionEvent, type CodexExecutionSource } from './codexExecutionFacts.ts'
import type { JobEvent, JobLog } from './jobLog.ts'
import type { TasksService } from './tasks.ts'

const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const reopenAt = (task: TaskView): string | undefined => task.transitions?.filter(one =>
  (one.from === 'confirm' || one.from === 'done') && one.to !== 'confirm' && one.to !== 'done').at(-1)?.at
const roleOfSource = (task: TaskView, source: Pick<CodexExecutionSource, 'agent' | 'session_id'>) =>
  task.links?.find(link => link.agent === source.agent && link.session_id === source.session_id)?.execution_role ?? executionRoleOf(task)
/**
 * 快照里每个来源只带最近这几条事件:界面只读最后一条(最后动作、最后更新),完整的在任务账(jobLog)里。
 * 全量带的时候长会话一个就上百条、一份 /state 两处各带一遍,涨到 1.8 MB,过不了房间代理 1 MB 的回包上限,
 * 出门 / 认不出网络的手机首页一直「电脑不在线」(2026-10-28 Pixel)。
 */
export const EXECUTION_VIEW_ROUNDS = 3
// 文件 stamp 不变时 parsed cache 返回同一 events 引用,rounds 是它的纯投影 —— 按引用备忘,
// 每拍 23 个来源就不各自重建一遍 rounds 数组。备忘的就是截到最近 EXECUTION_VIEW_ROUNDS 条的那份;其余字段仍每拍现算。
const roundsByEvents = new WeakMap<readonly CodexExecutionEvent[], readonly { round: string, event_id: string, kind: CodexExecutionEvent['kind'], at: string }[]>()
function roundsOf(events: readonly CodexExecutionEvent[]): readonly { round: string, event_id: string, kind: CodexExecutionEvent['kind'], at: string }[] {
  let rounds = roundsByEvents.get(events)
  if (rounds === undefined) {
    rounds = events.slice(-EXECUTION_VIEW_ROUNDS).map(event => ({ round: event.round, event_id: event.id, kind: event.kind, at: event.at }))
    roundsByEvents.set(events, rounds)
  }
  return rounds
}
export const executionSourceView = (source: CodexExecutionSource, task: TaskView): TaskExecutionSource => ({
  task_id: source.task_id, agent: source.agent, session_id: source.session_id, state: source.state,
  role: roleOfSource(task, source).kind, role_origin: roleOfSource(task, source).origin,
  ...(source.provider === undefined ? {} : { provider: source.provider }),
  ...(source.transport === undefined ? {} : { transport: source.transport }),
  ...(source.provider_basis === undefined ? {} : { provider_basis: source.provider_basis }),
  ...(source.task_round === undefined ? {} : { task_round: source.task_round }),
  ...(source.unknown === undefined ? {} : { unknown: source.unknown }),
  ...(source.receipt === undefined ? {} : { receipt: { kind: source.receipt.kind, at: source.receipt.at } }),
  rounds: roundsOf(source.events),
})

export function executionOverview(tasks: readonly TaskView[], available = true,
  runsOf: (task: TaskView) => readonly RunSegment[]): ExecutionOverview {
  const items: ExecutionItem[] = tasks.filter(task => (task.links?.length ?? 0) > 0 || task.status === 'doing' && isTrackedItem(task)).map(task => {
    const sources = task.execution_sources ?? []
    const role = executionRoleOf(task)
    const businessSources = sources.filter(one => one.role === 'business')
    let state: ExecutionItem['state']
    if (task.status === 'canceled') state = 'canceled'
    else if (role.kind !== 'business') state = sources.some(one => one.state === 'running') ? 'running' : 'unknown'
    else if (businessSources.some(one => one.state === 'running')) state = 'running'
    else if (businessSources.some(one => one.receipt?.kind === 'blocked') || task.status === 'blocked') state = 'blocked'
    else if (businessSources.some(one => one.unknown === 'awaiting_restart')) state = 'rework'
    else if (businessSources.length === 0 || businessSources.some(one => one.state === 'unknown' || one.state === 'ended' || one.state === 'interrupted')) state = 'unknown'
    else if (businessSources.every(one => one.state === 'returned')) state = task.status === 'done' ? 'completed' : 'awaiting_review'
    else state = 'queued'
    return { task_id: task.id, title: task.title, task_round: task.round ?? 1, state, role: role.kind, role_origin: role.origin, sources }
  })
  const statusById = new Map(tasks.map(task => [task.id, task.status]))
  const current = items.filter(item => item.role !== 'coordination' && item.state !== 'completed' && item.state !== 'canceled'
    // Historical imported cards remain visible as excluded unknown sources, but a closed/parked card
    // with no witnessed running source is not part of today's execution-count completeness gate.
    && !(item.role === 'unclassified' && item.state === 'unknown'
      && (statusById.get(item.task_id) === 'done' || statusById.get(item.task_id) === 'confirm' || statusById.get(item.task_id) === 'blocked')))
  /*
   * 「在跑几件 / 几个会话」只从任务日志那一本账数(2026-10-29 改口,任务书「在跑的事项要数到
   * 命令行真在跑的活」①b):`runsOf` 与 `GET /collab/runs` 是同一处(collabRoutes.runSegmentsOf,
   * 生产在 http.ts 用同一个 jobLog 接上),execution_sources 那本 Codex 来源账不再单独决定
   * 「在跑几件」——否则 Kimi 命令行这一类进不了来源账的活,总览永远数不到它。每件按 task_id 去重
   * (与客户端 runningTaskIdsOfRuns 同口径);「会话」= 在跑的业务片段条数,与旧来源账口径同义。
   */
  const runningBusinessSegments = tasks.flatMap(task => runsOf(task).filter(one => one.status === 'running' && one.role === 'business'))
  return {
    scope: 'linked_tasks', complete: available && current.every(item => item.role === 'business' && item.sources.some(one => one.role === 'business')
      && item.sources.filter(one => one.role !== 'coordination').every(one => one.role === 'business' && one.state !== 'unknown' && one.state !== 'ended' && one.state !== 'interrupted')),
    observed_running_tasks: new Set(runningBusinessSegments.map(one => one.task_id)).size,
    observed_running_sessions: runningBusinessSegments.length, items,
  }
}

/**
 * 对账一拍的产出。`snapshot()` 回这个;`request()` 合并后回同一个引用语义的结果。
 */
export interface ExecutionReconcileResult { tasks: TasksState, sessions: SessionView[] }

/**
 * 距上一拍对账的最长到期间隔(8791 第六轮):没有任何任务事件时,兜底一拍兜
 * 「进程退出 / 账外改动」; running 来源的断档也在这一拍内被发现。用例传 0 关掉到期调度。
 */
export const EXECUTION_RECONCILE_IDLE_MS = 30_000

/**
 * 事件触发的两拍最小间隔(8791 第六轮第 3 轮,实施者定):任务账连写(派活 / 交回高峰)
 * 时把对账摊到这个间隔上,触发合并成一拍;到期(30 秒)与显式 request(起服务 / 验收排障口)
 * 不受它限。0 = 不限(用例)。
 */
export const EXECUTION_RECONCILE_MIN_EVENT_GAP_MS = 2_000

/**
 * 事件驱动 + 有界到期的执行对账器(8791 第六轮,2026-10-29;取代「每拍 GET /state 排进串行队列」)。
 *   - `request()`:已在排 / 正在跑的一拍把所有后来的调用合并进它,不再追加;
 *   - `notifyChanged()`:任务账写事件的**节流**入口 —— 距上一拍不足 {@link EXECUTION_RECONCILE_MIN_EVENT_GAP_MS}
 *     时合并进下一拍(定时到点再跑),读路(collab / /state / 广播)一律不调它;
 *   - `snapshot()`:只读上一拍结果 —— 各读路每拍调它,**绝不**触达文件系统;
 *   - 已收场(done/canceled)与「confirm 且有回执」的卡,任务账签名没变就**一律跳过**:
 *     不定位、不 stat、不过授权,复用上一拍观察(不看观察结果 —— 老链接卡观察是 unknown/unsupported
 *     也必须安静,否则每拍重定位);签名(状态/轮次/updated_at/回执/链接/派发运行态)变了 = 新事件,
 *     该卡下一拍被读一次,读完回到安静。
 */
export interface ExecutionReconciler {
  /** 显式 / 到期驱动的合并请求:已在排或正在跑就并入那一次,否则起新的一拍(不受事件节流限制)。 */
  request(): Promise<ExecutionReconcileResult>
  /** 任务账写事件入口:节流 —— 两个**事件拍**之间至少隔 {@link EXECUTION_RECONCILE_MIN_EVENT_GAP_MS}
   * (0=不限;起服务冷拍/显式 request/到期拍不占这个间隔 —— 它们之后的首个事件拍立即跑,授权撤权因此即时生效)。 */
  notifyChanged(): void
  /** 上一拍对账的结果;从没跑过 = undefined(调用方退回 tasks.list())。 */
  snapshot(): ExecutionReconcileResult | undefined
  /**
   * 读路用的快照(8791 第六轮第 4 轮):没有未对账的写、也没有在途的对账时,白拿 `snapshot()`;
   * 有(任务账刚写、对账在途)就等到那一拍落地再回 —— 撤权 / 建卡之后紧跟的 /state 一定带着新结论,
   * 而平时连读多少遍都零对账触发(写事件本来就排了对账,这里只是等它,不是替它决定)。
   */
  awaitFresh(): Promise<ExecutionReconcileResult | undefined>
  /** 对账器自己正在写任务账(http.ts 的 onMutated 据此不递归触发)。 */
  applying(): boolean
  /** 停掉到期与节流调度(服务收摊用)。 */
  dispose(): void
}

/** Serialized request-driven replay into the existing task and event stores. No second ledger or poller. */
export function createExecutionReconciler(deps: { tasks: TasksService, jobLog: JobLog,
  prepareAuthorization?: (board: TasksState) => Promise<CodexExecutionDeps['authorize'] & { dispose?: () => void }> | (CodexExecutionDeps['authorize'] & { dispose?: () => void }),
  /** 有界到期间隔,缺省 {@link EXECUTION_RECONCILE_IDLE_MS};0 = 关到期调度(用例)。 */
  idleTtlMs?: number
  /** 事件触发的两拍最小间隔,缺省 {@link EXECUTION_RECONCILE_MIN_EVENT_GAP_MS};0 = 不限(用例)。 */
  minEventGapMs?: number
  /** 每拍跑完通知一次(http.ts 用来推快照)。 */
  onFinished?: () => void } & CodexExecutionDeps): ExecutionReconciler {
  /*
   * 对账自己的写(move / recordReceipt)包一层 applying 标记:任务账的 onMutated 通知
   * 据此不递归触发新的一拍(对账引发的写已在当前这一拍里,下一拍由拍间账差兜底)。
   */
  let applying = false
  /** 这一拍有没有真改东西(任务账写 / 账上新事件)——onFinished(推快照)只在有变化时通知。 */
  let mutated = false
  const tasks: TasksService = {
    ...deps.tasks,
    move: (id, status) => {
      applying = true
      return deps.tasks.move(id, status).finally(() => { applying = false })
        .then((moved) => { if (moved.ok) mutated = true; return moved })
    },
    recordReceipt: (id, receipt, current) => {
      applying = true
      return deps.tasks.recordReceipt(id, receipt, current).finally(() => { applying = false })
        .then((recorded) => { if (recorded.ok && recorded.fresh) mutated = true; return recorded })
    },
  }
  /** 上一拍收场时的任务账签名(状态 / 轮次 / 回执 / 链接 / 派发运行态):拍间签名不变 = 没有新事件。 */
  let lastBoardSig = new Map<string, string>()
  /** 上一拍每卡的来源观察;安静卡跳过读取时复用它。 */
  let lastSourcesByTask = new Map<string, readonly CodexExecutionSource[]>()
  let lastResult: ExecutionReconcileResult | undefined
  let pending: Promise<ExecutionReconcileResult> | undefined
  let expiryTimer: ReturnType<typeof setTimeout> | undefined
  let disposed = false
  const boardSigOf = (task: TaskView): string => JSON.stringify([
    task.status, task.round ?? 1, task.updated_at ?? '', task.receipt ?? null, (task.receipts ?? []).length, task.links ?? [],
    task.dispatch?.status ?? null, task.dispatch?.ended_at ?? null, task.dispatch?.pid ?? null,
  ])
  /**
   * 已收场且任务账签名没变的卡:这一拍**一律**跳过(不定位 / 不 stat / 不过授权),复用上一拍观察。
   * 不看观察结果(第 3 轮退修):老链接卡的观察常是 unknown / unsupported / missing,要求「全部 returned」
   * 它们就永远不安静、每拍重定位(0.4.188 真机剖面的 stat 风暴);收场卡没有新事实要追,
   * 新活动由任务事件(签名变)捞起。仍要求有上一拍观察可复用(没有 = 从没读过,必读)。
   */
  const quietSettled = (task: TaskView): boolean => {
    if (!lastBoardSig.has(task.id) || lastBoardSig.get(task.id) !== boardSigOf(task)) return false
    const settled = task.status === 'done' || task.status === 'canceled'
      || task.status === 'confirm' && task.receipt !== undefined
    if (!settled) return false
    const prev = lastSourcesByTask.get(task.id)
    return prev !== undefined && prev.length > 0
  }
  async function reconcile(): Promise<ExecutionReconcileResult> {
    const { jobLog } = deps
    const ledgerRevisionBefore = deps.jobLog.revision?.()
    const sigsBefore = lastBoardSig
    mutated = false
    let board = await tasks.list()
    const observed = board.tasks.filter(task => !quietSettled(task))
    const quiet = board.tasks.filter(task => quietSettled(task))
    const authorize = await deps.prepareAuthorization?.(board)
    let facts: Awaited<ReturnType<typeof readLinkedCodexExecutions>>
    try { facts = await readLinkedCodexExecutions(observed, deps, authorize) }
    finally { authorize?.dispose?.() }
    // 安静卡:没有新事实可读,复用上一拍观察(副本),后续投影 / 记账流程原样走,只是不碰文件系统。
    for (const task of quiet) {
      const prev = lastSourcesByTask.get(task.id)
      if (prev !== undefined) facts.sources.push(...prev.map(source => ({ ...source })))
    }
    /*
     * 合并后按「看板顺序 + 卡内链接顺序」重排来源:跳过与否只决定读不读,不改变投影里来源的
     * 顺序(消费方按链接顺序对来源分角色)。多卡共挂的歧义来源没有单一链接,留在原相对顺序殿后。
     */
    const sourceKeyOf = (source: CodexExecutionSource): string => JSON.stringify([source.task_id, source.agent, source.session_id])
    const mergedByKey = new Map<string, CodexExecutionSource>()
    for (const source of facts.sources) mergedByKey.set(sourceKeyOf(source), source)
    const ordered: CodexExecutionSource[] = []
    const pushed = new Set<string>()
    for (const task of board.tasks) for (const link of task.links ?? []) {
      const key = JSON.stringify([task.id, link.agent, link.session_id])
      const source = mergedByKey.get(key)
      if (source !== undefined && !pushed.has(key)) { ordered.push(source); pushed.add(key) }
    }
    for (const source of facts.sources) {
      const key = sourceKeyOf(source)
      if (!pushed.has(key)) { ordered.push(source); pushed.add(key) }
    }
    facts.sources = ordered
    const changedTasks = new Set<string>()
    const historyByTask = new Map<string, readonly JobEvent[]>()
    const taskHistory = (id: string): readonly JobEvent[] => {
      let history = historyByTask.get(id)
      if (history === undefined) { history = jobLog.events(id); historyByTask.set(id, history) }
      return history
    }
    for (const source of facts.sources) {
      let task = board.tasks.find(one => one.id === source.task_id)!
      const business = roleOfSource(task, source).kind === 'business'
      const last = source.events.at(-1)
      const started = source.events.find(one => one.round === last?.round && one.kind === 'started')
      const history = taskHistory(task.id).filter(one => one.agent === source.agent && one.session_id === source.session_id)
      const roundBySource = new Map<string, number>()
      const recordedIds = new Set<string>()
      for (const entry of history) {
        if (entry.source_round !== undefined && entry.task_round !== undefined && !roundBySource.has(entry.source_round)) {
          roundBySource.set(entry.source_round, entry.task_round)
        }
        if (entry.source_event_id !== undefined && (entry.step === 'started' || entry.step === 'updated'
          || entry.step === 'ended' || entry.step === 'interrupted' || entry.step === 'replied')) recordedIds.add(entry.source_event_id)
      }
      const priorObservation = history.at(-1)
      let round = last === undefined ? undefined : roundBySource.get(last.round)
      const reported = (task.receipts ?? []).find(one => one.source_session_id === source.session_id
        && one.source_round === last?.round && (one.task_round ?? 1) === (task.round ?? 1))
      if (reported !== undefined && source.state === 'running') { source.state = 'returned'; source.receipt = reported }
      // Reopen only for active work or a newly returned turn. A terminal turn whose receipt is already
      // saved cannot reopen the card again just because its start predates another source's current receipt.
      const newlyObservedWork = source.state === 'running' || source.state === 'returned' && reported === undefined
      if (business && newlyObservedWork && (task.status === 'confirm' || task.status === 'blocked') && started !== undefined
        && task.receipt !== undefined && Date.parse(started.at) > Date.parse(task.receipt.at)) {
        await tasks.move(task.id, 'doing')
        board = await tasks.list()
        task = board.tasks.find(one => one.id === task.id)!
        round = task.round ?? 1
      }
      const boundary = reopenAt(task)
      if (last === undefined) round = history.at(-1)?.task_round ?? task.round ?? 1
      round ??= (task.round ?? 1) === 1 || boundary !== undefined && started !== undefined && Date.parse(started.at) >= Date.parse(boundary)
        ? task.round ?? 1 : Math.max(1, (task.round ?? 1) - 1)
      source.task_round = round
      if (last !== undefined && round !== (task.round ?? 1)) {
        source.state = 'unknown'; source.unknown = 'awaiting_restart'; delete source.receipt
      }
      // Rebuilt source files can insert events before an already recorded event. Check each ID;
      // the task ledger keeps source evidence even when unrelated settled events are trimmed.
      let appended = false
      for (const event of source.events) {
        if (recordedIds.has(event.id)) continue
        const step = event.kind === 'ended' && event.receipt !== undefined ? 'replied' : event.kind
        const eventRound = roundBySource.get(event.round) ?? (event.round === last?.round ? round : 1)
        jobLog.append({ job: task.id, step, family: source.provider ?? 'unknown', agent: source.agent, session_id: source.session_id,
          source_round: event.round, source_event_id: event.id, occurred_at: event.at, observed_at: deps.now().toISOString(), at: event.at, task_round: eventRound,
          ...(event.receipt === undefined ? {} : { why: `receipt:${event.receipt.kind}` }) })
        appended = true
      }
      if (appended) historyByTask.delete(task.id)
      const previous = taskHistory(task.id).filter(one => one.agent === source.agent && one.session_id === source.session_id).at(-1)
      const sourceRound = last?.round ?? previous?.source_round ?? 'unknown'
      if (source.state === 'unknown' && (previous?.step !== 'source_unknown' || previous.why !== source.unknown)) {
        jobLog.append({ job: task.id, step: 'source_unknown', family: source.provider ?? 'unknown', agent: source.agent, session_id: source.session_id,
          source_round: sourceRound, source_event_id: digest([previous?.source_event_id, source.unknown, sourceRound]), task_round: round,
          at: deps.now().toISOString(), observed_at: deps.now().toISOString(), source_state: 'unknown', why: source.unknown ?? 'unavailable' })
        historyByTask.delete(task.id)
      } else if (source.state !== 'unknown' && previous !== undefined && (priorObservation?.step === 'source_unknown' || previous.task_round === undefined) && last !== undefined) {
        jobLog.append({ job: task.id, step: 'source_observed', family: source.provider ?? 'unknown', agent: source.agent, session_id: source.session_id,
          source_round: sourceRound, source_event_id: digest([priorObservation?.source_event_id, last.id, source.state]), task_round: round,
          at: deps.now().toISOString(), observed_at: deps.now().toISOString(), occurred_at: last.at, source_state: source.state })
        historyByTask.delete(task.id)
      }
      changedTasks.add(task.id)
    }
    // flush is the durability barrier for source broadcasts and HTTP snapshots.
    await jobLog.flush()
    let recordedReceipts = false
    for (const source of facts.sources) for (const event of source.events) {
      if (event.receipt === undefined) continue
      const eventRound = taskHistory(source.task_id).find(one => one.agent === source.agent && one.session_id === source.session_id && one.source_event_id === event.id)?.task_round
        ?? (event.round === source.events.at(-1)?.round ? source.task_round ?? 1 : 1)
      const task = board.tasks.find(one => one.id === source.task_id)!
      const current = roleOfSource(task, source).kind === 'business' && source.state === 'returned' && event.id === source.events.at(-1)?.id
      const prior = (task.receipts ?? []).find(one => one.source_session_id === source.session_id && one.source_round === event.round)
      if (prior !== undefined && (!current || task.receipt !== undefined || eventRound !== (task.round ?? 1))) continue
      await tasks.recordReceipt(source.task_id, { ...event.receipt, source_session_id: source.session_id, source_round: event.round, task_round: eventRound }, current)
      recordedReceipts = true
    }
    if (recordedReceipts) board = await tasks.list()
    let movedStatus = false
    for (const id of changedTasks) {
      const task = board.tasks.find(one => one.id === id)!
      if (task.status === 'done' || task.status === 'canceled') continue
      const sources = facts.sources.filter(one => one.task_id === id && roleOfSource(task, one).kind === 'business')
      const target = sources.some(one => one.state === 'running') ? 'doing'
        : sources.some(one => one.receipt?.kind === 'blocked') ? 'blocked'
          : sources.length > 0 && sources.every(one => one.state === 'returned') ? receiptStatus('done') : undefined
      if (target !== undefined && target !== task.status) for (const status of statusPathTo(task.status, target) ?? []) {
        const moved = await tasks.move(id, status); if (!moved.ok) break
        movedStatus = true
      }
    }
    if (movedStatus) board = await tasks.list()
    const projected = board.tasks.map(task => ({ ...task, execution_sources: facts.sources.filter(source => source.task_id === task.id).map(source => executionSourceView(source, task)) }))
    const sourcesByKey = new Map(facts.sources.map(source => [`${source.agent}:${source.session_id}`, source]))
    const sessions = facts.sessions.flatMap((session): SessionView[] => {
      const source = sourcesByKey.get(`${session.agent}:${session.session_id}`)
      if (source === undefined || source.state === 'unknown') return []
      const status = source.state === 'running' ? 'running' : source.state === 'returned'
        ? source.receipt?.kind === 'blocked' ? 'error' : 'done' : source.state === 'interrupted' ? 'error' : 'offline'
      return [{ ...session, status }]
    })
    const result: ExecutionReconcileResult = { tasks: { ...board, tasks: projected }, sessions }
    /*
     * 收场记忆:这一拍结束时的任务账签名 + 每卡来源观察。下一拍靠它判「有没有新事件」——
     * 签名不变且已收场的卡跳过读取;对账自己的写已体现在这份签名里,不会反复触发重读。
     */
    lastBoardSig = new Map(board.tasks.map(task => [task.id, boardSigOf(task)]))
    lastSourcesByTask = new Map()
    for (const source of facts.sources) {
      const list = [...(lastSourcesByTask.get(source.task_id) ?? []), source]
      lastSourcesByTask.set(source.task_id, list)
    }
    lastResult = result
    // 真变化才算:任务账写过、账上进了新事件(revision 变了)、或任务账签名与上一拍不同
    // (改卡/挪卡/新卡 —— 投影里那些格真的变了)。空拍(安静卡复用、签名不变、无新事件)
    // 不通知 —— 推快照只在快照真变了的时候(8791 第六轮第 3 轮「只在变化时广播」)。
    const ledgerChanged = ledgerRevisionBefore !== undefined && deps.jobLog.revision?.() !== ledgerRevisionBefore
    const boardChanged = sigsBefore.size !== lastBoardSig.size
      || [...sigsBefore].some(([id, sig]) => lastBoardSig.get(id) !== sig)
    lastRunChanged = mutated || ledgerChanged || boardChanged
    return result
  }
  let lastRunChanged = false
  /** 有界到期:上一拍跑完 arm 下一拍;任何位置先清旧的,不会叠。 */
  function armExpiry(): void {
    if (disposed || deps.idleTtlMs === 0) return
    if (expiryTimer !== undefined) clearTimeout(expiryTimer)
    expiryTimer = setTimeout(() => {
      expiryTimer = undefined
      void request().catch(() => { /* 到期那一拍坏了,下一拍再来 */ })
    }, deps.idleTtlMs ?? EXECUTION_RECONCILE_IDLE_MS)
    expiryTimer.unref?.()
  }
  /**
   * 在途这一拍起跑之后又有非对账的请求/写(派发 / 交回 / 回执 / 改卡 / 显式刷新):它看不见,
   * 跑完补一拍。合并进来的调用方不拿在途那一拍的旧结果 —— 它等到补拍落地(链式合并:
   * 每个调用方拿到的都是「不早于它到来」的一拍,而同一拍仍只有一份在跑)。
   */
  let rerunRequested = false
  let followUp: Promise<ExecutionReconcileResult> | undefined
  /** notifyChanged 的代际:在途那一拍起跑之后又来过任务账写(代际变)才真正需要补拍;
   * 显式 request(验收口)撞见在途拍、其间没有新写时,在途拍已包含它要等的东西,不补。 */
  let notifyEpoch = 0
  /** 事件节流(第 3/4 轮):上一个**事件拍**的起跑时刻;间隔只量事件拍之间,冷拍/显式拍之后的首个事件拍立即跑。 */
  let lastEventRunAt = 0
  let eventTimer: ReturnType<typeof setTimeout> | undefined
  /** 有未对账的任务账写(awaitFresh 据此等到下一拍落地;一拍干净跑完才清)。 */
  let dirty = false
  const emptyResult = (): ExecutionReconcileResult => ({ tasks: { tasks: [], sprints: [], modules: [], project_meta: [], goals: [], goal_sprints: [], agent_cards: [], squads: [], timers: [], mcp: [] }, sessions: [] })
  function startRun(): Promise<ExecutionReconcileResult> {
    // 显式/到期这一拍让事件节拍作废:它读的是此刻的账,节流定时器再跑只是重复。
    if (eventTimer !== undefined) { clearTimeout(eventTimer); eventTimer = undefined }
    const epochAtStart = notifyEpoch
    const run = reconcile()
    void run.finally(() => {
      pending = undefined
      armExpiry()
      try { if (lastRunChanged) deps.onFinished?.() } catch { /* 通知坏了不连累对账 */ }
      if (rerunRequested && notifyEpoch !== epochAtStart) {
        rerunRequested = false
        followUp = startRun()
        const done = followUp
        void done.finally(() => { if (followUp === done) followUp = undefined }).catch(() => { if (followUp === done) followUp = undefined })
      } else {
        rerunRequested = false
        dirty = false // 一拍干净跑完:账上没有更新的写了
      }
    }).catch(() => { /* 这一拍坏了,调用方各自处理 */ })
    return run
  }
  function request(): Promise<ExecutionReconcileResult> {
    if (disposed) return Promise.resolve(lastResult ?? emptyResult())
    if (pending !== undefined) {
      if (applying) return pending
      rerunRequested = true
      const current = pending
      // 在途这一拍起于我来之前;它落地后若有补拍,补拍才是我的结果。
      // 其间没有新的任务账写(notifyEpoch 未变)就不补,在途拍的结果即是我的结果。
      return current.then(() => followUp ?? lastResult ?? emptyResult())
    }
    pending = startRun()
    return pending
  }
  function notifyChanged(): void {
    if (disposed || applying) return
    dirty = true
    notifyEpoch += 1
    const gap = deps.minEventGapMs ?? EXECUTION_RECONCILE_MIN_EVENT_GAP_MS
    // 间隔量的是「上一个事件拍」与这一个之间;本事件先占下它的拍位(定时到点起跑 = 正好隔满)。
    const previousEventAt = lastEventRunAt
    lastEventRunAt = Date.now()
    if (gap <= 0) { void request().catch(() => {}); return }
    if (pending !== undefined) return // 在途那一拍落地时会按 rerunNeeded 补拍
    const wait = gap - (Date.now() - previousEventAt)
    if (wait <= 0) { void request().catch(() => {}); return }
    if (eventTimer !== undefined) return // 已排着一次,合并进它
    eventTimer = setTimeout(() => {
      eventTimer = undefined
      void request().catch(() => { /* 这一拍坏了,下一拍再来 */ })
    }, wait)
    eventTimer.unref?.()
  }
  async function awaitFresh(): Promise<ExecutionReconcileResult | undefined> {
    if (disposed) return lastResult
    if (pending !== undefined || dirty) return await request().catch(() => lastResult)
    return lastResult
  }
  armExpiry()
  return {
    request,
    notifyChanged,
    snapshot: () => lastResult,
    awaitFresh,
    applying: () => applying,
    dispose() {
      disposed = true
      if (expiryTimer !== undefined) { clearTimeout(expiryTimer); expiryTimer = undefined }
      if (eventTimer !== undefined) { clearTimeout(eventTimer); eventTimer = undefined }
    },
  }
}
