import { describe, expect, it } from 'vitest'
import { butlerConclusions } from '../src/client/butler.ts'
import { RING_AFTER_SEC } from '../src/protocol.ts'
import type { SessionView, WorkbenchProject, WorkbenchState } from '../src/protocol.ts'

const NOW = Math.floor(Date.parse('2026-08-21T09:00:00+08:00') / 1000)

function baseState(over: Partial<WorkbenchState> = {}): WorkbenchState {
  return {
    agents: [],
    sessions: [],
    quota: {},
    now: '2026-08-21T09:00:00+08:00',
    stale: false,
    ...over,
  }
}

function project(over: Partial<WorkbenchProject> = {}): WorkbenchProject {
  return {
    id: 'aiboo', name: 'Aiboo', stage: 'MVP 开发', links: [], session_count: 0, idle: false,
    ...over,
  }
}

function session(over: Partial<SessionView> = {}): SessionView {
  return {
    agent: 'dsh', session_id: 's1', project: 'Aiboo', status: 'waiting', elapsed_sec: 0, unread: false,
    updated_at: '2026-08-21T09:00:00.000Z',
    ...over,
  }
}

describe('butlerConclusions(spec D11 跨区结论)', () => {
  it('空态：什么都没命中 → []', () => {
    expect(butlerConclusions(baseState(), NOW)).toEqual([])
  })

  it('规则①：DDL 明天交付且已停 >=3 天 → "<名> 明天交付，但已停 N 天"', () => {
    const state = baseState({
      projects: {
        projects: [project({
          ddl: { date: '2026-08-22', title: '上线' },
          signals: { branch: 'main', dirty_count: 0, worktrees: 1, cleanup_count: 0, idle_days: 5 },
        })],
        pending: [], scan_errors: [], scanned_at: '2026-08-21T00:00:00.000Z',
      },
    })
    expect(butlerConclusions(state, NOW)).toEqual(['Aiboo 明天交付，但已停 5 天'])
  })

  it('规则①：daysLeft<=0（今天或已过期）→ 文案用"今天"', () => {
    const state = baseState({
      projects: {
        projects: [project({
          ddl: { date: '2026-08-21', title: '上线' },
          signals: { branch: 'main', dirty_count: 0, worktrees: 1, cleanup_count: 0, idle_days: 3 },
        })],
        pending: [], scan_errors: [], scanned_at: '2026-08-21T00:00:00.000Z',
      },
    })
    expect(butlerConclusions(state, NOW)).toEqual(['Aiboo 今天交付，但已停 3 天'])
  })

  it('规则①：DDL 迫近但 idle_days < 3（一直在动）→ 不命中', () => {
    const state = baseState({
      projects: {
        projects: [project({
          ddl: { date: '2026-08-22', title: '上线' },
          signals: { branch: 'main', dirty_count: 0, worktrees: 1, cleanup_count: 0, idle_days: 1 },
        })],
        pending: [], scan_errors: [], scanned_at: '2026-08-21T00:00:00.000Z',
      },
    })
    expect(butlerConclusions(state, NOW)).toEqual([])
  })

  it('规则②：waiting 会话 elapsed_sec >= RING_AFTER_SEC → "<Agent> 等你 N 分了"', () => {
    const state = baseState({
      sessions: [session({ agent: 'claude', status: 'waiting', elapsed_sec: RING_AFTER_SEC + 60 })],
    })
    expect(butlerConclusions(state, NOW)).toEqual(['Claude 等你 4 分了'])
  })

  it('规则②：elapsed_sec 刚好等于阈值也命中（>=，不是 >）', () => {
    const state = baseState({
      sessions: [session({ agent: 'codex', status: 'waiting', elapsed_sec: RING_AFTER_SEC })],
    })
    expect(butlerConclusions(state, NOW)).toEqual([`Codex 等你 ${Math.floor(RING_AFTER_SEC / 60)} 分了`])
  })

  it('规则②：running 会话不算，即便 elapsed_sec 很长', () => {
    const state = baseState({
      sessions: [session({ agent: 'codex', status: 'running', elapsed_sec: RING_AFTER_SEC + 999 })],
    })
    expect(butlerConclusions(state, NOW)).toEqual([])
  })

  it('规则③：disk_pct >= 95 → "磁盘只剩 N G"', () => {
    const state = baseState({
      machine: { disk_pct: 97, disk_free_gb: 3.2, mem_gb: 16, cpu_idle_pct: 50, sampled_at: '2026-08-21T00:00:00.000Z' },
    })
    expect(butlerConclusions(state, NOW)).toEqual(['磁盘只剩 3 G'])
  })

  it('规则③：machine 为 { error } 时不命中，不假装知道磁盘余量', () => {
    const state = baseState({ machine: { error: 'df 失败' } })
    expect(butlerConclusions(state, NOW)).toEqual([])
  })

  it('优先级：三条同时命中时按 ①②③ 顺序排列，首条是主文案', () => {
    const state = baseState({
      projects: {
        projects: [project({
          ddl: { date: '2026-08-21', title: '上线' },
          signals: { branch: 'main', dirty_count: 0, worktrees: 1, cleanup_count: 0, idle_days: 4 },
        })],
        pending: [], scan_errors: [], scanned_at: '2026-08-21T00:00:00.000Z',
      },
      sessions: [session({ agent: 'kimi', status: 'waiting', elapsed_sec: RING_AFTER_SEC + 120 })],
      machine: { disk_pct: 99, disk_free_gb: 1, mem_gb: 16, cpu_idle_pct: 10, sampled_at: '2026-08-21T00:00:00.000Z' },
    })
    const result = butlerConclusions(state, NOW)
    expect(result).toHaveLength(3)
    expect(result[0]).toBe('Aiboo 今天交付，但已停 4 天')
    expect(result[1]).toBe('Kimi 等你 5 分了')
    expect(result[2]).toBe('磁盘只剩 1 G')
  })
})

describe('butlerConclusions:排期风险(2026-09-09)', () => {
  const risky = (over: Partial<NonNullable<WorkbenchProject['risk']>> = {}) => project({
    ddl: { date: '2026-08-28', title: '上线' },
    risk: {
      level: 'late', eta: '2026-09-05', window_days: 14, done_recent: 3, remaining: 9,
      reason: '按最近 14 天 3 条的速度,剩 9 条约 42 天做完,截止只剩 7 天',
      ...over,
    },
  })
  const withProjects = (projects: WorkbenchProject[]) => baseState({
    projects: { projects, pending: [], scan_errors: [], scanned_at: '2026-08-21T00:00:00.000Z' },
  })

  it('赶不上 → 说一句「按当前速度赶不上」,带截止日与预计完成日', () => {
    expect(butlerConclusions(withProjects([risky()]), NOW))
      .toEqual(['Aiboo 按当前速度赶不上 8-28,预计 9-5 才做完'])
  })

  it('算不出预计完成日(速度为零)时只说赶不上,不编一个日期', () => {
    const noEta = risky()
    delete noEta.risk?.eta
    const state = withProjects([{ ...noEta, risk: { ...noEta.risk!, reason: '最近 14 天一条都没完成' } }])
    expect(butlerConclusions(state, NOW)).toEqual(['Aiboo 按当前速度赶不上 8-28'])
  })

  it('宽裕/紧/无法判断都不说话——事务官只在要出事的时候开口', () => {
    for (const level of ['ample', 'tight', 'unknown'] as const) {
      expect(butlerConclusions(withProjects([risky({ level })]), NOW)).toEqual([])
    }
  })

  it('排期那条会话不会被说成「DSH 等你 N 分了」——它不是在等人回话', () => {
    const state = baseState({
      sessions: [session({ agent: 'dsh', session_id: 'schedule:aiboo', status: 'waiting', elapsed_sec: RING_AFTER_SEC + 600 })],
    })
    expect(butlerConclusions(state, NOW)).toEqual([])
  })
})
