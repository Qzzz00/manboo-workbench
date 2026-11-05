// @vitest-environment node
/**
 * createButlerSessionOpener 的队列清口(2026-10-26,机制卡A;统筹验收打回两条后修复,场景取自
 * 同树另一会话留下的红用例与验收缺陷,端口形状按修复定案):
 *
 *   - `clearQueued(sessionId, taskId)`:**只清这条事项自己的**挂起句 —— say 递话时把事项 id
 *     嵌进 requestId(`workbench-<taskId>-<uuid>`, persisted 为 source.rpcId),清队列按它精确认,
 *     不靠任何前缀猜;同会话里**别的事项的句子和没有事项号的旧句(legacy)一律保留**;
 *   - 返回**分片真结果** `{removed, remaining, incomplete}`:removed=真摘掉且原文留存(一句不丢),
 *     remaining=想摘没摘成的(中途 remove 抛错),incomplete=true;调用方据 incomplete 拒发
 *     stale-queue,但回执必须照实说摘掉了几句、几句没动;
 *   - 投影 / 会话表 / updateQueue 缺席 → undefined(=整条能力没有,调用方拒发);
 *   - 队列里没有这条事项的句 → `{removed:[],remaining:[],incomplete:false}`,不出错。
 *
 * ★ 通道是**模拟宿主**:这些用例钉的是本插件对 DSH 接口的用法与形状,不证明真 DSH 进程
 * 内的投影真值 —— 真机集成仍待维护者环境(见交接)。
 */
import { describe, expect, it } from 'vitest'
import { createButlerSessionOpener } from '../src/index.ts'

interface PendingMessage { id: string, source: { rpcId: string }, content: { type: 'text', text: string }[] }

function pending(id: string, rpcId: string, text: string): PendingMessage {
  return { id, source: { rpcId }, content: [{ type: 'text', text }] }
}

function fixture(over: { withProjections?: boolean, withUpdateQueue?: boolean, failOn?: (itemId: string) => boolean } = {}) {
  const removals: { sessionId: string, itemId: string }[] = []
  const inbox: { 'next-turn': PendingMessage[], 'next-step': PendingMessage[] } = {
    'next-turn': [
      pending('m-tA-1', 'workbench-t-aaaa-111', 'A 的旧话一:先按 A 方案'),
      pending('m-tB-1', 'workbench-t-bbbb-222', 'B 的旧话:别动它'),
      pending('m-legacy-1', 'workbench-333', '旧格式(workbench-uuid):没有事项号,保留'),
      pending('m-ui-1', 'ui-hand-1', 'DSH 页面上手敲的,不动'),
    ],
    'next-step': [
      pending('m-tA-2', 'workbench-t-aaaa-444', 'A 的旧话二:把 B 也带上'),
    ],
  }
  const withProjections = over.withProjections !== false
  const withUpdateQueue = over.withUpdateQueue !== false
  const ctx = {
    on: () => undefined,
    inject: (names: readonly string[], callback: (ctx: never) => void) => {
      if (names[0] === 'sessionController') {
        const controller: Record<string, unknown> = {
          create: async () => ({ sessionId: 'qa-new' }),
          prompt: async () => undefined,
        }
        if (withUpdateQueue) {
          controller.updateQueue = async (request: { sessionId: string, itemId: string }) => {
            if (over.failOn?.(request.itemId)) throw new Error('queue locked')
            removals.push({ sessionId: request.sessionId, itemId: request.itemId })
            // 真 DSH 那一侧会把这条从队列里摘掉:假手同步自己的投影,让用例看得见「旧队列不复活」。
            for (const column of ['next-turn', 'next-step'] as const) {
              const index = inbox[column].findIndex(one => one.id === request.itemId)
              if (index >= 0) inbox[column].splice(index, 1)
            }
          }
        }
        callback({ sessionController: controller } as never)
      }
      if (withProjections && names[0] === 'sessionProjections') {
        callback({ sessionProjections: { snapshot: () => ({ values: { inbox } }) }, sessions: { list: () => [{ id: 'qa-session' }] } } as never)
      }
    },
  } as never
  const opener = createButlerSessionOpener(ctx, () => undefined, undefined)!
  return { removals, inbox, opener }
}

describe('clearQueued:事项级归属 —— 只清这条事项自己的,别的事和旧句一律保留', () => {
  it('★A 的改方向:只摘 A 的两条(next-turn + next-step),返回原文;B / legacy / 手敲的全留着', async () => {
    const f = fixture()
    const result = await f.opener.clearQueued!('qa-session', 't-aaaa', async () => true)
    expect(result).toMatchObject({ incomplete: false })
    expect(result?.removed).toEqual(['A 的旧话一:先按 A 方案', 'A 的旧话二:把 B 也带上'])
    expect(result?.remaining).toEqual([])
    expect(f.removals.map(one => one.itemId).sort()).toEqual(['m-tA-1', 'm-tA-2'])
    expect(f.inbox['next-turn'].map(one => one.id)).toEqual(['m-tB-1', 'm-legacy-1', 'm-ui-1'])
    expect(f.inbox['next-step'].map(one => one.id)).toEqual([])
  })

  it('★B 随后改方向:B 的那条还在、摘得动(证明 A 的清没误伤 B)', async () => {
    const f = fixture()
    await f.opener.clearQueued!('qa-session', 't-aaaa', async () => true)
    const result = await f.opener.clearQueued!('qa-session', 't-bbbb', async () => true)
    expect(result?.removed).toEqual(['B 的旧话:别动它'])
    expect(f.inbox['next-turn'].map(one => one.id)).toEqual(['m-legacy-1', 'm-ui-1'])
  })

  it('★队列里没有这条事项的句 → 空结果、不报错、谁都没动(legacy 也在)', async () => {
    const f = fixture()
    const result = await f.opener.clearQueued!('qa-session', 't-zzzz', async () => true)
    expect(result).toEqual({ removed: [], remaining: [], incomplete: false })
    expect(f.removals).toEqual([])
    expect(f.inbox['next-turn']).toHaveLength(4)
  })

  it('★会话 id 认不出来 → undefined(读不清,不编空结果)', async () => {
    const f = fixture()
    expect(await f.opener.clearQueued!('qa-nope', 't-aaaa', async () => true)).toBeUndefined()
  })
})

describe('clearQueued:先留证、后动手 —— 证据写不进就一条不摘(验收二轮)', () => {
  it('★证据回调回 false → refused:removed 为空、remaining 保住全部原文,队列一条没动', async () => {
    const f = fixture()
    const result = await f.opener.clearQueued!('qa-session', 't-aaaa', async () => false)
    expect(result).toMatchObject({ removed: [], incomplete: false, refused: 'evidence' })
    expect(result?.remaining).toEqual(['A 的旧话一:先按 A 方案', 'A 的旧话二:把 B 也带上'])
    expect(f.removals).toEqual([])
    expect(f.inbox['next-turn'].map(one => one.id)).toEqual(['m-tA-1', 'm-tB-1', 'm-legacy-1', 'm-ui-1'])
  })

  it('★证据回调抛错 → 同样 refused,不静默当成功', async () => {
    const f = fixture()
    const result = await f.opener.clearQueued!('qa-session', 't-aaaa', async () => { throw new Error('card store down') })
    expect(result).toMatchObject({ refused: 'evidence' })
    expect(f.removals).toEqual([])
  })

  it('★没有要摘的句 → 不调证据回调,空干净结果', async () => {
    const f = fixture()
    let called = 0
    const result = await f.opener.clearQueued!('qa-session', 't-zzzz', async () => { called += 1; return true })
    expect(result).toEqual({ removed: [], remaining: [], incomplete: false })
    expect(called).toBe(0)
  })

  it('★证据回调先于任何 updateQueue 调用(先留证后动手,顺序钉死)', async () => {
    const f = fixture()
    const order: string[] = []
    const result = await f.opener.clearQueued!('qa-session', 't-aaaa', async () => { order.push('evidence'); return true })
    expect(result?.incomplete).toBe(false)
    expect(order).toEqual(['evidence'])
    expect(f.removals.length).toBeGreaterThan(0)
  })
})

describe('clearQueued:部分失败 —— 原文证据不丢,进度照实', () => {
  it('★摘到一半 remove 抛错 → removed 留住已摘原文,remaining 留住没摘动的,incomplete=true', async () => {
    const f = fixture({ failOn: itemId => itemId === 'm-tA-2' })
    const result = await f.opener.clearQueued!('qa-session', 't-aaaa', async () => true)
    expect(result).toMatchObject({ incomplete: true })
    expect(result?.removed).toEqual(['A 的旧话一:先按 A 方案'])
    expect(result?.remaining).toEqual(['A 的旧话二:把 B 也带上'])
    expect(f.inbox['next-turn'].map(one => one.id)).toEqual(['m-tB-1', 'm-legacy-1', 'm-ui-1'])
    // 没摘动的那条还在队列里(下次重试还认得它)。
    expect(f.inbox['next-step'].map(one => one.id)).toEqual(['m-tA-2'])
  })

  it('★部分失败后可安全重试:再去一次只摘剩下的那条(已摘的不再出现)', async () => {
    let fail = true
    const f = fixture({ failOn: itemId => fail && itemId === 'm-tA-2' })
    const first = await f.opener.clearQueued!('qa-session', 't-aaaa', async () => true)
    expect(first?.incomplete).toBe(true)
    fail = false
    const second = await f.opener.clearQueued!('qa-session', 't-aaaa', async () => true)
    expect(second).toMatchObject({ incomplete: false, removed: ['A 的旧话二:把 B 也带上'], remaining: [] })
    expect(f.inbox['next-step'].map(one => one.id)).toEqual([])
    expect(f.inbox['next-turn'].map(one => one.id)).toEqual(['m-tB-1', 'm-legacy-1', 'm-ui-1'])
  })
})

describe('clearQueued:能力缺席 → undefined(整条能力没有,与部分失败分开)', () => {
  it('★这一版宿主没有 updateQueue → undefined,队列一条不动', async () => {
    const f = fixture({ withUpdateQueue: false })
    expect(await f.opener.clearQueued!('qa-session', 't-aaaa', async () => true)).toBeUndefined()
    expect(f.inbox['next-turn']).toHaveLength(4)
    expect(f.inbox['next-step']).toHaveLength(1)
  })

  it('★读不到 inbox 投影 / 会话表 → undefined', async () => {
    const f = fixture({ withProjections: false })
    expect(await f.opener.clearQueued!('qa-session', 't-aaaa', async () => true)).toBeUndefined()
  })
})

describe('say 的 mode / taskId 与 running(编排在上层,这里钉通道形状)', () => {
  function promptFixture(agentStatus: 'running' | 'idle') {
    const prompts: { mode: string, sessionId: string, requestId: string }[] = []
    const ctx = {
      on: () => undefined,
      inject: (names: readonly string[], callback: (ctx: never) => void) => {
        if (names[0] === 'sessionController') {
          callback({
            sessionController: {
              create: async () => ({ sessionId: 'qa-new' }),
              prompt: async (request: { mode: string, sessionId: string, requestId: string }) => {
                prompts.push({ mode: request.mode, sessionId: request.sessionId, requestId: request.requestId })
              },
            },
          } as never)
        }
        if (names.includes('agents')) callback({ agents: { get: () => ({ status: agentStatus }) } } as never)
      },
    } as never
    return { prompts, opener: createButlerSessionOpener(ctx, () => undefined, undefined)! }
  }

  it('★带 taskId 的 say → requestId 嵌 `workbench-<taskId>-`(清队列靠它精确认);不带 → 旧格式', async () => {
    const f = promptFixture('running')
    expect(await f.opener.say!('qa-session', 'A 的补话', undefined, { mode: 'queue', taskId: 't-aaaa' })).toBe(true)
    expect(await f.opener.say!('qa-session', '旧调用补话')).toBe(true)
    expect(f.prompts[0]?.requestId).toMatch(/^workbench-t-aaaa-/)
    expect(f.prompts[1]?.requestId).toMatch(/^workbench-[0-9a-f-]{36}$/)
  })

  it('{mode:\'steer\'} 原样递 steer;缺省 queue(旧调用逐字不变)', async () => {
    const f = promptFixture('running')
    expect(await f.opener.say!('qa-session', '改方向', undefined, { mode: 'steer' })).toBe(true)
    expect(await f.opener.say!('qa-session', '补一句')).toBe(true)
    expect(f.prompts.map(one => one.mode)).toEqual(['steer', 'queue'])
  })

  it('running() 读 Agent.status;读不出来回 undefined(不编)', async () => {
    const running = promptFixture('running')
    expect(running.opener.running!('qa-session')).toBe(true)
    const idle = promptFixture('idle')
    expect(idle.opener.running!('qa-session')).toBe(false)
    const noAgents = {
      on: () => undefined,
      inject: (names: readonly string[], callback: (ctx: never) => void) => {
        if (names[0] === 'sessionController') callback({ sessionController: { create: async () => ({ sessionId: 'x' }), prompt: async () => undefined } } as never)
      },
    } as never
    const opener = createButlerSessionOpener(noAgents, () => undefined, undefined)!
    expect(opener.running!('qa-session')).toBeUndefined()
  })
})

