/**
 * git 数据源(2026-09-21「项目数据源」那张卡)—— **现状,一字不改**。
 *
 * 这里没有一行新逻辑。三个方法的函数体是从 `projectsService.build()` 里**原样搬过来**的
 * 那三段:
 *
 * - `list()`   ← 「① 逐扫描根找仓库;一个根读不到只记那个根的错,其余照常」那一段
 *                 (连 `repoPaths.sort` 那条确定性排序的理由都跟着搬)
 * - `summary()`← 「② 逐仓扫『算』信号」+ 把 `RepoInfo` 拼成 `RepoSignals` 那一段
 * - `detail()` ← **没有对应的段**,回空数组。理由写在 projectSource.ts 头注里:
 *                 项目行展开后那两行来自 `projects.json`,不是数据源的事。
 *
 * 值一个都没改,所以既有那一大批项目区用例原样兜着;搬家有没有改动任何东西,由
 * `tests/server-project-source.test.ts` 里「同一批假 exec 喂进去,拼出来的 RepoSignals
 * 与从前逐字相同」那一组钉着。
 */
import type { RepoSignals } from '../protocol.ts'
import type { ProjectSource, ProjectSourceListing, ProjectSummary } from './projectSource.ts'
import { findRepos, idleDays, scanRepo } from './scan.ts'
import type { Exec, ScanRoot } from './scan.ts'

export interface GitSourceOptions {
  exec: Exec
  listDir: (dir: string) => Promise<string[]>
  isRepo: (dir: string) => Promise<boolean>
  /**
   * 每次真扫现问一遍(2026-09-17 卡 C:Ben 在设置里改完扫描根不必重启 DSH)。
   * 这里保持"函数"这个形状,不接受数组 —— 传数组等于"起服务时取一次",正是"改了没反应"的出处。
   */
  scanRoots: () => Promise<readonly ScanRoot[]>
  /** 提交活跃度的窗口天数(排期风险的速度窗口)。 */
  recentDays: number
  /** 当前 Unix 秒。`idle_days` 按它算。 */
  now: () => number
}

export function createGitSource(opts: GitSourceOptions): ProjectSource {
  return {
    id: 'git',
    // 会话就是在仓库里开的 —— 归属这一层对 git 数据源是一等公民。
    attributes_sessions: true,

    async list(): Promise<ProjectSourceListing> {
      const paths: string[] = []
      const scan_errors: { root: string, reason: string }[] = []
      for (const root of await opts.scanRoots()) {
        try {
          paths.push(...await findRepos(root, opts.listDir, opts.isRepo))
        }
        catch (err) {
          scan_errors.push({ root: root.path, reason: String(err) })
        }
      }
      // readdir 顺序不保证稳定,而遍历顺序决定了未存仓库的 id 消歧结果(先到先得最短形式);
      // 目录顺序一变,同名仓库谁拿到 'echo'、谁拿到 'echo-wx' 就跟着漂移,客户端手里缓存的 id
      // 可能悄悄指向另一个仓库(confirmStatus 顺手创建会落错对象,且没有任何报错)。
      paths.sort((a, b) => a.localeCompare(b, 'en'))
      return { paths, scan_errors }
    },

    async summary(path: string): Promise<ProjectSummary> {
      const result = await scanRepo(path, opts.exec, opts.recentDays)
      if ('error' in result) {
        // 单仓失败进这一行的 signal_error,不拖垮整批(D13)。
        return { kind: 'error', error: result.error, idle_candidate: false }
      }
      const lastCommitAt = result.lastCommitAt
      const nowSec = opts.now()
      const signals: RepoSignals = {
        branch: result.branch,
        dirty_count: result.dirtyCount,
        worktrees: result.worktreesActive,
        cleanup_count: result.cleanupCount,
        idle_days: idleDays(lastCommitAt, nowSec),
        ...(lastCommitAt === undefined ? {} : { last_commit_at: lastCommitAt }),
        ...(result.branches === undefined ? {} : { branches: result.branches }),
        ...(result.recentCommits === undefined ? {} : { recent_commits: result.recentCommits }),
      }
      return {
        kind: 'repo',
        signals,
        ...(lastCommitAt === undefined ? {} : { last_activity_at: lastCommitAt }),
        // 「闲置 = 7 天没提交」,既有口径逐字。
        idle_candidate: idleDays(lastCommitAt, nowSec) >= 7,
      }
    },

    /** git 这一支没有额外可展开的东西 —— 理由见 projectSource.ts 头注(不是忘了写)。 */
    detail(): Promise<readonly []> {
      return Promise.resolve([])
    },
  }
}
