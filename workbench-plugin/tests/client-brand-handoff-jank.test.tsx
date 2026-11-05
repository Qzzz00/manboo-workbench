/**
 * 串联去卡顿(2026-09-24,维护者真机:「无论是电脑端还是手机端,粒子从黑洞变成球的过程都是先卡住的」)。
 * 过程与修前 / 修后数据:docs/交接-0924-串联动画去卡顿.md。
 *
 * 钉住能测的调度逻辑:
 *   ① 飞几颗按登录页黑洞的实际帧耗时降级;
 *   ② 终点核心可以分片预热,热完与一口气热的一模一样;
 *   ③ 候选:空闲时挑好的那批与现挑的结果一样,而且只挑画布上真画出来的那几颗;
 *   ④ 让路:串联起步期间新屏的重初始化往后排,每个空闲时间片放一件;串联结束一定放行;
 *   ⑤ 飞行前 0.2 秒不找球(不翻 DOM、不量尺寸);预备好的飞行层画布直接用;
 *   ⑥ 粒子球(ParticleOrb)在串联起步期间不初始化渲染器,放行之后才初始化;
 *   ⑦ 登录页黑洞:串联开始后不再每帧画(那块画布已经拷进飞行层、藏起来了)。
 */
import '@testing-library/jest-dom/vitest'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  adaptiveHandoffCount, afterHandoffLaunch, BlackholePainter, candidateJob, HANDOFF_DEFER_UNTIL, HANDOFF_MS,
  handoffLaunching, orbTargets, prepareHandoff, runHandoff, type SwarmLike,
} from '../src/client/brand/blackhole.js'
import { ParticleOrb } from '../src/client/ParticleOrb.tsx'
import { SwarmV4, TUNING_DEFAULTS } from '../src/client/swarm/core.js'
import { STYLE } from '../src/client/style.ts'

const Swarm = SwarmV4 as unknown as new (n: number) => SwarmLike

afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks() })

function stubCanvas() {
  const ctx = new Proxy({}, {
    get: (_, key) => key === 'createImageData' ? (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }) : () => {},
    set: () => true,
  })
  return vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as unknown as CanvasRenderingContext2D)
}

/** 不碰 DOM 的画家(只用它的挑粒子那几样)。 */
function offscreenPainter(stride = 3): BlackholePainter {
  const painter = new BlackholePainter({ getContext: () => ({}) } as unknown as HTMLCanvasElement, { stride })
  painter.view = { width: 800, height: 216, dpr: 1, radius: 58, cx: 400, cy: 134 }
  return painter
}

describe('① 飞几颗(adaptiveHandoffCount)', () => {
  it('画一帧 ≤ 8ms 照原数;≥ 24ms 只飞一半;中间线性、取整到 10', () => {
    expect(adaptiveHandoffCount(700, 0)).toBe(700)
    expect(adaptiveHandoffCount(700, 8)).toBe(700)
    expect(adaptiveHandoffCount(700, 40)).toBe(350)
    const mid = adaptiveHandoffCount(700, 16)
    expect(mid).toBeLessThan(700); expect(mid).toBeGreaterThan(350); expect(mid % 10).toBe(0)
    expect(adaptiveHandoffCount(480, Number.NaN)).toBe(480)
  })
})

describe('② 终点核心分片预热', () => {
  it('lazy:先不热;没时间片就不动;热完与一口气热的投影逐点相同', () => {
    const eager = orbTargets(Swarm, { ...TUNING_DEFAULTS }, 120)
    const lazy = orbTargets(Swarm, { ...TUNING_DEFAULTS }, 120, { lazy: true })
    expect(lazy.warmed).toBe(false)
    expect(lazy.warm(() => false)).toBe(false)
    let slices = 0
    while (!lazy.warm(() => slices++ % 7 !== 6)) { /* 每片 6 步 */ }
    expect(lazy.warmed).toBe(true)
    const rect = { left: 0, top: 0, width: 300, height: 300 }
    expect(lazy.project(rect)).toEqual(eager.project(rect))
  })
})

describe('③ 候选', () => {
  it('只挑画布上真画出来的那几颗(每 stride 颗一颗)', () => {
    const painter = offscreenPainter(3)
    const picked = painter.snapshot(15, 300)
    expect(picked.length).toBe(300)
    expect(picked.every(p => p.i % 3 === 0)).toBe(true)
  })
  it('空闲时分片挑好的候选,与当场全扫挑出来的是同一批(同一刻)', () => {
    const painter = offscreenPainter(3)
    const job = candidateJob(painter, 15, 300)
    let step = job.next(), yields = 0
    while (!step.done) { yields++; step = job.next() }
    expect(yields).toBeGreaterThan(5) // 真的分了片
    expect(painter.snapshot(15, 300, step.value)).toEqual(painter.snapshot(15, 300))
  })
  it('候选不够(粒子流走了)就从全体里补齐', () => {
    const painter = offscreenPainter(3)
    expect(painter.snapshot(15, 300, [0, 3, 6]).length).toBe(300)
  })
})

describe('④ 让路(afterHandoffLaunch)', () => {
  it('不在串联里:当场就做', () => {
    const done = vi.fn()
    afterHandoffLaunch(done)
    expect(done).toHaveBeenCalledTimes(1)
  })

  it('串联起步期间往后排;到 HANDOFF_DEFER_UNTIL 之后每个空闲时间片放一件;取消了的不做', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame', 'performance'] })
    stubCanvas()
    const handle = runHandoff({ targets: orbTargets(Swarm, { ...TUNING_DEFAULTS }, 50), count: 50, findOrb: () => null })
    expect(handoffLaunching()).toBe(true)
    const a = vi.fn(), b = vi.fn(), c = vi.fn()
    afterHandoffLaunch(a)
    const cancel = afterHandoffLaunch(b)
    afterHandoffLaunch(c)
    cancel()
    vi.advanceTimersByTime(HANDOFF_MS * HANDOFF_DEFER_UNTIL - 20)
    expect(a).not.toHaveBeenCalled()
    vi.advanceTimersByTime(20 + 17)
    expect(a).toHaveBeenCalledTimes(1)
    expect(c).not.toHaveBeenCalled() // 一个时间片只放一件
    vi.advanceTimersByTime(40)
    expect(c).toHaveBeenCalledTimes(1)
    expect(b).not.toHaveBeenCalled()
    expect(handoffLaunching()).toBe(false)
    handle.cancel()
    await handle.done
  })

  it('串联提前收场(取消)也放行,不把新屏的球永远压着', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame', 'performance'] })
    stubCanvas()
    const handle = runHandoff({ reduced: false, targets: orbTargets(Swarm, { ...TUNING_DEFAULTS }, 20), count: 20, findOrb: () => null })
    const later = vi.fn()
    afterHandoffLaunch(later)
    handle.cancel()
    vi.advanceTimersByTime(50)
    expect(later).toHaveBeenCalledTimes(1)
  })

  it('减少动效(只淡 0.6 秒):不让路', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame', 'performance'] })
    stubCanvas()
    const handle = runHandoff({ reduced: true, findOrb: () => null })
    const later = vi.fn()
    afterHandoffLaunch(later)
    vi.advanceTimersByTime(20)
    expect(later).toHaveBeenCalledTimes(1)
    handle.cancel()
  })
})

describe('⑤ 飞行层', () => {
  it('飞行前 0.2 秒不找球(不翻 DOM、不量尺寸);粒子起飞之后才找', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame', 'performance'] })
    stubCanvas()
    const findOrb = vi.fn(() => null)
    const handle = runHandoff({ targets: orbTargets(Swarm, { ...TUNING_DEFAULTS }, 50), count: 50, findOrb })
    vi.advanceTimersByTime(150)
    expect(findOrb).not.toHaveBeenCalled()
    vi.advanceTimersByTime(250)
    expect(findOrb).toHaveBeenCalled()
    handle.cancel()
    await handle.done
  })

  it('找到球之后一直用它,不每帧再翻一遍 DOM', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame', 'performance'] })
    stubCanvas()
    const orb = document.createElement('canvas')
    document.body.appendChild(orb)
    const findOrb = vi.fn(() => orb)
    const ink = vi.fn(() => [255, 255, 255] as [number, number, number])
    const handle = runHandoff({ targets: orbTargets(Swarm, { ...TUNING_DEFAULTS }, 50), count: 50, findOrb, ink })
    vi.advanceTimersByTime(1200)
    expect(findOrb).toHaveBeenCalledTimes(1)
    expect(ink).toHaveBeenCalledTimes(1) // 颜色找到球时取一次,不每帧 getComputedStyle
    handle.cancel()
    orb.remove()
  })

  it('空闲时预备好的飞行层画布直接挂上去用;预热、候选也在空闲里做完', async () => {
    stubCanvas()
    const painter = offscreenPainter(3)
    const idleWindow = Object.assign(Object.create(window), {
      requestIdleCallback: (cb: (d: { timeRemaining(): number }) => void) => { cb({ timeRemaining: () => 50 }); return 1 },
      cancelIdleCallback: () => {},
      document, innerWidth: window.innerWidth, innerHeight: window.innerHeight, devicePixelRatio: 1,
    }) as Window
    const prepared = prepareHandoff({ SwarmClass: Swarm, settings: { ...TUNING_DEFAULTS }, count: 100, painter: () => painter, clock: () => 15, window: idleWindow, refreshMs: 60_000 })
    for (let k = 0; k < 50 && prepared.candidates() === null; k++) await new Promise(resolve => setTimeout(resolve, 5))
    expect(prepared.targets()?.warmed).toBe(true)
    expect(prepared.candidates()?.length).toBe(150)
    const surface = prepared.surface()
    expect(surface).not.toBeNull()
    const handle = runHandoff({ targets: prepared.targets()!, candidates: prepared.candidates(), surface, count: 100, findOrb: () => null })
    expect(handle.canvas).toBe(surface!.canvas)
    expect(handle.canvas.isConnected).toBe(true)
    handle.cancel()
    prepared.cancel()
    await handle.done
    expect(handle.canvas.isConnected).toBe(false)
  })
})

describe('⑥ 粒子球让路', () => {
  it('串联起步期间只挂画布、不初始化渲染器;放行之后才初始化', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame', 'performance'] })
    stubCanvas()
    const handle = runHandoff({ targets: orbTargets(Swarm, { ...TUNING_DEFAULTS }, 20), count: 20, findOrb: () => null })
    const { container } = render(<ParticleOrb mode="idle" notice="neutral" visible settings={{ ...TUNING_DEFAULTS }} />)
    // jsdom 没有 CanvasRenderingContext2D:一初始化就会退回声纹球 —— 所以「画布还在」= 还没初始化。
    expect(container.querySelector('.ben-wb__particle-orb canvas')).not.toBeNull()
    await act(async () => { vi.advanceTimersByTime(HANDOFF_MS * HANDOFF_DEFER_UNTIL + 40) })
    expect(container.querySelector('.ben-wb__particle-orb canvas')).toBeNull()
    handle.cancel()
  })

  it('不在串联里:当场初始化(与以前一样)', () => {
    const { container } = render(<ParticleOrb mode="idle" notice="neutral" visible settings={{ ...TUNING_DEFAULTS }} />)
    expect(container.querySelector('.ben-wb__particle-orb canvas')).toBeNull()
  })
})

describe('⑦ 登录页黑洞', () => {
  it('串联开始后那块画布藏起来(已经拷进飞行层)', () => {
    expect(STYLE).toContain('html[data-brand-handoff] .ben-wb__brand-hero canvas{visibility:hidden}')
  })
})
