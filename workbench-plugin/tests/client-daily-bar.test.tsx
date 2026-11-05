import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { DailyReport } from '../src/protocol.ts'
import { DailyBar } from '../src/client/DailyBar.tsx'

afterEach(cleanup)

const REPORT: DailyReport = {
  date: '2026-09-01',
  generated_at: '2026-09-02T09:00:05+08:00',
  progress: ['Aiboo:5 次提交 · 用量 25.0M(入+出)'],
  missing: ['Echo:零提交零用量'],
  ideas: ['想给展示台加个温度计'],
  proposals: ['提议系统(M5)未上线,本节暂空'],
}

describe('日结条(PRD 5.7;2026-09-02 起从占位文案变成真报告)', () => {
  it('没有报告时是老实话占位,不摆空壳', () => {
    render(<DailyBar daily={undefined} />)
    expect(screen.getByText('日结 · 每天早上 9 点生成昨天的')).toBeTruthy()
  })

  it('有报告时摘要可点,展开后 PRD 四段齐全、内容原样', () => {
    render(<DailyBar daily={REPORT} />)
    const toggle = screen.getByRole('button', { name: /日结 2026-09-01/ })
    fireEvent.click(toggle)
    expect(screen.getByText('推进了什么')).toBeTruthy()
    expect(screen.getByText('什么没发生 / 被绕开')).toBeTruthy()
    expect(screen.getByText('新点子')).toBeTruthy()
    expect(screen.getByText('提议')).toBeTruthy()
    expect(screen.getByText('Aiboo:5 次提交 · 用量 25.0M(入+出)')).toBeTruthy()
    expect(screen.getByText('Echo:零提交零用量')).toBeTruthy()
    expect(screen.getByText('想给展示台加个温度计')).toBeTruthy()
    // 再点一次收起
    fireEvent.click(toggle)
    expect(screen.queryByText('推进了什么')).toBeNull()
  })
})

describe('日结条里的 DeepSeek 峰谷分账(2026-09-09)', () => {
  it('有分账就多一节:合计与两笔各一行', () => {
    render(<DailyBar daily={{ ...REPORT, deepseek_spend: { total: '12.60', peak: '9.00', offpeak: '3.60' } }} />)
    fireEvent.click(screen.getByRole('button', { name: /日结 2026-09-01/ }))
    expect(screen.getByText('DeepSeek 峰谷分账')).toBeTruthy()
    expect(screen.getByText('当日合计 ¥12.60')).toBeTruthy()
    expect(screen.getByText('高峰 ¥9.00')).toBeTruthy()
    expect(screen.getByText('低谷 ¥3.60')).toBeTruthy()
  })

  it('那天没记过就整节不出现——不摆一个 0.00 让人以为真没花钱', () => {
    render(<DailyBar daily={REPORT} />)
    fireEvent.click(screen.getByRole('button', { name: /日结 2026-09-01/ }))
    expect(screen.queryByText('DeepSeek 峰谷分账')).toBeNull()
  })

  it('只有合计、分不出时段时:只出合计那一行', () => {
    render(<DailyBar daily={{ ...REPORT, deepseek_spend: { total: '12.60' } }} />)
    fireEvent.click(screen.getByRole('button', { name: /日结 2026-09-01/ }))
    expect(screen.getByText('当日合计 ¥12.60')).toBeTruthy()
    expect(screen.queryByText(/^高峰 /)).toBeNull()
  })
})
