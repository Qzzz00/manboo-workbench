import { describe, expect, it } from 'vitest'
import { sayDecisionEvents } from '../src/sayDecisionRoomEvent.ts'

describe('say decision room events', () => {
  it('emits each server decision as a distinct event correlated to its say id', () => {
    const events = sayDecisionEvents({
      say_id: 'say-7', items: [{ title: '给客户寄样片', status: 'todo', card_id: 'card-7', who: 'claude', desc: '忽略' }],
      decided: [{ item_index: 0, field: 'who', chosen: 'claude', why: '默认分工', alternatives: [] }],
      suggest: { suggest_id: 'suggest-2', line: '建议先记下', default_action: 'keep', options: [] },
      ask: { ask_id: 'ask-3', question: '现在执行吗？' },
      hold: { hold_id: 'hold-4', reason: 'external', question: '确认后再继续？' },
      say: { screen: '屏幕原文', spoken: '电话原文' },
    }, 'call-9')
    expect(events).toEqual([
      { type: 'say_decision', event_id: 'say-7:decided:0:who', call_id: 'call-9', say_id: 'say-7', kind: 'decided', say: { screen: '屏幕原文' }, item: { title: '给客户寄样片', status: 'todo', card_id: 'card-7', who: 'claude' }, decision: { item_index: 0, field: 'who', chosen: 'claude', why: '默认分工', alternatives: [] } },
      { type: 'say_decision', event_id: 'say-7:suggest:suggest-2', call_id: 'call-9', say_id: 'say-7', kind: 'suggest', say: { screen: '屏幕原文' }, decision: { suggest_id: 'suggest-2', line: '建议先记下', default_action: 'keep', options: [] } },
      { type: 'say_decision', event_id: 'say-7:ask:ask-3', call_id: 'call-9', say_id: 'say-7', kind: 'ask', say: { screen: '屏幕原文' }, decision: { ask_id: 'ask-3', question: '现在执行吗？' } },
      { type: 'say_decision', event_id: 'say-7:hold:hold-4', call_id: 'call-9', say_id: 'say-7', kind: 'hold', say: { screen: '屏幕原文' }, decision: { hold_id: 'hold-4', reason: 'external', question: '确认后再继续？' } },
    ])
  })

  it('keeps only the approved item fields and omits item when the referenced item is absent', () => {
    const events = sayDecisionEvents({
      say_id: 'say-9', items: [{ title: '原题', extra: '不外带' }],
      decided: [{ item_index: 0, field: 'who', chosen: 'codex' }, { item_index: 4, field: 'who', chosen: 'codex' }],
      say: { screen: '逐字屏幕', spoken: '电话话术' },
    })
    expect(events).toEqual([
      { type: 'say_decision', event_id: 'say-9:decided:0:who', say_id: 'say-9', kind: 'decided', say: { screen: '逐字屏幕' }, item: { title: '原题' }, decision: { item_index: 0, field: 'who', chosen: 'codex' } },
      { type: 'say_decision', event_id: 'say-9:decided:4:who', say_id: 'say-9', kind: 'decided', say: { screen: '逐字屏幕' }, decision: { item_index: 4, field: 'who', chosen: 'codex' } },
    ])
  })

  it('emits no placeholder card when the server returned no decision', () => {
    expect(sayDecisionEvents({ say_id: 'say-8', items: [], say: { screen: '闲聊', spoken: '闲聊' } }, 'call-9')).toEqual([])
  })

  it('emits each asks[] question once while retaining the rich hold event and legacy ask', () => {
    const events = sayDecisionEvents({
      say_id: 'say-10', items: [],
      ask: { ask_id: 'ask-2', question: '继续创建吗？' },
      asks: [
        { ask_id: 'hold-1', question: '先确认对外动作？' },
        { ask_id: 'ask-2', question: '继续创建吗？' },
        { ask_id: 'ask-3', question: '需要通知团队吗？' },
      ],
      hold: { hold_id: 'hold-1', reason: 'external', question: '先确认对外动作？' },
      say: { screen: 'screen', spoken: '先确认第一项。' },
    })
    expect(events).toEqual([
      { type: 'say_decision', event_id: 'say-10:ask:ask-2', say_id: 'say-10', kind: 'ask', say: { screen: 'screen' }, decision: { ask_id: 'ask-2', question: '继续创建吗？' } },
      { type: 'say_decision', event_id: 'say-10:ask:ask-3', say_id: 'say-10', kind: 'ask', say: { screen: 'screen' }, decision: { ask_id: 'ask-3', question: '需要通知团队吗？' } },
      { type: 'say_decision', event_id: 'say-10:hold:hold-1', say_id: 'say-10', kind: 'hold', say: { screen: 'screen' }, decision: { hold_id: 'hold-1', reason: 'external', question: '先确认对外动作？' } },
    ])
  })
})
