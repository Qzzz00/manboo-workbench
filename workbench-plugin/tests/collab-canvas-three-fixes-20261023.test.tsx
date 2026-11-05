/**
 * 卡: 协作区画布三处 (2026-10-23, agy/协作区画布三处)
 * 一、小地图只在全屏显示
 * 二、Agent 光标会过期、够大
 * 三、缩放控件被横线挡
 * 四、没有目标的卡别画进第一个目标框
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { UNSORTED_GOAL_ID, goalIdOf, type CollabGoal, type CollabPresence, type TaskView } from '../src/protocol.ts'

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as never
import {
  autoLayout,
  boardGoals,
  goalAt,
  isAgentCursorVisible,
  visiblePresence,
  AGENT_CURSOR_EXPIRE_MS,
  NOTE_W,
  NOTE_H,
} from '../src/client/collab/collabModel.ts'
import { CollabBoard, areNodesEqual } from '../src/client/collab/CollabBoard.tsx'
import { CollabZone } from '../src/client/collab/CollabZone.tsx'
import { CursorNode } from '../src/client/collab/nodes.tsx'
import { PeopleProvider, type PeopleCtx } from '../src/client/collab/people.tsx'
import { COLLAB_STYLE } from '../src/client/collab/collabStyle.ts'
import { placeSession } from '../src/server/collabRoutes.ts'
import { createTasksService } from '../src/server/tasks.ts'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const NOW_ISO = '2026-10-23T10:00:00.000Z'
const NOW_MS = Date.parse(NOW_ISO)

const goal = (id: string, partial: Partial<CollabGoal> = {}): CollabGoal => ({
  id, title: id, owner: 'me', status: 'open', created_at: '2026-10-21T00:00:00.000Z', updated_at: '2026-10-21T00:00:00.000Z', ...partial,
})

const note = (id: string, partial: Partial<Omit<TaskView, 'goal_id'>> & { goal_id?: string | null } = {}): TaskView => ({
  id, title: id, status: 'doing', origin: 'user', created_at: '2026-10-21T00:00:00.000Z', updated_at: '2026-10-21T00:00:00.000Z',
  source: { kind: 'manual' }, from: { kind: 'user' }, acceptance: ['做到'], ...(partial as Partial<TaskView>),
})

const agentPresence = (id: string, partial: Partial<CollabPresence> = {}): CollabPresence => ({
  actor: { kind: 'agent', id },
  on_note: 't-1',
  state: 'working',
  at: NOW_ISO,
  ...partial,
})

const baseBoardProps = {
  goals: [goal('g-1', { title: '目标一' })],
  tasks: [note('t-1', { goal_id: 'g-1' })],
  layout: { goals: { 'g-1': { x: 0, y: 0, w: 400, h: 200 } }, notes: { 't-1': { x: 20, y: 50 } } },
  shown: () => true,
  presence: [],
  cards: [],
  assigneeText: () => '某人',
  typeOf: () => undefined,
  goalOwner: () => 'me',
  onLayout: () => {},
  onChangeGoal: () => {},
  onStamp: () => {},
  onArrow: () => {},
  onOpen: () => {},
}

describe('一、小地图只在全屏显示', () => {
  it('组件模式/非全屏(fullscreen=false 或缺省)不渲染小地图', () => {
    const { unmount } = render(<CollabBoard {...baseBoardProps} fullscreen={false} />)
    expect(screen.queryByLabelText('板的小地图')).toBeNull()
    unmount()

    render(<CollabBoard {...baseBoardProps} />)
    expect(screen.queryByLabelText('板的小地图')).toBeNull()
  })

  it('全屏模式(fullscreen=true)渲染小地图', () => {
    render(<CollabBoard {...baseBoardProps} fullscreen={true} />)
    expect(screen.getByLabelText('板的小地图')).toBeInTheDocument()
  })
})

describe('二、Agent 光标会过期、够大', () => {
  it('常量 AGENT_CURSOR_EXPIRE_MS 为 60 秒', () => {
    expect(AGENT_CURSOR_EXPIRE_MS).toBe(60_000)
  })

  it('Agent 光标 60 秒无事件后不在 presence 可见列表里', () => {
    const tasks = [note('t-1', { status: 'doing' })]
    const pFresh = agentPresence('kimi', { at: new Date(NOW_MS - 30_000).toISOString() })
    const pExpired = agentPresence('kimi-old', { at: new Date(NOW_MS - 61_000).toISOString() })
    const pBoundary = agentPresence('kimi-60s', { at: new Date(NOW_MS - 60_000).toISOString() })

    expect(isAgentCursorVisible(pFresh, tasks, NOW_MS)).toBe(true)
    expect(isAgentCursorVisible(pExpired, tasks, NOW_MS)).toBe(false)
    expect(isAgentCursorVisible(pBoundary, tasks, NOW_MS)).toBe(true)

    const visible = visiblePresence([pFresh, pExpired, pBoundary], tasks, NOW_MS)
    expect(visible.map(p => (p.actor as { id: string }).id)).toEqual(['kimi', 'kimi-60s'])
  })

  it('负责的卡不在「在做」(doing)时, Agent 光标收掉', () => {
    const tTodo = note('t-todo', { status: 'todo' })
    const tDone = note('t-done', { status: 'done' })
    const tConfirm = note('t-confirm', { status: 'confirm' })
    const tDoing = note('t-doing', { status: 'doing' })
    const allTasks = [tTodo, tDone, tConfirm, tDoing]

    const pTodo = agentPresence('kimi', { on_note: 't-todo', at: NOW_ISO })
    const pDone = agentPresence('kimi', { on_note: 't-done', at: NOW_ISO })
    const pConfirm = agentPresence('kimi', { on_note: 't-confirm', at: NOW_ISO })
    const pDoing = agentPresence('kimi', { on_note: 't-doing', at: NOW_ISO })

    expect(isAgentCursorVisible(pTodo, allTasks, NOW_MS)).toBe(false)
    expect(isAgentCursorVisible(pDone, allTasks, NOW_MS)).toBe(false)
    expect(isAgentCursorVisible(pConfirm, allTasks, NOW_MS)).toBe(false)
    expect(isAgentCursorVisible(pDoing, allTasks, NOW_MS)).toBe(true)
  })

  it('人的光标不按 60s/在做 规则收掉', () => {
    const human: CollabPresence = {
      actor: { kind: 'member', account: 'ben' },
      state: 'idle',
      at: new Date(NOW_MS - 120_000).toISOString(),
    }
    expect(isAgentCursorVisible(human, [], NOW_MS)).toBe(true)
  })

  it('CursorNode 带头像标签同一规格(包含家的 logo / AvatarFace 与名字)', () => {
    const peopleCtx: PeopleCtx = {
      cards: [{ id: 'agent:kimi', name: 'Kimi 代码助手', kind: 'agent', hand: 'kimi', color: '#16a34a', online: true }],
      avatars: {},
      baseUrl: 'http://127.0.0.1:8791',
      selected: undefined,
      onSelect: () => {},
    }
    const { container } = render(
      <PeopleProvider value={peopleCtx}>
        <CursorNode
          data={{
            actorId: 'agent:kimi',
            name: 'Kimi 代码助手',
            color: '#16a34a',
            state: 'working',
          }}
          id="cursor:kimi"
          type="cursor"
          selected={false}
          zIndex={5}
          isConnectable={false}
          positionAbsoluteX={0}
          positionAbsoluteY={0}
          dragging={false}
          draggable={false}
          selectable={false}
          deletable={false}
        />
      </PeopleProvider>,
    )

    const cursor = container.querySelector('.ben-cl__cursor')
    expect(cursor).toBeInTheDocument()
    // 包含头像标签规格: AvatarFace + 名字
    const tag = container.querySelector('.ben-cl__cursor-tag')
    expect(tag).toBeInTheDocument()
    expect(tag?.textContent).toContain('Kimi 代码助手')
    const avatar = tag?.querySelector('.ben-cl__avatar')
    expect(avatar).toBeInTheDocument()

    // 校验 CSS 规范: 高度 28px、头像 22px、缩放容器
    expect(COLLAB_STYLE).toContain('min-height:28px')
    expect(COLLAB_STYLE).toContain('.ben-cl__cursor-tag .ben-cl__avatar{width:22px;height:22px}')
    expect(COLLAB_STYLE).toContain('.ben-cl__cursor-scale{position:relative;display:inline-block;pointer-events:none}')

    // 缩放容器包裹 cursor 节点，默认 zoom=1 时 scale(1)
    const scaleWrapper = container.querySelector('.ben-cl__cursor-scale')
    expect(scaleWrapper).toBeInTheDocument()
    expect(scaleWrapper?.getAttribute('style')).toContain('scale(1)')
  })

  it('areNodesEqual: 深度比较属性, 忽略 React Flow 测量尺寸变化, 阻止每秒无害触发 setNodes', () => {
    const prevNote = {
      id: 'note:t-1',
      type: 'note',
      position: { x: 20, y: 50 },
      width: 240, // React Flow measured dimension
      height: 142,
      data: {
        task: note('t-1', { title: '同标题' }),
        gaps: [],
        working: false,
      },
    }
    const nextNote = {
      id: 'note:t-1',
      type: 'note',
      position: { x: 20, y: 50 },
      // 新 built 节点尚未测量，width/height 为 undefined
      width: undefined,
      height: undefined,
      data: {
        task: note('t-1', { title: '同标题' }), // 新对象引用，但内容相同
        gaps: [], // 新数组引用，但内容相同
        working: false,
      },
    }

    // 属性实质相同，应返回 true
    expect(areNodesEqual([prevNote as never], [nextNote as never])).toBe(true)

    // 属性发生实质变化 (标题改了)，应返回 false
    const changedNote = {
      ...nextNote,
      data: {
        ...nextNote.data,
        task: note('t-1', { title: '新标题' }),
      },
    }
    expect(areNodesEqual([prevNote as never], [changedNote as never])).toBe(false)
  })
})

describe('三、缩放控件被横线挡', () => {
  it('CSS 规则: 缩放控件抬高留出间距, 画布容器有相对定位与完整高度', () => {
    // 根因是 controls 之前基于 .ben-cl 绝对定位骑在底线上
    // 改法: .ben-cl__flow 设置 position:relative 且 flex:1, controls 定位到 bottom:12px;left:16px;margin:0
    expect(COLLAB_STYLE).toContain('.ben-cl__flow{position:relative;width:100%;height:100%;flex:1;min-height:0;background:var(--cl-canvas)}')
    expect(COLLAB_STYLE).toContain('.ben-cl .react-flow__controls{box-shadow:none;bottom:12px;left:16px;margin:0;z-index:10}')
  })

  it('DOM 结构: 缩放控件严格包裹于 .ben-cl__board 内部, 底条独立于 .ben-cl__main 之外', () => {
    const { container } = render(
      <div className="ben-cl" style={{ position: 'relative', width: 800, height: 600 }}>
        <div className="ben-cl__main" style={{ flex: 1, display: 'flex', minHeight: 0 }}>
          <div className="ben-cl__board" style={{ flex: 1, position: 'relative', minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
            <CollabBoard {...baseBoardProps} fullscreen={false} />
          </div>
        </div>
        <div className="ben-cl__foot">
          <button type="button">未排时间 1</button>
        </div>
      </div>,
    )

    const foot = container.querySelector('.ben-cl__foot') as HTMLElement
    expect(foot).toBeInTheDocument()
    const controls = container.querySelector('.react-flow__controls') as HTMLElement
    expect(controls).toBeInTheDocument()

    // 控件必须位于 board / main 容器内部, 不与底条处于同级容器
    expect(controls.closest('.ben-cl__board')).toBeInTheDocument()
    expect(controls.closest('.ben-cl__main')).toBeInTheDocument()
    expect(foot.closest('.ben-cl__main')).toBeNull()

    // 验证 controls 按钮完整可点击
    const buttons = controls.querySelectorAll('button')
    expect(buttons.length).toBe(3) // zoomin, zoomout, fitview
    for (const btn of buttons) {
      fireEvent.click(btn)
    }
  })
})

describe('四、没有目标的卡别画进第一个目标框', () => {
  it('goalIdOf: 空串、空白、null、undefined 与 goal:unsorted 同样处理, 都回 goal:unsorted', () => {
    expect(goalIdOf(note('n1'))).toBe(UNSORTED_GOAL_ID)
    expect(goalIdOf(note('n2', { goal_id: '' }))).toBe(UNSORTED_GOAL_ID)
    expect(goalIdOf(note('n3', { goal_id: '   ' }))).toBe(UNSORTED_GOAL_ID)
    expect(goalIdOf(note('n4', { goal_id: null }))).toBe(UNSORTED_GOAL_ID)
    expect(goalIdOf(note('n5', { goal_id: UNSORTED_GOAL_ID }))).toBe(UNSORTED_GOAL_ID)
  })

  it('autoLayout: 没有 goal_id 的卡进「未归目标」, 绝不画进第一个目标框', () => {
    const hardwareGoal = goal('g-hardware', { title: '研究座机拓展坞硬件方案' })
    const sessionCards = [
      note('s-1', { title: '统筹 1021' }),
      note('s-2', { title: 'ai-memory', goal_id: '' }),
      note('s-3', { title: '发版底座' }),
    ]
    const goals = boardGoals([hardwareGoal], sessionCards)
    const layout = autoLayout(goals, sessionCards, { goals: {}, notes: {} })

    // 1. 未归目标框必须存在
    expect(layout.goals[UNSORTED_GOAL_ID]).toBeDefined()

    // 2. 三张会话卡必须全部在未归目标框内, 绝不能在硬件目标框内
    for (const card of sessionCards) {
      const pos = layout.notes[card.id]
      expect(pos).toBeDefined()
      const inArea = goalAt({ x: pos!.x + NOTE_W / 2, y: pos!.y + NOTE_H / 2 }, layout)
      expect(inArea).toBe(UNSORTED_GOAL_ID)
      expect(inArea).not.toBe('g-hardware')
    }
  })

  it('会话回流建卡时直接写 goal:unsorted', async () => {
    const file = join(tmpdir(), `test-tasks-collab-three-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
    let n = 0
    const tasks = createTasksService({ file, now: () => 1729600000, newId: () => `t-${++n}` })

    const placed = await placeSession(tasks, {
      agent: 'codex',
      sessionId: 'sess-test-1',
      body: { title: '统筹 1021' },
    })

    expect(placed.ok).toBe(true)
    if (placed.ok) {
      expect(placed.goalId).toBe(UNSORTED_GOAL_ID)
      const list = await tasks.list()
      const createdCard = list.tasks.find(t => t.id === placed.id)
      expect(createdCard).toBeDefined()
      expect(createdCard?.goal_id).toBe(UNSORTED_GOAL_ID)
    }
  })
})
