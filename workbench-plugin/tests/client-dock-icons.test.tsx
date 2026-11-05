/**
 * **坞上每一格都有图标** —— 界面这一半(2026-09-26,卡 LG2)。
 *
 * 维护者 18:05 看着坞:「做事做一半,现在只有 Agent 有 logo,你看着怪不怪」。
 * 他数出来没有图的那几格:Pen、微信、企业微信、Notion、终端、Finder、窗口布局,还有第一格「事务官」。
 *
 * 这一份钉四件事:
 * 1. **一格不落**:坞上每一种格(事务官、是 Agent 的、不是 Agent 的、还没拉进来的)都渲出
 *    一张 `<img>` 或者一个退路,**没有一格是空的**;
 * 2. 不是 Agent 的那几格图走 `/apps/icon/<坞项的键>`(键是坞自己那份清单里的键,界面不碰包标识);
 *    是 Agent 的那几格照旧走 `/agents/icon/<登记表 id>`(卡 LG 那条路不回归);
 * 3. **退路分两种**:是 Agent 的退回它自己颜色的色点(状态语义在那颗点上);
 *    不是 Agent 的退回中性小方块(它们没有状态色,不许凭空造一颗彩色圆点出来);
 * 4. 「窗口布局」那一格是**内置的小图形**(自己的 svg,不去取系统图标 —— 它不是一个 App)。
 *
 * 登记表这一份同卡 Q / LG 的做法:**真的发现引擎**对着模拟的窗口判出来的,
 * 界面代码里没有哪一家的名字、也没有任何 logo 文件。
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DockTabBar } from '../src/client/DockTabBar.tsx'
import { SceneBar } from '../src/client/SceneBar.tsx'
import type { WorkbenchState } from '../src/protocol.ts'
import { ICON_MIN_GAP_MS, createAgentDiscovery } from '../src/server/agentDiscovery.ts'
import { createMemoryRegistryStore } from '../src/server/agentRegistry.ts'
import type { FakeApp } from './fixtures/agentWorld.ts'
import { chatProbe, chatRead, fakeModel, fakeShell } from './fixtures/agentWorld.ts'

afterEach(cleanup)

const CAPS_NEW = ['new_conversation', 'read_reply', 'agent_window', 'icon_color', 'app_icon']

/**
 * 一台假的 Mac:一家真 Agent(Foo AI,图标渲得出来)+ 几家判过了**不是 Agent** 的
 * (人跟人聊天的「Chatter」、一个普通软件「Notes」)。坞上那几格就是照这台机器摆的。
 */
async function runtime() {
  let clock = new Date('2026-09-26T10:05:00Z')
  const apps: FakeApp[] = [
    { bundle_id: 'com.example.fooai', name: 'Foo AI', category: 'public.app-category.productivity', running: true, icon: '#eb714d', logo: true, probe: chatProbe(), read: () => chatRead({ answer: '好的' }) },
    { bundle_id: 'com.example.chatter', name: 'Chatter', category: 'public.app-category.social-networking', running: true, logo: true, probe: chatProbe(), read: () => chatRead({ answer: '晚上吃饭吗' }) },
    { bundle_id: 'com.example.notes', name: 'Notes', category: 'public.app-category.utilities', running: true, logo: true, probe: { windows: 1, inputs: [], send: [], lists: [], texts: { total: 3 } } },
    // 工作台自己(`OWN_BUNDLE_ID`)。`running: false` 让它不进「正在跑的常规 App」那一扫
    // (它本来也不该被当成候选的一家),可壳照样渲得出它的图标 —— 事务官那一格用的就是这一张。
    { bundle_id: 'ai.ben.workbench', name: '工作台', running: false, logo: true },
  ]
  const shell = fakeShell(apps, { caps: CAPS_NEW })
  const discovery = createAgentDiscovery({
    store: createMemoryRegistryStore(),
    helper: shell.helper,
    judge: fakeModel({ 'Foo AI': 'ai_agent', Chatter: 'human_chat', Notes: 'other', 工作台: 'other' }).judge,
    remainingCny: async () => 4,
    now: () => clock,
    setInterval: () => 1,
    clearInterval: () => {},
    setTimeout: () => 1,
    clearTimeout: () => {},
  })
  for (let i = 0; i < 10; i += 1) {
    await discovery.tick()
    clock = new Date(clock.getTime() + ICON_MIN_GAP_MS)
  }
  return { discovery, shell, clock }
}

/** 坞上摆着:是 Agent 的一格 + 不是 Agent 的两格,还有一格他要了、还没拉进来的。 */
function stateWith(registry: WorkbenchState['agent_registry'], now: string): WorkbenchState {
  return {
    agents: [], sessions: [], quota: {}, stale: false, now,
    tasks: { tasks: [], sprints: [], modules: [], project_meta: [] },
    butler_inbox: { items: [] },
    ...(registry === undefined ? {} : { agent_registry: registry }),
    dock: {
      stack: [
        { key: 'c-fooai', label: 'Foo AI', running: true, current: true },
        { key: 'c-chatter', label: '微信', running: true, current: false },
        { key: 'term', label: '终端', running: false, current: false },
      ],
      bundles: { 'c-fooai': 'com.example.fooai', 'c-chatter': 'com.example.chatter', term: 'com.example.notes' },
      pending: [{ key: 'wecom', label: '企业微信' }],
    },
  }
}

function renderDock(state: WorkbenchState) {
  render(
    <DockTabBar
      dock={state.dock}
      sessions={state.sessions}
      registry={state}
      badges={{}}
      baseUrl="http://wb"
      fetchImpl={vi.fn() as unknown as typeof fetch}
      butlerActive={false}
      onSelectButler={() => {}}
    />,
  )
}

/** 那一格标签里画出来的是什么:一张图(带地址)、一颗色点、还是一个中性小方块。 */
function markOf(name: string): { img?: string, dot: boolean, blank: boolean } {
  const tab = screen.getByRole('button', { name })
  const img = tab.querySelector('img')
  return {
    ...(img === null ? {} : { img: img.getAttribute('src') ?? '' }),
    dot: tab.querySelector('.ben-wb__dotmini') !== null,
    blank: tab.querySelector('.ben-wb__appicon-blank') !== null,
  }
}

describe('坞上每一格都有图标', () => {
  it('★★一格不落:事务官、是 Agent 的、不是 Agent 的、还没拉进来的 —— 每一格都有一张图或一个退路', async () => {
    const { discovery, clock } = await runtime()
    renderDock(stateWith(discovery.view(), clock.toISOString()))
    // 坞上所有标签的名字那颗键(事务官 + 三格 + 一格还没拉进来的)。
    const names = [...document.querySelectorAll('.ben-wb__dock-tab-name')]
    expect(names).toHaveLength(5)
    for (const button of names) {
      const has = button.querySelector('img, .ben-wb__dotmini, .ben-wb__appicon-blank') !== null
      expect(has, button.textContent ?? '').toBe(true)
    }
  })

  it('★不是 Agent 的那几格:图走 /apps/icon/<坞项的键>(界面不碰包标识)', async () => {
    const { discovery, clock } = await runtime()
    const state = stateWith(discovery.view(), clock.toISOString())
    // 先确认它们真的**不在登记表里**(判过了不是 Agent)—— 不然这一条就白验了。
    const ids = state.agent_registry?.entries.map(one => one.id) ?? []
    expect(ids).not.toContain('com.example.chatter')
    expect(ids).not.toContain('com.example.notes')
    renderDock(state)
    expect(markOf('微信').img).toBe('http://wb/apps/icon/c-chatter')
    expect(markOf('终端').img).toBe('http://wb/apps/icon/term')
    // 地址里是**键**,不是包标识 —— 键→包的换算只在服务端(server/appIcons.ts)。
    expect(document.body.innerHTML).not.toContain('com.example.chatter')
  })

  it('★是 Agent 的那一格照旧走 /agents/icon/<登记表 id>(卡 LG 那条路不回归)', async () => {
    const { discovery, clock } = await runtime()
    renderDock(stateWith(discovery.view(), clock.toISOString()))
    expect(markOf('Foo AI').img).toBe('http://wb/agents/icon/com.example.fooai')
  })

  it('★图 16px、读屏不念它(名字还是那一个)', async () => {
    const { discovery, clock } = await runtime()
    renderDock(stateWith(discovery.view(), clock.toISOString()))
    const img = screen.getByRole('button', { name: '微信' }).querySelector('img') as HTMLImageElement
    expect(img.width).toBe(16)
    expect(img).toHaveAttribute('alt', '')
    expect(img).toHaveAttribute('aria-hidden', 'true')
    // 名字一个字没变。
    expect(screen.getByRole('button', { name: '微信' })).toBeInTheDocument()
  })

  it('★★退路分两种:不是 Agent 的退回中性小方块(**不是色点**),是 Agent 的退回色点', async () => {
    const { discovery, clock } = await runtime()
    renderDock(stateWith(discovery.view(), clock.toISOString()))
    // 不是 Agent 的那一格:接口 404 / 加载失败 → 中性小方块。微信没有「在跑 / 等你」这回事,
    // 给一颗彩色圆点等于凭空发明一个语义。
    fireEvent.error(screen.getByRole('button', { name: '微信' }).querySelector('img') as HTMLImageElement)
    expect(markOf('微信')).toEqual({ dot: false, blank: true })
    // 是 Agent 的那一格:退回它自己颜色的色点(状态语义在那颗点上),不是小方块。
    fireEvent.error(screen.getByRole('button', { name: 'Foo AI' }).querySelector('img') as HTMLImageElement)
    expect(markOf('Foo AI')).toEqual({ dot: true, blank: false })
  })

  it('★还没拉进来的那一格也有图(背后还没有窗,可那个 App 装着)', async () => {
    const { discovery, clock } = await runtime()
    renderDock(stateWith(discovery.view(), clock.toISOString()))
    expect(markOf('企业微信:点一下拉进来').img).toBe('http://wb/apps/icon/wecom')
  })
})

describe('「事务官」那一格', () => {
  it('★用工作台自己的图标(登记表里 self 那一条的图就是它)', async () => {
    const { discovery, clock } = await runtime()
    const view = discovery.view()
    const self = view.entries.find(one => one.self === true)
    expect(self?.icon).toBe(true) // 巡检替工作台自己也取了一张(agentDiscovery.iconBundles)
    renderDock(stateWith(view, clock.toISOString()))
    expect(markOf('事务官').img).toBe(`http://wb/agents/icon/${self!.id}`)
  })

  it('★取不到 → 中性小方块,**不给色点**(它这一格原来一个记号都没有,一颗彩点会被读成「事务官在跑」)', async () => {
    const { discovery, clock } = await runtime()
    renderDock(stateWith(discovery.view(), clock.toISOString()))
    fireEvent.error(screen.getByRole('button', { name: '事务官' }).querySelector('img') as HTMLImageElement)
    expect(markOf('事务官')).toEqual({ dot: false, blank: true })
  })

  it('登记表整块没接(老服务端)→ 那一格照样不空:中性小方块,一个请求都不发', async () => {
    renderDock(stateWith(undefined, '2026-09-26T10:05:00.000Z'))
    expect(markOf('事务官')).toEqual({ dot: false, blank: true })
  })
})

describe('「窗口布局」那一格', () => {
  it('★内置的线性图标(评审页 `layers` 14px,不去取系统图标 —— 它不是一个 App),外格与那 16px 图标一样宽', () => {
    render(<SceneBar baseUrl="http://wb" scenes={[]} fetchImpl={vi.fn() as unknown as typeof fetch} compact />)
    const trigger = screen.getByRole('button', { name: '窗口布局' })
    const glyph = trigger.querySelector('.ben-wb__appicon-glyph')
    expect(glyph).not.toBeNull()
    const svg = glyph!.querySelector('svg')!
    expect(svg.getAttribute('width')).toBe('14')
    expect(svg.getAttribute('aria-hidden')).toBe('true')
    // 不取系统图标:这一格一张网络图片都不发。
    expect(trigger.querySelector('img')).toBeNull()
  })
})
