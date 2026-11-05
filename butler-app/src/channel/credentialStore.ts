/**
 * 房间凭证的存取——「第二套配对」(2026-09-17)。
 *
 * 局域网配对存的是 `{host, port, token, deviceId}`(api/tokenStore.ts);
 * 那一份只有在同一个网里才有用。出门之后手机连的是**房间**,所以还要存一份:
 * 服务器地址 `url`、房间名、我的身份、进房 token 和它的到期时间。
 *
 * 取法:局域网二维码配对成功后**立刻**向 8791 要一次(POST /channel/token),存下来;
 * 之后出门就能用。快到期时经房间的数据通道 `{type:'renew'}` 换一张(见 rpc.ts),续到的存回这里。
 *
 * token 的规矩和设备令牌一样:**只在这里和进房那一下出现**,不打日志、不进 URL、不进任何出口。
 */
import type { KeyValueStore } from '../api/tokenStore.ts';

export interface WbchCredential {
  /** wss://lk.example.cn 之类。8791 签凭证时一起给,手机不自己拼。 */
  url: string;
  room: string;
  /** 服务端按设备令牌拼的 `wb-phone-<device_id>`,手机说了不算。 */
  identity: string;
  token: string;
  /** unix 秒。 */
  expires_at: number;
}

export interface WbchCredentialStore {
  load(): Promise<WbchCredential | null>;
  save(credential: WbchCredential): Promise<void>;
  clear(): Promise<void>;
}

export const WBCH_CREDENTIAL_KEY = 'butler.channel';

/**
 * 8791 的回包 / 房间里续到的那一条 → 一份凭证。字段缺一个就 null。
 * **不给缺省值**:地址猜错了会连到别人的服务器上去。
 */
export function parseWbchCredential(value: unknown, fallback?: Pick<WbchCredential, 'url' | 'room' | 'identity'>): WbchCredential | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const str = (raw: unknown, spare?: string): string | undefined => {
    if (typeof raw === 'string' && raw.trim() !== '') return raw.trim();
    return spare !== undefined && spare !== '' ? spare : undefined;
  };
  const url = str(v.url, fallback?.url);
  const room = str(v.room, fallback?.room);
  const identity = str(v.identity, fallback?.identity);
  const token = str(v.token);
  const expiresAt = v.expires_at;
  if (url === undefined || room === undefined || identity === undefined || token === undefined) return null;
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) return null;
  return { url, room, identity, token, expires_at: expiresAt };
}

export function createWbchCredentialStore(kv: KeyValueStore): WbchCredentialStore {
  return {
    async load() {
      try {
        const raw = await kv.get(WBCH_CREDENTIAL_KEY);
        if (raw === null || raw === '') return null;
        return parseWbchCredential(JSON.parse(raw));
      } catch {
        return null;
      }
    },
    async save(credential) {
      try { await kv.set(WBCH_CREDENTIAL_KEY, JSON.stringify(credential)); } catch { /* 存不了下次再取一张 */ }
    },
    async clear() {
      try { await kv.remove(WBCH_CREDENTIAL_KEY); } catch { /* 同上 */ }
    },
  };
}

/**
 * 两条路各一份票(2026-10-21,局域网 M4):本机房间(`lan`,8791 签,24 小时)、云房间(`cloud`,中转签,7 天)。
 * 键与路线同名。**局域网的票永不拿去试云房间**:分两格存,谁也不覆盖谁。
 */
export const WBCH_ROUTE_CREDENTIAL_KEYS = { lan: 'butler.channel.lan', cloud: 'butler.channel.cloud' } as const;

export type WbchRouteKey = keyof typeof WBCH_ROUTE_CREDENTIAL_KEYS;

export interface WbchRouteCredentialStore {
  load(route: WbchRouteKey): Promise<WbchCredential | null>;
  save(route: WbchRouteKey, credential: WbchCredential): Promise<void>;
  clear(route: WbchRouteKey): Promise<void>;
  /** 老版本那一份(`butler.channel`,一张通用票)。路线那两格都没有时搬过来。 */
  legacy(): Promise<WbchCredential | null>;
}

export function createWbchRouteCredentialStore(kv: KeyValueStore): WbchRouteCredentialStore {
  const read = async (key: string): Promise<WbchCredential | null> => {
    try {
      const raw = await kv.get(key);
      if (raw === null || raw === '') return null;
      return parseWbchCredential(JSON.parse(raw));
    } catch {
      return null;
    }
  };
  return {
    load: (route) => read(WBCH_ROUTE_CREDENTIAL_KEYS[route]),
    async save(route, credential) {
      try { await kv.set(WBCH_ROUTE_CREDENTIAL_KEYS[route], JSON.stringify(credential)); } catch { /* 存不了下次再取一张 */ }
    },
    async clear(route) {
      try { await kv.remove(WBCH_ROUTE_CREDENTIAL_KEYS[route]); } catch { /* 同上 */ }
    },
    legacy: () => read(WBCH_CREDENTIAL_KEY),
  };
}

/**
 * 这个房间地址是不是局域网里的(私网段、链路本地、100.64/10、`.local`、回环)。
 * 老版本那一张通用票按它分到 lan / cloud;8791 回包没写 `route` 时也按它认。口径与 8791 的 `isPrivateAddress` 同一张表。
 */
export function wbchIsLanUrl(url: string): boolean {
  let host: string;
  try { host = new URL(url).hostname.replace(/^\[|\]$/g, '').toLowerCase(); } catch { return false; }
  if (host === 'localhost' || host.endsWith('.local')) return true;
  const v4 = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4 !== null) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
      || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  }
  if (!host.includes(':')) return false;
  return host === '::1' || /^f[cd][0-9a-f]{0,2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host);
}
