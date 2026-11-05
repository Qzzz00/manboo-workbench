/**
 * 原样转发:HTTP 请求与 WS 升级。
 *
 * HTTP 走 node:http 客户端,请求体与响应体都是 pipe(边到边,流式响应不攒);只摘逐跳头
 * (connection / keep-alive / transfer-encoding …),其余头、方法、路径、查询串、状态码、状态行原样。
 * 加一条 x-forwarded-for(插件不看它,将来路由搬过来时用得上)。
 *
 * WS 升级走裸 TCP:把客户端那一行请求与头原样写给上游,之后两条 socket 互相 pipe。
 * 101 由上游自己回,帧不经解析,壳的 /helper 与手机的 /live 都不知道中间多了一层。
 *
 * 上游连不上(DSH 在重启、插件没起来)时 HTTP 回 502 + 一句人话,WS 升级也回 502 响应行 ——
 * 让客户端走自己的重试,不让它看到「连接被拒」,也不编数据。
 *
 * ★ 为什么是 502 不是 503:8791 的契约里 503 已经有主了 ——「这项能力本机没配」(语音、形象、引导)。
 * 手机把 503 读成 unavailable,语音一关就是 60 秒(butler-app/src/api/client.ts 文件头、api/voice.ts);
 * 502 在手机是 kind=http,「掉线不改判断」;壳的 /ready 探针认 status < 500,工人与 /state 轮询对两者一视同仁。
 */
import { Agent, request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type OutgoingHttpHeaders, type ServerResponse } from 'node:http'
import { connect, type Socket } from 'node:net'
import type { Duplex } from 'node:stream'

export const UPSTREAM_DOWN_TEXT = '工作台后台这会儿不在(多半是 DSH 在重启),稍等几秒会自己恢复。'
export const UPSTREAM_SILENT_TEXT = '工作台后台接了请求却一直没回话(多半是 DSH 卡住了),稍后再试。'
export const REMOTE_REFUSED_TEXT = '座机服务这一版只接本机来源;局域网的设备请先连插件自己的端口。'
/** 502 里建议的重试秒数。DSH 重启实测十几秒,手机 3 秒一轮本来就会再来,这里只是给守规矩的客户端一个数。 */
const RETRY_AFTER_SECONDS = '3'

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-connection', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
])

export interface Target {
  host: string
  port: number
}

export function isLoopbackAddress(address: string | undefined = ''): boolean {
  return address === '::1' || address.startsWith('127.') || address.startsWith('::ffff:127.')
}

/**
 * 非本机来源的上游:客户端连进来的那块网卡的本机地址 + 插件端口。
 * 插件开着「允许局域网访问」时在 0.0.0.0 上听同一个端口;从这个地址连过去,插件看到的来源
 * 就是这块网卡的地址(非回环),于是照旧认设备令牌。地址是回环就不给 —— 绝不把远端请求转成回环来源。
 * 每次按进来的那条连接现取,DHCP 换了地址、换了网也跟着走。
 */
export function interfaceTarget(localAddress: string | undefined, port: number): Target | undefined {
  if (localAddress === undefined || localAddress === '' || isLoopbackAddress(localAddress)) return undefined
  return { host: localAddress.startsWith('::ffff:') ? localAddress.slice(7) : localAddress, port }
}

export function parseTarget(url: string): Target {
  const parsed = new URL(url)
  if (parsed.protocol !== 'http:') throw new Error(`上游地址只支持 http://:${url}`)
  const port = parsed.port === '' ? 80 : Number(parsed.port)
  // URL 把 IPv6 包成 [::1],net.connect 要的是裸地址。
  return { host: parsed.hostname.replace(/^\[(.*)\]$/, '$1'), port }
}

function forwardedFor(req: IncomingMessage): string {
  const prior = req.headers['x-forwarded-for']
  const self = req.socket.remoteAddress ?? ''
  const mapped = self.startsWith('::ffff:') ? self.slice(7) : self
  return typeof prior === 'string' && prior !== '' ? `${prior}, ${mapped}` : mapped
}

function requestHeaders(req: IncomingMessage): OutgoingHttpHeaders {
  const headers: OutgoingHttpHeaders = {}
  // connection 头里点名的也是逐跳头。
  const named = new Set(String(req.headers.connection ?? '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean))
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined || HOP_BY_HOP.has(name) || named.has(name)) continue
    headers[name] = value
  }
  headers['x-forwarded-for'] = forwardedFor(req)
  return headers
}

function responseHeaders(headers: IncomingHttpHeaders): OutgoingHttpHeaders {
  const out: OutgoingHttpHeaders = {}
  const named = new Set(String(headers.connection ?? '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean))
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || HOP_BY_HOP.has(name) || named.has(name)) continue
    out[name] = value
  }
  return out
}

export function sendJson(res: ServerResponse, status: number, body: unknown, extra: OutgoingHttpHeaders = {}): void {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
    ...extra,
  })
  res.end(text)
}

function sendUpstreamDown(res: ServerResponse): void {
  sendJson(res, 502, { error: UPSTREAM_DOWN_TEXT, code: 'upstream_unavailable' }, { 'retry-after': RETRY_AFTER_SECONDS })
}

/** 也是 502 不是 504:手机与壳对 502 的处理已经对(见文件头),不再多一种要它们认的码。 */
function sendUpstreamSilent(res: ServerResponse): void {
  sendJson(res, 502, { error: UPSTREAM_SILENT_TEXT, code: 'upstream_timeout' }, { 'retry-after': RETRY_AFTER_SECONDS })
}

/** `headersTimeoutMs`:等上游回头最多多久(见 server.ts DEFAULTS);回了头之后不管。 */
export function createHttpForwarder(agent: Agent, headersTimeoutMs: number) {
  return function forward(req: IncomingMessage, res: ServerResponse, target: Target): void {
    const upstream = httpRequest({
      host: target.host,
      port: target.port,
      method: req.method,
      path: req.url,
      headers: requestHeaders(req),
      agent,
    })
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      if (!res.headersSent) sendUpstreamSilent(res)
      upstream.destroy()
    }, headersTimeoutMs)
    upstream.on('response', (upRes) => {
      clearTimeout(timer)
      res.writeHead(upRes.statusCode ?? 502, upRes.statusMessage, responseHeaders(upRes.headers))
      // 先把头推出去:SSE / 长轮询这类迟迟不写体的响应,客户端也立刻知道连上了。
      res.flushHeaders()
      upRes.pipe(res)
      upRes.on('error', () => res.destroy())
      // 上游写到一半断了:客户端这头也断,不替它补一个正常结尾(那等于说「完整了」)。
      upRes.on('close', () => { if (!upRes.complete) res.destroy() })
    })
    upstream.on('error', () => {
      clearTimeout(timer)
      if (timedOut) return // 502 已经回过了,这是上面 destroy 引出来的
      if (!res.headersSent) sendUpstreamDown(res)
      else res.destroy()
    })
    // 客户端先走了:上游那条也不必再等。
    res.on('close', () => {
      clearTimeout(timer)
      if (!res.writableFinished) upstream.destroy()
    })
    req.pipe(upstream)
  }
}

function writeRawStatus(socket: Duplex, status: number, reason: string, body: unknown, extra: Record<string, string> = {}): void {
  const text = JSON.stringify(body)
  const head = [
    `HTTP/1.1 ${status} ${reason}`,
    'Content-Type: application/json; charset=utf-8',
    `Content-Length: ${Buffer.byteLength(text)}`,
    'Connection: close',
    ...Object.entries(extra).map(([k, v]) => `${k}: ${v}`),
    '', '',
  ].join('\r\n')
  socket.end(head + text)
}

export function refuseUpgrade(socket: Duplex, status: 403, text: string): void {
  writeRawStatus(socket, status, 'Forbidden', { error: text })
}

/** `headersTimeoutMs`:连上游加等它回第一个字节(101 或拒绝)最多多久;回了之后静默多久都不断。 */
export function forwardUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, target: Target, headersTimeoutMs: number): void {
  const lines = [`${req.method ?? 'GET'} ${req.url ?? '/'} HTTP/${req.httpVersion}`]
  const raw = req.rawHeaders
  for (let i = 0; i + 1 < raw.length; i += 2) {
    if (raw[i]!.toLowerCase() === 'x-forwarded-for') continue
    lines.push(`${raw[i]}: ${raw[i + 1]}`)
  }
  lines.push(`X-Forwarded-For: ${forwardedFor(req)}`)
  const preamble = `${lines.join('\r\n')}\r\n\r\n`

  let connected = false
  let timedOut = false
  const upstream: Socket = connect({ host: target.host, port: target.port })
  upstream.setNoDelay(true)
  if ('setNoDelay' in socket && typeof (socket as Socket).setNoDelay === 'function') (socket as Socket).setNoDelay(true)

  const timer = setTimeout(() => {
    timedOut = true
    if (!socket.destroyed) {
      writeRawStatus(socket, 502, 'Bad Gateway', { error: UPSTREAM_SILENT_TEXT, code: 'upstream_timeout' }, { 'Retry-After': RETRY_AFTER_SECONDS })
    }
    upstream.destroy()
  }, headersTimeoutMs)

  upstream.once('connect', () => {
    connected = true
    upstream.write(preamble)
    if (head.length > 0) upstream.write(head)
    upstream.once('data', () => clearTimeout(timer))
    upstream.pipe(socket)
    socket.pipe(upstream)
  })
  upstream.on('error', () => {
    clearTimeout(timer)
    if (timedOut) return
    if (!connected && !socket.destroyed) {
      writeRawStatus(socket, 502, 'Bad Gateway', { error: UPSTREAM_DOWN_TEXT, code: 'upstream_unavailable' }, { 'Retry-After': RETRY_AFTER_SECONDS })
      return
    }
    socket.destroy()
  })
  // 到期那一下是这边自己 destroy 的上游:客户端那头由 writeRawStatus 的 end 正常收尾,别抢先砍掉没写完的 502。
  upstream.on('close', () => {
    clearTimeout(timer)
    if (connected && !timedOut) socket.destroy()
  })
  socket.on('error', () => upstream.destroy())
  socket.on('close', () => {
    clearTimeout(timer)
    upstream.destroy()
  })
}
