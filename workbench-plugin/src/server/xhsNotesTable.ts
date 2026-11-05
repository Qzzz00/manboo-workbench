/**
 * 「笔记发布数」从**按笔记的那张表**里数出来(2026-09-22)。**一行 I/O 都没有。**
 *
 * ## 为什么要数
 *
 * 首页(`/new/home`)的账号总览里**没有**「笔记发布数」这一项 —— 2026-09-22 实测。
 * 有的是 `/statistics/data-analysis` 那张按笔记的表:一行一篇笔记,每行带一个
 * 「发布于 <日期>」,底下是分页(「10 条/页」「共 N 条,N 页」)。
 * 所以这一项只能**数**:范围内有几行,就是发了几篇。
 *
 * ## ★ 数不全的时候**缺席**,不给一个偏小的数
 *
 * 我们只读第一页(翻页要点「下一页」,而且每翻一页就多一次请求)。于是:
 *
 * | 第一页看到的 | 能不能确定 | 怎么办 |
 * |---|---|---|
 * | 最老的那一行已经**掉出**范围 | 能。表是倒序的,后面只会更老 | 报确切的数 |
 * | 「共 N 条」里的 N ≤ 第一页的行数 | 能。一共就这些 | 报确切的数 |
 * | 第一页 10 行**全在**范围内、后面还有页 | **不能**。第 11 篇可能也在范围内 | **缺席**,并说清为什么 |
 * | 一行「发布于」都没有 | 不能 | 缺席 |
 * | 日期不是从新到旧 | 不能(我们对"倒序"的假设不成立了) | 缺席 |
 *
 * 第三行那一格是这个文件存在的全部理由。「至少 10 篇」在界面上会被读成「10 篇」,
 * 而 10 是**偏小**的 —— 一个偏小的笔记发布数会让「曝光数为什么掉了」的复盘整个跑偏。
 * 宁可那一格写「数不全」。
 *
 * ## 对表的两条假设(写明,免得下一个人当成事实)
 *
 * 1. **表按发布时间从新到旧排**。这是创作者后台的默认排序,但它是个假设,
 *    所以代码里有一道自检:日期只要不是非递增的,整个结果作废。
 * 2. **「发布于」这三个字跟着日期**。改版换了措辞就一行都数不出来 → 缺席,不是 0。
 */
import { shiftDate, xhsDateStr } from './xhsStore.ts'

/** 数出来的结果。**要么是确切的数,要么是一句"为什么数不了"**,没有第三种。 */
export type XhsNoteCount
  = { ok: true, count: number, scanned: number, total?: number }
    | { ok: false, why: string }

/** 「发布于 2026-09-20」「发布于 09-20」「发布于 2026年9月20日」都认。 */
const PUBLISHED_AT = /发布于[\s:：]*((?:\d{4}[-/年])?\d{1,2}[-/月]\d{1,2}日?)/g

/** 「共 12 条」。拿它判断第一页是不是已经把全部行都看见了。 */
const TOTAL_ROWS = /共\s*(\d+)\s*条/

/**
 * 把表里那串日期读成 `YYYY-MM-DD`。
 *
 * 没写年份的(`09-20`)按**今天所在的年**算;算出来比今天还晚就往前退一年
 * (12 月底看「01-03」那种)。读不出来回 undefined。
 */
export function parsePublishedDate(raw: string, todayMs: number): string | undefined {
  const cleaned = raw.replace(/日$/, '')
  const full = /^(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})$/.exec(cleaned)
  const pad = (n: number): string => String(n).padStart(2, '0')
  if (full !== null) {
    const y = Number(full[1]); const m = Number(full[2]); const d = Number(full[3])
    if (m < 1 || m > 12 || d < 1 || d > 31) return undefined
    return `${y}-${pad(m)}-${pad(d)}`
  }
  const short = /^(\d{1,2})[-/月](\d{1,2})$/.exec(cleaned)
  if (short === null) return undefined
  const m = Number(short[1]); const d = Number(short[2])
  if (m < 1 || m > 12 || d < 1 || d > 31) return undefined
  const today = xhsDateStr(todayMs)
  const year = Number(today.slice(0, 4))
  const guess = `${year}-${pad(m)}-${pad(d)}`
  return guess > today ? `${year - 1}-${pad(m)}-${pad(d)}` : guess
}

/** 表上所有「发布于」的日期,按出现顺序。 */
export function publishedDatesOf(pageText: string, todayMs: number): string[] {
  const out: string[] = []
  for (const match of pageText.matchAll(PUBLISHED_AT)) {
    const date = parsePublishedDate(match[1] ?? '', todayMs)
    if (date !== undefined) out.push(date)
  }
  return out
}

/**
 * 范围内发了几篇。`days` = 7 或 30(含今天往回数)。
 *
 * 看文件头那张表:确定不了就 `{ ok: false, why }`,界面把 why 原样说出来。
 */
export function countNotesPublished(pageText: string, todayMs: number, days: number): XhsNoteCount {
  const dates = publishedDatesOf(pageText, todayMs)
  if (dates.length === 0) {
    return { ok: false, why: '按笔记的表上一条「发布于」都没读到(后台换了措辞?)' }
  }

  // 自检:必须是从新到旧。不是的话我们对这张表的假设就不成立了,整个结果作废。
  for (let i = 1; i < dates.length; i++) {
    if ((dates[i] ?? '') > (dates[i - 1] ?? '')) {
      return { ok: false, why: '按笔记的表不是按发布时间从新到旧排的,这一页数不准' }
    }
  }

  const floor = shiftDate(xhsDateStr(todayMs), -(days - 1))
  const inWindow = dates.filter(date => date >= floor).length
  const totalMatch = TOTAL_ROWS.exec(pageText)
  const total = totalMatch === null ? undefined : Number(totalMatch[1])

  // 看全了:要么最老的那一行已经掉出范围,要么「共 N 条」说一共就这些。
  const sawOldestOutside = inWindow < dates.length
  const sawEveryRow = total !== undefined && Number.isFinite(total) && dates.length >= total
  if (sawOldestOutside || sawEveryRow) {
    return {
      ok: true,
      count: inWindow,
      scanned: dates.length,
      ...(total === undefined || !Number.isFinite(total) ? {} : { total }),
    }
  }

  return {
    ok: false,
    why: `按笔记的表第一页 ${dates.length} 行全在这个范围内${total === undefined ? '' : `(共 ${total} 条)`}，`
      + '后面还有没翻,数出来只会偏小 —— 宁可空着',
  }
}
