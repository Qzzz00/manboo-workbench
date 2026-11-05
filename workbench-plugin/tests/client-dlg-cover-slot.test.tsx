/**
 * 弹层盖住窗位(2026-09-14,Ben:「设置按钮点击之后,现在会把在前端的页面隐藏,看下来有点像坏了,
 * 要不就是它刚好覆盖窗口槽,这样就看着不像是坏了」)。
 *
 * 0.2.19 起弹层打开时窗位里的原生窗让开(useVeilSlot),露出来的是一块空白。这里钉两件事:
 * 1. 弹层几何 = 窗位矩形(有矩形时);没矩形(窗位收起/纯净模式/不在壳里)照旧居中。
 * 2. 让路期间槽体里有一句占位「窗位里的应用已让开,关闭弹窗后回来」,弹层关了就消失。
 */
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DailyReport, DockTab, TaskView, WorkbenchProject } from '../src/protocol.ts'
import { DailyBar } from '../src/client/DailyBar.tsx'
import { SettingsDialog } from '../src/client/SettingsDialog.tsx'
import { SlotZone } from '../src/client/SlotZone.tsx'
import { TaskDialog } from '../src/client/TaskDialog.tsx'
import {
  dialogCoverStyle, showVeilPlaceholder, useVeilActive, veilDepthNow, type VeilTarget,
} from '../src/client/useVeilSlot.ts'
import { UNUSED_STANDARD_PROPS } from './helpers/standardProps.ts'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

const SLOT = { x: 12, y: 96, w: 640, h: 420 }
const COVER = { left: 12, top: 96, width: 640, height: 420 }
const PLACEHOLDER = '窗位里的应用已让开,关闭弹窗后回来'

/** 只对 /dock/veil 记账,别的请求一律回空 ok(同 client-veil-wiring 的先例)。 */
function okFetch(): typeof fetch {
  return vi.fn(async () => ({
    ok: true,
    json: async () => ({ ok: true, deepseek: false, kimi_web: false, claude_api: false, nodes: [], edges: [], notes: [] }),
  })) as unknown as typeof fetch
}

function target(slotRect: VeilTarget['slotRect']): VeilTarget {
  return { baseUrl: 'http://x', fetchImpl: okFetch(), ...(slotRect === undefined ? {} : { slotRect }) }
}

describe('dialogCoverStyle(纯函数)', () => {
  it('有窗位矩形 → 弹层几何等于窗位矩形', () => {
    expect(dialogCoverStyle(SLOT)).toEqual(COVER)
  })
  it('没矩形 → undefined(照旧居中)', () => {
    expect(dialogCoverStyle(undefined)).toBeUndefined()
  })
  it('零面积矩形(display:none 量出来的)→ undefined,不把弹层缩成一个点', () => {
    expect(dialogCoverStyle({ x: 0, y: 0, w: 0, h: 0 })).toBeUndefined()
    expect(dialogCoverStyle({ x: 5, y: 5, w: 100, h: 0 })).toBeUndefined()
  })
})

describe('showVeilPlaceholder(纯函数)', () => {
  const claude: DockTab = { key: 'claude', label: 'Claude', running: true, current: true }
  it('让路中且有窗在台前 → 显示', () => {
    expect(showVeilPlaceholder(true, [claude])).toBe(true)
  })
  it('没在让路 → 不显示', () => {
    expect(showVeilPlaceholder(false, [claude])).toBe(false)
  })
  it('让路中但台前没窗(事务官在台/叠空)→ 不显示:没有谁让开了', () => {
    expect(showVeilPlaceholder(true, [{ ...claude, current: false }])).toBe(false)
    expect(showVeilPlaceholder(true, [])).toBe(false)
    expect(showVeilPlaceholder(true, undefined)).toBe(false)
  })
})

describe('设置弹窗盖住窗位', () => {
  it('有窗位矩形 → 弹窗定位到窗位矩形上,带 ben-wb__dlg-cover', async () => {
    render(<SettingsDialog baseUrl="http://x" fetchImpl={okFetch()} onClose={() => {}} veil={target(() => SLOT)} />)
    const dlg = screen.getByRole('dialog', { name: '设置' })
    expect(dlg).toHaveClass('ben-wb__dlg-cover')
    expect(dlg).toHaveStyle({ left: '12px', top: '96px', width: '640px', height: '420px' })
    await Promise.resolve()
  })

  it('窗位收起/纯净模式(量不到矩形)→ 不盖,照旧居中', async () => {
    render(<SettingsDialog baseUrl="http://x" fetchImpl={okFetch()} onClose={() => {}} veil={target(() => undefined)} />)
    const dlg = screen.getByRole('dialog', { name: '设置' })
    expect(dlg).not.toHaveClass('ben-wb__dlg-cover')
    expect(dlg.getAttribute('style')).toBeNull()
    await Promise.resolve()
  })

  it('不在壳里(不传 veil)→ 不盖', () => {
    render(<SettingsDialog baseUrl="http://x" fetchImpl={okFetch()} onClose={() => {}} />)
    expect(screen.getByRole('dialog', { name: '设置' })).not.toHaveClass('ben-wb__dlg-cover')
  })

  it('视口变了重新量一次窗位', async () => {
    let rect = SLOT
    render(<SettingsDialog baseUrl="http://x" fetchImpl={okFetch()} onClose={() => {}} veil={target(() => rect)} />)
    rect = { x: 20, y: 100, w: 500, h: 300 }
    act(() => { fireEvent(window, new Event('resize')) })
    expect(screen.getByRole('dialog', { name: '设置' })).toHaveStyle({ left: '20px', top: '100px', width: '500px', height: '300px' })
    await Promise.resolve()
  })
})

describe('任务卡弹窗盖住窗位', () => {
  const AT = '2026-08-25T09:00:00.000Z'
  const task: TaskView = { id: 'a', title: '甲', status: 'todo', source: { kind: 'manual' }, created_at: AT, updated_at: AT, project_id: 'p1', module_id: 'm1' }
  const common = {
    task, moduleName: '模块', sessions: [], sessionUsage: {}, branches: [], filePathHints: [],
    onClose: () => {}, onMove: () => {}, onUpdate: () => {}, onDelete: () => {},
  }
  it('有窗位矩形 → 盖', async () => {
    render(<TaskDialog {...common} veil={target(() => SLOT)} />)
    const dlg = screen.getByRole('dialog', { name: '功能点 甲' })
    expect(dlg).toHaveClass('ben-wb__dlg-cover')
    expect(dlg).toHaveStyle({ left: '12px', top: '96px', width: '640px', height: '420px' })
    await Promise.resolve()
  })
  it('没矩形 → 不盖', async () => {
    render(<TaskDialog {...common} veil={target(() => undefined)} />)
    expect(screen.getByRole('dialog', { name: '功能点 甲' })).not.toHaveClass('ben-wb__dlg-cover')
    await Promise.resolve()
  })
})

describe('日结弹层盖住窗位', () => {
  const REPORT: DailyReport = {
    date: '2026-09-01', generated_at: '2026-09-02T09:00:05+08:00',
    progress: [], missing: [], ideas: [], proposals: [],
  }
  // 10-22 起完整日结是居中一张(评审页 `.modal` 宽 620):有窗位矩形时**遮罩**盖在窗位上、那张居中其中(窗让开后不露空白);
  // 没矩形 → 遮罩铺满。
  it('有窗位矩形 → 遮罩盖在窗位上、那张居中其中;没矩形 → 遮罩铺满', async () => {
    const { unmount } = render(<DailyBar daily={REPORT} veil={target(() => SLOT)} />)
    fireEvent.click(screen.getByRole('button', { name: /日结 2026-09-01/ }))
    const veil = screen.getByRole('dialog', { name: /日结 2026-09-01/ }).parentElement as HTMLElement
    expect(veil).toHaveClass('ben-wb__dlg-cover')
    expect(veil).toHaveStyle({ left: '12px', top: '96px', width: '640px', height: '420px' })
    unmount()

    render(<DailyBar daily={REPORT} veil={target(() => undefined)} />)
    fireEvent.click(screen.getByRole('button', { name: /日结 2026-09-01/ }))
    expect(screen.getByRole('dialog', { name: /日结 2026-09-01/ }).parentElement).not.toHaveClass('ben-wb__dlg-cover')
    await Promise.resolve()
  })
})

describe('让路期间槽体里的占位', () => {
  const bodyRef = { current: null }
  it('SlotZone veiled=true 渲染一句浅色占位(role=status,不是 alert);false 不渲染', () => {
    const { rerender } = render(<SlotZone helper={{ connected: true, authorized: true }} snap={undefined} dockNote={undefined} bodyRef={bodyRef} dropHover={false} veiled />)
    const note = screen.getByRole('status', { name: '' })
    expect(note).toHaveTextContent(PLACEHOLDER)
    expect(note).toHaveClass('ben-wb__slot-veiled')
    expect(screen.queryByRole('alert')).toBeNull()
    rerender(<SlotZone helper={{ connected: true, authorized: true }} snap={undefined} dockNote={undefined} bodyRef={bodyRef} dropHover={false} veiled={false} />)
    expect(screen.queryByText(PLACEHOLDER)).toBeNull()
  })

  function Probe() {
    const active = useVeilActive()
    return <output data-testid="veil-active">{String(active)}</output>
  }

  it('弹层挂上(壳内)→ 让路中;卸载 → 结束', async () => {
    render(<Probe />)
    expect(screen.getByTestId('veil-active')).toHaveTextContent('false')
    const dlg = render(<SettingsDialog baseUrl="http://x" fetchImpl={okFetch()} onClose={() => {}} veil={target(() => SLOT)} />)
    await waitFor(() => expect(screen.getByTestId('veil-active')).toHaveTextContent('true'))
    expect(veilDepthNow()).toBe(1)
    dlg.unmount()
    await waitFor(() => expect(screen.getByTestId('veil-active')).toHaveTextContent('false'))
    expect(veilDepthNow()).toBe(0)
  })

  it('不在壳里(没 veil)的弹层不算让路', async () => {
    render(<Probe />)
    const dlg = render(<SettingsDialog baseUrl="http://x" fetchImpl={okFetch()} onClose={() => {}} />)
    await Promise.resolve()
    expect(screen.getByTestId('veil-active')).toHaveTextContent('false')
    dlg.unmount()
  })
})

/* ── 页面级(壳内):从 ⚙ 到弹窗到槽体占位,整条接缝 ── */
import { WorkbenchOverlay, type MinimalWebSocket, type WorkbenchOverlayProps } from '../src/client/Workbench.tsx'
import { createWorkbenchStore } from '../src/client/store.ts'
import { DEFAULT_LAYOUT } from '../src/client/layout.ts'
import type { WorkbenchState } from '../src/protocol.ts'
import { beforeEach } from 'vitest'

function pageProps(state: WorkbenchState): WorkbenchOverlayProps {
  const instance = createWorkbenchStore().create()
  const workspaceState = {
    items: [], phase: 'ready', archivedSessionIds: [], state: 'idle', error: null, baselinesReady: true,
    recentWorkspaceId: undefined,
  }
  const serviceFetch = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'POST') return { ok: true, json: async () => ({ ok: true }) }
    return { ok: true, json: async () => state }
  }) as unknown as typeof fetch
  const serviceWebSocket = (): MinimalWebSocket => ({ onmessage: null, onclose: null, close: () => {} })
  return {
    useStore: selector => selector(instance.getSnapshot()),
    actions: instance.actions,
    useWorkspaces: selector => selector(workspaceState as never),
    useSessions: selector => selector({} as never),
    ...UNUSED_STANDARD_PROPS,
    openWorkspace: async () => {},
    openSession: () => {},
    serviceFetch,
    servicePollMs: 0,
    serviceWebSocket,
  }
}

function pageState(over: Partial<WorkbenchState> = {}): WorkbenchState {
  return {
    agents: [], sessions: [], quota: {}, now: '2026-09-14T10:03:00+08:00', stale: false,
    dock: { stack: [{ key: 'claude', label: 'Claude', running: true, current: true }] },
    ...over,
  }
}

/** jsdom 不排版:槽体元素量出 SLOT;藏在 [hidden] 祖先底下(纯净模式)量出 0 矩形,同真浏览器。 */
function stubSlotRect(): void {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const r = this.classList.contains('ben-wb__slot-body') && this.closest('[hidden]') === null ? SLOT : { x: 0, y: 0, w: 0, h: 0 }
    return { x: r.x, y: r.y, width: r.w, height: r.h, top: r.y, left: r.x, right: r.x + r.w, bottom: r.y + r.h, toJSON() {} } as DOMRect
  })
}

describe('页面级(壳内):点 ⚙ → 弹窗盖住窗位 + 槽体占位;关掉 → 占位消失', () => {
  beforeEach(() => { window.history.replaceState(null, '', '/?ben-workbench=app') })
  afterEach(() => { window.history.replaceState(null, '', '/') })

  it('★验收 1:窗位里贴着 Claude 时点设置', async () => {
    stubSlotRect()
    render(<WorkbenchOverlay {...pageProps(pageState())} />)
    await screen.findByLabelText('事务官')
    expect(screen.queryByText(PLACEHOLDER)).toBeNull()

    await userEvent.click(screen.getByRole('button', { name: '设置' }))
    const dlg = screen.getByRole('dialog', { name: '设置' })
    expect(dlg).toHaveClass('ben-wb__dlg-cover')
    expect(dlg).toHaveStyle({ left: '12px', top: '96px', width: '640px', height: '420px' })
    const note = await screen.findByText(PLACEHOLDER)
    expect(note).toHaveClass('ben-wb__slot-veiled')
    expect(note.closest('.ben-wb__slot-body')).not.toBeNull()

    await userEvent.click(screen.getByRole('button', { name: '关闭设置' }))
    await waitFor(() => expect(screen.queryByText(PLACEHOLDER)).toBeNull())
  })

  it('★验收 2:纯净模式(槽体 display:none)点设置 → 不盖、居中,占位也看不见', async () => {
    stubSlotRect()
    render(<WorkbenchOverlay {...pageProps(pageState({ layout: { ...DEFAULT_LAYOUT, pureMode: true } }))} />)
    await screen.findByRole('button', { name: /^事务官:/ })
    await userEvent.click(screen.getByRole('button', { name: '设置' }))
    const dlg = screen.getByRole('dialog', { name: '设置' })
    expect(dlg).not.toHaveClass('ben-wb__dlg-cover')
    expect(dlg.getAttribute('style')).toBeNull()
    // 槽体常挂载(它是窗位矩形的唯一来源),纯净模式只是整块 display:none——占位跟着看不见。
    const placeholder = screen.queryByText(PLACEHOLDER)
    if (placeholder !== null) expect(placeholder).not.toBeVisible()
  })

  it('窗位收起(slot 模块 hidden)点设置 → 不盖,行为同 0.2.19', async () => {
    stubSlotRect()
    const layout = { ...DEFAULT_LAYOUT, modules: DEFAULT_LAYOUT.modules.map(m => (m.id === 'slot' ? { ...m, hidden: true } : m)) }
    render(<WorkbenchOverlay {...pageProps(pageState({ layout }))} />)
    await screen.findByLabelText('事务官')
    await userEvent.click(screen.getByRole('button', { name: '设置' }))
    expect(screen.getByRole('dialog', { name: '设置' })).not.toHaveClass('ben-wb__dlg-cover')
  })
})

/**
 * 只盖窗位露在屏幕里的那一块(2026-09-25,卡 fix/evening-gaps 第 2 条)。窗位那一栏能滚,
 * 「第一眼」把球放大置顶之后窗位下沿可能落在视口外:照原矩形铺,弹层下半截在屏幕外,最末那几节永远看不见。
 */
describe('dialogCoverStyle:收进视口', () => {
  const VIEW = { w: 1440, h: 900 }
  it('整块在视口里:原样', () => {
    expect(dialogCoverStyle(SLOT, VIEW)).toEqual(COVER)
  })
  it('★ 下沿落在视口外:截到视口下沿(留 8px)', () => {
    expect(dialogCoverStyle({ x: 195, y: 500, w: 780, h: 700 }, VIEW)).toEqual({ left: 195, top: 500, width: 780, height: 392 })
  })
  it('上沿滚到视口上面去了:从视口上沿(留 8px)开始', () => {
    expect(dialogCoverStyle({ x: 195, y: -200, w: 780, h: 600 }, VIEW)).toEqual({ left: 195, top: 8, width: 780, height: 392 })
  })
  it('露在屏幕里的只剩一条缝:不盖,照旧贴右上角开', () => {
    expect(dialogCoverStyle({ x: 195, y: 800, w: 780, h: 600 }, VIEW)).toBeUndefined()
    expect(dialogCoverStyle({ x: 1300, y: 100, w: 780, h: 600 }, VIEW)).toBeUndefined()
  })
})

describe('设置弹窗:窗位下沿在屏幕外', () => {
  it('★ 弹窗的高截到视口里(jsdom 视口 1024×768)', async () => {
    render(<SettingsDialog baseUrl="http://x" fetchImpl={okFetch()} onClose={() => {}} veil={target(() => ({ x: 12, y: 300, w: 640, h: 900 }))} />)
    const dlg = screen.getByRole('dialog', { name: '设置' })
    expect(dlg).toHaveStyle({ top: '300px', height: `${window.innerHeight - 8 - 300}px` })
    await Promise.resolve()
  })
})
