/**
 * 粒子球此刻的状态 —— **全工作台只有这一个函数算它**(2026-10-04,卡「球的颜色一处算」;
 * 做法照卡 M 的 `waiting.ts` 与卡 V 的 `running.ts`)。
 *
 * 维护者 10-04 原话(经工作台捎话):「有一个镜头发现手机的粒子球和电脑上粒子球两个的状态不一样、
 * 颜色比如状态……我担心他跟到最新版两个端还是会有一样的问题」。
 *
 * 病根不是某一端算错,是**两端各自从 /state 推算**:
 *   - 电脑:`client/butlerSceneModel.ts` 的 `activeFailureOf` / `callingNowOf` / `orbNoticeOf`
 *     (0.4.96 刚改成「只认此刻正在执行的那件出错才红」,历史阻塞去球下「受阻 N」);
 *   - 手机:`butler-app/src/swarm/orbState.ts` 的 `signalsFromState` —— 红的判据还是
 *     「有一件**还开着**的事出过错」(`isOpenFailure`,含历史阻塞)=> 永久红;「等你」的口径也不同。
 * 0.4.96 之后两端更不一致了。
 *
 * 现在:服务端拼 /state 时用这个函数算好放进 `/state.orb`,**电脑与手机都只显示那一格**。
 * 老服务没给这一格时两端各自退回本地推算(行为与 0.4.96 一字不差)。
 *
 * 判据就是 0.4.96 电脑端那一套(维护者当天拍板):
 *   - **红**只认「此刻台上**正在执行**的那件出错」({@link activeFailureOf});历史阻塞只进 {@link OrbView.blocked};
 *   - **琥珀**= 有事停着等她回话(`/state.waiting`,卡 M 那一堆)/ 来电在响 / 通话中;
 *   - **在办**认 `/state.running` 的确定数量或已观测业务执行；总数未知不抹去已见开工—— 颜色与形态不另开一档;
 *   - `completed` **故意不发**:电脑把它折成 `neutral`、手机从来不产生它。
 *
 * 放在 `src/` 根上(不在 `client/` 里):服务端 import 不了客户端(同 `waiting.ts` / `running.ts` 的理由)。
 */
import { isItemExecuting, isTrackedItem, type ButlerInboxItem, type OrbView, type TaskView, type WorkbenchState } from './protocol.ts'
import { runningOf } from './running.ts'
import { waitingOnHim } from './waiting.ts'

export type OrbSource = Pick<WorkbenchState, 'sessions' | 'agents' | 'stale'>
  & Pick<Partial<WorkbenchState>, 'tasks' | 'butler_inbox' | 'agent_registry' | 'running' | 'waiting'
    | 'questions' | 'approvals' | 'materialize' | 'dev_tool' | 'layout_ask' | 'evolve'
    | 'ringing' | 'test_ringing' | 'call_out' | 'answers' | 'fresh_results'>

/**
 * 这件事此刻**真出错了、还没处理**。与 `client/butlerSceneModel.ts` 里事项那一支的 `failed`
 * 逐字同一条判据(2026-09-25 晚,统筹:「红色只用于真错误 —— 有真失败且还没处理才红」):
 * 收场了的(办完 / 取消 / 等她验收)一律不算;他按的停止(`dispatch.stopped`)不是出错。
 */
function failedOf(task: TaskView, state: Pick<OrbSource, 'sessions'>): boolean {
  if (['done', 'canceled', 'confirm'].includes(task.status)) return false
  if (task.block_reason === 'error') return true
  if (task.client_dispatch?.status === 'failed') return true
  if (task.dispatch?.status === 'failed' && task.dispatch.stopped === undefined) return true
  return (task.links ?? []).some((link) => {
    const session = state.sessions.find(one => one.agent === link.agent && one.session_id === link.session_id)
    return session?.status === 'error' && session.reason !== 'interrupted'
  })
}

/**
 * 这件事此刻**卡住了**:卡在「阻塞」那一列、出错了、或者挂着的那家下线了 / 在等她。与电脑端 `SceneItem.blocked` 逐字同一条。
 * 快照冻结(`stale`)时读不到各家此刻的样子,「在等某家」那一条不算 —— 掉线不是受阻,不把每件挂了会话的事都数进来。
 */
function blockedOf(task: TaskView, state: Pick<OrbSource, 'sessions' | 'agents' | 'stale'>): boolean {
  if (task.status === 'blocked') return true
  if (failedOf(task, state)) return true
  if (['done', 'canceled', 'confirm'].includes(task.status)) return false
  if (state.stale) return false
  return (task.links ?? []).some((link) => {
    const session = state.sessions.find(one => one.agent === link.agent && one.session_id === link.session_id)
    const agent = state.agents.find(one => one.id === link.agent)
    return session?.status === 'offline' || agent?.online === false || session?.status === 'waiting'
  })
}

/** 球周围摆得出来的那几件事项(与 `buildButlerScene` 第一个循环的门同一条:是事项,或者收件箱里有它的回执)。 */
function stagedTasks(state: OrbSource): readonly TaskView[] {
  const inbox = state.butler_inbox?.items ?? []
  return (state.tasks?.tasks ?? []).filter(task => isTrackedItem(task) || inbox.some(item => item.task_id === task.id))
}

/**
 * 此刻**正在执行**的那几件里有没有一件出错(球该不该红)。
 *
 * 历史上出过错、早就不跑了的那几件**不在这里** —— 它们是球下的「受阻 N」。
 * 「正在执行」认 `isItemExecuting`(protocol.ts,全仓库唯一口径:事项 + `doing` + 挂的会话在跑 + 那家在线 + 快照没冻结)。
 */
export function activeFailureOf(state: OrbSource): boolean {
  const snapshot = { sessions: state.sessions, agents: state.agents, stale: state.stale }
  return stagedTasks(state).some(task => isItemExecuting(task, snapshot) && failedOf(task, state))
}

/**
 * 此刻在通话里吗(来电在响 / 已接通还没挂 / 她刚按的试铃)。
 *
 * 读的全是现成的那几格:`/state.ringing`、`/state.test_ringing`、`/state.call_out.entries`。**不自己记状态。**
 * 与 0.4.96 电脑端 `callingNowOf` 逐字同一条。
 */
export function callingNowOf(state: Pick<OrbSource, 'ringing' | 'test_ringing' | 'call_out'>): boolean {
  if ((state.ringing ?? []).length > 0) return true
  if (state.test_ringing === true) return true
  return (state.call_out?.entries ?? []).some(entry =>
    entry.state === 'ringing' || (entry.state === 'answered' && entry.ended_at === undefined))
}

/**
 * 受阻几件:卡住的那几件事项 + 收件箱里那几条「出错」的事件(它们没挂在任何一张事项上,
 * 挂上了的已经作为那张事项数过一次)。与电脑端 0.4.96 球下那一行同一个数。
 */
export function blockedCountOf(state: OrbSource): number {
  const tasks = stagedTasks(state)
  let count = tasks.filter(task => blockedOf(task, state)).length
  const taskIds = new Set(tasks.map(task => task.id))
  const seen = new Set<string>()
  for (const event of state.butler_inbox?.items ?? []) {
    const id = event.task_id ?? event.id
    // 挂在某张事项卡上了(那张卡已经数过),或者同一个 id 已经算过一次。
    if (taskIds.has(id) || seen.has(id)) continue
    seen.add(id)
    if (event.wait_reason === 'error' && !settledEvent(event, state)) count += 1
  }
  return count
}

/** 这条事件说的那件事已经收场了(办完 / 取消):它当初那条「出错」不再算。 */
function settledEvent(event: ButlerInboxItem, state: OrbSource): boolean {
  if (event.task_id === undefined) return false
  return (state.tasks?.tasks ?? []).some(task => task.id === event.task_id && (task.status === 'done' || task.status === 'canceled'))
}

/**
 * 球此刻该是什么样 —— 两端都读这一份。
 *
 * 优先级:当前故障(红)> 等她回话 / 通话中(琥珀)> 中性。历史阻塞一律只进 `blocked`。
 * `waiting` 取服务端算好的 `/state.waiting`(卡 M,「同一件事的数字各处一致」);没有那一格就用同一个函数就地算。
 * `working` 同理取 `/state.running`；总数未知但已观测业务开工时仍在办，快照冻结时不编一个在办。
 */
export function orbCellOf(state: OrbSource): OrbView {
  const activeFailure = activeFailureOf(state)
  const calling = callingNowOf(state)
  const waiting = (state.waiting ?? waitingOnHim({ ...state, sessions: state.sessions })).count > 0
  const running = runningOf({ ...state, sessions: state.sessions, agents: state.agents, stale: state.stale })
  const working = !state.stale && (running.count ?? running.observed_count ?? 0) > 0
  const notice: OrbView['notice'] = activeFailure ? 'failed' : waiting || calling ? 'confirmation' : 'neutral'
  /**
   * ★ **一条新回答 / 一张「刚办完」**(2026-10-04,卡 `claude/answer-comes-to-her`)。
   *
   * 卡里要的是「一条新回答出现时球怎么动、要不要琥珀,按 `/state.orb` 一处算」——
   * **这一处的答案是:不要琥珀**,两格各自记下来、两端只拿去画球下那一行 / 一颗小点。
   *
   * 为什么(统筹 10-04 定,照着她已有的两条口径推):
   * - 琥珀的意思全仓库只有一个:**有事停着等你回话**(卡 M、`waiting.ts` 那一堆)。
   *   一条回答不等她做任何事 —— 染琥珀,球就会在她每问一句话之后长期发黄,
   *   「等你」那一档随之不值钱(维护者 09-18 两次说「又是黄色的笑脸」正是这个病)。
   * - 「刚办完」同理:2026-09-28 已经定过「完成那一类不打电话,只发通知」——
   *   办完是好消息,不是一件等她的事。要她点的只是「看过 / 划掉」,那一下在卡上。
   *
   * 要改成琥珀(或者新开一档颜色)只动这三行,两端一个字都不用改 —— 这正是这一格的用处。
   */
  const answer = ((state.answers?.unseen ?? 0) > 0) || undefined
  const freshResult = ((state.fresh_results?.items.length ?? 0) > 0) || undefined
  return {
    notice,
    working,
    blocked: blockedCountOf(state),
    active_failure: activeFailure,
    waiting,
    calling,
    ...(answer === undefined ? {} : { answer }),
    ...(freshResult === undefined ? {} : { fresh_result: freshResult }),
  }
}
