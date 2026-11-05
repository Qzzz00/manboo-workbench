/**
 * 各家的 **logo** 与「这台电脑上 N 家 Agent 客户端」——**界面这一半**(2026-09-26,卡 LG)。
 *
 * 维护者原话:「增加一个功能,就是现在电脑上有多少个 Agent 客户端,把对应的 logo 也搞上;
 * 桌面端的应用标签,也加各家的 logo icon」。
 *
 * 同卡 Q 那一份的做法:这里的「Foo AI」是**真的发现引擎**对着一扇模拟的窗口判出来、
 * 图标是**真的走了一遍壳的 `app_icon`** 之后进登记表的 —— 界面代码里没有「Foo AI」这几个字,
 * 也没有任何一家的 logo 文件。三处都验:窗口槽标签、顶栏那一排小灯、顶栏左端那一小条。
 *
 * 钉死的那条退路:**图取不到、或者加载失败,退回现在的色点**(不出错、不空白、不留破图)。
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DockTabBar } from '../src/client/DockTabBar.tsx'
import { TopBar } from '../src/client/TopBar.tsx'
import { registryCount, registryLamps } from '../src/client/agentRegistryView.ts'
import type { WorkbenchState } from '../src/protocol.ts'
import { ICON_MIN_GAP_MS, READ_IDLE_SLOW_MS, createAgentDiscovery } from '../src/server/agentDiscovery.ts'
import { createMemoryRegistryStore } from '../src/server/agentRegistry.ts'
import type { FakeApp } from './fixtures/agentWorld.ts'
import { chatProbe, chatRead, fakeModel, fakeShell } from './fixtures/agentWorld.ts'

afterEach(cleanup)

const WIDGET = { error: false, valueText: '—', alert: false }
const CAPS_NEW = ['new_conversation', 'read_reply', 'agent_window', 'icon_color', 'app_icon']

/**
 * 一台假的 Mac:「Foo AI」(图标渲得出来)与「Bar AI」(渲不出来)都在跑,都判成 Agent;
 * 「Sleepy AI」接上了却读不到窗口(用来验「还没接上」那一档灰化);「Chatter」是人跟人聊天的(不进登记表)。
 */
async function runtime(options: { caps?: string[] } = {}) {
  let clock = new Date('2026-09-26T02:00:00Z')
  const foo = { busy: false }
  const apps: FakeApp[] = [
    { bundle_id: 'com.example.fooai', name: 'Foo AI', category: 'public.app-category.productivity', running: true, icon: '#eb714d', logo: true, probe: chatProbe(), read: () => chatRead({ busy: foo.busy, answer: '好的,这是本周周报的草稿。' }) },
    { bundle_id: 'com.example.barai', name: 'Bar AI', category: 'public.app-category.productivity', running: true, probe: chatProbe(), read: () => chatRead({ answer: '在写了' }) },
    // 接上了、但**读不到窗口**的那一家(开着却一扇窗都没有):顶栏那一条上灰着画的就是它。
    { bundle_id: 'com.example.sleepy', name: 'Sleepy AI', category: 'public.app-category.productivity', running: true, logo: true, probe: chatProbe(), read: () => ({ windows: 0 }) },
    { bundle_id: 'com.example.chatter', name: 'Chatter', category: 'public.app-category.social-networking', running: true, probe: chatProbe(), read: () => chatRead({ answer: '晚上吃饭吗' }) },
  ]
  const shell = fakeShell(apps, { caps: options.caps ?? CAPS_NEW })
  const discovery = createAgentDiscovery({
    store: createMemoryRegistryStore(),
    helper: shell.helper,
    judge: fakeModel({ 'Foo AI': 'ai_agent', 'Bar AI': 'ai_agent', 'Sleepy AI': 'ai_agent', Chatter: 'human_chat' }).judge,
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
  // Foo AI 开始跑了(窗口里出现停止键):它那颗灯该是绿的 —— 状态语义换成图标之后也得还在。
  // 一拍最多读两扇窗、空闲的那几家读得慢(READ_IDLE_SLOW_MS),所以多走几拍让每一家都读到。
  foo.busy = true
  for (let i = 0; i < 6; i += 1) {
    clock = new Date(clock.getTime() + READ_IDLE_SLOW_MS)
    await discovery.tick()
  }
  const stateNow = (): WorkbenchState => ({
    agents: [], sessions: [], quota: {}, stale: false, now: clock.toISOString(),
    tasks: { tasks: [], sprints: [], modules: [], project_meta: [] },
    butler_inbox: { items: [] },
    agent_registry: discovery.view(),
    dock: {
      stack: [
        { key: 'c-fooai', label: 'Foo AI', running: true, current: false },
        { key: 'c-chatter', label: 'Chatter', running: true, current: false },
      ],
      bundles: { 'c-fooai': 'com.example.fooai', 'c-chatter': 'com.example.chatter' },
    },
  })
  return { discovery, shell, stateNow }
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

function renderTopBar(state: WorkbenchState) {
  render(
    <TopBar
      lamps={registryLamps(state)}
      agentCount={registryCount(state)}
      talk={{ baseUrl: 'http://wb', fetchImpl: vi.fn() as unknown as typeof fetch }}
      now="10:00"
      storage={WIDGET}
      performance={WIDGET}
      onOpenSettings={() => {}}
    />,
  )
}

describe('窗口槽的应用标签:名字前面是那家的 logo', () => {
  it('★它那一格有一张 16px 的图,取自 /agents/icon/<登记表 id>;读屏不念它(名字还是那一个)', async () => {
    const { stateNow } = await runtime()
    renderDock(stateNow())
    const tab = screen.getByRole('button', { name: 'Foo AI' })
    const img = tab.querySelector('img') as HTMLImageElement
    expect(img).not.toBeNull()
    expect(img.getAttribute('src')).toBe('http://wb/agents/icon/com.example.fooai')
    expect(img.width).toBe(16)
    // 图不参与读屏:那颗键念出来还是「Foo AI」,不是「Foo AI Foo AI」。
    expect(img).toHaveAttribute('alt', '')
    expect(img).toHaveAttribute('aria-hidden', 'true')
  })

  it('★图加载失败 → 当场退回色点,不留破图', async () => {
    const { stateNow } = await runtime()
    renderDock(stateNow())
    const tab = screen.getByRole('button', { name: 'Foo AI' })
    fireEvent.error(tab.querySelector('img') as HTMLImageElement)
    expect(tab.querySelector('img')).toBeNull()
    expect(tab.querySelector('.ben-wb__dotmini')).not.toBeNull()
    // 名字一个字没变(退路不该连累那颗键怎么念)。
    expect(screen.getByRole('button', { name: 'Foo AI' })).toBe(tab)
  })

  /**
   * 2026-09-26 **卡 LG2 改了这一条的后半句**。原来它钉着「不在登记表里的那一格什么都不加」,
   * 而维护者 18:05 看着坞说的正是这件事:「做事做一半,现在只有 Agent 有 logo,你看着怪不怪」。
   * 现在不在登记表里的那一格走 `/apps/icon/<坞项的键>`(那条路的用例在 tests/client-dock-icons.test.tsx),
   * 退回的**不是色点** —— 它没有「在跑 / 等你」这回事,画的是中性小方块。
   * 前半句一字没动:登记表说了这一家没有图(`icon` 是假),那条路连请求都不发。
   */
  it('★壳给不出图标的那一家:登记表那条路连请求都不发;不在登记表里的那一格走 /apps/icon', async () => {
    const { stateNow } = await runtime()
    const state = stateNow()
    // Bar AI 在登记表里但没有图标(fixture 里没给 logo)—— 顶栏那一颗灯上不发请求(见下面那一档)。
    expect(state.agent_registry?.entries.find(one => one.id === 'com.example.barai')?.icon).toBe(false)
    renderDock(state)
    // 人跟人聊天的那一格不在登记表里:图从坞那条路来,退回时是中性小方块,不是色点。
    const chatter = screen.getByRole('button', { name: 'Chatter' })
    expect((chatter.querySelector('img') as HTMLImageElement).getAttribute('src')).toBe('http://wb/apps/icon/c-chatter')
    fireEvent.error(chatter.querySelector('img') as HTMLImageElement)
    expect(chatter.querySelector('img')).toBeNull()
    expect(chatter.querySelector('.ben-wb__dotmini')).toBeNull()
    expect(chatter.querySelector('.ben-wb__appicon-blank')).not.toBeNull()
  })

  it('壳是旧版(没有 app_icon 这件本事):标签上一张图都没有,退回色点', async () => {
    const { stateNow } = await runtime({ caps: ['new_conversation', 'read_reply', 'agent_window', 'icon_color'] })
    renderDock(stateNow())
    const tab = screen.getByRole('button', { name: 'Foo AI' })
    expect(tab.querySelector('img')).toBeNull()
    expect(tab.querySelector('.ben-wb__dotmini')).not.toBeNull()
  })
})

describe('顶栏那一排小灯:换成小图标,状态那颗点叠在角上', () => {
  it('★有图的那一颗是图 + 角上的状态点(在跑还是绿的);没图的那一颗还是原来那颗点', async () => {
    const { stateNow } = await runtime()
    renderTopBar(stateNow())
    const foo = screen.getByRole('button', { name: 'Foo AI 的详情' })
    expect((foo.querySelector('img') as HTMLImageElement).getAttribute('src')).toBe('http://wb/agents/icon/com.example.fooai')
    // **状态语义没丢**:在跑那颗绿点还在,只是挪到图的右下角。
    expect(foo.querySelector('.ben-wb__lamp--teal.ben-wb__agenticon-dot')).not.toBeNull()
    const bar = screen.getByRole('button', { name: 'Bar AI 的详情' })
    expect(bar.querySelector('img')).toBeNull()
    expect(bar.querySelector('.ben-wb__dotmini')).not.toBeNull()
  })

  it('图加载失败 → 那一颗退回色点,灯色照旧', async () => {
    const { stateNow } = await runtime()
    renderTopBar(stateNow())
    const foo = screen.getByRole('button', { name: 'Foo AI 的详情' })
    fireEvent.error(foo.querySelector('img') as HTMLImageElement)
    expect(foo.querySelector('img')).toBeNull()
    expect(foo.querySelector('.ben-wb__dotmini.ben-wb__lamp--teal')).not.toBeNull()
  })
})

describe('顶栏只剩一排:排最前面那一小格「N 家」(2026-09-26,卡 TB2)', () => {
  it('★N 按登记表的条数(不写死名单);格子上只写「N 家」,整句是它的读屏名与悬停', async () => {
    const { stateNow } = await runtime()
    const state = stateNow()
    const count = registryCount(state)
    // 数的是这台电脑上的客户端:事务官自己(登记表最前那条 dsh)不算一家(统筹 2026-09-26 定)。
    const clients = (state.agent_registry?.entries ?? []).filter(one => one.id !== 'dsh')
    expect(clients.length).toBe((state.agent_registry?.entries.length ?? 0) - 1)
    expect(count.total).toBe(clients.length)
    expect(count.items.map(one => one.name)).toEqual(clients.map(one => one.name))
    // 人跟人聊天的那一家不在里面(它根本没进登记表)。
    expect(count.items.some(one => one.name === 'Chatter')).toBe(false)
    renderTopBar(state)
    const chip = screen.getByRole('button', { name: count.text })
    expect(chip).toHaveTextContent(`${count.total} 家`)
    expect(chip).toHaveAttribute('title', count.text)
    // 那一格里不再自己排一遍小图标(小灯那一排已经一家一颗了)。
    expect(chip.querySelectorAll('img')).toHaveLength(0)
    expect(document.querySelectorAll('.ben-wb__agentcount-one')).toHaveLength(0)
  })

  it('★只有一排:那一小格就在小灯那一排里,每一家在顶栏上只出现一次', async () => {
    const { stateNow } = await runtime()
    const state = stateNow()
    renderTopBar(state)
    const row = document.querySelector('.ben-wb__toplamps') as HTMLElement
    // 「N 家」那一格在这一排里(不是排外另起一条)。
    expect(row.contains(screen.getByRole('button', { name: registryCount(state).text }))).toBe(true)
    // 维护者:「这两个明显重叠了…这能整合的吧」—— 一家一处,不再两排各说一遍。
    for (const item of registryCount(state).items) expect(screen.getAllByText(item.name)).toHaveLength(1)
  })

  it('★运行时多接上一家,这个数自己就变了(一行代码都不用改)', async () => {
    const { discovery, stateNow } = await runtime()
    const before = registryCount(stateNow()).total
    await discovery.notAgent('com.example.barai')
    expect(registryCount(stateNow()).total).toBe(before - 1)
    await discovery.connect('com.example.barai')
    expect(registryCount(stateNow()).total).toBe(before)
  })

  it('★还没接上的那几家不再单独一排:在小灯这一排里灰着画,悬停说清「没接上:为什么」', async () => {
    const { stateNow } = await runtime()
    const state = stateNow()
    const dim = registryCount(state).items.filter(one => !one.connected)
    expect(dim.length).toBeGreaterThan(0)
    expect(dim.every(one => one.why.includes('没接上') || one.why.includes('还没接上'))).toBe(true)
    // 灰的那几家在**小灯排**里(不是另一条排里)。
    const lamps = registryLamps(state)
    for (const one of dim) {
      const lamp = lamps.find(item => item.id === one.id)
      expect(lamp?.dim).toBe(true)
      expect(lamp?.why).toBe(one.why)
    }
    // 事务官自己不算「没接上」(它就在这儿跑着)。
    expect(lamps.find(one => one.id === 'dsh')?.dim).toBeUndefined()
    renderTopBar(state)
    const lit = screen.getByRole('button', { name: `${dim[0]?.name as string} 的详情` })
    expect(lit).toHaveAttribute('data-dim', 'true')
    expect(lit).toHaveAttribute('title', dim[0]?.why as string)
    // 接上了的那一家不灰,悬停说的是它此刻怎样。
    const live = registryCount(state).items.find(item => item.connected)
    expect(live?.why).toContain(live?.name as string)
    expect(screen.getByRole('button', { name: `${live?.name as string} 的详情` })).not.toHaveAttribute('data-dim')
  })

  it('★点「N 家」开登记表那一档:每一家一行(图标 · 名字 · 状态);Esc 收起', async () => {
    const { stateNow } = await runtime()
    const state = stateNow()
    const count = registryCount(state)
    renderTopBar(state)
    fireEvent.click(screen.getByRole('button', { name: count.text }))
    const card = screen.getByRole('dialog', { name: count.text })
    expect(within(card).getByText(count.text)).toBeInTheDocument()
    for (const item of count.items) {
      expect(within(card).getByText(item.name)).toBeInTheDocument()
      expect(within(card).getByText(item.why)).toBeInTheDocument()
    }
    // Esc 收起。
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: count.text })).toBeNull()
  })

  it('★已经接上的那几行默认**没有**可见的「这不是 Agent」键(维护者:「每一个下面都有一个…这很蠢」);点「⋯」才出来', async () => {
    const { stateNow } = await runtime()
    const state = stateNow()
    const count = registryCount(state)
    renderTopBar(state)
    fireEvent.click(screen.getByRole('button', { name: count.text }))
    const card = screen.getByRole('dialog', { name: count.text })
    // 整张表上一颗「这不是 Agent」都看不见。
    expect(within(card).queryByLabelText(/^这不是 Agent:/)).toBeNull()
    // 判错了要撤:那一行的「⋯」点开才有。
    fireEvent.click(within(card).getByRole('button', { name: 'Foo AI:更多' }))
    expect(within(card).getByLabelText('这不是 Agent:Foo AI')).toBeInTheDocument()
    // 别的那几行还是干净的(只出来点开那一行的)。
    expect(within(card).queryByLabelText('这不是 Agent:Bar AI')).toBeNull()
    // 事务官自己连「⋯」也没有(没有可撤的)。
    expect(within(card).queryByRole('button', { name: '事务官:更多' })).toBeNull()
  })
})
