// @vitest-environment node
/**
 * **引擎接线上那两只手**(2026-10-03,卡「接缝清理」第 2 条;决策记录「2026-10-03 早」⑦)。
 *
 * 前因(`docs/交接-1002-引擎接线与删复制品.md` 第六节 ③④):删旧管线那一张卡把这两段判断
 * 接进了 `index.ts`,而 `index.ts` 够不到用例 —— 于是
 *
 * - 「包标识 → 窗位叠那一格的键」(`c-muse` 这种反查)**从此没人钉**:它从前在
 *   `dispatchClient.CLIENT_DISPATCH_DOCK_KEYS` 旁边有一条用例;
 * - `workdir(job)`(按卡查「许不许改文件」)只有真机那一跑的 rollout 文件作证。
 *
 * 搬成纯函数(`src/server/engine/wireHands.ts`)之后这一份补上那两道网。**行为一个字不变**。
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createAppsRegistry } from '../src/server/appsRegistry.ts'
import { bringAgentToFront, codexWorkdirOf, type BringToFrontDeps } from '../src/server/engine/wireHands.ts'

/**
 * 这一下谁被调过(次序照原样)。`key` 是反查答的那个键:
 * `undefined` = 窗位叠不认得它;`'throw'` = 反查这一路自己抛了。
 */
function spy(calls: string[], options: {
  key?: string | 'throw'
  switched?: boolean
  opened?: boolean
} = {}): BringToFrontDeps {
  return {
    keyFor: async (bundleId) => {
      if (options.key === 'throw') throw new Error('appsRegistry 读不了')
      calls.push(`keyFor:${bundleId}`)
      return options.key === undefined ? undefined : { key: options.key }
    },
    switchTo: async (key) => { calls.push(`switchTo:${key}`); return { ok: options.switched ?? true } },
    openApp: async (bundleId) => { calls.push(`openApp:${bundleId}`); return { ok: options.opened ?? true } },
  }
}

describe('叫那一家到台前(bringAgentToFront)', () => {
  it('★窗位叠里认得它、也切过去了 → 就到这儿为止,不再 open -b', async () => {
    const calls: string[] = []
    expect(await bringAgentToFront(spy(calls, { key: 'c-muse', switched: true }), 'com.meta.endo')).toEqual({ ok: true })
    expect(calls).toEqual(['keyFor:com.meta.endo', 'switchTo:c-muse'])
  })

  it('认得它、可那一格摆不成 → 退到 open -b(次序:先反查、再切、再开)', async () => {
    const calls: string[] = []
    expect(await bringAgentToFront(spy(calls, { key: 'c-muse', switched: false }), 'com.meta.endo')).toEqual({ ok: true })
    expect(calls).toEqual(['keyFor:com.meta.endo', 'switchTo:c-muse', 'openApp:com.meta.endo'])
  })

  it('★窗位叠压根不认得它(豆包这种没进过基础七应用那张表的)→ 一格都不切,直接 open -b', async () => {
    const calls: string[] = []
    expect(await bringAgentToFront(spy(calls), 'com.bytedance.doubao.desktop')).toEqual({ ok: true })
    expect(calls).toEqual(['keyFor:com.bytedance.doubao.desktop', 'openApp:com.bytedance.doubao.desktop'])
  })

  it('★反查那一步自己抛了:不许往外窜 —— 照旧退到 open -b(认不出就直接叫它到前面)', async () => {
    const calls: string[] = []
    expect(await bringAgentToFront(spy(calls, { key: 'throw' }), 'com.meta.endo')).toEqual({ ok: true })
    expect(calls).toEqual(['openApp:com.meta.endo'])
  })

  it('退路也没成 → 如实回 ok:false(不说成叫到台前了)', async () => {
    expect(await bringAgentToFront(spy([], { opened: false }), 'com.meta.endo')).toEqual({ ok: false })
  })

  /**
   * ★ **真反查**(接上生产里那一份 `appsRegistry`,不是假件)。两条分支都钉:
   *
   * - **家族目录认识的那几家 → 基础键本身**(`com.meta.endo` → `muse`)。这一条 2026-09-27(卡 HC)
   *   变过:AI 各家的包标识那天搬进了 `activation.APP_BUNDLES`(从 `FAMILY_SOURCES` 现长),
   *   所以 Muse 从「自定义应用 `c-muse`」变成了基础键 `muse` —— 交接 1002 第六节 ③ 与
   *   `client/DockTabBar.tsx` 的注释里还写着 `c-muse`,**那是旧的**;
   * - **运行时才认出来的陌生 App → `c-<名字>`**(Grok Bot 这种:目录不认识、`APP_BUNDLES` 里没有)。
   */
  it('★真反查:家族目录认识的 → 基础键(com.meta.endo → muse);陌生 App → c-<名字>', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wb-wire-hands-'))
    try {
      // 生产里的那一份(`index.ts` 的 `createAppsRegistry`);反查走它的 `keyFor`。
      const registry = createAppsRegistry({
        file: join(dir, 'apps.json'),
        runOsascript: async () => ({ ok: false, stdout: '' }),
      })
      const calls: string[] = []
      const deps = {
        keyFor: (bundleId: string) => registry.keyFor(bundleId),
        switchTo: async (key: string) => { calls.push(key); return { ok: true } },
        openApp: async (bundleId: string) => { calls.push(`open:${bundleId}`); return { ok: true } },
      }
      // ① 家族目录认识的那几家:包标识在 `APP_BUNDLES` 里 → 键就是家名本身。
      expect(await registry.keyFor('com.meta.endo')).toMatchObject({ key: 'muse' })
      expect(await bringAgentToFront(deps, 'com.meta.endo')).toEqual({ ok: true })
      expect(calls).toEqual(['muse'])
      // ② 陌生 App(壳把它那扇窗拖进来 → 自愈注册 A2b):键 = `c-` + 名字的 slug。
      calls.length = 0
      expect(await registry.addResolved({ bundle_id: 'com.x.grok', name: 'Grok Bot' })).toMatchObject({ ok: true, key: 'c-grokbot' })
      expect(await registry.keyFor('com.x.grok')).toEqual({ key: 'c-grokbot', label: 'Grok Bot' })
      expect(await bringAgentToFront(deps, 'com.x.grok')).toEqual({ ok: true })
      expect(calls).toEqual(['c-grokbot'])
      // ③ 两边都查不到的那个包:反查回 undefined → 不瞎编一个键,直接 open -b。
      calls.length = 0
      await bringAgentToFront(deps, 'com.nobody.unknown')
      expect(calls).toEqual(['open:com.nobody.unknown'])
    }
    finally { await rm(dir, { recursive: true, force: true }) }
  })
})

describe('这件活在哪个目录干、许不许改文件(codexWorkdirOf)', () => {
  const cards = [
    { id: 't-1', dispatch: { cwd: '/Users/example/Documents/GitHub/desktop-workbench' } },
    { id: 't-2', dispatch: {} },
    { id: 't-3', dispatch: { cwd: '   ' } },
    { id: 't-4' },
  ]
  const deps = { cards: async () => cards }

  it('★有卡、卡上写明了目录 → 给 workspace-write + 这个 cwd', async () => {
    expect(await codexWorkdirOf(deps, { itemId: 't-1' }))
      .toEqual({ cwd: '/Users/example/Documents/GitHub/desktop-workbench', writes: true })
  })

  it('★有卡、卡上那一格空着(没派过写代码的活)→ 只读', async () => {
    // 三种「空着」都算:`dispatch` 在但没有 cwd、cwd 全是空白、压根没有 `dispatch` 那一格。
    expect(await codexWorkdirOf(deps, { itemId: 't-2' })).toEqual({ writes: false })
    expect(await codexWorkdirOf(deps, { itemId: 't-3' })).toEqual({ writes: false })
    expect(await codexWorkdirOf(deps, { itemId: 't-4' })).toEqual({ writes: false })
  })

  it('★这件活压根没挂卡(没带事项 id / 全是空白)→ 只读,一次都不去查看板', async () => {
    let asked = 0
    const counted = { cards: async () => { asked += 1; return cards } }
    expect(await codexWorkdirOf(counted, {})).toEqual({ writes: false })
    expect(await codexWorkdirOf(counted, { itemId: '  ' })).toEqual({ writes: false })
    expect(asked).toBe(0)
  })

  it('★带了事项 id、看板上查不到那张卡 → 只读(查不出不许猜一个目录给它写权限)', async () => {
    expect(await codexWorkdirOf(deps, { itemId: 't-404' })).toEqual({ writes: false })
  })

  it('★查看板自己抛了 → 只读(最保守那一档),不往外窜', async () => {
    expect(await codexWorkdirOf({ cards: async () => { throw new Error('看板读不了') } }, { itemId: 't-1' }))
      .toEqual({ writes: false })
  })
})
