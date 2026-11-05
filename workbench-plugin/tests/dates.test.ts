import { describe, expect, it } from 'vitest'
import { daysLeftFromNow, localDateStr } from '../src/client/dates.ts'

describe('daysLeftFromNow(单一实现，spec D3/D10/D11)', () => {
  it('正常：未来日期返回正整数天数', () => {
    const nowSec = Date.parse('2026-08-20T12:00:00.000Z') / 1000
    expect(daysLeftFromNow('2026-08-25', nowSec)).toBe(5)
  })

  it('正常：过去日期返回负数', () => {
    const nowSec = Date.parse('2026-08-20T12:00:00.000Z') / 1000
    expect(daysLeftFromNow('2026-08-15', nowSec)).toBe(-5)
  })

  it('跨年：12 月底到次年 1 月初，按自然日算，不因跨年出错', () => {
    const nowSec = Date.parse('2026-12-30T00:00:00.000Z') / 1000
    expect(daysLeftFromNow('2027-01-02', nowSec)).toBe(3)
  })

  it('坏日期：解析不出 YYYY-MM-DD → 统一回 +Infinity（不是 0，不是 NaN）', () => {
    const nowSec = Date.parse('2026-08-20T12:00:00.000Z') / 1000
    expect(daysLeftFromNow('not-a-date', nowSec)).toBe(Number.POSITIVE_INFINITY)
    expect(daysLeftFromNow('', nowSec)).toBe(Number.POSITIVE_INFINITY)
    // 单位数月/日（缺前导零）不匹配 \d{4}-\d{2}-\d{2}，同样按"解析失败"处理，
    // 不是这个函数的合法输入格式（各调用方存的 DDL 日期统一是补零的 ISO 日期）。
    expect(daysLeftFromNow('2026-8-5', nowSec)).toBe(Number.POSITIVE_INFINITY)
  })
})

describe('localDateStr(整分支终审 I2:门槛①的"今天"必须按本地时区切)', () => {
  /**
   * 两个方向各钉一条,合起来在任何非零时区偏移下都能抓住"改回 UTC"这个退化:
   *   - 本地 00:30:东八区(以及所有东半球时区)此刻 UTC 还停在**昨天**;
   *   - 本地 23:30:西半球时区此刻 UTC 已经跳到**明天**。
   * (恰好跑在 UTC±0 的机器上时两条都抓不住——那种时区下 UTC 与本地本来就同一天,
   *  没有任何测试能区分两种实现。这是这条断言诚实的能力边界。)
   */
  it('本地当天的头尾两端都算作同一天,不跟着 UTC 跳', () => {
    expect(localDateStr(new Date(2026, 7, 26, 0, 30, 0).getTime())).toBe('2026-08-26')
    expect(localDateStr(new Date(2026, 7, 26, 23, 30, 0).getTime())).toBe('2026-08-26')
  })

  it('补零:个位数月/日照样是两位(不能出现 2026-8-6 这种解析不了的形状)', () => {
    expect(localDateStr(new Date(2026, 0, 6, 12, 0, 0).getTime())).toBe('2026-01-06')
  })
})
