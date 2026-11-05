/**
 * 串联第五轮(2026-09-24,维护者 0.2.79 真机「黑洞→粒子球还是卡」):
 *   ① 打点:3 秒帧间隔摘要(纯函数)+ 每次串联交一份;
 *   ② 起跑闸门:连着两帧顺了才开始计时,等满还没顺 → 降级;
 *   ③ 起步超标(首帧太晚 / 起步段一帧太长)→ 退成淡入淡出,不飞粒子;登录页黑洞本来就慢 → 一开始就不飞。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEGRADE_GAP_MS, GATE_MAX_MS, handoffPlan, lastHandoffPerf, onHandoffPerf, orbTargets, PERF_WINDOW_MS, runHandoff,
  SLOW_PAINT_MS, summarizeFrames, type HandoffPerf, type SwarmLike,
} from '../src/client/brand/blackhole.js'
import { SwarmV4, TUNING_DEFAULTS } from '../src/client/swarm/core.js'

const Swarm = SwarmV4 as unknown as new (n: number) => SwarmLike
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); document.documentElement.removeAttribute('data-brand-handoff') })

function stubCanvas() {
  const ctx = new Proxy({}, {
    get: (_, key) => key === 'createImageData' ? (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }) : () => {},
    set: () => true,
  })
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as unknown as CanvasRenderingContext2D)
}

/** 手摇的帧:frame(ms) = 时钟往前走 ms,再把排着的 rAF 全跑一遍。 */
function manualFrames() {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  let clock = 1000, id = 0
  let queue: [number, FrameRequestCallback][] = []
  vi.spyOn(performance, 'now').mockImplementation(() => clock)
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(cb => { queue.push([++id, cb]); return id })
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(n => { queue = queue.filter(([k]) => k !== n) })
  return {
    frame(ms: number) { clock += ms; const run = queue; queue = []; for (const [, cb] of run) cb(clock) },
    frames(n: number, ms = 16) { for (let i = 0; i < n; i++) this.frame(ms) },
  }
}

describe('① 打点摘要', () => {
  it('summarizeFrames:帧数、最长、p95、中位、>50 / >100 次数', () => {
    const s = summarizeFrames([16, 17, 16, 60, 16, 130, 16, 16, 16, 16])
    expect(s).toEqual({ frames: 10, maxGapMs: 130, p95GapMs: 130, medianGapMs: 16, over50: 2, over100: 1 })
    expect(summarizeFrames([])).toMatchObject({ frames: 0, maxGapMs: 0 })
  })
  it('handoffPlan:登录页黑洞一帧 ≥ SLOW_PAINT_MS 就不飞', () => {
    expect(handoffPlan(0)).toBe('fly')
    expect(handoffPlan(SLOW_PAINT_MS - 1)).toBe('fly')
    expect(handoffPlan(SLOW_PAINT_MS)).toBe('fade')
  })
})

describe('② ③ 闸门与降级', () => {
  const start = (extra: Record<string, unknown> = {}) => runHandoff({ targets: orbTargets(Swarm, { ...TUNING_DEFAULTS }, 30), count: 30, findOrb: () => null, side: 'desk', ...extra })

  it('顺的机器:闸门两帧就开,飞粒子;3 秒后交一份打点(mode fly、没降级)', () => {
    stubCanvas()
    const f = manualFrames()
    const got: HandoffPerf[] = []
    const stop = onHandoffPerf(r => got.push(r))
    const handle = start({ gate: true })
    f.frames(3)
    expect(handle.perf.gateMs).toBeGreaterThan(0)
    expect(handle.perf.gateMs).toBeLessThan(80)
    expect(document.documentElement.dataset.brandHandoff).toBe('fly')
    f.frames(Math.ceil(PERF_WINDOW_MS / 16) + 2)
    stop()
    expect(got).toHaveLength(1)
    expect(got[0]).toMatchObject({ side: 'desk', mode: 'fly', degraded: false, count: 30, over100: 0, longtasks: null })
    expect(got[0]!.frames).toBeGreaterThan(150)
    expect(lastHandoffPerf()).toBe(got[0])
  })

  it('新屏挂载那一下(闸门里一帧 200ms):不计时,等顺了再起跑,不降级', () => {
    stubCanvas()
    const f = manualFrames()
    const handle = start({ gate: true })
    f.frame(16); f.frame(200); f.frame(16)
    expect(handle.perf.gateMs).toBe(0) // 还没开
    f.frame(16)
    expect(handle.perf.gateMs).toBeGreaterThan(200)
    expect(handle.perf.degraded).toBe(false)
    handle.cancel()
  })

  it('一直不顺(闸门等满 GATE_MAX_MS):降级成淡入淡出,不飞粒子', () => {
    stubCanvas()
    const f = manualFrames()
    const handle = start({ gate: true })
    for (let t = 0; t <= GATE_MAX_MS + 100; t += 60) f.frame(60)
    expect(handle.perf).toMatchObject({ degraded: true, degradeReason: 'gate-timeout' })
    handle.cancel()
    expect(handle.perf.mode).toBe('degraded')
  })

  it('不开闸门时:首帧太晚 → first-frame 降级;起步段一帧太长 → slow-frame 降级;之后的慢帧不管', () => {
    stubCanvas()
    const f = manualFrames()
    let handle = start()
    f.frame(DEGRADE_GAP_MS + 30)
    expect(handle.perf).toMatchObject({ degraded: true, degradeReason: 'first-frame' })
    handle.cancel()

    handle = start()
    f.frame(16); f.frame(16); f.frame(DEGRADE_GAP_MS + 10)
    expect(handle.perf).toMatchObject({ degraded: true, degradeReason: 'slow-frame' })
    handle.cancel()

    handle = start()
    f.frames(40) // 640ms,已过起步段
    f.frame(DEGRADE_GAP_MS + 50)
    expect(handle.perf.degraded).toBe(false)
    handle.cancel()
  })

  it('降级后按淡入淡出的时长收场,球淡入到满', async () => {
    stubCanvas()
    const f = manualFrames()
    const handle = start()
    f.frame(DEGRADE_GAP_MS + 30)
    f.frames(45) // 720ms > 淡入淡出 600ms
    await handle.done
    expect(document.documentElement.dataset.brandHandoff).toBeUndefined()
  })
})

describe('④ 电脑回报', () => {
  it('reportHandoffPerf:POST /perf/handoff 带 cookie;失败不抛', async () => {
    const { reportHandoffPerf } = await import('../src/client/brand/brandHandoff.ts')
    const calls: [string, RequestInit][] = []
    const ok = (async (url: string, init: RequestInit) => { calls.push([url, init]); return new Response('{}') }) as unknown as typeof fetch
    await reportHandoffPerf('http://127.0.0.1:8791', { side: 'desk', mode: 'fly' } as HandoffPerf, ok)
    expect(calls[0]![0]).toBe('http://127.0.0.1:8791/perf/handoff')
    expect(calls[0]![1]).toMatchObject({ method: 'POST', credentials: 'include' })
    const bad = (async () => { throw new Error('断了') }) as unknown as typeof fetch
    await expect(reportHandoffPerf('http://x', { side: 'desk' } as HandoffPerf, bad)).resolves.toBeUndefined()
  })
})
