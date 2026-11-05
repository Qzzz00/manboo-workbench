/**
 * ——— 「把文字当成他说的话」测试口(2026-09-27,卡 TT) ———
 *
 * ## 为什么有这一路
 *
 * 2026-09-27 晚维护者用电话连撞几个 bug(名字认不出、该捎话却自办、问状态答旧卡、开场被吃),
 * 根子之一是**电话那一路没法在不开口的情况下端到端验证**:统筹只能写单元用例,
 * 从没当真用户走过一遍。麦克风 / VAD / ASR 那一段我们不怀疑(它有自己的用例与真机日志),
 * 真出错的是**他说完那句话之后**的一整条回合路径 —— 回合分流、工具、捎话、状态查询、回电。
 *
 * 所以这一路只干一件事:**把一段文字塞在「ASR 定稿」那个位置上**,后面一行都不改 ——
 * 同一个 `hearFinalText`(分流、先应、日志、farewell),同一个 `session.generateReply({ userInput })`
 * (框架公开的回合提交口,引导里的「打字备胎」用的也正是它)。
 * 这个文件里**没有任何一条回合逻辑**:它只有一个 HTTP 壳、一个门卫、一个收集器。
 *
 * ## 安全(三道,默认全关着)
 *
 *   1. **默认关**:`WORKBENCH_CHANNEL_TEXT_TURN=1` 才起,安装包的默认配置里没有这一项;
 *   2. **只听 127.0.0.1**:`listen` 就绑在回环上,连上来的地址再核一遍(非本机 403);
 *   3. **本机口令文件**:进程起来时现生成一串随机口令,写进 600 权限的文件,
 *      请求要带 `x-workbench-text-turn: <口令>`(不对 401)。**口令一个字都不打进日志**。
 *
 * 日志里这一路的每一行都带「测试口」两个字 —— 事后查日志时一眼分得出哪几回合不是真人说的。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TurnLatency } from './latency.ts'
import type { RoomDecisionReplay } from './roomDecisionReplay.ts'

/** 请求头里带口令的那一格。 */
export const TEXT_TURN_TOKEN_HEADER = 'x-workbench-text-turn'

/** 默认端口。8791 工作台 / 8792 本机后端 / 8794 模块 / 8796 连接器都占着了。 */
export const TEXT_TURN_DEFAULT_PORT = 8797

/**
 * 口令文件默认放哪:**临时目录**,不是 `~/.dsh`。
 * 这一路是统筹在本机临时开的测试口,不该在他的配置目录里留下任何一样东西。
 */
export function defaultTextTurnTokenFile(): string {
  return join(tmpdir(), 'workbench-channel-text-turn.token')
}

export interface TextTurnSettings {
  on: boolean
  port: number
  tokenFile: string
  /** 一句人话,进日志。 */
  note: string
}

/**
 * 开没开、开在哪。`WORKBENCH_CHANNEL_TEXT_TURN` 取 `1/on/true` 才算开,其余(含缺席)一律关。
 */
export function textTurnSettingsOf(env: Record<string, string | undefined>): TextTurnSettings {
  const raw = (env.WORKBENCH_CHANNEL_TEXT_TURN ?? '').trim().toLowerCase()
  const port = Number.parseInt((env.WORKBENCH_CHANNEL_TEXT_TURN_PORT ?? '').trim(), 10)
  const tokenFile = (env.WORKBENCH_CHANNEL_TEXT_TURN_TOKEN_FILE ?? '').trim() || defaultTextTurnTokenFile()
  const on = raw === '1' || raw === 'on' || raw === 'true' || raw === 'yes'
  return {
    on,
    port: Number.isInteger(port) && port > 0 ? port : TEXT_TURN_DEFAULT_PORT,
    tokenFile,
    note: on
      ? `文字回合测试口开着(只听 127.0.0.1:${Number.isInteger(port) && port > 0 ? port : TEXT_TURN_DEFAULT_PORT},口令在 ${tokenFile},600)`
      : '文字回合测试口关着(开:WORKBENCH_CHANNEL_TEXT_TURN=1)',
  }
}

/** 她这一回合调的一件工具。`result` 是工具的原样输出,截断只为别把日志撑爆。 */
export interface TextTurnToolCall {
  name: string
  result?: string
}

/** 一回合跑完之后回给统筹的东西。 */
export interface TextTurnResult {
  ok: boolean
  error?: string
  /** 她说了什么,**逐段** —— 和手机上字幕那一行是同一份(出声那一刻推的那几段)。 */
  said: string[]
  /** 调了哪些工具及结果。 */
  tools: TextTurnToolCall[]
  /** 这一回合从送进去到收尾多少毫秒(壳子自己掐的表,不是 latency.ts 那一份)。 */
  ms: number
  /** 回合计时(latency.ts 那一份)。`WORKBENCH_CHANNEL_LATENCY=off` 或没收到就缺席。 */
  latency?: TurnLatency
  /** 等到超时都没收尾:如实说一句,已经收到的那几段照回。 */
  timedOut?: boolean
}

/** 一回合的收尾等多久(毫秒)。工具往返 + 模型 + 合成,真机上慢的时候三四十秒。 */
export const TEXT_TURN_TIMEOUT_MS = 90_000
/** 状态回到「听」之后再多等这一小截 —— 最后一段字幕有时比状态晚一点点。 */
export const TEXT_TURN_GRACE_MS = 400

/**
 * 一回合的收集器。agent.ts 把**现成的**那几条事件喂进来(她说的字幕、工具执行完、
 * 状态变化、回合计时),它只负责攒起来、判断「这一回合结束了没有」。
 *
 * 结束的口径与 filler.ts / latency.ts 一字不差:`thinking`/`speaking` 算在回合里,
 * 回到 `listening`/`idle` 才算收尾(工具步之间会来回切,所以不能把「不是 thinking」当结束)。
 *
 * 纯数据结构:不认识 HTTP、不认识 LiveKit、时钟与定时器可注入(用例里不用真等)。
 */
export class TextTurnCollector {
  private readonly said: string[] = []
  private readonly tools: TextTurnToolCall[] = []
  private latency: TurnLatency | undefined
  private started = false
  private settled = false
  private holds = 0
  private lastState = 'idle'
  private graceTimer: ReturnType<typeof setTimeout> | undefined
  private deadline: ReturnType<typeof setTimeout> | undefined
  private resolve: ((result: TextTurnResult) => void) | undefined
  private readonly promise: Promise<TextTurnResult>
  private readonly at: number

  private readonly options: { now?: () => number, graceMs?: number, timeoutMs?: number }

  constructor(options: { now?: () => number, graceMs?: number, timeoutMs?: number } = {}) {
    this.options = options
    this.at = (options.now ?? Date.now)()
    this.promise = new Promise((resolve) => { this.resolve = resolve })
    this.deadline = setTimeout(() => this.settle(true), options.timeoutMs ?? TEXT_TURN_TIMEOUT_MS)
    this.deadline.unref?.()
  }

  /** 她说的一段(final 的字幕)。 */
  butler(text: string): void {
    const trimmed = text.trim()
    if (trimmed !== '' && !this.settled) this.said.push(trimmed)
  }

  tool(call: TextTurnToolCall): void {
    if (!this.settled) this.tools.push(call)
  }

  turnLatency(latency: TurnLatency): void {
    if (!this.settled) this.latency = latency
  }

  /** 框架的 agent 状态。 */
  agentState(state: string): void {
    if (this.settled) return
    this.lastState = state
    if (state === 'thinking' || state === 'speaking') {
      this.started = true
      if (this.graceTimer !== undefined) { clearTimeout(this.graceTimer); this.graceTimer = undefined }
      return
    }
    if (!this.started || this.holds > 0) return
    if (this.graceTimer !== undefined) clearTimeout(this.graceTimer)
    this.graceTimer = setTimeout(() => this.settle(false), this.options.graceMs ?? TEXT_TURN_GRACE_MS)
    this.graceTimer.unref?.()
  }

  /** 送不进去(没有嘴、抛了):当场收场,把原因带回去。 */
  fail(error: string): TextTurnResult {
    this.settle(false, error)
    return this.snapshot(false, error)
  }

  /** A pending same-key retry may speak after the fallback; retain it within the original deadline. */
  hold(): () => void {
    this.holds += 1
    if (this.graceTimer !== undefined) { clearTimeout(this.graceTimer); this.graceTimer = undefined }
    let released = false
    return () => {
      if (released) return
      released = true
      this.holds -= 1
      if (this.holds === 0 && !this.settled) this.agentState(this.lastState)
    }
  }

  done(): Promise<TextTurnResult> {
    return this.promise
  }

  private snapshot(timedOut: boolean, error?: string): TextTurnResult {
    const now = (this.options.now ?? Date.now)()
    return {
      ok: error === undefined,
      ...(error === undefined ? {} : { error }),
      said: [...this.said],
      tools: [...this.tools],
      ms: now - this.at,
      ...(this.latency === undefined ? {} : { latency: this.latency }),
      ...(timedOut ? { timedOut: true } : {}),
    }
  }

  private settle(timedOut: boolean, error?: string): void {
    if (this.settled) return
    this.settled = true
    if (this.graceTimer !== undefined) clearTimeout(this.graceTimer)
    if (this.deadline !== undefined) clearTimeout(this.deadline)
    this.resolve?.(this.snapshot(timedOut, error))
  }
}

/**
 * 送一段文字进**真的那条回合路径**。
 *
 * 这个函数就是「回合逻辑一行都不另写」那句话本身:它做的三件事,顺序与真通话逐字一致 ——
 *
 *   ① `caption('me', text, true)`     —— 和 ASR 最终结果同一条字幕;
 *   ② `hear(text)`                    —— agent.ts 里那个 `hearFinalText`:分流、先应、日志、farewell;
 *   ③ `session.generateReply({ userInput })` —— 回合提交(引导的「打字备胎」用的也是这一条)。
 *
 * 用例里传替身进来,钉的就是这个顺序与这三个参数(tests/text-turn.test.ts)。
 */
export function deliverTextTurn(input: {
  text: string
  caption: (role: 'me' | 'butler', text: string, final: boolean) => void
  hear: (text: string) => void
  session: { generateReply: (options: { userInput: string }) => unknown } | undefined
}): { ok: true } | { ok: false, error: string } {
  const text = input.text.trim()
  if (text === '') return { ok: false, error: '这句话是空的' }
  if (input.session === undefined) return { ok: false, error: '这一轮没有接话模型(没有嘴),这句话没送进去' }
  input.caption('me', text, true)
  input.hear(text)
  try { input.session.generateReply({ userInput: text }) }
  catch (err) { return { ok: false, error: (err as Error)?.message ?? '这句话没送进去' } }
  return { ok: true }
}

/** 测试口对外的两件事。agent.ts 实现它,壳子只管转发。 */
export interface TextTurnPort {
  /** 把这段文字当成他这一回合的 ASR 定稿送进去,等这一回合跑完。 */
  say: (text: string) => Promise<TextTurnResult>
  /** 结束这通(虚拟)来电 —— 走的是与真挂断同一条收尾。 */
  hangup: () => Promise<{ ok: boolean, error?: string }>
}

export interface TextTurnHttpRequest {
  method?: string | undefined
  url?: string | undefined
  remoteAddress?: string | undefined
  token?: string | undefined
  body: string
}

export interface TextTurnHttpReply {
  status: number
  body: Record<string, unknown>
}

/** 回环地址的三种写法(IPv4、IPv6、IPv4-mapped)。 */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (address === undefined) return false
  const addr = address.trim().toLowerCase()
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'
}

function sameToken(given: string | undefined, want: string): boolean {
  if (given === undefined) return false
  const a = Buffer.from(given)
  const b = Buffer.from(want)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/**
 * 门卫 + 两条路由。**纯函数式**(只依赖传进来的 port 与 token),用例直接调它。
 *
 * 顺序就是三道门的顺序:没开 → 404(连「有这么个口」都不承认);
 * 不是本机 → 403;口令不对 → 401。
 */
export async function handleTextTurnRequest(
  request: TextTurnHttpRequest,
  ctx: { enabled: boolean, token: string, port: () => TextTurnPort | undefined, roomReplay?: () => RoomDecisionReplay | undefined, log?: (line: string) => void },
): Promise<TextTurnHttpReply> {
  if (!ctx.enabled) return { status: 404, body: { error: '没有这个口' } }
  if (!isLoopbackAddress(request.remoteAddress)) {
    ctx.log?.(`[channel-worker] 测试口:拒了一个不是本机的请求(${request.remoteAddress ?? '地址不明'})`)
    return { status: 403, body: { error: '这个口只听 127.0.0.1' } }
  }
  if (!sameToken(request.token, ctx.token)) {
    ctx.log?.('[channel-worker] 测试口:口令不对,拒了')
    return { status: 401, body: { error: '口令不对' } }
  }
  const path = (request.url ?? '').split('?')[0]
  const method = (request.method ?? 'GET').toUpperCase()
  if (path === '/qa/room-decisions' || path === '/qa/room-decisions/replay') {
    const replay = ctx.roomReplay?.()
    if (!replay) return { status: 404, body: { error: '没有这个口' } }
    if (method === 'GET' && path === '/qa/room-decisions') return { status: 200, body: { events: replay.list() } }
    if (method !== 'POST' || path !== '/qa/room-decisions/replay') return { status: 404, body: { error: '没有这个口' } }
    let value: unknown
    try { value = JSON.parse(request.body) } catch { return { status: 400, body: { error: '需要 event_id' } } }
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1 || !('event_id' in value) || typeof value.event_id !== 'string' || value.event_id.trim() === '' || value.event_id.length > 256) {
      return { status: 400, body: { error: '只允许 event_id，不接收事件载荷' } }
    }
    return await replay.replay(value.event_id)
      ? { status: 200, body: { ok: true, event_id: value.event_id } }
      : { status: 404, body: { error: '没有实际发送过这个事件' } }
  }
  const port = ctx.port()
  if (method === 'GET' && path === '/health') {
    return { status: 200, body: { ok: true, ready: port !== undefined } }
  }
  if (method !== 'POST') return { status: 404, body: { error: '只认 POST /say 与 POST /hangup' } }
  if (port === undefined) return { status: 503, body: { error: '这会儿工人还没进房 / 没有接话模型,送不进去' } }
  if (path === '/say') {
    let text = ''
    try {
      const parsed = request.body.trim() === '' ? {} : JSON.parse(request.body) as { text?: unknown }
      text = typeof parsed.text === 'string' ? parsed.text : ''
    }
    catch { return { status: 400, body: { error: '读不懂这段 JSON' } } }
    if (text.trim() === '') return { status: 400, body: { error: '没有 text' } }
    const result = await port.say(text)
    return { status: result.ok ? 200 : 500, body: { ...result, heard: text.trim() } }
  }
  if (path === '/hangup') {
    const done = await port.hangup()
    return { status: done.ok ? 200 : 500, body: { ...done } }
  }
  return { status: 404, body: { error: '只认 POST /say 与 POST /hangup' } }
}

export interface TextTurnServerHandle {
  port: number
  tokenFile: string
  close: () => Promise<void>
}

/**
 * 起那个壳。**开关在外面判**(main.ts 里 `settings.on` 为假时压根不调这个函数);
 * 口令现生成、写 600 的文件、**不打印**。
 */
export async function startTextTurnServer(input: {
  settings: TextTurnSettings
  port: () => TextTurnPort | undefined
  roomReplay?: () => RoomDecisionReplay | undefined
  log?: (line: string) => void
  /** 用例里塞一个固定口令进来,免得去读文件。 */
  token?: string
}): Promise<TextTurnServerHandle> {
  const log = input.log ?? ((line: string) => console.log(line))
  const token = input.token ?? randomBytes(24).toString('hex')
  writeFileSync(input.settings.tokenFile, `${token}\n`, { mode: 0o600 })
  // 文件早就在(上一轮留下的)时 mode 不会被 writeFileSync 改,补一刀。
  try { chmodSync(input.settings.tokenFile, 0o600) } catch { /* 权限收不紧就下面那一行如实说 */ }

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk as Buffer)
      const header = req.headers[TEXT_TURN_TOKEN_HEADER]
      const reply = await handleTextTurnRequest({
        method: req.method,
        url: req.url,
        remoteAddress: req.socket?.remoteAddress,
        token: typeof header === 'string' ? header.trim() : undefined,
        body: Buffer.concat(chunks).toString('utf8'),
      }, { enabled: true, token, port: input.port, ...(input.roomReplay === undefined ? {} : { roomReplay: input.roomReplay }), log })
      res.writeHead(reply.status, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(reply.body))
    })().catch((err: unknown) => {
      log(`[channel-worker] 测试口:这一条没办成 —— ${(err as Error)?.message ?? String(err)}`)
      try {
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: (err as Error)?.message ?? '没说原因' }))
      }
      catch { /* 对面早走了 */ }
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    // **只绑回环**:这一句就是「外面连不进来」那道门本身。
    server.listen(input.settings.port, '127.0.0.1', () => resolve())
  })
  log(`[channel-worker] 测试口:开在 127.0.0.1:${input.settings.port},口令在 ${input.settings.tokenFile}(600,不打印)`)

  return {
    port: input.settings.port,
    tokenFile: input.settings.tokenFile,
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()) }),
  }
}
