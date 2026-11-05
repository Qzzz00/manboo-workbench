// @vitest-environment node
/**
 * ★ **这个文件钉的是「读额度要不要把藏着的那家放出来」这一件事,三张卡在它上面各改过一次口径。**
 *
 * 1. **2026-09-27**(维护者原话:「点击右上角的设置按钮,依次闪过 manus、muse、豆包、Grok bot
 *    四个应用,才显示出设置页面」)→ 定下「放出来只许发生在她点『读一下』那一下;自动那几路一律
 *    `unhide:false`」。这个文件当时钉的就是那两句。
 * 2. **2026-10-03 卡 QZ** 把它否了:豆包 / Muse / Grok Bot 此刻都在跑、只是被工作台自己的窗口槽
 *    ⌘H 藏着,而那张卡的前提是「藏着的 App 一扇窗都不在任何桌面上,不放出来就只能回 `no_window`」——
 *    于是改成「**读的时候一律放**」。维护者 10-03:「不用写原因,我要的是解决」。
 * 3. ★ **2026-10-03 卡 QT** 把 ② 那个**前提**量掉了。同一台机器上逐家量
 *    (`probe read-texts <包> --no-unhide`,三家都是藏着的):
 *
 *        豆包办公  102 块字 / 517 个节点 / 127ms
 *        Muse       85 块字 / 2 扇窗    / 440ms
 *        Grok Bot   89 块字 / 1 扇窗    /  64ms
 *
 *    **藏着的家读得到** —— 那一下放窗本来就不必。所以这一版的规矩是**两眼**:
 *    第一眼一律 `unhide:false`(她眼前一动不动),按原样读不到、而且这一格的数真过了线,
 *    才放出来再读一眼。09-27 那句「依次闪过四个应用」于是在常态下彻底没有了。
 *
 * 放窗那一眼**没有删掉**:同一台机器上量到 Muse 藏着时 `AXWindows` 只有 2 扇、放出来是 3 扇,
 * 而「使用情况」那一页就在多出来的那一扇(设置窗)上。所以口径是「按原样读不到 → 才值得放一次窗」,
 * 既不是「一律放」,也不是「一律不放」。
 *
 * 这个文件留着(而不是删掉)是为了挡住两头:哪天有人照着 09-27 的交接把放窗整个去掉,
 * 或者照着卡 QZ 的交接把它改回「一律放」。
 */
import { describe, expect, it } from 'vitest'
import { DOUBAO_WINDOW, MANUS_WINDOW, MUSE_WINDOW, createWindowQuotaReader } from '../src/server/agentQuota.ts'

/** 这三家此刻都在跑、只是被窗口槽藏着 —— 现场就是这个样子(10-03 `ps` 里都有)。 */
const HIDDEN_BUT_RUNNING = [MANUS_WINDOW, MUSE_WINDOW, DOUBAO_WINDOW]
  .map(spec => ({ bundle_id: spec.bundleId, hidden: true }))

function world() {
  const sent: { op?: string, bundle_id?: string, unhide?: unknown, label?: unknown }[] = []
  const r = createWindowQuotaReader({
    request: async (req: unknown) => {
      sent.push(req as never)
      return { ok: true, result: { apps: HIDDEN_BUT_RUNNING, matches: [], windows: [], text_nodes: 0, window_count: 0 } }
    },
    helper: () => ({ connected: true, authorized: true, readTexts: true }),
    now: () => new Date('2026-10-03T06:00:00Z'),
    wait: async () => {},
  } as never)
  return { r, reads: (): typeof sent => sent.filter(one => one.op === 'read_texts'), sent }
}

describe('读额度:先按原样读,放窗只当第二眼(2026-10-03 卡 QT 收口)', () => {
  it('★第一眼一律 unhide:false —— 她眼前一扇窗都不动(否掉卡 QZ 那句「一律放」)', async () => {
    const { r, reads } = world()
    await r.refresh()
    expect(reads().length).toBeGreaterThan(0)
    // 每一家的**第一条** read_texts 都不放窗。
    const firstOf = new Map<unknown, unknown>()
    for (const one of reads()) if (!firstOf.has(one.bundle_id)) firstOf.set(one.bundle_id, one.unhide)
    expect([...firstOf.values()].every(unhide => unhide === false)).toBe(true)
  })

  it('★按原样读不到、这一格又从没读到过数 → 才放出来再读一眼(放窗这一支没被删掉)', async () => {
    const { r, reads } = world()
    await r.refresh()
    // 这三家一次都没读到过数(`lastAt` 缺席)= `worthUnhiding` 放行,所以每一家都有第二眼。
    for (const spec of [MANUS_WINDOW, MUSE_WINDOW, DOUBAO_WINDOW]) {
      const mine = reads().filter(one => one.bundle_id === spec.bundleId)
      expect(mine.length).toBeGreaterThanOrEqual(2)
      expect(mine.some(one => one.unhide === true)).toBe(true)
    }
  })

  it('★她点「读一下」时也是先按原样读 —— 不为「她点的」多闪一次窗', async () => {
    const { r, reads } = world()
    await r.refresh(undefined, { press: true })
    expect(reads().length).toBeGreaterThan(0)
    const firstOf = new Map<unknown, unknown>()
    for (const one of reads()) if (!firstOf.has(one.bundle_id)) firstOf.set(one.bundle_id, one.unhide)
    expect([...firstOf.values()].every(unhide => unhide === false)).toBe(true)
    // 她点的那一下读不到时照旧放窗(`worthUnhiding` 的 `byHand` 一律放行)。
    expect(reads().some(one => one.unhide === true)).toBe(true)
  })
})

/**
 * ★ 2026-10-08 真机:Muse 那格 10-03 起一直读不到(「使用情况」那扇设置窗没开着,自动那一轮又不开深链),
 * 于是每 10 分钟「过了线 → 放窗再读一眼」,放出来一扇对话框、读不到、藏回去 —— 她看见的就是「时不时闪一下」,
 * 而且永远白闪。规矩:自动那一轮放过一次窗还是读不到,就不再为它放窗,等她亲手点「读一下」。
 */
describe('读额度:自动那一轮放窗白放过一次,就不再放(2026-10-08 Muse 闪一下)', () => {
  it('★第二轮自动读不再放任何一家的窗', async () => {
    const { r, reads, sent } = world()
    await r.refresh()
    expect(reads().some(one => one.unhide === true)).toBe(true)
    sent.length = 0
    await r.refresh()
    expect(reads().length).toBeGreaterThan(0)
    expect(reads().some(one => one.unhide === true)).toBe(false)
  })

  it('★她点「读一下」照旧放窗;放了还是读不到,之后自动那一轮也照旧不放', async () => {
    const { r, reads, sent } = world()
    await r.refresh()
    sent.length = 0
    await r.refresh(undefined, { press: true })
    expect(reads().some(one => one.unhide === true)).toBe(true)
    sent.length = 0
    await r.refresh()
    expect(reads().some(one => one.unhide === true)).toBe(false)
  })
})
