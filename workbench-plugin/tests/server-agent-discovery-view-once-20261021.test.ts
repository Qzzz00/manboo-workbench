// @vitest-environment node
/**
 * 登记表视图**同一拍只出一份**(2026-10-21 急修「8791 空转」)。
 *
 * 一次 `/state` 里派活对象表(每家问一次装了哪些包)、额度、体检、引导各自回头问登记表,真机采样里一拍要现算十来遍,
 * 每一遍都给每一家、每一条会话重判一次「在等你」。
 *
 * 钉四件事:
 *   ① 同一段同步执行、同一秒、会话表一字不差 → 同一份;
 *   ② 会话表变了(哪怕是同一个数组被改了)→ 新的;
 *   ③ 换了一秒 → 新的;
 *   ④ 过了一个微任务 → 新的。
 */
import { describe, expect, it } from 'vitest'
import type { SessionView } from '../src/protocol.ts'
import { createAgentDiscovery } from '../src/server/agentDiscovery.ts'
import { createMemoryRegistryStore } from '../src/server/agentRegistry.ts'
import { fakeModel, fakeShell } from './fixtures/agentWorld.ts'

function world() {
  let clock = new Date('2026-10-21T12:00:00Z')
  const sessions: SessionView[] = []
  let asks = 0
  const discovery = createAgentDiscovery({
    store: createMemoryRegistryStore(),
    helper: fakeShell([]).helper,
    judge: fakeModel({}, {}).judge,
    remainingCny: async () => 4.5,
    inCall: () => false,
    sessions: () => sessions,
    askOf: () => { asks += 1; return undefined },
    now: () => clock,
    setInterval: () => 1,
    clearInterval: () => {},
    setTimeout: () => 1,
    clearTimeout: () => {},
  })
  return { discovery, sessions, advance: (ms: number) => { clock = new Date(clock.getTime() + ms) } }
}

function session(id: string, status: SessionView['status']): SessionView {
  return { agent: 'claude', session_id: id, project: 'p', status, elapsed_sec: 1, unread: false, updated_at: '2026-10-21T12:00:00Z' } as SessionView
}

describe('登记表视图同一拍只出一份', () => {
  it('★同一段同步执行里连问三次:同一份', () => {
    const { discovery, sessions } = world()
    sessions.push(session('s1', 'running'))
    const first = discovery.view()
    expect(discovery.view()).toBe(first)
    expect(discovery.view()).toBe(first)
  })

  it('会话表变了(同一个数组被改了)→ 新的', () => {
    const { discovery, sessions } = world()
    sessions.push(session('s1', 'running'))
    const first = discovery.view()
    sessions[0] = session('s1', 'waiting')
    expect(discovery.view()).not.toBe(first)
    const second = discovery.view()
    sessions.push(session('s2', 'running'))
    expect(discovery.view()).not.toBe(second)
  })

  it('换了一秒 → 新的;过了一个微任务 → 新的', async () => {
    const { discovery, advance } = world()
    const first = discovery.view()
    advance(1000)
    const second = discovery.view()
    expect(second).not.toBe(first)
    await Promise.resolve()
    expect(discovery.view()).not.toBe(second)
  })
})
