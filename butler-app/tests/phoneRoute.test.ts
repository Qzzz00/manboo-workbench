/**
 * 会话里的路线那一块(2026-10-21,局域网 M4):事实存在哪、从配对里种什么、出门线路有没有、驱动和通道层怎么接上。
 */
import { describe, expect, it } from 'vitest';
import { createPhoneRoute, routeFactsKey, seedRouteFacts } from '../src/channel/phoneRoute';
import { createWbchChannel } from '../src/channel/channel';
import { createWbchCredentialStore } from '../src/channel/credentialStore';
import type { RouteNetworkReading, RouteNetworkSource } from '../src/channel/routeDriver';
import type { AccountStore, AccountRecord } from '../src/account/accountStore';
import type { Pairing } from '../src/api/tokenStore';
import { createFakeLink, memoryStore } from './wbchFakes';

const MAC = 'aaaa1111bbbb2222cccc3333dddd4444';
const PAIRING: Pairing = { token: 'wbt_dev', host: '10.0.0.5', port: 8791, deviceId: 'd1', macId: MAC };
const HOME: RouteNetworkReading = { kind: 'wifi', id: 'lan:10.0.0.1/24', label: '网关 10.0.0.1' };

function network(start: RouteNetworkReading): RouteNetworkSource & { set(n: RouteNetworkReading): void } {
  const listeners = new Set<(n: RouteNetworkReading) => void>();
  let current = start;
  return {
    current: async () => current,
    subscribe: (l) => { listeners.add(l); return () => listeners.delete(l); },
    set(n) { current = n; for (const l of [...listeners]) l(n); },
  };
}

function accounts(record: AccountRecord | null): AccountStore {
  return { load: async () => record, save: async () => {}, setDeviceToken: async () => {}, link: async () => {}, clear: async () => {} };
}

/** 假 8791:`/channel/route` 与 `/channel/token`。 */
function fakeFetch(calls: string[]): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    if (url.endsWith('/channel/route')) {
      return new Response(JSON.stringify({ mac_id: MAC, room: 'wb-local-aaaa1111', lan_url: 'ws://10.0.0.5:7880', lan_addresses: ['10.0.0.5'], relay: { configured: true } }), { status: 200 });
    }
    if (url.endsWith('/channel/token')) {
      return new Response(JSON.stringify({ url: 'ws://10.0.0.5:7880', room: 'wb-local-aaaa1111', identity: 'wb-phone-d1', token: 'lan-jwt', expires_at: Math.floor(Date.now() / 1000) + 86400, route: 'lan' }), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
}

describe('从配对里种事实', () => {
  it('新配对(带机器 id):机器 id、配对地址、手上有本机令牌;出门线路现取', () => {
    expect(seedRouteFacts(PAIRING)).toEqual({
      kind: 'phone', mac_id: MAC, has_lan_token: true, has_relay: false,
      lan_urls: ['http://10.0.0.5:8791'], trusted_networks: [], declined_networks: [],
      tickets: { lan: null, cloud: null }, revoked: false,
    });
  });

  it('只走房间的配对(账号登录、没见过局域网):没有本机令牌、没有候选地址', () => {
    expect(seedRouteFacts({ token: '', host: '127.0.0.1', port: 1, deviceId: 'd1' })).toMatchObject({ has_lan_token: false, lan_urls: [], mac_id: null });
  });

  it('事实按设备分开存(重新扫码 = 新设备 = 从头来)', () => {
    expect(routeFactsKey('d1')).toBe('butler.route.facts:d1');
  });
});

describe('接起来走一遍', () => {
  it('新配对的第一次启动:配对那一刻的网络直接记成确认过 → 判在家 → 进本机房间', async () => {
    const kv = memoryStore();
    const calls: string[] = [];
    const link = createFakeLink();
    const net = network(HOME);
    const route = createPhoneRoute({ pairing: PAIRING, kv, accountStore: accounts(null), fetchImpl: fakeFetch(calls), network: net, browse: async () => [] });
    const channel = createWbchChannel({
      direct: route.routing.directAt('http://10.0.0.5:8791'),
      store: createWbchCredentialStore(kv),
      onUnauthorized: () => {},
      link,
      expectedIdentity: 'wb-phone-d1',
      routing: route.routing,
    });
    route.attach(channel);
    await route.driver.idle();
    expect(calls).toEqual(['GET http://10.0.0.5:8791/channel/route', 'POST http://10.0.0.5:8791/channel/token']);
    expect(route.driver.view().route).toBe('lan');
    expect(link.rooms).toEqual(['open ws://10.0.0.5:7880 wb-local-aaaa1111']);
    expect(JSON.parse(kv.map.get(routeFactsKey('d1'))!).trusted_networks).toEqual([HOME.id]);
    route.stop();
  });

  it('老配对(没机器 id)第一次启动:不把当时的网络当确认过(不知道那是不是配对时的网)', async () => {
    const kv = memoryStore();
    const net = network(HOME);
    const route = createPhoneRoute({ pairing: { ...PAIRING, macId: undefined } as Pairing, kv, accountStore: accounts(null), fetchImpl: fakeFetch([]), network: net, browse: async () => [] });
    const channel = createWbchChannel({ direct: route.routing.directAt('http://x'), store: createWbchCredentialStore(kv), onUnauthorized: () => {}, link: createFakeLink(), routing: route.routing });
    route.attach(channel);
    await route.driver.idle();
    expect(JSON.parse(kv.map.get(routeFactsKey('d1'))!).trusted_networks).toEqual([]);
    route.stop();
  });

  it('出门线路:登录了这台设备的账号就有;别的设备的账号记录不算', async () => {
    const own = createPhoneRoute({ pairing: PAIRING, kv: memoryStore(), accountStore: accounts({ relayUrl: 'https://r', deviceId: 'd1', deviceToken: 'wb_x' }), network: network(HOME) });
    await expect(own.hasRelay()).resolves.toBe(true);
    const other = createPhoneRoute({ pairing: PAIRING, kv: memoryStore(), accountStore: accounts({ relayUrl: 'https://r', deviceId: 'd0', deviceToken: 'wb_x' }), network: network(HOME) });
    await expect(other.hasRelay()).resolves.toBe(false);
  });

  it('通话中换了路(这一版续不上):告诉订阅的人', async () => {
    const route = createPhoneRoute({ pairing: PAIRING, kv: memoryStore(), accountStore: accounts(null), network: network(HOME) });
    const seen: (string | null)[] = [];
    route.onCallDropped((id) => seen.push(id));
    route.ports.callDropped?.('call-1');
    expect(seen).toEqual(['call-1']);
  });
});
