/**
 * 「当前正在响的是谁」这份台账的测试。先于实现编写（仓库纪律：TDD）。
 *
 * 为什么需要它：2026-08-25 实测——响铃状态原来只活在消息流里，谁也不持有。
 * 派一断线重连就永久丢失这次响铃（回到待机态，按钮按下去什么也不做），
 * 网页那个「🔕停铃」又只认 dsh:test-ring 一个键，真响铃根本停不掉，
 * 只能干等 60 秒兜底。台账就是为了让重连的订阅者知道「现在在响什么」。
 */
import { describe, expect, it } from 'vitest'
import { listRings, pruneRings, startRing, stopRing } from '../src/server/ringActive.ts'

const claude = { agent: 'claude', session_id: 's1' } as const
const test1 = { agent: 'dsh', session_id: 'test-ring' } as const

describe('起铃', () => {
  it('起铃后能被列出来——重连的订阅者就靠这个知道现在在响什么', () => {
    const active = startRing({}, claude, 100)

    expect(listRings(active)).toEqual([{ agent: 'claude', session_id: 's1' }])
  })

  it('同一会话重复起铃只留一条，不重复堆积', () => {
    const active = startRing(startRing({}, claude, 100), claude, 130)

    expect(listRings(active)).toHaveLength(1)
  })
})

describe('停铃', () => {
  it('只摘掉指定那条，不动别的', () => {
    const active = stopRing(startRing(startRing({}, claude, 100), test1, 100), claude)

    expect(listRings(active)).toEqual([{ agent: 'dsh', session_id: 'test-ring' }])
  })

  it('停一条没在响的不炸，也不改动台账', () => {
    const before = startRing({}, claude, 100)

    expect(listRings(stopRing(before, test1))).toEqual(listRings(before))
  })
})

describe('过期清理', () => {
  it('超过时限的自动清掉（毫秒）——对齐展示台 60 秒兜底自停，别让台账里留着早就不响的', () => {
    const active = startRing({}, claude, 100)

    expect(listRings(pruneRings(active, 100 + 60_001, 60_000))).toEqual([])
  })

  it('正好卡在时限上还算在响（与响铃判定同款「持续超过」语义）', () => {
    const active = startRing({}, claude, 100)

    expect(listRings(pruneRings(active, 100 + 60_000, 60_000))).toHaveLength(1)
  })
})
