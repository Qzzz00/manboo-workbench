/**
 * 插件进程自己的内存与事件循环(2026-10-19,卡「插件内存增长与 GC 抖动」)。
 *
 * ## 为什么要有这一格
 *
 * 10-19 10:2x 维护者本机真机:插件所在的 DSH 进程连续跑了 4 天 20 小时后,RSS 350~520MB 来回涨落,
 * `sample` 两秒里最热的帧全是 V8 的 ConcurrentMarking / MarkCompactCollector / Sweeper ——
 * 一直在做全量回收。于是 8791 上最便宜的路由(/channel/status)也要 3~5 秒,/state 12 秒不回;
 * 壳的窗位标签因此失灵,插件探 8792 的 /health 超时又误报「语音后端探不到了」12 次(8792 其实一直活着)。
 *
 * 09-30 的接缝设计(根子 4)早写过:「DSH 卡死(不是退出)没人发现」。这一版先做到**能看见**:
 *
 * 1. `/state.machine.process` 与诊断包概要里有这几个数(rss / heap / 堆上限 / 起了多久 / 事件循环 p50·p99);
 * 2. 插件日志每 10 分钟一行 `[内存] rss=… heap=… loop_p99=…ms`,排「从哪天开始慢的」有据可查;
 * 3. `loopP99Ms()` 给探 8792 的那条路用:**事件循环 p99 比探测超时还长时,超时是我自己慢,不算对方挂了**
 *    (`butler.ts` 的 `probe`、`http.ts` 的 `noteButlerHealth`)。
 *
 * ## 怎么量
 *
 * - 内存:`process.memoryUsage()`(rss / heapUsed / heapTotal / external)+ `v8.getHeapStatistics().heap_size_limit`。
 *   每次 `view()` 现取(都是 V8 现成的计数,微秒级)。
 * - 事件循环:`perf_hooks.monitorEventLoopDelay`(一个 10ms 的定时器,量它自己每次被延误多少)。
 *   **按窗采样**:每 {@link LOOP_SAMPLE_EVERY_MS} 把直方图读成 p50 / p99 / max 再清零,`view()` 给的是
 *   最近一个完整窗的数;不清零的话它是「自启动以来」的分位数,四天前的一次卡顿会把 p99 永远顶着。
 * - 全部**挂在 http 那根既有的 1 秒节拍上**(`pump()`),内部限频;不另起定时器(同哨兵 / 布局快照那条老规矩)。
 *
 * ## 边界
 *
 * - 取不到就缺席(D13):`memoryUsage` 抛了整格缺席;窗里一个样本都没有,事件循环那三格缺席,日志里写「取不到」。
 * - 不上 heap snapshot、不开 inspector、不碰 GC 开关:这一层只看,不干预。
 */
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { getHeapStatistics } from 'node:v8'
import type { ProcessHealthView } from '../protocol.ts'

/** 日志那一行多久记一次。10 分钟:一天 144 行,排「从几点开始涨」够用,又不刷屏。 */
export const PROCESS_LOG_EVERY_MS = 10 * 60_000

/** 事件循环直方图多久读一次并清零。 */
export const LOOP_SAMPLE_EVERY_MS = 60_000

/** 日志行的行首。用例与排障搜它。 */
export const PROCESS_LOG_TAG = '[内存]'

/** 事件循环那三格取不到时日志里写的字。 */
export const LOOP_UNAVAILABLE = '取不到'

/** `monitorEventLoopDelay` 回的那个直方图里用到的几样(单位纳秒)。用例注入假的。 */
export interface LoopHistogram {
  readonly count: number
  readonly max: number
  percentile: (p: number) => number
  reset: () => void
  disable?: () => void
}

export interface ProcessMemory {
  rss: number
  heapUsed: number
  heapTotal: number
  external: number
}

export interface ProcessHealthDeps {
  now?: () => number
  /** 进程起来的时刻(毫秒)。缺省按 `process.uptime()` 倒推。 */
  startedAt?: number
  memoryUsage?: () => ProcessMemory
  /** V8 堆上限(字节)。缺省 `getHeapStatistics().heap_size_limit`。 */
  heapLimit?: () => number
  /**
   * 事件循环直方图。缺省真的 `monitorEventLoopDelay`;`null` = 不量(那三格永远缺席);用例注入假的。
   */
  histogram?: LoopHistogram | null
  log?: (line: string) => void
  logEveryMs?: number
  sampleEveryMs?: number
}

export interface LoopSample {
  p50_ms: number
  p99_ms: number
  max_ms: number
  count: number
}

export interface ProcessHealth {
  /** 此刻的那一格。`memoryUsage` 抛了就 undefined(整格缺席)。 */
  view: () => ProcessHealthView | undefined
  /**
   * 最近的事件循环 p99(毫秒):当前还没清零的窗与上一个完整窗取大。
   * 一个样本都没有就 undefined —— 调用方(探 8792 那条路)那时按「不知道」处理,不按 0。
   */
  loopP99Ms: () => number | undefined
  /** 挂在 1 秒节拍上;内部按 {@link LOOP_SAMPLE_EVERY_MS} 采样、按 {@link PROCESS_LOG_EVERY_MS} 记日志。 */
  pump: () => void
  /** 此刻那一行日志的原文(`pump` 到点时记的就是它)。 */
  logLine: () => string
  close: () => void
}

function mb(bytes: number): number {
  return Math.round(bytes / 1024 / 1024 * 10) / 10
}

function ms(ns: number): number {
  return Math.round(ns / 1e6 * 10) / 10
}

/** `4天20小时3分` 这种人话。 */
export function uptimeWords(upSec: number): string {
  const total = Math.max(0, Math.floor(upSec))
  const days = Math.floor(total / 86_400)
  const hours = Math.floor((total % 86_400) / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const parts: string[] = []
  if (days > 0) parts.push(`${days}天`)
  if (days > 0 || hours > 0) parts.push(`${hours}小时`)
  parts.push(`${minutes}分`)
  return parts.join('')
}

function defaultHistogram(): LoopHistogram {
  const histogram = monitorEventLoopDelay({ resolution: 10 })
  histogram.enable()
  return histogram
}

export function createProcessHealth(deps: ProcessHealthDeps = {}): ProcessHealth {
  const now = deps.now ?? (() => Date.now())
  const startedAt = deps.startedAt ?? (now() - Math.round(process.uptime() * 1000))
  const memoryUsage = deps.memoryUsage ?? (() => process.memoryUsage())
  const heapLimit = deps.heapLimit ?? (() => getHeapStatistics().heap_size_limit)
  const histogram: LoopHistogram | undefined = deps.histogram === null ? undefined : (deps.histogram ?? defaultHistogram())
  const log = deps.log ?? ((line: string) => { console.log(line) })
  const logEveryMs = deps.logEveryMs ?? PROCESS_LOG_EVERY_MS
  const sampleEveryMs = deps.sampleEveryMs ?? LOOP_SAMPLE_EVERY_MS

  /** 上一个完整窗。还没攒出一个窗就 undefined。 */
  let lastSample: LoopSample | undefined
  /** 自上一行日志以来最高的 p99(那一行里带上它:10 分钟里的一次 3 秒卡顿不该被最近一分钟的平静盖掉)。 */
  let worstP99SinceLog: number | undefined
  let lastSampleAt: number | undefined
  let lastLogAt: number | undefined

  function readWindow(): LoopSample | undefined {
    if (histogram === undefined || histogram.count === 0) return undefined
    return {
      p50_ms: ms(histogram.percentile(50)),
      p99_ms: ms(histogram.percentile(99)),
      max_ms: ms(histogram.max),
      count: histogram.count,
    }
  }

  function sample(): void {
    const window = readWindow()
    histogram?.reset()
    if (window === undefined) return
    lastSample = window
    worstP99SinceLog = worstP99SinceLog === undefined ? window.p99_ms : Math.max(worstP99SinceLog, window.p99_ms)
  }

  function view(): ProcessHealthView | undefined {
    let memory: ProcessMemory
    let limit: number
    try {
      memory = memoryUsage()
      limit = heapLimit()
    }
    catch {
      return undefined
    }
    const at = now()
    return {
      rss_mb: mb(memory.rss),
      heap_used_mb: mb(memory.heapUsed),
      heap_total_mb: mb(memory.heapTotal),
      heap_limit_mb: mb(limit),
      external_mb: mb(memory.external),
      up_sec: Math.max(0, Math.floor((at - startedAt) / 1000)),
      started_at: new Date(startedAt).toISOString(),
      ...(lastSample === undefined
        ? {}
        : { loop_p50_ms: lastSample.p50_ms, loop_p99_ms: lastSample.p99_ms, loop_max_ms: lastSample.max_ms }),
      sampled_at: new Date(at).toISOString(),
    }
  }

  function loopP99Ms(): number | undefined {
    const live = readWindow()
    const candidates = [live?.p99_ms, lastSample?.p99_ms].filter((one): one is number => one !== undefined)
    return candidates.length === 0 ? undefined : Math.max(...candidates)
  }

  function logLine(): string {
    const current = view()
    if (current === undefined) return `${PROCESS_LOG_TAG} 取不到(process.memoryUsage 抛了)`
    const loop = current.loop_p99_ms === undefined
      ? `loop_p50=${LOOP_UNAVAILABLE} loop_p99=${LOOP_UNAVAILABLE}`
      : `loop_p50=${current.loop_p50_ms}ms loop_p99=${current.loop_p99_ms}ms loop_max=${current.loop_max_ms}ms`
    const worst = worstP99SinceLog === undefined ? '' : `(10 分钟内最高 p99 ${worstP99SinceLog}ms)`
    return `${PROCESS_LOG_TAG} rss=${current.rss_mb}MB heap=${current.heap_used_mb}/${current.heap_total_mb}MB(上限 ${current.heap_limit_mb}MB) external=${current.external_mb}MB ${loop}${worst} 起了 ${uptimeWords(current.up_sec)}`
  }

  return {
    view,
    loopP99Ms,
    logLine,
    pump() {
      const at = now()
      if (lastSampleAt === undefined || at - lastSampleAt >= sampleEveryMs) {
        lastSampleAt = at
        sample()
      }
      // 第一拍就记一行:它是之后每一行的基线(「起了 0 分 · rss=…」)。
      if (lastLogAt === undefined || at - lastLogAt >= logEveryMs) {
        lastLogAt = at
        try { log(logLine()) }
        catch { /* 记日志坏了不能连累节拍 */ }
        worstP99SinceLog = undefined
      }
    },
    close() {
      histogram?.disable?.()
    },
  }
}
