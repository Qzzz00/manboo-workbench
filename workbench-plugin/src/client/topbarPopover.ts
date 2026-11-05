/**
 * 顶栏上所有弹出物的**同一处**门道(2026-09-26,卡 TB2)。
 *
 * 维护者 19:30 的原话:「这两个明显重叠了…前面的是汇总,后面的是在线/在忙情况?这能整合的吧…
 * 悬浮上去还被挡住了…你真的功能做完都不验收的」。「被挡住」说的是:窗口槽里贴的是**真的原生窗**
 * (Claude 桌面端那一扇),它永远盖在 WKWebView 之上,网页里任何与窗位矩形重叠的浮层都被它压住。
 *
 * 所以顶栏这一条上的弹出物(点「N 家」出的登记表面板、悬停小灯出的那一张)统一做两件事:
 * 1. **让路**:开着的时候走 `useVeilSlot`(POST /dock/veil),让槽里那扇窗退下去,关掉就回来。
 *    TopBar 里只有**一处** `useVeilSlot(anyOpen, veil)`,不给每个浮层各写一套 —— 配对由那个 hook 管。
 * 2. **退路**:壳旧、让路没成、或者压根不在壳里时,浮层至少**挪到不与窗位重叠的位置**
 *    ({@link popoverShift})—— 这条不依赖壳有没有本事,是纯几何。
 *
 * 悬停那一张还多一条纪律:**悬停超过一小段时间才算"打开"**({@link TOPBAR_HOVER_OPEN_MS})。
 * 鼠标扫过顶栏时不该一路 veil / unveil 一串窗口,那会闪。移开之后也留一点回头的余地
 * ({@link TOPBAR_HOVER_CLOSE_MS}),好让鼠标走进浮层里点东西。
 */
import type { RectLike } from './butlerGeometry.ts'

/** 悬停多久才真的把那一张打开(并让窗位让路)。鼠标扫过不算。 */
export const TOPBAR_HOVER_OPEN_MS = 320
/** 鼠标移开之后等多久收起(给一点走进浮层的余地)。点开(pinned)的那一张不受这条管。 */
export const TOPBAR_HOVER_CLOSE_MS = 180

/** 浮层离视口边、离窗位至少留这么多(px)。 */
export const POPOVER_GAP = 8

/**
 * 浮层横向躲开窗位(纯函数)。
 *
 * 入参都是**视口坐标**:`anchor` 是浮层锚点(那颗键)的矩形,浮层默认从 `anchor.x + offset` 开始、
 * 宽 `width`;`slot` 是窗位此刻的矩形(量不到就 undefined)。返回的是**新的 left(视口坐标)**,
 * 不需要挪就回 undefined —— 调用方 undefined 就不加 inline style,一切照原样。
 *
 * 挪法:先试着整块摆到窗位左边(右沿贴在 `slot.x - POPOVER_GAP`),放不下再试窗位右边;
 * 两边都放不下(窗位铺满了整条视口宽)就不挪 —— 那种情况只剩 veil 能救,硬挪只会挪出屏幕。
 * 结果一律夹在视口里(左右各留 POPOVER_GAP)。
 */
export function popoverShift(
  anchor: RectLike | undefined,
  width: number,
  slot: RectLike | undefined,
  viewport: { w: number, h: number } | undefined,
  offset = 0,
): number | undefined {
  if (anchor === undefined || slot === undefined || width <= 0) return undefined
  if (slot.w <= 0 || slot.h <= 0) return undefined
  const left = anchor.x + offset
  const right = left + width
  // 竖向不相交(窗位整块在浮层下面很远)也算不上"被挡住"?—— 不能这么赌:浮层从顶栏往下垂,
  // 窗位就在它下面那一屏,真实情况几乎总是竖向相交。这里只看横向重叠,够用且不会漏判。
  if (right <= slot.x || left >= slot.x + slot.w) return undefined
  const maxRight = viewport === undefined ? undefined : viewport.w - POPOVER_GAP
  const toLeft = slot.x - POPOVER_GAP - width
  if (toLeft >= POPOVER_GAP) return toLeft
  const toRight = slot.x + slot.w + POPOVER_GAP
  if (maxRight === undefined || toRight + width <= maxRight) return toRight
  return undefined
}

/**
 * 悬停那一张**只夹回视口里,不躲窗位**(2026-09-26,卡 AC)。
 *
 * 维护者 21:40 对着截图:「悬停顶栏 Claude 那一格,浮层跑到屏幕最右边」。那正是
 * {@link popoverShift} 干的 —— 窗位横着占了屏幕中间一大片,躲不到左边就整块摆到窗位**右边**,
 * 于是那一张离被悬停的那一格十万八千里。点开的登记表面板挪一挪还说得通(它是一张要读完的表),
 * 悬停出来的那一张**必须贴在鼠标底下那一格**,不然他根本认不出它说的是哪一家。
 *
 * 所以悬停这一张的几何只做一件事:**锚在那一格正下方**,靠右装不下时往左收边(右沿贴视口内侧)。
 * 窗位那一半交给 `useVeilSlot`(槽里那扇真窗退下去)—— 让路失败的下限是"位置对、可能被压住",
 * 而不是"没被压住、但跑到了屏幕另一头"。
 *
 * 入参同 {@link popoverShift}:视口坐标的锚点矩形、浮层宽、视口。返回**新的 left(视口坐标)**,
 * 照原位就 undefined。
 */
export function popoverClamp(
  anchor: RectLike | undefined,
  width: number,
  viewport: { w: number, h: number } | undefined,
  offset = 0,
): number | undefined {
  if (anchor === undefined || viewport === undefined || width <= 0) return undefined
  // 量不到那一格(jsdom / 还没上屏):不挪,照样式里的原位。
  if (anchor.w <= 0 && anchor.h <= 0) return undefined
  const left = anchor.x + offset
  const maxLeft = viewport.w - POPOVER_GAP - width
  // 视口比浮层还窄:贴左边留 GAP,别把它推得更远。
  if (maxLeft <= POPOVER_GAP) return left === POPOVER_GAP ? undefined : POPOVER_GAP
  if (left > maxLeft) return maxLeft
  if (left < POPOVER_GAP) return POPOVER_GAP
  return undefined
}

/** 此刻视口多大;拿不到(非浏览器)就 undefined。 */
export function popoverViewport(): { w: number, h: number } | undefined {
  if (typeof window === 'undefined') return undefined
  const w = window.innerWidth
  const h = window.innerHeight
  return Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0 ? { w, h } : undefined
}
