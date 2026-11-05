/**
 * 方向切换后窗口槽重贴(2026-09-21,分支 fix/slot-refit-on-orientation)。
 *
 * Ben 的原话:「我在横屏拉过来的时候,中间应用窗口是太长的,拉到竖屏之后应用窗口
 * 还是超出的,我自己又拉回横屏拉小之后再拉回来竖屏。」
 *
 * 这份文件只钉客户端那一半:**方向一翻档,立刻**把槽体此刻的真矩形带 reason:'resize'
 * 报上去,不等 800ms 去抖、不靠 ResizeObserver 再踢一脚。服务端那一半(收到变了的矩形
 * 就把当前在台的窗按新矩形贴一次)在 tests/server-dock.test.ts「方向切换后重贴」那一组。
 *
 * 量矩形的桩跟 client-landscape.test.tsx 不同,是**活的**:同一个 stub 按此刻的
 * window.innerWidth 回竖屏那份还是横屏那份——真浏览器里 getBoundingClientRect 就是这样,
 * 什么时候量都给你当下的真值。client-landscape.test.tsx 那条用例把矩形钉死在元素身上、
 * 翻档后还得手动 pin 一次再踢一次 resize,恰好把"翻档那一拍量到的是旧矩形"这件事糊过去了。
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, configure, render, screen, waitFor } from '@testing-library/react'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkbenchOverlay, type MinimalWebSocket, type WorkbenchOverlayProps } from '../src/client/Workbench.tsx'
import { createWorkbenchStore } from '../src/client/store.ts'
import type { WorkbenchState } from '../src/protocol.ts'
import { UNUSED_STANDARD_PROPS } from './helpers/standardProps.ts'

configure({ asyncUtilTimeout: 5_000 })

const REAL_WIDTH = window.innerWidth
const REAL_HEIGHT = window.innerHeight

/** 竖屏 1440×2560 下槽体的样子(数量级照 docs/交接-0918-横屏布局.md 里真量到的)。 */
const PORTRAIT_SLOT = { x: 20, y: 900, width: 1400, height: 847 }
/** 横屏 2560×1440 下槽体的样子——位置尺寸全变。 */
const LANDSCAPE_SLOT = { x: 188, y: 120, width: 1495, height: 879 }
/** 换屏途中那一拍(壳窗口宽已经变了、高还没跟上):判出来还是竖屏,但槽体矮了一大截。 */
const HALFWAY_SLOT = { x: 20, y: 500, width: 1400, height: 300 }

function setViewport(width: number, height: number): void {
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true, writable: true })
  Object.defineProperty(window, 'innerHeight', { value: height, configurable: true, writable: true })
  act(() => { window.dispatchEvent(new Event('resize')) })
}

/**
 * 活的量测桩:按**此刻**的视口回该方向那份矩形。挂在 Element.prototype 上(先例见
 * tests/client-dock.test.tsx 的 stubSlotRect)——方向判定量的是 window.innerWidth,
 * 不量元素(见 orientation.ts measureOrientationBox 那段注释),所以不会被它带偏。
 */
function stubLiveSlotRect(): void {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function rect() {
    const r = window.innerWidth > window.innerHeight
      ? LANDSCAPE_SLOT
      : (window.innerHeight <= 1600 ? HALFWAY_SLOT : PORTRAIT_SLOT)
    return { ...r, top: r.y, left: r.x, right: r.x + r.width, bottom: r.y + r.height, toJSON: () => r } as DOMRect
  })
}

function fakeWebSocket(): (url: string) => MinimalWebSocket {
  return () => ({ onmessage: null, onclose: null, close: () => {} })
}

function dockWithCurrent(): { stack: readonly { key: string, label: string, running: boolean, current: boolean }[] } {
  return { stack: [{ key: 'claude', label: 'Claude', running: true, current: true }] }
}

function snapshot(over: Partial<WorkbenchState> = {}): WorkbenchState {
  return {
    agents: [{ id: 'dsh', online: true, connected: true, waiting: 0, running: 0 }],
    sessions: [],
    quota: {},
    now: '2026-09-21T10:03:00+08:00',
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

type RectCall = { rect: { x: number, y: number, w: number, h: number } | null, reason?: string }

function slotRects(calls: { url: string, body: unknown }[]): RectCall[] {
  return calls.filter(c => c.url.endsWith('/slot/rect')).map(c => c.body as RectCall)
}

describe('方向翻档 → 立刻上报新槽矩形(不等 800ms 去抖)', () => {
  beforeEach(() => {
    window.history.replaceState(null, '', '/?ben-workbench=app')
    stubLiveSlotRect()
  })
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    setViewport(REAL_WIDTH, REAL_HEIGHT)
    window.history.replaceState(null, '', '/')
  })

  it('★竖 → 横:翻档那一拍就报出横屏那份矩形、带 reason:"resize"(去抖那一路一次都不用等)', async () => {
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
    await waitFor(() => expect(slotRects(calls).length).toBeGreaterThan(0))

    calls.length = 0
    setViewport(2560, 1440)

    // 去抖是 800ms;这里只给 400ms 的预算,能拿到就证明走的不是去抖那条路。
    await waitFor(() => {
      const refit = slotRects(calls).find(c => c.reason === 'resize')
      expect(refit?.rect).toEqual({ x: LANDSCAPE_SLOT.x, y: LANDSCAPE_SLOT.y, w: LANDSCAPE_SLOT.width, h: LANDSCAPE_SLOT.height })
    }, { timeout: 400 })
  })

  it('★横 → 竖(Ben 踩的那一下):翻回竖屏同样立刻报竖屏那份矩形、带 reason:"resize"', async () => {
    setViewport(2560, 1440)
    const calls: { url: string, body: unknown }[] = []
    const state = snapshot()
    const { container } = render(
      <WorkbenchOverlay {...props({ state, fetchImpl: fakeFetchRecording(state, calls) })} />,
    )
    await screen.findByRole('heading', { name: '工作台' })
    await waitFor(() => {
      expect(container.querySelector('main.ben-wb')).toHaveAttribute('data-orientation', 'landscape')
    })
    await waitFor(() => expect(slotRects(calls).length).toBeGreaterThan(0))

    calls.length = 0
    setViewport(1440, 2560)

    await waitFor(() => {
      const refit = slotRects(calls).find(c => c.reason === 'resize')
      expect(refit?.rect).toEqual({ x: PORTRAIT_SLOT.x, y: PORTRAIT_SLOT.y, w: PORTRAIT_SLOT.width, h: PORTRAIT_SLOT.height })
    }, { timeout: 400 })
  })

  /**
   * ★根因用例。壳窗口被拖到另一块屏时,WKWebView 的 resize **不是一拍到位**:
   * 先来一拍宽已经变了、高还没跟上的中间尺寸(这一拍已经足以把方向翻档),真正的最终
   * 尺寸随后才到。翻档那一拍报的是中间那份矮矩形(带 reason,服务端照它贴了一次),
   * 最终那一拍方向没再变、slot 的 basis 也没变——**签名一个字没动**,于是只走 800ms
   * 去抖那条被动路径、不带 reason,服务端存下新矩形却不动窗。
   *
   * 真机上的样子正是 Ben 说的:窗还是旧方向的尺寸、超出槽。
   */
  it('★换屏途中 resize 分两拍到位:最终那一拍(方向没再翻)也要带 reason:"resize",不然窗永远停在旧尺寸', async () => {
    setViewport(2560, 1440)
    const calls: { url: string, body: unknown }[] = []
    const state = snapshot()
    const { container } = render(
      <WorkbenchOverlay {...props({ state, fetchImpl: fakeFetchRecording(state, calls) })} />,
    )
    await screen.findByRole('heading', { name: '工作台' })
    await waitFor(() => {
      expect(container.querySelector('main.ben-wb')).toHaveAttribute('data-orientation', 'landscape')
    })
    await waitFor(() => expect(slotRects(calls).length).toBeGreaterThan(0))

    calls.length = 0
    // 第一拍:宽已经收到 1440、高还停在 1440 —— 方向就在这一拍翻成竖屏。
    setViewport(1440, 1440)
    await waitFor(() => {
      expect(container.querySelector('main.ben-wb')).toHaveAttribute('data-orientation', 'portrait')
    })
    // 第二拍:高补到 2560,壳窗口这才真的铺满竖屏。方向没再变,签名一个字没动。
    setViewport(1440, 2560)

    await waitFor(() => {
      const refit = slotRects(calls).filter(c => c.reason === 'resize').at(-1)
      expect(refit?.rect).toEqual({ x: PORTRAIT_SLOT.x, y: PORTRAIT_SLOT.y, w: PORTRAIT_SLOT.width, h: PORTRAIT_SLOT.height })
    }, { timeout: 2500 })
  })

  it('页面内部抖动(壳窗口尺寸没变)照旧只报被动矩形——S5 那条纪律不松口', async () => {
    setViewport(1440, 2560)
    const calls: { url: string, body: unknown }[] = []
    const state = snapshot()
    render(<WorkbenchOverlay {...props({ state, fetchImpl: fakeFetchRecording(state, calls) })} />)
    await screen.findByRole('heading', { name: '工作台' })
    await waitFor(() => expect(slotRects(calls).length).toBeGreaterThan(0))

    calls.length = 0
    // 视口一个像素没动,只是页面里有人喊了一声 resize(轮询回来重渲、标签栏冒出来那一类)。
    act(() => { window.dispatchEvent(new Event('resize')) })

    await new Promise(resolve => setTimeout(resolve, 1200))
    expect(slotRects(calls).some(c => c.reason === 'resize')).toBe(false)
  })
})
