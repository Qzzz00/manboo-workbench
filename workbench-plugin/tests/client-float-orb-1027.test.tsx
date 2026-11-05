// 悬浮球带状态(2026-10-27,合并稿 5.1;事务官入口只剩悬浮球)。球只读服务端那一格:/state.orb、waiting、running;不自己推算。
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkbenchState } from '../src/protocol.ts'
import { floatOrbView } from '../src/client/floatOrb.ts'
import { Butler } from '../src/client/Butler.tsx'

afterEach(cleanup)
const base = (patch: Partial<WorkbenchState> = {}): WorkbenchState => ({ agents: [], sessions: [], quota: {}, now: '2026-10-27T10:00:00Z', stale: false, ...patch }) as WorkbenchState
const orb = (patch: Record<string, unknown> = {}) => ({ notice: 'neutral', working: false, blocked: 0, active_failure: false, waiting: false, calling: false, ...patch })
const waiting = (n: number) => ({ count: n, items: Array.from({ length: n }, (_, i) => ({ key: `question:${i}`, kind: 'question', text: `第${i + 1}问` })) })

describe('球的状态(纯函数,只读服务端那一格)', () => {
  it('在办 → 执行形态;通话 → 电话形态;提示色照 notice', () => {
    expect(floatOrbView(base({ orb: orb({ working: true }) as never })).mode).toBe('working')
    expect(floatOrbView(base({ orb: orb({ calling: true, notice: 'confirmation' }) as never })).mode).toBe('calling')
    expect(floatOrbView(base({ orb: orb({ notice: 'failed', working: true }) as never })).notice).toBe('failed')
    expect(floatOrbView(base({ orb: orb() as never })).mode).toBe('idle')
  })
  it('等你几件、几问照 waiting;受阻、回复、刚办完照 orb', () => {
    const view = floatOrbView(base({ orb: orb({ notice: 'confirmation', waiting: true, blocked: 2, answer: true, fresh_result: true }) as never, waiting: waiting(3) as never }))
    expect(view.waiting).toBe(3)
    expect(view.lines).toEqual(['第1问', '第2问', '第3问'])
    expect(view.blocked).toBe(2)
    expect(view.answer).toBe(true)
    expect(view.fresh).toBe(true)
  })
  it('掉线:保留上次形态,不出琥珀与角标,标明是上次状态', () => {
    const view = floatOrbView(base({ stale: true, orb: orb({ working: true, notice: 'confirmation' }) as never, waiting: waiting(2) as never }))
    expect(view.stale).toBe(true)
    expect(view.notice).toBe('neutral')
    expect(view.waiting).toBe(0)
  })
  it('老服务端没有 orb 那一格:待命、不编数', () => {
    const view = floatOrbView(base())
    expect(view.mode).toBe('idle')
    expect(view.running).toBeUndefined()
  })
})

const props = {
  conclusions: [], corner: 'br' as const, min: true, narrowForced: false, paused: false, testRinging: false,
  onToggleMin: () => {}, onMove: () => {}, onResize: () => {}, onPause: () => {}, onTestRing: () => {}, onDismissBrief: () => {},
  onAsk: async () => true, onCancelWatch: () => {},
}
describe('收起的球', () => {
  it('角标写等你几件,点角标摊开;两颗小点;读屏名说状态', () => {
    const onOpenAsks = vi.fn()
    const view = floatOrbView(base({ orb: orb({ notice: 'confirmation', waiting: true, answer: true, fresh_result: true }) as never, waiting: waiting(4) as never }))
    render(<Butler {...props} orb={view} onOpenAsks={onOpenAsks} />)
    fireEvent.click(screen.getByRole('button', { name: '等你 4 件,点一下摊开' }))
    expect(onOpenAsks).toHaveBeenCalled()
    expect(screen.getByTitle('有一条没看的回复')).toBeInTheDocument()
    expect(screen.getByTitle('有刚办完的结果没看')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^事务官:等你回话/ })).toBeInTheDocument()
  })
  it('悬停卡写执行 · 等你 · 受阻与等你清单', () => {
    const view = floatOrbView(base({ orb: orb({ working: true, blocked: 1, notice: 'confirmation', waiting: true }) as never, waiting: waiting(2) as never, running: { scope: 'classified_business_tasks', count: 3, observed_count: 3, items: [], excluded: [] } as never }))
    render(<Butler {...props} orb={view} />)
    const card = screen.getByRole('tooltip')
    expect(card).toHaveTextContent('执行 3 · 等你 2 · 受阻 1')
    expect(card).toHaveTextContent('第1问')
  })
  it('已暂停写明只停响铃与采集', () => {
    render(<Butler {...props} paused orb={floatOrbView(base({ orb: orb() as never }))} />)
    expect(screen.getByRole('tooltip')).toHaveTextContent('已暂停:只停响铃与采集,不停 Agent')
  })
})
