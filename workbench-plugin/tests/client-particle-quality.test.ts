import { expect, it, vi } from 'vitest'
import { AUTO_QUALITY_FLOOR, FrameProfiler, ParticleLoop, QUALITY_FLOOR, QualityGovernor, applyQuality, cloudScaleFor, describeQuality } from '../src/client/particleScene.ts'
import { TUNING_DEFAULTS } from '../src/client/swarm/core.js'

const feed = (governor: QualityGovernor, from: number, intervals: number[]) => {
  let at = from
  const steps: number[] = []
  for (const interval of intervals) { at += interval; const tier = governor.record(at); if (tier !== undefined) steps.push(tier) }
  return { at, steps }
}
const until = (governor: QualityGovernor, from: number, interval: number, limit = 6000) => {
  let at = from
  while (at - from < limit) { at += interval; const tier = governor.record(at); if (tier !== undefined) return { at, tier, elapsed: at - from } }
  return { at, tier: undefined, elapsed: at - from }
}
/** 一直喂同一个间隔,直到档位变化(升或降)为止。 */
const step = (governor: QualityGovernor, from: number, interval: number, limit = 60000) => {
  let at = from
  while (at - from < limit) { at += interval; const tier = governor.record(at); if (tier !== undefined) return { at, tier, elapsed: at - from } }
  return { at, tier: undefined, elapsed: at - from }
}
it('最近2秒rAF间隔中位数超过17.5ms才降一档;短抖动不降;降档后要再攒满2秒才评估下一档', () => {
  const governor = new QualityGovernor()
  governor.record(0)
  // 预热 1 秒内的长帧不算
  let { at } = feed(governor, 0, [200, 200, 200, 200])
  expect(governor.tier).toBe(0)
  ;({ at } = feed(governor, at, Array(120).fill(16.7)))
  expect(governor.tier).toBe(0)
  // 一次 60ms 抖动、随后 400ms 慢帧:都不到窗口一半,不降
  ;({ at } = feed(governor, at, [60, ...Array(120).fill(16.7), ...Array(16).fill(25), ...Array(120).fill(16.7)]))
  expect(governor.tier).toBe(0)
  // 持续 25ms 间隔(40fps):慢帧过半后降到 1 档,而且只降一档
  const first = until(governor, at, 25)
  expect(first.tier).toBe(1)
  expect(first.elapsed).toBeGreaterThan(900)
  expect(first.elapsed).toBeLessThan(2100)
  const settle = feed(governor, first.at, Array(60).fill(25))
  expect(settle.steps).toEqual([])
  const second = until(governor, settle.at, 25)
  expect(second.tier).toBe(2)
  expect(second.at - first.at).toBeGreaterThanOrEqual(2000)
  // 流畅不满 12 秒不升回(8 秒)
  const smooth = feed(governor, second.at, Array(600).fill(13.3))
  expect(smooth.steps).toEqual([])
  expect(governor.tier).toBe(2)
})
// 2026-09-25:升回从「连续 30 秒、一个长帧都不许有」改成「连续 12 秒、2 秒窗口里至多 1 个长帧」——
// 开发机上别的进程隔一会儿就让一帧 > 50ms,以前流畅计时一再清零,降下去就再也升不回来(维护者:「球体……粒子变少了」)。
it('降档后连续12秒流畅逐档升回,一次一档,直到回到用户参数;升回后再掉再降', () => {
  const governor = new QualityGovernor()
  governor.record(0)
  // 先卡到 2 档
  const first = until(governor, 0, 30)
  expect(first.tier).toBe(1)
  const second = until(governor, first.at, 30)
  expect(second.tier).toBe(2)
  // 12 秒流畅升一档(2 秒评估窗 + 12 秒计时,不超过 16 秒)
  const up = step(governor, second.at, 16.7)
  expect(up.tier).toBe(1)
  expect(up.elapsed).toBeGreaterThanOrEqual(12000)
  expect(up.elapsed).toBeLessThan(16000)
  // 只升一档,再想升还得再等 12 秒
  const settle = feed(governor, up.at, Array(600).fill(16.7))
  expect(settle.steps).toEqual([])
  const back = step(governor, settle.at, 16.7)
  expect(back.tier).toBe(0)
  // 回到用户参数后不会再往上
  const done = feed(governor, back.at, Array(4000).fill(16.7))
  expect(done.steps).toEqual([])
  expect(governor.tier).toBe(0)
  // 升回后再掉,照样降
  const down = step(governor, done.at, 30)
  expect(down.tier).toBe(1)
})
it('迟滞:间隔卡在降档线与升回线之间既不降也不升;偶尔一个长帧不清零,扎堆的长帧才重新计时', () => {
  const governor = new QualityGovernor()
  governor.record(0)
  const first = until(governor, 0, 30)
  expect(first.tier).toBe(1)
  // 17.2ms:没到 17.5 的降档线,也没回到 17.0 的升回线 —— 40 秒一动不动
  const idle = feed(governor, first.at, Array(2400).fill(17.2))
  expect(idle.steps).toEqual([])
  expect(governor.tier).toBe(1)
  // 每 8 秒来**两个**挨着的 60ms 长帧(2 秒窗口里 2 个):每次都把 12 秒重新计时,升不回去
  let cursor = idle.at
  for (let i = 0; i < 5; i++) cursor = feed(governor, cursor, [...Array(480).fill(16.7), 60, 16.7, 60, ...Array(20).fill(16.7)]).at
  expect(governor.tier).toBe(1)
  // 每 4 秒只来**一个**长帧:不算坏,照样攒满 12 秒升回
  const lone = feed(governor, cursor, Array(6).fill([...Array(240).fill(16.7), 60]).flat())
  expect(lone.steps).toEqual([0])
  expect(governor.tier).toBe(0)
})
it('暂停会把升回的计时清零:停帧前攒的流畅时间不算数', () => {
  const governor = new QualityGovernor()
  governor.record(0)
  const first = until(governor, 0, 30)
  expect(first.tier).toBe(1)
  const warm = feed(governor, first.at, Array(600).fill(16.7))
  expect(warm.steps).toEqual([])
  governor.pause()
  let at = warm.at + 5000
  governor.record(at)
  // 暂停前那 10 秒不算,还得重新攒满 12 秒
  const partial = feed(governor, at, Array(600).fill(16.7))
  expect(partial.steps).toEqual([])
  expect(governor.tier).toBe(1)
  expect(step(governor, partial.at, 16.7).tier).toBe(0)
})
it('2秒内3个>50ms长帧也降档;暂停后的间隔不计入;自动最多降到第 3 档(粒子减半),四分之一只留给性能模式', () => {
  const governor = new QualityGovernor()
  governor.record(0)
  let { at } = feed(governor, 0, Array(80).fill(16.7))
  // 暂停 3 秒后恢复:第一帧没有间隔,预热 1 秒
  governor.pause()
  at += 3000
  governor.record(at)
  expect(governor.tier).toBe(0)
  ;({ at } = feed(governor, at, Array(130).fill(16.7)))
  expect(governor.tier).toBe(0)
  const bursty = feed(governor, at, [...Array(10).fill(16.7), 55, ...Array(10).fill(16.7), 55, ...Array(10).fill(16.7), 55, ...Array(20).fill(16.7)])
  expect(bursty.steps).toEqual([1])
  let cursor = bursty.at
  for (let i = 0; i < 10; i++) cursor = feed(governor, cursor, Array(100).fill(30)).at
  expect(governor.tier).toBe(AUTO_QUALITY_FLOOR)
  expect(AUTO_QUALITY_FLOOR).toBeLessThan(QUALITY_FLOOR)
  expect(applyQuality({ ...TUNING_DEFAULTS, count: 3600 }, AUTO_QUALITY_FLOOR).count).toBe(1800)
})
it('性能模式锁定最低档:采样不再改变,解除后从完整档重新评估', () => {
  const governor = new QualityGovernor()
  governor.lock(QUALITY_FLOOR)
  governor.record(0)
  feed(governor, 0, Array(400).fill(30))
  expect(governor.tier).toBe(QUALITY_FLOOR)
  governor.reset(0)
  expect(governor.tier).toBe(0)
  governor.record(0)
  expect(until(governor, 0, 30).tier).toBe(1)
})
it('降档只作用于有效值:粒子减半/四分之一(百位取整、不低于500)、二档起关柔光;用户的24项原样不动', () => {
  const user = { ...TUNING_DEFAULTS, count: 6800, particleGlow: .45 }
  const frozen = JSON.stringify(user)
  expect(applyQuality(user, 0)).toEqual(user)
  expect(applyQuality(user, 0)).not.toBe(user)
  expect(applyQuality(user, 1)).toMatchObject({ count: 3400, particleGlow: .45 })
  expect(applyQuality(user, 2)).toMatchObject({ count: 3400, particleGlow: 0 })
  expect(applyQuality(user, 3)).toMatchObject({ count: 3400, particleGlow: 0 })
  expect(applyQuality(user, QUALITY_FLOOR)).toMatchObject({ count: 1700, particleGlow: 0 })
  expect(applyQuality({ ...user, count: 1100 }, QUALITY_FLOOR).count).toBe(500)
  expect(applyQuality({ ...user, count: 3700 }, 1).count).toBe(1900)
  expect(Object.keys(applyQuality(user, 2))).toEqual(Object.keys(user))
  expect(JSON.stringify(user)).toBe(frozen)
  expect(cloudScaleFor(2)).toBe(1)
  expect(cloudScaleFor(3)).toBe(.5)
  expect(cloudScaleFor(QUALITY_FLOOR)).toBe(.5)
})
it('画质说明:完整 / 自动降到 n 颗 / 性能模式', () => {
  const user = { ...TUNING_DEFAULTS, count: 6800 }
  expect(describeQuality(user, 0, false)).toBe('完整(6800 颗)')
  expect(describeQuality(user, 1, false)).toBe('自动降到 3400 颗')
  expect(describeQuality(user, 2, false)).toBe('自动降到 3400 颗 · 柔光关')
  expect(describeQuality(user, QUALITY_FLOOR, true)).toBe('性能模式:1700 颗 · 柔光关 · 光团减半')
})
it('帧预算:30帧时在60Hz的rAF上隔帧绘制、dt按实际累计;0预算逐帧绘制;每个tick都上报', () => {
  const frames = new Map<number, FrameRequestCallback>(); let next = 0
  const draw = vi.fn(), onFrame = vi.fn()
  const loop = new ParticleLoop(draw, cb => { frames.set(++next, cb); return next }, id => frames.delete(id), onFrame)
  loop.setBudget(1000 / 30)
  loop.update(true, false)
  let at = 1000
  for (let i = 0; i < 6; i++) { const id = next; frames.get(id)!(at); frames.delete(id); at += 1000 / 60 }
  // 首帧 + 第 3、5 帧绘制
  expect(draw).toHaveBeenCalledTimes(3)
  expect(draw.mock.calls[1]![0]).toBeCloseTo(1 / 30, 3)
  expect(onFrame).toHaveBeenCalledTimes(6)
  loop.setBudget(0)
  for (let i = 0; i < 4; i++) { const id = next; frames.get(id)!(at); frames.delete(id); at += 1000 / 60 }
  expect(draw).toHaveBeenCalledTimes(7)
  loop.dispose()
})
it('采样器:预热700ms后按5秒窗口汇总rAF间隔、回调耗时与长帧', () => {
  const reports: ReturnType<FrameProfiler['summary']>[] = []
  const profiler = new FrameProfiler(report => reports.push(report))
  let at = 0
  for (let i = 0; i < 400; i++) { at += i === 100 ? 80 : 16.7; profiler.record(at, i % 2 ? 3 : 1) }
  expect(reports).toHaveLength(1)
  expect(reports[0]!.longFrames).toBe(1)
  expect(reports[0]!.intervalMean).toBeGreaterThan(16.7)
  expect(reports[0]!.costMean).toBeCloseTo(2, 0)
  expect(reports[0]!.frames).toBeGreaterThan(250)
})
