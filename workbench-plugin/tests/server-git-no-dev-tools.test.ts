// @vitest-environment node
/**
 * **新 Mac 上不弹「安装命令行开发者工具」**(2026-09-30,止血第 5 条)。
 *
 * 引导每推进一个阶段、下班例程每晚,都要在她的工作目录里 `git add/commit`。
 * 那台电脑上要是没装开发者工具,每一次调用都弹一个系统对话框问要不要装 ——
 * 她不是开发者,不该被问;点了「不装」之后那一步还只是静默失败。
 *
 * 这一份钉的是两处调用方接上那道门之后的行为:
 * - 门过不去时**一次 git 都不调**(用例里的 git 执行器只要被调到就记一笔,断言是空的);
 * - 汇报里如实写着「没装开发者工具,这一步没存版本」,不假装提交过。
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createAuthorizationService } from '../src/server/authorization.ts'
import { DEV_TOOLS_MISSING_NOTE, forgetDeveloperTools } from '../src/server/gitGate.ts'
import { createOnboardingService } from '../src/server/onboarding.ts'
import { FULL_PLAN } from '../src/server/onboardingStages.ts'
import { runEveningWrites } from '../src/server/routines.ts'
import type { WorkbenchState } from '../src/protocol.ts'

const dirs: string[] = []
beforeEach(() => { forgetDeveloperTools() })
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

describe('引导:没装开发者工具就不调 git', () => {
  it('推进一个阶段:文件照写照落盘,commit 那一格如实说「没装开发者工具」,git 一次都没调', async () => {
    const root = scratch('wb-onboarding-nodevtools-')
    const repo = join(root, 'repo')
    mkdirSync(join(repo, 'docs', '记忆'), { recursive: true })
    const calls: string[][] = []
    const service = createOnboardingService({
      plan: FULL_PLAN,
      file: join(root, 'onboarding.json'),
      repoRoot: repo,
      agentsFile: join(root, 'AGENTS.md'),
      authorization: createAuthorizationService({ file: join(repo, 'docs', '记忆', '授权.md') }),
      git: async (args) => { calls.push(args); return '' },
      // 这台电脑上有 .git,但没装开发者工具。
      gitReady: async () => ({ ok: false, note: DEV_TOOLS_MISSING_NOTE }),
    })
    await service.load()
    const result = await service.answer({ stage: 'opening', key: 'nickname', value: '阿本' })
    if (!result.ok) throw new Error(`推进失败:${result.error}`)
    expect(result.commit).toMatchObject({ ok: false, error: DEV_TOOLS_MISSING_NOTE })
    expect(calls).toEqual([])
  })
})

describe('下班例程:没装开发者工具就不调 git', () => {
  function emptyState(): WorkbenchState {
    return { projects: [], sessions: [], quotas: [] } as unknown as WorkbenchState
  }

  it('记忆照写,汇报里如实说「没装开发者工具,这一步没存版本」,git 一次都没调', async () => {
    const repo = scratch('wb-evening-nodevtools-')
    mkdirSync(join(repo, 'docs', '记忆', '项目'), { recursive: true })
    const calls: string[][] = []
    const written = await runEveningWrites({
      repo,
      date: '2026-09-30',
      startedMs: Date.parse('2026-09-30T18:30:00'),
      state: emptyState(),
      git: async (args) => { calls.push([...args]); return { ok: true, stdout: '' } },
      gitReady: async () => ({ ok: false, note: DEV_TOOLS_MISSING_NOTE }),
    })
    expect(calls).toEqual([])
    expect(written.commit).toBeUndefined()
    expect(written.push).toBe('nothing')
    expect(written.summary).toContain(DEV_TOOLS_MISSING_NOTE)
    // 记忆索引这一步照跑(它只是写文件),不因为没有 git 就整条例程失败。
    expect(written.index === true || written.index === false).toBe(true)
  })
})
