/**
 * 订阅上游(插件)的 /live,维护一份镜像,把每次变化写进事件环。
 *
 * 为什么订 /live 而不是轮询 /state(读 workbench-plugin/src/server/http.ts 定的):
 * - 插件每次状态变化都 broadcast({kind:'snapshot', state: composeState()}),/live 一连上先推一帧全量;
 *   订它 = 零轮询、变化即到。轮询 /state 每拍都要插件重拼一次 composeState()(几百 KB),
 *   正是 v3 想去掉的那份负担。
 * - 回环来源不要设备令牌(插件 onUpgrade:pairing 只拦非回环),座机服务从 127.0.0.1 连,不碰任何凭据。
 * - 广播快照里没有配对码(插件 GET /state 只对回环单独拼 pairing,composeState 永远不含它),
 *   所以镜像里也没有那把钥匙。
 *
 * 断线:按 reconnectMin → reconnectMax 翻倍退避重连;插件每 20 秒发一次应用层 ping,
 * 超过 liveIdleMs 一声不吭就当半开连接,主动断开重连。连上 / 断开各出一条 core.upstream 事件。
 * 镜像在断线期间保留上次的样子(「能看到上次状态」),connected 如实为 false。
 */
import type { EventLog } from './events.ts'
import { applyEvent, translate } from './translate.ts'

export interface MirrorOptions {
  /** ws://host:port/live */
  liveUrl: string
  events: EventLog
  reconnectMinMs: number
  reconnectMaxMs: number
  liveIdleMs: number
  log?: (line: string) => void
}

export class Mirror {
  state: Record<string, unknown> | null = null
  connected = false
  /** 第一次之后又连上了几次(含空闲判死后的重连)。 */
  reconnects = 0
  /** 最近一次连上 / 断开的时刻。 */
  changedAt = 0
  private opened = 0
  private ws: WebSocket | undefined
  private retryTimer: ReturnType<typeof setTimeout> | undefined
  private idleTimer: ReturnType<typeof setTimeout> | undefined
  private backoff: number
  private stopped = false

  constructor(private readonly options: MirrorOptions) {
    this.backoff = options.reconnectMinMs
  }

  start(): void { this.connect() }

  stop(): void {
    this.stopped = true
    clearTimeout(this.retryTimer)
    clearTimeout(this.idleTimer)
    const ws = this.ws
    this.ws = undefined
    try { ws?.close() } catch { /* 已经断了 */ }
  }

  private connect(): void {
    if (this.stopped) return
    let ws: WebSocket
    try { ws = new WebSocket(this.options.liveUrl) }
    catch { this.scheduleRetry(); return }
    this.ws = ws
    ws.addEventListener('open', () => {
      if (this.ws !== ws) return
      this.opened += 1
      if (this.opened > 1) this.reconnects += 1
      this.backoff = this.options.reconnectMinMs
      this.setConnected(true)
      this.touch()
    })
    ws.addEventListener('message', (event) => {
      if (this.ws !== ws) return
      this.touch()
      let message: unknown
      try { message = JSON.parse(String(event.data)) }
      catch { return }
      this.ingest(message)
    })
    const lost = (): void => {
      if (this.ws !== ws) return
      this.ws = undefined
      clearTimeout(this.idleTimer)
      this.setConnected(false)
      this.scheduleRetry()
    }
    ws.addEventListener('close', lost)
    ws.addEventListener('error', lost)
  }

  /** 一条 /live 消息进来:翻成事件、按顺序写环、同步更新镜像(两步之间没有 await,快照与 seq 永远对得上)。 */
  ingest(message: unknown): void {
    const changes = translate(this.state, message)
    for (const change of changes) {
      this.options.events.append(change.topic, change.kind, change.payload)
      if (change.topic.startsWith('state.')) this.state = applyEvent(this.state ?? {}, change)
    }
    if (this.state === null && typeof message === 'object' && message !== null && (message as { kind?: unknown }).kind === 'snapshot') {
      // 上游推了一份空快照:镜像就是空对象,不是「还没有」。
      this.state = {}
    }
  }

  private setConnected(connected: boolean): void {
    if (this.connected === connected) return
    this.connected = connected
    this.changedAt = Date.now()
    this.options.events.append('core.upstream', connected ? 'up' : 'down', { connected })
    this.options.log?.(connected ? '[core] 上游 /live 连上了' : '[core] 上游 /live 断了,稍后重连')
  }

  private touch(): void {
    clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => {
      const ws = this.ws
      if (ws === undefined) return
      this.options.log?.('[core] 上游 /live 太久没动静,当半开连接处理,重连')
      this.ws = undefined
      try { ws.close() } catch { /* 断了就断了 */ }
      this.setConnected(false)
      this.scheduleRetry()
    }, this.options.liveIdleMs)
  }

  private scheduleRetry(): void {
    if (this.stopped) return
    clearTimeout(this.retryTimer)
    const wait = this.backoff
    this.backoff = Math.min(this.backoff * 2, this.options.reconnectMaxMs)
    this.retryTimer = setTimeout(() => this.connect(), wait)
  }
}
