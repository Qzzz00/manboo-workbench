/**
 * git 扫描器 → 项目区「算」行。
 * 纪律(spec D3):导出值每次重算,永不落盘、永不手工编辑——落盘的信号会和真实 git 漂移,然后开始骗人。
 * 折叠规则(spec D14):worktree 不单独成行;prunable/临时目录剔除;claude/* 随机名折叠成「可清理」。
 */
export type Exec = (args: readonly string[], cwd: string) => Promise<{ ok: boolean, stdout: string }>
export interface ScanRoot { path: string, depth: number }
export interface RepoInfo {
  path: string, name: string, branch: string, dirtyCount: number,
  worktreesActive: number, cleanupCount: number, lastCommitAt?: string,
  /** 本地分支名(refs/heads,含 worktree 的)。取不到就缺席。2026-09-09 任务卡挂分支用。 */
  branches?: string[],
  /**
   * 窗口内的提交次数(2026-09-09 排期风险)。项目没有任务卡时,这是唯一能说明
   * 「还在动没有」的数字。**问不出来就缺省,不填 0**(D13):真的零次提交和 git 报错
   * 是两回事,后者填 0 等于替 git 编一个答案。
   */
  recentCommits?: number,
}
export interface ScanError { root: string, reason: string }

const TMP_MARKERS = ['/tmp/', '/scratchpad/']

export function parseWorktreePorcelain(text: string, mainPath: string): { active: number, cleanup: number } {
  let active = 0
  let cleanup = 0
  for (const block of text.split('\n\n')) {
    const lines = block.split('\n').filter(l => l !== '')
    if (lines.length === 0) continue
    const path = lines[0]?.replace(/^worktree /, '') ?? ''
    if (path === mainPath) continue
    if (lines.some(l => l.startsWith('prunable'))) continue
    if (TMP_MARKERS.some(m => path.includes(m))) continue
    const branch = lines.find(l => l.startsWith('branch '))?.replace('branch refs/heads/', '') ?? ''
    if (branch.startsWith('claude/')) cleanup += 1
    else active += 1
  }
  return { active, cleanup }
}

export function idleDays(lastCommitAt: string | undefined, nowSec: number): number {
  if (lastCommitAt === undefined) return 0
  const at = Date.parse(lastCommitAt)
  if (Number.isNaN(at)) return 0
  return Math.max(0, Math.floor((nowSec - at / 1000) / 86400))
}

export async function scanRepo(
  path: string,
  exec: Exec,
  /** 提交活跃度的窗口天数(排期风险的速度窗口)。缺省 = 不问这一条,不多跑一次 git。 */
  recentDays?: number,
): Promise<RepoInfo | { path: string, error: string }> {
  let branch = await exec(['rev-parse', '--abbrev-ref', 'HEAD'], path)
  if (!branch.ok) {
    // 刚 git init、一次提交都没有的仓库(微信小程序模板常见):HEAD 无法解析,
    // 但 symbolic-ref 仍能给出分支名。这不是「未接入」,是「还没提交」,按正常行展示。
    branch = await exec(['symbolic-ref', '--short', 'HEAD'], path)
    if (!branch.ok) return { path, error: 'git rev-parse 失败' }
  }
  const status = await exec(['status', '--porcelain'], path)
  if (!status.ok) return { path, error: 'git status 失败' }
  const log = await exec(['log', '-1', '--format=%cI'], path)
  const worktrees = await exec(['worktree', 'list', '--porcelain'], path)
  const wt = worktrees.ok ? parseWorktreePorcelain(worktrees.stdout, path) : { active: 0, cleanup: 0 }
  const last = log.ok ? log.stdout.trim() : ''
  // 分支清单只是给任务卡挑交付物用的,这条命令失败不该把整行判成「未接入」。
  const heads = await exec(['for-each-ref', '--format=%(refname:short)', 'refs/heads'], path)
  const branches = heads.ok ? heads.stdout.split('\n').map(l => l.trim()).filter(l => l !== '') : []
  // 窗口内提交次数:只在调用方要的时候才问,免得每次扫描都多跑一条 git。
  let recentCommits: number | undefined
  if (recentDays !== undefined) {
    const counted = await exec(['rev-list', '--count', `--since=${recentDays} days ago`, 'HEAD'], path)
    const n = counted.ok ? Number(counted.stdout.trim()) : Number.NaN
    if (Number.isInteger(n) && n >= 0) recentCommits = n
  }
  return {
    path,
    name: path.split('/').filter(Boolean).at(-1) ?? path,
    branch: branch.stdout.trim(),
    dirtyCount: status.stdout.split('\n').filter(l => l !== '').length,
    worktreesActive: wt.active,
    cleanupCount: wt.cleanup,
    ...(last === '' ? {} : { lastCommitAt: last }),
    ...(branches.length === 0 ? {} : { branches }),
    ...(recentCommits === undefined ? {} : { recentCommits }),
  }
}

export async function findRepos(
  root: ScanRoot,
  listDir: (dir: string) => Promise<string[]>,
  isRepo: (dir: string) => Promise<boolean>,
): Promise<string[]> {
  const out: string[] = []
  async function walk(dir: string, depth: number): Promise<void> {
    if (await isRepo(dir)) { out.push(dir); return }
    if (depth <= 0) return
    for (const child of await listDir(dir)) await walk(child, depth - 1)
  }
  await walk(root.path, root.depth)
  return out
}
