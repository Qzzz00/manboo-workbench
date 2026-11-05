/**
 * 「我照你说的摆好了」那张卡的纯函数(2026-09-24 晚,卡 feat/onboarding-materialize)。
 * 电脑首页球下面画它;手机「等你确认」里是同一份数据、同一套规矩(butler-app/src/materialize/)。
 *
 * - 哪几行能勾:已经有了的(done)、做不了的(placeholder)不能勾,灰着;
 * - 他勾掉 / 勾上 / 改了标题负责人 → 「就这样」时交给 `/onboarding/materialize/apply` 的那一份;
 * - 落完之后显示一句回执(`result.line`),十分钟后自己收起(他也可以点「收起」)。
 */
import type { MaterializeOwner, MaterializeRowView, MaterializeStateView } from '../protocol.ts'
import { MATERIALIZE_OWNER_LABELS } from '../protocol.ts'

export interface RowChoice {
  /** 他勾没勾(缺席 = 照单子默认)。 */
  checked?: boolean
  title?: string
  owner?: MaterializeOwner
  /** 免打扰到几点(HH:MM,只有带 `time` 的那一行有)。 */
  to?: string
}

type RowEdit = { title?: string, owner?: MaterializeOwner, to?: string }

export type Choices = Readonly<Record<string, RowChoice>>

/** 这一行能不能勾。 */
export function rowCheckable(row: MaterializeRowView): boolean {
  return row.done !== true && row.placeholder === undefined
}

/** 这一行此刻勾着没有(他改过就按他的,没改过按单子默认)。 */
export function rowChecked(row: MaterializeRowView, choices: Choices): boolean {
  if (!rowCheckable(row)) return false
  return choices[row.key]?.checked ?? row.checked
}

/** 按分组排好:组标题 + 那几行(单子上的顺序)。 */
export function groupedRows(view: Pick<MaterializeStateView, 'groups' | 'rows'>): { id: string, title: string, rows: MaterializeRowView[] }[] {
  return view.groups
    .map(group => ({ id: group.id, title: group.title, rows: view.rows.filter(row => row.group === group.id) }))
    .filter(group => group.rows.length > 0)
}

/** 「就这样」时交上去的那一份。只带他动过的(勾掉的、勾上的、改过的)。 */
export function applyPayload(view: Pick<MaterializeStateView, 'id' | 'rows'>, choices: Choices): {
  id: string
  uncheck?: string[]
  check?: string[]
  edits?: Record<string, RowEdit>
} {
  const uncheck: string[] = []
  const check: string[] = []
  const edits: Record<string, RowEdit> = {}
  for (const row of view.rows) {
    if (!rowCheckable(row)) continue
    const choice = choices[row.key]
    if (choice === undefined) continue
    if (choice.checked === false && row.checked) uncheck.push(row.key)
    if (choice.checked === true && !row.checked) check.push(row.key)
    const title = choice.title?.trim()
    const edit: RowEdit = {}
    if (row.editable === true && title !== undefined && title !== '' && title !== row.title) edit.title = title
    if (row.editable === true && choice.owner !== undefined && choice.owner !== row.owner) edit.owner = choice.owner
    if (row.time !== undefined && choice.to !== undefined && choice.to !== row.time.to) edit.to = choice.to
    if (Object.keys(edit).length > 0) edits[row.key] = edit
  }
  return {
    id: view.id,
    ...(uncheck.length === 0 ? {} : { uncheck }),
    ...(check.length === 0 ? {} : { check }),
    ...(Object.keys(edits).length === 0 ? {} : { edits }),
  }
}

/** 勾着要做的有几样(按钮上那个数)。 */
export function liveCount(view: Pick<MaterializeStateView, 'rows'>, choices: Choices): number {
  return view.rows.filter(row => rowChecked(row, choices)).length
}

/** 卡头那一行小字:「两个项目、十件事 · 等你点头」。 */
export function headLine(view: Pick<MaterializeStateView, 'counts' | 'status'>): string {
  const parts: string[] = []
  if (view.counts.projects > 0) parts.push(`${view.counts.projects} 个项目`)
  if (view.counts.tasks > 0) parts.push(`${view.counts.tasks} 件事`)
  if (view.counts.cancel > 0) parts.push(`撤掉 ${view.counts.cancel} 条旧的`)
  const tail = view.status === 'applied' ? '落好了' : view.status === 'applying' ? '正在落…' : '等你点头'
  return `${parts.join('、')}${parts.length === 0 ? '' : ' · '}${tail}`
}

/** 落完多久自己收起。 */
export const APPLIED_SHOW_MS = 10 * 60 * 1000

/** 这张卡还摆不摆。等他点头 / 正在落 → 摆;落完十分钟内 → 摆回执;他点过「收起」→ 不摆。 */
export function shouldShow(view: MaterializeStateView | undefined, nowMs: number, dismissed: string | undefined): boolean {
  if (view === undefined) return false
  if (dismissed === view.id) return false
  if (view.status !== 'applied') return true
  const at = view.applied_at === undefined ? Number.NaN : Date.parse(view.applied_at)
  return Number.isFinite(at) && nowMs - at < APPLIED_SHOW_MS
}

/** 负责人下拉的几项(「改一下」时用)。 */
export const OWNER_CHOICES: readonly { id: MaterializeOwner, label: string }[] = (Object.keys(MATERIALIZE_OWNER_LABELS) as MaterializeOwner[])
  .map(id => ({ id, label: MATERIALIZE_OWNER_LABELS[id] }))

/**
 * 免打扰「到几点」的几项(2026-09-25 统筹:默认 08:30,在「改一下」里能改)。单子上默认的那个不在表里也照样列上。
 */
export const QUIET_END_CHOICES: readonly string[] = ['07:30', '08:00', '08:30', '09:00']

export function quietEndChoices(current: string): string[] {
  return QUIET_END_CHOICES.includes(current) ? [...QUIET_END_CHOICES] : [...QUIET_END_CHOICES, current].sort()
}

/** 「早上 8 点半」这种说法(与服务端 materialize.ts `spokenTime` 同一套)。 */
export function spokenClock(time: string): string {
  const [h = 0, m = 0] = time.split(':').map(Number)
  const part = h < 12 ? '早上' : h < 18 ? '下午' : '晚上'
  const hour = h <= 12 ? h : h - 12
  return `${part} ${hour} 点${m === 30 ? '半' : m === 0 ? '' : ` ${m} 分`}`
}

/** 这一行此刻的标题:免打扰那一行改了到几点,标题跟着改(交上去之前只是显示)。 */
export function rowTitle(row: MaterializeRowView, choices: Choices): string {
  const choice = choices[row.key]
  if (row.time !== undefined && choice?.to !== undefined && choice.to !== row.time.to) return `${spokenClock(row.time.from)}到${spokenClock(choice.to)}不打扰`
  return choice?.title ?? row.title
}
