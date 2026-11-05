// @vitest-environment node
/**
 * 记忆的**收尾检查**(2026-09-27,并入闭环那张卡)。
 *
 * 复的是 09-26 20:49 真实那一幕:代码收了、提交了、推了;事务官逐份并到中途会话没了 ——
 * 台账只写了两行、并好的文件一行没提交。守住的几条:
 *
 * - **收尾由代码兜底**:记忆路径下有没提交的改动、且最近 10 分钟没人再动文件 → 一次 commit(+ 配了远端就推);
 * - **进度看得见**:每一家 `来源.md` 顶上那一块说得出「已并 2 / 共 5 份,还差 3 份」,用人话、不出现指纹;
 * - **状态块扛得住下一次收**:`importAgentMemories` 整篇重写 `来源.md` 之后它还在;
 * - **接着做**:下一次的待并清单只剩没记过的那 3 份;
 * - **不产生空 commit**:没有改动、状态块也没变化时一个文件不写、一个 commit 不产;
 * - **`已并入.md` 不存在不建空文件**;
 * - **推失败不抛**;
 * - **开工汇报也收**(只收不并,清单留给晚上)。
 *
 * 全部用 mktemp 出来的临时仓库与**注入的 home**:一个字节都不碰真的 `~/Documents/工作台`、`~/.claude`、`~/.dsh`。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { WorkbenchState } from '../src/protocol.ts'
import { CLOSEOUT_COMMIT_MESSAGE, runMemoryCloseout } from '../src/server/memoryCloseout.ts'
import { collectAgentMemories } from '../src/server/memoryCollect.ts'
import { importAgentMemories } from '../src/server/agentMemory.ts'
import { createRoutinesService, defaultRoutineGit } from '../src/server/routines.ts'

const dirs: string[] = []
afterEach(() => {
  // 只删 mktemp 出来的那几个目录(记的就是它们自己的绝对路径)。
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

const TODAY = '2026-09-26'
const INIT = '2026-09-25T09:00:00'
/** 收那一刻(真时钟无关,注入的)。状态块里「最近一次收」写的就是它。 */
const COLLECTED_AT = new Date(`${TODAY}T20:34:00`)
const CLAUDE_DIR = 'docs/记忆/来自-Claude'

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd: repo,
    stdio: 'pipe',
    env: { ...process.env, GIT_AUTHOR_DATE: INIT, GIT_COMMITTER_DATE: INIT, GIT_TERMINAL_PROMPT: '0' },
  }).toString()
}

function gitLog(repo: string): string[] {
  return execFileSync('git', ['log', '--format=%s'], { cwd: repo }).toString().trim().split('\n')
}

/** 一个最小的「她的工作目录」。 */
function workRepo(): string {
  const repo = tempDir('wb-closeout-repo-')
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'user.name', 'test')
  git(repo, 'config', 'user.email', 'test@example.com')
  mkdirSync(join(repo, 'docs/记忆/项目'), { recursive: true })
  writeFileSync(join(repo, 'docs/记忆/用户-Ben.md'), '# 用户:Ben\n\n## 观察(事务官追加,倒序)\n- 2026-09-25 · 一次只问一个问题\n')
  writeFileSync(join(repo, 'docs/记忆/项目/A.md'), '# A\n\n## 进展(倒序,一条一日期)\n- 2026-09-25:建档\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'init')
  return repo
}

/** 一个假的 HOME:`.claude/projects/x/memory/` 下 5 份。真的 ~/.claude 一个字节都不碰。 */
function fakeHome(names: readonly string[] = ['a', 'b', 'c', 'd', 'e']): string {
  const home = tempDir('wb-closeout-home-')
  mkdirSync(join(home, '.claude/projects/x/memory'), { recursive: true })
  for (const name of names) writeFileSync(join(home, `.claude/projects/x/memory/${name}.md`), `# ${name}\n\n- 第 ${name} 条\n`)
  return home
}

/** 收一次(授权是「可以」),时刻钉在 COLLECTED_AT。 */
async function collect(repo: string, home: string): Promise<{ fresh: readonly { rel: string, fingerprint: string }[] }> {
  const result = await collectAgentMemories({
    repo,
    home,
    date: TODAY,
    clientFiles: async () => '可以',
    stampNow: () => COLLECTED_AT,
  })
  return result
}

/** 收来的那几份的相对路径(排序后)。 */
function claudeCopies(fresh: readonly { rel: string, fingerprint: string }[]): string[] {
  return fresh.map(one => one.rel).filter(rel => rel.startsWith(CLAUDE_DIR)).sort()
}

function sourceText(repo: string): string {
  return readFileSync(join(repo, CLAUDE_DIR, '来源.md'), 'utf8')
}

/**
 * 「模型并到中途死了」:台账写了 2 行、用户文件与项目文件各改了一处,**一笔都没提交**。
 * 台账格式就是它自己会写的那四列。
 */
function halfDone(repo: string, fresh: readonly { rel: string, fingerprint: string }[]): void {
  const two = fresh.filter(one => one.rel.startsWith(CLAUDE_DIR)).slice(0, 2)
  const rows = two.map(one => `| ${one.rel.slice(`${CLAUDE_DIR}/`.length)} | ${one.fingerprint} | ${TODAY} | 用户-Ben.md 观察 |`)
  writeFileSync(
    join(repo, CLAUDE_DIR, '已并入.md'),
    `# 已并入(事务官逐份记)\n\n| 文件 | 指纹 | 日期 | 并到哪 |\n|---|---|---|---|\n${rows.join('\n')}\n`,
  )
  const user = join(repo, 'docs/记忆/用户-Ben.md')
  writeFileSync(user, `${readFileSync(user, 'utf8')}- ${TODAY} · 他要的是闭环(依据:${two[0]?.rel})\n`)
  const project = join(repo, 'docs/记忆/项目/A.md')
  writeFileSync(project, `${readFileSync(project, 'utf8')}- ${TODAY}:并进来一条(依据:${two[1]?.rel})\n`)
}

/**
 * 静默期之后:**真时钟 + 11 分钟**。不能写成 2026-09-26 那天的某一刻 ——
 * 文件的 mtime 是真的现在,拿一个过去的「现在」去减,静默期永远算不出来。
 */
const LATER = (): number => Date.now() + 11 * 60_000

describe('A/B 收尾检查:模型并到中途死了,代码把尾收掉', () => {
  it('提交没写完的那几处、来源.md 说「已并 2 / 共 5 份,还差 3 份」、下一次清单只剩 3 份', async () => {
    const repo = workRepo()
    const home = fakeHome()

    // 第 0 步:收。5 份都进清单,拷来的跟第 7 步一起提交(这里手动提交,模拟下班例程那一笔)。
    const first = await collect(repo, home)
    expect(claudeCopies(first.fresh)).toHaveLength(5)
    git(repo, 'add', '-A')
    git(repo, 'commit', '-q', '-m', 'chore(记忆): 下班例程 2026-09-26')
    expect(git(repo, 'status', '--porcelain')).toBe('')

    // 模型并到第 2 份就断了:台账 2 行 + 两处合并,一笔没提交。
    halfDone(repo, first.fresh)
    expect(git(repo, 'status', '--porcelain')).not.toBe('')

    // 收尾检查:静默期过了 → 提交 + 刷进度。
    const closeout = await runMemoryCloseout({ repo, git: defaultRoutineGit, now: LATER })
    expect(closeout.commit).toMatch(/^[0-9a-f]{7,}$/)
    expect(closeout.waiting).toBe(false)
    // 这个仓库没配远端 → 如实说,不抛。
    expect(closeout.push).toBe('no-upstream')
    expect(gitLog(repo)[0]).toBe(CLOSEOUT_COMMIT_MESSAGE)
    expect(git(repo, 'status', '--porcelain')).toBe('')

    // 状态块:人话、不出现指纹、不出现英文键名。
    const source = sourceText(repo)
    expect(source).toContain('## 这一家到哪了(工作台自动写的)')
    // 头一回还没有状态块,「最近一次收」按 来源.md 的 mtime 兜一个(那一刻正是刚收完写下它的时刻);
    // 有了状态块之后就由收的那一步写死(下一个用例验的就是这条)。
    expect(source).toMatch(/- 最近一次收:\d{4}-\d{2}-\d{2} \d{2}:\d{2},拷了 5 份/)
    expect(source).toContain('- 并入进度:已并 2 / 共 5 份,还差 3 份')
    expect(source).toContain(`- 最近一次并入:${TODAY}`)
    const block = source.slice(source.indexOf('工作台状态块:开始'), source.indexOf('工作台状态块:结束'))
    for (const one of first.fresh) expect(block).not.toContain(one.fingerprint)
    expect(block).not.toMatch(/merged|total|copied|fingerprint/)
    // 标题仍在第一行(状态块顶在标题之后,不在文件最开头)。
    expect(source.startsWith('# 来自 Claude 的记忆')).toBe(true)

    // 下一次待并清单:只剩没记过的那 3 份。
    const second = await collect(repo, home)
    expect(claudeCopies(second.fresh)).toHaveLength(3)
  })

  it('状态块扛得住下一次「收」:importAgentMemories 整篇重写来源.md 之后它还在,时刻也跟着更新', async () => {
    const repo = workRepo()
    const home = fakeHome()
    const first = await collect(repo, home)
    halfDone(repo, first.fresh)
    await runMemoryCloseout({ repo, git: defaultRoutineGit, now: LATER })
    expect(sourceText(repo)).toContain('- 并入进度:已并 2 / 共 5 份,还差 3 份')

    // 各家那边多了一份 → 来源.md 那张表多一行 → 它被整篇重写。状态块要活下来。
    writeFileSync(join(home, '.claude/projects/x/memory/f.md'), '# f\n\n- 第 f 条\n')
    const again = await importAgentMemories({ home, repoRoot: repo, now: () => new Date(`${TODAY}T00:00:00Z`), stampNow: () => new Date(`${TODAY}T21:10:00`) })
    expect(again.written).toContain(`${CLAUDE_DIR}/来源.md`)
    const source = sourceText(repo)
    expect(source).toContain('- 并入进度:已并 2 / 共 5 份,还差 3 份')
    // 「最近一次收」那一行归收的那一步管:时刻与份数都换成这一次的。
    expect(source).toContain(`- 最近一次收:${TODAY} 21:10,拷了 6 份`)
    expect(source).toContain('| x/f.md |')
    // 只有一块,不是两块。
    expect(source.split('工作台状态块:开始')).toHaveLength(2)

    // 再收尾一次:总数变 6、还差 4;台账两行照旧。
    await runMemoryCloseout({ repo, git: defaultRoutineGit, now: LATER })
    expect(sourceText(repo)).toContain('- 并入进度:已并 2 / 共 6 份,还差 4 份')
    expect(sourceText(repo)).toContain(`- 最近一次收:${TODAY} 21:10,拷了 6 份`)
  })

  it('没有改动就不产生 commit:连跑两次,第二次一个文件不写、一笔不提交', async () => {
    const repo = workRepo()
    const home = fakeHome()
    const first = await collect(repo, home)
    halfDone(repo, first.fresh)
    const one = await runMemoryCloseout({ repo, git: defaultRoutineGit, now: LATER })
    expect(one.commit).toBeDefined()
    const head = gitLog(repo).length

    const two = await runMemoryCloseout({ repo, git: defaultRoutineGit, now: LATER })
    expect(two.commit).toBeUndefined()
    expect(two.refreshed).toEqual([])
    expect(two.waiting).toBe(false)
    expect(gitLog(repo)).toHaveLength(head)
    expect(git(repo, 'status', '--porcelain')).toBe('')

    const three = await runMemoryCloseout({ repo, git: defaultRoutineGit, now: LATER })
    expect(three.commit).toBeUndefined()
    expect(gitLog(repo)).toHaveLength(head)
  })

  it('刚刚还有人在写(静默期没到)就先不提交,等下一轮', async () => {
    const repo = workRepo()
    const home = fakeHome()
    const first = await collect(repo, home)
    halfDone(repo, first.fresh)
    // 文件刚写完,现在就是现在 → 10 分钟静默期没到。
    const held = await runMemoryCloseout({ repo, git: defaultRoutineGit })
    expect(held.waiting).toBe(true)
    expect(held.commit).toBeUndefined()
    expect(held.summary).toContain('等下一轮再提交')
    // 进度还是照刷 —— 那是给人看的,不用等谁。
    expect(sourceText(repo)).toContain('- 并入进度:已并 2 / 共 5 份,还差 3 份')
  })

  it('D:`已并入.md` 不存在时不建空文件,进度如实说「已并 0」', async () => {
    const repo = workRepo()
    const home = fakeHome()
    await collect(repo, home)
    await runMemoryCloseout({ repo, git: defaultRoutineGit, now: LATER })
    expect(existsSync(join(repo, CLAUDE_DIR, '已并入.md'))).toBe(false)
    expect(sourceText(repo)).toContain('- 并入进度:已并 0 / 共 5 份,还差 5 份')
    expect(sourceText(repo)).toContain('- 最近一次并入:还没有')
  })

  it('推失败不抛:如实回 failed + 原因,别的照做', async () => {
    const repo = workRepo()
    const home = fakeHome()
    const first = await collect(repo, home)
    halfDone(repo, first.fresh)
    // 假 git:只有 push 失败,别的透给真 git。
    const fake = async (args: readonly string[], cwd: string, env?: Readonly<Record<string, string>>) => {
      if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return { ok: true, stdout: 'origin/main\n' }
      if (args[0] === 'push') return { ok: false, stdout: '', stderr: 'fatal: 连不上 origin\n' }
      return defaultRoutineGit(args, cwd, env)
    }
    const closeout = await runMemoryCloseout({ repo, git: fake, now: LATER })
    expect(closeout.commit).toMatch(/^[0-9a-f]{7,}$/)
    expect(closeout.push).toBe('failed')
    expect(closeout.summary).toContain('推不上去:fatal: 连不上 origin')
  })

  it('还没收过各家记忆的仓库:什么也不写、不抛', async () => {
    const repo = workRepo()
    const closeout = await runMemoryCloseout({ repo, git: defaultRoutineGit, now: LATER })
    expect(closeout.progress).toEqual([])
    expect(closeout.refreshed).toEqual([])
    expect(closeout.commit).toBeUndefined()
    expect(closeout.summary).toContain('还没有收过各家记忆')
  })
})

describe('C 开工汇报也收(只收不并)', () => {
  const state = async (): Promise<WorkbenchState> => ({
    agents: [], sessions: [], quota: {}, now: new Date().toISOString(), stale: false,
  } as unknown as WorkbenchState)

  it('morning 开跑时收一次,清单不进早报、只记一句;例程开跑前先收尾一次', async () => {
    const repo = workRepo()
    const home = fakeHome()
    const dir = tempDir('wb-closeout-state-')
    const collects: string[] = []
    let closeouts = 0
    const routines = createRoutinesService({
      configFile: join(dir, 'routines.json'),
      stateFile: join(dir, 'routines-state.json'),
      defaultRepo: repo,
      skipRetryMs: 0,
      session: { open: async () => 'sess-1' },
      collectMemories: async input => {
        collects.push(input.date)
        return collectAgentMemories({ repo: input.repo, home, date: input.date, clientFiles: async () => '可以', stampNow: () => COLLECTED_AT })
      },
      closeoutMemories: async () => { closeouts++; return undefined },
    })
    await routines.load()
    routines.attach({ readState: state })

    const result = await routines.run('morning')
    if (!result.ok) throw new Error(result.reason)
    expect(collects).toHaveLength(1)
    expect(closeouts).toBe(1)
    expect(result.run.note).toContain('收各家记忆:从各家 AI 收了')
    expect(result.run.note).toContain('清单留给下班例程')
    // 只收不并:早报正文里没有那份清单。
    expect(result.run.report ?? '').not.toContain('来自-Claude')
    // 真拷到了。
    expect(existsSync(join(repo, CLAUDE_DIR, '来源.md'))).toBe(true)
  })

  it('授权不是「可以」:morning 如实说哪一档,一个字节不拷', async () => {
    const repo = workRepo()
    const home = fakeHome()
    const dir = tempDir('wb-closeout-state-')
    const routines = createRoutinesService({
      configFile: join(dir, 'routines.json'),
      stateFile: join(dir, 'routines-state.json'),
      defaultRepo: repo,
      skipRetryMs: 0,
      session: { open: async () => 'sess-1' },
      collectMemories: async input => collectAgentMemories({ repo: input.repo, home, date: input.date, clientFiles: async () => '要问' }),
    })
    await routines.load()
    routines.attach({ readState: state })
    const result = await routines.run('morning')
    if (!result.ok) throw new Error(result.reason)
    expect(result.run.note).toContain('现在是「要问」')
    expect(existsSync(join(repo, CLAUDE_DIR))).toBe(false)
  })
})
