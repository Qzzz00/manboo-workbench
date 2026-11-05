// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import * as hostPlugin from '../src/index.ts'
import { createButlerSessionOpener, wireDshSessions } from '../src/index.ts'

/**
 * 接线的 C1 护栏(2026-09-09)。
 *
 * 实测教训(docs/superpowers/research/2026-09-09-DSH会话投影可读性.md 第二节):
 * - 裸取 `ctx.sessionProjections` 会让 DSH **整棵插件树启动失败**;
 * - 模块级 `export const inject = ['sessionProjections']` 会让注册表缺席时
 *   **整个插件被挂起**——那意味着工作台的 8791 服务也不起,直接违反架构约束 C1
 *   (「Agent 层挂掉时看板必须继续显示」)。
 *
 * 所以这份用例钉死两件事:host 半区**没有**模块级 inject,以及注册表缺席/异常时
 * 接线安静地退场、其余部分照常。谁把它改回模块级 inject,这里就会红。
 */
describe('DSH 会话接线的 C1 护栏', () => {
  it('★host 半区不得有模块级 inject(有了就会在注册表缺席时挂起整个插件)', () => {
    expect((hostPlugin as Record<string, unknown>).inject).toBeUndefined()
  })

  it('★注册表一直不来时:事件照订,接线不抛,插件其余部分照常往下走', () => {
    const on = vi.fn()
    // cordis 的 inject:依赖没凑齐就永远不回调(这正是模块级 inject 会挂起整个插件的原因)。
    const inject = vi.fn()

    expect(() => wireDshSessions({ on, inject }, { applyEvent: vi.fn(), setMetrics: vi.fn() })).not.toThrow()
    expect(on.mock.calls.map(call => call[0])).toEqual(['session/created', 'session/event', 'session/disposed'])
    expect(inject).toHaveBeenCalledWith(['sessionProjections', 'sessions'], expect.any(Function))
  })

  it('★inject 本身抛出(老版 DSH 没有这个服务名)也只是数字留空,不带走接线', () => {
    const on = vi.fn()
    const inject = vi.fn(() => { throw new Error('unknown service') })
    expect(() => wireDshSessions({ on, inject }, { applyEvent: vi.fn(), setMetrics: vi.fn() })).not.toThrow()
    expect(on).toHaveBeenCalledTimes(3)
  })

  it('★接上了要把 feed 交回去(2026-09-25:以前漏了 return,/butler/item/:id/turns 永远 404、上限读不到用量)', () => {
    const handlers = new Map<string, (...args: unknown[]) => void>()
    const on = vi.fn((event: string, fn: (...args: never[]) => void) => { handlers.set(event, fn as unknown as (...args: unknown[]) => void) })
    const feed = wireDshSessions({ on, inject: vi.fn() }, { applyEvent: vi.fn(), setMetrics: vi.fn() })
    expect(feed).toBeDefined()
    handlers.get('session/event')?.({ id: 's-1' }, { type: 'turn/start' })
    handlers.get('session/event')?.({ id: 's-1' }, { type: 'step/start' })
    expect(feed?.usage('s-1')).toMatchObject({ steps: 1, running: true })
    expect(feed?.turns('s-1', 5)).toEqual([])
  })

  it('没有 ctx(老版 DSH / 本地跑测试)时整块跳过', () => {
    expect(() => wireDshSessions(undefined, { applyEvent: vi.fn(), setMetrics: vi.fn() })).not.toThrow()
  })

  it('★接上之后把 feed 交回来:事项里「她说了什么」读得到(2026-09-25 卡 M:09-15 漏了 return,生产上 /turns 一直 404)', () => {
    const handlers: Record<string, (...args: unknown[]) => void> = {}
    const on = vi.fn((event: string, fn: (...args: unknown[]) => void) => { handlers[event] = fn })
    const feed = wireDshSessions({ on: on as never, inject: vi.fn() }, { applyEvent: vi.fn(), setMetrics: vi.fn() })
    expect(feed).toBeDefined()
    handlers['session/created']?.({ id: 's1', header: { cwd: '/w' } })
    handlers['session/event']?.({ id: 's1' }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '我先跟你对一遍。' }] } } })
    expect(feed?.turns('s1', 20)).toEqual([expect.objectContaining({ role: 'assistant', text: '我先跟你对一遍。' })])
  })

  it('★注册表来了之后订阅变化,一条真实投影推到 setMetrics', () => {
    const listeners: ((session: { id: string }, key: string, value: unknown) => void)[] = []
    const injected = { sessionProjections: { onChanged: (fn: never) => { listeners.push(fn); return () => {} } } }
    const inject = vi.fn((_services: readonly string[], cb: (ctx: never) => void) => { cb(injected as never) })
    const setMetrics = vi.fn()

    wireDshSessions({ on: vi.fn(), inject }, { applyEvent: vi.fn(), setMetrics })
    listeners[0]?.({ id: 's1' }, 'tokenUsage', {
      uncachedInputTokens: 8651, outputTokens: 300, cacheReadTokens: 25472, cacheWriteTokens: 0,
    })

    expect(setMetrics).toHaveBeenCalledWith('s1', { cache_hit_pct: 75 })
  })
})

/**
 * 事务官会话通道(2026-09-10 事项收件箱)。同一条 C1 纪律:拿不到服务不是错误,
 * 是**如实降级**——建事项那条路会照常建卡、回一句「会话未开」。
 */
describe('createButlerSessionOpener:开一条会话并发出第一条消息', () => {
  /** 一个假的 sessionController,记下收到的两次调用。 */
  function fakeController(over: Record<string, unknown> = {}) {
    const calls: { create: unknown[], prompt: unknown[] } = { create: [], prompt: [] }
    const controller = {
      create: async (request: unknown) => { calls.create.push(request); return { sessionId: 'sess-新' } },
      prompt: async (request: unknown) => { calls.prompt.push(request) },
      ...over,
    }
    const inject = vi.fn((_services: readonly string[], cb: (ctx: never) => void) => {
      cb({ sessionController: controller } as never)
    })
    return { calls, inject }
  }

  it('开会话 → 拿到 id → 把第一条 user 文本 queue 进去', async () => {
    const { calls, inject } = fakeController()
    const opener = createButlerSessionOpener({ on: vi.fn(), inject })

    expect(await opener?.open('把展示台的黄历接上')).toBe('sess-新')
    expect(calls.prompt).toEqual([expect.objectContaining({
      sessionId: 'sess-新',
      mode: 'queue',
      content: [{ type: 'text', text: '把展示台的黄历接上' }],
    })])
  })

  it('★prompt 抛了(实测最常见的一种:模型路由不可用)→ 返回 undefined,不给一条没人说话的空会话', async () => {
    const { inject } = fakeController({ prompt: async () => { throw new Error('session/model-unavailable') } })
    const opener = createButlerSessionOpener({ on: vi.fn(), inject })
    expect(await opener?.open('记一笔')).toBeUndefined()
  })

  it('★注册表一直不来(cordis 的 inject 永不回调)→ open 返回 undefined,不抛', async () => {
    const opener = createButlerSessionOpener({ on: vi.fn(), inject: vi.fn() })
    expect(await opener?.open('记一笔')).toBeUndefined()
  })

  it('★inject 本身抛出(这一版 DSH 没有 sessionController)→ 整块不接,返回 undefined', () => {
    const inject = vi.fn(() => { throw new Error('unknown service') })
    expect(createButlerSessionOpener({ on: vi.fn(), inject })).toBeUndefined()
  })

  it('没有 ctx(本地跑测试)时整块跳过', () => {
    expect(createButlerSessionOpener(undefined)).toBeUndefined()
  })
})


it('恢复会话与晚注入从既有modelSelection快照读next，旧服务缺席可降级', () => {
  const handlers = new Map<string, (...args: any[]) => void>()
  const existing = { id: 'existing' }, restored = { id: 'restored' }
  const next = { provider: 'deepseek-official', model: 'deepseek-v4-pro' }
  const snapshot = vi.fn(() => ({ values: { modelSelection: { lastUsed: { provider: 'deepseek-official', model: 'deepseek-flash' }, next } } }))
  const feed = wireDshSessions({
    on: ((name: string, fn: (...args: any[]) => void) => handlers.set(name, fn)) as never,
    inject: ((_names: string[], cb: (ctx: any) => void) => cb({ sessions: { list: () => [existing] }, sessionProjections: { onChanged: () => {}, snapshot } })) as never,
  }, { applyEvent: vi.fn(), setMetrics: vi.fn() })!
  expect(feed.selectionOf('existing')).toEqual(next)
  handlers.get('session/created')!(restored)
  expect(feed.selectionOf('restored')).toEqual(next)
  expect(snapshot).toHaveBeenCalledWith(existing, ['modelSelection'])
  expect(snapshot).toHaveBeenCalledWith(restored, ['modelSelection'])
})

/**
 * 同事项四意图的通道侧(2026-10-26,卡「事务官机制A」):
 * `say` 带 `{mode:'steer'}` 时原样递 `mode:'steer'`(打断正在跑的轮次,改方向 / 加速用),
 * 缺省仍是 'queue'(旧调用逐字不变);`running()` 如实报这条会话在不在跑,供回执说「打断 / 没在跑」。
 */
describe('createButlerSessionOpener:steer 与 running(同事项四意图)', () => {
  function fakeController(over: Record<string, unknown> = {}) {
    const calls: { create: unknown[], prompt: unknown[], cancel: unknown[] } = { create: [], prompt: [], cancel: [] }
    const controller = {
      create: async (request: unknown) => { calls.create.push(request); return { sessionId: 'sess-新' } },
      prompt: async (request: unknown) => { calls.prompt.push(request) },
      cancel: (request: unknown) => { calls.cancel.push(request) },
      selectModel: async (request: unknown) => { calls.create.push(['selectModel', request]); return {} },
      ...over,
    }
    const agents = { get: vi.fn((id: string) => ({ id, status: 'running' })) }
    const inject = vi.fn((_services: readonly string[], cb: (ctx: never) => void) => {
      cb({ sessionController: controller, agents } as never)
    })
    return { calls, inject, agents }
  }

  it('say 缺省 queue(与卡 A 之前逐字一致)', async () => {
    const { calls, inject } = fakeController()
    const opener = createButlerSessionOpener({ on: vi.fn(), inject })
    expect(await opener?.say?.('sess-1', '顺便补一句')).toBe(true)
    expect(calls.prompt).toEqual([expect.objectContaining({ sessionId: 'sess-1', mode: 'queue' })])
  })

  it('say 带 {mode:\'steer\'} → prompt 收到 steer(改方向 / 加速打断在跑的轮次)', async () => {
    const { calls, inject } = fakeController()
    const opener = createButlerSessionOpener({ on: vi.fn(), inject })
    expect(await opener?.say?.('sess-1', '改方向:别走那条路', undefined, { mode: 'steer' })).toBe(true)
    expect(calls.prompt).toEqual([expect.objectContaining({ sessionId: 'sess-1', mode: 'steer' })])
  })

  it('steer 之前照样做模型对齐(alignDeps 缺席不挡,与 queue 同契约)', async () => {
    const { calls, inject } = fakeController()
    const opener = createButlerSessionOpener({ on: vi.fn(), inject }, () => undefined, {
      target: async () => ({ provider: 'p', model: 'm' }),
      selectionOf: () => undefined,
      catalogDefault: async () => undefined,
    })
    expect(await opener?.say?.('sess-1', '催一下', undefined, { mode: 'steer' })).toBe(true)
    expect(calls.prompt).toEqual([expect.objectContaining({ mode: 'steer' })])
  })

  it('running() 读 Agent.status;读不出来回 undefined(不编)', async () => {
    const { inject, agents } = fakeController()
    const opener = createButlerSessionOpener({ on: vi.fn(), inject })
    expect(opener?.running?.('sess-1')).toBe(true)
    agents.get.mockReturnValueOnce({ id: 'sess-2', status: 'idle' })
    expect(opener?.running?.('sess-2')).toBe(false)
    agents.get.mockReturnValueOnce(undefined as never)
    expect(opener?.running?.('sess-nope')).toBeUndefined()
  })
})
