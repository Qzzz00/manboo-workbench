/**
 * 工作台线上协议的等价副本。
 *
 * 为什么是副本而不是 import：本仓库两个顶层子目录工具链独立
 * （workbench-plugin 用 tsdown，display-client 用 Vite），互不 import 是仓库约定。
 * 这是一份 wire 协议，副本是可接受的代价。
 *
 * ★ 真相源是 `workbench-plugin/src/protocol.ts`。改那边必须同步这里。
 */

export type AgentId = 'dsh' | 'claude' | 'codex' | 'kimi';

export const AGENT_IDS: readonly AgentId[] = ['dsh', 'claude', 'codex', 'kimi'];

export type SessionStatus = 'waiting' | 'running' | 'done' | 'error' | 'offline';

export type EventReason =
  | 'permission_prompt'
  | 'idle_prompt'
  | 'stop'
  | 'error'
  | 'interrupted'
  | 'offline';

export interface WorkbenchEvent {
  agent: AgentId;
  session_id: string;
  project?: string;
  cwd?: string;
  type: SessionStatus;
  reason?: EventReason;
  title?: string;
  summary?: string;
  ts?: number;
}

export interface SessionView {
  agent: AgentId;
  session_id: string;
  project: string;
  cwd?: string;
  status: SessionStatus;
  reason?: EventReason;
  title?: string;
  summary?: string;
  elapsed_sec: number;
  last_output_sec?: number;
  unread: boolean;
  updated_at: string;
}

export interface AgentView {
  id: AgentId;
  online: boolean;
  connected: boolean;
  waiting: number;
  running: number;
}

/**
 * 一份额度**截至什么时候**(2026-10-02,卡 QA)。真相源 `workbench-plugin/src/protocol.ts`
 * 的 `QuotaAsOf`;那条线与那两句人话的对照用例在 `quotaAsOf.test.ts`(读源头文件比对)。
 *
 * 维护者 21:3x:「本机上的 Claude 额度,一晚上了,还是 100%」—— 那个 100% 是 Claude 桌面端 **04:27**
 * 落的样本算出来的,这块屏上到 21:3x 还画着满条。`as_of` 就是那个「截至」,`source` 是哪来的。
 */
export interface QuotaAsOf {
  as_of?: string;
  source?: string;
  /** 过线那一格该多说哪两句(2026-10-02,卡 QK)。真相源那一处:`QuotaStaleHint`。 */
  stale_hint?: QuotaStaleHint;
}

/**
 * **「读不到最新」那一格说清为什么**(2026-10-02,卡 QK)。真相源 `workbench-plugin/src/protocol.ts`
 * 的 `QuotaStaleHint`;对照用例在 `quotaKeyHint.test.ts`(读源头文件比对)。
 *
 * 卡 QA 之后这块屏上写的是「读不到最新的 / 上次 04:27」—— 不骗人了,可**为什么**读不到、
 * 她能做什么,一个字都没有。两句由各家额度来源自己声明(工作台 `quota/liveSources.ts` 一处),
 * 这块屏只负责念:
 * - `why` —— 为什么(「Claude 桌面没在跑」);
 * - `live.why` —— 有一条更实时的来源、缺什么(2026-10-03 起是「点一下「接上」就实时」)。
 *
 * `live.fix` 这块屏**不画** —— 展示台上没有能点的东西(它是看板,不是遥控器),
 * 那颗键只在电脑上出现(`desk_only`)。
 */
export interface QuotaStaleHint {
  why?: string;
  live?: { why: string; fix?: { label: string; at: { group: string; row: string }; desk_only?: true } };
}

export interface BalanceQuota extends QuotaAsOf {
  kind: 'balance';
  currency: string;
  total: string;
  today_spent?: string;
  available: boolean;
}

export interface QuotaWindow {
  label: string;
  left_pct: number;
  reset_at?: string;
}

export interface WindowQuota extends QuotaAsOf {
  kind: 'quota';
  windows: readonly QuotaWindow[];
}

/** 过了这么久就不许再冒充当下(真相源那一处:`QUOTA_AS_OF_STALE_AFTER_MS`)。 */
export const QUOTA_AS_OF_STALE_AFTER_MS = 2 * 60 * 60 * 1000;

/** 过线那一格写的字。 */
export const QUOTA_STALE_VALUE = '读不到最新的';

/** 截至时刻写成人话:今天只写几点,昨天写「昨晚/昨天 HH:MM」,更早带上日期。认不出回 undefined。 */
export function quotaAsOfClock(iso: string, now: Date): string | undefined {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return undefined;
  const pad = (n: number): string => String(n).padStart(2, '0');
  const dayOf = (d: Date): number => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((dayOf(now) - dayOf(at)) / 86_400_000);
  const hhmm = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
  if (days <= 0) return hhmm;
  if (days === 1) return `${at.getHours() >= 18 ? '昨晚' : '昨天'} ${hhmm}`;
  return `${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${hhmm}`;
}

/** 这份额度过线了吗。缺席 / 认不出 / 时钟倒着走都不算过线 —— 不替它判一个旧。 */
export function quotaAsOfStale(asOf: string | undefined, now: Date): boolean {
  if (asOf === undefined) return false;
  const at = new Date(asOf).getTime();
  if (!Number.isFinite(at)) return false;
  const age = now.getTime() - at;
  return Number.isFinite(age) && age > QUOTA_AS_OF_STALE_AFTER_MS;
}

/** 线以内「截至 04:27」,过线「读不到最新的,上次 04:27」。时刻缺席 → undefined,那一行不占位。 */
export function quotaAsOfWords(asOf: string | undefined, now: Date): string | undefined {
  if (asOf === undefined) return undefined;
  const clock = quotaAsOfClock(asOf, now);
  if (clock === undefined) return undefined;
  if (quotaAsOfStale(asOf, now)) return `${QUOTA_STALE_VALUE},上次${/^\d/.test(clock) ? ' ' : ''}${clock}`;
  return `截至 ${clock}`;
}

/** 过线那一格小字的第一段:「上次 04:27」(数字开头留一个空格,中文开头不留)。 */
export function quotaLastSeenWords(clock: string): string {
  return `上次${/^\d/.test(clock) ? ' ' : ''}${clock}`;
}

/**
 * **过线那一格小字里的整句**(2026-10-02,卡 QK)—— 与工作台 `quotaStaleNote` 同一套拼法
 * (对照用例读源头文件比对)。三段,有就说、没有就不占位:
 *
 *   上次 04:27 · Claude 桌面没在跑 · 点一下「接上」就实时
 */
export function quotaStaleNote(asOf: string | undefined, now: Date, hint?: QuotaStaleHint): string {
  const clock = asOf === undefined ? undefined : quotaAsOfClock(asOf, now);
  return [
    ...(clock === undefined ? [] : [quotaLastSeenWords(clock)]),
    ...(hint?.why === undefined ? [] : [hint.why]),
    ...(hint?.live === undefined ? [] : [hint.live.why]),
  ].join(' · ');
}

export interface UnknownQuota {
  kind: 'unknown';
  note?: string;
}

export type QuotaEntry = BalanceQuota | WindowQuota | UnknownQuota;

export interface WorkbenchState {
  agents: readonly AgentView[];
  sessions: readonly SessionView[];
  quota: Partial<Record<AgentId, QuotaEntry>>;
  now: string;
  stale: boolean;
  /** 工作台的手动试铃是否在响（/ring/test）。展示台不消费，仅保持协议副本等价。 */
  test_ringing?: boolean;
  /**
   * 事务官外观那份配置的版本(2026-09-16 起工作台就在发,展示台 09-22 才开始用)。
   * 变了就重新拉 `GET /butler/appearance` —— Mac 上一拖滑杆,这块屏上的粒子球当场跟着变。
   * 从没在 Mac 上存过外观时工作台不发这个字段,所以是可选的。
   */
  appearance_version?: number;
  /**
   * **此刻能不能出声**(2026-09-26,卡 QH)。工作台服务端算好的**一处判断**
   * (`workbench-plugin/src/server/quietHours.ts`),与那边的 `QuietView` 同形。
   *
   * 展示台照 C2「不跑模型、不自己判断」的老规矩:**不算时段**,只读 `active`。
   * 时段里**铃不响**(`display/ringer.ts`)—— 响铃那一格照旧亮着,屏上看得见谁在等他,
   * 只是屋里没声。老工作台没有这一格,**缺席按能出声算**(不替他把铃关掉)。
   */
  quiet?: QuietView;
}

/** 见 {@link WorkbenchState.quiet}。字段名与工作台 `protocol.ts` 的 `QuietView` 一字不差。 */
export interface QuietView {
  active: boolean;
  from?: string;
  to?: string;
  until?: string;
  reason?: string;
}

/**
 * 话机摘挂机事件的类型。offhook=摘机（接听），onhook=挂机，missed=响铃超时没人接。
 * agent/session_id 指的是这通电话对应的会话——话机自己不是会话来源，
 * 所以 AgentId 不加 'pi'（加了会在界面上多出一家"未接入"，见设计文档）。
 */
export type PhoneEventType = 'offhook' | 'onhook' | 'missed';

export type LiveMessage =
  | { kind: 'snapshot'; state: WorkbenchState }
  | { kind: 'event'; event: WorkbenchEvent }
  | { kind: 'ring'; session_id: string; agent: AgentId }
  /**
   * 话机（树莓派+POP）的摘挂机动向，工作台从 POST /phone/event 原样翻出来。
   * 展示台靠 offhook/missed 停铃（来电链 v0，见 docs/设计-来电链-v0.md）。
   */
  | { kind: 'call'; phase: PhoneEventType; agent: AgentId; session_id: string }
  /**
   * 心跳。**必须是应用层消息，不能只靠 WS 协议层的 ping 帧**——浏览器会自动回 pong，
   * 但既不把 ping 也不把 pong 暴露给 JS，展示台那边的看门狗根本看不见协议层心跳。
   * 半开的 TCP（对端已消失、本端仍是 ESTABLISHED）不会派 close 事件，
   * 只有「一段时间内一条消息都没收到」能把它认出来，所以这条必须周期性地发。
   */
  | { kind: 'ping'; ts: number }
  /**
   * 拖拽悬停进出圈信号（悬停高亮 v1）。这条是给 workbench-plugin 客户端点亮槽体虚线用的，
   * **展示台不消费它**——同步进来只是为了让契约诚实：服务端 protocol.ts 里那条注释写着
   * 「display-client 副本本期不同步；它若对未知 kind 只是忽略，不受影响」，
   * 而 2026-08-24 之前展示台的兜底恰恰是「未知即响铃」，于是刷新应用就响铃、
   * 且按钮和网页都停不掉（铃挂在 undefined:undefined 这个坏键上）。
   * 现在 reduceLive 已改成默认忽略，这条只是把类型补齐、把那段历史钉在这里。
   */
  | { kind: 'hover'; inside: boolean };

/** 空快照。展示台任何时刻都要有东西可渲染，不能白屏。 */
export function emptyState(): WorkbenchState {
  return {
    /**
     * **一家都不编**(2026-09-27,卡 HC)。原来这里造四条 `connected:false` 的假行,
     * 可这会儿连 /state 都还没读到过 —— 凭什么知道那台电脑上装着 Claude 和 Kimi?
     * 空着就是真话:`stale: true` 已经把「还没接上」说清楚了。
     */
    agents: [],
    sessions: [],
    quota: {},
    now: new Date().toISOString(),
    stale: true,
  };
}
