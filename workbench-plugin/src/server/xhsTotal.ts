/**
 * 多账号的**合计那一行**(2026-09-22)。**一行 I/O 都没有。**
 *
 * 做法是把 N 个账号的按日快照**合成一份假的「合计账号」的按日快照**,
 * 然后原样交给 `xhsStore.buildRangeView` 与 `xhsTrend.buildTrendView` ——
 * 于是合计那一行的环比怎么算、折线图怎么断线,和单个账号**走的是同一份代码**,
 * 不会出现"账号那一行不画箭头、合计那一行画了"这种自己跟自己打架的情况。
 *
 * ## 哪几项能加,哪几项不能
 *
 * | 指标 | 合计怎么来 | 不能算的时候 |
 * |---|---|---|
 * | 笔记发布数 / 曝光数 / 观看数 / 点赞数 / 收藏数 / 涨粉数 | **直接加** | 只要有**一个**账号缺这一项就整格缺席 |
 * | 封面点击率 | **按曝光加权**(Σ 点击率×曝光 ÷ Σ 曝光)。点击率 = 封面点击 ÷ 曝光,所以加权之后就是真正的总点击率 | 任一账号缺点击率**或**缺曝光数 → 缺席 |
 * | 平均观看时长 | **不算**。时长不能加,要加权得有每个账号的观看数分母,而这一项本来就取不到 | 永远缺席 |
 *
 * ★ **少一个账号就整格缺席**,不是"把有的那几个加起来"。两个号加起来的曝光写在
 * 「合计」那一格上,而其实只算了一个号 —— 那个数看不出来是错的,而且**偏小**,
 * 会把"这周怎么掉了这么多"整条复盘带偏。缺席至少是一句实话。
 *
 * ## 只有一个账号的时候
 *
 * **原样把那个账号的快照交出去**,一个字不改:不加「合计」标、不重新格式化数字。
 * 一个账号的"合计"就是它自己,重新算一遍只会把页面上原样那串(「1.2万」)
 * 改写成我们格式化出来的「12,000」——那是凭空制造一处"和后台对不上"。
 */
import type { XhsMetricKey, XhsMetricValue } from './xhsMetrics.ts'
import { XHS_METRICS } from './xhsMetrics.ts'
import type { XhsDays, XhsRangeKey, XhsSnapshot } from './xhsStore.ts'

/** 合计那一格上自报家门的两句话。界面原样显示,别在界面里另写一份。 */
export const XHS_TOTAL_DERIVED = '合计'
export const XHS_TOTAL_WEIGHTED = '按曝光加权'

/** 一万三千二百 → 「13,200」。**不用 toLocaleString** —— 那一串跟着机器的 ICU 走。 */
export function formatTotalCount(value: number): string {
  const rounded = Math.round(value)
  return String(rounded).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/** 17.46 → 「17.5%」。一位小数,与后台显示的精度一致。 */
export function formatTotalPercent(value: number): string {
  return `${Math.round(value * 10) / 10}%`
}

/**
 * 一个日期 + 一个范围上,N 份快照的合计。
 * **任何一份缺这一项就整项缺席**(见文件头)。
 */
export function totalSnapshotOf(snapshots: readonly XhsSnapshot[]): XhsSnapshot | undefined {
  if (snapshots.length === 0) return undefined
  const metrics: Partial<Record<XhsMetricKey, XhsMetricValue>> = {}

  for (const def of XHS_METRICS) {
    // 时长不能加,也没有分母可加权(见文件头)。
    if (def.kind === 'seconds') continue

    const values = snapshots.map(snapshot => snapshot.metrics[def.key])
    if (values.some(value => value === undefined)) continue

    if (def.kind === 'count') {
      const sum = values.reduce((acc, value) => acc + (value?.value ?? 0), 0)
      metrics[def.key] = { value: sum, raw: formatTotalCount(sum), derived: XHS_TOTAL_DERIVED }
      continue
    }

    // 百分比:按曝光加权。少一个账号的曝光数就算不了 —— 算术平均是错的
    //(一个 100 曝光的号和一个 10 万曝光的号,它们的点击率不能各占一半)。
    const weights = snapshots.map(snapshot => snapshot.metrics.impressions)
    if (weights.some(weight => weight === undefined)) continue
    const denominator = weights.reduce((acc, weight) => acc + (weight?.value ?? 0), 0)
    if (denominator <= 0) continue
    const numerator = values.reduce(
      (acc, value, index) => acc + (value?.value ?? 0) * (weights[index]?.value ?? 0),
      0,
    )
    const weighted = numerator / denominator
    metrics[def.key] = {
      value: weighted,
      raw: formatTotalPercent(weighted),
      derived: XHS_TOTAL_WEIGHTED,
    }
  }

  // 「这份合计是什么时候取的」= 最晚的那一次。
  const at = snapshots.map(snapshot => snapshot.at).sort()[snapshots.length - 1] ?? snapshots[0]?.at ?? ''
  return { at, metrics }
}

/**
 * N 个账号的按日快照 → 一份「合计账号」的按日快照。
 *
 * **某一天某个范围上只要有一个账号没取到,那一天那个范围整个不出现** ——
 * 合计那条折线因此会在那天断掉,而不是画成"那天掉了一半"。
 */
export function mergeDaysForTotal(all: readonly XhsDays[]): XhsDays {
  if (all.length === 0) return {}
  // 一个账号的"合计"就是它自己,原样交出去(见文件头)。
  if (all.length === 1) return all[0] ?? {}

  const out: XhsDays = {}
  const dates = [...new Set(all.flatMap(days => Object.keys(days)))].sort()
  for (const date of dates) {
    for (const rangeKey of ['d7', 'd30'] as const satisfies readonly XhsRangeKey[]) {
      const snapshots = all.map(days => days[date]?.[rangeKey])
      // 少一个账号就不合计这一天(见文件头)。
      if (snapshots.some(snapshot => snapshot === undefined)) continue
      const merged = totalSnapshotOf(snapshots as XhsSnapshot[])
      if (merged === undefined) continue
      out[date] = { ...out[date], [rangeKey]: merged }
    }
  }
  return out
}
