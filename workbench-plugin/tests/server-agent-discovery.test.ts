// @vitest-environment node
/**
 * Agent 自动发现与统一接入 —— **机制本身**的证明(卡 Q,设计第 7 条)。
 *
 * 维护者:「要是写死了就很糟糕了……你得想个机制,后面检测到是 Agent,有会话窗口的这种都得能有气泡和会话状态、标题、内容」。
 * 这份用例里的「Foo AI」是**运行时**冒出来的一家(代码里任何一张表都没有它):它开着、窗口像对话窗口、模型判它是 AI ——
 * 于是它进了登记表,四样(状态、标题、最新一句、气泡)齐全。换成人跟人聊天的,不接、不读(连窗口结构都不看)。
 * 「这不是 Agent」能撤掉;通话中巡检整个停。
 *
 * 壳与模型都是假的(tests/fixtures/agentWorld.ts),一扇真窗口都不碰。
 */
import { describe, expect, it } from 'vitest'
import type { AgentEntryView, SessionAskView, SessionView } from '../src/protocol.ts'
import type { DiscoveryAsker } from '../src/server/agentDiscovery.ts'
import { HOT_AFTER_ACTIVITY_MS, READ_BUSY_MS, READ_IDLE_MS, createAgentDiscovery } from '../src/server/agentDiscovery.ts'
import { createMemoryRegistryStore } from '../src/server/agentRegistry.ts'
import type { FakeApp } from './fixtures/agentWorld.ts'
import { chatProbe, chatRead, fakeModel, fakeShell, selfDrawnProbe } from './fixtures/agentWorld.ts'

function world(input: {
  apps: FakeApp[]
  verdicts?: Record<string, 'ai_agent' | 'human_chat' | 'other' | 'unsure'>
  second?: Record<string, 'ai_agent' | 'human_chat' | 'other' | 'unsure'>
  remainingCny?: number
  sessions?: SessionView[]
  asker?: DiscoveryAsker
  caps?: string[]
  /** 读窗口那条会话有没有一问在等他(卡 WS;生产上接 waitingService.askOf)。 */
  askOf?: (entryId: string, sessionId: string) => SessionAskView | undefined
}) {
  let clock = new Date('2026-09-25T02:00:00Z')
  let inCall = false
  const shell = fakeShell(input.apps, input.caps === undefined ? {} : { caps: input.caps })
  const model = fakeModel(input.verdicts ?? {}, input.second ?? {})
  const store = createMemoryRegistryStore()
  const timeouts: { fn: () => void, ms: number }[] = []
  let changes = 0
  const discovery = createAgentDiscovery({
    store,
    helper: shell.helper,
    judge: model.judge,
    remainingCny: async () => input.remainingCny ?? 4.5,
    inCall: () => inCall,
    sessions: () => input.sessions ?? [],
    ...(input.asker === undefined ? {} : { asker: input.asker }),
    ...(input.askOf === undefined ? {} : { askOf: input.askOf }),
    now: () => clock,
    setInterval: () => 1,
    clearInterval: () => {},
    setTimeout: (fn, ms) => { timeouts.push({ fn, ms }); return timeouts.length },
    clearTimeout: () => {},
    onChanged: () => { changes += 1 },
  })
  return {
    discovery, shell, model, store, timeouts,
    advance: (ms: number) => { clock = new Date(clock.getTime() + ms) },
    setInCall: (value: boolean) => { inCall = value },
    changes: () => changes,
    entry: (id: string): AgentEntryView | undefined => discovery.view().entries.find(one => one.id === id),
  }
}

/** 运行时冒出来的一家:代码里没有它的名字。 */
function fooAi(state: { busy: boolean, answer: string }): FakeApp {
  return {
    bundle_id: 'com.example.fooai',
    name: 'Foo AI',
    category: 'public.app-category.productivity',
    vendor: '© Foo Inc.',
    running: true,
    probe: chatProbe(),
    read: () => chatRead({ busy: state.busy, answer: state.answer }),
  }
}

/** 人跟人聊天的(窗口结构也像对话窗口 —— 结构不是判据,回话的是人)。 */
const chatter: FakeApp = {
  bundle_id: 'com.example.chatter', name: 'Chatter', category: 'public.app-category.social-networking', running: true,
  probe: chatProbe(), read: () => chatRead({ answer: '晚上一起吃饭吗' }),
}
const wechat: FakeApp = {
  bundle_id: 'com.tencent.xinWeChat', name: 'WeChat', category: 'public.app-category.social-networking', running: true,
  probe: chatProbe(), read: () => chatRead({ answer: '私人消息' }),
}
const paint: FakeApp = { bundle_id: 'com.example.paint', name: 'Paint', category: 'public.app-category.graphics-design', running: true, probe: { windows: 1 } }

describe('运行时往登记表加一个假 Agent:不改一行代码,四样齐全', () => {
  it('★App 开着 → 按身份判是 AI → 窗口像对话窗口 → 自动接上,外层提示「新接上一家」;状态、标题、最新一句都在', async () => {
    const foo = { busy: false, answer: '好的,这是本周周报的草稿。' }
    const w = world({ apps: [fooAi(foo)], verdicts: { 'Foo AI': 'ai_agent' } })
    await w.discovery.tick()

    const entry = w.entry('com.example.fooai')
    expect(entry).toBeDefined()
    expect(entry?.name).toBe('Foo AI')
    expect(entry?.found.how).toBe('startup')
    expect(entry?.found.basis).toContain('输入框')
    expect(entry?.found.basis).toContain('回话的是 AI')
    expect(entry?.sources.map(one => one.kind)).toEqual(['window'])
    expect(entry?.status).toBe('idle')
    expect(entry?.title).toBe('周报怎么写')
    expect(entry?.latest).toBe('好的,这是本周周报的草稿。')
    expect(entry?.titles).toEqual(['周报怎么写', '旅行计划'])
    expect(entry?.gaps).toEqual({})
    expect(entry?.app_running).toBe(true)
    // 会话卡片那一句「最近在做什么 · 几分钟前」与卡 P 同一个形状(activity)。
    expect(entry?.sessions[0]).toMatchObject({ agent: 'com.example.fooai', via: 'window', title: '周报怎么写', activity: { line: '好的,这是本周周报的草稿。' } })
    expect(w.discovery.view().notices.map(one => one.text)).toEqual(['新接上一家:Foo AI'])
    // 模型只问了一次(一批),包里写的类别与出品方一起给它看。
    expect(w.model.prompts).toHaveLength(1)
    expect(w.model.prompts[0]).toContain('Foo AI|com.example.fooai|productivity|© Foo Inc.')
  })

  it('★气泡:开始跑了 → 「Foo AI 开始跑了」;说完了 → 「Foo AI 回了:…」,记成没看过;他切过去停够几秒就收掉', async () => {
    const foo = { busy: false, answer: '好的,这是本周周报的草稿。' }
    const w = world({ apps: [fooAi(foo)], verdicts: { 'Foo AI': 'ai_agent' } })
    await w.discovery.tick()

    foo.busy = true
    w.advance(READ_IDLE_MS)
    await w.discovery.tick()
    let entry = w.entry('com.example.fooai')
    expect(entry?.status).toBe('running')
    expect(entry?.bubble).toMatchObject({ kind: 'started', text: 'Foo AI 开始跑了' })
    expect(entry?.counts.running).toBe(1)
    expect(entry?.sessions[0]).toMatchObject({ agent: 'com.example.fooai', status: 'running', title: '周报怎么写', via: 'window' })

    // 在跑的那一家几秒读一次:停止键没了、字不再变 → 说完了。
    foo.busy = false
    foo.answer = '周报写好了,一共三段:完成、进行中、下周计划。'
    w.advance(READ_BUSY_MS)
    await w.discovery.tick()
    w.advance(READ_BUSY_MS)
    await w.discovery.tick()
    entry = w.entry('com.example.fooai')
    expect(entry?.status).toBe('idle')
    expect(entry?.latest).toBe('周报写好了,一共三段:完成、进行中、下周计划。')
    expect(entry?.bubble).toMatchObject({ kind: 'replied' })
    expect(entry?.bubble?.text).toContain('Foo AI 回了:周报写好了')
    expect(entry?.counts.unread).toBe(1)
    expect(entry?.sessions[0]).toMatchObject({ status: 'done', unread: true })

    // 他切到 Foo AI、停够几秒 = 看过了。
    w.discovery.handleAppEvent({ event: 'activated', bundle_id: 'com.example.fooai', name: 'Foo AI' })
    const dwell = w.timeouts.at(-1)
    expect(dwell?.ms).toBe(5000)
    dwell?.fn()
    await Promise.resolve()
    expect(w.entry('com.example.fooai')?.counts.unread).toBe(0)
  })

  it('它自己带了中文名就用中文名(界面是中文的);模型两个名字都看得到', async () => {
    const doubaoLike: FakeApp = { ...fooAi({ busy: false, answer: '你好' }), bundle_id: 'com.example.dou', name: 'Dou', name_zh: '豆豆' }
    const w = world({ apps: [doubaoLike], verdicts: { '豆豆(Dou)': 'ai_agent' } })
    await w.discovery.tick()
    expect(w.model.prompts[0]).toContain('|豆豆(Dou)|com.example.dou|')
    expect(w.entry('com.example.dou')?.name).toBe('豆豆')
    expect(w.discovery.view().notices.map(one => one.text)).toEqual(['新接上一家:豆豆'])
    // 事件里带的是系统语言下的名字,不拿它覆盖。
    w.discovery.handleAppEvent({ event: 'activated', bundle_id: 'com.example.dou', name: 'Dou' })
    expect(w.entry('com.example.dou')?.name).toBe('豆豆')
  })

  it('★App 启动那一刻发现(一分钟内出现):等窗口画出来(几秒)再判', async () => {
    const foo = fooAi({ busy: false, answer: '你好' })
    foo.running = false
    const w = world({ apps: [foo], verdicts: { 'Foo AI': 'ai_agent' } })
    await w.discovery.tick()
    expect(w.entry('com.example.fooai')).toBeUndefined()

    foo.running = true
    w.discovery.handleAppEvent({ event: 'launched', bundle_id: 'com.example.fooai', name: 'Foo AI' })
    await w.discovery.tick()
    expect(w.entry('com.example.fooai')).toBeUndefined()
    w.advance(6000)
    await w.discovery.tick()
    const entry = w.entry('com.example.fooai')
    expect(entry?.found.how).toBe('launch')
    expect(entry?.latest).toBe('你好')
  })

  it('★App 没开:显示最后一次读到的,带时间;状态、标题、最新一句都还在', async () => {
    const w = world({ apps: [fooAi({ busy: false, answer: '好的,这是本周周报的草稿。' })], verdicts: { 'Foo AI': 'ai_agent' } })
    await w.discovery.tick()
    w.discovery.handleAppEvent({ event: 'terminated', bundle_id: 'com.example.fooai' })
    const entry = w.entry('com.example.fooai')
    expect(entry?.app_running).toBe(false)
    expect(entry?.status).toBe('idle')
    expect(entry?.title).toBe('周报怎么写')
    expect(entry?.latest).toBe('好的,这是本周周报的草稿。')
    expect(entry?.note).toMatch(/^Foo AI 没开,显示的是 \d{2}:\d{2} 最后一次读到的$/)
    expect(entry?.sessions[0]?.status).toBe('offline')
    // 没开就不读。
    const before = w.shell.reads('com.example.fooai').length
    w.advance(READ_IDLE_MS)
    await w.discovery.tick()
    expect(w.shell.reads('com.example.fooai')).toHaveLength(before)
  })

  it('★只存需要的:登记表里是标题、最新一句(截断)、时间、状态 —— 没有整段对话', async () => {
    const long = `开头${'很长的回答'.repeat(60)}`
    const w = world({ apps: [fooAi({ busy: false, answer: long })], verdicts: { 'Foo AI': 'ai_agent' } })
    await w.discovery.tick()
    await w.discovery.stop()
    const saved = w.store.current()?.apps['com.example.fooai']
    expect(saved?.state).toBe('connected')
    expect(saved?.last?.title).toBe('周报怎么写')
    expect([...(saved?.last?.latest ?? '')].length).toBeLessThanOrEqual(121)
    const text = JSON.stringify(w.store.current())
    expect(text).not.toContain('帮我写一份周报')
    expect(text).not.toContain(long)
  })
})

describe('人跟人聊天的:不接、不读', () => {
  it('★模型判是人跟人聊天的 → 连窗口结构都不看;微信 / 企业微信连模型都不问', async () => {
    const w = world({ apps: [chatter, wechat, paint], verdicts: { Chatter: 'human_chat', Paint: 'other' } })
    await w.discovery.tick()
    w.advance(READ_IDLE_MS)
    await w.discovery.tick()
    expect(w.shell.touched('com.example.chatter')).toEqual([])
    expect(w.shell.touched('com.tencent.xinWeChat')).toEqual([])
    expect(w.shell.touched('com.example.paint')).toEqual([])
    expect(w.model.prompts.join('\n')).not.toContain('com.tencent.xinWeChat')
    const ids = w.discovery.view().entries.map(one => one.id)
    expect(ids).not.toContain('com.example.chatter')
    expect(ids).not.toContain('com.tencent.xinWeChat')
    const apps = w.discovery.detail().apps
    expect(apps.find(one => one.bundle_id === 'com.example.chatter')).toMatchObject({ state: 'not_agent', verdict: { kind: 'human_chat', by: 'model' } })
    expect(apps.find(one => one.bundle_id === 'com.tencent.xinWeChat')).toMatchObject({ state: 'not_agent', verdict: { kind: 'human_chat', by: 'floor' } })
    // 切到前台也不看。
    w.discovery.handleAppEvent({ event: 'activated', bundle_id: 'com.example.chatter', name: 'Chatter' })
    w.discovery.handleAppEvent({ event: 'activated', bundle_id: 'com.tencent.xinWeChat', name: 'WeChat' })
    await w.discovery.tick()
    expect(w.shell.touched('com.example.chatter')).toEqual([])
    expect(w.shell.touched('com.tencent.xinWeChat')).toEqual([])
  })

  it('★只凭名字判不了、结构又像的:带上界面字再判,判出是人 → 只看过一次结构,内容一个字都不读', async () => {
    const mystery: FakeApp = { ...chatter, bundle_id: 'com.example.mystery', name: 'Mystery' }
    const w = world({ apps: [mystery], verdicts: { Mystery: 'unsure' }, second: { Mystery: 'human_chat' } })
    await w.discovery.tick()
    w.advance(READ_IDLE_MS)
    await w.discovery.tick()
    expect(w.shell.touched('com.example.mystery').map(one => one.op)).toEqual(['agent_probe'])
    expect(w.shell.reads('com.example.mystery')).toEqual([])
    expect(w.discovery.view().entries.map(one => one.id)).not.toContain('com.example.mystery')
    expect(w.model.prompts[1]).toContain('没有任何聊天内容')
  })
})

describe('拿不准的:不读,在外层问一句', () => {
  it('★两道都判不出 → 「XX 像是个 Agent,要接上吗?」;他说要 → 接上', async () => {
    const asked: string[] = []
    let answer: ((value: 'yes' | 'no' | 'skip') => void) | undefined
    const asker: DiscoveryAsker = {
      ask: async (input) => {
        asked.push(input.question)
        return await new Promise(resolve => { answer = resolve })
      },
    }
    const mosaic: FakeApp = { ...fooAi({ busy: false, answer: '你好,我能帮你做什么?' }), bundle_id: 'com.example.mosaic', name: 'Mosaic' }
    const w = world({ apps: [mosaic], verdicts: { Mosaic: 'unsure' }, second: { Mosaic: 'unsure' }, asker })
    await w.discovery.tick()
    expect(asked).toEqual(['Mosaic 像是个 Agent,要接上吗?'])
    expect(w.discovery.view().asking).toMatchObject([{ id: 'com.example.mosaic', question: 'Mosaic 像是个 Agent,要接上吗?' }])
    expect(w.entry('com.example.mosaic')).toBeUndefined()
    expect(w.shell.reads('com.example.mosaic')).toEqual([])

    answer?.('yes')
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(w.discovery.view().asking).toEqual([])
    expect(w.entry('com.example.mosaic')?.found.how).toBe('user')
    await w.discovery.tick()
    expect(w.entry('com.example.mosaic')?.latest).toBe('你好,我能帮你做什么?')
  })
})

describe('「这不是 Agent」能撤掉', () => {
  it('★他说一句就从登记表里撤掉,以后不判、不读;说「接上」又回来', async () => {
    const w = world({ apps: [fooAi({ busy: false, answer: '好的' })], verdicts: { 'Foo AI': 'ai_agent' } })
    await w.discovery.tick()
    expect(w.entry('com.example.fooai')).toBeDefined()

    const result = await w.discovery.notAgent('com.example.fooai')
    expect(result).toEqual({ ok: true, note: '好,Foo AI 不算 Agent 了,以后不读它' })
    expect(w.entry('com.example.fooai')).toBeUndefined()
    const reads = w.shell.touched('com.example.fooai').length
    w.discovery.handleAppEvent({ event: 'activated', bundle_id: 'com.example.fooai', name: 'Foo AI' })
    w.advance(READ_IDLE_MS * 3)
    await w.discovery.tick()
    await w.discovery.tick()
    expect(w.shell.touched('com.example.fooai')).toHaveLength(reads)
    expect(w.store.current()?.not_agents['com.example.fooai']?.name).toBe('Foo AI')

    const back = await w.discovery.connect('com.example.fooai')
    expect(back.ok).toBe(true)
    await w.discovery.tick()
    expect(w.entry('com.example.fooai')?.found.how).toBe('user')
    expect(w.entry('com.example.fooai')?.latest).toBe('好的')
  })

  it('★有专门读法的那一家也能撤:按登记表 id 说(claude),登记簿按包标识记;会话记录里再有会话也不回来', async () => {
    const sessions: SessionView[] = [{
      agent: 'claude', session_id: 's1', project: 'workbench', status: 'running', title: '修登记表', elapsed_sec: 30, unread: false, updated_at: '2026-09-25T01:59:00Z',
    }]
    const w = world({ apps: [], sessions })
    expect(w.entry('claude')).toBeDefined()
    expect((await w.discovery.notAgent('claude')).ok).toBe(true)
    expect(w.entry('claude')).toBeUndefined()
    expect(w.store.current()?.not_agents['com.anthropic.claudefordesktop']?.name).toBe('Claude')
    expect((await w.discovery.connect('claude')).ok).toBe(true)
    expect(w.entry('claude')).toBeDefined()
  })

  it('事务官自己撤不掉', async () => {
    const w = world({ apps: [] })
    expect((await w.discovery.notAgent('dsh')).ok).toBe(false)
  })
})

describe('通话中巡检暂停', () => {
  it('★通话中一个窗口都不碰(不扫、不判、不看、不读);挂断后接着来,通话中起来的那一家也补上', async () => {
    const foo = { busy: false, answer: '好的' }
    const w = world({ apps: [fooAi(foo)], verdicts: { 'Foo AI': 'ai_agent' } })
    w.setInCall(true)
    await w.discovery.tick()
    expect(w.shell.calls).toEqual([])
    expect(w.model.prompts).toEqual([])
    expect(w.discovery.view().paused).toBe('通话中,先停着')

    w.discovery.handleAppEvent({ event: 'launched', bundle_id: 'com.example.fooai', name: 'Foo AI' })
    w.advance(READ_IDLE_MS)
    await w.discovery.tick()
    expect(w.shell.calls).toEqual([])

    w.setInCall(false)
    await w.discovery.tick()
    expect(w.discovery.view().paused).toBeUndefined()
    expect(w.entry('com.example.fooai')?.latest).toBe('好的')
  })

  it('接上之后的巡检也停:通话中一次都不读', async () => {
    const w = world({ apps: [fooAi({ busy: true, answer: '写着呢' })], verdicts: { 'Foo AI': 'ai_agent' } })
    await w.discovery.tick()
    const before = w.shell.calls.length
    w.setInCall(true)
    for (let i = 0; i < 5; i += 1) {
      w.advance(READ_BUSY_MS)
      await w.discovery.tick()
    }
    expect(w.shell.calls).toHaveLength(before)
  })
})

describe('花费有上限,计入每日额度', () => {
  it('★中转那边今天剩得少了:不问模型、不看窗口,记下原因明天再判', async () => {
    const w = world({ apps: [fooAi({ busy: false, answer: '好的' })], verdicts: { 'Foo AI': 'ai_agent' }, remainingCny: 0.4 })
    await w.discovery.tick()
    expect(w.model.prompts).toEqual([])
    expect(w.shell.touched('com.example.fooai')).toEqual([])
    const app = w.discovery.detail().apps.find(one => one.bundle_id === 'com.example.fooai')
    expect(app?.pending).toContain('留给通话和事务官')
    expect(w.discovery.detail().budget.calls).toBe(0)
    // 界面上明说还有几个没判(不默默不显示)。
    expect(w.discovery.view().note).toContain('还有 1 个开着的 App 没判是不是 Agent')
  })

  it('每个 App 只判一次:判完记下来,第二天不再问', async () => {
    const w = world({ apps: [fooAi({ busy: false, answer: '好的' }), chatter], verdicts: { 'Foo AI': 'ai_agent', Chatter: 'human_chat' } })
    await w.discovery.tick()
    expect(w.model.prompts).toHaveLength(1)
    w.advance(24 * 60 * 60_000)
    w.discovery.helperChanged()
    await w.discovery.tick()
    expect(w.model.prompts).toHaveLength(1)
    expect(w.discovery.detail().budget).toMatchObject({ calls: 0 })
  })
})

describe('专门读法挂在登记条目上,与别家走同一条路', () => {
  it('★事务官自己永远在最前;Claude 的会话记录里有会话 → 凭它登记,四样从会话来', () => {
    const sessions: SessionView[] = [{
      agent: 'claude', session_id: 's1', project: 'workbench', status: 'running', title: '修登记表', summary: '正在跑测试',
      elapsed_sec: 30, unread: false, updated_at: '2026-09-25T01:59:00Z',
    }]
    const w = world({ apps: [], sessions })
    const view = w.discovery.view()
    expect(view.entries[0]).toMatchObject({ id: 'dsh', name: '事务官', self: true })
    // 有专门读法的那一家,登记表 id 就是那一路的 id(事项卡的 links、/read、/sessions/digest 认的都是它),包标识在 bundle_id。
    const claude = view.entries.find(one => one.id === 'claude')
    expect(claude).toMatchObject({ name: 'Claude', bundle_id: 'com.anthropic.claudefordesktop', status: 'running', title: '修登记表', latest: '正在跑测试', found: { how: 'sessions' } })
    expect(claude?.sessions[0]).toMatchObject({ agent: 'claude', session_id: 's1', via: 'sessions' })
    expect(claude?.counts.running).toBe(1)
  })
})

/**
 * ★ **自绘界面那一家**(2026-10-02,卡「适配自绘界面的 Kimi」)。
 *
 * 现场:Air 上官网版 Kimi `com.moonshot.kimichat.kmp.mac` 登录之后,辅助功能树里对话文字读得到
 * (23 块静态文本),输入框与发送键被那套自绘工具箱画成了 `AXUnknown` —— 结构那一道认不出,
 * 整家停在候选、派不了活。这一组钉的是:**它接上,接上的那一档说得清是哪一档**,
 * 而且诊断包里带上那棵树的明细(下一次不用再上真机猜)。
 */
describe('自绘界面:读得到、写入靠粘贴那一档', () => {
  const kimiKmp = (over: Partial<FakeApp> = {}): FakeApp => ({
    bundle_id: 'com.moonshot.kimichat.kmp.mac',
    name: 'Kimi',
    category: 'public.app-category.productivity',
    vendor: '© Moonshot AI',
    running: true,
    probe: selfDrawnProbe(),
    read: () => chatRead({ answer: '一周有七天。', title: 'Kimi' }),
    ...over,
  })

  it('★接上了,派活候选里有它;判定依据里明说这一档是「点一下 + 粘贴」', async () => {
    const w = world({ apps: [kimiKmp()], verdicts: { Kimi: 'ai_agent' } })
    await w.discovery.tick()
    // 名字「Kimi」命中 `agentSources` 里 kimi 那一路 → 登记表 id 是 `kimi`(不是包标识)。
    const entry = w.entry('kimi')
    expect(entry).toBeDefined()
    expect(entry?.bundle_id).toBe('com.moonshot.kimichat.kmp.mac')
    expect(entry?.found.basis).toContain('自绘界面')
    expect(entry?.found.basis).toContain('粘贴')
    // kimi 那一路本来就有会话文件那只手(`agentSources` 的 feed),窗口这只手照旧在。
    expect(entry?.sources.map(one => one.kind)).toContain('window')
    // 「读不到它的窗口」那一行里**不许**再有它(它读得到,也送得进去)。
    expect(w.discovery.view().unreadable ?? []).toEqual([])
    const judged = w.discovery.detail().apps.find(one => one.bundle_id === 'com.moonshot.kimichat.kmp.mac')
    expect(judged?.state).toBe('connected')
    expect(judged?.structure?.mode).toBe('paste_only')
  })

  it('★诊断包里带上那棵树的明细(只有结构与字数);认得出输入框的那一家不带', async () => {
    const detail = {
      window: { w: 1200, h: 800 }, visited: 75,
      elements: [
        { role: 'AXWindow', d: 0, x: 0, y: 0, w: 1200, h: 800 },
        { role: 'AXUnknown', d: 6, x: 220, y: 700, w: 760, h: 56, act: ['AXPress'], set: ['AXFocused'], vl: 0 },
        // 壳哪天多回了一格字,服务端这道门也要把它扔掉。
        { role: 'AXStaticText', d: 5, x: 300, y: 300, w: 600, h: 40, t: '一周有七天。', tl: 6 },
      ],
    }
    const w = world({
      apps: [kimiKmp({ ax_detail: detail }), fooAi({ busy: false, answer: '好的' })],
      verdicts: { Kimi: 'ai_agent', 'Foo AI': 'ai_agent' },
    })
    await w.discovery.tick()
    const apps = w.discovery.detail().apps
    const kimi = apps.find(one => one.bundle_id === 'com.moonshot.kimichat.kmp.mac')
    expect(kimi?.ax_detail?.elements).toHaveLength(3)
    expect(kimi?.ax_detail?.elements[1]).toEqual({ role: 'AXUnknown', d: 6, x: 220, y: 700, w: 760, h: 56, act: ['AXPress'], set: ['AXFocused'], vl: 0 })
    expect(JSON.stringify(kimi?.ax_detail)).not.toContain('一周有七天')
    expect(kimi?.ax_detail?.elements[2]).toEqual({ role: 'AXStaticText', d: 5, x: 300, y: 300, w: 600, h: 40, tl: 6 })
    // 认得出输入框的那一家没有要查的 —— 这一格一直缺席(也没去问壳)。
    expect(apps.find(one => one.bundle_id === 'com.example.fooai')?.ax_detail).toBeUndefined()
    expect(w.shell.calls.filter(one => one.op === 'agent_ax_detail').map(one => one.bundle_id))
      .toEqual(['com.moonshot.kimichat.kmp.mac'])
  })

  it('★老壳不认 agent_ax_detail:吞掉,那一格缺席,结构那一道的结论一字不改', async () => {
    const w = world({ apps: [kimiKmp()], verdicts: { Kimi: 'ai_agent' } })
    await w.discovery.tick()
    const judged = w.discovery.detail().apps.find(one => one.bundle_id === 'com.moonshot.kimichat.kmp.mac')
    expect(judged?.ax_detail).toBeUndefined()
    expect(judged?.structure?.pass).toBe(true)
    expect(judged?.structure?.mode).toBe('paste_only')
    expect(w.entry('kimi')).toBeDefined()
  })

  it('★没登录那一份(一扇窗一张图)照旧停在候选,「读不到它的窗口」那一行里摆着它', async () => {
    const w = world({
      apps: [kimiKmp({ probe: { windows: 1, window: { w: 1200, h: 800 }, roles: { AXWindow: 1, AXImage: 1 },
        inputs: [], send: [], stop: [], new_chat: { menu: [], buttons: [] }, lists: [], left_links: 0,
        texts: { total: 0, left: 0, above_input: 0 }, toolbar: [], menus: [], visited: 2 } })],
      verdicts: { Kimi: 'ai_agent' },
    })
    await w.discovery.tick()
    expect(w.entry('kimi')).toBeUndefined()
    expect((w.discovery.view().unreadable ?? []).map(one => one.bundle_id)).toEqual(['com.moonshot.kimichat.kmp.mac'])
    const judged = w.discovery.detail().apps.find(one => one.bundle_id === 'com.moonshot.kimichat.kmp.mac')
    expect(judged?.state).toBe('candidate')
  })
})

describe('壳是旧版 / 没授权 / 没开', () => {
  it('★壳没有辅助功能授权(第一次装多半是这样):一扇窗都不碰,但点名说清「还看不到 Foo AI 在忙什么」、要开什么;一开就接上', async () => {
    let authorized = false
    const w = world({ apps: [fooAi({ busy: false, answer: '好的' }), chatter], verdicts: { 'Foo AI': 'ai_agent', Chatter: 'human_chat' } })
    ;(w.shell.helper as { view?: () => { authorized: boolean } }).view = () => ({ authorized })
    await w.discovery.tick()
    // 只问了「正在跑的是哪几个 App」(不碰辅助功能),没碰任何一扇窗。
    expect(w.shell.calls.map(one => one.op)).toEqual(['running_apps'])
    expect(w.discovery.view().paused).toBe('工作台还没开「辅助功能」权限')
    expect(w.discovery.view().blocked).toEqual({
      kind: 'accessibility',
      text: '还看不到 Foo AI 在忙什么:得给工作台开「辅助功能」权限',
      apps: ['Foo AI'],
    })
    expect(w.entry('com.example.fooai')).toBeUndefined()

    authorized = true
    await w.discovery.tick()
    expect(w.discovery.view().blocked).toBeUndefined()
    expect(w.entry('com.example.fooai')?.latest).toBe('好的')
    expect(w.shell.touched('com.example.chatter')).toEqual([])
  })

  it('没授权、也还没认出哪家像 Agent:照样一句能懂的话,不是空白', async () => {
    const w = world({ apps: [paint], verdicts: { Paint: 'other' } })
    ;(w.shell.helper as { view?: () => { authorized: boolean } }).view = () => ({ authorized: false })
    await w.discovery.tick()
    expect(w.discovery.view().blocked).toEqual({ kind: 'accessibility', text: '要看各家 Agent 在忙什么,得给工作台开「辅助功能」权限' })
  })

  it('旧壳不会读别家的窗口:一个请求都不发,明说要装新版', async () => {
    const w = world({ apps: [fooAi({ busy: false, answer: '好的' })], verdicts: { 'Foo AI': 'ai_agent' }, caps: ['new_conversation', 'read_reply'] })
    await w.discovery.tick()
    expect(w.shell.calls).toEqual([])
    expect(w.discovery.view().note).toContain('装上新版工作台 App')
    expect(w.discovery.view().blocked).toEqual({ kind: 'old_shell', text: '这台电脑上的工作台 App 是旧版,还看不到别家 Agent 在忙什么 —— 装上新版工作台 App 就好' })
  })
})

/**
 * 窗口型 Agent 的三态(2026-09-26,卡 WS)。维护者原话:「新加的是不是状态不全,只有完成的,
 * 但是没有弹过待确认还有执行中的气泡」。这一组钉的是**服务端那一半**:
 * ① 「执行中」为什么以前看不见 —— 短活整个落在两次读中间(3 分钟那一档);
 * ② 「刚有动静」之后密读几分钟就看得见了,几分钟过完自己回到 3 分钟那档;
 * ③ 「在等你」走与文件型会话同一份判断(`askOf`),只挂 `ask`、不改运行状态。
 */
describe('窗口型 Agent 的三态:执行中 / 在等你 / 做完未读', () => {
  /** 半分钟就答完的一轮:开始跑 → 跑完。 */
  async function shortRun(w: ReturnType<typeof world>, foo: { busy: boolean, answer: string }, stepMs: number): Promise<string[]> {
    const seen: string[] = []
    const note = (): void => {
      const entry = w.entry('com.example.fooai')
      if (entry !== undefined) seen.push(`${entry.status}${entry.bubble === undefined ? '' : `/${entry.bubble.kind}`}`)
    }
    foo.busy = true
    w.advance(stepMs)
    await w.discovery.tick()
    note()
    foo.busy = false
    foo.answer = '查完了,那条报错是 cookie 的 id 写错了。'
    w.advance(stepMs)
    await w.discovery.tick()
    note()
    w.advance(stepMs)
    await w.discovery.tick()
    note()
    return seen
  }

  it('★★09-26 那条根因的一半:没有动静的那一家 3 分钟读一次 —— 半分钟答完的短活只看得见「回了」,等不到「开始跑了」', async () => {
    const foo = { busy: false, answer: '好的,我看看。' }
    const w = world({ apps: [fooAi(foo)], verdicts: { 'Foo AI': 'ai_agent' } })
    await w.discovery.tick()
    // 一拍 10 秒地走:三分钟那一档下,这几拍一次都读不到(readDue 还没到)。
    const seen = await shortRun(w, foo, 10_000)
    expect(seen).toEqual(['idle', 'idle', 'idle'])
    expect(w.entry('com.example.fooai')?.bubble).toBeUndefined()
  })

  it('★★派活刚送了话(nudge)→ 接下来几分钟按在跑的节奏读:同一个短活,「开始跑了」与「回了」都看得见', async () => {
    const foo = { busy: false, answer: '好的,我看看。' }
    const w = world({ apps: [fooAi(foo)], verdicts: { 'Foo AI': 'ai_agent' } })
    await w.discovery.tick()
    w.discovery.nudge('com.example.fooai')
    w.advance(3000)
    await w.discovery.tick()

    const seen = await shortRun(w, foo, READ_BUSY_MS)
    expect(seen[0]).toBe('running/started')
    expect(seen.at(-1)).toBe('idle/replied')
    const entry = w.entry('com.example.fooai')
    // 白点与蓝点数的都是它这一条(坞上那两档的来源)。
    expect(entry?.counts.unread).toBe(1)
    expect(entry?.sessions[0]).toMatchObject({ status: 'done', unread: true, via: 'window' })
  })

  it('★他切到那扇窗 / 从那扇窗切走,也算刚有动静(送话进窗口时壳自己会激活它)', async () => {
    const foo = { busy: false, answer: '好的,我看看。' }
    const w = world({ apps: [fooAi(foo)], verdicts: { 'Foo AI': 'ai_agent' } })
    await w.discovery.tick()
    w.discovery.handleAppEvent({ event: 'activated', bundle_id: 'com.example.fooai', name: 'Foo AI' })
    w.advance(2000)
    await w.discovery.tick()
    expect((await shortRun(w, foo, READ_BUSY_MS))[0]).toBe('running/started')
  })

  it('★热那几分钟过完自己回到 3 分钟那一档 —— 不是把巡检整体调密', async () => {
    const foo = { busy: false, answer: '好的,我看看。' }
    const w = world({ apps: [fooAi(foo)], verdicts: { 'Foo AI': 'ai_agent' } })
    await w.discovery.tick()
    w.discovery.nudge('com.example.fooai')
    w.advance(3000)
    await w.discovery.tick()
    // 空转过这几分钟(内容一直没变):热窗到期。
    for (let i = 0; i < HOT_AFTER_ACTIVITY_MS / READ_BUSY_MS + 2; i += 1) {
      w.advance(READ_BUSY_MS)
      await w.discovery.tick()
    }
    expect((await shortRun(w, foo, 10_000))).toEqual(['idle', 'idle', 'idle'])
  })

  it('★她一直停在那扇窗前(读到 active)→ 热窗过了也照在跑的节奏读:第二轮的「开始跑了」看得见(10-08 千问办公)', async () => {
    const foo = { busy: false, answer: '好的,我看看。' }
    const app = fooAi(foo)
    const w = world({ apps: [{ ...app, read: () => chatRead({ busy: foo.busy, answer: foo.answer, active: true }) }], verdicts: { 'Foo AI': 'ai_agent' } })
    await w.discovery.tick()
    w.discovery.nudge('com.example.fooai')
    w.advance(3000)
    await w.discovery.tick()
    for (let i = 0; i < HOT_AFTER_ACTIVITY_MS / READ_BUSY_MS + 2; i += 1) {
      w.advance(READ_BUSY_MS)
      await w.discovery.tick()
    }
    // 她正看着它:不弹「开始跑了」那句,但状态是在跑(白点、事务官卡片都按状态来)。
    expect((await shortRun(w, foo, READ_BUSY_MS))[0]).toMatch(/^running/)
  })

  it('★★在等你:与文件型会话同一份判断(askOf)挂到那条窗口会话上,**不改运行状态**', async () => {
    const foo = { busy: false, answer: '两种改法,你选哪个?' }
    const asked: string[] = []
    const ask: SessionAskView = { kind: 'choose', question: '两种改法你选哪个', since: '2026-09-25T02:00:00.000Z', by: 'rules' }
    const w = world({
      apps: [fooAi(foo)],
      verdicts: { 'Foo AI': 'ai_agent' },
      askOf: (id, sessionId) => { asked.push(`${id}|${sessionId}`); return ask },
    })
    await w.discovery.tick()

    const entry = w.entry('com.example.fooai')
    // 问的就是登记表那条窗口会话(id 两边同一个)。
    expect(asked[0]).toBe(`com.example.fooai|${entry?.sessions[0]?.session_id}`)
    expect(entry?.sessions[0]?.ask).toEqual(ask)
    // 运行状态原样(做完了),**不是** waiting —— 那一问走「等你」那一堆,不占这一格的运行状态档。
    expect(entry?.sessions[0]?.status).toBe('done')
    expect(entry?.status).toBe('idle')
    expect(entry?.counts.waiting).toBe(0)
  })

  it('★windows():喂给「在等你」那一份 —— 最新那句、它的时刻、运行状态、是不是它刚说完的', async () => {
    const foo = { busy: false, answer: '好的,我看看。' }
    const w = world({ apps: [fooAi(foo)], verdicts: { 'Foo AI': 'ai_agent' } })
    await w.discovery.tick()
    // 第一次读:分不清那句是谁说的 → answered 缺席,不判。
    expect(w.discovery.windows()).toEqual([
      { agent: 'com.example.fooai', session_id: expect.stringMatching(/^window:[0-9a-f]{8}$/), latest: '好的,我看看。', at: expect.any(String), status: 'done', name: 'Foo AI' },
    ])
    w.discovery.nudge('com.example.fooai')
    w.advance(3000)
    await w.discovery.tick()
    await shortRun(w, foo, READ_BUSY_MS)
    const [one] = w.discovery.windows()
    expect(one).toMatchObject({ latest: '查完了,那条报错是 cookie 的 id 写错了。', status: 'done', answered: true })
  })

  it('★有专门读法、又真有会话的那几家不走这条路(那条窗口会话根本不上表,别替它去问模型)', async () => {
    const claudeApp: FakeApp = {
      bundle_id: 'com.anthropic.claudefordesktop', name: 'Claude', category: 'public.app-category.developer-tools', running: true,
      probe: chatProbe(), read: () => chatRead({ answer: '要不要合进 main?' }),
    }
    const sessions: SessionView[] = [{ agent: 'claude', session_id: 'c1', project: 'p', status: 'done', elapsed_sec: 30, unread: false, updated_at: '2026-09-25T02:00:00.000Z' }]
    const w = world({ apps: [claudeApp], verdicts: { Claude: 'ai_agent' }, sessions })
    await w.discovery.tick()
    expect(w.discovery.windows()).toEqual([])
  })
})
