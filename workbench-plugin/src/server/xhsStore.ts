/**
 * 数据复盘的落盘(2026-09-21)。`~/.dsh/workbench/xhs-metrics.json`,**按日存快照、留 90 天**。
 *
 * 这个文件里除了读写那两个函数,其余全是纯函数(保留期、环比、组视图),
 * 所以「留 90 天」「环比跟谁比」这些一错就整月对不上的东西不用起一台服务就能测。
 *
 * ## 为什么按**日**存,而不是存一条时间序列
 *
 * 后台给的本来就是「近 7 日」「近 30 日」两个**已经聚合过**的数,不是每天的明细。
 * 同一天取两次,第二次覆盖第一次(那是同一天的同一个口径,留两份只会让环比挑花眼)。
 * 环比因此是「今天这份近 7 日」对「7 天前那天的近 7 日」—— 两份都是后台自己算的,
 * 我们一个加减法都没做。
 *
 * ## 一个数都不编,贯穿整个文件
 *
 * - 上一周期那份快照不存在 → `prev` 缺席,界面不画箭头,**不拿更近的一天凑**;
 *   (真要用更近的一天,就得改口说"跟 5 天前比",那是另一件事,得有人拍板。)
 * - 快照里某一项缺席 → 视图里那一项也缺席,界面说「后台没有这项」;
 * - 文件读坏了 → 回一份空的,界面显示"还没取到过",那正是此刻的真实状态。
 *
 * ## 保管
 *
 * 文件权限 0600。里面**没有任何凭据** —— 登录态自始至终只在那个专用 Chrome 档案里,
 * 我们连 cookie 名都没读过。里面有的是他自己后台的几个数和一个昵称。
 */
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { XhsAdviceView, XhsFetchLogView, XhsMetricView, XhsRangeView } from '../protocol.ts'
import type { XhsMetricKey, XhsMetricValue, XhsRange } from './xhsMetrics.ts'
import { XHS_METRICS, XHS_RANGES, XHS_RANGE_DAYS } from './xhsMetrics.ts'
import { XHS_PROFILE_NAME } from './xhsAccount.ts'

/** 快照保留多少天。Ben 的卡写死 90。 */
export const XHS_KEEP_DAYS = 90

/** 自取记录留多少条。够看清"最近这几次发生了什么",不当日志用。 */
export const XHS_KEEP_FETCHES = 30

/**
 * 范围在文件里的**稳定机器键**。不拿「近 7 日」当 key:那是给人看的字,
 * 哪天文案改一个空格,盘上的存量就全对不上了。
 */
export const XHS_RANGE_KEY: Readonly<Record<XhsRange, 'd7' | 'd30'>> = {
  '近 7 日': 'd7',
  '近 30 日': 'd30',
}

export type XhsRangeKey = 'd7' | 'd30'

export function defaultXhsMetricsFile(home = process.env.HOME ?? ''): string {
  return `${home}/.dsh/workbench/xhs-metrics.json`
}

/** 标签覆盖文件(Ben 登录后校准用)。不存在是常态,不是错误。 */
export function defaultXhsSelectorsFile(home = process.env.HOME ?? ''): string {
  return `${home}/.dsh/workbench/xhs-selectors.json`
}

/** 一天一个范围的一份快照。 */
export interface XhsSnapshot {
  at: string
  metrics: Partial<Record<XhsMetricKey, XhsMetricValue>>
  /**
   * 这一次为什么没取到某一项,**一项一句人话**(2026-09-22)。
   *
   * 与 `XhsMetricDef.absent_why`(这一项天生就取不到)不是一回事:那句是常驻的,
   * 这份是**这一次**的(比如「按笔记的表第一页全在范围内,后面还有没翻」)。
   * 有这一份就显示这一份 —— 界面上那一格因此能说出"这次为什么空着"。
   */
  absent?: Partial<Record<XhsMetricKey, string>>
}

export type XhsDays = Record<string, Partial<Record<XhsRangeKey, XhsSnapshot>>>

/**
 * 一个账号在盘上的那一份(2026-09-22 多账号)。
 *
 * `profile` 是**机器键**(浏览器档案目录名),不是昵称 —— 昵称是会改的,
 * 改一次昵称就把历史数据认不出来了。
 */
export interface XhsAccountFile {
  profile: string
  index: number
  /** 首页读到的账号名。读不到就缺席,界面显示「账号 N」。 */
  name?: string
  /** 首页「小红书账号: <数字>」那一串。 */
  uid?: string
  days: XhsDays
}

export interface XhsFile {
  /** 2 = 按账号分开存(2026-09-22)。1 = 单账号那一版,读的时候当场迁移。 */
  version: 2
  accounts: XhsAccountFile[]
  fetches: XhsFetchLogView[]
  advice?: XhsAdviceView
  /** 最近一次「让我看看这页」导出到哪。 */
  peek?: XhsPeek
}

/** 「让我看看这页」那一份导出。**不含 cookie**(见 xhsCreator.peek)。 */
export interface XhsPeek { at: string, file: string, chars: number }

export function emptyXhsFile(): XhsFile {
  return { version: 2, accounts: [], fetches: [] }
}

/** 找一个账号那一份。没有就 undefined(**不顺手建一个空的**)。 */
export function accountOf(file: XhsFile, profile: string): XhsAccountFile | undefined {
  return file.accounts.find(account => account.profile === profile)
}

/**
 * 写回一个账号那一份(没有就追加,按档案序号排)。
 * 名字与 id **只在读到的时候覆盖**:这一次没读到就留着上一次那个,不清空。
 */
export function upsertAccount(file: XhsFile, next: XhsAccountFile): XhsFile {
  const existing = accountOf(file, next.profile)
  const merged: XhsAccountFile = {
    ...existing,
    ...next,
    ...(next.name === undefined && existing?.name !== undefined ? { name: existing.name } : {}),
    ...(next.uid === undefined && existing?.uid !== undefined ? { uid: existing.uid } : {}),
  }
  const others = file.accounts.filter(account => account.profile !== next.profile)
  return { ...file, accounts: [...others, merged].sort((a, b) => a.index - b.index) }
}

/** 本地日期串(与 server/brief.ts 的 localDateStr 同一口径,不拿 toISOString 切天)。 */
export function xhsDateStr(ms: number): string {
  const d = new Date(ms)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 往前/往后挪几天,仍按本地日历算(跨月跨年跨夏令时都走 Date 自己那一套)。 */
export function shiftDate(date: string, days: number): string {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  if (parts === null) return date
  const d = new Date(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]))
  d.setDate(d.getDate() + days)
  return xhsDateStr(d.getTime())
}

/**
 * 保留期:**只留最近 90 天**(含今天)。
 *
 * 认不出格式的键一律丢 —— 文件是可以被手改的,一个乱键不该永远留在那里。
 */
export function pruneDays(days: XhsDays, todayMs: number, keep = XHS_KEEP_DAYS): XhsDays {
  const floor = shiftDate(xhsDateStr(todayMs), -(keep - 1))
  const out: XhsDays = {}
  for (const [date, entry] of Object.entries(days)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue
    if (date < floor) continue
    out[date] = entry
  }
  return out
}

/** 记一条自取记录,新的在前,超过上限砍掉最旧的。 */
export function appendFetchLog(
  logs: readonly XhsFetchLogView[],
  entry: XhsFetchLogView,
  keep = XHS_KEEP_FETCHES,
): XhsFetchLogView[] {
  return [entry, ...logs].slice(0, keep)
}

/**
 * 上一周期那份快照。「今天这份近 7 日」对的是「7 天前那天的近 7 日」。
 *
 * **只认那一天本身,不拿附近的天凑**。找不到就回 undefined,界面不画箭头 ——
 * 拿 5 天前那份冒充"上一周期",算出来的涨跌会是错的,而界面上看不出来它是错的。
 */
export function previousSnapshot(
  days: XhsDays,
  date: string,
  range: XhsRange,
): { date: string, snapshot: XhsSnapshot } | undefined {
  const want = shiftDate(date, -XHS_RANGE_DAYS[range])
  const snapshot = days[want]?.[XHS_RANGE_KEY[range]]
  return snapshot === undefined ? undefined : { date: want, snapshot }
}

/** 把一份快照 + 它的上一周期组成界面要的那一行八格。 */
export function buildRangeView(
  days: XhsDays,
  date: string,
  range: XhsRange,
): XhsRangeView | undefined {
  const snapshot = days[date]?.[XHS_RANGE_KEY[range]]
  if (snapshot === undefined) return undefined
  const previous = previousSnapshot(days, date, range)

  const metrics: XhsMetricView[] = XHS_METRICS.map((def) => {
    const now = snapshot.metrics[def.key]
    const before = previous?.snapshot.metrics[def.key]
    // 空着的那一格要说清"为什么空":这一次的原因优先,没有就用这一项天生的原因。
    const why = snapshot.absent?.[def.key] ?? def.absent_why
    return {
      key: def.key,
      label: def.label,
      kind: def.kind,
      ...(now === undefined ? {} : { value: now.value, raw: now.raw }),
      // 合计那一行的数是算出来的,必须自报家门(server/xhsTotal.ts)。
      ...(now?.derived === undefined ? {} : { derived: now.derived }),
      ...(now !== undefined || why === undefined ? {} : { why }),
      // 这一期没取到时不画箭头 —— 拿"上期有、本期没有"画一个下降箭头是编数。
      ...(now === undefined || before === undefined || previous === undefined
        ? {}
        : { prev: { value: before.value, raw: before.raw, date: previous.date } }),
    }
  })

  return { range, date, at: snapshot.at, metrics }
}

/** 最新那一天(有任何一个范围的快照的那一天)。一次都没取过回 undefined。 */
export function latestDate(days: XhsDays): string | undefined {
  const dates = Object.keys(days).filter(date => Object.keys(days[date] ?? {}).length > 0).sort()
  return dates[dates.length - 1]
}

/** 最新那一天的两个范围视图。取不到的那个范围缺席。 */
export function buildRangeViews(days: XhsDays): XhsRangeView[] {
  const date = latestDate(days)
  if (date === undefined) return []
  return XHS_RANGES
    .map(range => buildRangeView(days, date, range))
    .filter((view): view is XhsRangeView => view !== undefined)
}

/** 最近一次成功的自取时刻。 */
export function lastOkAt(logs: readonly XhsFetchLogView[]): string | undefined {
  return logs.find(log => log.ok)?.at
}

/** 「上次成功 x 小时前」那句话。从没成功过时回 undefined(不说"0 小时前")。 */
export function lastOkLine(logs: readonly XhsFetchLogView[], nowMs: number): string | undefined {
  const at = lastOkAt(logs)
  if (at === undefined) return undefined
  const ms = nowMs - Date.parse(at)
  if (!Number.isFinite(ms) || ms < 0) return undefined
  const hours = Math.floor(ms / 3_600_000)
  if (hours < 1) return `上次成功 ${Math.max(1, Math.floor(ms / 60_000))} 分钟前`
  if (hours < 48) return `上次成功 ${hours} 小时前`
  return `上次成功 ${Math.floor(hours / 24)} 天前`
}

/** —— 落盘 —— */

/**
 * 读盘上那一份。
 *
 * ## v1 → v2 的迁移(2026-09-22)
 *
 * v1 是单账号:`{ days, nickname }` 摊在最外层。那一份属于**第一个档案**
 * (`login-profile-xhs_creator`),所以原样搬进 `accounts[0]` —— 历史快照一天不丢,
 * Ben 也不用重登。**迁移只在内存里做**,下一次落盘才写成 v2。
 */
function parseXhsFile(text: string): XhsFile {
  const parsed = JSON.parse(text) as Record<string, unknown>
  if (typeof parsed !== 'object' || parsed === null) return emptyXhsFile()
  const fetches = Array.isArray(parsed.fetches) ? parsed.fetches as XhsFetchLogView[] : []
  const tail = {
    ...(parsed.advice === undefined ? {} : { advice: parsed.advice as XhsAdviceView }),
    ...(parsed.peek === undefined ? {} : { peek: parsed.peek as XhsPeek }),
  }

  if (Array.isArray(parsed.accounts)) {
    const accounts = (parsed.accounts as unknown[])
      .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
      .map((item, order): XhsAccountFile => ({
        profile: typeof item.profile === 'string' && item.profile !== '' ? item.profile : XHS_PROFILE_NAME,
        index: typeof item.index === 'number' && Number.isInteger(item.index) ? item.index : order + 1,
        ...(typeof item.name === 'string' && item.name !== '' ? { name: item.name } : {}),
        ...(typeof item.uid === 'string' && item.uid !== '' ? { uid: item.uid } : {}),
        days: typeof item.days === 'object' && item.days !== null ? item.days as XhsDays : {},
      }))
      .sort((a, b) => a.index - b.index)
    return { version: 2, accounts, fetches, ...tail }
  }

  // —— v1:单账号那一版。整份搬进第一个档案。 ——
  const days = typeof parsed.days === 'object' && parsed.days !== null ? parsed.days as XhsDays : {}
  const nickname = typeof parsed.nickname === 'string' && parsed.nickname !== '' ? parsed.nickname : undefined
  const accounts: XhsAccountFile[] = Object.keys(days).length === 0 && nickname === undefined
    ? []
    : [{ profile: XHS_PROFILE_NAME, index: 1, ...(nickname === undefined ? {} : { name: nickname }), days }]
  return { version: 2, accounts, fetches, ...tail }
}

/** 读。没有 / 读坏了一律回空 —— 界面因此显示"还没取到过",那正是此刻的真实状态。 */
export async function loadXhsFile(file: string): Promise<XhsFile> {
  let text: string
  try { text = await readFile(file, 'utf8') }
  catch { return emptyXhsFile() }
  try { return parseXhsFile(text) }
  catch { return emptyXhsFile() }
}

/** 写。0600 —— 里面是他自己后台的数,不该给同机的别的用户看见。 */
export async function saveXhsFile(file: string, data: XhsFile): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 })
  // writeFile 的 mode 只在新建时生效,已存在的文件要显式收一次(同 credentials.ts)。
  await chmod(file, 0o600)
}

/** 把一份快照放进当天那一格(同一天同一范围**覆盖**),顺手剪掉 90 天以外的。 */
export function putSnapshot(
  days: XhsDays,
  date: string,
  range: XhsRange,
  snapshot: XhsSnapshot,
  todayMs: number,
): XhsDays {
  const next: XhsDays = { ...pruneDays(days, todayMs), [date]: { ...days[date], [XHS_RANGE_KEY[range]]: snapshot } }
  return next
}
