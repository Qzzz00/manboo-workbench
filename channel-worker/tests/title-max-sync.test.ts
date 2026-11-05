/**
 * ★ **卡标题的字数上限不许再漂**(2026-10-22,卡「契约对照测试补齐」)。
 *
 * 现场:同一件事「标题取第一行、超 40 字截断加『…』」两份 —— 源头在插件
 * (`workbench-plugin/src/server/butlerItem.ts` 的 `MAX_TITLE`),抄本在工人
 * (`channel-worker/src/remember.ts` 的 `NOTE_TITLE_MAX`,注释「与 8791 butlerItemFields 的
 * MAX_TITLE 同一个数」)。靠注释互相指着,没有用例守着。
 *
 * 这一份**直接读插件的源码**取 MAX_TITLE 的值比对(顶层子目录互不 import,只能读文本;
 * 范本 `calendar-note-sync.test.ts`)。漂了这条红给你看。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { NOTE_TITLE_MAX } from '../src/remember.ts'

const PLUGIN_BUTLER_ITEM = join(import.meta.dirname, '..', '..', 'workbench-plugin', 'src', 'server', 'butlerItem.ts')

/** 插件 `butlerItemFields` 的 `MAX_TITLE` 那个数。 */
function pluginMaxTitle(): number {
  const source = readFileSync(PLUGIN_BUTLER_ITEM, 'utf8')
  const hit = source.match(/const MAX_TITLE = (\d+)/)
  expect(hit, '插件 butlerItem.ts 里找不到 `const MAX_TITLE = …` —— 它改名了?这一条要跟着改').not.toBeNull()
  return Number(hit?.[1])
}

describe('★ 卡标题上限:插件那份是源头(40 字截断),工人这份同一个数', () => {
  it('读得到插件那一位(扫描本身没坏)', () => {
    expect(pluginMaxTitle()).toBe(40)
  })

  it('★ 工人 NOTE_TITLE_MAX 与插件 MAX_TITLE 同一个数(漂了就把两边收成一样)', () => {
    expect(NOTE_TITLE_MAX).toBe(pluginMaxTitle())
  })
})
