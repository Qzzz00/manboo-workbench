import { describe, expect, it } from 'vitest'
import { buildProjectRows } from '../src/client/portfolio.ts'
import type { PendingGroup, ProjectsState, WorkbenchProject } from '../src/protocol.ts'

// 固定在当天正午 UTC,给 monthDay/daysLeft 的本地日历日计算留足偏移余量
// (UTC-11 ~ UTC+12 都不会跨天),测试结果不随跑测机器时区抖动。
const NOW_ISO = '2026-08-20T12:00:00.000Z'
const NOW_SEC = Date.parse(NOW_ISO) / 1000

function project(overrides: Partial<WorkbenchProject> & Pick<WorkbenchProject, 'id' | 'name'>): WorkbenchProject {
  return {
    stage: 'MVP 开发',
    links: [],
    session_count: 0,
    idle: false,
    ...overrides,
  }
}

function projectsState(overrides: Partial<ProjectsState> = {}): ProjectsState {
  return {
    projects: [],
    pending: [],
    scan_errors: [],
    scanned_at: NOW_ISO,
    ...overrides,
  }
}

describe('buildProjectRows：projects 未接入', () => {
  it('projects 为 undefined 时不编数字,只报未接入', () => {
    const view = buildProjectRows(undefined, NOW_SEC)

    expect(view.rows).toEqual([])
    expect(view.scanErrorTexts).toEqual(['项目区未接入:服务未返回 projects'])
    expect(view.pendingText).toBe('0 组 / 0 条')
    expect(view.idleText).toBe('')
  })
})

describe('buildProjectRows：activityText / tone（「算」行,spec D3）', () => {
  it('idle_days=0 → 今天在动 / hot', () => {
    const view = buildProjectRows(projectsState({
      projects: [project({
        id: 'aiboo', name: 'Aiboo',
        signals: { branch: 'main', dirty_count: 0, worktrees: 1, cleanup_count: 0, idle_days: 0 },
      })],
    }), NOW_SEC)

    expect(view.rows[0]).toMatchObject({ activityText: '今天在动', tone: 'hot' })
  })

  it('idle_days 1-9 → 停 N 天 / normal', () => {
    const view = buildProjectRows(projectsState({
      projects: [project({
        id: 'aiboo', name: 'Aiboo',
        signals: { branch: 'main', dirty_count: 0, worktrees: 1, cleanup_count: 0, idle_days: 5 },
      })],
    }), NOW_SEC)

    expect(view.rows[0]).toMatchObject({ activityText: '停 5 天', tone: 'normal' })
  })

  it('idle_days>=10 且状态过期 → 停 N 天 / warn', () => {
    const view = buildProjectRows(projectsState({
      projects: [project({
        id: 'aiboo', name: 'Aiboo',
        signals: { branch: 'main', dirty_count: 0, worktrees: 1, cleanup_count: 0, idle_days: 12 },
        status: { text: '旧状态', review: 'confirmed', author: '你', updated_at: NOW_ISO, stale: true },
      })],
    }), NOW_SEC)

    expect(view.rows[0]).toMatchObject({ activityText: '停 12 天', tone: 'warn' })
  })

  it('idle_days>=10 且从没写过状态 → 也是 warn（没人确认过）', () => {
    const view = buildProjectRows(projectsState({
      projects: [project({
        id: 'aiboo', name: 'Aiboo',
        signals: { branch: 'main', dirty_count: 0, worktrees: 1, cleanup_count: 0, idle_days: 30 },
      })],
    }), NOW_SEC)

    expect(view.rows[0]).toMatchObject({ activityText: '停 30 天', tone: 'warn' })
  })

  it('idle_days>=10 但状态没过期 → normal，不是所有久停项目都告警', () => {
    const view = buildProjectRows(projectsState({
      projects: [project({
        id: 'aiboo', name: 'Aiboo',
        signals: { branch: 'main', dirty_count: 0, worktrees: 1, cleanup_count: 0, idle_days: 20 },
        status: { text: '长期归档,按计划闲置', review: 'confirmed', author: '你', updated_at: NOW_ISO, stale: false },
      })],
    }), NOW_SEC)

    expect(view.rows[0]).toMatchObject({ activityText: '停 20 天', tone: 'normal' })
  })

  it('无 signals 且有 session_count → 无仓库 / cold', () => {
    const view = buildProjectRows(projectsState({
      projects: [project({ id: 'market', name: '市场调研', session_count: 3 })],
    }), NOW_SEC)

    expect(view.rows[0]).toMatchObject({ activityText: '无仓库', tone: 'cold' })
  })
})

describe('buildProjectRows：signalText 组装', () => {
  it('branch · N 未提交 · N worktree，有可清理再加括号', () => {
    const view = buildProjectRows(projectsState({
      projects: [project({
        id: 'aiboo', name: 'Aiboo',
        signals: { branch: 'main', dirty_count: 10, worktrees: 1, cleanup_count: 4, idle_days: 5 },
      })],
    }), NOW_SEC)

    expect(view.rows[0]?.signalText).toBe('main · 10 未提交 · 1 worktree(另 4 个 claude/* 可清理)')
    expect(view.rows[0]?.signalError).toBe(false)
  })

  it('cleanup_count 为 0 时不加括号', () => {
    const view = buildProjectRows(projectsState({
      projects: [project({
        id: 'aiboo', name: 'Aiboo',
        signals: { branch: 'main', dirty_count: 0, worktrees: 1, cleanup_count: 0, idle_days: 5 },
      })],
    }), NOW_SEC)

    expect(view.rows[0]?.signalText).toBe('main · 0 未提交 · 1 worktree')
  })

  it('signal_error 时输出「未接入:原因」，不显示 0（spec D13）', () => {
    const view = buildProjectRows(projectsState({
      projects: [project({ id: 'echo', name: 'Echo', session_count: 1, signal_error: 'git 未安装' })],
    }), NOW_SEC)

    expect(view.rows[0]?.signalText).toBe('未接入:git 未安装')
    // spec D13：未接入必须醒目——ProjectZone 靠这个布尔给算行加告警样式，
    // 不能让「未接入」跟正常的算行文案同色同款混在一起。
    expect(view.rows[0]?.signalError).toBe(true)
  })
})

describe('buildProjectRows：状态元数据', () => {
  it('statusMeta 取 author · 月-日', () => {
    const view = buildProjectRows(projectsState({
      projects: [project({
        id: 'aiboo', name: 'Aiboo',
        status: { text: '正在做条漫演出', review: 'confirmed', author: '你', updated_at: '2026-08-18T12:00:00.000Z', stale: false },
      })],
    }), NOW_SEC)

    expect(view.rows[0]?.statusText).toBe('正在做条漫演出')
    expect(view.rows[0]?.statusMeta).toBe('你 · 8-18')
    expect(view.rows[0]?.statusStale).toBe(false)
  })

  it('review=suggested 时 statusMeta 加「(AI 拟,待确认)」', () => {
    const view = buildProjectRows(projectsState({
      projects: [project({
        id: 'aiboo', name: 'Aiboo',
        status: { text: 'AI 拟的状态', review: 'suggested', author: '你', updated_at: '2026-08-18T12:00:00.000Z', stale: false },
      })],
    }), NOW_SEC)

    expect(view.rows[0]?.statusMeta).toBe('你 · 8-18(AI 拟,待确认)')
  })

  it('没有 status 时 statusText/statusMeta 缺省，statusStale 为 false', () => {
    const view = buildProjectRows(projectsState({
      projects: [project({ id: 'aiboo', name: 'Aiboo' })],
    }), NOW_SEC)

    expect(view.rows[0]?.statusText).toBeUndefined()
    expect(view.rows[0]?.statusMeta).toBeUndefined()
    expect(view.rows[0]?.statusStale).toBe(false)
  })
})

describe('buildProjectRows：ddlText', () => {
  it('未来 DDL：M-D 标题(剩 N 天)', () => {
    const view = buildProjectRows(projectsState({
      projects: [project({ id: 'aiboo', name: 'Aiboo', ddl: { date: '2026-08-25', title: '上线' } })],
    }), NOW_SEC)

    expect(view.rows[0]?.ddlText).toBe('8-25 上线(剩 5 天)')
  })

  it('过期 DDL：已过 M-D', () => {
    const view = buildProjectRows(projectsState({
      projects: [project({ id: 'aiboo', name: 'Aiboo', ddl: { date: '2026-08-15', title: '上线' } })],
    }), NOW_SEC)

    expect(view.rows[0]?.ddlText).toBe('已过 8-15')
  })

  it('剩 <=1 天要加"——今天要动"', () => {
    const view = buildProjectRows(projectsState({
      projects: [project({ id: 'aiboo', name: 'Aiboo', ddl: { date: '2026-08-21', title: '评审' } })],
    }), NOW_SEC)

    expect(view.rows[0]?.ddlText).toBe('8-21 评审(剩 1 天)——今天要动')
  })

  it('没有 ddl 时 ddlText 缺省', () => {
    const view = buildProjectRows(projectsState({
      projects: [project({ id: 'aiboo', name: 'Aiboo' })],
    }), NOW_SEC)

    expect(view.rows[0]?.ddlText).toBeUndefined()
  })

  // daysLeftFromNow(dates.ts) 解析失败统一回 +Infinity——回归前 portfolio 这里本地
  // 拷贝的算法回的是 0，会把一条格式坏掉的 DDL 日期渲染成"剩 0 天"，跟真正今天到期
  // 长得一模一样，是比不显示更危险的误报。收拢到单一实现后必须确认这里不再是那样。
  it('DDL 日期解析失败 → 不显示"剩 N 天"，也不是 NaN，只如实标注格式有误', () => {
    const view = buildProjectRows(projectsState({
      projects: [project({ id: 'aiboo', name: 'Aiboo', ddl: { date: 'not-a-date', title: '上线' } })],
    }), NOW_SEC)

    expect(view.rows[0]?.ddlText).toBe('not-a-date 上线(日期格式有误)')
    expect(view.rows[0]?.ddlText).not.toMatch(/剩|NaN|Infinity/)
  })
})

describe('buildProjectRows：fragmentsText', () => {
  it('links 为空是空字符串，有内容报条数', () => {
    const view = buildProjectRows(projectsState({
      projects: [
        project({ id: 'a', name: 'A' }),
        project({ id: 'b', name: 'B', links: ['x', 'y', 'z'] }),
      ],
    }), NOW_SEC)

    expect(view.rows.find(r => r.id === 'a')?.fragmentsText).toBe('')
    expect(view.rows.find(r => r.id === 'b')?.fragmentsText).toBe('3 条零散记录')
  })
})

describe('buildProjectRows：排序', () => {
  it('今天在动 → 停少 → 停多 → 无仓库信号排最后', () => {
    const view = buildProjectRows(projectsState({
      projects: [
        project({ id: 'stale', name: 'Stale', signals: { branch: 'main', dirty_count: 0, worktrees: 1, cleanup_count: 0, idle_days: 15 } }),
        project({ id: 'nosig', name: 'NoSig', session_count: 1 }),
        project({ id: 'hot', name: 'Hot', signals: { branch: 'main', dirty_count: 0, worktrees: 1, cleanup_count: 0, idle_days: 0 } }),
        project({ id: 'mid', name: 'Mid', signals: { branch: 'main', dirty_count: 0, worktrees: 1, cleanup_count: 0, idle_days: 3 } }),
      ],
    }), NOW_SEC)

    expect(view.rows.map(row => row.id)).toEqual(['hot', 'mid', 'stale', 'nosig'])
  })
})

describe('buildProjectRows：idleText（闲置线,spec §3）', () => {
  it('按天数降序合并成一行,用 · 连接', () => {
    const view = buildProjectRows(projectsState({
      projects: [
        project({
          id: 'a', name: 'DouDou', idle: true,
          signals: { branch: 'main', dirty_count: 0, worktrees: 1, cleanup_count: 0, idle_days: 9 },
        }),
        project({
          id: 'b', name: '电子徽章', idle: true,
          signals: { branch: 'main', dirty_count: 0, worktrees: 1, cleanup_count: 0, idle_days: 14 },
        }),
        // 未标 idle 的不进闲置线，即使停了很久
        project({
          id: 'c', name: 'Echo',
          signals: { branch: 'main', dirty_count: 0, worktrees: 1, cleanup_count: 0, idle_days: 30 },
        }),
      ],
    }), NOW_SEC)

    expect(view.idleText).toBe('闲置 电子徽章 14 天 · 闲置 DouDou 9 天')
  })
})

describe('buildProjectRows：idle 项目从主列表折叠排除（PRD §5.3）', () => {
  it('idle:true 的项目不进 rows，只合并进 idleText 那一行', () => {
    const view = buildProjectRows(projectsState({
      projects: [
        project({
          id: 'a', name: 'DouDou', idle: true,
          signals: { branch: 'main', dirty_count: 0, worktrees: 1, cleanup_count: 0, idle_days: 9 },
        }),
        project({
          id: 'b', name: 'Aiboo',
          signals: { branch: 'main', dirty_count: 0, worktrees: 1, cleanup_count: 0, idle_days: 0 },
        }),
      ],
    }), NOW_SEC)

    expect(view.rows.map(row => row.id)).toEqual(['b'])
    expect(view.idleText).toBe('闲置 DouDou 9 天')
  })
})

describe('buildProjectRows：pendingText / scanErrorTexts', () => {
  it('pendingText 是「N 组 / M 条」', () => {
    const pending: PendingGroup[] = [
      { dir: '~/multica_workspaces/x', count: 143 },
      { dir: '~/Documents/Codex/a', count: 40 },
      { dir: '~/Documents/Codex/b', count: 38 },
      { dir: '~/Documents/other/c', count: 90 },
      { dir: '~/Documents/other/d', count: 60 },
      { dir: '~/Documents/other/e', count: 13 },
    ]
    const view = buildProjectRows(projectsState({ pending }), NOW_SEC)

    expect(view.pendingText).toBe('6 组 / 384 条')
  })

  it('scanErrorTexts 逐条报「root 未接入:reason」', () => {
    const view = buildProjectRows(projectsState({
      scan_errors: [{ root: '~/Documents/Codex', reason: '权限不足' }],
    }), NOW_SEC)

    expect(view.scanErrorTexts).toEqual(['~/Documents/Codex 未接入:权限不足'])
  })
})

describe('buildProjectRows：排期风险(2026-09-09)', () => {
  const risk = (over: Partial<NonNullable<WorkbenchProject['risk']>> = {}) => ({
    level: 'ample' as const, reason: '按最近 14 天 7 条的速度,剩 5 条约 10 天做完,截止前还余 20 天',
    window_days: 14, done_recent: 7, remaining: 5, eta: '2026-08-30',
    ...over,
  })

  it('宽裕：等级中文名 + 预计完成日,依据进 title', () => {
    const view = buildProjectRows(projectsState({
      projects: [project({ id: 'aiboo', name: 'Aiboo', risk: risk() })],
    }), NOW_SEC)

    expect(view.rows[0]?.riskLevel).toBe('ample')
    expect(view.rows[0]?.riskText).toBe('宽裕 · 预计 8-30 做完')
    expect(view.rows[0]?.riskTitle).toContain('按最近 14 天 7 条的速度')
  })

  it('赶不上：同一口径,只是等级不同', () => {
    const view = buildProjectRows(projectsState({
      projects: [project({ id: 'a', name: 'A', risk: risk({ level: 'late', eta: '2026-09-05' }) })],
    }), NOW_SEC)

    expect(view.rows[0]?.riskLevel).toBe('late')
    expect(view.rows[0]?.riskText).toBe('赶不上 · 预计 9-5 做完')
  })

  it('紧：也照样给预计完成日', () => {
    const view = buildProjectRows(projectsState({
      projects: [project({ id: 'a', name: 'A', risk: risk({ level: 'tight' }) })],
    }), NOW_SEC)

    expect(view.rows[0]?.riskText).toBe('紧 · 预计 8-30 做完')
  })

  it('无法判断：只写「无法判断」,不带预计日——没有就是没有(D13)', () => {
    const view = buildProjectRows(projectsState({
      projects: [project({
        id: 'a', name: 'A',
        risk: { level: 'unknown', reason: '没有任务卡,算不出速度', window_days: 14 },
      })],
    }), NOW_SEC)

    expect(view.rows[0]?.riskLevel).toBe('unknown')
    expect(view.rows[0]?.riskText).toBe('无法判断')
    expect(view.rows[0]?.riskTitle).toBe('没有任务卡,算不出速度')
  })

  it('算得出等级但算不出预计日(速度为零)：不显示「预计 undefined」', () => {
    const view = buildProjectRows(projectsState({
      projects: [project({
        id: 'a', name: 'A',
        risk: { level: 'late', reason: '最近 14 天一条都没完成', window_days: 14, done_recent: 0, remaining: 3 },
      })],
    }), NOW_SEC)

    expect(view.rows[0]?.riskText).toBe('赶不上')
  })

  it('服务端没给 risk（没接任务板）时整块缺省,不显示一个假的「无法判断」', () => {
    const view = buildProjectRows(projectsState({ projects: [project({ id: 'a', name: 'A' })] }), NOW_SEC)
    expect(view.rows[0]?.riskLevel).toBeUndefined()
    expect(view.rows[0]?.riskText).toBeUndefined()
  })
})
