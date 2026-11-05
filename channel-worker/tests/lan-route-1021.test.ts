/**
 * 局域网主路 M2 在工人这一侧(2026-10-21;docs/设计-局域网主路-2026-10-21.md 第二、三节)。
 *
 *   - 取票时记下自己在哪条路线的房里(8791 回的 `route`);替房里的设备转请求、续期时用
 *     `x-workbench-channel-route` 报上 —— 8791 据此签**同一间房**的票(云房间让中转签,本机房间给局域网地址);
 *   - 续期回包多带 `url` / `room` / `route`,房里的 `{type:'token'}` 原样转给设备(老 8791 不回就照旧只有两格);
 *   - 按房间领电话、报接起(先接先得)的客户端:卡 M6 两间房直接接这两条;
 *   - `GET /channel/route` **不进**房间代理的白名单:经云房间转来的一问不能当「在家」。
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { CHANNEL_ROUTE_HEADER, createWorkbenchClient } from '../src/workbench.ts'
import { handleRpcRequest, isAllowedRpcPath } from '../src/rpc.ts'

interface Seen { path: string, method: string, headers: Headers, body: unknown }

function stub(reply: (path: string, body: unknown) => { status: number, body: unknown }) {
  const seen: Seen[] = []
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : undefined
    seen.push({ path: url.pathname, method: init?.method ?? 'GET', headers: new Headers(init?.headers), body })
    const result = reply(url.pathname, body)
    return new Response(JSON.stringify(result.body), { status: result.status, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
  return { impl, seen }
}

const TICKET = { url: 'ws://127.0.0.1:7880', room: 'wb-local-3f9c0a1b', identity: 'wb-channel-worker', token: 'jwt', expires_at: 1, route: 'lan' }

describe('工人记下自己在哪条路线,替设备办事时报上', () => {
  it('取票读得出 route;之后续期与代理都带 x-workbench-channel-route', async () => {
    const s = stub(path => path === '/channel/token'
      ? { status: 200, body: TICKET }
      : { status: 200, body: { ok: true } })
    const client = createWorkbenchClient({ baseUrl: 'http://127.0.0.1:8791', fetchImpl: s.impl })
    const ticket = await client.ticket()
    expect(ticket.route).toBe('lan')
    await client.renewTicket('dev-1')
    await client.callAsDevice({ deviceId: 'dev-1', method: 'GET', path: '/channel/status' })
    expect(s.seen[1]?.headers.get(CHANNEL_ROUTE_HEADER)).toBe('lan')
    expect(s.seen[2]?.headers.get(CHANNEL_ROUTE_HEADER)).toBe('lan')
  })

  it('还没取过票(或老 8791 不回 route):不带这条头 —— 8791 照今天的老规矩签', async () => {
    const s = stub(() => ({ status: 200, body: { ...TICKET, route: undefined } }))
    const client = createWorkbenchClient({ baseUrl: 'http://127.0.0.1:8791', fetchImpl: s.impl })
    await client.renewTicket('dev-1')
    await client.ticket()
    await client.renewTicket('dev-1')
    expect(s.seen[0]?.headers.get(CHANNEL_ROUTE_HEADER)).toBeNull()
    expect(s.seen[2]?.headers.get(CHANNEL_ROUTE_HEADER)).toBeNull()
  })

  it('第二条工人(卡 M6)要云房间:取票时带 route: relay', async () => {
    const s = stub(() => ({ status: 200, body: { ...TICKET, route: 'relay' } }))
    const client = createWorkbenchClient({ baseUrl: 'http://127.0.0.1:8791', fetchImpl: s.impl, workerSuffix: 'cloud', workerRoute: 'relay' })
    await client.ticket()
    expect(s.seen[0]?.body).toEqual({ worker: true, suffix: 'cloud', route: 'relay' })
  })

  it('两端是同一个头名(8791 的 channel.ts 是这条接缝的主人)', () => {
    const source = readFileSync(new URL('../../workbench-plugin/src/server/channel.ts', import.meta.url), 'utf8')
    expect(source).toContain(`export const CHANNEL_ROUTE_HEADER = '${CHANNEL_ROUTE_HEADER}'`)
  })
})

describe('续期回包多带地址', () => {
  it('8791 回了 url / room / route:工人原样带回,房里那条 token 也带上', async () => {
    const s = stub(() => ({ status: 200, body: { url: 'ws://192.168.31.8:7880', room: 'wb-local-3f9c0a1b', identity: 'wb-phone-dev-1', token: 'jwt2', expires_at: 999, route: 'lan' } }))
    const client = createWorkbenchClient({ baseUrl: 'http://127.0.0.1:8791', fetchImpl: s.impl })
    const renewed = await client.renewTicket('dev-1')
    expect(renewed).toEqual({ token: 'jwt2', expires_at: 999, url: 'ws://192.168.31.8:7880', room: 'wb-local-3f9c0a1b', route: 'lan' })
    const response = await handleRpcRequest({ id: 'r', type: 'renew' }, { deviceId: 'dev-1', workbench: { renewTicket: async () => renewed, callAsDevice: async () => ({ status: 200, body: {} }) } })
    expect(response).toEqual({ id: 'r', type: 'token', token: 'jwt2', expires_at: 999, url: 'ws://192.168.31.8:7880', room: 'wb-local-3f9c0a1b', route: 'lan' })
  })

  it('老 8791 只回两格:房里那条照旧只有 token 与 expires_at', async () => {
    const response = await handleRpcRequest({ id: 'r', type: 'renew' }, { deviceId: 'dev-1', workbench: { renewTicket: async () => ({ token: 'tok', expires_at: 123 }), callAsDevice: async () => ({ status: 200, body: {} }) } })
    expect(response).toEqual({ id: 'r', type: 'token', token: 'tok', expires_at: 123 })
  })

  it('回包里的 route 认不出就不带(不把一个乱值转给设备)', async () => {
    const s = stub(() => ({ status: 200, body: { url: 'ws://x', room: 'r', identity: 'i', token: 't', expires_at: 1, route: 'moon' } }))
    const client = createWorkbenchClient({ baseUrl: 'http://127.0.0.1:8791', fetchImpl: s.impl })
    expect(await client.renewTicket('dev-1')).toEqual({ token: 't', expires_at: 1, url: 'ws://x', room: 'r' })
  })
})

describe('按房间领电话、报接起(卡 M6 接这两条)', () => {
  it('claimRoomCalls:带上房间,读回 calls 与 answered_elsewhere', async () => {
    const s = stub(() => ({ status: 200, body: { calls: [{ id: 'call-1' }], answered_elsewhere: [{ id: 'call-0', room: 'wb-acc0123456789abc' }] } }))
    const client = createWorkbenchClient({ baseUrl: 'http://127.0.0.1:8791', fetchImpl: s.impl })
    expect(await client.claimRoomCalls('wb-local-3f9c0a1b')).toEqual({ calls: [{ id: 'call-1' }], answered_elsewhere: [{ id: 'call-0', room: 'wb-acc0123456789abc' }] })
    expect(s.seen[0]).toMatchObject({ path: '/call/claim', method: 'POST', body: { room: 'wb-local-3f9c0a1b' } })
  })

  it('claimRoomCalls 取不到(8791 不在 / 老 8791 不回那一格):空的,不抛', async () => {
    const down = createWorkbenchClient({ baseUrl: 'http://127.0.0.1:8791', fetchImpl: (async () => { throw new Error('ECONNREFUSED') }) as unknown as typeof fetch })
    expect(await down.claimRoomCalls('wb-local-x')).toEqual({ calls: [], answered_elsewhere: [] })
    const old = createWorkbenchClient({ baseUrl: 'http://127.0.0.1:8791', fetchImpl: stub(() => ({ status: 200, body: { calls: [] } })).impl })
    expect(await old.claimRoomCalls('wb-local-x')).toEqual({ calls: [], answered_elsewhere: [] })
  })

  it('callAnswered:先接先得的答案原样带回;问不到当先接(老 8791 没这条路时别把电话挂了)', async () => {
    const s = stub(() => ({ status: 200, body: { ok: true, first: false, room: 'wb-acc0123456789abc', device_id: 'phone-1' } }))
    const client = createWorkbenchClient({ baseUrl: 'http://127.0.0.1:8791', fetchImpl: s.impl })
    expect(await client.callAnswered({ id: 'call-1', room: 'wb-local-x', device_id: 'handset-1' })).toEqual({ first: false, room: 'wb-acc0123456789abc', device_id: 'phone-1' })
    expect(s.seen[0]).toMatchObject({ path: '/call/answered', body: { id: 'call-1', room: 'wb-local-x', device_id: 'handset-1' } })
    const old = createWorkbenchClient({ baseUrl: 'http://127.0.0.1:8791', fetchImpl: stub(() => ({ status: 404, body: { error: '没有这个路径' } })).impl })
    expect(await old.callAnswered({ id: 'call-1', room: 'wb-local-x' })).toEqual({ first: true, unknown: true })
  })

  it('ackCall 带房间:原样交给 8791', async () => {
    const s = stub(() => ({ status: 200, body: { ok: true } }))
    const client = createWorkbenchClient({ baseUrl: 'http://127.0.0.1:8791', fetchImpl: s.impl })
    await client.ackCall({ id: 'call-1', result: 'missed', room: 'wb-local-x' })
    expect(s.seen[0]?.body).toEqual({ id: 'call-1', result: 'missed', room: 'wb-local-x' })
  })
})

describe('房间代理的白名单', () => {
  it('GET /channel/route 不转:在家的判据只能直连答', () => {
    expect(isAllowedRpcPath('GET', '/channel/route')).toBe(false)
    // 续期与状态照旧转。
    expect(isAllowedRpcPath('POST', '/channel/token')).toBe(true)
    expect(isAllowedRpcPath('GET', '/channel/status')).toBe(true)
  })
})

/**
 * 字段表(`workbench-plugin/src/server/channelWire.cases.json`,8791 是主人):工人读得懂 8791 发的那几样,
 * 发给设备的续期回包一格不多一格不少。三端读同一份(手机 `butler-app/tests/channelWire-1021.test.ts`、
 * 听筒 `phone-bridge/channel_wire_test.py`)。
 */
describe('字段表:工人读同一份', () => {
  const wire = JSON.parse(readFileSync(new URL('../../workbench-plugin/src/server/channelWire.cases.json', import.meta.url), 'utf8')) as {
    fields: Record<string, string[]>
    examples: Record<string, Record<string, unknown>>
  }

  it('工人自己那张票:读得出地址、房间、路线', async () => {
    const client = createWorkbenchClient({ baseUrl: 'http://127.0.0.1:8791', fetchImpl: stub(() => ({ status: 200, body: wire.examples.token_worker })).impl })
    const ticket = await client.ticket()
    expect(ticket).toMatchObject({ url: wire.examples.token_worker?.url, room: wire.examples.token_worker?.room, route: 'lan' })
  })

  it('替设备续期:8791 回局域网那张 → 房里那条 token 的格子正是表里的 renew,值与样例一致', async () => {
    const client = createWorkbenchClient({ baseUrl: 'http://127.0.0.1:8791', fetchImpl: stub(() => ({ status: 200, body: wire.examples.token_lan })).impl })
    const response = await handleRpcRequest({ id: 'r1', type: 'renew' }, { deviceId: 'd1', workbench: client })
    expect(Object.keys(response).sort()).toEqual([...wire.fields.renew as string[]].sort())
    expect(response).toEqual({ ...wire.examples.renew_lan, token: wire.examples.token_lan?.token, expires_at: wire.examples.token_lan?.expires_at })
  })

  it('按房间领与报接起:读得懂表里的样例', async () => {
    const claimed = createWorkbenchClient({ baseUrl: 'http://127.0.0.1:8791', fetchImpl: stub(() => ({ status: 200, body: wire.examples.call_claim_room })).impl })
    expect(await claimed.claimRoomCalls('wb-local-3f9c0a1b')).toEqual(wire.examples.call_claim_room)
    const answered = createWorkbenchClient({ baseUrl: 'http://127.0.0.1:8791', fetchImpl: stub(() => ({ status: 200, body: wire.examples.call_answered })).impl })
    expect(await answered.callAnswered({ id: 'call-1', room: 'wb-local-3f9c0a1b' })).toEqual({ first: false, room: wire.examples.call_answered?.room, device_id: wire.examples.call_answered?.device_id })
  })
})
