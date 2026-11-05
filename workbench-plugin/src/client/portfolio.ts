/**
 * 项目区的纯投影(spec D8:"项目状态由本地服务持有并持久化,portfolio.ts 退成纯投影")。
 *
 * 本文件不再持有任何项目定义或匹配规则——那些已经搬进 src/server/projects.ts
 * 与 scan.ts,由服务端算好、存好,经 GET /state 的 projects 字段整块下发。
 * 这里只做"数据 → 界面文案"的无副作用转换,方便单测,不摸 DOM、不发请求。
 */
import type {
  PendingGroup, ProjectDdl, ProjectDetailLine, ProjectsState, ProjectStage, ProjectStatusLine,
  ScheduleRiskLevel, WorkbenchProject,
} from '../protocol.ts'
import { scheduleRiskText } from '../protocol.ts'
import { daysLeftFromNow } from './dates.ts'

export type ProjectTone = 'hot' | 'warn' | 'normal' | 'cold'

export interface ProjectRow {
  id: string
  name: string
  stage: ProjectStage
  /**
   * git 数据源:'今天在动' | '停 N 天' | '无仓库'。
   * 账号数据源:'还没有笔记' | '今天有笔记' | '停更 N 天'(2026-09-21)。
   */
  activityText: string
  tone: ProjectTone
  /**
   * git 数据源:'main · 10 未提交 · 1 worktree(另 4 个 claude/* 可清理)' | '未接入:<原因>'。
   * 账号数据源:'小红书 · 最近笔记 9-20 · 3 件进行中'(2026-09-21)。
   */
  signalText: string
  /** signalText 是不是"未接入"那条(spec D13:未接入必须醒目,不能跟正常算行同色同款)。 */
  signalError: boolean
  statusText?: string
  statusStale: boolean
  /** '你 · 8-18'，suggested 再加 '(AI 拟,待确认)'。 */
  statusMeta?: string
  /**
   * 数据源在展开那一层多说的几行(2026-09-21)。git 那一支恒为空数组;
   * 账号那一支是 `账号.md` 里的定位 / 风格 / 人群 / 平台 / 开号日期。
   */
  detailLines: readonly ProjectDetailLine[]
  fragmentsText: string
  /** 'M-D 标题(剩 N 天)'；过期是 '已过 M-D'；剩 <=1 天再加 '——今天要动'。 */
  ddlText?: string
  /**
   * 排期风险(2026-09-09)。服务端不给(没接任务板)时**整块缺省**——
   * 界面照旧,不显示一个凭空的「无法判断」。
   */
  riskLevel?: ScheduleRiskLevel
  /** '赶不上 · 预计 9-19 做完';算不出预计日时只有等级那半句。 */
  riskText?: string
  /** 依据原文,进 title,鼠标停上去看得到口径。 */
  riskTitle?: string
}

export interface ProjectRowsView {
  /** 他确认过的项目(`confirmed`,2026-09-25)。项目区正文只排这几行。 */
  rows: ProjectRow[]
  /**
   * 扫描自动发现、没落进 projects.json 的仓库(2026-09-25,维护者:「引导说了两个项目,看板里还是一堆」)。
   * 收进项目区末尾那一格「其他仓库(N)」,点开才看;闲置那一行也在里面。
   */
  otherRows: ProjectRow[]
  idleText: string
  pendingText: string
  scanErrorTexts: string[]
  /** 项目区这一回没去看他的目录,为什么(2026-09-23,`ProjectsState.scan_blocked`)。没有就是空串。 */
  blockedText: string
}

/**
 * 账号那一支的活跃度(2026-09-21)。
 *
 * 「一条笔记都没有」与「今天刚发过」不许长成同一句话:前者是刚建出来的账号(引导里
 * 问完就会是这个样子),后者是在动。所以 `note_count === 0` 有自己的一句,
 * 而不是落进"停 0 天"。
 */
function buildAccountActivity(account: NonNullable<WorkbenchProject['account']>): { activityText: string, tone: ProjectTone } {
  if (account.note_count === 0) return { activityText: '还没有笔记', tone: 'cold' }
  const days = account.idle_days
  // 有笔记却算不出日期(文件名没日期、mtime 也问不到):**不编一个天数**,只说有几条。
  if (days === undefined) return { activityText: `${account.note_count} 条笔记`, tone: 'normal' }
  if (days === 0) return { activityText: '今天有笔记', tone: 'hot' }
  // 「停更」而不是「停」:运营这条线上不更新就是停更,git 那边的措辞照旧不动。
  return { activityText: `停更 ${days} 天`, tone: days < 10 ? 'normal' : 'warn' }
}

/** 「算」行读出的活跃度文案与色调(spec D3)。 */
function buildActivity(project: WorkbenchProject): { activityText: string, tone: ProjectTone } {
  // 账号数据源那一支(2026-09-21)。**放在最前面**:它与下面那几条 git 口径互斥,
  // 一个项目行上不会同时有 signals 与 account。
  if (project.account !== undefined) return buildAccountActivity(project.account)
  if (project.signals !== undefined) {
    const days = project.signals.idle_days
    if (days === 0) return { activityText: '今天在动', tone: 'hot' }
    if (days < 10) return { activityText: `停 ${days} 天`, tone: 'normal' }
    // 停得久且状态没人确认过(过期或压根没写过)才升级成警示档，
    // 免得一个仓库本来就闲(比如长期归档)也被天天标红。
    const warn = project.status === undefined || project.status.stale
    return { activityText: `停 ${days} 天`, tone: warn ? 'warn' : 'normal' }
  }
  if (project.session_count > 0) return { activityText: '无仓库', tone: 'cold' }
  return { activityText: '', tone: 'cold' }
}

function buildSignalText(project: WorkbenchProject): string {
  if (project.signal_error !== undefined) return `未接入:${project.signal_error}`
  if (project.account !== undefined) {
    const { platform, last_note_at, open_tasks } = project.account
    // 每一段**有才写**:没写平台就不占一格「—」,没接看板就不写「0 件进行中」
    // (「一件都没有」和「数不出来」不是一回事,D13)。
    const parts: string[] = []
    if (platform !== undefined) parts.push(platform)
    parts.push(last_note_at === undefined ? '还没有笔记' : `最近笔记 ${monthDayFromDateOnly(last_note_at)}`)
    if (open_tasks !== undefined) parts.push(`${open_tasks} 件进行中`)
    return parts.join(' · ')
  }
  if (project.signals === undefined) return ''
  const { branch, dirty_count, worktrees, cleanup_count } = project.signals
  const base = `${branch} · ${dirty_count} 未提交 · ${worktrees} worktree`
  return cleanup_count > 0 ? `${base}(另 ${cleanup_count} 个 claude/* 可清理)` : base
}

function monthDayFromIso(iso: string): string {
  const date = new Date(iso)
  return `${date.getMonth() + 1}-${date.getDate()}`
}

function monthDayFromDateOnly(dateStr: string): string {
  const [, , month, day] = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateStr) ?? []
  return month === undefined || day === undefined ? dateStr : `${Number(month)}-${Number(day)}`
}

function buildStatusMeta(status: ProjectStatusLine): string {
  const base = `${status.author} · ${monthDayFromIso(status.updated_at)}`
  return status.review === 'suggested' ? `${base}(AI 拟,待确认)` : base
}

/**
 * DDL 日期解析失败(daysLeftFromNow 回 +Infinity)时，不显示"剩 N 天"/"已过"这类
 * 基于天数算出来的判断——那是编数据。只把日期原文和标题露出来，让人看得出"这条
 * DDL 数据本身有问题"，而不是被一个假装正常的倒计时糊弄过去。
 */
function buildDdlText(nowSec: number, ddl: ProjectDdl): string {
  const left = daysLeftFromNow(ddl.date, nowSec)
  if (!Number.isFinite(left)) return `${ddl.date} ${ddl.title}(日期格式有误)`
  if (left < 0) return `已过 ${monthDayFromDateOnly(ddl.date)}`
  const base = `${monthDayFromDateOnly(ddl.date)} ${ddl.title}(剩 ${left} 天)`
  return left <= 1 ? `${base}——今天要动` : base
}

function buildFragmentsText(links: readonly string[]): string {
  return links.length === 0 ? '' : `${links.length} 条零散记录`
}

function buildRow(project: WorkbenchProject, nowSec: number): ProjectRow {
  const { activityText, tone } = buildActivity(project)
  return {
    id: project.id,
    name: project.name,
    stage: project.stage,
    activityText,
    tone,
    signalText: buildSignalText(project),
    signalError: project.signal_error !== undefined,
    ...(project.status === undefined ? {} : { statusText: project.status.text }),
    statusStale: project.status?.stale ?? false,
    ...(project.status === undefined ? {} : { statusMeta: buildStatusMeta(project.status) }),
    detailLines: project.detail ?? [],
    fragmentsText: buildFragmentsText(project.links),
    ...(project.ddl === undefined ? {} : { ddlText: buildDdlText(nowSec, project.ddl) }),
    ...(project.risk === undefined
      ? {}
      : { riskLevel: project.risk.level, riskText: scheduleRiskText(project.risk), riskTitle: project.risk.reason }),
  }
}

/**
 * 排序权重:今天在动(0)最前,其余按停摆天数升序;无「算」信号的排到最后。
 *
 * 2026-09-21:账号那一支按「最近一条笔记距今几天」排同一条队。一条笔记都没有的账号
 * 算不出天数,落到最后 —— 它仍然**在列表里**(账号永远不进闲置线),只是排在有动静的后面。
 */
function idleRank(project: WorkbenchProject): number {
  return project.signals?.idle_days ?? project.account?.idle_days ?? Number.POSITIVE_INFINITY
}

function hasSignals(project: WorkbenchProject): project is WorkbenchProject & {
  signals: NonNullable<WorkbenchProject['signals']>
} {
  return project.signals !== undefined
}

/** 闲置线合并成一行(spec §3 末尾闲置线,灰、不催),按天数降序排列。 */
function buildIdleText(projects: readonly WorkbenchProject[]): string {
  return projects
    .filter(project => project.idle)
    .filter(hasSignals)
    .sort((left, right) => right.signals.idle_days - left.signals.idle_days)
    .map(project => `闲置 ${project.name} ${project.signals.idle_days} 天`)
    .join(' · ')
}

function buildPendingText(pending: readonly PendingGroup[]): string {
  const total = pending.reduce((sum, group) => sum + group.count, 0)
  return `${pending.length} 组 / ${total} 条`
}

/**
 * 他确认过的项目(2026-09-25):在 projects.json 里的那几个,服务端标 `confirmed`。
 * 看板页签(TaskBoard)与项目区总览用同一个判据。
 */
export function isConfirmedProject(project: Pick<WorkbenchProject, 'confirmed'>): boolean {
  return project.confirmed === true
}

/**
 * 这一份快照分不分得出「确认过的 / 扫到的」:**一个带 `confirmed` 的都没有**就分不出 ——
 * 老服务端(这个字段出现之前)、或者一个都还没确认过。那时照旧全排出来,不把他的项目全塞进「其他仓库」。
 */
export function confirmedSplit<T extends Pick<WorkbenchProject, 'confirmed'>>(projects: readonly T[]): { mine: T[], others: T[] } {
  if (!projects.some(isConfirmedProject)) return { mine: [...projects], others: [] }
  return { mine: projects.filter(isConfirmedProject), others: projects.filter(project => !isConfirmedProject(project)) }
}

/**
 * 把服务端的 ProjectsState 投影成项目区能直接渲染的行。不接的时候(projects
 * undefined,GET /state 还没来得及带上这块,或服务端本身没这块)不编数字,
 * 只给出一条"未接入"的扫描错误文案(spec D13)。
 */
export function buildProjectRows(projects: ProjectsState | undefined, nowSec: number): ProjectRowsView {
  if (projects === undefined) {
    return {
      rows: [],
      otherRows: [],
      idleText: '',
      pendingText: '0 组 / 0 条',
      scanErrorTexts: ['项目区未接入:服务未返回 projects'],
      blockedText: '',
    }
  }

  // idle:true 的项目不进主列表——它们已经合并进末尾的 idleText 一行
  // (spec §3/PRD §5.3："闲置项目不进分组,合并成末尾一行灰字")，两处都放
  // 会同一个项目重复出现两遍。
  const shown = projects.projects
    .filter(project => !project.idle)
    .sort((left, right) => idleRank(left) - idleRank(right))
  const split = confirmedSplit(shown)
  const rows = split.mine.map(project => buildRow(project, nowSec))
  const otherRows = split.others.map(project => buildRow(project, nowSec))

  return {
    rows,
    otherRows,
    idleText: buildIdleText(projects.projects),
    pendingText: buildPendingText(projects.pending),
    scanErrorTexts: projects.scan_errors.map(error => `${error.root} 未接入:${error.reason}`),
    blockedText: projects.scan_blocked ?? '',
  }
}
