/**
 * **定时派活**(2026-10-21 协作区全量,视觉需求第 9 屏;维护者勾回来的「自定义定时任务」)。
 *
 * 挂在 http.ts 那根既有的节拍上(`pump()`),内部一分钟才看一次;到点的那几条建一张便签 ——
 * 四样照样过门(模板必须有标题与验收,来源固定 `from:{kind:'user', ref:'timer:<id>'}`、负责人就是派给的那张名片),
 * 负责人是一家能派的 Agent 时顺手走现有派活。每次运行记一条(新的在后,最多 20 条)。
 * **同一分钟不重复跑**(记最后跑过的那一分钟)。webhook 的地址由中转发,阶段二才有:这里只认 cron。
 */
import type { CollabTimer, TaskAssignee } from '../protocol.ts'
import { isTaskAssigneeValue } from '../protocol.ts'
import { cronMatches, minuteKey, parseCron } from './collabCron.ts'
import { noteGate } from './noteGate.ts'
import type { TasksService } from './tasks.ts'

export interface TimerRunner {
  /** 节拍上调:一分钟只真看一次。 */
  pump: () => Promise<void>
  /** 立刻跑一次(界面「现在跑一次」)。 */
  runNow: (id: string) => Promise<{ ok: boolean, note_id?: string, why?: string }>
}

export function createTimerRunner(deps: {
  tasks: Pick<TasksService, 'list' | 'create' | 'recordTimerRun'>
  now?: () => Date
  /** 负责人是一家能派的 Agent:派出去(缺席 = 只建便签)。 */
  dispatch?: (noteId: string, family: string, text: string) => Promise<unknown>
  canDispatch?: (family: string) => boolean
  onChanged?: () => void
}): TimerRunner {
  const now = deps.now ?? (() => new Date())
  let lastMinute = ''
  const ranAt = new Map<string, string>()

  async function run(timer: CollabTimer): Promise<{ ok: boolean, note_id?: string, why?: string }> {
    const at = now().toISOString()
    const assignee = timer.assignee as TaskAssignee
    const gate = noteGate({
      ...(timer.template.goal_id === undefined ? {} : { goal_id: timer.template.goal_id }),
      from: { kind: 'user', ref: `timer:${timer.id}` },
      acceptance: timer.template.acceptance,
      ...(isTaskAssigneeValue(assignee) ? { assignee } : {}),
    })
    if (!gate.ok) {
      await deps.tasks.recordTimerRun(timer.id, { at, ok: false, why: gate.error })
      return { ok: false, why: gate.error }
    }
    const created = await deps.tasks.create({
      title: timer.template.title,
      goalId: gate.goal_id,
      from: { kind: 'user', ref: `timer:${timer.id}`, quote: `定时派活「${timer.name}」` },
      acceptance: timer.template.acceptance,
      assignee,
      workType: 'routine',
    })
    if (!created.ok || created.id === undefined) {
      const why = created.reason ?? '便签没建成'
      await deps.tasks.recordTimerRun(timer.id, { at, ok: false, why })
      return { ok: false, why }
    }
    let why: string | undefined
    if (deps.dispatch !== undefined && deps.canDispatch?.(timer.assignee) === true) {
      try { await deps.dispatch(created.id, timer.assignee, timer.template.title) }
      catch (error) { why = `便签建了,派出去时出错:${error instanceof Error ? error.message : String(error)}` }
    }
    await deps.tasks.recordTimerRun(timer.id, { at, ok: why === undefined, note_id: created.id, ...(why === undefined ? {} : { why }) })
    deps.onChanged?.()
    return { ok: why === undefined, note_id: created.id, ...(why === undefined ? {} : { why }) }
  }

  return {
    async pump() {
      const at = now()
      const key = minuteKey(at)
      if (key === lastMinute) return
      lastMinute = key
      const timers = (await deps.tasks.list()).timers ?? []
      for (const timer of timers) {
        if (!timer.enabled || timer.trigger.kind !== 'cron') continue
        const spec = parseCron(timer.trigger.cron)
        if (spec === undefined || !cronMatches(spec, at) || ranAt.get(timer.id) === key) continue
        ranAt.set(timer.id, key)
        await run(timer).catch(() => undefined)
      }
    },
    async runNow(id) {
      const timer = ((await deps.tasks.list()).timers ?? []).find(one => one.id === id)
      if (timer === undefined) return { ok: false, why: '没有这条定时派活' }
      return await run(timer)
    },
  }
}
