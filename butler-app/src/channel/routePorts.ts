/**
 * 路线驱动(routeDriver.ts)真去做事的那几只手(2026-10-21,局域网 M4):
 *
 *   - **探测**:带设备令牌同时 `GET <url>/channel/route`,每个到点就掐(规格 800 ms)。这条**只在确认过的网络上**由规格发
 *     (没确认的网络上不带令牌问任何地址,只听 mDNS)。401 不是「回配对页」:别的 Mac 对这把令牌也回 401,
 *     是不是我那台撤了我,由回包里的 `mac_id` 判(规格 5.6),所以这里**不经** api/client.ts 那个会触发 onUnauthorized 的客户端;
 *   - **mDNS**:`_workbench._tcp`,TXT 的 `mac_id` 带上;同一时刻只听一份(两处同时要就合成一次);
 *   - **要票 / 进房 / 退房**:交给通道层(channel.ts 的路线那几样),票连令牌存在那边。
 */
import type { WbchChannel } from './channel';
import type { RouteDriverPorts, RouteMdnsService, RouteProbeAnswer } from './routeDriver';
import { startDiscovery } from '../pairing/discovery';

/**
 * `GET /channel/route` 的一次答复 → 规格要的那一条(M2 字段表 `workbench-plugin/src/server/channelWire.cases.json` 的 `route_lan`)。
 * `relay` 那一格:**整格缺席 = 这台 Mac 没接中转**(零服务器档,M7);`{configured: false}` = 接了、云房间这会儿还没好。
 */
export function parseRouteAnswer(url: string, status: number, body: unknown): RouteProbeAnswer {
  const b = typeof body === 'object' && body !== null && !Array.isArray(body) ? body as Record<string, unknown> : {};
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined);
  const macId = str(b.mac_id);
  if (status === 401) return { url, status: 'unauthorized', ...(macId === undefined ? {} : { mac_id: macId }) };
  if (status !== 200) return { url, status: 'error' };
  const lanUrl = str(b.lan_url);
  const room = str(b.room);
  const addresses = Array.isArray(b.lan_addresses) ? b.lan_addresses.filter((a): a is string => typeof a === 'string' && a !== '') : undefined;
  return {
    url,
    status: 'ok',
    ...(macId === undefined ? {} : { mac_id: macId }),
    ...(lanUrl === undefined ? {} : { lan_url: lanUrl }),
    ...(room === undefined ? {} : { room }),
    ...(addresses === undefined ? {} : { lan_addresses: addresses }),
    relay_configured: typeof b.relay === 'object' && b.relay !== null,
  };
}

export interface RoutePortsDeps {
  /** 8791 的设备令牌(只进请求头)。 */
  token: string;
  channel: Pick<WbchChannel, 'fetchRouteTicket' | 'enterRoute' | 'leaveRoute'>;
  fetchImpl?: typeof fetch;
  /** 听 mDNS。缺省是 capacitor-zeroconf(pairing/discovery.ts)。 */
  browse?: (ms: number) => Promise<RouteMdnsService[]>;
  onCallDropped?: (callId: string | null) => void;
  onRevoked?: () => void;
}

/** 缺省的 mDNS:听 `ms` 这么久,把看到的都报上来。插件不在(网页里)就是空表。 */
export async function browseWorkbenches(ms: number): Promise<RouteMdnsService[]> {
  const found = new Map<string, RouteMdnsService>();
  const handle = await startDiscovery({
    onFound: (w) => {
      const url = `http://${w.host.includes(':') ? `[${w.host}]` : w.host}:${w.port}`;
      found.set(url, { url, ...(w.macId === undefined ? {} : { mac_id: w.macId }), name: w.name });
    },
    onUnavailable: () => {},
  });
  await new Promise((resolve) => setTimeout(resolve, ms));
  await handle.stop().catch(() => {});
  return [...found.values()];
}

export function createRoutePorts(deps: RoutePortsDeps): RouteDriverPorts {
  const fetchImpl = deps.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const browse = deps.browse ?? browseWorkbenches;
  let browsing: Promise<RouteMdnsService[]> | null = null;

  async function probeOne(url: string, timeoutMs: number): Promise<RouteProbeAnswer> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(`${url}/channel/route`, {
        method: 'GET',
        headers: { authorization: `Bearer ${deps.token}` },
        signal: controller.signal,
      });
      let body: unknown = null;
      try { body = await res.json(); } catch { body = null; }
      return parseRouteAnswer(url, res.status, body);
    } catch {
      return { url, status: controller.signal.aborted ? 'timeout' : 'error' };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    probe: (urls, timeoutMs) => Promise.all(urls.map((u) => probeOne(u, timeoutMs))),

    browseMdns(ms) {
      if (browsing !== null) return browsing;
      browsing = browse(ms).catch(() => []).finally(() => { browsing = null; });
      return browsing;
    },

    async fetchTicket(route, _source, from) {
      if (deps.channel.fetchRouteTicket === undefined) return { ok: false, error: '通道层不认路线' };
      return deps.channel.fetchRouteTicket(route, from);
    },

    async join(route, url, room) {
      if (deps.channel.enterRoute === undefined) return { ok: false, error: '通道层不认路线' };
      return deps.channel.enterRoute(route, url, room);
    },

    async leave(route) {
      await deps.channel.leaveRoute?.(route);
    },

    callDropped: (callId) => deps.onCallDropped?.(callId),
    revoked: () => deps.onRevoked?.(),
  };
}
