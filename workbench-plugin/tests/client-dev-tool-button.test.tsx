/**
 * 窗位叠上那颗「开发一个小工具」(2026-09-20,分支 feat/dev-tool-button)。
 *
 * Ben 原话:「我想在窗口槽的应用那里加一个按钮,横版在底部,竖版在最右侧,名字叫
 * 开发一个小工具,点击下去之后,还是打开事务官,但是事务官会得到一个提前的输入,
 * 就是用户希望在窗口槽这个位置里开发一个工具类的应用,这个也先做占位就行。」
 *
 * 这一版**只有占位那三件事**:按钮在、点了打开事务官、输入框里预先写好那一句。
 * 「非标需求 → 事务官直接改 → 改不了交给 DSH 做成模块」那条链路是另一张卡
 * (决策记录 2026-09-20「运营模板先做横屏;窗位叠加『开发一个小工具』按钮」)。
 *
 * jsdom 量不出像素,所以位置那一半钉的是 **DOM 归属与次序**:横屏在左栏里、
 * 排在标签竖排与场景菜单之后(= 栏底);竖屏在标签栏那一排里、排在所有标签之后(= 最右)。
 * 真机上那两个方向各截了一张图,见 docs/交接-0920-开发一个小工具按钮.md。
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, configure, render, screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkbenchOverlay, type MinimalWebSocket, type WorkbenchOverlayProps } from '../src/client/Workbench.tsx'
import { createWorkbenchStore } from '../src/client/store.ts'
import type { WorkbenchState } from '../src/protocol.ts'
import { UNUSED_STANDARD_PROPS } from './helpers/standardProps.ts'

/** 同 client-landscape.test.tsx:一次重渲在 jsdom 里要几百毫秒,默认 1 秒不够重试。 */
configure({ asyncUtilTimeout: 5_000 })

const BUTTON_NAME = '开发一个小工具'
/** 预填那一句,**逐字**钉死:它是事务官这一问的全部上下文,改一个字就是改需求。 */
const DRAFT = '我想在窗口槽这个位置开发一个工具类的小应用,它要做的是:'

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

const SCENES = [{ id: 's1', name: '写代码', app_count: 3, saved_at: '2026-09-20T09:00:00+08:00' }]

/** 缺省就是**空窗位叠**:这颗按钮不依赖有没有认领过应用(任务卡第 3 条)。 */
function baseState(over: Partial<WorkbenchState> = {}): WorkbenchState {
  return {
    agents: [{ id: 'dsh', online: true, connected: true, waiting: 0, running: 0 }],
    sessions: [],
    quota: {},
    now: '2026-09-20T10:03:00+08:00',
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

async function mount(state: WorkbenchState = baseState()) {
  const server = fakeServer(state)
  const view = render(<WorkbenchOverlay {...props(server.fetchImpl)} />)
  await screen.findByRole('heading', { name: '工作台' })
  return { ...view, ...server }
}

// ───────────────────────────────────────────────────────────────────────────
describe('按钮在哪儿', () => {
  it('★横屏:在左侧窄栏里,而且排在标签竖排与场景菜单之后(= 栏底)', async () => {
    setViewport(2560, 1440)
    const { container } = await mount()

    const rail = await waitFor(() => {
      const found = container.querySelector('[data-land-region="rail"]')
      expect(found).not.toBeNull()
      return found as HTMLElement
    })
    const button = within(rail).getByRole('button', { name: BUTTON_NAME })
    // 「最底」在 jsdom 里只能钉次序:它是这条栏的最后一个孩子,前面是标签栏与场景菜单。
    const mine = button.closest('.ben-wb__devtool') as HTMLElement
    expect(rail.lastElementChild).toBe(mine)
    const order = [...rail.children].map(child => child.className.split(' ')[0])
    expect(order).toEqual(['ben-wb__dock', 'ben-wb__scenemenu', 'ben-wb__devtool'])
  })

  it('★竖屏:在顶栏标签那一排里,排在所有标签之后(= 最右)', async () => {
    setViewport(1440, 2560)
    const { container } = await mount(baseState({
      dock: { stack: [{ key: 'codex', label: 'Codex', current: true, running: true }] },
    }))
    await waitFor(() => {
      expect(container.querySelector('main.ben-wb')).toHaveAttribute('data-orientation', 'portrait')
    })

    const tabs = container.querySelector('.ben-wb__dock-tabs') as HTMLElement
    const button = within(tabs).getByRole('button', { name: BUTTON_NAME })
    expect(tabs.lastElementChild).toBe(button.closest('.ben-wb__devtool'))
    // 前面是应用标签,它殿后(2026-10-27 起没有「事务官」那一格了)。
    expect(within(tabs).queryByRole('button', { name: '事务官' })).toBeNull()
    expect(within(tabs).getByRole('button', { name: 'Codex' })).toBeTruthy()
  })

  it('★空窗位叠时照样在(它不依赖有没有应用)', async () => {
    setViewport(1440, 2560)
    const { container } = await mount()
    const tabs = container.querySelector('.ben-wb__dock-tabs') as HTMLElement
    // 叠里一个成员都没有:一格标签都没有(「事务官」那一格 2026-10-27 去掉了),只有这颗按钮。
    expect(tabs.querySelectorAll('.ben-wb__dock-tab')).toHaveLength(0)
    expect(within(tabs).getByRole('button', { name: BUTTON_NAME })).toBeTruthy()
  })

  it('全页只有一颗——横屏的标签栏是从窗位槽模块提上去的那一份,不会两处各画一颗', async () => {
    setViewport(2560, 1440)
    const { container } = await mount()
    await waitFor(() => expect(container.querySelector('[data-land-region="rail"]')).not.toBeNull())
    expect(container.querySelectorAll('.ben-wb__devtool')).toHaveLength(1)
  })

  it('它是动作不是标签:不带 ✕、不参与拖拽排序', async () => {
    setViewport(1440, 2560)
    const { container } = await mount(baseState({
      dock: { stack: [{ key: 'codex', label: 'Codex', current: true, running: true }] },
    }))
    const mine = container.querySelector('.ben-wb__devtool') as HTMLElement
    expect(mine.getAttribute('draggable')).not.toBe('true')
    expect(within(mine).queryByRole('button', { name: /放出/ })).toBeNull()
  })
})

// ───────────────────────────────────────────────────────────────────────────
describe('点下去之后', () => {
  beforeEach(() => { setViewport(1440, 2560) })

  it('★打开事务官 = 展开悬浮球(2026-10-27 起入口只剩它);不再去藏台前的原生窗', async () => {
    const { calls } = await mount()
    await userEvent.click(await screen.findByRole('button', { name: BUTTON_NAME }))
    expect(await screen.findByLabelText('交给事务官一件事')).toBeVisible()
    expect(calls.some(call => call.url.endsWith('/dock/hide'))).toBe(false)
  })

  it('★输入框里预先写好那一句,光标停在末尾', async () => {
    await mount()
    await userEvent.click(await screen.findByRole('button', { name: BUTTON_NAME }))

    const input = await screen.findByLabelText('交给事务官一件事') as HTMLTextAreaElement
    await waitFor(() => expect(input).toHaveValue(DRAFT))
    await waitFor(() => expect(document.activeElement).toBe(input))
    // 「它要做的是:」后面接着打字,光标不能停在开头。
    expect(input.selectionStart).toBe(DRAFT.length)
    expect(input.selectionEnd).toBe(DRAFT.length)
  })

  it('★不自动发送:一条 /butler/item 都没发出去', async () => {
    const { calls } = await mount()
    await userEvent.click(await screen.findByRole('button', { name: BUTTON_NAME }))
    await screen.findByLabelText('交给事务官一件事')
    expect(calls.some(call => call.url.endsWith('/butler/item'))).toBe(false)
  })

  it('接着往后打字就是那一句的续写(草稿仍归上层持有,不被按钮再覆盖一次)', async () => {
    await mount()
    await userEvent.click(await screen.findByRole('button', { name: BUTTON_NAME }))
    const input = await screen.findByLabelText('交给事务官一件事') as HTMLTextAreaElement
    await waitFor(() => expect(input).toHaveValue(DRAFT))
    await userEvent.type(input, '一个倒计时')
    expect(input).toHaveValue(`${DRAFT}一个倒计时`)
  })

  it('★没点这颗按钮时不抢焦点:悬浮窗里那一页挂着,光标不凭空跳进输入框', async () => {
    await mount()
    const input = await screen.findByLabelText('交给事务官一件事') as HTMLTextAreaElement
    expect(input).toHaveValue('')
    // 事务官档是懒挂载的:挂载那一拍"送光标进来"的 effect 照样会跑,
    // 上层计数器的初值(0)必须被当成"没人要求过"。手机上抢焦点还会顶出软键盘。
    expect(document.activeElement).not.toBe(input)
  })

  it('横屏点那一颗也预填同一句(两个方向同一条路)', async () => {
    setViewport(2560, 1440)
    const { container, calls } = await mount()
    await waitFor(() => expect(container.querySelector('[data-land-region="rail"]')).not.toBeNull())
    await userEvent.click(await screen.findByRole('button', { name: BUTTON_NAME }))
    const input = await screen.findByLabelText('交给事务官一件事') as HTMLTextAreaElement
    await waitFor(() => expect(input).toHaveValue(DRAFT))
    expect(calls.some(call => call.url.endsWith('/dock/hide'))).toBe(false)
  })
})
