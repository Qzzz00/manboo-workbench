/**
 * ★ **通话里一句话最长多少字不许再漂**(2026-10-22,卡「契约对照测试补齐」)。
 *
 * 现场:同一纪律「电话里每一句都短,25 字一句」的源头在插件
 * (`workbench-plugin/src/server/demoPlaybook.ts` 的 `DEMO_SAY_MAX_CHARS`,2026-10-13 早真机
 * 上一句长话被 TTS 流卡住截断),工人这份抄了三处:`callOut.ts` 的 `IN_CALL_SAY_MAX_CHARS`
 * (通话里插的那一句)、`understand.ts` 的 `ANSWER_ASK_SAY_MAX_CHARS` 与 `SAY_FIRST_FAIL_MAX_CHARS`
 * (都注释「同 DEMO_SAY_MAX_CHARS」)。靠注释互相指着,没有用例守着。
 *
 * 这一份**直接读插件的源码**取那个数比对(顶层子目录互不 import,只能读文本;
 * 范本 `calendar-note-sync.test.ts`)。漂了这条红给你看。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { IN_CALL_SAY_MAX_CHARS } from '../src/callOut.ts'
import { ANSWER_ASK_SAY_MAX_CHARS, SAY_FIRST_FAIL_MAX_CHARS } from '../src/understand.ts'

const PLUGIN_PLAYBOOK = join(import.meta.dirname, '..', '..', 'workbench-plugin', 'src', 'server', 'demoPlaybook.ts')

/** 插件 `DEMO_SAY_MAX_CHARS` 那个数。 */
function pluginDemoSayMax(): number {
  const source = readFileSync(PLUGIN_PLAYBOOK, 'utf8')
  const hit = source.match(/export const DEMO_SAY_MAX_CHARS = (\d+)/)
  expect(hit, '插件 demoPlaybook.ts 里找不到 `DEMO_SAY_MAX_CHARS = …` —— 它改名了?这一条要跟着改').not.toBeNull()
  return Number(hit?.[1])
}

describe('★ 电话里一句话最长多少字:插件那份是源头(25 字),工人这份同一纪律', () => {
  it('读得到插件那一位(扫描本身没坏)', () => {
    expect(pluginDemoSayMax()).toBe(25)
  })

  it('★ 插话那半句:工人 IN_CALL_SAY_MAX_CHARS 与插件 DEMO_SAY_MAX_CHARS 同一个数', () => {
    expect(IN_CALL_SAY_MAX_CHARS).toBe(pluginDemoSayMax())
  })

  it('★ 同一纪律还抄在另两处(注释都指着 DEMO_SAY_MAX_CHARS):答挂着那一问 / 派活没成补句', () => {
    expect(ANSWER_ASK_SAY_MAX_CHARS).toBe(pluginDemoSayMax())
    expect(SAY_FIRST_FAIL_MAX_CHARS).toBe(pluginDemoSayMax())
  })
})
