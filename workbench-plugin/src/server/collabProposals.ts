/**
 * **他直接开的会话,放进哪个目标**(2026-10-21 协作区,设计稿第五节第 3 条;10-22 第三轮 4 维护者定 B;
 * 10-28 任务书 11 维护者 15:0x「这种能不能别问我」)。
 *
 * 维护者 10-21:因为事务官不好用,他一直直接和 Codex / Claude / Kimi 聊,于是没有了事项卡这个目标。
 * 会话没连在任何便签上、最近三天动过 → 提一条:对得上(标题 / 项目,见 {@link GOAL_MATCH_MIN_LIKENESS})就带 `goal_id`
 * 由 http.ts 直接放进去,不问;对不上才留一条问她,默认选项是「新目标:〈会话标题〉」。只有一个还在推的目标时不问,
 * 直接放进去({@link singleOpenGoal})。说「不进看板」就记下不再提(`POST /collab/session/dismiss`)。
 * 已放进的那一行随时可换目标 / 不进看板(可撤回)。
 * 注意:10-28 设计稿(理解中枢,模型出命令)定了由中枢 `set_goal` 带上下文最终接管这个判断;这里是中枢落地前的
 * 快路径——命中即走、不命中不拦,别把新词表加在这一层。纯函数,组装 /state 时现算。
 */
import type { CollabGoal, SessionProposal, SessionView, TaskView, WorkbenchProject } from '../protocol.ts'

/** 多久以内动过的会话才提(老的那些他自己早忘了,提了是打扰)。 */
export const PROPOSAL_WINDOW_MS = 3 * 86_400_000
/** 一次最多提几条(「现在等你」那一条不该被它占满)。 */
export const PROPOSALS_MAX = 5

/** 一张卡上挂着的所有会话键(`<家>:<id>`)。 */
function linkedKeys(tasks: readonly TaskView[]): Set<string> {
  const keys = new Set<string>()
  for (const task of tasks) {
    for (const link of task.links ?? []) keys.add(`${link.agent}:${link.session_id}`)
    if (task.conversation !== undefined) keys.add(`dsh:${task.conversation.session_id}`)
    if (task.source.kind === 'session' && task.source.ref !== undefined) keys.add(task.source.ref)
    if (task.from?.kind === 'session' && task.from.ref !== undefined) keys.add(task.from.ref)
    const dispatched = task.dispatch?.session_id ?? task.client_dispatch?.session_id
    const family = task.dispatch?.family ?? task.client_dispatch?.family
    if (dispatched !== undefined && family !== undefined) keys.add(`${family}:${dispatched}`)
  }
  return keys
}

function projectOf(session: SessionView, projects: readonly WorkbenchProject[]): WorkbenchProject | undefined {
  return projects.find(one => one.id === session.project || one.name === session.project)
    ?? (session.cwd === undefined ? undefined : projects.find(one => one.path !== undefined && session.cwd?.startsWith(one.path)))
}

/** 两段字里共有的两字片段有几个(中文按字切,英文按小写)。只拿来排「哪个目标名最像会话标题」。 */
function likeness(a: string, b: string): number {
  const grams = (text: string): Set<string> => {
    const plain = text.toLowerCase().replace(/\s+/g, '')
    const out = new Set<string>()
    for (let i = 0; i + 1 < plain.length; i += 1) out.add(plain.slice(i, i + 2))
    return out
  }
  const left = grams(a)
  let n = 0
  for (const one of grams(b)) if (left.has(one)) n += 1
  return n
}

/**
 * 对题判据(10-28 任务书 11):会话标题与目标名共有的两字片段达到这个数,或会话认得的项目就是目标挂的项目,
 * 就算「对得上」——直接放进去,不问。一个都对不上才留给她选,不猜(猜错了比问一句更烦,反正问的时候带默认选项、放完可撤回)。
 */
export const GOAL_MATCH_MIN_LIKENESS = 1

/**
 * 默认放进哪个目标(10-22 第三轮 4,维护者定):还在推的目标里,名字和会话标题最像的那个;
 * 一样像(多半是都不像)时,同一个项目里最近动过的那个;再没有就最近动过的那个。
 * `matched` 是对题判据(任务书 11):最像的那个是不是真的像(标题像、或项目就是会话的项目)。
 */
function bestGoalFor(title: string, projectId: string | undefined, goals: readonly CollabGoal[]): { goal: CollabGoal, matched: boolean } | undefined {
  const open = goals.filter(one => one.status === 'open')
  const rank = (goal: CollabGoal): [number, number, number] => [likeness(title, goal.title), projectId !== undefined && goal.project_id === projectId ? 1 : 0, Date.parse(goal.updated_at) || 0]
  const goal = [...open].sort((a, b) => {
    const [x, y] = [rank(a), rank(b)]
    return (y[0] - x[0]) || (y[1] - x[1]) || (y[2] - x[2])
  })[0]
  if (goal === undefined) return undefined
  const matched = rank(goal)[0] >= GOAL_MATCH_MIN_LIKENESS || (projectId !== undefined && goal.project_id === projectId)
  return { goal, matched }
}

/** 只有一个还在推的目标时就是它:那时不问,直接放进去(10-22 第三轮 4,维护者定)。 */
export function singleOpenGoal(goals: readonly CollabGoal[]): string | undefined {
  const open = goals.filter(one => one.status === 'open')
  return open.length === 1 ? open[0]?.id : undefined
}

export function sessionProposals(input: {
  sessions: readonly SessionView[]
  tasks: readonly TaskView[]
  goals: readonly CollabGoal[]
  projects: readonly WorkbenchProject[]
  dismissed: readonly string[]
  nowMs: number
}): SessionProposal[] {
  const linked = linkedKeys(input.tasks)
  const dismissed = new Set(input.dismissed)
  const cut = input.nowMs - PROPOSAL_WINDOW_MS
  const picked = input.sessions
    .filter(one => one.agent !== 'dsh')
    .filter(one => !linked.has(`${one.agent}:${one.session_id}`) && !dismissed.has(`${one.agent}:${one.session_id}`))
    .filter((one) => {
      const at = Date.parse(one.updated_at)
      return Number.isFinite(at) && at >= cut
    })
    .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at))
    .slice(0, PROPOSALS_MAX)
  return picked.map((session): SessionProposal => {
    const title = (session.title ?? session.summary ?? session.project).trim().slice(0, 60) || session.project
    const project = projectOf(session, input.projects)
    const best = bestGoalFor(title, project?.id, input.goals)
    // 任务书 11:对得上(标题 / 项目)带 goal_id 由 http.ts 直接放;对不上不猜,提议新目标(问的时候的默认选项)。
    return {
      agent: session.agent,
      session_id: session.session_id,
      title,
      ...(project === undefined ? {} : { project_id: project.id }),
      ...(best === undefined || !best.matched ? { new_goal_title: title } : { goal_id: best.goal.id }),
      at: session.updated_at,
    }
  })
}
