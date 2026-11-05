/**
 * 真实回执飞线的触发(2026-10-27,合并稿 7.1)。只认任务账:同一件事项在两份快照之间多了一条回执
 * (`receipt.at` 变了)且写了是谁交回的(`receipt.by`)。第一份快照与新冒出来的事项不算 —— 那是旧账,不是此刻发生的。
 * 不从状态推:改章、派活、在跑都不飞。
 */
import type { TaskView } from '../../protocol.ts'

export interface Flight { key: string, taskId: string, from: string }

export function receiptFlights(prev: readonly TaskView[] | undefined, next: readonly TaskView[]): Flight[] {
  if (prev === undefined) return []
  const before = new Map(prev.map(one => [one.id, one.receipt?.at]))
  const out: Flight[] = []
  for (const task of next) {
    const receipt = task.receipt
    if (receipt === undefined || receipt.by === undefined || !before.has(task.id)) continue
    if (before.get(task.id) === receipt.at) continue
    out.push({ key: `${task.id}@${receipt.at}`, taskId: task.id, from: receipt.by })
  }
  return out
}
