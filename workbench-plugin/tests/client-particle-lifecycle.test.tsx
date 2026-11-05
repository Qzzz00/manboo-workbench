import '@testing-library/jest-dom/vitest'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ParticleOrb } from '../src/client/ParticleOrb.tsx'
import { TUNING_DEFAULTS } from '../src/client/swarm/core.js'

// Canvas/WebGL are absent in jsdom. Keep real dynamics; replace only the unavailable raster backend.
vi.mock('../src/client/swarm/core.js', async importOriginal => {
  const core = await importOriginal<typeof import('../src/client/swarm/core.js')>()
  return { ...core, SwarmRenderer: class {
    cloud = { gl: null }
    constructor(private canvas: HTMLCanvasElement) {}
    resize() {}
    setColor() {}
    paint() { this.canvas.dataset.paints = String(Number(this.canvas.dataset.paints ?? 0) + 1) }
  } }
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
it('真实组件在visible、document.hidden、隐藏祖先、reduced-motion间暂停恢复；卸载清理观察器和RAF', async () => {
  const frames = new Map<number, FrameRequestCallback>(); let id = 0
  vi.stubGlobal('CanvasRenderingContext2D', class {})
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({} as CanvasRenderingContext2D)
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++id, callback); return id })
  vi.stubGlobal('cancelAnimationFrame', (frame: number) => { frames.delete(frame) })
  const media = new EventTarget() as EventTarget & { matches: boolean }
  media.matches = false
  vi.stubGlobal('matchMedia', () => media)
  const disconnect = vi.fn()
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect = disconnect })
  let hidden = false
  vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden)
  const tree = (visible = true, ancestorHidden = false) => <div hidden={ancestorHidden}><ParticleOrb mode="idle" notice="neutral" visible={visible} settings={TUNING_DEFAULTS} /></div>
  const view = render(tree()), canvas = view.container.querySelector('canvas')!
  expect(canvas.dataset.running).toBe('true')
  expect(frames.size).toBe(1)
  view.rerender(tree(false))
  expect(canvas.dataset.running).toBe('false'); expect(frames.size).toBe(0)
  view.rerender(tree())
  expect(view.container.querySelector('canvas')).toBe(canvas)
  hidden = true; act(() => document.dispatchEvent(new Event('visibilitychange')))
  expect(frames.size).toBe(0)
  hidden = false; act(() => document.dispatchEvent(new Event('visibilitychange')))
  expect(frames.size).toBe(1)
  await act(async () => { view.rerender(tree(true, true)) })
  expect(canvas.dataset.running).toBe('false'); expect(frames.size).toBe(0)
  await act(async () => { view.rerender(tree()) })
  media.matches = true; act(() => media.dispatchEvent(new Event('change')))
  expect(frames.size).toBe(0); expect(Number(canvas.dataset.paints)).toBeGreaterThan(0)
  media.matches = false; act(() => media.dispatchEvent(new Event('change')))
  expect(frames.size).toBe(1)
  view.unmount()
  expect(frames.size).toBe(0); expect(disconnect).toHaveBeenCalledTimes(1)
  act(() => document.dispatchEvent(new Event('visibilitychange')))
  expect(frames.size).toBe(0)
})
