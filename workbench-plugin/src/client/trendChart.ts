/**
 * 折线图的**几何**(2026-09-21)。纯函数:点位进、坐标出,一个 DOM 都不碰,
 * 所以「缺的那天断不断线」「只有一个点画成什么样」这种一错就看不出来的事能直接对。
 *
 * 画在 `ReviewModule.tsx` 里,**自己画 SVG,不引图表库**(卡里钉死的)。
 *
 * ## 三条线为什么是三张小图,不是一张图三条线
 *
 * 观看数是几万,涨粉是几十。同一根 y 轴上,涨粉那条会紧贴着底边成为一条直线 ——
 * 看着像"一直没涨粉",而真相是它跟观看数不在一个量级。
 * 另一条常见的走法是**双 y 轴**:那是图表里最容易骗人的做法(两条线的交叉点由轴的缩放
 * 决定,而不是由数据决定),一律不用。
 * 所以三条线各占一张小图、各有自己的纵向范围,**每张图上把自己的最高/最低写出来**。
 *
 * ## 纵向范围不从 0 起
 *
 * 观看数在 48000~52000 之间起伏时,从 0 起的那张图是一条直线。这里按**数据自己的
 * 最小~最大**铺满,并且把这两个数原样写在图旁边 —— 轴被截断这件事因此是**写明的**,
 * 不是藏着的(柱状图不许这么干,折线图写明了可以)。
 *
 * ## 坐标系
 *
 * viewBox 固定 `0 0 300 40`,外层 `preserveAspectRatio="none"` 横向拉满格子宽度。
 * 于是所有线条都要 `vector-effect="non-scaling-stroke"`,不然横向一拉,线就变粗了。
 * 点画成"零长度 + 圆头"的线段(`M x y L x y`),也是为了躲开这次非等比缩放 ——
 * 真画一个 `<circle>` 会被拉成椭圆。
 */
import type { XhsTrendPointView } from '../protocol.ts'

/** 画布(viewBox 单位)。高度 40 是量出来的:三张图 + 轴标在横屏那一格里刚好不挤。 */
export const TREND_VIEW_W = 300
export const TREND_VIEW_H = 40
/** 上下留白:线贴着边缘时圆头点会被裁掉一半。 */
export const TREND_PAD_Y = 5

/** 点多到这个数以上就不画可见的点了(30 天那一档画出来是一串珠子,看不清线)。 */
export const TREND_DOT_MAX = 10

export interface TrendScale {
  min: number
  max: number
  /** 最高最低一样(或只有一个点)时为 true:线画在中间,而不是贴着上边或下边。 */
  flat: boolean
}

/** 这条线的纵向范围。**一个点都没有时回 undefined** —— 没有范围就没有图。 */
export function trendScale(points: readonly XhsTrendPointView[]): TrendScale | undefined {
  if (points.length === 0) return undefined
  let min = points[0]?.value ?? 0
  let max = min
  for (const point of points) {
    if (point.value < min) min = point.value
    if (point.value > max) max = point.value
  }
  return { min, max, flat: max === min }
}

/**
 * 把点按**日历上是否相邻**切成几段。缺一天就断一段 —— 断开的地方界面上是真的断开,
 * 不连线、不补 0(卡里钉死的那一条)。
 *
 * @param dates 完整的日历轴(升序)。点里出现了轴上没有的日期时,那个点**丢掉**
 *              (轴是服务端按范围算的,对不上说明两头口径不一致,画上去只会误导)。
 */
export function trendSegments(
  dates: readonly string[],
  points: readonly XhsTrendPointView[],
): { index: number, point: XhsTrendPointView }[][] {
  const at = new Map<string, number>()
  dates.forEach((date, index) => at.set(date, index))
  const segments: { index: number, point: XhsTrendPointView }[][] = []
  let current: { index: number, point: XhsTrendPointView }[] = []
  let previous: number | undefined
  for (const point of points) {
    const index = at.get(point.date)
    if (index === undefined) continue
    if (previous !== undefined && index !== previous + 1) {
      if (current.length > 0) segments.push(current)
      current = []
    }
    current.push({ index, point })
    previous = index
  }
  if (current.length > 0) segments.push(current)
  return segments
}

/** 第 index 天在横轴上的 x。只有一天时摆中间(0 会贴着左边缘,看着像被裁了)。 */
export function trendX(index: number, total: number): number {
  if (total <= 1) return TREND_VIEW_W / 2
  return (index / (total - 1)) * TREND_VIEW_W
}

/** 一个值在纵轴上的 y。**大的在上**(SVG 的 y 向下,所以这里要翻一次)。 */
export function trendY(value: number, scale: TrendScale): number {
  const usable = TREND_VIEW_H - TREND_PAD_Y * 2
  if (scale.flat) return TREND_PAD_Y + usable / 2
  return TREND_PAD_Y + (1 - (value - scale.min) / (scale.max - scale.min)) * usable
}

/** 一段的 `d`。一个点的那一段也回一条零长度线段(配圆头 = 一个点)。 */
export function trendPathD(
  segment: readonly { index: number, point: XhsTrendPointView }[],
  total: number,
  scale: TrendScale,
): string {
  if (segment.length === 0) return ''
  const xy = segment.map(item => `${round(trendX(item.index, total))} ${round(trendY(item.point.value, scale))}`)
  const head = xy[0] as string
  // 单点:`M x y L x y` —— 圆头描边会把它画成一个点。
  if (xy.length === 1) return `M ${head} L ${head}`
  return `M ${head} ${xy.slice(1).map(p => `L ${p}`).join(' ')}`
}

/** 坐标保留一位小数:SVG 属性里一串 15 位浮点数,diff 和用例都没法看。 */
function round(value: number): number {
  return Math.round(value * 10) / 10
}

/** 这条线画不画可见的点。点太多时只画线(见 TREND_DOT_MAX)。 */
export function trendShowDots(points: readonly XhsTrendPointView[]): boolean {
  return points.length > 0 && points.length <= TREND_DOT_MAX
}

/**
 * 图旁边那两个数:最高 / 最低(原样那串)。
 *
 * 回的是**页面上原样那串**(`raw`),不是归一化的值 —— 同 ReviewModule 那八格的道理:
 * 后台写「9.9万」,我们显示 99000 的话,他会以为我们算错了。
 */
export function trendRange(points: readonly XhsTrendPointView[]): { low: XhsTrendPointView, high: XhsTrendPointView } | undefined {
  if (points.length === 0) return undefined
  let low = points[0] as XhsTrendPointView
  let high = low
  for (const point of points) {
    if (point.value < low.value) low = point
    if (point.value > high.value) high = point
  }
  return { low, high }
}
