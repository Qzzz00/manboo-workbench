/**
 * 探针②的真机那一半:**真手机经 Wi-Fi 进本机房间**,量进房时延、经房间的数据往返、能不能把麦克风发上来。
 *
 * 真 App 今天没法被指到本机房间而不动生产(票中转优先、来电常驻云房间),所以用手机上的 Chrome 开一页
 * livekit-client:页面经 `adb reverse` 从 http://127.0.0.1:8799 载入(算安全上下文,麦克风给得出来),
 * **房间连接走票里的局域网地址 ws://<Mac>:7880,过真 Wi-Fi、媒体走 UDP 7882**。票由 8791 的 channel.ts local 模式签。
 * Mac 上一位应答者(rtc-node)把 ping 原样回成 pong。
 *
 * 前提:先跑 lk-up.sh;手机 USB 接上(adb devices 看得到)且和 Mac 在同一个 Wi-Fi。
 * 用法:node scripts/probe-lan-primary/phone-join.ts --out <OUT> [--deps <channel-worker 的 node_modules>] [--n 30]
 * 结果:OUT/phone-join.json。手机上会弹一次麦克风授权,点允许。
 */
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { createReadStream, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const repo = resolve(here, '..', '..')
function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : fallback
}
const OUT = arg('out') ?? join(process.env.TMPDIR ?? '/tmp', 'wb-lan-probe')
const N = Number(arg('n') ?? 30)
const PORT = 8799
/** `--no-adb`:不找手机,只起页面(在 Mac 的浏览器里开 http://127.0.0.1:8799 自检这一页)。 */
const NO_ADB = process.argv.includes('--no-adb')
const up = JSON.parse(readFileSync(join(OUT, 'up.json'), 'utf8')) as { signal: string }
const keys = Object.fromEntries(readFileSync(join(OUT, 'keys.env'), 'utf8').trim().split('\n').map(l => l.split('=') as [string, string]))
const depsDir = arg('deps') ?? join(repo, 'channel-worker', 'node_modules')
const req = createRequire(join(depsDir, 'x.js'))
const rtc = await import(pathToFileURL(req.resolve('@livekit/rtc-node')).href) as typeof import('@livekit/rtc-node')
const umd = join(depsDir, 'livekit-client', 'dist', 'livekit-client.umd.js')
if (!existsSync(umd)) throw new Error(`找不到 ${umd}`)

const devices = execFileSync('adb', ['devices']).toString().split('\n').slice(1).filter(l => /\tdevice$/.test(l))
if (!NO_ADB && devices.length === 0) { console.error('adb 看不到手机:先用 USB 接上并允许调试'); process.exit(2) }

const { createChannelService } = await import(pathToFileURL(join(repo, 'workbench-plugin', 'src', 'server', 'channel.ts')).href)
const channel = createChannelService({
  agentsFile: join(OUT, 'no-agents.md'),
  configFile: join(OUT, 'no-channel.json'),
  env: { WORKBENCH_CHANNEL_URL: up.signal, WORKBENCH_CHANNEL_API_KEY: keys.LK_KEY, WORKBENCH_CHANNEL_API_SECRET: keys.LK_SECRET },
  rememberTool: 'wb_remember_item',
  doingTool: 'wb_doing',
})
const phoneTicket = await channel.issue({ deviceId: 'probe-pixel', kind: 'phone', name: '探针真手机' })
const echoTicket = await channel.issue({ worker: true, suffix: 'echo', name: '探针应答' })

// Mac 上的应答者:ping → pong
const echo = new rtc.Room()
await echo.connect(echoTicket.url, echoTicket.token, { autoSubscribe: true, dynacast: false })
echo.on(rtc.RoomEvent.DataReceived, (payload: Uint8Array, _p: unknown, _k: unknown, topic?: string) => {
  if (topic === 'probe.ping') void echo.localParticipant!.publishData(payload, { reliable: true, topic: 'probe.pong' })
})
let micHeard = false
echo.on(rtc.RoomEvent.TrackSubscribed, (track: { kind?: unknown }) => { if (track.kind === rtc.TrackKind.KIND_AUDIO) micHeard = true })

const page = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<body style="font:16px sans-serif;padding:16px"><h3>局域网主路探针</h3><pre id="log"></pre>
<script src="/livekit-client.umd.js"></script><script>
const T = ${JSON.stringify({ url: phoneTicket.url, token: phoneTicket.token, n: N })};
const out = { ua: navigator.userAgent, url: T.url };
const log = (s) => { document.getElementById('log').textContent += s + '\\n' };
(async () => {
  try {
    const room = new LivekitClient.Room();
    const t0 = performance.now();
    await room.connect(T.url, T.token);
    out.join_ms = Math.round(performance.now() - t0); log('进房 ' + out.join_ms + ' ms');
    const waiters = new Map(); const rtts = [];
    room.on(LivekitClient.RoomEvent.DataReceived, (p, _x, _k, topic) => {
      if (topic !== 'probe.pong') return; const id = new TextDecoder().decode(p); waiters.get(id)?.(performance.now()); waiters.delete(id);
    });
    await new Promise(r => setTimeout(r, 800));
    for (let i = 0; i < T.n; i++) {
      const id = 'p' + i; const s = performance.now();
      const done = new Promise((ok, no) => { waiters.set(id, ok); setTimeout(() => no(), 3000) });
      await room.localParticipant.publishData(new TextEncoder().encode(id), { reliable: true, topic: 'probe.ping' });
      try { rtts.push((await done) - s) } catch { rtts.push(null) }
      await new Promise(r => setTimeout(r, 50));
    }
    out.rtts = rtts; log('往返 ' + rtts.map(x => x === null ? 'x' : Math.round(x)).join(' '));
    try {
      const m0 = performance.now();
      await room.localParticipant.setMicrophoneEnabled(true);
      out.mic_publish_ms = Math.round(performance.now() - m0); log('麦克风发上去了 ' + out.mic_publish_ms + ' ms');
      await new Promise(r => setTimeout(r, 3000));
    } catch (e) { out.mic_error = String(e); log('麦克风没发上去:' + e) }
    try {
      const pc = room.engine?.pcManager?.publisher?.getPeerConnection?.() ?? room.engine?.pcManager?.publisher?.pc;
      if (pc) { const st = await pc.getStats(); st.forEach(r => { if (r.type === 'candidate-pair' && r.nominated) out.pair = { rtt_ms: r.currentRoundTripTime * 1000, local: r.localCandidateId, remote: r.remoteCandidateId };
        if (r.type === 'local-candidate' || r.type === 'remote-candidate') (out.candidates ??= {})[r.id] = r.candidateType + ' ' + (r.protocol || '') + ' ' + (r.address || r.ip || '') + ':' + r.port }) }
    } catch (e) { out.stats_error = String(e) }
    await room.disconnect();
  } catch (e) { out.error = String(e); log('出错:' + e) }
  await fetch('/result', { method: 'POST', body: JSON.stringify(out) }); log('结果已交回 Mac');
})();
</script>`

const result = await new Promise<Record<string, unknown>>((done) => {
  const server = createServer((rq, rs) => {
    const path = (rq.url ?? '/').split('?')[0]
    if (path === '/livekit-client.umd.js') { rs.writeHead(200, { 'content-type': 'text/javascript' }); createReadStream(umd).pipe(rs); return }
    if (path === '/result' && rq.method === 'POST') {
      const c: Buffer[] = []; rq.on('data', d => c.push(d)); rq.on('end', () => { rs.end('ok'); server.close(); done(JSON.parse(Buffer.concat(c).toString('utf8'))) })
      return
    }
    rs.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); rs.end(page)
  })
  server.listen(PORT, '127.0.0.1', () => {
    if (NO_ADB) { console.log(`自检:在本机浏览器开 http://127.0.0.1:${PORT}/`); return }
    execFileSync('adb', ['reverse', `tcp:${PORT}`, `tcp:${PORT}`])
    execFileSync('adb', ['shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', `http://127.0.0.1:${PORT}/?t=${Date.now()}`, 'com.android.chrome'])
    console.log('已在手机 Chrome 打开探针页,等结果(最多 120 秒;弹麦克风授权就点允许)')
  })
  setTimeout(() => done({ error: '120 秒没等到手机交回结果' }), 120_000)
})
const rtts = (result.rtts as (number | null)[] | undefined ?? []).filter((x): x is number => typeof x === 'number').sort((a, b) => a - b)
const q = (p: number) => rtts.length === 0 ? undefined : Math.round(rtts[Math.min(rtts.length - 1, Math.floor(p * (rtts.length - 1)))]! * 10) / 10
const summary = { ...result, rtt_ms: { n: N, lost: N - rtts.length, p50: q(0.5), p90: q(0.9), max: q(1) }, mac_heard_mic_track: micHeard, at: new Date().toISOString() }
delete (summary as Record<string, unknown>).rtts
writeFileSync(join(OUT, 'phone-join.json'), JSON.stringify(summary, null, 2))
console.log(JSON.stringify(summary, null, 2))
try { if (!NO_ADB) execFileSync('adb', ['reverse', '--remove', `tcp:${PORT}`]) } catch { /* 已断 */ }
await echo.disconnect()
process.exit(0)
