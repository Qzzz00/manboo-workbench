/**
 * DeepSeek 峰谷时段(2026-09-09,借 dsh-save-money 的时间窗语义——只借概念,不装、不抄代码)。
 *
 * DeepSeek 官方在高峰段收全价、低谷段打折;这里只做一件事:给定时刻,回答
 * 「现在是高峰还是低谷、下一次何时切换」。纯函数,时间表由调用方传入
 * (默认按官方两段,SettingsDialog 可改,落盘在 server/peakSchedule.ts)。
 *
 * 纪律:**只显示与分账,不自动暂停任何任务**——那是 save-money 的主功能,
 * 我们的规矩是不替 Ben 做决定(设计-借鉴功能落位与资产区 §二)。
 *
 * 时段是「本地墙钟」的概念(官方按北京时间定),所以按时区把时刻换成当天的分钟数来判,
 * 不碰 UTC。段是左闭右开:08:58 那一分钟已经是高峰,12:02 那一分钟已经是低谷。
 */

export type PeakPhase = 'peak' | 'offpeak'

export interface PeakPeriod {
  /** HH:MM,24 小时制,两位。 */
  start: string
  end: string
}

export interface PeakSchedule {
  /** 高峰段,按先后排、互不重叠。段外一律低谷。 */
  periods: readonly PeakPeriod[]
}

/** DeepSeek 官方高峰段(北京时间)。 */
export const DEFAULT_PEAK_SCHEDULE: PeakSchedule = {
  periods: [
    { start: '08:58', end: '12:02' },
    { start: '13:58', end: '18:02' },
  ],
}

export interface PeakPhaseView {
  phase: PeakPhase
  next_phase: PeakPhase
  /** 下一次切换的墙钟时刻 HH:MM;已过最后一段时是明天第一段的起点。 */
  next_switch: string
}

const CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/

function clockToMinutes(clock: string): number | undefined {
  const match = CLOCK.exec(clock)
  if (match === null) return undefined
  return Number(match[1]) * 60 + Number(match[2])
}

/** 某时刻在指定时区的「当天分钟数」(0–1439)。 */
function minutesOfDay(now: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now)
  const pick = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find(part => part.type === type)?.value ?? '0')
  return pick('hour') * 60 + pick('minute')
}

export function systemTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone
}

/**
 * 判定某时刻的峰谷与下一次切换。
 *
 * @param timeZone 缺省取本机时区(设计文档:时区取本机)。
 */
export function peakPhase(
  now: Date,
  schedule: PeakSchedule = DEFAULT_PEAK_SCHEDULE,
  timeZone: string = systemTimeZone(),
): PeakPhaseView {
  const minute = minutesOfDay(now, timeZone)
  const periods = schedule.periods
    .map(period => ({ start: clockToMinutes(period.start), end: clockToMinutes(period.end), raw: period }))
    .filter((period): period is { start: number, end: number, raw: PeakPeriod } =>
      period.start !== undefined && period.end !== undefined)

  for (const period of periods) {
    if (minute < period.start) {
      return { phase: 'offpeak', next_phase: 'peak', next_switch: period.raw.start }
    }
    if (minute < period.end) {
      return { phase: 'peak', next_phase: 'offpeak', next_switch: period.raw.end }
    }
  }
  // 今天的段全过完了(或者表里一段都没有):下一次切换是明天第一段的起点。
  const first = periods[0]
  return { phase: 'offpeak', next_phase: 'peak', next_switch: first?.raw.start ?? '--:--' }
}

export type PeakScheduleValidation =
  | { ok: true, schedule: PeakSchedule }
  | { ok: false, error: string }

/** 落盘前的把关:格式、先后、不重叠、不为空。错误信息说人话,直接回给界面。 */
export function validatePeakSchedule(raw: unknown): PeakScheduleValidation {
  if (typeof raw !== 'object' || raw === null || !Array.isArray((raw as { periods?: unknown }).periods)) {
    return { ok: false, error: 'periods 必须是数组' }
  }
  const input = (raw as { periods: unknown[] }).periods
  if (input.length === 0) return { ok: false, error: '至少要有一段高峰时段' }

  const periods: PeakPeriod[] = []
  let lastEnd = -1
  for (const [index, item] of input.entries()) {
    const start = typeof (item as PeakPeriod)?.start === 'string' ? (item as PeakPeriod).start : ''
    const end = typeof (item as PeakPeriod)?.end === 'string' ? (item as PeakPeriod).end : ''
    const startMin = clockToMinutes(start)
    const endMin = clockToMinutes(end)
    if (startMin === undefined || endMin === undefined) {
      return { ok: false, error: `第 ${index + 1} 段的时刻要写成 HH:MM(如 08:58)` }
    }
    if (startMin >= endMin) return { ok: false, error: `第 ${index + 1} 段的起点要早于终点` }
    if (startMin < lastEnd) return { ok: false, error: '各段要按先后排且互不重叠' }
    lastEnd = endMin
    periods.push({ start, end })
  }
  return { ok: true, schedule: { periods } }
}
