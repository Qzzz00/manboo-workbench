/**
 * 目标条(2026-10-27,合并稿 2.1):一行回答四问 —— 当前目标、完成程度(已验收 / 总数 + 每件一格)、
 * 最该看的那一件为什么没完、预计完成(没有可信估计就说缺什么;截止日单写,不当预计)。下面一行说明卡片颜色。
 * 图例本身可点(2026-10-28 维护者拍板):点哪个颜色只看那种卡,可多选,再点取消;与筛选行同一份状态。
 */
import type { CollabGoal, TaskView } from '../../protocol.ts'
import { BOARD_PROGRESS, BOARD_PROGRESS_TITLES, type BoardProgress, goalBrief } from './boardProgress.ts'

export interface LegendPick {
  picked: readonly BoardProgress[]
  onPick: (kind: BoardProgress) => void
}

export function ColorLegend({ pick }: { pick?: LegendPick | undefined } = {}) {
  return (
    <p className="ben-cl__legend-progress" role="note" aria-label="卡片颜色表示完成情况">
      <b>卡片颜色 = 完成情况</b>
      {BOARD_PROGRESS.map(kind => (pick === undefined
        ? <span key={kind} data-progress={kind}><i aria-hidden="true" />{BOARD_PROGRESS_TITLES[kind]}</span>
        : (
            <button key={kind} type="button" data-progress={kind} aria-label={`只看 ${BOARD_PROGRESS_TITLES[kind]}`} aria-pressed={pick.picked.includes(kind)} onClick={() => pick.onPick(kind)}>
              <i aria-hidden="true" />{BOARD_PROGRESS_TITLES[kind]}
            </button>
          )))}
      <small>类型看卡头图标</small>
    </p>
  )
}

export function GoalBar({ goal, tasks, onTrace, pick }: { goal: CollabGoal, tasks: readonly TaskView[], onTrace?: () => void, pick?: LegendPick | undefined }) {
  const brief = goalBrief(goal, tasks)
  return (
    <section className="ben-cl__goalbar" role="region" aria-label="目标进展">
      <div className="ben-cl__goalbar-row">
        <h3 className="ben-cl__goalbar-title">{goal.title}</h3>
        <span className="ben-cl__goalbar-count">{brief.done}/{brief.total} 已验收</span>
        {onTrace !== undefined && <button type="button" className="ben-cl__link ben-cl__goalbar-trace" onClick={onTrace}>目标条件与证据</button>}
      </div>
      <span className="ben-cl__goalbar-rungs" aria-hidden="true">{brief.segments.map((kind, i) => <i key={i} data-progress={kind} />)}</span>
      <p className="ben-cl__goalbar-facts">
        {brief.reason === undefined ? <span>全部事项已完成</span> : <span>未完:{brief.reason}</span>}
        <span>预计完成:{brief.eta}</span>
        {goal.due !== undefined && <span>截止 {goal.due.slice(5)}</span>}
      </p>
      <ColorLegend pick={pick} />
    </section>
  )
}
