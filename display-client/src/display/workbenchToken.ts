/**
 * 展示台访问工作台 8791 用的设备令牌(2026-09-11 手机配对与设备令牌)。
 *
 * 服务端从这一版起对**非本机**来源的 /live 订阅也认令牌;本机来源(开发机上自己连自己)免令牌。
 * 展示台是浏览器环境,WebSocket 设不了请求头,所以令牌走 `?token=` 查询串——服务端只在 /live 的
 * 升级请求上认这种写法。
 *
 * 来源优先级:URL `?token=`(扫码/调试时一次性带进来,顺手存起来) > localStorage。
 * 拿令牌的方式:工作台设置里生成 6 位配对码,展示台上输码 → POST /pair/claim → 存起来 → 重连。
 * 令牌只存在这台设备的 localStorage 里,不进 URL 以外的任何出口,也不打日志。
 *
 * 与 holoPair.ts 的 `?pair=`(Stackchan 对 Aiboo 云端的配对码)**无关**——那条链路照旧。
 */
export const WORKBENCH_TOKEN_KEY = 'workbench.token';

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/** URL ?token= 优先并落到存储;否则读存储;都没有就是 null。存储不可用(隐私模式)也不抛。 */
export function resolveWorkbenchToken(search: string, storage: StorageLike | undefined): string | null {
  const fromUrl = new URLSearchParams(search).get('token');
  if (fromUrl !== null && fromUrl !== '') {
    try { storage?.setItem(WORKBENCH_TOKEN_KEY, fromUrl); } catch { /* 存不了就只用这一次 */ }
    return fromUrl;
  }
  try {
    const stored = storage?.getItem(WORKBENCH_TOKEN_KEY) ?? null;
    return stored === '' ? null : stored;
  } catch {
    return null;
  }
}

export function saveWorkbenchToken(storage: StorageLike | undefined, token: string): void {
  try { storage?.setItem(WORKBENCH_TOKEN_KEY, token); } catch { /* 同上 */ }
}

export function clearWorkbenchToken(storage: StorageLike | undefined): void {
  try { storage?.removeItem(WORKBENCH_TOKEN_KEY); } catch { /* 同上 */ }
}

/** 工作台地址是不是本机回环——是的话服务端不看令牌,这里也不必带。 */
export function isLoopbackWorkbench(wsUrl: string): boolean {
  try {
    return LOOPBACK_HOSTS.has(new URL(wsUrl).hostname);
  } catch {
    return false;
  }
}

/** 把令牌挂到 /live 地址上。回环地址或没有令牌就原样返回。 */
export function withWorkbenchToken(wsUrl: string, token: string | null): string {
  if (token === null || token === '' || isLoopbackWorkbench(wsUrl)) return wsUrl;
  try {
    const url = new URL(wsUrl);
    url.searchParams.set('token', token);
    return url.toString();
  } catch {
    return wsUrl;
  }
}

/** ws(s)://host:port/live → http(s)://host:port(配对与其它 HTTP 接口的基址)。 */
export function workbenchHttpBase(wsUrl: string): string {
  const url = new URL(wsUrl);
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
  url.pathname = '';
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

export type ClaimOutcome = { ok: true; token: string; deviceId: string } | { ok: false; error: string };

/** 拿 6 位配对码去换令牌。服务端的话原样转达(「配对码不对或已失效」「连续错 5 次…」),不自己编。 */
export async function claimWorkbenchToken(
  fetchImpl: typeof fetch,
  wsUrl: string,
  code: string,
  deviceName: string,
): Promise<ClaimOutcome> {
  let res: Response;
  try {
    res = await fetchImpl(`${workbenchHttpBase(wsUrl)}/pair/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: code.trim(), device_name: deviceName, platform: 'android' }),
    });
  } catch {
    return { ok: false, error: '连不上工作台:确认设置里「允许手机在局域网访问」已打开' };
  }
  let body: { ok?: boolean; token?: string; device_id?: string; error?: string } = {};
  try { body = await res.json(); } catch { /* 空 body 按失败处理 */ }
  if (!res.ok || typeof body.token !== 'string' || typeof body.device_id !== 'string') {
    return { ok: false, error: body.error ?? `配对失败(${res.status})` };
  }
  return { ok: true, token: body.token, deviceId: body.device_id };
}
