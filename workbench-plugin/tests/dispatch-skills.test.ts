// @vitest-environment node
/**
 * 派活带技能(2026-10-21,卡 S):把选中的技能目录拷进任务工作树,给命令行那只手读。
 *
 * 真 git 仓库、真拷文件;不起任何 Agent。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { dispatchChoices } from '../src/server/dispatchChoice.ts'
import type { DispatchTarget } from '../src/server/dispatchTargets.ts'
import {
  DISPATCH_SKILLS, SKILL_DIRS, SKILL_READER_FAMILIES, canReadSkills, checkSkillNames, findSkillsRoot, installSkills, skillsPromptLine,
} from '../src/server/dispatchSkills.ts'
import type { UserLayerSkill } from '../src/server/userLayer.ts'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wb-skills-'))
  dirs.push(dir)
  return dir
}

/** 一个假的技能库:两件,带 UPSTREAM.json 与一层子目录。 */
function fakeRoot(): string {
  const root = temp()
  for (const name of ['huashu-report', 'huashu-design']) {
    mkdirSync(join(root, name, 'references'), { recursive: true })
    writeFileSync(join(root, name, 'SKILL.md'), `---\nname: ${name}\n---\n正文`)
    writeFileSync(join(root, name, 'LICENSE'), 'MIT License\n')
    writeFileSync(join(root, name, 'references', 'a.md'), '参考')
    writeFileSync(join(root, name, 'UPSTREAM.json'), JSON.stringify({ name, commit: 'a'.repeat(40) }))
  }
  return root
}

function gitRepo(): string {
  const dir = temp()
  execFileSync('git', ['init', '-q'], { cwd: dir })
  return dir
}

function excludeOf(cwd: string): string {
  const path = execFileSync('git', ['rev-parse', '--git-path', 'info/exclude'], { cwd, encoding: 'utf8' }).trim()
  return readFileSync(isAbsolute(path) ? path : join(cwd, path), 'utf8')
}

describe('哪几家读得了技能', () => {
  it('Claude 读 .claude/skills,Codex 读 .agents/skills,Kimi 项目级技能目录也是 .agents/skills(2026-10-22 卡 C)', () => {
    expect(SKILL_DIRS.claude).toBe('.claude/skills')
    expect(SKILL_DIRS.codex).toBe('.agents/skills')
    expect(SKILL_DIRS.kimi).toBe('.agents/skills')
  })

  it('读得了的只有命令行那几家;窗口与接口那几家一律不算', () => {
    for (const family of SKILL_READER_FAMILIES) expect(['claude', 'codex', 'kimi']).toContain(family)
    expect(canReadSkills('claude')).toBe(true)
    expect(canReadSkills('kimi')).toBe(true)
    for (const family of ['doubao', 'gpt', 'manus', 'muse', 'dsh']) expect(canReadSkills(family)).toBe(false)
  })
})

describe('checkSkillNames', () => {
  it('不传 / 空表 = 没带技能', () => {
    expect(checkSkillNames(undefined)).toEqual({ ok: true, skills: [] })
    expect(checkSkillNames([])).toEqual({ ok: true, skills: [] })
  })

  it('认得的照收、去重', () => {
    expect(checkSkillNames(['huashu-report', ' huashu-report '])).toEqual({ ok: true, skills: ['huashu-report'] })
  })

  it('不是字符串数组 / 不认得的名字 → 明说', () => {
    const bad = checkSkillNames('huashu-report')
    expect(bad.ok).toBe(false)
    const unknown = checkSkillNames(['huashu-report', 'nope'])
    expect(unknown.ok).toBe(false)
    if (!unknown.ok) {
      expect(unknown.error).toContain('nope')
      for (const name of DISPATCH_SKILLS) expect(unknown.error).toContain(name)
    }
  })

  it('名字里带路径的一律不收(防拷出技能库)', () => {
    expect(checkSkillNames(['../etc']).ok).toBe(false)
    expect(checkSkillNames(['a/b']).ok).toBe(false)
  })
})

describe('installSkills', () => {
  it('Claude:拷进 .claude/skills/<名>/,写进 info/exclude', async () => {
    const root = fakeRoot()
    const cwd = gitRepo()
    const got = await installSkills({ family: 'claude', cwd, skills: ['huashu-report'], root })
    expect(got).toEqual({ ok: true, installed: ['huashu-report'], dir: '.claude/skills' })
    expect(readFileSync(join(cwd, '.claude/skills/huashu-report/SKILL.md'), 'utf8')).toContain('huashu-report')
    expect(existsSync(join(cwd, '.claude/skills/huashu-report/references/a.md'))).toBe(true)
    expect(existsSync(join(cwd, '.claude/skills/huashu-report/LICENSE'))).toBe(true)
    expect(existsSync(join(cwd, '.claude/skills/huashu-design'))).toBe(false)
    expect(excludeOf(cwd)).toContain('/.claude/skills/huashu-report/')
    // 不进她的提交:git 看不见它
    expect(execFileSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8' })).toBe('')
  })

  it('Codex:拷进 .agents/skills/<名>/', async () => {
    const root = fakeRoot()
    const cwd = gitRepo()
    const got = await installSkills({ family: 'codex', cwd, skills: ['huashu-report', 'huashu-design'], root })
    expect(got.ok).toBe(true)
    expect(existsSync(join(cwd, '.agents/skills/huashu-design/SKILL.md'))).toBe(true)
    expect(excludeOf(cwd)).toContain('/.agents/skills/huashu-design/')
  })

  it('git worktree 里:写进这个仓库的 info/exclude(工作树没有自己的 .git 目录)', async () => {
    const root = fakeRoot()
    const repo = gitRepo()
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'x'], { cwd: repo })
    const tree = join(temp(), 'tree')
    execFileSync('git', ['worktree', 'add', '-q', '-b', 'w', tree], { cwd: repo })
    const got = await installSkills({ family: 'claude', cwd: tree, skills: ['huashu-report'], root })
    expect(got.ok).toBe(true)
    expect(excludeOf(tree)).toContain('/.claude/skills/huashu-report/')
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: tree, encoding: 'utf8' })).toBe('')
  })

  it('再派一次:同一行不重复写,旧拷贝换成新的', async () => {
    const root = fakeRoot()
    const cwd = gitRepo()
    await installSkills({ family: 'claude', cwd, skills: ['huashu-report'], root })
    writeFileSync(join(cwd, '.claude/skills/huashu-report/多出来的.md'), 'x')
    const again = await installSkills({ family: 'claude', cwd, skills: ['huashu-report'], root })
    expect(again.ok).toBe(true)
    expect(existsSync(join(cwd, '.claude/skills/huashu-report/多出来的.md'))).toBe(false)
    expect(excludeOf(cwd).split('\n').filter(line => line === '/.claude/skills/huashu-report/')).toHaveLength(1)
  })

  it('工作区里已有同名、不是我们拷的技能目录 → 不覆盖、说清楚', async () => {
    const root = fakeRoot()
    const cwd = gitRepo()
    mkdirSync(join(cwd, '.claude/skills/huashu-report'), { recursive: true })
    writeFileSync(join(cwd, '.claude/skills/huashu-report/SKILL.md'), '她自己的')
    const got = await installSkills({ family: 'claude', cwd, skills: ['huashu-report'], root })
    expect(got.ok).toBe(false)
    if (!got.ok) expect(got.why).toContain('huashu-report')
    expect(readFileSync(join(cwd, '.claude/skills/huashu-report/SKILL.md'), 'utf8')).toBe('她自己的')
  })

  it('技能库里缺这一件 → 不派、说清楚', async () => {
    const root = temp()
    const got = await installSkills({ family: 'claude', cwd: gitRepo(), skills: ['huashu-report'], root })
    expect(got.ok).toBe(false)
    if (!got.ok) expect(got.why).toContain('huashu-report')
  })

  it('读不了技能的那一家 → 拒绝,一个文件都不拷', async () => {
    const root = fakeRoot()
    const cwd = gitRepo()
    const got = await installSkills({ family: 'doubao', cwd, skills: ['huashu-report'], root })
    expect(got.ok).toBe(false)
    expect(existsSync(join(cwd, '.claude'))).toBe(false)
    expect(existsSync(join(cwd, '.agents'))).toBe(false)
  })

  it('Kimi 读 .agents/skills(2026-10-22 卡 C):拷进项目级技能目录、写进 exclude', async () => {
    const root = fakeRoot()
    const cwd = gitRepo()
    const got = await installSkills({ family: 'kimi', cwd, skills: ['huashu-report'], root })
    expect(got).toMatchObject({ ok: true, dir: '.agents/skills' })
    expect(existsSync(join(cwd, '.agents/skills/huashu-report/SKILL.md'))).toBe(true)
    expect(excludeOf(cwd)).toContain('/.agents/skills/huashu-report/')
  })

  it('不是 git 仓库也照拷(没有 exclude 可写)', async () => {
    const root = fakeRoot()
    const cwd = temp()
    const got = await installSkills({ family: 'claude', cwd, skills: ['huashu-report'], root })
    expect(got.ok).toBe(true)
    expect(existsSync(join(cwd, '.claude/skills/huashu-report/SKILL.md'))).toBe(true)
  })
})

describe('用户层技能进技能库(2026-10-22,卡「用户层技能生效」B)', () => {
  /** 假的用户层技能目录:一件目录形、两件扁平形。 */
  function fakeUserLayer(): { skillsDir: string, skills: UserLayerSkill[] } {
    const skillsDir = temp()
    mkdirSync(join(skillsDir, 'g-scoped-implementation'), { recursive: true })
    writeFileSync(join(skillsDir, 'g-scoped-implementation', 'SKILL.md'), '---\nname: 范围内实现\ndescription: 接任务包后只在范围内改\n---\n\n# 范围内实现\n')
    writeFileSync(join(skillsDir, 'pm-status-report.SKILL.md'), '---\nname: 进度汇报\n---\n\n# 进度汇报\n')
    writeFileSync(join(skillsDir, 'c-acceptance.md'), '---\nname: 验收\n---\n\n# 验收\n')
    const skills: UserLayerSkill[] = [
      { id: 'c-acceptance', name: '验收', file: join(skillsDir, 'c-acceptance.md') },
      { id: 'g-scoped-implementation', name: '范围内实现', description: '接任务包后只在范围内改', dir: join(skillsDir, 'g-scoped-implementation') },
      { id: 'pm-status-report', name: '进度汇报', file: join(skillsDir, 'pm-status-report.SKILL.md') },
    ]
    return { skillsDir, skills }
  }

  it('★ checkSkillNames 两边都查:用户层的名字照收,错误里两边都列', () => {
    const { skills } = fakeUserLayer()
    expect(checkSkillNames(['g-scoped-implementation'], skills.map(one => one.id)))
      .toEqual({ ok: true, skills: ['g-scoped-implementation'] })
    const unknown = checkSkillNames(['huashu-report', 'nope'], skills.map(one => one.id))
    expect(unknown.ok).toBe(false)
    if (!unknown.ok) {
      expect(unknown.error).toContain('nope')
      for (const name of DISPATCH_SKILLS) expect(unknown.error).toContain(name)
      expect(unknown.error).toContain('g-scoped-implementation')
    }
  })

  it('★ 同名以用户层为准:用户层有 huashu-report 时,拷的是用户层那份', async () => {
    const root = fakeRoot()
    const { skillsDir, skills } = fakeUserLayer()
    mkdirSync(join(skillsDir, 'huashu-report'), { recursive: true })
    writeFileSync(join(skillsDir, 'huashu-report', 'SKILL.md'), '---\nname: 用户层的报告技能\n---\n\n# 我的版本\n')
    const cwd = gitRepo()
    const got = await installSkills({ family: 'kimi', cwd, skills: ['huashu-report'], root, userSkills: [...skills, { id: 'huashu-report', name: '用户层的报告技能', dir: join(skillsDir, 'huashu-report') }] })
    expect(got.ok).toBe(true)
    expect(readFileSync(join(cwd, '.agents/skills/huashu-report/SKILL.md'), 'utf8')).toContain('我的版本')
  })

  it('★ 扁平形拷进工作树时包成 <名>/SKILL.md(各家只认目录形),目录形整目录拷', async () => {
    const { skills } = fakeUserLayer()
    const cwd = gitRepo()
    const got = await installSkills({ family: 'kimi', cwd, skills: ['pm-status-report', 'g-scoped-implementation'], root: fakeRoot(), userSkills: skills })
    expect(got.ok).toBe(true)
    expect(readFileSync(join(cwd, '.agents/skills/pm-status-report/SKILL.md'), 'utf8')).toContain('进度汇报')
    expect(readFileSync(join(cwd, '.agents/skills/g-scoped-implementation/SKILL.md'), 'utf8')).toContain('范围内实现')
    expect(existsSync(join(cwd, '.agents/skills/pm-status-report.SKILL.md'))).toBe(false)
    // 是我们拷的:再派一次照样换新(带 UPSTREAM.json 记号)。
    const mark = JSON.parse(readFileSync(join(cwd, '.agents/skills/pm-status-report/UPSTREAM.json'), 'utf8')) as Record<string, unknown>
    expect(mark.name).toBe('pm-status-report')
    const again = await installSkills({ family: 'kimi', cwd, skills: ['pm-status-report'], root: fakeRoot(), userSkills: skills })
    expect(again.ok).toBe(true)
    // 写进了 info/exclude,不进她的提交。
    expect(excludeOf(cwd)).toContain('/.agents/skills/pm-status-report/')
    expect(excludeOf(cwd)).toContain('/.agents/skills/g-scoped-implementation/')
  })

  it('工作区里已有同名、不是我们拷的 → 用户层的也不覆盖,说清楚', async () => {
    const { skills } = fakeUserLayer()
    const cwd = gitRepo()
    mkdirSync(join(cwd, '.agents/skills/pm-status-report'), { recursive: true })
    writeFileSync(join(cwd, '.agents/skills/pm-status-report/SKILL.md'), '她自己的')
    const got = await installSkills({ family: 'kimi', cwd, skills: ['pm-status-report'], root: fakeRoot(), userSkills: skills })
    expect(got.ok).toBe(false)
    expect(readFileSync(join(cwd, '.agents/skills/pm-status-report/SKILL.md'), 'utf8')).toBe('她自己的')
  })

  it('本体库与用户层都没有 → 不派、说清楚', async () => {
    const { skills } = fakeUserLayer()
    const got = await installSkills({ family: 'kimi', cwd: gitRepo(), skills: ['no-such-skill'], root: temp(), userSkills: skills })
    expect(got.ok).toBe(false)
    if (!got.ok) expect(got.why).toContain('no-such-skill')
  })

  it('只带用户层技能、本体技能库缺席(root 空)也照拷', async () => {
    const { skills } = fakeUserLayer()
    const cwd = gitRepo()
    const got = await installSkills({ family: 'kimi', cwd, skills: ['c-acceptance'], root: '', userSkills: skills })
    expect(got.ok).toBe(true)
    expect(readFileSync(join(cwd, '.agents/skills/c-acceptance/SKILL.md'), 'utf8')).toContain('验收')
  })
})

describe('skillsPromptLine', () => {
  it('交代里点明带了哪几件、在哪', () => {
    const line = skillsPromptLine('claude', ['huashu-report'])
    expect(line).toContain('huashu-report')
    expect(line).toContain('.claude/skills/huashu-report/SKILL.md')
  })
})

describe('选项表:带技能的活只把能读技能的家列成能派', () => {
  const CLAUDE = { id: 'claude', title: 'Claude', hands: ['cli'], aliases: [], from_registry: true } as unknown as DispatchTarget
  const CODEX = { id: 'codex', title: 'Codex', hands: ['cli'], aliases: [], from_registry: true } as unknown as DispatchTarget
  const KIMI = { id: 'kimi', title: 'Kimi', hands: ['window'], aliases: [], from_registry: true } as unknown as DispatchTarget
  const DOUBAO = { id: 'doubao', title: '豆包办公', hands: ['window'], aliases: [], from_registry: true } as unknown as DispatchTarget
  const base = { text: '把 X 项目做一份研究简报', targets: [CLAUDE, CODEX, KIMI, DOUBAO], quota: {}, installed: () => true }

  it('带技能 → 按改文件那一类;能派的只有读得了技能的那几家(Kimi 2026-10-22 起在列)', () => {
    const view = dispatchChoices({ ...base, skills: ['huashu-report'] })
    expect(view.kind).toBe('code')
    expect(view.kind_why).toContain('技能')
    for (const option of view.options) {
      if (!canReadSkills(option.family)) {
        expect(option.ok).toBe(false)
        expect(option.why).toContain('读不了技能目录')
      }
    }
    expect(view.options.filter(one => one.ok).map(one => one.family)).toEqual(view.options.map(one => one.family).filter(canReadSkills))
    expect(view.options.find(one => one.family === 'kimi')?.ok).toBe(true)
    expect(view.default).toBe('claude')
  })

  it('点名一家窗口手:照列出来,说清读不了技能目录', () => {
    const view = dispatchChoices({ ...base, skills: ['huashu-report'], named: 'doubao' })
    const doubao = view.options.find(one => one.family === 'doubao')
    expect(doubao?.ok).toBe(false)
    expect(doubao?.why).toContain('读不了技能目录')
  })

  it('不带技能:选项表一字不变', () => {
    expect(dispatchChoices({ ...base, skills: [] })).toEqual(dispatchChoices(base))
  })
})

describe('findSkillsRoot', () => {
  it('从源码目录往上找得到仓库里的 third_party/skills', () => {
    const root = findSkillsRoot(join(import.meta.dirname, '..', 'src', 'server'))
    expect(root).toBe(join(import.meta.dirname, '..', '..', 'third_party', 'skills'))
    for (const name of DISPATCH_SKILLS) expect(existsSync(join(root ?? '', name, 'SKILL.md'))).toBe(true)
  })

  it('找不到回 undefined', () => {
    expect(findSkillsRoot(temp(), 0)).toBeUndefined()
  })
})

describe('8791 契约对照:`/dispatch/run` 的 skills(卡 S)', () => {
  const repo = join(import.meta.dirname, '..', '..')

  it('派活技能文档写着 skills、列全能带的那几件、只给读得了的几家', () => {
    const doc = readFileSync(join(repo, 'docs', '技能', '派活给别家Agent.md'), 'utf8')
    expect(doc).toContain('"skills"')
    expect(doc).toContain('&skills=')
    for (const name of DISPATCH_SKILLS) expect(doc).toContain(name)
    expect(doc).toContain('读不了技能目录')
  })

  it('能带的每一件都在技能库里', () => {
    const root = findSkillsRoot(join(repo, 'workbench-plugin'))
    for (const name of DISPATCH_SKILLS) expect(existsSync(join(root ?? '', name, 'UPSTREAM.json'))).toBe(true)
  })

  it('探针用的是派活同一个装法与同一张位置表(不另抄一份)', () => {
    const probe = readFileSync(join(repo, 'workbench-plugin', 'scripts', 'probe-skill-loading.ts'), 'utf8')
    expect(probe).toMatch(/import \{[^}]*installSkills[^}]*\} from '\.\.\/src\/server\/dispatchSkills\.ts'/)
    expect(probe).toMatch(/import \{[^}]*dispatchCommand[^}]*\} from '\.\.\/src\/server\/agentDispatch\.ts'/)
    expect(probe).not.toMatch(/'\.claude\/skills'|'\.agents\/skills'/)
  })
})
