/**
 * ★ **CLI 派活起的会话登记处**(2026-10-23 深夜,卡 A 硬门槛前置;统筹定:既有卡
 * `t-b34ddf83`「命令行派活能续跑」的 Kimi 这一支最小修,由本接缝唯一主人吸收进 A 同分支)。
 *
 * 为什么要有这一份:`finishCli` 把命令行留下的会话号写进**任务 links**(dispatchRun.ts),
 * 但 relay 的候选池(文件型/窗口型/记录型)里没有它 —— 「继续这件事」连来源都认不出。
 * 这里是**内存里的一份小镜像**:`finishCli` 记一条,启动时从任务账补种一次(DSH 重启后
 * 仍在);`sessionJobs.cliSessions` 与 http 的 `relaySessionPool` 读它。不是第二套任务账 —
 * 事实的源头仍是任务 links,这里只放 relay 认池要的那几格。
 */
import type { TasksService } from './tasks.ts'
import type { RelaySessionView } from './sessionRelay.ts'

interface Entry { agent: string, session_id: string, title: string, at: string, cwd?: string }

const entries = new Map<string, Entry>()

const key = (agent: string, sessionId: string): string => `${agent}:${sessionId}`

/** 命令行那一次收场、留下会话号时记一条(finishCli 调;同键只留第一条)。 */
export function noteCliDispatchSession(agent: string, sessionId: string, title: string, at: string, cwd?: string): void {
  const k = key(agent, sessionId)
  if (!entries.has(k)) entries.set(k, { agent, session_id: sessionId, title, at, ...(cwd === undefined ? {} : { cwd }) })
}

/** 这条 CLI 会话当初在哪个目录起的(kimi 续跑认原目录,换了目录它拒绝)。 */
export function cliDispatchSessionCwd(agent: string, sessionId: string): string | undefined {
  return entries.get(key(agent, sessionId))?.cwd
}

/** relay 候选池 / 认名字要的那一份(同步;最简会话视图)。 */
export function cliDispatchSessions(): readonly RelaySessionView[] {
  return [...entries.values()].map(one => ({
    agent: one.agent,
    session_id: one.session_id,
    title: one.title,
    project: '未归类',
    status: 'waiting' as const,
    elapsed_sec: 0,
    unread: false,
    updated_at: one.at,
  }))
}

/** 启动补种:任务账里 `dispatch.hand==='cli'` 且带会话号的,都认(卡上还留着的就是事实)。 */
export async function seedCliDispatchSessions(tasks: TasksService): Promise<number> {
  let n = 0
  for (const task of (await tasks.list()).tasks) {
    const dispatch = task.dispatch
    if (dispatch?.hand !== 'cli' || typeof dispatch.session_id !== 'string' || dispatch.session_id === '') continue
    noteCliDispatchSession(dispatch.family, dispatch.session_id, task.title, dispatch.started_at || new Date(0).toISOString(), dispatch.cwd)
    n += 1
  }
  return n
}

/** 用例用:清空。 */
export function clearCliDispatchSessions(): void {
  entries.clear()
}
