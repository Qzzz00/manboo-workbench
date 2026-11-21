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

  /*
   * 2026-11-21(维护者:「手机端正在办一直 0 事项」):真机上 8 张 11-16~11-19 的旧卡
   * (confirm / done / canceled,回执缺席、Codex 来源的 rollout 早没了)来源永远 unknown,
   * 闸门要求「每张在列的卡来源全部可判定」→ `complete` 永远假 → `running.count` 永远缺席,
   * 手机首页只剩「业务任务总数未知,已观测 0 件」。办完 / 待验的卡执行层面已收尾,
   * 没有「今天的在跑数」可追(真在跑对账会看见 running、不会 unknown),与未分类卡同一条
   * 规矩:不进闸门。受阻的业务卡保持保守(execution-facts-http 钉着:来源失联不猜、不发数)。
   */
  it('办完或待验的业务卡来源不可观测,也不永久挡住新业务的确定数量', () => {
    const parked = [task('biz-done', 'done', 'manual', 'unknown'), task('biz-confirm', 'confirm', 'manual', 'unknown')]
    const execution = executionOverview([...parked, task('new-business', 'doing', 'manual', 'running')], true, runsOf)
    const running = runningNow({ execution, sessions: [], agents: [], stale: false })
    expect(execution.complete).toBe(true)
    expect(running).toMatchObject({ count: 1, observed_count: 1, items: [{ task_id: 'new-business' }] })
  })

  it('受阻的业务卡来源失联时保持保守:总数未知、不发确定数(与钉住的 HTTP 用例同一条)', () => {
    const execution = executionOverview([task('biz-blocked', 'blocked', 'manual', 'unknown'), task('new-business', 'doing', 'manual', 'running')], true, runsOf)
    expect(execution.complete).toBe(false)
    expect(runningNow({ execution, sessions: [], agents: [], stale: false }).count).toBeUndefined()
  })

  it('仍在做的业务卡来源不可观测时总数保持未知(闸门不收窄到在跑的卡)', () => {
    const execution = executionOverview([task('active-biz', 'doing', 'manual', 'unknown'), task('new-business', 'doing', 'manual', 'running')], true, runsOf)
    expect(execution.complete).toBe(false)
    expect(runningNow({ execution, sessions: [], agents: [], stale: false }).count).toBeUndefined()
  })
})
