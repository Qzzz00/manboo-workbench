/**
 * 账号文件夹的读与写(2026-09-21「项目数据源换成账号」那张卡)。
 *
 * 一个账号 = 工作目录下 `账号/<账号名>/` 一个文件夹,里面:
 *   - `账号.md`:定位 / 风格 / 人群 / 平台 / 开号日期(引导 ②′ 记的答案落这里)
 *   - `笔记/`:一条笔记一个文件
 *
 * 这一份钉三件事:**文件长什么样**(人能看懂、能自己改)、**读回来是不是原样**、
 * **写第二次会不会把人手改过的东西弄没**(只改说到的那几个字段,别的一个字不碰)。
 *
 * 用的是真临时目录里的真文件 —— 这一层的价值全在"盘上到底有没有那个文件夹",
 * 拿假 fs 兜住的话等于没测(同 server-template-store 那一份的做法)。
 */
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ACCOUNTS_DIR_NAME, ACCOUNT_FIELDS, ACCOUNT_FILE_NAME, ACCOUNT_NOTES_DIR,
  accountsDir, listAccountNames, newAccountFile, readAccountFields, readAccountNotes,
  upsertAccountFields, writeAccount,
} from '../src/server/accounts.ts'

let cwd = ''

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'wb-accounts-'))
})

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true })
})

// ───────────────────────────────────────────────────────────────────────────
describe('① 账号.md 的样子', () => {
  it('五个字段按固定顺序写出来,没说的那几项写「待梳理」', () => {
    const text = newAccountFile('小食堂', { fields: { 平台: '小红书' }, date: '2026-09-21', origin: '引导访谈,Ben 口述' })
    expect(text.startsWith('# 小食堂\n')).toBe(true)
    const order = ACCOUNT_FIELDS.map(field => text.indexOf(`- **${field}**:`))
    expect(order.every(index => index > 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    expect(text).toContain('- **平台**:小红书')
    expect(text).toContain('- **定位**:待梳理')
  })

  it('建档那一笔带日期与依据,进「进展」节 —— **字段行里不带依据**', () => {
    const text = newAccountFile('小食堂', { fields: { 平台: '小红书' }, date: '2026-09-21', origin: '引导访谈,Ben 口述' })
    expect(text).toContain('- 2026-09-21:建档(引导访谈,Ben 口述)')
    // 字段行是给人改的,值就是值。记忆仓库里那种 `值(依据)` 的写法在这里会让
    // 项目区那一行显示成「小红书(引导访谈,Ben 口述,2026-09-21)」。
    expect(text).not.toContain('- **平台**:小红书(')
  })
})

describe('② 读回来', () => {
  it('写出去的值读回来一字不差', () => {
    const text = newAccountFile('小食堂', {
      fields: { 定位: '一个人做饭', 风格: '口播 + 实拍', 人群: '一人食的上班族', 平台: '小红书', 开号日期: '2025-03' },
      date: '2026-09-21',
      origin: '引导访谈',
    })
    expect(readAccountFields(text)).toEqual({
      定位: '一个人做饭', 风格: '口播 + 实拍', 人群: '一人食的上班族', 平台: '小红书', 开号日期: '2025-03',
    })
  })

  it('「待梳理」不算答案,整项缺席 —— 不许把占位词当成他说过的话', () => {
    const text = newAccountFile('小食堂', { fields: {}, date: '2026-09-21', origin: '引导访谈' })
    expect(readAccountFields(text)).toEqual({})
  })

  it('人手写的 `- **平台**: 抖音`(冒号后有空格、用半角冒号)也认', () => {
    expect(readAccountFields('# x\n\n- **平台**: 抖音\n')).toEqual({ 平台: '抖音' })
  })

  it('不认识的字段一律不收 —— 账号.md 是人改的,读到什么收什么会让界面冒出不该有的行', () => {
    expect(readAccountFields('# x\n\n- **粉丝数**:12000\n- **平台**:B 站\n')).toEqual({ 平台: 'B 站' })
  })
})

describe('③ 写第二次:只改说到的那几项', () => {
  it('补一个字段,别的字段与人手加的内容一个字不动', () => {
    const before = [
      '# 小食堂',
      '',
      '- **定位**:一个人做饭',
      '- **风格**:待梳理',
      '- **人群**:待梳理',
      '- **平台**:小红书',
      '- **开号日期**:待梳理',
      '',
      '## 我自己记的',
      '- 周三发效果最好',
      '',
    ].join('\n')
    const after = upsertAccountFields(before, { 风格: '口播' }, { date: '2026-09-21', origin: '引导访谈' })
    expect(after).toContain('- **风格**:口播')
    expect(after).toContain('- **定位**:一个人做饭')
    expect(after).toContain('- **平台**:小红书')
    // 人自己加的那一节原样留着。
    expect(after).toContain('## 我自己记的')
    expect(after).toContain('- 周三发效果最好')
  })

  it('改过的那几项在「进展」里留一行,说清是哪几项、依据是什么', () => {
    const before = newAccountFile('小食堂', { fields: {}, date: '2026-09-20', origin: '引导访谈' })
    const after = upsertAccountFields(before, { 平台: '抖音', 人群: '学生' }, { date: '2026-09-21', origin: '引导访谈,Ben 口述' })
    // 顺序按 ACCOUNT_FIELDS(定位/风格/人群/平台/开号日期),不是这次传进来的顺序 ——
    // 同一次改动在文件里永远长成同一个样子。
    expect(after).toContain('- 2026-09-21:记下 人群 / 平台(引导访谈,Ben 口述)')
  })

  it('一项都没变就不追加进展行 —— 没发生的事不许在文件里留痕', () => {
    const before = newAccountFile('小食堂', { fields: { 平台: '抖音' }, date: '2026-09-20', origin: '引导访谈' })
    const after = upsertAccountFields(before, { 平台: '抖音' }, { date: '2026-09-21', origin: '引导访谈' })
    expect(after).toBe(before)
  })
})

describe('④ 盘上的账号文件夹', () => {
  it('writeAccount 建出 账号/<名>/账号.md 与 笔记/', async () => {
    const result = await writeAccount(cwd, { name: '小食堂', fields: { 平台: '小红书' } }, { date: '2026-09-21', origin: '引导访谈' })
    expect(result.ok).toBe(true)
    expect(result.path).toBe(join(cwd, ACCOUNTS_DIR_NAME, '小食堂', ACCOUNT_FILE_NAME))
    expect(await readFile(result.path as string, 'utf8')).toContain('- **平台**:小红书')
    expect(await listAccountNames(accountsDir(cwd))).toEqual(['小食堂'])
    // 笔记文件夹一起建出来:空的 `笔记/` 比"以后自己会有"更清楚。
    expect(await readAccountNotes(join(cwd, ACCOUNTS_DIR_NAME, '小食堂'))).toEqual({ count: 0 })
  })

  it('同一个账号写两次不覆盖,只补字段', async () => {
    await writeAccount(cwd, { name: '小食堂', fields: { 平台: '小红书' } }, { date: '2026-09-20', origin: '引导访谈' })
    await writeAccount(cwd, { name: '小食堂', fields: { 定位: '一个人做饭' } }, { date: '2026-09-21', origin: '引导访谈' })
    const text = await readFile(join(cwd, ACCOUNTS_DIR_NAME, '小食堂', ACCOUNT_FILE_NAME), 'utf8')
    expect(readAccountFields(text)).toEqual({ 平台: '小红书', 定位: '一个人做饭' })
  })

  it('多个账号各是一个文件夹,按名字排序列出来', async () => {
    await writeAccount(cwd, { name: '小食堂', fields: { 平台: '小红书' } }, { date: '2026-09-21', origin: '引导' })
    await writeAccount(cwd, { name: '深夜书桌', fields: { 平台: '公众号' } }, { date: '2026-09-21', origin: '引导' })
    expect(await listAccountNames(accountsDir(cwd))).toEqual(['小食堂', '深夜书桌'])
  })

  it('账号名带路径分隔符 / `..` / 以点开头的,一律拒绝,**一个文件夹都不建**', async () => {
    for (const name of ['../跑出去', 'a/b', '.隐藏', '']) {
      const result = await writeAccount(cwd, { name, fields: { 平台: 'x' } }, { date: '2026-09-21', origin: '引导' })
      expect(result.ok).toBe(false)
      expect(result.reason).toBeTypeOf('string')
    }
    expect(await listAccountNames(accountsDir(cwd))).toEqual([])
  })

  it('账号文件夹还不存在时列出来是空的 —— 那不是错,是「还没有账号」', async () => {
    expect(await listAccountNames(accountsDir(cwd))).toEqual([])
  })

  it('文件夹里的文件(不是目录)、点开头的目录都不算账号', async () => {
    await mkdir(accountsDir(cwd), { recursive: true })
    await writeFile(join(accountsDir(cwd), '随手记.md'), 'x', 'utf8')
    await mkdir(join(accountsDir(cwd), '.DS_Store_dir'), { recursive: true })
    await mkdir(join(accountsDir(cwd), '真账号'), { recursive: true })
    expect(await listAccountNames(accountsDir(cwd))).toEqual(['真账号'])
  })
})

describe('⑤ 笔记', () => {
  it('数条数,最近那条的日期取文件名前面那段 YYYY-MM-DD', async () => {
    const dir = join(cwd, ACCOUNTS_DIR_NAME, '小食堂')
    await mkdir(join(dir, ACCOUNT_NOTES_DIR), { recursive: true })
    await writeFile(join(dir, ACCOUNT_NOTES_DIR, '2026-09-18-番茄面.md'), 'x', 'utf8')
    await writeFile(join(dir, ACCOUNT_NOTES_DIR, '2026-09-20-煎蛋.md'), 'x', 'utf8')
    expect(await readAccountNotes(dir)).toEqual({ count: 2, lastAt: '2026-09-20' })
  })

  it('文件名里没有日期的那几条:落回文件自己的修改时间,**不丢、也不编一个日期**', async () => {
    const dir = join(cwd, ACCOUNTS_DIR_NAME, '小食堂')
    await mkdir(join(dir, ACCOUNT_NOTES_DIR), { recursive: true })
    await writeFile(join(dir, ACCOUNT_NOTES_DIR, '随便起的名字.md'), 'x', 'utf8')
    const notes = await readAccountNotes(dir)
    expect(notes.count).toBe(1)
    expect(notes.lastAt).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('没有笔记文件夹 = 0 条、没有日期(**不是错**)', async () => {
    const dir = join(cwd, ACCOUNTS_DIR_NAME, '小食堂')
    await mkdir(dir, { recursive: true })
    expect(await readAccountNotes(dir)).toEqual({ count: 0 })
  })
})
