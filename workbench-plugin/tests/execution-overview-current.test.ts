import { describe, expect, it } from 'vitest'
import type { RunSegment, TaskView } from '../src/protocol.ts'
import { executionOverview } from '../src/server/executionState.ts'
import { runningNow } from '../src/running.ts'

function task(id: string, status: TaskView['status'], sourceKind: 'session' | 'manual', state: 'running' | 'unknown'): TaskView {
  return {
    id, title: `事项 ${id}`, status, source: { kind: sourceKind }, created_at: '', updated_at: '',
    links: [{ agent: 'codex', session_id: `source-${id}` }],
    execution_sources: [{ task_id: id, agent: 'codex', session_id: `source-${id}`, state,
      role: sourceKind === 'session' ? 'unclassified' : 'business', role_origin: sourceKind === 'session' ? 'automatic_session' : 'explicit_task',
      ...(state === 'unknown' ? { unknown: 'stale' } : {}), rounds: [] }],
  }
}

/*
 * 「在跑几件」2026-10-29 改口后从任务日志那一本账推(executionOverview 第三个参数,生产由 http.ts
 * 用 runSegmentsOf 接上)。这份单测的世界没有真账,按来源账的同一世界手工给片段:在跑的那件
 * 给一条 running 业务片段,其余给空 —— 两边说的是同一批事实。
 */
const runsOf = (task: TaskView): readonly RunSegment[] => task.id === 'new-business'
  ? [{ task_id: task.id, source: 'codex', status: 'running', role: 'business', started_at: '' }]
  : []

describe('当前可观测的业务执行范围', () => {
  it('历史导入卡的未知来源仍列明，但办完、受阻、待验不永久挡住新业务的确定数量', () => {
    const old = [task('old-done', 'done', 'session', 'unknown'), task('old-blocked', 'blocked', 'session', 'unknown'), task('old-confirm', 'confirm', 'session', 'unknown')]
    const execution = executionOverview([...old, task('new-business', 'doing', 'manual', 'running')], true, runsOf)
    const running = runningNow({ execution, sessions: [], agents: [], stale: false })
    expect(execution.complete).toBe(true)
    expect(execution.observed_running_tasks).toBe(1)
    expect(running).toMatchObject({ count: 1, observed_count: 1, items: [{ task_id: 'new-business' }] })
    expect(running.excluded?.map(item => item.task_id)).toEqual(['old-done', 'old-blocked', 'old-confirm'])
    expect(running.excluded?.every(item => item.sources?.[0]?.unknown === 'stale')).toBe(true)
  })

  it('仍在做或真来源还在跑的未分类卡保持总数未知，卡片done不推断原生会话结束', () => {
    for (const old of [task('active-unknown', 'doing', 'session', 'unknown'), task('premature-done', 'done', 'session', 'running')]) {
      const execution = executionOverview([old, task('new-business', 'doing', 'manual', 'running')], true, runsOf)
      const running = runningNow({ execution, sessions: [], agents: [], stale: false })
      expect(execution.complete).toBe(false)
      expect(running.count).toBeUndefined()
      expect(running.observed_count).toBe(1)
      expect(running.excluded?.[0]).toMatchObject({ task_id: old.id, role: 'unclassified' })
    }
  })
})
