/**
 * 座机服务(阶段 1):站在插件前面,转发一切;另给两条只读的口 —— GET /snapshot 与 GET /events?since=。
 *
 * 归座机服务自己的只有两条**精确**路径:/events 与 /snapshot(插件已有的 /snapshot/layout.md 照转)。
 * 其余任何路径、任何方法、任何 WS 升级都原样转给上游,插件一行逻辑不改。
 *
 * ★ 非本机来源(为什么默认 403):插件按 socket 的远端地址判「是不是本机」,回环来源不看设备令牌、
 * 能开配对码、能连 /helper(指挥本机真窗口)。经座机服务转过去的请求在插件眼里**全是 127.0.0.1**。
 * 所以局域网来的请求绝不能转到回环那条上游。配了 upstreamRemote(插件「允许局域网访问」时
 * 开在 0.0.0.0 上的同端口,用本机局域网地址去连,插件看到的来源就不是回环)才转过去,
 * 由插件自己照旧认令牌;没配就 403。/events、/snapshot 这一版只给本机。
 */
import { Agent, createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'
import { EventLog } from './events.ts'
import { Mirror } from './mirror.ts'
import { REMOTE_REFUSED_TEXT, createHttpForwarder, forwardUpgrade, interfaceTarget, isLoopbackAddress, parseTarget, refuseUpgrade, sendJson, type Target } from './proxy.ts'

export { isLoopbackAddress }

export interface CoreOptions {
  port: number
  host?: string
  /** 插件的回环地址,如 http://127.0.0.1:8790 */
  upstream: string
  /**
   * 非本机来源转到哪。'interface' = 进来的那块网卡的本机地址 + 上游端口(见 proxy.ts interfaceTarget);
   * 也可以写死一个 http:// 地址;缺省 = 非本机一律 403。
   */
  upstreamRemote?: string
  keepEvents?: number
  keepBytes?: number
  reconnectMinMs?: number
  reconnectMaxMs?: number
  liveIdleMs?: number
  sseHeartbeatMs?: number
  /** 转发出去之后等上游回头(HTTP 的响应头、WS 的第一个字节)最多多久;过了回 502 upstream_timeout。 */
  upstreamHeadersTimeoutMs?: number
  /** 测试注入:扮演非本机来源。 */
  isLoopback?: (req: IncomingMessage) => boolean
  log?: (line: string) => void
}

export interface Core {
  port: number
  events: EventLog
  mirror: Mirror
  close: () => Promise<void>
}

export const DEFAULTS = {
  keepEvents: 2000,
  /** 一份 /state 实测约 470 KB,sessions 一个键就占大半;64 MB 够留几百次整键变化。 */
  keepBytes: 64 * 1024 * 1024,
  reconnectMinMs: 250,
  reconnectMaxMs: 3000,
  /** 插件 /live 每 20 秒一次应用层 ping;两拍半不来就判死。 */
  liveIdleMs: 50_000,
  sseHeartbeatMs: 15_000,
  /**
   * 只管回头之前,回了头的 SSE / 流式响应 / WS 多久都不断。插件有合法的慢路(诊断打包最多 120 秒才回),
   * 所以给足 5 分钟:要防的是 DSH 卡死时客户端与这边的连接永远挂着,不是催上游。
   */
  upstreamHeadersTimeoutMs: 5 * 60_000,
} as const

export async function startCore(options: CoreOptions): Promise<Core> {
  const upstream = parseTarget(options.upstream)
  const remoteMode = options.upstreamRemote === undefined || options.upstreamRemote === ''
    ? 'refuse' as const
    : options.upstreamRemote === 'interface' ? 'interface' as const : parseTarget(options.upstreamRemote)
  if (typeof remoteMode === 'object' && isLoopbackAddress(remoteMode.host)) {
    throw new Error('非本机来源的上游不能是回环地址:插件会把它当本机、不再认设备令牌')
  }
  const isLoopback = options.isLoopback ?? ((req: IncomingMessage) => isLoopbackAddress(req.socket.remoteAddress))
  const sseHeartbeatMs = options.sseHeartbeatMs ?? DEFAULTS.sseHeartbeatMs

  const events = new EventLog({
    keep: options.keepEvents ?? DEFAULTS.keepEvents,
    keepBytes: options.keepBytes ?? DEFAULTS.keepBytes,
  })
  const mirror = new Mirror({
    liveUrl: `ws://${upstream.host.includes(':') ? `[${upstream.host}]` : upstream.host}:${upstream.port}/live`,
    events,
    reconnectMinMs: options.reconnectMinMs ?? DEFAULTS.reconnectMinMs,
    reconnectMaxMs: options.reconnectMaxMs ?? DEFAULTS.reconnectMaxMs,
    liveIdleMs: options.liveIdleMs ?? DEFAULTS.liveIdleMs,
    ...(options.log === undefined ? {} : { log: options.log }),
  })

  // keepAlive:每一拍 /state、/call/claim 都新建 TCP 是白花的握手;上游重启后旧连接由 Agent 自己丢。
  const agent = new Agent({ keepAlive: true, maxSockets: 256 })
  const headersTimeoutMs = options.upstreamHeadersTimeoutMs ?? DEFAULTS.upstreamHeadersTimeoutMs
  const forward = createHttpForwarder(agent, headersTimeoutMs)
  const sse = new Set<ServerResponse>()

  function targetFor(req: IncomingMessage): Target | undefined {
    if (isLoopback(req)) return upstream
    if (remoteMode === 'refuse') return undefined
    if (remoteMode === 'interface') return interfaceTarget(req.socket.localAddress, upstream.port)
    return remoteMode
  }

  function snapshot(res: ServerResponse): void {
    sendJson(res, 200, {
      epoch: events.epoch,
      snapshot_seq: events.lastSeq,
      upstream: { connected: mirror.connected, changed_at: mirror.changedAt },
      state: mirror.state,
    })
  }

  function stream(req: IncomingMessage, res: ServerResponse, query: URLSearchParams): void {
    // 浏览器 EventSource 断线重连时 URL 不变(还是当初的 ?since=),读到哪只在这条头里:头优先。
    const lastEventId = req.headers['last-event-id']
    const raw = (typeof lastEventId === 'string' && lastEventId !== '' ? lastEventId : null) ?? query.get('since') ?? '0'
    if (!/^\d+$/.test(raw)) { sendJson(res, 400, { error: 'since 要是非负整数' }); return }
    const since = Number(raw)
    const epoch = query.get('epoch')
    if (epoch !== null && epoch !== events.epoch) {
      sendJson(res, 410, { error: '座机服务重启过,序号换了一轮;先取 /snapshot 再续', reason: 'epoch', epoch: events.epoch, last_seq: events.lastSeq })
      return
    }
    const check = events.since(since)
    if (!check.ok) {
      sendJson(res, 410, {
        error: check.reason === 'too_old' ? '要的那一段已经不在缓冲里了;先取 /snapshot 再续' : '这个序号不是这一轮的;先取 /snapshot 再续',
        reason: check.reason,
        epoch: events.epoch,
        oldest_seq: check.oldest_seq,
        last_seq: check.last_seq,
      })
      return
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    req.socket.setNoDelay(true)
    let sent = since
    const write = (seq: number, line: string): void => {
      if (seq <= sent) return
      sent = seq
      res.write(`id: ${seq}\ndata: ${line}\n\n`)
    }
    res.write(`retry: 2000\nevent: hello\ndata: ${JSON.stringify({ epoch: events.epoch, last_seq: events.lastSeq })}\n\n`)
    // 回放与订阅之间没有 await:同一拍里先回放完,再挂上监听,不会漏也不会重(write 再按 seq 兜一道)。
    for (const { seq, line } of events.linesSince(since)) write(seq, line)
    const off = events.subscribe((event, line) => write(event.seq, line))
    const beat = setInterval(() => res.write(': ping\n\n'), sseHeartbeatMs)
    sse.add(res)
    res.on('close', () => { off(); clearInterval(beat); sse.delete(res) })
  }

  const server: Server = createServer((req, res) => {
    const [pathPart, queryPart] = (req.url ?? '/').split('?', 2) as [string, string | undefined]
    const own = pathPart === '/events' || pathPart === '/snapshot'
    if (own) {
      if (!isLoopback(req)) { sendJson(res, 403, { error: REMOTE_REFUSED_TEXT }); return }
      if (req.method !== 'GET') { sendJson(res, 405, { error: '这条只读' }, { allow: 'GET' }); return }
      if (pathPart === '/snapshot') snapshot(res)
      else stream(req, res, new URLSearchParams(queryPart ?? ''))
      return
    }
    const target = targetFor(req)
    if (target === undefined) { sendJson(res, 403, { error: REMOTE_REFUSED_TEXT }); return }
    forward(req, res, target)
  })
  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const target = targetFor(req)
    if (target === undefined) { refuseUpgrade(socket, 403, REMOTE_REFUSED_TEXT); return }
    forwardUpgrade(req, socket, head, target, headersTimeoutMs)
  })
  // 长连接(SSE、/live)不该被默认的请求超时掐掉。
  server.requestTimeout = 0
  server.headersTimeout = 60_000

  await new Promise<void>((resolve, reject) => {
    server.once('error', (err: NodeJS.ErrnoException) => {
      reject(err.code === 'EADDRINUSE' ? new Error(`端口 ${options.port} 已被占用,换一个或先停掉占用的进程`) : err)
    })
    server.listen(options.port, options.host ?? '127.0.0.1', () => resolve())
  })
  mirror.start()

  return {
    port: (server.address() as AddressInfo).port,
    events,
    mirror,
    close: async () => {
      mirror.stop()
      for (const res of sse) res.destroy()
      agent.destroy()
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
    },
  }
}
