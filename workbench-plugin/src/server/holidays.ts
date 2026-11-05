/**
 * 中国法定节假日与工作日推算(2026-09-20,Ben:「10 月 4 号,智能一点就该知道这是国庆」)。
 *
 * 为什么要这一份:引导 ②′ 里她要替用户排方案,而排方案离不开「到那天还有几个工作日」。
 * 她不上网、不该猜 —— 所以日期这件事由**代码**算,表在这个文件里,来源逐条写清。
 *
 * ———————————————————— 这份表里有什么、没有什么(要紧) ————————————————————
 *
 * **有的是两样,来源不同,可信度也不同:**
 *
 * 1. **法定节假日**(`kind: 'statutory'`)——《全国年节及纪念日放假办法》
 *    (国务院令第 761 号,2024-11-10 第四次修订,2025-01-01 起施行)第二条
 *    「全体公民放假的节日」共 13 天:元旦 1 天、春节 4 天(农历除夕、正月初一至初三)、
 *    清明 1 天、劳动节 2 天(5 月 1、2 日)、端午 1 天、中秋 1 天、国庆 3 天(10 月 1–3 日)。
 *    这是**法**,不是每年发一次的通知,所以它对任何一年都成立。
 *
 * 2. **农历节日落在哪一天**(`confidence: '推算'`)——除夕 / 清明 / 端午 / 中秋
 *    这四个的公历日期要换算。这几行是**按农历换算填的,没有拿官方文件逐条核对过**,
 *    所以每一行都标 `confidence: '推算'`;算出来的结论也会把这一格带出去。
 *
 * **没有的是一样,而且是故意没有的:**
 *
 * 3. **每年那份《国务院办公厅关于 XXXX 年部分节假日安排的通知》**(调休、连休、哪个周末上班)
 *    ——本机没有那份文件,写到今天(2026-09-20)为止 2027 年那份**还没发布**(历年在前一年
 *    11 月前后才发)。**不编**(D13):`makeups` 一律空,`noticeKnown: false`,
 *    算出来的数字会明说「调休没录入,实际工作日可能比这个少 1–2 天」。
 *    Ben 手上有那份通知的话,填 `spans` 里加一条 `kind:'notice'` 的连休段 + `makeups` 里加调休上班日,
 *    `noticeKnown` 改 true —— 一处改完,电话里那句话自己就准了。
 *
 * 纪律:纯数据 + 纯函数,没有 I/O、不读网、不读系统日历(`calendar.ts` 那份是 macOS 日历的投影,
 * 与这里无关)。日期一律 `YYYY-MM-DD` 字符串,内部按 UTC 算 —— 免得跑在别的时区上差一天。
 */

export type HolidayKind = 'statutory' | 'notice'
export type HolidayConfidence = '确定' | '推算'

export interface HolidaySpan {
  /** 「国庆节」「春节」。 */
  name: string
  /** 含,YYYY-MM-DD。 */
  from: string
  /** 含,YYYY-MM-DD。 */
  to: string
  kind: HolidayKind
  /** 这一行的出处,原样说给人听。 */
  source: string
  confidence: HolidayConfidence
}

/** 调休上的那个「周末要上班」。本份表里一条都没有(见文件头第 3 条)。 */
export interface MakeupWorkday {
  date: string
  /** 为哪个假期调的。 */
  forName: string
  source: string
}

export interface HolidayYear {
  year: number
  spans: readonly HolidaySpan[]
  makeups: readonly MakeupWorkday[]
  /** 那一年的国务院办公厅通知录进来了吗。false = 只有法定那几天,连休与调休都不知道。 */
  noticeKnown: boolean
  noticeNote: string
}

const LAW = '《全国年节及纪念日放假办法》(国务院令第 761 号,2024-11-10 修订)第二条'
const LUNAR = '农历换算(未与当年官方通知逐条核对)'

const NOTICE_MISSING
  = '这一年的《国务院办公厅关于部分节假日安排的通知》没录进来(本机没有那份文件),所以只有法定那几天,'
    + '连休和调休上班日都不知道 —— 算出来的工作日可能偏多 1–2 天。'

/**
 * 2026 年。除夕 2 月 16 日(周一)、正月初一 2 月 17 日(周二);清明 4 月 5 日(周日);
 * 端午 6 月 19 日(周五);中秋 9 月 25 日(周五)。后四个都是换算来的,标「推算」。
 */
const Y2026: HolidayYear = {
  year: 2026,
  spans: [
    { name: '元旦', from: '2026-01-01', to: '2026-01-01', kind: 'statutory', source: LAW, confidence: '确定' },
    { name: '春节', from: '2026-02-16', to: '2026-02-19', kind: 'statutory', source: `${LAW};除夕落在 2026-02-16 按${LUNAR}`, confidence: '推算' },
    { name: '清明节', from: '2026-04-05', to: '2026-04-05', kind: 'statutory', source: `${LAW};日期按${LUNAR}`, confidence: '推算' },
    { name: '劳动节', from: '2026-05-01', to: '2026-05-02', kind: 'statutory', source: LAW, confidence: '确定' },
    { name: '端午节', from: '2026-06-19', to: '2026-06-19', kind: 'statutory', source: `${LAW};日期按${LUNAR}`, confidence: '推算' },
    { name: '中秋节', from: '2026-09-25', to: '2026-09-25', kind: 'statutory', source: `${LAW};日期按${LUNAR}`, confidence: '推算' },
    { name: '国庆节', from: '2026-10-01', to: '2026-10-03', kind: 'statutory', source: LAW, confidence: '确定' },
  ],
  makeups: [],
  noticeKnown: false,
  noticeNote: NOTICE_MISSING,
}

/**
 * 2027 年。除夕 2 月 5 日(周五)、正月初一 2 月 6 日(周六);清明 4 月 5 日(周一);
 * 端午 6 月 9 日(周三);中秋 9 月 15 日(周三)。同样标「推算」。
 * 2027 年那份通知写到 2026-09-20 为止**还没发布**,所以 `noticeKnown` 只能是 false。
 */
const Y2027: HolidayYear = {
  year: 2027,
  spans: [
    { name: '元旦', from: '2027-01-01', to: '2027-01-01', kind: 'statutory', source: LAW, confidence: '确定' },
    { name: '春节', from: '2027-02-05', to: '2027-02-08', kind: 'statutory', source: `${LAW};除夕落在 2027-02-05 按${LUNAR}`, confidence: '推算' },
    { name: '清明节', from: '2027-04-05', to: '2027-04-05', kind: 'statutory', source: `${LAW};日期按${LUNAR}`, confidence: '推算' },
    { name: '劳动节', from: '2027-05-01', to: '2027-05-02', kind: 'statutory', source: LAW, confidence: '确定' },
    { name: '端午节', from: '2027-06-09', to: '2027-06-09', kind: 'statutory', source: `${LAW};日期按${LUNAR}`, confidence: '推算' },
    { name: '中秋节', from: '2027-09-15', to: '2027-09-15', kind: 'statutory', source: `${LAW};日期按${LUNAR}`, confidence: '推算' },
    { name: '国庆节', from: '2027-10-01', to: '2027-10-03', kind: 'statutory', source: LAW, confidence: '确定' },
  ],
  makeups: [],
  noticeKnown: false,
  noticeNote: `${NOTICE_MISSING}2027 年那一份到 2026-09-20 为止还没发布(历年在前一年 11 月前后才发)。`,
}

export const HOLIDAY_YEARS: Readonly<Record<number, HolidayYear>> = { 2026: Y2026, 2027: Y2027 }

/** 表里覆盖到的年份,小到大。表外的年份一律「不知道」,不外推。 */
export const COVERED_YEARS: readonly number[] = Object.keys(HOLIDAY_YEARS).map(Number).sort((a, b) => a - b)

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/

/** `YYYY-MM-DD` → UTC 毫秒。格式不对或不是真日期(2026-02-30)回 undefined —— 不猜一个。 */
export function parseDate(text: unknown): number | undefined {
  if (typeof text !== 'string') return undefined
  const matched = DATE_RE.exec(text.trim())
  if (matched === null) return undefined
  const [, year, month, day] = matched as unknown as [string, string, string, string]
  const at = Date.UTC(Number(year), Number(month) - 1, Number(day))
  const back = new Date(at)
  if (back.getUTCFullYear() !== Number(year) || back.getUTCMonth() + 1 !== Number(month) || back.getUTCDate() !== Number(day)) {
    return undefined
  }
  return at
}

export function formatDate(at: number): string {
  return new Date(at).toISOString().slice(0, 10)
}

const WEEKDAY_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'] as const

/** 「周三」。日期不合法时 undefined。 */
export function weekdayOf(date: string): string | undefined {
  const at = parseDate(date)
  return at === undefined ? undefined : WEEKDAY_NAMES[new Date(at).getUTCDay()]
}

const DAY_MS = 86_400_000

/** 这一天落在哪个假期段里。没落在任何一段(或那一年不在表里)回 undefined。 */
export function holidayOn(date: string): HolidaySpan | undefined {
  const at = parseDate(date)
  if (at === undefined) return undefined
  const year = HOLIDAY_YEARS[new Date(at).getUTCFullYear()]
  if (year === undefined) return undefined
  return year.spans.find(span => {
    const from = parseDate(span.from)
    const to = parseDate(span.to)
    return from !== undefined && to !== undefined && at >= from && at <= to
  })
}

/** 这一天是调休上班日吗。本份表里恒为 undefined(见文件头第 3 条),留着是为了 Ben 填进来那天代码不用改。 */
export function makeupOn(date: string): MakeupWorkday | undefined {
  const at = parseDate(date)
  if (at === undefined) return undefined
  const year = HOLIDAY_YEARS[new Date(at).getUTCFullYear()]
  return year?.makeups.find(item => item.date === date)
}

export interface DayVerdict {
  date: string
  weekday: string
  workday: boolean
  /** 一句人话:「周日」「国庆节假期」「调休上班」。 */
  why: string
  /** 这一年的通知没录入 —— 结论可能不准。 */
  uncertain: boolean
}

/**
 * 这一天上不上班。判定顺序:调休上班日 > 法定假期 > 周末 > 工作日。
 * 那一年不在表里时**照样回一个判断**(只按周末算)但把 `uncertain` 立起来 —— 表外的年份
 * 我们只知道周末,不知道假期,说得出口的只有这一格。
 */
export function dayVerdict(date: string): DayVerdict | undefined {
  const at = parseDate(date)
  if (at === undefined) return undefined
  const weekday = WEEKDAY_NAMES[new Date(at).getUTCDay()] as string
  const covered = HOLIDAY_YEARS[new Date(at).getUTCFullYear()]
  const makeup = makeupOn(date)
  if (makeup !== undefined) return { date, weekday, workday: true, why: `${makeup.forName}调休,这天上班`, uncertain: false }
  const holiday = holidayOn(date)
  if (holiday !== undefined) {
    return {
      date,
      weekday,
      workday: false,
      why: `${holiday.name}假期(${holiday.from} 到 ${holiday.to})`,
      uncertain: covered?.noticeKnown !== true,
    }
  }
  const weekend = new Date(at).getUTCDay() === 0 || new Date(at).getUTCDay() === 6
  return {
    date,
    weekday,
    workday: !weekend,
    why: weekend ? '周末' : '工作日',
    uncertain: covered === undefined || !covered.noticeKnown,
  }
}

export interface WorkdayCount {
  from: string
  to: string
  /** 含头含尾一共几天。 */
  days: number
  /** 其中几天要上班。 */
  workdays: number
  /** 这一段里碰上的假期(去重,按先后)。 */
  holidays: readonly HolidaySpan[]
  /** 里头有「推算」来的日期,或者那一年的通知没录入。 */
  uncertain: boolean
  /** 一句能直接念出来的话。 */
  text: string
}

/** 一段区间(含头含尾)里有几个工作日。日期不合法或首尾反了回 undefined —— 不回一个 0。 */
export function workdaysBetween(from: string, to: string): WorkdayCount | undefined {
  const start = parseDate(from)
  const end = parseDate(to)
  if (start === undefined || end === undefined || start > end) return undefined
  // 一次最多算三年,防着有人传进来一个离谱的区间把循环拖住。
  if (end - start > 1100 * DAY_MS) return undefined
  let workdays = 0
  let uncertain = false
  const holidays: HolidaySpan[] = []
  for (let at = start; at <= end; at += DAY_MS) {
    const verdict = dayVerdict(formatDate(at))
    if (verdict === undefined) continue
    if (verdict.workday) workdays += 1
    if (verdict.uncertain) uncertain = true
    const span = holidayOn(formatDate(at))
    if (span !== undefined && !holidays.includes(span)) holidays.push(span)
  }
  const days = Math.round((end - start) / DAY_MS) + 1
  const holidayText = holidays.length === 0 ? '' : `,中间有${holidays.map(span => span.name).join('、')}`
  const caveat = uncertain
    ? '(调休安排我这儿没有官方通知,没算进去 —— 真放起来可能比这个还少一两天)'
    : ''
  return {
    from,
    to,
    days,
    workdays,
    holidays,
    uncertain,
    text: `${from} 到 ${to} 一共 ${days} 天${holidayText},实际工作日 ${workdays} 天${caveat}`,
  }
}

export interface DeadlineInput {
  /** 「比赛报名截止」。 */
  label: string
  date: string
}

/**
 * 给引导简报的那一段日历。**今天是哪天由调用方给**(服务端的 `now()`),这里不读钟。
 *
 * 里头有三样:今天几号星期几;今天之后 90 天内的假期段(带出处);每条已知截止日到今天还剩几个工作日。
 * 一条都算不出来时回 undefined —— 简报里那一格就整格缺席,不摆一段空标题(D13)。
 */
export function calendarBrief(today: string, deadlines: readonly DeadlineInput[] = []): string | undefined {
  const at = parseDate(today)
  if (at === undefined) return undefined
  const lines: string[] = []
  const weekday = weekdayOf(today)
  lines.push(`今天是 ${today}(${weekday ?? '星期几不知道'})。`)

  const horizon = at + 90 * DAY_MS
  const upcoming: HolidaySpan[] = []
  for (const year of COVERED_YEARS) {
    for (const span of HOLIDAY_YEARS[year]?.spans ?? []) {
      const to = parseDate(span.to)
      const from = parseDate(span.from)
      if (to === undefined || from === undefined) continue
      if (to >= at && from <= horizon) upcoming.push(span)
    }
  }
  upcoming.sort((a, b) => (parseDate(a.from) ?? 0) - (parseDate(b.from) ?? 0))
  if (upcoming.length > 0) {
    lines.push(`接下来 90 天里的法定假期:${upcoming.map(span =>
      `${span.name} ${span.from}${span.from === span.to ? '' : ` 到 ${span.to}`}(${span.confidence})`).join(';')}。`)
  }

  for (const deadline of deadlines) {
    const counted = workdaysBetween(today, deadline.date)
    if (counted === undefined) continue
    const verdict = dayVerdict(deadline.date)
    lines.push(`离「${deadline.label}」(${deadline.date}${verdict === undefined ? '' : ` ${verdict.weekday}、${verdict.why}`})`
      + `还有 ${counted.days} 天,其中工作日 ${counted.workdays} 天。`)
  }

  const missing = COVERED_YEARS.filter(year => HOLIDAY_YEARS[year]?.noticeKnown !== true)
  if (missing.length > 0) {
    lines.push(`口径:法定假期出自${LAW};农历那几个(除夕/清明/端午/中秋)是换算的,标「推算」。`
      + `${missing.join('、')} 年的调休安排(哪个周末要补班、连休到几号)**没有**录进来 —— `
      + '说日期时只说法定那几天,连休别当成事实,拿不准就问他一句「你们那儿这次连休到几号?」。')
  }
  return lines.length <= 1 && upcoming.length === 0 ? undefined : lines.join('\n')
}
