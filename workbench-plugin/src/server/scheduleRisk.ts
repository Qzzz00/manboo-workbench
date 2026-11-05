/**
 * 排期风险(2026-09-09):项目经理层「按当前速度 vs 截止日」。
 *
 * 出处:docs/设计-三种视角与事务官边界.md §3(项目经理层最薄,说不出「按这个速度赶不上 DDL」)、
 * docs/决策记录.md 2026-09-09 傍晚拍板第 6 条。
 *
 * 全是纯函数,不读文件、不起定时器:composeState 每次组装 /state 时现算一遍,结果永不落盘
 * (落盘的判断会和真实进度漂移,然后开始骗人——与 RepoSignals「算」行同一条纪律)。
 *
 * ## 速度口径(待 Ben 拍板,见 docs/交接-0909-排期风险.md)
 *
 * - **窗口**:最近 RISK_WINDOW_DAYS(14)天。一冲刺两周,窗口跟冲刺同长,比 7 天抗周末抖动。
 * - **速度** = 窗口内完成的卡数 / 窗口天数(条/天)。卡的完成时刻取 `done_at`,老卡没有就退回 `updated_at`。
 * - **剩余** = 状态不是 done、也不是 canceled 的卡数。取消的卡不进分子也不进分母(与冲刺进度同一口径)。
 * - **预计完成日** = 今天 + ⌈剩余 / 速度⌉ 天。
 * - **四档**:
 *   - 截止已过而活没干完 → 赶不上(这是事实,不需要速度)
 *   - 预计天数 > 剩余天数 → 赶不上
 *   - 预计天数 > 剩余天数 × RISK_TIGHT_RATIO,或余量 < RISK_MIN_SLACK_DAYS → 紧
 *   - 其余 → 宽裕
 * - **无法判断**(D13:数据不够就是无法判断,不编):没有截止日 / 截止日格式坏 / 没有任务卡 /
 *   卡都是窗口内刚建的且一条没完成(还看不出速度)。
 * - **速度为零但卡建了超过一个窗口** → 赶不上:「按当前速度」速度就是零,这不是编,是照实说。
 * - **没有任务卡**时不据仓库提交活跃度编预计日——提交数没有分母,给不出「几天做完」;
 *   只把「最近 N 天 K 次提交 / 停 X 天」写进原因,让人自己看。
 */
import type {
  ProjectsState,
  ScheduleRisk,
  ScheduleRiskLevel,
  SprintView,
  TasksState,
  TaskView,
  WorkbenchEvent,
  WorkbenchProject,
} from '../protocol.ts'

/** 速度窗口(天)。 */
export const RISK_WINDOW_DAYS = 14
/** 预计天数超过剩余天数的这个比例就算「紧」。 */
export const RISK_TIGHT_RATIO = 0.8
/** 余量少于这么多天也算「紧」——三十天的项目余两天不算宽裕。 */
export const RISK_MIN_SLACK_DAYS = 2

/** 只取判断需要的几个字段,TaskView 直接满足。 */
export interface RiskTask {
  status: TaskView['status']
  created_at: string
  updated_at: string
  done_at?: string
}

export interface ScheduleRiskInput {
  /** 截止日 YYYY-MM-DD。缺省 = 没有截止日。 */
  ddl?: string
  tasks: readonly RiskTask[]
  /** 没有任务卡时用来说明「还在动没有」的仓库信号。只进原因文案,不进计算。 */
  repo?: { idle_days: number, recent_commits?: number }
}

const DAY_MS = 86_400_000

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/** 本地日期 YYYY-MM-DD(与 brief.ts / client dates.ts 同一条纪律:按本地时区切天)。 */
function localDate(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function localMidnight(ms: number): number {
  const d = new Date(ms)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

/** 距某个 YYYY-MM-DD 还剩几天(负数 = 已过);解析不了回 undefined,不回 0(0 和「今天到期」长得一样)。 */
function daysUntil(dateOnly: string, nowMs: number): number | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateOnly)
  if (m === null) return undefined
  const target = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime()
  if (Number.isNaN(target)) return undefined
  return Math.round((target - localMidnight(nowMs)) / DAY_MS)
}

/** M-D,原因文案用。 */
export function monthDay(dateOnly: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateOnly)
  return m === null ? dateOnly : `${Number(m[2])}-${Number(m[3])}`
}

function completedAtMs(task: RiskTask): number {
  const at = Date.parse(task.done_at ?? task.updated_at)
  return Number.isNaN(at) ? Number.NEGATIVE_INFINITY : at
}

function repoNote(repo: ScheduleRiskInput['repo'], windowDays: number): string {
  if (repo === undefined) return ''
  const parts: string[] = []
  if (repo.recent_commits !== undefined) parts.push(`仓库最近 ${windowDays} 天 ${repo.recent_commits} 次提交`)
  parts.push(repo.idle_days === 0 ? '今天在动' : `停 ${repo.idle_days} 天`)
  return `;${parts.join(',')}`
}

export function assessScheduleRisk(input: ScheduleRiskInput, nowSec: number, windowDays = RISK_WINDOW_DAYS): ScheduleRisk {
  const nowMs = nowSec * 1000
  const base = { window_days: windowDays }
  const unknown = (reason: string, extra: Partial<ScheduleRisk> = {}): ScheduleRisk =>
    ({ level: 'unknown', reason, ...base, ...extra })

  if (input.ddl === undefined) return unknown('没有截止日')
  const daysLeft = daysUntil(input.ddl, nowMs)
  if (daysLeft === undefined) return unknown(`截止日「${input.ddl}」格式有误`)

  const counted = input.tasks.filter(task => task.status !== 'canceled')
  const remainingTasks = counted.filter(task => task.status !== 'done')
  const remaining = remainingTasks.length

  if (counted.length === 0) {
    if (daysLeft < 0) {
      return { level: 'late', reason: `截止已过 ${-daysLeft} 天,没有任务卡${repoNote(input.repo, windowDays)}`, ...base }
    }
    return unknown(`没有任务卡,算不出速度${repoNote(input.repo, windowDays)}`)
  }

  const windowStart = nowMs - windowDays * DAY_MS
  const doneTasks = counted.filter(task => task.status === 'done')
  const doneRecent = doneTasks.filter(task => completedAtMs(task) >= windowStart).length
  const counts = { done_recent: doneRecent, remaining }

  if (remaining === 0) {
    const last = Math.max(...doneTasks.map(completedAtMs))
    return {
      level: 'ample',
      ...(Number.isFinite(last) ? { eta: localDate(last) } : {}),
      reason: `${doneTasks.length} 条任务全部完成`,
      ...base,
      ...counts,
    }
  }

  if (daysLeft < 0) {
    return { level: 'late', reason: `截止已过 ${-daysLeft} 天,还剩 ${remaining} 条`, ...base, ...counts }
  }

  if (doneRecent === 0) {
    const oldest = Math.min(...counted.map(task => Date.parse(task.created_at)).filter(ms => !Number.isNaN(ms)))
    if (!Number.isFinite(oldest) || oldest >= windowStart) {
      return unknown(`任务卡建了不到 ${windowDays} 天、一条没完成,还看不出速度;剩 ${remaining} 条`, counts)
    }
    return {
      level: 'late',
      reason: `最近 ${windowDays} 天一条都没完成,按这个速度做不完剩下的 ${remaining} 条`,
      ...base,
      ...counts,
    }
  }

  const velocity = doneRecent / windowDays
  const needDays = Math.ceil(remaining / velocity)
  const eta = localDate(localMidnight(nowMs) + needDays * DAY_MS)
  const slack = daysLeft - needDays
  const pace = `按最近 ${windowDays} 天 ${doneRecent} 条的速度,剩 ${remaining} 条约 ${needDays} 天做完`

  let level: ScheduleRiskLevel
  let reason: string
  if (needDays > daysLeft) {
    level = 'late'
    reason = `${pace},截止只剩 ${daysLeft} 天`
  }
  else if (needDays > daysLeft * RISK_TIGHT_RATIO || slack < RISK_MIN_SLACK_DAYS) {
    level = 'tight'
    reason = `${pace},截止前只余 ${slack} 天`
  }
  else {
    level = 'ample'
    reason = `${pace},截止前还余 ${slack} 天`
  }
  return { level, eta, reason, ...base, ...counts }
}

/**
 * 给 /state 的项目行与冲刺各挂一份风险。
 *
 * 项目行:截止日 = ProjectDdl.date,任务 = project_id 归它的卡;没有卡时把仓库信号交给原因文案。
 * 冲刺:截止日 = ends_at,任务 = 本冲刺各模块下、属于本项目的卡(与 boardModel.sprintProgress 同一范围)。
 * 卡本身一张不动(返回同一个数组引用)。
 */
export function decorateRisk(
  projects: ProjectsState,
  tasks: TasksState,
  nowSec: number,
): { projects: ProjectsState, tasks: TasksState } {
  const decoratedProjects: WorkbenchProject[] = projects.projects.map((project) => {
    const mine = tasks.tasks.filter(task => task.project_id === project.id)
    const repo = project.signals === undefined
      ? undefined
      : {
          idle_days: project.signals.idle_days,
          ...(project.signals.recent_commits === undefined ? {} : { recent_commits: project.signals.recent_commits }),
        }
    return {
      ...project,
      risk: assessScheduleRisk({
        ...(project.ddl === undefined ? {} : { ddl: project.ddl.date }),
        tasks: mine,
        ...(repo === undefined ? {} : { repo }),
      }, nowSec),
    }
  })

  const decoratedSprints: SprintView[] = tasks.sprints.map((sprint) => {
    const moduleIds = new Set(tasks.modules.filter(module => module.sprint_id === sprint.id).map(module => module.id))
    const mine = tasks.tasks.filter(task => task.project_id === sprint.project_id
      && task.module_id !== undefined && moduleIds.has(task.module_id))
    return {
      ...sprint,
      risk: assessScheduleRisk({
        ...(sprint.ends_at === undefined ? {} : { ddl: sprint.ends_at }),
        tasks: mine,
      }, nowSec),
    }
  })

  return {
    projects: { ...projects, projects: decoratedProjects },
    tasks: { ...tasks, sprints: decoratedSprints },
  }
}

/** 排期风险那条会话的 id。前缀与哨兵的 `sentinel:` 同款,界面/测试按前缀认。 */
export function scheduleSessionId(projectId: string): string {
  return `schedule:${projectId}`
}

export interface RiskWatcher {
  /**
   * 看一眼这一拍的项目行,回「该发出去的事件」:
   * 变成赶不上 → 一条 waiting + idle_prompt(不响铃:响铃只给审批,见 ring.ts);
   * 从赶不上离开(或项目消失)→ 一条 offline,收掉那条会话。
   * 第一次看到某个项目只建基线,不报——重启一次报一次会很吵(与哨兵「第一拍只建基线」同一取舍)。
   */
  observe: (projects: readonly WorkbenchProject[]) => WorkbenchEvent[]
}

export function createRiskWatcher(now: () => number): RiskWatcher {
  const seen = new Map<string, ScheduleRiskLevel>()

  return {
    observe(projects) {
      const nowSec = now()
      const events: WorkbenchEvent[] = []
      const present = new Set<string>()

      for (const project of projects) {
        if (project.risk === undefined) continue
        present.add(project.id)
        const before = seen.get(project.id)
        const level = project.risk.level
        seen.set(project.id, level)
        if (before === undefined || before === level) continue

        if (level === 'late') {
          const ddl = project.ddl === undefined ? '' : ` ${monthDay(project.ddl.date)}`
          const eta = project.risk.eta === undefined ? '' : `按当前速度预计 ${monthDay(project.risk.eta)} 才能做完。`
          events.push({
            agent: 'dsh',
            session_id: scheduleSessionId(project.id),
            project: project.name,
            type: 'waiting',
            reason: 'idle_prompt',
            title: `${project.name} 排期:赶不上${ddl}`,
            summary: `${eta}${project.risk.reason}`,
            ts: nowSec,
          })
        }
        else if (before === 'late') {
          events.push(offline(project.id, nowSec))
        }
      }

      for (const [id, level] of [...seen]) {
        if (present.has(id)) continue
        seen.delete(id)
        if (level === 'late') events.push(offline(id, nowSec))
      }
      return events
    },
  }
}

function offline(projectId: string, nowSec: number): WorkbenchEvent {
  return { agent: 'dsh', session_id: scheduleSessionId(projectId), type: 'offline', reason: 'offline', ts: nowSec }
}
