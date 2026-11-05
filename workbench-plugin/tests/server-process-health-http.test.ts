// @vitest-environment node
/**
 * 插件进程的内存与事件循环接进 8791(2026-10-19,卡「插件内存增长与 GC 抖动」)。
 *
 * 钉的是:
 * - `/state.machine.process` 有那几个数;没接采样器就缺席;机器采样整格缺席时它也缺席;
 * - 语音后端「从在跑变没在跑」那一下,本进程事件循环 p99 高于探测超时就**不报** crash_restart;正常时照报;
 * - 采样器挂在 1 秒节拍上(tick 到了就 pump);
 * - /live:整块快照的广播合并(连叫五次至多组两份);收不动的连接不再往它缓冲里堆。
 */
import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { startWorkbenchServer, type StartWorkbenchServerOptions, type WorkbenchServer } from '../src/server/http.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import type { ButlerService } from '../src/server/butler.ts'
import type { DiagService } from '../src/server/diagnostics/service.ts'
import { createProcessHealth, type ProcessHealth } from '../src/server/processHealth.ts'
import type { WorkbenchState } from '../src/protocol.ts'

const started: WorkbenchServer[] = []
afterEach(async () => {
  while (started.length) await started.pop()?.close()
})

const MACHINE: WorkbenchState['machine'] = { disk_pct: 40, disk_free_gb: 200, mem_gb: 16, cpu_idle_pct: 70, sampled_at: '2026-10-19T02:00:00.000Z' }

function fakeButler(state: { running: boolean }): ButlerService {
  return {
    async view() { return { running: state.running, port: 8792 } },
    async adminUrl() { return 'http://127.0.0.1:8792/admin/' },
    async start() { return { ok: true } },
    async stop() { return { ok: true } },
    async open() { return { ok: true } },
    async proxy() { return { status: 502, body: Buffer.from('') } },
  }
}

function fakeDiag(): DiagService & { reports: string[] } {
  const reports: string[] = []
  const settings = { report_enabled: true, notice_seen: true, sent_this_hour: 0, hourly_limit: 20 }
  return {
    reports,
    async export() { return { ok: false, error: '用例里不导' } },
    async settings() { return settings },
    async setReportEnabled() { return settings },
    async markNoticeSeen() { return settings },
    async report(event) { reports.push(`${event.component}/${event.kind}`); return { code: 'WB-000001', sent: false, merged: 1 } },
    pump() {},
    lastRotate: () => undefined,
    send: () => ({ id: 'send-1', state: 'failed', started_at: '2026-10-19T02:00:00.000Z', error: '用例里不发' }),
    sendView: () => undefined,
    async waitSend() {},
  }
}

/** 假采样器:p99 与 pump 次数可控。 */
function fakeHealth(input: { p99?: number } = {}): ProcessHealth & { pumps: number } {
  const health = {
    pumps: 0,
    view: () => ({
      rss_mb: 412.3, heap_used_mb: 180, heap_total_mb: 260, heap_limit_mb: 4288, external_mb: 12.5,
      up_sec: 300, started_at: '2026-10-19T01:55:00.000Z', sampled_at: '2026-10-19T02:00:00.000Z',
      ...(input.p99 === undefined ? {} : { loop_p99_ms: input.p99 }),
    }),
    loopP99Ms: () => input.p99,
    pump: () => { health.pumps += 1 },
    logLine: () => '',
    close: () => {},
  }
  return health
}

async function serve(options: Partial<StartWorkbenchServerOptions> = {}): Promise<WorkbenchServer> {
  const server = await startWorkbenchServer({
    port: 0,
    host: '127.0.0.1',
    service: createWorkbenchService(),
    tickIntervalMs: 0,
    heartbeatMs: 0,
    usageIntervalMs: 0,
    ...options,
  })
  started.push(server)
  return server
}

async function stateOf(server: WorkbenchServer): Promise<WorkbenchState> {
  const res = await fetch(`${server.url}/state`)
  return await res.json() as WorkbenchState
}

describe('/state.machine.process', () => {
  it('接了采样器:机器那一格里带上 process(rss / heap / 上限 / 起了多久)', async () => {
    const server = await serve({ machine: async () => MACHINE, processHealth: createProcessHealth({ histogram: null, log: () => {} }) })
    const state = await stateOf(server)
    const machine = state.machine as { process?: { rss_mb: number, heap_limit_mb: number, up_sec: number } }
    expect(machine.process?.rss_mb).toBeGreaterThan(0)
    expect(machine.process?.heap_limit_mb).toBeGreaterThan(0)
    expect(machine.process?.up_sec).toBeGreaterThanOrEqual(0)
    // 机器那几个数原样还在。
    expect((state.machine as { disk_pct: number }).disk_pct).toBe(40)
  })

  it('没接采样器:process 缺席;机器那格照旧', async () => {
    const server = await serve({ machine: async () => MACHINE })
    const state = await stateOf(server)
    expect(state.machine).toEqual(MACHINE)
  })

  it('机器采样没接线:整格缺席,process 不单独出现', async () => {
    const server = await serve({ processHealth: fakeHealth() })
    const state = await stateOf(server)
    expect(state).not.toHaveProperty('machine')
  })

  it('采样器 view 抛了:process 缺席,/state 照回', async () => {
    const health = fakeHealth()
    health.view = () => { throw new Error('没了') }
    const server = await serve({ machine: async () => MACHINE, processHealth: health })
    expect(await stateOf(server)).toMatchObject({ machine: MACHINE })
  })
})

describe('语音后端翻成「没在跑」那一下先问「是不是我自己慢」', () => {
  it('事件循环 p99 高于探测超时:不报 crash_restart', async () => {
    const butlerState = { running: true }
    const diag = fakeDiag()
    const server = await serve({ butler: fakeButler(butlerState), diag, processHealth: fakeHealth({ p99: 2600 }) })
    await stateOf(server)
    butlerState.running = false
    await stateOf(server)
    expect(diag.reports).toEqual([])
  })

  it('事件循环正常:照报一条 butler/crash_restart(老行为不变)', async () => {
    const butlerState = { running: true }
    const diag = fakeDiag()
    const server = await serve({ butler: fakeButler(butlerState), diag, processHealth: fakeHealth({ p99: 12 }) })
    await stateOf(server)
    butlerState.running = false
    await stateOf(server)
    expect(diag.reports).toEqual(['butler/crash_restart'])
  })

  it('没接采样器:照报(不猜)', async () => {
    const butlerState = { running: true }
    const diag = fakeDiag()
    const server = await serve({ butler: fakeButler(butlerState), diag })
    await stateOf(server)
    butlerState.running = false
    await stateOf(server)
    expect(diag.reports).toEqual(['butler/crash_restart'])
  })
})

describe('采样器挂在 1 秒节拍上', () => {
  it('tick 到了就 pump', async () => {
    const health = fakeHealth()
    await serve({ tickIntervalMs: 20, processHealth: health })
    await new Promise(resolve => setTimeout(resolve, 120))
    expect(health.pumps).toBeGreaterThanOrEqual(2)
  })
})

async function subscribe(server: WorkbenchServer): Promise<{ ws: WebSocket, snapshots: () => number, waitFirst: Promise<void> }> {
  const ws = new WebSocket(`${server.url.replace('http://', 'ws://')}/live`)
  let count = 0
  const waitFirst = new Promise<void>((resolve, reject) => {
    ws.on('message', (raw) => {
      if ((JSON.parse(String(raw)) as { kind: string }).kind === 'snapshot') count += 1
      resolve()
    })
    ws.on('error', reject)
  })
  return { ws, snapshots: () => count, waitFirst }
}

describe('/live · 广播', () => {
  it('整块快照的广播合并:连叫五次至多组两份,最后一份一定在最后一次叫之后', async () => {
    const server = await serve()
    const live = await subscribe(server)
    await live.waitFirst
    const before = live.snapshots()
    for (let i = 0; i < 5; i += 1) server.broadcastState()
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(server.liveStats().merged).toBeGreaterThanOrEqual(3)
    const got = live.snapshots() - before
    expect(got).toBeGreaterThanOrEqual(1)
    expect(got).toBeLessThanOrEqual(2)
    live.ws.close()
  })

  it('收不动的连接:发送缓冲超上限就跳过这一条,不往里堆', async () => {
    // 一份快照撑到 ~300KB(机器那格塞一段长字),对端把 socket 停住不读。
    const server = await serve({ machine: async () => ({ error: 'x'.repeat(300_000) }), liveSendBufferMaxBytes: 1 })
    const live = await subscribe(server)
    await live.waitFirst
    const socket = (live.ws as unknown as { _socket: { pause: () => void } })._socket
    socket.pause()
    for (let i = 0; i < 60; i += 1) {
      server.broadcastState()
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    expect(server.liveStats().skipped).toBeGreaterThan(0)
    live.ws.terminate()
  })
})
