// @vitest-environment node
/**
 * 运营技能包进事务官的标记段(2026-09-21,白板第四节第 4 条)。
 *
 * 这一份钉四件事:
 * 1. **模板闸**:自媒体运营模板下写八段,做产品模板下一段都不写(而且会把写过的摘掉);
 * 2. **段外一个字不动**:他自己写在 AGENTS.md 里的东西(名字、说话方式、别的技能段)原样留着;
 * 3. **备份纪律**:写之前先备份;重复接一次不会变成十六段;
 * 4. **仓库里那几份文件与代码里那份清单对得上**(产物路径、标记段名)。
 *
 * 全程在 `mkdtemp` 出来的**临时 HOME** 里跑 —— 一个字节都不会碰真实的 `~/.dsh`
 * (2026-09-04 家目录被删事故之后的纪律)。
 */
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { nodeSetupIo } from '../src/server/setup/io.ts'
import { wbOpsSkillsApply, wbSkillMergeInto, wbSkillRemoveFrom } from '../src/server/hooksApply.ts'
import { BASE_SKILLS, OPS_SKILLS, OPS_WORDLIST_DOC, PRODUCT_SKILLS, opsSkillBody, opsSkillDoc, opsSkillsForTemplate } from '../src/server/opsSkills.ts'
import { markers } from '../src/server/memoryMd.ts'
import { CONFIRM_POINT_SPOKEN_MAX, CONFIRM_SKILL_NAME } from '../src/server/confirmPoints.ts'

/** 仓库根(tests/ 的上两级)。技能文件是真读的,不是夹具 —— 清单对不上就是要当场红。 */
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))

const DEPS = { io: nodeSetupIo(), now: () => new Date('2026-09-21T10:00:00Z') }

/** 真读仓库里那份技能文件。 */
const readDoc = async (skill: { name: string }): Promise<string | undefined> => {
  try { return await readFile(join(REPO_ROOT, opsSkillDoc(skill as never)), 'utf8') }
  catch { return undefined }
}

function tempHome(agents?: string): { home: string, file: string } {
  const home = mkdtempSync(join(tmpdir(), 'wb-ops-skill-'))
  const file = join(home, 'AGENTS.md')
  if (agents !== undefined) writeFileSync(file, agents)
  return { home, file }
}

describe('模板闸', () => {
  /**
   * 2026-09-22(用自然语言改布局):多了一档「两种模板都写」的基础技能,所以这几条从
   * 「做产品一律空」改成「做产品只剩基础那几段」。**运营那八条的闸一个字没变** ——
   * 下面每一条都还是拿 OPS_SKILLS 去比,而不是比一个写死的数字。
   */
  it('ops = 基础那几段 + 运营那八条', () => {
    expect(opsSkillsForTemplate('ops')).toHaveLength(BASE_SKILLS.length + OPS_SKILLS.length)
    for (const skill of OPS_SKILLS) {
      expect(opsSkillsForTemplate('ops').map(one => one.name)).toContain(skill.name)
    }
  })

  /**
   * 2026-09-23(中秋目标断点 C):做产品那一档从"只剩基础几段"变成"基础几段 + 做产品那一包"。
   * **认不出的 id 与没选过那两种一个字没变** —— 它们照旧只有基础那几段,
   * 理由比从前更硬:做产品那一包里有一条会合并 main 并发一版。
   */
  it('做产品 = 基础那几段 + 做产品那一包,运营那几条一条都没有', () => {
    const got = opsSkillsForTemplate('product')
    expect(got.map(one => one.name)).toEqual([...BASE_SKILLS, ...PRODUCT_SKILLS].map(one => one.name))
    for (const skill of OPS_SKILLS) expect(got.map(one => one.name)).not.toContain(skill.name)
  })

  it('认不出的 id / 没选过 = 只有基础那几段,运营与做产品那两包一条都没有', () => {
    for (const id of ['没这个模板', undefined]) {
      const got = opsSkillsForTemplate(id)
      expect(got.map(one => one.name)).toEqual(BASE_SKILLS.map(one => one.name))
      for (const skill of [...OPS_SKILLS, ...PRODUCT_SKILLS]) {
        expect(got.map(one => one.name)).not.toContain(skill.name)
      }
    }
  })

  it('做产品那一包带前缀、而且不落任何产物(产物都是工作台自己写的)', () => {
    for (const skill of PRODUCT_SKILLS) {
      expect(skill.name.startsWith('做产品-')).toBe(true)
      expect(skill.artifacts).toEqual([])
    }
  })

  it('基础那几段里有「用说话改布局」,而且不带运营前缀(它不属于那一包)', () => {
    expect(BASE_SKILLS.map(one => one.name)).toContain('用说话改布局')
    for (const skill of BASE_SKILLS) expect(skill.name.startsWith('运营-')).toBe(false)
  })
})

describe('两种模板都写的那几段(2026-09-22)', () => {
  it('文件在仓库里,而且里面逐字写着自己的标记段名', () => {
    for (const skill of BASE_SKILLS) {
      const text = readFileSync(join(REPO_ROOT, opsSkillDoc(skill)), 'utf8')
      expect(text.trim()).not.toBe('')
      expect(text).toContain(markers(skill.name).open)
      expect(opsSkillDoc(skill)).toBe(`docs/技能/${skill.name}.md`)
    }
  })

  it('做产品模板下也真的写进 AGENTS.md(这就是「两种模板都写」那一条)', async () => {
    const { file } = tempHome('我叫小助。\n')
    const result = await wbOpsSkillsApply(DEPS, { file, templateId: 'product', readDoc })
    expect(result.ok).toBe(true)
    const after = readFileSync(file, 'utf8')
    for (const skill of BASE_SKILLS) expect(after).toContain(markers(skill.name).open)
    // 运营那八条在做产品模板下仍然一条都没有。
    for (const skill of OPS_SKILLS) expect(after).not.toContain(markers(skill.name).open)
  })

  it('那份技能里写明了走 /butler/item,而不是自己拼 /layout', () => {
    const text = readFileSync(join(REPO_ROOT, 'docs/技能/用说话改布局.md'), 'utf8')
    expect(text).toContain('/butler/item')
    expect(text).toContain('不自己拼布局 JSON')
  })
})

describe('仓库里那几份文件', () => {
  it('每一份都在,而且清单里的名字就是文件名', () => {
    for (const skill of OPS_SKILLS) {
      const text = readFileSync(join(REPO_ROOT, opsSkillDoc(skill)), 'utf8')
      expect(text.trim()).not.toBe('')
      expect(opsSkillDoc(skill)).toBe(`docs/技能/${skill.name}.md`)
    }
  })

  it('技能文件里写的产物路径,与清单里那一份逐字对得上', () => {
    // 两处各写一份路径、改一处忘另一处,是这类东西最常见的走样。
    for (const skill of OPS_SKILLS) {
      const text = readFileSync(join(REPO_ROOT, opsSkillDoc(skill)), 'utf8')
      for (const artifact of skill.artifacts) {
        expect(text, `${skill.name} 里没写产物 ${artifact}`).toContain(artifact)
      }
    }
  })

  it('每一份都写着自己的标记段名,免得文件名改了标记段没改', () => {
    for (const skill of OPS_SKILLS) {
      const text = readFileSync(join(REPO_ROOT, opsSkillDoc(skill)), 'utf8')
      expect(text).toContain(markers(skill.name).open)
    }
  })

  it('查词技能指着仓库里那份违禁词表,而那份表标明了哪一节非权威', () => {
    const skill = OPS_SKILLS.find(item => item.name === '运营-合规查词')
    expect(skill).toBeDefined()
    const text = readFileSync(join(REPO_ROOT, opsSkillDoc(skill as never)), 'utf8')
    expect(text).toContain(OPS_WORDLIST_DOC)
    const list = readFileSync(join(REPO_ROOT, OPS_WORDLIST_DOC), 'utf8')
    expect(list).toContain('非权威')
    expect(list).toContain('广告法')
  })
})

describe('正文:开头那段"这是怎么进 AGENTS.md 的"要摘掉', () => {
  it('H1 留着,紧跟的引用块摘掉,别处的引用块不动', () => {
    const body = opsSkillBody([
      '# 技能:X',
      '',
      '> 这份是事务官的技能,工作台会写进标记段。',
      '> 段外一个字不动。',
      '',
      '## 步骤',
      '',
      '> 他的原话:随便说,我记着。',
      '',
    ].join('\n'))
    expect(body).toContain('# 技能:X')
    expect(body).not.toContain('工作台会写进标记段')
    expect(body).toContain('> 他的原话:随便说,我记着。')
  })

  it('没有 H1、或者 H1 后面不是引用块时,原样回(不许乱剪他的文件)', () => {
    expect(opsSkillBody('就一行字')).toBe('就一行字')
    expect(opsSkillBody('# 标题\n\n正文')).toBe('# 标题\n\n正文')
  })
})

describe('写进临时 HOME 的 AGENTS.md', () => {
  it('运营模板:九段都进去了,他自己的内容一个字没动', async () => {
    const before = [
      '我叫小助。',
      '',
      '<!-- 引导:说话方式:开始 -->',
      '## 说话方式',
      '- 叫他「Ben」。',
      '<!-- 引导:说话方式:结束 -->',
      '',
    ].join('\n')
    const { file } = tempHome(before)
    const result = await wbOpsSkillsApply(DEPS, { file, templateId: 'ops', readDoc })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.written).toHaveLength(BASE_SKILLS.length + OPS_SKILLS.length)
    expect(result.missing).toEqual([])

    const after = readFileSync(file, 'utf8')
    // 他自己的两样原样在
    expect(after.startsWith('我叫小助。')).toBe(true)
    expect(after).toContain('- 叫他「Ben」。')
    // 九段都在,而且每一段里有那份技能的标题
    for (const skill of OPS_SKILLS) {
      expect(after).toContain(markers(skill.name).open)
      expect(after).toContain(markers(skill.name).close)
    }
    expect(after).toContain('选题/<选题名>/框架.md')
  })

  it('做产品模板:一段都不写;之前写过的会被摘干净,别的段原样留着', async () => {
    const { file } = tempHome('我叫小助。\n')
    const first = await wbOpsSkillsApply(DEPS, { file, templateId: 'ops', readDoc })
    expect(first.ok).toBe(true)
    // 别人家的技能段(派活卡那一段)也放一份进去,它不该被我们碰
    const withOther = `${readFileSync(file, 'utf8')}\n${wbSkillMergeInto('', '派活给别家Agent', '# 派活\n别动我')}\n`
    writeFileSync(file, withOther)

    const second = await wbOpsSkillsApply(DEPS, { file, templateId: 'product', readDoc })
    expect(second.ok).toBe(true)
    if (!second.ok) return
    // 做产品模板下写的是基础那几段 + 做产品那一包(2026-09-23),摘的是运营那几条。
    expect(second.written).toEqual([...BASE_SKILLS, ...PRODUCT_SKILLS].map(one => one.name))
    expect(second.removed).toHaveLength(OPS_SKILLS.length)

    const after = readFileSync(file, 'utf8')
    for (const skill of OPS_SKILLS) expect(after).not.toContain(markers(skill.name).open)
    expect(after).toContain('我叫小助。')
    expect(after).toContain('别动我')
  })

  it('接两次不会变成十六段,而且第二次一个字没变时连备份都不多留', async () => {
    const { home, file } = tempHome('我叫小助。\n')
    await wbOpsSkillsApply(DEPS, { file, templateId: 'ops', readDoc })
    const once = readFileSync(file, 'utf8')
    const backupsAfterFirst = readdirSync(home).filter(name => name.includes('bak-工作台')).length

    await wbOpsSkillsApply(DEPS, { file, templateId: 'ops', readDoc })
    const twice = readFileSync(file, 'utf8')
    expect(twice).toBe(once)
    // 内容一模一样 → 不写 → 不备份(见 wbSkillApply 里那一支)
    expect(readdirSync(home).filter(name => name.includes('bak-工作台')).length).toBe(backupsAfterFirst)
  })

  it('写之前先备份;备份里是改之前那一份', async () => {
    const { home, file } = tempHome('我叫小助。\n原来就有的一行。\n')
    const result = await wbOpsSkillsApply(DEPS, { file, templateId: 'ops', readDoc })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.backup_path).toBeDefined()
    const backups = readdirSync(home).filter(name => name.includes('bak-工作台'))
    // **一次 apply 只留一份备份**:八段是在内存里换完之后一次写回的,不是写八次。
    expect(backups).toHaveLength(1)
    expect(readFileSync(join(home, backups[0] as string), 'utf8')).toContain('原来就有的一行。')
  })

  it('仓库里那份文件读不到 → 那一段不写,如实回 missing(不写半份技能)', async () => {
    const { file } = tempHome('我叫小助。\n')
    const result = await wbOpsSkillsApply(DEPS, {
      file,
      templateId: 'ops',
      readDoc: async skill => (skill.name === '运营-合规查词' ? undefined : '# 技能\n\n正文'),
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.missing).toEqual(['运营-合规查词'])
    expect(result.written).toHaveLength(BASE_SKILLS.length + OPS_SKILLS.length - 1)
    expect(readFileSync(file, 'utf8')).not.toContain(markers('运营-合规查词').open)
  })

  it('文件本来就不存在:照样写,而且没有备份(没有东西可丢)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'wb-ops-skill-'))
    const file = join(home, 'AGENTS.md')
    const result = await wbOpsSkillsApply(DEPS, { file, templateId: 'ops', readDoc })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.backup_path).toBeUndefined()
    expect(readFileSync(file, 'utf8')).toContain(markers('运营-运营目标').open)
  })
})

describe('摘段这把刀', () => {
  it('只摘自己那一段,段前多余的空行跟着走', () => {
    const text = wbSkillMergeInto('我叫小助。\n', '运营-复盘', '# 复盘\n正文')
    const stripped = wbSkillRemoveFrom(text, '运营-复盘')
    expect(stripped.removed).toBe(true)
    expect(stripped.text).toBe('我叫小助。\n')
  })

  it('本来就没有这一段 → removed false,原文一个字不动', () => {
    const stripped = wbSkillRemoveFrom('我叫小助。\n', '运营-复盘')
    expect(stripped).toEqual({ text: '我叫小助。\n', removed: false })
  })
})

/**
 * 运营模板下《运营-总纲》《需求确认点》两段同时进 AGENTS.md(2026-10-04 收口)。
 * 「怎么问 / 问什么」只有一个主人 ——《需求确认点》(10-02 不复述、嘴里只一条;10-04 只问四类);
 * 运营那一包里任何一段再写一套别的问法,事务官就同时读到两套。读的是仓库里真的正文。
 */
describe('问话口径只有一条(《需求确认点》说了算)', () => {
  const STALE_ASK_RULES = /先复述|先把[^\n。]*复述|最多问三问|最多念 ?3 ?条/

  it('运营模板写进去的每一段,都不再有「先复述 / 先把…复述一遍 / 最多问三问 / 最多念 3 条」', () => {
    for (const skill of opsSkillsForTemplate('ops')) {
      const text = readFileSync(join(REPO_ROOT, opsSkillDoc(skill)), 'utf8')
      expect(text, `${skill.name} 里还留着旧问法`).not.toMatch(STALE_ASK_RULES)
    }
  })

  it('总纲「先问再做」那一节指回《需求确认点》,不另写一套', () => {
    const text = readFileSync(join(REPO_ROOT, 'docs/技能/运营-总纲.md'), 'utf8')
    const section = text.split('### 一、')[1]?.split('### 二、')[0] ?? ''
    expect(section).toContain(`《${CONFIRM_SKILL_NAME}》`)
  })

  it('《需求确认点》正文里嘴里问几条,与 CONFIRM_POINT_SPOKEN_MAX 对得上', () => {
    expect(CONFIRM_POINT_SPOKEN_MAX).toBe(1)
    const text = readFileSync(join(REPO_ROOT, `docs/技能/${CONFIRM_SKILL_NAME}.md`), 'utf8')
    expect(text).toContain('嘴里只说一条')
  })
})
