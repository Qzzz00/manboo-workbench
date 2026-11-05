/**
 * 舞台页(2026-09-17,Ben:「底部的对话框那种不太合适……字幕形式,平时不显示对话内容,点一个 icon 之后才会显示」)。
 * 整屏纯黑 + 居中粒子球 + 球下字幕;记录默认不显示,点右上角「记录」才升起来。
 *
 * 底部分两种状态:不通话时 = 一个撑满底部的输入框(2026-09-24 起通话键收在它右下角:没内容时发送键就是通话键;
 * 按住说话是它左边那颗麦克风键),通话中 = 麦克风 / 挂断 / 字幕。
 * 通话不是另起一屏:球还是正中那一颗,挂断就回到待命。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { StagePage } from '../src/stage/StagePage';
import { wbchLocalWhen } from '../src/channel/devices';
import { CALL_UNAVAILABLE_TEXT } from '../src/call/callModel';
import type { CallClient, CallEvents } from '../src/call/rtcCall';
import { SessionContext, type Session } from '../src/session';
import { SettingsContext } from '../src/settings/SettingsContext';
import { createSettingsStore, DEFAULT_SETTINGS, type Settings } from '../src/settings/settingsStore';
import { createApiClient } from '../src/api/client';
import { ASR_DESKTOP_OFFLINE_TEXT, ASR_EMPTY_TEXT, ASR_UNCONFIGURED_TEXT, createVoiceApi, VOICE_UNAVAILABLE_TEXT, type AsrResult } from '../src/api/voice';
import { createCallApi, type RtcStatus } from '../src/api/call';
import { createAppearanceFeed } from '../src/swarm/appearance';
import { emptyState, type WorkbenchState } from '../src/api/protocol';
import { RECENT_SESSIONS_TITLE } from '../src/nav/navModel';
import { parseCallLog, type CallLogView } from '../src/call/incomingModel';
import { MISSED_CLEAR_LABEL, MISSED_FOLD_LABEL, type MissedCallsProps as MissedProps } from '../src/call/MissedCalls';
import { RAIL_CALLS_NAME, RAIL_MEETING_NAME, RAIL_MISSED_NAME, RAIL_MISSED_NONE_TEXT, RAIL_NEWS_NAME, RAIL_NEWS_PODCAST_TEXT, RAIL_TODAY_NAME } from '../src/stage/HomeRail';
import type { NewsView } from '../src/feed/newsModel';
import type { AidjView } from '../src/feed/aidjModel';
import type { FeedSnapshot, StateFeed } from '../src/api/stateFeed';
import { AvatarContext } from '../src/live2d/AvatarContext';
import { NO_AVATAR_TEXT, type AvatarState } from '../src/live2d/useAvatar';
import type { KeyValueStore } from '../src/api/tokenStore';
import { fakeChannel, fakeRouted } from './wbchFakes';
import type { WbchChannel } from '../src/channel/channel';
import type { WbchMode } from '../src/channel/channelProtocol';
import type { WbchFileSinkDeps } from '../src/channel/fileSink';

/**
 * 放音:缺省一放就完;`player.hold = true` 时一直「在念」,直到 stopSpeaking(「停止朗读」那颗)。
 * `played` 数的是**真出了几声**(2026-10-13,卡 E:通话中 / 挂断后那几条一声都不许出)。
 */
const player = vi.hoisted(() => ({ hold: false, end: null as null | (() => void), stopped: 0, played: 0 }));
vi.mock('../src/aiboo/lipsyncPlayer', () => ({
  playAudioBlob: async (_b: Blob, _m: () => void, onEnded?: () => void) => { player.played += 1; if (player.hold) { player.end = () => onEnded?.(); return; } onEnded?.(); },
  stopSpeaking: () => { player.stopped += 1; player.end?.(); player.end = null; },
  isSpeaking: () => false,
}));

/** 录音本体假掉(真 hook 在 tests/holdToTalk.test.tsx):这里只管「按住 → 识别 → 那句话」这条页上的路。 */
const recorderCalls: string[] = [];
vi.mock('../src/aiboo/useVoiceRecorder', async () => {
  const { useRef, useState } = await import('react');
  return {
    MIC_PERMISSION_TEXT: '没有录音权限',
    useVoiceRecorder() {
      const [state, setState] = useState<{ status: string, elapsedMs?: number }>({ status: 'idle' });
      const audioLevelRef = useRef(0);
      return {
        state,
        audioLevelRef,
        async startRecording() { recorderCalls.push('start'); setState({ status: 'recording', elapsedMs: 0 }); },
        stopRecording() {
          recorderCalls.push('stop');
          setState({ status: 'idle' });
          return { wavBlob: new Blob(['x'], { type: 'audio/wav' }), durationMs: 1200 };
        },
        cancelRecording() { recorderCalls.push('cancel'); setState({ status: 'idle' }); },
      };
    },
  };
});

function memory(): KeyValueStore {
  const data = new Map<string, string>();
  return { async get(k) { return data.get(k) ?? null; }, async set(k, v) { data.set(k, v); }, async remove(k) { data.delete(k); } };
}

function fakeFeed(): StateFeed & { set(state: WorkbenchState): void; setConnected(connected: boolean): void } {
  let snapshot: FeedSnapshot = { state: emptyState(), connected: true, error: undefined };
  const listeners = new Set<() => void>();
  return {
    get: () => snapshot,
    subscribe(l) { listeners.add(l); return () => listeners.delete(l); },
    async refresh() {},
    stop() {},
    set(state) { snapshot = { ...snapshot, state }; listeners.forEach((l) => l()); },
    setConnected(connected) { snapshot = { ...snapshot, connected, error: connected ? undefined : '连不上工作台' }; listeners.forEach((l) => l()); },
  };
}

function replyState(text: string, id = 't-1', user = '把版本号补一下'): WorkbenchState {
  return {
    ...emptyState(),
    // `now` 是真快照一定有的那一格(占位的 emptyState 才是空字符串)。朗读那一层靠它认
    // 「第一份真快照到了」(2026-09-26 卡 QH:冷启动不念旧回答),留空等于在假装还没连上。
    now: '2026-09-17T01:00:00Z',
    stale: false,
    sessions: [{ agent: 'dsh', session_id: `s-${id}`, project: 'p', status: 'done', summary: text, elapsed_sec: 0, unread: true, updated_at: '2026-09-17T01:00:00Z' }],
    // 事项还开着(等你确认):2026-09-25 夜起字幕只取还在办 / 等你确认的事,办完的回答不上首页字幕。
    tasks: { tasks: [{ id, status: 'confirm', title: user, direction: 'mine', created_at: '2026-09-17T00:50:00Z', updated_at: '2026-09-17T01:00:00Z', conversation: { agent: 'dsh', session_id: `s-${id}` } }] },
  };
}

/** 可以手动推进阶段的假通话客户端(和 CallOverlay 那份同形)。 */
function fakeCallClient() {
  let events: CallEvents | null = null;
  const hangup = vi.fn(async () => ({ transcript: [] }));
  const setMuted = vi.fn(async () => {});
  const client: CallClient = {
    async start(_options, on) { events = on; on.onPhase('connecting'); },
    hangup,
    setMuted,
  };
  return { client, hangup, setMuted, emit: (fn: (on: CallEvents) => void) => { if (events !== null) fn(events); } };
}

interface MountOptions {
  settings?: Partial<Settings>;
  onOpenSettings?: () => void;
  onOpenInbox?: () => void;
  /** 「各家最近的对话」那条常驻入口(2026-10-03,卡「手机各家最近会话固定入口」)。 */
  onOpenHistory?: () => void;
  /** 球下那一排里「资讯」「最近一次通话」两颗(2026-10-03 傍晚,方案 B:两张卡收成了图标)。 */
  onOpenNews?: () => void;
  /** 别的页要求开一通(2026-10-13,卡「播客页重做」:资讯页深聊面板上那颗「打电话聊」)。 */
  callNow?: number;
  onOpenCalls?: (taskId?: string) => void;
  /** 球下那一排里「会议」那颗 + 记录面板里那颗(2026-10-04,卡「首页会议图标」)。 */
  onOpenMeeting?: () => void;
  onStartOnboarding?: () => void;
  captionHoldMs?: number;
  captionFadeMs?: number;
  captionMsPerChar?: number;
  sent?: string[];
  /** 通话供应商配没配(缺省:问到了,答的是没配)。 */
  callStatus?: RtcStatus | 'down';
  createCallClient?: () => CallClient;
  /** 通道层(2026-09-17):连接方式、发文件、收文件。缺省是「直连、什么都不发生」。 */
  channel?: Partial<WbchChannel>;
  /** 此刻的连接方式(顶上那条细横幅)。 */
  mode?: WbchMode;
  /** 收到文件时往哪儿存(用例里不碰 Capacitor)。 */
  fileSink?: WbchFileSinkDeps;
  /** 此刻在线的设备(2026-09-21)。缺省:一台电脑。 */
  devices?: { identity: string; device_id: string; name: string; kind: 'mac' | 'phone' }[];
  /** 最近的传输记录。 */
  transfers?: Record<string, unknown>[];
  /** 首页「重新扫码配对」(2026-09-23)。 */
  repair?: () => Promise<void>;
  /** 按住说话识别回来的结果(缺省走假 fetch:未知路径一律 503)。 */
  asr?: AsrResult;
  /** `/butler/item` 回什么(缺省:建了一件事项)。卡 J:回一张 `file_ask`。 */
  butlerItemReply?: unknown;
  /** `/butler/say` 当前真回包外形；仅测试普通文本输入接线，不代表服务端支持其他事项能力。 */
  butlerSayReply?: unknown;
  /** `/files/offer/<单号>` 下载回来的内容(卡 J)。缺省 404。 */
  offerBody?: string;
  /** `GET /files/pending` 回什么(电脑主动推过来的卡)。缺省空。 */
  pending?: unknown;
  /** `POST /tts` 回一段假音频(缺省 503:本机没配语音)。 */
  tts?: boolean;
  /** 未接来电台账(2026-10-03,卡「首页侧边小图标」:侧边那颗图标与它点开的那一块)。缺省不传这一格。 */
  missed?: { log: CallLogView; onCallBack?: MissedProps['onCallBack']; onClear?: MissedProps['onClear'] };
  /**
   * `GET /feed` 与 `GET /feed/aidj` 回什么(2026-10-03 晚,资讯那颗的小点)。缺省两样都走未知路径的 503。
   * `aidj: 404` = 这台工作台没接 AIDJ。
   */
  news?: { feed: NewsView; aidj: AidjView | 404 };
  /**
   * `GET /sessions/digest` 回什么(2026-10-04,卡 `claude/ask-with-context`:「等你确认」那张卡下面
   * 那一段「它刚才在干什么」读的就是它)。缺席 = 照旧走未知路径的 503 —— 那一段于是如实说读不到。
   */
  digest?: Record<string, unknown>;
}

function mount(options: MountOptions = {}) {
  const pairing = { token: 't', host: 'h', port: 8791, deviceId: 'd' };
  const sent = options.sent ?? [];
  /** 这一页问过的每一条路(资讯那一问只在该问的时候问,用例按它核)。 */
  const requested: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    requested.push(url.slice(url.indexOf('/', 'http://'.length)));
    if (options.news !== undefined && url.endsWith('/feed')) {
      return new Response(JSON.stringify(options.news.feed), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (options.news !== undefined && url.endsWith('/feed/aidj')) {
      const answer = options.news.aidj;
      return answer === 404
        ? new Response(JSON.stringify({ error: '还没接 Aiboo 的 AIDJ' }), { status: 404, headers: { 'content-type': 'application/json' } })
        : new Response(JSON.stringify(answer), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    // 「等你确认」那张卡下面那一段「它刚才在干什么」(2026-10-04):与事项页点开一条会话同一条路。
    if (options.digest !== undefined && url.includes('/sessions/digest')) {
      return new Response(JSON.stringify(options.digest), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.endsWith('/butler/item')) {
      sent.push(String(init?.body ?? ''));
      const noFetch = String(init?.body ?? '').includes('"no_fetch":true');
      const reply = options.butlerItemReply !== undefined && !noFetch ? options.butlerItemReply : { id: 't-new', status: 'todo' };
      return new Response(JSON.stringify(reply), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.endsWith('/butler/say')) {
      sent.push(String(init?.body ?? ''));
      const reply = options.butlerSayReply ?? {
        say_id: 'say-stage-test',
        items: [{ kind: '办', title: '受控输入回执', status: 'done', card_id: 't-stage-test' }],
        say: { screen: '记下了。', spoken: '记下了。' },
      };
      return new Response(JSON.stringify(reply), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.includes('/files/pending')) {
      return new Response(JSON.stringify({ file_asks: options.pending ?? [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.includes('/files/received')) {
      sent.push(`received ${String(init?.body ?? '')}`);
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.includes('/files/offer/')) {
      if (options.offerBody === undefined) return new Response(JSON.stringify({ error: '这张取件单不在了' }), { status: 404 });
      const bytes = new TextEncoder().encode(options.offerBody);
      return new Response(bytes, { status: 200, headers: { 'content-type': 'text/markdown', 'content-length': String(bytes.length) } });
    }
    /*
      「等你」那一堆里的一件她答了(2026-09-28,卡 WQ:一个口 `POST /asks/answer`)。
      2026-10-03 起这条分支在这儿,是为了钉**送上去的那颗键**:工作台下发什么就回什么,不重拼
      (新手机 × 老插件那一向,审计第四节第 1 条)。
    */
    if (url.endsWith('/asks/answer')) {
      sent.push(`ask ${String(init?.body ?? '')}`);
      return new Response(JSON.stringify({ ok: true, confirmed: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    // 事务官问你的话 / 要你批的事(2026-09-25,卡 M):手机上答。
    if (url.endsWith('/questions/answer') || url.endsWith('/approvals/answer')) {
      sent.push(`${url.endsWith('/questions/answer') ? 'answer' : 'approve'} ${String(init?.body ?? '')}`);
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    // 引导落地(2026-09-24 晚):手机上点「就这样」。
    if (url.endsWith('/onboarding/materialize/apply')) {
      sent.push(`apply ${String(init?.body ?? '')}`);
      return new Response(JSON.stringify({ ok: true, line: '派出去了,做完叫你。' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (options.tts === true && url.endsWith('/tts')) {
      return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'audio/mpeg' } });
    }
    if (url.endsWith('/devices/online')) {
      return new Response(
        JSON.stringify({ devices: options.devices ?? [{ identity: 'wb-channel-worker', device_id: 'mac-a', name: '书房 Mac', kind: 'mac' }], stale: false }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (url.endsWith('/devices/transfers')) {
      return new Response(JSON.stringify({ records: options.transfers ?? [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ error: '没配' }), { status: 503 });
  }) as typeof fetch;
  const client = createApiClient({ pairing, fetchImpl, onUnauthorized: () => {} });
  const feed = fakeFeed();
  const wanted = options.callStatus;
  // 两条链路问的是两条接口(/rtc/status 与 /channel/status),用例给的那个答案两边都用:
  // 这样同一条断言换个 callProvider 还是在测同一件事。
  const answer = async () => (wanted === 'down' ? { configured: false, checked: false, reason: '连不上工作台' } : wanted!);
  const call = {
    ...createCallApi(client),
    ...(wanted === undefined ? {} : { status: answer, channelStatus: answer }),
  };
  const channel = fakeChannel(options.channel ?? {});
  const session: Session = {
    pairing,
    client: fakeRouted(client, options.mode ?? 'direct'),
    direct: client,
    feed,
    voice: { ...createVoiceApi(client), ...(options.asr === undefined ? {} : { asr: async () => options.asr! }) },
    call,
    channel,
    appearance: createAppearanceFeed(client),
    settings: createSettingsStore(memory()),
    unpair: async () => {},
    ...(options.repair === undefined ? {} : { repair: options.repair }),
  };
  const settings = { ...DEFAULT_SETTINGS, ...options.settings };
  const avatar: AvatarState = { status: 'placeholder', note: NO_AVATAR_TEXT, avatars: [] };
  /**
   * 整棵树抽成一个函数(2026-10-13):用例要能**换一个 prop 再画一遍**而不换掉 session ——
   * 「别的页要求开一通」认的是那个数变了没变,换掉整份 session 等于重挂,测不到它。
   */
  const tree = (o: MountOptions) => (
    <SettingsContext.Provider value={{ settings, update: async () => {} }}>
      <SessionContext.Provider value={session}>
        <AvatarContext.Provider value={avatar}>
          <StagePage
            captionHoldMs={o.captionHoldMs ?? 200}
            captionFadeMs={o.captionFadeMs ?? 60}
            captionMsPerChar={o.captionMsPerChar ?? 1}
            callTickMs={10}
            {...(o.createCallClient === undefined ? {} : { createCallClient: o.createCallClient })}
            {...(o.onOpenSettings === undefined ? {} : { onOpenSettings: o.onOpenSettings })}
            {...(o.onOpenInbox === undefined ? {} : { onOpenInbox: o.onOpenInbox })}
            {...(o.onOpenHistory === undefined ? {} : { onOpenHistory: o.onOpenHistory })}
            {...(o.onOpenNews === undefined ? {} : { onOpenNews: o.onOpenNews })}
            {...(o.callNow === undefined ? {} : { callNow: o.callNow })}
            {...(o.onOpenCalls === undefined ? {} : { onOpenCalls: o.onOpenCalls })}
            {...(o.onOpenMeeting === undefined ? {} : { onOpenMeeting: o.onOpenMeeting })}
            {...(o.missed === undefined
              ? {}
              : { missed: {
                  log: o.missed.log,
                  onCallBack: o.missed.onCallBack ?? (async () => ({ ok: true as const })),
                  onClear: o.missed.onClear ?? (async () => ({ ok: true as const })),
                } })}
            {...(o.onStartOnboarding === undefined ? {} : { onStartOnboarding: o.onStartOnboarding })}
            {...(o.fileSink === undefined ? {} : { fileSink: o.fileSink })}
          />
        </AvatarContext.Provider>
      </SessionContext.Provider>
    </SettingsContext.Provider>
  );
  const view = render(tree(options));
  /** 换几个 prop 再画一遍(同一份 session、同一次挂载)。 */
  const rerender = (next: Partial<MountOptions>): void => { view.rerender(tree({ ...options, ...next })); };
  return { feed, view, sent, channel, requested, rerender };
}

afterEach(() => {
  player.played = 0;
  try { sessionStorage.clear(); } catch { /* jsdom 没有就算了 */ }
});

describe('舞台页 · 平时什么都不显示', () => {
  it('只有球和底部那一个输入框:没有气泡;球在页面中间', async () => {
    mount();
    await act(async () => {});
    expect(document.querySelector('.ba-scene')).toBeTruthy();
    // jsdom 画不了 canvas,粒子退回声纹球;两者都算球。
    expect(document.querySelector('.ba-scene__orb .ba-particles, .ba-scene__orb .ba-orb')).toBeTruthy();
    expect(document.querySelector('.ba-msg')).toBeNull();
    // 底部就一样:撑满的输入框(2026-09-24 维护者:「给电话挪个位置……默认输入框就能撑满底部了」)。
    // 左边那颗通话键没了 —— dock 里只有输入框,没有别的键;通话键收在输入框右下角。
    const dock = document.querySelector('.ba-scene__dock')!;
    expect([...dock.children].map((c) => c.className)).toEqual(['pc']);
    expect(dock.querySelector('textarea')?.getAttribute('placeholder')).toBe('说点什么…');
    // 通话打不了时名字后面带着原因(「通话(…)」),这里只认前面那两个字。
    expect([...dock.querySelectorAll('.pc-keys > button')].map((b) => (b.getAttribute('aria-label') ?? '').replace(/[((].*$/, ''))).toEqual(['按住说话', '通话']);
    expect(document.querySelector('.ba-scene__field')).toBeNull();
    expect(screen.queryByRole('button', { name: '打字' })).toBeNull();
  });

  it('来了新回复也只出字幕,不出气泡', async () => {
    const { feed } = mount({ captionHoldMs: 5000 });
    act(() => feed.set(replyState('版本号补好了。')));
    expect(await screen.findByText('版本号补好了。')).toBeTruthy();
    expect(document.querySelector('.ba-msg')).toBeNull();
  });
});

describe('舞台页 · 字幕', () => {
  it('我说的那句在上,事务官那句在下;停留几秒后淡出,球下面就空了', async () => {
    // 时值压缩成「停留 1 秒、淡出 0.2 秒」:够断言看得见,又不用真等 5 秒。别再压更小——整套测试一起跑时机器忙,断言会追不上。
    const { feed } = mount({ captionHoldMs: 1000, captionFadeMs: 200 });
    act(() => feed.set(replyState('版本号补好了。', 't-1', '把版本号补一下')));
    const me = await screen.findByText('把版本号补一下');
    const butler = screen.getByText('版本号补好了。');
    expect(me.closest('.ba-scene__caption')?.getAttribute('data-role')).toBe('me');
    expect(butler.closest('.ba-scene__caption')?.getAttribute('data-role')).toBe('butler');
    // 我说的那句排在事务官那句前面
    expect(me.compareDocumentPosition(butler) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await waitFor(() => expect(screen.queryByText('版本号补好了。')).toBeNull(), { timeout: 5000 });
    expect(screen.queryByText('把版本号补一下')).toBeNull();
  });

  /**
   * 2026-09-25 夜(卡 fix/phone-home-orb-first,统筹小米真机:一段长回答占了五行大字,球被压成一个小点):
   * 字幕那一格定高,她那句截到两行(CSS line-clamp),没有「展开」了;全文在右上角「记录」里。
   */
  it('超长的只占两行(CSS 截断),没有「展开」;全文在「记录」里', async () => {
    const long = `${'办这件事要分好几步。'.repeat(8)}都办完了。`;
    const { feed } = mount({ captionHoldMs: 3000, captionFadeMs: 200 });
    act(() => feed.set(replyState(long)));
    const caption = await waitFor(() => {
      const el = document.querySelector<HTMLElement>('.ba-scene__caption[data-role="butler"]');
      expect(el?.textContent).toBe(long);
      return el!;
    });
    expect(caption.closest('.ba-scene__captions')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '展开' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '记录' }));
    expect(document.querySelector('.ba-scene__log')?.textContent).toContain(long);
  });

  it('★办完了的那件,它的回答不上首页字幕(一刀切:只取还在办 / 等你确认的事)', async () => {
    const { feed } = mount({ captionHoldMs: 5000 });
    const open = replyState('版本号补好了。');
    const done: WorkbenchState = { ...open, tasks: { tasks: open.tasks!.tasks.map((task) => ({ ...task, status: 'done' as const })) } };
    act(() => feed.set(done));
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    expect(screen.queryByText('版本号补好了。')).toBeNull();
    expect(document.querySelector('.ba-scene__caption')).toBeNull();
  });

  it('★字幕那一格一直在(没有字幕时也占着「一行 + 两行」那么高),球那一格不随字幕变', async () => {
    const { feed } = mount({ captionHoldMs: 5000 });
    await act(async () => {});
    const box = document.querySelector('.ba-scene__captions')!;
    expect(box.querySelector('.ba-scene__capspace[aria-hidden="true"] [data-role="me"]')).toBeTruthy();
    expect(box.querySelector('.ba-scene__capspace [data-role="butler"]')).toBeTruthy();
    act(() => feed.set(replyState('版本号补好了。')));
    await screen.findByText('版本号补好了。');
    // 同一个格子,垫子还在;真字幕叠在它上面。
    expect(document.querySelector('.ba-scene__captions')).toBe(box);
    expect(box.querySelector('.ba-scene__capbody .ba-scene__caption[data-role="butler"]')).toBeTruthy();
  });

  it('★她在念回答时顶上一颗「停止朗读」(喇叭图标 + 字);按了就停,那颗也收起', async () => {
    player.hold = true;
    player.stopped = 0;
    try {
      const { feed } = mount({ tts: true, captionHoldMs: 5000 });
      await act(async () => {});
      // 第一次打开时已有的回复标成读过;之后新来的一条才念。
      act(() => feed.set(replyState('先有的一条。', 't-0')));
      await act(async () => {});
      act(() => feed.set({ ...replyState('版本号补好了。', 't-1'), tasks: { tasks: [...replyState('先有的一条。', 't-0').tasks!.tasks, ...replyState('版本号补好了。', 't-1').tasks!.tasks] }, sessions: [...replyState('先有的一条。', 't-0').sessions, ...replyState('版本号补好了。', 't-1').sessions] }));
      const hush = await screen.findByRole('button', { name: '停止朗读' });
      expect(hush.closest('.ba-scene__top')).toBeTruthy();
      expect(hush.querySelector('svg[data-icon="speakerphone"]')).toBeTruthy();
      expect(screen.queryByRole('button', { name: '停' })).toBeNull();
      fireEvent.click(hush);
      expect(player.stopped).toBeGreaterThan(0);
      await waitFor(() => expect(screen.queryByRole('button', { name: '停止朗读' })).toBeNull());
    } finally {
      player.hold = false;
      player.end = null;
    }
  });
});

describe('舞台页 · 记录面板', () => {
  it('点右上角「记录」进对话记录那一页,气泡列表在里面;左上角「‹」回首页', async () => {
    const { feed } = mount();
    act(() => feed.set(replyState('版本号补好了。')));
    await act(async () => {});
    expect(document.querySelector('.ba-scene__log')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '记录' }));
    const panel = document.querySelector('.ba-scene__log');
    expect(panel).toBeTruthy();
    expect(panel!.querySelectorAll('.ba-msg').length).toBe(1);
    expect(panel!.querySelector('.ba-bubble--me')?.textContent).toContain('把版本号补一下');
    // 2026-09-24 起它是首页的下一级页(卡 fix/phone-nav-back):顶上一条返回头,不再是底下升起来的一块。
    expect(panel!.querySelector('.ba-backhead__title')?.textContent).toBe('对话记录');
    expect(document.querySelector('.ba-scene__grab')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '返回' }));
    await waitFor(() => expect(document.querySelector('.ba-scene__log')).toBeNull());
  });

  it('记录面板里能去事项和设置(工具条上不放这些,别挡球)', async () => {
    const onOpenInbox = vi.fn();
    const onOpenSettings = vi.fn();
    mount({ onOpenInbox, onOpenSettings });
    fireEvent.click(screen.getByRole('button', { name: '记录' }));
    fireEvent.click(screen.getByRole('button', { name: '事项' }));
    expect(onOpenInbox).toHaveBeenCalledTimes(1);
  });
});

describe('舞台页 · 不通话时的底部(一个输入框,通话键收在右下角)', () => {
  it('打字 → 右下角变成发送;发出去那句真的发了,清空之后又变回通话键', async () => {
    const { sent } = mount();
    const input = screen.getByLabelText('打字说给事务官') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: '帮我订明天的会议室' } });
    expect(screen.queryByRole('button', { name: /^通话/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(sent.join('')).toContain('帮我订明天的会议室'));
    await waitFor(() => expect(input.value).toBe(''));
    expect(screen.getByRole('button', { name: /^通话/ })).toBeTruthy();
  });

  it('打一个字通话键就变发送键,删光又变回来(不再让位、不再藏起来)', () => {
    mount();
    const input = screen.getByLabelText('打字说给事务官');
    expect(screen.getByRole('button', { name: /^通话/ })).toBeTruthy();
    fireEvent.change(input, { target: { value: '好' } });
    expect(screen.getByRole('button', { name: '发送' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^通话/ })).toBeNull();
    fireEvent.change(input, { target: { value: '' } });
    expect(screen.getByRole('button', { name: /^通话/ })).toBeTruthy();
    // 两种样子下麦克风键都在
    expect(screen.getByRole('button', { name: '按住说话' })).toBeTruthy();
  });
});

/**
 * 按住说话识别没成(2026-09-24 那一版在外面只说「不在同一个网络,这会儿转不了文字」,并把麦克风键灰掉)。
 * 2026-09-25(卡 S「手机在哪都能用」):出了局域网也能转文字了(录音经房间交给电脑上的识别);
 * 没成时说真实原因(api/voice.ts 的 asrFailureOf 定的那一句),麦克风键不再因为「在外面」灰掉。
 */
describe('舞台页 · 按住说话识别没成时说哪句', () => {
  async function holdAndRelease() {
    const mic = screen.getByRole('button', { name: '按住说话' });
    fireEvent.pointerDown(mic, { clientY: 700, pointerId: 1 });
    await act(async () => { fireEvent.pointerUp(mic, { clientY: 700, pointerId: 1 }); });
  }

  it('出了局域网照样转文字:远程模式下按住说完,那句话发出去了;麦克风键不灰,屏上没有「同一个网络」', async () => {
    const sent: string[] = [];
    mount({ mode: 'remote', sent, asr: { ok: true, text: '把首页的时钟调大一号' } });
    await holdAndRelease();
    await waitFor(() => expect(sent.join('')).toContain('把首页的时钟调大一号'));
    expect(screen.getByRole('button', { name: '按住说话' }).getAttribute('aria-disabled')).not.toBe('true');
    expect(screen.queryByText(/同一个网络/)).toBeNull();
  });

  it('在外面没成:说那一句真实原因(电脑不在线);麦克风照样能按,再按照样开录', async () => {
    mount({ mode: 'remote', asr: { ok: false, kind: 'network', error: ASR_DESKTOP_OFFLINE_TEXT } });
    await holdAndRelease();
    expect(await screen.findByText(ASR_DESKTOP_OFFLINE_TEXT)).toBeTruthy();
    expect(screen.queryByText(VOICE_UNAVAILABLE_TEXT)).toBeNull();
    const mic = screen.getByRole('button', { name: '按住说话' });
    expect(mic.getAttribute('aria-disabled')).not.toBe('true');
    recorderCalls.length = 0;
    fireEvent.pointerDown(mic, { clientY: 700, pointerId: 1 });
    expect(recorderCalls).toEqual(['start']);
  });

  it('没听清:就说没听清', async () => {
    mount({ asr: { ok: false, kind: 'empty', error: ASR_EMPTY_TEXT } });
    await holdAndRelease();
    expect(await screen.findByText(ASR_EMPTY_TEXT)).toBeTruthy();
  });

  it('电脑上没配识别:说那一句,麦克风键随后灰掉(按下去说为什么)—— 不管在家还是在外面', async () => {
    for (const mode of ['direct', 'remote'] as const) {
      const { view } = mount({ mode, asr: { ok: false, kind: 'unavailable', error: ASR_UNCONFIGURED_TEXT } });
      await holdAndRelease();
      expect(await screen.findByText(ASR_UNCONFIGURED_TEXT)).toBeTruthy();
      await waitFor(() => expect(screen.getByRole('button', { name: '按住说话' }).getAttribute('aria-disabled')).toBe('true'));
      view.unmount();
    }
  });
});

describe('舞台页 · 通话入口', () => {
  it('没配 → 通话键灰掉,并说「电脑上还没配通话供应商」', async () => {
    mount({ settings: { callProvider: 'volc' }, callStatus: { configured: false, checked: true, reason: '未配置语音供应商密钥' } });
    const button = screen.getByRole('button', { name: /通话/ });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(true));
    expect(screen.getByText(CALL_UNAVAILABLE_TEXT)).toBeTruthy();
  });

  it('掉线 → 也是灰的,但说的是掉线那句话(过会儿还能打)', async () => {
    mount({ settings: { callProvider: 'volc' }, callStatus: 'down' });
    const button = screen.getByRole('button', { name: /通话/ });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(true));
    expect(screen.getByText('连不上工作台')).toBeTruthy();
    expect(screen.queryByText(CALL_UNAVAILABLE_TEXT)).toBeNull();
  });

  it('还没问到答案之前先是灰的(不让他点进一通拨不出去的电话)', () => {
    mount({ callStatus: { configured: true, checked: true } });
    expect((screen.getByRole('button', { name: /通话/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('配了 → 能点;点了就进通话态,底下不再有那句提示', async () => {
    mount({ callStatus: { configured: true, checked: true }, createCallClient: () => fakeCallClient().client });
    const button = screen.getByRole('button', { name: '通话' });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    expect(screen.queryByText(CALL_UNAVAILABLE_TEXT)).toBeNull();
  });
});

/**
 * 别的页要求开一通(2026-10-13,卡「播客页重做」★3)。这一页在竖屏下**一直挂着**,
 * 所以认的是「这个数变了」而不是「有值」—— 横竖屏来回切(这一页重挂)不许凭空再打一通。
 */
describe('舞台页 · 别的页要求开一通', () => {
  it('数字变了就进通话态;挂上那一刻的那个数不算一次要求', async () => {
    const fake = fakeCallClient();
    const { rerender } = mount({ callStatus: { configured: true, checked: true }, createCallClient: () => fake.client, callNow: 1 });
    // 挂上那一刻不打(她只是在首页待着,这个数是上一次留下的)。
    await waitFor(() => expect((screen.getByRole('button', { name: '通话' }) as HTMLButtonElement).disabled).toBe(false));
    expect(screen.queryByText('通话中')).toBeNull();
    // 同一个数再画一遍也不打。
    await act(async () => { rerender({ callNow: 1 }); });
    expect(screen.queryByText('通话中')).toBeNull();
    // 变了才打。
    await act(async () => { rerender({ callNow: 2 }); });
    act(() => { fake.emit(on => on.onPhase('connected')); });
    expect(await screen.findByText('通话中')).toBeTruthy();
  });
});

describe('舞台页 · 通话中的底部(麦克风 / 挂断 / 字幕)', () => {
  async function enterCall(fake: ReturnType<typeof fakeCallClient>) {
    mount({ callStatus: { configured: true, checked: true }, createCallClient: () => fake.client });
    const button = screen.getByRole('button', { name: '通话' });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    await act(async () => { fireEvent.click(button); });
    act(() => { fake.emit(on => on.onPhase('connected')); });
    await screen.findByText('通话中');
  }

  it('点通话 → 底部换成三个键,输入框和通话键都收起来;球还是同一颗', async () => {
    const fake = fakeCallClient();
    await enterCall(fake);
    const keys = [...document.querySelectorAll('.ba-call__dock button')].map(b => b.getAttribute('aria-label'));
    expect(keys).toEqual(['关掉麦克风', '挂断', '显示字幕']);
    // 首页那个输入框(连同收在里面的麦克风与通话键)整个收起来
    expect(screen.queryByLabelText('打字说给事务官')).toBeNull();
    expect(screen.queryByRole('button', { name: '按住说话' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^通话/ })).toBeNull();
    // 球只有一颗,还在舞台正中那个位置(通话不另起一屏)
    expect(document.querySelectorAll('.ba-scene__orb').length).toBe(1);
    expect(document.querySelectorAll('.ba-scene__orb .ba-particles, .ba-scene__orb .ba-orb').length).toBe(1);
    // 通话中右上角的记录 icon 收起来:字幕用底部那颗
    expect(screen.queryByRole('button', { name: '记录' })).toBeNull();
  });

  it('球的形态跟着通话走:她在说 = 说话态,你在说 = 聆听态', async () => {
    const fake = fakeCallClient();
    await enterCall(fake);
    const scene = document.querySelector('.ba-scene')!;
    act(() => { fake.emit(on => on.onBotSpeaking(true)); });
    await waitFor(() => expect(scene.getAttribute('data-mode')).toBe('speaking'));
    act(() => { fake.emit(on => { on.onBotSpeaking(false); on.onMicSpeaking(true); }); });
    await waitFor(() => expect(scene.getAttribute('data-mode')).toBe('listening'));
  });

  it('字幕默认不显示,点底部那颗才显示;再点收起', async () => {
    const fake = fakeCallClient();
    await enterCall(fake);
    expect(screen.queryByLabelText('字幕')).toBeNull();
    act(() => { fake.emit(on => on.onUtterance({ who: 'butler', text: '记下了。' })); });
    fireEvent.click(screen.getByRole('button', { name: '显示字幕' }));
    expect((await screen.findByLabelText('字幕')).textContent).toContain('事务官:记下了。');
    fireEvent.click(screen.getByRole('button', { name: '收起字幕' }));
    await waitFor(() => expect(screen.queryByLabelText('字幕')).toBeNull());
  });

  it('挂断 → 回到舞台:底部又是那个输入框,右下角是通话键', async () => {
    const fake = fakeCallClient();
    await enterCall(fake);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '挂断' })); });
    await waitFor(() => expect(screen.getByLabelText('打字说给事务官')).toBeTruthy());
    expect(fake.hangup).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: '通话' })).toBeTruthy();
    expect(document.querySelector('.ba-call__dock')).toBeNull();
  });
});

describe('舞台页 · 引导横幅与设置入口', () => {
  it('引导没做完:顶部还是那条细横幅,点它进引导页', async () => {
    const onStartOnboarding = vi.fn();
    const { feed } = mount({ settings: { onboarding: 'pending' }, onStartOnboarding });
    act(() => feed.set({ ...emptyState(), onboarding: { stage: 'habits', done: false, askedAt: 't' } }));
    const banner = await screen.findByRole('button', { name: '引导还没做完 · 继续' });
    expect(document.querySelector('.ba-scene > .ba-banner')).toBeTruthy();
    fireEvent.click(banner);
    expect(onStartOnboarding).toHaveBeenCalledTimes(1);
  });

  it('左上角一个小设置 icon,不挡球', async () => {
    const onOpenSettings = vi.fn();
    mount({ onOpenSettings });
    const gear = screen.getByRole('button', { name: '设置' });
    expect(gear.closest('.ba-scene__top')).toBeTruthy();
    fireEvent.click(gear);
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });
});

/**
 * 通道层(2026-09-17):局域网里优先直连,连不上自动切到 LiveKit 房间让 Mac 上的工人代理。
 * 界面上只有三样看得见的东西:顶上那条细横幅、记录面板里的「发文件」、收到文件那一句。
 */
describe('舞台页 · 连接方式那条细横幅', () => {
  it('直连是常态,不显示(常态不用说)', async () => {
    mount({ mode: 'direct' });
    await act(async () => {});
    expect(document.querySelector('.ba-scene__conn')).toBeNull();
  });

  it('远程:顶上一条细横幅写「远程」,**不弹窗**', async () => {
    mount({ mode: 'remote' });
    await act(async () => {});
    const banner = document.querySelector('.ba-scene__conn');
    expect(banner?.textContent).toBe('远程');
    expect(banner?.getAttribute('data-mode')).toBe('remote');
    // 弹窗 = 每次进出门打扰他一回。一个 dialog 都不该有。
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('两条都不通:写「未连接」', async () => {
    mount({ mode: 'offline' });
    await act(async () => {});
    expect(document.querySelector('.ba-scene__conn')?.textContent).toBe('未连接');
  });

  /** 2026-09-17 登录那张卡第 3 条:掉线不掉登录。 */
  it('电脑关机 → 同一条横幅写「电脑不在线」;人还在舞台页上,没被踢回登录', async () => {
    const { feed } = mount({ mode: 'direct' });
    await act(async () => {});
    expect(document.querySelector('.ba-scene__conn')).toBeNull();
    act(() => feed.setConnected(false));
    const banner = document.querySelector('.ba-scene__conn');
    expect(banner?.textContent).toBe('电脑不在线');
    expect(banner?.getAttribute('data-mode')).toBe('offline');
    expect(document.querySelector('.ba-scene')).toBeTruthy();
    // 接回来这条横幅自己消失,不用他做任何事。
    act(() => feed.setConnected(true));
    expect(document.querySelector('.ba-scene__conn')).toBeNull();
  });

  /** 2026-09-23 第二轮从零重装:电脑重装、换了账号,手机拿着旧配对。 */
  it('★ 房里没有电脑、说不清为什么 → 横幅说「连不上你的电脑」,下面一句 + 「重新扫码配对」,点了走 repair;通话那句说明让位', async () => {
    const repair = vi.fn(async () => {});
    const { feed } = mount({
      repair,
      callStatus: 'down',
      channel: { presence: () => ({ kind: 'absent', check: 'same', departure: 'unknown', at: 0 }) },
    });
    await act(async () => {});
    act(() => feed.setConnected(false));
    expect(document.querySelector('.ba-scene__conn')?.textContent).toBe('连不上你的电脑');
    expect(document.querySelector('.ba-scene__relink')?.textContent).toContain('重新扫码配对');
    expect(document.querySelector('.ba-scene__callnote')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '重新扫码配对' }));
    expect(repair).toHaveBeenCalledTimes(1);
    // 连上了(电脑只是关着、开机了)这一块自己消失。
    act(() => feed.setConnected(true));
    expect(document.querySelector('.ba-scene__relink')).toBeNull();
  });

  /** 2026-09-28,卡 AW:新 Air 不插电会自己睡,那时首页不该说配对坏了。 */
  it('★ 确知电脑是没说再见就消失的 → 横幅说「电脑睡着了」,而且**没有**「重新扫码配对」那颗键', async () => {
    const { feed } = mount({
      repair: async () => {},
      channel: { presence: () => ({ kind: 'absent', check: 'same', departure: 'timeout', at: 0 }) },
    });
    await act(async () => {});
    act(() => feed.setConnected(false));
    expect(document.querySelector('.ba-scene__conn')?.textContent).toBe('电脑睡着了');
    expect(document.querySelector('.ba-scene__relink')?.textContent).toContain('打开电脑');
    expect(screen.queryByRole('button', { name: '重新扫码配对' })).toBeNull();
  });

  it('★ 确知电脑上的工作台自己退了 → 说工作台没在运行,也没有扫码那颗键', async () => {
    const { feed } = mount({
      repair: async () => {},
      channel: { presence: () => ({ kind: 'absent', check: 'same', departure: 'closed', at: 0 }) },
    });
    await act(async () => {});
    act(() => feed.setConnected(false));
    expect(document.querySelector('.ba-scene__conn')?.textContent).toBe('电脑上的工作台没在运行');
    expect(screen.queryByRole('button', { name: '重新扫码配对' })).toBeNull();
  });

  it('中转明说不认 → 「电脑不认这台手机了」', async () => {
    const { feed } = mount({ repair: async () => {}, channel: { presence: () => ({ kind: 'revoked', error: 'x', at: 0 }) } });
    await act(async () => {});
    act(() => feed.setConnected(false));
    expect(document.querySelector('.ba-scene__conn')?.textContent).toBe('电脑不认这台手机了');
    expect(screen.getByRole('button', { name: '重新扫码配对' })).toBeTruthy();
  });

  it('还不知道(刚断开、没进过房)→ 照旧「电脑不在线」,不催他重新配对', async () => {
    const { feed } = mount({ channel: { presence: () => ({ kind: 'unknown' }) } });
    await act(async () => {});
    act(() => feed.setConnected(false));
    expect(document.querySelector('.ba-scene__conn')?.textContent).toBe('电脑不在线');
    expect(screen.queryByRole('button', { name: '重新扫码配对' })).toBeNull();
  });

  it('没连上时卡片是上次的数据:收起成一行,点开才看;一次都没拿到过就不画', async () => {
    const { feed } = mount();
    await act(async () => {});
    expect(document.querySelector('.ba-cards[data-stale]')).toBeNull();
    act(() => feed.setConnected(false));
    // emptyState 的 now 是空的:从没拿到过 → 不画空卡片(「没有事项」是没问到,不是没有)。
    expect(document.querySelector('.ba-cards')).toBeNull();
    act(() => { feed.set({ ...emptyState(), now: '2026-09-23T10:05:00' }); });
    expect(document.querySelector('.ba-cards[data-stale="collapsed"]')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /上次的数据/ }));
    expect(document.querySelector('.ba-cards[data-stale="open"]')).toBeTruthy();
    act(() => feed.setConnected(true));
    expect(document.querySelector('.ba-cards[data-stale]')).toBeNull();
    expect(document.querySelector('.ba-cards')).toBeTruthy();
  });
});

describe('舞台页 · 文件', () => {
  /** 选一个文件:记录面板 → 发文件 → 挑好文件。挑设备那一层随后弹出来。 */
  async function pickFile(name = '一张图.png') {
    fireEvent.click(screen.getByRole('button', { name: '记录' }));
    fireEvent.click(screen.getByRole('button', { name: '发文件' }));
    const input = screen.getByLabelText('发文件给电脑上的事务官') as HTMLInputElement;
    Object.defineProperty(input, 'files', { value: [new File(['x'], name, { type: 'image/png' })] });
    await act(async () => { fireEvent.change(input); });
  }

  it('选了文件先问「发到哪台」,挑完才发(2026-09-21:房里不止一台)', async () => {
    const sentFiles: { name: string; to?: string }[] = [];
    mount({
      channel: { sendFile: async (f: File, to?: string) => { sentFiles.push({ name: f.name, ...(to === undefined ? {} : { to }) }); return { ok: true }; } },
      devices: [
        { identity: 'wb-channel-worker', device_id: 'mac-a', name: '书房 Mac', kind: 'mac' },
        { identity: 'wb-channel-worker-b', device_id: 'mac-b', name: '客厅 Mac', kind: 'mac' },
      ],
    });
    await act(async () => {});
    await pickFile();
    // 挑之前**一个字节都还没发出去**。
    expect(sentFiles).toEqual([]);
    expect(await screen.findByText('把「一张图.png」发到——')).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /客厅 Mac/ })); });
    expect(sentFiles).toEqual([{ name: '一张图.png', to: 'wb-channel-worker-b' }]);
    expect(await screen.findByText('「一张图.png」已经发给客厅 Mac了')).toBeTruthy();
  });

  it('一台设备都不在线时如实说,不假装发得出去', async () => {
    const sentFiles: string[] = [];
    mount({
      channel: { sendFile: async (f: File) => { sentFiles.push(f.name); return { ok: true }; } },
      devices: [],
    });
    await act(async () => {});
    await pickFile();
    expect(await screen.findByText('此刻没有别的设备在线。电脑上的工人起来之后再试。')).toBeTruthy();
    expect(sentFiles).toEqual([]);
  });

  it('发不出去就如实说,不假装发了', async () => {
    mount({ channel: { sendFile: async () => ({ ok: false, error: '还没有房间凭证' }) } });
    await act(async () => {});
    await pickFile('a.txt');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /书房 Mac/ })); });
    expect(await screen.findByText('发不出去:还没有房间凭证')).toBeTruthy();
  });

  it('记录面板能切到传输记录:在线设备 + 最近几条,**不含文件内容**', async () => {
    mount({
      transfers: [
        { at: '2026-09-21T10:11:12.000Z', direction: 'out', peer: '书房 Mac', name: 'README.md', bytes: 2048, ok: true },
        { at: '2026-09-21T10:09:00.000Z', direction: 'in', peer: '书房 Mac', name: '图.png', bytes: 40, ok: false, error: '太大了' },
      ],
    });
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: '记录' }));
    // 2026-09-25(卡 J):这一栏改叫「收到的文件」,先列收到的文件,下面照旧是传输记录。
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '收到的文件' })); });
    expect(await screen.findByText('此刻在线:书房 Mac(电脑)')).toBeTruthy();
    // 时刻按手机本地时区(卡 J 修的:以前显示 UTC)。
    expect(screen.getByText(`${wbchLocalWhen('2026-09-21T10:11:12.000Z')} 发给 书房 Mac:README.md 2.0 KB`)).toBeTruthy();
    expect(screen.getByText(`${wbchLocalWhen('2026-09-21T10:09:00.000Z')} 收自 书房 Mac:图.png 没成 —— 太大了`)).toBeTruthy();
  });

  it('收到工人发来的文件:存下来,并说清楚存哪儿了', async () => {
    let push: ((file: { name: string, bytes: Uint8Array, from: string }) => void) | null = null;
    mount({
      channel: { onFile: (l) => { push = l as never; return () => {}; } },
      fileSink: { loadFilesystem: async () => { throw new Error('用例里没有原生桥'); }, saveInBrowser: () => {} },
    });
    await act(async () => {});
    await act(async () => { push?.({ name: '电脑发来的.txt', bytes: new Uint8Array([1]), from: 'wb-channel-worker' }); });
    expect(await screen.findByText('收到「电脑发来的.txt」,存在浏览器的下载里')).toBeTruthy();
  });

  it('没存下来就说没存下来(最糟的是收到了却让人以为存好了)', async () => {
    let push: ((file: { name: string, bytes: Uint8Array, from: string }) => void) | null = null;
    mount({
      channel: { onFile: (l) => { push = l as never; return () => {}; } },
      fileSink: {
        loadFilesystem: async () => { throw new Error('写不进去'); },
        saveInBrowser: () => { throw new Error('浏览器也不让'); },
      },
    });
    await act(async () => {});
    await act(async () => { push?.({ name: 'a.txt', bytes: new Uint8Array([1]), from: 'wb-channel-worker' }); });
    expect(await screen.findByText('收到「a.txt」但没存下来:浏览器也不让')).toBeTruthy();
  });
});

describe('舞台页 · 引导落地那张单子(2026-09-24 晚,卡 feat/onboarding-materialize)', () => {
  const plan = {
    id: 'plan-1', status: 'pending' as const, line: '都摆好了,两个项目、十件事,屏幕上有张单子;第一件交给 Codex 接着做参赛网页,行吗?', source: 'rules',
    counts: { projects: 2, tasks: 2, cancel: 1 },
    groups: [{ id: 'projects', title: '项目' }, { id: 'sprint', title: '冲刺 · Spotlight 参赛 · 10-04' }, { id: 'cleanup', title: '撤掉(改成「取消」,不删)' }, { id: 'desk', title: '桌面' }],
    rows: [
      { key: 'project:wb', kind: 'project', group: 'projects', title: '工作台(desktop-workbench)', detail: 'Spotlight 报名截止 10/4,倒计时', checked: true },
      { key: 'task:web', kind: 'task', group: 'sprint', title: '参赛网页架构收尾', detail: '负责:Codex · 进行中', checked: true, owner: 'codex' as const, editable: true },
      { key: 'task:video', kind: 'task', group: 'sprint', title: '参赛视频', detail: '负责:别人(接手做)', checked: true, owner: 'other' as const, editable: true },
      { key: 'cancel:t-b5302d3f', kind: 'cancel', group: 'cleanup', title: '查 0.2.80 真机聚球还卡不卡', detail: '照搬中午交接的旧清单:提到 0.2.80,现在已经 0.2.83', checked: true },
      { key: 'slot', kind: 'slot', group: 'desk', title: '窗口槽:Claude、Codex、Kimi、微信、企业微信', checked: false, placeholder: '自动拉进窗口槽要等卡 C' },
    ],
    created_at: '2026-09-24T12:30:00Z',
  };

  it('单子等他点头:两张卡照旧,「等你确认」那一格置顶「我照你说的摆好了」;整张卡点下去是整张单子,勾掉一件点「就这样」', async () => {
    const sent: string[] = [];
    const onOpenInbox = vi.fn();
    const { feed } = mount({ sent, onOpenInbox });
    await act(async () => { feed.set({ ...emptyState(), stale: false, now: '2026-09-24T12:31:00Z', materialize: plan }); });
    // 两张卡都在(不替掉);单子只是「等你确认」那一格最上面那一行。
    // 2026-10-03 傍晚(方案 B)主列从五张变两张,这一条钉的「不替掉」一个字没改,只是数跟着变。
    await waitFor(() => expect(document.querySelectorAll('.ba-cards__card')).toHaveLength(2));
    const confirm = document.querySelector('.ba-cards__card[data-card="confirm"]') as HTMLElement;
    expect(within(confirm).getByText('我照你说的摆好了')).toBeTruthy();
    expect(within(confirm).getByText('1')).toBeTruthy();
    expect(screen.queryByRole('dialog', { name: '我照你说的摆好了' })).toBeNull();
    await act(async () => { fireEvent.click(within(confirm).getByRole('button', { name: '打开「等你确认」' })); });
    expect(onOpenInbox).not.toHaveBeenCalled();
    const page = await screen.findByRole('dialog', { name: '我照你说的摆好了' });
    const card = within(page).getByRole('region', { name: '我照你说的摆好了' });
    expect(within(card).getByText('2 个项目、2 件事、撤掉 1 条旧的 · 等你点头')).toBeTruthy();
    expect(within(card).getByText('负责:Codex · 进行中')).toBeTruthy();
    expect((within(card).getByRole('checkbox', { name: '窗口槽:Claude、Codex、Kimi、微信、企业微信' }) as HTMLInputElement).disabled).toBe(true);
    await act(async () => { fireEvent.click(within(card).getByRole('checkbox', { name: '参赛视频' })); });
    await act(async () => { fireEvent.click(within(card).getByRole('button', { name: '就这样' })); });
    await waitFor(() => expect(sent.some((line) => line.startsWith('apply '))).toBe(true));
    expect(JSON.parse(sent.find((line) => line.startsWith('apply '))!.slice(6))).toEqual({ id: 'plan-1', uncheck: ['task:video'] });
    // 返回头「‹」回首页。
    await act(async () => { fireEvent.click(within(page).getByRole('button', { name: '返回' })); });
    expect(screen.queryByRole('dialog', { name: '我照你说的摆好了' })).toBeNull();
  });

  it('★「等你确认」里除了单子还有别的(2026-09-25,卡 fix/confirm-cancel):单子那一页顶上列出另外几件,点一件打开它', async () => {
    const onOpenInbox = vi.fn();
    const { feed } = mount({ onOpenInbox });
    const inbox = { items: [
      { id: 'confirm:t-kimi', kind: 'confirm', title: '[派活测试] 让 Kimi 用一句话回答:一周有几天?', note: '1 件交付物', task_id: 't-kimi' },
      { id: 'confirm:t-rule', kind: 'confirm', title: '[测试] 我的规矩有哪些?', note: '1 件交付物', task_id: 't-rule' },
    ] } as unknown as WorkbenchState['butler_inbox'];
    await act(async () => { feed.set({ ...emptyState(), stale: false, now: '2026-09-24T12:31:00Z', materialize: plan, butler_inbox: inbox }); });
    const confirm = await waitFor(() => document.querySelector('.ba-cards__card[data-card="confirm"]') as HTMLElement);
    // 卡上三行、数是 3;整张卡点下去先看单子(卡 B 定的,不变)。
    expect(within(confirm).getByText('3')).toBeTruthy();
    await act(async () => { fireEvent.click(within(confirm).getByRole('button', { name: '打开「等你确认」' })); });
    const page = await screen.findByRole('dialog', { name: '我照你说的摆好了' });
    const others = within(page).getByRole('region', { name: '另外 2 件等你确认' });
    expect(within(others).getAllByRole('button')).toHaveLength(2);
    await act(async () => { fireEvent.click(within(others).getByRole('button', { name: /让 Kimi 用一句话回答/ })); });
    expect(onOpenInbox).toHaveBeenCalledWith({ taskId: 't-kimi' });
  });

  it('★事务官问你的话(2026-09-25,卡 M):「等你确认」最前面一行、数算上它;点开是同样的问题与选项,点一个就交', async () => {
    const sent: string[] = [];
    const { feed } = mount({ onOpenInbox: vi.fn(), sent });
    const questions = [{
      id: 'q-1', session_id: 'session-07ed', task_id: 't-a8934b2a', task_title: '这个有点问题,你看三张卡片的左上角', at: '2026-09-25T05:49:11Z',
      questions: [{ id: 'confirm_avatar_clip', header: '派活前对一遍', question: '派活之前先跟你对一遍。\n① 就是它们吧\n\n哪条不对说一下,都对就开工。', multi: false,
        options: [{ label: '都对,开工 (Recommended)', text: '都对,开工(推荐)' }, { label: '都对,但你自己做', text: '都对,但你自己做' }] }],
    }];
    await act(async () => { feed.set({ ...emptyState(), stale: false, now: '2026-09-25T05:50:00Z', questions } as unknown as WorkbenchState); });
    const confirm = await waitFor(() => document.querySelector('.ba-cards__card[data-card="confirm"]') as HTMLElement);
    expect(within(confirm).getByText('1')).toBeTruthy();
    expect(within(confirm).getByText(/问你:派活前对一遍/)).toBeTruthy();
    await act(async () => { fireEvent.click(within(confirm).getByRole('button', { name: '打开「等你确认」' })); });
    const page = await screen.findByRole('dialog', { name: '等你确认' });
    expect(within(page).getByText(/派活之前先跟你对一遍/)).toBeTruthy();
    expect(page.textContent ?? '').not.toMatch(/Type your answer|Skip this question|Submit|Recommended/);
    await act(async () => { fireEvent.click(within(page).getByRole('button', { name: /都对,开工\(推荐\)/ })); });
    await waitFor(() => expect(sent.some((line) => line.startsWith('answer '))).toBe(true));
    expect(JSON.parse(sent.find((line) => line.startsWith('answer '))!.slice(7))).toEqual({ id: 'q-1', answers: [{ id: 'confirm_avatar_clip', selected: ['都对,开工 (Recommended)'] }] });
  });

  it('★要你批的事也在「等你确认」里,说人话;「这件事里同类的都允许」交 scope:kind(卡 M)', async () => {
    const sent: string[] = [];
    const { feed } = mount({ onOpenInbox: vi.fn(), sent });
    const approvals = [{
      id: 'a-1', session_id: 's', task_title: '修小头像', tool: 'bash', at: 'x',
      say: '要开一个看不见的浏览器,把页面截下来看', why: '要写自己的临时目录', scope: '这一条要能改这台电脑上的任何文件;平时只能改「工作台」文件夹和临时文件。',
      kind: { key: 'browser', title: '开看不见的浏览器截图' }, raw: { reason: 'escalate sandbox to danger-full-access: x' },
    }];
    await act(async () => { feed.set({ ...emptyState(), stale: false, now: '2026-09-25T06:00:00Z', approvals } as unknown as WorkbenchState); });
    const confirm = await waitFor(() => document.querySelector('.ba-cards__card[data-card="confirm"]') as HTMLElement);
    await act(async () => { fireEvent.click(within(confirm).getByRole('button', { name: '打开「等你确认」' })); });
    const page = await screen.findByRole('dialog', { name: '等你确认' });
    expect(within(page).getByText('要开一个看不见的浏览器,把页面截下来看')).toBeTruthy();
    expect(page.textContent ?? '').not.toMatch(/escalate|danger-full-access/);
    await act(async () => { fireEvent.click(within(page).getByRole('button', { name: '这件事里开看不见的浏览器截图都允许' })); });
    await waitFor(() => expect(sent.some((line) => line.startsWith('approve '))).toBe(true));
    expect(JSON.parse(sent.find((line) => line.startsWith('approve '))!.slice(8))).toEqual({ id: 'a-1', allow: true, scope: 'kind' });
    // 输入框上方不再另摆一排「允许这一次」(一起进了「等你确认」)。
    await act(async () => { fireEvent.click(within(page).getByRole('button', { name: '返回' })); });
    expect(screen.queryByRole('button', { name: '允许这一次' })).toBeNull();
  });

  it('★同一份状态(电脑那边那一份):首页「等你确认」的数 = 电脑上「等你 n」;点开那一页的几张 + 「另外 N 件」正好是这个数(卡 M 追加)', async () => {
    const same = JSON.parse(readFileSync(resolve(process.cwd(), '..', 'workbench-plugin', 'tests', 'fixtures', 'waiting-state.json'), 'utf8')) as WorkbenchState;
    const onOpenInbox = vi.fn();
    const { feed } = mount({ onOpenInbox });
    await act(async () => { feed.set({ ...emptyState(), ...same, stale: false } as WorkbenchState); });
    const confirm = await waitFor(() => document.querySelector('.ba-cards__card[data-card="confirm"]') as HTMLElement);
    expect(within(confirm).getByText(String(same.waiting!.count))).toBeTruthy();
    await act(async () => { fireEvent.click(within(confirm).getByRole('button', { name: '打开「等你确认」' })); });
    const page = await screen.findByRole('dialog', { name: '等你确认' });
    const cards = page.querySelectorAll('.ba-ask').length;
    const others = within(page).getByRole('region', { name: `另外 ${same.waiting!.count - cards} 件等你确认` });
    expect(cards).toBe(3);
    expect(within(others).getAllByRole('listitem')).toHaveLength(same.waiting!.count - cards);
    // 提议在电脑上定:那几行点不动;办完了等你确认的点下去打开那一件。
    expect(within(others).getAllByText('在电脑上定')).toHaveLength(3);
    await act(async () => { fireEvent.click(within(others).getByRole('button', { name: /Kimi 的回答/ })); });
    expect(onOpenInbox).toHaveBeenCalledWith({ taskId: 't-c2' });
  });

  it('只有单子一件等你确认:那一页上没有「另外 N 件」那一节', async () => {
    const { feed } = mount({ onOpenInbox: vi.fn() });
    await act(async () => { feed.set({ ...emptyState(), stale: false, now: '2026-09-24T12:31:00Z', materialize: plan }); });
    const confirm = await waitFor(() => document.querySelector('.ba-cards__card[data-card="confirm"]') as HTMLElement);
    await act(async () => { fireEvent.click(within(confirm).getByRole('button', { name: '打开「等你确认」' })); });
    const page = await screen.findByRole('dialog', { name: '我照你说的摆好了' });
    expect(within(page).queryByRole('region', { name: /另外 \d+ 件等你确认/ })).toBeNull();
  });

  it('落好了:「等你确认」那一格没有那一行了,首页飘一句回执;那一页开着时页上写着,「收起」回首页', async () => {
    const onOpenInbox = vi.fn();
    const { feed } = mount({ onOpenInbox });
    const applied = { ...plan, status: 'applied' as const, applied_at: new Date().toISOString(), result: { ok: true, line: '派出去了,做完叫你。', rows: [] } };
    await act(async () => { feed.set({ ...emptyState(), stale: false, now: '2026-09-24T12:31:00Z', materialize: plan }); });
    await act(async () => { feed.set({ ...emptyState(), stale: false, now: '2026-09-24T12:40:00Z', materialize: applied }); });
    expect((await screen.findByRole('alert')).textContent).toBe('派出去了,做完叫你。');
    const confirm = document.querySelector('.ba-cards__card[data-card="confirm"]') as HTMLElement;
    expect(within(confirm).queryByText('我照你说的摆好了')).toBeNull();
    // 打开 App 时早就落好的,不飘。
    const again = mount({ onOpenInbox });
    await act(async () => { again.feed.set({ ...emptyState(), stale: false, now: '2026-09-24T12:41:00Z', materialize: applied }); });
    expect(screen.getAllByRole('alert')).toHaveLength(1);
  });

  it('那一页开着时落好了:页上换成回执,「收起」回首页', async () => {
    const { feed } = mount({ onOpenInbox: vi.fn() });
    await act(async () => { feed.set({ ...emptyState(), stale: false, now: '2026-09-24T12:31:00Z', materialize: plan }); });
    const confirm = await waitFor(() => document.querySelector('.ba-cards__card[data-card="confirm"]') as HTMLElement);
    await act(async () => { fireEvent.click(within(confirm).getByRole('button', { name: '打开「等你确认」' })); });
    const applied = { ...plan, status: 'applied' as const, applied_at: new Date().toISOString(), result: { ok: false, line: '派出去了,做完叫你。有 1 样没落上,屏幕上写着是哪几样。', rows: [{ key: 'slot', title: '窗口槽', ok: false, note: '没接上' }] } };
    await act(async () => { feed.set({ ...emptyState(), stale: false, now: '2026-09-24T12:40:00Z', materialize: applied }); });
    const page = screen.getByRole('dialog', { name: '我照你说的摆好了' });
    expect(within(page).getByRole('status').textContent).toBe('派出去了,做完叫你。有 1 样没落上,屏幕上写着是哪几样。');
    expect(within(page).getByText('窗口槽:没接上')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    await act(async () => { fireEvent.click(within(page).getByRole('button', { name: '收起' })); });
    expect(screen.queryByRole('dialog', { name: '我照你说的摆好了' })).toBeNull();
  });
});

describe('舞台页 · 从电脑取文件(2026-09-25,卡 J)', () => {
  const ask = {
    id: 'ask-1',
    request: '把工作台仓库的 README 发到我手机上',
    query: 'desktop-workbench · readme',
    device: '书房 Mac',
    total: 1,
    hits: [{ offer: 'o-1', name: 'README.md', where: 'desktop-workbench', bytes: 12, kind: 'text' }],
  };
  /** 一份记在内存里的「文档」目录(不碰 Capacitor)。 */
  function memoryDocs() {
    const written: Record<string, unknown>[] = [];
    return {
      written,
      sink: { loadFilesystem: async () => ({ Filesystem: { writeFile: async (o: Record<string, unknown>) => { written.push(o); return {}; } }, Directory: { Documents: 'DOCUMENTS' } }) },
    };
  }
  async function typeAndSend(text: string) {
    const input = screen.getByLabelText('打字说给事务官') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: text } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '发送' })); });
  }

  it('打一句「发到我手机上」:不进对话,弹一张「找到了」的卡;**卡上没有路径**', async () => {
    const sent: string[] = [];
    const { requested } = mount({ sent, butlerSayReply: { say_id: 'say-file-ask', items: [], file_ask: ask, say: { screen: '找到了什么,摆一张卡给你挑。', spoken: '找到了什么,摆一张卡给你挑。' } } });
    await typeAndSend(ask.request);
    expect(requested.some((path) => path.startsWith('/butler/say'))).toBe(true);
    expect(sent[0]).toContain('"entrance":"phone"');
    expect(sent[0]).not.toContain('"can_file_ask"');
    expect(await screen.findByText('在书房 Mac上找到了')).toBeTruthy();
    expect(screen.getByText('找到了什么,摆一张卡给你挑。')).toBeTruthy();
    const pick = screen.getByRole('button', { name: '把「README.md」发到这台手机' });
    expect(pick.textContent).toContain('12 字节 · desktop-workbench');
    expect(document.querySelector('.ba-fileask')?.textContent).not.toContain('/');
  });

  it('在家点「发到这台手机」:直接下载、存进「文档 / 事务官」,那一句「收到」点了就去打开', async () => {
    const docs = memoryDocs();
    mount({ butlerSayReply: { say_id: 'say-file-ask', items: [], file_ask: ask, say: { screen: '找到了', spoken: '找到了' } }, offerBody: '# 工作台 README', fileSink: docs.sink, mode: 'direct' });
    await typeAndSend(ask.request);
    await act(async () => { fireEvent.click(await screen.findByRole('button', { name: '把「README.md」发到这台手机' })); });
    const notice = await screen.findByText('收到「README.md」,存在手机「文档 / 事务官」里,点这里打开');
    expect(docs.written[0]).toMatchObject({ path: '事务官/README.md', directory: 'DOCUMENTS' });
    expect(new TextDecoder().decode(Uint8Array.from(atob(String(docs.written[0]?.data)), (c) => c.charCodeAt(0)))).toBe('# 工作台 README');
    // 卡收掉了。
    expect(document.querySelector('.ba-fileask')).toBeNull();
    // 用例里没有原生打开器:点了之后如实说到哪儿去看。
    await act(async () => { fireEvent.click(notice); });
    expect(await screen.findByText(/「README.md」没打开:这里打不开:到手机的「文件」App 里/)).toBeTruthy();
  });

  it('在外面点:让电脑经房间推(带单号),屏幕上说「电脑在推」', async () => {
    const pulled: string[] = [];
    mount({
      butlerSayReply: { say_id: 'say-file-ask', items: [], file_ask: ask, say: { screen: '找到了', spoken: '找到了' } },
      mode: 'remote',
      channel: { pullOffer: async (offer: string) => { pulled.push(offer); return { ok: true, name: 'README.md', bytes: 12 }; } },
    });
    await typeAndSend(ask.request);
    await act(async () => { fireEvent.click(await screen.findByRole('button', { name: '把「README.md」发到这台手机' })); });
    expect(pulled).toEqual(['o-1']);
    expect(await screen.findByText('电脑在推「README.md」…')).toBeTruthy();
  });

  it('取不回来就如实说(单子过期)', async () => {
    mount({ butlerSayReply: { say_id: 'say-file-ask', items: [], file_ask: ask, say: { screen: '找到了', spoken: '找到了' } }, mode: 'direct' });
    await typeAndSend(ask.request);
    await act(async () => { fireEvent.click(await screen.findByRole('button', { name: '把「README.md」发到这台手机' })); });
    expect(await screen.findByText('「README.md」没取回来:这张取件单不在了')).toBeTruthy();
  });

  it('没找到:原样摆出来;「交给事务官找」照旧建一件事项(no_fetch)', async () => {
    const sent: string[] = [];
    mount({ sent, butlerSayReply: { say_id: 'say-file-ask-empty', items: [], file_ask: { ...ask, hits: [], total: 0, note: '在「desktop-workbench」里没找到名字带「预算表」的文件。' }, say: { screen: '没找到', spoken: '没找到' } } });
    await typeAndSend('把工作台的预算表发我');
    expect(await screen.findByText('在书房 Mac上没找到')).toBeTruthy();
    expect(screen.getByText('在「desktop-workbench」里没找到名字带「预算表」的文件。')).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '交给事务官找' })); });
    await waitFor(() => expect(sent[sent.length - 1]).toContain('"no_fetch":true'));
    expect(sent[sent.length - 1]).toContain('把工作台仓库的 README 发到我手机上');
    expect(document.querySelector('.ba-fileask')).toBeNull();
  });
});


/**
 * 点哪件开哪件 + 批准卡一眼看清(2026-09-28,卡 UX;维护者 09-28 10:1x 真机现场)。
 *
 * ① 首页「等你确认」第一行是「【工作台自测】让 Manus…」,他点进去 → 打开的是整个等你列表,
 *    最上面是另外两条 —— 他以为眼前那张卡就是他点的那一件,点了「允许这一次」,
 *    结果把「验证自我迭代能力」派给了 Claude。原话:「那个允许这一次,我点了,但是他发给了Claude」。
 * ② 那张批准卡的正文是一整面各家额度,「哪件事、派给谁」只在最上面一小行灰字。
 */
describe('首页「等你确认」:点哪件开哪件(卡 UX)', () => {
  const manus = {
    id: 'a-manus', session_id: 'dispatch:t-manus', task_id: 't-manus', task_title: '【工作台自测】让 Manus 帮我查国庆假期',
    tool: '派给 Manus(剩 2,690 积分)', say: '派给 Manus(剩 2,690 积分)', at: '2026-09-28T02:00:00Z',
    options: [
      { family: 'manus', title: 'Manus', quota: '剩 2,690 积分', chosen: true },
      { family: 'claude', title: 'Claude', quota: '本周还剩约 28%' },
      { family: 'doubao', title: '豆包办公', quota: '当前时段已用 99%' },
    ],
  };
  const claude = {
    id: 'a-claude', session_id: 'dispatch:t-evolve', task_id: 't-evolve', task_title: '验证自我迭代能力',
    tool: '派给 Claude(本周还剩约 28%)', say: '派给 Claude(本周还剩约 28%)', at: '2026-09-28T02:01:00Z',
    options: [{ family: 'claude', title: 'Claude', quota: '本周还剩约 28%', chosen: true }],
  };
  const both = { ...emptyState(), stale: false, now: '2026-09-28T02:10:00Z', approvals: [manus, claude] } as unknown as WorkbenchState;

  it('★点第一行 → 那一页只摆那一件;剩下的收在「还有 N 件」后面,按一下才整列摆', async () => {
    const { feed } = mount({ onOpenInbox: vi.fn() });
    await act(async () => { feed.set(both); });
    const confirm = await waitFor(() => document.querySelector('.ba-cards__card[data-card="confirm"]') as HTMLElement);
    await act(async () => { fireEvent.click(within(confirm).getByRole('button', { name: /打开「「【工作台自测】让 Man/ })); });
    const page = await screen.findByRole('dialog', { name: '等你确认' });
    expect(page.querySelectorAll('.ba-ask')).toHaveLength(1);
    expect(within(page).getByText(/^把「【工作台自测】让 Manus 帮我查国.*」派给 Manus\?$/)).toBeTruthy();
    // 另一件不在眼前,但有入口。
    expect(page.textContent ?? '').not.toContain('验证自我迭代能力');
    await act(async () => { fireEvent.click(within(page).getByRole('button', { name: '还有 1 件要你答 / 要你批' })); });
    expect(page.querySelectorAll('.ba-ask')).toHaveLength(2);
  });

  it('★批准卡大字第一行写着哪件事、派给谁;「允许」带着对象;别家额度收起成一行', async () => {
    const sent: string[] = [];
    const { feed } = mount({ onOpenInbox: vi.fn(), sent });
    await act(async () => { feed.set(both); });
    const confirm = await waitFor(() => document.querySelector('.ba-cards__card[data-card="confirm"]') as HTMLElement);
    await act(async () => { fireEvent.click(within(confirm).getByRole('button', { name: /打开「「【工作台自测】让 Man/ })); });
    const page = await screen.findByRole('dialog', { name: '等你确认' });
    expect(within(page).getByLabelText('这次问的那一家').textContent).toContain('剩 2,690 积分');
    expect(page.textContent ?? '').not.toContain('本周还剩约 28%');
    expect(within(page).getByText(/其他可选:Claude \/ 豆包办公/)).toBeTruthy();
    await act(async () => { fireEvent.click(within(page).getByRole('button', { name: '展开看额度' })); });
    expect(within(page).getByLabelText('能派给的几家').textContent).toContain('本周还剩约 28%');
    // 点下去批的就是眼前这一件(键上写着派给谁)。
    await act(async () => { fireEvent.click(within(page).getByRole('button', { name: '允许派给 Manus' })); });
    await waitFor(() => expect(sent.some((line) => line.startsWith('approve '))).toBe(true));
    expect(JSON.parse(sent.find((line) => line.startsWith('approve '))!.slice(8))).toEqual({ id: 'a-manus', allow: true });
  });

  it('★事务官自己提的那一问(「这张派给 X 开工?」)不算「等你」:首页那一格说没有要你确认的', async () => {
    const { feed } = mount({ onOpenInbox: vi.fn() });
    const proposal = { ...claude, proposal: true as const, say: '这张派给 Claude 开工?现在:还没看到这件事的进展' };
    await act(async () => { feed.set({ ...emptyState(), stale: false, now: '2026-09-28T02:10:00Z', approvals: [proposal] } as unknown as WorkbenchState); });
    const confirm = await waitFor(() => document.querySelector('.ba-cards__card[data-card="confirm"]') as HTMLElement);
    expect(within(confirm).getByText('没有要你确认的。')).toBeTruthy();
  });
});

/**
 * 首页球下那一排小图标(2026-10-03 傍晚,卡「首页两卡 + 一排图标」= 方案 B)。维护者 17:5x 原话:
 * 「只保留正在办和待确认两个是卡片,其他都和前面一样做成 icon 就 OK……中间的球球还是要大的,
 * 这个事情是要适配 Live2D 的显示空间,省出来的空间 Live2D 也能放大。」
 *
 * 当天下午那张卡(「首页侧边小图标」)把「未接来电」「各家最近的对话」做成了球那一栏右上角一列;
 * 这一版那一列**并进球下那一排**(只留一处),另三张卡(今天要做 / 最近一次通话 / 资讯)也收成图标。
 * 上午那张卡(「手机各家最近会话固定入口」)要的「不带任何条件」那几条**原封钉在这里**
 * (没有在跑的、电脑没连上都在)—— 换的只是它长什么样、摆在哪。
 * 「点不到」的根因、这一排的 CSS 与球跟着长大那一条在 tests/homeRail.test.tsx。
 */
describe('首页 · 球下那一排小图标', () => {
  const LABEL = `打开「${RECENT_SESSIONS_TITLE}」`;
  const RAW_LOG = {
    missed: 2,
    config: { enabled: true, done_call: false },
    entries: [
      { id: 'c1', reason: 'confirm', item_id: 't-confirm', title: '我的规矩有哪些?', at: '2026-10-03T06:20:00Z', state: 'missed', error: '响了 60 秒没人接' },
      { id: 'c2', reason: 'failed', item_id: 't-open', title: '还开着的一件', at: '2026-10-03T05:40:00Z', state: 'missed', error: '响了 60 秒没人接' },
    ],
  };

  it('★一条都没在跑、什么事都没有:那颗图标照样在;点下去去那一页', async () => {
    const onOpenHistory = vi.fn();
    mount({ onOpenHistory });
    await act(async () => {});
    const entry = screen.getByRole('button', { name: LABEL });
    // 它在球那一栏里那一排上,**不在主列里** —— 主列那一行的高度还给球了。
    expect(entry.closest('.ba-scene__stage > .ba-rail')).toBeTruthy();
    expect(document.querySelector('.ba-scene__recent')).toBeNull();
    await act(async () => { fireEvent.click(entry); });
    expect(onOpenHistory).toHaveBeenCalledTimes(1);
  });

  it('★另三样搬成这一排里的图标:主列里找不到那三张卡,点图标各进自己那一处', async () => {
    const onOpenInbox = vi.fn();
    const onOpenCalls = vi.fn();
    const onOpenNews = vi.fn();
    const { feed } = mount({ onOpenInbox, onOpenCalls, onOpenNews, onOpenHistory: vi.fn() });
    await act(async () => {
      feed.set({
        ...emptyState(), stale: false, now: '2026-10-03T09:00:00Z',
        tasks: { tasks: [
          { id: 't-1', title: '写口播稿', status: 'todo', direction: 'mine', created_at: 'a', updated_at: 'b' },
          { id: 't-call', title: '和事务官通了个电话(34 秒)', status: 'done', direction: 'mine', origin: 'call', created_at: '2026-10-03T08:00:00Z', updated_at: 'b', call: { kind: 'phone', summary: '说了版本号那件事', duration_seconds: 34 } },
        ] },
      } as unknown as WorkbenchState);
    });
    // 主列里只有那两张卡。
    expect([...document.querySelectorAll('.ba-cards__card')].map((one) => one.getAttribute('data-card'))).toEqual(['doing', 'confirm']);
    for (const title of [RAIL_TODAY_NAME, RAIL_CALLS_NAME, RAIL_NEWS_NAME]) {
      expect(document.querySelector(`.ba-cards__card[data-card="today"]`)).toBeNull();
      expect(within(document.querySelector<HTMLElement>('.ba-cards')!).queryByText(title)).toBeNull();
    }
    // 「今天要做」那颗:角标是真数(那一件),点下去进事项页「还没开始的」那一段。
    const today = screen.getByRole('button', { name: `${RAIL_TODAY_NAME} 1` });
    await act(async () => { fireEvent.click(today); });
    expect(onOpenInbox).toHaveBeenCalledWith({ tab: 'queued' });
    // 「最近一次通话」那颗:带着最近那一张纪要卡(与那张卡原来的去处一个字没改)。
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: `打开「${RAIL_CALLS_NAME}」` })); });
    expect(onOpenCalls).toHaveBeenCalledWith('t-call');
    // 「资讯」那颗:进资讯页。
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: `打开「${RAIL_NEWS_NAME}」` })); });
    expect(onOpenNews).toHaveBeenCalledTimes(1);
  });

  /*
   * 资讯那颗的小点(2026-10-03 晚,卡 `claude/phone-news-podcast-dot`)。维护者:「要,只标播客有没有」。
   * 判法与资讯那一页同一处(tests/newsPodcastDot.test.tsx);这里钉首页什么时候问、问回来亮不亮。
   */
  describe('资讯那颗:今天的播客能听时亮一个小点', () => {
    const CONFIG = { version: 1 as const, enabled: true, per_project: 5, podcast: true, podcast_minutes: 4, interests: [] };
    const NEWS = (podcast?: NewsView['podcast']): NewsView => ({ date: '2026-10-03', groups: [], config: CONFIG, last_run_at: 1, ...(podcast === undefined ? {} : { podcast }) });
    const LOCAL = { date: '2026-10-03', script: '今天两件事。', file: 'feed-podcast-2026-10-03.mp3', bytes: 12, at: 1 };
    const AIDJ: AidjView = {
      status: 'ready', fetched_at: 1, config: { enabled: true, base_url: 'http://x', push_interests: true, token_set: false },
      program: { date: '2026-10-03', status: 'ready', topics: [], segments: [{ id: 's1', speaker: '机车妹', text: '早', duration_ms: 1000 }], hosts: ['机车妹'], estimated_total_ms: 60_000 },
    };
    const LIT = `${RAIL_NEWS_NAME},${RAIL_NEWS_PODCAST_TEXT}`;

    it('★工作台自己合成的那段有音频:亮', async () => {
      mount({ onOpenNews: vi.fn(), news: { feed: NEWS(LOCAL), aidj: 404 } });
      const news = await screen.findByRole('button', { name: LIT });
      expect(news.querySelector('.ba-rail__dot')).toBeTruthy();
    });

    it('★Aiboo 那期双主播能播(工作台那段没有):也亮', async () => {
      mount({ onOpenNews: vi.fn(), news: { feed: NEWS(), aidj: AIDJ } });
      expect(await screen.findByRole('button', { name: LIT })).toBeTruthy();
    });

    it('只有文字稿 / 今天什么都没有:不亮,读屏照旧「打开「资讯」」', async () => {
      const { requested } = mount({ onOpenNews: vi.fn(), news: { feed: NEWS({ date: '2026-10-03', script: '稿子', error: '语音没配', at: 1 }), aidj: 404 } });
      await waitFor(() => { expect(requested).toContain('/feed/aidj'); });
      await act(async () => {});
      expect(screen.getByRole('button', { name: `打开「${RAIL_NEWS_NAME}」` })).toBeTruthy();
      expect(document.querySelector('.ba-rail__dot')).toBeNull();
    });

    it('★资讯那颗没有去处(没传 onOpenNews):首页压根不去问 `/feed`、`/feed/aidj` —— AIDJ 那一问要打 Aiboo 云端', async () => {
      const { requested } = mount({ news: { feed: NEWS(LOCAL), aidj: AIDJ } });
      await act(async () => {});
      expect(requested.filter((path) => path.startsWith('/feed'))).toEqual([]);
    });

    it('挂上时问一次,两样都问', async () => {
      const { requested } = mount({ onOpenNews: vi.fn(), news: { feed: NEWS(LOCAL), aidj: 404 } });
      await screen.findByRole('button', { name: LIT });
      expect(requested.filter((path) => path === '/feed')).toHaveLength(1);
      expect(requested.filter((path) => path === '/feed/aidj')).toHaveLength(1);
    });
  });

  /*
   * 会议那颗(2026-10-04,卡「首页会议图标」)。维护者:「再开张卡,把会议模式一样拿出来到右边的侧边栏上」。
   * 在这之前它只在「记录 → 对话记录页 → 顶上那排小链接」里 —— 藏了三层。
   */
  it('★会议那颗是这一排最后一颗:点下去就是会议页那一处;记录面板里那颗照旧留着(第二条路)', async () => {
    const onOpenMeeting = vi.fn();
    mount({ onOpenMeeting, onOpenHistory: vi.fn(), onOpenInbox: vi.fn(), onOpenCalls: vi.fn(), onOpenNews: vi.fn() });
    await act(async () => {});
    const rail = document.querySelector<HTMLElement>('.ba-scene__stage > .ba-rail')!;
    const titles = within(rail).getAllByRole('button').map((one) => one.getAttribute('title'));
    expect(titles[titles.length - 1]).toBe(RAIL_MEETING_NAME);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: `打开「${RAIL_MEETING_NAME}」` })); });
    expect(onOpenMeeting).toHaveBeenCalledTimes(1);

    // 记录面板里那颗一个字没动:两条路进同一处。
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '记录' })); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: RAIL_MEETING_NAME })); });
    expect(onOpenMeeting).toHaveBeenCalledTimes(2);
  });

  /*
   * ★整页一起看:一个图只表达一个意思(2026-10-04)。
   * 维护者撞上的那件事:「未接来电和现在输入框的通话是同一个」—— 首页上同一个话筒出现在两处,
   * 一个是「看我错过的电话」、一个是「现在打出去」。所以这一条数的是**整页所有图标**
   * (这一排六颗 + 输入条那几颗 + 顶上那两颗),不许有重复的 `data-icon`。
   */
  it('★首页上没有两处用同一个图标(输入条那颗「打出去」只归它自己)', async () => {
    mount({
      onOpenMeeting: vi.fn(), onOpenHistory: vi.fn(), onOpenInbox: vi.fn(), onOpenCalls: vi.fn(),
      onOpenNews: vi.fn(), onOpenSettings: vi.fn(), missed: { log: parseCallLog({ missed: 0, entries: [] }) },
    });
    await act(async () => {});
    const names = [...document.querySelectorAll('[data-icon]')].map((one) => one.getAttribute('data-icon')!);
    expect(names.length).toBeGreaterThan(8);
    expect([...new Set(names)].sort()).toEqual([...names].sort());
    // 输入条那颗「打出去」照旧是不带记号的话筒;这一排的未接是打叉那一个。
    expect(screen.getByRole('button', { name: /^通话/ }).querySelector('[data-icon="phone"]')).toBeTruthy();
    expect(screen.getByRole('button', { name: `${RAIL_MISSED_NAME},一条都没有` }).querySelector('[data-icon="phone-off"]')).toBeTruthy();
    // 「按住说话」照旧是麦克风;会议那颗是头戴耳麦。
    expect(screen.getByRole('button', { name: '按住说话' }).querySelector('[data-icon="microphone"]')).toBeTruthy();
    expect(screen.getByRole('button', { name: `打开「${RAIL_MEETING_NAME}」` }).querySelector('[data-icon="headset"]')).toBeTruthy();
  });

  it('★没传 onOpenMeeting(没有去处)→ 会议那颗整个不画,另外几颗照旧在(D13)', async () => {
    mount({ onOpenHistory: vi.fn(), onOpenNews: vi.fn() });
    await act(async () => {});
    expect(screen.queryByRole('button', { name: `打开「${RAIL_MEETING_NAME}」` })).toBeNull();
    expect(screen.getByRole('button', { name: LABEL })).toBeTruthy();
    expect(screen.getByRole('button', { name: `打开「${RAIL_NEWS_NAME}」` })).toBeTruthy();
  });

  it('一张纪要卡都没有时「最近一次通话」那颗照样在:点下去是通话记录那一页(它自己说还没有)', async () => {
    const onOpenCalls = vi.fn();
    mount({ onOpenCalls });
    await act(async () => {});
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: `打开「${RAIL_CALLS_NAME}」` })); });
    expect(onOpenCalls).toHaveBeenCalledWith(undefined);
  });

  it('电脑没连上(卡片收成「上次的数据」那一行)时也在 —— 入口不许跟着数据一起消失', async () => {
    const { feed } = mount({ onOpenHistory: vi.fn() });
    await act(async () => { feed.set(replyState('版本号补好了。')); });
    await act(async () => { feed.setConnected(false); });
    expect(document.querySelector('.ba-cards--stale')).toBeTruthy();
    expect(screen.getByRole('button', { name: LABEL })).toBeTruthy();
  });

  it('★未接那颗:角标写真数;点一下**原来那一块**就铺开(回拨 / 清空 / 明细照旧),「收起」收掉', async () => {
    mount({ missed: { log: parseCallLog(RAW_LOG) }, onOpenHistory: vi.fn() });
    await act(async () => {});
    expect(document.querySelector('.ba-rail__badge')?.textContent).toBe('2');
    // 没点之前主列与那一块都没有未接(侧边那颗就是收起来的样子)。
    expect(document.querySelector('.ba-missed')).toBeNull();

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: `${RAIL_MISSED_NAME} 2` })); });
    const sheet = document.querySelector('.ba-scene__stage > .ba-rail-sheet')!;
    expect(sheet.querySelector('.ba-missed')).toBeTruthy();
    expect(document.querySelectorAll('.ba-missed__row')).toHaveLength(2);
    expect(screen.getByRole('button', { name: MISSED_CLEAR_LABEL })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: '回拨' }).length).toBeGreaterThan(0);

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: MISSED_FOLD_LABEL })); });
    expect(document.querySelector('.ba-rail-sheet')).toBeNull();
  });

  it('★已经收场的事引起的未接不算:角标跟着那一份 /state 走(2 → 1)', async () => {
    const { feed } = mount({ missed: { log: parseCallLog(RAW_LOG) } });
    await act(async () => {});
    expect(document.querySelector('.ba-rail__badge')?.textContent).toBe('2');
    await act(async () => {
      feed.set({
        ...emptyState(), now: '2026-10-03T07:00:00Z', stale: false,
        tasks: { tasks: [{ id: 't-confirm', title: '我的规矩有哪些?', status: 'canceled', direction: 'mine', created_at: 'a', updated_at: 'b' }] },
      } as unknown as WorkbenchState);
    });
    expect(document.querySelector('.ba-rail__badge')?.textContent).toBe('1');
  });

  it('★一条都没有:图标在、不画角标、点下去不开空的一块,只飘一句说清它是什么', async () => {
    mount({ missed: { log: parseCallLog({ missed: 0, entries: [] }) } });
    await act(async () => {});
    const button = screen.getByRole('button', { name: `${RAIL_MISSED_NAME},一条都没有` });
    expect(document.querySelector('.ba-rail__badge')).toBeNull();
    await act(async () => { fireEvent.click(button); });
    expect(document.querySelector('.ba-rail-sheet')).toBeNull();
    expect(screen.getByRole('alert').textContent).toBe(RAIL_MISSED_NONE_TEXT);
  });

  it('通话中整列不画(整屏只有一件事在发生,同卡片区那条老规矩)', async () => {
    const fake = fakeCallClient();
    mount({ onOpenHistory: vi.fn(), onOpenMeeting: vi.fn(), missed: { log: parseCallLog(RAW_LOG) }, callStatus: { configured: true, checked: true }, createCallClient: () => fake.client });
    await act(async () => {});
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^通话/ })); });
    await waitFor(() => expect(screen.queryByRole('button', { name: LABEL })).toBeNull());
    expect(document.querySelector('.ba-rail')).toBeNull();
    // 会议那颗跟着整排走(它和另外五颗在同一个 `!inCall && onboarding === undefined` 里)。
    expect(screen.queryByRole('button', { name: `打开「${RAIL_MEETING_NAME}」` })).toBeNull();
  });
});

/**
 * 「等你确认」里别家的会话(2026-10-03,审计第四节第 1、2 条):首页那一行与点进去那张卡**查的是同一份会话**。
 * 10-03 之前点进去只在 `state.sessions` 里找 —— 窗口型会话只在登记表里,首页有行、详情只剩一行字,键一颗都不渲染;
 * 老插件下发的冒号键同样对不上。下面两条就是审计 `devices/ui.test.tsx.template` 的两个 DOM 反例反过来写。
 */
describe('舞台页 · 等你确认里别家的会话:首页列得出的,点进去就答得了', () => {
  const ASK = {
    kind: 'choose', question: '继续还是停止?', since: '2026-10-03T00:00:00Z', by: 'form', reply: 'window',
    press: true, write: true, options: [{ label: '继续' }, { label: '停止' }],
  };

  it('★只在登记表里的窗口型会话(sessions 是空的):点首页那一行,详情有选项键与「我自己说」', async () => {
    const { feed } = mount();
    const one = {
      agent: 'doubao', session_id: 'window:abc', via: 'window', status: 'waiting', title: '审计夹具',
      project: 'p', elapsed_sec: 0, unread: false, updated_at: '2026-10-03T00:00:00Z', ask: ASK,
    };
    const current = {
      ...emptyState(), now: '2026-10-03T00:00:00Z', stale: false, sessions: [],
      agent_registry: { entries: [{ id: 'doubao', name: '豆包办公', status: 'waiting', gaps: {}, sessions: [one], counts: { running: 0, waiting: 1, unread: 0 } }], asking: [], notices: [] },
      // 工作台算好的那一行(`waiting.ts` 的 waitingSessions 两路都数;键的拼法由 session-job-key-sync 钉着与插件一致)。
      waiting: { count: 1, items: [{ key: 'session:doubao/window:abc', kind: 'session', verb: '答', text: '豆包办公在等你选:继续还是停止?' }] },
    };
    act(() => feed.set(current as never));
    await act(async () => { fireEvent.click(document.querySelector('.ba-cards__linetap')!); });
    const page = await screen.findByRole('dialog', { name: '等你确认' });
    expect(page.textContent).toContain('继续还是停止');
    expect(within(page).getByRole('button', { name: '继续' })).toBeTruthy();
    expect(within(page).getByLabelText('我自己说')).toBeTruthy();
    expect(page.querySelector('.ba-asks-page__done')).toBeNull();
  });

  it('★老插件下发的冒号键(session:<家>:<id>):新手机照样找到那条会话,键照样渲染', async () => {
    const { feed } = mount();
    const one = {
      agent: 'codex', session_id: 'cx1', status: 'waiting', title: '审计夹具',
      project: 'p', elapsed_sec: 0, unread: false, updated_at: '2026-10-03T00:00:00Z', ask: ASK,
    };
    const current = {
      ...emptyState(), now: '2026-10-03T00:00:00Z', stale: false, sessions: [one],
      waiting: { count: 1, items: [{ key: 'session:codex:cx1', kind: 'session', verb: '答', text: 'Codex 在等你选:继续还是停止?' }] },
    };
    act(() => feed.set(current as never));
    await act(async () => { fireEvent.click(document.querySelector('.ba-cards__linetap')!); });
    const page = await screen.findByRole('dialog', { name: '等你确认' });
    expect(within(page).getByRole('button', { name: '继续' })).toBeTruthy();
    expect(page.querySelector('.ba-asks-page__done')).toBeNull();
  });

  /*
   * ★ **送上去的那颗键 = 工作台下发的那一颗,原样回传**(2026-10-03,统筹把审计第四节那条「上行」裁进这张卡)。
   *
   * 认键容两种只治了下行(那几颗键渲染得出来);按下去走的 `POST /asks/answer` 要是拿家名与会话 id
   * **重拼**一颗新键,新手机连老插件就按不动 —— 老插件只认冒号键。回传不是「拼键」,所以与
   * 「拼键只用新的」不冲突;新插件那一侧两种都收(`server/http.ts` 的 `/asks/answer`)。
   *
   * 这两条走的是**替她点 / 替她写**那条路(`ask.reply === 'desk'` + `press` / `write`)——
   * `reply: 'window'` 那一档点选项走的是 `/sessions/answer`(带 agent + session_id,没有键),
   * 上面那两条反例用的就是那一档,所以键只能在这里钉。
   */
  const DESK_ASK = { ...ASK, reply: 'desk', where: '这一问得在电脑上那家的窗口里点' };

  async function openOne(current: unknown) {
    const { feed, sent } = mount();
    act(() => feed.set(current as never));
    await act(async () => { fireEvent.click(document.querySelector('.ba-cards__linetap')!); });
    return { page: await screen.findByRole('dialog', { name: '等你确认' }), sent };
  }

  it('★老插件下发的冒号键:点「继续」送回去的还是那一颗冒号键(不重拼成斜杠)', async () => {
    const one = {
      agent: 'codex', session_id: 'cx1', status: 'waiting', title: '审计夹具',
      project: 'p', elapsed_sec: 0, unread: false, updated_at: '2026-10-03T00:00:00Z', ask: DESK_ASK,
    };
    const { page, sent } = await openOne({
      ...emptyState(), now: '2026-10-03T00:00:00Z', stale: false, sessions: [one],
      waiting: { count: 1, items: [{ key: 'session:codex:cx1', kind: 'session', verb: '答', text: 'Codex 在等你选:继续还是停止?' }] },
    });
    await act(async () => { fireEvent.click(within(page).getByRole('button', { name: '继续' })); });
    const pressed = sent.find((one) => one.startsWith('ask '));
    expect(pressed).toBeDefined();
    expect(pressed).toContain('"key":"session:codex:cx1"');
    expect(pressed).toContain('"choice":"继续"');
    // 「我自己说」那一句同一颗键(卡 AT 那条路也经 /asks/answer)。
    await act(async () => { fireEvent.change(within(page).getByLabelText('我自己说'), { target: { value: '两个都不要' } }); });
    await act(async () => { fireEvent.click(within(page).getByRole('button', { name: '回复' })); });
    const asked = sent.filter((one) => one.startsWith('ask '));
    const said = asked[asked.length - 1];
    expect(said).toContain('"key":"session:codex:cx1"');
    expect(said).toContain('"text":"两个都不要"');
  });

  it('新插件下发的新键(只在登记表里的窗口型):送回去的就是那一颗斜杠键', async () => {
    const one = {
      agent: 'doubao', session_id: 'window:abc', via: 'window', status: 'waiting', title: '审计夹具',
      project: 'p', elapsed_sec: 0, unread: false, updated_at: '2026-10-03T00:00:00Z', ask: DESK_ASK,
    };
    const { page, sent } = await openOne({
      ...emptyState(), now: '2026-10-03T00:00:00Z', stale: false, sessions: [],
      agent_registry: { entries: [{ id: 'doubao', name: '豆包办公', status: 'waiting', gaps: {}, sessions: [one], counts: { running: 0, waiting: 1, unread: 0 } }], asking: [], notices: [] },
      waiting: { count: 1, items: [{ key: 'session:doubao/window:abc', kind: 'session', verb: '答', text: '豆包办公在等你选:继续还是停止?' }] },
    });
    await act(async () => { fireEvent.click(within(page).getByRole('button', { name: '继续' })); });
    const pressed = sent.find((one) => one.startsWith('ask '));
    expect(pressed).toContain('"key":"session:doubao/window:abc"');
  });

  /*
   * ★ **那一条带上前因后果**(2026-10-04,卡 `claude/ask-with-context`)。维护者原话:
   * 「麻烦的是每次要确认内容的信息都很短,我都不知道发生了什么,还得自己去最近的会话找上下文,这个不好」。
   *
   * 这三条挂的是真 `StagePage`:问题全文、它刚才在干什么(最近几轮原文,走现成的 `GET /sessions/digest`)、
   * 读不到时如实说、以及底下那颗「打开整段对话」真的开出那一页。
   */
  const LONG = [
    '导出 PDF 这件事有两条路:一条是在工作台里自己排版(字体、页边距都要自己定,好处是以后改样式不用动别人的东西);',
    '另一条是调系统的打印那一路(样子跟她在浏览器里按 ⌘P 一样,坏处是页眉页脚改不了)。',
    '两条路工期差不多,差别只在以后改样式方便不方便。你要哪一条?',
  ].join('');

  function askingState(ask: Record<string, unknown>) {
    const one = {
      agent: 'codex', session_id: 'cx1', status: 'waiting', title: '加个导出 PDF',
      project: 'desktop-workbench', elapsed_sec: 0, unread: false, updated_at: '2026-10-03T00:00:00Z', ask,
    };
    return {
      ...emptyState(), now: '2026-10-03T00:00:00Z', stale: false, sessions: [one],
      waiting: { count: 1, items: [{ key: 'session:codex/cx1', kind: 'session', verb: '答', text: 'Codex 在等你选:导出 PDF 这件事有两条路' }] },
    };
  }

  const DIGEST = {
    agent: 'codex', session_id: 'cx1', project: 'desktop-workbench', status: 'waiting', title: '加个导出 PDF',
    read_at: '2026-10-03T00:00:00Z',
    rounds: [
      { ask: '加个导出 PDF', reply: '好,我先看这一页现在是怎么画的。', did: '读了 3 个文件', at: '2026-10-02T23:58:00Z' },
      { reply: '看完了,两条路都走得通。', did: '读了 2 个文件', at: '2026-10-03T00:00:00Z' },
    ],
  };

  it('★问题全文摆出来(不是 60 字那一句),它刚才那几轮原样摆,项目也在', async () => {
    const { feed } = mount({ digest: DIGEST });
    act(() => feed.set(askingState({ ...ASK, question: '导出 PDF 这件事有两条路:一条是在工作台里自己排…', full: { question: LONG, header: '导出 PDF 走哪一条' } }) as never));
    await act(async () => { fireEvent.click(document.querySelector('.ba-cards__linetap')!); });
    const page = await screen.findByRole('dialog', { name: '等你确认' });
    // 问的是什么:原文一个字不少。
    expect(within(page).getByTestId('ask-say').textContent).toContain(LONG);
    expect(page.textContent).toContain('导出 PDF 走哪一条');
    // 它刚才在干什么:她说的 / 它说的,原样 + 在哪个项目。
    await waitFor(() => { expect(page.textContent).toContain('好,我先看这一页现在是怎么画的。'); });
    expect(page.textContent).toContain('看完了,两条路都走得通。');
    expect(page.textContent).toContain('在「desktop-workbench」项目里');
    // 作答那几样一个都没少。
    expect(within(page).getByRole('button', { name: '继续' })).toBeTruthy();
  });

  it('★读不到前面的对话(离线 / 走中转):如实一句,那一问照样答得了', async () => {
    const { feed, sent } = mount();
    act(() => feed.set(askingState({ ...DESK_ASK, full: { question: LONG } }) as never));
    await act(async () => { fireEvent.click(document.querySelector('.ba-cards__linetap')!); });
    const page = await screen.findByRole('dialog', { name: '等你确认' });
    await waitFor(() => { expect(page.textContent).toContain('这会儿取不到前面的对话'); });
    await act(async () => { fireEvent.click(within(page).getByRole('button', { name: '继续' })); });
    expect(sent.find((one) => one.startsWith('ask '))).toContain('"choice":"继续"');
  });

  it('★底下那颗「打开整段对话」:点下去开出那条会话的详情页(返回回到那一问)', async () => {
    const { feed } = mount({ digest: DIGEST });
    act(() => feed.set(askingState({ ...ASK, full: { question: LONG } }) as never));
    await act(async () => { fireEvent.click(document.querySelector('.ba-cards__linetap')!); });
    const page = await screen.findByRole('dialog', { name: '等你确认' });
    await act(async () => { fireEvent.click(within(page).getByRole('button', { name: '打开整段对话' })); });
    const detail = await screen.findByRole('dialog', { name: '会话详情' });
    expect(detail.textContent).toContain('加个导出 PDF');
    // 收起来之后那一问还在原地(她答完还在「等你确认」那一页上)。
    await act(async () => { fireEvent.click(within(detail).getByRole('button', { name: '关闭' })); });
    expect(screen.queryByRole('dialog', { name: '会话详情' })).toBeNull();
    expect(screen.getByRole('dialog', { name: '等你确认' })).toBeTruthy();
  });
});

/**
 * 通话中把那段视频弹到眼前(2026-10-12,周三演示「出图进可灵」那条链路的末尾)。
 *
 * 维护者原话:「看到视频之后推到手机端上,再打个电话过来,并且可以在手机上(通话过程中)看到视频。
 * 播放器以弹窗形式弹到通话页面上,给个关闭的 icon。」
 */
describe('通话中电脑推来一段视频(2026-10-12)', () => {
  const VIDEO_ASK = [{
    id: 'ask-v',
    request: '把片子发我手机',
    query: '片子',
    device: '书房 Mac',
    hits: [{ offer: 'o-v', name: '成片.mp4', where: '桌面', bytes: 4, kind: 'video' }],
    total: 1,
  }];

  /** 原生桥的假实现:存得下、给得出 `file://` 地址(弹窗要拿它放)。 */
  function fakeSink(): WbchFileSinkDeps {
    return {
      loadFilesystem: async () => ({
        Filesystem: {
          writeFile: async () => ({}),
          appendFile: async () => ({}),
          getUri: async (o: Record<string, unknown>) => ({ uri: `file:///documents/${String(o.path)}` }),
        },
        Directory: { Documents: 'DOCUMENTS' },
      }),
    };
  }

  async function enterCallWith(options: MountOptions) {
    const fake = fakeCallClient();
    const mounted = mount({ callStatus: { configured: true, checked: true }, createCallClient: () => fake.client, ...options });
    const button = screen.getByRole('button', { name: '通话' });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    await act(async () => { fireEvent.click(button); });
    act(() => { fake.emit(on => on.onPhase('connected')); });
    await screen.findByText('通话中');
    // `fake` 也交出去:挂断之后要能再打一通(卡 E 那两条)。
    return { ...mounted, fake };
  }

  it('★视频自己取、自己弹:弹窗里就是那段片子,顶上写着文件名,一颗 × 关掉它(电话不断)', async () => {
    const { sent } = await enterCallWith({ pending: VIDEO_ASK, offerBody: '视频字节', fileSink: fakeSink() });
    const popup = await screen.findByRole('dialog', { name: '视频 成片.mp4' });
    await waitFor(() => expect(popup.querySelector('video')?.getAttribute('src')).toBe('file:///documents/%E4%BA%8B%E5%8A%A1%E5%AE%98/%E6%88%90%E7%89%87.mp4'));
    // 取的是同一条路:那张「收到了」的回执照样报上去。
    await waitFor(() => expect(sent.find((one) => one.startsWith('received '))).toContain('"offer":"o-v"'));
    // 底下那三颗键照旧点得到(弹窗不盖住挂断)。
    expect([...document.querySelectorAll('.ba-call__dock button')].map((b) => b.getAttribute('aria-label'))).toEqual(['关掉麦克风', '挂断', '显示字幕']);
    expect(document.querySelector('.ba-scene__scrim')).toBeNull();
    // 关掉:弹窗没了,电话还在(「通话中」还写着)。
    await act(async () => { fireEvent.click(within(popup).getByRole('button', { name: '关掉视频' })); });
    expect(screen.queryByRole('dialog', { name: '视频 成片.mp4' })).toBeNull();
    expect(screen.getByText('通话中')).toBeTruthy();
    // 关过的不再弹回来(轮询照旧在问)。
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    expect(screen.queryByRole('dialog', { name: '视频 成片.mp4' })).toBeNull();
  });

  it('取不到就说一句实话,× 还在(单号没了:404,不换路重试)', async () => {
    await enterCallWith({ pending: VIDEO_ASK, fileSink: fakeSink() });
    const popup = await screen.findByRole('dialog', { name: '视频 成片.mp4' });
    await waitFor(() => expect(popup.textContent).toContain('视频没取到:'));
    expect(within(popup).getByRole('button', { name: '关掉视频' })).toBeTruthy();
  });

  it('不是视频的不在通话中弹(照旧等挂了电话再摆那张卡)', async () => {
    await enterCallWith({
      pending: [{ ...VIDEO_ASK[0], hits: [{ offer: 'o-p', name: '稿子.pdf', where: '桌面', bytes: 4, kind: 'pdf' }] }],
      offerBody: 'PDF',
      fileSink: fakeSink(),
    });
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    expect(screen.queryByRole('dialog', { name: '视频 稿子.pdf' })).toBeNull();
    expect(screen.queryByRole('dialog', { name: '发到这台手机' })).toBeNull();
  });

  /**
   * **通话结束把这个播放器收掉**(2026-10-13,卡 E 第 2 条;交接-1013-统筹-四场景验收 第三节 12)。
   * 10-13 下午他再打出去时,上一通的那个弹窗还在 —— 原来它只在他点 × 时才清,
   * 而拨出去那条路上这一页**不重挂**(同一个 StagePage,只是 `inCall` 翻了一下)。
   */
  it('★挂断就把播放器收掉;再打一通,屏上不带着上一通那段片子(10-13 撞的那一下)', async () => {
    const { fake } = await enterCallWith({ pending: VIDEO_ASK, offerBody: '视频字节', fileSink: fakeSink() });
    const popup = await screen.findByRole('dialog', { name: '视频 成片.mp4' });
    await waitFor(() => expect(popup.querySelector('video')).toBeTruthy());

    // 挂断(他自己按的那颗):弹窗没了,片子也不在页上接着放。
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '挂断' })); });
    await waitFor(() => expect(screen.getByLabelText('打字说给事务官')).toBeTruthy());
    expect(screen.queryByRole('dialog', { name: '视频 成片.mp4' })).toBeNull();
    expect(document.querySelector('video')).toBeNull();

    // 第二通:干净的通话页(那张卡已经办过,也不会再弹一遍)。
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '通话' })); });
    act(() => { fake.emit(on => on.onPhase('connected')); });
    await screen.findByText('通话中');
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    expect(screen.queryByRole('dialog', { name: '视频 成片.mp4' })).toBeNull();
    expect(document.querySelector('video')).toBeNull();
  });

  it('★对方挂了也一样收掉(电脑那头先放下:不是他按的那颗键)', async () => {
    const { fake } = await enterCallWith({ pending: VIDEO_ASK, offerBody: '视频字节', fileSink: fakeSink() });
    const popup = await screen.findByRole('dialog', { name: '视频 成片.mp4' });
    await waitFor(() => expect(popup.querySelector('video')).toBeTruthy());

    await act(async () => { fake.emit(on => on.onRemoteHangup?.()); });
    await waitFor(() => expect(screen.getByLabelText('打字说给事务官')).toBeTruthy());
    expect(screen.queryByRole('dialog', { name: '视频 成片.mp4' })).toBeNull();

    // 同上:下一通也不许把它带回来(这一条才是 10-13 他看见的那一幕)。
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '通话' })); });
    act(() => { fake.emit(on => on.onPhase('connected')); });
    await screen.findByText('通话中');
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    expect(screen.queryByRole('dialog', { name: '视频 成片.mp4' })).toBeNull();
  });
});

/**
 * 通话中 / 挂断后不自动念(2026-10-13,卡 E 第 1 条;交接-1013-统筹-四场景验收 第三节 7)。
 *
 * 10-13 真机:他在电话里交代的事,豆包交回那段回话一到聊天页就被念了 —— 通话中也念,挂断后接着念。
 * 维护者拍板:「挂断后手机不许再出声;通话中也不该自顾自念」。
 * 这两条的零件(代号、记成念过、重听照念)在 `tests/callHush.test.tsx`;这里走的是整页那一幕。
 */
describe('舞台页 · 通话中 / 挂断后不自动念(2026-10-13)', () => {
  it('★通话中来的那条回话一声不出;挂断之后也不补念,而「记录」里一字不少', async () => {
    const fake = fakeCallClient();
    const { feed } = mount({ tts: true, callStatus: { configured: true, checked: true }, createCallClient: () => fake.client, captionHoldMs: 5000 });
    await act(async () => {});
    // 打开 App 时已经在那儿的那条标成念过(2026-09-26 卡 QH 的老规矩)。
    act(() => feed.set(replyState('先有的一条。', 't-0')));
    await act(async () => {});
    expect(player.played).toBe(0);

    const button = screen.getByRole('button', { name: '通话' });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    await act(async () => { fireEvent.click(button); });
    act(() => { fake.emit(on => on.onPhase('connected')); });
    await screen.findByText('通话中');

    // 电话里交代的那件事有了回话:一声不出(球下那一格通话中归通话字幕,这条回话不往那儿挤)。
    act(() => feed.set(replyState('豆包那段回话。', 't-1')));
    await act(async () => {});
    expect(player.played).toBe(0);

    // 挂断:不补念,顶上也没有「停止朗读」那一颗(它压根没在念)。
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '挂断' })); });
    await waitFor(() => expect(screen.getByLabelText('打字说给事务官')).toBeTruthy());
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    expect(player.played).toBe(0);
    expect(screen.queryByRole('button', { name: '停止朗读' })).toBeNull();

    // 不出声不等于不告诉他:那段回话在「记录」里一字不少(他要听就点那儿的「重听」)。
    fireEvent.click(screen.getByRole('button', { name: '记录' }));
    expect(document.querySelector('.ba-scene__log')?.textContent).toContain('豆包那段回话。');
  });

  it('不在通话里那条照念 —— 拦的是通话中那一声,不是把朗读关了', async () => {
    const { feed } = mount({ tts: true });
    await act(async () => {});
    act(() => feed.set(replyState('先有的一条。', 't-0')));
    await act(async () => {});
    act(() => feed.set(replyState('刚办完,版本号补好了。', 't-1')));
    await act(async () => {});
    expect(player.played).toBe(1);
  });
});
