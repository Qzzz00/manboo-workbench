/**
 * **电脑上那一格也要说「截至什么时候」**(2026-10-02,卡 QA)。
 *
 * 老四格读的是 `/state.quota` 的原始 entry(不是服务端判好的 `agent_quota`)—— 在此之前
 * 那一格只画百分比,**一个字都不说这个数多大年纪**。现场:04:27 的 100% 在 21:3x 还画着满条。
 *
 * 两档:线以内 → 照画条,小字缀「截至 04:27」;过线 → **不画条、不出百分比**,
 * 大字写「读不到最新的」,小字写「上次 04:27」,整格画淡(`stale`)。
 */
import { describe, expect, it } from 'vitest'
import type { QuotaEntry } from '../src/protocol.ts'
import { QUOTA_STALE_VALUE } from '../src/protocol.ts'
import { quotaCells } from '../src/client/quotaCells.ts'

const NOW = new Date(2026, 9, 2, 21, 30, 0)
const AT_0427 = new Date(2026, 9, 2, 4, 27, 40)
const ago = (ms: number): Date => new Date(NOW.getTime() - ms)

/** 现场那一份:桌面端 04:27 的样本算出来的两扇窗。 */
const SITE: QuotaEntry = {
  kind: 'quota',
  windows: [{ label: '5h', left_pct: 100 }, { label: '周', left_pct: 82 }],
  as_of: AT_0427.toISOString(),
}

const claudeCell = (claude: QuotaEntry) =>
  quotaCells({ claude }, {}, NOW, undefined, undefined, ['claude'])[0]!

describe('老四格:截至什么时候', () => {
  it('★过线(17 小时前的那一份):不画条、不出百分比,只说「读不到最新的 / 上次 04:27」,整格画淡', () => {
    const cell = claudeCell(SITE)
    expect(cell.value).toBe(QUOTA_STALE_VALUE)
    expect(cell.note).toBe('上次 04:27')
    expect(cell.showBar).toBe(false)
    expect(cell.bars).toEqual([])
    expect(cell.stale).toBe(true)
    // 「未接入」是「从没接上」的说法,读到过数的那一格不许那么写。
    expect(cell.value).not.toBe('未接入')
    expect(`${cell.value}${cell.note}`).not.toContain('%')
  })

  it('★线以内:照画两条,小字里缀上「截至 HH:MM」', () => {
    const at = ago(30 * 60_000)
    const cell = claudeCell({ ...SITE, as_of: at.toISOString() })
    expect(cell.value).toBe('82%')
    expect(cell.bars.map(bar => bar.pct)).toEqual([100, 82])
    expect(cell.showBar).toBe(true)
    expect(cell.stale).toBeUndefined()
    expect(cell.note).toBe('剩余 · 截至 21:00')
  })

  it('as_of 缺席(老宿主、这条来源没给)→ 与这一版之前一字不差,不替它编一个时刻', () => {
    const cell = claudeCell({ kind: 'quota', windows: [{ label: '周', left_pct: 69 }] })
    expect(cell.value).toBe('69%')
    expect(cell.note).toBe('剩余')
    expect(cell.stale).toBeUndefined()
  })

  it('有重置时刻、又有截至时刻时两样都写(重置说「什么时候回来」,截至说「这个数多大年纪」)', () => {
    const at = ago(30 * 60_000)
    const cell = claudeCell({
      kind: 'quota',
      windows: [{ label: '周', left_pct: 69, reset_at: new Date(2026, 9, 3, 11, 33).toISOString() }],
      as_of: at.toISOString(),
    })
    expect(cell.note).toBe('周 明天 11:33 重置 · 截至 21:00')
  })

  it('★余额型(DeepSeek)同一条线:过线不出钱数', () => {
    const stale: QuotaEntry = {
      kind: 'balance', currency: '元', total: '12.34', available: true, as_of: AT_0427.toISOString(),
    }
    const cell = quotaCells({ dsh: stale }, {}, NOW, undefined, undefined, ['dsh'])[0]!
    expect(cell.value).toBe(QUOTA_STALE_VALUE)
    expect(cell.note).toBe('上次 04:27')
    expect(cell.stale).toBe(true)
  })

  it('过线那一格仍然有那家的名字与峰谷一行(时段跟额度多大年纪无关)', () => {
    const cell = quotaCells(
      { dsh: { kind: 'balance', currency: '元', total: '12.34', available: true, as_of: AT_0427.toISOString() } },
      {}, NOW,
      { phase: 'peak', next_phase: 'offpeak', next_switch: '12:02', periods: [{ start: '00:30', end: '08:30' }] },
      undefined, ['dsh'],
    )[0]!
    expect(cell.name).toBe('DeepSeek')
    expect(cell.peak).toBe('高峰 · 12:02 转低谷')
  })
})
