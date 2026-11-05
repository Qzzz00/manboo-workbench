/**
 * 协作区执行轨迹(`GET /collab/trace?goal_id=`)的纯逻辑:一件事项的节点只从真实记录里取 ——
 * 任务日志事件、回执、留言、状态经手、关系、目标条件的核验留痕、运行片段。
 * 没有记录就没有节点;此刻停在哪读不出来就是 `unknown`,不从卡片状态推一个 running。
 */
import type { GoalCondition, NoteReceipt, RunSegment, TaskRelation, TaskTrace, TaskView, TraceCurrent, TraceNode } from '../protocol.ts'
import type { JobEvent, JobStep } from './jobLog.ts'

/** 两条记录相隔不超过这么久,视为同一件事的两份留痕(回执 vs replied、通过评论 vs 转 done)。 */
const SAME_MOMENT_MS = 60_000
/** 正文截短到这么多字。 */
const TEXT_MAX = 120

const BLOCKED_STEPS: readonly JobStep[] = ['timeout', 'not_sent', 'unreadable']

const ms = (value: string | undefined): number => (value === undefined ? Number.NaN : Date.parse(value))
const near = (a: string, b: string): boolean => Math.abs(ms(a) - ms(b)) <= SAME_MOMENT_MS
const clip = (text: string | undefined): string | undefined => {
  const trimmed = text?.trim()
  if (trimmed === undefined || trimmed === '') return undefined
  return trimmed.length > TEXT_MAX ? `${trimmed.slice(0, TEXT_MAX)}…` : trimmed
}
/** 只放有值的可选字段(exactOptionalPropertyTypes 下不写 undefined)。 */
function node(at: string, kind: TraceNode['kind'], extra: { actor?: string | undefined, to?: string | undefined, text?: string | undefined, evidence?: readonly string[] | undefined, round?: number | undefined } = {}): TraceNode {
  return {
    at,
    kind,
    ...(extra.actor === undefined || extra.actor === '' ? {} : { actor: extra.actor }),
    ...(extra.to === undefined || extra.to === '' ? {} : { to: extra.to }),
    ...(extra.text === undefined ? {} : { text: extra.text }),
    ...(extra.evidence === undefined || extra.evidence.length === 0 ? {} : { evidence: [...extra.evidence] }),
    ...(extra.round === undefined ? {} : { round: extra.round }),
  }
}
const whoOf = (event: Pick<JobEvent, 'family' | 'agent'>): string | undefined =>
  (event.family !== undefined && event.family !== '' ? event.family : event.agent !== undefined && event.agent !== '' ? event.agent : undefined)
/** 片段的执行者:agent 优先,其次 source;'unknown' 不算知道。 */
const segmentWho = (segment: RunSegment): string | undefined => {
  const who = segment.agent ?? segment.source
  return who === undefined || who === '' || who === 'unknown' ? undefined : who
}

function receiptsOf(task: TaskView): readonly NoteReceipt[] {
  if (task.receipts !== undefined && task.receipts.length > 0) return task.receipts
  return task.receipt === undefined ? [] : [task.receipt]
}

/**
 * 一件事项的轨迹。`titles` 用来把依赖关系念成「依赖「某事」」;缺了就用对方 id。
 * `runs` 应是同一批 `events` 算出的运行片段(collabRoutes.runSegmentsOf)。
 */
export function taskTraceOf(
  task: TaskView,
  events: readonly JobEvent[],
  relations: readonly TaskRelation[],
  conditions: readonly GoalCondition[],
  runs: readonly RunSegment[],
  nowMs: number,
  titles: ReadonlyMap<string, string> = new Map(),
): TaskTrace {
  const nodes: TraceNode[] = []
  const receipts = receiptsOf(task)
  const comments = task.comments ?? []

  // —— 前后两段执行源不同 = 换了人接(放在同一时刻的派出之前)。 ——
  const orderedRuns = [...runs].sort((a, b) => ms(a.started_at) - ms(b.started_at))
  for (let i = 1; i < orderedRuns.length; i += 1) {
    const before = segmentWho(orderedRuns[i - 1] as RunSegment)
    const after = segmentWho(orderedRuns[i] as RunSegment)
    if (before === undefined || after === undefined || before === after) continue
    const segment = orderedRuns[i] as RunSegment
    nodes.push(node(segment.started_at, 'handoff', { actor: before, to: after, round: segment.task_round }))
  }

  // —— 任务日志:每段只留第一条送达 / 开工,免得心跳刷屏。 ——
  const sorted = [...events].sort((a, b) => ms(a.at) - ms(b.at))
  const seenSent = new Set<string>()
  const seenStart = new Set<string>()
  let segmentIndex = 0
  const returnReceipts = receipts.filter(one => one.kind === 'done' || one.kind === 'objection')
  for (const event of sorted) {
    const segmentKey = event.session_id !== undefined && event.source_round !== undefined
      ? `src:${event.agent ?? 'unknown'}:${event.session_id}:${event.source_round}`
      : (event.step === 'assigned' ? `seg:${++segmentIndex}` : `seg:${segmentIndex}`)
    const who = whoOf(event)
    if (event.step === 'assigned') {
      nodes.push(node(event.at, 'dispatch', { to: who, round: event.task_round }))
    } else if (event.step === 'sent' || event.step === 'seen') {
      if (seenSent.has(segmentKey)) continue
      seenSent.add(segmentKey)
      nodes.push(node(event.at, 'sent', { to: who, round: event.task_round }))
    } else if (event.step === 'started') {
      if (seenStart.has(segmentKey)) continue
      seenStart.add(segmentKey)
      nodes.push(node(event.at, 'start', { actor: who, round: event.task_round }))
    } else if (event.step === 'replied') {
      // 同一时刻有回执就让回执出这一个「交回」(回执带原话与证据)。
      if (returnReceipts.some(one => near(one.at, event.at))) continue
      nodes.push(node(event.at, 'return', { actor: who, round: event.task_round }))
    } else if (BLOCKED_STEPS.includes(event.step)) {
      nodes.push(node(event.at, 'blocked', { actor: who, text: clip(event.why), round: event.task_round }))
    }
  }

  // —— 回执:交回 / 卡住;带证据的另出一个产物节点。 ——
  const receiptEvidence = new Set<string>()
  for (const receipt of receipts) {
    if (receipt.kind === 'blocked') {
      nodes.push(node(receipt.at, 'blocked', { actor: receipt.by, text: clip(receipt.text), round: receipt.task_round }))
      continue
    }
    nodes.push(node(receipt.at, 'return', { actor: receipt.by, text: clip(receipt.text), round: receipt.task_round }))
    const evidence = (receipt.evidence ?? []).filter(one => one.trim() !== '')
    for (const one of evidence) receiptEvidence.add(one)
    if (evidence.length > 0) nodes.push(node(receipt.at, 'artifact', { actor: receipt.by, evidence, round: receipt.task_round }))
  }
  const looseDeliverables = (task.deliverables ?? []).map(one => one.ref).filter(ref => ref.trim() !== '' && !receiptEvidence.has(ref))
  if (looseDeliverables.length > 0) {
    const latestReceipt = [...receipts].sort((a, b) => ms(a.at) - ms(b.at)).at(-1)
    nodes.push(node(latestReceipt?.at ?? task.updated_at, 'artifact', { evidence: looseDeliverables }))
  }

  // —— 留言里的三颗键。 ——
  for (const comment of comments) {
    if (comment.verdict === 'rework') nodes.push(node(comment.at, 'rework', { actor: comment.by, text: clip(comment.text) }))
    else if (comment.verdict === 'pass') nodes.push(node(comment.at, 'accept', { actor: comment.by }))
    else if (comment.verdict === 'self') nodes.push(node(comment.at, 'handoff', { actor: comment.by, to: 'me', text: '本人接手' }))
  }
  const passes = comments.filter(one => one.verdict === 'pass')
  const reworkComments = comments.filter(one => one.verdict === 'rework')

  // —— 关系:交接(本卡交出)、退回(本卡是原制作卡)、依赖(本卡依赖别人)。 ——
  const rejectedBack = relations.filter(one => one.kind === 'rejected_back' && one.to_id === task.id)
  for (const relation of relations) {
    if (relation.kind === 'handoff' && relation.from_id === task.id) {
      nodes.push(node(relation.created_at, 'handoff', { text: clip(relation.note), round: relation.round }))
    } else if (relation.kind === 'rejected_back' && relation.to_id === task.id) {
      nodes.push(node(relation.created_at, 'rework', { text: clip(relation.note), round: relation.round }))
    } else if (relation.kind === 'depends_on' && relation.from_id === task.id) {
      nodes.push(node(relation.created_at, 'arrange', { text: `依赖「${titles.get(relation.to_id) ?? relation.to_id}」` }))
    }
  }

  // —— 目标条件:本卡承接的条件被核验不通过 = 退回改(同一刻同一人已有改一改评论就不重复)。 ——
  for (const condition of conditions) {
    if (condition.task_id !== task.id) continue
    for (const verification of condition.verifications) {
      if (verification.pass) continue
      if (reworkComments.some(one => one.by === verification.by && near(one.at, verification.at))) continue
      nodes.push(node(verification.at, 'rework', { actor: verification.by, text: clip(verification.note), round: verification.round }))
    }
  }

  // —— 状态经手:没有对应评论 / 退回留痕时才各出一个(经手记录不带是谁)。 ——
  for (const transition of task.transitions ?? []) {
    if (transition.to === 'done' && !passes.some(one => near(one.at, transition.at))) {
      nodes.push(node(transition.at, 'accept'))
    } else if (transition.from === 'confirm' && transition.to === 'doing'
      && !reworkComments.some(one => near(one.at, transition.at))
      && !rejectedBack.some(one => near(one.created_at, transition.at))) {
      nodes.push(node(transition.at, 'rework'))
    }
  }

  const ordered = nodes
    .filter(one => Number.isFinite(ms(one.at)))
    .map((one, index) => ({ one, index }))
    .sort((a, b) => ms(a.one.at) - ms(b.one.at) || a.index - b.index)
    .map(({ one }) => one)

  return { task_id: task.id, nodes: ordered, current: currentOf(task, orderedRuns, ordered, nowMs) }
}

/** 此刻停在哪:卡上的终态先认,其余只看最近一段运行片段;读不出就是 unknown。 */
function currentOf(task: TaskView, runs: readonly RunSegment[], nodes: readonly TraceNode[], _nowMs: number): TraceCurrent {
  if (task.status === 'done') return { state: 'done', ...(task.done_at === undefined ? {} : { since: task.done_at }) }
  if (task.status === 'blocked') return { state: 'blocked' }
  const last = runs.at(-1)
  const since = (value: string | undefined): { since?: string } => (value === undefined ? {} : { since: value })
  const actorOf = (segment: RunSegment): { actor?: string } => {
    const who = segmentWho(segment)
    return who === undefined ? {} : { actor: who }
  }
  if (task.status === 'confirm') {
    const lastReturn = nodes.filter(one => one.kind === 'return').at(-1)
    return { state: 'awaiting_review', ...(lastReturn?.actor === undefined ? {} : { actor: lastReturn.actor }), ...since(lastReturn?.at) }
  }
  if (last === undefined) {
    return task.status === 'backlog' || task.status === 'todo' ? { state: 'not_started' } : { state: 'unknown' }
  }
  if (last.outcome === 'replied') {
    // 交回之后又被退回改了(且还没重派):不再是待验收,也读不出谁在做。
    const reworkedAfter = nodes.some(one => one.kind === 'rework' && ms(one.at) > ms(last.finished_at))
    if (reworkedAfter) return { state: 'unknown' }
    return { state: 'awaiting_review', ...actorOf(last), ...since(last.finished_at) }
  }
  if (last.status === 'running') return { state: 'running', ...actorOf(last), ...since(last.started_at) }
  if (last.status === 'dispatched') return { state: 'dispatched', ...actorOf(last), ...since(last.started_at) }
  if (last.status === 'paused') return { state: 'paused', ...actorOf(last) }
  return { state: 'unknown' }
}
