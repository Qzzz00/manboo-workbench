/**
 * ★ **「记到日历 / 记进发布计划」的认法不许再漂**(2026-10-22,卡「试跑-记日历认法对照」,
 * `docs/卡/试跑-记日历认法对照.md`;契约对照测试补齐里已漂的第一对)。
 *
 * 现场:同一句「记到日历 / 记进发布计划」两张正则 —— 源头在插件
 * (`workbench-plugin/src/server/understand.ts` 的 `CALENDAR_NOTE_CUE`),抄本在工人
 * (`channel-worker/src/remember.ts` 的 `CALENDAR_NOTE`)—— 靠注释互相指着,没有用例守着,
 * 已经不一样:工人这份多了一段 `发布计划里?(?:记|加|排)`,「发布计划里记一下」工人认、插件不认。
 *
 * 这一份**直接读插件的源码**比对字面量(顶层子目录互不 import,所以只能读文本;范本
 * `agent-name-sync.test.ts`)。对齐后的口径:两张正则**逐字相同**,工人照抄源头;
 * 哪一份要加认法,改源头再把这一份收成一样 —— 漂了这条红给你看。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CALENDAR_NOTE, looksLikeCalendarNote } from '../src/remember.ts'

const PLUGIN_UNDERSTAND = join(import.meta.dirname, '..', '..', 'workbench-plugin', 'src', 'server', 'understand.ts')

/** 取出插件 `CALENDAR_NOTE_CUE = /…/u` 那一张正则的 source(字面量本体,不含两条斜杠与 flag)。 */
function pluginCalendarNoteSource(): string {
  const source = readFileSync(PLUGIN_UNDERSTAND, 'utf8')
  const hit = source.match(/const CALENDAR_NOTE_CUE = \/(.*)\/([a-z]*)\s*\n/)
  expect(hit, '插件 understand.ts 里找不到 `CALENDAR_NOTE_CUE = /…/` —— 它改名了?这一条要跟着改').not.toBeNull()
  expect(hit?.[2], '插件那张正则的 flag 变了(不再是 /u)—— 两边 flag 也要一致,这一条要跟着改').toBe(CALENDAR_NOTE.flags.replace(/[^a-z]/g, ''))
  return hit?.[1] as string
}

describe('★ 记日历认法:插件那份是源头,工人这份照抄(逐字相同)', () => {
  it('读得到插件那张正则(扫描本身没坏)', () => {
    const source = pluginCalendarNoteSource()
    expect(source.length).toBeGreaterThan(0)
    expect(source).toContain('日历')
    expect(source).toContain('发布计划')
  })

  it('★ 工人 CALENDAR_NOTE 与插件 CALENDAR_NOTE_CUE 的 source 逐字相同(漂了就把两边收成一样)', () => {
    expect(
      CALENDAR_NOTE.source,
      [
        'channel-worker/src/remember.ts 的 CALENDAR_NOTE 与插件 understand.ts 的 CALENDAR_NOTE_CUE 漂了。',
        '插件那份是源头:改它,再把这一份改成与它逐字相同(含这一条的本行为用例)。',
      ].join('\n'),
    ).toBe(pluginCalendarNoteSource())
  })

  it('★「发布计划里记一下」这一句认(2026-10-22 对齐时从工人那份并回源头的那一段)', () => {
    expect(looksLikeCalendarNote('发布计划里记一下')).toBe(true)
  })
})
