import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App } from '../src/App';
import type { Pairing, KeyValueStore } from '../src/api/tokenStore';
import { createTokenStore } from '../src/api/tokenStore';
import { createSettingsStore } from '../src/settings/settingsStore';
import { createAccountStore } from '../src/account/accountStore';

vi.mock('@capacitor/app', () => ({
  App: { getLaunchUrl: async () => ({ url: '' }), addListener: async () => ({ remove: async () => {} }) },
}));
vi.mock('capacitor-zeroconf', () => ({ ZeroConf: { watch: async () => { throw new Error('web'); }, unwatch: async () => {}, close: async () => {} } }));

function memory(): KeyValueStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, async get(key) { return data.get(key) ?? null; }, async set(key, value) { data.set(key, value); }, async remove(key) { data.delete(key); } };
}

const pairingFile = process.env.COLLAB_1C_PAIRED_SESSION;
const realPairedAppIt = it.skipIf(pairingFile === undefined || pairingFile === '');
const realSuggestActionIt = it.skipIf(pairingFile === undefined || pairingFile === '' || process.env.COLLAB_1C_SUGGEST_ACTION !== '1');

afterEach(() => { cleanup(); try { sessionStorage.clear(); } catch { /* jsdom */ } });

describe('real paired production App → isolated workbench API', () => {
  realPairedAppIt('posts phone text through the production home composer and renders the actual say.screen', async () => {
    const pairing = JSON.parse(readFileSync(pairingFile!, 'utf8')) as Pairing;
    const settingsKv = memory();
    settingsKv.data.set('butler.settings', JSON.stringify({
      voiceEnabled: true, avatarId: null, onboarding: 'done', stage: 'particles', callProvider: 'livekit', ringStandby: false,
    }));
    let sayResponse: Record<string, unknown> | undefined;
    const realFetch: typeof fetch = async (input, init) => {
      const response = await fetch(input, init);
      const url = String(input);
      if (url.endsWith('/butler/say') && (init?.method ?? 'GET') === 'POST') {
        sayResponse = await response.clone().json() as Record<string, unknown>;
      }
      return response;
    };
    const previousWidth = window.innerWidth;
    const viewportWidth = Number(process.env.COLLAB_1C_VIEWPORT ?? '375');
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: viewportWidth });
    const pairedKv = memory();
    const view = render(<App
      tokenStore={{ ...createTokenStore(pairedKv), async load() { return pairing; } }}
      settingsStore={createSettingsStore(settingsKv)}
      accountStore={createAccountStore(memory())}
      fetchImpl={realFetch}
    />);
    try {
      expect(await screen.findByLabelText('记录', {}, { timeout: 10_000 })).toBeTruthy();
      expect(document.querySelector('.ba-scene__dock textarea')).toBeTruthy();
      const input = await screen.findByLabelText('打字说给事务官');
      fireEvent.change(input, { target: { value: '记一下 1c 手机真实配对应用链路验收' } });
      fireEvent.click(screen.getByRole('button', { name: '发送' }));
      await waitFor(() => expect(sayResponse).toBeDefined(), { timeout: 15_000 });
      const say = sayResponse?.say as { screen?: unknown } | undefined;
      expect(typeof say?.screen).toBe('string');
      expect(String(say?.screen)).not.toBe('');
      fireEvent.click(screen.getByLabelText('记录'));
      await waitFor(() => expect(screen.getAllByText(String(say?.screen)).length).toBeGreaterThan(0));
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(viewportWidth);
    } finally {
      view.unmount();
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: previousWidth });
    }
  }, 30_000);

  realSuggestActionIt('renders a model-produced suggest and applies default keep through the production phone card', async () => {
    const pairing = JSON.parse(readFileSync(pairingFile!, 'utf8')) as Pairing;
    const settingsKv = memory();
    settingsKv.data.set('butler.settings', JSON.stringify({
      voiceEnabled: true, avatarId: null, onboarding: 'done', stage: 'particles', callProvider: 'livekit', ringStandby: false,
    }));
    const responses: { status: number; request: Record<string, unknown>; body: Record<string, unknown> }[] = [];
    const realFetch: typeof fetch = async (input, init) => {
      const response = await fetch(input, init);
      if (String(input).endsWith('/butler/say') && init?.method === 'POST') {
        responses.push({ status: response.status, request: JSON.parse(String(init.body)) as Record<string, unknown>, body: await response.clone().json() as Record<string, unknown> });
      }
      return response;
    };
    const pairedKv = memory();
    const view = render(<App
      tokenStore={{ ...createTokenStore(pairedKv), async load() { return pairing; } }}
      settingsStore={createSettingsStore(settingsKv)}
      accountStore={createAccountStore(memory())}
      fetchImpl={realFetch}
    />);
    try {
      expect(await screen.findByLabelText('记录', {}, { timeout: 10_000 })).toBeTruthy();
      const prompts = [
        '把之前那件样片工作整理一下，先别派，建议我让谁开始处理。',
        '我有一项不太确定怎么分工的材料整理，请先记下并给我一个负责人建议。',
        '先记住这项需要整理的客户资料，分给谁比较合适请给建议，暂时不要开始。',
      ];
      let suggested: Record<string, unknown> | undefined;
      for (const [index, prompt] of prompts.entries()) {
        const input = screen.getByLabelText('打字说给事务官');
        fireEvent.change(input, { target: { value: prompt } });
        fireEvent.click(screen.getByRole('button', { name: '发送' }));
        await waitFor(() => expect(responses).toHaveLength(index + 1), { timeout: 120_000 });
        if (responses[index]?.body.suggest !== undefined) { suggested = responses[index]!.body; break; }
      }
      expect(suggested, `model did not return a suggest in ${responses.length} variants`).toBeDefined();
      const suggestion = suggested!.suggest as { suggest_id: string; default_action: string; options: { id: string; label: string }[] };
      const originalItem = (suggested!.items as { card_id?: string }[]).find(one => typeof one.card_id === 'string');
      expect(typeof originalItem?.card_id).toBe('string');
      expect(suggestion.default_action).toBe('keep');
      fireEvent.click(screen.getByLabelText('记录'));
      const actionCount = responses.length + 1;
      fireEvent.click(await screen.findByRole('button', { name: '按建议默认处理' }));
      await waitFor(() => expect(responses).toHaveLength(actionCount), { timeout: 120_000 });
      const action = responses[responses.length - 1]!;
      expect(action.status, JSON.stringify({ request: action.request, response: action.body })).toBe(200);
      expect(action.request.ctx).toMatchObject({ suggest: { suggest_id: suggestion.suggest_id, choice: 'keep' } });
      expect((action.body.items as { card_id?: string }[])[0]?.card_id).toBe(originalItem?.card_id);
      expect(typeof (action.body.say as { screen?: unknown } | undefined)?.screen).toBe('string');
      const stateResponse = await fetch(`http://${pairing.host}:${pairing.port}/state`, { headers: { authorization: `Bearer ${pairing.token}`, origin: `http://${pairing.host}:${pairing.port === 9692 ? 3893 : pairing.port}` } });
      const state = await stateResponse.json() as { tasks?: { tasks?: { id: string; status: string; dispatch?: unknown }[] } };
      const originalState = state.tasks?.tasks?.find(one => one.id === originalItem?.card_id);
      expect(originalState?.status).toBe('todo');
      expect(originalState?.dispatch).toBeUndefined();
    } finally {
      view.unmount();
    }
  }, 300_000);
});
