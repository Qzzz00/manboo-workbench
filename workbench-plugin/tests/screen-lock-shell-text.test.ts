// @vitest-environment node
/**
 * ★ **壳与插件那两处「锁着屏」的字,是同一个字符串**(2026-10-03,卡「锁屏时窗口型的家送不进」)。
 *
 * 为什么要这条对照测试(09-30「接缝与卡的规矩」):`helperChannel` 在 `ok:false` 时
 * **reject 一个 Error**,回包里别的格一个都带不过来 —— 所以服务端认「这一下是锁屏」靠的是
 * **壳那句原话里的一截字**。两边各写一份中文,改一个字这一道就瞎了,而且是**静默**瞎
 * (回到 09:04 那一幕:开窗五回、报「一扇标准窗口都没有」)。
 *
 * 所以这里**读壳的源码比对**,不写「逐字相同」的注释代替测试
 * (同 `engine-window-notes.test.ts` 的做法)。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SCREEN_LOCK_MARK, SCREEN_LOCKED_FIELD, isScreenLockedReason } from '../src/server/screenLock.ts'

/** 壳那一侧的判断全在这一个文件里(纯逻辑,`workbench-app/run-tests.sh` 里有用例)。 */
const SHELL = join(import.meta.dirname, '../../workbench-app/Sources/ScreenLockPolicy.swift')

function shellSource(): string {
  return readFileSync(SHELL, 'utf8')
}

/** 从 Swift 里取一个 `static let <名字> = "<值>"`。 */
function swiftLet(source: string, name: string): string | undefined {
  return new RegExp(`static let ${name} = "([^"]*)"`).exec(source)?.[1]
}

describe('壳与插件:「锁着屏」那一截字只有一份', () => {
  it('★★插件的 SCREEN_LOCK_MARK = 壳的 ScreenLockPolicy.marker', () => {
    expect(swiftLet(shellSource(), 'marker')).toBe(SCREEN_LOCK_MARK)
  })

  it('★★回包那一格的名字两边也一样(screen_locked)', () => {
    expect(swiftLet(shellSource(), 'field')).toBe(SCREEN_LOCKED_FIELD)
  })

  it('★壳那句真话(lockedWhy 的模板)认得出来', () => {
    const source = shellSource()
    // 壳那一句是插值串,这里把模板里那几段固定的字取出来、拼成壳真会回的那一句
    const template = /static func lockedWhy\(_ bundleId: String\) -> String \{\s*\n\s*"([^"]*)"/.exec(source)?.[1]
    expect(template, '壳那句人话还在 lockedWhy 里').toBeDefined()
    const said = (template as string)
      .replace('\\(marker)', swiftLet(source, 'marker') as string)
      .replace('\\(bundleId)', 'com.moonshot.kimichat')
    expect(isScreenLockedReason(said), `插件认不出壳这一句:${said}`).toBe(true)
  })

  it('★对照:壳在**没**锁屏时报的那句「一扇标准窗口都没有」**不**算锁屏', () => {
    expect(isScreenLockedReason('找不到窗口:com.moonshot.kimichat 在跑,但一扇标准窗口都没有(可能最小化了或只剩菜单栏图标)')).toBe(false)
  })

  it('★那两条系统通知的名字壳里还在(真机订得上没有要维护者验)', () => {
    const source = shellSource()
    expect(swiftLet(source, 'lockedNotification')).toBe('com.apple.screenIsLocked')
    expect(swiftLet(source, 'unlockedNotification')).toBe('com.apple.screenIsUnlocked')
  })

  it('★★壳认锁屏读的是 CGSession 那两格(名字改了这条就红)', () => {
    const source = shellSource()
    expect(swiftLet(source, 'lockedKey')).toBe('CGSSessionScreenIsLocked')
    expect(swiftLet(source, 'onConsoleKey')).toBe('kCGSSessionOnConsoleKey')
  })

  it('★★`screen_info` 在壳「不管锁没锁都带上那一格」的表里 —— 8791 那一拍问的就是它', () => {
    expect(/static let alwaysReport: Set<String> = \[[^\]]*"screen_info"/.test(shellSource())).toBe(true)
  })
})
