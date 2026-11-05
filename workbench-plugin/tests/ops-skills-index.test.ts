/**
 * **说明书改成「索引进 AGENTS.md,正文落盘按需读」**(2026-10-02,卡「事务官为什么要跑这么多步」)。
 *
 * ## 为什么
 *
 * 量过本机真实会话记录:每开一条事务官会话,`~/.dsh/AGENTS.md` 都以
 * `source:'agent-instructions'` 整摊注进第一轮上下文 —— 维护者那台(做产品模板)**18736~21120 字**,
 * 10-01 那条已经 **27239 字**(9 段、149 处接口说明)。Air 上运营模板还多十段。
 * 而**一件事最多用得上一条**:「来来来。」那一通用得上 0 条,照样先读了 18736 字的规矩,
 * 然后去 `ls ~/.dsh/skills`、试探 13 个接口。
 *
 * 10-02 那张「她的偏好页」已经把这摊**从她眼前**收起来了(页底只读、默认收起);
 * 这一张把同一条做在**机器那一侧**:AGENTS.md 里只留索引(H1 + 一句 summary + 正文在哪),
 * 正文落 `~/.dsh/workbench/技能/<段名>.md`,**要用那一条才读那一份**。
 *
 * ## 两条不许动
 *
 * 1. **她的偏好照旧在段里**(每次都注进去)—— 那是她的意思,不是机器说明书;
 * 2. **宿主给不了 mkdirp(老实现)→ 照旧整段正文写进 AGENTS.md**,一个字不变。
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BASE_SKILLS, opsSkillBody, opsSkillIndexEntry, opsSkillsAttachState, opsSkillsForTemplate } from '../src/server/opsSkills.ts'
import { skillBodyFile } from '../src/server/bundledSkills.ts'
import type { WbHooksApplyIo } from '../src/server/hooksApply.ts'
import { wbOpsSkillsApply } from '../src/server/hooksApply.ts'
import { readMarkedBlock } from '../src/server/memoryMd.ts'
import { nodeSetupIo } from '../src/server/setup/io.ts'

/** 一份够长的假正文:像真技能那样带 H1、带给改技能的人看的那段引号说明。 */
function doc(name: string): string {
  return [
    `# 技能:${name}`,
    '',
    '> 这份是**事务官的技能**。工作台会把它整段写进 `~/.dsh/AGENTS.md`。',
    '',
    '## 步骤',
    '',
    `POST /dispatch/run { "family": "codex" }`,
    'X'.repeat(3000),
  ].join('\n')
}

const NOW = (): Date => new Date('2026-10-02T12:00:00Z')

/** 真盘上的一个临时家目录(同兄弟用例 `server-ops-skills.test.ts` 的做法)。 */
function tempHome(agents?: string): { home: string, file: string } {
  const home = mkdtempSync(join(tmpdir(), 'wb-skill-index-'))
  const file = join(home, 'AGENTS.md')
  if (agents !== undefined) writeFileSync(file, agents)
  return { home, file }
}

/** 老宿主:io 里没有 mkdirp。 */
function ioWithoutMkdirp(): WbHooksApplyIo {
  const { mkdirp: _drop, ...rest } = nodeSetupIo()
  return { io: rest, now: NOW }
}

const NAMES = BASE_SKILLS.map(one => one.name)

describe('AGENTS.md 只留索引,正文落盘', () => {
  const DEPS: WbHooksApplyIo = { io: nodeSetupIo(), now: NOW }

  it('段里是 H1 + 一句 summary + 正文在哪;3000 字的正文不在段里', async () => {
    const { home, file } = tempHome('我叫 拓麻鸽子。\n')
    const done = await wbOpsSkillsApply(DEPS, {
      file,
      templateId: 'product',
      readDoc: async skill => doc(skill.name),
      bodyFile: name => skillBodyFile(home, name),
    })
    expect(done.ok).toBe(true)

    const text = readFileSync(file, 'utf8')
    for (const name of NAMES) {
      const block = readMarkedBlock(text, name)
      expect(block, name).toBeDefined()
      const summary = BASE_SKILLS.find(one => one.name === name)?.summary ?? ''
      expect(block).toContain(summary)
      expect(block).toContain(skillBodyFile(home, name))
      // 正文那 3000 个 X 一个都不许进 AGENTS.md。
      expect(block).not.toContain('X'.repeat(50))
    }
    // 整份文件瘦下来了:每段不到 400 字。
    expect(text.length).toBeLessThan(400 * NAMES.length + 200)
  })

  it('正文原样落在 ~/.dsh/workbench/技能/<段名>.md,接口说明都在那一份里', async () => {
    const { home, file } = tempHome('')
    await wbOpsSkillsApply(DEPS, {
      file,
      templateId: 'product',
      readDoc: async skill => doc(skill.name),
      bodyFile: name => skillBodyFile(home, name),
    })
    for (const name of NAMES) {
      const body = await readFile(skillBodyFile(home, name), 'utf8')
      expect(body).toContain('POST /dispatch/run')
      // 落盘那一份也是摘掉"给改技能的人看"那段之后的正文(同 `opsSkillBody`)。
      expect(body).toBe(opsSkillBody(doc(name)))
    }
  })

  it('★ 索引里指的那个路径,盘上真有那一份(指针与东西必须对上)', async () => {
    const { home, file } = tempHome('')
    await wbOpsSkillsApply(DEPS, {
      file,
      templateId: 'product',
      readDoc: async skill => doc(skill.name),
      bodyFile: name => skillBodyFile(home, name),
    })
    const text = readFileSync(file, 'utf8')
    const paths = [...text.matchAll(/(\S+\/\.dsh\/workbench\/技能\/[^\s)、。]+\.md)/g)].map(one => one[1] as string)
    expect(paths.length).toBe(opsSkillsForTemplate('product').length)
    for (const one of paths) expect(existsSync(one), one).toBe(true)
  })

  it('照旧接得上(段数不变),幂等:同样的输入第二遍不写盘', async () => {
    const { home, file } = tempHome('')
    const input = {
      file,
      templateId: 'product' as const,
      readDoc: async (skill: { name: string }) => doc(skill.name),
      bodyFile: (name: string) => skillBodyFile(home, name),
    }
    const first = await wbOpsSkillsApply(DEPS, input)
    expect(first.ok && first.changed).toBe(true)
    expect(opsSkillsAttachState(readFileSync(file, 'utf8'), 'product').ok).toBe(true)
    const second = await wbOpsSkillsApply(DEPS, input)
    expect(second.ok && second.changed).toBe(false)
  })

  it('★ 宿主给不了落盘的本事(没有 bodyFile)→ 照旧整段正文进 AGENTS.md', async () => {
    const { file } = tempHome('')
    await wbOpsSkillsApply(DEPS, {
      file,
      templateId: 'product',
      readDoc: async skill => doc(skill.name),
    })
    const block = readMarkedBlock(readFileSync(file, 'utf8'), '派活给别家Agent')
    expect(block).toContain('X'.repeat(50))
    expect(block).toContain('POST /dispatch/run')
  })

  it('★ 老宿主的 io 没有 mkdirp → 也照旧整段正文,不静默丢掉正文', async () => {
    const { home, file } = tempHome('')
    await wbOpsSkillsApply(ioWithoutMkdirp(), {
      file,
      templateId: 'product',
      readDoc: async skill => doc(skill.name),
      bodyFile: name => skillBodyFile(home, name),
    })
    const block = readMarkedBlock(readFileSync(file, 'utf8'), '派活给别家Agent')
    expect(block).toContain('X'.repeat(50))
    expect(existsSync(skillBodyFile(home, '派活给别家Agent'))).toBe(false)
  })

  it('★ 正文写不进盘(权限)→ 这一段退回整段正文,不留一个指向空位置的指针', async () => {
    const { home, file } = tempHome('')
    const io = nodeSetupIo()
    const deps: WbHooksApplyIo = {
      now: NOW,
      io: {
        ...io,
        writeFile: async (path: string, text: string) => {
          if (path.includes('/技能/')) throw new Error('写不进去')
          await io.writeFile(path, text)
        },
      },
    }
    await wbOpsSkillsApply(deps, {
      file,
      templateId: 'product',
      readDoc: async skill => doc(skill.name),
      bodyFile: name => skillBodyFile(home, name),
    })
    const block = readMarkedBlock(readFileSync(file, 'utf8'), '派活给别家Agent')
    expect(block).toContain('X'.repeat(50))
  })
})

describe('opsSkillIndexEntry', () => {
  it('索引一段 = H1 + summary + 正文在哪 + 「不属于这一条就别读」', () => {
    const skill = BASE_SKILLS[0]
    expect(skill).toBeDefined()
    const entry = opsSkillIndexEntry(skill as typeof BASE_SKILLS[number], '/x/y.md')
    expect(entry).toContain(`# 技能:${(skill as typeof BASE_SKILLS[number]).name}`)
    expect(entry).toContain((skill as typeof BASE_SKILLS[number]).summary)
    expect(entry).toContain('/x/y.md')
    expect(entry).toContain('不属于这一条就别读')
    // 短:一段索引不该超过 300 字。
    expect(entry.length).toBeLessThan(300)
  })
})
