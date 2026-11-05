/**
 * 数据复盘:从小红书创作者中心自取那八个数(2026-09-21 写,2026-09-22 真页面 + 多账号)。
 *
 * 依据:决策记录 2026-09-20「**数据复盘走浏览器自取**(创作者中心网页),不走手抄」;
 * 运营同事的原话「希望能够实时同步数据看板,并进一步给出优化建议」;
 * Ben 的草图(近 7 日 / 近 30 日 + 八个指标);
 * Ben 2026-09-22 原话「我想直接验证多账号的数据汇总……再开一个纯净的,我登录第二个账号」。
 *
 * 这个文件是**编排**:去哪几页取、什么时候可以去取、取回来算谁的、界面看到什么。
 * 真碰网络在 xhsBrowser.ts,解析在 xhsMetrics.ts / xhsNotesTable.ts,落盘在 xhsStore.ts,
 * 合计在 xhsTotal.ts,建议的提示词与依据在 xhsAdvice.ts —— 都不需要开 Chrome 就能测。
 *
 * ## 2026-09-22 实测到的两页(9/21 那一版指错了页,这一版改掉)
 *
 * | | 是什么 | 给谁 |
 * |---|---|---|
 * | `/new/home` | **账号级总览**。「统计周期 MM-DD 至 MM-DD」+ **近7日 / 近30日两颗按钮** | 曝光数、观看数、封面点击率、点赞数、收藏数、净涨粉 |
 * | `/statistics/data-analysis` | **按笔记的表**(一行一篇 + 「发布于 日期」+ 分页) | 笔记发布数(数出来的) |
 *
 * 9/21 把 `/statistics/data-analysis` 当成「近 7 日」那一页是错的 —— 它上面根本没有
 * 账号级的汇总。`/creator/home` 会跳到 `/new/home`,两条都存在。
 *
 * ## 「近 30 日」是**点出来的**,而且必须确认
 *
 * 两个范围是同一页上的两颗按钮,**地址栏一个字都不变**。所以取 30 日那一份要:
 * 打开首页 → 点一下「近30日」→ **等到「统计周期」那一行变了** → 才读。
 * 那一行没变就**不存这一份**:把 7 日那份数存成 30 日那份,是这张卡上最容易犯、
 * 又最看不出来的一种编数(交接 0921 第四节第 7 条)。
 *
 * 点那一下的边界(与「采集类三项」那条"不点"的承诺不冲突)写在 xhsBrowser.ts
 * `rangeSwitchExpression` 的注释里,拍板记在 docs/决策记录.md 2026-09-22。
 *
 * ## 多账号:一个账号一个浏览器档案
 *
 * `login-profile-xhs_creator`(第一个,**不改名**)、`-2`、`-3`……
 * 每个档案登录后从首页读到的账号名与「小红书账号」id 就是这份数据的归属(xhsAccount.ts)。
 * 落盘按账号分开(xhsStore 的 `accounts[]`),界面上**每个账号一行 + 合计一行**。
 *
 * ## PRD §9 那三条落在哪
 *
 * | 要求 | 落法 |
 * |---|---|
 * | **每个自动动作看得见** | 每一次自取(成功与失败)都写一条进「自取记录」:什么时候、取到几项、失败原因。例程那一次也一样 |
 * | **能撤销** | 这件事的唯一持久后果是 `~/.dsh/workbench/xhs-metrics.json` 与那几个浏览器档案目录,设置里写明在哪、可以自己删 |
 * | **有依据** | 建议里的每个数都是代码算的(xhsAdvice.ts),不经过模型;合计那一行的每个数都带一句「怎么算的」(xhsTotal.ts) |
 *
 * ## 风控自保(卡里第 5 条)
 *
 * - **同一个浏览器档案 + 真人登录 + 只读页面 + 低频**。低频在这里:
 *   两次自取之间至少 `MIN_GAP_MS`(10 分钟),例程一天最多一次。**多账号不放宽这条闸** ——
 *   一轮把所有账号顺着取完算**一次**。
 * - **改版了不重试轰炸**:一旦判成「页面变了」,例程那条路当天不再试。
 * - **一个数不编**:取不到的指标缺席、切不成的范围整块缺席、数不全的笔记数缺席。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { XhsAccountView, XhsFetchLogView, XhsRangeView, XhsTrendView, XhsView } from '../protocol.ts'
import type { XhsBrowser } from './xhsBrowser.ts'
import type { XhsMetricKey, XhsRange } from './xhsMetrics.ts'
import { XHS_METRICS, XHS_RANGES, XHS_RANGE_DAYS, mergeLabelOverrides, parseCreatorPage } from './xhsMetrics.ts'
import { countNotesPublished } from './xhsNotesTable.ts'
import {
  XHS_PROFILE_NAME, accountDisplayName, accountIdentityFrom, listXhsProfiles, xhsProfileName,
} from './xhsAccount.ts'
import { mergeDaysForTotal } from './xhsTotal.ts'
import { buildTrendView } from './xhsTrend.ts'
import type { XhsAccountFile, XhsFile, XhsSnapshot } from './xhsStore.ts'
import {
  XHS_RANGE_KEY, accountOf, appendFetchLog, buildRangeViews, emptyXhsFile, lastOkAt, lastOkLine,
  loadXhsFile, putSnapshot, saveXhsFile, upsertAccount, xhsDateStr,
} from './xhsStore.ts'
import { advisableChanges, buildAdvicePrompt, composeAdvice, parseAdviceReply } from './xhsAdvice.ts'

export { XHS_PROFILE_NAME, xhsProfileName } from './xhsAccount.ts'

/**
 * 登录 / 取数落脚的那一页。**2026-09-22 实测:账号级总览就在这一页上**
 * (`/creator/home` 会跳到这里)。
 */
export const XHS_HOME_URL = 'https://creator.xiaohongshu.com/new/home'

/** 「近 7 日」默认去哪一页取 —— 就是首页,它默认显示的就是近 7 日。 */
export const XHS_DEFAULT_D7_URL = XHS_HOME_URL

/** 「近 30 日」也是这一页,靠点那颗按钮切(见文件头)。 */
export const XHS_DEFAULT_D30_URL = XHS_HOME_URL

/** 按笔记的那张表。「笔记发布数」从它上面数出来(xhsNotesTable.ts)。 */
export const XHS_DEFAULT_NOTES_URL = 'https://creator.xiaohongshu.com/statistics/data-analysis'

/**
 * 那两颗范围切换按钮上写的字。**2026-09-22 实测是「近7日」「近30日」(没有空格)**,
 * 与我们对外说的「近 7 日」(有空格)不是同一串,所以这里单独留一份,
 * 并且可以在 `xhs-selectors.json` 里覆盖(后台改文案不用重新发版)。
 */
export const XHS_SWITCH_LABELS: Readonly<Record<'d7' | 'd30', readonly string[]>> = {
  d7: ['近7日', '近 7 日', '近7天'],
  d30: ['近30日', '近 30 日', '近30天'],
}

/** 两次自取之间至少隔多久。卡里写死 10 分钟。 */
export const MIN_GAP_MS = 10 * 60 * 1000

/** 判成「页面变了」之后,例程那条路歇多久。24 小时 —— 改版不是等几分钟会好的事。 */
export const LAYOUT_CHANGED_BACKOFF_MS = 24 * 60 * 60 * 1000

/** 被跳到登录页的判据(与 xhsMetrics 的文本判据互为旁证:一个看 URL,一个看文字)。 */
export function isLoginUrl(href: string): boolean {
  return href.includes('/login')
}

/** 可覆盖的那几样。整份文件读坏了就当没有(照用内置默认),不抛。 */
export interface XhsConfig {
  /** 每个范围去哪一页取,以及按笔记那张表在哪。**没配的整块缺席**。 */
  pages: Partial<Record<'d7' | 'd30' | 'notes', string>>
  /** 切范围那颗按钮上写的字。 */
  switchLabels: Record<'d7' | 'd30', readonly string[]>
  labels: Partial<Record<XhsMetricKey, readonly string[]>>
  /** 昵称在页面上跟在哪个词后面。没配就走 xhsAccount 那条启发式,**都读不到就没有名字**。 */
  nicknameLabels: readonly string[]
}

export function defaultXhsConfig(): XhsConfig {
  return {
    pages: { d7: XHS_DEFAULT_D7_URL, d30: XHS_DEFAULT_D30_URL, notes: XHS_DEFAULT_NOTES_URL },
    switchLabels: { d7: XHS_SWITCH_LABELS.d7, d30: XHS_SWITCH_LABELS.d30 },
    labels: {},
    nicknameLabels: [],
  }
}

/** 把覆盖文件读成配置。认不出的部分一律退回默认,**一个字段错不该废掉整份文件**。 */
export function parseXhsConfig(raw: unknown): XhsConfig {
  const base = defaultXhsConfig()
  if (typeof raw !== 'object' || raw === null) return base
  const source = raw as Record<string, unknown>

  const pages = { ...base.pages }
  const rawPages = source.pages
  if (typeof rawPages === 'object' && rawPages !== null) {
    for (const key of ['d7', 'd30', 'notes'] as const) {
      const value = (rawPages as Record<string, unknown>)[key]
      if (typeof value !== 'string') continue
      // 空串 = 明说"这个范围别取"。把默认那一条也清掉。
      if (value.trim() === '') { delete pages[key]; continue }
      // 只认创作者中心自己的地址 —— 一份可手改的配置不该能把这台机器指到别处去。
      if (!value.startsWith('https://creator.xiaohongshu.com/')) continue
      pages[key] = value.trim()
    }
  }

  const switchLabels = { ...base.switchLabels }
  const rawSwitch = source.switch_labels
  if (typeof rawSwitch === 'object' && rawSwitch !== null) {
    for (const key of ['d7', 'd30'] as const) {
      const value = (rawSwitch as Record<string, unknown>)[key]
      if (!Array.isArray(value)) continue
      const list = value.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
      if (list.length > 0) switchLabels[key] = list
    }
  }

  const nicknameLabels = Array.isArray(source.nickname_labels)
    ? source.nickname_labels.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
    : base.nicknameLabels

  return { pages, switchLabels, labels: mergeLabelOverrides(source), nicknameLabels }
}

/** 这一轮要取哪几页、每一页要不要先点一下那颗范围按钮。 */
export interface XhsTarget {
  range: XhsRange
  url: string
  /** 读之前要点的那颗按钮上写的字。不传 = 一个字都不点(近 7 日就是默认视图)。 */
  switchTo?: readonly string[]
}

/**
 * 这一轮要取哪几页。
 *
 * ★ **两个范围配到同一页、而且都不点按钮时,只认第一个**。同一页的同一份数字存成
 * 「近 7 日」和「近 30 日」两份,界面上会画出两组能互相比的柱子 —— 那是编得看不出来的编数。
 *
 * 默认这一份**两个范围确实是同一个地址**,但 30 日那一份要先点一下按钮、
 * 而且点完必须看见「统计周期」那一行变了才算数(xhsBrowser.readPageWith),
 * 所以它们不是同一份数 —— 去重看的是「地址 + 点哪颗按钮」这一对。
 */
export function pagesOf(config: XhsConfig): XhsTarget[] {
  const used = new Set<string>()
  const out: XhsTarget[] = []
  for (const range of XHS_RANGES) {
    const key = XHS_RANGE_KEY[range]
    const url = config.pages[key]
    if (url === undefined) continue
    // 近 7 日是首页的默认视图,不用点;近 30 日要点。
    const switchTo = key === 'd30' ? config.switchLabels.d30 : undefined
    const fingerprint = `${url}|${(switchTo ?? []).join(',')}`
    if (used.has(fingerprint)) continue
    used.add(fingerprint)
    out.push({ range, url, ...(switchTo === undefined ? {} : { switchTo }) })
  }
  return out
}

/** 从页面文字里找昵称。配了标签才找,找不到就**没有**。(保留给用例与旧调用方。) */
export function nicknameFrom(text: string, labels: readonly string[]): string | undefined {
  if (labels.length === 0) return undefined
  return accountIdentityFrom(text, labels).name
}

export type XhsTrigger = 'routine' | 'manual' | 'login'

/** 登录窗口开着时隔多久看一眼、最多看多久(2026-09-30)。用例传 0 / 假 sleep。 */
export interface XhsLoginWatch { pollMs?: number, maxMs?: number, sleep?: (ms: number) => Promise<void> }

export interface XhsCollectResult {
  ok: boolean
  /** 一句人话,界面原样显示。 */
  message: string
  got: number
  total: number
  /** 这一轮跑了几个账号。 */
  accounts?: number
}

export interface XhsServiceOptions {
  /** `~/.dsh/workbench/xhs-metrics.json` */
  metricsFile: string
  /** `~/.dsh/workbench/xhs-selectors.json`(不存在是常态) */
  selectorsFile: string
  /**
   * 那几个专用 Chrome 档案的**父目录**(`~/.dsh/workbench`)。
   * 2026-09-22 起这里从"一个档案目录"改成"档案们的根" —— 一个账号一个档案。
   */
  profileRoot: string
  /** 「让我看看这页」导出到哪个目录 */
  peekDir: string
  browser: XhsBrowser
  now?: () => number
  /**
   * 调模型生成建议。**不传 = 不生成**(没接模型服务时那一块整块缺席,
   * 而不是显示三条正确的废话)。
   */
  chat?: (prompt: string) => Promise<string>
  /**
   * 运营模板下 `<工作目录>/账号/` 里有哪几个文件夹。
   * 拿来**按名字**给每个登录档案挂个钩;**匹配不上就单列**,不强绑(xhsAccount.ts 文件头)。
   */
  opsAccounts?: () => Promise<readonly string[]>
  /** 盘上变了,广播一次快照(让界面下一拍就看见)。 */
  onChanged?: () => void
}

export interface XhsService {
  load: () => Promise<void>
  view: () => XhsView
  /**
   * 开登录窗口。**登录由他本人完成**,我们只开窗口。
   * 不传 index = 第一个档案(与 9/21 那一版行为逐字相同);`'new'` = 再开一个纯净的。
   */
  startLogin: (which?: number | 'new', watch?: XhsLoginWatch) => Promise<{ ok: boolean, message: string, profile?: string, index?: number }>
  /** 等登录后那一轮看守跑完(用例用;没在看就立刻回)。 */
  loginWatchDone?: () => Promise<void>
  /** 取一轮(所有账号)。频率闸在这里。 */
  collect: (trigger: XhsTrigger) => Promise<XhsCollectResult>
  /** 例程那一下:先取一轮,再让模型写三条建议。 */
  runForRoutine: () => Promise<{ collected: XhsCollectResult, advice: boolean }>
  /** 「让我看看这页」:把当前那一页的可见文字导出到本地文件(**不含 cookie**)。 */
  peek: (index?: number) => Promise<{ ok: boolean, message: string, file?: string }>
}

export function createXhsService(options: XhsServiceOptions): XhsService {
  const now = options.now ?? (() => Date.now())
  let file: XhsFile = emptyXhsFile()
  let config: XhsConfig = defaultXhsConfig()
  /** 盘上现在有哪几个档案(登录窗口开过一次就有了)。`load` 与每次动作后刷新。 */
  let profiles: number[] = []
  /** 运营模板那边的账号文件夹名。没接就空。 */
  let opsNames: readonly string[] = []
  /** 每个档案此刻还在不在登录态。键是档案名。 */
  const connected = new Map<string, boolean>()
  /** 每个档案这一轮的实话。键是档案名。 */
  const accountNotes = new Map<string, string>()
  /** 最近一次自取的时刻(不论成败)。频率闸看它。**多账号共用这一把闸。** */
  let lastAttemptMs = 0
  /** 最近一次判成「页面变了」的时刻。例程据此歇一天。 */
  let layoutChangedMs = 0
  /** 界面顶上那句实话。 */
  let note: string | undefined
  let inFlight = false
  /** 登录窗口那一轮看守(一次只看一个;再点一次登录就换成新的那个)。 */
  let loginWatch: Promise<void> = Promise.resolve()
  let loginWatchSeq = 0

  function profileDirOf(index: number): string {
    return join(options.profileRoot, xhsProfileName(index))
  }

  async function refreshProfiles(): Promise<void> {
    const found = await listXhsProfiles(options.profileRoot)
    const known = file.accounts.map(account => account.index)
    profiles = [...new Set([...found, ...known])].sort((a, b) => a - b)
    if (options.opsAccounts !== undefined) {
      try { opsNames = await options.opsAccounts() }
      catch { opsNames = [] }
    }
  }

  async function persist(): Promise<void> {
    await saveXhsFile(options.metricsFile, file)
    options.onChanged?.()
  }

  async function load(): Promise<void> {
    file = await loadXhsFile(options.metricsFile)
    try { config = parseXhsConfig(JSON.parse(await readFile(options.selectorsFile, 'utf8'))) }
    catch { config = defaultXhsConfig() }
    // 登录态不在我们这儿,所以启动时只能说"这个档案上次取到过" —— 真相以下一次自取为准。
    for (const account of file.accounts) {
      connected.set(account.profile, Object.keys(account.days).length > 0)
    }
    await refreshProfiles()
  }

  /** 界面上那一份账号清单:盘上有档案的 + 盘上没有但存过数的,按序号排。 */
  function accountFiles(): XhsAccountFile[] {
    const out: XhsAccountFile[] = []
    for (const index of profiles) {
      const profile = xhsProfileName(index)
      out.push(accountOf(file, profile) ?? { profile, index, days: {} })
    }
    for (const account of file.accounts) {
      if (out.some(item => item.profile === account.profile)) continue
      out.push(account)
    }
    return out.sort((a, b) => a.index - b.index)
  }

  function trendsOf(days: XhsAccountFile['days']): XhsTrendView[] {
    return XHS_RANGES.map(range => buildTrendView(days, range, now()))
  }

  function accountViews(): XhsAccountView[] {
    return accountFiles().map((account) => {
      const name = accountDisplayName(account.index, account.name)
      // 与运营模板那边按名字对钩。**对不上就缺席**,不强绑。
      const dir = account.name === undefined ? undefined : opsNames.find(item => item === account.name)
      const said = accountNotes.get(account.profile)
      return {
        profile: account.profile,
        index: account.index,
        name,
        ...(account.uid === undefined ? {} : { uid: account.uid }),
        connected: connected.get(account.profile) ?? false,
        ranges: buildRangeViews(account.days),
        trends: trendsOf(account.days),
        ...(dir === undefined ? {} : { account_dir: dir }),
        ...(said === undefined ? {} : { note: said }),
      }
    })
  }

  /** 合计那一份按日快照。只有一个账号时**就是它自己**(xhsTotal.ts)。 */
  function totalDays(): XhsAccountFile['days'] {
    return mergeDaysForTotal(accountFiles().map(account => account.days))
  }

  function rangeViews(): XhsRangeView[] {
    return buildRangeViews(totalDays())
  }

  /** 合计那一行下面那句话。**一个账号时不说** —— 那时候"合计"就是它自己。 */
  function totalNote(accounts: readonly XhsAccountView[]): string | undefined {
    if (accounts.length <= 1) return undefined
    const withData = accounts.filter(account => account.ranges.length > 0).length
    return `合计 = ${accounts.length} 个账号加起来（这一次有数的 ${withData} 个）。`
      + '能加的加起来；封面点击率按曝光加权；平均观看时长不能加。'
      + '**只要有一个账号缺某一项，合计那一格就空着** —— 少算一个账号的数看不出来是错的。'
  }

  function view(): XhsView {
    const accounts = accountViews()
    const lines: string[] = []
    if (note !== undefined) lines.push(note)
    const ok = lastOkLine(file.fetches, now())
    if (ok !== undefined) lines.push(ok)
    if (accounts.length === 0) lines.push('还没有登录过任何小红书账号')
    const missing = XHS_RANGES.filter(range => config.pages[XHS_RANGE_KEY[range]] === undefined)
    if (missing.length > 0) lines.push(`${missing.join('、')}没有配取数的页面`)

    const total = totalDays()
    const anyConnected = accounts.some(account => account.connected)
    const firstName = accountFiles().find(account => account.name !== undefined)?.name
    const note2 = totalNote(accounts)

    return {
      login: {
        connected: anyConnected,
        ...(firstName === undefined ? {} : { nickname: firstName }),
      },
      accounts,
      ranges: buildRangeViews(total),
      fetches: file.fetches,
      ...(lastOkAt(file.fetches) === undefined ? {} : { last_ok_at: lastOkAt(file.fetches) as string }),
      ...(lines.length === 0 ? {} : { note: lines.join(';') }),
      ...(file.advice === undefined ? {} : { advice: file.advice }),
      ...(lastAttemptMs === 0 ? {} : { refresh_ready_at: new Date(lastAttemptMs + MIN_GAP_MS).toISOString() }),
      ...(file.peek === undefined ? {} : { peek: file.peek }),
      trends: trendsOf(total),
      ...(note2 === undefined ? {} : { total_note: note2 }),
    }
  }

  /**
   * **登录完就自己取一轮**(2026-09-30,维护者 Air 真机:「登录上了,但是登录之后,数据没有登记进来」)。
   * 隔一会儿只看一眼那个窗口开着哪个地址:离开登录页、停在创作者中心 → 取一轮(不受 10 分钟那道闸)。
   * 窗口关了、看了太久还没登上 → 不再看。**只看地址,不跳转、不点**(他可能正在输验证码)。
   */
  async function watchLogin(index: number, seq: number, watch: XhsLoginWatch = {}): Promise<void> {
    const look = options.browser.currentUrls
    if (look === undefined) return
    const pollMs = watch.pollMs ?? 10_000
    const maxMs = watch.maxMs ?? 15 * 60_000
    const sleep = watch.sleep ?? (ms => new Promise<void>(resolve => { setTimeout(resolve, ms).unref?.() }))
    const who = accountDisplayName(index)
    for (let waited = 0; waited <= maxMs; waited += Math.max(pollMs, 1)) {
      if (seq !== loginWatchSeq) return
      let urls: string[]
      try { urls = await look(profileDirOf(index)) }
      catch { console.log(`[xhs] ${who}的登录窗口关了,不再等它登录`); return }
      if (urls.some(url => url.includes('creator.xiaohongshu.com') && !isLoginUrl(url))) {
        console.log(`[xhs] 看见${who}登上了,先取一轮数据`)
        await sleep(3_000)
        const result = await collect('login')
        console.log(`[xhs] 登录后那一轮:${result.message}`)
        options.onChanged?.()
        return
      }
      await sleep(pollMs)
    }
    console.log(`[xhs] 等了 ${Math.round(maxMs / 60_000)} 分钟,${who}还没登上,不再等`)
  }

  async function startLogin(
    which?: number | 'new',
    watch?: XhsLoginWatch,
  ): Promise<{ ok: boolean, message: string, profile?: string, index?: number }> {
    await refreshProfiles()
    const index = which === 'new'
      ? (profiles.length === 0 ? 1 : Math.max(...profiles) + 1)
      : (which ?? 1)
    if (!Number.isInteger(index) || index < 1) {
      return { ok: false, message: '没有这个账号档案' }
    }
    const profile = xhsProfileName(index)
    try {
      await options.browser.openWindow(profileDirOf(index), XHS_HOME_URL)
      note = `${accountDisplayName(index)}的登录窗口开着,登完把它留着别关 —— 取数要用同一个窗口`
      await refreshProfiles()
      const seq = ++loginWatchSeq
      loginWatch = watchLogin(index, seq, watch).catch(() => { /* 看守出错不拦登录 */ })
      return {
        ok: true,
        message: `已经为${accountDisplayName(index)}打开创作者中心。请在那个窗口里自己登录,登完不要关它。`,
        profile,
        index,
      }
    }
    catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : '打不开登录窗口' }
    }
  }

  /** 记一条自取记录并落盘。**成功失败都记** —— 自动动作必须看得见(PRD §9)。 */
  async function log(entry: XhsFetchLogView): Promise<void> {
    file = { ...file, fetches: appendFetchLog(file.fetches, entry) }
    await persist()
  }

  /**
   * 一个账号取一轮。回「取到几项」与这个账号的那句实话。
   * **不落盘**(落盘在外面一次性做),所以它只改传进来的那一份 days。
   */
  async function collectOne(
    account: XhsAccountFile,
    nowMs: number,
  ): Promise<{ got: number, account: XhsAccountFile, problems: string[] }> {
    const profileDir = profileDirOf(account.index)
    const problems: string[] = []
    let got = 0
    let days = account.days
    let name = account.name
    let uid = account.uid
    const who = accountDisplayName(account.index, account.name)

    // —— 按笔记的那张表,一个账号只读一次(7 日与 30 日都从它上面数)——
    let noteTableText: string | undefined
    const notesUrl = config.pages.notes
    if (notesUrl !== undefined) {
      try {
        const page = await options.browser.readPage(profileDir, notesUrl)
        if (!isLoginUrl(page.href)) noteTableText = page.text
      }
      catch (error) {
        problems.push(`${who}:按笔记的表打不开(${error instanceof Error ? error.message : '未知'})`)
      }
    }

    for (const target of pagesOf(config)) {
      let page
      try { page = await options.browser.readPage(profileDir, target.url, target.switchTo) }
      catch (error) {
        problems.push(`${who} ${target.range}:${error instanceof Error ? error.message : '打不开那一页'}`)
        continue
      }

      if (isLoginUrl(page.href)) {
        connected.set(account.profile, false)
        problems.push(`${who} ${target.range}:登录态过期了`)
        continue
      }

      const parsed = parseCreatorPage(page.text, config.labels)
      if (parsed.state === 'logged_out') {
        connected.set(account.profile, false)
        problems.push(`${who} ${target.range}:登录态过期了`)
        continue
      }
      connected.set(account.profile, true)

      const identity = accountIdentityFrom(page.text, config.nicknameLabels)
      name = identity.name ?? name
      uid = identity.uid ?? uid

      if (parsed.state === 'layout_changed') {
        layoutChangedMs = nowMs
        problems.push(`${who} ${target.range}:后台页面变了,等更新`)
        continue
      }

      // ★ 要切范围却没切成 —— **这一份一个字都不存**。
      //   存下去就是把近 7 日那份数当成近 30 日那份(交接 0921 第四节第 7 条)。
      if (target.switchTo !== undefined && page.switch_confirmed !== true) {
        problems.push(
          page.switch_clicked === true
            ? `${who} ${target.range}:点了那颗按钮,但「统计周期」那一行没变 —— 这一份不算数,没存`
            : `${who} ${target.range}:页面上找不到那颗「${target.switchTo[0] ?? ''}」按钮 —— 这一份没取`,
        )
        continue
      }

      const metrics = { ...parsed.metrics }
      const absent: Partial<Record<XhsMetricKey, string>> = {}

      // —— 笔记发布数:从按笔记的表数出来,数不全就缺席 ——
      if (noteTableText === undefined) {
        absent.notes = '这一次没读到按笔记的那张表,所以数不出发了几篇'
      }
      else {
        const counted = countNotesPublished(noteTableText, nowMs, XHS_RANGE_DAYS[target.range])
        if (counted.ok) metrics.notes = { value: counted.count, raw: String(counted.count) }
        else absent.notes = counted.why
      }

      const count = Object.keys(metrics).length
      if (count === 0) {
        problems.push(`${who} ${target.range}:认出了标签但一个数都没读出来`)
        continue
      }
      got += count
      // 这一页读通了,改版那个闸松开。
      layoutChangedMs = 0
      const snapshot: XhsSnapshot = {
        at: new Date(nowMs).toISOString(),
        metrics,
        ...(Object.keys(absent).length === 0 ? {} : { absent }),
      }
      days = putSnapshot(days, xhsDateStr(nowMs), target.range, snapshot, nowMs)
    }

    return {
      got,
      account: {
        ...account,
        days,
        ...(name === undefined ? {} : { name }),
        ...(uid === undefined ? {} : { uid }),
      },
      problems,
    }
  }

  async function collect(trigger: XhsTrigger): Promise<XhsCollectResult> {
    const nowMs = now()
    const total = XHS_METRICS.length

    if (inFlight) return { ok: false, message: '上一轮还没跑完', got: 0, total }

    // —— 频率闸 ——(登录后那一下不拦:他刚登上,等的就是这一轮)
    if (trigger !== 'login' && lastAttemptMs !== 0 && nowMs - lastAttemptMs < MIN_GAP_MS) {
      const wait = Math.ceil((MIN_GAP_MS - (nowMs - lastAttemptMs)) / 60_000)
      return { ok: false, message: `刚取过,${wait} 分钟后再来`, got: 0, total }
    }
    // —— 改版之后不重试轰炸:例程歇一天,他自己点刷新才再试 ——
    if (trigger === 'routine' && layoutChangedMs !== 0 && nowMs - layoutChangedMs < LAYOUT_CHANGED_BACKOFF_MS) {
      return { ok: false, message: '后台页面变了,等更新 —— 今天不再自动重试', got: 0, total }
    }

    const targets = pagesOf(config)
    if (targets.length === 0) {
      const message = '一个数据范围都没配取数的页面'
      note = message
      await log({ at: new Date(nowMs).toISOString(), ok: false, got: 0, total, trigger, reason: message })
      return { ok: false, message, got: 0, total }
    }

    await refreshProfiles()
    const accounts = accountFiles()
    if (accounts.length === 0) {
      const message = '还没有登录过任何小红书账号 —— 去设置 → 额度凭据登一个'
      note = message
      await log({ at: new Date(nowMs).toISOString(), ok: false, got: 0, total, trigger, reason: message })
      return { ok: false, message, got: 0, total, accounts: 0 }
    }

    inFlight = true
    lastAttemptMs = nowMs
    try {
      let got = 0
      const problems: string[] = []
      accountNotes.clear()
      for (const account of accounts) {
        const result = await collectOne(account, nowMs)
        got += result.got
        problems.push(...result.problems)
        if (result.problems.length > 0) accountNotes.set(account.profile, result.problems.join(';'))
        file = upsertAccount(file, result.account)
      }

      const ok = got > 0
      const reason = problems.join(';')
      note = ok ? (reason === '' ? undefined : reason) : (reason === '' ? '一个数都没取到' : reason)
      const totalSlots = total * targets.length * accounts.length
      await log({
        at: new Date(nowMs).toISOString(),
        ok,
        got,
        total: totalSlots,
        trigger,
        ...(reason === '' ? {} : { reason }),
      })
      return {
        ok,
        message: ok
          ? `${accounts.length} 个账号取到 ${got} 项${reason === '' ? '' : `(${reason})`}`
          : (note ?? '一个数都没取到'),
        got,
        total: totalSlots,
        accounts: accounts.length,
      }
    }
    finally {
      inFlight = false
    }
  }

  /** 让模型写三条建议。**没数据就不生成**(连提示词都不拼)。依据的是**合计**那一份。 */
  async function advise(): Promise<boolean> {
    const chat = options.chat
    if (chat === undefined) return false
    const views = rangeViews()
    // 挑有环比的那个范围;两个都有就用近 7 日(它更贴"下一条内容该怎么做")。
    const usable = views
      .map(view_ => ({ view: view_, changes: advisableChanges(view_) }))
      .filter(item => item.changes.length > 0)
    const picked = usable[0]
    if (picked === undefined) return false

    let reply: string
    try { reply = await chat(buildAdvicePrompt(picked.view.range, picked.changes)) }
    catch { return false }

    const drafts = parseAdviceReply(reply, picked.changes.map(change => change.key))
    const advice = composeAdvice(drafts, picked.changes, picked.view.range, new Date(now()).toISOString())
    if (advice === undefined) return false
    file = { ...file, advice }
    await persist()
    return true
  }

  async function runForRoutine(): Promise<{ collected: XhsCollectResult, advice: boolean }> {
    const collected = await collect('routine')
    const advice = await advise()
    return { collected, advice }
  }

  async function peek(index = 1): Promise<{ ok: boolean, message: string, file?: string }> {
    const target = pagesOf(config)[0]?.url ?? XHS_HOME_URL
    let page
    try { page = await options.browser.readPage(profileDirOf(index), target) }
    catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : '打不开那一页' }
    }
    const at = new Date(now()).toISOString()
    const name = `xhs-页面文本-${at.replace(/[:.]/g, '-')}.txt`
    const out = join(options.peekDir, name)
    // ★ 导出的只有**页面上看得见的字**与它的地址。没有 cookie、没有请求头、没有任何凭据 ——
    //   这份文件是要发给我看的,所以它里面能有什么必须一眼说得清。
    const body = [
      '# 小红书创作者中心 · 页面文本导出',
      `# 时间:${at}`,
      `# 账号档案:${xhsProfileName(index)}`,
      `# 地址:${page.href}`,
      `# 标题:${page.title}`,
      '# 这份文件里只有页面上看得见的文字。没有 cookie、没有请求头、没有任何登录凭据。',
      '',
      page.text,
    ].join('\n')
    await mkdir(options.peekDir, { recursive: true })
    await writeFile(out, body, { mode: 0o600 })
    file = { ...file, peek: { at, file: out, chars: page.text.length } }
    await persist()
    return { ok: true, message: `已经导出到 ${out}`, file: out }
  }

  return { load, view, startLogin, collect, runForRoutine, peek, loginWatchDone: async () => { await loginWatch } }
}
