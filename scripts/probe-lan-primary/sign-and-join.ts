/**
 * 探针①的后半:**用 8791 自己那份 `channel.ts` 的 local 模式签票**,两位参与者凭票进本机房间,
 * 量进房时延与「经房间转一圈」的数据往返;再拿一张别的钥匙签的票去敲门,确认进不来。
 *
 * 不起第二个 8791:直接调 `createChannelService`(真 8791 里 `/channel/token` 调的就是它的 `issue`),
 * env 指向 lk-up.sh 起的那台。不碰 ~/.dsh,`configFile` 指到一个不存在的路径。
 *
 * 用法(仓库根目录):
 *   node scripts/probe-lan-primary/sign-and-join.ts --out <lk-up 的 OUT 目录> [--url ws://<局域网IP>:7880] [--n 50]
 *   缺省 url 用 up.json 里的 signal(局域网地址)。依赖:@livekit/rtc-node,从 channel-worker/node_modules
 *   找;工作树里没装就加 --deps <装好的 node_modules>。
 * 输出:打印一份 JSON,同时写 OUT/sign-and-join.json。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { connect as tlsConnect } from 'node:tls'
import { performance } from 'node:perf_hooks'

const here = fileURLToPath(new URL('.', import.meta.url))
const repo = resolve(here, '..', '..')
function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : fallback
}
const OUT = arg('out') ?? join(process.env.TMPDIR ?? '/tmp', 'wb-lan-probe')
const up = JSON.parse(readFileSync(join(OUT, 'up.json'), 'utf8')) as { signal: string, lan_ip: string }
const keys = Object.fromEntries(readFileSync(join(OUT, 'keys.env'), 'utf8').trim().split('\n').map(l => l.split('=') as [string, string]))
const URL_ = arg('url') ?? up.signal
const N = Number(arg('n') ?? 50)
const depsDir = arg('deps') ?? [join(repo, 'channel-worker', 'node_modules'), resolve(repo, '..', '..', '..', 'channel-worker', 'node_modules')].find(d => existsSync(join(d, '@livekit', 'rtc-node'))) as string
const req = createRequire(join(depsDir, 'x.js'))
const rtc = await import(pathToFileURL(req.resolve('@livekit/rtc-node')).href) as typeof import('@livekit/rtc-node')
const { createChannelService, signAccessToken, joinGrant } = await import(pathToFileURL(join(repo, 'workbench-plugin', 'src', 'server', 'channel.ts')).href)

const env = {
  WORKBENCH_CHANNEL_URL: URL_,
  WORKBENCH_CHANNEL_API_KEY: keys.LK_KEY,
  WORKBENCH_CHANNEL_API_SECRET: keys.LK_SECRET,
}
const service = createChannelService({
  agentsFile: join(OUT, 'no-agents.md'),
  configFile: join(OUT, 'no-channel.json'),
  env,
  rememberTool: 'wb_remember_item',
  doingTool: 'wb_doing',
})

const result: Record<string, unknown> = { url: URL_, at: new Date().toISOString() }
result.view = await service.view()
const tPhone = await service.issue({ deviceId: 'probe-phone', kind: 'phone', name: '探针手机' })
const tHandset = await service.issue({ deviceId: 'probe-handset', kind: 'handset', name: '探针听筒' })
const tWorker = await service.issue({ worker: true, suffix: 'probe', name: '探针工人' })
result.tickets = [tPhone, tHandset, tWorker].map(t => ({ url: t.url, room: t.room, identity: t.identity, ttl_s: t.expires_at - Math.floor(Date.now() / 1000) }))

async function enter(ticket: { url: string, token: string }): Promise<{ room: InstanceType<typeof rtc.Room>, ms: number }> {
  const room = new rtc.Room()
  const t0 = performance.now()
  await room.connect(ticket.url, ticket.token, { autoSubscribe: true, dynacast: false })
  return { room, ms: Math.round(performance.now() - t0) }
}

// 两位凭票进房:手机、工人
const a = await enter(tPhone)
const b = await enter(tWorker)
result.join_ms = { phone: a.ms, worker: b.ms }

// 数据往返:手机发 ping,工人原样回 pong,经 SFU 两跳
const enc = new TextEncoder(); const dec = new TextDecoder()
b.room.on(rtc.RoomEvent.DataReceived, (payload: Uint8Array, _p: unknown, _k: unknown, topic?: string) => {
  if (topic === 'probe.ping') void b.room.localParticipant!.publishData(payload, { reliable: true, topic: 'probe.pong' })
})
const rtts: number[] = []
const waiters = new Map<string, (v: number) => void>()
a.room.on(rtc.RoomEvent.DataReceived, (payload: Uint8Array, _p: unknown, _k: unknown, topic?: string) => {
  if (topic !== 'probe.pong') return
  const id = dec.decode(payload); waiters.get(id)?.(performance.now()); waiters.delete(id)
})
await new Promise(r => setTimeout(r, 800))
for (let i = 0; i < N; i++) {
  const id = `p${i}`
  const t0 = performance.now()
  const done = new Promise<number>((res, rej) => { waiters.set(id, res); setTimeout(() => rej(new Error('timeout')), 3000) })
  await a.room.localParticipant!.publishData(enc.encode(id), { reliable: true, topic: 'probe.ping' })
  try { rtts.push((await done) - t0) } catch { rtts.push(Number.NaN) }
  await new Promise(r => setTimeout(r, 40))
}
const ok = rtts.filter(Number.isFinite).sort((x, y) => x - y)
const q = (p: number) => Math.round(ok[Math.min(ok.length - 1, Math.floor(p * (ok.length - 1)))]! * 10) / 10
result.data_rtt_ms = { n: N, lost: N - ok.length, p50: q(0.5), p90: q(0.9), max: q(1) }

// 别的钥匙签的票:同一局域网里的旁人没有这台 Mac 的 secret,应当进不来
const forged = signAccessToken({ apiKey: keys.LK_KEY, apiSecret: 'not-the-secret', identity: 'wb-phone-intruder', grant: joinGrant(tPhone.room), ttlSeconds: 600, nowSeconds: Math.floor(Date.now() / 1000) })
try { const r = new rtc.Room(); await r.connect(URL_, forged, {}); result.forged_join = 'JOINED(不该进来)'; await r.disconnect() }
catch (e) { result.forged_join = `rejected: ${(e as Error).message.slice(0, 80)}` }

result.status = await service.status()
await a.room.disconnect(); await b.room.disconnect()

// 对照:云房间那台的网络层往返(不进生产房间,只量 TCP+TLS 握手)
async function tlsMs(host: string): Promise<number> {
  const t0 = performance.now()
  return await new Promise((res, rej) => {
    const s = tlsConnect({ host, port: 443, servername: host }, () => { res(Math.round(performance.now() - t0)); s.end() })
    s.on('error', rej); s.setTimeout(5000, () => { s.destroy(); rej(new Error('timeout')) })
  })
}
const cloud: number[] = []
for (let i = 0; i < 5; i++) { try { cloud.push(await tlsMs('lk.aibooo.cn')) } catch { /* 记缺 */ } }
result.cloud_tls_handshake_ms = cloud

writeFileSync(join(OUT, 'sign-and-join.json'), JSON.stringify(result, null, 2))
console.log(JSON.stringify(result, null, 2))
await rtc.dispose?.()
process.exit(0)
