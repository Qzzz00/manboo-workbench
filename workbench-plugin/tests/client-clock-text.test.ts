/**
 * 顶栏右端那一行:公历 · 农历 · 时刻(2026-09-26,维护者:「顶部栏右侧只有时间,没有日期,最好公历和农历都要有」)。
 * 农历靠 Intl 自带的中国农历,这里钉几个查得到的日子(万年历):
 *   2026-09-25 = 中秋(八月十五);2026-02-17 = 丙午年正月初一;2025-01-29 = 乙巳年正月初一;2025-07-25 = 闰六月初一。
 */
import { describe, expect, it } from 'vitest'
import { topClockText } from '../src/client/clockText.ts'

/** 本机时区的当天正午,免得夏令时 / 时区把日期挪到前后一天。 */
function noon(y: number, m: number, d: number): string {
  return new Date(y, m - 1, d, 12, 0).toISOString()
}

describe('顶栏那一行:公历 · 农历 · 时刻', () => {
  it('★公历日期、周几、农历、时刻四样都在,用「 · 」隔开', () => {
    const text = topClockText(new Date(2026, 8, 25, 16, 7).toISOString())
    expect(text).toBe('9月25日 周五 · 八月十五 · 16:07')
  })

  it('农历按万年历:正月初一、闰月都认', () => {
    expect(topClockText(noon(2026, 2, 17))).toContain('正月初一')
    expect(topClockText(noon(2025, 1, 29))).toContain('正月初一')
    expect(topClockText(noon(2025, 7, 25))).toContain('闰六月初一')
    expect(topClockText(noon(2026, 9, 26))).toContain('八月十六')
  })

  it('时刻认不出只回 --:--,不编日期', () => {
    expect(topClockText('not-a-date')).toBe('--:--')
    expect(topClockText('')).toBe('--:--')
  })

  it('时刻两位补零', () => {
    expect(topClockText(new Date(2026, 8, 26, 9, 5).toISOString())).toMatch(/ · 09:05$/)
  })
})
