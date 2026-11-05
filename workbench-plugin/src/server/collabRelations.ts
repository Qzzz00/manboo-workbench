import type { TaskRelation, TaskView } from '../protocol.ts'

/** 只有成果承接边传播失效;依赖、参考与退回是另外的事实。允许成果图有环,每个节点只访问一次。 */
export function downstreamTasks(sources: Iterable<string>, relations: readonly TaskRelation[]): Set<string> {
  const affected = new Set(sources)
  const queue = [...affected]
  for (let i = 0; i < queue.length; i += 1) {
    for (const edge of relations) {
      if (edge.from_id !== queue[i] || edge.kind !== 'handoff' && edge.kind !== 'derived' || affected.has(edge.to_id)) continue
      affected.add(edge.to_id)
      queue.push(edge.to_id)
    }
  }
  return affected
}

export function staleRelation(edge: TaskRelation, rounds: ReadonlyMap<string, number>): boolean {
  return (edge.kind === 'handoff' || edge.kind === 'derived') && (rounds.get(edge.from_id) ?? 1) > (edge.round ?? 1)
}

/** 所有读写验收入口共同核对上游轮次,也覆盖升级前已存在的 stale 关系。 */
export function staleUpstreamTasks(tasks: readonly Pick<TaskView, 'id' | 'round'>[], relations: readonly TaskRelation[]): Set<string> {
  const rounds = new Map(tasks.map(task => [task.id, task.round ?? 1]))
  return downstreamTasks(relations.filter(edge => staleRelation(edge, rounds)).map(edge => edge.to_id), relations)
}
