/**
 * 路径 → 项目名(纯函数)。
 *
 * Ben 大量用 worktree:同一个仓库下五个 worktree 会在原始数据里算成五个项目,
 * 项目列表会被撑爆。归拢回仓库是他确认过的口径。
 *
 * Codex/ChatGPT 那两棵树先按日期分一层目录,直接取第一级会得到名叫 `2026-08-20`
 * 的"项目"——实测踩过,所以日期层要跳过取下一级。
 */
const HOME = '/Users/example'

/**
 * 项目名归并表。ben-dsh-workbench 是工作台的作废前身(2026-08-26 Ben 口径),
 * 与 desktop-workbench 是同一个项目——不归并的话历史用量分裂成两行。
 */
const ALIASES: Record<string, string> = {
  'ben-dsh-workbench': 'desktop-workbench',
}

function alias(name: string): string {
  return ALIASES[name] ?? name
}

export function rollupProject(cwd: string): string {
  if (cwd === '') return '(未知)'

  // Codex worktree 的布局是 `~/.codex/worktrees/<hash>/<仓库名>`——仓库名在 hash
  // **后面**,不能走下面的剥尾巴逻辑(那会剥成假项目「~/.codex」,真机踩过:348M
  // token 全落在这个名下,其中就有工作台的 Codex 会话)。
  const codexWt = cwd.match(/\/\.codex\/worktrees\/[^/]+\/([^/]+)/)
  if (codexWt?.[1] !== undefined) return alias(codexWt[1])

  // worktree:剥掉 `/.claude/worktrees/<name>` 及其后缀
  let path = cwd.replace(/\/\.claude\/worktrees\/[^/]+.*$/, '')
  path = path.replace(/\/[A-Za-z-]*worktrees\/[^/]+.*$/, '')

  const dated = path.match(/^\/Users\/ben\/Documents\/(?:Codex|ChatGPT)\/\d{4}-\d{2}-\d{2}\/([^/]+)/)
  if (dated?.[1] !== undefined) return alias(dated[1])

  const named = path.match(/^\/Users\/ben\/(?:Documents\/(?:GitHub|Codex|ChatGPT)|Applications)\/([^/]+)/)
  if (named?.[1] !== undefined) return alias(named[1])

  return path.startsWith(`${HOME}/`) ? path.replace(`${HOME}/`, '~/') : path
}
