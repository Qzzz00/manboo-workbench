/**
 * 手机此刻在哪个网络上(2026-10-21,局域网 M4)。路线驱动(routeDriver.ts)靠它判在家 / 出门:
 *
 *   - **原生网络回调**(`android/.../NetworkWatchPlugin.java`,`ConnectivityManager` 的缺省网络回调):Wi-Fi 换了、切到 4G、
 *     断网,当场来一声 —— 不再只靠浏览器的 `online` / `connection.change`(那两样在 WebView 里来得晚、有时不来);
 *   - **网络标识**:安卓读 Wi-Fi 名要定位权限,这个 App 不要定位(manifest 那一段写了为什么)。所以标识取**这个网络的网关地址 +
 *     网段 + DNS 域名**(`lan:192.168.1.1/24`);读得到 Wi-Fi 名(老系统上碰巧有定位权限)也只拿来给人看。
 *     代价:两处网关地址一样的网络认成同一个 —— 判在家另有一条「答话的是配对过的那台 Mac」兜着(规格第二节),
 *     最坏是在那个网络上把设备令牌带去问了候选表里那几个地址;
 *   - **Android 17 的本地网络权限**(`ACCESS_LOCAL_NETWORK`):没有它连局域网一律失败。给了就不问;系统说「还要问」时才问
 *     (manifest 写上之后 targetSdk 36 的包也会走到这一步;10-22 真机上系统当场给了、没弹框),拒了按出门走。
 *
 * 网页里(浏览器调试、没有原生插件)退回浏览器那两样事件,标识一律读不到(按出门走)。
 */
import { registerPlugin } from '@capacitor/core';
import type { RouteNetworkReading, RouteNetworkSource } from './routeDriver';

/** 原生那一份读数。`local: not_needed` = 这台系统没有本地网络权限这回事(Android 17 以前)。 */
export interface NativeNetworkReading {
  kind: 'wifi' | 'ethernet' | 'cellular' | 'none';
  id?: string | null;
  label?: string | null;
  local?: 'granted' | 'denied' | 'prompt' | 'not_needed';
}

export interface NetworkWatchNative {
  current(): Promise<NativeNetworkReading>;
  requestLocalNetwork(): Promise<{ local: NativeNetworkReading['local'] }>;
  addListener(event: 'change', listener: (reading: NativeNetworkReading) => void): Promise<{ remove(): Promise<void> }>;
}

/** 原生读数 → 驱动要的那一份。读坏了的格子当没有。 */
export function readingFromNative(raw: NativeNetworkReading | null | undefined): RouteNetworkReading {
  if (raw === null || raw === undefined || typeof raw !== 'object') return { kind: 'none', id: null };
  const kind = raw.kind === 'wifi' || raw.kind === 'ethernet' || raw.kind === 'cellular' ? raw.kind : 'none';
  const id = typeof raw.id === 'string' && raw.id !== '' ? raw.id : null;
  const label = typeof raw.label === 'string' && raw.label !== '' ? raw.label : undefined;
  const local = raw.local === 'granted' || raw.local === 'denied' || raw.local === 'prompt' ? raw.local : undefined;
  return { kind, id: kind === 'cellular' || kind === 'none' ? null : id, ...(label === undefined ? {} : { label }), ...(local === undefined ? {} : { local }) };
}

/** 浏览器那两样(网页调试、没有原生插件):只分得出有没有网、大概是什么网;标识读不到。 */
export function webNetworkReading(): RouteNetworkReading {
  if (typeof navigator === 'undefined') return { kind: 'none', id: null };
  if (navigator.onLine === false) return { kind: 'none', id: null };
  const type = (navigator as Navigator & { connection?: { type?: string } }).connection?.type;
  if (type === 'cellular') return { kind: 'cellular', id: null };
  if (type === 'ethernet') return { kind: 'ethernet', id: null };
  return { kind: 'wifi', id: null };
}

function webSubscribe(listener: (n: RouteNetworkReading) => void): () => void {
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return () => {};
  const fire = (): void => listener(webNetworkReading());
  const connection = (typeof navigator === 'undefined' ? undefined : (navigator as Navigator & { connection?: EventTarget }).connection);
  window.addEventListener('online', fire);
  window.addEventListener('offline', fire);
  try { connection?.addEventListener?.('change', fire); } catch { /* 老内核没有 */ }
  return () => {
    window.removeEventListener('online', fire);
    window.removeEventListener('offline', fire);
    try { connection?.removeEventListener?.('change', fire); } catch { /* 同上 */ }
  };
}

const nativePlugin = registerPlugin<NetworkWatchNative>('NetworkWatch');

/**
 * 给路线驱动的网络来源。原生插件在就用它;调它抛了(网页里、老包没登记)就退回浏览器那两样。
 * 测试注入 `plugin`(或 `null` = 当没有原生插件)。
 */
export function createNetworkSource(deps: { plugin?: NetworkWatchNative | null } = {}): RouteNetworkSource {
  const plugin = deps.plugin === undefined ? nativePlugin : deps.plugin;
  let native: boolean | null = plugin === null ? false : null;

  async function current(): Promise<RouteNetworkReading> {
    if (native !== false && plugin !== null) {
      try {
        const reading = readingFromNative(await plugin.current());
        native = true;
        return reading;
      } catch {
        native = false;
      }
    }
    return webNetworkReading();
  }

  return {
    current,

    subscribe(listener) {
      let remove: (() => void) | null = null;
      let cancelled = false;
      void (async () => {
        await current();
        if (cancelled) return;
        if (native === true && plugin !== null) {
          try {
            const handle = await plugin.addListener('change', (raw) => listener(readingFromNative(raw)));
            if (cancelled) { void handle.remove(); return; }
            remove = () => { void handle.remove(); };
            return;
          } catch { /* 退回浏览器那两样 */ }
        }
        remove = webSubscribe(listener);
        if (cancelled) remove();
      })();
      return () => { cancelled = true; remove?.(); };
    },

    async ensureLocal() {
      if (native !== true || plugin === null) return 'granted';
      try {
        const got = await plugin.requestLocalNetwork();
        return got.local === 'denied' || got.local === 'prompt' ? 'denied' : 'granted';
      } catch {
        return 'denied';
      }
    },
  };
}
