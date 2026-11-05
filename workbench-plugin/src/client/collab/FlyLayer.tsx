/**
 * 真实回执飞线(2026-10-27,合并稿 7.1):新到一条回执时,从交回那一家在成员那排的头像飞到那件事项的卡,只飞一次。
 * 两头有一头不在板上(成员那排收起、卡不在当前视图)就不飞,也不补播;系统设了「减少动态效果」就不飞。
 * 只画一颗点沿直线走,不挡点击;位置读当下的真实排版,不估。
 */
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from 'react'
import type { TaskView } from '../../protocol.ts'
import { receiptFlights } from './flyModel.ts'

const FLY_MS = 900

interface Shot { key: string, taskId: string, x0: number, y0: number, x1: number, y1: number }

function shown(el: Element | null | undefined): el is HTMLElement {
  return el instanceof HTMLElement && el.getClientRects().length > 0
}
function center(el: HTMLElement): { x: number, y: number } {
  const r = el.getBoundingClientRect()
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
}
function reducedMotion(): boolean {
  try { return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches } catch { return false }
}

export function FlyLayer({ tasks, root }: { tasks: readonly TaskView[], root: RefObject<HTMLElement> }) {
  const prev = useRef<readonly TaskView[] | undefined>(undefined)
  const seen = useRef(new Set<string>())
  const [shots, setShots] = useState<Shot[]>([])
  // 快照每秒一份,效果会跟着重跑:收掉飞线的定时器不能挂在效果的清理上,否则下一份快照一来就被取消。
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>())
  useEffect(() => () => { for (const timer of timers.current) clearTimeout(timer); timers.current.clear() }, [])
  useLayoutEffect(() => {
    const flights = receiptFlights(prev.current, tasks).filter(one => !seen.current.has(one.key))
    prev.current = tasks
    if (flights.length === 0) return
    for (const one of flights) seen.current.add(one.key)
    if (reducedMotion()) return
    const scope = root.current
    if (scope === null) return
    const next: Shot[] = []
    for (const one of flights) {
      const from = [...scope.querySelectorAll<HTMLElement>('[data-fly-from]')].find(el => el.dataset.flyFrom === one.from && shown(el))
      const to = [...scope.querySelectorAll<HTMLElement>('[data-note-id]')].find(el => el.dataset.noteId === one.taskId && shown(el))
      if (from === undefined || to === undefined) continue
      const a = center(from), b = center(to)
      next.push({ key: one.key, taskId: one.taskId, x0: a.x, y0: a.y, x1: b.x, y1: b.y })
    }
    if (next.length === 0) return
    setShots(list => [...list, ...next])
    const timer = setTimeout(() => {
      timers.current.delete(timer)
      setShots(list => list.filter(shot => !next.some(n => n.key === shot.key)))
    }, FLY_MS + 100)
    timers.current.add(timer)
  }, [tasks, root])
  if (shots.length === 0) return null
  return (
    <div className="ben-cl__fly-layer" aria-hidden="true">
      {shots.map(shot => (
        <span
          key={shot.key}
          className="ben-cl__fly"
          data-task={shot.taskId}
          style={{ '--fly-x0': `${shot.x0}px`, '--fly-y0': `${shot.y0}px`, '--fly-x1': `${shot.x1}px`, '--fly-y1': `${shot.y1}px`, '--fly-ms': `${FLY_MS}ms` } as CSSProperties}
        />
      ))}
    </div>
  )
}
