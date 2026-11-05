/**
 * 手机文字进理解中枢(A2,2026-10-28;设计 `docs/设计-理解中枢-模型出命令-2026-10-28.md` 第六节)。
 *
 * 手机输入框那条路打 `/butler/say` 并带 `entrance:'phone'`(8791 认成中枢的 phone 入口);
 * 中枢挂的那一问(取消 / 对外…)回来是手机现有的那张「护栏」卡,点一下带 `ctx.confirmed` 回同一个口。
 * 回归集里入口为「手机」的行在这里断言请求体;判断全在 8791,手机一条都不判。
 */
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useSendItem } from '../src/chat/useSendItem';
import type { Session } from '../src/session';

const NOW = '2026-10-28T15:00:00+08:00';

function hubSession(replies: Record<string, unknown>[]) {
  const json = vi.fn(async (_path: string, _init: { body: Record<string, unknown> }) => ({ ok: true as const, data: replies.shift() ?? {} }));
  const session = {
    client: { json },
    feed: { get: () => ({ state: { now: NOW }, connected: true, error: undefined }), refresh: vi.fn(async () => {}) },
  } as unknown as Session;
  return { session, json };
}

const reply = (screen: string, extra: Record<string, unknown> = {}) => ({ say_id: 'say-1', items: [], say: { screen, spoken: screen }, hub: { commands: [], rejected: [], results: [] }, ...extra });

describe('手机文字 → /butler/say entrance:phone', () => {
  it.each([
    '让小K把事务官窗里『在跑的事项』显示 0 的问题修了',
    '帮我建一个待办事项:周四下午给客户发样片',
    '把「周五(10-23)把仓库交接给研发」那个目标标成达成。',
  ])('「%s」原话照发,带 entrance:phone;手机不判是问是办', async (said) => {
    const { session, json } = hubSession([reply('好')]);
    const { result } = renderHook(() => useSendItem(session));
    await act(async () => { await result.current.send(said); });
    const [path, init] = json.mock.calls[0]!;
    expect(path).toBe('/butler/say');
    expect(init.body.text).toBe(said);
    expect(init.body.entrance).toBe('phone');
    expect(init.body).not.toHaveProperty('can_file_ask');
  });

  it('中枢挂的那一问(取消要问一次):卡上点「取消它」→ 同一个口带 ctx.confirmed 与 entrance:phone', async () => {
    const asked = reply('要把 t-d7eeb2ff「旧排期卡」取消吗?', { items: [{ kind: '改', title: '要把 t-d7eeb2ff「旧排期卡」取消吗?', status: 'asked', card_id: 't-d7eeb2ff' }], ask: { ask_id: 'ask-1', question: '要把 t-d7eeb2ff「旧排期卡」取消吗?', options: ['取消它', '先留着'] } });
    const { session, json } = hubSession([asked, reply('取消了 t-d7eeb2ff。', { say_id: 'ask-1' })]);
    const { result } = renderHook(() => useSendItem(session));
    await act(async () => { await result.current.send('把卡 t-d7eeb2ff 取消掉'); });
    let chose: { ok: boolean } = { ok: false };
    await act(async () => { chose = await result.current.choose(result.current.pending[0]!.localId, '取消它', 'ask-1'); });
    expect(chose.ok).toBe(true);
    const [path, init] = json.mock.calls[1]!;
    expect(path).toBe('/butler/say');
    expect(init.body).toMatchObject({ entrance: 'phone', text: '取消它', ctx: { confirmed: { ask_id: 'ask-1', choice: '取消它' } } });
    expect(result.current.pending[0]?.note).toContain('取消了');
  });
});
