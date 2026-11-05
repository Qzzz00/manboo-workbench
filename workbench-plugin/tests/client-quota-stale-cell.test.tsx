/**
 * 额度区那一格:**读到过的数不写「未接入」**(2026-09-26,卡 QS)。
 *
 * 维护者早上看到的就是这一格:Claude 桌面端几小时没报新用量,老四格里 Claude 那一格从
 * 「29%」翻成了「未接入」。现在服务端(`/state.agent_quota`)一处判好三格,这一格照它说:
 * 有数就写那个数 + 「昨晚 20:42 读到的」(老了再多一句「Claude 桌面没在跑,数字可能旧」、画淡),
 * 「未接入」只留给它也说没接上的时候。
 *
 * 另外钉两条:那句时刻**摊在明面上**(不折进「说明」里,他要一眼看见这个数的年纪);
 * 没有 `agentQuota`(老宿主 / 展示台那份副本)时一个字节不变。
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentQuotaView, ClientsView, QuotaEntry } from '../src/protocol.ts'
import { claudeDesktopGoneNote } from '../src/protocol.ts'
import { QuotaPanel } from '../src/client/QuotaPanel.tsx'
import { quotaCells, quotaSummaryLine } from '../src/client/quotaCells.ts'

afterEach(cleanup)

const NOW = '2026-09-26T12:00:00+08:00'
/**
 * 这一轮没取到(采集层原话已经是人话了,但界面上照服务端那一格说)。
 * ★ 2026-10-03:那句话改由 `protocol.ts` 的 `claudeDesktopGoneNote` 拼,这里跟着读常量。
 */
const MISSED: QuotaEntry = { kind: 'unknown', note: claudeDesktopGoneNote(918 * 60_000) }
/**
 * ★ 2026-10-03:**另外两种「这一轮没取到」**,用来钉「未接入」那一支还在。
 *
 * 为什么要分出来:上面那个 `MISSED` 是**桌面端没再提供用量记录**那一种,它从这一版起
 * 不再写「未接入」(大字是 `QUOTA_NO_RECORD_VALUE`,见 tests/client-quota-claude-desktop-gone.test.tsx)。
 * 「未接入」要留给**真的没接上 / 别的读取失败**,所以这两条用例换成与它们各自的情形
 * 对得上的采集层原话:没装那一种就是那句读不到文件的,别的读取失败就是别的那句。
 */
const NOT_INSTALLED: QuotaEntry = {
  kind: 'unknown',
  note: '读不到 Claude 桌面端报的用量(Claude 桌面端没装或没跑过)',
}
const BROKEN_FILE: QuotaEntry = { kind: 'unknown', note: 'Claude 桌面端用量记录不是合法 JSON' }
const ON = { installed: true, connected: true }
const OFF = { installed: false, connected: false }
const CLIENTS: ClientsView = { claude: ON, codex: ON, kimi: ON, wechat: OFF, wecom: OFF }

/** 服务端顶上来的那一格:昨晚 20:42 读到的 69%,已经老了。 */
const KEPT: AgentQuotaView = {
  id: 'claude',
  title: 'Claude',
  state: 'numbers',
  level: 'ok',
  left_pct: 69,
  line: '本周还剩约 69% · 昨晚 20:42 读到的 · Claude 桌面没在跑,数字可能旧',
  short: '本周还剩约 69% · 昨晚 20:42 读到的 · Claude 桌面没在跑,数字可能旧',
  read_at: '2026-09-25T20:42:00+08:00',
  stale: true,
}

describe('老四格:这一轮取不到数时写上次读到的那个数', () => {
  it('★Claude 那一格写 69% 与「昨晚 20:42 读到的」,不写「未接入」;摊在明面上、格子画淡', () => {
    render(<QuotaPanel quota={{ claude: MISSED }} now={NOW} clients={CLIENTS} agentQuota={[KEPT]} />)
    const cell = screen.getByRole('listitem', { name: 'Claude' })
    expect(cell).toHaveTextContent('69%')
    expect(cell).toHaveTextContent('昨晚 20:42 读到的')
    expect(cell).toHaveTextContent('Claude 桌面没在跑,数字可能旧')
    expect(cell).not.toHaveTextContent('未接入')
    // 采集层的原话不上界面(「过期」「记录」这类内部词一个都不许有)。
    expect(cell).not.toHaveTextContent('918')
    expect(cell).not.toHaveTextContent('过期')
    // 画淡靠这面旗子(样式在 dispatchEyesStyle.ts);那句时刻不在 <details> 里。
    expect(cell.getAttribute('data-stale')).toBe('true')
    expect(cell.querySelector('details')).toBeNull()
    expect(cell.querySelector('[data-kept="true"]')?.textContent).toContain('昨晚 20:42 读到的')
  })

  it('还没老(6 小时以内)的那个数:照写,但不画淡', () => {
    const { stale: _old, ...rest } = KEPT
    const fresh: AgentQuotaView = { ...rest, line: '本周还剩约 69% · 09:05 读到的', short: '本周还剩约 69% · 09:05 读到的' }
    render(<QuotaPanel quota={{ claude: MISSED }} now={NOW} clients={CLIENTS} agentQuota={[fresh]} />)
    const cell = screen.getByRole('listitem', { name: 'Claude' })
    expect(cell).toHaveTextContent('09:05 读到的')
    expect(cell.getAttribute('data-stale')).toBeNull()
  })

  it('★服务端也说没接上 → 照旧「未接入」,原因用它那句人话(不是采集层原话)', () => {
    const gone: AgentQuotaView = {
      id: 'claude', title: 'Claude', state: 'unconnected', line: '没接上:Claude 没装在这台电脑上', why: 'Claude 没装在这台电脑上',
    }
    render(<QuotaPanel quota={{ claude: NOT_INSTALLED }} now={NOW} clients={CLIENTS} agentQuota={[gone]} />)
    const cell = screen.getByRole('listitem', { name: 'Claude' })
    expect(cell).toHaveTextContent('未接入')
    expect(cell).toHaveTextContent('Claude 没装在这台电脑上')
    // 采集层那句原话不往界面上搬(服务端那一格说什么就说什么)。
    expect(cell).not.toHaveTextContent('没装或没跑过')
  })

  it('没有 agentQuota(老宿主、展示台那份副本、只传 quota 的用例)→ 一个字节不变,照旧「未接入 · 采集层那句」', () => {
    render(<QuotaPanel quota={{ claude: BROKEN_FILE }} now={NOW} clients={CLIENTS} />)
    const cell = screen.getByRole('listitem', { name: 'Claude' })
    expect(cell).toHaveTextContent('未接入')
    expect(cell.querySelector('details')).not.toBeNull()
  })

  it('真取到数的那一轮照旧画条(上次那个数只在取不到时顶上来)', () => {
    const live: QuotaEntry = { kind: 'quota', windows: [{ label: '周', left_pct: 29 }] }
    render(<QuotaPanel quota={{ claude: live }} now={NOW} clients={CLIENTS} agentQuota={[KEPT]} />)
    const cell = screen.getByRole('listitem', { name: 'Claude' })
    expect(cell).toHaveTextContent('29%')
    expect(cell.getAttribute('data-kind')).toBe('quota')
    expect(cell.getAttribute('data-stale')).toBeNull()
  })
})

describe('纯净模式顶栏那一行摘要', () => {
  it('也写上次读到的那个数,不写「未接入」', () => {
    const cells = quotaCells({ claude: MISSED }, {}, new Date(NOW), undefined, [KEPT])
    expect(quotaSummaryLine(cells)).toContain('Claude 69%')
    expect(quotaSummaryLine(cells)).not.toContain('Claude 未接入')
  })
})
