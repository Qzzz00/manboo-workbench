/**
 * 「今天的待办」= 看板事项的今天视图(2026-10-12;决策记录同日「运营补丁留的两条」第 2 条)。
 *
 * 运营同学那个待办小组件(10-08,存在他浏览器 localStorage 里)进了自媒体模板本体,但**不另存一份**:
 * 一件待办就是一件看板事项,「今天」是按事项的 `due` 切出来的。打勾走 `/task/move`(七态表上一格一格走到「完成」),
 * 「延到明天」走 `/task/update {due}`,新加一件走 `/task/create {due: 今天}` —— 验收、进度、早报都照看板那一套。
 *
 * 放在 src/ 顶层:服务端拼 `/state.today_todos` 用它,手机读服务端拼好的那一份,两端同一刀。
 */
import type { TaskView, TodayTodoGroup, TodayTodoItem, TodayTodosView, TodayViewStyle } from './protocol.ts'

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/** 本机时区的那一天(`YYYY-MM-DD`)。 */
export function localDayOf(at: Date): string {
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`
}

/** 下一天。认不出的原样回。 */
export function nextDayOf(day: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day)
  if (m === null) return day
  return localDayOf(new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + 1))
}

/** ISO 时刻落在本机哪一天;认不出回 undefined。 */
function dayOfIso(iso: string | undefined): string | undefined {
  if (iso === undefined) return undefined
  const at = Date.parse(iso)
  return Number.isNaN(at) ? undefined : localDayOf(new Date(at))
}

/**
 * 今天那一刀:
 * - 没办完(不是完成 / 取消)、`due` 不晚于今天的 —— 过了日子还没办的照样在(写明逾期),不悄悄消失;
 * - 今天办完的留着打勾的样子(打完勾不该从眼前一闪就没了);
 * - 选题不进(它们按 `planned_at` 在选题池与发布计划里)。
 */
export function todayTodosOf(tasks: readonly TaskView[], today: string, style: TodayViewStyle = 'flat'): TodayTodosView {
  const items: (TodayTodoItem & { created_at: string })[] = []
  const ahead: (TodayTodoItem & { created_at: string })[] = []
  for (const task of tasks) {
    if (task.kind === 'topic' || task.due === undefined || task.due === '') continue
    if (task.status === 'canceled') continue
    const done = task.status === 'done'
    if (task.due > today) {
      // 卡片版的「明天 / 更晚」:只要还没办完的(将来的事提前办完了,不再挂着)。
      if (!done) ahead.push({ id: task.id, title: task.title, due: task.due, done, overdue: false, created_at: task.created_at })
      continue
    }
    if (done && dayOfIso(task.done_at ?? task.updated_at) !== today) continue
    items.push({ id: task.id, title: task.title, due: task.due, done, overdue: !done && task.due < today, created_at: task.created_at })
  }
  items.sort((a, b) => Number(a.done) - Number(b.done)
    || Number(b.overdue) - Number(a.overdue)
    || (a.overdue ? a.due.localeCompare(b.due) : 0)
    || a.created_at.localeCompare(b.created_at))
  ahead.sort((a, b) => a.due.localeCompare(b.due) || a.created_at.localeCompare(b.created_at))
  const tomorrow = nextDayOf(today)
  const strip = (list: typeof items): TodayTodoItem[] => list.map(({ created_at: _, ...one }) => one)
  const todayItems = strip(items)
  const groups: TodayTodoGroup[] = [
    { key: 'today', label: '今天', items: todayItems },
    { key: 'tomorrow', label: '明天', items: strip(ahead.filter(one => one.due === tomorrow)) },
    { key: 'later', label: '更晚', items: strip(ahead.filter(one => one.due > tomorrow)) },
  ]
  return { date: today, tomorrow, items: todayItems, style, groups }
}
