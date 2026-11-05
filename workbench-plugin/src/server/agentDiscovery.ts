/**
 * Agent **自动发现与统一接入**(2026-09-25,卡 Q)。登记表(`agentRegistry.ts`)是账本,这个文件是跑腿的那一个。
 *
 * 维护者:「要是写死了就很糟糕了……你得想个机制,后面检测到是 Agent,有会话窗口的这种都得能有气泡和会话状态、
 * 标题、内容」。设计与确认点见 docs/设计-Agent自动发现与统一接入-2026-09-25.md。
 *
 * ## 什么时候发现
 *
 * | 时机 | 从哪来 |
 * |---|---|
 * | App 启动 / 切到前台 | 壳推来的 `app` 事件(壳的 AppDelegate 本来就在监听 didLaunch / didActivate) |
 * | 工作台启动 | 壳一接上就扫一遍正在跑的 App(`running_apps`,不碰辅助功能) |
 * | 平时 | 每 10 分钟再扫一遍(补漏掉的事件) |
 *
 * **通话中全停**(同通话护栏的 `inCall` 口径,见 `callState.ts`):不判、不看结构、不读窗口;挂断后接着来。
 *
 * ## 怎么判(两条都过才接,见 `agentJudge.ts`)
 *
 * 1. 先按身份(名字、包标识、类别、出品方)让模型一批判:人跟人聊天的、别的 App → 不是 Agent,**连窗口结构都不看**;
 * 2. 判成 Agent 或拿不准的,才读一次窗口**结构**(只数字块、只读按钮名 / 菜单名 / 输入框提示,不读对话);结构不像就不接;
 * 3. 结构像、身份是 Agent → **自动接上**,外层提示一句「新接上一家:XX」;
 *    结构像、身份拿不准 → 带上界面字再判一次;还拿不准 → **不读**,外层问一句「XX 像是个 Agent,要接上吗?」。
 * 他随时说一句「这不是 Agent」就撤掉,以后不判、不读。每个 App 只判一次,判完记下来;花费有上限,计入每日额度。
 *
 * ## 接上之后:通用的读窗口(`agentWindowModel.ts`)
 *
 * 只对接上的那几家读,**只读**(不点、不打字、不切对话、不抢焦点)。在跑的几秒读一次,空闲的几分钟读一次,
 * 他切到它 / 从它切走时各读一次;App 没开就不读,界面上显示最后一次读到的、带时间。
 * 每次最多做一件窗口上的事(一次探测或两次读),空闲时基本不花 CPU。
 *
 * **刚有动静之后密读一阵**(2026-09-26,卡 WS,见 {@link HOT_AFTER_ACTIVITY_MS}):他切过去 / 切走 /
 * 派活送了话 / 上一次读到内容变了之后的几分钟,空闲也按在跑的节奏读 —— 否则短活整个落在两次读中间,
 * 只看得见「回了:…」,看不见「开始跑了」。
 */
import type { AgentBlockedView, AgentBubbleView, AgentFoundHow, AgentRegistryDetailView, AgentRegistryView, SessionAskView, SessionView } from '../protocol.ts'
import type { AppIdentity } from './agentJudge.ts'
import {
  IDENTITY_BATCH, JUDGE_DAILY_CALLS, JUDGE_DAILY_CNY, axSummaryOf, budgetGate, estimateCallCny, identityPrompt, judgeStructure,
  parseAxDetail, parseIdentityVerdicts, parseProbe, parseWindowVerdict, spend, wantsAxDetail, windowPrompt,
} from './agentJudge.ts'
import type { AgentIcon } from './agentIcons.ts'
import { ICON_PER_TICK, ICON_SIDE, createIconCache, iconLogLine, parseIconResponse } from './agentIcons.ts'
import type { AgentRecordRead, AgentRecordReaders } from './agentRecords.ts'
import { RECORD_LEVEL_LINE, RECORD_SOURCE_LABEL, SCREEN_ONLY_NOTE } from './agentRecords.ts'
import type { AppRecord, RegistryFile, RegistryStore } from './agentRegistry.ts'
import { OWN_BUNDLE_ID, askQuestionText, emptyRegistry, isSnoozed, judgedApps, recordBasis, recordSessionId, registryView, windowSessionId } from './agentRegistry.ts'
import { FAMILY_SOURCES, SESSION_SOURCES, bindingForBundle, bundleForEntry, entryIdForBundle, entryIdOf, familyAsksInWindow, windowTitleOnly } from './agentSources.ts'
import type { WindowAgentState } from './agentWindowModel.ts'
import { clipText, windowProgressBusy, doubaoVisibleForm, nextWindowState, parseRead, summarizeRead, titleFromWindow, type ProgressSeen, type WindowRead } from './agentWindowModel.ts'
import { CLIENT_DISPATCH_NEVER } from './dispatchClient.ts'
import type { HelperRequest } from './helperChannel.ts'
// 「在等你」那一份要的形状(卡 WS):读窗口读出来的那条会话 → 同一份内容判断。
import type { WindowWaitRef } from './waitingService.ts'

/** 窗口那只手(壳)。与 `ClientDispatchHelper` 同一个形状。 */
export interface DiscoveryHelper {
  connected: () => boolean
  /** 壳会不会 `agent_window` 那几个原语(旧壳不会)。缺席按"会"处理。 */
  supports?: (cap: string) => boolean
  /** 壳此刻有没有辅助功能授权(读别家窗口要它)。缺席按"有"处理。 */
  view?: () => { authorized: boolean }
  request: (req: HelperRequest, timeoutMs?: number) => Promise<Record<string, unknown>>
}

/**
 * 在外层问他一句「XX 像是个 Agent,要接上吗?」。生产上接的是卡 M 的提问经纪人(`agentAsk.ts` 的 createBrokerAsker):
 * 这一问进「等你」那一堆、那一个数,电脑球下、手机「等你确认」都能答。
 *
 * - 回 `yes` → 接上;`no` → 当他说了「这不是 Agent」;`skip`(「先不管」、认不准他写的那一句)→ {@link ASK_SNOOZE_MS} 之后再问。
 * - `signal`:这一问不用再等了(他在别处说了「接上」/「这不是 Agent」、工作台要停了)就撤掉,两端那一张跟着消失。
 *   撤掉之后回什么都不算他答的。
 * - 这一问只活在内存里(同卡 M 的经纪人):工作台重启之后,登记表里还在问的那几家再挂一次。
 */
export interface DiscoveryAsker {
  ask: (input: { id: string, name: string, question: string, basis: string, signal?: AbortSignal }) => Promise<'yes' | 'no' | 'skip'>
}

/** 壳推来的 App 事件。 */
export interface AppEvent {
  event: 'launched' | 'activated' | 'terminated'
  bundle_id: string
  name?: string
  pid?: number
}

export interface AgentDiscoveryDeps {
  store: RegistryStore
  helper?: DiscoveryHelper | undefined
  /** 问一次模型(走工作台的模型服务,计入每日额度)。缺席 = 判不了(拿不准的一律不接)。 */
  judge?: ((prompt: string, maxTokens: number) => Promise<string>) | undefined
  /** 中转那边今天还剩多少(元)。缺席 / 说不出 = 只看发现自己的上限。 */
  remainingCny?: (() => Promise<number | undefined>) | undefined
  /** 此刻在不在通话(同通话护栏的口径)。 */
  inCall?: (() => boolean) | undefined
  /** `/state.sessions`(专门读法读出来的会话)。 */
  sessions?: (() => readonly SessionView[]) | undefined
  asker?: DiscoveryAsker | undefined
  /**
   * 读窗口那条会话「有没有一问在等他」(2026-09-26,卡 WS;接 `waitingService.askOf`)。
   * 与文件型会话**同一份判断、同一个花费上限**;按 09-26 的口径只挂 `ask`、不改运行状态。
   * 缺席 = 没接那一份 → 窗口会话不挂 `ask`,别的一字不变。
   */
  askOf?: ((entryId: string, sessionId: string) => SessionAskView | undefined) | undefined
  /**
   * 「它自己的记录」那一路(2026-10-08,`agentRecords.ts`):有本机对话库的那几家,在跑 / 做完 / 标题 / 最新一句
   * 以它的库为准,每一拍读一次(本机 SQLite,不碰壳);读窗口那一只手只补标题。读不了就整家退回读窗口。
   * 缺席 = 一家都没有这一路(老用例)。
   */
  records?: AgentRecordReaders | undefined
  now?: () => Date
  tickMs?: number
  setInterval?: (fn: () => void, ms: number) => unknown
  clearInterval?: (handle: unknown) => void
  setTimeout?: (fn: () => void, ms: number) => unknown
  clearTimeout?: (handle: unknown) => void
  /** 登记表有看得见的变化(推一份快照)。 */
  onChanged?: () => void
  log?: (line: string) => void
  /** 工作台自己(壳)的包标识,不当候选。 */
  ownBundleId?: string
}

export interface AgentDiscovery {
  start: () => Promise<void>
  stop: () => Promise<void>
  /** 走一拍(定时器每 `tickMs` 一拍;用例直接调)。绝不抛。 */
  tick: () => Promise<void>
  handleAppEvent: (event: AppEvent) => void
  /** 壳连上 / 断开了(连上就马上扫一遍)。 */
  helperChanged: () => void
  /** 派活刚往这一家送了话:马上读、读得勤一点。 */
  nudge: (bundleId: string) => void
  /**
   * 别人刚去翻过这几家的窗口(读额度那一路)——下一拍只重新起算,不把那一下的字当成「它回了一句」
   * (2026-09-27,卡 BB)。
   */
  windowTouched: (bundleIds: readonly string[]) => void
  /**
   * 读窗口读出来的那几条会话(2026-09-26,卡 WS):喂给「在等你」那一份({@link WindowWaitRef}),
   * 让窗口型 Agent 走**同一套**内容判断。只读内存里现成的那一份,不碰壳、不碰盘。
   */
  windows: () => readonly WindowWaitRef[]
  view: () => AgentRegistryView
  /**
   * **某一个包此刻开着没**(2026-09-28,卡 DP)。读内存里那一份活着的清单,不碰壳、不碰盘;
   * 没听说过这个包就 undefined(不猜)。
   *
   * 登记表那一份是**按家**报的(`AgentEntryView.app_running`),而一家可能装着两个 App
   * (豆包:`com.bot.pc.doubao` 与 `com.work.pc.doubao`)—— 派活要挑「她正开着的那一个」,
   * 就得按包问。
   */
  appRunning: (bundleId: string) => boolean | undefined
  /**
   * 这一家的 logo(2026-09-26,卡 LG):`GET /agents/icon/:id` 拿的就是它。
   * `id` = 登记表条目的 id(有专门读法的那几家是 `claude` / `dsh`……,别的是包标识)。
   * 还没取到 / 这台电脑上没装 / 壳是旧版 → undefined(接口回 404,界面退回色点)。
   */
  icon: (id: string) => AgentIcon | undefined
  /**
   * 坞上那一格的图标(2026-09-26,卡 LG2):`GET /apps/icon/:key` 拿的就是它。
   * 参数是**包标识**(键→包的换算在 `appIcons.resolveDockApp`,只认坞与窗位清单里登记过的键) ——
   * 与登记表那条 `icon(id)` 共用同一份取图与缓存,但**不要求这一家在登记表里**:
   * 微信、Notion、终端、Finder、Pen 判过了都不是 Agent,坞上照样该有它们的 logo。
   *
   * 没取到 / 这台电脑上没装 / 壳是旧版或没接上 → undefined(接口回 404,界面画中性小方块)。
   */
  appIcon: (bundleId: string) => Promise<AgentIcon | undefined>
  detail: () => AgentRegistryDetailView
  /** 他说「这不是 Agent」。 */
  notAgent: (id: string) => Promise<{ ok: boolean, note: string }>
  /** 他说「接上」(拿不准的那一家答「要」,或者撤回一次「这不是 Agent」)。 */
  connect: (id: string) => Promise<{ ok: boolean, note: string }>
  /**
   * 问一次模型的闸门与记账(2026-09-26,卡 QO)。**开集的额度读法共用登记表这一份每日上限** ——
   * 判「这是不是 Agent」与判「这一页上有没有用量」花的是同一份钱(`agentJudge` 的 `budgetGate` / `spend`,
   * 落在 `~/.dsh/workbench/agents.json` 的 `budget` 上)。卡 QO:「别另起一套模型调用与记账」。
   */
  judgeBudget: {
    gate: (estimateCny: number) => Promise<{ ok: true } | { ok: false, why: string }>
    spend: (cny: number) => Promise<void>
  }
  /** 他看过了(气泡、没看过的回复收掉)。 */
  markRead: (id: string) => Promise<boolean>
  dismissNotice: (id: string) => Promise<boolean>
  /** 此刻登记表那一份(用例看)。 */
  data: () => RegistryFile
}

export const DISCOVERY_TICK_MS = 5000
/** 平时低频巡检:多久扫一遍正在跑的 App。 */
export const SCAN_EVERY_MS = 10 * 60_000
/** App 刚起来,等窗口画出来再看它。 */
export const LAUNCH_SETTLE_MS = 6000
/** 在跑的那一家几秒读一次。 */
export const READ_BUSY_MS = 5000
/** 空闲的那一家多久读一次;连着几次都没变就再放慢一倍。 */
export const READ_IDLE_MS = 3 * 60_000
export const READ_IDLE_SLOW_MS = 6 * 60_000
/** 他切到它:过一会儿读一次。他从它切走(多半刚发出去一句):过一会儿读一次。 */
export const READ_AFTER_ACTIVATE_MS = 1500
export const READ_AFTER_LEAVE_MS = 2500
/**
 * **刚有动静之后密读一阵**(2026-09-26,卡 WS)。维护者 09-26:「新加的是不是状态不全,
 * 只有完成的,但是没有弹过待确认还有执行中的气泡」。
 *
 * 原来「刚有动静」只换来**一次**读(切过去 1.5 秒后读一次、切走 2.5 秒后读一次),读完那一次
 * 若不在跑就回到 {@link READ_IDLE_MS} 的 3 分钟。他在那扇窗里说一句、那家半分钟答完 ——
 * 三分钟后再去读,看到的只是「不在跑、内容变了」,于是**只有「回了:…」,永远等不到「开始跑了」**。
 *
 * 现在:他刚切到它 / 刚从它切走(送话进窗口时壳自己会激活那扇窗)/ 派活刚送了话 / 上一次读到内容变了 ——
 * 这之后的 {@link HOT_AFTER_ACTIVITY_MS} 里,空闲也按 {@link READ_BUSY_MS}(在跑的那个节奏)读,
 * 短活才看得见。这几分钟过完自己回到 3 分钟那档 —— 不是把巡检整体调密(那会白烧 CPU 与辅助功能调用)。
 */
export const HOT_AFTER_ACTIVITY_MS = 3 * 60_000
/** 在它前面停够这么久才算「看过了」(同 DockTabBar 的 DWELL_READ_MS)。 */
export const MARK_READ_DWELL_MS = 5000
/** 结构不像的那一家,最快多久再看一次(切到前台时)。 */
export const PROBE_RETRY_MS = 30 * 60_000
/**
 * **藏在窗口槽里**那一下多久再看一眼(2026-10-01)。那不是「结构不像」,是什么都没看见 ——
 * 所以不按上面那 30 分钟等。一分钟一次:藏着的时候再看还是看不见(便宜,一个 `agent_probe`),
 * 她一切到那一格,壳的 activated 事件当场就把它推回队里,不用等这一分钟。
 */
export const HIDDEN_RETRY_MS = 60_000
/** 模型没回 / 回坏了 / 今天的额度到了:多久以后再判。 */
export const JUDGE_RETRY_MS = 60 * 60_000
/** 读窗口读出来的「最后一次」多久落一次盘(只存需要的那几样;重启后「App 没开时显示最后一次读到的」靠它)。 */
export const SAVE_DEBOUNCE_MS = 5000
/** 问他「要接上吗」,他答「先不管」之后多久再问一次。 */
export const ASK_SNOOZE_MS = 7 * 24 * 60 * 60_000

/** 发现与巡检为什么停着(`paused` 那一句;界面上是「没接上:…」后面括号里那几个字)。 */
export const PAUSE_TEXT = {
  call: '通话中,先停着',
  no_shell: '工作台 App 没接上',
  old_shell: '工作台 App 是旧版',
  no_ax: '工作台还没开「辅助功能」权限',
} as const
export type PauseKind = keyof typeof PAUSE_TEXT

/** 顶栏那一句里最多点几家的名字(多了说「等 N 家」)。 */
const BLOCKED_NAMES_MAX = 4
/** 图标的颜色多久重读一次(换了图标的 App 很少);没装的那一家多久再看一眼。 */
export const COLOR_REFRESH_MS = 7 * 24 * 60 * 60_000
export const COLOR_MISSING_RETRY_MS = 24 * 60 * 60_000
/** 两次读图标颜色之间至少隔多久(新接上一家时马上读,别的时候不频繁)。 */
export const COLOR_MIN_GAP_MS = 60_000
/** 两次取整张图标之间至少隔多久(2026-09-26 卡 LG;同颜色那条:新接上一家马上取,别的时候不频繁)。 */
export const ICON_MIN_GAP_MS = 60_000

function localDay(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

interface LiveApp {
  bundle_id: string
  name: string
  running: boolean
  active: boolean
  identity?: AppIdentity
}

interface Queued { how: AgentFoundHow, notBefore: number }

function sameVisible(a: WindowAgentState | undefined, b: WindowAgentState): boolean {
  return a !== undefined && a.status === b.status && a.title === b.title && a.latest === b.latest && a.unread === b.unread
    && a.titles.join('\n') === b.titles.join('\n') && a.formAsk?.since === b.formAsk?.since
}

export function createAgentDiscovery(deps: AgentDiscoveryDeps): AgentDiscovery {
  const now = deps.now ?? (() => new Date())
  const tickMs = deps.tickMs ?? DISCOVERY_TICK_MS
  const setIntervalFn = deps.setInterval ?? ((fn: () => void, ms: number) => { const h = setInterval(fn, ms); h.unref?.(); return h })
  const clearIntervalFn = deps.clearInterval ?? ((h: unknown) => clearInterval(h as ReturnType<typeof setInterval>))
  const setTimeoutFn = deps.setTimeout ?? ((fn: () => void, ms: number) => { const h = setTimeout(fn, ms); h.unref?.(); return h })
  const clearTimeoutFn = deps.clearTimeout ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>))
  const own = deps.ownBundleId ?? 'ai.ben.workbench'
  const log = (line: string): void => { try { deps.log?.(`[agents] ${line}`) } catch { /* 日志坏了不连累 */ } }

  let data: RegistryFile = emptyRegistry()
  let loaded = false
  const live = new Map<string, LiveApp>()
  const queue = new Map<string, Queued>()
  const judgeRetryAt = new Map<string, number>()
  const readDue = new Map<string, number>()
  /** 豆包办公上次读到「正在…」是什么时候、在哪条对话上(两步之间的空档要用;见 `windowProgressBusy`)。 */
  const progressSeen = new Map<string, ProgressSeen>()
  /**
   * 「刚有动静」到这一刻之前按 {@link READ_BUSY_MS} 密读(卡 WS)。切过去 / 切走 / 派活送了话 /
   * 上一次读到内容变了都往后推一次。过期了自己回到 3 分钟那档。
   */
  const hotUntil = new Map<string, number>()
  const idleStreak = new Map<string, number>()
  const bubbles = new Map<string, AgentBubbleView>()
  const feedTrack = new Map<string, { status: string, latest?: string }>()
  /** 读它自己记录的那几家这一拍读到的(按包标识;读不了的不在里面)。 */
  const recordReads = new Map<string, AgentRecordRead>()
  /** 上一拍读到的样子(只比状态 / 标题 / 最新一句 / 时刻,判「变没变」与冒气泡)。 */
  const recordTrack = new Map<string, { sig: string, busy: boolean }>()
  /** 上一拍这一家的记录读不读得了(变了才记一句日志)。 */
  const recordOk = new Map<string, boolean>()
  /** 正挂在外层的那几问(按包标识):撤的时候用。 */
  const liveAsks = new Map<string, AbortController>()
  let activeBundle: string | undefined
  let dwellTimer: unknown
  let lastScanAt = Number.NEGATIVE_INFINITY
  let lastColorAt = Number.NEGATIVE_INFINITY
  /**
   * 各家的 logo(2026-09-26,卡 LG)。**只在内存里**,不进 agents.json(理由见 agentIcons.ts)。
   * 卡 LG2 起坞上那几格**不是 Agent** 的(微信、Notion、终端、Finder、Pen……)也存在这一份里 ——
   * 键是包标识,所以 Claude 那种「既在登记表里、又在坞上」的家只渲一次、只占一份内存。
   */
  const icons = createIconCache()
  let lastIconAt = Number.NEGATIVE_INFINITY
  /**
   * 正在问壳的那几张(2026-09-26,卡 LG2)。坞上十几格的 `<img>` 是**同时**发出来的,
   * 不去重的话同一个包会被问好几遍(壳那边幂等,可那条长连上白跑几趟)。
   */
  const iconsInFlight = new Map<string, Promise<AgentIcon | undefined>>()
  let scannedOnce = false
  let ticking = false
  let timer: unknown
  let saveTimer: unknown
  let paused: string | undefined
  let pausedKind: PauseKind | undefined
  let note: string | undefined

  const nowMs = (): number => now().getTime()

  /** 「这一家刚有动静」:接下来几分钟按在跑的节奏读(卡 WS)。 */
  function markHot(bundleId: string): void {
    hotUntil.set(bundleId, nowMs() + HOT_AFTER_ACTIVITY_MS)
  }

  /** 此刻还在「刚有动静」那几分钟里吗。 */
  function isHot(bundleId: string): boolean {
    const until = hotUntil.get(bundleId)
    if (until === undefined) return false
    if (until > nowMs()) return true
    hotUntil.delete(bundleId)
    return false
  }

  function changed(): void {
    viewMemo = undefined
    try { deps.onChanged?.() } catch { /* 推快照失败不连累发现 */ }
  }

  async function saveNow(): Promise<void> {
    if (saveTimer !== undefined) { clearTimeoutFn(saveTimer); saveTimer = undefined }
    try { await deps.store.save(data) }
    catch (error) { log(`登记表没写下去:${errorText(error)}`) }
  }

  /** 读窗口读出来的「最后一次」:攒一攒再落盘(在跑的那一家几秒读一次,不每次都写)。 */
  function saveSoon(): void {
    if (saveTimer !== undefined) return
    saveTimer = setTimeoutFn(() => { saveTimer = undefined; void saveNow() }, SAVE_DEBOUNCE_MS)
  }

  async function ensureLoaded(): Promise<void> {
    if (loaded) return
    loaded = true
    try { data = await deps.store.load() }
    catch { data = emptyRegistry() }
    /*
     * **从盘上来的那一份不拿来比「变没变」**(2026-09-27,卡 BB)。维护者 11:47 那一串假气泡里
     * 有一整批是重启那一下冒的:`agents.json` 里存着上次读到的指纹,工作台一起来读第一拍,
     * 与几十分钟前那一份一比「不一样」→ 判成「它刚回了一句」,九家一起冒。
     * 重启那一拍只重新起算(见 `agentWindowModel.WindowAgentState.stale`)。
     */
    for (const record of Object.values(data.apps)) if (record.last !== undefined) record.last = { ...record.last, stale: true }
  }

  /**
   * **有别人翻过这几家的窗口**(2026-09-27,卡 BB):读额度那一路(卡 AG:切走一家就重读它的额度,
   * 读之前把藏着的家 unhide、读完藏回去)会让窗口上的字整页换。那一下读到的差不是「它说了话」,
   * 所以把这几家下一拍标成「只重新起算」。**只动这一格**:不读壳、不落盘、不冒气泡。
   */
  function windowTouched(bundleIds: readonly string[]): void {
    for (const bundleId of bundleIds) {
      const record = data.apps[bundleId]
      if (record?.last === undefined) continue
      record.last = { ...record.last, stale: true }
    }
  }

  function isConnected(id: string): boolean {
    return data.apps[id]?.state === 'connected' && data.not_agents[id] === undefined
  }

  function displayName(id: string, fallback: string): string {
    // 有专门接法的那几家用那一路的名字(豆包在英文系统上 App 名是 Doubao,界面上一直叫「豆包」)。
    return bindingForBundle(id)?.name ?? fallback
  }

  function identityOf(bundleId: string): AppIdentity {
    const known = live.get(bundleId)
    const record = data.apps[bundleId]
    const fromLive = known?.identity
    const rest = { ...(record?.identity ?? {}), ...(fromLive === undefined ? {} : identityRest(fromLive) ?? {}) }
    return { ...rest, bundle_id: bundleId, name: known?.name ?? record?.name ?? bundleId }
  }

  function ensureRecord(bundleId: string): AppRecord {
    const existing = data.apps[bundleId]
    if (existing !== undefined) return existing
    const identity = identityOf(bundleId)
    const record: AppRecord = {
      bundle_id: bundleId,
      name: identity.name,
      state: 'candidate',
      ...(identityRest(identity) === undefined ? {} : { identity: identityRest(identity) as NonNullable<AppRecord['identity']> }),
    }
    data.apps[bundleId] = record
    return record
  }

  function identityRest(identity: AppIdentity): AppRecord['identity'] | undefined {
    const rest: NonNullable<AppRecord['identity']> = {
      ...(identity.alias === undefined ? {} : { alias: identity.alias }),
      ...(identity.category === undefined ? {} : { category: identity.category }),
      ...(identity.vendor === undefined ? {} : { vendor: identity.vendor }),
      ...(identity.version === undefined ? {} : { version: identity.version }),
      ...(identity.electron === undefined ? {} : { electron: identity.electron }),
    }
    return Object.keys(rest).length === 0 ? undefined : rest
  }

  /** 这一家要不要进「待判」的队。 */
  function consider(bundleId: string, how: AgentFoundHow, delayMs = 0): void {
    if (bundleId === '' || bundleId === own) return
    if (data.not_agents[bundleId] !== undefined) return
    const record = data.apps[bundleId]
    if (CLIENT_DISPATCH_NEVER.includes(bundleId)) {
      // 隐私底线:人跟人聊天的那几家不判、不看、不读(壳那一侧还有一道同样的门)。
      if (record?.verdict?.by !== 'floor') {
        const one = ensureRecord(bundleId)
        one.state = 'not_agent'
        one.verdict = { kind: 'human_chat', reason: '人跟人聊天的应用,工作台永远不读', by: 'floor', stage: 'identity', at: now().toISOString() }
        void saveNow()
      }
      return
    }
    if (record !== undefined && record.state !== 'candidate') return
    /*
     * 结构不像的那一家 30 分钟之内不再看 —— **但「藏在窗口槽里」不算不像**(2026-10-01):
     * 那一下什么都没看见,凭它罚 30 分钟,等于她把一家拉进槽里之后半小时都认不出来。
     */
    if (record?.structure !== undefined && !record.structure.pass && record.structure.hidden !== true
      && nowMs() - Date.parse(record.structure.at) < PROBE_RETRY_MS) return
    const existing = queue.get(bundleId)
    queue.set(bundleId, { how: existing?.how ?? how, notBefore: Math.min(existing?.notBefore ?? Number.POSITIVE_INFINITY, nowMs() + delayMs) })
  }

  function pauseKind(): PauseKind | undefined {
    if (deps.inCall?.() === true) return 'call'
    const helper = deps.helper
    if (helper === undefined || !helper.connected()) return 'no_shell'
    if (helper.supports !== undefined && !helper.supports('agent_window')) return 'old_shell'
    if (helper.view !== undefined && !helper.view().authorized) return 'no_ax'
    return undefined
  }

  /**
   * 要他动一下手才读得了别家窗口的时候,顶栏那一排小灯后面说什么(2026-09-25,统筹:从第一次装的人看,不许空白)。
   * 没授权时点名:已经接上的(读窗口那一路的)+ 已经认出来像 Agent、就等着看窗口的那几家。
   */
  function blockedView(kind: PauseKind | undefined): AgentBlockedView | undefined {
    if (kind === 'old_shell') {
      return { kind: 'old_shell', text: '这台电脑上的工作台 App 是旧版,还看不到别家 Agent 在忙什么 —— 装上新版工作台 App 就好' }
    }
    if (kind !== 'no_ax') return undefined
    const names: string[] = []
    for (const record of Object.values(data.apps)) {
      if (data.not_agents[record.bundle_id] !== undefined || live.get(record.bundle_id)?.running !== true) continue
      // 专门那一路(会话记录)读得到的那几家不靠窗口,不点它的名。
      if (SESSION_SOURCES.some(one => one.bundle_id === record.bundle_id)) continue
      const waiting = record.state === 'connected'
        || (record.state === 'candidate' && (record.verdict?.kind === 'ai_agent' || record.verdict?.kind === 'unsure'))
      if (waiting) names.push(displayName(record.bundle_id, record.name))
    }
    const shown = names.slice(0, BLOCKED_NAMES_MAX).join('、')
    const more = names.length > BLOCKED_NAMES_MAX ? ` 等 ${names.length} 家` : ''
    return names.length === 0
      ? { kind: 'accessibility', text: '要看各家 Agent 在忙什么,得给工作台开「辅助功能」权限' }
      : { kind: 'accessibility', text: `还看不到 ${shown}${more} 在忙什么:得给工作台开「辅助功能」权限`, apps: names }
  }

  /** 开着、却还没判完是不是 Agent 的那几个(模型没接上、今天的额度到了……):明说,不默默不显示。 */
  function pendingNote(): string | undefined {
    const waiting = Object.values(data.apps).filter(one =>
      one.verdict === undefined && one.pending !== undefined && live.get(one.bundle_id)?.running === true
      && data.not_agents[one.bundle_id] === undefined)
    if (waiting.length === 0) return undefined
    return `还有 ${waiting.length} 个开着的 App 没判是不是 Agent:${waiting[0]?.pending ?? ''}`
  }

  // ───────────────────────────── 扫一遍 ─────────────────────────────

  async function scan(how: AgentFoundHow): Promise<void> {
    const helper = deps.helper as DiscoveryHelper
    let raw: Record<string, unknown>
    try { raw = await helper.request({ op: 'running_apps' }, 5000) }
    catch (error) { log(`扫正在跑的 App 没扫成:${errorText(error)}`); lastScanAt = nowMs(); return }
    const apps = Array.isArray(raw.apps) ? raw.apps.filter((one): one is Record<string, unknown> => typeof one === 'object' && one !== null) : []
    const seen = new Set<string>()
    for (const app of apps) {
      const bundleId = typeof app.bundle_id === 'string' ? app.bundle_id : ''
      if (bundleId === '' || bundleId === own) continue
      seen.add(bundleId)
      // 它自己带了中文名就用中文名(界面是中文的;豆包在英文系统上 localizedName 是 Doubao)。
      const local = typeof app.name === 'string' && app.name.trim() !== '' ? app.name.trim() : bundleId
      const zh = typeof app.name_zh === 'string' && app.name_zh.trim() !== '' ? app.name_zh.trim() : undefined
      const name = zh ?? local
      live.set(bundleId, {
        bundle_id: bundleId,
        name,
        running: true,
        active: app.active === true,
        identity: {
          bundle_id: bundleId,
          name,
          ...(zh !== undefined && zh !== local ? { alias: local } : {}),
          ...(typeof app.category === 'string' ? { category: app.category } : {}),
          ...(typeof app.vendor === 'string' ? { vendor: app.vendor } : {}),
          ...(typeof app.version === 'string' ? { version: app.version } : {}),
          ...(typeof app.electron === 'boolean' ? { electron: app.electron } : {}),
        },
      })
      if (app.active === true) activeBundle = bundleId
    }
    for (const [bundleId, app] of live) {
      if (!seen.has(bundleId)) { app.running = false; app.active = false }
    }
    for (const bundleId of seen) {
      consider(bundleId, how)
      if (isConnected(bundleId) && !readDue.has(bundleId)) readDue.set(bundleId, nowMs())
      const record = data.apps[bundleId]
      if (record !== undefined) {
        const known = live.get(bundleId)
        if (known !== undefined && record.name !== known.name) record.name = known.name
        if (record.identity === undefined) {
          const rest = identityRest(identityOf(bundleId))
          if (rest !== undefined) record.identity = rest
        }
      }
    }
    lastScanAt = nowMs()
    scannedOnce = true
    changed()
  }

  // ───────────────────────────── ① 按身份判 ─────────────────────────────

  async function judgeIdentities(): Promise<void> {
    const t = nowMs()
    const need = [...queue.entries()]
      .filter(([bundleId, queued]) => queued.notBefore <= t && data.apps[bundleId]?.verdict === undefined && (judgeRetryAt.get(bundleId) ?? 0) <= t)
      .slice(0, IDENTITY_BATCH)
      .map(([bundleId]) => bundleId)
    if (need.length === 0) return
    const at = now().toISOString()
    const hold = (why: string): void => {
      for (const bundleId of need) {
        ensureRecord(bundleId).pending = why
        judgeRetryAt.set(bundleId, t + JUDGE_RETRY_MS)
      }
    }
    if (deps.judge === undefined) {
      hold('模型服务没接上,判不了它是不是 Agent')
      await saveNow()
      return
    }
    const identities = need.map(identityOf)
    const prompt = identityPrompt(identities)
    const maxTokens = 80 + 60 * identities.length
    const estimate = estimateCallCny([...prompt].length, maxTokens)
    let remaining: number | undefined
    try { remaining = await deps.remainingCny?.() }
    catch { remaining = undefined }
    const gate = budgetGate({ budget: data.budget, today: localDay(now()), estimate, remainingCny: remaining })
    if (!gate.ok) {
      hold(gate.why)
      await saveNow()
      return
    }
    data.budget = spend(data.budget, localDay(now()), estimate)
    let text: string
    try { text = await deps.judge(prompt, maxTokens) }
    catch (error) {
      hold(`问模型没问成:${errorText(error)}`)
      await saveNow()
      return
    }
    const verdicts = parseIdentityVerdicts(text, identities)
    for (const bundleId of need) {
      const record = ensureRecord(bundleId)
      const verdict = verdicts.get(bundleId)
      if (verdict === undefined) {
        record.pending = '模型这次没回这一家,过一阵再判'
        judgeRetryAt.set(bundleId, t + JUDGE_RETRY_MS)
        continue
      }
      delete record.pending
      record.verdict = { ...verdict, by: 'model', stage: 'identity', at }
      if (verdict.kind === 'human_chat' || verdict.kind === 'other') {
        // 不是 Agent:**连窗口结构都不看**。
        record.state = 'not_agent'
        queue.delete(bundleId)
      }
      log(`${record.name}:${verdict.kind}(${verdict.reason})`)
    }
    await saveNow()
    // 判完一批:没授权时顶栏那一句要点名的几家可能变了。
    changed()
  }

  // ───────────────────────────── ② 看结构 ─────────────────────────────

  async function connectRecord(record: AppRecord, how: AgentFoundHow, basis: string): Promise<void> {
    const at = now().toISOString()
    record.state = 'connected'
    record.found = { how, at, basis }
    delete record.pending
    delete record.asked_at
    delete record.ask_again_at
    withdrawAsk(record.bundle_id)
    const name = displayName(record.bundle_id, record.name)
    data.notices = [...data.notices, { id: `n-${record.bundle_id}-${Date.parse(at)}`, text: `新接上一家:${name}`, at, agent: entryIdForBundle(record.bundle_id) }].slice(-20)
    readDue.set(record.bundle_id, nowMs())
    queue.delete(record.bundle_id)
    // 新接上的这一家:下一拍就读它图标的颜色、取它的 logo(卡 LG)。
    lastColorAt = Number.NEGATIVE_INFINITY
    lastIconAt = Number.NEGATIVE_INFINITY
    log(`新接上一家:${name}(${basis})`)
    // 先找它的记录(2026-10-09,根治方案第三节第 2 条):有就走第一级,没有就如实说只能看屏幕。
    log(`${name}:${deps.records?.has(record.bundle_id) === true ? RECORD_LEVEL_LINE : SCREEN_ONLY_NOTE}`)
    await saveNow()
    changed()
  }

  async function askAbout(record: AppRecord): Promise<void> {
    record.state = 'asking'
    record.asked_at = now().toISOString()
    delete record.ask_again_at
    queue.delete(record.bundle_id)
    await saveNow()
    changed()
    putQuestion(record)
  }

  /**
   * 把「XX 像是个 Agent,要接上吗?」挂到外层(卡 M 的提问经纪人)。同一家同时只挂一问;
   * 问没问成(接口抛了)不要紧 —— 登记表里它还在问,下一拍 {@link resumeAsks} 再挂。
   */
  function putQuestion(record: AppRecord): void {
    const asker = deps.asker
    const bundle = record.bundle_id
    if (asker === undefined || liveAsks.has(bundle)) return
    const controller = new AbortController()
    liveAsks.set(bundle, controller)
    const name = displayName(bundle, record.name)
    const settle = (): void => { if (liveAsks.get(bundle) === controller) liveAsks.delete(bundle) }
    let answer: Promise<'yes' | 'no' | 'skip'>
    try { answer = asker.ask({ id: bundle, name, question: askQuestionText(name), basis: recordBasis(record), signal: controller.signal }) }
    catch (error) { settle(); log(`问「${name} 要接上吗」没挂上:${errorText(error)}`); return }
    void answer
      .then(async (said) => {
        settle()
        // 撤掉的那一问(他在别处答了、工作台要停了):回什么都不算他答的。
        if (controller.signal.aborted) return
        if (said === 'yes') await connect(entryIdForBundle(bundle))
        else if (said === 'no') await notAgent(entryIdForBundle(bundle))
        else await snooze(bundle)
      })
      .catch((error: unknown) => { settle(); log(`问「${name} 要接上吗」没问成:${errorText(error)}`) })
  }

  /** 撤掉挂在外层的那一问(两端那一张跟着消失)。 */
  function withdrawAsk(bundle: string): void {
    const controller = liveAsks.get(bundle)
    if (controller === undefined) return
    liveAsks.delete(bundle)
    controller.abort()
  }

  /** 他说「先不管」:这一家照旧不读,过一阵再问。 */
  async function snooze(bundle: string): Promise<void> {
    const record = data.apps[bundle]
    if (record === undefined || record.state !== 'asking') return
    record.ask_again_at = new Date(nowMs() + ASK_SNOOZE_MS).toISOString()
    log(`${displayName(bundle, record.name)}:先不管,${new Date(record.ask_again_at).toLocaleDateString('zh-CN')} 再问`)
    await saveNow()
    changed()
  }

  /**
   * 登记表里还在问、外层却没挂着的那几家再挂一次:工作台重启过(经纪人只在内存里)、「先不管」到期了、上一次没挂上。
   * 只是往外层摆一问,不碰任何窗口 —— 所以不跟着「通话中 / 壳没接上」停。
   */
  async function resumeAsks(): Promise<void> {
    if (deps.asker === undefined) return
    const t = nowMs()
    let expired = false
    for (const record of Object.values(data.apps)) {
      if (record.state !== 'asking' || data.not_agents[record.bundle_id] !== undefined || liveAsks.has(record.bundle_id)) continue
      if (isSnoozed(record, t)) continue
      if (record.ask_again_at !== undefined) {
        delete record.ask_again_at
        record.asked_at = now().toISOString()
        expired = true
      }
      putQuestion(record)
    }
    if (expired) { await saveNow(); changed() }
  }

  async function probeOne(): Promise<void> {
    const t = nowMs()
    const next = [...queue.entries()].find(([bundleId, queued]) => {
      const kind = data.apps[bundleId]?.verdict?.kind
      return queued.notBefore <= t && (kind === 'ai_agent' || kind === 'unsure') && live.get(bundleId)?.running !== false
    })
    if (next === undefined) return
    const [bundleId, queued] = next
    queue.delete(bundleId)
    const record = ensureRecord(bundleId)
    const at = now().toISOString()
    let raw: Record<string, unknown>
    try { raw = await (deps.helper as DiscoveryHelper).request({ op: 'agent_probe', bundle_id: bundleId }, 8000) }
    catch (error) {
      record.structure = { pass: false, surface: false, input: false, send: false, new_chat: false, why: `读不到它的窗口:${errorText(error)}`, at }
      await saveNow()
      return
    }
    const probe = parseProbe(raw)
    if (!probe.running) {
      const one = live.get(bundleId)
      if (one !== undefined) one.running = false
      return
    }
    const structure = judgeStructure(probe)
    record.structure = { ...structure, at }
    /*
     * 这扇窗的结构摘要(2026-10-01,诊断用)。**只有数、没有一个字的内容**;每看一次就更新一次,
     * 结构没过的那几家(Air 上的新 Kimi、可灵、App Store 版豆包)下一次不用再上真机猜它长什么样。
     */
    record.ax = axSummaryOf(probe, at)
    /*
     * ★ **输入框认不出的那几家,再多问一句「那棵树长什么样」**(2026-10-02,卡「适配自绘界面的 Kimi」)。
     *
     * 10-01 只带角色的个数,于是 Air 上那几家(官网 Kimi `…kmp.mac`、可灵、App Store 版豆包)
     * 隔着一台机器只看得出「它是自绘界面」,写不出「输入框是哪一个节点、怎么往里写」。
     * 这一问把明细收进登记表 → 进诊断包,下一份一摆出来读法当场写得出。
     *
     * 纪律:① 只对认不出输入框的那几家问(`wantsAxDetail`);② 老壳不认这个 op → 吞掉,
     * 这一格缺席,**不许因为多问了一句就把结构那一道的结论改掉**;③ 一个字的内容都不收(`parseAxDetail`)。
     */
    if (wantsAxDetail(structure)) {
      try {
        const detail = await (deps.helper as DiscoveryHelper).request({ op: 'agent_ax_detail', bundle_id: bundleId }, 8000)
        record.ax_detail = parseAxDetail(detail, at)
      }
      catch { delete record.ax_detail }
    }
    else delete record.ax_detail
    log(`${record.name} 的窗口:${structure.why}`)
    if (!structure.pass) {
      /*
       * ★ **藏在窗口槽里 ≠ 它不像对话窗口**(2026-10-01)。藏它的手是工作台自己,这一下**什么都没看见**。
       * 所以:已经接上的那一家**不降级**(她的「豆包办公」不能因为被我们藏了就退回候选),
       * 也不按 30 分钟那道冷却等着 —— 过一小会儿再看一眼;她切到那一格时壳的 activated 事件也会把它推回队里。
       */
      if (structure.hidden === true) {
        queue.set(bundleId, { how: queued.how, notBefore: t + HIDDEN_RETRY_MS })
        await saveNow()
        return
      }
      /**
       * ★ **目录认识的那几家不被这一道挡住**(2026-10-02,卡「引擎接线与删复制品」;
       * 设计 `docs/设计-一条引擎替八条管线-2026-10-02.md` 第七节「四件套的根子」)。
       *
       * 「这扇窗像不像对话窗口」回答的是**窗口这一条通道此刻会不会送 / 读 / 点**,
       * 不是「这是不是一家」。两件真机上发生过的事都栽在这里:
       * - Kimi(kmp 版把输入框画成 `AXUnknown`)永远过不了「有输入框」→ **永远不在 @ 候选里**;
       * - Codex 把窗一关(`windows === 0`)就掉出候选 —— 哪怕 `codex app-server` 好好的、那条路不要窗口。
       *
       * 家族目录认识它 = 工作台为它写过专门代码 = **它就是一家**;
       * 能做什么由各适配器现查(`registry.targets().can`),窗口结构只是其中一项。
       */
      if (bindingForBundle(bundleId) !== undefined) {
        await connectRecord(record, queued.how, recordBasis(record))
        return
      }
      record.state = 'candidate'
      await saveNow()
      return
    }
    if (record.verdict?.kind === 'ai_agent') {
      await connectRecord(record, queued.how, recordBasis(record))
      return
    }
    /*
     * ★ **目录认识的那几家不判身份**(2026-10-02,同上):工作台为它写过专门代码,
     * 「它是哪一家」是事实,不是模型的意见。模型判「这是不是个 AI 应用」**只对目录不认识的陌生 App**
     * 用一次(可灵 `com.electron.klingai` 那一类),判成了之后当一家喂进引擎的登记处。
     */
    if (bindingForBundle(bundleId) !== undefined) {
      await connectRecord(record, queued.how, recordBasis(record))
      return
    }
    // 身份拿不准、结构又像:带上界面字再判一次(界面字里没有聊天内容)。
    if (deps.judge === undefined) {
      await askAbout(record)
      return
    }
    const prompt = windowPrompt(identityOf(bundleId), probe)
    const estimate = estimateCallCny([...prompt].length, 160)
    let remaining: number | undefined
    try { remaining = await deps.remainingCny?.() }
    catch { remaining = undefined }
    const gate = budgetGate({ budget: data.budget, today: localDay(now()), estimate, remainingCny: remaining })
    if (!gate.ok) {
      record.pending = gate.why
      queue.set(bundleId, { how: queued.how, notBefore: t + JUDGE_RETRY_MS })
      await saveNow()
      return
    }
    data.budget = spend(data.budget, localDay(now()), estimate)
    let verdict = undefined as ReturnType<typeof parseWindowVerdict>
    try { verdict = parseWindowVerdict(await deps.judge(prompt, 160)) }
    catch (error) {
      record.pending = `问模型没问成:${errorText(error)}`
      queue.set(bundleId, { how: queued.how, notBefore: t + JUDGE_RETRY_MS })
      await saveNow()
      return
    }
    const final = verdict ?? { kind: 'unsure' as const, reason: '模型回的不是约定的格式' }
    record.verdict = { ...final, by: 'model', stage: 'window', at }
    delete record.pending
    if (final.kind === 'ai_agent') await connectRecord(record, queued.how, recordBasis(record))
    else if (final.kind === 'unsure') await askAbout(record)
    else {
      record.state = 'not_agent'
      await saveNow()
    }
  }

  // ───────────────────────────── 读窗口 ─────────────────────────────

  async function readOne(record: AppRecord): Promise<void> {
    const bundleId = record.bundle_id
    const name = displayName(bundleId, record.name)
    let raw: Record<string, unknown>
    try { raw = await (deps.helper as DiscoveryHelper).request({ op: 'agent_read', bundle_id: bundleId }, 6000) }
    catch (error) {
      const why = `读 ${name} 的窗口时出错:${errorText(error)}`
      const { state } = nextWindowState(record.last, { ok: false, busy: false, titles: [], gaps: { status: why, title: why, latest: why } }, { now: now(), active: false, name })
      record.last = state
      readDue.set(bundleId, nowMs() + READ_IDLE_MS)
      saveSoon()
      changed()
      return
    }
    const parsed = parseRead(raw)
    /*
     * 豆包窗口里摆着的那道选择题(2026-09-28 Air 维护包;认法见 `doubaoVisibleForm`)。同一条对话才沿用上一次那道题的 `since`。
     * 按家族认(2026-10-12):豆包 / 豆包办公 / 豆包工作 哪个包都算,判断里不写包名。
     */
    const isDoubao = familyAsksInWindow(bundleId)
    const formAsk = isDoubao
      ? doubaoVisibleForm(parsed, record.last?.title === titleFromWindow(parsed.title, name, [record.name]) ? record.last?.formAsk : undefined, now().toISOString(), name)
      : undefined
    /*
     * 豆包的侧栏只认真正的对话链接(`AXLink`),账号 / 套餐那几行不是对话(2026-09-28 Air 维护包);
     * 行尾那个「待确认」角标不是标题的一部分。壳没报 `r` 的老版本照旧全收。
     */
    const sideRows = Array.isArray(raw.side) ? raw.side as Record<string, unknown>[] : []
    const read: WindowRead = isDoubao && sideRows.some(row => row.r === 'AXLink')
      ? { ...parsed, side: parsed.side.filter((_, i) => sideRows.filter(row => typeof row.t === 'string')[i]?.r === 'AXLink').map(row => ({ ...row, t: row.t.replace(/\s+待确认\s*$/u, '') })) }
      : parsed
    const one = live.get(bundleId) ?? { bundle_id: bundleId, name: record.name, running: false, active: false }
    live.set(bundleId, one)
    if (!read.running) {
      one.running = false
      one.active = false
      readDue.delete(bundleId)
      changed()
      return
    }
    one.running = true
    // 它自己那个 App 名也一起给(卡 AC):界面上叫「豆包办公」「Codex」,它的窗口标题写的是
    // 「豆包」「ChatGPT」—— 两个名字都认,才不会把 App 名当成一条对话的标题。
    const summarized = summarizeRead(read, name, [record.name])
    /*
     * 停止键读不到(没字的图标)或压根没有(千问办公)的那几家,窗口上的「正在写入文件 / 正在思考 ... 7.3s」
     * 这类进度字补一个「在跑」(2026-10-08 起各家都认,见 `windowProgressBusy`)。
     */
    const progress = summarized.ok
      ? windowProgressBusy({ bundleId, read, ...(summarized.title === undefined ? {} : { title: summarized.title }), nowMs: nowMs(), ...(progressSeen.get(bundleId) === undefined ? {} : { seen: progressSeen.get(bundleId) as ProgressSeen }) })
      : { busy: false }
    if (progress.seen === undefined) progressSeen.delete(bundleId)
    else progressSeen.set(bundleId, progress.seen)
    const summary = progress.busy && !summarized.busy ? { ...summarized, busy: true } : summarized
    /*
     * **有文件型会话源的那几家只补标题**(2026-09-27,卡 GB):Claude / Codex / Kimi 的在跑与做完
     * 以 `/state.sessions` 那一路为准,窗口这一只手在它们身上不冒气泡、不下状态(见 `windowTitleOnly`)。
     */
    const next = nextWindowState(record.last, summary, {
      now: now(),
      active: read.active === true,
      name,
      // 读得到它自己记录的那几家同样只补标题(2026-10-08):在跑 / 做完以它的库为准。
      ...(windowTitleOnly(bundleId) || recordReads.has(bundleId) ? { titleOnly: true } : {}),
    })
    const state = formAsk === undefined ? next.state : { ...next.state, formAsk }
    // 一道新题(`since` 变了)冒一句气泡「豆包办公 在等你选:…」;同一道题不重复冒。
    const bubble = formAsk !== undefined && record.last?.formAsk?.since !== formAsk.since
      ? { kind: 'replied' as const, text: `${name} 在等你选:${clipText(formAsk.question, 40)}`, at: formAsk.since ?? now().toISOString() }
      : next.bubble
    const visible = !sameVisible(record.last, state)
    /**
     * 这是**第一次**读到它(刚接上、刚装好):`visible` 天然为真,但那不是「有动静」——
     * 它只是第一次被看见。不拿这个开密读,否则一启动九家一起密读三分钟,白烧辅助功能调用。
     */
    const firstEver = record.last === undefined
    record.last = state
    if (bubble !== undefined) {
      bubbles.set(entryIdForBundle(bundleId), bubble)
      log(bubble.text)
    }
    if (state.status === 'running') {
      idleStreak.delete(bundleId)
      // 在跑就一直算「有动静」:它停下来之后那几分钟也照密读,免得「跑完 → 又跑起来」这一下漏掉。
      markHot(bundleId)
      readDue.set(bundleId, nowMs() + READ_BUSY_MS)
    }
    else {
      const streak = visible ? 0 : (idleStreak.get(bundleId) ?? 0) + 1
      idleStreak.set(bundleId, streak)
      // 这一次读到内容变了(它刚说了什么 / 他刚说了什么)→ 接着密读几分钟:紧跟着的那一轮多半马上就来。
      if (visible && !firstEver) markHot(bundleId)
      /*
       * **她正停在它前面 → 一直算「有动静」**(2026-10-08 千问办公):她在那扇窗里看完第一轮、过了三分钟又发第二轮,
       * 密读那三分钟早过了,第二轮整段跑完都没被读到 —— 「运行中」一次都没冒。她在它前面时随时可能发下一句。
       */
      if (read.active === true) markHot(bundleId)
      /**
       * 「刚有动静」那几分钟里,空闲也按在跑的节奏读(卡 WS):否则他说一句、那家半分钟答完,
       * 三分钟后才去读,看到的只剩「不在跑、内容变了」—— 「开始跑了」那颗气泡与白点永远等不到。
       */
      readDue.set(bundleId, nowMs() + (isHot(bundleId) ? READ_BUSY_MS : streak >= 3 ? READ_IDLE_SLOW_MS : READ_IDLE_MS))
    }
    if (visible || bubble !== undefined) {
      saveSoon()
      changed()
    }
  }

  // ───────────────────────────── 它自己的记录 ─────────────────────────────

  /**
   * 有本机对话库的那几家读一次(2026-10-08)。不碰壳、不碰辅助功能:窗口藏着也照样准。
   * 开始跑 / 跑完冒的气泡与读窗口那几家同一种;她正停在它那扇窗前时不冒、不记没看过(同读窗口)。
   */
  function refreshRecords(): void {
    const readers = deps.records
    if (readers === undefined) return
    const at = now().toISOString()
    for (const record of Object.values(data.apps)) {
      const bundleId = record.bundle_id
      if (record.state !== 'connected' || data.not_agents[bundleId] !== undefined || !readers.has(bundleId)) continue
      const name = displayName(bundleId, record.name)
      const read = readers.read(bundleId)
      const ok = read !== undefined
      if (recordOk.get(bundleId) !== ok) {
        log(ok ? `${name}:读它自己的记录` : `${name}:它的记录这会儿读不了,退回读窗口`)
        recordOk.set(bundleId, ok)
        // 退回读窗口:马上读一次,别等空闲那三分钟。
        if (!ok && isConnected(bundleId)) readDue.set(bundleId, nowMs())
        changed()
      }
      if (read === undefined) {
        recordReads.delete(bundleId)
        recordTrack.delete(bundleId)
        continue
      }
      recordReads.set(bundleId, read)
      const active = live.get(bundleId)?.active === true
      const newestDone = read.chats.reduce((max, one) => one.finished_at !== undefined && one.finished_at > max ? one.finished_at : max, '')
      if (record.records_read_at === undefined || (active && newestDone > record.records_read_at)) {
        // 第一次读到(接上之前的旧对话不算没看过),或她正看着它时收尾的那一轮。
        record.records_read_at = at
        saveSoon()
      }
      const sig = JSON.stringify(read.chats.map(one => [one.id, one.status, one.title, one.latest, one.updated_at]))
      const busy = read.chats.some(one => one.status === 'running')
      const prev = recordTrack.get(bundleId)
      recordTrack.set(bundleId, { sig, busy })
      if (prev === undefined || prev.sig === sig) continue
      const id = entryIdForBundle(bundleId)
      if (!active && busy && !prev.busy) bubbles.set(id, { kind: 'started', text: `${name} 开始跑了`, at })
      else if (!active && prev.busy && !busy) {
        const latest = read.chats[0]?.latest
        bubbles.set(id, { kind: 'replied', text: latest === undefined ? `${name} 回完了` : `${name} 回了:${clipText(latest, 40)}`, at })
      }
      changed()
    }
  }

  async function readSome(): Promise<void> {
    const t = nowMs()
    const due = [...readDue.entries()].filter(([, at]) => at <= t).sort((a, b) => a[1] - b[1]).slice(0, 2)
    for (const [bundleId] of due) {
      const record = data.apps[bundleId]
      if (record === undefined || !isConnected(bundleId) || live.get(bundleId)?.running === false) {
        readDue.delete(bundleId)
        continue
      }
      await readOne(record)
    }
  }

  // ───────────────────────────── 专门读法的气泡 ─────────────────────────────

  /** 有会话记录的那几家:开始跑、跑完了,同样冒一下(与读窗口那几家同一种气泡)。 */
  function trackFeedBubbles(sessions: readonly SessionView[]): void {
    const at = now().toISOString()
    for (const binding of SESSION_SOURCES) {
      const id = entryIdOf(binding)
      const mine = sessions.filter(one => one.agent === binding.agent)
      if (mine.length === 0) { feedTrack.delete(id); continue }
      const status = mine.some(one => one.status === 'running') ? 'running' : mine.some(one => one.status === 'waiting') ? 'waiting' : 'idle'
      const newest = [...mine].sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at))[0]
      const prev = feedTrack.get(id)
      feedTrack.set(id, { status, ...(newest?.summary === undefined ? {} : { latest: newest.summary }) })
      if (prev === undefined) continue
      const name = binding.name
      if (status === 'running' && prev.status !== 'running') bubbles.set(id, { kind: 'started', text: `${name} 开始跑了`, at })
      else if (prev.status === 'running' && status !== 'running') {
        const latest = newest?.summary
        bubbles.set(id, { kind: 'replied', text: latest === undefined ? `${name} 回完了` : `${name} 回了:${clipText(latest, 40)}`, at })
      }
    }
  }

  // ───────────────────────────── 各家的颜色 ─────────────────────────────

  /**
   * 各家图标的主色(头像、小灯、手机上那一家的颜色;2026-09-25 卡 Q,维护者:「Claude 是橙色的」)。
   * 界面上出现的每一家 —— 接上了的、有专门读法的、工作台自己 —— 没读过就读一次(壳的 `icon_colors`,不碰辅助功能),
   * 读过的七天再读;没装的一天再看一眼。旧壳没有这个本事就不读,界面上一律中性灰。
   */
  async function refreshColors(): Promise<void> {
    const helper = deps.helper
    if (helper === undefined || !helper.connected()) return
    if (helper.supports !== undefined && !helper.supports('icon_color')) return
    const t = nowMs()
    if (t - lastColorAt < COLOR_MIN_GAP_MS) return
    const wanted = new Set<string>([OWN_BUNDLE_ID])
    for (const binding of FAMILY_SOURCES) if (binding.bundle_id !== undefined) wanted.add(binding.bundle_id)
    for (const record of Object.values(data.apps)) if (record.state === 'connected') wanted.add(record.bundle_id)
    const due = [...wanted].filter((bundleId) => {
      const known = data.colors[bundleId]
      if (known === undefined) return true
      const age = t - Date.parse(known.at)
      return !Number.isFinite(age) || age >= (known.color === undefined ? COLOR_MISSING_RETRY_MS : COLOR_REFRESH_MS)
    })
    if (due.length === 0) return
    lastColorAt = t
    let raw: Record<string, unknown>
    try { raw = await helper.request({ op: 'icon_colors', bundle_ids: due }, 8000) }
    catch (error) { log(`读图标颜色没读成:${errorText(error)}`); return }
    const colors = typeof raw.colors === 'object' && raw.colors !== null ? raw.colors as Record<string, unknown> : {}
    const at = now().toISOString()
    for (const bundleId of due) {
      const color = colors[bundleId]
      data.colors[bundleId] = typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color) ? { color, at } : { at }
    }
    await saveNow()
    changed()
  }

  // ───────────────────────────── 各家的 logo ─────────────────────────────

  /**
   * 界面上出现的每一家该有哪一个包的图标(2026-09-26,卡 LG)。与颜色那一份同一套口径:
   * 接上了的、有专门读法的、工作台自己(事务官那一格用工作台自己的图标)。
   */
  function iconBundles(): string[] {
    const wanted = new Set<string>([OWN_BUNDLE_ID])
    for (const binding of FAMILY_SOURCES) if (binding.bundle_id !== undefined) wanted.add(binding.bundle_id)
    for (const record of Object.values(data.apps)) if (record.state === 'connected') wanted.add(record.bundle_id)
    // 他说过「这不是 Agent」的那几家不要(界面上本来就没有它们)。
    return [...wanted].filter(bundleId => data.not_agents[bundleId] === undefined)
  }

  /**
   * 各家的 **logo**(2026-09-26,卡 LG;维护者:「把对应的 logo 也搞上;桌面端的应用标签,也加各家的 logo icon」)。
   * 沿颜色那条现成的路:界面上出现的每一家没取过就取一次(壳的 `app_icon`,不碰辅助功能),取过的七天再取;
   * 没取到的一天再看一眼。**一拍最多取几张**(一张十几 KB,别一口气占住那条长连)。
   * 旧壳没有这件本事就一张都不取,界面上一律退回色点(这块功能之前的样子)。
   */
  async function refreshIcons(): Promise<void> {
    const helper = deps.helper
    if (helper === undefined || !helper.connected()) return
    if (helper.supports !== undefined && !helper.supports('app_icon')) return
    const t = nowMs()
    if (t - lastIconAt < ICON_MIN_GAP_MS) return
    const due = icons.due(iconBundles(), t).slice(0, ICON_PER_TICK)
    if (due.length === 0) return
    lastIconAt = t
    const at = now().toISOString()
    let got = false
    for (const bundleId of due) {
      let raw: Record<string, unknown>
      try { raw = await helper.request({ op: 'app_icon', bundle_id: bundleId, size: ICON_SIDE }, 8000) }
      catch (error) { log(`取 ${bundleId} 的图标没取成:${errorText(error)}`); return }
      const icon = parseIconResponse(raw, at)
      icons.set(bundleId, icon, at)
      if (icon !== undefined) got = true
      log(iconLogLine(bundleId, icon))
    }
    // 取到了新的一张:界面上那一格 `icon` 从假变真,推一份快照(图片本身不在快照里)。
    if (got) changed()
  }

  /**
   * **现在就**去取一个包的图标(2026-09-26,卡 LG2;`GET /apps/icon/:key` 走这条)。
   *
   * 与上面那一份的分工:登记表里那几家是**巡检预取**(界面按 `entries[].icon` 决定画不画,
   * 所以必须先取到);坞上这几格是**按需取** —— 界面不知道有没有图,`<img>` 直接发请求,
   * 第一趟就得给出答案(先回 404 的话 `onError` 一退就再也不试了,那一格永远是个方块)。
   *
   * 三道闸都在:
   * - **缓存**先看(同 LG 那一份 `IconCache`,键是包标识);取过的直接回,没取到的那一家
   *   一天之内不再问壳(`icons.due` 的口径)—— 一格没装的应用不会每刷一次页面就问一遍 LaunchServices;
   * - **同一个包同时只问一次**(`iconsInFlight`):坞上十几格是同时发的请求;
   * - 壳没接上 / 是旧版没有 `app_icon` → undefined(接口 404,界面画中性小方块)。
   *
   * 不动 `lastIconAt`:那道最小间隔管的是巡检那条自动的路,而这一条是他打开页面**要看图**,
   * 把它按住只会让坞上一排格子一分钟一格地慢慢长出图来。
   */
  async function appIcon(bundleId: string): Promise<AgentIcon | undefined> {
    const trimmed = bundleId.trim()
    if (trimmed === '') return undefined
    const cached = icons.get(trimmed)
    if (cached !== undefined) return cached
    const inFlight = iconsInFlight.get(trimmed)
    if (inFlight !== undefined) return await inFlight
    // 取过、没取到、还没到再看一眼的时候:不问壳(`due` 里没有它)。
    if (!icons.due([trimmed], nowMs()).includes(trimmed)) return undefined
    const helper = deps.helper
    if (helper === undefined || !helper.connected()) return undefined
    if (helper.supports !== undefined && !helper.supports('app_icon')) return undefined
    const at = now().toISOString()
    const task = (async (): Promise<AgentIcon | undefined> => {
      let raw: Record<string, unknown>
      try { raw = await helper.request({ op: 'app_icon', bundle_id: trimmed, size: ICON_SIDE }, 8000) }
      // 壳那一趟没成(断了、超时、旧壳回「未知 op」):**不记进缓存** —— 那不是「这台电脑上没有这张图」,
      // 下一次请求该再试一遍。
      catch (error) { log(`取 ${trimmed} 的图标没取成:${errorText(error)}`); return undefined }
      const icon = parseIconResponse(raw, at)
      icons.set(trimmed, icon, at)
      log(iconLogLine(trimmed, icon))
      return icon
    })()
    iconsInFlight.set(trimmed, task)
    try { return await task }
    finally { iconsInFlight.delete(trimmed) }
  }

  // ───────────────────────────── 一拍 ─────────────────────────────

  async function tick(): Promise<void> {
    if (ticking) return
    ticking = true
    try {
      await ensureLoaded()
      await resumeAsks()
      // 读它自己的记录不靠壳与辅助功能(壳没接上、没授权也照读);通话中照样全停。
      if (deps.inCall?.() !== true) refreshRecords()
      const kind = pauseKind()
      const wasPaused = paused
      pausedKind = kind
      note = kind === 'old_shell' ? '这台电脑上的工作台 App 还是旧版,读不了别家的窗口 —— 装上新版工作台 App 就好' : undefined
      paused = kind === undefined ? undefined : PAUSE_TEXT[kind]
      if (wasPaused !== paused) changed()
      // 还没开「辅助功能」权限:窗口一扇都不碰;正在跑的是哪几个 App、像不像 Agent 照样判(只看包里写的名字与类别,
      // 不碰辅助功能)—— 顶栏那一句好点名「还看不到 Muse、Manus 在忙什么」,而不是一片空白。
      if (kind !== undefined && kind !== 'no_ax') return
      const t = nowMs()
      const lacksIdentity = [...queue.keys()].some(bundleId => live.get(bundleId)?.identity === undefined && data.apps[bundleId]?.verdict === undefined)
      if (t - lastScanAt >= SCAN_EVERY_MS || (lacksIdentity && t - lastScanAt >= 10_000)) {
        await scan(scannedOnce ? 'patrol' : 'startup')
      }
      await judgeIdentities()
      await refreshColors()
      await refreshIcons()
      if (kind === 'no_ax' || deps.inCall?.() === true) return
      await probeOne()
      if (deps.inCall?.() === true) return
      await readSome()
    }
    catch (error) { log(`这一拍没走完:${errorText(error)}`) }
    finally { ticking = false }
  }

  function handleAppEvent(event: AppEvent): void {
    const bundleId = event.bundle_id
    if (bundleId === '' || bundleId === own) return
    // 事件里的名字是系统语言下的那个;扫过一遍(知道它自己带的中文名)之后就不拿事件里的覆盖。
    const one = live.get(bundleId) ?? { bundle_id: bundleId, name: event.name?.trim() || bundleId, running: false, active: false }
    live.set(bundleId, one)
    const t = nowMs()
    if (event.event === 'terminated') {
      one.running = false
      one.active = false
      readDue.delete(bundleId)
      queue.delete(bundleId)
      if (activeBundle === bundleId) activeBundle = undefined
      if (isConnected(bundleId)) changed()
      return
    }
    one.running = true
    if (event.event === 'launched') {
      consider(bundleId, 'launch', LAUNCH_SETTLE_MS)
      return
    }
    // activated
    const previous = activeBundle
    activeBundle = bundleId
    for (const app of live.values()) app.active = app.bundle_id === bundleId
    consider(bundleId, 'activate')
    if (isConnected(bundleId)) {
      readDue.set(bundleId, Math.min(readDue.get(bundleId) ?? Number.POSITIVE_INFINITY, t + READ_AFTER_ACTIVATE_MS))
      // 他刚切过去 = 刚有动静:接下来几分钟密读(他多半正要在里面说一句)。
      markHot(bundleId)
      // 在它前面停够几秒 = 看过了。
      if (dwellTimer !== undefined) clearTimeoutFn(dwellTimer)
      dwellTimer = setTimeoutFn(() => {
        dwellTimer = undefined
        if (activeBundle === bundleId) void markRead(entryIdForBundle(bundleId))
      }, MARK_READ_DWELL_MS)
    }
    if (previous !== undefined && previous !== bundleId && isConnected(previous)) {
      readDue.set(previous, Math.min(readDue.get(previous) ?? Number.POSITIVE_INFINITY, t + READ_AFTER_LEAVE_MS))
      // 他从它切走,多半是刚在里面发出去一句 —— 这几分钟正是它在跑的那几分钟,密读。
      markHot(previous)
    }
  }

  // ───────────────────────────── 他说的话 ─────────────────────────────

  async function notAgent(id: string): Promise<{ ok: boolean, note: string }> {
    await ensureLoaded()
    // id 是登记表里的(Claude 那几家是 claude / codex / kimi,别的是包标识);登记簿按包标识记。
    const bundle = bundleForEntry(id)
    if (bundle === undefined) return { ok: false, note: '事务官自己撤不掉' }
    const known = data.apps[bundle] ?? (live.has(bundle) || bindingForBundle(bundle) !== undefined ? ensureRecord(bundle) : undefined)
    if (known === undefined) return { ok: false, note: '登记表里没有这一家' }
    const name = displayName(bundle, known.name)
    const at = now().toISOString()
    data.not_agents[bundle] = { name, at }
    // 那一家的「新接上一家」一并收掉(他已经说了不是)。
    for (const notice of data.notices) if (notice.agent === entryIdForBundle(bundle)) notice.dismissed = true
    known.state = 'not_agent'
    known.verdict = { kind: 'other', reason: '你说这不是 Agent', by: 'user', stage: 'identity', at }
    delete known.asked_at
    delete known.ask_again_at
    withdrawAsk(bundle)
    queue.delete(bundle)
    readDue.delete(bundle)
    bubbles.delete(entryIdForBundle(bundle))
    feedTrack.delete(entryIdForBundle(bundle))
    await saveNow()
    changed()
    return { ok: true, note: `好,${name} 不算 Agent 了,以后不读它` }
  }

  async function connect(id: string): Promise<{ ok: boolean, note: string }> {
    await ensureLoaded()
    const bundle = bundleForEntry(id)
    if (bundle === undefined) return { ok: true, note: '事务官一直在' }
    const known = data.apps[bundle] ?? (live.has(bundle) ? ensureRecord(bundle) : undefined)
    if (known === undefined && data.not_agents[bundle] === undefined) return { ok: false, note: '没找到这一家(它得开着,或者之前判过)' }
    const record = known ?? ensureRecord(bundle)
    delete data.not_agents[bundle]
    record.verdict = { kind: 'ai_agent', reason: '你说它是 Agent', by: 'user', stage: 'identity', at: now().toISOString() }
    await connectRecord(record, 'user', recordBasis(record) || '你说它是 Agent')
    return { ok: true, note: `接上了:${displayName(bundle, record.name)}` }
  }

  async function markRead(id: string): Promise<boolean> {
    await ensureLoaded()
    const bundle = bundleForEntry(id)
    const record = bundle === undefined ? undefined : data.apps[bundle]
    const hadBubble = bubbles.delete(id)
    if (record !== undefined && bundle !== undefined && recordReads.has(bundle)) {
      // 读它自己记录的那几家:她看过了 = 这一刻之前收尾的都看过了。
      record.records_read_at = now().toISOString()
      saveSoon()
      changed()
      return true
    }
    if (record?.last === undefined || !record.last.unread) {
      if (hadBubble) changed()
      return hadBubble
    }
    record.last = { ...record.last, unread: false }
    saveSoon()
    changed()
    return true
  }

  async function dismissNotice(id: string): Promise<boolean> {
    await ensureLoaded()
    const notice = data.notices.find(one => one.id === id)
    if (notice === undefined) return false
    notice.dismissed = true
    await saveNow()
    changed()
    return true
  }

  /**
   * **同一拍只出一份**(2026-10-21 急修「8791 空转」)。一次 `/state` 里派活对象表、额度、体检、引导各自回头问登记表,
   * 光派活引擎那一处就是每家问一次 —— 真机采样里一拍要现算十来遍。复用的条件:同一段同步执行(下一个微任务就作废)、
   * 同一秒、会话表一字不差、中间没喊过 `changed()`(登记表的每一处改动都从那里推快照)。拿到的那一份调用方只读。
   */
  let viewMemo: { sec: number, sessions: string, view: AgentRegistryView } | undefined

  function view(): AgentRegistryView {
    const sessions = deps.sessions?.() ?? []
    const sec = Math.floor(nowMs() / 1000)
    const sessionsKey = JSON.stringify(sessions)
    if (viewMemo !== undefined && viewMemo.sec === sec && viewMemo.sessions === sessionsKey) return viewMemo.view
    const fresh = composeView(sessions)
    const mine = { sec, sessions: sessionsKey, view: fresh }
    viewMemo = mine
    queueMicrotask(() => { if (viewMemo === mine) viewMemo = undefined })
    return fresh
  }

  function composeView(sessions: readonly SessionView[]): AgentRegistryView {
    trackFeedBubbles(sessions)
    const notes = [note, pendingNote()].filter((one): one is string => one !== undefined)
    const blocked = blockedView(pausedKind)
    return {
      ...registryView({
        data,
        running: bundleId => live.get(bundleId)?.running,
        sessions,
        bubbles,
        hasIcon: bundleId => icons.has(bundleId),
        now: now(),
        paused,
        note: notes.length === 0 ? undefined : notes.join(';'),
        // 读窗口那条会话有没有一问在等他(卡 WS):同一份判断,只挂 `ask` 不改运行状态。
        ...(deps.askOf === undefined ? {} : { askOf: deps.askOf }),
        ...(deps.records === undefined ? {} : {
          records: (bundleId: string) => {
            if (deps.records?.has(bundleId) !== true) return undefined
            const read = recordReads.get(bundleId)
            return { label: RECORD_SOURCE_LABEL, ...(read === undefined ? {} : { read }) }
          },
        }),
      }),
      ...(blocked === undefined ? {} : { blocked }),
    }
  }

  return {
    async start() {
      await ensureLoaded()
      if (timer === undefined) timer = setIntervalFn(() => { void tick() }, tickMs)
      void tick()
    },
    async stop() {
      if (timer !== undefined) { clearIntervalFn(timer); timer = undefined }
      if (dwellTimer !== undefined) { clearTimeoutFn(dwellTimer); dwellTimer = undefined }
      // 挂在外层的那几问一起撤(登记表里它们还在问,下次起来再挂)。
      for (const bundle of [...liveAsks.keys()]) withdrawAsk(bundle)
      if (saveTimer !== undefined) await saveNow()
    },
    tick,
    handleAppEvent,
    windowTouched,
    helperChanged() {
      // 壳(重新)连上:马上扫一遍(工作台启动时那一遍就是这么来的)。
      lastScanAt = Number.NEGATIVE_INFINITY
    },
    nudge(bundleId) {
      if (!isConnected(bundleId)) return
      readDue.set(bundleId, Math.min(readDue.get(bundleId) ?? Number.POSITIVE_INFINITY, nowMs() + 3000))
      // 刚送了话进去:接下来几分钟按在跑的节奏读(卡 WS)—— 一次读不够,那一轮可能几十秒就答完了。
      markHot(bundleId)
    },
    windows() {
      const out: WindowWaitRef[] = []
      // 专门读法那一路有会话的几家(Claude / Codex / Kimi 开着对话时)在登记表里用的是**那一路的会话**,
      // 读窗口读出来的那一条根本不上表(见 agentRegistry.entryView 的 `feed.length > 0`)——
      // 这里跟着同一条判据跳过,免得替一条没人看的会话去问模型、白花钱。
      const feed = deps.sessions?.() ?? []
      for (const record of Object.values(data.apps)) {
        if (record.state !== 'connected' || record.last === undefined) continue
        const bundleId = record.bundle_id
        if (data.not_agents[bundleId] !== undefined) continue
        const binding = bindingForBundle(bundleId)
        if (binding !== undefined && feed.some(one => one.agent === binding.agent)) continue
        const records = recordReads.get(bundleId)
        if (records !== undefined) {
          // 读它自己记录的那几家:最新那条对话(同读窗口那一路只判当前那一条)。
          const chat = records.chats[0]
          if (chat === undefined) continue
          const appRunning = live.get(bundleId)?.running
          out.push({
            agent: entryIdForBundle(bundleId),
            session_id: recordSessionId(chat),
            ...(chat.latest === undefined ? {} : { latest: chat.latest }),
            at: chat.updated_at,
            status: appRunning === false ? 'offline' : chat.status === 'running' ? 'running' : 'done',
            ...(chat.finished_at !== undefined ? { answered: true } : {}),
            name: displayName(bundleId, record.name),
          })
          continue
        }
        const last = record.last
        const appRunning = live.get(bundleId)?.running
        out.push({
          agent: entryIdForBundle(bundleId),
          session_id: windowSessionId(last),
          ...(last.latest === undefined ? {} : { latest: last.latest }),
          at: last.changed_at ?? last.at,
          // 与 agentRegistry.windowSession 同一条算法(App 没开 = offline,在跑 = running,别的 = 做完了)。
          status: appRunning === false ? 'offline' : last.status === 'running' ? 'running' : 'done',
          ...(last.answered === true ? { answered: true } : {}),
          name: displayName(bundleId, record.name),
        })
      }
      return out
    },
    view,
    // 某个包开着没(卡 DP:一家装着两个 App 时,派给她正开着的那一个)。
    appRunning: bundleId => live.get(bundleId)?.running,
    icon(id) {
      // 登记表 id → 包标识:事务官自己用工作台的图标;有专门读法的那几家(claude / kimi……)按绑定找;
      // 别的 id 本身就是包标识。**只在登记表出现过的那几家里找** —— 不拿一个随手传来的 id 去问壳。
      const trimmed = id.trim()
      if (trimmed === '') return undefined
      const entry = view().entries.find(one => one.id === trimmed)
      if (entry === undefined) return undefined
      const bundleId = entry.self === true ? OWN_BUNDLE_ID : entry.bundle_id
      return bundleId === undefined ? undefined : icons.get(bundleId)
    },
    appIcon,
    detail() {
      const base = view()
      const today = localDay(now())
      const budget = data.budget.day === today ? data.budget : { day: today, calls: 0, cny: 0 }
      return {
        ...base,
        apps: judgedApps(data),
        budget: { ...budget, cap_calls: JUDGE_DAILY_CALLS, cap_cny: JUDGE_DAILY_CNY },
        in_call: deps.inCall?.() === true,
      }
    },
    // 开集额度读法共用这一份每日上限(卡 QO):同一支尺、同一份账、同一句「明天再判」。
    judgeBudget: {
      async gate(estimateCny) {
        await ensureLoaded()
        let remaining: number | undefined
        try { remaining = await deps.remainingCny?.() }
        catch { remaining = undefined }
        return budgetGate({ budget: data.budget, today: localDay(now()), estimate: estimateCny, remainingCny: remaining })
      },
      async spend(cny) {
        await ensureLoaded()
        data.budget = spend(data.budget, localDay(now()), cny)
        await saveNow()
      },
    },
    notAgent,
    connect,
    markRead,
    dismissNotice,
    data: () => data,
  }
}
