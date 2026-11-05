// @vitest-environment node
/**
 * Claude socket 适配器:**说能读就得真能读**,`submit:false` 协议做不了「只填不发」→ `unsupported`
 * (2026-10-03,审计第二节第 5 条与第 4 条;统筹 10-03 裁定)。
 *
 * 10-03 之前 `capabilities.read === true` 而实例上没有 `read` 方法:引擎的 `read` 按「有 read 方法」挑通道,
 * 协议这一条永远被跳过,回电巡检只能退回窗口 —— 她切走 / 关掉窗口,socket 在线也收不回回答。
 * 现在 `read` 读**这条会话自己的记录文件**:找到我们那一句(记号)落在哪一刻,只认它**之后**的回话;
 * 我们那一句还没落到记录里 → 如实「读不到」,不拿更早的旧回话顶。
 *
 * 不开真 socket、不碰窗口:登记表 / socket 在不在 / 往 socket 写一行 全是注入的假件;记录文件是临时目录里的真文件。
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Job } from '../src/server/engine/adapter.ts'
import { CLAUDE_FROM, CLAUDE_NO_DRAFT_WHY, createClaudeAdapter } from '../src/server/engine/adapters/claude.ts'

const SID = 'aceefe64-6d3a-4f88-9e06-f8f7080616d6'
const T = (minute: number): string => new Date(Date.UTC(2026, 9, 3, 3, minute, 0)).toISOString()

const sayLine = (text: string, at: string): string => JSON.stringify({
  type: 'assistant', message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text }] }, timestamp: at,
})
const askLine = (text: string, at: string): string => JSON.stringify({
  type: 'user', origin: { kind: 'human' }, message: { role: 'user', content: text }, timestamp: at,
})
/** 工作台送进去的那一句到了对方那里的样子(`isMeta` + `origin.kind:'peer'`,见 engine-claude-adapter.test.ts)。 */
const peerLine = (text: string, at: string): string => JSON.stringify({
  type: 'user', isMeta: true, origin: { kind: 'peer', from: CLAUDE_FROM, hostInjected: true },
  message: { role: 'user', content: `Another Claude session sent a message:\n<cross-session-message from="${CLAUDE_FROM}" name="工作台">\n${text}\n</cross-session-message>` },
  timestamp: at,
})

/** 这一轮中途的一段话(后面还有工具调用)。 */
const midLine = (text: string, at: string): string => JSON.stringify({
  type: 'assistant', message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'text', text }] }, timestamp: at,
})
const toolLine = (at: string): string => JSON.stringify({
  type: 'assistant', message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } }] }, timestamp: at,
})
/** 对方正忙时收下、排进队列的那一行。 */
const queuedLine = (text: string, at: string): string => JSON.stringify({ type: 'queue-operation', operation: 'enqueue', content: text, timestamp: at })

const dirs: string[] = []
afterEach(async () => { while (dirs.length) await rm(dirs.pop() as string, { recursive: true, force: true }) })

async function rig(lines: readonly string[]) {
  const dir = await mkdtemp(join(tmpdir(), 'wb-claude-read-'))
  dirs.push(dir)
  const transcript = join(dir, 'tr.jsonl')
  await writeFile(transcript, `${lines.join('\n')}\n`, 'utf8')
  let writes = 0
  const adapter = createClaudeAdapter({
    claudeHome: join(dir, 'claude'),
    sockets: async () => [{ sessionId: SID, pid: 1, socket: join(dir, 'fake.sock'), hostSessionId: 'host-1' }],
    socketReady: async () => true,
    writeLine: async () => { writes += 1 },
    locate: async (agent, sessionId) => (agent === 'claude' && sessionId === SID
      ? { agent: 'claude', session_id: SID, file: transcript, format: 'claude-transcript' as const }
      : undefined),
    confirmMs: 50,
    confirmStepMs: 5,
    replyMs: 50,
  })
  return { adapter, writes: () => writes }
}

const job = (over: Partial<Job> = {}): Job => ({
  id: 'relay:w-1', family: 'claude', kind: 'relay', target: { kind: 'session', sessionId: SID }, text: '', marks: ['就按第二版来'], expect: 'reply', ...over,
})

describe('能力声明与实例一致:说能读就有 read', () => {
  it('★capabilities.read 为真时 adapter.read 必须在(引擎按它挑通道)', async () => {
    const r = await rig([askLine('先看一眼', T(0)), sayLine('看完了', T(1))])
    expect((await r.adapter.capabilities()).read).toBe(true)
    expect(typeof r.adapter.read).toBe('function')
  })
})

describe('read:只认我们那一句之后的回话', () => {
  it('★我们那一句落到记录里了、它之后回了 → 那一句回话;evidence 是记录文件', async () => {
    const r = await rig([askLine('先看一眼', T(0)), sayLine('看完了', T(1)), peerLine('就按第二版来', T(5)), sayLine('好,改成第二版了', T(6))])
    expect(await r.adapter.read?.(job())).toEqual({ reply: '好,改成第二版了', evidence: 'transcript', via: 'protocol' })
  })

  it('★我们那一句落到记录里了、它还没回 → 在跑(busy)、reply 缺席,**不拿更早那句「看完了」顶**', async () => {
    const r = await rig([askLine('先看一眼', T(0)), sayLine('看完了', T(1)), peerLine('就按第二版来', T(5))])
    const seen = await r.adapter.read?.(job())
    expect(seen?.reply).toBeUndefined()
    expect(seen).toMatchObject({ via: 'protocol', evidence: 'transcript', busy: true })
  })

  it('★这一轮还没收尾(中途一句 + 工具调用)→ busy,不拿中途那句顶(2026-10-12)', async () => {
    const r = await rig([peerLine('就按第二版来', T(5)), midLine('我先看看', T(6)), toolLine(T(6))])
    const seen = await r.adapter.read?.(job())
    expect(seen?.reply).toBeUndefined()
    expect(seen).toMatchObject({ via: 'protocol', evidence: 'transcript', busy: true })
  })

  it('★她打的那一句(不是 socket 送的)也认;收尾那一段才是回答', async () => {
    const r = await rig([askLine('就按第二版来', T(5)), midLine('我先看看', T(6)), toolLine(T(6)), sayLine('改成第二版了', T(7))])
    expect(await r.adapter.read?.(job())).toEqual({ reply: '改成第二版了', evidence: 'transcript', via: 'protocol' })
  })

  it('★只排进了队列(它正说着上一轮)→ busy,不把上一轮的收尾当回答', async () => {
    const r = await rig([askLine('先看一眼', T(0)), queuedLine('就按第二版来', T(1)), sayLine('上一轮的收尾', T(2))])
    const seen = await r.adapter.read?.(job())
    expect(seen?.reply).toBeUndefined()
    expect(seen).toMatchObject({ via: 'protocol', evidence: 'transcript', busy: true })
  })

  it('我们那一句还没落到记录里 → 如实读不到(不是「它还没回」),unsupported 让引擎换下一条', async () => {
    const r = await rig([askLine('先看一眼', T(0)), sayLine('看完了', T(1))])
    const seen = await r.adapter.read?.(job())
    expect(seen?.reply).toBeUndefined()
    expect(seen).toMatchObject({ via: 'protocol', evidence: 'none', unsupported: true })
  })

  it('它回了两段 → 认最后那段(与窗口那一路「最后一段交代」同口径)', async () => {
    const r = await rig([peerLine('就按第二版来', T(5)), sayLine('先改第一处', T(6)), sayLine('都改完了', T(7))])
    expect((await r.adapter.read?.(job()))?.reply).toBe('都改完了')
  })

  it('没有记录文件 → 如实说,不编', async () => {
    const r = await rig([])
    const seen = await r.adapter.read?.(job({ target: { kind: 'session', sessionId: 'no-such-session' } }))
    expect(seen?.reply).toBeUndefined()
    expect(seen).toMatchObject({ via: 'protocol', evidence: 'none', unsupported: true })
  })

  it('不是指名会话的目标 → 读不了,如实说;unsupported 让引擎换「记录文件」/ 窗口那条', async () => {
    const r = await rig([])
    const seen = await r.adapter.read?.(job({ target: { kind: 'current' } }))
    expect(seen).toMatchObject({ via: 'protocol', evidence: 'none', unsupported: true })
  })
})

describe('submit:false:协议做不了「只填不发」→ unsupported,socket 一行都不写', () => {
  it('★指名会话 + submit:false → unsupported、why 是那句定死的话;writeLine 零调用', async () => {
    const r = await rig([askLine('先看一眼', T(0))])
    const out = await r.adapter.run(job({ kind: 'answer', text: '就按第二版来', expect: 'ack', submit: false }))
    expect(out).toMatchObject({ delivered: 'not_sent', unsupported: true, why: CLAUDE_NO_DRAFT_WHY })
    expect(r.writes()).toBe(0)
  })

  it('submit 缺席 → 照旧写一行(老行为)', async () => {
    const r = await rig([askLine('先看一眼', T(0))])
    await r.adapter.run(job({ kind: 'answer', text: '就按第二版来', expect: 'none' }))
    expect(r.writes()).toBe(1)
  })
})
