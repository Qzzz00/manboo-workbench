/**
 * 引导里的「真去扫一遍仓库」(2026-09-20,Ben 真机第二轮:「授权扫仓库,但是没去扫」)。
 *
 * 他那一通电话的日志里只有十几条 `record_answer`,**一次扫描都没有** —— 因为通话模式的工人
 * 手上只有 `record_answer` 一件工具,项目那一段它只能**凭空问**:「这个项目是什么?」
 * 「做到哪了?」。而②′ 那一段的设计原本就是「授权线 ∥ 访谈线」:拿到授权就去读仓库,
 * 读到的当素材,再拿去跟他确认。扫描这一半在电话里整个缺席了。
 *
 * 这个文件是那一半的**纯函数**部分:把项目区已经算好的 `ProjectsState`
 * (projectsService.ts,和电脑上项目区看到的是同一份)翻译成一份**电话里念得出来**的仓库清单。
 * 没有 I/O、不认识 http —— 门(`read_scan_roots` 授权)与路由在 http.ts。
 *
 * 纪律:
 *   - **不编**。扫不到信号的仓库就说「读不到它的 git 信息」,不写一个 0 上去(D13)。
 *   - 念得出来。summary 是一句中文,不出现 id、不出现绝对路径、不出现 Markdown。
 *   - 有上限。一次最多回 {@link SCAN_REPO_LIMIT} 个:电话里念不完二十个仓库名,
 *     多出来的如实说一句「还有 N 个」,由人决定要不要细聊。
 */
import type { ProjectsState, WorkbenchProject } from '../protocol.ts'

/** 一次最多回几个仓库。电话里够聊了;`more` 里如实说还剩几个。 */
export const SCAN_REPO_LIMIT = 12

/** 按名字没找到时退一步念给他挑的个数(2026-09-24:一句话念得完 3–5 个)。 */
export const LOCATE_FALLBACK_CANDIDATES = 5

export interface ScannedRepo {
  name: string
  path: string
  /** 最近一次提交的时间(ISO)。读不到就缺席 —— **不写一个 0,也不写「从没提交过」**。 */
  last_commit?: string
  /** 一句中文,电话里直接念得出来。 */
  summary: string
}

export interface OnboardingScanResult {
  repos: readonly ScannedRepo[]
  /** 扫到的总数(可能大于 repos.length,见 {@link SCAN_REPO_LIMIT})。 */
  total: number
  /** 没进清单的还有几个。0 就是都在上面了。 */
  more: number
  /** 这一份是什么时候扫的(ISO)。项目区有节流,这个数可能比「现在」早几十秒,如实给。 */
  scanned_at: string
  /** 哪个扫描根读不到、为什么。一个根坏了不该让整次扫描变成一句「失败了」。 */
  errors: readonly { root: string, reason: string }[]
}

/** 「多久没动了」。天数由项目区算好(idle_days),这里只翻成人话。 */
export function idleText(idleDays: number | undefined): string {
  if (idleDays === undefined || !Number.isFinite(idleDays)) return ''
  if (idleDays <= 0) return '今天还在动'
  if (idleDays === 1) return '昨天动过'
  if (idleDays < 7) return `${idleDays} 天没动`
  if (idleDays < 30) return `${Math.floor(idleDays / 7)} 周没动`
  if (idleDays < 365) return `${Math.floor(idleDays / 30)} 个月没动`
  return '一年多没动'
}

/**
 * 一个项目 → 一句念得出来的话。
 *
 * 取的东西按「他听得懂」排序:人确认过的那一行状态 > 多久没动 > 分支与未提交。
 * 扫不到 git 信号时**如实说**,不拿空话填。
 */
export function repoSummary(project: WorkbenchProject): string {
  const parts: string[] = []
  const status = project.status?.text?.trim()
  if (status !== undefined && status !== '') parts.push(status)
  const signals = project.signals
  if (signals === undefined) {
    parts.push(project.signal_error === undefined ? '读不到它的 git 信息' : `读不到它的 git 信息(${project.signal_error})`)
    return parts.join(';')
  }
  const idle = idleText(signals.idle_days)
  if (idle !== '') parts.push(idle)
  if (signals.branch !== '' && signals.branch !== 'main' && signals.branch !== 'master') {
    parts.push(`在 ${signals.branch} 这条分支上`)
  }
  if (signals.dirty_count > 0) parts.push(`有 ${signals.dirty_count} 处还没提交`)
  if (parts.length === 0) parts.push('干净的,没什么待办的痕迹')
  return parts.join(';')
}

/**
 * 「最近动的是哪几个」在前。她开口第一句要说的就是这个
 * (「我看到 13 个仓库,最近动的是 X、Y,先从哪个说?」),排序错了那句话就是假的。
 *
 * 排序:idle_days 小的在前;读不到信号的排最后(不知道 ≠ 很久没动);同样新的按名字定序,
 * 免得两次扫描顺序自己漂。
 */
export function byRecency(a: WorkbenchProject, b: WorkbenchProject): number {
  const left = a.signals?.idle_days
  const right = b.signals?.idle_days
  if (left === undefined && right === undefined) return a.name.localeCompare(b.name, 'zh')
  if (left === undefined) return 1
  if (right === undefined) return -1
  if (left !== right) return left - right
  return a.name.localeCompare(b.name, 'zh')
}

/**
 * `ProjectsState` → 电话里的仓库清单。
 *
 * **只要有仓库路径的**:没有 path 的是手工建的项目(市场调研之类),它们不是「扫到的仓库」,
 * 放进来会让「我扫了一下你的电脑」变成一句半真的话。
 */
export function scanResultOf(state: ProjectsState, limit = SCAN_REPO_LIMIT): OnboardingScanResult {
  const withRepo = state.projects.filter((project): project is WorkbenchProject & { path: string } =>
    typeof project.path === 'string' && project.path !== '')
  const sorted = [...withRepo].sort(byRecency)
  const head = limit > 0 ? sorted.slice(0, limit) : sorted
  return {
    repos: head.map(project => ({
      name: project.name,
      path: project.path,
      ...(project.signals?.last_commit_at === undefined ? {} : { last_commit: project.signals.last_commit_at }),
      summary: repoSummary(project),
    })),
    total: sorted.length,
    more: Math.max(0, sorted.length - head.length),
    scanned_at: state.scanned_at,
    errors: state.scan_errors,
  }
}
