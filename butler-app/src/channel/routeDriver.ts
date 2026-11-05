/**
 * 手机的路线驱动(2026-10-21,局域网 M4)。规格(routeSpec.ts,docs/规格-连接路线-2026-10-21.md)只说「该做什么」,
 * 这一层去做:读网络、问 8791、听 mDNS、要票、进房、弹那一句「这是你常用的网络吗」,再把结果当事件喂回规格。
 *
 * 几条规矩:
 *   - **事件一个一个喂**(排队):规格是纯函数,两个事件交错着改状态就不是它说的那个结果了。
 *     要等结果的动作(探测、mDNS、要票、进房)发出去就不等,结果回来再排进队里 —— 一次慢探测不挡住「切到 4G」。
 *   - **事实(`facts`)每一步变了就存**:配对过的机器 id、候选地址表、确认过的网络、两条路各一份票的地址与到期。
 *     令牌不在这里(规格不认令牌),由通道层按路线另存(credentialStore.ts 的路线那一份)。
 *   - 规格之外,驱动只补三件规格管不着的事:① 会变的事实每一步现取(登没登录账号 → `has_relay`);
 *     ② 老配对(M4 之前配的,没记机器 id)怎么把 id 认回来;③ Android 17 的本地网络权限:要不到就当认不出这个网络
 *     (`id: null`,规格据此一律按出门走)。
 *   - 通话中换了路:规格给 `resume_call`(续上同一通是卡 M9);这一版工人还续不上,所以当场告诉界面
 *     「换了网络,这一通断了,点一下回拨」。
 */
import {
  ROUTE_SPEC,
  decideRoute,
  initialRouteState,
  type MdnsService,
  type ProbeAnswer,
  type RoomRoute,
  type RouteAction,
  type RouteDecision,
  type RouteEvent,
  type RouteFacts,
  type RouteName,
  type RouteNetwork,
  type RouteNotice,
  type RouteState,
  type RouteTicket,
  type TicketSource,
} from './routeSpec';

/** 8791 `GET /channel/route` 的一条答复,比规格多两格(M2 的回包里本来就有)。 */
export interface RouteProbeAnswer extends ProbeAnswer {
  /** 这台 Mac 的局域网地址表(M2 `lan_addresses`):并进候选表,Mac 有两块网卡时下次也问得到。 */
  lan_addresses?: string[];
  /** 这台 Mac 接没接中转(M2 `relay.configured`)。`false` = 零服务器档。 */
  relay_configured?: boolean;
}

/** mDNS 找到的一台,多一格给人看的名字(TXT `name`,「工作台 · <主机名>」)。 */
export interface RouteMdnsService extends MdnsService {
  name?: string;
}

export type RouteTicketFetch = { ok: true; ticket: RouteTicket } | { ok: false; error: string; revoked?: true };

/** 驱动真去做事的那几只手。测试塞假的;生产在 routePorts.ts。 */
export interface RouteDriverPorts {
  /** 带设备令牌同时 `GET <url>/channel/route`,每个最多等 `timeoutMs`。按传进来的顺序回。 */
  probe(urls: readonly string[], timeoutMs: number): Promise<RouteProbeAnswer[]>;
  /** 听 `_workbench._tcp` 这么久。听不了(没插件)就回空表。 */
  browseMdns(ms: number): Promise<RouteMdnsService[]>;
  /** `workbench`:向 `from` 那台 8791 要本机房间的票;`relay`:向中转要云房间的票。令牌由通道层存。 */
  fetchTicket(route: RoomRoute, source: TicketSource, from: string | null): Promise<RouteTicketFetch>;
  /** 用这条路那张票进 `url` 的 `room`。 */
  join(route: RoomRoute, url: string, room: string): Promise<{ ok: true } | { ok: false; error: string }>;
  leave(route: RoomRoute): Promise<void>;
  /** 通话中换了路、这一通续不上(或两条都断了):界面收场,提示回拨。 */
  callDropped?(callId: string | null): void;
  /** 电脑 / 中转明说不认这台手机了。 */
  revoked?(): void;
}

/** 一次网络读数。比规格多两格:给人看的名字、本地网络权限。 */
export interface RouteNetworkReading extends RouteNetwork {
  /** 给人看的:Wi-Fi 名(读得到时)或「网关 192.168.1.1」。 */
  label?: string;
  /**
   * Android 17 的本地网络权限(`ACCESS_LOCAL_NETWORK`)。`prompt` = 还没问过、可以问;
   * 缺席 = 这台系统没有这一条(17 以前),当给了。
   */
  local?: 'granted' | 'denied' | 'prompt';
}

export interface RouteNetworkSource {
  current(): Promise<RouteNetworkReading>;
  /** 网络变了(原生 ConnectivityManager 回调;网页里是 online / connection.change)。 */
  subscribe(listener: (network: RouteNetworkReading) => void): () => void;
  /** 要本地网络权限(弹系统那个框)。回问完之后的结果。没有就当给了。 */
  ensureLocal?(): Promise<'granted' | 'denied'>;
}

export interface RouteFactsStore {
  load(): Promise<RouteFacts | null>;
  save(facts: RouteFacts): Promise<void>;
}

export interface RouteDriverDeps {
  facts: RouteFactsStore;
  /** 从没存过事实时的起点(配对回包里的机器 id、配对地址、配对那一刻的网络)。 */
  seed: RouteFacts;
  network: RouteNetworkSource;
  ports: RouteDriverPorts;
  /** 此刻有没有出门线路(登没登录账号、电脑接没接中转)。每一步现取;不给就用事实里那一格。 */
  hasRelay?: () => Promise<boolean>;
  nowMs?: () => number;
  /**
   * 从没存过事实时,把此刻所在的网络直接记成确认过(规格第一节:配对那一次所在的网络由驱动记成确认过)。
   * 只给刚配对的会话开:升级上来的老配对第一次启动时人在哪个网络上不知道,不能替她确认。
   */
  trustFirstNetwork?: boolean;
  /** 手机包自己带没带中转地址(开源构建缺省没有,局域网 M7)。`false` 时设置页说「这台没接中转」。 */
  relayBuilt?: boolean;
  /** 定一个到点就叫的钟,回一个取消函数。测试塞假的。 */
  schedule?: (ms: number, fn: () => void) => () => void;
}

/** 设置页、首页横幅要看的那几样。 */
export interface RouteView {
  route: RouteName;
  /** 第一次判定还没落地 / 正在判。 */
  deciding: boolean;
  joined: RoomRoute | null;
  http: string | null;
  notice: RouteNotice | null;
  network: RouteNetworkReading;
  /** 此刻这个网络是她确认过的。 */
  trusted: boolean;
  /** 正在问「这是你常用的网络吗」。 */
  asking: { network_id: string; label?: string; mac_name?: string } | null;
  localNetwork: 'granted' | 'denied' | 'prompt' | 'unknown';
  hasRelay: boolean;
  /** 电脑报的「接没接中转」;没问到过是 null。 */
  relayConfigured: boolean | null;
  /** mDNS 里见过的那台的名字。 */
  macName: string | null;
  revoked: boolean;
}

/** 直连慢、切回前台那种 tick 最密多久一次(毫秒)。 */
export const ROUTE_TICK_MIN_GAP_MS = 5000;

export interface RouteDriver {
  start(): Promise<void>;
  stop(): void;
  view(): RouteView;
  subscribe(listener: () => void): () => void;
  /** HTTP 直连用哪个地址;`settled: false` = 第一次判定还没落地(routedClient 先等一小会儿)。 */
  http(): { url: string | null; settled: boolean };
  /** 第一次判定落地(或等满 `ms`)就回。 */
  settled(ms: number): Promise<void>;
  /** 复查一次(切回前台、直连慢)。正在判 / 5 秒内判过就不再起。 */
  tick(): void;
  answerHomeNetwork(yes: boolean): void;
  /** 设置页上她自己说「这个网络是 / 不是我常用的」(不等弹出来的那一问)。读不到网络标识就什么都不做。 */
  markNetwork(yes: boolean): void;
  callState(active: boolean, callId?: string | null): void;
  roomLost(route: RoomRoute): void;
  /** 房里续期拿到了新票(只存)。 */
  ticketRenewed(route: RoomRoute, ticket: RouteTicket): void;
  /** 事件队列与在路上的动作都完了(测试用)。 */
  idle(): Promise<void>;
}

const EMPTY_NETWORK: RouteNetworkReading = { kind: 'none', id: null };

export function createRouteDriver(deps: RouteDriverDeps): RouteDriver {
  const nowMs = deps.nowMs ?? (() => Date.now());
  const schedule = deps.schedule ?? ((ms: number, fn: () => void) => { const t = setTimeout(fn, ms); return () => clearTimeout(t); });
  const listeners = new Set<() => void>();
  let state: RouteState | null = null;
  let decision: RouteDecision | null = null;
  let reading: RouteNetworkReading = EMPTY_NETWORK;
  let localAsked = false;
  let localState: RouteView['localNetwork'] = 'unknown';
  let asking: RouteView['asking'] = null;
  let relayConfigured: boolean | null = null;
  const macNames = new Map<string, string>();
  let settledOnce = false;
  const settledWaiters = new Set<() => void>();
  let cancelTimer: (() => void) | null = null;
  let unsubscribe: (() => void) | null = null;
  let stopped = false;
  let chain: Promise<void> = Promise.resolve();
  let queued = 0;
  let inFlight = 0;
  let lastTick = -Infinity;
  let adopting = false;
  let starting = false;
  /** 上一次存下的事实(排好的 JSON):驱动自己补的那几格(机器 id、地址表)也要存。 */
  let savedFacts = '';

  const nowS = (): number => Math.floor(nowMs() / 1000);

  function emit(): void {
    for (const l of [...listeners]) { try { l(); } catch { /* 一个订阅者抛不该拦住别人 */ } }
  }

  function markSettled(): void {
    if (settledOnce) return;
    settledOnce = true;
    for (const w of [...settledWaiters]) w();
    settledWaiters.clear();
  }

  /** 排进队里;`make` 在轮到它时才算(那时的状态才是对的)。 */
  function feed(make: () => RouteEvent | null): void {
    if (stopped) return;
    queued += 1;
    chain = chain.then(async () => {
      try {
        const event = make();
        if (event !== null) await step(event);
      } catch { /* 一步出错不该把队列带走 */ }
      finally { queued -= 1; }
    });
  }

  /** 发出去不等的动作:结果回来再排队。 */
  function launch<T>(work: () => Promise<T>, then: (value: T) => RouteEvent | null): void {
    inFlight += 1;
    void work()
      .then((value) => { feed(() => then(value)); }, () => { feed(() => then(undefined as T)); })
      .finally(() => { inFlight -= 1; });
  }

  async function step(event: RouteEvent): Promise<void> {
    if (state === null || stopped) return;
    if (deps.hasRelay !== undefined && !state.facts.revoked) {
      const hasRelay = await deps.hasRelay().catch(() => state?.facts.has_relay ?? false);
      if (state !== null && hasRelay !== state.facts.has_relay) state = { ...state, facts: { ...state.facts, has_relay: hasRelay } };
    }
    const out = decideRoute(state, event);
    state = out.state;
    decision = out.decision;
    await persist();
    if (asking !== null && (state.network.id !== asking.network_id || state.facts.trusted_networks.includes(asking.network_id))) asking = null;
    arm(decision.recheck_ms);
    for (const action of decision.actions) await run(action);
    // 老配对:她刚确认了网络、或到点复查时,再试着认回机器 id(公司 Wi-Fi 常挡组播,mDNS 那条路走不通时全靠确认之后带令牌问)。
    if ((event.type === 'home_network_answer' || event.type === 'tick') && state.facts.mac_id === null) void adoptMacId();
    if (state.check === null && event.type !== 'call_state') markSettled();
    emit();
  }

  async function persist(): Promise<void> {
    if (state === null) return;
    const now = JSON.stringify(state.facts);
    if (now === savedFacts) return;
    savedFacts = now;
    await deps.facts.save(state.facts).catch(() => {});
  }

  function arm(ms: number | null): void {
    cancelTimer?.();
    cancelTimer = null;
    if (ms === null || stopped) return;
    cancelTimer = schedule(ms, () => { cancelTimer = null; feed(() => ({ type: 'tick', at: nowS() })); });
  }

  async function run(action: RouteAction): Promise<void> {
    switch (action.type) {
      case 'probe':
        launch(() => deps.ports.probe(action.urls, action.timeout_ms), (answers) => probeEvent(answers ?? []));
        return;
      case 'browse_mdns':
        launch(() => deps.ports.browseMdns(action.ms), (services) => {
          const list = services ?? [];
          for (const s of list) if (s.mac_id && s.name) macNames.set(s.mac_id, s.name);
          return { type: 'mdns_result', at: nowS(), services: list.map((s) => ({ url: s.url, ...(s.mac_id === undefined ? {} : { mac_id: s.mac_id }) })) };
        });
        return;
      case 'fetch_ticket':
        launch(() => deps.ports.fetchTicket(action.route, action.source, action.from), (got) => (
          got !== undefined && got.ok
            ? { type: 'ticket_result', at: nowS(), route: action.route, ok: true, ticket: got.ticket }
            : { type: 'ticket_result', at: nowS(), route: action.route, ok: false, ...(got?.ok === false && got.revoked === true ? { revoked: true } : {}) }
        ));
        return;
      case 'join':
        launch(() => deps.ports.join(action.route, action.url, action.room), (r) => ({ type: 'join_result', at: nowS(), route: action.route, ok: r?.ok === true }));
        return;
      case 'leave':
        await deps.ports.leave(action.route).catch(() => {});
        return;
      case 'resume_call':
        // 续上同一通是卡 M9;这一版工人还不认,当场收场并提示回拨。
        try { deps.ports.callDropped?.(action.call_id); } catch { /* 界面那边抛不该拦住换路 */ }
        return;
      case 'ask_home_network': {
        const mac = state?.facts.mac_id ?? null;
        asking = {
          network_id: action.network_id,
          ...(reading.id === action.network_id && reading.label !== undefined ? { label: reading.label } : {}),
          ...(mac !== null && macNames.has(mac) ? { mac_name: macNames.get(mac) as string } : {}),
        };
        return;
      }
      case 'notify':
        if (action.notice === 'revoked') { try { deps.ports.revoked?.(); } catch { /* 同上 */ } }
        if (action.notice === 'call_dropped') { try { deps.ports.callDropped?.(state?.call.call_id ?? null); } catch { /* 同上 */ } }
        return;
      default:
        return;
    }
  }

  function probeEvent(answers: RouteProbeAnswer[]): RouteEvent {
    const mine = state?.facts.mac_id ?? null;
    for (const a of answers) {
      if (mine !== null && a.mac_id === mine && typeof a.relay_configured === 'boolean') relayConfigured = a.relay_configured;
    }
    // 配对过的那台报的地址表并进候选表(规格随后把答话的那个排到最前、截到 4 个)。
    const match = answers.find((a) => a.status === 'ok' && mine !== null && a.mac_id === mine);
    if (state !== null && match !== undefined && Array.isArray(match.lan_addresses)) {
      const port = portOf(match.url);
      const extra = match.lan_addresses
        .filter((ip) => typeof ip === 'string' && ip !== '')
        .map((ip) => `http://${ip.includes(':') ? `[${ip}]` : ip}:${port}`)
        .filter((u) => !state!.facts.lan_urls.includes(u));
      if (extra.length > 0) state = { ...state, facts: { ...state.facts, lan_urls: [...state.facts.lan_urls, ...extra] } };
    }
    return {
      type: 'probe_result',
      at: nowS(),
      answers: answers.map((a) => ({
        url: a.url,
        status: a.status,
        ...(a.mac_id === undefined ? {} : { mac_id: a.mac_id }),
        ...(a.lan_url === undefined ? {} : { lan_url: a.lan_url }),
        ...(a.room === undefined ? {} : { room: a.room }),
      })),
    };
  }

  /** 给规格的那一份网络:本地网络权限要不到 = 认不出这个网络(按出门走)。 */
  async function networkFor(next: RouteNetworkReading): Promise<RouteNetwork> {
    reading = next;
    const lanKind = next.kind === 'wifi' || next.kind === 'ethernet';
    if (next.local === undefined) localState = lanKind ? 'granted' : localState;
    else localState = next.local;
    if (lanKind && next.local === 'prompt' && !localAsked && deps.network.ensureLocal !== undefined && state?.facts.has_lan_token === true) {
      localAsked = true;
      localState = await deps.network.ensureLocal().catch(() => 'denied' as const);
    }
    if (lanKind && localState !== 'granted') return { kind: next.kind, id: null };
    return { kind: next.kind, id: next.id };
  }

  /**
   * 老配对(没记机器 id)把 id 认回来。规格里机器 id 是 null 就永远判不到在家,升级上来的手机不能就此一直「出门」:
   *   - 确认过的网络:带令牌问候选表,答 200 的就是它 —— 别的 Mac 对这把令牌回 401,答得出 200 的只有发令牌的那一台;
   *   - 没确认过的网络:不带令牌,只听 mDNS,候选表里那个地址上的那台报的 id 认下来(随后规格照常问那一句)。
   */
  async function adoptMacId(): Promise<void> {
    if (adopting || state === null || state.facts.mac_id !== null || !state.facts.has_lan_token || state.facts.revoked) return;
    const net = state.network;
    if ((net.kind !== 'wifi' && net.kind !== 'ethernet') || net.id === null) return;
    adopting = true;
    inFlight += 1;
    try {
      const urls = [...state.facts.lan_urls];
      let found: string | null = null;
      if (state.facts.trusted_networks.includes(net.id)) {
        const answers = await deps.ports.probe(urls, ROUTE_SPEC.PROBE_TIMEOUT_MS).catch(() => []);
        found = answers.find((a) => a.status === 'ok' && typeof a.mac_id === 'string' && a.mac_id !== '')?.mac_id ?? null;
      }
      if (found === null) {
        const services = await deps.ports.browseMdns(ROUTE_SPEC.MDNS_BROWSE_MS).catch(() => []);
        const hit = services.find((s) => urls.includes(s.url) && typeof s.mac_id === 'string' && s.mac_id !== '');
        if (hit !== undefined) { found = hit.mac_id as string; if (hit.name) macNames.set(found, hit.name); }
      }
      if (found !== null) {
        const id = found;
        feed(() => {
          if (state === null || state.facts.mac_id !== null) return null;
          state = { ...state, facts: { ...state.facts, mac_id: id } };
          return { type: 'tick', at: nowS() };
        });
      }
    } finally {
      adopting = false;
      inFlight -= 1;
    }
  }

  function onNetwork(next: RouteNetworkReading): void {
    inFlight += 1;
    void networkFor(next).then((network) => {
      feed(() => ({ type: 'net_changed', at: nowS(), network }));
      feed(() => { void adoptMacId(); return null; });
    }).finally(() => { inFlight -= 1; });
  }

  async function begin(): Promise<void> {
    const stored = await deps.facts.load().catch(() => null);
    state = initialRouteState(stored ?? deps.seed);
    if (stored !== null) savedFacts = JSON.stringify(state.facts);
    unsubscribe = deps.network.subscribe(onNetwork);
    const first = await deps.network.current().catch(() => EMPTY_NETWORK);
    const network = await networkFor(first);
    if (stored === null && deps.trustFirstNetwork === true && network.id !== null
      && (network.kind === 'wifi' || network.kind === 'ethernet') && !state.facts.trusted_networks.includes(network.id)) {
      state = { ...state, facts: { ...state.facts, trusted_networks: [...state.facts.trusted_networks, network.id] } };
    }
    await persist();
    feed(() => ({ type: 'start', at: nowS(), network }));
    feed(() => { void adoptMacId(); return null; });
  }

  return {
    async start() {
      if (state !== null || stopped || starting) return;
      starting = true;
      inFlight += 1;
      try { await begin(); } finally { inFlight -= 1; }
    },

    stop() {
      stopped = true;
      cancelTimer?.();
      cancelTimer = null;
      unsubscribe?.();
      unsubscribe = null;
      markSettled();
    },

    view() {
      const facts = state?.facts;
      const id = state?.network.id ?? null;
      return {
        route: decision?.route ?? 'none',
        deciding: !settledOnce || (state?.check ?? null) !== null,
        joined: state?.joined?.route ?? null,
        http: decision?.http ?? null,
        notice: state?.notice ?? null,
        network: reading,
        trusted: id !== null && (facts?.trusted_networks.includes(id) ?? false),
        asking,
        localNetwork: localState,
        hasRelay: facts?.has_relay ?? false,
        relayConfigured: deps.relayBuilt === false ? false : relayConfigured,
        macName: facts?.mac_id === null || facts?.mac_id === undefined ? null : macNames.get(facts.mac_id) ?? null,
        revoked: facts?.revoked ?? false,
      };
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },

    http() {
      return { url: decision?.http ?? null, settled: settledOnce };
    },

    settled(ms) {
      if (settledOnce) return Promise.resolve();
      return new Promise((resolve) => {
        const done = (): void => { cancel(); settledWaiters.delete(done); resolve(); };
        const cancel = schedule(ms, done);
        settledWaiters.add(done);
      });
    },

    tick() {
      if (state === null || stopped || state.check !== null) return;
      const t = nowMs();
      if (t - lastTick < ROUTE_TICK_MIN_GAP_MS) return;
      lastTick = t;
      feed(() => ({ type: 'tick', at: nowS() }));
    },

    answerHomeNetwork(yes) {
      const asked = asking;
      if (asked === null) return;
      asking = null;
      feed(() => ({ type: 'home_network_answer', at: nowS(), network_id: asked.network_id, yes }));
      emit();
    },

    markNetwork(yes) {
      const id = state?.network.id ?? null;
      if (id === null) return;
      if (asking?.network_id === id) asking = null;
      feed(() => ({ type: 'home_network_answer', at: nowS(), network_id: id, yes }));
      emit();
    },

    callState(active, callId) {
      feed(() => ({ type: 'call_state', at: nowS(), active, ...(callId === undefined ? {} : { call_id: callId }) }));
    },

    roomLost(route) {
      feed(() => ({ type: 'room_lost', at: nowS(), route }));
    },

    ticketRenewed(route, ticket) {
      feed(() => ({ type: 'ticket_result', at: nowS(), route, ok: true, ticket }));
    },

    async idle() {
      for (let i = 0; i < 500; i += 1) {
        await chain;
        if (queued === 0 && inFlight === 0) return;
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    },
  };
}

function portOf(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.port === '' ? '8791' : parsed.port;
  } catch {
    return '8791';
  }
}

/** 设置页那一行的标题。 */
export const ROUTE_TITLE_TEXT: Record<RouteName, string> = {
  lan: '在家(本机房间)',
  cloud: '出门(云)',
  none: '没连上',
};

export const ROUTE_LOCAL_DENIED_TEXT = '没给「附近的设备」(本地网络)权限,连不了家里的电脑,先按出门走。去 系统设置 → 应用 → 事务官 → 权限,打开「附近的设备」';
/** 「这台没接中转」与插件那边 M7 导出的 `NO_RELAY_NOTE` 同一句话打头。 */
export const ROUTE_NO_RELAY_TEXT = '这台没接中转:不在家里的网时用不了,回到家里的 Wi-Fi 就好';
export const ROUTE_NO_ACCOUNT_TEXT = '不在家里的网,这台手机还没有出门线路:用账号登录一次,或者回到家里的 Wi-Fi';

/** 设置页那一行原因:此刻为什么走这条路。 */
export function routeReasonText(view: RouteView): string {
  if (view.revoked || view.notice === 'revoked') return '电脑不认这台手机了:到「我的电脑」里退出登录,重新扫码配对';
  if (view.route === 'none' && view.deciding) return '正在判断在家还是出门…';
  const net = view.network;
  const where = view.macName === null ? '' : `「${view.macName}」`;
  if (view.route === 'lan') return `在家:连着电脑${where}上的本机房间,来电和说话都不经云`;
  if (view.route === 'cloud') {
    if (view.notice === 'local_room_down') return '电脑在,但电脑上的通话服务没起来,先走出门线路';
    if (net.kind === 'cellular') return '用的是移动网络,走出门线路(云)';
    if (net.kind === 'none') return '手机没有网络';
    if ((net.kind === 'wifi' || net.kind === 'ethernet') && view.localNetwork === 'denied') return ROUTE_LOCAL_DENIED_TEXT;
    if (net.id === null) return '认不出这个网络,先按出门走';
    if (!view.trusted) return `这个网络${net.label === undefined ? '' : `(${net.label})`}还没确认是你常用的网络,先按出门走`;
    return '这个网络上没找到你的电脑,走出门线路';
  }
  if (view.notice === 'no_way_out' || (!view.hasRelay && view.notice !== 'offline')) {
    return view.relayConfigured === false ? ROUTE_NO_RELAY_TEXT : ROUTE_NO_ACCOUNT_TEXT;
  }
  if (view.notice === 'call_dropped') return '换了网络,这一通断了;点一下回拨';
  if (view.network.kind === 'none') return '手机没有网络';
  return '连不上电脑,稍后自动再试';
}
