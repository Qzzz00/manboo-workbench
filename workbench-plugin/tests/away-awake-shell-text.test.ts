// @vitest-environment node
/**
 * ★ **壳与插件:`away_awake` 那条 op 两边说的是同一件事**(2026-10-03,卡「出门时电脑不睡」)。
 *
 * 为什么要这条对照测试(09-30「接缝与卡的规矩」:改契约的卡要有对照测试):
 * 这一格是**改接缝**(8791 → 壳)——op 的名字与那一个字段名在两个仓库目录里各写一份,
 * 壳不认就回「未知 op」,而那是一句**静默**的失败:她以为开关开了,屏幕照旧 10 分钟就睡、
 * 一睡就锁,那句话照旧送不进去。改一个字就瞎,所以这里**读壳的源码比对**,
 * 不写「逐字相同」的注释代替测试(同 `screen-lock-shell-text.test.ts` 的做法)。
 *
 * 判断本身在 `server-away-awake.test.ts`;壳那一半的纯逻辑在 `workbench-app/run-tests.sh`。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SOCKET = join(import.meta.dirname, '../../workbench-app/Sources/HelperSocket.swift')
const POLICY = join(import.meta.dirname, '../../workbench-app/Sources/DisplayAwakePolicy.swift')
const DELEGATE = join(import.meta.dirname, '../../workbench-app/Sources/AppDelegate.swift')

function read(path: string): string {
  return readFileSync(path, 'utf8')
}

describe('壳认得插件发的那条 op', () => {
  it('★★壳的路由表里有 `away_awake` 这一支(op 名字改了这条就红)', () => {
    expect(/case "away_awake":/.test(read(SOCKET))).toBe(true)
  })

  it('★★壳读的字段名就是 `active`(插件发的那一格)', () => {
    const source = read(SOCKET)
    const branch = source.slice(source.indexOf('case "away_awake":'))
    expect(/msg\["active"\] as\? Bool/.test(branch.slice(0, 600))).toBe(true)
  })

  it('★壳在 hello 的 caps 里报 `away_awake` —— 老壳没有这一格,服务端据此如实说要重开工作台', () => {
    expect(/"caps": \[[\s\S]{0,4000}?"away_awake"/.test(read(SOCKET))).toBe(true)
  })

  it('★壳那一支回的是 `{active, held}`(设置页那句「已经生效」靠它)', () => {
    const source = read(SOCKET)
    const branch = source.slice(source.indexOf('case "away_awake":'))
    expect(/"result": \["active": active, "held": holding\]/.test(branch.slice(0, 900))).toBe(true)
  })
})

describe('壳那一侧的判断:出门那一格为真就不看前台', () => {
  it('★★`Moment` 上有 `awayKeepAwake`,而且**缺省假**(缺省 = 2026-10-03 之前的行为)', () => {
    const source = read(POLICY)
    expect(/var awayKeepAwake: Bool/.test(source)).toBe(true)
    expect(/awayKeepAwake: Bool = false/.test(source), '构造器里缺省假').toBe(true)
  })

  it('★★`holdReason` 里「正在退出」排在出门**前面** —— 退出一定放掉,出门模式也不例外', () => {
    const source = read(POLICY)
    const body = /static func holdReason\([\s\S]*?\n    \}/.exec(source)?.[0] ?? ''
    expect(body, 'holdReason 还在').not.toBe('')
    const terminating = body.indexOf('moment.terminating')
    const away = body.indexOf('moment.awayKeepAwake')
    const appActive = body.indexOf('moment.appActive')
    expect(terminating).toBeGreaterThanOrEqual(0)
    expect(away).toBeGreaterThan(terminating)
    expect(appActive, '★出门那一格排在前台三条前面 = 为真时不看前台').toBeGreaterThan(away)
  })

  it('★`pmset -g assertions` 里那一行:出门那一条是原句**加一句**,原句一个字不动', () => {
    const source = read(POLICY)
    expect(/static let assertionName = "工作台在前台,先别让屏幕暗下去"/.test(source),
      '原来那一句逐字不变').toBe(true)
    expect(/case \.away: return "\\\(assertionName\)\(/.test(source), '出门那一条以原句开头').toBe(true)
    expect(/static let awayMark = "出门"/.test(source)).toBe(true)
  })

  it('★★壳自己不做判断:那一格只由 `applyAwayAwake` 从 op 写进去', () => {
    const source = read(DELEGATE)
    expect(/socket\.onAwayAwake = /.test(source), '接线还在').toBe(true)
    // 全壳里给 awayKeepAwake 赋值的只有一处(服务端下发那一下)——壳不许自己猜她出门了没有。
    // 行首那一处是声明(`private var awayKeepAwake = false`),所以这里只数**赋值**那几处:
    // 全壳里只许有一处,就是服务端下发那一下。壳不许自己猜她出门了没有。
    expect((source.match(/^\s*awayKeepAwake = /gm) ?? []).length).toBe(1)
    expect(/awayKeepAwake = active/.test(source)).toBe(true)
  })

  it('★★只碰屏幕那条断言,不碰整机那条(整机是另一颗开关,`SystemAwake`)', () => {
    const delegate = read(DELEGATE)
    const apply = /private func applyAwayAwake\([\s\S]*?\n    \}/.exec(delegate)?.[0] ?? ''
    expect(apply, 'applyAwayAwake 还在').not.toBe('')
    expect(/systemAwake|SystemAwakePolicy/.test(apply), '出门那一下一个字都不碰整机那条').toBe(false)
    expect(/refreshDisplayAwake\(\)/.test(apply)).toBe(true)
  })

  it('★★不去挡整机空闲睡眠 / 合盖:壳里压根没有 PreventUserIdleSystemSleep 以外那几样', () => {
    // 刻意不做的那三样(卡上写明):整机不睡只由那颗老开关管、合盖与她自己按的锁屏一概不挡。
    const awake = read(join(import.meta.dirname, '../../workbench-app/Sources/DisplayAwake.swift'))
    expect(/kIOPMAssertPreventUserIdleDisplaySleep/.test(awake)).toBe(true)
    // 真去按的那个常量只有一个(注释里提到「刻意不用整机那条」不算 —— 按 `as CFString` 那个形状数)。
    expect(/kIOPMAssertPreventUserIdleSystemSleep as CFString|caffeinate/.test(awake)).toBe(false)
    expect((awake.match(/IOPMAssertionCreateWithName\(/g) ?? []).length, '只按一条断言').toBe(1)
  })
})
