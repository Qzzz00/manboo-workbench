// 窗口槽空态让开展开着的悬浮窗(2026-10-27):压住右侧就留右边距,压住左侧留左边距,没压住或整块盖住不让。
import { describe, expect, it } from 'vitest'
import { floatInset } from '../src/client/useAvoidFloat.ts'

const box = { left: 200, right: 1000, top: 100, bottom: 640 }
describe('floatInset', () => {
  it('★浮窗在右下压住槽右侧 80px → 右边让 80', () => {
    expect(floatInset(box, { left: 920, right: 1440, top: 0, bottom: 640 })).toEqual({ left: 0, right: 80 })
  })
  it('浮窗在左边压住 → 左边让', () => {
    expect(floatInset(box, { left: 0, right: 300, top: 300, bottom: 900 })).toEqual({ left: 100, right: 0 })
  })
  it('没压住、收成球(不传)、或整块盖住:不让', () => {
    expect(floatInset(box, { left: 1100, right: 1400, top: 0, bottom: 900 })).toEqual({ left: 0, right: 0 })
    expect(floatInset(box, undefined)).toEqual({ left: 0, right: 0 })
    expect(floatInset(box, { left: 100, right: 1100, top: 0, bottom: 900 })).toEqual({ left: 0, right: 0 })
  })
  it('只在横向重叠、纵向错开:不让', () => {
    expect(floatInset(box, { left: 900, right: 1400, top: 700, bottom: 900 })).toEqual({ left: 0, right: 0 })
  })
})
