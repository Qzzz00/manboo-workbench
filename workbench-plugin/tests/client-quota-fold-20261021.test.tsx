/**
 * 余额 / 额度(2026-10-21,视觉 A):没接上的几家折到最底一行计数,展开才见各自的原因与入口;
 * 有数的几家(含 0%)照常在上面。
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentQuotaView, ClientsView, QuotaEntry } from '../src/protocol.ts'
import { QUOTA_LOCKED_LINE, QUOTA_MORE_DETAIL, QuotaPanel } from '../src/client/QuotaPanel.tsx'

afterEach(cleanup)

const NOW = '2026-09-17T10:30:00+08:00'
const W = (left: number): QuotaEntry => ({ kind: 'quota', windows: [{ label: '周', left_pct: left }] })
const ON = { installed: true, connected: true }
const clients: ClientsView = { claude: ON, codex: { installed: true, connected: false, how: '去设置里登录 Codex。' }, kimi: ON, wechat: { installed: false, connected: false }, wecom: { installed: false, connected: false } }

describe('没接上的几家折到最底', () => {
  it('底部一行计数,原因在折叠里;0% 照常在上面', () => {
    const { container } = render(<QuotaPanel quota={{ claude: W(62), codex: W(91), kimi: W(0) }} now={NOW} clients={clients} onUnlock={() => {}} />)
    const more = container.querySelector('details.ben-wb__usage-qmore')!
    expect(more.querySelector('summary')!.textContent).toBe(`${QUOTA_LOCKED_LINE(1)}${QUOTA_MORE_DETAIL}`)
    expect(more.textContent).toContain('去设置里登录 Codex。')
    const top = screen.getByRole('list', { name: '客户端余额与额度' })
    expect(top.textContent).toContain('Kimi')
    expect(top.textContent).toContain('0%')
    expect(top.textContent).not.toContain('去设置里登录 Codex。')
  })

  /*
   * 2026-10-22 维护者:「读不到最新的,上次 …」那几行(Muse、豆包办公、Manus、Grok Bot)按评审页收成最底一行计数,展开才看明细。
   * 评审页 0cf75042 余额 / 额度:`暂不可用 2 家 · 查看详情 ›`,展开是「Muse · 上次读取 10-20 22:52」「Manus · 尚未接上」。
   */
  it('数老了的、没接上的别家也折进最底一行;有数的、不限的照常在上面;摘要右侧「查看详情 ›」', () => {
    const fresh: AgentQuotaView = { id: 'doubao', title: '豆包办公', state: 'unlimited', line: '不限', source: '官方说明' }
    const stale: AgentQuotaView = { id: 'muse', title: 'Muse', state: 'numbers', level: 'ok', left_pct: 40, line: '读不到最新的,上次 10-03 22:52', stale: true }
    const off: AgentQuotaView = { id: 'manus', title: 'Manus', state: 'unconnected', line: '没接上:没开着', why: '没开着' }
    const { container } = render(<QuotaPanel quota={{ claude: W(62) }} now={NOW} agentQuota={[fresh, stale, off]} agents={['claude']} />)
    const more = container.querySelector('details.ben-wb__usage-qmore')!
    expect(more.querySelector('summary')!.textContent).toBe(`${QUOTA_LOCKED_LINE(2)}${QUOTA_MORE_DETAIL}`)
    expect(within(more as HTMLElement).getByRole('listitem', { name: 'Muse' })).toBeInTheDocument()
    expect(within(more as HTMLElement).getByRole('listitem', { name: 'Manus' })).toBeInTheDocument()
    const top = screen.getByRole('list', { name: '客户端余额与额度' })
    expect(within(top).getByRole('listitem', { name: '豆包办公' })).toBeInTheDocument()
    expect(within(top).queryByRole('listitem', { name: 'Muse' })).toBeNull()
    expect(within(top).queryByRole('listitem', { name: 'Manus' })).toBeNull()
  })

  it('都接上了就没有这一行', () => {
    const { container } = render(<QuotaPanel quota={{ claude: W(62) }} now={NOW} />)
    expect(container.querySelector('.ben-wb__usage-qmore')).toBeNull()
  })
})
