/**
 * Claude 按模型分的周窗口（Fable / Opus / Sonnet …）——第四条采集路。
 *
 * ## 为什么非要单开一条
 *
 * 这一栏在另外三条路上**都取不到**，不是漏接：
 * - 响应头（claudeHeaders.ts）只有统一的 5h / 7d。用 Fable 去打想逼出按模型的头，
 *   回来的 429 里一个限流头都没有。社区那份权威记录（CodexBar #1894）也写明
 *   「Model-specific weekly 不在头里，要走 usage 端点」。
 * - 桌面端的 plan-usage-history.json（claudeDesktop.ts）只写 five_hour/seven_day
 *   —— 它的映射表其实支持八个键，但响应里只有那两个非空。本机 3186 个样本实证。
 * - statusLine 推送（claude.ts）：Claude Code 2.1.x 二进制里自带的字段文档写死了
 *   rate_limits 只有 five_hour 和 seven_day。
 *
 * 它只在 `GET /api/oauth/usage` 的 `limits[]` 里，正是 Claude Code 自己 `/usage`
 * 命令中「Current week (Fable)」那一栏的来源（判据抄自它的解析代码：
 * `kind === 'weekly_scoped' && scope?.model`，标签取 `scope.model.display_name`）。
 *
 * ## 为什么标签不写死
 *
 * **模型名是数据，不是 schema。** 接口自己给 display_name，出新模型、改名字都不用动代码。
 * 桌面端 app.asar 里那些 `seven_day_omelette` 之类的顶层键反而是会过期的写法，不抄。
 *
 * ## 纪律（与 claudeHeaders.ts 同一套）
 *
 * - token 只进请求头，**不进返回值、note、日志、错误信息**。
 * - 形状不对、单位不对就丢掉，绝不猜一个数出来。
 * - UA 必须是 `claude-code/<semver>`：这个端点按 UA 分限流桶，别的 UA 会进凶狠桶
 *   （社区实测；交接文档里那两个 429 则是另一回事——当时 Bearer 是空串）。
 * - 缺 user:profile 的 403 要**明说要重新登录**，不许悄悄降级成「没数」——
 *   悄悄降级会让界面长期停在两栏上，而没人知道为什么。
 */
import type { QuotaWindow } from '../protocol.ts'
import type { FetchLike } from './deepseek.ts'
import { windowFromUsedPercentage } from './claude.ts'

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'

/** keychain 里那份 JSON 的服务名。读的时候不带 -a，与社区各工具一致。 */
export const KEYCHAIN_SERVICE = 'Claude Code-credentials'

/**
 * 从 keychain 那份 JSON 里取 accessToken。
 *
 * 空串必须当「没有」：本机就是这个坑——条目在、值是空串（`claude auth login` 没跑过时
 * 就是这样），直接发出去会变成一个 `Bearer ` 加空格的请求，换回一句看不懂的 401；
 * 交接文档里把 usage 端点判死刑的那两次 429，就是这么来的。
 * 社区还记录过 2.1.x 上条目退化成只有 mcpOAuth 的情况，所以这里逐层取、不下标。
 */
export function pickOauthAccessToken(raw: string): string | undefined {
  if (raw === '') return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  }
  catch {
    return undefined
  }
  const oauth = (parsed as { claudeAiOauth?: unknown }).claudeAiOauth
  if (typeof oauth !== 'object' || oauth === null) return undefined
  const token = (oauth as { accessToken?: unknown }).accessToken
  return typeof token === 'string' && token !== '' ? token : undefined
}

/**
 * 从 keychain 那份 JSON 里取 accessToken 的到期时刻(Unix 毫秒)。
 *
 * 2026-08-26 真机:Fable 那一栏消失的**真因**就是这个 token 过期了(08-25 18:58),
 * 端点原话 "OAuth access token has expired. Re-authenticate to continue."。
 * 而我们既不看它、也不续期,于是每 60 秒拿一个死 token 去撞一次,撞了 17 个小时——
 * 最后把自己撞进限流,429 反过来把 401 盖住,连"要重新登录"这个真相都看不见了。
 *
 * 读不出来就返回 undefined,当作"不知道"照常去打——**不猜它已死**。少一次判断
 * 顶多多打一个请求,猜错却会让一栏本来好好的数据凭空消失。
 */
export function oauthTokenExpiry(raw: string): number | undefined {
  if (raw === '') return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  }
  catch {
    return undefined
  }
  const oauth = (parsed as { claudeAiOauth?: unknown }).claudeAiOauth
  if (typeof oauth !== 'object' || oauth === null) return undefined
  const expiresAt = (oauth as { expiresAt?: unknown }).expiresAt
  return typeof expiresAt === 'number' && Number.isFinite(expiresAt) ? expiresAt : undefined
}

/** 「要重新登录」那句话。403(缺作用域)与 401(token 过期)共用——对 Ben 是同一个动作。 */
export const RELOGIN_HINT = '需要重新跑 claude auth login'

/**
 * 从已装的版本目录名里挑最新的一个拼 UA。
 *
 * 按版本号比，不按字典序——`2.1.9` 字典序大于 `2.1.237`，写错了 UA 就不是当前版本，
 * 虽然仍是合法 semver，但没必要报个假版本。一个像样的都没有就返回 undefined，
 * 由调用方决定干脆别发这个请求（宁可少一栏，不拿错 UA 去撞限流桶）。
 */
export function claudeCodeUserAgent(entries: readonly string[]): string | undefined {
  const versions = entries
    .filter(name => /^\d+\.\d+\.\d+$/.test(name))
    .map(name => ({ name, parts: name.split('.').map(Number) }))
    .sort((left, right) => {
      for (let i = 0; i < 3; i += 1) {
        const diff = (right.parts[i] ?? 0) - (left.parts[i] ?? 0)
        if (diff !== 0) return diff
      }
      return 0
    })
  const newest = versions[0]?.name
  return newest === undefined ? undefined : `claude-code/${newest}`
}

/** limits[] 里一条按模型的周窗口。字段名抄自 Claude Code 的解析代码。 */
interface ScopedLimit {
  kind?: unknown
  percent?: unknown
  resets_at?: unknown
  scope?: { model?: { display_name?: unknown } }
}

/**
 * 挑出按模型分的周窗口。
 *
 * 只要 `kind === 'weekly_scoped'` 且 scope 里有 model 的那些：
 * - 统一的 5h/周 由响应头那条路负责，这里再给一份会在界面上多出两条重复的；
 * - 按 surface 分的（Cowork 之类）不是模型窗口，不在本栏语义里。
 *
 * percent 只认 0–100。上游哪天改成 0–1，这里要**当场丢掉**而不是把 0.8 当成
 * 「已用 0.8%、还剩 99.2%」显示出去——那是个看起来完全正常的错数，最危险。
 */
export function parseScopedWeeklyWindows(body: unknown): QuotaWindow[] {
  const limits = (body as { limits?: unknown })?.limits
  if (!Array.isArray(limits)) return []

  const windows: QuotaWindow[] = []
  for (const raw of limits as ScopedLimit[]) {
    if (raw?.kind !== 'weekly_scoped') continue
    const label = raw.scope?.model?.display_name
    if (typeof label !== 'string' || label === '') continue

    const used = raw.percent
    if (typeof used !== 'number' || !Number.isFinite(used) || used < 0 || used > 100) continue
    // 0–1 的比例混进来会被上面那道 0–100 放行（0.8 落在区间内），所以再挡一次：
    // 真实的按模型窗口不会用小数点后还带比例的写法，见文件头「单位」一节。
    if (used > 0 && used < 1) continue

    const resetsAt = typeof raw.resets_at === 'string' && raw.resets_at !== ''
      ? raw.resets_at
      : undefined
    const window = windowFromUsedPercentage(used, label)
    windows.push(resetsAt === undefined ? window : { ...window, reset_at: resetsAt })
  }
  return windows
}

/**
 * 429 专用的错误:多带一个 `retryAfterSec`,让调用方按端点说的时长退避。
 *
 * 用属性而不是新 Error 子类:既有测试按 `rejects.toThrow(/429/)` 断言,
 * 话术一个字不改;拿不到这个头就是 undefined,调用方退回自己的缺省间隔,不猜。
 */
export interface ClaudeScopedRateLimitError extends Error {
  retryAfterSec?: number
}

function rateLimitedError(retryAfterSec: number | undefined): ClaudeScopedRateLimitError {
  const error: ClaudeScopedRateLimitError = new Error('Claude 用量端点 429：被限流，退避后再取')
  if (retryAfterSec !== undefined) error.retryAfterSec = retryAfterSec
  return error
}

/**
 * 读响应头里的 `retry-after`(秒)。
 *
 * FetchLike 没约定 headers,但真实 fetch 和测试桩都给得出——取法与
 * claudeHeaders.ts 的 responseHeaders 一致。读不到、读到的不是正数就返回
 * undefined:宁可用调用方的缺省间隔,也不拿一个猜来的秒数去算退避。
 */
export function retryAfterSeconds(response: unknown): number | undefined {
  const headers = (response as { headers?: { get?: unknown } }).headers
  if (headers === undefined || typeof headers.get !== 'function') return undefined
  const raw = (headers as { get: (name: string) => string | null }).get('retry-after')
  if (typeof raw !== 'string' || raw.trim() === '') return undefined
  const seconds = Number(raw.trim())
  return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined
}

export interface ClaudeScopedOptions {
  /** keychain 里那把 OAuth access token（scope 需含 user:profile）。只进请求头。 */
  token: string
  /** `claude-code/<semver>`，见文件头「纪律」。 */
  userAgent: string
  fetch?: FetchLike
}

/**
 * 打一次 usage 端点，翻出按模型的周窗口。
 *
 * @throws 缺作用域 / 限流 / 形状不对时抛错，由调用方降级——但错误话术里绝不带 token。
 */
export async function fetchClaudeScopedWeekly(
  options: ClaudeScopedOptions,
): Promise<QuotaWindow[]> {
  const fetchImpl = options.fetch ?? ((url, init) => globalThis.fetch(url, init))

  let response: Awaited<ReturnType<FetchLike>>
  try {
    response = await fetchImpl(USAGE_URL, {
      method: 'GET',
      headers: {
        // token 只出现在这里。下面任何一条错误路径都不许把它带出去。
        'Authorization': `Bearer ${options.token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': options.userAgent,
      },
    })
  }
  catch {
    // 别把 fetch 的原始错误抛出去——它可能把 URL 和头一起打出来。
    throw new Error('Claude 用量端点请求发不出去')
  }

  const status = (response as { status?: number }).status ?? 0
  if (status === 401) {
    // 2026-08-26 真机:这是 Fable 栏消失的真因。端点原话
    // "OAuth access token has expired. Re-authenticate to continue."。
    // 以前它掉进下面通用的 4xx 分支,被调用方归进"下一轮自己会好"那一档——
    // 可它永远不会自己好,只会每分钟再撞一次,直到把自己撞进限流,
    // 而 429 又反过来盖住 401,连真相都查不出来。必须单独认出来、说人话。
    throw new Error(`Claude 用量端点 401：登录已过期，${RELOGIN_HINT}`)
  }
  if (status === 403) {
    // 这条必须说人话：setup-token 只有 user:inference，打这个端点就是 403。
    // 悄悄降级会让界面长期少一栏而没人知道为什么。
    throw new Error(`Claude 用量端点 403：当前登录缺 user:profile 作用域，${RELOGIN_HINT}`)
  }
  if (status === 429) {
    // 把 retry-after 一起带出去：调用方要按它退避。2026-08-26 实测这个端点
    // 给的是 161 秒，而采集器当时每 60 秒就再问一次——惩罚永远续着，出不来。
    throw rateLimitedError(retryAfterSeconds(response))
  }
  if (status >= 400) {
    throw new Error(`Claude 用量端点 HTTP ${status}`)
  }

  let body: unknown
  try {
    body = await (response as { json: () => Promise<unknown> }).json()
  }
  catch {
    throw new Error('Claude 用量端点返回的不是 JSON')
  }
  return parseScopedWeeklyWindows(body)
}
