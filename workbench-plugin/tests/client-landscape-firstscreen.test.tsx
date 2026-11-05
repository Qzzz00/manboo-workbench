/**
 * 横屏首屏那两处看得见的毛病(2026-09-18,分支 fix/landscape-firstrun-glitches)。
 * Ben 跳过引导直接进工作台(2560×1440,第一次用)时截的图:
 *
 *   ① 左栏「事务官」下面竖着两组「恢复 / 覆盖保存」,名字被截成半个字、挤成两行,
 *      「删除」整颗掉到 168px 的栏外面去了 —— 场景条不能就这么塞进窄栏;
 *   ② 「还没有文件夹。把 Finder 窗口拖到这一格……」浮在页面右下角、不在那一格里
 *      —— 横屏底部一排每格只有三百来像素高,而槽体写死了 min-height:252px,
 *      盒子撑得比模块还高,居中的那句话被顶到模块外面。
 *
 * jsdom 量不出像素(没有真实布局),所以这份用例钉的是**结构与那几条尺寸规则本身**:
 * 窄栏里只剩一颗按钮、点开才有那三颗操作;空态那句话的 DOM 位置在自己那一格里面;
 * 会把盒子撑破的那条定高不许再回来。像素那一半在 2560×1440 的浏览器里真看过,
 * 见 docs/交接-0918-首屏三处显示.md。
 * (2026-10-23:files 那一格本体换成 Graphify 图谱,② 那三条照新 DOM 守同一件事。)
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, configure, render, screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkbenchOverlay, type MinimalWebSocket, type WorkbenchOverlayProps } from '../src/client/Workbench.tsx'
import { createWorkbenchStore } from '../src/client/store.ts'
import { STYLE } from '../src/client/style.ts'
import type { WorkbenchState } from '../src/protocol.ts'
import { DEFAULT_MODULE_TITLES } from '../src/templates.ts'
import { UNUSED_STANDARD_PROPS } from './helpers/standardProps.ts'

/** 同 client-landscape.test.tsx:一次重渲在 jsdom 里要几百毫秒,默认 1 秒不够重试。 */
configure({ asyncUtilTimeout: 5_000 })

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

const SCENES = [
  { id: 's1', name: '写代码', app_count: 3, saved_at: '2026-09-18T09:00:00+08:00' },
  { id: 's2', name: '开会', app_count: 2, saved_at: '2026-09-18T09:00:00+08:00' },
]

/** Ben 那一刻的状态:引导没做完(点了跳过)、窗位叠空的、存过两个场景。 */
function firstRun(over: Partial<WorkbenchState> = {}): WorkbenchState {
  return {
    agents: [{ id: 'dsh', online: true, connected: true, waiting: 0, running: 0 }],
    sessions: [],
    quota: {},
    now: '2026-09-18T10:03:00+08:00',
    stale: false,
    onboarding: { stage: 'opening', done: false },
    dock: { stack: [] },
    scenes: SCENES,
    ...over,
  }
}

function fakeServer(state: WorkbenchState) {
  const calls: { url: string, body: unknown }[] = []
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      calls.push({ url: String(url), body: init.body === undefined ? undefined : JSON.parse(String(init.body)) })
      return { ok: true, json: async () => ({ ok: true }) }
    }
    return { ok: true, json: async () => state }
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
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
    serviceWebSocket: (): MinimalWebSocket => ({ onmessage: null, onclose: null, close: () => {} }),
  }
}

// ───────────────────────────────────────────────────────────────────────────
describe('① 窄栏里的场景条:收成一个图标菜单', () => {
  beforeEach(() => { setViewport(2560, 1440) })

  it('★左栏里只剩一颗「窗口布局」按钮,那三颗操作一颗都不常显', async () => {
    const { container } = render(<WorkbenchOverlay {...props(fakeServer(firstRun()).fetchImpl)} />)
    await screen.findByRole('heading', { name: '工作台' })

    const rail = await waitFor(() => {
      const found = container.querySelector('[data-land-region="rail"]')
      expect(found).not.toBeNull()
      return found as HTMLElement
    })
    expect(within(rail).getByRole('button', { name: '窗口布局' })).toBeTruthy()
    // 这三颗就是被挤成两行、截掉半个字的那几颗。收起来之后一颗都不在屏幕上。
    expect(screen.queryByRole('button', { name: '覆盖保存 写代码' })).toBeNull()
    expect(screen.queryByRole('button', { name: '恢复 写代码' })).toBeNull()
    expect(screen.queryByRole('button', { name: '删除 写代码' })).toBeNull()
  })

  it('★点开才有:面板里每个场景的 恢复 / 覆盖保存 / 删除 一个不少', async () => {
    render(<WorkbenchOverlay {...props(fakeServer(firstRun()).fetchImpl)} />)
    await screen.findByRole('heading', { name: '工作台' })
    const trigger = await screen.findByRole('button', { name: '窗口布局' })

    await userEvent.click(trigger)
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    for (const name of SCENES.map(scene => scene.name)) {
      expect(screen.getByRole('button', { name: `恢复 ${name}` })).toBeTruthy()
      expect(screen.getByRole('button', { name: `覆盖保存 ${name}` })).toBeTruthy()
      expect(screen.getByRole('button', { name: `删除 ${name}` })).toBeTruthy()
    }
  })

  it('面板里那几行**就是同一份场景条**,不是另画一套(两份各跑各的"恢复中"本地态必走漂)', async () => {
    const { container } = render(<WorkbenchOverlay {...props(fakeServer(firstRun()).fetchImpl)} />)
    await screen.findByRole('heading', { name: '工作台' })
    await userEvent.click(await screen.findByRole('button', { name: '窗口布局' }))
    expect(container.querySelectorAll('.ben-wb__scenebar')).toHaveLength(1)
  })

  it('按 Esc 收起来', async () => {
    render(<WorkbenchOverlay {...props(fakeServer(firstRun()).fetchImpl)} />)
    await screen.findByRole('heading', { name: '工作台' })
    const trigger = await screen.findByRole('button', { name: '窗口布局' })
    await userEvent.click(trigger)
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(trigger).toHaveAttribute('aria-expanded', 'false'))
  })

  it('竖屏一个字没变:场景条照旧整条常显在窗位槽模块里,没有那颗按钮', async () => {
    setViewport(1440, 2560)
    const { container } = render(<WorkbenchOverlay {...props(fakeServer(firstRun()).fetchImpl)} />)
    await screen.findByRole('heading', { name: '工作台' })

    await waitFor(() => {
      expect(container.querySelector('main.ben-wb')).toHaveAttribute('data-orientation', 'portrait')
    })
    expect(screen.queryByRole('button', { name: '窗口布局' })).toBeNull()
    expect(screen.getByRole('button', { name: '覆盖保存 写代码' })).toBeTruthy()
  })
})

// ───────────────────────────────────────────────────────────────────────────
describe('② 空态那句话待在自己那一格里', () => {
  beforeEach(() => { setViewport(2560, 1440) })

  it(`★${DEFAULT_MODULE_TITLES.files}那一句在**那一格里**,不是飘在页面上`, async () => {
    const { container } = render(<WorkbenchOverlay {...props(fakeServer(firstRun()).fetchImpl)} />)
    await screen.findByRole('heading', { name: '工作台' })

    // ★ 2026-10-23(卡「系统文件夹改成Graphify图谱」):那一格本体换成 GraphView(install /
    // build / iframe 三档),没有带本机路径的项目时它如实说一句、不摆点了必错的键。
    // 这一条守的事没变:那句话在**那一格的模块盒子里**,不飘在页面上。
    const line = await screen.findByText('项目区里还没有带本机路径的项目')
    // 那句话在底部一排最后那一格的模块盒子里 —— 盒子是 overflow:hidden 的,
    // 所以"在盒子里"这件事本身就是"不会画到别人身上"。
    const deck = container.querySelector('[data-land-region="deck"]') as HTMLElement
    const lastBox = [...deck.querySelectorAll('.ben-wb__mod')].at(-1) as HTMLElement
    expect(lastBox.contains(line)).toBe(true)
  })

  it('★那条会把盒子撑破的定高不许再回来(图谱格是可收缩的 flex:1 / min-height:0)', () => {
    // 2026-10-23 图谱格(.ben-wb__graph)接的就是当年 filesbody 那一格:吃掉剩余、可收缩。
    const rule = /\.ben-wb__graph\{([^}]*)\}/.exec(STYLE)?.[1] ?? ''
    expect(rule).toContain('min-height:0')
    expect(rule).toContain('flex:1')
    // 当年把盒子撑破的那条定高(min-height:252px)一个副本都不许回来。
    expect(STYLE).not.toContain('min-height:252px')
  })

  it('★窗位槽那一句画在槽体内部,不再跟上面那行红字叠在一起', async () => {
    const state = firstRun({ helper: { connected: true, authorized: false, reason: '辅助功能未授权' } })
    const { container } = render(<WorkbenchOverlay {...props(fakeServer(state).fetchImpl)} />)
    await screen.findByRole('heading', { name: '工作台' })

    const line = await screen.findByText('把常用的应用从屏幕上拖进这块槽里,它就会出现在这排标签里。')
    const slotBody = container.querySelector('.ben-wb__slot-body') as HTMLElement
    expect(slotBody.contains(line)).toBe(true)
    // 它曾经是 .ben-wb__slot-stack 的直接孩子(悬在 stack 顶端 = 红字待的地方)。
    expect(container.querySelector('.ben-wb__slot-stack > .ben-wb__emptyfirst')).toBeNull()
    // 悬浮这条性质要保住:槽体尺寸一变服务端就会把贴住的窗重摆一次。
    expect(line.closest('.ben-wb__emptyfirst')).toHaveAttribute('data-overlay', 'true')
  })

  it(`竖屏那一句照旧在同一个地方(空态没跟着方向改口径)`, async () => {
    setViewport(1440, 2560)
    const { container } = render(<WorkbenchOverlay {...props(fakeServer(firstRun()).fetchImpl)} />)
    await screen.findByRole('heading', { name: '工作台' })
    const line = await screen.findByText('项目区里还没有带本机路径的项目')
    // 没有 path 项目时 GraphView 只回这一句(不包 .ben-wb__graph 那层),锚到模块盒子即可。
    const filesBox = line.closest('.ben-wb__mod') as HTMLElement
    expect(filesBox).not.toBeNull()
    expect(filesBox.contains(line)).toBe(true)
  })
})
