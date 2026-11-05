import { useId, useState } from 'react'
import { createPortal } from 'react-dom'
import type { RunSegment, WorkbenchState } from '../protocol.ts'
import { friendlyWhen, sessionActivityLine } from '../protocol.ts'
import { agentTitle } from './butlerSceneModel.ts'

import { businessExecutionView, runningTaskIdsOfRuns } from './businessExecutionModel.ts'

/**
 * 汇报条(球下那一行「业务任务正在执行 n 件」)。`runFacts` 是 /collab/runs 的运行片段(与协作区同一本账,
 * 2026-10-28 残留清理):传进来且是数组时,n 与清单 ids 按片段判在跑;没接上('missing'/undefined)或不传
 * 时一字照旧,读 /state.running 快照。面板里每条任务的细节(sources 等)仍按现有逻辑从 state.running 取。
 */
export function BusinessExecution({ state, onOpenTask, panelRoot, onExpandedChange, runFacts }: { state: WorkbenchState, onOpenTask: (id: string) => void, panelRoot?: HTMLElement | null, onExpandedChange?: (open: boolean) => void, runFacts?: readonly RunSegment[] | 'missing' | undefined }) {
  const listId = useId()
  const [open, setOpen] = useState(false)
  const updateOpen = (value: boolean) => { setOpen(value); onExpandedChange?.(value) }
  const running = state.running
  const snapshot = businessExecutionView(state)
  const { unclassified, coordination, excluded, observed } = snapshot
  const ids = Array.isArray(runFacts) ? runningTaskIdsOfRuns(runFacts) : snapshot.ids
  const count = Array.isArray(runFacts) ? ids.length : snapshot.count
  const unlinked = [...new Map((running?.items ?? []).filter(one => one.task_id === undefined).map(one => [JSON.stringify([one.agent, one.session_id ?? one.key]), one])).values()]
  const known = count !== undefined
  const label = known ? `业务任务正在执行 ${count} 件` : '业务任务执行状态未知'
  const panel = <section id={listId} role="region" aria-label="正在执行的业务任务" className="ben-wb__business-list">
      <header><span>{known ? label : '最后已知业务任务 · 当前状态未知'}</span><button type="button" onClick={() => updateOpen(false)}>收起执行清单</button></header>
      {ids.length === 0 && <p>{known ? '当前公共运行清单没有业务任务；未纳管来源不在此数内。' : '公共运行事实尚不可用，无法确认业务任务数量。'}</p>}
      <ul>{ids.map(id => {
        const facts = running?.items.filter(one => one.task_id === id) ?? []
        const task = state.tasks?.tasks.find(one => one.id === id)
        const sources = facts.flatMap(one => one.sources ?? []).filter(one => one.role === 'business' || one.role === 'coordination')
        const refs = [...(task?.links ?? []), ...facts.flatMap(one => one.session_id === undefined ? [] : [{ agent: one.agent, session_id: one.session_id }])]
        const sessions = [...new Map(refs.map(ref => {
          const session = state.sessions.find(one => one.agent === ref.agent && one.session_id === ref.session_id)
            ?? state.agent_registry?.entries.flatMap(one => one.sessions).find(one => one.agent === ref.agent && one.session_id === ref.session_id)
          return [JSON.stringify([ref.agent, ref.session_id]), { ref, session }] as const
        })).values()]
        const providers = sources.length > 0 ? [...new Set(sources.filter(one => one.role === 'business').map(one => one.provider ?? '提供方未确认'))].map(one => one === '提供方未确认' ? one : agentTitle(one, state)).join(' · ')
          : [...new Set([...facts.map(one => one.agent), ...refs.map(ref => ref.agent)])].map(agent => agentTitle(agent, state)).join(' · ')
        const owner = state.tasks?.agent_cards?.find(one => one.id === task?.assignee)?.name ?? (task?.assignee === undefined ? '未指定' : agentTitle(task.assignee, state))
        const title = task?.title ?? facts[0]?.text ?? id
        return <li key={id}>
          <button type="button" aria-label={`打开业务任务:${title}`} disabled={task === undefined} onClick={() => { onOpenTask(id); updateOpen(false) }}>{title}</button>
          {task === undefined && <p>事项详情尚未同步</p>}
          <p>负责人 {owner} · 提供方 {providers}</p>
          {sources.length > 0 ? sources.map(source => {
            const session = state.sessions.find(one => one.agent === source.agent && one.session_id === source.session_id)
            const provider = source.provider === undefined ? '提供方未确认' : agentTitle(source.provider, state)
            const transport = source.transport === 'codex-rollout' ? 'Codex CLI' : source.transport === 'kimi-wire' ? 'Kimi CLI' : source.transport ?? '来源未确认'
            const status = source.state === 'running' ? '执行中' : source.state === 'returned' ? '已交回' : source.state === 'unknown' ? '来源未知' : source.state === 'interrupted' ? '已中断' : '已结束'
            const last = source.rounds.at(-1)?.kind
            const action = session?.activity === undefined ? session?.summary ?? (last === 'updated' ? '有新进展，内容未同步' : last === 'started' ? '已开工，细节未同步' : '当前动作未同步') : sessionActivityLine(session.activity, state.now)
            const at = source.rounds.at(-1)?.at ?? session?.updated_at
            return <p key={JSON.stringify([source.agent, source.session_id])}>{provider} · {transport} · {source.role === 'coordination' ? '协作' : '业务'} · {status} · 当前动作 {action} · 最后更新 {at === undefined ? '未知' : friendlyWhen(at, state.now)}</p>
          }) : sessions.length === 0 ? <p>当前动作未知 · 最后更新未知</p> : sessions.map(({ ref, session }) => <p key={JSON.stringify(ref)}>{agentTitle(ref.agent, state)} · {session?.status === 'running' ? '执行中' : session?.status === 'waiting' ? '等待中' : session?.status === 'done' ? '会话结束' : session?.status === 'offline' ? '来源离线' : session?.status === 'error' ? '来源中断或出错' : '来源状态未知'} · 当前动作 {session?.activity === undefined ? session?.summary ?? '当前动作未知' : sessionActivityLine(session.activity, state.now)} · 最后更新 {session?.updated_at === undefined ? '未知' : friendlyWhen(session.updated_at, state.now)}</p>)}
        </li>
      })}</ul>
      <small>仅含公共运行清单已纳管事项；未关联会话另列。事项章本身不代表正在执行。</small>
    </section>
  return <div className="ben-wb__business-execution">
    <button type="button" aria-expanded={open} aria-controls={listId} onClick={() => updateOpen(!open)}>{label}<span aria-hidden="true">{open ? ' −' : ' ›'}</span></button>
    {!known && running?.scope === 'classified_business_tasks' && <small>已观测业务任务 {observed} 件 · 总数未知</small>}
    {state.stale && <small>Agent 掉线 · 保留最后已知状态</small>}
    {unclassified.length > 0 && <details><summary>来源角色未知 {unclassified.length} · {known ? '未计入当前业务任务' : '业务总数未确认'}</summary><ul>{unclassified.map(id => <li key={id}><button type="button" onClick={() => onOpenTask(id)}>{state.tasks?.tasks.find(one => one.id === id)?.title ?? id}</button> · 来源未分类，待确认业务角色</li>)}</ul></details>}
    {coordination.length > 0 && <details><summary>协调会话 {coordination.length} · 不计业务任务</summary><ul>{coordination.map(one => <li key={one.key}>{one.text} · {one.sources?.map(source => source.provider ?? '提供方未确认').join(' · ') ?? one.agent}</li>)}</ul></details>}
    {excluded.length > unclassified.length + coordination.length && <small>另有 {excluded.length - unclassified.length - coordination.length} 件未分类来源</small>}
    {unlinked.length > 0 && <details><summary>未关联事项的会话 {unlinked.length} · 未计入业务任务</summary><ul>{unlinked.map(one => <li key={one.key}>{one.text} · {agentTitle(one.agent, state)}</li>)}</ul></details>}
    {open && (panelRoot ? createPortal(panel, panelRoot) : panel)}
  </div>
}
