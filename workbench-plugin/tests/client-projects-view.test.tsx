import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkbenchOverlay, type MinimalWebSocket, type WorkbenchOverlayProps } from '../src/client/Workbench.tsx'
import { createWorkbenchStore } from '../src/client/store.ts'
import type { TasksState, TaskView, WorkbenchLayout, WorkbenchState } from '../src/protocol.ts'
import { UNUSED_STANDARD_PROPS } from './helpers/standardProps.ts'

afterEach(cleanup)
// 协作区的画布(React Flow)要量尺寸;jsdom 没有 ResizeObserver,真浏览器里有。
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as never

/** 见 workbenchLayout.test.tsx 的同名注释:不喂假 WS 会去连 Ben 本机真跑着的工作台服务。 */
function fakeWebSocket(): (url: string) => MinimalWebSocket {
  return () => ({ onmessage: null, onclose: null, close: () => {} })
}

/** 与 main 的 DEFAULT_LAYOUT 同形:顶部行左列项目区,右列消耗数据 + 余额上下摞。 */
const LAYOUT: WorkbenchLayout = {
  modules: [
    { id: 'projects', order: 0, basis_pct: 34, row: 0, col: 0, width_pct: 60 },
    { id: 'usage', order: 1, basis_pct: 22, row: 0, col: 1, width_pct: 40 },
    { id: 'quota', order: 2, basis_pct: 12, row: 0, col: 1, width_pct: 40 },
    { id: 'slot', order: 3, basis_pct: 54, row: 1 },
  ],
  butler: { corner: 'br', min: false },
}

/** 一份最小的看板快照:一个冲刺 + 一个模块,卡片由各用例自己给。 */
function tasksState(tasks: readonly TaskView[]): TasksState {
  return {
    tasks,
    sprints: [{
      id: 's1', project_id: 'p1', name: '冲刺一', goal: '把看板跑通',
      versions: [{ label: '客户端', version: 'V0.1' }],
      created_at: '2026-08-25T09:00:00.000Z', updated_at: '2026-08-25T09:00:00.000Z',
    }],
    modules: [{
      id: 'm1', sprint_id: 's1', name: '播放模块',
      created_at: '2026-08-25T09:00:00.000Z', updated_at: '2026-08-25T09:00:00.000Z',
    }],
    project_meta: [],
  }
}

function task(over: Partial<TaskView> = {}): TaskView {
  return {
    id: 'a',
    title: '卡片甲',
    status: 'todo',
    source: { kind: 'manual' },
    created_at: '2026-08-25T09:00:00.000Z',
    updated_at: '2026-08-25T09:00:00.000Z',
    ...over,
  }
}

function snapshot(over: Partial<WorkbenchState> = {}): WorkbenchState {
  return {
    agents: [],
    sessions: [],
    quota: {},
    now: '2026-08-25T17:03:00+08:00',
    stale: false,
    layout: LAYOUT,
    projects: {
      projects: [{ id: 'p1', name: 'Aiboo', stage: 'MVP 开发', links: [], session_count: 0, idle: false }],
      pending: [],
      scan_errors: [],
      scanned_at: '2026-08-25T09:00:00.000Z',
    },
    ...over,
  }
}

/** /state 返回快照,任何 POST 原样记 { url, body }(仿 workbenchLayout.test.tsx)。 */
function fakeFetchRecording(state: WorkbenchState, calls: { url: string, body: unknown }[]) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      calls.push({ url: String(url), body: init.body === undefined ? undefined : JSON.parse(String(init.body)) })
      return { ok: true, json: async () => ({ ok: true }) }
    }
    return { ok: true, json: async () => state }
  }) as unknown as typeof fetch
}

function props(fetchImpl: typeof fetch): WorkbenchOverlayProps {
  const instance = createWorkbenchStore().create()
  const workspaceState = {
    items: [], phase: 'ready', archivedSessionIds: [], state: 'idle',
    error: null, baselinesReady: true, recentWorkspaceId: undefined,
  }
  return {
    useStore: selector => selector(instance.getSnapshot()),
    actions: instance.actions,
    useWorkspaces: selector => selector(workspaceState as never),
    useSessions: selector => selector({} as never),
    ...UNUSED_STANDARD_PROPS,
    openWorkspace: async () => {},
    openSession: () => {},
    serviceFetch: fetchImpl,
    servicePollMs: 0,
    serviceWebSocket: fakeWebSocket(),
  }
}

async function mount(state: WorkbenchState) {
  const calls: { url: string, body: unknown }[] = []
  render(<WorkbenchOverlay {...props(fakeFetchRecording(state, calls))} />)
  await screen.findByRole('heading', { name: '项目区' })
  return calls
}

/*
 * 2026-10-21:项目区的看板下线,换成「协作区」(`docs/设计-协作区-无限画布-2026-10-21.md`,待拍板 2:替代不并列)。
 * 2026-10-22 维护者:「总览」退役,项目区那一排标签里下掉 —— 协作区 Pen A·30 / A·31 里项目区那格就是协作区组件本身,
 * 头上没有「总览 / 协作区」那一排。原来这里那组「看板的四个动作」由 `client-collab-zone.test.tsx` 钉。
 */
describe('项目区这格直接是协作区(总览退役)', () => {
  it('接了任务账:这格就是协作区组件;没有「总览」,也没有展示模式那一排', async () => {
    await mount(snapshot({ tasks: tasksState([]) }))
    const embedded = document.querySelector('.ben-wb__projects-collab') as HTMLElement
    expect(within(embedded).getByRole('region', { name: '协作区' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '总览' })).not.toBeInTheDocument()
    expect(screen.queryByRole('group', { name: '项目区展示模式' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '从会话转卡' })).not.toBeInTheDocument()
  })

  // 10-22 第三轮 5(维护者):右上角改成全屏,点了整个工作台只剩协作区,有明显的「退出全屏」;协作区只有这一处、一个尺寸。
  it('「全屏」→ 整个工作台只剩协作区;「退出全屏」/ Esc 回来', async () => {
    const user = userEvent.setup()
    await mount(snapshot({ tasks: tasksState([task({ id: 't1', title: '甲', project_id: 'p1' })]) }))
    const embedded = document.querySelector('.ben-wb__projects-collab') as HTMLElement
    await user.click(within(embedded).getByRole('button', { name: '全屏' }))
    const full = screen.getByRole('dialog', { name: '协作区全屏' })
    expect(within(full).getByRole('region', { name: '协作区' })).toBeInTheDocument()
    await user.click(within(full).getByRole('button', { name: '退出全屏' }))
    expect(screen.queryByRole('dialog', { name: '协作区全屏' })).toBeNull()
    await user.click(within(embedded).getByRole('button', { name: '全屏' }))
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog', { name: '协作区全屏' })).toBeNull()
  })

  it('存档里还是「看板」的老布局:照样是协作区,不报错', async () => {
    await mount(snapshot({ layout: { ...LAYOUT, projects_view: 'board' }, tasks: tasksState([]) }))
    expect(document.querySelector('.ben-wb__projects-collab')).not.toBeNull()
    expect(screen.queryByRole('button', { name: '总览' })).not.toBeInTheDocument()
  })

  it('/state 里没有 tasks(没接任务账):没有协作区,项目行照旧,也没有「总览」那一颗', async () => {
    await mount(snapshot())
    expect(document.querySelector('.ben-wb__projects-collab')).toBeNull()
    expect(screen.getByText('Aiboo')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '总览' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '协作区' })).not.toBeInTheDocument()
  })
})

// 10-22 第三轮 5:窗口槽里不再有协作区的入口(槽里那页只是事务官自己那一页);协作区只从项目区那格进。
describe('窗口槽里没有协作区', () => {
  it('接了任务账也没有「协作区」那一格,槽里不挂协作区', async () => {
    await mount(snapshot({ tasks: tasksState([]) }))
    expect(document.querySelector('[data-module-id="wb:collab"]')).toBeNull()
    const slot = document.querySelector('[data-module-box="slot"]') as HTMLElement
    expect(within(slot).queryByRole('region', { name: '协作区' })).toBeNull()
  })
})

/*
 * 2026-10-22 拍板 8 / 9 / 11(评审页 `.slot-tabs`):窗口槽、项目区的卡里不再有标题行;卡外一行弱字,
 * 窗口槽那行是「窗口槽 · 事务官 · 设置」,「收起」排在行末;项目区同理。那一行仍是能拖、能 Alt+方向键挪的标题。
 */
describe('窗口槽与项目区:卡外一行弱字当标题,「收起」在行末', () => {
  // 10-22 第三轮 3:「设置」只留顶栏那一颗,窗口槽这一行不再有
  it('窗口槽:卡外「窗口槽 · 收起」;卡里没有头;没有第二颗「设置」', async () => {
    await mount(snapshot())
    const box = document.querySelector('[data-module-box="slot"]') as HTMLElement
    const line = box.querySelector(':scope > .ben-wb__modhead') as HTMLElement
    expect(line).not.toBeNull()
    expect(box.querySelector('section .ben-wb__modhead')).toBeNull()
    expect(within(line).getByRole('heading', { name: '窗口槽' })).toBeInTheDocument()
    const buttons = within(line).getAllByRole('button')
    // 2026-10-27 起卡头没有「事务官」那颗键(入口只剩悬浮球)。
    expect(buttons.map(one => one.getAttribute('aria-label') ?? one.textContent)).toEqual(['窗口槽 收起'])
    expect(screen.getAllByRole('button', { name: /设置/ }).filter(one => one.textContent === '设置')).toHaveLength(1)
  })

  it('项目区:卡外「项目区 · 收起」;卡里没有头', async () => {
    await mount(snapshot({ tasks: tasksState([]) }))
    const box = document.querySelector('[data-module-box="projects"]') as HTMLElement
    const line = box.querySelector(':scope > .ben-wb__modhead') as HTMLElement
    expect(line).not.toBeNull()
    expect(box.querySelector('section .ben-wb__modhead')).toBeNull()
    expect(within(line).getByRole('heading', { name: '项目区' })).toBeInTheDocument()
    expect(within(line).getAllByRole('button').map(one => one.getAttribute('aria-label'))).toEqual(['项目区 收起'])
  })
})

// 10-22 第三轮 1:协作区在时,接入的那几家只在它「成员」那排出现,顶栏那一排不画;没有协作区(没接任务账)时照旧在顶栏。
describe('接入的智能体只出现一处', () => {
  const registry = { entries: [{ id: 'claude', name: 'Claude', status: 'running', connected: true, kind: 'client', sessions: [], counts: { running: 1, waiting: 0, unread: 0 }, gaps: {}, sources: [], found: { how: 'process', at: '2026-08-25T09:00:00.000Z', basis: '' } }], asking: [], notices: [] }
  it('有协作区:顶栏没有那一排,成员那排有 Claude', async () => {
    await mount(snapshot({ tasks: tasksState([]), agent_registry: registry } as never))
    expect(document.querySelector('.ben-wb__topbar .ben-wb__topagent')).toBeNull()
    expect(within(screen.getAllByRole('group', { name: '成员' })[0] as HTMLElement).getByRole('button', { name: '看 Claude 的相关事项' })).toBeInTheDocument()
  })
  it('没有协作区:照旧在顶栏', async () => {
    await mount(snapshot({ agent_registry: registry } as never))
    await waitFor(() => expect(document.querySelector('.ben-wb__topbar .ben-wb__topagent')).not.toBeNull())
  })
})
