/**
 * 人和 Agent 的时间占用(2026-10-27,合并稿 ④;原型 repair-time-wide / repair-time-portrait)。
 *
 * 每个参与者两条:
 * - 计划:事项的 `start / end`(按负责人),会议算「你」的;只有开始没有结束的按半小时占位。
 * - 实际:运行片段里**核到的**开工(`execution_started_observed_at`)到交回(`execution_finished_observed_at`);
 *   没交回但已收场的只到收场那一刻;还在跑的只画到现在(open)。只派出、没核到开工的不画 —— 不把任务持续时间当作一直在跑。
 * 来源不明的不编一行。时间窗按整点包住当天所有条与「现在」,什么都没有时 9:00–18:00。
 *
 * 同一人同一子列里相交的块按 `packLanes` 并列分小列(各占 1/列数);一簇要的列超过 `OCC_MAX_LANES` 时
 * 只并列前几列,其余收成一枚「+N 件」占最后一列、横跨整簇的时段 —— 不无限细分到读不出字。
 */
import type { MeetingView, RunSegment, TaskView } from '../../protocol.ts'
import { dayStart, meetingItem, noteItem, POINT_MINUTES } from './timelineModel.ts'
import { packLanes } from './lanePack.ts'

/** 一簇里最多并列几列;再多的收成「+N 件」。 */
export const OCC_MAX_LANES = 3
/** 竖排时一条时间轴的高(像素),样式与「块太矮不写字」共用。 */
export const OCC_COLUMN_LANE_PX = 720
/** 横排时每一小行的高;一行字的高(矮于它的块只画色块)。 */
export const OCC_SUBROW_PX = 26
export const OCC_LINE_PX = 16
/** 竖排时每一小列至少多宽:并列多了就把这一人那一列撑宽(区里横向滚),不把小列挤到放不下一个字。 */
export const OCC_SUBCOL_PX = 40
/** 块窄于这个宽度只画色块(样式里按块的实际宽度判)。 */
export const OCC_TEXT_MIN_PX = 26

export interface OccBar {
  key: string
  title: string
  start: number
  end: number
  taskId?: string
  meetingId?: string
  /** 实际那条还没收场(画到现在)。 */
  open?: boolean
  status?: RunSegment['status']
}
/** 排好位置的块:第几列、这一簇共几列。 */
export interface OccBlock extends OccBar { lane: number, lanes: number }
/** 收起来的「+N 件」。 */
export interface OccMore { key: string, start: number, end: number, count: number, items: OccBar[], lane: number, lanes: number }
export interface OccRow { id: string, plan: OccBlock[], actual: OccBlock[], planMore: OccMore[], actualMore: OccMore[] }
interface RawRow { id: string, plan: OccBar[], actual: OccBar[] }
export interface Occupancy { rows: OccRow[], from: number, to: number }

const HOUR = 3_600_000
const parse = (iso: string | undefined): number | undefined => {
  if (iso === undefined) return undefined
  const at = Date.parse(iso)
  return Number.isFinite(at) ? at : undefined
}

export function occupancyRows({ tasks, meetings, runs, dayKey, nowMs }: {
  tasks: readonly TaskView[], meetings: readonly MeetingView[], runs: readonly RunSegment[], dayKey: string, nowMs: number,
}): Occupancy {
  const dayFrom = dayStart(dayKey), dayTo = dayFrom + 24 * HOUR
  const onDay = (bar: { start: number, end: number }): boolean => bar.start < dayTo && bar.end > dayFrom
  const rows = new Map<string, RawRow>()
  const rowOf = (id: string): RawRow => {
    let row = rows.get(id)
    if (row === undefined) { row = { id, plan: [], actual: [] }; rows.set(id, row) }
    return row
  }
  const titleOf = new Map(tasks.map(one => [one.id, one.title]))

  for (const task of tasks) {
    if (task.assignee === undefined || task.casual === true) continue
    const item = noteItem(task)
    if (item === undefined) continue
    const bar = { key: `plan:${task.id}`, title: task.title, taskId: task.id, start: item.start, end: item.end ?? item.start + POINT_MINUTES * 60_000 }
    if (onDay(bar)) rowOf(task.assignee).plan.push(bar)
  }
  for (const meeting of meetings) {
    const item = meetingItem(meeting)
    if (item === undefined) continue
    const bar = { key: `meeting:${meeting.id}`, title: meeting.title, meetingId: meeting.id, start: item.start, end: item.end ?? item.start + POINT_MINUTES * 60_000 }
    if (onDay(bar)) rowOf('me').plan.push(bar)
  }
  runs.forEach((run, index) => {
    const who = run.agent ?? (run.source === 'unknown' ? undefined : run.source)
    const start = parse(run.execution_started_observed_at)
    if (who === undefined || start === undefined) return
    const replied = parse(run.execution_finished_observed_at)
    const closed = replied ?? parse(run.finished_at)
    const open = closed === undefined && run.status === 'running'
    const end = closed ?? (open ? Math.max(start, nowMs) : start)
    const bar: OccBar = { key: `actual:${run.task_id}:${run.session_id ?? index}`, title: titleOf.get(run.task_id) ?? run.task_id, taskId: run.task_id, start, end, open, status: run.status }
    if (onDay(bar)) rowOf(who).actual.push(bar)
  })

  const all = [...rows.values()].flatMap(row => [...row.plan, ...row.actual])
  const nowOnDay = nowMs >= dayFrom && nowMs < dayTo
  let from: number, to: number
  if (all.length === 0) {
    from = dayFrom + 9 * HOUR; to = dayFrom + 18 * HOUR
    if (nowOnDay) { from = Math.min(from, Math.floor(nowMs / HOUR) * HOUR); to = Math.max(to, Math.ceil(nowMs / HOUR) * HOUR) }
  } else {
    const lo = Math.min(...all.map(bar => bar.start), ...(nowOnDay ? [nowMs] : []))
    const hi = Math.max(...all.map(bar => bar.end), ...(nowOnDay ? [nowMs] : []))
    from = Math.max(dayFrom, dayFrom + Math.floor((lo - dayFrom) / HOUR) * HOUR)
    to = Math.min(dayTo, dayFrom + Math.ceil((hi - dayFrom) / HOUR) * HOUR)
    if (to <= from) to = from + HOUR
  }
  const ordered = [...rows.values()].sort((a, b) => rank(a.id) - rank(b.id)).map((row): OccRow => {
    const plan = arrange(row.plan), actual = arrange(row.actual)
    return { id: row.id, plan: plan.blocks, actual: actual.blocks, planMore: plan.more, actualMore: actual.more }
  })
  return { rows: ordered, from, to }
}

function arrange(bars: readonly OccBar[]): { blocks: OccBlock[], more: OccMore[] } {
  const blocks: OccBlock[] = [], more: OccMore[] = []
  for (const cluster of packLanes(bars)) {
    const folding = cluster.lanes > OCC_MAX_LANES
    const lanes = folding ? OCC_MAX_LANES + 1 : cluster.lanes
    const folded: OccBar[] = []
    for (const { item, lane } of cluster.placed) {
      if (folding && lane >= OCC_MAX_LANES) folded.push(item)
      else blocks.push({ ...item, lane, lanes })
    }
    if (folded.length > 0) more.push({ key: `more:${folded[0]!.key}`, start: cluster.start, end: cluster.end, count: folded.length, items: folded, lane: OCC_MAX_LANES, lanes })
  }
  return { blocks, more }
}

/** 「你」第一,事务官第二,其余按出现先后(sort 稳定)。 */
function rank(id: string): number { return id === 'me' ? 0 : id === 'dsh' ? 1 : 2 }

/** 一个时刻在时间窗里的百分比位置(夹在 0–100)。 */
export function pctOf(at: number, from: number, to: number): number {
  return Math.min(100, Math.max(0, ((at - from) / (to - from)) * 100))
}
