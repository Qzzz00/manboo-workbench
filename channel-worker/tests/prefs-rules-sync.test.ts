/**
 * ★ **「长期规矩」的认法不许再漂**(2026-10-22,卡「契约对照测试补齐」已漂的第二对)。
 *
 * 现场:同一份「以后都算数」的词表 —— 源头在插件
 * (`workbench-plugin/src/server/rules.ts` 的 `explicitRuleOf` 那张提示词正则),
 * 抄本在工人(`channel-worker/src/prefs.ts` 的 `LONG_TERM_WORDS` / `NEGATIVE_LONG_TERM_WORDS`)。
 * 两张表靠注释互相指着,没有用例守着,已经不同:工人有插件没有的
 * 「默认 / 总是 / 一直 / 每回 / 从今以后 / 从此 / 下次开始」,插件有工人没有的
 * 「一律 / 不许再 / 从今天起 / 记住」。
 *
 * 对齐口径(**以插件那份为源头**):工人那张表的词**只许多、不许少** —— 插件认的每一个
 * 长期提示词,工人这份都得有,只有一个是**故意例外**:`记住`。插件对「记住」是**条件认**
 * (`explicitRuleOf` 里要求「记住,」后面跟标点/空格、再接一个要求),而工人的 `judgePreference`
 * 是整句 contains 判定 —— 把「记住」放进去,「这个你记住」(指这一通里的一件事)就会被当成
 * 长期规矩写进人设,正是 09-23 那起事故的形状(`prefs.ts` 文件头)。所以这个例外是设计,
 * 不是漂移:下面对照测试把它钉成「唯一一个缺的词」。
 *
 * 这一份**直接读插件的源码**取提示词正则的交替项比对(顶层子目录互不 import,只能读文本;
 * 范本 `calendar-note-sync.test.ts`)。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { LONG_TERM_WORDS, NEGATIVE_LONG_TERM_WORDS } from '../src/prefs.ts'

const PLUGIN_RULES = join(import.meta.dirname, '..', '..', 'workbench-plugin', 'src', 'server', 'rules.ts')

/** 插件 `explicitRuleOf` 那张提示词正则里的词(按正则交替顺序)。 */
function pluginCueWords(): string[] {
  const source = readFileSync(PLUGIN_RULES, 'utf8')
  const hit = source.match(/\n\s*const hit = \/(.*?)\/u\.exec\(sentence\)/)
  expect(hit, '插件 rules.ts 里找不到 `const hit = /…/u.exec(sentence)` —— 它改名了?这一条要跟着改').not.toBeNull()
  // 交替项外面的那对括号也在捕获里,两边都剥掉。
  return (hit?.[1] ?? '').replace(/^\(/, '').replace(/\)$/, '').split('|').map(one => one.trim()).filter(one => one !== '')
}

describe('★ 长期规矩词表:插件那份是源头,工人这份只许多不许少(唯一例外:「记住」)', () => {
  it('读得到插件那张正则(扫描本身没坏)', () => {
    const words = pluginCueWords()
    expect(words.length).toBeGreaterThanOrEqual(10)
    expect(words).toContain('一律')
    expect(words).toContain('记住')
  })

  it('★ 插件的每一个长期提示词,工人这份都有(唯一允许缺的只有「记住」)', () => {
    const mine: readonly string[] = [...LONG_TERM_WORDS, ...NEGATIVE_LONG_TERM_WORDS]
    const missing = pluginCueWords().filter(word => word !== '记住' && !mine.includes(word))
    expect(missing, [
      '插件 rules.ts 认的长期提示词,工人 prefs.ts 没有 —— 以插件为源头,把词补进工人那份。',
      '（插件正则里 2026-10-22 对齐时工人缺的是:「一律 / 不许再 / 从今天起」。）',
    ].join('\n')).toEqual([])
  })

  it('★ 缺的只许是「记住」这一个(插件条件认,工人整句 contains,故意的例外,见本文件头)', () => {
    const mine: readonly string[] = [...LONG_TERM_WORDS, ...NEGATIVE_LONG_TERM_WORDS]
    expect(pluginCueWords().filter(word => !mine.includes(word))).toEqual(['记住'])
  })
})
