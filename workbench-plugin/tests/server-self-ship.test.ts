// @vitest-environment node
/**
 * 「改工作台自己」那条闭环的八步(2026-09-23,断点 C)。
 *
 * ## 这一份里什么是真的、什么是假的
 *
 * - **git 是真跑的**:`mkdtemp` 出来一个仓库,真 `git init`、真提交、真开分支、
 *   真 `git merge --ff-only`。合并冲突那一条要是拿假的 git 去演,演的就是我们
 *   以为的 git 行为,而不是 git 的行为;
 * - **发版脚本与 `/update/apply` 全是假的**。那两下一个会往公网 rsync 产物、
 *   一个会把这台机器上跑着的工作台换掉 —— 用例里**一次都没有真跑过**;
 * - `npm version` 与 `pnpm typecheck/vitest` 也是假的(前者只改一行 JSON,
 *   后者在临时仓库里根本没有可跑的东西)。
 *
 * ## 钉的性质
 *
 * 1. 八步按顺序跑完,版本号、发版记录、决策记录、进化日志四样都真落了盘;
 * 2. **记录在热更新之前、热更新按下就回**(2026-09-23 接线时定的顺序,见 selfShip.ts 文件头);
 * 3. **三种失败各自停在该停的那一步**:测试红(②)、合并冲突(③)、发版失败(⑥);
 *    外加更新作业起不来(⑧);
 * 4. **硬边界在合并之前**:分支上改了 `deploy/` 时停在第 ① 步,main **一笔都没动**;
 * 5. **不自动重试**:失败那条命令只跑过一次,后面那几步一条都没发出去。
 */
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { DECISION_RECORD_REL } from '../src/protocol.ts'
import type { RunCommand } from '../src/server/featureResult.ts'
import type { SelfShipDeps, SelfShipInput } from '../src/server/selfShip.ts'
import { APPLY_TRIGGERED_NOTE, prepareSelfBranch, runSelfShip } from '../src/server/selfShip.ts'
import {
  EVOLUTION_CONFIRMED, EVOLUTION_LOG_REL, EVOLUTION_PENDING, PUBLISH_SCRIPT_REL, RELEASE_LOG_REL,
  SELF_PACKAGE_REL, bumpPatch, versionOfPackageJson,
} from '../src/server/selfUpdate.ts'

const execFileAsync = promisify(execFile)
const dirs: string[] = []

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

const RELEASE_LOG = [
  '# 发版记录',
  '',
  '一版一行:版本、日期、你会看到什么、交接文档。',
  '',
  '| 版本 | 日期 | 你会看到什么 | 交接 |',
  '|---|---|---|---|',
  '| 0.2.64 | 09-23 | 老的那一版 | 交接-0922.md |',
  '',
].join('\n')

async function git(args: readonly string[], cwd: string): Promise<void> {
  await execFileAsync('git', args as string[], { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
}

/**
 * 一个长得像工作台仓库的临时仓库:main 上有发版脚本、插件 package.json、发版记录。
 * `branchFiles` 是要在分支上改的那几个文件。
 */
async function tempRepo(branchFiles: Readonly<Record<string, string>>): Promise<{ repo: string, branch: string }> {
  const repo = mkdtempSync(join(tmpdir(), 'wb-self-ship-'))
  dirs.push(repo)
  const put = (rel: string, text: string): void => {
    mkdirSync(join(repo, rel, '..'), { recursive: true })
    writeFileSync(join(repo, rel), text, 'utf8')
  }
  await git(['init', '-b', 'main'], repo)
  await git(['config', 'user.email', 'test@example.com'], repo)
  await git(['config', 'user.name', '用例'], repo)
  put(PUBLISH_SCRIPT_REL, '#!/usr/bin/env bash\necho 这一份用例里永远不会真跑\n')
  put(SELF_PACKAGE_REL, `${JSON.stringify({ name: '@ben/dsh-workbench', version: '0.2.64' }, null, 2)}\n`)
  put(RELEASE_LOG_REL, RELEASE_LOG)
  put('workbench-plugin/src/keep.ts', 'export const keep = 1\n')
  await git(['add', '-A'], repo)
  await git(['commit', '-m', '起点'], repo)

  const branch = 'feat/时钟大一号'
  await git(['checkout', '-b', branch], repo)
  for (const [rel, text] of Object.entries(branchFiles)) put(rel, text)
  await git(['add', '-A'], repo)
  await git(['commit', '-m', '分支上的一笔'], repo)
  await git(['checkout', 'main'], repo)
  return { repo, branch }
}

interface Harness {
  deps: SelfShipDeps
  /** 发过去的每一条命令(`cmd args @ cwd`)。「不重试」那一条数的就是它。 */
  calls: string[]
  /** 发版脚本被真调过几次。**期望值永远是 0 或 1**,而且它是假的。 */
  published: { withArg: string, notes: string }[]
  /** `/update/apply` 被调过几次。同上。 */
  applied: number
}

function harness(repo: string, over: {
  /** 哪条测试命令要红(`pnpm typecheck` 这种)。 */
  redTest?: string
  publishCode?: number
  applyOk?: boolean
} = {}): Harness {
  const calls: string[] = []
  const published: { withArg: string, notes: string }[] = []
  let applied = 0
  let clock = Date.parse('2026-09-23T10:00:00Z')

  const run: RunCommand = async (input) => {
    const key = [input.cmd, ...input.args].join(' ')
    calls.push(`${key} @ ${input.cwd}`)
    if (over.redTest !== undefined && key === over.redTest) {
      return { code: 1, out: 'FAIL tests/x.test.ts\n  1 failed | 2 passed' }
    }
    // pnpm 那几条在临时仓库里没有可跑的东西 —— 假装绿。
    if (input.cmd === 'pnpm') return { code: 0, out: 'ok' }
    // npm version:只把 package.json 里那一行改掉(不真跑 npm)。
    if (input.cmd === 'npm' && input.args[0] === 'version') {
      const path = join(repo, SELF_PACKAGE_REL)
      const before = readFileSync(path, 'utf8')
      const next = bumpPatch(versionOfPackageJson(before) as string) as string
      writeFileSync(path, before.replace(/"version": "[^"]+"/, `"version": "${next}"`), 'utf8')
      return { code: 0, out: `v${next}` }
    }
    // push:临时仓库没有远端,假装推上去了(真 push 会去碰网)。
    if (input.cmd === 'git' && input.args[0] === 'push') return { code: 0, out: '' }
    try {
      const { stdout, stderr } = await execFileAsync(input.cmd, input.args as string[], {
        cwd: input.cwd,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      })
      return { code: 0, out: `${stdout}${stderr}` }
    }
    catch (error) {
      const one = error as { code?: number, stdout?: string, stderr?: string }
      return { code: typeof one.code === 'number' ? one.code : 1, out: `${one.stdout ?? ''}${one.stderr ?? ''}` }
    }
  }

  return {
    calls,
    published,
    get applied() { return applied },
    deps: {
      run,
      readText: path => readFile(path, 'utf8').catch(() => undefined),
      writeText: (path, text) => writeFile(path, text, 'utf8'),
      publish: async (input) => {
        published.push({ withArg: input.withArg, notes: input.notes })
        return over.publishCode === undefined || over.publishCode === 0
          ? { code: 0, out: '发好了(假的)' }
          : { code: over.publishCode, out: 'rsync: connection refused' }
      },
      /**
       * `/update/apply`。**回的只是"这条更新作业起来了没有"** —— 真那一下会把跑着
       * 这条请求的进程换掉并重启,所以这里没有"等版本号变"这回事(见 selfShip.ts 文件头)。
       */
      applyUpdate: async () => {
        applied += 1
        return over.applyOk === false ? { ok: false, note: '更新作业起不来(假的)' } : { ok: true }
      },
      now: () => { clock += 1000; return new Date(clock) },
      home: '/Users/nobody',
    },
  } as Harness
}

function inputFor(repo: string, branch: string, featureDir: string): SelfShipInput {
  return {
    projectPath: repo,
    // 用例里不真开 worktree:测试那一步的 cwd 是 `<worktree>/<包>`,而假执行器不看它在不在。
    worktree: repo,
    branch,
    name: '时钟大一号',
    featureDir,
    notes: '座机页的时钟大了一号',
    handoff: '交接-0923-事务官改自己闭环.md',
    sessionId: 'sess-1',
  }
}

describe('八步跑完', () => {
  it('版本号、发版记录、决策记录、进化日志四样都真落了盘', async () => {
    const { repo, branch } = await tempRepo({ 'workbench-plugin/src/clock.ts': 'export const px = 20\n' })
    const bag = harness(repo)
    const result = await runSelfShip(inputFor(repo, branch, join(repo, 'docs/需求/时钟大一号')), bag.deps)

    expect(result.ok).toBe(true)
    expect(result.stopped_at).toBeUndefined()
    expect(result.version).toBe('0.2.65')
    expect(result.previous_version).toBe('0.2.64')
    expect(result.steps.map(one => one.status)).toEqual(Array.from({ length: 8 }, () => 'ok'))
    // ★ **顺序**:record 在 apply 前面。反过来的话热更新会把这个进程换掉,记录就永远写不成。
    expect(result.steps.map(one => one.id)).toEqual([
      'guard', 'test', 'merge', 'version', 'commit', 'publish', 'record', 'apply',
    ])
    // ★ **不等**:回包那一句就是「已触发热更新,重启后见」。
    expect(result.note).toBe(APPLY_TRIGGERED_NOTE)

    // ④ 发版记录第 7 行
    const log = readFileSync(join(repo, RELEASE_LOG_REL), 'utf8').split('\n')
    expect(log[6]).toContain('| 0.2.65 |')
    expect(log[6]).toContain('座机页的时钟大了一号')
    expect(log[6]).toContain('交接-0923-事务官改自己闭环.md')
    expect(log[7]).toContain('0.2.64')

    // ⑥ 发版脚本:**假的**,而且只跑了一次,--with 是按改到的包算的
    expect(bag.published).toEqual([{ withArg: 'plugin', notes: '座机页的时钟大了一号' }])
    expect(bag.applied).toBe(1)

    // ⑧ 决策记录 + 进化日志
    const decision = readFileSync(join(repo, DECISION_RECORD_REL), 'utf8')
    expect(decision).toContain('时钟大一号')
    expect(decision).toContain('- 谁做的:事务官(DSH 会话 sess-1)')
    const evolution = readFileSync(join(repo, EVOLUTION_LOG_REL), 'utf8')
    for (const field of ['哪天', '什么', '谁做的', '版本号', '状态', '怎么撤']) expect(evolution).toContain(`- ${field}:`)
    expect(evolution).toContain('0.2.65')
    // ★ 状态如实写「待重启确认」——这一刻还不知道生没生效,**不编一句「已生效」**。
    expect(evolution).toContain(`- 状态:${EVOLUTION_PENDING}`)
    expect(evolution).not.toContain(EVOLUTION_CONFIRMED)
  })

  it('★记录**在热更新之前**落盘:更新那一下发出去时,进化日志已经在那儿了', async () => {
    const { repo, branch } = await tempRepo({ 'workbench-plugin/src/clock.ts': 'export const px = 20\n' })
    const bag = harness(repo)
    /** 按下更新的那一刻,这两份文件在不在。 */
    let seen: { decision: boolean, evolution: boolean } | undefined
    const deps: SelfShipDeps = {
      ...bag.deps,
      applyUpdate: async () => {
        seen = {
          decision: existsSync(join(repo, DECISION_RECORD_REL)),
          evolution: existsSync(join(repo, EVOLUTION_LOG_REL)),
        }
        return await bag.deps.applyUpdate()
      },
    }
    const result = await runSelfShip(inputFor(repo, branch, join(repo, 'docs/需求/x')), deps)
    expect(result.ok).toBe(true)
    // 这就是这次改顺序要保住的那一条:更新把进程换掉之前,记录已经落了盘。
    expect(seen).toEqual({ decision: true, evolution: true })
  })

  it('★更新那一步**不问版本号、不等**:一条问版本的命令都没发出去', async () => {
    const { repo, branch } = await tempRepo({ 'workbench-plugin/src/clock.ts': 'export const px = 20\n' })
    const bag = harness(repo)
    const result = await runSelfShip(inputFor(repo, branch, join(repo, 'docs/需求/x')), bag.deps)
    expect(result.ok).toBe(true)
    // 「等版本号变」已经不在这条请求里了(它挪到了重启之后的收尾)。
    expect(bag.applied).toBe(1)
    expect(result.steps.find(one => one.id === 'apply')?.note).toContain(APPLY_TRIGGERED_NOTE)
  })

  it('提交真的落在 main 上,尾行按事实署名', async () => {
    const { repo, branch } = await tempRepo({ 'workbench-plugin/src/clock.ts': 'export const px = 20\n' })
    await runSelfShip(inputFor(repo, branch, join(repo, 'docs/需求/时钟大一号')), harness(repo).deps)
    const { stdout } = await execFileAsync('git', ['log', '-1', '--pretty=%B'], { cwd: repo })
    expect(stdout).toContain('release: 0.2.65')
    expect(stdout).toContain('Co-Authored-By: 事务官(DSH 会话 sess-1) <butler@dsh.local>')
  })

  it('改到 channel-worker 时,那一份的测试也跑、--with 也带上它', async () => {
    const { repo, branch } = await tempRepo({
      'workbench-plugin/src/clock.ts': 'export const px = 20\n',
      'channel-worker/src/tools.ts': 'export const x = 1\n',
    })
    const bag = harness(repo)
    const result = await runSelfShip(inputFor(repo, branch, join(repo, 'docs/需求/时钟大一号')), bag.deps)
    expect(result.ok).toBe(true)
    expect(bag.published[0]?.withArg).toBe('worker')
    expect(bag.calls).toContain(`pnpm vitest run @ ${repo}/channel-worker`)
    expect(bag.calls).toContain(`pnpm typecheck @ ${repo}/workbench-plugin`)
  })

  it('`记录.md` 已经写好时,决策记录那四行用它的(不用兜底那一份)', async () => {
    const { repo, branch } = await tempRepo({ 'workbench-plugin/src/clock.ts': 'export const px = 20\n' })
    const featureDir = join(repo, 'docs/需求/时钟大一号')
    mkdirSync(featureDir, { recursive: true })
    writeFileSync(join(featureDir, '记录.md'), [
      '- 需求:把时钟调大',
      '- 做了什么:改了一个字号',
      '- 谁做的:Codex 改的,事务官验的',
      '- 遗留:横屏那一处还没改',
    ].join('\n'), 'utf8')
    await runSelfShip(inputFor(repo, branch, featureDir), harness(repo).deps)
    const decision = readFileSync(join(repo, DECISION_RECORD_REL), 'utf8')
    expect(decision).toContain('- 遗留:横屏那一处还没改')
    expect(decision).not.toContain('遗留待补')
  })

  it('`记录.md` 还没有时兜底那一份**如实写「遗留待补」**,不编一句「无」', async () => {
    const { repo, branch } = await tempRepo({ 'workbench-plugin/src/clock.ts': 'export const px = 20\n' })
    await runSelfShip(inputFor(repo, branch, join(repo, 'docs/需求/时钟大一号')), harness(repo).deps)
    const decision = readFileSync(join(repo, DECISION_RECORD_REL), 'utf8')
    expect(decision).toContain('遗留待补')
    expect(decision).not.toContain('- 遗留:无')
  })
})

describe('每一步失败就停', () => {
  it('① 硬边界:分支上改了 deploy/ —— 停在第一步,main 一笔都没动', async () => {
    const { repo, branch } = await tempRepo({
      'workbench-plugin/src/clock.ts': 'export const px = 20\n',
      'deploy/publish-update.sh': '#!/usr/bin/env bash\necho 我被改了\n',
    })
    const before = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repo })).stdout.trim()
    const bag = harness(repo)
    const result = await runSelfShip(inputFor(repo, branch, join(repo, 'docs/需求/时钟大一号')), bag.deps)

    expect(result.ok).toBe(false)
    expect(result.stopped_at).toBe('guard')
    expect(result.note).toContain('deploy/publish-update.sh')
    expect(result.note).toContain('发版链本身')
    // main **一笔都没动**,而且后面那几步一条都没发出去。
    expect((await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repo })).stdout.trim()).toBe(before)
    expect(bag.published).toEqual([])
    expect(bag.applied).toBe(0)
    expect(bag.calls.filter(one => one.startsWith('pnpm'))).toEqual([])
    expect(bag.calls.filter(one => one.includes('git merge'))).toEqual([])
    expect(readFileSync(join(repo, SELF_PACKAGE_REL), 'utf8')).toContain('0.2.64')
  })

  it('① 硬边界:改了 docs/交接-* 也停;docs/发版记录.md 是放行的那一份', async () => {
    const { repo, branch } = await tempRepo({
      'workbench-plugin/src/clock.ts': 'export const px = 20\n',
      'docs/交接-0923-我不该改这个.md': '# 我改了历史\n',
    })
    const result = await runSelfShip(inputFor(repo, branch, join(repo, 'docs/需求/x')), harness(repo).deps)
    expect(result.stopped_at).toBe('guard')
    expect(result.note).toContain('docs/交接-')
  })

  it('② 测试红 —— 停在测试,**不重试**,合并那一条没发出去', async () => {
    const { repo, branch } = await tempRepo({ 'workbench-plugin/src/clock.ts': 'export const px = 20\n' })
    const bag = harness(repo, { redTest: 'pnpm vitest run' })
    const result = await runSelfShip(inputFor(repo, branch, join(repo, 'docs/需求/x')), bag.deps)

    expect(result.ok).toBe(false)
    expect(result.stopped_at).toBe('test')
    expect(result.note).toContain('1 failed')
    // **一次都不重试**:那条红了的命令只发过一次。
    expect(bag.calls.filter(one => one.startsWith('pnpm vitest run'))).toHaveLength(1)
    expect(bag.calls.filter(one => one.includes('git merge'))).toEqual([])
    expect(bag.published).toEqual([])
  })

  it('③ 快进不动(main 上有分支没有的提交)—— **停下叫人**,不替她 rebase', async () => {
    const { repo, branch } = await tempRepo({ 'workbench-plugin/src/clock.ts': 'export const px = 20\n' })
    // main 上再落一笔:这下分支快进不过来了。
    writeFileSync(join(repo, 'workbench-plugin/src/keep.ts'), 'export const keep = 2\n', 'utf8')
    await git(['add', '-A'], repo)
    await git(['commit', '-m', 'main 上又来一笔'], repo)

    const bag = harness(repo)
    const result = await runSelfShip(inputFor(repo, branch, join(repo, 'docs/需求/x')), bag.deps)
    expect(result.ok).toBe(false)
    expect(result.stopped_at).toBe('merge')
    expect(result.note).toContain('快进不到 main')
    expect(result.note).toContain('没有替你 rebase')
    // 一次 rebase / merge --no-ff 都没发出去。
    expect(bag.calls.filter(one => one.includes('rebase'))).toEqual([])
    expect(bag.calls.filter(one => one.includes('git merge'))).toHaveLength(1)
    expect(bag.published).toEqual([])
    expect(readFileSync(join(repo, SELF_PACKAGE_REL), 'utf8')).toContain('0.2.64')
  })

  it('⑥ 发版失败 —— 停在发版,**不再点一次**,热更新那一下没发生', async () => {
    const { repo, branch } = await tempRepo({ 'workbench-plugin/src/clock.ts': 'export const px = 20\n' })
    const bag = harness(repo, { publishCode: 12 })
    const result = await runSelfShip(inputFor(repo, branch, join(repo, 'docs/需求/x')), bag.deps)
    expect(result.ok).toBe(false)
    expect(result.stopped_at).toBe('publish')
    expect(result.note).toContain('connection refused')
    expect(result.version).toBe('0.2.65')
    expect(bag.published).toHaveLength(1)
    expect(bag.applied).toBe(0)
    // 前五步是真跑过的:main 上有那一笔了。
    expect(readFileSync(join(repo, RELEASE_LOG_REL), 'utf8')).toContain('0.2.65')
  })

  it('⑧ 更新作业起不来 —— 停在 apply,但**记录已经落了盘**(那才是重点)', async () => {
    const { repo, branch } = await tempRepo({ 'workbench-plugin/src/clock.ts': 'export const px = 20\n' })
    const bag = harness(repo, { applyOk: false })
    const result = await runSelfShip(inputFor(repo, branch, join(repo, 'docs/需求/x')), bag.deps)
    expect(result.ok).toBe(false)
    expect(result.stopped_at).toBe('apply')
    expect(result.note).toContain('更新作业起不来(假的)')
    expect(result.note).toContain('0.2.65 已经发出去了')
    // **只按了一次**「更新」(不重试)。
    expect(bag.applied).toBe(1)
    // 这一版发出去了、也记下来了,只是这台电脑还没换 —— 日志里那一条如实标着待确认。
    expect(readFileSync(join(repo, EVOLUTION_LOG_REL), 'utf8')).toContain(`- 状态:${EVOLUTION_PENDING}`)
    expect(readFileSync(join(repo, DECISION_RECORD_REL), 'utf8')).toContain('时钟大一号')
  })

  it('分支相对 main 一个文件都没改 —— 没有可发的东西,停在第一步', async () => {
    const { repo } = await tempRepo({ 'workbench-plugin/src/clock.ts': 'export const px = 20\n' })
    const bag = harness(repo)
    const result = await runSelfShip({
      ...inputFor(repo, 'main', join(repo, 'docs/需求/x')),
      branch: 'main',
    }, bag.deps)
    expect(result.stopped_at).toBe('guard')
    expect(result.note).toContain('一个文件都没改')
  })
})

describe('派活之前先开分支', () => {
  it('真开一条 worktree;再开一次当成功回(created:false)', async () => {
    const { repo } = await tempRepo({ 'workbench-plugin/src/clock.ts': 'export const px = 20\n' })
    const bag = harness(repo)
    const worktree = join(repo, '.claude/worktrees/新需求')
    const first = await prepareSelfBranch({ run: bag.deps.run }, { projectPath: repo, branch: 'feat/新需求', worktree })
    expect(first.ok).toBe(true)
    expect(first.created).toBe(true)
    expect(existsSync(join(worktree, 'workbench-plugin/src/keep.ts'))).toBe(true)

    const again = await prepareSelfBranch({ run: bag.deps.run }, { projectPath: repo, branch: 'feat/新需求', worktree })
    expect(again.ok).toBe(true)
    expect(again.created).toBe(false)
  })

  it('不是 git 仓库时如实说一句', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-not-a-repo-'))
    dirs.push(dir)
    const bag = harness(dir)
    const result = await prepareSelfBranch({ run: bag.deps.run }, {
      projectPath: dir,
      branch: 'feat/x',
      worktree: join(dir, '.claude/worktrees/x'),
    })
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('git worktree')
  })
})
