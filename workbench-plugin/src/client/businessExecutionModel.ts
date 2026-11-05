import type { RunSegment, WorkbenchState } from '../protocol.ts'

/**
 * 悬浮球展开窗「在跑的事项」那一列的口径(2026-10-28,断点④):与 `GET /collab/runs` 同一本账。
 * 由来:事务官窗曾「在跑的事项 0」而 /collab/runs 有两条在跑 —— 那一列原来读 /state.running 快照,
 * 快照与任务日志各数各的。在跑 = 有未收场、近期核到开工的**业务**片段(与 /collab/capacity 的
 * running_jobs 同一判据);暂停 / 已收场 / 派出未开工 / 失联都不算。按事项去重,保留片段顺序。
 */
export function runningTaskIdsOfRuns(segments: readonly RunSegment[]): string[] {
  const ids: string[] = []
  for (const segment of segments) {
    if (segment.status !== 'running' || segment.role !== 'business') continue
    if (!ids.includes(segment.task_id)) ids.push(segment.task_id)
  }
  return ids
}

/**
 * 运行片段的那本账接到哪一步了:数组 = 接上了; 'missing' = 服务没接上(回包不是数组,
 * 老服务端 404 同路); undefined = 还没回。消费方**只经 runningCountOf 读数**,自己不再判。
 */
export type CollabRunFacts = readonly RunSegment[] | 'missing' | undefined

/**
 * 「在跑几件」一处定数(2026-10-28,断点④残留,第 3 轮按退修收窄到收起球这一处):接上了
 * /collab/runs 由片段判(口径在 runningTaskIdsOfRuns,与 /collab/capacity 的 running_jobs 同判据);
 * 没接上(undefined / 'missing')退回 /state.running 快照口径 —— 快照与任务日志曾各数各的
 * (窗里写 0、协作区写 2)。球下计数行、汇报条仍读快照,是统筹收窄后有意留下的残留,见交接。
 */
export function runningCountOf(facts: CollabRunFacts, snapshot: number | undefined): number | undefined {
  return Array.isArray(facts) ? runningTaskIdsOfRuns(facts).length : snapshot
}

export function businessExecutionView(state: Pick<WorkbenchState, 'running' | 'stale' | 'tasks'>) {
  if (state.running?.scope === 'classified_business_tasks') {
    const ids = [...new Set(state.running.items.filter(one => one.role === 'business').flatMap(one => one.task_id === undefined ? [] : [one.task_id]))]
    const excluded = state.running.excluded ?? []
    return { ids, unclassified: excluded.filter(one => one.role === 'unclassified').map(one => one.task_id).filter((id): id is string => id !== undefined),
      coordination: excluded.filter(one => one.role === 'coordination'), excluded,
      observed: state.running.observed_count ?? ids.length,
      count: state.stale ? undefined : state.running.count }
  }
  const allIds = [...new Set((state.running?.items ?? []).flatMap(one => one.task_id === undefined ? [] : [one.task_id]))]
  const unclassified = allIds.filter(id => state.tasks?.tasks.find(one => one.id === id)?.source?.kind === 'session')
  const ids = allIds.filter(id => !unclassified.includes(id))
  return { ids, unclassified, coordination: [], excluded: [], observed: ids.length,
    count: !state.stale && state.running?.count !== undefined && unclassified.length === 0 ? ids.length : undefined }
}
