/**
 * A2(2026-10-28):电话工人的工具表 = 理解中枢的命令表。
 *
 * 每件工具只做一件事:把一条命令发给 8791 的执行口(`POST /butler/hub/execute`),拿回结果念给她;
 * 工人侧不判断派给谁、能不能办、要不要先问 —— 要问由 8791 回 `ask`(带 ask_id),她答了走 `wb_confirm`。
 */
import { describe, expect, it } from 'vitest'
import { HUB_TOOL_OF, HUB_TOOL_COMMANDS, TOOL_HUB_CONFIRM, createHubTools, hubToolText, type HubExecuteReply } from '../src/hubTools.ts'
import { createWorkbenchClient } from '../src/workbench.ts'

type Sent = { path: string, body: Record<string, unknown> }

function fakeWorkbench(reply: (body: Record<string, unknown>) => { status: number, body: unknown }) {
  const sent: Sent[] = []
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname + new URL(url).search
    const body = init?.body === undefined ? {} : JSON.parse(String(init.body)) as Record<string, unknown>
    sent.push({ path, body })
    const out = reply(body)
    return new Response(JSON.stringify(out.body), { status: out.status })
  }) as typeof fetch
  return { workbench: createWorkbenchClient({ baseUrl: 'http://127.0.0.1:8791', fetchImpl }), sent }
}

const okReply = (did: string, extra: Record<string, unknown> = {}): HubExecuteReply => ({
  say_id: 's1', say: { screen: did, spoken: did }, results: [{ command: 'note', ok: true, did, ...extra }],
})

async function run(tools: Record<string, unknown>, name: string, args: Record<string, unknown>): Promise<string> {
  const tool = tools[name] as { execute: (args: Record<string, unknown>, opts: unknown) => Promise<string> }
  return tool.execute(args, { ctx: {}, toolCallId: 'x' } as never)
}

describe('工具表与命令表一一对应', () => {
  it('16 类命令(目标四条、取消 / 挪状态各一条、核验一条)各有一件工具,外加答护栏那一问', () => {
    expect([...HUB_TOOL_COMMANDS].sort()).toEqual([
      'cancel', 'dispatch', 'feedback', 'goal_create', 'goal_due', 'goal_status', 'move_status',
      'note', 'reassign', 'remember', 'rename', 'set_goal', 'supplement', 'user_layer_fix', 'verify',
    ].sort())
    for (const name of HUB_TOOL_COMMANDS) expect(HUB_TOOL_OF[name]).toBe(`wb_${name}`)
    const { workbench } = fakeWorkbench(() => ({ status: 200, body: okReply('好') }))
    const tools = createHubTools({ workbench, lastSaid: () => 'x' })
    expect(Object.keys(tools).sort()).toEqual([...HUB_TOOL_COMMANDS.map(one => HUB_TOOL_OF[one]), TOOL_HUB_CONFIRM].sort())
  })
})

describe('每件工具 = 一条命令发给执行口', () => {
  it('10-22 电话「帮我建一个待办事项:周四下午给客户发样片」→ wb_note:entrance call、原话、一条 note 命令;念 8791 那句', async () => {
    const h = fakeWorkbench(() => ({ status: 200, body: okReply('记下了:周四下午给客户发样片(t-1)。') }))
    const tools = createHubTools({ workbench: h.workbench, lastSaid: () => '帮我建一个待办事项:周四下午给客户发样片' })
    const text = await run(tools, 'wb_note', { title: '周四下午给客户发样片', status: 'todo' })
    expect(h.sent).toEqual([{ path: '/butler/hub/execute', body: {
      entrance: 'call', said: '帮我建一个待办事项:周四下午给客户发样片',
      commands: [{ name: 'note', title: '周四下午给客户发样片', status: 'todo' }],
    } }])
    expect(text).toContain('记下了')
    expect(text).not.toContain('收不回来')
  })

  it('派活点名:to 原样交给 8791 认手,工人不挑一家', async () => {
    const h = fakeWorkbench(() => ({ status: 200, body: okReply('派给小K了') }))
    const tools = createHubTools({ workbench: h.workbench, lastSaid: () => '让小K查 8791 空转热点' })
    await run(tools, 'wb_dispatch', { title: '查 8791 空转热点', to: '小K', text: '查 8791 空转热点' })
    expect(h.sent[0]?.body.commands).toEqual([{ name: 'dispatch', new: { title: '查 8791 空转热点' }, to: '小K', text: '查 8791 空转热点' }])
  })

  it('派活指已有卡:card_id,不带 new', async () => {
    const h = fakeWorkbench(() => ({ status: 200, body: okReply('派了') }))
    const tools = createHubTools({ workbench: h.workbench, lastSaid: () => 'x' })
    await run(tools, 'wb_dispatch', { card_id: 't-a2240dc9', text: '修一下' })
    expect(h.sent[0]?.body.commands).toEqual([{ name: 'dispatch', card_id: 't-a2240dc9', text: '修一下' }])
  })

  it('改派 / 改目标 / 取消 / 补话:参数照命令表', async () => {
    const h = fakeWorkbench(() => ({ status: 200, body: okReply('好') }))
    const tools = createHubTools({ workbench: h.workbench, lastSaid: () => 'x' })
    await run(tools, 'wb_reassign', { card_id: 't-1', to: '小K' })
    await run(tools, 'wb_goal_status', { goal_id: 'g-1', status: 'reached' })
    await run(tools, 'wb_cancel', { card_id: 't-1' })
    await run(tools, 'wb_supplement', { card_id: 't-1', text: '记得补用例' })
    await run(tools, 'wb_goal_due', { goal_id: 'g-1', due: '' })
    expect(h.sent.map(one => (one.body.commands as unknown[])[0])).toEqual([
      { name: 'reassign', card_id: 't-1', to: '小K', restart: true },
      { name: 'goal_status', goal_id: 'g-1', status: 'reached' },
      { name: 'cancel', card_id: 't-1' },
      { name: 'supplement', card_id: 't-1', text: '记得补用例' },
      { name: 'goal_due', goal_id: 'g-1', due: null },
    ])
  })

  it('核验已交回的卡:card_id 照给;卡上没条件、她这句带了条件就逐条带上', async () => {
    const h = fakeWorkbench(() => ({ status: 200, body: okReply('t-d66412f5「核一遍的活」核过了,验收通过') }))
    const tools = createHubTools({ workbench: h.workbench, lastSaid: () => '把 t-d66412f5 那张按卡上条件核一遍' })
    await run(tools, 'wb_verify', { card_id: 't-d66412f5' })
    expect(h.sent[0]?.body.commands).toEqual([{ name: 'verify', card_id: 't-d66412f5' }])
    await run(tools, 'wb_verify', { card_id: 't-3109f7ab', acceptance: ['同数'] })
    expect(h.sent[1]?.body.commands).toEqual([{ name: 'verify', card_id: 't-3109f7ab', acceptance: ['同数'] }])
  })

  it('8791 回 ask:还没办,让模型照问那一句、她答了调 wb_confirm(带 ask_id)', async () => {
    const h = fakeWorkbench((body) => body.confirmed === undefined
      ? { status: 200, body: { say_id: 's', say: { screen: 'q', spoken: 'q' }, results: [{ command: 'cancel', ok: true, did: '要把 t-1「旧卡」取消吗?', card_id: 't-1', ask: { ask_id: 'ask-9', question: '要把 t-1「旧卡」取消吗?', options: ['取消它', '先留着'] } }] } }
      : { status: 200, body: okReply('取消了 t-1') })
    const tools = createHubTools({ workbench: h.workbench, lastSaid: () => '把旧卡取消掉' })
    const first = await run(tools, 'wb_cancel', { card_id: 't-1' })
    expect(first).toContain('还没办')
    expect(first).toContain('要把')
    expect(first).toContain('ask-9')
    expect(first).toContain(TOOL_HUB_CONFIRM)
    const second = await run(tools, TOOL_HUB_CONFIRM, { ask_id: 'ask-9', choice: '取消它' })
    expect(h.sent[1]).toEqual({ path: '/butler/hub/execute', body: { entrance: 'call', said: '把旧卡取消掉', confirmed: { ask_id: 'ask-9', choice: '取消它' } } })
    expect(second).toContain('取消了')
  })

  it('没办成:照 8791 的 why / next 说,不说办成了', async () => {
    const h = fakeWorkbench(() => ({ status: 200, body: { say_id: 's', say: { screen: 'x', spoken: '小G 额度用完了;换小K?' }, results: [{ command: 'reassign', ok: false, did: '没改派', why: '小G 额度用完了', next: '换小K?' }] } }))
    const tools = createHubTools({ workbench: h.workbench, lastSaid: () => 'x' })
    const text = await run(tools, 'wb_reassign', { card_id: 't-1', to: '小G' })
    expect(text).toContain('没办成')
    expect(text).toContain('额度用完了')
    expect(text).toContain('换小K')
  })

  it('8791 连不上 / 老 8791 没这个口(404):如实说没办,不假装', async () => {
    const down = createHubTools({ workbench: createWorkbenchClient({ baseUrl: 'http://127.0.0.1:8791', fetchImpl: (async () => { throw new Error('ECONNREFUSED') }) as typeof fetch }), lastSaid: () => 'x' })
    expect(await run(down, 'wb_note', { title: 'a' })).toContain('没办')
    const old = fakeWorkbench(() => ({ status: 404, body: { error: 'not found' } }))
    const tools = createHubTools({ workbench: old.workbench, lastSaid: () => 'x' })
    expect(await run(tools, 'wb_note', { title: 'a' })).toContain('这一版')
  })
})

describe('hubToolText', () => {
  it('办成:念 say.spoken;别念卡号', () => {
    const text = hubToolText({ ok: true, reply: okReply('记下了') })
    expect(text).toContain('记下了')
  })
})

describe('上下文包同源:GET /butler/hub/context', () => {
  it('工人取的是 8791 那一份(entrance=call + 她那句)', async () => {
    const h = fakeWorkbench(() => ({ status: 200, body: { context: { entrance: 'call' }, text: '【入口与时间】call' } }))
    const got = await h.workbench.hubContext!({ entrance: 'call', said: '样片那件怎么样了' })
    expect(h.sent[0]?.path).toBe(`/butler/hub/context?entrance=call&said=${encodeURIComponent('样片那件怎么样了')}`)
    expect(got).toEqual({ ok: true, text: '【入口与时间】call' })
  })
  it('取不到就缺席,不挡回合', async () => {
    const h = fakeWorkbench(() => ({ status: 404, body: {} }))
    expect(await h.workbench.hubContext!({ entrance: 'call', said: 'x' })).toEqual({ ok: false })
  })
})

describe('引导那一通要办事的回合:上下文包补进这一回合', () => {
  it('取到了 → 一行说明 + 8791 那一段;取不到 / 老工作台 → 缺席', async () => {
    const { hubContextNote, HUB_CONTEXT_TIMEOUT_MS } = await import('../src/hubTools.ts')
    const seen: unknown[] = []
    const got = await hubContextNote({ hubContext: async (input, transport) => { seen.push([input, transport]); return { ok: true, text: '【板上的卡】\n- t-1「样片」' } } }, '样片那件')
    expect(got).toContain('【板上的卡】')
    expect(got).toContain('别念')
    expect(seen).toEqual([[{ entrance: 'call', said: '样片那件' }, { timeoutMs: HUB_CONTEXT_TIMEOUT_MS }]])
    expect(await hubContextNote({ hubContext: async () => ({ ok: false }) }, 'x')).toBeUndefined()
    expect(await hubContextNote({}, 'x')).toBeUndefined()
    expect(await hubContextNote({ hubContext: async () => { throw new Error('boom') } }, 'x')).toBeUndefined()
  })
})
