import { expect, it } from 'vitest'
import { LightCloud, SwarmRenderer, SwarmV4, alignSquare, cloudResolutionFor } from '../src/client/swarm/core.js'

it('颗粒边长按设备像素取整、最小1个设备像素,边缘落在设备像素格上;缩小到整像素时用覆盖率补偿亮度', () => {
  for (const dpr of [1, 2]) {
    for (const [px, py, size] of [[100.37, 57.9, .19], [33.3, 33.3, .8], [140.12, 90.77, 1.4], [200.5, 10.25, 2.6]] as const) {
      const square = alignSquare(px, py, size, dpr)
      expect(square.size * dpr).toBeGreaterThanOrEqual(1)
      expect(Number.isInteger(Math.round(square.size * dpr * 1e6) / 1e6)).toBe(true)
      expect(Number.isInteger(Math.round(square.x * dpr * 1e6) / 1e6)).toBe(true)
      expect(Number.isInteger(Math.round(square.y * dpr * 1e6) / 1e6)).toBe(true)
      expect(Math.abs(square.x + square.size / 2 - px)).toBeLessThanOrEqual(.5 / dpr + 1e-9)
      expect(square.coverage).toBeGreaterThan(0)
      expect(square.coverage).toBeLessThanOrEqual(1)
    }
  }
  expect(alignSquare(50, 50, .19, 1)).toMatchObject({ size: 1 })
  expect(alignSquare(50, 50, .19, 1).coverage).toBeCloseTo(.0361, 4)
  expect(alignSquare(50, 50, .19, 2)).toMatchObject({ size: .5, coverage: expect.closeTo(.1444, 4) })
  expect(alignSquare(50, 50, 1.4, 1).coverage).toBe(1)
  expect(alignSquare(50, 50, 2.6, 2).size).toBe(2.5)
})
it('光团离屏分辨率按球的设备像素直径取、16步进、64–320封顶;画质档减半', () => {
  // 完整模式 280px 球 · DPR 2:R=89.6,光团直径 233 css → 466 设备像素 → 封顶 320
  expect(cloudResolutionFor(233 * 2)).toBe(320)
  expect(cloudResolutionFor(233)).toBe(240)
  expect(cloudResolutionFor(233 * 2, .5)).toBe(240)
  expect(cloudResolutionFor(1200)).toBe(320)
  expect(cloudResolutionFor(20)).toBe(64)
  expect(cloudResolutionFor(Number.NaN)).toBe(64)
})
it('渲染器把光团分辨率、DPR柔光贴图和像素对齐接到真实绘制上', () => {
  const rects: number[][] = [], images: number[][] = []
  const ctx = { globalAlpha: 1, globalCompositeOperation: 'source-over', fillStyle: '', setTransform() {}, clearRect() {}, fillRect(...args: number[]) { rects.push([...args, this.globalAlpha]) }, drawImage(_: unknown, ...args: number[]) { images.push(args) }, createRadialGradient: () => ({ addColorStop() {} }), beginPath() {}, moveTo() {}, lineTo() {}, stroke() {} }
  const canvas = { getContext: () => ctx, getBoundingClientRect: () => ({ width: 280, height: 280 }), dataset: {} } as unknown as HTMLCanvasElement
  const glowCanvas = { width: 0, height: 0, getContext: (kind: string) => kind === "2d" ? ctx : null, addEventListener() {} }
  const created: typeof glowCanvas[] = []
  const realCreate = document.createElement.bind(document)
  document.createElement = ((tag: string) => { if (tag === 'canvas') { const c = { ...glowCanvas }; created.push(c); return c as unknown as HTMLCanvasElement } return realCreate(tag) }) as typeof document.createElement
  Object.defineProperty(window, 'devicePixelRatio', { value: 2, configurable: true })
  try {
    const swarm = new SwarmV4(200)
    swarm.configure({ particleGlow: .5 })
    const renderer = new SwarmRenderer(canvas, swarm)
    expect(renderer.dpr).toBe(2)
    const resolutions: number[] = []
    renderer.cloud.setResolution = (size: number) => { resolutions.push(size) }
    renderer.cloud.paint = () => ({} as HTMLCanvasElement)
    renderer.paint(0, true)
    expect(resolutions).toEqual([320])
    // 柔光贴图按 DPR 生成:48 css × 2
    const glow = created.find(c => c.width === 96)
    expect(glow).toBeDefined()
    for (const [, , w, h] of rects) { expect(w).toBe(h); expect(Number.isInteger(w! * 2)).toBe(true); expect(w! * 2).toBeGreaterThanOrEqual(1) }
    renderer.cloudScale = .5
    renderer.paint(0, true)
    expect(resolutions.at(-1)).toBe(240)
    const cloud = new LightCloud()
    expect(cloud.size).toBe(160)
    cloud.setResolution(240)
    expect(cloud.size).toBe(240)
    expect(cloud.canvas.width).toBe(240)
  } finally { document.createElement = realCreate }
})
