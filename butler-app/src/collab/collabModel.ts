/**
 * 协作区投影模型(2026-10-24,卡「完整手机协作下级页」,小K)。
 *
 * 纯函数,只吃 /state 的真实事实,输出手机协作页要的那几张「看得懂进展」的清单:
 * 分桶(已完成/状态进行中/未开始/受阻/交回待验/取消单列)、父子不双计、能力条件按条件算、
 * 连续活动流、真实时间片段与未知、人的名归一。
 *
 * 口径照维护者 2026-10-23 拍板(排卡「维护者补充」):
 * - 取消单列,不算达成;父子汇总不双计;范围始终标明;
 * - doing / PID / CLI 回合结束都不冒开工完成 —— 这里只摆状态事实 + 最近回执 + 最近时间,
 *   记录过旧单独标出来,不装作在跑;
 * - 任务数量只回答工作分布,能力目标进度按条件/证据/验收/交付算。
 */
import type { SessionView, TaskView } from '../api/protocol';
import type { CollabFields } from './collabState';

/** 六个桶:已完成/状态进行中/未开始/受阻/交回待验/取消(单列)。 */
export type CollabBucket = 'done' | 'doing' | 'todo' | 'blocked' | 'confirm' | 'canceled';

export const COLLAB_BUCKETS: readonly CollabBucket[] = ['done', 'doing', 'todo', 'blocked', 'confirm', 'canceled'];

export const COLLAB_BUCKET_TITLES: Readonly<Record<CollabBucket, string>> = {
  done: '已完成',
  doing: '状态进行中',
  todo: '未开始',
  blocked: '受阻',
  confirm: '交回待验',
  canceled: '已取消',
};

/** 任务状态只说明工作分布；目标能力是否当前可用取条件交付记录。 */
export const COLLAB_BUCKET_HINTS: Readonly<Record<CollabBucket, string>> = {
  done: '事项已完成;目标可用性看条件交付',
  doing: '卡片状态为进行中;开工事实见执行状态',
  todo: '还没人接',
  blocked: '原因与下一接手见卡内',
  confirm: '已交回,等她验',
  canceled: '取消单列,不算达成',
};

export function bucketOf(status: TaskView['status']): CollabBucket {
  switch (status) {
    case 'done': return 'done';
    case 'doing': return 'doing';
    case 'blocked': return 'blocked';
    case 'confirm': return 'confirm';
    case 'canceled': return 'canceled';
    default: return 'todo'; // backlog / todo
  }
}

export function emptyCounts(): Record<CollabBucket, number> {
  return { done: 0, doing: 0, todo: 0, blocked: 0, confirm: 0, canceled: 0 };
}

/** 「最该动」的桶序:受阻 > 交回待验 > 状态进行中 > 未开始 > 已完成(取消只在全取消时)。 */
const URGENCY: readonly CollabBucket[] = ['blocked', 'confirm', 'doing', 'todo', 'done'];

export interface BoardGroup {
  parent: TaskView;
  children: readonly TaskView[];
  leaves: readonly TaskView[];
  counts: Record<CollabBucket, number>;
  total: number;
}

export type BoardRow =
  | { kind: 'task'; task: TaskView; bucket: CollabBucket }
  | { kind: 'group'; group: BoardGroup; bucket: CollabBucket };

/**
 * 平铺分桶,父子不双计:
 * - 父卡(有 `children` 且至少一个在清单里)→ 收成一组,占一行,桶取组内「最该动」;
 * - 子卡不再单独出现;父卡不在清单(范围外)时子卡按独立卡算,不丢;
 * - 全取消的组进取消桶。
 */
export function boardRows(tasks: readonly TaskView[], fields: (t: TaskView) => CollabFields): BoardRow[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const childIds = new Set<string>();
  for (const t of tasks) {
    for (const c of fields(t).children ?? []) {
      if (byId.has(c)) childIds.add(c);
    }
  }
  const rows: BoardRow[] = [];
  for (const t of tasks) {
    if (childIds.has(t.id)) continue; // 子卡被父组收走
    const children = (fields(t).children ?? []).map((c) => byId.get(c)).filter((c): c is TaskView => c !== undefined);
    if ((fields(t).children?.length ?? 0) > 0) {
      const leaves: TaskView[] = [];
      const seen = new Set<string>();
      const visit = (one: TaskView) => {
        if (seen.has(one.id)) return;
        seen.add(one.id);
        const ids = fields(one).children ?? [];
        if (ids.length === 0) leaves.push(one);
        else for (const id of ids) { const child = byId.get(id); if (child !== undefined) visit(child); }
      };
      visit(t);
      const counts = emptyCounts();
      for (const c of leaves) counts[bucketOf(c.status)] += 1;
      const active = URGENCY.find((b) => counts[b] > 0);
      rows.push({ kind: 'group', group: { parent: t, children, leaves, counts, total: leaves.length }, bucket: active ?? 'canceled' });
    } else {
      rows.push({ kind: 'task', task: t, bucket: bucketOf(t.status) });
    }
  }
  return rows;
}

export function bucketCounts(rows: readonly BoardRow[]): Record<CollabBucket, number> {
  const counts = emptyCounts();
  const seen = new Set<string>();
  for (const row of rows) for (const task of row.kind === 'group' ? row.group.leaves : [row.task]) {
    if (seen.has(task.id)) continue;
    seen.add(task.id);
    counts[bucketOf(task.status)] += 1;
  }
  return counts;
}

export function rowsOfBucket(rows: readonly BoardRow[], bucket: CollabBucket): readonly BoardRow[] {
  return rows.filter((r) => r.bucket === bucket);
}

/** 能力条件的一条(从便签 acceptance 投影;进度按条件算,不按卡数算)。 */
export type ConditionState = 'reached' | 'confirm' | 'doing' | 'todo' | 'blocked' | 'canceled';

export const CONDITION_STATE_TITLES: Readonly<Record<ConditionState, string>> = {
  reached: '已达成',
  confirm: '验收中',
  doing: '进行中',
  todo: '尚未安排',
  blocked: '受阻',
  canceled: '已取消',
};

export interface ConditionRow {
  text: string;
  taskId: string;
  taskTitle: string;
  taskStatus: TaskView['status'];
  state: ConditionState;
  /** 证据:回执带的产物 + 交付物清单。 */
  evidence: readonly string[];
  receiptKind?: string;
  receiptAt?: string;
  receiptBy?: string;
  updatedAt: string;
}

function conditionStateOf(status: TaskView['status']): ConditionState {
  switch (status) {
    case 'done': return 'reached';
    case 'confirm': return 'confirm';
    case 'doing': return 'doing';
    case 'blocked': return 'blocked';
    case 'canceled': return 'canceled';
    default: return 'todo';
  }
}

/** 一组事项的能力条件表;没有 acceptance 的事项不进表(它没说自己做到什么算完)。 */
export function conditionRowsOf(tasks: readonly TaskView[], fields: (t: TaskView) => CollabFields): ConditionRow[] {
  const out: ConditionRow[] = [];
  for (const t of tasks) {
    const acceptance = fields(t).acceptance;
    if (acceptance === undefined || acceptance.length === 0) continue;
    const receipt = fields(t).receipt;
    // 证据:回执带的产物 + 交付物清单,去重(同一文件常两边都记)。
    const evidence = [...new Set([
      ...(receipt?.evidence ?? []),
      ...(t.deliverables ?? []).map((d) => d.ref),
    ])];
    for (const text of acceptance) {
      out.push({
        text,
        taskId: t.id,
        taskTitle: t.title,
        taskStatus: t.status,
        state: conditionStateOf(t.status),
        evidence,
        ...(receipt === undefined ? {} : { receiptKind: receipt.kind, receiptAt: receipt.at, receiptBy: receipt.by }),
        updatedAt: t.updated_at,
      });
    }
  }
  return out;
}

/** 连续活动流里的一条。 */
export type ActivityEntry =
  | { kind: 'created'; at: string }
  | { kind: 'from'; at: string; kindTitle: string; quote?: string; ref?: string }
  | { kind: 'comment'; at: string; by: string; text: string; verdict?: string; resolved?: boolean }
  | { kind: 'receipt'; at: string; receiptKind: string; text: string; by?: string; evidence: readonly string[] }
  | { kind: 'session'; at: string; agent: string; sessionId: string; status: string; title?: string; note?: string };

/** 来源那一格的中文名(与工作台 `NOTE_FROM_TITLES` 同表;认不出的 kind 原样摆)。 */
export const NOTE_FROM_TITLES: Readonly<Record<string, string>> = {
  meeting: '会上定的',
  session: '从会话来的',
  said: '你说的',
  channel: '频道里的',
  evidence: '证据里冒出来的',
  user: '你写下的',
};

/**
 * 一张便签的连续活动:来源 → 建卡 → 关联会话(links + conversation,对 /state.sessions
 * 的真实状态)→ 留言 → 回执,按时间新的在前。会话按 session_id 去重;对不上的不摆,
 * 不编造「在跑」。
 */
export function activityOf(
  task: TaskView,
  fields: (t: TaskView) => CollabFields,
  sessions: readonly Pick<SessionView, 'agent' | 'session_id' | 'status' | 'title' | 'updated_at'>[],
): ActivityEntry[] {
  const out: ActivityEntry[] = [];
  const f = fields(task);
  const from = f.from
    ?? (task.source?.kind === 'session' ? { kind: 'session', ...(task.source.ref === undefined ? {} : { ref: task.source.ref }) }
      : task.source?.kind === 'meeting' ? { kind: 'meeting', ...(task.source.ref === undefined ? {} : { ref: task.source.ref }) }
        : undefined);
  if (from !== undefined) {
    out.push({ kind: 'from', at: task.created_at, kindTitle: NOTE_FROM_TITLES[from.kind] ?? from.kind, ...(from.quote === undefined ? {} : { quote: from.quote }), ...(from.ref === undefined ? {} : { ref: from.ref }) });
  }
  out.push({ kind: 'created', at: task.created_at });
  const seenSessions = new Set<string>();
  const sessionEntries: ActivityEntry[] = [];
  const matchSession = (agent: string, sessionId: string, note?: string) => {
    if (seenSessions.has(sessionId)) return;
    const s = sessions.find((one) => one.session_id === sessionId && one.agent === agent)
      ?? sessions.find((one) => one.session_id === sessionId);
    if (s === undefined) return;
    seenSessions.add(sessionId);
    sessionEntries.push({
      kind: 'session', at: s.updated_at, agent: s.agent, sessionId: s.session_id, status: s.status,
      ...(s.title === undefined ? {} : { title: s.title }),
      ...(note === undefined ? {} : { note }),
    });
  };
  for (const link of task.links ?? []) {
    // 手机镜像的 TaskLinkView 还没声明 `note`(归 core 补);这里从原始 JSON 守卫着读。
    const rawNote = (link as unknown as Record<string, unknown>).note;
    matchSession(link.agent, link.session_id, typeof rawNote === 'string' && rawNote !== '' ? rawNote : undefined);
  }
  if (task.conversation !== undefined) matchSession(task.conversation.agent, task.conversation.session_id);
  out.push(...sessionEntries);
  for (const c of f.comments ?? []) {
    out.push({ kind: 'comment', at: c.at, by: c.by, text: c.text, ...(c.verdict === undefined ? {} : { verdict: c.verdict }), ...(c.resolved_by === undefined ? {} : { resolved: true }) });
  }
  const r = f.receipt;
  if (r !== undefined) {
    out.push({ kind: 'receipt', at: r.at, receiptKind: r.kind, text: r.text, ...(r.by === undefined ? {} : { by: r.by }), evidence: r.evidence ?? [] });
  }
  // 新的在前;同一刻按插入序稳定(来源在建卡之前说)。
  return out
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => (a.entry.at < b.entry.at ? 1 : a.entry.at > b.entry.at ? -1 : a.index - b.index))
    .map((x) => x.entry);
}

/** 多少天没动算「记录过旧」(失联/过旧如实标,不装作在跑)。 */
export const STALE_DAYS = 7;

export interface TimeFacts {
  /** 计划:普通事项看 due,选题看 planned_at。 */
  plannedDate?: string;
  plannedLabel?: string;
  /** 用户排期起止,不代表执行。 */
  plannedRange?: { start?: string; end?: string };
  /** 实际时间仅能来自执行 producer;现行 runs.started_at 为 assigned,不能放这里。 */
  actual?: { start: string; end?: string };
  /** 取不到的那几样(如实写「未知」,不填默认时间)。 */
  unknown: readonly string[];
  updatedAt: string;
  stale: boolean;
}

export function timeFactsOf(task: TaskView, fields: (t: TaskView) => CollabFields, nowIso: string): TimeFacts {
  const f = fields(task);
  const plannedDate = task.due ?? f.plannedAt ?? f.start ?? f.end;
  const plannedRange = f.start !== undefined || f.end !== undefined ? { ...(f.start === undefined ? {} : { start: f.start }), ...(f.end === undefined ? {} : { end: f.end }) } : undefined;
  const unknown: string[] = [];
  if (plannedDate === undefined) unknown.push('计划时间');
  unknown.push('实际时间');
  const staleMs = STALE_DAYS * 24 * 60 * 60 * 1000;
  let stale = false;
  const updatedMs = Date.parse(task.updated_at);
  const nowMs = Date.parse(nowIso);
  if (Number.isFinite(updatedMs) && Number.isFinite(nowMs) && nowMs - updatedMs > staleMs) stale = true;
  return {
    ...(plannedDate === undefined ? {} : { plannedDate, plannedLabel: task.due !== undefined ? '截止' : '计划' }),
    ...(plannedRange === undefined ? {} : { plannedRange }),
    unknown,
    updatedAt: task.updated_at,
    stale,
  };
}

export interface ActorContext {
  /** `agent:<id>` → 名片名。 */
  cards: Readonly<Record<string, string>>;
  /** 账号 → 成员 nick。 */
  members: Readonly<Record<string, string>>;
}

const FAMILY_TITLES: Readonly<Record<string, string>> = {
  dsh: '事务官', butler: '事务官', me: '我',
};

/** 人名归一:`me`→我、`butler/dsh`→事务官、`agent:<id>`→名片名、`member:<账号>`→成员 nick;认不出原样摆。 */
export function actorName(who: string | undefined, ctx: ActorContext): string {
  if (who === undefined || who === '') return '没写谁来做';
  const family = FAMILY_TITLES[who];
  if (family !== undefined) return family;
  if (who.startsWith('agent:')) return ctx.cards[who] ?? who;
  if (who.startsWith('member:')) {
    const acct = who.slice('member:'.length);
    return ctx.members[acct] ?? `成员·${acct}`;
  }
  return who;
}

/** 同名只影响标签,不能合并稳定身份。 */
export function actorLabel(who: string | undefined, ctx: ActorContext): string {
  const name = actorName(who, ctx);
  const ids = [...Object.keys(ctx.cards), ...Object.keys(ctx.members).map((id) => `member:${id}`), 'me', 'butler', 'dsh'];
  return who && ids.some((id) => id !== who && actorName(id, ctx) === name) ? `${name} (${who})` : name;
}

export function plannedTimeLine(time: TimeFacts): string {
  const range = time.plannedRange;
  const date = time.plannedDate === undefined || time.plannedDate === range?.start || time.plannedDate === range?.end ? '' : `${time.plannedLabel} ${time.plannedDate}`;
  return [date, range === undefined ? '' : `计划 ${range.start ?? '开始未定'} → ${range.end ?? '结束未定'}`].filter(Boolean).join(' · ') || '没有计划时间';
}
