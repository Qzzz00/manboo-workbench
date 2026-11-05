/**
 * 弹层让开窗位(2026-09-11,Ben:「弹窗(包括现在的浮窗)一直是在应用下层的」)。
 *
 * 窗位里贴着的是真实原生窗,永远盖在 WKWebView 之上——网页里任何与窗位矩形重叠的弹层
 * 都会被它压住,CSS 排不到操作系统窗口前面。修法是:弹层打开 → POST /dock/veil {on:true}
 * (服务端把当前那扇 hide_app);弹层关闭/卸载 → {on:false}(服务端 unhide 并重贴)。
 * 服务端是计数式的(dock.ts veil/unveil),所以每个弹层各发自己的一对 on/off 即可,
 * 多个弹层同时开也只让一次、最后一个关才回来。
 *
 * 两条纪律:
 * - **配对**:少一个 off 窗位就永远空着;卸载走 keepalive fetch,关页时也能发出去。React 在
 *   整页关闭/重载时**不跑卸载**,所以 open 期间还挂一个 pagehide 监听补发 off。
 * - **顺序**:on/off 走同一条 promise 链串行发送——两条并发 fetch 可能乱序,off 先到会把
 *   计数卡在 1,之后每次弹层关闭都回不来。
 *
 * 失败静默(同 postSilently 的规矩):8791 重启/壳断开时让路不成就算了,弹层照开照关,不卡。
 * 不在壳里(target 为 undefined:浏览器里开的工作台页面没有原生窗盖着)什么都不发。
 *
 * 2026-09-14 追加(Ben:「设置按钮点击之后,现在会把在前端的页面隐藏,看下来有点像坏了,要不就是
 * 它刚好覆盖窗口槽,这样就看着不像是坏了」):让路之后窗位那块是空白。两件事补上——
 * ① 弹层几何对准窗位矩形(useDialogCover / dialogCoverStyle),弹层自己把那块空白盖上;
 * ② 让路期间槽体画一句「已让开」占位(useVeilActive / showVeilPlaceholder),弹层比窗位小时
 *   露出来的部分也说得清发生了什么。量不到窗位矩形(窗位收起/纯净模式/不在壳里)一切照旧。
 */
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { DockTab } from '../protocol.ts'
import type { RectLike } from './butlerGeometry.ts'

export interface VeilTarget {
  baseUrl: string
  fetchImpl?: typeof fetch
  /**
   * 窗位此刻在页面上的矩形(视口坐标,量的是 /slot/rect 上报用的那个槽体元素;Workbench 传入)。
   * 弹层盖住窗位(2026-09-14)靠它定位:量不到(窗位收起、纯净模式下 display:none 量出 0 矩形)
   * 就回 undefined,弹层照旧居中。事务官浮窗的相交判定用的是同一个来源。
   */
  slotRect?: () => RectLike | undefined
}

let chain: Promise<void> = Promise.resolve()

/* ── 让路计数(客户端视角,2026-09-14)──
   槽体要在让路期间画一句占位「窗位里的应用已让开」,得知道"此刻有没有弹层在让路"。
   服务端 /state.dock.veil 也有这个真相,但它是 1s 轮询,弹层一开一关之间占位会迟到/滞留;
   这里按 useVeilSlot 自己发过的 on/off 记一份内存计数,弹层开的那一拍占位就出现,关的那一拍
   就消失。只在真的发了 on 时才 +1(不在壳里没发,也就不算让路)。 */
let veilDepth = 0
const veilListeners = new Set<() => void>()
function bumpVeil(delta: 1 | -1): void {
  veilDepth += delta
  for (const listener of veilListeners) listener()
}
function subscribeVeil(listener: () => void): () => void {
  veilListeners.add(listener)
  return () => { veilListeners.delete(listener) }
}
function readVeilActive(): boolean { return veilDepth > 0 }

/** 此刻是否有弹层(或压到窗位上的事务官浮窗)让窗位让着路。 */
export function useVeilActive(): boolean {
  return useSyncExternalStore(subscribeVeil, readVeilActive, readVeilActive)
}

/** 测试用:当前让路计数。 */
export function veilDepthNow(): number { return veilDepth }

/**
 * 槽体要不要画「已让开」占位(纯函数):让路中**且**台前真有一扇窗——事务官在台/叠空时
 * veil 什么也没藏,写"应用已让开"就是编。
 */
export function showVeilPlaceholder(active: boolean, stack: readonly DockTab[] | undefined): boolean {
  return active && (stack?.some(tab => tab.current) ?? false)
}

/** 弹层盖住窗位时的几何(inline style 用,单位 px)。 */
export interface CoverStyle { left: number, top: number, width: number, height: number }

/**
 * 弹层几何 = 窗位矩形(纯函数,2026-09-14 Ben:「要不就是它刚好覆盖窗口槽,这样就看着不像是坏了」)。
 * 没矩形或零面积(display:none 量出来的)→ undefined,弹层照旧居中/原位。
 */
export function dialogCoverStyle(rect: RectLike | undefined, viewport?: { w: number, h: number }): CoverStyle | undefined {
  if (rect === undefined || rect.w <= 0 || rect.h <= 0) return undefined
  if (viewport === undefined || viewport.w <= 0 || viewport.h <= 0) return { left: rect.x, top: rect.y, width: rect.w, height: rect.h }
  /**
   * **只盖窗位露在屏幕里的那一块**(2026-09-25,卡 fix/evening-gaps 第 2 条)。窗位在的那一栏是能滚的
   * (`.ben-wb__body` overflow-y:auto),「第一眼」把球放大置顶之后,窗位的下沿可能落在视口外 ——
   * 弹层照原矩形铺,下半截就在屏幕外,内容滚到底也看不见最后那几节(09-24 晚统筹在真壳里找不到
   * 「手机与设备」,它当时正是最末一节)。露在屏幕里的那块太小就不盖,照旧贴右上角开(自带封顶高度与滚动)。
   */
  const left = Math.max(COVER_MARGIN, rect.x)
  const top = Math.max(COVER_MARGIN, rect.y)
  const right = Math.min(viewport.w - COVER_MARGIN, rect.x + rect.w)
  const bottom = Math.min(viewport.h - COVER_MARGIN, rect.y + rect.h)
  if (right - left < COVER_MIN_W || bottom - top < COVER_MIN_H) return undefined
  return { left, top, width: right - left, height: bottom - top }
}

/** 弹层离视口边至少留多少(px)。 */
export const COVER_MARGIN = 8
/** 窗位露在屏幕里的那块小于这么大,就不盖了(盖上去也放不下几行字)。 */
export const COVER_MIN_W = 320
export const COVER_MIN_H = 240

/**
 * 弹层挂上 `.ben-wb__dlg-cover` + inline 几何,让它刚好盖在窗位那块区域上。
 *
 * 在渲染期直接量(不是 effect 里量完再 setState):弹层打开的第一帧就在窗位上,不闪一下居中。
 * 视口 resize 时重量一次。`active` 为假(日结弹层收着)不量;target 没给 slotRect(不在壳里)
 * 恒为 undefined。事务官浮窗不用这个——它不是弹层(它压到窗位上那条 veil 不动)。
 */
export function useDialogCover(target: VeilTarget | undefined, active = true): CoverStyle | undefined {
  const slotRect = target?.slotRect
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (!active || slotRect === undefined) return
    const remeasure = (): void => setTick(value => value + 1)
    window.addEventListener('resize', remeasure)
    return () => window.removeEventListener('resize', remeasure)
  }, [active, slotRect])
  // tick 只是"再量一次"的触发器,值本身不参与计算。
  return useMemo(() => (active && slotRect !== undefined ? dialogCoverStyle(slotRect(), viewportSize()) : undefined), [active, slotRect, tick])
}

/** 此刻视口多大;拿不到(非浏览器)就 undefined —— 那时照原矩形铺。 */
function viewportSize(): { w: number, h: number } | undefined {
  if (typeof window === 'undefined') return undefined
  const w = window.innerWidth
  const h = window.innerHeight
  return Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0 ? { w, h } : undefined
}

/** 弹层根元素的 className:盖住窗位时多一个 ben-wb__dlg-cover。 */
export function coverClass(base: string, cover: CoverStyle | undefined): string {
  return cover === undefined ? base : `${base} ben-wb__dlg-cover`
}

/** 串行发一条 veil 开关。返回的 promise 永不 reject。 */
export function postVeil(target: VeilTarget, on: boolean, keepalive = false): Promise<void> {
  const fetchImpl = target.fetchImpl ?? fetch
  const send = async (): Promise<void> => {
    try {
      await fetchImpl(`${target.baseUrl}/dock/veil`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ on }),
        ...(keepalive ? { keepalive: true } : {}),
      })
    }
    catch {
      // 静默:让路失败不该卡住弹层;真相以服务端下一拍快照为准。
    }
  }
  chain = chain.then(send)
  return chain
}

export function useVeilSlot(open: boolean, target: VeilTarget | undefined): void {
  const baseUrl = target?.baseUrl
  const fetchImpl = target?.fetchImpl
  useEffect(() => {
    if (!open || baseUrl === undefined) return
    const t: VeilTarget = { baseUrl, ...(fetchImpl === undefined ? {} : { fetchImpl }) }
    void postVeil(t, true)
    bumpVeil(1)
    let sent = false
    const off = (): void => {
      if (sent) return // pagehide 与卸载可能都来,只发一次
      sent = true
      bumpVeil(-1)
      void postVeil(t, false, true)
    }
    window.addEventListener('pagehide', off)
    return () => {
      window.removeEventListener('pagehide', off)
      off()
    }
  }, [open, baseUrl, fetchImpl])
}
