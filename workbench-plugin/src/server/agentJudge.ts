/**
 * 「这是不是一家 Agent」的两道判(2026-09-25,卡 Q「Agent 自动发现与统一接入」)。**全是纯函数**。
 *
 * 维护者:「要是写死了就很糟糕了……你得想个机制,后面检测到是 Agent,有会话窗口的这种都得能有气泡和会话状态、
 * 标题、内容」。所以这里**没有任何一家的名字**:哪一家算 Agent,是下面两道判在运行时判出来的,判完记进登记表。
 *
 * | 哪一道 | 看什么 | 谁判 |
 * |---|---|---|
 * | ① 回话的是 AI 还是人 | App 名、包标识、类别、出品方(它包里 Info.plist 写着的);拿不准时再加上**界面字**(按钮名、菜单名、输入框提示,**没有聊天内容**) | 模型,每个 App 只判一次,判完缓存 |
 * | ② 窗口像不像对话窗口 | 辅助功能读出来的**结构**:有对话区或会话列表、有输入框、有发送或「新对话」一类的入口 | 本文件 `judgeStructure`,确定的规则 |
 *
 * **先判 ①、再看 ②**:人跟人聊天的(微信、企业微信这一类)在 ① 就被判出来,**连窗口结构都不看**;
 * ① 判不出(`unsure`)的才去看结构,结构像,再带上界面字判一次;还判不出就不读,在外层问他一句。
 *
 * 花费:判 ① 一次问一批(最多 12 个 App 一次),每天有上限(次数 + 估算的钱),
 * 中转那边今天剩得不多(`remaining_cny` 低于留给通话与事务官的那一截)就不判,明天再说 —— 计入每日 ¥5 那一份。
 */

import type { AgentAxSummary } from '../protocol.ts'

/** 一个 App 的身份(壳 `running_apps` 读它包里的 Info.plist 读出来的)。 */
export interface AppIdentity {
  bundle_id: string
  /** 显示名(它自己带了中文名就用中文名)。 */
  name: string
  /** 另一个名字(系统语言下的名字 / 中文名,两个不一样时才有)。 */
  alias?: string
  category?: string
  vendor?: string
  version?: string
  electron?: boolean
}

export type VerdictKind = 'ai_agent' | 'human_chat' | 'other' | 'unsure'

export interface Verdict {
  kind: VerdictKind
  /** 一句中文理由(模型给的,或者规则给的)。 */
  reason: string
}

const KINDS: readonly VerdictKind[] = ['ai_agent', 'human_chat', 'other', 'unsure']

function isKind(value: unknown): value is VerdictKind {
  return typeof value === 'string' && (KINDS as readonly string[]).includes(value)
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  const chars = [...flat]
  return chars.length <= max ? flat : `${chars.slice(0, max).join('')}…`
}

/** `public.app-category.social-networking` → `social-networking`(给模型看的,短一点)。 */
export function shortCategory(category: string | undefined): string {
  if (category === undefined) return ''
  return category.replace(/^public\.app-category\./, '').trim()
}

/** 一行里不许出现分隔符(`|`)与换行 —— 不然一个 App 的名字就能把清单拆坏。 */
function cell(text: string | undefined, max: number): string {
  return clip((text ?? '').replace(/[|\n\r]/g, ' '), max)
}

// ───────────────────────────── ① 回话的是 AI 还是人 ─────────────────────────────

/** 一次最多问几个 App。 */
export const IDENTITY_BATCH = 12

const CRITERIA = [
  '- ai_agent:这个 App 主要就是用来跟 AI 助手对话、或者把活交给 AI 去做的(各家 AI 助手、AI 智能体的桌面客户端都算)。',
  '- human_chat:主要用来跟真人聊天、发消息的(即时通讯、团队聊天、短信、社交、邮件)。这一类工作台绝不去读。',
  '- other:别的 App(浏览器、编辑器、笔记、办公、设计、开发、远程控制、系统工具、音乐视频……),哪怕里面顺带有 AI 功能也算 other。',
  '- unsure:只凭给出的信息判断不了。',
]

/**
 * 按身份一批判(每个 App 一行:序号|名字|包标识|类别|出品方)。只凭给出的信息判断,拿不准就答 unsure ——
 * 答错成 ai_agent 的代价是多看一眼它的窗口结构(结构不像就不接),答错成 human_chat 的代价是漏接一家(他可以说「接上」)。
 */
export function identityPrompt(apps: readonly AppIdentity[]): string {
  const rows = apps.map((app, index) => [
    String(index + 1), cell(app.alias === undefined ? app.name : `${app.name}(${app.alias})`, 50), cell(app.bundle_id, 80),
    cell(shortCategory(app.category), 40), cell(app.vendor, 60),
  ].join('|'))
  return [
    '你在帮一个桌面工作台判断:这台 Mac 上正在跑的几个 App,各是不是「跟 AI 对话、让 AI 干活」的 App。',
    '每个 App 归到下面四类之一:',
    ...CRITERIA,
    '只凭下面给的信息判断,不要猜你不知道的;拿不准就答 unsure。',
    'App 清单(每行:序号|名字|包标识|类别|出品方):',
    ...rows,
    '只回一个 JSON 数组,每个 App 一项,不要别的字:',
    '[{"n":1,"kind":"ai_agent|human_chat|other|unsure","reason":"一句中文理由"}]',
  ].join('\n')
}

/** 模型回的那一段里的第一个 JSON 数组 / 对象(它常在前后加几句话或者代码围栏)。 */
function firstJson(text: string, open: '[' | '{'): unknown {
  const close = open === '[' ? ']' : '}'
  const start = text.indexOf(open)
  const end = text.lastIndexOf(close)
  if (start === -1 || end <= start) return undefined
  try { return JSON.parse(text.slice(start, end + 1)) }
  catch { return undefined }
}

/**
 * 解一批判的回答 → 按包标识的结论。**没回、回坏了的那一家不在结果里**(下次再判,不替它编一个)。
 */
export function parseIdentityVerdicts(text: string, apps: readonly AppIdentity[]): Map<string, Verdict> {
  const out = new Map<string, Verdict>()
  const parsed = firstJson(text, '[')
  if (!Array.isArray(parsed)) return out
  for (const item of parsed) {
    if (typeof item !== 'object' || item === null) continue
    const row = item as Record<string, unknown>
    const n = typeof row.n === 'number' ? row.n : typeof row.n === 'string' ? Number.parseInt(row.n, 10) : Number.NaN
    const app = Number.isInteger(n) ? apps[n - 1] : undefined
    if (app === undefined || !isKind(row.kind)) continue
    const reason = typeof row.reason === 'string' && row.reason.trim() !== '' ? clip(row.reason, 80) : '模型没给理由'
    out.set(app.bundle_id, { kind: row.kind, reason })
  }
  return out
}

// ───────────────────────────── ② 窗口像不像对话窗口 ─────────────────────────────

export interface ProbeRect { x: number, y: number, w: number, h: number }

/** 壳 `agent_probe` 回来的那一份(只有结构与界面字,没有对话内容)。字段见 workbench-app/Sources/AgentWindow.swift。 */
export interface WindowProbe {
  running: boolean
  windows: number
  ax_err?: number
  active?: boolean
  hidden?: boolean
  window?: { w: number, h: number, sheet?: boolean, minimized?: boolean }
  inputs: readonly (ProbeRect & { role: string, settable?: boolean, ph?: string, composer?: string })[]
  send: readonly (ProbeRect & { label?: string })[]
  stop: readonly ProbeRect[]
  new_chat: { menu: readonly string[], buttons: readonly string[] }
  lists: readonly (ProbeRect & { role: string, rows: number })[]
  left_links: number
  texts: { total: number, left: number, above_input: number }
  toolbar: readonly string[]
  menus: readonly string[]
  visited?: number
  capped?: boolean
  /** 各角色各数到几个(新壳才有;**只数不读**)。 */
  roles?: Readonly<Record<string, number>>
  /** 读之前敲过 `AXManualAccessibility` 没有(新壳才报)。 */
  ax_manual?: boolean
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function str(value: unknown, max = 80): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? clip(value, max) : undefined
}

function rect(value: unknown): ProbeRect {
  const r = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>
  return { x: num(r.x), y: num(r.y), w: num(r.w), h: num(r.h) }
}

function arr(value: unknown): readonly Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((one): one is Record<string, unknown> => typeof one === 'object' && one !== null) : []
}

function strings(value: unknown, max = 40): string[] {
  return Array.isArray(value) ? value.filter((one): one is string => typeof one === 'string' && one.trim() !== '').map(one => clip(one, max)) : []
}

/** 把壳回来的那一包收成 `WindowProbe`(坏字段当没有,**不抛**)。 */
export function parseProbe(raw: Record<string, unknown>): WindowProbe {
  const win = typeof raw.window === 'object' && raw.window !== null ? raw.window as Record<string, unknown> : undefined
  const newChat = typeof raw.new_chat === 'object' && raw.new_chat !== null ? raw.new_chat as Record<string, unknown> : {}
  const texts = typeof raw.texts === 'object' && raw.texts !== null ? raw.texts as Record<string, unknown> : {}
  return {
    running: raw.running === true,
    windows: num(raw.windows),
    ...(typeof raw.ax_err === 'number' ? { ax_err: raw.ax_err } : {}),
    ...(typeof raw.active === 'boolean' ? { active: raw.active } : {}),
    ...(typeof raw.hidden === 'boolean' ? { hidden: raw.hidden } : {}),
    ...(win === undefined ? {} : { window: { w: num(win.w), h: num(win.h), sheet: win.sheet === true, minimized: win.minimized === true } }),
    inputs: arr(raw.inputs).map(one => ({
      ...rect(one),
      role: str(one.role, 30) ?? '',
      settable: one.settable === true,
      ...(str(one.ph, 60) === undefined ? {} : { ph: str(one.ph, 60) as string }),
      ...(str(one.composer, 80) === undefined ? {} : { composer: str(one.composer, 80) as string }),
    })),
    send: arr(raw.send).map(one => ({ ...rect(one), ...(str(one.label, 30) === undefined ? {} : { label: str(one.label, 30) as string }) })),
    stop: arr(raw.stop).map(rect),
    new_chat: { menu: strings(newChat.menu, 30), buttons: strings(newChat.buttons, 30) },
    lists: arr(raw.lists).map(one => ({ ...rect(one), role: str(one.role, 30) ?? '', rows: num(one.rows) })),
    left_links: num(raw.left_links),
    texts: { total: num(texts.total), left: num(texts.left), above_input: num(texts.above_input) },
    toolbar: strings(raw.toolbar, 30).slice(0, 12),
    menus: strings(raw.menus, 20).slice(0, 14),
    ...(typeof raw.visited === 'number' ? { visited: raw.visited } : {}),
    ...(raw.capped === true ? { capped: true } : {}),
    ...(roles(raw.roles) === undefined ? {} : { roles: roles(raw.roles) as Record<string, number> }),
    ...(typeof raw.ax_manual === 'boolean' ? { ax_manual: raw.ax_manual } : {}),
  }
}

/** `{ AXButton: 12, AXGroup: 40 }`(坏字段整格当没有)。 */
function roles(value: unknown): Record<string, number> | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const out: Record<string, number> = {}
  for (const [role, count] of Object.entries(value as Record<string, unknown>)) {
    if (typeof count === 'number' && Number.isFinite(count) && count > 0) out[clip(role, 40)] = Math.trunc(count)
  }
  return Object.keys(out).length === 0 ? undefined : out
}

/**
 * 这一扇窗的辅助功能**结构摘要**(2026-10-01,诊断用)。**只数不读** —— 每一格都是个数或者尺寸,
 * 没有标题、没有提示字、没有按钮名、没有任何对话内容。诊断包里带的就是它。
 */
export function axSummaryOf(probe: WindowProbe, at: string): AgentAxSummary {
  return {
    at,
    windows: probe.windows,
    ...(probe.hidden === undefined ? {} : { hidden: probe.hidden }),
    ...(probe.ax_err === undefined ? {} : { ax_err: probe.ax_err }),
    ...(probe.window === undefined ? {} : { window: { w: probe.window.w, h: probe.window.h } }),
    ...(probe.roles === undefined ? {} : { roles: probe.roles }),
    inputs: probe.inputs.length,
    send: probe.send.length,
    stop: probe.stop.length,
    lists: probe.lists.length,
    left_links: probe.left_links,
    texts: probe.texts,
    toolbar: probe.toolbar.length,
    menus: probe.menus.length,
    ...(probe.visited === undefined ? {} : { visited: probe.visited }),
    ...(probe.capped === undefined ? {} : { capped: probe.capped }),
    ...(probe.ax_manual === undefined ? {} : { ax_manual: probe.ax_manual }),
  }
}

/**
 * ★ **自绘界面那一档**(2026-10-02,卡「适配自绘界面的 Kimi」)。
 *
 * 现场(Air 诊断包 20261002-193929,`快照/agents.json`):官网版 Kimi `com.moonshot.kimichat.kmp.mac`
 * 登录之后辅助功能树是 `{AXGroup:4, AXScrollArea:6, AXUnknown:32, AXButton:4, AXWindow:1, AXScrollBar:5, AXStaticText:23}`,
 * `inputs:0 send:0`、`texts.above_input:12` —— **对话文字读得到**,而输入框与发送键被画成了
 * `AXUnknown`,结构那一道认不出,于是整家停在候选、派不了活。
 *
 * 这不是 Kimi 一家的事:凡是自己画界面的工具箱(Compose、Flutter、自画 canvas 那一类)都长这样。
 * 所以**放行成一档,不是放行成一样**:
 *
 * | 哪一档 | 读 | 写 | 登记表里 |
 * |---|---|---|---|
 * | `full`(老样子) | 读得到 | 认得出输入框,AXValue 或粘贴 | 不标 |
 * | `paste_only` | 读得到 | 认不出输入框 —— 点一下 + 粘贴 + 回车,发完**按证据核** | 判定依据里明说 |
 *
 * 认这一档的三条(全部要满足,少一条照旧不过):
 * 1. **一个标准文本输入角色都没有**(`roles` 里没有 `AXTextArea` / `AXTextField` / `AXComboBox`)——
 *    有标准输入框而没认出来是别的毛病(位置不对、整块编辑区),不该走这条路;
 * 2. **认不出来的交互节点够多**(`AXUnknown` ≥ {@link SELF_DRAWN_UNKNOWN_MIN}):自绘的控件就报在这里;
 *    `AXGroup` 故意不算进去 —— 网页那一层的树里到处是 `AXGroup`,算进去会把「树还没建好的 Electron 应用」误当自绘;
 * 3. **有个滚得动的对话区**(`AXScrollArea` / `AXScrollBar` / 列表至少一个)+ 对话区那一道(`surface`)。
 *    Kimi 安装器那扇窗(`{AXButton:3, AXBusyIndicator:1, AXStaticText:2, AXWindow:1}`,`texts.above_input:2`)
 *    就是靠这一条与第 2 条被挡住的 —— 它确实不是对话窗口。
 *
 * `roles` 要新壳才有:老壳缺席这一格 → 这一档永不触发(老行为一字不变)。
 */
export type StructureMode = 'full' | 'paste_only'

/** 自绘界面至少要有这么多个认不出来的交互节点(`AXUnknown`)。Kimi 真机 32 个。 */
export const SELF_DRAWN_UNKNOWN_MIN = 4

/** 标准的文本输入角色(与壳 `SendTextPolicy.inputRoles` 同一张表,一处改两处跟)。 */
const INPUT_ROLES: readonly string[] = ['AXTextArea', 'AXTextField', 'AXComboBox']

/**
 * 这扇窗**是不是自绘界面**(只看角色直方图与滚动区,不看一个字)。见 {@link StructureMode}。
 * `roles` 缺席(老壳)→ 一律 false。
 */
export function looksSelfDrawn(probe: WindowProbe): boolean {
  const roles = probe.roles
  if (roles === undefined) return false
  if (INPUT_ROLES.some(role => (roles[role] ?? 0) > 0)) return false
  if ((roles.AXUnknown ?? 0) < SELF_DRAWN_UNKNOWN_MIN) return false
  const scrollable = (roles.AXScrollArea ?? 0) > 0 || (roles.AXScrollBar ?? 0) > 0 || probe.lists.length > 0
  return scrollable
}

// ───────────────────────────── ②' 那扇窗的辅助功能树**明细**(诊断用) ─────────────────────────────

/**
 * ★ **输入框认不出的那几家,诊断包带上树的明细**(2026-10-02,卡「适配自绘界面的 Kimi」)。
 *
 * 10-01 那一份只带角色的个数({@link AgentAxSummary}),于是隔着一台机器只看得到
 * `{AXUnknown:32, AXScrollArea:6, AXStaticText:23}` —— 认得出「它是自绘界面」,
 * 还是写不出「输入框是哪一个节点、怎么往里写」。明细补的就是这一步。
 *
 * **一个字的内容都不收**:这里只挑角色名、子角色名、动作名、属性名(全是系统常量)、位置大小、
 * 以及标题 / 说明 / 帮助 / 值的**字数**。壳那一侧已经只回这些({@link AgentWindow.axDetail}),
 * 这个解析器是**第二道门** —— 哪天壳变了、多回了一格字,它也进不了登记表、进不了诊断包。
 */
export const AX_DETAIL_MAX = 120

/** 明细里的一个元素(全是结构与数)。 */
export interface AxElementDetail {
  role: string
  sub?: string
  /** 它在树上第几层(窗口自己是 0)。 */
  d: number
  x: number
  y: number
  w: number
  h: number
  /** 按得下去哪些动作(`AXPress` / `AXConfirm` …)。 */
  act?: readonly string[]
  /** 哪几条属性写得进去(`AXValue` / `AXFocused` …)。 */
  set?: readonly string[]
  /** 此刻是不是焦点。 */
  foc?: boolean
  /** 标题 / 说明 / 帮助 / 值各有**几个字**(只有字数)。 */
  tl?: number
  dl?: number
  hl?: number
  vl?: number
}

export interface AxDetail {
  at: string
  window?: { w: number, h: number }
  elements: readonly AxElementDetail[]
  visited?: number
  capped?: boolean
}

const AX_NAME = /^[A-Za-z]{2,40}$/

/** 角色名 / 动作名 / 属性名只收**系统常量那个形状**(纯英文字母)—— 界面上的字过不了这一关。 */
function axNames(value: unknown, max = 8): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out = value.filter((one): one is string => typeof one === 'string' && AX_NAME.test(one)).slice(0, max)
  return out.length === 0 ? undefined : out
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : undefined
}

/** 壳 `agent_ax_detail` 回来的那一包 → 存得住的那一份(坏字段当没有,**不抛**;超了截断)。 */
export function parseAxDetail(raw: Record<string, unknown>, at: string): AxDetail {
  const win = typeof raw.window === 'object' && raw.window !== null ? raw.window as Record<string, unknown> : undefined
  const rows = Array.isArray(raw.elements) ? raw.elements : []
  const elements: AxElementDetail[] = []
  for (const one of rows) {
    if (typeof one !== 'object' || one === null) continue
    const row = one as Record<string, unknown>
    const role = typeof row.role === 'string' && AX_NAME.test(row.role) ? row.role : undefined
    if (role === undefined) continue
    const sub = typeof row.sub === 'string' && AX_NAME.test(row.sub) ? row.sub : undefined
    const act = axNames(row.act)
    const set = axNames(row.set)
    elements.push({
      role,
      ...(sub === undefined ? {} : { sub }),
      d: count(row.d) ?? 0,
      x: num(row.x), y: num(row.y), w: num(row.w), h: num(row.h),
      ...(act === undefined ? {} : { act }),
      ...(set === undefined ? {} : { set }),
      ...(row.foc === true ? { foc: true } : {}),
      ...(count(row.tl) === undefined ? {} : { tl: count(row.tl) as number }),
      ...(count(row.dl) === undefined ? {} : { dl: count(row.dl) as number }),
      ...(count(row.hl) === undefined ? {} : { hl: count(row.hl) as number }),
      ...(count(row.vl) === undefined ? {} : { vl: count(row.vl) as number }),
    })
    if (elements.length >= AX_DETAIL_MAX) break
  }
  return {
    at,
    ...(win === undefined ? {} : { window: { w: num(win.w), h: num(win.h) } }),
    elements,
    ...(count(raw.visited) === undefined ? {} : { visited: count(raw.visited) as number }),
    ...(raw.capped === true || rows.length > AX_DETAIL_MAX ? { capped: true } : {}),
  }
}

/**
 * 这一家**要不要收一份明细**:判成 AI 应用、而**输入框没认出来**的那几家 ——
 * 结构那一道没过的(可灵、App Store 版豆包),以及过了但走的是自绘那一档的(官网 Kimi)。
 * 两种都有同一个空白:「输入框是哪一个节点」。认得出输入框的那几家不收(没有要查的)。
 */
export function wantsAxDetail(verdict: StructureVerdict): boolean {
  if (verdict.hidden === true) return false
  return !verdict.pass || verdict.mode === 'paste_only'
}

export interface StructureVerdict {
  pass: boolean
  /**
   * 过了的那一家**写得进去到什么程度**(2026-10-02)。`full` 缺席 = 老样子(认得出输入框);
   * `paste_only` = 自绘界面,读得到字、输入框认不出,送话靠点一下 + 粘贴,见 {@link StructureMode}。
   */
  mode?: StructureMode
  /**
   * **这一下根本没看成,不是「它不像」**(2026-10-01):它藏着(多半是工作台自己的窗口槽藏的),
   * 藏着的 App 辅助功能一扇窗都列不出。拿着这一格的调用方不许把那一家降级成「不是 Agent」,
   * 也不许照 30 分钟那道冷却等着 —— 等它露面(她切到那一格)再看一眼。
   */
  hidden?: boolean
  /** 有对话区,或者有会话列表。 */
  surface: boolean
  /** 有输入框(在窗口中下部、不是一整块编辑区)。 */
  input: boolean
  /** 有发送键(或者输入区那颗按钮里写着发送)。 */
  send: boolean
  /** 有「新对话」一类的入口(菜单里或窗口里)。 */
  new_chat: boolean
  /** 判定依据 / 没过的原因(人话,记进登记表)。 */
  why: string
}

const SEND_WORD = /发送|送出|send/i

/**
 * 窗口像不像一个对话窗口。三样都要:**对话区或会话列表**、**输入框**、**发送键或「新对话」一类的入口**。
 *
 * - 「新对话」不是非有不可:只有一条长期对话的助手(比如只有一条对话的那种)没有这个入口,但它有发送键;
 *   反过来,空着的新对话里发送键常常要打了字才出现,那时「新对话」入口在。两样有一样就算。
 * - 输入框要在窗口中下部(上沿 25% 以内的是搜索框),而且不能是一整块编辑区(高过窗高 45% 的是文档正文,
 *   不是聊天输入框 —— 笔记、编辑器就是这样被排除的)。
 * - 结构像**不等于**是 Agent:浏览器里开着一个聊天网页、团队聊天软件,结构也都像。回话的是不是 AI 由 ① 判,
 *   两条都过才接。
 */
export function judgeStructure(probe: WindowProbe): StructureVerdict {
  const fail = (why: string): StructureVerdict => ({ pass: false, surface: false, input: false, send: false, new_chat: false, why })
  if (!probe.running) return fail('它没开')
  /*
   * ★ **藏着的时候别说「它没有窗口」**(2026-10-01)。藏它的手多半就是工作台自己的窗口槽
   * (不在台前那一格的 App 由 `dock` 发 `hide_app` 藏起来),藏着的 App 辅助功能一扇窗都列不出。
   * 这一下**什么都没看见**,既不是「它不像对话窗口」,也不是「它没窗口」——
   * 所以 `hidden` 这一格告诉调用方:别降级、别记 30 分钟冷却,等它露面再看。
   * `ax_err` 排在后面:藏着时壳回的多半就是「取不到窗口清单」那一支。
   */
  if (probe.hidden === true && probe.windows === 0) return { ...fail('它这会儿藏在窗口槽里,一扇窗都列不出来 —— 切到它那一格时我再看一眼'), hidden: true }
  if (probe.ax_err !== undefined) return fail(`辅助功能读不到它的窗口(回 ${probe.ax_err})`)
  if (probe.windows === 0 || probe.window === undefined) return fail('它没有窗口(可能只在菜单栏里,或者窗口都关了)')
  const { w, h } = probe.window
  if (w <= 0 || h <= 0) return fail('它的窗口读不出大小')
  const chatInputs = probe.inputs.filter(one =>
    one.w >= 60 && one.h >= 12
    && one.y + one.h / 2 >= h * 0.25
    && one.h <= h * 0.45,
  )
  const input = chatInputs.length > 0
  const surface = probe.texts.above_input >= 2
    || probe.lists.some(list => list.rows >= 3)
    || probe.texts.left >= 3
    || probe.left_links >= 3
  const send = probe.send.length > 0 || chatInputs.some(one => one.composer !== undefined && SEND_WORD.test(one.composer))
  const newChat = probe.new_chat.menu.length > 0 || probe.new_chat.buttons.length > 0
  const pass = input && surface && (send || newChat)
  const have: string[] = []
  if (surface) have.push(probe.texts.above_input >= 2 ? '对话区' : '会话列表')
  if (input) have.push('输入框')
  if (send) have.push('发送键')
  if (newChat) have.push(`「${probe.new_chat.menu[0] ?? probe.new_chat.buttons[0]}」入口`)
  if (pass) return { pass, mode: 'full', surface, input, send, new_chat: newChat, why: `窗口里有${have.join('、')}` }
  /*
   * ★ **自绘界面放行成「读得到、写入靠粘贴」那一档**(2026-10-02,见 StructureMode)。
   * 只在「对话区有、输入框一个标准角色都没有、自绘的样子」这一种情形上放 —— 别的没过照旧不过。
   */
  if (surface && !input && looksSelfDrawn(probe)) {
    return {
      pass: true, mode: 'paste_only', surface, input, send, new_chat: newChat,
      why: `自绘界面:读得到${probe.texts.above_input >= 2 ? '对话区' : '会话列表'}的字,输入框与发送键认不出(都画成 AXUnknown)—— 送话靠点一下 + 粘贴 + 回车,发完按证据核`,
    }
  }
  const missing: string[] = []
  if (!input) missing.push(probe.inputs.length === 0 ? '没有输入框' : '输入框不像聊天输入框(在顶上,或者是一整块编辑区)')
  if (!surface) missing.push('没有对话区也没有会话列表')
  if (!send && !newChat) missing.push('没有发送键,也没有「新对话」一类的入口')
  const capped = probe.capped === true ? '(窗口太大,这次没读完)' : ''
  return { pass, surface, input, send, new_chat: newChat, why: `不像对话窗口:${missing.join(';')}${capped}` }
}

// ───────────────────────────── ①' 带上界面字再判一次 ─────────────────────────────

/** 结构读出来的一句人话(给模型看,也写进判定依据):有输入框(提示字「…」)、有发送键…… */
export function chromeSummary(probe: WindowProbe): string {
  const parts: string[] = []
  const input = probe.inputs.find(one => one.composer !== undefined) ?? probe.inputs.find(one => one.ph !== undefined) ?? probe.inputs[0]
  if (input !== undefined) {
    if (input.composer !== undefined) parts.push(`输入区是一颗按钮,上面写着「${input.composer}」`)
    else parts.push(input.ph === undefined ? '有输入框(没有提示字)' : `有输入框,提示字「${input.ph}」`)
  }
  if (probe.send.length > 0) parts.push('有发送键')
  if (probe.stop.length > 0) parts.push('有停止键')
  const newChat = [...probe.new_chat.menu, ...probe.new_chat.buttons]
  if (newChat.length > 0) parts.push(`有「${newChat[0]}」入口`)
  if (probe.texts.left >= 3 || probe.left_links >= 3 || probe.lists.some(list => list.rows >= 3)) parts.push('左边有一列会话')
  if (probe.toolbar.length > 0) parts.push(`输入框旁边的按钮:${probe.toolbar.join('、')}`)
  if (probe.menus.length > 0) parts.push(`菜单栏:${probe.menus.join('、')}`)
  return parts.join(';')
}

/** 只凭名字判不了(`unsure`)、结构又像的那一家:带上界面字再判一次。**界面字里没有任何聊天内容**。 */
export function windowPrompt(app: AppIdentity, probe: WindowProbe): string {
  return [
    '你在帮一个桌面工作台判断:这个 App 是不是「跟 AI 对话、让 AI 干活」的 App。只凭名字判断不了,',
    '下面加上了它窗口里的界面字(只有按钮名、菜单名、输入框的提示字,没有任何聊天内容)。',
    `名字:${cell(app.alias === undefined ? app.name : `${app.name}(${app.alias})`, 50)};包标识:${cell(app.bundle_id, 80)};类别:${cell(shortCategory(app.category), 40) || '没写'};出品方:${cell(app.vendor, 60) || '没写'}`,
    `窗口:${chromeSummary(probe) || '没读出什么界面字'}`,
    '判断标准:',
    ...CRITERIA,
    '只回一行 JSON,不要别的字:{"kind":"ai_agent|human_chat|other|unsure","reason":"一句中文理由"}',
  ].join('\n')
}

export function parseWindowVerdict(text: string): Verdict | undefined {
  const parsed = firstJson(text, '{')
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const row = parsed as Record<string, unknown>
  if (!isKind(row.kind)) return undefined
  return { kind: row.kind, reason: typeof row.reason === 'string' && row.reason.trim() !== '' ? clip(row.reason, 80) : '模型没给理由' }
}

// ───────────────────────────── 花费 ─────────────────────────────

/** 发现这件事每天最多问几次模型。一批判算一次;判完的记下来,第二天基本是 0 次。 */
export const JUDGE_DAILY_CALLS = 40
/** 发现这件事每天最多花多少(估算,元)。 */
export const JUDGE_DAILY_CNY = 0.3
/**
 * 中转那边今天剩得少于这个数就不判(元)。每日 ¥5 那一份主要是给通话和事务官的:
 * 判一个 App 是不是 Agent 可以等到明天,通话接不上不行。
 */
export const JUDGE_RESERVE_CNY = 1

/**
 * 估一次调用花多少(元)。**往高了估**:按字数当 token 数(中文一个字大约不到一个 token)、
 * 输入 ¥4 / 百万、输出 ¥16 / 百万(比 deepseek-chat 的标价高一倍),让上限只会早到、不会晚到。
 */
export function estimateCallCny(promptChars: number, maxTokens: number): number {
  return (promptChars * 4 + maxTokens * 16) / 1_000_000
}

export interface JudgeBudget {
  /** 本地日期 YYYY-MM-DD。 */
  day: string
  calls: number
  cny: number
}

/** 这一次能不能问模型。不能就回一句人话(记在那一家的「还没判完」上)。 */
export function budgetGate(input: { budget: JudgeBudget, today: string, estimate: number, remainingCny?: number | undefined }): { ok: true } | { ok: false, why: string } {
  const used = input.budget.day === input.today ? input.budget : { day: input.today, calls: 0, cny: 0 }
  if (used.calls >= JUDGE_DAILY_CALLS) return { ok: false, why: `今天判是不是 Agent 已经问了 ${used.calls} 次模型,到上限了,明天再判` }
  if (used.cny + input.estimate > JUDGE_DAILY_CNY) return { ok: false, why: '今天判是不是 Agent 花的钱到上限了,明天再判' }
  if (input.remainingCny !== undefined && input.remainingCny < JUDGE_RESERVE_CNY) {
    return { ok: false, why: `今天的模型额度只剩 ¥${input.remainingCny.toFixed(2)},留给通话和事务官,明天再判` }
  }
  return { ok: true }
}

/** 记一次花费(跨天自动清零)。 */
export function spend(budget: JudgeBudget, today: string, cny: number): JudgeBudget {
  const base = budget.day === today ? budget : { day: today, calls: 0, cny: 0 }
  return { day: today, calls: base.calls + 1, cny: Math.round((base.cny + cny) * 1e6) / 1e6 }
}
