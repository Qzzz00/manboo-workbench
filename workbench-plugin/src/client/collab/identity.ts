/**
 * 事项上的两个身份(2026-10-27,《设计-协作区与事务官标签页合并》§3.1):执行与管理。
 * 只读卡上已有的事实,不猜:执行没有新字段,按「最后一段关联窗口 → 派活那一家 → 负责人」取;
 * 管理只读建卡 / 派活时记下的 `manager`,缺席就是不知道。
 */
import type { TaskAssignee, TaskView } from '../../protocol.ts'

/** 真实在干(或最后干过)这件事的那一家;都没有 = 缺席。 */
export function executorOf(task: TaskView): TaskAssignee | undefined {
  const last = task.links?.[task.links.length - 1]
  if (last !== undefined) return last.agent
  if (task.dispatch?.family !== undefined && task.dispatch.family !== '') return task.dispatch.family
  return task.assignee
}

/** 谁管这件事(派活与验收);缺席 = 卡上没记。 */
export function managerOf(task: TaskView): TaskAssignee | undefined {
  return task.manager
}
