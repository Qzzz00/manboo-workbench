/**
 * 手机设置 ·「它学到了什么」(2026-10-09)。与电脑设置里同一页(`GET /habits`)。
 *
 * 盯住:
 *   ① 老工作台 404 → 整节不出现;
 *   ② 一条都没有 → 说人话;三段都在;
 *   ③ 任何一种按同一个形状显示(不认识的种类照样一行,种类名缺了有兜底);依据、原话、开始试用;不露 id;
 *   ④ 撤掉:先确认,再打 `POST /habits/revoke {id}`(配对过的手机算她本人);撤掉的写明不会再自己学回来;
 *   ⑤ 进化日志有摘要,不露 id;
 *   ⑥ 撤错能恢复(2026-10-10):撤掉的每条一颗「恢复」→ `POST /habits/restore`;摘要取最新那一句结论。
 */
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  HabitsSection, PHONE_HABIT_KIND_FALLBACK, PHONE_HABITS_EMPTY_NOTE, phoneEvolveLogDigest,
  type PhoneHabitView, type PhoneHabitsView,
} from '../src/settings/HabitsSection';
import { SessionContext, type Session } from '../src/session';
import { createApiClient } from '../src/api/client';
import { createVoiceApi } from '../src/api/voice';
import { createCallApi } from '../src/api/call';
import { createAppearanceFeed } from '../src/swarm/appearance';
import { emptyState } from '../src/api/protocol';
import type { FeedSnapshot, StateFeed } from '../src/api/stateFeed';
import { fakeChannel, fakeRouted } from './wbchFakes';

function fakeFeed(): StateFeed {
  const snapshot: FeedSnapshot = { state: emptyState(), connected: true, error: undefined };
  return { get: () => snapshot, subscribe: () => () => {}, async refresh() {}, stop() {} };
}

const DISPATCH: PhoneHabitView = {
  id: '分派:写代码的活→codex', kind: 'dispatch', kind_title: '默认分派', text: '写代码的活这类事默认派给 Codex', status: 'trial',
  evidence: [{ at: '2026-10-07T03:00:00.000Z', what: '10-07 11:00 推荐 Claude,她改派 Codex' }],
  applied: 0, adopted_at: '2026-10-08T05:00:00.000Z', updated_at: '2026-10-08T05:00:00.000Z',
};
const STYLE: PhoneHabitView = {
  id: '风格:短', kind: 'style', kind_title: '说话风格', text: '汇报先说结论', status: 'kept',
  evidence: [{ at: '2026-10-06T02:00:00.000Z', what: '10-06 嫌汇报太长', said: '你说重点就行' }],
  applied: 3, adopted_at: '2026-10-06T02:00:00.000Z', updated_at: '2026-10-08T02:00:00.000Z', verdict: '之后没再这么说',
};
const ODD = { ...DISPATCH, id: '新:1', kind: 'whatever', kind_title: undefined, text: '某个新学到的', evidence: [] } as unknown as PhoneHabitView;
const GONE: PhoneHabitView = { ...DISPATCH, id: '时段:12', kind: 'quiet', kind_title: '什么时候打电话', text: '12 点不打电话', status: 'reverted', evidence: [], verdict: '12 点她接了一通' };

const LOG = '# 进化日志\n\n## 2026-10-07 试用习惯(默认分派):写代码的活这类事默认派给 Codex\n\n- **提议 id**:`x`\n- **留下**:2026-10-08 —— 她照派了(习惯 id `x`)\n';

function mount(view: PhoneHabitsView | 'off', log?: string) {
  const posts: { path: string; body: Record<string, unknown> }[] = [];
  const pairing = { token: 't', host: 'h', port: 8791, deviceId: 'd' };
  let current = view;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const path = url.slice(url.indexOf('/', 'http://'.length));
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (path === '/habits') return current === 'off' ? json({ error: '习惯没接上' }, 404) : json(current);
    if (path === '/habits/revoke') {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      posts.push({ path, body });
      if (current !== 'off') {
        const gone = [...current.trial, ...current.kept].find(one => one.id === body.id);
        current = {
          trial: current.trial.filter(one => one.id !== body.id),
          kept: current.kept.filter(one => one.id !== body.id),
          retired: gone === undefined ? current.retired : [{ ...gone, status: 'removed' }, ...current.retired],
        };
      }
      return json({ ok: true, note: '撤掉了,以后不再自己学回来。' });
    }
    if (path === '/habits/restore') {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      posts.push({ path, body });
      if (current !== 'off') {
        const back = current.retired.find(one => one.id === body.id);
        current = {
          trial: back === undefined ? current.trial : [{ ...back, status: 'trial' }, ...current.trial],
          kept: current.kept,
          retired: current.retired.filter(one => one.id !== body.id),
        };
      }
      return json({ ok: true, note: '恢复了,重新试用,下一次同类的事照常验证。' });
    }
    if (path === '/evolve/log') return log === undefined ? json({ error: '还没有进化日志' }, 404) : json({ text: log });
    return json({ error: '没这条路' }, 404);
  }) as typeof fetch;
  const client = createApiClient({ pairing, fetchImpl, onUnauthorized: () => {} });
  const session: Session = {
    pairing,
    client: fakeRouted(client, 'direct'),
    direct: client,
    feed: fakeFeed(),
    voice: createVoiceApi(client),
    call: createCallApi(client),
    channel: fakeChannel({}),
    appearance: createAppearanceFeed(client),
    settings: { async load() { throw new Error('用不到'); }, async update() { throw new Error('用不到'); } },
    async unpair() {},
  };
  const rendered = render(<SessionContext.Provider value={session}><HabitsSection /></SessionContext.Provider>);
  return { ...rendered, posts };
}

describe('手机设置 · 它学到了什么', () => {
  it('① 老工作台 404 → 整节不出现', async () => {
    const { container } = mount('off');
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(container.textContent).toBe('');
  });

  it('② 一条都没有 → 说人话,三段都在', async () => {
    mount({ trial: [], kept: [], retired: [] });
    expect(await screen.findByText(PHONE_HABITS_EMPTY_NOTE)).toBeTruthy();
    for (const head of ['正在试用', '已经留下', '撤掉的']) expect(screen.getByRole('heading', { name: new RegExp(head, 'u') })).toBeTruthy();
  });

  it('③ 任何一种按同一个形状显示;不露 id', async () => {
    const { container } = mount({ trial: [DISPATCH, ODD], kept: [STYLE], retired: [GONE] });
    expect(await screen.findByText('写代码的活这类事默认派给 Codex')).toBeTruthy();
    expect(screen.getByText('说话风格')).toBeTruthy();
    expect(screen.getByText(PHONE_HABIT_KIND_FALLBACK)).toBeTruthy();
    expect(screen.getByText(/10-07 11:00 推荐 Claude,她改派 Codex/u)).toBeTruthy();
    expect(screen.getByText(/「你说重点就行」/u)).toBeTruthy();
    expect(container.textContent).toMatch(/开始试用/u);
    expect(container.textContent).toContain('12 点她接了一通');
    expect(container.textContent).not.toContain('分派:');
  });

  it('④ 撤掉:先确认,再打 /habits/revoke;撤掉的不会再自己学回来', async () => {
    const { posts } = mount({ trial: [DISPATCH], kept: [STYLE], retired: [] });
    await screen.findByText('写代码的活这类事默认派给 Codex');
    expect(screen.getAllByRole('button', { name: '撤掉' })).toHaveLength(2);
    expect(screen.getByText(/不会再自己学回来/u)).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: '撤掉' })[0]!);
    expect(posts).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: /确定撤掉/u }));
    await waitFor(() => expect(posts).toEqual([{ path: '/habits/revoke', body: { id: DISPATCH.id } }]));
    expect(await screen.findByText('撤掉了,以后不再自己学回来。')).toBeTruthy();
    await waitFor(() => expect(screen.getAllByRole('button', { name: '撤掉' })).toHaveLength(1));
  });

  it('⑤ 进化日志摘要,不露 id', async () => {
    expect(phoneEvolveLogDigest(LOG, 5)).toEqual([
      { title: '2026-10-07 试用习惯(默认分派):写代码的活这类事默认派给 Codex', latest: '留下:2026-10-08 —— 她照派了' },
    ]);
    const { container } = mount({ trial: [], kept: [], retired: [] }, LOG);
    fireEvent.click(await screen.findByRole('button', { name: /进化日志/u }));
    expect(await screen.findByText(/写代码的活这类事默认派给 Codex$/u)).toBeTruthy();
    expect(container.textContent).not.toContain('提议 id');
  });

  it('⑥ 撤错能恢复:撤掉的每条一颗「恢复」→ /habits/restore,挪回正在试用;摘要取最新那一句', async () => {
    const { posts } = mount({ trial: [], kept: [], retired: [GONE] });
    await screen.findByText('12 点不打电话');
    expect(screen.getByText(/撤错了点「恢复」/u)).toBeTruthy();
    expect(screen.queryByRole('button', { name: '撤掉' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '恢复' }));
    await waitFor(() => expect(posts).toEqual([{ path: '/habits/restore', body: { id: GONE.id } }]));
    expect(await screen.findByText(/重新试用,下一次同类的事照常验证/u)).toBeTruthy();
    await waitFor(() => expect(screen.getByRole('button', { name: '撤掉' })).toBeTruthy());
    const log = '## 2026-10-06 试用习惯:12 点不打电话\n- **提议 id**:`时段:12`\n- **她恢复了**:2026-10-07 —— 重新试用,照常验证(习惯 id `时段:12`)\n- **她撤掉了**:2026-10-06 —— 她点了撤掉(习惯 id `时段:12`)\n';
    expect(phoneEvolveLogDigest(`# 进化日志\n\n${log}`, 5)[0]?.latest).toBe('她恢复了:2026-10-07 —— 重新试用,照常验证');
  });
});
