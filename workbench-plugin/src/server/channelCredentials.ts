/**
 * 通道凭据向中转要(2026-09-21)。这一刀之前,LiveKit 的 api key / secret 与火山识别的
 * appid / access token 都躺在每台 Mac 的 `~/.dsh/workbench/channel.json` 里 ——
 * Ben 手工拷过去的那一份(docs/验收-从零重装清单-2026-09-17.md 第九节的「暂留」)。
 *
 * 那份文件有两个毛病,而且是同一件事的两面:
 *   - **新用户拿不到**。他装完工作台、注册完,通道那一格永远是「没配」——
 *     而他根本不知道「LiveKit」是什么,也不该知道。
 *   - **老用户拿太多**。那是一整套基础设施的钥匙:拿到 secret 的人能进任何人的房间。
 *
 * 现在:钥匙留在中转那台服务器上(`/opt/relay/.env`),这个模块负责**把要的那一点点取回来**。
 *
 * ## 三条纪律
 *
 * 1. **只存内存**。取回来的东西放在这个闭包里,不落盘、不进 `/state`、不进日志、
 *    不进任何回给浏览器或手机的 JSON。进程重启就重取 —— 那正是我们要的:
 *    服务器上换一把钥匙,重启一次(或等一小时到期)全网就跟上了。
 * 2. **过期就重取**,401 也重取一次(令牌可能刚被重发过)。重取失败不抛,
 *    回一句人话 —— 通道连不上只是"这会儿打不了电话",不是崩溃。
 * 3. **LiveKit 的 secret 压根不会到这里**。要进房就 `issueToken()`,中转替我们签;
 *    我们手上从头到尾只有签好的那一串(而且它只够进自己那一间房、只活几天)。
 *
 * ## 「没登录 = 通道不可用」
 *
 * 取凭据要带**设备令牌**(model.json 里那把 `relay_token`),而那把是注册/登录成功那一刻
 * 由 `modelAutoSetup.kick()` 去领的。所以没登录 = 没令牌 = 取不到 —— 这不是故障,
 * 是这一版的设计。`view()` 里那句话要把它说成「登录后可用」,而不是「通道没配」。
 */
import { loadModelConfig, NO_RELAY_NOTE, relayConfigured } from './modelConfig.ts'

/** 中转 `GET /v1/channel-credentials` 回来的那一份(relay/server/channel.cjs 的 channelCredentialsView)。 */
export interface RemoteChannelCredentials {
  livekit: {
    configured: boolean
    url?: string
    room?: string
    token_endpoint?: string
    token_ttl_seconds?: number
  }
  /** 火山流式识别。**客户端直连火山的 WebSocket 才需要它**,所以中转下发值本身。 */
  volc_asr?: { app_id: string, access_token: string, resource_id?: string }
  volc_tts?: { app_id: string, access_token: string, resource_id?: string, cluster?: string }
  /** 这一份能用到什么时候(ISO)。到点重取。 */
  expires_at?: string
  /** 服务器那边缺了什么的人话。原样往上带,不自己编。 */
  notes?: readonly string[]
}

/** 取不到时的分类。界面上那句话按它分叉 —— 「没登录」与「服务器没配」要说不一样的话。 */
export type ChannelCredentialFailure =
  /** 这台没接中转(零服务器档):一个包都没发,不是「没登录」也不是「连不上」。 */
  | 'no_relay'
  | 'not_linked'
  | 'unauthorized'
  | 'network'
  | 'server'

export type ChannelCredentialResult =
  | { ok: true, credentials: RemoteChannelCredentials }
  | { ok: false, reason: ChannelCredentialFailure, error: string }

export interface RemoteChannelTicket {
  url: string
  room: string
  identity: string
  token: string
  /** 秒级时间戳(中转回的就是它)。 */
  expires_at: number
}

export type RemoteChannelTicketResult =
  | { ok: true, ticket: RemoteChannelTicket }
  | { ok: false, reason: ChannelCredentialFailure, error: string }

/** `/channel/status` 与设置里能显示的那一份。**一个密钥都没有**,只有「有没有」。 */
export interface ChannelCredentialView {
  /** 这会儿手上有没有一份没过期的。 */
  cached: boolean
  /** 服务器说 LiveKit 配好了没有。没取过就缺席。 */
  livekit_configured?: boolean
  volc_asr_configured?: boolean
  volc_tts_configured?: boolean
  /** 手上这一份什么时候过期(ISO)。没有就缺席。 */
  expires_at?: string
  /** 上一次取失败的原因分类与那句人话。成功时缺席。 */
  error?: string
  reason?: ChannelCredentialFailure
}

export interface ChannelCredentialStore {
  /** 取一份(有没过期的就用手上那份)。`force` 强制重取。**永不抛**。 */
  get: (options?: { force?: boolean }) => Promise<ChannelCredentialResult>
  /** 让中转替我们签一张进房凭证。**永不抛**。 */
  issueToken: (input: {
    identity: string
    name?: string
    attributes?: Record<string, string>
    /**
     * 设备 metadata(2026-09-21,一行 JSON `{device_id, name, kind}`)。中转原样签进凭证,
     * 房里的在线设备表认的就是它。中转是旧版时它会被忽略 —— 那时工人退回按 identity 认设备。
     */
    metadata?: string
    kind?: 'join' | 'admin'
    ttlSeconds?: number
  }) => Promise<RemoteChannelTicketResult>
  /** 显示用的那一份(没有密钥)。 */
  view: () => ChannelCredentialView
  /** 把手上这份扔掉(退出登录、换了服务器地址时)。 */
  forget: () => void
  /** 这台接没接中转(model.json 或构建里有没有中转地址)。没接时签票计划里没有中转那条路。缺席(老的假 store)= 按接了算。 */
  relayConfigured?: () => Promise<boolean>
}

export interface ChannelCredentialStoreDeps {
  /** `~/.dsh/workbench/model.json` —— 中转地址与设备令牌都在里头。 */
  modelFile: string
  fetchImpl?: typeof fetch
  now?: () => number
  /** 一行日志。**只许写"取到没取到",不许写任何值**。 */
  log?: (line: string) => void
  /**
   * 取凭据的超时(毫秒)。那台服务器在外网,断网时会一直挂着;
   * 而调用方是"手机要进房"这条热路径,挂住等于电话一直响没人接。
   */
  timeoutMs?: number
  /**
   * 「还没有设备令牌就去领一个」(生产接 `modelService.ensureDeviceToken`)。
   *
   * 为什么要这一条:令牌是登录时为**模型服务**领的,而「他用自己的 DeepSeek Key」那一支
   * 压根不会去领(autoRelayDecision 的第三条)。可通话跟他选哪家模型没关系 ——
   * 不补这一下,这类用户会莫名其妙地打不了电话。
   *
   * **只在真的没有时试一次**,而且失败不算错:领不到就还是「没登录/没接上」那句话。
   */
  ensureToken?: () => Promise<{ ok: boolean, error?: string }>
}

const NOT_LINKED = '这台机器还没领到服务器凭证,通道要登录之后才能用。'
const NO_RELAY = `${NO_RELAY_NOTE},通道凭据不向服务器要。`

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, '')
}

/**
 * 中转回包 → 我们认的形状。**看不懂的字段一律丢掉,不猜**:
 * 一个拼错的 `app_id` 会变成"配了但连不上",查起来比"没配"难十倍。
 */
export function parseChannelCredentials(body: unknown): RemoteChannelCredentials | undefined {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return undefined
  const raw = body as Record<string, unknown>
  const lk = (raw.livekit ?? {}) as Record<string, unknown>
  const configured = lk.configured === true
  const url = text(lk.url)
  const room = text(lk.room)
  const ttl = typeof lk.token_ttl_seconds === 'number' && Number.isFinite(lk.token_ttl_seconds)
    ? lk.token_ttl_seconds
    : undefined

  const volc = (value: unknown): { app_id: string, access_token: string, resource_id?: string, cluster?: string } | undefined => {
    if (value === null || typeof value !== 'object') return undefined
    const item = value as Record<string, unknown>
    const appId = text(item.app_id)
    const token = text(item.access_token)
    if (appId === undefined || token === undefined) return undefined
    return {
      app_id: appId,
      access_token: token,
      ...(text(item.resource_id) === undefined ? {} : { resource_id: text(item.resource_id) as string }),
      ...(text(item.cluster) === undefined ? {} : { cluster: text(item.cluster) as string }),
    }
  }

  const notes = Array.isArray(raw.notes)
    ? raw.notes.filter((n): n is string => typeof n === 'string' && n !== '')
    : undefined

  return {
    livekit: {
      // **地址缺了就当没配**:回一个 undefined 的地址比回 configured:true 诚实。
      configured: configured && url !== undefined,
      ...(url === undefined ? {} : { url }),
      ...(room === undefined ? {} : { room }),
      ...(text(lk.token_endpoint) === undefined ? {} : { token_endpoint: text(lk.token_endpoint) as string }),
      ...(ttl === undefined ? {} : { token_ttl_seconds: ttl }),
    },
    ...(volc(raw.volc_asr) === undefined ? {} : { volc_asr: volc(raw.volc_asr) as NonNullable<RemoteChannelCredentials['volc_asr']> }),
    ...(volc(raw.volc_tts) === undefined ? {} : { volc_tts: volc(raw.volc_tts) as NonNullable<RemoteChannelCredentials['volc_tts']> }),
    ...(text(raw.expires_at) === undefined ? {} : { expires_at: text(raw.expires_at) as string }),
    ...(notes === undefined || notes.length === 0 ? {} : { notes }),
  }
}

/**
 * 这一份还能用多久。没写到期时间时给一个**保守的短命**(5 分钟)——
 * 宁可多取几次,也不要因为老中转不回 `expires_at` 就把一份旧凭据抱一辈子。
 */
export const CHANNEL_CREDENTIAL_FALLBACK_TTL_MS = 5 * 60_000

/** 提前多久就算过期。取一次要一个外网往返,别卡在最后一秒上。 */
export const CHANNEL_CREDENTIAL_SKEW_MS = 30_000

export function credentialExpiryMs(credentials: RemoteChannelCredentials, nowMs: number): number {
  if (credentials.expires_at === undefined) return nowMs + CHANNEL_CREDENTIAL_FALLBACK_TTL_MS
  const at = Date.parse(credentials.expires_at)
  return Number.isFinite(at) ? at : nowMs + CHANNEL_CREDENTIAL_FALLBACK_TTL_MS
}

export function createChannelCredentialStore(deps: ChannelCredentialStoreDeps): ChannelCredentialStore {
  const fetchImpl = deps.fetchImpl ?? fetch
  const now = deps.now ?? Date.now
  const log = deps.log ?? (() => {})
  const timeoutMs = deps.timeoutMs ?? 8000

  /** **只在内存里**。进程没了就没了,这是故意的(文件头第 1 条)。 */
  let cached: { credentials: RemoteChannelCredentials, expiresAtMs: number } | undefined
  let lastFailure: { reason: ChannelCredentialFailure, error: string } | undefined
  /** 同一时刻只取一次:工人启动、手机进房、状态面板可能同时问。 */
  let inflight: Promise<ChannelCredentialResult> | undefined

  /**
   * 中转地址 + 设备令牌。没令牌时**试着补一次**(见 deps.ensureToken),
   * 补不上就是 undefined = 还没登录过(或还没领到)。
   */
  async function link(): Promise<{ relayUrl: string, token: string } | 'no_relay' | undefined> {
    let config = await loadModelConfig(deps.modelFile)
    // 没接中转:连「补一次令牌」都不试 —— 那一下也是往中转发的(工人每 30 秒问一次,不拦就是每 30 秒一趟)。
    if (!relayConfigured(config)) return 'no_relay'
    if (config.relay_token === undefined && deps.ensureToken !== undefined) {
      try { await deps.ensureToken() }
      catch { /* 领不到就还是「没接上」,不额外说一句 —— 下面那句话已经够了 */ }
      config = await loadModelConfig(deps.modelFile)
    }
    if (config.relay_token === undefined) return undefined
    return { relayUrl: trimSlash(config.relay_url), token: config.relay_token }
  }

  async function ask(path: string, init?: RequestInit): Promise<Response | 'no_relay' | undefined> {
    const target = await link()
    if (target === undefined || target === 'no_relay') return target
    return fetchImpl(`${target.relayUrl}${path}`, {
      ...init,
      headers: {
        ...(init?.headers ?? {}),
        authorization: `Bearer ${target.token}`,
      },
      signal: AbortSignal.timeout(timeoutMs),
    })
  }

  /** HTTP 状态 → 分类 + 一句人话。中转的错误形状是 OpenAI 的 `{ error: { message } }`。 */
  async function failureOf(res: Response): Promise<{ reason: ChannelCredentialFailure, error: string }> {
    if (res.status === 401) {
      return { reason: 'unauthorized', error: '这台设备的服务器凭证失效了,重新登录一次就好。' }
    }
    const body = await res.json().catch(() => ({})) as { error?: { message?: string } }
    return {
      reason: 'server',
      // 中转说的话优先(它知道服务器上缺什么);说不出来才用我们自己的兜底措辞。
      error: text(body.error?.message) ?? `服务器没能给出通道凭据(HTTP ${res.status})。`,
    }
  }

  async function fetchOnce(): Promise<ChannelCredentialResult> {
    let res: Response | 'no_relay' | undefined
    try {
      res = await ask('/v1/channel-credentials')
    }
    catch {
      // 底层报错里可能带地址与代理细节,一律换成自己的措辞。
      const failure = { reason: 'network' as const, error: '连不上服务器,这会儿取不到通道凭据。' }
      lastFailure = failure
      return { ok: false, ...failure }
    }
    if (res === 'no_relay') {
      lastFailure = { reason: 'no_relay', error: NO_RELAY }
      return { ok: false, reason: 'no_relay', error: NO_RELAY }
    }
    if (res === undefined) {
      lastFailure = { reason: 'not_linked', error: NOT_LINKED }
      return { ok: false, reason: 'not_linked', error: NOT_LINKED }
    }
    if (!res.ok) {
      const failure = await failureOf(res)
      lastFailure = failure
      log(`channel-credentials 取失败(${failure.reason})`)
      return { ok: false, ...failure }
    }
    const parsed = parseChannelCredentials(await res.json().catch(() => undefined))
    if (parsed === undefined) {
      const failure = { reason: 'server' as const, error: '服务器回的通道凭据看不懂。' }
      lastFailure = failure
      return { ok: false, ...failure }
    }
    cached = { credentials: parsed, expiresAtMs: credentialExpiryMs(parsed, now()) }
    lastFailure = undefined
    // **只写有没有,不写值**。
    log(`channel-credentials 取到了(livekit=${parsed.livekit.configured ? 1 : 0}`
      + ` asr=${parsed.volc_asr === undefined ? 0 : 1} tts=${parsed.volc_tts === undefined ? 0 : 1})`)
    return { ok: true, credentials: parsed }
  }

  async function get(options?: { force?: boolean }): Promise<ChannelCredentialResult> {
    if (options?.force !== true && cached !== undefined && now() + CHANNEL_CREDENTIAL_SKEW_MS < cached.expiresAtMs) {
      return { ok: true, credentials: cached.credentials }
    }
    if (inflight !== undefined) return inflight
    inflight = fetchOnce().finally(() => { inflight = undefined })
    return inflight
  }

  return {
    get,

    async issueToken(input) {
      // 身份与属性由调用方(server/channel.ts)定 —— 它才是"按设备令牌拼身份"的那一层。
      const body = {
        identity: input.identity,
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.attributes === undefined ? {} : { attributes: input.attributes }),
        ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
        ...(input.kind === undefined ? {} : { kind: input.kind }),
        ...(input.ttlSeconds === undefined ? {} : { ttl_seconds: input.ttlSeconds }),
      }
      const send = async (): Promise<Response | 'no_relay' | undefined> => ask('/v1/channel-token', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      let res: Response | 'no_relay' | undefined
      try { res = await send() }
      catch {
        return { ok: false, reason: 'network', error: '连不上服务器,这会儿签不出进房凭证。' }
      }
      if (res === 'no_relay') return { ok: false, reason: 'no_relay', error: NO_RELAY }
      if (res === undefined) return { ok: false, reason: 'not_linked', error: NOT_LINKED }
      if (!res.ok) {
        const failure = await failureOf(res)
        // 401 时把手上那份凭据也扔掉:令牌换过了,下一次 get() 会连同房间名一起重取。
        if (failure.reason === 'unauthorized') cached = undefined
        log(`channel-token 签失败(${failure.reason})`)
        return { ok: false, ...failure }
      }
      const parsed = await res.json().catch(() => undefined) as Record<string, unknown> | undefined
      const url = text(parsed?.url)
      const room = text(parsed?.room)
      const identity = text(parsed?.identity)
      const token = text(parsed?.token)
      if (url === undefined || room === undefined || identity === undefined || token === undefined) {
        return { ok: false, reason: 'server', error: '服务器回的进房凭证看不懂。' }
      }
      const expires = typeof parsed?.expires_at === 'number' && Number.isFinite(parsed.expires_at)
        ? parsed.expires_at
        : Math.floor(now() / 1000)
      log(`channel-token 签到了 identity=${identity}`)
      return { ok: true, ticket: { url, room, identity, token, expires_at: expires } }
    },

    view() {
      const fresh = cached !== undefined && now() + CHANNEL_CREDENTIAL_SKEW_MS < cached.expiresAtMs
      return {
        cached: fresh,
        ...(cached === undefined ? {} : {
          livekit_configured: cached.credentials.livekit.configured,
          volc_asr_configured: cached.credentials.volc_asr !== undefined,
          volc_tts_configured: cached.credentials.volc_tts !== undefined,
          ...(cached.credentials.expires_at === undefined ? {} : { expires_at: cached.credentials.expires_at }),
        }),
        ...(lastFailure === undefined ? {} : { error: lastFailure.error, reason: lastFailure.reason }),
      }
    },

    forget() {
      cached = undefined
      lastFailure = undefined
    },

    async relayConfigured() {
      return relayConfigured(await loadModelConfig(deps.modelFile))
    },
  }
}
