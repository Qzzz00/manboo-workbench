import { useEffect, useState } from 'react'
import type { GoalBoardSummary, GoalCondition } from '../protocol.ts'
import type { CollabApi } from './collab/collabApi.ts'
import { GOAL_CONDITION_TITLES } from './collab/collabContract.ts'

/** Read B's formal projection. Request revisions prevent a slow old response reviving a returned condition. */
export function TaskConditionFacts({ taskId, goalId, revision, api, history = [], round = 1 }: {
  taskId: string, goalId: string, revision: string, api: CollabApi,
  history?: readonly GoalCondition[], round?: number,
}) {
  const key = JSON.stringify([goalId, taskId, revision])
  const [loaded, setLoaded] = useState<{ key: string, summary?: GoalBoardSummary }>()
  useEffect(() => {
    let current = true
    void api.get<{ summary?: GoalBoardSummary }>(`/collab/goal/board?goal_id=${encodeURIComponent(goalId)}`).then(got => {
      if (current) setLoaded({ key, ...(got?.summary?.goal_id === goalId ? { summary: got.summary } : {}) })
    }).catch(() => { if (current) setLoaded({ key }) })
    return () => { current = false }
  }, [api, goalId, key])
  const summary = loaded?.key === key ? loaded.summary : undefined
  const items = summary?.conditions.items.filter(one => one.task_id === taskId)
  return <div className="ben-wb__particle-progress" aria-label="验收进度">
    {items === undefined ? <p>{GOAL_CONDITION_TITLES.unknown}</p> : items.map(item => <div key={item.id}>
      <p>{item.text}</p><p data-state={item.state}>{GOAL_CONDITION_TITLES[item.state]}</p>
      {(history.find(one => one.id === item.id)?.verifications ?? []).filter(one => one.round !== round).map((one, index) =>
        <small key={index}>旧轮 · {one.pass ? GOAL_CONDITION_TITLES.verified : GOAL_CONDITION_TITLES.rework} · {one.at.slice(0, 10)}</small>)}
    </div>)}
  </div>
}
