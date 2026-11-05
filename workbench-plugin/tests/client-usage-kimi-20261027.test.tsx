import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { UsageDay, UsageState } from '../src/protocol.ts'
import { USAGE_METHOD_LABEL, UsagePanel } from '../src/client/UsagePanel.tsx'

/**
 * Kimi 接进「消耗数据」(2026-10-27,任务书 `docs/任务书-Kimi用量接进消耗面板-2026-10-27.md`)。
 *
 * Kimi 的 wire 日志四字段齐全、按 model 分家(kimi.ts),来源标 `ok` 而不是旧的
 * partial(只有输出 token)——于是它**正常参与**缓存命中率;火山 deepseek-v4-flash
 * 走 `dsh` 键,并进 DeepSeek 那一格。「Kimi 只计命令行和桌面版本机 Agent」那句口径
 * 只在这一家真有数(或真接过)时出现,没装 Kimi 的机器上不替他操心。
 */
afterEach(cleanup)

const T = { input: 100, output: 50, cache_read: 100, cache_write: 0 }

function day(bySource: UsageDay['by_source']): UsageDay {
  return {
    date: '2026-10-20',
    by_project: { workbench: { input: 200, output: 100, cache_read: 400, cache_write: 0 } },
    by_model: {
      'kimi-code/kimi-for-coding': { ...T },
      'volcengine-coding-plan/deepseek-v4-flash': { input: 100, output: 50, cache_read: 300, cache_write: 0 },
    },
    by_source: bySource,
    sessions: 2,
    messages: 2,
    hour_counts: {},
  }
}
const usage = (sources: UsageState['sources'], bySource: UsageDay['by_source']): UsageState => ({
  days: [day(bySource)],
  sources,
  scanned_at: '2026-10-27T17:00:00Z',
})
const KIMI_OK = { kimi: { status: 'ok' as const }, codex: { status: 'ok' as const } }

describe('Kimi 接进消耗数据面板(2026-10-27)', () => {
  it('Kimi 是完整口径(ok):正常参与缓存命中率,不再被 partial 排除', () => {
    render(<UsagePanel usage={usage(KIMI_OK, { kimi: { ...T }, codex: { input: 100, output: 50, cache_read: 300, cache_write: 0 } })} />)
    // (100 缓存读 + 300 缓存读) / (100+100 新输入 + 100+300 缓存读) = 400/600 = 67%
    expect(within(screen.getByRole('group', { name: '缓存统计' })).getByText('67%')).toBeInTheDocument()
  })

  it('kimi 标 partial 时才排除(旧行为只对残缺的来源生效)', () => {
    render(<UsagePanel usage={usage({ kimi: { status: 'partial', note: '试' }, codex: { status: 'ok' } }, { kimi: { ...T }, codex: { input: 100, output: 50, cache_read: 300, cache_write: 0 } })} />)
    // 只算 codex:300 / (100 + 300) = 75%
    expect(within(screen.getByRole('group', { name: '缓存统计' })).getByText('75%')).toBeInTheDocument()
  })

  it('口径写明「Kimi 只计命令行和桌面版本机 Agent,普通聊天未计入」;Kimi 缺席时不出现这句', () => {
    const { unmount } = render(<UsagePanel usage={usage(KIMI_OK, { kimi: { ...T }, codex: { ...T } })} />)
    fireEvent.click(screen.getByText(`${USAGE_METHOD_LABEL} ›`))
    expect(screen.getByText('Kimi 只计命令行和桌面版本机 Agent,普通聊天未计入。')).toBeVisible()
    unmount()

    // 机器上没装 Kimi:sources 里没这家、数里也没有 → 口径不提它
    render(<UsagePanel usage={usage({ codex: { status: 'ok' } }, { codex: { ...T } })} />)
    fireEvent.click(screen.getByText(`${USAGE_METHOD_LABEL} ›`))
    expect(screen.queryByText(/Kimi 只计命令行/)).not.toBeInTheDocument()
  })

  it('按 model 分家:火山 deepseek 并进 DeepSeek 那一格,Kimi 合计是 Kimi 模型之和', () => {
    render(<UsagePanel usage={usage(KIMI_OK, { kimi: { ...T }, dsh: { input: 100, output: 50, cache_read: 300, cache_write: 0 } })} />)
    const legend = document.querySelector('.ben-wb__usage-mixlegend')
    // Kimi 一格 = 100+50+0+100 = 250(计费);DeepSeek 一格 = 100+50+300 读另算,计费 150
    expect(legend?.textContent).toContain('Kimi')
    expect(legend?.textContent).toContain('DeepSeek')
    expect(legend?.textContent).not.toContain('volcengine')
    // 模型页原样列模型名(带 provider 前缀),「按 model 分家」在数的那一层已分完
    fireEvent.click(screen.getByRole('tab', { name: '模型' }))
    expect(screen.getByText('volcengine-coding-plan/deepseek-v4-flash')).toBeInTheDocument()
  })
})
