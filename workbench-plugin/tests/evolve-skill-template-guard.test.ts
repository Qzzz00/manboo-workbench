// @vitest-environment node
/**
 * 守卫:代码起草的技能草稿 ←→ 仓库里那份人读的模板(2026-09-22,卡 ⑥)。
 *
 * 同 `ops-skills-topic-files-guard.test.ts` 那张卡记下的教训:两处各写一份小标题,
 * 改一头忘另一头,事务官起草出来的技能与模板长得不一样,而两边的用例都是绿的。
 *
 * 钉四件:
 * 1. `docs/技能/固化-模板.md` 里逐字有 `EVOLVE_SKILL_SECTIONS` 那四个小标题;
 * 2. 代码起草出来的正文也逐字有那四个,而且顺序一致;
 * 3. 技能目录常量与 `opsSkills.ts` 的 `OPS_SKILL_DIR` 相等 —— 两份技能落在同一个目录里,
 *    它们分头写字面量的那一天就是走漂的起点;
 * 4. 模板文件本身**不是**一份能被误当成技能接进 AGENTS.md 的东西:它不以 `固化-` 开头的
 *    真名字命名一个具体技能,而且开口就说自己是模板。
 *
 * **一行写盘都没有**(只读仓库里的文本),不碰 `~/.dsh`。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  EVOLVE_SKILL_DIR,
  EVOLVE_SKILL_PREFIX,
  EVOLVE_SKILL_SECTIONS,
  EVOLVE_SKILL_TEMPLATE_DOC,
  evolveSkillDraft,
  proposalOf,
} from '../src/server/evolve.ts'
import { OPS_SKILL_DIR } from '../src/server/opsSkills.ts'

/** 仓库根(tests/ 的上两级)。模板文档是**真读**的,不是夹具。 */
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const template = readFileSync(join(REPO_ROOT, EVOLVE_SKILL_TEMPLATE_DOC), 'utf8')

const draft = evolveSkillDraft({
  name: '评论区选题',
  proposal: proposalOf(
    {
      id: 'evolve:评论区问题整理成选题',
      sample: '评论区问题整理成选题',
      says: [
        { id: 'a', text: '把评论区里的问题整理成选题', at: '2026-09-12T10:00:00Z' },
        { id: 'b', text: '把评论区的问题整理一下变成选题', at: '2026-09-16T10:00:00Z' },
        { id: 'c', text: '评论区问题整理成选题', at: '2026-09-20T10:00:00Z' },
      ],
      shared: [],
    },
    '2026-09-22T12:00:00.000Z',
  ),
  date: '2026-09-22',
})

describe('固化技能的模板与草稿', () => {
  it('★模板文件里逐字有那四个小标题', () => {
    for (const section of EVOLVE_SKILL_SECTIONS) expect(template).toContain(`## ${section}`)
  })

  it('★代码起草的正文里也逐字有,而且顺序与模板一致', () => {
    const at = (text: string): number[] => EVOLVE_SKILL_SECTIONS.map(section => text.indexOf(`## ${section}`))
    const inTemplate = at(template)
    const inDraft = at(draft)
    expect(inDraft.every(index => index >= 0)).toBe(true)
    // 两边各自递增 = 顺序一致。
    expect([...inTemplate].sort((a, b) => a - b)).toEqual(inTemplate)
    expect([...inDraft].sort((a, b) => a - b)).toEqual(inDraft)
  })

  it('★技能目录只有一份定义——两包技能落在同一个目录里', () => {
    expect(EVOLVE_SKILL_DIR).toBe(OPS_SKILL_DIR)
    expect(EVOLVE_SKILL_TEMPLATE_DOC.startsWith(`${OPS_SKILL_DIR}/`)).toBe(true)
  })

  it('★模板自己说自己是模板,不会被误当成一份技能', () => {
    expect(template).toContain('不是技能')
    expect(template).toContain('模板')
    // 它确实落在 `固化-` 那一族里(文件名前缀一处定义),但名字是「模板」而不是某件具体的活。
    expect(EVOLVE_SKILL_TEMPLATE_DOC).toBe(`${EVOLVE_SKILL_DIR}/${EVOLVE_SKILL_PREFIX}模板.md`)
  })

  it('★模板与草稿都把「怎么做」那一节留空——工作台不替她编步骤', () => {
    expect(template).toContain('等你填')
    expect(draft).toContain('等你填')
  })
})
