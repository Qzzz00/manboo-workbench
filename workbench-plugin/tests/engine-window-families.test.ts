// @vitest-environment node
/**
 * **差异表**(2026-10-02,卡「窗口适配器」):窗口型那几家的差别**只许在这一张表里**。
 *
 * 这一份守两件事:
 * ① **会执行的差别只有一样** —— 有没有开到某一段对话的深链。别的(先开新对话、自绘输入框、
 *    侧栏点行、一家多包)查实之后都不是「家的差别」,它们各自已经在一处了
 *    (`JobKind` / `classifyFailure` / 缺省行 / `pickFamilyPackage`),详见 `window/families.ts` 文件头那张表;
 * ② **表外的一家照样跑** —— Grok Bot、Antigravity 这类运行时发现的(家名就是包标识)走缺省行,
 *    一行配置都不用加。哪天有人为某一家往这张表里加一个开关,这一份会逼他说清为什么。
 *
 * 另外钉住两条接缝:表里的家名必须真在家族目录里(不许凭空造一个家名)、
 * 每一种 `JobKind` 在动作闸上都要有名字(新加一种这里红)。
 */
import { describe, expect, it } from 'vitest'
import {
  WINDOW_FAMILIES,
  WINDOW_FAMILY_DEFAULT,
  windowDeepLink,
  windowFamilyRow,
  windowPressRoute,
} from '../src/server/engine/adapters/window.ts'
import { FAMILY_SOURCES } from '../src/server/agentSources.ts'
import { GATE_ACTIONS } from '../src/server/actionGate.ts'

/** 卡上点名的那七家(「豆包办公 / 豆包」是同一家 `doubao` 的两个包)。 */
const WINDOW_ONLY = ['doubao', 'kimi', 'manus', 'muse', 'com.google.antigravity', 'com.anysphere.sand'] as const
/** 窗口是它们的**第二条路**(真正的通道是协议)。 */
const PROTOCOL_FIRST = ['codex', 'claude'] as const

describe('差异表:会执行的差别只有「有没有深链」', () => {
  it('★只有 Codex 与 Claude 有深链;窗口型那几家一条都没有', async () => {
    const withLink = WINDOW_FAMILIES.filter(one => one.deepLink !== undefined).map(one => one.family)
    expect(withLink.sort()).toEqual([...PROTOCOL_FIRST].sort())
    for (const family of WINDOW_ONLY) {
      expect(windowFamilyRow(family).deepLink).toBeUndefined()
      expect(windowDeepLink(family, { sessionId: 'window:825f1900' })).toBeUndefined()
    }
  })

  it('★Codex:会话 id 就是 threadId,不用另读编号', () => {
    expect(windowDeepLink('codex', { sessionId: 'thread_abc' })).toBe('codex://threads/thread_abc')
    // 会话 id 是空的 → 不编一条链。
    expect(windowDeepLink('codex', { sessionId: '' })).toBeUndefined()
  })

  it('★Claude:要桌面 App 里那个 local_… 编号;读不到就没有深链(不编一条)', () => {
    expect(windowDeepLink('claude', { sessionId: 'x', hostId: 'local_aceefe64' }))
      .toBe('claude://code/continue?session=local_aceefe64')
    expect(windowDeepLink('claude', { sessionId: 'x' })).toBeUndefined()
    expect(windowDeepLink('claude', { sessionId: 'x', hostId: '  ' })).toBeUndefined()
  })

  it('★编号 / 会话 id 里的特殊字符要转义(不许拼出一条坏链)', () => {
    expect(windowDeepLink('codex', { sessionId: 'a b/c' })).toBe('codex://threads/a%20b%2Fc')
  })
})

describe('表外的一家照样跑:缺省行', () => {
  it('★运行时发现的那两家(家名就是包标识)走缺省行,表里一行都没有', () => {
    for (const family of ['com.google.antigravity', 'com.anysphere.sand']) {
      expect(WINDOW_FAMILIES.some(one => one.family === family)).toBe(false)
      const row = windowFamilyRow(family)
      expect(row.family).toBe(family)
      expect(row.note).toBe(WINDOW_FAMILY_DEFAULT.note)
      expect(row.deepLink).toBeUndefined()
    }
  })

  it('★下一家新接上的(这张表里压根没有的家名)也走缺省行', () => {
    const row = windowFamilyRow('com.some.newly.discovered.agent')
    expect(row.note).toBe(WINDOW_FAMILY_DEFAULT.note)
  })
})

describe('表里的家名不许凭空造', () => {
  it('★每一行的家名都在家族目录(`FAMILY_SOURCES`)里 —— 家名的主人只有那一处', () => {
    const known = new Set(FAMILY_SOURCES.map(one => one.agent))
    for (const row of WINDOW_FAMILIES) expect(known.has(row.family)).toBe(true)
  })

  it('★每一行都写清了「这一家差在哪」(给交接与新接手的人看)', () => {
    for (const row of WINDOW_FAMILIES) expect(row.note.trim().length).toBeGreaterThan(10)
  })
})

/*
 * ★ **「每一种 JobKind 在闸上叫什么」那一条搬去引擎了**(2026-10-02,卡「引擎接线与删复制品」):
 * 闸只接在引擎一处(`engine.JOB_GATE_ACTION` + `jobGateActionOf`,`tests/engine-core.test.ts` 钉着),
 * 这一层只剩 `window_wake` 与 `approval_read` / `approval` 两样 —— 那张表删了,这一条跟着删。
 */

describe('点一下:走批准那条路还是普通选项(一处判)', () => {
  it('★带了认弹窗的原话 + 壳会看批准弹窗 + 那颗键认得出是批准 / 拒绝 → 批准那条路', () => {
    expect(windowPressRoute({ label: 'Allow once', marks: ['rm -rf ./build'], canApprove: true })).toBe('approval')
    expect(windowPressRoute({ label: '允许', marks: ['rm -rf ./build'], canApprove: true })).toBe('approval')
    expect(windowPressRoute({ label: '拒绝', marks: ['rm -rf ./build'], canApprove: true })).toBe('approval')
  })

  it('★差一条就是普通选项', () => {
    // 没有认弹窗的原话。
    expect(windowPressRoute({ label: 'Allow once', marks: [], canApprove: true })).toBe('option')
    // 旧壳不会看批准弹窗。
    expect(windowPressRoute({ label: 'Allow once', marks: ['x'], canApprove: false })).toBe('option')
    // 那颗键是它明写的一个选项,认不出是批准 / 拒绝那一类。
    expect(windowPressRoute({ label: '方案 A', marks: ['x'], canApprove: true })).toBe('option')
  })
})
