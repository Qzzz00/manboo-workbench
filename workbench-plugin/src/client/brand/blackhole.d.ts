// blackhole.js 的类型。与 blackhole.js 一起由 docs/brand/sync-blackhole.mjs 同步到两端,逐字节相同。
export interface Blackhole { count: number; data: Float32Array; path: Float64Array; coreStart: number; coreSpan: number; rate: number }
export interface PlacedParticle { x: number; y: number; alpha: number; size: number; lum: number; kind: number }
export interface BlackholeView { width: number; height: number; dpr: number; radius: number; cx: number; cy: number }
export interface SnapshotParticle { i: number; x: number; y: number; vx: number; vy: number; size: number; alpha: number; arch: number }
export interface HandoffFrame { phase: 'release' | 'fly' | 'settle' | 'fade' | 'done'; t: number; heroAlpha: number; overlayAlpha: number; orbAlpha: number; done: boolean }
export interface Point { x: number; y: number }
export interface OrbPoint extends Point { size: number; alpha: number }
export interface RectLike { left: number; top: number; width: number; height: number }
export interface OrbTargets { count: number; readonly warmed?: boolean; warm?(more?: () => boolean): boolean; step(dt: number): void; project(rect: RectLike): OrbPoint[]; center(rect: RectLike): Point }
export interface SwarmLike {
  count: number; positions: Float32Array | number[]; sizes: Float32Array | number[]; settings: Record<string, number>
  configure(settings: Record<string, number>): void; setMode(mode: string): void; step(dt: number, snap?: boolean): void
}

export const BH_BACKGROUND: [number, number, number]
export const RING_RADIUS: number
export const RING_SIGMA: number
export const CENTER_Y: number
export const HANDOFF_MS: number
export const HANDOFF_REDUCED_MS: number
export const HANDOFF_BEATS: Readonly<{ release: number; stagger: number; flight: number; settle: number }>
export const HANDOFF_DEFER_UNTIL: number
export const ORB_WARM_STEPS: number

export function smoothstep(a: number, b: number, v: number): number
export function createBlackhole(): Blackhole
export function placeParticle(bh: Blackhole, i: number, clock: number, out: PlacedParticle, grain?: number): boolean
export function ringLight(distance: number, y: number): number
export function pixelScale(radius: number): number
export function handoffFrame(elapsed: number, reduced?: boolean): HandoffFrame
export function flightProgress(t: number, k: number, n: number): number
export function pairByAngle(sources: Point[], sourceCenter: Point, targets: Point[], targetCenter: Point): number[]
export function flightPoint(src: Point & { vx?: number; vy?: number }, dst: Point, dstCenter: Point, u: number): Point
export function orbTargets(SwarmClass: new (count: number) => SwarmLike, settings: Record<string, number>, n: number, options?: { lazy?: boolean }): OrbTargets & { readonly warmed: boolean; warm(more?: () => boolean): boolean }
export function adaptiveHandoffCount(base: number, paintMs: number): number
export function handoffLaunching(): boolean
export function afterHandoffLaunch(cb: () => void): () => void
export function candidateJob(painter: BlackholePainter, clock: number, n: number): Generator<void, number[], void>
export interface HandoffSurface { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D; W: number; H: number; dpr: number }
export interface HandoffSource { rect: RectLike; dpr: number; painter: BlackholePainter; sources: SnapshotParticle[] }
export interface PreparedHandoff { targets(): OrbTargets | null; candidates(): number[] | null; surface(): HandoffSurface | null; source(): HandoffSource | null; cancel(): void }
export function prepareHandoff(options: {
  SwarmClass: new (count: number) => SwarmLike; settings: Record<string, number>; count: number
  painter?: () => BlackholePainter | null; clock?: () => number; window?: Window; refreshMs?: number
  fallbackRect?: () => RectLike | null; fallbackStride?: number
}): PreparedHandoff

export interface PainterOptions { stride?: number; ink?: [number, number, number]; additive?: boolean; bloom?: boolean; grain?: number }
export interface PaintOptions { alpha?: number; ringAlpha?: number; skip?: (i: number) => boolean }
export class BlackholePainter {
  constructor(canvas: HTMLCanvasElement | OffscreenCanvas, options?: PainterOptions)
  readonly stride: number
  readonly canvas: HTMLCanvasElement | OffscreenCanvas
  /** 最近几帧 paint() 的耗时(毫秒,指数平均)。 */
  paintMs: number
  ink: [number, number, number]
  additive: boolean
  bloom: boolean
  view: BlackholeView
  layout(view: { width: number; height: number; dpr?: number; radius?: number; cx?: number; cy?: number }): BlackholeView
  setInk(ink: [number, number, number], additive: boolean): void
  paint(clock: number, options?: PaintOptions): void
  snapshot(clock: number, n: number, candidates?: readonly number[]): SnapshotParticle[]
}

export interface HandoffOptions {
  from?: { painter: BlackholePainter; rect: RectLike; clock: number } | null
  fallbackRect?: RectLike
  findOrb?: () => HTMLCanvasElement | null
  targets?: OrbTargets
  candidates?: readonly number[] | null
  surface?: HandoffSurface | null
  source?: HandoffSource | null
  stride?: number
  ink?: [number, number, number] | ((orb: HTMLCanvasElement | null) => [number, number, number])
  reduced?: boolean
  count?: number
  document?: Document
  /** 打点里记哪一端('desk' / 'phone')。 */
  side?: string
  /** 起跑闸门:连着两帧顺了才开始计时;等满 GATE_MAX_MS 还没顺就降级。缺省关(用例按帧数算时间)。 */
  gate?: boolean
  /** 记不记 3 秒打点。缺省记。 */
  probe?: boolean
}
export interface HandoffPerf {
  v: 1; at: string; side: string
  /** fly = 飞粒子;fade = 一开始就走淡入淡出(减少动效 / 登录页黑洞太慢);degraded = 起步超标中途退成淡入淡出。 */
  mode: 'fly' | 'fade' | 'degraded'
  count: number; paintMs: number; syncMs: number; gateMs: number; firstFrameMs: number | null
  degraded: boolean; degradeReason: '' | 'first-frame' | 'gate-timeout' | 'slow-frame' | string
  frames: number; maxGapMs: number; p95GapMs: number; medianGapMs: number; over50: number; over100: number
  /** 浏览器不支持 longtask(Safari / WKWebView)时是 null。 */
  longtasks: number | null; longtaskMaxMs: number | null; longtaskTotalMs: number | null
  viewport: string
}
export interface HandoffHandle { cancel(): void; done: Promise<void>; canvas: HTMLCanvasElement; perf: Partial<HandoffPerf> }
export const PERF_WINDOW_MS: number
export const GATE_SMOOTH_FRAMES: number
export const GATE_SMOOTH_MS: number
export const GATE_MAX_MS: number
export const DEGRADE_GAP_MS: number
export const SLOW_PAINT_MS: number
export function handoffPlan(paintMs: number): 'fly' | 'fade'
export function summarizeFrames(gaps: readonly number[]): { frames: number; maxGapMs: number; p95GapMs: number; medianGapMs: number; over50: number; over100: number }
export function lastHandoffPerf(): HandoffPerf | null
export function onHandoffPerf(cb: (report: HandoffPerf) => void): () => void
export function runHandoff(options: HandoffOptions): HandoffHandle
