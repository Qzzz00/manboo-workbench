/**
 * ★ **工人这边从插件抄的几个协议形状不许再漂**(2026-10-22,卡「契约对照测试补齐」)。
 *
 * 五对,都是「工人 src 里一份 ⇄ 插件 src 里一份」,靠注释互相指着,没有用例守着:
 *
 *   1. `SessionTurn`(回合):`channel-worker/src/workbench.ts` ⇄ `workbench-plugin/src/protocol.ts`
 *   2. 工人令牌头 `ACTOR_TOKEN_HEADER`:`channel-worker/src/workbench.ts` ⇄
 *      `workbench-plugin/src/server/herself.ts`
 *   3. `TurnLatency`(一回合的成绩单):`channel-worker/src/latency.ts` ⇄
 *      `workbench-plugin/src/server/channelLatency.ts`(插件那头注释「形状与工人那边一字不差」;
 *      真相在工人,插件只是转手柜台 —— 对照钉住的是两边对得上)
 *   4. `ScannedRepo`(扫回来的一个仓库):`channel-worker/src/onboarding.ts` ⇄
 *      `workbench-plugin/src/server/onboardingScan.ts`
 *   5. 首声禁用词 `FIRST_VOICE_BANNED`:`channel-worker/src/firstVoice.ts` ⇄
 *      `workbench-plugin/src/server/channel.ts`(人设里「不念系统里的名词」那份,注释「同一份词」)
 *
 * 这一份**直接读插件的源码**比对(顶层子目录互不 import,只能读文本;范本
 * `calendar-note-sync.test.ts`)。漂了这条红给你看。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ACTOR_TOKEN_HEADER, type SessionTurn } from '../src/workbench.ts'
import { FIRST_VOICE_BANNED } from '../src/firstVoice.ts'
import { LATENCY_KEEP } from '../src/latency.ts'

const WP = join(import.meta.dirname, '..', '..', 'workbench-plugin', 'src')
const CW = join(import.meta.dirname, '..', 'src')

/** 从一个 `export interface <Name> { … }` 里取字段名(按源码顺序)。 */
function interfaceFields(source: string, name: string): string[] {
  const at = source.indexOf(`export interface ${name}`)
  expect(at, `源码里找不到 \`export interface ${name}\` —— 它改名了?这一条要跟着改`).toBeGreaterThanOrEqual(0)
  const open = source.indexOf('{', at)
  const close = source.indexOf('\n}', open)
  expect(close).toBeGreaterThan(open)
  return [...source.slice(open + 1, close).matchAll(/^\s*([A-Za-z0-9_]+)\??:/gm)].map(one => one[1] as string)
}

/** 取插件 `export const <Name> = '…'` 的字面量。 */
function pluginStringConst(file: string, name: string): string {
  const source = readFileSync(join(WP, file), 'utf8')
  const hit = source.match(new RegExp(`export const ${name} = '([^']+)'`))
  expect(hit, `插件 ${file} 里找不到 \`export const ${name} = '…'\` —— 它改名了?这一条要跟着改`).not.toBeNull()
  return hit?.[1] as string
}

describe('★ 协议形状对照(5 对)', () => {
  it('① SessionTurn:工人 workbench.ts 那份与插件 protocol.ts 那份字段逐个相同', () => {
    const plugin = interfaceFields(readFileSync(join(WP, 'protocol.ts'), 'utf8'), 'SessionTurn')
    const mine = interfaceFields(readFileSync(join(CW, 'workbench.ts'), 'utf8'), 'SessionTurn')
    expect(mine).toEqual(plugin)
    // 编译期也钉一下:这条型必须仍是那三格。
    const turn: SessionTurn = { role: 'user', text: 'x', at: '2026-10-22T00:00:00.000Z' }
    expect([turn.role, turn.text, turn.at]).toEqual(['user', 'x', '2026-10-22T00:00:00.000Z'])
  })

  it('② 工人令牌头:工人 workbench.ts 与插件 herself.ts 的 ACTOR_TOKEN_HEADER 同一个字符串', () => {
    expect(ACTOR_TOKEN_HEADER).toBe(pluginStringConst('server/herself.ts', 'ACTOR_TOKEN_HEADER'))
  })

  it('③ TurnLatency:插件的每一段成绩单字段,工人 latency.ts 的 TurnLatency 里都有(number | null)', () => {
    const plugin = readFileSync(join(WP, 'server', 'channelLatency.ts'), 'utf8')
    const segments = (plugin.match(/export const LATENCY_SEGMENTS = \[([^\]]*)\]/)?.[1] ?? '')
      .split(',').map(one => one.trim()).filter(one => /'[^']+'/.test(one))
      .map(one => (one.match(/'([^']+)'/) as RegExpMatchArray)[1] as string)
    expect(segments.length).toBeGreaterThanOrEqual(8)
    const mine = interfaceFields(readFileSync(join(CW, 'latency.ts'), 'utf8'), 'TurnLatency')
    const missing = segments.filter(seg => !mine.includes(seg))
    expect(missing, '插件 channelLatency.ts 的成绩单字段,工人 latency.ts 的 TurnLatency 里没有 —— 以插件为源头收成一样').toEqual([])
  })

  it('③ TurnLatency 附:最近留几条 LATENCY_KEEP 两边同一个数(注释互指)', () => {
    const plugin = readFileSync(join(WP, 'server', 'channelLatency.ts'), 'utf8')
    const hit = plugin.match(/export const LATENCY_KEEP = (\d+)/)
    expect(hit, '插件 channelLatency.ts 里找不到 `LATENCY_KEEP = …`').not.toBeNull()
    expect(LATENCY_KEEP).toBe(Number(hit?.[1]))
  })

  it('④ ScannedRepo:工人 onboarding.ts 那份与插件 onboardingScan.ts 那份字段逐个相同', () => {
    const plugin = interfaceFields(readFileSync(join(WP, 'server', 'onboardingScan.ts'), 'utf8'), 'ScannedRepo')
    const mine = interfaceFields(readFileSync(join(CW, 'onboarding.ts'), 'utf8'), 'ScannedRepo')
    expect(mine).toEqual(plugin)
  })

  it('⑤ 首声禁用词:插件人设「不念系统里的名词」那份,工人 firstVoice.ts 的 FIRST_VOICE_BANNED 一个都不少', () => {
    const source = readFileSync(join(WP, 'server', 'channel.ts'), 'utf8')
    const hit = source.match(/'-\s*\*\*不念系统里的名词\*\*:([^']+)'/)
    expect(hit, '插件 channel.ts 里找不到「不念系统里的名词」那一行 —— 它改写了?这一条要跟着改').not.toBeNull()
    const plugin = (hit?.[1] ?? '').split('、').map(one => one.trim()).filter(one => one !== '')
    expect(plugin.length).toBeGreaterThanOrEqual(8)
    const missing = plugin.filter(word => !FIRST_VOICE_BANNED.includes(word))
    expect(missing, '插件 channel.ts 禁念的词,工人 firstVoice.ts 的 FIRST_VOICE_BANNED 没有 —— 以插件为源头把词补进工人那份').toEqual([])
  })
})
