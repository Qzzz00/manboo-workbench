/**
 * `codex app-server` 那条 stdio JSON-RPC 的**共用**客户端(2026-10-02,卡「Codex 协议适配器」)。
 *
 * ## 为什么要有这一份
 *
 * 到 10-02 为止,工作台有两处各自手写同一套握手 + 读行 + 对 id 的代码:
 * 额度那条(`src/quota/codexAppServer.ts`)和现在要加的送话那条。
 * `docs/设计-一条引擎替八条管线-2026-10-02.md` 的根子就是「同一件事多处各写一遍」,
 * 所以这一份是**唯一**一处:协议细节、超时、断线重起、它反过来问我们时怎么答,全在这儿。
 *
 * ## 这条路的分寸(不许退让的三条)
 *
 * 1. **不经手任何凭据**。app-server 走的是 ChatGPT 桌面版自己的登录态(`account/updated {authMode:'chatgpt'}`)。
 *    它若反过来要我们刷新令牌(`account/chatgptAuthTokens/refresh`),我们回**错误**——
 *    那是桌面 App 自己的活,工作台一个令牌字段都不碰。
 * 2. **不替她批准**。要批准的那几问(跑命令 / 改文件)一律 `decline`:
 *    她不在电脑前,挂在那儿等人点才是真卡死。放开到哪一档由调用方在 `thread/start` 里说清,
 *    而且 `danger-full-access` 不许出现在这条路上(见 `codex.ts` 的 `CODEX_SANDBOX_*`)。
 * 3. **超时一处**。{@link CODEX_TIMEOUT_MS} 是这条路上**全部**的时限,别处不再各自写一个数。
 *
 * ## 协议(10-02 本机对 codex-cli 0.159.2 验过,schema 由
 * `codex app-server generate-json-schema --out <dir>` 生成)
 *
 * - 握手:`initialize {clientInfo}` → 回包 → 我们发 `initialized` 通知;
 * - 列她桌面 App 里的线程:`thread/list {limit}` → `{data:[{id,sessionId,cwd,preview,…}]}`
 *   (**`id` 与 `sessionId` 是同一个 UUID**,也与 `~/.codex/sessions` 里 rollout 文件名上那个一致);
 * - 开新的 / 接着那条:`thread/start {cwd,approvalPolicy,sandbox}` / `thread/resume {threadId}`;
 * - 送一句:`turn/start {threadId,input:[{type:'text',text}]}` → 回包带 `turn{id,status}`;
 * - 事件:`turn/started`、`item/completed {item:{type:'agentMessage',text,phase}}`、`turn/completed {threadId,turn}`、
 *   `error {threadId,turnId,error,willRetry}`;停一轮:`turn/interrupt {threadId,turnId}`。
 */

/** 它从 stdout 吐出来的一条消息(通知:没有 `id`)。 */
export interface CodexNotification {
  method: string
  params: Record<string, unknown>
}

/**
 * 一条 stdio 对端。真机是 `codex app-server` 子进程({@link spawnCodexAppServerPeer}),
 * 用例里是假对端 —— 这一层把「起进程」隔在外面,用例一个真进程都不起。
 */
export interface CodexStdioPeer {
  /** 往它的 stdin 写一行(**不带**换行,这边补)。写不进去就抛。 */
  send: (line: string) => void
  /** 它从 stdout 吐出来的字节(可能是半行,断行由这边拼)。 */
  onData: (listen: (chunk: string) => void) => void
  /** 它没了(退出 / 出错)。`why` 是人话。 */
  onGone: (listen: (why: string) => void) => void
  /** 收工。 */
  kill: () => void
}

/** 一条开好了的连接(握手已经过了)。 */
export interface CodexAppServerConnection {
  /** 问一句,等它的回包。它回 `error` 就抛,原话带在消息里。 */
  request: <T = unknown>(method: string, params?: unknown, timeoutMs?: number) => Promise<T>
  /** 发一条通知(不等回包)。 */
  notify: (method: string, params?: unknown) => void
  /** 看它吐出来的通知。回一个退订。 */
  watch: (listen: (note: CodexNotification) => void) => () => void
  /** 它死了的时候叫一声(等事件的那一头据此收场,不干等到超时)。回一个退订。 */
  onGone: (listen: (why: string) => void) => () => void
  /** 死了没;死了回那句人话。 */
  gone: () => string | undefined
  /** 关掉(连带杀进程)。 */
  close: () => void
}

/**
 * 这条路上**全部**的时限,一处定义(卡要求「超时一处」)。
 * 一问一答那个 15 秒沿用额度那条路实测的数(握手 + 一问约 1.6 秒,15 秒是宽的)。
 */
export const CODEX_TIMEOUT_MS = {
  /** 一问一答:握手、`thread/start`、`thread/resume`、`turn/start`、`turn/interrupt`。 */
  request: 15_000,
  /** 等它把这一轮说完(`expect:'reply'`)。卡上带了 `deadline` 就听卡的,这是没带时的上限。 */
  turn: 10 * 60 * 1000,
  /** `expect:'ack'`:`turn/start` 的回包已经到了,再等一下 `turn/started` 这条通知。 */
  ack: 5_000,
} as const

/** 连接断了 / 没起来。**可重试**的那一类失败(适配器据此抛 `RetryableError`)。 */
export class CodexAppServerGone extends Error {
  constructor(why: string) { super(`codex app-server 断了:${why}`) }
}

/**
 * 它反过来要我们批准时的答复。**一律不批**:她不在电脑前,
 * 挂在那儿等一个不在的人点才是真卡死 —— 与 `agentDispatch.ts` 里
 * `--permission-prompts none`(任何要问人的一步直接拒)同一个分寸。
 */
const DENIED_APPROVALS: Readonly<Record<string, unknown>> = {
  'item/commandExecution/requestApproval': { decision: 'decline' },
  'item/fileChange/requestApproval': { decision: 'decline' },
  execCommandApproval: { decision: 'decline' },
  applyPatchApproval: { decision: 'decline' },
}

/** 它反过来问我们、而我们不接的那一问,回这个错误码(JSON-RPC 的「没这个方法」)。 */
const NOT_OURS = -32601

export interface OpenCodexOptions {
  /** 报给它的客户端名(`clientInfo.name`)。 */
  clientName?: string
  /** 覆盖一问一答的时限(用例用)。 */
  timeoutMs?: number
}

/**
 * 开一条连接:握手过了才返回。
 *
 * 握手中途它死了 → 抛 {@link CodexAppServerGone};它回错误 → 抛带原话的 Error。
 */
export async function openCodexAppServer(
  peer: CodexStdioPeer,
  options: OpenCodexOptions = {},
): Promise<CodexAppServerConnection> {
  const requestTimeout = options.timeoutMs ?? CODEX_TIMEOUT_MS.request
  const pending = new Map<number, { settle: (value: unknown) => void, fail: (error: Error) => void, timer: ReturnType<typeof setTimeout> }>()
  const watchers = new Set<(note: CodexNotification) => void>()
  const mourners = new Set<(why: string) => void>()
  let nextId = 1
  let buffer = ''
  let goneWhy: string | undefined

  const write = (message: unknown): void => {
    if (goneWhy !== undefined) throw new CodexAppServerGone(goneWhy)
    peer.send(JSON.stringify(message))
  }

  const die = (why: string): void => {
    if (goneWhy !== undefined) return
    goneWhy = why
    // 在飞的那几问一起 reject:不留一个永远不 settle 的 Promise。
    for (const [, flight] of pending) {
      clearTimeout(flight.timer)
      flight.fail(new CodexAppServerGone(why))
    }
    pending.clear()
    for (const mourner of [...mourners]) {
      try { mourner(why) }
      catch { /* 这个看客的事 */ }
    }
    mourners.clear()
  }

  const request = <T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T> => {
    if (goneWhy !== undefined) return Promise.reject(new CodexAppServerGone(goneWhy))
    const id = nextId++
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`codex app-server 超时未回 ${method}`))
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

  const answer = (id: unknown, method: string): void => {
    const allowed = DENIED_APPROVALS[method]
    const reply = allowed === undefined
      // 不接的那一问里有 `account/chatgptAuthTokens/refresh` —— 刷登录令牌是桌面 App 自己的活,
      // 工作台不经手凭据,所以这里回错误,**不**往回写任何像令牌的字段。
      ? { jsonrpc: '2.0', id, error: { code: NOT_OURS, message: `工作台这条路不接 ${method}` } }
      : { jsonrpc: '2.0', id, result: allowed }
    try { write(reply) }
    catch { /* 它已经没了,没人等这句回话 */ }
  }

  const take = (line: string): void => {
    const text = line.trim()
    if (text === '') return
    let message: { id?: unknown, method?: unknown, result?: unknown, error?: unknown, params?: unknown }
    try { message = JSON.parse(text) as typeof message }
    catch { return /* 一行坏的不影响别的(额度那条路同一口径) */ }

    if (typeof message.method === 'string' && message.id !== undefined) {
      answer(message.id, message.method)
      return
    }
    if (typeof message.method === 'string') {
      const params = (typeof message.params === 'object' && message.params !== null)
        ? message.params as Record<string, unknown>
        : {}
      for (const watcher of [...watchers]) {
        // 一个看客抛了不该把这条连接带走。
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
      const detail = (message.error as { message?: unknown }).message
      flight.fail(new Error(typeof detail === 'string' ? detail : JSON.stringify(message.error)))
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

  const connection: CodexAppServerConnection = {
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
    close: () => {
      die('工作台自己关掉了')
      watchers.clear()
      peer.kill()
    },
  }

  try {
    await request('initialize', { clientInfo: { name: options.clientName ?? 'desktop-workbench', version: '1' } })
  }
  catch (error) {
    peer.kill()
    throw error
  }
  connection.notify('initialized')
  return connection
}

/** 一个长连接的持有者:第一次用才起进程,断了下一次自己重起。 */
export interface CodexAppServerLink {
  /** 拿一条活的连接。 */
  open: () => Promise<CodexAppServerConnection>
  /** 关掉(整个工作台停的时候叫一次)。 */
  close: () => void
}

export interface CodexAppServerLinkDeps extends OpenCodexOptions {
  /** 起一条 stdio 对端。 */
  spawnPeer: () => CodexStdioPeer | Promise<CodexStdioPeer>
}

/**
 * **一个**长连接的 app-server 子进程,断了重起(卡要求的进程管理)。
 *
 * 为什么不像额度那条路一样每次新起一个:送话要**听事件**(`turn/completed` 可能几十秒后才来),
 * 一问一答起一个、杀一个的那种用法听不到。所以这里留一条,握手只付一次(约 1.6 秒)。
 */
export function codexAppServerLink(deps: CodexAppServerLinkDeps): CodexAppServerLink {
  let current: Promise<CodexAppServerConnection> | undefined
  /** 已经开好的那一条(`close` 要能**当场**关掉,不能等一个 then 的下一拍)。 */
  let opened: CodexAppServerConnection | undefined

  const open = async (): Promise<CodexAppServerConnection> => {
    const live = current
    if (live !== undefined) {
      try {
        const connection = await live
        if (connection.gone() === undefined) return connection
        /*
         * ★ **重起之前把旧那个对端杀掉**(2026-10-04,卡「Codex 线程被占时换路」)。
         *
         * 「它死了」不一定等于**那个进程没了**:`spawnCodexAppServerPeer` 里往 stdin 写出错
         * (EPIPE)也会叫 `onGone`,那一下子进程可能还活着。而 `codex app-server` 活着就一直握着
         * 它加载过的那几条线程的写入锁(`~/.codex/thread-writer-locks/<threadId>.lock`,本机量过),
         * 于是新起的那一条**永远 resume 不上同一条线程** —— 自己把自己挡在外面。
         * `close()` 连带 `peer.kill()`,锁随进程退出当场放。
         */
        try { connection.close() }
        catch { /* 已经没了就没什么可关的 */ }
      }
      catch { /* 上一次起失败了:下面重起一条 */ }
    }
    const next = (async () => await openCodexAppServer(await deps.spawnPeer(), deps))()
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
      // 还在握手:等它开好了再关(`openCodexAppServer` 自己失败时已经杀过进程了)。
      void live?.then(connection => { connection.close() }, () => { /* 没起起来就没什么可关的 */ })
    },
  }
}

/**
 * ChatGPT 桌面版自带的那一份 `codex`。
 *
 * **2026-10-02 改对**:原来写的是 `Contents/Resources/codex`,那个路径在 codex-cli 0.159.2 上
 * 早就不存在了(见 `docs/设计-一条引擎替八条管线-2026-10-02.md` 第六节)——
 * 于是 PATH 上没有 `codex` 时,额度那条实时路一直静默失败、挂着会话文件里的旧快照。
 * 本机现查:`/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex`(0.159.2)。
 */
export const CODEX_APP_BUNDLE_BINARY = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex'

/**
 * 决定 spawn 哪个 `codex`(2026-09-08 真机:事故删掉 ~/.local/bin 之后 PATH 上再没有 `codex`,
 * 实时路静默失败、整周挂着 9/3 的旧快照「剩 7%」,而真实是 100%)。
 * 规则:PATH 里找得到就用它(跟他终端里的是同一个);找不到就用 ChatGPT.app 自带的那份;
 * 两个都没有就仍然返回 `'codex'`,让 spawn 的 ENOENT 照常走调用方的退路。
 * @param pathEnv - `PATH` 环境变量
 * @param exists - 文件存在性探测(测试注入)
 */
export function resolveCodexBinary(
  pathEnv: string | undefined,
  exists: (file: string) => boolean,
): string {
  for (const dir of (pathEnv ?? '').split(':')) {
    if (dir !== '' && exists(`${dir}/codex`)) return 'codex'
  }
  if (exists(CODEX_APP_BUNDLE_BINARY)) return CODEX_APP_BUNDLE_BINARY
  return 'codex'
}

/**
 * 真机那条:起一个 `codex app-server` 子进程当对端。
 *
 * stdin 的错误**一定要接**:它提前退出后再往 stdin 写会抛 EPIPE,那一下没人接就是
 * 「未捕获异常」,**整个 DSH 连工作台一起崩**(2026-09-26 20:48 生产上真崩过一次)。
 */
export async function spawnCodexAppServerPeer(binary?: string): Promise<CodexStdioPeer> {
  const { spawn } = await import('node:child_process')
  const { existsSync } = await import('node:fs')
  const bin = binary ?? resolveCodexBinary(process.env.PATH, existsSync)
  const child = spawn(bin, ['app-server'], { stdio: ['pipe', 'pipe', 'ignore'] })
  const goneListeners = new Set<(why: string) => void>()
  const gone = (why: string): void => { for (const listen of goneListeners) listen(why) }

  child.on('error', error => gone(error.message))
  child.on('exit', code => gone(`提前退出(${code ?? '被信号杀掉'})`))
  child.stdin.on('error', error => gone(error.message))

  return {
    send: (line) => {
      if (child.stdin.destroyed || !child.stdin.writable) throw new CodexAppServerGone('它的 stdin 已经关了')
      child.stdin.write(`${line}\n`)
    },
    onData: listen => child.stdout.on('data', chunk => listen(String(chunk))),
    onGone: (listen) => { goneListeners.add(listen) },
    kill: () => { child.kill() },
  }
}

/**
 * 开一条、问一句、关掉(额度那条路要的就是这个:不留常驻进程)。
 */
export async function askCodexAppServerOnce<T = unknown>(
  method: string,
  params?: unknown,
  deps: { spawnPeer?: () => CodexStdioPeer | Promise<CodexStdioPeer>, clientName?: string } = {},
): Promise<T> {
  const peer = await (deps.spawnPeer ?? spawnCodexAppServerPeer)()
  const connection = await openCodexAppServer(peer, { clientName: deps.clientName ?? 'desktop-workbench' })
  try { return await connection.request<T>(method, params) }
  finally { connection.close() }
}
