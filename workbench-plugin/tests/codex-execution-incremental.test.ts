// @vitest-environment node
// 增量尾解析:追加只解析新增行;截断/同长改写整解析;事件 id 与全量解析一致。
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { readLinkedCodexExecutions } from '../src/server/codexExecutionFacts.ts'
import type { TaskView } from '../src/protocol.ts'

const dirs: string[] = []
afterEach(() => { while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true }) })

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'exec-incremental-')); dirs.push(home)
  const dir = join(home, 'sessions'); mkdirSync(dir)
  return { dir }
}

const NOW = '2026-10-26T02:00:00.000Z'
const task = (id: string, agent: 'codex' | 'kimi', sessionId: string): TaskView =>
  ({ id, title: id, status: 'doing', source: { kind: 'manual' }, created_at: '', updated_at: '', links: [{ agent, session_id: sessionId }] })
const depsFor = (file: string, agent: 'codex' | 'kimi', sessionId: string) => ({
  now: () => new Date(NOW),
  authorize: async () => ({ agent, session_id: sessionId, format: (agent === 'kimi' ? 'kimi-wire' : 'codex-rollout') as 'kimi-wire' | 'codex-rollout', file }),
})

/** 只数字符串入参的 JSON.parse —— 事实解析里每行恰一次,行外解析(如任务账)不进这条读路。 */
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
  { type: 'event_msg', timestamp: '2026-10-26T01:00:00.000Z', payload: { type: 'task_started', turn_id: 'r-1' } },
  { type: 'response_item', timestamp: '2026-10-26T01:01:00.000Z', payload: { type: 'custom_tool_call', turn_id: 'r-1', name: 'x' } },
]
const codexEnd = (sessionId: string) => ({ type: 'event_msg', timestamp: '2026-10-26T01:02:00.000Z', payload: { type: 'task_complete', turn_id: 'r-1', last_agent_message: '做完:产物已生成' } })
const lines = (rows: readonly unknown[]) => rows.map(row => JSON.stringify(row)).join('\n') + '\n'

it('Codex rollout 追加:第二拍只解析新增行,事件与全量解析逐字一致', async () => {
  const f = fixture(), sessionId = 's-codex-inc', file = join(f.dir, 'a.jsonl')
  writeFileSync(file, lines(codexRows(sessionId)))
  const deps = depsFor(file, 'codex', sessionId)
  const first = await countParses(() => readLinkedCodexExecutions([task('t-1', 'codex', sessionId)], deps))
  // 冷解析:每一行一次,首行额外一次(provider 追踪)——单遍化之前是两倍还多。
  expect(first.parses).toBe(codexRows(sessionId).length + 1)
  expect(first.result.sources[0]?.events.map(one => one.kind)).toEqual(['started', 'updated'])

  appendFileSync(file, JSON.stringify(codexEnd(sessionId)) + '\n')
  const second = await countParses(() => readLinkedCodexExecutions([task('t-1', 'codex', sessionId)], deps))
  expect(second.parses).toBe(1)
  // 同一输入下,增量结果必须与一份全新冷解析逐字一致(id 含行号/内容哈希,任何漂移都会在这儿显形)。
  const fresh = await readLinkedCodexExecutions([task('t-1', 'codex', sessionId)], depsFor(file, 'codex', sessionId))
  expect(second.result.sources[0]?.events).toEqual(fresh.sources[0]?.events)
  expect(second.result.sources[0]?.state).toBe('returned')
  expect(second.result.sources[0]?.receipt).toMatchObject({ kind: 'done', by: 'codex' })
})

it('Codex 截断重建与同长改写:下一拍整文件重解析,反映新事实', async () => {
  const f = fixture(), sessionId = 's-codex-trunc', file = join(f.dir, 'b.jsonl')
  writeFileSync(file, lines([...codexRows(sessionId), codexEnd(sessionId)]))
  const deps = depsFor(file, 'codex', sessionId)
  await readLinkedCodexExecutions([task('t-1', 'codex', sessionId)], deps)

  // 截断重建:更短的内容 → size < 已读 offset,必须整解析。
  const shorter = codexRows(sessionId).slice(0, 2)
  writeFileSync(file, lines(shorter))
  const truncated = await countParses(() => readLinkedCodexExecutions([task('t-1', 'codex', sessionId)], deps))
  expect(truncated.parses).toBe(shorter.length + 1)
  expect(truncated.result.sources[0]?.events.map(one => one.kind)).toEqual(['started'])

  // 同长改写(内容变了、字节数不变):stamp 变但 size == 已读 offset,不允许按追加处理。
  const target = Buffer.byteLength(lines(shorter))
  const rebuiltRaw = (pad: number) => lines([
    { type: 'session_meta', payload: { id: sessionId, model_provider: 'openai' } },
    { type: 'turn_context', payload: { model: 'kimi-k2.5', padding: 'x'.repeat(pad) } },
  ])
  // 'x' 无转义,字节数随 pad 线性涨;一次换算对齐到截断后文件的精确字节数。
  const pad = 64 + (target - Buffer.byteLength(rebuiltRaw(64)))
  const sameSizeRaw = rebuiltRaw(pad)
  expect(Buffer.byteLength(sameSizeRaw)).toBe(target)
  writeFileSync(file, sameSizeRaw)
  const sameSize = await countParses(() => readLinkedCodexExecutions([task('t-1', 'codex', sessionId)], deps))
  expect(sameSize.parses).toBe(2 + 1)
  expect(sameSize.result.sources[0]?.provider).toBe('kimi')
})

it('未换行的末行:当拍可见,下一拍追加时不重算、不重复', async () => {
  const f = fixture(), sessionId = 's-codex-pending', file = join(f.dir, 'c.jsonl')
  // 末行没有 '\n'(写到一半):当拍就要看到它(挂起行不入已读字节)。
  writeFileSync(file, lines(codexRows(sessionId)) + JSON.stringify(codexEnd(sessionId)))
  const deps = depsFor(file, 'codex', sessionId)
  const first = await countParses(() => readLinkedCodexExecutions([task('t-1', 'codex', sessionId)], deps))
  // 3 行已终结 + 首行 provider 追踪 1 次 + 挂起末行探测 1 次。
  expect(first.parses).toBe(codexRows(sessionId).length + 2)
  expect(first.result.sources[0]?.state).toBe('returned')

  // 文件补长:被挂起那行的前缀字节要重走一遍状态机,之后只有真正的新行算新解析。
  const extra = { type: 'event_msg', timestamp: '2026-10-26T01:03:00.000Z', payload: { type: 'task_started', turn_id: 'r-2' } }
  appendFileSync(file, '\n' + JSON.stringify(extra) + '\n')
  const second = await countParses(() => readLinkedCodexExecutions([task('t-1', 'codex', sessionId)], deps))
  // 挂起行补全后重解析 1 次 + 新行 1 次;不产生重复事件。
  expect(second.parses).toBe(2)
  const kinds = second.result.sources[0]?.events.map(one => `${one.round}:${one.kind}`)
  expect(kinds).toEqual(['r-1:started', 'r-1:updated', 'r-1:ended', 'r-2:started'])
})

it('Kimi wire 追加:行号 id 从续跑点继续数,增量与全量一致', async () => {
  const f = fixture(), sessionId = 's-kimi-inc', file = join(f.dir, 'd.jsonl')
  const head = [
    { type: 'metadata', protocol_version: '1.10' },
    { timestamp: 1792976402, message: { type: 'TurnBegin', payload: { turn_id: 'r-1' } } },
    { timestamp: 1792976403, message: { type: 'agent', payload: { role: 'user' } } },
  ]
  writeFileSync(file, lines(head))
  const deps = depsFor(file, 'kimi', sessionId)
  const first = await countParses(() => readLinkedCodexExecutions([task('t-1', 'kimi', sessionId)], deps))
  expect(first.parses).toBe(head.length + 1)
  expect(first.result.sources[0]?.events.map(one => one.kind)).toEqual(['started'])

  const tail = [
    { timestamp: 1792976404, message: { type: 'content.part', payload: {} } },
    { timestamp: 1792976405, message: { type: 'TurnEnd', payload: {} } },
  ]
  appendFileSync(file, lines(tail))
  const second = await countParses(() => readLinkedCodexExecutions([task('t-1', 'kimi', sessionId)], deps))
  expect(second.parses).toBe(tail.length)

  const fresh = await readLinkedCodexExecutions([task('t-1', 'kimi', sessionId)], depsFor(file, 'kimi', sessionId))
  expect(second.result.sources[0]?.events).toEqual(fresh.sources[0]?.events)
  const ids = second.result.sources[0]?.events.map(one => one.id) ?? []
  expect(new Set(ids).size).toBe(ids.length)
  expect(second.result.sources[0]?.state).toBe('ended')
})

it('同 inode 原地重写且变长:头锚不符,下一拍整文件重解析,不把重写尾巴当追加', async () => {
  const f = fixture(), sessionId = 's-codex-rewrite', file = join(f.dir, 'e.jsonl')
  writeFileSync(file, lines([...codexRows(sessionId), codexEnd(sessionId)]))
  const deps = depsFor(file, 'codex', sessionId)
  await readLinkedCodexExecutions([task('t-1', 'codex', sessionId)], deps)

  // 原地重写(同一路径,inode 不变)且更长,重建在中间多出一行当时没记下的 tool_call:
  // 旧判定(dev/ino 同 + 变长)会当追加,只读尾巴 —— 中间那行永远漏掉,旧事件全留着。
  // 头锚识破它,必须整解析。(前缀一字不改、只在尾巴上加长的原地扩写与追加不可区分,按追加对待。)
  const rewritten = [
    codexRows(sessionId)[0]!,
    codexRows(sessionId)[1]!,
    { type: 'response_item', timestamp: '2026-10-26T01:01:30.000Z', payload: { type: 'custom_tool_call', turn_id: 'r-1', name: 'inserted' } },
    codexRows(sessionId)[2]!,
    codexEnd(sessionId),
    { type: 'event_msg', timestamp: '2026-10-26T01:03:00.000Z', payload: { type: 'task_started', turn_id: 'r-2' } },
    { type: 'event_msg', timestamp: '2026-10-26T01:04:00.000Z', payload: { type: 'task_complete', turn_id: 'r-2', last_agent_message: '做完:重写后收尾' } },
  ]
  writeFileSync(file, lines(rewritten))
  const second = await countParses(() => readLinkedCodexExecutions([task('t-1', 'codex', sessionId)], deps))
  expect(second.parses).toBe(rewritten.length + 1)
  const fresh = await readLinkedCodexExecutions([task('t-1', 'codex', sessionId)], depsFor(file, 'codex', sessionId))
  expect(second.result.sources[0]?.events).toEqual(fresh.sources[0]?.events)
  expect(second.result.sources[0]?.events.map(one => `${one.round}:${one.kind}`))
    .toEqual(['r-1:started', 'r-1:updated', 'r-1:updated', 'r-1:ended', 'r-2:started', 'r-2:ended'])
  expect(second.result.sources[0]?.state).toBe('returned')
})

it('非法 UTF-8 行:已读偏移按原始字节推进,追加行不错位、不丢解析', async () => {
  const f = fixture(), sessionId = 's-codex-utf8', file = join(f.dir, 'f.jsonl')
  // 第二行塞 0xFF 非法字节(解出来是 3 字节的 U+FFFD):按解码后字符串回算已读字节会多算 2 个,
  // 下一拍从行中间开读,turn_context 整行报废、model 丢了。
  const headBytes = Buffer.from(lines([codexRows(sessionId)[0]!]))
  const startedBytes = Buffer.from(JSON.stringify(codexRows(sessionId)[1]!) + '\n')
  writeFileSync(file, Buffer.concat([headBytes, Buffer.from([0x7b, 0xff, 0x7d, 0x0a]), startedBytes]))
  const deps = depsFor(file, 'codex', sessionId)
  const first = await countParses(() => readLinkedCodexExecutions([task('t-1', 'codex', sessionId)], deps))
  // 首行 1 + meta 行 1 + 非法行 1 次(解析失败被跳过) + started 行 1。
  expect(first.parses).toBe(4)
  expect(first.result.sources[0]?.events.map(one => one.kind)).toEqual(['started'])

  appendFileSync(file, JSON.stringify({ type: 'turn_context', payload: { model: 'kimi-k2.5' } }) + '\n')
  const second = await countParses(() => readLinkedCodexExecutions([task('t-1', 'codex', sessionId)], deps))
  // 续跑点恰好落在 turn_context 行首:只解析这一行,不重走旧行。
  expect(second.parses).toBe(1)
  expect(second.result.sources[0]?.provider).toBe('kimi')
})

it('挂起末行的 turn_context 当拍就要进 model/provider 判定', async () => {
  const f = fixture(), sessionId = 's-codex-model', file = join(f.dir, 'g.jsonl')
  // 末行没有 '\n':当拍可见。provider 判定读的是状态机的 model —— 旧实现只把挂起行的事件透出来,
  // model 留在旧值上,这一拍 provider 还是 session_meta 的。
  writeFileSync(file, lines(codexRows(sessionId)) + JSON.stringify({ type: 'turn_context', payload: { model: 'kimi-k2.5' } }))
  const deps = depsFor(file, 'codex', sessionId)
  const first = await countParses(() => readLinkedCodexExecutions([task('t-1', 'codex', sessionId)], deps))
  expect(first.result.sources[0]?.provider).toBe('kimi')
  expect(first.result.sources[0]?.provider_basis).toBe('turn_context')

  // 下一拍补全挂起行:重走它一次,provider 判定不变。
  appendFileSync(file, '\n')
  const second = await readLinkedCodexExecutions([task('t-1', 'codex', sessionId)], deps)
  expect(second.sources[0]?.provider).toBe('kimi')
})
