/**
 * ★ 2026-10-03「消耗数据按模板分流」—— **分叉只在 `client/UsageModule.tsx` 那一处**。
 *
 * 维护者原话:「他做的全塞进自媒体布局里,产品研发布局改回之前的样子……我就说咋我的都变了」
 * 「主要是消耗数据,改成我自己之前在用的啊,其他的可以不改」。
 *
 * 这一份钉的就是那一处:
 * - 运营(自媒体)模板 → 他那一版(`air/usage.js`,根节点 `.creator-usage`);
 * - 产品研发模板 → 0.4.89 那一版(`UsagePanel.tsx`,三标签页 总览/项目/模型);
 * - **模板整块缺席也走产品研发那一版** —— 缺省模板就是 product,老客户端与没接模板服务的
 *   那些地方(展示台、手机、一大批用例)于是与 0.4.89 逐字相同。
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TemplateStateView, UsageState, WorkbenchState } from '../src/protocol.ts'
import { PRODUCT_TEMPLATE } from '../src/templates.ts'
import { UsageModule, usesAirUsagePanel } from '../src/client/UsageModule.tsx'

afterEach(cleanup)

const USAGE: UsageState = {
  days: [{
    date: '2026-09-01',
    by_project: { Aiboo: { input: 1_000, output: 0, cache_read: 0, cache_write: 0 } },
    by_model: { 'gpt-5-codex': { input: 1_000, output: 0, cache_read: 0, cache_write: 0 } },
    by_source: { codex: { input: 1_000, output: 0, cache_read: 0, cache_write: 0 } },
    sessions: 1,
    messages: 1,
    hour_counts: {},
  }],
  sources: { codex: { status: 'ok' } },
  scanned_at: '2026-09-02T00:00:00Z',
}

function templateView(id: string): TemplateStateView {
  return {
    id,
    name: id,
    project_word: '项目',
    project_empty_line: '',
    module_titles: {},
    board_lanes: [],
    has_backup: false,
  }
}

function renderModule(template: TemplateStateView | undefined) {
  const state = {
    usage: USAGE,
    now: '2026-09-02T10:00:00+08:00',
    ...(template === undefined ? {} : { template }),
  } as unknown as WorkbenchState
  return render(
    <UsageModule
      box={{
        id: 'usage',
        title: '消耗数据',
        basisPct: 30,
        dragging: false,
        onResizeStart: vi.fn(),
        onResizeMove: vi.fn(),
        onResizeEnd: vi.fn(),
      }}
      header={<h2 id="h-usage">消耗数据</h2>}
      headingId="h-usage"
      feed={{ state }}
    />,
  )
}

describe('挑哪一版面板', () => {
  it('运营(自媒体)模板 → 他那一版', () => {
    renderModule(templateView('ops'))
    expect(document.querySelector('.creator-usage')).not.toBeNull()
    // 0.4.89 那一版的三标签页不在场。
    expect(screen.queryByRole('tab', { name: '总览' })).toBeNull()
  })

  it('产品研发模板 → 0.4.89 那一版(他自己之前在用的那个)', () => {
    renderModule(templateView(PRODUCT_TEMPLATE.id))
    expect(document.querySelector('.creator-usage')).toBeNull()
    for (const name of ['总览', '项目', '模型']) {
      expect(screen.getByRole('tab', { name }), name).toBeInTheDocument()
    }
  })

  it('★ 模板整块缺席(展示台 / 手机 / 老服务端)也走产品研发那一版', () => {
    renderModule(undefined)
    expect(document.querySelector('.creator-usage')).toBeNull()
    expect(screen.getByRole('tab', { name: '总览' })).toBeInTheDocument()
  })

  it('判据只认 /state.template.id 与 templates.ts 那一份,不另造一张表', () => {
    expect(usesAirUsagePanel(templateView('ops'))).toBe(true)
    expect(usesAirUsagePanel(templateView(PRODUCT_TEMPLATE.id))).toBe(false)
    expect(usesAirUsagePanel(undefined)).toBe(false)
    // 2026-10-23(分层二刀二):判据改成「非缺省模板即她那一份」 —— 用户层加的别的模板
    // 也走她那一版面板的同一条路,不再白名单点名。
    expect(usesAirUsagePanel(templateView('something-else'))).toBe(true)
  })
})
