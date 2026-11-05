/**
 * 第二套横屏展示台「环绕」的投影(2026-10-01,Pen.dev 稿「B · 中央粒子与环绕会话」,Codex 画)。
 *
 * 与第一套(displayBoard.ts)读同一份 `/state`、同一套判据(登记表认「有哪几家、接上没有」,
 * 老四家额度看 `clients`),只是**摆法**不同,于是投影的形状不同:
 *   · 会话按**事项**一张卡,不按家分组;只有在跑的连到中央的球,等你的独立摆、不伪装成在执行;
 *   · 额度按**账号**,全部周期都摆(第一套右栏窄,最多两条)、分了模型组的按组摆、不合并;
 *   · 「暂未取得额度」(接上了、没读到数)与「额度未接入」(那一家额度这条路没接)分开说。
 * 不经模型、不编数:读不到就写读不到。
 */
import type { BoardState, RegistryEntry, RegistrySession } from './displayBoard';
import { QUOTA_WARN_PCT, type QuotaLevel } from './displayBoard';
import { QUOTA_STALE_VALUE, quotaAsOfStale, quotaAsOfWords, quotaStaleNote } from './workbenchProtocol';

// ───────────────────── 会话 ─────────────────────

/** 中央两侧最多摆几张卡(稿子:左二右二)。 */
export const MAX_ORBIT_SESSIONS = 4;

export interface OrbitCard {
  key: string;
  agentId: string;
  agentName: string;
  color?: string;
  title: string;
  /** 最新进展 · 多久前(读不到的那一半不写)。 */
  sub: string;
  status: 'running' | 'waiting' | 'error' | 'done';
  statusText: string;
  /** 只有在跑的连到中央的球。 */
  linked: boolean;
  ringing: boolean;
}

const OLD_NAMES: Record<string, string> = { dsh: '事务官', claude: 'Claude', codex: 'Codex', kimi: 'Kimi' };
const STATUS_TEXT: Record<OrbitCard['status'], string> = { running: '在跑', waiting: '等你', error: '出错了', done: '刚完成' };
/** 挑哪几张上屏:越急越先。 */
const PICK_RANK: Record<OrbitCard['status'], number> = { waiting: 0, error: 1, running: 2, done: 3 };
/** 挑出来之后怎么摆:在跑的在前(连线的那几张靠近球的上方),等你的在后。 */
const SHOW_RANK: Record<OrbitCard['status'], number> = { running: 0, waiting: 1, error: 2, done: 3 };

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** 「刚刚 / N分钟前 / N小时前 / MM-DD」。读不出时间就不写(不编一个)。 */
export function relativeAgo(iso: string | undefined, now: Date): string | undefined {
  if (iso === undefined) return undefined;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return undefined;
  const sec = Math.max(0, (now.getTime() - at.getTime()) / 1000);
  if (sec < 60) return '刚刚';
  if (sec < 3600) return `${Math.floor(sec / 60)}分钟前`;
  if (sec < 86_400) return `${Math.floor(sec / 3600)}小时前`;
  return `${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

function cardStatus(s: RegistrySession): OrbitCard['status'] | undefined {
  if (s.status === 'running' || s.status === 'waiting' || s.status === 'error') return s.status;
  if (s.status === 'done' && s.unread === true) return 'done';
  return undefined;
}

function connected(entry: RegistryEntry): boolean {
  if (entry.self === true) return true;
  return entry.status !== 'unknown' && entry.gaps.status === undefined;
}

function toCard(s: RegistrySession, who: { id: string; name: string; color?: string }, ringing: ReadonlySet<string>, now: Date): OrbitCard | undefined {
  const status = cardStatus(s);
  if (status === undefined) return undefined;
  const key = `${s.agent}:${s.session_id}`;
  const title = s.title ?? s.summary ?? '(无标题)';
  const progress = s.summary !== undefined && s.summary !== title ? s.summary
    : status === 'waiting' && s.reason === 'idle_prompt' ? '等你下一句'
      : s.via === 'window' || s.via === 'records' ? undefined : s.project;
  const ago = status === 'waiting' ? undefined : relativeAgo(s.updated_at, now);
  return {
    key,
    agentId: who.id,
    agentName: who.name,
    ...(who.color === undefined ? {} : { color: who.color }),
    title,
    sub: [progress, ago].filter((x): x is string => x !== undefined && x !== '').join(' · '),
    status,
    statusText: STATUS_TEXT[status],
    linked: status === 'running',
    ringing: ringing.has(key),
  };
}

/**
 * 中央两侧那几张卡。有登记表就只认它(没接上的那家不摆会话,同第一套);
 * 老工作台退回老 `sessions`,一条不编。
 */
export function orbitSessions(state: BoardState, ringing: ReadonlySet<string>, now: Date = new Date()): OrbitCard[] {
  const entries = state.agent_registry?.entries;
  const cards: OrbitCard[] = [];
  if (entries !== undefined && entries.length > 0) {
    for (const entry of entries) {
      if (!connected(entry)) continue;
      const who = { id: entry.id, name: entry.name, ...(entry.color === undefined ? {} : { color: entry.color }) };
      for (const s of entry.sessions) {
        const card = toCard(s, who, ringing, now);
        if (card !== undefined) cards.push(card);
      }
    }
  } else {
    for (const s of state.sessions) {
      const card = toCard({ ...s, via: 'sessions' }, { id: s.agent, name: OLD_NAMES[s.agent] ?? s.agent }, ringing, now);
      if (card !== undefined) cards.push(card);
    }
  }
  const urgency = (c: OrbitCard): number => (c.ringing ? -1 : PICK_RANK[c.status]);
  return cards
    .map((c, i) => ({ c, i }))
    .sort((a, b) => urgency(a.c) - urgency(b.c) || a.i - b.i)
    .slice(0, MAX_ORBIT_SESSIONS)
    .sort((a, b) => SHOW_RANK[a.c.status] - SHOW_RANK[b.c.status] || a.i - b.i)
    .map(({ c }) => c);
}

/** 前一半在左、后一半在右;单数时左边多一张。 */
export function splitSides<T>(items: readonly T[]): [T[], T[]] {
  const left = Math.ceil(items.length / 2);
  return [items.slice(0, left), items.slice(left)];
}

// ───────────────────── 额度 ─────────────────────

/** 同屏最多几个账号(稿子验到九个:三列三排)。 */
export const MAX_QUOTA_ACCOUNTS = 9;

export interface QuotaWindowView {
  label: string;
  pct: number;
  level: QuotaLevel;
}

export interface QuotaAccount {
  id: string;
  name: string;
  /** 不分组的那几扇窗,一个不省。 */
  windows: readonly QuotaWindowView[];
  /** 分了模型组的(Antigravity):按组摆,不合并、不取最低。 */
  groups?: readonly { name: string; windows: readonly QuotaWindowView[] }[];
  /** 没有分母的(余额、积分、不限)。 */
  value?: string;
  /** 「暂未取得额度」/「额度未接入」。 */
  empty?: string;
  /** 「09-27 读到的」/「工作台提供」。 */
  note?: string;
  stale: boolean;
}

const OLD_FOUR: readonly string[] = ['dsh', 'claude', 'codex', 'kimi'];
const OLD_QUOTA_NAMES: Record<string, string> = { dsh: 'DeepSeek', claude: 'Claude', codex: 'Codex', kimi: 'Kimi' };
export const NO_NUMBERS = '暂未取得额度';
export const NOT_HOOKED = '额度未接入';

/** 工作台发来的窗口名是缩写(5h / 周 / 总 / 模型名),这一套地方够,写全。 */
export function windowName(label: string): string {
  const text = label.trim();
  if (/^5\s*h$/i.test(text) || /five\s*hour/i.test(text)) return '5小时';
  if (/week/i.test(text)) return '周';
  if (/daily|today|\bday\b/i.test(text)) return '今日';
  if (/month/i.test(text)) return '月';
  if (text === '总') return '总量';
  return text;
}

function levelOf(pct: number): QuotaLevel {
  if (pct <= 0) return 'danger';
  return pct < QUOTA_WARN_PCT ? 'warn' : 'ok';
}

function view(w: { label: string; left_pct: number }): QuotaWindowView | undefined {
  if (typeof w.left_pct !== 'number' || !Number.isFinite(w.left_pct)) return undefined;
  const pct = Math.max(0, Math.min(100, Math.round(w.left_pct)));
  return { label: windowName(w.label), pct, level: levelOf(pct) };
}

function views(windows: readonly { label: string; left_pct: number }[]): QuotaWindowView[] {
  return windows.map(view).filter((w): w is QuotaWindowView => w !== undefined);
}

function readDate(iso: string | undefined): string | undefined {
  if (iso === undefined) return undefined;
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? undefined : `${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

function oldFour(state: BoardState, id: string, now: Date): QuotaAccount | undefined {
  if (id !== 'dsh') {
    const client = state.clients?.[id];
    if (client !== undefined && (client.installed === false || client.connected === false)) return undefined;
  }
  const entry = state.quota?.[id];
  const name = OLD_QUOTA_NAMES[id] ?? id;
  const relay = id === 'dsh' && state.model_mode === 'relay' ? '工作台提供' : undefined;
  /**
   * ★ 2026-10-02(卡 QA):这一格原来把 `stale` **写死成 false** —— 04:27 的 100% 在 21:3x
   * 还画着满条。过线(2 小时)就不出百分比,只写「读不到最新的 / 上次 04:27」;线以内缀「截至 HH:MM」。
   */
  // `unknown` 那一格没有数、也就没有截至时刻 —— 不给它编一个。
  const at = entry === undefined || entry.kind === 'unknown' ? undefined : entry.as_of;
  const asOf = quotaAsOfWords(at, now);
  if (quotaAsOfStale(at, now)) {
    /**
     * ★ 2026-10-02(卡 QK):这条横条下面**说清为什么**(「Claude 桌面没在跑 ·
     * 点一下「接上」就实时」)。两句由各家额度来源自己声明,拼法与电脑那一格、
     * 手机同一处(`quotaStaleNote`);没声明的那几家只剩「上次 HH:MM」,与卡 QA 一字不差。
     * 那颗入口键这块屏不画(`desk_only`:她得在电脑前做)。
     */
    return {
      id, name, windows: [], stale: true, value: QUOTA_STALE_VALUE,
      note: quotaStaleNote(at, now, entry === undefined || entry.kind === 'unknown' ? undefined : entry.stale_hint),
    };
  }
  const note = [...(relay === undefined ? [] : [relay]), ...(asOf === undefined ? [] : [asOf])];
  const base = {
    id, name, windows: [] as QuotaWindowView[], stale: false,
    ...(note.length === 0 ? {} : { note: note.join(' · ') }),
  };
  if (entry === undefined || entry.kind === 'unknown') return { ...base, empty: NO_NUMBERS };
  if (entry.kind === 'balance') return { ...base, value: entry.available ? `¥ ${entry.total}` : '不可用' };
  const windows = views(entry.windows);
  return windows.length > 0 ? { ...base, windows } : { ...base, empty: NO_NUMBERS };
}

function extra(q: NonNullable<BoardState['agent_quota']>[number]): QuotaAccount {
  const stale = q.stale === true;
  const read = stale ? readDate(q.read_at) : undefined;
  // 卡 QK:旧了的那一行后面跟上来源声明的那两句。没声明的一字不变。
  const words = !stale
    ? []
    : [
        ...(read === undefined ? [] : [`上次 ${read}`]),
        ...(q.stale_hint?.why === undefined ? [] : [q.stale_hint.why]),
        ...(q.stale_hint?.live === undefined ? [] : [q.stale_hint.live.why]),
      ];
  const base = { id: q.id, name: q.title, windows: [] as QuotaWindowView[], stale, ...(words.length === 0 ? {} : { note: words.join(' · ') }) };
  if (q.state === 'unconnected') return { ...base, empty: NOT_HOOKED };
  if (q.state === 'unlimited') return { ...base, value: '不限' };
  const windows = q.windows ?? [];
  if (windows.some((w) => w.group !== undefined)) {
    const order: string[] = [];
    const byGroup = new Map<string, QuotaWindowView[]>();
    for (const w of windows) {
      const name = w.group ?? '';
      const one = view(w);
      if (one === undefined) continue;
      if (!byGroup.has(name)) { order.push(name); byGroup.set(name, []); }
      byGroup.get(name)!.push(one);
    }
    if (order.length > 0) return { ...base, groups: order.map((name) => ({ name, windows: byGroup.get(name)! })) };
  }
  const flat = views(windows);
  if (flat.length > 0) return { ...base, windows: flat };
  if (typeof q.left_pct === 'number') {
    const one = view({ label: '剩余', left_pct: q.left_pct });
    if (one !== undefined) return { ...base, windows: [one] };
  }
  if (q.left !== undefined) return { ...base, value: q.left.unit === undefined ? q.left.text : `${q.left.text} ${q.left.unit}` };
  /**
   * 过线那一档(卡 QA):服务端把 `left_pct` / `windows` / `left` 一起摘掉了,走到这儿什么数都没有。
   * 原来落到「额度未接入」那一句上 —— 那是「从没接上」的说法,这一家明明读到过。说真话:「读不到最新的」。
   */
  if (stale) return { ...base, value: QUOTA_STALE_VALUE };
  return { ...base, empty: NO_NUMBERS };
}

/**
 * 额度区的每个账号。老四家:在 `agents` 里、`clients` 没说没装 / 没接上(DeepSeek 不看 clients);
 * 其余:`agent_quota` 里老四家之外的,全摆(没接入的也摆一行「额度未接入」—— 稿子要求所有 Agent 一眼可见)。
 * 超过九个不缩字号、不省周期,只报「另有 N 个账号」。
 */
export function quotaAccounts(state: BoardState, now: Date = new Date()): { accounts: QuotaAccount[]; hidden: number } {
  const shown = state.agents.map((a) => a.id as string);
  const oldIds = shown.length === 0 ? OLD_FOUR.filter((id) => state.quota?.[id] !== undefined) : OLD_FOUR.filter((id) => shown.includes(id));
  const all: QuotaAccount[] = [];
  for (const id of oldIds) {
    const one = oldFour(state, id, now);
    if (one !== undefined) all.push(one);
  }
  for (const q of state.agent_quota ?? []) {
    if (!OLD_FOUR.includes(q.id)) all.push(extra(q));
  }
  return { accounts: all.slice(0, MAX_QUOTA_ACCOUNTS), hidden: Math.max(0, all.length - MAX_QUOTA_ACCOUNTS) };
}

/** 额度区右上那一句。断开了要明示(C1),照旧摆最后一次已知状态。 */
export function syncLine(feed: { stale: boolean; received: boolean }): { text: string; alert: boolean } {
  if (feed.stale) return { text: '和电脑断开了 · 显示最后一次已知状态', alert: true };
  if (!feed.received) return { text: '正在等电脑的状态', alert: false };
  return { text: '与电脑同步中', alert: false };
}
