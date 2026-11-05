/**
 * 画布第一眼看哪(2026-10-28):对准当前目标那一块,从它的顶上开始;按宽度缩到放得下,但不小于读得清的下限,
 * 也不放大过 1。高出区域的部分往下滚着看,不再把整板塞进一屏(150 张卡缩到看不清)或从中间裁掉顶上的卡。
 */
export const GOAL_VIEW_PAD = 16
/** 再小卡上的字就读不出了。 */
export const MIN_READABLE_ZOOM = 0.6

export interface Bounds { x: number, y: number, width: number, height: number }

export function goalViewport(goal: Bounds, area: { width: number, height: number }): { x: number, y: number, zoom: number } {
  const fit = (area.width - 2 * GOAL_VIEW_PAD) / Math.max(1, goal.width)
  const zoom = Math.min(1, Math.max(MIN_READABLE_ZOOM, fit))
  const shown = goal.width * zoom
  const left = shown <= area.width - 2 * GOAL_VIEW_PAD ? (area.width - shown) / 2 : GOAL_VIEW_PAD
  return { x: left - goal.x * zoom, y: GOAL_VIEW_PAD - goal.y * zoom, zoom }
}

/**
 * 阅读模式(窄窗 / 嵌在格子里)跟当前目标走:把那一节的头对到区域顶下 `GOAL_VIEW_PAD`。
 * 传入的是视口坐标(getBoundingClientRect)与区域现在的 scrollTop。
 */
export function readingScrollTop({ sectionTop, regionTop, scrollTop }: { sectionTop: number, regionTop: number, scrollTop: number }): number {
  return Math.max(0, scrollTop + sectionTop - regionTop - GOAL_VIEW_PAD)
}
