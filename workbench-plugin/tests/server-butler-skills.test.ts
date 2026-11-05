// @vitest-environment node
/**
 * 事务官自己的技能装进她的工作目录(2026-09-25,卡 fix/evening-gaps 第 4 条)。
 *
 * 卡 K 查到:仓库里的 `.dsh/skills/记忆/SKILL.md`(还有引导、例程)在维护者机器上根本不存在 ——
 * 她的工作目录(`~/Documents/工作台`)与 `~/.dsh` 下都没有,「问到才读记忆」其实读不到。
 * 这里钉住:新装装上、升级跟上、她改过的不动、只提交这几个文件、不碰她别的改动。
 * **全程临时目录**(mkdtemp),一个字节都不碰真的家目录。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BUNDLED_BUTLER_SKILLS } from '../src/server/bundledSkills.generated.ts'
import { BUTLER_SKILLS_COMMIT_MESSAGE, butlerSkillFile, nodeButlerSkillsIo, syncButlerSkills } from '../src/server/butlerSkills.ts'
import type { UserLayerSkill } from '../src/server/userLayer.ts'

function sandbox(options: { git?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'wb-butler-skills-'))
  const workDir = join(root, '工作台')
  mkdirSync(workDir, { recursive: true })
  writeFileSync(join(workDir, 'AGENTS.md'), '# 这个目录是什么\n')
  const manifestFile = join(root, 'dsh', 'workbench', 'butler-skills.json')
  const git = (...args: string[]): string => execFileSync('git', args, { cwd: workDir, encoding: 'utf8' })
  if (options.git === true) {
    git('init', '-q', '-b', 'main')
    git('add', '-A')
    git('-c', 'user.name=测试', '-c', 'user.email=t@localhost', 'commit', '-q', '-m', '骨架')
  }
  return { root, workDir, manifestFile, git, io: nodeButlerSkillsIo() }
}

const V1 = { 记忆: '# 记忆 v1\n', 引导: '# 引导 v1\n', 例程: '# 例程 v1\n' }
const V2 = { 记忆: '# 记忆 v2\n', 引导: '# 引导 v1\n', 例程: '# 例程 v2\n' }
/** 顺带装的文档(2026-09-26):**缺才写**,有了一个字不动。 */
const DOCS = { 'docs/记忆/下班例程.md': '# 下班例程 v1\n' }
const DOCS_V2 = { 'docs/记忆/下班例程.md': '# 下班例程 v2\n' }

describe('随版本打进插件的那三份', () => {
  it('记忆 / 引导 / 例程都在,与仓库根上的 .dsh/skills 逐字一致(守卫另见 bundled-skills-guard)', () => {
    expect(Object.keys(BUNDLED_BUTLER_SKILLS).sort()).toEqual(['例程', '引导', '截图验收', '记忆'])
    for (const text of Object.values(BUNDLED_BUTLER_SKILLS)) expect(text.startsWith('---\nname: ')).toBe(true)
  })
})

describe('装进她的工作目录', () => {
  it('★★ 新装:每一份都装到 <工作目录>/.dsh/skills/<名字>/SKILL.md(她会话里那句「按 .dsh/skills/记忆/SKILL.md 查」读得到)', async () => {
    const s = sandbox()
    const out = await syncButlerSkills({ workDir: s.workDir, manifestFile: s.manifestFile, io: s.io })
    expect(out.installed.sort()).toEqual(['例程', '引导', '截图验收', '记忆'])
    for (const [name, text] of Object.entries(BUNDLED_BUTLER_SKILLS)) {
      expect(readFileSync(butlerSkillFile(s.workDir, name), 'utf8')).toBe(text)
    }
    expect(existsSync(join(s.workDir, '.dsh', 'skills', '记忆', 'SKILL.md'))).toBe(true)
    expect(out.note).toContain('装上了')
  })

  it('再起一次服务:都是这一版,一个字不写', async () => {
    const s = sandbox()
    await syncButlerSkills({ workDir: s.workDir, manifestFile: s.manifestFile, io: s.io, skills: V1 })
    const again = await syncButlerSkills({ workDir: s.workDir, manifestFile: s.manifestFile, io: s.io, skills: V1 })
    expect(again.installed).toEqual([])
    expect(again.upgraded).toEqual([])
    expect(again.current.sort()).toEqual(['例程', '引导', '记忆'])
    expect(again.note).toContain('都是这一版')
  })

  it('★★ 升级(老用户热更新):我们上次装的、她没改过的,换成这一版;没变的那份不动', async () => {
    const s = sandbox()
    await syncButlerSkills({ workDir: s.workDir, manifestFile: s.manifestFile, io: s.io, skills: V1 })
    const out = await syncButlerSkills({ workDir: s.workDir, manifestFile: s.manifestFile, io: s.io, skills: V2 })
    expect(out.upgraded.sort()).toEqual(['例程', '记忆'])
    expect(out.current).toEqual(['引导'])
    expect(readFileSync(butlerSkillFile(s.workDir, '记忆'), 'utf8')).toBe('# 记忆 v2\n')
  })

  it('★★ 她改过的(用户层):升级时不动,如实说一句', async () => {
    const s = sandbox()
    await syncButlerSkills({ workDir: s.workDir, manifestFile: s.manifestFile, io: s.io, skills: V1 })
    writeFileSync(butlerSkillFile(s.workDir, '记忆'), '# 记忆 v1\n\n她自己加的一条\n')
    const out = await syncButlerSkills({ workDir: s.workDir, manifestFile: s.manifestFile, io: s.io, skills: V2 })
    expect(out.kept).toEqual(['记忆'])
    expect(readFileSync(butlerSkillFile(s.workDir, '记忆'), 'utf8')).toBe('# 记忆 v1\n\n她自己加的一条\n')
    expect(out.note).toContain('记忆 被改过,没动')
    // 另外两份照常升级。
    expect(out.upgraded).toEqual(['例程'])
  })

  it('没见过的那份(开发仓库里版本库自己管着、或者早先手放的):不动', async () => {
    const s = sandbox()
    mkdirSync(join(s.workDir, '.dsh', 'skills', '例程'), { recursive: true })
    writeFileSync(butlerSkillFile(s.workDir, '例程'), '# 仓库里正在改的例程\n')
    const out = await syncButlerSkills({ workDir: s.workDir, manifestFile: s.manifestFile, io: s.io, skills: V1 })
    expect(out.kept).toEqual(['例程'])
    expect(readFileSync(butlerSkillFile(s.workDir, '例程'), 'utf8')).toBe('# 仓库里正在改的例程\n')
  })

  it('★ 工作目录是 git 仓库:只提交 .dsh/skills 与补上的那份文档,她别的改动原样留在工作区', async () => {
    const s = sandbox({ git: true })
    writeFileSync(join(s.workDir, 'AGENTS.md'), '# 她正在改的\n')
    const out = await syncButlerSkills({ workDir: s.workDir, manifestFile: s.manifestFile, io: s.io, skills: V1, docs: DOCS })
    expect(out.committed).toBe(true)
    expect(s.git('log', '-1', '--format=%s').trim()).toBe(BUTLER_SKILLS_COMMIT_MESSAGE)
    expect(s.git('-c', 'core.quotepath=false', 'show', '--name-only', '--format=', 'HEAD').trim().split('\n').sort())
      .toEqual(['.dsh/skills/例程/SKILL.md', '.dsh/skills/引导/SKILL.md', '.dsh/skills/记忆/SKILL.md', 'docs/记忆/下班例程.md'].sort())
    // 她那一处改动没被顺手提交。
    expect(s.git('status', '--porcelain').trim()).toBe('M AGENTS.md')
    // 提交人是现给的,没动她的全局配置。
    expect(s.git('log', '-1', '--format=%an').trim()).toBe('工作台')
  })

  /**
   * F(2026-09-26):`docs/记忆/下班例程.md` 随工作台装进她的工作目录 —— 记忆技能里写着「按它八步做」,
   * 而它原来只在开发仓库里有。与技能不同的一条:**缺才写**,有了一个字不动(她可能按自己的习惯改过)。
   */
  it('★★ 下班例程模板:缺就补上;已经有了(哪怕是她改过的)就一个字不动', async () => {
    const s = sandbox()
    const first = await syncButlerSkills({ workDir: s.workDir, manifestFile: s.manifestFile, io: s.io, skills: V1, docs: DOCS })
    expect(first.docs).toEqual(['docs/记忆/下班例程.md'])
    expect(readFileSync(join(s.workDir, 'docs/记忆/下班例程.md'), 'utf8')).toBe('# 下班例程 v1\n')
    expect(first.note).toContain('补上文档 docs/记忆/下班例程.md')

    // 她改了一行:再起服务、哪怕我们这一版换了内容,也不覆盖。
    writeFileSync(join(s.workDir, 'docs/记忆/下班例程.md'), '# 下班例程 v1\n\n她自己加的一步\n')
    const again = await syncButlerSkills({ workDir: s.workDir, manifestFile: s.manifestFile, io: s.io, skills: V1, docs: DOCS_V2 })
    expect(again.docs).toEqual([])
    expect(readFileSync(join(s.workDir, 'docs/记忆/下班例程.md'), 'utf8')).toBe('# 下班例程 v1\n\n她自己加的一步\n')
  })

  it('包内带的那份文档就是仓库里的下班例程模板(守卫另见 bundled-skills-guard)', async () => {
    const s = sandbox()
    const out = await syncButlerSkills({ workDir: s.workDir, manifestFile: s.manifestFile, io: s.io, skills: V1 })
    expect(out.docs).toEqual(['docs/记忆/下班例程.md'])
    const text = readFileSync(join(s.workDir, 'docs/记忆/下班例程.md'), 'utf8')
    expect(text).toContain('# 下班例程')
    expect(text).toContain('0. **收**')
  })

  it('不是 git 仓库:照装,不提交', async () => {
    const s = sandbox()
    const out = await syncButlerSkills({ workDir: s.workDir, manifestFile: s.manifestFile, io: s.io, skills: V1 })
    expect(out.installed).toHaveLength(3)
    expect(out.committed).toBe(false)
  })

  it('工作目录不在 / 不是绝对路径:什么都不写,如实说', async () => {
    const s = sandbox()
    const missing = await syncButlerSkills({ workDir: join(s.root, '没有这个'), manifestFile: s.manifestFile, io: s.io, skills: V1 })
    expect(missing.installed).toEqual([])
    expect(missing.note).toContain('不在')
    expect(existsSync(join(s.root, '没有这个'))).toBe(false)
    const relative = await syncButlerSkills({ workDir: 'Documents/工作台', manifestFile: s.manifestFile, io: s.io, skills: V1 })
    expect(relative.note).toContain('不是一个绝对路径')
  })

  it('写到一半抛了:不抛出去,说一句「下次起服务再补」', async () => {
    const s = sandbox()
    const io = { ...s.io, writeFile: async () => { throw new Error('磁盘满了') } }
    const out = await syncButlerSkills({ workDir: s.workDir, manifestFile: s.manifestFile, io, skills: V1 })
    expect(out.note).toContain('没装完')
    expect(out.note).toContain('磁盘满了')
  })
})

describe('用户层技能(2026-10-22,卡「用户层技能生效」C):源头是她用户层里那份', () => {
  const UL_V1 = '# 进度汇报 v1\n'
  const UL_V2 = '# 进度汇报 v2\n'

  function userSkill(root: string, name: string, text: string, flat = true): { id: string, name: string, file: string } {
    const skillsDir = join(root, '用户层', '技能')
    mkdirSync(skillsDir, { recursive: true })
    writeFileSync(join(skillsDir, `${name}.SKILL.md`), text)
    return { id: name, name, file: join(skillsDir, `${name}.SKILL.md`) }
  }

  it('★ 新装:扁平形包成 <名>/SKILL.md 装进 .dsh/skills/,进同一次提交', async () => {
    const s = sandbox({ git: true })
    const skill = userSkill(s.root, 'pm-status-report', UL_V1)
    const out = await syncButlerSkills({ workDir: s.workDir, manifestFile: s.manifestFile, io: s.io, skills: V1, userSkills: [skill] })
    expect(out.installed).toContain('pm-status-report')
    expect(readFileSync(butlerSkillFile(s.workDir, 'pm-status-report'), 'utf8')).toBe(UL_V1)
    expect(out.committed).toBe(true)
    expect(s.git('-c', 'core.quotepath=false', 'show', '--name-only', '--format=', 'HEAD')).toContain('.dsh/skills/pm-status-report/SKILL.md')
  })

  it('★ 源头为准:工作目录那份与用户层不同就换成它(她改过的也换 —— 不走本体三态指纹)', async () => {
    const s = sandbox()
    const skill = userSkill(s.root, 'pm-status-report', UL_V1)
    await syncButlerSkills({ workDir: s.workDir, manifestFile: s.manifestFile, io: s.io, skills: V1, userSkills: [skill] })
    // 她在工作目录里改了一笔(若在用户层改,源头本来就跟着变)。
    writeFileSync(butlerSkillFile(s.workDir, 'pm-status-report'), '# 她自己改过的汇报\n')
    writeFileSync(skill.file, UL_V2)
    const out = await syncButlerSkills({ workDir: s.workDir, manifestFile: s.manifestFile, io: s.io, skills: V1, userSkills: [skill] })
    expect(out.upgraded).toContain('pm-status-report')
    expect(out.kept).not.toContain('pm-status-report')
    expect(readFileSync(butlerSkillFile(s.workDir, 'pm-status-report'), 'utf8')).toBe(UL_V2)
  })

  it('与用户层那份一字不差:不动(current)', async () => {
    const s = sandbox()
    const skill = userSkill(s.root, 'pm-status-report', UL_V1)
    await syncButlerSkills({ workDir: s.workDir, manifestFile: s.manifestFile, io: s.io, skills: V1, userSkills: [skill] })
    const again = await syncButlerSkills({ workDir: s.workDir, manifestFile: s.manifestFile, io: s.io, skills: V1, userSkills: [skill] })
    expect(again.installed).toEqual([])
    expect(again.upgraded).toEqual([])
    expect(again.current).toContain('pm-status-report')
  })

  it('★ 用户层删了这件:工作目录那份不删(不删任何文件),照常起服务', async () => {
    const s = sandbox()
    const skill = userSkill(s.root, 'pm-status-report', UL_V1)
    await syncButlerSkills({ workDir: s.workDir, manifestFile: s.manifestFile, io: s.io, skills: V1, userSkills: [skill] })
    rmSync(skill.file)
    const out = await syncButlerSkills({ workDir: s.workDir, manifestFile: s.manifestFile, io: s.io, skills: V1, userSkills: [] })
    expect(out.note).toContain('都是这一版')
    expect(readFileSync(butlerSkillFile(s.workDir, 'pm-status-report'), 'utf8')).toBe(UL_V1)
  })

  it('★ 指纹表另记一段(user_layer),不与本体技能的 files 混在一起', async () => {
    const s = sandbox()
    const skill = userSkill(s.root, 'pm-status-report', UL_V1)
    await syncButlerSkills({ workDir: s.workDir, manifestFile: s.manifestFile, io: s.io, skills: V1, userSkills: [skill] })
    const manifest = JSON.parse(readFileSync(s.manifestFile, 'utf8')) as { files: Record<string, string>, user_layer?: Record<string, string> }
    const bundledKeys = Object.keys(manifest.files)
    expect(bundledKeys.some(one => one.includes('pm-status-report'))).toBe(false)
    expect(Object.keys(manifest.user_layer ?? {}).sort()).toEqual([butlerSkillFile(s.workDir, 'pm-status-report')])
  })

  it('目录形用户层技能:SKILL.md 照样装进工作目录', async () => {
    const s = sandbox()
    const skillsDir = join(s.root, '用户层', '技能')
    mkdirSync(join(skillsDir, 'team-skill'), { recursive: true })
    writeFileSync(join(skillsDir, 'team-skill', 'SKILL.md'), '# 目录形技能\n')
    const out = await syncButlerSkills({
      workDir: s.workDir, manifestFile: s.manifestFile, io: s.io, skills: V1,
      userSkills: [{ id: 'team-skill', name: '目录形', dir: join(skillsDir, 'team-skill') }],
    })
    expect(out.installed).toContain('team-skill')
    expect(readFileSync(butlerSkillFile(s.workDir, 'team-skill'), 'utf8')).toBe('# 目录形技能\n')
  })

  it('用户层那份这会儿读不出来:跳过这一件,别的不受带累,不抛', async () => {
    const s = sandbox()
    const skill = userSkill(s.root, 'pm-status-report', UL_V1)
    rmSync(skill.file)
    const out = await syncButlerSkills({ workDir: s.workDir, manifestFile: s.manifestFile, io: s.io, skills: V1, userSkills: [skill] })
    expect(out.installed).toEqual(['例程', '引导', '记忆'])
    expect(out.note).not.toContain('没装完')
  })
})
