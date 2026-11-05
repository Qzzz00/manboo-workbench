/**
 * 「歇着」—— 没人在用这扇窗时少画(2026-09-25,卡 fix/evening-gaps 第 6 条)。
 *
 * 统筹 09-24 22:3x:壳停在事务官页,WebKit GPU 进程约 71%、网页进程约 45%(无风扇 MacBook Air)。
 * 真 WKWebView 里量过:待命的球 19% · 15%,执行中的环 43% · 44%,一张卡沿边走的光 13% · 69%。
 * 这里钉住:什么时候算歇着、歇着时球降到几帧、沿边光与流光停在当前帧(光还在,只是不走)、一动就醒。
 */
import '@testing-library/jest-dom/vitest'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { REST_ATTRIBUTE, REST_BLUR_MS, REST_IDLE_MS, isResting, nextRestCheck, resetRestModeForTests, restingNow, subscribeRest, useRestMode } from '../src/client/restMode.ts'
import { orbFrameRate } from '../src/client/particleScene.ts'
import { FX_STYLE } from '../src/client/fx/fxStyle.ts'

let now = 1_000_000
beforeEach(() => {
  vi.useFakeTimers()
  now = 1_000_000
  resetRestModeForTests(() => now)
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => false })
})
afterEach(() => { cleanup(); resetRestModeForTests(); vi.useRealTimers(); vi.restoreAllMocks() })

function advance(ms: number): void {
  now += ms
  act(() => { vi.advanceTimersByTime(ms) })
}

describe('什么时候算歇着(纯判断)', () => {
  const base = { hidden: false, focused: true, lastInputAt: 0, blurredAt: 0, now: 0 }
  it('页面藏起来(窗口被盖住、最小化、锁屏):马上算', () => {
    expect(isResting({ ...base, hidden: true })).toBe(true)
  })
  it('窗口在前台:两分钟没一次动静才算;下一次该看的是那一刻', () => {
    expect(isResting({ ...base, now: REST_IDLE_MS - 1 })).toBe(false)
    expect(nextRestCheck({ ...base, now: 10 })).toBe(REST_IDLE_MS)
    expect(isResting({ ...base, now: REST_IDLE_MS })).toBe(true)
  })
  it('切到别的 App:过 5 秒才算(来回切不闪)', () => {
    expect(isResting({ ...base, focused: false, blurredAt: 100, now: 100 + REST_BLUR_MS - 1 })).toBe(false)
    expect(isResting({ ...base, focused: false, blurredAt: 100, now: 100 + REST_BLUR_MS })).toBe(true)
  })
})

describe('球每秒几帧', () => {
  it('★ 待命 20、执行中 30、聆听 / 说话 / 电话 60、调参预览 60', () => {
    expect(orbFrameRate('idle', false, false)).toBe(20)
    expect(orbFrameRate('working', false, false)).toBe(30)
    for (const mode of ['listening', 'speaking', 'calling', 'acknowledging']) expect(orbFrameRate(mode, false, false)).toBe(60)
    expect(orbFrameRate('idle', true, true)).toBe(60)
  })
  it('★ 歇着:待命 10、其余 15', () => {
    expect(orbFrameRate('idle', false, true)).toBe(10)
    expect(orbFrameRate('working', false, true)).toBe(15)
    expect(orbFrameRate('speaking', false, true)).toBe(15)
  })
})

describe('开着的时候', () => {
  function Probe({ seen }: { seen: boolean[] }) {
    seen.push(useRestMode())
    return null
  }

  it('★★ 有人在用 → 不歇;两分钟没动静 → 歇(<html data-wb-rest="true">);一动鼠标当场醒', () => {
    const seen: boolean[] = []
    render(<Probe seen={seen} />)
    expect(document.documentElement.getAttribute(REST_ATTRIBUTE)).toBe('false')
    advance(REST_IDLE_MS - 1000)
    expect(restingNow()).toBe(false)
    advance(2000)
    expect(restingNow()).toBe(true)
    expect(seen.at(-1)).toBe(true)
    expect(document.documentElement.getAttribute(REST_ATTRIBUTE)).toBe('true')
    act(() => { window.dispatchEvent(new Event('pointermove')) })
    expect(restingNow()).toBe(false)
    expect(seen.at(-1)).toBe(false)
    expect(document.documentElement.getAttribute(REST_ATTRIBUTE)).toBe('false')
  })

  it('★ 切到别的 App 5 秒 → 歇;切回来 → 醒', () => {
    render(<Probe seen={[]} />)
    act(() => { window.dispatchEvent(new Event('blur')) })
    advance(REST_BLUR_MS - 500)
    expect(restingNow()).toBe(false)
    advance(1000)
    expect(restingNow()).toBe(true)
    act(() => { window.dispatchEvent(new Event('focus')) })
    expect(restingNow()).toBe(false)
  })

  it('页面藏起来 → 马上歇;露出来 → 醒', () => {
    render(<Probe seen={[]} />)
    let hidden = true
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden })
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(restingNow()).toBe(true)
    hidden = false
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(restingNow()).toBe(false)
  })

  it('没人订阅就不挂监听、不留那一格', () => {
    const off = subscribeRest(() => {})
    expect(document.documentElement.hasAttribute(REST_ATTRIBUTE)).toBe(true)
    off()
    expect(document.documentElement.hasAttribute(REST_ATTRIBUTE)).toBe(false)
  })
})

describe('歇着时光停在当前帧(样式)', () => {
  it('★ 与 border-beam 自己「滚出屏幕就停」同一组选择器:只停亮着、没在淡出的;淡入淡出照走', () => {
    expect(FX_STYLE).toContain('html[data-wb-rest=true] [data-beam][data-active]:not([data-fading]),')
    expect(FX_STYLE).toContain('html[data-wb-rest=true] [data-beam][data-active]:not([data-fading]) [data-beam-bloom]{animation-play-state:paused!important}')
    expect(FX_STYLE).not.toMatch(/data-wb-rest=true\][^{]*data-fading\]\)?\s*\{[^}]*display:none/)
  })
  it('球到卡那几条线上的流光也停', () => {
    expect(FX_STYLE).toContain('html[data-wb-rest=true] .ben-wb__task-connections .ben-wb__task-flow{animation-play-state:paused!important}')
  })
})

describe('歇着时的光(真 border-beam 挂上去)', () => {
  function matchMediaStub() {
    return () => ({ matches: false, media: '', onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false })
  }

  it('★ 歇着时光照样「亮着」(走的光停在当前帧靠样式,库自己的淡入淡出不动);外层挂着 data-fx-resting', async () => {
    vi.stubGlobal('matchMedia', matchMediaStub())
    const { FxBeam } = await import('../src/client/fx/Fx.tsx')
    const { BEAM } = await import('../src/client/fx/fxModel.ts')
    const { container } = render(<>
      <FxBeam name="card" spec={BEAM.ask} active><div>卡</div></FxBeam>
      <FxBeam name="confirm" spec={BEAM.confirm} active><div>待确认</div></FxBeam>
    </>)
    const beamOf = (name: string) => container.querySelector(`.ben-fx[data-fx=${name}] [data-beam]`)!
    advance(REST_IDLE_MS + 1000)
    expect(document.documentElement.getAttribute(REST_ATTRIBUTE)).toBe('true')
    expect(beamOf('card')).toHaveAttribute('data-active')
    expect(beamOf('confirm')).toHaveAttribute('data-active')
    expect(container.querySelector('.ben-fx[data-fx=card]')).toHaveAttribute('data-fx-resting', 'true')
    act(() => { window.dispatchEvent(new Event('pointermove')) })
    expect(container.querySelector('.ben-fx[data-fx=card]')).toHaveAttribute('data-fx-resting', 'false')
    vi.unstubAllGlobals()
  })
})
