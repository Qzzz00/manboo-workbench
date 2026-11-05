import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { AgentEntryView, TaskView, WorkbenchState } from '../src/protocol.ts'
import { CollabZone } from '../src/client/collab/CollabZone.tsx'

afterEach(cleanup)
beforeAll(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as never
})

const AT = '2026-10-21T08:00:00.000Z'
const NOW = Date.parse('2026-10-21T04:24:00.000Z')
const note = (id: string, patch: Partial<TaskView> = {}): TaskView => ({ id, title: id, status: 'todo', source: { kind: 'manual' }, created_at: AT, updated_at: AT, ...patch })
const registry = [{ id: 'codex', name: 'Codex', status: 'running' }] as unknown as AgentEntryView[]

function stateWith(tasks: TaskView[], extra: Partial<NonNullable<WorkbenchState['tasks']>> = {}): WorkbenchState {
  return {
    now: new Date(NOW).toISOString(),
    sessions: [],
    tasks: { tasks, sprints: [], modules: [], project_meta: [], goals: [], goal_sprints: [], agent_cards: [], session_proposals: [], squads: [], timers: [], mcp: [], ...extra },
    agent_registry: { entries: registry, asking: [], notices: [] },
  } as unknown as WorkbenchState
}

const CHANNEL = { id: 'ws:w1/ch:c1', kind: 'workspace', workspace_id: 'w1', name: '工作室', created_by: 'a1', created_at: AT, version: 2 }
const JOINED = {
  state: 'joined',
  me: { account_id: 'a1', nick: '阿本', role: 'admin' },
  workspace: { id: 'w1', name: '小作坊', created_by: 'a1', created_at: AT },
  members: [
    { account_id: 'a1', nick: '阿本', role: 'admin', joined_at: AT, devices: [{ device_id: 'd1', kind: 'desktop', last_seen_at: new Date().toISOString() }] },
    { account_id: 'a2', nick: '小李', role: 'member', joined_at: AT, devices: [] },
  ],
  channels: [CHANNEL],
}
const msg = (seq: number, text: string, patch: Record<string, unknown> = {}) => ({
  id: `m${seq}`, channel: CHANNEL.id, seq, kind: 'say', author: { person: 'a2', nick: '小李', device: 'd2' }, text, refs: [], attachments: [], request_id: `r${seq}`, at: AT, origin: { device: 'd2' }, ...patch,
})

function fakeFetch(routes: Record<string, unknown>) {
  const calls: { path: string, method: string, body?: Record<string, unknown> }[] = []
  const impl = (async (input: string, init?: RequestInit) => {
    const url = new URL(input)
    const method = init?.method ?? 'GET'
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body)) as Record<string, unknown>
    calls.push({ path: url.pathname + url.search, method, ...(body === undefined ? {} : { body }) })
    const hit = routes[`${method} ${url.pathname}`]
    const json = hit !== undefined ? hit
      : url.pathname === '/collab/canvas' ? { layout: { goals: {}, notes: {} } }
        : url.pathname.endsWith('/trace') ? { events: [] } : { ok: true }
    const status = (json as { status?: number }).status ?? 200
    return new Response(JSON.stringify(json), { status, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  return { calls, impl }
}

async function openSettings(state: WorkbenchState, tab: string, routes: Record<string, unknown>) {
  const user = userEvent.setup()
  const fetch = fakeFetch(routes)
  render(<div style={{ position: 'relative' }}><CollabZone state={state} baseUrl="http://127.0.0.1:8791" fetchImpl={fetch.impl} presence={[]} visible nowMs={NOW} timelineWidth={1228} /></div>)
  await user.click(screen.getByRole('button', { name: '设置' }))
  await user.click(within(screen.getByRole('navigation', { name: '设置' })).getByRole('button', { name: tab }))
  return { user, fetch }
}
const posts = (calls: ReturnType<typeof fakeFetch>['calls'], path: string) => calls.filter(one => one.method === 'POST' && one.path === path)

describe('工作室四种样子', () => {
  it('没登录中转账号:两条路灰着,照实说', async () => {
    await openSettings(stateWith([note('x')]), '工作室', { 'GET /collab/relay/studio': { state: 'unwired', why: '这台还没登录中转账号' } })
    expect(await within(screen.getByRole('dialog', { name: '设置' })).findByRole('status')).toHaveTextContent('这台还没登录中转账号')
    expect(screen.getByRole('button', { name: '建一个工作室' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '用邀请码加入' })).toBeDisabled()
  })
  it('连不上:如实说,给「再试一次」', async () => {
    const { user, fetch } = await openSettings(stateWith([note('x')]), '工作室', { 'GET /collab/relay/studio': { state: 'offline' } })
    expect(await within(screen.getByRole('dialog', { name: '设置' })).findByRole('status')).toHaveTextContent('连不上中转')
    const before = fetch.calls.filter(one => one.path === '/collab/relay/studio').length
    await user.click(screen.getByRole('button', { name: '再试一次' }))
    await waitFor(() => expect(fetch.calls.filter(one => one.path === '/collab/relay/studio')).toHaveLength(before + 1))
  })
  it('服务回了认不出的东西 = 当连不上,不当「没加入」', async () => {
    await openSettings(stateWith([note('x')]), '工作室', { 'GET /collab/relay/studio': { ok: true } })
    expect(await within(screen.getByRole('dialog', { name: '设置' })).findByRole('status')).toHaveTextContent('没应答')
    expect(screen.queryByRole('form', { name: '用邀请码加入' })).toBeNull()
  })
  it('没加入:建工作室 / 输入邀请码两条路', async () => {
    const { user, fetch } = await openSettings(stateWith([note('x')]), '工作室', { 'GET /collab/relay/studio': { state: 'none' } })
    const create = await screen.findByRole('form', { name: '建一个工作室' })
    await user.type(within(create).getByLabelText('工作室名字'), '小作坊')
    await user.type(within(create).getByLabelText('你的花名'), '阿本')
    await user.click(within(create).getByRole('button', { name: '建一个工作室' }))
    await waitFor(() => expect(posts(fetch.calls, '/collab/relay/studio/create')[0]?.body).toEqual({ name: '小作坊', nick: '阿本' }))
    const join = screen.getByRole('form', { name: '用邀请码加入' })
    await user.type(within(join).getByLabelText('邀请码'), 'K7Q2M9XA')
    await user.click(within(join).getByRole('button', { name: '加入' }))
    await waitFor(() => expect(posts(fetch.calls, '/collab/relay/studio/join')[0]?.body).toEqual({ code: 'K7Q2M9XA', nick: '阿本' }))
  })
  it('建不成:服务端那一句原样给人看', async () => {
    const { user } = await openSettings(stateWith([note('x')]), '工作室', {
      'GET /collab/relay/studio': { state: 'none' },
      'POST /collab/relay/studio/create': { status: 409, error: '先在设置里登录账号' },
    })
    const create = await screen.findByRole('form', { name: '建一个工作室' })
    await user.type(within(create).getByLabelText('工作室名字'), 'a')
    await user.type(within(create).getByLabelText('你的花名'), 'b')
    await user.click(within(create).getByRole('button', { name: '建一个工作室' }))
    expect(await screen.findByText('先在设置里登录账号')).toBeInTheDocument()
  })
})

describe('已加入工作室', () => {
  const routes = {
    'GET /collab/relay/studio': JOINED,
    'GET /collab/relay/channel': { channel: CHANNEL, messages: [msg(1, '样片我看了'), msg(2, '', { retracted: { by: 'a2', at: AT } }), msg(3, '群里说的', { via: 'wecom', author: { person: 'a2', nick: '企微·lee', device: 'wecom' } })], cursor: 9 },
    'GET /collab/relay/agents': { cards: [
      { object_id: 'agent:d2:01', kind: 'agent', workspace_id: 'w1', owner_account: 'a2', owner_device: 'd2', owner_epoch: 3, version: 1, visibility: 'workspace', title: '小李的剪辑手', data: { good_at: '剪片' }, updated_at: AT, owner_online: false },
      { object_id: 'agent:d1:02', kind: 'agent', workspace_id: 'w1', owner_account: 'a1', owner_device: 'd1', owner_epoch: 1, version: 1, visibility: 'workspace', title: '我自己的', updated_at: AT, owner_online: true },
    ] },
    'POST /collab/relay/studio/invite': { ok: true, invite: { code: 'K7Q2M9XA', expires_at: '2026-10-28T08:00:00.000Z' } },
  }
  it('成员、在不在线、管理员能改角色 / 请离开 / 发邀请码', async () => {
    const { user, fetch } = await openSettings(stateWith([note('x')]), '工作室', routes)
    expect(await screen.findByRole('heading', { name: '工作室 · 小作坊' })).toBeInTheDocument()
    const members = screen.getByRole('list', { name: '成员' })
    expect(within(members).getByText('阿本').closest('li')).toHaveTextContent('在线')
    expect(within(members).getByText('小李').closest('li')).toHaveTextContent('不在线')
    await user.click(screen.getByRole('button', { name: '设为管理员' }))
    await waitFor(() => expect(posts(fetch.calls, '/collab/relay/studio/role')[0]?.body).toEqual({ account_id: 'a2', role: 'admin' }))
    await user.click(screen.getByRole('button', { name: '请离开' }))
    await waitFor(() => expect(posts(fetch.calls, '/collab/relay/studio/remove')[0]?.body).toEqual({ account_id: 'a2' }))
    await user.click(screen.getByRole('button', { name: '发一个邀请码' }))
    expect(await screen.findByText('K7Q2M9XA')).toBeInTheDocument()
  })
  it('频道:撤回的折成「已撤回」,企微来的标出来;说一句 → /collab/relay/channel/say', async () => {
    const { user, fetch } = await openSettings(stateWith([note('x')]), '工作室', routes)
    const list = await screen.findByRole('list', { name: '频道消息' })
    expect(within(list).getByText('样片我看了')).toBeInTheDocument()
    expect(within(list).getByText('(已撤回)')).toBeInTheDocument()
    expect(within(list).getByText('· 企微')).toBeInTheDocument()
    expect(fetch.calls.some(one => one.path === `/collab/relay/channel?id=${encodeURIComponent(CHANNEL.id)}`)).toBe(true)
    await user.type(screen.getByLabelText('说点什么'), '收到')
    await user.click(screen.getByRole('button', { name: '发' }))
    await waitFor(() => expect(posts(fetch.calls, '/collab/relay/channel/say')[0]?.body).toEqual({ channel_id: CHANNEL.id, text: '收到' }))
  })
  it('别人共享的 Agent:不列自己的;主人不在线照说;选便签请它做 → /collab/relay/borrow', async () => {
    const { user, fetch } = await openSettings(stateWith([note('剪 30 秒样片'), note('已做完', { status: 'done' })]), '工作室', routes)
    const region = await screen.findByRole('region', { name: '工作室里的 Agent' })
    await within(region).findByText('小李的剪辑手')
    expect(within(region).queryByText('我自己的')).toBeNull()
    expect(within(region).getByText('主人不在线,请求会排队')).toBeInTheDocument()
    const pick = within(region).getByLabelText('交给 小李的剪辑手 的便签')
    expect(within(pick).queryByText('已做完')).toBeNull()
    expect(within(region).getByRole('button', { name: '请它做' })).toBeDisabled()
    await user.selectOptions(pick, '剪 30 秒样片')
    await user.click(within(region).getByRole('button', { name: '请它做' }))
    await waitFor(() => expect(posts(fetch.calls, '/collab/relay/borrow')[0]?.body).toEqual({ object_id: 'agent:d2:01', owner_account: 'a2', owner_epoch: 3, note_id: '剪 30 秒样片' }))
    expect(await screen.findByText(/批了才开工/)).toBeInTheDocument()
  })
  it('Agent 名片:加入后能「登记到工作室」,也能指定成员', async () => {
    const card = { id: 'c1', name: '剪辑手', hand: 'codex', shared: { to: 'workspace' }, created_at: AT, updated_at: AT }
    const { user, fetch } = await openSettings(stateWith([note('x')], { agent_cards: [card] as never }), 'Agent 名片', routes)
    await user.click(await screen.findByRole('button', { name: '登记到工作室' }))
    await waitFor(() => expect(posts(fetch.calls, '/collab/relay/agents/share')[0]?.body).toEqual({ card_id: 'c1' }))
    const form = screen.getByRole('form', { name: '登记一张 Agent 名片' })
    await user.click(within(form).getByLabelText('指定成员'))
    await user.click(within(form).getByLabelText('小李'))
    await user.type(within(form).getByLabelText('名字'), '新手')
    await user.selectOptions(within(form).getByLabelText('哪一家'), 'codex')
    await user.click(within(form).getByRole('button', { name: '存名片' }))
    await waitFor(() => expect((posts(fetch.calls, '/collab/agent/save')[0]?.body?.shared as Record<string, unknown>)).toMatchObject({ to: 'members', members: ['a2'] }))
  })
})

describe('主人这边:别人请你的 Agent 做事', () => {
  it('等你里有一条,批 / 不批 → /collab/relay/asks/answer;数为 0 不去读', async () => {
    const user = userEvent.setup()
    const fetch = fakeFetch({ 'GET /collab/relay/asks': { asks: [{ request_id: 'rq1', from_account: 'a2', from_nick: '小李', card_id: 'c1', card_name: '剪辑手', title: '剪 30 秒样片', acceptance: ['30 秒内'], at: AT }] } })
    const { rerender } = render(<CollabZone state={stateWith([note('x')])} baseUrl="http://127.0.0.1:8791" fetchImpl={fetch.impl} presence={[]} visible nowMs={NOW} timelineWidth={1228} />)
    expect(fetch.calls.some(one => one.path === '/collab/relay/asks')).toBe(false)
    rerender(<CollabZone state={stateWith([note('x')], { relay_asks: 1 })} baseUrl="http://127.0.0.1:8791" fetchImpl={fetch.impl} presence={[]} visible nowMs={NOW} timelineWidth={1228} />)
    const strip = screen.getByRole('region', { name: '现在等你' })
    expect(await within(strip).findByText(/小李 请「剪辑手」做「剪 30 秒样片」/)).toBeInTheDocument()
    expect(within(strip).getByText('等你 1')).toBeInTheDocument()
    await user.click(within(strip).getByRole('button', { name: '批 剪 30 秒样片' }))
    await waitFor(() => expect(posts(fetch.calls, '/collab/relay/asks/answer')[0]?.body).toEqual({ request_id: 'rq1', approve: true }))
  })
})

describe('定时派活的地址与企业微信', () => {
  const timer = (url?: string) => ({ id: 't1', name: '每周报', trigger: { kind: 'webhook', ...(url === undefined ? {} : { url }) }, assignee: 'codex', template: { title: '周报', acceptance: ['发出去'] }, enabled: true, runs: [], created_at: AT, updated_at: AT })
  it('webhook 没地址 → 要一个;有地址 → 换', async () => {
    const { user, fetch } = await openSettings(stateWith([note('x')], { timers: [timer()] as never }), '定时派活', { 'POST /collab/relay/webhook': { ok: true, url: 'https://relay.example/v1/hooks/abcsecret' } })
    expect(screen.getByText('webhook · 还没有地址')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '要一个地址' }))
    await waitFor(() => expect(posts(fetch.calls, '/collab/relay/webhook')[0]?.body).toEqual({ timer_id: 't1' }))
    expect(await screen.findByLabelText('回调地址(只显示这一次)')).toHaveTextContent('https://relay.example/v1/hooks/abcsecret')
    cleanup()
    const again = await openSettings(stateWith([note('x')], { timers: [timer('https://relay.example/v1/hooks/abc…')] as never }), '定时派活', {})
    await again.user.click(screen.getByRole('button', { name: '换地址' }))
    await waitFor(() => expect(posts(again.fetch.calls, '/collab/relay/webhook/rotate')[0]?.body).toEqual({ timer_id: 't1' }))
  })
  it('企业微信:没加入就说先加入;加入后列绑定、要绑定码、解绑', async () => {
    await openSettings(stateWith([note('x')]), '企业微信机器人', { 'GET /collab/relay/studio': { state: 'none' } })
    expect(await within(screen.getByRole('dialog', { name: '设置' })).findByRole('status')).toHaveTextContent('先在「工作室」里建一个或加入')
    cleanup()
    const { user, fetch } = await openSettings(stateWith([note('x')]), '企业微信机器人', {
      'GET /collab/relay/studio': JOINED,
      'GET /collab/relay/wecom': { bindings: [{ chatid: 'wrOg1', workspace_id: 'w1', channel_id: CHANNEL.id, bound_by: 'a1', created_at: AT }] },
      'POST /collab/relay/wecom/code': { ok: true, code: '482913', expires_at: '2026-10-21T09:00:00.000Z' },
    })
    expect(await screen.findByText('群 wrOg1')).toBeInTheDocument()
    expect(screen.getByText('→ 工作室')).toBeInTheDocument()
    await user.selectOptions(screen.getByLabelText('绑到哪个频道'), '工作室')
    await user.click(screen.getByRole('button', { name: '要一个绑定码' }))
    expect(await screen.findByText('482913')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '解绑' }))
    await waitFor(() => expect(posts(fetch.calls, '/collab/relay/wecom/remove')[0]?.body).toEqual({ chatid: 'wrOg1' }))
  })
})
