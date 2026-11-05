import { runtimeLine } from '../dispatchReceipt.ts'
/**
 * 看板上的一张卡 = 一个功能点(四层收敛的叶子)。
 *
 * **这里只有卡面,没有编辑面**——2026-08-25 Ben:"每一个功能卡片点击之后展开一个弹窗吧,
 * 你现在的交互,很反人类"。原来点一张卡会在那一格里就地长出一堆输入框,同一行其他泳道
 * 被顶下去,打字的时候整块看板一直在动。编辑整个搬进 TaskDialog,卡片退回"一眼能扫完"
 * 的一小块:优先级色条、标题、负责人、剩余天数、关联窗口。
 *
 * 卡面上的东西都做成**看得见的形状**而不是文字标签:优先级是左边一条色边,负责人是
 * 一个带色的小徽章,关联窗口是几个状态点。扫一列的时候不需要读字。
 *
 * `data-status`(2026-09-09 七态)也是这个路子:卡自己带着状态,「等我确认」与「阻塞」
 * 这两种在整屏扫过去时跳得出来——哪怕它此刻被拖到了别的列附近。样式在 style.ts。
 */
import type { AgentEntryView, SessionView, TaskLink, TaskView, TaskDeliverable, UsageTotals } from '../protocol.ts'
import { DISPATCH_FAMILY_TITLES, clientDeliveryLine, taskWaitLabel, clientDispatchDelivery, friendlyWhen, ITEM_EVIDENCE_SOURCE_TITLES, WAIT_REASON_TITLES, assigneeName, standingBadgeText, standingWaitingText } from '../protocol.ts'
import type { DragEvent as ReactDragEvent } from 'react'
import {
  ASSIGNEE_TITLES, PRIORITY_TITLES, SOURCE_LABELS,
  agentDispatchBadgeText, agentDispatchTitle, cardSpend, daysLeft, dispatchBadgeText, dispatchTitle, formatSpend, needsDeliverable, sessionOfLink,
} from './boardModel.ts'
import { topicRunBadge } from './TopicDeckModel.ts'
import { FxAvatar } from './fx/Fx.tsx'
import { avatarStateOfDispatch } from './fx/fxModel.ts'
import { agentFaceOf } from './agentRegistryView.ts'

export interface TaskPatch {
  title?: string
  /** 需求卡的那一态(2026-09-22)。**只有需求卡的「推进一步」会传**。 */
  feature_stage?: TaskView['feature_stage']
  desc?: string | null
  priority?: TaskView['priority'] | null
  assignee?: TaskView['assignee'] | null
  /** 负责人那一格的补充(人那三档:「9/29 回来写」)。null = 清掉。 */
  assignee_note?: string | null
  due?: string | null
  links?: readonly TaskLink[]
  /** 阻塞原因(2026-09-09 拍板第 4 条)。字段名跟着 /task/update 的线上形状走。 */
  block_reason?: TaskView['block_reason'] | null
  /** 交付物整组替换(同 links),空数组 = 清空。 */
  deliverables?: readonly TaskDeliverable[]
}

export function TaskCard({ task, sessions, sessionUsage, nowMs, onOpen, onStopDispatch, onDragStart, onDragEnd, agents }: {
  task: TaskView
  /**
   * Agent 登记表里接上了的那几家(2026-09-25,卡 Z;卡 Q 交接里欠的那一样):派活小标上的**名字与小头像的颜色**
   * 从这里取 —— 与顶栏小灯、事务官舞台、手机上是同一个色、同一个名字。缺席 = 老行为(头像自带的颜色、家名那张表)。
   */
  agents?: readonly AgentEntryView[] | undefined
  sessions: readonly SessionView[]
  /** 已关联会话各自的用量(键 `agent:session_id`)。查不到的不在里面——卡面据此整段不显示。 */
  sessionUsage: Readonly<Record<string, UsageTotals>>
  nowMs: number
  onOpen: () => void
  /**
   * 「停掉」那颗按钮(2026-09-21 派活可撤销)。**没接线就不画**——
   * 一颗点了没反应的按钮比没有按钮更坏(D13)。
   */
  onStopDispatch?: (() => void) | undefined
  onDragStart: (event: ReactDragEvent<HTMLElement>) => void
  onDragEnd: () => void
}) {
  const evidence = task.client_dispatch === undefined || task.dispatch !== undefined && (Date.parse(task.dispatch.started_at) || 0) >= (Date.parse(task.client_dispatch.at) || 0) ? task.dispatch : task.client_dispatch
  const links = task.links ?? []
  const left = task.due === undefined ? undefined : daysLeft(task.due, nowMs)
  const deliverables = task.deliverables ?? []
  const spend = cardSpend(task, sessionUsage)

  return (
    <article
      className="ben-wb__task"
      draggable
      data-task-id={task.id}
      data-status={task.status}
      data-priority={task.priority ?? ''}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
    >
      <button type="button" className="ben-wb__task-title" onClick={onOpen}>
        {task.title}
      </button>

      {/* 现在到哪(2026-09-25 卡 N):证据评估器核出来的那一句 —— 不是卡上原来写的、也不是引导时他口述的。
          鼠标停一下看依据与几点看的;打开卡看全部依据。没核过的卡整行不画(不写「未知」)。
          **没看到进展的那种(「还没看到进展,要你说一句」)卡面上也不画**:第一次用的人刚引导完,一屏卡每张底下都挂一句「还没看到进展」
          只会让人发懵 —— 那一句与「说一句」的框在卡片弹窗里,早报里念一句「还有 N 件没看到进展」。 */}
      {task.progress !== undefined && task.progress.state !== 'none' && (
        <p className="ben-wb__task-progress" data-state={task.progress.state} title={progressTitle(task, nowMs)}>
          {task.progress.line}
        </p>
      )}

      {/* 停在哪(2026-10-12):只给要留意的那几种(结果没收进卡 / 没派成 / 多半不需要了 / 等她太久),
          鼠标停一下看最后一条证据、在等谁、下一步;打开卡有「继续 / 关掉 / 重派」。正常在做的不出字。 */}
      {(() => {
        const badge = standingBadgeText(task.standing)
        return badge === undefined || task.standing === undefined
          ? null
          : <p className="ben-wb__task-standing" data-case={task.standing.case} title={standingTitle(task, nowMs)}>{badge}</p>
      })()}

      <div className="ben-wb__task-foot">
        {/* 阻塞原因(2026-09-09):扫一列「阻塞」就知道各自卡在哪——
            三条等审批和三条额度不足是完全不同的两件事。没挂原因的卡不标,不写「原因未知」。 */}
        {taskWaitLabel(task) !== undefined && (
          <span className="ben-wb__task-block" title={`阻塞原因 ${taskWaitLabel(task) ?? ''}`}>
            {taskWaitLabel(task)}
          </span>
        )}

        {/* 派给别家(2026-09-21):一眼看出这张卡此刻不在事务官手上,而在 Codex / Claude 那边。
            失败那一档用 data-state 标出来(样式在 style.ts),同时收件箱里会有一条「要我自己来吗」。
            **只在派过活的卡上出现**:没派过就整段不显示,不写「没派给谁」。 */}
        {task.dispatch !== undefined && (
          <span
            className="ben-wb__task-dispatch"
            data-state={task.dispatch.status}
            data-family={task.dispatch.family}
            data-hand={task.dispatch.hand ?? 'cli'}
            title={agentDispatchTitle(task.dispatch)}
          >
            {/* 动效配角(2026-09-23):派给哪一家,就是哪一家的小头像;在跑时它在忙。 */}
            <FxAvatar agent={task.dispatch.family} {...agentFaceOf(agents, task.dispatch.family)} state={avatarStateOfDispatch(task.dispatch.status)} size={14} />
            {agentDispatchBadgeText(task.dispatch, agentFaceOf(agents, task.dispatch.family).name)}
          </span>
        )}

        {evidence?.selection !== undefined && <span>{evidence.selection.reason}</span>}
        {evidence?.runtime !== undefined && <span>{runtimeLine(evidence.runtime)}</span>}

        {/* 停掉 = 杀那个子进程。**三个条件都满足才画**:还在跑、事务官报了 pid、这一层接了线。
            报不出 pid 的那次派活停不掉 —— 那时不画按钮,而不是画一颗停不掉的。 */}
        {task.dispatch?.status === 'running' && task.dispatch.pid !== undefined && onStopDispatch !== undefined && (
          <button
            type="button"
            className="ben-wb__task-dispatch-stop"
            title={`停掉 ${agentFaceOf(agents, task.dispatch.family).name ?? DISPATCH_FAMILY_TITLES[task.dispatch.family] ?? task.dispatch.family} 那个子进程(pid ${task.dispatch.pid})`}
            onClick={(event) => { event.stopPropagation(); onStopDispatch() }}
          >
            停掉
          </button>
        )}

        {/* 选题那几张卡上的派活四档(2026-09-22,设计第一节「看得见进度」):
            2026-09-22 起需求卡也用这一颗(同一套词、同一个算法)。
            排队 / 在做 / 回来了 / 失败 —— 与卡打开后指挥台上那一颗**同一套词**
            (`topicRunBadge`),她在两处看到的不该是两种说法。

            ★ **看板上算不出「排队」**:那一档要读 `选题/<名>/审核记录.jsonl` 里
            「她点过按钮」那一行,而 `/state` 这一份快照里没有它(也不该有 —— 看板
            不该为了一个小标去读盘)。所以这里只出现另外三档,「排队」只在卡打开后的
            指挥台上出现。宁可少说一档,也不拿别的字冒充它(D13)。 */}
        {(task.kind === 'topic' || task.kind === 'feature') && (() => {
          const state = topicRunBadge({ dispatch: task.dispatch, clientDispatch: task.client_dispatch })
          return state === undefined
            ? null
            : <span className="ben-wb__task-runstate" data-state={state} title={`这一步:${state}`}>{state}</span>
        })()}

        {task.assignee !== undefined && (
          <span
            className="ben-wb__task-who"
            data-agent={task.assignee}
            title={`负责人 ${ASSIGNEE_TITLES[task.assignee]}${task.assignee_note === undefined ? '' : ` · ${task.assignee_note}`}${task.mover === undefined ? '' : `\n现在:${task.mover.line}`}`}
          >
            {ASSIGNEE_TITLES[task.assignee]}
          </span>
        )}

        {/* 派给那家客户端的窗口(2026-09-21)。**鼠标停一下要能看见送出去的原话** ——
            我们以他的名义往别人的输入框里写了一段字,这段字必须在卡上看得到(卡上的规矩第 4 条)。
            没送成的那张也显示,并把壳给的原因原样挂在 title 上,不藏起来(D13)。 */}
        {task.client_dispatch !== undefined && (
          <span
            className="ben-wb__task-dispatch"
            data-status={task.client_dispatch.status}
            title={dispatchTitle(task.client_dispatch)}
          >
            {dispatchBadgeText(task.client_dispatch, agentFaceOf(agents, task.client_dispatch.family).name)}
          </span>
        )}

        {/* 派出去了没有(2026-09-30 维护者拍板:派活成功不回电话,那就得在卡上一眼看得出来)。
            四档由协议层一处算(clientDispatchDelivery),手机上那一格照抄同一批字。 */}
        {task.client_dispatch !== undefined && (
          <span
            className="ben-wb__task-delivery"
            data-delivery={clientDispatchDelivery(task.client_dispatch)}
            title={task.client_dispatch.confirm_note ?? task.client_dispatch.reply_note ?? ''}
          >
            {clientDeliveryLine(task.client_dispatch, agentFaceOf(agents, task.client_dispatch.family).name)}
          </span>
        )}

        {/* ★ 在那一家窗口通道里的处境(2026-10-21,卡「派活按家隔离」):排在谁后面 / 正在送 / 那扇窗读不动。
            原话由服务端写(`dispatch_lane.note`),卡面原样画一行 —— 原因不藏在悬停里。 */}
        {task.dispatch_lane !== undefined && (
          <span className="ben-wb__task-lane" data-state={task.dispatch_lane.state} title={task.dispatch_lane.note}>
            {task.dispatch_lane.note}
          </span>
        )}

        {/* 关联窗口:一个 agent 一个状态点。扫一眼就知道"这条有没有人在跑"——
            状态是现查 sessions,查不到就是灰点(那条会话已经结束了)。 */}
        {links.length > 0 && (
          <span className="ben-wb__task-links" aria-label={`关联 ${links.length} 个窗口`}>
            {links.map(link => (
              <span
                key={`${link.agent}:${link.session_id}`}
                className="ben-wb__link-dot"
                data-status={sessionOfLink(sessions, link)?.status ?? 'gone'}
                title={`${ASSIGNEE_TITLES[link.agent]} · ${link.session_id}`}
              />
            ))}
          </span>
        )}

        {/* 交付物(2026-09-09):有就报几件,进了「等我确认」却一件都没有就报那句话——
            **只提示,不阻止**(转换表没改)。这一句是「完成 ≠ 交付物验收」在卡面上的落点。 */}
        {deliverables.length > 0 && (
          <span className="ben-wb__task-deliv" title={deliverables.map(one => one.ref).join('\n')}>
            交付物 {deliverables.length}
          </span>
        )}
        {needsDeliverable(task) && (
          <span className="ben-wb__task-deliv" data-empty="true">没有可验收的东西</span>
        )}

        {/* 本卡消耗:只把查得到账的会话加起来,一条都查不到就整段不显示(绝不写 0)。 */}
        {spend !== undefined && (
          <span className="ben-wb__task-spend" title="已关联会话的消耗合计(入 + 缓存写 + 出,不含缓存读)">
            {formatSpend(spend)}
          </span>
        )}

        {left !== undefined && (
          // 剩余天数比一个裸日期好读:"2026-09-01" 要心算,"剩 6 天"不用。
          // 过期/紧张时变色,但**只变色,不说话**——不提"要不要删/推迟"(不可改清单第 5 条延伸)。
          <span className="ben-wb__task-due" data-tight={left <= 1} title={task.due}>
            {left < 0 ? `晚了 ${-left} 天` : left === 0 ? '今天' : `剩 ${left} 天`}
          </span>
        )}

        {task.priority !== undefined && (
          <span className="ben-wb__sr">优先级 {PRIORITY_TITLES[task.priority]}</span>
        )}
        {SOURCE_LABELS[task.source.kind] !== undefined && (
          <span className="ben-wb__task-src">{SOURCE_LABELS[task.source.kind]}</span>
        )}
      </div>
    </article>
  )
}

/** 卡面「停在哪」那一格的悬停:最后一条证据(什么 · 来源 · 时刻)、在等谁、下一步。 */
function standingTitle(task: TaskView, nowMs: number): string {
  const standing = task.standing
  if (standing === undefined) return ''
  const lines: string[] = []
  if (standing.last !== undefined) {
    const at = friendlyWhen(standing.last.at, nowMs)
    lines.push(`最后一条:${standing.last.what}(${ITEM_EVIDENCE_SOURCE_TITLES[standing.last.source]}${at === '' ? '' : ` · ${at}`})`)
  }
  lines.push(standingWaitingText(standing, standing.agent === undefined ? undefined : assigneeName(standing.agent)))
  lines.push(`下一步:${standing.next}`)
  return lines.join('\n')
}

/** 卡面那一行「到哪」的悬停:依据(出处是人话:「Codex 里「制作参赛网页」那段对话 · 昨天 20:17」,不露文件名、路径、提交号)+ 几点看的。 */
function progressTitle(task: TaskView, nowMs: number): string {
  const progress = task.progress
  if (progress === undefined) return ''
  const lines = [progress.line]
  if (progress.state === 'mismatch' && progress.mismatch !== undefined) lines.push(`和卡上写的对不上:${progress.mismatch}`)
  for (const one of progress.basis.slice(0, 3)) {
    const at = friendlyWhen(one.at, nowMs)
    lines.push(`依据:${one.source}${at === '' ? '' : ` · ${at}`}`)
  }
  lines.push(`${friendlyWhen(progress.checked_at, nowMs)} 看的`)
  return lines.join('\n')
}
