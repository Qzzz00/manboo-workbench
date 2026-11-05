// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { ProjectsState, TasksState, TaskView, WorkbenchProject } from '../src/protocol.ts'
import {
  assessScheduleRisk,
  createRiskWatcher,
  decorateRisk,
  RISK_WINDOW_DAYS,
} from '../src/server/scheduleRisk.ts'

/** 本地时间 2026-09-09 12:00。风险按本地日切天,不用 UTC——东八区早上八点前 UTC 还是昨天。 */
const NOW_SEC = Math.floor(new Date(2026, 8, 9, 12, 0, 0).getTime() / 1000)
const DAY = 86400

function iso(daysAgo: number): string {
  return new Date((NOW_SEC - daysAgo * DAY) * 1000).toISOString()
}

let seq = 0
function task(over: Partial<TaskView> = {}): TaskView {
  seq += 1
  return {
    id: `t${seq}`, title: `卡 ${seq}`, status: 'todo', source: { kind: 'manual' },
    created_at: iso(30), updated_at: iso(30),
    ...over,
  }
}
/** daysAgo 天前完成的卡。 */
function done(daysAgo: number, over: Partial<TaskView> = {}): TaskView {
  return task({ status: 'done', done_at: iso(daysAgo), updated_at: iso(daysAgo), ...over })
}
function open(n: number, over: Partial<TaskView> = {}): TaskView[] {
  return Array.from({ length: n }, () => task(over))
}
/** 窗口内完成 n 条,均匀铺在最近几天。 */
function doneRecent(n: number): TaskView[] {
  return Array.from({ length: n }, (_, i) => done(1 + (i % 10)))
}

describe('assessScheduleRisk:四档', () => {
  it('宽裕:剩 30 天,按 14 天 7 条(半条/天)的速度,剩 5 条约 10 天做完', () => {
    const risk = assessScheduleRisk({ ddl: '2026-10-09', tasks: [...doneRecent(7), ...open(5)] }, NOW_SEC)
    expect(risk.level).toBe('ample')
    expect(risk.eta).toBe('2026-09-19')
    expect(risk).toMatchObject({ window_days: RISK_WINDOW_DAYS, done_recent: 7, remaining: 5 })
    expect(risk.reason).toContain('剩 5 条')
    expect(risk.reason).toContain('14 天')
  })

  it('紧:剩 10 天,要 10 天——做得完但没有余量', () => {
    const risk = assessScheduleRisk({ ddl: '2026-09-19', tasks: [...doneRecent(7), ...open(5)] }, NOW_SEC)
    expect(risk.level).toBe('tight')
    expect(risk.eta).toBe('2026-09-19')
  })

  it('紧:比例上够(4/5 天),但余量不足两天也算紧', () => {
    const risk = assessScheduleRisk({ ddl: '2026-09-14', tasks: [...doneRecent(14), ...open(4)] }, NOW_SEC)
    expect(risk.level).toBe('tight')
    expect(risk.eta).toBe('2026-09-13')
  })

  it('赶不上:剩 5 天,按当前速度要 10 天', () => {
    const risk = assessScheduleRisk({ ddl: '2026-09-14', tasks: [...doneRecent(7), ...open(5)] }, NOW_SEC)
    expect(risk.level).toBe('late')
    expect(risk.eta).toBe('2026-09-19')
    expect(risk.reason).toContain('截止只剩 5 天')
  })

  it('赶不上:截止日已过而活还没干完——不管速度多少', () => {
    const risk = assessScheduleRisk({ ddl: '2026-09-01', tasks: [...doneRecent(7), ...open(1)] }, NOW_SEC)
    expect(risk.level).toBe('late')
    expect(risk.reason).toContain('截止已过 8 天')
  })

  it('赶不上:任务卡建了很久,最近 14 天一条都没完成,速度为零', () => {
    const risk = assessScheduleRisk({ ddl: '2026-10-09', tasks: [done(20), ...open(3)] }, NOW_SEC)
    expect(risk.level).toBe('late')
    expect(risk.eta).toBeUndefined()
    expect(risk.reason).toContain('一条都没完成')
    expect(risk).toMatchObject({ done_recent: 0, remaining: 3 })
  })

  it('无法判断:没有截止日', () => {
    const risk = assessScheduleRisk({ tasks: [...doneRecent(3), ...open(2)] }, NOW_SEC)
    expect(risk.level).toBe('unknown')
    expect(risk.eta).toBeUndefined()
    expect(risk.reason).toBe('没有截止日')
  })

  it('无法判断:截止日格式坏了——不把坏日期当今天(D13)', () => {
    const risk = assessScheduleRisk({ ddl: '九月底', tasks: [...doneRecent(3), ...open(2)] }, NOW_SEC)
    expect(risk.level).toBe('unknown')
    expect(risk.reason).toContain('格式')
  })

  it('无法判断:没有任务卡——只把仓库提交活跃度说出来,不据此编预计日', () => {
    const risk = assessScheduleRisk({ ddl: '2026-10-09', tasks: [], repo: { idle_days: 3, recent_commits: 12 } }, NOW_SEC)
    expect(risk.level).toBe('unknown')
    expect(risk.eta).toBeUndefined()
    expect(risk.done_recent).toBeUndefined()
    expect(risk.remaining).toBeUndefined()
    expect(risk.reason).toContain('没有任务卡')
    expect(risk.reason).toContain('12 次提交')
    expect(risk.reason).toContain('停 3 天')
  })

  it('无法判断:没有任务卡也没有仓库信号——原因里不出现任何数字', () => {
    const risk = assessScheduleRisk({ ddl: '2026-10-09', tasks: [] }, NOW_SEC)
    expect(risk.level).toBe('unknown')
    expect(risk.reason).toBe('没有任务卡,算不出速度')
  })

  it('无法判断:任务卡都是窗口内刚建的、一条没完成——还看不出速度,不算零速', () => {
    const fresh = open(3, { created_at: iso(2), updated_at: iso(2) })
    const risk = assessScheduleRisk({ ddl: '2026-10-09', tasks: fresh }, NOW_SEC)
    expect(risk.level).toBe('unknown')
    expect(risk.reason).toContain('还看不出速度')
  })

  it('没有任务卡但截止日已过:这是事实,不是判断——赶不上', () => {
    const risk = assessScheduleRisk({ ddl: '2026-09-01', tasks: [] }, NOW_SEC)
    expect(risk.level).toBe('late')
  })
})

describe('assessScheduleRisk:速度口径', () => {
  it('全部完成:宽裕,预计完成日 = 最后一条完成的那天', () => {
    const risk = assessScheduleRisk({ ddl: '2026-09-14', tasks: [done(5), done(2)] }, NOW_SEC)
    expect(risk.level).toBe('ample')
    expect(risk.eta).toBe('2026-09-07')
    expect(risk.reason).toContain('全部完成')
  })

  it('取消的卡不进分子也不进分母', () => {
    const tasks = [...doneRecent(7), ...open(5), ...open(4, { status: 'canceled' })]
    expect(assessScheduleRisk({ ddl: '2026-10-09', tasks }, NOW_SEC)).toMatchObject({ done_recent: 7, remaining: 5 })
  })

  it('窗口外完成的不算速度', () => {
    const tasks = [...doneRecent(7), done(15), done(40), ...open(5)]
    expect(assessScheduleRisk({ ddl: '2026-10-09', tasks }, NOW_SEC)).toMatchObject({ done_recent: 7 })
  })

  it('老卡没有 done_at 时退回 updated_at', () => {
    const legacy = Array.from({ length: 7 }, () => task({ status: 'done', updated_at: iso(3) }))
    expect(assessScheduleRisk({ ddl: '2026-10-09', tasks: [...legacy, ...open(5)] }, NOW_SEC)).toMatchObject({ done_recent: 7 })
  })

  it('backlog / blocked / confirm / doing 都算「还没完成」', () => {
    const tasks = [
      ...doneRecent(7),
      task({ status: 'backlog' }), task({ status: 'blocked' }), task({ status: 'confirm' }), task({ status: 'doing' }),
    ]
    expect(assessScheduleRisk({ ddl: '2026-10-09', tasks }, NOW_SEC)).toMatchObject({ remaining: 4 })
  })
})

function project(over: Partial<WorkbenchProject> = {}): WorkbenchProject {
  return { id: 'p1', name: 'Aiboo', stage: 'MVP 开发', links: [], session_count: 0, idle: false, ...over }
}

function projectsState(projects: WorkbenchProject[]): ProjectsState {
  return { projects, pending: [], scan_errors: [], scanned_at: iso(0) }
}

function tasksState(over: Partial<TasksState> = {}): TasksState {
  return { tasks: [], sprints: [], modules: [], project_meta: [], ...over }
}

describe('decorateRisk:项目行与冲刺各挂一份', () => {
  it('项目行:截止日取 DDL,任务取 project_id 归它的卡', () => {
    const tasks = [
      ...doneRecent(7).map(t => ({ ...t, project_id: 'p1' })),
      ...open(5, { project_id: 'p1' }),
      ...open(9, { project_id: 'p2' }),
    ]
    const { projects } = decorateRisk(
      projectsState([project({ ddl: { date: '2026-10-09', title: '上线' } }), project({ id: 'p2', name: '别的' })]),
      tasksState({ tasks }),
      NOW_SEC,
    )
    expect(projects.projects[0]?.risk).toMatchObject({ level: 'ample', eta: '2026-09-19', remaining: 5 })
    expect(projects.projects[1]?.risk).toMatchObject({ level: 'unknown', reason: '没有截止日' })
  })

  it('项目行:没有任务卡时把仓库的提交活跃度带进原因', () => {
    const { projects } = decorateRisk(
      projectsState([project({
        ddl: { date: '2026-10-09', title: '上线' },
        signals: { branch: 'main', dirty_count: 0, worktrees: 0, cleanup_count: 0, idle_days: 2, recent_commits: 9 },
      })]),
      tasksState(),
      NOW_SEC,
    )
    expect(projects.projects[0]?.risk?.level).toBe('unknown')
    expect(projects.projects[0]?.risk?.reason).toContain('9 次提交')
  })

  it('冲刺:截止日取 ends_at,任务取本冲刺各模块下属于本项目的卡', () => {
    const tasks = [
      ...doneRecent(7).map(t => ({ ...t, project_id: 'p1', module_id: 'm1' })),
      ...open(5, { project_id: 'p1', module_id: 'm1' }),
      ...open(9, { project_id: 'p1', module_id: 'm2' }),
    ]
    const { tasks: decorated } = decorateRisk(
      projectsState([project()]),
      tasksState({
        tasks,
        sprints: [
          { id: 's1', project_id: 'p1', name: '冲刺一', versions: [], ends_at: '2026-09-14', created_at: iso(20), updated_at: iso(20) },
          { id: 's2', project_id: 'p1', name: '冲刺二', versions: [], created_at: iso(20), updated_at: iso(20) },
        ],
        modules: [
          { id: 'm1', sprint_id: 's1', name: '播放', created_at: iso(20), updated_at: iso(20) },
          { id: 'm2', sprint_id: 's2', name: '搜索', created_at: iso(20), updated_at: iso(20) },
        ],
      }),
      NOW_SEC,
    )
    expect(decorated.sprints[0]?.risk).toMatchObject({ level: 'late', remaining: 5, eta: '2026-09-19' })
    expect(decorated.sprints[1]?.risk).toMatchObject({ level: 'unknown', reason: '没有截止日' })
    // 卡本身一张不动。
    expect(decorated.tasks).toBe(tasks)
  })
})

describe('createRiskWatcher:变成「赶不上」时产出一条事件', () => {
  const late = (id = 'p1', name = 'Aiboo') => project({
    id, name, ddl: { date: '2026-09-14', title: '上线' },
    risk: { level: 'late', eta: '2026-09-19', reason: '按最近 14 天 7 条的速度要 10 天,截止只剩 5 天', window_days: 14 },
  })
  const tight = (id = 'p1', name = 'Aiboo') => project({
    id, name, ddl: { date: '2026-09-14', title: '上线' },
    risk: { level: 'tight', eta: '2026-09-13', reason: '…', window_days: 14 },
  })

  it('第一次看到就是赶不上:只建基线,不报——重启一次报一次会很吵', () => {
    const watcher = createRiskWatcher(() => NOW_SEC)
    expect(watcher.observe([late()])).toEqual([])
    expect(watcher.observe([late()])).toEqual([])
  })

  it('从紧变成赶不上:一条 waiting + idle_prompt 事件,不走响铃那条(不是审批)', () => {
    const watcher = createRiskWatcher(() => NOW_SEC)
    watcher.observe([tight()])
    const events = watcher.observe([late()])
    expect(events).toEqual([{
      agent: 'dsh',
      session_id: 'schedule:p1',
      project: 'Aiboo',
      type: 'waiting',
      reason: 'idle_prompt',
      title: 'Aiboo 排期:赶不上 9-14',
      summary: '按当前速度预计 9-19 才能做完。按最近 14 天 7 条的速度要 10 天,截止只剩 5 天',
      ts: NOW_SEC,
    }])
    // 还是赶不上:不重复报。
    expect(watcher.observe([late()])).toEqual([])
  })

  it('从赶不上回到紧:收掉那条会话(offline),黄点不该还挂着', () => {
    const watcher = createRiskWatcher(() => NOW_SEC)
    watcher.observe([tight()])
    watcher.observe([late()])
    expect(watcher.observe([tight()])).toEqual([{
      agent: 'dsh', session_id: 'schedule:p1', type: 'offline', reason: 'offline', ts: NOW_SEC,
    }])
  })

  it('项目从快照里消失:视同不再赶不上,收掉会话', () => {
    const watcher = createRiskWatcher(() => NOW_SEC)
    watcher.observe([tight()])
    watcher.observe([late()])
    expect(watcher.observe([])).toMatchObject([{ session_id: 'schedule:p1', type: 'offline' }])
  })

  it('没有 risk 字段(没接任务板)的项目不参与', () => {
    const watcher = createRiskWatcher(() => NOW_SEC)
    watcher.observe([project()])
    expect(watcher.observe([project()])).toEqual([])
  })
})
