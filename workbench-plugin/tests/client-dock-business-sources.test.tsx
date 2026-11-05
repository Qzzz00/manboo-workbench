import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { DockTabBar } from '../src/client/DockTabBar.tsx'
import type { RunningView, SessionView } from '../src/protocol.ts'

afterEach(cleanup)

it('窗口槽白点按各家真实运行会话计，同一业务双来源仍只是一件业务', () => {
  const sessions = ['codex:worker', 'kimi:worker', 'codex:manager'].map(value => {
    const [agent, session_id] = value.split(':')
    return { agent, session_id, title: value, status: 'running', updated_at: '2026-10-26T08:00:00Z', unread: false,
      elapsed_sec: 10, project: '' } as SessionView
  })
  const running: RunningView = { scope: 'classified_business_tasks', count: 1, observed_count: 1,
    items: [{ key: 'task:business', task_id: 'business', agent: 'codex', text: '图谱返修', role: 'business', sources: [
      { task_id: 'business', agent: 'codex', session_id: 'worker', role: 'business', state: 'running', rounds: [] },
      { task_id: 'business', agent: 'kimi', session_id: 'worker', role: 'business', state: 'running', rounds: [] },
    ] }], excluded: [{ key: 'task:manager', task_id: 'manager', agent: 'codex', text: '统筹', role: 'coordination', sources: [
      { task_id: 'manager', agent: 'codex', session_id: 'manager', role: 'coordination', state: 'running', rounds: [] },
    ] }] }
  render(<DockTabBar dock={{ stack: [{ key: 'codex', label: 'Codex', running: true, current: true },
    { key: 'kimi', label: 'Kimi', running: true, current: false }] } as never}
    sessions={sessions} badges={{}} baseUrl="" fetchImpl={vi.fn() as never} butlerActive={false} onSelectButler={() => {}} running={running} />)
  expect(running.count).toBe(1)
  const codex = screen.getByRole('button', { name: 'Codex' }).closest('.ben-wb__dock-tab')!
  const kimi = screen.getByRole('button', { name: 'Kimi' }).closest('.ben-wb__dock-tab')!
  expect(codex.querySelector('[data-tone=running] .ben-wb__dock-badge-dot')).toHaveAttribute('aria-label', '运行会话 2')
  expect(kimi.querySelector('[data-tone=running] .ben-wb__dock-badge-dot')).toHaveAttribute('aria-label', '运行会话 1')
})
