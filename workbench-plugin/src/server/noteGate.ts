/**
 * **贴便签的门**(2026-10-21 协作区,设计稿第五节;待拍板 4 已定:门在服务端,不在界面)。
 *
 * 维护者 10-21:「最大的问题是……事务官首先是派活就派不明白,也就是项目经理的活没干好。」
 * 卡上只有「按清单真机走一遍 · 你」,为什么、从哪来、怎么算完都没进卡。所以四样缺一不贴:
 *
 * | 样 | 缺了怎么办 |
 * |---|---|
 * | 目标 | 写不出就贴「未归目标」,便签上标「目标待定」—— **不挡** |
 * | 来源 | 挡(会议 id / 会话 id / 他的原话 / 频道消息) |
 * | 验收 | 挡(1–3 条短句) |
 * | 负责人 | 挡 |
 *
 * 派活那一处另有一道:**没写验收不许派**({@link dispatchGate}) —— 交给别家的活说不清怎么算完,
 * 回执就没法对着编号答。纯函数,HTTP 层(`/task/create` 新形状、事务官打的 `/dispatch/run`、`/butler/item/dispatch`)调它。
 */
import type { NoteFrom, NoteGap, TaskAssignee } from '../protocol.ts'
import { NOTE_GAP_TITLES, UNSORTED_GOAL_ID, isNoteFromKind } from '../protocol.ts'

export interface NoteGateInput {
  goal_id?: string | undefined
  from?: NoteFrom | undefined
  acceptance?: readonly string[] | undefined
  assignee?: TaskAssignee | undefined
}

export type NoteGateResult =
  | { ok: true, goal_id: string, goal_pending: boolean }
  | { ok: false, missing: NoteGap[], error: string }

/** 门拒绝时那一句的开头(断言照它,不逐字抄中文)。 */
export const NOTE_GATE_ERROR_HEAD = '便签四样没写齐,没贴:'

export function noteGate(input: NoteGateInput): NoteGateResult {
  const missing: NoteGap[] = []
  if (input.from === undefined || !isNoteFromKind(input.from.kind)) missing.push('from')
  if ((input.acceptance ?? []).filter(one => one.trim() !== '').length === 0) missing.push('acceptance')
  if (input.assignee === undefined) missing.push('assignee')
  if (missing.length > 0) {
    return {
      ok: false,
      missing,
      error: `${NOTE_GATE_ERROR_HEAD}${missing.map(one => NOTE_GAP_TITLES[one]).join('、')}。`
        + '要带 from {kind, ref?, quote?}、acceptance(1–3 条「做到什么算完」)、assignee;目标写不出可以不传 goal_id,会贴进「未归目标」。',
    }
  }
  const goal = input.goal_id === undefined || input.goal_id.trim() === '' ? UNSORTED_GOAL_ID : input.goal_id.trim()
  return { ok: true, goal_id: goal, goal_pending: goal === UNSORTED_GOAL_ID }
}

/** 派活门拒绝时那一句(事务官会把它念回自己的会话里,所以写清下一步)。 */
export const DISPATCH_GATE_ERROR = '派活之前先写清「做到什么算完」:POST /task/update {id, acceptance:[1–3 条短句]},再派。派活说明里这几条会带编号,回执要对着编号答。'

export function dispatchGate(task: { acceptance?: readonly string[] | undefined }): string | undefined {
  return (task.acceptance ?? []).length === 0 ? DISPATCH_GATE_ERROR : undefined
}
