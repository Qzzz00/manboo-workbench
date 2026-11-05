/**
 * 通话模式的手机侧(2026-09-17,交接-0917-手机通话模式):
 *
 * 1. **接口打在哪**:rtc 四条经 /butler/proxy/api/*;通话纪要直接打工作台的 /butler/call/record
 *    (只有工作台认识事项)。start **不带 systemMessage**——人设由工作台在代理层注入,手机连碰都不碰。
 * 2. **没配与掉线是两件事**:前者要 Ben 去 Mac 上配密钥,后者过会儿还能打。界面上说的话不一样。
 * 3. **通话客户端**:token → 进房 → 采集 → 发布 → start 的顺序不能变(顺序理由见 src/call/rtcCall.ts 头注释);
 *    任一步失败都要以 error 收场,而不是停在「接通中」让人干等。
 * 4. **挂电话必须挂得掉**:stop 请求失败、引擎抛错,照样离房、照样把时长与字幕交出来。
 */
import { describe, expect, it, vi } from 'vitest';
import { createApiClient } from '../src/api/client';
import { createCallApi } from '../src/api/call';
import {
  appendUtterance,
  callDurationSeconds,
  callStageMode,
  callStatusText,
  formatCallElapsed,
} from '../src/call/callModel';
import { createCallClient, decodeAigcMessage, type VolcRtcModule } from '../src/call/rtcCall';

const pairing = { token: 't', host: 'h', port: 8791, deviceId: 'd' };
function client(fetchImpl: typeof fetch) {
  return createApiClient({ pairing, fetchImpl, onUnauthorized: () => {} });
}

/** 把一段 JSON 封成火山的房间二进制消息(4 字节 magic + 4 字节大端长度 + UTF-8 JSON)。 */
function frame(json: unknown, magic = 'subv'): ArrayBuffer {
  const body = new TextEncoder().encode(JSON.stringify(json));
  const buffer = new ArrayBuffer(8 + body.byteLength);
  const view = new DataView(buffer);
  for (let i = 0; i < 4; i += 1) view.setUint8(i, magic.charCodeAt(i));
  view.setUint32(4, body.byteLength);
  new Uint8Array(buffer, 8).set(body);
  return buffer;
}

interface FakeEngine {
  handlers: Map<string, (payload: unknown) => void>;
  calls: string[];
  emit(event: string, payload: unknown): void;
}

function fakeSdk(options: { failAt?: string } = {}): { module: VolcRtcModule, engine: FakeEngine } {
  const handlers = new Map<string, (payload: unknown) => void>();
  const calls: string[] = [];
  const step = async (name: string) => {
    calls.push(name);
    if (options.failAt === name) throw new Error(`${name} 炸了`);
  };
  const engine = {
    handlers,
    calls,
    emit(event: string, payload: unknown) { handlers.get(event)?.(payload); },
    on(event: string, handler: (payload: unknown) => void) { handlers.set(event, handler); },
    joinRoom: async () => step('joinRoom'),
    startAudioCapture: async () => step('startAudioCapture'),
    stopAudioCapture: async () => step('stopAudioCapture'),
    publishStream: async () => step('publishStream'),
    enableAudioPropertiesReport: () => calls.push('enableAudioPropertiesReport'),
    leaveRoom: async () => step('leaveRoom'),
    play: async () => step('play'),
  };
  return {
    engine: engine as unknown as FakeEngine,
    module: {
      createEngine: () => { calls.push('createEngine'); return engine; },
      destroyEngine: () => { calls.push('destroyEngine'); },
    },
  };
}

/** 一个按路径分发的 fetch 桩,并记下每条请求。 */
function stubFetch(routes: Record<string, () => Response>) {
  const seen: { url: string, body: unknown }[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    seen.push({ url, body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) as unknown });
    const key = Object.keys(routes).find(path => url.endsWith(path));
    if (key === undefined) return new Response(JSON.stringify({ error: `没有这条路 ${url}` }), { status: 404 });
    return routes[key]!();
  }) as unknown as typeof fetch;
  return { impl, seen };
}

const OK_ROUTES = {
  '/rtc/token': () => new Response(JSON.stringify({ appId: 'app', roomId: 'room_1', userId: 'user_1', token: 'tk' }), { status: 200 }),
  '/rtc/start': () => new Response(JSON.stringify({ taskId: 'task_1', botUserId: 'bot_1' }), { status: 200 }),
  '/rtc/stop': () => new Response(JSON.stringify({ stopped: true, durationSeconds: 12 }), { status: 200 }),
  '/butler/call/record': () => new Response(JSON.stringify({ ok: true, id: 't-9' }), { status: 200 }),
};

describe('通话接口打在哪', () => {
  it('rtc 四条走 /butler/proxy/api/rtc/*,通话纪要直接打工作台', async () => {
    const { impl, seen } = stubFetch({
      ...OK_ROUTES,
      '/rtc/status': () => new Response(JSON.stringify({ configured: true }), { status: 200 }),
    });
    const api = createCallApi(client(impl));
    await api.status();
    await api.token();
    await api.start({ roomId: 'room_1', userId: 'user_1', avatarId: 'ava-1' });
    await api.stop({ roomId: 'room_1', taskId: 'task_1' });
    await api.record({ durationSeconds: 12, transcript: [{ who: 'me', text: '喂' }] });
    expect(seen.map(s => s.url)).toEqual([
      'http://h:8791/butler/proxy/api/rtc/status',
      'http://h:8791/butler/proxy/api/rtc/token',
      'http://h:8791/butler/proxy/api/rtc/start',
      'http://h:8791/butler/proxy/api/rtc/stop',
      'http://h:8791/butler/call/record',
    ]);
  });

  it('start 只带 roomId/userId/avatarId:人设不经手机的手', async () => {
    const { impl, seen } = stubFetch(OK_ROUTES);
    await createCallApi(client(impl)).start({ roomId: 'room_1', userId: 'user_1', avatarId: 'ava-1' });
    expect(seen[0]!.body).toEqual({ roomId: 'room_1', userId: 'user_1', avatarId: 'ava-1' });
  });

  it('没配(503)→ checked:true;掉线 → checked:false。两种要说不一样的话', async () => {
    const off = stubFetch({ '/rtc/status': () => new Response(JSON.stringify({ configured: false, reason: '未配置语音供应商密钥' }), { status: 200 }) });
    expect(await createCallApi(client(off.impl)).status()).toEqual({
      configured: false, checked: true, reason: '未配置语音供应商密钥',
    });

    const down = stubFetch({ '/rtc/status': () => { throw new Error('断网'); } });
    const result = await createCallApi(client(down.impl)).status();
    expect(result.configured).toBe(false);
    expect(result.checked).toBe(false);
  });
});

describe('通话里的那几个小函数', () => {
  it('时长:分秒补零,过一小时才有小时', () => {
    expect(formatCallElapsed(0)).toBe('00:00');
    expect(formatCallElapsed(5_000)).toBe('00:05');
    expect(formatCallElapsed(185_000)).toBe('03:05');
    expect(formatCallElapsed(3_725_000)).toBe('1:02:05');
    expect(formatCallElapsed(-1)).toBe('00:00');
  });

  it('字幕:空白不收,紧挨着的同一句不重复收', () => {
    let list = appendUtterance([], { who: 'me', text: ' 喂 ' });
    list = appendUtterance(list, { who: 'me', text: '喂' });
    list = appendUtterance(list, { who: 'butler', text: '  ' });
    list = appendUtterance(list, { who: 'butler', text: '在呢' });
    list = appendUtterance(list, { who: 'me', text: '喂' });
    expect(list).toEqual([
      { who: 'me', text: '喂' },
      { who: 'butler', text: '在呢' },
      { who: 'me', text: '喂' },
    ]);
  });

  it('球的形态:接通中=在办,她说=说话,你说=聆听,都不说=待命', () => {
    expect(callStageMode({ phase: 'connecting', botSpeaking: false, micSpeaking: false })).toBe('working');
    expect(callStageMode({ phase: 'connected', botSpeaking: true, micSpeaking: true })).toBe('speaking');
    expect(callStageMode({ phase: 'connected', botSpeaking: false, micSpeaking: true })).toBe('listening');
    expect(callStageMode({ phase: 'connected', botSpeaking: false, micSpeaking: false })).toBe('idle');
    expect(callStageMode({ phase: 'error', botSpeaking: true, micSpeaking: true })).toBe('idle');
  });

  it('出错时屏幕上说的是服务端那句原话', () => {
    expect(callStatusText('error', '未配置语音供应商密钥')).toBe('未配置语音供应商密钥');
    expect(callStatusText('error')).toBe('通话没接通');
    expect(callStatusText('connected')).toBe('通话中');
  });

  it('时长算不出就不给数(不编)', () => {
    expect(callDurationSeconds(1000, 4000)).toBe(3);
    expect(callDurationSeconds(undefined, 4000)).toBeUndefined();
    expect(callDurationSeconds(9000, 4000)).toBeUndefined();
  });

  it('房间二进制消息解不出来就当没有,不抛', () => {
    expect(decodeAigcMessage(frame({ a: 1 }))).toEqual({ a: 1 });
    expect(decodeAigcMessage(undefined)).toBeUndefined();
    expect(decodeAigcMessage(new ArrayBuffer(0))).toBeUndefined();
    expect(decodeAigcMessage(new TextEncoder().encode('不是 JSON').buffer as ArrayBuffer)).toBeUndefined();
  });
});

describe('通话客户端', () => {
  function events() {
    const phases: string[] = [];
    const utterances: { who: string, text: string }[] = [];
    const bot: boolean[] = [];
    const mic: boolean[] = [];
    let lastError: string | undefined;
    return {
      phases, utterances, bot, mic,
      error: () => lastError,
      handlers: {
        onPhase: (phase: string, detail?: { error?: string }) => { phases.push(phase); if (detail?.error !== undefined) lastError = detail.error; },
        onUtterance: (entry: { who: string, text: string }) => utterances.push(entry),
        onBotSpeaking: (speaking: boolean) => bot.push(speaking),
        onMicSpeaking: (speaking: boolean) => mic.push(speaking),
      },
    };
  }

  it('顺序是 token → 进房 → 采集 → 发布 → start,接通后报 connected', async () => {
    const { impl, seen } = stubFetch(OK_ROUTES);
    const sdk = fakeSdk();
    const call = createCallClient({ api: createCallApi(client(impl)), loadSdk: async () => sdk.module });
    const ev = events();
    await call.start({ avatarId: 'ava-1' }, ev.handlers as never);
    expect(ev.phases).toEqual(['connecting', 'connected']);
    expect(sdk.engine.calls.filter(c => c !== 'enableAudioPropertiesReport')).toEqual([
      'createEngine', 'joinRoom', 'startAudioCapture', 'publishStream',
    ]);
    // /rtc/start 在发布之后才打(智能体进房时上行音频必须已经在房间里)。
    expect(seen.map(s => s.url.split('/').pop())).toEqual(['token', 'start']);
  });

  it('token 拿不到 → error,引擎根本没建', async () => {
    const { impl } = stubFetch({ '/rtc/token': () => new Response(JSON.stringify({ error: '未配置语音供应商密钥' }), { status: 503 }) });
    const sdk = fakeSdk();
    const call = createCallClient({ api: createCallApi(client(impl)), loadSdk: async () => sdk.module });
    const ev = events();
    await call.start({}, ev.handlers as never);
    expect(ev.phases).toEqual(['connecting', 'error']);
    expect(ev.error()).toBe('未配置语音供应商密钥');
    expect(sdk.engine.calls).toEqual([]);
  });

  it('进房抛错 → error,不会停在「接通中」', async () => {
    const { impl } = stubFetch(OK_ROUTES);
    const sdk = fakeSdk({ failAt: 'joinRoom' });
    const call = createCallClient({ api: createCallApi(client(impl)), loadSdk: async () => sdk.module });
    const ev = events();
    await call.start({}, ev.handlers as never);
    expect(ev.phases).toEqual(['connecting', 'error']);
    expect(ev.error()).toContain('joinRoom');
  });

  it('定稿字幕按说话人分到我/事务官;非定稿不收', async () => {
    const { impl } = stubFetch(OK_ROUTES);
    const sdk = fakeSdk();
    const call = createCallClient({ api: createCallApi(client(impl)), loadSdk: async () => sdk.module });
    const ev = events();
    await call.start({}, ev.handlers as never);
    sdk.engine.emit('onRoomBinaryMessageReceived', { message: frame({ data: [{ userId: 'user_1', text: '周五交报销', definite: true }] }) });
    sdk.engine.emit('onRoomBinaryMessageReceived', { message: frame({ data: [{ userId: 'bot_1', text: '记下', definite: false }] }) });
    sdk.engine.emit('onRoomBinaryMessageReceived', { message: frame({ data: [{ userId: 'bot_1', text: '记下了。', definite: true }] }) });
    expect(ev.utterances).toEqual([
      { who: 'me', text: '周五交报销' },
      { who: 'butler', text: '记下了。' },
    ]);
  });

  it('她出声/停下靠云端状态机(answering=3 / 被打断=4 / 答完=5),不靠音频分析', async () => {
    const { impl } = stubFetch(OK_ROUTES);
    const sdk = fakeSdk();
    const call = createCallClient({ api: createCallApi(client(impl)), loadSdk: async () => sdk.module });
    const ev = events();
    await call.start({}, ev.handlers as never);
    sdk.engine.emit('onRoomBinaryMessageReceived', { message: frame({ RoundID: 1, Stage: { Code: 3 } }, 'conv') });
    sdk.engine.emit('onRoomBinaryMessageReceived', { message: frame({ RoundID: 1, Stage: { Code: 4 } }, 'conv') });
    sdk.engine.emit('onRoomBinaryMessageReceived', { message: frame({ RoundID: 2, Stage: { Code: 3 } }, 'conv') });
    sdk.engine.emit('onRoomBinaryMessageReceived', { message: frame({ RoundID: 2, Stage: { Code: 5 } }, 'conv') });
    expect(ev.bot).toEqual([true, false, true, false]);
  });

  it('本地音量过阈值 → 你在说话', async () => {
    const { impl } = stubFetch(OK_ROUTES);
    const sdk = fakeSdk();
    const call = createCallClient({ api: createCallApi(client(impl)), loadSdk: async () => sdk.module });
    const ev = events();
    await call.start({}, ev.handlers as never);
    sdk.engine.emit('onLocalAudioPropertiesReport', [{ audioPropertiesInfo: { linearVolume: 2 } }]);
    expect(ev.mic).toEqual([]);
    sdk.engine.emit('onLocalAudioPropertiesReport', [{ audioPropertiesInfo: { linearVolume: 25 } }]);
    expect(ev.mic).toEqual([true]);
    await call.hangup();
  });

  it('挂断:先 stop 再离房销毁,交回时长与字幕', async () => {
    const { impl, seen } = stubFetch(OK_ROUTES);
    const sdk = fakeSdk();
    let clock = 1_000;
    const call = createCallClient({ api: createCallApi(client(impl)), loadSdk: async () => sdk.module, now: () => clock });
    const ev = events();
    await call.start({}, ev.handlers as never);
    sdk.engine.emit('onRoomBinaryMessageReceived', { message: frame({ data: [{ userId: 'bot_1', text: '在呢', definite: true }] }) });
    clock += 185_000;
    const result = await call.hangup();
    expect(result.durationSeconds).toBe(185);
    expect(result.transcript).toEqual([{ who: 'butler', text: '在呢' }]);
    expect(seen.map(s => s.url.split('/').pop())).toEqual(['token', 'start', 'stop']);
    expect(sdk.engine.calls.slice(-3)).toEqual(['stopAudioCapture', 'leaveRoom', 'destroyEngine']);
  });

  it('stop 请求失败、离房也抛 → 照样挂得掉,并交回字幕', async () => {
    const { impl } = stubFetch({
      ...OK_ROUTES,
      '/rtc/stop': () => new Response(JSON.stringify({ error: '火山不理我们' }), { status: 502 }),
    });
    const sdk = fakeSdk({ failAt: 'leaveRoom' });
    const call = createCallClient({ api: createCallApi(client(impl)), loadSdk: async () => sdk.module });
    const ev = events();
    await call.start({}, ev.handlers as never);
    await expect(call.hangup()).resolves.toMatchObject({ transcript: [] });
  });

  it('静音 = 停采集,取消静音 = 重新采集', async () => {
    const { impl } = stubFetch(OK_ROUTES);
    const sdk = fakeSdk();
    const call = createCallClient({ api: createCallApi(client(impl)), loadSdk: async () => sdk.module });
    await call.start({}, events().handlers as never);
    const before = sdk.engine.calls.length;
    await call.setMuted(true);
    await call.setMuted(false);
    expect(sdk.engine.calls.slice(before)).toEqual(['stopAudioCapture', 'startAudioCapture']);
  });

  /*
   * ——— 静音以他的意愿为准(2026-09-24,卡 fix/call-mute-before-publish)———
   * 与 LiveKit 那一版同一个毛病、同一条规矩:接通过程中按的「关掉麦克风」,轮到采集那一步照它来。
   * 以前拿 token / 加载 SDK 那几秒按的直接不管,进房那一下按的被随后的「开采集」盖掉。
   */
  function gated<T>() {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    return { open: () => open(), wrap: (inner: () => Promise<T>) => async () => { await gate; return inner(); } };
  }

  it('★ 拿 token 那几秒里按了静音:接通照常,但不开采集;取消静音才开', async () => {
    const { impl } = stubFetch(OK_ROUTES);
    const sdk = fakeSdk();
    const api = createCallApi(client(impl));
    const token = gated<Awaited<ReturnType<typeof api.token>>>();
    const call = createCallClient({ api: { ...api, token: token.wrap(() => api.token()) }, loadSdk: async () => sdk.module });
    const ev = events();
    const started = call.start({}, ev.handlers as never);
    await call.setMuted(true);
    token.open();
    await started;
    expect(ev.phases).toEqual(['connecting', 'connected']);
    expect(sdk.engine.calls).not.toContain('startAudioCapture');
    await call.setMuted(false);
    expect(sdk.engine.calls.filter(c => c === 'startAudioCapture')).toHaveLength(1);
  });

  it('★ 进房那一下里按了静音:照样不开采集(以前被随后的「开采集」盖掉)', async () => {
    const { impl } = stubFetch(OK_ROUTES);
    const sdk = fakeSdk();
    const joined = gated<void>();
    const engine = sdk.engine as unknown as { joinRoom: () => Promise<void> };
    const original = engine.joinRoom;
    engine.joinRoom = joined.wrap(() => original());
    const call = createCallClient({ api: createCallApi(client(impl)), loadSdk: async () => sdk.module });
    const ev = events();
    const started = call.start({}, ev.handlers as never);
    await vi.waitFor(() => expect(sdk.engine.calls).toContain('createEngine'));
    await call.setMuted(true);
    joined.open();
    await started;
    expect(ev.phases).toEqual(['connecting', 'connected']);
    expect(sdk.engine.calls).not.toContain('startAudioCapture');
  });

  it('★ 拿 token 那几秒里挂断:引擎都不建,更不开采集', async () => {
    const { impl } = stubFetch(OK_ROUTES);
    const sdk = fakeSdk();
    const api = createCallApi(client(impl));
    const token = gated<Awaited<ReturnType<typeof api.token>>>();
    const call = createCallClient({ api: { ...api, token: token.wrap(() => api.token()) }, loadSdk: async () => sdk.module });
    const started = call.start({}, events().handlers as never);
    await call.hangup();
    token.open();
    await started;
    expect(sdk.engine.calls).toEqual([]);
  });

  it('SDK 加载不出来(WebView 太老)→ error,不是白屏', async () => {
    const { impl } = stubFetch(OK_ROUTES);
    const call = createCallClient({
      api: createCallApi(client(impl)),
      loadSdk: async () => { throw new Error('加载不了通话组件'); },
    });
    const ev = events();
    await call.start({}, ev.handlers as never);
    expect(ev.phases).toEqual(['connecting', 'error']);
    expect(ev.error()).toBe('加载不了通话组件');
  });

  it('远端发布音频 → 显式播放(WebView 不会自己播)', async () => {
    const { impl } = stubFetch(OK_ROUTES);
    const sdk = fakeSdk();
    const call = createCallClient({ api: createCallApi(client(impl)), loadSdk: async () => sdk.module });
    await call.start({}, events().handlers as never);
    const play = vi.spyOn(sdk.engine as unknown as { play: () => Promise<void> }, 'play');
    sdk.engine.emit('onUserPublishStream', { userId: 'bot_1', mediaType: 1 });
    expect(play).toHaveBeenCalled();
  });
});
