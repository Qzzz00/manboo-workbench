/**
 * **额度面板上 Antigravity 那一格照它页面原样列**(2026-09-27,卡 AG)。
 *
 * 维护者原话:「为什么我肉眼都看到额度信息了,但是还说读不到或者读反了」。
 * 「读到」不只是读到一个数 —— 他那一页上是**两组模型 × 两条限额 = 四行**,
 * 面板上就得是四行两组,组名是从那一页上读回来的原话。
 *
 * 按 DOM 钉(同卡 QU 的规矩):老四格那副骨架一个类名没动(`ben-wb__usage-qbar` / `-qtrack` / `-qpct`),
 * 只在**换组的那一行前面**多一条 `ben-wb__usage-qgroup` 小标题;没分组的那几家这一条压根不出现。
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentQuotaView } from '../src/protocol.ts'
import { QuotaPanel } from '../src/client/QuotaPanel.tsx'
import { quotaBarRows } from '../src/client/AgentQuotaCells.tsx'

afterEach(cleanup)

const NOW = '2026-09-27T02:30:00.000Z'

/** 服务端顶上来的那一份(与 `openQuotaView` 出来的一字不差)。 */
const ANTIGRAVITY: AgentQuotaView = {
  id: 'antigravity',
  title: 'Antigravity',
  state: 'numbers',
  level: 'ok',
  left_pct: 98,
  line: '还剩约 98%',
  source: '10:30 在 Antigravity 的窗口上读到的:「Gemini Models」「Weekly Limit Remaining」「100%」、…',
  windows: [
    { group: 'Gemini Models', label: 'Weekly Limit Remaining', left_pct: 100 },
    { group: 'Gemini Models', label: 'Five Hour Limit Remaining', left_pct: 98 },
    { group: 'Claude and GPT models', label: 'Weekly Limit Remaining', left_pct: 100 },
    { group: 'Claude and GPT models', label: 'Five Hour Limit Remaining', left_pct: 100 },
  ],
}

/** 没分组的那一家(豆包办公两扇窗):这一条小标题不该出现。 */
const DOUBAO: AgentQuotaView = {
  id: 'doubao', title: '豆包办公', state: 'numbers', level: 'ok', left_pct: 62, line: '还剩约 62%',
  windows: [{ label: '当前时段', left_pct: 81 }, { label: '近 7 天', left_pct: 62 }],
}

function row(name: string): HTMLElement {
  return screen.getByRole('listitem', { name })
}

describe('卡 AG:面板上照它页面原样列四行两组', () => {
  it('★四条横条、两条组名小标题,组名与行名都是原话', () => {
    render(<QuotaPanel quota={{}} now={NOW} agentQuota={[ANTIGRAVITY]} />)
    const at = row('Antigravity')
    expect(at.querySelectorAll('.ben-wb__usage-qbar')).toHaveLength(4)
    const groups = [...at.querySelectorAll('.ben-wb__usage-qgroup')].map(one => one.textContent)
    expect(groups).toEqual(['Gemini Models', 'Claude and GPT models'])
    const labels = [...at.querySelectorAll('.ben-wb__usage-qlabel')].map(one => one.textContent)
    expect(labels).toEqual([
      'Weekly Limit Remaining', 'Five Hour Limit Remaining',
      'Weekly Limit Remaining', 'Five Hour Limit Remaining',
    ])
    expect([...at.querySelectorAll('.ben-wb__usage-qpct')].map(one => one.textContent))
      .toEqual(['100%', '98%', '100%', '100%'])
  })

  it('★老四格那副骨架一个类名没动(组名只是多出来的一条小标题)', () => {
    render(<QuotaPanel quota={{}} now={NOW} agentQuota={[ANTIGRAVITY]} />)
    const at = row('Antigravity')
    expect(at.querySelectorAll('.ben-wb__usage-qbars')).toHaveLength(1)
    expect(at.querySelectorAll('.ben-wb__usage-qtrack')).toHaveLength(4)
  })

  it('★没分组的那几家不出这条小标题(豆包办公的两扇窗照旧两条,一条标题都没有)', () => {
    render(<QuotaPanel quota={{}} now={NOW} agentQuota={[DOUBAO]} />)
    const at = row('豆包办公')
    expect(at.querySelectorAll('.ben-wb__usage-qbar')).toHaveLength(2)
    expect(at.querySelectorAll('.ben-wb__usage-qgroup')).toHaveLength(0)
  })

  it('★`quotaBarRows` 把组名原样带给界面(界面自己不编组名)', () => {
    expect(quotaBarRows(ANTIGRAVITY).map(one => one.group)).toEqual([
      'Gemini Models', 'Gemini Models', 'Claude and GPT models', 'Claude and GPT models',
    ])
    expect(quotaBarRows(DOUBAO).every(one => one.group === undefined)).toBe(true)
  })
})

/**
 * ★ **卡 AN(2026-09-27):原生那条路出来的那一份,电脑页面与手机两端照旧对得上。**
 *
 * 原生这条路(直接问 Antigravity 在本机的语言服务)与窗口读法出的是**同一副骨架**
 * (`AgentQuotaView.windows`),所以卡 AG 做的四行两组一行界面代码都不用改 —— 这几例就是钉这一点:
 * 界面认的是 `windows`,不认「这个数是从哪条路来的」。
 */
describe('原生那条路出来的那一份(卡 AN)', () => {
  /** `antigravityNativeView` 出来的一字不差(那边用例钉的就是这一份)。 */
  const NATIVE: AgentQuotaView = {
    id: 'antigravity',
    title: 'Antigravity',
    state: 'numbers',
    level: 'ok',
    left_pct: 98,
    line: '还剩约 98%',
    read_at: NOW,
    reset_at: '2026-09-27T07:05:04Z',
    source: '10:30 直接问 Antigravity 在本机的语言服务读到的:「Gemini Models」「Weekly Limit Remaining」「100%」、「Gemini Models」「Five Hour Limit Remaining」「98%」、「Claude and GPT models」「Weekly Limit Remaining」「100%」、「Claude and GPT models」「Five Hour Limit Remaining」「100%」',
    windows: [
      { group: 'Gemini Models', label: 'Weekly Limit Remaining', left_pct: 100, reset_at: '2026-10-03T07:35:07Z' },
      { group: 'Gemini Models', label: 'Five Hour Limit Remaining', left_pct: 98, reset_at: '2026-09-27T07:05:04Z' },
      { group: 'Claude and GPT models', label: 'Weekly Limit Remaining', left_pct: 100, reset_at: '2026-10-04T02:05:04Z' },
      { group: 'Claude and GPT models', label: 'Five Hour Limit Remaining', left_pct: 100, reset_at: '2026-09-27T07:05:04Z' },
    ],
  }

  it('★四条横条 + 两条组名小标题,与窗口读法那一份画出来一模一样', () => {
    render(<QuotaPanel quota={{}} now={NOW} agentQuota={[NATIVE]} />)
    const at = row('Antigravity')
    expect([...at.querySelectorAll('.ben-wb__usage-qgroup')].map(one => one.textContent))
      .toEqual(['Gemini Models', 'Claude and GPT models'])
    expect([...at.querySelectorAll('.ben-wb__usage-qlabel')].map(one => one.textContent)).toEqual([
      'Weekly Limit Remaining', 'Five Hour Limit Remaining',
      'Weekly Limit Remaining', 'Five Hour Limit Remaining',
    ])
    expect([...at.querySelectorAll('.ben-wb__usage-qpct')].map(one => one.textContent))
      .toEqual(['100%', '98%', '100%', '100%'])
  })

  it('★`quotaBarRows` 认的是 `windows`,不认这个数是从哪条路来的', () => {
    expect(quotaBarRows(NATIVE).map(one => [one.group, one.label, one.right]))
      .toEqual(quotaBarRows(ANTIGRAVITY).map(one => [one.group, one.label, one.right]))
  })
})
