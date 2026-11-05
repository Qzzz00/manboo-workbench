import { useLayoutEffect, useState, type RefObject } from 'react'

/**
 * 窗口槽空态让开悬浮窗(2026-10-27,合并稿 ②b 之后):事务官只剩浮窗,浮窗缺省展开停在右下角,
 * 会压住窗口槽右侧一块。原生应用窗由 `useVeilSlot` 让开;网页里这块空态自己量浮窗,
 * 把被压住的那一侧留成内边距,让那句话和按键落在露出来的那一块里。只读位置,不改浮窗。
 */
export interface FloatInset { left: number, right: number }
const NONE: FloatInset = { left: 0, right: 0 }

export function floatInset(box: { left: number, right: number, top: number, bottom: number }, float: { left: number, right: number, top: number, bottom: number } | undefined): FloatInset {
  if (float === undefined) return NONE
  const overlapX = Math.min(box.right, float.right) - Math.max(box.left, float.left)
  const overlapY = Math.min(box.bottom, float.bottom) - Math.max(box.top, float.top)
  if (overlapX <= 0 || overlapY <= 0) return NONE
  // 浮窗中线在空态中线右边 → 让出右侧;否则让出左侧。整块都盖住时不让(让了也没地方放)。
  if (overlapX >= box.right - box.left) return NONE
  const floatMid = (float.left + float.right) / 2, boxMid = (box.left + box.right) / 2
  return floatMid >= boxMid ? { left: 0, right: Math.round(overlapX) } : { left: Math.round(overlapX), right: 0 }
}

export function useAvoidFloat(ref: RefObject<HTMLElement>, active: boolean): FloatInset {
  const [inset, setInset] = useState<FloatInset>(NONE)
  useLayoutEffect(() => {
    if (!active) { setInset(NONE); return }
    const measure = (): void => {
      const el = ref.current
      if (el === null) return
      const aside = document.querySelector<HTMLElement>('.ben-wb__butler')
      // 收起成球(narrow)或纯净模式藏起来时不让。
      const float = aside === null || aside.hidden || aside.dataset.narrow === 'true' ? undefined : aside.getBoundingClientRect()
      const next = floatInset(el.getBoundingClientRect(), float)
      setInset(prev => (prev.left === next.left && prev.right === next.right ? prev : next))
    }
    measure()
    window.addEventListener('resize', measure)
    const aside = document.querySelector('.ben-wb__butler')
    const watch = typeof MutationObserver === 'undefined' || aside === null ? undefined : new MutationObserver(measure)
    watch?.observe(aside!, { attributes: true, attributeFilter: ['style', 'data-narrow', 'data-corner', 'hidden', 'class'] })
    const resize = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure)
    if (ref.current !== null) resize?.observe(ref.current)
    if (aside !== null) resize?.observe(aside)
    return () => { window.removeEventListener('resize', measure); watch?.disconnect(); resize?.disconnect() }
  }, [ref, active])
  return inset
}
