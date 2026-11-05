/**
 * Agent 自动发现与统一接入 —— **界面这一半的机制证明**(卡 Q,设计第 7 条)。
 *
 * 「运行时往登记表里加一个假 Agent(模拟的窗口结构),不改一行界面代码,它就出现在顶栏、会话列表、事务官舞台、
 * 窗口槽的圆点与气泡、『执行』计数上,四样齐全。再换成一个人跟人聊天的窗口,断言不接、不读。」
 *
 * 这里的「Foo AI」是真的发现引擎(`createAgentDiscovery`)对着一扇**模拟的窗口**判出来、读出来的,
 * 界面拿到的就是 `/state.agent_registry` 那一份 —— 整个界面代码里没有「Foo AI」这几个字。
 * 他说「这不是 Agent」之后,它从所有这些地方消失。手机那一半在 butler-app/tests/agentRegistry.test.ts。
 */
import '@testing-library/jest-dom/vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentActions } from '../src/client/AgentActions.tsx'
import { ButlerScene } from '../src/client/ButlerScene.tsx'
import { DockTabBar } from '../src/client/DockTabBar.tsx'
import { QuestionAsk } from '../src/client/QuestionAsk.tsx'
import { TopBar } from '../src/client/TopBar.tsx'
import { lampDetail, registryEntries, registryHint, registryLamps } from '../src/client/agentRegistryView.ts'
import { buildButlerScene } from '../src/client/butlerSceneModel.ts'
import { groupByAgent } from '../src/client/sessionFeed.ts'
import type { WorkbenchState } from '../src/protocol.ts'
import { AGENT_NEUTRAL_COLOR, AGENT_NEVER_READ, AGENT_READ_SCOPE } from '../src/protocol.ts'
import { READ_IDLE_MS, createAgentDiscovery } from '../src/server/agentDiscovery.ts'
import { waitingOnHim } from '../src/waiting.ts'
import { createMemoryRegistryStore } from '../src/server/agentRegistry.ts'
import type { FakeApp } from './fixtures/agentWorld.ts'
import { chatProbe, chatRead, fakeModel, fakeShell } from './fixtures/agentWorld.ts'

afterEach(cleanup)

const WIDGET = { error: false, valueText: '—', alert: false }

/** 拿不准的那一家挂进卡 M 提问经纪人之后的 /state(服务端那边 server-agent-ask 核对过就是真拼出来的那一份;手机喂的也是它)。 */
const ASK_STATE = JSON.parse(readFileSync(resolve(process.cwd(), 'tests', 'fixtures', 'agent-ask-state.json'), 'utf8')) as WorkbenchState

/** 一台假的 Mac:「Foo AI」(AI 助手,窗口像对话窗口)在跑;「Chatter」是人跟人聊天的。 */
async function runtime(options: { authorized?: boolean, icons?: boolean } = {}) {
  let clock = new Date('2026-09-25T02:00:00Z')
  const foo = { busy: false, answer: '好的,这是本周周报的草稿。' }
  const apps: FakeApp[] = [
    { bundle_id: 'com.example.fooai', name: 'Foo AI', category: 'public.app-category.productivity', running: true, probe: chatProbe(), read: () => chatRead({ busy: foo.busy, answer: foo.answer }), ...(options.icons === true ? { icon: '#eb714d' } : {}) },
    { bundle_id: 'com.example.chatter', name: 'Chatter', category: 'public.app-category.social-networking', running: true, probe: chatProbe(), read: () => chatRead({ answer: '晚上吃饭吗' }) },
  ]
  const shell = fakeShell(apps, options.icons === true ? { caps: ['new_conversation', 'read_reply', 'agent_window', 'icon_color'] } : {})
  if (options.authorized === false) (shell.helper as { view?: () => { authorized: boolean } }).view = () => ({ authorized: false })
  const discovery = createAgentDiscovery({
    store: createMemoryRegistryStore(),
    helper: shell.helper,
    judge: fakeModel({ 'Foo AI': 'ai_agent', Chatter: 'human_chat' }).judge,
    remainingCny: async () => 4,
    now: () => clock,
    setInterval: () => 1,
    clearInterval: () => {},
    setTimeout: () => 1,
    clearTimeout: () => {},
  })
  await discovery.tick()
  // 它开始跑了(窗口里出现停止键)。
  foo.busy = true
  clock = new Date(clock.getTime() + READ_IDLE_MS)
  await discovery.tick()
  const stateNow = (): WorkbenchState => ({
    agents: [], sessions: [], quota: {}, stale: false, now: clock.toISOString(),
    tasks: { tasks: [], sprints: [], modules: [], project_meta: [] },
    butler_inbox: { items: [] },
    agent_registry: discovery.view(),
    // 窗口槽里有它一格(键是自愈注册来的 c-fooai,按包标识对上登记表 —— 不靠键名猜)。
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

describe('运行时的假 Agent:不改一行界面代码,出现在所有界面上,四样齐全', () => {
  it('★顶栏:有它一颗灯,名字、在跑的颜色、冒的那一句都在', async () => {
    const { stateNow } = await runtime()
    const state = stateNow()
    render(<TopBar lamps={registryLamps(state)} now="10:00" storage={WIDGET} performance={WIDGET} onOpenSettings={() => {}} />)
    const lamp = screen.getByText('Foo AI').closest('.ben-wb__topagent') as HTMLElement
    expect(lamp).toHaveAttribute('title', 'Foo AI 开始跑了')
    expect(lamp.querySelector('.ben-wb__lamp--teal')).not.toBeNull()
    // 事务官自己在最前;人跟人聊天的那一家没有灯。
    expect(registryLamps(state).map(one => one.name)).toEqual(['事务官', 'Foo AI'])
    expect(screen.queryByText('Chatter')).toBeNull()
  })

  it('★窗口槽:它那一格有「开着」的圆点,气泡里是它那条对话的标题;人跟人聊天那一格没有会话圆点', async () => {
    const { stateNow } = await runtime()
    renderDock(stateNow())
    const tab = screen.getByRole('button', { name: 'Foo AI' }).closest('.ben-wb__dock-tab') as HTMLElement
    const dot = within(tab).getByLabelText('开着 1')
    fireEvent.mouseEnter(dot.parentElement as HTMLElement)
    expect(within(tab).getByText(/周报怎么写/)).toBeInTheDocument()
    const chatterTab = screen.getByRole('button', { name: 'Chatter' }).closest('.ben-wb__dock-tab') as HTMLElement
    expect(within(chatterTab).queryByLabelText(/开着|等确认|未读完成|出错/)).toBeNull()
  })

  it('★事务官舞台与「执行」计数:它那条在跑的对话摆在球周围,名字、标题、最新一句都在,数进执行', async () => {
    const { stateNow } = await runtime()
    const state = stateNow()
    const scene = buildButlerScene(state)
    const card = scene.items.find(item => item.external?.agent === 'com.example.fooai')
    expect(card).toMatchObject({ title: '周报怎么写', executing: true, external: { name: 'Foo AI', via: 'window' } })
    expect(card?.progress).toContain('好的,这是本周周报的草稿。')
    expect(scene.running).toBe(1)
    render(<ButlerScene state={state} onOpen={vi.fn()} onConfirm={vi.fn()}>粒子</ButlerScene>)
    const stage = screen.getByLabelText('执行中的事项')
    /*
     * 2026-09-26(卡 ST):台上**一条对话一张卡** —— 它侧栏里有「周报怎么写」(当前选中、在跑)
     * 与「旅行计划」两条,所以「Foo AI」这个名字在台上出现两次(维护者 19:20:
     * 「机器上正在跑的、我安排的事……就是一张卡」)。
     * 2026-09-26 晚(维护者:「多了好多乱七八糟,感觉好久之前的任务啊」):**空闲的那条不上台**,
     * 台上只有在跑的「周报怎么写」;「旅行计划」在它的标签与会话列表里。
     */
    expect(within(stage).getAllByText('Foo AI')).toHaveLength(1)
    expect(within(stage).getByText('周报怎么写')).toBeInTheDocument()
    expect(within(stage).queryByText('旅行计划')).toBeNull()
    expect(within(stage).getByText('在跑')).toBeInTheDocument()
    expect(within(stage).queryByText('空闲')).toBeNull()
  })

  it('★会话列表:它有一组,组里是它那条对话(在跑)', async () => {
    const { stateNow } = await runtime()
    const groups = groupByAgent(registryEntries(stateNow()))
    const foo = groups.find(group => group.name === 'Foo AI')
    expect(foo?.running).toBe(1)
    // 卡 ST:侧栏里两条对话 = 两条会话;在跑的还是「周报怎么写」那一条(会话区自己的排序把「刚完成」排在在跑前面,
    // 见 sessionFeed.STATUS_RANK —— 那是它一直的口径,这里按标题找,不按下标找)。
    expect(foo?.sessions.map(one => one.title)).toEqual(expect.arrayContaining(['周报怎么写', '旅行计划']))
    expect(foo?.sessions.find(one => one.title === '周报怎么写')).toMatchObject({ summary: '好的,这是本周周报的草稿。', status: 'running' })
    // 没被选中过的那一条:只有名字,不编状态、不编一句话(读窗口只读得到当前选中的那条)。
    expect(foo?.sessions.find(one => one.title === '旅行计划')).toMatchObject({ status: 'done', unread: false })
    expect(foo?.sessions.find(one => one.title === '旅行计划')?.summary).toBeUndefined()
    expect(groups.map(group => group.name)).not.toContain('Chatter')
  })

  it('★登记表那一份里四样齐全(状态、标题、最新一句、气泡),没有一样落到「没接上」', async () => {
    const { stateNow } = await runtime()
    const foo = stateNow().agent_registry?.entries.find(one => one.id === 'com.example.fooai')
    expect(foo).toMatchObject({ status: 'running', title: '周报怎么写', latest: '好的,这是本周周报的草稿。', bubble: { kind: 'started' } })
    expect(foo?.gaps).toEqual({})
  })
})

describe('人跟人聊天的:不接、不读;「这不是 Agent」撤掉之后所有界面都没有它', () => {
  it('★人跟人聊天的那一家:壳一次都没被要过它的窗口', async () => {
    const { shell } = await runtime()
    expect(shell.touched('com.example.chatter')).toEqual([])
  })

  it('★他说「这不是 Agent」:顶栏、窗口槽圆点、舞台、会话列表、执行计数里都没有它了', async () => {
    const { discovery, stateNow } = await runtime()
    await discovery.notAgent('com.example.fooai')
    const state = stateNow()
    expect(registryLamps(state).map(one => one.name)).toEqual(['事务官'])
    expect(buildButlerScene(state).items.some(item => item.external?.agent === 'com.example.fooai')).toBe(false)
    expect(buildButlerScene(state).running).toBe(0)
    expect(groupByAgent(registryEntries(state)).map(group => group.name)).toEqual(['事务官'])
    renderDock(state)
    const tab = screen.getByRole('button', { name: 'Foo AI' }).closest('.ben-wb__dock-tab') as HTMLElement
    expect(within(tab).queryByLabelText(/开着/)).toBeNull()
  })
})

function fakeFetch(reply: Record<string, unknown>) {
  const calls: { path: string, body: unknown }[] = []
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ path: String(input).replace('http://wb', ''), body: JSON.parse(String(init?.body ?? '{}')) })
    return new Response(JSON.stringify(reply), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  return { calls, fetchImpl }
}

describe('拿不准的那一家「要接上吗」:卡 M 那张提问卡,进「等你」那一个数', () => {
  it('★「等你」那一堆就是这一问(一件),那一行「事务官问你:Mosaic 像是个 Agent」', () => {
    expect(waitingOnHim(ASK_STATE)).toEqual(ASK_STATE.waiting)
    expect(ASK_STATE.waiting?.count).toBe(1)
  })

  it('★球下那张卡:她的话里说清接上以后读什么、不读什么;点「接上」→ POST /questions/answer,带回原样的选项名', async () => {
    const { calls, fetchImpl } = fakeFetch({ ok: true })
    const question = ASK_STATE.questions![0]!
    render(<QuestionAsk question={question} baseUrl="http://wb" fetchImpl={fetchImpl} />)
    expect(screen.getByText('Mosaic 像是个 Agent')).toBeInTheDocument()
    expect(screen.getByText(new RegExp(AGENT_READ_SCOPE.slice(0, 12)))).toBeInTheDocument()
    expect(screen.getAllByRole('button').map(one => one.textContent)).toEqual(expect.arrayContaining([
      expect.stringContaining('接上'), expect.stringContaining('不是 Agent'), expect.stringContaining('先不管'),
    ]))
    fireEvent.click(screen.getByRole('button', { name: /^接上/ }))
    await vi.waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0]).toEqual({ path: '/questions/answer', body: { id: 'q-agent', answers: [{ id: 'agent-connect', selected: ['接上'] }] } })
  })
})

describe('外层那一张:知道了 / 这不是 Agent', () => {

  it('★「新接上一家」:判错了就「这不是 Agent」当场撤回;「知道了」收掉这一句', async () => {
    const { calls, fetchImpl } = fakeFetch({ ok: true, note: '好,Foo AI 不算 Agent 了,以后不读它' })
    render(<AgentActions item={{ title: '新接上一家:Foo AI', agent: { id: 'com.example.fooai', notice_id: 'n-1' } }} talk={{ baseUrl: 'http://wb', fetchImpl }} />)
    fireEvent.click(screen.getByRole('button', { name: '这不是 Agent:新接上一家:Foo AI' }))
    expect(await screen.findByRole('status')).toHaveTextContent('不算 Agent 了')
    fireEvent.click(screen.getByRole('button', { name: '知道了' }))
    await screen.findByRole('status')
    expect(calls.map(one => one.path)).toEqual(['/agents/not-agent', '/agents/notice/dismiss'])
    expect(calls[1]?.body).toEqual({ id: 'n-1' })
  })
})

describe('「这不是 Agent」要好找:顶上它那颗灯一点就有', () => {
  // 2026-09-26 晚(卡 AC,维护者 21:40):灯上那一张**不再有**「这不是 Agent」—— 撤一家只在「N 家」面板每行的「⋯」里。
  it('★点灯:它此刻怎样、最新一句、读什么不读什么;这一张里没有「这不是 Agent」', async () => {
    const { stateNow } = await runtime()
    const { calls, fetchImpl } = fakeFetch({ ok: true, note: '好,Foo AI 不算 Agent 了,以后不读它' })
    render(<TopBar lamps={registryLamps(stateNow())} talk={{ baseUrl: 'http://wb', fetchImpl }} now="10:00" storage={WIDGET} performance={WIDGET} onOpenSettings={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Foo AI 的详情' }))
    const card = screen.getByRole('dialog', { name: 'Foo AI' })
    expect(within(card).getByText('在跑 · 周报怎么写')).toBeInTheDocument()
    expect(within(card).getByText('好的,这是本周周报的草稿。')).toBeInTheDocument()
    expect(within(card).getByText(`${AGENT_READ_SCOPE}${AGENT_NEVER_READ}`)).toBeInTheDocument()
    expect(within(card).queryByRole('button', { name: '这不是 Agent:Foo AI' })).toBeNull()
    expect(calls).toEqual([])
    // Esc 收起。
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'Foo AI' })).toBeNull()
  })

  it('事务官自己那颗灯不点开(没有「这不是 Agent」可说);别家那颗再点一次收起', async () => {
    const { stateNow } = await runtime()
    render(<TopBar lamps={registryLamps(stateNow())} talk={{ baseUrl: 'http://wb', fetchImpl: vi.fn() as unknown as typeof fetch }} now="10:00" storage={WIDGET} performance={WIDGET} onOpenSettings={() => {}} />)
    expect(screen.queryByRole('button', { name: /事务官/ })).toBeNull()
    expect(screen.getByText('事务官')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Foo AI 的详情' }))
    expect(screen.getByRole('dialog', { name: 'Foo AI' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Foo AI 的详情' }))
    expect(screen.queryByRole('dialog', { name: 'Foo AI' })).toBeNull()
  })

  it('读不到它在不在跑的时候,第一行就是「没接上:…」;有专门读法的几家不替它们说读的范围', () => {
    const detail = lampDetail({
      id: 'com.example.x', name: 'X', found: { how: 'patrol', at: '', basis: '' }, sources: [{ kind: 'window', label: '读它的窗口', ok: false }],
      status: 'unknown', gaps: { status: '没接上:还没读到 X 的窗口(通话中,先停着)' }, sessions: [], counts: { running: 0, waiting: 0, unread: 0 },
    })
    expect(detail.state).toBe('没接上:还没读到 X 的窗口(通话中,先停着)')
    expect(detail.reads).toBe(`${AGENT_READ_SCOPE}${AGENT_NEVER_READ}`)
    const claude = lampDetail({
      id: 'claude', name: 'Claude', found: { how: 'sessions', at: '', basis: '' }, sources: [{ kind: 'sessions', label: '它的会话记录', ok: true }],
      status: 'idle', gaps: {}, sessions: [], counts: { running: 0, waiting: 0, unread: 0 },
    })
    expect(claude.reads).toBeUndefined()
  })
})

describe('没给壳辅助功能授权:一句能懂的话 + 一键去开,不是空白', () => {
  it('★小灯后面那一句点名还看不到的那几家,「去打开」一键到系统设置那一页', async () => {
    const { stateNow } = await runtime({ authorized: false })
    const state = stateNow()
    // 一扇窗都没读,但认出来了:Foo AI 像是 Agent。
    expect(registryHint(state)).toEqual({ text: '还看不到 Foo AI 在忙什么:得给工作台开「辅助功能」权限', authorize: true })
    const onAction = vi.fn()
    const hint = registryHint(state)!
    render(<TopBar lamps={registryLamps(state)} agentHint={{ text: hint.text, action: '去打开', onAction }} now="10:00" storage={WIDGET} performance={WIDGET} onOpenSettings={() => {}} />)
    expect(screen.getByRole('status')).toHaveTextContent('还看不到 Foo AI 在忙什么:得给工作台开「辅助功能」权限')
    fireEvent.click(screen.getByRole('button', { name: '去打开' }))
    expect(onAction).toHaveBeenCalledTimes(1)
  })

  it('壳是旧版:说清要装新版(没有能一键做的事,不画键)', () => {
    const hint = registryHint({ agent_registry: { entries: [], asking: [], notices: [], blocked: { kind: 'old_shell', text: '这台电脑上的工作台 App 是旧版,还看不到别家 Agent 在忙什么 —— 装上新版工作台 App 就好' } } })
    expect(hint).toEqual({ text: '这台电脑上的工作台 App 是旧版,还看不到别家 Agent 在忙什么 —— 装上新版工作台 App 就好', authorize: false })
    expect(registryHint({ agent_registry: { entries: [], asking: [], notices: [] } })).toBeUndefined()
  })
})

describe('各家的颜色:从它 App 的图标来,处处同一个色', () => {
  it('★图标主色是橙(像 Claude):会话卡的小头像、事务官舞台、顶栏小灯都用登记表里那一个色,与图标同色系', async () => {
    const { stateNow } = await runtime({ icons: true })
    const state = stateNow()
    const color = state.agent_registry?.entries.find(one => one.id === 'com.example.fooai')?.color
    expect(color).toBeDefined()
    expect(color).not.toBe(AGENT_NEUTRAL_COLOR)
    // 与图标同色系(色相差不过 12°)。
    const hue = (hex: string): number => {
      const [r, g, b] = [1, 3, 5].map(i => Number.parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number]
      const max = Math.max(r, g, b); const min = Math.min(r, g, b); const d = max - min
      const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4
      return (h * 60 + 360) % 360
    }
    expect(Math.abs(hue(color as string) - hue('#eb714d'))).toBeLessThan(12)
    // 事务官舞台:它那张卡上的小头像吃这个色。
    render(<ButlerScene state={state} onOpen={vi.fn()} onConfirm={vi.fn()}>粒子</ButlerScene>)
    const avatar = document.querySelector('[data-fx-agent="com.example.fooai"]')
    expect(avatar).toHaveAttribute('data-fx-color', color)
    cleanup()
    // 顶栏小灯:名字用同一个色写。
    render(<TopBar lamps={registryLamps(state)} now="10:00" storage={WIDGET} performance={WIDGET} onOpenSettings={() => {}} />)
    expect(screen.getByRole('button', { name: 'Foo AI 的详情' })).toHaveStyle({ color })
    cleanup()
    // 会话列表那一组的小头像也是它。
    expect(groupByAgent(registryEntries(state)).find(group => group.agent === 'com.example.fooai')?.color).toBe(color)
  })

  it('没有图标(壳读不到 / 旧壳):中性灰,不猜', async () => {
    const { stateNow } = await runtime()
    const state = stateNow()
    expect(state.agent_registry?.entries.find(one => one.id === 'com.example.fooai')?.color).toBe(AGENT_NEUTRAL_COLOR)
    expect(registryLamps(state).find(one => one.id === 'com.example.fooai')?.tint).toBe(AGENT_NEUTRAL_COLOR)
  })
})
