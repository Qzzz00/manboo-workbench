/**
 * 手机首页「等你确认」里那张「我照你说的摆好了」的纯函数(2026-09-24 晚,卡 feat/onboarding-materialize)。
 * 与电脑那张(workbench-plugin/src/client/materializeAskModel.ts)同一套规矩:
 *   - 已经有了的、做不了的(占位)不能勾;
 *   - 「就这样」只交他动过的(勾掉的、勾上的、改过标题负责人的);
 *   - 落完只留一句回执,十分钟后自己收起。
 * 维护者中秋起只拿手机:**手机上必须能确认**。
 */
import type { MaterializeOwner, MaterializeRowView, MaterializeStateView } from '../api/protocol';
import { MATERIALIZE_OWNER_LABELS } from '../api/protocol';

export interface RowChoice { checked?: boolean; title?: string; owner?: MaterializeOwner; /** 免打扰到几点(HH:MM)。 */ to?: string }
export type Choices = Readonly<Record<string, RowChoice>>;

export function rowCheckable(row: MaterializeRowView): boolean {
  return row.done !== true && row.placeholder === undefined;
}

export function rowChecked(row: MaterializeRowView, choices: Choices): boolean {
  if (!rowCheckable(row)) return false;
  return choices[row.key]?.checked ?? row.checked;
}

export function groupedRows(view: Pick<MaterializeStateView, 'groups' | 'rows'>): { id: string; title: string; rows: MaterializeRowView[] }[] {
  return view.groups
    .map((group) => ({ id: group.id, title: group.title, rows: view.rows.filter((row) => row.group === group.id) }))
    .filter((group) => group.rows.length > 0);
}

export interface ApplyPayload {
  id: string;
  uncheck?: string[];
  check?: string[];
  edits?: Record<string, { title?: string; owner?: MaterializeOwner; to?: string }>;
}

export function applyPayload(view: Pick<MaterializeStateView, 'id' | 'rows'>, choices: Choices): ApplyPayload {
  const uncheck: string[] = [];
  const check: string[] = [];
  const edits: Record<string, { title?: string; owner?: MaterializeOwner; to?: string }> = {};
  for (const row of view.rows) {
    if (!rowCheckable(row)) continue;
    const choice = choices[row.key];
    if (choice === undefined) continue;
    if (choice.checked === false && row.checked) uncheck.push(row.key);
    if (choice.checked === true && !row.checked) check.push(row.key);
    const title = choice.title?.trim();
    const edit: { title?: string; owner?: MaterializeOwner; to?: string } = {};
    if (row.editable === true && title !== undefined && title !== '' && title !== row.title) edit.title = title;
    if (row.editable === true && choice.owner !== undefined && choice.owner !== row.owner) edit.owner = choice.owner;
    if (row.time !== undefined && choice.to !== undefined && choice.to !== row.time.to) edit.to = choice.to;
    if (Object.keys(edit).length > 0) edits[row.key] = edit;
  }
  return {
    id: view.id,
    ...(uncheck.length === 0 ? {} : { uncheck }),
    ...(check.length === 0 ? {} : { check }),
    ...(Object.keys(edits).length === 0 ? {} : { edits }),
  };
}

export function liveCount(view: Pick<MaterializeStateView, 'rows'>, choices: Choices): number {
  return view.rows.filter((row) => rowChecked(row, choices)).length;
}

export function headLine(view: Pick<MaterializeStateView, 'counts' | 'status'>): string {
  const parts: string[] = [];
  if (view.counts.projects > 0) parts.push(`${view.counts.projects} 个项目`);
  if (view.counts.tasks > 0) parts.push(`${view.counts.tasks} 件事`);
  if (view.counts.cancel > 0) parts.push(`撤掉 ${view.counts.cancel} 条旧的`);
  const tail = view.status === 'applied' ? '落好了' : view.status === 'applying' ? '正在落…' : '等你点头';
  return `${parts.join('、')}${parts.length === 0 ? '' : ' · '}${tail}`;
}

export const APPLIED_SHOW_MS = 10 * 60 * 1000;

/** 还摆不摆:等他点头 / 正在落 → 摆整张;落完十分钟内 → 摆回执;他点过「收起」→ 不摆。 */
export function setupShown(view: MaterializeStateView | undefined, nowMs: number, dismissed: string | undefined): 'plan' | 'receipt' | null {
  if (view === undefined || dismissed === view.id) return null;
  if (view.status !== 'applied') return 'plan';
  const at = view.applied_at === undefined ? Number.NaN : Date.parse(view.applied_at);
  return Number.isFinite(at) && nowMs - at < APPLIED_SHOW_MS ? 'receipt' : null;
}

export const OWNER_CHOICES: readonly { id: MaterializeOwner; label: string }[] = (Object.keys(MATERIALIZE_OWNER_LABELS) as MaterializeOwner[])
  .map((id) => ({ id, label: MATERIALIZE_OWNER_LABELS[id] }));

/** 免打扰「到几点」的几项(2026-09-25 统筹:默认 08:30,「改一下」能改)。与电脑那张同一份。 */
export const QUIET_END_CHOICES: readonly string[] = ['07:30', '08:00', '08:30', '09:00'];

export function quietEndChoices(current: string): string[] {
  return QUIET_END_CHOICES.includes(current) ? [...QUIET_END_CHOICES] : [...QUIET_END_CHOICES, current].sort();
}

/** 「早上 8 点半」这种说法(与工作台 materialize.ts `spokenTime` 同一套)。 */
export function spokenClock(time: string): string {
  const [h = 0, m = 0] = time.split(':').map(Number);
  const part = h < 12 ? '早上' : h < 18 ? '下午' : '晚上';
  const hour = h <= 12 ? h : h - 12;
  return `${part} ${hour} 点${m === 30 ? '半' : m === 0 ? '' : ` ${m} 分`}`;
}

/** 这一行此刻的标题:改了免打扰到几点,标题跟着改(交上去之前只是显示)。 */
export function rowTitle(row: MaterializeRowView, choices: Choices): string {
  const choice = choices[row.key];
  if (row.time !== undefined && choice?.to !== undefined && choice.to !== row.time.to) return `${spokenClock(row.time.from)}到${spokenClock(choice.to)}不打扰`;
  return choice?.title ?? row.title;
}
