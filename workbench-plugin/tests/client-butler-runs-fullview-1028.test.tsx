// 完整视图与展开窗同一本账(2026-10-28,断点④残留):球下计数行(items/running)与汇报条
// (BusinessExecution 的「业务任务正在执行 n 件」)也读 /collab/runs,不再各读 /state.running 快照;
// 没接上('missing')退回快照口径,与 compact 分支同一退回纪律。
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ButlerInbox } from '../src/client/ButlerInbox.tsx'
import type { RunSegment, WorkbenchState } from '../src/protocol.ts'

afterEach(cleanup)
const AT = '2026-10-27T10:00:00.000Z'
const controls = { paused: false, testRinging: false, proposals: [], onPause() {}, onTestRing() {}, onCancelWatch() {}, onDismissBrief() {} }
const state = {
  agents: [], sessions: [], quota: {}, now: AT, stale: false,
  tasks: { tasks: [
    { id: 'a', title: '接续原会话', status: 'doing', assignee: 'codex', source: { kind: 'manual' }, created_at: AT, updated_at: AT },
  ], sprints: [], modules: [], project_meta: [] },
  // 快照说「在跑 1 件」:没接上 /collab/runs 时两处都退回这个口径。
  running: { scope: 'classified_business_tasks', count: 1, observed_count: 1, items: [{ key: 'task:a', agent: 'codex', task_id: 'a', text: '接续原会话', role: 'business' }], excluded: [] },
  butler_inbox: { items: [] },
} as unknown as WorkbenchState
const emptyRunningState = {
  ...state,
  running: { scope: 'classified_business_tasks', count: 0, observed_count: 0, items: [], excluded: [] },
} as unknown as WorkbenchState
const segment = (taskId: string, status: RunSegment['status']): RunSegment => ({
  task_id: taskId, status, role: 'business', source: 'kimi', started_at: AT,
})
const fetchRuns = (runsBody: unknown) => (async (input: RequestInfo | URL) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
  if (url.includes('/collab/runs')) return new Response(JSON.stringify(runsBody), { headers: { 'content-type': 'application/json' } })
  return new Response('{}', { headers: { 'content-type': 'application/json' } })
}) as typeof fetch
const mount = (given: WorkbenchState, givenFetch: typeof fetch) => render(<ButlerInbox state={given} controls={controls} fetchImpl={givenFetch} baseUrl="http://x" draft="" onDraftChange={() => {}} visible onOpenConversation={() => {}} />)
const summaryButton = (name: string) => screen.getByRole('button', { name })

describe('完整视图读 /collab/runs', () => {
  it('快照说 0 件、/collab/runs 有一条在跑——汇报条数出 1,清单里摆那件事', async () => {
    mount(emptyRunningState, fetchRuns({ runs: [segment('a', 'running')] }))
    await waitFor(() => expect(summaryButton('业务任务正在执行 1 件')).toBeInTheDocument())
    fireEvent.click(summaryButton('业务任务正在执行 1 件'))
    expect(screen.getByRole('region', { name: '正在执行的业务任务' })).toHaveTextContent('接续原会话')
  })
  it('快照与 runs 一致在跑——台上那张卡在数、汇报条 1 件', async () => {
    const { container } = mount(state, fetchRuns({ runs: [segment('a', 'running')] }))
    await waitFor(() => expect(summaryButton('业务任务正在执行 1 件')).toBeInTheDocument())
    expect(container.querySelector('[data-task-card="a"]')).not.toBeNull()
  })
  it('/collab/runs 说那段已收场、快照还说在跑——按 runs 口径不数,台上那张卡也不摆', async () => {
    const { container } = mount(state, fetchRuns({ runs: [segment('a', 'done')] }))
    await waitFor(() => expect(summaryButton('业务任务正在执行 0 件')).toBeInTheDocument())
    expect(container.querySelector('[data-task-card="a"]')).toBeNull()
    fireEvent.click(summaryButton('业务任务正在执行 0 件'))
    expect(screen.getByRole('region', { name: '正在执行的业务任务' }).querySelector('li')).toBeNull()
  })
  it('/collab/runs 没接上(回 \'{}\')——退回快照口径,数字与台上那张卡照旧', () => {
    const { container } = mount(state, fetchRuns({}))
    expect(summaryButton('业务任务正在执行 1 件')).toBeInTheDocument()
    expect(container.querySelector('[data-task-card="a"]')).not.toBeNull()
  })
})
