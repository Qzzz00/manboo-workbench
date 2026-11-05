/**
 * 事务官浮窗的「在盯着的事」一栏(2026-09-09 哨兵)。
 *
 * 这一栏是哨兵在界面上的**唯一常驻落点**:触发本身走会话/铃那条既有通道(黄点),
 * 而"我现在在盯哪些事、最近一次变化是什么、不想盯了怎么取消"只有这里能看见。
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Butler, type ButlerProps } from '../src/client/Butler.tsx'
import type { SentinelView } from '../src/protocol.ts'

afterEach(cleanup)

function props(over: Partial<ButlerProps> = {}): ButlerProps {
  return {
    conclusions: [],
    corner: 'br',
    min: false,
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

const SENTINEL: SentinelView = {
  watches: [
    {
      id: 'w1',
      kind: 'port',
      target: '127.0.0.1:3080',
      note: 'DSH 掉了要知道',
      interval_sec: 60,
      cooldown_sec: 600,
      created_at: '2026-09-09T01:00:00.000Z',
      fires: 1,
      last_change: '通 → 不通',
    },
  ],
}

describe('「在盯着的事」一栏', () => {
  it('★列出监视项:那句 note、盯的是什么、最近一次变化', () => {
    render(<Butler {...props({ sentinel: SENTINEL })} />)
    expect(screen.getByText('在盯着的事')).toBeInTheDocument()
    expect(screen.getByText('DSH 掉了要知道')).toBeInTheDocument()
    expect(screen.getByText(/127\.0\.0\.1:3080/)).toBeInTheDocument()
    expect(screen.getByText(/通 → 不通/)).toBeInTheDocument()
  })

  it('★✕ 取消一条 → 回调带上这条的 id', async () => {
    const onCancelWatch = vi.fn()
    render(<Butler {...props({ sentinel: SENTINEL, onCancelWatch })} />)
    await userEvent.click(screen.getByRole('button', { name: '取消监视:DSH 掉了要知道' }))
    expect(onCancelWatch).toHaveBeenCalledWith('w1')
  })

  it('还没变过:如实说"还没有变化",不编一条', () => {
    const { last_change: _dropped, ...fresh } = SENTINEL.watches[0]!
    render(<Butler {...props({ sentinel: { watches: [{ ...fresh, fires: 0 }] } })} />)
    expect(screen.getByText(/还没有变化/)).toBeInTheDocument()
  })

  it('探不到:如实显示原因,不当成变化(D13)', () => {
    render(<Butler {...props({
      sentinel: { watches: [{ ...SENTINEL.watches[0]!, error: '连不上' }] },
    })} />)
    expect(screen.getByText(/探不到/)).toBeInTheDocument()
    expect(screen.getByText(/连不上/)).toBeInTheDocument()
  })

  it('收工了的条目标出来(次数用尽/已到期),不假装还在盯', () => {
    render(<Butler {...props({
      sentinel: { watches: [{ ...SENTINEL.watches[0]!, done: true, last_change: '已到期,不再盯了' }] },
    })} />)
    expect(screen.getByText(/已收工/)).toBeInTheDocument()
  })

  it('一条都没有:整栏不渲染,不摆空壳(同今晨快报的纪律)', () => {
    render(<Butler {...props({ sentinel: { watches: [] } })} />)
    expect(screen.queryByText('在盯着的事')).toBeNull()
  })

  it('服务端没启用哨兵(字段缺省):同样不渲染', () => {
    render(<Butler {...props()} />)
    expect(screen.queryByText('在盯着的事')).toBeNull()
  })

  it('窄条态不显示这一栏;球态右键出「全部暂停 / 试铃」且能点,点球展开(不可改清单第 1 条)', async () => {
    const onPause = vi.fn()
    const onTestRing = vi.fn()
    const onToggleMin = vi.fn()
    render(<Butler {...props({ sentinel: SENTINEL, narrowForced: true, onPause, onTestRing, onToggleMin })} />)
    expect(screen.queryByText('在盯着的事')).toBeNull()
    // 两态设计:球面本身只是形象,没有直接暴露的暂停键——入口在右键 / 长按菜单里。
    const ball = screen.getByRole('button', { name: /^事务官.*\(点一下展开\)$/ })
    expect(screen.queryByRole('button', { name: /全部暂停/ })).toBeNull()
    // 右键球 → 菜单里有「全部暂停」「试铃」两键且都能点(叫停入口永远在,PRD §9)。
    fireEvent.contextMenu(ball)
    await userEvent.click(within(screen.getByRole('region', { name: '事务官叫停入口' })).getByRole('button', { name: /全部暂停/ }))
    expect(onPause).toHaveBeenCalledTimes(1)
    fireEvent.contextMenu(ball)
    await userEvent.click(within(screen.getByRole('region', { name: '事务官叫停入口' })).getByRole('button', { name: /试铃/ }))
    expect(onTestRing).toHaveBeenCalledTimes(1)
    // 再点球 → 展开。
    await userEvent.click(ball)
    expect(onToggleMin).toHaveBeenCalledTimes(1)
  })
})
