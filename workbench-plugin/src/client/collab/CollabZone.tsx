import { useContextFolds } from './useContextFolds.ts'
import { FixedGoalSummary } from './FixedGoalSummary.tsx'
import { isTaskGroup } from './taskGroup.ts'
/**
 * **协作区**(2026-10-21;对象与规则 `docs/设计-协作区-无限画布-2026-10-21.md`,样子 `docs/设计-协作区视觉-A-2026-10-21.md`)。
 *
 * 窗口槽里的一个标签。顶上「时间线 / 目标」切换、成员、日期导航与筛选,下面一条「等你」;
 * 时间线 = 日期作列共用刻度(会议一张卡),目标 = 按目标分区的画布(拖只挪位置);右边名片栏,点头像看他负责 / 协作 / 参加的;
 * 底部未排时间、类型图例与「跟事务官说一件事」。点卡开详情(便签七块 / 会议卡)。设置(小队、定时派活、MCP、GitHub、工作室……)按需进入。
 *
 * 这一层只拼东西、发请求;判断都在 `collabModel` / `timelineModel` / `peopleModel`,改动以服务端推回来的下一份快照为准。
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CollabPresence, RunSegment, MeetingView, SessionPlaced, TaskStatus, TaskView, WorkbenchState } from '../../protocol.ts'
import { UNSORTED_GOAL_ID, goalIdOf, assigneeName, workTypeOf } from '../../protocol.ts'
import { useMeName } from '../meName.tsx'
import { WorkTypesContext, workTypeStyle, workTypesOf } from './workTypes.tsx'
import { collabApi, moveAlong } from './collabApi.ts'
import type { BoardLayout, CollabFilter, StampChoice, WaitingItem } from './collabModel.ts'
import {
  NOTE_H, NOTE_W, autoLayout, boardGoals, boardNotes, filterOptions, matchesFilter, railCards, toggleProgress, waitingStrip,
} from './collabModel.ts'
import type { BoardProgress } from './boardProgress.ts'
import { CollabBoard, goalIdForUpdate } from './CollabBoard.tsx'
import { ReadingBoard } from './ReadingBoard.tsx'
import { CardRail, FilterBar, WaitingStrip } from './panels.tsx'
import type { GoalChoice } from './panels.tsx'
import { ProgressSummary } from './ProgressSummary.tsx'
import { NoteDialog } from './NoteDialog.tsx'
import { MeetingDialog } from './MeetingDialog.tsx'
import { ChatBubble } from './ChatBubble.tsx'
import { OccupancyView } from './OccupancyView.tsx'
import { FlyLayer } from './FlyLayer.tsx'
import { TimelineView } from './TimelineView.tsx'
import { CollabSettings, relayTick, type SettingsTab } from './CollabSettings.tsx'
import { ChannelView } from './ChannelView.tsx'
import { NoteQuickView } from './NoteQuickView.tsx'
import { GoalPanel } from './GoalPanel.tsx'
import { GoalBar } from './GoalBar.tsx'
import { TraceRail } from './TraceRail.tsx'
import type { CapacityItem } from '../../protocol.ts'
import { RelayAsks } from './RelaySections.tsx'
import { AvatarEditor } from './AvatarEditor.tsx'
import type { PeopleCtx } from './people.tsx'
import { PeopleProvider, PersonLabel, kindOfCard } from './people.tsx'
import type { TimelineItem } from './timelineModel.ts'
import { RAIL_WIDTH, dayKeyOf, dayKeys, railShownFor, unscheduled } from './timelineModel.ts'
import { meetingRelation, noteRelation, ownerLine } from './peopleModel.ts'
import { useHostTheme } from './useHostTheme.ts'
import { Empty } from '../ui/index.tsx'
import { Icon } from '../ui/icons.tsx'
import { LampHover, LampIcon } from '../AgentLamp.tsx'
import type { TopBarLamp } from '../TopBar.tsx'

const EMPTY_LAYOUT: BoardLayout = { goals: {}, notes: {} }
const EMPTY_PROGRESS: readonly BoardProgress[] = []

/** 读回来的摆法过一道形状检查:不像就当没存过(界面自动重排),不让一份坏文件把板弄塌。 */
function boardLayoutOf(value: unknown): BoardLayout {
  if (typeof value !== 'object' || value === null) return EMPTY_LAYOUT
  const raw = value as Record<string, unknown>
  const isMap = (one: unknown): one is Record<string, never> => typeof one === 'object' && one !== null && !Array.isArray(one)
  return isMap(raw.goals) && isMap(raw.notes) ? { goals: raw.goals, notes: raw.notes } : EMPTY_LAYOUT
}
/** 日期一段(评审页协作区原型 `.date-nav`):「10 月 21 日 — 23 日」,跨月写全「10 月 31 日 — 11 月 2 日」。 */
function rangeText(keys: readonly string[]): string {
  const part = (key: string | undefined): [number, number] => [Number(key?.slice(5, 7)), Number(key?.slice(8, 10))]
  const [m1, d1] = part(keys[0])
  if (keys.length <= 1) return `${m1} 月 ${d1} 日`
  const [m2, d2] = part(keys.at(-1))
  return `${m1} 月 ${d1} 日 — ${m2 === m1 ? '' : `${m2} 月 `}${d2} 日`
}

/** 摆法停手多久之后落盘(拖一下就存一次太碎)。 */
const SAVE_LAYOUT_MS = 600

export type CollabView = 'timeline' | 'goals' | 'channel'
export const TIMELINE_MODE_KEY = 'workbench.collab.timeline-mode.v1'

export interface CollabZoneProps {
  state: WorkbenchState
  baseUrl: string
  fetchImpl: typeof fetch
  /** 板上的小鼠标(`/live` 的 `kind:'presence'`,不进快照)。 */
  presence: readonly CollabPresence[]
  /** 这一档此刻露着没有(切走保活:不卸载,只藏起来)。 */
  visible: boolean
  /** 一开始是哪个视图(缺席 = 时间线)。 */
  initialView?: CollabView
  /** 「现在」(用例里给;缺席 = 服务端快照时刻)。 */
  nowMs?: number
  /** 时间线容器宽度(量不到时用;用例里给)。 */
  timelineWidth?: number
  /** 整个协作区的宽度(量不到时用;用例里给)。 */
  width?: number
  /** 放在项目区那格时给:点「全屏」整个工作台只剩协作区(10-22 第三轮;协作区只有这一处入口)。 */
  onExpand?: () => void
  /** 全屏那一份:给了就在工具栏右端画「退出全屏」(10-22 第三轮)。 */
  onExitFull?: () => void
  /** 本机接入的那几家的灯(与顶栏同一份;给了就在「成员」那排照顶栏的样子画,顶栏那一排就不画)。 */
  lamps?: readonly TopBarLamp[]
  /** 从悬浮球「在协作区查看」带进来的那一件(2026-10-27):`at` 变了就定位并打开它的详情。 */
  locate?: { id: string, at: number }
}

const shiftDay = (key: string, days: number): string => dayKeys(key, days + 1)[days] as string
const backDay = (key: string, days: number): string => {
  const [y, m, d] = key.split('-').map(Number) as [number, number, number]
  return dayKeyOf(new Date(y, m - 1, d - days).getTime())
}

export function CollabZone({ state, baseUrl, fetchImpl, presence, visible, initialView, nowMs, timelineWidth, width, onExpand, onExitFull, lamps, locate }: CollabZoneProps) {
  const api = useMemo(() => collabApi(baseUrl, fetchImpl), [baseUrl, fetchImpl])
  const rootRef = useRef<HTMLElement>(null)
  const theme = useHostTheme(rootRef)
  const { folds, toggleFold, toggleAll } = useContextFolds(rootRef)
  // —— 一套组件、三种摆法:量自己有多宽,窄了收名片栏为入口(天数由时间线自己按宽度算) ——
  const [measured, setMeasured] = useState<number | undefined>(undefined)
  useLayoutEffect(() => {
    const el = rootRef.current
    if (el === null || typeof ResizeObserver === 'undefined') return undefined
    let frame: number | undefined
    const observer = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width
      if (w === undefined || w <= 0) return
      if (frame !== undefined) cancelAnimationFrame(frame)
      // 更新宽度会改变名片栏和画布尺寸，离开观察回调再提交，避免同帧反馈。
      frame = requestAnimationFrame(() => { setMeasured(w); frame = undefined })
    })
    observer.observe(el)
    return () => { observer.disconnect(); if (frame !== undefined) cancelAnimationFrame(frame) }
  }, [])
  const zoneWidth = measured ?? width ?? (timelineWidth === undefined ? undefined : timelineWidth + RAIL_WIDTH)
  const railShown = zoneWidth === undefined || railShownFor(zoneWidth)
  // 「N 张名片」那颗来回切名片栏:宽的时候本来就摆着,点一下收起;窄的时候点一下浮出来。
  const [railOpen, setRailOpen] = useState(false)
  /**
   * 目标视图右边放什么(2026-10-27,合并稿 2.3):缺省是事项轨迹;「N 张名片」那颗切到名片栏,再点切回。
   * 时间线视图照旧是名片栏。
   */
  const [showCardRail, setShowCardRail] = useState(false)
  const tasksState = state.tasks
  const tasks = tasksState?.tasks ?? []
  const goalsRaw = tasksState?.goals ?? []
  const sprints = tasksState?.goal_sprints ?? []
  const squads = tasksState?.squads ?? []
  const meetings = useMemo((): MeetingView[] => [...(state.meetings?.upcoming ?? []), ...(state.meetings?.recent ?? [])], [state.meetings])
  const goals = useMemo(() => boardGoals(goalsRaw, tasks), [goalsRaw, tasks])
  const notes = useMemo(() => boardNotes(tasks), [tasks])
  const now = nowMs ?? (Number.isFinite(Date.parse(state.now)) ? Date.parse(state.now) : Date.now())

  const [view, setView] = useState<CollabView>(initialView ?? 'timeline')
  /**
   * 时间线两种摆法(2026-10-27 合并稿 ④)。缺省是人和 Agent 占用(决策记录 10-27「已拍板:呈现语义」:
   * 时间线主体是人和 Agent 的计划占位及实际占用,不是任务列表);按日期的日程留作切换项。只记阅读偏好,存不了也不妨碍。
   */
  const [timelineMode, setTimelineModeState] = useState<'days' | 'occupancy'>(() => {
    try { return localStorage.getItem(TIMELINE_MODE_KEY) === 'days' ? 'days' : 'occupancy' } catch { return 'occupancy' }
  })
  const setTimelineMode = (mode: 'days' | 'occupancy'): void => {
    setTimelineModeState(mode)
    try { localStorage.setItem(TIMELINE_MODE_KEY, mode) } catch { /* 本轮照样切。 */ }
  }
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsTab, setSettingsTab] = useState<SettingsTab | undefined>(undefined)

  // —— 目标视图的摆法:读一次,之后以本地为准,停手再存 ——
  const [saved, setSaved] = useState<BoardLayout | undefined>(undefined)
  useEffect(() => {
    if (!visible || saved !== undefined) return
    let alive = true
    void api.get<{ layout?: unknown }>('/collab/canvas').then((got) => { if (alive) setSaved(boardLayoutOf(got?.layout)) })
    return () => { alive = false }
  }, [visible, saved, api])
  // 看板可用宽 = 协作区宽 − 名片栏(露着的那一份);按宽增列(设计 3.3)。
  const fullscreen = onExitFull !== undefined
  const railWide = railShown !== railOpen
  const boardW = (zoneWidth ?? 1200) - (railWide ? RAIL_WIDTH : 0)
  const layout = useMemo(() => autoLayout(goals, notes, saved ?? EMPTY_LAYOUT, boardW), [goals, notes, saved, boardW])
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const onLayout = useCallback((next: BoardLayout) => {
    setSaved(next)
    if (saveTimer.current !== undefined) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => { void api.post('/collab/canvas', { layout: next }) }, SAVE_LAYOUT_MS)
  }, [api])
  useEffect(() => () => { if (saveTimer.current !== undefined) clearTimeout(saveTimer.current) }, [])
  /** 「整理布局」= 忘掉手动摆法,存一份按当前宽度自动重排的(设计 3.3:自动布局随窗口重排,手动位置保留)。 */
  const tidyLayout = useCallback(() => {
    onLayout(autoLayout(goals, notes, EMPTY_LAYOUT, boardW))
  }, [goals, notes, boardW, onLayout])

  // 看板方式:全屏可画布/阅读互切(默认画布);组件态固定阅读(设计 3.3)。
  const [boardModePick, setBoardModePick] = useState<'reading' | 'canvas'>('canvas')
  const boardMode: 'reading' | 'canvas' = fullscreen ? boardModePick : 'reading'

  const [filter, setFilter] = useState<CollabFilter>({})
  const [filtersOpen, setFiltersOpen] = useState(false)
  const shown = useCallback((task: TaskView) => matchesFilter(task, goalsRaw, sprints, filter), [goalsRaw, sprints, filter])
  const filteredTasks = useMemo(() => tasks.filter(shown), [tasks, shown])
  // 完成情况筛选一处真源:图例点选与筛选行「进行中」都改 filter.progress。
  const pickedProgress = filter.progress ?? EMPTY_PROGRESS
  const pickProgress = useCallback((kind: BoardProgress) => setFilter(previous => toggleProgress(previous, kind)), [])
  const entries = state.agent_registry?.entries ?? []
  const meName = useMeName()
  const cards = useMemo(() => railCards(entries, tasksState?.agent_cards ?? [], presence, meName, state.agent_caps), [entries, tasksState?.agent_cards, presence, meName, state.agent_caps])
  const nameOf = useCallback((id: string | undefined) => cards.find(one => one.id === id)?.name ?? assigneeName(id), [cards])
  const ownerText = useCallback((task: TaskView) => ownerLine(task, { squads, nameOf }), [squads, nameOf])
  const waiting = useMemo(() => waitingStrip(tasks, tasksState?.session_proposals ?? []), [tasks, tasksState?.session_proposals])

  // —— 头像关联:点一个名片,相关的加轮廓、其余变淡;「只看我」= 选中你 ——
  const [person, setPerson] = useState<string | undefined>(undefined)
  const personName = person === undefined ? '' : nameOf(person)
  const noteRel = useMemo(() => (person === undefined ? undefined : (task: TaskView) => noteRelation(task, person)), [person])
  const itemRel = useMemo(() => {
    if (person === undefined) return undefined
    return (item: TimelineItem) => {
      if (item.kind === 'note') { const task = tasks.find(one => one.id === item.id); return task === undefined ? undefined : noteRelation(task, person) }
      if (item.kind === 'session') return item.id.split(':')[0] === person ? 'owner' : undefined
      if (item.kind === 'event') {
        const task = tasks.find(one => one.id === item.id)
        if (task === undefined) return undefined
        return task.receipt?.by === person ? 'owner' : noteRelation(task, person)
      }
      const meeting = meetings.find(one => one.id === item.id)
      return meeting === undefined ? undefined : meetingRelation(meeting, person, personName)
    }
  }, [person, personName, tasks, meetings])

  const togglePerson = useCallback((id: string) => setPerson(current => (current === id ? undefined : id)), [])
  const avatars = tasksState?.avatars
  const people = useMemo((): PeopleCtx => ({ cards, avatars: avatars ?? {}, baseUrl, selected: person, onSelect: togglePerson }), [cards, avatars, baseUrl, person, togglePerson])
  const [avatarFor, setAvatarFor] = useState<string | undefined>(undefined)
  const avatarCard = avatarFor === undefined ? undefined : cards.find(one => one.id === avatarFor)

  // 容量随事项快照重读;接口不在就缺席,不编上限。
  const [capacity, setCapacity] = useState<readonly CapacityItem[] | undefined>(undefined)
  useEffect(() => {
    if (!visible) return undefined
    let alive = true
    void api.get<{ items?: CapacityItem[] }>('/collab/capacity').then((got) => {
      if (alive) setCapacity(got?.items ?? [])
    })
    return () => { alive = false }
  }, [visible, api, tasksState])
  const [actualRuns, setActualRuns] = useState<readonly RunSegment[]>()
  useEffect(() => {
    if (!visible) return
    let alive = true
    const goalIds = [...new Set(tasks.map(goalIdOf))]
    void Promise.all(goalIds.map(id => api.get<{ runs?: RunSegment[] }>(`/collab/runs?goal_id=${encodeURIComponent(id)}`))).then(results => {
      if (alive) setActualRuns(results.some(result => !Array.isArray(result?.runs)) ? undefined : results.flatMap(result => result?.runs ?? []))
    })
    return () => { alive = false }
  }, [visible, api, tasksState])
  const [receipt, setReceipt] = useState<string | undefined>(undefined)
  useEffect(() => {
    if (receipt === undefined) return undefined
    const timer = setTimeout(() => setReceipt(undefined), 4000)
    return () => clearTimeout(timer)
  }, [receipt])

  // —— 时间线的日期导航 ——
  const todayKey = dayKeyOf(now)
  const [anchor, setAnchor] = useState(todayKey)
  const [days, setDays] = useState(3)
  const rangeKeys = dayKeys(anchor, days)
  const rangeLabel = rangeText(rangeKeys)

  const [focus, setFocus] = useState<{ x: number, y: number, at: number } | undefined>(undefined)
  const [readingFocus, setReadingFocus] = useState<{ id: string, at: number }>()
  const flyToNote = useCallback((id: string) => {
    setReadingFocus({ id, at: Date.now() })
    const task = tasks.find(one => one.id === id)
    if (view === 'timeline' && task?.start !== undefined) { setAnchor(dayKeyOf(Date.parse(task.start))); return }
    const pos = layout.notes[id]
    if (pos === undefined) { setSelected({ kind: 'note', id, talk: false }); return }
    if (view !== 'goals') setView('goals')
    setFocus({ x: pos.x + NOTE_W / 2, y: pos.y + NOTE_H / 2, at: Date.now() })
  }, [layout, tasks, view])
  const flyToGoal = useCallback((id: string) => {
    const box = layout.goals[id]
    setView('goals')
    if (box !== undefined) setFocus({ x: box.x + box.w / 2, y: box.y + Math.min(box.h, 300) / 2, at: Date.now() })
  }, [layout])

  const [selected, setSelected] = useState<{ kind: 'note' | 'meeting', id: string, talk: boolean } | undefined>(undefined)
  const selectedTask = selected?.kind === 'note' ? notes.find(one => one.id === selected.id) : undefined
  const selectedMeeting = selected?.kind === 'meeting' ? meetings.find(one => one.id === selected.id) : undefined
  const hasDialogOpen = avatarFor !== undefined || selected !== undefined || settingsOpen
  const isFloatingRail = !railShown
  const railVisible = (railShown !== railOpen) && (!hasDialogOpen || !isFloatingRail)
  const order = useMemo(() => notes.slice().sort((a, b) => {
    const pa = layout.notes[a.id] ?? { x: 0, y: 0 }
    const pb = layout.notes[b.id] ?? { x: 0, y: 0 }
    return pa.y - pb.y || pa.x - pb.x
  }), [notes, layout])
  const neighbour = (step: 1 | -1): (() => void) | undefined => {
    if (selectedTask === undefined) return undefined
    const at = order.findIndex(one => one.id === selectedTask.id)
    const next = order[at + step]
    return next === undefined ? undefined : () => setSelected({ kind: 'note', id: next.id, talk: false })
  }

  const onStamp = useCallback((task: TaskView, choice: StampChoice) => {
    if (isTaskGroup(task) || choice.path === undefined) return
    void moveAlong(api, task.id, choice.path).then(failed => setReceipt(failed ?? `章盖成「${choice.stamp}」`))
  }, [api])
  const onArrow = useCallback((task: TaskView, status: TaskStatus) => {
    if (isTaskGroup(task)) return
    void api.post('/task/move', { id: task.id, status }).then(got => { if (!got.ok) setReceipt(got.error) })
  }, [api])
  const onChangeGoal = useCallback((task: TaskView, target: string) => {
    // 拖到别的目标区 = 只改 goal_id(**拖不改状态、不改时间**)。
    void api.post('/task/update', { id: task.id, goal_id: goalIdForUpdate(target) }).then(got => setReceipt(got.ok ? undefined : got.error))
  }, [api])
  const onOpen = useCallback((task: TaskView) => setSelected({ kind: 'note', id: task.id, talk: false }), [])
  useEffect(() => {
    if (locate === undefined) return
    const task = tasks.find(one => one.id === locate.id)
    if (task === undefined) return
    setView('goals')
    setSummaryGoalId(goalIdOf(task))
    setSelected({ kind: 'note', id: task.id, talk: false })
    // 只跟着「这一次要定位」走。
  }, [locate?.at])

  // 他直接开的会话放进目标(10-22 第三轮 4,维护者定 B)。回执里写目标名,不出现「挂」。
  const goalTitleOf = (choice: GoalChoice): string => ('goalId' in choice ? goalsRaw.find(one => one.id === choice.goalId)?.title ?? choice.goalId : choice.newGoalTitle)
  const goalBody = (choice: GoalChoice) => ('goalId' in choice ? { goal_id: choice.goalId } : { new_goal_title: choice.newGoalTitle })
  const place = (item: Extract<WaitingItem, { kind: 'proposal' }>, choice: GoalChoice): void => {
    const p = item.proposal
    void api.post('/collab/session/attach', {
      agent: p.agent, session_id: p.session_id, title: p.title, ...goalBody(choice),
      ...(p.project_id === undefined ? {} : { project_id: p.project_id }),
    }).then(got => setReceipt(got.ok ? `放进了「${goalTitleOf(choice)}」` : got.error))
  }
  const dismiss = (item: Extract<WaitingItem, { kind: 'proposal' }>): void => {
    void api.post('/collab/session/dismiss', { agent: item.proposal.agent, session_id: item.proposal.session_id }).then(got => setReceipt(got.ok ? '好,这条会话不进看板' : got.error))
  }
  const placedAct = (placed: SessionPlaced, action: 'move' | 'remove' | 'ack', choice?: GoalChoice): void => {
    void api.post('/collab/session/placed', { agent: placed.agent, session_id: placed.session_id, action, ...(choice === undefined ? {} : goalBody(choice)) })
      .then((got) => {
        if (!got.ok) { setReceipt(got.error); return }
        if (action === 'move' && choice !== undefined) setReceipt(`放进了「${goalTitleOf(choice)}」`)
        if (action === 'remove') setReceipt('好,这条会话不进看板')
      })
  }

  const [newGoal, setNewGoal] = useState<string | undefined>(undefined)
  const [unscheduledOpen, setUnscheduledOpen] = useState(false)
  const [bubbleOpen, setBubbleOpen] = useState(false)
  // 来往速览(与详情共用 NoteTalk/草稿);点「打开详情」平移过去。
  const [quickViewId, setQuickViewId] = useState<string | undefined>(undefined)
  const quickTask = quickViewId === undefined ? undefined : notes.find(one => one.id === quickViewId)
  // 目标条件面板(契约 B);goal_id 稳定,目标改名不丢。
  const [summaryGoalId, setSummaryGoalId] = useState<string>()
  const [goalPanelId, setGoalPanelId] = useState<string | undefined>(undefined)
  const goalPanelGoal = goalPanelId === undefined ? undefined : goalsRaw.find(one => one.id === goalPanelId)
  const onConditions = useCallback((one: { id: string }) => { setSummaryGoalId(one.id); setGoalPanelId(one.id) }, [])
  /** 目标条与轨迹看的是哪个目标:点过哪个就是哪个,没点过取第一个有事项的目标(2026-10-27)。 */
  const barGoal = goalsRaw.find(one => one.id === summaryGoalId) ?? goalsRaw.find(one => tasks.some(task => goalIdOf(task) === one.id)) ?? goalsRaw[0]
  const projectName = (id: string): string => state.projects?.projects.find(one => one.id === id)?.name ?? id
  // 类型表(2026-10-22 做成设置):认出来的类型不在表里(删掉了)就照中性灰画。
  const workTypes = workTypesOf(state)
  const typeIds = useMemo(() => new Set(workTypes.map(one => one.id)), [workTypes])
  const typeOf = useCallback((task: TaskView) => { const type = workTypeOf(task); return type !== undefined && typeIds.has(type) ? type : undefined }, [typeIds])
  const goalOwner = useCallback((goal: { owner: string }) => nameOf(goal.owner), [nameOf])
  const later = unscheduled(tasks)
  // 来往条数(留言+评论;服务端没接 messages 就是 0,不编)。
  const talkCountOf = useCallback((one: TaskView): number => (one.messages?.length ?? 0) + (one.comments?.length ?? 0), [])
  const onQuickView = useCallback((one: TaskView) => setQuickViewId(one.id), [])

  if (tasksState === undefined) {
    return (
      <section className="ben-cl" ref={rootRef} data-theme={theme} data-visible={visible} aria-label="协作区">
        <div className="ben-cl__emptystate"><Empty title="任务账没接上" hint="板上什么都摆不出来。" /></div>
      </section>
    )
  }

  const empty = notes.length === 0 && goalsRaw.length === 0 && meetings.length === 0

  return (
    <WorkTypesContext.Provider value={workTypes}>
    <PeopleProvider value={people}>
    <section className="ben-cl" ref={rootRef} data-theme={theme} data-visible={visible} aria-label="协作区">
      <style>{workTypeStyle(workTypes)}</style>
      {state.stale && <p role="status" className="ben-cl__offline">Agent 掉线，当前保留上次已知状态。</p>}
      {/* 头三行照评审页协作区原型(10-22 拍板 18):`.top` 标题与工具 / `.toolbar` 视图、项目、筛选、日期 / `.people-strip` 成员。 */}
      <div className="ben-cl__head">
        <div className="ben-cl__top">
          <h2 className="ben-cl__title">协作区</h2>
          <div className="ben-cl__tools">
            <button type="button" aria-label={`${cards.length} 张名片`} aria-expanded={view === 'goals' ? showCardRail && railVisible : railVisible} title="成员与 Agent" onClick={() => { if (view === 'goals') { setShowCardRail(on => !on); if (!railVisible) setRailOpen(open => !open) } else setRailOpen(open => !open) }}><Icon name="users-round" size={15} /><span className="ben-cl__tool-label">{cards.length} 张名片</span></button>
            {/* 设置是盖在协作区上的一层(评审页协作区组件:⚙ 打开、✕ / Esc / 点遮罩关),板子留在下面不换页。 */}
            <button type="button" aria-label="设置" title="协作区设置" aria-haspopup="dialog" aria-expanded={settingsOpen} onClick={() => setSettingsOpen(true)}><Icon name="settings-2" size={15} /></button>
            {onExpand !== undefined && <button type="button" onClick={onExpand} aria-label="全屏" title="整屏只看协作区"><Icon name="maximize-2" size={15} /></button>}
            {onExitFull !== undefined && <button type="button" className="ben-cl__exitfull" onClick={onExitFull}><Icon name="minimize-2" size={15} />退出全屏</button>}
          </div>
        </div>
      </div>
      <nav className="ben-cl__context-controls" aria-label="上方信息">
        <button type="button" aria-expanded={!folds.members} onClick={() => toggleFold('members')}>成员 · {person === undefined ? '全部成员' : personName}</button>
        <button type="button" aria-expanded={!folds.filters} onClick={() => toggleFold('filters')}>筛选 · {view === 'goals' ? '目标' : view === 'timeline' ? '时间线' : '频道'} · {filter.project?.[0] === undefined ? '全部项目' : projectName(filter.project[0])}{Object.keys(filter).some(key => key !== 'project') ? ' · 已筛选' : ''}</button>
        <button type="button" aria-expanded={!folds.waiting} onClick={() => toggleFold('waiting')}>等你 · {waiting.filter(one => one.kind === 'note').length + (tasksState?.relay_asks ?? 0)}</button>
        {view !== 'channel' && <button type="button" aria-expanded={!folds.stats} onClick={() => toggleFold('stats')}>统计 · {filteredTasks.length} 项</button>}
        <button type="button" onClick={toggleAll}>{Object.values(folds).every(Boolean) ? '展开上方' : '收起上方'}</button>
      </nav>
      <div className="ben-cl__context-details">
        <div hidden={folds.filters}>
        <div className="ben-cl__toolbar">
          <div className="ben-cl__seg" role="group" aria-label="视图">
            <button type="button" aria-pressed={view === 'timeline'} onClick={() => setView('timeline')}>时间线</button>
            <button type="button" aria-pressed={view === 'goals'} onClick={() => setView('goals')}>目标</button>
            <button type="button" aria-pressed={view === 'channel'} onClick={() => setView('channel')}>频道</button>
          </div>
          <select aria-label="项目" value={filter.project?.[0] ?? ''} onChange={(event) => { const { project: _drop, ...rest } = filter; setFilter(event.target.value === '' ? rest : { ...rest, project: [event.target.value] }) }}>
            <option value="">全部项目</option>
            {filterOptions(tasks, goalsRaw, sprints).project.map(id => <option key={id} value={id}>{projectName(id)}</option>)}
          </select>
          <button type="button" className="ben-cl__progress-pick" aria-label="筛选:只看进行中" aria-pressed={pickedProgress.includes('doing')} onClick={() => pickProgress('doing')}>进行中</button>
          <button type="button" aria-label="筛选" title="筛选" aria-expanded={filtersOpen} onClick={() => setFiltersOpen(open => !open)}><Icon name="sliders-horizontal" size={15} /></button>
          {view === 'goals' && fullscreen && (
            <span className="ben-cl__seg" role="group" aria-label="看板方式">
              <button type="button" aria-pressed={boardMode === 'canvas'} onClick={() => setBoardModePick('canvas')}>画布</button>
              <button type="button" aria-pressed={boardMode === 'reading'} onClick={() => setBoardModePick('reading')}>阅读</button>
            </span>
          )}
          {view === 'goals' && <button type="button" aria-label="整理布局" title="忘掉手动摆法,按当前宽度自动重排" onClick={tidyLayout}>整理布局</button>}
          {view === 'goals' && (newGoal === undefined
            ? <button type="button" onClick={() => setNewGoal('')}>新目标</button>
            : (
                <form
                  className="ben-cl__timeform"
                  onSubmit={(event) => {
                    event.preventDefault()
                    const title = newGoal.trim()
                    if (title === '') return
                    void api.post('/collab/goal/create', { title }).then((got) => {
                      setReceipt(got.ok ? `目标「${title}」贴上了` : got.error)
                      if (got.ok) setNewGoal(undefined)
                    })
                  }}
                >
                  <input aria-label="新目标(一句话)" value={newGoal} autoFocus onChange={event => setNewGoal(event.target.value)} placeholder="一句话:为了什么" />
                  <button type="submit" className="ben-cl__primary">贴上</button>
                  <button type="button" onClick={() => setNewGoal(undefined)}>算了</button>
                </form>
              ))}
          {view === 'timeline' && (
            <span className="ben-cl__tl-mode" role="group" aria-label="时间线摆法">
              <button type="button" aria-pressed={timelineMode === 'days'} onClick={() => setTimelineMode('days')}>按日期</button>
              <button type="button" aria-pressed={timelineMode === 'occupancy'} onClick={() => setTimelineMode('occupancy')}>人和 Agent 占用</button>
            </span>
          )}
          {view === 'timeline' && (
            <span className="ben-cl__nav">
              <button type="button" aria-label="往前" title="上一组日期" onClick={() => setAnchor(backDay(anchor, days))}><Icon name="chevron-left" size={15} /></button>
              <span className="ben-cl__range">{rangeLabel}</span>
              <button type="button" aria-label="往后" title="下一组日期" onClick={() => setAnchor(shiftDay(anchor, days))}><Icon name="chevron-right" size={15} /></button>
              <button type="button" onClick={() => setAnchor(todayKey)}>今天</button>
            </span>
          )}
        </div>
        {filtersOpen && <FilterBar options={filterOptions(tasks, goalsRaw, sprints)} filter={filter} onChange={setFilter} sprints={sprints} projectName={projectName} cards={cards} />}
        </div>
        <div hidden={folds.members}>
        <div className="ben-cl__people" role="group" aria-label="成员">
          <button type="button" className="ben-cl__person" aria-pressed={person === undefined} onClick={() => setPerson(undefined)}>全部成员</button>
          {/* 本机接入的那几家照顶栏原来的样子(受保护的图标、在干活的角标、悬停说明卡,同一个组件);顶栏那一排在协作区在时不画。 */}
          {cards.map((one) => {
            const lamp = lamps?.find(item => item.id === one.id)
            if (lamp === undefined) return <span key={one.id} data-fly-from={one.id}><PersonLabel id={one.id} /></span>
            return (
              <LampHover key={one.id} lamp={lamp}>
                <button type="button" className="ben-cl__person" data-fly-from={one.id} data-status={lamp.color} aria-pressed={person === one.id} aria-label={`看 ${one.name} 的相关事项`} onClick={() => togglePerson(one.id)}>
                  <LampIcon lamp={lamp} baseUrl={baseUrl} />
                  <span className="ben-cl__person-name">{one.name}</span>
                </button>
              </LampHover>
            )
          })}
        </div>
      </div>
      <div hidden={folds.waiting}>
      <WaitingStrip
        items={waiting}
        goals={goalsRaw}
        tasks={tasks}
        placed={state.tasks?.session_placed ?? []}
        nameOf={nameOf}
        onFly={flyToNote}
        onPlace={place}
        onDismiss={dismiss}
        onPlacedOpen={(placed) => { flyToNote(placed.task_id); placedAct(placed, 'ack') }}
        onPlacedMove={(placed, choice) => placedAct(placed, 'move', choice)}
        onPlacedRemove={placed => placedAct(placed, 'remove')}
        asks={state.tasks?.relay_asks ?? 0}
      >
        <RelayAsks api={api} count={state.tasks?.relay_asks ?? 0} onReceipt={setReceipt} />
      </WaitingStrip>
      </div>
      <div hidden={folds.stats}>
      {view !== 'channel' && (
        <ProgressSummary
          tasks={filteredTasks}
          runs={state.stale ? undefined : actualRuns}
          goals={goalsRaw}
          sprints={sprints}
          filter={filter}
          presence={presence}
          sessions={state.sessions ?? []}
          serverNow={state.now}
          nowMs={now}
          nameOfAssignee={nameOf}
          onOpenTask={onOpen}
          onFlyToNote={flyToNote}
        />
      )}
      </div>
      <div hidden={folds.conditions}>
      {view === 'goals' && (
        <div className="ben-cl__goalstrip" role="region" aria-label="目标摘要">
          {goals.map((goal) => {
            const known = new Set(goalsRaw.map(one => one.id))
            const members = notes.filter(one => (one.goal_id !== undefined && known.has(one.goal_id) ? one.goal_id : UNSORTED_GOAL_ID) === goal.id)
            const done = members.filter(one => one.status === 'done').length
            return (
              <button
                key={goal.id}
                type="button"
                className="ben-cl__goalstrip-chip"
                data-status={goal.status}
                aria-label={`跳到目标 ${goal.title}`}
                onClick={() => {
                  setSummaryGoalId(goal.id)
                  // 阅读模式跟着当前目标滚(ReadingBoard 的 currentGoalId),这里只管画布。
                  if (boardMode === 'canvas') flyToGoal(goal.id)
                }}
              >
                <span className="ben-cl__goalstrip-name">{goal.title}</span>
                <span className="ben-cl__goalstrip-count">事项 {done}/{members.length} 做完</span>
              </button>
            )
          })}
          {goals.length === 0 && <span className="ben-cl__muted">还没有目标。</span>}
        </div>
      )}
      </div>
      </div>
      {view === 'goals' && barGoal !== undefined && <GoalBar goal={barGoal} tasks={tasks} onTrace={() => onConditions(barGoal)} pick={{ picked: pickedProgress, onPick: pickProgress }} />}
      {view === 'goals' && <FixedGoalSummary collapsed={folds.conditions} onToggle={() => toggleFold('conditions')} goals={goalsRaw} selected={barGoal?.id} onSelect={setSummaryGoalId} api={api} snapshot={tasksState} stale={state.stale === true} nameOf={nameOf} onOpen={id => { flyToNote(id); setSelected({ kind: 'note', id, talk: false }) }} onConditions={onConditions} />}
      <div className="ben-cl__main" data-narrow={!railShown}>
        <div className="ben-cl__board">
          {view === 'channel' && (
            <ChannelView api={api} tick={relayTick(state)} lanTick={state} projects={[...new Set([...tasks.map(one => one.project_id), ...goalsRaw.map(one => one.project_id)].filter((id): id is string => id !== undefined))].map(id => ({ id, title: projectName(id) }))} nowMs={now} onReceipt={setReceipt} onOpenStudio={() => { setSettingsTab('studio'); setSettingsOpen(true) }} />
          )}
          {empty && view !== 'channel' && (
            <div className="ben-cl__emptystate">
              <Empty title="板上还没有事" hint="跟事务官说一件事,它会写清楚为什么、从哪来、做到什么算完。" action="跟事务官说一件事" onAction={() => setBubbleOpen(true)} />
            </div>
          )}
          {!empty && view === 'timeline' && timelineMode === 'occupancy' && (
            <div className="ben-cl__timeline-panes">
              <OccupancyView
                api={api}
                tasks={tasks.filter(shown)}
                meetings={meetings}
                dayKey={anchor}
                nowMs={now}
                onOpenNote={id => setSelected({ kind: 'note', id, talk: false })}
                onOpenMeeting={id => setSelected({ kind: 'meeting', id, talk: false })}
              />
            </div>
          )}
          {!empty && view === 'timeline' && timelineMode === 'days' && (
            <TimelineView
              api={api}
              tasks={tasks}
              meetings={meetings}
              goals={goalsRaw}
              projectName={projectName}
              sessions={state.sessions ?? []}
              anchorKey={anchor}
              nowMs={now}
              {...(timelineWidth === undefined ? {} : { width: timelineWidth })}
              shown={shown}
              typeOf={typeOf}
              ownerText={ownerText}
              relation={itemRel}
              onDays={setDays}
              onOpenNote={id => setSelected({ kind: 'note', id, talk: false })}
              onOpenMeeting={id => setSelected({ kind: 'meeting', id, talk: false })}
              onStamp={onStamp}
            />
          )}
          {!empty && view === 'goals' && boardMode === 'reading' && (
            <ReadingBoard
              focusNote={readingFocus}
              currentGoalId={barGoal?.id}
              progress={pickedProgress}
              goals={goals}
              tasks={tasks}
              shown={shown}
              cards={cards}
              assigneeText={ownerText}
              typeOf={typeOf}
              {...(noteRel === undefined ? {} : { relationOf: noteRel })}
              goalOwner={goalOwner}
              onConditions={onConditions}
              presence={presence}
              onStamp={onStamp}
              onArrow={onArrow}
              onOpen={onOpen}
              talkCountOf={talkCountOf}
              onQuickView={onQuickView}
            />
          )}
          {!empty && view === 'goals' && boardMode === 'canvas' && visible && saved !== undefined && (
            <CollabBoard
              goals={goals}
              tasks={tasks}
              layout={layout}
              boardW={boardW}
              shown={shown}
              presence={presence}
              cards={cards}
              assigneeText={ownerText}
              typeOf={typeOf}
              relationOf={noteRel}
              goalOwner={goalOwner}
              onConditions={onConditions}
              fullscreen
              nowMs={now}
              {...(focus === undefined ? {} : { focus })}
              {...(barGoal === undefined ? {} : { fitGoalId: barGoal.id })}
              onLayout={onLayout}
              onChangeGoal={onChangeGoal}
              onStamp={onStamp}
              onArrow={onArrow}
              onOpen={onOpen}
              talkCountOf={talkCountOf}
              onQuickView={onQuickView}
            />
          )}
          {receipt !== undefined && <p className="ben-cl__receipt" role="status">{receipt}</p>}
          {unscheduledOpen && (
            <div className="ben-cl__pop" role="dialog" aria-label="未排时间">
              {later.length === 0 ? <p className="ben-cl__muted">没有未排时间的事。</p> : (
                <ul>
                  {later.map(task => (
                    <li key={task.id}>
                      <span>{task.title}</span>
                      <button type="button" className="ben-cl__secondary" onClick={() => { setUnscheduledOpen(false); setSelected({ kind: 'note', id: task.id, talk: false }) }}>排时间</button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {bubbleOpen && (
            <ChatBubble
              note={selectedTask}
              api={api}
              onReceipt={setReceipt}
              onClose={() => setBubbleOpen(false)}
              {...(selectedTask === undefined ? {} : { onExpand: () => setSelected({ kind: 'note', id: selectedTask.id, talk: true }) })}
            />
          )}
          {quickTask !== undefined && (
            <NoteQuickView
              task={quickTask}
              cards={cards}
              api={api}
              onOpen={(one) => { setQuickViewId(undefined); setSelected({ kind: 'note', id: one.id, talk: false }) }}
              onOpenTask={id => { setQuickViewId(undefined); setSelected({ kind: 'note', id, talk: false }) }}
              onClose={() => setQuickViewId(undefined)}
            />
          )}
        </div>
        {/* 事项轨迹只在全屏画:组件态空间不够,高度全给阅读区(2026-10-28 维护者拍板)。 */}
        {view === 'goals' && fullscreen && !showCardRail && barGoal !== undefined && (railVisible || !railShown) && (
          <TraceRail
            api={api}
            goalId={barGoal.id}
            tasks={tasks.filter(task => goalIdOf(task) === barGoal.id)}
            nameOf={nameOf}
            onOpen={id => setSelected({ kind: 'note', id, talk: false })}
          />
        )}
        {railVisible && (view !== 'goals' || showCardRail || barGoal === undefined) && (
        <CardRail
          floating={!railShown}
          cards={cards}
          entries={entries}
          tasks={tasks}
          selected={person}
          onSelect={togglePerson}
          onEditAvatar={setAvatarFor}
          noteTitle={id => notes.find(one => one.id === id)?.title}
          onFly={flyToNote}
          onRegister={async (input) => {
            const got = await api.post('/collab/agent/save', input)
            if (got.ok) setReceipt(`名片「${input.name}」登记好了`)
            return got.ok ? undefined : got.error
          }}
          capacity={capacity}
        />
        )}
      </div>
      <div className="ben-cl__foot">
        <button type="button" aria-expanded={unscheduledOpen} onClick={() => setUnscheduledOpen(open => !open)}>未排时间 {later.length}<Icon name="chevron-up" size={12} /></button>
        {/* 目标视图的卡片按完成情况上色(图例在目标条里),类型看卡头图标;这排类型色只留给时间线。 */}
        {view !== 'goals' && <span className="ben-cl__legend" aria-label="类型">
          {workTypes.map(type => <span key={type.id} style={{ ['--lg' as string]: `var(--t-${type.id})` }}>{type.title}</span>)}
        </span>}
        <span className="ben-cl__spacer" />
        {/* 「记一件事」(原型 `.new-entry`):说给事务官,它写清为什么、从哪来、做到什么算完。 */}
        <button type="button" className="ben-cl__bubble-btn" aria-expanded={bubbleOpen} onClick={() => setBubbleOpen(open => !open)}><Icon name="plus" size={12} />记一件事</button>
      </div>
      {settingsOpen && <CollabSettings state={state} api={api} cards={cards} entries={entries} baseUrl={baseUrl} fetchImpl={fetchImpl} onReceipt={setReceipt} {...(settingsTab === undefined ? {} : { initialTab: settingsTab })} onEditAvatar={setAvatarFor} onClose={() => { setSettingsOpen(false); setSettingsTab(undefined) }} />}
      {selectedTask !== undefined && (
        <NoteDialog
          task={selectedTask}
          state={state}
          goals={goalsRaw}
          cards={cards}
          entries={entries}
          api={api}
          baseUrl={baseUrl}
          fetchImpl={fetchImpl}
          assigneeText={ownerText}
          focusTalk={selected?.talk === true}
          onClose={() => setSelected(undefined)}
          {...(neighbour(-1) === undefined ? {} : { onPrev: neighbour(-1) as () => void })}
          {...(neighbour(1) === undefined ? {} : { onNext: neighbour(1) as () => void })}
          onFlyGoal={(id) => { setSelected(undefined); flyToGoal(id) }}
          onReceipt={setReceipt}
          onOpenTask={(id) => setSelected({ kind: 'note', id, talk: false })}
        />
      )}
      {selectedMeeting !== undefined && (
        <MeetingDialog
          meeting={selectedMeeting}
          tasks={tasks}
          cards={cards}
          api={api}
          onClose={() => setSelected(undefined)}
          onOpenNote={id => setSelected({ kind: 'note', id, talk: false })}
          onReceipt={setReceipt}
        />
      )}
      {avatarCard !== undefined && (
        <AvatarEditor owner={avatarCard.id} name={avatarCard.name} kind={kindOfCard(avatarCard)} api={api} onClose={() => setAvatarFor(undefined)} onReceipt={setReceipt} />
      )}
      {goalPanelGoal !== undefined && (
        <GoalPanel
          key={goalPanelGoal.id}
          goal={goalPanelGoal}
          api={api}
          snapshotKey={tasksState}
          onOpenTask={(id) => { setGoalPanelId(undefined); setSelected({ kind: 'note', id, talk: false }) }}
          onClose={() => setGoalPanelId(undefined)}
        />
      )}
      {/* 真实回执飞线(合并稿 7.1):只认任务账里新到的回执,两头都在板上才飞,减少动态效果时不飞。 */}
      <FlyLayer tasks={tasksState.tasks} root={rootRef} />
    </section>
    </PeopleProvider>
    </WorkTypesContext.Provider>
  )
}
