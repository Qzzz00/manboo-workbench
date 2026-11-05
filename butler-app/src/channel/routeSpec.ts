/**
 * 连接路线规格 —— 手机这一份实现(2026-10-21,局域网主路卡 M3)。
 *
 * 规格正文:docs/规格-连接路线-2026-10-21.md。听筒那一份是 phone-bridge/route_spec.py,**同一签名、同一输出形状**;
 * 两边的用例都读 src/channel/routeSpec.cases.json、逐步比对同一份期望值(tests/routeSpec.test.ts、phone-bridge/route_spec_test.py)。
 * 改这里就要同时改那边,再改用例 —— 用例是规格的一部分。
 *
 * 一句话:`decideRoute(state, event) → {state, decision}`。设备每碰到一件事(启动、网络变了、到点复查、探测回来了、
 * 进房成败、房间掉了、通话起止、她答了「是不是常用网络」)就喂一个事件进来,拿回「该走哪条路、该连哪间房、
 * 现在要做哪几件事、多久之后再判」。**纯函数**:不读网络、不读文件、不看钟(时刻在事件的 `at` 里),不改传进来的状态。
 * 真正去探测、进房、要票、弹提示的是驱动(手机 M4、听筒 M5、通话中换路 M9),它们照 `actions` 做,再把结果当事件喂回来。
 *
 * 字段一律 snake_case:与房间协议、8791 回包(`expires_at`、`call_id`)同一个写法,两种语言的输出才能逐字相同。
 * 令牌(设备令牌、进房票里的 token)**不进这里**:规格只认票的地址、房间名、到期时刻,令牌由驱动按路线另存。
 */

/** 规格里的常数。用例文件 `constants` 一格一格比对它。 */
export const ROUTE_SPEC = {
  /** 问一个 8791 地址最多等多久(`GET /channel/route`,几个地址同时问)。 */
  PROBE_TIMEOUT_MS: 800,
  /** 听一次 mDNS 多久。 */
  MDNS_BROWSE_MS: 1500,
  /** 在本机房间里,隔多久复查一次(只为发现 Mac 换了地址)。 */
  RECHECK_LAN_MS: 60000,
  /** 在云房间里,隔多久回头看看到家没有。 */
  RECHECK_CLOUD_MS: 30000,
  /** 两条都不通时,隔多久从头再判。 */
  RECHECK_NONE_MS: 30000,
  /** 在本机房间里判不到一次之后,多久再判(确认是真断了还是抖了一下)。 */
  RECHECK_AFTER_MISS_MS: 10000,
  /** 在本机房间里连续判不到几次才换云房间(网络换了、房间掉了这类确定的事一次就算)。 */
  LEAVE_LAN_MISSES: 2,
  /** 从本机房间退到云房间之后,至少待多久才回本机房间(门口 Wi-Fi 时有时无时不来回跳)。 */
  BACK_TO_LAN_HOLD_S: 60,
  /** 票剩不到这么久就当不能用,先换一张。 */
  TICKET_MIN_LEFT_S: 600,
  /** 8791 地址候选表最多记几个。 */
  LAN_URLS_MAX: 4,
} as const;

export type RouteName = 'lan' | 'cloud' | 'none';
export type RoomRoute = 'lan' | 'cloud';
export type TicketSource = 'workbench' | 'relay';
export type RouteNotice = 'local_room_down' | 'no_way_out' | 'offline' | 'call_dropped' | 'revoked';

export interface RouteNetwork {
  kind: 'wifi' | 'ethernet' | 'cellular' | 'none';
  /** 手机:Wi-Fi 名;听筒:网关 MAC。读不到就 null(读不到 = 没法确认 = 按出门走)。 */
  id: string | null;
}

/** 票里规格要看的那三格。`url` / `room` 与 8791 `/channel/token`、中转 `/v1/channel-token` 回包同名。 */
export interface RouteTicket {
  url: string;
  room: string;
  /** unix 秒。 */
  expires_at: number;
}

/** 设备要存下来的那一份(跨启动)。驱动每一步都把 `state.facts` 原样存回去。 */
export interface RouteFacts {
  kind: 'phone' | 'handset';
  /** 配对时记下的那台 Mac 的机器 id(与 `/channel/route` 回包的 `mac_id` 同名)。 */
  mac_id: string | null;
  /** 手上有没有 8791 发的设备令牌。 */
  has_lan_token: boolean;
  /** 手上有没有中转地址 + 中转设备令牌(零服务器档没有)。 */
  has_relay: boolean;
  /** 8791 的地址候选表(`http://<host>:8791`),最近答过的在前。 */
  lan_urls: string[];
  /** 她确认过的「家里 / 办公室的网」。 */
  trusted_networks: string[];
  /** 她答过「不是」的网络:不再问。 */
  declined_networks: string[];
  /** 每条路一份票,**局域网的票只连局域网**。 */
  tickets: { lan: RouteTicket | null; cloud: RouteTicket | null };
  /** 任一边明说不认这台设备:两条路都停,重新配对才回来。 */
  revoked: boolean;
}

export interface RouteState {
  facts: RouteFacts;
  network: RouteNetwork;
  /** 上一个事件的时刻(unix 秒)。 */
  now: number;
  route: RouteName;
  /** 此刻真在哪间房里。 */
  joined: { route: RoomRoute; url: string; room: string } | null;
  /** 正在换过去的那条路:先要票(ticket),再进房(join)。 */
  pending: { route: RoomRoute; step: 'ticket' | 'join'; url: string | null; room: string | null } | null;
  /** 这个网络上最近一次答话的 8791(配对过的那台):HTTP 地址 + 它报的本机房间。网络一变就作废。 */
  home: { http: string; url: string | null; room: string | null; network_id: string | null } | null;
  /** 正在判的那一次:先问候选表(known)→ 听 mDNS(mdns)→ 问 mDNS 新找到的(found)。 */
  check: { phase: 'known' | 'mdns' | 'found'; urgent: boolean; tried: string[] } | null;
  /** 没确认的网络上,为了问那一句在听 mDNS 的那个网络。 */
  asking: string | null;
  /** 这次运行里问过的网络(没答也不再问)。 */
  asked: string[];
  /** 连续几次判不到在家。 */
  misses: number;
  /** 上次退出本机房间的时刻。 */
  left_lan_at: number | null;
  call: { active: boolean; call_id: string | null; resume: boolean };
  /** 上一次提示的是哪一句(同一句不重复提示)。 */
  notice: RouteNotice | null;
}

/** 一个 8791 地址对 `GET /channel/route` 的答复。`mac_id` / `lan_url` / `room` 缺、null、空串都当没给。 */
export interface ProbeAnswer {
  url: string;
  status: 'ok' | 'unauthorized' | 'timeout' | 'error';
  mac_id?: string | null;
  lan_url?: string | null;
  room?: string | null;
}

/** mDNS 找到的一台工作台。TXT 里有 `mac_id` 就带上。 */
export interface MdnsService {
  url: string;
  mac_id?: string | null;
}

export type RouteEvent =
  | { type: 'start'; at: number; network: RouteNetwork }
  | { type: 'net_changed'; at: number; network: RouteNetwork }
  | { type: 'tick'; at: number }
  | { type: 'probe_result'; at: number; answers: ProbeAnswer[] }
  | { type: 'mdns_result'; at: number; services: MdnsService[] }
  | { type: 'ticket_result'; at: number; route: RoomRoute; ok: boolean; ticket?: RouteTicket | null; revoked?: boolean }
  | { type: 'join_result'; at: number; route: RoomRoute; ok: boolean }
  | { type: 'room_lost'; at: number; route: RoomRoute }
  | { type: 'call_state'; at: number; active: boolean; call_id?: string | null }
  | { type: 'home_network_answer'; at: number; network_id: string; yes: boolean };

export type RouteAction =
  | { type: 'probe'; urls: string[]; timeout_ms: number }
  | { type: 'browse_mdns'; ms: number }
  | { type: 'fetch_ticket'; route: RoomRoute; source: TicketSource; from: string | null }
  | { type: 'join'; route: RoomRoute; url: string; room: string; ticket: TicketSource }
  | { type: 'leave'; route: RoomRoute }
  | { type: 'resume_call'; call_id: string | null }
  | { type: 'ask_home_network'; network_id: string }
  | { type: 'notify'; notice: RouteNotice };

export interface RouteDecision {
  route: RouteName;
  /** 该连的房间 + 票从哪来。 */
  room: { url: string; room: string; ticket: TicketSource } | null;
  /** HTTP 直连 8791 用这个地址;null = 此刻没有确认过的直连地址。 */
  http: string | null;
  /** 多久之后发一个 `tick`;null = 不用再判(撤销了)。 */
  recheck_ms: number | null;
  actions: RouteAction[];
}

export function initialRouteState(facts: RouteFacts): RouteState {
  return {
    facts: copy(facts),
    network: { kind: 'none', id: null },
    now: 0,
    route: 'none',
    joined: null,
    pending: null,
    home: null,
    check: null,
    asking: null,
    asked: [],
    misses: 0,
    left_lan_at: null,
    call: { active: false, call_id: null, resume: false },
    notice: null,
  };
}

export function decideRoute(state: RouteState, event: RouteEvent): { state: RouteState; decision: RouteDecision } {
  const s = copy(state);
  s.now = event.at;
  const acts: RouteAction[] = [];

  const setRoute = (route: RouteName): void => { s.route = route; };

  const notify = (notice: RouteNotice): void => {
    if (s.notice === notice) return;
    s.notice = notice;
    acts.push({ type: 'notify', notice });
  };

  /** 路断了的提示:通话中说的是「这一通断了」。 */
  const notifyDown = (notice: RouteNotice): void => {
    if (s.call.active) {
      s.call.resume = false;
      notify('call_dropped');
      return;
    }
    notify(notice);
  };

  const usable = (ticket: RouteTicket | null): ticket is RouteTicket =>
    ticket !== null && ticket.expires_at - s.now >= ROUTE_SPEC.TICKET_MIN_LEFT_S;

  const revoke = (): void => {
    s.facts.revoked = true;
    if (s.joined !== null) acts.push({ type: 'leave', route: s.joined.route });
    s.joined = null;
    s.pending = null;
    s.home = null;
    s.check = null;
    s.asking = null;
    setRoute('none');
    notify('revoked');
  };

  const relayUnreachable = (): void => {
    if (s.joined !== null) { setRoute(s.joined.route); return; }
    setRoute('none');
    notifyDown('offline');
  };

  const goCloud = (force: boolean): void => {
    if (s.joined?.route === 'cloud') { s.pending = null; setRoute('cloud'); return; }
    if (s.pending?.route === 'cloud') { setRoute('cloud'); return; }
    if (!s.facts.has_relay) {
      // 没有出门线路:本机房间还连着、只是探测没答,就留着。
      if (s.joined?.route === 'lan' && !force) return;
      if (s.joined?.route === 'lan') { acts.push({ type: 'leave', route: 'lan' }); s.joined = null; }
      s.pending = null;
      setRoute('none');
      notifyDown('no_way_out');
      return;
    }
    if (s.joined?.route === 'lan') {
      s.left_lan_at = s.now;
      if (s.call.active) s.call.resume = true;
    }
    setRoute('cloud');
    const ticket = s.facts.tickets.cloud;
    if (usable(ticket)) {
      s.pending = { route: 'cloud', step: 'join', url: ticket.url, room: ticket.room };
      acts.push({ type: 'join', route: 'cloud', url: ticket.url, room: ticket.room, ticket: 'relay' });
    } else {
      s.pending = { route: 'cloud', step: 'ticket', url: null, room: null };
      acts.push({ type: 'fetch_ticket', route: 'cloud', source: 'relay', from: null });
    }
  };

  const wantLan = (): void => {
    const home = s.home;
    if (home === null) return;
    if (home.url === null || home.room === null) {
      // 8791 答了,但本机房间没起:走云房间,HTTP 照样直连。
      notify('local_room_down');
      goCloud(false);
      return;
    }
    if (s.joined?.route === 'lan' && s.joined.url === home.url && s.joined.room === home.room) {
      s.pending = null;
      setRoute('lan');
      return;
    }
    if (s.pending?.route === 'lan') { setRoute('lan'); return; }
    // 通话中、房间还在:不主动换路,挂断后再判。
    if (s.call.active && s.joined !== null) return;
    // 刚从本机房间退出来:先在云房间待满,免得门口来回跳。
    if (s.joined?.route === 'cloud' && s.left_lan_at !== null && s.now - s.left_lan_at < ROUTE_SPEC.BACK_TO_LAN_HOLD_S) return;
    setRoute('lan');
    const ticket = s.facts.tickets.lan;
    if (usable(ticket) && ticket.room === home.room) {
      s.pending = { route: 'lan', step: 'join', url: home.url, room: home.room };
      acts.push({ type: 'join', route: 'lan', url: home.url, room: home.room, ticket: 'workbench' });
    } else {
      s.pending = { route: 'lan', step: 'ticket', url: home.url, room: home.room };
      acts.push({ type: 'fetch_ticket', route: 'lan', source: 'workbench', from: home.http });
    }
  };

  const finishCheck = (found: boolean, urgent: boolean): void => {
    s.check = null;
    if (found) { s.misses = 0; wantLan(); return; }
    s.misses += 1;
    if (s.route === 'lan' && s.joined?.route === 'lan' && !urgent
      && (s.misses < ROUTE_SPEC.LEAVE_LAN_MISSES || s.call.active)) return;
    goCloud(urgent);
  };

  const beginCheck = (urgent: boolean): void => {
    s.check = null;
    const net = s.network;
    const facts = s.facts;
    if (net.kind === 'none') {
      if (s.joined === null) { setRoute('none'); notifyDown('offline'); }
      return;
    }
    if ((net.kind !== 'wifi' && net.kind !== 'ethernet') || net.id === null || !facts.has_lan_token || facts.mac_id === null) {
      finishCheck(false, urgent);
      return;
    }
    if (facts.trusted_networks.includes(net.id)) {
      if (facts.lan_urls.length > 0) {
        s.check = { phase: 'known', urgent, tried: [...facts.lan_urls] };
        acts.push({ type: 'probe', urls: [...facts.lan_urls], timeout_ms: ROUTE_SPEC.PROBE_TIMEOUT_MS });
      } else {
        s.check = { phase: 'mdns', urgent, tried: [] };
        acts.push({ type: 'browse_mdns', ms: ROUTE_SPEC.MDNS_BROWSE_MS });
      }
      return;
    }
    // 没确认过的网络:按出门走;手机另外只听 mDNS(不带令牌问任何地址),看到配对过的那台再问一句。
    if (facts.kind === 'phone' && !facts.declined_networks.includes(net.id) && !s.asked.includes(net.id) && s.asking !== net.id) {
      s.asking = net.id;
      acts.push({ type: 'browse_mdns', ms: ROUTE_SPEC.MDNS_BROWSE_MS });
    }
    finishCheck(false, urgent);
  };

  if (s.facts.revoked) {
    // 撤销之后什么都不做;撤销前发出去的进房如果成了,退出来。
    if (event.type === 'join_result' && event.ok) acts.push({ type: 'leave', route: event.route });
    return { state: s, decision: decisionOf(s, acts) };
  }

  switch (event.type) {
    case 'start': {
      s.network = copy(event.network);
      s.route = 'none';
      s.joined = null;
      s.pending = null;
      s.home = null;
      s.check = null;
      s.asking = null;
      s.asked = [];
      s.misses = 0;
      s.left_lan_at = null;
      s.call = { active: false, call_id: null, resume: false };
      s.notice = null;
      beginCheck(true);
      break;
    }
    case 'net_changed': {
      const changed = event.network.kind !== s.network.kind || event.network.id !== s.network.id;
      s.network = copy(event.network);
      if (changed) {
        s.home = null;
        s.asking = null;
        if (s.pending?.route === 'lan') s.pending = null;
      }
      beginCheck(changed);
      break;
    }
    case 'tick': {
      beginCheck(false);
      break;
    }
    case 'probe_result': {
      const check = s.check;
      if (check === null || check.phase === 'mdns') break;
      const mine = s.facts.mac_id;
      if (event.answers.some((a) => a.status === 'unauthorized' && present(a.mac_id) && a.mac_id === mine)) { revoke(); break; }
      // 明说是别的机器的地址:从候选表里拿掉,下次不再把令牌发给它。
      const others = event.answers.filter((a) => present(a.mac_id) && a.mac_id !== mine).map((a) => a.url);
      s.facts.lan_urls = s.facts.lan_urls.filter((u) => !others.includes(u));
      const match = event.answers.find((a) => a.status === 'ok' && present(a.mac_id) && a.mac_id === mine);
      if (match !== undefined) {
        s.home = {
          http: match.url,
          url: present(match.lan_url) ? match.lan_url : null,
          room: present(match.room) ? match.room : null,
          network_id: s.network.id,
        };
        s.facts.lan_urls = [match.url, ...s.facts.lan_urls.filter((u) => u !== match.url)].slice(0, ROUTE_SPEC.LAN_URLS_MAX);
        finishCheck(true, check.urgent);
        break;
      }
      if (check.phase === 'known') {
        s.check = { phase: 'mdns', urgent: check.urgent, tried: check.tried };
        acts.push({ type: 'browse_mdns', ms: ROUTE_SPEC.MDNS_BROWSE_MS });
        break;
      }
      finishCheck(false, check.urgent);
      break;
    }
    case 'mdns_result': {
      const check = s.check;
      const mine = s.facts.mac_id;
      if (check !== null && check.phase === 'mdns') {
        const candidates: string[] = [];
        for (const svc of event.services) {
          if (present(svc.mac_id) && svc.mac_id !== mine) continue;
          if (check.tried.includes(svc.url) || candidates.includes(svc.url)) continue;
          candidates.push(svc.url);
        }
        if (candidates.length > 0) {
          s.check = { phase: 'found', urgent: check.urgent, tried: [...check.tried, ...candidates] };
          acts.push({ type: 'probe', urls: candidates, timeout_ms: ROUTE_SPEC.PROBE_TIMEOUT_MS });
        } else {
          finishCheck(false, check.urgent);
        }
        break;
      }
      if (s.asking !== null) {
        const networkId = s.asking;
        s.asking = null;
        if (networkId === s.network.id
          && !s.facts.trusted_networks.includes(networkId)
          && !s.facts.declined_networks.includes(networkId)
          && event.services.some((svc) => present(svc.mac_id) && svc.mac_id === mine)) {
          s.asked.push(networkId);
          acts.push({ type: 'ask_home_network', network_id: networkId });
        }
      }
      break;
    }
    case 'ticket_result': {
      if (event.revoked === true) { revoke(); break; }
      const got = event.ok && event.ticket !== undefined && event.ticket !== null ? event.ticket : null;
      if (got !== null) s.facts.tickets[event.route] = { url: got.url, room: got.room, expires_at: got.expires_at };
      const pending = s.pending;
      // 续期或过时的回包:只存。
      if (pending === null || pending.route !== event.route || pending.step !== 'ticket') break;
      if (got !== null) {
        const url = event.route === 'lan' ? pending.url ?? got.url : got.url;
        const room = event.route === 'lan' ? pending.room ?? got.room : got.room;
        s.pending = { route: event.route, step: 'join', url, room };
        acts.push({ type: 'join', route: event.route, url, room, ticket: sourceOf(event.route) });
        break;
      }
      s.pending = null;
      if (event.route === 'lan') { notify('local_room_down'); goCloud(false); } else relayUnreachable();
      break;
    }
    case 'join_result': {
      const pending = s.pending;
      if (pending === null || pending.route !== event.route || pending.step !== 'join') {
        // 进了一间已经不要的房:退出来。
        if (event.ok && s.joined?.route !== event.route) acts.push({ type: 'leave', route: event.route });
        break;
      }
      s.pending = null;
      if (event.ok) {
        const previous = s.joined;
        s.joined = { route: event.route, url: pending.url ?? '', room: pending.room ?? '' };
        setRoute(event.route);
        // 先在新房里续上这一通,再退旧房:反过来工人会当她挂了。
        if (s.call.active && s.call.resume) {
          acts.push({ type: 'resume_call', call_id: s.call.call_id });
          s.call.resume = false;
        }
        if (previous !== null && previous.route !== event.route) acts.push({ type: 'leave', route: previous.route });
        if (event.route === 'lan' || s.notice !== 'local_room_down') s.notice = null;
        break;
      }
      if (event.route === 'lan') { notify('local_room_down'); goCloud(false); } else relayUnreachable();
      break;
    }
    case 'room_lost': {
      if (s.joined === null || s.joined.route !== event.route) break;
      s.joined = null;
      if (event.route === 'lan') s.left_lan_at = s.now;
      if (s.call.active) s.call.resume = true;
      // 通话中本机房间掉了:直接去云房间续上,不先探测。
      if (event.route === 'lan' && s.call.active && s.facts.has_relay) { goCloud(true); break; }
      beginCheck(true);
      break;
    }
    case 'call_state': {
      const was = s.call.active;
      if (event.active) {
        if (!was) s.call = { active: true, call_id: event.call_id ?? null, resume: false };
        else s.call.call_id = event.call_id ?? s.call.call_id;
        break;
      }
      s.call = { active: false, call_id: null, resume: false };
      if (was) beginCheck(false);
      break;
    }
    case 'home_network_answer': {
      const facts = s.facts;
      facts.trusted_networks = facts.trusted_networks.filter((n) => n !== event.network_id);
      facts.declined_networks = facts.declined_networks.filter((n) => n !== event.network_id);
      if (event.yes) facts.trusted_networks.push(event.network_id);
      else facts.declined_networks.push(event.network_id);
      if (event.yes && event.network_id === s.network.id) beginCheck(false);
      break;
    }
    default:
      break;
  }

  return { state: s, decision: decisionOf(s, acts) };
}

function decisionOf(s: RouteState, actions: RouteAction[]): RouteDecision {
  return { route: s.route, room: roomOf(s), http: httpOf(s), recheck_ms: recheckOf(s), actions };
}

function roomOf(s: RouteState): RouteDecision['room'] {
  if (s.route === 'lan' && s.home !== null && s.home.url !== null && s.home.room !== null) {
    return { url: s.home.url, room: s.home.room, ticket: 'workbench' };
  }
  const cloud = s.facts.tickets.cloud;
  if (s.route === 'cloud' && cloud !== null) return { url: cloud.url, room: cloud.room, ticket: 'relay' };
  return null;
}

function httpOf(s: RouteState): string | null {
  return s.home !== null && s.misses === 0 ? s.home.http : null;
}

function recheckOf(s: RouteState): number | null {
  if (s.facts.revoked) return null;
  if (s.route === 'lan') return s.misses > 0 ? ROUTE_SPEC.RECHECK_AFTER_MISS_MS : ROUTE_SPEC.RECHECK_LAN_MS;
  if (s.route === 'cloud') {
    if (s.left_lan_at !== null) {
      const left = ROUTE_SPEC.BACK_TO_LAN_HOLD_S - (s.now - s.left_lan_at);
      if (left > 0) return Math.min(ROUTE_SPEC.RECHECK_CLOUD_MS, left * 1000);
    }
    return ROUTE_SPEC.RECHECK_CLOUD_MS;
  }
  return ROUTE_SPEC.RECHECK_NONE_MS;
}

function sourceOf(route: RoomRoute): TicketSource {
  return route === 'lan' ? 'workbench' : 'relay';
}

function present(value: string | null | undefined): value is string {
  return typeof value === 'string' && value !== '';
}

function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
