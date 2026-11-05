/**
 * 手机的路线驱动(局域网 M4):把 routeSpec 的纯函数接到真东西上 —— 网络回调、探测、mDNS、要票、进房、提示。
 * 规格本身的对错由 routeSpec.test.ts 那 26 条管;这里只核「驱动照动作做了、把结果喂回去了、事实存下来了」。
 */
import { describe, expect, it } from 'vitest';
import {
  createRouteDriver,
  routeReasonText,
  type RouteDriverPorts,
  type RouteNetworkReading,
  type RouteNetworkSource,
  type RouteProbeAnswer,
} from '../src/channel/routeDriver';
import type { MdnsService, RouteFacts, RoomRoute, RouteTicket } from '../src/channel/routeSpec';

const MAC = 'aaaa1111bbbb2222cccc3333dddd4444';
const HOME = 'http://10.0.0.5:8791';
const LAN_URL = 'ws://10.0.0.5:7880';
const LAN_ROOM = 'wb-local-aaaa1111';
const CLOUD: RouteTicket = { url: 'wss://lk.example.cn', room: 'wb-cloud', expires_at: 2_000_000_000 };
const HOME_WIFI: RouteNetworkReading = { kind: 'wifi', id: 'lan:10.0.0.1/24', label: '网关 10.0.0.1', local: 'granted' };
const CAFE_WIFI: RouteNetworkReading = { kind: 'wifi', id: 'lan:192.168.9.1/24', label: '网关 192.168.9.1', local: 'granted' };
const CELL: RouteNetworkReading = { kind: 'cellular', id: null };

function seed(over: Partial<RouteFacts> = {}): RouteFacts {
  return {
    kind: 'phone',
    mac_id: MAC,
    has_lan_token: true,
    has_relay: true,
    lan_urls: [HOME],
    trusted_networks: [HOME_WIFI.id as string],
    declined_networks: [],
    tickets: { lan: null, cloud: null },
    revoked: false,
    ...over,
  };
}

interface Bench {
  calls: string[];
  saved: RouteFacts[];
  network: { set(n: RouteNetworkReading): void };
  ports: RouteDriverPorts;
  clock: { t: number };
  timers: { ms: number; fn: () => void }[];
  dropped: (string | null)[];
  revoked: number;
  probeAnswer: (url: string) => RouteProbeAnswer;
  mdns: MdnsService[] & { names?: Record<string, string> };
  joinOk: Record<RoomRoute, boolean>;
  localAsk: 'granted' | 'denied';
}

function bench(over: { probe?: (url: string) => RouteProbeAnswer; mdns?: (MdnsService & { name?: string })[]; start?: RouteNetworkReading } = {}): Bench & { source: RouteNetworkSource } {
  const listeners = new Set<(n: RouteNetworkReading) => void>();
  let current: RouteNetworkReading = over.start ?? HOME_WIFI;
  const b: Bench & { source: RouteNetworkSource } = {
    calls: [],
    saved: [],
    clock: { t: 1_000_000_000_000 },
    timers: [],
    dropped: [],
    revoked: 0,
    probeAnswer: over.probe ?? ((url) => ({ url, status: 'ok', mac_id: MAC, lan_url: LAN_URL, room: LAN_ROOM })),
    mdns: (over.mdns ?? []) as Bench['mdns'],
    joinOk: { lan: true, cloud: true },
    localAsk: 'granted',
    network: {
      set(n) { current = n; for (const l of [...listeners]) l(n); },
    },
    source: {
      current: async () => current,
      subscribe: (l) => { listeners.add(l); return () => listeners.delete(l); },
      ensureLocal: async () => { b.calls.push('ask-local'); return b.localAsk; },
    },
    ports: {
      probe: async (urls, timeout) => { b.calls.push(`probe ${urls.join(',')} ${timeout}`); return urls.map((u) => b.probeAnswer(u)); },
      browseMdns: async (ms) => { b.calls.push(`mdns ${ms}`); return b.mdns; },
      fetchTicket: async (route, source, from) => {
        b.calls.push(`ticket ${route} ${source} ${from ?? '-'}`);
        return route === 'lan'
          ? { ok: true, ticket: { url: LAN_URL, room: LAN_ROOM, expires_at: Math.floor(b.clock.t / 1000) + 86400 } }
          : { ok: true, ticket: CLOUD };
      },
      join: async (route, url, room) => { b.calls.push(`join ${route} ${url} ${room}`); return b.joinOk[route] ? { ok: true } : { ok: false, error: '进不去' }; },
      leave: async (route) => { b.calls.push(`leave ${route}`); },
      callDropped: (callId) => { b.dropped.push(callId); },
      revoked: () => { b.revoked += 1; },
    },
  };
  return b;
}

function driverOf(b: ReturnType<typeof bench>, facts: RouteFacts | null = null, seedFacts: RouteFacts = seed()) {
  let stored = facts;
  return createRouteDriver({
    facts: {
      load: async () => stored,
      save: async (f) => { stored = f; b.saved.push(f); },
    },
    seed: seedFacts,
    network: b.source,
    ports: b.ports,
    nowMs: () => b.clock.t,
    schedule: (ms, fn) => { const entry = { ms, fn }; b.timers.push(entry); return () => { b.timers.splice(b.timers.indexOf(entry), 1); }; },
  });
}

describe('路线驱动:在家', () => {
  it('确认过的 Wi-Fi 上冷启动:问 8791 → 向它要本机票 → 进本机房间;HTTP 直连那台', async () => {
    const b = bench();
    const d = driverOf(b);
    await d.start();
    await d.idle();
    expect(b.calls).toEqual([
      `probe ${HOME} 800`,
      `ticket lan workbench ${HOME}`,
      `join lan ${LAN_URL} ${LAN_ROOM}`,
    ]);
    expect(d.view().route).toBe('lan');
    expect(d.view().joined).toBe('lan');
    expect(d.http()).toEqual({ url: HOME, settled: true });
    // 票存进了事实(下次启动票还能用就不再要)
    expect(b.saved.slice(-1)[0]?.tickets.lan?.room).toBe(LAN_ROOM);
  });

  it('settled():第一次判定落地之前等着,落地就回', async () => {
    const b = bench();
    const d = driverOf(b);
    expect(d.http()).toEqual({ url: null, settled: false });
    const started = d.start();
    await d.settled(5000);
    await started;
    expect(d.http().settled).toBe(true);
  });

  it('8791 报的局域网地址表并进候选表(Mac 有两块网卡时下次也问得到)', async () => {
    const b = bench({ probe: (url) => ({ url, status: 'ok', mac_id: MAC, lan_url: LAN_URL, room: LAN_ROOM, lan_addresses: ['10.0.0.5', '192.168.50.2'] }) });
    const d = driverOf(b);
    await d.start();
    await d.idle();
    expect(b.saved.slice(-1)[0]?.lan_urls).toEqual([HOME, 'http://192.168.50.2:8791']);
  });

  it('本机房间没起(8791 不报 lan_url):HTTP 照样直连,房间走云,提示一次', async () => {
    const b = bench({ probe: (url) => ({ url, status: 'ok', mac_id: MAC, relay_configured: true }) });
    const d = driverOf(b);
    await d.start();
    await d.idle();
    expect(b.calls).toEqual([`probe ${HOME} 800`, 'ticket cloud relay -', `join cloud ${CLOUD.url} ${CLOUD.room}`]);
    expect(d.view().route).toBe('cloud');
    expect(d.view().notice).toBe('local_room_down');
    expect(d.http().url).toBe(HOME);
    expect(routeReasonText(d.view())).toContain('电脑上的通话服务没起来');
  });
});

describe('路线驱动:出门 / 回家', () => {
  it('切 4G:网络回调一来当场重判,进云房间(不等 30 秒)', async () => {
    const b = bench();
    const d = driverOf(b);
    await d.start();
    await d.idle();
    b.calls.length = 0;
    b.network.set(CELL);
    await d.idle();
    expect(b.calls).toEqual(['ticket cloud relay -', `join cloud ${CLOUD.url} ${CLOUD.room}`, 'leave lan']);
    expect(d.view().route).toBe('cloud');
    expect(d.http()).toEqual({ url: null, settled: true });
    expect(routeReasonText(d.view())).toContain('移动网络');
  });

  it('回家:判到在家,但离开本机房间不满 60 秒先待在云房间;到点再回', async () => {
    const b = bench();
    const d = driverOf(b);
    await d.start();
    await d.idle();
    b.network.set(CELL);
    await d.idle();
    b.clock.t += 20_000;
    b.calls.length = 0;
    b.network.set(HOME_WIFI);
    await d.idle();
    expect(b.calls).toEqual([`probe ${HOME} 800`]);
    expect(d.view().route).toBe('cloud');
    // 复查对准满 60 秒那一刻
    const timer = b.timers.slice(-1)[0];
    expect(timer?.ms).toBe(30_000);
    b.clock.t += 40_000;
    b.calls.length = 0;
    timer?.fn();
    await d.idle();
    expect(b.calls).toEqual([`probe ${HOME} 800`, `join lan ${LAN_URL} ${LAN_ROOM}`, 'leave cloud']);
    expect(d.view().route).toBe('lan');
  });

  it('零服务器档(没中转)出了门:退房、没路,原因说「这台没接中转」', async () => {
    const b = bench({ probe: (url) => ({ url, status: 'ok', mac_id: MAC, lan_url: LAN_URL, room: LAN_ROOM, relay_configured: false }) });
    const d = driverOf(b, null, seed({ has_relay: false }));
    await d.start();
    await d.idle();
    b.calls.length = 0;
    b.network.set(CELL);
    await d.idle();
    expect(b.calls).toEqual(['leave lan']);
    expect(d.view().route).toBe('none');
    expect(routeReasonText(d.view())).toContain('这台没接中转');
  });

  it('接了中转、只是这台手机没登录账号:出门说「登录一次」,不说没接中转', async () => {
    const b = bench();
    const d = driverOf(b, null, seed({ has_relay: false }));
    await d.start();
    await d.idle();
    b.network.set(CELL);
    await d.idle();
    expect(routeReasonText(d.view())).toContain('用账号登录一次');
  });

  it('手机包没带中转地址(开源构建):一律说这台没接中转', async () => {
    const b = bench();
    let stored: RouteFacts | null = null;
    const d = createRouteDriver({
      facts: { load: async () => stored, save: async (f) => { stored = f; } },
      seed: seed({ has_relay: false }),
      network: b.source,
      ports: b.ports,
      relayBuilt: false,
      nowMs: () => b.clock.t,
      schedule: () => () => {},
    });
    await d.start();
    await d.idle();
    b.network.set(CELL);
    await d.idle();
    expect(routeReasonText(d.view())).toContain('这台没接中转');
  });

  it('has_relay 每一步现取:登录账号之后不用重启', async () => {
    const b = bench();
    let relay = false;
    let stored: RouteFacts | null = null;
    const d = createRouteDriver({
      facts: { load: async () => stored, save: async (f) => { stored = f; } },
      seed: seed({ has_relay: false }),
      network: b.source,
      ports: b.ports,
      hasRelay: async () => relay,
      nowMs: () => b.clock.t,
      schedule: () => () => {},
    });
    await d.start();
    await d.idle();
    b.network.set(CELL);
    await d.idle();
    expect(d.view().route).toBe('none');
    relay = true;
    d.tick();
    await d.idle();
    expect(d.view().route).toBe('cloud');
  });
});

describe('路线驱动:没确认过的网络', () => {
  it('不带令牌问任何地址,只听 mDNS;看到配对过的那台问一句;答「是」记住并当场判', async () => {
    const b = bench({ start: CAFE_WIFI, mdns: [{ url: 'http://192.168.9.20:8791', mac_id: MAC, name: '工作台 · Ben 的 Air' }] });
    const d = driverOf(b);
    await d.start();
    await d.idle();
    expect(b.calls.filter((c) => c.startsWith('probe'))).toEqual([]);
    expect(b.calls).toContain('mdns 1500');
    expect(d.view().route).toBe('cloud');
    expect(d.view().asking).toEqual({ network_id: CAFE_WIFI.id, label: CAFE_WIFI.label, mac_name: '工作台 · Ben 的 Air' });
    expect(routeReasonText(d.view())).toContain('还没确认');
    b.calls.length = 0;
    b.probeAnswer = (url) => ({ url, status: url === HOME ? 'timeout' : 'ok', mac_id: MAC, lan_url: 'ws://192.168.9.20:7880', room: LAN_ROOM });
    d.answerHomeNetwork(true);
    await d.idle();
    expect(d.view().asking).toBeNull();
    expect(b.saved.slice(-1)[0]?.trusted_networks).toContain(CAFE_WIFI.id);
    // 候选表里的老地址没答 → 听 mDNS → 问新找到的那台
    expect(b.calls[0]).toBe(`probe ${HOME} 800`);
    expect(b.calls).toContain('probe http://192.168.9.20:8791 800');
    // 刚从本机房间以外的地方来(没进过本机房间):不受 60 秒限制
    expect(d.view().route).toBe('lan');
  });

  it('设置页上自己点「这是我常用的网络」:不等那一问,当场记住并判', async () => {
    const b = bench({ start: CAFE_WIFI });
    const d = driverOf(b);
    await d.start();
    await d.idle();
    b.probeAnswer = (url) => ({ url, status: 'ok', mac_id: MAC, lan_url: LAN_URL, room: LAN_ROOM });
    d.markNetwork(true);
    await d.idle();
    expect(b.saved.slice(-1)[0]?.trusted_networks).toContain(CAFE_WIFI.id);
    expect(d.view().route).toBe('lan');
  });

  it('答「不是」:记下来,这个网络上以后连 mDNS 都不听', async () => {
    const b = bench({ start: CAFE_WIFI, mdns: [{ url: 'http://192.168.9.20:8791', mac_id: MAC }] });
    const d = driverOf(b);
    await d.start();
    await d.idle();
    d.answerHomeNetwork(false);
    await d.idle();
    expect(b.saved.slice(-1)[0]?.declined_networks).toContain(CAFE_WIFI.id);
    b.calls.length = 0;
    d.tick();
    await d.idle();
    expect(b.calls).toEqual([]);
  });

  it('老配对(没记机器 id):mDNS 里同一个地址的那台报的 id 认下来,再按规矩问一句', async () => {
    const b = bench({ start: CAFE_WIFI, mdns: [{ url: HOME, mac_id: MAC, name: '工作台 · Air' }] });
    const d = driverOf(b, null, seed({ mac_id: null, trusted_networks: [] }));
    await d.start();
    await d.idle();
    expect(b.saved.slice(-1)[0]?.mac_id).toBe(MAC);
    expect(d.view().asking?.network_id).toBe(CAFE_WIFI.id);
  });

  it('老配对、这个网络上听不到 mDNS(公司 Wi-Fi 常挡组播):她在设置里点「这是我常用的网络」,当场带令牌问候选表认回机器 id,判在家', async () => {
    const b = bench({ start: CAFE_WIFI, mdns: [] });
    const d = driverOf(b, null, seed({ mac_id: null, trusted_networks: [] }));
    await d.start();
    await d.idle();
    expect(d.view().route).toBe('cloud');
    expect(b.calls.filter((c) => c.startsWith('probe'))).toEqual([]);
    d.markNetwork(true);
    await d.idle();
    expect(b.saved.slice(-1)[0]?.mac_id).toBe(MAC);
    expect(d.view().route).toBe('lan');
  });

  it('老配对 + 已确认的网络:带令牌问候选表,答 200 的那台就是它(别的 Mac 对这把令牌回 401)', async () => {
    const b = bench();
    const d = driverOf(b, null, seed({ mac_id: null }));
    await d.start();
    await d.idle();
    expect(b.saved.slice(-1)[0]?.mac_id).toBe(MAC);
    expect(d.view().route).toBe('lan');
  });
});

describe('路线驱动:本地网络权限(Android 17)', () => {
  it('要得到才连局域网;被拒就按出门走,原因里说去哪儿打开', async () => {
    const b = bench({ start: { ...HOME_WIFI, local: 'prompt' } });
    b.localAsk = 'denied';
    const d = driverOf(b);
    await d.start();
    await d.idle();
    expect(b.calls[0]).toBe('ask-local');
    expect(b.calls.filter((c) => c.startsWith('probe'))).toEqual([]);
    expect(d.view().route).toBe('cloud');
    expect(d.view().localNetwork).toBe('denied');
    expect(routeReasonText(d.view())).toContain('附近的设备');
  });

  it('给了:照常在家', async () => {
    const b = bench({ start: { ...HOME_WIFI, local: 'prompt' } });
    const d = driverOf(b);
    await d.start();
    await d.idle();
    expect(b.calls).toEqual(['ask-local', `probe ${HOME} 800`, `ticket lan workbench ${HOME}`, `join lan ${LAN_URL} ${LAN_ROOM}`]);
  });
});

describe('路线驱动:通话中换路与撤销', () => {
  it('通话中出了家门:进上云房间后这一通续不上(M9 之前),告诉界面「换了网络,点一下回拨」', async () => {
    const b = bench();
    const d = driverOf(b);
    await d.start();
    await d.idle();
    d.callState(true, 'call-7');
    b.network.set(CELL);
    await d.idle();
    expect(b.calls.slice(-2)).toEqual([`join cloud ${CLOUD.url} ${CLOUD.room}`, 'leave lan']);
    expect(b.dropped).toEqual(['call-7']);
  });

  it('电脑明说不认(配对过的那台回 401 带自己的 id):两条路都停、告诉通道层,之后不再探', async () => {
    const b = bench({ probe: (url) => ({ url, status: 'unauthorized', mac_id: MAC }) });
    const d = driverOf(b);
    await d.start();
    await d.idle();
    expect(b.revoked).toBe(1);
    expect(d.view().route).toBe('none');
    expect(routeReasonText(d.view())).toContain('重新扫码配对');
    b.calls.length = 0;
    d.tick();
    b.network.set(CELL);
    await d.idle();
    expect(b.calls).toEqual([]);
  });

  it('别的 Mac 回 401:不算撤销,只把那个地址从候选表里拿掉', async () => {
    const other = 'http://10.0.0.9:8791';
    const b = bench({ probe: (url) => (url === other ? { url, status: 'unauthorized', mac_id: 'ffff' } : { url, status: 'ok', mac_id: MAC, lan_url: LAN_URL, room: LAN_ROOM }) });
    const d = driverOf(b, null, seed({ lan_urls: [other, HOME] }));
    await d.start();
    await d.idle();
    expect(b.revoked).toBe(0);
    expect(b.saved.slice(-1)[0]?.lan_urls).toEqual([HOME]);
    expect(d.view().route).toBe('lan');
  });

  it('房间掉了(LiveKit 放弃重连):当场重判', async () => {
    const b = bench();
    const d = driverOf(b);
    await d.start();
    await d.idle();
    b.calls.length = 0;
    d.roomLost('lan');
    await d.idle();
    expect(b.calls).toEqual([`probe ${HOME} 800`, `join lan ${LAN_URL} ${LAN_ROOM}`]);
  });
});

describe('路线驱动:复查节拍', () => {
  it('直连慢那一下发的 tick:正在判就不再起一次,5 秒内只算一次', async () => {
    const b = bench();
    const d = driverOf(b);
    await d.start();
    await d.idle();
    b.calls.length = 0;
    d.tick();
    d.tick();
    await d.idle();
    d.tick();
    await d.idle();
    expect(b.calls.filter((c) => c.startsWith('probe'))).toHaveLength(1);
    b.clock.t += 6000;
    d.tick();
    await d.idle();
    expect(b.calls.filter((c) => c.startsWith('probe'))).toHaveLength(2);
  });

  it('房里续期拿到的新票:只存,不换房', async () => {
    const b = bench();
    const d = driverOf(b);
    await d.start();
    await d.idle();
    b.calls.length = 0;
    d.ticketRenewed('lan', { url: LAN_URL, room: LAN_ROOM, expires_at: 2_100_000_000 });
    await d.idle();
    expect(b.calls).toEqual([]);
    expect(b.saved.slice(-1)[0]?.tickets.lan?.expires_at).toBe(2_100_000_000);
  });
});

describe('routeReasonText:设置页那一行原因', () => {
  it('还在判', () => {
    const b = bench();
    const d = driverOf(b);
    expect(routeReasonText(d.view())).toContain('正在判断');
  });
});
