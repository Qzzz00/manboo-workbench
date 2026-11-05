/**
 * 「今天的待办」两版显示与换版本那一下(2026-10-12 周三演示;
 * 2026-10-13 两版改成**列表 / 卡片**,维护者:「改成按列表展示或按卡片展示」)。
 *
 *   - 卡片:今天 / 明天 / 更晚三组,每组标题带件数,**每条一张小卡**(到期、负责人、状态点);
 *     列表:今天那一条平铺清单,一行一件(原样);两版一眼看得出不一样;
 *   - 版本变了(电话里切、设置里切、撤销):那一格先盖「正在优化…」,TODAY_SWITCH_MS 后换成新版本、遮罩淡出;
 *     第一次挂上就是哪一版就直接摆,不盖;
 *   - 设置里那两颗救场键:走 `POST /today/view`,字是「卡片 / 列表」。
 */
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TaskView, TodayTodosView, TodayViewStyle } from '../src/protocol.ts'
import { TODAY_SWITCH_MS, TODAY_SWITCH_TEXT, TODAY_VIEW_TITLES } from '../src/protocol.ts'
import {
  TODAY_CARD_STATES, TODAY_GROUP_EMPTY, TODAY_VEIL_FADE_MS, TodayModule, TodayViewPicker, todayCardFace, todayGroupHeading,
} from '../src/client/TodayModule.tsx'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const BOX = { id: 'today', title: '今天的待办', basisPct: 10, dragging: false, onResizeStart: () => {}, onResizeMove: () => {}, onResizeEnd: () => {} }
const AT = '2026-10-12T02:00:00.000Z'
const TASKS = [
  { id: 'a', title: '回三条评论', status: 'todo', due: '2026-10-12', created_at: AT, updated_at: AT },
  { id: 'b', title: '剪片头', status: 'blocked', block_reason: 'input', assignee: 'colleague', due: '2026-10-13', created_at: AT, updated_at: AT },
  { id: 'c', title: '投稿复盘', status: 'doing', assignee: 'me', due: '2026-10-18', created_at: AT, updated_at: AT },
] as TaskView[]

function viewOf(style: TodayViewStyle): TodayTodosView {
  const a = { id: 'a', title: '回三条评论', due: '2026-10-12', done: false, overdue: false }
  const b = { id: 'b', title: '剪片头', due: '2026-10-13', done: false, overdue: false }
  const c = { id: 'c', title: '投稿复盘', due: '2026-10-18', done: false, overdue: false }
  return {
    date: '2026-10-12',
    tomorrow: '2026-10-13',
    items: [a],
    style,
    groups: [
      { key: 'today', label: '今天', items: [a] },
      { key: 'tomorrow', label: '明天', items: [b] },
      { key: 'later', label: '更晚', items: [c] },
    ],
  }
}

const okFetch = (async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) as unknown as typeof fetch

function el(view: TodayTodosView) {
  return (
    <TodayModule
      box={BOX}
      header={<h3 id="t">今天的待办</h3>}
      headingId="t"
      baseUrl="http://127.0.0.1:8791"
      fetchImpl={okFetch}
      view={view}
      tasks={TASKS}
      storage={undefined}
    />
  )
}

describe('两版显示', () => {
  it('卡片:三组,每组标题带件数;明天、更晚的那几件也摆出来', () => {
    const { container } = render(el(viewOf('by_date')))
    expect(screen.getByText('今天 · 1 件')).toBeInTheDocument()
    expect(screen.getByText('明天 · 1 件')).toBeInTheDocument()
    expect(screen.getByText('更晚 · 1 件')).toBeInTheDocument()
    expect(screen.getByText('剪片头')).toBeInTheDocument()
    expect(screen.getByText('投稿复盘')).toBeInTheDocument()
    expect(container.querySelectorAll('.ben-wb__today-card')).toHaveLength(3)
    expect(screen.queryByText(TODAY_SWITCH_TEXT)).toBeNull()
  })

  it('★ 卡上带到期、负责人、状态点:阻塞那张照看板的语义色描边', () => {
    const { container } = render(el(viewOf('by_date')))
    expect([...container.querySelectorAll('.ben-wb__today-card-due')].map(one => one.textContent)).toEqual(['今天', '明天', '10/18'])
    expect(screen.getByText('同事')).toBeInTheDocument()
    expect(screen.getByText('我')).toBeInTheDocument()
    expect(screen.getByText(`${TODAY_CARD_STATES.blocked} · 等你输入`)).toBeInTheDocument()
    expect(container.querySelector('.ben-wb__today-card[data-state=blocked]')).not.toBeNull()
    const css = [...document.querySelectorAll('style')].map(one => one.textContent ?? '').join('\n')
    expect(css).toContain('--dsw-alias-state-warn-label')
  })

  it('★ 列表:一行一件的清单,一张卡都没有(两版一眼看得出不一样)', () => {
    const { container } = render(el(viewOf('flat')))
    expect(screen.getByText('回三条评论')).toBeInTheDocument()
    expect(screen.queryByText('剪片头')).toBeNull()
    expect(screen.queryByText(/件$/u, { selector: 'h4' })).toBeNull()
    expect(container.querySelectorAll('.ben-wb__today-card')).toHaveLength(0)
    expect(container.querySelectorAll('.ben-wb__today-item')).toHaveLength(1)
    // 到期 / 负责人那几样是卡片版才有的
    expect(screen.queryByText('同事')).toBeNull()
  })

  it('卡片版:那一格够宽摆三列,窄了掉成三段(按那一格的宽度,不看屏幕宽)', () => {
    render(el(viewOf('by_date')))
    const css = [...document.querySelectorAll('style')].map(one => one.textContent ?? '').join('\n')
    expect(css).toContain('container-type:inline-size')
    expect(css).toMatch(/@container \(min-width:520px\)\{[^}]*repeat\(3,/u)
  })

  it('卡片版空着的那一组写一行灰字,不画空清单', () => {
    const empty = { ...viewOf('by_date'), groups: [{ key: 'today' as const, label: '今天', items: [] }] }
    const { container } = render(el(empty))
    expect(screen.getByText('今天 · 0 件')).toBeInTheDocument()
    expect(screen.getByText(TODAY_GROUP_EMPTY)).toBeInTheDocument()
    expect(container.querySelectorAll('.ben-wb__today-cardlist')).toHaveLength(0)
  })

  it('勾选 / 延到明天在卡片版上还是那两条路(aria 名字两版一样)', () => {
    render(el(viewOf('by_date')))
    expect(screen.getByRole('checkbox', { name: '完成:剪片头' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '剪片头 延到明天' })).toBeInTheDocument()
  })

  it('卡面那三样算得对(到期按今天 / 明天 / 日子;逾期写明;没派给谁就不摆负责人)', () => {
    const days = { date: '2026-10-12', tomorrow: '2026-10-13' }
    const item = { id: 'b', title: '剪片头', due: '2026-10-13', done: false, overdue: false }
    expect(todayCardFace(item, TASKS[1], days)).toEqual({ due: '明天', state: 'blocked', owner: '同事', blockWhy: '等你输入' })
    expect(todayCardFace({ ...item, due: '2026-10-12' }, undefined, days)).toEqual({ due: '今天', state: 'open' })
    expect(todayCardFace({ ...item, due: '2026-10-10', overdue: true }, undefined, days)).toMatchObject({ due: '逾期 · 10/10' })
    expect(todayCardFace({ ...item, done: true }, TASKS[1], days).state).toBe('done')
  })

  it('标题的字只有一处', () => {
    expect(todayGroupHeading({ key: 'later', label: '更晚', items: [] })).toBe('更晚 · 0 件')
  })
})

describe('换版本那一下', () => {
  it('版本变了:先盖「正在优化…」(底下还是旧版),到点换成新版、遮罩淡出', () => {
    vi.useFakeTimers()
    const { rerender } = render(el(viewOf('flat')))
    rerender(el(viewOf('by_date')))
    expect(screen.getByText(TODAY_SWITCH_TEXT)).toBeInTheDocument()
    expect(screen.queryByText('明天 · 1 件')).toBeNull()

    act(() => { vi.advanceTimersByTime(TODAY_SWITCH_MS) })
    expect(screen.getByText('明天 · 1 件')).toBeInTheDocument()
    act(() => { vi.advanceTimersByTime(TODAY_VEIL_FADE_MS) })
    expect(screen.queryByText(TODAY_SWITCH_TEXT)).toBeNull()

    // 来回再演一遍
    rerender(el(viewOf('flat')))
    expect(screen.getByText(TODAY_SWITCH_TEXT)).toBeInTheDocument()
    act(() => { vi.advanceTimersByTime(TODAY_SWITCH_MS) })
    act(() => { vi.advanceTimersByTime(TODAY_VEIL_FADE_MS) })
    expect(screen.queryByText('明天 · 1 件')).toBeNull()
    expect(screen.queryByText(TODAY_SWITCH_TEXT)).toBeNull()
  })

  it('同一版的新快照(勾了一件)不盖遮罩', () => {
    const { rerender } = render(el(viewOf('by_date')))
    rerender(el({ ...viewOf('by_date'), items: [] }))
    expect(screen.queryByText(TODAY_SWITCH_TEXT)).toBeNull()
  })

  it('屏幕上不出现写代码之类的字样', () => {
    vi.useFakeTimers()
    const { rerender, container } = render(el(viewOf('flat')))
    rerender(el(viewOf('by_date')))
    expect(container.textContent).not.toMatch(/Codex|代码|写代码/u)
  })
})

describe('设置里那两颗救场键', () => {
  it('两颗键的字是「卡片 / 列表」', () => {
    render(<TodayViewPicker baseUrl="http://127.0.0.1:8791" fetchImpl={okFetch} current="flat" />)
    expect(screen.getByRole('button', { name: TODAY_VIEW_TITLES.by_date })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: TODAY_VIEW_TITLES.flat })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '按日期汇总' })).toBeNull()
  })

  it('点「卡片」→ POST /today/view {view:by_date};当前那一版按下着', async () => {
    const calls: { path: string, body: unknown }[] = []
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ path: String(url).replace('http://127.0.0.1:8791', ''), body: JSON.parse(String(init?.body ?? '{}')) })
      return new Response(JSON.stringify({ ok: true, view: 'by_date', changed: true }), { status: 200 })
    }) as unknown as typeof fetch
    render(<TodayViewPicker baseUrl="http://127.0.0.1:8791" fetchImpl={fetchImpl} current="flat" />)
    expect(screen.getByRole('button', { name: '列表' })).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(screen.getByRole('button', { name: '卡片' }))
    await waitFor(() => expect(calls).toEqual([{ path: '/today/view', body: { view: 'by_date' } }]))
  })

  it('服务端拒了就把那句话摆出来', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ error: '此刻读不到布局,没换。' }), { status: 409 })) as unknown as typeof fetch
    render(<TodayViewPicker baseUrl="http://127.0.0.1:8791" fetchImpl={fetchImpl} current="flat" />)
    fireEvent.click(screen.getByRole('button', { name: '卡片' }))
    expect(await screen.findByText('此刻读不到布局,没换。')).toBeInTheDocument()
  })
})
