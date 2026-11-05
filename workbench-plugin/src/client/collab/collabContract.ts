/**
 * 协作区契约类型的消费侧收口(2026-10-24,小K collab-desktop-1024)。
 *
 * core 的正式类型已落 `src/protocol.ts`(协作区一节,契约 v2):这里**一律 re-export
 * 真源,不再自带形状**;只留 UI 展示用的文字表(断言文案用,不逐字抄服务端原文)。
 * 差异与请求写 coordinator-state 的 collab-desktop-kimi-seam-request.md,交唯一 core 主人。
 */
import type {
  ActivityItem, CapacityItem, CollabGoal, GoalBoardSummary, GoalCondition, GoalConditionState, GoalConditionVerification,
  LanIdentity, LanMember, MessageDelivery, NoteMessage, NoteMessageIntent, RunSegment, TaskRelation, TaskRelationKind,
} from '../../protocol.ts'

export type {
  ActivityItem, CapacityItem, CollabGoal, GoalBoardSummary, GoalCondition, GoalConditionState, GoalConditionVerification,
  LanIdentity, LanMember, MessageDelivery, NoteMessage, NoteMessageIntent, RunSegment, TaskRelation, TaskRelationKind,
}

/** 条件状态的人话(配 data-state 浅状态色,不只靠颜色)。 */
const conditionTitles = {
  pending: '尚未安排',
  dispatched: '已派出，待开工证据',
  unknown: '执行状态未知',
  doing: '已开工',
  blocked: '受阻',
  submitted: '交回待验',
  rework: '退回重做',
  verified: '已验收',
  delivered: '已交付',
}
export const GOAL_CONDITION_TITLES: Readonly<Record<GoalConditionState, string>> = conditionTitles

/** 目标状态的人话:re-export 真源(2026-10-28 起真源在 protocol.ts,服务端听懂回话同一套词)。 */
export { GOAL_STATUS_TITLES } from '../../protocol.ts'

/** 投递态的人话(已受理待处理 / 已开始处理 / 没送到+原因,三态不混)。 */
export const DELIVERY_TITLES: Readonly<Record<MessageDelivery['status'], string>> = {
  pending: '已受理,待处理',
  delivered: '已送达',
  accepted: '已开始处理',
  failed: '没送到',
}

/** 运行片段状态的人话。 */
const runTitles = {
  dispatched: '已派出，待开工证据',
  running: '实际运行',
  paused: '暂停等待',
  done: '已收场',
  failed: '失败',
  unknown: '状态未知',
}
export const RUN_STATUS_TITLES: Readonly<Record<RunSegment['status'], string>> = runTitles

/** 关系种类的人话(父子不在此列,走 children)。 */
export const RELATION_TITLES: Readonly<Record<TaskRelationKind, string>> = {
  derived: '衍生',
  depends_on: '前置依赖',
  handoff: '流程交接',
  rejected_back: '验收退回',
  reference: '参考',
}
