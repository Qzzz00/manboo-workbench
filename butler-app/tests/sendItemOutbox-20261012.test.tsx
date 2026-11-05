/**
 * 交代一句,没送到就留在手机上(2026-10-12,卡「手机交代只执行一次」)。
 * 气泡摆「没送到」;点「重发」或待发箱自己补发,带的是同一个请求号;送到了气泡挂上卡 id(送到了 · 在等)。
 * App 被杀重开(换一个 hook、同一份账):那一句还在,补发后照样接上。
 */
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ApiResult } from '../src/api/client';
import { useSendItem } from '../src/chat/useSendItem';
import { mergePending } from '../src/chat/chatModel';
import { createSendOutbox } from '../src/outbox/sendOutbox';
import type { Session } from '../src/session';
import { memoryStore } from './wbchFakes';

const OFFLINE: ApiResult<never> = { ok: false, status: 0, kind: 'network', error: '连不上工作台' };

function world() {
  const kv = memoryStore();
  const answers: ApiResult<unknown>[] = [];
  const keys: unknown[] = [];
  const paths: string[] = [];
  const client = {
    json: vi.fn(async (path: string, options?: { body?: Record<string, unknown> }) => {
      paths.push(path);
      keys.push(options?.body?.client_key);
      const answer = (answers.shift() ?? OFFLINE) as ApiResult<never>;
      return answer;
    }),
  };
  const session = (outbox = createSendOutbox({ kv, client })) => ({
    client,
    outbox,
    feed: { get: () => ({ state: { now: '2026-10-12T09:00:00+08:00' }, connected: true }), refresh: vi.fn(async () => {}) },
  } as unknown as Session);
  return { kv, client, answers, keys, paths, session };
}

describe('没送到 → 重发', () => {
  it('连不上:气泡是「没送到」;点重发带同一个号,送到了挂上卡 id', async () => {
    const w = world();
    const s = w.session();
    const { result } = renderHook(() => useSendItem(s));
    let first: { ok: boolean } = { ok: true };
    await act(async () => { first = await result.current.send('把周报整理一下'); });
    expect(first.ok).toBe(false);
    expect(result.current.pending).toEqual([expect.objectContaining({ text: '把周报整理一下', unsent: true })]);
    expect(mergePending([], result.current.pending)[0]!.receipt).toBe('unsent');

    w.answers.push({ ok: true, status: 200, data: { say_id: 'say-1', say: { screen: '办完了' }, items: [{ status: 'done', card_id: 't-1' }], replayed: true } });
    await act(async () => { await result.current.resend(result.current.pending[0]!.localId); });
    expect(w.keys[1]).toBe(w.keys[0]);
    expect(result.current.pending).toEqual([expect.objectContaining({ taskIds: ['t-1'], sayCards: expect.objectContaining({ say_id: 'say-1' }) })]);
    expect(mergePending([], result.current.pending)[0]!.receipt).toBe('waiting');
  });

  it('App 被杀重开:同一份账,那一句还在;待发箱补发后接上卡', async () => {
    const w = world();
    const s1 = w.session();
    const before = renderHook(() => useSendItem(s1));
    await act(async () => { await before.result.current.send('交房租'); });
    before.unmount();

    const outbox = createSendOutbox({ kv: w.kv, client: w.client });
    const s2 = w.session(outbox);
    const after = renderHook(() => useSendItem(s2));
    await waitFor(() => expect(after.result.current.pending).toEqual([expect.objectContaining({ text: '交房租', unsent: true })]));
    w.answers.push({ ok: true, status: 200, data: { say_id: 'say-9', say: { screen: '记下了' }, items: [{ status: 'done', card_id: 't-9' }] } });
    await act(async () => { await outbox.pump(); });
    expect(w.keys[1]).toBe(w.keys[0]);
    expect(after.result.current.pending).toEqual([expect.objectContaining({ text: '交房租', taskIds: ['t-9'], sayCards: expect.objectContaining({ say_id: 'say-9' }) })]);
  });

  it('收起:电脑答了不行的那一句她点掉', async () => {
    const w = world();
    w.answers.push({ ok: false, status: 400, kind: 'http', error: '事项内容不能为空' });
    const s = w.session();
    const { result } = renderHook(() => useSendItem(s));
    await act(async () => { await result.current.send('x'); });
    expect(result.current.pending[0]).toMatchObject({ error: '事项内容不能为空' });
    expect(result.current.pending[0]!.unsent).toBeUndefined();
    act(() => { result.current.dismiss(result.current.pending[0]!.localId); });
    expect(result.current.pending).toEqual([]);
  });

  it('纯文本与建议卡使用 /butler/say；无建议动作口时不伪造 confirmed', async () => {
    const w = world();
    w.answers.push({ ok: true, status: 200, data: { say_id: 'say-1', say: { screen: '建议派给 Claude' }, suggest: { suggest_id: 's-1', line: '建议派给 Claude', default_action: 'dispatch', options: [{ id: 'dispatch', label: '派给 Claude' }] } } });
    const s = w.session();
    const { result } = renderHook(() => useSendItem(s));
    await act(async () => { await result.current.send('把样片整理一下'); });
    expect(w.paths[0]).toBe('/butler/say');
    expect(result.current.pending[0]).toMatchObject({ note: '建议派给 Claude', sayCards: { say_id: 'say-1' } });

    let choice: { ok: boolean; error?: string } = { ok: true };
    await act(async () => { choice = await result.current.choose(result.current.pending[0]!.localId, 'dispatch'); });
    expect(choice.ok).toBe(false);
    expect(choice.error).toContain('没有提供可用的确认编号');
    expect(w.paths).toEqual(['/butler/say']);
    expect(result.current.pending[0]).toMatchObject({ note: '建议派给 Claude', sayCards: { say_id: 'say-1' } });
  });

  it('say 回包缺少 say.screen 时即使带 done/card_id 也不冒称成功或自动重发', async () => {
    const w = world();
    w.answers.push({ ok: true, status: 200, data: { say_id: 'say-bad', items: [{ status: 'done', card_id: 'task-1' }] } });
    const s = w.session();
    const { result } = renderHook(() => useSendItem(s));
    let sent: { ok: boolean; error?: string } = { ok: true };
    await act(async () => { sent = await result.current.send('整理样片'); });
    expect(sent.ok).toBe(false);
    expect(sent.error).toContain('不要直接重复发送');
    expect(result.current.pending[0]?.error?.includes('不要直接重复发送')).toBe(true);
    expect(w.paths).toEqual(['/butler/say']);
  });

  it('确认选择的回包 say.screen 为空时保留原卡并报告未确认', async () => {
    const w = world();
    w.answers.push({ ok: true, status: 200, data: { say_id: 'say-1', say: { screen: '请确认', spoken: '请确认' }, hold: { hold_id: 'hold-1', reason: 'external', question: '确认？' } } });
    const s = w.session();
    const { result } = renderHook(() => useSendItem(s));
    await act(async () => { await result.current.send('发邮件'); });
    w.answers.push({ ok: true, status: 200, data: { say_id: 'say-2', say: { screen: '' }, items: [{ status: 'done', card_id: 'task-1' }] } });
    let choice: { ok: boolean } = { ok: true };
    await act(async () => { choice = await result.current.choose(result.current.pending[0]!.localId, 'yes'); });
    expect(choice.ok).toBe(false);
    expect(result.current.pending[0]?.sayCards?.say_id).toBe('say-1');
    expect(w.paths).toEqual(['/butler/say', '/butler/say']);
  });
});
