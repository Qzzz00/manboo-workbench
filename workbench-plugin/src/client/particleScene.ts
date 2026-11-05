import type { Tuning } from './swarm/core.js'

export type FrameListener = (at: number, cost: number, drew: boolean) => void

export class ParticleLoop {
  private frame: number | undefined
  private last: number | undefined
  private lastDraw: number | undefined
  private budget = 0
  private disposed = false
  private active = false
  private reduced = false
  constructor(private draw: (dt: number, snap: boolean) => void, private request: (cb: FrameRequestCallback) => number = cb => window.requestAnimationFrame(cb), private cancel: (id: number) => void = id => window.cancelAnimationFrame(id), private onFrame?: FrameListener) {}
  /** Minimum milliseconds between draws; 0 draws on every animation frame. rAF keeps its native cadence, skipped ticks cost nothing. */
  setBudget(ms: number): void { this.budget = Math.max(0, ms) }
  private tick = (at: number): void => {
    this.frame = undefined
    if (this.disposed || !this.active || this.reduced) return
    const due = this.lastDraw === undefined || this.budget === 0 || at - this.lastDraw >= this.budget * .8
    let cost = 0
    if (due) {
      const dt = this.last === undefined ? 0 : Math.max(0, Math.min(.05, (at - this.last) / 1000))
      this.last = at; this.lastDraw = at
      const begin = typeof performance !== 'undefined' ? performance.now() : 0
      this.draw(dt, false)
      cost = typeof performance !== 'undefined' ? performance.now() - begin : 0
    }
    this.onFrame?.(at, cost, due)
    if (!this.disposed && this.active && !this.reduced) this.frame = this.request(this.tick)
  }
  update(active: boolean, reduced: boolean): void {
    if (this.disposed) return
    this.active = active; this.reduced = reduced
    if (!active || reduced) {
      if (this.frame !== undefined) this.cancel(this.frame)
      this.frame = undefined; this.last = undefined; this.lastDraw = undefined
      if (active) this.draw(0, true)
    } else if (this.frame === undefined) this.frame = this.request(this.tick)
  }
  dispose(): void {
    this.update(false, false)
    this.disposed = true
  }
}

/**
 * 球每秒画几帧(2026-09-25,卡 fix/evening-gaps 第 6 条:无风扇 MacBook Air,壳停在事务官页 GPU 71%)。
 *
 * 在真的 WKWebView 里量过(3600 颗):待命 30 帧 = 网页 19% · GPU 15%;执行中 60 帧 = 网页 43% · GPU 44%。
 * 开销几乎全在「每帧算 3600 颗 + 3600 次画」,跟帧数成正比 —— 所以降帧就是降开销,**画面一颗不少**
 * (动作按真实时间走,帧少只是没那么顺)。
 *   - 待命 20 帧(原 30):呼吸本来就慢;
 *   - 执行中 30 帧(原 60):莫比乌斯环转得不快,30 帧看不出卡;
 *   - 聆听 / 说话 / 电话 / 事项刚建下 / 调参预览 60:都是他正盯着、而且只有几秒的时候;
 *   - **歇着**(restMode.ts:切到别的 App、两分钟没动静)再降:待命 10、其余 15。页面藏起来时本来就整个停。
 */
export function orbFrameRate(mode: string, preview: boolean, resting: boolean): number {
  if (preview) return 60
  if (mode === 'idle') return resting ? 10 : 20
  if (mode === 'working') return resting ? 15 : 30
  return resting ? 15 : 60
}

/**
 * 交给粒子核心的那个「提示色」词(2026-09-25,维护者:「球是蓝的」)。核心的调色板里 `completed` 是蓝
 * (109,175,255),09-24 全局去蓝之后它是唯一还会染蓝的地方:「办完了、还没看」一多,整颗球就是蓝的。
 * 这里把它换成中性(白);琥珀(等你拍板)与红(出错)是语义色,照旧。核心一个字不改。
 */
export function coreNoticeOf(notice: string): string {
  return notice === 'completed' ? 'neutral' : notice
}

/** Includes ancestor display:none used by the persistent normal/pure workbench trees. */
export function particleHostVisible(host: HTMLElement): boolean {
  for (let node: HTMLElement | null = host; node; node = node.parentElement) {
    if (node.hidden || getComputedStyle(node).display === 'none' || getComputedStyle(node).visibility === 'hidden') return false
  }
  return true
}

/**
 * Quality tiers only change the values handed to the renderer; the user's 24 settings stay untouched.
 * 0 完整 · 1 粒子减半 · 2 +关柔光 · 3 +光团分辨率减半 · 4 粒子四分之一(性能模式锁在这档)
 */
export const QUALITY_FLOOR = 4
/**
 * **自动**降档最多降到哪一档(2026-09-25,维护者:「球体看起来确实因为内存小粒子变少了」)。
 * 机器被别的活压满时(统筹开着好几张卡跑测试),以前会一路降到第 4 档 —— 粒子只剩四分之一,稀得难看,
 * 而且那时掉帧多半不是球自己造成的,再减粒子也换不回帧率。自动最多到第 3 档(粒子减半、柔光关;
 * 光团早就全关了,第 3 档与第 2 档看上去一样);四分之一那一档只留给手动「性能模式」。
 */
export const AUTO_QUALITY_FLOOR = 3
const roundCount = (count: number, factor: number) => Math.max(500, Math.round(count * factor / 100) * 100)
export function applyQuality(settings: Tuning, tier: number): Tuning {
  const next: Tuning = { ...settings }
  const count = settings.count ?? 3600
  if (tier >= QUALITY_FLOOR) next.count = roundCount(count, .25)
  else if (tier >= 1) next.count = roundCount(count, .5)
  if (tier >= 2) next.particleGlow = 0
  return next
}
export function cloudScaleFor(tier: number): number { return tier >= 3 ? .5 : 1 }
export function describeQuality(settings: Tuning, tier: number, performanceMode: boolean): string {
  const effective = applyQuality(settings, tier)
  if (tier <= 0 && !performanceMode) return `完整(${effective.count} 颗)`
  const notes = [`${effective.count} 颗`]
  if (tier >= 2) notes.push('柔光关')
  if (tier >= 3) notes.push('光团减半')
  return performanceMode ? `性能模式:${notes.join(' · ')}` : `自动降到 ${notes.join(' · ')}`
}

interface GovernorOptions { window: number; slowMean: number; fastMean: number; longFrame: number; longFrames: number; recoverLongFrames: number; warmup: number; recover: number; floor: number }
/**
 * 掉帧就降档、流畅够久就升回(2026-09-18 Ben:「粒子突然就变得很稀疏,但是参数里面还是 4000」)。
 * 降:最近 2 秒的 rAF 间隔中位数 > slowMean(过半帧丢 vsync)或窜出 3 个长帧,每 2 秒最多降一档,**自动最多降到 {@link AUTO_QUALITY_FLOOR}**。
 * 升:中位数 ≤ fastMean、长帧不超过 `recoverLongFrames` 个,连续 recover(12 秒)就升一档,升完从头再攒。
 * 迟滞在两头:阈值 17.0 / 17.5 之间是死区(既不降也不升),时间 2 秒 / 12 秒不对称 —— 边界上的机器不会来回抖。
 *
 * 2026-09-25 改过两处(统筹转维护者:「降档要能在负载下去后自己升回来」):
 *  - 以前升档要**一个长帧都没有**连续 30 秒 —— 开发机上隔一会儿总有一帧 > 50ms(别的进程 GC、编译),
 *    流畅计时一再清零,降下去就再也升不回来,等于单向锁死。现在 2 秒窗口里偶尔一个长帧不算坏,12 秒升一档。
 *  - 降档下限见 {@link AUTO_QUALITY_FLOOR}。
 * fastMean 17.0 是给 60Hz(16.67ms)留的余量;60Hz 以下的屏(50Hz = 20ms)会降到下限且升不回来,和本轮之前一样。
 */
export class QualityGovernor {
  tier = 0
  private locked = false
  private last: number | undefined
  private since: number | undefined
  /** 这一段连续流畅是什么时候开始的;出现一次不够流畅的窗口就清零。 */
  private smooth: number | undefined
  private samples: { at: number; interval: number }[] = []
  private options: GovernorOptions
  constructor(options: Partial<GovernorOptions> = {}) {
    this.options = { window: 2000, slowMean: 17.5, fastMean: 17, longFrame: 50, longFrames: 3, recoverLongFrames: 1, warmup: 1000, recover: 12000, floor: AUTO_QUALITY_FLOOR, ...options }
  }
  /** Called on every animation frame with its timestamp. Returns the new tier when it stepped down or back up. */
  record(at: number): number | undefined {
    const previous = this.last
    this.last = at
    if (previous === undefined) { this.since = at + this.options.warmup; this.samples.length = 0; this.smooth = undefined; return undefined }
    if (this.locked || this.since === undefined || at < this.since) return undefined
    this.samples.push({ at, interval: at - previous })
    const start = at - this.options.window
    while (this.samples.length && this.samples[0]!.at < start) this.samples.shift()
    if (at - this.since < this.options.window) return undefined
    // Upper median: more than half of the last 2 s missed a vsync, or a burst of long frames. A short stutter passes.
    const sorted = this.samples.map(sample => sample.interval).sort((a, b) => a - b)
    const median = sorted[Math.floor(sorted.length / 2)] ?? 0
    const long = sorted.filter(interval => interval > this.options.longFrame).length
    if (median > this.options.slowMean || long >= this.options.longFrames) {
      this.smooth = undefined
      if (this.tier >= this.options.floor) return undefined
      this.tier += 1
      this.samples.length = 0; this.since = at
      return this.tier
    }
    // 死区(17.0–17.5,或窗口里长帧多于 recoverLongFrames 个):不降也不升,连流畅计时都不给,免得在边界上一升一降。
    if (median > this.options.fastMean || long > this.options.recoverLongFrames || this.tier <= 0) { this.smooth = undefined; return undefined }
    if (this.smooth === undefined) { this.smooth = at; return undefined }
    if (at - this.smooth < this.options.recover) return undefined
    this.tier -= 1
    this.samples.length = 0; this.since = at; this.smooth = undefined
    return this.tier
  }
  /** Frames after a pause are not consecutive: forget the previous timestamp, the smooth streak, and warm up again. */
  pause(): void { this.last = undefined; this.since = undefined; this.smooth = undefined; this.samples.length = 0 }
  reset(tier = 0): void { this.tier = tier; this.locked = false; this.pause() }
  lock(tier: number): void { this.tier = tier; this.locked = true; this.smooth = undefined; this.samples.length = 0 }
}

export interface FrameReport { frames: number; fps: number; intervalMean: number; intervalP95: number; longFrames: number; costMean: number; costP95: number }
/** `?profile=1` sampling: 700 ms warm-up, then 5 s windows of rAF intervals and callback cost. Not a GPU trace. */
export class FrameProfiler {
  private start: number | undefined
  private sampling = false
  private intervals: number[] = []
  private costs: number[] = []
  private last: number | undefined
  constructor(private report: (summary: FrameReport) => void, private warmup = 700, private window = 5000) {}
  record(at: number, cost: number): void {
    if (this.start === undefined) this.start = at
    if (!this.sampling) {
      if (at - this.start < this.warmup) return
      this.sampling = true; this.start = at; this.last = undefined; this.intervals = []; this.costs = []
    }
    if (this.last !== undefined) this.intervals.push(at - this.last)
    this.last = at; this.costs.push(cost)
    if (at - this.start >= this.window) { this.report(this.summary()); this.start = at; this.intervals = []; this.costs = [] }
  }
  summary(): FrameReport {
    const mean = (list: number[]) => list.length ? list.reduce((a, b) => a + b, 0) / list.length : 0
    const p95 = (list: number[]) => { const sorted = [...list].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * .95))] ?? 0 }
    const round = (n: number) => Math.round(n * 100) / 100
    return { frames: this.costs.length, fps: round(1000 / (mean(this.intervals) || Infinity)), intervalMean: round(mean(this.intervals)), intervalP95: round(p95(this.intervals)), longFrames: this.intervals.filter(x => x > 50).length, costMean: round(mean(this.costs)), costP95: round(p95(this.costs)) }
  }
}

/**
 * 场景(2026-09-23,维护者从零重装验收:「初始化不要有中间的光团……像个半成品」)。
 * 粒子球在不同地方露面时,有些调参要按场景压掉,而**不动用户那 24 项**(它们照旧存在 preset 里):
 * - `workbench`:看板上的球。
 * - `onboarding`:注册后的引导整屏。
 * 两个场景现在一样:**中心光团一律关**(`cloudSize = 0`,核心里「大小 · 0 为关闭」那一格),只剩粒子本身。
 * 返回新对象只在真有改动时;已经是 0 就返回同一个引用(ParticleOrb 按引用判断要不要重新 configure)。
 *
 * 2026-09-24 傍晚收掉了 `onboarding-busy`(「执行中」借待命形、把自转与漂移提上去那一档):维护者澄清 09-23 那次
 * 只是不要中间的光团,执行中恢复核心原版的 working 形(莫比乌斯环),见 ParticleOrb.tsx。
 */
export type ParticleSceneKind = 'workbench' | 'onboarding'
export function sceneSettings(settings: Tuning, _scene: ParticleSceneKind = 'workbench'): Tuning {
  /**
   * 2026-09-24 维护者验收清单「粒子球中心不要光团(电脑与手机所有页面)」:看板上的球也关。
   * 用户外观设置里那一格照旧存着,只是交给核心时压成 0。
   */
  if (settings.cloudSize !== 0) return { ...settings, cloudSize: 0 }
  return settings
}
