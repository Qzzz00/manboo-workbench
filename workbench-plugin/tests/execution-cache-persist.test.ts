// @vitest-environment node
// 8791 热点第四轮:解析状态落盘 + 重启续跑;已结束来源 stamp 不变跳过解析;冷解析限速队列;
// pickCandidates/scoreEvidence 打分增量化(指纹没变复用上拍分数)。
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { readLinkedCodexExecutions } from '../src/server/codexExecutionFacts.ts'
import { createScoreCache, pickCandidates, scoreEvidence } from '../src/server/progressEvidence.ts'
import type { EvalCard, EvidenceItem } from '../src/server/progressEvidence.ts'
import type { TaskLink, TaskView } from '../src/protocol.ts'

const dirs: string[] = []
afterEach(() => { while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true }) })

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'exec-cache-')); dirs.push(home)
  const dir = join(home, 'sessions'); mkdirSync(dir)
  return { home, dir }
}

const NOW = '2026-10-28T02:00:00.000Z'
const task = (id: string, agent: 'codex' | 'kimi', sessionId: string, status: TaskView['status'] = 'doing'): TaskView =>
  ({ id, title: id, status, source: { kind: 'manual' }, created_at: '', updated_at: '', links: [{ agent, session_id: sessionId }] })
const depsFor = (file: string, agent: 'codex' | 'kimi', sessionId: string, extra: Record<string, unknown> = {}) => ({
  now: () => new Date(NOW),
  authorize: async () => ({ agent, session_id: sessionId, format: (agent === 'kimi' ? 'kimi-wire' : 'codex-rollout') as 'kimi-wire' | 'codex-rollout', file }),
  ...extra,
})

/** 只数字符串入参的 JSON.parse —— wire/rollout 每行恰一次,缓存账本文件本身也是一次,断言里分开说。 */
async function countParses<T>(fn: () => Promise<T>): Promise<{ result: T, parses: number }> {
  const original = JSON.parse
  let parses = 0
  JSON.parse = ((input: unknown, reviver?: (key: string, value: unknown) => unknown) => {
    if (typeof input === 'string') parses += 1
    return original(input as string, reviver)
  }) as typeof JSON.parse
  try {
    const result = await fn()
    return { result, parses }
  } finally {
    JSON.parse = original
  }
}

const codexRows = (sessionId: string) => [
  { type: 'session_meta', payload: { id: sessionId, model_provider: 'openai' } },
  { type: 'event_msg', timestamp: '2026-10-28T01:00:00.000Z', payload: { type: 'task_started', turn_id: 'r-1' } },
  { type: 'response_item', timestamp: '2026-10-28T01:01:00.000Z', payload: { type: 'custom_tool_call', turn_id: 'r-1', name: 'x' } },
]
const codexEnd = (sessionId: string) => ({ type: 'event_msg', timestamp: '2026-10-28T01:02:00.000Z', payload: { type: 'task_complete', turn_id: 'r-1', last_agent_message: '做完:产物已生成' } })
const lines = (rows: readonly unknown[]) => rows.map(row => JSON.stringify(row)).join('\n') + '\n'

it('解析状态落盘:重启后 stamp 续得上只解析新增行,结果与全新冷解析逐字一致', async () => {
  const f = fixture(), sessionId = 's-codex-persist', file = join(f.dir, 'a.jsonl')
  const cacheDir = join(f.home, 'execution-cache')
  writeFileSync(file, lines(codexRows(sessionId)))
  const depsA = depsFor(file, 'codex', sessionId, { cacheDir })
  const first = await countParses(() => readLinkedCodexExecutions([task('t-1', 'codex', sessionId)], depsA))
  expect(first.parses).toBe(codexRows(sessionId).length + 1)

  appendFileSync(file, JSON.stringify(codexEnd(sessionId)) + '\n')
  // 模拟重启:新 deps 实例(内存缓存全丢),同一 cacheDir。落盘状态当上一拍,只读追加尾巴。
  const depsB = depsFor(file, 'codex', sessionId, { cacheDir })
  const second = await countParses(() => readLinkedCodexExecutions([task('t-1', 'codex', sessionId)], depsB))
  // 1 次读缓存账本文件 + 1 次解析新增行 —— wire 零次从头解析。
  expect(second.parses).toBe(2)
  const fresh = await readLinkedCodexExecutions([task('t-1', 'codex', sessionId)], depsFor(file, 'codex', sessionId))
  expect(second.result.sources[0]?.events).toEqual(fresh.sources[0]?.events)
  expect(second.result.sources[0]?.state).toBe('returned')
})

it('解析状态落盘:文件被截断重写后 stamp/锚对不上,不拿旧状态、整文件重解析', async () => {
  const f = fixture(), sessionId = 's-codex-persist-trunc', file = join(f.dir, 'b.jsonl')
  const cacheDir = join(f.home, 'execution-cache')
  writeFileSync(file, lines([...codexRows(sessionId), codexEnd(sessionId)]))
  await readLinkedCodexExecutions([task('t-1', 'codex', sessionId)], depsFor(file, 'codex', sessionId, { cacheDir }))

  // 截断重建成更短的内容:已读 offset 超过新 size,旧解析状态续不上 → 整文件重解析。
  const shorter = codexRows(sessionId).slice(0, 2)
  writeFileSync(file, lines(shorter))
  const depsB = depsFor(file, 'codex', sessionId, { cacheDir })
  const reopened = await countParses(() => readLinkedCodexExecutions([task('t-1', 'codex', sessionId)], depsB))
  expect(reopened.parses).toBe(shorter.length + 2) // 1 次读缓存账本 + 冷解析(行数 + 首行)
  expect(reopened.result.sources[0]?.events.map(one => one.kind)).toEqual(['started'])
})

it('已结束来源 stamp 不变:第二拍零次解析直接用缓存观察;追加后恢复解析', async () => {
  const f = fixture(), sessionId = 's-codex-settled', file = join(f.dir, 'c.jsonl')
  writeFileSync(file, lines([...codexRows(sessionId), codexEnd(sessionId)]))
  const deps = depsFor(file, 'codex', sessionId)
  const done = () => task('t-1', 'codex', sessionId, 'done')
  const first = await countParses(() => readLinkedCodexExecutions([done()], deps))
  expect(first.parses).toBe(codexRows(sessionId).length + 2) // 4 行 + 首行
  expect(first.result.sources[0]?.state).toBe('returned')

  // 文件没动:跳过 readParsed,零次 JSON.parse,观察不变。
  const second = await countParses(() => readLinkedCodexExecutions([done()], deps))
  expect(second.parses).toBe(0)
  expect(second.result.sources[0]?.state).toBe('returned')
  expect(second.result.sources[0]?.events).toEqual(first.result.sources[0]?.events)

  // 卡被重开/文件又长了(stamp 变):恢复正常喂行。
  appendFileSync(file, JSON.stringify({ type: 'event_msg', timestamp: '2026-10-28T01:03:00.000Z', payload: { type: 'task_started', turn_id: 'r-2' } }) + '\n')
  const third = await countParses(() => readLinkedCodexExecutions([done()], deps))
  expect(third.parses).toBe(1)
  expect(third.result.sources[0]?.events.length).toBe(first.result.sources[0]!.events.length + 1)
})

it('已结束来源 stamp 不变:重启后(新实例 + cacheDir)同样不再解析 wire', async () => {
  const f = fixture(), sessionId = 's-codex-settled-disk', file = join(f.dir, 'd.jsonl')
  const cacheDir = join(f.home, 'execution-cache')
  writeFileSync(file, lines([...codexRows(sessionId), codexEnd(sessionId)]))
  const done = () => task('t-1', 'codex', sessionId, 'done')
  await readLinkedCodexExecutions([done()], depsFor(file, 'codex', sessionId, { cacheDir }))

  const depsB = depsFor(file, 'codex', sessionId, { cacheDir })
  const second = await countParses(() => readLinkedCodexExecutions([done()], depsB))
  // 唯一一次 JSON.parse 是读缓存账本文件本身;wire 零次解析,settled 观察直接用。
  expect(second.parses).toBe(1)
  expect(second.result.sources[0]?.state).toBe('returned')
})

it('冷解析限速:每拍最多 N 个整文件解析,超出吃旧观察或记不可用,下一拍消化', async () => {
  const f = fixture()
  const fileBySession = new Map<string, string>()
  const tasks: TaskView[] = []
  // 事件时刻贴着 NOW:未结束的来源判 'running'(STALE_MS 只有 2 分钟)。
  const recentRows = (sessionId: string) => [
    { type: 'session_meta', payload: { id: sessionId, model_provider: 'openai' } },
    { type: 'event_msg', timestamp: '2026-10-28T01:59:30.000Z', payload: { type: 'task_started', turn_id: 'r-1' } },
    { type: 'response_item', timestamp: '2026-10-28T01:59:40.000Z', payload: { type: 'custom_tool_call', turn_id: 'r-1', name: 'x' } },
  ]
  for (let i = 0; i < 6; i += 1) {
    const sessionId = `s-budget-${i}`, file = join(f.dir, `budget-${i}.jsonl`)
    writeFileSync(file, lines(recentRows(sessionId)))
    tasks.push(task(`t-${i}`, 'codex', sessionId))
    fileBySession.set(sessionId, file)
  }
  const deps = {
    now: () => new Date(NOW),
    coldParsePerBeat: 2,
    authorize: async (_task: TaskView, link: TaskLink) =>
      ({ agent: link.agent === 'kimi' ? 'kimi' as const : 'codex' as const, session_id: link.session_id, format: 'codex-rollout' as const, file: fileBySession.get(link.session_id) ?? '' }),
  }
  const run = () => readLinkedCodexExecutions(tasks, deps)
  const states = (r: Awaited<ReturnType<typeof run>>) => r.sources.map(one => one.state)

  const beat1 = await run()
  // 恰好 2 个解析出事件(running),其余 4 个额度耗尽、无旧观察 → unknown(unavailable)。
  expect(states(beat1).filter(one => one === 'running')).toHaveLength(2)
  expect(states(beat1).filter(one => one === 'unknown')).toHaveLength(4)
  expect(beat1.sources.filter(one => one.state === 'unknown').every(one => one.unknown === 'unavailable')).toBe(true)

  const beat2 = await run()
  expect(states(beat2).filter(one => one === 'running')).toHaveLength(4)

  const beat3 = await run()
  expect(states(beat3).filter(one => one === 'running')).toHaveLength(6)

  // 全部进缓存后:stamp 不变,一拍全部命中,零次解析。
  const beat4 = await countParses(run)
  expect(beat4.parses).toBe(0)
  expect(states(beat4.result)).toEqual(['running', 'running', 'running', 'running', 'running', 'running'])
})

it('打分增量化:同输入第二拍零次打分,新证据只对含它的对重算', () => {
  const card = (id: string, title: string): EvalCard =>
    ({ id, title, status: 'doing', context: [], sessionIds: [], namedSessions: [] })
  const ev = (id: string, text: string): EvidenceItem => ({ id, kind: 'item', source: '测试', text })
  const cards = [card('T1', '部署上线'), card('T2', '文案定稿')]
  const evidence = [ev('E1', '部署上线已经改好,还没装进正式版'), ev('E2', '别的杂事一件')]
  const scoreCache = createScoreCache()
  const score = vi.fn((one: EvalCard, item: EvidenceItem) => scoreEvidence(one, item))

  const beat1 = pickCandidates(cards, evidence, { scoreCache, score })
  const callsAfter1 = score.mock.calls.length
  // 无 project 过滤、无直连:全量 2 卡 × 2 证据 = 4 次。
  expect(callsAfter1).toBe(4)
  expect(beat1.get('T1')?.map(one => one.ev.id)).toContain('E1')

  // 同输入第二拍:指纹全中,一次打分都不调。
  pickCandidates(cards, evidence, { scoreCache, score })
  expect(score.mock.calls.length).toBe(callsAfter1)

  // 加一条新证据:旧对复用,只对 2 张卡 × 新证据重算。
  const withNew = [...evidence, ev('E3', '文案定稿已经完成,在等他审')]
  const beat3 = pickCandidates(cards, withNew, { scoreCache, score })
  const newCalls = score.mock.calls.slice(callsAfter1)
  expect(newCalls).toHaveLength(2)
  expect(newCalls.every(call => (call[1] as EvidenceItem).id === 'E3')).toBe(true)
  expect(beat3.get('T2')?.map(one => one.ev.id)).toContain('E3')

  // 证据改了内容(指纹变):旧对也重算。
  const changed = [ev('E1', '部署上线彻底重做,方案换了'), ...evidence.slice(1)]
  pickCandidates(cards, changed, { scoreCache, score })
  const callsAfter3 = callsAfter1 + 2
  const recalc = score.mock.calls.slice(callsAfter3)
  expect(recalc).toHaveLength(2)
  expect(recalc.every(call => (call[1] as EvidenceItem).id === 'E1')).toBe(true)
})
