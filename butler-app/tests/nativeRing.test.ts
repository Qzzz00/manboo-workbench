/**
 * 原生收铃(2026-10-20,卡 E)。实测(docs/交接-1020-Pixel熄屏响铃实测.md):熄屏约 5 分钟后 WebView 那一页被冻住,
 * 房间里的 `ring` 没人读。这一版把「熄屏 / 后台时听铃」交给原生前台服务,**同一个身份、同一张凭证**:
 * LiveKit 同一个身份第二条连接会把第一条踢掉,所以两边**交接**而不是同时在房。
 *
 * 五节:①什么时候交给原生(纯函数);②交接的先后(先停靠网页、再让原生进;原生进不去就收回);
 * ③房间那一层的「停靠」;④通道层在停靠时不去敲房门、不把电脑说成不在;⑤原生那几个字符串与网页一致(读源头文件比对)。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  RING_HANDOFF_GRACE_MS,
  RING_HANDOFF_MIN_TOKEN_S,
  RING_HANDOFF_RETRY_MS,
  RING_HANDOFF_STARTUP_MS,
  createRingHandoff,
  ringHandoffWanted,
  type NativeRingPort,
} from '../src/call/ringHandoff';
import { createWbchRoomLink, WBCH_PARKABLE_HOLDERS, type WbchLivekitSdk } from '../src/channel/roomLink';
import { WBCH_PARKED_TEXT, createWbchChannel } from '../src/channel/channel';
import { createWbchCredentialStore, WBCH_CREDENTIAL_KEY, type WbchCredential } from '../src/channel/credentialStore';
import { WBCH_RPC_TOPIC, WBCH_WORKER_IDENTITY } from '../src/channel/channelProtocol';
import { RING_REASON_TITLES } from '../src/call/incomingModel';
import type { ApiClient } from '../src/api/client';
import { memoryStore } from './wbchFakes';

/* eslint-disable @typescript-eslint/no-explicit-any */

const NOW_MS = 1_800_000_000_000;
/** 手机这边 lib 是 ES2020,没有 `Array.prototype.at`。 */
function last<T>(list: readonly T[]): T | undefined { return list[list.length - 1]; }
const CREDENTIAL: WbchCredential = {
  url: 'wss://lk.test', room: 'acct-1', identity: 'wb-phone-dev1', token: 'jwt-1', expires_at: NOW_MS / 1000 + 7 * 24 * 3600,
};

function inputs(patch: Partial<Parameters<typeof ringHandoffWanted>[0]> = {}): Parameters<typeof ringHandoffWanted>[0] {
  return {
    visible: false,
    hiddenForMs: RING_HANDOFF_GRACE_MS,
    standby: true,
    busy: false,
    holders: ['ring'],
    credential: CREDENTIAL,
    nowMs: NOW_MS,
    ...patch,
  };
}

describe('① 什么时候交给原生', () => {
  it('熄屏 / 后台够久、只守着铃、待机开着、凭证够用 → 交', () => {
    expect(ringHandoffWanted(inputs())).toBe(true);
    // 出门在外:远程那一份(rpc)也在,一样交 —— 冻住的页面那条代理本来也答不了话。
    expect(ringHandoffWanted(inputs({ holders: ['ring', 'rpc'] }))).toBe(true);
  });

  it('看得见页面就不交;刚熄屏不到宽限期也不交(按一下电源键又点亮,不来回进出房)', () => {
    expect(ringHandoffWanted(inputs({ visible: true }))).toBe(false);
    expect(ringHandoffWanted(inputs({ hiddenForMs: RING_HANDOFF_GRACE_MS - 1 }))).toBe(false);
  });

  it('通话中 / 发文件 / 取文件(网页那几份持有)不交:一交就把这通电话从房里拿走了', () => {
    expect(ringHandoffWanted(inputs({ holders: ['ring', 'call'] }))).toBe(false);
    expect(ringHandoffWanted(inputs({ holders: ['ring', 'file'] }))).toBe(false);
    expect(ringHandoffWanted(inputs({ holders: ['ring', 'pull'] }))).toBe(false);
    // 话筒接起那一通 / 已接起(界面在通话页):busy。
    expect(ringHandoffWanted(inputs({ busy: true }))).toBe(false);
    // 根本没守着铃:没什么可交的。
    expect(ringHandoffWanted(inputs({ holders: ['rpc'] }))).toBe(false);
    expect(ringHandoffWanted(inputs({ holders: [] }))).toBe(false);
  });

  it('待机关着不交(原生没在跑,交出去就没人听);凭证没有 / 快过期不交', () => {
    expect(ringHandoffWanted(inputs({ standby: false }))).toBe(false);
    expect(ringHandoffWanted(inputs({ credential: null }))).toBe(false);
    expect(ringHandoffWanted(inputs({ credential: { ...CREDENTIAL, expires_at: NOW_MS / 1000 + RING_HANDOFF_MIN_TOKEN_S - 1 } }))).toBe(false);
  });

  it('能停靠的只有铃、远程、路线三份(与 roomLink 的那张表同一份;路线那份是局域网 M4 加的,也只是在房里等)', () => {
    expect([...WBCH_PARKABLE_HOLDERS].sort()).toEqual(['ring', 'route', 'rpc']);
  });
});

/** 一个够用的假房间层:只记停靠 / 收回的先后。 */
function parkingLink(holders: string[] = ['ring']) {
  const log: string[] = [];
  let parked = false;
  return {
    log,
    heldBy: () => holders,
    parked: () => parked,
    async park() { log.push('park'); parked = true; },
    async unpark() { log.push('unpark'); parked = false; },
    /** 网页那边有人(比如一通电话)自己把它拿回去了。 */
    takeBack() { parked = false; },
  };
}

function nativePort(result: { ok: boolean; note?: string } = { ok: true }): NativeRingPort & {
  log: string[]; creds: WbchCredential[]; ready: { ok: boolean; note?: string }; live: { state: string; note?: string };
} {
  const log: string[] = [];
  const creds: WbchCredential[] = [];
  const port = {
    log,
    creds,
    /** 原生那边此刻做得到吗(待机服务在不在跑)。 */
    ready: { ok: true } as { ok: boolean; note?: string },
    /** 原生听铃此刻的状态(NativeRingListener.STATE_*)。 */
    live: { state: 'listening' } as { state: string; note?: string },
    async listen(credential: WbchCredential) { log.push('listen'); creds.push(credential); return result; },
    async unlisten() { log.push('unlisten'); },
    async canListen() { log.push('ready?'); return port.ready; },
    async listenState(): Promise<{ state: string; note?: string } | null> { return port.live; },
  };
  return port;
}

function handoffWith(over: { visible?: boolean; busy?: boolean; standby?: boolean; link?: ReturnType<typeof parkingLink>; native?: ReturnType<typeof nativePort> } = {}) {
  let now = NOW_MS;
  let visible = over.visible ?? true;
  const busy = { value: over.busy ?? false };
  const link = over.link ?? parkingLink();
  const native = over.native ?? nativePort();
  const notes: (string | null)[] = [];
  const handoff = createRingHandoff({
    link,
    native,
    credential: () => CREDENTIAL,
    visible: () => visible,
    standby: () => over.standby ?? true,
    busy: () => busy.value,
    now: () => now,
    onNote: (text) => notes.push(text),
  });
  return {
    handoff, link, native, notes, busy,
    setVisible(next: boolean) { visible = next; },
    advance(ms: number) { now += ms; },
  };
}

describe('② 交接的先后', () => {
  it('熄屏够久:先停靠网页那条(离房),再让原生拿同一张凭证进房', async () => {
    const t = handoffWith();
    await t.handoff.update();
    t.setVisible(false);
    await t.handoff.update(); // 刚熄屏:记下时刻,不交
    expect(t.link.log).toEqual([]);
    t.advance(RING_HANDOFF_GRACE_MS);
    await t.handoff.update();
    expect(t.link.log).toEqual(['park']);
    expect(t.native.log).toEqual(['unlisten', 'ready?', 'listen']);
    expect(t.native.creds[0]).toEqual(CREDENTIAL);
    expect(t.handoff.mode()).toBe('native');
  });

  it('原生进不去(待机服务没起来):当场收回网页那条,并如实说一句', async () => {
    const native = nativePort({ ok: false, note: '后台待机没在跑' });
    const t = handoffWith({ native });
    t.setVisible(false);
    await t.handoff.update();
    t.advance(RING_HANDOFF_GRACE_MS);
    await t.handoff.update();
    expect(t.link.log).toEqual(['park', 'unpark']);
    expect(t.handoff.mode()).toBe('web');
    expect(last(t.notes)).toContain('后台待机没在跑');
  });

  it('亮屏回来:先让原生离房,再收回网页那条(反过来会被同一身份踢来踢去)', async () => {
    const t = handoffWith();
    t.setVisible(false);
    await t.handoff.update();
    t.advance(RING_HANDOFF_GRACE_MS);
    await t.handoff.update();
    t.native.log.length = 0;
    t.link.log.length = 0;
    t.setVisible(true);
    await t.handoff.update();
    expect(t.native.log).toEqual(['unlisten']);
    expect(t.link.log).toEqual(['unpark']);
    expect(t.handoff.mode()).toBe('web');
  });

  it('网页那边自己拿回了房间(一通电话要进房):原生那一条跟着放掉,不留两份', async () => {
    const t = handoffWith();
    t.setVisible(false);
    await t.handoff.update();
    t.advance(RING_HANDOFF_GRACE_MS);
    await t.handoff.update();
    t.native.log.length = 0;
    t.link.takeBack();
    await t.handoff.update();
    expect(t.native.log).toEqual(['unlisten']);
    expect(t.handoff.mode()).toBe('web');
  });

  it('通话中熄屏不交;通话收场之后(还熄着)才交', async () => {
    const t = handoffWith({ busy: true });
    t.setVisible(false);
    await t.handoff.update();
    t.advance(RING_HANDOFF_GRACE_MS * 3);
    await t.handoff.update();
    expect(t.link.log).toEqual([]);
    t.busy.value = false;
    await t.handoff.update();
    expect(t.link.log).toEqual(['park']);
  });

  it('同时来两次 update 只交一次', async () => {
    const t = handoffWith();
    t.setVisible(false);
    await t.handoff.update();
    t.advance(RING_HANDOFF_GRACE_MS);
    await Promise.all([t.handoff.update(), t.handoff.update()]);
    expect(t.link.log).toEqual(['park']);
    expect(t.native.log.filter((x) => x === 'listen')).toHaveLength(1);
  });

  it('E1 ★ 原生先问一句「做得到吗」:做不到就不离房(不进出房)', async () => {
    const native = nativePort();
    native.ready = { ok: false, note: '后台待机没在跑' };
    const t = handoffWith({ native });
    t.setVisible(false);
    await t.handoff.update();
    t.advance(RING_HANDOFF_GRACE_MS);
    await t.handoff.update();
    expect(t.link.log).toEqual([]);
    expect(t.native.log).not.toContain('listen');
    expect(last(t.notes)).toContain('后台待机没在跑');
  });

  it('E1 ★ 交不上之后退避:熄屏期间每 2 秒一拍,也不再进出房;过了退避期才再试一次', async () => {
    const native = nativePort({ ok: false, note: '原生进不去' });
    const t = handoffWith({ native });
    t.setVisible(false);
    await t.handoff.update();
    t.advance(RING_HANDOFF_GRACE_MS);
    await t.handoff.update();
    expect(t.link.log).toEqual(['park', 'unpark']);
    for (let i = 0; i < 20; i += 1) { t.advance(2_000); await t.handoff.update(); }
    expect(t.link.log).toEqual(['park', 'unpark']);
    t.advance(RING_HANDOFF_RETRY_MS);
    await t.handoff.update();
    expect(t.link.log).toEqual(['park', 'unpark', 'park', 'unpark']);
  });

  it('E1 亮一下屏再熄:退避清零,下一次熄屏照常交', async () => {
    const native = nativePort({ ok: false });
    const t = handoffWith({ native });
    t.setVisible(false);
    await t.handoff.update();
    t.advance(RING_HANDOFF_GRACE_MS);
    await t.handoff.update();
    t.setVisible(true);
    await t.handoff.update();
    t.setVisible(false);
    await t.handoff.update();
    t.advance(RING_HANDOFF_GRACE_MS);
    await t.handoff.update();
    expect(t.link.log.filter((x) => x === 'park')).toHaveLength(2);
  });

  it('E2 ★ 交出去之后每一拍回查原生:原生放弃了(被请出房 / 凭证到期)就收回网页那条,并如实说', async () => {
    const t = handoffWith();
    t.setVisible(false);
    await t.handoff.update();
    t.advance(RING_HANDOFF_GRACE_MS);
    await t.handoff.update();
    expect(t.handoff.mode()).toBe('native');
    t.native.live = { state: 'failed', note: '电脑那边把这台手机请出了房间' };
    t.advance(2_000);
    await t.handoff.update();
    expect(t.handoff.mode()).toBe('web');
    expect(last(t.link.log)).toBe('unpark');
    expect(last(t.notes)).toContain('电脑那边把这台手机请出了房间');
    // 收回之后不立刻又交出去(退避)。
    t.advance(2_000);
    await t.handoff.update();
    expect(t.link.log.filter((x) => x === 'park')).toHaveLength(1);
  });

  it('E2 原生那边已经没了(服务被杀 → off):同样收回;刚交出去那一下的 off 不算(服务还没起完)', async () => {
    const t = handoffWith();
    t.native.live = { state: 'off' };
    t.setVisible(false);
    await t.handoff.update();
    t.advance(RING_HANDOFF_GRACE_MS);
    await t.handoff.update();
    t.advance(RING_HANDOFF_STARTUP_MS - 1);
    await t.handoff.update();
    expect(t.handoff.mode()).toBe('native');
    t.advance(2);
    await t.handoff.update();
    expect(t.handoff.mode()).toBe('web');
  });

  it('E2 原生在重连(网断了)不收回:那是它自己会修好的', async () => {
    const t = handoffWith();
    t.setVisible(false);
    await t.handoff.update();
    t.advance(RING_HANDOFF_GRACE_MS);
    await t.handoff.update();
    for (const state of ['connecting', 'reconnecting', 'retrying', 'listening']) {
      t.native.live = { state };
      t.advance(RING_HANDOFF_STARTUP_MS + 2_000);
      await t.handoff.update();
      expect(t.handoff.mode()).toBe('native');
    }
  });

  it('收场(页面没了 / 卸载):交出去的收回来', async () => {
    const t = handoffWith();
    t.setVisible(false);
    await t.handoff.update();
    t.advance(RING_HANDOFF_GRACE_MS);
    await t.handoff.update();
    await t.handoff.dispose();
    expect(last(t.native.log)).toBe('unlisten');
    expect(last(t.link.log)).toBe('unpark');
  });
});

/** 与 desktopAsleep.test.ts 同一间假房,只留这几条用例用得到的。 */
function fakeSdk() {
  const rooms: any[] = [];
  const sdk: WbchLivekitSdk = {
    Room: (function FakeRoom(this: unknown) {
      const handlers = new Map<string, ((...args: any[]) => void)[]>();
      const room = {
        connects: 0,
        disconnects: 0,
        remoteParticipants: new Map<string, unknown>([[WBCH_WORKER_IDENTITY, {}]]),
        localParticipant: { identity: 'wb-phone-dev1', sendText: async () => {} },
        on(event: string, handler: (...args: any[]) => void) { handlers.set(event, [...(handlers.get(event) ?? []), handler]); return room; },
        async connect() { room.connects += 1; },
        async disconnect() { room.disconnects += 1; },
      };
      rooms.push(room);
      return room as never;
    }) as never,
    RoomEvent: {},
  };
  return { sdk, rooms };
}

describe('③ 房间那一层的「停靠」', () => {
  it('停靠:离房但记着谁持有;铃 / 远程再来要只记一笔,不进房', async () => {
    const { sdk, rooms } = fakeSdk();
    const link = createWbchRoomLink({ loadSdk: async () => sdk, attachAudio: () => {}, detachAudio: () => {} });
    await link.acquire('ring', CREDENTIAL);
    expect(link.state()).toBe('connected');
    await link.park!();
    expect(link.parked!()).toBe(true);
    expect(link.state()).toBe('closed');
    expect(rooms[0].disconnects).toBe(1);
    expect(link.heldBy!()).toEqual(['ring']);
    // 看门狗那一拍(holdForRing)、远程那条路:只记,不进房 —— 进了就把原生踢出去。
    await link.acquire('ring', CREDENTIAL);
    await link.acquire('rpc', CREDENTIAL);
    expect(rooms).toHaveLength(1);
    expect([...link.heldBy!()].sort()).toEqual(['ring', 'rpc']);
    // 停靠时发不出去:当场失败,不悬着。
    await expect(link.sendText('x', WBCH_RPC_TOPIC)).rejects.toThrow();
  });

  it('收回:持有还在就重新进房', async () => {
    const { sdk, rooms } = fakeSdk();
    const link = createWbchRoomLink({ loadSdk: async () => sdk, attachAudio: () => {}, detachAudio: () => {} });
    await link.acquire('ring', CREDENTIAL);
    await link.park!();
    await link.unpark!(CREDENTIAL);
    expect(link.parked!()).toBe(false);
    expect(link.state()).toBe('connected');
    expect(rooms).toHaveLength(2);
  });

  it('停靠时来一通要进房的(通话 / 文件):自己收回并进房', async () => {
    const { sdk, rooms } = fakeSdk();
    const link = createWbchRoomLink({ loadSdk: async () => sdk, attachAudio: () => {}, detachAudio: () => {} });
    await link.acquire('ring', CREDENTIAL);
    await link.park!();
    await link.acquire('call', CREDENTIAL);
    expect(link.parked!()).toBe(false);
    expect(link.state()).toBe('connected');
    expect(rooms).toHaveLength(2);
  });

  it('没人持有时停靠 / 收回什么都不做', async () => {
    const { sdk, rooms } = fakeSdk();
    const link = createWbchRoomLink({ loadSdk: async () => sdk, attachAudio: () => {}, detachAudio: () => {} });
    await link.park!();
    await link.unpark!(CREDENTIAL);
    expect(rooms).toHaveLength(0);
    expect(link.state()).toBe('closed');
  });
});

describe('④ 通道层:停靠时不敲房门、不把电脑说成不在', () => {
  const direct: ApiClient = {
    baseUrl: 'http://192.168.1.10:8791',
    async json() { return { ok: false as const, status: 0, kind: 'network' as const, error: '连不上' }; },
  } as unknown as ApiClient;

  it('远程那条路:当场回「后台待机中」,presence 不动', async () => {
    const { sdk, rooms } = fakeSdk();
    const link = createWbchRoomLink({ loadSdk: async () => sdk, attachAudio: () => {}, detachAudio: () => {} });
    const kv = memoryStore({ [WBCH_CREDENTIAL_KEY]: JSON.stringify(CREDENTIAL) });
    const channel = createWbchChannel({
      direct, store: createWbchCredentialStore(kv), onUnauthorized: () => {}, link, now: () => NOW_MS, workerGraceMs: 1, absentRecheckMs: 1,
    });
    expect((await channel.holdForRing()).ok).toBe(true);
    await link.park!();
    const before = channel.presence!().kind;
    const result = await channel.remote();
    expect(result).toEqual({ ok: false, error: WBCH_PARKED_TEXT });
    expect(channel.presence!().kind).toBe(before);
    // 看门狗那一拍:照旧回「好」,但没有进房。
    expect((await channel.holdForRing()).ok).toBe(true);
    expect(rooms).toHaveLength(1);
    channel.stop();
  });
});

describe('⑤ 原生那一头的几个字符串与网页一致(读源头文件比对)', () => {
  const kotlin = readFileSync(resolve(__dirname, '../android/app/src/main/java/ai/ben/butler/RingSignal.kt'), 'utf8');

  it('topic 与工人身份', () => {
    expect(kotlin).toContain(`const val RPC_TOPIC = "${WBCH_RPC_TOPIC}"`);
    expect(kotlin).toContain(`const val WORKER_IDENTITY = "${WBCH_WORKER_IDENTITY}"`);
  });

  it('来电理由那几句人话(原生通知上的标题与网页来电页同一份)', () => {
    for (const [reason, title] of Object.entries(RING_REASON_TITLES)) {
      expect(kotlin).toContain(`"${reason}" to "${title}"`);
    }
  });
});
