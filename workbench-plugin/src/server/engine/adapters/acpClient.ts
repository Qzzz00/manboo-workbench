/**
 * **ACP(Agent Client Protocol)那条 stdio JSON-RPC 的客户端**(2026-10-19,实验卡「ACP 客户端替 app-server 直连」)。
 *
 * ## 为什么要有这一份
 *
 * 今天 Codex 走 `codex app-server` 直连(`codexAppServerClient.ts`),`approvalPolicy` 写死 `never`、
 * 它反过来要批准的那几问一律 `decline` —— 于是 Codex 一问人整件就挂。
 * ACP(agentclientprotocol.com)把「问人」收进了协议:代理发 `session/request_permission`,客户端答
 * `selected{optionId}` 或 `cancelled`。Zed 的 `@agentclientprotocol/codex-acp` 把 Codex app-server 翻成 ACP,
 * 我们只要做一个 ACP 客户端,权限请求就能进「它在问她」那一堆、由手机答。
 *
 * 这一份只管协议:握手、一问一答、它反过来问我们时交给上层({@link OpenAcpOptions.onRequest})、断线、起进程。
 * **不**管会话 / 轮次 / 抽屉 —— 那些在 `acp.ts`。
 *
 * ## 分寸(与 app-server 那条同)
 *
 * 1. **不经手任何凭据**:认证照旧用 ChatGPT 桌面版的登录态(`CODEX_PATH` 指向它那份 `codex`,与今天同源);
 *    我们**从不**调 `authenticate`(那会开浏览器),它说没登录就如实报没登录。
 * 2. **权限只由她答**:`session/request_permission` 一律交上层挂进抽屉,这一层不替她选任何一项。
 * 3. **依赖钉死版本**({@link CODEX_ACP_VERSION};C4),`npx -y <包>@<版>` 起。
 *
 * ## 协议(2026-10-19 对 codex-acp 2.2.2 / SDK 1.9 的 schema 核过)
 *
 * - 握手:`initialize {protocolVersion, clientCapabilities, clientInfo}` → `{protocolVersion, agentCapabilities, authMethods}`;**没有** `initialized` 通知(那是 app-server 的);
 * - 开新的:`session/new {cwd, mcpServers:[]}` → `{sessionId, modes}`;接着那条:`session/load {sessionId, cwd, mcpServers:[]}`;
 * - 权限档:`session/set_mode {sessionId, modeId}`(codex-acp 的模式 = Codex 的 approval + sandbox 预设,见 {@link CODEX_ACP_MODES});
 * - 送一句:`session/prompt {sessionId, prompt:[{type:'text',text}]}` → **这一轮说完才回** `{stopReason}`;
 * - 事件:`session/update {sessionId, update:{sessionUpdate:'agent_message_chunk'|'tool_call'|'tool_call_update'|…}}`;
 * - 它问我们:`session/request_permission {sessionId, toolCall, options:[{optionId,name,kind}]}` → 我们答 `{outcome:{outcome:'selected',optionId}}` / `{outcome:{outcome:'cancelled'}}`;
 * - 停:`session/cancel {sessionId}`(通知,没有回包;挂着的权限请求**必须**回 `cancelled`)。
 *
 * 行分隔(ndjson),与 app-server 同一种读法。
 */
import type { CodexStdioPeer } from './codexAppServerClient.ts'

/** 这条路用的 stdio 对端与 app-server 那条**同一个形状**(用例里的假对端两边通用)。 */
export type AcpStdioPeer = CodexStdioPeer

/** 它从 stdout 吐出来的一条通知(没有 `id`)。 */
export interface AcpNotification {
  method: string
  params: Record<string, unknown>
}

/** 方法名一处写(查实自 SDK `AGENT_METHODS` / `CLIENT_METHODS`)。 */
export const ACP_METHODS = {
  initialize: 'initialize',
  newSession: 'session/new',
  loadSession: 'session/load',
  setMode: 'session/set_mode',
  prompt: 'session/prompt',
  cancel: 'session/cancel',
  /** 代理 → 客户端:通知。 */
  update: 'session/update',
  /** 代理 → 客户端:请求(要我们答)。 */
  requestPermission: 'session/request_permission',
} as const

/** 协议版本(schema 里是整数;SDK 1.9 当前为 1)。 */
export const ACP_PROTOCOL_VERSION = 1

/** 钉死的包与版本(C4)。2026-10-19 npm 上最新的正式版;改版本 = 改这一处 + 跑一遍真机脚本。 */
export const CODEX_ACP_PACKAGE = '@agentclientprotocol/codex-acp'
export const CODEX_ACP_VERSION = '2.2.2'

/**
 * codex-acp 的模式 id(2.2.2 `AgentMode`):每一档 = Codex 的 approvalPolicy + sandbox 预设。
 * 我们只用这两档(approval 都是 `on-request`:它要问就问,问到抽屉里来);
 * `agent`(自动审)与 `agent-full-access`(`never` + `danger-full-access`)**不许出现在这条路上**。
 */
export const CODEX_ACP_MODES = {
  readOnly: 'read-only',
  writes: 'workspace-write',
} as const

/** 这条路上**全部**的时限,一处定义。 */
export const ACP_TIMEOUT_MS = {
  /** 一问一答:`session/new` / `session/load` / `session/set_mode`。 */
  request: 15_000,
  /**
   * 握手。`npx -y` 第一次要把包下下来(本机量过约 2 分钟),之后走缓存几秒。
   * 握手期间登记处那一问(`capabilities()`)就等着 —— 若采纳,装插件时该预热一次(交接里写)。
   */
  handshake: 90_000,
  /** 等它把这一轮说完(`expect:'reply'`)。卡上带了 `deadline` 就听卡的,这是没带时的上限。 */
  turn: 10 * 60 * 1000,
  /** `session/prompt` 那一问本身的时限:这一轮**最多**跑多久(到点就当它死在里面了)。 */
  promptMax: 6 * 60 * 60 * 1000,
  /** `expect:'ack'`:prompt 发出去之后等它第一个动静。 */
  ack: 5_000,
} as const

/** 连接断了 / 没起来。**可重试**的那一类失败(适配器据此抛 `RetryableError`)。 */
export class AcpAgentGone extends Error {
  constructor(why: string) { super(`codex-acp 断了:${why}`) }
}

/** 它反过来问我们、我们回的错误(JSON-RPC 的 code 原样给它)。 */
export class AcpRequestError extends Error {
  readonly code: number
  constructor(code: number, message: string) {
    super(message)
    this.code = code
  }
}

/** JSON-RPC「没这个方法」。 */
export const ACP_NOT_OURS = -32601
/** codex-acp 报「要先登录」用的 code(SDK `RequestError.authRequired`)。 */
export const ACP_AUTH_REQUIRED = -32000

/** 它回错误时抛的那一种(带 code,上层据此认「没登录」)。 */
export class AcpRefused extends Error {
  readonly code: number | undefined
  constructor(message: string, code?: number) {
    super(message)
    this.code = code
  }
}

/** 一条开好了的连接(握手已经过了)。 */
export interface AcpConnection {
  /** 问一句,等它的回包。它回 `error` 就抛 {@link AcpRefused},原话带在消息里。 */
  request: <T = unknown>(method: string, params?: unknown, timeoutMs?: number) => Promise<T>
  /** 发一条通知(不等回包)。 */
  notify: (method: string, params?: unknown) => void
  /** 看它吐出来的通知。回一个退订。 */
  watch: (listen: (note: AcpNotification) => void) => () => void
  /** 它死了的时候叫一声。回一个退订。 */
  onGone: (listen: (why: string) => void) => () => void
  /** 死了没;死了回那句人话。 */
  gone: () => string | undefined
  /**
   * **它反过来问我们**(`session/request_permission` 这一类带 id 的请求)。
   * 回什么就原样写回去;抛 {@link AcpRequestError} 就按那个 code 回错误;抛别的回 -32603。
   * 没挂的时候一律「没这个方法」。回一个退订。
   */
  onRequest: (handle: AcpRequestHandler) => () => void
  /** 握手时它报的能力(`agentCapabilities`)与认证方式(`authMethods`)。 */
  agent: { capabilities: Record<string, unknown>, authMethods: readonly { id?: unknown, name?: unknown }[] }
  /** 关掉(连带杀进程)。 */
  close: () => void
}

/** 它问我们一句,我们怎么答(见 {@link AcpConnection.onRequest})。 */
export type AcpRequestHandler = (method: string, params: Record<string, unknown>) => Promise<unknown> | unknown

export interface OpenAcpOptions {
  /** 报给它的客户端名(`clientInfo.name`)。 */
  clientName?: string
  /** 覆盖一问一答的时限(用例用)。 */
  timeoutMs?: number
  /** 覆盖握手的时限(用例用)。 */
  handshakeMs?: number
}

/**
 * 开一条连接:握手过了才返回。
 *
 * 握手中途它死了 → 抛 {@link AcpAgentGone};它回错误 → 抛带原话的 {@link AcpRefused}。
 */
export async function openAcpAgent(peer: AcpStdioPeer, options: OpenAcpOptions = {}): Promise<AcpConnection> {
  const requestTimeout = options.timeoutMs ?? ACP_TIMEOUT_MS.request
  const pending = new Map<number, { settle: (value: unknown) => void, fail: (error: Error) => void, timer: ReturnType<typeof setTimeout> }>()
  const watchers = new Set<(note: AcpNotification) => void>()
  const mourners = new Set<(why: string) => void>()
  let handler: AcpRequestHandler | undefined
  let nextId = 1
  let buffer = ''
  let goneWhy: string | undefined

  const write = (message: unknown): void => {
    if (goneWhy !== undefined) throw new AcpAgentGone(goneWhy)
    peer.send(JSON.stringify(message))
  }

  const die = (why: string): void => {
    if (goneWhy !== undefined) return
    goneWhy = why
    for (const [, flight] of pending) {
      clearTimeout(flight.timer)
      flight.fail(new AcpAgentGone(why))
    }
    pending.clear()
    for (const mourner of [...mourners]) {
      try { mourner(why) }
      catch { /* 这个看客的事 */ }
    }
    mourners.clear()
  }

  const request = <T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T> => {
    if (goneWhy !== undefined) return Promise.reject(new AcpAgentGone(goneWhy))
    const id = nextId++
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`codex-acp 超时未回 ${method}`))
      }, timeoutMs ?? requestTimeout)
      pending.set(id, { settle: value => resolve(value as T), fail: reject, timer })
      try { write({ jsonrpc: '2.0', id, method, params: params ?? {} }) }
      catch (error) {
        clearTimeout(timer)
        pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  /** 它问我们:交给上层答,答完写回去。**这一层一项都不替她选。** */
  const answer = async (id: unknown, method: string, params: Record<string, unknown>): Promise<void> => {
    let reply: unknown
    try {
      if (handler === undefined) throw new AcpRequestError(ACP_NOT_OURS, `工作台这条路不接 ${method}`)
      const result = await handler(method, params)
      reply = { jsonrpc: '2.0', id, result: result ?? {} }
    }
    catch (error) {
      const code = error instanceof AcpRequestError ? error.code : -32603
      reply = { jsonrpc: '2.0', id, error: { code, message: error instanceof Error ? error.message : String(error) } }
    }
    try { write(reply) }
    catch { /* 它已经没了,没人等这句回话 */ }
  }

  const take = (line: string): void => {
    const text = line.trim()
    if (text === '') return
    let message: { id?: unknown, method?: unknown, result?: unknown, error?: unknown, params?: unknown }
    try { message = JSON.parse(text) as typeof message }
    catch { return /* 一行坏的不影响别的 */ }
    const params = (typeof message.params === 'object' && message.params !== null) ? message.params as Record<string, unknown> : {}

    if (typeof message.method === 'string' && message.id !== undefined && message.id !== null) {
      void answer(message.id, message.method, params)
      return
    }
    if (typeof message.method === 'string') {
      for (const watcher of [...watchers]) {
        try { watcher({ method: message.method, params }) }
        catch { /* 这个看客的事 */ }
      }
      return
    }
    if (typeof message.id !== 'number') return
    const flight = pending.get(message.id)
    if (flight === undefined) return
    pending.delete(message.id)
    clearTimeout(flight.timer)
    if (message.error !== undefined && message.error !== null) {
      const error = message.error as { message?: unknown, code?: unknown }
      const detail = typeof error.message === 'string' ? error.message : JSON.stringify(message.error)
      flight.fail(new AcpRefused(detail, typeof error.code === 'number' ? error.code : undefined))
      return
    }
    flight.settle(message.result)
  }

  peer.onData((chunk) => {
    buffer += chunk
    let index = buffer.indexOf('\n')
    while (index >= 0) {
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      index = buffer.indexOf('\n')
      take(line)
    }
  })
  peer.onGone(die)

  let agent: AcpConnection['agent'] = { capabilities: {}, authMethods: [] }
  const connection: AcpConnection = {
    request,
    notify: (method, params) => {
      try { write({ jsonrpc: '2.0', method, params: params ?? {} }) }
      catch { /* 它没了,这条通知没人要了 */ }
    },
    watch: (listen) => {
      watchers.add(listen)
      return () => { watchers.delete(listen) }
    },
    onGone: (listen) => {
      if (goneWhy !== undefined) { listen(goneWhy); return () => { /* 已经叫过了 */ } }
      mourners.add(listen)
      return () => { mourners.delete(listen) }
    },
    gone: () => goneWhy,
    onRequest: (handle) => {
      handler = handle
      return () => { if (handler === handle) handler = undefined }
    },
    get agent() { return agent },
    close: () => {
      die('工作台自己关掉了')
      watchers.clear()
      peer.kill()
    },
  }

  try {
    const hello = await request<{ agentCapabilities?: unknown, authMethods?: unknown }>(ACP_METHODS.initialize, {
      protocolVersion: ACP_PROTOCOL_VERSION,
      // 我们不做文件 / 终端那几样:它要改文件走它自己的沙箱,要问人走 request_permission。
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: options.clientName ?? 'desktop-workbench', version: '1' },
    }, options.handshakeMs ?? ACP_TIMEOUT_MS.handshake)
    agent = {
      capabilities: (typeof hello?.agentCapabilities === 'object' && hello.agentCapabilities !== null) ? hello.agentCapabilities as Record<string, unknown> : {},
      authMethods: Array.isArray(hello?.authMethods) ? hello.authMethods as { id?: unknown, name?: unknown }[] : [],
    }
  }
  catch (error) {
    peer.kill()
    throw error
  }
  return connection
}

/** 一个长连接的持有者:第一次用才起进程,断了下一次自己重起。 */
export interface AcpAgentLink {
  open: () => Promise<AcpConnection>
  close: () => void
}

export interface AcpAgentLinkDeps extends OpenAcpOptions {
  /** 起一条 stdio 对端。 */
  spawnPeer: () => AcpStdioPeer | Promise<AcpStdioPeer>
}

/**
 * **一个**长连接的 codex-acp 子进程,断了重起(与 `codexAppServerLink` 同一个管法:
 * 送话要听事件、权限请求要能答,一问一答起一个杀一个的用法听不到)。
 */
export function acpAgentLink(deps: AcpAgentLinkDeps): AcpAgentLink {
  let current: Promise<AcpConnection> | undefined
  let opened: AcpConnection | undefined

  const open = async (): Promise<AcpConnection> => {
    const live = current
    if (live !== undefined) {
      try {
        const connection = await live
        if (connection.gone() === undefined) return connection
        // 重起之前把旧那个对端杀掉(同 app-server 那条的理由:进程活着就握着线程写入锁)。
        try { connection.close() }
        catch { /* 已经没了就没什么可关的 */ }
      }
      catch { /* 上一次起失败了:下面重起一条 */ }
    }
    const next = (async () => await openAcpAgent(await deps.spawnPeer(), deps))()
    current = next
    try {
      const connection = await next
      if (current === next) opened = connection
      return connection
    }
    catch (error) {
      if (current === next) { current = undefined; opened = undefined }
      throw error
    }
  }

  return {
    open,
    close: () => {
      const live = current
      const ready = opened
      current = undefined
      opened = undefined
      if (ready !== undefined) { ready.close(); return }
      void live?.then(connection => { connection.close() }, () => { /* 没起起来就没什么可关的 */ })
    },
  }
}

/** DSH 宿主(launchd 起的)PATH 很短,`npx` 常不在上面;装 node 的那几处按次序找。 */
export const NPX_FALLBACKS: readonly string[] = ['/opt/homebrew/bin/npx', '/usr/local/bin/npx']

/**
 * 这台机器上的 `npx` 在哪:PATH 上找得到就用它;找不到按 {@link NPX_FALLBACKS};都没有回 `'npx'`,
 * 让 spawn 的 ENOENT 照常走「代理没起来」那条退路(与 `resolveCodexBinary` 同一个分寸)。
 */
export function findNpx(pathEnv: string | undefined, exists: (file: string) => boolean): string {
  for (const dir of (pathEnv ?? '').split(':')) {
    if (dir !== '' && exists(`${dir}/npx`)) return `${dir}/npx`
  }
  for (const one of NPX_FALLBACKS) if (exists(one)) return one
  return 'npx'
}

export interface SpawnCodexAcpOptions {
  /**
   * 这台机器上那份 `codex`(ChatGPT 桌面版自带的那一份,与今天 app-server 那条同源)。
   * 缺席 = 让 codex-acp 用它自己包里带的 `@openai/codex`(另一份二进制、同一个 `~/.codex` 登录态)。
   */
  codexBinary?: string
  /** `npx` 在哪(DSH 宿主的 PATH 可能很短)。缺席 = `npx`。 */
  npx?: string
  /** 它的 stderr 往哪去(真机脚本要看日志就 `pipe` + {@link onStderr};插件里缺省不看)。 */
  stderr?: 'ignore' | 'inherit' | 'pipe'
  onStderr?: (chunk: string) => void
  /** 它自己的日志目录(`APP_SERVER_LOGS`);缺席 = 不设。 */
  logsDir?: string
}

/**
 * 真机那条:起一个 `npx -y @agentclientprotocol/codex-acp@<钉死版本>` 子进程当对端。
 *
 * 环境里只多三样:`CODEX_PATH`(用哪份 codex)、`INITIAL_AGENT_MODE=read-only`(新会话缺省最保守的那一档,
 * 送话前再按卡 `set_mode`)、`NO_BROWSER=1`(它列认证方式时别把「开浏览器登录」列进来 —— 我们从不调 authenticate)。
 * **不**往环境里写任何 Key / Token。stdin 的错误一定要接(同 app-server 那条:EPIPE 没人接会把整个 DSH 带崩)。
 */
export async function spawnCodexAcpPeer(options: SpawnCodexAcpOptions = {}): Promise<AcpStdioPeer> {
  const { spawn } = await import('node:child_process')
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...(options.codexBinary === undefined ? {} : { CODEX_PATH: options.codexBinary }),
    INITIAL_AGENT_MODE: CODEX_ACP_MODES.readOnly,
    NO_BROWSER: '1',
    ...(options.logsDir === undefined ? {} : { APP_SERVER_LOGS: options.logsDir }),
  }
  const child = spawn(options.npx ?? 'npx', ['-y', `${CODEX_ACP_PACKAGE}@${CODEX_ACP_VERSION}`], {
    env,
    stdio: ['pipe', 'pipe', options.stderr ?? 'ignore'],
  })
  const goneListeners = new Set<(why: string) => void>()
  const gone = (why: string): void => { for (const listen of goneListeners) listen(why) }
  const stdin = child.stdin
  const stdout = child.stdout
  if (stdin === null || stdout === null) { child.kill(); throw new AcpAgentGone('起进程时没拿到它的 stdin / stdout') }

  child.on('error', error => gone(error.message))
  child.on('exit', code => gone(`提前退出(${code ?? '被信号杀掉'})`))
  stdin.on('error', error => gone(error.message))
  if (options.stderr === 'pipe' && child.stderr !== null) child.stderr.on('data', chunk => options.onStderr?.(String(chunk)))

  return {
    send: (line) => {
      if (stdin.destroyed || !stdin.writable) throw new AcpAgentGone('它的 stdin 已经关了')
      stdin.write(`${line}\n`)
    },
    onData: listen => stdout.on('data', chunk => listen(String(chunk))),
    onGone: (listen) => { goneListeners.add(listen) },
    kill: () => { child.kill() },
  }
}
