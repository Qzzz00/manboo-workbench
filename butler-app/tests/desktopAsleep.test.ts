/**
 * **电脑睡了不是配对坏了**(2026-09-28,卡 AW 的手机端那一半)。
 *
 * 现场:维护者的新 Air 不插电时会自己睡,一睡手机首页就写「找不到你的电脑」+「重新扫码配对」——
 * 她照着做只会白扫一遍二维码,而其实只要掀开电脑。
 *
 * 要守住的:
 *   1. 房间那一层**记住电脑那一方上一次是怎么走的**:livekit 的 `disconnectReason` 能说就照它说;
 *      说不了就只认「这一次连接里见过它在房里、我们自己的连接当时是好的,它却消失了」这一条依据;
 *      再取不到就一律 `unknown`;
 *   2. 通道层把这条依据带进 `presence.absent.departure`;
 *   3. 首页按依据分三路说话:睡着了 / 工作台没在运行 / 连不上(说不清);
 *      **没有依据时一个字都不许说成睡着了**,`revoked` 那一路与「重新扫码配对」一个字没动。
 */
import { describe, expect, it } from 'vitest';
import { createWbchRoomLink, type WbchLivekitSdk, type WbchWorkerDeparture } from '../src/channel/roomLink';
import { WBCH_WORKER_IDENTITY } from '../src/channel/channelProtocol';
import {
  RELINK_ABSENT_DETAIL, RELINK_ABSENT_TITLE, RELINK_ACTION_LABEL,
  RELINK_ASLEEP_DETAIL, RELINK_ASLEEP_TITLE, RELINK_QUIT_DETAIL, RELINK_QUIT_TITLE,
  RELINK_REVOKED_DETAIL, RELINK_REVOKED_TITLE, relinkNotice,
} from '../src/stage/linkHealth';
import {
  ASR_DESKTOP_ASLEEP_TEXT, ASR_DESKTOP_OFFLINE_TEXT, ASR_OFFLINE_TEXT, asrOfflineText,
} from '../src/api/voice';
import { WBCH_DESKTOP_NOT_IN_ROOM_TEXT, createWbchChannel } from '../src/channel/channel';
import { createWbchCredentialStore, WBCH_CREDENTIAL_KEY, type WbchCredential } from '../src/channel/credentialStore';
import type { ApiClient } from '../src/api/client';
import { createFakeLink, memoryStore } from './wbchFakes';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** livekit 的 DisconnectReason(@livekit/protocol 1.50.4)里这几条用例用到的那几个数。 */
const REASON = {
  CLIENT_INITIATED: 1,
  PARTICIPANT_REMOVED: 4,
  SIGNAL_CLOSE: 9,
  CONNECTION_TIMEOUT: 14,
  MEDIA_FAILURE: 15,
} as const;

const EVENTS = {
  ParticipantConnected: 'participantConnected',
  ParticipantDisconnected: 'participantDisconnected',
  Disconnected: 'disconnected',
  Reconnecting: 'reconnecting',
  Reconnected: 'reconnected',
  Moved: 'moved',
};

const CREDENTIAL: WbchCredential = {
  url: 'wss://lk.test', room: 'acct-1', identity: 'wb-phone-dev1', token: 'jwt-1', expires_at: 2_000_000_000,
};

/** 一间够用的假房:能让电脑进来、走掉,能放事件。 */
function fakeRoom() {
  const handlers = new Map<string, ((...args: any[]) => void)[]>();
  const room = {
    handlers,
    remoteParticipants: new Map<string, unknown>(),
    localParticipant: { identity: 'wb-phone-dev1' },
    on(event: string, handler: (...args: any[]) => void) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      return room;
    },
    async connect() { /* 接上了 */ },
    async disconnect() { /* 断了 */ },
    fire(event: string, ...args: any[]) { for (const h of handlers.get(event) ?? []) h(...args); },
    /** 电脑进房。 */
    workerIn() {
      room.remoteParticipants.set(WBCH_WORKER_IDENTITY, { identity: WBCH_WORKER_IDENTITY });
      room.fire(EVENTS.ParticipantConnected);
    },
    /** 电脑从房里消失。`reason` 不给就是「livekit 没说」。 */
    workerOut(reason?: number) {
      room.remoteParticipants.delete(WBCH_WORKER_IDENTITY);
      room.fire(EVENTS.ParticipantDisconnected, { identity: WBCH_WORKER_IDENTITY }, reason);
    },
  };
  return room;
}

async function linked() {
  const rooms: ReturnType<typeof fakeRoom>[] = [];
  const sdk: WbchLivekitSdk = {
    Room: (function FakeRoom(this: unknown) { const r = fakeRoom(); rooms.push(r); return r as never; }) as never,
    RoomEvent: EVENTS,
  };
  const seen: { present: boolean; departure?: WbchWorkerDeparture }[] = [];
  const link = createWbchRoomLink({ loadSdk: async () => sdk, attachAudio: () => {}, detachAudio: () => {} });
  link.listen({ onWorker: (present, departure) => { seen.push({ present, ...(departure === undefined ? {} : { departure }) }); } });
  await link.acquire('rpc', CREDENTIAL);
  const room = rooms[0];
  if (room === undefined) throw new Error('假房间没建起来');
  return { link, room, seen };
}

describe('① 房间那一层:电脑上一次是怎么走的', () => {
  it('一次都没见过电脑(手机守在旧房里)→ unknown,不许说成睡着了', async () => {
    const { link } = await linked();
    expect(link.workerDeparture?.()).toBe('unknown');
  });

  it('★ 服务器把电脑那一方超时了(合盖睡过去)→ timeout', async () => {
    const { link, room, seen } = await linked();
    room.workerIn();
    room.workerOut(REASON.CONNECTION_TIMEOUT);
    expect(link.workerDeparture?.()).toBe('timeout');
    expect(seen).toEqual([{ present: true }, { present: false, departure: 'timeout' }]);
  });

  it('信令断了 / 媒体断了 → 也是 timeout(都是没说再见就消失)', async () => {
    for (const reason of [REASON.SIGNAL_CLOSE, REASON.MEDIA_FAILURE]) {
      const { link, room } = await linked();
      room.workerIn();
      room.workerOut(reason);
      expect(link.workerDeparture?.()).toBe('timeout');
    }
  });

  it('★ 电脑那一方自己走的(工作台退出)→ closed', async () => {
    const { link, room, seen } = await linked();
    room.workerIn();
    room.workerOut(REASON.CLIENT_INITIATED);
    expect(link.workerDeparture?.()).toBe('closed');
    expect(seen[1]).toEqual({ present: false, departure: 'closed' });
  });

  it('服务器说的是别的原因(被移除)→ unknown:它已经把话说清了,不许拿兜底那条去盖', async () => {
    const { link, room } = await linked();
    room.workerIn();
    room.workerOut(REASON.PARTICIPANT_REMOVED);
    expect(link.workerDeparture?.()).toBe('unknown');
  });

  it('★ livekit 没说原因,但见过电脑在这间房、我们自己连着,它却消失了 → timeout(唯一允许的那条兜底)', async () => {
    const { link, room } = await linked();
    room.workerIn();
    room.workerOut();
    expect(link.workerDeparture?.()).toBe('timeout');
  });

  it('没说原因、而且一次都没见过电脑 → unknown', async () => {
    const { link, room } = await linked();
    room.workerOut();
    expect(link.workerDeparture?.()).toBe('unknown');
  });

  it('★ 断的是我们自己这一头(重连 / 掉线 / 房间被搬走)→ unknown,不许说成电脑睡了', async () => {
    for (const event of [EVENTS.Reconnecting, EVENTS.Disconnected, EVENTS.Moved]) {
      const { link, room } = await linked();
      room.workerIn();
      // 真的 livekit 就是这个顺序:先把房里的人「消失」一遍,再说我们自己在重连 / 被搬走。
      room.workerOut();
      room.fire(event);
      expect(link.workerDeparture?.()).toBe('unknown');
    }
  });

  it('电脑又回来了 → 依据清零(在房里就没有「怎么走的」这回事)', async () => {
    const { link, room } = await linked();
    room.workerIn();
    room.workerOut(REASON.CONNECTION_TIMEOUT);
    room.workerIn();
    expect(link.workerDeparture?.()).toBe('unknown');
  });

  it('我们自己离房 → 依据清零', async () => {
    const { link, room } = await linked();
    room.workerIn();
    room.workerOut(REASON.CONNECTION_TIMEOUT);
    await link.release('rpc');
    expect(link.workerDeparture?.()).toBe('unknown');
  });

  it('房里别的设备走了不算数(另一台手机、那只听筒)', async () => {
    const { link, room } = await linked();
    room.workerIn();
    room.fire(EVENTS.ParticipantDisconnected, { identity: 'wb-handset-1' }, REASON.CONNECTION_TIMEOUT);
    expect(link.workerDeparture?.()).toBe('unknown');
  });
});

describe('② 通道层:依据进 presence.absent.departure', () => {
  const offline = (): ApiClient => ({
    baseUrl: 'http://10.0.0.9:8791',
    async json() { return { ok: false as const, status: 0, kind: 'network' as const, error: '连不上工作台' }; },
    async blob() { return { ok: false as const, status: 0, kind: 'network' as const, error: '连不上工作台' }; },
  });

  function channelWith(departure: WbchWorkerDeparture | undefined) {
    const link = createFakeLink();
    link.workerPresent = () => false;
    if (departure === undefined) delete (link as { workerDeparture?: unknown }).workerDeparture;
    else link.workerDeparture = () => departure;
    return createWbchChannel({
      direct: offline(),
      store: createWbchCredentialStore(memoryStore({ [WBCH_CREDENTIAL_KEY]: JSON.stringify(CREDENTIAL) })),
      onUnauthorized: () => {}, link, workerGraceMs: 1, absentRecheckMs: 60_000,
    });
  }

  it('★ 房里没有电脑 → absent 带上「怎么走的」', async () => {
    const channel = channelWith('timeout');
    const got = await channel.remote();
    expect(got).toEqual({ ok: false, error: WBCH_DESKTOP_NOT_IN_ROOM_TEXT });
    expect(channel.presence?.()).toMatchObject({ kind: 'absent', departure: 'timeout' });
  });

  it('老的假房间没有 workerDeparture → unknown(照旧口径)', async () => {
    const channel = channelWith(undefined);
    await channel.remote();
    expect(channel.presence?.()).toMatchObject({ kind: 'absent', departure: 'unknown' });
  });
});

describe('③ 首页那一句:按依据分三路', () => {
  it('★ 确知睡过去了 → 「电脑睡着了」,而且**不催她重新扫码**(房间是对的)', () => {
    const notice = relinkNotice({ connected: false, presence: 'absent', departure: 'timeout' });
    expect(notice).toEqual({ kind: 'asleep', title: RELINK_ASLEEP_TITLE, detail: RELINK_ASLEEP_DETAIL });
    expect(RELINK_ASLEEP_TITLE).toBe('电脑睡着了');
    expect(RELINK_ASLEEP_DETAIL).toBe('合盖或省电睡过去了,打开电脑就会自己连上。');
    expect(notice?.action).toBeUndefined();
  });

  it('★ 确知工作台自己退了 → 说工作台没在运行,也不催她扫码', () => {
    const notice = relinkNotice({ connected: false, presence: 'absent', departure: 'closed' });
    expect(notice).toEqual({ kind: 'quit', title: RELINK_QUIT_TITLE, detail: RELINK_QUIT_DETAIL });
    expect(RELINK_QUIT_DETAIL).toContain('在电脑上打开工作台');
    expect(notice?.action).toBeUndefined();
  });

  it('★ 没有依据 → 「连不上你的电脑:它可能睡着了或没联网」+ 原来那套(两种都说 + 重新扫码)', () => {
    for (const departure of ['unknown', undefined] as const) {
      const notice = relinkNotice({ connected: false, presence: 'absent', departure });
      expect(notice).toEqual({ kind: 'absent', title: RELINK_ABSENT_TITLE, detail: RELINK_ABSENT_DETAIL, action: RELINK_ACTION_LABEL });
      // 不许说成睡着了:只说「可能」。
      expect(notice?.title).toBe('连不上你的电脑');
      expect(notice?.detail).toContain('它可能睡着了或没联网');
      expect(notice?.title).not.toContain('睡着了');
      // 原来那两种可能一个都没丢。
      expect(notice?.detail).toContain('开机后会自己连上');
      expect(notice?.detail).toContain('重新扫码配对');
    }
  });

  it('令牌被撤那一路一个字没动', () => {
    for (const departure of ['timeout', 'closed', 'unknown', undefined] as const) {
      expect(relinkNotice({ connected: false, presence: 'revoked', departure })).toEqual({
        kind: 'revoked', title: RELINK_REVOKED_TITLE, detail: RELINK_REVOKED_DETAIL, action: RELINK_ACTION_LABEL,
      });
    }
    expect(RELINK_REVOKED_TITLE).toBe('电脑不认这台手机了');
  });

  it('连着 / 还不知道 / 电脑在房里 → 这一块不出(睡没睡都不出)', () => {
    expect(relinkNotice({ connected: true, presence: 'absent', departure: 'timeout' })).toBeNull();
    expect(relinkNotice({ connected: false, presence: 'unknown', departure: 'timeout' })).toBeNull();
    expect(relinkNotice({ connected: false, presence: 'present', departure: 'timeout' })).toBeNull();
    expect(relinkNotice({ connected: false, presence: undefined, departure: 'timeout' })).toBeNull();
  });
});

describe('④ 语音那一句跟上同一口径', () => {
  it('确知睡过去了 → 说睡着了;没有依据 → 照旧说「不在线」,不猜', () => {
    expect(asrOfflineText({ online: true, presence: { kind: 'absent', departure: 'timeout' } })).toBe(ASR_DESKTOP_ASLEEP_TEXT);
    expect(asrOfflineText({ online: true, presence: { kind: 'absent', departure: 'unknown' } })).toBe(ASR_DESKTOP_OFFLINE_TEXT);
    expect(asrOfflineText({ online: true, presence: { kind: 'absent' } })).toBe(ASR_DESKTOP_OFFLINE_TEXT);
    expect(asrOfflineText({ online: true, presence: { kind: 'unknown', departure: 'timeout' } })).toBe(ASR_OFFLINE_TEXT);
  });
});
