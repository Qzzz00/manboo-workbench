/**
 * mDNS 发现 `_workbench._tcp`(工作台开了「允许手机在局域网访问」才广播;TXT 里有 port / name / v,局域网 M2 起还有 mac_id)。
 *
 * 安卓走 capacitor-zeroconf(jmDNS,只在本地多播,不出站;审计见 docs/superpowers/research/审计-capacitor-zeroconf-2026-09-14.md)。
 * 网页/插件不可用时调 onUnavailable,界面直接给扫码 / 手输。
 */
import type { DiscoveredWorkbench } from './pairingMachine';

export interface DiscoveryHandle {
  stop(): Promise<void>;
}

export interface DiscoveryCallbacks {
  onFound(workbench: DiscoveredWorkbench): void;
  onUnavailable(reason: string): void;
}

export const WORKBENCH_SERVICE_TYPE = '_workbench._tcp.';

interface ZeroconfServiceLike {
  name: string;
  port: number;
  hostname?: string;
  ipv4Addresses?: string[];
  txtRecord?: Record<string, string>;
}

/** 把 zeroconf 的一条 resolved 记录变成我们的目标。IPv4 优先;TXT 的 port 优先于服务端口(两者应当一致)。 */
export function workbenchFromService(service: ZeroconfServiceLike): DiscoveredWorkbench | null {
  const host = service.ipv4Addresses?.find((ip) => ip !== '' && !ip.startsWith('169.254.'))
    ?? (service.hostname && service.hostname !== '' ? service.hostname.replace(/\.$/, '') : undefined);
  if (host === undefined) return null;
  const txtPort = Number(service.txtRecord?.port);
  const port = Number.isInteger(txtPort) && txtPort > 0 ? txtPort : service.port;
  if (!Number.isInteger(port) || port <= 0) return null;
  const name = service.txtRecord?.name && service.txtRecord.name !== '' ? service.txtRecord.name : service.name;
  const version = service.txtRecord?.v;
  const macId = service.txtRecord?.mac_id;
  return {
    name, host, port,
    ...(version === undefined || version === '' ? {} : { version }),
    ...(macId === undefined || macId === '' ? {} : { macId }),
  };
}

export async function startDiscovery(callbacks: DiscoveryCallbacks): Promise<DiscoveryHandle> {
  let ZeroConf: {
    watch(req: { type: string; domain: string }, cb: (r: { action: string; service: ZeroconfServiceLike } | undefined) => void): Promise<string>;
    unwatch(req: { type: string; domain: string }): Promise<void>;
    close(): Promise<void>;
  };
  try {
    const mod = await import('capacitor-zeroconf');
    ZeroConf = mod.ZeroConf as unknown as typeof ZeroConf;
  } catch (error) {
    callbacks.onUnavailable(error instanceof Error ? error.message : '插件不可用');
    return { stop: async () => {} };
  }
  const request = { type: WORKBENCH_SERVICE_TYPE, domain: 'local.' };
  try {
    await ZeroConf.watch(request, (result) => {
      // 安卓插件 watch 挂上那一下会先回一个空结果(Pixel / Android 17 上每次都有)。
      if (result?.action !== 'resolved') return;
      const workbench = workbenchFromService(result.service);
      if (workbench !== null) callbacks.onFound(workbench);
    });
  } catch (error) {
    callbacks.onUnavailable(error instanceof Error ? error.message : String(error));
    return { stop: async () => {} };
  }
  return {
    async stop() {
      try { await ZeroConf.unwatch(request); } catch { /* 已经停了 */ }
    },
  };
}
