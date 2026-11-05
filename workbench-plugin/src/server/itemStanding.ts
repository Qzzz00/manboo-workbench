/**
 * 没办完的事项停在哪(2026-10-12,卡「没办完的事项说清楚」;来由:运营同学 10-12 排查报告 ——
 * 305 件里阻塞 9、进行中 2、待确认 2,最近更新都停在几天前,说不清是正常等她、结果没回写、通道失败没继续,还是已不需要没关)。
 *
 * 每件没办完的事项算三样,**纯代码、按已有证据、不经模型,取不到就缺席**:
 *   - 最后一条证据(什么、什么时刻、来源:派活回执 / 会话 / 她的操作;卡上改动只作兜底,说明是「卡上改动」);
 *   - 现在在等谁(她 / 某家 AI / 解锁电脑 / 同事别人 / 没人在等);
 *   - 下一步(一句人话)。
 * 再归成一种停法(`ItemStandingCase`)。组装 /state 时现算(与 `itemMover` 同一处),不落盘、不起扫描:
 * 早报读的就是 /state 上这一格(`stalledMorningLines`)。
 *
 * 判的先后(前面的命中就不往下看):
 *   1. 锁屏排着(任务账最后一条是 `waiting`,之后没再送)→ 等她解锁电脑;
 *   2. 字写进框没发出去 → 等她按发送;
 *   3. 等我确认 → 等她验收;阻塞:出错 → 通道失败,其余 → 等她;「现在该谁动」是她 → 等她;
 *   4. 派活回执与会话里**最晚的那个有信号的证据**:失败 → 通道失败;在等她 → 等她;交回了 / 说完了而卡在进行中 → 结果没回写;
 *      送到了 / 在跑 → 在做(**看见了那一句只算送到,不算办完**);
 *   5. 等同事 / 别人 → 等别人;
 *   6. 都没有 → 没人在等:离最后一条证据 ≥ {@link ITEM_LIKELY_MOOT_DAYS} 天 → 多半不再需要,否则排着。
 */
import type {
  ItemEvidenceSource, ItemEvidenceView, ItemStandingAction, ItemStandingCase, ItemStandingView, ItemWaitingOn,
  SessionStatus, TaskMoverView, TaskView,
} from '../protocol.ts'
import { ITEM_LIKELY_MOOT_DAYS, ITEM_STANDING_STALL_DAYS, assigneeName, isTrackedItem, taskOriginOf } from '../protocol.ts'
import type { JobEvent } from './jobLog.ts'

export interface StandingSession {
  status: SessionStatus
  updated_at: string
}

export interface StandingContext {
  now: Date
  /** 这张卡此刻「现在该谁动」(`itemMover` 算的那一格)。 */
  mover?: TaskMoverView
  /** 会话现查表,键 `agent:session_id`。 */
  sessions?: ReadonlyMap<string, StandingSession>
  /** 任务账上这件事的事件(`jobLog.events(task.id)`)。 */
  jobEvents?: readonly JobEvent[]
}

/** 一条证据带的信号:失败、在等她、交回了 / 说完了、送到了 / 在跑;`neutral` 只算证据、不定停法。 */
type Signal = 'fail' | 'her' | 'done' | 'live' | 'lock' | 'neutral'

interface Evidence extends ItemEvidenceView {
  signal: Signal
  family?: string
  ms: number
}

const DAY_MS = 86_400_000

function who(family: string | undefined): string {
  return family === undefined ? '那一家' : assigneeName(family)
}

function stamp(at: string | undefined): number | undefined {
  if (at === undefined) return undefined
  const ms = Date.parse(at)
  return Number.isNaN(ms) ? undefined : ms
}

function push(list: Evidence[], at: string | undefined, what: string, source: ItemEvidenceSource, signal: Signal, family?: string): void {
  const ms = stamp(at)
  if (ms === undefined || at === undefined) return
  list.push({ what, at, source, signal, ms, ...(family === undefined ? {} : { family }) })
}

const JOB_WORDS: Partial<Record<JobEvent['step'], { what: (family: string) => string, signal: Signal }>> = {
  assigned: { what: f => `交给了 ${f}`, signal: 'neutral' },
  sent: { what: f => `送进 ${f} 了,还没核上`, signal: 'live' },
  seen: { what: f => `在 ${f} 那边看到了那一句(已送达,不等于办完)`, signal: 'live' },
  replied: { what: f => `${f} 交回来了`, signal: 'done' },
  timeout: { what: f => `等 ${f} 回话等过头了`, signal: 'fail' },
  unreadable: { what: f => `${f} 那边的回话读不到`, signal: 'fail' },
  not_sent: { what: f => `没送进 ${f}`, signal: 'fail' },
  waiting: { what: f => `电脑锁着屏,给 ${f} 的那一句排着等解锁`, signal: 'lock' },
  budget_stop: { what: () => '到上限先停下来了', signal: 'her' },
}

const SESSION_WORDS: Partial<Record<SessionStatus, { what: (name: string) => string, signal: Signal }>> = {
  running: { what: n => `${n} 那段会话在跑`, signal: 'live' },
  waiting: { what: n => `${n} 那段会话在等你`, signal: 'her' },
  done: { what: n => `${n} 那段会话说完了`, signal: 'done' },
  error: { what: n => `${n} 那段会话出错了`, signal: 'fail' },
}

function collect(task: TaskView, ctx: StandingContext): Evidence[] {
  const list: Evidence[] = []
  // 她的操作:她交代了这件事。
  if (taskOriginOf(task) === 'user') push(list, task.created_at, '你交代了这件事', 'her', 'neutral')
  push(list, task.updated_at, '卡上最后一次改动', 'card', 'neutral')

  const d = task.dispatch
  if (d !== undefined) {
    const name = who(d.family)
    push(list, d.started_at, `派给了 ${name}`, 'dispatch', d.status === 'running' ? 'live' : 'neutral', d.family)
    if (d.ended_at !== undefined) {
      if (d.status === 'done') push(list, d.ended_at, `${name} 交回来了`, 'dispatch', 'done', d.family)
      else if (d.stopped === 'user') push(list, d.ended_at, `你停掉了派给 ${name} 的那一次`, 'her', 'neutral', d.family)
      else if (d.stopped === 'cap') push(list, d.ended_at, `派给 ${name} 的那一次到上限停下了`, 'dispatch', 'her', d.family)
      else if (d.status === 'failed') push(list, d.ended_at, `派给 ${name} 没做成${d.note === undefined || d.note.trim() === '' ? '' : `:${d.note.trim()}`}`, 'dispatch', 'fail', d.family)
    }
  }

  const c = task.client_dispatch
  if (c !== undefined) {
    const name = who(c.family)
    if (c.status === 'failed') push(list, c.at, `没送进 ${name}${c.reason === undefined || c.reason.trim() === '' ? '' : `:${c.reason.trim()}`}`, 'dispatch', 'fail', c.family)
    else if (c.status === 'typed') push(list, c.at, `字写进 ${name} 的输入框了,没发出去`, 'dispatch', 'her', c.family)
    else push(list, c.at, `送进 ${name} 了,还没核上`, 'dispatch', 'live', c.family)
    if (c.status === 'sent') push(list, c.seen_at, `在 ${name} 那边看到了那一句(已送达,不等于办完)`, 'dispatch', 'live', c.family)
    if (c.reply_state === 'done') push(list, c.reply_at ?? c.seen_at ?? c.at, `${name} 的回话读回来了`, 'dispatch', 'done', c.family)
    if (c.reply_state === 'unreadable') push(list, c.reply_at ?? c.seen_at ?? c.at, `${name} 的回话读不回来`, 'dispatch', 'her', c.family)
  }

  for (const event of ctx.jobEvents ?? []) {
    if (event.job !== task.id) continue
    const words = JOB_WORDS[event.step]
    if (words === undefined) continue
    push(list, event.at, words.what(who(event.family)), 'dispatch', words.signal, event.family)
  }

  // 卡上挂的会话:事务官那条 + 关联窗口 + 派活认上的那条。
  const keys = new Map<string, string>()
  if (task.conversation !== undefined) keys.set(`dsh:${task.conversation.session_id}`, 'dsh')
  for (const link of task.links ?? []) keys.set(`${link.agent}:${link.session_id}`, link.agent)
  if (d?.session_id !== undefined) keys.set(`${d.family}:${d.session_id}`, d.family)
  if (c?.session_id !== undefined) keys.set(`${c.family}:${c.session_id}`, c.family)
  for (const [key, agent] of keys) {
    const session = ctx.sessions?.get(key)
    if (session === undefined) continue
    const words = SESSION_WORDS[session.status]
    if (words === undefined) continue
    push(list, session.updated_at, words.what(who(agent)), 'session', words.signal, agent)
  }
  return list
}

/** 同一时刻:有来源的证据先于「卡上改动」。 */
const SOURCE_RANK: Readonly<Record<ItemEvidenceSource, number>> = { dispatch: 3, session: 3, her: 2, card: 1 }

function latest(list: readonly Evidence[]): Evidence | undefined {
  let best: Evidence | undefined
  for (const one of list) {
    if (best === undefined || one.ms > best.ms || (one.ms === best.ms && SOURCE_RANK[one.source] > SOURCE_RANK[best.source])) best = one
  }
  return best
}

function view(input: {
  task: TaskView
  case: ItemStandingCase
  waiting_on: ItemWaitingOn
  next: string
  last: Evidence | undefined
  now: Date
  agent?: string | undefined
}): ItemStandingView {
  const { last } = input
  const idle = last === undefined ? undefined : Math.max(0, Math.floor((input.now.getTime() - last.ms) / DAY_MS))
  const limit = (ITEM_STANDING_STALL_DAYS as Readonly<Record<string, number>>)[input.case]
  const stalled = limit !== undefined && idle !== undefined && idle >= limit
  const dispatched = input.task.dispatch !== undefined || input.task.client_dispatch !== undefined
  const actions: ItemStandingAction[] | undefined = input.case === 'likely_moot'
    ? ['continue', 'close']
    : input.case === 'result_unwritten' || input.case === 'channel_failed'
      ? ['continue', 'close', 'redispatch']
      : input.case === 'waiting_her'
        ? (dispatched ? ['continue', 'close', 'redispatch'] : ['continue', 'close'])
        : undefined
  return {
    case: input.case,
    ...(last === undefined ? {} : { last: { what: last.what, at: last.at, source: last.source } }),
    waiting_on: input.waiting_on,
    ...(input.agent === undefined ? {} : { agent: input.agent }),
    next: input.next,
    ...(idle === undefined ? {} : { idle_days: idle }),
    ...(stalled ? { stalled: true as const } : {}),
    ...(actions === undefined ? {} : { actions }),
  }
}

export function itemStanding(task: TaskView, ctx: StandingContext): ItemStandingView | undefined {
  if (task.status !== 'todo' && task.status !== 'doing' && task.status !== 'confirm' && task.status !== 'blocked') return undefined
  if (task.casual === true || !isTrackedItem(task)) return undefined

  const evidence = collect(task, ctx)
  const last = latest(evidence)
  const base = { task, last, now: ctx.now }
  const mover = ctx.mover

  // 1. 锁屏排着:任务账最后一条有信号的是 `waiting`。
  const jobSignals = evidence.filter(one => one.source === 'dispatch' && one.signal !== 'neutral')
  const lastJob = latest(jobSignals)
  if (lastJob?.signal === 'lock') {
    return view({ ...base, case: 'waiting_her', waiting_on: 'unlock', agent: lastJob.family, next: `电脑一解锁就接着送给 ${who(lastJob.family)}` })
  }
  // 2. 字写进框没发出去。
  const c = task.client_dispatch
  if (c?.status === 'typed' && lastJob?.signal === 'her' && lastJob.family === c.family) {
    return view({ ...base, case: 'waiting_her', waiting_on: 'her', next: `去 ${who(c.family)} 按一下发送;不做了就关掉` })
  }
  // 3. 看板那一列本身就说了在等她 / 出错了。
  if (task.status === 'confirm') {
    return view({ ...base, case: 'waiting_her', waiting_on: 'her', next: '看一眼交回来的,收下或打回' })
  }
  if (task.status === 'blocked' && task.block_reason === 'error') {
    const why = task.note === undefined || task.note.trim() === '' ? '出错停下了' : `出错停下了:${task.note.trim()}`
    return view({ ...base, case: 'channel_failed', waiting_on: 'nobody', next: `${why}。重派,或者不做了就关掉` })
  }
  if (task.status === 'blocked' || mover?.who === 'me') {
    const line = mover?.line ?? '卡住了'
    return view({ ...base, case: 'waiting_her', waiting_on: 'her', next: task.status === 'blocked' ? `${line};你解一下,不做了就关掉` : line })
  }

  // 4. 派活回执与会话里最晚那个有信号的。
  const signal = latest(evidence.filter(one => one.signal !== 'neutral' && one.signal !== 'lock'))
  if (signal?.signal === 'fail') {
    return view({ ...base, case: 'channel_failed', waiting_on: 'nobody', next: `${signal.what},之后没再推进。重派,或者不做了就关掉` })
  }
  if (signal?.signal === 'her') {
    return view({ ...base, case: 'waiting_her', waiting_on: 'her', next: signal.what.includes('读不回来') ? `结果读不回来,到 ${who(signal.family)} 里看一眼` : `${signal.what},等你定:继续、停掉或换一家` })
  }
  if (signal?.signal === 'done' && task.status === 'doing') {
    return view({ ...base, case: 'result_unwritten', waiting_on: 'nobody', next: `${who(signal.family)} 已经说完了,结果没收进卡:看一眼收下(进「等我确认」),或者重派` })
  }
  if (signal?.signal === 'live') {
    return view({ ...base, case: 'in_motion', waiting_on: 'agent', agent: signal.family, next: `${who(signal.family)} 在做,等它交回来` })
  }

  // 5. 等同事 / 别人。
  if (mover?.who === 'others') return view({ ...base, case: 'waiting_others', waiting_on: 'others', next: mover.line })

  // 6. 没人在等。
  const idle = last === undefined ? undefined : Math.floor((ctx.now.getTime() - last.ms) / DAY_MS)
  if (idle !== undefined && idle >= ITEM_LIKELY_MOOT_DAYS) {
    return view({ ...base, case: 'likely_moot', waiting_on: 'nobody', next: `${idle} 天没动静、也没人在等:还要就继续,不要就关掉` })
  }
  return view({ ...base, case: 'queued', waiting_on: 'nobody', next: mover?.line ?? '排着,还没人动' })
}

/** 早报那一段最多列几件(最久的在前)。 */
export const STALLED_MORNING_MAX = 5
export const STALLED_MORNING_HEAD = '停太久的几件(卡上点「继续 / 关掉 / 重派」,或者跟我说一声):'

/**
 * 早报里「停太久」那一段。只列 `standing.stalled` 的;她自己的待办(负责人是她、没有派活)不列 ——
 * 早报另有「你自己的」那一句(`ownerMorningLines`)。一件都没有就整段不出。
 */
export function stalledMorningLines(tasks: readonly TaskView[]): string[] {
  const stalled = tasks.filter((task) => {
    const s = task.standing
    if (s?.stalled !== true) return false
    return !(task.assignee === 'me' && task.dispatch === undefined && task.client_dispatch === undefined && task.status !== 'confirm')
  })
  if (stalled.length === 0) return []
  stalled.sort((a, b) => (b.standing?.idle_days ?? 0) - (a.standing?.idle_days ?? 0))
  const lines = stalled.slice(0, STALLED_MORNING_MAX).map((task) => {
    const s = task.standing as ItemStandingView
    return `- 「${task.title}」:停了 ${s.idle_days ?? 0} 天;${s.next}`
  })
  if (stalled.length > STALLED_MORNING_MAX) lines.push(`另外 ${stalled.length - STALLED_MORNING_MAX} 件在事项里`)
  return [STALLED_MORNING_HEAD, ...lines]
}
