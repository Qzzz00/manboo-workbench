/**
 * 窗口槽那圈原生流线光(2026-09-10 起的「光圈」,2026-09-25 卡 P 补三起**只剩这一下**)。
 *
 * 维护者定的:流线光效**只属于他亲手把一个新应用拖进窗口槽、松手那一下**(`drop`)。
 * 事务官(或别的程序)做的动作一律只出一行字,由页面挂在真实的元素上画(见 server/actorNotes.ts);
 * 服务端不再按布局参数算「某一块在屏幕哪里」让壳去画 —— 那条路 0.3.1 真的漂了:
 * 「事务官正在挪任务卡的状态」连同一圈光框挂在工作台左上角,任务卡却在右边的看板里。
 *
 * 这一下为什么还要壳画(不交给页面):窗口槽里贴着的是一扇真实的原生窗,压在网页上面,
 * 网页自己那圈光被它盖住看不见;壳的浮窗压在所有应用窗之上。矩形是**页面自己量了报上来的**
 * 槽体矩形(`/slot/rect`),按 orchestrator.pageRectToScreen 换成屏幕坐标 —— 不是服务端算的。
 *
 * 纪律:**打光失败绝不影响任何动作**。drop() 只回亮没亮成,永不抛:壳没连、辅助功能没授权、
 * screen_info 超时,都只是没光而已(页面自己那圈 border-beam 顶上)。
 */
import type { HelperRect } from '../protocol.ts'
import type { HelperChannel } from './helperChannel.ts'
import { pageRectToScreen } from './orchestrator.ts'

/** 光亮多久。Ben 定的 2 秒:够看见一眼,不会糊在屏幕上。 */
export const DEFAULT_HIGHLIGHT_TTL_MS = 2000

/** 拖窗悬停时槽体里那句提示 —— 与网页槽体里那句同一句(SlotZone.tsx)。悬停时**只有这句字,没有光**(卡 P)。 */
export const HOVER_LABEL = '松手认领到窗位'
/** 真拖进一个新应用、放手那一下,槽上那圈光带的那行字(2026-09-25,卡 P)。 */
export const DROP_LABEL = '认领到窗位了'

export interface HighlightServiceOptions {
  helper: Pick<HelperChannel, 'request'>
  /** 光亮多久,默认 2 秒。 */
  ttlMs?: number
}

export interface HighlightService {
  /**
   * 页面报来的窗口槽槽体矩形(**页面坐标**,与 /slot/rect 收到的是同一个值)。
   * undefined = 失效(模块收起 / 纯净模式),清掉不留旧值 —— 指向空处的旧矩形会把光打到别处。
   */
  setSlotRect(rect: HelperRect | undefined): void
  /**
   * 他真把一个新应用拖进窗口槽、放手那一下(2026-09-25,卡 P;维护者:「窗口槽的流线光效时不时自己闪一下,
   * 其实没拖新应用进去」)。在槽的屏幕矩形上亮**一轮**原生光(ttl 那么久,压在所有应用窗之上),不续期。
   * 回「原生那圈亮没亮成」:亮成了页面就不再画自己那圈。永不抛。可选:测试替身不实现它 = 没有这一档。
   */
  drop?(): Promise<boolean>
  /** 等排队中的打光跑完。测试用;关停时也可以拿它把尾巴收干净。 */
  idle(): Promise<void>
}

export function createHighlightService(opts: HighlightServiceOptions): HighlightService {
  const ttlMs = opts.ttlMs ?? DEFAULT_HIGHLIGHT_TTL_MS
  let slotRect: HelperRect | undefined
  /** 串行队列:打光要问 screen_info,并发几条只会互相抢答,没有意义(先例 dock.enqueueWrite)。 */
  let chain: Promise<unknown> = Promise.resolve()

  function enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = chain.then(fn, fn)
    chain = next.catch(() => {})
    return next
  }

  return {
    setSlotRect(rect: HelperRect | undefined): void {
      slotRect = rect
    },

    drop(): Promise<boolean> {
      // 亮一轮就好(ttl 到了壳自己灭),不续期:这是「放下了」的回声,不是一直亮着的状态。
      return enqueue(async () => {
        try {
          const page = slotRect
          if (page === undefined) return false
          const screen = await opts.helper.request({ op: 'screen_info' }) as unknown as { webview: HelperRect, scale: number }
          const rect = pageRectToScreen(page, screen.webview, screen.scale)
          await opts.helper.request({ op: 'highlight_region', rect, ttl_ms: ttlMs, label: DROP_LABEL })
          return true
        }
        catch {
          // 壳没连 / 没授权 / 超时:没光而已,不升级成任何人的错误。
          return false
        }
      })
    },

    idle(): Promise<void> {
      return chain.then(() => {})
    },
  }
}
