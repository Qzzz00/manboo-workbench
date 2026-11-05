/**
 * ★ **从行为账里数出习惯**(2026-10-09,卡「数出习惯」;设计 `docs/设计-事务官从她的行为里学-2026-10-09.md`
 * 第三节第 2、4、5 条;决策记录 2026-10-09 维护者拍板的三条)。
 *
 * 四种,**全靠计数,不经模型**:
 *
 * | 种 | 同一类事怎么分 | 什么时候试用 | 怎么验 |
 * |---|---|---|---|
 * | 默认分派 `dispatch` | 活的种类 + 挂的项目(`dispatchClassOf`,与派活挑手同一把尺) | 推荐 A、她改成 B,在 ≥2 件不同的事上,且最近一次也是改成 B | 下一次推荐 B:她照派 = 留,改别家 = 撤 |
 * | 什么时段不打电话 `quiet` | 一天里的钟点(本机时间) | 那个钟点 ≥2 天没接、一通都没接过,且最近一通也没接 | 那个钟点她接了一通 = 撤;改成消息的那一通过去了她没接电话 = 留 |
 * | 早报几点备好 `brief` | 每天第一次露面 | 早报没设时刻(露面才开工)、近 14 天 ≥3 天露过面 → 中位数前 10 分钟 | 下一天她在那之后才露面 = 留;比它早 = 撤 |
 * | 问不问她 `noask` | 「同类都允许」那两类(开浏览器截图 / 同一个仓库里动手) | 连着 ≥3 次原样点头、跨 ≥2 天 | 放行过的那件事她打回 / 取消 / 收回「同类都允许」/ 又说不行 = 撤;那件事通过了、或又放行一次她没改 = 留 |
 *
 * 第五种 **说话和做事风格 `style`**(卡「学风格」,`styleHabits.ts`):模型只从她的原话 / 观察里提候选(必须附原话),
 * 改稿比对不经模型;同一候选按固定风格表的 id 数,不同的两件事上出现才试用,下一次交付她没再这么说 = 留,又说了 = 撤。
 * 试用中 / 留下的风格由规矩表投影进四处(事务官对话、电话人设、派活指令、交回自查),与规矩同一条路。
 *
 * **硬边界**:10-04 定的四类(改她的习惯、花钱或额度、对外说法、要她亲手做的)**永远要问,学不掉**
 * (`fourKindOf`)。学的时候沾四类的不出候选;放行的时候这一条沾四类的照旧问 —— 两道都在,表被手改也拦得住。
 *
 * 状态沿用规矩表那一套(`trial` → `kept` / `reverted`;她点撤掉 = `removed`),**存在同一张 `rules.json` 里**
 * (`RulesService.habits / putHabits`),不另起一份。撤过的(`reverted` / `removed`)id 留着,**同一条不再自动学回来**。
 * 每一步(试用、留下、撤)写一行进她工作目录的 `进化日志.md`,写法与选题偏好同一套(`evolve.ts` 的 `appendLog` / `annotateLog`)。
 *
 * 行为账的两个已知毛病(交接-1009-行为账 第三节),数作息时不被它带偏:
 * - 工作台重启会让「当天第一次露面」重复记 → 每天只取最早那一刻,不认「当天第一次」那几个字;
 * - 手机在后台会多记露面 → 一天从早上 4 点算起(过了半夜那几条算前一天),且早于「早报最早几点」的露面不算第一次。
 */
import { dispatchFamilyTitle, isAgentDispatchFamily, JOB_KIND_TITLES } from '../protocol.ts'
import type { AgentDispatchFamily, HabitKind, HabitStatus, HabitsView, HabitView, JobKind } from '../protocol.ts'
import { BEHAVIOR_EVENTS, type BehaviorEntry } from './behaviorLog.ts'
import { annotateLog, appendLog, evolveLogPath, type EvolveLogEntry } from './evolve.ts'
import {
  STYLE_BATCH, STYLE_DAILY_CALLS, STYLE_NOTES_MAX, STYLE_OBSERVED_MAX, emptyStyleState, findStyleHabits, observationLines,
  parseStyleReply, styleCandidate, styleExtractPrompt, styleNotesOfRevisions, styleSayable, styleThingOf, verifyStyleHabit,
  type StyleNote, type StyleSource, type StyleState,
} from './styleHabits.ts'

// ───────────────────────────── 常量 ─────────────────────────────

/** 数多久以内的账(早报另看近 14 天)。 */
export const HABIT_WINDOW_DAYS = 30
/** 默认分派:在几件不同的事上改成同一家。 */
export const DISPATCH_MIN_ITEMS = 2
/** 时段:几天没接。 */
export const QUIET_MIN_DAYS = 2
/** 早报:近几天、至少几天露过面。 */
export const BRIEF_LOOKBACK_DAYS = 14
export const BRIEF_MIN_DAYS = 3
/** 早报比她通常露面早几分钟备好。 */
export const BRIEF_LEAD_MIN = 10
/** 问不问:连着几次原样点头、至少跨几天。 */
export const NOASK_MIN = 3
export const NOASK_MIN_DAYS = 2
/** 一天从几点算起(手机在后台过了半夜还在多记露面,那几条算前一天)。 */
export const DAY_STARTS_AT_HOUR = 4
/** 每条习惯留几条证据、几条「用上了」。 */
export const HABIT_EVIDENCE_MAX = 10
export const HABIT_APPLIED_MAX = 20

export const HABIT_KIND_TITLES: Readonly<Record<HabitKind, string>> = {
  dispatch: '默认分派',
  quiet: '什么时候打电话',
  brief: '早报几点备好',
  noask: '要不要问她',
  style: '说话和做事风格',
}

// ───────────────────────────── 硬边界:四类永远要问 ─────────────────────────────

/** 10-04 定的四类(`confirmPoints.ASK_ONLY_FOUR_KINDS`)各自的短名。 */
export const FOUR_KINDS = {
  habit: '改她的习惯',
  spend: '花钱或额度',
  outward: '对外说法',
  byHand: '要她亲手做',
} as const
export type FourKind = typeof FOUR_KINDS[keyof typeof FOUR_KINDS]

/** 认的是字面,宁可多认(多问一次)不可漏认(替她做了不该做的)。顺序:亲手 → 花钱 → 对外 → 改习惯。 */
const FOUR_KIND_PATTERNS: readonly (readonly [FourKind, RegExp])[] = [
  [FOUR_KINDS.byHand, /登录|登陆|密码|口令|验证码|凭据|令牌|钥匙串|付款|扫码|身份证|银行卡|password|passwd|login|log\s*in|sign\s*in|captcha|2fa|otp|token|credential|keychain|security\s+(find|add|delete)-/i],
  [FOUR_KINDS.spend, /花钱|付费|支付|购买|下单|充值|订阅|续费|额度|上限|派给|派活|还剩约|dispatch|quota|billing|purchase|subscri|checkout/i],
  [FOUR_KINDS.outward, /发布|发帖|发给|发消息|发邮件|发朋友圈|群发|转发给|回复客户|对外|公开|上线|部署|publish|deploy|release|git\s+push|\bpush\b|gh\s+pr|tweet|\bsend\b|\bmail\b|\bpost\b/i],
  [FOUR_KINDS.habit, /规矩|习惯|偏好|设置|布局|默认值|授权|rules\.json|routines\.json|AGENTS\.md|\.dsh\/|settings|defaults\s+write/i],
]

/** 这段字沾不沾四类(沾哪一类)。 */
export function fourKindOf(text: string): FourKind | undefined {
  for (const [kind, pattern] of FOUR_KIND_PATTERNS) if (pattern.test(text)) return kind
  return undefined
}

// ───────────────────────────── 同一类事怎么分 ─────────────────────────────

/** 派活那一类:活的种类(与 `dispatchChoice.jobKindOf` 同一把尺)+ 挂的项目。 */
export function dispatchClassOf(kind: JobKind, project?: string): string {
  const name = project?.trim() ?? ''
  return name === '' ? JOB_KIND_TITLES[kind] : `${JOB_KIND_TITLES[kind]} · ${name}`
}

/**
 * 问不问那一类,只认「同类都允许」那两类(`butlerAsks.approvalKind`:`browser` / `repo:<仓库根>`)——
 * 学的就是她自己本来能点的那颗键,从一件事推广到以后的事。别的(派活闸、上限问话、钩子判的那一问)一律不学。
 */
export function noAskLearnable(klass: string): boolean {
  if (klass !== 'browser' && !klass.startsWith('repo:')) return false
  return fourKindOf(klass) === undefined
}

function noAskTitle(klass: string): string {
  if (klass === 'browser') return '开看不见的浏览器截图'
  const root = klass.slice('repo:'.length).replace(/\/+$/, '')
  return `在「${root.slice(root.lastIndexOf('/') + 1) || root}」这个仓库里动手`
}

// ───────────────────────────── 存的形状 ─────────────────────────────

export interface HabitEvidence { at: string, what: string }
export interface HabitApplied { at: string, where: string }

export interface StoredHabit {
  /** 稳定 id(撤过的靠它认出来,不再自动学回来)。 */
  id: string
  kind: HabitKind
  /** 同一类事的那个「类」。 */
  类: string
  /** 学到的值:家名 / 钟点 / HH:MM / 空。 */
  value: string
  text: string
  status: HabitStatus
  evidence: HabitEvidence[]
  applied: HabitApplied[]
  created_at: string
  updated_at: string
  adopted_at: string
  verdict?: string
  /** 风格那一种:证据从哪几路来(说 / 观察 / 改稿);验的时候据此认「同类交付」。 */
  from?: StyleSource[]
  /**
   * 收件箱里那句「新学到一条」她看过了(点「知道了」、撤掉、自己恢复的)。缺席 = 还没告诉过她 ——
   * 试用中的每一条只说一次。
   */
  noticed_at?: string
}

const KINDS: readonly HabitKind[] = ['dispatch', 'quiet', 'brief', 'noask', 'style']
const STYLE_SOURCES: readonly StyleSource[] = ['说', '观察', '改稿']
const STATUSES: readonly HabitStatus[] = ['trial', 'kept', 'reverted', 'removed']

/** 读盘时的把关:认不出的一条丢掉(读不懂的不该让工作台起不来)。 */
export function sanitizeHabit(value: unknown): StoredHabit | undefined {
  const raw = value as Record<string, unknown> | null
  if (raw === null || typeof raw !== 'object') return undefined
  if (typeof raw.id !== 'string' || raw.id === '' || typeof raw.text !== 'string') return undefined
  if (!KINDS.includes(raw.kind as HabitKind) || !STATUSES.includes(raw.status as HabitStatus)) return undefined
  const at = typeof raw.created_at === 'string' ? raw.created_at : new Date(0).toISOString()
  const list = <T>(items: unknown, ok: (one: Record<string, unknown>) => boolean): T[] =>
    Array.isArray(items) ? items.filter(one => one !== null && typeof one === 'object' && ok(one as Record<string, unknown>)) as T[] : []
  return {
    id: raw.id,
    kind: raw.kind as HabitKind,
    类: typeof raw.类 === 'string' ? raw.类 : '',
    value: typeof raw.value === 'string' ? raw.value : '',
    text: raw.text,
    status: raw.status as HabitStatus,
    evidence: list<HabitEvidence>(raw.evidence, one => typeof one.at === 'string' && typeof one.what === 'string'),
    applied: list<HabitApplied>(raw.applied, one => typeof one.at === 'string' && typeof one.where === 'string'),
    created_at: at,
    updated_at: typeof raw.updated_at === 'string' ? raw.updated_at : at,
    adopted_at: typeof raw.adopted_at === 'string' ? raw.adopted_at : at,
    ...(typeof raw.verdict === 'string' ? { verdict: raw.verdict } : {}),
    ...(Array.isArray(raw.from) ? { from: raw.from.filter((one): one is StyleSource => STYLE_SOURCES.includes(one as StyleSource)) } : {}),
    ...(typeof raw.noticed_at === 'string' ? { noticed_at: raw.noticed_at } : {}),
  }
}

/** 还算数的(试用中 / 留下的)。 */
export function habitLive(habit: Pick<StoredHabit, 'status'>): boolean {
  return habit.status === 'trial' || habit.status === 'kept'
}

// ───────────────────────────── 时间 ─────────────────────────────

const pad = (n: number): string => String(n).padStart(2, '0')

function dateOf(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 哪一天(本机时间;一天从早上 4 点算起)。 */
export function dayKeyOf(ms: number): string {
  return dateOf(new Date(ms - DAY_STARTS_AT_HOUR * 3600_000))
}

function minuteOfDay(ms: number): number {
  const d = new Date(ms)
  return d.getHours() * 60 + d.getMinutes()
}

function hhmm(minutes: number): string {
  return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`
}

function parseHhmm(text: string | undefined): number | undefined {
  const m = /^(\d{1,2}):(\d{2})$/.exec(text?.trim() ?? '')
  if (m === null) return undefined
  const h = Number(m[1])
  const min = Number(m[2])
  return h < 24 && min < 60 ? h * 60 + min : undefined
}

/** 证据那一行的时刻:「10-03 14:20」。 */
function stamp(iso: string): string {
  const d = new Date(iso)
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function inWindow(entries: readonly BehaviorEntry[], nowMs: number, days: number): BehaviorEntry[] {
  const from = nowMs - days * 86_400_000
  return entries
    .filter((one) => { const t = Date.parse(one.at); return !Number.isNaN(t) && t >= from && t <= nowMs })
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
}

function newHabit(input: Omit<StoredHabit, 'status' | 'applied' | 'created_at' | 'updated_at' | 'adopted_at'>, nowMs: number): StoredHabit {
  const at = new Date(nowMs).toISOString()
  return { ...input, evidence: input.evidence.slice(-HABIT_EVIDENCE_MAX), status: 'trial', applied: [], created_at: at, updated_at: at, adopted_at: at }
}

const itemOf = (对象: string): string => 对象.trim().split(/\s+/)[0] ?? ''
const chosenOf = (结果: string): string => 结果.replace(/[((]没派成[))]\s*$/u, '').trim()

// ───────────────────────────── ① 默认分派 ─────────────────────────────

function isPick(one: BehaviorEntry): boolean {
  return (one.事 === BEHAVIOR_EVENTS.dispatch || one.事 === BEHAVIOR_EVENTS.redispatch)
    && typeof one.类 === 'string' && one.类 !== '' && typeof one.推荐 === 'string' && one.推荐 !== ''
    && isAgentDispatchFamily(chosenOf(one.结果))
}

export function findDispatchHabits(entries: readonly BehaviorEntry[], known: readonly StoredHabit[], nowMs: number): StoredHabit[] {
  const rows = inWindow(entries, nowMs, HABIT_WINDOW_DAYS).filter(isPick)
  const out: StoredHabit[] = []
  for (const klass of new Set(rows.map(one => one.类 as string))) {
    const inClass = rows.filter(one => one.类 === klass)
    const last = inClass[inClass.length - 1]
    if (last === undefined) continue
    const target = chosenOf(last.结果)
    // 最近那一次就是「推荐别家、她改成这一家」—— 她已经照推荐派了的,不学。
    if (last.推荐 === target) continue
    const id = `分派:${klass}→${target}`
    if (known.some(one => one.id === id || (one.kind === 'dispatch' && one.类 === klass && habitLive(one)))) continue
    const changes = inClass.filter(one => chosenOf(one.结果) === target && one.推荐 !== target)
    if (new Set(changes.map(one => itemOf(one.对象))).size < DISPATCH_MIN_ITEMS) continue
    out.push(newHabit({
      id,
      kind: 'dispatch',
      类: klass,
      value: target,
      text: `「${klass}」这类事默认派给 ${dispatchFamilyTitle(target)}`,
      evidence: changes.map(one => ({
        at: one.at,
        what: `${stamp(one.at)}《${one.对象}》推荐 ${dispatchFamilyTitle(one.推荐 ?? '')},她派了 ${dispatchFamilyTitle(target)}`,
      })),
    }, nowMs))
  }
  return out
}

function verifyDispatch(habit: StoredHabit, entries: readonly BehaviorEntry[]): { status: HabitStatus, why: string } {
  const next = entries
    .filter(one => one.at >= habit.adopted_at && isPick(one) && one.类 === habit.类 && one.推荐 === habit.value)
    .sort((a, b) => a.at.localeCompare(b.at))[0]
  if (next === undefined) return { status: 'trial', why: '试用之后这类事还没派过' }
  const chosen = chosenOf(next.结果)
  return chosen === habit.value
    ? { status: 'kept', why: `${stamp(next.at)}《${next.对象}》推荐 ${dispatchFamilyTitle(habit.value)},她照派了` }
    : { status: 'reverted', why: `${stamp(next.at)}《${next.对象}》推荐 ${dispatchFamilyTitle(habit.value)},她改派了 ${dispatchFamilyTitle(chosen)}` }
}

// ───────────────────────────── ② 什么时段不打电话 ─────────────────────────────

const isCall = (one: BehaviorEntry): boolean => one.事 === BEHAVIOR_EVENTS.call && (one.结果 === '接了' || one.结果 === '没接')
const hourOf = (iso: string): number => new Date(iso).getHours()

export function findQuietHabits(entries: readonly BehaviorEntry[], known: readonly StoredHabit[], nowMs: number): StoredHabit[] {
  const calls = inWindow(entries, nowMs, HABIT_WINDOW_DAYS).filter(isCall)
  const out: StoredHabit[] = []
  for (const hour of new Set(calls.map(one => hourOf(one.at)))) {
    const id = `时段:${hour}`
    if (known.some(one => one.id === id)) continue
    const inHour = calls.filter(one => hourOf(one.at) === hour)
    if (inHour.some(one => one.结果 === '接了')) continue
    if (new Set(inHour.map(one => dayKeyOf(Date.parse(one.at)))).size < QUIET_MIN_DAYS) continue
    out.push(newHabit({
      id,
      kind: 'quiet',
      类: `${hour} 点`,
      value: String(hour),
      text: `${pad(hour)}:00–${pad((hour + 1) % 24)}:00 不打电话,改发消息`,
      evidence: inHour.map(one => ({ at: one.at, what: `${stamp(one.at)} 打来一通(${one.对象}),她没接` })),
    }, nowMs))
  }
  return out
}

function verifyQuiet(habit: StoredHabit, entries: readonly BehaviorEntry[], nowMs: number): { status: HabitStatus, why: string } {
  const hour = Number(habit.value)
  const answered = entries.find(one => one.at >= habit.adopted_at && isCall(one) && one.结果 === '接了' && hourOf(one.at) === hour)
  if (answered !== undefined) return { status: 'reverted', why: `${stamp(answered.at)} 那个钟点她接了电话` }
  const used = habit.applied.find((one) => {
    const end = new Date(one.at)
    end.setMinutes(0, 0, 0)
    return end.getTime() + 3600_000 <= nowMs
  })
  if (used !== undefined) return { status: 'kept', why: `${stamp(used.at)} 那一通改成了消息,那个钟点她没接过电话` }
  return { status: 'trial', why: '试用之后那个钟点还没有电话改成消息' }
}

// ───────────────────────────── ③ 早报几点备好 ─────────────────────────────

/**
 * 每天第一次露面(分钟)。去重靠两条:每天只取最早那一刻(重启重复记的「当天第一次」不影响);
 * 一天从 4 点算起、早于 `notBefore` 的不算(手机在后台过了半夜多记的那几条)。
 */
export function firstSeenByDay(entries: readonly BehaviorEntry[], notBefore: string): Map<string, number> {
  const floor = parseHhmm(notBefore) ?? 6 * 60
  const days = new Map<string, number>()
  for (const one of entries) {
    if (one.事 !== BEHAVIOR_EVENTS.seen) continue
    const t = Date.parse(one.at)
    if (Number.isNaN(t)) continue
    const minute = minuteOfDay(t)
    if (minute < floor) continue
    const day = dayKeyOf(t)
    const before = days.get(day)
    if (before === undefined || minute < before) days.set(day, minute)
  }
  return days
}

export function briefHabitText(at: string, usual: string): string {
  return `早报 ${at} 先备好(她通常 ${usual} 前后第一次露面)`
}

export function findBriefHabit(
  entries: readonly BehaviorEntry[],
  known: readonly StoredHabit[],
  nowMs: number,
  morning: { at?: string, not_before: string },
): StoredHabit | undefined {
  // 她自己定了时刻 = 她的设置,不动。
  if (morning.at !== undefined && morning.at !== '') return undefined
  if (known.some(one => one.kind === 'brief' && habitLive(one))) return undefined
  const today = dayKeyOf(nowMs)
  const days = [...firstSeenByDay(inWindow(entries, nowMs, BRIEF_LOOKBACK_DAYS), morning.not_before)]
    .filter(([day]) => day !== today)
    .sort(([a], [b]) => a.localeCompare(b))
  if (days.length < BRIEF_MIN_DAYS) return undefined
  const sorted = days.map(([, minute]) => minute).sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  const median = sorted.length % 2 === 1 ? sorted[mid] as number : Math.floor(((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2)
  const floor = parseHhmm(morning.not_before) ?? 6 * 60
  const target = Math.max(floor, Math.floor((median - BRIEF_LEAD_MIN) / 5) * 5)
  const id = `早报:${hhmm(target)}`
  if (known.some(one => one.id === id)) return undefined
  return newHabit({
    id,
    kind: 'brief',
    类: '早报',
    value: hhmm(target),
    text: briefHabitText(hhmm(target), hhmm(median)),
    evidence: days.map(([day, minute]) => ({ at: day, what: `${day.slice(5)} 第一次露面 ${hhmm(minute)}` })),
  }, nowMs)
}

function verifyBrief(habit: StoredHabit, entries: readonly BehaviorEntry[], nowMs: number): { status: HabitStatus, why: string } {
  const target = parseHhmm(habit.value)
  if (target === undefined) return { status: 'trial', why: '' }
  const adoptedDay = dayKeyOf(Date.parse(habit.adopted_at))
  // 过了半夜那几条(手机在后台多记的)不算第一次露面:它们算前一天,而且早于一天的起点。
  const next = [...firstSeenByDay(inWindow(entries, nowMs, BRIEF_LOOKBACK_DAYS), hhmm(DAY_STARTS_AT_HOUR * 60))]
    .filter(([day]) => day > adoptedDay)
    .sort(([a], [b]) => a.localeCompare(b))[0]
  if (next === undefined) return { status: 'trial', why: '试用之后她还没露过面' }
  const [day, minute] = next
  return minute >= target
    ? { status: 'kept', why: `${day.slice(5)} 她 ${hhmm(minute)} 才露面,早报 ${habit.value} 已经备好` }
    : { status: 'reverted', why: `${day.slice(5)} 她 ${hhmm(minute)} 就露面了,比 ${habit.value} 还早` }
}

// ───────────────────────────── ④ 问不问她 ─────────────────────────────

const isApproval = (one: BehaviorEntry): boolean => one.事 === BEHAVIOR_EVENTS.decide && typeof one.类 === 'string' && one.类 !== ''
const allowed = (one: BehaviorEntry): boolean => one.结果.startsWith('同意')
/** 她收回「同类都允许」那一下记成的结果(http.ts `/approvals/grant/revoke`)。 */
export const GRANT_REVOKED = '收回同类都允许'

export function findNoAskHabits(entries: readonly BehaviorEntry[], known: readonly StoredHabit[], nowMs: number): StoredHabit[] {
  const rows = inWindow(entries, nowMs, HABIT_WINDOW_DAYS).filter(isApproval)
  const out: StoredHabit[] = []
  for (const klass of new Set(rows.map(one => one.类 as string))) {
    if (!noAskLearnable(klass)) continue
    const id = `不问:${klass}`
    if (known.some(one => one.id === id)) continue
    const streak: BehaviorEntry[] = []
    for (const one of rows.filter(row => row.类 === klass).reverse()) {
      if (!allowed(one)) break
      streak.unshift(one)
    }
    if (streak.length < NOASK_MIN) continue
    if (new Set(streak.map(one => dayKeyOf(Date.parse(one.at)))).size < NOASK_MIN_DAYS) continue
    // 那几次问的事里沾了四类的(要推送、要登录……)整类不学。
    if (streak.some(one => fourKindOf(one.对象) !== undefined)) continue
    out.push(newHabit({
      id,
      kind: 'noask',
      类: klass,
      value: '',
      text: `「${noAskTitle(klass)}」这类不问,做完告诉她`,
      evidence: streak.map(one => ({ at: one.at, what: `${stamp(one.at)}「${one.对象}」她点了${one.结果}` })),
    }, nowMs))
  }
  return out
}

function verifyNoAsk(habit: StoredHabit, entries: readonly BehaviorEntry[]): { status: HabitStatus, why: string } {
  const applied = [...habit.applied].sort((a, b) => a.at.localeCompare(b.at))
  const events: { at: string, status: HabitStatus, why: string }[] = []
  for (const one of entries) {
    if (one.at < habit.adopted_at) continue
    if (isApproval(one) && one.类 === habit.类 && (one.结果 === GRANT_REVOKED || !allowed(one))) {
      events.push({ at: one.at, status: 'reverted', why: `${stamp(one.at)} 她${one.结果 === GRANT_REVOKED ? '收回了「同类都允许」' : `对「${one.对象}」说了不行`}` })
      continue
    }
    if (one.事 !== BEHAVIOR_EVENTS.review) continue
    const item = itemOf(one.对象)
    const used = applied.find(a => a.where === item && a.at <= one.at)
    if (used === undefined) continue
    if (one.结果 === '通过') events.push({ at: one.at, status: 'kept', why: `${stamp(one.at)}《${one.对象}》替她放行过,她通过了` })
    else if (one.结果 === '打回' || one.结果 === '取消') events.push({ at: one.at, status: 'reverted', why: `${stamp(one.at)}《${one.对象}》替她放行过,她${one.结果}了` })
  }
  const second = applied[1]
  if (second !== undefined) events.push({ at: second.at, status: 'kept', why: `${stamp(applied[0]?.at ?? second.at)} 起替她放行了两次,中间她没改` })
  events.sort((a, b) => a.at.localeCompare(b.at))
  const first = events[0]
  return first === undefined ? { status: 'trial', why: '试用之后还没替她放行过' } : { status: first.status, why: first.why }
}

// ───────────────────────────── 验 ─────────────────────────────

/** 试用的这一条验出结论没有。**第一个有结论的说了算**。风格那一种要带上认过的候选,走 `verifyStyleHabit`。 */
export function verifyHabit(habit: StoredHabit, entries: readonly BehaviorEntry[], nowMs: number): { status: HabitStatus, why: string } {
  const sorted = [...entries].sort((a, b) => a.at.localeCompare(b.at))
  if (habit.kind === 'dispatch') return verifyDispatch(habit, sorted)
  if (habit.kind === 'quiet') return verifyQuiet(habit, sorted, nowMs)
  if (habit.kind === 'brief') return verifyBrief(habit, sorted, nowMs)
  if (habit.kind === 'style') return verifyStyleHabit(habit, styleNotesOfRevisions(sorted), sorted, undefined)
  return verifyNoAsk(habit, sorted)
}

// ───────────────────────────── 进化日志 ─────────────────────────────

export const HABIT_UNDO = '「它学到了什么」里点「撤掉」(接口 `POST /habits/revoke {id}`);撤掉的不再自动学回来,撤错了在那里点「恢复」'

export function habitLogEntry(habit: StoredHabit, date: string): EvolveLogEntry {
  return {
    id: habit.id,
    date,
    why: habit.evidence.map(one => one.what).join(';'),
    what: `试用习惯(${HABIT_KIND_TITLES[habit.kind]}):${habit.text}`,
    how_to_undo: HABIT_UNDO,
    way: 'habit',
  }
}

/** 她在「它学到了什么」里把撤掉的那条恢复了。 */
export function habitRestoredLine(habit: StoredHabit, date: string): string {
  return `- **她恢复了**:${date} —— 重新试用,照常验证(习惯 id \`${habit.id}\`)\n`
}

export function habitVerdictLine(habit: StoredHabit, date: string): string {
  const head = habit.status === 'kept' ? '留下' : habit.status === 'removed' ? '她撤掉了' : '撤了(她纠正了)'
  return `- **${head}**:${date} —— ${habit.verdict ?? ''}(习惯 id \`${habit.id}\`)\n`
}

// ───────────────────────────── 视图 ─────────────────────────────

export function habitView(habit: StoredHabit): HabitView {
  const last = habit.applied[habit.applied.length - 1]
  return {
    id: habit.id,
    kind: habit.kind,
    kind_title: HABIT_KIND_TITLES[habit.kind],
    text: habit.text,
    ...(habit.kind === 'style' && styleCandidate(habit.value) !== undefined ? { title: styleCandidate(habit.value)?.title as string } : {}),
    status: habit.status,
    evidence: habit.evidence,
    applied: habit.applied.length,
    ...(last === undefined ? {} : { last_applied_at: last.at }),
    adopted_at: habit.adopted_at,
    updated_at: habit.updated_at,
    ...(habit.verdict === undefined ? {} : { verdict: habit.verdict }),
  }
}

export function habitsView(habits: readonly StoredHabit[]): HabitsView {
  const newest = (a: StoredHabit, b: StoredHabit): number => b.updated_at.localeCompare(a.updated_at)
  return {
    trial: habits.filter(one => one.status === 'trial').sort(newest).map(habitView),
    kept: habits.filter(one => one.status === 'kept').sort(newest).map(habitView),
    retired: habits.filter(one => !habitLive(one)).sort(newest).map(habitView),
  }
}

// ───────────────────────────── 服务 ─────────────────────────────

/** 存在规矩表那一份里(`RulesService.habits / putHabits`)。 */
export interface HabitStorePort {
  habits: () => readonly StoredHabit[]
  putHabits: (habits: readonly StoredHabit[]) => Promise<void>
  /** 风格那一截认到哪了、认出了什么、今天问了几次模型(同一张 `rules.json` 的 `style` 一节)。缺席 = 只记在内存里。 */
  styleState?: () => StyleState | undefined
  putStyleState?: (state: StyleState) => Promise<void>
}

/** 风格那一种要的两样:问模型(只认候选)、读「观察」。 */
export interface HabitStyleOptions {
  /** 问一次模型,回原文。会花额度:每天最多 `dailyCalls` 次(缺省 `STYLE_DAILY_CALLS`)。 */
  ask: (prompt: string) => Promise<string>
  /** `用户-*.md` 全文(读「观察」一节)。缺席 = 观察这一路不学。 */
  observations?: () => Promise<string | undefined>
  dailyCalls?: number
}

export interface HabitServiceOptions {
  store: HabitStorePort
  behavior: { read: (query: { since?: string }) => Promise<BehaviorEntry[]> }
  now?: () => number
  /** 她的工作目录(`进化日志.md` 落这里)。缺席 = 日志写不了,习惯照学、日志如实少写。 */
  workdir?: string
  io?: { readFile: (file: string) => Promise<string | undefined>, writeFile: (file: string, text: string) => Promise<void> }
  /** 早报那条例程的设置(她定没定时刻、最早几点)。缺席 = 早报这一种不学。 */
  morning?: () => { at?: string, not_before: string } | undefined
  /** 学完有变化时叫一声(广播快照)。 */
  onChanged?: () => void
  log?: (line: string) => void
  /** 风格那一种的模型与观察。缺席 = 只从改稿里学风格(不问模型)。 */
  style?: HabitStyleOptions
}

export interface HabitLearnOptions {
  /**
   * 这一遍要不要把还没认的话 / 观察送去认(下班例程之后、启动时、她点「从观察里学」)。
   * 不带 = 平时那一遍(派活、拍板之后):攒满一批(`STYLE_BATCH`)才认,省额度;观察不读。
   */
  style?: boolean
}

export type HabitRevokeResult = { ok: true, habit: HabitView, note: string } | { ok: false, error: string }

/** 收件箱里一次最多说几条「新学到一条」(新的在前;看过一条,下一条才轮上)。 */
export const HABIT_NOTICES_MAX = 3

export interface HabitService {
  load: () => Promise<void>
  /** 学一遍:先认风格候选,再验试用中的,再找新的。同一时刻只跑一遍。 */
  learn: (opts?: HabitLearnOptions) => Promise<{ adopted: number, kept: number, reverted: number, note: string }>
  /** 只把「观察」送去认一遍(她在设置里点「从记忆里的观察学」;观察不再一次性导进规矩表)。 */
  learnObservations: () => Promise<{ ok: boolean, candidates: number, adopted: number, note: string }>
  /** 账里多了一条值得数的:过一会儿学一遍(合并几下连着的)。 */
  poke: () => void
  view: () => HabitsView
  revoke: (id: string) => Promise<HabitRevokeResult>
  /**
   * 撤错了,她手动恢复(撤掉的 / 自动撤的都行):重新进试用、从这一刻起照常验证,日志补一行。
   * 同一类正有另一条在算数(相反的风格、另一家默认分派、另一个早报时刻)时不恢复,说清是哪一条。
   */
  restore: (id: string) => Promise<HabitRevokeResult>
  /** 试用中、还没告诉过她的那几条(收件箱那一句;不按种类写死,新的在前,至多 `HABIT_NOTICES_MAX` 条)。 */
  notices: () => HabitView[]
  /** 她看过那一句了(「知道了」)。 */
  seen: (id: string) => Promise<{ ok: true } | { ok: false, error: string }>
  /** 这一类事学到的默认分派(试用中 / 留下的)。 */
  dispatchDefault: (kind: JobKind, project?: string) => { family: AgentDispatchFamily, why: string, id: string } | undefined
  /** 这一刻在不在「不打电话」的时段里(回那条习惯的 id)。 */
  quietNow: (nowMs: number) => string | undefined
  /**
   * 早报学到的时刻(HH:MM)。**只在她前一天露过面的日子给**(维护者 10-09 拍板:连着不来就不白花一次模型额度,
   * 那天等她露面再照老办法开工)。
   */
  briefAt: () => string | undefined
  /** 行为账刚记了一条露面:当场算进「哪几天露过面」(不等下一次学)。 */
  noteSeen: (at: string) => void
  /**
   * 这一条审批能不能不问(回那条习惯的 id)。**沾四类的一律回 undefined**(类、命令原文、人话都查)。
   */
  noAsk: (input: { kind?: string, subject?: string, say?: string }) => string | undefined
  /** 用上了一次(看得见用了几次;「问不问」的验证也靠它认是哪件事)。 */
  applied: (id: string, where: string) => Promise<void>
}

export const HABIT_POKE_MS = 3000
/** 账里多了这几种才值得学一遍(露面那一种每天的验证在下班例程里兜底)。 */
export const HABIT_POKE_EVENTS: readonly string[] = [
  BEHAVIOR_EVENTS.dispatch, BEHAVIOR_EVENTS.redispatch, BEHAVIOR_EVENTS.decide, BEHAVIOR_EVENTS.review, BEHAVIOR_EVENTS.call,
  // 改稿不经模型,数得出来就学;「说」不在这里 —— 一句一叫会一句一问模型,攒满一批或下班例程那一遍才认。
  BEHAVIOR_EVENTS.revise,
]

export function createHabitService(options: HabitServiceOptions): HabitService {
  const now = options.now ?? (() => Date.now())
  const warn = options.log ?? ((line: string) => console.warn(line))
  let chain: Promise<unknown> = Promise.resolve()
  let timer: ReturnType<typeof setTimeout> | undefined

  const live = (): StoredHabit[] => options.store.habits().filter(habitLive)
  /** 哪几天露过面(同 `firstSeenByDay` 的去重:一天从 4 点算起)。每次学的时候刷新,露面时 `noteSeen` 补。 */
  let seenDays = new Set<string>()
  const dayStart = hhmm(DAY_STARTS_AT_HOUR * 60)
  const today = (): string => dateOf(new Date(now()))
  let styleMemory: StyleState = emptyStyleState()
  const readStyle = (): StyleState => options.store.styleState?.() ?? styleMemory
  async function writeStyle(state: StyleState): Promise<void> {
    styleMemory = state
    try { await options.store.putStyleState?.(state) }
    catch (error) { warn(`[习惯] 风格那一截没存下:${String(error)}`) }
  }

  /**
   * 把还没认的话、观察送去认(**花额度**:每天最多 `dailyCalls` 次,一次一批 `STYLE_BATCH` 句)。
   * 模型出错 = 这一批不算认过、也不算一次(多半没花出去),这一遍就停,下次再认。回认出了几条候选。
   */
  async function scanStyle(entries: readonly BehaviorEntry[], nowMs: number, full: boolean, observationsToo: boolean): Promise<number> {
    const port = options.style
    if (port === undefined) return 0
    const before = readStyle()
    const day = dateOf(new Date(nowMs))
    let state: StyleState = { ...before, calls: before.calls.day === day ? before.calls : { day, n: 0 } }
    const cap = port.dailyCalls ?? STYLE_DAILY_CALLS
    let found = 0
    let changed = false
    const fresh: StyleNote[] = []

    let pending = entries
      .filter(one => styleSayable(one) && (state.said_until === undefined || one.at > state.said_until))
      .sort((a, b) => a.at.localeCompare(b.at))
    if (full || pending.length >= STYLE_BATCH) {
      while (pending.length > 0 && state.calls.n < cap) {
        const batch = pending.slice(0, STYLE_BATCH)
        const texts = batch.map(one => one.原话 ?? '')
        let reply: string
        try { reply = await port.ask(styleExtractPrompt(texts, 'say')) }
        catch (error) { warn(`[习惯] 认风格时模型没回(这一批下次再认):${String(error)}`); break }
        state = { ...state, calls: { day, n: state.calls.n + 1 } }
        changed = true
        for (const hit of parseStyleReply(reply, texts)) {
          const entry = batch[hit.n - 1] as BehaviorEntry
          fresh.push({ at: entry.at, thing: styleThingOf(entry), candidate: hit.id, quote: hit.quote, source: '说', from: `${entry.端} · ${entry.结果} · ${entry.对象}` })
        }
        state = { ...state, said_until: (batch[batch.length - 1] as BehaviorEntry).at }
        pending = pending.slice(batch.length)
      }
    }

    if (observationsToo && port.observations !== undefined) {
      let markdown: string | undefined
      try { markdown = await port.observations() }
      catch { markdown = undefined }
      const seen = new Set(state.observed)
      let lines = observationLines(markdown ?? '').filter(one => !seen.has(one.key))
      while (lines.length > 0 && state.calls.n < cap) {
        const batch = lines.slice(0, STYLE_BATCH)
        const texts = batch.map(one => one.text)
        let reply: string
        try { reply = await port.ask(styleExtractPrompt(texts, 'observation')) }
        catch (error) { warn(`[习惯] 认观察时模型没回(下次再认):${String(error)}`); break }
        state = { ...state, calls: { day, n: state.calls.n + 1 } }
        changed = true
        for (const hit of parseStyleReply(reply, texts)) {
          const line = batch[hit.n - 1] as (typeof batch)[number]
          const [y, m, d] = (line.date ?? '').split('-').map(Number)
          const at = line.date === undefined ? new Date(nowMs).toISOString() : new Date(y as number, (m as number) - 1, d as number, 12).toISOString()
          fresh.push({ at, thing: `观察 ${line.key}`, candidate: hit.id, quote: hit.quote, source: '观察', from: `事务官记忆「观察」${line.date ?? ''}`.trim() })
        }
        state = { ...state, observed: [...state.observed, ...batch.map(one => one.key)].slice(-STYLE_OBSERVED_MAX) }
        lines = lines.slice(batch.length)
      }
    }

    if (fresh.length > 0) {
      const from = nowMs - 90 * 86_400_000
      state = { ...state, notes: [...state.notes, ...fresh].filter(one => Date.parse(one.at) >= from).slice(-STYLE_NOTES_MAX) }
      found = fresh.length
    }
    if (changed || fresh.length > 0) await writeStyle(state)
    return found
  }

  async function writeLog(change: (text: string | undefined) => string | undefined): Promise<void> {
    const workdir = options.workdir
    if (workdir === undefined || workdir === '' || options.io === undefined) return
    try {
      const file = evolveLogPath(workdir)
      const next = change(await options.io.readFile(file))
      if (next !== undefined) await options.io.writeFile(file, next)
    }
    catch (error) { warn(`[习惯] 进化日志写不下(习惯照记):${String(error)}`) }
  }

  async function annotate(habit: StoredHabit): Promise<void> {
    await writeLog((text) => {
      const marked = annotateLog(text, habit.id, habitVerdictLine(habit, today()))
      return marked.marked ? marked.text : undefined
    })
  }

  async function learnOnce(opts: HabitLearnOptions = {}): Promise<{ adopted: number, kept: number, reverted: number, note: string }> {
    const nowMs = now()
    const since = new Date(nowMs - HABIT_WINDOW_DAYS * 86_400_000).toISOString()
    let entries: BehaviorEntry[]
    try { entries = await options.behavior.read({ since }) }
    catch { return { adopted: 0, kept: 0, reverted: 0, note: '行为账读不出来,这次没学' } }
    seenDays = new Set(firstSeenByDay(entries, dayStart).keys())
    await scanStyle(entries, nowMs, opts.style === true, opts.style === true)
    const style = readStyle()
    const styleNotes = [...style.notes, ...styleNotesOfRevisions(entries)]
    let habits = [...options.store.habits()]
    const settled: StoredHabit[] = []
    habits = habits.map((habit) => {
      if (habit.status !== 'trial') return habit
      const verdict = habit.kind === 'style'
        ? verifyStyleHabit(habit, styleNotes, entries, style.said_until)
        : verifyHabit(habit, entries, nowMs)
      if (verdict.status === 'trial') return habit
      const next = { ...habit, status: verdict.status, verdict: verdict.why, updated_at: new Date(nowMs).toISOString() }
      settled.push(next)
      return next
    })
    const morning = options.morning?.()
    const fresh = [
      ...findDispatchHabits(entries, habits, nowMs),
      ...findQuietHabits(entries, habits, nowMs),
      ...findNoAskHabits(entries, habits, nowMs),
      ...findStyleHabits(styleNotes, habits, nowMs),
      ...(() => { const one = morning === undefined ? undefined : findBriefHabit(entries, habits, nowMs, morning); return one === undefined ? [] : [one] })(),
    ]
    habits = [...habits, ...fresh]
    if (settled.length + fresh.length > 0) {
      await options.store.putHabits(habits)
      for (const habit of settled) await annotate(habit)
      for (const habit of fresh) await writeLog(text => appendLog(text, habitLogEntry(habit, today())))
      options.onChanged?.()
    }
    const kept = settled.filter(one => one.status === 'kept').length
    const reverted = settled.length - kept
    const notes: string[] = []
    if (fresh.length > 0) notes.push(`试用 ${fresh.length} 条习惯`)
    if (kept > 0) notes.push(`${kept} 条验过了,留下`)
    if (reverted > 0) notes.push(`${reverted} 条她纠正了,撤了`)
    return { adopted: fresh.length, kept, reverted, note: notes.length === 0 ? '没有新的习惯,试用中的也还没验出结果' : notes.join(';') }
  }

  function learn(opts?: HabitLearnOptions): Promise<{ adopted: number, kept: number, reverted: number, note: string }> {
    const once = (): ReturnType<typeof learnOnce> => learnOnce(opts)
    const run = chain.then(once, once)
    chain = run.catch(() => undefined)
    return run
  }

  async function learnObservations(): Promise<{ ok: boolean, candidates: number, adopted: number, note: string }> {
    if (options.style?.observations === undefined) return { ok: false, candidates: 0, adopted: 0, note: '不知道事务官的工作目录在哪,或者没接上模型,读不了「观察」' }
    const before = readStyle().notes.filter(one => one.source === '观察').length
    const done = await learn({ style: true })
    const candidates = readStyle().notes.filter(one => one.source === '观察').length - before
    const head = candidates === 0 ? '「观察」里这次没认出新的风格候选' : `「观察」里认出 ${candidates} 条风格候选(不同的两件事上都出现才试用)`
    return { ok: true, candidates, adopted: done.adopted, note: `${head};${done.note}。观察不再直接导成规矩。` }
  }

  return {
    async load() { /* 表由规矩表那一份读;这里留着与别的服务同一个起法 */ },

    learn,

    learnObservations,

    poke() {
      if (timer !== undefined) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = undefined
        learn().catch(error => warn(`[习惯] 学的时候出错(不影响业务):${String(error)}`))
      }, HABIT_POKE_MS)
      timer.unref?.()
    },

    view: () => habitsView(options.store.habits()),

    async revoke(id) {
      const habit = options.store.habits().find(one => one.id === id)
      if (habit === undefined) return { ok: false, error: '没有这条习惯' }
      if (!habitLive(habit)) return { ok: false, error: '这条已经撤过了' }
      const at = new Date(now()).toISOString()
      const next: StoredHabit = { ...habit, status: 'removed', verdict: '她点了撤掉', updated_at: at, noticed_at: habit.noticed_at ?? at }
      await options.store.putHabits(options.store.habits().map(one => (one.id === id ? next : one)))
      await annotate(next)
      options.onChanged?.()
      return { ok: true, habit: habitView(next), note: `撤掉了:「${habit.text}」,以后不再照做,也不会再自己学回来。撤错了在「它学到了什么」里点「恢复」。` }
    },

    async restore(id) {
      const habits = options.store.habits()
      const habit = habits.find(one => one.id === id)
      if (habit === undefined) return { ok: false, error: '没有这条习惯' }
      if (habitLive(habit)) return { ok: false, error: '这条还在算数,不用恢复' }
      const clash = habits.find(one => one.id !== id && one.kind === habit.kind && one.类 === habit.类 && habitLive(one))
      if (clash !== undefined) return { ok: false, error: `同一类正在照「${clash.text}」做,先撤掉那条再恢复这条` }
      const at = new Date(now()).toISOString()
      const { verdict: _old, ...rest } = habit
      const next: StoredHabit = { ...rest, status: 'trial', adopted_at: at, updated_at: at, noticed_at: at }
      await options.store.putHabits(habits.map(one => (one.id === id ? next : one)))
      await writeLog((text) => {
        const marked = annotateLog(text, next.id, habitRestoredLine(next, today()))
        return marked.marked ? marked.text : undefined
      })
      options.onChanged?.()
      return { ok: true, habit: habitView(next), note: `恢复了:「${habit.text}」,重新试用,下一次同类的事照常验证。` }
    },

    notices: () => options.store.habits()
      .filter(one => one.status === 'trial' && one.noticed_at === undefined)
      .sort((a, b) => b.adopted_at.localeCompare(a.adopted_at))
      .slice(0, HABIT_NOTICES_MAX)
      .map(habitView),

    async seen(id) {
      const habit = options.store.habits().find(one => one.id === id)
      if (habit === undefined) return { ok: false, error: '没有这条习惯' }
      if (habit.noticed_at !== undefined) return { ok: true }
      const next: StoredHabit = { ...habit, noticed_at: new Date(now()).toISOString() }
      await options.store.putHabits(options.store.habits().map(one => (one.id === id ? next : one)))
      options.onChanged?.()
      return { ok: true }
    },

    dispatchDefault(kind, project) {
      const klass = dispatchClassOf(kind, project)
      const habit = live().find(one => one.kind === 'dispatch' && one.类 === klass)
      if (habit === undefined || !isAgentDispatchFamily(habit.value)) return undefined
      const state = habit.status === 'trial' ? '试用中' : '验过了'
      return { family: habit.value, id: habit.id, why: `按你的习惯(${state}):「${klass}」这类事你改派过 ${dispatchFamilyTitle(habit.value)}` }
    },

    quietNow(nowMs) {
      const hour = new Date(nowMs).getHours()
      return live().find(one => one.kind === 'quiet' && Number(one.value) === hour)?.id
    },

    briefAt() {
      const morning = options.morning?.()
      if (morning?.at !== undefined && morning.at !== '') return undefined
      const at = live().find(one => one.kind === 'brief')?.value
      if (at === undefined) return undefined
      return seenDays.has(dayKeyOf(now() - 86_400_000)) ? at : undefined
    },

    noteSeen(at) {
      const day = firstSeenByDay([{ at, 端: '电脑', 事: BEHAVIOR_EVENTS.seen, 对象: '', 结果: '' }], dayStart)
      for (const key of day.keys()) seenDays.add(key)
    },

    noAsk(input) {
      const klass = input.kind ?? ''
      if (!noAskLearnable(klass)) return undefined
      if (fourKindOf(`${input.subject ?? ''}\n${input.say ?? ''}`) !== undefined) return undefined
      return live().find(one => one.kind === 'noask' && one.类 === klass)?.id
    },

    async applied(id, where) {
      const habit = options.store.habits().find(one => one.id === id)
      if (habit === undefined) return
      const next: StoredHabit = { ...habit, applied: [...habit.applied, { at: new Date(now()).toISOString(), where }].slice(-HABIT_APPLIED_MAX) }
      try { await options.store.putHabits(options.store.habits().map(one => (one.id === id ? next : one))) }
      catch (error) { warn(`[习惯] 「用上了」没记下:${String(error)}`) }
    },
  }
}
