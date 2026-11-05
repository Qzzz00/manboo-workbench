import type { SentenceBudget } from './sentenceCap.ts'

export const SAY_TIMEOUT_MS = 3000
export const SAY_RESULT_BUDGET_MS = 15_000
export const SAY_PENDING_ACK_DELAY_MS = 700
export const SAY_PENDING_ACK_LINE = '我听到了。'

export interface SayContext {
  last_say_id?: string
  confirmed?: { ask_id: string, choice: string }
  in_call?: boolean
}

export interface SayReply {
  say_id: string
  items: readonly Record<string, unknown>[]
  decided?: readonly Record<string, unknown>[]
  suggest?: Record<string, unknown>
  ask?: { ask_id: string, question: string }
  asks?: readonly { ask_id: string, question: string }[]
  hold?: { hold_id: string, reason: string, question: string }
  say: { screen: string, spoken: string }
}

export const SAY_UNAVAILABLE_LINE = '电话入口暂时不可用，这句没有办成。'
export const SAY_RETRY_UNKNOWN_LINE = '我还没收到这句的结果，是否办成还不确定；我不会重复办理。'
export const SAY_OUTCOME_UNKNOWN_LINE = '这句仍在处理，结果还不确定；我不会重复办理。'

export function capSaySpoken(text: string, budget: SentenceBudget, limit: number | undefined): string {
  if (limit === undefined || !Number.isInteger(limit) || limit <= 0) return text
  return budget.take(text, limit)
}

/** A local acknowledgement must leave at least one actual sentence for the result. */
export function canSayPendingAck(budget: SentenceBudget, limit: number | undefined): boolean {
  return limit === undefined || !Number.isInteger(limit) || limit <= 0 || budget.spent < limit - 1
}

/** A pending stream may be pulled after a different call/final has replaced its owner. */
export function guardSayStream<T>(stream: ReadableStream<T>, current: () => boolean): ReadableStream<T> {
  return stream.pipeThrough(new TransformStream<T, T>({
    transform(chunk, controller) { if (current()) controller.enqueue(chunk) },
  }))
}

export async function sayPendingAckDue(pending: Promise<unknown>, delayMs = SAY_PENDING_ACK_DELAY_MS): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      pending.then(() => false, () => false),
      new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(true), delayMs) }),
    ])
  }
  finally { if (timer !== undefined) clearTimeout(timer) }
}

export type SayTurnResult = { kind: 'reply', reply: SayReply } | { kind: 'fallback', reason: string, timedOut?: boolean, outcomeUncertain?: boolean }

export function uncertainSayReplyOf(result: { outcomeUncertain?: boolean, kind?: string, ok?: boolean }): SayReply | undefined {
  if (result.outcomeUncertain !== true) return undefined
  return { say_id: '', items: [], say: { screen: SAY_OUTCOME_UNKNOWN_LINE, spoken: SAY_OUTCOME_UNKNOWN_LINE } }
}

/** Per-call continuation state; failed requests never consume confirmation context. */
export class SayConversation {
  #lastSayId: string | undefined
  #pendingAskIds: string[] = []

  contextFor(choice?: 'yes' | 'no'): SayContext {
    return {
      ...(this.#lastSayId === undefined ? {} : { last_say_id: this.#lastSayId }),
      ...(this.#pendingAskIds[0] !== undefined && choice !== undefined
        ? { confirmed: { ask_id: this.#pendingAskIds[0], choice: choice === 'yes' ? '是' : '否' } }
        : {}),
      in_call: true,
    }
  }

  accept(reply: SayReply): void {
    this.#lastSayId = reply.say_id
    const pending = [...(reply.asks ?? [])]
    if (reply.hold !== undefined && !pending.some(one => one.ask_id === reply.hold?.hold_id)) {
      pending.unshift({ ask_id: reply.hold.hold_id, question: reply.hold.question })
    }
    if (reply.ask !== undefined && !pending.some(one => one.ask_id === reply.ask?.ask_id)) {
      pending.unshift(reply.ask)
    }
    this.#pendingAskIds = pending.map(one => one.ask_id)
  }

  reset(): void {
    this.#lastSayId = undefined
    this.#pendingAskIds = []
  }

  failed(): void { /* Keep the prior say id and confirmation until a server reply arrives. */ }
}

export async function postSayTurn(input: {
  baseUrl: string
  text: string
  ctx?: SayContext
  clientKey?: string
  headers?: Record<string, string>
  timeoutMs?: number
  signal?: AbortSignal
  fetchImpl?: typeof fetch
}): Promise<SayTurnResult> {
  const text = input.text.trim()
  if (!text) return { kind: 'fallback', reason: 'empty transcript' }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? SAY_TIMEOUT_MS)
  const signal = input.signal === undefined ? controller.signal : AbortSignal.any([controller.signal, input.signal])
  try {
    const response = await (input.fetchImpl ?? fetch)(`${input.baseUrl.replace(/\/+$/, '')}/butler/say`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...input.headers }, signal,
      // 电话入口(A2,2026-10-28):8791 按 call 进理解中枢;老 8791 不认 call 时照旧按 ctx.in_call 走旧路。
      body: JSON.stringify({ text, entrance: 'call', ...(input.clientKey ? { client_key: input.clientKey } : {}), ...(input.ctx ? { ctx: input.ctx } : {}) }),
    })
    if (!response.ok) {
      if (response.status === 409) {
        const body = await response.json().catch(() => undefined) as { code?: unknown } | undefined
        if (body?.code === 'still_running') return { kind: 'fallback', reason: 'still_running', outcomeUncertain: true }
      }
      return { kind: 'fallback', reason: `HTTP ${response.status}` }
    }
    const raw = await response.json() as Partial<SayReply>
    signal.throwIfAborted()
    if (typeof raw.say_id !== 'string' || typeof raw.say?.screen !== 'string' || typeof raw.say.spoken !== 'string' || !Array.isArray(raw.items)) {
      return { kind: 'fallback', reason: 'invalid /butler/say response' }
    }
    return { kind: 'reply', reply: raw as SayReply }
  }
  catch (error) {
    return {
      kind: 'fallback', reason: error instanceof Error ? error.message : 'request failed',
      ...(controller.signal.aborted ? { timedOut: true } : {}),
    }
  }
  finally { clearTimeout(timer) }
}
