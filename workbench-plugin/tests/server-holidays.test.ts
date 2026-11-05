// @vitest-environment node
/**
 * 中国法定节假日与工作日推算(2026-09-20,Ben:「10 月 4 号,智能一点就该知道这是国庆」)。
 *
 * 守住三样:
 *   ① **表里只有法定那几天与农历换算,没有调休** —— 那份年度通知本机没有,不许编。
 *      「不知道」必须**说出来**(`uncertain`),不能悄悄按「没有假期」算。
 *   ② 算不出来的回 undefined,**不回一个 0** —— 0 个工作日和「我没算明白」是两件事。
 *   ③ Ben 那一条具体的:2026-10-04 得认出是国庆假,不能当成普通周日。
 */
import { describe, expect, it } from 'vitest'
import {
  COVERED_YEARS, HOLIDAY_YEARS, calendarBrief, dayVerdict, holidayOn, parseDate, weekdayOf, workdaysBetween,
} from '../src/server/holidays.ts'

describe('日期解析', () => {
  it('只认 YYYY-MM-DD,而且要是真日期', () => {
    expect(parseDate('2026-10-04')).toBe(Date.UTC(2026, 9, 4))
    expect(parseDate('2026-02-30')).toBeUndefined()
    expect(parseDate('2026-13-01')).toBeUndefined()
    expect(parseDate('2026/10/04')).toBeUndefined()
    expect(parseDate('十月四号')).toBeUndefined()
    expect(parseDate(undefined)).toBeUndefined()
  })

  it('星期几', () => {
    expect(weekdayOf('2026-10-04')).toBe('周日')
    expect(weekdayOf('2026-09-20')).toBe('周日')
    expect(weekdayOf('2026-10-01')).toBe('周四')
  })
})

describe('假期表', () => {
  it('每一行都带出处;农历换算来的标「推算」,不冒充确定', () => {
    for (const year of COVERED_YEARS) {
      for (const span of HOLIDAY_YEARS[year]?.spans ?? []) {
        expect(span.source).not.toBe('')
        expect(span.source).toContain('放假办法')
        expect(['确定', '推算']).toContain(span.confidence)
      }
    }
    const spring = HOLIDAY_YEARS[2026]?.spans.find(span => span.name === '春节')
    expect(spring?.confidence).toBe('推算')
    const national = HOLIDAY_YEARS[2026]?.spans.find(span => span.name === '国庆节')
    // 10 月 1–3 日写在法里,不是换算来的。
    expect(national?.confidence).toBe('确定')
  })

  it('**调休一条都没有**,而且两年都明说「通知没录入」——不编一份出来', () => {
    for (const year of COVERED_YEARS) {
      expect(HOLIDAY_YEARS[year]?.makeups).toEqual([])
      expect(HOLIDAY_YEARS[year]?.noticeKnown).toBe(false)
      expect(HOLIDAY_YEARS[year]?.noticeNote).toContain('没录进来')
    }
  })

  it('国庆那三天认得出来;10 月 4 号落在法定段外,但那天是周日(Ben 那条的底)', () => {
    expect(holidayOn('2026-10-01')?.name).toBe('国庆节')
    expect(holidayOn('2026-10-03')?.name).toBe('国庆节')
    expect(dayVerdict('2026-10-04')?.workday).toBe(false)
    expect(dayVerdict('2026-09-28')?.workday).toBe(true)
  })

  it('表外的年份:只按周末判,而且把「不确定」立起来 —— 不外推假期', () => {
    const verdict = dayVerdict('2030-10-01')
    expect(verdict?.workday).toBe(true)
    expect(verdict?.uncertain).toBe(true)
    expect(holidayOn('2030-10-01')).toBeUndefined()
  })
})

describe('workdaysBetween', () => {
  it('算不出来的回 undefined,不回 0', () => {
    expect(workdaysBetween('2026-10-04', '2026-10-01')).toBeUndefined()
    expect(workdaysBetween('胡说', '2026-10-01')).toBeUndefined()
    expect(workdaysBetween('2026-01-01', '2030-01-01')).toBeUndefined()
  })

  it('Ben 那一条:今天(9/20)到报名截止(10/4)', () => {
    const counted = workdaysBetween('2026-09-20', '2026-10-04')
    expect(counted?.days).toBe(15)
    // 9/21–25、9/28–30 是工作日(9/25 中秋放假),10/1–3 国庆,10/4 周日。
    // 逐日数:21/22/23/24 四天 + 28/29/30 三天 = 7 天。
    expect(counted?.workdays).toBe(7)
    expect(counted?.holidays.map(span => span.name)).toEqual(['中秋节', '国庆节'])
    expect(counted?.text).toContain('实际工作日 7 天')
  })

  it('通知没录入时,那句「可能还更少」要跟着数字一起出去', () => {
    const counted = workdaysBetween('2026-09-20', '2026-10-04')
    expect(counted?.uncertain).toBe(true)
    expect(counted?.text).toContain('调休安排')
  })

  it('同一天首尾:一天,工作日按那天自己算', () => {
    expect(workdaysBetween('2026-10-04', '2026-10-04')?.days).toBe(1)
    expect(workdaysBetween('2026-10-04', '2026-10-04')?.workdays).toBe(0)
    expect(workdaysBetween('2026-09-21', '2026-09-21')?.workdays).toBe(1)
  })
})

describe('calendarBrief', () => {
  it('今天几号、接下来的假期、离截止日还剩几个工作日,三样都在', () => {
    const text = calendarBrief('2026-09-20', [{ label: '比赛报名截止', date: '2026-10-04' }]) as string
    expect(text).toContain('2026-09-20(周日)')
    expect(text).toContain('中秋节')
    expect(text).toContain('国庆节')
    expect(text).toContain('比赛报名截止')
    expect(text).toContain('工作日 7 天')
    // 「哪些是推算的、调休没录入」这句必须跟着走。
    expect(text).toContain('推算')
    expect(text).toContain('调休安排')
  })

  it('没有截止日照样有今天与假期;今天读不懂就整格缺席', () => {
    expect(calendarBrief('2026-09-20')).toContain('接下来 90 天')
    expect(calendarBrief('胡说')).toBeUndefined()
  })
})
