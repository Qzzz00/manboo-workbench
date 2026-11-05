/**
 * 自定义模块在窗位叠里那一档(2026-09-21,分支 feat/custom-module-container)。
 *
 * 钉五件:
 *   ① 一个模块一格标签,排在应用标签之后、「开发一个小工具」之前(横竖两处);
 *   ② 点它 = 走点「事务官」同一条 `POST /dock/hide`,iframe 铺在窗位槽的定位层里;
 *   ③ **切走保活**:iframe 不卸载,只 display:none(番茄钟不能一切走就重新计时);
 *   ④ ✕ 是二次确认,确认之后 `POST /modules/<id>/remove`(移进回收站,不是删);
 *   ⑤ 点回「事务官」 / 点某个应用标签,iframe 让开。
 *
 * jsdom 量不出像素,所以"铺满窗位槽"钉的是 **DOM 归属**:iframe 必须是
 * `.ben-wb__slot-stack` 的孩子 —— 那一层是事务官档的定位上下文,槽体本身仍旧挂着
 * (它是窗位矩形的唯一来源,2026-08-26 那次真机事故的教训)。
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, configure, render, screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkbenchOverlay, type MinimalWebSocket, type WorkbenchOverlayProps } from '../src/client/Workbench.tsx'
import { createWorkbenchStore } from '../src/client/store.ts'
import { CustomModulesPanel } from '../src/client/CustomModulesPanel.tsx'
import { CustomModuleFrame } from '../src/client/CustomModuleFrame.tsx'
import type { CustomModuleView, WorkbenchState } from '../src/protocol.ts'
import { UNUSED_STANDARD_PROPS } from './helpers/standardProps.ts'

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

/**
 * `frame_url` 是**服务端签好的那条**(2026-09-22,C7):单开的那个来源 + 这个模块自己那把
 * 短期令牌。前端不拼这个地址 —— 端口与令牌都只有服务端知道。
 */
const POMODORO: CustomModuleView = {
  id: 'tool-a1b2c3', name: '番茄钟', created_at: '2026-09-21T10:00:00+08:00', source: 'dsh', entry: 'index.html',
  frame_url: 'http://127.0.0.1:8794/modules/tool-a1b2c3/index.html?wb=wbm.aaa.bbb',
}
const LIST: CustomModuleView = {
  id: 'tool-d4e5f6', name: '今日待发', created_at: '2026-09-21T11:00:00+08:00', source: 'dsh', entry: 'index.html',
  frame_url: 'http://127.0.0.1:8794/modules/tool-d4e5f6/index.html?wb=wbm.ccc.ddd',
}

function baseState(over: Partial<WorkbenchState> = {}): WorkbenchState {
  return {
    agents: [{ id: 'dsh', online: true, connected: true, waiting: 0, running: 0 }],
    sessions: [],
    quota: {},
    now: '2026-09-21T10:03:00+08:00',
    stale: false,
    onboarding: { stage: 'opening', done: false },
    dock: { stack: [] },
    scenes: [],
    modules: [POMODORO],
    ...over,
  }
}

function fakeServer(initial: WorkbenchState) {
  let state = initial
  const calls: { url: string, body: unknown }[] = []
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      calls.push({ url: String(url), body: init.body === undefined ? undefined : JSON.parse(String(init.body)) })
      return { ok: true, json: async () => ({ ok: true }) }
    }
    return { ok: true, json: async () => state }
  }) as unknown as typeof fetch
  return { fetchImpl, calls, setState: (next: WorkbenchState) => { state = next } }
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

/**
 * 标签栏里那一排按钮。**必须限定在标签栏里找** —— 「事务官」这三个字在这一屏上不止一处
 * (右下角那个浮窗也有),全页 getByRole 会撞上(先例:client-dev-tool-button 那一份也是
 * `within(tabs)`)。
 */
function tabs(container: HTMLElement): HTMLElement {
  const found = container.querySelector('.ben-wb__dock-tabs')
  if (found === null) throw new Error('没有标签栏')
  return found as HTMLElement
}

function clickTab(container: HTMLElement, name: string): Promise<void> {
  return userEvent.click(within(tabs(container)).getByRole('button', { name }))
}

/**
 * 事务官那一页(2026-10-27 起只在悬浮球的展开窗里;入口只剩悬浮球):收着就点开它。
 */
async function openButler(): Promise<void> {
  const ball = document.querySelector('.ben-wb__butler-ball-btn')
  if (ball instanceof HTMLElement) await userEvent.click(ball)
  await screen.findByLabelText('交给事务官一件事')
}
function frames(container: HTMLElement): HTMLIFrameElement[] {
  return [...container.querySelectorAll('iframe.ben-wb__module-frame')] as HTMLIFrameElement[]
}

// ───────────────────────────────────────────────────────────────────────────
describe('标签在哪儿', () => {
  it.each([[2560, 1440], [1440, 2560]])('窗口槽不显示模板网页链接，保留应用与模块标签（%d × %d）', async (width, height) => {
    setViewport(width, height)
    const { container } = await mount(baseState({
      dock: { stack: [{ key: 'codex', label: 'Codex', current: true, running: true }] },
      template: {
        id: 'ops',
        name: '自媒体运营',
        project_word: '账号',
        project_empty_line: '',
        module_titles: {},
        board_lanes: [],
        has_backup: false,
        web_apps: [
          { key: 'kling', label: '可灵', url: 'https://klingai.com' },
          { key: 'xiaohongshu', label: '小红书', url: 'https://www.xiaohongshu.com' },
          { key: 'canva', label: '可画', url: 'https://www.canva.cn' },
        ],
      },
    }))
    const bar = within(tabs(container))
    expect(bar.getByRole('button', { name: 'Codex' })).toBeInTheDocument()
    expect(bar.getByRole('button', { name: '番茄钟' })).toBeInTheDocument()
    expect(bar.queryAllByRole('link')).toHaveLength(0)
    if (width > height) expect(screen.getByRole('button', { name: '窗口布局' })).toBeInTheDocument()
  })

  it('★竖屏:排在应用标签之后、「开发一个小工具」之前', async () => {
    setViewport(1440, 2560)
    const { container } = await mount(baseState({
      dock: { stack: [{ key: 'codex', label: 'Codex', current: true, running: true }] },
      modules: [POMODORO, LIST],
    }))
    const tabs = await waitFor(() => {
      const found = container.querySelector('.ben-wb__dock-tabs')
      expect(found).not.toBeNull()
      return found as HTMLElement
    })
    const order = [...tabs.children].map(child => child.textContent)
    // 2026-10-27 已拍板:最左那一格「事务官」去掉了(入口只剩悬浮球)。
    expect(order.some(one => one?.includes('事务官'))).toBe(false)
    expect(order[0]).toContain('Codex')
    expect(order[1]).toContain('番茄钟')
    expect(order[2]).toContain('今日待发')
    expect(order[3]).toContain('开发一个小工具')
  })

  it('★横屏:同一排(左侧窄栏里那份标签栏),不是另画一份', async () => {
    setViewport(2560, 1440)
    const { container } = await mount()
    const rail = await waitFor(() => {
      const found = container.querySelector('[data-land-region="rail"]')
      expect(found).not.toBeNull()
      return found as HTMLElement
    })
    expect(within(rail).getByRole('button', { name: '番茄钟' })).toBeTruthy()
    // 全页只有一格:横屏那份标签栏是从窗位槽模块提上去的同一份。
    expect(container.querySelectorAll('[data-module-id="tool-a1b2c3"].ben-wb__module-tab')).toHaveLength(1)
  })

  it('没接自定义模块服务(state.modules 缺席)时一格都不画', async () => {
    setViewport(1440, 2560)
    const state = baseState()
    delete (state as { modules?: unknown }).modules
    const { container } = await mount(state)
    expect(container.querySelectorAll('.ben-wb__module-tab')).toHaveLength(0)
    // 而且一个 iframe 都没挂。
    expect(frames(container)).toHaveLength(0)
  })
})

describe('src 冻住(令牌会换,而 src 一变这块 iframe 就重载)', () => {
  it('★/state 下一拍换了一把令牌:src 一个字符都不跟着动(番茄钟不能从头计时)', () => {
    const { rerender, container } = render(<CustomModuleFrame module={POMODORO} active />)
    const before = (container.querySelector('iframe') as HTMLIFrameElement).getAttribute('src')
    expect(before).toBe(POMODORO.frame_url)

    rerender(<CustomModuleFrame module={{ ...POMODORO, frame_url: 'http://127.0.0.1:8794/modules/tool-a1b2c3/index.html?wb=wbm.zzz.yyy' }} active />)
    const frame = container.querySelector('iframe') as HTMLIFrameElement
    expect(frame.getAttribute('src')).toBe(before)
  })

  it('没被选中过就一个 iframe 都不建(懒挂载:没人看的时候不该加载一整份页面)', () => {
    const { container } = render(<CustomModuleFrame module={POMODORO} active={false} />)
    expect(container.querySelector('iframe')).toBeNull()
  })
})

describe('点它 = 跟事务官同一档', () => {
  it('★点标签:发 POST /dock/hide(藏原生窗),iframe 铺在窗位槽的定位层里', async () => {
    setViewport(1440, 2560)
    const { container, calls } = await mount()
    // 还没点过:一个 iframe 都不挂(懒挂载,不白加载一整份页面)。
    expect(frames(container)).toHaveLength(0)

    await clickTab(container, '番茄钟')

    expect(calls.map(call => call.url).filter(url => url.endsWith('/dock/hide'))).toHaveLength(1)
    const frame = await waitFor(() => {
      const found = frames(container)[0]
      expect(found).toBeDefined()
      return found as HTMLIFrameElement
    })
    expect(frame.getAttribute('src')).toContain('/modules/tool-a1b2c3/index.html')
    // ★DOM 归属:与事项收件箱同一层,盖在槽体上——槽体本身还在(窗位矩形的唯一来源)。
    expect(frame.parentElement?.className).toContain('ben-wb__slot-stack')
    expect(container.querySelector('.ben-wb__slot-body')).not.toBeNull()
  })

  it('★选中模块:那一格是选中态;标签栏里没有「事务官」那一格', async () => {
    setViewport(1440, 2560)
    const { container } = await mount()
    expect(container.querySelector('.ben-wb__dock-tab--butler')).toBeNull()
    await clickTab(container, '番茄钟')
    await waitFor(() => expect(container.querySelector('[data-module-id="tool-a1b2c3"].ben-wb__module-tab')?.getAttribute('data-current')).toBe('true'))
  })

  it('★再点一次正在看的那一格:iframe 让开(但不卸载);事务官那一页在悬浮窗里照旧在', async () => {
    setViewport(1440, 2560)
    const { container } = await mount()
    await clickTab(container, '番茄钟')
    await waitFor(() => expect(frames(container)[0]?.style.display).not.toBe('none'))

    await clickTab(container, '番茄钟')
    await waitFor(() => expect(frames(container)[0]?.style.display).toBe('none'))
    // 卸载了就等于重新计时——这里必须还在 DOM 里。
    expect(frames(container)).toHaveLength(1)
    await openButler()
    expect(screen.getByLabelText('交给事务官一件事')).toBeVisible()
  })

  it('★这块 iframe 的 src 是服务端给的那条(单开来源),而且带 sandbox 不带 allow-same-origin', async () => {
    setViewport(1440, 2560)
    const { container } = await mount(baseState({ modules: [POMODORO] }))
    await clickTab(container, '番茄钟')
    const frame = await waitFor(() => frames(container)[0] as HTMLIFrameElement)

    // ① src 逐字就是 /state 里那条 —— 前端不自己拼(端口与令牌只有服务端知道)。
    expect(frame.getAttribute('src')).toBe(POMODORO.frame_url)
    // ② 它不在工作台那个 origin 上。
    expect(new URL(frame.getAttribute('src') as string).port).toBe('8794')
    // ③ sandbox:给 scripts/forms,**不给 allow-same-origin**(给了就退回同源,
    //    这张卡立起来的边界当场没了),也不给弹窗与顶层导航。
    const sandbox = (frame.getAttribute('sandbox') ?? '').split(/\s+/)
    expect(sandbox).toContain('allow-scripts')
    expect(sandbox).toContain('allow-forms')
    expect(sandbox).not.toContain('allow-same-origin')
    expect(sandbox).not.toContain('allow-popups')
    expect(sandbox).not.toContain('allow-top-navigation')
  })

  it('★服务端没给 frame_url(单开来源没起来):一格都不挂,**不退回同源**', async () => {
    setViewport(1440, 2560)
    const { frame_url: _gone, ...noFrame } = POMODORO
    const { container } = await mount(baseState({ modules: [noFrame] }))
    // 标签照画(用户看得见这个模块在),但点开挂不出 iframe —— 而不是挂一块打不开的白 iframe。
    expect(container.querySelectorAll('.ben-wb__module-tab').length).toBeGreaterThan(0)
    await clickTab(container, '番茄钟')
    await waitFor(() => expect(frames(container)).toHaveLength(0))
  })

  it('★切走保活:A → B → A,两块 iframe 都还在,src 一次都没重设', async () => {
    setViewport(1440, 2560)
    const { container } = await mount(baseState({ modules: [POMODORO, LIST] }))
    await clickTab(container, '番茄钟')
    const first = await waitFor(() => frames(container)[0] as HTMLIFrameElement)

    await clickTab(container, '今日待发')
    await waitFor(() => expect(frames(container)).toHaveLength(2))

    await clickTab(container, '番茄钟')
    await waitFor(() => expect(frames(container)[0]?.style.display).not.toBe('none'))
    // ★同一个 DOM 节点(不是被卸载之后重建的新节点)。
    expect(frames(container)[0]).toBe(first)
    expect(frames(container)).toHaveLength(2)
  })

  it('★有原生窗在台前时 iframe 让开(它盖的正是那扇窗要贴的矩形)', async () => {
    setViewport(1440, 2560)
    // 这一条要的是"服务端真的跟着动":/dock/hide 把窗藏起来,/dock/switch 把它调回台前。
    // 假服务端照着改 dock.current,轮询下一拍就是新的 —— 与真机同一条路。
    let current = true
    const calls: string[] = []
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        calls.push(String(url))
        if (String(url).endsWith('/dock/hide')) current = false
        if (String(url).endsWith('/dock/switch')) current = true
        return { ok: true, json: async () => ({ ok: true }) }
      }
      return {
        ok: true,
        json: async () => baseState({ dock: { stack: [{ key: 'codex', label: 'Codex', current, running: false }] } }),
      }
    }) as unknown as typeof fetch
    const { container } = render(<WorkbenchOverlay {...props(fetchImpl)} servicePollMs={20} />)
    await screen.findByRole('heading', { name: '工作台' })

    await clickTab(container, '番茄钟')
    // 先等 iframe **真的挂上来**:只断言 display 不是 'none' 的话,"一块都没挂"也会侥幸为真。
    await waitFor(() => expect(frames(container)).toHaveLength(1))
    expect(frames(container)[0]?.style.display).not.toBe('none')

    // 点回 Codex:那扇原生窗回到台前,iframe 必须让开(它盖的就是那扇窗的矩形)。
    await clickTab(container, 'Codex')
    await waitFor(() => expect(frames(container)[0]?.style.display).toBe('none'))
    // 而且**没卸载** —— 切回来还是同一块。
    expect(frames(container)).toHaveLength(1)
  })
})

describe('移除是二次确认的,而且是"移进回收站"', () => {
  it('★点 ✕ 不立刻移除,原地变成一句问话', async () => {
    setViewport(1440, 2560)
    const { container, calls } = await mount()
    await clickTab(container, '移除 番茄钟')
    expect(calls.filter(call => call.url.includes('/modules/'))).toHaveLength(0)
    expect(within(tabs(container)).getByRole('button', { name: '移到回收站' })).toBeTruthy()
    expect(container.querySelector('.ben-wb__module-tab')?.getAttribute('data-confirming')).toBe('true')
  })

  it('★「不移」退回原状,一个请求都不发', async () => {
    setViewport(1440, 2560)
    const { calls, container } = await mount()
    await clickTab(container, '移除 番茄钟')
    await clickTab(container, '不移除 番茄钟')
    expect(within(tabs(container)).getByRole('button', { name: '移除 番茄钟' })).toBeTruthy()
    expect(calls.filter(call => call.url.includes('/modules/'))).toHaveLength(0)
  })

  it('★确认之后才发 POST /modules/<id>/remove', async () => {
    setViewport(1440, 2560)
    const { calls, container } = await mount()
    await clickTab(container, '移除 番茄钟')
    await clickTab(container, '移到回收站')
    expect(calls.map(call => call.url).some(url => url.endsWith('/modules/tool-a1b2c3/remove'))).toBe(true)
  })

  it('移除正在看的那一格:先退回事务官档,不留一块指着空目录的白 iframe', async () => {
    setViewport(1440, 2560)
    const { container } = await mount()
    await clickTab(container, '番茄钟')
    await waitFor(() => expect(frames(container)[0]?.style.display).not.toBe('none'))
    await clickTab(container, '移除 番茄钟')
    await clickTab(container, '移到回收站')
    await waitFor(() => expect(frames(container)[0]?.style.display).toBe('none'))
    expect(screen.getByLabelText('交给事务官一件事')).toBeVisible()
  })
})

describe('待确认的小工具需求', () => {
  const pending = {
    id: 'p1',
    request: '我想在窗口槽这个位置开发一个工具类的小应用,它要做的是:一个番茄钟',
    restate: '一个番茄钟,25 分钟一轮',
    module_id: 'tool-a1b2c3',
    created_at: '2026-09-21T10:02:00+08:00',
  }

  it('★复述原样上屏;没有草图时如实说一句,不拿模板话冒充', async () => {
    setViewport(1440, 2560)
    const { container } = await mount(baseState({ modules: [], dev_tool: { pending: [pending] } }))
    await openButler()
    const card = await screen.findByLabelText('待确认的小工具需求')
    expect(within(card).getByText('一个番茄钟,25 分钟一轮')).toBeTruthy()
    expect(within(card).getByText(/这一版没有草图/)).toBeTruthy()
  })

  it('接上草图端口之后那一行就是真的草图', async () => {
    setViewport(1440, 2560)
    const { container } = await mount(baseState({
      modules: [],
      dev_tool: { pending: [{ ...pending, sketch: '满屏一个大圆环,中间是剩余分钟数' }] },
    }))
    await openButler()
    const card = await screen.findByLabelText('待确认的小工具需求')
    expect(within(card).getByText('草图:满屏一个大圆环,中间是剩余分钟数')).toBeTruthy()
    expect(within(card).queryByText(/这一版没有草图/)).toBeNull()
  })

  it('★「就这样」带上名字发 POST /devtool/confirm', async () => {
    setViewport(1440, 2560)
    const { calls, container } = await mount(baseState({ modules: [], dev_tool: { pending: [pending] } }))
    await openButler()
    const card = await screen.findByLabelText('待确认的小工具需求')
    await userEvent.type(within(card).getByLabelText('这个小工具叫什么'), '番茄钟')
    await userEvent.click(within(card).getByRole('button', { name: '就这样,派出去做' }))
    const confirm = calls.find(call => call.url.endsWith('/devtool/confirm'))
    expect(confirm?.body).toEqual({ id: 'p1', name: '番茄钟' })
  })

  it('★「不做了」发 POST /devtool/cancel,一条事项都不建', async () => {
    setViewport(1440, 2560)
    const { calls, container } = await mount(baseState({ modules: [], dev_tool: { pending: [pending] } }))
    await openButler()
    const card = await screen.findByLabelText('待确认的小工具需求')
    await userEvent.click(within(card).getByRole('button', { name: '不做了' }))
    expect(calls.find(call => call.url.endsWith('/devtool/cancel'))?.body).toEqual({ id: 'p1' })
    expect(calls.some(call => call.url.endsWith('/butler/item'))).toBe(false)
  })

  it('一条待确认都没有时整块不渲染', async () => {
    setViewport(1440, 2560)
    const { container } = await mount(baseState({ modules: [] }))
    await openButler()
    expect(screen.queryByLabelText('待确认的小工具需求')).toBeNull()
  })
})

// ───────────────────────────────────────────────────────────────────────────
/**
 * 设置里那一节(可撤销的那条路)。**单独渲染这个组件**,不走整个设置弹窗 ——
 * 那一屏里还有十来个自己拉自己数据的面板,混在一起时这条 fetch mock 会被别人的断言牵着走
 * (先例:TemplatePanel 那一份用例也是单独渲染)。
 */
describe('设置 · 自定义模块', () => {
  function panelServer(payload: { modules: CustomModuleView[], trash: CustomModuleView[] }) {
    const calls: string[] = []
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        calls.push(String(url))
        if (String(url).endsWith('/restore')) {
          payload.modules = [...payload.modules, ...payload.trash]
          payload.trash = []
        }
        return { ok: true, json: async () => ({ ok: true }) }
      }
      return { ok: true, json: async () => payload }
    }) as unknown as typeof fetch
    return { fetchImpl, calls }
  }

  it('★回收站里那几个列得出来,「恢复」把它拿回来', async () => {
    const { fetchImpl, calls } = panelServer({ modules: [], trash: [POMODORO] })
    render(<CustomModulesPanel baseUrl="http://x" fetchImpl={fetchImpl} />)
    await screen.findByRole('heading', { name: '自定义组件' })
    expect(await screen.findByText('还没有自定义组件。窗位叠上那颗「开发一个小工具」是入口。')).toBeTruthy()

    // 回收站收在「回收站 N 个 · 展开 ›」里(2026-10-22 照评审页)
    await userEvent.click(await screen.findByText('回收站 1 个'))
    await userEvent.click(await screen.findByRole('button', { name: '恢复' }))
    expect(calls.some(url => url.endsWith('/modules/tool-a1b2c3/restore'))).toBe(true)
    await waitFor(() => expect(screen.getByText('回收站是空的。')).toBeTruthy())
  })

  it('没接自定义模块服务(GET /modules 404)时整节不出现', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 404, json: async () => ({ error: '自定义模块未启用' }) })) as unknown as typeof fetch
    const { container } = render(<CustomModulesPanel baseUrl="http://x" fetchImpl={fetchImpl} />)
    await waitFor(() => expect(fetchImpl).toHaveBeenCalled())
    expect(container.querySelector('section')).toBeNull()
  })
})
