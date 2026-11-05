// 收起球与「在跑的事项」同读 /collab/runs 一本账(2026-10-28,断点④残留,第 3 轮按退修收窄):
// 快照与任务日志曾各数各的 —— 窗里按片段判在跑、收起球还在数快照,同一刻几个数。
// 取数以 main 上的 useCollabRuns 为准,这里只并「收起球 + runningCountOf」两处;
// 服务没接上(undefined / 'missing')退回 /state.running 快照口径,不说瞎话。
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup } from '@testing-library/react'
import { runningCountOf } from '../src/client/businessExecutionModel.ts'
import type { CollabRunFacts } from '../src/client/businessExecutionModel.ts'
import { floatOrbCounts, floatOrbView } from '../src/client/floatOrb.ts'
import type { RunSegment, WorkbenchState } from '../src/protocol.ts'

afterEach(cleanup)
const AT = '2026-10-27T10:00:00.000Z'
const stateWith = (running: unknown): WorkbenchState => ({
  agents: [], sessions: [], quota: {}, now: AT, stale: false,
  tasks: { tasks: [
    { id: 'a', title: '接续原会话', status: 'doing', assignee: 'codex', source: { kind: 'manual' }, created_at: AT, updated_at: AT },
    { id: 'b', title: '早报', status: 'done', source: { kind: 'manual' }, created_at: AT, updated_at: AT },
  ], sprints: [], modules: [], project_meta: [] },
  running,
  butler_inbox: { items: [] },
} as unknown as WorkbenchState)
const runningOne = { scope: 'classified_business_tasks', count: 1, observed_count: 1, items: [{ key: 'task:a', agent: 'codex', task_id: 'a', text: '接续原会话', role: 'business' }], excluded: [] }
const runningNone = { scope: 'classified_business_tasks', count: 0, observed_count: 0, items: [], excluded: [] }
const segment = (taskId: string, status: RunSegment['status']): RunSegment => ({
  task_id: taskId, status, role: 'business', source: 'kimi', started_at: AT,
})

describe('收起球读 /collab/runs', () => {
  const base = stateWith(runningOne)
  it('接上了:片段说了算(快照 1 件、片段已收场 → 执行 0,不再说正在执行)', () => {
    const view = floatOrbView(base, [segment('a', 'done')])
    expect(view.running).toBe(0)
    expect(view.line).toBe('我在。')
    expect(floatOrbCounts(view)).toBe('执行 0 · 等你 0')
  })
  it('片段说在跑:快照 0 也算 1 件', () => {
    const view = floatOrbView(stateWith(runningNone), [segment('a', 'running')])
    expect(view.running).toBe(1)
    expect(view.line).toBe('正在执行 1 件')
  })
  it("没接上('missing' / undefined)退回快照口径", () => {
    expect(floatOrbView(base, 'missing').running).toBe(1)
    expect(floatOrbView(base, undefined).running).toBe(1)
  })
  it('不传 runFacts(老调用方):行为与未改一致,照旧读快照', () => {
    expect(floatOrbView(base).running).toBe(1)
  })
  it('老服务端没有快照那一格:接不上时不编数', () => {
    const old = stateWith(undefined)
    expect(floatOrbView(old, 'missing').running).toBeUndefined()
    expect(floatOrbView(old, undefined).running).toBeUndefined()
  })
})

describe('在跑数一处定数', () => {
  it('runningCountOf:接上了按片段判(去重),没接上退回快照', () => {
    const facts: CollabRunFacts = [segment('a', 'running'), { ...segment('a', 'running'), session_id: 's2' }, segment('b', 'paused')]
    expect(runningCountOf(facts, 9)).toBe(1)
    expect(runningCountOf('missing', 9)).toBe(9)
    expect(runningCountOf(undefined, 9)).toBe(9)
    expect(runningCountOf(facts, undefined)).toBe(1)
  })
})
