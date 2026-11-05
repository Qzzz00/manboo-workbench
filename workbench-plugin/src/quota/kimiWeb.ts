/**
 * Kimi 网页端额度（PRD §8.2）。
 *
 * 接口与响应结构是 2026-08-20 从 Ben 登录着的网页端**实抓**的，不是猜的——
 * 之前猜 `billing.v1.BillingService/GetUsages` 是错的，实际在 MembershipService 下，
 * 而且**光有 Cookie 不够，必须带 `authorization`**，所以当时一直 401。
 *
 * 响应形如：
 * ```json
 * { "ratelimitCode5h":  {"ratio":0.011,  "resetTime":"..."},
 *   "ratelimitCode7d":  {"ratio":0.5287, "resetTime":"..."},
 *   "subscriptionBalance": {"amountUsedRatio":0.9463, "expireTime":"..."} }
 * ```
 * 三个 ratio 都是**已用**比例（0–1），我们统一换成剩余百分比。
 *
 * 为什么非要网页这条路：`sk-kimi-` 那个 Coding Plan Key 只覆盖 Code 部分的窗口，
 * 拿不到 `amountUsedRatio` 这个「Kimi + Code 合并」的总量——而它才是先见底的那个
 *（实抓时总量已用 94.63%，Code 的 7 天窗口才 52.87%）。
 */
import type { QuotaWindow, WindowQuota } from '../protocol.ts'
import type { FetchLike } from './deepseek.ts'

const STATS_URL
  = 'https://www.kimi.com/apiv2/kimi.gateway.membership.v2.MembershipService/GetSubscriptionStats'

/**
 * 续期口子。2026-08-20 实抓，不是猜的。
 *
 * ★为什么必须有这一层：登录时抓到的那个 `authorization` 是**只活 15 分钟**的 access token
 *（它自己的 JWT 里 `typ:"access"`、`exp - iat = 900` 秒）。把它当长期凭据存下来，
 * 结果就是「重新登录后能显示几分钟，然后又变成登录态失效」——Ben 实际遇到的就是这个。
 * 真正耐久的是 refresh token（网页端放在 localStorage.refresh_token），
 * 每次取数前拿它换一个新的 access token。
 */
const REFRESH_URL = 'https://auth.kimi.com/api/account.gateway.v1.AuthService/RefreshToken'

export interface KimiWebUsageOptions {
  /** 网页端的 authorization 头，登录时抓下来的。不落进返回值或日志。 */
  authorization: string
  fetch: FetchLike
}

function ratioToLeft(ratio: unknown): number | undefined {
  if (typeof ratio !== 'number' || !Number.isFinite(ratio)) return undefined
  // 服务端给的是"已用"比例，界面统一按剩余显示（PRD §8.2 规则 1）。
  const left = (1 - ratio) * 100
  return Math.min(100, Math.max(0, Math.round(left * 10) / 10))
}

/**
 * 窗口对象里没有 ratio，是"这一轮没用量"还是"接口改了"？
 *
 * 实测是前者：真机上「5h」和「周」的对象里只有 `enabled` 和 `resetTime`，`ratio` 这个键
 * 整个不存在；而有用量时它是给的（实抓到过 0.011 / 0.5287）。所以 ratio 缺席 = 已用 0。
 *
 * 但这是**推断**，而且猜错的方向很危险——把"接口改了"读成"还剩 100%"，等于在额度见底时
 * 报平安。所以加一道防线：只有当对象里**再没有任何别的数字字段**时才认。上游要是把 ratio
 * 改了名，那个新名字底下总会有个数，届时这里不认，走留痕，由人来看。
 */
function usedNothing(record: Record<string, unknown>, ratioKey: string): boolean {
  if (ratioKey in record) return false
  return !Object.values(record).some(v => typeof v === 'number' && Number.isFinite(v))
}

function windowFrom(
  source: unknown,
  label: string,
  ratioKey: string,
  resetKey: string,
): QuotaWindow | undefined {
  if (typeof source !== 'object' || source === null) return undefined
  const record = source as Record<string, unknown>
  const left = ratioToLeft(record[ratioKey]) ?? (usedNothing(record, ratioKey) ? 100 : undefined)
  if (left === undefined) return undefined
  const reset = record[resetKey]
  return {
    label,
    left_pct: left,
    ...(typeof reset === 'string' && reset !== '' ? { reset_at: reset } : {}),
  }
}

export async function fetchKimiWebUsage(options: KimiWebUsageOptions): Promise<WindowQuota> {
  const { authorization, fetch: fetchImpl } = options

  let response: Awaited<ReturnType<FetchLike>>
  try {
    response = await fetchImpl(STATS_URL, {
      method: 'POST',
      headers: {
        authorization,
        'content-type': 'application/json',
        // 这是 Connect-RPC 的口子，少了这个头会被拒。
        'connect-protocol-version': '1',
      },
      body: '{}',
    })
  }
  catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    // 底层报错可能把请求头（含 token）带出来，抹掉再抛。
    throw new Error(`Kimi 用量查询失败：${reason.split(authorization).join('***')}`)
  }

  if (!response.ok) {
    throw new Error(response.status === 401 || response.status === 403
      ? `Kimi 登录态已失效（HTTP ${response.status}），在工作台重新登录一次`
      : `Kimi 用量查询失败：HTTP ${response.status}`)
  }

  let body: unknown
  try {
    body = await response.json()
  }
  catch {
    throw new Error('Kimi 用量响应不是合法 JSON')
  }
  if (typeof body !== 'object' || body === null) throw new Error('Kimi 用量响应格式异常：不是对象')

  const payload = body as Record<string, unknown>
  // 总量排最前：它是先见底的那个，也是他最该看见的。
  const expected: readonly (readonly [string, string, string, string])[] = [
    ['subscriptionBalance', '总', 'amountUsedRatio', 'expireTime'],
    ['ratelimitCode5h', '5h', 'ratio', 'resetTime'],
    ['ratelimitCode7d', '周', 'ratio', 'resetTime'],
  ]

  const windows: QuotaWindow[] = []
  const missing: [string, string][] = []
  for (const [key, label, ratioKey, resetKey] of expected) {
    const window = windowFrom(payload[key], label, ratioKey, resetKey)
    if (window === undefined) missing.push([key, label])
    else windows.push(window)
  }

  if (windows.length === 0) {
    // 只报**字段名**，不报值——响应里夹带账号 id 之类的东西。
    const keys = Object.keys(payload).slice(0, 6).join(', ')
    throw new Error(`Kimi 用量响应认不出，顶层字段是：${keys || '（空对象）'}`)
  }

  // 少了哪一栏要留痕：一栏静默消失和"接口改了"在界面上长得一模一样，真机上为此白查过一轮。
  //
  // 留痕要挖到**子字段**这一层。只报顶层字段名不够——第一次上线就撞见了：
  // 顶层明明有 ratelimitCode5h / ratelimitCode7d，两栏却还是没出来，
  // 说明问题不在"上游不返回这个字段"，而在对象里面的 ratio 读不出数。
  // 只报字段名、不报值：响应里夹带账号 id 之类的东西。
  // 展示台不渲染 note，它是给 /state 看的。
  if (missing.length === 0) return { kind: 'quota', windows }

  const detail = missing.map(([key, label]) => {
    const source = payload[key]
    if (source === undefined) return `${label}(顶层没有 ${key})`
    if (typeof source !== 'object' || source === null) return `${label}(${key} 不是对象)`
    const inner = Object.keys(source as Record<string, unknown>).slice(0, 8).join(', ')
    return `${label}(${key} 里有：${inner || '空'})`
  }).join('；')

  return { kind: 'quota', windows, note: `这次没出数的窗口 —— ${detail}` }
}

export interface KimiRefreshResult {
  /** 新的 access token，只活 15 分钟，用完即弃，不落盘。 */
  accessToken: string
  /** 服务端**换发**的 refresh token。每次都会换，必须回存，否则下次就用不了了。 */
  refreshToken: string
}

export interface KimiRefreshOptions {
  refreshToken: string
  fetch: FetchLike
}

/** 拿 refresh token 换一对新的 token。请求体是 snake_case、响应是 camelCase——实抓如此，别改。 */
export async function refreshKimiToken(options: KimiRefreshOptions): Promise<KimiRefreshResult> {
  const { refreshToken, fetch: fetchImpl } = options
  const scrub = (text: string): string => text.split(refreshToken).join('***')

  let response: Awaited<ReturnType<FetchLike>>
  try {
    response = await fetchImpl(REFRESH_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // 这条口子不认 authorization，凭证就在 body 里。
        'connect-protocol-version': '1',
      },
      body: JSON.stringify({ refresh_token: refreshToken }),
    })
  }
  catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`Kimi 续期失败：${scrub(reason)}`)
  }

  if (!response.ok) {
    throw new Error(response.status === 401 || response.status === 403
      ? `Kimi 登录态已失效（续期 HTTP ${response.status}），在工作台重新登录一次`
      : `Kimi 续期失败：HTTP ${response.status}`)
  }

  let body: unknown
  try {
    body = await response.json()
  }
  catch {
    throw new Error('Kimi 续期响应不是合法 JSON')
  }
  const payload = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>
  const accessToken = payload.accessToken
  const rotated = payload.refreshToken
  // 半份凭证比没有更糟：少了任何一个都当失败，让上层显示"重新登录"，而不是拿残缺的去打接口。
  if (typeof accessToken !== 'string' || accessToken === ''
    || typeof rotated !== 'string' || rotated === '') {
    const keys = Object.keys(payload).slice(0, 6).join(', ')
    throw new Error(`Kimi 续期响应认不出，顶层字段是：${keys || '（空对象）'}`)
  }

  return { accessToken, refreshToken: rotated }
}

export interface KimiWebUsageWithRefreshOptions {
  /** 长期凭据：登录时从网页端 localStorage.refresh_token 取到的那个。 */
  refreshToken: string
  fetch: FetchLike
  /** 服务端换发新 refresh token 时回调，用来落盘。不落的话下次就用不了了。 */
  onRefreshed?: (refreshToken: string) => void | Promise<void>
}

/** 取额度的正路：先续期换一个新的 access token，再打用量接口。 */
export async function fetchKimiWebUsageWithRefresh(
  options: KimiWebUsageWithRefreshOptions,
): Promise<WindowQuota> {
  const { refreshToken, fetch: fetchImpl, onRefreshed } = options

  const fresh = await refreshKimiToken({ refreshToken, fetch: fetchImpl })
  // 先落盘再取数：取数万一抛错，换发出来的新 refresh token 也已经保住了，
  // 否则下一轮还拿着已经被换掉的旧值去续期，等于自己把自己踢下线。
  await onRefreshed?.(fresh.refreshToken)

  return await fetchKimiWebUsage({
    authorization: `Bearer ${fresh.accessToken}`,
    fetch: fetchImpl,
  })
}
