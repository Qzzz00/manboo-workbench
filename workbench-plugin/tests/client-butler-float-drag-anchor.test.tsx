/**
 * 浮窗拖拽的回锚校验(2026-11-21)。
 *
 * 真机故障:悬浮球「一点就消失」——当天复现三次。落盘数据里 butler_pos 的 x 全在
 * 1~4%(屏幕最左边缘),而 y(65~71%)是对的。原因方向:按下那一刻 getBoundingClientRect
 * 量到的 left 已失效(≈0,与真实位置差了整屏),offsetX 跟着错,第一次 pointermove
 * 就把浮窗写到错误落点上——单击只要带了几个像素的微动就触发。
 *
 * 这里的回归断言:**锚点失效时,落点必须跟着「当前渲染位置 + 指针位移」走**,
 * 不许把浮窗写到与指针位移不符的地方。
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Butler, type ButlerProps } from '../src/client/Butler.tsx'

afterEach(cleanup)

function props(over: Partial<ButlerProps> = {}): ButlerProps {
  return {
    conclusions: [],
    corner: 'br',
    min: true,
    narrowForced: false,
    paused: false,
    testRinging: false,
    onToggleMin: vi.fn(),
    onMove: vi.fn(),
    onResize: vi.fn(),
    onPause: vi.fn(),
    onTestRing: vi.fn(),
    onDismissBrief: vi.fn(),
    onAsk: vi.fn(async () => true),
    onCancelWatch: vi.fn(),
    ...over,
  }
}

function fakeRect(left: number, top: number, size = 96): DOMRect {
  return {
    left, top, width: size, height: size,
    x: left, y: top,
    right: left + size, bottom: top + size,
    toJSON: () => ({}),
  } as DOMRect
}

const BALL_LABEL = /事务官.*(展开|\(点一下展开\))/

describe('浮窗拖拽回锚(2026-11-21 单击甩飞)', () => {
  it('按下时量到的位置已失效:落点按指针位移走,不甩飞', () => {
    const onMove = vi.fn()
    render(<Butler {...props({ onMove })} />)
    const ball = screen.getByLabelText(BALL_LABEL)
    const aside = ball.closest('aside')
    expect(aside).not.toBeNull()

    // 按下瞬间:rect 失效(≈0,与真实位置差整屏)——真机那三次就是这个入口。
    let rect = fakeRect(0, 0)
    const spy = vi.spyOn(aside as Element, 'getBoundingClientRect').mockImplementation(() => rect)

    fireEvent.pointerDown(ball, { clientX: 930, clientY: 650, pointerId: 1, button: 0, isPrimary: true })
    // 到第一次移动时 rect 已恢复正常(球其实在 900,600)。
    rect = fakeRect(900, 600)
    fireEvent.pointerMove(ball, { clientX: 955, clientY: 670, pointerId: 1 })

    expect(onMove).toHaveBeenCalled()
    const pos = onMove.mock.calls.at(-1)![0] as { x_pct: number, y_pct: number }
    // 球在 900/1024 ≈ 88% 一带;写错锚点时会落在 0~4%。
    expect(pos.x_pct).toBeGreaterThan(50)
    expect(pos.y_pct).toBeGreaterThan(50)
    spy.mockRestore()
  })

  it('锚点正常时:拖拽落点照旧(回锚校验不误伤正常拖拽)', () => {
    const onMove = vi.fn()
    render(<Butler {...props({ onMove })} />)
    const ball = screen.getByLabelText(BALL_LABEL)
    const aside = ball.closest('aside')
    expect(aside).not.toBeNull()

    const rect = fakeRect(900, 600)
    const spy = vi.spyOn(aside as Element, 'getBoundingClientRect').mockImplementation(() => rect)

    fireEvent.pointerDown(ball, { clientX: 930, clientY: 650, pointerId: 1, button: 0, isPrimary: true })
    fireEvent.pointerMove(ball, { clientX: 1030, clientY: 720, pointerId: 1 })

    expect(onMove).toHaveBeenCalled()
    const pos = onMove.mock.calls.at(-1)![0] as { x_pct: number, y_pct: number }
    // 900+100=1000 → 1000/1024 ≈ 97.7(被 0–95 夹住也 ≥90);锚点不被「校验」改掉。
    expect(pos.x_pct).toBeGreaterThan(85)
    expect(pos.y_pct).toBeGreaterThan(80)
    spy.mockRestore()
  })
})
