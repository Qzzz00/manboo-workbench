/**
 * 「数据复盘」那一格**的那几份口径与零件**。
 *
 * ★ 2026-10-03:这一格的组件本体是**运营同学(Air)自己写的那一份**,在
 * `src/client/air/review.js`(原件 `contrib/air-20261002/src/review.js`)。
 * 维护者当日原话:「有现成的代码不用,非要去重新开发……你就把他之前的代码,原封不动在下一次更新里替换进去。」
 * 这里留下的是**她那份代码引用的东西**(`REVIEW_RANGES` / `AccountsTable` / `reviewHasValue`)
 * 与这一格一路攒下来的口径常量 —— 她那一格里要显示哪几种实话,由她那份代码说了算。
 *
 * ## 为什么每个数显示的是「页面上原样那串」
 *
 * 后台写的是「9.9万」,我们存的是 99000。界面显示的是**他在后台看到的那一串** ——
 * 换算回来的 99,000 和后台对不上时,他会以为我们算错了,而其实我们只是换了个写法。
 * 换算出来的那个数只用来算涨跌。
 *
 * ## 这里有几样她那一版用不到了
 *
 * `TrendChart` / `deltaOf` / `TREND_*` / 那几句占位文案是 09-21~09-22 那几版的零件。
 * 她那一格自己画趋势、自己摆关键数字,所以它们此刻**没有消费方**。
 * 留着没删:它们是独立的纯函数/纯组件,各自带着一整份用例与口径注释,
 * 而「这一格以后还要不要折线图」是另一张卡的事(见 docs/交接-1003-运营同学六组件原封接入.md)。
 */
import type { ReactNode } from 'react'
import type {
  XhsAccountView, XhsMetricView, XhsRangeView, XhsTrendSeriesView, XhsTrendView,
} from '../protocol.ts'
import {
  TREND_VIEW_H, TREND_VIEW_W, trendPathD, trendRange, trendScale, trendSegments, trendShowDots, trendX, trendY,
} from './trendChart.ts'

/** 数据范围。Ben 草图上就这两个,与 server/xhsMetrics.ts 的 XHS_RANGES 同一份口径。 */
export const REVIEW_RANGES = ['近 7 日', '近 30 日'] as const
export type ReviewRange = typeof REVIEW_RANGES[number]

/**
 * 还没接上自取服务时(`/state.xhs` 整块缺席)说的那一句。
 * 展示台、手机、以及一大批用例走的都是这一支。
 */
export const REVIEW_NOT_WIRED_LINE = '数据看板还没接上。接上之后这里会按上面的范围显示下面这些数,并给一份优化建议。'

/** 登录了但这个范围一个数都没有时那一句。 */
export const REVIEW_NO_RANGE_LINE = '这个范围还没接上。'

/** 某一项后台没给时,那一格里写的字。**不是 0,也不是「—」**。 */
export const REVIEW_METRIC_MISSING = '后台没有这项'

/**
 * 那一项**平台本来就不给**时写的字(2026-09-22)。
 * 与「后台没有这项」分开:一个是"这次没取到",一个是"这一项平台根本没有"。
 * 旁边跟着服务端给的那一句 `why`,把为什么说清楚。
 */
export const REVIEW_METRIC_NOT_GIVEN = '平台没给'

/** 账号表里那一格空着时写的字。表里地方小,只能短 —— 完整的原因在 title 上。 */
export const REVIEW_CELL_NONE = '没给'

/** 账号表的标题。**每个账号一行 + 合计一行**(Ben 2026-09-22 要的就是这个)。 */
export const REVIEW_ACCOUNTS_CAPTION = '每个账号一行,最后一行是合计'

/** 这个账号这个范围一个数都没有时,那一行写的字。 */
export const REVIEW_ACCOUNT_NO_DATA = '这个账号这个范围还没有数'

/** 合计那一行的名字。 */
export const REVIEW_TOTAL_ROW = '合计'

/** 还没登录时那一句。指的是设置里他真能点到的那一步。 */
export const REVIEW_NOT_LOGGED_IN_LINE = '还没接上创作者中心 —— 去设置 → 额度凭据,点「登录小红书创作者中心」登一次。'

/**
 * ★ **这一格摆不摆这一项**(原件:`contrib/air-20261002/src/review.js` 旁边那一份
 * `patches/changes.json` 的 `client-10`,2026-10-03 原封不动接入)。
 *
 * 她的原话口径是「移除不可采集项」。判据是她写的这一条,**一个字没改**,只补了类型:
 * 名单里那两项(`notes` / `avg_watch`,以及它们的中文名)不摆,**而且**没有有限的 `value`、
 * 没有 `raw`、`raw` 是空白的也不摆。
 *
 * 为什么那两项平台结构上就不给:见 server/xhsMetrics.ts 的 `source: 'none'` 与
 * `AVG_WATCH_ABSENT_WHY`。**服务端那份定义一个字不改** —— `/state.xhs` 是对外口径,
 * 别的消费方(交接、建议、按笔记的表)还在读它,只有这一格不显示。
 */
export function reviewHasValue(metric: XhsMetricView | undefined | null): boolean {
  return metric != null && !['notes', 'avg_watch'].includes(metric.key)
    && !['笔记发布数', '平均观看时长'].includes(metric.label)
    && Number.isFinite(metric.value) && metric.raw != null && String(metric.raw).trim() !== ''
}

/**
 * 接上之前用来占位的那几个名字 —— 取自 Ben 的运营草图,**去掉上面那两项不可采集的**。
 * 接上之后显示的是服务端回的 `metrics[].label`(同一批字,由服务端那一份定义说了算)。
 */
export const REVIEW_METRICS = [
  '曝光数', '观看数', '封面点击率',
  '点赞数', '收藏数', '涨粉数',
] as const

/**
 * 与上一周期比,画哪个箭头、说哪句话。
 *
 * **上一周期没有就整块缺席** —— 不画一个"持平"的横杠:那会让人以为真的持平了。
 */
export function deltaOf(
  metric: XhsMetricView,
): { arrow: string, text: string, dir: 'up' | 'down' | 'flat' } | undefined {
  if (metric.value === undefined || metric.prev === undefined) return undefined
  const diff = metric.value - metric.prev.value
  const dir = diff > 0 ? 'up' : diff < 0 ? 'down' : 'flat'
  const arrow = dir === 'up' ? '↑' : dir === 'down' ? '↓' : '→'
  // 上期是 0 时"涨了百分之多少"没有意义,只说上期原样那串(同 server/xhsAdvice.ts)。
  const percent = metric.prev.value === 0 ? undefined : Math.round((diff / Math.abs(metric.prev.value)) * 100)
  const text = percent === undefined
    ? `上期 ${metric.prev.raw}`
    : `${percent > 0 ? '+' : ''}${percent}% · 上期 ${metric.prev.raw}`
  return { arrow, text, dir }
}

/** 折线图上面那一行小字。**口径要写出来** —— 每个点是"那天取到的近 N 日那一份",不是日增量。 */
export const TREND_BASIS_LINE = '每个点 = 那天取到的「{range}」那一份(后台给的本来就是聚合值,不是当天的量);没取到的那天不连线。'

/** 这条线一个点都没有时那一格里写的字。**不是 0、不是空白**。 */
export const TREND_SERIES_EMPTY = '这条线还没有数'

/** 折线图整块都没有数时那一句(三条线都空)。 */
export const TREND_ALL_EMPTY = '还没有按日快照,画不出折线图 —— 取过两天以上就有线了。'

/**
 * 一条线 = 一张小图(为什么不是一张图三条线,见 client/trendChart.ts 的文件头:
 * 量级差着两三个数量级,共用一根 y 轴会把涨粉压成一条直线;双 y 轴一律不用)。
 */
function TrendRow({ series, dates }: { series: XhsTrendSeriesView, dates: readonly string[] }) {
  const scale = trendScale(series.points)
  const edge = trendRange(series.points)
  const last = series.points[series.points.length - 1]
  const dots = trendShowDots(series.points)
  return (
    <li className="ben-wb__trend-row" data-empty={series.points.length === 0}>
      <div className="ben-wb__trend-head">
        <span className="ben-wb__trend-name">{series.label}</span>
        {last === undefined
          ? <span className="ben-wb__trend-none">{TREND_SERIES_EMPTY}</span>
          : <span className="ben-wb__trend-last">{last.raw}</span>}
      </div>
      {scale !== undefined && edge !== undefined && (
        <div className="ben-wb__trend-plot">
          <svg
            className="ben-wb__trend-svg"
            viewBox={`0 0 ${TREND_VIEW_W} ${TREND_VIEW_H}`}
            preserveAspectRatio="none"
            role="img"
            aria-label={`${series.label}:${dates[0] ?? ''} 到 ${dates[dates.length - 1] ?? ''},取到 ${series.points.length} 天;最低 ${edge.low.raw},最高 ${edge.high.raw}`}
          >
            {/* 底边一根很淡的轴线。网格线一条都没有 —— 40px 高的图里,网格比数据还显眼。 */}
            <path className="ben-wb__trend-axis" d={`M 0 ${TREND_VIEW_H - 0.5} L ${TREND_VIEW_W} ${TREND_VIEW_H - 0.5}`} vectorEffect="non-scaling-stroke" />
            {trendSegments(dates, series.points).map(segment => (
              <path
                key={`${segment[0]?.index ?? 0}`}
                className="ben-wb__trend-line"
                d={trendPathD(segment, dates.length, scale)}
                vectorEffect="non-scaling-stroke"
                fill="none"
              />
            ))}
            {series.points.map((point) => {
              const index = dates.indexOf(point.date)
              if (index === -1) return null
              const x = trendX(index, dates.length)
              const y = trendY(point.value, scale)
              return (
                <g key={point.date}>
                  {dots && (
                    <path className="ben-wb__trend-dot" d={`M ${x} ${y} L ${x} ${y}`} vectorEffect="non-scaling-stroke" />
                  )}
                  {/* 看不见的大靶子:鼠标停上去有原生提示,**每一天都有**(可见的点太多时不画)。 */}
                  <path className="ben-wb__trend-hit" d={`M ${x} ${y} L ${x} ${y}`} vectorEffect="non-scaling-stroke">
                    <title>{`${point.date} · ${point.raw}`}</title>
                  </path>
                </g>
              )
            })}
          </svg>
          <div className="ben-wb__trend-edge">
            <span>{`高 ${edge.high.raw}`}</span>
            <span>{`低 ${edge.low.raw}`}</span>
          </div>
        </div>
      )}
      {/* 依据:这条线是从快照里哪几项来的。互动那条写着"点赞数 + 收藏数",他能自己核。 */}
      <span className="ben-wb__trend-from">{`来自:${series.from.join(' + ')}`}</span>
    </li>
  )
}

export function TrendChart({ trend }: { trend: XhsTrendView }) {
  const empty = trend.series.every(series => series.points.length === 0)
  const first = trend.dates[0]
  const last = trend.dates[trend.dates.length - 1]
  return (
    <div className="ben-wb__trend">
      <p className="ben-wb__trend-basis">{TREND_BASIS_LINE.replace('{range}', trend.range)}</p>
      {empty
        ? <p className="ben-wb__review-note">{TREND_ALL_EMPTY}</p>
        : (
            <>
              <ul className="ben-wb__trend-rows" aria-label={`${trend.range}的折线图`}>
                {trend.series.map(series => <TrendRow key={series.key} series={series} dates={trend.dates} />)}
              </ul>
              <div className="ben-wb__trend-axis-labels">
                <span>{first}</span>
                <span>{last}</span>
              </div>
            </>
          )}
    </div>
  )
}

/**
 * 每个账号一行 + 合计一行(2026-09-22)。
 *
 * **只有两个以上账号时才出现**:一个账号的时候这张表的每一行都和上面那八格一模一样,
 * 摆两遍只是在一格本来就不大的地方占地方。
 *
 * 空着的那一格写「没给」而不是 `—` 或 `0`:表里地方小,完整那一句放在 `title` 上
 * (鼠标停上去看得见),而 `0` 会被直接读成"这个号这周一个赞都没有"。
 */
export function AccountsTable({
  accounts, total, range,
}: {
  accounts: readonly XhsAccountView[]
  /** 合计那一行(服务端算的,`XhsView.ranges`)。取不到就不画那一行。 */
  total?: XhsRangeView
  range: string
}) {
  /*
   * 列头那一段是她改的(原件:`contrib/air-20261002/patches/changes.json` 的 `client-11`,
   * 2026-10-03 原封不动接入)。上一版只看合计那一行、合计缺席时退回**任一**账号那一行;
   * 她改成把合计与**所有**账号那几行并起来、按 `reviewHasValue` 筛、按 key 去重 ——
   * 某个账号独有的那一项也有列,而真的一项都没有时整张表不画。
   */
  const available = [...(total?.metrics ?? []), ...accounts.flatMap(item => item.ranges.find(r => r.range === range)?.metrics ?? [])]
  const columns = [...new Map(available.filter(reviewHasValue).map(metric => [metric.key, metric])).values()]
  if (columns.length === 0) return null

  const cellOf = (metric: XhsMetricView | undefined) => {
    if (metric === undefined || metric.raw === undefined) {
      return (
        <span className="ben-wb__review-acc-none" title={metric?.why ?? REVIEW_METRIC_MISSING}>
          {REVIEW_CELL_NONE}
        </span>
      )
    }
    return (
      <span className="ben-wb__review-acc-num" title={metric.derived ?? ''}>
        {metric.raw}
        {metric.derived !== undefined && <i className="ben-wb__review-acc-derived">{metric.derived}</i>}
      </span>
    )
  }

  return (
    <table className="ben-wb__review-accounts">
      <caption>{REVIEW_ACCOUNTS_CAPTION}</caption>
      <thead>
        <tr>
          <th scope="col">账号</th>
          {columns.map(metric => <th scope="col" key={metric.key}>{metric.label}</th>)}
        </tr>
      </thead>
      <tbody>
        {accounts.map((account) => {
          const row = account.ranges.find(item => item.range === range)
          return (
            <tr key={account.profile} data-connected={account.connected}>
              <th scope="row">
                {account.name}
                {/* 对上运营模板那边的账号文件夹就挂个钩;对不上就没有这一块(不强绑)。 */}
                {account.account_dir !== undefined && (
                  <i className="ben-wb__review-acc-dir">{`账号/${account.account_dir}`}</i>
                )}
                {!account.connected && <i className="ben-wb__review-acc-off">未登录</i>}
              </th>
              {row === undefined
                ? <td colSpan={columns.length}>{REVIEW_ACCOUNT_NO_DATA}</td>
                : columns.map(column => (
                    <td key={column.key}>{cellOf(row.metrics.find(item => item.key === column.key))}</td>
                  ))}
            </tr>
          )
        })}
        {total !== undefined && (
          <tr data-total="true">
            <th scope="row">{REVIEW_TOTAL_ROW}</th>
            {columns.map(column => (
              <td key={column.key}>{cellOf(total.metrics.find(item => item.key === column.key))}</td>
            ))}
          </tr>
        )}
      </tbody>
    </table>
  )
}
