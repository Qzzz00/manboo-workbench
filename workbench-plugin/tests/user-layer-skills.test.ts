// @vitest-environment node
/**
 * 用户层「技能」那一格的读法(2026-10-22,卡「用户层技能生效」A;决策记录 10-22「用户层技能」)。
 *
 * 维护者把自己的技能搬进了 `~/.dsh/workbench/用户层/技能/`:`g-*` 七件(给小K)、`c-*` 八件(给统筹)、
 * `项目经理/` 十一份扁平 `.SKILL.md`(给事务官)。派活与事务官都要读它。这里钉住两种形与跳过的那几样:
 *
 *   - 目录形 `<名>/SKILL.md`;
 *   - 扁平形 `<名>.SKILL.md` 或 `<名>.md`,**头部 frontmatter 带 `name:` 的才算**
 *     (`来源说明.md` / `说明.md` / `pm-overview.md` 这类没有 `name:` 的不算技能);
 *   - 子目录(如 `项目经理/`)往下一层也扫;
 *   - 每件给出 `{ id, name, description, dir | file }`。
 *
 * **全程临时目录**(mkdtemp),一个字节都不碰真的 `~/.dsh`。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { USER_LAYER_FOLDERS, scanUserLayerSkills } from '../src/server/userLayer.ts'

const dirs: string[] = []
afterEach(() => { while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true }) })

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wb-ul-skills-'))
  dirs.push(dir)
  return dir
}

function skillsDir(): string {
  const root = tmp()
  mkdirSync(join(root, '技能'), { recursive: true })
  return join(root, '技能')
}

const FRONT = (name: string, description = ''): string => `---\nname: ${name}\n${description === '' ? '' : `description: ${description}\n`}---\n\n# ${name}\n`

describe('scanUserLayerSkills', () => {
  it('目录形:<名>/SKILL.md 算一件,名字与简介读 frontmatter', async () => {
    const dir = skillsDir()
    mkdirSync(join(dir, 'g-scoped-implementation'), { recursive: true })
    writeFileSync(join(dir, 'g-scoped-implementation', 'SKILL.md'), FRONT('范围内实现', '接任务包后只在范围内改'))
    const got = await scanUserLayerSkills(dir)
    expect(got).toEqual([{ id: 'g-scoped-implementation', name: '范围内实现', description: '接任务包后只在范围内改', dir: join(dir, 'g-scoped-implementation') }])
  })

  it('目录形没有 frontmatter name: 的,名字退回目录名,照样算', async () => {
    const dir = skillsDir()
    mkdirSync(join(dir, 'plain-skill'), { recursive: true })
    writeFileSync(join(dir, 'plain-skill', 'SKILL.md'), '# 没有头部的技能\n')
    const got = await scanUserLayerSkills(dir)
    expect(got).toEqual([{ id: 'plain-skill', name: 'plain-skill', dir: join(dir, 'plain-skill') }])
  })

  it('扁平形:<名>.SKILL.md 与 <名>.md,头部带 name: 的才算', async () => {
    const dir = skillsDir()
    writeFileSync(join(dir, 'pm-status-report.SKILL.md'), FRONT('进度汇报', '按检查点报进度'))
    writeFileSync(join(dir, 'c-acceptance.md'), FRONT('验收', '对照验收标准逐条核'))
    const got = await scanUserLayerSkills(dir)
    expect(got).toEqual([
      { id: 'c-acceptance', name: '验收', description: '对照验收标准逐条核', file: join(dir, 'c-acceptance.md') },
      { id: 'pm-status-report', name: '进度汇报', description: '按检查点报进度', file: join(dir, 'pm-status-report.SKILL.md') },
    ])
  })

  it('★ 跳过非技能:没有 name: 的说明文档(来源说明.md / 说明.md / pm-overview.md)一律不算', async () => {
    const dir = skillsDir()
    writeFileSync(join(dir, 'pm-status-report.SKILL.md'), FRONT('进度汇报'))
    writeFileSync(join(dir, '来源说明.md'), '# 这几件从哪来\n')
    writeFileSync(join(dir, '说明.md'), '---\ntitle: 说明\n---\n没有 name 的头部\n')
    writeFileSync(join(dir, 'pm-overview.md'), '---\nname-upper: x\n---\n有个像名字的键但不是 name\n')
    const got = await scanUserLayerSkills(dir)
    expect(got.map(one => one.id)).toEqual(['pm-status-report'])
  })

  it('★ 子目录(如 项目经理/)往下一层也扫;再深一层不扫', async () => {
    const dir = skillsDir()
    mkdirSync(join(dir, '项目经理'), { recursive: true })
    writeFileSync(join(dir, '项目经理', 'pm-status-report.SKILL.md'), FRONT('进度汇报'))
    mkdirSync(join(dir, '项目经理', '深一层'), { recursive: true })
    writeFileSync(join(dir, '项目经理', '深一层', 'too-deep.SKILL.md'), FRONT('太深'))
    const got = await scanUserLayerSkills(dir)
    expect(got.map(one => one.id)).toEqual(['pm-status-report'])
    expect(got[0]).toMatchObject({ file: join(dir, '项目经理', 'pm-status-report.SKILL.md') })
  })

  it('目录里两样同名:先扫到的那件为准(结果按 id 排好、去重)', async () => {
    const dir = skillsDir()
    writeFileSync(join(dir, 'a-skill.SKILL.md'), FRONT('扁平甲'))
    mkdirSync(join(dir, 'a-skill'), { recursive: true })
    writeFileSync(join(dir, 'a-skill', 'SKILL.md'), FRONT('目录甲'))
    const got = await scanUserLayerSkills(dir)
    expect(got).toHaveLength(1)
  })

  it('目录不在 / 是空的:回空表,不抛', async () => {
    const root = tmp()
    expect(await scanUserLayerSkills(join(root, '没有这个'))).toEqual([])
    expect(await scanUserLayerSkills(skillsDir())).toEqual([])
  })
})

describe('「技能」那一格(设置 →「这台电脑」→「用户层」里看得见)', () => {
  it('★ live: true,文案按事实写(派活与事务官都读这个目录)', () => {
    const entry = USER_LAYER_FOLDERS.find(one => one.name === '技能')
    expect(entry?.live).toBe(true)
    expect(entry?.what).toContain('派活')
    expect(entry?.what).toContain('事务官')
    expect(entry?.what).not.toContain('暂时不生效')
  })
})
