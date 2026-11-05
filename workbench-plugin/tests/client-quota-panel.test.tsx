import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { QuotaEntry } from '../src/protocol.ts'
import { QuotaPanel } from '../src/client/QuotaPanel.tsx'

afterEach(cleanup)

const NOW = '2026-09-09T10:30:00+08:00'
const BALANCE: QuotaEntry = { kind: 'balance', currency: 'CNY', total: '218.40', available: true }

describe('额度面板的 DeepSeek 峰谷一行(2026-09-09)', () => {
  it('高峰时那一行在屏幕上', () => {
    render(<QuotaPanel quota={{ dsh: BALANCE }} now={NOW}
      peak={{ phase: 'peak', next_phase: 'offpeak', next_switch: '12:02', periods: [] }} />)
    expect(screen.getByText('高峰 · 12:02 转低谷')).toBeTruthy()
  })

  it('低谷时换成另一句', () => {
    render(<QuotaPanel quota={{ dsh: BALANCE }} now={NOW}
      peak={{ phase: 'offpeak', next_phase: 'peak', next_switch: '13:58', periods: [] }} />)
    expect(screen.getByText('低谷 · 13:58 转高峰')).toBeTruthy()
  })

  it('服务端没给峰谷时这一行不出现,余额照常显示', () => {
    render(<QuotaPanel quota={{ dsh: BALANCE }} now={NOW} />)
    expect(screen.queryByText(/转低谷|转高峰/)).toBeNull()
    expect(screen.getByText('¥218.40')).toBeTruthy()
  })

  it('★这一行只说时段,不出现任何"已暂停/将暂停"的字眼——纪律是不替 Ben 做决定', () => {
    const { container } = render(<QuotaPanel quota={{ dsh: BALANCE }} now={NOW}
      peak={{ phase: 'peak', next_phase: 'offpeak', next_switch: '12:02', periods: [] }} />)
    expect(container.textContent).not.toMatch(/暂停|停止|自动/)
  })
})
