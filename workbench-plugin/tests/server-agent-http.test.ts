// @vitest-environment node
/**
 * 8791 上的 Agent 登记表(卡 Q):
 *
 *   /state.agent_registry          界面只读这一份(顶栏、会话列表、事务官舞台、手机)
 *   GET  /agents                   登记表 + 判过的每个 App + 今天判了几次
 *   POST /agents/not-agent {id}    「这不是 Agent」
 *   POST /agents/connect {id}      「接上」
 *   POST /agents/read {id}         看过了
 *   POST /channel/call-state       工人报通话状态(巡检据此暂停)
 *
 * 壳与模型都是假的(tests/fixtures/agentWorld.ts)。
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentRegistryDetailView, WorkbenchState } from '../src/protocol.ts'
import { AGENT_NEVER_READ, AGENT_READ_SCOPE } from '../src/protocol.ts'
import { createAgentDiscovery } from '../src/server/agentDiscovery.ts'
import { createMemoryRegistryStore } from '../src/server/agentRegistry.ts'
import { createCallState } from '../src/server/callState.ts'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { chatProbe, chatRead, fakeModel, fakeShell } from './fixtures/agentWorld.ts'

const started: WorkbenchServer[] = []

afterEach(async () => {
  while (started.length) await started.pop()?.close()
})

async function post(url: string, path: string, body: unknown) {
  const res = await fetch(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { status: res.status, body: await res.json() as Record<string, unknown> }
}

async function serve(opts: { withAgents?: boolean } = {}) {
  const shell = fakeShell([{
    bundle_id: 'com.example.fooai', name: 'Foo AI', category: 'public.app-category.productivity', running: true,
    probe: chatProbe(), read: () => chatRead({ answer: '好的,这是本周周报的草稿。' }),
  }])
  const model = fakeModel({ 'Foo AI': 'ai_agent' })
  const callState = createCallState()
  const service = createWorkbenchService({})
  const agents = createAgentDiscovery({
    store: createMemoryRegistryStore(),
    helper: shell.helper,
    judge: model.judge,
    remainingCny: async () => 4,
    inCall: () => callState.inCall(),
    sessions: () => service.getState().sessions,
    setInterval: () => 1,
    clearInterval: () => {},
  })
  const server = await startWorkbenchServer({
    port: 0,
    service,
    tickIntervalMs: 0,
    heartbeatMs: 0,
    ...(opts.withAgents === false ? {} : { agents, callState }),
  })
  started.push(server)
  return { url: server.url, agents, shell, callState }
}

async function state(url: string): Promise<WorkbenchState> {
  return await (await fetch(`${url}/state`)).json() as WorkbenchState
}

describe('/state.agent_registry', () => {
  it('★运行时冒出来的一家,不改一行界面代码就出现在 /state 里,四样齐全;事务官自己在最前', async () => {
    const { url, agents } = await serve()
    await agents.tick()
    const registry = (await state(url)).agent_registry
    expect(registry?.entries.map(one => one.id)).toEqual(['dsh', 'com.example.fooai'])
    const foo = registry?.entries[1]
    expect(foo).toMatchObject({ name: 'Foo AI', status: 'idle', title: '周报怎么写', latest: '好的,这是本周周报的草稿。' })
    expect(foo?.gaps).toEqual({})
    expect(registry?.notices.map(one => one.text)).toEqual(['新接上一家:Foo AI'])
  })

  it('★外层那一句:「新接上一家:Foo AI」进事务官收件箱(电脑球下、手机「等你确认」同一份),带着撤回要用的 id;撤回之后那一句也收掉', async () => {
    const { url, agents } = await serve()
    await agents.tick()
    const inbox = (await state(url)).butler_inbox?.items ?? []
    const line = inbox.find(one => one.kind === 'agent')
    expect(line).toMatchObject({ kind: 'agent', title: '新接上一家:Foo AI', agent: { id: 'com.example.fooai' } })
    expect(line?.agent?.notice_id).toBeDefined()
    // 第一次接上一家时一句人话说清读了什么、没读什么,「这不是 Agent」在哪儿(统筹 09-25:从第一次装的人看)。
    expect(line?.note).toBe(`从现在起${AGENT_READ_SCOPE}${AGENT_NEVER_READ}判错了就点「这不是 Agent」;以后在顶上它那颗灯上点一下也有。`)
    await post(url, '/agents/not-agent', { id: 'com.example.fooai' })
    expect(((await state(url)).butler_inbox?.items ?? []).filter(one => one.kind === 'agent')).toEqual([])
  })

  it('没接登记表服务:字段整块缺席,/agents 404', async () => {
    const { url } = await serve({ withAgents: false })
    expect((await state(url)).agent_registry).toBeUndefined()
    expect((await fetch(`${url}/agents`)).status).toBe(404)
  })
})

describe('/agents', () => {
  it('GET 给判过的每个 App 与今天的花费', async () => {
    const { url, agents } = await serve()
    await agents.tick()
    const detail = await (await fetch(`${url}/agents`)).json() as AgentRegistryDetailView
    expect(detail.apps).toMatchObject([{ bundle_id: 'com.example.fooai', state: 'connected', verdict: { kind: 'ai_agent', by: 'model' }, structure: { pass: true } }])
    expect(detail.budget.calls).toBe(1)
    expect(detail.in_call).toBe(false)
  })

  it('★「这不是 Agent」→ 从 /state 里撤掉;「接上」→ 回来', async () => {
    const { url, agents } = await serve()
    await agents.tick()
    const off = await post(url, '/agents/not-agent', { id: 'com.example.fooai' })
    expect(off).toEqual({ status: 200, body: { ok: true, note: '好,Foo AI 不算 Agent 了,以后不读它' } })
    expect((await state(url)).agent_registry?.entries.map(one => one.id)).toEqual(['dsh'])
    const on = await post(url, '/agents/connect', { id: 'com.example.fooai' })
    expect(on.status).toBe(200)
    expect((await state(url)).agent_registry?.entries.map(one => one.id)).toEqual(['dsh', 'com.example.fooai'])
  })

  it('只认登记表自己那几条:/agents 底下别的路径不拦(卡 O 的 /agents/quota、/agents/caps 在别处接)', async () => {
    const { url } = await serve()
    const other = await fetch(`${url}/agents/quota`)
    const body = await other.json() as { error?: string }
    expect(body.error ?? '').not.toContain('登记表')
    expect((await fetch(`${url}/agents/not-agent`)).status).not.toBe(200)
  })

  it('带错了参数说清楚', async () => {
    const { url } = await serve()
    expect((await post(url, '/agents/not-agent', {})).status).toBe(400)
    expect((await post(url, '/agents/not-agent', { id: 'dsh' })).status).toBe(409)
    expect((await post(url, '/agents/connect', { id: 'com.nobody.here' })).status).toBe(409)
    expect((await post(url, '/agents/read', { id: 'com.example.fooai' })).body).toEqual({ ok: true, changed: false })
  })
})

describe('/channel/call-state', () => {
  it('★工人报「在通话」→ 巡检停着(一个窗口都不碰);报「挂了」→ 接着来', async () => {
    const { url, agents, shell } = await serve()
    expect(await post(url, '/channel/call-state', { in_call: true })).toMatchObject({ status: 200, body: { ok: true, in_call: true } })
    await agents.tick()
    expect(shell.calls).toEqual([])
    expect((await state(url)).agent_registry?.paused).toBe('通话中,先停着')
    await post(url, '/channel/call-state', { in_call: false })
    await agents.tick()
    expect(shell.calls.length).toBeGreaterThan(0)
    expect((await post(url, '/channel/call-state', { in_call: 'yes' })).status).toBe(400)
  })
})
