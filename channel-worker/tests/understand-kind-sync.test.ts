/**
 * ★ **「听懂」的分类不许再漂**(2026-10-22,卡「契约对照测试补齐」)。
 *
 * 现场:同一份「她这句是哪一类事」的枚举 —— 源头在插件
 * (`workbench-plugin/src/server/understand.ts` 的 `UnderstandKind`,十类),抄本在工人
 * (`channel-worker/src/understand.ts` 的 `UnderstandKind`,注释「与 8791 的 UnderstandKind
 * 同一组字」)。靠注释互相指着,没有用例守着。
 *
 * 这一份**直接读两边的源码**取类型联合的字面量比对(顶层子目录互不 import,只能读文本;
 * 范本 `calendar-note-sync.test.ts`)。哪一边加了一类,这条红给你看,两边一起收成一样。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const PLUGIN_UNDERSTAND = join(import.meta.dirname, '..', '..', 'workbench-plugin', 'src', 'server', 'understand.ts')
const WORKER_UNDERSTAND = join(import.meta.dirname, '..', 'src', 'understand.ts')

/** 从 `export type <Name> =` 之后抓到下一个声明为止,取里面所有单引号字面量。 */
function typeUnionLiterals(source: string, name: string): string[] {
  const at = source.indexOf(`export type ${name} =`)
  expect(at, `源码里找不到 \`export type ${name}\` —— 它改名了?这一条要跟着改`).toBeGreaterThanOrEqual(0)
  const rest = source.slice(at + 1)
  const next = /\n\s*export\b/.exec(rest)
  const block = next === null ? rest : rest.slice(0, next.index)
  return [...block.matchAll(/'([^']*)'/g)].map(one => one[1] as string)
}

describe('★ 听懂的分类:插件那份是源头,工人这份同一组字', () => {
  it('读得到插件那张联合(扫描本身没坏)', () => {
    const plugin = typeUnionLiterals(readFileSync(PLUGIN_UNDERSTAND, 'utf8'), 'UnderstandKind')
    expect(plugin).toContain('dispatch')
    expect(plugin).toContain('remember')
    expect(plugin.length).toBeGreaterThanOrEqual(10)
  })

  it('★ 工人 UnderstandKind 与插件 UnderstandKind 是同一组字(漂了就把两边收成一样)', () => {
    const plugin = typeUnionLiterals(readFileSync(PLUGIN_UNDERSTAND, 'utf8'), 'UnderstandKind').sort()
    const mine = typeUnionLiterals(readFileSync(WORKER_UNDERSTAND, 'utf8'), 'UnderstandKind').sort()
    expect(mine).toEqual(plugin)
  })
})
