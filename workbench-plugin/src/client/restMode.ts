/**
 * 「歇着」—— 没人看的时候少画(2026-09-25,卡 fix/evening-gaps 第 6 条:无风扇 MacBook Air 的耗电)。
 *
 * 统筹 09-24 22:3x 看到壳停在事务官页时 WebKit GPU 进程约 71%、网页进程约 45%。在真的 WKWebView 里量
 * (docs/交接-0925-今晚断点.md 第六节,一扇几乎透明、点不中的窗里开同一套组件):
 *   - 待命的球(3600 颗、30 帧):网页 19% · GPU 15%;
 *   - 执行中的莫比乌斯环(60 帧):网页 43% · GPU 44%;
 *   - **一张卡沿边走的光**(border-beam,绕圈):网页 13% · **GPU 69%** —— 模糊 + 遮罩 + 每帧重画;
 *   - 三样叠在一起(执行中 + 当前卡的光 + 待确认的呼吸光):网页 34% · GPU 78%。
 * 页面藏起来(窗口被盖住、最小化、锁屏)WebKit 自己会停 rAF;**窗口开着但没人在用**时什么都不降 —— 这正是那一幕。
 *
 * 所以这里判一件事:**这会儿有没有人在用这扇窗**。三种情况算「歇着」:
 *   1. 页面藏起来了(`document.hidden`);
 *   2. 窗口不在前台超过 {@link REST_BLUR_MS}(他切到别的 App 去了;刚切走那几秒不算,来回切不闪);
 *   3. 窗口在前台,但 {@link REST_IDLE_MS} 里没有一次鼠标 / 键盘 / 滚轮(人走开了,或者只是挂在那儿)。
 * 歇着时:球降帧(ParticleOrb 按 {@link useRestMode} 选帧预算),沿边光与连线上的流光**停在当前那一帧**
 * (`<html data-wb-rest="true">`,样式在 fx/fxStyle.ts)—— 光还在,只是不走;一动鼠标、一切回来,当场恢复。
 *
 * 有订阅者才监听:没有球、没有光的页面不挂任何监听。
 */
import { useSyncExternalStore } from 'react'

/** 窗口不在前台多久算歇着。 */
export const REST_BLUR_MS = 5_000
/** 窗口在前台、多久没动静算歇着。 */
export const REST_IDLE_MS = 120_000
/** `<html>` 上那一格:样式据此把装饰动画停在当前帧。 */
export const REST_ATTRIBUTE = 'data-wb-rest'

export interface RestSignals {
  hidden: boolean
  focused: boolean
  /** 最近一次输入(毫秒时钟)。 */
  lastInputAt: number
  /** 失去焦点那一刻;在前台时无意义。 */
  blurredAt: number
  now: number
}

/** 纯判断(好单测):此刻算不算歇着。 */
export function isResting(signals: RestSignals): boolean {
  if (signals.hidden) return true
  if (!signals.focused) return signals.now - signals.blurredAt >= REST_BLUR_MS
  return signals.now - signals.lastInputAt >= REST_IDLE_MS
}

/** 下一次该重新判一次的时刻(不在歇着时,到点就翻过去)。已经歇着就不用定时 —— 醒来靠事件。 */
export function nextRestCheck(signals: RestSignals): number | undefined {
  if (isResting(signals)) return undefined
  return signals.focused ? signals.lastInputAt + REST_IDLE_MS : signals.blurredAt + REST_BLUR_MS
}

const listeners = new Set<() => void>()
let resting = false
let signals: RestSignals | undefined
let timer: ReturnType<typeof setTimeout> | undefined
let detach: (() => void) | undefined
let clock: () => number = () => Date.now()

function apply(): void {
  if (signals === undefined) return
  signals.now = clock()
  const next = isResting(signals)
  if (timer !== undefined) { clearTimeout(timer); timer = undefined }
  const at = nextRestCheck(signals)
  if (at !== undefined) timer = setTimeout(apply, Math.max(50, at - signals.now + 20))
  if (next === resting) return
  resting = next
  try { document.documentElement.setAttribute(REST_ATTRIBUTE, String(resting)) } catch { /* 没有 DOM */ }
  for (const listener of [...listeners]) { try { listener() } catch { /* 一个订阅者抛了不影响别人 */ } }
}

function start(): void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return
  const now = clock()
  const focused = typeof document.hasFocus === 'function' ? document.hasFocus() : true
  signals = { hidden: document.hidden === true, focused, lastInputAt: now, blurredAt: now, now }
  resting = false
  let lastInputWrite = 0
  const onInput = (): void => {
    if (signals === undefined) return
    const at = clock()
    signals.lastInputAt = at
    // 鼠标一挪就是几十个事件:醒着的时候不必每个都重判,一秒一次够了;歇着的时候第一下就醒。
    if (!resting && at - lastInputWrite < 1000) return
    lastInputWrite = at
    apply()
  }
  const onFocus = (): void => { if (signals === undefined) return; signals.focused = true; signals.lastInputAt = clock(); apply() }
  const onBlur = (): void => { if (signals === undefined) return; signals.focused = false; signals.blurredAt = clock(); apply() }
  const onVisibility = (): void => {
    if (signals === undefined) return
    signals.hidden = document.hidden === true
    if (!signals.hidden) signals.lastInputAt = clock()
    apply()
  }
  const passive = { passive: true, capture: true } as const
  const inputs = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'] as const
  for (const name of inputs) window.addEventListener(name, onInput, passive)
  window.addEventListener('focus', onFocus)
  window.addEventListener('blur', onBlur)
  document.addEventListener('visibilitychange', onVisibility)
  detach = () => {
    for (const name of inputs) window.removeEventListener(name, onInput, passive)
    window.removeEventListener('focus', onFocus)
    window.removeEventListener('blur', onBlur)
    document.removeEventListener('visibilitychange', onVisibility)
  }
  try { document.documentElement.setAttribute(REST_ATTRIBUTE, 'false') } catch { /* 没有 DOM */ }
  apply()
}

function stop(): void {
  detach?.()
  detach = undefined
  if (timer !== undefined) { clearTimeout(timer); timer = undefined }
  signals = undefined
  resting = false
  try { document.documentElement.removeAttribute(REST_ATTRIBUTE) } catch { /* 没有 DOM */ }
}

export function subscribeRest(listener: () => void): () => void {
  if (listeners.size === 0) start()
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) stop()
  }
}

export function restingNow(): boolean {
  return resting
}

/** 这会儿算不算歇着。挂上它的组件在,监听就在。 */
export function useRestMode(): boolean {
  return useSyncExternalStore(subscribeRest, restingNow, () => false)
}

/** 测试用:换时钟、清状态。 */
export function resetRestModeForTests(now?: () => number): void {
  stop()
  listeners.clear()
  clock = now ?? (() => Date.now())
}
