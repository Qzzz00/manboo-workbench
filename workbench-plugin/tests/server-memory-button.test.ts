// @vitest-environment node
/**
 * 「把各家 Agent 的记忆拷给事务官」那颗按钮在**服务端**的那一半(2026-09-22)。
 *
 * 界面上那一颗按钮要做三件事,这里逐件钉住:
 *
 * 1. **先探一眼**:每家找到几份 —— Claude N 份、Codex 的 SQLite 看得见但不拷、
 *    Kimi 这台机器上未查到(0 份)。探这一下 **不过授权表的门**(它只 readdir/lstat,
 *    正文一个字节都不读),但回包里带着授权此刻是哪一档;
 * 2. **点「拷」之前查授权**:`read_client_files` 三档 —— 只有「可以」才真拷,
 *    「要问」「不可以」都拦住并回那句原话(Ben 2026-09-22 定的 C5);
 * 3. **可以重复点**:再点一次只补新的 —— 内容没变的一份都不重写,`written` 为空。
 *
 * 全部在 mktemp 出来的假 HOME / 假仓库里跑:不碰真的 `~/.claude` / `~/.codex` / `~/.dsh`。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { importAgentMemories, probeAgentMemories } from '../src/server/agentMemory.ts'
import { createAuthorizationService } from '../src/server/authorization.ts'
import type { OnboardingService } from '../src/server/onboarding.ts'
import { createOnboardingService } from '../src/server/onboarding.ts'
import { FULL_PLAN } from '../src/server/onboardingStages.ts'

const dirs: string[] = []
afterEach(() => { while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) })

interface Fixture { home: string, repo: string, service: OnboardingService }

/** 一台装了 Claude(2 份)与 Codex(1 份 md + 1 个 SQLite)、没有 Kimi 的假机器。 */
function fixture(options: { wired?: boolean } = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'wb-memory-button-'))
  dirs.push(root)
  const home = join(root, 'home')
  const repo = join(root, 'repo')
  mkdirSync(join(repo, 'docs', '记忆', '项目'), { recursive: true })
  mkdirSync(home, { recursive: true })
  execFileSync('git', ['init', '-q'], { cwd: repo })
  execFileSync('git', ['config', 'user.email', 't@e.com'], { cwd: repo })
  execFileSync('git', ['config', 'user.name', 't'], { cwd: repo })
  execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'init'], { cwd: repo })

  mkdirSync(join(home, '.claude', 'projects', '-x-KOUKOU', 'memory'), { recursive: true })
  writeFileSync(join(home, '.claude', 'projects', '-x-KOUKOU', 'memory', 'MEMORY.md'), '# 索引\n', 'utf8')
  writeFileSync(join(home, '.claude', 'projects', '-x-KOUKOU', 'memory', 'a.md'), '# a\n', 'utf8')
  mkdirSync(join(home, '.codex'), { recursive: true })
  writeFileSync(join(home, '.codex', 'AGENTS.md'), '# codex\n', 'utf8')
  writeFileSync(join(home, '.codex', 'memories_1.sqlite'), 'SQLite format 3', 'utf8')
  mkdirSync(join(home, '.dsh'), { recursive: true })
  writeFileSync(join(home, '.dsh', 'AGENTS.md'), '我叫小助。\n', 'utf8')

  const now = () => new Date('2026-09-22T01:00:00Z')
  let tick = 0
  const service = createOnboardingService({
    plan: FULL_PLAN,
    file: join(root, 'onboarding.json'),
    repoRoot: repo,
    agentsFile: join(root, 'AGENTS.md'),
    authorization: createAuthorizationService({ file: join(repo, 'docs', '记忆', '授权.md') }),
    now: () => new Date(Date.UTC(2026, 8, 22, 1, 0, tick++)),
    ...(options.wired === false
      ? {}
      : {
          memories: {
            importAll: () => importAgentMemories({ home, repoRoot: repo, now }),
            probeAll: async () => (await probeAgentMemories({ home, repoRoot: repo })).map(view => ({
              family: view.family,
              label: view.label,
              count: view.files.length,
              left: view.left,
              ...(view.skip === undefined ? {} : { skip: view.skip }),
            })),
          },
        }),
  })
  return { home, repo, service }
}

/** 授权表里那一项直接写成某一档(界面上那条路就是这样:不必走完引导)。 */
async function setClientFiles(f: Fixture, status: '可以' | '要问' | '不可以'): Promise<void> {
  const auth = createAuthorizationService({ file: join(f.repo, 'docs', '记忆', '授权.md') })
  await auth.set('read_client_files', status, '2026-09-22')
}

describe('先探一眼:每家找到几份', () => {
  it('Claude 数得出来、Codex 的 SQLite 进「没拷的」、Kimi 是 0 份(未查到)、工作台自己不拷', async () => {
    const f = fixture()
    await f.service.load()
    const probe = await f.service.probeMemories()

    expect(probe.wired).toBe(true)
    const byFamily = new Map(probe.families.map(one => [one.family, one]))
    expect(byFamily.get('claude')?.count).toBe(2)
    expect(byFamily.get('codex')?.count).toBe(1)
    // Kimi:这台机器上一份都没有 —— 界面照它写「未查到」,不是「0 份记忆」。
    expect(byFamily.get('kimi')?.count).toBe(0)
    expect(byFamily.get('kimi')?.skip).toBeUndefined()
    // 工作台自己那一份探得到但整家不拷,理由带得出来。
    expect(byFamily.get('dsh')?.skip).toContain('事务官自己')
    // 看见了没拷的那一样(SQLite)要说得出来,不闷声吞掉。
    expect(byFamily.get('codex')?.left.join('')).toContain('memories_1.sqlite')
  })

  it('★探这一下不过授权表的门(它只数,不读正文),但如实带回此刻是哪一档', async () => {
    const f = fixture()
    await f.service.load()
    // 一个字都没授权:默认「要问」。
    const probe = await f.service.probeMemories()
    expect(probe.status).toBe('要问')
    expect(probe.allowed).toBe(false)
    // 数照样数得出来 —— 他得先看见有几份,才谈得上决定要不要放开。
    expect(probe.families.find(one => one.family === 'claude')?.count).toBe(2)
    expect(probe.note).toContain('授权')
    // 而且**一个文件都没往仓库里写**。
    expect(existsSync(join(f.repo, 'docs', '记忆', '来自-Claude'))).toBe(false)
  })

  it('这台工作台没接这一档时如实说,不画一个空表冒充「一家都没有」', async () => {
    const f = fixture({ wired: false })
    await f.service.load()
    const probe = await f.service.probeMemories()
    expect(probe.wired).toBe(false)
    expect(probe.families).toEqual([])
    expect(probe.note).toContain('没接')
  })
})

describe('点「拷」之前查授权:三档', () => {
  it('「要问」(缺省)→ 一个字节都不拷,回那句原话', async () => {
    const f = fixture()
    await f.service.load()
    const result = await f.service.importMemories()
    expect(result.ok).toBe(false)
    expect(result.note).toContain('要问')
    expect(result.written).toEqual([])
    expect(existsSync(join(f.repo, 'docs', '记忆', '来自-Claude'))).toBe(false)
  })

  it('「不可以」→ 同样拦住', async () => {
    const f = fixture()
    await f.service.load()
    await setClientFiles(f, '不可以')
    const result = await f.service.importMemories()
    expect(result.ok).toBe(false)
    expect(result.note).toContain('不可以')
    expect(existsSync(join(f.repo, 'docs', '记忆', '来自-Codex'))).toBe(false)
  })

  it('「可以」→ 真拷,并且**说得出写了哪几份**', async () => {
    const f = fixture()
    await f.service.load()
    await setClientFiles(f, '可以')
    const result = await f.service.importMemories()

    expect(result.ok).toBe(true)
    expect(result.written).toContain('docs/记忆/来自-Claude/-x-KOUKOU/a.md')
    expect(result.written).toContain('docs/记忆/来自-Codex/AGENTS.md')
    // 每家一份「来源.md」,写清原件在哪。
    expect(result.written).toContain('docs/记忆/来自-Claude/来源.md')
    // 工作台自己那一份不拷 —— 目录都不该出现。
    expect(existsSync(join(f.repo, 'docs', '记忆', '来自-工作台'))).toBe(false)
    expect(result.note).toContain('Claude')
  })
})

describe('可以重复点:只补新的', () => {
  it('第二次点:内容没变就一份都不重写,而那句话照旧数得出拷过几份', async () => {
    const f = fixture()
    await f.service.load()
    await setClientFiles(f, '可以')
    const first = await f.service.importMemories()
    expect(first.written.length).toBeGreaterThan(0)
    expect(first.added.length).toBe(first.written.length)

    const again = await f.service.importMemories()
    expect(again.ok).toBe(true)
    expect(again.written).toEqual([])
    expect(again.added).toEqual([])
    // 「拷过来了:Claude 2 份…」这句话数的是**仓库里有几份**,不是这一趟写了几份。
    expect(again.note).toContain('Claude 2 份')
  })

  it('第二次点:源头多出来的那一份补上,只有它算新增', async () => {
    const f = fixture()
    await f.service.load()
    await setClientFiles(f, '可以')
    await f.service.importMemories()
    writeFileSync(join(f.home, '.claude', 'projects', '-x-KOUKOU', 'memory', 'b.md'), '# b\n', 'utf8')

    const again = await f.service.importMemories()
    expect(again.added).toEqual(['docs/记忆/来自-Claude/-x-KOUKOU/b.md'])
    // 「来源.md」那张表多了一行,所以它也被重写了 —— 但它不是「新增」。
    expect(again.written).toContain('docs/记忆/来自-Claude/来源.md')
    expect(again.written).not.toContain('docs/记忆/来自-Codex/AGENTS.md')
  })
})
