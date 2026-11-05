/**
 * 右侧执行轨迹(2026-10-27,合并稿 2.3;取舍 1 定 A,读 `GET /collab/trace?goal_id=`)。
 * 一件没做完的事项一条:派发 / 送达 / 开工 / 交回 / 产物 / 交接 / 退回 / 验收 / 受阻 / 安排,末尾一截是它此刻停在哪。
 * 只摆真实记录;没记录就说「还没有执行记录」,接口取不到就说取不到。方向按自己容器的宽高定。
 * 一件进行中的都没有时摆已完成的(轨迹慢时也不只剩一行字)。
 *
 * 读法(2026-10-28):跟快照重读但不丢在途的那次(`useCoalescedRead`);回包按行验(`readTraceView`),
 * 坏一行只那一行写读不出,每条再包一层兜底。读中先按卡上的事项一件一条摆出来,写已读几秒,超过 `TRACE_SLOW_MS` 说慢在哪。
 */
import { Component, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { TaskTrace, TaskView, TraceNode } from '../../protocol.ts'
import type { CollabApi } from './collabApi.ts'
import { TRACE_CURRENT_TITLES, TRACE_NODE_TITLES, traceDirection } from './boardProgress.ts'
import { readTraceView, type TraceRow } from './traceRows.ts'
import { tasksReadKey, useCoalescedRead } from './useCoalescedRead.ts'

/** 等过这么久还没回,就如实说慢在哪。 */
export const TRACE_SLOW_MS = 5000
const tracePath = (goalId: string): string => `/collab/trace?goal_id=${encodeURIComponent(goalId)}`
const BAD_ROW = '这件的执行记录读不出,先看卡上的状态。'

/** 一条轨迹渲染抛错只坏这一条。 */
class RowGuard extends Component<{ children: ReactNode }, { broken: boolean }> {
  override state = { broken: false }
  static getDerivedStateFromError(): { broken: boolean } { return { broken: true } }
  override render(): ReactNode {
    return this.state.broken ? <p className="ben-cl__muted ben-cl__trace-bad">{BAD_ROW}</p> : this.props.children
  }
}

function readStatus(read: { data?: unknown, loading: boolean, waitedMs: number, missing: boolean }): string | undefined {
  if (!read.loading) return read.missing ? '轨迹记录取不到,先看卡上的状态。' : undefined
  const seconds = Math.floor(read.waitedMs / 1000)
  if (read.waitedMs >= TRACE_SLOW_MS) {
    return `执行记录(/collab/trace)已等 ${seconds} 秒还没回:慢在工作台服务读执行账这一步,不是这页卡住;${read.data === undefined ? '先显示卡上的状态' : '先显示上次读到的'}。`
  }
  return read.data === undefined ? `在读执行记录…… 已读 ${seconds} 秒` : `更新中 · 已读 ${seconds} 秒,先显示上次读到的`
}

function clock(at: string): string {
  const d = new Date(at)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export interface TraceRailProps {
  api: CollabApi
  goalId: string
  /** 这个目标下的事项;它们的内容变了(或过了 `REREAD_EVERY_MS`)就重读。 */
  tasks: readonly TaskView[]
  nameOf: (id: string | undefined) => string
  onOpen: (taskId: string) => void
  /** 量不到时用(用例里给)。 */
  width?: number
  height?: number
}

function NodeItem({ node, nameOf }: { node: TraceNode, nameOf: (id: string | undefined) => string }) {
  const who = node.actor === undefined && node.to === undefined
    ? undefined
    : `${node.actor === undefined ? '' : nameOf(node.actor)}${node.to === undefined ? '' : ` → ${nameOf(node.to)}`}`.trim()
  return (
    <li className="ben-cl__trace-node" data-kind={node.kind}>
      <i aria-hidden="true" />
      <time dateTime={node.at}>{clock(node.at)}</time>
      <b>{TRACE_NODE_TITLES[node.kind]}</b>
      {who !== undefined && who !== '' && <small>{who}</small>}
      {node.text !== undefined && <small className="ben-cl__trace-text">{node.text}</small>}
      {(node.evidence ?? []).slice(0, 2).map(one => <code key={one}>{one}</code>)}
    </li>
  )
}

function TraceLine({ trace, nameOf }: { trace: TaskTrace | undefined, nameOf: (id: string | undefined) => string }) {
  const nodes = trace?.nodes ?? []
  const current = trace?.current ?? { state: 'unknown' as const }
  return (
      <ol className="ben-cl__trace-line">
        {nodes.length === 0 && <li className="ben-cl__trace-empty">还没有执行记录</li>}
        {nodes.map((node, i) => <NodeItem key={`${node.at}-${node.kind}-${i}`} node={node} nameOf={nameOf} />)}
        <li className="ben-cl__trace-node ben-cl__trace-current" data-state={current.state}>
          <i aria-hidden="true" />
          {current.since !== undefined && <time dateTime={current.since}>{clock(current.since)}</time>}
          <b>{TRACE_CURRENT_TITLES[current.state]}</b>
          {current.actor !== undefined && <small>{nameOf(current.actor)}</small>}
        </li>
      </ol>
  )
}

/** `row`:undefined = 还在读(这件先只摆头);'none' = 读到了但没这件的记录;'unread' = 整个口取不到(只摆头,不说没记录)。 */
function Lane({ task, row, nameOf, onOpen }: { task: TaskView, row: TraceRow | 'none' | 'unread' | undefined, nameOf: (id: string | undefined) => string, onOpen: (id: string) => void }) {
  return (
    <section className="ben-cl__trace-lane" role="group" aria-label={`${task.title} 的轨迹`}>
      <button type="button" className="ben-cl__trace-head" aria-label={`打开 ${task.title}`} onClick={() => onOpen(task.id)}>
        <b>{task.title}</b>
        <small>{task.assignee === undefined ? '没写负责人' : nameOf(task.assignee)}</small>
      </button>
      {row === 'unread' ? null : row === undefined
        ? <p className="ben-cl__muted ben-cl__trace-wait">记录在读</p>
        : row === 'bad'
          ? <p className="ben-cl__muted ben-cl__trace-bad">{BAD_ROW}</p>
          : <RowGuard><TraceLine trace={row === 'none' ? undefined : row} nameOf={nameOf} /></RowGuard>}
    </section>
  )
}

/**
 * 详情顶部那一条(合并稿第六节「经手 → 顶部轨迹」):同一个口,只摆这一件,时间从左到右。
 * 没有所属目标的事项不画(轨迹按目标读)。
 */
export function TaskTraceStrip({ api, goalId, taskId, snapshotKey, nameOf }: { api: CollabApi, goalId: string, taskId: string, snapshotKey: unknown, nameOf: (id: string | undefined) => string }) {
  const read = useCoalescedRead(api, tracePath(goalId), snapshotKey, readTraceView)
  const row = read.data?.get(taskId)
  return (
    <section className="ben-cl__trace ben-cl__trace--strip" role="region" aria-label="这件的轨迹" data-dir="row">
      {read.data === undefined && read.loading && <p className="ben-cl__muted">在读执行记录……</p>}
      {read.data === undefined && read.missing && <p className="ben-cl__muted" role="status">轨迹记录取不到,先看下面的经手记录。</p>}
      {read.data !== undefined && (row === 'bad'
        ? <p className="ben-cl__muted ben-cl__trace-bad">{BAD_ROW}</p>
        : <RowGuard><TraceLine trace={row} nameOf={nameOf} /></RowGuard>)}
    </section>
  )
}

export function TraceRail({ api, goalId, tasks, nameOf, onOpen, width, height }: TraceRailProps) {
  const ref = useRef<HTMLElement>(null)
  const [size, setSize] = useState<{ w: number, h: number } | undefined>(undefined)
  useLayoutEffect(() => {
    const el = ref.current
    if (el === null || typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect
      if (box !== undefined && box.width > 0 && box.height > 0) setSize(prev => (prev?.w === box.width && prev.h === box.height ? prev : { w: box.width, h: box.height }))
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  const dir = traceDirection(size?.w ?? width ?? 300, size?.h ?? height ?? 600)

  const read = useCoalescedRead(api, tracePath(goalId), tasksReadKey(tasks, Date.now()), readTraceView)
  const status = readStatus(read)

  const open = tasks.filter(task => task.status !== 'done' && task.status !== 'canceled' && task.casual !== true)
  const finished = tasks.filter(task => task.status === 'done' && task.casual !== true)
  const doneCount = tasks.filter(task => task.status === 'done').length
  return (
    <section className="ben-cl__trace" ref={ref} role="region" aria-label="事项轨迹" data-dir={dir}>
      <header className="ben-cl__trace-top">
        <h4>事项轨迹</h4>
        <small>{open.length} 件进行中 · {doneCount} 件已完成</small>
      </header>
      {status !== undefined && <p className="ben-cl__muted ben-cl__trace-status" role="status">{status}</p>}
      <div className="ben-cl__trace-lanes">
        {open.length === 0 && <p className="ben-cl__muted">{finished.length === 0 ? '这个目标没有进行中的事项。' : `这个目标没有进行中的事项,下面是已完成的 ${finished.length} 件。`}</p>}
        {(open.length > 0 ? open : finished).map(task => <Lane key={task.id} task={task} row={read.data === undefined ? (read.missing ? 'unread' : undefined) : read.data.get(task.id) ?? 'none'} nameOf={nameOf} onOpen={onOpen} />)}
      </div>
    </section>
  )
}
