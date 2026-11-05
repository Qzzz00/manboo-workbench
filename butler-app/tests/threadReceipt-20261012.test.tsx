/**
 * 记录面板里每一次交代下面那一行回执(2026-10-12,卡「手机交代只执行一次」):
 * 没送到摆「重发」、电脑答了不行摆「收起」、送到了 / 办完了只是一行字。
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ThreadList } from '../src/chat/ThreadList';
import { RECEIPT_TEXT, mergePending } from '../src/chat/chatModel';

const NOW = '2026-10-12T09:00:00+08:00';

describe('回执那一行', () => {
  it('没送到:那一行 + 「重发」,点了带 localId', () => {
    const onResend = vi.fn();
    const thread = mergePending([], [{ localId: 'k-1', text: '买咖啡豆', at: NOW, unsent: true, error: '连不上工作台' }]);
    render(<ThreadList thread={thread} voiceOff now={NOW} onResend={onResend} />);
    expect(screen.getByText(RECEIPT_TEXT.unsent)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '重发' }));
    expect(onResend).toHaveBeenCalledWith('k-1');
  });

  it('电脑答了不行:没有回执档,摆「收起」', () => {
    const onDismiss = vi.fn();
    const thread = mergePending([], [{ localId: 'k-2', text: 'x', at: NOW, error: '事项内容不能为空' }]);
    render(<ThreadList thread={thread} voiceOff now={NOW} onDismiss={onDismiss} />);
    expect(screen.queryByRole('button', { name: '重发' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '收起' }));
    expect(onDismiss).toHaveBeenCalledWith('k-2');
  });

  it('送到了 · 在等 / 办完了:只是一行字,没有键', () => {
    const thread = [
      ...mergePending([], [{ localId: 'k-3', text: 'a', at: NOW, taskId: 't-3' }]),
      { taskId: 't-4', user: 'b', at: NOW, butler: { kind: 'status' as const, text: '办完了', speak: false }, status: 'done' as const, receipt: 'done' as const },
    ];
    render(<ThreadList thread={thread} voiceOff now={NOW} />);
    expect(screen.getByText(RECEIPT_TEXT.waiting)).toBeTruthy();
    expect(screen.getAllByRole('status').map((one) => one.textContent)).toEqual([RECEIPT_TEXT.waiting, RECEIPT_TEXT.done]);
    expect(screen.queryAllByRole('button')).toEqual([]);
  });
});
