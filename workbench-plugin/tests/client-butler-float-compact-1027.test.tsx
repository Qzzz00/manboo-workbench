// 悬浮球展开窗只放四样(2026-10-27,合并稿第四、五节):待你处理、最近结果、在跑的事项、交代入口。
// 球周围的执行星座退休(由协作区轨迹表达),事项收纳夹退休(归协作区);在跑的那几件能「在协作区查看」。
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ButlerInbox } from '../src/client/ButlerInbox.tsx'
import { runningTaskIdsOfRuns } from '../src/client/businessExecutionModel.ts'
import type { RunSegment, WorkbenchState } from '../src/protocol.ts'

afterEach(cleanup)
const AT = '2026-10-27T10:00:00.000Z'
const controls = { paused: false, testRinging: false, proposals: [], onPause() {}, onTestRing() {}, onCancelWatch() {}, onDismissBrief() {} }
const state = {
  agents: [], sessions: [], quota: {}, now: AT, stale: false,
  tasks: { tasks: [
    { id: 'a', title: '接续原会话', status: 'doing', assignee: 'codex', source: { kind: 'manual' }, created_at: AT, updated_at: AT },
    { id: 'b', title: '早报', status: 'done', source: { kind: 'manual' }, created_at: AT, updated_at: AT },
  ], sprints: [], modules: [], project_meta: [] },
  running: { scope: 'classified_business_tasks', count: 1, observed_count: 1, items: [{ key: 'task:a', agent: 'codex', task_id: 'a', text: '接续原会话', role: 'business' }], excluded: [] },
  butler_inbox: { items: [] },
} as unknown as WorkbenchState
const fetchImpl = (async () => new Response('{}', { headers: { 'content-type': 'application/json' } })) as typeof fetch
const mount = (onLocate = vi.fn()) => render(<ButlerInbox state={state} controls={controls} fetchImpl={fetchImpl} baseUrl="http://x" draft="" onDraftChange={() => {}} visible onOpenConversation={() => {}} compact onLocate={onLocate} />)

describe('展开窗四样', () => {
  it('没有星座、没有事项收纳夹', () => {
    const { container } = mount()
    expect(container.querySelector('.ben-wb__task-constellation')).toBeNull()
    expect(container.querySelector('.ben-wb__result-folders')).toBeNull()
  })
  it('在跑的事项一件一行,写执行者,能去协作区看', () => {
    const onLocate = vi.fn()
    mount(onLocate)
    const list = screen.getByRole('region', { name: '在跑的事项' })
    expect(list).toHaveTextContent('接续原会话')
    expect(list).toHaveTextContent('Codex')
    expect(list).not.toHaveTextContent('早报')
    fireEvent.click(within(list).getByRole('button', { name: '在协作区查看 接续原会话' }))
    expect(onLocate).toHaveBeenCalledWith('a')
  })
  it('交代入口还在', () => {
    mount()
    expect(screen.getByLabelText('交给事务官一件事')).toBeInTheDocument()
  })
})

// 在跑的事项与 /collab/runs 同一本账(2026-10-28,断点④):事务官窗曾「在跑的事项 0」而 /collab/runs 有两条在跑
// (快照与任务日志各数各的)。这一列改读运行片段;服务没接上才退回 /state.running 快照口径。
describe('在跑的事项读 /collab/runs', () => {
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
  const mountWith = (given: WorkbenchState, givenFetch: typeof fetch, onLocate = vi.fn()) => render(<ButlerInbox state={given} controls={controls} fetchImpl={givenFetch} baseUrl="http://x" draft="" onDraftChange={() => {}} visible onOpenConversation={() => {}} compact onLocate={onLocate} />)
  const runningList = () => screen.getByRole('region', { name: '在跑的事项' })

  it('快照说没有在跑、/collab/runs 有一条在跑——那件事项摆出来', async () => {
    mountWith(emptyRunningState, fetchRuns({ runs: [segment('a', 'running')] }))
    await waitFor(() => expect(runningList()).toHaveTextContent('接续原会话'))
    expect(runningList().querySelector('h4 span')).toHaveTextContent('1')
    expect(runningList()).not.toHaveTextContent('这会儿没有在跑的事项')
  })
  it('/collab/runs 说那段已收场——不摆(与协作区实际执行同一本账,不各说各话)', async () => {
    mountWith(emptyRunningState, fetchRuns({ runs: [segment('a', 'done')] }))
    await waitFor(() => expect(runningList()).toHaveTextContent('这会儿没有在跑的事项'))
    expect(runningList()).not.toHaveTextContent('接续原会话')
  })
  it('暂停等待不算在跑', async () => {
    mountWith(emptyRunningState, fetchRuns({ runs: [segment('a', 'paused')] }))
    await waitFor(() => expect(runningList()).toHaveTextContent('这会儿没有在跑的事项'))
  })
  it('/collab/runs 没接上——退回快照口径,照旧摆快照里那件', () => {
    // 默认 fetch 对 /collab/runs 回 '{}'(runs 不是数组 = 没接上)。
    mountWith(state, fetchRuns({}))
    expect(runningList()).toHaveTextContent('接续原会话')
  })
  it('在跑口径:只算未收场且开工的业务片段,按事项去重', () => {
    const ids = runningTaskIdsOfRuns([
      segment('a', 'running'),
      { ...segment('a', 'running'), session_id: 's2' },
      segment('b', 'dispatched'),
      segment('c', 'paused'),
      segment('d', 'failed'),
      { ...segment('e', 'running'), role: 'coordination' },
    ])
    expect(ids).toEqual(['a'])
  })
})
