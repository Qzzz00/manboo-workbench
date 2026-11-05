/**
 * 真实 core 投影的消费模型(2026-10-24,小K,阶段 2)。
 *
 * 公共类型来自 core 同源的 api/protocol；Raw 形状仅归一显示字段，并在网络边界守卫坏数据。
 */
import type { ActorContext } from './collabModel';
import { actorLabel, actorName } from './collabModel';
import type { RawGoal } from './collabState';
import type { GoalConditionState, GoalConditionVerification, RunSegment } from '../api/protocol';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function isStr(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

/** 一条能力条件的核验留痕(与 core `GoalConditionVerification` 同形子集)。 */
export type RawVerification = GoalConditionVerification;

/** 一条能力条件(与 core `GoalCondition` 同形子集)。 */
export interface RawCondition {
  id: string;
  text: string;
  taskId?: string;
  evidence?: readonly string[];
  verifications: readonly RawVerification[];
  deliveredAt?: string;
  createdAt: string;
  updatedAt: string;
}

export type GoalConditionStateName = GoalConditionState;

/** 状态名归一(与 core 口径逐字对应的中文)。 */
export const GOAL_CONDITION_STATE_TITLES: Readonly<Record<GoalConditionStateName, string>> = {
  pending: '尚未安排',
  dispatched: '已派出,开工未确认',
  doing: '进行中',
  unknown: '状态未知',
  blocked: '受阻',
  submitted: '交回待验',
  rework: '退回重做',
  verified: '已验待交付',
  delivered: '当前可用(已交付)',
};

/** board 投影里的一条条件(与 core 同形子集)。 */
export interface RawBoardItem {
  id: string;
  text: string;
  state: GoalConditionStateName;
  taskId?: string;
  assignee?: string;
  lastReceiptAt?: string;
  blocker?: { reason?: string; next?: string };
}

/** `GET /collab/goal/board` 回包(与 core `GoalBoardSummary` 同形子集)。 */
export interface RawBoardSummary {
  goalId: string;
  scope: string;
  items: readonly RawBoardItem[];
  canceled: number;
  unscheduled: number;
}

/** 板上的一条条件行:服务端给状态,账上给核验留痕与交付时刻。 */
export interface ConditionRowReal {
  id: string;
  text: string;
  state: GoalConditionStateName;
  taskId?: string;
  assigneeName?: string;
  lastReceiptAt?: string;
  blocker?: { reason?: string; next?: string };
  evidence: readonly string[];
  verifications: readonly RawVerification[];
  deliveredAt?: string;
}

/**
 * board 投影 × 条件账 → 条件行。board 里没有的条件(脏数据)跳过不编造;
 * 核验留痕原样保留 —— 轮次不符的旧核验在账上(历史依据),状态只看服务端。
 */
export function conditionRowsFromBoard(
  board: RawBoardSummary,
  conditions: readonly RawCondition[],
  actors?: ActorContext,
): ConditionRowReal[] {
  const byId = new Map(conditions.map((c) => [c.id, c]));
  const out: ConditionRowReal[] = [];
  for (const item of board.items) {
    const cond = byId.get(item.id);
    out.push({
      id: item.id,
      text: item.text,
      state: item.state,
      ...(item.taskId === undefined ? {} : { taskId: item.taskId }),
      ...(item.assignee === undefined || actors === undefined ? {} : { assigneeName: actorName(item.assignee, actors) }),
      ...(item.lastReceiptAt === undefined ? {} : { lastReceiptAt: item.lastReceiptAt }),
      ...(item.blocker === undefined ? {} : { blocker: item.blocker }),
      evidence: cond?.evidence ?? [],
      verifications: cond?.verifications ?? [],
      ...(cond?.deliveredAt === undefined ? {} : { deliveredAt: cond.deliveredAt }),
    });
  }
  return out;
}

/** 有真实条件的目标(RawGoal 扩展)。 */
export type RawGoalWithConditions = RawGoal & { conditions?: readonly RawCondition[] };

/** 目标有没有条件;没有 = 无条件(显示未设置,不按卡数偷算达成)。 */
export function goalHasConditions(goal: RawGoalWithConditions): boolean {
  return (goal.conditions?.length ?? 0) > 0;
}

/** 投递状态名归一:三态不混。 */
export const DELIVERY_STATUS_TITLES: Readonly<Record<string, string>> = {
  pending: '已受理待处理',
  delivered: '已送达',
  accepted: '已受理',
  failed: '失败',
};

export interface RawDelivery {
  to: string;
  status: string;
  error?: string;
  at: string;
  taskId?: string;
  receipt?: {
    kind: string;
    text: string;
    at: string;
    messageId?: string;
    evidence: readonly string[];
  };
}

/** 一条投递的那一行字;失败带真实原因(unknown target 不当已邀请)。 */
export function deliveryTitle(d: RawDelivery, actors?: ActorContext): string {
  const title = DELIVERY_STATUS_TITLES[d.status] ?? d.status;
  const who = actors === undefined ? '' : `${actorName(d.to, actors)}:`;
  return d.status === 'failed' && d.error !== undefined && d.error !== ''
    ? `${who}${title}(${d.error})`
    : `${who}${title}`;
}

/** 一条留言(与 core `NoteMessage` 同形子集)。 */
export interface RawMessage {
  id: string;
  by: string;
  text: string;
  at: string;
  intent: string;
  mentions?: readonly string[];
  replyTo?: string;
  deliveries?: readonly RawDelivery[];
}

/** 关系名归一。 */
export const RELATION_KIND_TITLES: Readonly<Record<string, string>> = {
  derived: '衍生',
  depends_on: '依赖',
  handoff: '交接',
  rejected_back: '验收退回',
  reference: '参考',
};

export interface RawRelation {
  id: string;
  fromId: string;
  toId: string;
  kind: string;
  note?: string;
  round?: number;
  stale?: boolean;
}

export interface RelationRow {
  id: string;
  kindTitle: string;
  direction: 'in' | 'out';
  otherId: string;
  note?: string;
  round?: number;
  stale: boolean;
}

/** `GET /collab/relations?task_id=` 的一条 → 行;direction 相对当前卡(从这张出 / 到这张来)。 */
export function relationRowOf(relation: RawRelation, taskId: string): RelationRow {
  const out = relation.fromId === taskId;
  return {
    id: relation.id,
    kindTitle: RELATION_KIND_TITLES[relation.kind] ?? relation.kind,
    direction: out ? 'out' : 'in',
    otherId: out ? relation.toId : relation.fromId,
    ...(relation.note === undefined || relation.note === '' ? {} : { note: relation.note }),
    ...(relation.round === undefined ? {} : { round: relation.round }),
    stale: relation.stale === true,
  };
}

/** 运行片段(与 core `RunSegment` 同形子集)。 */
export type RawRunSegment = Pick<RunSegment, 'execution_started_observed_at' | 'execution_finished_observed_at'> & {
  taskId: string;
  source: string;
  status: string;
  startedAt: string;
  finishedAt?: string;
  pauseReason?: string;
  outcome?: string;
}

export const RUN_STATUS_TITLES: Readonly<Record<string, string>> = {
  dispatched: '已派出,开工未确认',
  running: '实际执行中(有开工回执)',
  paused: '有等待/暂停记录(开工未知)',
  done: '执行已收场(成果另看回执)',
  failed: '收到失败收场记录',
  unknown: '未知(失联或记录过旧)',
};

/** 一段账面记录的那一行字;assigned 只证明派出,不证明真实开工。 */
export function runSegmentLine(seg: RawRunSegment): string {
  const title = RUN_STATUS_TITLES[seg.status] ?? seg.status;
  const parts = [title];
  if (seg.pauseReason !== undefined && seg.pauseReason !== '') parts.push(`停着:${seg.pauseReason}`);
  if (seg.outcome !== undefined && seg.outcome !== '') parts.push(`收场:${seg.outcome}`);
  parts.push(`本机核到开工:${seg.execution_started_observed_at ?? '未知'}`);
  parts.push(`本机收到结果:${seg.execution_finished_observed_at ?? '未知'}`);
  parts.push('观察时刻,非模型精确起止或耗时');
  return parts.join(' · ');
}

/** 容量(与 core `CapacityItem` 同形):在线 / 手上几件 / 未收场几件 / 能接几件,四个事实分开。 */
export interface RawCapacity {
  id: string;
  online: boolean;
  activeJobs: number;
  runningJobs: number;
  limit: number | 'unknown';
}

export function capacityLine(item: RawCapacity, actors?: ActorContext): string {
  const who = actors === undefined ? item.id : actorLabel(item.id, actors);
  return `${who}:${item.online ? '在线' : '离线'} · 手上 ${item.activeJobs} 件 · 实际执行 ${item.runningJobs} 件 · 能接几件:${item.limit === 'unknown' ? '未知' : item.limit}`;
}


export function guardDelivery(v: unknown): RawDelivery | undefined {
  if (!isRecord(v) || !isStr(v.to) || !isStr(v.status) || !isStr(v.at)) return undefined;
  const receipt = isRecord(v.receipt) && isStr(v.receipt.kind) && isStr(v.receipt.text) && isStr(v.receipt.at)
    ? { kind: v.receipt.kind, text: v.receipt.text, at: v.receipt.at,
        ...(isStr(v.receipt.message_id) ? { messageId: v.receipt.message_id } : {}),
        evidence: Array.isArray(v.receipt.evidence) ? v.receipt.evidence.filter(isStr) : [] }
    : undefined;
  return { to: v.to, status: v.status, at: v.at, ...(isStr(v.error) ? { error: v.error } : {}),
    ...(isStr(v.task_id) ? { taskId: v.task_id } : {}), ...(receipt === undefined ? {} : { receipt }) };
}

export function guardMessage(v: unknown): RawMessage | undefined {
  if (!isRecord(v) || !isStr(v.id) || !isStr(v.by) || !isStr(v.text) || !isStr(v.at) || !isStr(v.intent)) return undefined;
  const deliveries = Array.isArray(v.deliveries)
    ? v.deliveries.map(guardDelivery).filter((one): one is RawDelivery => one !== undefined)
    : [];
  return {
    id: v.id, by: v.by, text: v.text, at: v.at, intent: v.intent,
    ...(Array.isArray(v.mentions) && v.mentions.filter(isStr).length > 0 ? { mentions: v.mentions.filter(isStr) } : {}),
    ...(isStr(v.reply_to) ? { replyTo: v.reply_to } : {}),
    ...(deliveries.length > 0 ? { deliveries } : {}),
  };
}

/* ────────────────── 真实回包(wire 形状)→ 消费形状 ────────────────── */


/**
 * `GET /collab/goal/board` 的回包(契约 §1:`{summary:{goal_id, scope, conditions:{items:[…]}, tasks:{canceled, unscheduled}}}`)
 * → 消费形状;认不出 = undefined(调用方显示未知/重试,不编造)。
 */
export function guardBoardSummary(data: unknown): RawBoardSummary | undefined {
  if (!isRecord(data) || !isRecord(data.summary)) return undefined;
  const summary = data.summary;
  if (!isStr(summary.goal_id) || !isStr(summary.scope)) return undefined;
  if (!isRecord(summary.conditions) || !Array.isArray(summary.conditions.items)) return undefined;
  const itemsRaw: unknown[] = summary.conditions.items;
  const tasks = isRecord(summary.tasks) ? summary.tasks : undefined;
  const items: RawBoardItem[] = [];
  for (const raw of itemsRaw) {
    if (!isRecord(raw) || !isStr(raw.id) || !isStr(raw.text)) continue;
    const state = typeof raw.state === 'string' && Object.hasOwn(GOAL_CONDITION_STATE_TITLES, raw.state)
      ? raw.state as GoalConditionStateName
      : 'unknown';
    const blocker = isRecord(raw.blocker)
      ? {
          ...(isStr(raw.blocker.reason) ? { reason: raw.blocker.reason } : {}),
          ...(isStr(raw.blocker.next) ? { next: raw.blocker.next } : {}),
        }
      : undefined;
    items.push({
      id: raw.id, text: raw.text, state,
      ...(isStr(raw.task_id) ? { taskId: raw.task_id } : {}),
      ...(isStr(raw.assignee) ? { assignee: raw.assignee } : {}),
      ...(isStr(raw.last_receipt_at) ? { lastReceiptAt: raw.last_receipt_at } : {}),
      ...(blocker !== undefined && (blocker.reason !== undefined || blocker.next !== undefined) ? { blocker } : {}),
    });
  }
  return {
    goalId: summary.goal_id,
    scope: summary.scope,
    items,
    ...(typeof tasks?.canceled === 'number' ? { canceled: tasks.canceled } : { canceled: 0 }),
    ...(typeof tasks?.unscheduled === 'number' ? { unscheduled: tasks.unscheduled } : { unscheduled: 0 }),
  };
}

function guardRelationWire(v: unknown): RawRelation | undefined {
  if (!isRecord(v) || !isStr(v.id) || !isStr(v.from_id) || !isStr(v.to_id) || !isStr(v.kind)) return undefined;
  return {
    id: v.id, fromId: v.from_id, toId: v.to_id, kind: v.kind,
    ...(isStr(v.note) ? { note: v.note } : {}),
    ...(typeof v.round === 'number' && Number.isInteger(v.round) ? { round: v.round } : {}),
    ...(v.stale === true ? { stale: true } : {}),
  };
}

/** `GET /collab/relations?task_id=` 的回包(`{relations:[…]}`)→ 行。 */
export function guardRelations(data: unknown, taskId: string): RelationRow[] | undefined {
  if (!isRecord(data) || !Array.isArray(data.relations)) return undefined;
  return data.relations
    .map(guardRelationWire)
    .filter((one): one is RawRelation => one !== undefined)
    .map((one) => relationRowOf(one, taskId));
}

/** `GET /collab/runs` 的回包(`{runs:[…]}`)→ 片段。 */
export function guardRunSegments(data: unknown): RawRunSegment[] | undefined {
  if (!isRecord(data) || !Array.isArray(data.runs)) return undefined;
  const out: RawRunSegment[] = [];
  for (const v of data.runs) {
    if (!isRecord(v) || !isStr(v.task_id) || !isStr(v.status) || !isStr(v.started_at)) continue;
    out.push({
      taskId: v.task_id,
      source: isStr(v.source) ? v.source : 'unknown',
      status: v.status,
      startedAt: v.started_at,
      ...(isStr(v.finished_at) ? { finishedAt: v.finished_at } : {}),
      ...(isStr(v.execution_started_observed_at) ? { execution_started_observed_at: v.execution_started_observed_at } : {}),
      ...(isStr(v.execution_finished_observed_at) ? { execution_finished_observed_at: v.execution_finished_observed_at } : {}),
      ...(isStr(v.pause_reason) ? { pauseReason: v.pause_reason } : {}),
      ...(isStr(v.outcome) ? { outcome: v.outcome } : {}),
    });
  }
  return out;
}

/** `GET /collab/capacity` 的回包(`{items:[…]}`)→ 容量。 */
export function guardCapacity(data: unknown): RawCapacity[] | undefined {
  if (!isRecord(data) || !Array.isArray(data.items)) return undefined;
  const out: RawCapacity[] = [];
  for (const v of data.items) {
    if (!isRecord(v) || !isStr(v.id) || typeof v.online !== 'boolean') continue;
    out.push({
      id: v.id,
      online: v.online,
      activeJobs: typeof v.active_jobs === 'number' ? v.active_jobs : 0,
      runningJobs: typeof v.running_jobs === 'number' ? v.running_jobs : 0,
      limit: typeof v.limit === 'number' ? v.limit : 'unknown',
    });
  }
  return out;
}

/** `GET /collab/note/activity?id=` 的回包(`{items:[…]}`)→ 按 at 升序的原始条目(逐格守卫,坏条跳过)。 */
export type RawActivityItem =
  | { type: 'message'; at: string; message: RawMessage }
  | { type: 'comment'; at: string; comment: { id: string; by: string; text: string; at: string; verdict?: string; resolved?: boolean } }
  | { type: 'receipt'; at: string; receipt: { kind: string; text: string; by?: string; at: string; evidence: readonly string[] } }
  | { type: 'transition'; at: string; from: string; to: string }
  | { type: 'run'; at: string; segment: RawRunSegment };

export function guardActivityItems(data: unknown): RawActivityItem[] | undefined {
  if (!isRecord(data) || !Array.isArray(data.items)) return undefined;
  const out: RawActivityItem[] = [];
  for (const v of data.items) {
    if (!isRecord(v) || !isStr(v.type) || !isStr(v.at)) continue;
    if (v.type === 'message' && isRecord(v.message)) {
      const message = guardMessage(v.message);
      if (message !== undefined) out.push({ type: 'message', at: v.at, message });
    } else if (v.type === 'comment' && isRecord(v.comment) && isStr(v.comment.id) && isStr(v.comment.by) && isStr(v.comment.text) && isStr(v.comment.at)) {
      out.push({
        type: 'comment', at: v.at,
        comment: {
          id: v.comment.id, by: v.comment.by, text: v.comment.text, at: v.comment.at,
          ...(isStr(v.comment.verdict) ? { verdict: v.comment.verdict } : {}),
          ...(isStr(v.comment.resolved_by) ? { resolved: true } : {}),
        },
      });
    } else if (v.type === 'receipt' && isRecord(v.receipt) && isStr(v.receipt.kind) && isStr(v.receipt.text) && isStr(v.receipt.at)) {
      const evidence = Array.isArray(v.receipt.evidence) ? v.receipt.evidence.filter(isStr) : [];
      out.push({
        type: 'receipt', at: v.at,
        receipt: { kind: v.receipt.kind, text: v.receipt.text, at: v.receipt.at, ...(isStr(v.receipt.by) ? { by: v.receipt.by } : {}), evidence },
      });
    } else if (v.type === 'transition' && isStr(v.from) && isStr(v.to)) {
      out.push({ type: 'transition', at: v.at, from: v.from, to: v.to });
    } else if (v.type === 'run' && isRecord(v.segment) && isStr(v.segment.task_id)) {
      const segments = guardRunSegments({ runs: [v.segment] });
      if (segments?.[0] !== undefined) out.push({ type: 'run', at: v.at, segment: segments[0] });
    }
  }
  return out.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

/* ────────────────── 局域网身份与成员(契约 §5) ────────────────── */

export interface RawLanIdentity {
  memberId: string;
  name: string;
  version: number;
  updatedAt?: string;
}

export interface RawLanMember {
  memberId: string;
  name: string;
  host: string;
  port: number;
  lastSeen?: string;
  reachable?: boolean;
}

/** `GET /collab/lan/identity` / 保存改名回包里的 identity。 */
export function guardLanIdentity(data: unknown): RawLanIdentity | undefined {
  if (!isRecord(data) || !isRecord(data.identity)) return undefined;
  const v = data.identity;
  if (!isStr(v.member_id) || !isStr(v.name) || typeof v.version !== 'number') return undefined;
  return { memberId: v.member_id, name: v.name, version: v.version, ...(isStr(v.updated_at) ? { updatedAt: v.updated_at } : {}) };
}

/** `GET /collab/lan/members` 的回包。 */
export function guardLanMembers(data: unknown): RawLanMember[] | undefined {
  if (!isRecord(data) || !Array.isArray(data.members)) return undefined;
  const out: RawLanMember[] = [];
  for (const v of data.members) {
    if (!isRecord(v) || !isStr(v.member_id) || !isStr(v.name) || !isStr(v.host) || typeof v.port !== 'number') return undefined;
    out.push({
      memberId: v.member_id, name: v.name, host: v.host, port: v.port,
      ...(isStr(v.last_seen) ? { lastSeen: v.last_seen } : {}),
      ...(typeof v.reachable === 'boolean' ? { reachable: v.reachable } : {}),
    });
  }
  return out;
}

/** 改名保存的回执:成功带新身份;409 带原因/冲突对象/可用性未知。 */
export interface LanSaveResult {
  ok: boolean;
  identity?: RawLanIdentity;
  error?: string;
  conflictWith?: string;
  availabilityUnknown?: boolean;
}

export function guardLanSave(data: unknown): LanSaveResult {
  if (!isRecord(data)) return { ok: false, error: '读不懂回包' };
  if (data.ok === true) {
    const identity = guardLanIdentity(data);
    return identity === undefined ? { ok: false, error: '回包里没 identity' } : { ok: true, identity };
  }
  return {
    ok: false,
    ...(isStr(data.error) ? { error: data.error } : { error: '没存上' }),
    ...(isStr(data.conflict_with) ? { conflictWith: data.conflict_with } : {}),
    ...(data.availability === 'unknown' ? { availabilityUnknown: true } : {}),
    ...(guardLanIdentity(data) === undefined ? {} : { identity: guardLanIdentity(data) }),
  };
}
