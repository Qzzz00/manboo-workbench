/**
 * 事项类型表在协作区里的读法(2026-10-22,统筹转维护者:类型名不写死,做成设置)。
 * 表从 `/state.tasks.work_types` 来(`GET / POST /collab/types` 那一张);拿不到就用缺省四类。
 * 名字、图标、暗亮两套底色都从这里读:卡头、图例、详情里的下拉、筛选。
 */
import { createContext, useContext } from 'react'
import type { CollabWorkTypeView, WorkbenchState } from '../../protocol.ts'
import { DEFAULT_WORK_TYPES } from '../../protocol.ts'

export function workTypesOf(state: WorkbenchState): readonly CollabWorkTypeView[] {
  const table = state.tasks?.work_types
  return table === undefined || table.length === 0 ? DEFAULT_WORK_TYPES : table
}

export const WorkTypesContext = createContext<readonly CollabWorkTypeView[]>(DEFAULT_WORK_TYPES)

export function useWorkTypes(): readonly CollabWorkTypeView[] {
  return useContext(WorkTypesContext)
}

/**
 * 每一类的底色:`--t-<id>` 暗亮各一份,`[data-type=<id>]` 读它。id 已按 `WORK_TYPE_ID` 校验过(小写字母、数字、连字符),
 * 颜色是 `#rrggbb`,拼进样式表不会漏出别的东西。
 */
export function workTypeStyle(types: readonly CollabWorkTypeView[]): string {
  const vars = (theme: 'dark' | 'light') => types.map(one => `--t-${one.id}:${one.color[theme]}`).join(';')
  return [
    `.ben-cl[data-theme=dark]{${vars('dark')}}`,
    `.ben-cl[data-theme=light]{${vars('light')}}`,
    ...types.map(one => `.ben-cl [data-type="${one.id}"]{--cl-tbg:var(--t-${one.id})}`),
  ].join('\n')
}
