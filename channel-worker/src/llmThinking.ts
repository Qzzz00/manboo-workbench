/**
 * 电话那一路**显式关掉思考**(2026-09-28,卡 BS;
 * `docs/设计-事务官做什么不做什么与思考分档-2026-09-28.md` 6.1 最后一条、6.3 第 5 条)。
 *
 * ## 为什么要绕这么一下
 *
 * 接话走的是 `@livekit/agents-plugin-openai` 的 `OpenAILLM.withDeepSeek`。它拼请求体时
 * **只放它认得的那几个字段**(model / messages / tools / temperature / reasoning_effort …),
 * 传给它的额外键会被丢掉 —— 也就是说没有任何一个参数能让它发 DeepSeek 方言的
 * `thinking: { type: 'disabled' }`。于是电话这一路一直走 DeepSeek 的默认「开着想」:
 * 有人正举着听筒等回话,想 4–16 秒是最贵也最不该花的一笔(思考按输出计价)。
 *
 * 唯一不改上游、也不猜它内部结构的口子是它收的 `client`:**自己建一个 OpenAI 客户端**,
 * 把 `fetch` 换成一层薄包装,只在发往 `/chat/completions` 的那一下往 body 里补一个 `thinking`。
 * 别的请求(`models.list` 的连通性探测)原样过。
 *
 * ## 三条纪律
 *
 * - **只补不改**:body 里已经有 `thinking` 就一个字不动(哪天上游自己支持了,这层自动让位)。
 * - **绝不因为这层把请求弄坏**:body 读不出来、不是 JSON、不是对象 —— 一律原样发出去。
 * - **不碰凭据**:这层只认 URL 和 body,`authorization` 头原样透传,一个字节都不读、不记。
 */

import OpenAI from 'openai'

/** DeepSeek 方言里「这一问不要想」。与 workbench-plugin 那几处直连写的是同一格。 */
export const THINKING_DISABLED = { type: 'disabled' } as const

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

/** 这一发是不是聊天补全(要补 `thinking` 的只有它)。 */
function isChatCompletions(input: string | URL | Request): boolean {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  try { return new URL(url).pathname.endsWith('/chat/completions') }
  // 相对地址 / 认不出的 URL:按字符串看一眼就够,认不出就不补(宁可不补,也不弄坏这一发)。
  catch { return url.includes('/chat/completions') }
}

/** body 里补一个 `thinking`。补不了(不是 JSON / 不是对象 / 已经有了)回 undefined = 原样发。 */
export function bodyWithThinkingDisabled(body: unknown): string | undefined {
  if (typeof body !== 'string' || body === '') return undefined
  let parsed: unknown
  try { parsed = JSON.parse(body) }
  catch { return undefined }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const record = parsed as Record<string, unknown>
  if ('thinking' in record) return undefined
  try { return JSON.stringify({ ...record, thinking: THINKING_DISABLED }) }
  catch { return undefined }
}

/** 包一层 fetch:发往 `/chat/completions` 的那一下补上 `thinking: { type: 'disabled' }`。 */
export function withThinkingDisabled(fetchImpl: FetchLike): FetchLike {
  return async (input, init) => {
    if (init === undefined || !isChatCompletions(input)) return await fetchImpl(input, init)
    const next = bodyWithThinkingDisabled(init.body)
    if (next === undefined) return await fetchImpl(input, init)
    return await fetchImpl(input, { ...init, body: next })
  }
}

/**
 * 接话用的 OpenAI 客户端。`maxRetries: 0` 与上游自己建的那一个一致
 * (电话里重试一遍比失败更糟:她会在听筒里沉默两倍的时间)。
 */
export function createNoThinkingClient(options: {
  apiKey: string
  baseURL?: string
  fetchImpl?: FetchLike
}): OpenAI {
  return new OpenAI({
    apiKey: options.apiKey,
    ...(options.baseURL === undefined ? {} : { baseURL: options.baseURL }),
    maxRetries: 0,
    fetch: withThinkingDisabled(options.fetchImpl ?? fetch) as unknown as typeof fetch,
  })
}
