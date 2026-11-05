/**
 * **派活撞上「一扇标准窗口都没有」:先把这个包的窗开出来重试 → 还不行再换包 → 到顶如实说**
 * (2026-10-01,卡 AX3;维护者 21:3x:「现在所有你知道的走不通的,都做到走通为止」「能力是通用的」)。
 *
 * 现场:卡 AX2 把**窗口上那五条路**(答 / 捎话 / 点选项 / 写面板 / 批准)收进了同一圈
 * 「没窗口就把窗开出来再来一遍」(`withWindowWake`),但**派活那条路**(`dispatchClient.sendOnce`)
 * 还是老样子:它只有自己那套「换同一家另一个装着的包再送」(10-01 Air 诊断包 095718),
 * 遇到「那个包在跑、一扇窗都没有」时**一回都不重开** —— 于是豆包只剩菜单栏图标时从手机派活照旧派不出去。
 *
 * 守的口径与那五条路**逐字同一套**(实现只有一份:`src/server/windowWake.ts`):
 * ① 壳说没窗口 → `open -b` 把窗真正开出来、等一拍、再来一遍,最多 `NO_WINDOW_WAKE_TRIES` 回;
 * ② 真壳 ok:false 是 **reject 一个 Error**(`helperChannel`),所以 reject 版与 `{ok:false}` 版都要认;
 * ③ 到顶还是没有 → **如实说**,并且说出又开了几回(`NO_WINDOW_GAVE_UP`);
 * ④ **只在 no_window 重开**:别的失败(输入框没找到、弹框挡着……)是那扇窗上的事实,一回都不重开
 *    —— 重开就等于把那段交代又打了一遍;
 * ⑤ 次序:**先开这个包的窗重试,还不行才换包**。
 *
 * ★ 2026-10-02(卡「引擎接线与删复制品」),这一份改了三处口径,都不是行为退步:
 *
 * 1. 送话后面换成引擎了:**开窗那一圈在窗口适配器,换包的决定也在那里,再来一回的循环在引擎**
 *    (`RetryableError`)。所以这一份改成「假壳 + 真引擎」(`engineHarness`)端到端跑。
 * 2. **回包上那一格 `front` 没有了**:契约里 `JobResult` 压根没有它(窗口适配器那张卡写明),
 *    `windowWake.frontTraceText` 也跟着删了。「又开了几回窗」那句实话照旧有 ——
 *    `noWindowWhy` 把它接进失败那一句(`NO_WINDOW_GAVE_UP`),断言改成读它。
 * 3. **开窗那几回现在真过闸**(`window_wake`:3 回 / 一件事 · 一家,`GATE_LIMITS`)。
 *    从前这一份的假件没接闸,所以看不见这条上限;生产里 `index.ts` 一直接着它。
 *    于是「两个包都没窗口」时第一个包用光了开窗的预算,第二个包只送一回、不再开窗 ——
 *    这是生产里原来就有的口径。预算够的时候每个包照样都开窗(下面那条「预算够」的用例钉的就是它)。
 */
import { describe, expect, it } from 'vitest'
import { createClientDispatch } from '../src/server/dispatchSend.ts'
import type { DispatchTarget } from '../src/server/dispatchTargets.ts'
import { NO_WINDOW_GAVE_UP, NO_WINDOW_WAKE_TRIES } from '../src/server/windowWake.ts'
import type { EngineHarnessOptions } from './helpers/engineHarness.ts'
import { engineHarness } from './helpers/engineHarness.ts'

const CLAUDE = 'com.anthropic.claudefordesktop'
const WORK = 'com.work.pc.doubao'
const STORE = 'com.bot.neotix.doubao'

/** 壳那句原话(`SendTextPolicy.Failure.noWindow` 的措辞,逐字照真机那一句)。 */
const NO_WINDOW = (bundleId: string): string =>
  `找不到窗口:${bundleId} 在跑,但一扇标准窗口都没有(可能最小化了或只剩菜单栏图标)`

const TWO_DOUBAO: DispatchTarget = {
  id: 'doubao',
  title: '豆包办公',
  bundle_id: WORK,
  packages: [
    { bundle_id: WORK, name: '豆包工作', running: true },
    { bundle_id: STORE, name: '豆包', running: true },
  ],
} as unknown as DispatchTarget

/** 两个豆包那一台:适配器挑包 / 换包的输入(与 `tests/dispatch-family-fallback.test.ts` 同一份)。 */
const TWO_INSTALLED = [
  { bundle_id: WORK, name: '豆包工作', running: true },
  { bundle_id: STORE, name: '豆包', running: true },
]

interface Options {
  /** 这几个包上,壳一律说「一扇标准窗口都没有」。 */
  noWindow?: readonly string[]
  /** 开窗开到第几回之后那个包就有窗口了(0 = 一直没有)。 */
  wakesAt?: number
  /** 壳回失败的形状:reject 一个 Error(真通道)还是回 `{ok:false}`(老的假件)。 */
  shape?: 'reject' | 'flag'
  /** 这台机器上接没接「把窗真正开出来」这件本事(缺席 = 老宿主,一回都不重开)。 */
  canOpen?: boolean
  /** 别的失败(不是没窗口那一类):壳每回都这么回。 */
  otherFailure?: string
  targets?: readonly DispatchTarget[]
  /** 这一家这台电脑上装着哪几个包(缺席 = 只有家族目录那个主包,一个都不换)。 */
  installed?: readonly { bundle_id: string, name?: string, running?: boolean }[]
  /** 盖掉闸的上限(「开窗预算够」那一条用它)。 */
  limits?: EngineHarnessOptions['limits']
}

function harness(options: Options = {}) {
  const opened: string[] = []
  const noWindow = new Set(options.noWindow ?? [])
  const h = engineHarness({
    reply: (req) => {
      if (req.op !== 'send_text') return { found: false }
      if (options.otherFailure !== undefined) {
        if (options.shape === 'flag') return { ok: false, error: options.otherFailure }
        throw new Error(options.otherFailure)
      }
      const bundleId = (req as { bundle_id: string }).bundle_id
      const awake = options.wakesAt !== undefined && options.wakesAt > 0
        && opened.filter(one => one === bundleId).length >= options.wakesAt
      if (noWindow.has(bundleId) && !awake) {
        if (options.shape === 'flag') return { ok: false, error: NO_WINDOW(bundleId) }
        throw new Error(NO_WINDOW(bundleId))
      }
      return { submitted: true, method: 'ax_value' }
    },
    ...(options.installed === undefined ? {} : { installed: () => options.installed }),
    ensureRunning: () => Promise.resolve({ ok: true }),
    bringToFront: () => Promise.resolve({ ok: true }),
    ...(options.canOpen === false
      ? {}
      : { openApp: (bundleId: string) => { opened.push(bundleId); return Promise.resolve({ ok: true }) } }),
    ...(options.limits === undefined ? {} : { limits: options.limits }),
  })
  const dispatch = createClientDispatch({
    engine: h.engine,
    ...(options.targets === undefined ? {} : { targets: () => options.targets as readonly DispatchTarget[] }),
    sessionIdsOf: () => [],
    now: () => new Date('2026-10-01T13:37:03.000Z'),
  })
  return { dispatch, sentTo: h.sentTo, opened, sends: () => h.sentTo().length }
}

for (const shape of ['reject', 'flag'] as const) {
  describe(`派活遇到没窗口(壳${shape === 'reject' ? ' reject 一个 Error(真通道)' : ' 回 {ok:false}(老假件)'})`, () => {
    it('★开窗后送成了:同一个包重试一回就进去了', async () => {
      const h = harness({ noWindow: [CLAUDE], wakesAt: 1, shape })
      const got = await h.dispatch.send({ family: 'claude', text: '看看这个', submit: true })
      expect(got.ok).toBe(true)
      expect(h.sentTo()).toEqual([CLAUDE, CLAUDE])
      expect(h.opened).toEqual([CLAUDE])
      /*
       * 送成了就不再多说一句开窗的事:`JobResult` 没有 `front` 那一格(2026-10-02),
       * 「又开了几回」只在**没送成**那一句里说(见下一条)。回包里一句多余的话都没有。
       */
      expect(got.front_note).toBeUndefined()
    })

    it('★一直没窗口、这一家只有一个包 → 开满 3 回,如实说又开了几回', async () => {
      const h = harness({ noWindow: [CLAUDE], shape })
      const got = await h.dispatch.send({ family: 'claude', text: '看看这个', submit: true })
      expect(got.ok).toBe(false)
      expect(got.kind).toBe('no_window')
      expect(h.sends()).toBe(1 + NO_WINDOW_WAKE_TRIES)
      expect(h.opened).toHaveLength(NO_WINDOW_WAKE_TRIES)
      expect(got.reason ?? '').toContain(NO_WINDOW_GAVE_UP)
      // 卡上那一条也要带着这句实话 —— **不许**说成送到了。
      expect(got.dispatch?.status).toBe('failed')
      expect(got.dispatch?.reason ?? '').toContain(NO_WINDOW_GAVE_UP)
    })

    it('★别的失败一回都不重开(不多打一遍交代)', async () => {
      const h = harness({ otherFailure: '输入框没找到:com.anthropic.claudefordesktop —— 这扇窗的 AX 树里没有任何文本输入元素', shape })
      const got = await h.dispatch.send({ family: 'claude', text: '看看这个', submit: true })
      expect(got.ok).toBe(false)
      expect(got.kind).toBe('no_input')
      expect(h.sends()).toBe(1)
      expect(h.opened).toEqual([])
      expect(got.reason ?? '').not.toContain(NO_WINDOW_GAVE_UP)
    })
  })
}

describe('次序:先开这个包的窗重试,还不行才换包', () => {
  it('★豆包工作开了 3 回还是没窗口 → 换 App Store 版送进去,话里说清派给了哪一个', async () => {
    const h = harness({ noWindow: [WORK], targets: [TWO_DOUBAO], installed: TWO_INSTALLED })
    const got = await h.dispatch.send({ family: 'doubao', text: '说明今天深圳的天气', said: '让豆包说明今天深圳的天气', submit: true })
    expect(got.ok).toBe(true)
    // 先把豆包工作那扇窗开满 3 回(每回一次送),才轮到另一个包。
    expect(h.sentTo()).toEqual([WORK, WORK, WORK, WORK, STORE])
    expect(h.opened).toEqual([WORK, WORK, WORK])
    expect(got.bundle_id).toBe(STORE)
    /*
     * 两个同名图标摆在坞上:**说清这次派给的是哪一个**(卡 DP)。
     * 2026-10-02 起这一句只说「派给了哪一个」—— 从前它还捎着「豆包工作那边没有窗口、又开了 3 回」,
     * 那段话现在只在**没送成**那一句里(送成了就别再念一遍没走通的中间过程)。
     */
    expect(got.package_note ?? '').toContain('豆包')
    expect(got.package_note ?? '').toContain('这次派给的是')
  })

  it('★换包也不行 → 如实说:装着的都试了(开窗的预算第一个包用光了)', async () => {
    const h = harness({ noWindow: [WORK, STORE], targets: [TWO_DOUBAO], installed: TWO_INSTALLED })
    const got = await h.dispatch.send({ family: 'doubao', text: 'x', said: '让豆包说明', submit: true })
    expect(got.ok).toBe(false)
    expect(got.kind).toBe('no_window')
    /*
     * 闸把 `window_wake` 封在 3 回 / 一件事 · 一家(`GATE_LIMITS`),第一个包就用光了 ——
     * 所以第二个包只送一回、一扇窗都没替它开。**这不是少做了一步**:那是「同一件事别把她的窗
     * 弹到眼前没完」那条上限,生产里一直这么接着(老用例没接闸才看不见)。
     */
    expect(h.sentTo()).toEqual([WORK, WORK, WORK, WORK, STORE])
    expect(h.opened).toEqual([WORK, WORK, WORK])
    expect(got.reason ?? '').toContain('个都试了')
    expect(got.reason ?? '').toContain('豆包工作')
  })

  it('★开窗预算够的时候,换过去那个包的窗照样开满 3 回', async () => {
    const h = harness({
      noWindow: [WORK, STORE],
      targets: [TWO_DOUBAO],
      installed: TWO_INSTALLED,
      limits: { window_wake: { tries: 6, minIntervalMs: 0 } },
    })
    const got = await h.dispatch.send({ family: 'doubao', text: 'x', said: '让豆包说明', submit: true })
    expect(got.ok).toBe(false)
    expect(h.sentTo()).toEqual([WORK, WORK, WORK, WORK, STORE, STORE, STORE, STORE])
    expect(h.opened).toEqual([WORK, WORK, WORK, STORE, STORE, STORE])
    // 最后试的那一个开满了,所以这一句里「又开了几回」也在(与上一条对照看)。
    expect(got.reason ?? '').toContain(NO_WINDOW_GAVE_UP)
  })

  it('★她点名了哪一个:照旧不换包,但这个包的窗照样开(她要的就是它)', async () => {
    const h = harness({ noWindow: [WORK], wakesAt: 2, targets: [TWO_DOUBAO], installed: TWO_INSTALLED })
    const got = await h.dispatch.send({ family: 'doubao', text: 'x', said: '让豆包办公说明今天深圳的天气', submit: true })
    expect(got.ok).toBe(true)
    expect(h.sentTo()).toEqual([WORK, WORK, WORK])
    expect(h.opened).toEqual([WORK, WORK])
  })
})

describe('开新会话那条路(派活一律先按「新对话」)也走这一圈', () => {
  it('★`newConversation` 那一送撞上没窗口 → 开窗后送成,那一格照旧带给壳', async () => {
    const h = harness({ noWindow: [CLAUDE], wakesAt: 1 })
    const got = await h.dispatch.send({ family: 'claude', text: '拆这件活', submit: true, newConversation: true })
    expect(got.ok).toBe(true)
    expect(h.sentTo()).toEqual([CLAUDE, CLAUDE])
    expect(h.opened).toEqual([CLAUDE])
  })
})

describe('这台机器上没接「把窗开出来」这件本事', () => {
  it('★`openApp` 缺席 → 一回都不重开(老宿主 / 老用例一字不变)', async () => {
    const h = harness({ noWindow: [CLAUDE], canOpen: false })
    const got = await h.dispatch.send({ family: 'claude', text: '看看这个', submit: true })
    expect(got.ok).toBe(false)
    expect(got.kind).toBe('no_window')
    expect(h.sends()).toBe(1)
    // 没重开过 → 那句实话一个字不加(壳原话原样)。
    expect(got.reason ?? '').not.toContain(NO_WINDOW_GAVE_UP)
  })
})
