/**
 * 功能点详情弹窗。
 *
 * 2026-08-25 Ben 的原话:"每一个功能卡片点击之后展开一个弹窗吧,你现在的交互,很反人类"。
 * 原来是**就地展开**——点一张卡,那一格里长出一堆输入框,同一行其他泳道跟着被顶下去,
 * 整块看板在你打字的时候一直在动。改成弹窗之后看板本身完全不动,编辑区也终于放得下
 * 描述、关联窗口这些多行内容。
 *
 * 关窗有三条路:右上角 ✕、点遮罩、按 Esc。三条都要有——只留一条的弹窗才是真的反人类。
 */
import { useEffect, useRef, useState } from 'react'
import type { AgentEntryView, SessionView, TaskAssignee, TaskPriority, TaskStatus, TaskView, TaskDeliverable, TaskDeliverableKind, UsageTotals } from '../protocol.ts'
import { TASK_PRIORITIES, TASK_STATUSES, WAIT_REASONS, WAIT_REASON_TITLES, canTransition, isPersonAssignee, MANUAL_DELIVERABLE_KINDS, billedTokens } from '../protocol.ts'
import { ASSIGNEE_TITLES, PRIORITY_TITLES, SOURCE_LABELS, STATUS_TITLES, sessionOfLink, DELIVERABLE_TITLES, formatSpend, needsDeliverable } from './boardModel.ts'
import type { TaskPatch } from './TaskCard.tsx'
import { coverClass, useDialogCover, useVeilSlot, type VeilTarget } from './useVeilSlot.ts'
import { FeatureDeck } from './FeatureDeck.tsx'
import { ProgressBlock, type ProgressActions } from './ProgressBlock.tsx'
import { StandingBlock } from './StandingBlock.tsx'
import { agentFaceOf, assigneePicker } from './agentRegistryView.ts'

export function TaskDialog({
  task, moduleName, sessions, sessionUsage, branches, repoPath, filePathHints,
  onClose, onMove, onUpdate, onDelete, veil, deckBaseUrl, deckFetch, progressActions, now, agents,
}: {
  task: TaskView
  /**
   * Agent 登记表里接上了的那几家(2026-09-25,卡 Z):负责人那一排列谁、小头像什么颜色、名字怎么写都读它。
   * 缺席(老调用方、精简看板)= 只有人那几档,行为与 09-25 之前一样。
   */
  agents?: readonly AgentEntryView[] | undefined
  /** 这张卡挂在哪条泳道下,弹窗顶部给一句"我在哪"——弹窗盖住看板之后就没有别的线索了。 */
  moduleName: string
  sessions: readonly SessionView[]
  /** 已关联会话各自的用量(键 `agent:session_id`)。查不到的不在里面,那一条就不显示数字。 */
  sessionUsage: Readonly<Record<string, UsageTotals>>
  /**
   * 这张卡所属项目那个仓库的本地分支(项目区扫来的 RepoSignals.branches)。
   * 空着就是没扫到——那时退回手敲,**不摆一个空下拉**(点开什么都没有比没有这个控件更费解)。
   */
  branches: readonly string[]
  /** 那个仓库的路径。挂 branch 类交付物时一并记下来:光有分支名分不清是哪个仓库的。 */
  repoPath?: string | undefined
  /** 「文件」类的候选路径:收件箱刚归档的落点、这张卡当初是从哪个文件转来的。点一下填上。 */
  filePathHints: readonly string[]
  onClose: () => void
  onMove: (id: string, status: TaskStatus) => void
  onUpdate: (id: string, patch: TaskPatch) => void
  onDelete: (id: string) => void
  /** 弹层让开窗位(2026-09-11):弹窗居中盖住整页,必与窗位重叠——挂载即让路,卸载即回来。 */
  veil?: VeilTarget
  /**
   * 需求指挥台要打的那几条路由(2026-09-22)。**两个都传到才画那一块** ——
   * 没接线的地方(既有的一批用例、手机端那份精简看板)整块不出现,
   * 行为与这件功能出现之前一字不差(同 `onStopDispatch` 那条分寸)。
   */
  deckBaseUrl?: string | undefined
  deckFetch?: typeof fetch | undefined
  /**
   * 「现在到哪」那一块的三颗按钮(2026-09-25 卡 N):现在核一次 / 派给 X / 说一句。**缺席 = 那一块只读**
   * (卡上核过的那一句照样显示,按钮不画)。
   */
  progressActions?: ProgressActions | undefined
  /** /state.now(「今天 / 昨天」按它算)。 */
  now?: string | undefined
}) {
  useVeilSlot(true, veil)
  // 弹层盖住窗位(2026-09-14):让路后的空白由弹窗本身填上;量不到矩形照旧居中。
  const cover = useDialogCover(veil)
  const [title, setTitle] = useState(task.title)
  const [desc, setDesc] = useState(task.desc ?? '')
  const [ownerNote, setOwnerNote] = useState(task.assignee_note ?? '')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [addingLink, setAddingLink] = useState(false)
  const [addingDeliverable, setAddingDeliverable] = useState(false)
  const [deliverableKind, setDeliverableKind] = useState<TaskDeliverableKind>('branch')
  const [deliverableRef, setDeliverableRef] = useState('')
  const closeRef = useRef<HTMLButtonElement | null>(null)

  // Esc 关窗 + 打开时焦点落到关闭键(不然 Tab 会从页面最上面开始走一遍)。
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    closeRef.current?.focus()
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const links = task.links ?? []
  const linkedIds = new Set(links.map(link => `${link.agent}:${link.session_id}`))
  const addable = sessions.filter(session => !linkedIds.has(`${session.agent}:${session.session_id}`))

  const deliverables = task.deliverables ?? []
  /** 分支能从下拉里挑,当且仅当真扫到了分支;其余三类一律手敲(路径/链接猜不出来)。 */
  const pickBranch = deliverableKind === 'branch' && branches.length > 0

  const addDeliverable = (one: TaskDeliverable): void => {
    onUpdate(task.id, { deliverables: [...deliverables, one] })
    setAddingDeliverable(false)
    setDeliverableRef('')
  }

  const commitTitle = (): void => {
    const next = title.trim()
    if (next !== '' && next !== task.title) onUpdate(task.id, { title: next })
  }
  const commitDesc = (): void => {
    const next = desc.trim()
    if (next !== (task.desc ?? '')) onUpdate(task.id, { desc: next === '' ? null : next })
  }

  return (
    // 遮罩上的 onClick 只认"点在遮罩自己身上"(不是冒泡上来的),否则在弹窗里
    // 拖选一段文字、松手时鼠标落在遮罩上,窗就关了,刚打的字全丢。
    <div
      className="ben-wb__dlg-scrim"
      onClick={(event) => { if (event.target === event.currentTarget) onClose() }}
    >
      <div className={coverClass('ben-wb__dlg', cover)} style={cover} role="dialog" aria-modal="true" aria-label={`功能点 ${task.title}`}>
        <div className="ben-wb__dlg-head">
          <span className="ben-wb__task-prio" data-priority={task.priority ?? ''} aria-hidden="true" />
          <span className="ben-wb__dlg-where">{moduleName}</span>
          {SOURCE_LABELS[task.source.kind] !== undefined && (
            <span className="ben-wb__task-src">{SOURCE_LABELS[task.source.kind]}</span>
          )}
          <button type="button" ref={closeRef} className="ben-wb__dlg-close" aria-label="关闭" onClick={onClose}>✕</button>
        </div>

        <div className="ben-wb__dlg-body">
          <input
            className="ben-wb__dlg-title"
            type="text"
            aria-label="标题"
            value={title}
            onChange={event => setTitle(event.target.value)}
            onBlur={commitTitle}
          />

          {/* 现在到哪 · 依据 · 什么时候看的(2026-09-25 卡 N):他打开一张卡,先看见的是证据说的进度,不是引导时的口述。
              选题卡不画(选题那一屏按六段排,不走证据评估)。 */}
          {/* 停在哪(2026-10-12):最后一条证据 · 在等谁 · 下一步,四种要分开说的带「继续 / 关掉 / 重派」。 */}
          <StandingBlock task={task} now={now} onMove={onMove} drive={progressActions?.drive} />
          {task.kind !== 'topic' && <ProgressBlock task={task} actions={progressActions} now={now} />}

          {/* ── 需求卡 = 指挥台(2026-09-22,审视第四节第三幕)──
              **只有 `kind: 'feature'` 才画**:普通事项与选题卡上这一块整个不出现
              (选题有它自己那一套,在 TodoModule 里)。接线没给全时也不画 ——
              一颗点了没反应的按钮比没有按钮更坏(D13)。 */}
          {task.kind === 'feature' && deckBaseUrl !== undefined && deckFetch !== undefined && (
            <FeatureDeck
              task={task}
              baseUrl={deckBaseUrl}
              fetchImpl={deckFetch}
              onStageChange={stage => onUpdate(task.id, { feature_stage: stage })}
            />
          )}

          {/* 状态:四格一排,当前那格高亮。比 ←/→ 两个箭头直观得多——箭头要在脑子里
              先想"我现在在哪一列",这一排是直接看得见的。 */}
          <div className="ben-wb__dlg-steps" role="group" aria-label="状态">
            {TASK_STATUSES.map((status) => {
              // 转换表(protocol.ts)说去不了的那几格直接置灰,并把原因挂在 title 上——
              // 点了没反应比不让点更让人费解(D13:拒绝要如实说出为什么)。
              const checked = canTransition(task.status, status)
              return (
                <button
                  key={status}
                  type="button"
                  data-on={status === task.status}
                  aria-pressed={status === task.status}
                  disabled={!checked.ok}
                  {...(checked.ok ? {} : { title: checked.reason })}
                  onClick={() => onMove(task.id, status)}
                >
                  {STATUS_TITLES[status]}
                </button>
              )
            })}
          </div>

          <label className="ben-wb__dlg-field">
            <span>功能描述</span>
            <textarea
              rows={4}
              aria-label="功能描述"
              placeholder="这个功能点具体要做成什么样"
              value={desc}
              onChange={event => setDesc(event.target.value)}
              onBlur={commitDesc}
            />
          </label>

          {/* 阻塞原因(2026-09-09 傍晚拍板第 4 条):**只在「阻塞」列出现**——
              一张在跑的卡挂"为什么卡住"是没有意义的。四个选项就是会话那套等待原因,
              同一套 id、同一批中文名,他不必在两个地方记两套词。服务端在卡离开阻塞列时清掉它。 */}
          {task.status === 'blocked' && (
            <div className="ben-wb__dlg-field">
              <span>卡在哪</span>
              <div className="ben-wb__chips" role="group" aria-label="阻塞原因">
                {WAIT_REASONS.map(reason => (
                  <button
                    key={reason}
                    type="button"
                    className="ben-wb__chip"
                    data-block={reason}
                    data-on={task.block_reason === reason}
                    aria-pressed={task.block_reason === reason}
                    // 再点一下当前那档 = 取消(同优先级那一排),不另设"未定"按钮。
                    onClick={() => onUpdate(task.id, {
                      block_reason: task.block_reason === reason ? null : reason,
                    })}
                  >
                    {WAIT_REASON_TITLES[reason]}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* 工作台记在卡上的那句话(2026-09-16 事项生命周期闭环):出错原话 / 你停了它 / 会话未开。
              只读——它是事实的转述,不是给人编辑的字段。 */}
          {task.note !== undefined && (
            <p className="ben-wb__dlg-note" role="note" aria-label="事务官备注">{task.note}</p>
          )}

          <div className="ben-wb__dlg-grid">
            <div className="ben-wb__dlg-field">
              <span>优先级</span>
              <div className="ben-wb__chips" role="group" aria-label="优先级">
                {TASK_PRIORITIES.map(priority => (
                  <button
                    key={priority}
                    type="button"
                    className="ben-wb__chip"
                    data-priority={priority}
                    data-on={task.priority === priority}
                    aria-pressed={task.priority === priority}
                    // 再点一下当前那档 = 取消,不必另设一个"未定"按钮。
                    onClick={() => onUpdate(task.id, { priority: task.priority === priority ? null : priority })}
                  >
                    {PRIORITY_TITLES[priority]}
                  </button>
                ))}
              </div>
            </div>

            {/* 负责人(2026-09-25 卡 N):**是真的,决定谁动** —— 某家 AI / 事务官:按档位问一句或直接派;
                你:进「今天要做」与早报;同事 / 别人:只跟进、到期提醒。人那三档可以补一句(「9/29 回来写」)。 */}
            <div className="ben-wb__dlg-field">
              <span>负责人</span>
              <div className="ben-wb__chips" role="group" aria-label="负责人">
                {ownerChoices(task.assignee, agents).map(agent => (
                  <button
                    key={agent}
                    type="button"
                    className="ben-wb__chip"
                    data-agent={agent}
                    data-on={task.assignee === agent}
                    aria-pressed={task.assignee === agent}
                    onClick={() => onUpdate(task.id, { assignee: task.assignee === agent ? null : agent })}
                  >
                    {agentFaceOf(agents, agent).name ?? ASSIGNEE_TITLES[agent] ?? agent}
                  </button>
                ))}
              </div>
              {task.assignee !== undefined && isPersonAssignee(task.assignee) && (
                <label className="ben-wb__item-owner">
                  <input
                    type="text"
                    aria-label="负责人补充"
                    maxLength={40}
                    placeholder={task.assignee === 'me' ? '补一句(比如:周末弄)' : '补一句(比如:9/29 回来写)'}
                    value={ownerNote}
                    onChange={event => setOwnerNote(event.target.value)}
                    onBlur={() => {
                      const next = ownerNote.trim()
                      if (next !== (task.assignee_note ?? '')) onUpdate(task.id, { assignee_note: next === '' ? null : next })
                    }}
                  />
                </label>
              )}
            </div>

            <label className="ben-wb__dlg-field">
              <span>预期结束</span>
              <input
                type="date"
                aria-label="预期结束时间"
                value={task.due ?? ''}
                onChange={event => onUpdate(task.id, { due: event.target.value === '' ? null : event.target.value })}
              />
            </label>
          </div>

          {/**
            * 交付物(2026-09-09,待办第 5 条)。借 Multica「work lands in review, not in main」的
            * 思路:验收的对象是产物,不是一句「完成」——但界面颗粒度按我们现有看板,就是这张卡上
            * 的一个可选清单,不另起一套审阅流程(Ben 用过 Multica,嫌它颗粒度不够)。
            *
            * **只留痕,不回查**:分支被删了、文件被挪了,这一条照旧在——它记的是"交回来的是
            * 什么",不是"它现在还在不在"(同 TaskSource.ref 的纪律)。
            */}
          <div className="ben-wb__dlg-field">
            <span>交付物</span>
            <div className="ben-wb__delivs">
              {deliverables.length === 0 && (
                <em className="ben-wb__sprint-blank">
                  {needsDeliverable(task) ? '还没有可验收的东西' : '还没有交付物'}
                </em>
              )}
              {deliverables.map(one => (
                <span className="ben-wb__deliv" key={`${one.kind}:${one.ref}`}>
                  <span className="ben-wb__deliv-kind" data-kind={one.kind}>{DELIVERABLE_TITLES[one.kind]}</span>
                  <code>{one.ref}</code>
                  {one.repo !== undefined && <span className="ben-wb__deliv-repo">{one.repo}</span>}
                  <button
                    type="button"
                    aria-label={`去掉交付物 ${one.ref}`}
                    onClick={() => onUpdate(task.id, {
                      deliverables: deliverables.filter(other => !(other.kind === one.kind && other.ref === one.ref)),
                    })}
                  >
                    ✕
                  </button>
                </span>
              ))}
            </div>

            {addingDeliverable
              ? (
                  <div className="ben-wb__deliv-add">
                    <div className="ben-wb__chips" role="group" aria-label="交付物是什么">
                      {/* 「回答」那一类只由工作台在会话结束时挂,不给手敲(protocol.ts MANUAL_DELIVERABLE_KINDS)。 */}
                      {MANUAL_DELIVERABLE_KINDS.map(kind => (
                        <button
                          key={kind}
                          type="button"
                          className="ben-wb__chip"
                          data-on={deliverableKind === kind}
                          aria-pressed={deliverableKind === kind}
                          onClick={() => setDeliverableKind(kind)}
                        >
                          {DELIVERABLE_TITLES[kind]}
                        </button>
                      ))}
                    </div>

                    {pickBranch
                      ? (
                          <select
                            aria-label="挑一条分支"
                            defaultValue=""
                            onChange={(event) => {
                              const picked = event.target.value
                              if (picked === '') return
                              addDeliverable({
                                kind: 'branch',
                                ref: picked,
                                ...(repoPath === undefined || repoPath === '' ? {} : { repo: repoPath }),
                              })
                            }}
                          >
                            <option value="">挑一条分支…</option>
                            {branches.map(name => <option key={name} value={name}>{name}</option>)}
                          </select>
                        )
                      : (
                          <>
                            <input
                              type="text"
                              aria-label="交付物的路径 / 分支名 / 链接"
                              placeholder={deliverableKind === 'url' ? 'https://…' : '/Users/example/…'}
                              value={deliverableRef}
                              onChange={event => setDeliverableRef(event.target.value)}
                            />
                            {/* 「带入」:收件箱刚归档到哪儿、这张卡当初从哪个文件转来的——
                                路径手敲最容易敲错,而这两条工作台本来就知道。 */}
                            {deliverableKind !== 'url' && filePathHints.map(hint => (
                              <button
                                key={hint}
                                type="button"
                                className="ben-wb__deliv-hint"
                                onClick={() => setDeliverableRef(hint)}
                              >
                                用 {hint}
                              </button>
                            ))}
                            <button
                              type="button"
                              disabled={deliverableRef.trim() === ''}
                              onClick={() => addDeliverable({
                                kind: deliverableKind,
                                ref: deliverableRef.trim(),
                                ...(deliverableKind === 'branch' && repoPath !== undefined && repoPath !== ''
                                  ? { repo: repoPath }
                                  : {}),
                              })}
                            >
                              挂上
                            </button>
                          </>
                        )}
                  </div>
                )
              : (
                  <button
                    type="button"
                    className="ben-wb__dlg-addlink"
                    onClick={() => setAddingDeliverable(true)}
                  >
                    ＋ 挂一件交付物
                  </button>
                )}
          </div>

          {/* 关联窗口(Ben:"进行中的应该有窗口的 ID……允许一个功能点有多个任务 ID,
              也支持多个 Agent,可能中间因为额度做了交接和切换")。 */}
          <div className="ben-wb__dlg-field">
            <span>关联窗口</span>
            <div className="ben-wb__links">
              {links.length === 0 && <em className="ben-wb__sprint-blank">还没关联任何窗口</em>}
              {links.map((link) => {
                const live = sessionOfLink(sessions, link)
                return (
                  <span className="ben-wb__link" key={`${link.agent}:${link.session_id}`}>
                    <span className="ben-wb__link-dot" data-status={live?.status ?? 'gone'} aria-hidden="true" />
                    <span className="ben-wb__link-who">{ASSIGNEE_TITLES[link.agent]}</span>
                    <code>{link.session_id}</code>
                    {/* 状态是**现查 sessions**,不落盘:落盘的状态一定会跟真实会话漂移,
                        然后开始骗人(与 RepoSignals 同一条纪律)。查不到就如实说"已结束/查不到"。 */}
                    <span className="ben-wb__link-state">
                      {live === undefined ? '已结束 / 查不到' : STATUS_LIVE[live.status]}
                    </span>
                    {/* 这条会话烧了多少(2026-09-09 费用归因)。查不到账就不显示这一段——
                        Kimi 压根不给 token 级数据,摆个 0 会被读成"这条没花钱"(D13)。 */}
                    {(() => {
                      const totals = sessionUsage[`${link.agent}:${link.session_id}`]
                      return totals === undefined
                        ? null
                        : <span className="ben-wb__link-spend">{formatSpend(billedTokens(totals))}</span>
                    })()}
                    <button
                      type="button"
                      aria-label={`解除关联 ${link.session_id}`}
                      onClick={() => onUpdate(task.id, {
                        links: links.filter(other => !(other.agent === link.agent && other.session_id === link.session_id)),
                      })}
                    >
                      ✕
                    </button>
                  </span>
                )
              })}
            </div>

            {addingLink
              ? (
                  <select
                    aria-label="挑一个窗口关联上来"
                    defaultValue=""
                    onChange={(event) => {
                      const picked = addable.find(session => `${session.agent}:${session.session_id}` === event.target.value)
                      if (picked !== undefined) {
                        onUpdate(task.id, {
                          links: [...links, { agent: picked.agent, session_id: picked.session_id }],
                        })
                      }
                      setAddingLink(false)
                    }}
                  >
                    <option value="">挑一个窗口…</option>
                    {addable.map(session => (
                      <option key={`${session.agent}:${session.session_id}`} value={`${session.agent}:${session.session_id}`}>
                        {ASSIGNEE_TITLES[session.agent]} · {session.title ?? session.session_id}
                      </option>
                    ))}
                  </select>
                )
              : (
                  <button
                    type="button"
                    className="ben-wb__dlg-addlink"
                    disabled={addable.length === 0}
                    onClick={() => setAddingLink(true)}
                  >
                    ＋ 关联一个窗口
                    {addable.length === 0 && <em className="ben-wb__sprint-blank">(现在没有别的窗口)</em>}
                  </button>
                )}
          </div>
        </div>

        <div className="ben-wb__dlg-foot">
          {confirmDelete
            ? (
                <>
                  <button type="button" className="ben-wb__task-del" aria-label="确定删" onClick={() => onDelete(task.id)}>
                    确定删?
                  </button>
                  <button type="button" onClick={() => setConfirmDelete(false)}>取消</button>
                </>
              )
            : (
                <button type="button" className="ben-wb__task-del" aria-label="删掉" onClick={() => setConfirmDelete(true)}>
                  删掉
                </button>
              )}
          <button type="button" className="ben-wb__dlg-done" onClick={onClose}>完成</button>
        </div>
      </div>
    </div>
  )
}

/** 会话状态的人话。与展示台那套用词一致,不另造。 */
const STATUS_LIVE: Record<SessionView['status'], string> = {
  waiting: '等你确认',
  running: '在跑',
  done: '刚完成',
  error: '出错了',
  offline: '掉线',
}

/**
 * 负责人那一排:你 / 事务官 / **登记表里的每一家** / 同事 / 别人(2026-09-25,卡 Z:几家 AI 不再写死)。
 * 卡上已经写着一家不在这排里的(比如电话里点名的 GPT),也把它摆上,免得看不出选的是谁。
 */
function ownerChoices(current: TaskAssignee | undefined, agents: readonly AgentEntryView[] | undefined): readonly TaskAssignee[] {
  return assigneePicker(agents, current) as readonly TaskAssignee[]
}
