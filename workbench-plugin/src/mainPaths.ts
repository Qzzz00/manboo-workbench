/**
 * **三件主路与首次引导的共享口径**(2026-10-21,卡「引导三件事」;设计 `docs/设计-拿得出手-三件事与首次引导-2026-10-15.md`)。
 *
 * 维护者 10-15 认下的验收句:一个陌生人在一台没碰过的 Mac 上照安装包装好,一周内自己走通三件事,不找你;
 * 出了事,她能自己说清停在哪。三件事 = 早报与播客、交代一件文字活(走协议路给 Claude / Codex)、手机拨一通电话。
 *
 * 这个文件只放**三处要说同一句**的东西(电脑首页、引导、安装器那一页、手机):三件是哪三件、先试哪件怎么认、
 * 顺序、缺哪道门怎么说、自检那一行怎么写、实验开关的默认、「现在能做什么」那张卡的几行。纯数据与纯函数,
 * 放在 src/ 根上(服务端 import 不了客户端,同 `waiting.ts`)。判成没成在 `server/firstUse.ts`。
 *
 * 一条纪律:**不说「都好了」**(设计稿第二节第 7 条)。三样各自写成没成;成的说成,没成的说缺哪道门。
 */
import { BUILD_RELAY_URL } from './buildEndpoints.ts'

export type MainPath = 'morning' | 'delegate' | 'call'

export const MAIN_PATHS: readonly MainPath[] = ['morning', 'delegate', 'call']

export const MAIN_PATH_TITLES: Readonly<Record<MainPath, string>> = {
  morning: '早报与播客',
  delegate: '交代一件事',
  call: '打个电话',
}

/** 行为账里「对象」那一格写的名字(短,数的时候认它)。 */
export const MAIN_PATH_LEDGER_NAMES: Readonly<Record<MainPath, string>> = {
  morning: '早报',
  delegate: '交代',
  call: '电话',
}

export function isMainPath(value: unknown): value is MainPath {
  return typeof value === 'string' && (MAIN_PATHS as readonly string[]).includes(value)
}

/** 五问前那一问(设计稿第二节第 3 条),逐字。 */
export const FIRST_TRY_ASK = '想先试哪一件:早报、交代一件事?'

/** 她答的那一句 → 哪一件。按钮传 id;话里认字。说「都行」或认不出 = 没选(按默认顺序)。 */
export function firstTryOf(raw: unknown): MainPath | undefined {
  if (isMainPath(raw)) return raw
  if (typeof raw !== 'string') return undefined
  const text = raw.trim()
  if (text === '') return undefined
  if (/电话|打给|拨/u.test(text)) return 'call'
  if (/早报|播客|资讯|新闻/u.test(text)) return 'morning'
  if (/交代|派|一件事|干活/u.test(text)) return 'delegate'
  return undefined
}

/** 第一次有用的顺序:答了哪件就排第一,其余照「早报 → 交代 → 电话」。 */
export function firstUseOrder(prefer: MainPath | undefined): MainPath[] {
  if (prefer === undefined) return [...MAIN_PATHS]
  return [prefer, ...MAIN_PATHS.filter(one => one !== prefer)]
}

/** 第一次有用那几句(设计稿第二节第 4–7 条)。`call_desk` = 没配手机的人(iPhone / 没手机)那一版第三件。 */
export const FIRST_USE_SAY = {
  morning: '我先把今天的资讯整理成早报,一分钟。',
  delegate: '挑一件你手上的事,交给我试试;没想好就让我把这个项目介绍一遍。',
  call: '手机上拨给我一下。',
  call_desk: '没配手机也行:在电脑上对我说一句你要我盯的事,我记成一张事项。',
  closing: '三样都通了,剩下的用到时我再问。',
} as const

/** 「交代」那一件她没想好时,替她交代的那一句(派给协议路那一家)。 */
export const DELEGATE_DEFAULT_TEXT = '把这个项目介绍一遍:看一下这台电脑上的项目列表和当前目录,用一段话说清它在做什么、现在大概到哪了。只读,不改任何文件。'

/** 电话那一件是拿手机打,还是在电脑上说(没配过手机 = 电脑)。 */
export type CallMode = 'phone' | 'desk'

/** ——— 缺哪道门 ——— */

export type FirstUseDoor = 'service' | 'model' | 'ai_missing' | 'ai_login' | 'phone' | 'worker' | 'voice' | 'news' | 'other'

/** 一颗修的键。界面照 `kind` 办:`login_cli` 打 `/agents/login`;其余是去哪一页。 */
export interface DoorFix {
  kind: 'login_cli' | 'pair' | 'model' | 'setup'
  label: string
  family?: string
}

export interface DoorView {
  door: FirstUseDoor
  /** 短名(卡上那一格、行为账里「类」旁边的字)。 */
  title: string
  /** 一句怎么办。 */
  text: string
  fixes: readonly DoorFix[]
}

export interface DoorInput {
  /** 登录键给哪几家(本机装了、还没登录的那几家)。 */
  families?: readonly { family: string, title: string }[]
  /** 认不出的那一种:原因原话。 */
  note?: string
}

export function doorView(door: FirstUseDoor, input: DoorInput = {}): DoorView {
  switch (door) {
    case 'service':
      return { door, title: '工作台服务没起来', text: '重开一次工作台再试;还不行就重启电脑。', fixes: [] }
    case 'model':
      return {
        door,
        title: '缺模型钥匙',
        // 构建没带中转(开源构建,2026-10-21)就没有「登录自动接上」这一路,只说填自己的钥匙。
        text: BUILD_RELAY_URL === ''
          ? '在设置 › 模型里填你自己的 DeepSeek 密钥就能用。'
          : '登录工作台账号就会自动接上;或在设置 › 模型里填自己的钥匙。',
        fixes: [{ kind: 'model', label: '去接模型' }],
      }
    case 'ai_missing':
      return { door, title: '这台电脑上没有 Claude 或 Codex', text: '交代的活要一家能干活的 AI:先装上 Claude 或 Codex 其中一家,装好登录一次。', fixes: [] }
    case 'ai_login':
      return {
        door,
        title: '没登录 Claude 或 Codex',
        text: '先登录 Claude 或 Codex 其中一家',
        fixes: (input.families ?? []).map(one => ({ kind: 'login_cli' as const, label: `登录 ${one.title}`, family: one.family })),
      }
    case 'phone':
      return {
        door,
        title: '手机没配对',
        text: '扫一下配对页的二维码,或在手机上输那六位配对码;没有安卓手机也行,第三件改在电脑上对我说一句。',
        fixes: [{ kind: 'pair', label: '去配对' }],
      }
    case 'worker':
      return { door, title: '通话那一块没起来', text: '电话打不进来:到设置 › 体检第 1 步看一眼。', fixes: [{ kind: 'setup', label: '去体检' }] }
    case 'voice':
      return { door, title: '语音服务没接上', text: '早报出来了,播客没出声:登录工作台账号后语音会自动接上。', fixes: [{ kind: 'model', label: '去接上' }] }
    case 'news':
      return { door, title: '今天没拉到资讯', text: '网不通,或还没接搜索;连上网再出一份。', fixes: [] }
    case 'other':
      return { door, title: '没成', text: input.note === undefined || input.note.trim() === '' ? '原因没说出来,看一眼那张卡。' : input.note.trim(), fixes: [] }
  }
}

/** ——— 安装器末尾那三行 ——— */

/** `pending` = 派出去了还没回(交代那一件);`running` = 正在试。 */
export type SelfCheckState = 'ok' | 'missing' | 'pending' | 'running'

export interface SelfCheckRow {
  path: MainPath
  state: SelfCheckState
  door?: DoorView
  /** 一句补充(派给哪一家了、用的是内置示例资讯……)。 */
  note?: string
}

/** 不许出现在任何一句总结里的字眼(设计稿:「不说『都好了』」)。 */
export const ALL_GOOD_WORDS: readonly string[] = ['都好了', '全好了', '一切正常']

/** 一行:「交代一件事:没成 —— 没登录 Claude 或 Codex。先登录 Claude 或 Codex 其中一家(点「登录 Claude」)。」 */
export function selfCheckLine(row: SelfCheckRow): string {
  const title = MAIN_PATH_TITLES[row.path]
  if (row.state === 'ok') return row.note === undefined ? `${title}:成` : `${title}:成(${row.note})`
  if (row.state === 'running') return `${title}:在试`
  if (row.state === 'pending') return `${title}:在路上 —— ${row.note ?? '派出去了'},结果回来会出现在卡上`
  const door = row.door ?? doorView('other', row.note === undefined ? {} : { note: row.note })
  // 只点名登录那几颗:安装器、命令行、工作台三处都有它;去配对 / 去接模型那几颗只在工作台里有,那一句里已经说了去哪。
  const keys = door.fixes.filter(one => one.kind === 'login_cli').map(one => `「${one.label}」`).join(' 或 ')
  const text = door.text.replace(/[。.]$/u, '')
  // 认不出是哪道门:不念「没成 —— 没成」,直接说原因原话(2026-10-21 隔离实例真机)。
  if (door.door === 'other') return `${title}:没成 —— ${text}。`
  return `${title}:没成 —— ${door.title}。${text}${keys === '' ? '' : `(点${keys})`}。`
}

/** 三行上面那一句总结。只数、只点名,不说「都好了」。 */
export function selfCheckSummary(rows: readonly SelfCheckRow[]): string {
  const ok = rows.filter(one => one.state === 'ok')
  if (rows.length > 0 && ok.length === rows.length) return '三件都试过了,都成。'
  const left = rows.filter(one => one.state !== 'ok').map(one => MAIN_PATH_TITLES[one.path])
  return `三件里成了 ${ok.length} 件;${left.join('、')}还差一步,见下面。`
}

/** ——— 实验开关 ——— */

export type ExperimentKey = 'video' | 'meeting' | 'handset' | 'window_dispatch'

export const EXPERIMENT_KEYS: readonly ExperimentKey[] = ['video', 'meeting', 'handset', 'window_dispatch']

export const EXPERIMENT_TITLES: Readonly<Record<ExperimentKey, string>> = {
  video: '视频(豆包出图 → 可灵出片)',
  meeting: '会议录音转纪要',
  handset: '座机听筒',
  window_dispatch: '派活到豆包 / Kimi(读窗口)',
}

/** 关着时她对这一类要求说的那一句(设计稿第一节),逐字。 */
export const EXPERIMENT_OFF_LINE = '这一类还在内测,我先不接。'

/** 内部(维护者与内测同学)还是外部。只决定实验开关的**默认**,不是权限。 */
export type Audience = 'internal' | 'external'

export type ExperimentsSaved = Partial<Record<ExperimentKey, boolean>>

export function isExperimentKey(value: unknown): value is ExperimentKey {
  return typeof value === 'string' && (EXPERIMENT_KEYS as readonly string[]).includes(value)
}

/** 四样各开没开:存过的照存的,没存过的按内外默认(内部开、外部关)。 */
export function experimentsOf(saved: ExperimentsSaved | undefined, audience: Audience): Record<ExperimentKey, boolean> {
  const fallback = audience === 'internal'
  return Object.fromEntries(EXPERIMENT_KEYS.map(key => [key, saved?.[key] ?? fallback])) as Record<ExperimentKey, boolean>
}

/** 内部还是外部:环境变量 `WORKBENCH_AUDIENCE` > app.json 存的 > 有源码仓库的机器算内部 > 外部。 */
export function audienceOf(input: { env?: string, saved?: string, sourceRepo: boolean }): Audience {
  const pick = (raw: string | undefined): Audience | undefined => raw === 'internal' || raw === 'external' ? raw : undefined
  return pick(input.env?.trim()) ?? pick(input.saved) ?? (input.sourceRepo ? 'internal' : 'external')
}

/** 认话(`server/understand.ts` 的 `kind`)认出来的那一类归哪个开关。不归任何开关 = 主路,照办。 */
export function experimentOfUnderstanding(kind: string): ExperimentKey | undefined {
  if (kind === 'video') return 'video'
  if (kind === 'meeting_plan') return 'meeting'
  return undefined
}

/** 读窗派活那一样管的是哪几家(设计稿第一节:豆包 / Kimi)。Claude / Codex 走协议路,不归它。 */
export const WINDOW_EXPERIMENT_FAMILIES: readonly string[] = ['doubao', 'kimi']

export function windowDispatchExperiment(family: string): boolean {
  return WINDOW_EXPERIMENT_FAMILIES.includes(family)
}

/** /state 里那一格。 */
export interface ExperimentsView {
  audience: Audience
  on: Readonly<Record<ExperimentKey, boolean>>
}

/** ——— 首次引导那一段与首页那张卡 ——— */

/** 一件主路此刻怎样:`ok` 成过 / `missing` 缺一道门(或试过没成)/ `todo` 还没试 / `trying` 正在试。 */
export type FirstUsePathState = 'ok' | 'missing' | 'todo' | 'trying'

export interface FirstUsePathView {
  path: MainPath
  title: string
  state: FirstUsePathState
  /** 事务官这一件说的那一句(第一次有用那一屏)。 */
  say: string
  door?: DoorView
  /** 第一次成的时刻(ISO)与那是装好后的第几天(从 1 数)。 */
  first_ok_at?: string
  ok_day?: number
  first_fail_at?: string
  oks: number
  fails: number
}

export interface SelfCheckView {
  started_at: string
  ended_at?: string
  rows: readonly SelfCheckRow[]
  /** 每行照 {@link selfCheckLine} 拼好的那一句(安装器与命令行原样显示)。 */
  lines: readonly string[]
  summary: string
}

export interface FirstUseView {
  /** 她答的那一问(不答 / 说「都行」缺席)。 */
  prefer?: MainPath
  /** 那一问答过的时刻(说「都行」也算答过,不再问第二遍)。 */
  asked_at?: string
  order: readonly MainPath[]
  call_mode: CallMode
  paths: readonly FirstUsePathView[]
  /** 三样都成过的那一刻(之后只说一次收尾那一句)。 */
  closed_at?: string
  /** 从哪天数「第几天」(装好 / 这一版第一次起来那天,本机日期)。 */
  day0: string
  selfcheck?: SelfCheckView
}

export interface CapabilityRow {
  key: string
  kind: 'main' | 'beta'
  title: string
  state: FirstUsePathState | 'on' | 'off'
  line: string
  door?: DoorView
}

/** 一件主路此刻那一句(首页那张卡与第一次有用那一屏同一句)。 */
export function mainPathLine(state: FirstUsePathState, door: DoorView | undefined): string {
  if (state === 'ok') return '通了'
  if (state === 'trying') return '在试'
  // 认不出是哪道门的:不写「缺一步:没成」这种绕口的话,原因原话在底下那一行。
  if (state === 'missing') return door === undefined || door.door === 'other' ? '这次没成' : `缺一步:${door.title}`
  return '还没试过'
}

/** 「现在能做什么」那张卡:三件主路各一行,实验里的几样标「内测中」。 */
export function capabilityRows(input: {
  paths: readonly { path: MainPath, state: FirstUsePathState, door?: DoorView }[]
  experiments: Readonly<Record<ExperimentKey, boolean>>
}): CapabilityRow[] {
  const main = input.paths.map((one): CapabilityRow => ({
    key: one.path,
    kind: 'main',
    title: MAIN_PATH_TITLES[one.path],
    state: one.state,
    line: mainPathLine(one.state, one.door),
    ...(one.door === undefined || one.state === 'ok' ? {} : { door: one.door }),
  }))
  const beta = EXPERIMENT_KEYS.map((key): CapabilityRow => ({
    key,
    kind: 'beta',
    title: EXPERIMENT_TITLES[key],
    state: input.experiments[key] ? 'on' : 'off',
    line: input.experiments[key] ? '内测中' : '内测中 · 没开',
  }))
  return [...main, ...beta]
}
