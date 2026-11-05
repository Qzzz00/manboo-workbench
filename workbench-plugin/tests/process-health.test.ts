// @vitest-environment node
/**
 * 插件进程自己的内存与事件循环(2026-10-19,卡「插件内存增长与 GC 抖动」)。
 *
 * 钉的是:数全是现取的、取不到就缺席;事件循环按窗采样(清零);日志每 10 分钟一行、第一拍就有基线;
 * `loopP99Ms()` 给探 8792 那条路的「我自己慢不慢」。
 */
import { describe, expect, it } from 'vitest'
import {
  createProcessHealth, LOOP_UNAVAILABLE, PROCESS_LOG_EVERY_MS, PROCESS_LOG_TAG, uptimeWords, type LoopHistogram,
} from '../src/server/processHealth.ts'

const MB = 1024 * 1024

/** 假直方图:纳秒计,`feed` 一批延迟进去。 */
function fakeHistogram(): LoopHistogram & { feed: (...delaysMs: number[]) => void, disabled: boolean } {
  let values: number[] = []
  return {
    get count() { return values.length },
    get max() { return values.length === 0 ? 0 : Math.max(...values) },
    percentile(p) {
      if (values.length === 0) return 511
      const sorted = [...values].sort((a, b) => a - b)
      return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p / 100))] as number
    },
    reset() { values = [] },
    disabled: false,
    disable() { this.disabled = true },
    feed(...delaysMs) { values.push(...delaysMs.map(one => one * 1e6)) },
  }
}

function harness(input: { histogram?: LoopHistogram | null, memory?: () => { rss: number, heapUsed: number, heapTotal: number, external: number } } = {}) {
  let now = Date.parse('2026-10-19T02:00:00.000Z')
  const lines: string[] = []
  const histogram = input.histogram === undefined ? fakeHistogram() : input.histogram
  const health = createProcessHealth({
    now: () => now,
    startedAt: now - 5 * 60_000,
    memoryUsage: input.memory ?? (() => ({ rss: 412.26 * MB, heapUsed: 180.04 * MB, heapTotal: 260 * MB, external: 12.5 * MB })),
    heapLimit: () => 4288 * MB,
    histogram,
    log: line => lines.push(line),
  })
  return { health, lines, histogram, advance: (ms: number) => { now += ms } }
}

describe('view · 数全是现取的', () => {
  it('rss / heap / 上限 / external 按 MB 一位小数;起了多久按注入的起点算', () => {
    const h = harness()
    const view = h.health.view()
    expect(view).toMatchObject({ rss_mb: 412.3, heap_used_mb: 180, heap_total_mb: 260, heap_limit_mb: 4288, external_mb: 12.5, up_sec: 300 })
    expect(view?.started_at).toBe('2026-10-19T01:55:00.000Z')
    expect(view?.sampled_at).toBe('2026-10-19T02:00:00.000Z')
  })

  it('还没攒出一个窗:事件循环那三格缺席,不填 0', () => {
    const h = harness()
    const view = h.health.view()
    expect(view).not.toHaveProperty('loop_p50_ms')
    expect(view).not.toHaveProperty('loop_p99_ms')
    expect(view).not.toHaveProperty('loop_max_ms')
  })

  it('memoryUsage 抛了:整格缺席', () => {
    const h = harness({ memory: () => { throw new Error('没了') } })
    expect(h.health.view()).toBeUndefined()
    expect(h.health.logLine()).toContain('取不到')
  })

  it('不量事件循环(histogram: null):那三格永远缺席,loopP99Ms 是 undefined', () => {
    const h = harness({ histogram: null })
    h.health.pump()
    expect(h.health.view()).not.toHaveProperty('loop_p99_ms')
    expect(h.health.loopP99Ms()).toBeUndefined()
    expect(h.lines[0]).toContain(`loop_p99=${LOOP_UNAVAILABLE}`)
  })
})

describe('事件循环按窗采样', () => {
  it('第一拍读窗并清零;view 给上一个完整窗的 p50 / p99 / max', () => {
    const h = harness()
    const histogram = h.histogram as ReturnType<typeof fakeHistogram>
    histogram.feed(10, 12, 11, 2100, 15)
    h.health.pump()
    expect(histogram.count).toBe(0)
    const view = h.health.view()
    expect(view?.loop_p50_ms).toBe(12)
    expect(view?.loop_p99_ms).toBe(2100)
    expect(view?.loop_max_ms).toBe(2100)
  })

  it('一分钟之内再 pump 不读窗(窗里攒着);满一分钟才换下一个窗', () => {
    const h = harness()
    const histogram = h.histogram as ReturnType<typeof fakeHistogram>
    histogram.feed(10)
    h.health.pump()
    histogram.feed(3000)
    h.advance(30_000)
    h.health.pump()
    expect(histogram.count).toBe(1)
    expect(h.health.view()?.loop_p99_ms).toBe(10)
    h.advance(30_000)
    h.health.pump()
    expect(histogram.count).toBe(0)
    expect(h.health.view()?.loop_p99_ms).toBe(3000)
  })

  it('loopP99Ms:当前还没清零的窗与上一个窗取大 —— 卡顿刚发生、窗还没满也答得出来', () => {
    const h = harness()
    const histogram = h.histogram as ReturnType<typeof fakeHistogram>
    histogram.feed(10)
    h.health.pump()
    expect(h.health.loopP99Ms()).toBe(10)
    histogram.feed(2600)
    expect(h.health.loopP99Ms()).toBe(2600)
  })
})

describe('日志', () => {
  it(`第一拍就记一行基线,之后每 ${PROCESS_LOG_EVERY_MS / 60_000} 分钟一行;行首是 ${PROCESS_LOG_TAG}`, () => {
    const h = harness()
    h.health.pump()
    expect(h.lines).toHaveLength(1)
    expect(h.lines[0]?.startsWith(PROCESS_LOG_TAG)).toBe(true)
    h.advance(PROCESS_LOG_EVERY_MS - 1000)
    h.health.pump()
    expect(h.lines).toHaveLength(1)
    h.advance(1000)
    h.health.pump()
    expect(h.lines).toHaveLength(2)
  })

  it('那一行里有 rss / heap(含上限)/ loop_p99 / 起了多久;10 分钟里最高的 p99 不被最近一分钟的平静盖掉', () => {
    const h = harness()
    const histogram = h.histogram as ReturnType<typeof fakeHistogram>
    histogram.feed(10)
    h.health.pump()
    expect(h.lines[0]).toBe(`${PROCESS_LOG_TAG} rss=412.3MB heap=180/260MB(上限 4288MB) external=12.5MB loop_p50=10ms loop_p99=10ms loop_max=10ms(10 分钟内最高 p99 10ms) 起了 5分`)
    // 第 3 分钟卡了 3 秒,之后几分钟都平静。
    h.advance(3 * 60_000)
    histogram.feed(3000)
    h.health.pump()
    h.advance(7 * 60_000)
    histogram.feed(8)
    h.health.pump()
    expect(h.lines).toHaveLength(2)
    expect(h.lines[1]).toContain('loop_p99=8ms')
    expect(h.lines[1]).toContain('10 分钟内最高 p99 3000ms')
    expect(h.lines[1]).toContain('起了 15分')
  })

  it('记日志的函数抛了不连累节拍', () => {
    let now = 0
    const health = createProcessHealth({
      now: () => now, startedAt: 0, histogram: null,
      memoryUsage: () => ({ rss: 1, heapUsed: 1, heapTotal: 1, external: 0 }), heapLimit: () => 1,
      log: () => { throw new Error('盘满了') },
    })
    expect(() => health.pump()).not.toThrow()
    now += PROCESS_LOG_EVERY_MS
    expect(() => health.pump()).not.toThrow()
  })

  it('close 关掉直方图', () => {
    const h = harness()
    h.health.close()
    expect((h.histogram as ReturnType<typeof fakeHistogram>).disabled).toBe(true)
  })
})

describe('uptimeWords', () => {
  it('4天20小时3分 / 20小时0分 / 7分', () => {
    expect(uptimeWords(4 * 86_400 + 20 * 3600 + 3 * 60 + 40)).toBe('4天20小时3分')
    expect(uptimeWords(20 * 3600)).toBe('20小时0分')
    expect(uptimeWords(7 * 60 + 59)).toBe('7分')
    expect(uptimeWords(0)).toBe('0分')
  })
})

describe('真的 monitorEventLoopDelay', () => {
  it('缺省接真直方图:忙等 120ms 之后 p99 ≥ 100ms', async () => {
    const health = createProcessHealth({ log: () => {} })
    try {
      await new Promise(resolve => setTimeout(resolve, 30))
      const end = Date.now() + 120
      while (Date.now() < end) { /* 堵住事件循环 */ }
      await new Promise(resolve => setTimeout(resolve, 30))
      const p99 = health.loopP99Ms()
      expect(p99).toBeDefined()
      expect(p99 as number).toBeGreaterThanOrEqual(100)
      const view = health.view()
      expect(view?.heap_limit_mb).toBeGreaterThan(0)
      expect(view?.rss_mb).toBeGreaterThan(0)
    }
    finally {
      health.close()
    }
  })
})
