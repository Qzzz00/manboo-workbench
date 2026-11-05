/**
 * 8791 的一次**久跑**(2026-10-19,卡「插件内存增长与 GC 抖动」):本地起一份同一份源码的工作台,
 * 连打 /state 与 /live 广播若干分钟,看 heapUsed 收不收敛。
 *
 * 不碰 ~/.dsh、不碰维护者机器上任何在跑的进程:数据目录是临时的,端口随机。
 * 这台是**夹层**,不是生产入口:没有 DSH 会话通道、没有壳、没有额度采集;看板、会话表、机器格、
 * 进程采样器、/live 是真的。它量的是「这几条路本身」会不会随时间涨,不是生产进程的全貌 ——
 * 生产那边的数随 0.4.138 起每 10 分钟一行 `[内存]` 日志自己说。
 *
 * 用法(`--expose-gc` 让每分钟那一下量的是**活着的堆**,不含还没回收的垃圾):
 *   node --expose-gc dev/soak-8791.ts --minutes 30 --cards 200 --out /tmp/soak.json
 *
 * 负载(每秒):/state 两路轮询(1 秒一次 + 3 秒一次)、3 条 /live 订阅、每 500ms 一次整块快照广播、
 * 每 5 秒一条新会话上报(让会话表走到「收」那一步)。
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { createTasksService } from '../src/server/tasks.ts'
import { createProcessHealth } from '../src/server/processHealth.ts'
import { SESSION_STORE_MAX_SETTLED_PER_AGENT } from '../src/server/sessions.ts'
import type { WorkbenchEvent } from '../src/protocol.ts'

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback
}

const minutes = Number(arg('minutes', '30'))
const cards = Number(arg('cards', '200'))
const out = arg('out', '')
const dir = mkdtempSync(join(tmpdir(), 'wb-soak-'))

const tasks = createTasksService({ file: join(dir, 'tasks.json') })
for (let i = 0; i < cards; i += 1) {
  await tasks.create({
    title: `久跑第 ${i} 张卡:${'一句不短的标题'.repeat(3)}`,
    desc: `${'这张卡的说明文字,凑到和真看板差不多的体量。'.repeat(12)}`,
    status: i % 3 === 0 ? 'done' : i % 3 === 1 ? 'todo' : 'doing',
  })
}

const service = createWorkbenchService()
const processHealth = createProcessHealth({ log: line => console.log(line) })
const server = await startWorkbenchServer({
  port: 0,
  host: '127.0.0.1',
  service,
  tasks,
  processHealth,
  machine: async () => ({ disk_pct: 40, disk_free_gb: 200, mem_gb: 16, cpu_idle_pct: 70, sampled_at: new Date().toISOString() }),
  tickIntervalMs: 1000,
  heartbeatMs: 20_000,
  usageIntervalMs: 0,
})
console.log(`[soak] 起来了:${server.url}(数据目录 ${dir},${cards} 张卡,跑 ${minutes} 分钟)`)

const sockets: WebSocket[] = []
let liveFrames = 0
let liveBytes = 0
for (let i = 0; i < 3; i += 1) {
  const ws = new WebSocket(`${server.url.replace('http://', 'ws://')}/live`)
  ws.on('message', (raw) => { liveFrames += 1; liveBytes += (raw as Buffer).length })
  ws.on('error', () => {})
  sockets.push(ws)
}

let stateCalls = 0
let stateBytes = 0
let stateMaxMs = 0
let stateErrors = 0
async function hitState(): Promise<void> {
  const t0 = performance.now()
  try {
    const res = await fetch(`${server.url}/state`)
    const text = await res.text()
    stateCalls += 1
    stateBytes = text.length
  }
  catch { stateErrors += 1 }
  stateMaxMs = Math.max(stateMaxMs, performance.now() - t0)
}

let sessionSeq = 0
function feedSession(): void {
  sessionSeq += 1
  const ts = Math.floor(Date.now() / 1000)
  const agent = (['claude', 'codex', 'dsh'] as const)[sessionSeq % 3] as WorkbenchEvent['agent']
  service.applyEvent({ agent, session_id: `soak-${sessionSeq}`, type: 'running', ts, project: '久跑', title: `第 ${sessionSeq} 条`, summary: '一段摘要'.repeat(10) } as WorkbenchEvent)
  service.applyEvent({ agent, session_id: `soak-${sessionSeq}`, type: 'done', ts, project: '久跑' } as WorkbenchEvent)
}

const timers = [
  setInterval(() => { void hitState() }, 1000),
  setInterval(() => { void hitState() }, 3000),
  setInterval(() => { server.broadcastState() }, 500),
  setInterval(feedSession, 5000),
]

interface Sample { minute: number, heap_used_mb: number, heap_total_mb: number, rss_mb: number, external_mb: number, sessions: number, state_kb: number, state_max_ms: number, loop_p99_ms?: number, live_frames: number, live_mb: number, merged: number, skipped: number }
const samples: Sample[] = []
const gc = (globalThis as { gc?: () => void }).gc

function sampleNow(minute: number): Sample {
  gc?.()
  const view = processHealth.view()
  const stats = server.liveStats()
  const sample: Sample = {
    minute,
    heap_used_mb: view?.heap_used_mb ?? -1,
    heap_total_mb: view?.heap_total_mb ?? -1,
    rss_mb: view?.rss_mb ?? -1,
    external_mb: view?.external_mb ?? -1,
    sessions: service.getState().sessions.length,
    state_kb: Math.round(stateBytes / 1024),
    state_max_ms: Math.round(stateMaxMs),
    ...(view?.loop_p99_ms === undefined ? {} : { loop_p99_ms: view.loop_p99_ms }),
    live_frames: liveFrames,
    live_mb: Math.round(liveBytes / 1024 / 1024 * 10) / 10,
    merged: stats.merged,
    skipped: stats.skipped,
  }
  stateMaxMs = 0
  console.log(`[soak] 第 ${minute} 分钟 heapUsed=${sample.heap_used_mb}MB heapTotal=${sample.heap_total_mb}MB rss=${sample.rss_mb}MB sessions=${sample.sessions} state=${sample.state_kb}KB state_max=${sample.state_max_ms}ms loop_p99=${sample.loop_p99_ms ?? '取不到'}ms live=${sample.live_frames}帧/${sample.live_mb}MB merged=${sample.merged} skipped=${sample.skipped}${gc === undefined ? '(没开 --expose-gc,heap 含垃圾)' : ''}`)
  return sample
}

samples.push(sampleNow(0))
for (let minute = 1; minute <= minutes; minute += 1) {
  await new Promise(resolve => setTimeout(resolve, 60_000))
  samples.push(sampleNow(minute))
}

for (const timer of timers) clearInterval(timer)
for (const ws of sockets) ws.terminate()
await server.close()
processHealth.close()

/** 结论:后一半的 heapUsed 中位数比前一半(去掉前 2 分钟热身)高了多少。 */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted.length === 0 ? 0 : sorted[Math.floor(sorted.length / 2)] as number
}
const body = samples.slice(2)
const half = Math.floor(body.length / 2)
const first = median(body.slice(0, half).map(one => one.heap_used_mb))
const second = median(body.slice(half).map(one => one.heap_used_mb))
const verdict = {
  minutes,
  cards,
  state_calls: stateCalls,
  state_errors: stateErrors,
  heap_first_half_median_mb: first,
  heap_second_half_median_mb: second,
  heap_drift_mb: Math.round((second - first) * 10) / 10,
  sessions_capped_at: SESSION_STORE_MAX_SETTLED_PER_AGENT,
  samples,
}
console.log(`[soak] 结论:/state ${stateCalls} 次(${stateErrors} 次失败);heapUsed 前半中位 ${first}MB → 后半中位 ${second}MB(漂 ${verdict.heap_drift_mb}MB)`)
if (out !== '') {
  writeFileSync(out, `${JSON.stringify(verdict, null, 2)}\n`)
  console.log(`[soak] 写到 ${out}`)
}
