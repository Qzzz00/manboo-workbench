/**
 * 电脑重装之后手机困在旧房间(2026-09-23 从零重装验收第 1 件)。要守住的四条:
 *
 *   1. **重新配对之后不拿旧凭证进房**:存着的那张身份(device_id)对不上就当没有,现取一张新的;
 *   2. **房里等不到工人时核对一次房间**:电脑那边换了一间 → 换上新凭证、持有一起搬进新房间,
 *      工人在那边就照常接通;问不到 → 说人话并引导重新配对;没换 → 工人真的不在;
 *   3. **挂断等不到工人回话也挂得掉**:每一步有超时,不卡在「正在挂断…」;
 *   4. 经房间发一条消息时 `sendText` 永远不落地,超时照样收场(那正是卡住的根子)。
 */
import { describe, expect, it } from 'vitest';
import type { ApiClient, ApiResult } from '../src/api/client';
import { WBCH_ROOM_STALE_TEXT, createWbchChannel } from '../src/channel/channel';
import { WBCH_CREDENTIAL_KEY, createWbchCredentialStore, type WbchCredential } from '../src/channel/credentialStore';
import { WBCH_RPC_TIMEOUT_TEXT, createWbchRpc } from '../src/channel/rpc';
import { createWbchRoomLink, type WbchLivekitSdk } from '../src/channel/roomLink';
import { WBCH_WORKER_IDENTITY } from '../src/channel/channelProtocol';
import { WBCH_CALL_NO_WORKER_TEXT, createWbchCallClient } from '../src/call/livekitCall';
import type { CallEvents } from '../src/call/rtcCall';
import type { CallPhase } from '../src/call/callModel';
import { createFakeLink, fakeChannel, fakeCredential, memoryStore } from './wbchFakes';

/**
 * 用例里**不烘热通话输出**(2026-09-28,卡 OP):jsdom 里没有真的音频输出可判 ——
 * `<audio>` 的 `play()` 是空实现、媒体时钟永远不走,烘热就会每通白等到上限。
 * 烘热本身在 tests/outputWarm.test.ts 里逐条钉;它在通话流程里的位置由「烘热」那一节钉。
 */
const NO_WARM = { makeWarmSink: () => undefined };

/* eslint-disable @typescript-eslint/no-explicit-any */

const OLD: WbchCredential = { url: 'wss://lk.test', room: 'workbench', identity: 'wb-phone-old', token: 'jwt-old', expires_at: 2_000_000_000 };
const NEW: WbchCredential = { url: 'wss://lk.test', room: 'wb-8913', identity: 'wb-phone-new', token: 'jwt-new', expires_at: 2_000_000_000 };

function direct(answer: () => ApiResult<unknown>): ApiClient & { calls: number } {
  const client = {
    calls: 0,
    baseUrl: 'http://10.0.0.9:8791',
    async json() { client.calls += 1; return answer() as ApiResult<never>; },
    async blob() { return { ok: false as const, status: 0, kind: 'network' as const, error: 'x' }; },
  };
  return client;
}

describe('① 重新配对之后不拿旧凭证进房', () => {
  it('存着的那张身份对不上(上一次配对留下的):丢掉,现取一张新的', async () => {
    const kv = memoryStore({ [WBCH_CREDENTIAL_KEY]: JSON.stringify(OLD) });
    const link = createFakeLink();
    const lan = direct(() => ({ ok: true, status: 200, data: { ...NEW, identity: 'wb-phone-new' } }));
    const channel = createWbchChannel({
      direct: lan, store: createWbchCredentialStore(kv), onUnauthorized: () => {}, link,
      expectedIdentity: 'wb-phone-new', now: () => 1_000_000,
    });
    await channel.acquireCall();
    expect(channel.credential()?.room).toBe('wb-8913');
    expect(lan.calls).toBe(1);
    expect(JSON.parse(kv.map.get(WBCH_CREDENTIAL_KEY) ?? '{}').room).toBe('wb-8913');
  });

  it('身份对得上就照用(不白取一张)', async () => {
    const kv = memoryStore({ [WBCH_CREDENTIAL_KEY]: JSON.stringify(NEW) });
    const lan = direct(() => ({ ok: false, status: 0, kind: 'network', error: '不该来问' }));
    const channel = createWbchChannel({
      direct: lan, store: createWbchCredentialStore(kv), onUnauthorized: () => {}, link: createFakeLink(),
      expectedIdentity: 'wb-phone-new', now: () => 1_000_000,
    });
    await channel.acquireCall();
    expect(lan.calls).toBe(0);
    expect(channel.credential()?.token).toBe('jwt-new');
  });
});

describe('② 核对房间(recheckRoom)', () => {
  function wire(answer: () => ApiResult<unknown>) {
    const kv = memoryStore({ [WBCH_CREDENTIAL_KEY]: JSON.stringify(OLD) });
    const link = createFakeLink();
    const switched: WbchCredential[] = [];
    link.switchRoom = async (credential) => { switched.push(credential); };
    const channel = createWbchChannel({ direct: direct(answer), store: createWbchCredentialStore(kv), onUnauthorized: () => {}, link, now: () => 1_000_000 });
    return { channel, link, switched };
  }

  it('电脑换了一间房:换上新凭证,正拿着房间的持有一起搬过去', async () => {
    const { channel, switched } = wire(() => ({ ok: true, status: 200, data: NEW }));
    await channel.acquireCall();
    expect(await channel.recheckRoom?.()).toEqual({ kind: 'moved', from: 'workbench', to: 'wb-8913' });
    expect(switched.map((c) => c.room)).toEqual(['wb-8913']);
    expect(channel.credential()?.room).toBe('wb-8913');
  });

  it('还是这一间:如实说「同一间」,不换房', async () => {
    const { channel, switched } = wire(() => ({ ok: true, status: 200, data: { ...OLD, token: 'jwt-2' } }));
    await channel.acquireCall();
    expect(await channel.recheckRoom?.()).toEqual({ kind: 'same' });
    expect(switched).toEqual([]);
  });

  it('问不到:回原话,不换房', async () => {
    const { channel, switched } = wire(() => ({ ok: false, status: 0, kind: 'network', error: '连不上工作台' }));
    await channel.acquireCall();
    expect(await channel.recheckRoom?.()).toEqual({ kind: 'unknown', error: '连不上工作台' });
    expect(switched).toEqual([]);
  });
});

describe('② 房间连接换房:持有不变、不当成「断了」', () => {
  function fakeSdk() {
    const rooms: any[] = [];
    class FakeRoom {
      handlers = new Map<string, ((...args: any[]) => void)[]>();
      remoteParticipants = new Map<string, unknown>();
      connected: string[] = [];
      localParticipant = { identity: 'wb-phone-new', sendText: async () => {}, setMicrophoneEnabled: async () => ({}) };
      constructor() { rooms.push(this); }
      on(event: string, handler: (...args: any[]) => void) { const l = this.handlers.get(event) ?? []; l.push(handler); this.handlers.set(event, l); return this; }
      registerTextStreamHandler() {}
      registerByteStreamHandler() {}
      async connect(url: string, token: string) { this.connected.push(`${url}|${token}`); }
      async disconnect() { for (const h of this.handlers.get('disconnected') ?? []) h(); }
    }
    return { sdk: { Room: FakeRoom as never, RoomEvent: { Disconnected: 'disconnected' } } as WbchLivekitSdk, rooms };
  }

  it('换进新房间;旧那间断开时不发 closed(通话那一层会把它当成掉线)', async () => {
    const { sdk, rooms } = fakeSdk();
    const link = createWbchRoomLink({ loadSdk: async () => sdk, attachAudio: () => {}, detachAudio: () => {} });
    const states: string[] = [];
    link.listen({ onState: (s) => states.push(s) });
    await link.acquire('call', OLD);
    await link.acquire('ring', OLD);
    link.setSpeakerEnabled(true);
    states.length = 0;
    await link.switchRoom?.(NEW);
    expect(rooms).toHaveLength(2);
    expect(rooms[1].connected).toEqual(['wss://lk.test|jwt-new']);
    expect(states).not.toContain('closed');
    expect(link.state()).toBe('connected');
    // 持有还在:放掉一份不离房,两份都放才离。
    await link.release('call');
    expect(link.state()).toBe('connected');
    await link.release('ring');
    expect(link.state()).toBe('closed');
  });

  it('没人持有:什么都不做', async () => {
    const { sdk, rooms } = fakeSdk();
    const link = createWbchRoomLink({ loadSdk: async () => sdk, attachAudio: () => {}, detachAudio: () => {} });
    await link.switchRoom?.(NEW);
    expect(rooms).toHaveLength(0);
  });
});

function recorder() {
  const phases: { phase: CallPhase; error?: string }[] = [];
  const events: CallEvents = {
    onPhase: (phase, detail) => phases.push({ phase, ...(detail?.error === undefined ? {} : { error: detail.error }) }),
    onUtterance: () => {},
    onInterim: () => {},
    onBotSpeaking: () => {},
    onMicSpeaking: () => {},
  };
  return { events, phases };
}

const GRANTED = async () => ({ state: 'granted' as const, granted: true, needsSettings: false, via: 'native' as const });

describe('② 通话里等不到工人', () => {
  it('★ 核对出电脑换了房间:换过去、工人在,照常接通', async () => {
    const link = createFakeLink();
    let present = false;
    link.workerPresent = () => present;
    const channel = fakeChannel({
      link,
      acquireCall: async () => { await link.acquire('call', fakeCredential()); },
      recheckRoom: async () => { present = true; return { kind: 'moved', from: 'workbench', to: 'wb-8913' }; },
    });
    const rec = recorder();
    await createWbchCallClient({ ...NO_WARM, channel, workerWaitMs: 10, askMicPermission: GRANTED }).start({}, rec.events);
    expect(rec.phases.map((p) => p.phase)).toEqual(['connecting', 'connected']);
    // 麦克风只在新房间里、工人露面之后发一次(2026-09-25:真接通了才开麦,旧房间里不先发一遍)。
    expect(link.micLog).toEqual([true]);
  });

  it('★ 问不到电脑那边是哪一间:不说「进程没跑」,说可能是旧配对并引导重新配对', async () => {
    const link = createFakeLink();
    link.workerPresent = () => false;
    const channel = fakeChannel({ link, recheckRoom: async () => ({ kind: 'unknown', error: '连不上工作台' }) });
    const rec = recorder();
    await createWbchCallClient({ ...NO_WARM, channel, workerWaitMs: 10, askMicPermission: GRANTED }).start({}, rec.events);
    expect(rec.phases[rec.phases.length - 1]).toEqual({ phase: 'error', error: WBCH_ROOM_STALE_TEXT });
    expect(WBCH_ROOM_STALE_TEXT).toContain('重新扫码');
  });

  it('还是同一间:工人真的不在,说那一句', async () => {
    const link = createFakeLink();
    link.workerPresent = () => false;
    const channel = fakeChannel({ link, recheckRoom: async () => ({ kind: 'same' }) });
    const rec = recorder();
    await createWbchCallClient({ ...NO_WARM, channel, workerWaitMs: 10, askMicPermission: GRANTED }).start({}, rec.events);
    expect(rec.phases[rec.phases.length - 1]).toEqual({ phase: 'error', error: WBCH_CALL_NO_WORKER_TEXT });
  });
});

describe('③ 挂断等不到工人回话也挂得掉', () => {
  it('★ 告诉工人「挂了」那一条永远不回:最多等一步的时间就收场', async () => {
    const link = createFakeLink();
    const never = new Promise<never>(() => {});
    const channel = fakeChannel({
      link,
      hangupCall: () => never,
      onboarding: async (action) => (action === 'stop' ? never : { ok: true }),
    });
    const client = createWbchCallClient({ ...NO_WARM, channel, workerWaitMs: 10, askMicPermission: GRANTED, hangupStepMs: 20 });
    await client.start({}, recorder().events);
    const started = Date.now();
    const result = await client.hangup();
    expect(Date.now() - started).toBeLessThan(1000);
    expect(result.transcript).toEqual([]);
    expect(link.holders.has('call')).toBe(false);
  });

  it('引导那一通的「暂停」永远不回:同样收场', async () => {
    const link = createFakeLink();
    const never = new Promise<never>(() => {});
    const channel = fakeChannel({ link, onboarding: async (action) => (action === 'stop' ? never : { ok: true }) });
    const client = createWbchCallClient({ ...NO_WARM, channel, workerWaitMs: 10, askMicPermission: GRANTED, hangupStepMs: 20 });
    await client.start({ onboarding: { resume: false } }, recorder().events);
    await expect(client.hangup()).resolves.toMatchObject({ transcript: [] });
  });
});

describe('④ sendText 永远不落地,超时照样收场', () => {
  it('以前这里 await 着 sendText,超时到了调用方也回不来', async () => {
    const link = createFakeLink();
    link.sendText = () => new Promise<void>(() => {});
    const rpc = createWbchRpc({ link, timeoutMs: 20 });
    await expect(rpc.callHangup()).resolves.toEqual({ ok: false, error: WBCH_RPC_TIMEOUT_TEXT });
  });

  it('工人照常答复时不受影响', async () => {
    const link = createFakeLink();
    const rpc = createWbchRpc({ link, newId: () => 'id-1' });
    const pending = rpc.callHangup();
    link.deliver({ id: 'id-1', type: 'call', ok: true }, WBCH_WORKER_IDENTITY);
    await expect(pending).resolves.toEqual({ ok: true });
  });
});
