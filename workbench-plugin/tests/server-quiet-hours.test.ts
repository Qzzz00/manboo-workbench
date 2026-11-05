/**
 * 「现在能不能出声」这一处判断(2026-09-26,卡 QH)。
 *
 * 维护者的规矩:**晚上 9 点以后不想被打扰**。09-26 00:19 手机冷启动时首页顶上出现「停止朗读」——
 * 来电那条路早就照免打扰时段只发通知不响铃了,朗读没照它。根因是「时段判断」只长在座机那条路里,
 * 别的出声点各看各的。这份用例守的就是**只有这一处**:时段的两头、跨零点、读不出来怎么办、
 * 到几点恢复,全在 quietHours.ts 里定;来电、朗读、提示音都读它的结论。
 */
import { describe, expect, it } from 'vitest'
import { inQuietHours, parseClock, quietViewOf, QUIET_REASON } from '../src/server/quietHours.ts'
import {
  inQuietHours as inQuietHoursFromCallOut,
  parseClock as parseClockFromCallOut,
} from '../src/server/callOut.ts'

describe('parseClock', () => {
  it('读得出 HH:MM', () => {
    expect(parseClock('21:00')).toBe(21 * 60)
    expect(parseClock('08:30')).toBe(8 * 60 + 30)
    expect(parseClock('0:05')).toBe(5)
  })

  it('★读不出来回 undefined,不猜一个 0(那是午夜,会把整晚静音)', () => {
    expect(parseClock('八点')).toBeUndefined()
    expect(parseClock('24:00')).toBeUndefined()
    expect(parseClock('21:60')).toBeUndefined()
    expect(parseClock(2100)).toBeUndefined()
    expect(parseClock(undefined)).toBeUndefined()
  })
})

describe('inQuietHours', () => {
  it('★跨零点是常态:21:00–08:30 在夜里两头都算', () => {
    expect(inQuietHours(new Date('2026-09-26T00:19:00'), '21:00', '08:30')).toBe(true)
    expect(inQuietHours(new Date('2026-09-25T21:00:00'), '21:00', '08:30')).toBe(true)
    expect(inQuietHours(new Date('2026-09-26T08:29:00'), '21:00', '08:30')).toBe(true)
    expect(inQuietHours(new Date('2026-09-26T08:30:00'), '21:00', '08:30')).toBe(false)
    expect(inQuietHours(new Date('2026-09-26T14:00:00'), '21:00', '08:30')).toBe(false)
  })

  it('不跨零点的时段照常', () => {
    expect(inQuietHours(new Date('2026-09-26T13:30:00'), '13:00', '14:00')).toBe(true)
    expect(inQuietHours(new Date('2026-09-26T14:00:00'), '13:00', '14:00')).toBe(false)
  })

  it('★读不出来就不静音——不许替他把声音关掉,那会让他以为坏了', () => {
    expect(inQuietHours(new Date('2026-09-26T00:19:00'), '八点', '08:30')).toBe(false)
    expect(inQuietHours(new Date('2026-09-26T00:19:00'), '21:00', '')).toBe(false)
  })

  it('两头相等 = 整天静默(他真想那样就随他)', () => {
    expect(inQuietHours(new Date('2026-09-26T14:00:00'), '21:00', '21:00')).toBe(true)
  })
})

describe('quietViewOf:/state 里那一格', () => {
  it('★时段内:active + 到几点恢复 + 一句人话', () => {
    const view = quietViewOf({ at: new Date('2026-09-26T00:19:00'), from: '21:00', to: '08:30' })
    expect(view).toEqual({ active: true, from: '21:00', to: '08:30', until: '08:30', reason: QUIET_REASON })
  })

  it('★时段外:active 为 false,时段两头照样带着(设置里要显示、界面要说「几点起不出声」)', () => {
    const view = quietViewOf({ at: new Date('2026-09-26T14:00:00'), from: '21:00', to: '08:30' })
    expect(view).toEqual({ active: false, from: '21:00', to: '08:30' })
    expect(view.until).toBeUndefined()
    expect(view.reason).toBeUndefined()
  })

  it('★跨天两侧同一格:昨晚 23:00 与今早 08:00 都说「08:30 后恢复」', () => {
    for (const at of ['2026-09-25T23:00:00', '2026-09-26T08:00:00']) {
      const view = quietViewOf({ at: new Date(at), from: '21:00', to: '08:30' })
      expect(view.active).toBe(true)
      expect(view.until).toBe('08:30')
    }
  })

  it('★时段读不出来:不静音,而且**不编一个时段**出来', () => {
    const view = quietViewOf({ at: new Date('2026-09-26T00:19:00'), from: '不知道', to: '08:30' })
    expect(view).toEqual({ active: false })
  })
})

describe('★只有这一处判断', () => {
  it('座机那条路上的 parseClock / inQuietHours 就是 quietHours.ts 里的同一个函数', () => {
    expect(parseClockFromCallOut).toBe(parseClock)
    expect(inQuietHoursFromCallOut).toBe(inQuietHours)
  })
})
