/**
 * 起别家命令行时给它的那份环境(2026-09-25,卡 O 兜底;统筹:「命令行派活别继承死掉的代理地址」)。
 *
 * 维护者这台 DSH 的环境里带着 `ANTHROPIC_BASE_URL=http://127.0.0.1:8787` —— 他以前 headroom 代理的地址;现在 8787 上
 * 什么都没在听,headroom 也不在了。DSH 起的 `claude` 命令行照单继承,于是**全都连不上**,他登录以后也一样。
 * 源头有两处:`~/.dsh/bin/dsh-start` 里的一行(卡 R 已删,老用户要等热更新),和 headroom 装的 LaunchAgent ——
 * **每次登录都 `launchctl setenv` 一遍**(卡 R 查到),所以**这道兜底是唯一挡着的**:
 *
 * - **起命令行之前先探一下这个地址**:是本机地址(127.x / localhost / ::1)、而且连不上 → 这一个变量不传;
 *   别的 `ANTHROPIC_*` 一个都不动(统筹原话)。
 * - **只认本机地址**:本机代理没开,这个地址就是死的,去掉它命令行就直连 Claude。远端的中转连不上是另一回事 ——
 *   去掉它会让请求改道去官方、带着给中转的那份令牌,所以不替他改,体检那一格如实说「Claude 命令行指向的中转连不上」。
 * - 探一次最多等 800 毫秒,结论留 30 秒(派活、体检、登录窗口共用),**绝不抛**。
 */
import { createConnection } from 'node:net'

/** `ANTHROPIC_BASE_URL` 指向哪、是不是本机、探不探得通。 */
export interface BaseUrlFact {
  /** 原样那一串。 */
  url: string
  host: string
  port: number
  /** 本机地址(127.x / localhost / ::1)。 */
  local: boolean
  reachable: boolean
  /**
   * 这个地址从哪来的(卡 R 查到:维护者那台是以前装的 headroom 留下的 LaunchAgent,**每次登录都 `launchctl setenv` 一遍**,
   * 所以删掉 dsh-start 那一行也挡不住)。`launchd` = `launchctl getenv` 读得到同一个值(系统登录时设进去的);
   * `process` = 只在这个进程的环境里(DSH 启动时带进来的);缺席 = 没查。
   */
  source?: 'launchd' | 'process'
  /** 探的时刻(毫秒)。 */
  at: number
}

export type PortProbe = (host: string, port: number, timeoutMs: number) => Promise<boolean>

/** 认得出的那种地址才回(http / https、有主机名);认不出回 undefined(那就原样不动)。 */
export function parseBaseUrl(raw: string | undefined): Omit<BaseUrlFact, 'reachable' | 'at'> | undefined {
  if (typeof raw !== 'string' || raw.trim() === '') return undefined
  let parsed: URL
  try { parsed = new URL(raw.trim()) }
  catch { return undefined }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined
  const host = parsed.hostname.replace(/^\[|\]$/g, '')
  if (host === '') return undefined
  const port = parsed.port === '' ? (parsed.protocol === 'https:' ? 443 : 80) : Number(parsed.port)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return undefined
  const local = host === 'localhost' || host === '::1' || /^127(\.\d{1,3}){3}$/.test(host)
  return { url: raw.trim(), host, port, local }
}

/** 真去连一下那个端口(生产用)。连上就断开;超时、被拒一律当连不上。 */
export const tcpProbe: PortProbe = (host, port, timeoutMs) => new Promise((resolve) => {
  let settled = false
  const socket = createConnection({ host, port })
  const done = (ok: boolean): void => {
    if (settled) return
    settled = true
    socket.removeAllListeners()
    socket.destroy()
    resolve(ok)
  }
  socket.setTimeout(timeoutMs, () => done(false))
  socket.once('connect', () => done(true))
  socket.once('error', () => done(false))
})

/** 这个地址该不该拿掉:本机的、连不上的才拿。 */
export function shouldDrop(fact: BaseUrlFact | undefined): fact is BaseUrlFact {
  return fact !== undefined && fact.local && !fact.reachable
}

/** 起命令行用的那份环境:该拿掉的只拿 `ANTHROPIC_BASE_URL` 这一个,别的原样。纯函数。 */
export function cliEnvWith(env: NodeJS.ProcessEnv, fact: BaseUrlFact | undefined): { env: NodeJS.ProcessEnv, dropped?: BaseUrlFact } {
  if (!shouldDrop(fact) || env.ANTHROPIC_BASE_URL === undefined) return { env }
  const next: NodeJS.ProcessEnv = { ...env }
  delete next.ANTHROPIC_BASE_URL
  return { env: next, dropped: fact }
}

/** 给人看的那一截地址:「127.0.0.1:8787」。 */
export function hostPort(fact: Pick<BaseUrlFact, 'host' | 'port'>): string {
  return fact.host.includes(':') ? `[${fact.host}]:${fact.port}` : `${fact.host}:${fact.port}`
}

/**
 * 登录窗口那段脚本里用的同一条规矩(那扇终端窗口的环境来自他的登录 shell,不是 DSH;他的 shell 配置里要是也留着这一行,
 * 同样拿掉):本机地址、`curl` 回「连不上」(退出码 7)才 unset。
 */
export const SHELL_DROP_DEAD_LOCAL_BASE_URL = [
  'if [ -n "$ANTHROPIC_BASE_URL" ]; then',
  '  case "$ANTHROPIC_BASE_URL" in',
  '    http://127.*|https://127.*|http://localhost*|https://localhost*|http://\\[::1\\]*|https://\\[::1\\]*)',
  '      /usr/bin/curl -s -o /dev/null --max-time 2 "$ANTHROPIC_BASE_URL"',
  '      if [ $? -eq 7 ]; then unset ANTHROPIC_BASE_URL; fi',
  '      ;;',
  '  esac',
  'fi',
].join('\n')

export interface CliEnvDeps {
  env?: () => NodeJS.ProcessEnv
  probe?: PortProbe
  /** 系统登录环境里这个变量是什么(生产:`launchctl getenv`,只读)。缺席 = 不查来源。 */
  launchdGetenv?: (key: string) => Promise<string | undefined>
  now?: () => number
  ttlMs?: number
  timeoutMs?: number
}

/** 那个地址从哪来的,一句人话(体检那一格用)。 */
export function sourceText(source: BaseUrlFact['source']): string {
  if (source === 'launchd') return '是系统每次登录时设进去的(以前装的本机代理留下的开机项)'
  if (source === 'process') return '是 DSH 启动时带进来的'
  return '是 DSH 的环境里带着的'
}

export function createCliEnv(deps: CliEnvDeps = {}) {
  const env = deps.env ?? (() => process.env)
  const probe = deps.probe ?? tcpProbe
  const now = deps.now ?? (() => Date.now())
  const ttlMs = deps.ttlMs ?? 30_000
  const timeoutMs = deps.timeoutMs ?? 800
  let cached: BaseUrlFact | undefined

  /** 探一次(结论留 `ttlMs`)。环境里没有这个变量 / 认不出 → undefined。**绝不抛**。 */
  async function check(force = false): Promise<BaseUrlFact | undefined> {
    const parsed = parseBaseUrl(env().ANTHROPIC_BASE_URL)
    if (parsed === undefined) { cached = undefined; return undefined }
    if (!force && cached !== undefined && cached.url === parsed.url && now() - cached.at < ttlMs) return cached
    let reachable = false
    try { reachable = await probe(parsed.host, parsed.port, timeoutMs) }
    catch { reachable = false }
    let source: BaseUrlFact['source']
    if (deps.launchdGetenv !== undefined) {
      try { source = (await deps.launchdGetenv('ANTHROPIC_BASE_URL'))?.trim() === parsed.url ? 'launchd' : 'process' }
      catch { source = undefined }
    }
    cached = { ...parsed, reachable, ...(source === undefined ? {} : { source }), at: now() }
    return cached
  }

  /** 起命令行那一刻用:该拿掉的拿掉。 */
  async function envFor(): Promise<{ env: NodeJS.ProcessEnv, dropped?: BaseUrlFact }> {
    return cliEnvWith(env(), await check())
  }

  return {
    check,
    envFor,
    /** 上一次探的结论(同步;体检那一格读)。 */
    fact: (): BaseUrlFact | undefined => cached,
  }
}

export type CliEnv = ReturnType<typeof createCliEnv>
