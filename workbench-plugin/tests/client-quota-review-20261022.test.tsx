/**
 * 余额 / 额度照评审页 0cf75042 的写法(10-22 拍板 21):余额一行「DeepSeek · 余额」+「¥218.40」,下面一句口径
 * 「剩余额度 · 一格 5% · 末格按实际比例填充」;窗口名「5时 / 周」;有一扇窗用完了,格脚写「Kimi 5 小时额度已用完 · 14:30 重置」。
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { QuotaEntry } from '../src/protocol.ts'
import { QUOTA_SCALE_LINE, QuotaPanel } from '../src/client/QuotaPanel.tsx'

afterEach(cleanup)

const NOW = '2026-10-21T12:24:00+08:00'
const DSH: QuotaEntry = { kind: 'balance', currency: 'CNY', total: '218.40', available: true }
const KIMI: QuotaEntry = { kind: 'quota', windows: [{ label: '5h', left_pct: 0, reset_at: '2026-10-21T14:30:00+08:00' }, { label: '周', left_pct: 100 }] }
const CLAUDE: QuotaEntry = { kind: 'quota', windows: [{ label: '5h', left_pct: 96 }, { label: '周', left_pct: 71 }] }

describe('余额 / 额度照评审页写', () => {
  it('余额一行:名字后面弱字「· 余额」,金额「¥218.40」', () => {
    render(<QuotaPanel quota={{ dsh: DSH, claude: CLAUDE }} now={NOW} />)
    const balance = screen.getByRole('listitem', { name: 'DeepSeek' })
    expect(balance.querySelector('.ben-wb__usage-qname')?.textContent).toBe('DeepSeek · 余额')
    expect(within(balance).getByText('¥218.40')).toBeInTheDocument()
  })

  it('余额下面、各家上面一句口径', () => {
    render(<QuotaPanel quota={{ dsh: DSH, claude: CLAUDE }} now={NOW} />)
    const line = screen.getByText(QUOTA_SCALE_LINE)
    expect(QUOTA_SCALE_LINE).toBe('剩余额度 · 一格 5% · 末格按实际比例填充')
    const balance = screen.getByRole('listitem', { name: 'DeepSeek' })
    const claude = screen.getByRole('listitem', { name: 'Claude' })
    expect(balance.compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(line.compareDocumentPosition(claude) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('窗口名写「5时」「周」', () => {
    render(<QuotaPanel quota={{ claude: CLAUDE }} now={NOW} />)
    const claude = screen.getByRole('listitem', { name: 'Claude' })
    expect([...claude.querySelectorAll('.ben-wb__usage-qlabel')].map(one => one.textContent)).toEqual(['5时', '周'])
  })

  it('有一扇窗用完了:格脚「Kimi 5 小时额度已用完」「14:30 重置」;都没用完就没有格脚', () => {
    const { container, unmount } = render(<QuotaPanel quota={{ claude: CLAUDE, kimi: KIMI }} now={NOW} />)
    const foot = container.querySelector('.ben-wb__usage-qfoot')!
    expect([...foot.children].map(one => one.textContent)).toEqual(['Kimi 5 小时额度已用完', '14:30 重置'])
    unmount()
    const again = render(<QuotaPanel quota={{ claude: CLAUDE }} now={NOW} />)
    expect(again.container.querySelector('.ben-wb__usage-qfoot')).toBeNull()
  })
})
