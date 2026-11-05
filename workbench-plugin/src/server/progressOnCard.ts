/**
 * 卡上那一格「现在到哪」该摆哪一份(2026-10-12,卡 `claude/ops-patch-1012`;运营同学 10-09「跨设备同步」那一条)。
 *
 * 他在手机与电脑上看到的:一张已经办完的卡,进度那一行还写着上一轮核对出来的「在做」;一张刚改过状态的卡,
 * 挂着的还是改之前核的那份 —— 两端各自拿旧进度盖住了新状态。
 *
 * 规矩两条:
 *   ① **收场的卡以主状态为准**:办完 → 「已完成」,取消 → 「已取消」(`by:'rules'`,没有依据可列);
 *   ② **比卡还旧的进度不下发**:核对时刻比卡的最后更新早过 {@link PROGRESS_STALE_GRACE_MS} 的那一份藏起来,
 *      等下一轮核对(早报 / 他问 / 派出去 / 交回来都会触发)。留两分钟余量是因为核对那一轮自己也会动卡
 *      (证据够了就把「待办」推到「在办」,见 progress.ts),那一下不该把刚核出来的进度判成旧的。
 */
import type { TaskProgressView, TaskStatus } from '../protocol.ts'

export const PROGRESS_STALE_GRACE_MS = 2 * 60_000
export const PROGRESS_DONE_LINE = '已完成'
export const PROGRESS_CANCELED_LINE = '已取消'

export interface ProgressCardTask {
  status: TaskStatus
  updated_at: string
  done_at?: string
}

export function progressOnCard(task: ProgressCardTask, stored: TaskProgressView | undefined): TaskProgressView | undefined {
  if (task.status === 'done') {
    return { line: PROGRESS_DONE_LINE, state: 'found', basis: [], checked_at: task.done_at ?? task.updated_at, waiting_on: 'nobody', by: 'rules' }
  }
  if (task.status === 'canceled') {
    return { line: PROGRESS_CANCELED_LINE, state: 'found', basis: [], checked_at: task.updated_at, waiting_on: 'nobody', by: 'rules' }
  }
  if (stored === undefined) return undefined
  const taskAt = Date.parse(task.updated_at)
  const checkedAt = Date.parse(stored.checked_at)
  // 时刻认不出就照旧下发 —— 不因为一个解不开的字符串把进度藏起来。
  if (!Number.isFinite(taskAt) || !Number.isFinite(checkedAt)) return stored
  return taskAt - checkedAt > PROGRESS_STALE_GRACE_MS ? undefined : stored
}
