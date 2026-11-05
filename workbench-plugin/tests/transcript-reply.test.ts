// @vitest-environment node
/**
 * **Claude / Kimi 收回答从它们自己的记录里判与取**(2026-10-12,卡「Claude与Kimi收回答读记录」;
 * 交接 `docs/交接-1012-Claude与Kimi收回答读记录.md`,接法照千问那张卡 `docs/交接-1009-千问派活收回答.md`)。
 *
 * 两家的会话记录本来就被会话流读着(Claude `~/.claude/projects/…/<id>.jsonl`、Kimi daimon 的 `wire.jsonl`),
 * 解析只有一份(`sessionDigest.turnsOf`)。这里只多一层:按送进去那句里的记号找到那一轮,等那一轮收尾再取正文;
 * 判断里不写包名,`agentRecords.RECORD_SOURCES` 一行一家。
 *
 * 记录文件都是临时目录里的真文件(结构照真机抄,内容换成占位)。
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { bindingFor, bundleIdsOf } from '../src/server/agentSources.ts'
import { createRecordReaders } from '../src/server/agentRecords.ts'
import type { SessionFileRef } from '../src/server/sessionHistory.ts'
import { readTranscriptReply, type TranscriptAccess } from '../src/server/transcriptReply.ts'
import { createRecordsAdapter } from '../src/server/engine/adapters/records.ts'
import type { Job } from '../src/server/engine/adapter.ts'
import { createEngineWiring } from '../src/server/engine/wire.ts'
import { createActionGate } from '../src/server/actionGate.ts'
import { createJobLog } from '../src/server/jobLog.ts'

const MARK = '工作台派活 abc123'
const T = (minute: number): string => new Date(Date.UTC(2026, 9, 12, 3, minute, 0)).toISOString()

// ── Claude 记录文件的几种行(结构照 `~/.claude/projects/<目录>/<id>.jsonl`) ──
const ask = (text: string, at: string): string => JSON.stringify({
  type: 'user', origin: { kind: 'human' }, message: { role: 'user', content: text }, timestamp: at,
})
/** 这一轮中途的一段话(后面还有工具调用):`stop_reason: tool_use`。 */
const midSay = (text: string, at: string): string => JSON.stringify({
  type: 'assistant', message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'text', text }] }, timestamp: at,
})
const toolUse = (at: string): string => JSON.stringify({
  type: 'assistant', message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } }] }, timestamp: at,
})
const toolResult = (at: string): string => JSON.stringify({
  type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] }, timestamp: at,
})
/** 这一轮收尾那一段:`stop_reason: end_turn`。 */
const finalSay = (text: string, at: string): string => JSON.stringify({
  type: 'assistant', message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text }] }, timestamp: at,
})
const interrupted = (at: string): string => JSON.stringify({
  type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] }, timestamp: at,
})

// ── Kimi 桌面版 wire.jsonl(1.4:`turn.prompt` / `context.append_loop_event`) ──
const kAsk = (text: string): string => JSON.stringify({ type: 'turn.prompt', input: [{ type: 'text', text }] })
const kSay = (text: string): string => JSON.stringify({ type: 'context.append_loop_event', event: { type: 'content.part', part: { type: 'text', text } } })
const kTool = (): string => JSON.stringify({ type: 'context.append_loop_event', event: { type: 'tool.call', name: 'Shell', args: { command: 'ls' } } })
const kStepEnd = (finishReason: string): string => JSON.stringify({ type: 'context.append_loop_event', event: { type: 'step.end', finishReason } })

const dirs: string[] = []
afterEach(async () => { while (dirs.length) await rm(dirs.pop() as string, { recursive: true, force: true }) })

interface Fake { agent: string, id: string, lines: readonly string[], updated?: string, format?: SessionFileRef['format'] }

async function rig(fakes: readonly Fake[]): Promise<TranscriptAccess & { located: string[] }> {
  const dir = await mkdtemp(join(tmpdir(), 'wb-transcript-reply-'))
  dirs.push(dir)
  const files = new Map<string, SessionFileRef>()
  for (const one of fakes) {
    const file = join(dir, `${one.agent}-${one.id}.jsonl`)
    await writeFile(file, `${one.lines.join('\n')}\n`, 'utf8')
    files.set(`${one.agent}|${one.id}`, {
      agent: one.agent, session_id: one.id, file,
      format: one.format ?? (one.agent === 'kimi' ? 'kimi-wire' : 'claude-transcript'),
    })
  }
  const located: string[] = []
  return {
    located,
    sessions: () => fakes.map(one => ({ agent: one.agent, session_id: one.id, updated_at: one.updated ?? T(0) })),
    locate: async (agent, id) => { located.push(`${agent}|${id}`); return files.get(`${agent}|${id}`) },
  }
}

describe('Claude:按记号找那一轮,收尾了才给正文', () => {
  it('★那一轮 end_turn 收尾 → done,正文是收尾那一段(不是中途那句「我先看看」)', async () => {
    const access = await rig([{ agent: 'claude', id: 's1', lines: [
      ask('先前那件事', T(0)), finalSay('旧回答', T(1)),
      ask(`【${MARK}】帮我改短一点`, T(5)), midSay('我先看看', T(6)), toolUse(T(6)), toolResult(T(7)), finalSay('改好了,短了一半', T(8)),
    ] }])
    expect(await readTranscriptReply({ agent: 'claude', marker: MARK, access })).toEqual({ found: true, status: 'done', reply: '改好了,短了一半' })
  })

  it('★还在跑(最后是工具调用 / 中途一句)→ running,不给半截', async () => {
    const access = await rig([{ agent: 'claude', id: 's1', lines: [ask(`【${MARK}】帮我改短一点`, T(5)), midSay('我先看看', T(6)), toolUse(T(6))] }])
    expect(await readTranscriptReply({ agent: 'claude', marker: MARK, access })).toEqual({ found: true, status: 'running' })
  })

  it('那句刚落盘、它还没开口 → running', async () => {
    const access = await rig([{ agent: 'claude', id: 's1', lines: [finalSay('旧回答', T(1)), ask(`【${MARK}】帮我改短一点`, T(5))] }])
    expect(await readTranscriptReply({ agent: 'claude', marker: MARK, access })).toEqual({ found: true, status: 'running' })
  })

  it('★她后来又问了一句:只认我们那一轮,不拿后面那轮的回答', async () => {
    const access = await rig([{ agent: 'claude', id: 's1', lines: [
      ask(`【${MARK}】帮我改短一点`, T(5)), finalSay('改好了', T(6)), ask('再加个标题', T(7)), finalSay('标题加好了', T(8)),
    ] }])
    expect(await readTranscriptReply({ agent: 'claude', marker: MARK, access })).toEqual({ found: true, status: 'done', reply: '改好了' })
  })

  it('被她停掉 → done + stopped,有字给字', async () => {
    const access = await rig([{ agent: 'claude', id: 's1', lines: [ask(`【${MARK}】帮我改短一点`, T(5)), midSay('我先看看', T(6)), interrupted(T(7))] }])
    expect(await readTranscriptReply({ agent: 'claude', marker: MARK, access })).toEqual({ found: true, status: 'done', stopped: true, reply: '我先看看' })
  })

  it('★派活开的新对话:那一句在开头、之后干了一大段(比尾巴窗口长)→ 照样认得出那一轮', async () => {
    const big = Array.from({ length: 1400 }, (_, i) => toolResult(T(6)).replace('"ok"', JSON.stringify(`${i}:${'x'.repeat(1000)}`)))
    const access = await rig([{ agent: 'claude', id: 's1', lines: [ask(`【${MARK}】帮我改短一点`, T(5)), toolUse(T(6)), ...big, finalSay('全改完了', T(9))] }])
    expect(await readTranscriptReply({ agent: 'claude', marker: MARK, access })).toEqual({ found: true, status: 'done', reply: '全改完了' })
  })

  it('那一句在开头、尾巴里她又说过别的 → 分不清中间那段归谁,当读不到(退窗口),不乱认', async () => {
    const big = Array.from({ length: 1400 }, (_, i) => toolResult(T(6)).replace('"ok"', JSON.stringify(`${i}:${'x'.repeat(1000)}`)))
    const access = await rig([{ agent: 'claude', id: 's1', lines: [ask(`【${MARK}】帮我改短一点`, T(5)), toolUse(T(6)), ...big, ask('再加个标题', T(8)), finalSay('标题加好了', T(9))] }])
    expect(await readTranscriptReply({ agent: 'claude', marker: MARK, access })).toBeUndefined()
  })

  it('记录里还没有这一句 → found:false(引擎换到窗口)', async () => {
    const access = await rig([{ agent: 'claude', id: 's1', lines: [ask('别的事', T(5)), finalSay('好', T(6))] }])
    expect(await readTranscriptReply({ agent: 'claude', marker: MARK, access })).toEqual({ found: false })
  })

  it('一条会话的记录都读不到 → undefined(读不了,不是「还没有」)', async () => {
    const access = await rig([])
    const lost: TranscriptAccess = { sessions: () => [{ agent: 'claude', session_id: 'gone', updated_at: T(0) }], locate: access.locate }
    expect(await readTranscriptReply({ agent: 'claude', marker: MARK, access: lost })).toBeUndefined()
  })

  it('★在这一家的几条会话里按记号找;别家的会话不碰', async () => {
    const access = await rig([
      { agent: 'claude', id: 'other', lines: [ask('别的事', T(1)), finalSay('好', T(2))], updated: T(9) },
      { agent: 'claude', id: 'mine', lines: [ask(`【${MARK}】帮我改短一点`, T(5)), finalSay('改好了', T(6))], updated: T(6) },
      { agent: 'kimi', id: 'k', lines: [kAsk(`【${MARK}】帮我改短一点`), kSay('这是 Kimi'), kStepEnd('end_turn')] },
    ])
    expect(await readTranscriptReply({ agent: 'claude', marker: MARK, access })).toEqual({ found: true, status: 'done', reply: '改好了' })
    expect(access.located.every(one => one.startsWith('claude|'))).toBe(true)
  })

  it('★给了会话号 → 只读那一条', async () => {
    const access = await rig([
      { agent: 'claude', id: 'a', lines: [ask(`【${MARK}】帮我改短一点`, T(5)), finalSay('A 的回答', T(6))] },
      { agent: 'claude', id: 'b', lines: [ask(`【${MARK}】帮我改短一点`, T(5)), finalSay('B 的回答', T(6))] },
    ])
    expect(await readTranscriptReply({ agent: 'claude', marker: MARK, sessionId: 'b', access })).toEqual({ found: true, status: 'done', reply: 'B 的回答' })
    expect(access.located).toEqual(['claude|b'])
  })
})

describe('Kimi:同一套判断,读的是它的 wire.jsonl', () => {
  it('★step.end end_turn → done,正文是最后那段字', async () => {
    const access = await rig([{ agent: 'kimi', id: 'k1', lines: [kAsk(`【${MARK}】帮我改短一点`), kSay('我先看看'), kTool(), kStepEnd('tool_calls'), kSay('改好了'), kStepEnd('end_turn')] }])
    expect(await readTranscriptReply({ agent: 'kimi', marker: MARK, access })).toEqual({ found: true, status: 'done', reply: '改好了' })
  })

  it('★还在跑(交给工具了,下一步还没来)→ running', async () => {
    const access = await rig([{ agent: 'kimi', id: 'k1', lines: [kAsk(`【${MARK}】帮我改短一点`), kSay('我先看看'), kTool(), kStepEnd('tool_calls')] }])
    expect(await readTranscriptReply({ agent: 'kimi', marker: MARK, access })).toEqual({ found: true, status: 'running' })
  })

  it('这一步被掐断 → done + stopped', async () => {
    const access = await rig([{ agent: 'kimi', id: 'k1', lines: [kAsk(`【${MARK}】帮我改短一点`), kSay('我先看看'), kStepEnd('interrupted')] }])
    expect(await readTranscriptReply({ agent: 'kimi', marker: MARK, access })).toEqual({ found: true, status: 'done', stopped: true, reply: '我先看看' })
  })
})

describe('接进「它自己的记录」那张表:一行一家,判断里不写包名', () => {
  const claudeBundle = bundleIdsOf(bindingFor('claude'))[0] as string
  const kimiBundle = bundleIdsOf(bindingFor('kimi'))[0] as string

  it('★Claude / Kimi 的包有收回答这一路(hasReply),但不接管它们的会话(has 仍是 false:会话照旧走会话流)', async () => {
    const access = await rig([])
    const readers = createRecordReaders({ home: '/nonexistent', transcripts: access })
    for (const bundle of [claudeBundle, kimiBundle]) {
      expect(readers.hasReply(bundle)).toBe(true)
      expect(readers.canReply(bundle)).toBe(true)
      expect(readers.has(bundle)).toBe(false)
      expect(readers.read(bundle)).toBeUndefined()
    }
  })

  it('没接会话那一份(transcripts 缺席)→ 读不到,canReply 为假', async () => {
    const readers = createRecordReaders({ home: '/nonexistent' })
    expect(readers.hasReply(claudeBundle)).toBe(true)
    expect(readers.canReply(claudeBundle)).toBe(false)
    expect(await readers.reply(claudeBundle, MARK)).toBeUndefined()
  })

  it('★记录文件那条通道:指名会话时把会话号交下去;收了 → transcript + 正文', async () => {
    const access = await rig([
      { agent: 'kimi', id: 'k1', lines: [kAsk(`【${MARK}】帮我改短一点`), kSay('k1 的回答'), kStepEnd('end_turn')] },
      { agent: 'kimi', id: 'k2', lines: [kAsk(`【${MARK}】帮我改短一点`), kSay('k2 的回答'), kStepEnd('end_turn')] },
    ])
    const readers = createRecordReaders({ home: '/nonexistent', transcripts: access })
    const adapter = createRecordsAdapter('kimi', { bundleIds: [kimiBundle], readers })
    const job: Job = { id: 't', family: 'kimi', kind: 'relay', target: { kind: 'session', sessionId: 'k2' }, text: '', marks: [MARK], expect: 'reply' }
    expect(await adapter.read?.(job)).toEqual({ via: 'file', evidence: 'transcript', reply: 'k2 的回答' })
    expect(access.located).toEqual(['kimi|k2'])
  })
})

describe('接线:Claude / Kimi 登记窗口那一条时一起登记「记录文件」那一条,引擎读的时候先问它', () => {
  const windowDeps = {
    helper: { connected: () => false, request: () => Promise.reject(new Error('no')) },
  } as unknown as NonNullable<Parameters<typeof createEngineWiring>[0]['window']>

  it('★两家都多一条 file;收回答走它,窗口一眼都不读(窗口这会儿也读不了)', async () => {
    const access = await rig([
      { agent: 'claude', id: 'c1', lines: [ask(`【${MARK}】帮我改短一点`, T(5)), midSay('我先看看', T(6)), toolUse(T(6)), finalSay('改好了', T(7))] },
      { agent: 'kimi', id: 'k1', lines: [kAsk(`【${MARK}】帮我改短一点`), kSay('Kimi 改好了'), kStepEnd('end_turn')] },
    ])
    const now = (): Date => new Date(1_000_000)
    const log = createJobLog({ now })
    const gate = createActionGate({ phaseOf: () => 'open', log, now })
    const wiring = createEngineWiring({ gate, log, window: windowDeps, records: createRecordReaders({ home: '/nonexistent', transcripts: access }) })
    expect(wiring.registry.channelsOf('claude').map(one => one.via)).toContain('file')
    expect(wiring.registry.channelsOf('kimi').map(one => one.via)).toEqual(['file', 'window'])
    const dispatch = (family: string): Job => ({ id: `t-${family}`, itemId: `t-${family}`, family, kind: 'dispatch', target: { kind: 'current' }, text: `【${MARK}】帮我改短一点`, marks: [MARK], expect: 'reply' })
    expect(await wiring.engine.read(dispatch('claude'))).toEqual({ via: 'file', evidence: 'transcript', reply: '改好了' })
    expect(await wiring.engine.read(dispatch('kimi'))).toEqual({ via: 'file', evidence: 'transcript', reply: 'Kimi 改好了' })
    wiring.close()
  })
})
