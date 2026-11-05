#!/usr/bin/env node
/**
 * **Claude 捎话探针:终端会话的 socket + claude-agent-acp 续旧会话**(2026-10-19,卡「Claude 捎话探针」)。
 *
 * 只在维护者自己这台机器上**手动**跑,只对**自己起的**那条 Claude Code 会话跑 —— 它会真往那条会话里送一句话、
 * 真花一点额度、真让 Claude 在你给的目录里建文件。不挂定时、不进测试套件、不登记进插件、不装 profile、不碰 `~/.dsh`。
 * **不读任何凭据**:`~/.claude/sessions/*.key` 一个字节都不碰;ACP 那条走这台机器上 Claude Code 自己的登录态。
 *
 * ```
 * node workbench-plugin/scripts/probe-claude-relay.ts registry                         # 登记表里有哪些会话(entrypoint / kind / socket),不发任何东西
 * node workbench-plugin/scripts/probe-claude-relay.ts socket --session <id> [--text '…']  # 问题一:照 adapters/claude.ts 的线协议写一行进它的 socket,到记录文件里核
 * node workbench-plugin/scripts/probe-claude-relay.ts acp --session <id> --cwd <dir>      # 问题二:npx claude-agent-acp → initialize → session/load → 两句 prompt(第二句要改文件)
 * node workbench-plugin/scripts/probe-claude-relay.ts acp --cwd <dir>                     # 同上,但 session/new 开新的
 *   --text1 '…' --text2 '…' --answer allow_once|reject_once|none --answer-after 3 --via load|new-resume
 *   --mode default            # 续上之后先 session/set_mode 切档(记录文件尾部的 permissionMode 是 auto 时,改文件不会问人;切成 default 才看得到 request_permission)
 * ```
 *
 * 两问各记什么(交接里就贴这几样):
 * - socket:登记表那几格(`entrypoint` / `kind` / `messagingSocketPath` / `version`)、写入到记录文件里出现那句的毫秒数、
 *   落下来的那一行长什么样(`isMeta` / `origin.kind` / `userType`)、它回了什么、回话等了多久。
 * - acp:npx 起到握手回包的毫秒数(第一次是冷启动)、`agentCapabilities.loadSession`、`session/load` 的毫秒数与回放了几条、
 *   每句 prompt 到 `stopReason` 的毫秒数、`session/request_permission` 来没来 / 带什么选项 / 答后接不接着跑、
 *   记录文件里 ACP 送进去的那句是不是普通 user turn(`isMeta` / `origin` / `entrypoint` / `turnOrigin`)、
 *   跑的时候登记表里多出来的那条(entrypoint 是什么、有没有 socket)。
 *
 * 自己带最小客户端、只用 Node 内置模块(不 import 插件源码:核的是「这台机器上这两条路通不通」,不是适配器的分支)。
 * 线协议那一行与 `src/server/engine/adapters/claude.ts` 的 `claudeMessageLine` 同形;记录文件的「送进去的话」认法与那边的
 * `claudeDeliveredLines` 同口径(`type:'user'` 的正文 / `queue-operation` 的 `enqueue`)。
 */
import { spawn } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { access, readFile, readdir } from 'node:fs/promises'
import { connect } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'

const CLAUDE_HOME = join(homedir(), '.claude')
/** 与 `adapters/claude.ts` 的 `CLAUDE_PREFIX.relay` / `CLAUDE_FROM` 同一句、同一个来路。 */
const RELAY_PREFIX = '[她本人经工作台捎话]'
const FROM = 'uds:/tmp/cc-socks/workbench.sock'
/** 钉死的包与版本(C4)。2026-10-19 npm `latest`;`@zed-industries/claude-code-acp` 已标 deprecated、指到这个名字。 */
const ACP_PACKAGE = '@agentclientprotocol/claude-agent-acp'
const ACP_VERSION = '0.93.0'
const ACP_PROTOCOL_VERSION = 1

const since = Date.now()
const stamp = (): string => `+${((Date.now() - since) / 1000).toFixed(2)}s`
const log = (line: string): void => { console.log(`${stamp()} ${line}`) }
const oneLine = (text: string, max = 160): string => text.replace(/\s+/g, ' ').slice(0, max)

function arg(name: string, fallback?: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`)
  return at >= 0 && process.argv[at + 1] !== undefined ? process.argv[at + 1] : fallback
}
const has = (flag: string): boolean => process.argv.includes(`--${flag}`)
const sleep = (ms: number): Promise<void> => new Promise(resolve => { setTimeout(resolve, ms) })

type Row = Record<string, unknown>
const asRecord = (value: unknown): Row | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value)) ? value as Row : undefined

// ───────────── 登记表(只读 .json;.key 不碰) ─────────────

interface Registry {
  file: string
  pid: number
  sessionId: string
  socket?: string
  fields: Row
}

async function readRegistry(): Promise<Registry[]> {
  const dir = join(CLAUDE_HOME, 'sessions')
  let names: string[] = []
  try { names = await readdir(dir) }
  catch { return [] }
  const out: Registry[] = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    let raw: Row | undefined
    try { raw = asRecord(JSON.parse(await readFile(join(dir, name), 'utf8'))) }
    catch { continue }
    if (raw === undefined || typeof raw.sessionId !== 'string' || typeof raw.pid !== 'number') continue
    const socketRaw = typeof raw.messagingSocketPath === 'string' ? raw.messagingSocketPath : undefined
    const socket = socketRaw === undefined ? undefined : (socketRaw.startsWith('uds:') ? socketRaw.slice(4) : socketRaw)
    // 不把 .key 的内容、也不把 token 之类的格带出来:只留我们看得懂的那几格。
    const { pid, sessionId, cwd, kind, entrypoint, version, status, name: sessionName, hostSessionId, jobId, peerProtocol, nameSource } = raw
    out.push({ file: name, pid: raw.pid, sessionId: raw.sessionId, ...(socket === undefined ? {} : { socket }), fields: { pid, sessionId, cwd, kind, entrypoint, version, status, name: sessionName, hostSessionId, jobId, peerProtocol, nameSource, messagingSocketPath: socketRaw, keys: Object.keys(raw).sort() } })
  }
  return out
}

async function statusOf(sessionId: string): Promise<string | undefined> {
  const row = (await readRegistry()).find(one => one.sessionId === sessionId)
  return typeof row?.fields.status === 'string' ? row.fields.status : undefined
}

// ───────────── 记录文件 ─────────────

async function locateTranscript(sessionId: string): Promise<string | undefined> {
  const root = join(CLAUDE_HOME, 'projects')
  let dirs: string[] = []
  try { dirs = await readdir(root) }
  catch { return undefined }
  for (const dir of dirs) {
    const file = join(root, dir, `${sessionId}.jsonl`)
    try { await access(file); return file }
    catch { /* 下一个目录 */ }
  }
  return undefined
}

async function readRows(file: string): Promise<Row[]> {
  let text: string
  try { text = await readFile(file, 'utf8') }
  catch { return [] }
  const out: Row[] = []
  for (const line of text.split('\n')) {
    const one = line.trim()
    if (one === '' || !one.startsWith('{')) continue
    try {
      const row = asRecord(JSON.parse(one))
      if (row !== undefined) out.push(row)
    }
    catch { /* 半行 */ }
  }
  return out
}

/** 一条记录的正文(`message.content` 是字串或 text 块;tool_result 整条不算)。 */
function textOf(row: Row): string | undefined {
  if (row.type === 'queue-operation') return typeof row.content === 'string' ? row.content : undefined
  const content = asRecord(row.message)?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return undefined
  const parts: string[] = []
  for (const block of content) {
    const one = asRecord(block)
    if (one === undefined) continue
    if (one.type === 'tool_result') return undefined
    if (one.type === 'text' && typeof one.text === 'string') parts.push(one.text)
  }
  return parts.length === 0 ? undefined : parts.join('\n')
}

/** 交接里要看的那几格(一行记录是「谁说的、怎么进来的」)。 */
function describe(row: Row): Row {
  const origin = asRecord(row.origin)
  return {
    type: row.type,
    ...(row.type === 'queue-operation' ? { operation: row.operation } : {}),
    isMeta: row.isMeta,
    originKind: origin?.kind,
    originFrom: origin?.from ?? origin?.sender ?? origin?.peer,
    userType: row.userType,
    entrypoint: row.entrypoint,
    turnOrigin: row.turnOrigin,
    promptSource: row.promptSource,
    timestamp: row.timestamp,
    text: oneLine(textOf(row) ?? '', 240),
  }
}

function userRowsWith(rows: readonly Row[], needle: string): Row[] {
  return rows.filter(row => (row.type === 'user' || row.type === 'queue-operation') && (textOf(row) ?? '').includes(needle))
}

function assistantTextsAfter(rows: readonly Row[], sinceMs: number): { at: string, text: string }[] {
  const out: { at: string, text: string }[] = []
  for (const row of rows) {
    if (row.type !== 'assistant') continue
    const at = typeof row.timestamp === 'string' ? row.timestamp : undefined
    if (at === undefined || Date.parse(at) <= sinceMs) continue
    const text = textOf(row)
    if (text !== undefined && text.trim() !== '') out.push({ at, text })
  }
  return out
}

// ───────────── socket(问题一) ─────────────

async function writeSocketLine(path: string, line: string, timeoutMs = 4000): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = connect(path)
    let settled = false
    const done = (error?: unknown): void => {
      if (settled) return
      settled = true
      socket.destroy()
      if (error === undefined) resolve()
      else reject(error instanceof Error ? error : new Error(String(error)))
    }
    socket.setTimeout(timeoutMs, () => { done(new Error('写 socket 超时')) })
    socket.on('error', done)
    socket.on('close', () => { done() })
    socket.on('connect', () => { socket.end(line) })
  })
}

async function runRegistry(): Promise<void> {
  const rows = await readRegistry()
  console.log(`登记表 ${join(CLAUDE_HOME, 'sessions')}:${rows.length} 条(.key 没读)`)
  for (const row of rows) console.log(JSON.stringify(row.fields, null, 0))
}

async function runSocket(): Promise<void> {
  const sessionId = arg('session')
  if (sessionId === undefined) { console.error('要 --session <sessionId>(只对你自己起的那条!)'); process.exit(1) }
  const text = arg('text', '请只回一句话:1+1 等于几?不要用任何工具。') as string
  const confirmS = Number(arg('confirm-s', '15'))
  const replyS = Number(arg('reply-s', '120'))
  const entry = (await readRegistry()).find(one => one.sessionId === sessionId)
  if (entry === undefined) { console.error(`登记表里没有 ${sessionId}`); process.exit(1) }
  log(`登记表 ${entry.file}:${JSON.stringify(entry.fields)}`)
  if (entry.socket === undefined) { console.error('这条没有 messagingSocketPath'); process.exit(1) }
  log(`socket ${entry.socket} 存在=${existsSync(entry.socket)}`)
  const file = await locateTranscript(sessionId)
  log(`记录文件 ${file ?? '(没有)'}`)
  const before = file === undefined ? [] : await readRows(file)
  const wantBefore = userRowsWith(before, text).length
  log(`送之前:记录 ${before.length} 行,含这句的 ${wantBefore} 行,status=${await statusOf(sessionId)}`)

  const line = `${JSON.stringify({ type: 'user', message: { role: 'user', content: `${RELAY_PREFIX} ${text}` }, from: FROM, msgV: 1 })}\n`
  const sentAt = Date.now()
  await writeSocketLine(entry.socket, line)
  const wroteMs = Date.now() - sentAt
  log(`写进 socket 用了 ${wroteMs}ms(${line.length} 字节)`)

  const out: Row = { sessionId, entrypoint: entry.fields.entrypoint, kind: entry.fields.kind, version: entry.fields.version, socket: entry.socket, wroteMs }
  const statuses: { ms: number, status: string | undefined }[] = [{ ms: 0, status: await statusOf(sessionId) }]
  let seenMs: number | undefined
  let seenRow: Row | undefined
  for (;;) {
    const now = Date.now() - sentAt
    const status = await statusOf(sessionId)
    if (statuses.at(-1)?.status !== status) { statuses.push({ ms: now, status }); log(`status → ${status}`) }
    const rows = file === undefined ? [] : await readRows(file)
    const mine = userRowsWith(rows, text)
    if (mine.length > wantBefore) {
      seenMs = now
      seenRow = mine.at(-1)
      break
    }
    if (now >= confirmS * 1000) break
    await sleep(100)
  }
  out.seenInTranscriptMs = seenMs
  out.seenRow = seenRow === undefined ? undefined : describe(seenRow)
  log(seenMs === undefined ? `记录文件里 ${confirmS}s 内没出现那句(hold / refuse / 没有记录)` : `记录文件里出现了:${seenMs}ms → ${JSON.stringify(describe(seenRow!))}`)

  let replyMs: number | undefined
  let reply: string | undefined
  if (seenMs !== undefined) {
    for (;;) {
      const now = Date.now() - sentAt
      const status = await statusOf(sessionId)
      if (statuses.at(-1)?.status !== status) { statuses.push({ ms: now, status }); log(`status → ${status}`) }
      const rows = file === undefined ? [] : await readRows(file)
      const replies = assistantTextsAfter(rows, sentAt)
      if (replies.length > 0 && status !== 'busy') {
        replyMs = now
        reply = replies.map(one => one.text).join('\n⏎ ')
        break
      }
      if (now >= replyS * 1000) {
        if (replies.length > 0) { replyMs = now; reply = replies.map(one => one.text).join('\n⏎ ') }
        break
      }
      await sleep(250)
    }
  }
  out.replyMs = replyMs
  out.reply = reply
  out.statuses = statuses
  log(reply === undefined ? `没等到回话(${replyS}s)` : `它回了(${replyMs}ms):${oneLine(reply, 300)}`)
  console.log('\n=== socket 结果 ===')
  console.log(JSON.stringify(out, null, 2))
}

// ───────────── ACP(问题二):最小 JSON-RPC stdio 客户端 ─────────────

interface Pending { settle: (value: unknown) => void, fail: (error: Error) => void, timer: ReturnType<typeof setTimeout> }

/** 起子进程时把本会话(这台 Claude Code)的环境剥干净:嵌在另一条 Claude 会话里起 claude 会被认成子会话。 */
function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (key === 'CLAUDECODE' || key.startsWith('CLAUDE_') || key === 'CLAUDE_PID') continue
    env[key] = value
  }
  return env
}

function findNpx(): string {
  for (const dir of (process.env.PATH ?? '').split(':')) if (dir !== '' && existsSync(`${dir}/npx`)) return `${dir}/npx`
  for (const one of ['/opt/homebrew/bin/npx', '/usr/local/bin/npx']) if (existsSync(one)) return one
  return 'npx'
}

async function runAcp(): Promise<void> {
  const sessionId = arg('session')
  const cwd = arg('cwd', process.cwd()) as string
  const text1 = arg('text1', '上一轮你做了什么?一句话说清,不要用任何工具。') as string
  const text2 = arg('text2', '在当前目录新建 probe-acp.txt,里面写一句问候。做完用一句话说明做了什么。') as string
  const answer = arg('answer', 'allow_once') as string
  const answerAfterMs = Number(arg('answer-after', '3')) * 1000
  const via = arg('via', 'load') as string
  const mode = arg('mode')
  const npx = findNpx()
  const out: Row = { package: `${ACP_PACKAGE}@${ACP_VERSION}`, npx, cwd, sessionId, via }

  const registryBefore = new Set((await readRegistry()).map(one => one.file))
  const stderr: string[] = []
  const updates = new Map<string, number>()
  let agentText = ''
  const permissionAsks: Row[] = []
  const pending = new Map<number, Pending>()
  let nextId = 1
  let buffer = ''
  let gone: string | undefined

  log(`起 ${npx} -y ${ACP_PACKAGE}@${ACP_VERSION}(cwd=${cwd})`)
  const t0 = Date.now()
  const child = spawn(npx, ['-y', `${ACP_PACKAGE}@${ACP_VERSION}`], { cwd, env: cleanEnv(), stdio: ['pipe', 'pipe', 'pipe'] })
  child.stdin!.on('error', error => { gone = error.message })
  child.stderr!.on('data', chunk => { for (const line of String(chunk).split('\n')) if (line.trim() !== '') { stderr.push(line); log(`[stderr] ${oneLine(line, 200)}`) } })
  child.on('exit', (code, signal) => { gone = `退出 ${code ?? signal}`; for (const [, flight] of pending) { clearTimeout(flight.timer); flight.fail(new Error(gone)) } pending.clear() })

  const write = (message: unknown): void => { child.stdin!.write(`${JSON.stringify(message)}\n`) }
  const request = <T = unknown>(method: string, params: unknown, timeoutMs: number): Promise<T> => new Promise<T>((resolve, reject) => {
    if (gone !== undefined) { reject(new Error(gone)); return }
    const id = nextId++
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} ${timeoutMs}ms 没回`)) }, timeoutMs)
    pending.set(id, { settle: value => resolve(value as T), fail: reject, timer })
    write({ jsonrpc: '2.0', id, method, params })
  })

  /** 它反过来问我们:只接 `session/request_permission`;别的一律 -32601。 */
  const answerRequest = (id: unknown, method: string, params: Row): void => {
    if (method !== 'session/request_permission') {
      log(`它问 ${method} → 不接(-32601)`)
      write({ jsonrpc: '2.0', id, error: { code: -32601, message: `探针不接 ${method}` } })
      return
    }
    const toolCall = asRecord(params.toolCall) ?? {}
    const options = Array.isArray(params.options) ? params.options.map(one => asRecord(one) ?? {}) : []
    const ask: Row = { atMs: Date.now() - t0, title: toolCall.title, kind: toolCall.kind, toolCallId: toolCall.toolCallId, options: options.map(one => ({ optionId: one.optionId, name: one.name, kind: one.kind })) }
    permissionAsks.push(ask)
    log(`它在问权限:${JSON.stringify(ask)}`)
    if (answer === 'none') { log('(--answer none:不答,看它等)'); return }
    const pick = options.find(one => one.kind === answer) ?? options.find(one => one.optionId === answer)
    setTimeout(() => {
      if (pick === undefined) {
        log(`没有 kind/optionId=${answer} 的选项 → 回 cancelled`)
        write({ jsonrpc: '2.0', id, result: { outcome: { outcome: 'cancelled' } } })
        ask.answered = 'cancelled'
        return
      }
      write({ jsonrpc: '2.0', id, result: { outcome: { outcome: 'selected', optionId: pick.optionId } } })
      ask.answered = pick.optionId
      ask.answeredAtMs = Date.now() - t0
      log(`答了 ${String(pick.optionId)}(${String(pick.name)})`)
    }, answerAfterMs)
  }

  const take = (line: string): void => {
    const text = line.trim()
    if (text === '') return
    let message: Row | undefined
    try { message = asRecord(JSON.parse(text)) }
    catch { log(`[stdout 非 JSON] ${oneLine(text, 200)}`); return }
    if (message === undefined) return
    const params = asRecord(message.params) ?? {}
    if (typeof message.method === 'string' && message.id !== undefined && message.id !== null) { answerRequest(message.id, message.method, params); return }
    if (typeof message.method === 'string') {
      if (message.method === 'session/update') {
        const update = asRecord(params.update) ?? {}
        const kind = typeof update.sessionUpdate === 'string' ? update.sessionUpdate : '?'
        updates.set(kind, (updates.get(kind) ?? 0) + 1)
        const content = asRecord(update.content)
        if (kind === 'agent_message_chunk' && content?.type === 'text' && typeof content.text === 'string') agentText += content.text
        if (kind === 'tool_call' || kind === 'tool_call_update') log(`[update] ${kind} ${String(update.title ?? '')} ${String(update.status ?? '')}`)
      }
      else log(`[notify] ${message.method} ${oneLine(JSON.stringify(params), 200)}`)
      return
    }
    if (typeof message.id !== 'number') return
    const flight = pending.get(message.id)
    if (flight === undefined) return
    pending.delete(message.id)
    clearTimeout(flight.timer)
    if (message.error !== undefined && message.error !== null) { flight.fail(new Error(`它回错误:${JSON.stringify(message.error)}`)); return }
    flight.settle(message.result)
  }
  child.stdout!.on('data', (chunk) => {
    buffer += String(chunk)
    let index = buffer.indexOf('\n')
    while (index >= 0) { take(buffer.slice(0, index)); buffer = buffer.slice(index + 1); index = buffer.indexOf('\n') }
  })

  const finish = async (): Promise<never> => {
    out.stderrLines = stderr.length
    out.updates = Object.fromEntries(updates)
    out.permissionAsks = permissionAsks
    const registryAfter = await readRegistry()
    const fresh = registryAfter.filter(one => !registryBefore.has(one.file))
    out.registryDuringRun = fresh.map(one => one.fields)
    log(`跑的时候登记表多出 ${fresh.length} 条:${JSON.stringify(fresh.map(one => ({ entrypoint: one.fields.entrypoint, kind: one.fields.kind, socket: one.socket, sessionId: one.sessionId })))}`)
    child.kill()
    await sleep(500)
    const after = (await readRegistry()).filter(one => !registryBefore.has(one.file))
    out.registryLeftAfterClose = after.length
    console.log('\n=== acp 结果 ===')
    console.log(JSON.stringify(out, null, 2))
    process.exit(0)
  }

  try {
    const hello = await request<Row>('initialize', {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: 'probe-claude-relay', version: '1' },
    }, 240_000)
    out.handshakeMs = Date.now() - t0
    out.agentCapabilities = hello.agentCapabilities
    out.authMethods = hello.authMethods
    out.agentInfo = hello.agentInfo
    log(`握手 ${out.handshakeMs}ms · ${JSON.stringify({ protocolVersion: hello.protocolVersion, agentInfo: hello.agentInfo, agentCapabilities: hello.agentCapabilities, authMethods: hello.authMethods })}`)
    const caps = asRecord(hello.agentCapabilities) ?? {}

    let acpSessionId: string | undefined
    const replayBefore = new Map(updates)
    if (sessionId !== undefined && via === 'load') {
      log(`session/load {sessionId:${sessionId}, cwd}(loadSession=${String(caps.loadSession)})`)
      const t1 = Date.now()
      try {
        const loaded = await request<Row>('session/load', { sessionId, cwd, mcpServers: [] }, 120_000)
        out.loadMs = Date.now() - t1
        out.loadResult = loaded
        acpSessionId = sessionId
        const replayed: Row = {}
        for (const [kind, count] of updates) replayed[kind] = count - (replayBefore.get(kind) ?? 0)
        out.loadReplayed = replayed
        log(`load ${out.loadMs}ms · 回包 ${JSON.stringify(loaded)} · 回放 ${JSON.stringify(replayed)}`)
      }
      catch (error) {
        out.loadError = error instanceof Error ? error.message : String(error)
        log(`load 失败:${out.loadError}`)
      }
    }
    if (acpSessionId === undefined) {
      // 续不上(或没给 --session / --via new-resume):走 session/new;给了 --session 就带 `_meta.claudeCode.options.resume`(它文档里的 per-call 控制)。
      const meta = sessionId === undefined ? {} : { _meta: { claudeCode: { options: { resume: sessionId } } } }
      log(`session/new {cwd, mcpServers:[]${sessionId === undefined ? '' : ', _meta.claudeCode.options.resume'}}`)
      const t1 = Date.now()
      const made = await request<Row>('session/new', { cwd, mcpServers: [], ...meta }, 120_000)
      out.newMs = Date.now() - t1
      out.newResult = { sessionId: made.sessionId, modes: made.modes, models: made.models === undefined ? undefined : '(有)' }
      acpSessionId = typeof made.sessionId === 'string' ? made.sessionId : undefined
      log(`new ${out.newMs}ms · ${JSON.stringify(out.newResult)}`)
      if (acpSessionId === undefined) throw new Error('session/new 没给 sessionId')
    }
    out.acpSessionId = acpSessionId
    if (mode !== undefined) {
      // 续上来的档是它记录文件尾部那一行 `permissionMode`(这台机器上是 auto);要看它问不问人,先切档。
      const t1 = Date.now()
      const switched = await request<Row>('session/set_mode', { sessionId: acpSessionId, modeId: mode }, 30_000)
      out.setModeMs = Date.now() - t1
      out.setModeResult = switched
      log(`session/set_mode ${mode} ${out.setModeMs}ms · ${JSON.stringify(switched)}`)
    }

    const prompt = async (label: string, text: string): Promise<Row> => {
      agentText = ''
      const t1 = Date.now()
      const asksBefore = permissionAsks.length
      log(`[${label}] session/prompt「${text}」`)
      let firstChunkMs: number | undefined
      const watch = setInterval(() => { if (firstChunkMs === undefined && agentText !== '') firstChunkMs = Date.now() - t1 }, 50)
      let result: Row
      try { result = await request<Row>('session/prompt', { sessionId: acpSessionId, prompt: [{ type: 'text', text }] }, 600_000) }
      finally { clearInterval(watch) }
      const ms = Date.now() - t1
      const one: Row = { ms, firstChunkMs, stopReason: result.stopReason, text: oneLine(agentText, 400), permissionAsks: permissionAsks.length - asksBefore }
      log(`[${label}] stopReason=${String(result.stopReason)} ${ms}ms(首字 ${firstChunkMs ?? '-'}ms)· 它说:${oneLine(agentText, 300)}`)
      return one
    }
    out.prompt1 = await prompt('第一句', text1)
    const filesBefore = new Set(readdirSync(cwd))
    out.prompt2 = await prompt('第二句', text2)
    const made = readdirSync(cwd).filter(one => !filesBefore.has(one))
    out.filesMade = made
    log(`目录里多了:${JSON.stringify(made)}`)

    // 记录文件:ACP 送进去的那两句落成什么样的记录(是不是普通 user turn)。
    await sleep(1500)
    const file = await locateTranscript(acpSessionId)
    out.transcript = file
    if (file === undefined) log(`没找到 ${acpSessionId} 的记录文件`)
    else {
      const rows = await readRows(file)
      const mine = [...userRowsWith(rows, text1), ...userRowsWith(rows, text2)].map(describe)
      out.transcriptRows = rows.length
      out.promptRows = mine
      const entrypoints = new Set(rows.map(row => row.entrypoint).filter(one => typeof one === 'string'))
      out.transcriptEntrypoints = [...entrypoints]
      log(`记录 ${file}:${rows.length} 行,entrypoint 出现过 ${JSON.stringify([...entrypoints])}`)
      for (const row of mine) log(`  送进去的那句:${JSON.stringify(row)}`)
    }
  }
  catch (error) {
    out.error = error instanceof Error ? error.message : String(error)
    log(`出错:${out.error}`)
  }
  await finish()
}

async function main(): Promise<void> {
  const mode = process.argv[2]
  if (mode === 'registry') return runRegistry()
  if (mode === 'socket') return runSocket()
  if (mode === 'acp') return runAcp()
  console.error('用法:probe-claude-relay.ts registry | socket --session <id> [--text …] | acp [--session <id>] --cwd <dir> [--text1 … --text2 … --answer allow_once --answer-after 3 --via load|new-resume]')
  process.exit(1)
}

void main().catch((error) => { console.error(error); process.exit(1) })
