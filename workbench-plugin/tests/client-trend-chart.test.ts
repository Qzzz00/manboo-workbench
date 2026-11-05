/**
 * 折线图的几何(2026-09-21)。纯函数,不碰 DOM。
 *
 * 这一份钉的是**看不出来的走样**:缺一天没断线、只有一个点画成了一条横线、
 * 最高最低一样时线贴着上边缘、30 天那一档画了一串珠子。
 */
import { describe, expect, it } from 'vitest'
import type { XhsTrendPointView } from '../src/protocol.ts'
import {
  TREND_DOT_MAX, TREND_PAD_Y, TREND_VIEW_H, TREND_VIEW_W,
  trendPathD, trendRange, trendScale, trendSegments, trendShowDots, trendX, trendY,
} from '../src/client/trendChart.ts'

const DATES = ['09-15', '09-16', '09-17', '09-18', '09-19', '09-20', '09-21']

function point(date: string, value: number): XhsTrendPointView {
  return { date, value, raw: String(value) }
}

describe('分段:缺的那天要断线', () => {
  it('连着的几天是一段', () => {
    const points = [point('09-15', 1), point('09-16', 2), point('09-17', 3)]
    const segments = trendSegments(DATES, points)
    expect(segments).toHaveLength(1)
    expect(segments[0]).toHaveLength(3)
  })

  it('中间缺一天 → 两段(**不连过去**)', () => {
    const points = [point('09-15', 1), point('09-16', 2), point('09-19', 3), point('09-20', 4)]
    const segments = trendSegments(DATES, points)
    expect(segments).toHaveLength(2)
    expect(segments.map(segment => segment.map(item => item.point.date)))
      .toEqual([['09-15', '09-16'], ['09-19', '09-20']])
  })

  it('隔一天一个点 → 每个点自成一段(全是孤点,一条线都不画)', () => {
    const points = [point('09-15', 1), point('09-17', 2), point('09-19', 3)]
    expect(trendSegments(DATES, points)).toHaveLength(3)
  })

  it('轴上没有的日期直接丢掉,不画到图外面去', () => {
    expect(trendSegments(DATES, [point('08-01', 9)])).toEqual([])
  })

  it('一个点都没有 → 没有段', () => {
    expect(trendSegments(DATES, [])).toEqual([])
  })
})

describe('纵向范围', () => {
  it('取数据自己的最小~最大(不从 0 起,图旁边把这两个数写出来)', () => {
    const scale = trendScale([point('09-15', 48000), point('09-16', 52000)])
    expect(scale).toEqual({ min: 48000, max: 52000, flat: false })
  })

  it('全都一样 / 只有一个点 → flat,线画在中间', () => {
    const scale = trendScale([point('09-15', 7), point('09-16', 7)])
    expect(scale?.flat).toBe(true)
    expect(trendY(7, scale as never)).toBeCloseTo(TREND_VIEW_H / 2)
  })

  it('一个点都没有 → 没有范围(界面据此说「这条线还没有数」)', () => {
    expect(trendScale([])).toBeUndefined()
  })

  it('大的在上:最大值贴上留白线,最小值贴下留白线', () => {
    const scale = trendScale([point('a', 10), point('b', 20)]) as never
    expect(trendY(20, scale)).toBeCloseTo(TREND_PAD_Y)
    expect(trendY(10, scale)).toBeCloseTo(TREND_VIEW_H - TREND_PAD_Y)
  })
})

describe('横坐标', () => {
  it('第一天在最左、最后一天在最右', () => {
    expect(trendX(0, 7)).toBe(0)
    expect(trendX(6, 7)).toBe(TREND_VIEW_W)
  })

  it('只有一天时摆中间(摆 0 会贴着左边缘,看着像被裁了)', () => {
    expect(trendX(0, 1)).toBe(TREND_VIEW_W / 2)
  })
})

describe('路径', () => {
  it('两个点 = 一条线段', () => {
    const scale = trendScale([point('09-15', 0), point('09-16', 10)]) as never
    const d = trendPathD(trendSegments(DATES, [point('09-15', 0), point('09-16', 10)])[0] as never, 7, scale)
    expect(d.startsWith('M ')).toBe(true)
    expect(d.split('L')).toHaveLength(2)
  })

  it('孤点 = 零长度线段(配圆头描边画成一个点)', () => {
    const scale = trendScale([point('09-17', 5)]) as never
    const d = trendPathD(trendSegments(DATES, [point('09-17', 5)])[0] as never, 7, scale)
    const [head, tail] = d.split(' L ')
    expect(head?.replace('M ', '')).toBe(tail)
  })

  it('坐标只留一位小数(别在属性里塞一串浮点数)', () => {
    const points = [point('09-15', 1), point('09-16', 3), point('09-17', 7)]
    const scale = trendScale(points) as never
    const d = trendPathD(trendSegments(DATES, points)[0] as never, 7, scale)
    for (const number of d.match(/-?\d+(\.\d+)?/g) ?? []) {
      expect((number.split('.')[1] ?? '').length).toBeLessThanOrEqual(1)
    }
  })

  it('空段回空串', () => {
    expect(trendPathD([], 7, { min: 0, max: 1, flat: false })).toBe('')
  })
})

describe('点画不画', () => {
  it('7 天那一档画点,30 天那一档不画(一串珠子看不清线)', () => {
    const few = Array.from({ length: TREND_DOT_MAX }, (_, i) => point(`d${i}`, i))
    expect(trendShowDots(few)).toBe(true)
    expect(trendShowDots([...few, point('more', 1)])).toBe(false)
    expect(trendShowDots([])).toBe(false)
  })
})

describe('最高最低', () => {
  it('回的是页面上原样那串,不是重新格式化的数', () => {
    const points: XhsTrendPointView[] = [
      { date: '09-15', value: 99000, raw: '9.9万' },
      { date: '09-16', value: 12000, raw: '1.2万' },
    ]
    const edge = trendRange(points)
    expect(edge?.high.raw).toBe('9.9万')
    expect(edge?.low.raw).toBe('1.2万')
  })

  it('一个点都没有 → undefined', () => {
    expect(trendRange([])).toBeUndefined()
  })
})
