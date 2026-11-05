import { describe, expect, it } from 'vitest'
import { EventLog } from '../src/events.ts'
import { translate, applyEvent } from '../src/translate.ts'

describe('EventLog', () => {
  it('seq 从 1 起严格单调 +1,每条带 ts / topic / kind / payload', () => {
    let t = 1000
    const log = new EventLog({ keep: 10, now: () => t++ })
    const a = log.append('state.agents', 'set', [1])
    const b = log.append('state.agents', 'set', [2])
    expect(a).toEqual({ seq: 1, ts: 1000, topic: 'state.agents', kind: 'set', payload: [1] })
    expect(b.seq).toBe(2)
    expect(log.lastSeq).toBe(2)
  })

  it('只留最近 N 条:超出的从旧的丢', () => {
    const log = new EventLog({ keep: 3 })
    for (let i = 0; i < 10; i++) log.append('t', 'set', i)
    expect(log.oldestSeq).toBe(8)
    const r = log.since(7)
    expect(r.ok && r.events.map(e => e.seq)).toEqual([8, 9, 10])
  })

  it('按字节也有上限:一条巨大的事件把旧的挤出去,但最新那一条总在', () => {
    const log = new EventLog({ keep: 100, keepBytes: 1000 })
    for (let i = 0; i < 5; i++) log.append('t', 'set', 'x'.repeat(300))
    expect(log.size()).toBeLessThanOrEqual(3)
    log.append('t', 'set', 'y'.repeat(5000))
    expect(log.size()).toBe(1)
    expect(log.oldestSeq).toBe(6)
  })

  it('since 的边界:= lastSeq 回空;早于保留窗、晚于 lastSeq 都回 gone', () => {
    const log = new EventLog({ keep: 3 })
    for (let i = 0; i < 6; i++) log.append('t', 'set', i)
    expect(log.since(6)).toEqual({ ok: true, events: [] })
    expect(log.since(3).ok).toBe(true) // 3 之后是 4,4 还在
    expect(log.since(2)).toMatchObject({ ok: false, reason: 'too_old' })
    expect(log.since(7)).toMatchObject({ ok: false, reason: 'ahead' })
    expect(log.since(-1)).toMatchObject({ ok: false, reason: 'bad' })
  })

  it('空日志 since=0 回空;订阅者按顺序收到之后追加的每一条', () => {
    const log = new EventLog({ keep: 3 })
    expect(log.since(0)).toEqual({ ok: true, events: [] })
    const got: number[] = []
    const off = log.subscribe(e => got.push(e.seq))
    log.append('t', 'set', 1)
    log.append('t', 'set', 2)
    off()
    log.append('t', 'set', 3)
    expect(got).toEqual([1, 2])
  })

  it('每次启动一个新 epoch:座机服务重启后旧 seq 不能拿来续', () => {
    expect(new EventLog({ keep: 1 }).epoch).not.toBe(new EventLog({ keep: 1 }).epoch)
  })
})

describe('translate:插件 /live 消息 → 事件', () => {
  it('第一帧快照:每个顶层键一条 set', () => {
    expect(translate(null, { kind: 'snapshot', state: { a: 1, b: [2] } })).toEqual([
      { topic: 'state.a', kind: 'set', payload: 1 },
      { topic: 'state.b', kind: 'set', payload: [2] },
    ])
  })

  it('之后的快照只出变了的键;没了的键出 unset;没变就一条都不出', () => {
    const prev = { a: 1, b: { x: 1 }, c: 'keep' }
    expect(translate(prev, { kind: 'snapshot', state: { a: 1, b: { x: 2 }, c: 'keep' } })).toEqual([
      { topic: 'state.b', kind: 'set', payload: { x: 2 } },
    ])
    expect(translate(prev, { kind: 'snapshot', state: { a: 1, c: 'keep' } })).toEqual([
      { topic: 'state.b', kind: 'unset', payload: null },
    ])
    expect(translate(prev, { kind: 'snapshot', state: { ...prev } })).toEqual([])
  })

  it('非快照的广播(event / call / ring / actor_note …)按 kind 归一条 live.<kind>;心跳 ping 不进流', () => {
    expect(translate({}, { kind: 'call', phase: 'offhook', agent: 'claude', session_id: 's1' })).toEqual([
      { topic: 'live.call', kind: 'message', payload: { kind: 'call', phase: 'offhook', agent: 'claude', session_id: 's1' } },
    ])
    expect(translate({}, { kind: 'ping', ts: 1 })).toEqual([])
    expect(translate({}, 'not an object')).toEqual([])
    expect(translate({}, { kind: 'snapshot' })).toEqual([])
  })

  it('applyEvent 把 set / unset 应用回镜像;live.* 不改镜像', () => {
    let m: Record<string, unknown> = { a: 1, b: 2 }
    m = applyEvent(m, { topic: 'state.a', kind: 'set', payload: 9 })
    m = applyEvent(m, { topic: 'state.b', kind: 'unset', payload: null })
    m = applyEvent(m, { topic: 'live.call', kind: 'message', payload: {} })
    expect(m).toEqual({ a: 9 })
  })
})
