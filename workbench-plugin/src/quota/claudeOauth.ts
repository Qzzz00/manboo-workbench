/**
 * Claude OAuth 续期(2026-08-26)——把 keychain 里那份 refresh token 换成新的 access token。
 *
 * ## 为什么需要它
 *
 * access token **只活 8 小时**(实测:08-26 16:14 登录 → 08-27 00:14 到期;公开资料亦记
 * "8-hour expiry",两处独立吻合)。过期后按模型的周窗口(Fable/Opus)那一栏就取不到,
 * 而 Claude Code CLI 只在**它自己需要发请求时**才续期——Ben 的会话大多拿着进程内的
 * 旧值跑,于是 2026-08-25 那次 token 过期后整整 17.6 小时没人续,那一栏也就消失了 17.6 小时。
 *
 * ## 做法为什么是这个做法(先查了再做)
 *
 * 这是个很多人趟过的需求。已上线的同类工具(pi-claude-auth、opencode-claude-auth、
 * claude-oauth-refresher)做法一致,三条共识:
 *
 * 1. **refresh token 每用一次就换一张**(rotation)。所以换完**必须写回**原处,
 *    否则 Claude Code 下次拿着已作废的旧值去续期,会被踢去重新登录。
 *    ——写回不是可选项,是安全前提。
 * 2. **懒续期**:只在真的过期(或贴近过期)时才换,不做定期主动换。用得越少,
 *    与 CLI 撞车的机会越小。
 * 3. **写回要带并发护栏**:opencode-claude-auth 的原话是"用发起续期时那份 access token
 *    守住写回",即写之前确认存储里还是我们出发时那一份;若期间 CLI 自己换过了,
 *    就**认它的、丢我们的**,绝不覆盖。这条是防止把别人刚换好的凭据盖掉的关键。
 *
 * 本文件只负责"拿 refresh token 换一份新的",写回与护栏在调用方(collect.ts)。
 *
 * ## 纪律
 *
 * - token 只进请求体,**不进返回值以外的任何地方**:不进错误信息、不进日志。
 * - 响应形状不对就抛错,绝不猜——凭据这种东西,猜错的代价是把人踢下线。
 */
import type { FetchLike } from './deepseek.ts'

/** Claude Code 自己的公开 OAuth client id(公开资料多处一致)。 */
export const CLAUDE_CODE_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'

/**
 * 续期端点。按新到旧试——与 claudeHeaders.ts 的 FALLBACK_MODELS 同一套纪律:
 * 上游搬家时不至于整条哑掉,而且懒续期一天最多几次,试两个的代价可以忽略。
 * `console.anthropic.com` 那个是旧址(社区记录它已开始 404,续期路径已搬到 platform)。
 */
export const OAUTH_TOKEN_ENDPOINTS: readonly string[] = [
  'https://platform.claude.com/v1/oauth/token',
  'https://claude.ai/v1/oauth/token',
  'https://console.anthropic.com/v1/oauth/token',
]

export interface ClaudeOauthTokens {
  accessToken: string
  /** 服务端**换发**的新 refresh token。必须写回,否则下次谁都续不了(见文件头)。 */
  refreshToken: string
  /** 新 access token 的到期时刻(Unix 毫秒)。 */
  expiresAtMs: number
}

export interface RefreshClaudeOauthOptions {
  refreshToken: string
  fetch?: FetchLike
  /** 当前毫秒时刻,用来把 expires_in 换算成绝对时刻。 */
  now?: () => number
  endpoints?: readonly string[]
}

/** 严格解析续期响应。少任何一样都算不认识,绝不用缺省值凑。 */
export function parseRefreshResponse(body: unknown, nowMs: number): ClaudeOauthTokens | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const raw = body as Record<string, unknown>
  const accessToken = raw.access_token
  const refreshToken = raw.refresh_token
  const expiresIn = raw.expires_in
  if (typeof accessToken !== 'string' || accessToken === '') return undefined
  // refresh token 必须回来:它是轮换的,没拿到新的就说明我们理解错了这个接口,
  // 这时候写回会把好好的凭据写坏,宁可整条失败。
  if (typeof refreshToken !== 'string' || refreshToken === '') return undefined
  if (typeof expiresIn !== 'number' || !Number.isFinite(expiresIn) || expiresIn <= 0) return undefined
  return { accessToken, refreshToken, expiresAtMs: nowMs + Math.floor(expiresIn) * 1000 }
}

/**
 * 拿 refresh token 换一份新的。失败一律抛错,**错误信息里绝不带任何 token**。
 *
 * 端点按顺序试:一个说"这地址没有"(404/405)就换下一个;其余错误(400 invalid_grant、
 * 401、429…)是**这次续期真的失败了**,当场停手——继续换地址只会拿同一个已作废的
 * refresh token 到处撞,把事情弄得更糟。
 */
export async function refreshClaudeOauth(
  options: RefreshClaudeOauthOptions,
): Promise<ClaudeOauthTokens> {
  const fetchImpl = options.fetch ?? ((url, init) => globalThis.fetch(url, init))
  const now = options.now ?? (() => Date.now())
  const endpoints = options.endpoints ?? OAUTH_TOKEN_ENDPOINTS

  let lastNote = '没有可用的续期端点'
  for (const url of endpoints) {
    let response: Awaited<ReturnType<FetchLike>>
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'anthropic' },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          refresh_token: options.refreshToken,
          client_id: CLAUDE_CODE_CLIENT_ID,
        }),
      })
    }
    catch {
      // 连不上这个地址(网络/DNS),换下一个。原始错误不外传:它可能把 URL 和头带出来。
      lastNote = '续期请求发不出去'
      continue
    }

    const status = (response as { status?: number }).status ?? 0
    if (status === 404 || status === 405) {
      lastNote = `续期端点不存在(HTTP ${status})`
      continue // 只有"这地址没有"才换下一个
    }
    if (status >= 400) {
      // 400 invalid_grant = refresh token 已作废(多半是 CLI 抢先换过了)。
      // 这类失败换地址也没用,当场停手,由调用方降级成"要重新登录"。
      throw new Error(`Claude 续期失败(HTTP ${status})`)
    }

    let parsed: unknown
    try {
      parsed = await (response as { json: () => Promise<unknown> }).json()
    }
    catch {
      throw new Error('Claude 续期响应不是 JSON')
    }
    const tokens = parseRefreshResponse(parsed, now())
    if (tokens === undefined) throw new Error('Claude 续期响应缺字段,不敢写回')
    return tokens
  }
  throw new Error(`Claude 续期未能完成:${lastNote}`)
}

/** 从 keychain 那份 JSON 里取 refreshToken。空串当「没有」,同 accessToken 的规矩。 */
export function pickOauthRefreshToken(raw: string): string | undefined {
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
  const token = (oauth as { refreshToken?: unknown }).refreshToken
  return typeof token === 'string' && token !== '' ? token : undefined
}

/**
 * 把续期换来的三样合进原来那份 JSON,**其余字段一个不动**。
 *
 * 为什么整份原样改而不是重造一份:那份 JSON 里还有 scopes、subscriptionType、
 * rateLimitTier、refreshTokenExpiresAt 这些我们不理解也没资格决定的字段。
 * 重造等于替 Claude Code 决定它该存什么,漏一个就可能把它的登录写坏。
 * 只覆盖我们确实换到了新值的那三项,是唯一安全的改法。
 *
 * 形状不对就返回 undefined——调用方据此放弃写回,绝不写一份自己都没看懂的凭据。
 */
export function mergeRefreshedCredential(raw: string, tokens: ClaudeOauthTokens): string | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  }
  catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const oauth = (parsed as { claudeAiOauth?: unknown }).claudeAiOauth
  if (typeof oauth !== 'object' || oauth === null) return undefined

  const merged = {
    ...(parsed as Record<string, unknown>),
    claudeAiOauth: {
      ...(oauth as Record<string, unknown>),
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAtMs,
    },
  }
  return JSON.stringify(merged)
}
