/**
 * ★ 2026-10-03:**Claude 额度格不许再笼统地写「未接入」**。
 *
 * 维护者 10-03 午后那一段:「Claude 额度格如实显示『Claude 桌面端没再提供』不再追」。
 *
 * 这一种的真相是:钩子接着、文件也在,只是
 * `~/Library/Application Support/Claude/plan-usage-history.json` 里最后一个样本
 * 已经几小时前了(桌面端这段时间没在跑)。写「未接入」等于告诉她"去接一下",
 * 而她什么都不用做 —— 两件事差得远。
 *
 * **不加新数据源、不碰凭据**:这张卡只换这一格说的话。
 * 认这一种靠的是 `protocol.ts` 的 `CLAUDE_DESKTOP_GONE`(一份字,取数层写、界面层读)。
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentQuotaView, QuotaEntry } from '../src/protocol.ts'
import { CLAUDE_DESKTOP_GONE, claudeDesktopGoneNote } from '../src/protocol.ts'
import { QUOTA_NO_RECORD_VALUE, quotaCells } from '../src/client/quotaCells.ts'
import { QuotaPanel } from '../src/client/QuotaPanel.tsx'

afterEach(cleanup)

const NOW = '2026-10-03T12:00:00+08:00'
const GONE: QuotaEntry = { kind: 'unknown', note: claudeDesktopGoneNote(15 * 60 * 60 * 1000) }
/** 服务端那一格:装了、接上了,只是这一轮没取到 —— 它那句 `why` 是笼统的「这次没取到」。 */
const VAGUE: AgentQuotaView = {
  id: 'claude',
  title: 'Claude',
  state: 'unconnected',
  // 形状照 server/agentQuota.ts 的 unconnected():没接上那一格**不带 level**。
  line: '没接上:这次没取到',
  short: '没接上:这次没取到',
  why: '这次没取到',
}

function claudeCell(view?: AgentQuotaView) {
  const cells = quotaCells({ claude: GONE }, {}, new Date(NOW), undefined, view === undefined ? undefined : [view])
  const cell = cells.find(one => one.agent === 'claude')
  if (cell === undefined) throw new Error('这一排里没有 Claude 那一格')
  return cell
}

describe('Claude 桌面端没再提供用量记录', () => {
  it('★ 大字写的是实话,不是「未接入」', () => {
    const cell = claudeCell(VAGUE)
    expect(cell.value).toBe(QUOTA_NO_RECORD_VALUE)
    expect(cell.value).not.toBe('未接入')
  })

  it('那句话带岁数,按小时写', () => {
    expect(claudeCell(VAGUE).note).toBe(`${CLAUDE_DESKTOP_GONE}(最后一次 15 小时前)`)
  })

  it('服务端那句笼统的「这次没取到」在这一种上让位', () => {
    expect(claudeCell(VAGUE).note).not.toBe('这次没取到')
  })

  it('不画条、也不编一个百分比(连一个旧数都没有)', () => {
    const cell = claudeCell(VAGUE)
    expect(cell.showBar).toBe(false)
    expect(cell.bars).toEqual([])
    expect(cell.value).not.toMatch(/%/)
  })

  it('没有 agent_quota 那一份(展示台那份副本 / 老服务端)也照说', () => {
    expect(claudeCell().value).toBe(QUOTA_NO_RECORD_VALUE)
  })

  it('★ 那句话摊在明面上,不折进「说明」里', () => {
    render(<QuotaPanel quota={{ claude: GONE }} now={NOW} agentQuota={[VAGUE]} agents={['claude']} />)
    const note = screen.getByText(`${CLAUDE_DESKTOP_GONE}(最后一次 15 小时前)`)
    expect(note).toBeInTheDocument()
    // 折着的那一支是 <details><summary>说明</summary>,这一格不该走它。
    expect(note.closest('details')).toBeNull()
    expect(screen.queryByText('未接入')).toBeNull()
  })

  it('别的家 / 别的原因照旧写「未接入」(这一条只认桌面端那一种)', () => {
    const other: QuotaEntry = { kind: 'unknown', note: '取数方式待实测' }
    const cells = quotaCells({ claude: other }, {}, new Date(NOW))
    expect(cells.find(one => one.agent === 'claude')?.value).toBe('未接入')
  })
})
