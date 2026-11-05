import { describe, expect, it } from 'vitest'
import { buildPerformanceWidget, buildStorageWidget } from '../src/client/machineWidgets.ts'
import type { WorkbenchState } from '../src/protocol.ts'

const OK: WorkbenchState['machine'] = {
  disk_pct: 62, disk_free_gb: 180.4, mem_gb: 16, cpu_idle_pct: 54.3, sampled_at: '2026-08-20T00:00:00.000Z',
}

describe('buildStorageWidget（组件条·存储格，spec §3）', () => {
  it('正常采样 → disk_pct% + 剩 N G，非告警态', () => {
    const view = buildStorageWidget(OK)
    expect(view.error).toBe(false)
    expect(view.alert).toBe(false)
    expect(view.valueText).toBe('62% · 剩 180G')
  })

  it('disk_pct >= 95 → 告警态（参照 v5 原型 .wg.bad）', () => {
    const view = buildStorageWidget({ ...OK, disk_pct: 97, disk_free_gb: 16 })
    expect(view.alert).toBe(true)
    expect(view.valueText).toBe('97% · 剩 16G')
  })

  it('disk_pct 恰好 95 → 也是告警态（含边界）', () => {
    expect(buildStorageWidget({ ...OK, disk_pct: 95 }).alert).toBe(true)
  })

  it('disk_pct 94 → 不告警', () => {
    expect(buildStorageWidget({ ...OK, disk_pct: 94 }).alert).toBe(false)
  })

  it('machine 为 { error } → 未接入:<原因>，不编数(D13)', () => {
    const view = buildStorageWidget({ error: 'df 失败' })
    expect(view.error).toBe(true)
    expect(view.alert).toBe(false)
    expect(view.valueText).toBe('未接入:df 失败')
  })

  it('machine 缺省(尚未接入/未采样) → 同样显式标注，不留空(D13)', () => {
    const view = buildStorageWidget(undefined)
    expect(view.error).toBe(true)
    expect(view.valueText).toContain('未接入')
  })
})

describe('buildPerformanceWidget（组件条·性能格，spec §3）', () => {
  it('正常采样 → cpu_idle_pct% 空闲 + mem_gb G', () => {
    const view = buildPerformanceWidget(OK)
    expect(view.error).toBe(false)
    expect(view.valueText).toBe('54% 空闲 · 16G')
  })

  it('machine 为 { error } → 未接入:<原因>，不编数(D13)', () => {
    const view = buildPerformanceWidget({ error: 'top 失败' })
    expect(view.error).toBe(true)
    expect(view.valueText).toBe('未接入:top 失败')
  })

  it('machine 缺省 → 同样显式标注', () => {
    const view = buildPerformanceWidget(undefined)
    expect(view.error).toBe(true)
    expect(view.valueText).toContain('未接入')
  })
})
