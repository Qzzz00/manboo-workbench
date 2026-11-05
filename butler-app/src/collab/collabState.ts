import { guardMessage } from './collabCore';
import type { NoteComment, NoteFrom, NoteReceipt } from '../api/protocol';

/**
 * 协作区原始字段的守卫读取(2026-10-24,卡「完整手机协作下级页」,小K)。
 *
 * 公共协议由 core 同源镜像提供；这里在网络边界守卫并归一显示字段，兼容老快照与坏数据。
 *
 * 纪律:**只读真实存在的字段,缺了就是 undefined** —— 不补默认值、不造事实。
 */

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function isStr(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}
function strArray(v: unknown): readonly string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter(isStr);
  return out.length === 0 ? undefined : out;
}

/** 交回回执(工作台 `NoteReceipt` 同形;只读)。 */
export type RawReceipt = Omit<NoteReceipt, 'kind'> & { kind: string };

/** 便签上的一条留言(工作台 `NoteComment` 同形;只读)。 */
export type RawComment = Omit<NoteComment, 'verdict'> & { verdict?: string };

/** 从哪来(工作台 `NoteFrom` 同形;只读)。 */
export type RawFrom = Omit<NoteFrom, 'kind'> & { kind: string };

/**
 * 一张便签上手机协作页要读的那几格(全是可选;缺席 = 老卡/没写过)。
 * 字段名与工作台 protocol.ts 逐字相同,读法见 collabFields()。
 */
export interface CollabFields {
  /** 所属目标 id;缺席 = 未归目标。 */
  goalId?: string;
  /** 做到什么算完(1–3 条)。 */
  acceptance?: readonly string[];
  comments?: readonly RawComment[];
  receipt?: RawReceipt;
  /** 子便签 id。 */
  children?: readonly string[];
  from?: RawFrom;
  collaborators?: readonly string[];
  watchers?: readonly string[];
  /** 开始/结束时刻(ISO);只有 start = 时间点卡。 */
  start?: string;
  end?: string;
  /** 选题的计划发布日。 */
  plannedAt?: string;
  labels?: readonly string[];
}

function guardReceipt(v: unknown): RawReceipt | undefined {
  if (!isRecord(v) || !isStr(v.kind) || !isStr(v.text) || !isStr(v.at)) return undefined;
  return {
    kind: v.kind,
    text: v.text,
    ...(strArray(v.evidence) === undefined ? {} : { evidence: strArray(v.evidence) }),
    ...(isStr(v.by) ? { by: v.by } : {}),
    at: v.at,
  };
}

function guardComment(v: unknown): RawComment | undefined {
  if (!isRecord(v) || !isStr(v.id) || !isStr(v.by) || !isStr(v.text) || !isStr(v.at)) return undefined;
  return {
    id: v.id, by: v.by, text: v.text, at: v.at,
    ...(isStr(v.verdict) ? { verdict: v.verdict } : {}),
    ...(isStr(v.resolved_by) ? { resolved_by: v.resolved_by } : {}),
    ...(isStr(v.resolved_at) ? { resolved_at: v.resolved_at } : {}),
  };
}

function guardFrom(v: unknown): RawFrom | undefined {
  if (!isRecord(v) || !isStr(v.kind)) return undefined;
  return { kind: v.kind, ...(isStr(v.ref) ? { ref: v.ref } : {}), ...(isStr(v.quote) ? { quote: v.quote } : {}) };
}

/** 从一张原始便签 JSON 上取协作那几格;逐格守卫,坏格当缺席。 */
export function collabFields(task: unknown): CollabFields {
  if (!isRecord(task)) return {};
  const out: CollabFields = {};
  if (isStr(task.goal_id)) out.goalId = task.goal_id;
  const acceptance = strArray(task.acceptance);
  if (acceptance !== undefined) out.acceptance = acceptance;
  if (Array.isArray(task.comments)) {
    const comments = task.comments.map(guardComment).filter((c): c is RawComment => c !== undefined);
    if (comments.length > 0) out.comments = comments;
  }
  const receipt = guardReceipt(task.receipt);
  if (receipt !== undefined) out.receipt = receipt;
  const children = strArray(task.children);
  if (children !== undefined) out.children = children;
  const from = guardFrom(task.from);
  if (from !== undefined) out.from = from;
  const collaborators = strArray(task.collaborators);
  if (collaborators !== undefined) out.collaborators = collaborators;
  const watchers = strArray(task.watchers);
  if (watchers !== undefined) out.watchers = watchers;
  if (isStr(task.start)) out.start = task.start;
  if (isStr(task.end)) out.end = task.end;
  if (isStr(task.planned_at)) out.plannedAt = task.planned_at;
  const labels = strArray(task.labels);
  if (labels !== undefined) out.labels = labels;
  return out;
}

/** 一个目标(工作台 `CollabGoal` 同形子集;只读)。未归目标的 id 用 {@link UNSORTED_GOAL_ID}。 */
export interface RawGoal {
  id: string;
  title: string;
  status?: string;
  due?: string;
  why?: string;
  updated_at?: string;
  projectId?: string;
}

/** 「未归目标」的固定 id(与工作台 protocol.ts 的 `UNSORTED_GOAL_ID` 逐字相同:`goal:unsorted`)。 */
export const UNSORTED_GOAL_ID = 'goal:unsorted';

/** 一张便签归哪个目标(老卡/空串 → 未归目标);与工作台 `goalIdOf` 同口径。 */
export function goalIdOfTask(task: unknown): string {
  const g = isRecord(task) ? task.goal_id : undefined;
  return typeof g !== 'string' || g.trim() === '' ? UNSORTED_GOAL_ID : g.trim();
}

function guardGoal(v: unknown): RawGoal | undefined {
  if (!isRecord(v) || !isStr(v.id) || !isStr(v.title)) return undefined;
  return {
    id: v.id, title: v.title,
    ...(isStr(v.status) ? { status: v.status } : {}),
    ...(isStr(v.due) ? { due: v.due } : {}),
    ...(isStr(v.why) ? { why: v.why } : {}),
    ...(isStr(v.updated_at) ? { updated_at: v.updated_at } : {}),
    ...(isStr(v.project_id) ? { projectId: v.project_id } : {}),
    // conditions 原样带着(类型上不在 RawGoal 里):guardGoalConditions 下一道守卫逐条认。
    ...(Array.isArray((v as Record<string, unknown>).conditions)
      ? { conditions: (v as Record<string, unknown>).conditions } : {}),
  } as RawGoal;
}

/** `/state.tasks` 上的目标清单;缺席/坏 = 空。 */
export function collabGoals(tasksState: unknown): readonly RawGoal[] {
  if (!isRecord(tasksState) || !Array.isArray(tasksState.goals)) return [];
  return tasksState.goals.map(guardGoal).filter((g): g is RawGoal => g !== undefined);
}

/** 一段时间里要推的几个目标(工作台 `CollabSprint` 同形子集;只读)。 */
export interface RawSprint {
  id: string;
  title: string;
  goalIds: readonly string[];
  start?: string;
  end?: string;
}

/** `/state.tasks` 上的冲刺清单;缺席/坏 = 空。 */
export function collabSprints(tasksState: unknown): readonly RawSprint[] {
  if (!isRecord(tasksState) || !Array.isArray(tasksState.goal_sprints)) return [];
  const out: RawSprint[] = [];
  for (const v of tasksState.goal_sprints) {
    if (!isRecord(v) || !isStr(v.id) || !isStr(v.title)) continue;
    const goalIds = strArray(v.goal_ids) ?? [];
    out.push({
      id: v.id, title: v.title, goalIds,
      ...(isStr(v.start) ? { start: v.start } : {}),
      ...(isStr(v.end) ? { end: v.end } : {}),
    });
  }
  return out;
}

/** 名片栏:`agent:<id>` → 显示名(用于负责人/留言/@ 的名归一)。 */
export function collabCards(tasksState: unknown): Readonly<Record<string, string>> {
  if (!isRecord(tasksState) || !Array.isArray(tasksState.agent_cards)) return {};
  const out: Record<string, string> = {};
  for (const v of tasksState.agent_cards) {
    if (isRecord(v) && isStr(v.id) && isStr(v.name)) out[v.id] = v.name;
  }
  return out;
}

export interface RawMember {
  accountId: string;
  nick?: string;
  role?: string;
  devices?: readonly string[];
}

/** 工作室成员(中转名单;`GET /collab/relay/studio` joined 态的 members)。 */
export function guardMembers(v: unknown): readonly RawMember[] {
  if (!Array.isArray(v)) return [];
  const out: RawMember[] = [];
  for (const m of v) {
    if (isRecord(m) && isStr(m.account_id)) {
      out.push({
        accountId: m.account_id,
        ...(isStr(m.nick) ? { nick: m.nick } : {}),
        ...(isStr(m.role) ? { role: m.role } : {}),
        ...(strArray(m.devices) !== undefined ? { devices: strArray(m.devices) } : {}),
      });
    }
  }
  return out;
}

/** `member:<账号>` → 显示名。 */
export function membersMap(members: readonly RawMember[]): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const m of members) out[m.accountId] = m.nick ?? m.accountId;
  return out;
}

/** 中转变了几次(频道消息、成员变动……):界面拿它当该重读频道的信号。缺席 = 没接。 */
export function relayTickOf(state: unknown): number | undefined {
  if (!isRecord(state) || !isRecord(state.tasks)) return undefined;
  const tick = state.tasks.relay_tick;
  return typeof tick === 'number' && Number.isFinite(tick) ? tick : undefined;
}

/* ────────────────── 真实 core 投影的守卫读取(2026-10-24 契约 §1–§3)────────────────── */

function guardVerification(v: unknown): import('./collabCore').RawVerification | undefined {
  if (!isRecord(v) || !isStr(v.by) || !isStr(v.at) || typeof v.pass !== 'boolean') return undefined;
  return {
    by: v.by, at: v.at, pass: v.pass,
    ...(typeof v.round === 'number' && Number.isInteger(v.round) ? { round: v.round } : { round: 1 }),
    ...(isStr(v.note) ? { note: v.note } : {}),
  };
}

function guardCondition(v: unknown): import('./collabCore').RawCondition | undefined {
  if (!isRecord(v) || !isStr(v.id) || !isStr(v.text)) return undefined;
  const verifications = Array.isArray(v.verifications)
    ? v.verifications.map(guardVerification).filter((one): one is import('./collabCore').RawVerification => one !== undefined)
    : [];
  return {
    id: v.id, text: v.text,
    verifications,
    ...(isStr(v.task_id) ? { taskId: v.task_id } : {}),
    ...(strArray(v.evidence) !== undefined ? { evidence: strArray(v.evidence) } : {}),
    ...(isStr(v.delivered_at) ? { deliveredAt: v.delivered_at } : {}),
    createdAt: isStr(v.created_at) ? v.created_at : '',
    updatedAt: isStr(v.updated_at) ? v.updated_at : '',
  };
}

/** 目标的 conditions 逐条守卫;一条都认不出 = 无条件(缺席),不编造。 */
export function guardGoalConditions(goals: readonly RawGoal[]): readonly import('./collabCore').RawGoalWithConditions[] {
  return goals.map((goal) => {
    // 从原始 JSON 再读一遍 conditions(守卫过的 RawGoal 只剩子集字段);拷一份把原始 conditions 摘掉,防坏格漏出去。
    const { conditions: _raw, ...rest } = goal as unknown as Record<string, unknown>;
    if (!Array.isArray(_raw)) return rest as unknown as import('./collabCore').RawGoalWithConditions;
    const conditions = _raw.map(guardCondition).filter((one): one is import('./collabCore').RawCondition => one !== undefined);
    return conditions.length > 0
      ? { ...(rest as unknown as RawGoal), conditions }
      : rest as unknown as import('./collabCore').RawGoalWithConditions;
  });
}

// guardMessage / guardDelivery 在 collabCore(活动流守卫共用,避免环)。

function guardTransition(v: unknown): { from: string; to: string; at: string } | undefined {
  if (!isRecord(v) || !isStr(v.from) || !isStr(v.to) || !isStr(v.at)) return undefined;
  return { from: v.from, to: v.to, at: v.at };
}

/** 一张便签的 round / messages / transitions 逐格守卫(契约 B/C/D2;缺席 = 缺省)。 */
export function guardTaskCollab(task: unknown): {
  round: number;
  messages?: readonly import('./collabCore').RawMessage[];
  transitions?: readonly { from: string; to: string; at: string }[];
} {
  const out: { round: number; messages?: readonly import('./collabCore').RawMessage[]; transitions?: readonly { from: string; to: string; at: string }[] } = { round: 1 };
  if (!isRecord(task)) return out;
  if (typeof task.round === 'number' && Number.isInteger(task.round) && task.round >= 1) out.round = task.round;
  if (Array.isArray(task.messages)) {
    const messages = task.messages.map(guardMessage).filter((one): one is import('./collabCore').RawMessage => one !== undefined);
    if (messages.length > 0) out.messages = messages;
  }
  if (Array.isArray(task.transitions)) {
    const transitions = task.transitions.map(guardTransition).filter((one): one is { from: string; to: string; at: string } => one !== undefined);
    if (transitions.length > 0) out.transitions = transitions;
  }
  return out;
}
