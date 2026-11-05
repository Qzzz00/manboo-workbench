/**
 * 免打扰时段不朗读、不出声(2026-09-26,卡 QH)。
 *
 * ## 撞出来的事
 *
 * 09-26 00:19,统筹在小米测试机上冷启动 App(装 0.3.4 之后),首页顶上出现「停止朗读」—— 半夜在念东西。
 * 维护者设的免打扰是 21:00–08:30(`/call/config`);来电那条路早就照它只发通知不响铃,**朗读没照它**,
 * 因为时段判断只长在座机那条路里。
 *
 * ## 这一份守什么
 *
 * 1. **时段内不自动念**(字幕、气泡照常出 —— 免打扰是不出声,不是不告诉他);
 * 2. **他自己点「重听」照念**(维护者:「他主动按下『播放 / 朗读』的,不拦」);
 * 3. 时段内首页顶上那一颗改说**为什么没声**:「免打扰中 · 08:30 后恢复」,点了不出声、飘一句人话;
 * 4. 时段外一切照旧;
 * 5. **拦掉的照旧记成「念过了」**:不然 08:30 一到,凌晨三点那条回复会突然被念出来。
 *
 * 判断在服务端(`workbench-plugin/src/server/quietHours.ts` → `/state.quiet`),这里只验手机怎么读它。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { StagePage } from '../src/stage/StagePage';
import { useSpeak } from '../src/chat/useSpeak';
import { mayMakeSound, quietActive, quietHushLabel, quietWhyText } from '../src/chat/quietVoice';
import type { QuietView, WorkbenchState } from '../src/api/protocol';
import { emptyState, snapshotArrived } from '../src/api/protocol';
import type { ThreadMessage } from '../src/chat/chatModel';
import { SessionContext, type Session } from '../src/session';
import { SettingsContext } from '../src/settings/SettingsContext';
import { createSettingsStore, DEFAULT_SETTINGS } from '../src/settings/settingsStore';
import { createApiClient } from '../src/api/client';
import { createVoiceApi } from '../src/api/voice';
import { createCallApi } from '../src/api/call';
import { createAppearanceFeed } from '../src/swarm/appearance';
import type { FeedSnapshot, StateFeed } from '../src/api/stateFeed';
import { AvatarContext } from '../src/live2d/AvatarContext';
import { NO_AVATAR_TEXT, type AvatarState } from '../src/live2d/useAvatar';
import type { KeyValueStore } from '../src/api/tokenStore';
import { fakeChannel, fakeRouted } from './wbchFakes';
import type { WbchMode } from '../src/channel/channelProtocol';

/** 放的每一段都记一笔:断言「到底出没出声」认的就是这个计数,不是界面上的字。 */
const player = vi.hoisted(() => ({ played: 0, hold: false, end: null as null | (() => void) }));
vi.mock('../src/aiboo/lipsyncPlayer', () => ({
  playAudioBlob: async (_b: Blob, _m: () => void, onEnded?: () => void) => {
    player.played += 1;
    if (player.hold) { player.end = () => onEnded?.(); return; }
    onEnded?.();
  },
  stopSpeaking: () => { player.end?.(); player.end = null; },
  isSpeaking: () => false,
}));

/** 录音本体假掉(真 hook 在 tests/holdToTalk.test.tsx):这一页挂着它,但这一份一次都不按。 */
vi.mock('../src/aiboo/useVoiceRecorder', async () => {
  const { useRef, useState } = await import('react');
  return {
    MIC_PERMISSION_TEXT: '没有录音权限',
    useVoiceRecorder() {
      const [state] = useState<{ status: string }>({ status: 'idle' });
      const audioLevelRef = useRef(0);
      return { state, audioLevelRef, async startRecording() {}, stopRecording() { return null; }, cancelRecording() {} };
    },
  };
});

/** 维护者真机上那一档。 */
const NIGHT: QuietView = { active: true, from: '21:00', to: '08:30', until: '08:30', reason: '免打扰时段' };
const DAY: QuietView = { active: false, from: '21:00', to: '08:30' };

afterEach(() => {
  player.played = 0;
  player.hold = false;
  player.end = null;
  try { sessionStorage.clear(); } catch { /* jsdom 没有就算了 */ }
});

// ———————————————————————— 纯函数:出不出声 + 说什么 ————————————————————————

describe('quietVoice:出不出声、说什么', () => {
  it('★缺席按「能出声」算:老工作台没有这一格,不替他把声音关掉', () => {
    expect(quietActive(undefined)).toBe(false);
    expect(mayMakeSound(undefined, false)).toBe(true);
  });

  it('★免打扰时段里:自己冒出来的那一声不出,他按的照出', () => {
    expect(mayMakeSound(NIGHT, false)).toBe(false);
    expect(mayMakeSound(NIGHT, true)).toBe(true);
  });

  it('时段外:两种都出', () => {
    expect(mayMakeSound(DAY, false)).toBe(true);
    expect(mayMakeSound(DAY, true)).toBe(true);
  });

  it('★那一行说人话:「免打扰中 · 08:30 后恢复」', () => {
    expect(quietHushLabel(NIGHT)).toBe('免打扰中 · 08:30 后恢复');
  });

  it('拿不到「几点恢复」时只说前半句,**不编一个时刻**', () => {
    expect(quietHushLabel({ active: true })).toBe('免打扰中');
  });

  it('★点了之后那句话:为什么没声 + 还能怎么听 + 去哪儿改;不出现命令行 / 键名这类词', () => {
    const why = quietWhyText(NIGHT);
    expect(why).toContain('21:00 到 08:30');
    expect(why).toContain('照样出字');
    expect(why).toContain('重听');
    expect(why).toContain('设置');
    expect(why).not.toMatch(/quiet|TTS|接口|字段|命令/i);
  });
});

// ———————————————————————— useSpeak:自动念 vs 他点重听 ————————————————————————

function fakeSession(): Session {
  return {
    client: { mode: () => 'direct' },
    voice: { tts: async () => ({ ok: true as const, status: 200, data: new Blob([new Uint8Array([1])]) }) },
  } as unknown as Session;
}

function reply(id: string, text: string): ThreadMessage {
  return { taskId: id, butler: { kind: 'reply', text } } as unknown as ThreadMessage;
}

describe('useSpeak:免打扰时段', () => {
  it('★时段内:新回复不自动念(一声都没出)', async () => {
    const { result } = renderHook(() => useSpeak(fakeSession(), true, undefined, { current: 0 }, undefined, NIGHT));
    // 第一拍把已有的标成读过(这是打开 App 时的老规矩)。
    act(() => { result.current.speakNewReplies([]); });
    await act(async () => { result.current.speakNewReplies([reply('t-1', '版本号补好了。')]); });
    expect(player.played).toBe(0);
  });

  it('时段外:新回复照念', async () => {
    const { result } = renderHook(() => useSpeak(fakeSession(), true, undefined, { current: 0 }, undefined, DAY));
    act(() => { result.current.speakNewReplies([]); });
    await act(async () => { result.current.speakNewReplies([reply('t-1', '版本号补好了。')]); });
    expect(player.played).toBe(1);
  });

  it('★时段内他自己点「重听」:照念 —— 那是他要听的,不是打扰', async () => {
    const { result } = renderHook(() => useSpeak(fakeSession(), true, undefined, { current: 0 }, undefined, NIGHT));
    let why: string | undefined = 'x';
    await act(async () => { why = await result.current.speakText('t-1:好', '好'); });
    expect(player.played).toBe(1);
    expect(why).toBeUndefined();
  });

  it('★时段内拦掉的照旧记成「念过了」:08:30 恢复之后不再把凌晨那条补念一遍', async () => {
    const quiet = { value: NIGHT };
    const { result, rerender } = renderHook(
      ({ q }: { q: QuietView }) => useSpeak(fakeSession(), true, undefined, { current: 0 }, undefined, q),
      { initialProps: { q: quiet.value } },
    );
    act(() => { result.current.speakNewReplies([]); });
    const thread = [reply('t-1', '凌晨三点那条。')];
    await act(async () => { result.current.speakNewReplies(thread); });
    expect(player.played).toBe(0);
    // 天亮了(同一条 thread 又过一拍):它已经记成念过,不补念。
    rerender({ q: DAY });
    await act(async () => { result.current.speakNewReplies(thread); });
    expect(player.played).toBe(0);
  });
});

// ———————————————————————— 首页那一行 ————————————————————————

function memory(): KeyValueStore {
  const data = new Map<string, string>();
  return { async get(k) { return data.get(k) ?? null; }, async set(k, v) { data.set(k, v); }, async remove(k) { data.delete(k); } };
}

function fakeFeed(): StateFeed & { set(state: WorkbenchState): void } {
  let snapshot: FeedSnapshot = { state: emptyState(), connected: true, error: undefined };
  const listeners = new Set<() => void>();
  return {
    get: () => snapshot,
    subscribe(l) { listeners.add(l); return () => listeners.delete(l); },
    async refresh() {},
    stop() {},
    set(state) { snapshot = { ...snapshot, state }; listeners.forEach((l) => l()); },
  };
}

/**
 * 一条真回复挂在一件还开着的事上(同 StagePage.test.tsx 的 replyState)。
 *
 * **`now` 必须是真时刻**:工作台每一拍都填它,只有占位的 `emptyState()` 是空字符串。
 * 朗读那一层靠这一格认「第一份真快照到了」(`snapshotArrived`,卡 QH 统筹拍板那一条),
 * 留空就等于在假装「还没连上」。
 */
function replyState(text: string, quiet?: QuietView): WorkbenchState {
  return {
    ...emptyState(),
    now: '2026-09-26T00:19:00Z',
    stale: false,
    ...(quiet === undefined ? {} : { quiet }),
    sessions: [{ agent: 'dsh', session_id: 's-1', project: 'p', status: 'done', summary: text, elapsed_sec: 0, unread: true, updated_at: '2026-09-26T00:19:00Z' }],
    tasks: { tasks: [{ id: 't-1', status: 'confirm', title: '把版本号补一下', direction: 'mine', created_at: '2026-09-26T00:10:00Z', updated_at: '2026-09-26T00:19:00Z', conversation: { agent: 'dsh', session_id: 's-1' } }] },
  };
}

function mount(options: { mode?: WbchMode } = {}) {
  const pairing = { token: 't', host: 'h', port: 8791, deviceId: 'd' };
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    // 语音配好了:免打扰拦不住的话就会真念一声,player.played 数得出来。
    if (url.endsWith('/tts')) return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'audio/mpeg' } });
    if (url.endsWith('/devices/online')) return new Response(JSON.stringify({ devices: [], stale: false }), { status: 200, headers: { 'content-type': 'application/json' } });
    if (url.endsWith('/devices/transfers')) return new Response(JSON.stringify({ records: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify({ error: '没配' }), { status: 503 });
  }) as typeof fetch;
  const client = createApiClient({ pairing, fetchImpl, onUnauthorized: () => {} });
  const feed = fakeFeed();
  const session: Session = {
    pairing,
    client: fakeRouted(client, options.mode ?? 'direct'),
    direct: client,
    feed,
    voice: createVoiceApi(client),
    call: createCallApi(client),
    channel: fakeChannel({}),
    appearance: createAppearanceFeed(client),
    settings: createSettingsStore(memory()),
    unpair: async () => {},
  } as unknown as Session;
  const avatar: AvatarState = { status: 'placeholder', note: NO_AVATAR_TEXT, avatars: [] };
  const view = render(
    <SettingsContext.Provider value={{ settings: DEFAULT_SETTINGS, update: async () => {} }}>
      <SessionContext.Provider value={session}>
        <AvatarContext.Provider value={avatar}>
          <StagePage captionHoldMs={5000} captionFadeMs={60} captionMsPerChar={1} callTickMs={10} />
        </AvatarContext.Provider>
      </SessionContext.Provider>
    </SettingsContext.Provider>,
  );
  return { feed, view };
}

describe('首页 · 免打扰时段那一行', () => {
  it('★时段内:顶上写「免打扰中 · 08:30 后恢复」,字幕照常出,一声不出', async () => {
    const { feed } = mount();
    await act(async () => {});
    await act(async () => { feed.set(replyState('版本号补好了。', NIGHT)); });

    expect(await screen.findByRole('button', { name: /免打扰中/ })).toBeTruthy();
    // 界面照常:那句回答该出字还是出字。
    expect(screen.getByText('版本号补好了。')).toBeTruthy();
    expect(player.played).toBe(0);
  });

  it('★点了那一行:不出声,飘一句话说清为什么、还能怎么听', async () => {
    const { feed } = mount();
    await act(async () => {});
    await act(async () => { feed.set(replyState('版本号补好了。', NIGHT)); });

    fireEvent.click(await screen.findByRole('button', { name: /免打扰中/ }));

    expect(screen.getByText(quietWhyText(NIGHT))).toBeTruthy();
    expect(player.played).toBe(0);
  });

  it('时段外:没有那一行(常态不用说话)', async () => {
    const { feed } = mount();
    await act(async () => {});
    await act(async () => { feed.set(replyState('版本号补好了。', DAY)); });

    expect(screen.getByText('版本号补好了。')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /免打扰中/ })).toBeNull();
  });
});

// ———————————————————————— 冷启动那一幕 ————————————————————————

/**
 * **冷启动不念旧回答**(2026-09-26,卡 QH 第 4 条查清 + 统筹拍板)。
 *
 * 查出来的病根:`useSpeak.speakNewReplies` 的老规矩是「第一拍把已有的全标成念过,不从头念一遍」,
 * 可**第一拍发生在第一份 `/state` 到达之前** —— 那时 `feed.state` 还是 `emptyState()`、一条回复都没有,
 * 于是「已有的」是**空集**;第一份真快照一到,还开着的那几件事上的旧回答全成了「新出现的」,
 * 最新那条就被念了出来。所以**每次打开 App 都会念一遍上一条回答**(不只半夜,白天也一样)。
 *
 * 统筹 09-26 定:不念 —— 「他打开 App 是去看不是去听;念旧内容不合理;那行注释的意图本来就是不念」。
 * 落法是「第一拍」改认「收到第一份真快照」(`snapshotArrived`),没到之前什么都不做。
 * 下面四条分别钉:打开不念旧的、打开之后新来的照念、第一句回复不会被误吞、免打扰那一幕一声不出。
 */
describe('冷启动', () => {
  it('★打开 App 不念旧回答:第一份真快照里已经在那儿的,一声不出', async () => {
    const { feed } = mount();
    await act(async () => {});
    // 他昨天交代的那件事还开着,回答早就在那儿了 —— 不是这会儿新来的一句。
    await act(async () => { feed.set(replyState('这是他昨天那件事的回答。', DAY)); });
    await act(async () => {});

    expect(player.played).toBe(0);
  });

  it('★打开之后新来的那一句照念 —— 拦的只是旧的,不是把朗读关了', async () => {
    const { feed } = mount();
    await act(async () => {});
    await act(async () => { feed.set(replyState('这是他昨天那件事的回答。', DAY)); });
    await act(async () => {});
    expect(player.played).toBe(0);

    // 他刚交代的那件事有了回答:这一句是真的新,该念。
    await act(async () => { feed.set(replyState('刚办完,版本号补好了。', DAY)); });
    await act(async () => {});

    expect(player.played).toBe(1);
  });

  it('★他机器上本来一条回复都没有(全新装):第一句回复照念,不被当成「已有的」吞掉', async () => {
    const { feed } = mount();
    await act(async () => {});
    // 第一份真快照是空的 —— 新装的机器就是这样。
    await act(async () => { feed.set({ ...emptyState(), now: '2026-09-26T09:00:00Z', stale: false, quiet: DAY }); });
    await act(async () => {});

    await act(async () => { feed.set(replyState('记下了。', DAY)); });
    await act(async () => {});

    expect(player.played).toBe(1);
  });

  it('★免打扰时段里冷启动:一声不出(00:19 撞出这张卡的那一幕)', async () => {
    const { feed } = mount();
    await act(async () => {});
    await act(async () => { feed.set(replyState('这是他昨天那件事的回答。', NIGHT)); });
    await act(async () => {});

    expect(player.played).toBe(0);
    // 顶上不再是「停止朗读」(它压根没在念),而是「免打扰中 · 08:30 后恢复」。
    expect(screen.queryByRole('button', { name: '停止朗读' })).toBeNull();
    expect(screen.getByRole('button', { name: /免打扰中/ })).toBeTruthy();
  });
});

/**
 * 上面那四条走的是整页;这几条钉住机制本身的两块零件 —— 免得哪天有人把
 * `snapshotArrived` 改成看 `connected`(电脑掉线之后它翻 false,可手上那份状态还是真的)。
 */
describe('冷启动 · 零件', () => {
  it('★snapshotArrived 只认 now:占位那份是空字符串,真快照一定有时刻', () => {
    expect(snapshotArrived(emptyState())).toBe(false);
    expect(snapshotArrived({ ...emptyState(), now: '2026-09-26T00:19:00Z' })).toBe(true);
    // 电脑掉线之后 stale 会翻 true,可手上这份状态还是真的 —— 不许因为它就当没收到过。
    expect(snapshotArrived({ ...emptyState(), now: '2026-09-26T00:19:00Z', stale: true })).toBe(true);
  });

  it('★真快照没到那一拍:既不念,也不把空集记成「已有的」', async () => {
    const { result } = renderHook(() => useSpeak(fakeSession(), true, undefined, { current: 0 }, undefined, DAY));

    // 界面刚挂出来:arrived = false,thread 是空的。
    await act(async () => { result.current.speakNewReplies([], false); });
    expect(player.played).toBe(0);

    // 第一份真快照到了,里头是他昨天那条旧回答:这一拍才把「已有的」记下,不念。
    const old = [reply('t-1', '昨天那条。')];
    await act(async () => { result.current.speakNewReplies(old, true); });
    expect(player.played).toBe(0);

    // 之后真的新来一句:念。
    await act(async () => { result.current.speakNewReplies([...old, reply('t-2', '刚办完。')], true); });
    expect(player.played).toBe(1);
  });
});

// ———————————————————————— 状态行不许挤球 ————————————————————————

/**
 * **任何多出来的行都不许挤球**(2026-09-26,卡 QH 第二轮;统筹 0.3.5 装到小米上实测)。
 *
 * 现场:首页顶上出现「免打扰中 · 08:30 后恢复」、同时还有一行「远程」之后,球的画布只剩 84×84
 * (`.ba-particles__canvas` 84×84、`.ba-scene__orb` 整格高 84);0.3.4 同一台机同一页是 152。
 *
 * 病根:球那一格是 `flex: 1 1 auto`,而球在 stageCards.css 里有 `max-height: 100%` ——
 * **上面每多一行、每高一点,全从球身上扣,而且是真的变小,不是溢出**。原来「远程」还是 `.ba-scene` 的
 * 直接子元素、自己又付了一遍 `--ba-safe-top`(顶格已经付过一次),小米上这一条连边距就吃掉约 70px。
 *
 * 维护者的规矩①「球是主角、够大」与⑦「弹键盘球不缩」是同一个意思。所以机制改成:
 * 状态行全住在顶格里**一格固定预留的地方**、**绝对定位不占布局**(`.ba-scene__status`)。
 *
 * jsdom 不排版,量不到 84 还是 152。所以这里照这个仓库的老办法钉两样能钉的:
 *   ① **布局行数不变** —— 有两行状态与一行都没有时,`.ba-scene` 的直接子元素一模一样;
 *   ② **规则在不在** —— 顶格高度定死、那一叠绝对定位、「远程」不再自己付一遍安全区。
 * 真排出来的 px 由统筹在真机上量(交接第七节「没做的」里写了要量哪两样)。
 */
const SCENE_CSS = readFileSync(resolve(__dirname, '../src/styles.css'), 'utf8');
const CARDS_CSS = readFileSync(resolve(__dirname, '../src/stage/stageCards.css'), 'utf8');

/** `.ba-scene` 的直接子元素 = 竖着排的那几行(球那一格的高度 = 总高减掉它们)。 */
function layoutRows(): string[] {
  const scene = document.querySelector('.ba-scene')!;
  return [...scene.children].map((one) => one.className);
}

describe('顶上的状态行不许挤球', () => {
  it('★「远程」+「免打扰中」两行都有时,.ba-scene 的布局行与一行都没有时完全一样', async () => {
    const plain = mount({ mode: 'direct' });
    await act(async () => {});
    await act(async () => { plain.feed.set(replyState('版本号补好了。', DAY)); });
    const without = layoutRows();
    // 确认这一份真的什么状态行都没有(不然这条断言是假的)。
    expect(document.querySelector('.ba-scene__conn')).toBeNull();
    expect(screen.queryByRole('button', { name: /免打扰中/ })).toBeNull();
    plain.view.unmount();

    const both = mount({ mode: 'remote' });
    await act(async () => {});
    await act(async () => { both.feed.set(replyState('版本号补好了。', NIGHT)); });
    // 两行都在。
    expect(document.querySelector('.ba-scene__conn')?.textContent).toBe('远程');
    expect(screen.getByRole('button', { name: /免打扰中/ })).toBeTruthy();

    // ★ 球那一格上面下面的布局行一个没多、一个没少 —— 所以球那一格的高度不会变。
    expect(layoutRows()).toEqual(without);
  });

  it('★两条状态行都住在顶上那一格里,不是 .ba-scene 的布局行', async () => {
    const { feed } = mount({ mode: 'remote' });
    await act(async () => {});
    await act(async () => { feed.set(replyState('版本号补好了。', NIGHT)); });

    const conn = document.querySelector('.ba-scene__conn')!;
    const hush = screen.getByRole('button', { name: /免打扰中/ });
    for (const one of [conn, hush]) {
      expect(one.closest('.ba-scene__status')).toBeTruthy();
      expect(one.closest('.ba-scene__top')).toBeTruthy();
      // 不是 .ba-scene 的直接子元素 —— 那才是会挤球的位置。
      expect(one.parentElement?.classList.contains('ba-scene')).toBe(false);
    }
    // 球那一格与状态行是两回事:球不在顶格里。
    expect(document.querySelector('.ba-scene__orb')?.closest('.ba-scene__top')).toBeNull();
  });

  it('★CSS:那一格的高度由看不见的垫子定(不写死像素)、真内容叠在同一格、「远程」不再自己付一遍安全区', () => {
    // 垫子与真内容压在同一格(grid 叠放),所以摆几行都不改这一格的高 —— 同球下字幕那一处的做法。
    expect(SCENE_CSS).toMatch(/\.ba-scene__topspace, \.ba-scene__status \{[^}]*grid-area: 1 \/ 1/);
    expect(SCENE_CSS).toMatch(/\.ba-scene__statusbox \{[^}]*display: grid/);
    expect(SCENE_CSS).toMatch(/\.ba-scene__topspace \{[^}]*visibility: hidden/);
    /*
     * ★**不许写死像素**:这个仓库在定高上摔过两次(定高卡片、字幕那一格)——
     * 无头 Chrome 里量得正好,到 MIUI 的系统字体 / 放大字上就不够高。垫子是真字体排的。
     */
    expect(SCENE_CSS).not.toMatch(/--ba-scene-top-slot/);
    expect(CARDS_CSS).not.toMatch(/--ba-scene-top-slot/);
    expect(SCENE_CSS).not.toMatch(/\.ba-scene__top \{[^}]*min-height: \d/);
    // 垫子的尺寸规则与真的那两条**写在同一条选择器上**:改一处两边一起动,不会跑偏。
    expect(SCENE_CSS).toMatch(/\.ba-scene__hush, \.ba-scene__hushspace \{/);
    expect(SCENE_CSS).toMatch(/\.ba-scene__conn, \.ba-scene__connspace \{/);
    // 「远程」那一条不许再自己付一遍安全区(顶格付过了;付两遍就是从球身上扣)。
    expect(SCENE_CSS).toMatch(/\.ba-scene__conn, \.ba-scene__connspace \{[^}]*margin: 0;/);
    expect(SCENE_CSS).not.toMatch(/\.ba-scene__conn[^{]*\{[^}]*margin: calc\([^)]*--ba-safe-top/);
  });

  it('★垫子恒在,而且不冒充内容:查「那条横幅在不在」查不到它', async () => {
    const { feed } = mount({ mode: 'direct' });
    await act(async () => {});
    await act(async () => { feed.set(replyState('版本号补好了。', DAY)); });

    const space = document.querySelector('.ba-scene__topspace')!;
    // 两条状态行各一个壳子:高度从这儿来。
    expect(space.getAttribute('aria-hidden')).toBe('true');
    expect(space.querySelector('.ba-scene__connspace')).toBeTruthy();
    expect(space.querySelector('.ba-scene__hushspace')).toBeTruthy();
    // 而它不冒充内容:直连 + 白天,这两样一个都查不到。
    expect(document.querySelector('.ba-scene__conn')).toBeNull();
    expect(screen.queryByRole('button', { name: /免打扰中/ })).toBeNull();
    expect(screen.queryByRole('button', { name: '停止朗读' })).toBeNull();
  });
});
