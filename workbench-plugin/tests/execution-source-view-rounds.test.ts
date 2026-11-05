import { describe, expect, it } from 'vitest'
import type { TaskView } from '../src/protocol.ts'
import { EXECUTION_VIEW_ROUNDS, executionSourceView } from '../src/server/executionState.ts'
import type { CodexExecutionSource } from '../src/server/codexExecutionFacts.ts'

const task: TaskView = { id: 't-1', title: 't-1', status: 'doing', source: { kind: 'manual' }, created_at: '', updated_at: '', links: [{ agent: 'codex', session_id: 's-1' }] }

function longSource(n: number): CodexExecutionSource {
  const events = Array.from({ length: n }, (_, i) => ({
    id: `event-${i}`, round: `round-${Math.floor(i / 3)}`, kind: (i % 3 === 0 ? 'started' : i % 3 === 1 ? 'updated' : 'ended') as 'started' | 'updated' | 'ended',
    at: new Date(Date.UTC(2026, 9, 26, 0, i)).toISOString(),
  }))
  return { task_id: 't-1', agent: 'codex', session_id: 's-1', state: 'returned', events }
}

describe('/state 里的执行来源只带最近几轮', () => {
  it('长会话不把全部历史事件塞进快照(1.8 MB 的 /state 过不了房间 1 MB 上限,手机首页一直「电脑不在线」)', () => {
    const view = executionSourceView(longSource(200), task)
    expect(view.rounds).toHaveLength(EXECUTION_VIEW_ROUNDS)
    expect(view.rounds.at(-1)).toMatchObject({ event_id: 'event-199', kind: 'updated' })
  })

  it('事件不多时原样带上', () => {
    const view = executionSourceView(longSource(2), task)
    expect(view.rounds.map(one => one.event_id)).toEqual(['event-0', 'event-1'])
  })
})
