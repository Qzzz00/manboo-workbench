import { describe, expect, it } from 'vitest'
import { matchWindowIndex, splitSlot } from '../src/server/dockSplit.ts'

const slot = { x: 100, y: 200, w: 800, h: 600 }

describe('splitSlot', () => {
  it('宽大于高 → 左右劈,两半加上中缝正好等于原宽', () => {
    const [a, b] = splitSlot(slot)
    expect(a.y).toBe(200)
    expect(b.y).toBe(200)
    expect(a.h).toBe(600)
    expect(b.h).toBe(600)
    expect(a.x).toBe(100)
    expect(a.w + b.w + (b.x - (a.x + a.w))).toBe(800)
  })

  it('高大于宽 → 上下劈', () => {
    const [a, b] = splitSlot({ x: 0, y: 0, w: 400, h: 1000 })
    expect(a.x).toBe(0)
    expect(b.x).toBe(0)
    expect(a.w).toBe(400)
    expect(a.h + b.h + (b.y - (a.y + a.h))).toBe(1000)
  })

  it('两半都不为负宽/负高——极窄槽位也不能劈出负数', () => {
    const [a, b] = splitSlot({ x: 0, y: 0, w: 10, h: 8 })
    for (const half of [a, b]) {
      expect(half.w).toBeGreaterThanOrEqual(0)
      expect(half.h).toBeGreaterThanOrEqual(0)
    }
  })
})

describe('matchWindowIndex', () => {
  const windows = [
    { index: 0, frame: { x: 0, y: 0, w: 500, h: 400 } },
    { index: 1, frame: { x: 900, y: 100, w: 600, h: 500 } },
  ]

  it('按 frame 找到对应的窗序号', () => {
    expect(matchWindowIndex(windows, { x: 900, y: 100, w: 600, h: 500 })).toBe(1)
  })

  it('容忍几个像素的抖动——AX 报回来的 frame 常有零点几的误差', () => {
    expect(matchWindowIndex(windows, { x: 901, y: 99.5, w: 600, h: 500 })).toBe(1)
  })

  it('差得远就认不出,返回 undefined 而不是硬凑最近的一个', () => {
    expect(matchWindowIndex(windows, { x: 400, y: 400, w: 300, h: 300 })).toBeUndefined()
  })

  it('两扇窗都对得上(重叠窗)时判定为认不出——宁可降级也不猜', () => {
    const dup = [
      { index: 0, frame: { x: 10, y: 10, w: 100, h: 100 } },
      { index: 1, frame: { x: 10, y: 10, w: 100, h: 100 } },
    ]
    expect(matchWindowIndex(dup, { x: 10, y: 10, w: 100, h: 100 })).toBeUndefined()
  })

  it('空窗口列表返回 undefined,不抛错', () => {
    expect(matchWindowIndex([], { x: 0, y: 0, w: 1, h: 1 })).toBeUndefined()
  })
})
