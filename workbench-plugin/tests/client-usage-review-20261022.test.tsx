/**
 * 消耗数据照评审页 0cf75042 的写法(10-22 拍板 10 / 21):活动两格写「会话 / 消息」;构成图例「● Codex 345M」;
 * 年历头「2026 年 · 一格一天」、下面一句说明;格脚「本机记录 · 12:24」与「来源与口径 ›」;有来源没接上 / 残缺时收成一行
 * 「暂未更新 N 家 · 查看原因 ›」。大字仍是「总吞吐」(10-21 拍板),多出来的页签与几块保留。
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { UsageState, UsageTotals } from '../src/protocol.ts'
import { USAGE_METHOD_LABEL, USAGE_STALE_LINE, UsagePanel } from '../src/client/UsagePanel.tsx'

afterEach(cleanup)

const T = (input: number): UsageTotals => ({ input, output: 0, cache_read: 0, cache_write: 0 })
const USAGE: UsageState = {
  days: [{
    date: '2026-09-01',
    by_project: { A: T(500_000_000) },
    by_model: { m: T(500_000_000) },
    by_source: { codex: T(345_000_000), claude: T(155_000_000) },
    sessions: 3,
    messages: 12,
    hour_counts: {},
  }],
  sources: { codex: { status: 'ok' }, claude: { status: 'ok' } },
  scanned_at: '2026-09-02T04:24:00Z',
}

describe('消耗数据照评审页写', () => {
  it('活动两格写「会话」「消息」', () => {
    render(<UsagePanel usage={USAGE} />)
    const activity = screen.getByRole('group', { name: '活动统计' })
    expect([...activity.querySelectorAll('.ben-wb__usage-tile-l')].map(one => one.textContent)).toEqual(['会话', '消息'])
  })

  it('构成图例每家「● 名 数」,圆点明度与刻度同序', () => {
    const { container } = render(<UsagePanel usage={USAGE} />)
    const items = [...container.querySelectorAll('.ben-wb__usage-mixlegend>span')]
    expect(items.map(one => one.textContent)).toEqual(['Codex 345.0M', 'Claude 155.0M'])
    expect(items.map(one => one.querySelector('i')?.getAttribute('data-part'))).toEqual(['0', '1'])
  })

  it('年历头「年 · 一格一天」,格子下一句「明度表示用量」带已点亮几天', () => {
    const { container } = render(<UsagePanel usage={USAGE} />)
    expect(container.querySelector('.ben-wb__usage-heathead>span')?.textContent).toMatch(/^\d{4} 年 · 一格一天$/)
    expect(container.querySelector('.ben-wb__usage-heatcap')?.textContent).toMatch(/^明度表示用量 · 已点亮 \d+ \/ \d+ 天$/)
  })

  it('格脚:左「本机记录 · HH:MM」,右「来源与口径 ›」点开是口径', () => {
    const { container } = render(<UsagePanel usage={USAGE} />)
    const foot = container.querySelector('details.ben-wb__usage-method>summary')!
    expect(foot.children[0]?.textContent).toMatch(/^本机记录 · \d\d:\d\d$/)
    expect(foot.children[1]?.textContent).toBe(`${USAGE_METHOD_LABEL} ›`)
    fireEvent.click(foot)
    expect(screen.getByText(/缓存读 = 每轮重读上下文/)).toBeVisible()
  })

  it('有来源残缺 / 没接上:收成一行「暂未更新 N 家 · 查看原因 ›」,展开才见各家', () => {
    const { container } = render(<UsagePanel usage={{ ...USAGE, sources: { codex: { status: 'ok' }, claude: { status: 'partial', note: '上次读取 10:04' }, kimi: { status: 'error' } } } as UsageState} />)
    const fold = container.querySelector('details.ben-wb__usage-stale')!
    expect([...fold.querySelector('summary')!.children].map(one => one.textContent)).toEqual([USAGE_STALE_LINE(2), '查看原因 ›'])
    expect(within(fold as HTMLElement).getByText(/claude/i)).toBeInTheDocument()
    expect(container.querySelector('.ben-wb__usage-notes')).toBeNull()
  })
})
