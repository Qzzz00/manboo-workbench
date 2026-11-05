/**
 * 消耗数据「各家构成」(2026-10-21,视觉 A「消耗数据」):1.3B 下方一排构成刻度,明度依次对应用量最多的两家与其他。
 * 口径同总消耗(入 + 缓存写 + 出);只算范围内的天;一家都没有就整排缺席。
 */
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { UsagePanel, usageMix } from '../src/client/UsagePanel.tsx'
import type { UsageDay, UsageTotals } from '../src/protocol.ts'

afterEach(cleanup)

const t = (input: number): UsageTotals => ({ input, output: 0, cache_read: 999, cache_write: 0 })
const day = (date: string, by_source: Record<string, UsageTotals>): UsageDay => ({
  date, by_source, by_project: { p: t(1) }, by_model: {}, sessions: 1, messages: 1, hour_counts: {},
}) as UsageDay

describe('usageMix', () => {
  it('多的两家排前,其余并成「其他」;缓存读不算', () => {
    const mix = usageMix([day('2026-10-20', { codex: t(60), claude: t(30), kimi: t(6), dsh: t(4) })])
    expect(mix).toEqual([{ label: 'Codex', value: 60 }, { label: 'Claude', value: 30 }, { label: '其他', value: 10 }])
  })

  it('不到三家不补「其他」;都没量就空', () => {
    expect(usageMix([day('2026-10-20', { claude: t(5) })])).toEqual([{ label: 'Claude', value: 5 }])
    expect(usageMix([day('2026-10-20', {})])).toEqual([])
  })
})

describe('UsagePanel 总览', () => {
  it('总量下方一排构成刻度,图例写各家名字', () => {
    render(<UsagePanel usage={{ days: [day('2026-10-20', { codex: t(60), claude: t(40) })], sources: {}, scanned_at: '2026-10-20T00:00:00Z' }} />)
    expect(screen.getByRole('img', { name: '各家构成 Codex 60% · Claude 40%' })).toBeTruthy()
    // 图例照评审页 0cf75042 写「● 名 数」(10-22),不再是「Codex / Claude」一串名字
    expect([...document.querySelectorAll('.ben-wb__usage-mixlegend>span')].map(one => one.textContent?.split(' ')[0])).toEqual(['Codex', 'Claude'])
  })
})
