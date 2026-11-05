/**
 * 目标上的排期风险(2026-10-21 协作区,设计稿第四节第 7 条):**目标有 `due` 才算**,
 * 只写在目标标题栏右侧一行小字;没有截止日什么都不写(今天看板开头那串红字「晚了 17 天 / 无法判断」不再出现)。
 * 口径与项目行同一份(`scheduleRisk.assessScheduleRisk`),任务取贴在这个目标里的便签。
 */
import type { CollabGoal, ScheduleRisk, TaskView } from '../protocol.ts'
import { goalIdOf } from '../protocol.ts'
import { assessScheduleRisk } from './scheduleRisk.ts'

export function goalRisks(goals: readonly CollabGoal[], tasks: readonly TaskView[], nowSec: number): Record<string, ScheduleRisk> {
  const out: Record<string, ScheduleRisk> = {}
  for (const goal of goals) {
    if (goal.due === undefined || goal.status !== 'open') continue
    out[goal.id] = assessScheduleRisk({ ddl: goal.due, tasks: tasks.filter(task => goalIdOf(task) === goal.id) }, nowSec)
  }
  return out
}
