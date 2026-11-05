/**
 * 折线图那个组件(`TrendChart`,2026-09-21)。
 *
 * **夹具里的数字全是假的**(同 client-review-module.test.tsx 那条纪律)。
 *
 * ★ 2026-10-03:「数据复盘」那一格的组件本体换成了运营同学(Air)自己写的那一份
 * (`user-layer/起步/小组件/review/index.js`),**她那一格自己画趋势**(「账号趋势」那个视图里一个账号一张
 * 小图),不再渲染这个 `TrendChart`。所以这一份用例从"渲染整格"改成**直接渲染这个组件**:
 * 它与 `client/trendChart.ts` 那几个纯函数是独立的一套零件,口径(缺一天断一段、不补 0、
 * 显示原样那串)没有变,守卫留着;上一版那四条断言整格行为的(没接自取退回占位、
 * 老服务没回 trends 整块缺席、范围按钮切那一份)删了 —— 她那一格没有这几支。
 *
 * **这个组件此刻没有消费方**,记在 docs/交接-1003-运营同学六组件原封接入.md 的
 * 「没有消费方但留着的」里。
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { XhsTrendView } from '../src/protocol.ts'
import { TREND_ALL_EMPTY, TREND_SERIES_EMPTY, TrendChart } from '../src/client/ReviewModule.tsx'

afterEach(cleanup)

const DATES = ['2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18', '2026-09-19', '2026-09-20', '2026-09-21']

function trend(over: Partial<XhsTrendView> = {}): XhsTrendView {
  return {
    range: '近 7 日',
    dates: DATES,
    series: [
      {
        key: 'views',
        label: '观看数',
        from: ['观看数'],
        points: [
          { date: '2026-09-15', value: 100, raw: '100' },
          { date: '2026-09-16', value: 200, raw: '200' },
          // 17、18 没取到
          { date: '2026-09-19', value: 300, raw: '300' },
          { date: '2026-09-21', value: 500, raw: '500' },
        ],
      },
      {
        key: 'engagement',
        label: '互动(点赞+收藏)',
        from: ['点赞数', '收藏数'],
        points: [{ date: '2026-09-21', value: 15, raw: '7 + 8' }],
      },
      { key: 'new_fans', label: '涨粉', from: ['涨粉数'], points: [] },
    ],
    ...over,
  }
}

function mount(one: XhsTrendView = trend()) {
  render(<TrendChart trend={one} />)
}

describe('画出来的线', () => {
  it('三行小图,每行一条线,名字逐字取自白板', () => {
    mount()
    expect(screen.getByLabelText('近 7 日的折线图')).toBeInTheDocument()
    expect(screen.getByText('观看数')).toBeInTheDocument()
    expect(screen.getByText('互动(点赞+收藏)')).toBeInTheDocument()
    expect(screen.getByText('涨粉')).toBeInTheDocument()
  })

  it('缺的那两天真的断线:观看那条画成两段路径', () => {
    mount()
    const rows = document.querySelectorAll('.ben-wb__trend-row')
    const lines = rows[0]?.querySelectorAll('.ben-wb__trend-line')
    // 15-16 一段、19 一段、21 一段 —— 三段,而不是一条连过去的线
    expect(lines?.length).toBe(3)
  })

  it('一个点都没有的那条:写「这条线还没有数」,不画图', () => {
    mount()
    expect(screen.getByText(TREND_SERIES_EMPTY)).toBeInTheDocument()
    const rows = document.querySelectorAll('.ben-wb__trend-row')
    expect(rows[2]?.querySelector('svg')).toBeNull()
  })

  it('三条线全空 → 说清是"还没有按日快照",不画三条贴底的直线', () => {
    mount(trend({ series: trend().series.map(s => ({ ...s, points: [] })) }))
    expect(screen.getByText(TREND_ALL_EMPTY)).toBeInTheDocument()
    expect(document.querySelector('.ben-wb__trend-svg')).toBeNull()
  })

  it('每个点上挂着「日期 · 原样那串」,互动那条写的是 7 + 8', () => {
    mount()
    expect(screen.getByText('2026-09-21 · 7 + 8')).toBeInTheDocument()
    expect(screen.getByText('2026-09-16 · 200')).toBeInTheDocument()
  })

  it('图旁边写着最高最低(轴被截断这件事是写明的)', () => {
    mount()
    expect(screen.getByText('高 500')).toBeInTheDocument()
    expect(screen.getByText('低 100')).toBeInTheDocument()
  })

  it('口径写在图上面:每个点是"那天取到的近 7 日那一份"', () => {
    mount()
    expect(screen.getByText(/每个点 = 那天取到的「近 7 日」那一份/)).toBeInTheDocument()
  })

  it('依据写着这条线从快照里哪几项来', () => {
    mount()
    expect(screen.getByText('来自:点赞数 + 收藏数')).toBeInTheDocument()
  })

  it('横轴两头写着起止日期', () => {
    mount()
    const labels = document.querySelector('.ben-wb__trend-axis-labels')
    expect(labels?.textContent).toContain('2026-09-15')
    expect(labels?.textContent).toContain('2026-09-21')
  })
})
