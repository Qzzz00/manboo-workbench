import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { SayDecisionCards } from './SayDecisionCards.tsx';
import { sayConfirmBody, sayDecidedBody, saySuggestBody } from './sayCards.ts';

describe('desktop say cards', () => {
  it('offers real stable card IDs from state without retargeting the current assignee or inventing a candidate', () => {
    const choose = vi.fn();
    const state = { tasks: { sprints: [], modules: [], project_meta: [], tasks: [{ id: 't-1', title: 'original', status: 'confirm' as const, source: { kind: 'manual' as const }, created_at: '', updated_at: '', assignee: 'agent:old' }], agent_cards: ['old', 'next'].map(id => ({ id: `agent:${id}` as const, name: id, owner: 'me' as const, hand: 'cli', runtime: { family: 'codex' }, shared: { to: 'none' as const }, created_at: '', updated_at: '' })) } };
    const payload = { say_id: 's', items: [{ card_id: 't-1' }], decided: [{ decided_id: 'd-1', item_index: 0, field: 'who', chosen: 'codex', why: 'default', alternatives: [] }] };
    render(<SayDecisionCards busy={false} payload={payload} state={state} onChoose={choose} />);
    expect(screen.queryByRole('button', { name: '改为 old' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '改为 next' }));
    expect(choose).toHaveBeenCalledWith('agent:next', undefined, undefined, 'd-1');
    expect(sayDecidedBody(payload, 'd-1', 'agent:next', state)?.ctx).toEqual({ decided: { decided_id: 'd-1', choice: 'agent:next' }, last_say_id: 's' });
    expect(sayDecidedBody(payload, 'd-1', 'agent:old', state)).toBeUndefined();
    expect(sayDecidedBody(payload, 'd-1', 'agent:invented', state)).toBeUndefined();
  });
  it('shows service screen verbatim and enables a decided switch only with its stable id', () => {
    const choose = vi.fn();
    render(<SayDecisionCards busy={false} onChoose={choose} payload={{ say_id: 'say-1', say: { screen: '我先记下了。' }, items: [{ title: '整理样片', card_id: 'task-1' }], decided: [{ decided_id: 'decision-1', item_index: 0, field: 'who', chosen: 'Claude', why: '默认分工', alternatives: [{ id: 'agent:kimi', label: 'Kimi' }] }] }} />);
    expect(screen.getByText('我先记下了。')).toBeTruthy();
    expect(screen.getByText(/事项 ID task-1/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '改为 Kimi' }));
    expect(choose).toHaveBeenCalledWith('agent:kimi', undefined, undefined, 'decision-1');
    expect(sayDecidedBody({ say_id: 'say-1', decided: [{ decided_id: 'decision-1', item_index: 0, field: 'who', chosen: 'Claude', why: '默认分工', alternatives: [{ id: 'agent:kimi', label: 'Kimi' }] }] }, 'decision-1', 'agent:kimi'))
      .toEqual({ text: '改为 Kimi', entrance: 'desktop', ctx: { decided: { decided_id: 'decision-1', choice: 'agent:kimi' }, last_say_id: 'say-1' } });
  });

  it('never invents a decided id or enables unsupported decision fields', () => {
    const choose = vi.fn();
    render(<SayDecisionCards busy={false} onChoose={choose} payload={{ decided: [{ item_index: 0, field: 'when', chosen: '今天', why: '缺省', alternatives: [{ id: 'tomorrow', label: '明天' }] }] }} />);
    expect(screen.getByRole('button', { name: '改为 明天' })).toHaveProperty('disabled', true);
    expect(choose).not.toHaveBeenCalled();
  });

  it('only sends the frozen confirmation context, preserving say id', () => {
    expect(sayConfirmBody({ say_id: 'say-1', hold: { hold_id: 'hold-1', reason: 'external', question: '确认？' } }, 'no'))
      .toEqual({ text: '否定', entrance: 'desktop', ctx: { confirmed: { ask_id: 'hold-1', choice: 'no' }, last_say_id: 'say-1' } });
    expect(sayConfirmBody({ say: { screen: 'ok' } }, 'yes')).toBeUndefined();
    expect(sayConfirmBody({ say_id: 's-2', suggest: { suggest_id: 'suggest-2', line: '建议', default_action: 'keep', options: [{ id: 'agent:kimi', label: 'Kimi' }] } }, 'agent:kimi')).toBeUndefined();
  });

  it('renders every additive ask and binds each answer to its own ask id', () => {
    const choose = vi.fn();
    render(<SayDecisionCards busy={false} onChoose={choose} payload={{ say_id: 'say-many', asks: [{ ask_id: 'a-1', question: '第一问' }, { ask_id: 'a-2', question: '第二问' }] }} />);
    expect(screen.getByText('第一问')).toBeTruthy();
    expect(screen.getByText('第二问')).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: '否定' })[1]!);
    expect(choose).toHaveBeenCalledWith('no', 'a-2');
  });

  it('maps the confirmation labels to the frozen yes/no choice values', () => {
    const choose = vi.fn();
    const view = render(<SayDecisionCards busy={false} onChoose={choose} payload={{ ask: { ask_id: 'ask-1', question: '允许继续吗？' } }} />);
    fireEvent.click(within(view.container).getByRole('button', { name: '确认' }));
    fireEvent.click(within(view.container).getByRole('button', { name: '否定' }));
    expect(choose.mock.calls).toEqual([['yes', 'ask-1'], ['no', 'ask-1']]);
  });

  it('disables choices when the service omitted its confirmation id', () => {
    const view = render(<SayDecisionCards busy={false} onChoose={() => {}} payload={{ hold: { hold_id: '', reason: 'external', question: '确认？' } }} />);
    expect(within(view.container).getByRole('button', { name: '确认' })).toHaveProperty('disabled', true);
    expect(sayConfirmBody({ hold: { hold_id: '', reason: 'external', question: '确认？' } }, 'yes')).toBeUndefined();
  });

  it('suggest controls submit exact option id or keep with the same suggest_id', () => {
    const choose = vi.fn();
    render(<SayDecisionCards busy={false} onChoose={choose} payload={{ say_id: 'say-s', suggest: { suggest_id: 's-1', line: '建议派给 Kimi', default_action: 'keep', options: [{ id: 'agent:kimi', label: 'Kimi' }] } }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Kimi' }));
    fireEvent.click(screen.getByRole('button', { name: '按建议默认处理' }));
    expect(choose.mock.calls).toEqual([['agent:kimi', undefined, 's-1'], ['keep', undefined, 's-1']]);
    expect(saySuggestBody({ say_id: 'say-s', suggest: { suggest_id: 's-1', line: '建议', default_action: 'keep', options: [{ id: 'agent:kimi', label: 'Kimi' }] } }, 'agent:kimi'))
      .toEqual({ text: '派给 Kimi', entrance: 'desktop', ctx: { suggest: { suggest_id: 's-1', choice: 'agent:kimi' }, last_say_id: 'say-s' } });
  });

  it('renders partial success and failure exactly from per-item status', () => {
    render(<SayDecisionCards busy={false} onChoose={() => {}} payload={{ items: [
      { title: '资料整理', status: 'done' },
      { title: '客户发送', status: 'failed' },
      { title: '补确认', status: 'asked' },
    ] }} />);
    expect(screen.getByText(/资料整理.*已处理/)).toBeTruthy();
    expect(screen.getByText(/客户发送.*处理失败/)).toBeTruthy();
    expect(screen.getByText(/补确认.*等待确认/)).toBeTruthy();
  });
});
