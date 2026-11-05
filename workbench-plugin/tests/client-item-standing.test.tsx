import '@testing-library/jest-dom/vitest'
/**
 * 没办完的事项停在哪(2026-10-12,卡「没办完的事项说清楚」)在电脑界面上的两处:
 * 看板卡面上那一小格(只给要留意的那几种),卡片弹窗里「停在哪」那一块(最后一条证据 · 在等谁 · 下一步 + 继续 / 关掉 / 重派)。
 */
import { cleanup, render, screen } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ItemStandingView, TaskView } from '../src/protocol.ts'
import { TaskCard } from '../src/client/TaskCard.tsx'
import { StandingBlock } from '../src/client/StandingBlock.tsx'

afterEach(cleanup)

const AT = '2026-10-10T02:00:00.000Z'
const NOW = '2026-10-12T10:00:00+08:00'

function task(standing: ItemStandingView, over: Partial<TaskView> = {}): TaskView {
  return { id: 'a', title: '换首页截图', status: 'doing', direction: 'mine', source: { kind: 'manual' }, created_at: AT, updated_at: AT, standing, ...over }
}

const UNWRITTEN: ItemStandingView = {
  case: 'result_unwritten',
  last: { what: '事务官 那段会话说完了', at: AT, source: 'session' },
  waiting_on: 'nobody',
  next: '事务官 已经说完了,结果没收进卡:看一眼收下(进「等我确认」),或者重派',
  idle_days: 2,
  stalled: true,
  actions: ['continue', 'close', 'redispatch'],
}

describe('看板卡面', () => {
  it('结果没收进卡:卡面一小格说是哪种、停了几天;鼠标停上去看得到最后一条证据与下一步', () => {
    render(<TaskCard task={task(UNWRITTEN)} sessions={[]} sessionUsage={{}} nowMs={Date.parse(NOW)} onOpen={() => {}} onDragStart={() => {}} onDragEnd={() => {}} />)
    const badge = screen.getByText('结果回来了没收进卡 · 停了 2 天')
    expect(badge).toHaveAttribute('data-case', 'result_unwritten')
    expect(badge.getAttribute('title')).toContain('事务官 那段会话说完了')
    expect(badge.getAttribute('title')).toContain('会话')
    expect(badge.getAttribute('title')).toContain('没人在等')
  })

  it('正常在做的不出字', () => {
    render(<TaskCard task={task({ case: 'in_motion', waiting_on: 'agent', agent: 'claude', next: 'Claude 在做', idle_days: 0 })} sessions={[]} sessionUsage={{}} nowMs={Date.parse(NOW)} onOpen={() => {}} onDragStart={() => {}} onDragEnd={() => {}} />)
    expect(document.querySelector('.ben-wb__task-standing')).toBeNull()
  })
})

describe('卡片弹窗「停在哪」', () => {
  it('三样都写出来:最后一条证据(什么 · 来源 · 时刻)、在等谁、下一步', () => {
    render(<StandingBlock task={task(UNWRITTEN)} now={NOW} />)
    expect(screen.getByText(/最后一条:事务官 那段会话说完了/)).toHaveTextContent('会话')
    expect(screen.getByText('没人在等')).toBeInTheDocument()
    expect(screen.getByText(/下一步:事务官 已经说完了/)).toBeInTheDocument()
  })

  it('继续 = 收进等我确认;关掉 = 挪进取消;重派 = 再派一次(都走现有入口)', async () => {
    const onMove = vi.fn()
    const drive = vi.fn(async () => '派出去了')
    render(<StandingBlock task={task(UNWRITTEN)} now={NOW} onMove={onMove} drive={drive} />)
    await userEvent.click(screen.getByRole('button', { name: '继续' }))
    expect(onMove).toHaveBeenLastCalledWith('a', 'confirm')
    await userEvent.click(screen.getByRole('button', { name: '关掉' }))
    expect(onMove).toHaveBeenLastCalledWith('a', 'canceled')
    await userEvent.click(screen.getByRole('button', { name: '重派' }))
    expect(drive).toHaveBeenCalledWith('a')
  })

  it('弹窗里「继续」= 打开这件 的那几种不画那颗(她已经在这件里了);没接线的那颗不画', () => {
    const waiting: ItemStandingView = { case: 'waiting_her', waiting_on: 'her', next: '看一眼交回来的,收下或打回', idle_days: 4, stalled: true, actions: ['continue', 'close'] }
    render(<StandingBlock task={task(waiting, { status: 'confirm' })} now={NOW} onMove={() => {}} />)
    expect(screen.queryByRole('button', { name: '继续' })).toBeNull()
    expect(screen.getByRole('button', { name: '关掉' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '重派' })).toBeNull()
  })

  it('没有 standing(办完的、老工作台)整块不画', () => {
    const { standing: _none, ...done } = task(UNWRITTEN)
    const { container } = render(<StandingBlock task={done} now={NOW} />)
    expect(container).toBeEmptyDOMElement()
  })
})
