// @vitest-environment node
/**
 * 电话里「新开一条发给 Codex」:对端自己报了新线程的号,回电账就得记那个号(2026-10-03,审计第二节第 1 条)。
 *
 * 10-03 之前 `relayIntoNewConversation` 不管送话那一层回了什么,一律登记本地占位号 + `session_placeholder:true`;
 * 巡检把占位翻成 `target:{kind:'current'}`,而协议那条路认不出「此刻开着的那条」—— Codex 已经答完了,
 * 回电却只剩 20 分钟后的超时通知。`dispatchSend` 早就把协议回的 threadId 存进 `dispatch.session_id`
 * (2026-10-02 真机查出来的那一条),差的只是这一层没读它。
 *
 * 这一份两截:
 * - **单元**:送话结果带 `dispatch.session_id` → 登记用真号、不带占位;不带 / 空白 → 照旧占位(窗口型那几家的老行为一字不变);
 * - **串起来**:真 Codex 适配器(假对端)→ 真引擎 → 真 `createClientDispatch` → `relayIntoNewConversation` → 真 `EngineRelayReader`:
 *   登记的号 = 对端回的 `real-new-thread`,巡检按它 `thread/resume`,读得到它的回答。
 *   对端是内存 stub,不访问任何真实 Codex。
 */
import { describe, expect, it } from 'vitest'
import type { TaskClientDispatch } from '../src/protocol.ts'
import type { SendToClientInput, SendToClientResult } from '../src/server/dispatchSend.ts'
import { createClientDispatch } from '../src/server/dispatchSend.ts'
import { relayIntoNewConversation } from '../src/server/relayNewConversation.ts'
import { createEngineRelayReader, type RelayWait } from '../src/server/relayWatch.ts'
import { codexAdapter } from '../src/server/engine/adapters/codex.ts'
import { createRegistry } from '../src/server/engine/registry.ts'
import { createEngine } from '../src/server/engine/engine.ts'
import { createActionGate } from '../src/server/actionGate.ts'
import { createJobLog } from '../src/server/jobLog.ts'

const T0 = Date.parse('2026-10-03T03:00:00.000Z')

function sentWith(extra: Partial<TaskClientDispatch> = {}): SendToClientResult {
  const dispatch: TaskClientDispatch = { hand: 'window', family: 'codex', status: 'sent', at: new Date(T0).toISOString(), text: '请总结本周工作', ...extra }
  return { ok: true, dispatch }
}

function unit(result: SendToClientResult) {
  const remembered: Record<string, unknown>[] = []
  const sends: SendToClientInput[] = []
  const run = () => relayIntoNewConversation({
    send: async (input) => { sends.push(input); return result },
    watch: {
      remember: async (input) => {
        remembered.push(input)
        return { id: 'r-1', ...input, at: new Date(T0).toISOString(), state: 'waiting' } as RelayWait
      },
    },
    newId: () => 'local-placeholder',
  /*
   * ★ 2026-10-04(卡 `claude/relay-nocall-noread`):`callOnReply: true` —— 回电是**她明说了才有**,
   * 没明说的那一句压根不登记(不盯、不读)。这一份钉的是「登记的那一条记哪个会话号」,
   * 所以它走的是明说了的那一路。
   */
  }, { family: 'codex', title: 'Codex', text: '请总结本周工作', from: 'call', callOnReply: true })
  return { run, remembered, sends }
}

describe('新开一条:对端报了号就记真号', () => {
  it('★送话结果带 dispatch.session_id → 回电账记那个号,不带占位标记', async () => {
    const h = unit(sentWith({ session_id: 'real-new-thread' }))
    const got = await h.run()
    expect(got).toMatchObject({ ok: true, delivered: 'sent', watched: true })
    expect(h.remembered).toHaveLength(1)
    expect(h.remembered[0]).toMatchObject({ agent: 'codex', session_id: 'real-new-thread', title: '新会话', from: 'call' })
    expect(h.remembered[0]).not.toHaveProperty('session_placeholder')
  })

  it('没报号(窗口型那几家)→ 照旧登记本地占位号 + session_placeholder:true(老行为一字不变)', async () => {
    const h = unit(sentWith())
    await h.run()
    expect(h.remembered[0]).toMatchObject({ session_id: 'local-placeholder', session_placeholder: true })
  })

  it('报了个空白的号 → 当没报(不拿一串空格当会话键)', async () => {
    const h = unit(sentWith({ session_id: '   ' }))
    await h.run()
    expect(h.remembered[0]).toMatchObject({ session_id: 'local-placeholder', session_placeholder: true })
  })

  it('按了发送没核上(typed)而对端报了号 → 真号 + unconfirmed 两样都带', async () => {
    const h = unit(sentWith({ status: 'typed', session_id: 'real-new-thread' }))
    const got = await h.run()
    expect(got.delivered).toBe('unconfirmed')
    expect(h.remembered[0]).toMatchObject({ session_id: 'real-new-thread', unconfirmed: true })
    expect(h.remembered[0]).not.toHaveProperty('session_placeholder')
  })
})

describe('★串起来:真 Codex 适配器(假对端)→ 引擎 → 送话 → 登记 → 巡检读得到', () => {
  function rig() {
    let nowMs = T0
    const methods: { method: string, params: Record<string, unknown> }[] = []
    const connection = {
      request: async (method: string, params: Record<string, unknown>) => {
        methods.push({ method, params })
        if (method === 'thread/start') return { thread: { id: 'real-new-thread' } }
        if (method === 'turn/start') return { turn: { id: 'new-turn', status: 'inProgress' } }
        if (method === 'thread/resume') {
          return {
            thread: {
              id: params.threadId,
              turns: [{ id: 'new-turn', status: 'completed', items: [{ type: 'agentMessage', phase: 'final_answer', text: '一周有七天。' }] }],
            },
          }
        }
        return {}
      },
      watch: () => () => {},
      onGone: () => () => {},
    }
    const adapter = codexAdapter({ link: { open: async () => connection as never, close() {} }, binary: () => '/fake/codex', warn() {} })
    const registry = createRegistry({ now: () => new Date(nowMs) })
    registry.register(adapter)
    const engine = createEngine({
      registry,
      gate: createActionGate({ phaseOf: () => 'open', now: () => new Date(nowMs) }),
      log: createJobLog(),
      warn() {},
    })
    const client = createClientDispatch({
      engine,
      sessionIdsOf: () => [],
      now: () => new Date(nowMs),
      targets: () => [{ id: 'codex', title: 'Codex', bundle_id: 'com.openai.codex' } as never],
    })
    const reader = createEngineRelayReader({ engine })
    return { methods, client, reader, tick: (ms: number) => { nowMs += ms } }
  }

  it('★登记的号 = 对端回的 real-new-thread;巡检按它 thread/resume,读到它的回答', async () => {
    const r = rig()
    let remembered: Record<string, unknown> | undefined
    const sent = await relayIntoNewConversation({
      send: r.client.send,
      newId: () => 'local-placeholder',
      watch: { remember: async (input) => { remembered = input; return { id: 'w-1', ...input, at: new Date(T0).toISOString(), state: 'waiting' } as RelayWait } },
    }, { family: 'codex', title: 'Codex', text: '请总结本周工作', from: 'call', callOnReply: true })
    expect(sent).toMatchObject({ ok: true, delivered: 'sent', watched: true })
    expect(remembered).toMatchObject({ agent: 'codex', session_id: 'real-new-thread' })
    expect(remembered).not.toHaveProperty('session_placeholder')

    r.tick(5_000)
    const wait = remembered as unknown as RelayWait
    const read = await r.reader.read({
      agent: wait.agent,
      sessionId: wait.session_id,
      mark: wait.mark,
      ...(wait.session_placeholder === true ? { placeholder: true } : {}),
      waitId: 'w-1',
    })
    expect(read).toMatchObject({ found: true, busy: false, text: '一周有七天。' })
    const resumed = r.methods.filter(one => one.method === 'thread/resume')
    expect(resumed.length).toBeGreaterThanOrEqual(1)
    expect(resumed.at(-1)?.params.threadId).toBe('real-new-thread')
  })
})
