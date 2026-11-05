/**
 * 协作区进展纯读取模型 (2026-10-23 卡 D1 第一段)。
 *
 * 仅消费 0.4.148 已有 WorkbenchState、TaskView、NoteReceipt 等事实，
 * 严格只读，不写后端账，不改协议，不造假百分比或假执行。
 */
import type {
  CollabGoal,
  CollabPresence,
  CollabSprint,
  SessionView,
  RunSegment,
  TaskView,
} from '../../protocol.ts'
import {
  STATUS_TITLES,
  WAIT_REASON_TITLES,
  assigneeName,
  taskWaitLabel,
} from '../../protocol.ts'
import type { CollabFilter } from './collabModel.ts'
import { FILTER_TITLES, isAgentCursorVisible } from './collabModel.ts'

export type ProgressFilter = CollabFilter & {
  goal?: readonly string[] | undefined
}

export type ExecutionTruth =
  | 'delivered'          // 当前可用: status === 'done' 且有代码入库或发布事实
  | 'accepted'           // 已验收待交付: status === 'done' 且无发布事实
  | 'review'             // 交回待验: status === 'confirm'
  | 'running'            // 真实执行中: status === 'doing' 且有实际执行凭据
  | 'dispatched_queued'  // 已派出未接单: status === 'doing' 且处于派活通道排队
  | 'turn_ended'         // 回合结束待收口: status === 'doing' 且 CLI/派活回合结束但无交回回执
  | 'waiting_receipt'    // 待执行回执 / 未知: status === 'doing' 且缺少实时运行证据
  | 'unstarted'          // 未开始: status === 'todo' | 'backlog'
  | 'blocked'            // 受阻: status === 'blocked' 或带有 dispatch_block
  | 'canceled'           // 已取消: status === 'canceled' (单列，不算达成)

export const EXECUTION_TRUTH_TITLES: Record<ExecutionTruth, string> = {
  delivered: '当前可用',
  accepted: '已验收待交付',
  review: '交回待验',
  running: '真实执行中',
  dispatched_queued: '已派出未接单',
  turn_ended: '回合结束待收口',
  waiting_receipt: '待执行回执 / 未知',
  unstarted: '未开始',
  blocked: '受阻',
  canceled: '已取消',
}

export interface TaskProgressDetail {
  task: TaskView
  truth: ExecutionTruth
  truthLabel: string
  assigneeText: string
  lastRecordTime?: string | undefined
  lastRecordFormatted: string
  waitReason?: string | undefined
  nextMover?: string | undefined
  acceptanceConditions: readonly string[]
  hasUnassignedConditions: boolean
}

export interface CapabilityCondition {
  id: string
  text: string
  taskId: string
  taskTitle: string
  status: ExecutionTruth
  statusLabel: string
  unassigned?: boolean | undefined
  evidence?: readonly string[] | undefined
}

export interface ProgressSummaryCounts {
  delivered: number
  accepted: number
  review: number
  running: number
  waiting_receipt: number
  unstarted: number
  blocked: number
  canceled: number
  remaining: number
  totalProduction: number
}

export interface ProgressSummaryModel {
  scopeName: string
  counts: ProgressSummaryCounts
  groups: Record<ExecutionTruth, TaskProgressDetail[]>
  remainingList: TaskProgressDetail[]
  capabilityConditions: CapabilityCondition[]
  demoCount: number
  snapshotStale: boolean
  snapshotTimeText?: string | undefined
  parentGroupTasks: TaskView[]
  dedupedTasks: TaskView[]
}

export interface ClassifyOptions {
  presence?: readonly CollabPresence[] | undefined
  sessions?: readonly SessionView[] | undefined
  nowMs?: number | undefined
  runs?: readonly RunSegment[] | undefined
}

/**
 * 判定单项任务的执行真实度 (Execution Truth)。
 * 严格遵守：status=doing 仅代表账面状态，必须根据可用回执/实时记录区分实际执行与待回执未知。
 */
export function classifyExecutionTruth(task: TaskView, opts: ClassifyOptions = {}): ExecutionTruth {
  if (task.status === 'canceled') return 'canceled'
  if (task.status === 'blocked' || task.dispatch_block !== undefined) return 'blocked'
  if (task.status === 'confirm') return 'review'

  if (task.status === 'done') {
    // 只有具有真实交付/发布证据（如选题已发布、改自己的分支已 ok 闭环）才算当前可用
    const isShipped = task.self_ship?.status === 'ok'
    const isPublished = task.published_at !== undefined && task.published_at.trim() !== ''
    if (isShipped || isPublished) return 'delivered'
    return 'accepted'
  }

  if (task.status === 'doing') {
    // 1. 检查派活通道排队
    if (task.dispatch_lane?.state === 'queued') return 'dispatched_queued'

    // 进程创建和派出不是开工。实际运行账由 core 从匹配会话活动或原生事件计算。
    const latestRun = opts.runs?.filter(run => run.task_id === task.id).at(-1)
    if (latestRun?.status === 'running') return 'running'

    // 3. 检查派活回合已结束（CLI等结束回合，等待交回收口）
    if (task.dispatch?.status === 'done') return 'turn_ended'

    // 5. 检查板上活跃 Presence 光标：只认 agent 且正在working的那一种（member/idle/moving/stamping 都不能冒开工）；
    //    新鲜度与任务绑定守卫照旧走 isAgentCursorVisible。
    if (opts.presence !== undefined && opts.nowMs !== undefined) {
      const active = opts.presence.some(p =>
        p.actor.kind === 'agent'
        && p.state === 'working'
        && isAgentCursorVisible(p, [task], opts.nowMs!))
      if (active) return 'running'
    }

    // 无实时证据兜底为待回执/未知
    return 'waiting_receipt'
  }

  // todo, backlog
  return 'unstarted'
}

/**
 * 父子任务去重：若父任务的子任务同样在统计列表中，仅计入子任务叶子项，父容器仅作分组呈现，避免重复计算工作量。
 */
export function dedupTasksParentChild(tasks: readonly TaskView[]): {
  dedupedWorkTasks: TaskView[]
  parentGroupTasks: TaskView[]
} {
  const taskMap = new Map(tasks.map(t => [t.id, t]))
  const parentTasks: TaskView[] = []
  const workTasks: TaskView[] = []

  for (const t of tasks) {
    const hasChildrenInList = (t.children ?? []).some(childId => taskMap.has(childId))
    if (hasChildrenInList) {
      parentTasks.push(t)
    } else {
      workTasks.push(t)
    }
  }

  return { dedupedWorkTasks: workTasks, parentGroupTasks: parentTasks }
}

/**
 * 生产数据与演示数据严格分区。
 */
export function partitionProductionTasks(tasks: readonly TaskView[]): {
  production: TaskView[]
  demo: TaskView[]
} {
  const production: TaskView[] = []
  const demo: TaskView[] = []
  for (const t of tasks) {
    if (t.demo === true) demo.push(t)
    else production.push(t)
  }
  return { production, demo }
}

/**
 * 格式化 ISO 时间戳为可读文本。若取不到则返回未知。
 */
export function formatIsoTime(isoString?: string): string {
  if (!isoString) return '未知'
  const ms = Date.parse(isoString)
  if (!Number.isFinite(ms)) return '未知'
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/**
 * 提取任务的等待原因、依赖与受阻信息。
 */
export function extractTaskWaitReason(task: TaskView): string | undefined {
  if (task.dispatch_block?.why) return task.dispatch_block.why
  const waitLabel = taskWaitLabel(task)
  if (waitLabel) return waitLabel
  if (task.block_reason && WAIT_REASON_TITLES[task.block_reason]) {
    return WAIT_REASON_TITLES[task.block_reason]
  }
  if (task.receipt?.kind === 'blocked' && task.receipt.text) {
    return task.receipt.text
  }
  if (task.standing?.waiting_on && task.standing.waiting_on !== 'nobody') {
    return task.standing.next || '等候处理中'
  }
  return undefined
}

/**
 * 提取当前筛选范围的人类可读名称。
 *
 * 每个有值的维度都列出（与摘要计数同一份 filter，同源不漂）；
 * 维度名取 CollabFilter 自己的 FILTER_TITLES，不另造一套词。
 * 值缺失（如目标被换掉）时回退显示原 id，不静默丢维度。
 */
export function extractScopeName(
  filter: ProgressFilter = {},
  goals: readonly CollabGoal[] = [],
  sprints: readonly CollabSprint[] = [],
  nameOfAssignee: (id?: string) => string = assigneeName,
): string {
  const parts: string[] = []
  const joined = (vals: readonly string[] | undefined): string | undefined =>
    vals !== undefined && vals.length > 0 ? vals.join('、') : undefined

  const goalVals = joined(filter.goal)
  if (goalVals !== undefined) {
    parts.push(`目标: ${filter.goal!.map(id => goals.find(g => g.id === id)?.title ?? id).join('、')}`)
  }
  const sprintVals = joined(filter.sprint)
  if (sprintVals !== undefined) {
    parts.push(`${FILTER_TITLES.sprint}: ${filter.sprint!.map(id => sprints.find(s => s.id === id)?.title ?? id).join('、')}`)
  }
  const projectVals = joined(filter.project)
  if (projectVals !== undefined) parts.push(`${FILTER_TITLES.project}: ${projectVals}`)
  const assigneeVals = joined(filter.assignee)
  if (assigneeVals !== undefined) {
    parts.push(`${FILTER_TITLES.assignee}: ${filter.assignee!.map(id => nameOfAssignee(id)).join('、')}`)
  }
  const typeVals = joined(filter.type)
  if (typeVals !== undefined) parts.push(`${FILTER_TITLES.type}: ${typeVals}`)
  const labelVals = joined(filter.label)
  if (labelVals !== undefined) parts.push(`${FILTER_TITLES.label}: ${labelVals}`)
  const propVals = joined(filter.prop)
  if (propVals !== undefined) parts.push(`${FILTER_TITLES.prop}: ${propVals}`)
  const versionVals = joined(filter.version)
  if (versionVals !== undefined) parts.push(`${FILTER_TITLES.version}: ${versionVals}`)
  const moduleVals = joined(filter.module)
  if (moduleVals !== undefined) parts.push(`${FILTER_TITLES.module}: ${moduleVals}`)
  const stampVals = joined(filter.stamp as readonly string[] | undefined)
  if (stampVals !== undefined) {
    parts.push(`${FILTER_TITLES.stamp}: ${filter.stamp!.map(s => STATUS_TITLES[s] ?? s).join('、')}`)
  }

  return parts.length > 0 ? parts.join('；') : '全部事项'
}

export interface SummarizeProgressInput {
  tasks: readonly TaskView[]
  goals?: readonly CollabGoal[] | undefined
  sprints?: readonly CollabSprint[] | undefined
  filter?: ProgressFilter | undefined
  presence?: readonly CollabPresence[] | undefined
  sessions?: readonly SessionView[] | undefined
  serverNow?: string | undefined
  nowMs?: number | undefined
  nameOfAssignee?: ((id?: string) => string) | undefined
  runs?: readonly RunSegment[] | undefined
}

/**
 * 汇总进展全量模型计算。
 */
export function summarizeProgress(input: SummarizeProgressInput): ProgressSummaryModel {
  const now = input.nowMs ?? Date.now()
  const nameOf = input.nameOfAssignee ?? assigneeName
  const goals = input.goals ?? []
  const sprints = input.sprints ?? []
  const filter = input.filter ?? {}

  // 1. 演示数据隔离
  const { production, demo } = partitionProductionTasks(input.tasks)

  // 2. 父子任务汇总去重
  const { dedupedWorkTasks, parentGroupTasks } = dedupTasksParentChild(production)

  // 3. 构建详细条目
  const groups: Record<ExecutionTruth, TaskProgressDetail[]> = {
    delivered: [],
    accepted: [],
    review: [],
    running: [],
    dispatched_queued: [],
    turn_ended: [],
    waiting_receipt: [],
    unstarted: [],
    blocked: [],
    canceled: [],
  }

  const capabilityConditions: CapabilityCondition[] = []

  for (const task of dedupedWorkTasks) {
    const truth = classifyExecutionTruth(task, {
      runs: input.runs,
      presence: input.presence,
      sessions: input.sessions,
      nowMs: now,
    })

    const lastTime = task.receipt?.at ?? task.dispatch?.started_at ?? task.updated_at
    const acceptance = task.acceptance ?? []
    const detail: TaskProgressDetail = {
      task,
      truth,
      truthLabel: EXECUTION_TRUTH_TITLES[truth],
      assigneeText: nameOf(task.assignee),
      lastRecordTime: lastTime,
      lastRecordFormatted: formatIsoTime(lastTime),
      waitReason: extractTaskWaitReason(task),
      nextMover: task.standing?.next,
      acceptanceConditions: acceptance,
      hasUnassignedConditions: acceptance.length === 0,
    }

    groups[truth].push(detail)

    // 事项验收要求来自 task.acceptance;不冒充 goal.conditions 的能力达成。
    // 已取消的事项单列在「已取消」里，不再产出条件（避免取消事项的未声明条件混成「尚未安排」噪音）。
    if (truth !== 'canceled') {
      if (acceptance.length > 0) {
        for (let i = 0; i < acceptance.length; i++) {
          capabilityConditions.push({
            id: `${task.id}-cond-${i}`,
            text: acceptance[i]!,
            taskId: task.id,
            taskTitle: task.title,
            status: truth,
            statusLabel: EXECUTION_TRUTH_TITLES[truth],
            evidence: task.receipt?.evidence,
          })
        }
      } else {
        capabilityConditions.push({
          id: `${task.id}-cond-none`,
          text: `（未声明验收条件：尚未安排）`,
          taskId: task.id,
          taskTitle: task.title,
          status: truth,
          statusLabel: EXECUTION_TRUTH_TITLES[truth],
          unassigned: true,
        })
      }
    }
  }

  // 4. 统计数量（合并待回执/未接单/回合结束等未知执行到 waiting_receipt 组计数）
  const waitingTotal = groups.waiting_receipt.length + groups.dispatched_queued.length + groups.turn_ended.length

  const counts: ProgressSummaryCounts = {
    delivered: groups.delivered.length,
    accepted: groups.accepted.length,
    review: groups.review.length,
    running: groups.running.length,
    waiting_receipt: waitingTotal,
    unstarted: groups.unstarted.length,
    blocked: groups.blocked.length,
    canceled: groups.canceled.length,
    remaining: groups.accepted.length + groups.review.length + groups.running.length + waitingTotal + groups.blocked.length + groups.unstarted.length,
    totalProduction: dedupedWorkTasks.length,
  }

  // 剩余工作清单 (不含 delivered, 不含 canceled)
  const remainingList: TaskProgressDetail[] = [
    ...groups.accepted,
    ...groups.review,
    ...groups.running,
    ...groups.dispatched_queued,
    ...groups.turn_ended,
    ...groups.waiting_receipt,
    ...groups.blocked,
    ...groups.unstarted,
  ]

  // 5. 快照时效检测
  let snapshotStale = false
  if (input.serverNow) {
    const sMs = Date.parse(input.serverNow)
    if (Number.isFinite(sMs) && now - sMs > 60_000) {
      snapshotStale = true
    }
  }

  return {
    scopeName: extractScopeName(filter, goals, sprints, nameOf),
    counts,
    groups,
    remainingList,
    capabilityConditions,
    demoCount: demo.length,
    snapshotStale,
    snapshotTimeText: formatIsoTime(input.serverNow),
    parentGroupTasks,
    dedupedTasks: dedupedWorkTasks,
  }
}
