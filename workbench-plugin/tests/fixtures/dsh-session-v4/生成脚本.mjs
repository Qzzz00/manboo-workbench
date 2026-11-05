/** 用真 0.1.7-rc.2 的编解码器与校验器造一份 V4 会话文件。 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { zstdCompressSync } from 'node:zlib'
const R = process.env.HOME + '/.dsh/runtime-next/node_modules/@deepseek-ai/'
const { sessionFormatCatalog } = await import(R + 'dsh-session-format-catalog/lib/index.js')
const { SESSION_FORMAT_VERSION, KNOWN_SESSION_EVENT_TYPES } = await import(R + 'dsh-session/lib/index.js')
const { sessionFormatLogFilename } = await import(R + 'dsh-session-format/lib/index.js')
const { assertV4RowAdmission, assertReleasedV4Relationships } = await import(R + 'dsh-session-format-v3-to-v4/lib/index.js')

const T0 = 1789468204357
const CWD = '/Users/example/Documents/GitHub/desktop-workbench'
const MODEL = 'deepseek-flash'
const modelSource = { kind: 'model', provider: 'deepseek-official', model: MODEL }
const usage = (i, o, cr) => ({ inputTokens: i, outputTokens: o, totalTokens: i + o + cr, cacheReadTokens: cr, reasoningTokens: 0 })

function header(id, extra = {}) {
  return sessionFormatCatalog.encodeCurrentHeader(
    { version: SESSION_FORMAT_VERSION, id, createdAt: T0, cwd: CWD, isSeeded: false, delegationDepth: 0, ...extra }, 0)
}

function build(fn) {
  const rows = []
  let seq = -1
  const push = (type, data, extra = {}) => {
    seq += 1
    rows.push(sessionFormatCatalog.encodeCurrentEvent({ type, seq, time: T0 + 1000 * (seq + 1), data, ...extra }))
    return seq
  }
  fn(push)
  return rows
}

function validate(head, rows, label) {
  const restore = sessionFormatCatalog.createRestore(head, { recovery: 'strict', validation: 'transformed' })
  for (const row of rows) { assertV4RowAdmission(row, KNOWN_SESSION_EVENT_TYPES); restore.decodeRow(row) }
  assertReleasedV4Relationships(restore.finish(), KNOWN_SESSION_EVENT_TYPES)
  console.log(`OK ${label}:${rows.length} 行通过上游 V4 校验`)
}

const ARGS = '{"file_path":"/Users/example/x.ts","content":"a"}'
const mainRows = build((push) => {
  push('turn/start', { turn: 1 })
  push('request/header', { header: { config: { model: MODEL, provider: 'deepseek-official' }, tools: [] }, reason: 'initial' })
  push('request/context', { provider: 'deepseek-official', model: MODEL, contextWindow: 128000 })
  push('step/start', { turn: 1, step: 1 })
  const human = push('user/message', { id: 'msg-user-1', role: 'user', content: [{ type: 'text', text: '把回归跑一遍' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
  push('session/title', { title: '跑一遍回归', source: { kind: 'user' }, messageSeqs: [] })
  push('assistant/message', { turn: 1, step: 1, message: { id: 'msg-asst-1', role: 'assistant', content: [{ type: 'text', text: '好,我先改一个文件,再起后台任务跑测试。' }, { type: 'tool-call', id: 'call-1', name: 'write', arguments: ARGS }], source: modelSource }, usage: usage(100, 10, 0), stream: [] }, { surfaceOp: 'append' })
  push('tool/call', { turn: 1, step: 1, callId: 'call-1', name: 'write', arguments: ARGS })
  push('tool/result', { turn: 1, step: 1, message: { id: 'msg-tool-1', role: 'tool', toolCallId: 'call-1', source: { kind: 'tool', callId: 'call-1' }, content: [{ type: 'text', text: 'wrote 1 file' }] } }, { surfaceOp: 'append' })
  push('step/end', { turn: 1, step: 1 })
  push('turn/end', { turn: 1, reason: { kind: 'completed' } })
  // 第二回合:后台任务做完把会话唤醒(tool-jobs 的 notice),中间还塞了一条时间上下文
  push('turn/start', { turn: 2 })
  push('step/start', { turn: 2, step: 1 })
  push('user/message', { id: 'msg-job-1', role: 'user', content: [{ type: 'text', text: 'background job job-7 (bash: pnpm test) finished completed. Read its output with job_output.' }], source: { kind: 'tool-jobs', form: 'notice', summary: 'bash pnpm test completed' } }, { surfaceOp: 'append' })
  push('user/message', { id: 'msg-time-1', role: 'user', content: [{ type: 'text', text: 'Current time: 2026-09-15 10:32 CST' }], source: { kind: 'time-context', form: 'snapshot', sections: [{ name: 'time', text: '2026-09-15 10:32 CST' }] } }, { surfaceOp: 'append' })
  push('assistant/message', { turn: 2, step: 1, message: { id: 'msg-asst-2', role: 'assistant', content: [{ type: 'text', text: '测试全绿,438 个文件都过了。' }], source: modelSource }, usage: usage(200, 20, 1000), stream: [] }, { surfaceOp: 'append' })
  push('step/end', { turn: 2, step: 1 })
  push('turn/end', { turn: 2, reason: { kind: 'completed' } })
  void human
})
const mainHead = header('session-u3main')
validate(mainHead, mainRows, '主会话')

const subHead = header('session-u3sub', { origin: 'subagent', parentSession: 'session-u3main', delegationDepth: 1 })
const subRows = build((push) => {
  push('turn/start', { turn: 1 })
  push('request/header', { header: { config: { model: MODEL, provider: 'deepseek-official' }, tools: [] }, reason: 'initial' })
  push('step/start', { turn: 1, step: 1 })
  push('user/message', { id: 'msg-sub-u', role: 'user', content: [{ type: 'text', text: '查一下这三个文件里谁读会话' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
  push('assistant/message', { turn: 1, step: 1, message: { id: 'msg-sub-a', role: 'assistant', content: [{ type: 'text', text: '只有 usage/dsh.ts 一个读者。' }], source: modelSource }, usage: usage(30, 5, 0), stream: [] }, { surfaceOp: 'append' })
  push('step/end', { turn: 1, step: 1 })
  push('turn/end', { turn: 1, reason: { kind: 'completed' } })
})
validate(subHead, subRows, '子代理会话')

const text = (head, rows) => [JSON.stringify(head), ...rows.map(r => JSON.stringify(r))].join('\n') + '\n'
mkdirSync('out', { recursive: true })
const name = sessionFormatLogFilename(4)
writeFileSync('out/' + name, text(mainHead, mainRows))
writeFileSync('out/sub.' + name, text(subHead, subRows))
console.log('文件名 v4 =', name, '| v0 =', sessionFormatLogFilename(0))
console.log('头(主):', JSON.stringify(mainHead))
console.log('头(子):', JSON.stringify(subHead))
