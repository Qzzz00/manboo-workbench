/**
 * 回执三档(2026-10-12,卡「手机交代只执行一次」):手机上每一次交代显示
 * 「没送到(可重发)/ 送到了,在等 / 办完了」—— 电脑答了不行的不算没送到,原话照摆。
 */
import { describe, expect, it } from 'vitest';
import { RECEIPT_TEXT, mergePending, receiptOfStatus } from '../src/chat/chatModel';

describe('回执三档', () => {
  it('没送到:三档里的第一档,butler 那一句说清原因', () => {
    const [m] = mergePending([], [{ localId: 'k-1', text: '买咖啡豆', at: 'x', unsent: true, error: '连不上工作台' }]);
    expect(m!.receipt).toBe('unsent');
    expect(m!.butler.text).toContain('连不上工作台');
  });

  it('还在发的那一下不摆回执(只是「发送中…」)', () => {
    const [m] = mergePending([], [{ localId: 'k-1', text: 'a', at: 'x' }]);
    expect(m!.receipt).toBeUndefined();
    expect(m!.butler.text).toBe('发送中…');
  });

  it('电脑答了不行:不是「没送到」,原话照摆、没有回执档', () => {
    const [m] = mergePending([], [{ localId: 'k-1', text: '', at: 'x', error: '事项内容不能为空' }]);
    expect(m!.receipt).toBeUndefined();
    expect(m!.butler.kind).toBe('error');
  });

  it('送到了、卡还没回来:在等;不用再办的那种(登记了会、本体反馈)直接办完了', () => {
    const [a, b, c] = mergePending([], [
      { localId: 'k-1', text: 'a', at: 'x', taskId: 't-1' },
      { localId: 'k-2', text: 'b', at: 'x', note: '接着刚才那件说了' },
      { localId: 'k-3', text: 'c', at: 'x', note: '记下了这场会。', settled: true },
    ]);
    expect([a!.receipt, b!.receipt, c!.receipt]).toEqual(['waiting', 'waiting', 'done']);
  });

  it('有卡的按卡的状态:做完 / 等确认 / 取消算办完了,别的算在等', () => {
    expect(['todo', 'doing', 'blocked'].map((s) => receiptOfStatus(s as never))).toEqual(['waiting', 'waiting', 'waiting']);
    expect(['done', 'confirm', 'canceled'].map((s) => receiptOfStatus(s as never))).toEqual(['done', 'done', 'done']);
  });

  it('三档的字', () => {
    expect(RECEIPT_TEXT.unsent).toContain('没送到');
    expect(RECEIPT_TEXT.waiting).toContain('送到了');
    expect(RECEIPT_TEXT.done).toContain('办完了');
  });
});
