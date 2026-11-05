import { useEffect, useState } from 'react'
import type { RunSegment, TaskView } from '../../protocol.ts'
import { goalIdOf } from '../../protocol.ts'
import type { CollabApi } from './collabApi.ts'
import { runLine } from './RunsPanel.tsx'

/** 当前筛选事项的真实执行账。与左侧计划刻度分开,缺记录不从 doing/时长补算。 */
export function TimelineActual({ api, tasks, onOpen }: { api: CollabApi, tasks: readonly TaskView[], onOpen: (id: string) => void }) {
  const [runs, setRuns] = useState<readonly RunSegment[]>()
  const [unknown, setUnknown] = useState(false)
  useEffect(() => {
    let alive = true
    const goals = [...new Set(tasks.map(goalIdOf))]
    void Promise.all(goals.map(id => api.get<{ runs?: RunSegment[] }>(`/collab/runs?goal_id=${encodeURIComponent(id)}`))).then(results => {
      if (!alive) return
      if (results.some(result => !Array.isArray(result?.runs))) { setUnknown(true); return }
      setUnknown(false)
      setRuns(results.flatMap(result => result?.runs ?? []))
    })
    return () => { alive = false }
  }, [api, tasks])
  return <section className="ben-cl__timeline-actual" role="region" aria-label="实际执行记录">
    <h3>实际执行</h3>
    <p className="ben-cl__muted">当前筛选事项的全部运行片段；计划时间在左侧。</p>
    {unknown && <p role="status">执行账暂时读不到，当前状态未知{runs === undefined ? '。' : '；保留上次已知记录。'}</p>}
    {!unknown && runs === undefined && <p role="status">在读执行账…</p>}
    <ul>{tasks.map(task => {
      const segments = runs?.filter(run => run.task_id === task.id) ?? []
      return <li key={task.id}>
        <button type="button" className="ben-cl__link" aria-label={`查看实际记录 · ${task.title}`} onClick={() => onOpen(task.id)}>{task.title}</button>
        {runs !== undefined && segments.length === 0 && <p className="ben-cl__muted">没有实际执行记录，是否开工未知。</p>}
        {segments.map((run, index) => <div key={`${run.started_at}-${index}`} data-status={unknown ? 'unknown' : run.status}>
          <time dateTime={run.started_at}>派出记录日期：{new Date(run.started_at).toLocaleDateString('zh-CN')}</time>
          <p>{unknown ? '上次记录：' : ''}{runLine(run)}</p>
        </div>)}
      </li>
    })}</ul>
  </section>
}
