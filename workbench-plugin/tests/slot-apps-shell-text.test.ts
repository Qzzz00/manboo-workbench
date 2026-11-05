// @vitest-environment node
/**
 * ★ **壳与插件:`slot_apps` 那条 op 两边说的是同一件事**(2026-10-04,卡「常亮认窗口槽里的程序」)。
 *
 * 为什么要这条对照测试(09-30「接缝与卡的规矩」:改契约的卡要有对照测试):
 * 这一格是**改接缝**(8791 → 壳)—— op 的名字与那一个字段名在两个仓库目录里各写一份,
 * 壳不认就回「未知 op」,而那又是一句**静默**的失败:她照旧在用窗口槽里的 Codex、
 * 屏幕照旧 10 分钟就暗、一暗就锁 —— 跟 10-04 之前一模一样,谁也看不出修复没接上。
 * 所以这里**读壳的源码比对**,不写「逐字相同」的注释代替测试
 * (同 `away-awake-shell-text.test.ts` / `screen-lock-shell-text.test.ts` 的做法)。
 *
 * 下发那一半在 `server-dock.test.ts`(「窗口槽成员表下发给壳」那一组);
 * 壳那一半的纯逻辑在 `workbench-app/run-tests.sh`(`DisplayAwakePolicy`)。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SOCKET = join(import.meta.dirname, '../../workbench-app/Sources/HelperSocket.swift')
const POLICY = join(import.meta.dirname, '../../workbench-app/Sources/DisplayAwakePolicy.swift')
const DELEGATE = join(import.meta.dirname, '../../workbench-app/Sources/AppDelegate.swift')
const CHANNEL = join(import.meta.dirname, '../src/server/helperChannel.ts')

function read(path: string): string {
  return readFileSync(path, 'utf8')
}

describe('壳认得插件发的那条 op', () => {
  it('★★壳的路由表里有 `slot_apps` 这一支(op 名字改了这条就红)', () => {
    expect(/case "slot_apps":/.test(read(SOCKET))).toBe(true)
  })

  it('★★壳读的字段名就是 `bundle_ids`(插件发的那一格)', () => {
    const source = read(SOCKET)
    const branch = source.slice(source.indexOf('case "slot_apps":'))
    expect(/msg\["bundle_ids"\]/.test(branch.slice(0, 900))).toBe(true)
  })

  it('★壳在 hello 的 caps 里报 `slot_apps` —— 老壳没有这一格,插件据此不发', () => {
    expect(/"caps": \[[\s\S]{0,6000}?"slot_apps"/.test(read(SOCKET))).toBe(true)
  })

  it('★★这条 op 在授权门**外面**(她没给辅助功能授权时照样会点进槽里那扇窗)', () => {
    const channel = read(CHANNEL)
    const line = channel.slice(channel.indexOf('const AX_FREE_OPS'),
      channel.indexOf('\n', channel.indexOf('const AX_FREE_OPS')))
    expect(line).toContain('slot_apps')
  })
})

describe('壳那一侧的判断:最前面那一家在槽里就照样按住', () => {
  it('★★`Moment` 上有 `slotAppFront`,而且**缺省假**(缺省 = 2026-10-04 之前的行为)', () => {
    const source = read(POLICY)
    expect(/var slotAppFront: Bool/.test(source)).toBe(true)
    expect(/slotAppFront: Bool = false/.test(source), '构造器里缺省假').toBe(true)
  })

  it('★★`holdReason` 里「正在退出」与「出门」都排在它**前面**(那两条纪律一个字没改)', () => {
    const source = read(POLICY)
    const body = /static func holdReason\([\s\S]*?\n    \}/.exec(source)?.[0] ?? ''
    expect(body, 'holdReason 还在').not.toBe('')
    const terminating = body.indexOf('moment.terminating')
    const away = body.indexOf('moment.awayKeepAwake')
    const slot = body.indexOf('moment.slotAppFront')
    expect(terminating).toBeGreaterThanOrEqual(0)
    expect(away).toBeGreaterThan(terminating)
    expect(slot, '★槽里那一家那一条排在出门后面').toBeGreaterThan(away)
  })

  it('★「最前面那一家在槽里」和「工作台自己在前台」是**或**的关系,不是取代', () => {
    const source = read(POLICY)
    const body = /static func holdReason\([\s\S]*?\n    \}/.exec(source)?.[0] ?? ''
    // 这一条钉的是 09-27 那三条没被改写:appActive 还在、窗在屏上与收进坞两条还在。
    expect(/!moment\.appActive && !moment\.slotAppFront/.test(body)).toBe(true)
    expect(/moment\.windowMiniaturized/.test(body)).toBe(true)
    expect(/moment\.windowVisible/.test(body)).toBe(true)
  })

  it('★`pmset -g assertions` 里那一行:这一条也是原句**加一句**,原句一个字不动', () => {
    const source = read(POLICY)
    expect(/static let assertionName = "工作台在前台,先别让屏幕暗下去"/.test(source),
      '原来那一句逐字不变').toBe(true)
    expect(/case \.slotApp: return "\\\(assertionName\)\(/.test(source), '这一条以原句开头').toBe(true)
    expect(/static let slotMark = "窗口槽"/.test(source)).toBe(true)
  })

  it('★★壳不另造一张成员表:那一格只由 `applySlotApps` 从 op 写进去', () => {
    const source = read(DELEGATE)
    expect(/socket\.onSlotApps = /.test(source), '接线还在').toBe(true)
    // 全壳里给 slotBundleIds 赋值的只有一处(插件下发那一下)—— 壳不许从
    // 「我被叫去摆过谁的窗」反推谁在槽里(弹层让路、遮罩底下挪的那几发都会算错)。
    expect((source.match(/^\s*slotBundleIds = /gm) ?? []).length).toBe(1)
    expect(/slotBundleIds = Set\(bundleIds/.test(source)).toBe(true)
  })

  it('★★最前面那一家换了也要重算一次 —— 激活通知那一处接上了 `refreshDisplayAwake`', () => {
    const source = read(DELEGATE)
    const handler = /@objc private func handleAppActivated\([\s\S]*?\n    \}/.exec(source)?.[0] ?? ''
    expect(handler, 'handleAppActivated 还在').not.toBe('')
    expect(/refreshDisplayAwake\(\)/.test(handler),
      '★原来只在工作台自己 active/resign/hide/miniaturize 时刷,她在两家之间切就一次也刷不到').toBe(true)
  })

  it('★★「最前面是谁」现问 `NSWorkspace`,壳不存一份(切得快的那几拍上别跟系统不一致)', () => {
    const source = read(DELEGATE)
    const moment = /private func currentDisplayMoment\([\s\S]*?\n    \}/.exec(source)?.[0] ?? ''
    expect(moment, 'currentDisplayMoment 还在').not.toBe('')
    expect(/NSWorkspace\.shared\.frontmostApplication\?\.bundleIdentifier/.test(moment)).toBe(true)
    expect(/DisplayAwakePolicy\.slotAppFront\(/.test(moment), '判断在纯函数里').toBe(true)
  })

  it('★只碰屏幕那条断言,不碰整机那条(整机是另一颗开关,`SystemAwake`)', () => {
    const delegate = read(DELEGATE)
    const apply = /private func applySlotApps\([\s\S]*?\n    \}/.exec(delegate)?.[0] ?? ''
    expect(apply, 'applySlotApps 还在').not.toBe('')
    expect(/systemAwake|SystemAwakePolicy/.test(apply)).toBe(false)
    expect(/refreshDisplayAwake\(\)/.test(apply)).toBe(true)
  })
})
