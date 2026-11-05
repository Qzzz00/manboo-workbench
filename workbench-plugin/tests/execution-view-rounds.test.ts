// @vitest-environment node
// executionSourceView() 的 rounds 按 events 数组引用备忘:引用不变不重建(备忘的是截到最近 EXECUTION_VIEW_ROUNDS 条的那份);其余字段每拍现算。
import { expect, it } from 'vitest'
import { executionSourceView as view } from '../src/server/executionState.ts'
import type { CodexExecutionSource } from '../src/server/codexExecutionFacts.ts'
import type { TaskView } from '../src/protocol.ts'

const task: TaskView = {
  id: 't-1', title: '事项', status: 'doing', source: { kind: 'manual' }, created_at: '', updated_at: '',
  links: [{ agent: 'codex', session_id: 's-1', execution_role: { kind: 'business', origin: 'explicit_task' } }],
}
const sourceOf = (events: readonly { id: string, round: string, kind: 'started' | 'updated' | 'ended', at: string }[]): CodexExecutionSource => ({
  task_id: 't-1', agent: 'codex', session_id: 's-1', state: 'running', events: events as never,
})
const EVENTS = [
  { id: 'e-1', round: 'r-1', kind: 'started', at: '2026-10-26T01:00:00.000Z' },
  { id: 'e-2', round: 'r-1', kind: 'updated', at: '2026-10-26T01:01:00.000Z' },
] as const

it('events 引用不变:rounds 不重建(同一数组引用);state 等其余字段每拍现算', () => {
  const source = sourceOf(EVENTS)
  const first = view(source, task)
  const second = view(source, task)
  expect(second.rounds).toBe(first.rounds)
  expect(second.rounds).toEqual([
    { round: 'r-1', event_id: 'e-1', kind: 'started', at: '2026-10-26T01:00:00.000Z' },
    { round: 'r-1', event_id: 'e-2', kind: 'updated', at: '2026-10-26T01:01:00.000Z' },
  ])
  // 同一引用、状态变了:rounds 照旧复用,state 必须反映新事实。
  const returned = view({ ...source, state: 'returned' }, task)
  expect(returned.state).toBe('returned')
  expect(returned.rounds).toBe(first.rounds)
  // 来源身份字段也不吃旧备忘。
  expect(view({ ...source, unknown: 'stale' }, task).unknown).toBe('stale')
})

it('events 引用变了(文件追加后的新数组):rounds 按新引用重建,内容跟上', () => {
  const grown = sourceOf([...EVENTS, { id: 'e-3', round: 'r-1', kind: 'ended', at: '2026-10-26T01:02:00.000Z' }])
  const viewOfGrown = view(grown, task)
  expect(viewOfGrown.rounds).toHaveLength(3)
  expect(viewOfGrown.rounds.at(-1)).toEqual({ round: 'r-1', event_id: 'e-3', kind: 'ended', at: '2026-10-26T01:02:00.000Z' })
  // 两个不同来源各拿各的 rounds,不串。
  expect(view(sourceOf(EVENTS), task).rounds).toHaveLength(2)
})
