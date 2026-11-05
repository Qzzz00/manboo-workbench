/**
 * 串联:登录成功那一刻,黑洞里的粒子「飞出来」聚成事务官的粒子球(2026-09-23 维护者拍板,很期待的一下)。
 *
 * 分镜(总 2 秒,节拍在 blackhole.js HANDOFF_BEATS):
 *   0–0.6s   脱离 —— overlay 里那份黑洞淡出(光环一起暗),选中的 700 颗顺着各自的轨道切向甩出去;
 *   0.2–1.6s 飞行 —— 每颗走一条三次贝塞尔,从球外侧落到球面上她那颗粒子的位置(里圈先走,错开 0.5s);
 *   1.56–2s  成形 —— 粒子已贴在球面上跟着她转,飞行层淡出、真的球淡入(交叉淡化)。
 * 终点对齐:用的是她自己的核心(swarm/core.js 的 SwarmV4)、同一份外观设置(引导场景关光团)、
 * 待命态、与 SwarmRenderer.paint() 同一个投影 —— 飞到的就是那颗球该有粒子的地方。
 *
 * **不拦人**:overlay 是 pointer-events:none 的一层画布;登录屏照常卸载,新屏照常渲染、能点;
 * 飞行期间只是那颗球透明(CSS 变量 --brand-handoff-orb,见 style.ts)。
 * 「减少动效」开着:不飞粒子,黑洞 0.4s 淡出、球淡入,共 0.6s。画布都没有(jsdom / 老 WebView):什么都不做。
 *
 * **去卡顿(2026-09-24 维护者真机:「粒子从黑洞变成球的过程都是先卡住的」)**:点登录那一下原来同步做
 * 「造终点核心 + 预热 60 步 + 扫 20440 颗挑 700 颗 + 另造画家重画光环」,4 倍降速下 170ms 长任务,正好压在第一帧上。
 * 现在登录页一挂上就在空闲时间里备好(prepareBrandHandoff),点登录只剩挑 700 颗里的那几颗 + 拷一帧;
 * 飞几颗按这台机器上登录页黑洞的实际帧耗时降级(adaptiveHandoffCount)。
 *
 * **第五轮(2026-09-24 维护者 0.2.79 真机「还是卡」)**:起跑闸门(连着两帧顺了才计时,新屏挂载落在静帧上)、
 * 起步超标自动退成淡入淡出、每次记 3 秒帧间隔 / 长任务回报给 8791(见 blackhole.js「真机打点」)。
 */
import { adaptiveHandoffCount, handoffPlan, onHandoffPerf, orbTargets, prepareHandoff, runHandoff, type HandoffHandle, type HandoffPerf, type PreparedHandoff, type SwarmLike } from './blackhole.js'
import { SwarmV4 } from '../swarm/core.js'
import { sceneSettings } from '../particleScene.ts'
import { getParticleSettingsStore } from '../particleSettingsStore.ts'
import type { HeroHandle } from './BlackholeHero.tsx'

export type HandoffMode = 'none' | 'fade' | 'fly'

/** 这一次串联走哪条路。纯函数,好测。 */
export function handoffMode(env: { canvas: boolean; reduced: boolean }): HandoffMode {
  if (!env.canvas) return 'none'
  return env.reduced ? 'fade' : 'fly'
}

/** 新屏上那颗球:看得见的 `.ben-wb__particle-orb canvas` 里面积最大的那块(引导里那颗,或看板上那颗)。 */
export function findOrbCanvas(root: ParentNode = document): HTMLCanvasElement | null {
  let best: HTMLCanvasElement | null = null, area = 0
  root.querySelectorAll<HTMLCanvasElement>('.ben-wb__particle-orb canvas').forEach(canvas => {
    const rect = canvas.getBoundingClientRect(), size = rect.width * rect.height
    if (size > area) { best = canvas; area = size }
  })
  return best
}

/** 电脑上飞几颗(慢机器按登录页黑洞帧耗时降级,见 adaptiveHandoffCount)。 */
export const DESK_HANDOFF_COUNT = 700

function handoffSettings(): Record<string, number> {
  return sceneSettings(getParticleSettingsStore().effectiveSettings(), 'onboarding') as Record<string, number>
}

/**
 * 登录页挂上时调:空闲时间里预热终点核心、挑候选。返回取消函数(登录页卸载时调)。
 * 没有画布 / 减少动效(不飞粒子)就什么都不做。
 */
export function prepareBrandHandoff(hero: { readonly current: HeroHandle | null }): () => void {
  const reduced = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
  if (handoffMode({ canvas: canvasAvailable(), reduced }) !== 'fly') return () => {}
  try {
    const job = prepareHandoff({
      SwarmClass: SwarmV4 as unknown as new (count: number) => SwarmLike,
      settings: handoffSettings(),
      count: DESK_HANDOFF_COUNT,
      painter: () => hero.current?.painter ?? null,
      clock: () => hero.current?.clock() ?? 12,
    })
    prepared = job
    return () => { job.cancel(); if (prepared === job) prepared = null }
  } catch { return () => {} }
}
let prepared: PreparedHandoff | null = null

/** 终点颜色跟着新屏上那颗球(浅色主题是黑粒子);球挂上之前先按白的飞。找到球时取一次,不每帧 getComputedStyle。 */
export function orbInkOf(orb: HTMLCanvasElement | null): [number, number, number] {
  const rgb = orb ? (getComputedStyle(orb).color.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number) : []
  return rgb.length === 3 ? [rgb[0]!, rgb[1]!, rgb[2]!] : [255, 255, 255]
}

function canvasAvailable(): boolean {
  if (typeof CanvasRenderingContext2D === 'undefined' || typeof document === 'undefined') return false
  try { return document.createElement('canvas').getContext('2d') !== null } catch { return false }
}

/** 登录成功时调一次。返回句柄(测试 / 取消用),走不了就 null。**任何异常都吞掉**:动画坏了不能挡登录。 */
export function startBrandHandoff(hero: HeroHandle | null, options: { report?: (perf: HandoffPerf) => void } = {}): HandoffHandle | null {
  const reduced = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
  // 登录页黑洞一帧就画很久(真机 WebView 慢):一开始就不飞粒子,走淡入淡出(2026-09-24 第五轮)。
  const slow = handoffPlan(hero?.painter.paintMs ?? 0) === 'fade'
  const mode = handoffMode({ canvas: canvasAvailable(), reduced: reduced || slow })
  if (mode === 'none') return null
  // 这一次的 3 秒打点交给调用方回报(电脑:POST /perf/handoff 进 8791 日志)。只收这一次那一份。
  if (options.report) {
    const report = options.report
    const stop = onHandoffPerf(perf => { stop(); try { report(perf) } catch { /* 回报坏了不拦 */ } })
  }
  try {
    const ready = mode === 'fly' ? prepared : null
    const count = adaptiveHandoffCount(DESK_HANDOFF_COUNT, hero?.painter.paintMs ?? 0)
    const rect = hero?.canvas.getBoundingClientRect()
    return runHandoff({
      from: hero && rect ? { painter: hero.painter, rect, clock: hero.clock() } : null,
      findOrb: () => findOrbCanvas(),
      ...(mode === 'fly' ? { targets: ready?.targets() ?? orbTargets(SwarmV4 as unknown as new (count: number) => SwarmLike, handoffSettings(), DESK_HANDOFF_COUNT) } : {}),
      candidates: ready?.candidates() ?? null,
      surface: ready?.surface() ?? null,
      ink: orbInkOf,
      reduced: mode === 'fade',
      count,
      side: 'desk',
      gate: true,
    })
  } catch {
    document.documentElement.removeAttribute('data-brand-handoff')
    document.documentElement.style.removeProperty('--brand-handoff-orb')
    return null
  }
}

/** 把一次串联的打点送进 8791 日志(`POST /perf/handoff`,只有数字)。失败不吵:下一次真机再说。 */
export async function reportHandoffPerf(baseUrl: string, perf: HandoffPerf, doFetch: typeof fetch = fetch): Promise<void> {
  try {
    await doFetch(`${baseUrl}/perf/handoff`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(perf), credentials: 'include' })
  } catch { /* 不吵 */ }
}
