/**
 * 目标视图里的三种节点(React Flow 的自定义节点就是 React 组件):便签、目标区、Agent 小鼠标(视觉 A 第 2、17、33 屏)。
 *
 * 便签上的纪律(设计稿第四节):**拖只挪位置**(松手落进别的目标区才改 `goal_id`);**点章改状态**;←/→ 照旧在
 * —— 按钮路径是唯一保证能用的交互面,拖是补充。按钮都挂 `nodrag`:点它们不会被当成开始拖。
 */
import type { NodeProps } from '@xyflow/react'
import { isTaskGroup } from './taskGroup.ts'
import { useViewport } from '@xyflow/react'
import type { CollabGoal, NoteGap, TaskStatus, TaskView, WorkType } from '../../protocol.ts'
import {
  NOTE_FROM_TITLES, NOTE_GAP_TITLES, RECEIPT_TITLES, STAMP_TITLES, UNSORTED_GOAL_ID, noteFromOf, scheduleRiskText,
} from '../../protocol.ts'
import type { StampChoice } from './collabModel.ts'
import { arrowTargets, receiptBody } from './collabModel.ts'
import type { Relation } from './peopleModel.ts'
import { RELATION_TITLES } from './peopleModel.ts'
import { AvatarFace, NoteOwners, usePeople } from './people.tsx'
import { managerOf } from './identity.ts'
import { useAssigneeName } from '../meName.tsx'
import { DotList, Stamp, TypeIcon } from './parts.tsx'
import { progressOf, stageLabel, stageSteps } from './boardProgress.ts'
import { GOAL_STATUS_TITLES } from './collabContract.ts'

export interface NoteNodeData extends Record<string, unknown> {
  task: TaskView
  type: WorkType | undefined
  /** 筛掉了 / 和选中的头像没关系:变淡,不消失。 */
  dim: boolean
  relation?: Relation | undefined
  assigneeText: string
  gaps: readonly NoteGap[]
  /** 有 Agent 小鼠标停在这张上。 */
  working: boolean
  /** 状态的文字原因(2026-10-24 设计 3.3:浅状态色之外要读得出「等谁/什么」)。 */
  statusReason?: string | undefined
  /** 父任务组:组完成从子卡汇总,父卡不单独标完成(章只读)。 */
  grouped?: boolean | undefined
  groupStatus?: TaskStatus | undefined
  /** 来往记录条数(留言+评论);给了才画「来往」速览按钮。 */
  talkCount?: number | undefined
  /** 这件事挂着的目标条件(核验过几条 / 共几条);缺席或 0 条 = 画阶段刻度(2026-10-27)。 */
  conditions?: { verified: number, total: number } | undefined
  onQuickView?: ((task: TaskView) => void) | undefined
  onStamp: (task: TaskView, choice: StampChoice) => void
  onArrow: (task: TaskView, status: TaskStatus) => void
  onOpen: (task: TaskView) => void
}

/** 「管理 某某」:只在卡上记了 manager 时画;名字先认名片表(她起的名),再退回负责人名表。 */
export function NoteManager({ task }: { task: TaskView }) {
  const { cards } = usePeople()
  const nameOf = useAssigneeName()
  const manager = managerOf(task)
  if (manager === undefined) return null
  const name = cards.find(one => one.id === manager)?.name ?? nameOf(manager)
  return <span className="ben-cl__manager" title="派活与验收">管理 {name}</span>
}

export function NoteNode({ data }: NodeProps) {
  const { task, type, dim, relation, assigneeText, gaps, working, statusReason, grouped: groupedProp, groupStatus, talkCount, conditions, onQuickView, onStamp, onArrow, onOpen } = data as NoteNodeData
  const grouped = groupedProp === true || isTaskGroup(task)
  const status = grouped ? groupStatus ?? 'todo' : task.status
  const arrows = arrowTargets(status)
  const from = noteFromOf(task)
  const objection = task.receipt?.kind === 'objection' ? receiptBody(task.receipt.text) : undefined
  // 进度刻度(2026-10-27):有目标条件按核验数,没有就按阶段(派发 → 执行 → 交回 → 验收),不造百分比。
  const steps = stageSteps(status)
  const rungs = conditions !== undefined && conditions.total > 0
    ? { on: conditions.verified, total: conditions.total, label: `完成条件 ${conditions.verified}/${conditions.total} 已核验` }
    : { on: steps.passed, total: steps.total, label: stageLabel(status) }
  const next = task.standing?.next !== undefined && task.standing.next !== '' && task.standing.next !== statusReason ? task.standing.next : undefined
  return (
    <div
      className="ben-cl__note"
      data-type={type ?? 'none'}
      data-progress={progressOf(status)}
      data-status={status}
      data-dim={dim}
      data-related={relation !== undefined}
      data-working={working}
      data-note-id={task.id}
      aria-label={`便签 ${task.title}`}
    >
      <button type="button" className="ben-cl__note-title nodrag" onClick={() => onOpen(task)} title={task.title}>
        {type !== undefined && <TypeIcon type={type} />}{task.title}
      </button>
      <span className="ben-cl__note-line">来自 · {from.quote === undefined ? NOTE_FROM_TITLES[from.kind] : `${NOTE_FROM_TITLES[from.kind]}「${from.quote.slice(0, 18)}${from.quote.length > 18 ? '…' : ''}」`}</span>
      {(task.acceptance ?? []).length > 0 && <span className="ben-cl__note-line">验收 {(task.acceptance ?? []).length} 条</span>}
      {statusReason !== undefined && <p className="ben-cl__note-reason" data-status={status}>{statusReason}</p>}
      {next !== undefined && <p className="ben-cl__note-next">下一步:{next}</p>}
      <div className="ben-cl__note-progress">
        <span>{rungs.label}</span>
        <span className="ben-cl__note-rungs" aria-hidden="true">{Array.from({ length: rungs.total }, (_, i) => <i key={i} data-on={i < rungs.on} />)}</span>
      </div>
      {objection !== undefined && <p className="ben-cl__note-objection">它不同意:{objection}</p>}
      {task.receipt !== undefined && task.receipt.kind !== 'objection' && (
        <p className="ben-cl__note-receipt">{RECEIPT_TITLES[task.receipt.kind]}:{receiptBody(task.receipt.text)}</p>
      )}
      {(gaps.length > 0 || task.receipt_irregular === true || (task.labels ?? []).length > 0) && (
        <div className="ben-cl__gaps">
          {(task.labels ?? []).map(label => <span key={`l-${label}`} className="ben-cl__gap">{label}</span>)}
          {gaps.map(gap => <span key={gap} className="ben-cl__gap">{NOTE_GAP_TITLES[gap]}</span>)}
          {task.receipt_irregular === true && <span className="ben-cl__flag" title="交回来的话不是做完 / 有异议 / 卡住三种开头之一">回执不规范</span>}
        </div>
      )}
      <div className="ben-cl__note-foot">
        <span className="ben-cl__owner" title="负责人"><NoteOwners task={task} ownerText={assigneeText} /></span>
        <NoteManager task={task} />
        {onQuickView !== undefined && <button type="button" className="ben-cl__note-talk nodrag" aria-label={`看 ${task.title} 的来往`} onClick={() => onQuickView(task)}>来往 {talkCount ?? 0}</button>}
        {relation !== undefined && <span className="ben-cl__rel">{RELATION_TITLES[relation]}</span>}
        {grouped !== true && (
          <span className="ben-cl__note-arrows">
            <button type="button" className="nodrag" aria-label={`往左挪一格${arrows.prev === undefined ? '' : `:${STAMP_TITLES[arrows.prev]}`}`} disabled={arrows.prev === undefined} onClick={() => { if (arrows.prev !== undefined) onArrow(task, arrows.prev) }}>←</button>
            <button type="button" className="nodrag" aria-label={`往右挪一格${arrows.next === undefined ? '' : `:${STAMP_TITLES[arrows.next]}`}`} disabled={arrows.next === undefined} onClick={() => { if (arrows.next !== undefined) onArrow(task, arrows.next) }}>→</button>
          </span>
        )}
        <Stamp status={status} {...(grouped === true ? {} : { onPick: (choice: StampChoice) => onStamp(task, choice) })} />
      </div>
      {working && <span className="ben-cl__muted" aria-hidden="true" />}
    </div>
  )
}

export interface GoalNodeData extends Record<string, unknown> {
  goal: CollabGoal
  count: number
  done: number
  ownerText: string
  onConditions?: ((goal: CollabGoal) => void) | undefined
  /** 拖便签悬在这一块上:高亮,松手就归它。 */
  over: boolean
  dim: boolean
}

/** 目标区头部(标题 / 版本 / 为什么 / 负责 / 截止风险 / 进度点):画布节点与阅读模式同一份。 */
export function GoalHead({ goal, count, done, ownerText, onConditions }: { goal: CollabGoal, count: number, done: number, ownerText: string, onConditions?: ((goal: CollabGoal) => void) | undefined }) {
  const unsorted = goal.id === UNSORTED_GOAL_ID
  // 风险只写一行小字,**只在有截止日时**(服务端没算就是没截止日)。
  const risk = goal.risk === undefined ? undefined : scheduleRiskText(goal.risk)
  return (
    <header className="ben-cl__goal-head">
      <div className="ben-cl__goal-row">
        <h3>{goal.title}</h3>
        {goal.version !== undefined && <span className="ben-cl__goal-meta">版本 {goal.version}</span>}
        {goal.status === 'reached' && <span className="ben-cl__goal-meta">{GOAL_STATUS_TITLES.reached}</span>}
        {goal.status === 'dropped' && <span className="ben-cl__goal-meta">{GOAL_STATUS_TITLES.dropped}</span>}
        {goal.due !== undefined && <span className="ben-cl__goal-risk">{goal.due.slice(5)} 截止{risk !== undefined && risk !== '' ? ` · ${risk}` : ''}</span>}
        {onConditions !== undefined && <button type="button" className="ben-cl__goal-conds nodrag" aria-label={`看目标 ${goal.title} 的条件`} onClick={(event) => { event.stopPropagation(); onConditions(goal) }}>条件</button>}
      </div>
      {goal.why !== undefined && <span className="ben-cl__goal-why">{goal.why}</span>}
      {!unsorted && <span className="ben-cl__goal-meta">负责 · {ownerText}</span>}
      {/* 未归目标不画点列(不催)。 */}
      {!unsorted && <DotList total={count} done={done} />}
    </header>
  )
}

export function GoalNode({ data }: NodeProps) {
  const { goal, count, done, ownerText, onConditions, over, dim } = data as GoalNodeData
  return (
    <div className="ben-cl__goal" data-over={over} data-dim={dim} data-unsorted={goal.id === UNSORTED_GOAL_ID} data-status={goal.status} data-empty={count === 0} aria-label={`目标 ${goal.title}`}>
      <GoalHead goal={goal} count={count} done={done} ownerText={ownerText} onConditions={onConditions} />
    </div>
  )
}

export interface CursorNodeData extends Record<string, unknown> {
  actorId?: string
  name: string
  color?: string
  state: 'moving' | 'working' | 'stamping' | 'leaving'
}

/**
 * Agent 的小鼠标:一个带名字与头像的小光标(同一头像标签规格)。
 * 画布缩放时对光标做逆缩放补偿 (scale = 1 / zoom)，保证屏幕上物理渲染尺寸始终与评审页原型一致(高 28px、头像 22px)。
 */
export function CursorNode({ data }: NodeProps) {
  const { actorId, name, color, state } = data as CursorNodeData
  let zoom = 1
  try {
    const vp = useViewport()
    if (vp && typeof vp.zoom === 'number' && vp.zoom > 0) zoom = vp.zoom
  } catch {
    zoom = 1
  }
  const scale = zoom > 0 ? 1 / zoom : 1

  return (
    <div
      className="ben-cl__cursor-scale"
      style={{
        transform: `scale(${scale})`,
        transformOrigin: '0 0',
      }}
    >
      <div className="ben-cl__cursor" data-state={state} aria-label={`${name} 的小鼠标`} style={color === undefined ? undefined : { ['--cl-cursor' as string]: color }}>
        <svg width="16" height="18" viewBox="0 0 16 18" aria-hidden="true"><path d="M1 1l13 7-6 1.6L5.4 17z" /></svg>
        <span className="ben-cl__cursor-tag">
          <AvatarFace owner={actorId ?? name} name={name} kind="agent" color={color} />
          <span className="ben-cl__person-name">{name}</span>
        </span>
        {state === 'stamping' && <span className="ben-cl__cursor-stamp" aria-hidden="true">章</span>}
      </div>
    </div>
  )
}
