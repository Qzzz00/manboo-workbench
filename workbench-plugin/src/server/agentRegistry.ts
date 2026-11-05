/**
 * Agent **登记表**(2026-09-25,卡 Q「Agent 自动发现与统一接入」)。
 *
 * 维护者:「要是写死了就很糟糕了,这次不能说你把写死的范围增加到 6 个,你得想个机制」。
 * 这就是那个机制落盘的地方:`~/.dsh/workbench/agents.json`。**有哪几家 Agent 只认这一份** ——
 * 界面(顶栏小灯与气泡、会话列表、事务官舞台、手机)、派活候选、额度,以后都只读它。
 *
 * 每个判过的 App 一条,记:
 * - 身份:包标识、显示名(类别 / 出品方 / 版本是它包里写的);
 * - 怎么认出来的、判定依据(窗口像不像对话窗口 + 回话的是 AI 还是人,谁判的);
 * - 可用的来源:通用的读窗口,以及挂在它上面的专门读法(`agentSources.ts`);
 * - 状态与会话摘要:**只存标题、最新一句(截 120 字)、时间、状态**,侧栏标题最多 8 条 —— 不存整段对话;
 * - 他说过的「这不是 Agent」(单独一张,撤掉的那一家以后不再判、不再读)。
 *
 * 这个文件是纯数据 + 纯函数(`registryView`);读写磁盘只在 `createFileRegistryStore` 那一段,用例注入内存版。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type {
  AgentBubbleView, AgentEntryView, AgentFoundHow, AgentGapKey, AgentJudgedAppView, AgentRegistryView, AgentRunStatus,
  AgentAxSummary, AgentSessionView, AgentSourceView, AgentUnreadableView, SessionAskView, SessionView,
} from '../protocol.ts'
import {
  AGENT_MONO_COLOR, AGENT_NEUTRAL_COLOR, agentHiddenInSlotWhy, agentNotOpenWhy, agentUnreadableWhy, sessionBusy,
} from '../protocol.ts'
import type { AppIdentity, AxDetail, JudgeBudget, StructureVerdict, VerdictKind } from './agentJudge.ts'
import { SESSION_SOURCES, bindingForApp, entryIdOf } from './agentSources.ts'
import type { AgentRecordChat, AgentRecordRead } from './agentRecords.ts'
import { SCREEN_ONLY_NOTE, SCREEN_SOURCE_LABEL } from './agentRecords.ts'
import type { WindowAgentState } from './agentWindowModel.ts'
import { clipText, conversationTitles, fnv1a, fullTitleOf } from './agentWindowModel.ts'

export type AppState = 'candidate' | 'connected' | 'asking' | 'not_agent'

export interface AppVerdict {
  kind: VerdictKind
  reason: string
  /** 谁判的:模型 / 他自己 / 壳与服务端的隐私底线 / 它的会话记录。 */
  by: 'model' | 'user' | 'floor' | 'sessions'
  /** 判的时候看了什么:只看身份,还是连界面字一起看。 */
  stage: 'identity' | 'window'
  at: string
}

/** 登记表里的一条(每个判过的 App 一条)。 */
export interface AppRecord {
  bundle_id: string
  name: string
  identity?: Omit<AppIdentity, 'bundle_id' | 'name'>
  state: AppState
  verdict?: AppVerdict
  structure?: StructureVerdict & { at: string }
  /**
   * 最后一次看它窗口时那扇窗的**辅助功能结构摘要**(2026-10-01,诊断用;见 {@link AgentAxSummary})。
   * **只有数**,一个字的内容都没有 —— 判成 AI 应用、结构那一道却没过的那几家,下一次不用再上真机猜。
   */
  ax?: AgentAxSummary
  /**
   * 最后一次看它窗口时那棵树的**明细**(2026-10-02,诊断用;见 {@link AgentAxDetailView})。
   * 只对**输入框没认出来**的那几家收 —— 认得出输入框的那几家这一格一直缺席(没有要查的)。
   */
  ax_detail?: AxDetail
  /** 接上的那一刻:怎么认出来的、判定依据。 */
  found?: { how: AgentFoundHow, at: string, basis: string }
  /** 拿不准、在外层问他的那一刻。 */
  asked_at?: string
  /** 他答了「先不管」:到这一刻之前不再问(照旧不读)。 */
  ask_again_at?: string
  /** 还没判完的原因(预算到了、模型没接上……)。 */
  pending?: string
  /** 最后一次读到的(**只有需要的那几样**)。 */
  last?: WindowAgentState
  /**
   * 读它自己记录的那几家(`agentRecords.ts`):她最后一次看过它的时刻。这之后收尾的那几轮是没看过的回复(蓝点)。
   * 第一次读到它的记录时记成那一刻 —— 接上之前的旧对话不算没看过。
   */
  records_read_at?: string
}

export interface RegistryNotice { id: string, text: string, at: string, dismissed?: boolean, agent?: string }

export interface RegistryFile {
  version: 1
  apps: Record<string, AppRecord>
  /** 他说过的「这不是 Agent」。**这张表里的一家不判、不看结构、不读窗口**。 */
  not_agents: Record<string, { name: string, at: string }>
  notices: RegistryNotice[]
  budget: JudgeBudget
  /**
   * 各家图标的主色(按包标识;壳的 `icon_colors` 读出来的原色,`#rrggbb`)。没装的那一家 `color` 缺席。
   * 界面用的颜色是它过一遍 {@link agentColor} 之后的那一个。
   */
  colors: Record<string, { color?: string, at: string }>
}

export function emptyRegistry(): RegistryFile {
  return { version: 1, apps: {}, not_agents: {}, notices: [], budget: { day: '', calls: 0, cny: 0 }, colors: {} }
}

// ───────────────────────────── 各家的颜色 ─────────────────────────────

/** 工作台自己(事务官那颗灯用它的图标色)。 */
export const OWN_BUNDLE_ID = 'ai.ben.workbench'

const HEX = /^#([0-9a-f]{6})$/i

function hexToRgb(hex: string | undefined): [number, number, number] | undefined {
  const match = hex === undefined ? null : HEX.exec(hex.trim())
  if (match === null) return undefined
  const value = Number.parseInt(match[1] as string, 16)
  return [((value >> 16) & 0xff) / 255, ((value >> 8) & 0xff) / 255, (value & 0xff) / 255]
}

function hslToHex(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = l - c / 2
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x]
  const byte = (v: number): string => Math.round(Math.max(0, Math.min(1, v + m)) * 255).toString(16).padStart(2, '0')
  return `#${byte(r)}${byte(g)}${byte(b)}`
}

/** `#rrggbb` → 色相(度)、饱和度、亮度(HSL)。认不出回 undefined。 */
export function colorHsl(hex: string | undefined): { h: number, s: number, l: number } | undefined {
  const rgb = hexToRgb(hex)
  if (rgb === undefined) return undefined
  const [r, g, b] = rgb
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  const d = max - min
  if (d === 0) return { h: 0, s: 0, l }
  const s = d / (1 - Math.abs(2 * l - 1))
  let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  h *= 60
  if (h < 0) h += 360
  return { h, s, l }
}

/**
 * 一家在界面上用什么颜色(2026-09-25,卡 Q;维护者:「Claude 是橙色的……其他的 Agent 也是使用同色系的卡通形象」)。
 * **全工作台只有这一处定**:会话卡的小头像、事务官舞台、顶栏小灯、手机都用登记表里算好的这一格。
 *
 * - 取不到图标 → 中性灰(不猜);
 * - 黑白图标(没什么颜色)→ 浅的中性色(深色底上看得清);
 * - 有颜色的:色相不动;太深的提亮一档(亮度提到 0.62),太浅的压到 0.78;饱和度至少 0.45(别发灰)。
 */
export function agentColor(iconColor: string | undefined): string {
  const hsl = colorHsl(iconColor)
  if (hsl === undefined) return AGENT_NEUTRAL_COLOR
  if (hsl.s < 0.18) return AGENT_MONO_COLOR
  const lightness = hsl.l < 0.5 ? 0.62 : Math.min(hsl.l, 0.78)
  return hslToHex(hsl.h, Math.min(0.9, Math.max(hsl.s, 0.45)), lightness)
}

export function defaultAgentRegistryFile(home: string): string {
  return `${home}/.dsh/workbench/agents.json`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const APP_STATES: readonly AppState[] = ['candidate', 'connected', 'asking', 'not_agent']

/** 读坏了的那几条丢掉,别的照用(一条坏记录不该让整张表作废)。 */
export function parseRegistry(text: string): RegistryFile {
  let raw: unknown
  try { raw = JSON.parse(text) }
  catch { return emptyRegistry() }
  if (!isRecord(raw)) return emptyRegistry()
  const out = emptyRegistry()
  if (isRecord(raw.apps)) {
    for (const [id, value] of Object.entries(raw.apps)) {
      if (!isRecord(value) || typeof value.name !== 'string' || !APP_STATES.includes(value.state as AppState)) continue
      out.apps[id] = { ...(value as unknown as AppRecord), bundle_id: id }
    }
  }
  if (isRecord(raw.not_agents)) {
    for (const [id, value] of Object.entries(raw.not_agents)) {
      if (isRecord(value) && typeof value.name === 'string' && typeof value.at === 'string') out.not_agents[id] = { name: value.name, at: value.at }
    }
  }
  if (Array.isArray(raw.notices)) {
    out.notices = raw.notices.filter((one): one is RegistryNotice => isRecord(one) && typeof one.id === 'string' && typeof one.text === 'string' && typeof one.at === 'string')
  }
  if (isRecord(raw.budget) && typeof raw.budget.day === 'string') {
    out.budget = { day: raw.budget.day, calls: Number(raw.budget.calls) || 0, cny: Number(raw.budget.cny) || 0 }
  }
  if (isRecord(raw.colors)) {
    for (const [id, value] of Object.entries(raw.colors)) {
      if (!isRecord(value) || typeof value.at !== 'string') continue
      out.colors[id] = { at: value.at, ...(typeof value.color === 'string' && HEX.test(value.color) ? { color: value.color } : {}) }
    }
  }
  return out
}

export interface RegistryStore {
  load: () => Promise<RegistryFile>
  save: (data: RegistryFile) => Promise<void>
}

/** 真落盘的那一份:整份读、整份写(tmp + rename),写之前建目录。**只写 `file` 这一个文件**。 */
export function createFileRegistryStore(file: string): RegistryStore {
  let queue: Promise<void> = Promise.resolve()
  return {
    async load() {
      try { return parseRegistry(await readFile(file, 'utf8')) }
      catch { return emptyRegistry() }
    },
    save(data) {
      const text = `${JSON.stringify(data, null, 2)}\n`
      const run = async (): Promise<void> => {
        await mkdir(dirname(file), { recursive: true })
        const tmp = `${file}.tmp-${process.pid}`
        await writeFile(tmp, text, 'utf8')
        await rename(tmp, file)
      }
      queue = queue.then(run, run)
      return queue
    },
  }
}

/** 用例用的内存版。`saved` 是每次写下去的那一份(深拷贝)。 */
export function createMemoryRegistryStore(initial?: RegistryFile): RegistryStore & { saved: RegistryFile[], current: () => RegistryFile | undefined } {
  const saved: RegistryFile[] = []
  return {
    saved,
    current: () => saved.at(-1),
    load: async () => structuredClone(initial ?? emptyRegistry()),
    save: async (data) => { saved.push(structuredClone(data)) },
  }
}

// ───────────────────────────── 出视图 ─────────────────────────────

/** 气泡在视图里留多久。 */
export const BUBBLE_TTL_MS = 10 * 60_000
/** 提示留多久。 */
export const NOTICE_TTL_MS = 24 * 60 * 60_000
/** 一家最多摆几条会话。 */
export const ENTRY_SESSIONS_MAX = 20

/** 本机时间的「15:20」。 */
export function clock(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function seconds(fromIso: string | undefined, nowMs: number): number {
  const at = fromIso === undefined ? Number.NaN : Date.parse(fromIso)
  return Number.isNaN(at) ? 0 : Math.max(0, Math.round((nowMs - at) / 1000))
}

export interface RegistryViewInput {
  data: RegistryFile
  /** 这个包此刻开着没(壳报的);不知道就 undefined。 */
  running: (bundleId: string) => boolean | undefined
  /** `/state.sessions`(专门读法读出来的会话)。 */
  sessions: readonly SessionView[]
  /** 最近冒过的气泡(按登记表 id)。 */
  bubbles: ReadonlyMap<string, AgentBubbleView>
  /**
   * 这一家的 logo 取到了没(2026-09-26,卡 LG)。图片本身只在内存里(`agentIcons.ts`),
   * 快照里只有这一格真假 —— 界面据此决定画 `GET /agents/icon/<id>` 那一张,还是退回色点。
   * 缺席(用例不关心图标、老代码路径)= 一家都没有,与这块功能之前逐字相同。
   */
  hasIcon?: ((bundleId: string) => boolean) | undefined
  now: Date
  /** 发现与巡检停着的原因(通话中……)。 */
  paused?: string | undefined
  note?: string | undefined
  /**
   * 读窗口那条会话「有没有一问在等他」(2026-09-26,卡 WS;`waitingService.askOf`)。
   * 缺席 = 没接「在等你」那一份(老用例、还没接线)→ 窗口会话不挂 `ask`,别的一字不变。
   */
  askOf?: ((entryId: string, sessionId: string) => SessionAskView | undefined) | undefined
  /**
   * 这个包「它自己的记录」那一路(2026-10-08,`agentRecords.ts`)。缺席 / 回 undefined = 这一家没有这一路;
   * `read` 缺席 = 有这一路、这一拍读不了(整家退回读窗口)。
   */
  records?: ((bundleId: string) => { label: string, read?: AgentRecordRead } | undefined) | undefined
}

/** 它记录里那一条对话的会话号:有标题就与读窗口那一路同一个号(已读簿、「在等你」、捎话认的都是它)。 */
export function recordSessionId(chat: Pick<AgentRecordChat, 'id' | 'title'>): string {
  return chat.title === undefined ? `records:${chat.id}` : windowSessionId({ title: chat.title })
}

/** 它记录里的那几条对话 → 登记表里这一家的会话(`via: 'records'`)。 */
export function recordSessions(input: {
  entryId: string
  name: string
  read: AgentRecordRead
  appRunning: boolean
  readAt?: string | undefined
  nowMs: number
  askOf?: ((entryId: string, sessionId: string) => SessionAskView | undefined) | undefined
}): AgentSessionView[] {
  const readAtMs = input.readAt === undefined ? Number.POSITIVE_INFINITY : Date.parse(input.readAt)
  return input.read.chats.slice(0, ENTRY_SESSIONS_MAX).map((chat) => {
    const status = !input.appRunning ? 'offline' : chat.status
    const sessionId = recordSessionId(chat)
    const ask = status === 'offline' ? undefined : input.askOf?.(input.entryId, sessionId)
    const finishedMs = chat.finished_at === undefined ? Number.NaN : Date.parse(chat.finished_at)
    return {
      agent: input.entryId,
      session_id: sessionId,
      project: input.name,
      status,
      ...(chat.title === undefined ? {} : { title: chat.title }),
      ...(chat.latest === undefined ? {} : { summary: chat.latest, activity: { line: clipText(chat.latest, ACTIVITY_MAX), at: chat.updated_at } }),
      elapsed_sec: seconds(chat.started_at ?? chat.updated_at, input.nowMs),
      last_output_sec: seconds(chat.updated_at, input.nowMs),
      unread: status === 'done' && finishedMs > readAtMs,
      ...(ask === undefined ? {} : { ask }),
      updated_at: chat.updated_at,
      via: 'records',
    } satisfies AgentSessionView
  })
}

/** 一条专门读法读出来的会话 → 登记表里那一家的一条会话。 */
function feedSession(entryId: string, one: SessionView): AgentSessionView {
  return { ...one, agent: entryId, via: 'sessions' }
}

/** 「最近在做什么」那一句最长几个字(同卡 P 的会话卡片)。 */
export const ACTIVITY_MAX = 36

/**
 * 读窗口读出来的那条会话的 id(2026-09-26,卡 WS 抽出来)。**只有这一处算它**:
 * 登记表出视图与「在等你」那一份(`waitingService.windows()`)要对上同一个 id,不许各算一遍。
 */
export function windowSessionId(state: Pick<WindowAgentState, 'title'>): string {
  return `window:${fnv1a(state.title ?? '当前对话')}`
}

/**
 * 侧栏里那几条对话,**当前选中的那条排最前**(2026-09-26,卡 ST)。
 *
 * 维护者 09-26 19:10:「我发的任务随机抽查大部分都没变成卡片在事务官那一页展示出来」——
 * 以前窗口型的家**一家只有一条会话**、标题就是窗口标题(「Grok Bot, Working」
 * 「Initiating A New Conversa...」那种被 App 自己截断的),他在那扇窗里说的每一件事都只算成「那一扇窗」。
 * 现在**一条对话一条会话**:名字从侧栏读到的那几行来(界面字按 {@link conversationTitles} 剔掉),
 * 再把「当前选中的那条」摆到最前。
 *
 * 一条都认不出来(真机 09-26 的 Kimi:侧栏整屏都是「返回 / 看板 / 插件」这类界面字)时回一个
 * `[undefined]` —— 那就是卡 ST 之前的样子:这一家照旧只有一条会话、标题缺席。**不能回空数组**:
 * 那样这一家在坞上、`/state.running` 里会整个消失。
 */
export function windowConversations(state: WindowAgentState): readonly { id: string, title?: string, current: boolean }[] {
  const kept = conversationTitles(state.titles)
  /*
   * 当前那条的**显示名**可能比存下来的那一截长(维护者 19:10 第一句:「Grok Bot 的标题显示不全」)——
   * 窗口标题是 App 自己截断的(「Initiating A New Conversa...」),侧栏里那条是全的。
   * **id 还是按存下来的那一截算**({@link windowSessionId}):`waitingService.askOf`、已读簿、`seen` 都认那个 id,
   * 换了 id 就等于把那一问与那颗蓝点弄丢。只有摆到他眼前的那个名字换成全的。
   */
  const shown = state.title === undefined ? undefined : fullTitleOf(state.title, kept)
  const rest = kept.filter(one => one !== state.title && one !== shown)
  const current = { id: windowSessionId(state), current: true, ...(shown === undefined ? {} : { title: shown }) }
  if (state.title === undefined && rest.length === 0) return [current]
  /**
   * **认不出当前那条对话的名字**时(侧栏里没有选中标记、窗口标题就是 App 名 —— 真机 Codex、Manus、
   * Kimi 都这样):卡 ST 原来把这一条**整个扔掉**,只摆侧栏里那几条有名字的。
   * 维护者 2026-09-27 11:47:「实际上正在运行的 codex 却没有气泡」—— 那一刻
   * `/state.agent_registry` 里 codex 这一家 `status: running`,可 `counts.running: 0`:
   * 在跑的那条会话被扔掉了,坞上与顶栏的白点按会话数画,于是一颗都没有。
   *
   * 现在:**它身上有真事要说的时候留着这一条**(在跑,或者有他没看过的回话)。
   * 名字缺席、卡上就写「当前对话」那一档 —— 宁可多一张没名字的卡,也不能让真在跑的那一条不见。
   * 空闲又没有未读时照旧不摆(不然每一家都常驻一张没名字的卡,那是 09-26 晚刚收掉的乱)。
   */
  if (state.title === undefined) {
    const live = state.status === 'running' || state.unread
    return live ? [current, ...rest.map(title => ({ id: windowSessionId({ title }), title, current: false }))]
      : rest.map(title => ({ id: windowSessionId({ title }), title, current: false }))
  }
  return [current, ...rest.map(title => ({ id: windowSessionId({ title }), title, current: false }))]
}

/**
 * 侧栏里那几条对话 → 几条会话(2026-09-26,卡 ST)。**状态只挂在当前选中的那一条上**:
 * 可读窗口只读得到它的内容,别的几条只有名字与「上次看到的」({@link WindowAgentState.seen})。
 *
 * 所以别的几条一律不是 `running`、不带 `ask`、`unread` 为假 —— 于是
 * `/state.running`、坞上那几颗点、`waitingOnHim` 的数**一个都没变**(卡 ST 的纪律:数法不动,只是卡多了)。
 */
function windowSessions(
  entryId: string,
  name: string,
  state: WindowAgentState,
  appRunning: boolean,
  nowMs: number,
  ask?: SessionAskView,
): AgentSessionView[] {
  return windowConversations(state).map(({ id, title, current }) => {
    if (current) return { ...windowSession(entryId, name, state, appRunning, nowMs, ask), ...(title === undefined ? {} : { title }) }
    const seen = state.seen?.[title as string]
    const at = seen?.at ?? state.at
    return {
      agent: entryId,
      session_id: id,
      project: name,
      // 只有名字的那几条不谈「在跑」:没读过它的内容,说它在跑就是编。App 没开照旧 offline。
      status: appRunning ? 'done' : 'offline',
      ...(title === undefined ? {} : { title }),
      ...(seen?.latest === undefined ? {} : { summary: seen.latest }),
      ...(seen?.latest === undefined ? {} : { activity: { line: clipText(seen.latest, ACTIVITY_MAX), at } }),
      elapsed_sec: seconds(at, nowMs),
      last_output_sec: seconds(at, nowMs),
      unread: false,
      updated_at: at,
      via: 'window',
    } satisfies AgentSessionView
  })
}

/** 读窗口读出来的「当前那条对话」→ 一条会话(气泡、会话列表、执行数都数它)。 */
function windowSession(entryId: string, name: string, state: WindowAgentState, appRunning: boolean, nowMs: number, readAsk?: SessionAskView): AgentSessionView {
  // 窗口里摆着一道选择题(豆包办公;2026-09-28 Air 维护包)= 形式上在等她:压过按内容读出来的那一问,状态记「等你」。
  const ask = state.formAsk ?? readAsk
  /*
   * 藏着(2026-10-09):读到的是旧画面,不改判 —— 照最后一次看得见时摆,「最近在做什么」那一句如实说看不见。
   */
  const seen = state.hidden === true ? state.seen_status : state.status
  const status = !appRunning ? 'offline' : ask?.by === 'form' ? 'waiting' : seen === 'running' ? 'running' : 'done'
  const activity = state.hidden === true
    ? { line: clipText(agentHiddenInSlotWhy(name), ACTIVITY_MAX), at: state.since }
    : state.latest === undefined ? undefined : { line: clipText(state.latest, ACTIVITY_MAX), at: state.changed_at ?? state.at }
  return {
    agent: entryId,
    session_id: windowSessionId(state),
    project: name,
    status,
    ...(state.title === undefined ? {} : { title: state.title }),
    ...(state.latest === undefined ? {} : { summary: state.latest }),
    // 「最近在做什么 · 几分钟前」:最新那一句 + 它最后一次变的时刻(卡 P 那一套,电脑手机同一句)。
    ...(activity === undefined ? {} : { activity }),
    elapsed_sec: seconds(state.since, nowMs),
    last_output_sec: seconds(state.at, nowMs),
    unread: status === 'done' && state.unread,
    /**
     * 「有一问在等他」(2026-09-26,卡 WS):与文件型会话**同一份判断**(`waitingForYou.ts` 的那套
     * rules / model,同一个花费上限)。窗口这一路读不出形式信号(没有弹窗可读),所以永远是
     * `by:'rules'|'model'` —— 按 09-26 的口径**只挂 `ask`,不改运行状态**:在跑还是在跑、
     * 做完还是做完(蓝点),那一问走 `src/waiting.ts` 的 `waitingOnHim`(事务官琥珀气泡、
     * 球下「等你 n」、手机「等你确认」)。App 没开(`offline`)时不挂。
     */
    ...(ask === undefined || status === 'offline' ? {} : { ask }),
    updated_at: state.at,
    via: 'window',
  }
}

function counts(sessions: readonly AgentSessionView[]): AgentEntryView['counts'] {
  return {
    // 底下有后台任务在跑的主会话也算在跑(卡 Q:只算这一条主会话一次,子任务不单独数)。
    running: sessions.filter(one => one.status === 'running' || (one.status !== 'waiting' && sessionBusy(one))).length,
    waiting: sessions.filter(one => one.status === 'waiting').length,
    unread: sessions.filter(one => one.status === 'done' && one.unread).length,
  }
}

interface EntrySeed {
  id: string
  name: string
  bundle_id?: string
  self?: true
  found: { how: AgentFoundHow, at: string, basis: string }
  record?: AppRecord
}

function entryView(seed: EntrySeed, input: RegistryViewInput): AgentEntryView {
  const nowMs = input.now.getTime()
  const binding = SESSION_SOURCES.find(one => entryIdOf(one) === seed.id)
  const feed = binding === undefined
    ? []
    : input.sessions
        // 工作台 / 程序自己起的会话(探针)不是他的:不进这一家的列表,也不计数(2026-09-26 晚,统筹;规矩同卡 V)。
        .filter(one => one.agent === binding.agent && one.selfcheck === undefined)
        .slice()
        .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at))
        .slice(0, ENTRY_SESSIONS_MAX)
        .map(one => feedSession(seed.id, one))
  const last = seed.record?.state === 'connected' ? seed.record.last : undefined
  const running = seed.bundle_id === undefined ? undefined : input.running(seed.bundle_id)
  const appRunning = running === true
  const name = seed.name
  // 它自己的记录(2026-10-08):有这一路、这一拍读得到 → 会话从它的库里长,读窗口只作兜底。
  const recordWay = seed.record?.state === 'connected' && seed.bundle_id !== undefined ? input.records?.(seed.bundle_id) : undefined
  const records = recordWay?.read

  const sources: AgentSourceView[] = []
  if (recordWay !== undefined) {
    sources.push({
      kind: 'records',
      label: recordWay.label,
      ok: records !== undefined,
      ...(records !== undefined ? {} : { note: '这会儿读不了它的记录,退回读它的窗口' }),
    })
  }
  if (seed.record?.state === 'connected' && seed.bundle_id !== undefined) {
    const ok = appRunning && last !== undefined && last.status !== 'unknown'
    /*
     * 来源分级写在这一格上(2026-10-09,根治方案第三节第 2 条):有它自己的记录 → 看屏幕只是兜底;
     * 没有 → 如实写「只能看屏幕」。读不到时写为什么(藏着就说藏着、看不见)。
     */
    sources.push({
      kind: 'window',
      label: SCREEN_SOURCE_LABEL,
      ok,
      ...(records !== undefined
        ? { note: '兜底:它自己的记录读得到,窗口只补标题' }
        : ok
          ? (recordWay === undefined ? { note: SCREEN_ONLY_NOTE } : {})
          : { note: !appRunning ? `${name} 没开` : last === undefined ? '还没读到' : (last.gaps.status ?? '这次没读到') }),
    })
  }
  if (binding !== undefined) {
    sources.push({ kind: 'sessions', label: binding.label, ok: feed.length > 0, ...(feed.length > 0 ? {} : { note: '这会儿没有会话' }) })
  }

  let status: AgentRunStatus
  let title: string | undefined
  let latest: string | undefined
  let readAt: string | undefined
  let note: string | undefined
  let sessions: AgentSessionView[]
  const gaps: Partial<Record<AgentGapKey, string>> = {}

  if (feed.length > 0) {
    // 专门那一路有会话:它更细,先用它;缺的那一样退回读窗口读到的。
    status = feed.some(one => one.status === 'running') ? 'running' : feed.some(one => one.status === 'waiting') ? 'waiting' : feed.some(sessionBusy) ? 'running' : 'idle'
    const newest = feed[0] as AgentSessionView
    title = newest.title ?? last?.title
    latest = newest.summary ?? last?.latest
    readAt = newest.updated_at
    if (title === undefined) gaps.title = `没接上:${name} 最新那条会话还没有标题`
    if (latest === undefined) gaps.latest = `没接上:${name} 最新那条会话还没读到内容`
    sessions = feed
  }
  else if (records !== undefined) {
    sessions = recordSessions({
      entryId: seed.id, name, read: records, appRunning: appRunning || running === undefined,
      readAt: seed.record?.records_read_at, nowMs, askOf: input.askOf,
    })
    status = sessions.some(one => one.status === 'running') ? 'running' : sessions.some(one => one.status === 'waiting') ? 'waiting' : 'idle'
    const newest = sessions[0]
    title = newest?.title
    latest = newest?.summary
    readAt = newest?.updated_at
    if (running === false) note = `${name} 没开,显示的是它记录里最后的样子`
    if (newest === undefined) {
      gaps.title = `${name} 的记录里还没有对话`
      gaps.latest = `${name} 的记录里还没有对话`
    }
    else {
      if (title === undefined) gaps.title = `没接上:${name} 最新那条对话还没有标题`
      if (latest === undefined) gaps.latest = `没接上:${name} 最新那条对话还没有回答`
    }
  }
  else if (last !== undefined) {
    status = appRunning ? last.status : (running === false ? 'idle' : last.status)
    title = last.title
    latest = last.latest
    readAt = last.at
    if (running === false) note = `${name} 没开,显示的是 ${clock(last.at)} 最后一次读到的`
    /*
     * ★ **「没接上」这三个字要配得上事实**(2026-10-01)。两种情形以前都被写成「没接上:X 开着,但一扇窗都没有」:
     *
     * - **藏在窗口槽里**:藏它的手就是工作台自己 —— 不是没接上,是这一拍没看成。照实说,切过去就看得到;
     * - **它没开**(来源明说 `running === false`):那就说「没开」,别拿上一拍那句「开着但没有窗口」顶上来。
     *
     * 事务官读的就是这几句:说错一个字,她就照着说「派不了活」(Air 10-01 那两条现场)。
     */
    const why = (fallback: string): string =>
      running === false ? agentNotOpenWhy(name) : last.hidden === true ? agentHiddenInSlotWhy(name) : `没接上:${fallback}`
    if (title === undefined) gaps.title = why(last.gaps.title ?? `认不出 ${name} 当前那条对话的标题`)
    if (latest === undefined) gaps.latest = why(last.gaps.latest ?? `没读到 ${name} 的对话内容`)
    if (status === 'unknown') gaps.status = why(last.gaps.status ?? `读不到 ${name} 在不在跑`)
    // 一条对话一条会话(2026-09-26,卡 ST)。当前选中的那条排最前,状态只挂在它身上。
    sessions = windowSessions(seed.id, name, last, appRunning || running === undefined, nowMs, input.askOf?.(seed.id, windowSessionId(last)))
  }
  else if (seed.self === true) {
    status = 'idle'
    gaps.title = '事务官这会儿没有会话'
    gaps.latest = '事务官这会儿没有会话'
    sessions = []
  }
  else {
    status = 'unknown'
    // 没开就说没开(2026-10-01):别在前面加「没接上」—— 它只是关着,接没接上这会儿还说不上。
    const why = running === false
      ? agentNotOpenWhy(name)
      : `没接上:${input.paused !== undefined ? `还没读到 ${name} 的窗口(${input.paused})` : `还没读到 ${name} 的窗口,稍等`}`
    gaps.status = why
    gaps.title = why
    gaps.latest = why
    sessions = []
  }
  if (status === 'unknown') gaps.bubble = records === undefined && feed.length === 0 && last?.hidden === true && running !== false ? agentHiddenInSlotWhy(name) : `没接上:读不到 ${name} 在不在跑,冒不了气泡`

  const bubble = input.bubbles.get(seed.id)
  const freshBubble = bubble !== undefined && nowMs - Date.parse(bubble.at) <= BUBBLE_TTL_MS ? bubble : undefined
  // 颜色从它自己的图标来(事务官用工作台自己的);没有就中性灰。
  const colorBundle = seed.self === true ? OWN_BUNDLE_ID : seed.bundle_id
  const color = agentColor(colorBundle === undefined ? undefined : input.data.colors[colorBundle]?.color)
  // logo 取到了没(卡 LG):同一个包 —— 颜色与整张图标是同一张图上取的两样东西。
  const icon = colorBundle !== undefined && input.hasIcon?.(colorBundle) === true
  const recordTitles = records?.chats.flatMap(one => one.title === undefined ? [] : [one.title]).slice(0, 8)
  const titles = recordTitles !== undefined
    ? (recordTitles.length > 0 ? recordTitles : undefined)
    : feed.length === 0 && last !== undefined && last.titles.length > 0 ? last.titles : undefined
  return {
    id: seed.id,
    ...(seed.bundle_id === undefined ? {} : { bundle_id: seed.bundle_id }),
    name,
    ...(seed.self === true ? { self: true } : {}),
    color,
    icon,
    found: seed.found,
    sources,
    ...(seed.bundle_id === undefined || running === undefined ? {} : { app_running: running }),
    status,
    ...(title === undefined ? {} : { title }),
    ...(latest === undefined ? {} : { latest }),
    ...(readAt === undefined ? {} : { read_at: readAt }),
    ...(freshBubble === undefined ? {} : { bubble: freshBubble }),
    gaps,
    ...(note === undefined ? {} : { note }),
    sessions,
    ...(titles === undefined ? {} : { titles }),
    counts: counts(sessions),
  }
}

/** 那几种专门读法里,有会话、但登记表里还没有的那一家(凭会话记录登记)。事务官自己永远在。 */
export function sessionSeeds(data: RegistryFile, sessions: readonly SessionView[], nowIso: string): EntrySeed[] {
  const out: EntrySeed[] = []
  for (const binding of SESSION_SOURCES) {
    const id = entryIdOf(binding)
    const mine = sessions.filter(one => one.agent === binding.agent && one.selfcheck === undefined)
    if (binding.self === true) {
      out.push({ id, name: binding.name, self: true, found: { how: 'self', at: '', basis: '事务官自己' } })
      continue
    }
    const bundle = binding.bundle_id
    if (bundle === undefined || data.not_agents[bundle] !== undefined) continue
    if (data.apps[bundle]?.state === 'connected') continue
    if (mine.length === 0) continue
    const first = mine.map(one => one.updated_at).sort()[0] ?? nowIso
    out.push({
      id,
      name: binding.name,
      bundle_id: bundle,
      found: { how: 'sessions', at: first, basis: `在${binding.label}里读到了 ${mine.length} 条会话` },
      ...(data.apps[bundle] === undefined ? {} : { record: data.apps[bundle] as AppRecord }),
    })
  }
  return out
}

/** 登记表 → 界面要的那一份。事务官自己在最前,其余按认出来的先后。 */
export function registryView(input: RegistryViewInput): AgentRegistryView {
  const nowIso = input.now.toISOString()
  const seeds: EntrySeed[] = sessionSeeds(input.data, input.sessions, nowIso)
  for (const record of Object.values(input.data.apps)) {
    if (record.state !== 'connected' || input.data.not_agents[record.bundle_id] !== undefined) continue
    /*
     * **按包标识,认不出再按显示名**(2026-09-28,卡 CF)。新 Air 上豆包办公的包标识是
     * `com.work.pc.doubao`,登记表原来把它登记成 id = 包标识、名字 =「豆包工作」,而派活按家名
     * `doubao` 找 —— 同一个 App 被说成两家。两个包标识现在都在 `FAMILY_SOURCES` 里;
     * 显示名那一路是退路,给还没收录的渠道包用。
     */
    const binding = bindingForApp({ bundle_id: record.bundle_id, name: record.name })
    seeds.push({
      id: binding?.agent ?? record.bundle_id,
      // 有专门读法的那一家用那一路的名字(界面上一直这么叫它,派活小标上也是)。
      name: binding?.name ?? record.name,
      bundle_id: record.bundle_id,
      found: record.found ?? { how: 'patrol', at: '', basis: '' },
      record,
    })
  }
  const selfSeeds = seeds.filter(one => one.self === true)
  const others = seeds.filter(one => one.self !== true).sort((a, b) => (a.found.at < b.found.at ? -1 : a.found.at > b.found.at ? 1 : 0))
  const entries = [...selfSeeds, ...others].map(seed => entryView(seed, input))
  const nowMs = input.now.getTime()
  // 正在外层问他的那几家(「先不管」还没到期的不算:那一问已经从「等你」那一堆里收掉了)。
  const asking = Object.values(input.data.apps)
    .filter(one => one.state === 'asking' && input.data.not_agents[one.bundle_id] === undefined && !isSnoozed(one, nowMs))
    .map((one) => {
      const binding = bindingForApp({ bundle_id: one.bundle_id, name: one.name })
      const name = binding?.name ?? one.name
      return {
        id: binding?.agent ?? one.bundle_id,
        name,
        question: askQuestionText(name),
        basis: recordBasis(one),
        at: one.asked_at ?? nowIso,
      }
    })
  const notices = input.data.notices
    .filter(one => one.dismissed !== true && nowMs - Date.parse(one.at) <= NOTICE_TTL_MS)
    .map(one => ({ id: one.id, text: one.text, at: one.at, ...(one.agent === undefined ? {} : { agent: one.agent }) }))
  const unreadable = unreadableApps(input)
  return {
    entries,
    asking,
    notices,
    ...(input.paused === undefined ? {} : { paused: input.paused }),
    ...(input.note === undefined ? {} : { note: input.note }),
    ...(unreadable.length === 0 ? {} : { unreadable }),
  }
}

/**
 * **认出是 AI 应用、可它那扇窗读不到**的那几家(2026-10-01;Air 上的新版 Kimi `…kmp.mac`、
 * 可灵、Mac App Store 版豆包都是这样)。
 *
 * 以前它们判完就静静停在 `candidate` 上,界面上**一行都没有** —— 她只看见「拉进来了却什么都没发生」。
 * 现在如实摆一行:认出来了,但读不到它的窗口,工作台没法替她往里发话。
 *
 * **三道门都要过**,免得把别的事说成这件事:判成 `ai_agent`(不是 unsure —— 那几家还在外层问她)、
 * 结构那一道**真判过而且没过**、而且**不是「藏在窗口槽里」**(那种只是这一拍没看成,不是读不到)。
 * 它开没开不管:关着的时候这句话照样是实情,界面上跟着「没开」那一档灰着排在后面。
 */
export function unreadableApps(input: Pick<RegistryViewInput, 'data'>): AgentUnreadableView[] {
  const out: AgentUnreadableView[] = []
  for (const record of Object.values(input.data.apps)) {
    if (input.data.not_agents[record.bundle_id] !== undefined) continue
    if (record.state === 'connected' || record.state === 'not_agent') continue
    if (record.verdict?.kind !== 'ai_agent') continue
    const structure = record.structure
    if (structure === undefined || structure.pass || structure.hidden === true) continue
    const binding = bindingForApp({ bundle_id: record.bundle_id, name: record.name })
    const name = binding?.name ?? record.name
    out.push({
      id: binding?.agent ?? record.bundle_id,
      name,
      bundle_id: record.bundle_id,
      why: agentUnreadableWhy(name),
      detail: structure.why,
      at: structure.at,
    })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/** 外层那一问怎么说(登记表的 `asking` 与挂到卡 M 经纪人上的那一问同一句)。 */
export function askQuestionText(name: string): string {
  return `${name} 像是个 Agent,要接上吗?`
}

/** 他答过「先不管」、还没到再问的时候。 */
export function isSnoozed(record: Pick<AppRecord, 'ask_again_at'>, nowMs: number): boolean {
  if (record.ask_again_at === undefined) return false
  const until = Date.parse(record.ask_again_at)
  return Number.isFinite(until) && until > nowMs
}

/**
 * 这一家凭什么算(或者像)Agent —— 一句人话:窗口里有什么 + 回话的是不是 AI 谁说的。
 * 「新接上一家」的判据、外层那一问的小字都用它。
 */
export function recordBasis(record: Pick<AppRecord, 'structure' | 'verdict'>): string {
  const verdict = record.verdict
  const who = verdict === undefined
    ? ''
    : verdict.by === 'user'
      ? verdict.kind === 'ai_agent' ? '你说它是 Agent' : '你说这不是 Agent'
      : verdict.by === 'sessions' || verdict.by === 'floor'
        ? verdict.reason
        : verdict.kind === 'ai_agent'
          ? `回话的是 AI(${verdict.reason})`
          : verdict.kind === 'unsure'
            ? `回话的是不是 AI 拿不准(${verdict.reason})`
            : `不像 AI(${verdict.reason})`
  return [record.structure?.why, who].filter((one): one is string => one !== undefined && one !== '').join(';')
}

/** 判过的每个 App(`GET /agents` 的诊断那一截)。 */
export function judgedApps(data: RegistryFile): AgentJudgedAppView[] {
  return Object.values(data.apps)
    .map((one): AgentJudgedAppView => ({
      bundle_id: one.bundle_id,
      name: one.name,
      state: data.not_agents[one.bundle_id] !== undefined ? 'not_agent' : one.state,
      ...(one.verdict === undefined ? {} : { verdict: { kind: one.verdict.kind, reason: one.verdict.reason, by: one.verdict.by, at: one.verdict.at } }),
      ...(one.structure === undefined ? {} : { structure: {
        pass: one.structure.pass, why: one.structure.why, at: one.structure.at,
        // 过了的那一家写得进去到什么程度(2026-10-02):`paste_only` = 自绘界面,送话靠点一下 + 粘贴。
        ...(one.structure.mode === undefined ? {} : { mode: one.structure.mode }),
      } }),
      // 那扇窗的结构摘要(2026-10-01,诊断包里带的就是它;只有数,没有内容)。
      ...(one.ax === undefined ? {} : { ax: one.ax }),
      // 输入框没认出来的那几家,再带一份树的明细(2026-10-02;角色 / 动作 / 属性名 + 位置 + 字数,没有内容)。
      ...(one.ax_detail === undefined ? {} : { ax_detail: one.ax_detail }),
      ...(one.pending === undefined ? {} : { pending: one.pending }),
      ...(one.ask_again_at === undefined ? {} : { ask_again_at: one.ask_again_at }),
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
}
