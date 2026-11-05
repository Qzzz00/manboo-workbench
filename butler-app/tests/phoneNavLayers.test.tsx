/**
 * 系统返回键在页里那几层上怎么走(2026-09-24,卡 fix/phone-nav-back,维护者拍板)。
 *
 *   - **通话中划返回不挂断**(防误挂;挂断只靠挂断键):首页那一通、引导那一通都一样。
 *     字幕面板开着时先收字幕面板,电话照常;
 *   - 会议**录着(含暂停)不走**,没在录时回首页 —— 同左上角那颗「‹」;
 *   - 引导打字页 → 回首页(OnboardingCall 的 onClose);
 *   - 输入框的底部抽屉开着 → 先收它。
 *
 * 「按返回」在这里就是 `stack.dispatch()`:App 那一层装的 Capacitor 监听做的也正是这一下
 * (谁都不接才退到后台,见 tests/phoneNav.test.tsx)。
 */
import { testMeetingController } from './meetingFakes';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { createBackStack, type BackStack } from '../src/nav/backStack';
import { BackProvider } from '../src/nav/back';
import { OnboardingCall } from '../src/onboarding/OnboardingCall';
import type { OnboardingApi } from '../src/onboarding/onboardingApi';
import { StagePage } from '../src/stage/StagePage';
import { MeetingPage } from '../src/meeting/MeetingPage';
import { PhoneComposer } from '../src/composer/PhoneComposer';
import type { CallClient, CallEvents } from '../src/call/rtcCall';
import { SessionContext, type Session } from '../src/session';
import { SettingsContext } from '../src/settings/SettingsContext';
import { createSettingsStore, DEFAULT_SETTINGS } from '../src/settings/settingsStore';
import { createApiClient, type ApiClient, type ApiResult } from '../src/api/client';
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

afterEach(() => { try { sessionStorage.clear(); } catch { /* jsdom 没有就算了 */ } });

function memory(): KeyValueStore {
  const data = new Map<string, string>();
  return { async get(k) { return data.get(k) ?? null; }, async set(k, v) { data.set(k, v); }, async remove(k) { data.delete(k); } };
}

function fakeFeed(): StateFeed {
  const snapshot: FeedSnapshot = { state: emptyState(), connected: true, error: undefined };
  return { get: () => snapshot, subscribe: () => () => {}, async refresh() {}, stop() {} };
}

function fakeCallClient() {
  let events: CallEvents | null = null;
  const hangup = vi.fn(async () => ({ transcript: [] }));
  const client: CallClient = {
    async start(_options, on) { events = on; on.onPhase('connecting'); },
    hangup,
    setMuted: vi.fn(async () => {}),
    sayText: vi.fn(async () => ({ ok: true as const })),
  };
  return { client, hangup, emit: (fn: (on: CallEvents) => void) => { if (events !== null) fn(events); } };
}

function fakeOnboardingApi(): OnboardingApi {
  const detail = { stage: 'opening', done: false };
  return {
    detail: async () => ({ ok: true, status: 200, data: { plan: [], answered: {}, ...detail } }),
    session: async () => ({ ok: true, status: 200, data: { ok: true, stage: detail.stage, note: '会话未开', first_message: '' } }),
    say: async () => ({ ok: true, status: 200, data: { ok: true, session_id: 's' } }),
    turns: async () => ({ ok: true, status: 200, data: { turns: [], busy: false, ended: false, stage: detail.stage, done: detail.done } }),
    restart: async () => ({ ok: true, status: 200, data: { ok: true, stage: 'opening' } }),
    leader: async () => ({ ok: true, status: 200, data: { ok: true, leader: 'phone' } }),
  };
}

/** 一份假会话 + 那一条返回链。`status` 是通话链路配没配。 */
function shell(status: RtcStatus, children: ReactNode): { stack: BackStack; ui: ReactNode } {
  const pairing = { token: 't', host: 'h', port: 8791, deviceId: 'd' };
  const fetchImpl = (async () => new Response(JSON.stringify({ error: '没配' }), { status: 503 })) as typeof fetch;
  const client = createApiClient({ pairing, fetchImpl, onUnauthorized: () => {} });
  const answer = async () => status;
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
  const stack = createBackStack();
  return {
    stack,
    ui: (
      <BackProvider stack={stack}>
        <SettingsContext.Provider value={{ settings: DEFAULT_SETTINGS, update: async () => {} }}>
          <SessionContext.Provider value={session}>
            <AvatarContext.Provider value={avatar}>{children}</AvatarContext.Provider>
          </SessionContext.Provider>
        </SettingsContext.Provider>
      </BackProvider>
    ),
  };
}

/** 按一下系统返回。回 true = 页里有一层接了(false 就轮到 App 那一层:退到后台)。 */
function pressBack(stack: BackStack): boolean {
  let took = false;
  act(() => { took = stack.dispatch(); });
  return took;
}

const CONFIGURED: RtcStatus = { configured: true, checked: true };

describe('★通话中划返回不挂断', () => {
  it('引导那一通:返回被接住,电话还在,挂断没被调', async () => {
    const fake = fakeCallClient();
    const onClose = vi.fn();
    const { stack, ui } = shell(CONFIGURED, <OnboardingCall onClose={onClose} api={fakeOnboardingApi()} createCallClient={() => fake.client} />);
    render(ui);
    await screen.findByText('正在接通…');
    act(() => { fake.emit((on) => on.onPhase('connected')); });
    await waitFor(() => expect(screen.getByRole('button', { name: '挂断' })).toBeTruthy());

    expect(pressBack(stack)).toBe(true);
    expect(pressBack(stack)).toBe(true);
    expect(fake.hangup).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(document.querySelector('.ba-scene')?.getAttribute('data-call')).toBe('true');
    expect(screen.getByRole('button', { name: '挂断' })).toBeTruthy();
  });

  it('字幕面板开着:返回先收字幕面板,电话照常;再按还是不挂', async () => {
    const fake = fakeCallClient();
    const { stack, ui } = shell(CONFIGURED, <OnboardingCall onClose={() => {}} api={fakeOnboardingApi()} createCallClient={() => fake.client} />);
    render(ui);
    await screen.findByText('正在接通…');
    act(() => { fake.emit((on) => on.onPhase('connected')); });
    fireEvent.click(await screen.findByRole('button', { name: '显示字幕' }));
    expect(screen.getByLabelText('字幕')).toBeTruthy();

    expect(pressBack(stack)).toBe(true);
    expect(screen.queryByLabelText('字幕')).toBeNull();
    expect(screen.getByRole('button', { name: '显示字幕' })).toBeTruthy();
    expect(pressBack(stack)).toBe(true);
    expect(fake.hangup).not.toHaveBeenCalled();
  });

  it('没接通(红键已经变成「关闭」):没有电话可挂,返回 = 按「关闭」,回首页', async () => {
    const fake = fakeCallClient();
    const onClose = vi.fn();
    const { stack, ui } = shell(CONFIGURED, <OnboardingCall onClose={onClose} api={fakeOnboardingApi()} createCallClient={() => fake.client} />);
    render(ui);
    await screen.findByText('正在接通…');
    // 还在接通:不动
    expect(pressBack(stack)).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
    act(() => { fake.emit((on) => on.onPhase('error', { error: '房间里没有工人' })); });
    await waitFor(() => expect(screen.getByRole('button', { name: '关闭' })).toBeTruthy());
    expect(pressBack(stack)).toBe(true);
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('首页那一通(点通话键打的):返回被接住、不挂断;挂断键照样能挂', async () => {
    const fake = fakeCallClient();
    const { stack, ui } = shell(CONFIGURED, <StagePage createCallClient={() => fake.client} callTickMs={10} />);
    render(ui);
    // 通话键在输入框右下角(没内容时那颗就是通话键)
    const callKey = await screen.findByRole('button', { name: /^通话/ });
    await waitFor(() => expect((callKey as HTMLButtonElement).disabled).toBe(false));
    // 没在通话:首页上谁都不接(→ App 那一层退到后台)
    expect(pressBack(stack)).toBe(false);
    fireEvent.click(callKey);
    await screen.findByText('正在接通…');
    act(() => { fake.emit((on) => on.onPhase('connected')); });

    expect(pressBack(stack)).toBe(true);
    expect(fake.hangup).not.toHaveBeenCalled();
    expect(document.querySelector('.ba-scene')?.getAttribute('data-call')).toBe('true');

    await act(async () => { screen.getByRole('button', { name: '挂断' }).click(); });
    await waitFor(() => expect(fake.hangup).toHaveBeenCalledTimes(1));
  });
});

describe('引导打字页', () => {
  it('★通话打不了、退回打字那一版:返回 = 回首页(onClose)', async () => {
    const onClose = vi.fn();
    const { stack, ui } = shell({ configured: false, checked: true, reason: '电脑上的工人没在跑' }, <OnboardingCall onClose={onClose} api={fakeOnboardingApi()} />);
    render(ui);
    await waitFor(() => expect(document.querySelector('.ba-onboarding')).toBeTruthy());
    expect(pressBack(stack)).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('首页上开着的一层先收', () => {
  it('对话记录那一页开着:返回先收它;收了之后首页上谁都不接', async () => {
    const { stack, ui } = shell({ configured: false, checked: true }, <StagePage />);
    render(ui);
    fireEvent.click(await screen.findByRole('button', { name: '记录' }));
    expect(document.querySelector('.ba-scene__log')).toBeTruthy();
    expect(pressBack(stack)).toBe(true);
    expect(document.querySelector('.ba-scene__log')).toBeNull();
    expect(pressBack(stack)).toBe(false);
  });

  it('输入框的底部抽屉(「+」那一层)开着:返回先收它', async () => {
    const stack = createBackStack();
    render(
      <BackProvider stack={stack}>
        <PhoneComposer
          trim="phone-home"
          placeholder="说点什么…"
          ariaLabel="打字说给事务官"
          onSubmit={() => true}
          api={{ loadOptions: async () => ({ error: '先不用' }), saveChoice: async () => true, upload: async () => ({ ok: false, error: '先不用' }) }}
        />
      </BackProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: '添加' }));
    expect(screen.getByRole('dialog', { name: '添加' })).toBeTruthy();
    expect(pressBack(stack)).toBe(true);
    expect(screen.queryByRole('dialog', { name: '添加' })).toBeNull();
    expect(pressBack(stack)).toBe(false);
  });
});

describe('会议', () => {
  /** 只认开会那几条路由的假电脑。 */
  function desk(): ApiClient {
    return {
      baseUrl: 'http://127.0.0.1:8791',
      async json<T>(path: string): Promise<ApiResult<T>> {
        if (path === '/meeting/start') return { ok: true, status: 200, data: { ok: true, id: 'm1', dir: '/x' } as T };
        return { ok: true, status: 200, data: { ok: true } as T };
      },
      async blob(): Promise<ApiResult<Blob>> { return { ok: false, status: 404, kind: 'http', error: '用不到' }; },
    } as ApiClient;
  }
  function recorder() {
    const log: string[] = [];
    const plugin = {
      start: async () => { log.push('start'); return {}; },
      pause: async () => { log.push('pause'); },
      resume: async () => { log.push('resume'); },
      stop: async () => { log.push('stop'); },
      level: async () => ({ level: 0.4 }),
      addListener: async () => ({ remove: async () => {} }),
    };
    return { log, deps: { native: { ...plugin, status: async () => ({ recording: false }) } as never, stopGraceMs: 10 } };
  }
  function mount(onClose: () => void) {
    const rec = recorder();
    const direct = desk();
    const stack = createBackStack();
    render(
      <BackProvider stack={stack}>
        <SessionContext.Provider value={{ direct } as unknown as Session}>
          <MeetingPage
            onClose={onClose}
            controller={testMeetingController({ direct, recorderDeps: rec.deps })}
            pollMs={10}
            tickMs={20}
          />
        </SessionContext.Provider>
      </BackProvider>,
    );
    return { stack, rec };
  }

  it('★没在录:顶上「‹ 会议」,返回 = 回首页', () => {
    const onClose = vi.fn();
    const { stack } = mount(onClose);
    expect(screen.getByRole('heading', { name: '会议' })).toBeTruthy();
    expect(pressBack(stack)).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('★录着(含暂停):返回被接住、不走,录音不停;顶上只剩页名,没有「‹」', async () => {
    const onClose = vi.fn();
    const { stack, rec } = mount(onClose);
    await act(async () => { screen.getByRole('button', { name: '开始录' }).click(); });
    await waitFor(() => expect(screen.getByRole('button', { name: '结束' })).toBeTruthy());
    expect(screen.getByRole('heading', { name: '会议' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '返回' })).toBeNull();

    expect(pressBack(stack)).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => { screen.getByRole('button', { name: '暂停' }).click(); });
    expect(pressBack(stack)).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
    expect(rec.log).not.toContain('stop');
  });
});
