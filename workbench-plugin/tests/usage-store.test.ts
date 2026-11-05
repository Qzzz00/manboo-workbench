import { beforeAll, describe, expect, it } from 'vitest'
import { createUsageStore, localDayOf, nextCursor } from '../src/usage/store.ts'
import type { UsageRecord } from '../src/usage/types.ts'

/**
 * 按天切片用的是**本机时区**(2026-10-02,见 store.ts 的 localDayOf)。把时区钉死,
 * 这一份才在任何机器上说同一句话 —— 不钉的话 CI 跑在 UTC 上,下面每一个日期都对不上。
 */
beforeAll(() => { process.env.TZ = 'Asia/Shanghai' })

function record(over: Partial<UsageRecord> = {}): UsageRecord {
  return {
    ts: '2026-08-24T10:00:00.000Z',
    project: 'p1',
    model: 'm1',
    source: 'claude',
    input: 10,
    output: 5,
    cache_read: 100,
    cache_write: 20,
    session: 's1',
    ...over,
  }
}

describe('UsageStore 去重', () => {
  it('同一个 key 只计一次——Claude 日志同一请求会出现多条', () => {
    const store = createUsageStore()
    store.ingest([record({ key: 'req-1' }), record({ key: 'req-1' }), record({ key: 'req-2' })])
    const day = store.aggregate().days.find(d => d.date === '2026-08-24')
    expect(day?.by_project.p1?.input).toBe(20)
  })

  it('没有 key 的记录不去重(Codex 每轮都是新增量)', () => {
    const store = createUsageStore()
    store.ingest([record(), record()])
    expect(store.aggregate().days[0]?.by_project.p1?.input).toBe(20)
  })
})

describe('UsageStore 聚合', () => {
  it('按天 × 项目 × 模型 × 来源分别累计', () => {
    const store = createUsageStore()
    store.ingest([
      record({ ts: '2026-08-24T10:00:00.000Z', project: 'p1', model: 'm1' }),
      record({ ts: '2026-08-25T10:00:00.000Z', project: 'p2', model: 'm2', source: 'codex' }),
    ])
    const { days } = store.aggregate()
    expect(days.map(d => d.date)).toEqual(['2026-08-24', '2026-08-25'])
    expect(days[1]?.by_model.m2?.output).toBe(5)
    expect(days[1]?.by_source.codex?.output).toBe(5)
  })

  it('统计会话数与消息数,同一会话不重复计', () => {
    const store = createUsageStore()
    store.ingest([record({ session: 's1' }), record({ session: 's1' }), record({ session: 's2' })])
    const day = store.aggregate().days[0]
    expect(day?.sessions).toBe(2)
    expect(day?.messages).toBe(3)
  })

  it('按小时计数,供高峰时段用 —— **本机钟点**(10:30Z 在东八区是 18 点)', () => {
    const store = createUsageStore()
    store.ingest([record({ ts: '2026-08-24T10:30:00.000Z' })])
    expect(store.aggregate().days[0]?.hour_counts['18']).toBe(1)
  })
})

/**
 * ★ 2026-10-02 运营同学 Air 那一版:按天切片按**本机时区**,不再切 UTC 字符串。
 *
 * 她的原话是「北京时间归日」。上一版 `ts.slice(0,10)` 切的是 UTC,于是东八区**早上 8 点
 * 之前的用量全被记到昨天** —— 她上午打开「今天」那一格恒为 0,而昨天凭空多一截。
 */
describe('按本机时区归日(localDayOf)', () => {
  it('★东八区 00:30 的那一笔算**今天**,不算 UTC 的昨天', () => {
    // 2026-08-25 00:30(+08)= 2026-08-24T16:30Z。上一版会把它记到 08-24。
    expect(localDayOf('2026-08-24T16:30:00.000Z')).toEqual({ date: '2026-08-25', hour: '0' })
    const store = createUsageStore()
    store.ingest([record({ ts: '2026-08-24T16:30:00.000Z' })])
    expect(store.aggregate().days.map(day => day.date)).toEqual(['2026-08-25'])
  })

  it('认不出的时刻**一条都不计入**,不塞进一个猜出来的日子', () => {
    expect(localDayOf('不是一个时刻')).toBeUndefined()
    const store = createUsageStore()
    store.ingest([record({ ts: '不是一个时刻' }), record({ ts: '2026-08-24T10:00:00.000Z' })])
    expect(store.aggregate().days.map(day => day.date)).toEqual(['2026-08-24'])
  })
})

describe('nextCursor 增量追读', () => {
  it('文件变长时只读新增部分', () => {
    expect(nextCursor(500, 200)).toEqual({ offset: 200, rescan: false })
  })

  it('文件被截断或重写时整份重扫', () => {
    expect(nextCursor(100, 200)).toEqual({ offset: 0, rescan: true })
  })

  it('文件没变时偏移量不动', () => {
    expect(nextCursor(200, 200)).toEqual({ offset: 200, rescan: false })
  })
})

/**
 * 按会话汇总(2026-09-09 任务卡费用归因)。键是 `${source}:${session}`,与看板卡上
 * TaskLink 的 `${agent}:${session_id}` 对得上(claude / codex / dsh 三家的 source 就是 AgentId)。
 */
describe('UsageStore 按会话汇总', () => {
  it('同一会话跨天累计;只回问到且查得到的键,查不到的不出现(不填 0)', () => {
    const store = createUsageStore()
    store.ingest([
      record({ ts: '2026-08-24T10:00:00.000Z', session: 's1' }),
      record({ ts: '2026-08-25T10:00:00.000Z', session: 's1', input: 1, output: 1, cache_read: 1, cache_write: 1 }),
      record({ session: 's2', source: 'codex' }),
    ])
    expect(store.sessionTotals(['claude:s1', 'codex:s2', 'kimi:nope', 'claude:s2'])).toEqual({
      'claude:s1': { input: 11, output: 6, cache_read: 101, cache_write: 21 },
      'codex:s2': { input: 10, output: 5, cache_read: 100, cache_write: 20 },
    })
  })

  it('去重键同样作用于按会话的汇总——同一请求的多条只计一次', () => {
    const store = createUsageStore()
    store.ingest([record({ key: 'req-1' }), record({ key: 'req-1' })])
    expect(store.sessionTotals(['claude:s1'])['claude:s1']?.input).toBe(10)
  })
})
