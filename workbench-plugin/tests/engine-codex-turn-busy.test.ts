// @vitest-environment node
/**
 * Codex 协议:读一眼只认**这一轮**,还在跑就说还在跑(2026-10-03,审计第二节第 2 条);
 * `submit:false` 协议做不了「只填不发」→ `unsupported`(审计第二节第 4 条;统筹 10-03 裁定)。
 *
 * 10-03 之前 `read` 把所有 turn 的话平铺、不读 `turn.status`、结果没有 `busy`,`pickCodexReply` 只要历史里有
 * `final_answer` 就取它 —— 已有线程里追加一句新任务、新一轮还在 `inProgress`,巡检两拍读到的都是**上一轮的答案**,
 * 两拍一字不差就当它说完了,回电念的是旧结果。离线反例:`docs/审计材料/2026-10-03/engine-repro.mjs` BUG 2 / BUG 4。
 *
 * 对端是内存里的假连接(`thread/resume` 回一份可改的 turns),不起进程、不读凭据。
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Job } from '../src/server/engine/adapter.ts'
import { codexAdapter } from '../src/server/engine/adapters/codex.ts'
import { createRegistry } from '../src/server/engine/registry.ts'
import { createEngine } from '../src/server/engine/engine.ts'
import { createActionGate } from '../src/server/actionGate.ts'
import { createJobLog } from '../src/server/jobLog.ts'
import { createEngineRelayReader, createRelayWatchService } from '../src/server/relayWatch.ts'

const THREAD = 'existing-thread'

interface FakeTurn { id: string, status: string, items: { type: string, phase?: string, text: string }[] }

/** 一条假连接:`thread/resume` 回这会儿的 turns(可改),别的方法照单记下来。 */
function fakeCodex(initial: FakeTurn[]) {
  const methods: { method: string, params: Record<string, unknown> }[] = []
  let turns: FakeTurn[] = initial
  let listed: { turnId: string, item: Record<string, unknown> }[] | undefined
  const connection = {
    request: async (method: string, params: Record<string, unknown>) => {
      methods.push({ method, params })
      if (method === 'thread/start') return { thread: { id: 'fresh-thread' } }
      if (method === 'turn/start') return { turn: { id: 'started-turn', status: 'inProgress' } }
      if (method === 'thread/resume') return { thread: { id: params.threadId, turns } }
      if (method === 'thread/items/list') return { data: listed ?? [] }
      return {}
    },
    watch: () => () => {},
    onGone: () => () => {},
  }
  const adapter = codexAdapter({ link: { open: async () => connection as never, close() {} }, binary: () => '/fake/codex', warn() {} })
  return {
    adapter,
    methods: () => methods.map(one => one.method),
    setTurns: (next: FakeTurn[]) => { turns = next },
    setListed: (next: typeof listed) => { listed = next },
  }
}

const say = (text: string, phase?: string) => ({ type: 'agentMessage', text, ...(phase === undefined ? {} : { phase }) })
const readJob = (over: Partial<Job> = {}): Job => ({
  id: 'relay:w-1', family: 'codex', kind: 'relay', target: { kind: 'session', sessionId: THREAD }, text: '', marks: ['请继续这一轮'], expect: 'reply', ...over,
})

describe('只读一眼(read):只认最后一轮', () => {
  it('★上一轮有 final_answer、这一轮 inProgress → busy:true、没有 reply(旧答案不是本轮结果)', async () => {
    const fake = fakeCodex([
      { id: 'old', status: 'completed', items: [say('这是上一轮的结果', 'final_answer')] },
      { id: 'new', status: 'inProgress', items: [say('正在处理这一轮', 'commentary')] },
    ])
    const seen = await fake.adapter.read?.(readJob())
    expect(seen).toMatchObject({ via: 'protocol', busy: true })
    expect(seen?.reply).toBeUndefined()
    // 看一眼不开 turn。
    expect(fake.methods()).not.toContain('turn/start')
  })

  it('这一轮 completed → 只认这一轮里的话;上一轮的 final_answer 不算', async () => {
    const fake = fakeCodex([
      { id: 'old', status: 'completed', items: [say('这是上一轮的结果', 'final_answer')] },
      { id: 'new', status: 'completed', items: [say('我先看了文件', 'commentary'), say('这一轮的结论', 'final_answer')] },
    ])
    expect(await fake.adapter.read?.(readJob())).toEqual({ reply: '这一轮的结论', evidence: 'transcript', via: 'protocol' })
  })

  it('这一轮 completed 但只有过场话 → 认这一轮最后那句过场话,不拿上一轮的 final 顶', async () => {
    const fake = fakeCodex([
      { id: 'old', status: 'completed', items: [say('这是上一轮的结果', 'final_answer')] },
      { id: 'new', status: 'completed', items: [say('只说了这一句', 'commentary')] },
    ])
    expect((await fake.adapter.read?.(readJob()))?.reply).toBe('只说了这一句')
  })

  it('这一轮被打断、一个字没说 → reply 缺席、不编一句、也不拿上一轮顶', async () => {
    const fake = fakeCodex([
      { id: 'old', status: 'completed', items: [say('这是上一轮的结果', 'final_answer')] },
      { id: 'new', status: 'interrupted', items: [] },
    ])
    const seen = await fake.adapter.read?.(readJob())
    expect(seen?.reply).toBeUndefined()
    expect(seen).toMatchObject({ via: 'protocol', evidence: 'none' })
    expect(seen?.busy).not.toBe(true)
  })

  it('只有一轮、completed → 照旧回那一句(老行为一字不变)', async () => {
    const fake = fakeCodex([{ id: 'only', status: 'completed', items: [say('收到', 'final_answer')] }])
    expect(await fake.adapter.read?.(readJob())).toEqual({ reply: '收到', evidence: 'transcript', via: 'protocol' })
  })

  it('resume 没给 turns(分页的老对话)→ items/list 退路也按 turnId 只认最新那一轮', async () => {
    const fake = fakeCodex([])
    // 倒着取的一页:最新那一轮(U3)只有过场话,上一轮(U2)有 final。
    fake.setListed([
      { turnId: 'U3', item: say('这一轮还在说', 'commentary') },
      { turnId: 'U2', item: say('上一轮的结论', 'final_answer') },
    ])
    expect((await fake.adapter.read?.(readJob()))?.reply).toBe('这一轮还在说')
  })
})

describe('submit:false:协议做不了「只填不发」→ unsupported,一个请求都不发', () => {
  it('★新开一条 + submit:false → unsupported;没有 thread/start、没有 turn/start', async () => {
    const fake = fakeCodex([])
    const out = await fake.adapter.run({ id: 'J', family: 'codex', kind: 'dispatch', target: { kind: 'new' }, text: '先填好不要发送', expect: 'ack', submit: false })
    expect(out).toMatchObject({ delivered: 'not_sent', unsupported: true })
    expect(out.why).toBeTruthy()
    expect(fake.methods()).not.toContain('thread/start')
    expect(fake.methods()).not.toContain('turn/start')
  })

  it('指名会话 + submit:false → unsupported;没有 thread/resume、没有 turn/start', async () => {
    const fake = fakeCodex([{ id: 'only', status: 'completed', items: [] }])
    const out = await fake.adapter.run({ id: 'J', family: 'codex', kind: 'relay', target: { kind: 'session', sessionId: THREAD }, text: '先填好', expect: 'ack', submit: false })
    expect(out).toMatchObject({ delivered: 'not_sent', unsupported: true })
    expect(fake.methods()).not.toContain('thread/resume')
    expect(fake.methods()).not.toContain('turn/start')
  })

  it('submit 缺席 / true 照旧发(老行为)', async () => {
    const fake = fakeCodex([{ id: 'only', status: 'completed', items: [] }])
    const out = await fake.adapter.run({ id: 'J', family: 'codex', kind: 'relay', target: { kind: 'session', sessionId: THREAD }, text: '照发', expect: 'none' })
    expect(out.delivered).toBe('confirmed')
    expect(fake.methods()).toContain('turn/start')
  })
})

describe('★串起来:真 relayWatch 巡检 —— 这一轮没完不回电,完了才回、回的是这一轮的答案', () => {
  const dirs: string[] = []
  afterEach(async () => { while (dirs.length) await rm(dirs.pop() as string, { recursive: true, force: true }) })

  it('旧 final + 新 inProgress 两拍 → 零回电;新一轮 completed 后两拍 → 一通回电、reply 是新答案', async () => {
    let nowMs = Date.parse('2026-10-03T03:00:00.000Z')
    const fake = fakeCodex([
      { id: 'old', status: 'completed', items: [say('这是上一轮的结果', 'final_answer')] },
      { id: 'new', status: 'inProgress', items: [say('正在处理这一轮', 'commentary')] },
    ])
    const registry = createRegistry({ now: () => new Date(nowMs) })
    registry.register(fake.adapter)
    const engine = createEngine({ registry, gate: createActionGate({ phaseOf: () => 'open', now: () => new Date(nowMs) }), log: createJobLog(), warn() {} })
    const reader = createEngineRelayReader({ engine })
    const dir = await mkdtemp(join(tmpdir(), 'wb-codex-turn-'))
    dirs.push(dir)
    const calls: string[] = []
    const watcher = createRelayWatchService({
      file: join(dir, 'relay.json'),
      reader,
      now: () => nowMs,
      newId: () => 'wait-existing',
      callOut: { request: async (input) => { calls.push(input.item_id); return { ok: true, entry: { id: 'fake-call' } } } },
    })
    await watcher.load()
    await watcher.remember({ agent: 'codex', session_id: THREAD, title: '已有会话', mark: '请继续这一轮', from: 'call' })

    for (let i = 0; i < 3; i += 1) { await watcher.pump(); nowMs += 9_000 }
    expect(calls).toHaveLength(0)
    expect(watcher.list()[0]?.state).toBe('waiting')

    fake.setTurns([
      { id: 'old', status: 'completed', items: [say('这是上一轮的结果', 'final_answer')] },
      { id: 'new', status: 'completed', items: [say('正在处理这一轮', 'commentary'), say('这一轮的新答案', 'final_answer')] },
    ])
    for (let i = 0; i < 2; i += 1) { await watcher.pump(); nowMs += 9_000 }
    expect(calls).toHaveLength(1)
    expect(watcher.list()[0]?.reply).toBe('这一轮的新答案')
  })
})
