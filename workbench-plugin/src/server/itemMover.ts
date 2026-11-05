/**
 * 「现在该谁动」(2026-09-25,卡 N;设计第一节第 1、2 条)。
 *
 * **事项与看板卡是同一份数据的两种排法**:看板按项目 / 冲刺 / 模块排,事项按「现在该谁动」排。
 * 这个文件把一张卡算成那一格(`TaskView.mover`),组装 /state 时现算,不落盘;电脑、手机、早报都读这一格,不各算各的。
 *
 * | 卡上负责人 | 现在该谁动 |
 * |---|---|
 * | 某家 AI(Codex / Claude / Kimi / Muse / Manus / 豆包 / GPT) | 派出去了在做 → 那家;等他点头派 → 他;还没派 → 事务官(她按档位去问 / 去派);派不出去(挑手说不行)→ 他(要他修) |
 * | 事务官 | 她在办 / 排着 → 事务官 |
 * | 他 | 他 |
 * | 同事 / 别人 | 等那个人(只跟进,到期提醒) |
 * | 没写(他交给事务官的老事项) | 事务官 |
 *
 * 不管负责人是谁:等我确认 → 他验收;阻塞 → 他解;证据里冒出来的下一步(待排)→ 他点头;办完 / 取消 → 没人。
 */
import type { TaskAssignee, TaskMoverView, TaskView, WaitReason } from '../protocol.ts'
import { ASSIGNEE_NAMES, isAgentDispatchFamily, isPersonAssignee } from '../protocol.ts'

export interface MoverContext {
  /** 此刻挂着「这张派给 X 开工?」的卡(审批经纪人里 `dispatch:<id>` 那几条)。 */
  askingDispatch?: ReadonlySet<string>
  /** 此刻在跑的会话(`agent:session_id`)。 */
  runningSessions?: ReadonlySet<string>
  /** 负责人驱动记下的:这张为什么没派(挑手说不行、他没批、只出方案档)。 */
  held?: ReadonlyMap<string, { why: string, who: 'me' | 'butler' }>
}

const BLOCK_WORDS: Readonly<Record<WaitReason, string>> = {
  approval: '等你批',
  input: '等你回话',
  quota: '额度不够了',
  error: '出错了',
}

function mmdd(date: string | undefined): string {
  const match = /^\d{4}-(\d{2})-(\d{2})/.exec(date ?? '')
  return match === null ? '' : `${Number(match[1])}/${Number(match[2])}`
}

/** 派出去了、还在等那家交回来。 */
function inFlight(task: TaskView, running: ReadonlySet<string>): boolean {
  if (task.client_dispatch?.status === 'sent' && task.client_dispatch.reply_state === 'waiting') return true
  if (task.dispatch?.status === 'running') return true
  if (task.status !== 'doing') return false
  return (task.links ?? []).some(link => link.agent !== 'dsh' && running.has(`${link.agent}:${link.session_id}`))
}

/** 事务官那条会话在跑没有。 */
function butlerRunning(task: TaskView, running: ReadonlySet<string>): boolean {
  if (task.conversation !== undefined && running.has(`dsh:${task.conversation.session_id}`)) return true
  return (task.links ?? []).some(link => link.agent === 'dsh' && running.has(`dsh:${link.session_id}`))
}

export function itemMover(task: TaskView, ctx: MoverContext = {}): TaskMoverView {
  const assignee: TaskAssignee | undefined = task.assignee
  const withOwner = (view: Omit<TaskMoverView, 'assignee'>): TaskMoverView => ({ ...view, ...(assignee === undefined ? {} : { assignee }) })
  const running = ctx.runningSessions ?? new Set<string>()
  const name = assignee === undefined ? undefined : ASSIGNEE_NAMES[assignee]

  if (task.status === 'done') return withOwner({ who: 'none', line: '办完了' })
  if (task.status === 'canceled') return withOwner({ who: 'none', line: '取消了' })
  if (task.origin === 'evidence' && task.status === 'backlog') return withOwner({ who: 'me', line: '对话里提到还要做的,等你点头要不要加' })
  if (task.status === 'confirm') {
    const family = task.client_dispatch?.family ?? task.dispatch?.family
    return withOwner({ who: 'me', line: family === undefined ? '等你验收' : `${ASSIGNEE_NAMES[family]} 交回来了,等你验收` })
  }
  if (task.status === 'blocked') {
    const why = task.block_reason === undefined ? '' : `:${BLOCK_WORDS[task.block_reason]}`
    return withOwner({ who: 'me', line: `卡住了${why}` })
  }
  if (ctx.askingDispatch?.has(task.id) === true) {
    return withOwner({ who: 'me', line: assignee === 'dsh' ? '等你点头交给事务官' : `等你点头派给 ${name ?? '那一家'}` })
  }
  const held = ctx.held?.get(task.id)

  if (assignee !== undefined && isPersonAssignee(assignee)) {
    if (assignee === 'me') return withOwner({ who: 'me', line: `你来${task.due === undefined ? '' : ` · 截止 ${mmdd(task.due)}`}` })
    const note = task.assignee_note === undefined ? '' : ` · ${task.assignee_note}`
    return withOwner({ who: 'others', line: `等${name as string}${note}${task.due === undefined ? '' : ` · ${mmdd(task.due)} 到期`}` })
  }

  if (assignee !== undefined && assignee !== 'dsh' && isAgentDispatchFamily(assignee)) {
    if (inFlight(task, running)) return withOwner({ who: 'agent', line: `${name as string} 在做` })
    if (held !== undefined) return withOwner({ who: held.who, line: held.why })
    if (task.status === 'doing') return withOwner({ who: 'agent', line: `${name as string} 在做(没看到它在跑)` })
    return withOwner({ who: 'butler', line: `排着,等派给 ${name as string}` })
  }

  // 事务官自己办的,或者他交给事务官、没点名的老事项。
  if (held !== undefined) return withOwner({ who: held.who, line: held.why })
  if (butlerRunning(task, running) || task.status === 'doing') return withOwner({ who: 'butler', line: '事务官在办' })
  return withOwner({ who: 'butler', line: '事务官排着' })
}

/**
 * 早报里「负责人」那两段(设计第一节第 2 条):他自己的事提一句、同事 / 别人的到期提醒。
 * 只念**还没办完**的;他自己的按截止日先后,最多三件;到期提醒只念三天内到期(含已过期)的。
 */
export function ownerMorningLines(tasks: readonly TaskView[], now: Date): string[] {
  const open = tasks.filter(task => task.status !== 'done' && task.status !== 'canceled')
  const lines: string[] = []
  const mine = open.filter(task => task.assignee === 'me')
    .sort((a, b) => (a.due ?? '9999').localeCompare(b.due ?? '9999'))
  if (mine.length > 0) {
    const shown = mine.slice(0, 3).map(task => `${task.title}${task.due === undefined ? '' : `(截止 ${mmdd(task.due)})`}`)
    lines.push(`你自己的:${shown.join(';')}${mine.length > 3 ? `;另外 ${mine.length - 3} 件` : ''}`)
  }
  const soon = now.getTime() + 3 * 86_400_000
  const due = open
    .filter(task => (task.assignee === 'colleague' || task.assignee === 'other') && task.due !== undefined)
    .filter(task => {
      const at = Date.parse(`${task.due as string}T23:59:59`)
      return Number.isFinite(at) && at <= soon
    })
    .sort((a, b) => (a.due as string).localeCompare(b.due as string))
  if (due.length > 0) {
    lines.push(`到期提醒:${due.slice(0, 3).map(task => `${task.title}(${ASSIGNEE_NAMES[task.assignee as TaskAssignee]}${task.assignee_note === undefined ? '' : `,${task.assignee_note}`},${mmdd(task.due)})`).join(';')}`)
  }
  return lines
}
