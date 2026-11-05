/**
 * 探针⑤(卡 M4,2026-10-21):**真手机按路线进本机房间、接一通来电**。
 *
 * 起的东西全是自己的,不碰 ~/.dsh、不碰正在跑的 8791 / 工人 / 云房间:
 *   - 一台「替身 8791」,听**局域网**的 `0.0.0.0:<port>`(缺省 18791):`/channel/route`(机器 id、本机房间、地址表)、
 *     `/channel/token`(手机 / 工人的本机房间票,由 8791 那份 channel.ts 的 local 模式签)、`/channel/status`、
 *     工人要的 `/channel/persona`、`/channel/credentials`(转问真 8791,只在内存里交给工人)、`/call/claim`(按下面的「响一通」交一通)、
 *     `/call/ack`;手机要的别的一律空答(不进真账)。设备令牌是这次现生成的测试值,存在 OUT 里(0600)。
 *   - 一个真工人进程(channel-worker/src/main.ts,HOME 指到临时目录),进本机房间;接话模型是 dev/stub-llm.mjs。
 *   - 控制口(只认回环):`POST /bench/ring` 交下一通来电;`GET /bench/events` 看事件表。
 *
 * 手机那一侧(另外用 adb 做,交接里写了步骤):把调试包的配对改成指向这台替身(同一个设备 id —— 出门时账号那条路照旧通到
 * 真的云房间),在家的 Wi-Fi 上它就会判到在家、进本机房间。
 *
 * 用法(仓库根目录,先跑 lk-up.sh):
 *   node scripts/probe-lan-primary/phone-route.ts --out <lk-up 的 OUT> --device-id <手机的设备 id> [--port 18791]
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createWriteStream, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const repo = resolve(here, '..', '..')
function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : fallback
}
const OUT = arg('out') ?? join(process.env.TMPDIR ?? '/tmp', 'wb-lan-probe')
const PORT = Number(arg('port', '18791'))
const DEVICE_ID = arg('device-id')
if (DEVICE_ID === undefined || DEVICE_ID === '') { console.error('要 --device-id'); process.exit(2) }
const REAL_8791 = arg('real-workbench') ?? 'http://127.0.0.1:8791'
const REAL_8792 = arg('real-butler') ?? 'http://127.0.0.1:8792'
const up = JSON.parse(readFileSync(join(OUT, 'up.json'), 'utf8')) as { lan_ip: string, signal: string }
const keys = Object.fromEntries(readFileSync(join(OUT, 'keys.env'), 'utf8').trim().split('\n').map(l => l.split('=') as [string, string]))
const LAN = up.lan_ip

/** 这台替身的机器 id 与给手机的测试令牌:第一次现生成,之后照用(手机里改过一次配对就不用再改)。 */
function persisted(name: string, make: () => string): string {
  const file = join(OUT, name)
  if (existsSync(file)) return readFileSync(file, 'utf8').trim()
  const value = make()
  writeFileSync(file, value, { mode: 0o600 })
  return value
}
const MAC_ID = persisted('phone-route-mac-id', () => randomBytes(16).toString('hex'))
const DEVICE_TOKEN = persisted('phone-route-token', () => `wbt_bench_${randomBytes(18).toString('hex')}`)
const ROOM = `wb-local-${MAC_ID.slice(0, 8)}`
const LAN_URL = up.signal

const { createChannelService } = await import(pathToFileURL(join(repo, 'workbench-plugin', 'src', 'server', 'channel.ts')).href)
const channel = createChannelService({
  agentsFile: join(OUT, 'no-agents.md'),
  configFile: join(OUT, 'no-channel.json'),
  env: { WORKBENCH_CHANNEL_URL: LAN_URL, WORKBENCH_CHANNEL_API_KEY: keys.LK_KEY, WORKBENCH_CHANNEL_API_SECRET: keys.LK_SECRET, WORKBENCH_CHANNEL_ROOM: ROOM },
  rememberTool: 'wb_remember_item',
  doingTool: 'wb_doing',
})

const t0 = Date.now()
const events: { t: number, what: string }[] = []
const mark = (what: string): void => { events.push({ t: Date.now() - t0, what }); console.log(`+${Date.now() - t0}ms ${what}`) }
function body(req: IncomingMessage): Promise<string> {
  return new Promise((ok) => { const c: Buffer[] = []; req.on('data', d => c.push(d)); req.on('end', () => ok(Buffer.concat(c).toString('utf8'))) })
}
function json(res: ServerResponse, status: number, value: unknown): void { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)) }
const loopback = (req: IncomingMessage): boolean => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '')
const bearer = (req: IncomingMessage): string | undefined => /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1]

let workerInRoom = false
let pendingCall: { id: string, title: string } | null = null
let callSeq = 0
const shim = createServer((req, res) => {
  void (async () => {
    const path = (req.url ?? '').split('?')[0] ?? ''
    // 手机 App 的页面在 WebView 自己的源上,带 Authorization 的跨源请求先发预检:与真 8791 一样放行(http.ts 的「预检」那段)。
    const origin = req.headers.origin
    if (typeof origin === 'string') { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin') }
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'content-type, authorization, range')
      res.writeHead(204); res.end(); return
    }
    const raw = await body(req)
    const input = (() => { try { return JSON.parse(raw === '' ? '{}' : raw) as Record<string, unknown> } catch { return {} } })()
    const local = loopback(req)
    const phone = bearer(req) === DEVICE_TOKEN
    // 控制口
    if (path === '/bench/ring' && local) {
      callSeq += 1
      pendingCall = { id: `bench-call-${process.pid}-${callSeq}`, title: typeof input.title === 'string' ? input.title : 'M4 真机:在家来电' }
      mark(`排下一通来电 ${pendingCall.id}`)
      return json(res, 200, { ok: true, id: pendingCall.id })
    }
    if (path === '/bench/events' && local) return json(res, 200, { events })
    // 工人(回环)
    if (local && path === '/channel/token' && req.method === 'POST' && input.worker === true) {
      const ticket = await channel.issue({ worker: true, name: '替身工人' })
      mark(`签工人票 → ${ticket.url} / ${ticket.room}`)
      return json(res, 200, { ...ticket, route: 'lan' })
    }
    if (local && path === '/channel/persona') return json(res, 200, { system_message: '你是事务官。说话简短,一两句就够。', welcome: '我在,这是家里那条线。', addresses: ['老板'] })
    if (local && path === '/channel/credentials') {
      try { const r = await fetch(`${REAL_8791}/channel/credentials`, { signal: AbortSignal.timeout(8000) }); return json(res, r.status, await r.json()) }
      catch { return json(res, 200, { source: 'none' }) }
    }
    if (local && path === '/call/claim') {
      if (pendingCall === null) return json(res, 200, { calls: [] })
      const call = pendingCall
      pendingCall = null
      mark(`工人领走来电 ${call.id}`)
      return json(res, 200, { calls: [{ id: call.id, reason: 'ask', item_id: 'bench-item', title: call.title, at: new Date().toISOString(), silent: false }] })
    }
    if (local && path === '/call/ack') { mark(`工人报这通结果:${String(input.result)}`); return json(res, 200, { ok: true }) }
    // 手机(局域网,带测试令牌)
    if (path === '/channel/route') {
      if (!phone) { mark(`/channel/route 401(${req.socket.remoteAddress})`); return json(res, 401, { error: '设备令牌不对', mac_id: MAC_ID }) }
      mark(`手机问 /channel/route(${req.socket.remoteAddress})`)
      return json(res, 200, { mac_id: MAC_ID, room: ROOM, lan_url: LAN_URL, mode: 'lan', lan_addresses: [LAN], relay: { configured: true } })
    }
    if (!phone && !local) return json(res, 401, { error: '设备令牌不对' })
    if (path === '/channel/token' && req.method === 'POST') {
      const ticket = await channel.issue({ deviceId: DEVICE_ID, kind: 'phone', name: '真手机' })
      mark(`签手机票 → ${ticket.url} / ${ticket.room}`)
      return json(res, 200, { ...ticket, route: 'lan' })
    }
    if (path === '/channel/status') return json(res, 200, { configured: true, url: LAN_URL, room: ROOM, mode: 'lan', route: 'lan', server: true, worker: workerInRoom })
    // 写操作一律空答(不进真账);读操作(首页的 /state、来电台账……)转问真 8791 的回环口,只读,让 App 的页面照常画得出来。
    if (req.method !== 'GET') return json(res, 200, { ok: true })
    try {
      const r = await fetch(`${REAL_8791}${req.url ?? path}`, { signal: AbortSignal.timeout(8000) })
      res.writeHead(r.status, { 'content-type': r.headers.get('content-type') ?? 'application/json' })
      res.end(Buffer.from(await r.arrayBuffer()))
    } catch { json(res, 502, { error: '替身转问真 8791 没通' }) }
  })()
})
await new Promise<void>(ok => shim.listen(PORT, '0.0.0.0', () => ok()))
mark(`替身 8791 在 http://${LAN}:${PORT}(机器 id ${MAC_ID.slice(0, 8)}…,房间 ${ROOM})`)

const WORKER_DIR = join(repo, 'channel-worker')
const children: ChildProcess[] = []
const nodeBin = process.execPath
const llmPort = 18000 + (process.pid % 1000)
children.push(spawn(nodeBin, [join(WORKER_DIR, 'dev', 'stub-llm.mjs'), String(llmPort)], { stdio: 'ignore' }))
const HOME = mkdtempSync(join(tmpdir(), 'wb-phone-route-home-'))
const workerLog = createWriteStream(join(OUT, 'phone-route-worker.log'))
const worker = spawn(nodeBin, [join(WORKER_DIR, 'src', 'main.ts')], {
  cwd: WORKER_DIR,
  env: {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME,
    LANG: 'en_US.UTF-8',
    WORKBENCH_CHANNEL_WORKBENCH_URL: `http://127.0.0.1:${PORT}`,
    WORKBENCH_CHANNEL_BUTLER_URL: REAL_8792,
    WORKBENCH_CHANNEL_LLM_BASE_URL: `http://127.0.0.1:${llmPort}/v1`,
    DEEPSEEK_API_KEY: 'stub-not-a-key',
    WORKBENCH_CHANNEL_INBOX_DIR: join(HOME, 'inbox'),
    WORKBENCH_CHANNEL_OUTBOX_DIR: join(HOME, 'outbox'),
    WORKBENCH_CHANNEL_TRANSFERS_FILE: join(HOME, 'transfers.jsonl'),
    WORKBENCH_CHANNEL_DEVICE_NAME: 'phone-route-bench',
    WORKBENCH_CHANNEL_WORKER_SUFFIX: 'bench',
    WORKBENCH_CHANNEL_LOAD_GUARD: 'off',
    WORKBENCH_CHANNEL_TURN_ROUTER: 'rules',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
children.push(worker)
for (const s of [worker.stdout!, worker.stderr!]) {
  s.setEncoding('utf8')
  s.on('data', (chunk: string) => {
    for (const line of chunk.split('\n')) {
      if (line.trim() === '') continue
      workerLog.write(`${Date.now() - t0}\t${line}\n`)
      if (line.includes('进房了')) workerInRoom = true
      if (/进房了|响铃|ring|接起|answered|识别|ASR|TTS|合成|失败|出错|error|wb-phone/i.test(line) && !line.startsWith('{')) mark(`工人:${line.slice(0, 160)}`)
    }
  })
}
worker.on('exit', (code) => { mark(`工人退出(${code})`) })

const stop = (): void => {
  for (const c of children) { try { c.kill('SIGTERM') } catch { /* 已退 */ } }
  shim.close()
  writeFileSync(join(OUT, 'phone-route.json'), JSON.stringify({ lan: LAN, port: PORT, room: ROOM, events }, null, 2))
  process.exit(0)
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
