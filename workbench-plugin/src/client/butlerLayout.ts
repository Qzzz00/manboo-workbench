export interface TaskBox { x: number, y: number, w: number, h: number }
export interface OrbAnchor { x: number, y: number, r: number }

/**
 * 台上没有事时球多大(2026-09-25,维护者「最上面……要大」):占舞台高度的 40%、宽的三成,最大 210。
 * 台上有卡时照旧给卡让位置(卡片摆在四周,球小一圈)。
 */
export const EMPTY_ORB_MAX_R = 210

/**
 * 台上一张卡最高多少(2026-09-26,卡 ST)。维护者 09-26 19:10:「Grok Bot 的标题显示不全」——
 * 原来的 88 只装得下「一行小字 + 两行标题 + 一行(裁成一行的)进度」,对话名一长、最后一句一长就全看不见。
 * 现在一张卡要装:一行小字(logo + 名字 + 状态字)、**折两行的对话名**、**折两行的最后一句 / 那一问**,
 * 所以 124;台子矮的时候按能给多少给多少(见 {@link arrangeButlerTasks}),不硬撑到越界。
 */
export const CARD_MAX_H = 124

/** Stable positions within one page; selection and progress never affect geometry. */
export function arrangeButlerTasks(width: number, height: number, count: number) {
  const portrait = width < 760
  const r = count === 0
    ? Math.max(48, Math.min(portrait ? width * .34 : width * .3, height * .4, EMPTY_ORB_MAX_R))
    : portrait ? Math.min(110, width * .19, height * (count > 3 ? .18 : .24)) : Math.min(170, width * .15, height * .34)
  const orb = { x: width / 2, y: height * (count === 0 ? .5 : portrait ? count > 3 ? .49 : .33 : .5), r }
  const cards: TaskBox[] = []
  if (portrait) {
    const columns = Math.min(3, count), gap = 10, pad = 12
    const w = count === 1 ? Math.min(240, width - pad * 2) : (width - pad * 2 - (columns - 1) * gap) / columns
    const h = Math.max(width < 420 ? 104 : 92, Math.min(CARD_MAX_H, height / 4))
    for (let i = 0; i < count; i++) {
      const top = count > 3 && i < 3, col = i % 3
      const offset = (top ? [14, 0, 24] : [0, 18, -6])[col]!
      cards.push({ x: count === 1 ? (width - w) / 2 : pad + col * (w + gap), y: Math.max(0, Math.min(height - h - 8, (top ? 10 : count > 3 ? height - h - 24 : height * .62) + offset)), w, h })
    }
  } else {
    // 横屏左右各三行卡:能给多高就给多高(上限 CARD_MAX_H),矮台子上退回原来的 88。
    const w = Math.min(244, (width - r * 2 - 112) / 2), h = Math.max(88, Math.min(CARD_MAX_H, (height - 64) / 3))
    const slots = [
      { x: 24, y: 20 }, { x: width - w - 44, y: 38 },
      { x: 4, y: height * .49 - h / 2 }, { x: width - w - 8, y: height * .49 - h / 2 + 16 },
      { x: 42, y: height - h - 18 }, { x: width - w - 30, y: height - h - 4 },
    ]
    const order = count === 1 ? [2] : count === 2 ? [0, 3] : count === 3 ? [0, 3, 4] : count === 4 ? [0, 1, 4, 5] : count === 5 ? [0, 1, 2, 3, 4] : [0, 1, 2, 3, 4, 5]
    for (const index of order.slice(0, count)) cards.push({ ...slots[index]!, w, h })
  }
  return { portrait, orb, cards }
}

/** Nearest card edge → sphere edge; no side rail and no path through the card. */
export function butlerConnector(box: TaskBox, orb: OrbAnchor) {
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2
  const dx = orb.x - cx, dy = orb.y - cy, distance = Math.hypot(dx, dy) || 1
  const scale = Math.min(dx === 0 ? Infinity : box.w / 2 / Math.abs(dx), dy === 0 ? Infinity : box.h / 2 / Math.abs(dy))
  const start = { x: cx + dx * (Number.isFinite(scale) ? scale : 0), y: cy + dy * (Number.isFinite(scale) ? scale : 0) }
  const end = { x: orb.x - dx / distance * orb.r, y: orb.y - dy / distance * orb.r }
  const bend = { x: (start.x + end.x) / 2 - dy / distance * 6, y: (start.y + end.y) / 2 + dx / distance * 6 }
  return { start, end, path: `M ${start.x} ${start.y} Q ${bend.x} ${bend.y} ${end.x} ${end.y}` }
}
