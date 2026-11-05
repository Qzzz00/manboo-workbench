/**
 * 去掉「干活 / 沟通」两条空预置之后,界面该说的话(2026-09-20,分支 fix/no-preset-scenes;
 * **2026-09-21 fix/slot-refit-on-orientation 改了第 ① 段**)。
 *
 * Ben 原话(0920):「那两个所谓的『预置』从默认布局里删掉吧,反而是要提醒用户把常用的
 * 应用自己拖进来。」删掉之后有两处会空下来:
 *
 *   ① 场景菜单(SceneBar)一条布局都没有 → 0920 在这儿放了一句「还没存过窗口布局……」
 *      外加一颗「存成新布局」。**0921 Ben 拍板两样一起去掉**(原话:「这个部分不要有了」)
 *      —— 布局以后由模板带出来,这一格只做恢复。现在:竖屏整条不画(不留空壳容器),
 *      窄栏那颗按钮照旧在,点开只说一句「还没有窗口布局」(菜单开出来一片空白更像坏了)。
 *   ② 窗位叠一个应用都没认领过 → 「把常用的应用从屏幕上拖进这块槽里,它就会出现在这排
 *      标签里。」走的是既有的空态机制(emptyState.ts + .ben-wb__emptyfirst),没有第二套样式。
 *      **这一句 0921 一个字没动**,两次改动互不相干。
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, configure, render, screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SceneBar } from '../src/client/SceneBar.tsx'
import { WorkbenchOverlay, type MinimalWebSocket, type WorkbenchOverlayProps } from '../src/client/Workbench.tsx'
import { createWorkbenchStore } from '../src/client/store.ts'
import type { WorkbenchState } from '../src/protocol.ts'
import { UNUSED_STANDARD_PROPS } from './helpers/standardProps.ts'

/** 同 client-landscape*.test.tsx:jsdom 里一次重渲要几百毫秒,默认 1 秒不够重试。 */
configure({ asyncUtilTimeout: 5_000 })

/** 0920 那句(已经下线),用它钉"不许再出现"。 */
const OLD_SCENE_HINT = '还没存过窗口布局。先把常用的应用拖进窗口槽,摆好了再在这里保存。'
/** 0921 之后菜单里剩下的那一句(只在窄栏菜单里)。 */
const SCENE_EMPTY = '还没有窗口布局'
const SLOT_HINT = '把常用的应用从屏幕上拖进这块槽里,它就会出现在这排标签里。'

const REAL_WIDTH = window.innerWidth
const REAL_HEIGHT = window.innerHeight

function setViewport(width: number, height: number): void {
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true, writable: true })
  Object.defineProperty(window, 'innerHeight', { value: height, configurable: true, writable: true })
  act(() => { window.dispatchEvent(new Event('resize')) })
}

afterEach(() => {
  cleanup()
  setViewport(REAL_WIDTH, REAL_HEIGHT)
})

// ───────────────────────────────────────────────────────────────────────────
describe('① 场景菜单:一条布局都没存过(2026-09-21 改口)', () => {
  it('★竖屏那条路径整条不画:没有那句提示、没有「存成新布局」、连空壳容器都不留', () => {
    const { container } = render(
      <SceneBar baseUrl="http://x" scenes={[]} fetchImpl={vi.fn() as unknown as typeof fetch} />,
    )

    expect(container.querySelector('.ben-wb__scenebar')).toBeNull()
    expect(screen.queryByText(OLD_SCENE_HINT)).toBeNull()
    expect(screen.queryByRole('button', { name: '存成新布局' })).toBeNull()
    expect(screen.queryByRole('textbox', { name: '新布局的名字' })).toBeNull()
  })

  it('★窄栏(横屏左栏)照旧有那颗按钮,点开只说一句「还没有窗口布局」,没有任何存布局的入口', async () => {
    render(<SceneBar baseUrl="http://x" scenes={[]} compact fetchImpl={vi.fn() as unknown as typeof fetch} />)

    await userEvent.click(screen.getByRole('button', { name: '窗口布局' }))

    expect(screen.getByText(SCENE_EMPTY)).toBeTruthy()
    expect(screen.queryByRole('button', { name: '存成新布局' })).toBeNull()
  })

  it('存过布局之后照常画清单,那句空话不出现', () => {
    const scenes = [{ id: 's1', name: '写代码', app_count: 3, saved_at: '2026-09-20T09:00:00+08:00' }]
    render(<SceneBar baseUrl="http://x" scenes={scenes} fetchImpl={vi.fn() as unknown as typeof fetch} />)

    expect(screen.queryByText(SCENE_EMPTY)).toBeNull()
    expect(screen.getByRole('button', { name: '恢复 写代码' })).toBeTruthy()
    // 「覆盖保存」是既有场景自己的入口,这次一个字没动——下线的只有"新建"那一条路。
    expect(screen.getByRole('button', { name: '覆盖保存 写代码' })).toBeTruthy()
  })

  it('★整个组件里一次 /scene/create 都不会发(路由留在服务端给模板用,客户端没有入口)', async () => {
    const calls: string[] = []
    const fetchImpl = vi.fn(async (url: string) => {
      calls.push(String(url))
      return { ok: true, json: async () => ({ ok: true }) }
    }) as unknown as typeof fetch
    const scenes = [{ id: 's1', name: '写代码', app_count: 3, saved_at: '2026-09-20T09:00:00+08:00' }]
    render(<SceneBar baseUrl="http://x" scenes={scenes} fetchImpl={fetchImpl} />)

    await userEvent.click(screen.getByRole('button', { name: '覆盖保存 写代码' }))

    await waitFor(() => expect(calls.length).toBe(1))
    expect(calls.some(url => url.endsWith('/scene/create'))).toBe(false)
  })
})

// ───────────────────────────────────────────────────────────────────────────
function fakeWebSocket(): (url: string) => MinimalWebSocket {
  return () => ({ onmessage: null, onclose: null, close: () => {} })
}

function props(fetchImpl: typeof fetch): WorkbenchOverlayProps {
  const instance = createWorkbenchStore().create()
  const workspaceState = {
    items: [], phase: 'ready', archivedSessionIds: [], state: 'idle', error: null,
    baselinesReady: true, recentWorkspaceId: undefined,
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

function fakeServer(state: WorkbenchState): typeof fetch {
  return vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'POST') return { ok: true, json: async () => ({ ok: true }) }
    return { ok: true, json: async () => state }
  }) as unknown as typeof fetch
}

/** 装完就进来的样子:一个场景都没有(预置删了)、窗位叠接上了但一个应用都没认领。 */
function fresh(over: Partial<WorkbenchState> = {}): WorkbenchState {
  return {
    agents: [{ id: 'dsh', online: true, connected: true, waiting: 0, running: 0 }],
    sessions: [],
    quota: {},
    now: '2026-09-20T10:03:00+08:00',
    stale: false,
    onboarding: { stage: 'opening', done: false },
    dock: { stack: [] },
    scenes: [],
    ...over,
  }
}

describe('② 竖屏:槽里那句在,场景那一格整条不画(2026-09-21 改口)', () => {
  it('★窗位槽那句照旧;场景那句与「存成新布局」都不在了', async () => {
    setViewport(1440, 2560)
    render(<WorkbenchOverlay {...props(fakeServer(fresh()))} />)
    await screen.findByRole('heading', { name: '工作台' })

    expect(await screen.findByText(SLOT_HINT)).toBeTruthy()
    expect(screen.queryByText(OLD_SCENE_HINT)).toBeNull()
    expect(screen.queryByRole('button', { name: '存成新布局' })).toBeNull()
  })

  /**
   * 2026-09-25(卡 feat/first-look-orb-top)改:引导走完、叠为空 → **一打开是事务官档**(大球那一页),
   * 不再是一块空虚线框(维护者:「最上面不应该是我精心制作的那张粒子球吗」)。窗位槽那句没跟着引导退场:
   * 事务官档上挂着「叠里还没有窗——回到窗位落点」,点一下就是它。
   */
  it('★引导做完了、还是一个应用都没认领 → 默认事务官档;「回到窗位落点」一点,窗位槽那句照旧在(它不跟着引导退场)', async () => {
    setViewport(1440, 2560)
    render(<WorkbenchOverlay {...props(fakeServer(fresh({ onboarding: { stage: 'done', done: true } })))} />)
    await screen.findByRole('heading', { name: '工作台' })

    const back = await screen.findByRole('button', { name: '回到窗位落点' })
    expect(screen.queryByText(SLOT_HINT)).toBeNull()
    await userEvent.click(back)
    expect(await screen.findByText(SLOT_HINT)).toBeTruthy()
    expect(screen.queryByText(OLD_SCENE_HINT)).toBeNull()
  })

  it('★认领过一个应用 → 窗位槽那句消失(有东西就显示东西)', async () => {
    setViewport(1440, 2560)
    const state = fresh({ dock: { stack: [{ key: 'claude', label: 'Claude', current: true, running: true }] } })
    render(<WorkbenchOverlay {...props(fakeServer(state))} />)
    await screen.findByRole('heading', { name: '窗口槽' })

    await waitFor(() => expect(screen.queryByText(SLOT_HINT)).toBeNull())
  })
})

describe('③ 横屏:槽体那句在;左栏那颗「窗口布局」点开只说清单是空的', () => {
  it('★槽体那句在;点开左栏的「窗口布局」→ 面板里只有「还没有窗口布局」,没有存布局的入口', async () => {
    setViewport(2560, 1440)
    const { container } = render(<WorkbenchOverlay {...props(fakeServer(fresh()))} />)
    await screen.findByRole('heading', { name: '工作台' })

    expect(await screen.findByText(SLOT_HINT)).toBeTruthy()

    const rail = await waitFor(() => {
      const found = container.querySelector('[data-land-region="rail"]')
      expect(found).not.toBeNull()
      return found as HTMLElement
    })
    // 清单为空也要画这颗按钮 —— 窄栏这一档不跟着清空退场(退场的话横屏左栏会凭空少一格,
    // 而且等模板把布局带出来之后它又凭空多一格)。
    const trigger = within(rail).getByRole('button', { name: '窗口布局' })
    // 评审页左栏「窗口布局」只有图标与名字,不带计数(10-22 拍板 7)
    expect(trigger.textContent).toBe('窗口布局')
    await userEvent.click(trigger)

    expect(await screen.findByText(SCENE_EMPTY)).toBeTruthy()
    expect(screen.queryByText(OLD_SCENE_HINT)).toBeNull()
    expect(screen.queryByRole('button', { name: '存成新布局' })).toBeNull()
  })
})
