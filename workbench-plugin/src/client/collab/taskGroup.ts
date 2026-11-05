import type { TaskStatus, TaskView } from '../../protocol.ts'
export const isTaskGroup = (task: TaskView): boolean => (task.children?.length ?? 0) > 0
/** 只读汇总，不把父组账上的手工状态当作子事项成果。缺项/循环不能算完成。 */
export function groupFacts(task: TaskView, tasks: readonly TaskView[], path = new Set<string>()): { status: TaskStatus, done: number, total: number, unknown: boolean } {
  const ids = [...new Set(task.children ?? [])]
  if (ids.length === 0) return { status: task.status, done: task.status === 'done' ? 1 : 0, total: 1, unknown: false }
  if (path.has(task.id)) return { status: 'todo', done: 0, total: ids.length, unknown: true }
  const next = new Set(path).add(task.id)
  const children = ids.map(id => { const child = tasks.find(one => one.id === id); return child === undefined ? { status: 'todo' as const, unknown: true } : groupFacts(child, tasks, next) })
  const done = children.filter(one => !one.unknown && one.status === 'done').length
  const unknown = children.some(one => one.unknown)
  const status: TaskStatus = !unknown && done === ids.length ? 'done' : children.some(one => one.status === 'blocked') ? 'blocked' : children.some(one => one.status === 'doing') ? 'doing' : children.some(one => one.status === 'confirm') ? 'confirm' : 'todo'
  return { status, done, total: ids.length, unknown }
}
