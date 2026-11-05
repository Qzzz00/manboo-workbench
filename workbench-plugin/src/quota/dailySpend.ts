/**
 * 今日消耗跟踪（纯函数）。
 *
 * DeepSeek 官方只开放余额接口，没有用量统计接口（PRD §8.2 规则 3），
 * 所以"今日消耗"只能靠两次余额读数相减推出来，且必须遵守两条纪律：
 *
 * 1. 当天第一次读数只建基线，不报数——没有前值就没有消耗，不允许编造 0。
 * 2. 余额变多（充值）不算负消耗，已累计的消耗要保留，否则一充值就把当天账抹平。
 *
 * 金额一律换算成"分"用整数累计，避免浮点误差把 8.40 累成 8.399999。
 *
 * 2026-09-09 起同一笔差值还按**峰谷时段**分记两笔(quota/peakHours.ts),口径见
 * `trackDailySpend` 的注释。分账只用于显示与日结,**不自动暂停任何任务**。
 */
import type { PeakPhase } from './peakHours.ts'

/** 一天的消耗账本。跨天由调用方传入新的 `day` 触发清零。 */
export interface DailySpendState {
  /** 本地日期 YYYY-MM-DD，用于判断是否跨天。 */
  date: string
  /** 上次读到的余额（分），用于算差值。 */
  lastCents: number
  /** 当天累计消耗（分）。当天还没有第二次读数时不存在。 */
  spentCents?: number
  /** 当天累计消耗，两位小数字符串。没有可报的数时不存在——不写 0。 */
  spent?: string
  /** 高峰段累计消耗(分)。没传过时段的那些差值不计入任何一笔,所以两笔之和可能小于总数。 */
  peakCents?: number
  /** 低谷段累计消耗(分)。 */
  offpeakCents?: number
  /** 高峰段累计消耗，两位小数字符串。这一笔一次都没记过时不存在——不写 0。 */
  peak?: string
  /** 低谷段累计消耗，两位小数字符串。 */
  offpeak?: string
}

/** 把 '218.40' 这类金额字符串换成整数分。 */
function toCents(amount: string): number {
  const value = Number(amount)
  if (!Number.isFinite(value)) throw new Error(`无法解析余额数值：${JSON.stringify(amount)}`)
  return Math.round(value * 100)
}

function formatCents(cents: number): string {
  return (cents / 100).toFixed(2)
}

/**
 * 按指定时区取"今天"是哪一天（YYYY-MM-DD）。
 *
 * 不能用 `toISOString().slice(0, 10)`：那是 UTC 的天，东八区凌晨会算成昨天，
 * 导致每天 00:00–08:00 的消耗记到前一天头上。
 */
export function localDay(now: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now)

  const pick = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find(part => part.type === type)?.value ?? ''

  return `${pick('year')}-${pick('month')}-${pick('day')}`
}

/**
 * 用一次新的余额读数更新账本。返回新账本，不改传入的那份。
 *
 * @param prev 上一份账本，首次采集或跨天后为 undefined
 * @param total 本次读到的余额（原样的字符串，如 '218.40'）
 * @param day 本次读数所属的本地日期，来自 `localDay`
 * @param phase 本次读数所处的峰谷时段(2026-09-09);不传就只记总数,不分账。
 *
 * 分账口径:两次读数之间的差值**整笔算在后一次读数所处的时段**。两次采集相隔五分钟,
 * 跨过 12:02 那一刻的那一笔最多把五分钟的消耗记错边——比按比例劈开更好解释,
 * 也不用假装知道钱是在这五分钟里的哪一秒花掉的。分不了账时两笔都不动,
 * 于是 `peak + offpeak` 可能小于 `spent`：那是如实的"有一部分没归到时段",不是算错。
 */
export function trackDailySpend(
  prev: DailySpendState | undefined,
  total: string,
  day: string,
  phase?: PeakPhase,
): DailySpendState {
  const cents = toCents(total)

  // 首次读数或跨天：只建基线，当天还报不出消耗。
  if (!prev || prev.date !== day) return { date: day, lastCents: cents }

  // 余额变多说明是充值，按 0 计入消耗，但基线要跟上新余额。
  const delta = Math.max(0, prev.lastCents - cents)
  const spentCents = (prev.spentCents ?? 0) + delta

  const peakCents = (prev.peakCents ?? 0) + (phase === 'peak' ? delta : 0)
  const offpeakCents = (prev.offpeakCents ?? 0) + (phase === 'offpeak' ? delta : 0)
  // 一次都没记过的那一笔不出现——同"首次读数不写 0"的纪律:0 会被读成"这段真没花钱"。
  const hadPeak = prev.peakCents !== undefined || phase === 'peak'
  const hadOffpeak = prev.offpeakCents !== undefined || phase === 'offpeak'

  return {
    date: day,
    lastCents: cents,
    spentCents,
    spent: formatCents(spentCents),
    ...(hadPeak ? { peakCents, peak: formatCents(peakCents) } : {}),
    ...(hadOffpeak ? { offpeakCents, offpeak: formatCents(offpeakCents) } : {}),
  }
}
