// @vitest-environment node
/**
 * 「这一次对应它的哪一轮」从送那一刻一路带到读回话(2026-10-03,审计第二节「共同根因」:
 * 缺少贯穿发送、存盘、读取和完成的「本次任务对应哪个会话、哪一轮」的证据)。
 *
 * 10-03 上午那张卡把 Codex `read` 改成「只认最后一轮」,够治「旧轮答案提前回电」,但认了一条边界:
 * 她自己又在那条线程里发了一句,最后一轮是她那句、不是我们这件。现在送那一刻对端报的轮号
 * (`JobResult.turnId`)记在卡上(`client_dispatch.turn_id`)/ 账上(`RelayWait.turn_id`),巡检读的时候
 * 原样带回去(`Job.turnId`),协议型**按号找那一轮**;没报过号(老账 / 窗口型)才认最后一轮。
 *
 * 对端是内存里的假连接;看板是临时目录里的真 tasks.json;一个真进程都不起。
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Job } from '../src/server/engine/adapter.ts'
import { CODEX_TURN_NOT_FOUND_WHY, codexAdapter } from '../src/server/engine/adapters/codex.ts'
import { createRegistry } from '../src/server/engine/registry.ts'
import { createEngine } from '../src/server/engine/engine.ts'
import { createActionGate } from '../src/server/actionGate.ts'
import { createJobLog } from '../src/server/jobLog.ts'
import { createClientDispatch } from '../src/server/dispatchSend.ts'
import { relayIntoNewConversation } from '../src/server/relayNewConversation.ts'
import { createEngineRelayReader, createRelayWatchService, type RelayReader, type RelayWait } from '../src/server/relayWatch.ts'
import { createDispatchRunner } from '../src/server/dispatchRun.ts'
import { createTasksService } from '../src/server/tasks.ts'

const THREAD = 'thread-1'
interface FakeTurn { id: string, status: string, items: { type: string, phase?: string, text: string }[] }
const say = (text: string, phase?: string) => ({ type: 'agentMessage', text, ...(phase === undefined ? {} : { phase }) })

function fakeCodex(initial: FakeTurn[], startedTurn = 'our-turn') {
  const methods: { method: string, params: Record<string, unknown> }[] = []
  let turns: FakeTurn[] = initial
  let listed: { turnId: string, item: Record<string, unknown> }[] = []
  const connection = {
    request: async (method: string, params: Record<string, unknown>) => {
      methods.push({ method, params })
      if (method === 'thread/start') return { thread: { id: 'fresh-thread' } }
      if (method === 'turn/start') return { turn: { id: startedTurn, status: 'inProgress' } }
      if (method === 'thread/resume') return { thread: { id: params.threadId, turns } }
      if (method === 'thread/items/list') return { data: listed }
      return {}
    },
    watch: () => () => {},
    onGone: () => () => {},
  }
  const adapter = codexAdapter({ link: { open: async () => connection as never, close() {} }, binary: () => '/fake/codex', warn() {} })
  return { adapter, methods, setTurns: (next: FakeTurn[]) => { turns = next }, setListed: (next: typeof listed) => { listed = next } }
}

const readJob = (over: Partial<Job> = {}): Job => ({
  id: 'relay:w-1', family: 'codex', kind: 'relay', target: { kind: 'session', sessionId: THREAD }, text: '', marks: ['请继续'], expect: 'reply', ...over,
})

describe('送那一刻:Codex 报的轮号进 JobResult', () => {
  it('★expect:ack → turnId = turn/start 回包里那一轮的 id', async () => {
    const fake = fakeCodex([{ id: 'old', status: 'completed', items: [] }])
    const out = await fake.adapter.run({ id: 'J', family: 'codex', kind: 'relay', target: { kind: 'session', sessionId: THREAD }, text: '请继续', expect: 'ack' })
    expect(out).toMatchObject({ delivered: 'confirmed', sessionId: THREAD, turnId: 'our-turn' })
  })
  it('expect:none 也带(回包里学到的)', async () => {
    const fake = fakeCodex([{ id: 'old', status: 'completed', items: [] }])
    const out = await fake.adapter.run({ id: 'J', family: 'codex', kind: 'relay', target: { kind: 'session', sessionId: THREAD }, text: '请继续', expect: 'none' })
    expect(out.turnId).toBe('our-turn')
  })
})

describe('读回话:报过号就只认那一轮', () => {
  const ours = { id: 'our-turn', status: 'completed', items: [say('我们这件的结论', 'final_answer')] }
  const hersRunning = { id: 'her-turn', status: 'inProgress', items: [say('她那句还在跑', 'commentary')] }
  const hersDone = { id: 'her-turn', status: 'completed', items: [say('她那句的答案', 'final_answer')] }

  it('★我们那一轮完了、她后来那一轮还在跑 → 认我们的,不 busy(10-03 上午「只认最后一轮」会把这一条判成 busy)', async () => {
    const fake = fakeCodex([ours, hersRunning])
    expect(await fake.adapter.read?.(readJob({ turnId: 'our-turn' }))).toEqual({ reply: '我们这件的结论', evidence: 'transcript', via: 'protocol' })
    // 对照:没报号 → 最后一轮是她那句 → busy。
    expect((await fake.adapter.read?.(readJob()))?.busy).toBe(true)
  })

  it('★我们那一轮还在跑、她后来那一轮完了 → busy,不拿她的答案顶', async () => {
    const fake = fakeCodex([{ ...ours, status: 'inProgress' }, hersDone])
    const seen = await fake.adapter.read?.(readJob({ turnId: 'our-turn' }))
    expect(seen?.busy).toBe(true)
    expect(seen?.reply).toBeUndefined()
  })

  it('报了号、线程里找不到那一轮 → 读不到、说清楚,不拿别的轮次顶', async () => {
    const fake = fakeCodex([hersDone])
    const seen = await fake.adapter.read?.(readJob({ turnId: 'our-turn' }))
    expect(seen).toMatchObject({ via: 'protocol', evidence: 'none', why: CODEX_TURN_NOT_FOUND_WHY })
  })

  it('分页老对话(resume 没带 turns):items/list 里按号挑', async () => {
    const fake = fakeCodex([])
    fake.setListed([
      { turnId: 'her-turn', item: say('她那句的答案', 'final_answer') },
      { turnId: 'our-turn', item: say('我们这件的结论', 'final_answer') },
    ])
    expect((await fake.adapter.read?.(readJob({ turnId: 'our-turn' })))?.reply).toBe('我们这件的结论')
    expect((await fake.adapter.read?.(readJob({ turnId: 'nobody' })))?.why).toBe(CODEX_TURN_NOT_FOUND_WHY)
  })
})

describe('★串起来:送 → 卡 / 账记轮号 → 巡检按号读', () => {
  const dirs: string[] = []
  afterEach(async () => { while (dirs.length) await rm(dirs.pop() as string, { recursive: true, force: true }) })

  function rig(initial: FakeTurn[]) {
    let nowMs = Date.parse('2026-10-03T06:00:00.000Z')
    const fake = fakeCodex(initial)
    const registry = createRegistry({ now: () => new Date(nowMs) })
    registry.register(fake.adapter)
    const engine = createEngine({ registry, gate: createActionGate({ phaseOf: () => 'open', now: () => new Date(nowMs) }), log: createJobLog(), warn() {} })
    const client = createClientDispatch({ engine, sessionIdsOf: () => [], now: () => new Date(nowMs), targets: () => [{ id: 'codex', title: 'Codex', bundle_id: 'com.openai.codex' } as never] })
    return { fake, engine, client, now: () => nowMs, tick: (ms: number) => { nowMs += ms } }
  }

  it('送话结果与新开捎话的登记都带上轮号', async () => {
    const r = rig([])
    const sent = await r.client.send({ family: 'codex', text: '请总结本周工作', newConversation: true, submit: true })
    expect(sent.dispatch).toMatchObject({ session_id: 'fresh-thread', turn_id: 'our-turn' })

    let remembered: Record<string, unknown> | undefined
    await relayIntoNewConversation({
      send: r.client.send,
      newId: () => 'local',
      watch: { remember: async (input) => { remembered = input; return { id: 'w', ...input, at: new Date(r.now()).toISOString(), state: 'waiting' } as RelayWait } },
      /*
       * ★ 2026-10-04(卡 `claude/relay-nocall-noread`):`callOnReply: true` —— 回电是**她明说了才有**,
       * 没明说的那一句**压根不登记**(不盯、不读)。这一条钉的是「登记那一条带不带轮号」,
       * 所以它走的是明说了的那一路。
       */
    }, { family: 'codex', title: 'Codex', text: '请总结本周工作', from: 'call', callOnReply: true })
    expect(remembered).toMatchObject({ session_id: 'fresh-thread', turn_id: 'our-turn' })
  })

  it('★账上记了轮号 → 落盘再读回来还在 → 巡检把它交给引擎 → 她后来那一轮在跑也照样收到我们这件的答案并回电', async () => {
    const r = rig([
      { id: 'our-turn', status: 'completed', items: [say('我们这件的结论', 'final_answer')] },
      { id: 'her-turn', status: 'inProgress', items: [say('她那句还在跑', 'commentary')] },
    ])
    const dir = await mkdtemp(join(tmpdir(), 'wb-turn-id-'))
    dirs.push(dir)
    const file = join(dir, 'relay.json')
    const seen: Record<string, unknown>[] = []
    const inner = createEngineRelayReader({ engine: r.engine })
    const reader: RelayReader = { read: async (req) => { seen.push(req); return await inner.read(req) } }
    const calls: string[] = []
    const first = createRelayWatchService({ file, reader, now: () => r.now(), newId: () => 'w-1', callOut: { request: async (input) => { calls.push(input.item_id); return { ok: true, entry: { id: 'c' } } } } })
    await first.load()
    await first.remember({ agent: 'codex', session_id: THREAD, title: '已有会话', mark: '请继续', from: 'call', turn_id: 'our-turn' })
    expect(first.list()[0]?.turn_id).toBe('our-turn')

    // 换一个服务实例从盘上读回来(工作台重启那一下)。
    const second = createRelayWatchService({ file, reader, now: () => r.now(), newId: () => 'w-2', callOut: { request: async (input) => { calls.push(input.item_id); return { ok: true, entry: { id: 'c' } } } } })
    await second.load()
    expect(second.list()[0]?.turn_id).toBe('our-turn')

    for (let i = 0; i < 2; i += 1) { await second.pump(); r.tick(9_000) }
    expect(seen.every(one => one.turnId === 'our-turn')).toBe(true)
    expect(calls).toHaveLength(1)
    expect(second.list()[0]?.reply).toBe('我们这件的结论')
  })
})

describe('正式派活的盯窗也按号读', () => {
  const dirs: string[] = []
  afterEach(() => { while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true }) })

  it('★卡上记着 turn_id → engine.read 的 Job 带 turnId', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-dispatch-turn-'))
    dirs.push(dir)
    let clock = Date.parse('2026-10-03T06:00:00Z')
    let n = 0
    const tasks = createTasksService({ file: join(dir, 'tasks.json'), now: () => Math.floor(clock / 1000), newId: () => `t-00000${++n}` })
    const created = await tasks.create({ title: '[派活] 一件事', direction: 'mine', status: 'todo' })
    const id = created.id as string
    await tasks.update(id, {
      clientDispatch: {
        hand: 'window', family: 'codex', status: 'sent', at: new Date(clock).toISOString(), text: '【工作台派活 000001】一件事',
        marker: '工作台派活 000001', reply_state: 'waiting', session_id: THREAD, turn_id: 'our-turn', seen_at: new Date(clock).toISOString(),
      },
      assignee: 'codex',
    })
    await tasks.move(id, 'doing')
    const jobs: Job[] = []
    const runner = createDispatchRunner({
      tasks,
      engine: { read: async (job) => { jobs.push(job); return { via: 'protocol', evidence: 'none', busy: true } } },
      readFile: async () => undefined,
      sessions: () => [{ agent: 'codex', session_id: THREAD, status: 'running' }],
      now: () => new Date(clock),
      setTimer: () => 'timer',
      clearTimer: () => {},
      notSeenMs: 60_000,
      replyTimeoutMs: 600_000,
    })
    clock += 5_000
    await runner.tick()
    expect(jobs.length).toBeGreaterThanOrEqual(1)
    expect(jobs[0]).toMatchObject({ kind: 'dispatch', target: { kind: 'session', sessionId: THREAD }, turnId: 'our-turn' })
  })
})
