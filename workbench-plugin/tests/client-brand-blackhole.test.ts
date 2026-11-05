/**
 * 粒子黑洞品牌视觉(2026-09-23,docs/交接-0923-黑洞主视觉与图标.md)。
 * 钉住:① 三份核心逐字节相同;② 移植的几条几何事实;③ 串联动画的状态机(分镜、时长、减少动效分支);
 * ④ 终点对齐她的核心(SwarmV4)的投影;⑤ runHandoff 不拦人、按时收场、减少动效只淡入淡出。
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  HANDOFF_BEATS, HANDOFF_MS, HANDOFF_REDUCED_MS, createBlackhole, flightPoint, flightProgress, handoffFrame,
  orbTargets, pairByAngle, placeParticle, ringLight, runHandoff, type SwarmLike,
} from '../src/client/brand/blackhole.js'
import { handoffMode } from '../src/client/brand/brandHandoff.ts'
import { heroInk, heroLayout } from '../src/client/brand/BlackholeHero.tsx'
import { SwarmV4, TUNING_DEFAULTS } from '../src/client/swarm/core.js'
import { STYLE } from '../src/client/style.ts'

const repo = resolve(__dirname, '../..')
const read = (path: string) => readFileSync(resolve(repo, path), 'utf8')

describe('三份核心逐字节相同(改 docs/brand/blackhole.js 之后要跑 sync-blackhole.mjs)', () => {
  for (const name of ['blackhole.js', 'blackhole.d.ts']) {
    it(name, () => {
      const source = read(`docs/brand/${name}`)
      expect(read(`workbench-plugin/src/client/brand/${name}`)).toBe(source)
      expect(read(`butler-app/src/brand/${name}`)).toBe(source)
    })
  }
})

describe('移植的几何', () => {
  const bh = createBlackhole()
  const p = { x: 0, y: 0, alpha: 0, size: 0, lum: 1, kind: 0 }
  it('与原型同一批粒子:26000 颗里筛掉外两层,剩 20440 颗;造一次复用', () => {
    expect(bh.count).toBe(20440)
    expect(createBlackhole()).toBe(bh)
  })
  it('黑洞里面是黑的:拱形、倒影、两翼的粒子都不进光环(r < 1.055);只有前面那片盘能挡在洞前', () => {
    for (let i = 0; i < bh.count; i += 7) {
      if (!placeParticle(bh, i, 12, p)) continue
      if (![0, 1, 4, 6].includes(p.kind)) continue // 3 快速环贴在环上;2/5 是从洞前面经过的吸积盘
      expect(Math.hypot(p.x, p.y)).toBeGreaterThanOrEqual(1.0549)
    }
  })
  it('拱形在地平线上方,倒影(echo)在下方', () => {
    let above = 0, below = 0
    for (let i = 0; i < bh.count; i++) {
      if (!placeParticle(bh, i, 12, p)) continue
      if (p.kind === 0 && p.y > 0) above++
      if (p.kind === 4 && p.y <= 0) below++
    }
    expect(above).toBeGreaterThan(3000)
    expect(below).toBeGreaterThan(100)
  })
  it('光环:上半圈满亮,下半圈只剩一点(倒影)', () => {
    expect(ringLight(1.045, .8)).toBeGreaterThan(1.3)
    expect(ringLight(1.045, -.8)).toBeLessThan(.1)
    expect(ringLight(1.3, .8)).toBeLessThan(.2)
  })
})

describe('串联状态机', () => {
  it('总时长在维护者给的 1.5–2.5 秒里', () => {
    expect(HANDOFF_MS).toBeGreaterThanOrEqual(1500)
    expect(HANDOFF_MS).toBeLessThanOrEqual(2500)
  })
  it('分镜:脱离 → 飞行 → 成形 → 结束', () => {
    expect(handoffFrame(0)).toMatchObject({ phase: 'release', heroAlpha: 1, overlayAlpha: 1, orbAlpha: 0, done: false })
    expect(handoffFrame(HANDOFF_MS * .5).phase).toBe('fly')
    expect(handoffFrame(HANDOFF_MS * .9).phase).toBe('settle')
    expect(handoffFrame(HANDOFF_MS)).toMatchObject({ phase: 'done', overlayAlpha: 0, orbAlpha: 1, done: true })
  })
  it('黑洞在脱离段淡完;真的球只在成形段淡入,单调不回头', () => {
    expect(handoffFrame(HANDOFF_MS * HANDOFF_BEATS.release).heroAlpha).toBe(0)
    expect(handoffFrame(HANDOFF_MS * (HANDOFF_BEATS.settle - .01)).orbAlpha).toBe(0)
    let last = -1
    for (let ms = 0; ms <= HANDOFF_MS; ms += 50) {
      const f = handoffFrame(ms)
      expect(f.orbAlpha).toBeGreaterThanOrEqual(last)
      expect(f.orbAlpha + f.overlayAlpha).toBeGreaterThan(.99) // 交叉淡化:任何时候总有一边看得见
      last = f.orbAlpha
    }
  })
  it('减少动效:不飞粒子,只淡出淡入,0.6 秒', () => {
    expect(HANDOFF_REDUCED_MS).toBeLessThanOrEqual(600)
    const mid = handoffFrame(300, true)
    expect(mid.phase).toBe('fade')
    expect(mid.overlayAlpha).toBe(0)
    expect(mid.orbAlpha).toBeGreaterThan(0)
    expect(handoffFrame(HANDOFF_REDUCED_MS, true)).toMatchObject({ phase: 'done', heroAlpha: 0, orbAlpha: 1, done: true })
  })
  it('每颗粒子成形前都已落到球面;里圈先走', () => {
    const n = 700
    for (const k of [0, 350, 699]) {
      expect(flightProgress(0, k, n)).toBe(0)
      expect(flightProgress(HANDOFF_BEATS.settle, k, n)).toBe(1)
    }
    expect(flightProgress(.45, 0, n)).toBeGreaterThan(flightProgress(.45, 699, n))
  })
  it('起止配对是一一对应的,按角度排,确定性', () => {
    const ring = (n: number, cx: number, r: number) => Array.from({ length: n }, (_, i) => ({ x: cx + Math.cos(i * 2.1) * r, y: 100 + Math.sin(i * 2.1) * r }))
    const sources = ring(40, 0, 50), targets = ring(40, 500, 20)
    const order = pairByAngle(sources, { x: 0, y: 100 }, targets, { x: 500, y: 100 })
    expect(new Set(order).size).toBe(40)
    expect(pairByAngle(sources, { x: 0, y: 100 }, targets, { x: 500, y: 100 })).toEqual(order)
  })
  it('贝塞尔两端就是起点和终点', () => {
    const src = { x: 10, y: 20, vx: 50, vy: 0 }, dst = { x: 300, y: 200 }, c = { x: 280, y: 180 }
    expect(flightPoint(src, dst, c, 0)).toEqual({ x: 10, y: 20 })
    const end = flightPoint(src, dst, c, 1)
    expect(end.x).toBeCloseTo(300); expect(end.y).toBeCloseTo(200)
  })
  it('终点用她的核心:投影落在球的外接圆里(R = min(W,H)·.32·bodySize,透视最多放大 4.2/3.2)', () => {
    const targets = orbTargets(SwarmV4 as unknown as new (n: number) => SwarmLike, { ...TUNING_DEFAULTS, cloudSize: 0 }, 300)
    expect(targets.count).toBe(300)
    const rect = { left: 100, top: 50, width: 400, height: 200 }
    const points = targets.project(rect), center = targets.center(rect)
    const limit = 200 * .32 * 1.1 * 4.2 / 3.2
    for (const p of points) expect(Math.hypot(p.x - center.x, p.y - center.y)).toBeLessThanOrEqual(limit + 1)
  })
  it('走哪条路:没画布什么都不做,减少动效只淡,否则飞', () => {
    expect(handoffMode({ canvas: false, reduced: false })).toBe('none')
    expect(handoffMode({ canvas: false, reduced: true })).toBe('none')
    expect(handoffMode({ canvas: true, reduced: true })).toBe('fade')
    expect(handoffMode({ canvas: true, reduced: false })).toBe('fly')
  })
})

describe('登录页黑洞的版式与颜色', () => {
  it('环半径不超过高的 27%、宽的 8%;圆心 62% 高', () => {
    expect(heroLayout(1200, 240)).toEqual({ radius: 240 * .27, cx: 600, cy: 240 * .62 })
    expect(heroLayout(400, 240).radius).toBe(32)
  })
  it('深色主题白光相加,浅色主题墨色覆盖', () => {
    expect(heroInk('rgb(240, 240, 240)')).toEqual({ ink: [255, 255, 255], additive: true })
    expect(heroInk('rgb(20, 20, 20)').additive).toBe(false)
  })
  it('样式:飞行期间只把球的画布透明度交给 --brand-handoff-orb', () => {
    expect(STYLE).toContain('html[data-brand-handoff] .ben-wb__particle-orb canvas{opacity:var(--brand-handoff-orb,1)}')
    expect(STYLE).toMatch(/\.ben-wb__brand-slot\{[^}]*pointer-events:none/)
  })
})

describe('runHandoff(浏览器里那一层)', () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })
  function stubCanvas() {
    const ctx = new Proxy({}, {
      get: (_, key) => key === 'createImageData' ? (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }) : () => {},
      set: () => true,
    })
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as unknown as CanvasRenderingContext2D)
  }
  it('不拦人:pointer-events:none;球先透明,2 秒后收场、把球交还', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame', 'performance'] })
    stubCanvas()
    const targets = orbTargets(SwarmV4 as unknown as new (n: number) => SwarmLike, { ...TUNING_DEFAULTS }, 50)
    const handle = runHandoff({ targets, count: 50, findOrb: () => null })
    const root = document.documentElement
    expect(handle.canvas.style.pointerEvents).toBe('none')
    expect(root.dataset.brandHandoff).toBe('fly')
    expect(root.style.getPropertyValue('--brand-handoff-orb')).toBe('0')
    vi.advanceTimersByTime(HANDOFF_MS * .5)
    expect(root.dataset.brandHandoff).toBe('fly')
    vi.advanceTimersByTime(HANDOFF_MS * .5 + 100)
    await handle.done
    expect(root.dataset.brandHandoff).toBeUndefined()
    expect(root.style.getPropertyValue('--brand-handoff-orb')).toBe('')
    expect(handle.canvas.isConnected).toBe(false)
  })
  it('减少动效:标成 fade,0.6 秒内收场', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame', 'performance'] })
    stubCanvas()
    const handle = runHandoff({ reduced: true, findOrb: () => null })
    expect(document.documentElement.dataset.brandHandoff).toBe('fade')
    vi.advanceTimersByTime(HANDOFF_REDUCED_MS + 50)
    await handle.done
    expect(document.documentElement.dataset.brandHandoff).toBeUndefined()
  })
  it('rAF 被节流(窗口藏起来)也按时收场', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    stubCanvas()
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 1)
    const handle = runHandoff({ reduced: true })
    vi.advanceTimersByTime(HANDOFF_REDUCED_MS + 900)
    await handle.done
    expect(document.documentElement.dataset.brandHandoff).toBeUndefined()
  })
})
