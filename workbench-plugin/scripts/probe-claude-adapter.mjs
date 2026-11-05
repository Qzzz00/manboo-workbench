#!/usr/bin/env node
/**
 * **真机自测:往一条开着的 Claude 桌面会话里送一句话,再回头核一次**(2026-10-02,卡「Claude socket 适配器」)。
 *
 *   node scripts/probe-claude-adapter.mjs <sessionId> ["一句话"] [--expect reply] [--list]
 *
 * - `<sessionId>` 是 `~/.claude/sessions/<pid>.json` 里的 `sessionId`(不是 `hostSessionId`、不是 pid)。
 *   `--list` 只把登记表列出来、一个字节都不送。
 * - 走的就是 `src/server/engine/adapters/claude.ts` 本身(Node 26 自带 TS 类型剥离,直接 import `.ts`),
 *   所以这一跑验的是**要合并的那份代码**,不是脚本里另写的一套。
 * - **不读 `~/.claude/sessions/*.key`、不开窗、不开 App**。只往 socket 写一行,再读会话记录文件核。
 *
 * 结果与真机那一跑的输出贴在 `docs/交接-1002-Claude-socket适配器.md`。
 */
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'
import ts from 'typescript'

/**
 * Node 26 内置的 TS 支持只会「剥类型」,而契约文件 `src/server/engine/adapter.ts` 里有参数属性
 * (`constructor(message: string, readonly waitMs = 1200)`),剥不了(`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`)。
 * 契约不是这张卡的东西(**不许改**),所以这里拿仓库里现成的 typescript 转一道再 import ——
 * 跑的仍然是 `src/` 里要合并的那份代码,不是脚本里另写一套。
 */
registerHooks({
  load(url, context, nextLoad) {
    if (!url.startsWith('file:') || !url.endsWith('.ts')) return nextLoad(url, context)
    const source = ts.transpileModule(readFileSync(new URL(url), 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.ESNext, verbatimModuleSyntax: true },
    }).outputText
    return { format: 'module', shortCircuit: true, source }
  },
})

const {
  CLAUDE_FROM,
  claudeMessageLine,
  createClaudeAdapter,
  readClaudeSockets,
} = await import('../src/server/engine/adapters/claude.ts')

const argv = process.argv.slice(2)
const claudeHome = process.env.CLAUDE_HOME ?? join(homedir(), '.claude')

// `--expect reply` 的那个 `reply` 是旗子的值,不是位置参数(不挑出来会被当成「要送的那一句」)。
const flags = new Set()
const rest = []
let expect = 'ack'
for (let i = 0; i < argv.length; i += 1) {
  const one = argv[i]
  if (one === '--expect') { expect = argv[i + 1] ?? 'ack'; i += 1 }
  else if (one.startsWith('--')) flags.add(one)
  else rest.push(one)
}
const expectReply = expect === 'reply'
const [sessionId, said] = rest
const text = said ?? '自测:工作台在核 socket 这条路,收到不用管。'

const rows = await readClaudeSockets(claudeHome)
console.log(`登记表 ${join(claudeHome, 'sessions')} 里开着的会话 ${rows.length} 条(只读 .json):`)
for (const row of rows) {
  console.log(`  - ${row.sessionId}  pid=${row.pid}  status=${row.status ?? '?'}  peerProtocol=${row.peerProtocol ?? '?'}`)
  console.log(`    name=${row.name ?? '(没名字)'}  socket=${row.socket}  hostSessionId=${row.hostSessionId ?? '(没有)'}`)
}

if (flags.has('--list')) process.exit(0)
if (sessionId === undefined) {
  console.error('用法:node scripts/probe-claude-adapter.mjs <sessionId> ["一句话"] [--expect reply] [--list]')
  process.exit(2)
}

const job = {
  id: `probe-${Date.now()}`,
  family: 'claude',
  kind: 'answer',
  target: { kind: 'session', sessionId },
  text,
  expect: expectReply ? 'reply' : 'ack',
}

console.log(`\n要送的那一行(from=${CLAUDE_FROM},没有 auth 行):`)
console.log(`  ${claudeMessageLine(job).trim()}`)

const adapter = createClaudeAdapter({
  claudeHome,
  // 适配器缺省的等待用 unref 过的定时器(插件进程里该这样,免得挂住宿主退出);
  // 一次性脚本里 unref 的定时器留不住进程,核到一半就退了,所以这里换成普通的。
  sleep: ms => new Promise(resolve => { setTimeout(resolve, ms) }),
  ...(expectReply ? { replyMs: 60_000 } : {}),
})
console.log(`\n能力:${JSON.stringify(await adapter.capabilities())}`)

const startedMs = Date.now()
const result = await adapter.run(job)
console.log(`\n结果(等了 ${Math.round((Date.now() - startedMs) / 100) / 10} 秒):`)
console.log(JSON.stringify(result, undefined, 2))

// 送到 = confirmed;写进去了没核上 = unconfirmed;没送 = not_sent。退出码跟着,好串在别的检查里。
process.exit(result.delivered === 'confirmed' ? 0 : result.delivered === 'unconfirmed' ? 3 : 4)
