#!/usr/bin/env node
/**
 * **DSH 自带的进程外口(`dsh --profile acp`)探针**(2026-10-19,架构评审稿 v2 表 5-1 的三条「先验」)。
 *
 * 只在维护者自己这台机器上**手动**跑:它真起一个 DSH 进程(ACP 档)、真开会话、真花一点额度、
 * 真在你给的目录里让它新建文件。不挂定时、不进测试套件、不登记进插件、不改 `~/.dsh` 下任何已有文件。
 *
 * **怎么不碰 `~/.dsh` 的配置**:`dsh --profile acp` 第一次跑会在 `$DSH_HOME/profiles/acp/` 落三个文件,
 * 所以本脚本要求你给一个**临时 DSH_HOME**(`--home`),里面只放两条软链:`sessions → ~/.dsh/sessions`
 * (问题三要看会话是不是落在同一处)、`.env → ~/.dsh/.env`(模型服务的令牌由它供给,脚本不读不印)。
 * 模型路由用 `--patch` 覆盖层指到工作台中转(acp 包缺省是 deepseek-official,这台机器没有那把钥匙)。
 *
 * ```
 * node workbench-plugin/scripts/probe-dsh-acp.ts --home /tmp/x/dsh-home --patch /tmp/x/overlay.yml --cwd /tmp/x/work \
 *   --case perm --mode read-only            # 问题一:不许改文件那档,看 session/request_permission 来不来、答 allow-once 后文件建没建
 * node … --case perm --mode workspace-write # 问题一:许改那档,看它问不问
 * node … --case ask                         # 问题二:挂一个 stdio MCP(本文件自己当服务,露一个 ask 工具),看它调不调
 * node … --case ask-bare                    # 问题二对照:不挂 MCP,看它怎么处理「要问人」
 * node … --case resume --session <id>       # 问题三:换一个 acp 进程,session/list 列不列得回、session/resume 续不续得上
 * node … --serve-mcp <调用记录文件> [固定答案]  # (被 DSH 起的)MCP 服务模式,不手动跑
 * ```
 *
 * 记的几样:起进程到握手耗时、prompt 到 request_permission 耗时与选项、答后到 stopReason 耗时、文件建没建、
 * session/update 里每一条长什么样、会话目录落在哪、session/list 列回什么、stderr 行数。
 *
 * 只用 Node 内置模块,`node` 直接跑 .ts(strip-only)。协议对照 ~/.dsh/runtime/node_modules/@agentclientprotocol/sdk/schema/schema.json(1.4.0)
 * 与上游 packages/acp/acp/src/index.ts(0.1.7-rc.2)。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'

// ---------- 参数 ----------

function arg(name: string, fallback?: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`)
  return at >= 0 && process.argv[at + 1] !== undefined && !process.argv[at + 1]!.startsWith('--') ? process.argv[at + 1] : fallback
}

const since = Date.now()
const stamp = (): string => `+${((Date.now() - since) / 1000).toFixed(2)}s`
const log = (line: string): void => { console.log(`${stamp()} ${line}`) }
const short = (value: unknown, max = 160): string => {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return (text ?? '').replace(/\n/g, ' ⏎ ').slice(0, max)
}

// ---------- 模式二:被 DSH 起来当 MCP 服务(stdio,ndjson) ----------

function serveMcp(logFile: string, answer: string): void {
  const record = (line: string): void => { appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`) }
  const reply = (id: unknown, result: unknown): void => { process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`) }
  const refuse = (id: unknown, code: number, message: string): void => { process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`) }
  record('[起] MCP 服务起来了')
  createInterface({ input: process.stdin }).on('line', (line) => {
    if (line.trim() === '') return
    let message: { id?: unknown, method?: string, params?: { protocolVersion?: string, name?: string, arguments?: unknown } }
    try { message = JSON.parse(line) as typeof message }
    catch { record(`[坏行] ${line.slice(0, 200)}`); return }
    record(`[收] ${line.slice(0, 600)}`)
    if (message.method === undefined) return
    if (message.id === undefined) return // 通知(notifications/initialized 等)不回
    switch (message.method) {
      case 'initialize':
        reply(message.id, {
          protocolVersion: message.params?.protocolVersion ?? '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'probe-ask', version: '1' },
        })
        return
      case 'ping':
        reply(message.id, {})
        return
      case 'tools/list':
        reply(message.id, {
          tools: [{
            name: 'ask',
            description: '向用户提一个问题并给出几个选项,等用户选;返回用户选中的那一项的原文。需要用户做选择、拿不准该做哪一件时必须用它,不要自己猜。',
            inputSchema: {
              type: 'object',
              properties: {
                question: { type: 'string', description: '问用户的那句话' },
                options: { type: 'array', items: { type: 'string' }, description: '给用户选的几项' },
              },
              required: ['question', 'options'],
            },
          }],
        })
        return
      case 'tools/call':
        record(`[调用] ${message.params?.name} ${JSON.stringify(message.params?.arguments)}`)
        if (message.params?.name !== 'ask') { refuse(message.id, -32602, `没有这个工具:${message.params?.name}`); return }
        reply(message.id, { content: [{ type: 'text', text: answer }] })
        return
      default:
        refuse(message.id, -32601, `不接 ${message.method}`)
    }
  })
  process.stdin.on('end', () => { record('[关] stdin 关了'); process.exit(0) })
}

// ---------- 模式一:ACP 客户端 ----------

interface Pending { settle: (value: unknown) => void, fail: (error: Error) => void, timer: ReturnType<typeof setTimeout> }
interface Note { method: string, params: Record<string, unknown> }

interface Peer {
  child: ChildProcess
  request: <T = unknown>(method: string, params: unknown, timeoutMs: number) => Promise<T>
  notify: (method: string, params: unknown) => void
  onNote: (listen: (note: Note) => void) => void
  onAsk: (handle: (method: string, params: Record<string, unknown>) => Promise<unknown>) => void
  stderrLines: string[]
  kill: () => void
}

function spawnDshAcp(input: { home: string, patches: string[], cwd: string, mode: string, stderrFile: string }): Peer {
  const dshHome = join(homedir(), '.dsh')
  const node = join(dshHome, 'node', 'bin', 'node')
  const bin = join(dshHome, 'runtime', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  // 环境照 ~/.dsh/bin/dsh-start(只读它):自有 node、同一条 PATH、关遥测;DSH_HOME 换成临时家;权限档由 --mode 给。
  const env: NodeJS.ProcessEnv = {
    HOME: homedir(),
    USER: process.env.USER ?? '',
    LANG: process.env.LANG ?? 'zh_CN.UTF-8',
    TMPDIR: process.env.TMPDIR ?? '/tmp',
    DSH_HOME: input.home,
    DSH_NODE: node,
    PATH: `${join(dshHome, 'node', 'bin')}:${join(dshHome, 'advisors', 'bin')}:${join(homedir(), '.local', 'bin')}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
    DSH_TELEMETRY_DISABLED: '1',
    DSH_PERMISSION_MODE: input.mode,
  }
  const args = [bin, '--profile', 'acp', ...input.patches.flatMap(file => ['--patch', file])]
  log(`起进程:${node} ${args.join(' ')}  (DSH_HOME=${input.home} DSH_PERMISSION_MODE=${input.mode} cwd=${input.cwd})`)
  const child = spawn(node, args, { env, cwd: input.cwd, stdio: ['pipe', 'pipe', 'pipe'] })
  const pending = new Map<number, Pending>()
  const watchers: ((note: Note) => void)[] = []
  let asker: ((method: string, params: Record<string, unknown>) => Promise<unknown>) | undefined
  let nextId = 1
  const stderrLines: string[] = []
  child.stderr!.on('data', (chunk) => {
    for (const line of String(chunk).split('\n')) {
      if (line.trim() === '') continue
      stderrLines.push(line)
      appendFileSync(input.stderrFile, `${line}\n`)
    }
  })
  child.stdin!.on('error', error => log(`stdin 出错:${error.message}`))
  child.on('exit', (code, signal) => {
    log(`进程退出:code=${code} signal=${signal}`)
    for (const [, flight] of pending) { clearTimeout(flight.timer); flight.fail(new Error(`进程退出(${code ?? signal})`)) }
    pending.clear()
  })
  const write = (message: unknown): void => { child.stdin!.write(`${JSON.stringify(message)}\n`) }
  createInterface({ input: child.stdout! }).on('line', (line) => {
    if (line.trim() === '') return
    let message: { id?: unknown, method?: string, params?: unknown, result?: unknown, error?: { code?: number, message?: string } }
    try { message = JSON.parse(line) as typeof message }
    catch { log(`stdout 非 JSON:${line.slice(0, 200)}`); return }
    const params = (typeof message.params === 'object' && message.params !== null) ? message.params as Record<string, unknown> : {}
    if (message.method !== undefined && message.id !== undefined && message.id !== null) {
      // 它反过来问我们(session/request_permission)
      const id = message.id
      const ask = asker
      if (ask === undefined) { write({ jsonrpc: '2.0', id, error: { code: -32601, message: '探针不接这个' } }); return }
      void ask(message.method, params).then(
        result => write({ jsonrpc: '2.0', id, result }),
        (error: Error) => write({ jsonrpc: '2.0', id, error: { code: -32603, message: error.message } }),
      )
      return
    }
    if (message.method !== undefined) {
      for (const watch of watchers) watch({ method: message.method, params })
      return
    }
    if (typeof message.id !== 'number') return
    const flight = pending.get(message.id)
    if (flight === undefined) return
    pending.delete(message.id)
    clearTimeout(flight.timer)
    if (message.error !== undefined && message.error !== null) {
      flight.fail(new Error(`${message.error.code ?? '?'} ${message.error.message ?? JSON.stringify(message.error)}`))
      return
    }
    flight.settle(message.result)
  })
  return {
    child,
    request: <T,>(method: string, params: unknown, timeoutMs: number): Promise<T> => new Promise<T>((settle, fail) => {
      const id = nextId++
      const timer = setTimeout(() => { pending.delete(id); fail(new Error(`${method} 超时(${timeoutMs}ms 没回)`)) }, timeoutMs)
      pending.set(id, { settle: value => settle(value as T), fail, timer })
      write({ jsonrpc: '2.0', id, method, params })
    }),
    notify: (method, params) => write({ jsonrpc: '2.0', method, params }),
    onNote: (listen) => { watchers.push(listen) },
    onAsk: (handle) => { asker = handle },
    stderrLines,
    kill: () => { child.kill() },
  }
}

// ---------- 记录 ----------

interface Numbers {
  case: string
  mode: string
  sessionId?: string
  handshakeMs?: number
  newSessionMs?: number
  agentCapabilities?: unknown
  configOptionsSummary?: string
  promptToStopMs?: number
  stopReason?: string
  promptError?: string
  permissionAsks: { atMs: number, options: unknown, toolCallId: unknown, toolTitle?: string, toolInput?: unknown, answered?: string, answeredAtMs?: number }[]
  updates: { atMs: number, kind: string, text: string }[]
  updateCounts: Record<string, number>
  toolCalls: { id: unknown, title: string, input: unknown, status?: string, result?: string }[]
  fileMade?: boolean
  fileContent?: string
  sessionDir?: string
  sessionDirFiles?: string[]
  listBeforeClose?: unknown
  listAfterClose?: unknown
  resumeMs?: number
  reply?: string
  mcpCalls?: string[]
  answerFile?: string
  stderrLines: number
  stderrTail: string[]
}

function findSessionDir(home: string, sessionId: string): string | undefined {
  const root = join(home, 'sessions')
  if (!existsSync(root)) return undefined
  for (const project of readdirSync(root)) {
    const dir = join(root, project, sessionId)
    if (existsSync(dir)) return dir
  }
  return undefined
}

async function main(): Promise<void> {
  const home = arg('home')
  const cwd = arg('cwd')
  const which = arg('case', 'perm')!
  const mode = arg('mode', 'workspace-write')!
  const answer = arg('answer', 'allow-once')!
  const answerAfterMs = Number(arg('answer-after', '2')) * 1000
  const turnTimeoutMs = Number(arg('turn-timeout', '300')) * 1000
  const patches = process.argv.flatMap((one, at) => one === '--patch' && process.argv[at + 1] !== undefined ? [resolve(process.argv[at + 1]!)] : [])
  if (home === undefined || cwd === undefined) { console.error('要 --home <临时 DSH_HOME> 与 --cwd <会话目录>'); process.exit(2) }
  if (!existsSync(join(home, 'sessions'))) { console.error(`${home}/sessions 不存在(要软链到 ~/.dsh/sessions)`); process.exit(2) }
  mkdirSync(cwd, { recursive: true })
  const logsDir = join(home, 'probe-logs')
  mkdirSync(logsDir, { recursive: true })
  const runTag = `${which}-${mode}-${Date.now()}`
  const out: Numbers = { case: which, mode, permissionAsks: [], updates: [], updateCounts: {}, toolCalls: [], stderrLines: 0, stderrTail: [] }
  const peer = spawnDshAcp({ home, patches, cwd, mode, stderrFile: join(logsDir, `${runTag}.stderr.log`) })
  let promptAt = 0

  peer.onNote((note) => {
    if (note.method !== 'session/update') { log(`通知 ${note.method} ${short(note.params)}`); return }
    const update = note.params.update as Record<string, unknown> | undefined
    const kind = String(update?.sessionUpdate ?? '?')
    out.updateCounts[kind] = (out.updateCounts[kind] ?? 0) + 1
    const atMs = promptAt === 0 ? 0 : Date.now() - promptAt
    let text = ''
    if (kind === 'agent_message_chunk' || kind === 'agent_thought_chunk') {
      const content = update?.content as { text?: string } | undefined
      text = content?.text ?? ''
    } else if (kind === 'tool_call') {
      text = `${String(update?.title)} ${short(update?.rawInput, 200)}`
      out.toolCalls.push({ id: update?.toolCallId, title: String(update?.title), input: update?.rawInput })
    } else if (kind === 'tool_call_update') {
      const content = update?.content as { content?: { text?: string } }[] | undefined
      const result = (content ?? []).map(one => one.content?.text ?? '').join(' ')
      text = `${String(update?.status)} ${short(result, 300)}`
      const call = out.toolCalls.find(one => one.id === update?.toolCallId)
      if (call !== undefined) { call.status = String(update?.status); call.result = short(result, 500) }
    } else {
      text = short(update, 200)
    }
    if (kind !== 'agent_thought_chunk') log(`[update] ${kind} ${short(text, 300)}`)
    out.updates.push({ atMs, kind, text: short(text, 500) })
  })
  peer.onAsk(async (method, params) => {
    const atMs = Date.now() - promptAt
    const toolCall = params.toolCall as { toolCallId?: unknown } | undefined
    const known = out.toolCalls.find(one => one.id === toolCall?.toolCallId)
    const record: Numbers['permissionAsks'][number] = { atMs, options: params.options, toolCallId: toolCall?.toolCallId, toolTitle: known?.title, toolInput: known?.input }
    out.permissionAsks.push(record)
    log(`[它在问] ${method} toolCall=${short(params.toolCall)} options=${short(params.options)} ← 对应工具 ${known?.title ?? '(没对上)'} ${short(known?.input, 120)}`)
    if (method !== 'session/request_permission') throw new Error(`探针不接 ${method}`)
    if (answer === 'none') { log('(--answer none:不答,看它等多久)'); await new Promise(() => { /* 永不答 */ }) }
    await new Promise(done => setTimeout(done, answerAfterMs))
    record.answered = answer
    record.answeredAtMs = Date.now() - promptAt
    log(`[替她答] ${answer}`)
    return { outcome: { outcome: 'selected', optionId: answer } }
  })

  const t0 = Date.now()
  try {
    const hello = await peer.request<{ agentCapabilities?: unknown, agentInfo?: unknown }>('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: 'probe-dsh-acp', version: '1' },
    }, 120_000)
    out.handshakeMs = Date.now() - t0
    out.agentCapabilities = hello.agentCapabilities
    log(`握手 ${out.handshakeMs}ms · agentInfo=${short(hello.agentInfo)} · 能力=${short(hello.agentCapabilities, 300)}`)

    const mcpServers = which === 'ask'
      ? [{ name: 'workbench', command: process.execPath, args: [resolve(process.argv[1]!), '--serve-mcp', join(logsDir, `${runTag}.mcp-calls.log`), arg('mcp-answer', 'B')!], env: [] }]
      : []
    const summarizeOptions = (options: unknown): string => {
      if (!Array.isArray(options)) return short(options)
      return options.map((one: { id?: unknown, currentValue?: unknown, options?: unknown[] }) => `${String(one.id)}=${String(one.currentValue)}(${Array.isArray(one.options) ? one.options.length : '?'} 项)`).join(' ')
    }

    let sessionId: string
    const resumeId = arg('session')
    if (which === 'resume') {
      if (resumeId === undefined) { console.error('--case resume 要 --session <id>'); process.exit(2) }
      const listed = await peer.request<{ sessions?: { sessionId: string, cwd: string }[] }>('session/list', { cwd }, 60_000)
      out.listBeforeClose = listed
      log(`session/list(cwd 过滤)→ ${listed.sessions?.length ?? 0} 条:${short(listed.sessions, 400)} · 含目标:${listed.sessions?.some(one => one.sessionId === resumeId) === true}`)
      const t1 = Date.now()
      const resumed = await peer.request<{ configOptions?: unknown }>('session/resume', { sessionId: resumeId, cwd, mcpServers: [] }, 120_000)
      out.resumeMs = Date.now() - t1
      sessionId = resumeId
      log(`session/resume ${out.resumeMs}ms · configOptions:${summarizeOptions(resumed.configOptions)}`)
    } else {
      const t1 = Date.now()
      const made = await peer.request<{ sessionId: string, configOptions?: unknown }>('session/new', { cwd, mcpServers }, 120_000)
      out.newSessionMs = Date.now() - t1
      sessionId = made.sessionId
      out.configOptionsSummary = summarizeOptions(made.configOptions)
      log(`session/new ${out.newSessionMs}ms · sessionId=${sessionId} · configOptions:${out.configOptionsSummary}`)
    }
    out.sessionId = sessionId

    const text = arg('text') ?? (
      which === 'perm' ? '在当前目录新建 probe.txt 写一行 hello。做完只回一句话说明做了什么。'
        : which === 'resume' ? '上一轮你做了什么?一句话,不要再动文件。'
          : '问我今天先做哪一件:A 还是 B,然后按我的回答把选中的那一项写进当前目录的 answer.txt。做完只回一句话。')
    const before = new Set(readdirSync(cwd))
    log(`prompt → ${text}`)
    promptAt = Date.now()
    try {
      const done = await peer.request<{ stopReason?: string }>('session/prompt', { sessionId, prompt: [{ type: 'text', text }] }, turnTimeoutMs)
      out.promptToStopMs = Date.now() - promptAt
      out.stopReason = done.stopReason
      log(`stopReason=${done.stopReason} · prompt→stop ${out.promptToStopMs}ms`)
    } catch (error) {
      out.promptToStopMs = Date.now() - promptAt
      out.promptError = (error as Error).message
      log(`prompt 失败/超时:${out.promptError} → 发 session/cancel`)
      peer.notify('session/cancel', { sessionId })
      await new Promise(done => setTimeout(done, 3000))
    }
    out.reply = out.updates.filter(one => one.kind === 'agent_message_chunk').map(one => one.text).join('').slice(0, 600)
    const fresh = readdirSync(cwd).filter(one => !before.has(one))
    out.fileMade = fresh.length > 0
    if (fresh.length > 0) {
      log(`目录里新出现:${fresh.join(', ')}`)
      const first = join(cwd, fresh[0]!)
      try { if (statSync(first).isFile()) out.fileContent = readFileSync(first, 'utf8').slice(0, 200) } catch { /* 不是文件 */ }
    } else log('目录里没有新文件')
    if (which === 'ask') {
      const callsFile = join(logsDir, `${runTag}.mcp-calls.log`)
      out.mcpCalls = existsSync(callsFile) ? readFileSync(callsFile, 'utf8').split('\n').filter(line => line.includes('[调用]') || line.includes('[起]')) : ['(MCP 服务没被起来:没有调用记录文件)']
      log(`MCP 调用记录:${out.mcpCalls.join(' | ')}`)
      const answerFile = join(cwd, 'answer.txt')
      out.answerFile = existsSync(answerFile) ? readFileSync(answerFile, 'utf8').slice(0, 200) : undefined
    }

    const dir = findSessionDir(home, sessionId)
    out.sessionDir = dir
    out.sessionDirFiles = dir === undefined ? [] : readdirSync(dir)
    log(`会话目录:${dir ?? '(没找到)'} · 文件:${out.sessionDirFiles.join(', ')}`)

    // 列表只记个数、前三条、含不含本会话、按 cwd 分几堆(整张表几十条,不进交接)。
    const summarizeList = (listed: { sessions?: { sessionId?: string, cwd?: string }[] }): unknown => {
      const rows = listed.sessions ?? []
      const byCwd: Record<string, number> = {}
      for (const row of rows) byCwd[row.cwd ?? '?'] = (byCwd[row.cwd ?? '?'] ?? 0) + 1
      return { count: rows.length, hasThis: rows.some(one => one.sessionId === sessionId), first3: rows.slice(0, 3), byCwd }
    }
    const listedActive = await peer.request<{ sessions?: { sessionId?: string, cwd?: string }[] }>('session/list', {}, 60_000)
    out.listBeforeClose = summarizeList(listedActive)
    log(`session/list(会话还开着,不过滤)→ ${short(out.listBeforeClose, 400)}`)
    await peer.request('session/close', { sessionId }, 60_000)
    log('session/close 回了')
    const listedClosed = await peer.request<{ sessions?: { sessionId?: string, cwd?: string }[] }>('session/list', { cwd }, 60_000)
    out.listAfterClose = summarizeList(listedClosed)
    log(`session/list(关掉后,cwd 过滤)→ ${short(out.listAfterClose, 400)}`)
  } catch (error) {
    log(`出错:${(error as Error).message}`)
    out.promptError ??= (error as Error).message
  } finally {
    out.stderrLines = peer.stderrLines.length
    out.stderrTail = peer.stderrLines.slice(-8).map(line => line.slice(0, 200))
    peer.kill()
  }
  console.log('\n=== 数字 ===')
  console.log(JSON.stringify(out, null, 2))
  process.exit(0)
}

if (process.argv.includes('--serve-mcp')) {
  const at = process.argv.indexOf('--serve-mcp')
  serveMcp(process.argv[at + 1] ?? '/dev/null', process.argv[at + 2] ?? 'B')
} else {
  void main().catch((error) => { console.error(error); process.exit(1) })
}
