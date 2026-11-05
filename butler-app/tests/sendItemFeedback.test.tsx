/**
 * 手机上说了一句「工作台这里不对」(2026-09-28 卡 FB,2026-10-01 按新 main 重做)。
 *
 * 电脑那头这一句**不建卡、不派任何一家**,回执里带 `feedback` 与事务官那一句。
 * 手机这一侧要钉住的就一件事:**那条气泡不许挂卡 id** —— 挂了 `mergePending` 会去等一张
 * 永远不会来的卡,他刚说的那句话就一直停在「发送中…」(这正是卡 J 那一幕的毛病)。
 * 正确的样子:把工作台那一句摆成这条气泡的回话。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useSendItem } from '../src/chat/useSendItem';
import type { Session } from '../src/session';

const NOTE = '这是工作台本身的问题,我已经反馈给开发者了,修好会随更新到你这。';

/** 电脑那一拍的时刻(`/state.now`):这条气泡上那个时刻盖的就是它(2026-10-02,卡 claude/phone-clock)。 */
const NOW = '2026-10-02T21:30:00+08:00';

/** 只有 `client.json`、`feed.get`(拿 `/state.now`)与 `feed.refresh` 会被用到,别的不造。 */
function fakeSession(reply: Record<string, unknown>, now: string = NOW) {
  const refresh = vi.fn(async () => {});
  const session = {
    client: { json: async () => ({ ok: true as const, data: reply }) },
    feed: { get: () => ({ state: { now }, connected: true, error: undefined }), refresh },
  } as unknown as Session;
  return { session, refresh };
}

/** 手机自己的钟钉在一个风马牛不相及的日子:证的是这一处盖的不是它。 */
function pinPhoneClock(iso: string): void {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(iso));
}
afterEach(() => { vi.useRealTimers(); });

describe('本体的毛病:气泡不挂卡 id', () => {
  it('回执带 feedback → 气泡上摆那一句,没有 taskId', async () => {
    const { session } = fakeSession({ say_id: 'say-fb-1', say: { screen: NOTE, spoken: NOTE }, items: [], feedback: { id: 'fb-1', status: 'sent' }, note: NOTE });
    const { result } = renderHook(() => useSendItem(session));
    await act(async () => { await result.current.send('发布计划那里没有标记今天是哪一天,这个不方便'); });
    expect(result.current.pending.length).toBe(1);
    expect(result.current.pending[0]?.note).toBe(NOTE);
    expect(result.current.pending[0]?.taskId).toBeUndefined();
  });

  it('发不出去那一句也原样摆(不许说成已经反馈了)', async () => {
    const local = '这是工作台本身的问题,我记下了。还没连上服务器(没登录),这一条先记在本机。';
    const { session } = fakeSession({ say_id: 'say-fb-2', say: { screen: local, spoken: local }, items: [], feedback: { id: 'fb-2', status: 'local' }, note: local });
    const { result } = renderHook(() => useSendItem(session));
    await act(async () => { await result.current.send('顶栏的时间显示不对'); });
    expect(result.current.pending[0]?.note).toBe(local);
  });

  it('普通一件事照旧挂卡 id(这一档一个字都没变)', async () => {
    const { session } = fakeSession({
      ok: true,
      say_id: 'say-7',
      items: [{ kind: '办', title: '明天上午十点提醒我开会', status: 'done', card_id: 'item-7' }],
      say: { screen: '记下了。', spoken: '记下了。' },
    });
    const { result } = renderHook(() => useSendItem(session));
    await act(async () => { await result.current.send('明天上午十点提醒我开会'); });
    expect(result.current.pending[0]?.taskIds).toEqual(['item-7']);
    expect(result.current.pending[0]?.note).toBe('记下了。');
  });
});

/**
 * 这条气泡上那个时刻(2026-10-02,卡 claude/phone-clock):气泡画出来时 `formatClock` 判
 * 「是不是今天」看的是 `/state.now`,所以盖戳也得用同一个钟 —— 手机钟歪了,
 * 他刚说出口的那句话不许写成「12-25 10:00」。
 */
describe('气泡上那个时刻:盖的是电脑的钟', () => {
  it('★手机的钟在 12-25 也不算数:pending 那条的 at 就是 /state.now', async () => {
    pinPhoneClock('2026-12-25T10:00:00+08:00');
    const { session } = fakeSession({ ok: true, id: 'item-8' });
    const { result } = renderHook(() => useSendItem(session));
    await act(async () => { await result.current.send('加个导出 PDF'); });
    expect(result.current.pending[0]?.at).toBe(NOW);
  });

  it('还没连上(/state.now 是空串)才退回手机的钟 —— 那时 formatClock 也退回它,两头仍是同一个钟', async () => {
    pinPhoneClock('2026-12-25T10:00:00+08:00');
    const { session } = fakeSession({ ok: true, id: 'item-9' }, '');
    const { result } = renderHook(() => useSendItem(session));
    await act(async () => { await result.current.send('加个导出 PDF'); });
    expect(result.current.pending[0]?.at).toBe(new Date('2026-12-25T10:00:00+08:00').toISOString());
  });
});

describe('登记了一场会(2026-10-10):气泡不挂卡 id,摆「记下了 + 还差哪一问」并指去会议页', () => {
  it('回执带 meeting_plan → 不挂 taskId;发出去的那一下带 can_meeting_plan', async () => {
    const note = '记下了这场会。还差一问:什么类型的会?';
    const json = vi.fn(async () => ({ ok: true as const, data: { say_id: 'say-meeting-1', say: { screen: note, spoken: note }, items: [], meeting_plan: { id: 'm1', title: '跟 B 客户谈' }, note } }));
    const session = {
      client: { json },
      feed: { get: () => ({ state: { now: NOW }, connected: true, error: undefined }), refresh: vi.fn(async () => {}) },
    } as unknown as Session;
    const { result } = renderHook(() => useSendItem(session));
    await act(async () => { await result.current.send('下午三点跟 B 客户谈下季度合作'); });
    expect((json.mock.calls[0] as unknown as [string, { body: Record<string, unknown> }])[0]).toBe('/butler/say');
    expect((json.mock.calls[0] as unknown as [string, { body: Record<string, unknown> }])[1].body.entrance).toBe('phone');
    expect(result.current.pending[0]?.taskId).toBeUndefined();
    expect(result.current.pending[0]?.note).toContain('还差一问:什么类型的会?');
    expect(result.current.pending[0]?.note).toContain('会议');
  });
});

describe('排进发布计划(2026-10-13):气泡摆电脑那一句,回执直接「办完了」', () => {
  it('★回执带 publish_plan → 不挂 taskId、摆那一句、receipt 是 done', async () => {
    const note = '好,记进发布计划了:10 月 18 号,秋天穿搭的视频';
    const json = vi.fn(async () => ({ ok: true as const, data: { say_id: 'say-publish-1', say: { screen: note, spoken: note }, items: [], publish_plan: { day: '2026-10-18', title: '秋天穿搭的视频' }, note } }));
    const session = {
      client: { json },
      feed: { get: () => ({ state: { now: NOW }, connected: true, error: undefined }), refresh: vi.fn(async () => {}) },
    } as unknown as Session;
    const { result } = renderHook(() => useSendItem(session));
    await act(async () => { await result.current.send('计划 18 号发一个关于秋天穿搭的视频'); });
    expect(result.current.pending[0]?.taskId).toBeUndefined();
    expect(result.current.pending[0]?.note).toContain('记进发布计划了');
    expect(result.current.pending[0]?.settled).toBe(true);
  });
});

describe('换「今天的待办」那一版(2026-10-13,卡「三个入口一套管线」)', () => {
  it('★回执带 today_view → 不挂 taskId、摆电脑那一句(与电话里逐字相同)、receipt 是 done', async () => {
    const note = '好,改成按日期汇总了。';
    const json = vi.fn(async () => ({ ok: true as const, data: { say_id: 'say-view-1', say: { screen: note, spoken: note }, items: [], today_view: { view: 'by_date', changed: true }, note } }));
    const session = {
      client: { json },
      feed: { get: () => ({ state: { now: NOW }, connected: true, error: undefined }), refresh: vi.fn(async () => {}) },
    } as unknown as Session;
    const { result } = renderHook(() => useSendItem(session));
    await act(async () => { await result.current.send('把待办改成按日期汇总'); });
    expect(result.current.pending[0]?.taskId).toBeUndefined();
    expect(result.current.pending[0]?.note).toBe('好,改成按日期汇总了。');
    expect(result.current.pending[0]?.settled).toBe(true);
  });
});
