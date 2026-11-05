/**
 * 通话走 LiveKit 的那一半(2026-09-17)。要守住的:
 *   1. 进房 → 工人接起 → 才算接通 → 这才发布麦克风(2026-09-25 返工:以前是「先发布麦克风才算接通」,
 *      发布卡住时招呼一直发不出去;工人的收音闸会订上接通之后才发上来的轨道);
 *   2. 麦克风开关 = 取消/恢复发布本地音轨;
 *   3. 挂断 = 停麦克风 + 放手(局域网里放手就是离房);
 *   4. 字幕来自工人经数据通道推的 caption:**定稿的才进纪要**,说到一半的只画在屏幕上;
 *   5. 房里没有工人 = 打通了但没人接,**不当成成功**。
 */
import { describe, expect, it, vi } from 'vitest';
import {
  WBCH_CALL_NO_WORKER_TEXT,
  WBCH_CONNECT_NO_ANSWER_TEXT,
  WBCH_CONNECT_ROOM_FAILED_TEXT,
  WBCH_CONNECT_ROOM_TIMEOUT_TEXT,
  WBCH_CONNECT_SEND_FAILED_TEXT,
  WBCH_MIC_PERMISSION_SLOW_TEXT,
  WBCH_MIC_PUBLISH_SLOW_TEXT,
  createWbchCallClient as rawCallClient,
  humanized,
} from '../src/call/livekitCall';
import { MIC_PUBLISH_FAILED_TEXT, type MicPermissionResult } from '../src/call/micPermission';
import type { CallEvents, CallStartOptions } from '../src/call/rtcCall';
import type { CallPhase, CallUtterance } from '../src/call/callModel';
import type { WbchRoomCheck } from '../src/channel/channel';
import type { WbchCaption, WbchFiller } from '../src/channel/channelProtocol';
import { createFakeLink, deferred, fakeChannel, fakeCredential, trackMic } from './wbchFakes';

/**
 * 用例里**不烘热通话输出**(2026-09-28,卡 OP):jsdom 里没有真的音频输出可判 ——
 * `<audio>` 的 `play()` 是空实现、媒体时钟永远不走,烘热就会每通白等到上限。
 * 烘热本身在 tests/outputWarm.test.ts 里逐条钉;它在通话流程里的位置由「烘热」那一节钉。
 */
const NO_WARM = { makeWarmSink: () => undefined };

function recorder() {
  const phases: { phase: CallPhase; error?: string }[] = [];
  const lines: CallUtterance[] = [];
  const interims: (CallUtterance | null)[] = [];
  const bot: boolean[] = [];
  const me: boolean[] = [];
  const mic: { granted: boolean; needsSettings: boolean; text?: string }[] = [];
  const leaders: string[] = [];
  const events: CallEvents = {
    onPhase: (phase, detail) => phases.push({ phase, ...(detail?.error === undefined ? {} : { error: detail.error }) }),
    onUtterance: (entry) => lines.push(entry),
    onInterim: (entry) => interims.push(entry),
    onBotSpeaking: (s) => bot.push(s),
    onMicSpeaking: (s) => me.push(s),
    onMicPermission: (r) => mic.push({ granted: r.granted, needsSettings: r.needsSettings, ...(r.text === undefined ? {} : { text: r.text }) }),
    onLeader: (l) => leaders.push(l),
  };
  return { events, phases, lines, interims, bot, me, mic, leaders };
}

/** 缺省「权限给过了」的录音权限问答。不给权限那几条用例自己传一份别的。 */
const MIC_GRANTED: MicPermissionResult = { state: 'granted', granted: true, needsSettings: false, via: 'native' };

/**
 * 这一份用例里的通话客户端**一律注入问权限那一步**(2026-09-18):
 * 真的那条会去找原生插件、再退回 getUserMedia,jsdom 里两样都没有 —— 那不是这几条要验的东西。
 */
function createWbchCallClient(deps: Parameters<typeof rawCallClient>[0]) {
  // 每一步那一行(`[通话] …`)缺省打到控制台;用例里不要这份噪音,要看的那一条自己传收集器。
  return rawCallClient({ askMicPermission: async () => MIC_GRANTED, trace: () => {}, ...NO_WARM, ...deps });
}

function wire(patch: Parameters<typeof fakeChannel>[0] = {}) {
  const link = createFakeLink();
  const captions: ((c: WbchCaption) => void)[] = [];
  const fillers: ((f: WbchFiller) => void)[] = [];
  const voices: ((c: { type: 'filler_voice_changed'; voice: string; at: number }) => void)[] = [];
  const channel = fakeChannel({
    link,
    acquireCall: async () => { await link.acquire('call', { url: 'u', room: 'r', identity: 'i', token: 't', expires_at: 9e9 }); },
    releaseCall: async () => { await link.release('call'); },
    onCaption: (listener) => { captions.push(listener); return () => { captions.splice(captions.indexOf(listener), 1); }; },
    onFiller: (listener) => { fillers.push(listener); return () => { fillers.splice(fillers.indexOf(listener), 1); }; },
    onFillerVoice: (listener) => { voices.push(listener); return () => { voices.splice(voices.indexOf(listener), 1); }; },
    ...patch,
  });
  return {
    link,
    channel,
    caption: (c: WbchCaption) => { for (const l of [...captions]) l(c); },
    filler: (f: WbchFiller) => { for (const l of [...fillers]) l(f); },
    voiceChanged: (voice: string) => { for (const l of [...voices]) l({ type: 'filler_voice_changed', voice, at: 1 }); },
  };
}

describe('一通电话', () => {
  it('进房 → 工人接起 → 接通 → 发布麦克风', async () => {
    const { link, channel } = wire();
    const rec = recorder();
    await createWbchCallClient({ channel }).start({}, rec.events);
    expect(link.holders.has('call')).toBe(true);
    expect(link.micLog).toEqual([true]);
    expect(rec.phases.map((p) => p.phase)).toEqual(['connecting', 'connected']);
  });

  /*
   * ——— 喇叭(2026-09-22 晚)———
   *
   * Ben 真机 20:50:座机模式手动打开之后,手机响铃 ✓、提机接听 ✓,
   * **但事务官的声音从手机里出来,不从话筒出来**。根子是 roomLink 从 0917 起
   * 「进房就把远端音轨挂到一个 autoplay 的 `<audio>` 上」,而从今天起手机常驻房间。
   * 所以喇叭改成缺省关、**由这一层明着打开**:谁接谁说话。
   */
  it('★ 接通就打开喇叭;挂断关回去', async () => {
    const { link, channel } = wire();
    const rec = recorder();
    const client = createWbchCallClient({ channel });
    await client.start({}, rec.events);
    expect(link.speakerLog).toEqual([true]);
    await client.hangup();
    expect(link.speakerLog).toEqual([true, false]);
  });

  it('★ 开喇叭排在麦克风**之前** —— 麦克风那一步可能要等人点权限弹框,而她已经在说开场白了', async () => {
    const order: string[] = [];
    const { link, channel } = wire();
    link.setSpeakerEnabled = (on: boolean) => { order.push(`speaker:${on}`); };
    const original = link.setMicrophoneEnabled.bind(link);
    link.setMicrophoneEnabled = async (on: boolean) => { order.push(`mic:${on}`); return original(on); };
    await createWbchCallClient({ channel }).start({}, recorder().events);
    expect(order[0]).toBe('speaker:true');
  });

  /*
   * ——— 起播那一下(2026-09-27,卡 CL)———
   *
   * 维护者 21:3x 手机打过去:「一上来就听到『吩咐』两个字,『吩』字还是尾巴,前面估计被吃了。」
   * 工人一帧都没少发,手机十七分钟前就订上了音轨 —— 吃掉前半句的是这一侧的起播:
   * 常驻房间时那个 `<audio>` 是暂停 + 静音的,接通才 `play()`,WebView 要重开一次
   * AudioTrack 才真出声。所以**请工人接起之前先等这一下**。
   */
  it('★ 喇叭起播之前不请工人接起(她一开口就被吃掉前半句)', async () => {
    const order: string[] = [];
    const { link, channel } = wire();
    const gate = deferred<void>();
    link.speakerReady = async () => { order.push('speakerReady'); await gate.promise; };
    const started = channel.callStart.bind(channel);
    channel.callStart = async () => { order.push('callStart'); return await started(); };
    const run = createWbchCallClient({ channel }).start({}, recorder().events);
    await vi.waitFor(() => { expect(order).toContain('speakerReady'); });
    expect(order).toEqual(['speakerReady']); // 还没起播:一个字都还没请她说
    gate.resolve();
    await run;
    expect(order).toEqual(['speakerReady', 'callStart']);
  });

  /*
   * ——— 烘热(2026-09-28,卡 OP)———
   *
   * 卡 CF 第 4 条那一版判「真的在放了」靠「新建一个 AudioContext、看它的时钟走不走」——
   * 那个时钟一建就在走。于是手机在**开喇叭那一刻**就报「我在放了」,而**拨出这一路是
   * 先开喇叭、后发 `call.start`**:那条 `playing` 比接起先到,工人那道闸把先到的丢掉,
   * 白等到上限。真机(0.4.55,Pixel 10 → 本机,18:1x)日志里一行「在放了」都没有,
   * 维护者听到的还是「何吩咐」。
   *
   * 所以判据换成**输出真的在消化音频**(经同一输出播一小段静音,它的媒体时钟真的在走),
   * 而且**烘热排在请工人接起之前** —— 顺序才是这张卡的解。
   */
  describe('烘热通话输出(卡 OP)', () => {
    /** 一个能被手动推的假输出。 */
    function warmSink() {
      const sink = {
        currentTime: 0,
        paused: 0,
        play: () => { /* 起播了 */ },
        pause: () => { sink.paused += 1; },
      };
      return sink;
    }

    it('★ 烘热之前不请工人接起:输出还没出声就请她开口,第一个字必被吃', async () => {
      const order: string[] = [];
      const { channel } = wire();
      const sink = warmSink();
      const started = channel.callStart.bind(channel);
      channel.callStart = async () => { order.push('callStart'); return await started(); };
      channel.playingCall = async () => { order.push('playing'); return { ok: true as const }; };
      const run = createWbchCallClient({ channel, makeWarmSink: () => sink, outputWarmMs: 2000 }).start({}, recorder().events);
      // 输出一动不动(路由还在切):这会儿一个字都不许请她说。
      await new Promise((resolve) => { setTimeout(resolve, 80); });
      expect(order).toEqual([]);
      sink.currentTime = 1;
      await run;
      // 先报「我这边在放了」,才请工人接起 —— 拨出那一路的顺序就是这么反的,工人那道闸认先到的。
      expect(order).toEqual(['playing', 'callStart']);
    });

    it('★ 烘热等了多久原样报给工人(统筹真机核那一行靠它)', async () => {
      const warm: (number | undefined)[] = [];
      const { channel } = wire();
      const sink = warmSink();
      sink.currentTime = 1; // 一看就在出声
      channel.playingCall = async (ms?: number) => { warm.push(ms); return { ok: true as const }; };
      await createWbchCallClient({ channel, makeWarmSink: () => sink, outputWarmMs: 2000 }).start({}, recorder().events);
      expect(warm).toHaveLength(1);
      expect(typeof warm[0]).toBe('number');
    });

    it('★ 输出一直不出声 → **不报**「我在放了」,但电话照样打通', async () => {
      const told: number[] = [];
      const { channel } = wire();
      const sink = warmSink(); // currentTime 永远是 0
      channel.playingCall = async () => { told.push(1); return { ok: true as const }; };
      const rec = recorder();
      await createWbchCallClient({ channel, makeWarmSink: () => sink, outputWarmMs: 40 }).start({}, rec.events);
      expect(told).toEqual([]);
      expect(rec.phases.map((p) => p.phase)).toEqual(['connecting', 'connected']);
      // 没热就把那一小段静音收干净。
      expect(sink.paused).toBe(1);
    });

    it('★ 这台机器造不出输出 → 当场往下走,不把接通变慢', async () => {
      const { channel } = wire();
      const rec = recorder();
      await createWbchCallClient({ channel, makeWarmSink: () => undefined, outputWarmMs: 5000 }).start({}, rec.events);
      expect(rec.phases.map((p) => p.phase)).toEqual(['connecting', 'connected']);
    });

    it('★ 挂断把那一小段静音停掉(热了之后是留着的:AudioTrack 不许被回收)', async () => {
      const { channel } = wire();
      const sink = warmSink();
      sink.currentTime = 1;
      const client = createWbchCallClient({ channel, makeWarmSink: () => sink, outputWarmMs: 2000 });
      await client.start({}, recorder().events);
      expect(sink.paused).toBe(0);
      await client.hangup();
      expect(sink.paused).toBe(1);
    });
  });

  it('★ 起播等不回来也照样打:这一条治的是「第一个字被吃」,不许变成「打不通」', async () => {
    const { link, channel } = wire();
    link.speakerReady = () => new Promise<void>(() => {}); // 永远不回
    const rec = recorder();
    await createWbchCallClient({ channel, speakerReadyMs: 20 }).start({}, rec.events);
    expect(rec.phases.map((p) => p.phase)).toEqual(['connecting', 'connected']);
  });

  it('★ 没人接的那一通也要把喇叭关回去(它开过了)', async () => {
    const { link, channel } = wire();
    link.workerPresent = () => false;
    await createWbchCallClient({ channel, workerWaitMs: 20 }).start({}, recorder().events);
    expect(link.speakerLog).toEqual([true, false]);
  });

  // 报了 connected,挂断时就会往看板上写一条「和事务官通了个电话(38 秒)」——那是在记一件没发生的事
  // (本机实测踩到过)。所以没人接的时候**连 connected 都不许报**,房间也要放回去。
  it('房里没有工人 = 打通了但没人接:只报错,不报接通,也不留着房间', async () => {
    const { link, channel } = wire();
    link.workerPresent = () => false;
    const rec = recorder();
    const client = createWbchCallClient({ channel, workerWaitMs: 20 });
    await client.start({}, rec.events);
    expect(rec.phases.map((p) => p.phase)).toEqual(['connecting', 'error']);
    expect(rec.phases[1]?.error).toBe(WBCH_CALL_NO_WORKER_TEXT);
    expect(link.holders.has('call')).toBe(false);
    // ★ 2026-09-25:没人接的那一通**从头到尾不开麦**(以前先发布、等不到工人再关);收场照样撤一次轨道。
    expect(link.micLog).not.toContain(true);
    expect(link.micStops).toBeGreaterThan(0);
    // 没接通 → 没有时长 → 上一层据此不写纪要
    await expect(client.hangup()).resolves.toEqual({ transcript: [] });
  });

  // 进房那一瞬间 SDK 的参与者表可能还没填上(本机实测过一次)。问早了会把打得通的电话说成没人接。
  it('工人晚一拍才露面:等到了就照样接通', async () => {
    const { link, channel } = wire();
    link.workerPresent = () => false;
    const rec = recorder();
    const client = createWbchCallClient({ channel, workerWaitMs: 2000 });
    const started = client.start({}, rec.events);
    await vi.waitFor(() => expect(rec.phases.map((p) => p.phase)).toEqual(['connecting']));
    link.workerPresent = () => true;
    link.deliverWorker(true);
    await started;
    expect(rec.phases.map((p) => p.phase)).toEqual(['connecting', 'connected']);
  });

  it('进不了房:报错,而且把房间放回去(不占着一个半死的连接)', async () => {
    const { link, channel } = wire();
    link.failNextAcquire('服务器不理人');
    const rec = recorder();
    await createWbchCallClient({ channel }).start({}, rec.events);
    expect(rec.phases[rec.phases.length - 1]).toEqual({ phase: 'error', error: '服务器不理人' });
    expect(link.holders.has('call')).toBe(false);
  });

  /**
   * 2026-09-18(交接-0918-引导不理人 第二节)。Ben 真机上「她听不到我」查了两轮 ——
   * 一轮怀疑权限、一轮怀疑轨道。轨道这一头以前是**哑的**:
   * `setMicrophoneEnabled(true)` 抛了就掉进那个大 catch,屏幕上只剩一句「通话没接通」;
   * 没抛但一条轨道也没发出去,屏幕上则**什么都不说**。两种都要当场说清楚。
   */
  it('权限给了但麦克风发不出去:电话照通,屏幕上说清楚是麦克风', async () => {
    const { link, channel } = wire();
    link.setMicrophoneEnabled = async () => { throw new Error('WebView 不给采集'); };
    const rec = recorder();
    await createWbchCallClient({ channel }).start({}, rec.events);
    // 电话本身不受影响:她说得出话、打字备胎照样能用。
    expect(rec.phases.map((p) => p.phase)).toEqual(['connecting', 'connected']);
    const last = rec.mic[rec.mic.length - 1];
    expect(last?.granted).toBe(false);
    expect(last?.text).toContain(MIC_PUBLISH_FAILED_TEXT);
    // 原因原样带上,别让人对着一句「她听不到你」猜是权限还是别的。
    expect(last?.text).toContain('WebView 不给采集');
    // 这不是「被永久拒」,不该摆那颗「去设置里打开」。
    expect(last?.needsSettings).toBe(false);
  });

  it('没抛但一条轨道也没发出去:一样要说', async () => {
    const { link, channel } = wire();
    link.setMicrophoneEnabled = async (enabled: boolean) => { link.micLog.push(enabled); return false; };
    const rec = recorder();
    await createWbchCallClient({ channel }).start({}, rec.events);
    expect(rec.phases.map((p) => p.phase)).toEqual(['connecting', 'connected']);
    expect(rec.mic[rec.mic.length - 1]?.text).toContain(MIC_PUBLISH_FAILED_TEXT);
  });

  it('发布成功就不多说一句:界面上不摆红字', async () => {
    const { channel } = wire();
    const rec = recorder();
    await createWbchCallClient({ channel }).start({}, rec.events);
    expect(rec.mic).toEqual([{ granted: true, needsSettings: false }]);
  });

  it('麦克风开关 = 取消/恢复发布本地音轨', async () => {
    const { link, channel } = wire();
    const client = createWbchCallClient({ channel });
    await client.start({}, recorder().events);
    await client.setMuted(true);
    await client.setMuted(false);
    expect(link.micLog).toEqual([true, false, true]);
  });

  it('挂断:先停麦克风再放手,时长算得出来', async () => {
    let clock = 1_000_000;
    const { link, channel } = wire();
    const client = createWbchCallClient({ channel, now: () => clock });
    await client.start({}, recorder().events);
    clock += 7_400;
    const result = await client.hangup();
    expect(link.micLog[link.micLog.length - 1]).toBe(false);
    expect(link.holders.has('call')).toBe(false);
    expect(result.durationSeconds).toBe(7);
  });

  // 「电话必须挂得掉」:拆的时候什么都可能抛,一律吞。
  it('停麦克风 / 放手抛了也照样挂得掉', async () => {
    const { link, channel } = wire();
    const client = createWbchCallClient({ channel });
    await client.start({}, recorder().events);
    link.setMicrophoneEnabled = async () => { throw new Error('拆不动'); };
    await expect(client.hangup()).resolves.toMatchObject({ transcript: [] });
  });
});

describe('字幕', () => {
  it('定稿的进纪要;说到一半的只画在屏幕上', async () => {
    const { channel, caption } = wire();
    const rec = recorder();
    const client = createWbchCallClient({ channel });
    await client.start({}, rec.events);

    caption({ type: 'caption', role: 'me', text: '记一下明天', final: false });
    caption({ type: 'caption', role: 'me', text: '记一下明天上午十点开会', final: true });
    caption({ type: 'caption', role: 'butler', text: '好,记下了', final: true });

    expect(rec.lines).toEqual([
      { who: 'me', text: '记一下明天上午十点开会' },
      { who: 'butler', text: '好,记下了' },
    ]);
    expect(rec.interims).toEqual([null, { who: 'me', text: '记一下明天' }, null, null]);
    const result = await client.hangup();
    expect(result.transcript).toEqual(rec.lines);
  });

  it('挂断之后迟到的字幕不再改界面,也不进纪要', async () => {
    const { channel, caption } = wire();
    const rec = recorder();
    const client = createWbchCallClient({ channel });
    await client.start({}, rec.events);
    const result = await client.hangup();
    caption({ type: 'caption', role: 'butler', text: '迟到的一句', final: true });
    expect(rec.lines).toEqual([]);
    expect(result.transcript).toEqual([]);
  });
});

describe('房里的动静', () => {
  it('谁在出声原样转给球(她在说 / 你在说)', async () => {
    const { link, channel } = wire();
    const rec = recorder();
    await createWbchCallClient({ channel }).start({}, rec.events);
    link.deliverSpeaking('butler', true);
    link.deliverSpeaking('butler', false);
    link.deliverSpeaking('me', true);
    expect(rec.bot).toEqual([true, false]);
    expect(rec.me).toEqual([true]);
  });

  it('挂断之后房里的动静不再改界面', async () => {
    const { link, channel } = wire();
    const rec = recorder();
    const client = createWbchCallClient({ channel });
    await client.start({}, rec.events);
    await client.hangup();
    const before = rec.bot.length;
    link.deliverSpeaking('butler', true);
    expect(rec.bot).toHaveLength(before);
  });

  it('房间自己断了(掉网/被踢)如实说一声,不留一个写着「通话中」的屏', async () => {
    const { link, channel } = wire();
    const rec = recorder();
    await createWbchCallClient({ channel }).start({}, rec.events);
    link.setState('closed');
    await vi.waitFor(() => expect(rec.phases[rec.phases.length - 1]).toEqual({ phase: 'error', error: '房间断开了' }));
  });
});

/**
 * 引导模式(2026-09-18)。要守住的:
 *   1. 接通那一刻告诉工人「我在做引导」——它据此换提示、立刻开口(开场白不再等模型);
 *   2. 接不上就如实说那句原话,**不当成接通**(不然屏幕上写着「通话中」而她永远不开口);
 *   3. 挂断 = 告诉工人暂停(进度在 onboarding.json);
 *   4. 打字备胎走同一条路。
 */
describe('引导模式', () => {
  function withOnboarding(reply: { ok: true; stage?: string } | { ok: false; error: string } = { ok: true, stage: 'opening' }) {
    const calls: { action: string; text?: string }[] = [];
    const wired = wire({
      onboarding: async (action, text) => { calls.push({ action, ...(text === undefined ? {} : { text }) }); return reply; },
    });
    return { ...wired, calls };
  }

  it('接通那一刻发一条 start(接着做时发 resume)', async () => {
    const { channel, calls } = withOnboarding();
    const rec = recorder();
    await createWbchCallClient({ channel }).start({ onboarding: { resume: false } }, rec.events);
    expect(calls).toEqual([{ action: 'start' }]);
    expect(rec.phases.map((p) => p.phase)).toEqual(['connecting', 'connected']);

    const second = withOnboarding();
    await createWbchCallClient({ channel: second.channel }).start({ onboarding: { resume: true } }, recorder().events);
    expect(second.calls).toEqual([{ action: 'resume' }]);
  });

  it('工人接不了引导:说那句原话,不报接通,房间也放回去', async () => {
    const { link, channel } = withOnboarding({ ok: false, error: '电脑上的事务官现在接不了引导(没有接话模型)' });
    const rec = recorder();
    await createWbchCallClient({ channel }).start({ onboarding: { resume: false } }, rec.events);
    expect(rec.phases.map((p) => p.phase)).toEqual(['connecting', 'error']);
    expect(rec.phases[1]?.error).toContain('接不了引导');
    expect(link.holders.has('call')).toBe(false);
  });

  it('挂断 = 暂停引导;打字备胎走同一条 wb.rpc', async () => {
    const { channel, calls } = withOnboarding();
    const client = createWbchCallClient({ channel });
    await client.start({ onboarding: { resume: false } }, recorder().events);
    await client.sayText?.('叫我 Ben');
    await client.hangup();
    expect(calls).toEqual([{ action: 'start' }, { action: 'say', text: '叫我 Ben' }, { action: 'stop' }]);
  });

  it('不是引导的那一通:不发引导消息,也不能打字', async () => {
    const { channel, calls } = withOnboarding();
    const client = createWbchCallClient({ channel });
    await client.start({}, recorder().events);
    const said = await client.sayText?.('喂');
    expect(said).toMatchObject({ ok: false });
    await client.hangup();
    expect(calls).toEqual([]);
  });
});

/**
 * 录音权限(2026-09-18,Ben 真机:「没有去要录音的权限,我说话它听不到」)。
 *
 * 两条纪律:**进房之前问**(弹框不该压在一通已经接通的电话上),
 * **拒了不静默**(通话照常,但屏幕上要说清「她听不到你」,能去设置就给那条路)。
 */
describe('录音权限', () => {
  it('**先问权限,再进房**——顺序反了弹框就压在开场白上', async () => {
    const order: string[] = [];
    const link = createFakeLink();
    const channel = fakeChannel({
      link,
      acquireCall: async () => {
        order.push('进房');
        await link.acquire('call', { url: 'u', room: 'r', identity: 'i', token: 't', expires_at: 9e9 });
      },
    });
    const rec = recorder();
    await rawCallClient({
      ...NO_WARM,
      channel,
      askMicPermission: async () => { order.push('问权限'); return MIC_GRANTED; },
    }).start({}, rec.events);
    expect(order).toEqual(['问权限', '进房']);
    expect(rec.mic).toEqual([{ granted: true, needsSettings: false }]);
  });

  it('被永久拒:**电话照样接通**(她说得出话、能打字),但如实报一条「要去设置里开」', async () => {
    const { link, channel } = wire();
    const rec = recorder();
    await rawCallClient({
      ...NO_WARM,
      channel,
      askMicPermission: async () => ({ state: 'denied', granted: false, needsSettings: true, via: 'native' }),
    }).start({}, rec.events);
    expect(rec.mic).toEqual([{ granted: false, needsSettings: true }]);
    // 关键:没有把它变成一条 error —— 那会让人以为是网络的问题。
    expect(rec.phases.map((p) => p.phase)).toEqual(['connecting', 'connected']);
    expect(link.holders.has('call')).toBe(true);
  });

  /**
   * 2026-09-24 改(卡 fix/call-mute-before-publish)。以前这一条钉的是「没权限时那颗键一下 SDK 都不碰」,
   * 而接通时仍然顺手 `setMicrophoneEnabled(true)` 试一下 —— 那一下真发出去了的话,麦克风开着、
   * 屏幕上写着「没有录音权限」、那颗键又按不动。现在钉更硬的那一条:**没权限就从头到尾不去开**,
   * 按键怎么按都开不了;关是永远可以的(关不到的只有本来就没有的)。
   */
  it('没权限:从头到尾不去开麦克风,那颗键怎么按都开不了(她本来就听不见你)', async () => {
    const { link, channel } = wire();
    const rec = recorder();
    const client = rawCallClient({
      ...NO_WARM,
      channel,
      askMicPermission: async () => ({ state: 'denied', granted: false, needsSettings: true, via: 'native' }),
    });
    await client.start({}, rec.events);
    await client.setMuted(true);
    await client.setMuted(false);
    expect(link.micLog).not.toContain(true);
    // 屏幕上那一行照旧如实说(不多一条、不改口)。
    expect(rec.mic).toEqual([{ granted: false, needsSettings: true }]);
    expect(rec.phases.map((p) => p.phase)).toEqual(['connecting', 'connected']);
  });

  it('引导那一通走的是**同一条**路(一通电话就是一通电话)', async () => {
    const asked: number[] = [];
    const { channel } = wire({ onboarding: async () => ({ ok: true, stage: 'opening' }) });
    await rawCallClient({
      ...NO_WARM,
      channel,
      askMicPermission: async () => { asked.push(1); return MIC_GRANTED; },
    }).start({ onboarding: { resume: false } }, recorder().events);
    expect(asked).toHaveLength(1);
  });
});

/**
 * 招呼与主导方(2026-09-18)。Ben 真机:「接通的瞬间它说『你说』」——
 * 那句招呼原先是工人一进房就说的,排在音频队列里等第一台手机进来才出声。
 */
describe('招呼与主导方', () => {
  it('普通通话:接通后点名要一句招呼', async () => {
    const greeted: number[] = [];
    const { channel } = wire({ callStart: async () => { greeted.push(1); return { ok: true }; } });
    await createWbchCallClient({ channel }).start({}, recorder().events);
    expect(greeted).toHaveLength(1);
  });

  it('引导那一通**从不**要招呼:接通第一句必须是开场白', async () => {
    const greeted: number[] = [];
    const { channel } = wire({
      callStart: async () => { greeted.push(1); return { ok: true }; },
      onboarding: async () => ({ ok: true, stage: 'opening' }),
    });
    await createWbchCallClient({ channel }).start({ onboarding: { resume: false } }, recorder().events);
    expect(greeted).toEqual([]);
  });

  /*
   * 2026-09-25 返工推翻了 09-18 那条「招呼说不出去不拦通话」:从收音闸起,工人收到这一条才进通话、才开始听 ——
   * 它回「不行」(没有接话模型、不认这台手机、办的时候抛了),接通了也是白通。照原话说,不报接通,不开麦。
   */
  it('★ 工人接不起(回了「不行」):照原话说,不报接通,不开麦;补一句挂了', async () => {
    const hungUp: number[] = [];
    const { link, channel } = wire({
      callStart: async () => ({ ok: false, error: '电脑上的事务官现在接不了话(没有接话模型)' }),
      hangupCall: async () => { hungUp.push(1); return { ok: true }; },
    });
    const rec = recorder();
    await createWbchCallClient({ channel }).start({}, rec.events);
    expect(rec.phases).toEqual([{ phase: 'connecting' }, { phase: 'error', error: '电脑上的事务官现在接不了话(没有接话模型)' }]);
    expect(link.micLog).not.toContain(true);
    expect(hungUp).toHaveLength(1);
    expect(link.holders.has('call')).toBe(false);
  });

  it('引导归电脑管:照样接通,但把 leader 交给界面(它据此说「先别说」)', async () => {
    const { channel } = wire({ onboarding: async () => ({ ok: true, stage: 'branch', leader: 'desktop' }) });
    const rec = recorder();
    await createWbchCallClient({ channel }).start({ onboarding: { resume: false } }, rec.events);
    expect(rec.leaders).toEqual(['desktop']);
    expect(rec.phases.map((p) => p.phase)).toEqual(['connecting', 'connected']);
  });

  it('「改回手机」之后再发一次 start,而且**照原样带着 resume**', async () => {
    let leader = 'desktop';
    const calls: { action: string }[] = [];
    const { channel } = wire({
      onboarding: async (action) => {
        calls.push({ action });
        return leader === 'desktop' ? { ok: true, stage: 'branch', leader } : { ok: true, stage: 'branch', leader: 'phone' };
      },
    });
    const client = createWbchCallClient({ channel });
    await client.start({ onboarding: { resume: true } }, recorder().events);
    leader = 'phone';
    await expect(client.retryOnboarding?.()).resolves.toEqual({ ok: true });
    expect(calls.map((c) => c.action)).toEqual(['resume', 'resume']);
  });

  it('电脑那边还占着:「改回手机」如实说一句,不假装成了', async () => {
    const { channel } = wire({ onboarding: async () => ({ ok: true, stage: 'branch', leader: 'desktop' }) });
    const client = createWbchCallClient({ channel });
    await client.start({ onboarding: { resume: false } }, recorder().events);
    const again = await client.retryOnboarding?.();
    expect(again).toMatchObject({ ok: false });
  });
});

/**
 * 缓冲语接线(2026-09-20 第二版)。这里验的是**这一层**把三条线接对了没有:
 * 信号进来 → 垫的那一句进字幕与纪要;她那条字幕 / 音轨有能量 / 他开口 → 掐;挂断 → 拆干净。
 * 「等多久、挑哪句、怎么淡出」在 fillerAudio.test.ts 里验,那一份不需要一条电话。
 */
describe('缓冲语', () => {
  /** 一个记账用的假缓冲语:不放音频,只记「被叫了什么」。 */
  function fakeFiller() {
    const log: string[] = [];
    let played: ((line: { id: string; kind: 'thinking'; text: string }) => void) | undefined;
    const createFiller: Parameters<typeof rawCallClient>[0]['createFiller'] = (hooks) => {
      played = hooks.onPlayed;
      return {
        signal: (s) => log.push(`signal:${s.kind}:${s.tool ?? '-'}:${s.round}`),
        butlerSpoke: () => log.push('butlerSpoke'),
        setRemoteSpeaking: (s) => log.push(`remote:${s}`),
        userSpoke: () => log.push('userSpoke'),
        dispose: () => log.push('dispose'),
      };
    };
    return { log, createFiller, play: (text: string) => played?.({ id: 'think-1', kind: 'thinking', text }) };
  }

  it('工人的信号原样递进去(轮号与工具名一个都不能丢)', async () => {
    const { channel, filler } = wire();
    const fake = fakeFiller();
    const rec = recorder();
    await createWbchCallClient({ channel, createFiller: fake.createFiller }).start({}, rec.events);
    filler({ type: 'filler', kind: 'thinking', round: 1, at: 10 });
    filler({ type: 'filler', kind: 'tool', tool: 'scan_projects', round: 1, at: 20 });
    expect(fake.log).toEqual(['signal:thinking:-:1', 'signal:tool:scan_projects:1']);
  });

  it('★ 工人已经用当前音色自己垫了(voiced_by:worker)→ 这台手机一句都不放;老工人不带标记 → 照老行为', async () => {
    const { channel, filler } = wire();
    const fake = fakeFiller();
    const rec = recorder();
    await createWbchCallClient({ channel, createFiller: fake.createFiller }).start({}, rec.events);
    filler({ type: 'filler', kind: 'thinking', round: 1, at: 10, voiced_by: 'worker' });
    filler({ type: 'filler', kind: 'tool', tool: 'scan_projects', round: 1, at: 20, voiced_by: 'worker' });
    expect(fake.log).toEqual([]);
    filler({ type: 'filler', kind: 'thinking', round: 2, at: 30 });
    expect(fake.log).toEqual(['signal:thinking:-:2']);
  });

  /**
   * 引导里「她在找你的项目」那一整段(2026-09-24 傍晚,卡 fix/scan-orb-working-whole-wait):
   * 慢工具开跑 / 跑完的信号不管垫不垫话都转给界面;`tool_done` 不垫话;她的字幕报一声「她开口了」,手机本地垫的那句不算。
   */
  it('★ 工具开跑 / 跑完转给界面(voiced_by:worker 也转);tool_done 不进缓冲语', async () => {
    const { channel, filler } = wire();
    const fake = fakeFiller();
    const tools: string[] = [];
    const rec = recorder();
    await createWbchCallClient({ channel, createFiller: fake.createFiller }).start({}, { ...rec.events, onTool: (e) => tools.push(`${e.state}:${e.tool}`) });
    filler({ type: 'filler', kind: 'tool', tool: 'scan_projects', round: 1, at: 10, voiced_by: 'worker' });
    filler({ type: 'filler', kind: 'tool_done', tool: 'scan_projects', round: 1, at: 20, voiced_by: 'worker' });
    filler({ type: 'filler', kind: 'tool', tool: 'read_project', round: 1, at: 30 });
    filler({ type: 'filler', kind: 'tool_done', tool: 'read_project', round: 1, at: 40 });
    expect(tools).toEqual(['start:scan_projects', 'done:scan_projects', 'start:read_project', 'done:read_project']);
    // 没带 voiced_by 的 tool 照老行为垫;tool_done 一条都不进缓冲语。
    expect(fake.log).toEqual(['signal:tool:read_project:1']);
  });

  it('★ 她的字幕(定稿或中间结果)报「她开口了」;他的字幕、手机本地垫的那句都不算', async () => {
    const { channel, caption } = wire();
    const fake = fakeFiller();
    let spoke = 0;
    const rec = recorder();
    await createWbchCallClient({ channel, createFiller: fake.createFiller }).start({}, { ...rec.events, onButlerSpeech: () => { spoke += 1; } });
    fake.play('我查一下,稍等。');
    caption({ type: 'caption', role: 'me', text: '工作台', final: true });
    expect(spoke).toBe(0);
    caption({ type: 'caption', role: 'butler', text: '找到了,是 desktop-workbench。', final: false });
    caption({ type: 'caption', role: 'butler', text: '找到了,是 desktop-workbench。', final: true });
    expect(spoke).toBe(2);
  });

  it('垫出去的那一句**当成她说的一句**进字幕与纪要(屏幕上和上一版一模一样)', async () => {
    const { channel } = wire();
    const fake = fakeFiller();
    const rec = recorder();
    const client = createWbchCallClient({ channel, createFiller: fake.createFiller });
    await client.start({}, rec.events);
    fake.play('我想想。');
    expect(rec.lines).toEqual([{ who: 'butler', text: '我想想。' }]);
    const result = await client.hangup();
    expect(result.transcript).toEqual([{ who: 'butler', text: '我想想。' }]);
  });

  it('**她那条字幕 = 她的真声要来了** → 掐;他那条 → 也掐', async () => {
    const { channel, caption } = wire();
    const fake = fakeFiller();
    const rec = recorder();
    await createWbchCallClient({ channel, createFiller: fake.createFiller }).start({}, rec.events);
    caption({ type: 'caption', role: 'butler', text: '我在。你说。', final: true });
    caption({ type: 'caption', role: 'me', text: '你就叫我本吧。', final: false });
    expect(fake.log).toEqual(['butlerSpoke', 'userSpoke']);
  });

  it('音轨有没有能量照样递进去(字幕丢了一条还有这一路),他开口也递', async () => {
    const { channel, link } = wire();
    const fake = fakeFiller();
    const rec = recorder();
    await createWbchCallClient({ channel, createFiller: fake.createFiller }).start({}, rec.events);
    link.deliverSpeaking('butler', true);
    link.deliverSpeaking('me', true);
    expect(fake.log).toEqual(['remote:true', 'userSpoke']);
    // 球的形态那一路一个字都没变(缓冲语不许改它)。
    expect(rec.bot).toEqual([true]);
    expect(rec.me).toEqual([true]);
  });

  it('挂断把它拆干净(不然七个 `<audio>` 会留在内存里)', async () => {
    const { channel } = wire();
    const fake = fakeFiller();
    const rec = recorder();
    const client = createWbchCallClient({ channel, createFiller: fake.createFiller });
    await client.start({}, rec.events);
    await client.hangup();
    expect(fake.log).toContain('dispose');
  });

  it('挂断之后再来信号不做任何事', async () => {
    const { channel, filler } = wire();
    const fake = fakeFiller();
    const rec = recorder();
    const client = createWbchCallClient({ channel, createFiller: fake.createFiller });
    await client.start({}, rec.events);
    await client.hangup();
    filler({ type: 'filler', kind: 'thinking', round: 2, at: 30 });
    expect(fake.log.filter((line) => line.startsWith('signal:'))).toEqual([]);
  });
});


/**
 * 缓冲语的音色对齐(2026-09-22)。这里只钉**接线**那三件:
 * 进房会去对齐一次、对齐不挡接通、电脑上换了音色这一通里只记一笔。
 * 缓存键与兜底本身在 tests/fillerVoiceCache.test.ts 里。
 */
describe('缓冲语跟着当前音色走', () => {
  function fakeCache() {
    const calls: string[] = [];
    const cache = {
      urlFor: (id: string) => `blob:${id}`,
      voice: () => 'V1',
      markStale: (voice?: string) => { calls.push(`stale:${voice ?? ''}`); },
      stale: () => calls.some((one) => one.startsWith('stale')),
      refresh: async () => { calls.push('refresh'); return { voice: 'V1', cached: 0, synthesized: 7, bundled: 0, trimmedMs: 0 }; },
      dispose: () => { calls.push('dispose'); },
    };
    return { cache, calls };
  }

  it('★进房就对齐一次;挂断把它放掉', async () => {
    const { link, channel } = wire();
    const { cache, calls } = fakeCache();
    const client = createWbchCallClient({ channel, createVoiceCache: () => cache });
    await client.start({}, recorder().events);
    expect(calls).toContain('refresh');
    await client.hangup();
    expect(calls).toContain('dispose');
    expect(link.micLog).toEqual([true, false]);
  });

  it('★对齐那一步慢/失败都不挡接通 —— 它是 void 出去的', async () => {
    const { channel } = wire();
    const rec = recorder();
    const slow = { ...fakeCache().cache, refresh: async () => new Promise<never>(() => {}) };
    await createWbchCallClient({ channel, createVoiceCache: () => slow as never }).start({}, rec.events);
    expect(rec.phases.map((p) => p.phase)).toEqual(['connecting', 'connected']);
  });

  it('★电脑上换了音色:这一通里只记一笔,不当场重新合成七句', async () => {
    const { channel, voiceChanged } = wire();
    const { cache, calls } = fakeCache();
    await createWbchCallClient({ channel, createVoiceCache: () => cache }).start({}, recorder().events);
    calls.length = 0;
    voiceChanged('V2');
    expect(calls).toEqual(['stale:V2']);
    expect(calls).not.toContain('refresh');
  });

  it('没接 api、也没注入缓存时照旧能打(那时放的是包里那七句)', async () => {
    const { channel } = wire();
    const rec = recorder();
    await createWbchCallClient({ channel, createVoiceCache: () => null }).start({}, rec.events);
    expect(rec.phases.map((p) => p.phase)).toEqual(['connecting', 'connected']);
  });
});

/**
 * 电脑那边挂了(2026-09-23 晚,维护者真机 0.2.73「说了拜拜之后没有真的拜拜」)。
 * 他道了别、她回了一句,工人在那句播完之后挂断,广播 `call_state{idle, by:'worker'}`。
 */
describe('她道过别,由她挂', () => {
  type RingMsg = Parameters<Parameters<ReturnType<typeof fakeChannel>['onRing']>[0]>[0];
  function ringWire(patch: Parameters<typeof fakeChannel>[0] = {}) {
    const rings: ((m: RingMsg) => void)[] = [];
    const hangupCall = vi.fn(async () => ({ ok: true as const }));
    const w = wire({
      onRing: (listener) => { rings.push(listener); return () => { rings.splice(rings.indexOf(listener), 1); }; },
      hangupCall,
      ...patch,
    });
    const push = (m: RingMsg) => { for (const l of [...rings]) l(m); };
    return { ...w, push, hangupCall, listeners: () => rings.length };
  }
  const idle = (by: 'phone' | 'handset' | 'worker'): RingMsg => ({ type: 'call_state', state: 'idle', by, started_at: 1 });

  it('★★ 自己拨的那一通:收到 idle(by:worker)→ 告诉上一层「电脑那边挂了」', async () => {
    const { channel, push } = ringWire();
    const remote = vi.fn();
    const rec = recorder();
    await createWbchCallClient({ channel }).start({}, { ...rec.events, onRemoteHangup: remote });
    push(idle('worker'));
    expect(remote).toHaveBeenCalledTimes(1);
  });

  it('我自己挂的那条回声(by:phone)不认;in_call 不认', async () => {
    const { channel, push } = ringWire();
    const remote = vi.fn();
    await createWbchCallClient({ channel }).start({}, { ...recorder().events, onRemoteHangup: remote });
    push(idle('phone'));
    push({ type: 'call_state', state: 'in_call', by: 'worker' as never, started_at: 1 });
    expect(remote).not.toHaveBeenCalled();
  });

  it('★ 她打来、我接起的那一通不归这条管(来电状态机收它,两条都认就挂两遍)', async () => {
    const { channel, push } = ringWire();
    const remote = vi.fn();
    await createWbchCallClient({ channel }).start({ incoming: { callId: 'c1' } }, { ...recorder().events, onRemoteHangup: remote });
    push(idle('worker'));
    expect(remote).not.toHaveBeenCalled();
  });

  it('挂断之后不再听(订阅收掉)', async () => {
    const { channel, push, listeners } = ringWire();
    const remote = vi.fn();
    const client = createWbchCallClient({ channel });
    await client.start({}, { ...recorder().events, onRemoteHangup: remote });
    await client.hangup();
    expect(listeners()).toBe(0);
    push(idle('worker'));
    expect(remote).not.toHaveBeenCalled();
  });

  it('★ 自己拨的那一通挂断也告诉工人(以前一个字不说,工人那边的通话状态与纪要一直开着)', async () => {
    const { channel, hangupCall } = ringWire();
    const client = createWbchCallClient({ channel });
    await client.start({}, recorder().events);
    await client.hangup();
    expect(hangupCall).toHaveBeenCalledTimes(1);
  });

  it('引导那一通、没接通的那一通不发挂断', async () => {
    const a = ringWire();
    const onboardingClient = createWbchCallClient({ channel: a.channel });
    await onboardingClient.start({ onboarding: { resume: false } }, recorder().events);
    await onboardingClient.hangup();
    expect(a.hangupCall).not.toHaveBeenCalled();

    const b = ringWire();
    b.link.workerPresent = () => false;
    const failed = createWbchCallClient({ channel: b.channel, workerWaitMs: 20 });
    await failed.start({}, recorder().events);
    await failed.hangup();
    expect(b.hangupCall).not.toHaveBeenCalled();
  });
});

/**
 * ——— 静音以他的意愿为准(2026-09-24,卡 fix/call-mute-before-publish)———
 *
 * 统筹真机 0.2.81(Pixel,手机引导电话):接通过程中按「关掉麦克风」—— 键一出现的 0.57 秒、
 * 冷启动后第一通的 4–5 秒 —— 界面上已经是「麦克风已关,事务官听不见你」,工人日志里之后
 * 几十秒照样有「他说(ASR)」:旁边人的说话声被收走、识别、写进日志。接通 5 秒后再按就生效。
 *
 * 根子:那一下只对着**此刻的轨道**说一句「关」(权限还没问完就不管、房还没进好就抛了被吞、
 * 轨道还没发布就什么都关不到),随后接通流程照样发布。下面这几条用的是 `trackMic` 那条假轨道:
 * 它按 SDK 那一侧真正落地的顺序记「在不在发」,卡着的发布回来之后又开了,一定看得出来。
 */
describe('★ 静音以他的意愿为准', () => {
  /** 进房那一步卡住、等用例放行的通道。`entering` 变 true = 权限已经问完、正卡在进房。 */
  function slowRoom() {
    const link = createFakeLink();
    const track = trackMic(link);
    const gate = deferred<void>();
    const state = { entering: false };
    const channel = fakeChannel({
      link,
      acquireCall: async () => { state.entering = true; await gate.promise; await link.acquire('call', fakeCredential()); },
    });
    return { link, track, channel, state, enter: () => gate.resolve() };
  }

  it('★★ 权限还没问完就按了静音(键一出现的 0.57 秒):从头到尾不发布,接通照常,最终是关的', async () => {
    const { link, channel } = wire();
    const track = trackMic(link);
    const asked = deferred<MicPermissionResult>();
    const rec = recorder();
    const client = rawCallClient({ ...NO_WARM, channel, askMicPermission: () => asked.promise });
    const started = client.start({}, rec.events);
    await client.setMuted(true);
    asked.resolve(MIC_GRANTED);
    await started;
    expect(rec.phases.map((p) => p.phase)).toEqual(['connecting', 'connected']);
    expect(link.micLog).not.toContain(true);
    expect(track.live).toBe(false);
    // 这不是「发不出去」,是他不要:屏幕上不多一条红字。
    expect(rec.mic).toEqual([{ granted: true, needsSettings: false }]);
    // 他取消静音 —— 这时才发。
    await client.setMuted(false);
    expect(track.live).toBe(true);
  });

  it('★★ 权限问完、房还没进好就按了静音(冷启动后第一通的 4–5 秒):照样不发', async () => {
    const { link, track, channel, state, enter } = slowRoom();
    const rec = recorder();
    const client = createWbchCallClient({ channel });
    const started = client.start({}, rec.events);
    await vi.waitFor(() => expect(state.entering).toBe(true));
    await client.setMuted(true);
    enter();
    await started;
    expect(rec.phases.map((p) => p.phase)).toEqual(['connecting', 'connected']);
    expect(link.micLog).not.toContain(true);
    expect(track.live).toBe(false);
  });

  it('★★ 发布那一下还没回来就按了静音:一回来当场关,最终是关的;不当成「发不出去」', async () => {
    const { link, channel } = wire();
    const track = trackMic(link);
    const release = track.holdPublish();
    const rec = recorder();
    const client = createWbchCallClient({ channel });
    const started = client.start({}, rec.events);
    // 发布已经发出去、还没回来(冷启动 getUserMedia + 协商那几秒)。
    await vi.waitFor(() => expect(link.micLog).toEqual([true]));
    const muting = client.setMuted(true);
    release();
    await Promise.all([started, muting]);
    expect(track.live).toBe(false);
    expect(link.micLog[link.micLog.length - 1]).toBe(false);
    expect(rec.mic).toEqual([{ granted: true, needsSettings: false }]);
    expect(rec.phases.map((p) => p.phase)).toEqual(['connecting', 'connected']);
  });

  it('发布那几秒里连按几下:以最后一下为准', async () => {
    for (const presses of [[true, false, true], [true, false], [true, false, true, false, true]]) {
      const { link, channel } = wire();
      const track = trackMic(link);
      const release = track.holdPublish();
      const client = createWbchCallClient({ channel });
      const started = client.start({}, recorder().events);
      await vi.waitFor(() => expect(link.micLog).toEqual([true]));
      const pressing = presses.map((muted) => client.setMuted(muted));
      release();
      await Promise.all([started, ...pressing]);
      expect(track.live).toBe(!presses[presses.length - 1]);
    }
  });

  it('接通之后:按一下关,再按一下开(轨道跟着走)', async () => {
    const { link, channel } = wire();
    const track = trackMic(link);
    const client = createWbchCallClient({ channel });
    await client.start({}, recorder().events);
    expect(track.live).toBe(true);
    await client.setMuted(true);
    expect(track.live).toBe(false);
    await client.setMuted(false);
    expect(track.live).toBe(true);
  });

  it('★ 换房那条路(等不到工人 → 核对出换了房):静音着就不在新房间里重发;取消静音才发', async () => {
    const link = createFakeLink();
    const track = trackMic(link);
    let present = false;
    let checking = false;
    link.workerPresent = () => present;
    const moved = deferred<WbchRoomCheck>();
    const channel = fakeChannel({
      link,
      acquireCall: async () => { await link.acquire('call', fakeCredential()); },
      recheckRoom: async () => { checking = true; const check = await moved.promise; present = true; return check; },
    });
    const rec = recorder();
    const client = createWbchCallClient({ channel, workerWaitMs: 10 });
    const started = client.start({}, rec.events);
    // 等工人、核对房间的这几秒里**麦克风还没开**(2026-09-25:真接通了才开)——他这会儿按了静音。
    await vi.waitFor(() => expect(checking).toBe(true));
    expect(link.micLog).not.toContain(true);
    await client.setMuted(true);
    moved.resolve({ kind: 'moved', from: 'workbench', to: 'wb-8913' });
    await started;
    expect(rec.phases.map((p) => p.phase)).toEqual(['connecting', 'connected']);
    expect(link.micLog).not.toContain(true);
    expect(track.live).toBe(false);
    await client.setMuted(false);
    expect(track.live).toBe(true);
  });

  it('★ 新一通复位成开:上一通按过的静音不带到这一通', async () => {
    const { link, channel } = wire();
    const track = trackMic(link);
    const client = createWbchCallClient({ channel });
    await client.start({}, recorder().events);
    await client.setMuted(true);
    await client.hangup();
    expect(track.live).toBe(false);
    await client.start({}, recorder().events);
    expect(track.live).toBe(true);
  });

  const threeKinds: [string, CallStartOptions][] = [
    ['平时电话', {}],
    ['引导通话', { onboarding: { resume: false } }],
    ['来电接起', { incoming: { callId: 'c1' } }],
  ];
  for (const [name, options] of threeKinds) {
    it(`三条路一样:${name}接通过程中按的静音照样算数`, async () => {
      const { link, track, channel, state, enter } = slowRoom();
      const rec = recorder();
      const client = createWbchCallClient({ channel });
      const started = client.start(options, rec.events);
      await vi.waitFor(() => expect(state.entering).toBe(true));
      await client.setMuted(true);
      enter();
      await started;
      expect(rec.phases.map((p) => p.phase)).toEqual(['connecting', 'connected']);
      expect(link.micLog).not.toContain(true);
      expect(track.live).toBe(false);
    });
  }

  it('★★ 进房那几秒里挂断:不开喇叭、不发麦克风(以前挂了照样往下走,麦克风留在常驻房间里一直开着)', async () => {
    const { link, track, channel, state, enter } = slowRoom();
    // 常驻房间:来电那一份一直拿着(App 活着就在房里)。
    await link.acquire('ring', fakeCredential());
    const client = createWbchCallClient({ channel });
    const started = client.start({}, recorder().events);
    await vi.waitFor(() => expect(state.entering).toBe(true));
    await client.hangup();
    enter();
    await started;
    expect(link.micLog).not.toContain(true);
    expect(link.speakerLog).not.toContain(true);
    expect(track.live).toBe(false);
  });

  it('★ 发布那一下还没回来就挂断:一回来当场关', async () => {
    const { link, channel } = wire();
    const track = trackMic(link);
    const release = track.holdPublish();
    const client = createWbchCallClient({ channel });
    const started = client.start({}, recorder().events);
    await vi.waitFor(() => expect(link.micLog).toEqual([true]));
    const hanging = client.hangup();
    release();
    await Promise.all([started, hanging]);
    expect(track.live).toBe(false);
  });

  it('★ 挂断先关麦克风:「告诉工人挂了」那一条还没回话时,麦克风已经不在发了', async () => {
    const said = deferred<{ ok: true }>();
    const { link, channel } = wire({ hangupCall: () => said.promise });
    const track = trackMic(link);
    const client = createWbchCallClient({ channel });
    await client.start({}, recorder().events);
    expect(track.live).toBe(true);
    const hanging = client.hangup();
    await vi.waitFor(() => expect(track.live).toBe(false));
    said.resolve({ ok: true });
    await hanging;
    expect(link.holders.has('call')).toBe(false);
  });

  it('接通时正静音着、第一次取消静音才发 —— 那一下发不出去照样当场说清楚,之后不再装作能开', async () => {
    const { link, channel } = wire();
    link.setMicrophoneEnabled = async (enabled: boolean) => {
      link.micLog.push(enabled);
      if (enabled) throw new Error('WebView 不给采集');
      return false;
    };
    const asked = deferred<MicPermissionResult>();
    const rec = recorder();
    const client = rawCallClient({ ...NO_WARM, channel, askMicPermission: () => asked.promise });
    const started = client.start({}, rec.events);
    await client.setMuted(true);
    asked.resolve(MIC_GRANTED);
    await started;
    expect(rec.mic).toEqual([{ granted: true, needsSettings: false }]);
    await client.setMuted(false);
    const last = rec.mic[rec.mic.length - 1];
    expect(last?.granted).toBe(false);
    expect(last?.text).toContain(MIC_PUBLISH_FAILED_TEXT);
    expect(last?.text).toContain('WebView 不给采集');
    expect(last?.needsSettings).toBe(false);
    const tries = link.micLog.filter(Boolean).length;
    await client.setMuted(true);
    await client.setMuted(false);
    expect(link.micLog.filter(Boolean).length).toBe(tries);
  });

  it('一次开永远不回,也挡不住后面那一下「关」(队列最多等一阵)', async () => {
    const { link, channel } = wire();
    let stuck = true;
    link.setMicrophoneEnabled = async (enabled: boolean) => {
      link.micLog.push(enabled);
      if (enabled && stuck) { stuck = false; return new Promise<boolean>(() => {}); }
      return enabled;
    };
    const client = createWbchCallClient({ channel, micQueueWaitMs: 20 });
    void client.start({}, recorder().events);
    await vi.waitFor(() => expect(link.micLog).toEqual([true]));
    await client.setMuted(true);
    expect(link.micLog[link.micLog.length - 1]).toBe(false);
  });
});

/**
 * ——— 麦克风只在「真的接通了」的时候开,收场就撤轨道(2026-09-25,卡 fix/evening-gaps 第 1 条)———
 *
 * 两段真机证据:
 *   · 小米测试机配对后自动开的那通引导:房里「身份被拒」,一直停在「正在接通…」,
 *     Android 录音记录 21:28:30 开 → 21:33:18 才放(`src:VOICE_COMMUNICATION not silenced pack:ai.ben.butler`)——
 *     电话没通,麦克风开了 5 分钟;
 *   · 维护者 18:52 挂断引导,手机常驻房间、挂断只静音:轨道一直挂着,工人 18:53–19:19 订着它跑 VAD 与火山识别。
 * 所以:① 等工人、问引导接不接得上,都在开麦**之前**;② 挂断 / 接不通 / 出错一律**撤轨道、停录音**,通话里的静音才是 mute。
 */
describe('★★ 隐私:没接通不开麦,收场撤轨道', () => {
  it('★★ 引导那一条还没回话(正在接通…):麦克风没开;回了「接上了」才开', async () => {
    const answer = deferred<{ ok: true; stage?: string }>();
    const { link, channel } = wire({ onboarding: () => answer.promise });
    const track = trackMic(link);
    const rec = recorder();
    const started = createWbchCallClient({ channel }).start({ onboarding: { resume: false } }, rec.events);
    await vi.waitFor(() => expect(link.speakerLog).toEqual([true]));
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    expect(link.micLog).not.toContain(true);
    expect(track.live).toBe(false);
    answer.resolve({ ok: true, stage: 'opening' });
    await started;
    expect(track.live).toBe(true);
    expect(rec.phases.map((p) => p.phase)).toEqual(['connecting', 'connected']);
  });

  it('★★ 引导接不上(工人没回话 / 不认这台手机):从头到尾不开麦,收场撤轨道、放掉房间', async () => {
    const { link, channel } = wire({ onboarding: async () => ({ ok: false, error: '经房间问电脑上的事务官,等了很久没回话' }) });
    const rec = recorder();
    await createWbchCallClient({ channel }).start({ onboarding: { resume: false } }, rec.events);
    expect(rec.phases.map((p) => p.phase)).toEqual(['connecting', 'error']);
    expect(rec.phases[1]?.error).toContain('引导接不上');
    expect(link.micLog).not.toContain(true);
    expect(link.micStops).toBeGreaterThan(0);
    expect(link.holders.has('call')).toBe(false);
    expect(link.speakerLog).toEqual([true, false]);
  });

  it('★ 电脑说引导早就做完了:不留一个没人说话的通话页,不开麦,说清一句', async () => {
    const { link, channel } = wire({ onboarding: async () => ({ ok: true, stage: 'done' }) });
    const rec = recorder();
    await createWbchCallClient({ channel }).start({ onboarding: { resume: false } }, rec.events);
    expect(rec.phases.map((p) => p.phase)).toEqual(['connecting', 'error']);
    expect(rec.phases[1]?.error).toContain('引导已经做完了');
    expect(link.micLog).not.toContain(true);
    expect(link.holders.has('call')).toBe(false);
  });

  it('★ 引导归电脑管:接通了但不开麦(她不说话、电脑也不听);按「改回手机」她开口了才开', async () => {
    let lead: 'desktop' | 'phone' = 'desktop';
    const { link, channel } = wire({ onboarding: async () => ({ ok: true, stage: 'branch', leader: lead }) });
    const track = trackMic(link);
    const rec = recorder();
    const client = createWbchCallClient({ channel });
    await client.start({ onboarding: { resume: false } }, rec.events);
    expect(rec.phases.map((p) => p.phase)).toEqual(['connecting', 'connected']);
    expect(rec.leaders).toEqual(['desktop']);
    expect(track.live).toBe(false);
    lead = 'phone';
    await expect(client.retryOnboarding?.()).resolves.toEqual({ ok: true });
    await vi.waitFor(() => expect(track.live).toBe(true));
  });

  it('★★ 挂断 = 撤轨道停录音(不是静音);通话里按静音才是静音', async () => {
    const { link, channel } = wire();
    const track = trackMic(link);
    const client = createWbchCallClient({ channel });
    await client.start({}, recorder().events);
    await client.setMuted(true);
    expect(track.live).toBe(false);
    expect(link.micStops).toBe(0);
    await client.setMuted(false);
    await client.hangup();
    expect(track.live).toBe(false);
    expect(link.micStops).toBe(1);
  });

  it('★ 开麦之后接通流程半路抛了(意外):catch 那一支同样撤轨道、放房间', async () => {
    const { link, channel } = wire();
    const track = trackMic(link);
    const rec = recorder();
    // 界面那一层在「接通了」那一下抛了 —— 麦克风这时已经发布了。
    const events: CallEvents = { ...rec.events, onPhase: (phase, detail) => { rec.events.onPhase(phase, detail); if (phase === 'connected') throw new Error('界面抛了'); } };
    await createWbchCallClient({ channel }).start({}, events);
    expect(track.live).toBe(false);
    expect(link.micStops).toBeGreaterThan(0);
    expect(link.holders.has('call')).toBe(false);
  });

  it('★ 核对房间一直不回:最多等 recheckMs 就收场(以前屏幕停在「正在接通…」好几分钟),麦克风没开过', async () => {
    const link = createFakeLink();
    link.workerPresent = () => false;
    const channel = fakeChannel({
      link,
      acquireCall: async () => { await link.acquire('call', fakeCredential()); },
      releaseCall: async () => { await link.release('call'); },
      recheckRoom: () => new Promise<WbchRoomCheck>(() => {}),
    });
    const rec = recorder();
    const began = Date.now();
    await createWbchCallClient({ channel, workerWaitMs: 10, recheckMs: 40 }).start({}, rec.events);
    expect(Date.now() - began).toBeLessThan(2000);
    expect(rec.phases.map((p) => p.phase)).toEqual(['connecting', 'error']);
    expect(link.micLog).not.toContain(true);
    expect(link.holders.has('call')).toBe(false);
  });
});

/*
 * ——— 接通要有上限,卡在哪一步要说得出来(2026-09-25 返工)———
 *
 * 统筹 0.2.95 真机:小米点「通话」一直「正在接通…」一分多钟,工人一条开始通话的记录都没有,屏幕上也没有一句原因。
 * 那一版接通之前要先把麦克风发布出去,发布要协商 —— 网络慢时 livekit 自己的重试能拖一分多钟,招呼一直排在它后面。
 */
describe('★★ 接通有上限:进房 → 工人接起合起来 15 秒,麦克风挪到接通之后', () => {
  it('★★ 顺序:招呼那一条回了「好」才报接通,麦克风排在接通之后', async () => {
    const order: string[] = [];
    const { link, channel } = wire({ callStart: async () => { order.push('call.start'); return { ok: true }; } });
    const original = link.setMicrophoneEnabled.bind(link);
    link.setMicrophoneEnabled = async (on: boolean) => { order.push(`mic:${on}`); return original(on); };
    const rec = recorder();
    const events: CallEvents = { ...rec.events, onPhase: (phase, detail) => { order.push(phase); rec.events.onPhase(phase, detail); } };
    await createWbchCallClient({ channel }).start({}, events);
    expect(order).toEqual(['connecting', 'call.start', 'connected', 'mic:true']);
  });

  it('★★ 麦克风发布卡住(网络慢时 livekit 自己重试一分多钟):照样接通;到点说「麦克风没打开」,回来了也不开', async () => {
    const { link, channel } = wire();
    const track = trackMic(link);
    const release = track.holdPublish();
    const rec = recorder();
    const began = Date.now();
    await createWbchCallClient({ channel, micPublishMs: 40 }).start({}, rec.events);
    expect(Date.now() - began).toBeLessThan(2000);
    expect(rec.phases.map((p) => p.phase)).toEqual(['connecting', 'connected']);
    const said = rec.mic[rec.mic.length - 1];
    expect(said?.granted).toBe(false);
    expect(said?.text).toContain(MIC_PUBLISH_FAILED_TEXT);
    expect(said?.text).toContain(WBCH_MIC_PUBLISH_SLOW_TEXT);
    // 那一下迟迟回来了:屏幕上已经说了「没打开」,这一通就不开 —— 当场关掉。
    release();
    await vi.waitFor(() => expect(link.micLog[link.micLog.length - 1]).toBe(false));
    expect(track.live).toBe(false);
  });

  it('★★ 进房一直进不去:到点收场,说清卡在进房;麦克风没开过', async () => {
    const link = createFakeLink();
    const channel = fakeChannel({
      link,
      acquireCall: () => new Promise<void>(() => {}),
      releaseCall: async () => { await link.release('call'); },
    });
    const rec = recorder();
    const began = Date.now();
    await createWbchCallClient({ channel, connectMs: 40 }).start({}, rec.events);
    expect(Date.now() - began).toBeLessThan(2000);
    expect(rec.phases).toEqual([{ phase: 'connecting' }, { phase: 'error', error: WBCH_CONNECT_ROOM_TIMEOUT_TEXT }]);
    expect(link.micLog).not.toContain(true);
  });

  it('★★ 工人在房里却一直不接起(招呼没回话):到点收场,说清;补一句挂了;麦克风没开过', async () => {
    const hungUp: number[] = [];
    const { link, channel } = wire({
      callStart: () => new Promise<{ ok: true }>(() => {}),
      hangupCall: async () => { hungUp.push(1); return { ok: true }; },
    });
    const rec = recorder();
    const began = Date.now();
    await createWbchCallClient({ channel, connectMs: 40 }).start({}, rec.events);
    expect(Date.now() - began).toBeLessThan(2000);
    expect(rec.phases).toEqual([{ phase: 'connecting' }, { phase: 'error', error: WBCH_CONNECT_NO_ANSWER_TEXT }]);
    expect(link.micLog).not.toContain(true);
    expect(hungUp).toHaveLength(1);
    expect(link.holders.has('call')).toBe(false);
    expect(link.speakerLog).toEqual([true, false]);
  });

  it('★★ 引导那一条一直不回话:到点收场;补一句「引导停了」(晚到的话工人别一直留在引导里);麦克风没开过', async () => {
    const actions: string[] = [];
    const { link, channel } = wire({
      onboarding: (action) => { actions.push(action); return action === 'stop' ? Promise.resolve({ ok: true as const }) : new Promise<{ ok: true }>(() => {}); },
    });
    const rec = recorder();
    await createWbchCallClient({ channel, connectMs: 40 }).start({ onboarding: { resume: true } }, rec.events);
    expect(rec.phases).toEqual([{ phase: 'connecting' }, { phase: 'error', error: WBCH_CONNECT_NO_ANSWER_TEXT }]);
    expect(actions).toEqual(['resume', 'stop']);
    expect(link.micLog).not.toContain(true);
  });

  it('★ 三步共用一个期限:进房用掉的时间,等工人接起时就少等这么久', async () => {
    const link = createFakeLink();
    const channel = fakeChannel({
      link,
      acquireCall: async () => { await new Promise((resolve) => { setTimeout(resolve, 60); }); await link.acquire('call', fakeCredential()); },
      releaseCall: async () => { await link.release('call'); },
      callStart: () => new Promise<{ ok: true }>(() => {}),
    });
    const rec = recorder();
    const began = Date.now();
    await createWbchCallClient({ channel, connectMs: 100 }).start({}, rec.events);
    const took = Date.now() - began;
    expect(took).toBeGreaterThanOrEqual(90);
    expect(took).toBeLessThan(1000);
    expect(rec.phases[1]?.error).toBe(WBCH_CONNECT_NO_ANSWER_TEXT);
  });

  it('★ 问录音权限那一步不计时(要等人点系统弹框)', async () => {
    const { channel } = wire();
    const rec = recorder();
    const client = rawCallClient({
      ...NO_WARM,
      channel,
      connectMs: 40,
      trace: () => {},
      askMicPermission: async () => { await new Promise((resolve) => { setTimeout(resolve, 80); }); return MIC_GRANTED; },
    });
    await client.start({}, rec.events);
    expect(rec.phases.map((p) => p.phase)).toEqual(['connecting', 'connected']);
  });

  it('★ 进房抛了 livekit 的英文原话:说人话,原话放在括号里', async () => {
    const link = createFakeLink();
    const channel = fakeChannel({
      link,
      acquireCall: async () => { throw new Error('could not establish pc connection'); },
      releaseCall: async () => { await link.release('call'); },
    });
    const rec = recorder();
    await createWbchCallClient({ channel }).start({}, rec.events);
    expect(rec.phases[1]).toEqual({ phase: 'error', error: `${WBCH_CONNECT_ROOM_FAILED_TEXT}(could not establish pc connection)` });
  });

  it('★ 招呼那一条发不出去(英文原话):说人话;工人的中文原话照旧原样', async () => {
    const { channel } = wire({ callStart: async () => ({ ok: false, error: 'could not establish publisher connection, state: failed' }) });
    const rec = recorder();
    await createWbchCallClient({ channel }).start({}, rec.events);
    expect(rec.phases[1]?.error).toBe(`${WBCH_CONNECT_SEND_FAILED_TEXT}(could not establish publisher connection, state: failed)`);
    expect(humanized('电脑上的事务官现在接不了话(没有接话模型)', 'x')).toBe('电脑上的事务官现在接不了话(没有接话模型)');
    expect(humanized('', '兜底那句')).toBe('兜底那句');
  });

  it('★ 问录音权限那一问一直不回:到点当没有权限,电话照打,屏幕上说清楚;不开麦', async () => {
    const { link, channel } = wire();
    const rec = recorder();
    const client = rawCallClient({ ...NO_WARM, channel, trace: () => {}, micPermissionWaitMs: 40, askMicPermission: () => new Promise<MicPermissionResult>(() => {}) });
    const began = Date.now();
    await client.start({}, rec.events);
    expect(Date.now() - began).toBeLessThan(2000);
    expect(rec.phases.map((p) => p.phase)).toEqual(['connecting', 'connected']);
    expect(rec.mic[0]).toEqual({ granted: false, needsSettings: false, text: WBCH_MIC_PERMISSION_SLOW_TEXT });
    expect(link.micLog).not.toContain(true);
  });

  it('★ 每一步记一行:真机卡住时,调试口里看得见卡在哪一步', async () => {
    const lines: string[] = [];
    const { channel } = wire({ callStart: () => new Promise<{ ok: true }>(() => {}) });
    await createWbchCallClient({ channel, connectMs: 30, trace: (line) => lines.push(line) }).start({}, recorder().events);
    /*
     * 「这边真的在出声了(…),告诉工人」(2026-09-28,卡 CF 第 4 条)那一行**报几次不定**
     * (烘热成了报一次;她真的出声了那一路另算),不该钉在这串顺序里 —— 钉了就是钉一个巧合。
     *
     * 「烘热通话输出」与它下面那句结论**是钉死的**(2026-09-28,卡 OP):烘热排在
     * 「等电脑上的事务官 / 请事务官接起」**之前** —— 输出没热就请她开口,第一个字必被吃。
     * 这一条用例里没有真的输出可判(NO_WARM),所以那句结论是「判不出来」。
     */
    const steps = lines.map((line) => line.replace(/^\+\d+ms /, '')).filter((one) => !one.startsWith('这边真的在出声了'));
    expect(steps.slice(0, 7)).toEqual([
      '点了通话', '问录音权限', '进房', '开喇叭',
      '烘热通话输出', '这台机器判不出输出热没热,照旧往下打',
      '等电脑上的事务官',
    ]);
    expect(steps[7]).toBe('请事务官接起');
    expect(steps[steps.length - 1]).toBe(`接不通:${WBCH_CONNECT_NO_ANSWER_TEXT}`);
    for (const line of lines) expect(line).toMatch(/^\+\d+ms /);
  });
});
