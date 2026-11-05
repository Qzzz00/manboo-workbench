/**
 * ★ **来电理由及其中文名不许再漂**(2026-10-22,卡「契约对照测试补齐」)。
 *
 * 现场:同一件事「事务官为什么打这个电话」三份 —— 源头在插件
 * (`workbench-plugin/src/protocol.ts` 的 `CallOutReason` / `CALL_OUT_REASONS` /
 * `CALL_OUT_REASON_TITLES`),抄本在工人(`channel-worker/src/callOut.ts` 的 `RingReason` /
 * `RING_REASON_TITLES`)与手机(`butler-app/src/call/incomingModel.ts` 的 `RING_REASON_TITLES`)。
 * 三份靠「逐字相同」的注释互相指着,没有用例守着。
 *
 * 这一份**直接读插件的源码**比对字面量(顶层子目录互不 import,所以只能读文本;
 * 范本 `calendar-note-sync.test.ts`)。手机那一份的对照在 `butler-app/tests/call-reason-sync.test.ts`。
 * 哪一份要加理由,改插件那一处再把各份收成一样 —— 漂了这条红给你看。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { RING_REASON_TITLES } from '../src/callOut.ts'

const PLUGIN_PROTOCOL = join(import.meta.dirname, '..', '..', 'workbench-plugin', 'src', 'protocol.ts')

/** 插件 `CALL_OUT_REASONS = [ … ]` 那张表的理由值(按源码顺序)。 */
function pluginReasons(): string[] {
  const source = readFileSync(PLUGIN_PROTOCOL, 'utf8')
  const hit = source.match(/export const CALL_OUT_REASONS: readonly CallOutReason\[] = \[([^\]]*)\]/)
  expect(hit, '插件 protocol.ts 里找不到 `CALL_OUT_REASONS = [ … ]` —— 它改名了?这一条要跟着改').not.toBeNull()
  return [...(hit?.[1] ?? '').matchAll(/'([^']*)'/g)].map(one => one[1] as string)
}

/** 插件 `CALL_OUT_REASON_TITLES` 那张表:理由 → 中文名(按源码顺序)。 */
function pluginReasonTitles(): Record<string, string> {
  const source = readFileSync(PLUGIN_PROTOCOL, 'utf8')
  const at = source.indexOf('export const CALL_OUT_REASON_TITLES')
  expect(at, '插件 protocol.ts 里找不到 `CALL_OUT_REASON_TITLES` —— 它改名了?这一条要跟着改').toBeGreaterThanOrEqual(0)
  const body = source.slice(at, source.indexOf('\n}', at))
  const out: Record<string, string> = {}
  for (const hit of body.matchAll(/^\s*([A-Za-z0-9_]+):\s*'([^']*)'/gm)) out[hit[1] as string] = hit[2] as string
  return out
}

describe('★ 来电理由及其中文名:插件那份是源头,工人这份照抄', () => {
  it('读得到插件那两张表(扫描本身没坏)', () => {
    expect(pluginReasons()).toEqual(['confirm', 'failed', 'done', 'ask', 'relay'])
    expect(pluginReasonTitles()).toMatchObject({ confirm: '等你确认', done: '完成', relay: '回话来了' })
  })

  it('★ 工人 RingReason 的值域与插件 CALL_OUT_REASONS 逐字相同', () => {
    // RING_REASON_TITLES 是 `Record<RingReason, string>`,它的键就是 RingReason 的值域。
    expect(Object.keys(RING_REASON_TITLES)).toEqual(pluginReasons())
  })

  it('★ 工人 RING_REASON_TITLES 与插件 CALL_OUT_REASON_TITLES 逐字相同(漂了就把两边收成一样)', () => {
    expect({ ...RING_REASON_TITLES }).toEqual(pluginReasonTitles())
  })
})
