// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { InboxEvent, InboxRequest } from '../src/protocol.ts'
import { COLLAB_NO_RELAY, createCollabRelay } from '../src/server/collabRelay.ts'
import { NO_RELAY_NOTE } from '../src/server/modelConfig.ts'
import { createTasksService } from '../src/server/tasks.ts'
import { readRelayInboxState } from '../src/server/relayInbox.ts'

const NOW_SEC = Math.floor(Date.parse('2026-10-21T09:00:00Z') / 1000)
const RELAY = 'https://relay.test'
const DEVICE = 'dev-secret-token'
const SESSION = 'session-secret-token'
const dirs: string[] = []
afterEach(() => { while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true }) })

const WS = { id: 'ws1', name: '小作坊', created_by: 'acc-me', created_at: '2026-10-20T00:00:00Z' }
const CHANNEL = { id: 'ws:ws1/ch:main', kind: 'workspace', workspace_id: 'ws1', name: '工作室', created_by: 'acc-me', created_at: '2026-10-20T00:00:00Z', version: 1 }
const ME = {
  workspace: WS,
  me: { account_id: 'acc-me', nick: '本', role: 'admin' },
  members: [
    { account_id: 'acc-me', nick: '本', role: 'admin', joined_at: '2026-10-20T00:00:00Z', devices: [] },
    { account_id: 'acc-li', nick: '小李', role: 'member', joined_at: '2026-10-20T00:00:00Z', devices: [] },
  ],
  channels: [CHANNEL],
}

interface Seen { method: string, path: string, auth: string, body?: Record<string, unknown> }

/** 假中转:按路径回;`events` / `requests` 排着,拉一次给完。 */
function fakeRelay(opts: { me?: unknown, offline?: boolean, eventsGone?: boolean } = {}) {
  const seen: Seen[] = []
  const events: InboxEvent[] = []
  const requests: InboxRequest[] = []
  let eventsGone = opts.eventsGone ?? false
  let hookTarget: unknown = {}
  const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status })
  const impl = (async (input: string, init?: RequestInit) => {
    if (opts.offline === true) throw new Error('ECONNREFUSED relay.test')
    const url = new URL(String(input))
    const method = init?.method ?? 'GET'
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body)) as Record<string, unknown>
    seen.push({ method, path: url.pathname + url.search, auth: String((init?.headers as Record<string, string>)?.authorization ?? ''), ...(body === undefined ? {} : { body }) })
    const p = url.pathname
    if (p === '/v1/workspace/me') return json(opts.me ?? ME)
    if (p === '/v1/workspace' && method === 'POST') return json({ workspace: WS, member: ME.me, channel: CHANNEL })
    if (p === '/v1/workspace/invite') return json({ code: 'INV12345', workspace_id: 'ws1', expires_at: '2026-10-22T00:00:00Z' })
    if (p === '/v1/workspace/join') return json({ workspace: WS, member: ME.me })
    if (p.startsWith('/v1/channels/') && p.endsWith('/messages') && method === 'GET') return json({ channel: CHANNEL, messages: [], cursor: 42 })
    if (p.startsWith('/v1/channels/') && p.endsWith('/messages')) return json({ message: { id: 'm1', text: body?.text }, duplicate: false })
    if (p === '/v1/objects' && method === 'GET') return json({ objects: [{ object_id: 'agent:li:1', kind: 'agent', title: '小李的 Codex', owner_account: 'acc-li', owner_online: true }] })
    if (p === '/v1/objects' && method === 'POST') return json({ object: { ...body, owner_account: 'acc-me' } })
    if (p === '/v1/inbox/requests' && method === 'POST') {
      if (body?.to_account === 'acc-old') return json({ error: { message: '主人换了', code: 'wrong_owner', owner_account: 'acc-li', owner_epoch: 2 } }, 409)
      return json({ request: { request_id: body?.request_id, state: 'queued' }, duplicate: false })
    }
    if (p === '/v1/inbox/requests' && method === 'GET') {
      const page = requests.splice(0)
      return json({ requests: page, next_cursor: page.at(-1)?.cursor ?? Number(url.searchParams.get('since')), more: false, head: 0 })
    }
    if (p === '/v1/inbox/requests/result') return json({ request: { request_id: body?.request_id, state: body?.state }, duplicate: false })
    if (p === '/v1/inbox/events') {
      if (eventsGone) { eventsGone = false; return json({ error: { message: '离开太久', code: 'cursor_expired' } }, 410) }
      const page = events.splice(0)
      return json({ events: page, next_cursor: page.at(-1)?.cursor ?? Number(url.searchParams.get('since')), more: false, head: 0 })
    }
    if (p === '/v1/webhooks' && method === 'POST') hookTarget = body?.target
    if (p === '/v1/webhooks' && method === 'POST') return json({ webhook: { id: 'wh_1', label: body?.label, target: body?.target, prefix: 'wh_1', created_at: '' }, url: `${RELAY}/v1/hooks/wh_1secret` })
    if (p === '/v1/webhooks' && method === 'GET') return json({ webhooks: [{ id: 'wh_1', label: 'x', target: hookTarget, prefix: 'wh_1', created_at: '' }] })
    if (p === '/v1/webhooks/wh_1/rotate') return json({ webhook: { id: 'wh_1' }, url: `${RELAY}/v1/hooks/wh_1rotated` })
    if (p === '/v1/wecom/bindings' && method === 'POST') return json({ code: 'BIND1234', expires_at: '2026-10-21T09:30:00Z', say: '绑定 BIND1234' })
    if (p === '/v1/wecom/bindings' && method === 'GET') return json({ bindings: [{ chatid: 'c1', workspace_id: 'ws1', channel_id: CHANNEL.id, bound_by: 'acc-me', created_at: '' }], configured: true })
    if (p === '/v1/wecom/bindings/remove') return json({ removed: true })
    return json({ error: { message: `假中转不认识 ${method} ${p}` } }, 404)
  }) as typeof fetch
  return { impl, seen, events, requests }
}

function request(patch: Partial<InboxRequest>): InboxRequest {
  return { cursor: 1, request_id: 'r1', to_account: 'acc-me', from_account: 'acc-li', from_device: 'd-li', op: 'task.create', args: {}, at: '2026-10-21T09:00:00Z', state: 'delivered', ...patch }
}

async function setup(opts: { link?: 'none' | 'device' | 'both' | 'no_relay', relay?: ReturnType<typeof fakeRelay>, avatarOf?: (owner: string) => Promise<{ preset: string } | { thumb: string } | undefined> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wb-collab-relay-'))
  dirs.push(dir)
  let n = 0
  const tasks = createTasksService({ file: join(dir, 'tasks.json'), now: () => NOW_SEC, newId: () => `t-${++n}` })
  const relay = opts.relay ?? fakeRelay()
  const dispatched: string[] = []
  const timersRun: string[] = []
  let changes = 0
  const linkKind = opts.link ?? 'both'
  const service = createCollabRelay({
    link: async () => linkKind === 'none' ? undefined : linkKind === 'no_relay' ? { relayUrl: '' } : { relayUrl: RELAY, deviceToken: DEVICE, ...(linkKind === 'both' ? { sessionToken: SESSION } : {}) },
    fetchImpl: relay.impl,
    inboxFile: join(dir, 'relay-inbox.json'),
    borrowFile: join(dir, 'collab-borrows.json'),
    tasks,
    dispatch: async (noteId, family) => { dispatched.push(`${noteId}:${family}`) },
    canDispatch: () => true,
    runTimer: async (id) => { timersRun.push(id); return { ok: true, note_id: 'tn-1' } },
    onChanged: () => { changes += 1 },
    now: () => new Date('2026-10-21T09:00:00Z'),
    ...(opts.avatarOf === undefined ? {} : { avatarOf: opts.avatarOf }),
  })
  return { dir, tasks, relay, service, dispatched, timersRun, changes: () => changes }
}

describe('工作室状态', () => {
  it('没登录中转 = unwired;连不上 = offline;没加入 = none;加入了带回成员与频道', async () => {
    expect((await (await setup({ link: 'none' })).service.studio()).state).toBe('unwired')
    expect(await (await setup({ relay: fakeRelay({ offline: true }) })).service.studio()).toMatchObject({ state: 'offline' })
    expect(await (await setup({ relay: fakeRelay({ me: { workspace: null } }) })).service.studio()).toEqual({ state: 'none' })
    const joined = await (await setup()).service.studio()
    expect(joined).toMatchObject({ state: 'joined', workspace: { id: 'ws1' }, me: { account_id: 'acc-me' } })
    if (joined.state !== 'joined') throw new Error('应当已加入')
    expect(joined.members).toHaveLength(2)
    expect(joined.channels[0]?.id).toBe(CHANNEL.id)
  })

  it('没接中转(零服务器档):unwired,说「这台没接中转」;建 / 加入都 409 同一句;一个包都不发', async () => {
    const { service, relay } = await setup({ link: 'no_relay' })
    expect(await service.studio()).toEqual({ state: 'unwired', why: COLLAB_NO_RELAY })
    expect(COLLAB_NO_RELAY).toContain(NO_RELAY_NOTE)
    expect(await service.invite()).toMatchObject({ ok: false, status: 409, error: COLLAB_NO_RELAY })
    expect(relay.seen).toEqual([])
  })

  it('令牌只在请求头里,回包与错误里没有', async () => {
    const { service, relay } = await setup()
    const out = JSON.stringify([await service.studio(), await service.invite(), await service.channel(), await service.agents()])
    expect(out).not.toContain(DEVICE)
    expect(out).not.toContain(SESSION)
    expect(relay.seen.every(one => !one.path.includes(DEVICE) && !one.path.includes(SESSION))).toBe(true)
    expect(relay.seen.find(one => one.path === '/v1/workspace/me')?.auth).toBe(`Bearer ${DEVICE}`)
    expect(relay.seen.find(one => one.path === '/v1/workspace/invite')?.auth).toBe(`Bearer ${SESSION}`)
  })

  it('建 / 邀请 / 加入要会话令牌;没有就 409 说先登录', async () => {
    const { service } = await setup({ link: 'device' })
    const out = await service.invite()
    expect(out).toMatchObject({ ok: false, status: 409 })
    if (!out.ok) expect(out.error).toContain('登录')
    const both = await setup()
    expect(await both.service.invite()).toEqual({ ok: true, value: { code: 'INV12345', expires_at: '2026-10-22T00:00:00Z' } })
    expect(await both.service.createStudio({ name: '小作坊', nick: '本' })).toMatchObject({ ok: true })
    expect(await both.service.join({ code: 'INV12345', nick: '本' })).toMatchObject({ ok: true })
  })
})

describe('频道', () => {
  it('缺 id 读工作室那条;发一句带请求号', async () => {
    const { service, relay } = await setup()
    expect(await service.channel()).toMatchObject({ ok: true, value: { channel: { id: CHANNEL.id }, cursor: 42 } })
    await service.say({ channel_id: CHANNEL.id, text: '早' })
    const sent = relay.seen.find(one => one.method === 'POST' && one.path.endsWith('/messages'))
    expect(sent?.path).toBe(`/v1/channels/${encodeURIComponent(CHANNEL.id)}/messages`)
    expect(sent?.body).toMatchObject({ text: '早' })
    expect(typeof sent?.body?.request_id).toBe('string')
  })
})

describe('Agent 名片共享', () => {
  it('本机名片 upsert 成对象;members → workspace + allowed_members', async () => {
    const { service, tasks, relay } = await setup()
    const made = await tasks.saveAgentCard({ name: '我的 Codex', hand: 'codex', goodAt: '修 bug', shared: { to: 'members', members: ['member:acc-li'], budget_per_day: 3 } })
    const id = made.id as string
    expect((await service.shareAgent(id)).ok).toBe(true)
    const up = relay.seen.find(one => one.method === 'POST' && one.path === '/v1/objects')?.body
    expect(up).toMatchObject({ object_id: id, kind: 'agent', title: '我的 Codex', visibility: 'workspace', data: { hand: 'codex', good_at: '修 bug', shared: { to: 'workspace', allowed_members: ['acc-li'], budget_per_day: 3 } } })
    const none = await tasks.saveAgentCard({ name: '私用', hand: 'claude', shared: { to: 'none' } })
    await service.shareAgent(none.id as string)
    expect(relay.seen.filter(one => one.path === '/v1/objects' && one.method === 'POST')[1]?.body).toMatchObject({ visibility: 'owner' })
    expect(await service.agents()).toMatchObject({ ok: true, value: { cards: [{ object_id: 'agent:li:1', owner_online: true }] } })
  })
})

describe('名片头像跨机', () => {
  it('登记时 data.avatar 只带内置 id 或小图;原图不进中转;没设就不带', async () => {
    const BIG = 'BIGPHOTOBYTES'
    const avatars: Record<string, { preset: string } | { thumb: string }> = {}
    const { service, tasks, relay } = await setup({ avatarOf: async owner => avatars[owner] })
    const a = await tasks.saveAgentCard({ name: '甲', hand: 'codex', shared: { to: 'workspace' } })
    const b = await tasks.saveAgentCard({ name: '乙', hand: 'claude', shared: { to: 'workspace' } })
    const c = await tasks.saveAgentCard({ name: '丙', hand: 'claude', shared: { to: 'workspace' } })
    avatars[a.id as string] = { preset: 'agent-2' }
    avatars[b.id as string] = { thumb: 'data:image/png;base64,SMALL' }
    for (const one of [a, b, c]) await service.shareAgent(one.id as string)
    const ups = relay.seen.filter(one => one.path === '/v1/objects' && one.method === 'POST').map(one => one.body as { data: Record<string, unknown> })
    expect(ups[0]?.data.avatar).toEqual({ preset: 'agent-2' })
    expect(ups[1]?.data.avatar).toEqual({ thumb: 'data:image/png;base64,SMALL' })
    expect(ups[2]?.data.avatar).toBeUndefined()
    expect(JSON.stringify(relay.seen)).not.toContain(BIG)
  })
})

describe('用别人的 Agent(请求方)', () => {
  it('发请求、留言;批了挪到在做,没批回待领', async () => {
    const { service, tasks, relay } = await setup()
    await tasks.create({ title: '修歌词错位', acceptance: ['歌词对上'], from: { kind: 'user' }, assignee: 'me' })
    const sent = await service.borrow({ object_id: 'agent:li:1', owner_account: 'acc-li', note_id: 't-1' })
    expect(sent.ok).toBe(true)
    const req = relay.seen.find(one => one.method === 'POST' && one.path === '/v1/inbox/requests')?.body
    expect(req).toMatchObject({ to_account: 'acc-li', op: 'agent.dispatch', object_id: 'agent:li:1', args: { title: '修歌词错位', acceptance: ['歌词对上'] } })
    let note = (await tasks.list()).tasks[0]
    expect(note?.comments?.at(-1)?.text).toContain('请求已发到主人那里')
    relay.events.push({ cursor: 5, kind: 'request.result', origin: {}, at: '', payload: { request_id: req?.request_id as string, to_account: 'acc-li', op: 'agent.dispatch', state: 'done', result: {} } })
    await service.tick()
    note = (await tasks.list()).tasks[0]
    expect(note?.status).toBe('doing')
    expect(note?.comments?.at(-1)?.text).toContain('主人批了')

    await tasks.create({ title: '第二件', acceptance: ['a'], from: { kind: 'user' }, assignee: 'me' })
    await service.borrow({ object_id: 'agent:li:1', owner_account: 'acc-li', note_id: 't-2' })
    const second = relay.seen.filter(one => one.method === 'POST' && one.path === '/v1/inbox/requests')[1]?.body
    await tasks.move('t-2', 'doing')
    relay.events.push({ cursor: 6, kind: 'request.result', origin: {}, at: '', payload: { request_id: second?.request_id as string, to_account: 'acc-li', op: 'agent.dispatch', state: 'rejected', result: { reason: '今天额度用完' } } })
    await service.tick()
    const two = (await tasks.list()).tasks.find(one => one.id === 't-2')
    expect(two?.status).toBe('todo')
    expect(two?.comments?.at(-1)?.text).toContain('今天额度用完')
  })

  it('409 wrong_owner 把现任带回给界面', async () => {
    const { service, tasks } = await setup()
    await tasks.create({ title: 'x', acceptance: ['a'], from: { kind: 'user' }, assignee: 'me' })
    const out = await service.borrow({ object_id: 'agent:li:1', owner_account: 'acc-old', note_id: 't-1' })
    expect(out).toMatchObject({ ok: false, status: 409, code: 'wrong_owner', owner_account: 'acc-li' })
  })
})

describe('请求队列(主人方)', () => {
  it('agent.dispatch 记成待批,重启还在;批了建便签、派出去、回 done', async () => {
    const env = await setup()
    const card = await env.tasks.saveAgentCard({ name: '我的 Codex', hand: 'codex', shared: { to: 'workspace' } })
    env.relay.requests.push(request({ op: 'agent.dispatch', object_id: card.id as string, args: { title: '修歌词', acceptance: ['对上'] } }))
    await env.service.tick()
    expect(await env.service.askCount()).toBe(1)
    const asks = await env.service.asks()
    expect(asks[0]).toMatchObject({ request_id: 'r1', from_account: 'acc-li', from_nick: '小李', card_id: card.id, card_name: '我的 Codex', title: '修歌词', acceptance: ['对上'] })
    // 重启:新造一个服务读同一份文件
    const again = createCollabRelay({ link: async () => ({ relayUrl: RELAY, deviceToken: DEVICE }), fetchImpl: env.relay.impl, inboxFile: join(env.dir, 'relay-inbox.json'), borrowFile: join(env.dir, 'collab-borrows.json'), tasks: env.tasks, dispatch: async () => {}, runTimer: async () => ({ ok: true }) })
    expect(await again.askCount()).toBe(1)

    const answered = await env.service.answer('r1', true)
    expect(answered.ok).toBe(true)
    const note = (await env.tasks.list()).tasks.at(-1)
    // 2026-10-22(卡「名片补四样与Kimi命令行手」B):负责人保留名片 id,不折成家名(派出去的那一家由派活那一层按名片解析)。
    expect(note).toMatchObject({ title: '修歌词', acceptance: ['对上'], assignee: card.id, from: { kind: 'channel', ref: 'relay:r1' } })
    // 卡「名片编辑表单重排」:dispatch 收名片 id(用哪一家由 dispatchRun.startNow 按名片解析),hand 不再折成家名传。
    expect(env.dispatched).toEqual([`${note?.id}:${card.id as string}`])
    expect(env.relay.seen.find(one => one.path === '/v1/inbox/requests/result')?.body).toMatchObject({ request_id: 'r1', state: 'done', result: { note_id: note?.id } })
    expect(await env.service.askCount()).toBe(0)
  })

  it('拒了回 rejected;名片不在这台 → 当场 rejected', async () => {
    const env = await setup()
    const card = await env.tasks.saveAgentCard({ name: 'c', hand: 'claude', shared: { to: 'workspace' } })
    env.relay.requests.push(request({ op: 'agent.dispatch', object_id: card.id as string, args: { title: 'a' } }))
    env.relay.requests.push(request({ cursor: 2, request_id: 'r2', op: 'agent.dispatch', object_id: 'agent:gone:1', args: { title: 'b' } }))
    await env.service.tick()
    await env.service.answer('r1', false)
    const results = env.relay.seen.filter(one => one.path === '/v1/inbox/requests/result').map(one => one.body)
    expect(results).toEqual(expect.arrayContaining([expect.objectContaining({ request_id: 'r2', state: 'rejected' }), expect.objectContaining({ request_id: 'r1', state: 'rejected' })]))
    expect(env.dispatched).toEqual([])
  })

  it('task.create 建便签不编验收;timer.fire 跑定时;不认得的 op 拒', async () => {
    const env = await setup()
    env.relay.requests.push(request({ op: 'task.create', args: { title: '企微里说的', desc: '把封面换一张', origin: 'channel', source: { via: 'wecom', ref: 'm9' } } }))
    env.relay.requests.push(request({ cursor: 2, request_id: 'r2', op: 'timer.fire', from_device: 'webhook:wh_1', args: { target: { timer_id: 'tm-1' } } }))
    env.relay.requests.push(request({ cursor: 3, request_id: 'r3', op: 'task.transfer' }))
    await env.service.tick()
    const note = (await env.tasks.list()).tasks[0]
    expect(note).toMatchObject({ title: '企微里说的', from: { kind: 'channel', ref: 'relay:r1' } })
    expect(note?.acceptance ?? []).toEqual([])
    expect(env.timersRun).toEqual(['tm-1'])
    const results = env.relay.seen.filter(one => one.path === '/v1/inbox/requests/result').map(one => one.body)
    expect(results[0]).toMatchObject({ request_id: 'r1', state: 'done', result: { note_id: note?.id } })
    expect(results[1]).toMatchObject({ request_id: 'r2', state: 'done' })
    expect(results[2]).toMatchObject({ request_id: 'r3', state: 'rejected' })
    // 重放同一条 task.create 不再建第二张
    env.relay.requests.push(request({ cursor: 4, op: 'task.create', args: { title: '企微里说的' } }))
    await env.service.tick()
    expect((await env.tasks.list()).tasks).toHaveLength(1)
  })
})

describe('事件', () => {
  it('频道消息到了 relay_tick +1 并推一拍;410 重取快照拨游标', async () => {
    const env = await setup({ relay: fakeRelay({ eventsGone: true }) })
    await env.service.tick()
    expect((await readRelayInboxState(join(env.dir, 'relay-inbox.json'))).last_cursor).toBe(42)
    const before = env.service.tickCount()
    env.relay.events.push({ cursor: 43, kind: 'channel.message', origin: {}, at: '', payload: { id: 'm1' } })
    await env.service.tick()
    expect(env.service.tickCount()).toBe(before + 1)
    expect(env.changes()).toBeGreaterThan(0)
  })
})

describe('定时派活回调地址与企微', () => {
  it('开地址:整串只回一次,定时里只存遮住的样子;轮换换地址', async () => {
    const env = await setup()
    const timer = await env.tasks.saveTimer({ name: '周报', trigger: { kind: 'webhook' }, assignee: 'codex', template: { title: '写周报', acceptance: ['发出去'] } })
    const made = await env.service.webhook(timer.id as string, false)
    expect(made.ok).toBe(true)
    let saved = (await env.tasks.list()).timers?.[0]
    // 整串地址只在发的那一下回给页面;存进定时(也就进了 /state)的只是遮住尾巴的样子。
    expect(made.ok && made.value.url).toBe(`${RELAY}/v1/hooks/wh_1secret`)
    expect(saved?.trigger).toEqual({ kind: 'webhook', url: `${RELAY}/v1/hooks/wh_1…` })
    expect(JSON.stringify(await env.tasks.list())).not.toContain('wh_1secret')
    expect(env.relay.seen.find(one => one.path === '/v1/webhooks' && one.method === 'POST')?.body).toMatchObject({ target: { timer_id: timer.id } })
    await env.service.webhook(timer.id as string, true)
    saved = (await env.tasks.list()).timers?.[0]
    expect(saved?.trigger).toEqual({ kind: 'webhook', url: `${RELAY}/v1/hooks/wh_1…` })
  })

  it('企微绑定码平铺、绑定列表、解绑', async () => {
    const { service } = await setup()
    expect(await service.wecomCode(CHANNEL.id)).toEqual({ ok: true, value: { code: 'BIND1234', expires_at: '2026-10-21T09:30:00Z' } })
    expect(await service.wecomBindings()).toMatchObject({ ok: true, value: { bindings: [{ chatid: 'c1' }] } })
    expect(await service.wecomRemove('c1')).toMatchObject({ ok: true })
  })
})

describe('落盘', () => {
  it('借用文件不带令牌', async () => {
    const env = await setup()
    await env.tasks.create({ title: 'x', acceptance: ['a'], from: { kind: 'user' }, assignee: 'me' })
    await env.service.borrow({ object_id: 'agent:li:1', owner_account: 'acc-li', note_id: 't-1' })
    const raw = readFileSync(join(env.dir, 'collab-borrows.json'), 'utf8')
    expect(raw).not.toContain(DEVICE)
    expect(raw).toContain('t-1')
  })
})
