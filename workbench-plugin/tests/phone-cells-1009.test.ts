/**
 * 「哪一版起手机才有这一格」那张表(2026-10-09,卡「四件小事」第 1 件)。
 * 手机拿自己装的版本与这张表比,落后于任何一格、而且电脑上有更新的包时,首页提示更新手机端。
 * 这里钉表本身:四格都在、版本号认得出、不超过工作台这一版(手机包版本就是插件版本)。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PHONE_CELLS } from '../src/phoneCells.ts'

const PLUGIN_VERSION = (JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf8')) as { version: string }).version
const parts = (v: string) => v.split('.').map(Number)
/**
 * 功能分支上写的是**下一版**号(2026-10-12 起的做法:分支不改 package.json,统筹合并时才统一版本号),
 * 所以上限放到「工作台这一版 + 1」。
 */
const NEXT_VERSION = (() => { const [a, b, c] = parts(PLUGIN_VERSION); return `${a}.${b}.${(c ?? 0) + 1}` })()
const notAfter = (a: string, b: string) => {
  const [x, y] = [parts(a), parts(b)]
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return (x[i] ?? 0) < (y[i] ?? 0)
  return true
}

describe('PHONE_CELLS', () => {
  it('要文件 / 答案来找她 / 它学到了什么 / 会议待传箱 / 会前画像与预案 / 新学到一条 / 今天的待办 都记着,起始版本照发版记录', () => {
    expect(PHONE_CELLS.map(one => [one.cell, one.since])).toEqual([
      ['file_offers', '0.4.95'],
      ['answers', '0.4.98'],
      ['habits', '0.4.110'],
      ['meeting_outbox', '0.4.110'],
      ['meeting_prep', '0.4.111'],
      ['habit_notice', '0.4.111'],
      ['today_todos', '0.4.113'],
      ['today_view', '0.4.115'],
    ])
  })

  it('每一行:版本号三段数字、不晚于工作台这一版、有一个她看得懂的名字、cell 不重复', () => {
    for (const one of PHONE_CELLS) {
      expect(one.since).toMatch(/^\d+\.\d+\.\d+$/)
      expect(notAfter(one.since, NEXT_VERSION), `${one.cell} 的 ${one.since} 晚于 ${NEXT_VERSION}`).toBe(true)
      expect(one.title.trim()).not.toBe('')
    }
    expect(new Set(PHONE_CELLS.map(one => one.cell)).size).toBe(PHONE_CELLS.length)
  })
})
