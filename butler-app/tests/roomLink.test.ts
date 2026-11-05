import { describe, expect, it, vi } from 'vitest';
import { createWbchRoomLink, type WbchLivekitSdk } from '../src/channel/roomLink';
import { WBCH_FILE_TOPIC, WBCH_LEGACY_FILE_TOPIC, WBCH_WORKER_IDENTITY } from '../src/channel/channelProtocol';
import { fakeCredential } from './wbchFakes';

/* eslint-disable @typescript-eslint/no-explicit-any */

const EVENTS = {
  DataReceived: 'dataReceived',
  TrackSubscribed: 'trackSubscribed',
  TrackUnsubscribed: 'trackUnsubscribed',
  ActiveSpeakersChanged: 'activeSpeakersChanged',
  ParticipantConnected: 'participantConnected',
  ParticipantDisconnected: 'participantDisconnected',
  Disconnected: 'disconnected',
  Reconnecting: 'reconnecting',
  Reconnected: 'reconnected',
};

function fakeSdk() {
  const rooms: any[] = [];
  let connectError: string | null = null;
  class FakeRoom {
    handlers = new Map<string, ((...args: any[]) => void)[]>();
    byteHandlers = new Map<string, (reader: any, info: any) => void>();
    textHandlers = new Map<string, (reader: any, info: any) => void>();
    remoteParticipants = new Map<string, unknown>();
    connected: string[] = [];
    disconnects = 0;
    published: { text: string; topic: string }[] = [];
    files: { name: string; topic: string; mimeType?: string }[] = [];
    mic: boolean[] = [];
    localParticipant = {
      identity: 'wb-phone-dev1',
      sendText: async (text: string, options: { topic: string }) => { this.published.push({ text, topic: options.topic }); },
      sendFile: async (_file: File, options: { topic: string; name: string; mimeType?: string }) => {
        this.files.push({ name: options.name, topic: options.topic, ...(options.mimeType === undefined ? {} : { mimeType: options.mimeType }) });
      },
      setMicrophoneEnabled: async (on: boolean) => { this.mic.push(on); },
    };
    constructor() { rooms.push(this); }
    on(event: string, handler: (...args: any[]) => void) {
      const list = this.handlers.get(event) ?? [];
      list.push(handler);
      this.handlers.set(event, list);
      return this;
    }
    registerByteStreamHandler(topic: string, handler: (reader: any, info: any) => void) {
      if (this.byteHandlers.has(topic)) throw new Error('重复注册');
      this.byteHandlers.set(topic, handler);
    }
    registerTextStreamHandler(topic: string, handler: (reader: any, info: any) => void) {
      if (this.textHandlers.has(topic)) throw new Error('重复注册');
      this.textHandlers.set(topic, handler);
    }
    async connect(url: string, token: string) {
      if (connectError !== null) throw new Error(connectError);
      this.connected.push(`${url}|${token}`);
    }
    async disconnect() { this.disconnects += 1; }
    fire(event: string, ...args: any[]) { for (const h of this.handlers.get(event) ?? []) h(...args); }
  }
  const sdk: WbchLivekitSdk = { Room: FakeRoom as never, RoomEvent: EVENTS };
  return {
    sdk,
    rooms,
    failConnect(message: string) { connectError = message; },
    allowConnect() { connectError = null; },
  };
}

/** 一个够用的假 `<audio>`:`muted` 是这几条用例真正要看的那一格。 */
function fakeAudio(): HTMLMediaElement & { muted: boolean } {
  return { tag: 'audio', muted: false, play: async () => {}, pause: () => {} } as unknown as HTMLMediaElement & { muted: boolean };
}

function link(deps: ReturnType<typeof fakeSdk>) {
  const attached: HTMLMediaElement[] = [];
  const detached: HTMLMediaElement[] = [];
  return {
    attached,
    detached,
    value: createWbchRoomLink({
      loadSdk: async () => deps.sdk,
      attachAudio: (e) => { attached.push(e); },
      detachAudio: (e) => { detached.push(e); },
    }),
  };
}

describe('房间连接:谁持有它', () => {
  it('第一个持有者进房;凭证里的地址与 token 原样交给 SDK', async () => {
    const sdk = fakeSdk();
    const { value } = link(sdk);
    await value.acquire('rpc', fakeCredential({ url: 'wss://lk.test', token: 'jwt-7' }));
    expect(sdk.rooms).toHaveLength(1);
    expect(sdk.rooms[0].connected).toEqual(['wss://lk.test|jwt-7']);
    expect(value.state()).toBe('connected');
  });

  it('第二个持有者不再开一间房', async () => {
    const sdk = fakeSdk();
    const { value } = link(sdk);
    await value.acquire('rpc', fakeCredential());
    await value.acquire('call', fakeCredential());
    expect(sdk.rooms).toHaveLength(1);
  });

  // Ben 的口径是「挂断 = 离房」。局域网里挂断时只有通话持有它 → 真的离房;
  // 出了局域网,RPC 还持有着 → 房间留着,不然挂断电话等于把手机变砖。
  it('还有人持有就不离房,最后一个放手才离', async () => {
    const sdk = fakeSdk();
    const { value } = link(sdk);
    await value.acquire('rpc', fakeCredential());
    await value.acquire('call', fakeCredential());
    await value.release('call');
    expect(sdk.rooms[0].disconnects).toBe(0);
    expect(value.state()).toBe('connected');
    await value.release('rpc');
    expect(sdk.rooms[0].disconnects).toBe(1);
    expect(value.state()).toBe('closed');
  });

  it('连不上就抛,而且不算他持有过(否则下一次 release 会拆掉一间没连上的房)', async () => {
    const sdk = fakeSdk();
    sdk.failConnect('服务器不理人');
    const { value } = link(sdk);
    await expect(value.acquire('call', fakeCredential())).rejects.toThrow('服务器不理人');
    expect(value.state()).toBe('failed');
    sdk.allowConnect();
    await value.acquire('rpc', fakeCredential());
    await value.release('rpc');
    expect(sdk.rooms[1].disconnects).toBe(1);
  });

  it('没进房就发消息 / 开麦克风,一律抛', async () => {
    const sdk = fakeSdk();
    const { value } = link(sdk);
    await expect(value.sendText('{}', 'wb.rpc')).rejects.toThrow('还没进房');
    await expect(value.setMicrophoneEnabled(true)).rejects.toThrow('还没进房');
  });
});

describe('房间里收发', () => {
  // 走文本流不是数据包:publishData 单包 15KB 封顶,/state 一份快照装不下(与 Mac 侧对齐)。
  it('发的是文本流,带 topic;收的时候把发送人的身份一起交出来', async () => {
    const sdk = fakeSdk();
    const { value } = link(sdk);
    await value.acquire('rpc', fakeCredential());
    await value.sendText('{"id":"a1"}', 'wb.rpc');
    expect(sdk.rooms[0].published[0]).toEqual({ text: '{"id":"a1"}', topic: 'wb.rpc' });
    expect(sdk.rooms[0].localParticipant).not.toHaveProperty('publishData');

    const seen: { text: string; from: string | undefined }[] = [];
    value.listen({ onText: (text, from) => seen.push({ text, from }) });
    const handler = sdk.rooms[0].textHandlers.get('wb.rpc')!;
    handler({ readAll: async () => '{"type":"caption"}' }, { identity: WBCH_WORKER_IDENTITY });
    await vi.waitFor(() => expect(seen).toEqual([{ text: '{"type":"caption"}', from: WBCH_WORKER_IDENTITY }]));
  });

  it('发文件走协议定的 wb.file,名字显式给(不给两端会拿到 unknown)', async () => {
    const sdk = fakeSdk();
    const { value } = link(sdk);
    await value.acquire('call', fakeCredential());
    await value.sendFile(new File(['一二三'], '给事务官.txt', { type: 'text/plain' }), WBCH_FILE_TOPIC);
    expect(sdk.rooms[0].files[0]).toEqual({ name: '给事务官.txt', topic: 'wb.file', mimeType: 'text/plain' });
  });

  // 2026-09-25(卡 S):出了局域网「按住说话」的录音走 sendBytes —— livekit-client 2.22 的 sendFile 不带流上的属性,
  // 而工人靠属性里的编号把录音和那条 `{type:'asr'}` 对上。
  it('发一段字节:带属性、只发那一台、不压缩;没进房就抛', async () => {
    const sdk = fakeSdk();
    const { value } = link(sdk);
    await expect(value.sendBytes!(new Uint8Array([1]), 'wb.asr', WBCH_WORKER_IDENTITY)).rejects.toThrow('还没进房');
    await value.acquire('rpc', fakeCredential());
    const calls: { bytes: Uint8Array; options: Record<string, unknown> }[] = [];
    sdk.rooms[0].localParticipant.sendBytes = async (bytes: Uint8Array, options: Record<string, unknown>) => { calls.push({ bytes, options }); };
    await value.sendBytes!(new Uint8Array([82, 73, 70, 70]), 'wb.asr', WBCH_WORKER_IDENTITY, { name: 'asr.wav', mimeType: 'audio/wav', attributes: { wb_asr_id: 'a1' }, compress: false });
    expect(calls).toEqual([{
      bytes: new Uint8Array([82, 73, 70, 70]),
      options: { topic: 'wb.asr', destinationIdentities: [WBCH_WORKER_IDENTITY], name: 'asr.wav', mimeType: 'audio/wav', attributes: { wb_asr_id: 'a1' }, compress: false },
    }]);
  });

  it('收文件两个 topic 都挂着(协议 wb.file 与原型工人的 wb-file)', async () => {
    const sdk = fakeSdk();
    const { value } = link(sdk);
    await value.acquire('call', fakeCredential());
    expect([...sdk.rooms[0].byteHandlers.keys()]).toEqual([WBCH_FILE_TOPIC, WBCH_LEGACY_FILE_TOPIC]);
  });

  it('收到的分片拼回一个完整文件', async () => {
    const sdk = fakeSdk();
    const { value } = link(sdk);
    await value.acquire('call', fakeCredential());
    const got: { name: string; text: string; from: string }[] = [];
    value.listen({ onFile: (f) => got.push({ name: f.name, text: new TextDecoder().decode(f.bytes), from: f.from }) });
    const handler = sdk.rooms[0].byteHandlers.get(WBCH_LEGACY_FILE_TOPIC)!;
    handler(
      {
        info: { name: '电脑发来的.txt', mimeType: 'text/plain' },
        readAll: async () => [new TextEncoder().encode('前半'), new TextEncoder().encode('后半')],
      },
      { identity: WBCH_WORKER_IDENTITY },
    );
    await vi.waitFor(() => expect(got).toHaveLength(1));
    expect(got[0]).toEqual({ name: '电脑发来的.txt', text: '前半后半', from: WBCH_WORKER_IDENTITY });
  });

  it('一个文件收坏了不会把房间带走', async () => {
    const sdk = fakeSdk();
    const { value } = link(sdk);
    await value.acquire('call', fakeCredential());
    const handler = sdk.rooms[0].byteHandlers.get(WBCH_FILE_TOPIC)!;
    expect(() => handler({ info: {}, readAll: async () => { throw new Error('断了'); } }, { identity: 'x' })).not.toThrow();
    expect(value.state()).toBe('connected');
  });
});

describe('房间里的动静', () => {
  it('工人进房 / 离房都说一声', async () => {
    const sdk = fakeSdk();
    const { value } = link(sdk);
    await value.acquire('rpc', fakeCredential());
    expect(value.workerPresent()).toBe(false);
    const seen: boolean[] = [];
    value.listen({ onWorker: (p) => seen.push(p) });
    sdk.rooms[0].remoteParticipants.set(WBCH_WORKER_IDENTITY, {});
    sdk.rooms[0].fire('participantConnected');
    expect(seen).toEqual([true]);
    expect(value.workerPresent()).toBe(true);
    sdk.rooms[0].remoteParticipants.delete(WBCH_WORKER_IDENTITY);
    sdk.rooms[0].fire('participantDisconnected');
    expect(seen).toEqual([true, false]);
  });

  it('谁在出声:工人 = 她在说,自己 = 你在说', async () => {
    const sdk = fakeSdk();
    const { value } = link(sdk);
    await value.acquire('call', fakeCredential());
    const bot: boolean[] = [];
    const me: boolean[] = [];
    value.listen({ onRemoteSpeaking: (s) => bot.push(s), onLocalSpeaking: (s) => me.push(s) });
    sdk.rooms[0].fire('activeSpeakersChanged', [{ identity: WBCH_WORKER_IDENTITY }]);
    sdk.rooms[0].fire('activeSpeakersChanged', [{ identity: 'wb-phone-dev1' }]);
    expect(bot).toEqual([true, false]);
    expect(me).toEqual([false, true]);
  });

  it('订到音频轨就挂出来播;退订就摘掉', async () => {
    const sdk = fakeSdk();
    const l = link(sdk);
    await l.value.acquire('call', fakeCredential());
    const element = fakeAudio();
    sdk.rooms[0].fire('trackSubscribed', { kind: 'audio', attach: () => element });
    expect(l.attached).toEqual([element]);
    sdk.rooms[0].fire('trackUnsubscribed', { detach: () => [element] });
    expect(l.detached).toEqual([element]);
  });

  /*
   * ——— 喇叭那个开关(2026-09-22 晚,Ben:「响铃应该是手机发出,而不是话筒,
   * 话筒自己是用来对话的」) ———
   *
   * 从今天起手机**常驻房间**(不常驻收不到 ring),于是「在房里」不再等于「在通话里」。
   * 远端音轨照旧挂上来(字幕那条链要它),但**缺省是静音的** —— 他拿起听筒说话,
   * 她的回答不许从桌上那台手机里出来。
   */
  it('★ 缺省静音:常驻房间时订到她的音轨也不出声', async () => {
    const sdk = fakeSdk();
    const l = link(sdk);
    await l.value.acquire('ring', fakeCredential());
    const element = fakeAudio();
    sdk.rooms[0].fire('trackSubscribed', { kind: 'audio', attach: () => element });
    expect(element.muted).toBe(true);
  });

  it('★ 打开喇叭才出声;关掉又静音(她可能正说到一半,所以是同步的)', async () => {
    const sdk = fakeSdk();
    const l = link(sdk);
    await l.value.acquire('call', fakeCredential());
    const element = fakeAudio();
    sdk.rooms[0].fire('trackSubscribed', { kind: 'audio', attach: () => element });
    l.value.setSpeakerEnabled(true);
    expect(element.muted).toBe(false);
    l.value.setSpeakerEnabled(false);
    expect(element.muted).toBe(true);
  });

  it('★ 先开喇叭、音轨后到,那一路照样出声(她先开口、手机才接通)', async () => {
    const sdk = fakeSdk();
    const l = link(sdk);
    await l.value.acquire('call', fakeCredential());
    l.value.setSpeakerEnabled(true);
    const element = fakeAudio();
    sdk.rooms[0].fire('trackSubscribed', { kind: 'audio', attach: () => element });
    expect(element.muted).toBe(false);
  });

  /*
   * ——— 起播那一下(2026-09-27,卡 CL)———
   *
   * 维护者 21:3x 手机打过去:「一上来就听到『吩咐』两个字,『吩』字还是尾巴。」
   * 常驻房间时这个 `<audio>` 是暂停+静音的,接通才 `play()` —— 从 `play()` 到真出声
   * 要几百毫秒,那半秒的帧就丢了。所以通话那一层要能等这一下。
   */
  it('★ speakerReady 等的是 play() 那个 promise:它没回来之前不算起播', async () => {
    const sdk = fakeSdk();
    const l = link(sdk);
    await l.value.acquire('call', fakeCredential());
    let started = (): void => {};
    const element = {
      tag: 'audio', muted: false, pause: () => {},
      play: () => new Promise<void>((resolve) => { started = resolve; }),
    } as unknown as HTMLMediaElement;
    sdk.rooms[0].fire('trackSubscribed', { kind: 'audio', attach: () => element });
    l.value.setSpeakerEnabled(true);
    let ready = false;
    void l.value.speakerReady().then(() => { ready = true; });
    await Promise.resolve();
    expect(ready).toBe(false);
    started();
    await new Promise<void>((done) => { setTimeout(done, 0); });
    expect(ready).toBe(true);
  });

  it('喇叭没开 / 还没订上音轨:speakerReady 当场就回(别把接通拖慢)', async () => {
    const sdk = fakeSdk();
    const l = link(sdk);
    await l.value.acquire('call', fakeCredential());
    await l.value.speakerReady(); // 喇叭还没开
    l.value.setSpeakerEnabled(true);
    await l.value.speakerReady(); // 开了,但房里还没有音轨
  });

  it('自动播放被拦(play() 拒绝)也算这一下过了:不许因此一直等着', async () => {
    const sdk = fakeSdk();
    const l = link(sdk);
    await l.value.acquire('call', fakeCredential());
    const element = {
      tag: 'audio', muted: false, pause: () => {},
      play: async () => { throw new Error('NotAllowedError'); },
    } as unknown as HTMLMediaElement;
    sdk.rooms[0].fire('trackSubscribed', { kind: 'audio', attach: () => element });
    l.value.setSpeakerEnabled(true);
    await l.value.speakerReady();
  });

  it('★ 离房把喇叭关回缺省:下一次进房不带着上一通电话的开关', async () => {
    const sdk = fakeSdk();
    const l = link(sdk);
    await l.value.acquire('call', fakeCredential());
    l.value.setSpeakerEnabled(true);
    await l.value.release('call');
    await l.value.acquire('ring', fakeCredential());
    const element = fakeAudio();
    sdk.rooms[1].fire('trackSubscribed', { kind: 'audio', attach: () => element });
    expect(element.muted).toBe(true);
  });

  it('房间自己断了(掉网 / 被踢)如实翻成 closed', async () => {
    const sdk = fakeSdk();
    const { value } = link(sdk);
    await value.acquire('rpc', fakeCredential());
    const seen: string[] = [];
    value.listen({ onState: (s) => seen.push(s) });
    sdk.rooms[0].fire('disconnected');
    expect(value.state()).toBe('closed');
    expect(seen).toEqual(['closed']);
  });

  it('一个监听者抛异常不该把别的监听者带走', async () => {
    const sdk = fakeSdk();
    const { value } = link(sdk);
    await value.acquire('rpc', fakeCredential());
    const seen: string[] = [];
    value.listen({ onState: () => { throw new Error('我坏了'); } });
    value.listen({ onState: (s) => seen.push(s) });
    expect(() => sdk.rooms[0].fire('disconnected')).not.toThrow();
    expect(seen).toEqual(['closed']);
  });

  it('麦克风开关传到 SDK', async () => {
    const sdk = fakeSdk();
    const { value } = link(sdk);
    await value.acquire('call', fakeCredential());
    await value.setMicrophoneEnabled(true);
    await value.setMicrophoneEnabled(false);
    expect(sdk.rooms[0].mic).toEqual([true, false]);
  });
});

/**
 * 挂断 = 撤掉麦克风轨道、停掉录音(2026-09-25,卡 fix/evening-gaps 第 1 条)。
 * `setMicrophoneEnabled(false)` 对已发布的轨道只是 mute:livekit-client 缺省不停底下的 MediaStreamTrack,
 * Android 的录音一直开着、轨道一直挂在常驻房间里,电脑上的工人照样订着它跑识别。
 */
describe('★ 挂断收场:撤轨道 + 停录音', () => {
  function withMic(sdk: ReturnType<typeof fakeSdk>) {
    const room = sdk.rooms[0];
    const stops: string[] = [];
    const unpublished: { sid: string; stop: boolean | undefined }[] = [];
    const mic = { sid: 'TR_mic', stop: () => { stops.push('mic'); } };
    const cam = { sid: 'TR_cam', stop: () => { stops.push('cam'); } };
    room.localParticipant.trackPublications = new Map<string, unknown>([
      ['TR_mic', { source: 'microphone', track: mic }],
      ['TR_cam', { source: 'camera', track: cam }],
    ]);
    room.localParticipant.unpublishTrack = async (track: { sid: string }, stop?: boolean) => { unpublished.push({ sid: track.sid, stop }); };
    return { stops, unpublished };
  }

  it('★★ 麦克风那条:从房里撤掉,并且带 stop(录音释放、指示灯灭);别的轨道不碰', async () => {
    const sdk = fakeSdk();
    const { value } = link(sdk);
    await value.acquire('call', fakeCredential());
    const seen = withMic(sdk);
    await value.stopMicrophone();
    expect(seen.unpublished).toEqual([{ sid: 'TR_mic', stop: true }]);
    expect(seen.stops).toEqual(['mic']);
    // 不是静音那一下。
    expect(sdk.rooms[0].mic).toEqual([]);
  });

  it('撤不掉(SDK 抛了)也要停掉录音', async () => {
    const sdk = fakeSdk();
    const { value } = link(sdk);
    await value.acquire('call', fakeCredential());
    const seen = withMic(sdk);
    sdk.rooms[0].localParticipant.unpublishTrack = async () => { throw new Error('协商断了'); };
    await expect(value.stopMicrophone()).resolves.toBeUndefined();
    expect(seen.stops).toEqual(['mic']);
  });

  it('没进房 / 没有轨道:什么都不做,不抛(关永远可以)', async () => {
    const sdk = fakeSdk();
    const { value } = link(sdk);
    await expect(value.stopMicrophone()).resolves.toBeUndefined();
    await value.acquire('call', fakeCredential());
    await expect(value.stopMicrophone()).resolves.toBeUndefined();
  });
});
