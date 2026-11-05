/**
 * ★ **电话里最多念几条确认点不许再漂**(2026-10-22,卡「契约对照测试补齐」)。
 *
 * 现场:同一件事「电话里只念最要紧的那一条」两份 —— 源头在插件
 * (`workbench-plugin/src/server/confirmPoints.ts` 的 `CONFIRM_POINT_SPOKEN_MAX`,2026-10-02
 * 从 3 改成 1),抄本在工人(`channel-worker/src/confirm.ts` 的 `SPOKEN_MAX`,注释「8791 那边的
 * CONFIRM_POINT_SPOKEN_MAX 同日同改,两边对不上时以回包为准」)。靠注释互相指着,没有用例守着。
 *
 * 这一份**直接读插件的源码**取那个数比对(顶层子目录互不 import,只能读文本;
 * 范本 `calendar-note-sync.test.ts`)。漂了这条红给你看。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SPOKEN_MAX } from '../src/confirm.ts'

const PLUGIN_CONFIRM_POINTS = join(import.meta.dirname, '..', '..', 'workbench-plugin', 'src', 'server', 'confirmPoints.ts')

/** 插件 `CONFIRM_POINT_SPOKEN_MAX` 那个数。 */
function pluginSpokenMax(): number {
  const source = readFileSync(PLUGIN_CONFIRM_POINTS, 'utf8')
  const hit = source.match(/export const CONFIRM_POINT_SPOKEN_MAX = (\d+)/)
  expect(hit, '插件 confirmPoints.ts 里找不到 `CONFIRM_POINT_SPOKEN_MAX = …` —— 它改名了?这一条要跟着改').not.toBeNull()
  return Number(hit?.[1])
}

describe('★ 电话里最多念几条确认点:插件那份是源头,工人这份同一个数', () => {
  it('读得到插件那一位(扫描本身没坏)', () => {
    expect(pluginSpokenMax()).toBe(1)
  })

  it('★ 工人 SPOKEN_MAX 与插件 CONFIRM_POINT_SPOKEN_MAX 同一个数(漂了就把两边收成一样)', () => {
    expect(SPOKEN_MAX).toBe(pluginSpokenMax())
  })
})
