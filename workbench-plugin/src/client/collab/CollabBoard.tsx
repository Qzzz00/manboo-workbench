import { groupFacts, isTaskGroup } from './taskGroup.ts'
/**
 * 协作区的画布(React Flow,`@xyflow/react` 12.11.6,MIT;待拍板 3 已定)。平移、缩放、小地图现成;
 * 自由画图、连线、文本编辑器第一版没有(设计稿第四节第 8 条)。
 *
 * 拖拽的两条规矩在这里:
 * - 拖便签:松手那一刻看落在哪块目标区 —— 别的区 = 改 `goal_id`(`/task/update`),区外 / 本区 = 只挪位置;**拖不改状态**;
 * - 拖目标区:区里的便签跟着一起挪(位置只存在 `.canvas` 里,不进账)。
 * 正在拖的时候不吃服务端那一秒一拍的快照(否则手里那张会被拽回去),松手再对齐。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { Node, NodeTypes } from '@xyflow/react'
import { Background, Controls, MiniMap, ReactFlow, ReactFlowProvider, useNodesInitialized, useNodesState, useReactFlow, useStore } from '@xyflow/react'
import type { CollabGoal, CollabPresence, TaskStatus, TaskView, WorkType } from '../../protocol.ts'
import type { Relation } from './peopleModel.ts'
import { UNSORTED_GOAL_ID, noteGaps } from '../../protocol.ts'
import type { BoardLayout, RailCard, StampChoice } from './collabModel.ts'
import { NOTE_H, NOTE_W, areaOf, boardNotes, goalAt, noteWidthFor, visiblePresence } from './collabModel.ts'
import { CursorNode, GoalNode, NoteNode, type CursorNodeData, type GoalNodeData, type NoteNodeData } from './nodes.tsx'
import { extractTaskWaitReason } from './progressModel.ts'
import { taskConditions } from './boardProgress.ts'
import { goalViewport } from './boardViewport.ts'

const NODE_TYPES: NodeTypes = { note: NoteNode, goal: GoalNode, cursor: CursorNode }

export interface CollabBoardProps {
  goals: readonly CollabGoal[]
  tasks: readonly TaskView[]
  layout: BoardLayout
  /** 这张便签没被筛掉。 */
  shown: (task: TaskView) => boolean
  presence: readonly CollabPresence[]
  cards: readonly RailCard[]
  assigneeText: (task: TaskView) => string
  typeOf: (task: TaskView) => WorkType | undefined
  /** 选中了某个头像时这张便签和他什么关系(没选中 = 不传,也不因此变淡)。 */
  relationOf?: ((task: TaskView) => Relation | undefined) | undefined
  goalOwner: (goal: CollabGoal) => string
  /** 打开目标条件面板。 */
  onConditions?: ((goal: CollabGoal) => void) | undefined
  /** 把板飞到这一点居中(「现在等你」点一下、详情里「在板上看」)。`at` 变了才飞。 */
  focus?: { x: number, y: number, at: number }
  /** 第一眼对准哪个目标(目标条上那一个);换了再对一次。 */
  fitGoalId?: string
  fullscreen?: boolean
  /** 看板可用宽(按宽增列、卡宽至多 370;缺席 = 260 老宽)。 */
  boardW?: number
  /** 来往条数(留言+评论);给了才画「来往」速览按钮。 */
  talkCountOf?: ((task: TaskView) => number) | undefined
  onQuickView?: ((task: TaskView) => void) | undefined
  nowMs?: number
  onLayout: (next: BoardLayout) => void
  onChangeGoal: (task: TaskView, goalId: string) => void
  onStamp: (task: TaskView, choice: StampChoice) => void
  onArrow: (task: TaskView, status: TaskStatus) => void
  onOpen: (task: TaskView) => void
}

export function CollabBoard(props: CollabBoardProps) {
  return (
    <ReactFlowProvider>
      <BoardInner {...props} />
    </ReactFlowProvider>
  )
}

/** 小鼠标停在便签右上角的哪儿。 */
function cursorSpot(pos: { x: number, y: number }): { x: number, y: number } {
  return { x: pos.x + NOTE_W - 24, y: pos.y - 12 }
}

function isValueEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a === 'function' && typeof b === 'function') return true
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) {
      if (!isValueEqual(a[i], b[i])) return false
    }
    return true
  }
  if (typeof a === 'object' && a !== null && typeof b === 'object' && b !== null) {
    const keysA = Object.keys(a as Record<string, unknown>)
    const keysB = Object.keys(b as Record<string, unknown>)
    if (keysA.length !== keysB.length) return false
    for (const k of keysA) {
      if (!isValueEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false
    }
    return true
  }
  return false
}

export function areNodesEqual(a: readonly Node[], b: readonly Node[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const na = a[i]
    const nb = b[i]
    if (na === undefined || nb === undefined) return false
    if (na.id !== nb.id || na.type !== nb.type) return false
    if (na.position.x !== nb.position.x || na.position.y !== nb.position.y) return false
    if (nb.width !== undefined && na.width !== nb.width) return false
    if (nb.height !== undefined && na.height !== nb.height) return false
    const da = (na.data ?? {}) as Record<string, unknown>
    const db = (nb.data ?? {}) as Record<string, unknown>
    if (!isValueEqual(da, db)) return false
  }
  return true
}

function mergeNodes(prev: readonly Node[], next: readonly Node[]): Node[] {
  const prevMap = new Map(prev.map(n => [n.id, n]))
  return next.map((n) => {
    const p = prevMap.get(n.id)
    if (p === undefined) return n
    const merged: Node = { ...n }
    const w = n.width ?? p.width
    const h = n.height ?? p.height
    const m = n.measured ?? p.measured
    if (w !== undefined) merged.width = w
    if (h !== undefined) merged.height = h
    if (m !== undefined) merged.measured = m
    return merged
  })
}

function BoardInner({ goals, tasks, layout, shown, presence, cards, assigneeText, typeOf, relationOf, goalOwner, onConditions, focus, fitGoalId, fullscreen, boardW, talkCountOf, onQuickView, nowMs, onLayout, onChangeGoal, onStamp, onArrow, onOpen }: CollabBoardProps) {
  const flow = useReactFlow()
  const noteW = noteWidthFor(boardW ?? 580)
  if (typeof window !== 'undefined') {
    (window as unknown as { __collabFlow?: typeof flow }).__collabFlow = flow
  }
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([])
  const dragging = useRef(false)
  const [over, setOver] = useState<string | undefined>(undefined)
  const goalStart = useRef<{ id: string, x: number, y: number, members: Record<string, { x: number, y: number }> } | undefined>(undefined)
  const notes = useMemo(() => boardNotes(tasks), [tasks])
  const known = useMemo(() => new Set(goals.map(one => one.id)), [goals])

  /** 小鼠标:有活的(滑过去 / 干活 / 盖章)才画;盖完章那一下之后滑走(界面上的动画,不是账上的事)。 */
  const [leaving, setLeaving] = useState<Record<string, number>>({})
  useEffect(() => {
    const stamping = presence.filter(one => one.state === 'stamping')
    if (stamping.length === 0) return undefined
    const timer = setTimeout(() => {
      setLeaving(prev => ({ ...prev, ...Object.fromEntries(stamping.map(one => [`${one.actor.kind}:${one.actor.kind === 'agent' ? one.actor.id : one.actor.account}`, Date.parse(one.at)])) }))
    }, 1400)
    return () => clearTimeout(timer)
  }, [presence])

  const built = useMemo((): Node[] => {
    const goalNodes: Node[] = goals.map((goal) => {
      const box = layout.goals[goal.id] ?? { x: 0, y: 0, w: 3 * NOTE_W, h: 44 }
      const members = notes.filter(task => areaOf(task, known) === goal.id)
      const data: GoalNodeData = {
        goal, count: members.length, done: members.filter(task => task.status === 'done').length, ownerText: goalOwner(goal),
        ...(onConditions === undefined ? {} : { onConditions }),
        over: over === goal.id, dim: members.length > 0 && members.every(task => !shown(task)),
      }
      return {
        id: `goal:${goal.id}`, type: 'goal', position: { x: box.x, y: box.y }, data,
        // 先给一个尺寸:React Flow 量到尺寸之前不画节点,给了初值第一帧就摆得出来(量到之后以量到的为准)。
        style: { width: box.w, height: box.h }, width: box.w, height: box.h, zIndex: 0, selectable: false, dragHandle: '.ben-cl__goal-head',
      }
    })
    const noteNodes: Node[] = notes.map((task) => {
      const pos = layout.notes[task.id] ?? { x: 0, y: 0 }
      const relation = relationOf?.(task)
      const data: NoteNodeData = {
        task, grouped: isTaskGroup(task), groupStatus: groupFacts(task, tasks).status, type: typeOf(task), dim: !shown(task) || (relationOf !== undefined && relation === undefined), relation,
        assigneeText: assigneeText(task), gaps: noteGaps(task),
        working: presence.some(one => one.on_note === task.id && one.state === 'working'),
        statusReason: extractTaskWaitReason(task),
        conditions: taskConditions(task, goals),
        ...(talkCountOf === undefined ? {} : { talkCount: talkCountOf(task) }),
        ...(onQuickView === undefined ? {} : { onQuickView }),
        onStamp, onArrow, onOpen,
      }
      return { id: `note:${task.id}`, type: 'note', position: pos, data, zIndex: 2, style: { width: noteW }, initialWidth: noteW, initialHeight: NOTE_H }
    })
    const activePresence = visiblePresence(presence, tasks, nowMs ?? Date.now())
    const cursorNodes: Node[] = activePresence.flatMap((one): Node[] => {
      if (one.actor.kind !== 'agent' || one.on_note === undefined || one.state === 'idle') return []
      const key = `agent:${one.actor.id}`
      if (leaving[key] === Date.parse(one.at)) return []
      const pos = layout.notes[one.on_note]
      if (pos === undefined) return []
      const actorId = (one.actor as { id: string }).id
      const card = cards.find(c => c.id === actorId || c.id === `agent:${actorId}`)
      const data: CursorNodeData = {
        actorId: `agent:${actorId}`,
        name: card?.name ?? actorId,
        ...(card?.color === undefined ? {} : { color: card.color }),
        state: one.state,
      }
      return [{ id: `cursor:${actorId}`, type: 'cursor', position: cursorSpot(pos), data, zIndex: 5, draggable: false, selectable: false, focusable: false, initialWidth: 140, initialHeight: 36 }]
    })
    return [...goalNodes, ...noteNodes, ...cursorNodes]
  }, [goals, notes, known, layout, shown, presence, tasks, nowMs, cards, assigneeText, typeOf, relationOf, goalOwner, onConditions, over, leaving, noteW, talkCountOf, onQuickView, onStamp, onArrow, onOpen])

  // 快照一拍一拍地来;正在拖的时候不吃(手里那张别被拽回去)。比较节点属性,无变化时不触发更新以消灭小地图闪烁。
  useEffect(() => {
    if (!dragging.current) {
      setNodes(prev => areNodesEqual(prev, built) ? prev : mergeNodes(prev, built))
    }
  }, [built, setNodes])

  // 第一眼:等所有节点量到尺寸、画布有了宽高再对焦(原来第一批节点一落下就 fitView,那时大多没量到,
  // 150 张卡的板会对到一张卡上、从顶上裁掉;量到了又把整板塞进一屏,卡缩到读不清)。现在对准目标条上那个目标,
  // 从它顶上开始、按宽度缩到放得下但不小于读得清的下限;高出的往下滚。换目标再对一次,其余时候由他自己平移缩放。
  const measured = useNodesInitialized()
  const areaW = useStore(store => store.width)
  const areaH = useStore(store => store.height)
  const fittedFor = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (!measured || areaW <= 0 || areaH <= 0 || nodes.length === 0) return
    const key = fitGoalId ?? '*'
    if (fittedFor.current === key) return
    fittedFor.current = key
    const goalNode = fitGoalId === undefined ? undefined : flow.getNode(`goal:${fitGoalId}`)
    if (goalNode === undefined) { void flow.fitView({ padding: 0.12, maxZoom: 1 }); return }
    void flow.setViewport(goalViewport(flow.getNodesBounds([goalNode]), { width: areaW, height: areaH }))
  }, [measured, areaW, areaH, nodes.length, fitGoalId, flow])

  useEffect(() => {
    if (focus === undefined) return
    void flow.setCenter(focus.x, focus.y, { zoom: Math.max(flow.getZoom(), 1), duration: 400 })
    // 只跟着「这一次要飞」走。
  }, [focus?.at])

  return (
    <ReactFlow
      className="ben-cl__flow"
      nodes={nodes}
      edges={[]}
      nodeTypes={NODE_TYPES}
      onNodesChange={onNodesChange}
      minZoom={0.2}
      maxZoom={2}
      panOnScroll
      proOptions={{ hideAttribution: true }}
      nodesConnectable={false}
      elementsSelectable={false}
      deleteKeyCode={null}
      onNodeDragStart={(_event, node) => {
        dragging.current = true
        if (node.type === 'goal') {
          const id = node.id.slice('goal:'.length)
          const members = Object.fromEntries(notes.filter(task => areaOf(task, known) === id).map(task => [task.id, layout.notes[task.id] ?? { x: 0, y: 0 }]))
          goalStart.current = { id, x: node.position.x, y: node.position.y, members }
        }
      }}
      onNodeDrag={(_event, node) => {
        if (node.type === 'note') {
          setOver(goalAt({ x: node.position.x + noteW / 2, y: node.position.y + NOTE_H / 2 }, layout))
          return
        }
        const start = goalStart.current
        if (node.type !== 'goal' || start === undefined) return
        const dx = node.position.x - start.x
        const dy = node.position.y - start.y
        // 区里的便签跟着走。
        setNodes(list => list.map((one) => {
          const id = one.id.startsWith('note:') ? one.id.slice('note:'.length) : undefined
          const from = id === undefined ? undefined : start.members[id]
          return from === undefined ? one : { ...one, position: { x: from.x + dx, y: from.y + dy } }
        }))
      }}
      onNodeDragStop={(_event, node) => {
        dragging.current = false
        setOver(undefined)
        if (node.type === 'note') {
          const id = node.id.slice('note:'.length)
          const task = notes.find(one => one.id === id)
          const next: BoardLayout = { goals: { ...layout.goals }, notes: { ...layout.notes, [id]: { x: node.position.x, y: node.position.y } } }
          onLayout(next)
          const target = goalAt({ x: node.position.x + noteW / 2, y: node.position.y + NOTE_H / 2 }, layout)
          if (task !== undefined && target !== undefined && target !== areaOf(task, known)) onChangeGoal(task, target)
          return
        }
        const start = goalStart.current
        goalStart.current = undefined
        if (node.type !== 'goal' || start === undefined) return
        const dx = node.position.x - start.x
        const dy = node.position.y - start.y
        const box = layout.goals[start.id]
        const moved = Object.fromEntries(Object.entries(start.members).map(([id, pos]) => [id, { x: pos.x + dx, y: pos.y + dy }]))
        onLayout({
          goals: { ...layout.goals, ...(box === undefined ? {} : { [start.id]: { ...box, x: node.position.x, y: node.position.y } }) },
          notes: { ...layout.notes, ...moved },
        })
      }}
    >
      <Background gap={28} size={1} />
      {fullscreen === true && (
        <MiniMap
          position="top-right"
          pannable
          zoomable
          ariaLabel="板的小地图"
          nodeColor={n => n.type === 'cursor' ? 'transparent' : '#3a3a3a'}
          nodeStrokeColor={n => n.type === 'cursor' ? 'transparent' : '#555555'}
          nodeClassName={n => n.type === 'cursor' ? 'ben-cl__minimap-cursor-hide' : ''}
          maskColor="rgba(0,0,0,0.55)"
          bgColor="#141414"
        />
      )}
      <Controls showInteractive={false} />
    </ReactFlow>
  )
}

/** 拖到「未归目标」那块 = 把目标摘掉(账上 goal_id 清空),不写一个假的目标 id 进去。 */
export function goalIdForUpdate(target: string): string | null {
  return target === UNSORTED_GOAL_ID ? null : target
}
