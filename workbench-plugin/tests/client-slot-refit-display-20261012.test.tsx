/**
 * 跨屏 / 换缩放比后窗口槽重贴(2026-10-12,卡 `claude/ops-patch-1012`;运营同学 10-09 在 0.4.98 产物上修的那一条)。
 *
 * 他的根因分析(维护包 README):「原实现只监听 window.resize 和槽体 ResizeObserver。工作台窗口在两块屏幕之间移动时,
 * 如果逻辑宽高没变,两种监听都不会触发,服务端就继续使用上一块屏幕的槽位坐标。」
 *
 * 这份文件只钉客户端那一半:
 *   ① 壳窗口的屏幕位置变了(screenX/Y)、视口宽高没变 → 半秒内带 reason:'resize' 重报一次;
 *   ② 窗口重新拿到焦点时立刻比一次(接屏 / 唤醒后点回来就自愈);
 *   ③ 签名没变 → 一次都不多报(轮询不是「每半秒报一次」);
 *   ④ 卸载后定时器与 focus 监听都清掉。
 * 服务端那一半(收到带 reason 的新矩形就重贴 current)在 tests/server-dock.test.ts「方向切换后重贴」那一组。
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, configure, render, waitFor } from '@testing-library/react'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SLOT_DISPLAY_POLL_MS, WorkbenchOverlay, type MinimalWebSocket, type WorkbenchOverlayProps } from '../src/client/Workbench.tsx'
import { createWorkbenchStore } from '../src/client/store.ts'
import type { WorkbenchState } from '../src/protocol.ts'
import { UNUSED_STANDARD_PROPS } from './helpers/standardProps.ts'

configure({ asyncUtilTimeout: 5_000 })

const SLOT = { x: 20, y: 900, width: 1400, height: 847 }

function pinSlotRect(): void {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function rect() {
    const r = SLOT
    return { ...r, top: r.y, left: r.x, right: r.x + r.width, bottom: r.y + r.height, toJSON: () => r } as DOMRect
  })
}

function setScreenPosition(x: number, y: number): void {
  Object.defineProperty(window, 'screenX', { value: x, configurable: true, writable: true })
  Object.defineProperty(window, 'screenY', { value: y, configurable: true, writable: true })
}

function fakeWebSocket(): (url: string) => MinimalWebSocket {
  return () => ({ onmessage: null, onclose: null, close: () => {} })
}

function snapshot(): WorkbenchState {
  return {
    agents: [{ id: 'dsh', online: true, connected: true, waiting: 0, running: 0 }],
    sessions: [],
    quota: {},
    now: '2026-10-12T10:03:00+08:00',
    stale: false,
    dock: { stack: [{ key: 'claude', label: 'Claude', running: true, current: true }] },
  }
}

type RectCall = { rect: { x: number, y: number, w: number, h: number } | null, reason?: string }

function fakeFetchRecording(state: WorkbenchState, calls: RectCall[]) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      if (String(url).endsWith('/slot/rect')) calls.push(JSON.parse(String(init.body)) as RectCall)
      return { ok: true, json: async () => ({ ok: true }) }
    }
    return { ok: true, json: async () => state }
  }) as unknown as typeof fetch
}

function props(fetchImpl: typeof fetch): WorkbenchOverlayProps {
  const instance = createWorkbenchStore().create()
  const workspaceState = { items: [], phase: 'ready', archivedSessionIds: [], state: 'idle', error: null, baselinesReady: true, recentWorkspaceId: undefined }
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

async function paint(): Promise<{ calls: RectCall[], unmount: () => void }> {
  const calls: RectCall[] = []
  const view = render(<WorkbenchOverlay {...props(fakeFetchRecording(snapshot(), calls))} />)
  // 先等挂载那一次被动上报(不带 reason)发出去,后面的断言才数得清。
  await waitFor(() => expect(calls.length).toBeGreaterThan(0))
  await new Promise(r => setTimeout(r, SLOT_DISPLAY_POLL_MS + 100))
  return { calls, unmount: view.unmount }
}

describe('壳窗口换了屏 → 重报槽矩形(带 reason:resize)', () => {
  beforeEach(() => {
    window.history.replaceState(null, '', '/?ben-workbench=app')
    pinSlotRect()
    setScreenPosition(0, 0)
  })
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('★视口宽高一字没变、只有屏幕位置变了 → 半秒内带 reason:resize 报一次', async () => {
    const { calls } = await paint()
    const before = calls.length
    setScreenPosition(2560, 0) // 拖到右边那块同尺寸的外接屏
    await waitFor(() => expect(calls.length).toBeGreaterThan(before), { timeout: SLOT_DISPLAY_POLL_MS * 4 })
    const last = calls.at(-1)
    expect(last?.reason).toBe('resize')
    expect(last?.rect).toEqual({ x: SLOT.x, y: SLOT.y, w: SLOT.width, h: SLOT.height })
  })

  it('窗口重新拿到焦点 → 立刻比一次,不等那半秒', async () => {
    const { calls } = await paint()
    const before = calls.length
    setScreenPosition(0, 1440)
    act(() => { window.dispatchEvent(new Event('focus')) })
    expect(calls.length).toBe(before + 1)
    expect(calls.at(-1)?.reason).toBe('resize')
  })

  it('★签名没变 → 轮询一次都不多报', async () => {
    const { calls } = await paint()
    const before = calls.length
    await new Promise(r => setTimeout(r, SLOT_DISPLAY_POLL_MS * 2 + 100))
    act(() => { window.dispatchEvent(new Event('focus')) })
    expect(calls.length).toBe(before)
  })

  it('卸载后换屏也不再报(定时器与 focus 监听都清了)', async () => {
    const { calls, unmount } = await paint()
    unmount()
    const before = calls.length
    setScreenPosition(2560, 0)
    act(() => { window.dispatchEvent(new Event('focus')) })
    await new Promise(r => setTimeout(r, SLOT_DISPLAY_POLL_MS * 2 + 100))
    expect(calls.length).toBe(before)
  })
})
