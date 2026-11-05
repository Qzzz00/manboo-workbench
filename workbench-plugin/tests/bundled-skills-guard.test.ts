/**
 * 包内技能与仓库 docs/技能/ 逐字一致(2026-09-23)。红了就跑:
 *     node workbench-plugin/scripts/gen-bundled-skills.mjs
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { BUNDLED_BUTLER_DOCS, BUNDLED_BUTLER_SKILLS, BUNDLED_SKILL_DOCS } from '../src/server/bundledSkills.generated.ts'
import { bundledSkillDoc, pointWordlistAt, readSkillDoc } from '../src/server/bundledSkills.ts'

const skillDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'docs', '技能')
const butlerSkillDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '.dsh', 'skills')

describe('包内技能', () => {
  it('与 docs/技能/*.md 逐字一致(忘了跑生成脚本就红)', () => {
    const names = readdirSync(skillDir).filter(name => name.endsWith('.md')).sort()
    expect(Object.keys(BUNDLED_SKILL_DOCS).sort()).toEqual(names)
    for (const name of names) expect(BUNDLED_SKILL_DOCS[name], name).toBe(readFileSync(join(skillDir, name), 'utf8'))
  })
  it('事务官自己的技能与仓库根上的 .dsh/skills/*/SKILL.md 逐字一致(2026-09-25;改了那几份忘了跑生成脚本就红)', () => {
    const names = readdirSync(butlerSkillDir, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name).sort()
    expect(Object.keys(BUNDLED_BUTLER_SKILLS).sort()).toEqual(names)
    for (const name of names) expect(BUNDLED_BUTLER_SKILLS[name], name).toBe(readFileSync(join(butlerSkillDir, name, 'SKILL.md'), 'utf8'))
  })
  it('事务官照着做的文档与仓库那一份逐字一致(2026-09-26,下班例程模板;改了它忘了跑生成脚本就红)', () => {
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
    expect(Object.keys(BUNDLED_BUTLER_DOCS)).toEqual(['docs/记忆/下班例程.md'])
    for (const [rel, text] of Object.entries(BUNDLED_BUTLER_DOCS)) expect(text, rel).toBe(readFileSync(join(repoRoot, rel), 'utf8'))
  })
  it('只认 docs/技能/ 下的相对路径', () => {
    expect(bundledSkillDoc('docs/技能/运营-总纲.md')).toContain('#')
    expect(bundledSkillDoc('运营-总纲.md')).toBeUndefined()
    expect(bundledSkillDoc('docs/技能/没有这份.md')).toBeUndefined()
  })
  it('仓库优先,读不到/空的才用包内', async () => {
    expect(await readSkillDoc('docs/技能/运营-总纲.md', async () => '仓库版')).toEqual({ text: '仓库版', source: 'repo' })
    expect((await readSkillDoc('docs/技能/运营-总纲.md', async () => '  '))?.source).toBe('bundled')
    expect((await readSkillDoc('docs/技能/运营-总纲.md', undefined))?.source).toBe('bundled')
    expect(await readSkillDoc('docs/技能/没有.md', undefined)).toBeUndefined()
  })
  it('违禁词表路径换成落盘那份', () => {
    expect(pointWordlistAt('读 `docs/技能/违禁词表.md`,依据 docs/技能/违禁词表.md', '/h/.dsh/workbench/技能/违禁词表.md'))
      .toBe('读 `/h/.dsh/workbench/技能/违禁词表.md`,依据 /h/.dsh/workbench/技能/违禁词表.md')
  })
})
