import { useMemo, useState, type ReactNode } from 'react'
import type { WorkbenchState } from '../protocol.ts'
import { agentTitle, buildButlerScene, readSceneItem, type ButlerSceneModel, type SceneGroup, type SceneItem, type SceneRead } from './butlerSceneModel.ts'
import { cardTime, elapsedLabel } from './orb.ts'
import { DELIVERABLE_TITLES, OWNER_ASK_TITLES, SESSION_ACTIVITY_UNKNOWN, assigneeName, friendlyWhen } from '../protocol.ts'
// 「等你 n」那个数:全工作台同一份(src/waiting.ts)。
import { waitingOf } from '../waiting.ts'
import type { Proposal } from './proposals.ts'
import { businessExecutionView, runningTaskIdsOfRuns } from './businessExecutionModel.ts'
import { BusinessExecution } from './BusinessExecution.tsx'
import { ButlerTaskStage } from './ButlerTaskStage.tsx'
import { FxBeam } from './fx/Fx.tsx'
import { BEAM, confirmPulse } from './fx/fxModel.ts'
// 点开一件事 —— 在工作台里看,不跳到 DSH 原始界面(2026-09-25,卡 M;维护者点名的 bug)。
import { ItemTalk } from './ItemTalk.tsx'
// 点开「某家在跑的会话」(2026-09-25,卡 P):标题、项目、在做什么、最近几轮 —— 在工作台里看。
import { AgentActions } from './AgentActions.tsx'
import { HabitNoticeActions } from './HabitNoticeActions.tsx'
// 事项里那一段对话要的几样(SceneTalk)两张卡同一个形状,定义在 SessionDigestPanel 里,这里转出去。
import { ExternalSessionDetails, type SceneTalk } from './SessionDigestPanel.tsx'
export type { SceneTalk } from './SessionDigestPanel.tsx'

export { TaskConditionFacts } from './TaskConditionFacts.tsx'
import { TaskConditionFacts } from './TaskConditionFacts.tsx'
import { collabApi } from './collab/collabApi.ts'
import { useCollabRuns } from './useCollabRuns.ts'

const GROUP_TITLES: Record<SceneGroup, string> = { working: '进行中', queued: '排队', confirmation: '待确认', completed: '已完成', attention: '需要留意', canceled: '已取消' }
/**
 * 选题建议那一档的两颗键(2026-09-22 卡 ③)。**只在服务端给了 `topic` 时才画** ——
 * 画一颗按下去什么都不发生的按钮就是骗人(D13),所以上层没接这两个回调时也不画。
 *
 * 「加入选题池」在选题池里建一条卡、来源链接落进 `选题/<名>/来源.md`;
 * 「不要」只记住这一条(同链接/同标题不再推),**不是**「这个来源以后都别给我」——
 * 那是资讯页上另一颗键(「不看了」)的事,两件事差一个量级,措辞上要分得开。
 */
function TopicActions({ item, onAdopt, onDecline, busy }: {
  item: SceneItem
  onAdopt?: (feedId: string, title: string) => void
  onDecline?: (feedId: string, title: string) => void
  busy?: boolean
}) {
  const topic = item.topic
  if (topic === undefined || (onAdopt === undefined && onDecline === undefined)) return null
  return <div className="ben-wb__particle-actions ben-wb__topic-actions">
    {onAdopt && <button type="button" disabled={busy === true} aria-label={`把选题加入选题池:${item.title}`} onClick={() => onAdopt(topic.feed_id, item.title)}>加入选题池</button>}
    {onDecline && <button type="button" disabled={busy === true} aria-label={`不要这条选题:${item.title}`} onClick={() => onDecline(topic.feed_id, item.title)}>不要</button>}
  </div>
}

function Details({ item, onOpen, onConfirm, onProposal, onAdoptTopic, onDeclineTopic, topicBusy, onRetryMeeting, onMeetingOutcome, controls, talk, now }: {
  item: SceneItem
  onOpen: (id: string) => void
  onConfirm: (id: string) => void
  /** 证据里冒出来的下一步:「加上」(true)/「不要」(false)。不传就不画那两颗(D13)。 */
  onProposal?: (taskId: string, accept: boolean) => void
  onAdoptTopic?: (feedId: string, title: string) => void
  onDeclineTopic?: (feedId: string, title: string) => void
  topicBusy?: boolean
  /** 会议那一档的「重新整理」(2026-10-09):只重做没成的那一截。没接就不画(D13)。 */
  onRetryMeeting?: (meetingId: string) => void
  /** 会后那一句(2026-10-10):要定的定下来没有。没接就不画。 */
  onMeetingOutcome?: (meetingId: string, settled: 'yes' | 'partly' | 'no') => void
  /** 卡 O:花了多少 / 停掉这一件 / 到上限的三颗键 / 派不出去的修法(上层按这张卡画;没接就不画)。 */
  controls?: (item: SceneItem) => ReactNode
  /** 点开一件事要的取数那几样(同卡 M 的 SceneTalk);给了,某家会话那一张才读得到「最近几轮」。 */
  talk?: SceneTalk
  now?: string
}) {
  // 某家客户端里的一条会话(2026-09-25,卡 P):不画执行者标签(那是会话 id)、不画「打开对话」(那条会话不在 DSH 里)。
  if (item.external !== undefined) return <ExternalSessionDetails item={item} {...(now === undefined ? {} : { now })} {...(talk === undefined ? {} : { talk })} />
  return <>
    {item.context && <small>{item.context}</small>}
    <h3>{item.title}</h3>
    <p>{item.label}{item.waitLabel ? ` · ${item.waitLabel}` : ''}</p>
    {item.description && <p>{item.description}</p>}
    {item.note && <p>{item.note}</p>}
    {/* 现在到哪 · 依据 · 几点看的(2026-09-25 卡 N):按证据,不按口述。依据只写出处与时刻,不露路径。 */}
    {item.evidence && <div className="ben-wb__particle-progress">
      <small>现在到哪</small>
      <p data-state={item.evidence.state}>{item.evidence.line}</p>
      {item.evidence.state === 'mismatch' && item.evidence.mismatch && <p>和卡上写的对不上:{item.evidence.mismatch}</p>}
      {item.evidence.basis[0] && <small>依据:{item.evidence.basis[0].source}{item.evidence.basis[0].at ? ` · ${friendlyWhen(item.evidence.basis[0].at, now)}` : ''} · {friendlyWhen(item.evidence.checked_at, now)} 看的</small>}
    </div>}
    {/* 座机打过电话吗、他接了没有(2026-09-21)。只转述台账,见 client/callOutLine.ts。 */}
    {item.callOut && <p className="ben-wb__particle-callout">{item.callOut}</p>}
    {/* 会话答完时服务端挂上的回答(2026-09-16):验收的对象是它,不是一句「完成」。 */}
    {item.reply && <div className="ben-wb__particle-reply"><small>{DELIVERABLE_TITLES.reply}</small><p>{item.reply}</p></div>}
    {item.pending && <p>会话开启中</p>}
    {/* 说是在办、却还没看到哪一家在办它(2026-09-25,卡 Q;统筹:「证据」是内部说法)—— 同卡 P 那一句「读不到它在做什么」。 */}
    {item.group === 'working' && item.executors.length === 0 && <p>在办 · {SESSION_ACTIVITY_UNKNOWN}</p>}
    {item.executors
      // 接上了对话那一段(卡 M):事务官自己那条会话由下面那一段说(在办到哪、她说了什么),这里不再摆一遍。
      .filter(executor => talk === undefined || !executor.id.startsWith('dsh:'))
      .map(executor => <div className="ben-wb__particle-executor" key={executor.id}>
      {/* 不露会话 id 这类内部的东西(维护者规矩第 3 条):只写是哪一家。老调用方照旧。 */}
      <small>{talk === undefined ? executor.label : agentTitle(executor.id.split(':')[0] ?? '')}</small>
      <p>{executor.offline ? (talk === undefined ? 'Agent 掉线 · 最后进度未更新' : '掉线了 · 最后的进度没更新') : executor.session?.status === 'running' ? '正在执行' : executor.session?.status === 'waiting' ? '等待中' : executor.session?.status === 'error' ? (executor.session.reason === 'interrupted' ? '已停下(按了停止,或者到上限先停的)' : '执行出错') : executor.session?.status === 'done' ? '会话已结束' : '执行状态未知'}</p>
      {executor.session?.summary && <p>{executor.session.summary}</p>}
    </div>)}
    {controls?.(item)}
    <div className="ben-wb__particle-actions">
      {/* 没接对话那一段时(老调用方)才画这颗:它会把整个壳切到 DSH 原始界面。接上了就在下面那一段里看。 */}
      {item.sessionId && talk === undefined && <button type="button" aria-label={`打开事项:${item.title}`} onClick={() => onOpen(item.sessionId!)}>打开对话 ↗</button>}
      {/* 2026-10-26(卡「事务官页接管队列」):「确认」只画在事务官核过、标了四类拍板请求的卡上;
          待核验队列不摊给他(未知不自动放行)——那几张卡的状态字由 butlerSceneModel 写成「事务官核验中」。 */}
      {item.confirmTaskId && <button type="button" aria-label={`确认收下:${item.title}`} onClick={() => onConfirm(item.confirmTaskId!)}>确认</button>}
      {/* 带方案与依据那一问摆出来再让他点(2026-10-26,卡「事务官页接管队列」;与手机 InboxPage 同一份口径)。 */}
      {item.ownerAsk && <div className="ben-wb__askrow">
        <small>{`要拍板:${OWNER_ASK_TITLES[item.ownerAsk.kind]}`}</small>
        <small>{`方案:${item.ownerAsk.proposal}`}</small>
        <small>{`依据:${item.ownerAsk.basis}`}</small>
      </div>}
      {item.meeting?.retryable === true && onRetryMeeting && <button type="button" aria-label={`重新整理这场会:${item.title}`} onClick={() => onRetryMeeting(item.meeting!.id)}>重新整理</button>}
      {item.meeting?.ask_outcome !== undefined && onMeetingOutcome && <span className="ben-wb__meeting-outcome">
        <small>{`这场要定「${item.meeting.ask_outcome}」,定下来了吗?`}</small>
        <button type="button" onClick={() => onMeetingOutcome(item.meeting!.id, 'yes')}>定下来了</button>
        <button type="button" onClick={() => onMeetingOutcome(item.meeting!.id, 'partly')}>定了一部分</button>
        <button type="button" onClick={() => onMeetingOutcome(item.meeting!.id, 'no')}>没定下来</button>
      </span>}
      {item.proposalTaskId && onProposal && <>
        <button type="button" aria-label={`加上这张卡:${item.title}`} onClick={() => onProposal(item.proposalTaskId!, true)}>加上</button>
        <button type="button" aria-label={`不要这张卡:${item.title}`} onClick={() => onProposal(item.proposalTaskId!, false)}>不要</button>
      </>}
    </div>
    {item.sessionId !== undefined && talk !== undefined && (
      <ItemTalk
        state={talk.state}
        {...(item.kind === 'mine' ? { taskId: item.id } : {})}
        sessionId={item.sessionId}
        version={item.version}
        baseUrl={talk.baseUrl}
        fetchImpl={talk.fetchImpl}
        onOpenRaw={onOpen}
        {...(talk.onReceipt === undefined ? {} : { onReceipt: talk.onReceipt })}
      />
    )}
    <TopicActions item={item} {...(onAdoptTopic === undefined ? {} : { onAdopt: onAdoptTopic })} {...(onDeclineTopic === undefined ? {} : { onDecline: onDeclineTopic })} {...(topicBusy === undefined ? {} : { busy: topicBusy })} />
    {/* Agent 登记表那一档(卡 Q):「接上 / 知道了 / 这不是 Agent」。 */}
    <AgentActions item={item} talk={talk} />
    {/* 新学到一条(2026-10-10):「撤掉 / 知道了」。 */}
    <HabitNoticeActions item={item} talk={talk} />
  </>
}
export function ButlerScene({ state, onOpen, onConfirm, onProposal, onAdoptTopic, onDeclineTopic, topicBusy, onRetryMeeting, onMeetingOutcome, proposals = [], children, orb, visible = true, onRead, read: externalRead, focusedId, onFocus, asks, tools, itemControls, talk, stageGlow, compact = false, onLocate }: {
  state: WorkbenchState
  /**
   * 事项里那一段对话(2026-09-25,卡 M):她说了什么、在办到哪、在等他的那一问。给了就在工作台里看,
   * 「打开对话 ↗」那颗(把整个壳切到 DSH 原始界面)换成最底下一个不起眼的「看原始对话」。
   * 卡 P 也用它读「某家在跑的会话」的最近几轮(`GET /sessions/digest`)。不给就只画卡片上已有的几样。
   */
  talk?: { baseUrl: string, fetchImpl: typeof fetch, onReceipt?: (text: string) => void }
  /**
   * 球下面那一区最上头的卡(2026-09-25):要他处理的那几张 —— 待批的操作、小工具需求、布局改动、固化提议、
   * 以及卡 B 那张「我照你说的摆好了」。**这一区自己滚**,再多也挤不掉上面的球。
   */
  asks?: ReactNode
  /** 球那一格标题行右边的小键(抽屉 ⋯、外观设置)。 */
  /** 卡 O:聚焦那张卡上「派活的眼睛」那几样。 */
  itemControls?: (item: SceneItem) => ReactNode
  tools?: ReactNode
  onOpen: (id: string) => void
  onConfirm: (id: string) => void
  /** 证据里冒出来的下一步(卡 N):「加上」挪进「待办」,「不要」改取消。不传就不画那两颗。 */
  onProposal?: (taskId: string, accept: boolean) => void
  /** 选题建议上「加入选题池」。不传就不画那颗键(见 TopicActions)。 */
  /** 会议那一档的「重新整理」(2026-10-09)。 */
  onRetryMeeting?: (meetingId: string) => void
  /** 会议那一档的会后那一句(2026-10-10):要定的定下来没有。 */
  onMeetingOutcome?: (meetingId: string, settled: 'yes' | 'partly' | 'no') => void
  onAdoptTopic?: (feedId: string, title: string) => void
  /** 选题建议上「不要」。不传就不画那颗键。 */
  onDeclineTopic?: (feedId: string, title: string) => void
  /** 这会儿有一次选题操作在路上(两颗键一起禁用,免得按两下建两张卡)。 */
  topicBusy?: boolean
  proposals?: readonly Proposal[]
  children: ReactNode | ((model: ButlerSceneModel) => ReactNode)
  orb?: ReactNode
  visible?: boolean
  read?: SceneRead
  onRead?: (read: SceneRead) => void
  focusedId?: string | null
  onFocus?: (id: string | null) => void
  /**
   * 台上哪一张卡走光(2026-09-27,卡 DD 追加)。上层算:「要他处理的第一件」已经在台上有卡时就是那张卡的 id,
   * 球下那一行随之不走光 —— 这一屏的强效果仍然最多一个。缺席 = 台上没有一张走光(在跑的卡从不单独走光,卡 P 补三)。
   */
  stageGlow?: string
  /**
   * 悬浮球展开窗那一版(2026-10-27,合并稿第四、五节):只放待你处理、最近结果、在跑的事项、交代入口。
   * 球周围的执行星座与事项收纳夹不画(由协作区表达);在跑的那几件一行一件,能去协作区看。
   */
  compact?: boolean
  /** 「在协作区查看」:打开协作区并定位那件事项。 */
  onLocate?: (taskId: string) => void
}) {
  const [localFocus, setLocalFocus] = useState<string | null>(null), [localRead, setLocalRead] = useState<SceneRead>({})
  const [executionPanel, setExecutionPanel] = useState<HTMLDivElement | null>(null)
  const [executionOpen, setExecutionOpen] = useState(false)
  const [expanded, setExpanded] = useState<Partial<Record<SceneGroup, boolean>>>({})
  const focus = focusedId === undefined ? localFocus : focusedId
  const setFocus = (id: string | null) => { setLocalFocus(id); onFocus?.(id) }
  const read = externalRead ?? localRead, model = buildButlerScene(state, read, proposals)
  // 台上那几张会话卡(卡 ST)不在 `items` 里(它们不进下面那几个收纳夹),所以点开的那一张两处都找。
  // 多人协作区总开关(2026-11-09):关着时这两条 /collab/* 捷径都不接,退回快照口径。
  const collabApiOn = state.collab_enabled === true
  const conditionApi = useMemo(() => !collabApiOn || talk === undefined ? undefined : collabApi(talk.baseUrl, talk.fetchImpl), [collabApiOn, talk?.baseUrl, talk?.fetchImpl])
  // 在跑哪几件:与展开窗同一本账(/collab/runs)。runFacts 是数组时按片段判;没接上('missing'/undefined)退回快照口径。
  const runFacts = useCollabRuns(state, !collabApiOn || talk === undefined ? undefined : { baseUrl: talk.baseUrl, fetchImpl: talk.fetchImpl })
  const runTaskIds = Array.isArray(runFacts) ? runningTaskIdsOfRuns(runFacts) : undefined
  const businessIds = runTaskIds ?? (state.running === undefined ? model.stage.filter(item => item.external === undefined).map(item => item.id) : businessExecutionView(state).ids)
  const selected = model.items.find(item => item.id === focus) ?? model.stage.find(item => item.id === focus)
  const selectedTask = state.tasks?.tasks.find(one => one.id === selected?.id)
  const selectedGoal = state.tasks?.goals?.find(one => one.id === selectedTask?.goal_id)
  const conditionFacts = selectedTask !== undefined && selectedGoal?.conditions?.some(one => one.task_id === selectedTask.id) && conditionApi !== undefined
    ? <TaskConditionFacts taskId={selectedTask.id} goalId={selectedGoal.id} revision={JSON.stringify([selectedTask.round, selectedTask.updated_at, selectedTask.receipt, selectedGoal.updated_at, state.stale, state.tasks?.tasks.map(one => [one.id, one.status, one.round, one.updated_at])])} api={conditionApi} history={selectedGoal.conditions} round={selectedTask.round ?? 1} /> : null
  const choose = (item: SceneItem) => { setFocus(item.id); const next = readSceneItem(read, item); setLocalRead(next); onRead?.(next) }
  // 进行中的卡写「进行中 · 12 分钟」而不是建卡时刻(2026-09-16 第 4 条):起点取卡最后一次改状态的时刻。
  const statusLine = (item: SceneItem): string => {
    if (item.group === 'working') {
      const elapsed = elapsedLabel(item.at, state.now)
      return elapsed === undefined ? '进行中' : `进行中 · ${elapsed}`
    }
    const time = item.at === undefined ? undefined : cardTime(item.at)
    return `${item.waitLabel ?? item.label ?? ''}${time === undefined ? '' : ` · ${time}`}`
  }
  const folder = (group: SceneGroup, always = false) => {
    // 台上的(在执行、或排队等会话)不再在夹子里摆第二遍。
    const items = model.groups[group].filter(item => !item.executing && !item.pending)
    if (!always && items.length === 0) return null
    const open = expanded[group] === true
    const node = <section key={group} className="ben-wb__result-folder" aria-label={GROUP_TITLES[group]} data-group={group} data-open={open} data-empty={items.length === 0}>
      <header><h4>{GROUP_TITLES[group]}</h4><span>{items.length.toString().padStart(2, '0')}</span></header>
      {items.length === 0 ? <p className="ben-wb__folder-empty">{group === 'confirmation' ? '没有等待确认的事' : group === 'completed' ? '完成的事项会收在这里' : model.groups.attention.some(item => item.executing) ? '需留意的执行事项见上方' : '暂时没有需要留意的事'}</p> : <ul>
        {(open ? items : items.slice(0, 1)).map(item => <li key={item.id} data-notice={item.notice} data-unread={item.unread} data-selected={focus === item.id}>
          <button type="button" aria-label={`查看事项:${item.title}`} aria-pressed={focus === item.id} onClick={() => choose(item)}>
            <span className="ben-wb__particle-dot" aria-hidden="true" /><span>{item.context && <small className="ben-wb__folder-context">{item.context}</small>}<strong>{item.title}</strong><small>{statusLine(item)}</small>{item.note && <small className="ben-wb__folder-note">{item.note}</small>}{item.callOut && <small className="ben-wb__folder-note">{item.callOut}</small>}</span>
            {item.unread && item.notice !== 'neutral' && <small className="ben-wb__folder-unread">未读</small>}
          </button>
        </li>)}
      </ul>}
      {items.length > 1 && <button className="ben-wb__folder-toggle" type="button" aria-label={`${open ? '收起' : '展开全部'}${GROUP_TITLES[group]}`} aria-expanded={open} onClick={() => setExpanded(value => ({ ...value, [group]: !open }))}>{open ? '收起' : `查看全部 ${items.length} 件`}<span aria-hidden="true">{open ? '−' : '+'}</span></button>}
    </section>
    // 「待确认」那一夹:有东西等你拍板时轻轻呼吸(琥珀,与球的「需要你」同色系)。弱效果,不占强效果名额。
    return group === 'confirmation'
      ? <FxBeam key={group} name="confirm" spec={BEAM.confirm} active={confirmPulse({ visible, count: items.length })}>{node}</FxBeam>
      : node
  }
  /*
   * 两截(2026-09-25,卡 feat/first-look-orb-top):
   *   上 —— 球的舞台(在办的事围着球连线)+ 球下一行状态。固定在最上面,不随下面滚;
   *   下 —— 要他处理的卡、点开的那张详情、事项收纳。自己一个滚动区。
   * 以前整块一起滚,底下几张长卡(那张「这 4 次你都在说…」)一多,滚动区只剩最上面一行「此刻留给你」,球被挤没了。
   */
  if (compact) {
    // 在跑哪几件:优先 /collab/runs 那本账;没接上(老服务端 / 服务没应答)退回 /state.running 快照口径。
    const runningTasks = (runFacts === undefined || runFacts === 'missing'
      ? businessIds
      : runningTaskIdsOfRuns(runFacts))
      .map(id => state.tasks?.tasks.find(one => one.id === id)).filter((one): one is NonNullable<typeof one> => one !== undefined)
    return <div className="ben-wb__particle-scene ben-wb__particle-scene--compact" data-focused={Boolean(selected)}>
      <div className="ben-wb__scene-below" role="region" aria-label="事务官小窗">
        {/* 「更多」:抽屉(全部暂停、试铃、在盯着的事、今晨快报)与外观设置,两颗键还在原来的样子。 */}
        {tools !== undefined && <div className="ben-wb__float-tools">{tools}</div>}
        <div className="ben-wb__items-center">{typeof children === 'function' ? children(model) : children}</div>
        {asks !== undefined && <div className="ben-wb__asks">{asks}</div>}
        <section className="ben-wb__float-running" role="region" aria-label="在跑的事项">
          <h4 className="ben-wb__stack-head">在跑的事项 <span>{runningTasks.length}</span></h4>
          {runningTasks.length === 0 && <p className="ben-wb__items-empty">{state.running === undefined ? '执行状态读不到' : '这会儿没有在跑的事项'}</p>}
          <ul>{runningTasks.map(task => <li key={task.id}>
            <span className="ben-wb__float-running-title">{task.title}</span>
            <small>{task.assignee === undefined ? '执行者未知' : agentTitle(task.assignee, state) === task.assignee ? assigneeName(task.assignee) : agentTitle(task.assignee, state)}</small>
            {onLocate !== undefined && <button type="button" aria-label={`在协作区查看 ${task.title}`} onClick={() => onLocate(task.id)}>在协作区查看 ↗</button>}
          </li>)}</ul>
        </section>
      </div>
      {talk !== undefined && selected && <div className="ben-wb__item-sheet" role="dialog" aria-label="当前聚焦事项">
        <div className="ben-wb__particle-focus"><article data-notice={selected.notice}>
          <header><small>当前聚焦事项</small><button type="button" onClick={() => setFocus(null)}>返回待机</button></header>
          {conditionFacts}<Details item={selected} onOpen={onOpen} onConfirm={onConfirm} {...(itemControls === undefined ? {} : { controls: itemControls })} {...(onProposal === undefined ? {} : { onProposal })} {...(onAdoptTopic === undefined ? {} : { onAdoptTopic })} {...(onDeclineTopic === undefined ? {} : { onDeclineTopic })} {...(topicBusy === undefined ? {} : { topicBusy })} {...(onRetryMeeting === undefined ? {} : { onRetryMeeting })} {...(onMeetingOutcome === undefined ? {} : { onMeetingOutcome })} now={state.now} talk={{ ...talk, state }} />
        </article></div>
      </div>}
    </div>
  }
  return <div className="ben-wb__particle-scene" data-focused={Boolean(selected)}>
    <div className="ben-wb__scene-top" data-testid="ben-wb-orb-stage">
      {/*
        台上按**会话**画卡(2026-09-26,卡 ST;维护者 19:20:「机器上正在跑的、我安排的事,不管是通过事务官
        发的还是直接在那家客户端里说的,就是一张卡」)。`model.stage` 里是「在办 / 排队的事项」+「每一条会话」;
        「正在执行 n · 等你 k」那行数字读 `/state.running` / `/state.waiting`,不数台上的卡;
        接了 /collab/runs 时(2026-10-28 残留清理)「正在执行 n」与台上哪几张在数改按运行片段判,没接上退回快照口径。
      */}
      <ButlerTaskStage executionSummary={<BusinessExecution panelRoot={executionPanel} onExpandedChange={setExecutionOpen} state={state} runFacts={runFacts} onOpenTask={id => { const item = model.items.find(one => one.id === id); if (item !== undefined) choose(item) }} />} items={model.stage.filter(item => item.executing && businessIds.includes(item.id))} now={state.now} focus={focus} onChoose={choose} orb={orb} visible={visible} tools={tools} registry={state} running={runTaskIds?.length ?? model.running} waiting={waitingOf(state).count} {...(talk === undefined ? {} : { baseUrl: talk.baseUrl })} {...(stageGlow === undefined ? {} : { glow: stageGlow })} />
      <div className="ben-wb__items-center">{typeof children === 'function' ? children(model) : children}</div>
    </div>
    <div className="ben-wb__scene-below" data-execution-open={executionOpen} role="region" aria-label="球下面:要你处理的与事项收纳">
    <div ref={setExecutionPanel} className="ben-wb__execution-panel" />
    {model.stage.some(item => !businessIds.includes(item.id) || !item.executing) && <details className="ben-wb__other-items">
      <summary>会话与排队 · 未计入业务执行</summary>
      <ul aria-label="会话与排队">{model.stage.filter(item => !businessIds.includes(item.id) || !item.executing).map(item => <li key={item.id}><button type="button" onClick={() => choose(item)}>{item.title} · {item.pending ? '排队' : item.sessionCard?.status ?? item.label}</button></li>)}</ul>
    </details>}
    {asks !== undefined && <div className="ben-wb__asks">{asks}</div>}
    {/* 没接对话那一段(老调用方):聚焦的那一张照旧摆在球下这一区。 */}
    {talk === undefined && <aside className="ben-wb__particle-focus" aria-label="当前聚焦事项">{selected && <article data-notice={selected.notice}>
      <header><small>当前聚焦事项</small><button type="button" onClick={() => setFocus(null)}>返回待机</button></header>
      {conditionFacts}<Details item={selected} onOpen={onOpen} onConfirm={onConfirm} {...(itemControls === undefined ? {} : { controls: itemControls })} {...(onProposal === undefined ? {} : { onProposal })} {...(onAdoptTopic === undefined ? {} : { onAdoptTopic })} {...(onDeclineTopic === undefined ? {} : { onDeclineTopic })} {...(topicBusy === undefined ? {} : { topicBusy })} {...(onRetryMeeting === undefined ? {} : { onRetryMeeting })} {...(onMeetingOutcome === undefined ? {} : { onMeetingOutcome })} now={state.now} />
    </article>}</aside>}
    <aside className="ben-wb__particle-storage" aria-label="事项收纳">
      {model.items.length === 0 && <p>{state.tasks === undefined || state.butler_inbox === undefined ? '事项数据未接入' : '这会儿没有事项。'}</p>}
      {model.frozen && <p role="status">Agent 掉线 · 保留最后已知状态</p>}
      {model.groups.working.some(item => !item.executing) && <div className="ben-wb__secondary-folders">{folder('working')}</div>}
      {(model.groups.queued.length > 0 || model.groups.canceled.length > 0) && <details className="ben-wb__other-items">
        <summary>排队 {model.groups.queued.length} · 已取消 {model.groups.canceled.length}<span>查看记录</span></summary>
        <div className="ben-wb__secondary-folders">{folder('queued')}{folder('canceled')}</div>
      </details>}
      <div className="ben-wb__result-folders" aria-label="结果事项夹">{folder('confirmation', true)}{folder('completed', true)}{folder('attention', true)}</div>
    </aside>
    </div>
    {/*
      点开一件事(2026-09-25,卡 M):整张摊在这一栏上面看 —— 真壳 1475×812 那样,球下那一区只剩一行高,
      原来那张「当前聚焦事项」摆在那一行里等于看不见;以前唯一看得清的路是「打开对话 ↗」,一点就把整个壳换成 DSH 原始界面。
      现在:她在办到哪、在等你的那一问、对话,都在这一张里;「返回待机」收起。输入框不盖,照样能跟她说话。
    */}
    {talk !== undefined && selected && <div className="ben-wb__item-sheet" role="dialog" aria-label="当前聚焦事项">
      <div className="ben-wb__particle-focus"><article data-notice={selected.notice}>
        <header><small>当前聚焦事项</small><button type="button" onClick={() => setFocus(null)}>返回待机</button></header>
        {/* 某家在跑的会话(卡 P)也在这一张里看:标题、在做什么、最近几轮(ExternalSessionDetails 当场读)。 */}
        {conditionFacts}<Details item={selected} onOpen={onOpen} onConfirm={onConfirm} {...(itemControls === undefined ? {} : { controls: itemControls })} {...(onProposal === undefined ? {} : { onProposal })} {...(onAdoptTopic === undefined ? {} : { onAdoptTopic })} {...(onDeclineTopic === undefined ? {} : { onDeclineTopic })} {...(topicBusy === undefined ? {} : { topicBusy })} {...(onRetryMeeting === undefined ? {} : { onRetryMeeting })} {...(onMeetingOutcome === undefined ? {} : { onMeetingOutcome })} now={state.now} talk={{ ...talk, state }} />
      </article></div>
    </div>}
  </div>
}
