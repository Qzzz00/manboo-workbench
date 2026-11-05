/**
 * 协作区事项详情接过来的原事务官页那几样(2026-10-27,合并稿第六节)的小判据。
 * 跟事务官页同口径:「干预」那一段画不画与 `ItemControls` 自己的判断一致;执行者一行与原 `Details` 同一句话。
 */
import type { SessionView, TaskView } from '../../protocol.ts'
import type { SceneItem } from '../butlerSceneModel.ts'
import { stoppable } from '../itemControlsModel.ts'

/** 与 `ItemControls` 返回 null 的条件互补:有花费、派不出去、能停、或还没收场(能取消)。 */
export function hasItemControls(task: TaskView, sessions: readonly SessionView[]): boolean {
  return task.budget !== undefined || task.dispatch_block !== undefined || stoppable(task, sessions)
    || (task.status !== 'done' && task.status !== 'canceled')
}

/** 执行者此刻怎样(在线 / 出错 / 停下 / 掉线),与原事务官页详情同一句。 */
export function executorLine(executor: SceneItem['executors'][number]): string {
  if (executor.offline) return '掉线了 · 最后的进度没更新'
  const session = executor.session
  if (session?.status === 'running') return '正在执行'
  if (session?.status === 'waiting') return '等待中'
  if (session?.status === 'error') return session.reason === 'interrupted' ? '已停下(按了停止,或者到上限先停的)' : '执行出错'
  if (session?.status === 'done') return '会话已结束'
  return '执行状态未知'
}
