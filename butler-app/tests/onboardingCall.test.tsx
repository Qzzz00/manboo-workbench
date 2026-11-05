/** 手机兼容入口不再自动通话；回电脑继续，已有完成状态不变。 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { OnboardingCall, DESKTOP_ONBOARDING_NOTE } from '../src/onboarding/OnboardingCall';
import type { OnboardingApi } from '../src/onboarding/onboardingApi';
import type { CallClient, CallEvents } from '../src/call/rtcCall';
import { SessionContext, type Session } from '../src/session';
import { SettingsContext } from '../src/settings/SettingsContext';
import { createSettingsStore, DEFAULT_SETTINGS } from '../src/settings/settingsStore';
import { createApiClient } from '../src/api/client';
import { createVoiceApi } from '../src/api/voice';
import { createCallApi, type RtcStatus } from '../src/api/call';
import { createAppearanceFeed } from '../src/swarm/appearance';
import { emptyState } from '../src/api/protocol';
import type { FeedSnapshot, StateFeed } from '../src/api/stateFeed';
import { AvatarContext } from '../src/live2d/AvatarContext';
import { NO_AVATAR_TEXT, type AvatarState } from '../src/live2d/useAvatar';
import type { KeyValueStore } from '../src/api/tokenStore';
import { fakeChannel, fakeRouted } from './wbchFakes';

vi.mock('../src/aiboo/lipsyncPlayer', () => ({ playAudioBlob: async (_b: Blob, _m: () => void, onEnded?: () => void) => { onEnded?.(); }, stopSpeaking: () => {}, isSpeaking: () => false }));

function memory(): KeyValueStore {
  const data = new Map<string, string>();
  return { async get(k) { return data.get(k) ?? null; }, async set(k, v) { data.set(k, v); }, async remove(k) { data.delete(k); } };
}

function fakeFeed(): StateFeed {
  const snapshot: FeedSnapshot = { state: emptyState(), connected: true, error: undefined };
  return { get: () => snapshot, subscribe: () => () => {}, async refresh() {}, stop() {} };
}

/** 记下 start 时拿到的选项的假通话客户端。 */
function fakeCallClient() {
  let events: CallEvents | null = null;
  const started: unknown[] = [];
  const hangup = vi.fn(async () => ({ transcript: [] }));
  const client: CallClient = {
    async start(options, on) { started.push(options); events = on; on.onPhase('connecting'); },
    hangup,
    setMuted: vi.fn(async () => {}),
    sayText: vi.fn(async () => ({ ok: true as const })),
  };
  return { client, hangup, started, emit: (fn: (on: CallEvents) => void) => { if (events !== null) fn(events); } };
}

function fakeOnboardingApi(detail: { stage: string; done: boolean; askedAt?: string }): OnboardingApi {
  return {
    detail: async () => ({ ok: true, status: 200, data: { plan: [], answered: {}, ...detail } }),
    session: async () => ({ ok: true, status: 200, data: { ok: true, stage: detail.stage, note: '会话未开', first_message: '' } }),
    say: async () => ({ ok: true, status: 200, data: { ok: true, session_id: 's' } }),
    turns: async () => ({ ok: true, status: 200, data: { turns: [], busy: false, ended: false, stage: detail.stage, done: detail.done } }),
    restart: async () => ({ ok: true, status: 200, data: { ok: true, stage: 'opening' } }),
    leader: async () => ({ ok: true, status: 200, data: { ok: true, leader: 'phone' } }),
  };
}

function mount(options: {
  status: RtcStatus;
  detail?: { stage: string; done: boolean; askedAt?: string };
  onClose?: () => void;
  client?: ReturnType<typeof fakeCallClient>;
  /** 本机设置的更新(看「引导做完了」有没有记进本机标记)。 */
  update?: (patch: Record<string, unknown>) => Promise<void>;
}) {
  const pairing = { token: 't', host: 'h', port: 8791, deviceId: 'd' };
  const fetchImpl = (async () => new Response(JSON.stringify({ error: '没配' }), { status: 503 })) as typeof fetch;
  const client = createApiClient({ pairing, fetchImpl, onUnauthorized: () => {} });
  const answer = async () => options.status;
  const session: Session = {
    pairing,
    client: fakeRouted(client, 'direct'),
    direct: {} as Session['direct'],
    feed: fakeFeed(),
    voice: createVoiceApi(client),
    call: { ...createCallApi(client), status: answer, channelStatus: answer },
    channel: fakeChannel(),
    appearance: createAppearanceFeed(client),
    settings: createSettingsStore(memory()),
    unpair: async () => {},
  };
  const avatar: AvatarState = { status: 'placeholder', note: NO_AVATAR_TEXT, avatars: [] };
  const onClose = options.onClose ?? vi.fn();
  const view = render(
    <SettingsContext.Provider value={{ settings: DEFAULT_SETTINGS, update: options.update ?? (async () => {}) }}>
      <SessionContext.Provider value={session}>
        <AvatarContext.Provider value={avatar}>
          <OnboardingCall
            onClose={onClose}
            api={fakeOnboardingApi(options.detail ?? { stage: 'opening', done: false })}
            {...(options.client === undefined ? {} : { createCallClient: () => options.client!.client })}
          />
        </AvatarContext.Provider>
      </SessionContext.Provider>
    </SettingsContext.Provider>,
  );
  return { view, onClose };
}

afterEach(() => { try { sessionStorage.clear(); } catch { /* jsdom 没有就算了 */ } });

describe('电脑主导引导的手机兼容入口', () => {
  for (const configured of [true, false]) {
    it(`通话配置 ${configured}: 只指引回电脑，不自动通话`, () => {
      const fake = fakeCallClient();
      const onClose = vi.fn();
      mount({ status: { configured, checked: true }, client: fake, onClose });
      expect(screen.getByText(DESKTOP_ONBOARDING_NOTE)).toBeTruthy();
      expect(fake.started).toHaveLength(0);
      expect(screen.queryByLabelText('回答事务官')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: '回主页' }));
      expect(onClose).toHaveBeenCalledOnce();
    });
  }
  it('已完成旧引导不清完成标记或强制重配', () => {
    const update = vi.fn(async () => {});
    const fake = fakeCallClient();
    mount({ status: { configured: true, checked: true }, detail: { stage: 'done', done: true }, client: fake, update });
    expect(fake.started).toHaveLength(0);
    expect(update).not.toHaveBeenCalled();
    expect(screen.getByText(DESKTOP_ONBOARDING_NOTE)).toBeTruthy();
  });
});
