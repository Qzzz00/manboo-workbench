/**
 * 已有项目拉齐(2026-09-24):扫描进度多一种 `phase:'read'`(她拿到点头之后读那个项目的说明和最近记录,`current` = 项目名)。
 * 手机两处(文字引导页、引导通话页)那一行显示「正在读 X 的说明…」(名字太长只说「正在读它的说明…」,375 宽整句看得见)、球进执行中;
 * 2026-09-24 傍晚起(卡 fix/scan-orb-working-whole-wait)那一行跟着「那一整段等待」走:读完了、她还没开口时照样是读的那一句
 * (服务端 held 的那一份,或者收了之后凭 `last_read`);认不得的 phase 照「正在找你的项目… <current>」退化。
 * 与电脑端 workbench-plugin/tests/client-onboarding-read-line.test.tsx 口径一致。
 */
import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  EMPTY_REPLY_WINDOW, SCAN_LINE, nextReplyWindow, scanLineOf, scanProgressOf, scanReadLine, settledScanOf,
} from '../src/onboarding/scanHold';
import { OnboardingPage } from '../src/onboarding/OnboardingPage';
import type { OnboardingApi, TurnsResult } from '../src/onboarding/onboardingApi';
import { openSession, SessionContext, type Session } from '../src/session';
import { SettingsContext } from '../src/settings/SettingsContext';
import { createSettingsStore, DEFAULT_SETTINGS } from '../src/settings/settingsStore';
import type { KeyValueStore } from '../src/api/tokenStore';
import { CallOverlay } from '../src/call/CallOverlay';
import { useCall } from '../src/call/useCall';
import type { CallClient, CallEvents } from '../src/call/rtcCall';
import type { CallApi } from '../src/api/call';
import { fakeChannel } from './wbchFakes';

vi.mock('voice-glow', () => ({ VoiceBeam: ({ children }: { children?: unknown }) => children }));
vi.mock('../src/aiboo/lipsyncPlayer', () => ({ playAudioBlob: async (_b: Blob, _m: () => void, onEnded?: () => void) => { onEnded?.(); }, stopSpeaking: () => {}, isSpeaking: () => false }));

afterEach(() => { vi.useRealTimers(); });

const READ_LINE = '正在读 desktop-workbench 的说明…';

describe('read 那一行(纯函数)', () => {
  it('读回包:phase read 与 last_read 都认;文案与电脑端同一句', () => {
    expect(scanProgressOf({ scan: { scanning: true, phase: 'read', done: 0, current: 'desktop-workbench' } }))
      .toEqual({ scanning: true, phase: 'read', done: 0, current: 'desktop-workbench' });
    expect(scanProgressOf({ scan: { scanning: false, done: 0, finished_at: '2026-09-24T05:00:00.000Z', last_read: 'desktop-workbench' } }))
      .toEqual({ scanning: false, done: 0, finishedAt: Date.parse('2026-09-24T05:00:00.000Z'), lastRead: 'desktop-workbench' });
    expect(scanLineOf({ scanning: true, phase: 'read', current: 'desktop-workbench' })).toBe(READ_LINE);
    expect(scanReadLine()).toBe('正在读它的说明…');
    expect(READ_LINE).not.toContain('她');
  });

  it('375 宽也整句看得见:名字太长(显示宽度 > 24,中文算 2)就只说「正在读它的说明…」', () => {
    expect(scanReadLine('abcdefghijklmnopqrstuvwx')).toBe('正在读 abcdefghijklmnopqrstuvwx 的说明…');
    expect(scanReadLine('abcdefghijklmnopqrstuvwxy')).toBe('正在读它的说明…');
    expect(scanReadLine('一二三四五六七八九十一二')).toBe('正在读 一二三四五六七八九十一二 的说明…');
    expect(scanReadLine('一二三四五六七八九十一二三')).toBe('正在读它的说明…');
    // 最长的那一句也在 40 个显示宽度以内(14px 字、335px 可用宽,一行放得下)。
    expect(Array.from('正在读 abcdefghijklmnopqrstuvwx 的说明…').reduce((w, ch) => w + (/[\u4e00-\u9fff…]/.test(ch) ? 2 : 1), 0)).toBeLessThanOrEqual(40);
  });

  it('认不得的 phase 体面退化:照「正在找你的项目… <名字>」显示,不出错', () => {
    const later = scanProgressOf({ scan: { scanning: true, phase: 'summarize', current: 'desktop-workbench' } });
    expect(later?.phase).toBeUndefined();
    expect(scanLineOf(later)).toBe(`${SCAN_LINE} desktop-workbench`);
  });

  it('读完了、她还没开口:服务端 held 那一份照样是读的那一句;收了之后凭 last_read 留在读的那一句', () => {
    expect(scanLineOf(scanProgressOf({ scan: { scanning: true, held: true, phase: 'read', done: 0, current: 'desktop-workbench', id: 1 } }))).toBe(READ_LINE);
    expect(scanLineOf(settledScanOf({ scanning: false, lastRead: 'desktop-workbench' }))).toBe(READ_LINE);
    expect(settledScanOf({ scanning: false, done: 0 })).toBeUndefined();
    const win = [
      { scan: { scanning: true, phase: 'list' as const, id: 1 }, now: 0 },
      { scan: { scanning: false, id: 1, lastRead: 'desktop-workbench' }, now: 1_500 },
    ].reduce((w, s) => nextReplyWindow(w, { her: 'h1', busy: true, ...s }), EMPTY_REPLY_WINDOW);
    expect(win.open).toBe(true);
    expect(scanLineOf(win.shown)).toBe(READ_LINE);
  });
});

function memory(): KeyValueStore {
  const data = new Map<string, string>();
  return { async get(k) { return data.get(k) ?? null; }, async set(k, v) { data.set(k, v); }, async remove(k) { data.delete(k); } };
}

function turnsOf(body: Partial<TurnsResult>): OnboardingApi['turns'] {
  return async (_after: number) => ({ ok: true as const, status: 200, data: { turns: [], busy: true, ended: false, stage: 'projects', done: false, ...body } });
}

describe('两处页面都显示读的那一行、球进执行中', () => {
  it('文字引导页', async () => {
    const api: OnboardingApi = {
      detail: async () => ({ ok: true, status: 200, data: { stage: 'projects', done: false, plan: [], answered: {} } }),
      session: async () => ({ ok: true, status: 200, data: { ok: true, stage: 'projects', session_id: 's1', first_message: '', seed: '你想先把哪个项目交给我?' } }),
      say: async () => ({ ok: true, status: 200, data: { ok: true, session_id: 's1' } }),
      turns: turnsOf({ scan: { scanning: true, phase: 'read', done: 0, current: 'desktop-workbench', id: 1 } }),
      restart: async () => ({ ok: true, status: 200, data: { ok: true, stage: 'opening' } }),
      leader: async (leader) => ({ ok: true, status: 200, data: { ok: true, leader } }),
    };
    const pairing = { token: 't', host: 'h', port: 8791, deviceId: 'd' };
    const fetchImpl = (async () => new Response(JSON.stringify({ error: '没配' }), { status: 503 })) as typeof fetch;
    const session = openSession({ pairing, settings: createSettingsStore(memory()), onUnauthorized: () => {}, unpair: async () => {}, fetchImpl });
    render(
      <SettingsContext.Provider value={{ settings: { ...DEFAULT_SETTINGS, onboarding: 'pending' as const }, update: async () => {} }}>
        <SessionContext.Provider value={session}>
          <OnboardingPage onClose={() => {}} api={api} pollMs={20} />
        </SessionContext.Provider>
      </SettingsContext.Provider>,
    );
    const line = await screen.findByText(READ_LINE);
    expect(line.getAttribute('role')).toBe('status');
    await waitFor(() => expect(document.querySelector('.ba-orb, .ba-particles')?.getAttribute('data-mode')).toBe('working'));
    session.feed.stop();
  });

  it('引导通话页:read_project 一开跑就是「正在读它的说明…」,轮询补上名字;字幕位那一行 + 球在办', async () => {
    let events: CallEvents | null = null;
    const client: CallClient = {
      async start(_o, on) { events = on; on.onPhase('connecting'); },
      hangup: vi.fn(async () => ({ transcript: [] })),
      setMuted: vi.fn(async () => {}),
    };
    const session: Session = {
      pairing: { token: 'T', host: 'h', port: 8791, deviceId: 'd' },
      client: { json: async () => ({ ok: true, status: 200, data: {} }) } as unknown as Session['client'],
      direct: {} as Session['direct'],
      feed: {} as Session['feed'],
      voice: {} as Session['voice'],
      channel: fakeChannel(),
      call: {
        status: async () => ({ configured: true, checked: true }),
        channelStatus: async () => ({ configured: true, checked: true }),
        record: async () => ({ ok: true, status: 200, data: { id: 't' } }),
      } as unknown as CallApi,
      appearance: {} as Session['appearance'],
      settings: {} as Session['settings'],
      unpair: async () => {},
    };
    let body: Partial<TurnsResult> = { scan: { scanning: false, done: 0, id: 1 } };
    const turns: OnboardingApi['turns'] = async () => ({ ok: true as const, status: 200, data: { turns: [], busy: false, ended: false, stage: 'projects', done: false, ...body } });
    function Harness() {
      const call = useCall({ active: true, createClient: () => client, onEnded: () => {}, scanPollMs: 20, onboardingApi: { turns }, onboarding: { resume: false } });
      return <><span data-testid="orb" data-mode={call.stageMode} /><CallOverlay call={call} /></>;
    }
    render(<SessionContext.Provider value={session}><Harness /></SessionContext.Provider>);
    act(() => { (events as CallEvents | null)?.onPhase('connected'); });
    act(() => { (events as CallEvents | null)?.onTool?.({ tool: 'read_project', state: 'start' }); });
    const first = screen.getByText('正在读它的说明…');
    expect(first.closest('.ba-call__captions')).not.toBeNull();
    expect(screen.getByTestId('orb').getAttribute('data-mode')).toBe('working');
    body = { scan: { scanning: true, phase: 'read', done: 0, current: 'desktop-workbench', id: 2 } };
    expect(await screen.findByText(READ_LINE)).toBeTruthy();
    // 读完了(电话那条路服务端活儿做完就收):那一行留在读的那一句上,球照样在办,直到她开口。
    body = { scan: { scanning: false, done: 0, id: 2, last_read: 'desktop-workbench' } };
    await new Promise((r) => setTimeout(r, 80));
    expect(screen.getByText(READ_LINE)).toBeTruthy();
    expect(screen.getByTestId('orb').getAttribute('data-mode')).toBe('working');
    act(() => { (events as CallEvents | null)?.onButlerSpeech?.(); });
    expect(screen.queryByText(READ_LINE)).toBeNull();
    expect(screen.getByTestId('orb').getAttribute('data-mode')).toBe('idle');
  });
});
