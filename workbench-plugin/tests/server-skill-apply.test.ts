// @vitest-environment node
/**
 * 技能段进 `~/.dsh/AGENTS.md`(2026-09-21,参赛冲刺卡 ④)。
 *
 * 机制与「说话方式」一模一样:一个标记段,段内整段重写,**段外一个字不动**。
 * 这一份用例守的就是"段外一个字不动"与"写前必有备份"这两条 —— 它写的是**用户家目录里的
 * 事务官人设文件**,写坏了的后果是事务官换了个人格,而他看不出是哪一步改的。
 *
 * 全部在 `mkdtemp` 出来的临时 HOME 里跑:**一个字节都不会碰真实的 ~/.dsh**
 * (2026-09-04 家目录被删事故之后的纪律;这条尤其要紧 —— 真的 ~/.dsh 是生产目录,
 * 授权表里「永远不动」那一节点了名的)。
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { nodeSetupIo } from '../src/server/setup/io.ts'
import { WB_HOOKS_BACKUP_TAG, WB_SKILL_DISPATCH, wbSkillApply, wbSkillMergeInto, wbSkillRemoveFrom, wbSkillRevert } from '../src/server/hooksApply.ts'
import { markers, readMarkedBlock } from '../src/server/memoryMd.ts'

const dirs: string[] = []
afterEach(() => { while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true }) })

/** 一个假的 HOME,里面有 `.dsh/AGENTS.md`。**这是这份用例唯一碰得到的盘**。 */
function fakeHome(agentsText?: string): { home: string, file: string } {
  const home = mkdtempSync(join(tmpdir(), 'wb-skill-home-'))
  dirs.push(home)
  mkdirSync(join(home, '.dsh'), { recursive: true })
  const file = join(home, '.dsh', 'AGENTS.md')
  if (agentsText !== undefined) writeFileSync(file, agentsText, 'utf8')
  return { home, file }
}

const deps = { io: nodeSetupIo(), now: () => new Date('2026-09-21T10:11:12') }

/** 引导写过的那一份:首行名字 + 「说话方式」标记段。技能段进来之后这两样**一个字不能变**。 */
const EXISTING = [
  '我叫 小柯。',
  '',
  '# 事务官',
  '',
  '<!-- 引导:说话方式:开始 -->',
  '叫他「Ben」。说人话,不用英文词。',
  '<!-- 引导:说话方式:结束 -->',
  '',
].join('\n')

describe('合并:只动自己那一段', () => {
  it('段落是标记包起来的,读得回来', () => {
    const merged = wbSkillMergeInto(EXISTING, WB_SKILL_DISPATCH, '技能正文若干。')
    expect(readMarkedBlock(merged, WB_SKILL_DISPATCH)).toBe('技能正文若干。')
    expect(merged).toContain(markers(WB_SKILL_DISPATCH).open)
  })

  it('**段外一个字不动**:首行名字与「说话方式」原样还在', () => {
    const merged = wbSkillMergeInto(EXISTING, WB_SKILL_DISPATCH, '技能正文若干。')
    expect(merged.split('\n')[0]).toBe('我叫 小柯。')
    expect(readMarkedBlock(merged, '说话方式')).toBe('叫他「Ben」。说人话,不用英文词。')
  })

  it('幂等:写两遍还是一段,不是两段', () => {
    const once = wbSkillMergeInto(EXISTING, WB_SKILL_DISPATCH, '第一版')
    const twice = wbSkillMergeInto(once, WB_SKILL_DISPATCH, '第二版')
    const opens = twice.split(markers(WB_SKILL_DISPATCH).open).length - 1
    expect(opens).toBe(1)
    expect(readMarkedBlock(twice, WB_SKILL_DISPATCH)).toBe('第二版')
  })

  it('文件还不存在 → 不凭空造一个 H1 出来(那会占掉引导要写的首行)', () => {
    const merged = wbSkillMergeInto(undefined, WB_SKILL_DISPATCH, '技能正文')
    expect(merged.startsWith('#')).toBe(false)
    expect(readMarkedBlock(merged, WB_SKILL_DISPATCH)).toBe('技能正文')
  })
})

describe('摘掉:只摘自己那一段', () => {
  it('摘完段外照旧', () => {
    const merged = wbSkillMergeInto(EXISTING, WB_SKILL_DISPATCH, '技能正文')
    const stripped = wbSkillRemoveFrom(merged, WB_SKILL_DISPATCH)
    expect(stripped.removed).toBe(true)
    expect(readMarkedBlock(stripped.text, WB_SKILL_DISPATCH)).toBeUndefined()
    expect(readMarkedBlock(stripped.text, '说话方式')).toBe('叫他「Ben」。说人话,不用英文词。')
    expect(stripped.text.split('\n')[0]).toBe('我叫 小柯。')
  })

  it('本来就没有这一段 → 原样回,removed 是 false', () => {
    const stripped = wbSkillRemoveFrom(EXISTING, WB_SKILL_DISPATCH)
    expect(stripped.removed).toBe(false)
    expect(stripped.text).toBe(EXISTING)
  })
})

describe('真写盘(临时 HOME)', () => {
  it('头一次:文件已有内容 → 先备份,再写;备份里是**原文**', async () => {
    const { home, file } = fakeHome(EXISTING)
    const result = await wbSkillApply(deps, { file, name: WB_SKILL_DISPATCH, body: '技能正文 v1' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.block).toBe('added')
    expect(result.backup_path).toBeDefined()
    expect(readFileSync(result.backup_path as string, 'utf8')).toBe(EXISTING)
    expect(readMarkedBlock(readFileSync(file, 'utf8'), WB_SKILL_DISPATCH)).toBe('技能正文 v1')
    // 备份文件在同一个目录里,名字里带着那个中文中缀(Ben 在 Finder 里认得出)。
    const names = readdirSync(join(home, '.dsh'))
    expect(names.some(name => name.includes(WB_HOOKS_BACKUP_TAG))).toBe(true)
  })

  it('再写一遍同样的内容 → **不写、不备份**(他的目录里不该每次重启多一个 .bak)', async () => {
    const { home, file } = fakeHome(EXISTING)
    await wbSkillApply(deps, { file, name: WB_SKILL_DISPATCH, body: '技能正文 v1' })
    const before = readdirSync(join(home, '.dsh')).length
    const again = await wbSkillApply(deps, { file, name: WB_SKILL_DISPATCH, body: '技能正文 v1' })
    expect(again.ok).toBe(true)
    if (!again.ok) return
    expect(again.backup_path).toBeUndefined()
    expect(readdirSync(join(home, '.dsh')).length).toBe(before)
  })

  it('改了内容 → 换段(replaced),旧的那一段不并存', async () => {
    const { file } = fakeHome(EXISTING)
    await wbSkillApply(deps, { file, name: WB_SKILL_DISPATCH, body: '技能正文 v1' })
    const result = await wbSkillApply(deps, { file, name: WB_SKILL_DISPATCH, body: '技能正文 v2' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.block).toBe('replaced')
    const text = readFileSync(file, 'utf8')
    expect(readMarkedBlock(text, WB_SKILL_DISPATCH)).toBe('技能正文 v2')
    expect(text).not.toContain('技能正文 v1')
  })

  it('正文是空的 → **一个字都不写**(半份技能比没有技能更坏)', async () => {
    const { file } = fakeHome(EXISTING)
    const result = await wbSkillApply(deps, { file, name: WB_SKILL_DISPATCH, body: '   \n  ' })
    expect(result.ok).toBe(false)
    expect(readFileSync(file, 'utf8')).toBe(EXISTING)
  })

  it('文件本来就不存在 → 建出来,没有备份(没有东西可丢)', async () => {
    const { file } = fakeHome()
    const result = await wbSkillApply(deps, { file, name: WB_SKILL_DISPATCH, body: '技能正文' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.backup_path).toBeUndefined()
    expect(readMarkedBlock(readFileSync(file, 'utf8'), WB_SKILL_DISPATCH)).toBe('技能正文')
  })

  it('撤回:摘掉那一段,「说话方式」与首行一个字不动', async () => {
    const { file } = fakeHome(EXISTING)
    await wbSkillApply(deps, { file, name: WB_SKILL_DISPATCH, body: '技能正文' })
    const reverted = await wbSkillRevert(deps, { file, name: WB_SKILL_DISPATCH })
    expect(reverted.ok).toBe(true)
    if (!reverted.ok) return
    expect(reverted.removed).toBe(true)
    const text = readFileSync(file, 'utf8')
    expect(readMarkedBlock(text, WB_SKILL_DISPATCH)).toBeUndefined()
    expect(readMarkedBlock(text, '说话方式')).toBe('叫他「Ben」。说人话,不用英文词。')
    expect(text.split('\n')[0]).toBe('我叫 小柯。')
  })

  it('撤回一件没做过的事 → 不写、不备份(不在他家目录里多留一个文件)', async () => {
    const { home, file } = fakeHome(EXISTING)
    const reverted = await wbSkillRevert(deps, { file, name: WB_SKILL_DISPATCH })
    expect(reverted.ok).toBe(true)
    if (!reverted.ok) return
    expect(reverted.removed).toBe(false)
    expect(readdirSync(join(home, '.dsh'))).toEqual(['AGENTS.md'])
  })
})

/**
 * 2026-10-02(卡「事务官为什么要跑这么多步」):给了 `bodyFile` 就**正文落盘、段里只留索引**。
 * 两条写路(起服务那条 `wbOpsSkillsApply` 与设置里那颗按钮这条)写出来的那一段必须**同形** ——
 * 不然她在设置里点一次「接上」,5839 字的派活正文就又回到 AGENTS.md 里。
 */
describe('给了 bodyFile:正文落盘,段里只留索引', () => {
  it('段里有正文路径、没有正文;正文在那个路径上', async () => {
    const { home, file } = fakeHome(EXISTING)
    const bodyFile = join(home, '.dsh', 'workbench', '技能', `${WB_SKILL_DISPATCH}.md`)
    const result = await wbSkillApply(deps, {
      file,
      name: WB_SKILL_DISPATCH,
      body: `# 技能:派活给别家 Agent\n\nPOST /dispatch/run\n${'X'.repeat(3000)}`,
      bodyFile,
    })
    expect(result.ok).toBe(true)
    const block = readMarkedBlock(readFileSync(file, 'utf8'), WB_SKILL_DISPATCH) ?? ''
    expect(block).toContain(bodyFile)
    expect(block).not.toContain('X'.repeat(50))
    expect(readFileSync(bodyFile, 'utf8')).toContain('POST /dispatch/run')
    // 段外她自己的东西一个字不动(这一份用例最老的那条纪律)。
    expect(readFileSync(file, 'utf8')).toContain(EXISTING.trim())
  })

  it('★ 没给 bodyFile → 照旧整段正文进 AGENTS.md(她那几项人话走的就是这一支)', async () => {
    const { file } = fakeHome(EXISTING)
    await wbSkillApply(deps, { file, name: WB_SKILL_DISPATCH, body: `正文 ${'X'.repeat(100)}` })
    expect(readMarkedBlock(readFileSync(file, 'utf8'), WB_SKILL_DISPATCH)).toContain('X'.repeat(100))
  })

  it('★ 认不出的段名(她手写的那种)→ 不敢替她换成索引,照旧整段写', async () => {
    const { home, file } = fakeHome(EXISTING)
    await wbSkillApply(deps, {
      file,
      name: '她自己加的一段',
      body: `正文 ${'X'.repeat(100)}`,
      bodyFile: join(home, '.dsh', 'workbench', '技能', '她自己加的一段.md'),
    })
    expect(readMarkedBlock(readFileSync(file, 'utf8'), '她自己加的一段')).toContain('X'.repeat(100))
  })
})
