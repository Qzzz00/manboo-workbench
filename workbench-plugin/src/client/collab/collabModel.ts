/**
 * 协作区板的纯函数(2026-10-21,`docs/设计-协作区-无限画布-2026-10-21.md` 第三、四节)。
 *
 * 板的规则在这里落成判断,组件只管画:
 * - 按**目标**分区,不按状态分列;空目标只画一条标题线;「未归目标」只在有老卡时出现;
 * - **拖只挪位置**(落进别的目标区 = 改 `goal_id`),**点章改状态**;←/→ 照旧在;
 * - 「现在等你」= 章是「等你」、且事务官标了四类拍板请求的便签(按回执时间先后;2026-10-26 卡
 *   「事务官页接管队列」——没带请求的是事务官待核验队列,不摊给他,判据唯一:`protocol.ts` 的
 *   `ownerAskOf`,与服务端「等你」堆、冲刺条「等我确认」同一处)+ 会话挂目标的提议;
 * - 不画进度条、不算完成率(不可改清单第 5 条:不催、不建议删)。
 */
import type {
  AgentCapsView, AgentCard, AgentEntryView, CollabGoal, CollabPresence, CollabSprint, SessionProposal, TaskAssignee, TaskStatus, TaskView, UsageTotals,
} from '../../protocol.ts'
import {
  AGENT_IDS, STAMP_TITLES, TASK_STATUSES, UNSORTED_GOAL_ID, boardAssignee, canTransition, goalIdOf, ownerAskOf, statusPathTo, workTypeOf,
} from '../../protocol.ts'
import { cardSpend, formatSpend } from '../boardModel.ts'
import { type BoardProgress, progressOf } from './boardProgress.ts'
import { ME_FALLBACK } from '../meName.tsx'

/** 便签在板上画多大(拖放落点判断、自动摆都按它)。 */
export const NOTE_W = 260
/** 阅读宽上限(2026-10-24 设计 3.3):正文可读的前提下卡不再拉长,宽了加列。 */
export const READING_W = 370
export const NOTE_H = 160
/** 目标区标题那一条有多高(空目标就只有这一条)。 */
export const GOAL_TITLE_H = 112
/** 区里便签之间、区与区之间的空。 */
const GAP = 20
const AREA_GAP = 48
/** 一个目标区一排摆几张(自动摆用;他自己挪过的不受它管)。 */
const COLS = 2
/** 老默认区域宽(580 = 两列 260 + 三条缝),不传宽时保持 e2242240b 之前的行为。 */
const DEFAULT_AREA_W = COLS * NOTE_W + (COLS + 1) * GAP

/**
 * 这块目标区一排摆几张(2026-10-24,设计 3.3「宽屏增加列数,不能无限拉长卡片」):
 * 窄容器(摆不下一张 370 加缝)收成一列随宽度收缩;摆得下时按「每列至多 370」算列数,至少两列(老行为)。
 */
export function colsForAreaWidth(areaW: number): number {
  if (areaW < READING_W + 2 * GAP) return 1
  return Math.max(2, Math.min(6, Math.floor((areaW + GAP) / (READING_W + GAP))))
}

/** 这一宽下列里一张卡多宽:不超过 370,窄容器随宽度收缩。 */
export function noteWidthFor(areaW: number): number {
  const cols = colsForAreaWidth(areaW)
  if (cols === 1) return Math.max(NOTE_W, Math.min(READING_W, areaW))
  return Math.max(NOTE_W, Math.min(READING_W, Math.floor((areaW - GAP) / cols) - GAP))
}
/** 板上一排摆几个目标区。 */
const AREAS_PER_ROW = 2

/** Agent 小鼠标在板上显示的有效期(60 秒无事件后收掉)。常量放一处。 */
export const AGENT_CURSOR_EXPIRE_MS = 60_000

/**
 * 判断一个光标在板上是否可见:
 * - 人的光标(member)不按 60s / 在做 规则收掉;
 * - Agent 光标: 状态不是 idle, 且绑定了便签;
 * - at 距现在超过 60 秒收掉;
 * - 负责的卡已不在「在做」(doing)就收掉。
 */
export function isAgentCursorVisible(
  one: CollabPresence,
  tasks: readonly TaskView[],
  nowMs: number,
): boolean {
  if (one.actor.kind !== 'agent') return true
  if (one.state === 'idle' || one.on_note === undefined) return false
  const atMs = Date.parse(one.at)
  if (Number.isFinite(atMs) && nowMs - atMs > AGENT_CURSOR_EXPIRE_MS) return false
  const task = tasks.find(t => t.id === one.on_note)
  if (task === undefined || task.status !== 'doing') return false
  return true
}

export function visiblePresence(
  presence: readonly CollabPresence[],
  tasks: readonly TaskView[],
  nowMs: number,
): CollabPresence[] {
  return presence.filter(one => isAgentCursorVisible(one, tasks, nowMs))
}

export interface GoalBox { x: number, y: number, w: number, h: number }
export interface NotePos { x: number, y: number }
export interface BoardLayout {
  goals: Record<string, GoalBox>
  notes: Record<string, NotePos>
}

/** 「未归目标」那一块在板上长什么样(它不在账上,是现拼的)。 */
export const UNSORTED_GOAL: CollabGoal = {
  id: UNSORTED_GOAL_ID, title: '未归目标', owner: 'me', status: 'open', created_at: '', updated_at: '',
}

/** 上板的便签:随手问一句的不上(同今天看板的老规矩)。 */
export function boardNotes(tasks: readonly TaskView[]): TaskView[] {
  return tasks.filter(task => task.casual !== true)
}

/** 便签归哪块:挂的目标账上没有(被换掉、回退过)就算进「未归目标」—— 不丢。 */
export function areaOf(task: Pick<TaskView, 'goal_id'>, known: ReadonlySet<string>): string {
  const id = goalIdOf(task)
  return known.has(id) ? id : UNSORTED_GOAL_ID
}

/** 板上有哪几块目标(账上的顺序;达成 / 不要了的只在还有便签时留着;「未归目标」殿后、只在有便签时出现)。 */
export function boardGoals(goals: readonly CollabGoal[], tasks: readonly TaskView[]): CollabGoal[] {
  const notes = boardNotes(tasks)
  const known = new Set(goals.map(one => one.id))
  const used = new Set(notes.map(task => areaOf(task, known)))
  const shown = goals.filter(goal => goal.status === 'open' || used.has(goal.id))
  return used.has(UNSORTED_GOAL_ID) ? [...shown, UNSORTED_GOAL] : shown
}

function byCreated(a: TaskView, b: TaskView): number {
  return a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id)
}

/** 估算一张便签的实际渲染高度(最少 NOTE_H = 160)。 */
export function estimateNoteHeight(task: TaskView): number {
  let h = 28 + 24 + 28 // padding (28) + from (24) + foot (28)
  const titleLines = Math.min(2, Math.max(1, Math.ceil(task.title.length / 16)))
  h += titleLines * 20 + 6
  if ((task.acceptance ?? []).length > 0) h += 24
  if (task.receipt?.kind === 'objection' || task.receipt !== undefined) h += 42
  if ((task.labels ?? []).length > 0 || task.receipt_irregular === true) h += 30
  return Math.max(NOTE_H, Math.ceil(h / 10) * 10)
}

function boxesOverlap(a: GoalBox, b: GoalBox): boolean {
  return a.x < b.x + b.w + AREA_GAP && a.x + a.w + AREA_GAP > b.x && a.y < b.y + b.h + AREA_GAP && a.y + a.h + AREA_GAP > b.y
}

/**
 * 自动摆(设计稿第四节第 9 条:`.canvas` 丢了能从账重排)。**存过的位置照旧**,
 * 没存过的目标区接在已有区的下面按格子摆;没存过的便签按创建先后填进自己区里的下一个空格。
 * `boardW` = 看板可用宽(2026-10-24,设计 3.3):按宽增列、卡宽至多 370;缺席 = 老默认(两列 260)。
 */
export function autoLayout(goals: readonly CollabGoal[], tasks: readonly TaskView[], saved: BoardLayout, boardW?: number): BoardLayout {
  const known = new Set(goals.map(one => one.id))
  const notes = boardNotes(tasks).sort(byCreated)
  const byGoal = new Map<string, TaskView[]>()
  for (const task of notes) {
    const area = areaOf(task, known)
    byGoal.set(area, [...(byGoal.get(area) ?? []), task])
  }
  const effectiveGoals = byGoal.has(UNSORTED_GOAL_ID) && !known.has(UNSORTED_GOAL_ID)
    ? [...goals, UNSORTED_GOAL]
    : goals
  const cols = colsForAreaWidth(boardW ?? DEFAULT_AREA_W)
  const noteW = noteWidthFor(boardW ?? DEFAULT_AREA_W)
  const areaW = cols * noteW + (cols + 1) * GAP
  const heightFor = (members: readonly TaskView[]): number => {
    if (members.length === 0) return GOAL_TITLE_H
    const rows = Math.ceil(members.length / cols)
    let total = GOAL_TITLE_H + GAP
    for (let r = 0; r < rows; r++) {
      const slice = members.slice(r * cols, (r + 1) * cols)
      const rH = Math.max(NOTE_H, ...slice.map(estimateNoteHeight))
      total += rH + GAP
    }
    return Math.max(GOAL_TITLE_H, total)
  }

  const layout: BoardLayout = { goals: {}, notes: {} }

  // 1. 先摆目标框:存过的非重叠框保留;重叠或未存过的区按网格寻找首个不与已有区重叠的空位
  for (const goal of effectiveGoals) {
    const members = byGoal.get(goal.id) ?? []
    const savedBox = saved.goals[goal.id]
    const overlapsExisting = savedBox !== undefined && Object.values(layout.goals).some(existing => boxesOverlap(savedBox, existing))
    if (savedBox !== undefined && !overlapsExisting) {
      layout.goals[goal.id] = { ...savedBox, h: Math.max(savedBox.h, members.length === 0 ? GOAL_TITLE_H : savedBox.h) }
      continue
    }

    const h = heightFor(members)
    let slot = 0
    let candidate: GoalBox
    do {
      const c = slot % AREAS_PER_ROW
      const colBoxes = Object.values(layout.goals).filter(b => Math.abs(b.x - c * (areaW + AREA_GAP)) < 10)
      const baseY = colBoxes.length === 0 ? 0 : Math.max(0, ...colBoxes.map(b => b.y + b.h + AREA_GAP))
      candidate = { x: c * (areaW + AREA_GAP), y: baseY, w: areaW, h }
      if (!Object.values(layout.goals).some(b => boxesOverlap(candidate, b))) {
        break
      }
      const hit = Object.values(layout.goals).find(b => boxesOverlap(candidate, b))
      if (hit !== undefined) {
        candidate = { x: candidate.x, y: hit.y + hit.h + AREA_GAP, w: areaW, h }
        if (!Object.values(layout.goals).some(b => boxesOverlap(candidate, b))) {
          break
        }
      }
      slot += 1
    } while (slot < 100)
    layout.goals[goal.id] = candidate
  }

  // 2. 摆放各目标区里的便签
  for (const goal of effectiveGoals) {
    const box = layout.goals[goal.id] as GoalBox
    const members = byGoal.get(goal.id) ?? []

    const unplaced: TaskView[] = []
    for (const task of members) {
      const sp = saved.notes[task.id]
      const inBox = sp !== undefined
        && sp.x >= box.x - GAP && sp.x + noteW <= box.x + box.w + GAP
        && sp.y >= box.y - GAP && sp.y <= box.y + Math.max(box.h, 2000)
      if (inBox && sp !== undefined) {
        layout.notes[task.id] = sp
      } else {
        unplaced.push(task)
      }
    }

    let currentY = box.y + GOAL_TITLE_H + GAP
    let slot = 0
    const taken = (pos: NotePos): boolean => Object.values(layout.notes).some(one => Math.abs(one.x - pos.x) < noteW / 2 && Math.abs(one.y - pos.y) < NOTE_H / 2)

    while (slot < unplaced.length) {
      const rowSlice = unplaced.slice(slot, slot + cols)
      const rowH = Math.max(NOTE_H, ...rowSlice.map(estimateNoteHeight))
      for (let c = 0; c < rowSlice.length; c++) {
        const task = rowSlice[c]
        if (task === undefined) continue
        let pos: NotePos = { x: box.x + GAP + c * (noteW + GAP), y: currentY }
        while (taken(pos) && pos.y < box.y + 10000) {
          pos = { x: pos.x, y: pos.y + rowH + GAP }
        }
        layout.notes[task.id] = pos
      }
      currentY += rowH + GAP
      slot += rowSlice.length
    }

    const bottom = Math.max(box.y + box.h, ...members.map(task => (layout.notes[task.id]?.y ?? 0) + estimateNoteHeight(task) + GAP))
    layout.goals[goal.id] = { ...box, h: members.length === 0 ? box.h : bottom - box.y }
  }
  return layout
}

/** 一个点落在哪块目标区里(拖放松手时用;落在区外回 undefined = 只挪位置)。后摆的区压在先摆的上面。 */
export function goalAt(point: NotePos, layout: BoardLayout): string | undefined {
  const hits = Object.entries(layout.goals).filter(([, box]) => point.x >= box.x && point.x <= box.x + box.w && point.y >= box.y && point.y <= box.y + box.h)
  return hits.at(-1)?.[0]
}

export interface StampChoice {
  status: TaskStatus
  stamp: string
  current: boolean
  /** 照转换表走过去的那几步(`/task/move` 一次一格);走不到 = undefined(这一格灰掉)。 */
  path?: TaskStatus[]
}

/**
 * 点章弹出的那一排七个。走不到的灰掉,走得到的带着要走的那几步。
 * **「做完」只许直接一步**(重开到「在做」):绕道走到「不做」等于背着他先重开一次 ——
 * 转换表那条「做完了说取消没有意义,要撤销先重开」照旧。
 */
export function stampChoices(status: TaskStatus): StampChoice[] {
  return TASK_STATUSES.map((target) => {
    const found = statusPathTo(status, target)
    const path = status === 'done' && found !== undefined && found.length > 1 ? undefined : found
    return { status: target, stamp: STAMP_TITLES[target], current: target === status, ...(path === undefined ? {} : { path }) }
  })
}

/** ←/→:沿七态的次序,往左 / 往右找最近一个这一步走得通的章。 */
export function arrowTargets(status: TaskStatus): { prev?: TaskStatus, next?: TaskStatus } {
  const at = TASK_STATUSES.indexOf(status)
  const find = (step: 1 | -1): TaskStatus | undefined => {
    for (let i = at + step; i >= 0 && i < TASK_STATUSES.length; i += step) {
      const target = TASK_STATUSES[i] as TaskStatus
      if (canTransition(status, target).ok) return target
    }
    return undefined
  }
  const prev = find(-1)
  const next = find(1)
  return { ...(prev === undefined ? {} : { prev }), ...(next === undefined ? {} : { next }) }
}

export type WaitingItem =
  | { key: string, kind: 'note', task: TaskView, at: string }
  | { key: string, kind: 'proposal', proposal: SessionProposal, at: string }

/** 「现在等你」那一条:章是「等你」、且带四类拍板请求的便签按回执时间先后(没有回执按最后改动),会话挂目标的提议跟在后面。 */
export function waitingStrip(tasks: readonly TaskView[], proposals: readonly SessionProposal[]): WaitingItem[] {
  const notes = boardNotes(tasks)
    .filter(task => ownerAskOf(task) !== undefined)
    .map(task => ({ key: `note:${task.id}`, kind: 'note' as const, task, at: task.receipt?.at ?? task.updated_at }))
    .sort((a, b) => a.at.localeCompare(b.at))
  return [...notes, ...proposals.map(proposal => ({ key: `proposal:${proposal.agent}:${proposal.session_id}`, kind: 'proposal' as const, proposal, at: proposal.at }))]
}

/** 顶部筛选:每一维多选,维度之间是「且」。筛掉的便签变淡不消失。 */
export interface CollabFilter {
  project?: readonly string[]
  /** 事项类型(类型表里的 id)。 */
  type?: readonly string[]
  version?: readonly string[]
  module?: readonly string[]
  sprint?: readonly string[]
  assignee?: readonly string[]
  stamp?: readonly TaskStatus[]
  label?: readonly string[]
  /** `键=值`。 */
  prop?: readonly string[]
  /** 完成情况(卡片颜色那几档);图例点选与筛选行「进行中」都改这一份。 */
  progress?: readonly BoardProgress[]
}

export const FILTER_KEYS = ['project', 'type', 'version', 'module', 'sprint', 'assignee', 'stamp', 'label', 'prop'] as const
export type FilterKey = typeof FILTER_KEYS[number]
export const FILTER_TITLES: Readonly<Record<FilterKey, string>> = {
  project: '项目', type: '类型', version: '版本', module: '模块', sprint: '冲刺', assignee: '负责人', stamp: '章', label: '标签', prop: '属性',
}

function versionOf(task: TaskView, goals: readonly CollabGoal[]): string | undefined {
  return task.version ?? goals.find(one => one.id === task.goal_id)?.version
}

function sortedUnique(values: Iterable<string | undefined>): string[] {
  return [...new Set([...values].filter((one): one is string => one !== undefined && one !== ''))].sort((a, b) => a.localeCompare(b))
}

/** 每一维有哪些可选(从板上现有的便签里来,不列一个选了也什么都没有的值)。 */
export function filterOptions(tasks: readonly TaskView[], goals: readonly CollabGoal[], sprints: readonly CollabSprint[]): Record<FilterKey, string[]> {
  const notes = boardNotes(tasks)
  return {
    project: sortedUnique(notes.map(task => task.project_id)),
    type: sortedUnique(notes.map(task => workTypeOf(task))),
    version: sortedUnique(notes.map(task => versionOf(task, goals))),
    module: sortedUnique(notes.map(task => task.module)),
    sprint: sprints.map(one => one.id),
    assignee: sortedUnique(notes.map(task => boardAssignee(task.assignee))),
    stamp: TASK_STATUSES.filter(status => notes.some(task => task.status === status)),
    label: sortedUnique(notes.flatMap(task => task.labels ?? [])),
    prop: sortedUnique(notes.flatMap(task => Object.entries(task.props ?? {}).map(([key, value]) => `${key}=${value}`))),
  }
}

export function matchesFilter(task: TaskView, goals: readonly CollabGoal[], sprints: readonly CollabSprint[], filter: CollabFilter): boolean {
  const any = (picked: readonly string[] | undefined, values: readonly (string | undefined)[]): boolean =>
    picked === undefined || picked.length === 0 || values.some(one => one !== undefined && picked.includes(one))
  const sprintGoals = (filter.sprint ?? []).flatMap(id => sprints.find(one => one.id === id)?.goal_ids ?? [])
  return any(filter.project, [task.project_id])
    && any(filter.type, [workTypeOf(task)])
    && any(filter.version, [versionOf(task, goals)])
    && any(filter.module, [task.module])
    && (filter.sprint === undefined || filter.sprint.length === 0 || sprintGoals.includes(goalIdOf(task)))
    && any(filter.assignee, [boardAssignee(task.assignee)])
    && any(filter.stamp, [task.status])
    && any(filter.label, task.labels ?? [])
    && any(filter.prop, Object.entries(task.props ?? {}).map(([key, value]) => `${key}=${value}`))
    && any(filter.progress, [progressOf(task.status)])
}

/** 图例点一下 / 筛选行点一下:有就去掉、没有就加上;一档不剩就把这一项拿掉。 */
export function toggleProgress(filter: CollabFilter, kind: BoardProgress): CollabFilter {
  const { progress = [], ...rest } = filter
  const next = progress.includes(kind) ? progress.filter(one => one !== kind) : [...progress, kind]
  return next.length === 0 ? rest : { ...rest, progress: next }
}

/** 名片栏里的一张:你、本机登记表里的一家、或一张登记过的 Agent 名片。 */
export interface RailCard {
  id: string
  name: string
  kind: 'me' | 'agent' | 'card'
  online: boolean
  /** 现在在哪张便签上(小鼠标)。 */
  onNote?: string
  /** 名片的 hand(`cli` / `window`;老卡可能是登记表 id),见 {@link AgentCard.hand}。 */
  hand?: string
  /** 名片的命令行家与模型名(2026-10-22 卡 E:卡面显示这两格)。 */
  runtimeFamily?: string
  modelName?: string
  color?: string
  goodAt?: string
}

/**
 * 这张名片「是哪一家」:`runtime.family` 优先;老卡(没有 runtime)退回 `hand` 当登记表 id 读;
 * `hand` 已是新语义的 `cli` / `window` 而没有 runtime 时认不出来(缺席)。表单回填与列表显示都用它。
 */
export function cardFamilyOf(card: Pick<AgentCard, 'hand' | 'runtime'>): string | undefined {
  if (card.runtime?.family !== undefined && card.runtime.family !== '') return card.runtime.family
  return card.hand === 'cli' || card.hand === 'window' ? undefined : card.hand
}

/**
 * 名片栏:用户自己在最前,然后本机登记表里接上的几家(事务官自己不算一张名片),再是登记过的名片。
 * 用户那张写账号名(`meName`,见 client/meName.tsx),不写「你」。
 *
 * 名片的「在线」(hand 语义变化后,2026-10-22 卡「名片编辑表单重排」):
 * - `hand:'cli'` → 那家(`runtime.family`)体检 edit 格 `ok` 且 `via:'cli'`(探到了命令行);
 * - `hand:'window'` → 登记表里那家活着(`status !== 'unknown'`);
 * - 老卡(hand 是登记表 id)→ 照旧按登记表判。
 */
export function railCards(entries: readonly AgentEntryView[], cards: readonly AgentCard[], presence: readonly CollabPresence[], meName = ME_FALLBACK, agentCaps?: AgentCapsView): RailCard[] {
  const onNote = (id: string): string | undefined => presence.find(one => one.actor.kind === 'agent' && one.actor.id === id && one.state !== 'idle')?.on_note
  const entryAlive = (id: string | undefined): boolean => {
    if (id === undefined) return false
    const entry = entries.find(one => one.id === id)
    return entry !== undefined && entry.status !== 'unknown'
  }
  const cardOnline = (card: AgentCard): boolean => {
    if (card.hand === 'cli') {
      const family = card.runtime?.family
      const cap = family === undefined ? undefined : agentCaps?.agents.find(one => one.family === family)
      return cap !== undefined && cap.cells.edit.state === 'ok' && cap.cells.edit.via === 'cli'
    }
    if (card.hand === 'window') return entryAlive(card.runtime?.family)
    // 老卡:hand 是登记表 id,保持旧判法。
    return entryAlive(card.hand)
  }
  return [
    { id: 'me', name: meName, kind: 'me', online: true },
    ...entries.filter(entry => entry.self !== true && entry.id !== 'dsh').map((entry): RailCard => ({
      id: entry.id, name: entry.name, kind: 'agent', online: entry.status !== 'unknown',
      ...(onNote(entry.id) === undefined ? {} : { onNote: onNote(entry.id) as string }),
      ...(entry.color === undefined ? {} : { color: entry.color }),
    })),
    ...cards.map((card): RailCard => ({
      id: card.id, name: card.name, kind: 'card', online: cardOnline(card), hand: card.hand,
      ...(card.runtime?.family === undefined ? {} : { runtimeFamily: card.runtime.family }),
      ...(card.model?.name === undefined ? {} : { modelName: card.model.name }),
      ...(onNote(card.id) === undefined ? {} : { onNote: onNote(card.id) as string }),
      ...(card.good_at === undefined ? {} : { goodAt: card.good_at }),
    })),
  ]
}

/** 负责人怎么称呼(名片换成它的名字;其余同 protocol 的 `assigneeName`)。 */
export function assigneeLabel(assignee: TaskAssignee | undefined, cards: readonly RailCard[], fallback: (one: string | undefined) => string): string {
  const shown = boardAssignee(assignee)
  const card = cards.find(one => one.id === shown)
  return card?.name ?? fallback(shown)
}

/** 便签头上那一行花费:挂着的会话用量 + 事务官那一件的钱。**一样都取不到就缺席**(不写 0)。 */
export function noteCost(task: TaskView, sessionUsage: Readonly<Record<string, UsageTotals>>): string | undefined {
  const tokens = cardSpend(task, sessionUsage)
  const cny = task.budget?.spent_cny
  const parts = [
    ...(cny === undefined ? [] : [`¥${cny.toFixed(2)}`]),
    ...(tokens === undefined ? [] : [formatSpend(tokens)]),
  ]
  return parts.length === 0 ? undefined : parts.join(' · ')
}

/** 执行回放的来源:有记录文件的那几家(事务官 / Codex / Claude …)按会话回放;窗口型那几家如实说没有记录。 */
export interface ReplaySource {
  agent: string
  session_id?: string
  recorded: boolean
}

export function replaySources(task: TaskView): ReplaySource[] {
  const out: ReplaySource[] = []
  const seen = new Set<string>()
  const add = (agent: string, sessionId: string | undefined): void => {
    const recorded = (AGENT_IDS as readonly string[]).includes(agent) && sessionId !== undefined
    const key = recorded ? `${agent}:${sessionId as string}` : agent
    if (seen.has(key)) return
    seen.add(key)
    out.push({ agent, ...(recorded ? { session_id: sessionId as string } : {}), recorded })
  }
  if (task.conversation !== undefined) add('dsh', task.conversation.session_id)
  for (const link of task.links ?? []) add(link.agent, link.session_id)
  if (task.dispatch !== undefined) add(task.dispatch.family, task.dispatch.session_id)
  if (task.client_dispatch !== undefined) add(task.client_dispatch.family, task.client_dispatch.session_id)
  return out
}

/** 回执正文去掉开头那个「做完:/ 有异议:/ 卡住:」—— 便签上已经用章与标题说了是哪一种,不说两遍。 */
export function receiptBody(text: string): string {
  return text.trim().replace(/^(回执\s*[::]\s*)?(做完|完成了?|已完成|有异议|异议|不同意|卡住了?|阻塞|做不了|done|objection|blocked)\s*[::,,]?\s*/i, '').trim() || text.trim()
}
