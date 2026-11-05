/**
 * 测试用的假插件:一台 HTTP 服务 + /live、/helper 两条 WS,形状照 workbench-plugin/src/server/http.ts:
 * /live 一连上先推一帧 {kind:'snapshot', state},之后每次 broadcast 推一行 JSON;/helper 原样回声;
 * 别的路径的升级一律 socket.destroy()(插件 onUpgrade 的做法)。
 * 能在同一个端口上停了再起,用来模拟 DSH 重启。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocketServer, type WebSocket } from 'ws'

export type Handler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>

export interface FakeUpstream {
  port: number
  url: string
  state: Record<string, unknown>
  /** 改一下状态并像插件那样整块广播。 */
  setState: (next: Record<string, unknown>) => void
  /** 广播一条非快照消息(event / call / ring ...)。 */
  send: (message: Record<string, unknown>) => void
  liveClients: () => number
  /** 最近一次请求在上游看到的样子。 */
  lastSeen: () => SeenRequest | undefined
  on: (path: string, handler: Handler) => void
  stop: () => Promise<void>
  start: () => Promise<void>
}

export interface SeenRequest {
  method: string
  url: string
  headers: IncomingMessage['headers']
  body: Buffer
  remoteAddress: string | undefined
}

export async function startFakeUpstream(initial: Record<string, unknown> = {}, port = 0, host = '127.0.0.1'): Promise<FakeUpstream> {
  const routes = new Map<string, Handler>()
  let seen: SeenRequest | undefined
  let server: Server | undefined
  let wss: WebSocketServer | undefined
  const live = new Set<WebSocket>()
  /** 所有升级过的 socket:「进程死了」要连它们一起断(http.Server 升级后就不再管这些 socket)。 */
  const upgraded = new Set<WebSocket>()
  let boundPort = port

  const api: FakeUpstream = {
    port: 0,
    url: '',
    state: { ...initial },
    setState(next) {
      api.state = next
      broadcast({ kind: 'snapshot', state: next })
    },
    send(message) { broadcast(message) },
    liveClients: () => live.size,
    lastSeen: () => seen,
    on(path, handler) { routes.set(path, handler) },
    stop: async () => {
      const s = server
      server = undefined
      for (const ws of upgraded) ws.terminate()
      upgraded.clear()
      live.clear()
      wss?.close()
      if (s === undefined) return
      s.closeAllConnections()
      await new Promise<void>(resolve => s.close(() => resolve()))
    },
    start: async () => {
      const s = createServer((req, res) => {
        const chunks: Buffer[] = []
        req.on('data', (c: Buffer) => chunks.push(c))
        req.on('end', () => {
          seen = {
            method: req.method ?? '',
            url: req.url ?? '',
            headers: req.headers,
            body: Buffer.concat(chunks),
            remoteAddress: req.socket.remoteAddress,
          }
          const path = (req.url ?? '/').split('?')[0] ?? '/'
          const handler = routes.get(path)
          if (handler !== undefined) { void handler(req, res); return }
          if (path === '/state') {
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify(api.state))
            return
          }
          res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ error: '没有这个路径' }))
        })
      })
      const w = new WebSocketServer({ noServer: true })
      s.on('upgrade', (req, socket, head) => {
        const path = (req.url ?? '/').split('?')[0]
        if (path === '/helper') {
          w.handleUpgrade(req, socket, head, (ws) => {
            upgraded.add(ws)
            ws.on('message', (data, isBinary) => ws.send(data, { binary: isBinary }))
          })
          return
        }
        if (path !== '/live') { socket.destroy(); return }
        w.handleUpgrade(req, socket, head, (ws) => {
          upgraded.add(ws)
          live.add(ws)
          ws.on('close', () => live.delete(ws))
          ws.send(JSON.stringify({ kind: 'snapshot', state: api.state }))
        })
      })
      await new Promise<void>((resolve, reject) => {
        s.once('error', reject)
        s.listen(boundPort, host, () => resolve())
      })
      boundPort = (s.address() as AddressInfo).port
      api.port = boundPort
      api.url = `http://127.0.0.1:${boundPort}`
      server = s
      wss = w
    },
  }
  function broadcast(message: Record<string, unknown>): void {
    const text = JSON.stringify(message)
    for (const ws of live) if (ws.readyState === ws.OPEN) ws.send(text)
  }
  await api.start()
  return api
}

/** 拿一个当下空着的端口(给「上游根本不在」的用例)。 */
export async function freePort(): Promise<number> {
  const s = createServer()
  await new Promise<void>(resolve => s.listen(0, '127.0.0.1', () => resolve()))
  const { port } = s.address() as AddressInfo
  await new Promise<void>(resolve => s.close(() => resolve()))
  return port
}

/** 等到条件成立;到时还不成立就抛,带上说明。 */
export async function until(check: () => boolean | Promise<boolean>, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`等不到:${what}`)
}
