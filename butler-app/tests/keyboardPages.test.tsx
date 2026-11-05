/**
 * 弹键盘时粒子球不缩 —— 三页同一个规矩(卡 fix/phone-keyboard-orb-stable,维护者拍板第 2 条)。
 *
 * 首页(舞台底部的统一输入框)、通话页字幕面板里的打字框、引导的打字兜底页:
 * 挂真组件 + 装上 keyboardViewport,点那一页的输入框、模拟键盘弹起(视口 986 → 560 + keyboardHeight 426),
 * 三页都要:布局高度仍是 986(球那一格不动)、输入框抬 426;收起后 html 上什么都不留。
 * jsdom 不排版,球的真尺寸在真 Chrome 里量(见交接文档);这里钉的是三页都接上了同一套。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { installKeyboardViewport } from '../src/viewport/keyboardViewport';
import { StagePage } from '../src/stage/StagePage';
import { OnboardingPage } from '../src/onboarding/OnboardingPage';
import type { OnboardingApi, OnboardingTurn } from '../src/onboarding/onboardingApi';
import { SessionContext, openSession, type Session } from '../src/session';
import { SettingsContext } from '../src/settings/SettingsContext';
import { createSettingsStore, DEFAULT_SETTINGS } from '../src/settings/settingsStore';
import { createApiClient } from '../src/api/client';
import { createVoiceApi } from '../src/api/voice';
import { createCallApi } from '../src/api/call';
import { createAppearanceFeed } from '../src/swarm/appearance';
import { emptyState } from '../src/api/protocol';
import type { FeedSnapshot, StateFeed } from '../src/api/stateFeed';
import { AvatarContext } from '../src/live2d/AvatarContext';
import { NO_AVATAR_TEXT, type AvatarState } from '../src/live2d/useAvatar';
import type { CallClient, CallEvents } from '../src/call/rtcCall';
import type { KeyValueStore } from '../src/api/tokenStore';
import { fakeChannel, fakeRouted } from './wbchFakes';

vi.mock('../src/aiboo/lipsyncPlayer', () => ({ playAudioBlob: async (_b: Blob, _m: () => void, onEnded?: () => void) => { onEnded?.(); }, stopSpeaking: () => {}, isSpeaking: () => false }));

const html = document.documentElement;
const v = (name: string) => html.style.getPropertyValue(name);
let dispose: (() => void) | null = null;

function setViewport(width: number, height: number): void {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: height });
}
function keyboard(open: boolean): void {
  const ev = new Event(open ? 'keyboardWillShow' : 'keyboardWillHide') as Event & { keyboardHeight?: number };
  if (open) ev.keyboardHeight = 426;
  act(() => {
    window.dispatchEvent(ev);
    setViewport(443, open ? 560 : 986);
    window.dispatchEvent(new Event('resize'));
  });
}

function memory(): KeyValueStore {
  const data = new Map<string, string>();
  return { async get(k) { return data.get(k) ?? null; }, async set(k, val) { data.set(k, val); }, async remove(k) { data.delete(k); } };
}
const pairing = { token: 't', host: 'h', port: 8791, deviceId: 'd' };
const fetchImpl = (async () => new Response(JSON.stringify({ error: '没配' }), { status: 503 })) as typeof fetch;

function staticFeed(): StateFeed {
  const snapshot: FeedSnapshot = { state: emptyState(), connected: true, error: undefined };
  return { get: () => snapshot, subscribe: () => () => {}, async refresh() {}, stop() {} };
}
function stageSession(): Session {
  const client = createApiClient({ pairing, fetchImpl, onUnauthorized: () => {} });
  const ready = async () => ({ configured: true, checked: true });
  return {
    pairing,
    client: fakeRouted(client, 'direct'),
    direct: client,
    feed: staticFeed(),
    voice: createVoiceApi(client),
    call: { ...createCallApi(client), status: ready, channelStatus: ready },
    channel: fakeChannel({}),
    appearance: createAppearanceFeed(client),
    settings: createSettingsStore(memory()),
    unpair: async () => {},
  };
}
const avatar: AvatarState = { status: 'placeholder', note: NO_AVATAR_TEXT, avatars: [] };
const settings = { ...DEFAULT_SETTINGS, voiceEnabled: true, onboarding: 'done' as const };

function mountStage(page: ReactElement) {
  return render(
    <SettingsContext.Provider value={{ settings, update: async () => {} }}>
      <SessionContext.Provider value={stageSession()}>
        <AvatarContext.Provider value={avatar}>{page}</AvatarContext.Provider>
      </SessionContext.Provider>
    </SettingsContext.Provider>,
  );
}

/** 三页共用的那一串:点输入框 → 键盘起来 → 看数 → 收起 → 什么都不留。 */
function expectSameRule(input: HTMLElement, page: Element): void {
  expect(page.getAttribute('data-ba-kb-page')).not.toBeNull();
  act(() => { input.focus(); });
  expect(html.getAttribute('data-ba-kb')).toBe('hold');
  keyboard(true);
  expect(html.getAttribute('data-ba-kb')).toBe('up');
  // 布局按没弹键盘时的 986 排(球那一格的尺寸全从这里来),输入框抬键盘那么高。
  expect(v('--ba-app-h')).toBe('986px');
  expect(v('--ba-vh')).toBe('9.86px');
  expect(v('--ba-kb-shift')).toBe('426px');
  keyboard(false);
  act(() => { input.blur(); });
  expect(html.hasAttribute('data-ba-kb')).toBe(false);
  expect(v('--ba-app-h')).toBe('');
}

beforeEach(() => {
  setViewport(443, 986);
  dispose = installKeyboardViewport(window);
});
afterEach(() => {
  dispose?.();
  dispose = null;
  try { sessionStorage.clear(); } catch { /* jsdom 没有就算了 */ }
});

describe('三页同一个规矩', () => {
  it('★首页:底部统一输入框', async () => {
    mountStage(<StagePage />);
    await act(async () => {});
    const scene = document.querySelector('.ba-scene')!;
    // 球那一格是量高度的那一格(键盘开着时钉住它)。
    expect(scene.querySelector('.ba-scene__orb')?.getAttribute('data-ba-kb-anchor')).toBe('orb');
    expectSameRule(screen.getByLabelText('打字说给事务官'), scene);
  });

  it('★通话页:字幕面板里的打字框(面板贴底)', async () => {
    let events: CallEvents | null = null;
    const client: CallClient = {
      async start(_options, on) { events = on; on.onPhase('connecting'); },
      async hangup() { return { transcript: [] }; },
      async setMuted() {},
      async sayText() { return { ok: true as const }; },
    };
    mountStage(<StagePage onboarding={{ resume: false, onExit: () => {} }} createCallClient={() => client} callTickMs={10} />);
    await waitFor(() => expect(events).not.toBeNull());
    act(() => { events!.onPhase('connected'); });
    fireEvent.click(await screen.findByRole('button', { name: '显示字幕' }));
    const panel = document.querySelector('.ba-call__subtitles')!;
    expect(panel.getAttribute('data-ba-kb-stick')).toBe('bottom');
    expectSameRule(await screen.findByLabelText('打字回答'), document.querySelector('.ba-scene[data-call="true"]')!);
  });

  it('★引导打字兜底页:输入行(对话流贴底)', async () => {
    const turns: OnboardingTurn[] = [{ seq: 1, role: 'assistant', text: '你希望我怎么称呼你?', at: 't', kind: 'seed' }];
    const api: OnboardingApi = {
      async detail() { return { ok: true, status: 200, data: { stage: 'opening', done: false, plan: ['opening', 'done'], answered: {} } }; },
      async session() { return { ok: true, status: 200, data: { ok: true, stage: 'opening', session_id: 's1', first_message: 'seed', seed: '你希望我怎么称呼你?', resumed: false } }; },
      async say() { return { ok: true, status: 200, data: { ok: true, session_id: 's1' } }; },
      async turns(after) { return { ok: true, status: 200, data: { turns: turns.filter((t) => t.seq > after), busy: false, ended: false, stage: 'opening', done: false, session_id: 's1' } }; },
      async restart() { return { ok: true, status: 200, data: { ok: true, stage: 'opening' } }; },
      async leader(leader) { return { ok: true, status: 200, data: { ok: true, leader } }; },
    };
    const store = createSettingsStore(memory());
    const session = openSession({ pairing, settings: store, onUnauthorized: () => {}, unpair: async () => {}, fetchImpl });
    render(
      <SettingsContext.Provider value={{ settings: { ...settings, onboarding: 'pending' }, update: async () => {} }}>
        <SessionContext.Provider value={session}>
          <OnboardingPage onClose={() => {}} api={api} pollMs={20} />
        </SessionContext.Provider>
      </SettingsContext.Provider>,
    );
    const input = await screen.findByLabelText('回答事务官');
    const page = document.querySelector('.ba-onboarding')!;
    expect(page.querySelector('.ba-chat__thread')?.getAttribute('data-ba-kb-stick')).toBe('bottom');
    expectSameRule(input, page);
    session.feed.stop();
  });
});
