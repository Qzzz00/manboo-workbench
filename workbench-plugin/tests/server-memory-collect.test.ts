// @vitest-environment node
/**
 * 下班例程的「收 · 并 · 推」(2026-09-26,docs/设计-讨论结论都落进工作台记忆-2026-09-26.md)。
 *
 * 守住的几条:
 * - **收**:授权表 `read_client_files` 是「可以」才拷;不是就整步跳过并如实说哪一档;
 *   清单按**内容指纹**算 —— `已并入.md` 里记过的同一份同一个指纹下次不再列;
 * - **并**:清单进会话第一条消息(没有就明说没有),格式与「记在哪」写清楚;
 * - **索引每一行都链得到文件**:索引里有、文件缺的按模板建一份「待梳理」的档;
 * - **推**:配了 upstream 才 `git push`(不写死分支名);没配如实说「只存在这台电脑」;推失败把原因写进汇报、不抛、不改 status;
 * - **用户文件名不写死**:按 `docs/记忆/用户-*.md` 找。
 *
 * 全部用 mktemp 出来的临时仓库与**注入的 home**:一个字节都不碰真的 `~/Documents/工作台`、`~/.claude`、`~/.dsh`。
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ProjectsState, WorkbenchState } from '../src/protocol.ts'
import { collectAgentMemories, fingerprintOf, parseMergedLedger } from '../src/server/memoryCollect.ts'
import {
  defaultRoutineGit,
  eveningFirstMessage,
  findUserMemoryFile,
  readMemoryTexts,
  runEveningWrites,
} from '../src/server/routines.ts'
import { projectIndexRows } from '../src/server/routineMemory.ts'

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

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd: repo,
    stdio: 'pipe',
    env: { ...process.env, GIT_AUTHOR_DATE: INIT, GIT_COMMITTER_DATE: INIT, GIT_TERMINAL_PROMPT: '0' },
  }).toString()
}

/** 一个最小的「她的工作目录」:记忆目录 + 项目索引(两行,只有 A 有文件)。 */
function workRepo(options: { userFile?: string } = {}): string {
  const repo = tempDir('wb-collect-repo-')
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'user.name', 'test')
  git(repo, 'config', 'user.email', 'test@example.com')
  mkdirSync(join(repo, 'docs/记忆/项目'), { recursive: true })
  writeFileSync(join(repo, 'docs/记忆/项目/A.md'), '# A\n\n## 进展(倒序,一条一日期)\n- 2026-09-25:建档\n')
  writeFileSync(
    join(repo, 'docs/记忆/项目/索引.md'),
    '# 项目索引(快照 2026-09-25)\n\n| 项目 | 一句话 | 阶段 | 最近活动 | 路径 | 文件 |\n|---|---|---|---|---|---|\n'
    + '| A | 待梳理 | 待梳理 | 闲置 1 天 | `/x/A` | [项目/A.md](项目/A.md) |\n'
    + '| 老项目 | 待梳理 | 待梳理 | 闲置 9 天 | `/x/老` | [项目/老项目.md](项目/老项目.md) |\n',
  )
  writeFileSync(join(repo, `docs/记忆/${options.userFile ?? '用户-Ben.md'}`), '# 用户\n\n## 观察(事务官追加,倒序)\n- 2026-09-25 · 一次只问一个问题\n')
  writeFileSync(join(repo, 'docs/决策记录.md'), '# 决策记录\n\n## 2026-09-25 · x(已拍板)\n- y\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'init')
  return repo
}

/** 一个假的 HOME:只放 `.claude/projects/x/memory/a.md`。真的 ~/.claude 一个字节都不碰。 */
function fakeHome(body = '# a\n\n- 他喜欢一次只问一个问题\n'): string {
  const home = tempDir('wb-collect-home-')
  mkdirSync(join(home, '.claude/projects/x/memory'), { recursive: true })
  writeFileSync(join(home, '.claude/projects/x/memory/a.md'), body)
  return home
}

const PROJECTS: ProjectsState = {
  projects: [{
    id: 'p-a', name: 'A', stage: 'MVP 开发', path: '/x/A', links: [], session_count: 0, idle: false,
    signals: { branch: 'main', dirty_count: 0, worktrees: 0, cleanup_count: 0, idle_days: 0, recent_commits: 1 },
  }],
  pending: [],
  scan_errors: [],
  scanned_at: '',
}

function state(): WorkbenchState {
  return {
    agents: [], sessions: [], quota: {}, now: `${TODAY}T18:30:00.000Z`, stale: false,
    projects: PROJECTS,
    tasks: { tasks: [], sprints: [], modules: [], project_meta: [] },
  } as unknown as WorkbenchState
}

const CLAUDE_COPY = 'docs/记忆/来自-Claude/x/a.md'

describe('第 0 步「收」:授权门与「新增或变了」的清单', () => {
  it('授权「可以」:拷进 来自-Claude/,清单列出它(已并入.md 没有 → 全算新的)', async () => {
    const repo = workRepo()
    const home = fakeHome()
    const got = await collectAgentMemories({ repo, home, date: TODAY, clientFiles: async () => '可以' })
    expect(got.skipped).toBeUndefined()
    expect(got.copied).toBe(1)
    expect(got.fresh.map(one => one.rel)).toEqual([CLAUDE_COPY])
    expect(got.summary).toBe('从各家 AI 收了 1 份,待并 1 份')
    // 原样一个字节不动地落在仓库里。
    expect(await readFile(join(repo, CLAUDE_COPY), 'utf8')).toBe('# a\n\n- 他喜欢一次只问一个问题\n')
    // 原件没被动过(只读)。
    expect(await readFile(join(home, '.claude/projects/x/memory/a.md'), 'utf8')).toBe('# a\n\n- 他喜欢一次只问一个问题\n')
  })

  it('授权不是「可以」:一个字节都不拷,summary 说现在是哪一档', async () => {
    const repo = workRepo()
    const home = fakeHome()
    for (const status of ['要问', '不可以', '未答']) {
      const got = await collectAgentMemories({ repo, home, date: TODAY, clientFiles: async () => status })
      expect(got.skipped).toBe(`没收各家记忆:授权表里「读各家客户端文件」现在是「${status}」,不是「可以」`)
      expect(got.summary).toBe(got.skipped)
      expect(got.copied).toBe(0)
      expect(got.fresh).toEqual([])
      await expect(readFile(join(repo, CLAUDE_COPY), 'utf8')).rejects.toThrow()
    }
  })

  it('授权读不到(那一块没接上):按最保守的「未答」处理,不收', async () => {
    const repo = workRepo()
    const got = await collectAgentMemories({
      repo, home: fakeHome(), date: TODAY, clientFiles: async () => { throw new Error('没接授权') },
    })
    expect(got.skipped).toContain('「未答」')
    expect(got.copied).toBe(0)
  })

  it('没有新文件:各家都探不到 → copied 0,如实说没有可收的', async () => {
    const got = await collectAgentMemories({
      repo: workRepo(), home: tempDir('wb-collect-empty-home-'), date: TODAY, clientFiles: async () => '可以',
    })
    expect(got.copied).toBe(0)
    expect(got.fresh).toEqual([])
    expect(got.summary).toBe('各家 AI 在这台电脑上没有可收的记忆文件,没有待并的(都并过了)')
  })

  it('已并入.md 记过同一个指纹:下次不再列;内容变了又列出来(新指纹)', async () => {
    const repo = workRepo()
    const home = fakeHome()
    const first = await collectAgentMemories({ repo, home, date: TODAY, clientFiles: async () => '可以' })
    const one = first.fresh[0]!
    expect(one.fingerprint).toBe(fingerprintOf('# a\n\n- 他喜欢一次只问一个问题\n'))

    // 事务官并完写的那份台账(格式就是第一条消息里让它写的四列)。
    writeFileSync(
      join(repo, 'docs/记忆/来自-Claude/已并入.md'),
      '# 已并入\n\n| 文件 | 指纹 | 日期 | 并到哪 |\n|---|---|---|---|\n'
      + `| x/a.md | ${one.fingerprint} | ${TODAY} | 用户-Ben.md「观察」 |\n`,
    )
    const again = await collectAgentMemories({ repo, home, date: TODAY, clientFiles: async () => '可以' })
    expect(again.copied).toBe(1)
    expect(again.fresh).toEqual([])
    expect(again.summary).toBe('从各家 AI 收了 1 份,没有待并的(都并过了)')

    // 原件改了 → 指纹变了 → 又要并一次。
    writeFileSync(join(home, '.claude/projects/x/memory/a.md'), '# a\n\n- 他还说别一次开七张卡\n')
    const third = await collectAgentMemories({ repo, home, date: TODAY, clientFiles: async () => '可以' })
    expect(third.fresh.map(f => f.rel)).toEqual([CLAUDE_COPY])
    expect(third.fresh[0]!.fingerprint).not.toBe(one.fingerprint)
  })

  it('已并入.md 认得宽松:列序不同、只写文件名那一截、指纹带反引号都认;认不出的行忽略', () => {
    const ledger = parseMergedLedger([
      '# 已并入',
      '| 日期 | 指纹 | 文件 | 并到哪 |',
      '|---|---|---|---|',
      '| 2026-09-26 | `abcdef123456` | `a.md` | 用户文件 |',
      '| 2026-09-26 | 没有指纹 | b.md | — |',
      '随便一行字',
    ].join('\n'))
    expect(ledger.has('a.md\u0000abcdef123456')).toBe(true)
    expect(ledger.has('b.md\u0000没有指纹')).toBe(false)
  })
})

describe('第 0 步接进下班例程:拷来的文件跟第 7 步一起提交', () => {
  it('收来的 a.md 进了同一次 commit;收出错只丢一句,别的步骤照做', async () => {
    const repo = workRepo()
    const home = fakeHome()
    const written = await runEveningWrites({
      repo, date: TODAY, startedMs: Date.parse(`${TODAY}T18:30:00`), state: state(), git: defaultRoutineGit,
      collect: () => collectAgentMemories({ repo, home, date: TODAY, clientFiles: async () => '可以' }),
    })
    expect(written.collect?.fresh.map(f => f.rel)).toEqual([CLAUDE_COPY])
    expect(written.summary.startsWith('从各家 AI 收了 1 份,待并 1 份;')).toBe(true)
    expect(written.commit).toMatch(/^[0-9a-f]{7,}$/)
    // 拷来的那份在这一次 commit 里(COMMIT_PATHS 就是 docs/记忆),工作区干净。
    expect(git(repo, '-c', 'core.quotePath=false', 'show', '--name-only', '--format=', 'HEAD')).toContain(CLAUDE_COPY)
    expect(git(repo, 'status', '--porcelain')).toBe('')

    const boom = await runEveningWrites({
      repo, date: TODAY, startedMs: Date.parse(`${TODAY}T18:31:00`), state: state(), git: defaultRoutineGit,
      collect: async () => { throw new Error('各家目录读不动') },
    })
    expect(boom.summary.startsWith('收各家记忆出错:各家目录读不动;')).toBe(true)
    expect(boom.summary).toContain('布局快照已覆盖')
  })
})

describe('第 5 步的清单进会话第一条消息', () => {
  it('有清单:逐份列出文件与指纹,写清并到哪、怎么记已并入', () => {
    const text = eveningFirstMessage(TODAY, '做完了', {
      fresh: [{ rel: CLAUDE_COPY, fingerprint: 'abcdef123456' }],
      userFile: 'docs/记忆/用户-维护者.md',
    })
    expect(text).toContain(`- ${CLAUDE_COPY}(指纹 abcdef123456)`)
    expect(text).toContain('下面这 1 份')
    expect(text).toContain('| 文件 | 指纹 | 日期 | 并到哪 |')
    expect(text).toContain('docs/记忆/用户-维护者.md「观察」段')
    expect(text).toContain('今天从各家 AI 收了 N 份、并进 M 条')
  })

  it('没有清单:明说没有、这次跳过「并」;缺席与空数组一个字不差', () => {
    const none = eveningFirstMessage(TODAY, '做完了')
    expect(none).toBe(eveningFirstMessage(TODAY, '做完了', { fresh: [] }))
    expect(none).toContain('没有新增或变了的记忆')
    expect(none).toContain('docs/记忆/用户-Ben.md「观察」段')
  })
})

describe('C 项目索引:每一行都链得到文件', () => {
  it('索引里有、文件缺的按模板建一份「待梳理」的档;已有的一个字不动', async () => {
    const repo = workRepo()
    const before = await readFile(join(repo, 'docs/记忆/项目/A.md'), 'utf8')
    const written = await runEveningWrites({
      repo, date: TODAY, startedMs: Date.parse(`${TODAY}T18:30:00`), state: state(), git: defaultRoutineGit,
    })
    const old = await readFile(join(repo, 'docs/记忆/项目/老项目.md'), 'utf8')
    expect(old.startsWith('# 老项目\n')).toBe(true)
    expect(old).toContain('- **路径**:`/x/老`')
    expect(old).toContain(`- ${TODAY}:建档`)
    expect(written.created).toContain('老项目')
    // A 只多了今天那一条进展,旧行都还在。
    const a = await readFile(join(repo, 'docs/记忆/项目/A.md'), 'utf8')
    for (const line of before.split('\n')) expect(a).toContain(line)

    // 索引每一行的链接都指到一个真存在的文件。
    const index = await readFile(join(repo, 'docs/记忆/项目/索引.md'), 'utf8')
    for (const row of projectIndexRows(index)) {
      expect(row.link, row.name).toBeDefined()
      await expect(readFile(join(repo, 'docs/记忆', row.link!), 'utf8')).resolves.toContain('#')
    }
  })

  it('索引表格行读得出名字、链接与路径;表头与分隔行不算', () => {
    expect(projectIndexRows('# x\n\n| 项目 | 一句话 | 阶段 | 最近活动 | 路径 | 文件 |\n|---|---|---|---|---|---|\n| A | 待梳理 | 待梳理 | 今天在动 | `/x/A` | [项目/A.md](项目/A.md) |\n| B | 待梳理 | 待梳理 | 闲置 1 天 | 待梳理 | [项目/B.md](项目/B.md) |\n'))
      .toEqual([{ name: 'A', link: '项目/A.md', path: '/x/A' }, { name: 'B', link: '项目/B.md' }])
  })
})

describe('D 第 7 步 commit 之后由代码推', () => {
  /** 本地 bare 仓库当远端,克隆出来的工作目录本地 main 跟踪远端别名分支 —— 直接 `git push` 就该对。 */
  function withRemote(): { repo: string, bare: string } {
    const bare = tempDir('wb-collect-bare-')
    execFileSync('git', ['init', '-q', '--bare', bare], { stdio: 'pipe' })
    const repo = workRepo()
    git(repo, 'remote', 'add', 'origin', bare)
    git(repo, 'push', '-q', '-u', 'origin', 'main')
    return { repo, bare }
  }

  it('有远端:推成功,summary 说「已推到远端」,bare 仓库收到了这一笔', async () => {
    const { repo, bare } = withRemote()
    const written = await runEveningWrites({
      repo, date: TODAY, startedMs: Date.parse(`${TODAY}T18:30:00`), state: state(), git: defaultRoutineGit,
    })
    expect(written.commit).toBeDefined()
    expect(written.push).toBe('pushed')
    expect(written.summary).toContain('已推到远端')
    expect(execFileSync('git', ['log', '-1', '--format=%s', 'main'], { cwd: bare }).toString().trim())
      .toBe(`chore(记忆): 下班例程 ${TODAY}`)
  })

  it('没配远端:不推,summary 说只存在这台电脑', async () => {
    const written = await runEveningWrites({
      repo: workRepo(), date: TODAY, startedMs: Date.parse(`${TODAY}T18:30:00`), state: state(), git: defaultRoutineGit,
    })
    expect(written.push).toBe('no-upstream')
    expect(written.summary).toContain('没配远端,没推——记忆只存在这台电脑上')
  })

  it('推失败(远端没了):不抛、照样有 commit,原因进 summary', async () => {
    const { repo, bare } = withRemote()
    rmSync(bare, { recursive: true, force: true })
    const written = await runEveningWrites({
      repo, date: TODAY, startedMs: Date.parse(`${TODAY}T18:30:00`), state: state(), git: defaultRoutineGit,
    })
    expect(written.commit).toBeDefined()
    expect(written.push).toBe('failed')
    expect(written.summary).toContain('推不上去:')
    expect(written.summary.toLowerCase()).toMatch(/repository|not appear|does not/)
  })

  it('没有 commit(没改动)就没什么可推:summary 里没有推的那一句', async () => {
    const repo = workRepo()
    const args = { repo, date: TODAY, state: state(), git: defaultRoutineGit }
    await runEveningWrites({ ...args, startedMs: Date.parse(`${TODAY}T18:30:00`) })
    const again = await runEveningWrites({ ...args, startedMs: Date.parse(`${TODAY}T18:30:00`) })
    expect(again.commit).toBeUndefined()
    expect(again.push).toBe('nothing')
    expect(again.summary).toContain('没有需要提交的改动')
    expect(again.summary).not.toContain('推')
  })
})

describe('E 用户文件名不写死 用户-Ben.md', () => {
  it('只有一份 用户-维护者.md:找的是它,读的是它', async () => {
    const repo = workRepo({ userFile: '用户-维护者.md' })
    expect(await findUserMemoryFile(repo)).toBe('docs/记忆/用户-维护者.md')
    expect((await readMemoryTexts(repo)).user).toContain('一次只问一个问题')
  })

  it('一份都没有:降级成没有(不编一份)', async () => {
    const repo = workRepo()
    rmSync(join(repo, 'docs/记忆/用户-Ben.md'))
    expect(await findUserMemoryFile(repo)).toBeUndefined()
    expect((await readMemoryTexts(repo)).user).toBeUndefined()
  })

  it('有好几份:优先老名字 用户-Ben.md,同一个仓库每次算出同一份', async () => {
    const repo = workRepo({ userFile: '用户-维护者.md' })
    writeFileSync(join(repo, 'docs/记忆/用户-Ben.md'), '# 用户:Ben\n')
    expect(await findUserMemoryFile(repo)).toBe('docs/记忆/用户-Ben.md')
    expect(await findUserMemoryFile(repo)).toBe('docs/记忆/用户-Ben.md')
  })
})
