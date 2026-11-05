/**
 * 通道层用例里共用的假件(不是测试文件本身:vitest 的 include 只收 *.test.ts)。
 */
import type { WbchCredential } from '../src/channel/credentialStore';
import type { WbchLinkListener, WbchLinkState, WbchRoomLink } from '../src/channel/roomLink';
import { WBCH_WORKER_IDENTITY } from '../src/channel/channelProtocol';
import type { KeyValueStore } from '../src/api/tokenStore';
import type { WbchChannel } from '../src/channel/channel';
import type { WbchRoutedClient } from '../src/channel/routedClient';
import type { WbchMode } from '../src/channel/channelProtocol';
import type { ApiClient } from '../src/api/client';

export function fakeCredential(patch: Partial<WbchCredential> = {}): WbchCredential {
  return {
    url: 'wss://lk.example.test',
    room: 'workbench',
    identity: 'wb-phone-dev1',
    token: 'jwt-1',
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    ...patch,
  };
}

export interface FakeLink extends WbchRoomLink {
  /** 手机发出去的每一行 JSON(按顺序)。点名发的那几条带 `to`(2026-09-25:识别那一条只发工人)。 */
  readonly sent: { text: string; topic: string; to?: string }[];
  /** 手机发出去的每个文件。`to` 是点名发的那一台(2026-09-21),不点名就是 undefined。 */
  readonly files: { name: string; topic: string; to: string | undefined }[];
  /** 手机发出去的每一段字节(2026-09-25,卡 S:识别的录音走 `wb.asr`)。 */
  readonly bytes: { data: Uint8Array; topic: string; to: string; name?: string; mimeType?: string; attributes?: Record<string, string> }[];
  readonly holders: ReadonlySet<string>;
  readonly micLog: boolean[];
  /**
   * 「撤掉轨道、停掉录音」那一种关(stopMicrophone,2026-09-25)被调了几次。它同时往 micLog 里记一个 false
   * (对只看「开 / 关」顺序的老用例来说它就是一次关);要分清是静音还是撤轨道,看这个数。
   */
  micStops: number;
  /** 喇叭开关按顺序记一遍(2026-09-22 晚:「谁接谁说话」那条靠它钉)。 */
  readonly speakerLog: boolean[];
  /** 假装工人回了一条。 */
  deliver(value: unknown, from?: string): void;
  /** 假装工人发来一个文件。 */
  deliverFile(name: string, text: string, from?: string): void;
  /** 假装房里谁在出声。 */
  deliverSpeaking(who: 'butler' | 'me', speaking: boolean): void;
  /** 假装工人进/离房。 */
  deliverWorker(present: boolean): void;
  setState(state: WbchLinkState): void;
  /** 下一次 acquire 抛这个。 */
  failNextAcquire(error: string): void;
  /**
   * 进过哪几间房(2026-10-21,局域网 M4):`open <url> <room>` / `switch <url> <room>` / `detach`。
   * 只记真进出房那几下(已经在同一间房里再 acquire 不记)。
   */
  readonly rooms: string[];
  /** 下一次 switchRoom 抛这个。 */
  failNextSwitch(error: string): void;
}

export function createFakeLink(): FakeLink {
  const listeners = new Set<WbchLinkListener>();
  const holders = new Set<string>();
  const sent: { text: string; topic: string; to?: string }[] = [];
  const files: { name: string; topic: string; to: string | undefined }[] = [];
  const bytes: FakeLink['bytes'][number][] = [];
  const micLog: boolean[] = [];
  const speakerLog: boolean[] = [];
  let state: WbchLinkState = 'closed';
  let worker = true;
  let acquireError: string | null = null;
  let switchError: string | null = null;
  const rooms: string[] = [];
  let current: { url: string; room: string } | null = null;

  const link: FakeLink = {
    sent,
    files,
    bytes,
    holders,
    micLog,
    micStops: 0,
    speakerLog,
    state: () => state,
    workerPresent: () => worker,
    rooms,
    async acquire(holder, credential) {
      if (acquireError !== null) { const e = acquireError; acquireError = null; throw new Error(e); }
      holders.add(holder);
      if (state !== 'connected' && credential !== undefined) { current = { url: credential.url, room: credential.room }; rooms.push(`open ${credential.url} ${credential.room}`); }
      link.setState('connected');
    },
    async release(holder) {
      holders.delete(holder);
      if (holders.size === 0) { current = null; link.setState('closed'); }
    },
    heldBy: () => [...holders],
    current: () => current,
    async switchRoom(credential) {
      if (holders.size === 0) return;
      if (switchError !== null) { const e = switchError; switchError = null; current = null; state = 'failed'; throw new Error(e); }
      current = { url: credential.url, room: credential.room };
      rooms.push(`switch ${credential.url} ${credential.room}`);
      state = 'connected';
    },
    async detach() {
      current = null;
      rooms.push('detach');
      link.setState('closed');
    },
    failNextSwitch(error) { switchError = error; },
    async sendText(text, topic, to) { sent.push(to === undefined ? { text, topic } : { text, topic, to }); },
    async sendFile(file, topic, to) { files.push({ name: file.name, topic, to }); },
    async sendBytes(data, topic, to, options = {}) { bytes.push({ data, topic, to, ...options }); },
    async setMicrophoneEnabled(enabled) { micLog.push(enabled); return enabled; },
    async stopMicrophone() { micLog.push(false); link.micStops += 1; },
    setSpeakerEnabled(enabled) { speakerLog.push(enabled); },
    // 起播那一下(卡 CL):缺省当场就回(不记进 speakerLog —— 那一串只记开关)。
    // 要卡住它、或者看它被等过没有的用例,自己换掉这个方法。
    async speakerReady() { /* 当场就回 */ },
    listen(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    deliver(value, from = WBCH_WORKER_IDENTITY) {
      const text = typeof value === 'string' ? value : JSON.stringify(value);
      for (const l of [...listeners]) l.onText?.(text, from);
    },
    deliverFile(name, text, from = WBCH_WORKER_IDENTITY) {
      for (const l of [...listeners]) l.onFile?.({ name, bytes: new TextEncoder().encode(text), from });
    },
    deliverWorker(present) {
      for (const l of [...listeners]) l.onWorker?.(present);
    },
    deliverSpeaking(who, speaking) {
      for (const l of [...listeners]) {
        if (who === 'butler') l.onRemoteSpeaking?.(speaking);
        else l.onLocalSpeaking?.(speaking);
      }
    },
    setState(next) {
      if (state === next) return;
      state = next;
      worker = next === 'connected';
      for (const l of [...listeners]) l.onState?.(next);
    },
    failNextAcquire(error) { acquireError = error; },
  };
  return link;
}

/** 一个等用例放行的 promise。 */
export function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

/**
 * 假轨道(2026-09-24,卡 fix/call-mute-before-publish):按 SDK 那一侧**真正落地的顺序**记「此刻在不在发」,
 * 调用顺序照旧记在 `micLog`。`holdPublish()` 让下一次「开」卡在半路(冷启动 getUserMedia + 协商那几秒),
 * 返回放行它的那个函数 —— 卡着的时候来的「关」**当场落地**(比真的 SDK 更严:它不替你等那一次发布),
 * 所以「一回来就又开了」在这里一定看得出来。
 */
export function trackMic(link: FakeLink): { readonly live: boolean; holdPublish(): () => void } {
  let live = false;
  let hold: { promise: Promise<void>; resolve: (value: void) => void } | null = null;
  link.setMicrophoneEnabled = async (enabled: boolean) => {
    link.micLog.push(enabled);
    if (enabled && hold !== null) { const waiting = hold; hold = null; await waiting.promise; }
    live = enabled;
    return enabled;
  };
  link.stopMicrophone = async () => {
    link.micLog.push(false);
    link.micStops += 1;
    live = false;
  };
  return {
    get live() { return live; },
    holdPublish() {
      const gate = deferred<void>();
      hold = gate;
      return () => gate.resolve();
    },
  };
}

/** 手机发出去的最后一条请求。 */
export function lastSent(link: FakeLink): Record<string, unknown> {
  const entry = link.sent[link.sent.length - 1];
  if (entry === undefined) throw new Error('一条都没发出去');
  return JSON.parse(entry.text) as Record<string, unknown>;
}

export function memoryStore(initial: Record<string, string> = {}): KeyValueStore & { map: Map<string, string> } {
  const map = new Map(Object.entries(initial));
  return {
    map,
    async get(key) { return map.get(key) ?? null; },
    async set(key, value) { map.set(key, value); },
    async remove(key) { map.delete(key); },
  };
}

// ———— 给别的用例当零件:一个不碰 livekit-client 的通道层 + 一个只会直连的 routedClient ————

/**
 * 假通道层。缺省:有一张凭证、进房总是成功、什么都不发生。
 * 用例只覆盖它关心的那几个方法。
 */
export function fakeChannel(patch: Partial<WbchChannel> = {}): WbchChannel {
  const link = createFakeLink();
  return {
    link,
    remote: async () => ({ ok: false, error: '用例没给远程那条路' }),
    credential: () => fakeCredential(),
    releaseRemote: async () => { await link.release('rpc'); },
    refresh: async () => ({ ok: true }),
    renewNow: async () => ({ ok: true }),
    renewDelayMs: () => 3600_000,
    acquireCall: async () => { await link.acquire('call', fakeCredential()); },
    releaseCall: async () => { await link.release('call'); },
    sendFile: async () => ({ ok: true }),
    // 引导那条消息(2026-09-18):缺省当成接上了,用例要看它就自己 patch 一份。
    onboarding: async () => ({ ok: true }),
    // 普通通话那句招呼(2026-09-18):缺省当成说出去了。
    callStart: async () => ({ ok: true }),
    // 座机主动来电那几条(2026-09-21):缺省当成办成了,用例要看它就自己 patch。
    answerCall: async () => ({ ok: true }),
    laterCall: async () => ({ ok: true }),
    hangupCall: async () => ({ ok: true }),
    // 「我这边在放了」(2026-09-28,卡 CF 第 4 条):缺省当成报出去了,用例要看它就自己 patch。
    playingCall: async () => ({ ok: true }),
    holdForRing: async () => { await link.acquire('ring', fakeCredential()); return { ok: true }; },
    releaseRing: async () => { await link.release('ring'); },
    onCaption: () => () => {},
    onFiller: () => () => {},
    // 应声信号(2026-10-02,卡「声音与形象跟着话走」第 5 件):缺省什么都不发,
    // 用例要看它就自己 patch 一份(同 onFiller 那条)。
    onBackchannel: () => () => {},
    onFillerVoice: () => () => {},
    onRing: () => () => {},
    onFile: () => () => {},
    subscribe: () => () => {},
    stop: () => {},
    ...patch,
  };
}

/** 只会走直连的 routedClient(用例里不想连房间时用它包一层)。 */
export function fakeRouted(client: ApiClient, mode: WbchMode = 'direct'): WbchRoutedClient {
  return { ...client, mode: () => mode, subscribe: () => () => {} };
}
