import { describe, expect, it } from 'vitest'
import type { BalanceQuota, UnknownQuota, WindowQuota } from '../src/protocol.ts'
import * as display from '../src/quota/display.ts'
import { DEFAULT_QUOTA_THRESHOLDS, quotaAlert, quotaDisplay } from '../src/quota/display.ts'

function balance(total: string, available = true): BalanceQuota {
  return { kind: 'balance', currency: 'CNY', total, available }
}

const windows: WindowQuota = {
  kind: 'quota',
  windows: [
    { label: '5h', left_pct: 31, reset_at: '14:20' },
    { label: '周', left_pct: 74 },
  ],
}

const unknown: UnknownQuota = { kind: 'unknown', note: '取数方式待实测' }

describe('显示规则 1：统一按剩余，方向一致（PRD §8.2）', () => {
  it('窗口型条长直接等于剩余百分比，不是已用', () => {
    const view = quotaDisplay(windows, DEFAULT_QUOTA_THRESHOLDS)

    expect(view.bars.map(bar => bar.leftPct)).toEqual([31, 74])
    expect(view.bars.every(bar => bar.direction === 'remaining')).toBe(true)
  })

  it('措辞只说剩余，不出现「已用」', () => {
    const view = quotaDisplay(windows, DEFAULT_QUOTA_THRESHOLDS)
    const text = [view.headline, view.sub ?? '', ...view.bars.map(bar => bar.text)].join(' ')

    expect(text).toContain('剩余')
    expect(text).not.toContain('已用')
  })

  it('余额型同样是剩余口径：数字变小＝该慌了', () => {
    const view = quotaDisplay(balance('218.40'), DEFAULT_QUOTA_THRESHOLDS)

    expect(view.headline).toContain('218.40')
    expect(view.headline).toContain('剩余')
  })
})

describe('显示规则 2：DeepSeek 余额不画进度条', () => {
  it('余额型 showBar 为 false 且没有任何条', () => {
    const view = quotaDisplay(balance('218.40'), DEFAULT_QUOTA_THRESHOLDS)

    expect(view.showBar).toBe(false)
    expect(view.bars).toEqual([])
  })

  it('余额型只给数字 + 今日消耗', () => {
    const view = quotaDisplay({ ...balance('218.40'), today_spent: '12.60' }, DEFAULT_QUOTA_THRESHOLDS)

    expect(view.headline).toContain('218.40')
    expect(view.sub).toContain('12.60')
    expect(view.sub).toContain('今日')
  })

  it('今日消耗拿不到时不显示该行，也不写 0', () => {
    const view = quotaDisplay(balance('218.40'), DEFAULT_QUOTA_THRESHOLDS)

    expect(view.sub).toBeUndefined()
  })

  it('窗口型才画条', () => {
    expect(quotaDisplay(windows, DEFAULT_QUOTA_THRESHOLDS).showBar).toBe(true)
  })
})

describe('显示规则 3：第一版不做消耗趋势图', () => {
  it('quota 模块不导出任何趋势/历史相关能力', () => {
    const forbidden = /trend|history|series|chart|sparkline/i
    expect(Object.keys(display).filter(name => forbidden.test(name))).toEqual([])
  })

  it('视图模型里没有时间序列字段', () => {
    const view = quotaDisplay(balance('218.40'), DEFAULT_QUOTA_THRESHOLDS)
    const forbidden = /trend|history|series|points|samples/i
    expect(Object.keys(view).filter(key => forbidden.test(key))).toEqual([])
  })
})

describe('显示规则 4：阈值告警', () => {
  it('余额高于阈值为 ok', () => {
    expect(quotaAlert(balance('218.40'), DEFAULT_QUOTA_THRESHOLDS)).toBe('ok')
  })

  it('余额低于阈值变黄', () => {
    expect(quotaAlert(balance('12.00'), { balanceWarnBelow: 20, windowWarnBelowPct: 15 })).toBe('warn')
  })

  it('余额为 0 变红', () => {
    expect(quotaAlert(balance('0.00'), DEFAULT_QUOTA_THRESHOLDS)).toBe('danger')
  })

  it('账号不可用变红，哪怕数字还挂着', () => {
    expect(quotaAlert(balance('99.00', false), DEFAULT_QUOTA_THRESHOLDS)).toBe('danger')
  })

  it('阈值可配：调高阈值后同一余额就该黄', () => {
    expect(quotaAlert(balance('50.00'), { balanceWarnBelow: 10, windowWarnBelowPct: 15 })).toBe('ok')
    expect(quotaAlert(balance('50.00'), { balanceWarnBelow: 100, windowWarnBelowPct: 15 })).toBe('warn')
  })

  it('窗口型取最紧的一条判档', () => {
    expect(quotaAlert(windows, { balanceWarnBelow: 20, windowWarnBelowPct: 35 })).toBe('warn')
    expect(quotaAlert(windows, { balanceWarnBelow: 20, windowWarnBelowPct: 10 })).toBe('ok')
    expect(quotaAlert({
      kind: 'quota',
      windows: [{ label: '5h', left_pct: 0 }],
    }, DEFAULT_QUOTA_THRESHOLDS)).toBe('danger')
  })

  it('未接入的来源既不报警也不显示 0', () => {
    expect(quotaAlert(unknown, DEFAULT_QUOTA_THRESHOLDS)).toBe('unknown')

    const view = quotaDisplay(unknown, DEFAULT_QUOTA_THRESHOLDS)
    expect(view.connected).toBe(false)
    expect(view.showBar).toBe(false)
    expect(view.headline).toBe('未接入')
    expect(view.sub).toBe('取数方式待实测')
    expect(view.headline).not.toContain('0')
  })
})
