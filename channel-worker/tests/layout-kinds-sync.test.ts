/**
 * ★ **电话里改布局那几种动作不许再漂**(2026-10-22,卡「契约对照测试补齐」)。
 *
 * 现场:同一份「事务官能对布局做什么」的枚举 —— 源头在插件
 * (`workbench-plugin/src/protocol.ts` 的 `LAYOUT_ACT_KINDS`,七个 kind 就是全集),
 * 抄本在工人(`channel-worker/src/tools.ts` 的 `LAYOUT_KINDS`,注释「与 8791 的
 * LAYOUT_ACT_KINDS 同一份;工作台认不出的一律 400」)。靠注释互相指着,没有用例守着。
 *
 * 这一份**直接读插件的源码**取那张表比对(顶层子目录互不 import,只能读文本;
 * 范本 `calendar-note-sync.test.ts`)。漂了这条红给你看。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { LAYOUT_KINDS } from '../src/tools.ts'

const PLUGIN_PROTOCOL = join(import.meta.dirname, '..', '..', 'workbench-plugin', 'src', 'protocol.ts')

/** 插件 `LAYOUT_ACT_KINDS = [ … ]` 那张表(按源码顺序)。 */
function pluginLayoutKinds(): string[] {
  const source = readFileSync(PLUGIN_PROTOCOL, 'utf8')
  const hit = source.match(/export const LAYOUT_ACT_KINDS = \[([^\]]*)\]/)
  expect(hit, '插件 protocol.ts 里找不到 `LAYOUT_ACT_KINDS = [ … ]` —— 它改名了?这一条要跟着改').not.toBeNull()
  return [...(hit?.[1] ?? '').matchAll(/'([^']*)'/g)].map(one => one[1] as string)
}

describe('★ 改布局动作:插件那份是源头(七个 kind 就是全集),工人这份同一份', () => {
  it('读得到插件那张表(扫描本身没坏)', () => {
    expect(pluginLayoutKinds()).toEqual(['move', 'region', 'hide', 'show', 'rename', 'resize', 'swap'])
  })

  it('★ 工人 LAYOUT_KINDS 与插件 LAYOUT_ACT_KINDS 同一份(漂了就把两边收成一样)', () => {
    expect([...LAYOUT_KINDS]).toEqual(pluginLayoutKinds())
  })
})
