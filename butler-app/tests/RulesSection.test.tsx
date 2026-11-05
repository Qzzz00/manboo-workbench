/**
 * 手机设置 ·「记住的规矩」(2026-09-24 晚,卡 K)。与电脑设置里是同一张表(`GET /butler/rules`)。
 *
 * 盯住四件:
 *   ① 没接规矩表(老工作台 404)→ 整节不出现;
 *   ② 一条一行,带块与日期、试用状态;**不露 id**;
 *   ③ 删 = `POST /butler/rules/remove {id}`;写一条 = `POST /butler/rules {text, channel:'phone'}`;改字 = `/butler/rules/update`;
 *   ④ 删了的在「不再照做的」里,点「恢复」回来。
 */
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { RulesSection, phoneRuleMeta, type PhoneRuleView, type PhoneRulesView } from '../src/settings/RulesSection';
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

const BLUE: PhoneRuleView = {
  id: 'rule:不要蓝', text: '不要蓝(球的「完成」色也不要)', area: 'ui', status: 'active', origin: 'said',
  evidence: [{ channel: 'call', at: '2026-09-24T12:00:00.000Z', text: '不要蓝' }], created_at: '2026-09-24T12:00:00.000Z', editable: true,
};
const TRIAL: PhoneRuleView = { ...BLUE, id: 'rule:颜色太跳', text: '按钮颜色太跳,换灰色', status: 'trial', origin: 'repeated' };
const GONE: PhoneRuleView = { ...BLUE, id: 'rule:只做深色', text: '只做深色', status: 'removed' };

function mount(view: PhoneRulesView | 'off') {
  const posts: { path: string; body: Record<string, unknown> }[] = [];
  const pairing = { token: 't', host: 'h', port: 8791, deviceId: 'd' };
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const path = url.slice(url.indexOf('/', 'http://'.length));
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (path === '/butler/rules' && (init?.method ?? 'GET') === 'GET') return view === 'off' ? json({ error: '规矩表未启用' }, 404) : json(view);
    if (path.startsWith('/butler/rules')) {
      posts.push({ path, body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> });
      return json({ ok: true, note: '好了。' });
    }
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
  const rendered = render(<SessionContext.Provider value={session}><RulesSection /></SessionContext.Provider>);
  return { ...rendered, posts };
}

describe('手机设置 · 记住的规矩', () => {
  it('① 老工作台 404 → 整节不出现', async () => {
    const { container } = mount('off');
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(container.textContent).toBe('');
  });

  it('② 一条一行,带块、日期、试用;不露 id', async () => {
    const { container } = mount({ rules: [BLUE, TRIAL], retired: [] });
    expect(await screen.findByText('不要蓝(球的「完成」色也不要)')).toBeTruthy();
    expect(screen.getAllByText(/界面 · 2026-09-24/u).length).toBe(2);
    expect(screen.getByText(/试用中/u)).toBeTruthy();
    expect(container.textContent).not.toContain('rule:');
  });

  it('③ 删、写一条、改字:打对的路', async () => {
    const { posts } = mount({ rules: [BLUE], retired: [] });
    await screen.findByText('不要蓝(球的「完成」色也不要)');
    fireEvent.click(screen.getByRole('button', { name: '删' }));
    await waitFor(() => expect(posts).toContainEqual({ path: '/butler/rules/remove', body: { id: 'rule:不要蓝' } }));
    fireEvent.change(screen.getByLabelText('写一条新规矩'), { target: { value: '以后派活先截图给我看' } });
    fireEvent.click(screen.getByRole('button', { name: '记下' }));
    await waitFor(() => expect(posts).toContainEqual({ path: '/butler/rules', body: { text: '以后派活先截图给我看', channel: 'phone' } }));
    fireEvent.click(await screen.findByRole('button', { name: '改' }));
    fireEvent.change(screen.getByLabelText('改这条规矩'), { target: { value: '不要蓝' } });
    fireEvent.click(screen.getByRole('button', { name: '存' }));
    await waitFor(() => expect(posts).toContainEqual({ path: '/butler/rules/update', body: { id: 'rule:不要蓝', text: '不要蓝' } }));
  });

  it('④ 删了的能恢复', async () => {
    const { posts } = mount({ rules: [BLUE], retired: [GONE] });
    fireEvent.click(await screen.findByRole('button', { name: '不再照做的(1)' }));
    fireEvent.click(screen.getByRole('button', { name: '恢复' }));
    await waitFor(() => expect(posts).toContainEqual({ path: '/butler/rules/restore', body: { id: 'rule:只做深色' } }));
  });

  it('那一小行', () => {
    expect(phoneRuleMeta(BLUE)).toBe('界面 · 2026-09-24');
    expect(phoneRuleMeta(TRIAL)).toBe('界面 · 2026-09-24 · 试用中');
  });
});
