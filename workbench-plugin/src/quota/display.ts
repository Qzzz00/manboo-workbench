/**
 * 额度显示规则（PRD §8.2 的四条硬要求，全部落在这里）。
 *
 * 1. 四家统一按**剩余**显示：条越短越危险，数字变小＝该慌了。措辞里不出现"已用"，
 *    混用口径会让人在同一屏上看反方向。
 * 2. DeepSeek 余额**不画进度条**：余额没有分母，画条就得假设一个"满"值，那是误导。
 *    只给数字 + 今日消耗。
 * 3. **不做消耗趋势图**：官方无用量接口，第一版明确不做。所以这个模块不提供任何
 *    趋势/历史/时间序列能力，视图模型里也没有对应字段。
 * 4. 阈值告警：低于阈值变黄，为 0 或不可用变红，阈值可配。
 *
 * 这里全是纯函数：判断在工作台做完，展示台只渲染（架构约束 C2）。
 */
import type { QuotaEntry } from '../protocol.ts'

/** 告警档。`unknown` 是"未接入"，既不报警也不显示 0。 */
export type QuotaAlertLevel = 'ok' | 'warn' | 'danger' | 'unknown'

/** 阈值可配（PRD §8.2 规则 4）。 */
export interface QuotaThresholds {
  /** 余额低于该值变黄（按余额币种的原始单位）。 */
  balanceWarnBelow: number
  /** 窗口剩余百分比低于该值变黄。 */
  windowWarnBelowPct: number
}

export const DEFAULT_QUOTA_THRESHOLDS: QuotaThresholds = {
  balanceWarnBelow: 20,
  windowWarnBelowPct: 15,
}

/** 一条进度条。`direction` 写死 'remaining'，是规则 1 的类型级保险。 */
export interface QuotaBar {
  label: string
  leftPct: number
  direction: 'remaining'
  text: string
}

/** 给界面用的视图模型。故意不含任何时间序列字段（规则 3）。 */
export interface QuotaView {
  /** 该来源是否已接通取数。false 时界面显式标"未接入"，不要渲染成 0。 */
  connected: boolean
  /** 是否画进度条。余额型永远 false（规则 2）。 */
  showBar: boolean
  headline: string
  sub?: string
  bars: QuotaBar[]
  alert: QuotaAlertLevel
}

function clampPct(pct: number): number {
  if (!Number.isFinite(pct)) return 0
  return Math.min(100, Math.max(0, pct))
}

/** 窗口型取最紧的一条：一屏只报最坏消息，避免"周还剩 74%"掩盖"5h 只剩 9%"。 */
function tightestWindow(windows: readonly { label: string, left_pct: number, reset_at?: string }[]) {
  return windows.reduce<(typeof windows)[number] | undefined>(
    (tightest, window) => (!tightest || window.left_pct < tightest.left_pct ? window : tightest),
    undefined,
  )
}

export function quotaAlert(entry: QuotaEntry, thresholds: QuotaThresholds): QuotaAlertLevel {
  if (entry.kind === 'unknown') return 'unknown'

  if (entry.kind === 'balance') {
    // 账号不可用直接红，哪怕数字还挂着——这时候数字不作数。
    if (!entry.available) return 'danger'
    const total = Number(entry.total)
    if (!Number.isFinite(total)) return 'unknown'
    if (total <= 0) return 'danger'
    return total < thresholds.balanceWarnBelow ? 'warn' : 'ok'
  }

  const tightest = tightestWindow(entry.windows)
  // 一条窗口都没有＝没取到数，按未接入处理，不能报成"额度充足"。
  if (!tightest) return 'unknown'
  if (tightest.left_pct <= 0) return 'danger'
  return tightest.left_pct < thresholds.windowWarnBelowPct ? 'warn' : 'ok'
}

export function quotaDisplay(entry: QuotaEntry, thresholds: QuotaThresholds): QuotaView {
  const alert = quotaAlert(entry, thresholds)

  if (entry.kind === 'unknown') {
    // 未接入：说"未接入"，不给数字、不给条，也不写 0。
    return {
      connected: false,
      showBar: false,
      headline: '未接入',
      ...(entry.note === undefined ? {} : { sub: entry.note }),
      bars: [],
      alert,
    }
  }

  if (entry.kind === 'balance') {
    const notes: string[] = []
    if (!entry.available) notes.push('账号不可用')
    // 今日消耗要靠两次读数相减，第一次采集拿不到就整行不显示，不写 0。
    if (entry.today_spent !== undefined) notes.push(`今日消耗 ${entry.today_spent}`)

    return {
      connected: true,
      // 规则 2：余额无分母，坚决不画条。
      showBar: false,
      headline: `剩余 ${entry.total} ${entry.currency}`,
      ...(notes.length === 0 ? {} : { sub: notes.join(' · ') }),
      bars: [],
      alert,
    }
  }

  const bars: QuotaBar[] = entry.windows.map((window) => {
    const leftPct = clampPct(window.left_pct)
    const reset = window.reset_at ? `，${window.reset_at} 重置` : ''
    return {
      label: window.label,
      // 规则 1：条长直接是剩余，不做 100 - 已用 的换算。
      leftPct,
      direction: 'remaining',
      text: `${window.label} 剩余 ${leftPct}%${reset}`,
    }
  })

  const tightest = tightestWindow(entry.windows)
  const headline = tightest
    ? `${tightest.label} 剩余 ${clampPct(tightest.left_pct)}%`
    : '剩余额度未知'
  const sub = tightest?.reset_at

  return {
    connected: true,
    showBar: true,
    headline,
    ...(sub === undefined ? {} : { sub: `${tightest?.label} ${sub} 重置` }),
    bars,
    alert,
  }
}
