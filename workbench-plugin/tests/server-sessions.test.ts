import { describe, expect, it } from 'vitest'
import type { WorkbenchEvent } from '../src/protocol.ts'
import type { SessionStore } from '../src/server/sessions.ts'
import {
  applyEvent,
  emptySessionStore,
  inferProject,
  markRead,
  setMetrics,
  toSessionViews,
} from '../src/server/sessions.ts'

/** 基准时刻，测试里所有秒数都相对它算，避免依赖真实时钟。 */
const T0 = 1_755_500_000

function evt(patch: Partial<WorkbenchEvent> = {}): WorkbenchEvent {
  return {
    agent: 'dsh',
    session_id: 'a7c1',
    type: 'running',
    ...patch,
  }
}

describe('inferProject', () => {
  it('取 cwd 末段作为项目名', () => {
    expect(inferProject('/Users/example/Documents/GitHub/Aiboo')).toBe('Aiboo')
  })

  it('忽略结尾的斜杠', () => {
    expect(inferProject('/Users/example/Documents/GitHub/Aiboo/')).toBe('Aiboo')
  })

  it('cwd 缺失或不含有效段时返回 undefined，绝不编造项目名', () => {
    expect(inferProject(undefined)).toBeUndefined()
    expect(inferProject('')).toBeUndefined()
    expect(inferProject('/')).toBeUndefined()
  })
})

describe('applyEvent', () => {
  it('project 缺失时按 cwd 末段推断', () => {
    const store = applyEvent(emptySessionStore(), evt({ cwd: '/Users/example/GitHub/扣扣直聘' }), T0)
    const [view] = toSessionViews(store, T0)

    expect(view?.project).toBe('扣扣直聘')
  })

  it('显式 project 优先于 cwd 推断', () => {
    const store = applyEvent(
      emptySessionStore(),
      evt({ project: '扣扣直聘', cwd: '/Users/example/GitHub/kkzp' }),
      T0,
    )

    expect(toSessionViews(store, T0)[0]?.project).toBe('扣扣直聘')
  })

  it('project 与 cwd 都没有时给占位名而不是空字符串', () => {
    const store = applyEvent(emptySessionStore(), evt(), T0)

    expect(toSessionViews(store, T0)[0]?.project).toBe('未归类')
  })

  it('elapsed_sec 从进入当前状态的时刻算起，waiting 期间持续走', () => {
    const store = applyEvent(
      emptySessionStore(),
      evt({ type: 'waiting', reason: 'permission_prompt', ts: T0 }),
      T0,
    )

    expect(toSessionViews(store, T0)[0]?.elapsed_sec).toBe(0)
    expect(toSessionViews(store, T0 + 252)[0]?.elapsed_sec).toBe(252)
  })

  it('状态变化时重置计时', () => {
    let store = applyEvent(emptySessionStore(), evt({ type: 'running', ts: T0 }), T0)
    store = applyEvent(store, evt({ type: 'waiting', reason: 'permission_prompt', ts: T0 + 100 }), T0 + 100)

    expect(toSessionViews(store, T0 + 130)[0]?.elapsed_sec).toBe(30)
  })

  it('同状态的重复上报不重置计时，但刷新「上次输出距今」', () => {
    let store = applyEvent(emptySessionStore(), evt({ type: 'running', ts: T0 }), T0)
    store = applyEvent(store, evt({ type: 'running', ts: T0 + 40 }), T0 + 40)

    const [view] = toSessionViews(store, T0 + 60)
    expect(view?.elapsed_sec).toBe(60)
    expect(view?.last_output_sec).toBe(20)
  })

  it('waiting 的 reason 变化算重新进入状态', () => {
    let store = applyEvent(emptySessionStore(), evt({ type: 'waiting', reason: 'idle_prompt', ts: T0 }), T0)
    store = applyEvent(
      store,
      evt({ type: 'waiting', reason: 'permission_prompt', ts: T0 + 90 }),
      T0 + 90,
    )

    expect(toSessionViews(store, T0 + 100)[0]?.elapsed_sec).toBe(10)
  })

  it('ts 缺省时用接收时刻', () => {
    const store = applyEvent(emptySessionStore(), evt({ type: 'waiting' }), T0)

    expect(toSessionViews(store, T0 + 5)[0]?.elapsed_sec).toBe(5)
  })

  it('title / summary 沿用上一次已知值，缺省的上报不会把它擦掉', () => {
    let store = applyEvent(
      emptySessionStore(),
      evt({ type: 'waiting', title: '要改 config/schema.ts', summary: '改动会影响 3 处引用' }),
      T0,
    )
    store = applyEvent(store, evt({ type: 'running', ts: T0 + 10 }), T0 + 10)

    const [view] = toSessionViews(store, T0 + 10)
    expect(view?.title).toBe('要改 config/schema.ts')
    expect(view?.summary).toBe('改动会影响 3 处引用')
  })

  it('不同 agent 的同名 session_id 互不串台', () => {
    let store = applyEvent(emptySessionStore(), evt({ agent: 'dsh', type: 'waiting' }), T0)
    store = applyEvent(store, evt({ agent: 'claude', type: 'running' }), T0)

    expect(toSessionViews(store, T0)).toHaveLength(2)
  })

  it('把 waiting 排在最前，方便界面置顶', () => {
    let store = emptySessionStore()
    store = applyEvent(store, evt({ session_id: 'r1', type: 'running' }), T0)
    store = applyEvent(store, evt({ session_id: 'd1', type: 'done', reason: 'stop' }), T0)
    store = applyEvent(store, evt({ session_id: 'w1', type: 'waiting', reason: 'permission_prompt' }), T0)

    expect(toSessionViews(store, T0).map(v => v.session_id)).toEqual(['w1', 'd1', 'r1'])
  })
})

describe('幽灵 SessionEnd：从没见过的会话，第一条事件就是 offline', () => {
  it('不建条目——一次性后台/辅助进程生平只发一条 SessionEnd，不该在界面上占一行纯噪音', () => {
    const store = applyEvent(emptySessionStore(), evt({ type: 'offline', reason: 'offline' }), T0)

    expect(toSessionViews(store, T0)).toHaveLength(0)
  })

  it('返回的 store 与原 store 全等（空操作），不是"建了又立刻清空"', () => {
    const before = emptySessionStore()
    const after = applyEvent(before, evt({ type: 'offline', reason: 'offline' }), T0)

    expect(after).toBe(before)
  })

  it('已经见过的会话收到 offline 时照旧正常流转，不受这条丢弃规则影响', () => {
    let store = applyEvent(emptySessionStore(), evt({ type: 'running', ts: T0 }), T0)
    store = applyEvent(store, evt({ type: 'offline', reason: 'offline', ts: T0 + 30 }), T0 + 30)

    const [view] = toSessionViews(store, T0 + 30)
    expect(view?.status).toBe('offline')
    expect(view?.reason).toBe('offline')
  })

  it('done/waiting/running 的未知会话照常创建——这些是有信息量的首事件，不是幽灵', () => {
    let store = emptySessionStore()
    store = applyEvent(store, evt({ session_id: 'd1', type: 'done', reason: 'stop' }), T0)
    store = applyEvent(store, evt({ session_id: 'w1', type: 'waiting', reason: 'permission_prompt' }), T0)
    store = applyEvent(store, evt({ session_id: 'r1', type: 'running' }), T0)

    expect(toSessionViews(store, T0).map(v => v.session_id).sort()).toEqual(['d1', 'r1', 'w1'])
  })

  it('多个不同会话各自的首个 offline 事件都被丢弃，互不影响', () => {
    let store = emptySessionStore()
    store = applyEvent(store, evt({ agent: 'claude', session_id: 'x1', type: 'offline', reason: 'offline' }), T0)
    store = applyEvent(store, evt({ agent: 'codex', session_id: 'x2', type: 'offline', reason: 'offline' }), T0)

    expect(toSessionViews(store, T0)).toHaveLength(0)
  })
})

describe('done 的未读语义（PRD §5.3）', () => {
  it('完成即标未读', () => {
    const store = applyEvent(emptySessionStore(), evt({ type: 'done', reason: 'stop' }), T0)

    expect(toSessionViews(store, T0)[0]?.unread).toBe(true)
  })

  it('未读不会被后续消息刷掉', () => {
    let store = applyEvent(emptySessionStore(), evt({ type: 'done', reason: 'stop', ts: T0 }), T0)
    store = applyEvent(store, evt({ type: 'running', ts: T0 + 30 }), T0 + 30)
    store = applyEvent(store, evt({ type: 'waiting', reason: 'idle_prompt', ts: T0 + 60 }), T0 + 60)

    expect(toSessionViews(store, T0 + 60)[0]?.unread).toBe(true)
  })

  it('只有显式已读才清掉未读', () => {
    let store = applyEvent(emptySessionStore(), evt({ type: 'done', reason: 'stop' }), T0)
    store = markRead(store, 'dsh', 'a7c1')

    expect(toSessionViews(store, T0)[0]?.unread).toBe(false)
  })

  it('已读之后再次完成会重新标未读', () => {
    let store = applyEvent(emptySessionStore(), evt({ type: 'done', reason: 'stop', ts: T0 }), T0)
    store = markRead(store, 'dsh', 'a7c1')
    store = applyEvent(store, evt({ type: 'done', reason: 'stop', ts: T0 + 100 }), T0 + 100)

    expect(toSessionViews(store, T0 + 100)[0]?.unread).toBe(true)
  })

  it('标记不存在的会话为已读时原样返回', () => {
    const store = emptySessionStore()

    expect(markRead(store, 'dsh', '不存在')).toBe(store)
  })

  it('running / waiting 不会被标成未读', () => {
    const store = applyEvent(emptySessionStore(), evt({ type: 'running' }), T0)

    expect(toSessionViews(store, T0)[0]?.unread).toBe(false)
  })
})

/**
 * 会话行上的数字(2026-09-09,DSH 会话接入)。数字与状态是两条独立的路:
 * 状态走 applyEvent(hook/事件流),数字走 setMetrics(投影订阅 + 文件计数)。
 */
describe('setMetrics(会话行上的三个数字)', () => {
  const NOW = 1_788_925_678

  function withRunningDsh(): SessionStore {
    return applyEvent(emptySessionStore(), {
      agent: 'dsh', session_id: 's1', type: 'running',
    }, NOW)
  }

  it('★会话不存在时原样返回:数字不许凭空造出一行会话', () => {
    const store = emptySessionStore()
    expect(setMetrics(store, 'dsh', 'ghost', { context_tokens: 8805 })).toBe(store)
  })

  it('写进去的数字出现在视图里', () => {
    const store = setMetrics(withRunningDsh(), 'dsh', 's1', { context_tokens: 8805, cache_hit_pct: 75 })
    const view = toSessionViews(store, NOW)[0]
    expect(view?.metrics).toEqual({ context_tokens: 8805, cache_hit_pct: 75 })
  })

  it('★后到的数字与先到的合并,不互相擦除(文件数与投影值到达时机不同)', () => {
    let store = setMetrics(withRunningDsh(), 'dsh', 's1', { files_changed: 2 })
    store = setMetrics(store, 'dsh', 's1', { context_tokens: 8805 })
    expect(toSessionViews(store, NOW)[0]?.metrics).toEqual({ files_changed: 2, context_tokens: 8805 })
  })

  it('数字没变时返回同一个 store(不制造无意义的变化)', () => {
    const store = setMetrics(withRunningDsh(), 'dsh', 's1', { context_tokens: 8805 })
    expect(setMetrics(store, 'dsh', 's1', { context_tokens: 8805 })).toBe(store)
  })

  it('★随后的状态上报不会把数字擦掉', () => {
    const store = setMetrics(withRunningDsh(), 'dsh', 's1', { context_tokens: 8805 })
    const next = applyEvent(store, { agent: 'dsh', session_id: 's1', type: 'done' }, NOW + 5)
    expect(toSessionViews(next, NOW + 5)[0]?.metrics).toEqual({ context_tokens: 8805 })
  })
})

describe('最近在做什么(2026-09-25,卡 P)', () => {
  it('activity 同 title/summary:上报带就换,不带就沿用上一次', async () => {
    const { applyEvent: apply, emptySessionStore: empty, toSessionViews: views } = await import('../src/server/sessions.ts')
    let store = apply(empty(), { agent: 'codex', session_id: 'c1', type: 'running', activity: { line: '在跑测试', at: '2026-09-25T07:00:00.000Z' } }, 100)
    store = apply(store, { agent: 'codex', session_id: 'c1', type: 'running' }, 110)
    expect(views(store, 120)[0]?.activity).toEqual({ line: '在跑测试', at: '2026-09-25T07:00:00.000Z' })
    store = apply(store, { agent: 'codex', session_id: 'c1', type: 'running', activity: { line: '在提交改动', at: '2026-09-25T07:01:00.000Z' } }, 130)
    expect(views(store, 140)[0]?.activity?.line).toBe('在提交改动')
  })

  it('setDetail:只补标题与在做什么,不建行、不动状态与计时;没变原样返回', async () => {
    const { applyEvent: apply, emptySessionStore: empty, setDetail, toSessionViews: views } = await import('../src/server/sessions.ts')
    const blank = empty()
    expect(setDetail(blank, 'claude', 'nope', { title: 'x' })).toBe(blank)
    const store = apply(blank, { agent: 'claude', session_id: 's1', type: 'waiting', reason: 'permission_prompt', wait_reason: 'approval' }, 100)
    const next = setDetail(store, 'claude', 's1', { title: '统筹交接', activity: { line: '在等你批准一个操作', at: '2026-09-25T07:00:00.000Z' } })
    const view = views(next, 160)[0]!
    expect(view).toMatchObject({ status: 'waiting', wait_reason: 'approval', elapsed_sec: 60, title: '统筹交接', activity: { line: '在等你批准一个操作' } })
    expect(setDetail(next, 'claude', 's1', { title: '统筹交接' })).toBe(next)
  })

  it('setDetail 带 selfcheck:钩子在管的探针会话也记成工作台自己起的(统筹 09-26 晚,Claude 那格假蓝 1)', async () => {
    const { applyEvent: apply, emptySessionStore: empty, setDetail, toSessionViews: views } = await import('../src/server/sessions.ts')
    const store = apply(empty(), { agent: 'claude', session_id: 'p1', type: 'done' }, 100)
    const next = setDetail(store, 'claude', 'p1', { selfcheck: { by: 'sdk' } })
    expect(views(next, 120)[0]?.selfcheck).toEqual({ by: 'sdk' })
    // 已记过就原样返回(不重复推快照);不带 selfcheck 也不会把它抹掉。
    expect(setDetail(next, 'claude', 'p1', { selfcheck: { by: 'sdk' } })).toBe(next)
    expect(views(setDetail(next, 'claude', 'p1', { title: 'x' }), 120)[0]?.selfcheck).toEqual({ by: 'sdk' })
  })
})
