/**
 * 通话中的那一层(2026-09-17 整合版)。原来它是整屏盖上去的一屏、自己画一颗球;
 * Ben 拍板之后通话是**舞台的一种状态**——球还是舞台上那一颗,这一层只管球下面的状态字、字幕和底部三个键。
 * 通话本体(拨号、阶段机、时长、静音、挂断收尾)抽到 useCall,这里连着它一起测。
 *
 * 要守住的几条:
 *   1. 进去就自己拨号,接通后显示时长;
 *   2. 底部三个键:麦克风(收音开关)、挂断、字幕——就这三个,不多不少;
 *   3. 字幕默认不显示,点了才显示,再点收起;
 *   4. 麦克风点一下关、再点开,关的时候真的不往火山发本地音频,而且屏幕上看得出来是关的;
 *   5. 挂断 = 真的挂断 + 把纪要交回工作台 + 退回舞台;
 *   6. 接不通时屏幕上是**服务端那句原话**,按钮变成「关闭」;
 *   7. 界面被拆(返回键、切页)也要真的挂断——不然房间里还留着一个在说话的智能体。
 */
import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CallOverlay } from '../src/call/CallOverlay';
import { useCall } from '../src/call/useCall';
import type { CallClient, CallEvents, CallResult, CallStartOptions } from '../src/call/rtcCall';
import { createWbchCallClient } from '../src/call/livekitCall';
import type { MicPermissionResult } from '../src/call/micPermission';
import { SessionContext, type Session } from '../src/session';
import type { CallApi } from '../src/api/call';
import type { SayDecisionRoomEvent } from '../src/call/sayDecisionRoomEvent';
import { createFakeLink, deferred, fakeChannel, trackMic } from './wbchFakes';

/**
 * 用例里**不烘热通话输出**(2026-09-28,卡 OP):jsdom 里没有真的音频输出可判 ——
 * `<audio>` 的 `play()` 是空实现、媒体时钟永远不走,烘热就会每通白等到上限。
 * 烘热本身在 tests/outputWarm.test.ts 里逐条钉;它在通话流程里的位置由「烘热」那一节钉。
 */
const NO_WARM = { makeWarmSink: () => undefined };

/** 「改回手机」走的是 /onboarding/leader(2026-09-18),所以这份假会话要有个能应答的 client。 */
const leaderCalls: { path: string; body?: unknown }[] = [];
const roomDecisionListeners = new Set<(event: SayDecisionRoomEvent) => void>();
let sayApiResult: unknown = { ok: true, status: 200, data: { say_id: 'say-1', say: { screen: '服务端确认回执' }, items: [] } };

function fakeSession(call: Partial<CallApi>): Session {
  return {
    pairing: { token: 'T', host: 'h', port: 8791, deviceId: 'd' },
    client: {
      json: async (path: string, init?: { body?: unknown }) => {
        leaderCalls.push({ path, ...(init?.body === undefined ? {} : { body: init.body }) });
        if (path === '/butler/say') return sayApiResult;
        return { ok: true, status: 200, data: { ok: true, leader: 'phone' } };
      },
    } as unknown as Session['client'],
    // 会议模式(2026-09-21)要一份只直连的客户端;这份用例用不到它,给个空壳。
    direct: {} as Session['direct'],
    feed: {} as Session['feed'],
    voice: {} as Session['voice'],
    channel: fakeChannel({ onSayDecision: listener => { roomDecisionListeners.add(listener); return () => { roomDecisionListeners.delete(listener); }; } }),
    call: {
      status: async () => ({ configured: true, checked: true }),
      channelStatus: async () => ({ configured: true, checked: true }),
      token: async () => ({ ok: false, status: 0, kind: 'network', error: '没接' }),
      start: async () => ({ ok: false, status: 0, kind: 'network', error: '没接' }),
      stop: async () => ({ ok: false, status: 0, kind: 'network', error: '没接' }),
      record: async () => ({ ok: true, status: 200, data: { id: 't-9' } }),
      ...call,
    } as CallApi,
    appearance: {} as Session['appearance'],
    settings: {} as Session['settings'],
    unpair: async () => {},
  };
}

/** 可以手动推进阶段的假通话客户端。 */
function fakeClient(result: CallResult = { transcript: [] }) {
  let events: CallEvents | null = null;
  let startOptions: CallStartOptions | undefined;
  const hangup = vi.fn(async () => result);
  const setMuted = vi.fn(async (_muted: boolean) => {});
  const client: CallClient = {
    async start(options, on) { startOptions = options; events = on; on.onPhase('connecting'); },
    hangup,
    setMuted,
  };
  return {
    client,
    hangup,
    setMuted,
    startOptions: () => startOptions,
    emit: (fn: (on: CallEvents) => void) => { if (events !== null) fn(events); },
  };
}

/** 舞台页在通话时做的事,浓缩成一个壳:起一通电话,把状态交给这一层画。 */
function Harness({ client, onEnded, onboarding }: { client: CallClient, onEnded: () => void, onboarding?: { resume: boolean } }) {
  const call = useCall({ active: true, createClient: () => client, tickMs: 10, onEnded, ...(onboarding === undefined ? {} : { onboarding }) });
  return <CallOverlay call={call} />;
}

function mount(options: { client: CallClient, call?: Partial<CallApi>, onEnded?: () => void, onboarding?: { resume: boolean } }) {
  const onEnded = options.onEnded ?? vi.fn();
  const view = render(
    <SessionContext.Provider value={fakeSession(options.call ?? {})}>
      <Harness client={options.client} onEnded={onEnded} {...(options.onboarding === undefined ? {} : { onboarding: options.onboarding })} />
    </SessionContext.Provider>,
  );
  return { view, onEnded };
}

describe('通话中的那一层', () => {
  it('把房间 ask 事件去重呈卡，点击后经同一 /butler/say 更新服务端回执', async () => {
    const fake = fakeClient();
    roomDecisionListeners.clear();
    leaderCalls.length = 0;
    mount({ client: fake.client });
    const event: SayDecisionRoomEvent = { type: 'say_decision', event_id: 's:ask:a', say_id: 's', kind: 'ask', decision: { ask_id: 'a', question: '允许继续吗？' } };
    act(() => { for (const listener of roomDecisionListeners) { listener(event); listener(event); } });
    expect(await screen.findByText('允许继续吗？')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '确认' }));
    await waitFor(() => expect(leaderCalls.at(-1)).toEqual({ path: '/butler/say', body: { text: '确认', entrance: 'phone', ctx: { confirmed: { ask_id: 'a', choice: 'yes' }, last_say_id: 's' } } }));
    expect(await screen.findByText('服务端确认回执')).toBeTruthy();
  });

  it('房间 decided 备选只以 decided_id 回送，API 拒绝时保留原卡', async () => {
    const fake = fakeClient();
    roomDecisionListeners.clear();
    leaderCalls.length = 0;
    sayApiResult = { ok: false, status: 409, kind: 'http', error: '原件已结束，不能改选。' };
    mount({ client: fake.client });
    const event: SayDecisionRoomEvent = { type: 'say_decision', event_id: 's:decided:d', say_id: 's', kind: 'decided', decision: { decided_id: 'd', item_index: 0, field: 'who', chosen: 'Claude', why: '默认分工', alternatives: [{ id: 'agent:kimi', label: 'Kimi' }] } };
    act(() => { for (const listener of roomDecisionListeners) listener(event); });
    expect(await screen.findByText(/我替你定的/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '改为 Kimi' }));
    await waitFor(() => expect(leaderCalls.at(-1)).toEqual({ path: '/butler/say', body: { text: '改为 Kimi', entrance: 'phone', ctx: { decided: { decided_id: 'd', choice: 'agent:kimi' }, last_say_id: 's' } } }));
    expect(await screen.findByText('原件已结束，不能改选。')).toBeTruthy();
    expect(screen.getByRole('button', { name: '改为 Kimi' })).toHaveProperty('disabled', false);
    sayApiResult = { ok: true, status: 200, data: { say_id: 'say-1', say: { screen: '服务端确认回执' }, items: [] } };
  });

  it('房间 suggest 的选择传回真实 suggest_id 与稳定 option id', async () => {
    const fake = fakeClient();
    roomDecisionListeners.clear(); leaderCalls.length = 0;
    mount({ client: fake.client });
    const event: SayDecisionRoomEvent = { type: 'say_decision', event_id: 'ss:suggest:sg', say_id: 'ss', kind: 'suggest', decision: { suggest_id: 'sg', line: '建议交给 Codex', default_action: 'keep', options: [{ id: 'agent:qa-codex', label: 'Codex' }] }, say: { screen: '先记着，建议交给 Codex。' } };
    act(() => { for (const listener of roomDecisionListeners) listener(event); });
    fireEvent.click(await screen.findByRole('button', { name: 'Codex' }));
    await waitFor(() => expect(leaderCalls.at(-1)).toEqual({ path: '/butler/say', body: { text: '派给 Codex', entrance: 'phone', ctx: { suggest: { suggest_id: 'sg', choice: 'agent:qa-codex' }, last_say_id: 'ss' } } }));
  });

  it('同轮两件有相同备选时，第二件只提交自己的 decided_id', async () => {
    const fake = fakeClient();
    roomDecisionListeners.clear(); leaderCalls.length = 0;
    mount({ client: fake.client });
    act(() => {
      for (const index of [0, 1]) for (const listener of roomDecisionListeners) listener({
        type: 'say_decision', event_id: `two:decided:${index}`, say_id: 'two', kind: 'decided',
        decision: { decided_id: `d-${index}`, item_index: index, field: 'who', chosen: 'Claude', why: '默认分工', alternatives: [{ id: 'agent:codex', label: 'Codex' }] },
      });
    });
    const buttons = await screen.findAllByRole('button', { name: '改为 Codex' });
    fireEvent.click(buttons[1]!);
    await waitFor(() => expect(leaderCalls.at(-1)).toEqual({ path: '/butler/say', body: { text: '改为 Codex', entrance: 'phone', ctx: { decided: { decided_id: 'd-1', choice: 'agent:codex' }, last_say_id: 'two' } } }));
  });

  it('消费新房间 producer 的 screen 与原件；错 call_id 丢弃，同 ID 重放只显示一次', async () => {
    const fake = fakeClient();
    roomDecisionListeners.clear();
    mount({ client: fake.client });
    const callId = fake.startOptions()?.callId;
    if (callId === undefined) throw new Error('拨出的测试电话应带 callId');
    const event: SayDecisionRoomEvent = {
      type: 'say_decision', event_id: 'say-room-1:decided:0:who', call_id: callId, say_id: 'say-room-1', kind: 'decided',
      decision: { decided_id: 'decided-room-1', item_index: 0, field: 'who', chosen: 'Claude', why: '按既有分工', alternatives: [{ id: 'agent:kimi', label: 'Kimi' }] },
      say: { screen: '我替你定了：由 Claude 接手。' },
      item: { title: '剪辑客户样片', status: 'todo', card_id: 'task-room-1', who: 'Claude' },
    };
    act(() => { for (const listener of roomDecisionListeners) listener({ ...event, call_id: 'another-call' }); });
    expect(screen.queryByText('我替你定了：由 Claude 接手。')).toBeNull();
    act(() => { for (const listener of roomDecisionListeners) { listener(event); listener(event); } });
    expect(await screen.findByText('我替你定了：由 Claude 接手。')).toBeTruthy();
    expect(screen.getByText(/原件：剪辑客户样片 · 事项 ID task-room-1/)).toBeTruthy();
    expect(document.querySelectorAll('.ba-say-card')).toHaveLength(1);
  });

  it('进去就在接通;接通后显示「通话中」与时长', async () => {
    const fake = fakeClient();
    mount({ client: fake.client });
    expect(await screen.findByText('正在接通…')).toBeTruthy();

    act(() => { fake.emit(on => on.onPhase('connected')); });
    expect(await screen.findByText('通话中')).toBeTruthy();
    await waitFor(() => expect(screen.getByLabelText('通话时长').textContent).toMatch(/^\d{2}:\d{2}$/));
  });

  it('底部就三个键:麦克风、挂断、字幕', async () => {
    const fake = fakeClient();
    mount({ client: fake.client });
    act(() => { fake.emit(on => on.onPhase('connected')); });
    const keys = [...document.querySelectorAll('.ba-call__dock button')].map(b => b.getAttribute('aria-label'));
    expect(keys).toEqual(['关掉麦克风', '挂断', '显示字幕']);
    // 舞台上那套底部件在通话时不该还在
    expect(document.querySelector('.ba-scene__field')).toBeNull();
    expect(document.querySelector('textarea')).toBeNull();
  });

  it('字幕:默认不显示,点了才显示,再点收起;按说话人分「我 / 事务官」', async () => {
    const fake = fakeClient();
    mount({ client: fake.client });
    act(() => { fake.emit(on => on.onPhase('connected')); });
    expect(screen.queryByLabelText('字幕')).toBeNull();

    act(() => {
      fake.emit(on => on.onUtterance({ who: 'me', text: '周五交报销' }));
      fake.emit(on => on.onUtterance({ who: 'butler', text: '记下了。' }));
    });
    fireEvent.click(screen.getByRole('button', { name: '显示字幕' }));
    const box = await screen.findByLabelText('字幕');
    expect(box.textContent).toContain('我:周五交报销');
    expect(box.textContent).toContain('事务官:记下了。');

    fireEvent.click(screen.getByRole('button', { name: '收起字幕' }));
    await waitFor(() => expect(screen.queryByLabelText('字幕')).toBeNull());
  });

  it('麦克风:点一下关(真的停掉上行音频、屏幕上看得出来),再点开', async () => {
    const fake = fakeClient();
    mount({ client: fake.client });
    act(() => { fake.emit(on => on.onPhase('connected')); });

    const mic = screen.getByRole('button', { name: '关掉麦克风' });
    expect(mic.getAttribute('aria-pressed')).toBe('false');
    await act(async () => { fireEvent.click(mic); });
    await waitFor(() => expect(fake.setMuted).toHaveBeenCalledWith(true));
    const off = screen.getByRole('button', { name: '打开麦克风' });
    expect(off.getAttribute('aria-pressed')).toBe('true');
    expect(off.getAttribute('data-off')).toBe('true');
    expect(screen.getByText('麦克风已关,事务官听不见你')).toBeTruthy();

    await act(async () => { fireEvent.click(off); });
    await waitFor(() => expect(fake.setMuted).toHaveBeenLastCalledWith(false));
    expect(screen.queryByText('麦克风已关,事务官听不见你')).toBeNull();
  });

  /**
   * ★★ 2026-09-24(卡 fix/call-mute-before-publish,统筹真机 0.2.81):接通过程中按「关掉麦克风」,
   * 界面说关了,工人日志里照样有「他说」。这一条走**真的 LiveKit 那一版**(只有房间是假的):
   * 键一出现就按(权限还在问),接通之后屏幕上说「麦克风已关」,轨道也真的没在发。
   */
  it('★★ 接通过程中按「关掉麦克风」:界面说关了,轨道也真的没在发', async () => {
    const link = createFakeLink();
    const track = trackMic(link);
    const asked = deferred<MicPermissionResult>();
    const client = createWbchCallClient({ ...NO_WARM, channel: fakeChannel({ link }), askMicPermission: () => asked.promise });
    mount({ client });
    expect(await screen.findByText('正在接通…')).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '关掉麦克风' })); });
    await act(async () => { asked.resolve({ state: 'granted', granted: true, needsSettings: false, via: 'native' }); });
    expect(await screen.findByText('通话中')).toBeTruthy();
    expect(screen.getByText('麦克风已关,事务官听不见你')).toBeTruthy();
    expect(screen.getByRole('button', { name: '打开麦克风' }).getAttribute('aria-pressed')).toBe('true');
    expect(link.micLog).not.toContain(true);
    expect(track.live).toBe(false);
    // 再按一下:这时才真的开。
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '打开麦克风' })); });
    await waitFor(() => expect(track.live).toBe(true));
    expect(screen.queryByText('麦克风已关,事务官听不见你')).toBeNull();
  });

  it('连按两下:送过去的是「关」再「开」,一下都不丢', async () => {
    const fake = fakeClient();
    mount({ client: fake.client });
    const mic = await screen.findByRole('button', { name: '关掉麦克风' });
    fireEvent.click(mic);
    fireEvent.click(mic);
    await waitFor(() => expect(fake.setMuted.mock.calls.map(([muted]) => muted)).toEqual([true, false]));
    expect(screen.getByRole('button', { name: '关掉麦克风' }).getAttribute('aria-pressed')).toBe('false');
  });

  it('★ 新一通默认开麦:上一通按过的静音不带过来', async () => {
    const first = fakeClient();
    const second = fakeClient();
    const queue = [first.client, second.client];
    const session = fakeSession({});
    function Host({ active }: { active: boolean }) {
      const call = useCall({ active, createClient: () => queue.shift()!, tickMs: 10, onEnded: () => {} });
      return active ? <CallOverlay call={call} /> : null;
    }
    const view = render(<SessionContext.Provider value={session}><Host active /></SessionContext.Provider>);
    fireEvent.click(await screen.findByRole('button', { name: '关掉麦克风' }));
    await waitFor(() => expect(first.setMuted).toHaveBeenLastCalledWith(true));
    view.rerender(<SessionContext.Provider value={session}><Host active={false} /></SessionContext.Provider>);
    view.rerender(<SessionContext.Provider value={session}><Host active /></SessionContext.Provider>);
    const mic = await screen.findByRole('button', { name: '关掉麦克风' });
    expect(mic.getAttribute('aria-pressed')).toBe('false');
    expect(screen.queryByText('麦克风已关,事务官听不见你')).toBeNull();
    expect(second.setMuted).not.toHaveBeenCalled();
    // 这一通按一下就是「关」—— 不是把上一通的「关」翻回「开」。
    fireEvent.click(mic);
    await waitFor(() => expect(second.setMuted).toHaveBeenLastCalledWith(true));
  });

  it('挂断:真的挂断、把时长与字幕交回工作台、退回舞台', async () => {
    const fake = fakeClient({ durationSeconds: 185, transcript: [{ who: 'me', text: '周五交报销' }] });
    const record = vi.fn(async () => ({ ok: true as const, status: 200, data: {} }));
    const { onEnded } = mount({ client: fake.client, call: { record } });
    act(() => { fake.emit(on => on.onPhase('connected')); });

    fireEvent.click(await screen.findByRole('button', { name: '挂断' }));
    await waitFor(() => expect(onEnded).toHaveBeenCalled());
    expect(fake.hangup).toHaveBeenCalledTimes(1);
    // 2026-10-22:带上这一通的编号(拨号时编的),工作台据此把手机与工人报的并成一份。
    expect(record).toHaveBeenCalledWith({ callId: expect.stringMatching(/^ph-/), durationSeconds: 185, transcript: [{ who: 'me', text: '周五交报销' }] });
  });

  it('纪要交不上去也照样挂断,只是屏幕上说一句', async () => {
    const fake = fakeClient({ durationSeconds: 3, transcript: [] });
    const { onEnded } = mount({
      client: fake.client,
      call: { record: async () => ({ ok: false, status: 404, kind: 'http', error: '任务看板未启用' }) },
    });
    act(() => { fake.emit(on => on.onPhase('connected')); });
    fireEvent.click(await screen.findByRole('button', { name: '挂断' }));
    await waitFor(() => expect(onEnded).toHaveBeenCalled());
  });

  it('接不通:屏幕上是服务端那句原话,按钮变「关闭」,不摆时长也不摆麦克风', async () => {
    const fake = fakeClient();
    mount({ client: fake.client });
    act(() => { fake.emit(on => on.onPhase('error', { error: '未配置语音供应商密钥' })); });
    expect(await screen.findByText('未配置语音供应商密钥')).toBeTruthy();
    expect(screen.getByText('关闭')).toBeTruthy();
    expect(screen.queryByLabelText('通话时长')).toBeNull();
    expect(screen.queryByRole('button', { name: '关掉麦克风' })).toBeNull();
  });

  it('压根没接通过就不写纪要(看板上不该多一张「通了个电话」的空卡)', async () => {
    const fake = fakeClient();
    const record = vi.fn(async () => ({ ok: true as const, status: 200, data: {} }));
    const { onEnded } = mount({ client: fake.client, call: { record } });
    act(() => { fake.emit(on => on.onPhase('error', { error: '未配置语音供应商密钥' })); });
    fireEvent.click(await screen.findByText('关闭'));
    await waitFor(() => expect(onEnded).toHaveBeenCalled());
    expect(record).not.toHaveBeenCalled();
  });

  it('界面被拆掉也要真的挂断(不然房间里还留着一个在说话的智能体)', async () => {
    const fake = fakeClient();
    const { view } = mount({ client: fake.client });
    act(() => { fake.emit(on => on.onPhase('connected')); });
    view.unmount();
    await waitFor(() => expect(fake.hangup).toHaveBeenCalledTimes(1));
  });

  /**
   * 2026-09-23 晚(维护者真机 0.2.73「说了拜拜之后没有真的拜拜」):他道了别、她回了一句,
   * 电脑那边在那句播完之后挂了 —— 手机要**自己退出通话页**,纪要照交,和按挂断同一条路。
   */
  it('★★ 电脑那边挂了(她道过别):走自己那条挂断 —— 纪要照交、退回平常页面,只挂一次', async () => {
    const fake = fakeClient({ durationSeconds: 42, transcript: [{ who: 'me', text: '好,拜拜' }, { who: 'butler', text: '好的老板,拜拜' }] });
    const record = vi.fn(async () => ({ ok: true as const, status: 200, data: {} }));
    const { onEnded } = mount({ client: fake.client, call: { record } });
    act(() => { fake.emit(on => on.onPhase('connected')); });
    act(() => { fake.emit(on => on.onRemoteHangup?.()); });
    await waitFor(() => expect(onEnded).toHaveBeenCalledTimes(1));
    expect(fake.hangup).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith({ callId: expect.stringMatching(/^ph-/), durationSeconds: 42, transcript: [{ who: 'me', text: '好,拜拜' }, { who: 'butler', text: '好的老板,拜拜' }] });
    // 又来一条(广播重送)也不再挂一次
    act(() => { fake.emit(on => on.onRemoteHangup?.()); });
    expect(fake.hangup).toHaveBeenCalledTimes(1);
  });

  it('挂断连点两次只挂一次', async () => {
    const fake = fakeClient();
    mount({ client: fake.client });
    act(() => { fake.emit(on => on.onPhase('connected')); });
    const button = await screen.findByRole('button', { name: '挂断' });
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(fake.hangup).toHaveBeenCalledTimes(1));
  });
});

/**
 * 打字备胎(2026-09-18,引导改通话模式)。Ben 的口径里引导要能打字回答;
 * 通话模式下那条路在**字幕面板里**——字幕与记录本来就是同一个概念,不再多摆一个键。
 */
describe('引导通话里的打字备胎', () => {
  function onboardingClient() {
    const fake = fakeClient();
    const sayText = vi.fn(async (_text: string) => ({ ok: true as const }));
    return { ...fake, sayText, client: { ...fake.client, sayText } };
  }

  it('字幕面板里能打字,发出去走同一条路;我这句立刻进字幕', async () => {
    const fake = onboardingClient();
    mount({ client: fake.client, onboarding: { resume: false } });
    act(() => { fake.emit(on => on.onPhase('connected')); });
    fireEvent.click(screen.getByRole('button', { name: '显示字幕' }));

    const input = screen.getByLabelText('打字回答') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: '叫我 Ben' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));

    await waitFor(() => expect(fake.sayText).toHaveBeenCalledWith('叫我 Ben'));
    await waitFor(() => expect(screen.getByLabelText('字幕').textContent).toContain('我:叫我 Ben'));
    expect(input.value).toBe('');
  });

  it('不是引导(或这条链路不能打字)就不摆输入框——摆一个发不出去的框是骗人', async () => {
    const fake = fakeClient();
    mount({ client: fake.client });
    act(() => { fake.emit(on => on.onPhase('connected')); });
    fireEvent.click(screen.getByRole('button', { name: '显示字幕' }));
    expect(screen.queryByLabelText('打字回答')).toBeNull();
  });

  /**
   * 2026-09-25 翻过来(卡 feat/first-look-orb-top):维护者刚走了 27 分钟引导,手机上「最近一次通话」还说「还没有通过电话」。
   * 引导那一通**也写纪要**,但只交时长与 `kind:'onboarding'`,**不交字幕**:那一句摘要由工作台照引导存档拼。
   */
  it('引导那一通也写纪要:只交时长与 kind:onboarding,不交字幕', async () => {
    const fake = onboardingClient();
    const record = vi.fn(async (_input: unknown) => ({ ok: true as const, status: 200, data: {} }));
    mount({ client: fake.client, onboarding: { resume: false }, call: { record } });
    act(() => { fake.emit(on => on.onPhase('connected')); });
    fireEvent.click(screen.getByRole('button', { name: '挂断' }));
    await waitFor(() => expect(fake.hangup).toHaveBeenCalled());
    await waitFor(() => expect(record).toHaveBeenCalledTimes(1));
    expect(record.mock.calls[0]![0]).toMatchObject({ kind: 'onboarding', transcript: [] });
  });
});

/**
 * 录音权限与主导方(2026-09-18,Ben 真机那两条)。
 * 这一层的职责只有一个:**把结论说出来,并给一条能走的路**。不静默。
 */
describe('没有录音权限', () => {
  it('说「她听不到你」,并给一颗「去设置里打开」', async () => {
    const fake = fakeClient();
    mount({ client: fake.client });
    act(() => {
      fake.emit(on => on.onMicPermission?.({ granted: false, needsSettings: true }));
      fake.emit(on => on.onPhase('connected'));
    });
    expect(await screen.findByText('没有录音权限,事务官听不到你')).toBeTruthy();
    expect(screen.getByRole('button', { name: '去设置里打开' })).toBeTruthy();
  });

  it('还问得动的时候不摆那颗按钮(送人去系统设置是多此一举)', async () => {
    const fake = fakeClient();
    mount({ client: fake.client });
    act(() => {
      fake.emit(on => on.onMicPermission?.({ granted: false, needsSettings: false }));
      fake.emit(on => on.onPhase('connected'));
    });
    expect(await screen.findByText('没有录音权限,事务官听不到你')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '去设置里打开' })).toBeNull();
  });

  it('给了权限就什么都不说(这一行只在真的缺的时候出现)', async () => {
    const fake = fakeClient();
    mount({ client: fake.client });
    act(() => {
      fake.emit(on => on.onMicPermission?.({ granted: true, needsSettings: false }));
      fake.emit(on => on.onPhase('connected'));
    });
    await screen.findByText('通话中');
    expect(screen.queryByText('没有录音权限,事务官听不到你')).toBeNull();
  });
});

describe('引导归电脑管', () => {
  it('说「电脑上在做引导,先别说」,并给一颗「改回手机」', async () => {
    const fake = fakeClient();
    const retryOnboarding = vi.fn(async () => ({ ok: true as const }));
    fake.client.retryOnboarding = retryOnboarding;
    mount({ client: fake.client, onboarding: { resume: false } });
    act(() => {
      fake.emit(on => on.onLeader?.('desktop'));
      fake.emit(on => on.onPhase('connected'));
    });
    expect(await screen.findByText('电脑上在做引导,先别说')).toBeTruthy();
    leaderCalls.length = 0;
    fireEvent.click(screen.getByRole('button', { name: '改回手机' }));
    await waitFor(() => expect(retryOnboarding).toHaveBeenCalled());
    // 顺序不能反:先把主导权落成 phone,工人再问一次简报才会开口。
    expect(leaderCalls[0]).toEqual({ path: '/onboarding/leader', body: { leader: 'phone' } });
  });

  it('归手机管时这一段整个不出现', async () => {
    const fake = fakeClient();
    mount({ client: fake.client, onboarding: { resume: false } });
    act(() => {
      fake.emit(on => on.onLeader?.('phone'));
      fake.emit(on => on.onPhase('connected'));
    });
    await screen.findByText('通话中');
    expect(screen.queryByText('电脑上在做引导,先别说')).toBeNull();
  });
});

/**
 * 2026-09-23 从零重装验收:手机守在旧房间里,挂断一直停在「正在挂断…」,只能把 App 划掉。
 * 挂断整件事有期限:到点还没收拾完就自己收场,退回平常页面,纪要不写。
 */
describe('★ 挂断等不到回话要自己收场', () => {
  function DeadlineHarness({ client, onEnded }: { client: CallClient, onEnded: () => void }) {
    const call = useCall({ active: true, createClient: () => client, tickMs: 10, onEnded, hangupDeadlineMs: 40, recordWaitMs: 40 });
    return <CallOverlay call={call} />;
  }

  it('hangup 永远不回:过了期限照样退回,纪要不写', async () => {
    const fake = fakeClient();
    fake.hangup.mockImplementation(() => new Promise<CallResult>(() => {}));
    const record = vi.fn(async () => ({ ok: true as const, status: 200, data: { id: 't-9' } }));
    const onEnded = vi.fn();
    render(
      <SessionContext.Provider value={fakeSession({ record })}>
        <DeadlineHarness client={fake.client} onEnded={onEnded} />
      </SessionContext.Provider>,
    );
    act(() => { fake.emit(on => on.onPhase('connected')); });
    fireEvent.click(screen.getByLabelText('挂断'));
    await waitFor(() => expect(onEnded).toHaveBeenCalledTimes(1));
    expect(record).not.toHaveBeenCalled();
  });

  it('纪要那一条永远不回:也不把人按在通话页上', async () => {
    const fake = fakeClient({ transcript: [{ who: 'me', text: '在吗' }], durationSeconds: 3 });
    const record = vi.fn(() => new Promise<never>(() => {}));
    const onEnded = vi.fn();
    render(
      <SessionContext.Provider value={fakeSession({ record })}>
        <DeadlineHarness client={fake.client} onEnded={onEnded} />
      </SessionContext.Provider>,
    );
    act(() => { fake.emit(on => on.onPhase('connected')); });
    fireEvent.click(screen.getByLabelText('挂断'));
    await waitFor(() => expect(onEnded).toHaveBeenCalledTimes(1));
    expect(record).toHaveBeenCalledTimes(1);
  });
});
