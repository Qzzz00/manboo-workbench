// @vitest-environment node
/**
 * DeepSeek 峰谷时段(2026-09-09,借 dsh-save-money 的时间窗语义,只借概念不装不抄)。
 *
 * 纪律:只判「现在是高峰还是低谷、下一次何时切换」,**不自动暂停任何任务**——
 * 那是 save-money 的主功能,我们的规矩是不替 Ben 做决定(设计-借鉴功能落位 §二)。
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_PEAK_SCHEDULE, peakPhase, validatePeakSchedule } from '../src/quota/peakHours.ts'

const TZ = 'Asia/Shanghai'
const at = (clock: string) => new Date(`2026-09-09T${clock}:00+08:00`)

describe('峰谷判定(默认时间表:高峰 08:58–12:02 / 13:58–18:02,按本机时区)', () => {
  it('默认时间表就是 DeepSeek 官方那两段', () => {
    expect(DEFAULT_PEAK_SCHEDULE.periods).toEqual([
      { start: '08:58', end: '12:02' },
      { start: '13:58', end: '18:02' },
    ])
  })

  it('上午高峰段内:高峰,12:02 转低谷', () => {
    expect(peakPhase(at('10:30'), DEFAULT_PEAK_SCHEDULE, TZ)).toEqual({
      phase: 'peak', next_phase: 'offpeak', next_switch: '12:02',
    })
  })

  it('午休段:低谷,13:58 转高峰', () => {
    expect(peakPhase(at('12:30'), DEFAULT_PEAK_SCHEDULE, TZ)).toEqual({
      phase: 'offpeak', next_phase: 'peak', next_switch: '13:58',
    })
  })

  it('晚上过了最后一段:低谷,下一次切换是明早 08:58', () => {
    expect(peakPhase(at('22:00'), DEFAULT_PEAK_SCHEDULE, TZ)).toEqual({
      phase: 'offpeak', next_phase: 'peak', next_switch: '08:58',
    })
  })

  it('边界:起点那一分钟算高峰,终点那一分钟算低谷(左闭右开)', () => {
    expect(peakPhase(at('08:58'), DEFAULT_PEAK_SCHEDULE, TZ).phase).toBe('peak')
    expect(peakPhase(at('12:02'), DEFAULT_PEAK_SCHEDULE, TZ).phase).toBe('offpeak')
    expect(peakPhase(at('12:01'), DEFAULT_PEAK_SCHEDULE, TZ).phase).toBe('peak')
  })

  it('时区按传入的算:同一 UTC 时刻在纽约是凌晨,自然是低谷', () => {
    const utc = new Date('2026-09-09T02:30:00Z') // 上海 10:30 高峰;纽约 22:30 低谷
    expect(peakPhase(utc, DEFAULT_PEAK_SCHEDULE, TZ).phase).toBe('peak')
    expect(peakPhase(utc, DEFAULT_PEAK_SCHEDULE, 'America/New_York').phase).toBe('offpeak')
  })

  it('时间表可改:只留一段也能判', () => {
    const schedule = { periods: [{ start: '09:00', end: '18:00' }] }
    expect(peakPhase(at('17:59'), schedule, TZ)).toEqual({ phase: 'peak', next_phase: 'offpeak', next_switch: '18:00' })
    expect(peakPhase(at('18:00'), schedule, TZ)).toEqual({ phase: 'offpeak', next_phase: 'peak', next_switch: '09:00' })
  })
})

describe('时间表校验(SettingsDialog 改的东西要落盘,落盘前先挡住写坏的)', () => {
  it('合法的原样返回', () => {
    expect(validatePeakSchedule({ periods: [{ start: '08:58', end: '12:02' }] }))
      .toEqual({ ok: true, schedule: { periods: [{ start: '08:58', end: '12:02' }] } })
  })

  it('不是 HH:MM 就拒', () => {
    expect(validatePeakSchedule({ periods: [{ start: '8:58', end: '12:02' }] }).ok).toBe(false)
    expect(validatePeakSchedule({ periods: [{ start: '08:58', end: '25:00' }] }).ok).toBe(false)
  })

  it('起点不早于终点就拒(不做跨午夜的段,YAGNI)', () => {
    expect(validatePeakSchedule({ periods: [{ start: '12:02', end: '08:58' }] }).ok).toBe(false)
    expect(validatePeakSchedule({ periods: [{ start: '12:02', end: '12:02' }] }).ok).toBe(false)
  })

  it('两段重叠或没按先后排就拒', () => {
    expect(validatePeakSchedule({ periods: [{ start: '08:58', end: '14:00' }, { start: '13:58', end: '18:02' }] }).ok).toBe(false)
    expect(validatePeakSchedule({ periods: [{ start: '13:58', end: '18:02' }, { start: '08:58', end: '12:02' }] }).ok).toBe(false)
  })

  it('空表也拒:没有高峰段等于关掉功能,那要显式做,不靠一个空数组', () => {
    expect(validatePeakSchedule({ periods: [] }).ok).toBe(false)
    expect(validatePeakSchedule(null).ok).toBe(false)
    expect(validatePeakSchedule({ periods: 'x' }).ok).toBe(false)
  })
})
