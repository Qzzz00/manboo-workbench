/**
 * 引导落地的**纯函数那一半**(2026-09-24 晚,卡 feat/onboarding-materialize;设计 docs/设计-引导落地-引导结束后的样子-2026-09-24.md 第三节)。
 *
 * 维护者 18:25–18:52 手机语音走完整遍引导,对话好、59 次记录全成功,**挂断后一件都没落到界面上**:
 * 「结束的时候应该可以直接生成事项,然后它自己开始派活吧?」「我刚才和 AI 可是聊了半小时啊,你不会让我准备再来一次吧?」
 *
 * 所以「落地」是一个**独立、可重跑**的步骤:读存档(onboarding.json 的答案 + 项目区 + 看板)→ 排一份计划(预览)→
 * 他点「就这样」才写 → 写完派第一件。这个文件只管「排」:
 *   - 把他的原话(项目细节、愿景、拿不准、其它、第一件)切成一句一句,按一张**主题表**认出卡片(确定性兜底,{@link rulesExtract});
 *   - 模型那一份(见 materializeModel.ts)回来后与规则那一份**合并**({@link mergeExtractions}):
 *     规则认得的主题以规则为准(同一份存档重跑,标题一个字不变 = 按内容去重才站得住),模型多认出来的补在后面;
 *   - 对照项目区 / 看板 / 例程 / 免打扰 / 资讯现在的样子,排出一行一行的计划({@link buildPlan}):已经有的标「已经有了」不再建;
 *   - 算电话里那一句({@link planLine}):「都摆好了,两个项目、十件事,屏幕上有张单子;第一件交给 Codex 接着做参赛网页,行吗?」
 *
 * **没有 I/O**:读盘、调模型、写看板都在 materializeService.ts。用例拿维护者那份存档的副本对第三节的对照表。
 */
import { createHash } from 'node:crypto'
import type { MaterializeGroup, MaterializeOwner, MaterializeRowKind, MaterializeRowView, TaskAssignee, TaskPriority, TaskStatus, TaskView } from '../protocol.ts'
import { MATERIALIZE_OWNER_LABELS, taskOriginOf } from '../protocol.ts'
import { DIVISION_TITLE, divisionFromArchive, divisionRuleText, familiesIn } from './dispatchChoice.ts'

export type { MaterializeGroup, MaterializeRowKind }

// ———————————————————————————— 输入 ————————————————————————————

/** 存档里落地要读的那几样(onboarding.json 的子集,只读)。 */
export interface MaterializeArchive {
  stage: string
  nickname?: string
  mode?: string
  template?: string
  answers: Readonly<Record<string, Readonly<Record<string, unknown>>>>
  plan_tasks?: Readonly<Record<string, readonly string[]>>
  memory_index?: readonly string[]
  app_labels?: readonly string[]
  startedAt?: string
  updatedAt?: string
}

/** 引导里记下的一个项目(answers.projects.project 里的一条)。 */
export interface ArchivedProject {
  name: string
  one_liner?: string
  status?: string
  details?: string
  vision?: string
  next_step?: string
  deadline?: string
  unsure?: readonly string[]
  path?: string
  later?: boolean
}

// ———————————————————————————— 抽出来的卡片 ————————————————————————————

/**
 * 负责人。**看板上的 `assignee` 只收几家 Agent**(protocol.ts `TaskAssignee`),
 * 「你 / 同事 / 别人」没有地方放 —— 落到卡上时写进 desc 那一行「负责:同事(9/29 回来写)」,assignee 缺席。
 */
export type CardOwner = MaterializeOwner
export const CARD_OWNERS: readonly CardOwner[] = ['codex', 'claude', 'kimi', 'butler', 'me', 'colleague', 'other']
export const OWNER_LABELS: Record<CardOwner, string> = MATERIALIZE_OWNER_LABELS
/** 能直接当看板 `assignee` 的几个(其余只写进描述)。 */
const AGENT_OWNERS: ReadonlySet<CardOwner> = new Set(['codex', 'claude', 'kimi'])

export type CardStatus = 'todo' | 'doing' | 'confirm'

export interface ExtractedCard {
  /** 他的说法,短。 */
  title: string
  owner: CardOwner
  /** 负责人那一格的补充(「9/29 回来写」「别人接手」)。 */
  owner_note?: string
  status: CardStatus
  /** YYYY-MM-DD。冲刺截止日不用每张都写。 */
  due?: string
  priority?: TaskPriority
  /** false = 他说了「不算阻塞」。 */
  blocking?: boolean
  /** 进哪个模块(看板上冲刺底下的一栏)。 */
  group?: string
  /** 一句补充(卡上的小字)。 */
  note?: string
  /** 出自他哪句原话(原样摘)。 */
  quote: string
  /** 「第一件」:落地后派出去的那一张。 */
  first?: boolean
  /** 规则表里的主题 id(模型那一份没有)。合并与去重认它。 */
  topic?: string
}

/** 他顺口说的另一个项目(「Lapis 项目:仓库名还叫 Echo……Kimi 现在专门负责它」)。 */
export interface ExtraProject {
  name: string
  /** 仓库目录名(「仓库名还叫 Echo」)。 */
  repo?: string
  owner?: CardOwner
  note?: string
}

export interface Extraction {
  /** 这份卡片是谁认出来的。`model+rules` = 模型那一份与规则表合并过。 */
  source: 'rules' | 'model+rules'
  /** 卡片归哪个项目(引导里确认的那一个的名字)。 */
  project?: string
  /** 比赛名(「Spotlight」)。截止日那一行写「Spotlight 报名截止」。 */
  contest?: string
  sprint?: { name: string, deadline: string }
  /** 项目背景一句(假期、行程),写进项目文件,不出卡。 */
  background?: string
  cards: ExtractedCard[]
  projects: ExtraProject[]
  /** 资讯关注方向:项目名 → 关键词(只从他的话里取)。 */
  keywords: Record<string, string[]>
  /** 没出卡的原话与原因(过时的交接清单、他说不做的),给人看。 */
  skipped: { text: string, why: string }[]
  /** 模型那一份没用上的原因(没接模型、超时、回的不是 JSON……)。 */
  model_note?: string
}

// ———————————————————————————— 小工具 ————————————————————————————

// 全角的逗号、冒号、分号、括号、叹号问号也算(模型回的原话常是全角的):\uFF0C \uFF1A \uFF1B \uFF08 \uFF09 \uFF01 \uFF1F。
const PUNCT = /[\s,,\uFF0C。.、;;\uFF1B::\uFF1A!!\uFF01??\uFF1F()()\uFF08\uFF09「」『』"'“”‘’《》<>\[\]【】/\\|+·\-—_~`*#]+/g
/** 比标题用:去空白与标点、小写,去掉「她 / 事务官 / 你 / 让 / 把」这类不改变事情本身的字。 */
export function normalizeTitle(text: string): string {
  return text.toLowerCase().replace(PUNCT, '').replace(/事务官|她|你|我|让|把|一下|能够/g, '')
}

function bigrams(text: string): Map<string, number> {
  const out = new Map<string, number>()
  const chars = Array.from(text)
  for (let i = 0; i + 1 < chars.length; i += 1) {
    const gram = `${chars[i]}${chars[i + 1]}`
    out.set(gram, (out.get(gram) ?? 0) + 1)
  }
  return out
}

/** 两个标题像不像(字二元组的 Dice 系数,0–1)。一个字的标题按全等算。 */
export function titleSimilarity(a: string, b: string): number {
  const x = normalizeTitle(a)
  const y = normalizeTitle(b)
  if (x === '' || y === '') return 0
  if (x === y) return 1
  const gx = bigrams(x)
  const gy = bigrams(y)
  let common = 0
  let total = 0
  for (const count of gx.values()) total += count
  for (const count of gy.values()) total += count
  for (const [gram, count] of gx) common += Math.min(count, gy.get(gram) ?? 0)
  return total === 0 ? 0 : (2 * common) / total
}

/** 算「像同一件事」的门槛。 */
export const SAME_TITLE = 0.72

export function contentHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16)
}

/** `0.2.83` 这种版本号比大小。认不出回 undefined。 */
export function compareVersions(a: string, b: string): number | undefined {
  const pa = /^(\d+)\.(\d+)\.(\d+)$/.exec(a)
  const pb = /^(\d+)\.(\d+)\.(\d+)$/.exec(b)
  if (pa === null || pb === null) return undefined
  for (let i = 1; i <= 3; i += 1) {
    const diff = Number(pa[i]) - Number(pb[i])
    if (diff !== 0) return diff
  }
  return 0
}

/** 一段话里提到的版本号(`0.2.80`)。 */
export function versionsIn(text: string): string[] {
  return [...text.matchAll(/(?<![\d.])(\d+\.\d+\.\d+)(?![\d.])/g)].map(m => m[1] as string)
}

/** 一段话里最大的那个版本号。 */
export function maxVersion(texts: readonly string[]): string | undefined {
  let best: string | undefined
  for (const text of texts) {
    for (const version of versionsIn(text)) {
      if (best === undefined || (compareVersions(version, best) ?? 0) > 0) best = version
    }
  }
  return best
}

/** 这段话提到的版本比 current 旧吗(提到了、且最大的那个也比现在旧)。回旧的那个版本号。 */
export function staleVersionOf(text: string, current: string | undefined): string | undefined {
  if (current === undefined) return undefined
  const mentioned = maxVersion([text])
  if (mentioned === undefined) return undefined
  return (compareVersions(mentioned, current) ?? 0) < 0 ? mentioned : undefined
}

/** `2026-10-04` → `10-04`。 */
function monthDay(date: string): string {
  return date.slice(5)
}

/** `9/29` → `9/29`;`2026-09-28` → `9/28`(卡上写短的)。 */
function shortDate(date: string): string {
  const [, month, day] = /^\d{4}-(\d{2})-(\d{2})$/.exec(date) ?? []
  return month === undefined || day === undefined ? date : `${Number(month)}/${Number(day)}`
}

function isoFromMonthDay(month: number, day: number, today: string): string | undefined {
  const year = Number(today.slice(0, 4))
  if (!Number.isFinite(year) || month < 1 || month > 12 || day < 1 || day > 31) return undefined
  const at = new Date(Date.UTC(year, month - 1, day))
  if (at.getUTCMonth() + 1 !== month || at.getUTCDate() !== day) return undefined
  const iso = at.toISOString().slice(0, 10)
  // 比今天早半年以上的按明年算(九月说「一月五号」指的是明年)。
  if (Date.parse(`${iso}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`) < -180 * 86_400_000) {
    return isoFromMonthDay(month, day, `${year + 1}${today.slice(4)}`)
  }
  return iso
}

/**
 * 一句话里的日子:`2026-10-04` / `10 月 4 日` / `10-04` / `9/29` / `29 号`(只有「号」时按今天这个月)。
 * 抠不出来回 undefined(不猜)。
 */
export function dateIn(text: string, today: string): string | undefined {
  const full = /(\d{4})\s*[-/年]\s*(\d{1,2})\s*[-/月]\s*(\d{1,2})/.exec(text)
  if (full !== null) return isoFromMonthDay(Number(full[2]), Number(full[3]), `${full[1]}${today.slice(4)}`)
  const md = /(?<![\d.])(\d{1,2})\s*(?:月|\/)\s*(\d{1,2})\s*(?:日|号)?(?![\d.])/.exec(text)
  if (md !== null) return isoFromMonthDay(Number(md[1]), Number(md[2]), today)
  const dayOnly = /(?<![\d./])(\d{1,2})\s*号/.exec(text)
  if (dayOnly !== null) return isoFromMonthDay(Number(today.slice(5, 7)), Number(dayOnly[1]), today)
  return undefined
}

// ———————————————————————————— 从存档里取原话 ————————————————————————————

export function archivedProjects(archive: MaterializeArchive): ArchivedProject[] {
  const raw = archive.answers.projects?.project
  if (raw === null || typeof raw !== 'object') return []
  const out: ArchivedProject[] = []
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value === null || typeof value !== 'object') continue
    const item = value as Record<string, unknown>
    const text = (field: string): string | undefined => typeof item[field] === 'string' && (item[field] as string).trim() !== '' ? (item[field] as string).trim() : undefined
    const unsure = Array.isArray(item.unsure) ? item.unsure.filter((one): one is string => typeof one === 'string' && one.trim() !== '') : undefined
    const project: ArchivedProject = { name: text('name') ?? key }
    for (const field of ['one_liner', 'status', 'details', 'vision', 'next_step', 'deadline', 'path'] as const) {
      const value = text(field)
      if (value !== undefined) project[field] = value
    }
    if (unsure !== undefined && unsure.length > 0) project.unsure = unsure
    if (item.later === true) project.later = true
    out.push(project)
  }
  return out
}

function answerText(archive: MaterializeArchive, stage: string, key: string): string | undefined {
  const value = archive.answers[stage]?.[key]
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function answerStrings(archive: MaterializeArchive, stage: string, key: string): string[] {
  const value = archive.answers[stage]?.[key]
  return Array.isArray(value) ? value.filter((one): one is string => typeof one === 'string' && one.trim() !== '') : []
}

/** 一句一句的原话,带出处。 */
export interface Clause {
  text: string
  from: 'details' | 'status' | 'next_step' | 'vision' | 'unsure' | 'one_liner' | 'deadline' | 'habits.other' | 'habits.music' | 'habits.rhythm' | 'wrapup.first_item' | 'wrapup.unsure'
}

function splitClauses(text: string, from: Clause['from']): Clause[] {
  return text.split(/[;;\uFF1B]\s*|。\s*/).map(part => part.trim()).filter(part => part !== '').map(part => ({ text: part, from }))
}

/**
 * 落地要读的全部原话(给规则表与模型共用)。**这就是「同一份存档」的判据**:它不变,抽出来的卡就不变。
 */
export function archiveClauses(archive: MaterializeArchive): { project?: ArchivedProject, clauses: Clause[] } {
  const project = archivedProjects(archive).find(one => one.later !== true)
  const clauses: Clause[] = []
  if (project !== undefined) {
    if (project.one_liner !== undefined) clauses.push({ text: project.one_liner, from: 'one_liner' })
    if (project.status !== undefined) clauses.push(...splitClauses(project.status, 'status'))
    if (project.details !== undefined) clauses.push(...splitClauses(project.details, 'details'))
    if (project.vision !== undefined) clauses.push({ text: project.vision, from: 'vision' })
    if (project.next_step !== undefined) clauses.push(...splitClauses(project.next_step, 'next_step'))
    if (project.deadline !== undefined) clauses.push({ text: project.deadline, from: 'deadline' })
    for (const item of project.unsure ?? []) clauses.push({ text: item, from: 'unsure' })
  }
  const other = answerText(archive, 'habits', 'other')
  if (other !== undefined) clauses.push(...splitClauses(other, 'habits.other'))
  const first = answerText(archive, 'wrapup', 'first_item')
  if (first !== undefined) clauses.push({ text: first, from: 'wrapup.first_item' })
  for (const item of answerStrings(archive, 'wrapup', 'unsure')) clauses.push({ text: item, from: 'wrapup.unsure' })
  return { ...(project === undefined ? {} : { project }), clauses }
}

/** 存档里和落地有关的那一份的指纹(抽卡缓存、计划 id 都认它)。 */
export function archiveHash(archive: MaterializeArchive): string {
  const { project, clauses } = archiveClauses(archive)
  return contentHash({
    project: project?.name,
    path: project?.path,
    clauses: clauses.map(one => `${one.from}|${one.text}`),
    habits: archive.answers.habits ?? {},
    wrapup: archive.answers.wrapup ?? {},
  })
}

// ———————————————————————————— 规则表(确定性兜底) ————————————————————————————

/**
 * 一个主题 = 一张卡。**认的是事,不是字**:同一件事在细节、拿不准、下一步里各说了一遍,只出一张,出处攒在一起。
 *
 * 这张表是照维护者 09-24 那一通电话的说法写的(第三节对照表),也照顾到常见的近义说法;
 * 认不出来的交给模型那一份(见 {@link mergeExtractions})—— 规则是兜底与「同一份存档不变」的保证,不是全部。
 */
interface TopicRule {
  id: string
  /** 这一句说的是这件事吗。 */
  match: (text: string) => boolean
  card: (ctx: TopicContext, clause: Clause) => Omit<ExtractedCard, 'quote' | 'topic'>
}

interface TopicContext {
  today: string
  /** 他在参赛(截止日、细节里提到比赛)。 */
  contest: boolean
  /** 第一件那句话。 */
  firstItem?: string
}

const has = (text: string, ...patterns: RegExp[]): boolean => patterns.every(pattern => pattern.test(text))

/** 一句里点名的 Agent(Codex 在跑 → codex)。 */
function agentNamed(text: string): CardOwner | undefined {
  if (/codex/i.test(text)) return 'codex'
  if (/claude|cloud|克劳德/i.test(text)) return 'claude'
  if (/kimi/i.test(text)) return 'kimi'
  return undefined
}

const TOPICS: readonly TopicRule[] = [
  {
    id: 'web',
    match: text => has(text, /网页|网站|官网|落地页/, /架构|主件|在跑|在做|快弄完|搭/),
    card: (ctx, clause) => ({
      title: ctx.contest ? '参赛网页架构收尾' : '网页架构收尾',
      owner: agentNamed(clause.text) ?? agentNamed(ctx.firstItem ?? '') ?? 'codex',
      status: /在跑|在做|快弄完|基本/.test(clause.text) ? 'doing' : 'todo',
      group: '参赛材料',
      note: '架构基本快弄完,把剩下的补完',
      ...(ctx.firstItem !== undefined && /网页/.test(ctx.firstItem) ? { first: true } : {}),
    }),
  },
  {
    id: 'video',
    match: text => /视频/.test(text) && /别人|他人|接手|外包/.test(text),
    card: ctx => ({ title: ctx.contest ? '参赛视频' : '视频', owner: 'other', owner_note: '接手做', status: 'todo', group: '参赛材料', note: '你不用管,别人接手' }),
  },
  {
    id: 'copy',
    match: text => /文案/.test(text) && /同事|伙伴|同学/.test(text),
    card: (ctx, clause) => {
      const back = /(\d{1,2})\s*[/月]\s*(\d{1,2})\s*(?:号|日)?\s*回来|(\d{1,2}\/\d{1,2})\s*回来/.exec(clause.text)
      const date = back === null ? undefined : dateIn(back[0], ctx.today)
      return {
        title: ctx.contest ? '参赛文案' : '文案',
        owner: 'colleague',
        owner_note: date === undefined ? '写' : `${shortDate(date)} 回来写`,
        status: 'todo',
        group: '参赛材料',
      }
    },
  },
  {
    id: 'handover',
    match: text => /(桌上|桌面|交给他|给他)/.test(text) && /放|整理|交/.test(text) && /\d{1,2}\s*号|\d{1,2}\/\d{1,2}/.test(text),
    card: (ctx, clause) => {
      const part = /[^,,]*(?:\d{1,2}\s*号|\d{1,2}\/\d{1,2})[^,,]*(?:桌上|桌面|给他)[^,,]*/.exec(clause.text)?.[0] ?? clause.text
      const date = dateIn(part, ctx.today)
      return {
        title: `${date === undefined ? '' : `${shortDate(date)} `}把材料整理好放同事桌上`,
        owner: 'me',
        status: 'todo',
        ...(date === undefined ? {} : { due: date }),
        group: '参赛材料',
      }
    },
  },
  {
    id: 'remote',
    match: text => /远程(派单|指挥|下发|派活|汇报)|派单.*汇报|进度评估/.test(text),
    card: () => ({
      title: '手机远程派单 + 汇报 / 进度评估准确',
      owner: 'claude',
      status: 'todo',
      priority: 'high',
      group: '核心能力与打磨',
      note: '最高优先:通过事务官下发、通过事务官验收',
    }),
  },
  {
    id: 'core-flow',
    match: text => /核心(体验)?流程/.test(text),
    card: () => ({
      title: '定核心体验流程(四段)',
      owner: 'me',
      status: 'confirm',
      group: '核心能力与打磨',
      note: '早报播报 → 会议录音转待办 → 跨系统调文件 → 跨系统指挥调度 Agent;哪段没跑通你下去再确认',
    }),
  },
  {
    id: 'self-iter',
    match: text => /自我迭代/.test(text),
    card: () => ({
      title: '验证自我迭代能力',
      owner: 'claude',
      status: 'todo',
      group: '核心能力与打磨',
      note: '重点验证项:同事回来会用它改页面 UI、做小工具',
    }),
  },
  {
    id: 'ops-layout',
    match: text => /(自媒体|运营).{0,6}布局|布局.{0,6}(自媒体|运营)/.test(text),
    card: () => ({
      title: '打磨自媒体布局',
      owner: 'claude',
      status: 'todo',
      group: '核心能力与打磨',
      note: '新电脑到手只差安装(几分钟);这套布局你还没打开看过',
    }),
  },
  {
    id: 'version-sync',
    match: text => /(服务器|手机).{0,16}版本|版本.{0,10}(服务器|手机)/.test(text),
    card: () => ({ title: '服务器与手机版本同步', owner: 'claude', status: 'todo', group: '核心能力与打磨', note: '比这台电脑旧不少,落后多少还没细看' }),
  },
  {
    id: 'quota-ui',
    match: text => /额度显示|会话读取/.test(text),
    card: () => ({
      title: '额度显示 / 会话读取',
      owner: 'claude',
      status: 'todo',
      priority: 'low',
      blocking: false,
      group: '核心能力与打磨',
      note: '不阻塞',
    }),
  },
]

/** 这一句不出卡:他说不做 / 没必要。 */
const NEGATIVE = /没必要|不做了|不需要|算了|不用做/
/** 这一句是照搬旧清单(「按交接里的三件」「后面接着按交接推进」)。 */
const STALE_HANDOFF = /按交接|交接里的|照交接/
/** 只是背景(行程、假期、截止日本身),不出卡。 */
const BACKGROUND = /假期|中秋|国庆|高铁|回老家|只带\s*pad|截止/i

/**
 * 规则表那一份。**确定性**:同一份存档永远出同样的卡、同样的标题、同样的顺序。
 */
export function rulesExtract(archive: MaterializeArchive, today: string): Extraction {
  const { project, clauses } = archiveClauses(archive)
  const firstItem = answerText(archive, 'wrapup', 'first_item')
  const contestText = [project?.deadline ?? '', project?.details ?? '', project?.vision ?? ''].join(' ')
  const contest = /参赛|比赛|报名|大赛|spotlight/i.test(contestText)
  const ctx: TopicContext = { today, contest, ...(firstItem === undefined ? {} : { firstItem }) }

  const byTopic = new Map<string, ExtractedCard>()
  const order: string[] = []
  const skipped: { text: string, why: string }[] = []
  for (const clause of clauses) {
    if (clause.from === 'one_liner' || clause.from === 'deadline') continue
    // 第一件那句只认「第一条」那半句,后半句「后面接着按交接推进……」是旧清单。
    const text = clause.from === 'wrapup.first_item' ? clause.text.split(/[;;]/)[0] ?? clause.text : clause.text
    if (clause.from === 'wrapup.first_item') {
      const rest = clause.text.split(/[;;]/).slice(1).join(';').trim()
      if (rest !== '' && STALE_HANDOFF.test(rest)) skipped.push({ text: rest, why: '照搬中午交接的旧清单,不另建;看板上那几条在「撤掉」里' })
    }
    if (clause.from === 'next_step' && STALE_HANDOFF.test(text)) { skipped.push({ text, why: '照搬交接的旧清单,不另建' }); continue }
    if (NEGATIVE.test(text) && !TOPICS.some(rule => rule.id === 'quota-ui' && rule.match(text))) { skipped.push({ text, why: '他说不做 / 没必要' }); continue }
    let hit = false
    for (const rule of TOPICS) {
      if (!rule.match(text)) continue
      hit = true
      const existing = byTopic.get(rule.id)
      if (existing !== undefined) {
        // 同一件事又说了一遍:出处攒进去,卡不重复。
        if (!existing.quote.includes(text)) existing.quote = clip(`${existing.quote};${text}`, 160)
        continue
      }
      byTopic.set(rule.id, { ...rule.card(ctx, { ...clause, text }), quote: clip(text, 80), topic: rule.id })
      order.push(rule.id)
    }
    if (!hit && BACKGROUND.test(text)) continue
  }
  // 按主题表的顺序排(参赛材料在前、能力与打磨在后),不按他先说哪句 —— 同一份存档永远同一个顺序。
  const rank = (topic: string | undefined): number => TOPICS.findIndex(rule => rule.id === topic)
  const cards = order.map(id => byTopic.get(id) as ExtractedCard).sort((a, b) => rank(a.topic) - rank(b.topic))
  // 第一件兜底:规则没认出「第一件」时,拿第一件那句去对标题。
  if (!cards.some(card => card.first === true) && firstItem !== undefined) {
    const best = cards.map(card => ({ card, score: titleSimilarity(card.title, firstItem) })).sort((a, b) => b.score - a.score)[0]
    if (best !== undefined && best.score > 0.2) best.card.first = true
  }

  const deadline = project?.deadline === undefined ? undefined : dateIn(project.deadline, today)
  const contestName = /([A-Za-z][\w-]{2,})\s*(?:比赛|大赛|报名)/.exec(contestText)?.[1]
  const sprint = deadline === undefined
    ? undefined
    : { name: `${contest ? `${contestName ?? ''} 参赛`.trim() : '冲刺'} · ${monthDay(deadline)}`, deadline }

  const background = backgroundOf(project, today)
  const projects = extraProjects(archive)
  const keywords: Record<string, string[]> = {}
  if (project !== undefined) {
    const words = mainKeywords(project, contestName)
    if (words.length > 0) keywords[project.name] = words
  }
  for (const extra of projects) {
    const words = extraKeywords(archive, extra, contestName)
    if (words.length > 0) keywords[extra.name] = words
  }
  return {
    source: 'rules',
    ...(project === undefined ? {} : { project: project.name }),
    ...(contestName === undefined || !contest ? {} : { contest: contestName }),
    ...(sprint === undefined ? {} : { sprint }),
    ...(background === undefined ? {} : { background }),
    cards,
    projects,
    keywords,
    skipped,
  }
}

function clip(text: string, limit: number): string {
  const chars = Array.from(text)
  return chars.length <= limit ? text : `${chars.slice(0, limit - 1).join('')}…`
}

/** 项目背景一句:行程与假期(「9/29 起远程,只带 Pad;中秋 9/25–27,国庆 10/1 起」)。 */
function backgroundOf(project: ArchivedProject | undefined, today: string): string | undefined {
  if (project?.details === undefined) return undefined
  const parts: string[] = []
  const trip = splitClauses(project.details, 'details').find(one => /高铁|回老家|只带/.test(one.text))
  if (trip !== undefined) {
    const date = dateIn(trip.text, today)
    parts.push(`${date === undefined ? '' : `${shortDate(date)} 起`}远程${/pad/i.test(trip.text) ? '(只带 Pad)' : ''}`)
  }
  const holiday = splitClauses(project.details, 'details').find(one => /假期|中秋|国庆/.test(one.text))
  if (holiday !== undefined) parts.push(holiday.text.replace(/^假期[::]\s*/, ''))
  return parts.length === 0 ? undefined : parts.join(';')
}

/** 「Lapis 项目:仓库名还叫 Echo,产品名已改成 Lapis;Kimi 现在专门负责它」→ 一个项目。 */
export function extraProjects(archive: MaterializeArchive): ExtraProject[] {
  const other = answerText(archive, 'habits', 'other') ?? ''
  const out: ExtraProject[] = []
  for (const m of other.matchAll(/([A-Za-z][\w-]*)\s*项目[::]?\s*仓库名?(?:还|现在)?叫\s*([A-Za-z][\w.-]*)/g)) {
    const name = m[1] as string
    const repo = m[2] as string
    // 同一段里「X 现在专门负责它」。
    const tail = other.slice(m.index ?? 0, (m.index ?? 0) + 120)
    const owner = /(Kimi|Claude|Codex)[^;;。]{0,10}负责/i.exec(tail)?.[1]
    const contest = /参(加|赛)|比赛/.test(tail)
    const ownerKey = owner === undefined ? undefined : owner.toLowerCase() as CardOwner
    out.push({
      name,
      repo,
      ...(ownerKey === undefined ? {} : { owner: ownerKey }),
      note: [ownerKey === undefined ? '' : `${OWNER_LABELS[ownerKey]} 负责`, contest ? '也参赛' : '', `仓库名 ${repo}`].filter(one => one !== '').join(';'),
    })
  }
  return out
}

/** 主项目的资讯关键词:只取他话里出现过的那几样。 */
function mainKeywords(project: ArchivedProject, contestName: string | undefined): string[] {
  const text = [project.one_liner, project.details, project.vision, project.status, project.deadline].filter(Boolean).join(' ')
  const words: string[] = []
  if (contestName !== undefined) words.push(`${contestName} 比赛`)
  if (/事务官/.test(text)) words.push('AI 事务官')
  if (/调度\s*agent|agent\s*调度|指挥调度|调度/i.test(text)) words.push('Agent 调度')
  if (/远程(派单|指挥|下发)/.test(text)) words.push('远程派单')
  if (/会议录音/.test(text)) words.push('会议录音转待办')
  return [...new Set(words)]
}

function extraKeywords(archive: MaterializeArchive, extra: ExtraProject, contestName: string | undefined): string[] {
  const other = answerText(archive, 'habits', 'other') ?? ''
  const words: string[] = []
  if (contestName !== undefined && new RegExp(`${extra.name}[^;;。]*`, 'i').test(other) && /参(加|赛)|比赛/.test(other)) words.push(`${contestName} 比赛`)
  return words
}

// ———————————————————————————— 模型那一份的校验与合并 ————————————————————————————

const CARD_STATUSES: readonly CardStatus[] = ['todo', 'doing', 'confirm']
const PRIORITIES: readonly TaskPriority[] = ['high', 'mid', 'low']

/**
 * 模型回的 JSON → 卡片。**严格**:形状不对就整份不要(回 undefined + 原因),不挑着用 ——
 * 一半对一半错的卡片比没有更糟(他会以为全是照他说的)。
 */
export function parseModelExtraction(raw: unknown, today: string): { ok: true, value: Omit<Extraction, 'source' | 'skipped'> } | { ok: false, why: string } {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, why: '回的不是一个 JSON 对象' }
  const body = raw as Record<string, unknown>
  if (!Array.isArray(body.cards)) return { ok: false, why: 'cards 不是数组' }
  if (body.cards.length === 0) return { ok: false, why: '一张卡都没有' }
  if (body.cards.length > 16) return { ok: false, why: `卡太多(${body.cards.length} 张)` }
  const cards: ExtractedCard[] = []
  for (const [index, entry] of body.cards.entries()) {
    if (entry === null || typeof entry !== 'object') return { ok: false, why: `第 ${index + 1} 张不是对象` }
    const item = entry as Record<string, unknown>
    const title = typeof item.title === 'string' ? item.title.trim() : ''
    if (title === '' || Array.from(title).length > 40) return { ok: false, why: `第 ${index + 1} 张标题不对` }
    const owner = typeof item.owner === 'string' ? item.owner.trim().toLowerCase() : ''
    if (!(CARD_OWNERS as readonly string[]).includes(owner)) return { ok: false, why: `第 ${index + 1} 张负责人「${String(item.owner)}」不认得` }
    const status = typeof item.status === 'string' ? item.status : 'todo'
    if (!(CARD_STATUSES as readonly string[]).includes(status)) return { ok: false, why: `第 ${index + 1} 张状态「${status}」不认得` }
    const due = typeof item.due === 'string' && item.due.trim() !== '' ? item.due.trim() : undefined
    if (due !== undefined && (!/^\d{4}-\d{2}-\d{2}$/.test(due) || Number.isNaN(Date.parse(`${due}T00:00:00Z`)))) return { ok: false, why: `第 ${index + 1} 张日期「${due}」不对` }
    const priority = typeof item.priority === 'string' && (PRIORITIES as readonly string[]).includes(item.priority) ? item.priority as TaskPriority : undefined
    const quote = typeof item.quote === 'string' ? item.quote.trim() : ''
    if (quote === '') return { ok: false, why: `第 ${index + 1} 张没写出自哪句原话` }
    const text = (key: string, limit: number): string | undefined => typeof item[key] === 'string' && (item[key] as string).trim() !== '' ? clip((item[key] as string).trim(), limit) : undefined
    const ownerNote = text('owner_note', 30)
    const group = text('group', 16)
    const note = text('note', 60)
    cards.push({
      title,
      owner: owner as CardOwner,
      status: status as CardStatus,
      quote: clip(quote, 80),
      ...(ownerNote === undefined ? {} : { owner_note: ownerNote }),
      ...(due === undefined ? {} : { due }),
      ...(priority === undefined ? {} : { priority }),
      ...(item.blocking === false ? { blocking: false } : {}),
      ...(group === undefined ? {} : { group }),
      ...(note === undefined ? {} : { note }),
      ...(item.first === true ? { first: true } : {}),
    })
  }
  if (cards.filter(card => card.first === true).length > 1) return { ok: false, why: '标了不止一张「第一件」' }
  let sprint: Extraction['sprint']
  if (body.sprint !== null && body.sprint !== undefined) {
    const raw = body.sprint as Record<string, unknown>
    const name = typeof raw.name === 'string' ? raw.name.trim() : ''
    const deadline = typeof raw.deadline === 'string' ? raw.deadline.trim() : ''
    if (name !== '' && /^\d{4}-\d{2}-\d{2}$/.test(deadline)) sprint = { name: clip(name, 30), deadline }
  }
  const projects: ExtraProject[] = []
  if (Array.isArray(body.projects)) {
    for (const entry of body.projects) {
      const item = (entry ?? {}) as Record<string, unknown>
      const name = typeof item.name === 'string' ? item.name.trim() : ''
      if (name === '' || name.length > 40) continue
      const owner = typeof item.owner === 'string' && (CARD_OWNERS as readonly string[]).includes(item.owner.toLowerCase()) ? item.owner.toLowerCase() as CardOwner : undefined
      const repo = typeof item.repo === 'string' && /^[\w.-]{1,60}$/.test(item.repo.trim()) ? item.repo.trim() : undefined
      const note = typeof item.note === 'string' && item.note.trim() !== '' ? clip(item.note.trim(), 60) : undefined
      projects.push({ name, ...(repo === undefined ? {} : { repo }), ...(owner === undefined ? {} : { owner }), ...(note === undefined ? {} : { note }) })
    }
  }
  const keywords: Record<string, string[]> = {}
  if (body.keywords !== null && typeof body.keywords === 'object' && !Array.isArray(body.keywords)) {
    for (const [name, list] of Object.entries(body.keywords as Record<string, unknown>)) {
      if (!Array.isArray(list)) continue
      const words = list.filter((one): one is string => typeof one === 'string' && one.trim() !== '' && one.length <= 20).map(one => one.trim()).slice(0, 6)
      if (words.length > 0) keywords[name] = words
    }
  }
  const background = typeof body.background === 'string' && body.background.trim() !== '' ? clip(body.background.trim(), 80) : undefined
  void today
  return { ok: true, value: { cards, projects, keywords, ...(sprint === undefined ? {} : { sprint }), ...(background === undefined ? {} : { background }) } }
}

/**
 * 规则那一份 + 模型那一份 → 一份。
 *
 * **规则认得的主题以规则为准**:模型的卡要是说的是同一件事(规则表那条认得它的标题或出处,或者标题很像),
 * 就并进规则那张、不另出一张 —— 同一份存档重跑,规则那几张一个字不变,「按内容去重」才站得住。
 * 模型多认出来的(规则表没有的主题)排在后面;冲刺、背景、关键词以规则为准,规则没有才用模型的。
 */
export function mergeExtractions(
  rules: Extraction,
  model: Omit<Extraction, 'source' | 'skipped'> | undefined,
  modelNote?: string,
  firstItem?: string,
  clauses: readonly Clause[] = [],
): Extraction {
  if (model === undefined) return { ...rules, ...(modelNote === undefined ? {} : { model_note: modelNote }) }
  const cards = rules.cards.map(card => ({ ...card }))
  /** 模型那张卡出自他哪一段话(按原话摘的 quote 去对)。 */
  const fromOf = (quote: string): Clause['from'] | undefined => {
    const hit = clauses.find(one => one.text.includes(quote) || quote.includes(one.text))
      ?? clauses.map(one => ({ one, score: titleSimilarity(one.text, quote) })).sort((a, b) => b.score - a.score).find(pick => pick.score >= 0.5)?.one
    return hit?.from
  }
  let extras = 0
  for (const extra of model.cards) {
    const topic = TOPICS.find(rule => rule.match(extra.title) || rule.match(extra.quote))
    // 同一句原话规则那一份已经出过卡了(模型常把一句拆成两张:「手机端远程派单」+「远程汇报与进度评估要准」)——并进去,不另出。
    const said = normalizeTitle(extra.quote)
    const sameClause = said.length >= 6 && cards.some(card => normalizeTitle(card.quote).includes(said) || said.includes(normalizeTitle(card.quote)))
    const same = sameClause || cards.find(card => (topic !== undefined && card.topic === topic.id) || titleSimilarity(card.title, extra.title) >= SAME_TITLE) !== undefined
    if (same) continue
    // 规则认得这个主题、但规则那一份里没有它(他没这么说过)—— 模型多半是在编,不要。
    if (topic !== undefined) continue
    // 规则那一份明说不出卡的(他说没必要、照搬旧清单的),模型出了也不要。
    if (rules.skipped.some(one => one.text.includes(extra.quote) || extra.quote.includes(one.text) || titleSimilarity(one.text, extra.quote) >= 0.6)) continue
    /**
     * 模型多认出来的,**只收「要做的事」**(2026-09-24 晚 scratch 真跑:模型把「Claude 在做产品进一步研发」「电脑上派活各家都能派」
     * 「想按两个项目做定向搜索」都出成了卡 —— 前两句是现状、后一句是偏好,落到看板上就是一堆不用做的卡):
     * 已经在做的(doing)不收;出自「其它」那一段(工作习惯、偏好)的不收;最多补三张。
     */
    if (extra.status === 'doing') continue
    const from = fromOf(extra.quote)
    if (from === 'habits.other' || from === 'habits.music' || from === 'habits.rhythm') continue
    if (extras >= 3) continue
    extras += 1
    const card: ExtractedCard = { ...extra }
    // 「第一件」只认一张:规则那一份已经认出来了,模型的不算。
    if (card.first === true && cards.some(one => one.first === true)) delete card.first
    cards.push(card)
  }
  // 「第一件」:规则那一份没认出来(说法规则表不认得),拿他点头的那句去对合并后的卡。
  if (!cards.some(card => card.first === true) && firstItem !== undefined) {
    const head = firstItem.split(/[;;]/)[0] ?? firstItem
    const best = cards.map(card => ({ card, score: titleSimilarity(card.title, head) })).sort((a, b) => b.score - a.score)[0]
    if (best !== undefined && best.score > 0.2) best.card.first = true
  }
  const projects = [...rules.projects]
  for (const extra of model.projects) {
    // 主项目本身不是「另一个项目」(模型常把它也列进来)。
    if (rules.project !== undefined && extra.name.toLowerCase() === rules.project.toLowerCase()) continue
    if (!projects.some(one => one.name.toLowerCase() === extra.name.toLowerCase())) projects.push(extra)
  }
  const keywords: Record<string, string[]> = { ...model.keywords, ...rules.keywords }
  return {
    source: 'model+rules',
    ...(rules.project === undefined ? {} : { project: rules.project }),
    ...(rules.contest === undefined ? {} : { contest: rules.contest }),
    ...(rules.sprint ?? model.sprint) === undefined ? {} : { sprint: (rules.sprint ?? model.sprint) as NonNullable<Extraction['sprint']> },
    ...((rules.background ?? model.background) === undefined ? {} : { background: (rules.background ?? model.background) as string }),
    cards,
    projects,
    keywords,
    skipped: rules.skipped,
    ...(modelNote === undefined ? {} : { model_note: modelNote }),
  }
}

// ———————————————————————————— 计划 ————————————————————————————

/** 一行真去做的时候要的数据(不进 /state,服务端自己留着)。 */
export type MaterializeRowData =
  | { kind: 'project', id?: string, name: string, path?: string, owner?: CardOwner, ddl?: { date: string, title: string }, status?: string, background?: string, main: boolean, memory?: string }
  | { kind: 'sprint', name: string, deadline: string, project: string, modules: string[] }
  | { kind: 'task', card: ExtractedCard, project: string }
  | { kind: 'routine', which: 'morning' | 'evening', at: string }
  | { kind: 'quiet', from: string, to: string }
  | { kind: 'feed', interests: { project: string, name: string, keywords: string[] }[], podcast: boolean }
  | { kind: 'slot', apps: string[] }
  | { kind: 'quota' }
  | { kind: 'caps' }
  | { kind: 'memories' }
  | { kind: 'division', text: string, said: string }
  | { kind: 'cancel', task_id: string, from: TaskStatus }
  | {
    kind: 'dispatch'
    topic_key: string
    owner: CardOwner
    /** 交给事务官的那一句(现有链路:开一条事务官会话,它照「派活给别家Agent」办)。 */
    text: string
    /** 直接说给那一家听的那一句(卡 F 的 `dispatchItem`:新开一条对话送进去)。 */
    agent_text: string
    /** 他点头的那句原话(「第一条:让 Codex 把参赛网页的架构剩下的补完」)—— 这张卡是「他交给事务官的」,手机对话里显示的就是这句。 */
    said?: string
    thread?: { id: string, title: string }
  }

/** 计划里的一行 = 界面上那一行(protocol.ts `MaterializeRowView`)+ 真做时要的数据(不进 /state)。 */
export interface MaterializeRow extends MaterializeRowView {
  data: MaterializeRowData
}

export interface MaterializePlan {
  version: 1
  id: string
  created_at: string
  input_hash: string
  source: Extraction['source']
  model_note?: string
  /** 电话里那一句。 */
  line: string
  counts: { projects: number, tasks: number, cancel: number }
  groups: { id: MaterializeGroup, title: string }[]
  rows: MaterializeRow[]
  skipped: { text: string, why: string }[]
}

/** 看板现在的样子(落地排计划要对照的)。 */
export interface BoardSnapshot {
  tasks: readonly TaskView[]
  sprints: readonly { id: string, project_id: string, name: string }[]
  modules: readonly { id: string, sprint_id: string, name: string }[]
}

/** 项目区现在的样子。 */
export interface ProjectsSnapshot {
  /** 已经落盘的(projects.json)。 */
  stored: readonly { id: string, name: string, repoPath?: string, ddl?: { date: string, title: string }, /** 项目区那一行状态(人确认过的那条)。 */ status?: string }[]
  /** 扫到的仓库(找「Echo」那种仓库名用)。 */
  repos: readonly { id: string, name: string, path?: string }[]
}

export interface PlanContext {
  now: Date
  today: string
  archive: MaterializeArchive
  extraction: Extraction
  board: BoardSnapshot
  projects: ProjectsSnapshot
  routines?: { morning?: { at?: string }, evening?: { at?: string } }
  quiet?: { from: string, to: string }
  feed?: { podcast: boolean, interests: readonly { project_id: string, project_name: string, keywords: readonly string[] }[] }
  apps?: { enabled: readonly string[] }
  /** 卡 C 那边的窗口槽预览(有就用;没有这一行写占位)。 */
  slotPreview?: { results: readonly { app: string, label: string, state: string, note?: string }[] }
  /** 卡 C 那边的额度状态(`/state.quota_connect`,有就用;`line` 是它拼好的那一句)。 */
  quotaStatus?: { providers: readonly { agent: string, label: string, state: string, note?: string }[], line?: string }
  /** 各家客户端接上没有(clientScan 那一份,卡 C 的接口没好时拿它拼额度那一行)。 */
  clients?: Readonly<Record<string, { installed?: boolean, connected?: boolean }>>
  /** 授权表里「读各家客户端文件」现在是哪一档。 */
  readClientFiles?: string
  /** 项目仓库现在的版本(判「交接里的 0.2.80 过时了」)。 */
  currentVersion?: string
  /** Codex 里按名字找到的那条会话(「制作参赛网页」)。 */
  codexThread?: { id: string, title: string }
  /** 各家能做什么(卡 O 的体检那一句,`/state.agent_caps.line`)。有就在「桌面」那一组多一行,只读。 */
  agentCaps?: { line: string }
  /** 规矩表里已经有「派活默认分工」那一条了没有(卡 O;有就只记一条依据,不另起一条)。 */
  rules?: { hasDivision: boolean }
  /** 哪几样这台工作台没接(没接就占位,不装成能做)。 */
  wired: { tasks: boolean, projects: boolean, routines: boolean, quiet: boolean, feed: boolean, slot: boolean, quota: boolean, memories: boolean, dispatch: boolean, rules?: boolean }
}

export const GROUP_TITLES: Record<MaterializeGroup, string> = {
  projects: '项目',
  sprint: '冲刺',
  daily: '每天',
  desk: '桌面',
  rules: '派活分工',
  memory: '记忆',
  cleanup: '撤掉(改成「取消」,不删)',
  first: '第一件',
}

/** 引导里(②′ 方案)建的事项:desc 的开头是这一句(onboarding.ts writePlan)。 */
export const PLAN_TASK_DESC = /^引导 ②′ 排的方案「([^」]+)」/
/**
 * 老纪要卡:标题「和事务官通了个电话(N 秒)」。2026-10-22 起通话不再建卡(落成通话记录),
 * 这一条只认存量。
 *
 * **两种写法都认**(2026-10-02):时长没记下来时那种卡的标题是「和事务官通了**一次**电话」——
 * 以前这条正则漏了它,于是那种卡既没被清理掉、也没被来电那一层拦住(卡「电话里像个活人」第 4 条)。
 */
export const CALL_RECORD_TITLE = /^和事务官通了(?:个|一次)电话/

/**
 * 一张卡是不是通话纪要。**2026-10-13 起标题换成了「聊了什么」**(维护者:「已完成里面不要再写
 * 什么和事务官通了个电话了」),所以光看标题认不出新卡了 —— 先认 `origin`(新卡一律带),
 * 认不出再退回老标题那条正则(这个字段出现之前落的老卡)。
 */
export function isCallRecordCard(task: Pick<TaskView, 'origin' | 'title' | 'desc' | 'source'>): boolean {
  return taskOriginOf(task) === 'call' || CALL_RECORD_TITLE.test(task.title.trim())
}

/** 维护者的早报 / 播客「8 点半准备好」,下班例程与免打扰从他的话里取。 */
export function timesOf(archive: MaterializeArchive): { morning?: string, evening?: string, quietFrom?: string, quietTo?: string } {
  const rhythm = answerText(archive, 'habits', 'rhythm') ?? ''
  const evening = answerText(archive, 'wrapup', 'evening_routine')
  const out: { morning?: string, evening?: string, quietFrom?: string, quietTo?: string } = {}
  const morning = /早上\s*(\d{1,2})\s*点\s*(半|(\d{1,2})\s*分?)?/.exec(rhythm)
  if (morning !== null) out.morning = hhmm(Number(morning[1]), morning[2] === '半' ? 30 : Number(morning[3] ?? 0))
  if (evening !== undefined && /^\d{2}:\d{2}$/.test(evening)) out.evening = evening
  const quiet = /晚上\s*(\d{1,2})\s*点\s*(半)?\s*(?:以后|之后|后)/.exec(rhythm)
  if (quiet !== null) {
    let hour = Number(quiet[1])
    if (hour < 12) hour += 12
    out.quietFrom = hhmm(hour, quiet[2] === '半' ? 30 : 0)
    // 免打扰到早报准备好为止(他说早报 8 点半准备好、他自己点开)。
    out.quietTo = out.morning ?? '08:00'
  }
  return out
}

function hhmm(hour: number, minute: number): string {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

/** 「21:00」→「晚上 9 点」,「08:30」→「早上 8 点半」。 */
export function spokenTime(time: string): string {
  const [h, m] = time.split(':').map(Number) as [number, number]
  const part = h < 12 ? '早上' : h < 18 ? '下午' : '晚上'
  const hour = h <= 12 ? h : h - 12
  return `${part} ${hour} 点${m === 30 ? '半' : m === 0 ? '' : ` ${m} 分`}`
}

function projectIdFor(ctx: PlanContext, name: string, path: string | undefined): string | undefined {
  const byPath = path === undefined ? undefined : ctx.projects.stored.find(one => one.repoPath === path)
  if (byPath !== undefined) return byPath.id
  const byName = ctx.projects.stored.find(one => one.name.toLowerCase() === name.toLowerCase())
  if (byName !== undefined) return byName.id
  const repo = path === undefined ? undefined : ctx.projects.repos.find(one => one.path === path)
  return repo?.id
}

/** 维护者口中的项目名 → 显示名(「desktop-workbench」他叫「工作台」)。 */
function displayNameOf(archive: MaterializeArchive, project: ArchivedProject): string {
  // 引导里他报的是「工作台」,录下来的名字是仓库名;显示名取他的叫法(一句话里的自称优先)。
  const said = /(工作台)/.exec(`${answerText(archive, 'habits', 'self_intro') ?? ''} ${answerText(archive, 'habits', 'other') ?? ''}`)?.[1]
  if (said !== undefined && /workbench/i.test(project.name)) return said
  return project.name
}

/** 看板上已经有的一张同样的卡(按内容:标题像、没取消)。 */
function existingCard(ctx: PlanContext, title: string): TaskView | undefined {
  return ctx.board.tasks.find(task => task.status !== 'canceled' && !isCallRecordCard(task) && titleSimilarity(task.title, title) >= SAME_TITLE)
}

/**
 * 看板上要撤掉的几条(改状态为「取消」,**不删**)。
 *
 * 1. **引导 ②′ 照搬交接旧清单建的**:同一份方案里只要有一条提到的版本比现在旧(「查 0.2.80…」,现在已经 0.2.83),
 *    那份方案就是照中午那份交接念的 —— 整份都列出来(每条写清为什么);另外同一件事建了两条的,后一条标「重复」。
 * 2. **测试留下的通话记录**:标题「和事务官通了个电话」、在引导做完之前、里面没有转写或只有「测试」那几句。
 *
 * 只列,不替他撤:预览里默认勾着,他点「就这样」才改。
 */
export function cancelCandidates(ctx: Pick<PlanContext, 'board' | 'archive' | 'currentVersion'>): { task: TaskView, why: string }[] {
  const out: { task: TaskView, why: string }[] = []
  const open = (task: TaskView): boolean => task.status === 'todo' || task.status === 'backlog'
  const planTasks = ctx.board.tasks.filter(task => open(task) && PLAN_TASK_DESC.test(task.desc ?? ''))
  const byPlan = new Map<string, TaskView[]>()
  for (const task of planTasks) {
    const project = PLAN_TASK_DESC.exec(task.desc ?? '')?.[1] ?? ''
    byPlan.set(project, [...(byPlan.get(project) ?? []), task])
  }
  for (const [, group] of byPlan) {
    const stale = group.map(task => ({ task, old: staleVersionOf(task.title, ctx.currentVersion) }))
    const anyStale = stale.find(one => one.old !== undefined)
    const seen: TaskView[] = []
    for (const { task, old } of stale) {
      const twin = seen.find(prev => titleSimilarity(prev.title, task.title) >= SAME_TITLE)
      seen.push(task)
      if (old !== undefined) out.push({ task, why: `照搬中午交接的旧清单:提到 ${old},现在已经 ${ctx.currentVersion as string}` })
      else if (twin !== undefined) out.push({ task, why: `和「${twin.title}」重复,也是照搬交接旧清单建的` })
      else if (anyStale !== undefined) out.push({ task, why: `和两条 ${anyStale.old as string} 一起照搬的中午交接旧清单` })
    }
  }
  const finishedAt = ctx.archive.stage === 'done' ? ctx.archive.updatedAt : undefined
  for (const task of ctx.board.tasks) {
    if (!isCallRecordCard(task) || task.status === 'canceled') continue
    if (finishedAt !== undefined && task.created_at > finishedAt) continue
    const desc = task.desc ?? ''
    const said = desc.split('\n').filter(line => line.startsWith('我:')).map(line => line.slice(2))
    const test = /没有留下转写/.test(desc) || (said.length > 0 && said.every(line => /测试/.test(line)))
    if (test) out.push({ task, why: /没有留下转写/.test(desc) ? '测试时留下的通话记录(没有转写)' : '测试时留下的通话记录(只有「这是一段测试声音」)' })
  }
  return out
}

/**
 * 项目区那一行状态(设计对照表:「冲刺截止 10-04;项目状态写倒计时」)。
 * 冲刺那半句 + 他说的现状的**第一句**(「参赛网页架构基本快弄完(Codex 在跑)」);都没有就不写。
 * 「还剩几天」不写进来:项目区 DDL 那一行每天现算,写死在状态里第二天就是错的。
 */
export function projectStatusText(main: ArchivedProject, extraction: Pick<Extraction, 'sprint' | 'contest'>): string | undefined {
  const deadline = extraction.sprint?.deadline
  const sprint = deadline === undefined ? '' : `冲刺${extraction.contest === undefined ? '' : ` ${extraction.contest}`},${shortDate(deadline)} 截止`
  const said = main.status?.split(/[;;\uFF1B。]/)[0]?.trim() ?? ''
  const text = [sprint, said].filter(one => one !== '').join(';')
  return text === '' ? undefined : text
}

/**
 * 排计划。**纯函数**:同样的输入永远排出同样的计划(同样的 id)。
 */
export function buildPlan(ctx: PlanContext): MaterializePlan {
  const rows: MaterializeRow[] = []
  const archive = ctx.archive
  const extraction = ctx.extraction
  const main = archivedProjects(archive).find(one => one.later !== true)

  // ① 项目
  if (main !== undefined) {
    const name = displayNameOf(archive, main)
    const id = projectIdFor(ctx, main.name, main.path)
    const stored = id === undefined ? undefined : ctx.projects.stored.find(one => one.id === id)
    const deadline = extraction.sprint?.deadline
    const ddl = deadline === undefined ? undefined : { date: deadline, title: extraction.contest === undefined ? '冲刺截止' : `${extraction.contest} 报名截止` }
    // 项目区那一行状态:**只在还没写过时**照他的话写一句(他写过的、日结确认过的不覆盖);倒计时由 DDL 那一行现算,不写死在状态里。
    const status = stored?.status !== undefined && stored.status.trim() !== '' ? undefined : projectStatusText(main, extraction)
    const same = stored !== undefined && stored.name === name && (ddl === undefined || (stored.ddl?.date === ddl.date)) && status === undefined
    rows.push({
      key: `project:${main.path ?? main.name}`,
      kind: 'project',
      group: 'projects',
      title: `${name}${name !== main.name ? `(${main.name})` : ''}`,
      detail: [
        ddl === undefined ? '' : `${ddl.title} ${shortDate(ddl.date)},倒计时`,
        extraction.background ?? '',
        status === undefined ? '' : `状态写「${status}」`,
      ].filter(one => one !== '').join(';'),
      checked: !same,
      ...(same ? { done: true } : {}),
      ...(ctx.wired.projects ? {} : { placeholder: '这台工作台没接项目区' }),
      data: {
        kind: 'project',
        ...(id === undefined ? {} : { id }),
        name,
        ...(main.path === undefined ? {} : { path: main.path }),
        ...(ddl === undefined ? {} : { ddl }),
        ...(status === undefined ? {} : { status }),
        ...(extraction.background === undefined ? {} : { background: extraction.background }),
        main: true,
        // 引导里录的名字 = 记忆里项目文件的名字(docs/记忆/项目/<名>.md),背景写进那一份。
        memory: main.name,
      },
    })
  }
  for (const extra of extraction.projects) {
    const repo = extra.repo === undefined ? undefined : ctx.projects.repos.find(one => one.name.toLowerCase() === (extra.repo as string).toLowerCase() || (one.path ?? '').toLowerCase().endsWith(`/${(extra.repo as string).toLowerCase()}`))
    const path = repo?.path
    const id = projectIdFor(ctx, extra.name, path)
    const stored = id === undefined ? undefined : ctx.projects.stored.find(one => one.id === id)
    const same = stored !== undefined && stored.name === extra.name
    rows.push({
      key: `project:${path ?? extra.name}`,
      kind: 'project',
      group: 'projects',
      title: `${extra.name}${extra.repo === undefined ? '' : `(仓库 ${extra.repo})`}`,
      detail: extra.note ?? '',
      checked: !same,
      ...(same ? { done: true } : {}),
      ...(ctx.wired.projects ? {} : { placeholder: '这台工作台没接项目区' }),
      ...(path === undefined && extra.repo !== undefined ? { placeholder: `扫描根里没找到叫 ${extra.repo} 的仓库,先只记名字` } : {}),
      ...(extra.owner === undefined ? {} : { owner: extra.owner }),
      data: {
        kind: 'project',
        ...(id === undefined ? {} : { id }),
        name: extra.name,
        ...(path === undefined ? {} : { path }),
        ...(extra.owner === undefined ? {} : { owner: extra.owner }),
        main: false,
      },
    })
  }

  // ② 冲刺与卡
  const mainKey = main?.path ?? main?.name ?? ''
  if (extraction.sprint !== undefined && main !== undefined) {
    const projectId = projectIdFor(ctx, main.name, main.path) ?? main.name
    const exists = ctx.board.sprints.find(one => one.project_id === projectId && normalizeTitle(one.name) === normalizeTitle(extraction.sprint?.name ?? ''))
    const modules = [...new Set(extraction.cards.map(card => card.group ?? '参赛冲刺'))]
    rows.push({
      key: `sprint:${normalizeTitle(extraction.sprint.name)}`,
      kind: 'sprint',
      group: 'sprint',
      title: `冲刺「${extraction.sprint.name}」`,
      detail: `截止 ${shortDate(extraction.sprint.deadline)};分 ${modules.join('、')} 两栏`.replace('两栏', modules.length === 2 ? '两栏' : `${modules.length} 栏`),
      checked: exists === undefined && ctx.wired.tasks && ctx.wired.projects,
      ...(exists === undefined ? {} : { done: true }),
      ...(!ctx.wired.tasks ? { placeholder: '这台工作台没接看板' } : !ctx.wired.projects ? { placeholder: '这台工作台没接项目区,冲刺归不到项目' } : {}),
      data: { kind: 'sprint', name: extraction.sprint.name, deadline: extraction.sprint.deadline, project: mainKey, modules },
    })
  }
  for (const card of extraction.cards) {
    const exists = existingCard(ctx, card.title)
    const bits: string[] = [`负责:${OWNER_LABELS[card.owner]}${card.owner_note === undefined ? '' : `(${card.owner_note})`}`]
    if (card.status === 'doing') bits.push('进行中')
    if (card.status === 'confirm') bits.push('等你确认')
    if (card.due !== undefined) bits.push(`截止 ${shortDate(card.due)}`)
    if (card.priority === 'high') bits.push('最高优先')
    if (card.blocking === false) bits.push('不阻塞')
    rows.push({
      key: `task:${card.topic ?? normalizeTitle(card.title)}`,
      kind: 'task',
      group: 'sprint',
      title: card.title,
      detail: bits.join(' · '),
      quote: card.quote,
      checked: exists === undefined,
      ...(exists === undefined ? {} : { done: true }),
      ...(ctx.wired.tasks ? {} : { placeholder: '这台工作台没接看板' }),
      owner: card.owner,
      editable: exists === undefined,
      data: { kind: 'task', card, project: mainKey },
    })
  }

  // ③ 每天:例程、免打扰、资讯
  const times = timesOf(archive)
  if (times.morning !== undefined) {
    const same = ctx.routines?.morning?.at === times.morning
    rows.push({
      key: 'routine:morning',
      kind: 'routine',
      group: 'daily',
      title: `${spokenTime(times.morning)}:播客和早报准备好`,
      detail: '你起来自己点开看;播客按下面两个项目搜',
      checked: !same,
      ...(same ? { done: true } : {}),
      ...(ctx.wired.routines ? {} : { placeholder: '这台工作台没接例程' }),
      data: { kind: 'routine', which: 'morning', at: times.morning },
    })
  }
  if (times.evening !== undefined) {
    const same = ctx.routines?.evening?.at === times.evening
    rows.push({
      key: 'routine:evening',
      kind: 'routine',
      group: 'daily',
      title: `${spokenTime(times.evening)}:收尾`,
      detail: '下班例程:记进展、摆好明天',
      checked: !same,
      ...(same ? { done: true } : {}),
      ...(ctx.wired.routines ? {} : { placeholder: '这台工作台没接例程' }),
      data: { kind: 'routine', which: 'evening', at: times.evening },
    })
  }
  if (times.quietFrom !== undefined && times.quietTo !== undefined) {
    const same = ctx.quiet?.from === times.quietFrom && ctx.quiet?.to === times.quietTo
    rows.push({
      key: 'quiet',
      kind: 'quiet',
      group: 'daily',
      title: `${spokenTime(times.quietFrom)}到${spokenTime(times.quietTo)}不打扰`,
      detail: `${ctx.quiet === undefined ? '' : `现在是 ${ctx.quiet.from}–${ctx.quiet.to};`}这段时间有事只发通知不响铃,手机和电脑同一份`,
      checked: !same,
      ...(same ? { done: true } : {}),
      ...(ctx.wired.quiet ? {} : { placeholder: '这台工作台没接座机外呼' }),
      time: { from: times.quietFrom, to: times.quietTo },
      data: { kind: 'quiet', from: times.quietFrom, to: times.quietTo },
    })
  }
  const interests: { project: string, name: string, keywords: string[] }[] = []
  for (const [name, keywords] of Object.entries(extraction.keywords)) {
    const projectRow = rows.find(row => row.data.kind === 'project' && (row.data.name === name || row.title.includes(name) || row.key.endsWith(`/${name}`)))
    const projectName = projectRow !== undefined && projectRow.data.kind === 'project' ? projectRow.data.name : name
    const path = projectRow !== undefined && projectRow.data.kind === 'project' ? projectRow.data.path : undefined
    interests.push({ project: path ?? name, name: projectName, keywords })
  }
  const podcast = archive.answers.wrapup?.feed_podcast === true || /播客/.test(answerText(archive, 'habits', 'music') ?? '')
  if (interests.length > 0) {
    const same = interests.every(one => ctx.feed?.interests.some(have => (have.project_name === one.name || have.project_id === one.project) && one.keywords.every(word => have.keywords.includes(word))) === true)
    rows.push({
      key: 'feed',
      kind: 'feed',
      group: 'daily',
      title: `资讯与播客只按 ${interests.map(one => one.name).join('、')} 定向搜`,
      detail: interests.map(one => `${one.name}:${one.keywords.join('、')}`).join(';') + ';其余仓库不搜',
      checked: !same,
      ...(same ? { done: true } : {}),
      ...(ctx.wired.feed ? {} : { placeholder: '这台工作台没接资讯' }),
      data: { kind: 'feed', interests, podcast },
    })
  }

  // ④ 桌面:窗口槽、额度
  const enabled = ctx.apps?.enabled ?? []
  if (enabled.length > 0) {
    const labels = ctx.slotPreview?.results.map(one => one.label) ?? archive.app_labels ?? enabled
    rows.push({
      key: 'slot',
      kind: 'slot',
      group: 'desk',
      title: `窗口槽:${labels.join('、')}`,
      detail: slotDetail(ctx.slotPreview),
      checked: ctx.wired.slot,
      ...(ctx.wired.slot ? {} : { placeholder: '这台工作台没接窗口槽认领,拉不进来;标签已经在了,先点一下拉进来' }),
      data: { kind: 'slot', apps: [...enabled] },
    })
  }
  rows.push({
    key: 'quota',
    kind: 'quota',
    group: 'desk',
    title: '额度:DeepSeek、Claude、Codex、Kimi',
    detail: quotaDetail(ctx),
    // 这一行不替他点:落地只让「全部接上」那张卡出现在球下面,点仍由他。
    checked: false,
    placeholder: '「全部接上」在电脑首页球下面「额度还差一步」那张卡里,你自己点一次(不替你点);微信、企业微信没有额度,不在这里',
    data: { kind: 'quota' },
  })

  // ④″ 各家能做什么(2026-09-25,卡 O;设计第 3 条「设置与引导里每家三格」):体检那一句,只读 ——
  // 要修的(「登录 Claude」)在电脑设置「各家能做什么」里点,登录要他自己在那家的登录页上登,工作台不经手。
  if (ctx.agentCaps !== undefined) {
    rows.push({
      key: 'caps',
      kind: 'caps',
      group: 'desk',
      title: '各家能做什么',
      detail: ctx.agentCaps.line,
      checked: false,
      placeholder: '看一眼就好:要修的在电脑设置 →「各家能做什么」里点(登录在那家自己的登录页上登,工作台不经手)',
      data: { kind: 'caps' },
    })
  }

  // ④′ 派活分工(2026-09-25,卡 O):他在引导里说的「谁写代码、谁做综合、谁管哪个项目」→ 规矩表「派活默认分工」。
  // 以后派活的默认项按它选、选项里几家都列。表里已经有这一条(统筹手加的那条就是样板)→ 只多记一条依据,不另起一条。
  const division = divisionFromArchive(archive.answers, extraProjects(archive))
  const divisionText = division === undefined ? undefined : divisionRuleText(division)
  if (divisionText !== undefined) {
    const has = ctx.rules?.hasDivision === true
    const wiredRules = ctx.wired.rules === true
    rows.push({
      key: 'rules:division',
      kind: 'division',
      group: 'rules',
      title: DIVISION_TITLE,
      detail: `${divisionText.slice(divisionText.indexOf(':') + 1).replace(/。问他派给谁时[\s\S]*$/, '')} —— 以后派活默认照这个选,选项里几家都列${has ? '(规矩表里已经有这一条,落地时只多记一条依据)' : ''}`,
      checked: wiredRules,
      ...(wiredRules ? {} : { placeholder: '这台工作台没接规矩表' }),
      data: { kind: 'division', text: divisionText, said: divisionSaid(archive) },
    })
  }

  // ⑤ 记忆:③ 授权那一问被 400 拒过,补拷
  const imported = (archive.memory_index?.length ?? 0) > 0
    || archive.answers.projects?.import_memories === true
    || archive.answers.authorization?.import_memories === true
  const declined = archive.answers.projects?.import_memories === false || archive.answers.authorization?.import_memories === false
  if (!declined) {
    const allowed = ctx.readClientFiles === '可以'
    rows.push({
      key: 'memories',
      kind: 'memories',
      group: 'memory',
      title: '补拷记忆:Claude、Codex、Kimi 里记着的东西拷一份过来',
      // 说到做到:这一行只拷(③ 授权那一问当时被 400 拒了,没拷成);不许在这里许「拷完我去整理」这种这一步不做的事。
      detail: imported ? '已经拷过了' : allowed ? '③ 授权那一问当时没拷成,这次补上:只读原件、不改不删,拷进事务官这边的记忆文件夹' : `授权表里「读各家客户端文件」现在是「${ctx.readClientFiles ?? '未答'}」,先不拷`,
      checked: !imported && allowed && ctx.wired.memories,
      ...(imported ? { done: true } : {}),
      ...(!ctx.wired.memories ? { placeholder: '这台工作台没接「拷别家记忆」' } : !allowed && !imported ? { placeholder: '还没有「读各家客户端文件」的授权' } : {}),
      data: { kind: 'memories' },
    })
  }

  // ⑥ 撤掉
  for (const { task, why } of cancelCandidates(ctx)) {
    rows.push({
      key: `cancel:${task.id}`,
      kind: 'cancel',
      group: 'cleanup',
      title: task.title,
      detail: why,
      checked: ctx.wired.tasks,
      ...(ctx.wired.tasks ? {} : { placeholder: '这台工作台没接看板' }),
      data: { kind: 'cancel', task_id: task.id, from: task.status },
    })
  }

  // ⑦ 第一件
  const first = extraction.cards.find(card => card.first === true)
  if (first !== undefined) {
    const firstRowKey = `task:${first.topic ?? normalizeTitle(first.title)}`
    const existing = existingCard(ctx, first.title)
    const dispatched = existing !== undefined && (existing.conversation !== undefined || existing.dispatch !== undefined || (existing.links?.length ?? 0) > 0)
    const agent = AGENT_OWNERS.has(first.owner)
    const thread = ctx.codexThread
    rows.push({
      key: 'dispatch:first',
      kind: 'dispatch',
      group: 'first',
      title: `${first.title} → ${OWNER_LABELS[first.owner]}`,
      detail: !agent
        ? '这件不是交给 Agent 的,不派'
        : thread !== undefined
          ? `接着 Codex 里「${thread.title}」那条会话做;派不进那条会话就新开一条,消息里写清接着它做,做完汇报`
          : '新开一条,消息里写清接着之前那条会话做,做完汇报',
      checked: agent && !dispatched && ctx.wired.dispatch,
      ...(dispatched ? { done: true } : {}),
      ...(!ctx.wired.dispatch ? { placeholder: '这台工作台没接事务官会话,派不出去' } : !agent ? { placeholder: '不是交给 Agent 的' } : {}),
      data: {
        kind: 'dispatch',
        topic_key: firstRowKey,
        owner: first.owner,
        text: dispatchText(first, thread),
        agent_text: agentDispatchText(first, thread),
        ...(firstItemSaid(archive) === undefined ? {} : { said: firstItemSaid(archive) as string }),
        ...(thread === undefined ? {} : { thread }),
      },
    })
  }

  const counts = {
    projects: rows.filter(row => row.kind === 'project' && row.placeholder === undefined).length,
    tasks: rows.filter(row => row.kind === 'task' && row.placeholder === undefined).length,
    cancel: rows.filter(row => row.kind === 'cancel' && row.placeholder === undefined).length,
  }
  const groups = (Object.keys(GROUP_TITLES) as MaterializeGroup[])
    .filter(id => rows.some(row => row.group === id))
    .map(id => ({ id, title: id === 'sprint' && extraction.sprint !== undefined ? `冲刺 · ${extraction.sprint.name}` : GROUP_TITLES[id] }))
  const inputHash = archiveHash(archive)
  const id = contentHash({ inputHash, rows: rows.map(row => [row.key, row.title, row.detail ?? '', row.checked, row.done === true, row.placeholder ?? '']) })
  const plan: MaterializePlan = {
    version: 1,
    id,
    created_at: ctx.now.toISOString(),
    input_hash: inputHash,
    source: extraction.source,
    ...(extraction.model_note === undefined ? {} : { model_note: extraction.model_note }),
    line: '',
    counts,
    groups,
    rows,
    skipped: extraction.skipped,
  }
  plan.line = planLine(plan)
  return plan
}

/**
 * 窗口槽那一行的小字(卡 C 的 `claimPreview`)。**预览里一个都不说「摆好了」**:`ready` 是「落地时直接拉进来」,
 * 真拉进来(`claimed` / `already`)才算数,那是落地回执的事。
 */
function slotDetail(preview: PlanContext['slotPreview']): string {
  if (preview === undefined) return '标签已经在了;能自动拉进来的自动拉,拉不进来的标签上写「点一下拉进来」'
  const pick = (states: readonly string[]): string[] => preview.results.filter(one => states.includes(one.state)).map(one => one.label)
  const already = pick(['already', 'claimed'])
  const ready = pick(['ready'])
  const click = pick(['needs_click', 'not_running', 'failed'])
  return [
    already.length === 0 ? '' : `${already.join('、')} 已经在窗口槽里`,
    ready.length === 0 ? '' : `${ready.join('、')} 开着,落地时直接拉进来`,
    click.length === 0 ? '' : `${click.join('、')} 标签上写「点一下拉进来」`,
  ].filter(one => one !== '').join(';')
}

function quotaDetail(ctx: PlanContext): string {
  if (ctx.quotaStatus?.line !== undefined && ctx.quotaStatus.line.trim() !== '') return ctx.quotaStatus.line.trim()
  const providers = ctx.quotaStatus?.providers
  if (providers !== undefined && providers.length > 0) {
    const connected = providers.filter(one => one.state === 'connected').map(one => one.label)
    const oneClick = providers.filter(one => one.state === 'one_click').map(one => one.label)
    const login = providers.filter(one => one.state === 'login').map(one => one.label)
    return [
      connected.length === 0 ? '' : `${connected.join('、')} 已接上`,
      oneClick.length === 0 ? '' : `${oneClick.join('、')} 要你点一次「全部接上」`,
      login.length === 0 ? '' : `${login.join('、')} 要你登录一次`,
    ].filter(one => one !== '').join(';')
  }
  const clients = ctx.clients ?? {}
  const need = ['claude', 'codex'].filter(key => clients[key]?.installed === true && clients[key]?.connected !== true).map(key => (key === 'claude' ? 'Claude' : 'Codex'))
  const kimi = clients.kimi?.installed === true && clients.kimi?.connected !== true
  return [
    'DeepSeek 走工作台提供的服务',
    need.length === 0 ? '' : `${need.join('、')} 要你点一次「全部接上」`,
    kimi ? 'Kimi 要你登录一次' : '',
  ].filter(one => one !== '').join(';')
}

/** 分工那几句他的原话(引导里「其它习惯」那一段里点到几家的那几句),记成规矩的依据。 */
function divisionSaid(archive: MaterializeArchive): string {
  const other = answerText(archive, 'habits', 'other') ?? ''
  const picked = other.split(/[。;;\n]/).map(one => one.trim()).filter(one => familiesIn(one).length > 0)
  return (picked.length === 0 ? other : picked.join(';')).slice(0, 240)
}

/** 他点头的第一件那句原话(去掉后半句的旧清单)。 */
function firstItemSaid(archive: MaterializeArchive): string | undefined {
  const first = answerText(archive, 'wrapup', 'first_item')
  const head = first?.split(/[;;\uFF1B]/)[0]?.trim()
  return head === undefined || head === '' ? undefined : head
}

/** 交给事务官的那一句(「第一件」)。 */
export function dispatchText(card: ExtractedCard, thread: { id: string, title: string } | undefined): string {
  const who = OWNER_LABELS[card.owner]
  const lines = [
    thread === undefined
      ? `让 ${who} 接着之前的工作:${card.title.replace(/收尾$/, '')}剩下的补完,完了汇报。`
      : `让 ${who} 接着「${thread.title}」那条会话的工作:把${card.title.replace(/收尾$/, '')}剩下的补完,完了汇报。`
      + `那条会话在 ${who} 桌面 App 里(会话 id ${thread.id})。优先派进那条会话接着做;派不进指定会话就新开一条,并在消息里写清「接着『${thread.title}』那条会话的工作:把架构剩下的补完,完了汇报」。`,
  ]
  if (/参赛/.test(card.title)) lines.push('文案不用写(同事回来写),视频不用管(别人接手)。')
  return lines.join('')
}

/**
 * 直接说给那一家听的那一句(卡 F 的 `dispatchItem` 新开一条对话送进去)。**送不进指定会话就明说是新开的**,
 * 让它先看提交和没提交的改动接着做,别从头重做;做完用几句话汇报 —— 那几句就是回到他手机上的汇报。
 */
export function agentDispatchText(card: ExtractedCard, thread: { id: string, title: string } | undefined): string {
  const what = card.title.replace(/收尾$/, '')
  const lines = [
    thread === undefined
      ? `接着之前的工作:把${what}剩下的补完,完了汇报。`
      : `接着「${thread.title}」那条会话的工作:把${what}剩下的补完,完了汇报。工作台送不进那条会话,所以新开了这一条。`,
    '先看最近的提交和还没提交的改动,弄清做到哪了再接着做,别从头重做;不要合并到 main、不要发版、不要删文件。',
  ]
  if (/参赛/.test(card.title)) lines.push('文案不用写(同事回来写),视频不用管(别人接手)。')
  lines.push('做完用三五句话汇报:做了什么、改了哪些文件、还差什么。')
  return lines.join('')
}

/**
 * 电话里那一句(维护者:「结束环节的大总结听得我好累」)。**只说这一句**,完整的单子在屏幕上。
 * 「都摆好了,两个项目、十件事,屏幕上有张单子;第一件交给 Codex 接着做参赛网页,行吗?」
 */
export function planLine(plan: Pick<MaterializePlan, 'rows'>): string {
  const live = plan.rows.filter(row => row.checked && row.done !== true)
  // 做不了的(占位)不算进「摆好了」里 —— 没接项目区就别说「两个项目」。
  const projects = plan.rows.filter(row => row.kind === 'project' && row.placeholder === undefined).length
  const tasks = plan.rows.filter(row => row.kind === 'task' && row.placeholder === undefined).length
  const count = (n: number, unit: string): string => `${n <= 10 ? '零一两三四五六七八九十'[n] : n}${unit}`
  const parts: string[] = []
  if (projects > 0) parts.push(count(projects, '个项目'))
  if (tasks > 0) parts.push(count(tasks, '件事'))
  const head = parts.length === 0 ? '都记好了,屏幕上有张单子' : `都摆好了,${parts.join('、')},屏幕上有张单子`
  const dispatch = live.find(row => row.kind === 'dispatch')
  if (dispatch !== undefined && dispatch.data.kind === 'dispatch') {
    const what = dispatch.title.split(' → ')[0]?.replace(/收尾$/, '').replace(/架构$/, '') ?? ''
    return `${head};第一件交给 ${OWNER_LABELS[dispatch.data.owner]} 接着做${what},行吗?`
  }
  return `${head},你看一眼,行吗?`
}

// ———————————————————————————— 他勾掉 / 改了 ————————————————————————————

/** 「改一下」交上来的:卡片那几行改标题 / 负责人;免打扰那一行改到几点(`to`,HH:MM)。 */
export interface RowEdit { title?: string, owner?: CardOwner, to?: string }

const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/

/**
 * 他在单子上勾掉的、改过的 → 这一次真做的那几行。
 * `skip` 是电话里他说「文案那件不用」这种:按标题认(像就算),认不出的原样回去让她问一句。
 */
export function selectRows(
  plan: MaterializePlan,
  input: { uncheck?: readonly string[], check?: readonly string[], edits?: Readonly<Record<string, RowEdit>>, skip?: readonly string[] },
): { rows: MaterializeRow[], unmatched: string[] } {
  const uncheck = new Set(input.uncheck ?? [])
  const check = new Set(input.check ?? [])
  const unmatched: string[] = []
  for (const phrase of input.skip ?? []) {
    const text = phrase.trim()
    if (text === '') continue
    const hit = plan.rows.find(row => row.title.includes(text) || text.includes(row.title) || titleSimilarity(row.title, text) >= 0.5)
    if (hit === undefined) unmatched.push(text)
    else uncheck.add(hit.key)
  }
  const rows: MaterializeRow[] = []
  for (const row of plan.rows) {
    if (row.done === true || row.placeholder !== undefined) continue
    const wanted = uncheck.has(row.key) ? false : check.has(row.key) ? true : row.checked
    if (!wanted) continue
    const edit = input.edits?.[row.key]
    if (edit !== undefined && row.data.kind === 'task') {
      const title = typeof edit.title === 'string' && edit.title.trim() !== '' ? clip(edit.title.trim(), 40) : undefined
      const owner = edit.owner !== undefined && CARD_OWNERS.includes(edit.owner) ? edit.owner : undefined
      const card: ExtractedCard = { ...row.data.card, ...(title === undefined ? {} : { title }), ...(owner === undefined ? {} : { owner }) }
      rows.push({ ...row, title: card.title, owner: card.owner, data: { ...row.data, card } })
      continue
    }
    if (edit !== undefined && row.data.kind === 'quiet' && typeof edit.to === 'string' && CLOCK.test(edit.to) && edit.to !== row.data.from) {
      const to = edit.to
      rows.push({ ...row, title: `${spokenTime(row.data.from)}到${spokenTime(to)}不打扰`, time: { from: row.data.from, to }, data: { ...row.data, to } })
      continue
    }
    rows.push(row)
  }
  // 第一件那一行跟着卡走:卡被勾掉,第一件也不派。
  const dispatch = rows.find(row => row.data.kind === 'dispatch')
  if (dispatch !== undefined && dispatch.data.kind === 'dispatch') {
    const topic = dispatch.data.topic_key
    const cardRow = plan.rows.find(row => row.key === topic)
    const cardKept = cardRow === undefined || cardRow.done === true || rows.some(row => row.key === topic)
    if (!cardKept) rows.splice(rows.indexOf(dispatch), 1)
  }
  return { rows, unmatched }
}

/** 卡落到看板上的描述(负责人、出处)。 */
export function cardDesc(card: ExtractedCard): string {
  const lines = [
    `负责:${OWNER_LABELS[card.owner]}${card.owner_note === undefined ? '' : `(${card.owner_note})`}`,
    ...(card.note === undefined ? [] : [card.note]),
    `他的原话:「${card.quote}」`,
    '(引导落地建的,照他在引导里说的)',
  ]
  return lines.join('\n')
}

/**
 * 卡的 `assignee`(2026-09-25,卡 N 起**负责人是真的**):三家 Agent 照旧;事务官 → `dsh`;
 * 你 / 同事 / 别人 → `me` / `colleague` / `other`(以前只写进描述那一行,负责人那一格缺席,没人知道这张该谁动)。
 */
export function cardAssignee(card: ExtractedCard): TaskAssignee | undefined {
  if (AGENT_OWNERS.has(card.owner)) return card.owner as 'codex' | 'claude' | 'kimi'
  return OWNER_ASSIGNEE[card.owner]
}

const OWNER_ASSIGNEE: Readonly<Partial<Record<CardOwner, TaskAssignee>>> = {
  butler: 'dsh', me: 'me', colleague: 'colleague', other: 'other',
}

/**
 * 老卡的负责人(2026-09-25,卡 N):0.2.88–0.2.98 引导落地建的卡,「你 / 同事 / 别人」只写在描述第一行
 * 「负责:同事(9/29 回来写)」、负责人那一格缺席。起服务时照这一行补上负责人与补充 —— **只补缺席的**,
 * 他改过的一格都不碰;认不出那一行就不补。
 */
export function ownerFromDesc(desc: string | undefined): { assignee: TaskAssignee, note?: string } | undefined {
  const first = (desc ?? '').split('\n')[0] ?? ''
  const match = /^负责:(你|同事|别人|事务官)(?:[((]([^))]+)[))])?\s*$/.exec(first.trim())
  if (match === null) return undefined
  const assignee: TaskAssignee = match[1] === '你' ? 'me' : match[1] === '同事' ? 'colleague' : match[1] === '别人' ? 'other' : 'dsh'
  return { assignee, ...(match[2] === undefined ? {} : { note: match[2].trim() }) }
}
