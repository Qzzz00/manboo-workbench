import { describe, expect, it } from 'vitest';
import { sayChoiceRequest, sayDecidedRequest, sayReceipt, sayScreen, saySuggestRequest } from '../src/chat/sayCards';

describe('1c say 回包消费', () => {
  it('屏幕原样用服务端 say.screen，缺失时不按 item id 猜成功', () => {
    expect(sayScreen({ say: { screen: '记下了,要派再告诉我。' }, items: [{ status: 'done', card_id: 'card-1' }] })).toBe('记下了,要派再告诉我。');
    expect(sayReceipt({ items: [{ status: 'done', card_id: 'card-1' }] })).toContain('未判断为成功');
  });

  it('suggest 选择用真实 suggest_id 与备选 id，默认 keep 不派且延续原 say_id', () => {
    const payload = { say_id: 'say-9', suggest: { suggest_id: 's-2', line: '建议', default_action: 'keep', options: [{ id: 'agent:claude', label: 'Claude' }] } };
    expect(saySuggestRequest(payload, 'keep')).toEqual({ text: '先放着', ctx: { suggest: { suggest_id: 's-2', choice: 'keep' }, last_say_id: 'say-9' } });
    expect(saySuggestRequest(payload, 'agent:claude')).toEqual({ text: '派给 Claude', ctx: { suggest: { suggest_id: 's-2', choice: 'agent:claude' }, last_say_id: 'say-9' } });
    expect(saySuggestRequest(payload, 'fake-agent')).toBeUndefined();
    expect(saySuggestRequest({ suggest: { suggest_id: '', line: '建议', default_action: 'keep', options: [] } }, 'keep')).toBeUndefined();
  });

  it('suggest 不再借用 confirmed 请求', () => {
    expect(sayChoiceRequest({ say_id: 'say-9', suggest: { suggest_id: 's-2', line: '建议', default_action: 'keep', options: [{ id: 'agent:claude', label: 'Claude' }] } }, 'agent:claude')).toBeUndefined();
  });

  it('hold 与 ask 使用服务端待答 id，畸形/缺少 ID 不构造请求', () => {
    expect(sayChoiceRequest({ hold: { hold_id: 'h-1', reason: 'external', question: '确认?' } }, 'no'))
      .toEqual({ text: '否定', ctx: { confirmed: { ask_id: 'h-1', choice: 'no' } } });
    expect(sayChoiceRequest({ ask: { ask_id: 'a-1', question: '确认?' } }, 'yes')?.ctx.confirmed.ask_id).toBe('a-1');
    expect(sayChoiceRequest({ say: { screen: 'ok' } }, 'yes')).toBeUndefined();
    expect(sayChoiceRequest({ hold: { hold_id: '', reason: 'external', question: '确认?' } }, 'yes')).toBeUndefined();
  });

  it('additive asks 按各自 ask_id 提交，续回 last_say_id', () => {
    const payload = { say_id: 'say-many', asks: [{ ask_id: 'a-1', question: '第一问' }, { ask_id: 'a-2', question: '第二问' }] };
    expect(sayChoiceRequest(payload, 'no', 'a-2')).toEqual({ text: '否定', ctx: { confirmed: { ask_id: 'a-2', choice: 'no' }, last_say_id: 'say-many' } });
  });

  it('decided 改选用真实 decided_id 与备选 id，并沿用原 say_id', () => {
    const payload = { say_id: 'say-7', decided: [{ decided_id: 'd-3', item_index: 0, field: 'who', chosen: 'Claude', why: '默认分工', alternatives: [{ id: 'agent:kimi', label: 'Kimi' }] }] };
    expect(sayDecidedRequest(payload, 'd-3', 'agent:kimi'))
      .toEqual({ text: '改为 Kimi', ctx: { decided: { decided_id: 'd-3', choice: 'agent:kimi' }, last_say_id: 'say-7' } });
    expect(sayDecidedRequest({ decided: [{ item_index: 0, field: 'who', chosen: 'Claude', why: '默认分工', alternatives: [] }] }, undefined, 'fake-id')).toBeUndefined();
    expect(sayDecidedRequest(payload, 'd-3', 'Claude')).toBeUndefined();
  });
});
