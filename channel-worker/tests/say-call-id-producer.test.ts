import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createCallState } from '../src/callOut.ts'
import { sayDecisionEvents } from '../src/sayDecisionRoomEvent.ts'

// Execute the actual greet setup, before its first onboarding return. LiveKit audio/session startup
// is unnecessary for checking the producer's state -> decision association.
function greetSetup() {
  const source = readFileSync(new URL('../src/agent.ts', import.meta.url), 'utf8')
  const start = source.indexOf('async greet(by, callId) {')
  const body = source.indexOf('{', start) + 1
  const end = source.indexOf('if (onboardingOn)', body)
  if (start < 0 || end < body) throw new Error('greet boundary changed')
  return new Function('by', 'callId', 'bindSpeaker', 'sayConversation', 'farewell', 'listenAgain', 'callState', 'syncListen', 'let sayCallId; const invalidateSay = () => sayConversation.reset();' + source.slice(body, end)) as (...args: unknown[]) => void
}

describe('outgoing production call -> say decision correlation', () => {
  it('retains the caller supplied call_id in in_call, say_decision and idle', () => {
    const signals: Record<string, unknown>[] = []
    const state = createCallState({ send: line => signals.push(JSON.parse(line) as Record<string, unknown>), now: () => 1234 })
    greetSetup()({ identity: 'wb-phone-qa', kind: 'phone' }, 'ph-qa-original', () => {}, { reset() {} }, undefined, () => {}, state, () => {})
    const event = sayDecisionEvents({ say_id: 'say-qa', items: [], ask: { ask_id: 'ask-qa', question: '确认吗？' }, say: { screen: '确认吗？', spoken: '确认吗？' } }, state.current()?.callId)[0]
    state.leave('phone')
    expect({ start: signals[0]?.call_id, decision: event?.call_id, end: signals[1]?.call_id }).toEqual({ start: 'ph-qa-original', decision: 'ph-qa-original', end: 'ph-qa-original' })
  })

  it('keeps legacy callers without an id compatible', () => {
    const signals: Record<string, unknown>[] = []
    const state = createCallState({ send: line => signals.push(JSON.parse(line) as Record<string, unknown>) })
    greetSetup()({ identity: 'wb-phone-old', kind: 'phone' }, undefined, () => {}, { reset() {} }, undefined, () => {}, state, () => {})
    expect(signals[0]).not.toHaveProperty('call_id')
    expect(state.current()?.callId).toBeUndefined()
  })
})
