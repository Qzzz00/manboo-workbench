/**
 * **派活被一层弹框挡住了 + 一家装着两个包时派给哪一个**(2026-09-28,卡 DP)。
 *
 * 真机(维护者本机 0.4.55,统筹 18:4x 用页面身份 `POST /dispatch/run {app:'doubao'}` 派一件自测):
 *
 * 1. 第一次:`窗口:辅助功能通道关着:com.bot.pc.doubao 回 **-25204**` ——
 *    -25204 是 `kAXErrorCannotComplete`(树还没长出来),**不是** -25211(权限没给)。
 *    说错了她按那句话去开辅助功能权限,而它本来就是开着的。
 * 2. 第二次:`窗口:输入框没找到:com.bot.pc.doubao —— 这扇窗的 AX 树里没有任何文本输入元素`。
 * 3. 截图:豆包窗口正中弹着一个推广框「手机控制电脑 · 随时用手机,继续电脑上的任务」,
 *    左边一颗蓝键「开始体验」、右上角一个 ×,整个界面被盖住。
 *    维护者:「那是不是我打电话派活也还是输不进去?」—— 是。
 * 4. 同一台上装着**两个豆包**:`com.bot.pc.doubao`(显示名 Doubao)与 `com.work.pc.doubao`(豆包工作)。
 *    卡 CF 把两个包都认成 `doubao` 一家,可**没定「派给哪一个」** —— 于是永远派给主包那一个。
 *
 * 这一份钉住的是服务端那一半:失败归类与话术、事项该挂「等你处理」、一家多个包时挑哪个(写成一处)。
 * 壳那一半(哪些键算纯关闭、哪些绝不点、-25204 要重试)在 `workbench-app/Tests/main.swift`。
 */
import { describe, expect, it } from 'vitest'
import { FAMILY_SOURCES, packagesOf, pickFamilyPackage } from '../src/server/agentSources.ts'
import { classifyFailure, FAILURE_HINTS, humanizeFailure } from '../src/server/dispatchClient.ts'
import { dispatchTargets } from '../src/server/dispatchTargets.ts'

describe('壳那句原话:归类与话术', () => {
  const modal = '没送:com.bot.pc.doubao 那边弹了个框挡着(「手机控制电脑」) —— 我只按「×/关闭/稍后」这类纯关闭的键,这个关不掉;去点一下再叫我派'
  const shellOnly = '没送:com.bot.pc.doubao 的窗口里只读到窗口本身,网页那一层没长出来(它被一层弹框盖住时也会这样)—— 去看一眼它的窗口,有框就关掉再叫我派'

  it('弹框挡着是它自己一类(不跟「找不到输入框」混)', () => {
    expect(classifyFailure(modal)).toBe('modal_in_the_way')
    expect(classifyFailure(shellOnly)).toBe('tree_shell_only')
    expect(FAILURE_HINTS.modal_in_the_way).toContain('框')
    expect(FAILURE_HINTS.tree_shell_only).toContain('窗口')
  })

  it('★「只读到窗口本身」那句不再说成有框:让人关掉重开(演示机 10-13 Codex 排障日志;卡 U)', () => {
    const said = humanizeFailure(shellOnly, 'doubao')
    expect(said).toContain('关掉重开')
    expect(said).not.toContain('有框就关掉')
    expect(said).not.toContain('被一层框盖住')
    expect(said).toContain('豆包')
  })

  it('-25204 照旧归「辅助功能通道」这一类(壳换了措辞,归类不许漂)', () => {
    expect(classifyFailure('辅助功能通道没通:com.bot.pc.doubao 回 -25204(kAXErrorCannotComplete:它的辅助功能树还没长出来(已敲过 AXManualAccessibility 并重试过))')).toBe('ax_disabled')
    expect(classifyFailure('辅助功能通道关着:x 回 -25211(kAXErrorAPIDisabled = -25211)')).toBe('ax_disabled')
  })

  it('念给她听的那一句:说家的名字、说框上那句话、说下一步 —— 不念包标识', () => {
    const said = humanizeFailure(modal, 'doubao')
    expect(said).toContain('豆包办公')
    expect(said).toContain('手机控制电脑')
    expect(said).toContain('去点一下')
    expect(said).not.toContain('com.bot.pc.doubao')
    expect(said).not.toContain('AX')
  })

  it('框上那句话读不到时就不提它(不留一对空括号、不念 undefined)', () => {
    const said = humanizeFailure('没送:com.bot.pc.doubao 那边弹了个框挡着 —— 我只按「×/关闭/稍后」这类纯关闭的键,这个关不掉;去点一下再叫我派', 'doubao')
    expect(said).toContain('豆包办公')
    expect(said).not.toContain('()')
    expect(said).not.toContain('undefined')
  })

  it('树里只剩窗口本身那一句也换成人话(她要知道去看一眼那扇窗)', () => {
    const said = humanizeFailure(shellOnly, 'doubao')
    expect(said).toContain('豆包办公')
    // ★ 卡 U(2026-10-13 夜):「去看一眼」换成「关掉重开」—— 演示机两次都是这么好的,看一眼找不到框。
    expect(said).toContain('关掉重开')
    expect(said).not.toContain('com.bot.pc.doubao')
  })

  it('别的原因一个字都不改(归不出类就原话带走)', () => {
    expect(humanizeFailure('窗口:随便一句没见过的话', 'doubao')).toBe('窗口:随便一句没见过的话')
  })
})

describe('一家装着两个包:派给哪一个(写成一处)', () => {
  const both = [{ bundle_id: 'com.bot.pc.doubao' }, { bundle_id: 'com.work.pc.doubao' }]

  it('豆包那一家的几个包各有自己的显示名,主包排在最前(2026-10-01 加了 Mac App Store 版)', () => {
    const packages = packagesOf(FAMILY_SOURCES.find(one => one.agent === 'doubao'))
    expect(packages.map(one => one.bundle_id)).toEqual(['com.bot.pc.doubao', 'com.work.pc.doubao', 'com.bot.neotix.doubao'])
    expect(packages[1]?.name).toBe('豆包工作')
  })

  it('她说「豆包工作」→ 派给 com.work.pc.doubao', () => {
    const picked = pickFamilyPackage({ family: 'doubao', said: '让豆包工作查国庆放几天假', installed: both })
    expect(picked?.bundle_id).toBe('com.work.pc.doubao')
    expect(picked?.name).toBe('豆包工作')
    expect(picked?.why).toBe('said')
  })

  it('她说「豆包办公」→ 同一个(办公 = 工作那个包)', () => {
    expect(pickFamilyPackage({ family: 'doubao', said: '豆包办公帮我查一下', installed: both })?.bundle_id)
      .toBe('com.work.pc.doubao')
  })

  it('★她只说「豆包」而两个都装着 → 按窗口开着没有挑,并说得出挑的是哪一个', () => {
    const picked = pickFamilyPackage({
      family: 'doubao',
      said: '让豆包查一下国庆放几天',
      installed: [{ bundle_id: 'com.bot.pc.doubao' }, { bundle_id: 'com.work.pc.doubao', running: true }],
    })
    expect(picked?.bundle_id).toBe('com.work.pc.doubao')
    expect(picked?.why).toBe('running')
  })

  it('她只说「豆包」、两个都没开 → 主包(不猜,按知识表的顺序)', () => {
    const picked = pickFamilyPackage({ family: 'doubao', said: '让豆包查一下', installed: both })
    expect(picked?.bundle_id).toBe('com.bot.pc.doubao')
    expect(picked?.why).toBe('default')
  })

  it('★她点名的那个包没装 → 退回装着的那一个,不硬派给没装的', () => {
    const picked = pickFamilyPackage({
      family: 'doubao',
      said: '让豆包工作查一下',
      installed: [{ bundle_id: 'com.bot.pc.doubao' }],
    })
    expect(picked?.bundle_id).toBe('com.bot.pc.doubao')
    expect(picked?.why).toBe('only')
  })

  it('这台电脑上一个都没装 → 回 undefined(上层照旧说「这台电脑上还没接上」)', () => {
    expect(pickFamilyPackage({ family: 'doubao', said: '豆包', installed: [] })).toBeUndefined()
  })

  it('只有一个包的那几家一字不变;运行时新发现的那一家(知识表里没有)不掺和', () => {
    expect(pickFamilyPackage({ family: 'kimi', installed: [{ bundle_id: 'com.moonshot.kimichat' }] })?.bundle_id)
      .toBe('com.moonshot.kimichat')
    expect(pickFamilyPackage({ family: 'com.anysphere.sand', installed: [{ bundle_id: 'com.anysphere.sand' }] }))
      .toBeUndefined()
  })

  it('探测那一格缺席(不知道装了哪几个)→ 主包,行为与这张卡之前一字不变', () => {
    expect(pickFamilyPackage({ family: 'doubao' })?.bundle_id).toBe('com.bot.pc.doubao')
  })
})

describe('派活候选:一家两个包都装着时,两个包都带在这一家身上', () => {
  it('候选里豆包只有一条,但它身上记着两个包(派的时候才挑)', () => {
    const targets = dispatchTargets({
      installedAgents: [{
        id: 'doubao',
        name: '豆包办公',
        bundle_id: 'com.bot.pc.doubao',
        packages: [{ bundle_id: 'com.bot.pc.doubao', name: '豆包' }, { bundle_id: 'com.work.pc.doubao', name: '豆包工作' }],
      }],
    })
    const doubao = targets.filter(one => one.id === 'doubao')
    expect(doubao).toHaveLength(1)
    expect(doubao[0]?.packages?.map(one => one.bundle_id)).toEqual(['com.bot.pc.doubao', 'com.work.pc.doubao'])
  })

  it('只装了一个包的那几家不长出这一格(不给界面添一份空数组)', () => {
    const targets = dispatchTargets({
      installedAgents: [{ id: 'kimi', name: 'Kimi', bundle_id: 'com.moonshot.kimichat' }],
    })
    expect(targets.find(one => one.id === 'kimi')?.packages).toBeUndefined()
  })
})
