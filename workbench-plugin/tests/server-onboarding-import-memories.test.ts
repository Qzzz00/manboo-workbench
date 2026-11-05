// @vitest-environment node
/**
 * 引导 ②′「已有项目」那一支多一问:各家 Agent 客户端里记的东西,要不要拷一份给事务官
 * (2026-09-21;Ben 09-18:「Agent 客户端里的记忆这件事,后面在引导里要加一条进去,
 * 在已有项目那里要加,就是要不要把记忆拷贝到事务官那」)。
 *
 * 守住的东西:
 * - **授权表里「读各家客户端文件」不是「可以」→ 一个字节都不拷**(2026-09-22 Ben 定的 C5),
 *   如实回一句现在是哪一档;
 * - 授权到位 + 答「可以」→ 真拷,拷完那一句**是数出来的**,并在 用户-<称呼>.md 里留下索引;
 * - 答「不要」→ 只记一行,一个文件都不写,而且从此 `answered` 里有它
 *   (通话模式的工人据此**不再问第二遍**);
 * - 这一档没接线(老接线 / 测试)→ 答案照记,但如实说一句「没拷」,不冒充拷好了;
 * - 拷这件事出错 → 说「没拷成」,不吞。
 *
 * 全部在临时目录里跑,不碰 ~/.dsh,也不碰真的 ~/.claude / ~/.codex。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createAuthorizationService } from '../src/server/authorization.ts'
import { importAgentMemories } from '../src/server/agentMemory.ts'
import type { OnboardingMemoryDeps, OnboardingService } from '../src/server/onboarding.ts'
import { createOnboardingService } from '../src/server/onboarding.ts'
import { FULL_PLAN, keyBriefs, stageDef } from '../src/server/onboardingStages.ts'

const dirs: string[] = []
afterEach(() => { while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) })

interface Fixture {
  home: string
  repo: string
  service: OnboardingService
  read: (relative: string) => string
  saved: () => { answers: Record<string, Record<string, unknown>>, memory_index?: string[] }
}

function fixture(options: { memories?: OnboardingMemoryDeps | false } = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'wb-onboarding-memories-'))
  dirs.push(root)
  const home = join(root, 'home')
  const repo = join(root, 'repo')
  mkdirSync(join(repo, 'docs', '记忆', '项目'), { recursive: true })
  mkdirSync(home, { recursive: true })
  execFileSync('git', ['init', '-q'], { cwd: repo })
  execFileSync('git', ['config', 'user.email', 't@e.com'], { cwd: repo })
  execFileSync('git', ['config', 'user.name', 't'], { cwd: repo })
  execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'init'], { cwd: repo })

  // 一台装了 Claude 与 Codex 的假机器。
  mkdirSync(join(home, '.claude', 'projects', '-x-KOUKOU', 'memory'), { recursive: true })
  writeFileSync(join(home, '.claude', 'projects', '-x-KOUKOU', 'memory', 'MEMORY.md'), '# 索引\n', 'utf8')
  mkdirSync(join(home, '.codex'), { recursive: true })
  writeFileSync(join(home, '.codex', 'AGENTS.md'), '# codex\n', 'utf8')

  const stateFile = join(root, 'onboarding.json')
  let tick = 0
  const service = createOnboardingService({
    plan: FULL_PLAN,
    file: stateFile,
    repoRoot: repo,
    agentsFile: join(root, 'AGENTS.md'),
    authorization: createAuthorizationService({ file: join(repo, 'docs', '记忆', '授权.md') }),
    now: () => new Date(Date.UTC(2026, 8, 21, 1, 0, tick++)),
    ...(options.memories === false
      ? {}
      : {
          memories: options.memories ?? {
            importAll: () => importAgentMemories({ home, repoRoot: repo, now: () => new Date('2026-09-21T01:00:00Z') }),
          },
        }),
  })
  return {
    home,
    repo,
    service,
    read: relative => readFileSync(join(repo, relative), 'utf8'),
    saved: () => JSON.parse(readFileSync(stateFile, 'utf8')) as never,
  }
}

async function ok(service: OnboardingService, stage: string, key: string, value: unknown) {
  const result = await service.answer({ stage, key, value })
  if (!result.ok) throw new Error(`answer ${stage}.${key} 失败:${result.error}`)
  return result
}

/** 走到 ②′「已有项目」那一支。 */
async function toProjects(service: OnboardingService): Promise<void> {
  await service.load()
  await ok(service, 'opening', 'nickname', '阿本')
  await ok(service, 'branch', 'mode', 'existing')
  await ok(service, 'template', 'template', 'product')
}

/** 他在这一段里答了「能读各家客户端里的文件」——2026-09-22 起这是拷记忆的前提。 */
async function allowClientFiles(service: OnboardingService): Promise<void> {
  await ok(service, 'projects', 'read_client_files', true)
}

describe('C5:授权表里「读各家客户端文件」那一项', () => {
  it('②′ 与 ③ 两段都答得了它,而且是三档(同 write_docs),不是是非题', () => {
    for (const brief of [keyBriefs('projects', 'existing'), keyBriefs('authorization', undefined)]) {
      const one = brief.find(key => key.name === 'read_client_files')
      expect(one?.kind).toBe('tri')
    }
  })

  it('③ 授权阶段的 goals 里有这一问,而且说的是人话(不出现 memory / 路径)', () => {
    const line = stageDef('authorization', undefined).goals.find(goal => goal.includes('Claude')) as string
    expect(line).toContain('只读')
    expect(line).not.toContain('memory')
    expect(line).not.toContain('~/.claude')
  })

  it('★不是「可以」就一个字节都不拷,而且如实说现在是哪一档', async () => {
    const f = fixture()
    await toProjects(f.service)
    // 一个字都没授权(默认「要问」)。
    const result = await ok(f.service, 'projects', 'import_memories', true)
    expect(result.ok && result.note).toContain('没拷')
    expect(result.ok && result.note).toContain('要问')
    expect(existsSync(join(f.repo, 'docs', '记忆', '来自-Claude'))).toBe(false)
    expect(existsSync(join(f.repo, 'docs', '记忆', '来自-Codex'))).toBe(false)
  })

  it('★答了「不可以」照样不拷(「要问」与「不可以」在代码里同样拦住 —— 问他的是对话,不是代码)', async () => {
    const f = fixture()
    await toProjects(f.service)
    await ok(f.service, 'projects', 'read_client_files', false)
    const result = await ok(f.service, 'projects', 'import_memories', true)
    expect(result.ok && result.note).toContain('不可以')
    expect(existsSync(join(f.repo, 'docs', '记忆', '来自-Codex'))).toBe(false)
  })

  it('答「可以」会写进 docs/记忆/授权.md 那张表', async () => {
    const f = fixture()
    await toProjects(f.service)
    await allowClientFiles(f.service)
    const table = f.read('docs/记忆/授权.md')
    expect(table).toContain('`read_client_files`')
    expect(table).toContain('读各家客户端文件')
    expect(table).toMatch(/read_client_files.*可以/)
  })
})

describe('②′ 的那一问本身', () => {
  it('「已有项目」这一支里有 import_memories 这一项,而且不是必答', () => {
    const brief = keyBriefs('projects', 'existing')
    const one = brief.find(key => key.name === 'import_memories')
    expect(one?.kind).toBe('bool')
    expect(one?.required).toBe(false)
  })

  it('「从零开始」那一支没有这一问(那台电脑上还没有项目可谈)', () => {
    expect(keyBriefs('projects', 'fresh').map(key => key.name)).not.toContain('import_memories')
  })

  it('goals 里那句话说的是人话:不出现 memory / 目录 / 路径这些词', () => {
    const line = stageDef('projects', 'existing').goals.find(goal => goal.includes('import_memories')) as string
    expect(line).toContain('Claude')
    expect(line).toContain('只读')
    expect(line).not.toContain('memory 目录')
    expect(line).not.toContain('~/.claude')
  })
})

describe('答「可以」', () => {
  it('真拷过来了,而且那一句是数出来的', async () => {
    const f = fixture()
    await toProjects(f.service)
    await allowClientFiles(f.service)
    const result = await ok(f.service, 'projects', 'import_memories', true)
    expect(f.read('docs/记忆/来自-Codex/AGENTS.md')).toBe('# codex\n')
    expect(f.read('docs/记忆/来自-Claude/-x-KOUKOU/MEMORY.md')).toBe('# 索引\n')
    expect(result.ok && result.note).toContain('Claude 1 份')
    expect(result.ok && result.note).toContain('Codex 1 份')
    // 这台假机器上没有 Kimi 的记忆 —— 那句话要说出来,不许含糊过去。
    expect(result.ok && result.note).toContain('Kimi')
  })

  it('用户-<称呼>.md 里多一段索引,指得到那几个目录', async () => {
    const f = fixture()
    await toProjects(f.service)
    await allowClientFiles(f.service)
    await ok(f.service, 'projects', 'import_memories', true)
    const user = f.read('docs/记忆/用户-阿本.md')
    expect(user).toContain('从别家拷过来的记忆')
    expect(user).toContain('docs/记忆/来自-Claude')
    expect(user).toContain('docs/记忆/来自-Codex')
  })

  it('`POST /onboarding/import-memories` 走的是同一条路,而且不看阶段(但照样过授权那道门)', async () => {
    const f = fixture()
    await toProjects(f.service)
    await allowClientFiles(f.service)
    const result = await f.service.importMemories()
    expect(result.ok).toBe(true)
    expect(f.read('docs/记忆/来自-Codex/AGENTS.md')).toBe('# codex\n')
    // 记成答过了:从此不再问第二遍。
    expect(f.saved().answers.projects?.import_memories).toBe(true)
  })

  it('★没授权时那颗按钮回 ok:false,**而且不把这一问记成答过了**(否则改了授权也不会再问)', async () => {
    const f = fixture()
    await f.service.load()
    const result = await f.service.importMemories()
    expect(result.ok).toBe(false)
    expect(result.note).toContain('没拷')
    expect(existsSync(join(f.repo, 'docs', '记忆', '来自-Codex'))).toBe(false)
    expect((await f.service.brief()).answered.projects ?? []).not.toContain('import_memories')
  })
})

describe('答「不要」', () => {
  it('一个文件都不写,并且记下来往后不再问', async () => {
    const f = fixture()
    await toProjects(f.service)
    const result = await ok(f.service, 'projects', 'import_memories', false)
    expect(result.ok && result.note).toContain('不再问')
    expect(existsSync(join(f.repo, 'docs', '记忆', '来自-Claude'))).toBe(false)
    expect(existsSync(join(f.repo, 'docs', '记忆', '来自-Codex'))).toBe(false)
    // 简报里的 answered 有它 —— 通话模式的工人据此不再问第二遍。
    expect(f.saved().answers.projects?.import_memories).toBe(false)
    expect(f.read('docs/记忆/用户-阿本.md')).not.toContain('从别家拷过来的记忆')
  })

  it('简报的 answered 里带着它', async () => {
    const f = fixture()
    await toProjects(f.service)
    await ok(f.service, 'projects', 'import_memories', false)
    expect((await f.service.brief()).answered.projects).toContain('import_memories')
  })
})

describe('接不上 / 拷不成的时候不编', () => {
  it('没接这一档:答案照记,但如实说「没拷」', async () => {
    const f = fixture({ memories: false })
    await toProjects(f.service)
    await allowClientFiles(f.service)
    const result = await ok(f.service, 'projects', 'import_memories', true)
    expect(result.ok && result.note).toContain('没拷')
    expect(existsSync(join(f.repo, 'docs', '记忆', '来自-Claude'))).toBe(false)
  })

  it('拷的时候出错:说「没拷成」,不吞,也不说成拷好了', async () => {
    const f = fixture({ memories: { importAll: () => Promise.reject(new Error('磁盘满了')) } })
    await toProjects(f.service)
    await allowClientFiles(f.service)
    const result = await ok(f.service, 'projects', 'import_memories', true)
    expect(result.ok && result.note).toContain('没拷成')
    expect(result.ok && result.note).toContain('磁盘满了')
  })
})
