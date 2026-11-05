// @vitest-environment node
/**
 * 会话表要收(2026-10-19,卡「插件内存增长与 GC 抖动」):从前只进不出,进程跑几天表里就是这几天的每一条会话。
 * 钉的是:在跑 / 在等的一条不丢;结束了的超过 7 天丢;每家结束了的超过 200 条按最老的先丢;没要丢的原样返回。
 * 服务那一层:tick 一分钟收一次,/state.sessions 随之变短。
 */
import { describe, expect, it } from 'vitest'
import {
  applyEvent, emptySessionStore, pruneSessionStore, SESSION_STORE_KEEP_SEC, SESSION_STORE_MAX_SETTLED_PER_AGENT, type SessionStore,
} from '../src/server/sessions.ts'
import { createWorkbenchService, SESSION_STORE_PRUNE_EVERY_SEC } from '../src/server/service.ts'
import type { WorkbenchEvent } from '../src/protocol.ts'

const DAY = 86_400

function event(input: Partial<WorkbenchEvent> & { session_id: string, ts: number }): WorkbenchEvent {
  return { agent: 'claude', type: 'done', project: 'p', ...input } as WorkbenchEvent
}

function storeWith(...events: WorkbenchEvent[]): SessionStore {
  let store = emptySessionStore()
  for (const one of events) store = applyEvent(store, one, one.ts ?? 0)
  return store
}

describe('pruneSessionStore', () => {
  it('结束了的会话最后一次动静超过 7 天:丢;没超过的留', () => {
    const now = 100 * DAY
    const store = storeWith(
      event({ session_id: 'old', ts: now - SESSION_STORE_KEEP_SEC - 1 }),
      event({ session_id: 'fresh', ts: now - SESSION_STORE_KEEP_SEC + 60 }),
    )
    const pruned = pruneSessionStore(store, now)
    expect(Object.keys(pruned)).toEqual(['claude:fresh'])
  })

  it('在跑 / 在等的一条不丢,再老也不丢(它们是此刻的事实)', () => {
    const now = 100 * DAY
    const store = storeWith(
      event({ session_id: 'running', type: 'running', ts: now - 30 * DAY }),
      event({ session_id: 'waiting', type: 'waiting', ts: now - 30 * DAY }),
      event({ session_id: 'done', type: 'done', ts: now - 30 * DAY }),
    )
    expect(Object.keys(pruneSessionStore(store, now)).sort()).toEqual(['claude:running', 'claude:waiting'])
  })

  it(`每家结束了的超过 ${SESSION_STORE_MAX_SETTLED_PER_AGENT} 条:按最后一次动静最老的先丢,别家不受影响`, () => {
    const now = 10 * DAY
    const events: WorkbenchEvent[] = []
    for (let i = 0; i < SESSION_STORE_MAX_SETTLED_PER_AGENT + 5; i += 1) {
      events.push(event({ session_id: `c${i}`, ts: now - 1000 + i }))
    }
    events.push(event({ agent: 'codex', session_id: 'x', ts: now - 2000 }))
    const pruned = pruneSessionStore(storeWith(...events), now)
    const claude = Object.keys(pruned).filter(key => key.startsWith('claude:'))
    expect(claude).toHaveLength(SESSION_STORE_MAX_SETTLED_PER_AGENT)
    // 最老的 5 条(c0…c4)没了。
    expect(claude).not.toContain('claude:c0')
    expect(claude).not.toContain('claude:c4')
    expect(claude).toContain('claude:c5')
    expect(pruned['codex:x']).toBeDefined()
  })

  it('没有要丢的:原样返回同一个对象', () => {
    const now = 10 * DAY
    const store = storeWith(event({ session_id: 'a', ts: now - 60 }))
    expect(pruneSessionStore(store, now)).toBe(store)
  })

  it('上限可注入(用例与以后放到设置里)', () => {
    const now = 10 * DAY
    const store = storeWith(event({ session_id: 'a', ts: now - 60 }), event({ session_id: 'b', ts: now - 30 }))
    expect(Object.keys(pruneSessionStore(store, now, { maxSettledPerAgent: 1 }))).toEqual(['claude:b'])
    expect(Object.keys(pruneSessionStore(store, now, { keepSec: 40 }))).toEqual(['claude:b'])
  })
})

describe('createWorkbenchService · tick 一分钟收一次', () => {
  it('7 天前结束的会话,过一分钟那一拍从 /state.sessions 里消失;在跑的还在', () => {
    let nowSec = 100 * DAY
    const service = createWorkbenchService({ now: () => nowSec })
    service.applyEvent(event({ session_id: 'old', ts: nowSec - 8 * DAY }))
    service.applyEvent(event({ session_id: 'live', type: 'running', ts: nowSec - 8 * DAY }))
    service.tick()
    // 还没到一分钟:不收。
    expect(service.getState().sessions.map(one => one.session_id).sort()).toEqual(['live', 'old'])
    nowSec += SESSION_STORE_PRUNE_EVERY_SEC
    service.tick()
    expect(service.getState().sessions.map(one => one.session_id)).toEqual(['live'])
  })
})
