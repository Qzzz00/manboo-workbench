/**
 * 引导里「她在找你的项目」(2026-09-24;傍晚按维护者拍板改成「整段等待」,卡 fix/scan-orb-working-whole-wait)。
 * 拍板:粒子球就是 loading —— 从她开始找项目、读仓库那一刻,到她开口说结果为止,球一直是执行中样子;她一开口就回到说话的样子。
 * 钉住:
 *   1. 那一行字(与电脑端一致)与回包的形状(多 id / held);
 *   2. 文字引导页(DSH 那条路):服务端窗口开着就执行中;**她的新一句出来(朗读开了口)**才回去;中间不闪回;保险时限;
 *   3. 引导通话页:**工具信号当场进**(不等轮询);她跑之前那句「我看一下」不算;`tool_done` 之后她一开口就回去;
 *      信号没来但轮询看到在干照样进;保险时限到了回去;
 *   4. 说话优先(她真在出声就是说话的样子);不是引导那一通不理这些。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import {
  EMPTY_REPLY_WINDOW, nextReplyWindow, REPLY_VOICE_GRACE_MS, REPLY_WINDOW_MAX_MS, SCAN_LINE, SCAN_LIST_LINE, SCAN_READ_FALLBACK,
  scanLineOf, scanProgressOf, withScanMode, type ReplySignals, type ReplyWindow, type ScanProgress,
} from '../src/onboarding/scanHold';
import { CALL_SCAN_IDLE_MAX_MS, EMPTY_CALL_SCAN, nextCallScan, type CallScanEvent, type CallScanWindow } from '../src/onboarding/scanWindow';
import { OnboardingPage } from '../src/onboarding/OnboardingPage';
import type { OnboardingApi, OnboardingTurn, TurnsResult } from '../src/onboarding/onboardingApi';
import { openSession, SessionContext, type Session } from '../src/session';
import { SettingsContext } from '../src/settings/SettingsContext';
import { createSettingsStore, DEFAULT_SETTINGS } from '../src/settings/settingsStore';
import type { KeyValueStore } from '../src/api/tokenStore';
import { CallOverlay } from '../src/call/CallOverlay';
import { useCall } from '../src/call/useCall';
import type { CallClient, CallEvents } from '../src/call/rtcCall';
import type { CallApi } from '../src/api/call';
import { fakeChannel } from './wbchFakes';

// 通话页底边的声音光在 jsdom 里画不了(SVG baseVal),与这里要测的无关:换成只渲染孩子的壳。
vi.mock('voice-glow', () => ({ VoiceBeam: ({ children }: { children?: unknown }) => children }));
vi.mock('../src/aiboo/lipsyncPlayer', () => ({ playAudioBlob: async (_b: Blob, _m: () => void, onEnded?: () => void) => { onEnded?.(); }, stopSpeaking: () => {}, isSpeaking: () => false }));

afterEach(() => { vi.useRealTimers(); });

describe('那一行字与回包', () => {
  it('文案与电脑端一致:list 一句、repos 带数与名字,路径不露用户名', () => {
    expect(scanLineOf({ scanning: true, phase: 'list', done: 0 })).toBe(SCAN_LIST_LINE);
    expect(scanLineOf({ scanning: true, phase: 'repos', done: 12, total: 40, current: '/Users/example/Documents/GitHub/foo' })).toBe(`${SCAN_LINE} 已看 12/40 · …/GitHub/foo`);
    expect(scanLineOf({ scanning: true, done: 5 })).toBe(`${SCAN_LINE} 已看 5 个`);
    expect(scanLineOf({ scanning: true })).toBe('正在找你的项目…');
    expect(SCAN_LIST_LINE).toBe('正在看有哪些文件夹…');
    expect(SCAN_LINE + SCAN_LIST_LINE).not.toContain('她');
  });
  it('读回包:{ scan } 与顶层两种形状,finished_at 读成毫秒,窗口号 id 与 held 读出来;认不出 = undefined', () => {
    expect(scanProgressOf({ scan: { scanning: true, phase: 'repos', done: 3, total: 9, current: ' a ', id: 4 } })).toEqual({ scanning: true, phase: 'repos', done: 3, total: 9, current: 'a', id: 4 });
    expect(scanProgressOf({ scan: { scanning: false, done: 0, finished_at: '2026-09-24T10:00:00.000Z' } })).toEqual({ scanning: false, done: 0, finishedAt: Date.parse('2026-09-24T10:00:00.000Z') });
    expect(scanProgressOf({ scan: { scanning: true, held: true, id: 2 } })).toEqual({ scanning: true, held: true, id: 2 });
    expect(scanProgressOf({ scan: { scanning: true, held: 'yes' } })).toEqual({ scanning: true });
    expect(scanProgressOf({ turns: [], busy: true })).toBeUndefined();
  });
  it('找项目那一整段 → 在办(working);她真在出声时说话优先;不在找原样', () => {
    for (const mode of ['idle', 'listening', 'preparing', 'acknowledging'] as const) expect(withScanMode(mode, true)).toBe('working');
    expect(withScanMode('speaking', true)).toBe('speaking');
    expect(withScanMode('preparing', false)).toBe('preparing');
  });
});

/* ———————————————————————— 文字引导页:等她开口的窗口(纯函数) ———————————————————————— */

function reply(steps: readonly Partial<ReplySignals>[], from: ReplyWindow = EMPTY_REPLY_WINDOW): ReplyWindow {
  return steps.reduce<ReplyWindow>((win, step) => nextReplyWindow(win, { scan: undefined, her: 'h1', busy: true, now: 0, ...step }), from);
}

describe('文字引导页的窗口(纯函数)', () => {
  const open: ScanProgress = { scanning: true, phase: 'list', id: 1 };
  it('服务端窗口开着就进;开之前她说的那句是记号,不算她的下一句', () => {
    const win = reply([{ scan: open, her: 'h1', now: 100 }]);
    expect(win).toMatchObject({ open: true, id: 1, herMark: 'h1', shown: open });
  });
  it('★服务端这一段收了、她还在想(老服务端活儿一做完就收):照样开着,那一行留在最后那一段;她的新一句出来才收', () => {
    const win = reply([
      { scan: open, now: 0 },
      { scan: { scanning: false, id: 1, lastRead: 'desktop-workbench' }, now: 1_500 },
    ]);
    expect(win.open).toBe(true);
    expect(scanLineOf(win.shown)).toBe('正在读 desktop-workbench 的说明…');
    expect(reply([{ scan: { scanning: false, id: 1 }, her: 'h2', now: 3_000 }], win).open).toBe(false);
  });
  it('★朗读开着:她的新一句出来先不收,等朗读开口(或等够宽限)—— 球不先闪回待命再变说话', () => {
    const heard = reply([{ scan: open, now: 0 }, { scan: { scanning: false, id: 1 }, her: 'h2', busy: false, voice: true, now: 2_000 }]);
    expect(heard).toMatchObject({ open: true, heardAt: 2_000 });
    expect(reply([{ scan: { scanning: false, id: 1 }, her: 'h2', busy: false, voice: true, speaking: true, now: 2_600 }], heard).open).toBe(false);
    expect(reply([{ scan: { scanning: false, id: 1 }, her: 'h2', busy: false, voice: true, now: 2_000 + REPLY_VOICE_GRACE_MS - 1 }], heard).open).toBe(true);
    expect(reply([{ scan: { scanning: false, id: 1 }, her: 'h2', busy: false, voice: true, now: 2_000 + REPLY_VOICE_GRACE_MS }], heard).open).toBe(false);
  });
  it('服务端收了、她那一轮也收场了(一句没说):收', () => {
    expect(reply([{ scan: open, now: 0 }, { scan: { scanning: false, id: 1 }, busy: false, now: 1_000 }]).open).toBe(false);
  });
  it('保险:服务端好久没说「还开着」就收', () => {
    const win = reply([{ scan: open, now: 0 }]);
    expect(reply([{ scan: undefined, now: REPLY_WINDOW_MAX_MS - 1 }], win).open).toBe(true);
    expect(reply([{ scan: undefined, now: REPLY_WINDOW_MAX_MS }], win).open).toBe(false);
  });
  it('本地收掉的那一段,服务端还报着也不重开;新的一段照开', () => {
    const closed = reply([{ scan: open, now: 0 }, { scan: open, her: 'h2', now: 1_000 }]);
    expect(closed).toMatchObject({ open: false, closedId: 1 });
    expect(reply([{ scan: open, her: 'h2', now: 1_500 }], closed).open).toBe(false);
    expect(reply([{ scan: { scanning: true, id: 2 }, her: 'h2', now: 3_000 }], closed)).toMatchObject({ open: true, id: 2, herMark: 'h2' });
  });
  it('开着的时候服务端换了一段(她说完一句又去找):接着开着,她的下一句从这一段算', () => {
    const win = reply([{ scan: open, now: 0 }, { scan: { scanning: true, id: 2, phase: 'read', current: 'x' }, her: 'h2', now: 2_000 }]);
    expect(win).toMatchObject({ open: true, id: 2, herMark: 'h2' });
    expect(win.heardAt).toBeUndefined();
  });
});

/* ———————————————————————— 引导通话页的窗口(纯函数) ———————————————————————— */

function call(events: readonly CallScanEvent[], from: CallScanWindow = EMPTY_CALL_SCAN): CallScanWindow {
  return events.reduce(nextCallScan, from);
}

describe('引导通话页的窗口(纯函数)', () => {
  it('★工具一开跑就进(不等轮询):找 → 「正在找你的项目…」,读 → 「正在读它的说明…」', () => {
    expect(scanLineOf(call([{ kind: 'tool', tool: 'scan_projects', state: 'start', at: 0 }]).shown)).toBe(SCAN_LINE);
    const reading = call([{ kind: 'tool', tool: 'read_project', state: 'start', at: 0 }]);
    expect(reading.open).toBe(true);
    expect(scanLineOf(reading.shown)).toBe(SCAN_READ_FALLBACK);
  });
  it('★她跑之前那句「我看一下」(工具还没跑完)不算:照样执行中;tool_done 之后她一开口就收', () => {
    const win = call([
      { kind: 'tool', tool: 'scan_projects', state: 'start', at: 0 },
      { kind: 'her', at: 300 },
    ]);
    expect(win).toMatchObject({ open: true, armed: false });
    const done = call([{ kind: 'tool', tool: 'scan_projects', state: 'done', at: 1_500 }], win);
    expect(done).toMatchObject({ open: true, armed: true });
    expect(call([{ kind: 'her', at: 3_000 }], done).open).toBe(false);
  });
  it('找完接着读:同一段,不断;读的名字由轮询补上', () => {
    const win = call([
      { kind: 'tool', tool: 'scan_projects', state: 'start', at: 0 },
      { kind: 'tool', tool: 'scan_projects', state: 'done', at: 500 },
      { kind: 'tool', tool: 'read_project', state: 'start', at: 600 },
      { kind: 'poll', scan: { scanning: true, phase: 'read', current: 'desktop-workbench', id: 5 }, at: 900 },
    ]);
    expect(win).toMatchObject({ open: true, armed: false, since: 0 });
    expect(scanLineOf(win.shown)).toBe('正在读 desktop-workbench 的说明…');
    expect(call([{ kind: 'her', at: 1_000 }], win).open).toBe(true);
  });
  it('兜底:信号没来,轮询看到服务端在干照样进;看到这一段收了当活儿做完,她开口就收', () => {
    const win = call([{ kind: 'poll', scan: { scanning: true, phase: 'list', id: 3 }, at: 0 }]);
    expect(win).toMatchObject({ open: true, armed: false, id: 3 });
    const settled = call([{ kind: 'poll', scan: { scanning: false, id: 3, lastRead: 'x' }, at: 1_500 }], win);
    expect(settled).toMatchObject({ open: true, armed: true });
    expect(scanLineOf(settled.shown)).toBe('正在读 x 的说明…');
    expect(call([{ kind: 'her', at: 2_000 }], settled)).toMatchObject({ open: false, closedId: 3 });
  });
  it('信号先到、服务端那一段在两拍之间做完:比开跑时新的那一段收了才算这一段做完;旧的不算', () => {
    const before = call([{ kind: 'poll', scan: { scanning: false, id: 3 }, at: 0 }]);
    const win = call([{ kind: 'tool', tool: 'scan_projects', state: 'start', at: 100 }, { kind: 'poll', scan: { scanning: false, id: 3 }, at: 200 }], before);
    expect(win.armed).toBe(false);
    expect(call([{ kind: 'poll', scan: { scanning: false, id: 4 }, at: 1_600 }], win).armed).toBe(true);
  });
  it('收掉之后:同一段服务端还报着不重开;活儿做完在等别人开口(held)的不重开;真在干的新一段照开', () => {
    const closed = call([{ kind: 'poll', scan: { scanning: true, id: 3 }, at: 0 }, { kind: 'tool', tool: 'scan_projects', state: 'done', at: 10 }, { kind: 'her', at: 20 }]);
    expect(closed).toMatchObject({ open: false, closedId: 3 });
    expect(call([{ kind: 'poll', scan: { scanning: true, id: 3 }, at: 30 }], closed).open).toBe(false);
    expect(call([{ kind: 'poll', scan: { scanning: true, id: 4, held: true }, at: 30 }], closed).open).toBe(false);
    expect(call([{ kind: 'poll', scan: { scanning: true, id: 4 }, at: 30 }], closed).open).toBe(true);
  });
  it('保险:好久没有「还在干」的动静就收;全量扫描时轮询续命', () => {
    const win = call([{ kind: 'tool', tool: 'scan_projects', state: 'start', at: 0 }]);
    expect(call([{ kind: 'tick', at: CALL_SCAN_IDLE_MAX_MS - 1 }], win).open).toBe(true);
    expect(call([{ kind: 'tick', at: CALL_SCAN_IDLE_MAX_MS }], win).open).toBe(false);
    const renewed = call([{ kind: 'poll', scan: { scanning: true, phase: 'repos', done: 3, total: 13 }, at: 15_000 }], win);
    expect(call([{ kind: 'tick', at: CALL_SCAN_IDLE_MAX_MS + 1 }], renewed).open).toBe(true);
  });
  it('别的工具不算;reset 从头来', () => {
    expect(call([{ kind: 'tool', tool: 'record_answer', state: 'start', at: 0 }]).open).toBe(false);
    expect(call([{ kind: 'tool', tool: 'scan_projects', state: 'start', at: 0 }, { kind: 'reset' }])).toEqual(EMPTY_CALL_SCAN);
  });
});

/* ———————————————————————— 文字引导页(真页面) ———————————————————————— */

function memory(): KeyValueStore {
  const data = new Map<string, string>();
  return { async get(k) { return data.get(k) ?? null; }, async set(k, v) { data.set(k, v); }, async remove(k) { data.delete(k); } };
}

/** 一份可以从外面改的回合回包。 */
function turnsServer(initial: Partial<TurnsResult>) {
  let body: Partial<TurnsResult> = initial;
  let calls = 0;
  const turns = async (after: number) => {
    calls += 1;
    const all = body.turns ?? [];
    return { ok: true as const, status: 200, data: { busy: true, ended: false, stage: 'projects', done: false, ...body, turns: all.filter((t) => t.seq > after) } };
  };
  return { turns, set: (next: Partial<TurnsResult>) => { body = next; }, count: () => calls };
}

function turn(seq: number, role: OnboardingTurn['role'], text: string): OnboardingTurn {
  return { seq, role, text, at: '2026-09-24T10:00:00.000Z' };
}

describe('文字引导页', () => {
  function mountPage(turns: OnboardingApi['turns'], voiceEnabled = false) {
    const api: OnboardingApi = {
      detail: async () => ({ ok: true, status: 200, data: { stage: 'projects', done: false, plan: [], answered: {} } }),
      session: async () => ({ ok: true, status: 200, data: { ok: true, stage: 'projects', session_id: 's1', first_message: '', seed: '你手上在做哪些项目?' } }),
      say: async () => ({ ok: true, status: 200, data: { ok: true, session_id: 's1' } }),
      turns,
      restart: async () => ({ ok: true, status: 200, data: { ok: true, stage: 'opening' } }),
      leader: async (leader) => ({ ok: true, status: 200, data: { ok: true, leader } }),
    };
    const pairing = { token: 't', host: 'h', port: 8791, deviceId: 'd' };
    const fetchImpl = (async () => new Response(JSON.stringify({ error: '没配' }), { status: 503 })) as typeof fetch;
    const session = openSession({ pairing, settings: createSettingsStore(memory()), onUnauthorized: () => {}, unpair: async () => {}, fetchImpl });
    render(
      <SettingsContext.Provider value={{ settings: { ...DEFAULT_SETTINGS, voiceEnabled, onboarding: 'pending' as const }, update: async () => {} }}>
        <SessionContext.Provider value={session}>
          <OnboardingPage onClose={() => {}} api={api} pollMs={20} />
        </SessionContext.Provider>
      </SettingsContext.Provider>,
    );
    return session;
  }
  const orbMode = () => document.querySelector('.ba-orb, .ba-particles')?.getAttribute('data-mode');

  it('服务端窗口开着:球进在办 + 输入框上方一行灰字进度(role=status)', async () => {
    const server = turnsServer({ scan: { scanning: true, phase: 'repos', done: 3, total: 12, current: '/Users/x/Documents/GitHub/demo', id: 1 } });
    const session = mountPage(server.turns);
    const line = await screen.findByText(`${SCAN_LINE} 已看 3/12 · …/GitHub/demo`);
    expect(line.getAttribute('role')).toBe('status');
    expect(line.className).toContain('ba-onboarding__scan');
    await waitFor(() => expect(orbMode()).toBe('working'));
    session.feed.stop();
  });

  it('★活儿做完在等她(held):一直是执行中 + 读的那一行;她的下一句一出来就回去', async () => {
    const server = turnsServer({ turns: [turn(1, 'assistant', '我看一下。')], scan: { scanning: true, held: true, phase: 'read', current: 'desktop-workbench', id: 1 } });
    const session = mountPage(server.turns);
    expect(await screen.findByText('正在读 desktop-workbench 的说明…')).toBeTruthy();
    await waitFor(() => expect(orbMode()).toBe('working'));
    // 好几拍过去了,还在等她:不闪回。
    await waitFor(() => expect(server.count()).toBeGreaterThan(4));
    expect(orbMode()).toBe('working');
    server.set({ turns: [turn(1, 'assistant', '我看一下。'), turn(2, 'assistant', '找到了,是 desktop-workbench。')], busy: false, scan: { scanning: false, done: 0, id: 1, last_read: 'desktop-workbench' } });
    await waitFor(() => expect(screen.queryByText('正在读 desktop-workbench 的说明…')).toBeNull());
    expect(orbMode()).not.toBe('working');
    expect(screen.getByText('找到了,是 desktop-workbench。')).toBeTruthy();
    session.feed.stop();
  });

  it('老服务端(活儿做完就 scanning:false、她还在想):照样撑到她开口', async () => {
    const server = turnsServer({ scan: { scanning: true, phase: 'list', done: 0 } });
    const session = mountPage(server.turns);
    await waitFor(() => expect(orbMode()).toBe('working'));
    server.set({ busy: true, scan: { scanning: false, done: 0, finished_at: '2026-09-24T10:00:01.000Z' } });
    await waitFor(() => expect(server.count()).toBeGreaterThan(6));
    expect(orbMode()).toBe('working');
    server.set({ turns: [turn(3, 'assistant', '找到两个像的。')], busy: false, scan: { scanning: false, done: 0, finished_at: '2026-09-24T10:00:01.000Z' } });
    await waitFor(() => expect(orbMode()).not.toBe('working'));
    session.feed.stop();
  });
});

/* ———————————————————————— 引导通话页(真 hook + 字幕位) ———————————————————————— */

describe('引导通话', () => {
  function fakeSession(): Session {
    return {
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
  }
  function fakeClient() {
    let events: CallEvents | null = null;
    const client: CallClient = {
      async start(_o, on) { events = on; on.onPhase('connecting'); },
      hangup: vi.fn(async () => ({ transcript: [] })),
      setMuted: vi.fn(async () => {}),
    };
    return { client, emit: (fn: (on: CallEvents) => void) => { act(() => { if (events !== null) fn(events); }); } };
  }
  function Harness({ client, turns, onboarding, pollMs }: { client: CallClient; turns: OnboardingApi['turns']; onboarding?: { resume: boolean }; pollMs: number }) {
    const call = useCall({ active: true, createClient: () => client, onEnded: () => {}, scanPollMs: pollMs, onboardingApi: { turns }, ...(onboarding === undefined ? {} : { onboarding }) });
    return <><span data-testid="orb" data-mode={call.stageMode} /><CallOverlay call={call} /></>;
  }
  function mountCall(turns: OnboardingApi['turns'], options: { onboarding?: boolean; pollMs?: number } = {}) {
    const fake = fakeClient();
    render(
      <SessionContext.Provider value={fakeSession()}>
        <Harness client={fake.client} turns={turns} pollMs={options.pollMs ?? 20} {...(options.onboarding === false ? {} : { onboarding: { resume: false } })} />
      </SessionContext.Provider>,
    );
    fake.emit((on) => on.onPhase('connected'));
    return fake;
  }
  const orb = () => screen.getByTestId('orb').getAttribute('data-mode');
  const quiet = turnsServer({ scan: { scanning: false, done: 0 } }).turns;

  it('★工人一开跑就执行中(不等轮询:这一通根本不轮询)+ 字幕位那一行;她跑之前那句不算;tool_done 之后她一开口就回去', () => {
    const fake = mountCall(quiet, { pollMs: 0 });
    expect(orb()).toBe('idle');
    fake.emit((on) => on.onTool?.({ tool: 'scan_projects', state: 'start' }));
    expect(orb()).toBe('working');
    const line = screen.getByText(SCAN_LINE);
    expect(line.closest('.ba-call__captions')).not.toBeNull();
    expect(line.getAttribute('role')).toBe('status');
    // 「我看一下。」:她在说 → 说话的样子;说完 → 还在找。
    fake.emit((on) => { on.onButlerSpeech?.(); on.onBotSpeaking(true); });
    expect(orb()).toBe('speaking');
    fake.emit((on) => on.onBotSpeaking(false));
    expect(orb()).toBe('working');
    // 找完接着读。
    fake.emit((on) => { on.onTool?.({ tool: 'scan_projects', state: 'done' }); on.onTool?.({ tool: 'read_project', state: 'start' }); });
    expect(orb()).toBe('working');
    expect(screen.getByText(SCAN_READ_FALLBACK)).toBeTruthy();
    fake.emit((on) => on.onTool?.({ tool: 'read_project', state: 'done' }));
    expect(orb()).toBe('working');
    // 她开口说结果:回去,那一行也收。说完是待命,不再回执行中。
    fake.emit((on) => { on.onButlerSpeech?.(); on.onBotSpeaking(true); });
    expect(orb()).toBe('speaking');
    expect(screen.queryByText(SCAN_READ_FALLBACK)).toBeNull();
    fake.emit((on) => on.onBotSpeaking(false));
    expect(orb()).toBe('idle');
  });

  it('远端音轨起声也算她开口(字幕丢了一条也还有这一路)', () => {
    const fake = mountCall(quiet, { pollMs: 0 });
    fake.emit((on) => { on.onTool?.({ tool: 'scan_projects', state: 'start' }); on.onTool?.({ tool: 'scan_projects', state: 'done' }); });
    expect(orb()).toBe('working');
    fake.emit((on) => on.onBotSpeaking(true));
    fake.emit((on) => on.onBotSpeaking(false));
    expect(orb()).toBe('idle');
  });

  it('轮询只补字:找的是谁、读的是谁', async () => {
    const server = turnsServer({ scan: { scanning: true, phase: 'read', current: 'desktop-workbench', id: 2 } });
    const fake = mountCall(server.turns);
    fake.emit((on) => on.onTool?.({ tool: 'read_project', state: 'start' }));
    expect(await screen.findByText('正在读 desktop-workbench 的说明…')).toBeTruthy();
    expect(orb()).toBe('working');
  });

  it('信号没来(老工人 / 丢了):轮询看到服务端在干照样进;这一段收了、她开口就回去', async () => {
    const server = turnsServer({ scan: { scanning: true, phase: 'repos', done: 5, total: 20, current: 'desktop-workbench', id: 7 } });
    const fake = mountCall(server.turns);
    expect(await screen.findByText(`${SCAN_LINE} 已看 5/20 · desktop-workbench`)).toBeTruthy();
    expect(orb()).toBe('working');
    server.set({ scan: { scanning: false, done: 20, total: 20, id: 7 } });
    await waitFor(() => expect(screen.getByText(`${SCAN_LINE} 已看 20/20`)).toBeTruthy());
    expect(orb()).toBe('working');
    fake.emit((on) => on.onButlerSpeech?.());
    expect(orb()).toBe('idle');
    expect(screen.queryByText(/正在找你的项目/)).toBeNull();
  });

  it('找项目时他开口:球照旧在办,底边声音光照样升(光跟的是谁在出声,不是球的样子;2026-09-24)', () => {
    const fake = mountCall(quiet, { pollMs: 0 });
    fake.emit((on) => on.onTool?.({ tool: 'scan_projects', state: 'start' }));
    const floor = () => document.querySelector('[data-fx=voice]');
    expect(floor()?.getAttribute('data-fx-level')).toBe('0');
    fake.emit((on) => on.onMicSpeaking(true));
    expect(orb()).toBe('working');
    expect(floor()?.getAttribute('data-fx-level')).toBe('0.5');
  });

  it('保险时限:工人跑完的信号丢了、她也一直没开口,到点回去', () => {
    vi.useFakeTimers();
    const fake = mountCall(quiet, { pollMs: 0 });
    fake.emit((on) => on.onTool?.({ tool: 'scan_projects', state: 'start' }));
    expect(orb()).toBe('working');
    act(() => { vi.advanceTimersByTime(CALL_SCAN_IDLE_MAX_MS - 100); });
    expect(orb()).toBe('working');
    act(() => { vi.advanceTimersByTime(200); });
    expect(orb()).toBe('idle');
  });

  it('不是引导的那一通:不轮询、工具信号也不理', async () => {
    const server = turnsServer({ scan: { scanning: true } });
    const fake = mountCall(server.turns, { onboarding: false });
    fake.emit((on) => on.onTool?.({ tool: 'scan_projects', state: 'start' }));
    await new Promise((r) => setTimeout(r, 80));
    expect(server.count()).toBe(0);
    expect(screen.queryByText(SCAN_LINE)).toBeNull();
    expect(orb()).toBe('idle');
  });
});
