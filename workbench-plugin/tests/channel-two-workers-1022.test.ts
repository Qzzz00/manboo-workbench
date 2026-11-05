// @vitest-environment node
/**
 * 8791 看管两条工人(2026-10-22,局域网主路 M6;docs/设计-局域网主路-2026-10-21.md 第七节 M6 一行)。
 *
 *   - 哪几条路线要工人(`workerRoutesOf` / `channel.workerRoutes()`):本机有钥匙 → 本机房间一条;
 *     中转签得出云房间、又不是本机钥匙签的那同一间 → 云房间再一条;没接中转(M7)只有本机那条;
 *     中转一时问不到 → 「照旧」,不为一次网络抖动把在房里的工人停掉;
 *   - 一条路线一个看护(`createChannelWorkerFleet`):各自重启、各自日志、各自进程号文件,
 *     进程环境里报自己是哪条路线(`WORKBENCH_CHANNEL_WORKER_ROUTE`);房间换了那条重起;路线没了那条停;
 *     他点了「停」,30 秒那一拍不再把它拉起来;
 *   - 两条工人各报一份在线设备、各报一份「在不在通话」:8791 按路线分开记,不互相盖掉;
 *   - 只发通知的那一通(夜里 / 「完成」那一类)两间房都收到,台账仍是一条。
 */
import { describe, expect, it } from 'vitest'
import {
  CHANNEL_WORKER_RELAY_RECHECK_MS,
  WORKER_ROUTE_NO_LOCAL_KEY,
  WORKER_ROUTE_NO_RELAY,
  WORKER_ROUTE_RELAY_NOT_READY,
  WORKER_ROUTE_SAME_ROOM,
  createChannelService,
  workerRoutesOf,
} from '../src/server/channel.ts'
import type { ChannelWorkerRoutes } from '../src/server/channel.ts'
import type { ChannelCredentialResult, ChannelCredentialStore } from '../src/server/channelCredentials.ts'
import { defaultChannelWorkerLogFile } from '../src/server/channelWorker.ts'
import type { ChannelWorkerService, ChannelWorkerServiceDeps, SpawnedWorker } from '../src/server/channelWorker.ts'
import { defaultChannelWorkerPidFile } from '../src/server/channelWorkerReap.ts'
import {
  CHANNEL_ROUTE_LABELS,
  CHANNEL_WORKER_ROUTE_ENV,
  channelWorkerForRoute,
  createChannelWorkerFleet,
} from '../src/server/channelWorkerFleet.ts'
import { createDeviceDirectoryService } from '../src/server/deviceDirectory.ts'
import { createCallState } from '../src/server/callState.ts'
import { createCallOutService } from '../src/server/callOut.ts'
import { logSourcesOf } from '../src/server/diagnostics/pack.ts'
import { setupPaths } from '../src/server/setup/paths.ts'
import { CALL_TOOL_DOING, CALL_TOOL_REMEMBER } from '../src/server/rtcCall.ts'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach } from 'vitest'

const LOCAL = { url: 'ws://127.0.0.1:7880', room: 'wb-local-3f9c0a1b' }
const CLOUD = { url: 'wss://lk.example.cn', room: 'wb-acc0123456789abc' }
const RELAY_OK: ChannelCredentialResult = { ok: true, credentials: { livekit: { configured: true, ...CLOUD } } }

describe('哪几条路线要工人', () => {
  it('本机有钥匙 + 中转签得出云房间:两条', () => {
    expect(workerRoutesOf({ local: LOCAL, relay: RELAY_OK })).toEqual({
      lan: { want: true, ...LOCAL },
      relay: { want: true, ...CLOUD },
    })
  })

  it('本机没钥匙(今天线上那样):只有云房间那一条', () => {
    const routes = workerRoutesOf({ relay: RELAY_OK })
    expect(routes.lan).toEqual({ want: false, note: WORKER_ROUTE_NO_LOCAL_KEY })
    expect(routes.relay).toEqual({ want: true, ...CLOUD })
  })

  it('没接中转(M7 零服务器):只有本机那一条', () => {
    const routes = workerRoutesOf({ local: LOCAL })
    expect(routes.lan).toEqual({ want: true, ...LOCAL })
    expect(routes.relay).toEqual({ want: false, note: WORKER_ROUTE_NO_RELAY })
  })

  it('接了中转、还没登录:云房间那条不要(那句人话原样带上)', () => {
    const routes = workerRoutesOf({ local: LOCAL, relay: { ok: false, reason: 'not_linked', error: '通道要登录之后才能用。' } })
    expect(routes.relay).toEqual({ want: false, note: '通道要登录之后才能用。' })
  })

  it('中转一时问不到(网络 / 服务器):云房间那条「照旧」—— 在房里的不停,没起的不起', () => {
    for (const reason of ['network', 'server'] as const) {
      expect(workerRoutesOf({ local: LOCAL, relay: { ok: false, reason, error: '连不上服务器' } }).relay).toEqual({ want: 'keep', note: '连不上服务器' })
    }
  })

  it('中转回了、却没配 LiveKit:云房间那条不要', () => {
    expect(workerRoutesOf({ local: LOCAL, relay: { ok: true, credentials: { livekit: { configured: false } } } }).relay)
      .toEqual({ want: false, note: WORKER_ROUTE_RELAY_NOT_READY })
  })

  it('本机钥匙签的就是云上那同一间(维护者从阿里云拷来的老 channel.json):一条就够 —— 两条同身份会互相踢', () => {
    const routes = workerRoutesOf({ local: { url: 'wss://lk.example.cn/', room: CLOUD.room }, relay: RELAY_OK })
    expect(routes.lan).toEqual({ want: true, url: 'wss://lk.example.cn/', room: CLOUD.room })
    expect(routes.relay).toEqual({ want: false, note: WORKER_ROUTE_SAME_ROOM })
  })
})

describe('channel.workerRoutes():没登录时不每 30 秒敲一次中转', () => {
  function service(remote: ChannelCredentialStore | undefined, clock: { now: number }) {
    return createChannelService({
      agentsFile: '/不存在/AGENTS.md',
      env: { WORKBENCH_CHANNEL_API_KEY: 'devkey', WORKBENCH_CHANNEL_API_SECRET: 'secret' },
      configFile: '/不存在/channel.json',
      nowSeconds: () => Math.floor(clock.now / 1000),
      rememberTool: CALL_TOOL_REMEMBER,
      doingTool: CALL_TOOL_DOING,
      machineId: async () => '3f9c0a1b22223333444455556666777a',
      ...(remote === undefined ? {} : { remote }),
    })
  }
  function relay(results: ChannelCredentialResult[]): ChannelCredentialStore & { asked: number } {
    const store = {
      asked: 0,
      async get() { store.asked += 1; return results[Math.min(store.asked - 1, results.length - 1)] as ChannelCredentialResult },
      async issueToken() { return { ok: false as const, reason: 'server' as const, error: '不签' } },
      view() { return { cached: false, livekit_configured: false } },
      forget() {},
    }
    return store
  }

  it('本机有钥匙:本机房间是 wb-local-<机器 id 前 8 位>;没接中转就只有它', async () => {
    const routes = await service(undefined, { now: Date.parse('2026-10-22T10:00:00Z') }).workerRoutes()
    expect(routes.lan).toEqual({ want: true, url: 'ws://127.0.0.1:7880', room: 'wb-local-3f9c0a1b' })
    expect(routes.relay).toEqual({ want: false, note: WORKER_ROUTE_NO_RELAY })
  })

  it('「还没登录」记一阵:5 分钟里不再问中转;登录那一下(force)当场再问', async () => {
    const clock = { now: Date.parse('2026-10-22T10:00:00Z') }
    const store = relay([{ ok: false, reason: 'not_linked', error: '要登录' }, RELAY_OK])
    const channel = service(store, clock)
    expect((await channel.workerRoutes()).relay.want).toBe(false)
    clock.now += 30_000
    expect((await channel.workerRoutes()).relay.want).toBe(false)
    expect(store.asked).toBe(1)
    expect((await channel.workerRoutes({ force: true })).relay).toEqual({ want: true, ...CLOUD })
    expect(store.asked).toBe(2)
  })

  it('过了那一阵自己再问一次', async () => {
    const clock = { now: Date.parse('2026-10-22T10:00:00Z') }
    const store = relay([{ ok: false, reason: 'unauthorized', error: '令牌不对' }, RELAY_OK])
    const channel = service(store, clock)
    await channel.workerRoutes()
    clock.now += CHANNEL_WORKER_RELAY_RECHECK_MS + 1000
    expect((await channel.workerRoutes()).relay).toEqual({ want: true, ...CLOUD })
    expect(store.asked).toBe(2)
  })

  it('网络问不到不记:下一拍照常问(那是一会儿就好的事)', async () => {
    const clock = { now: Date.parse('2026-10-22T10:00:00Z') }
    const store = relay([{ ok: false, reason: 'network', error: '连不上' }, RELAY_OK])
    const channel = service(store, clock)
    expect((await channel.workerRoutes()).relay.want).toBe('keep')
    clock.now += 30_000
    expect((await channel.workerRoutes()).relay).toEqual({ want: true, ...CLOUD })
  })
})

describe('每条路线各自的日志与进程号文件', () => {
  it('本机房间那条沿用老名字(局域网是主路);云房间那条带 -relay', () => {
    expect(defaultChannelWorkerLogFile('/Users/example', 'lan')).toBe('/Users/example/.dsh/workbench/logs/channel-worker.log')
    expect(defaultChannelWorkerLogFile('/Users/example', 'relay')).toBe('/Users/example/.dsh/workbench/logs/channel-worker-relay.log')
    expect(defaultChannelWorkerPidFile({ HOME: '/Users/example' }, 'lan')).toBe('/Users/example/.dsh/workbench/channel-worker.pid')
    expect(defaultChannelWorkerPidFile({ HOME: '/Users/example' }, 'relay')).toBe('/Users/example/.dsh/workbench/channel-worker-relay.pid')
  })

  it('诊断包两份工人日志都收', () => {
    const names = logSourcesOf(setupPaths({ home: '/Users/example' })).map(one => one.name)
    expect(names).toContain('channel-worker.log')
    expect(names).toContain('channel-worker-relay.log')
  })

  it('channelWorkerForRoute:进程环境里报路线,日志与进程号文件按路线分开', async () => {
    const spawned: { env: Record<string, string> }[] = []
    const pidFiles: string[] = []
    const crashes: string[] = []
    const fake: Partial<ChannelWorkerServiceDeps> = {
      scriptExists: async () => true,
      openLog: async () => undefined,
      spawnImpl: (input) => {
        spawned.push({ env: input.env })
        let onExit: ((exit: { code: number | null, signal: NodeJS.Signals | null }) => void) | undefined
        return {
          pid: 200 + spawned.length,
          kill: () => { onExit?.({ code: null, signal: 'SIGTERM' }) },
          onExit: (handler) => { onExit = handler },
          onError: () => {},
        } satisfies SpawnedWorker
      },
    }
    const base = {
      env: { WORKBENCH_CHANNEL_WORKBENCH_URL: 'http://127.0.0.1:8791' },
      home: '/Users/example',
      dshEnv: { HOME: '/Users/example' },
      reaperFor: (pidFile: string) => { pidFiles.push(pidFile); return { reap: async () => [], record: async () => {} } },
      onCrash: (event: { route: string }) => { crashes.push(event.route) },
    }
    const lan = channelWorkerForRoute('lan', base, fake)
    const relay = channelWorkerForRoute('relay', base, fake)
    await lan.start()
    await relay.start()
    expect(spawned.map(one => one.env[CHANNEL_WORKER_ROUTE_ENV])).toEqual(['lan', 'relay'])
    expect(spawned[0]?.env.WORKBENCH_CHANNEL_WORKBENCH_URL).toBe('http://127.0.0.1:8791')
    // 身份不带后缀:两间房各是一个 `wb-channel-worker`(手机与听筒只认这个名字)。
    expect(spawned.every(one => one.env.WORKBENCH_CHANNEL_WORKER_SUFFIX === undefined)).toBe(true)
    expect(lan.view().log_file).toBe('/Users/example/.dsh/workbench/logs/channel-worker.log')
    expect(relay.view().log_file).toBe('/Users/example/.dsh/workbench/logs/channel-worker-relay.log')
    expect(pidFiles).toEqual(['/Users/example/.dsh/workbench/channel-worker.pid', '/Users/example/.dsh/workbench/channel-worker-relay.pid'])
    await lan.dispose()
    await relay.dispose()
  })
})

/** 一条路线的假看护:只记起停,`running` 由它自己说了算。 */
function fakeService(route: string, journal: string[]) {
  let running = false
  let supervising = false
  let retryAt: string | undefined
  const service: ChannelWorkerService & { crashOut: () => void, coolDown: () => void } = {
    view: () => ({
      running,
      supervising,
      restarts: 0,
      script: '/假的/channel-start',
      log_file: `/假的/${route}.log`,
      ...(running ? { pid: route === 'lan' ? 11 : 22 } : {}),
      ...(retryAt === undefined ? {} : { retry_at: retryAt }),
    }),
    start: async () => {
      journal.push(`start ${route}`)
      if (running) return { ok: true, note: '本来就在跑' }
      running = true
      supervising = true
      retryAt = undefined
      return { ok: true }
    },
    stop: async () => {
      journal.push(`stop ${route}`)
      const was = running
      running = false
      supervising = false
      retryAt = undefined
      return was ? { ok: true } : { ok: true, note: '本来就没在跑' }
    },
    dispose: async () => { journal.push(`dispose ${route}`); running = false; supervising = false },
    // 崩了、看护正在退避里等着重起:不在跑,但还在看着。
    crashOut: () => { running = false },
    // 撞了上限、10 分钟冷却里。
    coolDown: () => { running = false; supervising = false; retryAt = '2026-10-22T10:10:00.000Z' },
  }
  return service
}

function fleetOf(initial: ChannelWorkerRoutes) {
  let routes = initial
  const journal: string[] = []
  const lines: string[] = []
  const made = new Map<string, ReturnType<typeof fakeService>>()
  const asked: ({ force?: boolean } | undefined)[] = []
  const fleet = createChannelWorkerFleet({
    routes: async (options) => { asked.push(options); return routes },
    make: (route) => {
      const one = fakeService(route, journal)
      made.set(route, one)
      return one
    },
    log: line => lines.push(line),
  })
  return { fleet, journal, lines, made, asked, set: (next: ChannelWorkerRoutes) => { routes = next } }
}

const BOTH: ChannelWorkerRoutes = { lan: { want: true, ...LOCAL }, relay: { want: true, ...CLOUD } }
const LAN_ONLY: ChannelWorkerRoutes = { lan: { want: true, ...LOCAL }, relay: { want: false, note: WORKER_ROUTE_NO_RELAY } }
const NONE: ChannelWorkerRoutes = { lan: { want: false, note: WORKER_ROUTE_NO_LOCAL_KEY }, relay: { want: false, note: '要登录' } }

describe('两条工人的看护', () => {
  it('两条路线都在:各起一条', async () => {
    const h = fleetOf(BOTH)
    await h.fleet.reconcile()
    expect(h.journal).toEqual(['start lan', 'start relay'])
    const view = h.fleet.view()
    expect(view.running).toBe(true)
    expect(view.routes?.map(one => [one.route, one.room, one.running])).toEqual([['lan', LOCAL.room, true], ['relay', CLOUD.room, true]])
  })

  it('没接中转:只起本机那条;云房间那条一个进程都不起', async () => {
    const h = fleetOf(LAN_ONLY)
    await h.fleet.reconcile()
    expect(h.journal).toEqual(['start lan'])
    expect(h.made.has('relay')).toBe(false)
    expect(h.fleet.view().routes?.map(one => one.route)).toEqual(['lan'])
  })

  it('已经在跑的,下一拍不再动它', async () => {
    const h = fleetOf(BOTH)
    await h.fleet.reconcile()
    await h.fleet.reconcile()
    expect(h.journal).toEqual(['start lan', 'start relay'])
  })

  it('登录之后云房间才有:下一拍补起那一条,本机那条不动', async () => {
    const h = fleetOf(LAN_ONLY)
    await h.fleet.reconcile()
    h.set(BOTH)
    await h.fleet.reconcile()
    expect(h.journal).toEqual(['start lan', 'start relay'])
  })

  it('退出登录 / 删了钥匙:那条路线停掉那一条,另一条照旧', async () => {
    const h = fleetOf(BOTH)
    await h.fleet.reconcile()
    h.set(LAN_ONLY)
    await h.fleet.reconcile()
    expect(h.journal).toEqual(['start lan', 'start relay', 'stop relay'])
    expect(h.lines.some(line => line.includes(CHANNEL_ROUTE_LABELS.relay))).toBe(true)
    // 停下的那条不再列在 routes 里(`/channel/status.workers` 只报该有的那几条);总的 running 只看本机那条。
    expect(h.fleet.view().routes?.map(one => one.route)).toEqual(['lan'])
    expect(h.fleet.view().running).toBe(true)
  })

  it('中转一时问不到(照旧):在房里的那条不停', async () => {
    const h = fleetOf(BOTH)
    await h.fleet.reconcile()
    h.set({ ...BOTH, relay: { want: 'keep', note: '连不上服务器' } })
    await h.fleet.reconcile()
    expect(h.journal).toEqual(['start lan', 'start relay'])
  })

  it('那条路线的房间换了(账号绑定后云房间改名):只重起那一条', async () => {
    const h = fleetOf(BOTH)
    await h.fleet.reconcile()
    h.set({ ...BOTH, relay: { want: true, url: CLOUD.url, room: 'wb-accffffffffffffff' } })
    await h.fleet.reconcile()
    expect(h.journal).toEqual(['start lan', 'start relay', 'stop relay', 'start relay'])
    expect(h.fleet.view().routes?.find(one => one.route === 'relay')?.room).toBe('wb-accffffffffffffff')
  })

  it('崩了、看护在退避里等着重起:这一拍不插手(重启归那条自己的看护)', async () => {
    const h = fleetOf(BOTH)
    await h.fleet.reconcile()
    h.made.get('relay')?.crashOut()
    await h.fleet.reconcile()
    expect(h.journal).toEqual(['start lan', 'start relay'])
  })

  it('撞了上限在冷却里:30 秒那一拍也不插手(不然退避等于没有)', async () => {
    const h = fleetOf(BOTH)
    await h.fleet.reconcile()
    h.made.get('relay')?.coolDown()
    await h.fleet.reconcile()
    expect(h.journal).toEqual(['start lan', 'start relay'])
    // 他自己点「起」:从头来。
    await h.fleet.start()
    expect(h.journal.slice(2)).toContain('start relay')
    expect(h.made.get('relay')?.view().running).toBe(true)
  })

  it('他点了「停」:两条都停,30 秒那一拍不再拉起;点「起」两条都回来', async () => {
    const h = fleetOf(BOTH)
    await h.fleet.reconcile()
    expect(await h.fleet.stop()).toMatchObject({ ok: true })
    await h.fleet.reconcile()
    expect(h.journal).toEqual(['start lan', 'start relay', 'stop lan', 'stop relay'])
    expect(h.fleet.view().running).toBe(false)
    expect(await h.fleet.start()).toMatchObject({ ok: true })
    expect(h.fleet.view().running).toBe(true)
    // 「起」那一下当场重问一遍路线(刚登录完就点「起」,不该等 5 分钟)。
    expect(h.asked.at(-1)).toEqual({ force: true })
  })

  it('一条路线都没有时点「起」:如实说为什么,不假装起了', async () => {
    const h = fleetOf(NONE)
    const result = await h.fleet.start()
    expect(result.ok).toBe(false)
    expect(result.error).toContain(WORKER_ROUTE_NO_LOCAL_KEY)
    expect(h.journal).toEqual([])
  })

  it('总的 running = 要的那几条都在跑;少一条就不算(出门那一路打不进来)', async () => {
    const h = fleetOf(BOTH)
    await h.fleet.reconcile()
    h.made.get('relay')?.crashOut()
    const view = h.fleet.view()
    expect(view.running).toBe(false)
    expect(view.routes?.find(one => one.route === 'lan')?.running).toBe(true)
    // 老字段照旧给得出(体检页、诊断包读它们):进程号取本机那条,日志指本机那条。
    expect(view.pid).toBe(11)
    expect(view.log_file).toBe('/假的/lan.log')
  })

  it('dispose 两条都带走,之后的拍子不再起', async () => {
    const h = fleetOf(BOTH)
    await h.fleet.reconcile()
    await h.fleet.dispose()
    await h.fleet.reconcile()
    expect(h.journal).toEqual(['start lan', 'start relay', 'dispose lan', 'dispose relay'])
  })

  it('同时来两拍(30 秒那一拍撞上换房那一下):排着队对,不起两个', async () => {
    const h = fleetOf(BOTH)
    await Promise.all([h.fleet.reconcile(), h.fleet.reconcile({ force: true })])
    expect(h.journal).toEqual(['start lan', 'start relay'])
  })
})

describe('两条工人各报一份,8791 不互相盖掉', () => {
  const phone = { identity: 'wb-phone-d1', name: '小米', kind: 'phone', online_since: '2026-10-22T10:00:00.000Z' }
  const handset = { identity: 'wb-phone-h1', name: '座机', kind: 'phone', online_since: '2026-10-22T10:00:00.000Z' }
  const mac = { identity: 'wb-channel-worker', name: 'Ben 的 Mac', kind: 'mac', online_since: '2026-10-22T10:00:00.000Z' }

  it('在线设备:本机房间的听筒 + 云房间的手机都在表上,工人自己只算一次', () => {
    let clock = 1_000_000
    const directory = createDeviceDirectoryService({ now: () => clock })
    directory.report([mac, handset], 'lan')
    clock += 1000
    directory.report([mac, phone], 'relay')
    clock += 1000
    directory.report([mac, handset], 'lan')
    expect(directory.view().devices.map(one => one.identity).sort()).toEqual(['wb-channel-worker', 'wb-phone-d1', 'wb-phone-h1'])
  })

  it('一条路线很久没报了(那条工人没了):它报的那几台不再算在线', () => {
    let clock = 1_000_000
    const directory = createDeviceDirectoryService({ now: () => clock, staleMs: 60_000 })
    directory.report([mac, phone], 'relay')
    directory.report([mac, handset], 'lan')
    clock += 50_000
    directory.report([mac, handset], 'lan')
    clock += 20_000
    expect(directory.view().devices.map(one => one.identity).sort()).toEqual(['wb-channel-worker', 'wb-phone-h1'])
    expect(directory.view().stale).toBe(false)
  })

  it('老工人不报路线:照旧一份整表', () => {
    const directory = createDeviceDirectoryService()
    directory.report([mac, phone])
    directory.report([mac])
    expect(directory.view().devices.map(one => one.identity)).toEqual(['wb-channel-worker'])
  })

  it('在不在通话:一条在通话、另一条刚起报了「不在」,不把正在打的那通盖掉', () => {
    let clock = 1_000_000
    const state = createCallState({ now: () => clock })
    state.report(true, 'lan')
    clock += 1000
    state.report(false, 'relay')
    expect(state.inCall()).toBe(true)
    state.report(false, 'lan')
    expect(state.inCall()).toBe(false)
  })

  it('在不在通话:老工人不报路线,照旧一个开关', () => {
    const state = createCallState()
    state.report(true)
    state.report(false)
    expect(state.inCall()).toBe(false)
  })
})

describe('只发通知的那一通,两间房都收到', () => {
  const dirs: string[] = []
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
  async function quietCall(at: string) {
    const dir = mkdtempSync(join(tmpdir(), 'wb-two-workers-'))
    dirs.push(dir)
    let seq = 0
    let clock = new Date(at).getTime()
    const settled: string[] = []
    const service = createCallOutService({ file: join(dir, 'call-out.json'), newId: () => `call-${++seq}`, now: () => clock, onSettled: entry => settled.push(`${entry.id}:${entry.state}`) })
    await service.load()
    const queued = await service.request({ reason: 'confirm', item_id: 't-1', title: '看合同' })
    return { service, id: queued.entry?.id ?? '', settled, later: (ms: number) => { clock += ms } }
  }

  it('夜里那一通(silent):本机房间先发了通知、收了场,云房间来领照样拿到;台账一条、收场只记一次', async () => {
    const h = await quietCall('2026-10-22T23:30:00')
    const lan = await h.service.claimRoom(LOCAL.room)
    expect(lan.calls[0]).toMatchObject({ id: h.id, silent: true })
    await h.service.ack({ id: h.id, result: 'notified', room: LOCAL.room })
    expect(h.service.view().entries[0]?.state).toBe('notified')
    const cloud = await h.service.claimRoom(CLOUD.room)
    expect(cloud.calls.map(one => one.id)).toEqual([h.id])
    await h.service.ack({ id: h.id, result: 'notified', room: CLOUD.room })
    expect(h.service.view().entries).toHaveLength(1)
    expect(h.service.view().entries[0]).toMatchObject({ state: 'notified', rooms: [LOCAL.room, CLOUD.room] })
    expect(h.settled).toEqual([`${h.id}:notified`])
    expect((await h.service.claimRoom(CLOUD.room)).calls).toEqual([])
  })

  it('响铃那一通在一间房的通话里当场说了(notified 但不是 silent):另一间房不再响', async () => {
    const h = await quietCall('2026-10-22T14:00:00')
    await h.service.claimRoom(LOCAL.room)
    await h.service.ack({ id: h.id, result: 'notified', room: LOCAL.room })
    expect((await h.service.claimRoom(CLOUD.room)).calls).toEqual([])
  })

  it('过了几分钟才进房的那一间:那条通知已经过时,不再补', async () => {
    const h = await quietCall('2026-10-22T23:30:00')
    await h.service.claimRoom(LOCAL.room)
    await h.service.ack({ id: h.id, result: 'notified', room: LOCAL.room })
    h.later(10 * 60_000)
    expect((await h.service.claimRoom(CLOUD.room)).calls).toEqual([])
  })
})
