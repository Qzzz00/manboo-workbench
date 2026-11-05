import { useEffect, useLayoutEffect, useRef } from 'react'
import type { RefObject } from 'react'
import type { WorkbenchLayout } from '../protocol.ts'
import type { Orientation } from './orientation.ts'
import { FIXED_MODULES, LANDSCAPE_MOVABLE_IDS, moveModule, reorderWidget } from './layout.ts'
import type { WidgetDrop } from './layout.ts'

type Placement = WidgetDrop & { rect: DOMRect; full?: boolean }
interface Drag {
  root: HTMLElement
  header: HTMLElement
  element: HTMLElement
  id: string
  orientation: Orientation
  pointerId: number
  startX: number
  startY: number
  x: number
  y: number
  active: boolean
  ghost?: HTMLElement
  guide?: HTMLElement
}
const interactive = 'button,a,input,textarea,select,summary,[contenteditable],[role=button],[role=separator]'
const movable = (id: string, orientation: Orientation) => orientation === 'landscape'
  ? LANDSCAPE_MOVABLE_IDS.includes(id) : !(FIXED_MODULES as readonly string[]).includes(id)
const within = (rect: DOMRect, x: number, y: number) => x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom
const boxesOf = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>('[data-module-box]')]

function placement(drag: Drag): Placement | null {
  const { root, x, y, id, orientation } = drag
  const body = root.getBoundingClientRect()
  if (!within(body, x, y)) return null
  const boxes = boxesOf(root)
  if (orientation !== 'landscape') {
    const target = boxes.find(element => element.dataset.moduleBox !== id && within(element.getBoundingClientRect(), x, y))
    return target ? { id: target.dataset.moduleBox!, rect: target.getBoundingClientRect(), full: true } : null
  }
  let region: 'side' | 'deck' | undefined
  let regionRect: DOMRect | undefined
  for (const name of ['side', 'deck'] as const) {
    const rect = root.querySelector(`[data-land-region=${name}]`)?.getBoundingClientRect()
    if (rect && within(rect, x, y)) { region = name; regionRect = rect; break }
  }
  // Empty regions still have a reachable destination along the layout edge.
  if (!region && !root.querySelector('[data-land-region=deck]') && y > body.bottom - Math.max(56, body.height * .14)) {
    region = 'deck'; regionRect = new DOMRect(body.left, body.bottom - 48, body.width, 48)
  }
  if (!region && !root.querySelector('[data-land-region=side]') && x > body.right - Math.max(80, body.width * .2)) {
    region = 'side'; regionRect = new DOMRect(body.right - 80, body.top, 80, body.height * .7)
  }
  if (!region || !regionRect) return null
  const list = boxes.filter(element => element.closest(`[data-land-region=${region}]`))
  if (list.find(element => within(element.getBoundingClientRect(), x, y))?.dataset.moduleBox === id) return null
  const targets = list.filter(element => element.dataset.moduleBox !== id)
  if (!targets.length) return { region, id: null, rect: regionRect, full: true }
  const horizontal = region === 'deck'
  const coordinate = horizontal ? x : y
  let target = targets.find(element => {
    const rect = element.getBoundingClientRect()
    return coordinate < (horizontal ? rect.left + rect.width / 2 : rect.top + rect.height / 2)
  })
  let after = !target
  target ??= targets[targets.length - 1]!
  if (region === 'side' && target.dataset.moduleBox === 'projects') after = true
  return { region, id: target.dataset.moduleBox!, after, rect: target.getBoundingClientRect() }
}

/** Preview geometry stays outside React; the existing layout save path runs once on drop. */
export function useWidgetReorder(
  bodyRef: RefObject<HTMLDivElement | null>, layout: WorkbenchLayout, orientation: Orientation,
  applyLayout: (next: WorkbenchLayout) => void,
): void {
  const latest = useRef({ layout, orientation, applyLayout })
  latest.current = { layout, orientation, applyLayout }
  const controller = useRef<{ cancel: () => void } | null>(null)
  const animationRects = useRef<Map<string, DOMRect> | null>(null)
  const restoreFocus = useRef<string | null>(null)
  useLayoutEffect(() => {
    if (restoreFocus.current) {
      const id = restoreFocus.current
      restoreFocus.current = null
      if (bodyRef.current) boxesOf(bodyRef.current).find(element => element.dataset.moduleBox === id)
        ?.querySelector<HTMLElement>('.ben-wb__modhead')?.focus({ preventScroll: true })
    }
    const before = animationRects.current
    animationRects.current = null
    if (!before || !bodyRef.current || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
    for (const element of boxesOf(bodyRef.current)) {
      // Transforms would send temporary rectangles to native window pinning.
      if (['slot', 'files'].includes(element.dataset.moduleBox!)) continue
      const old = before.get(element.dataset.moduleBox!)
      const next = element.getBoundingClientRect()
      if (!old || !next.width || !next.height) continue
      element.animate?.([
        { transform: `translate(${old.left - next.left}px, ${old.top - next.top}px) scale(${old.width / next.width}, ${old.height / next.height})`, transformOrigin: '0 0' },
        { transform: 'none', transformOrigin: '0 0' },
      ], { duration: 200, easing: 'cubic-bezier(.2,.8,.2,1)' })
    }
  }, [layout, bodyRef])
  useEffect(() => {
    let drag: Drag | null = null
    let frame = 0
    let suppressClick = false
    let clickTimer: ReturnType<typeof setTimeout> | undefined
    const cleanup = () => {
      if (!drag) return
      cancelAnimationFrame(frame); frame = 0
      const old = drag; drag = null
      old.ghost?.remove(); old.guide?.remove()
      old.element.removeAttribute('data-reordering')
      old.root.removeAttribute('data-widget-reordering')
      try { old.header.releasePointerCapture?.(old.pointerId) } catch { /* capture can already be lost */ }
    }
    controller.current = { cancel: cleanup }
    const paint = () => {
      frame = 0
      if (!drag?.active || !drag.ghost || !drag.guide) return
      const { ghost, guide, x, y, startX, startY } = drag
      ghost.style.transform = `translate3d(${x - startX}px, ${y - startY}px, 0)`
      const drop = placement(drag)
      guide.hidden = !drop
      if (!drop) return
      const r = drop.rect
      const horizontal = drop.region === 'deck'
      const rect = drop.full ? r : horizontal
        ? new DOMRect((drop.after ? r.right : r.left) - 2, r.top, 4, r.height)
        : new DOMRect(r.left, (drop.after ? r.bottom : r.top) - 2, r.width, 4)
      Object.assign(guide.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` })
      guide.dataset.full = String(drop.full === true)
    }
    const down = (event: PointerEvent) => {
      if (drag || event.button !== 0 || event.isPrimary === false || !(event.target instanceof Element)) return
      const root = bodyRef.current
      const header = event.target.closest<HTMLElement>('.ben-wb__modhead[data-widget-draggable=true]')
      if (!root || !header || !root.contains(header) || event.target.closest(interactive)) return
      const element = header.closest<HTMLElement>('[data-module-box]')
      const id = element?.dataset.moduleBox
      if (!element || !id || !movable(id, latest.current.orientation)) return
      drag = { root, header, element, id, orientation: latest.current.orientation, pointerId: event.pointerId,
        startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY, active: false }
      try { header.setPointerCapture?.(event.pointerId) } catch { /* pointer can have ended */ }
    }
    const move = (event: PointerEvent) => {
      if (!drag || event.pointerId !== drag.pointerId) return
      if (latest.current.orientation !== drag.orientation || !drag.element.isConnected) { cleanup(); return }
      drag.x = event.clientX; drag.y = event.clientY
      if (!drag.active) {
        if (Math.hypot(drag.x - drag.startX, drag.y - drag.startY) < 5) return
        drag.active = true
        const rect = drag.element.getBoundingClientRect()
        const ghost = document.createElement('div')
        ghost.className = 'ben-wb__widget-ghost'; ghost.setAttribute('aria-hidden', 'true'); ghost.inert = true
        const clone = drag.element.cloneNode(true) as HTMLElement
        for (const element of [clone, ...clone.querySelectorAll('[id]')]) element.removeAttribute('id')
        clone.style.cssText = 'width:100%;height:100%;min-height:0;flex:none'
        ghost.append(clone)
        Object.assign(ghost.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` })
        const guide = document.createElement('div')
        guide.className = 'ben-wb__widget-drop'; guide.setAttribute('aria-hidden', 'true'); guide.hidden = true
        drag.root.closest('.ben-wb')?.append(ghost, guide)
        drag.ghost = ghost; drag.guide = guide
        drag.element.setAttribute('data-reordering', 'true'); drag.root.setAttribute('data-widget-reordering', 'true')
      }
      event.preventDefault()
      if (!frame) frame = requestAnimationFrame(paint)
    }
    const up = (event: PointerEvent) => {
      if (!drag || event.pointerId !== drag.pointerId) return
      if (drag.active) {
        drag.x = event.clientX; drag.y = event.clientY
        const current = latest.current
        const next = current.orientation === drag.orientation
          ? reorderWidget(current.layout, current.orientation, drag.id, placement(drag)) : current.layout
        suppressClick = true
        clearTimeout(clickTimer)
        clickTimer = setTimeout(() => { suppressClick = false }, 0)
        if (next !== current.layout) {
          const rects = new Map(boxesOf(drag.root).map(element => [element.dataset.moduleBox!, element.getBoundingClientRect()]))
          if (drag.ghost) rects.set(drag.id, drag.ghost.getBoundingClientRect())
          animationRects.current = rects; restoreFocus.current = drag.id
          current.applyLayout(next)
        }
      }
      cleanup()
    }
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && drag) { event.preventDefault(); cleanup(); return }
      if (!event.altKey || !(event.target instanceof HTMLElement)) return
      const header = event.target.closest('.ben-wb__modhead[data-widget-draggable=true]')
      if (!header || event.target !== header || !bodyRef.current?.contains(header)) return
      const direction = ['ArrowUp', 'ArrowLeft'].includes(event.key) ? -1 : ['ArrowDown', 'ArrowRight'].includes(event.key) ? 1 : 0
      if (!direction) return
      event.preventDefault()
      const id = header.closest<HTMLElement>('[data-module-box]')?.dataset.moduleBox
      if (!id) return
      const current = latest.current
      const next = moveModule(current.layout, id, direction, current.orientation)
      if (next !== current.layout) { restoreFocus.current = id; current.applyLayout(next) }
    }
    const click = (event: MouseEvent) => { if (suppressClick) { event.preventDefault(); event.stopImmediatePropagation() } }
    const lost = (event: PointerEvent) => { if (drag?.pointerId === event.pointerId) cleanup() }
    const visibility = () => { if (document.hidden) cleanup() }
    document.addEventListener('pointerdown', down)
    document.addEventListener('pointermove', move, { passive: false })
    document.addEventListener('pointerup', up)
    document.addEventListener('pointercancel', lost)
    document.addEventListener('lostpointercapture', lost)
    document.addEventListener('keydown', key)
    document.addEventListener('click', click, true)
    document.addEventListener('visibilitychange', visibility)
    window.addEventListener('blur', cleanup)
    return () => {
      cleanup(); clearTimeout(clickTimer); controller.current = null
      document.removeEventListener('pointerdown', down)
      document.removeEventListener('pointermove', move)
      document.removeEventListener('pointerup', up)
      document.removeEventListener('pointercancel', lost)
      document.removeEventListener('lostpointercapture', lost)
      document.removeEventListener('keydown', key)
      document.removeEventListener('click', click, true)
      document.removeEventListener('visibilitychange', visibility)
      window.removeEventListener('blur', cleanup)
    }
  }, [bodyRef])
  useEffect(() => { controller.current?.cancel() }, [orientation])
}
