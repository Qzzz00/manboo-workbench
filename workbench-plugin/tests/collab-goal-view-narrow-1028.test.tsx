// 协作区「目标」视图窄窗退修(2026-10-28 17:0x 真机,窗口约 785×766):
// ① 窄窗里目标视图走的是阅读模式(不是画布),当前目标那一节从区域顶上裁掉、只露卡的下半截 —— 阅读区不跟当前目标走;
// ② 协作区这一格外沿是直角,同屏其他小组件是圆角 —— 格子里那块铺满的协作区盖住了卡的圆角;
// ③ 目标里 0 件进行中、轨迹又慢时,轨迹那一栏只有一行字,下面大片空白 —— 已完成的事项也该先摆出来。
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { CollabGoal, CollabPresence, TaskView, WorkbenchState } from '../src/protocol.ts'
import { CollabZone } from '../src/client/collab/CollabZone.tsx'
import type { CollabApi } from '../src/client/collab/collabApi.ts'
import { ReadingBoard, type ReadingBoardProps } from '../src/client/collab/ReadingBoard.tsx'
import { GOAL_VIEW_PAD, readingScrollTop } from '../src/client/collab/boardViewport.ts'
import { TraceRail } from '../src/client/collab/TraceRail.tsx'
import { MONO_STYLE } from '../src/client/monoStyle.ts'

afterEach(() => { cleanup(); localStorage.clear() })
beforeAll(() => { globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as never })
const AT = '2026-10-28T09:00:00.000Z'
const goal = (id: string, title: string): CollabGoal => ({ id, title, owner: 'me', status: 'open', created_at: AT, updated_at: AT }) as CollabGoal
const task = (id: string, goalId: string, patch: Partial<TaskView> = {}): TaskView => ({ id, title: `事项-${id}`, status: 'todo', source: { kind: 'manual' }, created_at: AT, updated_at: AT, goal_id: goalId, ...patch })
const goals = [goal('g1', '座机出门也能接'), goal('g2', '周五发样片'), goal('g3', '研究座机拓展坞硬件方案')]
const tasks = [task('a', 'g1'), task('b', 'g1'), task('c', 'g2'), task('d', 'g3', { status: 'done', title: '列三种拓展坞方案' })]

/** 阅读区顶在视口 100px;三节在内容里的位置 16 / 400 / 900(随 scrollTop 上移)。 */
const OFFSETS: Record<string, number> = { 'ben-cl-goal-g1': 16, 'ben-cl-goal-g2': 400, 'ben-cl-goal-g3': 900 }
function layOut(): HTMLElement {
  const region = screen.getByRole('region', { name: '目标阅读区' })
  const box = (top: number) => ({ top, bottom: top + 300, left: 0, right: 700, width: 700, height: 300, x: 0, y: top, toJSON: () => ({}) }) as DOMRect
  region.getBoundingClientRect = () => box(100)
  for (const section of region.querySelectorAll<HTMLElement>('section[id]')) {
    section.getBoundingClientRect = () => box(100 + (OFFSETS[section.id] ?? 0) - region.scrollTop)
  }
  return region
}
const props = (patch: Partial<ReadingBoardProps> = {}): ReadingBoardProps => ({
  goals, tasks, shown: () => true, cards: [], assigneeText: () => '我', typeOf: () => undefined, goalOwner: () => '我',
  onStamp: () => {}, onArrow: () => {}, onOpen: () => {}, ...patch,
})

describe('readingScrollTop(纯函数)', () => {
  it('把那一节的顶对到区域顶下 GOAL_VIEW_PAD;已经在上面时不出负数', () => {
    expect(readingScrollTop({ sectionTop: 1000, regionTop: 100, scrollTop: 0 })).toBe(900 - GOAL_VIEW_PAD)
    expect(readingScrollTop({ sectionTop: 110, regionTop: 100, scrollTop: 0 })).toBe(0)
    expect(readingScrollTop({ sectionTop: 50, regionTop: 100, scrollTop: 300 })).toBe(250 - GOAL_VIEW_PAD)
  })
})

describe('窄窗阅读区跟着当前目标走', () => {
  it('★当前目标是第三节:那一节的头对到区域顶上(不再停在随便哪儿、裁掉卡头)', () => {
    const view = render(<ReadingBoard {...props({ currentGoalId: 'g3' })} />)
    const region = layOut()
    view.rerender(<ReadingBoard {...props({ currentGoalId: 'g3' })} />)
    expect(region.scrollTop).toBe(900 - GOAL_VIEW_PAD)
  })
  it('换当前目标再对一次;他自己滚过之后,快照再来也不把他拽回去', () => {
    const view = render(<ReadingBoard {...props({ currentGoalId: 'g3' })} />)
    const region = layOut()
    view.rerender(<ReadingBoard {...props({ currentGoalId: 'g3' })} />)
    view.rerender(<ReadingBoard {...props({ currentGoalId: 'g2' })} />)
    expect(region.scrollTop).toBe(400 - GOAL_VIEW_PAD)
    fireEvent.wheel(region, { deltaY: 120 })
    region.scrollTop = 500
    view.rerender(<ReadingBoard {...props({ currentGoalId: 'g2', tasks: [...tasks, task('e', 'g1')] })} />)
    expect(region.scrollTop).toBe(500)
    view.rerender(<ReadingBoard {...props({ currentGoalId: 'g1' })} />)
    expect(region.scrollTop).toBe(0)
  })
  it('上面几节后量到高度(数据晚到)时,没动过手就继续对准当前目标', () => {
    const view = render(<ReadingBoard {...props({ currentGoalId: 'g3' })} />)
    const region = layOut()
    view.rerender(<ReadingBoard {...props({ currentGoalId: 'g3' })} />)
    OFFSETS['ben-cl-goal-g3'] = 1300
    view.rerender(<ReadingBoard {...props({ currentGoalId: 'g3', tasks: [...tasks, task('f', 'g1')] })} />)
    expect(region.scrollTop).toBe(1300 - GOAL_VIEW_PAD)
    OFFSETS['ben-cl-goal-g3'] = 900
  })
})

describe('协作区这一格的外沿', () => {
  it('★格子里铺满的协作区跟着卡的圆角裁边(圆角从卡上继承,不在协作区里另写一个数)', () => {
    const rule = MONO_STYLE.split('\n').find(line => line.includes('.ben-wb__card>.ben-wb__projects-collab{'))
    expect(rule).toBeDefined()
    expect(rule).toMatch(/border-radius:inherit/)
    expect(rule).toMatch(/overflow:hidden/)
  })
})

describe('事项轨迹:0 件进行中时', () => {
  const hang: CollabApi = { get: () => new Promise(() => {}) as never, post: async () => ({ ok: true, body: {} }) }
  it('★轨迹还没回:已完成那件也先摆一条(标题、负责人、「记录在读」),不只剩一行字', async () => {
    render(<TraceRail api={hang} goalId="g3" tasks={tasks.filter(one => one.goal_id === 'g3')} nameOf={String} onOpen={() => {}} width={700} height={300} />)
    const lane = screen.getByRole('group', { name: '列三种拓展坞方案 的轨迹' })
    expect(lane).toHaveTextContent('记录在读')
    expect(screen.getByRole('region', { name: '事项轨迹' })).toHaveTextContent('没有进行中的事项')
    await act(async () => {})
  })
  it('有进行中的就只摆进行中的(已完成的不挤进来)', () => {
    render(<TraceRail api={hang} goalId="g1" tasks={[task('x', 'g1', { status: 'doing' }), task('y', 'g1', { status: 'done' })]} nameOf={String} onOpen={() => {}} width={700} height={300} />)
    expect(screen.getAllByRole('group', { name: / 的轨迹$/ })).toHaveLength(1)
  })
})

// 18:4x 真机再退修:「当前目标」选着「研究座机拓展坞硬件方案」,阅读区却停在别的目标那一节、卡头被裁。
// 一是「动过」原来认的是 scrollTop 与上次设的差 —— 浏览器滚动锚定、恢复滚动位都会改 scrollTop,被误判成他动过、从此不再对准;
// 二是没点过目标时,下拉框显示第一个目标,目标条与阅读区跟的却是「第一个有事项的目标」,两处各说各的。
describe('「动过」只认他真的动手', () => {
  it('★对准之后 scrollTop 被别的东西改了(滚动锚定 / 恢复位)、上面又变高:照样对回当前目标', () => {
    const view = render(<ReadingBoard {...props({ currentGoalId: 'g3' })} />)
    const region = layOut()
    view.rerender(<ReadingBoard {...props({ currentGoalId: 'g3' })} />)
    region.scrollTop = 280 // 不是他动的:没有滚轮 / 触摸 / 键盘 / 拖滚动条
    OFFSETS['ben-cl-goal-g3'] = 1100
    view.rerender(<ReadingBoard {...props({ currentGoalId: 'g3', tasks: [...tasks, task('h', 'g1')] })} />)
    expect(region.scrollTop).toBe(1100 - GOAL_VIEW_PAD)
    OFFSETS['ben-cl-goal-g3'] = 900
  })
  it('★页面刚起就有一个恢复的滚动位:让位给对准当前目标', () => {
    const view = render(<ReadingBoard {...props()} />)
    const region = layOut()
    region.scrollTop = 700
    view.rerender(<ReadingBoard {...props({ currentGoalId: 'g3' })} />)
    expect(region.scrollTop).toBe(900 - GOAL_VIEW_PAD)
  })
  for (const [name, act] of [
    ['滚轮', (el: HTMLElement) => fireEvent.wheel(el, { deltaY: 100 })],
    ['触摸拖', (el: HTMLElement) => fireEvent.touchMove(el)],
    ['PageDown', (el: HTMLElement) => fireEvent.keyDown(el, { key: 'PageDown' })],
    ['空格', (el: HTMLElement) => fireEvent.keyDown(el, { key: ' ' })],
  ] as const) {
    it(`${name}算他动过:之后快照再来不拽回`, () => {
      const view = render(<ReadingBoard {...props({ currentGoalId: 'g3' })} />)
      const region = layOut()
      view.rerender(<ReadingBoard {...props({ currentGoalId: 'g3' })} />)
      act(region)
      region.scrollTop = 1200
      view.rerender(<ReadingBoard {...props({ currentGoalId: 'g3', tasks: [...tasks, task('i', 'g1')] })} />)
      expect(region.scrollTop).toBe(1200)
    })
  }
  it('按在滚动条上算动过;按在卡上、打字(字母键)不算', () => {
    const view = render(<ReadingBoard {...props({ currentGoalId: 'g3' })} />)
    const region = layOut()
    Object.defineProperty(region, 'clientWidth', { configurable: true, value: 690 })
    view.rerender(<ReadingBoard {...props({ currentGoalId: 'g3' })} />)
    fireEvent.keyDown(region, { key: 'a' })
    fireEvent.pointerDown(region, { clientX: 300 })
    region.scrollTop = 50
    view.rerender(<ReadingBoard {...props({ currentGoalId: 'g3', tasks: [...tasks, task('j', 'g1')] })} />)
    expect(region.scrollTop).toBe(900 - GOAL_VIEW_PAD)
    fireEvent.pointerDown(region, { clientX: 695 })
    region.scrollTop = 1500
    view.rerender(<ReadingBoard {...props({ currentGoalId: 'g3', tasks: [...tasks, task('k', 'g1')] })} />)
    expect(region.scrollTop).toBe(1500)
  })
})

describe('下拉框、目标条、阅读区说同一个「当前目标」', () => {
  it('★没点过目标、第一个目标没事项:下拉框显示的就是目标条与阅读区跟的那个', async () => {
    const state = {
      now: AT, sessions: [],
      tasks: {
        tasks: [task('z', 'g2', { title: '诊断包、新机器演练一条命令' })], sprints: [], modules: [], project_meta: [],
        goals: [goal('g1', '研究座机拓展坞硬件方案'), goal('g2', '一条命令装好')], goal_sprints: [], agent_cards: [], session_proposals: [],
      },
      agent_registry: { entries: [], asking: [], notices: [] },
    } as unknown as WorkbenchState
    const fetchImpl = (async (input: string) => new Response(JSON.stringify(new URL(input).pathname === '/collab/canvas' ? { layout: { goals: {}, notes: {} } } : { ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch
    render(<div style={{ width: 785, height: 766, position: 'relative' }}><CollabZone state={state} baseUrl="http://127.0.0.1:8791" fetchImpl={fetchImpl} presence={[] as CollabPresence[]} visible initialView="goals" onExpand={() => {}} /></div>)
    await screen.findByLabelText('目标阅读区')
    const select = screen.getByLabelText('当前目标') as HTMLSelectElement
    await waitFor(() => expect(select.value).toBe('g2'))
  })
})
