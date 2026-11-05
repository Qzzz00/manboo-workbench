import { describe, expect, it } from 'vitest'
import { RING_AFTER_SEC, RING_COOLDOWN_SEC } from '../src/protocol.ts'
import { createWorkbenchService } from '../src/server/service.ts'

const T0 = 1_755_500_000

/** 造一个时钟可控的服务，避免测试依赖真实时间。 */
function bench(start = T0) {
  let now = start
  const service = createWorkbenchService({ now: () => now })
  return {
    service,
    advance(sec: number) {
      now += sec
    },
  }
}

describe('createWorkbenchService', () => {
  it('四家来源都出现在快照里，没接入过的标 connected:false 而不是留白', () => {
    const { service } = bench()

    const { agents } = service.getState()
    expect(agents.map(a => a.id)).toEqual(['dsh', 'claude', 'codex', 'kimi'])
    expect(agents.every(a => !a.connected && !a.online)).toBe(true)
  })

  it('按 agent 汇总等待 / 在跑条数', () => {
    const { service } = bench()
    service.applyEvent({ agent: 'dsh', session_id: 'w1', type: 'waiting', reason: 'permission_prompt' })
    service.applyEvent({ agent: 'dsh', session_id: 'r1', type: 'running' })
    service.applyEvent({ agent: 'claude', session_id: 'r2', type: 'running' })

    const agents = Object.fromEntries(service.getState().agents.map(a => [a.id, a]))
    expect(agents.dsh).toMatchObject({ connected: true, online: true, waiting: 1, running: 1 })
    expect(agents.claude).toMatchObject({ connected: true, online: true, waiting: 0, running: 1 })
    expect(agents.codex).toMatchObject({ connected: false, online: false })
  })

  it('额度默认是 unknown，界面据此标明未实测而不是显示 0', () => {
    const { service } = bench()

    const { quota } = service.getState()
    expect(quota.dsh).toEqual({ kind: 'unknown' })
    expect(quota.claude).toEqual({ kind: 'unknown' })
    expect(quota.codex).toEqual({ kind: 'unknown' })
    expect(quota.kimi).toEqual({ kind: 'unknown' })
  })

  it('now 是可解析的时间戳', () => {
    const { service } = bench()

    expect(Date.parse(service.getState().now)).toBe(T0 * 1000)
  })
})

describe('架构约束 C1：上游掉线不清空快照', () => {
  it('上游挂了以后看板还能拿到上次数据，只是标 stale', () => {
    const { service, advance } = bench()
    service.applyEvent({
      agent: 'dsh',
      session_id: 'a7c1',
      type: 'waiting',
      reason: 'permission_prompt',
      project: '扣扣直聘',
      title: '要改 config/schema.ts',
    })
    expect(service.getState().stale).toBe(false)

    advance(30)
    service.markUpstreamOffline()

    const state = service.getState()
    expect(state.stale).toBe(true)
    expect(state.sessions).toHaveLength(1)
    expect(state.sessions[0]).toMatchObject({
      session_id: 'a7c1',
      project: '扣扣直聘',
      title: '要改 config/schema.ts',
      status: 'waiting',
    })
    expect(state.agents.find(a => a.id === 'dsh')).toMatchObject({ connected: true, online: false })
  })

  it('单个来源上报 offline 只让它自己离线', () => {
    const { service } = bench()
    service.applyEvent({ agent: 'dsh', session_id: 'a7c1', type: 'running' })
    service.applyEvent({ agent: 'claude', session_id: 'b1', type: 'running' })
    service.applyEvent({ agent: 'dsh', session_id: 'a7c1', type: 'offline', reason: 'offline' })

    const state = service.getState()
    expect(state.stale).toBe(false)
    expect(state.agents.find(a => a.id === 'dsh')?.online).toBe(false)
    expect(state.agents.find(a => a.id === 'claude')?.online).toBe(true)
  })

  it('上游回来以后 stale 自动摘掉', () => {
    const { service } = bench()
    service.applyEvent({ agent: 'dsh', session_id: 'a7c1', type: 'running' })
    service.markUpstreamOffline()
    expect(service.getState().stale).toBe(true)

    service.applyEvent({ agent: 'dsh', session_id: 'a7c1', type: 'running' })
    expect(service.getState().stale).toBe(false)
  })

  it('一个来源都没接入过时不算掉线', () => {
    const { service } = bench()
    service.markUpstreamOffline()

    expect(service.getState().stale).toBe(false)
  })
})

describe('tick 响铃', () => {
  it('等审批超时后 tick 出一条铃，冷却期内不再出', () => {
    const { service, advance } = bench()
    service.applyEvent({ agent: 'dsh', session_id: 'a7c1', type: 'waiting', reason: 'permission_prompt' })

    expect(service.tick()).toEqual([])
    advance(RING_AFTER_SEC + 1)
    expect(service.tick()).toEqual([{ agent: 'dsh', session_id: 'a7c1' }])
    advance(1)
    expect(service.tick()).toEqual([])
    advance(RING_COOLDOWN_SEC)
    expect(service.tick()).toEqual([{ agent: 'dsh', session_id: 'a7c1' }])
  })

  it('会话完成后不再响铃', () => {
    const { service, advance } = bench()
    service.applyEvent({ agent: 'dsh', session_id: 'a7c1', type: 'waiting', reason: 'permission_prompt' })
    advance(RING_AFTER_SEC + 1)
    service.applyEvent({ agent: 'dsh', session_id: 'a7c1', type: 'done', reason: 'stop' })

    advance(RING_AFTER_SEC + 1)
    expect(service.tick()).toEqual([])
  })
})

describe('已读入口', () => {
  it('标已读把未读清掉，未知会话返回 false', () => {
    const { service } = bench()
    service.applyEvent({ agent: 'dsh', session_id: 'a7c1', type: 'done', reason: 'stop' })

    expect(service.getState().sessions[0]?.unread).toBe(true)
    expect(service.markRead('dsh', 'a7c1')).toBe(true)
    expect(service.getState().sessions[0]?.unread).toBe(false)
    expect(service.markRead('dsh', '不存在')).toBe(false)
  })
})

describe('已读状态跨重启保留(2026-09-02 Ben 点名)', () => {
  /** 极简的已读簿桩:只管记与查,不碰磁盘。 */
  function fakeMarks() {
    const set = new Set<string>()
    return {
      set,
      marks: {
        has: (agent: string, id: string) => set.has(`${agent}:${id}`),
        add: (agent: string, id: string) => { set.add(`${agent}:${id}`) },
      },
    }
  }

  it('★重启前标过已读 → 重启后同一条会话再报 done,也不再是未读', () => {
    const fake = fakeMarks()
    fake.set.add('codex:s1') // 上一条命里标过

    const service = createWorkbenchService({ now: () => 1_788_300_000, readMarks: fake.marks })
    service.applyEvent({ agent: 'codex', session_id: 's1', project: 'X', type: 'done' })

    const view = service.getState().sessions.find(s => s.session_id === 's1')
    expect(view?.status).toBe('done')
    expect(view?.unread).toBe(false) // ← 修之前这里是 true,每次重启都要重新点一遍
  })

  it('没标过的照旧是未读——不能把"没看过"也一起吞掉', () => {
    const fake = fakeMarks()
    const service = createWorkbenchService({ now: () => 1_788_300_000, readMarks: fake.marks })
    service.applyEvent({ agent: 'codex', session_id: 's2', project: 'X', type: 'done' })
    expect(service.getState().sessions.find(s => s.session_id === 's2')?.unread).toBe(true)
  })

  it('★markRead 会写进已读簿(这样下次重启才认得)', () => {
    const fake = fakeMarks()
    const service = createWorkbenchService({ now: () => 1_788_300_000, readMarks: fake.marks })
    service.applyEvent({ agent: 'codex', session_id: 's3', project: 'X', type: 'done' })
    expect(service.markRead('codex', 's3')).toBe(true)
    expect(fake.set.has('codex:s3')).toBe(true)
  })

  it('不传已读簿时行为与从前完全一致(既有调用方零改动)', () => {
    const service = createWorkbenchService({ now: () => 1_788_300_000 })
    service.applyEvent({ agent: 'codex', session_id: 's4', project: 'X', type: 'done' })
    expect(service.getState().sessions.find(s => s.session_id === 's4')?.unread).toBe(true)
  })
})
