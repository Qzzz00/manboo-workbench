import { groupFacts, isTaskGroup } from './taskGroup.ts'
/**
 * 时间线视图(2026-10-21,视觉 A 第 1、23–26、32 屏)。日期作列、纵向共用一把刻度、「现在」线;
 * 同刻并排,装不下收成「该时段 N 件」点开展开。天数按容器宽度定(`timelineModel.daysFor`)。
 *
 * 这一视图里**不拖**:时间只在详情里的日期 / 开始 / 结束字段改,状态只由章改。
 */
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import type { CollabGoal, MeetingView, SessionView, TaskView, WorkType } from '../../protocol.ts'
import type { StampChoice } from './collabModel.ts'
import type { Relation } from './peopleModel.ts'
import type { CollabApi } from './collabApi.ts'
import { TimelineActual } from './TimelineActual.tsx'
import { RELATION_TITLES } from './peopleModel.ts'
import { MeetingPeople, NoteOwners, PersonLabel } from './people.tsx'
import type { DayBlock, TimelineItem } from './timelineModel.ts'
import {
  HALF_HOUR_PX, dayKeyOf, dayKeys, dayTitle, daysFor, layoutDay, maxLanesFor, pastItems, ticks, timeRange, timelineItems, yOf, yOfMs,
} from './timelineModel.ts'
import { Stamp, TypeIcon } from './parts.tsx'
import { useWorkTypes } from './workTypes.tsx'

/** 刻度栏宽(评审页协作区原型 `.ruler` 48;协作区窄于 650 时 43)。 */
const gutterFor = (width: number): number => (width <= 650 ? 43 : 48)
/** 一张卡最矮多高(短于半小时的事也要读得清标题)。 */
const MIN_CARD = HALF_HOUR_PX - 4
/** 卡矮于它只留标题、高于 LONG_CARD 才写目标与为什么(评审页协作区原型 `compact` <82、`long` >150)。 */
const COMPACT_CARD = 82
const LONG_CARD = 150

/** 「同刻 N 件」前那枚叠层图标(评审页协作区原型用的 Lucide `layers`)。 */
const LAYERS_PATH = 'M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83zM2 12a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 12M2 17a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 17'

type CardSize = 'compact' | 'normal' | 'long'
function sizeOf(height: number): CardSize {
  return height < COMPACT_CARD ? 'compact' : height > LONG_CARD ? 'long' : 'normal'
}
function clock(ms: number): string { return new Date(ms).toTimeString().slice(0, 5) }
function dayText(key: string): string { const [, m, d] = key.split('-').map(Number); return `${m} 月 ${d} 日` }
function weekText(key: string): string {
  const [y, m, d] = key.split('-').map(Number) as [number, number, number]
  return `周${'日一二三四五六'[new Date(y, m - 1, d).getDay()]}`
}
/** 卡头那段时段:「· 09:00–11:30」,只有开始就只写开始。 */
function spanText(item: TimelineItem): string {
  return `· ${clock(item.start)}${item.end === undefined ? '' : `–${clock(item.end)}`}`
}

export interface TimelineViewProps {
  api?: CollabApi
  tasks: readonly TaskView[]
  meetings: readonly MeetingView[]
  /** 目标(高的卡认「所属项目」时,便签自己没写项目就取它的)。 */
  goals?: readonly CollabGoal[]
  /** 项目 id → 名字(高的卡第二行「所属项目 · 验收 N 条」)。不给就照写 id。 */
  projectName?: (id: string) => string
  /** 会话(已发生的经过;缺席 = 不画)。 */
  sessions?: readonly SessionView[]
  /** 从哪一天起显示。 */
  anchorKey: string
  nowMs: number
  /** 容器宽度(量不到时用它;用例里给)。 */
  width?: number
  shown: (task: TaskView) => boolean
  typeOf: (task: TaskView) => WorkType | undefined
  ownerText: (task: TaskView) => string
  /** 选中了某个头像时,这件和他什么关系(没选中 = undefined 且不变淡)。 */
  relation?: ((item: TimelineItem) => Relation | undefined) | undefined
  onDays?: (days: number) => void
  onOpenNote: (id: string) => void
  onOpenMeeting: (id: string) => void
  onStamp: (task: TaskView, choice: StampChoice) => void
}

export function TimelineView(props: TimelineViewProps) {
  const { tasks, meetings, anchorKey, nowMs, shown, typeOf, ownerText, relation, onDays, onOpenNote, onOpenMeeting, onStamp } = props
  const ref = useRef<HTMLDivElement>(null)
  const [measured, setMeasured] = useState<number | undefined>(undefined)
  useLayoutEffect(() => {
    const el = ref.current
    if (el === null || typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width
      if (w !== undefined && w > 0) setMeasured(w)
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  const width = measured ?? props.width ?? 1228
  const GUTTER = gutterFor(width)
  const days = daysFor(width)
  useEffect(() => { onDays?.(days) }, [days, onDays])
  const keys = dayKeys(anchorKey, days)
  const columnWidth = (width - GUTTER) / days
  const lanesMax = maxLanesFor(columnWidth)

  const items = [...timelineItems(tasks, meetings), ...pastItems(tasks, props.sessions ?? [], nowMs)]
  const visible = items.filter(item => keys.includes(dayKeyOf(item.start)))
  const range = timeRange(visible)
  const height = yOf(range.toMinutes, range)
  const todayKey = dayKeyOf(nowMs)
  const taskOf = new Map(tasks.map(one => [one.id, one]))
  const meetingOf = new Map(meetings.map(one => [one.id, one]))
  const goalOf = new Map((props.goals ?? []).map(one => [one.id, one]))
  const projectOf = (id: string | undefined): string => (id === undefined || id === '' ? '未归目标' : props.projectName?.(id) ?? id)
  const [expanded, setExpanded] = useState<string | undefined>(undefined)

  const dimOf = (item: TimelineItem): boolean => {
    if (relation !== undefined && relation(item) === undefined) return true
    if (item.kind === 'note' || item.kind === 'event') { const task = taskOf.get(item.id); return task !== undefined && !shown(task) }
    return false
  }

  const types = useWorkTypes()
  const head = (type: WorkType, item: TimelineItem) => (
    <div className="ben-cl__tcard-head"><TypeIcon type={type} size={12} /><span>{types.find(one => one.id === type)?.title ?? ''}</span><span>{spanText(item)}</span></div>
  )

  const card = (item: TimelineItem, style: CSSProperties, size: CardSize) => {
    const rel = relation?.(item)
    if (item.kind === 'meeting') {
      const meeting = meetingOf.get(item.id)
      return (
        <div key={item.key} className="ben-cl__tcard" data-type="meeting" data-size={size} data-point={item.point} data-dim={dimOf(item)} data-related={rel !== undefined} style={style} aria-label={`会议 ${item.title}`}>
          {head('meeting', item)}
          <button type="button" className="ben-cl__tcard-title" onClick={() => onOpenMeeting(item.id)}>{item.title}</button>
          <div className="ben-cl__tcard-foot">
            <span className="ben-cl__tcard-owner">{meeting === undefined ? '' : <MeetingPeople meeting={meeting} mini />}</span>
            {rel !== undefined && <span className="ben-cl__rel">{RELATION_TITLES[rel]}</span>}
            <button type="button" className="ben-cl__act" onClick={() => onOpenMeeting(item.id)}>{meeting?.status === 'done' ? '查看纪要' : '打开会议'}</button>
          </div>
        </div>
      )
    }
    if (item.kind === 'session') {
      const agent = item.id.split(':')[0] ?? ''
      return (
        <div key={item.key} className="ben-cl__tcard" data-type="past" data-size={size} data-point={item.point} data-dim={dimOf(item)} data-related={rel !== undefined} style={style} aria-label={`会话 ${item.title}`}>
          <span className="ben-cl__tcard-title"><span className="ben-cl__past-tag">会话</span>{item.title}</span>
          <div className="ben-cl__tcard-foot"><span className="ben-cl__tcard-owner"><PersonLabel id={agent} mini /></span>{rel !== undefined && <span className="ben-cl__rel">{RELATION_TITLES[rel]}</span>}</div>
        </div>
      )
    }
    if (item.kind === 'event') {
      const done = taskOf.get(item.id)
      return (
        <div key={item.key} className="ben-cl__tcard" data-type="past" data-size={size} data-point data-dim={dimOf(item)} data-related={rel !== undefined} style={style} aria-label={`经过 ${item.title}`}>
          <button type="button" className="ben-cl__tcard-title" onClick={() => onOpenNote(item.id)}><span className="ben-cl__past-tag">经过</span>{item.title}</button>
          {done?.receipt?.by !== undefined && <div className="ben-cl__tcard-foot"><span className="ben-cl__tcard-owner"><PersonLabel id={done.receipt.by} mini /></span></div>}
        </div>
      )
    }
    const task = taskOf.get(item.id)
    if (task === undefined) return null
    const type = typeOf(task)
    const goal = task.goal_id === undefined ? undefined : goalOf.get(task.goal_id)
    return (
      <div key={item.key} className="ben-cl__tcard" data-type={type ?? 'none'} data-size={size} data-point={item.point} data-dim={dimOf(item)} data-related={rel !== undefined} style={style} aria-label={`便签 ${task.title}`}>
        {type === undefined
          ? <div className="ben-cl__tcard-head"><span>{spanText(item)}</span></div>
          : head(type, item)}
        <button type="button" className="ben-cl__tcard-title" onClick={() => onOpenNote(task.id)}>{task.title}</button>
        {/* 「所属项目 · 验收 N 条」(原型 `.event-project`,10-22 统筹定照稿):便签自己的项目,没有就取目标的项目,都没有写「未归目标」。 */}
        {size === 'long' && <div className="ben-cl__tcard-goal">{projectOf(task.project_id ?? goal?.project_id)} · 验收 {task.acceptance?.length ?? 0} 条</div>}
        {size === 'long' && task.desc !== undefined && task.desc !== '' && <p className="ben-cl__tcard-why">{task.desc}</p>}
        <div className="ben-cl__tcard-foot">
          <span className="ben-cl__tcard-owner"><NoteOwners task={task} ownerText={ownerText(task)} /></span>
          {rel !== undefined && <span className="ben-cl__rel">{RELATION_TITLES[rel]}</span>}
          <Stamp status={isTaskGroup(task) ? groupFacts(task, tasks).status : task.status} {...(isTaskGroup(task) ? {} : { onPick: (choice: StampChoice) => onStamp(task, choice) })} />
        </div>
      </div>
    )
  }

  const block = (b: DayBlock) => {
    if (b.kind === 'more') {
      const top = yOfMs(b.start, range)
      const open = expanded === b.key
      return (
        <div key={b.key} className="ben-cl__tmore" style={{ top, minHeight: MIN_CARD }}>
          <button type="button" aria-expanded={open} onClick={() => setExpanded(open ? undefined : b.key)}>
            <svg className="ben-cl__ticon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d={LAYERS_PATH} />
            </svg>
            <span><strong>该时段 {b.items.length} 件</strong><small>{clock(b.start)}–{clock(b.end)} · 最多 {b.count} 件并行</small></span>
            <svg className="ben-cl__ticon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="m9 18 6-6-6-6" />
            </svg>
          </button>
          {open && (
            <ul className="ben-cl__tmore-list">
              {b.items.map(item => (
                <li key={item.key}>
                  <button type="button" onClick={() => (item.kind === 'note' ? onOpenNote(item.id) : onOpenMeeting(item.id))}>{item.title}</button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )
    }
    const top = yOfMs(b.item.start, range)
    const bottom = b.item.end === undefined ? top + MIN_CARD : yOfMs(b.item.end, range)
    const h = Math.max(MIN_CARD, bottom - top - 4)
    return card(b.item, { top, height: h, left: `calc(${(b.lane / b.lanes) * 100}% + 2px)`, width: `calc(${100 / b.lanes}% - 6px)` }, sizeOf(h))
  }

  const nowY = keys.includes(todayKey) ? yOfMs(nowMs, range) : undefined
  return (
    <div className="ben-cl__timeline-panes">
    <div className="ben-cl__tl" ref={ref} data-days={days} role="region" aria-label="时间线">
      {props.api !== undefined && <h3 className="ben-cl__timeline-plan-title">计划与会话记录</h3>}
      <div className="ben-cl__tl-head" style={{ paddingLeft: GUTTER }}>
        {/* 日期头照原型 `.date-head`:今天前一颗圆点、日期加粗、后面星期;「今天 / 明天」留在读屏名里。 */}
        {keys.map(key => (
          <div key={key} className="ben-cl__tl-day" aria-label={dayTitle(key, todayKey)}>
            {key === todayKey && <i className="ben-cl__today-dot" aria-hidden="true" />}
            <b>{dayText(key)}</b>
            <span>{weekText(key)}</span>
          </div>
        ))}
      </div>
      <div className="ben-cl__tl-body">
        <div className="ben-cl__tl-grid" style={{ height }}>
          <div className="ben-cl__tl-gutter" style={{ width: GUTTER }}>
            {ticks(range).map(t => <span key={t.minutes} style={{ top: yOf(t.minutes, range) }}>{t.label}</span>)}
            {nowY !== undefined && nowY >= 0 && nowY <= height && <span className="ben-cl__now-tag" style={{ top: nowY }}>{clock(nowMs)}</span>}
          </div>
          {keys.map(key => (
            <div key={key} className="ben-cl__tl-col" data-day={key}>
              {ticks(range).map(t => <span key={t.minutes} className="ben-cl__tl-line" style={{ top: yOf(t.minutes, range) }} />)}
              {layoutDay(visible.filter(item => dayKeyOf(item.start) === key), lanesMax).map(block)}
              {key === todayKey && nowY !== undefined && nowY >= 0 && nowY <= height && <span className="ben-cl__now" style={{ top: nowY }} aria-label="现在" />}
            </div>
          ))}
        </div>
      </div>
    </div>
    {props.api !== undefined && <TimelineActual api={props.api} tasks={tasks.filter(task => task.casual !== true && shown(task))} onOpen={onOpenNote} />}
    </div>
  )
}
