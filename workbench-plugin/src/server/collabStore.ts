/**
 * 协作区落在任务账里的那几格(2026-10-21,`docs/设计-协作区-无限画布-2026-10-21.md`)。
 *
 * 便签内容**以任务账为真**(`tasks.json`):目标、名片、留言、四样都在这里;板上的位置不在这里
 * (那是 `<工作目录>/协作区/板.canvas`,见 `collabCanvas.ts`)。
 *
 * 这个文件只有两类东西:**逐格体检**(同 tasks.ts 的老取舍 —— 认不出只挑掉这一格,卡本身留着)
 * 与**老冲刺 → 目标的迁移**(一次性、可回退、老字段一个不删)。
 */
import type {
  CollabMcpEntry, CollabSquad, CollabTimer, CollabTimerRun, CollabTimerTrigger,
  LanChannelMessage, LanChannelCategory, LanChannelSourcePolicy, LanChannelSource, LanChannelRef, AgentCard, CollabGoal, CollabSprint, GoalCondition, GoalConditionVerification, LanIdentity, LanMember, MessageDelivery,
  NoteComment, NoteEvaluation, NoteFrom, NoteMessage, NoteReceipt, OwnerAsk, ProjectRepo, ProjectResource, TaskRelation, TaskTransition,
} from '../protocol.ts'
import {
  ACCEPTANCE_ITEM_MAX, ACCEPTANCE_MAX, GOAL_STATUSES, NOTE_COMMENTS_MAX, NOTE_MESSAGES_MAX,
  NOTE_TRANSITIONS_MAX, TASK_STATUSES,
  isAgentCardAssignee, isMemberAssignee, isNoteFromKind, isOwnerAskKind, isReceiptKind, isTaskRelationKind, isWorkType,
} from '../protocol.ts'
import { parseCron } from './collabCron.ts'
import type { TasksFile } from './tasks.ts'

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/** 一句话最多多长(标签、属性值、留言以外的短格)。 */
const SHORT_MAX = 120
/** 一条留言最多多长。 */
const COMMENT_MAX = 2000

function clip(text: string, max: number): string {
  const chars = [...text]
  return chars.length <= max ? text : chars.slice(0, max).join('')
}

export function sanitizeFrom(value: unknown): NoteFrom | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as Record<string, unknown>
  if (!isNoteFromKind(raw.kind)) return undefined
  const ref = str(raw.ref)
  const quote = str(raw.quote)
  return { kind: raw.kind, ...(ref === undefined ? {} : { ref: clip(ref, SHORT_MAX) }), ...(quote === undefined ? {} : { quote: clip(quote, 400) }) }
}

/** 验收:去空白、去空条、每条截到 80 字、最多三条。 */
export function sanitizeAcceptance(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .flatMap(one => (str(one) === undefined ? [] : [clip(str(one) as string, ACCEPTANCE_ITEM_MAX)]))
    .slice(0, ACCEPTANCE_MAX)
}

/** 字符串数组(标签、子便签、关注者):去空、去重、截长、最多 30 个。 */
export function sanitizeStrings(value: unknown, max = 30): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const one of value) {
    const text = str(one)
    if (text === undefined) continue
    const clipped = clip(text, SHORT_MAX)
    if (!out.includes(clipped)) out.push(clipped)
    if (out.length >= max) break
  }
  return out
}

/** 自定义属性:键值都要是非空字符串,最多 30 对。 */
export function sanitizeProps(value: unknown): Record<string, string> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const out: Record<string, string> = {}
  let n = 0
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const k = str(key)
    const v = str(raw)
    if (k === undefined || v === undefined) continue
    out[clip(k, 40)] = clip(v, SHORT_MAX)
    n += 1
    if (n >= 30) break
  }
  return n === 0 ? undefined : out
}

export function sanitizeReceipt(value: unknown): NoteReceipt | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as Record<string, unknown>
  if (!isReceiptKind(raw.kind)) return undefined
  const text = str(raw.text)
  const at = str(raw.at)
  if (text === undefined || at === undefined) return undefined
  const evidence = sanitizeStrings(raw.evidence, 20)
  const by = str(raw.by)
  const messageId = str(raw.message_id)
  const sourceSessionId = str(raw.source_session_id)
  const sourceRound = str(raw.source_round)
  return {
    kind: raw.kind,
    text: clip(text, COMMENT_MAX),
    ...(evidence.length === 0 ? {} : { evidence }),
    ...(by === undefined ? {} : { by }),
    ...(messageId === undefined ? {} : { message_id: messageId }),
    ...(sourceSessionId === undefined ? {} : { source_session_id: sourceSessionId }),
    ...(sourceRound === undefined ? {} : { source_round: sourceRound }),
    ...(typeof raw.task_round === 'number' && Number.isInteger(raw.task_round) && raw.task_round >= 1 ? { task_round: raw.task_round } : {}),
    at,
  }
}

/** 要本人拍板的结构化请求(2026-10-26,卡「事务官页接管队列」)。类别必须是四类之一,方案与依据必填。 */
export function sanitizeOwnerAsk(value: unknown): OwnerAsk | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as Record<string, unknown>
  if (!isOwnerAskKind(raw.kind)) return undefined
  const proposal = str(raw.proposal)
  const basis = str(raw.basis)
  const at = str(raw.at)
  if (proposal === undefined || basis === undefined || at === undefined) return undefined
  const by = str(raw.by)
  return {
    kind: raw.kind,
    proposal: clip(proposal, COMMENT_MAX),
    basis: clip(basis, COMMENT_MAX),
    ...(by === undefined ? {} : { by }),
    at,
  }
}

/** 一条能力条件(2026-10-24 契约 §1)。坏条挑掉;老目标没有 conditions 整格缺席。 */
export function sanitizeGoalCondition(value: unknown): GoalCondition | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as Record<string, unknown>
  const id = str(raw.id)
  const text = str(raw.text)
  const createdAt = str(raw.created_at)
  const updatedAt = str(raw.updated_at)
  if (id === undefined || text === undefined || createdAt === undefined || updatedAt === undefined) return undefined
  const verifications: GoalConditionVerification[] = (Array.isArray(raw.verifications) ? raw.verifications : []).flatMap((one) => {
    if (typeof one !== 'object' || one === null) return []
    const entry = one as Record<string, unknown>
    const by = str(entry.by)
    const at = str(entry.at)
    const round = typeof entry.round === 'number' && Number.isFinite(entry.round) && entry.round >= 1 ? Math.floor(entry.round) : undefined
    if (by === undefined || at === undefined || round === undefined) return []
    const note = str(entry.note)
    return [{ by, at, pass: entry.pass === true, round, ...(note === undefined ? {} : { note: clip(note, COMMENT_MAX) }) }]
  })
  const evidence = sanitizeStrings(raw.evidence, 20)
  const deliveredAt = isoTime(raw.delivered_at)
  return {
    id,
    text: clip(text, SHORT_MAX),
    ...(str(raw.task_id) === undefined ? {} : { task_id: str(raw.task_id) as string }),
    ...(evidence.length === 0 ? {} : { evidence }),
    verifications,
    ...(deliveredAt === undefined ? {} : { delivered_at: deliveredAt }),
    created_at: createdAt,
    updated_at: updatedAt,
  }
}

/** 一条留言 / 邀请(2026-10-24 契约 §2)。intent 认不出当 record;deliveries 坏条挑掉。 */
export function sanitizeLanMessage(value: unknown): LanChannelMessage | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as Record<string, unknown>
  const author = raw.author as Record<string, unknown> | undefined
  if (str(raw.id) === undefined || str(raw.project_id) === undefined || str(raw.text) === undefined || isoTime(raw.at) === undefined || str(author?.member_id) === undefined || str(author?.name) === undefined) return undefined
  const message = sanitizeNoteMessage({ ...raw, by: author!.member_id, intent: 'record' })
  if (message === undefined) return undefined
  const formal = ['category', 'source', 'topic', 'refs'].some(key => raw[key] !== undefined)
  const metadata = formal ? sanitizeLanSourceFields(raw) : undefined
  if (formal && (metadata === undefined || raw.kind !== 'message' || str(raw.text)!.length > 64_000)) return undefined
  return { id: message.id, project_id: str(raw.project_id)!, author: { member_id: str(author!.member_id)!, name: str(author!.name)! }, text: formal ? str(raw.text)! : message.text, at: message.at, kind: raw.kind === 'report' ? 'report' : 'message', ...(message.client_msg_id === undefined ? {} : { client_msg_id: message.client_msg_id }), ...(message.reply_to === undefined ? {} : { reply_to: message.reply_to }), ...(message.deliveries === undefined ? {} : { deliveries: message.deliveries }), ...metadata }
}

export const LAN_CHANNEL_CATEGORIES: readonly LanChannelCategory[] = ['news', 'daily', 'weekly']
const bounded = (value: unknown, max: number): string | undefined => { const s = str(value); return s !== undefined && s.length <= max ? s : undefined }
// Reserved credential parameter names, not guesses based on the article text or value.
const sourceCredentialKeys = new Set([
  'token', 'accesstoken', 'refreshtoken', 'idtoken', 'apitoken', 'authtoken', 'bearer',
  'key', 'apikey', 'accesskey', 'accesskeyid', 'privatekey', 'secret', 'clientsecret',
  'auth', 'authorization', 'password', 'passwd', 'pwd', 'signature', 'sig',
  'credential', 'credentials', 'session', 'sessionid', 'sessiontoken', 'sessionkey',
  'jwt', 'code', 'authcode', 'securitytoken', 'cookie', 'setcookie', 'xapikey',
  'xamzcredential', 'xamzsignature', 'xamzsecuritytoken', 'xgoogcredential', 'xgoogsignature',
  'awsaccesskeyid', 'ossaccesskeyid',
])
function sourceUrlPartSafe(part: string): boolean {
  // Decode only for inspection; accepted references retain their exact original URL.
  // Bound nested escaping and reject malformed/excessively encoded metadata.
  for (let depth = 0; depth <= 4; depth++) {
    if (/^[\s+]*(?:bearer|basic)[\s+]+\S+/i.test(part)) return false
    for (const parameter of part.split(/[?&;]/)) {
      const equals = parameter.indexOf('=')
      if (equals < 0) continue
      const key = parameter.slice(0, equals)
      const names = [key, ...key.split(/[\[\]]/)]
      if (names.some(name => sourceCredentialKeys.has(name.toLowerCase().replace(/[-_.\s+]/g, '')))) return false
    }
    // A decoded literal percent (e.g. a 100% search) is not another escape.
    if (depth > 0 && !/%[0-9a-f]{2}/i.test(part)) return true
    if (!part.includes('%') && !part.includes('+')) return true
    if (depth === 4) return false
    try { part = decodeURIComponent(part.replace(/\+/g, ' ')) } catch { return false }
  }
  return false
}
function sourceUrl(value: unknown): string | undefined {
  const s = bounded(value, 2048)
  if (s === undefined) return undefined
  try {
    const u = new URL(s)
    return ['http:', 'https:'].includes(u.protocol) && u.username === '' && u.password === ''
      && sourceUrlPartSafe(u.search.slice(1)) && sourceUrlPartSafe(u.hash.slice(1)) ? s : undefined
  } catch { return undefined }
}
function sourceDate(value: unknown): string | undefined {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().startsWith(value) ? value : undefined
}
function sanitizeLanSourceFields(raw: Record<string, unknown>): Pick<LanChannelMessage, 'category' | 'source' | 'topic' | 'refs'> | undefined {
  if (!LAN_CHANNEL_CATEGORIES.includes(raw.category as LanChannelCategory) || typeof raw.source !== 'object' || raw.source === null || typeof raw.topic !== 'object' || raw.topic === null || !Array.isArray(raw.refs) || raw.refs.length > 100) return undefined
  const s = raw.source as Record<string, unknown>, t = raw.topic as Record<string, unknown>
  const id = bounded(s.id, 400), at = isoTime(s.recorded_at), topicId = bounded(t.id, 400), title = bounded(t.title, 200)
  if (id === undefined || at === undefined || topicId === undefined || title === undefined) return undefined
  const source: LanChannelSource = { kind: s.kind === 'feed' ? 'feed' : 'project-report', id, recorded_at: at, scope: s.kind === 'feed' ? 'project-feed' : 'local-project-records' }
  if (raw.category === 'news') {
    const url = sourceUrl(s.url)
    if (s.kind !== 'feed' || s.scope !== 'project-feed' || url === undefined) return undefined
    source.url = url
    if (s.publisher !== undefined) { const publisher = bounded(s.publisher, 200); if (publisher === undefined) return undefined; source.publisher = publisher }
    if (s.published_at !== undefined) { const published = isoTime(s.published_at); if (published === undefined) return undefined; source.published_at = published }
  } else {
    const period = s.period as Record<string, unknown> | undefined
    const from = sourceDate(period?.from), to = sourceDate(period?.to)
    if (s.kind !== 'project-report' || s.scope !== 'local-project-records' || from === undefined || to === undefined || from > to) return undefined
    const days = (Date.parse(to) - Date.parse(from)) / 86_400_000
    if (days !== (raw.category === 'daily' ? 0 : 6)) return undefined
    source.period = { from, to }
  }
  const refs: LanChannelRef[] = []
  for (const value of raw.refs) {
    if (typeof value !== 'object' || value === null) return undefined
    const r = value as Record<string, unknown>, refId = bounded(r.id, 400), refTitle = bounded(r.title, 200)
    if (!['task', 'url'].includes(r.kind as string) || refId === undefined || refTitle === undefined) return undefined
    const url = r.kind === 'url' ? sourceUrl(r.url) : undefined
    if (r.kind === 'url' && url === undefined) return undefined
    refs.push({ kind: r.kind as LanChannelRef['kind'], id: refId, title: refTitle, ...(url === undefined ? {} : { url }) })
  }
  return { category: raw.category as LanChannelCategory, source, topic: { id: topicId, title }, refs }
}
export function sanitizeLanSourcePolicy(value: unknown): LanChannelSourcePolicy | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as Record<string, unknown>, project = bounded(raw.project_id, 200), at = isoTime(raw.updated_at)
  if (project === undefined || at === undefined || typeof raw.enabled !== 'boolean' || !Number.isInteger(raw.version) || (raw.version as number) < 1 || !Array.isArray(raw.recipients) || raw.recipients.length > 32 || !Array.isArray(raw.categories) || raw.categories.length > 3) return undefined
  if (raw.recipients.some(v => bounded(v, 200) === undefined) || raw.categories.some(v => !LAN_CHANNEL_CATEGORIES.includes(v as LanChannelCategory))) return undefined
  const recipients = [...new Set(raw.recipients.map(v => str(v)!))], categories = [...new Set(raw.categories)] as LanChannelCategory[]
  if (raw.enabled && (recipients.length === 0 || categories.length === 0)) return undefined
  return { project_id: project, enabled: raw.enabled, recipients, categories, version: raw.version as number, updated_at: at }
}

export function sanitizeNoteMessage(value: unknown): NoteMessage | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as Record<string, unknown>
  const id = str(raw.id)
  const by = str(raw.by)
  const text = str(raw.text)
  const at = str(raw.at)
  if (id === undefined || by === undefined || text === undefined || at === undefined) return undefined
  const deliveries: MessageDelivery[] = (Array.isArray(raw.deliveries) ? raw.deliveries : []).flatMap((one) => {
    if (typeof one !== 'object' || one === null) return []
    const entry = one as Record<string, unknown>
    const to = str(entry.to)
    const atOne = str(entry.at)
    const status = entry.status === 'pending' || entry.status === 'delivered' || entry.status === 'accepted' || entry.status === 'failed' ? entry.status : undefined
    if (to === undefined || atOne === undefined || status === undefined) return []
    const error = str(entry.error)
    const receipt = sanitizeReceipt(entry.receipt)
    return [{ to, status, at: atOne, ...(str(entry.task_id) === undefined ? {} : { task_id: str(entry.task_id) as string }), ...(receipt === undefined ? {} : { receipt }), ...(error === undefined ? {} : { error: clip(error, 400) }) }]
  })
  const mentions = sanitizeStrings(raw.mentions, 30)
  return {
    id,
    ...(str(raw.client_msg_id) === undefined ? {} : { client_msg_id: str(raw.client_msg_id) as string }),
    by,
    text: clip(text, COMMENT_MAX),
    at,
    intent: raw.intent === 'ask' ? 'ask' : 'record',
    ...(mentions.length === 0 ? {} : { mentions }),
    ...(str(raw.reply_to) === undefined ? {} : { reply_to: str(raw.reply_to) as string }),
    ...(deliveries.length === 0 ? {} : { deliveries }),
  }
}

/** 任务关系(2026-10-24 契约 §3)。kind 认不出整条挑掉。 */
export function sanitizeTaskRelation(value: unknown): TaskRelation | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as Record<string, unknown>
  const id = str(raw.id)
  const fromId = str(raw.from_id)
  const toId = str(raw.to_id)
  const createdAt = str(raw.created_at)
  if (id === undefined || fromId === undefined || toId === undefined || !isTaskRelationKind(raw.kind) || createdAt === undefined) return undefined
  const round = typeof raw.round === 'number' && Number.isFinite(raw.round) && raw.round >= 1 ? Math.floor(raw.round) : undefined
  const note = str(raw.note)
  return {
    id,
    from_id: fromId,
    to_id: toId,
    kind: raw.kind,
    ...(note === undefined ? {} : { note: clip(note, COMMENT_MAX) }),
    ...(round === undefined ? {} : { round }),
    created_at: createdAt,
  }
}

function isTaskStatusValue(value: unknown): value is TaskTransition['from'] {
  return typeof value === 'string' && (TASK_STATUSES as readonly string[]).includes(value)
}

/** 状态经手记录:from/to 都要是认得的七态、at 是带时刻的 ISO;cap {@link NOTE_TRANSITIONS_MAX},只留最后一段。 */
function sanitizeTransitions(value: unknown): TaskTransition[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((one): TaskTransition[] => {
    if (typeof one !== 'object' || one === null) return []
    const raw = one as Record<string, unknown>
    const at = isoTime(raw.at)
    if (at === undefined || !isTaskStatusValue(raw.from) || !isTaskStatusValue(raw.to)) return []
    return [{ from: raw.from, to: raw.to, at }]
  }).slice(-NOTE_TRANSITIONS_MAX)
}

export function sanitizeEvaluation(value: unknown): NoteEvaluation | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as Record<string, unknown>
  const by = str(raw.by)
  const text = str(raw.text)
  const at = str(raw.at)
  return by === undefined || text === undefined || at === undefined ? undefined : { by, text: clip(text, COMMENT_MAX), at }
}

export function sanitizeComments(value: unknown): NoteComment[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((one): NoteComment[] => {
    if (typeof one !== 'object' || one === null) return []
    const raw = one as Record<string, unknown>
    const id = str(raw.id)
    const by = str(raw.by)
    const text = str(raw.text)
    const at = str(raw.at)
    if (id === undefined || by === undefined || text === undefined || at === undefined) return []
    const verdict = raw.verdict === 'pass' || raw.verdict === 'rework' || raw.verdict === 'self' ? raw.verdict : undefined
    const resolvedBy = str(raw.resolved_by)
    const resolvedAt = str(raw.resolved_at)
    // 意图只认四值(2026-10-26,卡「事务官机制A」);认不出的挑掉,不留半截。
    const intent = raw.intent === 'supplement' || raw.intent === 'redirect' || raw.intent === 'hurry' || raw.intent === 'recall' ? raw.intent : undefined
    return [{
      id, by, text: clip(text, COMMENT_MAX), at,
      ...(verdict === undefined ? {} : { verdict }),
      ...(intent === undefined ? {} : { intent }),
      // 已解决那一对要么都有、要么都没有(半截的「谁解决的」比没有更误导)。
      ...(resolvedBy === undefined || resolvedAt === undefined ? {} : { resolved_by: resolvedBy, resolved_at: resolvedAt }),
    }]
  }).slice(-NOTE_COMMENTS_MAX)
}

/** 便签那几格,一次挑完(tasks.ts 的 sanitizeTask 展开它)。认不出的格整格缺席。 */
export function sanitizeNoteFields(raw: Record<string, unknown>): Record<string, unknown> {
  const from = sanitizeFrom(raw.from)
  const acceptance = sanitizeAcceptance(raw.acceptance)
  const receipt = sanitizeReceipt(raw.receipt)
  const receipts = (Array.isArray(raw.receipts) ? raw.receipts : []).map(sanitizeReceipt).filter((one): one is NoteReceipt => one !== undefined)
  const ownerAsk = sanitizeOwnerAsk(raw.owner_ask)
  const labels = sanitizeStrings(raw.labels)
  const children = sanitizeStrings(raw.children)
  const watchers = sanitizeStrings(raw.watchers)
  const props = sanitizeProps(raw.props)
  const evaluation = sanitizeEvaluation(raw.evaluation)
  const comments = sanitizeComments(raw.comments)
  const start = isoTime(raw.start)
  // 结束早于开始 = 写错了,丢结束(开始还在,画成时间点卡),不替她猜一个时长。
  const end = start === undefined ? undefined : isoTime(raw.end)
  const endOk = end !== undefined && Date.parse(end) >= Date.parse(start as string)
  const collaborators = sanitizeStrings(raw.collaborators)
  const pulls = sanitizeStrings(raw.pull_requests, 30).filter(one => PR_REF.test(one))
  const round = typeof raw.round === 'number' && Number.isFinite(raw.round) && raw.round >= 1 ? Math.floor(raw.round) : undefined
  const transitions = sanitizeTransitions(raw.transitions)
  const messages = (Array.isArray(raw.messages) ? raw.messages : []).map(sanitizeNoteMessage).filter((one): one is NoteMessage => one !== undefined).slice(-NOTE_MESSAGES_MAX)
  return {
    ...(round === undefined ? {} : { round }),
    ...(transitions.length === 0 ? {} : { transitions }),
    ...(messages.length === 0 ? {} : { messages }),
    ...(start === undefined ? {} : { start }),
    ...(endOk ? { end } : {}),
    ...(isWorkType(raw.work_type) ? { work_type: raw.work_type } : {}),
    ...(collaborators.length === 0 ? {} : { collaborators }),
    ...(str(raw.squad_id) === undefined ? {} : { squad_id: str(raw.squad_id) as string }),
    ...(pulls.length === 0 ? {} : { pull_requests: pulls }),
    ...(str(raw.goal_id) === undefined ? {} : { goal_id: str(raw.goal_id) as string }),
    ...(from === undefined ? {} : { from }),
    ...(acceptance.length === 0 ? {} : { acceptance }),
    ...(receipt === undefined ? {} : { receipt }),
    ...(receipts.length === 0 ? {} : { receipts }),
    ...(ownerAsk === undefined ? {} : { owner_ask: ownerAsk }),
    ...(raw.receipt_irregular === true ? { receipt_irregular: true } : {}),
    ...(labels.length === 0 ? {} : { labels }),
    ...(children.length === 0 ? {} : { children }),
    ...(watchers.length === 0 ? {} : { watchers }),
    ...(props === undefined ? {} : { props }),
    ...(evaluation === undefined ? {} : { evaluation }),
    ...(str(raw.module) === undefined ? {} : { module: clip(str(raw.module) as string, 40) }),
    ...(str(raw.version) === undefined ? {} : { version: clip(str(raw.version) as string, 40) }),
    ...(comments.length === 0 ? {} : { comments }),
  }
}

/** PR 写成 `<owner>/<repo>#<号>`。 */
const PR_REF = /^[\w.-]+\/[\w.-]+#\d+$/

/** 带日期与时刻的 ISO 串(只有日期的不算:时间线要按时刻摆)。 */
export function isoTime(value: unknown): string | undefined {
  const text = str(value)
  if (text === undefined || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(text) || !Number.isFinite(Date.parse(text))) return undefined
  return text
}

export function sanitizeSquad(value: unknown): CollabSquad | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as Record<string, unknown>
  const id = str(raw.id)
  const name = str(raw.name)
  const leader = str(raw.leader)
  if (id === undefined || name === undefined || leader === undefined) return undefined
  return {
    id, name: clip(name, 40), leader,
    members: sanitizeStrings(raw.members, 30).filter(one => one !== leader),
    created_at: typeof raw.created_at === 'string' ? raw.created_at : '',
    updated_at: typeof raw.updated_at === 'string' ? raw.updated_at : '',
  }
}

export function sanitizeTimerTrigger(value: unknown): CollabTimerTrigger | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as Record<string, unknown>
  if (raw.kind === 'cron') {
    const cron = str(raw.cron)
    return cron !== undefined && parseCron(cron) !== undefined ? { kind: 'cron', cron } : undefined
  }
  if (raw.kind === 'webhook') return { kind: 'webhook', ...(str(raw.url) === undefined ? {} : { url: str(raw.url) as string }) }
  return undefined
}

function sanitizeRun(value: unknown): CollabTimerRun | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as Record<string, unknown>
  const at = str(raw.at)
  if (at === undefined || typeof raw.ok !== 'boolean') return undefined
  return {
    at, ok: raw.ok,
    ...(str(raw.note_id) === undefined ? {} : { note_id: str(raw.note_id) as string }),
    ...(str(raw.why) === undefined ? {} : { why: clip(str(raw.why) as string, 400) }),
  }
}

/** 一条定时派活最多留几次运行记录。 */
export const TIMER_RUNS_MAX = 20

export function sanitizeTimer(value: unknown): CollabTimer | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as Record<string, unknown>
  const id = str(raw.id)
  const name = str(raw.name)
  const assignee = str(raw.assignee)
  const trigger = sanitizeTimerTrigger(raw.trigger)
  const tpl = typeof raw.template === 'object' && raw.template !== null ? raw.template as Record<string, unknown> : {}
  const title = str(tpl.title)
  const acceptance = sanitizeAcceptance(tpl.acceptance)
  if (id === undefined || name === undefined || assignee === undefined || trigger === undefined || title === undefined || acceptance.length === 0) return undefined
  return {
    id, name: clip(name, 40), trigger, assignee,
    template: { title: clip(title, SHORT_MAX), ...(str(tpl.goal_id) === undefined ? {} : { goal_id: str(tpl.goal_id) as string }), acceptance },
    enabled: raw.enabled !== false,
    runs: (Array.isArray(raw.runs) ? raw.runs : []).map(sanitizeRun).filter((one): one is CollabTimerRun => one !== undefined).slice(-TIMER_RUNS_MAX),
    created_at: typeof raw.created_at === 'string' ? raw.created_at : '',
    updated_at: typeof raw.updated_at === 'string' ? raw.updated_at : '',
  }
}

/** 密钥名:字母、数字、下划线(它会被当成环境变量名用)。 */
export const SECRET_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/

export function sanitizeMcp(value: unknown): CollabMcpEntry | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as Record<string, unknown>
  const id = str(raw.id)
  const name = str(raw.name)
  const url = str(raw.url_template)
  const names = Array.isArray(raw.secret_names) ? raw.secret_names.filter((one): one is string => typeof one === 'string') : []
  if (id === undefined || name === undefined || url === undefined || names.some(one => !SECRET_NAME.test(one))) return undefined
  return {
    id, name: clip(name, 40), url_template: clip(url, 400), secret_names: [...new Set(names)].slice(0, 20),
    created_at: typeof raw.created_at === 'string' ? raw.created_at : '',
    updated_at: typeof raw.updated_at === 'string' ? raw.updated_at : '',
  }
}

export function sanitizeGoal(value: unknown): CollabGoal | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as Record<string, unknown>
  const id = str(raw.id)
  const title = str(raw.title)
  if (id === undefined || title === undefined) return undefined
  const status = (GOAL_STATUSES as readonly unknown[]).includes(raw.status) ? raw.status as CollabGoal['status'] : 'open'
  const conditions = (Array.isArray(raw.conditions) ? raw.conditions : []).map(sanitizeGoalCondition).filter((one): one is GoalCondition => one !== undefined)
  return {
    id,
    title: clip(title, SHORT_MAX),
    ...(str(raw.why) === undefined ? {} : { why: clip(str(raw.why) as string, 400) }),
    owner: isMemberAssignee(raw.owner) ? raw.owner : 'me',
    status,
    ...(str(raw.due) === undefined ? {} : { due: str(raw.due) as string }),
    ...(str(raw.project_id) === undefined ? {} : { project_id: str(raw.project_id) as string }),
    ...(str(raw.version) === undefined ? {} : { version: clip(str(raw.version) as string, 80) }),
    ...(str(raw.migrated_from) === undefined ? {} : { migrated_from: str(raw.migrated_from) as string }),
    ...(conditions.length === 0 ? {} : { conditions }),
    created_at: typeof raw.created_at === 'string' ? raw.created_at : '',
    updated_at: typeof raw.updated_at === 'string' ? raw.updated_at : '',
  }
}

export function sanitizeGoalSprint(value: unknown): CollabSprint | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as Record<string, unknown>
  const id = str(raw.id)
  const title = str(raw.title)
  if (id === undefined || title === undefined) return undefined
  return {
    id,
    title: clip(title, SHORT_MAX),
    ...(str(raw.start) === undefined ? {} : { start: str(raw.start) as string }),
    ...(str(raw.end) === undefined ? {} : { end: str(raw.end) as string }),
    goal_ids: sanitizeStrings(raw.goal_ids, 50),
    created_at: typeof raw.created_at === 'string' ? raw.created_at : '',
    updated_at: typeof raw.updated_at === 'string' ? raw.updated_at : '',
  }
}

export function sanitizeAgentCard(value: unknown): AgentCard | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as Record<string, unknown>
  const name = str(raw.name)
  const hand = str(raw.hand)
  if (!isAgentCardAssignee(raw.id) || name === undefined || hand === undefined) return undefined
  const shared = typeof raw.shared === 'object' && raw.shared !== null ? raw.shared as Record<string, unknown> : {}
  const repos = sanitizeStrings(shared.repos, 20)
  const budget = typeof shared.budget_per_day === 'number' && Number.isFinite(shared.budget_per_day) && shared.budget_per_day > 0 ? shared.budget_per_day : undefined
  const skills = sanitizeStrings(raw.skills, 30)
  const mcp = sanitizeStrings(raw.mcp, 30)
  const members = sanitizeStrings(shared.members, 50).filter(one => isMemberAssignee(one))
  // 指定成员却一个都没选,就是只自己(不替他扩大成全工作室)。
  const to: AgentCard['shared']['to'] = shared.to === 'workspace' ? 'workspace' : shared.to === 'members' && members.length > 0 ? 'members' : 'none'
  // 四样(2026-10-22):命令行 / 仓库 / 模型与强度 / 智能体文件。形状不对只挑掉这一格(同全文件的取舍);
  // 强度只认三档,别的值整格挑掉(不写进名片、也不 silently 归缺省)。
  const runtime = sanitizeCardRuntime(raw.runtime)
  const project = sanitizeCardProject(raw.project)
  const model = sanitizeCardModel(raw.model)
  const instructions = str(raw.instructions)
  // 时长上限(2026-10-23 卡「派活给名片的四处」③):只认 1..1440 的整数,形状不对整格挑掉。
  const cardBudget = sanitizeCardBudget(raw.budget)
  return {
    id: raw.id,
    name: clip(name, 40),
    owner: isMemberAssignee(raw.owner) ? raw.owner : 'me',
    hand,
    ...(runtime === undefined ? {} : { runtime }),
    ...(project === undefined ? {} : { project }),
    ...(model === undefined ? {} : { model }),
    ...(instructions === undefined ? {} : { instructions: clip(instructions, 200) }),
    ...(cardBudget === undefined ? {} : { budget: cardBudget }),
    ...(str(raw.good_at) === undefined ? {} : { good_at: clip(str(raw.good_at) as string, 200) }),
    ...(skills.length === 0 ? {} : { skills }),
    ...(mcp.length === 0 ? {} : { mcp }),
    shared: {
      to,
      ...(to === 'members' ? { members } : {}),
      ...(repos.length === 0 ? {} : { repos }),
      ...(budget === undefined ? {} : { budget_per_day: budget }),
    },
    created_at: typeof raw.created_at === 'string' ? raw.created_at : '',
    updated_at: typeof raw.updated_at === 'string' ? raw.updated_at : '',
  }
}

/** 名片四样各自的体检(2026-10-22)。认不出回 undefined = 这一格挑掉。 */
function sanitizeCardRuntime(value: unknown): AgentCard['runtime'] | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as Record<string, unknown>
  const family = str(raw.family)
  if (family === undefined) return undefined
  const bin = str(raw.bin)
  return { family: clip(family, 40), ...(bin === undefined ? {} : { bin: clip(bin, 240) }) }
}

function sanitizeCardProject(value: unknown): AgentCard['project'] | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const repo = str((value as Record<string, unknown>).repo)
  return repo === undefined ? undefined : { repo: clip(repo, 240) }
}

/** 时长上限那一格(2026-10-23 卡「派活给名片的四处」③):1..1440 的整数才算,别的(含缺席)整格挑掉。 */
export function sanitizeCardBudget(value: unknown): AgentCard['budget'] | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = (value as Record<string, unknown>).minutes
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 1 || raw > 24 * 60) return undefined
  return { minutes: Math.round(raw) }
}

const CARD_EFFORTS = ['low', 'medium', 'high'] as const

function sanitizeCardModel(value: unknown): AgentCard['model'] | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as Record<string, unknown>
  const name = str(raw.name)
  const effort = CARD_EFFORTS.includes(raw.effort as never) ? raw.effort as 'low' | 'medium' | 'high' : undefined
  if (name === undefined && effort === undefined) return undefined
  return {
    ...(name === undefined ? {} : { name: clip(name, 80) }),
    ...(effort === undefined ? {} : { effort }),
  }
}

export function sanitizeRepos(value: unknown): ProjectRepo[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((one): ProjectRepo[] => {
    if (typeof one !== 'object' || one === null) return []
    const raw = one as Record<string, unknown>
    const local = str(raw.local_path)
    if (local === undefined) return []
    return [{
      local_path: local,
      ...(str(raw.remote_url) === undefined ? {} : { remote_url: str(raw.remote_url) as string }),
      ...(str(raw.branch) === undefined ? {} : { branch: str(raw.branch) as string }),
    }]
  }).slice(0, 20)
}

export function sanitizeResources(value: unknown): ProjectResource[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((one): ProjectResource[] => {
    if (typeof one !== 'object' || one === null) return []
    const raw = one as Record<string, unknown>
    const kind = raw.kind === 'doc' || raw.kind === 'url' || raw.kind === 'path' ? raw.kind : undefined
    const title = str(raw.title)
    const ref = str(raw.ref)
    return kind === undefined || title === undefined || ref === undefined ? [] : [{ kind, title: clip(title, SHORT_MAX), ref }]
  }).slice(0, 50)
}

/** 本机局域网身份(契约 §5)。member_id 必须是 UUID 的样子;version 只认 ≥1 的整数。 */
export function sanitizeLanIdentity(value: unknown): LanIdentity | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as Record<string, unknown>
  const memberId = str(raw.member_id)
  const name = str(raw.name)
  if (memberId === undefined || name === undefined) return undefined
  const version = typeof raw.version === 'number' && Number.isFinite(raw.version) && raw.version >= 1 ? Math.floor(raw.version) : undefined
  if (version === undefined) return undefined
  return {
    member_id: memberId,
    name: clip(name, 40),
    ...(str(raw.avatar) === undefined ? {} : { avatar: str(raw.avatar) as string }),
    version,
    updated_at: typeof raw.updated_at === 'string' ? raw.updated_at : '',
  }
}

/** 注册表一员(契约 §5)。reachable 只认布尔(认不出 = 没 refresh 过 = 缺席,不说在线)。 */
export function sanitizeLanMember(value: unknown): LanMember | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as Record<string, unknown>
  const memberId = str(raw.member_id)
  const name = str(raw.name)
  const host = str(raw.host)
  const port = typeof raw.port === 'number' && Number.isFinite(raw.port) && raw.port >= 1 && raw.port <= 65535 ? Math.floor(raw.port) : undefined
  if (memberId === undefined || name === undefined || host === undefined || port === undefined) return undefined
  return {
    member_id: memberId,
    name: clip(name, 40),
    host,
    port,
    ...(isoTime(raw.last_seen) === undefined ? {} : { last_seen: isoTime(raw.last_seen) as string }),
    ...(typeof raw.reachable === 'boolean' ? { reachable: raw.reachable } : {}),
  }
}

/** 迁移记了什么(回退照它撤)。 */
export interface CollabMigrationRecord {
  at: string
  goal_ids: string[]
  /** 迁移时给哪几张卡挂了目标(与模块名)。 */
  tasks: Record<string, { goal_id: string, module?: string }>
}

export function sanitizeMigration(value: unknown): CollabMigrationRecord | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as Record<string, unknown>
  const at = str(raw.at)
  if (at === undefined) return undefined
  const tasks: CollabMigrationRecord['tasks'] = {}
  if (typeof raw.tasks === 'object' && raw.tasks !== null) {
    for (const [id, one] of Object.entries(raw.tasks as Record<string, unknown>)) {
      if (typeof one !== 'object' || one === null) continue
      const entry = one as Record<string, unknown>
      const goal = str(entry.goal_id)
      if (goal === undefined) continue
      tasks[id] = { goal_id: goal, ...(str(entry.module) === undefined ? {} : { module: str(entry.module) as string }) }
    }
  }
  return { at, goal_ids: sanitizeStrings(raw.goal_ids, 1000), tasks }
}

/**
 * **老冲刺 → 目标、模块 → 目标区里的分组**(设计稿 3.2;待拍板 7 已定)。纯函数,一次性:
 *
 * - 一个冲刺 = 一个目标:标题取冲刺名、`why` 取冲刺目标、截止取结束日、版本取那组版本号;
 * - 冲刺下模块里的卡挂上那个目标,`module` 写模块名(只是位置分组,不是对象);
 * - **老字段一个不删**(`sprints` / `modules` / `module_id` 再留一个版本只读),迁移记一份账,回退照账撤;
 * - 已经迁过(账在)就原样返回;他已经自己挂过目标的卡不动。
 */
export function migrateSprintsToGoals(data: TasksFile, at: string, newId: () => string): TasksFile {
  if (data.collab_migration !== undefined) return data
  const goals = [...(data.goals ?? [])]
  const record: CollabMigrationRecord = { at, goal_ids: [], tasks: {} }
  const goalOfSprint = new Map<string, string>()
  for (const sprint of data.sprints) {
    const id = newId()
    const version = sprint.versions.map(one => `${one.label} ${one.version}`).join(' / ')
    goals.push({
      id,
      title: sprint.name,
      ...(sprint.goal === undefined ? {} : { why: sprint.goal }),
      owner: 'me',
      status: 'open',
      ...(sprint.ends_at === undefined ? {} : { due: sprint.ends_at }),
      project_id: sprint.project_id,
      ...(version === '' ? {} : { version }),
      migrated_from: sprint.id,
      created_at: at,
      updated_at: at,
    })
    goalOfSprint.set(sprint.id, id)
    record.goal_ids.push(id)
  }
  const moduleById = new Map(data.modules.map(one => [one.id, one]))
  const tasks = data.tasks.map((task) => {
    if (task.goal_id !== undefined || task.module_id === undefined) return task
    const module = moduleById.get(task.module_id)
    const goalId = module === undefined ? undefined : goalOfSprint.get(module.sprint_id)
    if (module === undefined || goalId === undefined) return task
    const tagged = task.module === undefined
    record.tasks[task.id] = { goal_id: goalId, ...(tagged ? { module: module.name } : {}) }
    return { ...task, goal_id: goalId, ...(tagged ? { module: module.name } : {}) }
  })
  return { ...data, goals, tasks, collab_migration: record }
}

/**
 * 回退:撤掉迁移建的目标,把迁移时挂上的目标 / 模块名摘掉 —— **只摘还是迁移那一份的**
 * (迁完之后他自己改挂过的不动)。老冲刺 / 模块本来就没删,回退之后看板那一套原样在。
 */
export function rollbackGoalMigration(data: TasksFile): { data: TasksFile, goals: number, tasks: number } {
  const record = data.collab_migration
  if (record === undefined) return { data, goals: 0, tasks: 0 }
  const drop = new Set(record.goal_ids)
  const goals = (data.goals ?? []).filter(one => !drop.has(one.id))
  let touched = 0
  const tasks = data.tasks.map((task) => {
    const was = record.tasks[task.id]
    if (was === undefined || task.goal_id !== was.goal_id) return task
    touched += 1
    const next = { ...task }
    delete next.goal_id
    if (was.module !== undefined && next.module === was.module) delete next.module
    return next
  })
  const next: TasksFile = { ...data, goals, tasks }
  delete next.collab_migration
  return { data: next, goals: (data.goals ?? []).length - goals.length, tasks: touched }
}
