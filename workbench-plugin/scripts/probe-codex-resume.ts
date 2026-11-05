#!/usr/bin/env node
/**
 * **Codex 续线程探针**(2026-10-19,卡「1019 codex 续线程探针」;交接 `docs/交接-1019-codex续线程探针.md`)。
 *
 * 三个问题,各在真机上跑一遍、记毫秒:
 *
 * 1. `codex exec` 派活起的那条线程,能不能经 `codex app-server` 的 `thread/resume` + `turn/start` 续上
 *    (它记不记得上一轮、改没改文件、要多久;她的 Codex App 握着同一条时写锁那句原话);
 * 2. 回合进行中插话:`turn/steer {threadId, expectedTurnId}`(对 / 错的 expectedTurnId 各一次)、
 *    回合中再 `turn/start`、`turn/interrupt`;
 * 3. 杀掉 app-server 进程再起一个续同一条线程:续不续得上、`~/.codex/sessions` 的 rollout 是不是同一份文件、
 *    `session_index.jsonl` 的标题有没有变。
 *
 * **只在维护者自己这台机器上手动跑**:会真起 `codex exec`、真花一点额度、真在你给的目录里建文件。
 * 不挂定时、不进测试套件、不登记进插件、不碰 `~/.dsh`。**只用 Node 内置模块**,不 import 插件源码 ——
 * `threadIdOf` 的口径(`dispatchRun.ts`)与 app-server 的握手 / 读行 / 对 id(`codexAppServerClient.ts`)
 * 在这里各抄了一份最小版,核的是协议在这台机器上通不通,不是适配器自己的分支。
 *
 * ```
 * node workbench-plugin/scripts/probe-codex-resume.ts exec    --dir <目录>                  # 照 dispatchRun 跑 codex exec --json,打出 thread id
 * node workbench-plugin/scripts/probe-codex-resume.ts resume  --dir <目录> --thread <id> [--text '…'] [--sandbox workspace-write] [--hold 30]
 * node workbench-plugin/scripts/probe-codex-resume.ts steer   --dir <目录> --thread <id> [--steer-after 5000] [--interrupt-after 5000]
 * node workbench-plugin/scripts/probe-codex-resume.ts restart --dir <目录> --thread <id>   # 进程 A 续一轮 → kill -9 → 进程 B 再续
 * node workbench-plugin/scripts/probe-codex-resume.ts inspect --thread <id>                # rollout 文件 / session_index / 写锁
 * node workbench-plugin/scripts/probe-codex-resume.ts list    --thread <id>                # thread/list 列不列得到它(她的 App 侧栏按这个列)
 * node workbench-plugin/scripts/probe-codex-resume.ts delete  --thread <id>                # 用完清掉:thread/delete(只删自己起的那条)
 * node workbench-plugin/scripts/probe-codex-resume.ts hold    --thread <id> [--hold 120] [--unsubscribe-after 5]   # 只 resume 然后握着不放(给「另一进程撞写锁」用);--unsubscribe-after 看 thread/unsubscribe 放不放锁
 * ```
 *
 * 审批那几问(`item/commandExecution/requestApproval` 等)照生产 `codexAppServerClient.ts` 的分寸一律 `decline`,
 * 但会打一行出来 —— 捎话不带 sandbox 时它到底问不问人,就是要看这个。不经手任何凭据:
 * `account/chatgptAuthTokens/refresh` 回 `-32601`。
 */
import { spawn, spawnSync } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// ───────────── 参数 ─────────────

const argv = process.argv.slice(2)
const step = argv[0] ?? 'help'
function arg(name: string, fallback?: string): string | undefined {
  const at = argv.indexOf(`--${name}`)
  return at >= 0 && argv[at + 1] !== undefined ? argv[at + 1] : fallback
}
function num(name: string, fallback: number): number {
  const raw = arg(name)
  const value = raw === undefined ? Number.NaN : Number(raw)
  return Number.isFinite(value) ? value : fallback
}

/** ChatGPT 桌面版自带的那份 `codex`(与 `codexAppServerClient.ts` 的 `CODEX_APP_BUNDLE_BINARY` 同一路径);PATH 上有就用 PATH 的。 */
const CODEX_APP_BUNDLE_BINARY = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex'
function findCodex(): string {
  const forced = process.env.CODEX_BIN
  if (forced !== undefined && forced !== '') return forced
  for (const dir of (process.env.PATH ?? '').split(':')) {
    if (dir !== '' && existsSync(`${dir}/codex`)) return `${dir}/codex`
  }
  return CODEX_APP_BUNDLE_BINARY
}
const CODEX = findCodex()
const CODEX_HOME = process.env.CODEX_HOME ?? join(homedir(), '.codex')

const since = Date.now()
const stamp = (): string => `+${((Date.now() - since) / 1000).toFixed(3)}s`
const log = (line: string): void => { console.log(`${stamp()} ${line}`) }
const short = (value: unknown, max = 160): string => {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  const flat = (text ?? '').replace(/\s+/g, ' ')
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

// ───────────── threadIdOf(抄 dispatchRun.ts 的口径) ─────────────

/** `codex exec --json` 的事件流里第一个 thread id(取不到回 undefined)。 */
function threadIdOf(logText: string): string | undefined {
  for (const line of logText.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    try {
      const event = JSON.parse(trimmed) as Record<string, unknown>
      const id = event.thread_id ?? (event.msg as Record<string, unknown> | undefined)?.thread_id ?? event.session_id
      if (typeof id === 'string' && id !== '') return id
    }
    catch { /* 半截行跳过 */ }
  }
  return undefined
}

// ───────────── app-server 最小客户端(抄 codexAppServerClient.ts 的握手 / 读行 / 对 id) ─────────────

interface Note { method: string, params: Record<string, unknown>, at: number }

/** 审批那几问一律 decline(与生产 `DENIED_APPROVALS` 同一份);别的回 -32601。 */
const DENIED: Readonly<Record<string, unknown>> = {
  'item/commandExecution/requestApproval': { decision: 'decline' },
  'item/fileChange/requestApproval': { decision: 'decline' },
  'item/permissions/requestApproval': { decision: 'decline' },
  execCommandApproval: { decision: 'decline' },
  applyPatchApproval: { decision: 'decline' },
}

class AppServer {
  readonly label: string
  readonly child: ChildProcess
  readonly pid: number
  readonly stderr: string[] = []
  readonly serverRequests: { at: number, method: string, params: unknown }[] = []
  private readonly pending = new Map<number, { settle: (v: unknown) => void, fail: (e: Error) => void, timer: NodeJS.Timeout }>()
  private readonly watchers = new Set<(note: Note) => void>()
  private nextId = 1
  private buffer = ''
  gone: string | undefined

  constructor(label: string) {
    this.label = label
    this.child = spawn(CODEX, ['app-server'], { stdio: ['pipe', 'pipe', 'pipe'] })
    this.pid = this.child.pid ?? -1
    this.child.stdout!.on('data', (chunk: Buffer) => {
      this.buffer += String(chunk)
      let index = this.buffer.indexOf('\n')
      while (index >= 0) {
        const line = this.buffer.slice(0, index)
        this.buffer = this.buffer.slice(index + 1)
        index = this.buffer.indexOf('\n')
        this.take(line)
      }
    })
    this.child.stderr!.on('data', (chunk: Buffer) => {
      for (const line of String(chunk).split('\n')) if (line.trim() !== '') this.stderr.push(line)
    })
    this.child.stdin!.on('error', (error) => { this.die(`stdin:${error.message}`) })
    this.child.on('error', (error) => { this.die(error.message) })
    this.child.on('exit', (code, signal) => { this.die(`退出(code=${code ?? 'null'} signal=${signal ?? 'null'})`) })
  }

  private die(why: string): void {
    if (this.gone !== undefined) return
    this.gone = why
    for (const [, flight] of this.pending) { clearTimeout(flight.timer); flight.fail(new Error(`app-server 没了:${why}`)) }
    this.pending.clear()
    log(`[${this.label}] 进程 ${this.pid} 没了:${why}`)
  }

  private write(message: unknown): void {
    if (this.gone !== undefined) throw new Error(`app-server 没了:${this.gone}`)
    this.child.stdin!.write(`${JSON.stringify(message)}\n`)
  }

  private take(line: string): void {
    const text = line.trim()
    if (text === '') return
    let message: { id?: unknown, method?: unknown, result?: unknown, error?: unknown, params?: unknown }
    try { message = JSON.parse(text) as typeof message }
    catch { log(`[${this.label}] 一行不是 JSON:${short(text)}`); return }
    if (typeof message.method === 'string' && message.id !== undefined) {
      // 它反过来问我们(审批 / 令牌)。
      this.serverRequests.push({ at: Date.now(), method: message.method, params: message.params })
      log(`[${this.label}] ← 它在问 ${message.method}:${short(message.params, 300)}`)
      const allowed = DENIED[message.method]
      const reply = allowed === undefined
        ? { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `探针不接 ${message.method}` } }
        : { jsonrpc: '2.0', id: message.id, result: allowed }
      try { this.write(reply) }
      catch { /* 它已经没了 */ }
      return
    }
    if (typeof message.method === 'string') {
      const params = (typeof message.params === 'object' && message.params !== null) ? message.params as Record<string, unknown> : {}
      const note: Note = { method: message.method, params, at: Date.now() }
      for (const watcher of [...this.watchers]) { try { watcher(note) } catch { /* 看客的事 */ } }
      return
    }
    if (typeof message.id !== 'number') return
    const flight = this.pending.get(message.id)
    if (flight === undefined) return
    this.pending.delete(message.id)
    clearTimeout(flight.timer)
    if (message.error !== undefined && message.error !== null) {
      flight.fail(new Error(JSON.stringify(message.error)))
      return
    }
    flight.settle(message.result)
  }

  request<T = unknown>(method: string, params: unknown = {}, timeoutMs = 15_000): Promise<T> {
    if (this.gone !== undefined) return Promise.reject(new Error(`app-server 没了:${this.gone}`))
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`超时未回 ${method}(${timeoutMs}ms)`)) }, timeoutMs)
      this.pending.set(id, { settle: v => resolve(v as T), fail: reject, timer })
      try { this.write({ jsonrpc: '2.0', id, method, params }) }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error instanceof Error ? error : new Error(String(error))) }
    })
  }

  notify(method: string, params: unknown = {}): void {
    try { this.write({ jsonrpc: '2.0', method, params }) }
    catch { /* 它没了 */ }
  }

  watch(listen: (note: Note) => void): () => void {
    this.watchers.add(listen)
    return () => { this.watchers.delete(listen) }
  }

  /** 一问带毫秒:成了回 `{ms, result}`,它回错误就回 `{ms, error}`(原话逐字)。 */
  async timed<T = unknown>(method: string, params: unknown = {}, timeoutMs = 15_000): Promise<{ ms: number, result?: T, error?: string }> {
    const t0 = Date.now()
    try {
      const result = await this.request<T>(method, params, timeoutMs)
      return { ms: Date.now() - t0, result }
    }
    catch (error) {
      return { ms: Date.now() - t0, error: error instanceof Error ? error.message : String(error) }
    }
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): void {
    if (this.gone === undefined) this.child.kill(signal)
  }
}

/** 起进程 + 握手。回 `{server, spawnMs, initMs}`。 */
async function openAppServer(label: string): Promise<{ server: AppServer, spawnMs: number, initMs: number }> {
  const t0 = Date.now()
  const server = new AppServer(label)
  const spawnMs = Date.now() - t0
  const init = await server.timed('initialize', { clientInfo: { name: 'probe-codex-resume', version: '1' } })
  if (init.error !== undefined) throw new Error(`initialize 失败:${init.error}`)
  server.notify('initialized')
  log(`[${label}] 起进程 pid=${server.pid} ${spawnMs}ms · initialize ${init.ms}ms · ${short(init.result, 200)}`)
  return { server, spawnMs, initMs: init.ms }
}

// ───────────── 盯一轮 ─────────────

interface TurnWatch {
  turnId: () => string | undefined
  /** 等到某个条件成立,或到点。 */
  until: (test: () => boolean, ms: number) => Promise<boolean>
  /** 这一轮收场了没(turn/completed 的 turn)。 */
  end: () => Record<string, unknown> | undefined
  events: () => readonly string[]
  agentText: () => string
  stop: () => void
}

function rec(value: unknown): Record<string, unknown> | undefined {
  return (typeof value === 'object' && value !== null) ? value as Record<string, unknown> : undefined
}

/** 盯住一条线程上的事件,从 `t0` 起记毫秒。**在 turn/start 发出去之前挂上**。 */
function watchThread(server: AppServer, threadId: string, t0: () => number): TurnWatch {
  const events: string[] = []
  const wakers = new Set<() => void>()
  let turnId: string | undefined
  let end: Record<string, unknown> | undefined
  let deltas = 0
  let agentText = ''
  const wake = (): void => { for (const waker of [...wakers]) waker() }
  const ms = (note: Note): string => `+${note.at - t0()}ms`

  const unwatch = server.watch((note) => {
    const p = note.params
    if (typeof p.threadId === 'string' && p.threadId !== threadId) return
    if (note.method === 'item/agentMessage/delta') {
      deltas += 1
      if (deltas === 1) { events.push(`${ms(note)} 第一个字`); log(`[${server.label}] ${ms(note)} 第一个字:${short(p.delta, 60)}`) }
      return
    }
    if (note.method.startsWith('item/reasoning') || note.method === 'item/commandExecution/outputDelta' || note.method === 'thread/tokenUsage/updated' || note.method === 'account/rateLimits/updated') return
    if (note.method === 'turn/started') {
      const id = rec(p.turn)?.id
      if (typeof id === 'string') turnId = id
      events.push(`${ms(note)} turn/started ${turnId ?? '?'}`)
      log(`[${server.label}] ${ms(note)} turn/started turn=${turnId ?? '?'}`)
      wake()
      return
    }
    if (note.method === 'item/started' || note.method === 'item/completed') {
      const item = rec(p.item)
      const type = typeof item?.type === 'string' ? item.type : '?'
      let detail = ''
      if (type === 'commandExecution') detail = `${short(item?.command, 100)} → ${String(item?.status)}${item?.exitCode === undefined || item?.exitCode === null ? '' : ` exit=${String(item.exitCode)}`}`
      else if (type === 'fileChange') detail = `${String(item?.status)} ${short((item?.changes as unknown[] | undefined)?.map(one => rec(one)?.path), 120)}`
      else if (type === 'agentMessage') { detail = `phase=${String(item?.phase)} ${short(item?.text, 140)}`; if (note.method === 'item/completed' && typeof item?.text === 'string') agentText = item.text }
      else if (type === 'userMessage') detail = short((item?.content as unknown[] | undefined)?.map(one => rec(one)?.text), 100)
      else detail = short(item, 100)
      events.push(`${ms(note)} ${note.method} ${type} ${detail}`)
      log(`[${server.label}] ${ms(note)} ${note.method} ${type} ${detail}`)
      return
    }
    if (note.method === 'turn/completed') {
      const turn = rec(p.turn)
      end = turn
      events.push(`${ms(note)} turn/completed status=${String(turn?.status)} turn=${String(turn?.id)}`)
      log(`[${server.label}] ${ms(note)} turn/completed status=${String(turn?.status)} turn=${String(turn?.id)} durationMs=${String(turn?.durationMs)} error=${short(turn?.error, 200)}`)
      wake()
      return
    }
    events.push(`${ms(note)} ${note.method} ${short(p, 160)}`)
    log(`[${server.label}] ${ms(note)} ${note.method} ${short(p, 160)}`)
    wake()
  })

  const until = async (test: () => boolean, ms: number): Promise<boolean> => {
    if (test()) return true
    return await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => { wakers.delete(waker); resolve(test()) }, ms)
      const waker = (): void => { if (!test()) return; clearTimeout(timer); wakers.delete(waker); resolve(true) }
      wakers.add(waker)
    })
  }
  return {
    turnId: () => turnId,
    until,
    end: () => end,
    events: () => events,
    agentText: () => agentText,
    stop: unwatch,
  }
}

// ───────────── 旁证:文件 / 写锁 / rollout / session_index ─────────────

function lockOf(threadId: string): string {
  return join(CODEX_HOME, 'thread-writer-locks', `${threadId}.lock`)
}
function lockHolders(threadId: string): string {
  const file = lockOf(threadId)
  if (!existsSync(file)) return '锁文件不存在'
  const out = spawnSync('lsof', ['-F', 'p', file], { encoding: 'utf8' })
  const pids = (out.stdout ?? '').split('\n').filter(one => one.startsWith('p')).map(one => one.slice(1))
  return pids.length === 0 ? '锁文件在、没人握着' : `握着的 pid:${pids.join(',')}`
}
function rolloutsOf(threadId: string): string[] {
  const found: string[] = []
  const roots = [join(CODEX_HOME, 'sessions'), join(CODEX_HOME, 'archived_sessions')]
  const walk = (dir: string, depth: number): void => {
    if (!existsSync(dir)) return
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      let st
      try { st = statSync(full) } catch { continue }
      if (st.isDirectory()) { if (depth < 4) walk(full, depth + 1) }
      else if (name.includes(threadId) && name.endsWith('.jsonl')) found.push(full)
    }
  }
  for (const root of roots) walk(root, 0)
  return found
}
function rolloutSummary(file: string): string {
  const st = statSync(file)
  const lines = readFileSync(file, 'utf8').split('\n').filter(one => one.trim() !== '')
  const counts = new Map<string, number>()
  let users = 0
  let agents = 0
  for (const line of lines) {
    try {
      const o = JSON.parse(line) as Record<string, unknown>
      const payload = rec(o.payload)
      const key = `${String(o.type)}${payload?.type === undefined ? '' : `/${String(payload.type)}`}`
      counts.set(key, (counts.get(key) ?? 0) + 1)
      if (o.type === 'response_item' && payload?.type === 'message') {
        if (payload.role === 'user') users += 1
        if (payload.role === 'assistant') agents += 1
      }
    }
    catch { counts.set('(坏行)', (counts.get('(坏行)') ?? 0) + 1) }
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${k}=${v}`).join(' ')
  return `${file.replace(CODEX_HOME, '~/.codex')} · ${lines.length} 行 · ${st.size}B · mtime ${st.mtime.toISOString()} · user 消息 ${users} / assistant 消息 ${agents} · ${top}`
}
function indexLinesOf(threadId: string): string[] {
  const file = join(CODEX_HOME, 'session_index.jsonl')
  if (!existsSync(file)) return ['(没有 session_index.jsonl)']
  return readFileSync(file, 'utf8').split('\n').filter(one => one.includes(threadId))
}
function dirListing(dir: string): string {
  if (!existsSync(dir)) return '(目录不存在)'
  return readdirSync(dir).filter(one => !one.startsWith('.')).map((name) => {
    const full = join(dir, name)
    try {
      const st = statSync(full)
      if (st.isDirectory()) return `${name}/`
      const body = st.size <= 400 ? readFileSync(full, 'utf8') : undefined
      return `${name}(${st.size}B)${body === undefined ? '' : ` = ${JSON.stringify(body)}`}`
    }
    catch { return name }
  }).join(' · ')
}
function inspect(threadId: string): void {
  log(`[inspect] 写锁:${lockHolders(threadId)}`)
  const files = rolloutsOf(threadId)
  log(`[inspect] rollout 文件 ${files.length} 份`)
  for (const file of files) log(`[inspect]   ${rolloutSummary(file)}`)
  const index = indexLinesOf(threadId)
  log(`[inspect] session_index.jsonl 里 ${index.length} 行:${index.map(one => short(one, 200)).join(' | ') || '(无)'}`)
}

// ───────────── 共用:resume + 一轮 ─────────────

interface ResumeOptions {
  sandbox?: string
  approvalPolicy?: string
  excludeTurns?: boolean
}

async function resumeThread(server: AppServer, threadId: string, options: ResumeOptions = {}): Promise<{ ms: number, ok: boolean, error?: string, thread?: Record<string, unknown>, response?: Record<string, unknown> }> {
  const params: Record<string, unknown> = { threadId }
  if (options.sandbox !== undefined) params.sandbox = options.sandbox
  if (options.approvalPolicy !== undefined) params.approvalPolicy = options.approvalPolicy
  if (options.excludeTurns === true) params.excludeTurns = true
  const got = await server.timed<Record<string, unknown>>('thread/resume', params)
  if (got.error !== undefined) {
    log(`[${server.label}] thread/resume ${got.ms}ms → 错误(逐字):${got.error}`)
    return { ms: got.ms, ok: false, error: got.error }
  }
  const response = got.result ?? {}
  const thread = rec(response.thread)
  const turns = Array.isArray(thread?.turns) ? thread.turns as Record<string, unknown>[] : []
  log(`[${server.label}] thread/resume ${got.ms}ms → thread.id=${String(thread?.id)} name=${String(thread?.name)} status=${short(thread?.status, 80)} cwd=${String(response.cwd)} model=${String(response.model)} approvalPolicy=${String(response.approvalPolicy)} sandbox=${short(response.sandbox, 120)} turns=${turns.length} turnsBackwardsCursor=${String(response.turnsBackwardsCursor)}`)
  for (const [i, turn] of turns.entries()) {
    const items = Array.isArray(turn.items) ? turn.items as Record<string, unknown>[] : []
    const user = items.filter(one => one.type === 'userMessage').map(one => short((one.content as unknown[] | undefined)?.map(c => rec(c)?.text), 80))
    const agent = items.filter(one => one.type === 'agentMessage').map(one => short(one.text, 80))
    log(`[${server.label}]   轮 ${i + 1} id=${String(turn.id)} status=${String(turn.status)} items=${items.length} 她说:${user.join(' / ') || '(无)'} 它说:${agent.join(' / ') || '(无)'}`)
  }
  return { ms: got.ms, ok: true, thread: thread ?? undefined, response }
}

/** 送一句、等收场。回 `{startMs, turnId, startedMs, completedMs, status, text}`。 */
async function oneTurn(server: AppServer, threadId: string, text: string, waitMs: number, extra: Record<string, unknown> = {}): Promise<{ startMs: number, startError?: string, turnId?: string, startedMs?: number, completedMs?: number, status?: string, text: string, watch: TurnWatch }> {
  let t0 = Date.now()
  const watch = watchThread(server, threadId, () => t0)
  t0 = Date.now()
  const started = await server.timed<Record<string, unknown>>('turn/start', { threadId, input: [{ type: 'text', text }], ...extra })
  if (started.error !== undefined) {
    log(`[${server.label}] turn/start ${started.ms}ms → 错误(逐字):${started.error}`)
    watch.stop()
    return { startMs: started.ms, startError: started.error, text: '', watch }
  }
  const turn = rec(started.result?.turn)
  log(`[${server.label}] turn/start ${started.ms}ms → turn.id=${String(turn?.id)} status=${String(turn?.status)}`)
  const startedAt = watch.turnId() === undefined ? undefined : Date.now()
  await watch.until(() => watch.turnId() !== undefined, 5000)
  const startedMs = startedAt === undefined ? (watch.turnId() === undefined ? undefined : Date.now() - t0) : startedAt - t0
  const done = await watch.until(() => watch.end() !== undefined, waitMs)
  const completedMs = done ? Date.now() - t0 : undefined
  const end = watch.end()
  const status = typeof end?.status === 'string' ? end.status : undefined
  if (!done) log(`[${server.label}] 等了 ${waitMs}ms 还没 turn/completed`)
  return { startMs: started.ms, turnId: (typeof turn?.id === 'string' ? turn.id : undefined) ?? watch.turnId(), startedMs, completedMs, status, text: watch.agentText(), watch }
}

// ───────────── 各步 ─────────────

async function stepExec(): Promise<void> {
  const dir = arg('dir')
  if (dir === undefined) throw new Error('要 --dir')
  mkdirSync(dir, { recursive: true })
  const text = arg('text', '在当前目录新建 a.txt,内容只有一行:hello。做完只回一句话。') as string
  const out = join(dir, 'exec-last.txt')
  const args = ['exec', '--json', '-C', dir, '-s', 'workspace-write', '-o', out, text]
  log(`[exec] ${CODEX} ${args.map(one => (one.includes(' ') ? JSON.stringify(one) : one)).join(' ')}`)
  const t0 = Date.now()
  const child = spawn(CODEX, args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  let firstLineAt: number | undefined
  let threadId: string | undefined
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += String(chunk)
    if (firstLineAt === undefined && stdout.includes('\n')) firstLineAt = Date.now() - t0
    if (threadId === undefined) {
      threadId = threadIdOf(stdout)
      if (threadId !== undefined) log(`[exec] +${Date.now() - t0}ms 认到 thread id(threadIdOf 口径):${threadId}`)
    }
  })
  child.stderr.on('data', (chunk: Buffer) => { stderr += String(chunk) })
  const code = await new Promise<number | null>(resolve => child.on('exit', c => resolve(c)))
  const totalMs = Date.now() - t0
  writeFileSync(join(dir, 'exec.jsonl'), stdout)
  writeFileSync(join(dir, 'exec.stderr.log'), stderr)
  const lines = stdout.split('\n').filter(one => one.trim() !== '')
  log(`[exec] 退出 code=${String(code)} · ${totalMs}ms · 第一行 +${firstLineAt ?? '?'}ms · 事件 ${lines.length} 行 · stderr ${stderr.split('\n').filter(one => one.trim() !== '').length} 行`)
  log(`[exec] 第一行:${short(lines[0], 300)}`)
  const types = new Map<string, number>()
  for (const line of lines) {
    try { const o = JSON.parse(line) as Record<string, unknown>; const key = `${String(o.type)}${rec(o.item)?.type === undefined ? '' : `/${String(rec(o.item)?.type)}`}`; types.set(key, (types.get(key) ?? 0) + 1) }
    catch { /* 跳过 */ }
  }
  log(`[exec] 事件类型:${[...types.entries()].map(([k, v]) => `${k}=${v}`).join(' ')}`)
  log(`[exec] -o 文件:${existsSync(out) ? JSON.stringify(readFileSync(out, 'utf8').slice(0, 300)) : '(没写)'}`)
  log(`[exec] 目录:${dirListing(dir)}`)
  threadId ??= threadIdOf(stdout)
  log(`[exec] thread id = ${threadId ?? '(没取到)'}`)
  if (threadId !== undefined) inspect(threadId)
  console.log(`\nTHREAD_ID=${threadId ?? ''}`)
}

async function stepResume(): Promise<void> {
  const dir = arg('dir')
  const threadId = arg('thread')
  if (threadId === undefined) throw new Error('要 --thread')
  const text = arg('text', '把 a.txt 改成两行:第一行保持原样,第二行写 world。做完只回一句话,说清你改了什么、第一行原来是什么。') as string
  const sandbox = arg('sandbox')
  const approvalPolicy = arg('approval')
  const holdSec = num('hold', 0)
  log(`[resume] thread=${threadId} 锁(之前):${lockHolders(threadId)}`)
  const { server } = await openAppServer('resume')
  try {
    const resumed = await resumeThread(server, threadId, { sandbox, approvalPolicy })
    if (!resumed.ok) {
      log(`[resume] 锁(resume 失败后):${lockHolders(threadId)}`)
      return
    }
    log(`[resume] 锁(resume 之后):${lockHolders(threadId)}`)
    const loaded = await server.timed<{ data?: string[] }>('thread/loaded/list', {})
    log(`[resume] thread/loaded/list ${loaded.ms}ms → ${short(loaded.result?.data ?? loaded.error, 200)}`)
    const turn = await oneTurn(server, threadId, text, 5 * 60 * 1000)
    turn.watch.stop()
    log(`[resume] 结果:turn/start 回包 ${turn.startMs}ms · turn/started +${turn.startedMs ?? '?'}ms · turn/completed +${turn.completedMs ?? '(没等到)'}ms · status=${turn.status ?? '?'}`)
    log(`[resume] 它说:${short(turn.text, 400)}`)
    log(`[resume] 它问过我们 ${server.serverRequests.length} 次:${server.serverRequests.map(one => one.method).join(',') || '(没问)'}`)
    if (dir !== undefined) log(`[resume] 目录:${dirListing(dir)}`)
    if (holdSec > 0) { log(`[resume] 握着线程 ${holdSec}s 不放…`); await sleep(holdSec * 1000) }
  }
  finally {
    log(`[resume] stderr ${server.stderr.length} 行${server.stderr.length === 0 ? '' : `:${short(server.stderr.slice(-3), 300)}`}`)
    server.kill('SIGTERM')
    await sleep(300)
    log(`[resume] 锁(进程退了之后):${lockHolders(threadId)}`)
    inspect(threadId)
  }
}

async function stepHold(): Promise<void> {
  const threadId = arg('thread')
  if (threadId === undefined) throw new Error('要 --thread')
  const holdSec = num('hold', 120)
  const { server } = await openAppServer('hold')
  const resumed = await resumeThread(server, threadId, { excludeTurns: true })
  log(`[hold] 锁:${lockHolders(threadId)}`)
  if (!resumed.ok) { server.kill(); return }
  log(`[hold] pid ${server.pid} 握着 ${threadId} 共 ${holdSec}s(kill 它锁就放)`)
  console.log(`HOLD_PID=${server.pid}`)
  const unsubscribeAfter = num('unsubscribe-after', 0)
  if (unsubscribeAfter > 0) {
    // 长连接不退、只 `thread/unsubscribe`,锁放不放 —— 工作台那条长连接 read 一眼就 resume,握着不放就会挡她的 App。
    await sleep(unsubscribeAfter * 1000)
    const left = await server.timed('thread/unsubscribe', { threadId })
    log(`[hold] thread/unsubscribe ${left.ms}ms → ${left.error === undefined ? `回包 ${short(left.result, 200)}` : `错误(逐字):${left.error}`}`)
    await sleep(500)
    log(`[hold] unsubscribe 之后锁:${lockHolders(threadId)}`)
    const loaded = await server.timed<{ data?: string[] }>('thread/loaded/list', {})
    log(`[hold] thread/loaded/list → ${short(loaded.result?.data ?? loaded.error, 200)}`)
    await sleep(Math.max(0, holdSec - unsubscribeAfter) * 1000)
  }
  else await sleep(holdSec * 1000)
  server.kill('SIGTERM')
}

async function stepSteer(): Promise<void> {
  const dir = arg('dir')
  const threadId = arg('thread')
  if (threadId === undefined || dir === undefined) throw new Error('要 --thread 与 --dir')
  const steerAfter = num('steer-after', 5000)
  const interruptAfter = num('interrupt-after', 5000)
  const longText = arg('text', '从 1 数到 30:每数一个数字就执行一条单独的 shell 命令把这个数字追加成一行写进 count.txt(每个数字一条命令,不要一条命令写完),每条命令之间 sleep 1 秒。全部写完后只回一句话:说你数到了几、count.txt 有几行。') as string
  const { server } = await openAppServer('steer')
  try {
    const resumed = await resumeThread(server, threadId, { excludeTurns: true })
    if (!resumed.ok) return
    const resumedTurns = rec(resumed.thread)
    log(`[steer] (excludeTurns) turns=${Array.isArray(resumedTurns?.turns) ? (resumedTurns!.turns as unknown[]).length : '?'}`)

    // ── 第一轮:长任务,中途 steer ──
    let t0 = Date.now()
    const watch = watchThread(server, threadId, () => t0)
    t0 = Date.now()
    const started = await server.timed<Record<string, unknown>>('turn/start', { threadId, input: [{ type: 'text', text: longText }] })
    log(`[steer] turn/start ${started.ms}ms → ${started.error ?? `turn.id=${String(rec(started.result?.turn)?.id)}`}`)
    const turnId = (typeof rec(started.result?.turn)?.id === 'string' ? rec(started.result?.turn)!.id as string : undefined) ?? watch.turnId()
    await watch.until(() => watch.turnId() !== undefined, 5000)
    log(`[steer] 等 ${steerAfter}ms 再插话(此时 turn=${turnId ?? watch.turnId() ?? '?'})`)
    await sleep(steerAfter)
    const linesBeforeSteer = existsSync(join(dir, 'count.txt')) ? readFileSync(join(dir, 'count.txt'), 'utf8').split('\n').filter(one => one.trim() !== '').length : 0
    log(`[steer] +${Date.now() - t0}ms count.txt 此刻 ${linesBeforeSteer} 行`)

    // (a) 错的 expectedTurnId
    const wrong = await server.timed('turn/steer', { threadId, expectedTurnId: '00000000-0000-7000-8000-000000000000', input: [{ type: 'text', text: '改成只数到 10。' }] })
    log(`[steer] +${Date.now() - t0}ms turn/steer(错的 expectedTurnId)${wrong.ms}ms → ${wrong.error === undefined ? `回包 ${short(wrong.result, 200)}` : `错误(逐字):${wrong.error}`}`)
    // (b) 对的 expectedTurnId
    const active = turnId ?? watch.turnId()
    const right = await server.timed('turn/steer', { threadId, expectedTurnId: active, input: [{ type: 'text', text: '改成只数到 10,数到 10 就停、不要再往下数。最后只回一句话说你数到了几。' }] })
    log(`[steer] +${Date.now() - t0}ms turn/steer(对的 expectedTurnId=${active ?? '?'})${right.ms}ms → ${right.error === undefined ? `回包 ${short(right.result, 200)}` : `错误(逐字):${right.error}`}`)
    // (c) 回合进行中再 turn/start 一句,看它是排队还是插话
    const again = await server.timed<Record<string, unknown>>('turn/start', { threadId, input: [{ type: 'text', text: '(这是回合进行中又发的一句)另外在 note.txt 里写一行 steer-probe。' }] })
    log(`[steer] +${Date.now() - t0}ms 回合进行中 turn/start ${again.ms}ms → ${again.error === undefined ? `turn.id=${String(rec(again.result?.turn)?.id)} status=${String(rec(again.result?.turn)?.status)}(与第一轮 ${active ?? '?'} ${rec(again.result?.turn)?.id === active ? '相同' : '不同'})` : `错误(逐字):${again.error}`}`)

    const done = await watch.until(() => watch.end() !== undefined, 4 * 60 * 1000)
    log(`[steer] 第一轮 turn/completed +${done ? Date.now() - t0 : '(没等到)'}ms status=${String(watch.end()?.status)}`)
    log(`[steer] 它说:${short(watch.agentText(), 300)}`)
    const linesAfter = existsSync(join(dir, 'count.txt')) ? readFileSync(join(dir, 'count.txt'), 'utf8').split('\n').filter(one => one.trim() !== '').length : 0
    log(`[steer] count.txt 最终 ${linesAfter} 行 · 目录:${dirListing(dir)}`)
    // 如果第二句被排成了下一轮,等它也收场
    const secondId = rec(again.result?.turn)?.id
    if (typeof secondId === 'string' && secondId !== active) {
      const t1 = Date.now()
      const w2 = watchThread(server, threadId, () => t0)
      const ok = await w2.until(() => { const e = w2.end(); return e !== undefined && e.id === secondId }, 3 * 60 * 1000)
      log(`[steer] 排队的那一轮 ${secondId} ${ok ? `也收场了(+${Date.now() - t1}ms)status=${String(w2.end()?.status)}` : '没等到收场'} · 它说:${short(w2.agentText(), 200)}`)
      w2.stop()
    }
    watch.stop()

    // (d) 没有在跑的回合时 steer
    const idle = await server.timed('turn/steer', { threadId, expectedTurnId: active, input: [{ type: 'text', text: '没在跑时插的一句。' }] })
    log(`[steer] 空闲时 turn/steer ${idle.ms}ms → ${idle.error === undefined ? `回包 ${short(idle.result, 200)}` : `错误(逐字):${idle.error}`}`)

    // ── 第二轮:长任务,中途 interrupt ──
    log(`[interrupt] 第二轮:同样的长任务,${interruptAfter}ms 后 turn/interrupt`)
    const turn2 = await oneTurn(server, threadId, longText.replace('count.txt', 'count2.txt'), 0)
    const id2 = turn2.turnId ?? turn2.watch.turnId()
    await sleep(interruptAfter)
    const t2 = Date.now()
    const stopped = await server.timed('turn/interrupt', { threadId, turnId: id2 })
    log(`[interrupt] turn/interrupt(turn=${id2 ?? '?'})${stopped.ms}ms → ${stopped.error === undefined ? `回包 ${short(stopped.result, 200)}` : `错误(逐字):${stopped.error}`}`)
    const ended = await turn2.watch.until(() => turn2.watch.end() !== undefined, 60_000)
    log(`[interrupt] turn/completed ${ended ? `+${Date.now() - t2}ms(自 interrupt 起)` : '(60s 没等到)'} status=${String(turn2.watch.end()?.status)} error=${short(turn2.watch.end()?.error, 200)}`)
    log(`[interrupt] 它说:${short(turn2.watch.agentText(), 200)}`)
    log(`[interrupt] count2.txt ${existsSync(join(dir, 'count2.txt')) ? readFileSync(join(dir, 'count2.txt'), 'utf8').split('\n').filter(one => one.trim() !== '').length : 0} 行`)
    turn2.watch.stop()
    // 打断之后再 interrupt 一次(已收场)
    const twice = await server.timed('turn/interrupt', { threadId, turnId: id2 })
    log(`[interrupt] 已收场再 interrupt ${twice.ms}ms → ${twice.error === undefined ? `回包 ${short(twice.result, 200)}` : `错误(逐字):${twice.error}`}`)
    log(`[steer] 它问过我们 ${server.serverRequests.length} 次:${server.serverRequests.map(one => one.method).join(',') || '(没问)'}`)
  }
  finally {
    log(`[steer] stderr ${server.stderr.length} 行${server.stderr.length === 0 ? '' : `:${short(server.stderr.slice(-3), 300)}`}`)
    server.kill('SIGTERM')
  }
}

async function stepRestart(): Promise<void> {
  const dir = arg('dir')
  const threadId = arg('thread')
  if (threadId === undefined || dir === undefined) throw new Error('要 --thread 与 --dir')
  log(`[restart] 之前:`)
  inspect(threadId)
  const indexBefore = indexLinesOf(threadId)
  const filesBefore = rolloutsOf(threadId)

  // 进程 A
  const a = await openAppServer('A')
  const resumedA = await resumeThread(a.server, threadId, {})
  if (!resumedA.ok) { a.server.kill(); return }
  const turnA = await oneTurn(a.server, threadId, '在 a.txt 末尾再追加一行:round-A。做完只回一句话。', 3 * 60 * 1000)
  turnA.watch.stop()
  log(`[restart] A 的一轮:turn/start ${turnA.startMs}ms · completed +${turnA.completedMs ?? '?'}ms · status=${turnA.status ?? '?'} · 它说:${short(turnA.text, 200)}`)
  log(`[restart] A 握着锁:${lockHolders(threadId)}`)
  const tKill = Date.now()
  a.server.kill('SIGKILL')
  await sleep(500)
  log(`[restart] kill -9 A(pid ${a.server.pid})+${Date.now() - tKill}ms 后锁:${lockHolders(threadId)}`)
  log(`[restart] A 退了之后:`)
  inspect(threadId)

  // 进程 B
  const b = await openAppServer('B')
  try {
    const resumedB = await resumeThread(b.server, threadId, {})
    if (!resumedB.ok) return
    const turnB = await oneTurn(b.server, threadId, '不要动任何文件。只回一句话:我上一句让你做什么?a.txt 现在应该有几行、每行是什么?', 3 * 60 * 1000)
    turnB.watch.stop()
    log(`[restart] B 的一轮:turn/start ${turnB.startMs}ms · completed +${turnB.completedMs ?? '?'}ms · status=${turnB.status ?? '?'}`)
    log(`[restart] B 它说:${short(turnB.text, 400)}`)
    log(`[restart] 目录:${dirListing(dir)}`)
  }
  finally {
    b.server.kill('SIGTERM')
    await sleep(300)
    log(`[restart] 之后:`)
    inspect(threadId)
    const filesAfter = rolloutsOf(threadId)
    log(`[restart] rollout 文件:之前 ${filesBefore.length} 份、之后 ${filesAfter.length} 份 · ${filesAfter.every(one => filesBefore.includes(one)) && filesAfter.length === filesBefore.length ? '同一份' : '不是同一份集合'}`)
    const indexAfter = indexLinesOf(threadId)
    log(`[restart] session_index:之前 ${indexBefore.length} 行 / 之后 ${indexAfter.length} 行 · ${JSON.stringify(indexBefore) === JSON.stringify(indexAfter) ? '一字未变' : `变了:${short(indexAfter, 300)}`}`)
  }
}

/** `thread/list` 列不列得到这条(她的 App 侧栏、`codexThreads.ts` 认会话都从这类列表来)。 */
async function stepList(): Promise<void> {
  const threadId = arg('thread')
  if (threadId === undefined) throw new Error('要 --thread')
  const { server } = await openAppServer('list')
  try {
    const listed = await server.timed<{ data?: Record<string, unknown>[], nextCursor?: unknown }>('thread/list', { limit: 100 })
    if (listed.error !== undefined) { log(`[list] thread/list ${listed.ms}ms → 错误(逐字):${listed.error}`); return }
    const rows = listed.result?.data ?? []
    const mine = rows.find(one => one.id === threadId)
    log(`[list] thread/list ${listed.ms}ms → ${rows.length} 条(nextCursor=${String(listed.result?.nextCursor)});这条${mine === undefined ? '不在里面' : `在:${short(mine, 400)}`}`)
    const withSource = await server.timed<{ data?: Record<string, unknown>[] }>('thread/list', { limit: 100, sourceKinds: ['exec', 'cli', 'vscode', 'subAgent', 'unknown'] })
    const rows2 = withSource.result?.data ?? []
    log(`[list] thread/list(带 sourceKinds)${withSource.ms}ms → ${withSource.error ?? `${rows2.length} 条;这条${rows2.some(one => one.id === threadId) ? '在' : '不在'}`}`)
    const read = await server.timed<Record<string, unknown>>('thread/read', { threadId, includeTurns: false })
    log(`[list] thread/read ${read.ms}ms → ${read.error ?? short(read.result, 400)}`)
  }
  finally { server.kill('SIGTERM') }
}

/** 用完清掉自己起的那条:`thread/delete`(官方那条路,rollout 与索引一起清);被别的进程握着时如实打出来。 */
async function stepDelete(): Promise<void> {
  const threadId = arg('thread')
  if (threadId === undefined) throw new Error('要 --thread')
  const before = rolloutsOf(threadId)
  log(`[delete] 之前 rollout ${before.length} 份 · 锁:${lockHolders(threadId)}`)
  const { server } = await openAppServer('delete')
  try {
    const gone = await server.timed('thread/delete', { threadId })
    log(`[delete] thread/delete ${gone.ms}ms → ${gone.error === undefined ? `回包 ${short(gone.result, 200)}` : `错误(逐字):${gone.error}`}`)
  }
  finally { server.kill('SIGTERM') }
  await sleep(500)
  const after = rolloutsOf(threadId)
  log(`[delete] 之后 rollout ${after.length} 份:${after.map(one => one.replace(CODEX_HOME, '~/.codex')).join(' · ') || '(无)'} · 锁:${lockHolders(threadId)} · session_index ${indexLinesOf(threadId).length} 行`)
}

async function main(): Promise<void> {
  log(`codex=${CODEX} · CODEX_HOME=${CODEX_HOME} · node=${process.version}`)
  const version = spawnSync(CODEX, ['--version'], { encoding: 'utf8' })
  log(`codex --version → ${(version.stdout ?? '').trim() || (version.stderr ?? '').trim()}`)
  if (step === 'exec') await stepExec()
  else if (step === 'resume') await stepResume()
  else if (step === 'hold') await stepHold()
  else if (step === 'steer') await stepSteer()
  else if (step === 'restart') await stepRestart()
  else if (step === 'inspect') { const id = arg('thread'); if (id === undefined) throw new Error('要 --thread'); inspect(id) }
  else if (step === 'list') await stepList()
  else if (step === 'delete') await stepDelete()
  else { console.log('用法见文件头注释:exec | resume | hold | steer | restart | inspect | list | delete'); process.exit(2) }
  process.exit(0)
}

void main().catch((error) => { console.error(error); process.exit(1) })
