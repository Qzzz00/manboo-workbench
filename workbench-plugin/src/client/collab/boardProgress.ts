/**
 * 协作区主体的判据(2026-10-27,《设计-协作区与事务官标签页合并》第二节;决策记录同日「事项卡按完成情况上色」)。
 * 纯函数:卡片颜色五档、事项的完成条件、没条件时的阶段刻度、目标四问、轨迹方向、轨迹节点的念法。
 * 只读卡上已有的状态与条件账,不推算、不编时间。
 */
import type { CollabGoal, TaskStatus, TaskView, TraceCurrent, TraceNodeKind } from '../../protocol.ts'
import { STAMP_TITLES, conditionStateOf, goalIdOf } from '../../protocol.ts'
import { extractTaskWaitReason } from './progressModel.ts'

export type BoardProgress = 'not-started' | 'doing' | 'review' | 'done' | 'blocked'

export const BOARD_PROGRESS: readonly BoardProgress[] = ['not-started', 'doing', 'review', 'done', 'blocked']
export const BOARD_PROGRESS_TITLES: Readonly<Record<BoardProgress, string>> = {
  'not-started': '未开始', 'doing': '进行中', 'review': '待验收', 'done': '已完成', 'blocked': '受阻',
}

/** 卡片颜色:待排、待办、取消都算未开始;在做 → 进行中;等你确认 → 待验收。 */
export function progressOf(status: TaskStatus): BoardProgress {
  if (status === 'doing') return 'doing'
  if (status === 'confirm') return 'review'
  if (status === 'done') return 'done'
  if (status === 'blocked') return 'blocked'
  return 'not-started'
}

/** 这件事挂着的目标条件:核验过(verified / delivered)才算一格。 */
export function taskConditions(task: TaskView, goals: readonly CollabGoal[]): { verified: number, total: number } {
  const mine = goals.flatMap(goal => (goal.conditions ?? []).filter(one => one.task_id === task.id))
  const verified = mine.filter((one) => {
    const state = conditionStateOf(one, task)
    return state === 'verified' || state === 'delivered'
  }).length
  return { verified, total: mine.length }
}

export const STAGE_TITLES = ['派发', '执行', '交回', '验收'] as const
/** 没有条件时的阶段刻度(派发 → 执行 → 交回 → 验收),不造百分比。 */
export function stageSteps(status: TaskStatus): { passed: number, total: 4 } {
  const passed = status === 'done' ? 4 : status === 'confirm' ? 3 : status === 'doing' ? 2 : status === 'blocked' ? 1 : 0
  return { passed, total: 4 }
}

/** 目标四问:当前目标、完成程度、未完原因、预计。没有可信估计时说缺什么,不编时间。 */
export interface GoalBrief {
  done: number
  total: number
  /** 每件事项一格,颜色按完成情况(顺序照账上)。 */
  segments: readonly BoardProgress[]
  /** 最该看的那一件为什么没完:受阻 > 待验收 > 进行中 > 未开始。全做完了缺席。 */
  reason?: string
  eta: string
}
const REASON_ORDER: readonly BoardProgress[] = ['blocked', 'review', 'doing', 'not-started']
export function goalBrief(goal: CollabGoal, tasks: readonly TaskView[]): GoalBrief {
  const members = tasks.filter(task => goalIdOf(task) === goal.id && task.casual !== true)
  const segments = members.map(task => progressOf(task.status))
  const done = members.filter(task => task.status === 'done').length
  let reason: string | undefined
  for (const kind of REASON_ORDER) {
    const task = members.find(one => progressOf(one.status) === kind && one.status !== 'canceled')
    if (task === undefined) continue
    const why = extractTaskWaitReason(task)
    reason = `「${task.title}」${BOARD_PROGRESS_TITLES[kind]}${why === undefined ? '' : `:${why}`}`
    break
  }
  return { done, total: members.length, segments, ...(reason === undefined ? {} : { reason }), eta: '未估计 · 缺执行者估计' }
}

/** 轨迹方向:容器宽大于高 = 一件事一行、时间从左到右;否则一件事一列、时间从上到下。 */
export function traceDirection(width: number, height: number): 'row' | 'column' {
  return width > height ? 'row' : 'column'
}

export const TRACE_NODE_TITLES: Readonly<Record<TraceNodeKind, string>> = {
  dispatch: '派发', sent: '已送达', start: '开工', return: '交回', artifact: '产物',
  handoff: '交接', rework: '验收退回', accept: '验收通过', blocked: '受阻', arrange: '安排',
}
export const TRACE_CURRENT_TITLES: Readonly<Record<TraceCurrent['state'], string>> = {
  not_started: '未开始', dispatched: '已派发,等待开工', running: '执行中', paused: '暂停',
  awaiting_review: '待验收', blocked: '受阻', done: '已完成', unknown: '状态未知',
}

/** 卡上那一格的阶段名(没有条件时刻度下的那一句)。 */
export function stageLabel(status: TaskStatus): string {
  const { passed } = stageSteps(status)
  if (status === 'blocked') return `受阻 · ${STAMP_TITLES.blocked}`
  return passed === 0 ? '阶段 未派发' : `阶段 ${STAGE_TITLES[passed - 1]}`
}
