/**
 * 横屏布局(2026-09-18,分支 feat/landscape-layout)。
 *
 * Ben 的主用屏是 1440×2560 竖屏,工作台此前只有竖屏那一版排布,拖到 2560×1440 的横屏上
 * 一格都不重排。这份文件钉四件事:
 *   ① 方向判定本身(纯函数,不碰 DOM);
 *   ② 横屏下那五个区域真的在 DOM 里;
 *   ③ 布局按方向分开存取,「恢复默认布局」只恢复当前方向那一份;
 *   ④ 窗位矩形上报的是**槽体在横屏下的真实位置**,不是竖屏那一份旧矩形。
 *
 * jsdom 没有 ResizeObserver(同 Workbench.tsx 槽体上报那段的先例),所以这里一律靠改
 * window.innerWidth/innerHeight + 派发 resize 来驱动方向——真机上多的那条 ResizeObserver
 * 通路量的是同一个元素、走的是同一个回调,不是另一条行为。
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, configure, render, screen, waitFor, within } from '@testing-library/react'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkbenchOverlay, type MinimalWebSocket, type WorkbenchOverlayProps } from '../src/client/Workbench.tsx'
import { createWorkbenchStore } from '../src/client/store.ts'
import {
  branchModules, DEFAULT_LANDSCAPE_MODULES, DEFAULT_LAYOUT, landscapeDeckPct,
  resetLayout, resizeLandscapeDeck, resizeRowPair, toggleHidden,
} from '../src/client/layout.ts'
import { LANDSCAPE_MIN_WIDTH_PX, measureOrientationBox, pickOrientation } from '../src/client/orientation.ts'
import type { WorkbenchLayout, WorkbenchState } from '../src/protocol.ts'
import { DEFAULT_MODULE_TITLES } from '../src/templates.ts'
import { UNUSED_STANDARD_PROPS } from './helpers/standardProps.ts'

/** 底部最后一格的正式标题(2026-10-23 起 files 格是 Graphify 图谱,与本体常量共源)。 */
const FILES_TITLE = DEFAULT_MODULE_TITLES.files

/**
 * 同 tests/client-pure-mode.test.tsx 的那条(2026-09-17 决策记录):`render()` 之后
 * `/state` 落地要重渲整棵工作台树(含十几万字符的内联 `<style>`),在 jsdom 里会把主线程
 * 堵住几百毫秒,testing-library 默认的 1000 毫秒 waitFor 预算连一次重试都轮不上。
 * 这里的方向切换同样要走那一拍重渲,放宽到 5 秒——只放宽本文件,不动全局默认值。
 */
configure({ asyncUtilTimeout: 5_000 })

const REAL_WIDTH = window.innerWidth
const REAL_HEIGHT = window.innerHeight

/** 把视口改成给定尺寸并派发一次 resize——壳窗口被拖到另一块屏在测试里就是这一下。 */
function setViewport(width: number, height: number): void {
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true, writable: true })
  Object.defineProperty(window, 'innerHeight', { value: height, configurable: true, writable: true })
  act(() => { window.dispatchEvent(new Event('resize')) })
}

afterEach(() => {
  cleanup()
  setViewport(REAL_WIDTH, REAL_HEIGHT)
  window.history.replaceState(null, '', '/')
})

function fakeWebSocket(): (url: string) => MinimalWebSocket {
  return () => ({ onmessage: null, onclose: null, close: () => {} })
}

/** 叠上有一扇窗在台前——不这样的话 butlerActive 为真,事务官档会盖住槽体(先例见 workbenchLayout.test.tsx)。 */
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

// ───────────────────────────────────────────────────────────────────────────
describe('① 方向判定(pickOrientation)', () => {
  it('Ben 那两块屏各判各的:1440×2560 竖、2560×1440 横', () => {
    expect(pickOrientation(1440, 2560)).toBe('portrait')
    expect(pickOrientation(2560, 1440)).toBe('landscape')
  })

  it('宽 > 高但宽不到 1200 仍然走竖屏——五个区域挤不下时竖屏是更好的那个,不是将就的那个', () => {
    expect(pickOrientation(1000, 700)).toBe('portrait')
    expect(pickOrientation(LANDSCAPE_MIN_WIDTH_PX - 1, 700)).toBe('portrait')
    expect(pickOrientation(LANDSCAPE_MIN_WIDTH_PX, 700)).toBe('landscape')
  })

  it('正方形(宽等于高)算竖屏:判据是「宽 > 高」,不是「宽 >= 高」', () => {
    expect(pickOrientation(1600, 1600)).toBe('portrait')
  })

  it('量不到(0 / 负数 / NaN)一律竖屏——「量不到」不是「是横屏」(D13 降级纪律)', () => {
    expect(pickOrientation(0, 0)).toBe('portrait')
    expect(pickOrientation(2560, 0)).toBe('portrait')
    expect(pickOrientation(Number.NaN, 1440)).toBe('portrait')
    expect(pickOrientation(-2560, -1440)).toBe('portrait')
  })

  // 量的是**视口**,不是某个元素——理由(踩过的坑)见 orientation.ts 的 measureOrientationBox。
  // 这条用例的价值不在这一行等式,而在它旁边那段注释:谁要是又想改回"优先量元素",
  // 先去看一眼 client-dock.test.tsx 的稳定性门那三条为什么会被全局矩形桩带进横屏。
  it('量的是视口,原样返回', () => {
    expect(measureOrientationBox({ width: 2560, height: 1440 })).toEqual({ width: 2560, height: 1440 })
  })
})

// ───────────────────────────────────────────────────────────────────────────
describe('② 横屏 DOM 结构:五个区域', () => {
  beforeEach(() => { setViewport(2560, 1440) })

  it('左栏 / 中区 / 右栏 / 底部四格 / 最底一行 —— 五个都在,且带 data-orientation=landscape', async () => {
    const { container } = render(<WorkbenchOverlay {...props()} />)
    await screen.findByRole('heading', { name: '工作台' })

    await waitFor(() => {
      expect(container.querySelector('main.ben-wb')).toHaveAttribute('data-orientation', 'landscape')
    })
    for (const region of ['rail', 'stage', 'side', 'deck', 'foot']) {
      expect(container.querySelector(`[data-land-region="${region}"]`)).not.toBeNull()
    }
  })

  it('中区放的是窗位槽本体(.ben-wb__slot-body),右栏放的是项目区', async () => {
    const { container } = render(<WorkbenchOverlay {...props()} />)
    await screen.findByRole('heading', { name: '工作台' })

    await waitFor(() => {
      const stage = container.querySelector('[data-land-region="stage"]')
      expect(stage?.querySelector('.ben-wb__slot-body')).not.toBeNull()
    })
    const side = container.querySelector('[data-land-region="side"]') as HTMLElement
    expect(within(side).getByRole('heading', { name: '项目区' })).toBeTruthy()
  })

  it(`底部一排正好四格,顺序是 消耗数据 / 余额 / 随手记 / ${DEFAULT_MODULE_TITLES.files}`, async () => {
    const { container } = render(<WorkbenchOverlay {...props()} />)
    await screen.findByRole('heading', { name: '工作台' })

    await waitFor(() => {
      expect(container.querySelector('[data-land-region="deck"]')).not.toBeNull()
    })
    const deck = container.querySelector('[data-land-region="deck"]') as HTMLElement
    const titles = [...deck.querySelectorAll('.ben-wb__ttl')].map(el => el.textContent)
    expect(titles).toEqual(['消耗数据', '余额 / 额度', '随手记', FILES_TITLE])
  })

  it('应用栏的标签**只有一份**:提到左栏之后,窗位槽模块里不再画第二份(两份会各跑一遍已读计时器)', async () => {
    const { container } = render(<WorkbenchOverlay {...props()} />)
    await screen.findByRole('heading', { name: '工作台' })

    await waitFor(() => {
      expect(container.querySelector('[data-land-region="rail"]')).not.toBeNull()
    })
    const tabBars = screen.getAllByRole('group', { name: '窗位叠标签' })
    expect(tabBars).toHaveLength(1)
    const rail = container.querySelector('[data-land-region="rail"]') as HTMLElement
    expect(rail.contains(tabBars[0]!)).toBe(true)
  })

  it('不可改清单第 1、4 条在横屏下照常:日结条与事务官浮窗都在(PRD §9)', async () => {
    render(<WorkbenchOverlay {...props()} />)
    expect(await screen.findByText(/^日结/)).toBeTruthy()
    expect(screen.getByText(/AI 悬浮窗.*不可改/)).toBeTruthy()
  })

  it('竖屏下一个 land 区域都不画,DOM 与从前一致(旧排布零回归)', async () => {
    setViewport(1440, 2560)
    const { container } = render(<WorkbenchOverlay {...props()} />)
    await screen.findByRole('heading', { name: '工作台' })

    await waitFor(() => {
      expect(container.querySelector('main.ben-wb')).toHaveAttribute('data-orientation', 'portrait')
    })
    expect(container.querySelector('[data-land-region="rail"]')).toBeNull()
    expect(container.querySelector('[data-land-region="stage"]')).toBeNull()
    expect(container.querySelector('[data-land-region="deck"]')).toBeNull()
    // 竖屏的行容器还在;最底一行是横竖共用的同一条,所以 foot 这一个是例外。
    expect(container.querySelector('.ben-wb__row')).not.toBeNull()
  })

  it('尺寸一变就跟着切,不用刷新(拖到另一块屏)', async () => {
    const { container } = render(<WorkbenchOverlay {...props()} />)
    await screen.findByRole('heading', { name: '工作台' })

    setViewport(1440, 2560)
    await waitFor(() => {
      expect(container.querySelector('main.ben-wb')).toHaveAttribute('data-orientation', 'portrait')
    })
    setViewport(2560, 1440)
    await waitFor(() => {
      expect(container.querySelector('main.ben-wb')).toHaveAttribute('data-orientation', 'landscape')
    })
    expect(container.querySelector('[data-land-region="stage"]')).not.toBeNull()
  })
})

// ───────────────────────────────────────────────────────────────────────────
describe('③ 布局按方向分开存取', () => {
  it('横屏分支缺席时读到的是横屏默认排布,竖屏那份原样不动', () => {
    expect(branchModules(DEFAULT_LAYOUT, 'landscape')).toEqual(DEFAULT_LANDSCAPE_MODULES)
    expect(branchModules(DEFAULT_LAYOUT, 'portrait')).toEqual(DEFAULT_LAYOUT.modules)
  })

  it('横屏收起一个模块,只写进 landscape 分支;竖屏那份一个字没变', () => {
    const next = toggleHidden(DEFAULT_LAYOUT, 'notes', 'landscape')
    expect(next.landscape?.modules.find(m => m.id === 'notes')?.hidden).toBe(true)
    expect(next.modules).toEqual(DEFAULT_LAYOUT.modules)
    // 反过来同理:竖屏改的不落进横屏分支。
    const back = toggleHidden(next, 'notes', 'portrait')
    expect(back.modules.find(m => m.id === 'notes')?.hidden).toBe(true)
    expect(back.landscape?.modules.find(m => m.id === 'notes')?.hidden).toBe(true)
  })

  it('横屏拖分栏改的是 landscape 分支里的 width_pct,两边和恒为 100', () => {
    const next = resizeRowPair(DEFAULT_LAYOUT, 'slot', 'projects', 10, 'landscape')
    const slot = next.landscape?.modules.find(m => m.id === 'slot')
    const projects = next.landscape?.modules.find(m => m.id === 'projects')
    expect(slot?.width_pct).toBe(74)
    expect(projects?.width_pct).toBe(26)
    expect((slot?.width_pct ?? 0) + (projects?.width_pct ?? 0)).toBe(100)
    expect(next.modules).toEqual(DEFAULT_LAYOUT.modules)
  })

  it('底部一排四格恒等高——拖任意一格,四格一起改到同一个值', () => {
    const next = resizeLandscapeDeck(DEFAULT_LAYOUT, 6)
    const basis = next.landscape!.modules
      .filter(m => ['usage', 'quota', 'notes', 'files'].includes(m.id))
      .map(m => m.basis_pct)
    expect(new Set(basis).size).toBe(1)
    expect(landscapeDeckPct(next)).toBe(30)
  })

  it('底部一排的高度上下夹死:拖到头也不会把中间贴窗那块挤没', () => {
    expect(landscapeDeckPct(resizeLandscapeDeck(DEFAULT_LAYOUT, -900))).toBe(14)
    expect(landscapeDeckPct(resizeLandscapeDeck(DEFAULT_LAYOUT, 900))).toBe(48)
  })

  it('「恢复默认布局」按当前方向恢复:在横屏上点它,竖屏那版拖过的排布保住', () => {
    const dragged = resizeLandscapeDeck(toggleHidden(DEFAULT_LAYOUT, 'notes', 'portrait'), 8)
    expect(dragged.modules.find(m => m.id === 'notes')?.hidden).toBe(true)

    const restoredLandscape = resetLayout('landscape', dragged)
    expect(restoredLandscape.landscape?.modules).toEqual(DEFAULT_LANDSCAPE_MODULES)
    // 竖屏那份**没被顺手抹掉**——这正是这条用例要钉的东西。
    expect(restoredLandscape.modules.find(m => m.id === 'notes')?.hidden).toBe(true)

    const restoredPortrait = resetLayout('portrait', dragged)
    expect(restoredPortrait.modules).toEqual(DEFAULT_LAYOUT.modules)
    expect(landscapeDeckPct(restoredPortrait)).toBe(landscapeDeckPct(dragged))
  })

  it('无参 resetLayout() 行为逐字不变(既有调用点与既有用例不受影响)', () => {
    expect(resetLayout()).toEqual({
      modules: DEFAULT_LAYOUT.modules.map(m => ({ ...m })),
      butler: { ...DEFAULT_LAYOUT.butler },
    })
  })

  it('横屏收起「随手记」后落盘的是 layout.landscape,竖屏 modules 原样 POST 回去', async () => {
    setViewport(2560, 1440)
    const calls: { url: string, body: unknown }[] = []
    const stored: WorkbenchLayout = {
      modules: DEFAULT_LAYOUT.modules.map(m => ({ ...m })),
      butler: { corner: 'br', min: false },
    }
    const state = snapshot({ layout: stored })
    render(<WorkbenchOverlay {...props({ state, fetchImpl: fakeFetchRecording(state, calls) })} />)
    await screen.findByRole('heading', { name: '工作台' })
    await waitFor(() => expect(screen.getByRole('button', { name: '随手记 收起' })).toBeTruthy())

    screen.getByRole('button', { name: '随手记 收起' }).click()

    await waitFor(() => expect(calls.some(c => c.url.endsWith('/layout'))).toBe(true))
    const posted = calls.filter(c => c.url.endsWith('/layout')).at(-1)?.body as { layout: WorkbenchLayout }
    expect(posted.layout.landscape?.modules.find(m => m.id === 'notes')?.hidden).toBe(true)
    expect(posted.layout.modules.find(m => m.id === 'notes')?.hidden).toBeUndefined()
  })
})

// ───────────────────────────────────────────────────────────────────────────
describe('④ 窗位矩形:横屏下报的是槽在横屏里的真实位置', () => {
  // 只有壳内页面有资格上报(2026-08-25 那条纪律),先例见 tests/client-dock.test.tsx。
  beforeEach(() => { window.history.replaceState(null, '', '/?ben-workbench=app') })

  it('从竖屏切到横屏后重新上报,且报的是槽体此刻量出来的矩形、带 reason:"resize"', async () => {
    setViewport(1440, 2560)
    const calls: { url: string, body: unknown }[] = []
    const state = snapshot()
    const { container } = render(
      <WorkbenchOverlay {...props({ state, fetchImpl: fakeFetchRecording(state, calls) })} />,
    )
    await screen.findByRole('heading', { name: '工作台' })
    await waitFor(() => {
      expect(container.querySelector('main.ben-wb')).toHaveAttribute('data-orientation', 'portrait')
    })

    // jsdom 的 getBoundingClientRect 恒为 0,自己给槽体钉两个不同的矩形:竖屏一份、横屏一份。
    // 钉在**元素身上**而不是原型上——切换之后拿到的是同一个 DOM 元素还是新的一个,
    // 这条用例不假设,两种情况都要报出横屏那份。
    const portraitRect = { x: 20, y: 900, width: 1400, height: 1000 }
    const landscapeRect = { x: 188, y: 120, width: 1500, height: 900 }
    let current = portraitRect
    const pin = (): void => {
      const el = container.querySelector('.ben-wb__slot-body') as HTMLElement | null
      if (el !== null) {
        el.getBoundingClientRect = (() => ({ ...current, top: current.y, left: current.x })) as never
      }
    }
    pin()

    calls.length = 0
    current = landscapeRect
    setViewport(2560, 1440)
    await waitFor(() => {
      expect(container.querySelector('[data-land-region="stage"]')).not.toBeNull()
    })
    pin()
    // 方向翻档后再踢一次量测(真机上这一下由 ResizeObserver 触发,jsdom 没有)。
    setViewport(2560, 1440 - 1)
    setViewport(2560, 1440)

    await waitFor(() => {
      const rects = calls.filter(c => c.url.endsWith('/slot/rect'))
      const body = rects.at(-1)?.body as { rect: { x: number, w: number }, reason?: string } | undefined
      expect(body?.rect.x).toBe(landscapeRect.x)
      expect(body?.rect.w).toBe(landscapeRect.width)
    })
    // 方向翻档是"用户明确动作后的稳定态"(他把窗口拖到了另一块屏),要带 reason
    // 让贴住的原生窗跟着挪——不带的话窗会停在竖屏那块已经改由别的模块占着的区域上。
    const withReason = calls
      .filter(c => c.url.endsWith('/slot/rect'))
      .some(c => (c.body as { reason?: string }).reason === 'resize')
    expect(withReason).toBe(true)
  })

  it('横屏下窗位槽被收起 → 照旧发 {rect:null} 让矩形失效(与竖屏同一条路径)', async () => {
    setViewport(2560, 1440)
    const calls: { url: string, body: unknown }[] = []
    const state = snapshot()
    render(<WorkbenchOverlay {...props({ state, fetchImpl: fakeFetchRecording(state, calls) })} />)
    await screen.findByRole('heading', { name: '工作台' })
    await waitFor(() => expect(screen.getByRole('button', { name: '窗口槽 收起' })).toBeTruthy())

    calls.length = 0
    screen.getByRole('button', { name: '窗口槽 收起' }).click()

    await waitFor(() => {
      expect(calls.some(c => c.url.endsWith('/slot/rect') && (c.body as { rect: unknown }).rect === null)).toBe(true)
    })
  })
})
