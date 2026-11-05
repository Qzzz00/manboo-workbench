// @vitest-environment node
/**
 * 「XX 像是个 Agent,要接上吗?」挂进卡 M 的提问经纪人(2026-09-25,卡 Q;统筹:这一问算「只有他能做的」)。
 *
 * 自动发现两道都判不出的那一家,不读它、只问他一句。这一句不另起一套:
 *   - 进 `/state.questions` → `waitingOnHim` 数进「等你」那一堆、那一个数(电脑球下、「事务官」标签、手机「等你确认」都读它);
 *   - 电脑球下那张提问卡、手机「等你确认」那一张答(`POST /questions/answer`),答了两边同时消失;
 *   - 「接上」→ 接上并说一句「新接上一家」;「不是 Agent」→ 以后不判不读;「先不管」→ 7 天后再问;
 *   - 他在别处说了「这不是 Agent」/「接上」,挂着的那一问跟着撤;工作台重启,还在问的那几家再挂一次;
 *   - 不打电话(没挂在事项上),工作台不在前台时弹一条通知(卡 M 的 notify 那一套)。
 *
 * 壳与模型都是假的(tests/fixtures/agentWorld.ts);经纪人是真的(`createQuestionBroker`)。
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { PendingQuestionView, WorkbenchState } from '../src/protocol.ts'
import { AGENT_READ_SCOPE } from '../src/protocol.ts'
import { AGENT_ASK_SESSION, agentAnswerFromText, agentAnswerOf, createBrokerAsker } from '../src/server/agentAsk.ts'
import { ASK_SNOOZE_MS, createAgentDiscovery } from '../src/server/agentDiscovery.ts'
import type { RegistryFile } from '../src/server/agentRegistry.ts'
import { createMemoryRegistryStore } from '../src/server/agentRegistry.ts'
import { askCallOutEvents, askNotice, createQuestionBroker, questionViews } from '../src/server/butlerAsks.ts'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { waitingOnHim } from '../src/waiting.ts'
import type { FakeApp } from './fixtures/agentWorld.ts'
import { chatProbe, chatRead, fakeModel, fakeShell } from './fixtures/agentWorld.ts'

const FIXTURE = JSON.parse(readFileSync(resolve(process.cwd(), 'tests', 'fixtures', 'agent-ask-state.json'), 'utf8')) as WorkbenchState

/** 拿不准的一家:结构像对话窗口,模型两道都答「拿不准」。 */
const mosaic: FakeApp = {
  bundle_id: 'com.example.mosaic', name: 'Mosaic', category: 'public.app-category.productivity', running: true,
  probe: chatProbe(), read: () => chatRead({ answer: '你好,我能帮你做什么?' }),
}

const settle = async (): Promise<void> => { for (let i = 0; i < 5; i += 1) await new Promise(resolve => setTimeout(resolve, 0)) }

function world(input: { initial?: RegistryFile, store?: ReturnType<typeof createMemoryRegistryStore> } = {}) {
  let clock = new Date('2026-09-25T02:00:00.000Z')
  const now = (): Date => clock
  const shell = fakeShell([mosaic])
  const model = fakeModel({ Mosaic: 'unsure' }, { Mosaic: 'unsure' })
  const store = input.store ?? createMemoryRegistryStore(input.initial)
  const broker = createQuestionBroker(now)
  const discovery = createAgentDiscovery({
    store,
    helper: shell.helper,
    judge: model.judge,
    remainingCny: async () => 4,
    asker: createBrokerAsker(broker),
    now,
    setInterval: () => 1,
    clearInterval: () => {},
    setTimeout: () => 1,
    clearTimeout: () => {},
  })
  /** 服务端拼 /state 时那几格(同 http.ts 的 composeState:questionViews → waitingOnHim)。 */
  const state = () => {
    const questions = questionViews(broker.list(), [])
    return { questions, waiting: waitingOnHim({ questions }), registry: discovery.view() }
  }
  return { discovery, broker, shell, model, store, state, advance: (ms: number) => { clock = new Date(clock.getTime() + ms) } }
}

function answer(w: ReturnType<typeof world>, label: string): void {
  const [one] = w.broker.list()
  expect(one).toBeDefined()
  expect(w.broker.answer(one!.id, [{ id: 'agent-connect', selected: [label] }])).toEqual({ ok: true })
}

describe('拿不准的那一家:一问挂进「等你」那一堆', () => {
  it('★挂上的就是 fixtures/agent-ask-state.json 那一份:「等你 1」,那一行「事务官问你:Mosaic 像是个 Agent」;它的窗口一个字没读', async () => {
    const w = world()
    await w.discovery.tick()
    const { questions, waiting, registry } = w.state()
    const renamed = (one: PendingQuestionView): PendingQuestionView => ({ ...one, id: 'q-agent' })
    expect(questions.map(renamed)).toEqual(FIXTURE.questions)
    expect({ ...waiting, items: waiting.items.map(item => ({ ...item, key: 'question:q-agent' })) }).toEqual(FIXTURE.waiting)
    expect(registry.asking).toEqual(FIXTURE.agent_registry?.asking)
    // 一问对一件:登记表的账与「等你」那一堆对得上。
    expect(registry.asking).toHaveLength(waiting.count)
    // 读的范围那一句就在问题里(第一次见到它的人也知道接上以后读什么、不读什么)。
    expect(questions[0]?.questions[0]?.question).toContain(AGENT_READ_SCOPE)
    expect(w.shell.reads('com.example.mosaic')).toEqual([])
    expect(registry.entries.find(one => one.id === 'com.example.mosaic')).toBeUndefined()
  })

  it('★不打电话(没挂在哪件事上);工作台不在前台时那条通知说的是这一问', async () => {
    const w = world()
    await w.discovery.tick()
    const { questions } = w.state()
    expect(askCallOutEvents(questions, [])).toEqual([])
    expect(askNotice({ kind: 'question', view: questions[0]! })).toEqual({ title: '事务官有话问你', body: 'Mosaic 像是个 Agent' })
    expect(questions[0]?.session_id).toBe(AGENT_ASK_SESSION)
    expect(questions[0]?.task_id).toBeUndefined()
  })
})

describe('他答了', () => {
  it('★「接上」→ 接上、说一句「新接上一家」;那一问从「等你」里没了;下一拍就读它', async () => {
    const w = world()
    await w.discovery.tick()
    answer(w, '接上')
    await settle()
    const { questions, waiting, registry } = w.state()
    expect(questions).toEqual([])
    expect(waiting.count).toBe(0)
    expect(registry.asking).toEqual([])
    expect(registry.entries.find(one => one.id === 'com.example.mosaic')?.found.how).toBe('user')
    expect(registry.notices.map(one => one.text)).toEqual(['新接上一家:Mosaic'])
    await w.discovery.tick()
    expect(w.discovery.view().entries.find(one => one.id === 'com.example.mosaic')?.latest).toBe('你好,我能帮你做什么?')
  })

  it('★「不是 Agent」→ 以后不判、不读;那一问没了', async () => {
    const w = world()
    await w.discovery.tick()
    const calls = w.model.prompts.length
    answer(w, '不是 Agent')
    await settle()
    expect(w.state().waiting.count).toBe(0)
    expect(w.discovery.data().not_agents['com.example.mosaic']?.name).toBe('Mosaic')
    w.discovery.handleAppEvent({ event: 'activated', bundle_id: 'com.example.mosaic', name: 'Mosaic' })
    w.advance(ASK_SNOOZE_MS * 2)
    await w.discovery.tick()
    expect(w.broker.list()).toEqual([])
    expect(w.shell.reads('com.example.mosaic')).toEqual([])
    expect(w.model.prompts).toHaveLength(calls)
  })

  it('★「先不管」→ 那一问收掉(「等你」里没了),照旧不读;7 天后再问一次,不再花钱判', async () => {
    const w = world()
    await w.discovery.tick()
    const calls = w.model.prompts.length
    answer(w, '先不管')
    await settle()
    expect(w.state().waiting.count).toBe(0)
    expect(w.discovery.view().asking).toEqual([])
    expect(w.discovery.detail().apps.find(one => one.bundle_id === 'com.example.mosaic')?.ask_again_at).toBe('2026-10-02T02:00:00.000Z')

    w.advance(ASK_SNOOZE_MS - 60_000)
    await w.discovery.tick()
    expect(w.broker.list()).toEqual([])

    w.advance(120_000)
    await w.discovery.tick()
    expect(w.state().waiting.count).toBe(1)
    expect(w.discovery.view().asking).toHaveLength(1)
    expect(w.shell.reads('com.example.mosaic')).toEqual([])
    expect(w.model.prompts).toHaveLength(calls)
  })

  it('「我自己说」:说得明白的照办,认不准的当「先不管」', () => {
    expect(agentAnswerFromText('接上吧')).toBe('yes')
    expect(agentAnswerFromText('好的')).toBe('yes')
    expect(agentAnswerFromText('它不是 Agent')).toBe('no')
    expect(agentAnswerFromText('别接')).toBe('no')
    expect(agentAnswerFromText('是不是 Agent 我也不知道')).toBe('skip')
    expect(agentAnswerFromText('这是 Kimi 的另一个窗口')).toBe('skip')
    expect(agentAnswerOf({ kind: 'answer', answers: [{ id: 'agent-connect', selected: [], custom: '接上' }] })).toBe('yes')
    expect(agentAnswerOf({ kind: 'cancelled' })).toBe('skip')
  })
})

describe('那一问跟着登记表走', () => {
  it('★他在别处说了「这不是 Agent」(新接上那一句、顶栏小灯上):挂着的那一问当场撤掉', async () => {
    const w = world()
    await w.discovery.tick()
    expect(w.broker.list()).toHaveLength(1)
    await w.discovery.notAgent('com.example.mosaic')
    await settle()
    expect(w.broker.list()).toEqual([])
    expect(w.state().waiting.count).toBe(0)
    // 撤掉的那一问不算他答的:还是「不是 Agent」,没被当成「先不管」。
    expect(w.discovery.data().apps['com.example.mosaic']?.ask_again_at).toBeUndefined()
  })

  it('★他在别处点了「接上」:挂着的那一问当场撤掉,接上', async () => {
    const w = world()
    await w.discovery.tick()
    const result = await w.discovery.connect('com.example.mosaic')
    await settle()
    expect(result.ok).toBe(true)
    expect(w.broker.list()).toEqual([])
    expect(w.discovery.view().entries.map(one => one.id)).toContain('com.example.mosaic')
  })

  it('★工作台重启(经纪人只在内存里):还在问的那一家再挂一次,不再问模型;停下时挂着的那一问撤掉', async () => {
    const first = world()
    await first.discovery.tick()
    await first.discovery.stop()
    expect(first.broker.list()).toEqual([])

    const again = world({ store: createMemoryRegistryStore(first.store.current()) })
    await again.discovery.tick()
    expect(again.state().waiting.count).toBe(1)
    expect(again.state().questions[0]?.questions[0]?.header).toBe('Mosaic 像是个 Agent')
    expect(again.model.prompts).toEqual([])
    expect(again.shell.touched('com.example.mosaic')).toEqual([])
  })
})

describe('8791 上:/state 与 POST /questions/answer(卡 M 那两个口)', () => {
  const started: WorkbenchServer[] = []
  afterEach(async () => { while (started.length) await started.pop()?.close() })

  it('★/state.questions 里有这一问、/state.waiting 数它;POST /questions/answer 选「接上」→ 两格都空,登记表里有了它', async () => {
    const shell = fakeShell([mosaic])
    const model = fakeModel({ Mosaic: 'unsure' }, { Mosaic: 'unsure' })
    const questions = createQuestionBroker()
    const agents = createAgentDiscovery({
      store: createMemoryRegistryStore(),
      helper: shell.helper,
      judge: model.judge,
      remainingCny: async () => 4,
      asker: createBrokerAsker(questions),
      setInterval: () => 1,
      clearInterval: () => {},
    })
    const server = await startWorkbenchServer({ port: 0, service: createWorkbenchService(), tickIntervalMs: 0, heartbeatMs: 0, questions, agents })
    started.push(server)
    const state = async (): Promise<WorkbenchState> => await (await fetch(`${server.url}/state`)).json() as WorkbenchState

    await agents.tick()
    const before = await state()
    expect(before.questions).toHaveLength(1)
    expect(before.waiting?.count).toBe(1)
    expect(before.waiting?.items[0]).toMatchObject({ kind: 'question', verb: '答', text: '事务官问你:Mosaic 像是个 Agent' })
    // 收件箱里没有另一份(同一件事不摆两处)。
    expect(before.butler_inbox?.items.filter(item => item.kind === 'agent')).toEqual([])

    const id = before.questions?.[0]?.id as string
    const res = await fetch(`${server.url}/questions/answer`, {
      method: 'POST',
      // 带 `origin` = 「他在电脑球下那张提问卡上点的」。「等你确认」只认她本人(2026-09-28,卡 BS):
      // 不带身份的程序调用会被 403 挡掉(那道门的用例在 tests/server-herself-gate.test.ts)。
      headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:3080' },
      body: JSON.stringify({ id, answers: [{ id: 'agent-connect', selected: ['接上'] }] }),
    })
    expect(res.status).toBe(200)
    await settle()
    const after = await state()
    expect(after.questions).toEqual([])
    expect(after.waiting?.count).toBe(0)
    expect(after.agent_registry?.entries.map(one => one.id)).toContain('com.example.mosaic')
    expect(after.butler_inbox?.items.find(item => item.kind === 'agent')?.title).toBe('新接上一家:Mosaic')
  })
})
