import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { ButtonHTMLAttributes } from 'react'

const HOVER_DELAY_MS = 360
const GAP = 8

/** 应用说明只在需要时出现；保持在侧栏范围内，避免落到原生窗口背后。 */
export function DockAppButton({ label, hint, children, onClick, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string
  hint?: string | undefined
}) {
  const buttonRef = useRef<HTMLButtonElement>(null)
  const hintRef = useRef<HTMLDivElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const pointerPressed = useRef(false)
  const [phase, setPhase] = useState<'closed' | 'waiting' | 'open'>('closed')
  const [position, setPosition] = useState({ left: 0, top: 0, maxWidth: 260 })
  const [side, setSide] = useState<'top' | 'bottom'>('top')
  const id = useId()

  const dismiss = useCallback(() => {
    clearTimeout(timer.current)
    timer.current = undefined
    setPhase('closed')
  }, [])

  const reveal = (): void => {
    clearTimeout(timer.current)
    timer.current = undefined
    const button = buttonRef.current
    if (!button || props.disabled) { setPhase('closed'); return }
    // 完整可见的普通名称没有额外信息，不重复弹出。
    if (!hint && button.scrollWidth <= button.clientWidth) { setPhase('closed'); return }
    const rail = button.closest('.ben-wb__land-rail')?.getBoundingClientRect()
    setPosition({ left: 0, top: 0, maxWidth: Math.max(1, Math.min(260, (rail?.width || window.innerWidth) - GAP * 2)) })
    setPhase('open')
  }

  useLayoutEffect(() => {
    if (phase !== 'open') return
    const button = buttonRef.current
    const bubble = hintRef.current
    if (!button || !bubble) return
    const anchor = button.getBoundingClientRect()
    const rail = button.closest('.ben-wb__land-rail')?.getBoundingClientRect()
    const rect = bubble.getBoundingClientRect()
    const minLeft = Math.max(GAP, (rail?.left ?? 0) + GAP)
    const maxRight = Math.min(window.innerWidth - GAP, rail?.width ? rail.right - GAP : window.innerWidth - GAP)
    const left = Math.max(minLeft, Math.min(anchor.left + (anchor.width - rect.width) / 2, maxRight - rect.width))
    const top = anchor.top - GAP - rect.height >= GAP
      ? anchor.top - GAP - rect.height
      : Math.max(GAP, Math.min(anchor.bottom + GAP, window.innerHeight - GAP - rect.height))
    const slot = button.closest('.ben-wb')?.querySelector('.ben-wb__slot-body')?.getBoundingClientRect()
    // 网页浮层盖不过真实 App 窗口；无安全位置时不弹，也不为提示隐藏原生窗。
    if (slot && slot.width > 0 && slot.height > 0 && left < slot.right && left + rect.width > slot.left
      && top < slot.bottom && top + rect.height > slot.top) {
      dismiss()
      return
    }
    setPosition(current => ({ ...current, left, top }))
    setSide(top < anchor.top ? 'top' : 'bottom')
  }, [phase, label, hint, dismiss])

  useEffect(() => {
    if (phase === 'closed') return
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') dismiss() }
    window.addEventListener('scroll', dismiss, true)
    window.addEventListener('resize', dismiss)
    window.addEventListener('blur', dismiss)
    document.addEventListener('keydown', onKey)
    document.addEventListener('visibilitychange', dismiss)
    return () => {
      window.removeEventListener('scroll', dismiss, true)
      window.removeEventListener('resize', dismiss)
      window.removeEventListener('blur', dismiss)
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('visibilitychange', dismiss)
    }
  }, [phase, dismiss])

  useEffect(() => () => clearTimeout(timer.current), [])

  return <>
    <button
      {...props}
      ref={buttonRef}
      type="button"
      className="ben-wb__dock-tab-name"
      aria-describedby={phase === 'open' ? id : undefined}
      onMouseEnter={() => {
        pointerPressed.current = false
        if (phase === 'open') return
        clearTimeout(timer.current)
        setPhase('waiting')
        timer.current = setTimeout(reveal, HOVER_DELAY_MS)
      }}
      onMouseLeave={() => { pointerPressed.current = false; dismiss() }}
      onPointerDown={() => { pointerPressed.current = true; dismiss() }}
      onFocus={() => { if (!pointerPressed.current) reveal() }}
      onBlur={dismiss}
      onClick={event => { dismiss(); onClick?.(event) }}
    >{children}</button>
    {phase === 'open' && <div ref={hintRef} id={id} role="tooltip" data-side={side} className="ben-wb__dock-app-hint" style={position}>
      <strong>{label}</strong>
      {hint && <p>{hint}</p>}
    </div>}
  </>
}
