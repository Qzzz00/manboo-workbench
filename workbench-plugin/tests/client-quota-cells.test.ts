// @vitest-environment node
/**
 * 余额/额度格子的取数投影(client/quotaCells.ts)。
 *
 * 这份文件此前没有任何测试,代价在 2026-08-26 兑现了:服务端写了很久的
 * 「403 要重新登录、不许闷声少一栏」纪律,一个字都没到过界面上——因为
 * cellFor 对 kind==='quota' 的格子会用重置时刻**整个覆盖**掉 entry 上的话术。
 * Fable 那一栏消失了一整天,屏幕上没有任何线索。这里把"话必须到得了屏幕"钉死。
 */
import { describe, expect, it } from 'vitest'
import { quotaCells } from '../src/client/quotaCells.ts'
import type { QuotaEntry } from '../src/protocol.ts'

const NOW = new Date('2026-08-26T12:00:00+08:00')

function claudeCell(entry: QuotaEntry) {
  return quotaCells({ claude: entry }, {}, NOW).find(cell => cell.agent === 'claude')!
}

describe('quotaCells:诊断话术必须到得了屏幕', () => {
  it('★entry.alert 要跟重置时刻一起显示,不许被覆盖掉', () => {
    const cell = claudeCell({
      kind: 'quota',
      windows: [{ label: '5h', left_pct: 75, reset_at: '2026-08-26T08:10:00.000Z' }],
      alert: 'Fable 等按模型窗口暂缺:用量端点取不到(已退避,稍后自动重试)',
    })

    expect(cell.note).toContain('5h') // 重置那行还在
    expect(cell.note).toContain('Fable 等按模型窗口暂缺') // 话也在
  })

  it('★note(给 /state 看的调试字段)不该跑到界面上——它是字段名清单,不是人话', () => {
    const cell = claudeCell({
      kind: 'quota',
      windows: [{ label: '5h', left_pct: 75, reset_at: '2026-08-26T08:10:00.000Z' }],
      note: '响应头: anthropic-ratelimit-unified-5h-utilization, anthropic-ratelimit-unified-5h-reset',
    })

    expect(cell.note).not.toContain('anthropic-ratelimit')
  })

  it('没有 alert 时一个字不多加,保持原样', () => {
    const cell = claudeCell({
      kind: 'quota',
      windows: [{ label: '5h', left_pct: 75, reset_at: '2026-08-26T08:10:00.000Z' }],
    })

    expect(cell.note).toBe('5h 今天 16:10 重置')
  })

  it('未接入那格仍然用 entry.note——它本来就是那格唯一的说明来源', () => {
    const cell = claudeCell({ kind: 'unknown', note: '等 Claude Code statusLine 上报' })

    expect(cell.value).toBe('未接入')
    expect(cell.note).toBe('等 Claude Code statusLine 上报')
  })
})

describe('DeepSeek 格的峰谷一行(2026-09-09,借 save-money 的时间窗语义)', () => {
  const dshCell = (entry: QuotaEntry, peak?: Parameters<typeof quotaCells>[3]) =>
    quotaCells({ dsh: entry }, {}, NOW, peak).find(cell => cell.agent === 'dsh')!

  const balance: QuotaEntry = { kind: 'balance', currency: 'CNY', total: '218.40', available: true }

  it('高峰时说「高峰 · 12:02 转低谷」', () => {
    const cell = dshCell(balance, { phase: 'peak', next_phase: 'offpeak', next_switch: '12:02', periods: [] })
    expect(cell.peak).toBe('高峰 · 12:02 转低谷')
  })

  it('低谷时说「低谷 · 13:58 转高峰」', () => {
    const cell = dshCell(balance, { phase: 'offpeak', next_phase: 'peak', next_switch: '13:58', periods: [] })
    expect(cell.peak).toBe('低谷 · 13:58 转高峰')
  })

  it('服务端没给峰谷就没有这一行——不摆空壳,也不在客户端自己算', () => {
    expect(dshCell(balance).peak).toBeUndefined()
  })

  it('只加在 DeepSeek 那一格,别家不受影响', () => {
    const cells = quotaCells(
      { dsh: balance, claude: { kind: 'unknown' } }, {}, NOW,
      { phase: 'peak', next_phase: 'offpeak', next_switch: '12:02', periods: [] },
    )
    expect(cells.find(cell => cell.agent === 'claude')?.peak).toBeUndefined()
  })

  it('未接入(还没填 Key)的 DeepSeek 格也照样说峰谷——那是时段,与有没有余额无关', () => {
    const cell = dshCell({ kind: 'unknown', note: '未填 DeepSeek API Key(在工作台里填)' },
      { phase: 'peak', next_phase: 'offpeak', next_switch: '12:02', periods: [] })
    expect(cell.peak).toBe('高峰 · 12:02 转低谷')
  })
})
