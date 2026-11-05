import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { SayDecisionCards } from '../src/chat/SayDecisionCards';
import { sayDecidedRequest } from '../src/chat/sayCards';

describe('say 决策卡片', () => {
  it('消费真实状态中的另一张名片ID，排除本原件负责人，不猜同家第一张', () => {
    const choose = vi.fn();
    const state = { tasks: { tasks: [{ id: 't-1', title: '原件', status: 'confirm' as const, created_at: '', updated_at: '', assignee: 'agent:old' }], agent_cards: ['old', 'next'].map(id => ({ id: `agent:${id}`, name: id, owner: 'me' as const, hand: 'cli', runtime: { family: 'codex' }, shared: { to: 'none' as const }, created_at: '', updated_at: '' })) } };
    const payload = { say_id: 's', items: [{ card_id: 't-1' }], decided: [{ decided_id: 'd-1', item_index: 0, field: 'who', chosen: 'codex', why: '默认', alternatives: [] }] };
    render(<SayDecisionCards payload={payload} state={state} onChoose={choose} />);
    expect(screen.queryByRole('button', { name: '改为 old' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '改为 next' }));
    expect(choose).toHaveBeenCalledWith('agent:next', undefined, undefined, 'd-1');
    expect(sayDecidedRequest(payload, 'd-1', 'agent:next', state)?.ctx.decided).toEqual({ decided_id: 'd-1', choice: 'agent:next' });
    expect(sayDecidedRequest(payload, 'd-1', 'agent:old', state)).toBeUndefined();
    expect(sayDecidedRequest(payload, 'd-1', 'agent:invented', state)).toBeUndefined();
  });
  it('呈现原件并允许用服务端 decided_id 改选', () => {
    const choose = vi.fn();
    render(<SayDecisionCards payload={{ say: { screen: '我先记下了。' }, say_id: 's-1', items: [{ kind: '办', title: '整理样片', status: 'done', card_id: 'task-1' }], decided: [{ decided_id: 'd-1', item_index: 0, field: 'who', chosen: 'Claude', why: '默认分工', alternatives: [{ id: 'agent:kimi', label: 'Kimi' }] }] }} onChoose={choose} />);
    expect(screen.getByText('我先记下了。')).toBeTruthy();
    expect(screen.getByText(/整理样片.*task-1/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '改为 Kimi' }));
    expect(choose).toHaveBeenCalledWith('agent:kimi', undefined, undefined, 'd-1');
  });

  it('缺少服务端关联编号时不能改选', () => {
    render(<SayDecisionCards payload={{ decided: [{ item_index: 0, field: 'who', chosen: 'Claude', why: '默认分工', alternatives: [{ id: 'agent:kimi', label: 'Kimi' }] }] }} onChoose={() => {}} />);
    expect(screen.getByRole('button', { name: '改为 Kimi' })).toHaveProperty('disabled', true);
    expect(screen.getByText(/服务端未提供改选编号/)).toBeTruthy();
  });

  it('显示确认卡且重复提交期间禁用操作', () => {
    render(<SayDecisionCards payload={{ ask: { ask_id: 'a-1', question: '按建议派给 Claude？' }, suggest: { suggest_id: 's-1', line: '建议派给 Claude', default_action: '记下', options: [{ id: 'dispatch', label: '派给 Claude' }] } }} busy onChoose={() => {}} />);
    expect(screen.getByText('建议派给 Claude')).toBeTruthy();
    expect(screen.getByRole('button', { name: '派给 Claude' })).toHaveProperty('disabled', true);
  });

  it('suggest-only 没有真实动作编号时禁用备选与默认按钮', () => {
    const choose = vi.fn();
    render(<SayDecisionCards payload={{ say_id: 'say-s', suggest: { suggest_id: 's-1', line: '可以派给 Claude', default_action: 'keep', options: [{ id: 'agent:claude', label: 'Claude' }] } }} onChoose={choose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Claude' }));
    fireEvent.click(screen.getByRole('button', { name: '按建议默认处理' }));
    expect(choose.mock.calls).toEqual([['agent:claude', undefined, 's-1'], ['keep', undefined, 's-1']]);
  });

  it('ask 与 hold 的中文按钮提交冻结契约使用的 yes/no', () => {
    const choose = vi.fn();
    render(<SayDecisionCards payload={{ hold: { hold_id: 'h-1', reason: 'external', question: '允许继续吗？' } }} onChoose={choose} />);
    fireEvent.click(screen.getByRole('button', { name: '确认' }));
    fireEvent.click(screen.getByRole('button', { name: '否定' }));
    expect(choose.mock.calls).toEqual([['yes', 'h-1'], ['no', 'h-1']]);
  });

  it('部分成功按每件服务端 status 展示，不把失败件算成成功', () => {
    render(<SayDecisionCards payload={{ items: [
      { title: '资料整理', status: 'done', card_id: 'card-1' },
      { title: '客户发送', status: 'failed' },
      { title: '补确认', status: 'asked' },
    ] }} onChoose={() => {}} />);
    expect(screen.getByText(/资料整理.*已处理/)).toBeTruthy();
    expect(screen.getByText(/客户发送.*未处理成功/)).toBeTruthy();
    expect(screen.getByText(/补确认.*等待确认/)).toBeTruthy();
  });
});
