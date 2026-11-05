/**
 * 事务官本机后端(butler-server,2026-09-11)在工作台这一侧的接线。
 *
 * butler-server 是旁路服务(Express + SQLite,代码搬自 Aiboo),由 launchd 拉起、只听 127.0.0.1,
 * 管 Live2D 形象与音色配置。工作台不把它塞进 DSH 进程(C1:别再往一个进程里堆),只做三件事:
 *
 * 1. **看状态**:GET /health → /state.butler { running, port, avatarCount?, voiceCount? }。
 *    取不到就 running:false 且**数字缺席**(D13 不编数,绝不填 0);health 3 秒缓存,
 *    界面 1 秒轮询 /state 不该变成每秒打一次后端。
 * 2. **启停**:走 launchctl(kickstart -k / kill SIGTERM);launchd 项还没装就把话如实回给界面,
 *    指到登录台「一键装」(不假装成功)。**不再脱离 launchd 直接拉起 butler-start**(2026-09-17 撤掉):
 *    那条兜底起的进程不归 launchd 管,之后一装 launchd 项两份就抢 8792,launchd 那份每 10 秒重试一次,
 *    永远——本机 16:02 起风暴 125 次。停止那边按 /health 的 pid 发 SIGTERM 的兜底保留,正好用来收拾这类野进程。
 * 3. **代理**:/butler/proxy/* 原样转发到 butler-server 并带上 X-Workbench-Token——
 *    设计上入口统一在工作台 8791(设计-事务官形态 §7.2)。2026-09-14 起手机就从这里进:
 *    http.ts 认过设备令牌后,把设备 id 放 X-Workbench-Device、把手机看到的地址放 X-Forwarded-Host/Proto/Prefix
 *    一起转过去(后端据此生成手机能打通的绝对 URL,通话记录按设备落),并把后端的 ETag/Range/Cache 头带回。
 *    ASR 是一次普通 HTTP POST(wav → 文字),RTC 通话在手机与火山之间直连,所以这里没有 WebSocket 转发。
 *
 * 凭据纪律:butler.json 里的 token 只在转发时进请求头,不进 /state、不进日志、不进任何错误信息;
 * 设备令牌(Authorization)不往后端送。
 */
import { readFile } from 'node:fs/promises'

export const BUTLER_LAUNCHD_LABEL = 'ai.deepseek.butler'
export const BUTLER_DEFAULT_PORT = 8792

/** 探 `/health` 给多久。本机回环,1.5 秒已是十倍余量。 */
export const BUTLER_PROBE_TIMEOUT_MS = 1500

/**
 * 「是我自己慢」那一行日志多久记一次。GC 风暴时每 3 秒探一次、次次超时,逐次记会刷屏;
 * 与 `[内存]` 那一行同一个节奏,排障时两行能对上。
 */
export const BUTLER_SELF_SLOW_LOG_EVERY_MS = 10 * 60_000

/**
 * 探测超时、但本进程自己的事件循环 p99 比探测超时还长时记的那一行(行首;用例搜它)。
 *
 * ★ **分清「8792 没回」与「我自己慢得等不到回」**(2026-10-19,卡「插件内存增长与 GC 抖动」)。
 * 10-19 真机:插件进程一直在做全量回收,事件循环一卡就是几秒;`AbortSignal.timeout(1500)` 的定时器
 * 在循环恢复那一刻先于 fetch 的回包被处理,于是 /health 明明回了也判成超时 —— 12 次误报
 * 「语音后端探不到了」(8792 其实一直活着,launchd runs=1)。
 */
export const BUTLER_SELF_SLOW_LOG_TAG = '[语音后端] 探 8792 超时,但是我自己慢'

/** GET /state.butler 的形状。数字取不到就缺席,不填 0。 */
export interface ButlerView {
  running: boolean
  port: number
  avatarCount?: number
  voiceCount?: number
  /**
   * chat 场景此刻解析出来的音色 id(2026-09-22)。后端 `/health` 给什么就是什么,
   * **解析不出来就缺席**(没配供应商时不编一个默认名)。
   *
   * 谁在看它:手机把缓冲语那七句**按音色缓存**(butler-app/src/call/fillerVoiceCache.ts),
   * 通道层工人盯着它变没变、变了就往房间里广播一条 `filler_voice_changed`。
   * 在这之前,换了音色之后电话里会有两个嗓子(交接-0920 第六节第 1 条记的那个洞)。
   */
  voice?: string
  /**
   * 语音合成钥匙有没有、从哪来(2026-09-23)。后端 `/health` 给什么就是什么,**没有任何密钥**:
   * `source` = settings(设置页填的)/ server(服务器下发)/ none(都没有);都没有时 `note` 是一句能行动的人话
   * (例如「服务器还没下发语音合成的钥匙,她暂时开不了口」)。老后端不给就缺席。
   */
  tts?: ButlerTtsStatus
}

export interface ButlerTtsStatus {
  ready: boolean
  source: 'settings' | 'server' | 'none'
  note?: string
}

/** `/health` 里那一格 → ButlerTtsStatus;形状不对就 undefined(不猜)。 */
export function butlerTtsStatusOf(value: unknown): ButlerTtsStatus | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const raw = value as Record<string, unknown>
  if (typeof raw.ready !== 'boolean') return undefined
  if (raw.source !== 'settings' && raw.source !== 'server' && raw.source !== 'none') return undefined
  return {
    ready: raw.ready,
    source: raw.source,
    ...(typeof raw.note === 'string' && raw.note !== '' ? { note: raw.note } : {}),
  }
}

export interface ButlerActionResult { ok: boolean, error?: string }

export interface ButlerProxyRequest {
  method: string
  /** 去掉 /butler/proxy 前缀后的路径(含 query),以 / 开头。 */
  path: string
  contentType?: string
  body?: Buffer
  /**
   * 额外转发的请求头(小写键),由 http.ts 挑好:x-workbench-device、x-forwarded-host/proto/prefix、range、accept。
   * 不是把手机的头整包透传——Authorization 这类绝不能进来。
   */
  headers?: Record<string, string>
}

/** 后端回包里原样带回给调用方的头(小写)。 */
export const PROXY_RESPONSE_HEADERS = ['etag', 'accept-ranges', 'content-range', 'cache-control', 'content-disposition', 'last-modified'] as const

export interface ButlerProxyResponse {
  status: number
  contentType?: string
  /** PROXY_RESPONSE_HEADERS 里后端真的给了的那些。 */
  headers?: Record<string, string>
  body: Buffer
}

export interface ButlerService {
  view(): Promise<ButlerView>
  adminUrl(): Promise<string>
  start(): Promise<ButlerActionResult>
  stop(): Promise<ButlerActionResult>
  open(): Promise<ButlerActionResult>
  proxy(req: ButlerProxyRequest): Promise<ButlerProxyResponse>
}

export function defaultButlerConfigFile(home = process.env.HOME ?? ''): string {
  return `${home}/.dsh/workbench/butler.json`
}

export interface ButlerServiceDeps {
  configFile: string
  runCommand: (cmd: readonly string[]) => Promise<{ ok: boolean, stdout: string }>
  fetchImpl?: typeof fetch
  /** 兜底停止:launchctl 认不得时按 /health 回报的 pid 发 SIGTERM。缺省 process.kill。 */
  killProcess?: (pid: number) => boolean
  uid?: number
  now?: () => number
  /** health 缓存毫秒,缺省 3000;0 = 不缓存(测试用)。 */
  cacheMs?: number
  /**
   * 本进程事件循环最近的 p99(毫秒;`processHealth.loopP99Ms`)。缺省不接 = 老行为(超时一律算没回)。
   * 高于 {@link BUTLER_PROBE_TIMEOUT_MS} 时,这一次超时按「我自己慢」处理:**沿用上一次的结论**,不算它挂了。
   */
  loopDelayP99Ms?: () => number | undefined
  log?: (line: string) => void
}

interface ButlerConfig { port: number, token?: string }

async function readConfig(file: string): Promise<ButlerConfig> {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as { port?: unknown, token?: unknown }
    const port = typeof parsed.port === 'number' && Number.isInteger(parsed.port) && parsed.port > 0 && parsed.port < 65536
      ? parsed.port
      : BUTLER_DEFAULT_PORT
    const token = typeof parsed.token === 'string' && parsed.token !== '' ? parsed.token : undefined
    return token === undefined ? { port } : { port, token }
  }
  catch {
    // 文件不存在(butler-server 还没起过)或写坏了:端口按默认值,没有令牌——本机回环本来就不要令牌。
    return { port: BUTLER_DEFAULT_PORT }
  }
}

function defaultKillProcess(pid: number): boolean {
  try {
    process.kill(pid, 'SIGTERM')
    return true
  }
  catch {
    return false
  }
}

export function createButlerService(deps: ButlerServiceDeps): ButlerService {
  const fetchImpl = deps.fetchImpl ?? fetch
  const killProcess = deps.killProcess ?? defaultKillProcess
  const uid = deps.uid ?? (typeof process.getuid === 'function' ? process.getuid() : 501)
  const now = deps.now ?? (() => Date.now())
  const cacheMs = deps.cacheMs ?? 3000
  const target = `gui/${uid}/${BUTLER_LAUNCHD_LABEL}`

  let cached: { at: number, view: ButlerView, pid?: number } | undefined
  const log = deps.log ?? ((line: string) => { console.log(line) })
  let selfSlowLoggedAt: number | undefined

  function headersFor(config: ButlerConfig, extra: Record<string, string> = {}): Record<string, string> {
    return config.token === undefined ? extra : { ...extra, 'x-workbench-token': config.token }
  }

  /**
   * 这一次超时是不是**我自己慢**:事件循环 p99 比探测超时还长,定时器与回包谁先被处理是随机的。
   * 那时不知道它活没活 —— 沿用上一次的结论(没有上一次就只能按没在跑),并每 10 分钟记一行。
   */
  function selfSlow(error: unknown, at: number): boolean {
    const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
    if (!timedOut) return false
    const p99 = deps.loopDelayP99Ms?.()
    if (p99 === undefined || p99 <= BUTLER_PROBE_TIMEOUT_MS) return false
    if (selfSlowLoggedAt === undefined || at - selfSlowLoggedAt >= BUTLER_SELF_SLOW_LOG_EVERY_MS) {
      selfSlowLoggedAt = at
      log(`${BUTLER_SELF_SLOW_LOG_TAG}:本进程事件循环 p99=${p99}ms 比探测超时 ${BUTLER_PROBE_TIMEOUT_MS}ms 还长,沿用上一次的结论(${cached === undefined ? '没有上一次,按没在跑' : cached.view.running ? '在跑' : '没在跑'}),不算它挂了`)
    }
    return true
  }

  async function probe(): Promise<{ view: ButlerView, pid?: number }> {
    const config = await readConfig(deps.configFile)
    const base = { port: config.port }
    try {
      const res = await fetchImpl(`http://127.0.0.1:${config.port}/health`, {
        headers: headersFor(config),
        signal: AbortSignal.timeout(BUTLER_PROBE_TIMEOUT_MS),
      })
      if (!res.ok) return { view: { running: false, ...base } }
      const body = await res.json() as { ok?: unknown, avatarCount?: unknown, voiceCount?: unknown, voice?: unknown, tts?: unknown, pid?: unknown }
      const tts = butlerTtsStatusOf(body.tts)
      if (body.ok !== true) return { view: { running: false, ...base } }
      return {
        view: {
          running: true,
          ...base,
          // 数字只在后端真的给了才带上——取不到就缺席,不填 0(D13)。
          ...(typeof body.avatarCount === 'number' ? { avatarCount: body.avatarCount } : {}),
          ...(typeof body.voiceCount === 'number' ? { voiceCount: body.voiceCount } : {}),
          // 音色只在后端真解析出来时才带上 —— 取不到就缺席,不编一个名字(D13)。
          ...(typeof body.voice === 'string' && body.voice !== '' ? { voice: body.voice } : {}),
          ...(tts === undefined ? {} : { tts }),
        },
        ...(typeof body.pid === 'number' ? { pid: body.pid } : {}),
      }
    }
    catch (error) {
      // 我自己慢:沿用上一次(端口照配置给,免得上一次是老端口)。
      if (selfSlow(error, now()) && cached !== undefined) {
        return { view: { ...cached.view, ...base }, ...(cached.pid === undefined ? {} : { pid: cached.pid }) }
      }
      return { view: { running: false, ...base } }
    }
  }

  async function refresh(): Promise<{ view: ButlerView, pid?: number }> {
    const at = now()
    if (cached !== undefined && cacheMs > 0 && at - cached.at < cacheMs) return cached
    const result = await probe()
    cached = { at, ...result }
    return cached
  }

  return {
    async view() {
      return (await refresh()).view
    },

    async adminUrl() {
      const config = await readConfig(deps.configFile)
      return `http://127.0.0.1:${config.port}/admin/`
    },

    async start() {
      cached = undefined
      const viaLaunchd = await deps.runCommand(['launchctl', 'kickstart', '-k', target])
      if (viaLaunchd.ok) return { ok: true }
      // 不绕过 launchd 自己拉:那样起的进程没人管,装上 launchd 项后两份抢端口(2026-09-17 风暴)。
      return {
        ok: false,
        error: `launchd 里没有 ${BUTLER_LAUNCHD_LABEL}:去登录台「一键装」装 launchd 项(不再脱离 launchd 直接拉起)`,
      }
    },

    async stop() {
      const before = await refresh()
      cached = undefined
      const viaLaunchd = await deps.runCommand(['launchctl', 'kill', 'SIGTERM', target])
      if (viaLaunchd.ok) return { ok: true }
      if (before.pid !== undefined && killProcess(before.pid)) return { ok: true }
      return { ok: false, error: before.view.running ? '停不下来:launchd 不认这个服务,也拿不到它的进程号' : '本来就没在跑' }
    },

    async open() {
      const url = await this.adminUrl()
      const result = await deps.runCommand(['open', url])
      return result.ok ? { ok: true } : { ok: false, error: `打不开浏览器:${url}` }
    },

    async proxy(req) {
      const config = await readConfig(deps.configFile)
      const url = `http://127.0.0.1:${config.port}${req.path}`
      const headers = headersFor(config, {
        ...(req.headers ?? {}),
        ...(req.contentType === undefined ? {} : { 'content-type': req.contentType }),
      })
      const hasBody = req.body !== undefined && req.body.length > 0 && req.method !== 'GET' && req.method !== 'HEAD'
      try {
        const res = await fetchImpl(url, {
          method: req.method,
          headers,
          ...(hasBody ? { body: new Uint8Array(req.body!) } : {}),
          // 语音合成/识别要等上游,比配置后台那些接口慢;60 秒够火山把 60 秒的音频转完。
          signal: AbortSignal.timeout(60_000),
        })
        const contentType = res.headers.get('content-type') ?? undefined
        const passthrough: Record<string, string> = {}
        for (const name of PROXY_RESPONSE_HEADERS) {
          const value = res.headers.get(name)
          if (value !== null) passthrough[name] = value
        }
        return {
          status: res.status,
          ...(contentType === undefined ? {} : { contentType }),
          ...(Object.keys(passthrough).length === 0 ? {} : { headers: passthrough }),
          body: Buffer.from(await res.arrayBuffer()),
        }
      }
      catch {
        return {
          status: 502,
          contentType: 'application/json; charset=utf-8',
          body: Buffer.from(JSON.stringify({ error: '本机后端没在跑' })),
        }
      }
    },
  }
}
