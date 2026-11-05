/**
 * 人和 Agent 的时间占用(2026-10-27,合并稿 ④)。数据见 `occupancyModel.ts`:计划虚线、实际实心,空白 = 没有记录。
 * 方向按协作区容器的宽高:宽 → 每人一行、时间从左到右;高 → 每人一列、时间从上到下(同详情顶部轨迹那条规矩)。
 * 同时段的块按模型给的列序并列(横排分小行、竖排分小列),一簇装不下的收成「+N 件」,点开列标题。
 * 实际读 `/collab/runs?goal_id=`(与原「实际执行」同一个口),读不到就说读不到,只画计划。
 */
import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import type { MeetingView, RunSegment, TaskView } from '../../protocol.ts'
import { goalIdOf } from '../../protocol.ts'
import type { CollabApi } from './collabApi.ts'
import { useAssigneeName } from '../meName.tsx'
import { PersonLabel } from './people.tsx'
import { traceDirection } from './boardProgress.ts'
import { tasksReadKey, useCoalescedRead } from './useCoalescedRead.ts'
import { OCC_COLUMN_LANE_PX, OCC_LINE_PX, OCC_SUBCOL_PX, OCC_SUBROW_PX, occupancyRows, pctOf, type OccBlock, type OccMore, type OccRow } from './occupancyModel.ts'

export { OCC_COLUMN_LANE_PX, OCC_LINE_PX } from './occupancyModel.ts'

const HOUR = 3_600_000
const clock = (at: number): string => new Date(at).toTimeString().slice(0, 5)

export interface OccupancyViewProps {
  api: CollabApi
  tasks: readonly TaskView[]
  meetings: readonly MeetingView[]
  dayKey: string
  nowMs: number
  /** 量不到时用(用例里给)。 */
  width?: number
  height?: number
  onOpenNote: (id: string) => void
  onOpenMeeting: (id: string) => void
}

export function OccupancyView({ api, tasks, meetings, dayKey, nowMs, width, height, onOpenNote, onOpenMeeting }: OccupancyViewProps) {
  const ref = useRef<HTMLElement>(null)
  const [size, setSize] = useState<{ w: number, h: number } | undefined>(undefined)
  useLayoutEffect(() => {
    // 方向认整个协作区容器的形状(原型:组件 714×756、竖屏 768×1024 都是竖排),不认自己这一块。
    const el = ref.current?.closest<HTMLElement>('.ben-cl') ?? ref.current
    if (el === null || el === undefined || typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect
      if (box !== undefined && box.width > 0 && box.height > 0) setSize(prev => (prev?.w === box.width && prev.h === box.height ? prev : { w: box.width, h: box.height }))
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  const dir = traceDirection(size?.w ?? width ?? 1200, size?.h ?? height ?? 600)
  const nameOf = useAssigneeName()

  const goalKey = [...new Set(tasks.map(goalIdOf))].sort().join('|')
  // 跟着快照重读,但不丢在途那次(执行片段 1.6 秒才回,原来每秒一份新 tasks 就作废上一次,实际那条永远画不出)。
  const runsApi = useMemo<CollabApi>(() => ({
    ...api,
    get: async <T,>(path: string) => {
      const goals = path === '' ? [] : path.split('|')
      const results = await Promise.all(goals.map(id => api.get<{ runs?: RunSegment[] }>(`/collab/runs?goal_id=${encodeURIComponent(id)}`)))
      return (results.some(one => !Array.isArray(one?.runs)) ? undefined : results.flatMap(one => one?.runs ?? [])) as T
    },
  }), [api])
  const read = useCoalescedRead<readonly RunSegment[]>(runsApi, goalKey, tasksReadKey(tasks, nowMs), raw => (Array.isArray(raw) ? raw as RunSegment[] : undefined))
  const runs: readonly RunSegment[] | 'missing' | undefined = read.data ?? (read.missing ? 'missing' : undefined)

  const { rows, from, to } = useMemo(
    () => occupancyRows({ tasks, meetings, runs: Array.isArray(runs) ? runs : [], dayKey, nowMs }),
    [tasks, meetings, runs, dayKey, nowMs],
  )
  const hours: number[] = []
  for (let at = from; at <= to; at += HOUR) hours.push(at)
  const lastReceipt = Array.isArray(runs) ? Math.max(...runs.map(one => Date.parse(one.execution_finished_observed_at ?? '')).filter(Number.isFinite)) : -Infinity
  const nowIn = nowMs >= from && nowMs <= to

  const [expanded, setExpanded] = useState<string | undefined>(undefined)
  // 时间方向:横排 left / width,竖排 top / height;并列方向反过来,按第几列 / 共几列等分。
  const place = (start: number, end: number, lane: number, lanes: number): CSSProperties => {
    const a = pctOf(start, from, to), b = pctOf(end, from, to)
    const across = `calc(${(lane / lanes) * 100}% + 1px)`, size = `calc(${100 / lanes}% - 2px)`
    return dir === 'row'
      ? { left: `${a}%`, width: `max(${b - a}%, 6px)`, top: across, height: size, bottom: 'auto' }
      : { top: `${a}%`, height: `max(${b - a}%, 6px)`, left: across, width: size, right: 'auto' }
  }
  // 竖排时块的高按轴长折成像素;矮于一行字就不写字。横排每小行都够一行字。
  const tooShort = (start: number, end: number): boolean =>
    dir === 'column' && ((pctOf(end, from, to) - pctOf(start, from, to)) / 100) * OCC_COLUMN_LANE_PX < OCC_LINE_PX
  const at = (t: number): CSSProperties => (dir === 'row' ? { left: `${pctOf(t, from, to)}%` } : { top: `${pctOf(t, from, to)}%` })
  const openOne = (one: { meetingId?: string, taskId?: string }): void => {
    if (one.meetingId !== undefined) onOpenMeeting(one.meetingId)
    else if (one.taskId !== undefined) onOpenNote(one.taskId)
  }
  const kindName = (kind: 'plan' | 'actual'): string => (kind === 'plan' ? '计划' : '实际')
  const bar = (one: OccBlock, kind: 'plan' | 'actual') => {
    const short = tooShort(one.start, one.end)
    return (
      <button
        key={one.key}
        type="button"
        className="ben-cl__occ-bar"
        data-kind={kind}
        data-open={one.open === true}
        data-short={short}
        aria-label={`${kindName(kind)} · ${one.title}`}
        title={`${one.title} · ${clock(one.start)}–${one.open === true ? '现在' : clock(one.end)}`}
        style={place(one.start, one.end, one.lane, one.lanes)}
        onClick={() => openOne(one)}
      >
        {!short && <span>{one.title}</span>}
      </button>
    )
  }
  const more = (one: OccMore, kind: 'plan' | 'actual') => {
    const open = expanded === `${kind}:${one.key}`
    return [
      <button
        key={one.key}
        type="button"
        className="ben-cl__occ-bar"
        data-kind="more"
        aria-expanded={open}
        aria-label={`${kindName(kind)} · 同时段另有 ${one.count} 件`}
        title={one.items.map(item => item.title).join('、')}
        style={place(one.start, one.end, one.lane, one.lanes)}
        onClick={() => setExpanded(open ? undefined : `${kind}:${one.key}`)}
      >
        {!tooShort(one.start, one.end) && <span>+{one.count} 件</span>}
      </button>,
      open && (
        <ul key={`${one.key}:list`} className="ben-cl__tmore-list ben-cl__occ-more-list" aria-label="同时段另有的事项" style={at(one.start)}>
          {one.items.map(item => (
            <li key={item.key}><button type="button" onClick={() => openOne(item)}>{item.title}</button></li>
          ))}
        </ul>
      ),
    ]
  }
  const lanesOf = (row: OccRow, kind: 'plan' | 'actual'): number =>
    Math.max(1, ...(kind === 'plan' ? [...row.plan, ...row.planMore] : [...row.actual, ...row.actualMore]).map(one => one.lanes))
  // 横排:一条轨道按它最多几小行撑高。竖排:一人那一列按两条轨道各几小列撑宽。
  const trackStyle = (row: OccRow, kind: 'plan' | 'actual'): CSSProperties | undefined =>
    (dir === 'row' ? { height: lanesOf(row, kind) * OCC_SUBROW_PX } : undefined)
  const rowStyle = (row: OccRow): CSSProperties | undefined => {
    if (dir !== 'column' || (lanesOf(row, 'plan') === 1 && lanesOf(row, 'actual') === 1)) return undefined
    const plan = lanesOf(row, 'plan') * OCC_SUBCOL_PX, actual = lanesOf(row, 'actual') * OCC_SUBCOL_PX
    return { gridTemplateColumns: `minmax(${plan}px, 1fr) minmax(${actual}px, 1fr)`, minWidth: plan + actual + 16 }
  }

  return (
    <section className="ben-cl__occ" ref={ref} role="region" aria-label="人和 Agent 的时间占用" data-dir={dir}>
      <header className="ben-cl__occ-top">
        <h3>人和 Agent 的时间占用</h3>
        <p className="ben-cl__muted">{dayKey.slice(5).replace('-', ' 月 ')} 日 · {clock(from)}—{clock(to)} 虚线为计划占位,实色为实际执行;空白表示没有记录。</p>
        <p className="ben-cl__occ-legend">
          <span data-kind="plan"><i aria-hidden="true" />计划占位</span>
          <span data-kind="actual"><i aria-hidden="true" />实际占用</span>
          {Number.isFinite(lastReceipt) && <span>最近回执 {clock(lastReceipt)}</span>}
        </p>
        {runs === undefined && <p className="ben-cl__muted" role="status">在读执行账……</p>}
        {runs === 'missing' && <p className="ben-cl__muted" role="status">执行账暂时读不到,只画计划;实际占用未知。</p>}
      </header>
      <div className="ben-cl__occ-body">
        <div className="ben-cl__occ-axis" aria-hidden="true">
          {hours.map(h => <span key={h} style={at(h)}>{clock(h)}</span>)}
        </div>
        {rows.length === 0 && <p className="ben-cl__muted">这一天没有登记的安排,也没有执行记录。</p>}
        {rows.map(row => (
          <div key={row.id} className="ben-cl__occ-row" role="group" aria-label={nameOf(row.id)} style={rowStyle(row)}>
            <div className="ben-cl__occ-who"><PersonLabel id={row.id} mini /></div>
            {(['plan', 'actual'] as const).map(kind => (
              <div key={kind} className="ben-cl__occ-track" data-kind={kind}>
                <small className="ben-cl__occ-track-name">{kind === 'plan' ? '计划' : '实际'}</small>
                <div className="ben-cl__occ-lane" style={trackStyle(row, kind)}>
                  {hours.map(h => <i key={h} className="ben-cl__occ-tick" style={at(h)} aria-hidden="true" />)}
                  {(kind === 'plan' ? row.plan : row.actual).map(one => bar(one, kind))}
                  {(kind === 'plan' ? row.planMore : row.actualMore).flatMap(one => more(one, kind))}
                  {nowIn && <span className="ben-cl__occ-now" style={at(nowMs)} aria-hidden="true" />}
                </div>
              </div>
            ))}
          </div>
        ))}
        {nowIn && <span className="ben-wb__sr" aria-label="现在">{clock(nowMs)}</span>}
      </div>
      <p className="ben-cl__muted ben-cl__occ-foot">按参与者显示占用,不把任务持续时间当作 Agent 一直在运行。未知容量和离线期间不推断为空闲。</p>
    </section>
  )
}
