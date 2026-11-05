import '@testing-library/jest-dom/vitest'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ParticleOrb } from '../src/client/ParticleOrb.tsx'
import { createParticleSettingsStore } from '../src/client/particleSettingsStore.ts'
import { TUNING_DEFAULTS } from '../src/client/swarm/core.js'

const configured: Record<string, number>[] = [], cloudScales: number[] = []
vi.mock('../src/client/swarm/core.js', async importOriginal => {
  const core = await importOriginal<typeof import('../src/client/swarm/core.js')>()
  class SwarmV4 extends core.SwarmV4 { override configure(settings: Record<string, number>) { configured.push({ ...settings }); super.configure(settings) } }
  return { ...core, SwarmV4, SwarmRenderer: class {
    cloud = { gl: null }
    cloudScale = 1
    dpr = 1
    constructor(private canvas: HTMLCanvasElement) {}
    resize() {}
    setColor() {}
    paint() { cloudScales.push(this.cloudScale); this.canvas.dataset.paints = String(Number(this.canvas.dataset.paints ?? 0) + 1) }
  } }
})
const values = new Map<string, string>()
const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) } }
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); values.clear(); configured.length = 0; cloudScales.length = 0 })
function host() {
  const frames = new Map<number, FrameRequestCallback>(); let id = 0
  vi.stubGlobal('CanvasRenderingContext2D', class {})
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({} as CanvasRenderingContext2D)
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++id, callback); return id })
  vi.stubGlobal('cancelAnimationFrame', (frame: number) => { frames.delete(frame) })
  const media = new EventTarget() as EventTarget & { matches: boolean }; media.matches = false
  vi.stubGlobal('matchMedia', () => media)
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  // 窗口在前台(restMode.ts 据此判「有人在用」);歇着那几条在 client-rest-mode.test.tsx。
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
  let at = 0
  const run = (interval: number, count: number) => { for (let i = 0; i < count; i++) { at += interval; const [key, cb] = [...frames.entries()][0]!; frames.delete(key); act(() => cb(at)) } }
  return { frames, run }
}
it('待命20帧、执行中30帧、其他状态60帧;卡顿两秒自动降档并只改有效值;性能模式锁最低档;光团分辨率随档位减半', () => {
  const { run } = host()
  values.set('butler-swarm-v4:tuning', JSON.stringify({ kind: 'butler-swarm-v4', version: 1, settings: { count: 6800, particleGlow: .4 }, svg: '', fill: false }))
  const store = createParticleSettingsStore(storage)
  const tree = (mode: 'idle' | 'listening' | 'working') => <ParticleOrb mode={mode} notice="neutral" visible settings={store.getSnapshot().preset.settings} store={store} />
  const view = render(tree('idle')), canvas = view.container.querySelector('canvas')!
  // 2026-09-25(卡 fix/evening-gaps 第 6 条):待命从 30 帧降到 20 帧(真 WKWebView 里量过,开销与帧数成正比)。
  expect(canvas.dataset.frameRate).toBe('20')
  expect(configured.at(-1)!.count).toBe(6800)
  const before = Number(canvas.dataset.paints ?? 0)
  run(1000 / 60, 60)
  const drawn = Number(canvas.dataset.paints) - before
  expect(drawn).toBeGreaterThanOrEqual(19); expect(drawn).toBeLessThanOrEqual(21)
  expect(store.getSnapshot().quality.tier).toBe(0)
  // 三秒 30ms 间隔(33fps):降一档,渲染器收到 3400,用户参数仍是 6800
  run(30, 100)
  expect(store.getSnapshot().quality.tier).toBe(1)
  view.rerender(tree('idle'))
  expect(configured.at(-1)!.count).toBe(3400)
  expect(configured.at(-1)!.particleGlow).toBe(.4)
  expect(store.getSnapshot().preset.settings.count).toBe(6800)
  expect(canvas.dataset.quality).toBe('1')
  // 继续卡 4.2 秒:每 2 秒只降一档,到 3 档时光团分辨率减半
  run(30, 140)
  expect(store.getSnapshot().quality.tier).toBe(3)
  view.rerender(tree('idle'))
  run(1000 / 60, 4)
  expect(cloudScales.at(-1)).toBe(.5)
  // 流畅不满 30 秒(这里 6.7 秒)不升回
  run(1000 / 60, 400)
  expect(store.getSnapshot().quality.tier).toBe(3)
  // 聆听/在办回 60 帧
  view.rerender(tree('listening'))
  expect(canvas.dataset.frameRate).toBe('60')
  const mark = Number(canvas.dataset.paints)
  run(1000 / 60, 60)
  expect(Number(canvas.dataset.paints) - mark).toBe(60)
  view.rerender(tree('working'))
  expect(canvas.dataset.frameRate).toBe('30')
  // 性能模式:立即最低档,采样不再动
  act(() => store.setPerformanceMode(true))
  view.rerender(tree('idle'))
  expect(configured.at(-1)).toMatchObject({ count: 1700, particleGlow: 0 })
  run(30, 300)
  expect(store.getSnapshot().quality.tier).toBe(4)
  act(() => store.setPerformanceMode(false))
  view.rerender(tree('idle'))
  expect(configured.at(-1)!.count).toBe(6800)
  view.unmount()
})
it('?profile=1 时把每 5 秒的 rAF 采样写到 canvas 的 data-profile', () => {
  const { run } = host()
  vi.stubGlobal('location', { ...window.location, search: '?profile=1' })
  const store = createParticleSettingsStore(storage)
  const view = render(<ParticleOrb mode="listening" notice="neutral" visible settings={TUNING_DEFAULTS} store={store} />), canvas = view.container.querySelector('canvas')!
  run(1000 / 60, 400)
  const report = JSON.parse(canvas.dataset.profile!) as { frames: number; intervalMean: number; longFrames: number }
  expect(report.frames).toBeGreaterThan(250)
  expect(report.intervalMean).toBeCloseTo(16.67, 1)
  expect(report.longFrames).toBe(0)
  view.unmount()
})
it('降档后连续30秒流畅自动升回;降档时球旁边闪一句「机器忙,先省着画」,几秒后自己消失', () => {
  const { run } = host()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  values.set('butler-swarm-v4:tuning', JSON.stringify({ kind: 'butler-swarm-v4', version: 1, settings: { count: 4000 }, svg: '', fill: false }))
  const store = createParticleSettingsStore(storage)
  const tree = () => <ParticleOrb mode="idle" notice="neutral" visible settings={store.getSnapshot().preset.settings} store={store} />
  const view = render(tree()), canvas = view.container.querySelector('canvas')!
  expect(view.queryByText('机器忙,先省着画')).toBeNull()
  // 1 秒预热 + 2 秒评估窗,30ms 间隔(33fps):降一档,提示闪一下
  run(30, 120)
  expect(store.getSnapshot().quality.tier).toBe(1)
  view.rerender(tree())
  expect(configured.at(-1)!.count).toBe(2000)
  expect(view.getByText('机器忙,先省着画')).toBeInTheDocument()
  // 不占位:提示是绝对定位的浮层,不是弹窗
  expect(view.getByText('机器忙,先省着画').closest('.ben-wb__particle-orb')).toBe(view.container.querySelector('.ben-wb__particle-orb'))
  act(() => { vi.advanceTimersByTime(5000) })
  expect(view.queryByText('机器忙,先省着画')).toBeNull()
  // 35 秒流畅:升回完整,渲染器拿回 4000,用户参数一直是 4000
  run(1000 / 60, 2100)
  expect(store.getSnapshot().quality.tier).toBe(0)
  view.rerender(tree())
  expect(configured.at(-1)!.count).toBe(4000)
  expect(store.getSnapshot().preset.settings.count).toBe(4000)
  expect(canvas.dataset.quality).toBe('0')
  // 升回不吭声
  expect(view.queryByText('机器忙,先省着画')).toBeNull()
  view.unmount()
})
it('「恢复完整画质」立即生效:球马上拿回用户参数,评估从头再来', () => {
  const { run } = host()
  values.set('butler-swarm-v4:tuning', JSON.stringify({ kind: 'butler-swarm-v4', version: 1, settings: { count: 4000 }, svg: '', fill: false }))
  const store = createParticleSettingsStore(storage)
  const tree = () => <ParticleOrb mode="idle" notice="neutral" visible settings={store.getSnapshot().preset.settings} store={store} />
  const view = render(tree()), canvas = view.container.querySelector('canvas')!
  run(30, 300)
  expect(store.getSnapshot().quality.tier).toBeGreaterThanOrEqual(2)
  act(() => { store.restoreQuality() })
  view.rerender(tree())
  expect(store.getSnapshot().quality).toEqual({ tier: 0, performanceMode: false })
  expect(configured.at(-1)!.count).toBe(4000)
  expect(canvas.dataset.quality).toBe('0')
  // 重置评估:再卡起来要重新走满一档的 2 秒,不会立刻掉回原来的档
  run(30, 60)
  expect(store.getSnapshot().quality.tier).toBe(0)
  run(30, 100)
  expect(store.getSnapshot().quality.tier).toBe(1)
  view.unmount()
})
