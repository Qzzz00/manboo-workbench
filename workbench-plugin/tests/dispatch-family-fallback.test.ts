/**
 * 一家装着几个 App、挑中的那个没窗口 → 换同一家另一个再送(2026-10-01 Air 诊断包 095718)。
 *
 * 现场:Air 上装着两个豆包 —— 豆包办公(`com.work.pc.doubao`,在跑、一扇窗都没有)和
 * App Store 版豆包(`com.bot.neotix.doubao`,她平时开着的那扇)。工作台只认识前一个包,
 * 「让豆包说明今天深圳的天气」→ 派给豆包办公 →「一扇标准窗口都没有」→ 没派出去。
 *
 * 守:
 * ① App Store 版的包标识认得是豆包这一家;
 * ② 她只说「豆包」、挑中的那个没窗口 → 换另一个装着的再送一次,记下真送进去的那个、说清派给了哪一个;
 * ③ 她点名「豆包办公」→ 不换(换了就违背她的话),照实说没窗口;
 * ④ 换了也都不行 → 失败原因说的是最后试的那一个,而且说清两个都试过;
 * ⑤ 告诉壳「哪些包能送」时,一家的每个包都报上去(不然壳会拒掉挑中的第二个包)。
 *
 * ★ 2026-10-02(卡「引擎接线与删复制品」):送话后面换成引擎了 ——
 * **换哪一个包的决定在窗口适配器,再来一回的循环在引擎**(`RetryableError`),
 * 所以这一份用例改成「假壳 + 真引擎」端到端跑,断言的还是上面那五条。
 */
import { describe, expect, it } from 'vitest'
import { bindingForBundle, packagesOf, bindingFor } from '../src/server/agentSources.ts'
import { createClientDispatch } from '../src/server/dispatchSend.ts'
import type { DispatchTarget } from '../src/server/dispatchTargets.ts'
import { engineHarness } from './helpers/engineHarness.ts'

const WORK = 'com.work.pc.doubao'
const STORE = 'com.bot.neotix.doubao'

const AIR_TWO_DOUBAO: DispatchTarget = {
  id: 'doubao',
  title: '豆包办公',
  bundle_id: WORK,
  packages: [
    { bundle_id: WORK, name: '豆包工作', running: true },
    { bundle_id: STORE, name: '豆包', running: true },
  ],
} as unknown as DispatchTarget

function harness(noWindow: readonly string[]) {
  const h = engineHarness({
    reply: (req) => {
      if (req.op === 'send_text' && noWindow.includes(req.bundle_id)) {
        throw new Error(`找不到窗口:${req.bundle_id} 在跑,但一扇标准窗口都没有(可能最小化了或只剩菜单栏图标)`)
      }
      return { submitted: true, method: 'ax_value' }
    },
    // 这一家这台电脑上装着两个(挑哪一个、换哪一个都照 `pickFamilyPackage`)。
    installed: () => [
      { bundle_id: WORK, name: '豆包工作', running: true },
      { bundle_id: STORE, name: '豆包', running: true },
    ],
    nameOf: () => '豆包办公',
  })
  const dispatch = createClientDispatch({
    engine: h.engine,
    targets: () => [AIR_TWO_DOUBAO],
    sessionIdsOf: () => [],
    now: () => new Date('2026-10-01T01:37:03.000Z'),
  })
  return { dispatch, sentTo: h.sentTo }
}

describe('App Store 版豆包也是豆包这一家', () => {
  it('★包标识认得', () => {
    expect(bindingForBundle(STORE)?.agent).toBe('doubao')
    expect(packagesOf(bindingFor('doubao')).map(one => one.bundle_id)).toContain(STORE)
  })
})

describe('挑中的那个没窗口 → 换同一家另一个', () => {
  it('★只说「豆包」:豆包办公没窗口 → 换 App Store 版送进去,记下的是它,话里说清派给了哪一个', async () => {
    const h = harness([WORK])
    const got = await h.dispatch.send({ family: 'doubao', text: '说明今天深圳的天气', said: '让豆包说明今天深圳的天气', submit: true })
    expect(got.ok).toBe(true)
    expect(h.sentTo()).toEqual([WORK, STORE])
    expect(got.bundle_id).toBe(STORE)
    // 两个同名图标摆在坞上:说清这次派给的是哪一个(卡 DP)。
    expect(got.package_note).toContain('豆包')
    expect(got.package_note).toContain('这次派给的是')
  })

  it('★点名「豆包办公」:不换,照实说没窗口', async () => {
    const h = harness([WORK])
    const got = await h.dispatch.send({ family: 'doubao', text: 'x', said: '让豆包办公说明今天深圳的天气', submit: true })
    expect(got.ok).toBe(false)
    expect(h.sentTo()).toEqual([WORK])
    expect(got.kind).toBe('no_window')
  })

  it('两个都没窗口:失败,话里说清两个都试过', async () => {
    const h = harness([WORK, STORE])
    const got = await h.dispatch.send({ family: 'doubao', text: 'x', said: '让豆包说明', submit: true })
    expect(got.ok).toBe(false)
    expect(h.sentTo()).toEqual([WORK, STORE])
    expect(got.reason).toContain('个都试了')
    expect(got.reason).toContain('豆包工作')
  })

  it('挑中的那个就有窗口:只送一次,不多试', async () => {
    const h = harness([])
    const got = await h.dispatch.send({ family: 'doubao', text: 'x', said: '让豆包说明', submit: true })
    expect(got.ok).toBe(true)
    expect(h.sentTo()).toHaveLength(1)
  })
})

describe('告诉壳哪些包能送:一家的每个包都报', () => {
  it('★两个豆包都在名单里(壳才不会拒掉换过去的那个)', async () => {
    const { allowBundlesOf } = await import('../src/server/dispatchTargets.ts')
    expect(allowBundlesOf([AIR_TWO_DOUBAO, { id: 'codex', title: 'Codex', bundle_id: 'com.openai.codex' } as unknown as DispatchTarget]))
      .toEqual(['com.bot.neotix.doubao', 'com.openai.codex', 'com.work.pc.doubao'])
  })
})
