/**
 * 探针④(卡 M2,2026-10-21):**真的 8791 HTTP 层**按来路签票 —— 不是直调 `createChannelService`,而是起一台
 * `startWorkbenchServer`(本分支的 http.ts),配置写 `ws://127.0.0.1:7880`,再从这台 Mac 的**局域网地址**去敲它:
 *
 *   1. 工人(回环)取票 → `ws://127.0.0.1:7880`,凭票进本机房间;
 *   2. 「手机」(配对出来的设备令牌)从局域网地址取票 → `ws://<局域网地址>:7880`(`req.socket.localAddress`),凭票进房;
 *      两位经房间收发数据往返;
 *   3. `/channel/status` 从局域网地址问 → `mode: lan`、看得见工人在房;
 *   4. `/channel/route` → 机器 id、房间、给这一位的地址、地址表;
 *   5. 工人替手机续期(回环 + 设备头 + 路线头 lan)→ 地址是这台 Mac 的局域网地址;
 *   6. 另起一台 8791(另一份 devices.json、另一个机器 id):拿第一台的设备令牌去敲 → 401;
 *   7. 别的钥匙签的票 → 本机房间 401。
 *
 * 不碰 ~/.dsh、不碰正在跑的 8791:数据目录、机器 id 都在 OUT 下;livekit 是 lk-up.sh 起的那台探针房间。
 *
 * 用法(仓库根目录,先跑 lk-up.sh):
 *   node scripts/probe-lan-primary/route-http.ts --out <lk-up 的 OUT> [--deps <channel-worker 的 node_modules>]
 * 输出:打印一份 JSON,同时写 OUT/route-http.json。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const repo = resolve(here, '..', '..')
function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : fallback
}
const OUT = arg('out') ?? join(process.env.TMPDIR ?? '/tmp', 'wb-lan-probe')
const up = JSON.parse(readFileSync(join(OUT, 'up.json'), 'utf8')) as { lan_ip: string }
const keys = Object.fromEntries(readFileSync(join(OUT, 'keys.env'), 'utf8').trim().split('\n').map(l => l.split('=') as [string, string]))
const depsDir = arg('deps') ?? [join(repo, 'channel-worker', 'node_modules'), resolve(repo, '..', '..', '..', 'channel-worker', 'node_modules')].find(d => existsSync(join(d, '@livekit', 'rtc-node'))) as string
const rtc = await import(pathToFileURL(createRequire(join(depsDir, 'x.js')).resolve('@livekit/rtc-node')).href) as typeof import('@livekit/rtc-node')

;(globalThis as Record<string, unknown>).__WORKBENCH_VERSION__ = 'probe'
const src = (path: string): string => pathToFileURL(join(repo, 'workbench-plugin', 'src', path)).href
const { startWorkbenchServer } = await import(src('server/http.ts'))
const { createChannelService, signAccessToken, joinGrant } = await import(src('server/channel.ts'))
const { createPairingService } = await import(src('server/devices.ts'))
const { createWorkbenchService } = await import(src('server/service.ts'))
const { readOrCreateMachineId } = await import(src('server/machineId.ts'))
const { lanAddresses } = await import(src('server/lan.ts'))

const LAN = up.lan_ip
const result: Record<string, unknown> = { at: new Date().toISOString(), lan_ip: LAN }

/** 起一台 8791:本分支的 http.ts,配置 `ws://127.0.0.1:7880`,局域网开关开着(只监听,不广播 mDNS)。 */
async function workbench(name: string) {
  const dir = join(OUT, `route-http-${name}`)
  mkdirSync(dir, { recursive: true })
  const machineId = async (): Promise<string> => await readOrCreateMachineId(join(dir, 'machine-id'))
  const channel = createChannelService({
    agentsFile: join(dir, 'no-agents.md'),
    configFile: join(dir, 'no-channel.json'),
    env: { WORKBENCH_CHANNEL_URL: 'ws://127.0.0.1:7880', WORKBENCH_CHANNEL_API_KEY: keys.LK_KEY, WORKBENCH_CHANNEL_API_SECRET: keys.LK_SECRET },
    rememberTool: 'wb_remember_item',
    doingTool: 'wb_doing',
    machineId,
    lanAddresses: () => lanAddresses(),
  })
  const pairing = createPairingService({ file: join(dir, 'devices.json') })
  let lanConfig: Record<string, unknown> = { lan_access: true }
  const server = await startWorkbenchServer({
    port: 0,
    service: createWorkbenchService(),
    tickIntervalMs: 0,
    heartbeatMs: 0,
    pairing,
    channel,
    machineId,
    lan: {
      config: { async get() { return lanConfig }, async set(patch: Record<string, unknown>) { lanConfig = { ...lanConfig, ...patch }; return lanConfig } },
      lanAddress: () => LAN,
    },
  })
  pairing.start()
  const claimed = await pairing.claim({ code: pairing.current()?.code ?? '', device_name: `探针手机-${name}`, platform: 'android' })
  if (!claimed.ok) throw new Error('探针:配对没成')
  const port = new URL(server.url).port
  return { server, port, token: claimed.token as string, deviceId: claimed.device_id as string, macId: await machineId() }
}

async function hit(base: string, method: string, path: string, options: { token?: string, body?: unknown, headers?: Record<string, string> } = {}) {
  const t0 = performance.now()
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(options.token === undefined ? {} : { authorization: `Bearer ${options.token}` }),
      ...options.headers,
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  })
  const text = await res.text()
  return { status: res.status, ms: Math.round(performance.now() - t0), body: (text === '' ? {} : JSON.parse(text)) as Record<string, unknown> }
}

const redact = (body: Record<string, unknown>): Record<string, unknown> => ({ ...body, ...(typeof body.token === 'string' ? { token: `<${(body.token as string).length} 字节>` } : {}) })

const a = await workbench('a')
const loop = `http://127.0.0.1:${a.port}`
const viaLan = `http://${LAN}:${a.port}`

// 1 · 工人(回环)
const workerTicket = await hit(loop, 'POST', '/channel/token', { body: { worker: true, name: '探针工人' } })
// 2 · 手机(局域网)
const phoneTicket = await hit(viaLan, 'POST', '/channel/token', { token: a.token, body: { name: '探针手机' } })
result.tickets = { worker: redact(workerTicket.body), phone: redact(phoneTicket.body), phone_ms: phoneTicket.ms }

async function enter(ticket: Record<string, unknown>) {
  const room = new rtc.Room()
  const t0 = performance.now()
  await room.connect(ticket.url as string, ticket.token as string, { autoSubscribe: true, dynacast: false })
  return { room, ms: Math.round(performance.now() - t0) }
}
const worker = await enter(workerTicket.body)
const phone = await enter(phoneTicket.body)
result.join_ms = { worker: worker.ms, phone: phone.ms }

// 数据往返:手机发 ping,工人回 pong(经本机房间两跳)
const enc = new TextEncoder(); const dec = new TextDecoder()
worker.room.on(rtc.RoomEvent.DataReceived, (payload: Uint8Array, _p: unknown, _k: unknown, topic?: string) => {
  if (topic === 'probe.ping') void worker.room.localParticipant!.publishData(payload, { reliable: true, topic: 'probe.pong' })
})
const waiters = new Map<string, (v: number) => void>()
phone.room.on(rtc.RoomEvent.DataReceived, (payload: Uint8Array, _p: unknown, _k: unknown, topic?: string) => {
  if (topic !== 'probe.pong') return
  const id = dec.decode(payload); waiters.get(id)?.(performance.now()); waiters.delete(id)
})
await new Promise(r => setTimeout(r, 800))
const rtts: number[] = []
let lost = 0
for (let i = 0; i < 20; i += 1) {
  const id = `p${i}`
  const t0 = performance.now()
  const done = new Promise<number>(ok => waiters.set(id, ok))
  await phone.room.localParticipant!.publishData(enc.encode(id), { reliable: true, topic: 'probe.ping' })
  const t1 = await Promise.race([done, new Promise<number>(ok => setTimeout(() => ok(-1), 2000))])
  if (t1 < 0) lost += 1
  else rtts.push(t1 - t0)
}
rtts.sort((x, y) => x - y)
result.data_rtt_ms = { n: 20, lost, median: Math.round((rtts[Math.floor(rtts.length / 2)] ?? -1) * 10) / 10, p90: Math.round((rtts[Math.floor(rtts.length * 0.9)] ?? -1) * 10) / 10 }

// 3 · 状态(局域网问)
const status = await hit(viaLan, 'GET', '/channel/status', { token: a.token })
result.status = { http: status.status, ms: status.ms, url: status.body.url, mode: status.body.mode, route: status.body.route, room: status.body.room, server: status.body.server, worker: status.body.worker, participants: status.body.participants }
// 4 · 找回(局域网问)
const route = await hit(viaLan, 'GET', '/channel/route', { token: a.token })
result.route = { http: route.status, ms: route.ms, ...route.body }
// 5 · 工人替手机续期(回环 + 设备头 + 路线头)
const renew = await hit(loop, 'POST', '/channel/token', { body: {}, headers: { 'x-workbench-channel-device': a.deviceId, 'x-workbench-channel-route': 'lan' } })
result.renew_via_worker = redact(renew.body)
// 6 · 第二台 8791:A 的设备令牌敲 B
const b = await workbench('b')
const crossRoute = await hit(`http://${LAN}:${b.port}`, 'GET', '/channel/route', { token: a.token })
const crossToken = await hit(`http://${LAN}:${b.port}`, 'POST', '/channel/token', { token: a.token, body: {} })
const ownRoute = await hit(`http://${LAN}:${b.port}`, 'GET', '/channel/route', { token: b.token })
result.two_macs = { a_mac_id: a.macId, b_mac_id: b.macId, a_token_on_b_route: crossRoute.status, a_token_on_b_token: crossToken.status, b_own_route_mac_id: ownRoute.body.mac_id }
// 7 · 别的钥匙签的票
const forged = signAccessToken({ apiKey: 'APIforged', apiSecret: 'not-the-secret-of-this-mac-xxxxxxxxxxxxxxxx', identity: 'wb-phone-intruder', grant: joinGrant(String(phoneTicket.body.room)), ttlSeconds: 600, nowSeconds: Math.floor(Date.now() / 1000) })
try {
  const intruder = new rtc.Room()
  await intruder.connect(String(phoneTicket.body.url), forged, { autoSubscribe: false })
  result.forged = 'joined (不该进得来)'
  await intruder.disconnect()
}
catch (err) {
  result.forged = `rejected: ${(err as Error).message.slice(0, 120)}`
}

await phone.room.disconnect()
await worker.room.disconnect()
await a.server.close()
await b.server.close()
writeFileSync(join(OUT, 'route-http.json'), `${JSON.stringify(result, null, 2)}\n`)
console.log(JSON.stringify(result, null, 2))
process.exit(0)
