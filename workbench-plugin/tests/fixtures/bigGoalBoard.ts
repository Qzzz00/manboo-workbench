// 照 10-28 真机板子的形状造的夹具(标题、时刻都是编的):板上 150 张卡;目标 g1 下 32 件,21 件进行中、11 件已完成;
// `/collab/trace?goal_id=g1` 的回包约 36 KB(每件派发 / 送达 / 开工,做完的多一条交回,正文照真机回执的长度)。
import type { GoalTraceView, RunSegment, TaskTrace, TaskView } from '../../src/protocol.ts'

export const BIG_DAY = '2026-10-28'
const AT = `${BIG_DAY}T01:00:00.000Z`
const FAMILIES = ['codex', 'claude', 'kimi', 'doubao'] as const
const at = (minute: number): string => new Date(Date.parse(`${BIG_DAY}T00:00:00.000Z`) + minute * 60_000).toISOString()
const RETURN_TEXT = '交回:按验收单在内部同学的机器上走了一遍,装机、登录、派活、交回四步都过了;截图与日志路径写在交接里,另有两处文案待你定。'

export function bigBoardTasks(): TaskView[] {
  return Array.from({ length: 150 }, (_, i): TaskView => ({
    id: `b${i}`, title: `第 ${i + 1} 件 · 内部同学试用里冒出来的事`, source: { kind: 'manual' }, created_at: AT, updated_at: AT,
    goal_id: i < 32 ? 'g1' : i % 2 === 0 ? 'g2' : 'g3', assignee: FAMILIES[i % 4]!,
    status: i < 21 ? 'doing' : i < 32 ? 'done' : i < 60 ? 'doing' : 'todo',
  }))
}

const who = (task: TaskView): string => task.assignee ?? 'codex'

export function bigBoardTrace(tasks: readonly TaskView[] = bigBoardTasks()): GoalTraceView {
  return {
    goal_id: 'g1',
    traces: tasks.filter(one => one.goal_id === 'g1').map((one, i): TaskTrace => ({
      task_id: one.id,
      nodes: [
        { at: at(i * 7), kind: 'dispatch', actor: 'butler', to: who(one), text: `派给 ${who(one)}:${one.title},验收照任务书第 ${i + 1} 条` },
        { at: at(i * 7 + 1), kind: 'sent', actor: 'butler', to: who(one) },
        { at: at(i * 7 + 3), kind: 'start', actor: who(one) },
        { at: at(i * 7 + 10), kind: 'handoff', actor: who(one), to: 'butler', text: RETURN_TEXT },
        ...(one.status === 'done' ? [
          { at: at(i * 7 + 40), kind: 'return' as const, actor: who(one), to: 'me', text: RETURN_TEXT },
          { at: at(i * 7 + 40), kind: 'artifact' as const, actor: who(one), evidence: [`docs/交接-1028-第${i + 1}件.md`, `claude/card-${i + 1}`] },
          { at: at(i * 7 + 55), kind: 'accept' as const, actor: 'me', text: RETURN_TEXT },
        ] : [
          { at: at(i * 7 + 20), kind: 'arrange' as const, actor: 'butler', text: `${RETURN_TEXT}(进行中补充说明)` },
        ]),
      ],
      current: { state: one.status === 'done' ? 'done' : 'running', actor: who(one), since: at(i * 7 + 3) },
    })),
  }
}

export function bigBoardRuns(tasks: readonly TaskView[] = bigBoardTasks()): RunSegment[] {
  return tasks.filter(one => one.goal_id === 'g1' && one.status === 'doing').map((one, i): RunSegment => ({
    task_id: one.id, agent: who(one), source: who(one) as RunSegment['source'], status: 'running', session_id: `s${i}`,
    started_at: at(i * 7), execution_started_observed_at: at(i * 7 + 3),
  }))
}
