import { useEffect, useState } from 'react'
import type { CollabGoal, GoalBoardSummary, WorkbenchState } from '../../protocol.ts'
import type { CollabApi } from './collabApi.ts'
import { GOAL_CONDITION_TITLES } from './collabContract.ts'

/** 固定在任务滚动区外，达成与剩余只消费正式条件账，不按事项数补算。 */
export function FixedGoalSummary({ goals, selected, onSelect, api, snapshot, stale, nameOf, onOpen, onConditions, collapsed = false, onToggle }: {
  collapsed?: boolean, onToggle?: () => void,
  goals: readonly CollabGoal[], selected: string | undefined, onSelect: (id: string) => void,
  api: CollabApi, snapshot: WorkbenchState['tasks'], stale: boolean,
  nameOf: (id: string | undefined) => string, onOpen: (id: string) => void, onConditions: (goal: CollabGoal) => void,
}) {
  const goal = goals.find(one => one.id === selected) ?? goals[0]
  return <section className="ben-cl__fixed-goal" aria-label="当前目标能力摘要">
    <label>当前目标 <select aria-label="当前目标" value={goal?.id ?? ''} onChange={event => onSelect(event.target.value)}>{goals.map(one => <option key={one.id} value={one.id}>{one.title}</option>)}</select></label>
    {onToggle !== undefined && <button type="button" aria-expanded={!collapsed} onClick={onToggle}>能力条件</button>}
    <div hidden={collapsed}>
    {goal === undefined ? <p>还没有目标，能力条件未知。</p> : <GoalFacts key={goal.id} goal={goal} api={api} snapshot={snapshot} stale={stale} nameOf={nameOf} onOpen={onOpen} onConditions={onConditions} />}
    </div>
  </section>
}
function GoalFacts({ goal, api, snapshot, stale, nameOf, onOpen, onConditions }: {
  goal: CollabGoal, api: CollabApi, snapshot: WorkbenchState['tasks'], stale: boolean,
  nameOf: (id: string | undefined) => string, onOpen: (id: string) => void, onConditions: (goal: CollabGoal) => void,
}) {
  const [board, setBoard] = useState<GoalBoardSummary>()
  const [unknown, setUnknown] = useState(false)
  useEffect(() => {
    let alive = true
    void api.get<{ summary?: GoalBoardSummary }>(`/collab/goal/board?goal_id=${encodeURIComponent(goal.id)}`).then(got => {
      if (!alive) return
      if (got?.summary?.conditions === undefined) { setUnknown(true); return }
      setBoard(got.summary); setUnknown(false)
    })
    return () => { alive = false }
  }, [api, goal.id, snapshot])
  return <>
    <button type="button" className="ben-cl__link" onClick={() => onConditions(goal)}>查看条件与证据</button>
    {(unknown || stale) && <p role="status">条件状态未知{board === undefined ? '。' : '，下面保留上次记录。'}</p>}
    {board === undefined ? <p className="ben-cl__muted">尚未读到能力条件。</p> : <>
      <p>{unknown || stale ? '上次记录 · ' : ''}能力条件 {board.conditions.total} · 已交付 {board.conditions.by_state.delivered ?? 0} · 剩余条件 {Math.max(0, board.conditions.total - (board.conditions.by_state.delivered ?? 0))}（尚待交付或解决）</p>
      <ul>{board.conditions.items.map(item => <li key={item.id} data-state={unknown || stale ? 'unknown' : item.state}>
        {item.task_id === undefined ? <span>{item.text}</span> : <button type="button" className="ben-cl__link" onClick={() => onOpen(item.task_id!)}>{item.text}</button>}
        <span> · {GOAL_CONDITION_TITLES[item.state] ?? '未知'}</span>
        <small> · {item.assignee === undefined ? '承接人未知' : nameOf(item.assignee)}{item.blocker?.reason === undefined ? '' : ` · 缺 ${item.blocker.reason}`}{item.blocker?.next === undefined ? '' : ` · 下一步 ${item.blocker.next}`}</small>
      </li>)}</ul>
      {board.conditions.total === 0 && <p className="ben-cl__muted">目标尚未声明能力条件，不能按事项数判达成。</p>}
    </>}
  </>
}
