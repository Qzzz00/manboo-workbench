/**
 * 展示台会话区与额度区的投影(2026-09-30 横屏补齐)。
 *
 * 维护者看着手机横屏:「Agent 显示都是下线状态,下面的额度也没有,更直接的说,下面的额度是些死的,
 * 不是根据实际账号现在接入了哪些动态展示的」。
 *
 * 09-22 之后 Mac 与手机早就不看老的 `agents[].online` 与写死四家的 `quota` 了:
 *   · 「有哪几家、此刻怎样」只认 `agent_registry`(卡 Q,09-25)—— 窗口型的几家(Muse、豆包办公、Manus…)
 *     只在这里;老 `agents[].online` 的意思是「这次服务启动以来收到过它的事件」,重启后没来事件的一律 false;
 *   · 额度 = 老四家(`quota`,只画装了且接上了的 —— `clients`)+ 其余各家(`agent_quota`,开集)。
 * 展示台这一份照抄那两处的判据(同一条规矩:展示台不自己判断,C2),字段全是 `/state` 原样发来的。
 *
 * 判据出处(口径改了要一起改):
 *   · 灯色 / 接上没有:workbench-plugin/src/client/agentRegistryView.ts `entryLamp` / `entryConnected`;
 *   · 老四家画不画:workbench-plugin/src/client/areaUnlock.ts `quotaAreas`(没装不画;没接上在 Mac 上是解锁卡,
 *     展示台没人点,**不画**);其余各家:AgentQuotaCells.tsx `extraQuotas` / `quotaBar`。
 */
import { formatResetAt, humanDuration } from './displayFeed';
import type { AgentView, QuotaEntry, QuotaWindow, SessionView } from './workbenchProtocol';
import type { QuotaStaleHint } from './workbenchProtocol';
import { QUOTA_STALE_VALUE, quotaAsOfStale, quotaAsOfWords, quotaStaleNote } from './workbenchProtocol';

// ───────────────────── 线上字段(只写展示台用得到的那几格,全是可选:老工作台没有就当没有) ─────────────────────

export interface RegistrySession {
  agent: string;
  session_id: string;
  project?: string;
  status: string;
  reason?: string;
  title?: string;
  summary?: string;
  elapsed_sec?: number;
  unread?: boolean;
  updated_at?: string;
  /** `records`(2026-10-08):读它自己本机记录长出来的。只在登记表里的两种都没有项目名。 */
  via?: 'sessions' | 'window' | 'records';
}

export interface RegistryEntry {
  id: string;
  name: string;
  self?: boolean;
  color?: string;
  app_running?: boolean;
  status: 'running' | 'waiting' | 'idle' | 'unknown';
  title?: string;
  gaps: Partial<Record<'status' | 'title' | 'latest' | 'bubble', string>>;
  sessions: readonly RegistrySession[];
  counts: { running: number; waiting: number; unread: number };
}

export interface AgentQuotaView {
  id: string;
  title: string;
  state: 'numbers' | 'unlimited' | 'unconnected';
  line?: string;
  level?: 'ok' | 'low' | 'empty';
  left_pct?: number;
  windows?: readonly (QuotaWindow & { group?: string })[];
  left?: { text: string; unit?: string; amount?: number };
  reset_at?: string;
  read_at?: string;
  stale?: boolean;
  /** 过线那一格该多说哪两句(2026-10-02,卡 QK)。这块屏只念,不画那颗键(`desk_only`)。 */
  stale_hint?: QuotaStaleHint;
}

export interface BoardState {
  stale: boolean;
  agents: readonly AgentView[];
  sessions: readonly SessionView[];
  quota?: Partial<Record<string, QuotaEntry>>;
  agent_registry?: { entries: readonly RegistryEntry[] };
  agent_quota?: readonly AgentQuotaView[];
  clients?: Partial<Record<string, { installed?: boolean; connected?: boolean }>>;
  model_mode?: string;
}

// ───────────────────── 会话区 ─────────────────────

export type FamilyLamp = 'teal' | 'amber' | 'off';

export interface FamilySession {
  key: string;
  title: string;
  meta: string;
  status: string;
  ringing: boolean;
  unread: boolean;
}

export interface FamilyGroup {
  id: string;
  name: string;
  color?: string;
  lamp: FamilyLamp;
  connected: boolean;
  /** 这一家此刻怎样(「在跑」「空闲」「没接上:…」)。 */
  line: string;
  sessions: readonly FamilySession[];
  waiting: number;
  running: number;
  /** 说完了、他还没看的几条。 */
  unread: number;
}

/** 每家最多摆几条会话。展示台没人滚动,摆多了下面那几家就看不见了。 */
export const SESSIONS_PER_FAMILY = 3;

const OLD_NAMES: Record<string, string> = { dsh: '事务官', claude: 'Claude', codex: 'Codex', kimi: 'Kimi' };
const STATUS_WORD: Record<RegistryEntry['status'], string> = { running: '在跑', waiting: '在等你', idle: '空闲', unknown: '读不到' };
const RANK: Record<string, number> = { waiting: 0, running: 1, error: 3, done: 4, offline: 5 };

function lampOf(entry: RegistryEntry): FamilyLamp {
  if (entry.counts.waiting > 0 || entry.status === 'waiting') return 'amber';
  if (entry.counts.running > 0 || entry.status === 'running') return 'teal';
  return 'off';
}

function connectedOf(entry: RegistryEntry): boolean {
  if (entry.self === true) return true;
  return entry.status !== 'unknown' && entry.gaps.status === undefined;
}

function sessionMeta(session: RegistrySession): string {
  const elapsed = typeof session.elapsed_sec === 'number' && Number.isFinite(session.elapsed_sec) ? session.elapsed_sec : undefined;
  const long = elapsed === undefined ? '' : ` ${humanDuration(elapsed)}`;
  let word: string;
  if (session.status === 'waiting') word = session.reason === 'idle_prompt' ? `等你下一句${long}` : `等你${long}`;
  else if (session.status === 'running') word = `在跑${long}`;
  else if (session.status === 'done') word = session.unread === true ? '刚完成 · 没看' : '说完了';
  else if (session.status === 'error') word = '出错了';
  else word = '离线';
  const where = session.via === 'window' || session.via === 'records' ? '' : (session.project ?? '');
  return where === '' ? word : `${where} · ${word}`;
}

function toRows(sessions: readonly RegistrySession[], ringing: ReadonlySet<string>): FamilySession[] {
  const withKey = sessions.map((s) => ({ s, key: `${s.agent}:${s.session_id}` }));
  const rank = (one: { s: RegistrySession; key: string }): number => {
    if (ringing.has(one.key)) return -1;
    if (one.s.status === 'done' && one.s.unread === true) return 2;
    return RANK[one.s.status] ?? 6;
  };
  return withKey
    .sort((a, b) => rank(a) - rank(b) || (b.s.updated_at ?? '').localeCompare(a.s.updated_at ?? ''))
    .slice(0, SESSIONS_PER_FAMILY)
    .map(({ s, key }) => ({
      key,
      title: s.title ?? s.summary ?? '(无标题)',
      meta: sessionMeta(s),
      status: s.status,
      ringing: ringing.has(key),
      unread: s.unread === true,
    }));
}

/**
 * 会话区一家一组。有登记表就只认它;老工作台(没有这一格)退回老的 `agents` + `sessions`,
 * 那一支**一家都不编**:`agents` 是空的(还没连上)就是空的。
 */
export function familyGroups(state: BoardState, ringing: ReadonlySet<string>): FamilyGroup[] {
  const entries = state.agent_registry?.entries;
  if (entries !== undefined && entries.length > 0) {
    return entries.map((entry) => {
      const connected = connectedOf(entry);
      const line = connected
        ? STATUS_WORD[entry.status]
        : (entry.gaps.status ?? `没接上:读不到 ${entry.name} 在不在跑`);
      return {
        id: entry.id,
        name: entry.name,
        ...(entry.color === undefined ? {} : { color: entry.color }),
        lamp: lampOf(entry),
        connected,
        line,
        sessions: toRows(entry.sessions, ringing),
        waiting: entry.counts.waiting,
        running: entry.counts.running,
        unread: entry.counts.unread,
      };
    });
  }
  return state.agents.map((agent) => {
    const mine = state.sessions.filter((s) => s.agent === agent.id);
    const waiting = mine.filter((s) => s.status === 'waiting').length;
    const running = mine.filter((s) => s.status === 'running').length;
    return {
      id: agent.id,
      name: OLD_NAMES[agent.id] ?? agent.id,
      lamp: waiting > 0 ? 'amber' : running > 0 ? 'teal' : 'off',
      connected: true,
      line: waiting > 0 ? '在等你' : running > 0 ? '在跑' : '空闲',
      sessions: toRows(mine.map((s) => ({ ...s, via: 'sessions' as const })), ringing),
      waiting,
      running,
      unread: mine.filter((s) => s.status === 'done' && s.unread).length,
    };
  });
}

/** 会话区标题右边那一行:各家加起来。 */
export function boardCounts(groups: readonly FamilyGroup[]): { waiting: number; done: number; running: number } {
  return groups.reduce(
    (sum, g) => ({ waiting: sum.waiting + g.waiting, done: sum.done + g.unread, running: sum.running + g.running }),
    { waiting: 0, done: 0, running: 0 },
  );
}

// ───────────────────── 额度区 ─────────────────────

export type QuotaLevel = 'ok' | 'warn' | 'danger';

export interface QuotaLineBar {
  label: string;
  pct: number;
  level: QuotaLevel;
  /**
   * 这一扇窗口的重置时刻(人话:「今天 22:21」「明天 00:00」「10-04」)。**逐窗口挂**:只挑最紧的写,
   * 会被读成整个额度那时才回来(真机误读实锤,Ben 点名要逐窗口;原 displayFeed.ts quotaCells 那条规矩)。
   */
  reset?: string;
}

export interface QuotaLine {
  id: string;
  name: string;
  /** 最多两条。 */
  bars: readonly QuotaLineBar[];
  /** 没有分母的(余额、积分、不限):只写这个字,不画条。 */
  value?: string;
  /** 小字:重置时刻 / 「09-26 读到的」/「工作台提供」。 */
  note?: string;
  /** 这个数是上次读到的、此刻读不到新的。 */
  stale: boolean;
}

/** 老四家(有专门读法、在 `/state.quota` 里的那几家)。 */
const OLD_FOUR: readonly string[] = ['dsh', 'claude', 'codex', 'kimi'];
const OLD_QUOTA_NAMES: Record<string, string> = { dsh: 'DeepSeek', claude: 'Claude', codex: 'Codex', kimi: 'Kimi' };
export const QUOTA_WARN_PCT = 20;
const MAX_BARS = 2;

function levelOf(pct: number): QuotaLevel {
  if (pct <= 0) return 'danger';
  return pct < QUOTA_WARN_PCT ? 'warn' : 'ok';
}

/** 窗口名缩成一两个字:Antigravity 的「Weekly Limit Remaining」= 周,「Five Hour Limit Remaining」= 5h。 */
export function shortWindowLabel(label: string): string {
  const text = label.trim();
  if (/week|周/i.test(text)) return '周';
  if (/five\s*hour|5\s*h|5\s*小时|当前时段/i.test(text)) return '5h';
  if (/day|today|今日|每日|日/i.test(text)) return '今日';
  if (/month|月/i.test(text)) return '月';
  return text.length > 4 ? text.slice(0, 4) : text;
}

/** 同名窗口(分了组的)取最紧的那一条,按第一次出现的顺序,最多两条。重置时刻跟着那一条走。 */
function barsFrom(windows: readonly { label: string; left_pct: number; reset_at?: string }[], now: Date): QuotaLineBar[] {
  const order: string[] = [];
  const least = new Map<string, { pct: number; reset_at?: string }>();
  for (const w of windows) {
    if (typeof w.left_pct !== 'number' || !Number.isFinite(w.left_pct)) continue;
    const label = shortWindowLabel(w.label);
    const pct = Math.max(0, Math.min(100, Math.round(w.left_pct)));
    const seen = least.get(label);
    if (seen === undefined) order.push(label);
    if (seen === undefined || pct < seen.pct) least.set(label, { pct, ...(w.reset_at === undefined ? {} : { reset_at: w.reset_at }) });
  }
  return order.slice(0, MAX_BARS).map((label) => {
    const one = least.get(label)!;
    const reset = one.reset_at === undefined ? undefined : formatResetAt(one.reset_at, now);
    return { label, pct: one.pct, level: levelOf(one.pct), ...(reset === undefined ? {} : { reset }) };
  });
}

function readDate(iso: string | undefined): string | undefined {
  if (iso === undefined) return undefined;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return undefined;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

function oldFourLine(state: BoardState, id: string, now: Date): QuotaLine | undefined {
  const entry = state.quota?.[id];
  if (entry === undefined || entry.kind === 'unknown') return undefined;
  const name = OLD_QUOTA_NAMES[id] ?? id;
  const relay = id === 'dsh' && state.model_mode === 'relay' ? '工作台提供' : undefined;
  /**
   * ★ 2026-10-02(卡 QA;维护者 21:3x:「本机上的 Claude 额度,一晚上了,还是 100%」)。
   *
   * 这几行原来把 `stale` **写死成 false**,小字里一个字都不说那个数多大年纪 —— 04:27 的 100%
   * 在 21:3x 还画着满条。过了那条线(2 小时)就**一条横条都不画**,只写「读不到最新的 / 上次 04:27」。
   * 线以内照画,小字里缀上「截至 HH:MM」。`as_of` 缺席(老宿主)→ 与这一版之前一字不差。
   */
  const asOf = quotaAsOfWords(entry.as_of, now);
  if (quotaAsOfStale(entry.as_of, now)) {
    /**
     * ★ 2026-10-02(卡 QK):小字里**说清为什么**。卡 QA 之后这一行只写「读不到最新的 / 上次 04:27」,
     * 而她在屏前问的下一句是「为什么」。那两句由各家额度来源自己声明、跟着 entry 过来
     * (`stale_hint`),拼法与电脑那一格、手机同一处(`quotaStaleNote`);没声明的那几家一字不变。
     * 那颗入口键这块屏不画 —— 展示台上没有能点的东西。
     */
    return {
      id, name, bars: [], stale: true, value: QUOTA_STALE_VALUE,
      note: quotaStaleNote(entry.as_of, now, entry.stale_hint),
    };
  }
  const note = [...(relay === undefined ? [] : [relay]), ...(asOf === undefined ? [] : [asOf])];
  if (entry.kind === 'balance') {
    return {
      id, name, bars: [], stale: false,
      value: entry.available ? `¥ ${entry.total}` : '不可用',
      ...(note.length === 0 ? {} : { note: note.join(' · ') }),
    };
  }
  const bars = barsFrom(entry.windows, now);
  if (bars.length === 0) return undefined;
  return { id, name, bars, stale: false, ...(note.length === 0 ? {} : { note: note.join(' · ') }) };
}

function extraLine(view: AgentQuotaView, now: Date): QuotaLine | undefined {
  if (view.state === 'unconnected') return undefined;
  const stale = view.stale === true;
  const read = stale ? readDate(view.read_at) : undefined;
  // 卡 QK:旧了的那一行后面跟上来源声明的那两句(为什么 / 配上什么就能实时)。没声明的一字不变。
  const words = !stale
    ? []
    : [
        ...(read === undefined ? [] : [`上次 ${read}`]),
        ...(view.stale_hint?.why === undefined ? [] : [view.stale_hint.why]),
        ...(view.stale_hint?.live === undefined ? [] : [view.stale_hint.live.why]),
      ];
  const note = words.length === 0 ? undefined : words.join(' · ');
  const base = { id: view.id, name: view.title, stale, ...(note === undefined ? {} : { note }) };
  if (view.state === 'unlimited') return { ...base, bars: [], value: '不限' };
  const fromWindows = view.windows === undefined ? [] : barsFrom(view.windows, now);
  if (fromWindows.length > 0) return { ...base, bars: fromWindows };
  if (typeof view.left_pct === 'number') {
    const pct = Math.max(0, Math.min(100, Math.round(view.left_pct)));
    const reset = view.reset_at === undefined ? undefined : formatResetAt(view.reset_at, now);
    return { ...base, bars: [{ label: '剩', pct, level: levelOf(pct), ...(reset === undefined ? {} : { reset }) }] };
  }
  if (view.left !== undefined) return { ...base, bars: [], value: view.left.unit === undefined ? view.left.text : `${view.left.text} ${view.left.unit}` };
  /**
   * 过线那一档**这一行不许消失**(卡 QA):服务端把 `left_pct` / `windows` / `left` 一起摘掉了
   * (陈旧的数不能冒充当下),走到这儿就什么数都没有。原来这里 `return undefined` —— 那一行会
   * 整个从屏上不见,看起来像这一家没接上。摆「读不到最新的」,把真相说出来。
   */
  if (stale) return { ...base, bars: [], value: QUOTA_STALE_VALUE };
  return undefined;
}

/**
 * 额度区的每一行。**只画这台电脑此刻真接上了、真有数的那几家**:
 *   · 老四家:在 `agents` 里(工作台已按探测筛过)、`clients` 说装了且接上了(DeepSeek 不看 clients)、`quota` 有数;
 *   · 其余:`agent_quota` 里老四家之外的,没接上的不画(展示台没人去点「带我过去」)。
 * 一家都没有就是空的,面板自己说一句,不编四格「未接入」。
 */
export function quotaLines(state: BoardState, now: Date = new Date()): QuotaLine[] {
  const shown = state.agents.map((a) => a.id as string);
  const oldIds = (shown.length === 0 ? OLD_FOUR : OLD_FOUR.filter((id) => shown.includes(id)));
  const drawn: QuotaLine[] = [];
  for (const id of oldIds) {
    if (id !== 'dsh') {
      const client = state.clients?.[id];
      if (client !== undefined && (client.installed === false || client.connected === false)) continue;
    }
    const line = oldFourLine(state, id, now);
    if (line !== undefined) drawn.push(line);
  }
  const extras = (state.agent_quota ?? [])
    .filter((view) => !OLD_FOUR.includes(view.id))
    .map((view) => extraLine(view, now))
    .filter((line): line is QuotaLine => line !== undefined);
  return [...drawn, ...extras];
}
