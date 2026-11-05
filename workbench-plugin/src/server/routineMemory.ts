/**
 * 事务官例程里**不经模型**的那一半(2026-09-15,docs/设计-事务官完整材料.md §4.2、
 * docs/记忆/下班例程.md)。
 *
 * 两件事都是纯文本函数,不碰 I/O(I/O 在 routines.ts):
 * 1. **开工汇报的三句**:从记忆文件与 /state 数出来——上次记住了什么、今天在盯什么、
 *    几条等你拍板。取不到就少一句,数字必须能指回某个文件或某个 /state 字段,绝不编(D13)。
 * 2. **下班例程的机械步骤**:布局快照覆盖(手写那一节保留)、给今天有活动的项目文件
 *    追加一条进展(只追加不删)、项目索引的「最近活动」列、全仓库记忆索引重写。
 *    判断类的步骤(偏好、矛盾、待拍板)留给 DSH 会话里的模型做——那是它的活,不是代码的。
 */
import type { MeetingView, TasksState, TodayTodosView, WorkbenchProject, WorkbenchState } from '../protocol.ts'
import { RISK_WINDOW_DAYS } from './scheduleRisk.ts'

/** —— 一、从记忆文件数出来的事实 —— */

export interface MemoryFacts {
  /** 最近一次有记录的那一天:那天记了几条进展、哪些项目、几条观察。一条带日期的记录都没有就缺席。 */
  last?: {
    date: string
    progress: number
    projects: string[]
    observations: number
  }
  /** 决策记录里带「待拍板」的段数。没读到决策记录就缺席。 */
  pending_decisions?: number
}

export interface MemoryTexts {
  /** `docs/记忆/项目/<名>.md` 各一份(不含 索引.md)。 */
  projects: readonly { name: string, text: string }[]
  /** `docs/记忆/用户-Ben.md`。 */
  user?: string
  /** `docs/决策记录.md`。 */
  decisions?: string
}

const DATE_RE = /^(\d{4}-\d{2}-\d{2})/

/** 把 Markdown 按 `## ` 切成节:[标题行, 正文行数组]。标题之前的部分算作空标题。 */
function sections(text: string): { heading: string, lines: string[] }[] {
  const out: { heading: string, lines: string[] }[] = [{ heading: '', lines: [] }]
  for (const line of text.split('\n')) {
    if (line.startsWith('## ')) out.push({ heading: line, lines: [] })
    else (out[out.length - 1] as { lines: string[] }).lines.push(line)
  }
  return out
}

/** 「## 进展…」那一节里的日期行(`- YYYY-MM-DD:…`)。 */
function progressDates(text: string): string[] {
  const section = sections(text).find(s => s.heading.startsWith('## 进展'))
  if (section === undefined) return []
  return section.lines
    .map(line => (line.startsWith('- ') ? DATE_RE.exec(line.slice(2))?.[1] : undefined))
    .filter((date): date is string => date !== undefined)
}

/** 「## 观察…」那一节里的日期行(`- YYYY-MM-DD · …`)。 */
function observationDates(text: string): string[] {
  const section = sections(text).find(s => s.heading.startsWith('## 观察'))
  if (section === undefined) return []
  return section.lines
    .map(line => (line.startsWith('- ') ? DATE_RE.exec(line.slice(2))?.[1] : undefined))
    .filter((date): date is string => date !== undefined)
}

export function parseMemoryFacts(texts: MemoryTexts): MemoryFacts {
  const perProject = texts.projects.map(p => ({ name: p.name, dates: progressDates(p.text) }))
  const observations = texts.user === undefined ? [] : observationDates(texts.user)
  const allDates = [...perProject.flatMap(p => p.dates), ...observations]
  const facts: MemoryFacts = {}
  if (allDates.length > 0) {
    const date = allDates.reduce((max, d) => (d > max ? d : max))
    const projects = perProject.filter(p => p.dates.includes(date)).map(p => p.name)
    facts.last = {
      date,
      progress: perProject.reduce((n, p) => n + p.dates.filter(d => d === date).length, 0),
      projects,
      observations: observations.filter(d => d === date).length,
    }
  }
  if (texts.decisions !== undefined) {
    // 一段 = 一个 `## ` 标题到下一个之间;标题或正文里出现「待拍板」就算一段。
    // 这是个能指回文件的数(grep 得到),不是"判断"——判断留给人。
    facts.pending_decisions = sections(texts.decisions)
      .filter(s => s.heading !== '' && `${s.heading}\n${s.lines.join('\n')}`.includes('待拍板'))
      .length
  }
  return facts
}

/** —— 二、从 /state 数出来的事实 —— */

export interface StateFacts {
  /** 哨兵监视项数。没接哨兵就缺席。 */
  sentinel?: number
  /** DSH 会话:在跑几条、等着几条(投影会话不算)。 */
  running: number
  waiting: number
  /** 排期赶不上的项目数。没接项目区就缺席。 */
  late?: number
  /** 「等我确认」的卡数。没接任务板就缺席。 */
  confirm?: number
}

const PROJECTION_PREFIXES = ['sentinel:', 'schedule:'] as const

export function stateFactsOf(state: WorkbenchState): StateFacts {
  const dsh = state.sessions.filter(s => s.agent === 'dsh' && !PROJECTION_PREFIXES.some(p => s.session_id.startsWith(p)))
  return {
    ...(state.sentinel === undefined ? {} : { sentinel: state.sentinel.watches.length }),
    running: dsh.filter(s => s.status === 'running').length,
    waiting: dsh.filter(s => s.status === 'waiting').length,
    ...(state.projects === undefined ? {} : { late: state.projects.projects.filter(p => p.risk?.level === 'late').length }),
    ...(state.tasks === undefined ? {} : { confirm: state.tasks.tasks.filter(t => t.status === 'confirm').length }),
  }
}

/** —— 三、三句加一问 —— */

export interface MorningReport {
  /** 最多三句,取不到的那句没有。 */
  sentences: string[]
  question: string
  /** 三句各占一行,最后一行是问句。就是发给 Ben 与写进会话的原文。 */
  text: string
}

export const MORNING_QUESTION = '今天先做哪件?'

/** `2026-09-14` → `9月14日`。 */
function chineseDate(date: string): string {
  const [, month, day] = /^\d{4}-(\d{2})-(\d{2})$/.exec(date) ?? []
  return month === undefined || day === undefined ? date : `${Number(month)}月${Number(day)}日`
}

function rememberedSentence(memory: MemoryFacts | undefined): string | undefined {
  const last = memory?.last
  if (last === undefined) return undefined
  const parts: string[] = []
  if (last.progress > 0) {
    const names = last.projects.slice(0, 3).join('、') + (last.projects.length > 3 ? ' 等' : '')
    parts.push(`${last.projects.length} 个项目的进展(${names})`)
  }
  if (last.observations > 0) parts.push(`${last.observations} 条关于你的观察`)
  if (parts.length === 0) return undefined
  return `上次 ${chineseDate(last.date)} 记了 ${parts.join('、')}。`
}

function watchingSentence(state: StateFacts): string {
  const parts: string[] = []
  if (state.sentinel !== undefined && state.sentinel > 0) parts.push(`哨兵 ${state.sentinel} 项`)
  if (state.running > 0) parts.push(`${state.running} 条会话在跑`)
  if (state.waiting > 0) parts.push(`${state.waiting} 条在等你`)
  if (state.late !== undefined && state.late > 0) parts.push(`${state.late} 个项目排期赶不上`)
  return parts.length === 0 ? '今天没有在盯的事。' : `今天在盯:${parts.join('、')}。`
}

function pendingSentence(memory: MemoryFacts | undefined, state: StateFacts): string | undefined {
  const decisions = memory?.pending_decisions
  if (decisions === undefined && state.confirm === undefined) return undefined
  const parts: string[] = []
  if (decisions !== undefined && decisions > 0) parts.push(`决策记录 ${decisions} 段待拍板`)
  if (state.confirm !== undefined && state.confirm > 0) parts.push(`${state.confirm} 张卡等你确认`)
  return parts.length === 0 ? '没有等你拍板的。' : `等你拍板:${parts.join('、')}。`
}

/** —— 三之一、今天的会与今天的待办(2026-10-13) —— */

export const MEETING_TODAY_HEAD = '今天要开的会:'
export const TODAY_TODO_HEAD = '今天的待办:'
/** 待办最多念几条(同停太久那一段的 5 条:早上念一长串没人听得完)。 */
export const TODAY_TODO_MAX = 5

/** ISO → 本机 `HH:MM`;认不出回 undefined(不猜一个时刻)。 */
function localHhmm(iso: string | undefined): string | undefined {
  if (iso === undefined) return undefined
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) return undefined
  const at = new Date(ms)
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
}

/** 预案卡这一刻的一句话。`ask` 在的时候由调用处先说那一问,这里不管。 */
function prepCardPhrase(prep: NonNullable<MeetingView['prep']>): string {
  if (prep.goal_unclear === true && prep.ask === undefined) return '目的还没说清,等你一句'
  if (prep.card_status === 'ready') return '预案卡好了'
  if (prep.card_status === 'making') return '预案卡在做'
  if (prep.card_status === 'failed') return prep.card_error === undefined ? '预案卡没做成' : `预案卡没做成(${prep.card_error})`
  return '预案卡还没做'
}

/**
 * 早报里的「今天要开的会」(2026-10-13,卡「早报:界面上能随时跑一遍…」第 3 件)。
 *
 * 素材是 `/state.meetings.upcoming`(会前登记、还没开录的那几场,`server/meetingPrep.ts` 算好的):
 * **只挑今天那几场**,一行写几点、跟谁、还差哪一问 / 预案卡好了没。
 * 一场都没有就整段不出(不写「今天没有会」——那是句废话,同 feedLines 的纪律);
 * 不经模型、不另起扫描,每一个字都指回 `prep` 上的某一格。
 */
export function meetingTodayLines(upcoming: readonly MeetingView[] | undefined, today: string): string[] {
  const todays = (upcoming ?? []).filter(one => one.date === today)
  if (todays.length === 0) return []
  const lines = todays.map((one) => {
    const prep = one.prep
    const when = localHhmm(prep?.scheduled_at) ?? prep?.when ?? '没说几点'
    const aliases = (prep?.people?.value ?? []).map(person => person.alias).filter(alias => alias !== '')
    const who = aliases.length === 0 ? '' : `(跟 ${aliases.join('、')})`
    const tail = prep === undefined
      ? '直接开录的那一场'
      : prep.ask === undefined ? prepCardPhrase(prep) : `还差一问:${prep.ask.text}`
    return `- ${when}「${one.title}」${who};${tail}`
  })
  return [MEETING_TODAY_HEAD, ...lines]
}

/**
 * 早报里的「今天的待办」(2026-10-13)。素材是 `/state.today_todos`(`src/todayTodos.ts` 按 `due` 切好的今天那一刀,
 * 只在自媒体模板下有)。**今天已经办完的不念**(早上要听的是还得办的),逾期的写明原定哪天;
 * 最多 {@link TODAY_TODO_MAX} 条,超出末尾一行「还有 N 条」。一条都没有就整段不出。
 */
export function todayTodoLines(view: TodayTodosView | undefined): string[] {
  const open = (view?.items ?? []).filter(item => !item.done)
  if (open.length === 0) return []
  const lines = open.slice(0, TODAY_TODO_MAX).map(item =>
    `- 「${item.title}」${item.overdue ? `(逾期,原定 ${chineseDate(item.due)})` : ''}`)
  if (open.length > TODAY_TODO_MAX) lines.push(`还有 ${open.length - TODAY_TODO_MAX} 条`)
  return [TODAY_TODO_HEAD, ...lines]
}

/**
 * 早报里的资讯那几行(2026-09-21)。每个项目一行标题 + 最多 3 条,一条一行。
 * **一条都没有就整段不出**(不写「今天没有资讯」——那是句废话,而且多半只说明搜索没配)。
 * 条目里的每一个字都来自搜索结果与模型的那一句 why,这里一个字都不编。
 */
export function feedLines(groups: readonly { project_name: string, items: readonly { title: string, why: string, source?: string }[] }[]): string[] {
  const lines: string[] = []
  for (const group of groups) {
    if (group.items.length === 0) continue
    lines.push(`【${group.project_name}】今天看到:`)
    for (const item of group.items) {
      lines.push(`- 《${item.title}》${item.source === undefined ? '' : `(${item.source})`}:${item.why}`)
    }
  }
  return lines
}

/**
 * 三句由代码拼,不经模型:
 * ① 上次记住了什么(记忆文件)——没有记忆仓库或一条带日期的记录都没有 → 这句没有;
 * ② 今天在盯什么(/state)——永远有(会话表永远在),但一件都没有时如实说没有;
 * ③ 几条等你拍板(决策记录 + 看板)——两边都取不到 → 这句没有。
 *
 * 2026-09-21 起多一段**可选**的资讯(`feed`,每项目最多 3 条,来自 server/feed.ts)。
 * **缺席 = 与加它之前逐字相同**,既有那一批早报用例一条没改。
 *
 * 2026-09-22 起再多一段**可选**的运营目标进度(`goals`,一行一个账号,来自
 * server/accounts.ts 的 composeGoalProgress)。同样地:**缺席 = 逐字相同**。
 * 它排在资讯前面 —— 目标是她自己定下的事,资讯是外面的事。
 *
 * 2026-09-25 起再多一段**可选**的进度核对(`progress`,卡 N):按证据核过、**只念变了的**那几件,
 * 加上他自己的事与同事 / 别人的到期提醒。排在那三句之后、目标与资讯之前 —— 「事情到哪了」是早上最先要知道的。
 * 同样地:**缺席或空 = 逐字相同**。
 *
 * 2026-10-12 起再多一段**可选**的「停太久的事项」(`stalled`,卡「没办完的事项说清楚」):紧跟那三句 ——
 * 卡住没人推的事比「进度变了」更该先听到。缺席或空 = 逐字相同。
 *
 * 2026-10-13 起最前面多一段**可选**的日报四段(`day_review`,`server/agentDayReview.ts`,照《日报规范》):
 * 已完成 / 推进中 / 卡点 / 下一步。它在的时候「今天的待办」与「停太久」不再单独出一段 ——
 * 待办已经并进「下一步」、停太久的并进「卡点」。缺席或空 = 逐字相同。
 *
 * 2026-10-13 起再多两段**可选**的「今天要开的会」(`meetings`)与「今天的待办」(`todos`):
 * 排在最前面那几段 —— 今天几点有会、今天还得办什么,决定了别的几段还看不看得动。
 * 同样地:缺席或空 = 逐字相同。
 */
export function composeMorningReport(input: {
  memory?: MemoryFacts | undefined
  state: StateFacts
  feed?: readonly { project_name: string, items: readonly { title: string, why: string, source?: string }[] } []
  /** 一行一个账号的进度句。**一行都没有就整段不出**(不写「今天没有目标要对」那种废话)。 */
  goals?: readonly string[]
  /** 按证据核过的进度(只有变了的)与负责人那两段。一行都没有就整段不出。 */
  progress?: readonly string[]
  /** 停太久的事项(2026-10-12,`itemStanding.stalledMorningLines`)。一行都没有就整段不出。 */
  stalled?: readonly string[]
  /** 今天要开的会(2026-10-13,`meetingTodayLines`)。一行都没有就整段不出。 */
  meetings?: readonly string[]
  /** 今天的待办(2026-10-13,`todayTodoLines`)。一行都没有就整段不出。 */
  todos?: readonly string[]
  /**
   * 日报正文那四段(2026-10-13,`agentDayReview.dayReviewLines`)。**排在最前** —— 这就是维护者说的「日报」。
   * 有它的时候「今天的待办」与「停太久的事项」两段不再单独出:待办已经并进四段的「下一步」、
   * 停太久的已经并进「卡点」,同一件事不在早报里出现两次。缺席或空 = 与加它之前逐字相同。
   */
  day_review?: readonly string[]
}): MorningReport {
  const sentences = [
    rememberedSentence(input.memory),
    watchingSentence(input.state),
    pendingSentence(input.memory, input.state),
  ].filter((s): s is string => s !== undefined)
  const goals = (input.goals ?? []).filter(line => line.trim() !== '')
  const progress = (input.progress ?? []).filter(line => line.trim() !== '')
  const review = (input.day_review ?? []).filter(line => line.trim() !== '')
  // 四段出来了就不再单独念待办与停太久(它们已经在「下一步」「卡点」里)。
  const stalled = review.length > 0 ? [] : (input.stalled ?? []).filter(line => line.trim() !== '')
  const meetings = (input.meetings ?? []).filter(line => line.trim() !== '')
  const todos = review.length > 0 ? [] : (input.todos ?? []).filter(line => line.trim() !== '')
  const feed = feedLines(input.feed ?? [])
  const blocks = [
    ...(review.length === 0 ? [] : [review.join('\n')]),
    sentences.join('\n'),
    ...(meetings.length === 0 ? [] : [meetings.join('\n')]),
    ...(todos.length === 0 ? [] : [todos.join('\n')]),
    ...(stalled.length === 0 ? [] : [stalled.join('\n')]),
    ...(progress.length === 0 ? [] : [progress.join('\n')]),
    ...(goals.length === 0 ? [] : [goals.join('\n')]),
    ...(feed.length === 0 ? [] : [feed.join('\n')]),
  ]
  return { sentences, question: MORNING_QUESTION, text: `${blocks.join('\n\n')}\n${MORNING_QUESTION}` }
}

/** —— 四、下班例程的机械写入(纯文本) —— */

const PROGRESS_HEADING = '## 进展(倒序,一条一日期)'

/**
 * 往「## 进展」节的第一行插一条(倒序)。**只追加不删**:旧的每一行都原样保留、顺序不变。
 * 同一条已经在了就不动(同一天跑两次例程不该出现两条一样的)。没有这一节就在末尾补一节。
 */
export function appendProgress(text: string, line: string): { text: string, changed: boolean } {
  const lines = text.split('\n')
  const at = lines.findIndex(l => l.startsWith('## 进展'))
  if (at === -1) {
    const base = text.endsWith('\n') ? text : `${text}\n`
    return { text: `${base}\n${PROGRESS_HEADING}\n${line}\n`, changed: true }
  }
  const end = lines.findIndex((l, i) => i > at && l.startsWith('## '))
  const body = lines.slice(at + 1, end === -1 ? lines.length : end)
  if (body.includes(line)) return { text, changed: false }
  lines.splice(at + 1, 0, line)
  return { text: lines.join('\n'), changed: true }
}

/**
 * 一条进展怎么写:日期 + 仓库信号 + 看板上这个项目的卡 + 依据。
 * 数字全部来自 /state,写清楚来自哪个字段;拿不到的(recent_commits 缺席、没接任务板)那一段不写。
 */
export function progressLine(project: WorkbenchProject, date: string, tasks?: TasksState): string {
  const signals = project.signals
  const facts: string[] = []
  const evidence: string[] = [`/state.projects[${project.name}].signals`]
  if (signals !== undefined) {
    facts.push(`分支 \`${signals.branch}\``, `未提交 ${signals.dirty_count} 处`)
    if (signals.recent_commits !== undefined) facts.push(`近 ${RISK_WINDOW_DAYS} 天 ${signals.recent_commits} 次提交`)
  }
  let board = ''
  if (tasks !== undefined) {
    const mine = tasks.tasks.filter(t => t.project_id === project.id)
    const doing = mine.filter(t => t.status === 'doing').length
    const confirm = mine.filter(t => t.status === 'confirm').length
    const doneToday = mine.filter(t => t.status === 'done' && t.done_at !== undefined && t.done_at.startsWith(date)).length
    const parts: string[] = []
    if (doing > 0) parts.push(`在办 ${doing} 张`)
    if (confirm > 0) parts.push(`等确认 ${confirm} 张`)
    if (doneToday > 0) parts.push(`今天办完 ${doneToday} 张`)
    board = parts.length === 0 ? ';看板:这个项目没有在动的卡' : `;看板:${parts.join('、')}`
    evidence.push('/state.tasks')
  }
  const detail = facts.length === 0 ? '' : `——${facts.join(',')}`
  return `- ${date}:今天有活动${detail}${board}(依据:${evidence.join('、')};下班例程自动追加)`
}

/** 新项目的记忆文件。字段与统筹会话 2026-09-10 建的那一批完全一样。 */
export function newProjectFile(name: string, path: string | undefined, date: string): string {
  return [
    `# ${name}`,
    '',
    '> 项目记忆文件。字段固定,每条带日期与依据;「待梳理」表示还没人核实过。事务官只改「进展/下一步/风险」三节并附依据;「一句话/阶段/目标」改动要他本人拍板。',
    '',
    '- **一句话**:待梳理',
    '- **阶段**:待梳理(可选:市场调研 / 项目策划 / 需求梳理 / MVP 开发 / 上线 / 维护)',
    `- **路径**:${path === undefined ? '待梳理' : `\`${path}\``}`,
    '- **目标**:待梳理',
    '- **截止日**:无',
    '',
    PROGRESS_HEADING,
    `- ${date}:建档(下班例程按项目区扫描生成,内容待事务官梳理核实)`,
    '',
    '## 当前冲刺 / 任务',
    '- 待梳理(任务板里有的话在这里列)',
    '',
    '## 下一步',
    '- 待梳理',
    '',
    '## 关键文件与入口',
    '- 待梳理(README、AGENTS.md、docs、入口脚本)',
    '',
    '## 风险',
    '- 待梳理',
    '',
    '## 历史决定(指向决策记录)',
    '- 无',
    '',
  ].join('\n')
}

export interface IndexActivity {
  name: string
  idle_days: number
  path?: string
}

function activityText(idleDays: number): string {
  return idleDays === 0 ? '今天在动' : `闲置 ${idleDays} 天`
}

/**
 * 项目索引:只改标题里的快照日期与每行的「最近活动」列;没给活动信号的行一字不动;
 * 索引里没有的项目补一行(其余列都是「待梳理」,那是事实——还没人梳理)。
 */
export function updateProjectIndex(text: string, date: string, activities: readonly IndexActivity[]): string {
  const byName = new Map(activities.map(a => [a.name, a]))
  const seen = new Set<string>()
  const lines = text.split('\n').map((line) => {
    if (line.startsWith('# 项目索引')) return `# 项目索引(快照 ${date})`
    if (!line.startsWith('| ')) return line
    const cells = line.split('|').map(c => c.trim())
    // `| a | b |` 切出来首尾各一个空串;正文行第 1 格是项目名。
    const name = cells[1]
    if (name === undefined || name === '项目' || name.startsWith('---')) return line
    const activity = byName.get(name)
    if (activity === undefined) return line
    seen.add(name)
    cells[4] = activityText(activity.idle_days)
    return `| ${cells.slice(1, -1).join(' | ')} |`
  })
  const missing = activities.filter(a => !seen.has(a.name))
  if (missing.length > 0) {
    // 表格在文件末尾;补在最后一个表格行后面。
    let lastRow = -1
    lines.forEach((line, i) => { if (line.startsWith('| ')) lastRow = i })
    const rows = missing.map(a =>
      `| ${a.name} | 待梳理 | 待梳理 | ${activityText(a.idle_days)} | ${a.path === undefined ? '待梳理' : `\`${a.path}\``} | [项目/${a.name}.md](项目/${a.name}.md) |`)
    lines.splice(lastRow + 1, 0, ...rows)
  }
  return lines.join('\n')
}

/** 索引里的一行:项目名、它指向的文件(相对 `docs/记忆/`)、路径列里那个仓库路径。 */
export interface ProjectIndexRow {
  name: string
  /** 「文件」列里那个链接的目标,如 `项目/A.md`。认不出就缺席。 */
  link?: string
  /** 「路径」列里那个仓库路径(反引号已去掉)。「待梳理」当缺席。 */
  path?: string
}

/**
 * 把项目索引的表格行读出来(2026-09-26)。
 *
 * 为什么要读:`updateProjectIndex` 只补行、不建文件 —— 于是索引 15 行、文件 5 个,点进去是空链接
 * (设计文档 §一 3)。下班例程写完索引之后按这份清单**给每一行补一份档**(newProjectFile,内容「待梳理」),
 * 保证索引每一行都链得到文件。**只读不改**,认不出的行直接丢。
 */
export function projectIndexRows(text: string): ProjectIndexRow[] {
  const out: ProjectIndexRow[] = []
  for (const line of text.split('\n')) {
    if (!line.startsWith('| ')) continue
    const cells = line.split('|').map(cell => cell.trim())
    const name = cells[1]
    if (name === undefined || name === '' || name === '项目' || name.startsWith('---')) continue
    // 「文件」列在最后一格:`[项目/A.md](项目/A.md)`;链接写法不标准时这一行就没有 link。
    const link = /\(([^)]+\.md)\)/.exec(cells[cells.length - 2] ?? '')?.[1]
    const rawPath = (cells[5] ?? '').replace(/^`|`$/g, '')
    out.push({
      name,
      ...(link === undefined ? {} : { link }),
      ...(rawPath === '' || rawPath === '待梳理' ? {} : { path: rawPath }),
    })
  }
  return out
}

const HANDWRITTEN_HEADING = '## 每个模块里有什么'
const SOURCES_HEADING = '## 字段来源'

/**
 * 布局记忆文件 = 工作台生成的快照 + 旧文件里手写的「每个模块里有什么」那一节
 * (它量不出来,是人写的知识,docs/记忆/下班例程.md 第 2 步明说保留)。
 * 手写节接在「字段来源」之前;旧文件的其它节(包括过时的「怎么重新生成」)不保留——
 * 那些都是快照能量出来的东西,留两份只会漂。
 */
export function mergeLayoutMemory(generated: string, existing: string | undefined): string {
  if (existing === undefined) return generated
  const hand = sections(existing).find(s => s.heading.startsWith(HANDWRITTEN_HEADING))
  if (hand === undefined) return generated
  const handText = [hand.heading, ...hand.lines].join('\n').replace(/\n+$/, '')
  const at = generated.indexOf(`${SOURCES_HEADING}`)
  if (at === -1) return `${generated.replace(/\n+$/, '')}\n\n${handText}\n`
  return `${generated.slice(0, at)}${handText}\n\n${generated.slice(at)}`
}

/** —— 五、全仓库记忆索引 —— */

export interface MemoryIndexEntry {
  /** 相对 docs/ 的路径。 */
  rel: string
  title: string
  summary: string
  /** 最后提交日 YYYY-MM-DD(没提交过的用今天)。 */
  date: string
}

const INDEX_SECTIONS = [
  '事实与决定(先读)',
  '记忆',
  '记忆·项目',
  '设计',
  '交接(过程)',
  '调研与审计',
  '规格',
  '其它',
  '记忆副本(~/.claude 的镜像)',
  '计划(历史)',
] as const

type IndexSection = typeof INDEX_SECTIONS[number]

const FACT_FILES = ['决策记录.md', '发版记录.md']
const FACT_PREFIXES = ['PRD-', '能力清单-', '全局梳理-']

/** 一个文件归哪一节:按路径与文件名前缀,规则写死在这里,不猜。 */
export function memoryIndexSection(rel: string): IndexSection {
  const base = rel.split('/').pop() ?? rel
  if (rel.startsWith('记忆/项目/')) return '记忆·项目'
  if (rel.startsWith('记忆/')) return '记忆'
  if (rel.startsWith('project-memory/')) return '记忆副本(~/.claude 的镜像)'
  if (rel.startsWith('superpowers/plans/')) return '计划(历史)'
  if (rel.startsWith('superpowers/research/')) return '调研与审计'
  if (rel.startsWith('superpowers/specs/')) return '规格'
  if (base.startsWith('交接-')) return '交接(过程)'
  if (base.startsWith('设计-')) return '设计'
  if (base.startsWith('计划-')) return '计划(历史)'
  if (FACT_FILES.includes(base) || FACT_PREFIXES.some(p => base.startsWith(p))) return '事实与决定(先读)'
  return '其它'
}

/** 标题与一句话:第一个 `# ` 行是标题;第一段非标题、非空的文字是一句话(去掉引用符号,截到 120 字)。 */
export function describeMarkdown(text: string): { title: string, summary: string } {
  let title = ''
  let summary = ''
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '') continue
    if (title === '' && line.startsWith('# ')) { title = line.slice(2).trim(); continue }
    if (line.startsWith('#')) continue
    if (line.startsWith('```') || line.startsWith('---')) continue
    summary = line.replace(/^>\s*/, '').replace(/^[-*]\s+/, '')
    break
  }
  if (summary.length > 120) summary = `${summary.slice(0, 120)}…`
  return { title, summary }
}

export function renderMemoryIndex(entries: readonly MemoryIndexEntry[], date: string): string {
  const out = [
    `# 记忆索引(全仓库 docs 一行一文件;${date} 由下班例程重写)`,
    '',
    '> 读法:先看「事实与决定」,再按问题挑「记忆」「设计」,过程细节才读「交接」。一行 = 文件 — 标题 — 一句话 — 最后提交日。',
    '',
  ]
  for (const section of INDEX_SECTIONS) {
    const rows = entries
      .filter(e => memoryIndexSection(e.rel) === section)
      .sort((a, b) => b.date.localeCompare(a.date) || b.rel.localeCompare(a.rel))
    if (rows.length === 0) continue
    out.push(`## ${section}`)
    for (const row of rows) {
      const parts = [`[docs/${row.rel}](${row.rel})`, row.title === '' ? row.rel : row.title]
      if (row.summary !== '') parts.push(row.summary)
      parts.push(row.date)
      out.push(`- ${parts.join(' — ')}`)
    }
    out.push('')
  }
  return `${out.join('\n')}`
}
