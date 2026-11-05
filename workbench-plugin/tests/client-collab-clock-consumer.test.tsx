import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import type { RunSegment, TaskView } from '../src/protocol.ts'
import { RunsPanel, runLine } from '../src/client/collab/RunsPanel.tsx'
import { NoteTalk } from '../src/client/collab/NoteTalk.tsx'
import { TimelineActual } from '../src/client/collab/TimelineActual.tsx'
import type { CollabApi } from '../src/client/collab/collabApi.ts'
afterEach(cleanup)
const run: RunSegment = { task_id: 't1', source: 'codex', status: 'done', started_at: '2026-10-24T01:00:00Z', finished_at: '2026-10-24T01:10:00Z', execution_started_observed_at: '2026-10-24T01:02:00Z', execution_finished_observed_at: '2026-10-24T01:09:00Z', outcome: 'replied' }
const task = { id: 't1', goal_id: 'g1', title: '原事项', status: 'confirm', source: { kind: 'manual' }, created_at: run.started_at, updated_at: run.finished_at } as TaskView
const api: CollabApi = { get: async () => ({ runs: [run], items: [{ type: 'run', at: run.started_at, segment: run }] }) as never, post: async () => ({ ok: false, body: {} }) }
it('观察时刻与派出/管线记录分开，不计算实际耗时', () => {
  const text = runLine(run)
  for (const label of ['本机核到开工：', '收到结果：', '派出记录：', '管线收场：']) expect(text).toContain(label)
  expect(text).not.toMatch(/耗时|分钟|–/)
})
it('旧源缺席与仅有结果时不从派出时间补开工', () => {
  const { execution_started_observed_at, execution_finished_observed_at, ...legacy } = run
  expect(runLine(legacy)).toContain('本机核到开工：未知 · 收到结果：未知')
  expect(runLine({ ...legacy, execution_finished_observed_at: execution_finished_observed_at! })).toContain('本机核到开工：未知 · 收到结果：')
})
it('失联片段保留历史观察而不改成正在运行', async () => {
  const unknown = { ...run, status: 'unknown' } as RunSegment
  render(<RunsPanel taskId="t1" api={{ ...api, get: async () => ({ runs: [unknown] }) as never }} />)
  const row = await screen.findByText(/本机核到开工：/)
  expect(row).toHaveAttribute('data-status', 'unknown')
  expect(row).toHaveTextContent('不当作在跑')
  expect(row).not.toHaveTextContent('实际运行中')
})
it('生产活动列表消费同一观察字段', async () => {
  render(<NoteTalk task={task} cards={[]} api={api} onReceipt={() => {}} />)
  expect(await screen.findByText(/本机核到开工：/)).toHaveTextContent('收到结果：')
})
it('生产时间线消费观察字段并保留派出记录日期', async () => {
  render(<TimelineActual tasks={[task]} api={api} onOpen={() => {}} />)
  expect(await screen.findByText(/本机核到开工：/)).toHaveTextContent('收到结果：')
  expect(screen.getByText(/派出记录日期/)).toBeInTheDocument()
})
