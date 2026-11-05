import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MEETING_PLAN_WHERE, useSendItem } from '../src/chat/useSendItem';
import { mergePending } from '../src/chat/chatModel';
import type { Session } from '../src/session';

// 结构化响应只证明真实 hook/待发箱的消费，不代表模型已理解这些句子。
const fileAsk = { id: 'file-guard', request: '取受控文件', query: 'README', device: 'QA', hits: [], total: 0 };
const screen = '服务端原样回话。';
function world(reply: Record<string, unknown>) {
  const json = vi.fn(async (_path: string) => ({ ok: true as const, status: 200, data: reply }));
  const refresh = vi.fn(async () => {});
  const session = { client: { json }, feed: { get: () => ({ state: { now: '2026-10-24T12:00:00+08:00' } }), refresh } } as unknown as Session;
  return { session, json, refresh };
}

describe('三入口守门对应的真实手机收据源头', () => {
  it.each([undefined, { agent: '受控目标' }])('fileAsk 先于事项/专项，返回卡和原 screen，收掉 pending：extra=%j', async extra => {
    const w = world({ say_id: 'say-file', say: { screen }, file_ask: fileAsk, id: 'not-a-task', meeting_plan: {}, today_view: {}, publish_plan: {}, feedback: {}, carried_on: true });
    const { result } = renderHook(() => useSendItem(w.session));
    let sent: Awaited<ReturnType<typeof result.current.send>> | undefined;
    await act(async () => { sent = await result.current.send('取受控文件', extra); });
    expect(sent).toEqual({ ok: true, fileAsk: { ...fileAsk, screen } });
    expect(result.current.pending).toEqual([]);
    expect(w.refresh).not.toHaveBeenCalled();
    expect(w.json.mock.calls[0]?.[0]).toBe(extra === undefined ? '/butler/say' : '/butler/item');
  });

  it('无效 fileAsk 不抢有效 say 收据，部分失败不挂任何 taskIds', async () => {
    const reply = { say_id: 'say-partial', say: { screen }, file_ask: { id: '', hits: [] }, items: [{ status: 'done', card_id: 'one' }, { status: 'failed' }] };
    const w = world(reply);
    const { result } = renderHook(() => useSendItem(w.session));
    await act(async () => { expect(await result.current.send('受控结构消费')).toEqual({ ok: true }); });
    expect(result.current.pending).toHaveLength(1);
    expect(result.current.pending[0]).toMatchObject({ note: screen, sayCards: reply });
    expect(result.current.pending[0]?.taskIds).toBeUndefined();
    expect(result.current.pending[0]?.taskId).toBeUndefined();
  });

  it('缺 say.screen 即使 fileAsk/id 有值也 rejected，不返回取件卡或成功气泡', async () => {
    const w = world({ file_ask: fileAsk, id: 'not-a-task' });
    const { result } = renderHook(() => useSendItem(w.session));
    await act(async () => { expect((await result.current.send('取受控文件')).ok).toBe(false); });
    expect(result.current.pending[0]?.error).toContain('缺少 say.screen');
    expect(result.current.pending[0]?.taskId).toBeUndefined();
    expect(w.refresh).not.toHaveBeenCalled();
  });

  it.each([
    { fields: { today_view: {}, meeting_plan: {}, publish_plan: {}, feedback: {} }, suffix: '', refresh: true },
    { fields: { meeting_plan: {}, publish_plan: {}, feedback: {} }, suffix: MEETING_PLAN_WHERE, refresh: true },
    { fields: { publish_plan: {}, feedback: {} }, suffix: '', refresh: true },
    { fields: { feedback: {} }, suffix: '', refresh: false },
  ])('专项优先于 carried_on/say/id，已办回执不等不存在的事项：$fields', async ({ fields, suffix, refresh }) => {
    const w = world({ ...fields, note: '专项事实回执', say: { screen }, id: 'not-a-task', carried_on: true });
    const { result } = renderHook(() => useSendItem(w.session));
    await act(async () => { await result.current.send('受控专项结构'); });
    expect(result.current.pending[0]).toMatchObject({ note: `专项事实回执${suffix}`, settled: true });
    expect(result.current.pending[0]?.taskId).toBeUndefined();
    expect(result.current.pending[0]?.taskIds).toBeUndefined();
    expect(mergePending([], result.current.pending)[0]?.receipt).toBe('done');
    expect(w.refresh.mock.calls.length > 0).toBe(refresh);
  });

  it.each([
    { reply: { carried_on: true, id: 'old-task', say: { screen } }, expected: { note: '接着刚才那件说了' } },
    { reply: { id: 'legacy-task' }, expected: { taskId: 'legacy-task' } },
    { reply: { note: '不能拿任意 note 当成功' }, expected: { note: '送到了' } },
  ])('原 /item 接续与普通回执保留：$reply', async ({ reply, expected }) => {
    const w = world(reply);
    const { result } = renderHook(() => useSendItem(w.session));
    await act(async () => { await result.current.send('受控旧入口', { agent: '受控目标' }); });
    expect(result.current.pending[0]).toMatchObject(expected);
    if (!('taskId' in expected)) expect(result.current.pending[0]?.taskId).toBeUndefined();
  });
});
