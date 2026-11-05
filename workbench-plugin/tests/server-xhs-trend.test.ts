// @vitest-environment node
/**
 * 折线图的数据(2026-09-21)。**夹具里的数字全是假的**(同 tests/xhsPageFixtures.ts 那条纪律)。
 *
 * 钉的是三件"一错就看不出来"的事:
 * 1. **缺的天不出点**(不补 0、不拿前一天顺延);
 * 2. **互动 = 点赞 + 收藏,两项都在才算**(少一项整天不出点,而不是按一项算);
 * 3. **轴的长度跟着范围走**(近 7 日 = 7 天,近 30 日 = 30 天)。
 */
import { describe, expect, it } from 'vitest'
import { XHS_TREND_DEFS, buildTrendView, trendDates, trendValueOf } from '../src/server/xhsTrend.ts'
import type { XhsDays, XhsSnapshot } from '../src/server/xhsStore.ts'

/** 2026-09-21 12:00 本地时间。 */
const TODAY = new Date(2026, 8, 21, 12, 0, 0).getTime()

function snap(metrics: Record<string, number>): XhsSnapshot {
  return {
    at: '2026-09-21T02:00:00.000Z',
    metrics: Object.fromEntries(
      Object.entries(metrics).map(([key, value]) => [key, { value, raw: String(value) }]),
    ) as XhsSnapshot['metrics'],
  }
}

function days(entries: Record<string, Record<string, number>>): XhsDays {
  return Object.fromEntries(Object.entries(entries).map(([date, metrics]) => [date, { d7: snap(metrics) }]))
}

describe('轴', () => {
  it('近 7 日 = 7 天、近 30 日 = 30 天,升序,最后一天是今天', () => {
    const seven = trendDates(TODAY, '近 7 日')
    expect(seven).toHaveLength(7)
    expect(seven[0]).toBe('2026-09-15')
    expect(seven[6]).toBe('2026-09-21')
    expect(trendDates(TODAY, '近 30 日')).toHaveLength(30)
    expect(trendDates(TODAY, '近 30 日')[0]).toBe('2026-08-23')
  })
})

describe('三条线', () => {
  it('顺序与名字逐字取自白板:观看数 / 互动(点赞+收藏)/ 涨粉', () => {
    expect(XHS_TREND_DEFS.map(def => def.label)).toEqual(['观看数', '互动(点赞+收藏)', '涨粉'])
  })

  it('互动 = 点赞 + 收藏;raw 里两串原文都留着', () => {
    const value = trendValueOf(snap({ likes: 12, favorites: 30 }), 'engagement')
    expect(value?.value).toBe(42)
    expect(value?.raw).toBe('12 + 30')
  })

  it('只取到点赞、没取到收藏 → 这一天整个不出点(**不按一项算**)', () => {
    expect(trendValueOf(snap({ likes: 12 }), 'engagement')).toBeUndefined()
    expect(trendValueOf(snap({ favorites: 30 }), 'engagement')).toBeUndefined()
  })

  it('取不到就是取不到,绝不退回 0', () => {
    expect(trendValueOf(snap({}), 'views')).toBeUndefined()
    expect(trendValueOf(snap({}), 'new_fans')).toBeUndefined()
  })
})

describe('整份视图', () => {
  const data = days({
    '2026-09-16': { views: 100, likes: 1, favorites: 2, new_fans: 5 },
    // 17、18 没取到 —— 断线就断在这里
    '2026-09-19': { views: 300, likes: 3, favorites: 4, new_fans: 7 },
    '2026-09-20': { views: 400, likes: 5, favorites: 6 },
    '2026-09-21': { views: 500, likes: 7, favorites: 8, new_fans: 9 },
  })

  it('缺的那两天不出点,轴仍然是完整的 7 天', () => {
    const view = buildTrendView(data, '近 7 日', TODAY)
    expect(view.dates).toHaveLength(7)
    const views = view.series.find(series => series.key === 'views')
    expect(views?.points.map(point => point.date)).toEqual(['2026-09-16', '2026-09-19', '2026-09-20', '2026-09-21'])
    // 17、18 一个 0 都没有
    expect(views?.points.some(point => point.value === 0)).toBe(false)
  })

  it('涨粉那天没取到 → 涨粉那条线少一个点,观看那条不受影响', () => {
    const view = buildTrendView(data, '近 7 日', TODAY)
    expect(view.series.find(s => s.key === 'new_fans')?.points.map(p => p.date))
      .toEqual(['2026-09-16', '2026-09-19', '2026-09-21'])
    expect(view.series.find(s => s.key === 'views')?.points).toHaveLength(4)
  })

  it('范围之外的那一天不进来(近 7 日看不到 9 天前)', () => {
    const older = days({ '2026-09-10': { views: 1 }, '2026-09-21': { views: 2 } })
    const view = buildTrendView(older, '近 7 日', TODAY)
    expect(view.series.find(s => s.key === 'views')?.points.map(p => p.date)).toEqual(['2026-09-21'])
  })

  it('一天快照都没有:三条线都是空数组,而不是整块缺席', () => {
    const view = buildTrendView({}, '近 7 日', TODAY)
    expect(view.series).toHaveLength(3)
    expect(view.series.every(series => series.points.length === 0)).toBe(true)
    expect(view.dates).toHaveLength(7)
  })

  it('近 30 日读的是 d30 那一格,不拿 d7 顶替', () => {
    const view = buildTrendView(data, '近 30 日', TODAY)
    expect(view.series.every(series => series.points.length === 0)).toBe(true)
  })
})
