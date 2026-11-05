// @vitest-environment node
/**
 * 「笔记发布数」从按笔记那张表里数出来(src/server/xhsNotesTable.ts)。
 *
 * 这一份守的是同一件事的另一个走样形态:**数不全的时候要空着,不许给一个偏小的数**。
 * 「至少 10 篇」在界面上会被读成「10 篇」,而 10 偏小 —— 一个偏小的笔记发布数
 * 会把「曝光为什么掉了」整条复盘带偏。
 */
import { describe, expect, it } from 'vitest'
import { countNotesPublished, parsePublishedDate, publishedDatesOf } from '../src/server/xhsNotesTable.ts'
import { XHS_NOTE_TABLE_FULL_PAGE_TEXT, XHS_NOTE_TABLE_TEXT } from './xhsPageFixtures.ts'

/** 以 2026-09-22(本地)为今天。近 7 日的下界是 09-16,近 30 日是 08-24。 */
const TODAY = new Date(2026, 8, 22, 12, 0, 0).getTime()

describe('parsePublishedDate:「发布于」后面那一串', () => {
  it('带年份的几种写法', () => {
    expect(parsePublishedDate('2026-09-20', TODAY)).toBe('2026-09-20')
    expect(parsePublishedDate('2026/09/20', TODAY)).toBe('2026-09-20')
    expect(parsePublishedDate('2026年9月20日', TODAY)).toBe('2026-09-20')
  })

  it('不带年份的按今年算', () => {
    expect(parsePublishedDate('09-20', TODAY)).toBe('2026-09-20')
  })

  it('★不带年份、又比今天晚的,是去年那一天(12 月底看「01-03」那种)', () => {
    expect(parsePublishedDate('12-31', TODAY)).toBe('2025-12-31')
  })

  it('读不出来就是读不出来', () => {
    expect(parsePublishedDate('前天', TODAY)).toBeUndefined()
    expect(parsePublishedDate('2026-13-40', TODAY)).toBeUndefined()
  })
})

describe('publishedDatesOf', () => {
  it('把表上每一行的发布日期按出现顺序取出来', () => {
    expect(publishedDatesOf(XHS_NOTE_TABLE_TEXT, TODAY)).toEqual([
      '2026-09-20', '2026-09-18', '2026-08-30',
    ])
  })
})

describe('countNotesPublished:能确定就报数,不能确定就空着', () => {
  it('近 7 日:最老的那一行(08-30)已经掉出范围 → 确切是 2', () => {
    const counted = countNotesPublished(XHS_NOTE_TABLE_TEXT, TODAY, 7)
    expect(counted).toEqual({ ok: true, count: 2, scanned: 3, total: 3 })
  })

  it('近 30 日:「共 3 条」说一共就这些 → 确切是 3', () => {
    const counted = countNotesPublished(XHS_NOTE_TABLE_TEXT, TODAY, 30)
    expect(counted).toEqual({ ok: true, count: 3, scanned: 3, total: 3 })
  })

  it('★第一页 10 行全在范围内、「共 25 条」后面还有 → **缺席**,不报 10', () => {
    const counted = countNotesPublished(XHS_NOTE_TABLE_FULL_PAGE_TEXT, TODAY, 7)
    expect(counted.ok).toBe(false)
    if (counted.ok) return
    expect(counted.why).toContain('偏小')
    expect(counted.why).toContain('共 25 条')
  })

  it('一行「发布于」都没读到 → 缺席,不是 0', () => {
    const counted = countNotesPublished('笔记数据\n共 0 条', TODAY, 7)
    expect(counted.ok).toBe(false)
    if (counted.ok) return
    expect(counted.why).toContain('一条「发布于」都没读到')
  })

  it('★表不是从新到旧排的 → 我们对这张表的假设不成立,整个结果作废', () => {
    const shuffled = [
      '发布于 2026-09-10', '发布于 2026-09-20', '共 2 条',
    ].join('\n')
    const counted = countNotesPublished(shuffled, TODAY, 7)
    expect(counted.ok).toBe(false)
    if (counted.ok) return
    expect(counted.why).toContain('从新到旧')
  })

  it('范围内一篇都没发时**报 0**——那是真的 0(表上最老的一行已经掉出范围)', () => {
    const old = ['发布于 2026-01-02', '发布于 2026-01-01', '共 2 条'].join('\n')
    expect(countNotesPublished(old, TODAY, 7)).toEqual({ ok: true, count: 0, scanned: 2, total: 2 })
  })
})
