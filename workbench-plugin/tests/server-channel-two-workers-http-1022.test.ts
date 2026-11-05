// @vitest-environment node
/**
 * 两条工人经 8791 的那几条路(2026-10-22,局域网主路 M6)。
 *
 *   GET  /channel/status        本机问:多一格 `workers`,本机房间、云房间各报一行「进程在不在、人在不在房」;
 *                               `process.routes` 是两条看护各自的进程状态。手机问不给 `workers`(省一趟查云房间)。
 *   POST /channel/devices       工人带上 `route`:两间房各一份,`/devices/online` 是两份合起来。
 *   POST /channel/call-state    工人带上 `route`:一条在通话,另一条报「不在」不盖掉它。
 *   POST /call/claim|answered|ack  两条工人领同一通:两间房都响,先接的出声,后到的判「已被接」;台账一条。
 *
 * livekit-server 是桩(按房间回谁在房),中转是桩,工人进程是假的。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { IncomingMessage } from 'node:http'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createChannelService } from '../src/server/channel.ts'
import type { ChannelCredentialStore } from '../src/server/channelCredentials.ts'
import type { ChannelWorkerService } from '../src/server/channelWorker.ts'
import { createChannelWorkerFleet } from '../src/server/channelWorkerFleet.ts'
import { createCallOutService } from '../src/server/callOut.ts'
import { createCallState } from '../src/server/callState.ts'
import { createDeviceDirectoryService } from '../src/server/deviceDirectory.ts'
import { CALL_TOOL_DOING, CALL_TOOL_REMEMBER } from '../src/server/rtcCall.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { createPairingService } from '../src/server/devices.ts'
import { lanOn } from './helpers/lanOn.ts'

const NOW_SEC = Math.floor(Date.parse('2026-10-22T06:00:00Z') / 1000)
const ENV = { WORKBENCH_CHANNEL_API_KEY: 'devkey', WORKBENCH_CHANNEL_API_SECRET: 'secret' }
const MAC_ID = 'aaaaaaaa111122223333444455556666'
const LAN_ROOM = 'wb-local-aaaaaaaa'
const CLOUD_ROOM = 'wb-acc0123456789abc'

const started: WorkbenchServer[] = []
const dirs: string[] = []
afterEach(async () => {
  while (started.length) await started.pop()?.close()
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

function fakeRelay(): ChannelCredentialStore {
  return {
    async get() { return { ok: true as const, credentials: { livekit: { configured: true, url: 'wss://lk.example.cn', room: CLOUD_ROOM } } } },
    async issueToken(input: { identity: string }) {
      return { ok: true as const, ticket: { url: 'wss://lk.example.cn', room: CLOUD_ROOM, identity: input.identity, token: 'relay-signed', expires_at: NOW_SEC + 604800 } }
    },
    view() { return { cached: true, livekit_configured: true } },
    forget() {},
  }
}

/** 假看护:起了就在跑。 */
function fakeWorker(route: string): ChannelWorkerService {
  let running = false
  return {
    view: () => ({ running, supervising: running, restarts: 0, script: '/假的/channel-start', log_file: `/假的/${route}.log`, ...(running ? { pid: route === 'lan' ? 11 : 22 } : {}) }),
    start: async () => { running = true; return { ok: true } },
    stop: async () => { running = false; return { ok: true } },
    dispose: async () => { running = false },
  }
}

type Who = 'local' | 'lan'

async function mac(options: { inRoom: { lan: string[], cloud: string[] }, callAt?: string }) {
  const dir = mkdtempSync(join(tmpdir(), 'wb-two-workers-http-'))
  dirs.push(dir)
  const agentsFile = join(dir, 'AGENTS.md')
  writeFileSync(agentsFile, '我叫 周到。\n', 'utf8')
  const pairing = createPairingService({ file: join(dir, 'devices.json'), now: () => NOW_SEC })
  const machineId = async (): Promise<string> => MAC_ID
  // 按探的是哪间房回谁在房(本机那台 livekit-server 与云上那台都是这一个桩)。
  const livekit = (async (_input: string | URL | Request, init?: RequestInit) => {
    const room = (JSON.parse(String(init?.body ?? '{}')) as { room?: string }).room
    const who = room === LAN_ROOM ? options.inRoom.lan : room === CLOUD_ROOM ? options.inRoom.cloud : []
    return new Response(JSON.stringify({ participants: who.map(identity => ({ identity })) }), { status: 200 })
  }) as unknown as typeof fetch
  const channel = createChannelService({
    agentsFile,
    env: ENV,
    configFile: join(dir, '不存在.json'),
    fetchImpl: livekit,
    nowSeconds: () => NOW_SEC,
    rememberTool: CALL_TOOL_REMEMBER,
    doingTool: CALL_TOOL_DOING,
    machineId,
    lanAddresses: () => ['192.168.31.8'],
    remote: fakeRelay(),
  })
  const channelWorker = createChannelWorkerFleet({ routes: options2 => channel.workerRoutes(options2), make: fakeWorker })
  await channelWorker.reconcile()
  let seq = 0
  const callOut = createCallOutService({ file: join(dir, 'call-out.json'), newId: () => `call-${++seq}`, now: () => new Date(options.callAt ?? '2026-10-22T14:00:00').getTime() })
  await callOut.load()
  const deviceDirectory = createDeviceDirectoryService()
  const callState = createCallState()
  let actor: Who = 'local'
  const addresses: Record<Who, { remote: string, local: string }> = {
    local: { remote: '127.0.0.1', local: '127.0.0.1' },
    lan: { remote: '192.168.31.40', local: '192.168.31.8' },
  }
  const server = await startWorkbenchServer({
    port: 0,
    service: createWorkbenchService({ now: () => NOW_SEC }),
    tickIntervalMs: 0,
    heartbeatMs: 0,
    pairing,
    channel,
    channelWorker,
    callOut,
    deviceDirectory,
    callState,
    machineId,
    remoteAddress: (_req: IncomingMessage) => addresses[actor].remote,
    localAddress: (_req: IncomingMessage) => addresses[actor].local,
    lan: lanOn(),
  })
  started.push(server)
  pairing.start()
  const claimed = await pairing.claim({ code: pairing.current()?.code ?? '', device_name: '小米', platform: 'android' })
  if (!claimed.ok) throw new Error('测试装置:配对没成')
  const call = async (method: string, path: string, body?: unknown, token?: string) => {
    const res = await fetch(`${server.url}${path}`, {
      method,
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(token === undefined ? {} : { authorization: `Bearer ${token}` }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const text = await res.text()
    return { status: res.status, body: (text === '' ? {} : JSON.parse(text)) as Record<string, unknown> }
  }
  return { call, callOut, who: (value: Who) => { actor = value }, token: claimed.token }
}

describe('GET /channel/status 报两条', () => {
  it('本机问:workers 两行 —— 本机房间那条在房,云房间那条进程在、人没在房', async () => {
    const m = await mac({ inRoom: { lan: ['wb-channel-worker', 'wb-phone-h1'], cloud: [] } })
    const { status, body } = await m.call('GET', '/channel/status')
    expect(status).toBe(200)
    expect(body.workers).toEqual([
      { route: 'lan', room: LAN_ROOM, running: true, in_room: true },
      { route: 'relay', room: CLOUD_ROOM, running: true, in_room: false },
    ])
    const process = body.process as { running: boolean, routes: { route: string, running: boolean }[] }
    expect(process.running).toBe(true)
    expect(process.routes.map(one => [one.route, one.running])).toEqual([['lan', true], ['relay', true]])
  })

  it('两间房都有工人', async () => {
    const m = await mac({ inRoom: { lan: ['wb-channel-worker'], cloud: ['wb-channel-worker', 'wb-phone-d1'] } })
    const workers = (await m.call('GET', '/channel/status')).body.workers as { route: string, in_room: boolean }[]
    expect(workers.map(one => [one.route, one.in_room])).toEqual([['lan', true], ['relay', true]])
  })

  it('手机问:不给 workers(那一行要多查一趟云房间);进程那一格照旧', async () => {
    const m = await mac({ inRoom: { lan: ['wb-channel-worker'], cloud: ['wb-channel-worker'] } })
    m.who('lan')
    const { body } = await m.call('GET', '/channel/status', undefined, m.token)
    expect(body.workers).toBeUndefined()
    expect(body.process).toBeDefined()
  })

  it('字段表里有这一格(三端读同一份)', async () => {
    const wire = JSON.parse(readFileSync(new URL('../src/server/channelWire.cases.json', import.meta.url), 'utf8')) as { fields: Record<string, string[]> }
    const m = await mac({ inRoom: { lan: ['wb-channel-worker'], cloud: [] } })
    const { body } = await m.call('GET', '/channel/status')
    for (const key of Object.keys(body)) expect(wire.fields.status).toContain(key)
  })
})

describe('两条工人各报各的', () => {
  it('在线设备:本机房间报听筒、云房间报手机,/devices/online 两台都在', async () => {
    const m = await mac({ inRoom: { lan: [], cloud: [] } })
    await m.call('POST', '/channel/devices', { route: 'lan', devices: [{ identity: 'wb-phone-h1', name: '座机', kind: 'phone' }] })
    await m.call('POST', '/channel/devices', { route: 'relay', devices: [{ identity: 'wb-phone-d1', name: '小米', kind: 'phone' }] })
    const online = (await m.call('GET', '/devices/online')).body.devices as { identity: string }[]
    expect(online.map(one => one.identity).sort()).toEqual(['wb-phone-d1', 'wb-phone-h1'])
  })

  it('在不在通话:本机房间那条在通话,云房间那条报「不在」不盖掉', async () => {
    const m = await mac({ inRoom: { lan: [], cloud: [] } })
    await m.call('POST', '/channel/call-state', { in_call: true, route: 'lan' })
    const after = await m.call('POST', '/channel/call-state', { in_call: false, route: 'relay' })
    expect(after.body.in_call).toBe(true)
  })
})

describe('两条工人领同一通', () => {
  it('两间房都领到;云房间先接(出门的手机)出声;本机房间后到判「已被接」、下一拍收铃;台账一条「接了」', async () => {
    const m = await mac({ inRoom: { lan: [], cloud: [] } })
    const queued = await m.callOut.request({ reason: 'confirm', item_id: 't-1', title: '看合同' })
    const id = queued.entry?.id ?? ''
    expect(((await m.call('POST', '/call/claim', { room: LAN_ROOM })).body.calls as { id: string }[]).map(one => one.id)).toEqual([id])
    expect(((await m.call('POST', '/call/claim', { room: CLOUD_ROOM })).body.calls as { id: string }[]).map(one => one.id)).toEqual([id])
    expect((await m.call('POST', '/call/answered', { id, room: CLOUD_ROOM, device_id: 'd1' })).body).toMatchObject({ first: true })
    expect((await m.call('POST', '/call/answered', { id, room: LAN_ROOM, device_id: 'h1' })).body).toMatchObject({ first: false, room: CLOUD_ROOM })
    // 先接的那条工人回「接了」(振铃机那一下),后到的那条下一拍知道在别处接了,收铃、回一句。
    await m.call('POST', '/call/ack', { id, result: 'answered', room: CLOUD_ROOM })
    expect((await m.call('POST', '/call/claim', { room: LAN_ROOM })).body.answered_elsewhere).toEqual([{ id, room: CLOUD_ROOM }])
    await m.call('POST', '/call/ack', { id, result: 'answered', room: LAN_ROOM })
    const entries = m.callOut.view().entries
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ state: 'answered', answered_room: CLOUD_ROOM, answered_device: 'd1', rooms_done: [CLOUD_ROOM, LAN_ROOM] })
    expect((await m.call('POST', '/call/claim', { room: LAN_ROOM })).body.answered_elsewhere).toEqual([])
  })
})
