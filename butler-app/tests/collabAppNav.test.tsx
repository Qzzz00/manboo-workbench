/**
 * 协作区装进真壳的走法(2026-10-24,小K):舞台(首页,零改动)→ 事项页 → 协作区 → 返回首页。
 *
 * 首页保护的门:这条用例钉死「进得了协作区,但首页那一屏一颗按钮没多、布局没动」——
 * 协作区入口只在事项页里,stage 的文件一个没碰。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { App } from '../src/App';
import { createTokenStore, type KeyValueStore } from '../src/api/tokenStore';
import { createSettingsStore } from '../src/settings/settingsStore';

vi.mock('@capacitor/app', () => ({
  App: {
    getLaunchUrl: async () => ({ url: '' }),
    addListener: async () => ({ remove: async () => {} }),
  },
}));
vi.mock('capacitor-zeroconf', () => ({ ZeroConf: { watch: async () => { throw new Error('web'); }, unwatch: async () => {}, close: async () => {} } }));

function memory(): KeyValueStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, async get(k) { return data.get(k) ?? null; }, async set(k, v) { data.set(k, v); }, async remove(k) { data.delete(k); } };
}
function jsonRes(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const STATE = {
  now: '2026-10-24T12:00:00+08:00',
  stale: false,
  sessions: [],
  butler_inbox: { items: [] },
  tasks: {
    tasks: [
      {
        id: 't-1', title: '在做的活', status: 'doing', assignee: 'dsh', goal_id: 'goal:a',
        created_at: '2026-10-23T09:00:00+08:00', updated_at: '2026-10-24T09:00:00+08:00',
      },
    ],
    goals: [{ id: 'goal:a', title: '冲刺目标甲', status: 'open', created_at: '2026-10-23T00:00:00+08:00', updated_at: '2026-10-23T00:00:00+08:00' }],
    goal_sprints: [],
    agent_cards: [],
  },
};

function pairedOnboarded(): KeyValueStore & { data: Map<string, string> } {
  const kv = memory();
  kv.data.set('butler.pairing', JSON.stringify({ token: 'T', host: '10.0.0.9', port: 8795, deviceId: 'd1' }));
  kv.data.set('butler.settings', JSON.stringify({ voiceEnabled: true, avatarId: null, onboarding: 'done', stage: 'particles', callProvider: 'livekit' }));
  return kv;
}

afterEach(() => { try { sessionStorage.clear(); } catch { /* jsdom 没有就算了 */ } });

describe('协作区在壳里的走法(首页保护门)', () => {
  it('舞台 → 事项页 → 协作区 → 返回头回首页;首页本体零改动', async () => {
    const kv = pairedOnboarded();
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/state')) return jsonRes(200, STATE);
      if (url.includes('/collab/relay/studio')) return jsonRes(200, { state: 'none' });
      return jsonRes(503, { error: '没配' });
    });
    render(<App tokenStore={createTokenStore(kv)} settingsStore={createSettingsStore(kv)} fetchImpl={fetchImpl as unknown as typeof fetch} />);

    // 首页(舞台)照旧:球 + 输入框,没有协作区的东西混进来。
    expect(await screen.findByLabelText('记录', {}, { timeout: 3000 })).toBeTruthy();
    expect(document.querySelector('.ba-scene')).toBeTruthy();
    // 首页(舞台)那一格里没有协作区的东西(入口只在事项页;隐藏的别的 pane 不算)。
    expect(document.querySelector('.ba-pane--stage')!.textContent).not.toContain('协作区');

    // 首页「正在办」卡整张点下去 → 事项页(同一张卡的既有走法;卡面那颗整张开按钮)。
    await act(async () => { fireEvent.click(await screen.findByLabelText('打开「正在办」', {}, { timeout: 3000 })); });
    expect(await screen.findByText('在做的活', {}, { timeout: 3000 })).toBeTruthy();
    const entry = screen.getByRole('button', { name: /协作区/ });
    expect(entry.textContent).toContain('目标进展');

    // 事项页 → 协作区:目标 tab 拿 /state 的真实目标。
    await act(async () => { fireEvent.click(entry); });
    expect(await screen.findByText('冲刺目标甲', {}, { timeout: 3000 })).toBeTruthy();
    expect(document.querySelector('.ba-collab')).toBeTruthy();
    // 顶部返回头写的是「协作区」(PAGE_TITLES)。
    expect(screen.getByText('冲刺目标甲')).toBeTruthy();

    const collab = within(document.querySelector('.ba-pane--collab') as HTMLElement);
    await act(async () => { fireEvent.click(collab.getByRole('tab', { name: '事项' })); });
    await act(async () => { fireEvent.click(collab.getByText('在做的活', { selector: '.ba-collab__rowtitle' })); });
    await act(async () => { fireEvent.click(await collab.findByRole('button', { name: '打开原事项操作' })); });
    await waitFor(() => expect(document.querySelector('.ba-pane--inbox')?.hasAttribute('hidden')).toBe(false));
    expect(document.querySelector('.ba-pane--collab')?.hasAttribute('hidden')).toBe(true);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /协作区/ })); });
    expect(await screen.findByText('冲刺目标甲')).toBeTruthy();

    // 返回头(左上角 ‹)回首页:舞台原样。
    await act(async () => { fireEvent.click(screen.getAllByLabelText('返回')[0]!); });
    await waitFor(() => expect(document.querySelector('.ba-pane--collab')?.hasAttribute('hidden')).toBe(true));
    expect(document.querySelector('.ba-scene')).toBeTruthy();
    expect(screen.queryByText('冲刺目标甲')).toBeNull();
  }, 15000);
});
