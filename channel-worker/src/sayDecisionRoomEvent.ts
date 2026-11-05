import type { SayReply } from './sayTurn.ts'

export type SayDecisionKind = 'decided' | 'suggest' | 'ask' | 'hold'
export interface SayDecisionRoomEvent {
  type: 'say_decision'
  event_id: string
  call_id?: string
  say_id: string
  kind: SayDecisionKind
  decision: Record<string, unknown>
  say: { screen: string }
  item?: { title?: unknown, status?: unknown, card_id?: unknown, who?: unknown }
}

/** Build separate, replay-deduplicable room messages from the server's unchanged decision payloads. */
export function sayDecisionEvents(reply: SayReply, callId?: string): SayDecisionRoomEvent[] {
  const events: SayDecisionRoomEvent[] = []
  const base = { type: 'say_decision' as const, say_id: reply.say_id, say: { screen: reply.say.screen }, ...(callId === undefined ? {} : { call_id: callId }) }
  const emitAsk = (decision: { ask_id: string, question: string }): void => {
    events.push({ ...base, kind: 'ask', event_id: `${reply.say_id}:ask:${decision.ask_id}`, decision })
  }
  for (const decision of reply.decided ?? []) {
    const item = decision as Record<string, unknown>
    const source = typeof item.item_index === 'number' ? reply.items[item.item_index] : undefined
    const card = source === undefined ? undefined : Object.fromEntries(['title', 'status', 'card_id', 'who'].flatMap(key => key in source ? [[key, source[key]]] : []))
    events.push({ ...base, kind: 'decided', event_id: `${reply.say_id}:decided:${String(item.item_index ?? events.length)}:${String(item.field ?? 'field')}`, ...(card === undefined || Object.keys(card).length === 0 ? {} : { item: card }), decision: item })
  }
  if (reply.suggest !== undefined) {
    const decision = reply.suggest as Record<string, unknown>
    events.push({ ...base, kind: 'suggest', event_id: `${reply.say_id}:suggest:${String(decision.suggest_id ?? 'unknown')}`, decision })
  }
  const asks = [...(reply.asks ?? [])]
  if (reply.ask !== undefined && !asks.some(one => one.ask_id === reply.ask?.ask_id)) asks.unshift(reply.ask)
  if (reply.hold !== undefined && !asks.some(one => one.ask_id === reply.hold?.hold_id)) {
    asks.unshift({ ask_id: reply.hold.hold_id, question: reply.hold.question })
  }
  const emitted = new Set<string>()
  for (const ask of asks) {
    if (ask.ask_id === reply.hold?.hold_id || emitted.has(ask.ask_id)) continue
    emitAsk(ask)
    emitted.add(ask.ask_id)
  }
  if (reply.hold !== undefined) {
    const decision = reply.hold as unknown as Record<string, unknown>
    events.push({ ...base, kind: 'hold', event_id: `${reply.say_id}:hold:${String(decision.hold_id)}`, decision })
  }
  return events
}
