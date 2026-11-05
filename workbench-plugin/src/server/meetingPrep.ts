/**
 * 会议「会前」那一段的纯函数(2026-10-10,卡「会前画像与预案」)。
 * 设计:`docs/设计-会议模式目标与验收-2026-09-27.md` 第三节(五问、目的说不清先拦、预案卡)与第六节(花名制)。
 *
 * 几条纪律,都在这个文件里兑现:
 *
 * 1. **认不出的不猜**。登记那一句只按她说出来的词认(「客户」→ 外部、「例会」→ 例会、「要敲定…」→ 要定什么);
 *    「谈」不等于谈判会,「三点」不说上午下午就不填几点。花名档案里的记录能认的才填,并写明依据。
 *    五问的认法全是词表,不经模型。
 * 2. **参会人只记花名**。花名里像电话、邮箱的一律不收;档案(`StoredPerson`)只有花名、角色、上次哪场会。
 * 3. **预案卡的数只从她的数据里来**。代码先从账号数据、复盘、选题池、看板里拼一张带出处的事实表,
 *    模型只能引编号;数由代码按编号原样填。说法里冒出表里没有的数,那一条整条不要。
 * 4. **对外的只拟不发**。目的说不清时替她拟一句去问组织者的话,这里没有任何发送的能力。
 */
import type {
  MeetingCardQuestionView,
  MeetingCardStatus,
  MeetingPersonView,
  MeetingPrepAnswer,
  MeetingPrepAsk,
  MeetingPrepFrom,
  MeetingPrepQuestionId,
  MeetingPrepView,
} from '../protocol.ts'
import { TOPIC_STAGES } from '../protocol.ts'
import { localDateStr } from './brief.ts'

/** 目的说不清时替她拟的那句话(设计第三节第 2 条原话)。 */
export const MEETING_ORGANIZER_ASK = '这次会主要想定哪几件事?我好提前准备。'

/** 预案卡最多几条。 */
export const MEETING_CARD_MAX = 5

/** 预案卡退路的缺省那句。 */
export const MEETING_CARD_FALLBACK = '这个我会后给您补一份。'

export interface StoredMeetingPrep {
  said: string
  when?: string
  scheduled_at?: string
  /** 那句话里认出的花名(去掉空白)。 */
  aliases: string[]
  scope?: MeetingPrepAnswer<'内部' | '外部'>
  kind?: MeetingPrepAnswer<string>
  people?: MeetingPrepAnswer<MeetingPersonView[]>
  decider?: MeetingPrepAnswer<string>
  my_role?: MeetingPrepAnswer<string>
  goal?: MeetingPrepAnswer<string>
  goal_unclear?: true
  /** 目的还没说清,她点了「先照现在的准备」。 */
  proceed?: true
  card?: { made_at: string, questions: MeetingCardQuestionView[] }
  card_error?: string
}

/* ——— 时间 ——— */

const CN_DIGITS: Record<string, number> = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }

/**
 * 「十一」「两」「12」→ 数。认不出回 NaN。
 *
 * 中文数字那张表的**主人在这里**(2026-10-13:排发布计划那一句里的「十八号」也用它,`publishPlan.ts`)。
 */
export function cnNumberOf(raw: string): number {
  if (/^\d+$/.test(raw)) return Number.parseInt(raw, 10)
  if (raw.includes('十')) {
    const [before = '', after = ''] = raw.split('十')
    const tens = before === '' ? 1 : (CN_DIGITS[before] ?? Number.NaN)
    const ones = after === '' ? 0 : (CN_DIGITS[after] ?? Number.NaN)
    return tens * 10 + ones
  }
  return raw.length === 1 ? (CN_DIGITS[raw] ?? Number.NaN) : Number.NaN
}

const WEEKDAYS = '一二三四五六日'
const DAY_RE = /(今天|今儿|明天|明儿|后天|大后天|(下下?)?(?:周|星期|礼拜)([一二三四五六日天])|(\d{1,2})月(\d{1,2})[日号])/
const PART_RE = /(早上|上午|中午|下午|傍晚|晚上)/
const CN_NUM = '[零一二两三四五六七八九十]{1,3}'
const CLOCK_RE = new RegExp(`(\\d{1,2}|${CN_NUM})(?:[:：](\\d{2})|点(?:(半)|(一刻)|(三刻)|(\\d{1,2}|${CN_NUM})分?)?)`)

export interface MeetingWhen {
  /** 原话里那一截(「下午三点」)。 */
  phrase?: string
  /** 哪天(本地日期)。没说哪天就是今天。 */
  date: string
  /** 能确定到几点几分才有。 */
  at?: number
}

/** 「下午三点」「明天上午10:30」「下周二」→ 哪天、几点。几点说不清就只给哪天。 */
export function parseMeetingWhen(text: string, now: number): MeetingWhen {
  const hits: { index: number, end: number, kind: 'day' | 'part' | 'clock', m: RegExpMatchArray }[] = []
  for (const [kind, re] of [['day', DAY_RE], ['part', PART_RE], ['clock', CLOCK_RE]] as const) {
    const m = text.match(re)
    if (m?.index !== undefined) hits.push({ index: m.index, end: m.index + m[0].length, kind, m })
  }
  hits.sort((a, b) => a.index - b.index)
  // 只认挨在一起的那一截(中间最多隔一个空白):「明天上午10:30」是一截,散在句子两头的不拼。
  const run: typeof hits = []
  for (const hit of hits) {
    const last = run[run.length - 1]
    if (last === undefined || /^\s?$/.test(text.slice(last.end, hit.index))) run.push(hit)
    else break
  }
  const today = new Date(now)
  if (run.length === 0) return { date: localDateStr(now) }
  const day = run.find(h => h.kind === 'day')?.m
  const part = run.find(h => h.kind === 'part')?.m[1]
  const clock = run.find(h => h.kind === 'clock')?.m

  const base = new Date(today.getFullYear(), today.getMonth(), today.getDate())
  if (day !== undefined) {
    const word = day[1] ?? ''
    if (word === '明天' || word === '明儿') base.setDate(base.getDate() + 1)
    else if (word === '后天') base.setDate(base.getDate() + 2)
    else if (word === '大后天') base.setDate(base.getDate() + 3)
    else if (day[3] !== undefined) {
      const target = day[3] === '天' ? 7 : WEEKDAYS.indexOf(day[3]) + 1 // 周一 = 1 … 周日 = 7
      const todayIso = base.getDay() === 0 ? 7 : base.getDay()
      if (day[2] === undefined) base.setDate(base.getDate() + ((target - todayIso + 7) % 7))
      else base.setDate(base.getDate() + (7 - todayIso + 1) + (target - 1) + (day[2] === '下下' ? 7 : 0))
    }
    else if (day[4] !== undefined && day[5] !== undefined) {
      base.setMonth(Number.parseInt(day[4], 10) - 1, Number.parseInt(day[5], 10))
      if (base.getTime() < new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()) base.setFullYear(base.getFullYear() + 1)
    }
  }
  const phrase = text.slice(run[0]!.index, run[run.length - 1]!.end).trim()
  const result: MeetingWhen = { phrase, date: localDateStr(base.getTime()) }
  if (clock === undefined) return result
  let hour = cnNumberOf(clock[1] ?? '')
  const minute = clock[2] !== undefined ? Number.parseInt(clock[2], 10)
    : clock[3] !== undefined ? 30
      : clock[4] !== undefined ? 15
        : clock[5] !== undefined ? 45
          : clock[6] !== undefined ? cnNumberOf(clock[6]) : 0
  if (!Number.isFinite(hour) || hour > 24 || !Number.isFinite(minute) || minute > 59) return result
  if (part === undefined) {
    // 不说上午下午:只有 13 点以后的写法是确定的,「三点」不猜。
    if (hour < 13) return result
  }
  else if ((part === '下午' || part === '傍晚' || part === '晚上') && hour < 12) hour += 12
  else if (part === '中午' && hour <= 2) hour += 12
  base.setHours(hour, minute, 0, 0)
  return { ...result, at: base.getTime() }
}

/* ——— 认这一句是不是在登记一场会 ——— */

const MEETING_CUE = /开会|会议|例会|周会|晨会|月会|早会|碰头|碰一下|短会|汇报|评审|述职|谈判|开个会|(?:跟|和|与|同).{1,15}?(?:谈|聊|开会|碰|对一下|过一下|见面)/
const NOT_A_PLAN = /提醒我|叫我|打电话|[??]\s*$|吗\s*$/

/** 这句话像不像「登记一场会」:得说了时间,又有开会的词;提醒、问话不算。宁可漏认(漏了照旧建事项)。 */
export function looksLikeMeetingPlan(text: string, now: number): boolean {
  const said = text.trim()
  if (said === '' || said.length > 120 || NOT_A_PLAN.test(said)) return false
  if (parseMeetingWhen(said, now).phrase === undefined) return false
  return MEETING_CUE.test(said)
}

/* ——— 登记 ——— */

const EXTERNAL_RE = /客户|品牌|甲方|乙方|合作方|供应商|投资人|商家|平台方|MCN|机构/
const INTERNAL_RE = /组里|组内|团队|同事|内部|例会|周会|晨会|月会|早会|部门/

const KIND_WORDS: readonly (readonly [string, RegExp])[] = [
  ['例会', /例会|周会|晨会|月会|早会/],
  ['汇报会', /汇报|述职|评审/],
  ['谈判会', /谈判/],
  ['临时短会', /碰头|碰一下|短会|过一下/],
  ['专题会', /专题|头脑风暴/],
]
export const MEETING_KINDS: readonly string[] = ['例会', '专题会', '汇报会', '谈判会', '临时短会']
export const MEETING_MY_ROLES: readonly string[] = ['汇报人', '主持人', '参与者', '被拉来听的']

const GOAL_RE = /(敲定|定下|确定|拿到|批下|签下|定个|谈妥|争取到)([^,,。;;!!]+)/
const ALIAS_RES = [
  /(?:跟|和|与|同)\s*([^,,。;;]{1,14}?)\s*(?:再|又|先|一起|好好)?\s*(?:谈|聊|开会|开个会|碰|对一下|过一下|见面|汇报|开)/,
  /给\s*([^,,。;;]{1,10}?)\s*(?:汇报|讲|过)/,
]
/** 花名里不许出现联系方式:长串数字、邮箱、微信号这种字眼。 */
const CONTACT_RE = /\d{6,}|@|微信|手机号|电话|邮箱/

function normalizeAlias(raw: string): string {
  return raw.replace(/\s+/g, '')
}

function aliasesOf(text: string): string[] {
  for (const re of ALIAS_RES) {
    const m = text.match(re)
    if (m?.[1] === undefined) continue
    const names = m[1].split(/和|、|与|跟|及/).map(normalizeAlias).filter(name => name !== '' && name.length <= 10 && !CONTACT_RE.test(name))
    if (names.length > 0) return [...new Set(names)]
  }
  return []
}

export interface MeetingPlanDraft {
  title: string
  date: string
  prep: StoredMeetingPrep
}

/** 一句话 → 一场待开的会:标题、哪天、那句话里认得出的几问。 */
export function draftMeetingPlan(text: string, now: number): MeetingPlanDraft {
  const said = text.trim()
  const when = parseMeetingWhen(said, now)
  const rest = when.phrase === undefined ? said : said.replace(when.phrase, '')
  const title = (rest.replace(/^[\s,,。、]+/, '').split(/[,,。;;\n]/)[0] ?? '').trim() || said
  const prep: StoredMeetingPrep = {
    said,
    ...(when.phrase === undefined ? {} : { when: when.phrase }),
    ...(when.at === undefined ? {} : { scheduled_at: new Date(when.at).toISOString() }),
    aliases: aliasesOf(said),
  }
  const external = EXTERNAL_RE.test(said)
  const internal = INTERNAL_RE.test(said)
  if (external !== internal) prep.scope = { value: external ? '外部' : '内部', from: 'said' }
  const kind = KIND_WORDS.find(([, re]) => re.test(said))
  if (kind !== undefined) prep.kind = { value: kind[0], from: 'said' }
  const goal = said.match(GOAL_RE)
  if (goal !== null) prep.goal = { value: `${goal[1]}${goal[2]}`.trim(), from: 'said' }
  return { title: title.slice(0, 40), date: when.date, prep }
}

/* ——— 一问一答 ——— */

/** 此刻该问哪一问。五问齐了(或目的说不清、先拦着)就没有。 */
export function nextPrepAsk(prep: StoredMeetingPrep): MeetingPrepAsk | undefined {
  if (prep.scope === undefined) {
    return { id: 'scope', text: '这是内部会还是外部会?', choices: ['内部', '外部'], hint: '内部 = 自己团队;外部 = 品牌方、客户、平台' }
  }
  if (prep.kind === undefined) return { id: 'kind', text: '什么类型的会?', choices: MEETING_KINDS }
  if (prep.people === undefined) {
    const named = prep.aliases.length === 0 ? '' : `你那句话里提到:${prep.aliases.join('、')}。`
    return { id: 'people', text: '谁来,各自什么角色?谁拍板?', hint: `${named}只写花名,不写真名和联系方式。例:「B 客户拍板,小鱼执行」` }
  }
  if (prep.decider === undefined) {
    return { id: 'decider', text: '那这场谁拍板?', choices: [...prep.people.value.map(p => p.alias), '我', '还没定'] }
  }
  if (prep.my_role === undefined) return { id: 'my_role', text: '你在这场会上是什么角色?', choices: MEETING_MY_ROLES }
  if (prep.goal === undefined && prep.goal_unclear !== true) {
    return { id: 'goal', text: '这场会要定下什么?散会时你应该拿到什么?', choices: ['说不清'], hint: '一个决定、一笔预算,还是一句「可以」' }
  }
  return undefined
}

export type PrepAnswerResult = { ok: true, prep: StoredMeetingPrep } | { ok: false, error: string }

const ROLE_WORDS: readonly (readonly [string, RegExp])[] = [
  ['拍板', /拍板|说了算|定夺|决定/],
  ['有影响力', /有影响力|影响/],
  ['执行', /执行|干活|落地|负责做/],
  ['对面的人', /对面|对方/],
  ['旁听', /旁听|听着|列席/],
]
const UNCLEAR_RE = /说不清|不知道|不清楚|没说|不确定|没想好|不晓得|^不明/
const CONTACT_ERROR = '花名里不记联系方式(电话、邮箱、微信号),换个只有你认得的叫法。'

function parsePeople(answer: string): { people: MeetingPersonView[], me?: true } | { error: string } {
  const people: MeetingPersonView[] = []
  let me: true | undefined
  for (const raw of answer.split(/[,,、;;\n]|以及/)) {
    const part = raw.trim()
    if (part === '') continue
    if (CONTACT_RE.test(part)) return { error: CONTACT_ERROR }
    const role = ROLE_WORDS.find(([, re]) => re.test(part))
    const alias = normalizeAlias((role === undefined ? part : part.replace(role[1], ''))
      .replace(/(是|来|负责|的人|的)$/, '').replace(/^(还有|和|跟)/, ''))
    if (alias === '') continue
    if (alias === '我') { if (role?.[0] === '拍板') me = true; continue }
    const person: MeetingPersonView = { alias: alias.slice(0, 10), ...(role === undefined ? {} : { role: role[0] }), ...(role?.[0] === '拍板' ? { decides: true as const } : {}) }
    const at = people.findIndex(p => p.alias === person.alias)
    if (at >= 0) people[at] = person
    else people.push(person)
  }
  if (people.length === 0 && me === undefined) return { error: '没听出谁来。用花名说,比如「B 客户拍板,小鱼执行」。' }
  return { people, ...(me === undefined ? {} : { me }) }
}

function pick(answer: string, options: readonly string[], keys: readonly RegExp[]): string {
  const at = keys.findIndex(re => re.test(answer))
  return at >= 0 ? options[at]! : answer.slice(0, 12)
}

/** 她答了一问。可以重答已经填过的(那就是「改」),答案一律记成「你答的」。 */
export function answerPrep(prep: StoredMeetingPrep, id: MeetingPrepQuestionId, raw: string): PrepAnswerResult {
  const answer = raw.trim()
  if (answer === '') return { ok: false, error: '没听到答案' }
  const next: StoredMeetingPrep = { ...prep }
  const asked = <T>(value: T): MeetingPrepAnswer<T> => ({ value, from: 'asked' as MeetingPrepFrom })
  switch (id) {
    case 'scope': {
      if (/外/.test(answer)) next.scope = asked('外部' as const)
      else if (/内/.test(answer)) next.scope = asked('内部' as const)
      else return { ok: false, error: '内部会还是外部会?选一个。' }
      break
    }
    case 'kind': {
      next.kind = asked(pick(answer, MEETING_KINDS, [/例会|周会/, /专题/, /汇报|评审/, /谈判/, /短会|碰头|临时/]))
      break
    }
    case 'people': {
      const got = parsePeople(answer)
      if ('error' in got) return { ok: false, error: got.error }
      next.people = asked(got.people)
      const decides = got.people.find(p => p.decides === true)
      if (got.me === true) next.decider = asked('我')
      else if (decides !== undefined) next.decider = asked(decides.alias)
      else delete next.decider
      break
    }
    case 'decider': {
      if (CONTACT_RE.test(answer)) return { ok: false, error: CONTACT_ERROR }
      if (/^我/.test(answer)) { next.decider = asked('我'); break }
      if (/没定|不知道|不清楚|还没/.test(answer)) { next.decider = asked('还没定'); break }
      const alias = normalizeAlias(answer).slice(0, 10)
      const people = [...(next.people?.value ?? [])].map(p => (p.alias === alias ? { ...p, role: '拍板', decides: true as const } : p))
      if (!people.some(p => p.alias === alias)) people.push({ alias, role: '拍板', decides: true })
      next.people = { ...(next.people ?? asked([])), value: people }
      next.decider = asked(alias)
      break
    }
    case 'my_role': {
      next.my_role = asked(pick(answer, MEETING_MY_ROLES, [/汇报/, /主持/, /参与|参加/, /听/]))
      break
    }
    case 'goal': {
      if (UNCLEAR_RE.test(answer)) {
        delete next.goal
        next.goal_unclear = true
      }
      else {
        next.goal = asked(answer.slice(0, 80))
        delete next.goal_unclear
        delete next.proceed
      }
      break
    }
    default: return { ok: false, error: '不认识这一问' }
  }
  return { ok: true, prep: next }
}

/* ——— 花名档案(用户层,只在她电脑上)——— */

export interface StoredPerson {
  alias: string
  role?: string
  decides?: true
  /** 上次那场会是内部还是外部。 */
  scope?: '内部' | '外部'
  last_meeting: { id: string, title: string, date: string }
  updated_at: string
}

export interface MeetingPeopleFile { version: 1, people: StoredPerson[] }

/** 她答完「谁来」之后记一笔(同一个花名覆盖上一笔)。「我」不进档案。 */
export function upsertPeople(
  file: MeetingPeopleFile,
  people: readonly MeetingPersonView[],
  meeting: { id: string, title: string, date: string, scope?: '内部' | '外部' },
  now: number,
): void {
  for (const person of people) {
    if (person.alias === '我' || person.alias === '' || CONTACT_RE.test(person.alias)) continue
    const entry: StoredPerson = {
      alias: person.alias,
      ...(person.role === undefined ? {} : { role: person.role }),
      ...(person.decides === true ? { decides: true as const } : {}),
      ...(meeting.scope === undefined ? {} : { scope: meeting.scope }),
      last_meeting: { id: meeting.id, title: meeting.title, date: meeting.date },
      updated_at: new Date(now).toISOString(),
    }
    const at = file.people.findIndex(p => p.alias === person.alias)
    if (at >= 0) file.people[at] = entry
    else file.people.push(entry)
  }
}

/**
 * 花名档案里认得出的就填,写明依据。**那句话里提到的花名有一个没见过,就不从记录填谁来**
 * (认不全等于猜)。填的只是「上次」的样子,她可以改。
 */
export function fillFromRecords(prep: StoredMeetingPrep, file: MeetingPeopleFile): StoredMeetingPrep {
  if (prep.aliases.length === 0) return prep
  const known = prep.aliases.map(alias => file.people.find(p => p.alias === alias))
  if (known.some(p => p === undefined)) return prep
  const people = known as StoredPerson[]
  const latest = [...people].sort((a, b) => b.last_meeting.date.localeCompare(a.last_meeting.date))[0]!
  const basis = `花名档案:上次「${latest.last_meeting.title}」(${latest.last_meeting.date})`
  const record = <T>(value: T): MeetingPrepAnswer<T> => ({ value, from: 'record', basis })
  const next: StoredMeetingPrep = { ...prep }
  if (next.people === undefined) {
    next.people = record(people.map(p => ({ alias: p.alias, ...(p.role === undefined ? {} : { role: p.role }), ...(p.decides === true ? { decides: true as const } : {}) })))
    const decides = people.find(p => p.decides === true)
    if (next.decider === undefined && decides !== undefined) next.decider = record(decides.alias)
  }
  const scopes = new Set(people.map(p => p.scope))
  if (next.scope === undefined && scopes.size === 1) {
    const scope = [...scopes][0]
    if (scope !== undefined) next.scope = record(scope)
  }
  return next
}

/* ——— 预案卡 ——— */

export interface MeetingFact {
  id: string
  /** 原样那一句(带数)。 */
  text: string
  /** 出处。 */
  source: string
}

export interface MeetingFactsInput {
  now: number
  xhs?: readonly { name: string, ranges: readonly { range: string, date: string, metrics: readonly { label: string, raw?: string }[] }[] }[]
  accounts?: readonly { name: string, notes?: number, goal?: string }[]
  reviews?: readonly { topic: string, line: string, date?: string }[]
  tasks?: readonly { id: string, title: string, status: string, kind?: string, stage?: string, due?: string, done_at?: string, published_at?: string }[]
  /** 跟这场会有关的词(花名等):看板上标题里带这些词的事项单列出来。 */
  keywords?: readonly string[]
}

const FACTS_MAX = 40
const STATUS_TITLES: Record<string, string> = { doing: '进行中', todo: '待办', backlog: '待办', confirm: '等你确认', blocked: '卡住', done: '办完了', canceled: '取消了' }

/** 她自己的数据 → 一张带出处的事实表。**只照抄,不算新数**(合计等由各自的服务算好再给)。 */
export function meetingFactsOf(input: MeetingFactsInput): MeetingFact[] {
  const rows: Omit<MeetingFact, 'id'>[] = []
  for (const account of input.xhs ?? []) {
    for (const range of account.ranges) {
      const parts = range.metrics.filter(m => m.raw !== undefined && m.raw !== '').map(m => `${m.label} ${m.raw!}`)
      if (parts.length > 0) rows.push({ text: `账号「${account.name}」${range.range}:${parts.join('、')}`, source: `小红书创作者数据(${range.date} 取)` })
    }
  }
  for (const account of input.accounts ?? []) {
    if (account.notes !== undefined) rows.push({ text: `账号「${account.name}」已发笔记 ${account.notes} 篇`, source: `账号/${account.name}/笔记/` })
    if (account.goal !== undefined && account.goal !== '') rows.push({ text: `账号「${account.name}」的目标:${account.goal}`, source: `账号/${account.name}/目标.md` })
  }
  for (const review of input.reviews ?? []) {
    rows.push({ text: `选题「${review.topic}」复盘:${review.line}`, source: `选题/${review.topic}/复盘.md${review.date === undefined ? '' : `(${review.date})`}` })
  }
  const live = (input.tasks ?? []).filter(t => t.status !== 'canceled')
  const topics = live.filter(t => t.kind === 'topic')
  if (topics.length > 0) {
    const stages = TOPIC_STAGES.map(stage => [stage, topics.filter(t => t.stage === stage).length] as const).filter(([, n]) => n > 0)
    const monthAgo = input.now - 30 * 24 * 3600 * 1000
    const published = topics.filter(t => t.published_at !== undefined && Date.parse(t.published_at) >= monthAgo).length
    const pool = stages.map(([stage, n]) => `${stage} ${n} 条`).join('、')
    rows.push({ text: `选题池:${pool === '' ? `共 ${topics.length} 条` : pool};近 30 天发布 ${published} 条`, source: '看板 · 选题池' })
  }
  const work = live.filter(t => t.kind !== 'topic')
  if (work.length > 0) {
    const counts = (['doing', 'todo', 'confirm', 'blocked'] as const)
      .map(status => [status, work.filter(t => t.status === status || (status === 'todo' && t.status === 'backlog')).length] as const)
      .filter(([, n]) => n > 0)
      .map(([status, n]) => `${STATUS_TITLES[status]} ${n} 件`)
    const weekAgo = input.now - 7 * 24 * 3600 * 1000
    const done = work.filter(t => t.status === 'done' && t.done_at !== undefined && Date.parse(t.done_at) >= weekAgo).length
    rows.push({ text: `看板上:${counts.length === 0 ? '没有在办的' : counts.join('、')};近 7 天办完 ${done} 件`, source: '看板' })
  }
  const keywords = (input.keywords ?? []).filter(word => word.length >= 2)
  if (keywords.length > 0) {
    const related = live.filter(t => keywords.some(word => normalizeAlias(t.title).includes(word))).slice(0, 8)
    for (const task of related) {
      rows.push({ text: `看板事项「${task.title}」:${STATUS_TITLES[task.status] ?? task.status}${task.due === undefined ? '' : `,期限 ${task.due}`}`, source: '看板事项' })
    }
  }
  return rows.slice(0, FACTS_MAX).map((row, i) => ({ id: `f${i + 1}`, ...row }))
}

function personLine(people: readonly MeetingPersonView[]): string {
  return people.map(p => (p.role === undefined ? p.alias : `${p.alias}(${p.role})`)).join('、')
}

/** 做预案卡那一次模型调用的提示。 */
export function buildCardPrompt(meeting: { title: string, prep: StoredMeetingPrep }, facts: readonly MeetingFact[]): string {
  const { prep } = meeting
  const portrait = [
    `会:${meeting.title}${prep.when === undefined ? '' : `(${prep.when})`}`,
    `她登记时的原话:「${prep.said}」`,
    `内部还是外部:${prep.scope?.value ?? '没说'}`,
    `类型:${prep.kind?.value ?? '没说'}`,
    `谁来(都是花名):${prep.people === undefined ? '没说' : personLine(prep.people.value) || '没说'}`,
    `谁拍板:${prep.decider?.value ?? '没说'}`,
    `她的角色:${prep.my_role?.value ?? '没说'}`,
    `这场会要定下什么:${prep.goal?.value ?? '她还没问清(准备时别替她假定一个目的)'}`,
  ]
  const table = facts.length === 0
    ? '(她这边一条数据都没有)'
    : facts.map(f => `${f.id} | ${f.text} | 出处:${f.source}`).join('\n')
  return [
    '你在替她准备一场会的预案卡。下面是这场会的画像和她自己的数据。',
    '',
    ...portrait,
    '',
    '她自己的数据(只能按编号引用,不许写表外的数):',
    table,
    '',
    `任务:列出这场会上她最可能被问到的 3~${MEETING_CARD_MAX} 个问题,拍板人最可能问的排前面。每个问题给:`,
    '- fact:最能回答它的那条数据的编号(如 "f1");表里没有能回答的就填 null,不要硬凑。',
    '- line:一两句话怎么接(口语,第一人称)。**不许写任何表里没有的数字**;要提数就照抄那条数据里的数。',
    `- fallback:一句退路,比如「${MEETING_CARD_FALLBACK}」。`,
    '只输出一个 JSON 数组,不要别的字:[{"q":"…","fact":"f1" 或 null,"line":"…","fallback":"…"}]',
  ].join('\n')
}

const NUMBER_TOKEN = /\d+(?:\.\d+)?/g

function numberTokens(text: string): string[] {
  return text.match(NUMBER_TOKEN) ?? []
}

/**
 * 模型的回话 → 预案卡。**数由代码按编号填**;问题、说法、退路里冒出一个出处(和画像)里没有的数,那一条整条不要。
 * `context` 是画像里她自己说过的字(原话、标题、要定什么),那里面的数可以出现。
 */
export function parseCardReply(reply: string, facts: readonly MeetingFact[], context: string): { questions: MeetingCardQuestionView[] } | { error: string } {
  const start = reply.indexOf('[')
  const end = reply.lastIndexOf(']')
  let items: unknown
  try { items = start >= 0 && end > start ? JSON.parse(reply.slice(start, end + 1)) : undefined }
  catch { items = undefined }
  if (!Array.isArray(items)) return { error: '模型没按格式回,这次没做成预案卡' }
  const questions: MeetingCardQuestionView[] = []
  for (const item of items) {
    if (questions.length >= MEETING_CARD_MAX) break
    if (typeof item !== 'object' || item === null) continue
    const one = item as Record<string, unknown>
    const q = typeof one.q === 'string' ? one.q.trim() : ''
    const line = typeof one.line === 'string' ? one.line.trim() : ''
    const fallback = typeof one.fallback === 'string' && one.fallback.trim() !== '' ? one.fallback.trim() : MEETING_CARD_FALLBACK
    if (q === '' || line === '' || q.length > 120 || line.length > 200 || fallback.length > 120) continue
    const fact = typeof one.fact === 'string' ? facts.find(f => f.id === one.fact) : undefined
    const allowed = new Set([...numberTokens(context), ...numberTokens(fact?.text ?? '')])
    if (numberTokens(`${q}\n${line}\n${fallback}`).some(token => !allowed.has(token))) continue
    questions.push({
      q,
      ...(fact === undefined ? { none: true as const } : { number: { text: fact.text, source: fact.source } }),
      line,
      fallback,
    })
  }
  if (questions.length === 0) return { error: '模型给的问题一条都对不上她的数据,这次没做成预案卡' }
  return { questions }
}

/* ——— 给人看的 ——— */

function fromLabel(answer: MeetingPrepAnswer<unknown>): string {
  if (answer.from === 'said') return '你那句话里说的'
  if (answer.from === 'record') return answer.basis ?? '已有记录里认出的'
  return '你答的'
}

/** 预案卡此刻在哪一步。`running` = 正在做。 */
export function cardStatusOf(prep: StoredMeetingPrep, running: boolean): MeetingCardStatus {
  if (nextPrepAsk(prep) !== undefined) return 'answers'
  if (prep.goal_unclear === true && prep.proceed !== true) return 'goal'
  if (running) return 'making'
  if (prep.card !== undefined) return 'ready'
  if (prep.card_error !== undefined) return 'failed'
  return 'making'
}

export function prepViewOf(prep: StoredMeetingPrep, running: boolean): MeetingPrepView {
  const ask = nextPrepAsk(prep)
  return {
    said: prep.said,
    ...(prep.when === undefined ? {} : { when: prep.when }),
    ...(prep.scheduled_at === undefined ? {} : { scheduled_at: prep.scheduled_at }),
    ...(prep.scope === undefined ? {} : { scope: prep.scope }),
    ...(prep.kind === undefined ? {} : { kind: prep.kind }),
    ...(prep.people === undefined ? {} : { people: prep.people }),
    ...(prep.decider === undefined ? {} : { decider: prep.decider }),
    ...(prep.my_role === undefined ? {} : { my_role: prep.my_role }),
    ...(prep.goal === undefined ? {} : { goal: prep.goal }),
    ...(prep.goal_unclear === true ? { goal_unclear: true as const, organizer_ask: MEETING_ORGANIZER_ASK } : {}),
    ...(ask === undefined ? {} : { ask }),
    card_status: cardStatusOf(prep, running),
    ...(prep.card === undefined ? {} : { card: prep.card }),
    ...(prep.card_error === undefined ? {} : { card_error: prep.card_error }),
  }
}

/** 会前.md:电脑上看全本(落在这场会的目录里)。 */
export function renderPrepMd(input: { title: string, date: string, prep: StoredMeetingPrep, ask?: string }): string {
  const { prep } = input
  const row = (label: string, answer: MeetingPrepAnswer<unknown> | undefined, value: (a: MeetingPrepAnswer<unknown>) => string): string =>
    answer === undefined ? `- ${label}:还没答` : `- ${label}:${value(answer)}(${fromLabel(answer)})`
  const lines = [
    `# 会前准备:${input.title}`,
    '',
    `- 时间:${prep.when ?? '没说'}(${input.date})`,
    `- 你登记时的原话:「${prep.said}」`,
    '',
    '## 这场会',
    row('内部还是外部', prep.scope, a => String(a.value)),
    row('类型', prep.kind, a => String(a.value)),
    row('谁来', prep.people, a => personLine(a.value as MeetingPersonView[]) || '没说'),
    row('谁拍板', prep.decider, a => String(a.value)),
    row('你的角色', prep.my_role, a => String(a.value)),
    prep.goal_unclear === true ? '- 这场会要定下什么:还没说清' : row('这场会要定下什么', prep.goal, a => String(a.value)),
    '',
    '参会人只记花名;花名对应谁只有你知道。',
  ]
  if (prep.goal_unclear === true) {
    lines.push('', '## 先问清楚这场会要定什么', '', `可以这样问组织者:「${input.ask ?? MEETING_ORGANIZER_ASK}」`, '', '这句话事务官只替你拟好,发不发由你,它不会替你发。')
  }
  if (prep.card !== undefined) {
    lines.push('', '## 预案卡', '', '数只从你自己的数据里查,写明出处;查不到写「没有这个数」。')
    prep.card.questions.forEach((one, i) => {
      lines.push('', `### ${i + 1}. ${one.q}`,
        `- 一个数:${one.number === undefined ? '没有这个数' : `${one.number.text}(出处:${one.number.source})`}`,
        `- 一个说法:${one.line}`,
        `- 一个退路:${one.fallback}`)
    })
  }
  return `${lines.join('\n')}\n`
}

/** 会议目录里那份会前准备的文件名。 */
export const PREP_FILE_NAME = '会前.md'
