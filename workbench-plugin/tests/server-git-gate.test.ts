// @vitest-environment node
/**
 * 「调 git 之前先看一眼」(2026-09-30,止血第 5 条;排查-写死的地方 §五-1)。
 *
 * 新 Mac 上没装命令行开发者工具,任何一次 `git` 都会**弹一个系统对话框**问要不要装 ——
 * 引导每推进一个阶段弹一次、下班例程每晚弹一次。她没装开发者工具,也不该被问。
 *
 * 这一份钉的是那道门本身:
 * 1. 文件夹里没有 `.git` → 不调 git,如实回一句;
 * 2. `xcode-select -p` 失败(没装开发者工具)→ 不调 git,回「没装开发者工具,这一步没存版本」;
 * 3. 那一问**只问一次**(答案缓存住)—— 不然「先看一眼」自己就成了每次一个子进程;
 * 4. 两样都齐了才放行。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { DEV_TOOLS_MISSING_NOTE, createGitGate, forgetDeveloperTools } from '../src/server/gitGate.ts'

beforeEach(() => { forgetDeveloperTools() })

describe('调 git 之前那道门', () => {
  it('两样都齐:放行', async () => {
    const gate = createGitGate('/仓库', { exists: async () => true, developerTools: async () => true })
    expect(await gate()).toEqual({ ok: true })
  })

  it('文件夹里没有 .git:不调 git,如实说这一步没存版本', async () => {
    const asked: string[] = []
    const gate = createGitGate('/随便一个文件夹', {
      exists: async (path) => { asked.push(path); return false },
      developerTools: async () => true,
    })
    const result = await gate()
    expect(result.ok).toBe(false)
    expect(result.note).toContain('不是 git 仓库')
    expect(result.note).toContain('没存版本')
    expect(asked).toEqual(['/随便一个文件夹/.git'])
  })

  it('没装开发者工具:回那一句人话,而且**先问 .git 再问工具**都不会去 spawn git', async () => {
    const gate = createGitGate('/仓库', { exists: async () => true, developerTools: async () => false })
    expect(await gate()).toEqual({ ok: false, note: DEV_TOOLS_MISSING_NOTE })
    expect(DEV_TOOLS_MISSING_NOTE).toBe('没装开发者工具,这一步没存版本')
  })

  it('「装没装开发者工具」只问一次:答案缓存住,第二次不再起子进程', async () => {
    let asked = 0
    const gate = createGitGate('/仓库', {
      exists: async () => true,
      developerTools: async () => { asked += 1; return false },
    })
    await gate()
    await gate()
    const other = createGitGate('/另一个仓库', {
      exists: async () => true,
      developerTools: async () => { asked += 1; return false },
    })
    await other()
    expect(asked).toBe(1)
    // 清一下缓存(用例之间用),下一次才重新问。
    forgetDeveloperTools()
    await gate()
    expect(asked).toBe(2)
  })
})
