// @vitest-environment node
/**
 * 局域网主路 M2 经 8791 的那几条路(2026-10-21;docs/设计-局域网主路-2026-10-21.md 第二节)。
 *
 *   POST /channel/token   按来路签:工人回环、局域网里的设备给它进来的那块网卡、工人转来的按工人报的房间;
 *   GET  /channel/status  地址与票同一条规矩,局域网报 `mode: lan`;
 *   GET  /channel/route   给设备找回这台 Mac 的那张小表(设备令牌门;别的 Mac 的令牌 401);
 *   POST /pair/claim      多回一格 `mac_id`,手机配对那一刻就记下「我配的是哪一台」。
 *
 * 同一局域网里两台 8791:各自一份 devices.json、各自一个机器 id。这里起两台服务验「令牌只对配对过的那台有效」。
 * livekit-server 是桩,中转是桩。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { IncomingMessage } from 'node:http'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { CHANNEL_ROUTES, CHANNEL_ROUTE_HEADER, createChannelService } from '../src/server/channel.ts'
import type { ChannelCredentialStore } from '../src/server/channelCredentials.ts'
import { CALL_TOOL_DOING, CALL_TOOL_REMEMBER } from '../src/server/rtcCall.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { createPairingService } from '../src/server/devices.ts'
import { lanOn } from './helpers/lanOn.ts'

const NOW_SEC = Math.floor(Date.parse('2026-10-21T09:00:00Z') / 1000)
const ENV = { WORKBENCH_CHANNEL_API_KEY: 'devkey', WORKBENCH_CHANNEL_API_SECRET: 'secret' }

const started: WorkbenchServer[] = []
const dirs: string[] = []
afterEach(async () => {
  while (started.length) await started.pop()?.close()
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

/** 来路:回环(本机 / 工人)、局域网里的手机、外网来的手机。 */
type Who = 'local' | 'lan' | 'outside'
const ADDRESSES: Record<Who, { remote: string, local: string }> = {
  local: { remote: '127.0.0.1', local: '127.0.0.1' },
  lan: { remote: '192.168.31.40', local: '192.168.31.8' },
  outside: { remote: '203.0.113.9', local: '192.168.31.8' },
}

function fakeRelay(): ChannelCredentialStore & { calls: number } {
  const store = {
    calls: 0,
    async get() {
      store.calls += 1
      return { ok: true as const, credentials: { livekit: { configured: true, url: 'wss://lk.example.cn', room: 'wb-acc0123456789abc' } } }
    },
    async issueToken(input: { identity: string }) {
      store.calls += 1
      return { ok: true as const, ticket: { url: 'wss://lk.example.cn', room: 'wb-acc0123456789abc', identity: input.identity, token: 'relay-signed', expires_at: NOW_SEC + 604800 } }
    },
    view() { return { cached: true, livekit_configured: true } },
    forget() {},
  }
  return store
}

interface Mac {
  server: WorkbenchServer
  who: (value: Who) => void
  token: string
  deviceId: string
  macId: string
  relay?: ReturnType<typeof fakeRelay>
}

async function mac(options: { macId: string, relay?: boolean, env?: Record<string, string> }): Promise<Mac> {
  const dir = mkdtempSync(join(tmpdir(), 'wb-channel-route-'))
  dirs.push(dir)
  const agentsFile = join(dir, 'AGENTS.md')
  writeFileSync(agentsFile, '我叫 周到。\n', 'utf8')
  const pairing = createPairingService({ file: join(dir, 'devices.json'), now: () => NOW_SEC })
  const relay = options.relay === true ? fakeRelay() : undefined
  const machineId = async (): Promise<string> => options.macId
  const channel = createChannelService({
    agentsFile,
    env: options.env ?? ENV,
    configFile: join(dir, '不存在.json'),
    fetchImpl: (async () => new Response(JSON.stringify({ participants: [{ identity: 'wb-channel-worker' }] }), { status: 200 })) as unknown as typeof fetch,
    nowSeconds: () => NOW_SEC,
    rememberTool: CALL_TOOL_REMEMBER,
    doingTool: CALL_TOOL_DOING,
    machineId,
    lanAddresses: () => ['192.168.31.8', '10.0.0.5'],
    ...(relay === undefined ? {} : { remote: relay }),
  })
  let actor: Who = 'local'
  const server = await startWorkbenchServer({
    port: 0,
    service: createWorkbenchService({ now: () => NOW_SEC }),
    tickIntervalMs: 0,
    heartbeatMs: 0,
    pairing,
    channel,
    machineId,
    remoteAddress: (_req: IncomingMessage) => ADDRESSES[actor].remote,
    localAddress: (_req: IncomingMessage) => ADDRESSES[actor].local,
    lan: lanOn(),
  })
  started.push(server)
  pairing.start()
  const claimed = await pairing.claim({ code: pairing.current()?.code ?? '', device_name: '小米', platform: 'android' })
  if (!claimed.ok) throw new Error('测试装置:配对没成')
  return { server, who: (value) => { actor = value }, token: claimed.token, deviceId: claimed.device_id, macId: options.macId, ...(relay === undefined ? {} : { relay }) }
}

async function call(m: Mac, method: string, path: string, options: { body?: unknown, token?: string, headers?: Record<string, string> } = {}) {
  const res = await fetch(`${m.server.url}${path}`, {
    method,
    headers: {
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(options.token === undefined ? {} : { authorization: `Bearer ${options.token}` }),
      ...options.headers,
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  })
  const text = await res.text()
  return { status: res.status, body: (text === '' ? {} : JSON.parse(text)) as Record<string, unknown> }
}

const MAC_A = 'aaaaaaaa111122223333444455556666'
const MAC_B = 'bbbbbbbb111122223333444455556666'

describe('POST /channel/token 按来路签', () => {
  it('同一台 Mac:工人那张回环,局域网里手机那张是它进来的那块网卡', async () => {
    const m = await mac({ macId: MAC_A })
    const worker = await call(m, 'POST', '/channel/token', { body: { worker: true } })
    expect(worker.body).toMatchObject({ url: 'ws://127.0.0.1:7880', room: 'wb-local-aaaaaaaa', route: 'lan' })
    m.who('lan')
    const phone = await call(m, 'POST', '/channel/token', { body: {}, token: m.token })
    expect(phone.status).toBe(200)
    expect(phone.body).toMatchObject({ url: 'ws://192.168.31.8:7880', room: 'wb-local-aaaaaaaa', identity: `wb-phone-${m.deviceId}`, route: 'lan', expires_at: NOW_SEC + 24 * 3600 })
  })

  it('在家签票不碰中转;外网来的才让中转签', async () => {
    const m = await mac({ macId: MAC_A, relay: true })
    m.who('lan')
    expect((await call(m, 'POST', '/channel/token', { body: {}, token: m.token })).body.url).toBe('ws://192.168.31.8:7880')
    expect(m.relay?.calls).toBe(0)
    m.who('outside')
    const away = await call(m, 'POST', '/channel/token', { body: {}, token: m.token })
    expect(away.body).toMatchObject({ url: 'wss://lk.example.cn', token: 'relay-signed', route: 'relay' })
  })

  it('工人替房里的手机续期:报自己在云房间就中转签,在本机房间就给这台 Mac 的局域网地址', async () => {
    const m = await mac({ macId: MAC_A, relay: true })
    const viaCloud = await call(m, 'POST', '/channel/token', { body: {}, headers: { 'x-workbench-channel-device': m.deviceId, [CHANNEL_ROUTE_HEADER]: 'relay' } })
    expect(viaCloud.body).toMatchObject({ url: 'wss://lk.example.cn', route: 'relay', identity: `wb-phone-${m.deviceId}` })
    const viaLan = await call(m, 'POST', '/channel/token', { body: {}, headers: { 'x-workbench-channel-device': m.deviceId, [CHANNEL_ROUTE_HEADER]: 'lan' } })
    expect(viaLan.body).toMatchObject({ url: 'ws://192.168.31.8:7880', route: 'lan', identity: `wb-phone-${m.deviceId}` })
    // 认不出的值当没报(老工人那条:本机有钥匙签本机)。
    const odd = await call(m, 'POST', '/channel/token', { body: {}, headers: { 'x-workbench-channel-device': m.deviceId, [CHANNEL_ROUTE_HEADER]: 'cloud-maybe' } })
    expect(odd.body.route).toBe('lan')
  })

  it('本机点名要云房间(卡 M6 的第二条工人):中转签;手机点名一律不算', async () => {
    const m = await mac({ macId: MAC_A, relay: true })
    const second = await call(m, 'POST', '/channel/token', { body: { worker: true, suffix: 'cloud', route: 'relay' } })
    expect(second.body).toMatchObject({ route: 'relay', identity: 'wb-channel-worker-cloud' })
    m.who('lan')
    const phone = await call(m, 'POST', '/channel/token', { body: { route: 'relay' }, token: m.token })
    expect(phone.body.route).toBe('lan')
  })
})

describe('GET /channel/status 与票同一条规矩', () => {
  it('局域网里的手机问:局域网地址、mode lan', async () => {
    const m = await mac({ macId: MAC_A })
    m.who('lan')
    const { status, body } = await call(m, 'GET', '/channel/status', { token: m.token })
    expect(status).toBe(200)
    expect(body).toMatchObject({ url: 'ws://192.168.31.8:7880', mode: 'lan', room: 'wb-local-aaaaaaaa', route: 'lan', worker: true })
  })

  it('本机问:回环、mode local', async () => {
    const m = await mac({ macId: MAC_A })
    expect((await call(m, 'GET', '/channel/status')).body).toMatchObject({ url: 'ws://127.0.0.1:7880', mode: 'local' })
  })
})

describe('GET /channel/route', () => {
  it('配对过的手机在局域网里问:我是谁、在哪、哪间房', async () => {
    const m = await mac({ macId: MAC_A, relay: true })
    m.who('lan')
    const { status, body } = await call(m, 'GET', '/channel/route', { token: m.token })
    expect(status).toBe(200)
    expect(body).toEqual({
      mac_id: MAC_A,
      room: 'wb-local-aaaaaaaa',
      lan_url: 'ws://192.168.31.8:7880',
      mode: 'lan',
      lan_addresses: ['192.168.31.8', '10.0.0.5'],
      relay: { configured: true },
    })
    expect(m.relay?.calls).toBe(0)
  })

  it('没带令牌:401(局域网里的别人问不到这台的房间名与地址表),但回包带 mac_id —— 设备分得清「我那台不认我了」与「这不是我那台」', async () => {
    const m = await mac({ macId: MAC_A })
    m.who('lan')
    const denied = await call(m, 'GET', '/channel/route')
    expect(denied.status).toBe(401)
    expect(denied.body.mac_id).toBe(MAC_A)
    expect(denied.body.room).toBeUndefined()
    expect(denied.body.lan_url).toBeUndefined()
    // 别的路由的 401 不带(只有找回这一条要它)。
    expect((await call(m, 'GET', '/channel/status')).body.mac_id).toBeUndefined()
  })

  it('同一局域网两台 8791:A 的设备令牌到 B 那里 401,只对配对过的那台有效', async () => {
    const a = await mac({ macId: MAC_A })
    const b = await mac({ macId: MAC_B })
    a.who('lan')
    b.who('lan')
    expect((await call(a, 'GET', '/channel/route', { token: a.token })).body.mac_id).toBe(MAC_A)
    expect((await call(b, 'GET', '/channel/route', { token: a.token })).status).toBe(401)
    expect((await call(b, 'POST', '/channel/token', { body: {}, token: a.token })).status).toBe(401)
    expect((await call(b, 'GET', '/channel/route', { token: b.token })).body.mac_id).toBe(MAC_B)
  })

  it('房间代理不转它(白名单里没有):在家的判据只能直连答', async () => {
    const m = await mac({ macId: MAC_A })
    // 工人转来的那条路 8791 照样答(权限是那台设备的),不转是工人那边白名单的事 —— 见 channel-worker 的对照用例。
    const proxied = await call(m, 'GET', '/channel/route', { headers: { 'x-workbench-channel-device': m.deviceId } })
    expect(proxied.status).toBe(200)
  })
})

describe('POST /pair/claim 回 mac_id', () => {
  it('配对那一刻就告诉手机「你配的是哪一台」', async () => {
    const m = await mac({ macId: MAC_A })
    m.who('local')
    const started = await call(m, 'POST', '/pair/start')
    const code = String((started.body as { pairing?: { code?: unknown } }).pairing?.code ?? '')
    m.who('lan')
    const claimed = await call(m, 'POST', '/pair/claim', { body: { code, device_name: '第二台', platform: 'android' } })
    expect(claimed.status).toBe(200)
    expect(claimed.body).toMatchObject({ ok: true, mac_id: MAC_A })
    expect(typeof claimed.body.token).toBe('string')
  })
})

/**
 * 字段表(`src/server/channelWire.cases.json`):三端读同一份。这里拿 8791 的**真回包**比对 ——
 * 8791 多发一格或少发一格都红,逼着先改那份表(改了表,工人 / 手机 / 听筒那边的用例跟着重跑)。
 */
describe('字段表:8791 真回包对得上 channelWire.cases.json', () => {
  const wire = JSON.parse(readFileSync(new URL('../src/server/channelWire.cases.json', import.meta.url), 'utf8')) as {
    fields: Record<string, string[]>
    modes: string[]
    routes: string[]
    examples: Record<string, Record<string, unknown>>
  }
  const keys = (value: Record<string, unknown>): string[] => Object.keys(value).sort()

  it('票:局域网手机、工人、外网(中转)三张,格子与表一样', async () => {
    const m = await mac({ macId: MAC_A, relay: true })
    const worker = await call(m, 'POST', '/channel/token', { body: { worker: true } })
    m.who('lan')
    const lan = await call(m, 'POST', '/channel/token', { body: {}, token: m.token })
    m.who('outside')
    const relay = await call(m, 'POST', '/channel/token', { body: {}, token: m.token })
    for (const body of [worker.body, lan.body, relay.body]) expect(keys(body)).toEqual([...wire.fields.token as string[]].sort())
    expect(keys(wire.examples.token_lan as Record<string, unknown>)).toEqual([...wire.fields.token as string[]].sort())
  })

  it('状态与找回:每一格都在表里;找回那张一格不少', async () => {
    const m = await mac({ macId: MAC_A, relay: true })
    m.who('lan')
    const status = await call(m, 'GET', '/channel/status', { token: m.token })
    for (const key of Object.keys(status.body)) expect(wire.fields.status).toContain(key)
    expect(wire.modes).toContain(status.body.mode)
    expect(wire.routes).toContain(status.body.route)
    const route = await call(m, 'GET', '/channel/route', { token: m.token })
    expect(keys(route.body)).toEqual([...wire.fields.route as string[]].sort())
    expect(keys(wire.examples.route_lan as Record<string, unknown>)).toEqual([...wire.fields.route as string[]].sort())
  })

  it('配对回包:每一格都在表里', async () => {
    const m = await mac({ macId: MAC_A })
    const started = await call(m, 'POST', '/pair/start')
    m.who('lan')
    const claimed = await call(m, 'POST', '/pair/claim', { body: { code: (started.body as { pairing?: { code?: string } }).pairing?.code, device_name: '第二台', platform: 'android' } })
    expect(keys(claimed.body)).toEqual([...wire.fields.pair_claim as string[]].sort())
  })

  it('取值:路线与模式只有表里那几个(与 channel.ts 的常量同一套)', () => {
    expect(wire.routes).toEqual([...CHANNEL_ROUTES])
    expect(wire.modes).toEqual(['local', 'lan', 'remote'])
    for (const name of ['token_worker', 'token_lan', 'token_relay', 'renew_lan']) expect(wire.routes).toContain(wire.examples[name]?.route)
  })
})
