/**
 * 数据看板的**折线图数据**(2026-09-21,白板第一节:「折线图:横轴时间,纵轴 观看数、
 * 互动(点赞+收藏)、涨粉」;第四节增量第 1 条「数据复盘已按日存快照,可画」)。
 *
 * 这个文件**一行 I/O 都没有**:输入是 `xhsStore` 那份按日快照(`XhsDays`),
 * 输出是界面画线要的点位。开浏览器、落盘在 xhsCreator.ts / xhsStore.ts。
 *
 * ## ★ 每个点是什么,必须说清楚
 *
 * 后台给的从来不是"那一天的观看数",而是**那一天取到的「近 7 日」/「近 30 日」那一份**
 * ——一个已经聚合过的滚动值。所以这条线是**滚动窗口值随时间的变化**,不是日增量。
 *
 * 这件事没法靠算出来绕开:把相邻两天的近 7 日相减,得到的是"进窗口的那天减出窗口的那天",
 * 不是当天的量。**宁可把口径原样说出来,也不算一个看着像日增量的数**(D13),
 * 所以界面上那一行小字写的是「每个点 = 那天取到的『近 N 日』那一份」。
 *
 * ## 缺的天
 *
 * 没取到的那一天**不出点、也不连线**(`XhsTrendPoint` 只出现在真有快照的日子上,
 * 轴上的 `dates` 仍然是完整的日历)。不补 0、不拿前一天顺延 ——
 * 一条平着走过去的线会被读成"那几天没变",而真相是"那几天没取"。
 *
 * ## 互动 = 点赞 + 收藏
 *
 * 白板上写死的口径。两项**都取到了才算**:只有点赞时算出来的"互动"比真实值小,
 * 而界面上看不出它小 —— 那是编数。少一项时这一天整个不出点。
 */
import type { XhsTrendPointView, XhsTrendSeriesView, XhsTrendView } from '../protocol.ts'
import type { XhsRange } from './xhsMetrics.ts'
import { XHS_RANGE_DAYS } from './xhsMetrics.ts'
import type { XhsDays, XhsSnapshot } from './xhsStore.ts'
import { XHS_RANGE_KEY, shiftDate, xhsDateStr } from './xhsStore.ts'

/** 三条线的机器名。顺序 = 白板上从左到右念的顺序,也是界面上从上到下的顺序。 */
export const XHS_TREND_KEYS = ['views', 'engagement', 'new_fans'] as const
export type XhsTrendKey = typeof XHS_TREND_KEYS[number]

export interface XhsTrendDef {
  key: XhsTrendKey
  /** 界面上那一行小标题。**逐字取自白板**。 */
  label: string
  /** 这条线是从快照里哪几项来的(界面上「依据」那一句念的就是它)。 */
  from: readonly string[]
}

export const XHS_TREND_DEFS: readonly XhsTrendDef[] = [
  { key: 'views', label: '观看数', from: ['观看数'] },
  { key: 'engagement', label: '互动(点赞+收藏)', from: ['点赞数', '收藏数'] },
  { key: 'new_fans', label: '涨粉', from: ['涨粉数'] },
]

/** 一份快照里这条线的值。取不到(或互动少一项)回 undefined —— **绝不退回 0**。 */
export function trendValueOf(snapshot: XhsSnapshot, key: XhsTrendKey): { value: number, raw: string } | undefined {
  const metrics = snapshot.metrics
  if (key === 'views') {
    const views = metrics.views
    return views === undefined ? undefined : { value: views.value, raw: views.raw }
  }
  if (key === 'new_fans') {
    const fans = metrics.new_fans
    return fans === undefined ? undefined : { value: fans.value, raw: fans.raw }
  }
  const likes = metrics.likes
  const favorites = metrics.favorites
  // 两项都在才算。少一项整天不出点(见文件头)。
  if (likes === undefined || favorites === undefined) return undefined
  // raw 是"页面上原样那两串加起来"的写法 —— 两串原文都留着,他能自己核。
  return { value: likes.value + favorites.value, raw: `${likes.raw} + ${favorites.raw}` }
}

/**
 * 轴上的日期:**从今天往回数 N 天**(含今天),N 由范围决定(近 7 日 → 7 天,近 30 日 → 30 天)。
 *
 * 为什么窗口长度跟着范围走:界面上只有那两颗按钮,两处用同一个词却指不同的天数,
 * 是这一格最容易让人读错的地方。**这条是可推翻的**(决策记录里记了一份):
 * 想让折线图永远看 30 天的话,改这一个函数就够,别处不用动。
 */
export function trendDates(todayMs: number, range: XhsRange): string[] {
  const days = XHS_RANGE_DAYS[range]
  const today = xhsDateStr(todayMs)
  const out: string[] = []
  for (let back = days - 1; back >= 0; back -= 1) out.push(shiftDate(today, -back))
  return out
}

/**
 * 画折线图要的那一份。**一个点都没有的线仍然回**(`points: []`),
 * 界面据此说「这条线还没有数」——整条缺席的话,界面只能说"没有折线图",
 * 而真相是"有轴、有范围,只是这条线一个点都没取到"。
 */
export function buildTrendView(days: XhsDays, range: XhsRange, todayMs: number): XhsTrendView {
  const dates = trendDates(todayMs, range)
  const rangeKey = XHS_RANGE_KEY[range]
  const series: XhsTrendSeriesView[] = XHS_TREND_DEFS.map((def) => {
    const points: XhsTrendPointView[] = []
    for (const date of dates) {
      const snapshot = days[date]?.[rangeKey]
      if (snapshot === undefined) continue
      const value = trendValueOf(snapshot, def.key)
      if (value === undefined) continue
      points.push({ date, value: value.value, raw: value.raw })
    }
    return { key: def.key, label: def.label, from: def.from, points }
  })
  return { range, dates, series }
}
