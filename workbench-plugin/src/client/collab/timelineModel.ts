/**
 * 时间线视图的纯函数(2026-10-21,视觉 A「一套内容,两种容器」)。
 *
 * - **日期作列,纵向共用时间刻度**(30 分钟 58 像素,不为塞满而拉伸);同一天同一时刻的并排,会议多人参加仍是一张卡;
 * - 容器宽度定天数(日期最小宽约 312:400 → 1 天,714 / 840 → 2 天,窗口槽扣名片栏 → 3 天);
 * - 有起止才按时长排;只有开始 = 时间点卡(按 30 分钟占位算重叠,不暗示工期);没排时间的进底部入口;
 * - 一列装不下的同刻事项收成「同刻 N 件」(N = 最多几件并行),点开展开,不挤成字条、不谎报。
 * 拖动在这一视图里**不改时间也不改状态**;时间只走便签的 `start` / `end` 字段。
 */
import type { MeetingView, SessionView, TaskView } from '../../protocol.ts'
import { packLanes } from './lanePack.ts'

export const HALF_HOUR_PX = 58
export const POINT_MINUTES = 30
/** 一个日期列的最小宽度(再窄就少显示一天)。 */
export const DAY_MIN_WIDTH = 312
/** 同刻并排时一张卡的最小宽度。 */
export const LANE_MIN_WIDTH = 150
export const MAX_DAYS = 3

/** 名片栏多宽(样式里同一个数)。 */
export const RAIL_WIDTH = 252

/**
 * 同一个协作区放在项目区那格、窗口槽、展开态,只按容器宽度调密度:扣掉名片栏还放得下三天才露名片栏,
 * 窄了收成一个入口(点开浮出来)。
 */
export function railShownFor(zoneWidth: number): boolean {
  return zoneWidth - RAIL_WIDTH >= MAX_DAYS * DAY_MIN_WIDTH
}

export function daysFor(width: number): number {
  return Math.max(1, Math.min(MAX_DAYS, Math.floor(width / DAY_MIN_WIDTH)))
}

export function maxLanesFor(columnWidth: number): number {
  return Math.max(1, Math.floor(columnWidth / LANE_MIN_WIDTH))
}

const pad = (n: number): string => String(n).padStart(2, '0')

/** 本地日期键 YYYY-MM-DD(按本机时区切天,同 brief / dates 那条纪律)。 */
export function dayKeyOf(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 从某一天起连着 n 天的日期键。 */
export function dayKeys(fromKey: string, n: number): string[] {
  const [y, m, d] = fromKey.split('-').map(Number) as [number, number, number]
  return Array.from({ length: n }, (_, i) => dayKeyOf(new Date(y, m - 1, d + i).getTime()))
}

/** 那一天本地零点。 */
export function dayStart(key: string): number {
  const [y, m, d] = key.split('-').map(Number) as [number, number, number]
  return new Date(y, m - 1, d).getTime()
}

export interface TimelineItem {
  key: string
  /** note / meeting = 安排;session / event = 已发生的经过(会话、任务账里的交回)。 */
  kind: 'note' | 'meeting' | 'session' | 'event'
  id: string
  title: string
  start: number
  end?: number
  /** 只有开始时刻(时间点卡)。 */
  point: boolean
}

function ms(iso: string | undefined): number | undefined {
  if (iso === undefined) return undefined
  const at = Date.parse(iso)
  return Number.isFinite(at) ? at : undefined
}

export function noteItem(task: TaskView): TimelineItem | undefined {
  const start = ms(task.start)
  if (start === undefined) return undefined
  const end = ms(task.end)
  const valid = end !== undefined && end > start ? end : undefined
  return { key: `note:${task.id}`, kind: 'note', id: task.id, title: task.title, start, ...(valid === undefined ? {} : { end: valid }), point: valid === undefined }
}

/** 会议:会前按排期时刻(没排期就不上时间线);开过的按开始 / 结束。 */
export function meetingItem(meeting: MeetingView): TimelineItem | undefined {
  const planned = meeting.status === 'planned'
  const start = planned ? ms(meeting.prep?.scheduled_at) : ms(meeting.started_at)
  if (start === undefined) return undefined
  const end = planned ? undefined : ms(meeting.ended_at)
  const valid = end !== undefined && end > start ? end : undefined
  return { key: `meeting:${meeting.id}`, kind: 'meeting', id: meeting.id, title: meeting.title, start, ...(valid === undefined ? {} : { end: valid }), point: valid === undefined }
}

/** 上时间线的那几件(随手问一句的不上)。 */
export function timelineItems(tasks: readonly TaskView[], meetings: readonly MeetingView[]): TimelineItem[] {
  const notes = tasks.filter(task => task.casual !== true).flatMap(task => noteItem(task) ?? [])
  const meets = meetings.flatMap(one => meetingItem(one) ?? [])
  return [...notes, ...meets].sort((a, b) => a.start - b.start || a.key.localeCompare(b.key))
}

/**
 * 已发生的经过(2026-10-21 协作区评审 ②),只用记下来的真实时刻,不编:
 * - 会话:在跑的从「进入在跑那一刻」(`elapsed_sec` 往回推)画到现在;别的状态只在最后动静(`updated_at`)落一点;
 *   工作台自己起的自检会话不上;
 * - 任务账:交回(做完 / 卡住 / 有异议)那一刻落一点。
 * 比「现在」还晚的时刻不算经过。
 */
export function pastItems(tasks: readonly TaskView[], sessions: readonly SessionView[], nowMs: number): TimelineItem[] {
  const out: TimelineItem[] = []
  for (const one of sessions) {
    if (one.selfcheck !== undefined) continue
    const id = `${one.agent}:${one.session_id}`
    const title = one.title ?? one.summary ?? one.project
    if (one.status === 'running' && Number.isFinite(one.elapsed_sec) && one.elapsed_sec > 0) {
      out.push({ key: `session:${id}`, kind: 'session', id, title, start: nowMs - one.elapsed_sec * 1000, end: nowMs, point: false })
      continue
    }
    const at = ms(one.updated_at)
    if (at !== undefined && at <= nowMs) out.push({ key: `session:${id}`, kind: 'session', id, title, start: at, point: true })
  }
  for (const task of tasks) {
    const at = ms(task.receipt?.at)
    if (at === undefined || at > nowMs) continue
    out.push({ key: `event:${task.id}`, kind: 'event', id: task.id, title: `交回 · ${task.title}`, start: at, point: true })
  }
  return out.sort((a, b) => a.start - b.start || a.key.localeCompare(b.key))
}

/** 没排时间的便签(底部那个入口)。 */
export function unscheduled(tasks: readonly TaskView[]): TaskView[] {
  return tasks.filter(task => task.casual !== true && ms(task.start) === undefined)
}

const shownEnd = (item: Pick<TimelineItem, 'start' | 'end'>): number => item.end ?? item.start + POINT_MINUTES * 60_000

export type DayBlock =
  | { kind: 'item', item: TimelineItem, lane: number, lanes: number }
  | { kind: 'more', key: string, start: number, end: number, count: number, items: TimelineItem[] }

/**
 * 一天里怎么排:先按重叠连成一簇,簇内贪心分道;簇需要的道数超过 `maxLanes` 就整簇收成一块「同刻 N 件」。
 */
export function layoutDay(items: readonly TimelineItem[], maxLanes: number): DayBlock[] {
  return packLanes(items, shownEnd).flatMap((cluster): DayBlock[] => (cluster.lanes > maxLanes
    ? [{ kind: 'more', key: `more:${cluster.placed[0]?.item.key ?? ''}`, start: cluster.start, end: cluster.end, count: cluster.lanes, items: cluster.placed.map(one => one.item) }]
    : cluster.placed.map(one => ({ kind: 'item', item: one.item, lane: one.lane, lanes: cluster.lanes }))))
}

export interface TimeRange { fromMinutes: number, toMinutes: number }

const minutesOfDay = (at: number): number => {
  const d = new Date(at)
  return d.getHours() * 60 + d.getMinutes()
}

/** 共用刻度:默认 9:00–18:00,有更早 / 更晚的就撑开,按半点取整。 */
export function timeRange(items: readonly Pick<TimelineItem, 'start' | 'end'>[]): TimeRange {
  let from = 9 * 60
  let to = 18 * 60
  for (const item of items) {
    from = Math.min(from, minutesOfDay(item.start))
    const end = minutesOfDay(shownEnd(item))
    // 跨过午夜的那截按当天到 24:00 画。
    to = Math.max(to, end < minutesOfDay(item.start) ? 24 * 60 : end)
  }
  return { fromMinutes: Math.floor(from / 30) * 30, toMinutes: Math.min(24 * 60, Math.ceil(to / 30) * 30) }
}

export function yOf(minutes: number, range: TimeRange): number {
  return ((minutes - range.fromMinutes) / 30) * HALF_HOUR_PX
}

export function yOfMs(at: number, range: TimeRange): number {
  return yOf(minutesOfDay(at), range)
}

/** 半点刻度那几行(左边那一栏)。 */
export function ticks(range: TimeRange): { minutes: number, label: string }[] {
  const out: { minutes: number, label: string }[] = []
  for (let m = range.fromMinutes; m <= range.toMinutes; m += 30) out.push({ minutes: m, label: `${pad(Math.floor(m / 60))}:${pad(m % 60)}` })
  return out
}

/** 日期列的标题:今天 / 明天 / 后天 · 10 月 21 日。 */
export function dayTitle(key: string, todayKey: string): string {
  const diff = Math.round((dayStart(key) - dayStart(todayKey)) / 86_400_000)
  const word = diff === 0 ? '今天' : diff === 1 ? '明天' : diff === 2 ? '后天' : diff === -1 ? '昨天' : undefined
  const [, m, d] = key.split('-').map(Number)
  return `${word === undefined ? '' : `${word} · `}${m} 月 ${d} 日`
}
