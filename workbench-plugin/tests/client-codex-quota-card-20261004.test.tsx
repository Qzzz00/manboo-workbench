/**
 * ★ 2026-10-04 自媒体布局「消耗数据」上的 **Codex 剩余额度** 卡(运营同学交回的那一版)。
 *
 * 维护者点名的四条:
 *
 * ① **优先 5 小时窗口、另列一周窗口**;
 * ② 数**只**从 `/state.quota.codex`(`kind:'quota'` 的 windows)与 `/state.agent_quota` 里 codex
 *    那一格取,**取不到就照实说「暂未读取」,不推算**(一个数都不从 token 用量折算);
 * ③ 删掉「豆包办公 未接入用量」那一格与「豆包办公尚未纳入」那半句;
 * ④ `recorded/3` 改成按 sources 的实际条数。
 *
 * ⑤ 这张卡**只在自媒体布局上** —— 产品研发布局的消耗数据是另一版面板(`UsagePanel.tsx`,
 *    见 client-usage-by-template),那边一个字不变。
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentQuotaView, QuotaEntry, TemplateStateView, UsageState, WorkbenchState } from '../src/protocol.ts'
import { PRODUCT_TEMPLATE } from '../src/templates.ts'
import { CODEX_QUOTA_UNREAD, codexQuotaOf } from '../src/client/codexQuota.ts'
import { UsageModule } from '../src/client/UsageModule.tsx'

afterEach(cleanup)

const USAGE: UsageState = {
  days: [{
    date: '2026-10-03',
    by_project: {}, by_model: {},
    by_source: { codex: { input: 1_000, output: 0, cache_read: 0, cache_write: 0 } },
    sessions: 1, messages: 1, hour_counts: {},
  }],
  sources: { codex: { status: 'ok' } },
  scanned_at: '2026-10-04T00:00:00Z',
}

const WINDOW_QUOTA: QuotaEntry = {
  kind: 'quota',
  windows: [
    { label: '5h', left_pct: 42.4, reset_at: '2026-10-04T14:00:00+08:00' },
    { label: '周', left_pct: 81.6 },
  ],
  as_of: '2026-10-04T09:00:00+08:00',
} as QuotaEntry

function templateView(id: string): TemplateStateView {
  return { id, name: id, project_word: '账号', project_empty_line: '', module_titles: {}, board_lanes: [], has_backup: false } as TemplateStateView
}

function renderModule(patch: Partial<WorkbenchState>, templateId = 'ops') {
  const state = {
    usage: USAGE, now: '2026-10-04T10:00:00+08:00', quota: {},
    template: templateView(templateId),
    ...patch,
  } as unknown as WorkbenchState
  return render(
    <UsageModule
      box={{ id: 'usage', title: '消耗数据', basisPct: 30, dragging: false, onResizeStart: vi.fn(), onResizeMove: vi.fn(), onResizeEnd: vi.fn() }}
      header={<h2 id="h-usage">消耗数据</h2>}
      headingId="h-usage"
      feed={{ state }}
    />,
  )
}

describe('取数:只从那两格来,不推算', () => {
  it('/state.quota.codex 的 windows 优先;5 小时在前、一周另列', () => {
    const view = codexQuotaOf({ codex: WINDOW_QUOTA }, undefined)
    expect(view.five).toEqual({ label: '5h', leftPct: 42, resetAt: '2026-10-04T14:00:00+08:00' })
    expect(view.weekly).toEqual({ label: '周', leftPct: 82 })
    expect(view.head).toBe('42%')
  })

  it('/state.quota 里没有 → 退到 /state.agent_quota 里 codex 那一格', () => {
    const agent: AgentQuotaView = {
      id: 'codex', title: 'Codex', state: 'numbers', line: '5 小时窗口还剩约 9%',
      windows: [{ label: '5 小时', left_pct: 9 }, { label: '本周', left_pct: 55 }],
    }
    const view = codexQuotaOf({}, [agent])
    expect(view.five?.leftPct).toBe(9)
    expect(view.weekly?.leftPct).toBe(55)
  })

  it('两格都没有 → 照实说「暂未读取」,不编一个数', () => {
    const view = codexQuotaOf(undefined, undefined)
    expect(view.five).toBeUndefined()
    expect(view.weekly).toBeUndefined()
    expect(view.head).toBe(CODEX_QUOTA_UNREAD)
    expect(view.why).toContain(CODEX_QUOTA_UNREAD)
  })

  it('那一家没接上(不是 numbers)→ 原样转述它自己那句话,不拿 windows 顶上', () => {
    const agent: AgentQuotaView = {
      id: 'codex', title: 'Codex', state: 'unconnected', line: '没接上:Codex 没登录',
      short: '没接上', why: '没接上:Codex 没登录', windows: [{ label: '5h', left_pct: 30 }],
    }
    const view = codexQuotaOf({}, [agent])
    expect(view.five).toBeUndefined()
    expect(view.head).toBe('没接上')
    expect(view.why).toBe('没接上:Codex 没登录')
  })

  it('百分比夹在 0–100 的整数里(采集层给过越界值)', () => {
    const over = { kind: 'quota', windows: [{ label: '5h', left_pct: 140 }, { label: '周', left_pct: -7 }] } as QuotaEntry
    const view = codexQuotaOf({ codex: over }, undefined)
    expect(view.five?.leftPct).toBe(100)
    expect(view.weekly?.leftPct).toBe(0)
  })
})

describe('画出来是什么样', () => {
  it('有数:卡上写剩余百分比与一周那一行', () => {
    renderModule({ quota: { codex: WINDOW_QUOTA } })
    const card = screen.getByLabelText('Codex 剩余额度')
    expect(card).toHaveTextContent('42%')
    expect(card).toHaveTextContent('剩余 42%')
    expect(card).toHaveTextContent('周剩余')
    expect(card).toHaveTextContent('82%')
  })

  it('没数:卡还在,写的是「暂未读取」,**没有任何百分比**', () => {
    renderModule({ quota: {} })
    const card = screen.getByLabelText('Codex 剩余额度')
    expect(card).toHaveTextContent(CODEX_QUOTA_UNREAD)
    expect(card.textContent ?? '').not.toMatch(/\d+%/)
  })

  it('豆包办公那一格与那半句都没了;分母按真的摆了几格', () => {
    renderModule({ quota: { codex: WINDOW_QUOTA } })
    expect(screen.queryByText('未接入用量')).toBeNull()
    expect(screen.queryByText(/豆包办公/)).toBeNull()
    expect(screen.getByText(/项工具可读取/).textContent).toContain('1/1 项工具可读取')
  })

  it('产品研发布局上没有这张卡(消耗数据是另一版面板)', () => {
    renderModule({ quota: { codex: WINDOW_QUOTA } }, PRODUCT_TEMPLATE.id)
    expect(screen.queryByLabelText('Codex 剩余额度')).toBeNull()
  })
})
