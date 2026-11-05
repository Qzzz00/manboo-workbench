/**
 * 会话里的路线那一块(2026-10-21,局域网 M4):把路线驱动(routeDriver.ts)、真去做事的手(routePorts.ts)、
 * 网络来源(networkWatch.ts)、通道层要的路线接口(channel.ts 的 WbchChannelRouting)拧在一起。session.ts 只调这一个。
 *
 *   - **事实存哪**:`butler.route.facts:<设备 id>`。重新扫码 = 新设备 id = 从头来(上一台 Mac 的机器 id、确认过的网络都不带过来)。
 *   - **从配对里种什么**:配对回包的机器 id(`Pairing.macId`)、配对地址(候选表第一个)、手上有没有 8791 的令牌。
 *     刚配对的会话第一次启动时,此刻的网络直接记成确认过(就是扫码那个网);老配对不替她确认(见 routeDriver.ts 的 `trustFirstNetwork`)。
 *   - **出门线路有没有**(规格的 `has_relay`,每一步现取):这台设备的账号登录着;或者手上那张云房间的票还能用(在房里由工人续);
 *     或者在家时电脑说它接了中转(那时没本机房间的电脑会替手机签云房间的票)。
 */
import { createApiClient } from '../api/client';
import type { KeyValueStore, Pairing } from '../api/tokenStore';
import type { AccountStore } from '../account/accountStore';
import { DEFAULT_RELAY_URL } from '../account/accountStore';
import { baseUrlOf } from '../pairing/pairUrl';
import type { WbchChannel, WbchChannelRouting } from './channel';
import { createWbchRouteCredentialStore } from './credentialStore';
import { createNetworkSource } from './networkWatch';
import { createRoutePorts } from './routePorts';
import {
  createRouteDriver,
  routeReasonText,
  type RouteDriver,
  type RouteDriverPorts,
  type RouteFactsStore,
  type RouteMdnsService,
  type RouteNetworkSource,
} from './routeDriver';
import { ROUTE_SPEC, type RouteFacts } from './routeSpec';

export const ROUTE_FACTS_KEY = 'butler.route.facts';

export function routeFactsKey(deviceId: string): string {
  return `${ROUTE_FACTS_KEY}:${deviceId}`;
}

/** 第一次启动(还没存过事实)时的起点。 */
export function seedRouteFacts(pairing: Pairing): RouteFacts {
  const lan = pairing.token !== '';
  return {
    kind: 'phone',
    mac_id: pairing.macId ?? null,
    has_lan_token: lan,
    has_relay: false,
    lan_urls: lan ? [baseUrlOf(pairing)] : [],
    trusted_networks: [],
    declined_networks: [],
    tickets: { lan: null, cloud: null },
    revoked: false,
  };
}

/** 读回来的事实形状不对(存坏了、老版本)就当没有:从配对重新种,不为一份坏文件把人困在「出门」。 */
function parseFacts(raw: string | null): RouteFacts | null {
  if (raw === null || raw === '') return null;
  try {
    const f = JSON.parse(raw) as Partial<RouteFacts>;
    const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');
    if (f.kind !== 'phone' || typeof f.has_lan_token !== 'boolean' || typeof f.has_relay !== 'boolean' || typeof f.revoked !== 'boolean') return null;
    if (!(f.mac_id === null || typeof f.mac_id === 'string')) return null;
    if (!strings(f.lan_urls) || !strings(f.trusted_networks) || !strings(f.declined_networks)) return null;
    if (typeof f.tickets !== 'object' || f.tickets === null) return null;
    return f as RouteFacts;
  } catch {
    return null;
  }
}

export function createRouteFactsStore(kv: KeyValueStore, deviceId: string): RouteFactsStore {
  const key = routeFactsKey(deviceId);
  return {
    load: async () => parseFacts(await kv.get(key).catch(() => null)),
    async save(facts) { try { await kv.set(key, JSON.stringify(facts)); } catch { /* 存不了下次再判 */ } },
  };
}

export interface PhoneRoute {
  driver: RouteDriver;
  /** 给通道层的那一份(createWbchChannel 的 `routing`)。 */
  routing: WbchChannelRouting;
  ports: RouteDriverPorts;
  /** 通道层建好之后接上并开始判。 */
  attach(channel: WbchChannel): void;
  /** 此刻有没有出门线路(规格 `has_relay`)。 */
  hasRelay(): Promise<boolean>;
  /** 通话中换了路、这一通续不上(卡 M9 之前):界面收场并提示回拨。 */
  onCallDropped(listener: (callId: string | null) => void): () => void;
  stop(): void;
}

/** 电脑明说不认这台手机时那句话(路线驱动从 `/channel/route` 的 401 判出来的)。 */
export const ROUTE_REVOKED_TEXT = '电脑不认这台手机了:到「设置 → 我的电脑」里退出登录,重新扫码配对';

export function createPhoneRoute(deps: {
  pairing: Pairing;
  kv: KeyValueStore;
  accountStore: AccountStore;
  fetchImpl?: typeof fetch;
  network?: RouteNetworkSource;
  browse?: (ms: number) => Promise<RouteMdnsService[]>;
  /** 手机包带的中转地址;缺省是 accountStore 里那个(开源构建为空)。 */
  relayUrl?: string;
}): PhoneRoute {
  const { pairing, kv } = deps;
  const credentials = createWbchRouteCredentialStore(kv);
  const dropped = new Set<(callId: string | null) => void>();
  let channel: WbchChannel | null = null;
  // 驱动建好之前就会有人问 http():先给一个「还没判」。
  let driverRef: RouteDriver | null = null;

  const routing: WbchChannelRouting = {
    store: credentials,
    directAt: (base) => createApiClient({
      pairing,
      baseUrl: () => base,
      // 是不是「不认这台手机」由驱动按机器 id 判,这里不触发回配对页。
      onUnauthorized: () => {},
      ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
    }),
    http: () => driverRef?.http().url ?? null,
    unavailable: () => (driverRef === null ? '正在判断在家还是出门…' : routeReasonText(driverRef.view())),
    nudge: () => driverRef?.tick(),
    renewed: (route, ticket) => driverRef?.ticketRenewed(route, ticket),
    callState: (active, callId) => driverRef?.callState(active, callId),
    roomLost: (route) => driverRef?.roomLost(route),
  };

  const ports = createRoutePorts({
    token: pairing.token,
    channel: {
      fetchRouteTicket: (route, from) => channel?.fetchRouteTicket?.(route, from) ?? Promise.resolve({ ok: false, error: '通道层还没接上' }),
      enterRoute: (route, url, room) => channel?.enterRoute?.(route, url, room) ?? Promise.resolve({ ok: false, error: '通道层还没接上' }),
      leaveRoute: async (route) => { await channel?.leaveRoute?.(route); },
    },
    ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
    ...(deps.browse === undefined ? {} : { browse: deps.browse }),
    onCallDropped: (callId) => { for (const l of [...dropped]) { try { l(callId); } catch { /* 一个订阅者抛不该拦住别人 */ } } },
    onRevoked: () => { channel?.markRevoked?.(ROUTE_REVOKED_TEXT); },
  });

  async function hasRelay(): Promise<boolean> {
    const account = await deps.accountStore.load().catch(() => null);
    if (account !== null && account.deviceToken !== undefined && (pairing.deviceId === '' || account.deviceId === pairing.deviceId)) return true;
    const cloud = await credentials.load('cloud').catch(() => null);
    if (cloud !== null && cloud.expires_at - Date.now() / 1000 >= ROUTE_SPEC.TICKET_MIN_LEFT_S) return true;
    return driverRef?.view().relayConfigured === true;
  }

  const driver = createRouteDriver({
    facts: createRouteFactsStore(kv, pairing.deviceId),
    seed: seedRouteFacts(pairing),
    network: deps.network ?? createNetworkSource(),
    ports,
    hasRelay,
    trustFirstNetwork: pairing.macId !== undefined,
    relayBuilt: (deps.relayUrl ?? DEFAULT_RELAY_URL) !== '',
  });
  driverRef = driver;

  return {
    driver,
    routing,
    ports,
    attach(next) {
      channel = next;
      void driver.start();
    },
    hasRelay,
    onCallDropped(listener) {
      dropped.add(listener);
      return () => { dropped.delete(listener); };
    },
    stop() {
      driver.stop();
      dropped.clear();
    },
  };
}
