import { describe, expect, it } from 'vitest';
import { createSayDecisionEventDeduper, mergeSayDecisionEvent, parseSayDecisionRoomEvent } from '../src/call/sayDecisionRoomEvent';

describe('room say_decision 消费投影', () => {
  it('识别1b事件并原样保留 decision 与关联字段', () => {
    const decision = { decided_id: 'd-1', item_index: 0, field: 'who', chosen: 'Claude', alternatives: [{ id: 'agent:kimi', label: 'Kimi' }] };
    expect(parseSayDecisionRoomEvent(JSON.stringify({ type: 'say_decision', event_id: 's-1:decided:d-1', call_id: 'call-1', say_id: 's-1', kind: 'decided', decision })))
      .toEqual({ type: 'say_decision', event_id: 's-1:decided:d-1', call_id: 'call-1', say_id: 's-1', kind: 'decided', decision });
  });

  it('畸形或空决定结构不变成客户端候选', () => {
    expect(parseSayDecisionRoomEvent('{bad')).toBeNull();
    expect(parseSayDecisionRoomEvent(JSON.stringify({ type: 'say_decision', event_id: 'e', say_id: 's', kind: 'ask', decision: [] }))).toBeNull();
    expect(parseSayDecisionRoomEvent(JSON.stringify({ type: 'say_decision', event_id: 'e', say_id: '', kind: 'ask', decision: {} }))).toBeNull();
  });

  it('按 event_id 去重但不合并不同服务端决定', () => {
    const accept = createSayDecisionEventDeduper();
    const one = parseSayDecisionRoomEvent(JSON.stringify({ type: 'say_decision', event_id: 's:ask:a', say_id: 's', kind: 'ask', decision: { ask_id: 'a' } }))!;
    expect(accept(one)).toBe(true);
    expect(accept(one)).toBe(false);
    expect(accept({ ...one, event_id: 's:hold:h', kind: 'hold' })).toBe(true);
  });

  it('同一 say_id 聚合原始事件，多条 decided 保留各自服务端 id', () => {
    const a = parseSayDecisionRoomEvent(JSON.stringify({ type: 'say_decision', event_id: 's:decided:0:who', say_id: 's', kind: 'decided', decision: { decided_id: 'd1', item_index: 0, field: 'who' } }))!;
    const b = parseSayDecisionRoomEvent(JSON.stringify({ type: 'say_decision', event_id: 's:ask:a', say_id: 's', kind: 'ask', decision: { ask_id: 'a', question: '确认？' } }))!;
    expect(mergeSayDecisionEvent(mergeSayDecisionEvent([], a), b)).toEqual([{ say_id: 's', decided: [{ decided_id: 'd1', item_index: 0, field: 'who' }], asks: [{ ask_id: 'a', question: '确认？' }] }]);
  });

  it('同一回合的多条 ask 事件都保留，不能被后到的一条覆盖', () => {
    const a = parseSayDecisionRoomEvent(JSON.stringify({ type: 'say_decision', event_id: 's:ask:a1', say_id: 's', kind: 'ask', decision: { ask_id: 'a1', question: '第一问' } }))!;
    const b = parseSayDecisionRoomEvent(JSON.stringify({ type: 'say_decision', event_id: 's:ask:a2', say_id: 's', kind: 'ask', decision: { ask_id: 'a2', question: '第二问' } }))!;
    expect(mergeSayDecisionEvent(mergeSayDecisionEvent([], a), b)).toEqual([{ say_id: 's', asks: [{ ask_id: 'a1', question: '第一问' }, { ask_id: 'a2', question: '第二问' }] }]);
  });

  it('消费接缝补充的 screen 与原件字段，不在客户端推导', () => {
    const decision = { decided_id: 'd2', item_index: 2, field: 'who', chosen: 'Claude', why: '默认分工', alternatives: [{ id: 'agent:kimi', label: 'Kimi' }] };
    const event = parseSayDecisionRoomEvent(JSON.stringify({
      type: 'say_decision', event_id: 's:decided:2:who', say_id: 's', kind: 'decided', decision,
      say: { screen: '我替你定了这件事。' }, item: { title: '原件标题', status: 'running', card_id: 'card-2', who: 'Claude' },
    }))!;
    expect(event).toMatchObject({ say: { screen: '我替你定了这件事。' }, item: { title: '原件标题', status: 'running', card_id: 'card-2' } });
    expect(mergeSayDecisionEvent([], event)[0]).toMatchObject({
      say_id: 's', say: { screen: '我替你定了这件事。' },
      items: [undefined, undefined, { title: '原件标题', status: 'running', card_id: 'card-2', who: 'Claude' }],
      decided: [decision],
    });
  });

  it('忽略决定事件中字段类型错误的可选 screen/item', () => {
    expect(parseSayDecisionRoomEvent(JSON.stringify({
      type: 'say_decision', event_id: 's:decided:0:who', say_id: 's', kind: 'decided',
      decision: { item_index: 0, field: 'who' }, say: { screen: 7 }, item: { title: 9, card_id: 'c1' },
    }))).toEqual({
      type: 'say_decision', event_id: 's:decided:0:who', say_id: 's', kind: 'decided',
      decision: { item_index: 0, field: 'who' }, item: { card_id: 'c1' },
    });
  });
});
