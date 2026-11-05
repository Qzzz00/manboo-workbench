/**
 * 登录页顶上的粒子黑洞(2026-09-23 维护者拍板:主视觉用在登录页顶部背景,不压过表单可读性)。
 *
 * 画法是共用核心 `brand/blackhole.js`(参赛网页原型的逐行移植,三处逐字节相同)的 Canvas2D 版:
 * 透明底、每 3 颗画 1 颗、30 帧;深色主题相加混合发光,浅色主题用墨色(与粒子球在浅色下变黑同一口径)。
 * 「减少动效」开着:只画一帧静图。窗口藏起来就停。
 *
 * 串联(登录成功 → 粒子飞出来聚成事务官的球)要从这里取「此刻粒子在哪」:通过 handleRef 交出去,见 brandHandoff.ts。
 */
import { useEffect, useRef, type MutableRefObject } from 'react'
import { BlackholePainter, handoffLaunching } from './blackhole.js'

export interface HeroHandle {
  painter: BlackholePainter
  canvas: HTMLCanvasElement
  /** 现在画到第几秒(串联从这一刻接着画)。 */
  clock(): number
}

/** 待命 30 帧;提交中(busy)流速 ×2.2,借这一下表示「在办」。 */
export const HERO_FRAME_MS = 1000 / 30
export const HERO_BUSY_SPEED = 2.2
/** 一进来就从第 12 秒开始画:各层已经流开,不是从一条细线长出来。 */
export const HERO_START_CLOCK = 12

/** 版式:环半径占高 27%,圆心在 62% 高处;宽屏上环也不超过宽的 8%(原型比例)。 */
export function heroLayout(width: number, height: number): { radius: number; cx: number; cy: number } {
  return { radius: Math.max(8, Math.min(height * .27, width * .08)), cx: width / 2, cy: height * .62 }
}

/** 从 CSS color 判深浅:亮字(深色主题)→ 白光相加;暗字(浅色主题)→ 墨色覆盖。 */
export function heroInk(color: string): { ink: [number, number, number]; additive: boolean } {
  const parts = (color.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number)
  if (parts.length < 3) return { ink: [255, 255, 255], additive: true }
  const scale = Math.max(...parts) > 1 ? 255 : 1
  const luma = (parts[0]! * .2126 + parts[1]! * .7152 + parts[2]! * .0722) / scale
  return luma < .5 ? { ink: [24, 26, 30], additive: false } : { ink: [255, 255, 255], additive: true }
}

export function BlackholeHero({ busy = false, handleRef }: { busy?: boolean; handleRef?: MutableRefObject<HeroHandle | null> }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const busyRef = useRef(busy); busyRef.current = busy
  useEffect(() => {
    const canvas = canvasRef.current
    // jsdom / 很老的 WebView 没有 2D 画布:什么都不画,留一块空位,表单照常。
    if (!canvas || typeof CanvasRenderingContext2D === 'undefined') return
    let painter: BlackholePainter
    try { if (!canvas.getContext('2d')) return; painter = new BlackholePainter(canvas, { stride: 3 }) } catch { return }
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)')
    let clock = HERO_START_CLOCK, frame = 0, last: number | undefined, dead = false
    const fit = () => {
      // 卸载 / 串联途中 ResizeObserver 会报一次 0 尺寸:不重排、不重画光环(原来这里会按 600×200 兜底重算一遍,白占 10ms)。
      if (!canvas.isConnected || handoffLaunching()) return
      const rect = canvas.getBoundingClientRect()
      if (rect.width === 0 && rect.height === 0 && painter.view.width > 1) return
      const { ink, additive } = heroInk(getComputedStyle(canvas).color)
      painter.setInk(ink, additive); painter.bloom = additive
      painter.layout({ width: rect.width || 600, height: rect.height || 200, dpr: window.devicePixelRatio || 1, ...heroLayout(rect.width || 600, rect.height || 200) })
      painter.paint(clock)
    }
    const tick = (at: number) => {
      frame = 0
      // 串联开始了:这块画布已经被拷进飞行层、藏起来了(style.ts),别再每帧画它 —— 那段时间主线程要留给飞行和新屏。
      if (dead) return
      if (document.documentElement.dataset.brandHandoff !== undefined) { last = undefined; schedule(); return }
      if (last === undefined || at - last >= HERO_FRAME_MS * .8) {
        const dt = last === undefined ? 0 : Math.min(.1, (at - last) / 1000)
        last = at
        clock += dt * (busyRef.current ? HERO_BUSY_SPEED : 1)
        painter.paint(clock)
      }
      schedule()
    }
    const schedule = () => {
      if (dead || frame || document.hidden || reduced?.matches) return
      frame = requestAnimationFrame(tick)
    }
    const wake = () => { if (document.hidden || reduced?.matches) { if (frame) cancelAnimationFrame(frame); frame = 0; last = undefined; painter.paint(clock) } else schedule() }
    fit(); schedule()
    canvas.dataset.running = String(!reduced?.matches)
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(fit) : undefined
    observer?.observe(canvas)
    document.addEventListener('visibilitychange', wake)
    reduced?.addEventListener?.('change', wake)
    if (handleRef) handleRef.current = { painter, canvas, clock: () => clock }
    return () => {
      dead = true
      if (frame) cancelAnimationFrame(frame)
      observer?.disconnect()
      document.removeEventListener('visibilitychange', wake)
      reduced?.removeEventListener?.('change', wake)
      if (handleRef?.current?.canvas === canvas) handleRef.current = null
    }
  }, [handleRef])
  return (
    <div className="ben-wb__brand-hero" aria-hidden="true" data-busy={busy}>
      <canvas ref={canvasRef} />
    </div>
  )
}
