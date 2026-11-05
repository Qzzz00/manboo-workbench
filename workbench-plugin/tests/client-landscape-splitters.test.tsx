/**
 * 横屏分栏把手(2026-09-18,分支 feat/landscape-splitters)。
 *
 * Ben 截图圈的四处:横屏下**只有**「窗口槽 | 项目区」之间有一根可拖的把手,
 * 左栏|窗口槽、底部四格两两之间、主区|底部一排都没有。这份文件钉五件事:
 *   ① 四条边界上的把手真的都在 DOM 里,而且是同一个组件(同样的类、同样的 11px 热区);
 *   ② 每一根拖出来的结果都落进 `layout.landscape` 那一支;
 *   ③ 竖屏那一版一根都没多、拖出来的仍然写顶层 modules;
 *   ④ 事务官浮窗落点按方向分别记,横屏那份缺席时不传 pos(默认落点交给 CSS);
 *   ⑤ 「恢复默认布局」按方向恢复,横屏那支连左栏宽度与浮窗落点一起回默认。
 *
 * 驱动方向的手法同 tests/client-landscape.test.tsx:改 window.innerWidth/innerHeight
 * 再派发 resize(jsdom 没有 ResizeObserver)。拖拽的手法同 tests/workbenchLayout.test.tsx:
 * 全局桩住 getBoundingClientRect 当分母,再 fireEvent.pointer* 三连。
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkbenchOverlay, type MinimalWebSocket, type WorkbenchOverlayProps } from '../src/client/Workbench.tsx'
import { createWorkbenchStore } from '../src/client/store.ts'
import {
  branchModules, butlerPosOf, DEFAULT_LANDSCAPE_MODULES, DEFAULT_LAYOUT,
  LANDSCAPE_DECK_CELL_MIN_PCT, LANDSCAPE_RAIL_MAX_PCT, LANDSCAPE_RAIL_MIN_PCT,
  landscapeDeckPct, landscapeDeckWidth, landscapeRailPct, resetLayout,
  resizeLandscapeDeckPair, setLandscapeRailPct, withButlerPos,
} from '../src/client/layout.ts'
import type { WorkbenchLayout, WorkbenchState } from '../src/protocol.ts'
import { DEFAULT_MODULE_TITLES } from '../src/templates.ts'
import { UNUSED_STANDARD_PROPS } from './helpers/standardProps.ts'

configure({ asyncUtilTimeout: 5_000 })

const REAL_WIDTH = window.innerWidth
const REAL_HEIGHT = window.innerHeight

/** 四根竖把手 + 一根横把手的可访问名(与 Workbench.tsx 里那几处 label 逐字一致;files 边界名与本体正式标题常量共源)。 */
const LABEL_RAIL = '调整 窗位应用栏 与 窗口槽 的宽度占比'
const LABEL_BAND = '调整 窗口槽 与 项目区 的宽度占比'
const LABEL_DECK_H = '调整 主区 与 底部一排 的高度占比'
const LABEL_DECK_1 = '调整 消耗数据 与 余额 / 额度 的宽度占比'
const LABEL_DECK_3 = `调整 随手记 与 ${DEFAULT_MODULE_TITLES.files} 的宽度占比`

function setViewport(width: number, height: number): void {
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true, writable: true })
  Object.defineProperty(window, 'innerHeight', { value: height, configurable: true, writable: true })
  act(() => { window.dispatchEvent(new Event('resize')) })
}

/** 全局桩一个固定矩形当拖拽换算的分母(手法同 tests/workbenchLayout.test.tsx)。 */
function pinRect(width: number, height: number): void {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0, y: 0, width, height, top: 0, left: 0, right: width, bottom: height, toJSON() {},
  } as DOMRect)
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  setViewport(REAL_WIDTH, REAL_HEIGHT)
  window.history.replaceState(null, '', '/')
})

function fakeWebSocket(): (url: string) => MinimalWebSocket {
  return () => ({ onmessage: null, onclose: null, close: () => {} })
}

/** 叠上有一扇窗在台前——否则 butlerActive 为真,事务官档会盖住槽体(先例见 workbenchLayout.test.tsx)。 */
function dockWithCurrent(): { stack: readonly { key: string, label: string, running: boolean, current: boolean }[] } {
  return { stack: [{ key: 'claude', label: 'Claude', running: true, current: true }] }
}

function snapshot(over: Partial<WorkbenchState> = {}): WorkbenchState {
  return {
    agents: [{ id: 'dsh', online: true, connected: true, waiting: 0, running: 0 }],
    sessions: [],
    quota: {},
    now: '2026-09-18T10:03:00+08:00',
    stale: false,
    dock: dockWithCurrent(),
    ...over,
  }
}

function fakeFetchRecording(state: WorkbenchState, calls: { url: string, body: unknown }[]) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      calls.push({ url: String(url), body: init.body === undefined ? undefined : JSON.parse(String(init.body)) })
      return { ok: true, json: async () => ({ ok: true }) }
    }
    return { ok: true, json: async () => state }
  }) as unknown as typeof fetch
}

function props(options: { state?: WorkbenchState, fetchImpl?: typeof fetch } = {}): WorkbenchOverlayProps {
  const instance = createWorkbenchStore().create()
  const workspaceState = {
    items: [], phase: 'ready', archivedSessionIds: [], state: 'idle', error: null,
    baselinesReady: true, recentWorkspaceId: undefined,
  }
  const state = options.state ?? snapshot()
  return {
    useStore: selector => selector(instance.getSnapshot()),
    actions: instance.actions,
    useWorkspaces: selector => selector(workspaceState as never),
    useSessions: selector => selector({} as never),
    ...UNUSED_STANDARD_PROPS,
    openWorkspace: async () => {},
    openSession: () => {},
    serviceFetch: options.fetchImpl ?? (vi.fn(async () => ({
      ok: true, json: async () => state,
    })) as unknown as typeof fetch),
    servicePollMs: 0,
    serviceWebSocket: fakeWebSocket(),
  }
}

/** 落盘的最后一份 layout(applyLayout 是 800ms 去抖,所以要 waitFor)。 */
async function lastPostedLayout(calls: { url: string, body: unknown }[]): Promise<WorkbenchLayout> {
  await waitFor(() => expect(calls.some(c => c.url.endsWith('/layout'))).toBe(true), { timeout: 3000 })
  return (calls.filter(c => c.url.endsWith('/layout')).at(-1)?.body as { layout: WorkbenchLayout }).layout
}

// ───────────────────────────────────────────────────────────────────────────
describe('① 四条边界上的把手都在,而且是同一个组件', () => {
  it('横屏渲染出五根把手:左栏|窗口槽、窗口槽|项目区、主区|底部一排、底部四格之间那三根', async () => {
    setViewport(2560, 1440)
    render(<WorkbenchOverlay {...props()} />)
    await screen.findByRole('heading', { name: '工作台' })

    // 四条边界 = 五根把手(底部四格之间是三根)。少一根就是 Ben 截图里那个问题还在。
    await waitFor(() => expect(screen.getByLabelText(LABEL_RAIL)).toBeTruthy())
    for (const label of [
      LABEL_RAIL, LABEL_BAND, LABEL_DECK_H,
      LABEL_DECK_1, '调整 余额 / 额度 与 随手记 的宽度占比', LABEL_DECK_3,
    ]) {
      expect(screen.getByLabelText(label)).toBeTruthy()
    }
  })

  it('五根长得一模一样:同一个类、同一颗短杠、都是 role=separator——四条边界是同一种东西', async () => {
    setViewport(2560, 1440)
    render(<WorkbenchOverlay {...props()} />)
    await screen.findByRole('heading', { name: '工作台' })
    await waitFor(() => expect(screen.getByLabelText(LABEL_RAIL)).toBeTruthy())

    for (const label of [LABEL_RAIL, LABEL_BAND, LABEL_DECK_H, LABEL_DECK_1, LABEL_DECK_3]) {
      const handle = screen.getByLabelText(label)
      expect(handle.classList.contains('ben-wb__split')).toBe(true)
      expect(handle.getAttribute('role')).toBe('separator')
      expect(handle.querySelector('.ben-wb__split-grip')).not.toBeNull()
      expect(handle.getAttribute('data-dragging')).toBe('false')
    }
    // 上下那根是横的(row-resize),其余四根是竖的——朝向是它们唯一的区别。
    expect(screen.getByLabelText(LABEL_DECK_H).getAttribute('data-split-axis')).toBe('horizontal')
    expect(screen.getByLabelText(LABEL_DECK_H).classList.contains('ben-wb__split--h')).toBe(true)
    expect(screen.getByLabelText(LABEL_RAIL).getAttribute('data-split-axis')).toBe('vertical')
  })

  it('拖动中那一根变色(data-dragging),松手归位;别的几根一直是 false', async () => {
    setViewport(2560, 1440)
    pinRect(800, 1000)
    render(<WorkbenchOverlay {...props()} />)
    await screen.findByRole('heading', { name: '工作台' })
    await waitFor(() => expect(screen.getByLabelText(LABEL_DECK_1)).toBeTruthy())

    const handle = screen.getByLabelText(LABEL_DECK_1)
    fireEvent.pointerDown(handle, { clientX: 100, pointerId: 1 })
    expect(handle.getAttribute('data-dragging')).toBe('true')
    // 底部三根各有各的 key:拖第一根时第三根不该跟着变色(它们的左格 id 不同)。
    expect(screen.getByLabelText(LABEL_DECK_3).getAttribute('data-dragging')).toBe('false')
    fireEvent.pointerUp(handle, { pointerId: 1 })
    expect(handle.getAttribute('data-dragging')).toBe('false')
  })

  it('窗位槽被收起时左栏与那根把手一起不画——栏没有主人,边界也就不存在', async () => {
    setViewport(2560, 1440)
    render(<WorkbenchOverlay {...props()} />)
    await screen.findByRole('heading', { name: '工作台' })
    await waitFor(() => expect(screen.getByRole('button', { name: '窗口槽 收起' })).toBeTruthy())

    act(() => { screen.getByRole('button', { name: '窗口槽 收起' }).click() })
    await waitFor(() => expect(screen.queryByLabelText(LABEL_RAIL)).toBeNull())
    // 中区也没了,「窗口槽 | 项目区」那根同理不画;底部那几根不受影响。
    expect(screen.queryByLabelText(LABEL_BAND)).toBeNull()
    expect(screen.getByLabelText(LABEL_DECK_1)).toBeTruthy()
  })
})

// ───────────────────────────────────────────────────────────────────────────
describe('② 每一根拖出来的都落进 layout.landscape', () => {
  it('拖左栏那根 → landscape.rail_pct(起点是量出来的真实宽度,不是猜的)', async () => {
    setViewport(2560, 1440)
    pinRect(800, 1000)
    const calls: { url: string, body: unknown }[] = []
    const state = snapshot()
    render(<WorkbenchOverlay {...props({ state, fetchImpl: fakeFetchRecording(state, calls) })} />)
    await screen.findByRole('heading', { name: '工作台' })
    await waitFor(() => expect(screen.getByLabelText(LABEL_RAIL)).toBeTruthy())

    const handle = screen.getByLabelText(LABEL_RAIL)
    // 左栏自己那份矩形单独钉成 80px:全局桩会让左栏跟上半条一样宽(800),
    // 那样起点恒为 100% —— 量真实几何这条路就测不出来了。
    const rail = document.querySelector('.ben-wb__land-rail') as HTMLElement
    rail.getBoundingClientRect = (() => ({
      x: 0, y: 0, width: 80, height: 1000, top: 0, left: 0, right: 80, bottom: 1000, toJSON() {},
    })) as never

    calls.length = 0
    // 起点 80/800 = 10%;右移 80px / 800px = +10% → 20%。
    fireEvent.pointerDown(handle, { clientX: 100, pointerId: 1 })
    fireEvent.pointerMove(handle, { clientX: 180, pointerId: 1 })
    fireEvent.pointerUp(handle, { pointerId: 1 })

    const posted = await lastPostedLayout(calls)
    expect(posted.landscape?.rail_pct).toBeCloseTo(20, 5)
    // 竖屏那份一个字没变(不可越界):顶层 modules 仍是默认那一套。
    expect(posted.modules.map(m => m.id)).toEqual(DEFAULT_LAYOUT.modules.map(m => m.id))
  })

  it('拖底部两格之间那根 → 这两格的 width_pct 此消彼长,和恒定;另外两格一个字没动', async () => {
    setViewport(2560, 1440)
    pinRect(800, 1000)
    const calls: { url: string, body: unknown }[] = []
    const state = snapshot()
    render(<WorkbenchOverlay {...props({ state, fetchImpl: fakeFetchRecording(state, calls) })} />)
    await screen.findByRole('heading', { name: '工作台' })
    await waitFor(() => expect(screen.getByLabelText(LABEL_DECK_1)).toBeTruthy())

    calls.length = 0
    const handle = screen.getByLabelText(LABEL_DECK_1)
    fireEvent.pointerDown(handle, { clientX: 100, pointerId: 1 })
    fireEvent.pointerMove(handle, { clientX: 180, pointerId: 1 }) // +80/800 = +10%
    fireEvent.pointerUp(handle, { pointerId: 1 })

    const posted = await lastPostedLayout(calls)
    const width = (id: string): number | undefined => posted.landscape?.modules.find(m => m.id === id)?.width_pct
    expect(width('usage')).toBeCloseTo(35, 5)
    expect(width('quota')).toBeCloseTo(15, 5)
    expect((width('usage') ?? 0) + (width('quota') ?? 0)).toBeCloseTo(50, 5)
    // 没被这根把手夹在中间的两格保持 25 —— 拖一根只动它两边那两格。
    expect(width('notes')).toBe(25)
    expect(width('files')).toBe(25)
  })

  it('拖主区与底部一排之间那根横把手 → 底部四格的 basis_pct 一起改到同一个值', async () => {
    setViewport(2560, 1440)
    pinRect(800, 1000)
    const calls: { url: string, body: unknown }[] = []
    const state = snapshot()
    render(<WorkbenchOverlay {...props({ state, fetchImpl: fakeFetchRecording(state, calls) })} />)
    await screen.findByRole('heading', { name: '工作台' })
    await waitFor(() => expect(screen.getByLabelText(LABEL_DECK_H)).toBeTruthy())

    calls.length = 0
    const handle = screen.getByLabelText(LABEL_DECK_H)
    // 往上拖 100px:分母是模块区高度 1000 → -10% → 底部一排从 24 变 14(拖到下限)。
    fireEvent.pointerDown(handle, { clientY: 500, pointerId: 1 })
    fireEvent.pointerMove(handle, { clientY: 400, pointerId: 1 })
    fireEvent.pointerUp(handle, { pointerId: 1 })

    const posted = await lastPostedLayout(calls)
    const basis = posted.landscape!.modules
      .filter(m => ['usage', 'quota', 'notes', 'files'].includes(m.id))
      .map(m => m.basis_pct)
    expect(new Set(basis).size).toBe(1) // 四格恒等高,拖不出参差
    expect(landscapeDeckPct(posted)).toBe(14)
  })

  it('拖窗口槽|项目区那根(原来就有的一根)照旧改 width_pct,行为一字未变', async () => {
    setViewport(2560, 1440)
    pinRect(800, 1000)
    const calls: { url: string, body: unknown }[] = []
    const state = snapshot()
    render(<WorkbenchOverlay {...props({ state, fetchImpl: fakeFetchRecording(state, calls) })} />)
    await screen.findByRole('heading', { name: '工作台' })
    await waitFor(() => expect(screen.getByLabelText(LABEL_BAND)).toBeTruthy())

    calls.length = 0
    const handle = screen.getByLabelText(LABEL_BAND)
    fireEvent.pointerDown(handle, { clientX: 100, pointerId: 1 })
    fireEvent.pointerMove(handle, { clientX: 180, pointerId: 1 }) // +10%
    fireEvent.pointerUp(handle, { pointerId: 1 })

    const posted = await lastPostedLayout(calls)
    expect(posted.landscape?.modules.find(m => m.id === 'slot')?.width_pct).toBeCloseTo(74, 5)
    expect(posted.landscape?.modules.find(m => m.id === 'projects')?.width_pct).toBeCloseTo(26, 5)
  })
})

// ───────────────────────────────────────────────────────────────────────────
describe('③ 竖屏不受影响', () => {
  it('竖屏一根横把手、一根左栏把手都没有(那三条边界是横屏才有的)', async () => {
    setViewport(1440, 2560)
    const { container } = render(<WorkbenchOverlay {...props()} />)
    await screen.findByRole('heading', { name: '工作台' })
    await waitFor(() => {
      expect(container.querySelector('main.ben-wb')).toHaveAttribute('data-orientation', 'portrait')
    })
    expect(screen.queryByLabelText(LABEL_RAIL)).toBeNull()
    expect(screen.queryByLabelText(LABEL_DECK_H)).toBeNull()
    expect(container.querySelector('.ben-wb__split--h')).toBeNull()
    // 竖屏顶部那对分栏还在,而且还是竖的那一种。
    const splits = [...container.querySelectorAll('.ben-wb__split')]
    expect(splits.length).toBeGreaterThan(0)
    for (const split of splits) expect(split.getAttribute('data-split-axis')).toBe('vertical')
  })

  it('竖屏拖分栏写的仍然是顶层 modules,landscape 分支一个字都不生出来', async () => {
    setViewport(1440, 2560)
    pinRect(800, 1000)
    const calls: { url: string, body: unknown }[] = []
    const state = snapshot()
    const { container } = render(<WorkbenchOverlay {...props({ state, fetchImpl: fakeFetchRecording(state, calls) })} />)
    await screen.findByRole('heading', { name: '工作台' })
    await waitFor(() => {
      expect(container.querySelector('main.ben-wb')).toHaveAttribute('data-orientation', 'portrait')
    })

    calls.length = 0
    const handle = container.querySelector('.ben-wb__split') as HTMLElement
    fireEvent.pointerDown(handle, { clientX: 100, pointerId: 1 })
    fireEvent.pointerMove(handle, { clientX: 180, pointerId: 1 })
    fireEvent.pointerUp(handle, { pointerId: 1 })

    const posted = await lastPostedLayout(calls)
    expect(posted.landscape).toBeUndefined()
    expect(posted.modules.find(m => m.id === 'projects')?.width_pct).not.toBe(60)
  })
})

// ───────────────────────────────────────────────────────────────────────────
describe('④ 事务官浮窗落点按方向分别记', () => {
  it('纯函数:横屏写 landscape.butler_pos,竖屏写 butler.pos,互不串门', () => {
    const land = withButlerPos(DEFAULT_LAYOUT, 'landscape', { x_pct: 70, y_pct: 30 })
    expect(land.landscape?.butler_pos).toEqual({ x_pct: 70, y_pct: 30 })
    expect(land.butler.pos).toBeUndefined()
    // 写横屏落点时不能把横屏那份模块排布弄丢(它此前可能还没生成过)。
    expect(land.landscape?.modules).toEqual(DEFAULT_LANDSCAPE_MODULES)

    const both = withButlerPos(land, 'portrait', { x_pct: 5, y_pct: 5 })
    expect(both.butler.pos).toEqual({ x_pct: 5, y_pct: 5 })
    expect(both.landscape?.butler_pos).toEqual({ x_pct: 70, y_pct: 30 })
    expect(butlerPosOf(both, 'landscape')).toEqual({ x_pct: 70, y_pct: 30 })
    expect(butlerPosOf(both, 'portrait')).toEqual({ x_pct: 5, y_pct: 5 })
  })

  it('横屏那份缺席时 butlerPosOf 回 undefined —— 落点交给 CSS,不拿竖屏那份顶替', () => {
    const portraitOnly: WorkbenchLayout = {
      ...DEFAULT_LAYOUT,
      butler: { corner: 'br', min: false, pos: { x_pct: 3, y_pct: 3 } },
    }
    expect(butlerPosOf(portraitOnly, 'landscape')).toBeUndefined()
    expect(butlerPosOf(portraitOnly, 'portrait')).toEqual({ x_pct: 3, y_pct: 3 })
  })

  it('横屏下浮窗没有行内 left/top(走 CSS 默认落点),竖屏存过的坐标不会漏过来', async () => {
    setViewport(2560, 1440)
    const stored: WorkbenchLayout = {
      modules: DEFAULT_LAYOUT.modules.map(m => ({ ...m })),
      butler: { corner: 'br', min: false, pos: { x_pct: 2, y_pct: 2 } },
    }
    const state = snapshot({ layout: stored })
    const { container } = render(<WorkbenchOverlay {...props({ state })} />)
    await screen.findByRole('heading', { name: '工作台' })
    await waitFor(() => {
      expect(container.querySelector('main.ben-wb')).toHaveAttribute('data-orientation', 'landscape')
    })

    const butler = container.querySelector('.ben-wb__butler') as HTMLElement
    // pos 不传 → Butler.tsx 不写行内定位 → [data-corner=br] 那条 CSS 生效,
    // 而横屏下那条的 bottom 被 --ben-wb-land-butler-bottom 抬到了底部四格之上。
    expect(butler.style.left).toBe('')
    expect(butler.style.top).toBe('')
    expect(butler.getAttribute('data-corner')).toBe('br')
  })
})

// ───────────────────────────────────────────────────────────────────────────
describe('⑤ 纯函数:夹紧与「恢复默认布局」按方向', () => {
  it('左栏宽度两端夹死,拖到头也拖不没、拖不爆', () => {
    expect(landscapeRailPct(setLandscapeRailPct(DEFAULT_LAYOUT, -900))).toBe(LANDSCAPE_RAIL_MIN_PCT)
    expect(landscapeRailPct(setLandscapeRailPct(DEFAULT_LAYOUT, 900))).toBe(LANDSCAPE_RAIL_MAX_PCT)
    // 没拖过就是 undefined ——「缺席 = 定死 168px」,不折算成一个百分比替用户做主。
    expect(landscapeRailPct(DEFAULT_LAYOUT)).toBeUndefined()
    // 写左栏宽度不能把模块排布弄丢。
    expect(branchModules(setLandscapeRailPct(DEFAULT_LAYOUT, 12), 'landscape')).toEqual(DEFAULT_LANDSCAPE_MODULES)
  })

  it('底部两格之间:和恒定、两端各留下限,拖到头也不会把一格挤成零', () => {
    const far = resizeLandscapeDeckPair(DEFAULT_LAYOUT, 'usage', 'quota', 900)
    expect(landscapeDeckWidth(far, 'usage')).toBe(50 - LANDSCAPE_DECK_CELL_MIN_PCT)
    expect(landscapeDeckWidth(far, 'quota')).toBe(LANDSCAPE_DECK_CELL_MIN_PCT)
    const back = resizeLandscapeDeckPair(DEFAULT_LAYOUT, 'usage', 'quota', -900)
    expect(landscapeDeckWidth(back, 'usage')).toBe(LANDSCAPE_DECK_CELL_MIN_PCT)
    expect(landscapeDeckWidth(back, 'quota')).toBe(50 - LANDSCAPE_DECK_CELL_MIN_PCT)
    // 四格总和仍是 100 —— 拖任何一根都不会让底部一排留缝或溢出。
    const total = ['usage', 'quota', 'notes', 'files']
      .reduce((sum, id) => sum + landscapeDeckWidth(far, id), 0)
    expect(total).toBe(100)
  })

  it('不可改清单第 1、4 条:butler/foot 传进来一律原样返回,拖不动它们', () => {
    expect(resizeLandscapeDeckPair(DEFAULT_LAYOUT, 'butler', 'usage', 10)).toBe(DEFAULT_LAYOUT)
    expect(resizeLandscapeDeckPair(DEFAULT_LAYOUT, 'usage', 'foot', 10)).toBe(DEFAULT_LAYOUT)
    // 同一个 id 拖自己是无意义输入,原样返回而不是把它自己跟自己算一遍。
    expect(resizeLandscapeDeckPair(DEFAULT_LAYOUT, 'usage', 'usage', 10)).toBe(DEFAULT_LAYOUT)
  })

  it('「恢复默认布局」在横屏上把左栏宽度与横屏浮窗落点一起收回默认,竖屏那份原样保住', () => {
    let dragged: WorkbenchLayout = setLandscapeRailPct(DEFAULT_LAYOUT, 18)
    dragged = resizeLandscapeDeckPair(dragged, 'usage', 'quota', 8)
    dragged = withButlerPos(dragged, 'landscape', { x_pct: 66, y_pct: 40 })
    dragged = withButlerPos(dragged, 'portrait', { x_pct: 4, y_pct: 4 })

    const restored = resetLayout('landscape', dragged)
    expect(restored.landscape?.rail_pct).toBeUndefined()
    expect(restored.landscape?.butler_pos).toBeUndefined()
    expect(restored.landscape?.modules).toEqual(DEFAULT_LANDSCAPE_MODULES)
    // 竖屏那份**没被顺手抹掉**——这正是"按方向恢复"要钉的东西。
    expect(restored.butler.pos).toEqual({ x_pct: 4, y_pct: 4 })

    // 反过来:在竖屏上点恢复,横屏那支(左栏宽度、浮窗落点、拖过的四格)一个字不动。
    const restoredPortrait = resetLayout('portrait', dragged)
    expect(restoredPortrait.landscape?.rail_pct).toBe(18)
    expect(restoredPortrait.landscape?.butler_pos).toEqual({ x_pct: 66, y_pct: 40 })
    expect(landscapeDeckWidth(restoredPortrait, 'usage')).toBe(33)
  })
})
