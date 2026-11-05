// WebKit 那一份(2026-09-25,卡 fix/evening-gaps 第 6 条):起 webhost(一扇几乎透明、点不中、不抢焦点的窗,
// 里面一块 WKWebView —— 壳用的就是它),量它新起的 WebContent / GPU 进程的 CPU(累计 CPU 时间差 / 墙钟)。
// 用法(先起 vite,见 vite.config.mjs;再 swiftc -O webhost.swift -o webhost):
//   node measure-webkit.mjs idle,working,beam,all 12 "" 9          # 歇着(那扇窗不在前台,等 9 秒过了 5 秒的门槛)
//   node measure-webkit.mjs idle,working,beam,all 12 "&active=1" 5 # 在用
// 百分比随这台 Mac 的负载漂(忙的时候同样的活吃得更多):比前后要交替跑,别拿两个时段的数比。
import { execFileSync, spawn } from 'node:child_process'
const S = new URL('.', import.meta.url).pathname  // webhost 编在这一格旁边:swiftc -O webhost.swift -o webhost
const scenes = (process.argv[2] ?? 'blank,idle,working,beam,all').split(',')
const seconds = Number(process.argv[3] ?? 12)
const extra = process.argv[4] ?? ''
const warmup = Number(process.argv[5] ?? 5) * 1000
const sleep = ms => new Promise(r => setTimeout(r, ms))
function parseTime(t) {
  const [a, b] = t.split('.')
  const parts = a.split(':').map(Number)
  let secs = 0
  for (const p of parts) secs = secs * 60 + p
  return secs + (b === undefined ? 0 : Number(`0.${b}`))
}
function webkitProcs() {
  const out = execFileSync('ps', ['-axo', 'pid=,time=,comm='], { encoding: 'utf8', maxBuffer: 1 << 24 })
  const rows = {}
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(line); if (!m) continue
    const comm = m[3]
    const kind = /com\.apple\.WebKit\.(WebContent|GPU|Networking)/.exec(comm)?.[1] ?? (comm.endsWith('/webhost') ? 'host' : undefined)
    if (kind === undefined) continue
    rows[m[1]] = { kind, secs: parseTime(m[2]) }
  }
  return rows
}
for (const scene of scenes) {
  const before = webkitProcs()
  const child = spawn(`${S}webhost`, [`http://127.0.0.1:4198/${process.env.PAGE ?? ""}?scene=${scene}${extra}`, String(seconds + warmup / 1000 + 3), '0.02'], { stdio: 'ignore' })
  await sleep(warmup)
  const a = webkitProcs()
  const t0 = Date.now()
  await sleep(seconds * 1000)
  const b = webkitProcs()
  const dt = (Date.now() - t0) / 1000
  const pct = {}
  for (const [pid, row] of Object.entries(b)) {
    if (before[pid] !== undefined && row.kind !== 'host') continue // 事先就在的(比如维护者壳的)不算
    const start = a[pid]; if (start === undefined) continue
    pct[row.kind] = Math.round(((pct[row.kind] ?? 0) + (row.secs - start.secs) / dt * 100) * 10) / 10
  }
  console.log(JSON.stringify({ scene, webcontent_pct: pct.WebContent ?? 0, gpu_pct: pct.GPU ?? 0, host_pct: pct.host ?? 0, networking_pct: pct.Networking ?? 0 }))
  await new Promise(r => child.on('exit', r))
  await sleep(1500)
}
