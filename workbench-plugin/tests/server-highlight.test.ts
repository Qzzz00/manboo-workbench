/**
 * 窗口槽那圈原生流线光:只剩「他亲手把新应用拖进窗口槽、松手」那一下(2026-09-25 卡 P 补三)。
 *
 * 以前这个服务还管「事务官在动哪一块,就在那一块边上打一圈光 + 一行字」:区域 → 屏幕矩形,看板那块页面没报过,
 * 就按布局参数自己重算(moduleRectInWebview)。0.3.1 算漂了 —— 「事务官正在挪任务卡的状态」连同一圈光框挂在
 * 工作台左上角。统筹定:程序做的动作一律只出一行字,页面挂在真实的元素上画(server/actorNotes.ts +
 * client/ActorNotes.tsx);这里只剩 drop 一下,矩形只用页面自己量了报上来的槽体矩形。
 */
import { describe, expect, it, vi } from 'vitest'
import type { HelperRect } from '../src/protocol.ts'
import { DROP_LABEL, createHighlightService } from '../src/server/highlight.ts'

const WEBVIEW: HelperRect = { x: 100, y: 50, w: 2000, h: 1200 }

/** 假壳:screen_info 给固定 webview,其余一律 ok。 */
function fakeHelper(fail = false) {
  const calls: Record<string, unknown>[] = []
  const request = vi.fn(async (req: Record<string, unknown>) => {
    calls.push(req)
    if (fail) throw new Error('壳没连')
    if (req.op === 'screen_info') return { webview: WEBVIEW, scale: 1 }
    return {}
  })
  return { request, calls, lit: () => calls.filter(c => c.op === 'highlight_region') }
}

describe('窗口槽那圈原生流线光:只剩「拖进来、松手」那一下', () => {
  it('页面报过槽体矩形 → 换算成屏幕坐标亮一轮,带「认领到窗位了」', async () => {
    const helper = fakeHelper()
    const service = createHighlightService({ helper: { request: helper.request as never }, ttlMs: 2000 })
    service.setSlotRect({ x: 10, y: 20, w: 800, h: 500 })
    expect(await service.drop?.()).toBe(true)
    expect(helper.lit()).toEqual([{ op: 'highlight_region', rect: { x: 110, y: 70, w: 800, h: 500 }, ttl_ms: 2000, label: DROP_LABEL }])
  })

  it('槽体矩形没报过 / 被清掉(模块收起、纯净模式)→ 不亮,回 false,壳一次都不叫', async () => {
    const helper = fakeHelper()
    const service = createHighlightService({ helper: { request: helper.request as never } })
    expect(await service.drop?.()).toBe(false)
    service.setSlotRect({ x: 10, y: 20, w: 800, h: 500 })
    service.setSlotRect(undefined)
    expect(await service.drop?.()).toBe(false)
    expect(helper.calls).toEqual([])
  })

  it('壳断线:吞掉,回 false(没光而已,不是谁的错)', async () => {
    const helper = fakeHelper(true)
    const service = createHighlightService({ helper: { request: helper.request as never } })
    service.setSlotRect({ x: 10, y: 20, w: 800, h: 500 })
    expect(await service.drop?.()).toBe(false)
  })

  it('★这个服务上没有「按区域打光」「按布局算矩形」「在动作前后打光」那些口了', () => {
    const service = createHighlightService({ helper: { request: vi.fn() as never } })
    expect(Object.keys(service).sort()).toEqual(['drop', 'idle', 'setSlotRect'])
  })
})
