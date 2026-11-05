/**
 * 资讯搜索走哪条路(2026-10-21,局域网 M7「零服务器是缺省」):
 *
 * 1. 她在设置 › 各家的登录与密钥里填了**自己的博查密钥**(`credentials.json` 的 `bocha`)→ 直连博查,不经中转;
 * 2. 没填、这台接了中转且领到了设备令牌 → 中转的 `/v1/search`(relay/server/search.cjs,今天的老路);
 * 3. 都没有 → 如实说「搜索没配」,资讯里不编条目。
 *
 * 直连的请求与回包形状照抄中转那一份(`relay/server/search.cjs` 的 `searchUpstream` / `normalizeResults`),
 * 两边换了要一起换。密钥只进 authorization 头,错误里一个字都不带上游原文(它可能把密钥抖出来)。
 */
import { loadCredentials } from './credentials.ts'
import type { SearchResult } from './feed.ts'
import { loadModelConfig, NO_RELAY_NOTE, relayConfigured } from './modelConfig.ts'

export const BOCHA_SEARCH_URL = 'https://api.bochaai.com/v1/web-search'

/** 搜索两条路都没有时那一句。 */
export const SEARCH_NOT_CONFIGURED = `搜索没配:${NO_RELAY_NOTE},也没填博查密钥(设置 › 各家的登录与密钥 › 博查搜索)。`

const SEARCH_TIMEOUT_MS = 12_000

export type FeedSearch = (query: string, count: number) => Promise<{ ok: true, results: SearchResult[] } | { ok: false, error: string }>

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/** 博查(`data.webPages.value[]`)或扁平数组(`results[]` / 顶层数组)→ 资讯那一侧的形状。认不出 = 0 条,不编。 */
export function normalizeSearchResults(json: unknown): SearchResult[] {
  const body = (typeof json === 'object' && json !== null ? json : {}) as Record<string, unknown>
  const pages = (body.data as { webPages?: { value?: unknown } } | undefined)?.webPages?.value
    ?? (body.webPages as { value?: unknown } | undefined)?.value
  const rows: unknown[] = Array.isArray(json) ? json : Array.isArray(pages) ? pages : Array.isArray(body.results) ? body.results : []
  const out: SearchResult[] = []
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue
    const r = row as Record<string, unknown>
    const url = nonEmpty(r.url) ?? nonEmpty(r.link)
    const title = nonEmpty(r.name) ?? nonEmpty(r.title)
    if (url === undefined || title === undefined) continue
    const source = nonEmpty(r.siteName) ?? nonEmpty(r.source) ?? nonEmpty(r.displayUrl)
    const published = nonEmpty(r.datePublished) ?? nonEmpty(r.date) ?? nonEmpty(r.published_at)
    out.push({
      title,
      url,
      snippet: nonEmpty(r.summary) ?? nonEmpty(r.snippet) ?? nonEmpty(r.description) ?? '',
      ...(source === undefined ? {} : { source }),
      ...(published === undefined ? {} : { published_at: published }),
    })
  }
  return out
}

export function createFeedSearch(deps: { modelFile: string, credentialFile: string, fetchImpl?: typeof fetch }): FeedSearch {
  const fetchImpl = deps.fetchImpl ?? fetch

  async function direct(key: string, query: string, count: number): ReturnType<FeedSearch> {
    let res: Response
    try {
      res = await fetchImpl(BOCHA_SEARCH_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({ query, count, freshness: 'oneWeek', summary: true }),
        signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
      })
    }
    catch { return { ok: false, error: '连不上博查搜索' } }
    if (!res.ok) return { ok: false, error: res.status === 401 || res.status === 403 ? '博查不认这串密钥(设置 › 各家的登录与密钥 › 博查搜索 里重填一次)' : `博查搜索回了 ${res.status}` }
    try { return { ok: true, results: normalizeSearchResults(await res.json()) } }
    catch { return { ok: false, error: '博查搜索回了一段读不懂的内容' } }
  }

  async function viaRelay(relayUrl: string, token: string, query: string, count: number): ReturnType<FeedSearch> {
    let response: Response
    try {
      response = await fetchImpl(`${relayUrl}/v1/search`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ query, count, freshness: 'oneWeek' }),
      })
    }
    catch { return { ok: false, error: '连不上搜索服务' } }
    if (!response.ok) {
      // 中转的错误体是 OpenAI 形状 `{ error: { message } }`,那句 message 是写给人看的,原样转达。
      let message = `搜索服务回了 ${response.status}`
      try {
        const body = await response.json() as { error?: { message?: unknown } }
        if (typeof body.error?.message === 'string' && body.error.message !== '') message = body.error.message
      }
      catch { /* 读不出就用上面那句 */ }
      return { ok: false, error: message }
    }
    try {
      const body = await response.json() as { results?: unknown }
      return { ok: true, results: Array.isArray(body.results) ? body.results as SearchResult[] : [] }
    }
    catch { return { ok: false, error: '搜索服务回了一段读不懂的内容' } }
  }

  return async (query, count) => {
    const own = (await loadCredentials(deps.credentialFile)).bocha
    if (own !== undefined) return await direct(own, query, count)
    /**
     * 直接读 model.json,不经 `modelService.endpoint()` —— endpoint() 在「用自己的 DeepSeek Key」那档回的是
     * api.deepseek.com,那底下没有搜索;设备令牌与「他选了哪家模型」本来就是两件事。
     */
    const config = await loadModelConfig(deps.modelFile)
    if (!relayConfigured(config)) return { ok: false, error: SEARCH_NOT_CONFIGURED }
    if (config.relay_token === undefined) return { ok: false, error: '这台机器还没领到服务凭证,资讯搜不了' }
    return await viaRelay(config.relay_url, config.relay_token, query, count)
  }
}
