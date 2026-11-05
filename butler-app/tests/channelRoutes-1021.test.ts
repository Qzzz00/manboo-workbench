/**
 * 通道层按路线进房(2026-10-21,局域网 M4)。
 *
 * 路线驱动(routeDriver.ts)判在家 / 出门,通道层管票与房间:
 *   - **两条路各一份票**(令牌也分开存):本机房间的票只向 8791 要,云房间的票向中转要(没账号才向 8791 兜一张云票);
 *     **局域网的票永不拿去试云**;
 *   - 进哪间由驱动说(`enterRoute`),同一条连接换房,持有(守铃、远程、通话)一起搬;
 *   - 守铃、远程、通话、发文件都用**当前路线**那张;没有路线时说驱动给的那句原因,不去碰任何房间。
 */
import { describe, expect, it } from 'vitest';
import type { ApiClient, ApiResult, RequestOptions } from '../src/api/client';
import { createWbchChannel, type WbchChannelRouting } from '../src/channel/channel';
import {
  WBCH_CREDENTIAL_KEY,
  WBCH_ROUTE_CREDENTIAL_KEYS,
  createWbchCredentialStore,
  createWbchRouteCredentialStore,
  wbchIsLanUrl,
  type WbchCredential,
} from '../src/channel/credentialStore';
import type { RelayRoomSource } from '../src/account/roomFromRelay';
import type { RoomRoute, RouteTicket } from '../src/channel/routeSpec';
import { createFakeLink, lastSent, memoryStore } from './wbchFakes';

const HOME = 'http://10.0.0.5:8791';
const LAN: WbchCredential = { url: 'ws://10.0.0.5:7880', room: 'wb-local-aaaa1111', identity: 'wb-phone-d1', token: 'lan-jwt', expires_at: 2_000_000_000 };
const CLOUD: WbchCredential = { url: 'wss://lk.example.cn', room: 'wb-cloud', identity: 'wb-phone-d1', token: 'cloud-jwt', expires_at: 2_000_000_000 };

function directAt(answers: Record<string, () => ApiResult<unknown>>, calls: string[]): (base: string) => ApiClient {
  return (base) => ({
    baseUrl: base,
    async json(path: string, options: RequestOptions = {}) {
      calls.push(`${options.method ?? 'GET'} ${base}${path}`);
      const answer = answers[base];
      return (answer === undefined ? { ok: false, status: 0, kind: 'network', error: '连不上' } : answer()) as ApiResult<never>;
    },
    async blob() { return { ok: false, status: 0, kind: 'network', error: 'x' } as ApiResult<Blob>; },
  });
}

function wire(options: {
  answers?: Record<string, () => ApiResult<unknown>>;
  relay?: RelayRoomSource;
  stored?: Record<string, string>;
  http?: string | null;
} = {}) {
  const kv = memoryStore(options.stored ?? {});
  const link = createFakeLink();
  const calls: string[] = [];
  const told: string[] = [];
  const renewed: { route: RoomRoute; ticket: RouteTicket }[] = [];
  const routing: WbchChannelRouting = {
    store: createWbchRouteCredentialStore(kv),
    directAt: directAt(options.answers ?? { [HOME]: () => ({ ok: true, status: 200, data: { ...LAN, route: 'lan' } }) }, calls),
    http: () => (options.http === undefined ? HOME : options.http),
    unavailable: () => '用的是移动网络,这台没接中转',
    nudge: () => { told.push('nudge'); },
    renewed: (route, ticket) => { renewed.push({ route, ticket }); },
    callState: (active, callId) => { told.push(`call ${active} ${callId ?? '-'}`); },
    roomLost: (route) => { told.push(`lost ${route}`); },
  };
  const channel = createWbchChannel({
    direct: directAt({}, calls)('http://unused:8791'),
    store: createWbchCredentialStore(kv),
    onUnauthorized: () => { told.push('unauthorized'); },
    link,
    name: 'Ben 的手机',
    expectedIdentity: 'wb-phone-d1',
    routing,
    ...(options.relay === undefined ? {} : { relay: options.relay }),
  });
  return { kv, link, calls, told, renewed, channel };
}

const relayOk: RelayRoomSource = { credential: async () => ({ ok: true, credential: CLOUD }) };
const relayNone: RelayRoomSource = { credential: async () => null };

describe('票按路线分存', () => {
  it('本机房间的票向 8791 要,存进 lan 那一格;云房间的票向中转要,存进 cloud 那一格', async () => {
    const { channel, kv, calls } = wire({ relay: relayOk });
    await expect(channel.fetchRouteTicket!('lan', HOME)).resolves.toEqual({ ok: true, ticket: { url: LAN.url, room: LAN.room, expires_at: LAN.expires_at } });
    expect(calls).toEqual([`POST ${HOME}/channel/token`]);
    await expect(channel.fetchRouteTicket!('cloud', null)).resolves.toEqual({ ok: true, ticket: { url: CLOUD.url, room: CLOUD.room, expires_at: CLOUD.expires_at } });
    expect(JSON.parse(kv.map.get(WBCH_ROUTE_CREDENTIAL_KEYS.lan)!)).toEqual(LAN);
    expect(JSON.parse(kv.map.get(WBCH_ROUTE_CREDENTIAL_KEYS.cloud)!)).toEqual(CLOUD);
  });

  it('8791 这会儿只签得出云房间的票(没本机钥匙):不当本机票存', async () => {
    const { channel, kv } = wire({ answers: { [HOME]: () => ({ ok: true, status: 200, data: { ...CLOUD, route: 'relay' } }) } });
    const got = await channel.fetchRouteTicket!('lan', HOME);
    expect(got.ok).toBe(false);
    expect(kv.map.has(WBCH_ROUTE_CREDENTIAL_KEYS.lan)).toBe(false);
  });

  it('没登录账号:云房间的票向判到的那台 8791 兜一张(它签的是中转的票);本机票不算', async () => {
    const { channel, kv } = wire({ relay: relayNone, answers: { [HOME]: () => ({ ok: true, status: 200, data: { ...CLOUD, route: 'relay' } }) } });
    const got = await channel.fetchRouteTicket!('cloud', HOME);
    expect(got.ok).toBe(true);
    expect(JSON.parse(kv.map.get(WBCH_ROUTE_CREDENTIAL_KEYS.cloud)!)).toEqual(CLOUD);
    const lanOnly = wire({ relay: relayNone });
    expect((await lanOnly.channel.fetchRouteTicket!('cloud', HOME)).ok).toBe(false);
    expect(lanOnly.kv.map.has(WBCH_ROUTE_CREDENTIAL_KEYS.cloud)).toBe(false);
  });

  it('8791 对本机票回 401:电脑明说不认这台手机 —— 记下,之后不再打网络', async () => {
    const { channel, calls } = wire({ answers: { [HOME]: () => ({ ok: false, status: 401, kind: 'unauthorized', error: '设备令牌已失效' }) } });
    await expect(channel.fetchRouteTicket!('lan', HOME)).resolves.toEqual({ ok: false, error: '设备令牌已失效', revoked: true });
    expect(channel.presence?.().kind).toBe('revoked');
    calls.length = 0;
    await channel.fetchRouteTicket!('cloud', HOME);
    expect(calls).toEqual([]);
  });

  it('老版本那一份(`butler.channel`)按地址认路线搬过来:局域网地址进 lan,别的进 cloud', async () => {
    expect(wbchIsLanUrl('ws://10.0.0.5:7880')).toBe(true);
    expect(wbchIsLanUrl('ws://192.168.1.8:7880')).toBe(true);
    expect(wbchIsLanUrl('ws://mac.local:7880')).toBe(true);
    expect(wbchIsLanUrl('wss://lk.aibooo.cn')).toBe(false);
    const { channel } = wire({ stored: { [WBCH_CREDENTIAL_KEY]: JSON.stringify(CLOUD) } });
    await channel.enterRoute!('cloud', CLOUD.url, CLOUD.room);
    expect(channel.credential()).toEqual(CLOUD);
  });

  it('身份对不上的(上一次配对留下的)不认', async () => {
    const { channel } = wire({ stored: { [WBCH_ROUTE_CREDENTIAL_KEYS.cloud]: JSON.stringify({ ...CLOUD, identity: 'wb-phone-old' }) } });
    await expect(channel.enterRoute!('cloud', CLOUD.url, CLOUD.room)).resolves.toEqual({ ok: false, error: '这条路还没有票' });
  });
});

describe('进哪间房由路线说', () => {
  it('还没判出路线:守铃不进任何房,说驱动给的那句原因', async () => {
    const { channel, link, told } = wire({ relay: relayOk });
    await expect(channel.holdForRing()).resolves.toEqual({ ok: false, error: '用的是移动网络,这台没接中转' });
    expect(link.rooms).toEqual([]);
    expect(told).toContain('nudge');
  });

  it('进本机房间;守铃跟着进同一间;再换到云房间是同一条连接换房,持有不变', async () => {
    const { channel, link } = wire({ relay: relayOk });
    await channel.fetchRouteTicket!('lan', HOME);
    await expect(channel.enterRoute!('lan', LAN.url, LAN.room)).resolves.toEqual({ ok: true });
    await expect(channel.holdForRing()).resolves.toEqual({ ok: true });
    expect(link.rooms).toEqual([`open ${LAN.url} ${LAN.room}`]);
    expect(channel.route!()).toBe('lan');
    expect(channel.credential()).toEqual(LAN);

    await channel.fetchRouteTicket!('cloud', null);
    await expect(channel.enterRoute!('cloud', CLOUD.url, CLOUD.room)).resolves.toEqual({ ok: true });
    expect(link.rooms).toEqual([`open ${LAN.url} ${LAN.room}`, `switch ${CLOUD.url} ${CLOUD.room}`]);
    expect([...link.holders].sort()).toEqual(['ring', 'route']);
    expect(channel.credential()).toEqual(CLOUD);
    // 驱动随后说退本机房间:已经换走了,什么都不做
    await channel.leaveRoute!('lan');
    expect(link.rooms.slice(-1)[0]).toBe(`switch ${CLOUD.url} ${CLOUD.room}`);
  });

  it('换去本机房间没进上:回到原来那间(不让电话落空),告诉驱动没进上', async () => {
    const { channel, link, told } = wire({ relay: relayOk });
    await channel.fetchRouteTicket!('cloud', null);
    await channel.enterRoute!('cloud', CLOUD.url, CLOUD.room);
    await channel.fetchRouteTicket!('lan', HOME);
    link.failNextSwitch('连不上 7880');
    const got = await channel.enterRoute!('lan', LAN.url, LAN.room);
    expect(got.ok).toBe(false);
    expect(link.rooms.slice(-1)[0]).toBe(`switch ${CLOUD.url} ${CLOUD.room}`);
    expect(channel.route!()).toBe('cloud');
    expect(told).not.toContain('lost cloud');
  });

  it('两条都停(没路 / 撤销):退房,持有照记;之后守铃不再进房', async () => {
    const { channel, link } = wire({ relay: relayOk });
    await channel.fetchRouteTicket!('lan', HOME);
    await channel.enterRoute!('lan', LAN.url, LAN.room);
    await channel.holdForRing();
    await channel.leaveRoute!('lan');
    expect(link.rooms.slice(-1)[0]).toBe('detach');
    expect(channel.route!()).toBeNull();
    expect((await channel.holdForRing()).ok).toBe(false);
    expect(link.rooms.slice(-1)[0]).toBe('detach');
  });

  it('熄屏时听铃交给了原生(网页停靠着),路线换了:网页收回来进新房,原生那条随后由 ringHandoff 放手', async () => {
    const { channel, link } = wire({ relay: relayOk });
    await channel.fetchRouteTicket!('lan', HOME);
    await channel.enterRoute!('lan', LAN.url, LAN.room);
    const unparked: string[] = [];
    let parked = true;
    Object.assign(link, {
      parked: () => parked,
      unpark: async (c: WbchCredential) => { parked = false; unparked.push(`${c.url} ${c.room}`); },
    });
    await channel.fetchRouteTicket!('cloud', null);
    await expect(channel.enterRoute!('cloud', CLOUD.url, CLOUD.room)).resolves.toEqual({ ok: true });
    expect(unparked).toEqual([`${CLOUD.url} ${CLOUD.room}`]);
    expect(channel.credential()).toEqual(CLOUD);
  });

  it('远程代办(出门时 HTTP 经房间)用当前路线那张进房', async () => {
    const { channel, link } = wire({ relay: relayOk });
    await channel.fetchRouteTicket!('cloud', null);
    await channel.enterRoute!('cloud', CLOUD.url, CLOUD.room);
    const remote = await channel.remote();
    expect(remote.ok).toBe(true);
    expect(link.holders.has('rpc')).toBe(true);
    expect(link.rooms).toEqual([`open ${CLOUD.url} ${CLOUD.room}`]);
  });

  it('房间自己掉了(不是我们换房 / 退房):告诉驱动', async () => {
    const { channel, link, told } = wire({ relay: relayOk });
    await channel.fetchRouteTicket!('lan', HOME);
    await channel.enterRoute!('lan', LAN.url, LAN.room);
    link.setState('closed');
    expect(told).toContain('lost lan');
  });
});

describe('通话与续期', () => {
  it('通话中换了房(出了家门):旧房那一通就此断了,告诉通话那一层(续上是卡 M9)', async () => {
    const { channel } = wire({ relay: relayOk });
    await channel.fetchRouteTicket!('lan', HOME);
    await channel.enterRoute!('lan', LAN.url, LAN.room);
    await channel.acquireCall();
    let dropped = 0;
    channel.onCallDropped!(() => { dropped += 1; });
    await channel.fetchRouteTicket!('cloud', null);
    await channel.enterRoute!('cloud', CLOUD.url, CLOUD.room);
    expect(dropped).toBe(1);
  });

  it('不在通话里换房:不报', async () => {
    const { channel } = wire({ relay: relayOk });
    await channel.fetchRouteTicket!('lan', HOME);
    await channel.enterRoute!('lan', LAN.url, LAN.room);
    let dropped = 0;
    channel.onCallDropped!(() => { dropped += 1; });
    await channel.fetchRouteTicket!('cloud', null);
    await channel.enterRoute!('cloud', CLOUD.url, CLOUD.room);
    expect(dropped).toBe(0);
  });

  it('通话起止告诉驱动(接起的那一通带 call_id,换路时 M9 要它)', async () => {
    const { channel, told, link } = wire({ relay: relayOk });
    await channel.fetchRouteTicket!('lan', HOME);
    await channel.enterRoute!('lan', LAN.url, LAN.room);
    const answering = channel.answerCall('call-9');
    await new Promise((r) => setTimeout(r, 0));
    link.deliver({ id: lastSent(link).id, type: 'call', ok: true });
    await answering;
    await channel.acquireCall();
    await channel.releaseCall();
    expect(told.filter((t) => t.startsWith('call'))).toEqual(['call true call-9', 'call false -']);
  });

  it('自己拨出去的那一通:进房后报了编号,也告诉驱动(换路时续上同一通要它)', async () => {
    const { channel, told, link } = wire({ relay: relayOk });
    await channel.fetchRouteTicket!('lan', HOME);
    await channel.enterRoute!('lan', LAN.url, LAN.room);
    await channel.acquireCall();
    const starting = channel.callStart('out-1');
    await new Promise((r) => setTimeout(r, 0));
    link.deliver({ id: lastSent(link).id, type: 'call', ok: true });
    await starting;
    expect(told.filter((t) => t.startsWith('call'))).toEqual(['call true -', 'call true out-1']);
  });

  it('房里续期:新票存回当前路线那一格,回包带地址就用新地址;告诉驱动', async () => {
    const { channel, link, kv, renewed } = wire({ relay: relayOk });
    await channel.fetchRouteTicket!('lan', HOME);
    await channel.enterRoute!('lan', LAN.url, LAN.room);
    const pending = channel.renewNow();
    await new Promise((r) => setTimeout(r, 0));
    const sent = lastSent(link);
    link.deliver({ id: sent.id, type: 'token', token: 'lan-jwt-2', expires_at: 2_100_000_000, url: 'ws://10.0.0.6:7880', room: LAN.room, route: 'lan' });
    await expect(pending).resolves.toEqual({ ok: true });
    expect(JSON.parse(kv.map.get(WBCH_ROUTE_CREDENTIAL_KEYS.lan)!)).toEqual({ ...LAN, token: 'lan-jwt-2', expires_at: 2_100_000_000, url: 'ws://10.0.0.6:7880' });
    expect(renewed).toEqual([{ route: 'lan', ticket: { url: 'ws://10.0.0.6:7880', room: LAN.room, expires_at: 2_100_000_000 } }]);
  });
});
