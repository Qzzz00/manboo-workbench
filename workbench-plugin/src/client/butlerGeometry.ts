/**
 * 事务官浮窗的几何约束(W4)。纯函数,不碰 DOM——拖拽路径(Butler.tsx)与渲染路径
 * (读存档来的值)共用同一份 clamp,不写两遍。
 *
 * 不可改清单第 1 条:浮窗可拉伸、可拖动,但**不能小到、也不能远到让「全部暂停」
 * 离开可视区**。位置这一路必须把浮窗自身尺寸算进去——既有的 clampPct 只夹左上角的
 * 0–95%,1400px 宽的屏上拖到 95% 时 250px 宽的浮窗已经有 180px 出屏了。
 */
import { MIN_BUTLER_H_PX, MIN_BUTLER_W_PX } from '../protocol.ts'

export interface ButlerSize { w_px: number, h_px: number }
export interface ButlerPos { x_pct: number, y_pct: number }
export interface Viewport { w: number, h: number }

/** NaN/Infinity/负数一律按兜底值处理——绝不把 NaN 写进存档(存进去之后每次读都得再防一遍)。 */
function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback
}

/**
 * 尺寸:下限是硬约束(叫停入口要装得下),上限是视口(拉出屏幕就再也抓不着手柄)。
 * 视口比下限还小的极端情况下**下限优先**——宁可浮窗溢出一点,也不能把按钮挤没。
 */
export function clampButlerSize(size: ButlerSize, viewport: Viewport): ButlerSize {
  const w = finiteOr(size.w_px, MIN_BUTLER_W_PX)
  const h = finiteOr(size.h_px, MIN_BUTLER_H_PX)
  return {
    w_px: Math.max(MIN_BUTLER_W_PX, Math.min(w, Math.max(viewport.w, MIN_BUTLER_W_PX))),
    h_px: Math.max(MIN_BUTLER_H_PX, Math.min(h, Math.max(viewport.h, MIN_BUTLER_H_PX))),
  }
}

/**
 * 位置:保证整个浮窗留在视口内。浮窗比视口还大时贴左上角(0,0),不算出负值——
 * 负值会把浮窗顶到视口外面,连标题栏都抓不着。
 */
export function clampButlerPos(pos: ButlerPos, size: ButlerSize, viewport: Viewport): ButlerPos {
  const maxLeftPx = Math.max(0, viewport.w - size.w_px)
  const maxTopPx = Math.max(0, viewport.h - size.h_px)
  const leftPx = Math.min(Math.max(finiteOr(pos.x_pct, 0) * viewport.w / 100, 0), maxLeftPx)
  const topPx = Math.min(Math.max(finiteOr(pos.y_pct, 0) * viewport.h / 100, 0), maxTopPx)
  return {
    x_pct: viewport.w === 0 ? 0 : (leftPx / viewport.w) * 100,
    y_pct: viewport.h === 0 ? 0 : (topPx / viewport.h) * 100,
  }
}

export interface RectLike { x: number, y: number, w: number, h: number }

/**
 * 两个矩形是否有**重叠面积**(2026-09-11 弹层让开窗位):事务官浮窗常驻,只有它真的压在
 * 窗位上才让窗位让开。贴边不算(共享一条边没有面积),零面积矩形不算(jsdom 量不到、元素
 * 还没布局时 getBoundingClientRect 全是 0——那是"不知道",不是"在原点有个点")。
 */
export function rectsIntersect(a: RectLike, b: RectLike): boolean {
  if (a.w <= 0 || a.h <= 0 || b.w <= 0 || b.h <= 0) return false
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}
