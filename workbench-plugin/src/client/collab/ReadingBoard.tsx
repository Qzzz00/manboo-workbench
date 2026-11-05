/**
 * 目标视图的**阅读模式**(2026-10-24,小K collab-desktop-1024;设计 3.3「组件阅读」):
 * 固定阅读字号、普通纵向滚动、目标分区、卡片网格按宽增列(260–370,不拉长卡)。
 * 没有画布的拖动/缩放 —— 挪目标、改归属是画布(全屏)那一份的事;这一份只管读和点。
 * 卡片、目标头与画布同一份组件(nodes.tsx),同源不两套。
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { NodeProps } from '@xyflow/react'
import type { CollabGoal, CollabPresence, TaskView, WorkType } from '../../protocol.ts'
import { noteGaps } from '../../protocol.ts'
import type { Relation } from './peopleModel.ts'
import { UNSORTED_GOAL_ID } from '../../protocol.ts'
import type { RailCard, StampChoice } from './collabModel.ts'
import { areaOf, boardNotes } from './collabModel.ts'
import type { NoteNodeData } from './nodes.tsx'
import { GoalHead, NoteNode } from './nodes.tsx'
import { extractTaskWaitReason } from './progressModel.ts'
import { taskConditions } from './boardProgress.ts'
import { groupFacts, isTaskGroup } from './taskGroup.ts'
import { readingScrollTop } from './boardViewport.ts'
import { BOARD_PROGRESS_TITLES, type BoardProgress, progressOf } from './boardProgress.ts'

/** 按完成情况筛得一张不剩时那一句。 */
export const PROGRESS_EMPTY_TEXT = (titles: readonly string[]): string => `没有${titles.map(one => `「${one}」`).join('、')}的事项。再点一下图例里按下的颜色就取消筛选。`

/** 会让阅读区滚动的按键。 */
const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '])

export interface ReadingBoardProps {
  goals: readonly CollabGoal[]
  tasks: readonly TaskView[]
  /** 这张便签没被筛掉。 */
  shown: (task: TaskView) => boolean
  cards: readonly RailCard[]
  assigneeText: (task: TaskView) => string
  typeOf: (task: TaskView) => WorkType | undefined
  /** 选中了某个头像时这张便签和他什么关系(没选中 = 不传,也不因此变淡)。 */
  relationOf?: ((task: TaskView) => Relation | undefined) | undefined
  goalOwner: (goal: CollabGoal) => string
  /** 打开目标条件面板。 */
  onConditions?: ((goal: CollabGoal) => void) | undefined
  presence?: readonly CollabPresence[] | undefined
  /** 来往条数(留言+评论);给了才画「来往」速览按钮。 */
  talkCountOf?: ((task: TaskView) => number) | undefined
  onQuickView?: ((task: TaskView) => void) | undefined
  focusNote?: { id: string, at: number } | undefined
  /** 目标条上那个目标:区域滚到它那一节的头,没动过手之前一直对着它(上面几节后量到高度也不跑)。 */
  currentGoalId?: string | undefined
  /** 只看这几种完成情况(图例点选 / 筛选行);给了就把别的卡藏起来、没卡的目标整节不画。 */
  progress?: readonly BoardProgress[] | undefined
  onStamp: (task: TaskView, choice: StampChoice) => void
  onArrow: (task: TaskView, status: import('../../protocol.ts').TaskStatus) => void
  onOpen: (task: TaskView) => void
}

export function ReadingBoard({ goals, tasks, shown, cards, assigneeText, typeOf, relationOf, goalOwner, onConditions, presence, talkCountOf, onQuickView, onStamp, onArrow, onOpen, focusNote, currentGoalId, progress }: ReadingBoardProps) {
  const picking = progress !== undefined && progress.length > 0
  const picked = (task: TaskView): boolean => !picking || progress.includes(progressOf(task.status))
  const notes = useMemo(() => boardNotes(tasks), [tasks])
  const known = useMemo(() => new Set(goals.map(one => one.id)), [goals])
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  // 窄窗里画布换成这一份,区域只剩一两百像素高;停在哪全凭上次滚到哪,当前目标的卡头常被裁在上沿外。
  // 现在跟当前目标:换目标对一次;他没动过之前,每次渲染、每次哪一节量出新高度都再对一次(数据晚到、上面几节变高时不跑偏)。
  // 「动过」只认他真的动手:滚轮、触摸拖、翻页类按键、按在滚动条上,或点卡要看它(focusNote)。
  // 不认 scrollTop 变了 —— 浏览器滚动锚定、恢复滚动位都会改它,那不是他动的。
  const region = useRef<HTMLDivElement>(null)
  const moved = useRef(false)
  const lastGoal = useRef<string | undefined>(undefined)
  const align = useRef<() => void>(() => {})
  align.current = () => {
    const el = region.current
    if (el === null || currentGoalId === undefined || moved.current) return
    const section = document.getElementById(`ben-cl-goal-${currentGoalId}`)
    if (section === null || !el.contains(section)) return
    const next = readingScrollTop({ sectionTop: section.getBoundingClientRect().top, regionTop: el.getBoundingClientRect().top, scrollTop: el.scrollTop })
    if (Math.abs(next - el.scrollTop) > 0.5) el.scrollTop = next
  }
  useLayoutEffect(() => {
    if (lastGoal.current !== currentGoalId) { lastGoal.current = currentGoalId; moved.current = false }
    align.current()
  })
  useLayoutEffect(() => {
    const el = region.current
    if (el === null || typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(() => align.current())
    for (const section of el.children) observer.observe(section)
    return () => observer.disconnect()
  }, [goals])
  const handMoved = (): void => { moved.current = true }
  const onKey = (event: React.KeyboardEvent): void => { if (SCROLL_KEYS.has(event.key)) handMoved() }
  // 按在滚动条上:落点在内容宽(clientWidth)之外。
  const onPointer = (event: React.PointerEvent<HTMLDivElement>): void => {
    const el = event.currentTarget
    if (event.clientX - el.getBoundingClientRect().left >= el.clientWidth) handMoved()
  }
  useEffect(() => {
    if (focusNote === undefined) return
    const ancestors = new Set<string>()
    const visit = (id: string): void => { for (const task of notes) if (task.children?.includes(id) && !ancestors.has(task.id)) { ancestors.add(task.id); visit(task.id) } }
    visit(focusNote.id)
    moved.current = true
    setCollapsed(previous => new Set([...previous].filter(id => !ancestors.has(id))))
    const timer = requestAnimationFrame(() => { Array.from(document.querySelectorAll<HTMLElement>('[data-note-id]')).find(el => el.dataset.noteId === focusNote.id)?.scrollIntoView?.({ block: 'center', behavior: 'smooth' }) })
    return () => cancelAnimationFrame(timer)
  }, [focusNote, notes])
  const dataOf = (task: TaskView, extra: Partial<NoteNodeData> = {}): NoteNodeData => {
    const relation = relationOf?.(task)
    return {
      task,
      grouped: isTaskGroup(task),
      groupStatus: groupFacts(task, tasks).status,
      type: typeOf(task),
      dim: !shown(task) || (relationOf !== undefined && relation === undefined),
      ...(relation === undefined ? {} : { relation }),
      assigneeText: assigneeText(task),
      gaps: noteGaps(task),
      working: (presence ?? []).some(one => one.on_note === task.id && one.state === 'working'),
      statusReason: extractTaskWaitReason(task),
      conditions: taskConditions(task, goals),
      ...(talkCountOf === undefined ? {} : { talkCount: talkCountOf(task) }),
      ...(onQuickView === undefined ? {} : { onQuickView }),
      ...extra,
      onStamp, onArrow, onOpen,
    }
  }
  const cardOf = (task: TaskView, extra?: Partial<NoteNodeData>) => (
    <NoteNode key={task.id} {...({ data: dataOf(task, extra) } as unknown as NodeProps)} />
  )
  return (
    <div ref={region} className="ben-cl__reading" role="region" aria-label="目标阅读区" data-empty={goals.length === 0} onWheel={handMoved} onTouchMove={handMoved} onKeyDown={onKey} onPointerDown={onPointer}>
      {goals.map((goal) => {
        // 头上的件数 / 做完数照这个目标全部算;卡只摆筛中的。
        const all = notes.filter(task => areaOf(task, known) === goal.id)
        const members = all.filter(picked)
        if (picking && members.length === 0) return null
        const done = all.filter(task => task.status === 'done').length
        const dim = members.length > 0 && members.every(task => !shown(task))
        return (
          <section key={goal.id} id={`ben-cl-goal-${goal.id}`} className="ben-cl__rgoal" data-unsorted={goal.id === UNSORTED_GOAL_ID} data-status={goal.status} data-dim={dim} data-empty={members.length === 0} aria-label={`目标 ${goal.title}`}>
            <GoalHead goal={goal} count={all.length} done={done} ownerText={goalOwner(goal)} onConditions={onConditions} />
            {members.length > 0 && (
              <div className="ben-cl__rgrid" data-note-id-list={members.map(one => one.id).join(' ')}>
                {(() => {
                  // 仅同目标的父子边参与嵌套；跨目标的子事在其实际目标作根，不消失。
                  const parents = new Set(members.flatMap(parent => (parent.children ?? []).filter(id => members.some(child => child.id === id))))
                  const visited = new Set<string>()
                  const renderTask = (task: TaskView): React.ReactNode => {
                    if (visited.has(task.id)) return null
                    visited.add(task.id)
                    if (!isTaskGroup(task)) return cardOf(task)
                    const kids = members.filter(one => task.children?.includes(one.id) && !visited.has(one.id))
                    const elsewhere = notes.filter(one => task.children?.includes(one.id) && areaOf(one, known) !== goal.id)
                    const facts = groupFacts(task, tasks)
                    const closed = collapsed.has(task.id)
                    return <div key={task.id} className="ben-cl__rgroup" data-group={task.id}>
                      {cardOf(task)}
                      <small className="ben-cl__muted">子事 {facts.total} 件 · 完成度 {facts.done}/{facts.total} · 父组完成从子卡汇总{facts.unknown ? ' · 部分子事未知' : ''}</small>
                      <button type="button" aria-label={`${closed ? '展开子事' : '收起子事'} · ${task.title}`} aria-expanded={!closed} onClick={() => setCollapsed(previous => { const next = new Set(previous); if (closed) next.delete(task.id); else next.add(task.id); return next })}>{closed ? '展开子事' : '收起子事'}</button>
                      <div className="ben-cl__rgroup-kids" hidden={closed}>
                        <div className="ben-cl__rgroup-grid">{kids.map(renderTask)}</div>
                        {elsewhere.map(child => <button key={child.id} type="button" className="ben-cl__link" onClick={() => onOpen(child)}>查看其他目标子事 · {child.title}</button>)}
                      </div>
                    </div>
                  }
                  const roots = members.filter(one => !parents.has(one.id)).map(renderTask)
                  // 异常环或多父引用也保持每张真实事项可定位，不额外复制卡。
                  return [...roots, ...members.filter(one => !visited.has(one.id)).map(renderTask)]
                })()}
              </div>
            )}
          </section>
        )
      })}
      {goals.length === 0 && <p className="ben-cl__muted ben-cl__rgoal-empty">板上还没有目标。</p>}
      {goals.length > 0 && picking && !notes.some(task => known.has(areaOf(task, known)) && picked(task)) && (
        <p className="ben-cl__muted ben-cl__rgoal-empty" role="status">{PROGRESS_EMPTY_TEXT(progress.map(kind => BOARD_PROGRESS_TITLES[kind]))}</p>
      )}
    </div>
  )
}
