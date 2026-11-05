/**
 * ★ **行为账**:她在电脑 / 手机 / 电话上做了什么、对事务官说了什么,一条一行记下来(2026-10-09,卡「行为账」)。
 *
 * 设计与拍板:`docs/设计-事务官从她的行为里学-2026-10-09.md` 第三节第 1 条;
 * 决策记录 2026-10-09「事务官从她的行为里学」。**这一张只记,不学** —— 从账里数习惯是下一张卡。
 *
 * ## 规矩
 *
 * - **只在她这台电脑上**:`<DSH_HOME>/workbench/行为账/<年-月>.jsonl`,不进记忆仓库、不推远端;
 * - **留 90 天**:整个月都过了 90 天的那份文件整个删掉(按月分文件就是为了删得干净);读的时候也只给 90 天内的;
 * - **写失败不影响业务**:`record` 不抛、不等盘,失败只打一行日志;
 * - **不进账的**:各家 AI 的聊天正文、凭据、别人的隐私。`原话` 只收她**对事务官**说的话,
 *   进账前擦掉密钥形状(同诊断包那套 `redactText`),过长截断。
 *
 * 「事」的取值见 `BEHAVIOR_EVENTS`;各入口引常量,不逐字抄。
 */
import { appendFile, mkdir, readdir, readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { redactText } from './diagnostics/redact.ts'

export const BEHAVIOR_DIR_NAME = '行为账'
export const BEHAVIOR_KEEP_DAYS = 90
/** 一句原话最多留多少字。她对事务官一次说的话很少超过这个数;超了截断,不整条丢。 */
export const BEHAVIOR_SAID_MAX = 2000
/** 同一端「露面」隔多久才再记一次。每天第一次 / 最后一次由账里数出来,误差在这一刻钟以内。 */
export const BEHAVIOR_SEEN_GAP_MS = 15 * 60_000

export type BehaviorEnd = '电脑' | '手机' | '电话'
const ENDS: readonly BehaviorEnd[] = ['电脑', '手机', '电话']

/** 「事」的取值。下一张卡按它数,新加一种在这里加。 */
export const BEHAVIOR_EVENTS = {
  /** 拍板:选了哪个选项(`推荐` = 当时事务官推荐的那个)。 */
  decide: '拍板',
  /** 派活:点了哪家(`推荐` = 推荐的那家)。 */
  dispatch: '派活',
  /** 改派:把一件事换给另一家。 */
  redispatch: '改派',
  /** 点开收件箱 / 早报 / 提议 / 待确认里的一条。 */
  open: '点开',
  /** 划掉(收起、忽略、清空)一条。 */
  dismiss: '划掉',
  /** 采纳收件箱 / 提议里的一条(转成卡、加进选题池、固化)。 */
  adopt: '采纳',
  /** 一条在那儿放了很久她都没理(结果里写放了多久)。 */
  ignored: '没理',
  /** 通过 / 打回:`结果` 写「通过」或「打回」。 */
  review: '审',
  /** 替她答的那句被她改掉了。 */
  amend: '改替她答',
  /** 露面(同一端一刻钟内只记一次)。 */
  seen: '露面',
  /** 来电:`结果` 写「接了」/「没接」。 */
  call: '来电',
  /** 通了一通电话(2026-10-22:通话是记录不是事项)。`对象` 是 `通话 <id>`,`结果` 写多长、几句。 */
  talk: '通了电话',
  /** 她对事务官说的话,`原话` 是原文。 */
  say: '说',
  /** 改稿:上一版与她存下的那一版按段比,`结果` 写改了哪几类,`类` 是风格表里的 id(`styleHabits.revisionNoteOf`)。 */
  revise: '改稿',
  /** 改版面:换了哪一格的显示(`对象` 是那一格,`结果` 是换成的那一版)。 */
  layout: '改版面',
  /** 重置了一家的派活通道(2026-10-21,卡「派活按家隔离」):`对象` 是那一家,`结果` 是撤了几下、清了几格。 */
  reset: '重置',
} as const

export type BehaviorEvent = typeof BEHAVIOR_EVENTS[keyof typeof BEHAVIOR_EVENTS]

export interface BehaviorInput {
  端: BehaviorEnd
  事: BehaviorEvent | string
  对象: string
  结果: string
  推荐?: string
  原话?: string
  /**
   * 这件事算哪一类(2026-10-09,卡「数出习惯」):派活 = `habits.dispatchClassOf`(活的种类 + 项目);
   * 审批 = 「同类都允许」那一类的 key(`browser` / `repo:<仓库根>`)。数习惯时按它分,不靠模型。
   */
  类?: string
  /** 这件事摆到她面前的时刻(ISO)。不落盘,落成 `隔了`。 */
  起?: string
}

export interface BehaviorEntry extends Omit<BehaviorInput, '起'> {
  at: string
  /**
   * 隔了几分钟她才理(从摆到她面前到她这一下)。「长时间没理」就从这一格数:没有后台扫描器
   * 去盯着「还没理的」,她理的那一刻把等了多久一起记下;一直没理的由各自的台账(未接来电、提问)作证。
   */
  隔了?: number
}

export interface BehaviorQuery {
  since?: string
  事?: string
  /** 只要最后几条。 */
  limit?: number
}

export interface BehaviorLog {
  /** 记一条。不抛、不等盘。 */
  record: (input: BehaviorInput) => void
  /** 她在某一端露了一面(同一端一刻钟内只记一次)。 */
  seen: (end: BehaviorEnd) => void
  /** 按时间先后读回来(只给 90 天内的)。 */
  read: (query: BehaviorQuery) => Promise<BehaviorEntry[]>
  /** 等排着的写完(测试用;不抛)。 */
  flush: () => Promise<void>
}

export interface BehaviorLogOptions {
  /** 账本所在的目录(测试注入临时目录)。 */
  dir: string
  now?: () => Date
  log?: (line: string) => void
}

/** 默认目录:`<DSH_HOME>/workbench/行为账`;没设 `DSH_HOME` 就是 `~/.dsh`。 */
export function defaultBehaviorDir(env: NodeJS.ProcessEnv = process.env): string {
  const dshHome = env.DSH_HOME !== undefined && env.DSH_HOME !== '' ? env.DSH_HOME : `${env.HOME ?? ''}/.dsh`
  return join(dshHome, 'workbench', BEHAVIOR_DIR_NAME)
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/** 按她这台机器的本地时间分月。 */
function monthOf(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`
}

function dayOf(d: Date): string {
  return `${monthOf(d)}-${pad(d.getDate())}`
}

const MONTH_FILE_RE = /^(\d{4})-(\d{2})\.jsonl$/

function cutoffOf(now: Date): Date {
  return new Date(now.getTime() - BEHAVIOR_KEEP_DAYS * 24 * 3600_000)
}

/** 这个月的最后一刻(本地时间)早于期限 = 整月都过期了。 */
function monthExpired(year: number, month: number, cutoff: Date): boolean {
  const nextMonthStart = new Date(year, month, 1)
  return nextMonthStart.getTime() <= cutoff.getTime()
}

function cleanSaid(said: string | undefined): string | undefined {
  if (said === undefined) return undefined
  const text = redactText(said.trim())
  if (text === '') return undefined
  return text.length > BEHAVIOR_SAID_MAX ? `${text.slice(0, BEHAVIOR_SAID_MAX)}…` : text
}

function entryOf(input: BehaviorInput, at: Date): BehaviorEntry | undefined {
  if (!ENDS.includes(input.端)) return undefined
  if (typeof input.事 !== 'string' || input.事 === '') return undefined
  const said = cleanSaid(input.原话)
  const fromMs = input.起 === undefined ? Number.NaN : Date.parse(input.起)
  const waited = Number.isNaN(fromMs) ? undefined : Math.max(0, Math.round((at.getTime() - fromMs) / 60_000))
  return {
    at: at.toISOString(),
    端: input.端,
    事: input.事,
    对象: String(input.对象 ?? ''),
    结果: String(input.结果 ?? ''),
    ...(input.推荐 !== undefined && input.推荐 !== '' ? { 推荐: input.推荐 } : {}),
    ...(input.类 !== undefined && input.类 !== '' ? { 类: input.类 } : {}),
    ...(said !== undefined ? { 原话: said } : {}),
    ...(waited !== undefined ? { 隔了: waited } : {}),
  }
}

function parseLine(line: string): BehaviorEntry | undefined {
  if (line.trim() === '') return undefined
  try {
    const value = JSON.parse(line) as Partial<BehaviorEntry>
    if (typeof value.at !== 'string' || Number.isNaN(Date.parse(value.at))) return undefined
    if (typeof value.事 !== 'string' || !ENDS.includes(value.端 as BehaviorEnd)) return undefined
    return value as BehaviorEntry
  }
  catch {
    return undefined
  }
}

export function createBehaviorLog(options: BehaviorLogOptions): BehaviorLog {
  const now = options.now ?? (() => new Date())
  const warn = options.log ?? ((line: string) => console.warn(line))
  let chain: Promise<void> = Promise.resolve()
  let prunedDay = ''
  const lastSeen = new Map<BehaviorEnd, Date>()

  async function prune(at: Date): Promise<void> {
    const cutoff = cutoffOf(at)
    let names: string[]
    try { names = await readdir(options.dir) }
    catch { return }
    for (const name of names) {
      const m = MONTH_FILE_RE.exec(name)
      if (m === null) continue
      if (monthExpired(Number(m[1]), Number(m[2]), cutoff)) {
        await unlink(join(options.dir, name)).catch(() => {})
      }
    }
  }

  function write(entry: BehaviorEntry, at: Date): void {
    chain = chain.then(async () => {
      await mkdir(options.dir, { recursive: true })
      await appendFile(join(options.dir, `${monthOf(at)}.jsonl`), `${JSON.stringify(entry)}\n`, 'utf8')
      // 一天删一回过期月份就够了
      const day = dayOf(at)
      if (day !== prunedDay) {
        prunedDay = day
        await prune(at)
      }
    }).catch((error: unknown) => {
      warn(`[workbench] 行为账写不进去(不影响业务):${error instanceof Error ? error.message : String(error)}`)
    })
  }

  function record(input: BehaviorInput): void {
    try {
      const at = now()
      const entry = entryOf(input, at)
      if (entry !== undefined) write(entry, at)
    }
    catch { /* 记账不能拖垮业务 */ }
  }

  function seen(end: BehaviorEnd): void {
    const at = now()
    const last = lastSeen.get(end)
    if (last !== undefined && at.getTime() - last.getTime() < BEHAVIOR_SEEN_GAP_MS && dayOf(last) === dayOf(at)) return
    const first = last === undefined || dayOf(last) !== dayOf(at)
    lastSeen.set(end, at)
    record({ 端: end, 事: BEHAVIOR_EVENTS.seen, 对象: '工作台', 结果: first ? '当天第一次' : '在' })
  }

  async function read(query: BehaviorQuery): Promise<BehaviorEntry[]> {
    await chain
    const cutoff = cutoffOf(now())
    const sinceMs = query.since !== undefined ? Date.parse(query.since) : Number.NEGATIVE_INFINITY
    const fromMs = Math.max(cutoff.getTime(), Number.isNaN(sinceMs) ? Number.NEGATIVE_INFINITY : sinceMs)
    let names: string[]
    try { names = await readdir(options.dir) }
    catch { return [] }
    const rows: BehaviorEntry[] = []
    for (const name of names.filter(n => MONTH_FILE_RE.test(n)).sort()) {
      let text: string
      try { text = await readFile(join(options.dir, name), 'utf8') }
      catch { continue }
      for (const line of text.split('\n')) {
        const entry = parseLine(line)
        if (entry === undefined) continue
        if (Date.parse(entry.at) < fromMs) continue
        if (query.事 !== undefined && entry.事 !== query.事) continue
        rows.push(entry)
      }
    }
    rows.sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
    return query.limit !== undefined && query.limit > 0 ? rows.slice(-query.limit) : rows
  }

  return {
    record,
    seen,
    read,
    flush: async () => { await chain },
  }
}

/** `GET /behavior` 的查询串。 */
export function parseBehaviorQuery(params: URLSearchParams): { ok: true, query: BehaviorQuery } | { ok: false, error: string } {
  const query: BehaviorQuery = {}
  const since = params.get('since')
  if (since !== null && since !== '') {
    const ms = Date.parse(since)
    if (Number.isNaN(ms)) return { ok: false, error: 'since 要是一个时间(如 2026-10-01 或 ISO 时间)' }
    query.since = new Date(ms).toISOString()
  }
  const event = params.get('事') ?? params.get('event')
  if (event !== null && event !== '') query.事 = event
  const limit = params.get('limit')
  if (limit !== null && limit !== '') {
    const n = Number(limit)
    if (!Number.isInteger(n) || n <= 0) return { ok: false, error: 'limit 要是正整数' }
    query.limit = n
  }
  return { ok: true, query }
}

/**
 * 这一条是哪一端的她(http.ts 认出来的设备种类 + `asker`)。
 *
 * **认出了设备就按设备算**:出门时手机的请求由电话工人在房间里代发,同时带着设备头和工人自己那把令牌,
 * `asker` 会是 `worker` —— 按它算就把手机上点的记成了电话。
 * 事务官自己、派出去的别家、认不出来的一律 `undefined` —— **不是她做的不进账**。
 */
export function behaviorEndOf(input: { asker: string, deviceKind?: 'phone' | 'handset' | undefined }): BehaviorEnd | undefined {
  if (input.deviceKind !== undefined) return input.deviceKind === 'handset' ? '电话' : '手机'
  if (input.asker === 'page') return '电脑'
  if (input.asker === 'worker') return '电话'
  return undefined
}

/** 选项名里带着「推荐」记号的那一项就是当时推荐的(DSH 那边写作 `(Recommended)`)。 */
const RECOMMENDED_RE = /recommended|推荐/i

/**
 * 拍板那一问:问的是什么、她选了哪个、当时推荐的是哪个。一次答多问的,各问用「;」连起来。
 */
export function questionPickOf(
  questions: readonly { id: string, question: string, options?: readonly { label: string }[] }[],
  answers: unknown,
): { 对象: string, 结果: string, 推荐?: string } {
  const list = Array.isArray(answers) ? answers as { id?: unknown, selected?: unknown, custom?: unknown }[] : []
  const asked: string[] = []
  const picked: string[] = []
  const recommended: string[] = []
  for (const q of questions) {
    asked.push(q.question)
    const a = list.find(item => item?.id === q.id)
    const selected = Array.isArray(a?.selected) ? a.selected.filter((x): x is string => typeof x === 'string') : []
    const custom = typeof a?.custom === 'string' && a.custom.trim() !== '' ? `自己写:${a.custom.trim()}` : undefined
    picked.push([...selected, ...(custom === undefined ? [] : [custom])].join('、'))
    const rec = q.options?.find(o => RECOMMENDED_RE.test(o.label))
    if (rec !== undefined) recommended.push(rec.label)
  }
  return {
    对象: asked.join(';'),
    结果: picked.join(';'),
    ...(recommended.length > 0 ? { 推荐: recommended.join(';') } : {}),
  }
}

/** 「等你确认」那一条她批没批。带派活选项的(`dispatch:` 那一种)算派活,推荐 = 当时问的那一家。 */
export function approvalNoteOf(
  view: {
    session_id: string, tool: string, at?: string, reason?: string, say?: string,
    options?: readonly { title: string, chosen?: boolean }[]
    /** 「同类都允许」那一类(有才记;数「要不要问她」按它分)。 */
    kind?: { key: string }
  },
  allow: boolean,
): Omit<BehaviorInput, '端'> {
  const chosen = view.options?.find(o => o.chosen === true)
  const dispatch = view.session_id.startsWith('dispatch:') || chosen !== undefined
  return {
    事: dispatch ? BEHAVIOR_EVENTS.dispatch : BEHAVIOR_EVENTS.decide,
    对象: view.say ?? view.reason ?? view.tool,
    结果: allow ? '同意' : '不同意',
    ...(dispatch && chosen !== undefined ? { 推荐: chosen.title } : {}),
    ...(!dispatch && view.kind !== undefined ? { 类: view.kind.key } : {}),
    ...(view.at === undefined ? {} : { 起: view.at }),
  }
}

/**
 * 看板上挪一格,哪几种是她的判断:等我确认那件点完成(通过)/ 拖回在办或待办(打回)/ 取消;
 * 随口问、事务官直接答完的那张(`casual`)从办完拖回来 = 那个答案她不认。别的挪动只是排程,不记。
 */
export function taskMoveNoteOf(
  before: { id: string, title: string, status: string, casual?: boolean },
  to: string,
): Omit<BehaviorInput, '端'> | undefined {
  const 对象 = `${before.id} ${before.title}`
  if (before.status === 'confirm') {
    if (to === 'done') return { 事: BEHAVIOR_EVENTS.review, 对象, 结果: '通过' }
    if (to === 'doing' || to === 'todo') return { 事: BEHAVIOR_EVENTS.review, 对象, 结果: '打回' }
    if (to === 'canceled') return { 事: BEHAVIOR_EVENTS.review, 对象, 结果: '取消' }
    return undefined
  }
  if (before.status === 'done' && before.casual === true && (to === 'doing' || to === 'todo')) {
    return { 事: BEHAVIOR_EVENTS.amend, 对象, 结果: '拖回去重办' }
  }
  return undefined
}

/** 选题 / 需求那一页的三颗键记成什么(`DECK_REVIEW_ACTIONS`);别的动作原样记。 */
const REVIEW_RESULT_TEXT: Readonly<Record<string, string>> = {
  pass: '通过',
  revise: '打回',
  self: '自己改',
}

export function reviewResultText(action: string): string {
  return REVIEW_RESULT_TEXT[action] ?? action
}

/** 事务官打来的那一通收场了:接了 / 没接。只发了通知的、没打出去的那几条她压根没听见响,不记。 */
export function callSettledNoteOf(entry: { reason: string, title: string, state: string, silent: boolean }): BehaviorInput | undefined {
  if (entry.silent) return undefined
  if (entry.state !== 'answered' && entry.state !== 'missed') return undefined
  return { 端: '电话', 事: BEHAVIOR_EVENTS.call, 对象: `${entry.reason} · ${entry.title}`, 结果: entry.state === 'answered' ? '接了' : '没接' }
}
