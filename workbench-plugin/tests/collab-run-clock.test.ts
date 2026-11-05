// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { runSegmentsOf } from '../src/server/collabRoutes.ts'
import type { JobEvent, JobStep } from '../src/server/jobLog.ts'

// 纯投影输入 fixture,不作为自然执行或模型完成证据。
const at = (minute: number) => `2026-10-24T01:${String(minute).padStart(2, '0')}:00.000Z`
const now = Date.parse(at(40))
const event = (step: JobStep, minute: number): JobEvent => ({ job: 'clock-task', family: 'codex', step, at: at(minute) })
const segment = (events: JobEvent[], clock = now) => runSegmentsOf('clock-task', events, clock)[0]!

describe('原E执行源观察时刻独立于assigned与管线收场', () => {
  it('最早started作为开工观察,心跳不改写;replied作为完成观察', () => {
    const run = segment([event('assigned', 0), event('sent', 1), event('started', 3), event('started', 7), event('replied', 10)])
    expect(run).toMatchObject({ started_at: at(0), finished_at: at(10), execution_started_observed_at: at(3), execution_finished_observed_at: at(10) })
  })
  it.each(['sent', 'seen', 'waiting', 'done', 'timeout', 'unreadable', 'not_sent'] as const)('%s不冒开工或真实完成观察', step => {
    const run = segment([event('assigned', 0), event(step, 2)])
    expect(run).not.toHaveProperty('execution_started_observed_at')
    expect(run).not.toHaveProperty('execution_finished_observed_at')
  })
  it('只有replied时完成观察可得,开工时刻仍缺席,不拼假区间', () => {
    const run = segment([event('assigned', 0), event('replied', 8)])
    expect(run).not.toHaveProperty('execution_started_observed_at')
    expect(run).toHaveProperty('execution_finished_observed_at', at(8))
  })
  it('失联保留曾核到开工的历史时刻,完成未知', () => {
    const run = segment([event('assigned', 0), event('started', 1)], Date.parse(at(30)))
    expect(run.status).toBe('unknown')
    expect(run).toHaveProperty('execution_started_observed_at', at(1))
    expect(run).not.toHaveProperty('execution_finished_observed_at')
  })
  it('重派不挪用旧段时刻,收场后的散事件也不补旧段开工', () => {
    const runs = runSegmentsOf('clock-task', [event('assigned', 0), event('timeout', 2), event('started', 3), event('replied', 4), event('assigned', 5), event('sent', 6)], now)
    expect(runs).toHaveLength(2)
    for (const run of runs) {
      expect(run).not.toHaveProperty('execution_started_observed_at')
      expect(run).not.toHaveProperty('execution_finished_observed_at')
    }
  })
  it('同一事项的两条来源分别成段，一条交回不结束另一条', () => {
    const runs = runSegmentsOf('clock-task', [
      { ...event('started', 39), agent: 'codex', session_id: 's-1', source_round: 'r-1', source_event_id: 'e-1' },
      { ...event('started', 39), agent: 'codex', session_id: 's-2', source_round: 'r-1', source_event_id: 'e-2' },
      { ...event('replied', 39), agent: 'codex', session_id: 's-1', source_round: 'r-1', source_event_id: 'e-3' },
    ], now)
    expect(runs).toHaveLength(2)
    expect(runs.find(one => one.session_id === 's-1')?.status).toBe('done')
    expect(runs.find(one => one.session_id === 's-2')?.status).toBe('running')
  })
  it('来源被拒后该来源显示未知，不沿用上次仍在运行的快照', () => {
    const runs = runSegmentsOf('clock-task', [
      { ...event('started', 39), agent: 'codex', session_id: 's-1', source_round: 'r-1', source_event_id: 'e-1' },
      { ...event('source_unknown', 40), agent: 'codex', session_id: 's-1', source_round: 'r-1', source_event_id: 'unknown:denied' },
    ], now)
    expect(runs[0]?.status).toBe('unknown')
  })
  it('无assigned不编段;非法或未来事件不提供确认时刻', () => {
    expect(runSegmentsOf('clock-task', [event('started', 2)], now)).toEqual([])
    for (const started of [{ ...event('started', 1), at: 'invalid' }, event('started', 50)]) {
      expect(segment([event('assigned', 0), started])).not.toHaveProperty('execution_started_observed_at')
    }
    expect(segment([event('assigned', 0), event('replied', 50)])).not.toHaveProperty('execution_finished_observed_at')
  })
})
