/**
 * 「今天的待办」那一格的两版显示(2026-10-12,周三演示)。电话那件 `wb_todo_view`(tools.ts)
 * 与打 8791 那一层(workbench.ts)共用这几句;单放一个文件免得两边互相 import。
 *
 * ★ **2026-10-13 两版改名**(维护者:「改成按列表展示或按卡片展示」):`by_date` 现在是**卡片**,
 * `flat` 是**列表**。两个值一个字没改 —— 换的只是嘴里怎么说(8791 那边同步,见
 * `workbench-plugin/src/protocol.ts` 的 `TODAY_VIEW_TITLES`)。
 */
/** 两版。与 8791 的 `TODAY_VIEWS` 同一份(工作台认不出的回 400)。 */
export const TODO_VIEWS = ['by_date', 'flat'] as const
export type TodoView = typeof TODO_VIEWS[number]

/** 两版在嘴里叫什么(与 8791 的 `TODAY_VIEW_TITLES` 同一份)。 */
export const TODO_VIEW_TITLES: Readonly<Record<TodoView, string>> = { by_date: '卡片', flat: '列表' }

/** 复述那一句。 */
export function todoViewConfirmText(view: TodoView): string {
  return view === 'by_date' ? '把待办改成卡片,对吗?' : '把待办改回列表,对吗?'
}

/** 切好了说的那一句。 */
export function todoViewDoneText(view: TodoView): string {
  return view === 'by_date' ? '好,改成卡片了。' : '好,改回列表了。'
}

/** 本来就是这一版(没切)时说的那一句。**不许说成改了**。 */
export function todoViewSameText(view: TodoView): string {
  return `本来就是${TODO_VIEW_TITLES[view]}的,没动。`
}
