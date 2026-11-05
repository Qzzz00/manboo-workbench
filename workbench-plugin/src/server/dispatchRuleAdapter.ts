import type { DispatchRunDeps } from './dispatchRun.ts'
import type { RulesService } from './rules.ts'
import type { TasksService } from './tasks.ts'

/** 普通规矩判断只读本实例事项的标题和描述；缺项沿原空串语义。 */
export async function dispatchRuleTaskText(tasks: Pick<TasksService, 'list'> | undefined, itemId: string | undefined): Promise<string> {
  if (itemId === undefined || itemId === '' || tasks === undefined) return ''
  const task = (await tasks.list()).tasks.find(one => one.id === itemId)
  return task === undefined ? '' : [task.title, task.desc ?? ''].join('\n')
}

/** HTTP 默认回退与显式 host 装配共用同一份普通规矩适配，不另定筛选规则。 */
export function createOrdinaryDispatchRulesFor(input: {
  tasks?: Pick<TasksService, 'list'> | undefined
  rules?: Pick<RulesService, 'brief'> | undefined
}): DispatchRunDeps['rulesFor'] {
  const { tasks, rules } = input
  if (rules === undefined) return undefined
  return async ({ taskId, said, kind }) => rules.brief('dispatch', [await dispatchRuleTaskText(tasks, taskId), said].join('\n'), kind).text
}
