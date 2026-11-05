/**
 * **中转上配了哪家,才出现哪家**(2026-09-26,卡 GH)。
 *
 * 起因:派活名单与额度面板里的「GPT」是个空壳。接口那只手是经我们自己的中转(`relay/`)转给上游的
 * (`dispatchApi.ts`,默认 `gpt-4o`,中转按模型名前缀挑上游),而线上那台中转 `/health` 回的是
 * `"providers":{"deepseek":true,"openai":false,"doubao":false}` —— **服务器上没配 OpenAI 的 Key**。
 * 于是「派给 GPT」只会换回一句 503 `openai_not_configured`:界面上摆着一家、点下去必失败。
 *
 * 维护者 09-26 问的是「所以 GPT 那条没有意义,可以删掉是吧」。答应的做法**不是删**,而是一条机制:
 * **中转配了哪家才出现哪家**。哪天服务器上加一行 `RELAY_OPENAI_KEY`,GPT 自己回来,一行代码都不用改。
 *
 * ## 这个文件回答三件事
 *
 * 1. **中转此刻配了哪几家**(`createRelayProvidersReader`):问 `/health` 的 `providers`,缓存;
 *    取不到就按上次那份,从没取到过就当「一家都没配」——**宁可少一家,不摆空壳**。
 * 2. **某一家的接口那只手发给中转上的哪一家上游**(`relayProviderFor`):判据与中转自己那份
 *    **逐字同源**(`relay/server/providers.cjs` 的 `providerOfModel`:模型名前缀),
 *    所以这边判「发不出去」与那边判「503」永远是同一条线。
 * 3. **接口那只手这会儿能不能用**(`apiHandStatus`),以及不能用时对人说的那一句。
 *
 * ## 为什么只在「走中转」那一档问
 *
 * 他自己填了 DeepSeek Key 直连官方时,接口那只手本来就一律不可用(`dispatchApi.ts` 的 `not_relay`),
 * 问了也没有用处;而 `/health` 是中转的路,官方那边没有这条路。所以 `mode !== 'relay'` 时**一个请求都不发**。
 *
 * ## 凭据纪律
 *
 * `/health` **不含任何密钥**(relay/server/app.cjs:「配了没有」只回布尔),所以这条路不带令牌、
 * 回包里也没有任何要藏的东西。这个文件从头到尾不碰 Key。
 */
import type { ApiDispatchFamily } from './dispatchApi.ts'
import { API_DISPATCH_MODELS } from './dispatchApi.ts'

/** 中转上游那三家。顺序与 `relay/server/providers.cjs` 的 `PROVIDERS` 一致。 */
export const RELAY_PROVIDERS = ['deepseek', 'openai', 'doubao'] as const
export type RelayProviderName = typeof RELAY_PROVIDERS[number]

/**
 * `/health` 的 `providers` 那一格:哪几家配了 Key。**只有布尔** —— 中转永远不回 Key、不回地址。
 *
 * 用 `string` 当键而不是 `RelayProviderName`:中转哪天多接一家上游,老工作台读到的是一个它不认得的名字,
 * 那时该照旧过日子(多出来的那一家它压根用不上),而不是类型上先炸一下。
 */
export type RelayProvidersView = Readonly<Record<string, boolean>>

/** 重问的最小间隔。10 分钟 —— 服务器上加一行 Key 到界面上多一家,慢十分钟没有人会察觉。 */
export const RELAY_PROVIDERS_REFRESH_MS = 10 * 60_000

/** 问一次等多久。`/health` 是一条不查库不转发的路,5 秒还不回就是网络的事,按「取不到」办。 */
export const RELAY_PROVIDERS_TIMEOUT_MS = 5_000

/**
 * `/health` 的回包 → `providers`。**认不出一律 undefined**(= 没取到,照上次那份),不猜:
 *
 * - 不是合法 JSON、不是对象、没有 `providers` 那一格(09-22 之前的老中转就没有)→ undefined;
 * - 有那一格:只留值真是布尔的那几条 —— 回了 `"openai": "yes"` 这种就当这一条没说。
 */
export function parseRelayProviders(text: string | undefined): RelayProvidersView | undefined {
  if (text === undefined) return undefined
  let parsed: unknown
  try { parsed = JSON.parse(text) }
  catch { return undefined }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const raw = (parsed as { providers?: unknown }).providers
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const out: Record<string, boolean> = {}
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'boolean') out[name] = value
  }
  return out
}

/**
 * 模型名 → 中转会把它发给哪一家。**这是 `relay/server/providers.cjs` 的 `providerOfModel` 的镜像**
 * (`gpt-*`、`o1`/`o3`/`o4…` → OpenAI;`doubao-*`、`ep-*` → 豆包;其余 → DeepSeek)。
 *
 * 为什么抄一份而不是共用:那份是中转仓库里的 CommonJS,跑在服务器上;工作台是 TypeScript,
 * 跑在用户的电脑上,两边压根不在一个进程里。抄的是**三行纯字符串判断**,而且用例把两边的判据钉在一起。
 */
export function relayProviderOfModel(model: string | undefined): RelayProviderName {
  const name = (model ?? '').trim().toLowerCase()
  if (name.startsWith('gpt-') || /^o\d/.test(name)) return 'openai'
  if (name.startsWith('doubao-') || name.startsWith('ep-')) return 'doubao'
  return 'deepseek'
}

/**
 * 这一家走接口那只手时,中转会转给哪一家上游。
 *
 * 判据是**这一家默认发的那个模型名**(`API_DISPATCH_MODELS`)—— 与中转分家的判据是同一个值,
 * 所以这里不另存一张「家 → 上游」的表(两张表迟早会漂,而漂出来的现象是「界面说配了、派过去 503」)。
 * 没给它配过模型的家回 `deepseek`,与中转「认不出就是 DeepSeek」那一档对齐。
 */
export function relayProviderFor(family: string): RelayProviderName {
  return relayProviderOfModel(API_DISPATCH_MODELS[family as ApiDispatchFamily])
}

/**
 * 中转上配了这一家的上游没有。
 *
 * **`providers` 缺席(从没问到过)一律 false** —— 宁可少一家,不摆空壳:
 * 少了那一家的代价是「他得自己去点别家」,摆一个空壳的代价是「点下去必失败,而且看不出为什么」。
 */
export function relayHasProviderFor(family: string, providers: RelayProvidersView | undefined): boolean {
  if (providers === undefined) return false
  return providers[relayProviderFor(family)] === true
}

/** 接口那只手没接上时那一句(模型服务本身没接上)。 */
export const API_HAND_NO_RELAY_WHY = '模型服务没接上'

/** 接口那只手接上了、但**中转上没配这一家上游**时那一句(维护者 09-26 的原话)。 */
export const API_HAND_PROVIDER_MISSING_WHY = '中转没配这家'

/**
 * 接口那只手这会儿能不能用。有窗口的那几家(豆包)据此把接口那一只标成不可用,整家照常在;
 * 只有接口那一只的那几家(今天 = GPT)据此**整家不出现**(`dispatchTargets`)。
 */
export function apiHandStatus(
  family: string,
  input: { apiReady?: boolean | undefined, relayProviders?: RelayProvidersView | undefined },
): { ready: boolean, why?: string } {
  if (input.apiReady !== true) return { ready: false, why: API_HAND_NO_RELAY_WHY }
  if (!relayHasProviderFor(family, input.relayProviders)) return { ready: false, why: API_HAND_PROVIDER_MISSING_WHY }
  return { ready: true }
}

/** `/health` 在哪。`endpoint().baseUrl` 是带 `/v1` 的那一份,健康检查在它外面一层。 */
export function relayHealthUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '')}/health`
}

/** 读它要的那一点点:往哪发、是不是走中转。注进来的就是 `modelService.endpoint()`。 */
export interface RelayProvidersEndpoint {
  mode: 'relay' | 'own'
  /** 已经带 `/v1`。 */
  baseUrl: string
}

export interface RelayProvidersReaderDeps {
  endpoint: () => Promise<RelayProvidersEndpoint>
  fetchImpl?: typeof fetch
  now: () => number
  /** 重问的最小间隔。缺省 `RELAY_PROVIDERS_REFRESH_MS`。 */
  refreshMs?: number
  /** 一次问答等多久。缺省 `RELAY_PROVIDERS_TIMEOUT_MS`。 */
  timeoutMs?: number
}

export interface RelayProvidersReader {
  /** 上次问到的那一份。**从没问到过 → undefined**(调用方按「一家都没配」办)。 */
  view: () => RelayProvidersView | undefined
  /** 节流过的后台重问(`/state` 那一拍上调一次,同 `modelMode.pump`)。 */
  pump: () => void
  /** 真去问一次。**绝不抛**:取不到就回上次那份。 */
  read: () => Promise<RelayProvidersView | undefined>
  /** 模型模式切了 / 重领了凭证:作废节流,立刻重问一次。 */
  refresh: () => void
}

/**
 * 跟 `modelMode.ts` 同一套「请求驱动 + 内部限频」:`/state` 一秒一拍,不能一秒问中转一次。
 *
 * **三条都是「宁可少一家」**:
 * - 走的不是中转(他填了自己的 Key)→ 一个请求都不发,回上次那份;
 * - 请求失败 / 超时 / 回包认不出 → 回上次那份(网络抖一下不该让界面上少一家又多一家);
 * - 从没问到过 → undefined,调用方当「一家都没配」。
 */
export function createRelayProvidersReader(deps: RelayProvidersReaderDeps): RelayProvidersReader {
  const fetchImpl = deps.fetchImpl ?? fetch
  const refreshMs = deps.refreshMs ?? RELAY_PROVIDERS_REFRESH_MS
  const timeoutMs = deps.timeoutMs ?? RELAY_PROVIDERS_TIMEOUT_MS
  let providers: RelayProvidersView | undefined
  let askedAt: number | undefined
  let asking = false

  async function read(): Promise<RelayProvidersView | undefined> {
    askedAt = deps.now()
    let endpoint: RelayProvidersEndpoint | undefined
    try { endpoint = await deps.endpoint() }
    catch { endpoint = undefined }
    // ★ 只在「走工作台提供的模型服务」那一档问:自己的 Key 直连官方时接口那只手本来就不可用。
    if (endpoint === undefined || endpoint.mode !== 'relay') return providers

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetchImpl(relayHealthUrl(endpoint.baseUrl), { method: 'GET', signal: controller.signal })
      if (!response.ok) return providers
      const got = parseRelayProviders(await response.text())
      if (got !== undefined) providers = got
    }
    catch { /* 连不上 / 超时 / 回包读不出:按上次那份办 */ }
    finally { clearTimeout(timer) }
    return providers
  }

  /** 正在问的那一次(pump / refresh 都不等它,但把它交出去:用例要等「问完了」而不是睡固定的毫秒数)。 */
  let inflight: Promise<void> = Promise.resolve()
  function ask(): Promise<void> {
    asking = true
    inflight = read().then(() => undefined, () => undefined).finally(() => { asking = false })
    return inflight
  }
  return {
    view: () => providers,
    pump: () => {
      if (asking) return inflight
      if (askedAt !== undefined && deps.now() - askedAt < refreshMs) return inflight
      return ask()
    },
    read,
    refresh: () => {
      askedAt = undefined
      if (asking) return inflight
      return ask()
    },
  }
}
