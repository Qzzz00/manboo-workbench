/** Codex cwd 到工作台项目名的可验证归属解析。 */

export interface CodexProjectDeps {
  /** 返回主仓库根目录；worktree 必须回到 common Git repository，而不是 worktree basename。 */
  gitCommonRoot: (cwd: string) => Promise<string | undefined>
  /** 用既有项目状态/目录规则把一个已验证目录映射为展示名。 */
  projectNameForRoot: (root: string) => Promise<string | undefined>
}

export async function resolveCodexProject(
  cwd: string,
  deps: CodexProjectDeps,
): Promise<string | undefined> {
  let gitRoot: string | undefined
  try {
    gitRoot = await deps.gitCommonRoot(cwd)
  }
  catch {
    gitRoot = undefined
  }

  if (gitRoot !== undefined) {
    try {
      const project = await deps.projectNameForRoot(gitRoot)
      if (project !== undefined && project !== '') return project
    }
    catch {
      // 归属失败不应让当前 Codex 会话消失，继续尝试已配置的 cwd 目录规则。
    }
  }

  try {
    const project = await deps.projectNameForRoot(cwd)
    return project === undefined || project === '' ? undefined : project
  }
  catch {
    return undefined
  }
}
