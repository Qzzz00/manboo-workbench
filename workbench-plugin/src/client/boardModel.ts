/**
 * 看板的纯换算(2026-08-25 四层收敛)。**不碰 React、不碰 fetch**——把"这个项目下
 * 有哪些冲刺、这个冲刺有哪些模块泳道、每格里是哪几张卡"算清楚,组件只负责画。
 *
 * 单独一个文件的理由跟 layout.ts 一样:这些规则是真正会出错的地方(归属链断了怎么办、
 * 未归的东西落哪儿),它们要能被直接测,而不是只能透过渲染出来的 DOM 反推。
 */
import type {
  AgentId,
  BoardModule,
  SessionView,
  TaskClientDispatch,
  TaskLink,
  ProjectBoardMeta,
  ScheduleRisk,
  SprintView,
  TaskAssignee,
  TaskDispatch,
  TaskPriority,
  TaskStatus,
  TaskView,
  UsageTotals,
  WorkbenchProject,
} from '../protocol.ts'
import {
  ASSIGNEE_NAMES, billedTokens, CLIENT_DISPATCH_TITLES, DELIVERABLE_TITLES, DISPATCH_FAMILY_TITLES, DISPATCH_HAND_TITLES,
  STATUS_TITLES, TASK_STATUSES, ownerAskOf,
} from '../protocol.ts'

/**
 * 竖列的中文名。顺序即 TASK_STATUSES 的顺序,左→右(2026-09-09 起是七列)。
 *
 * 真身在 protocol.ts:服务端拒绝一次非法转换时也要用同一批中文名说人话,
 * 两边各写一份迟早会漂。这里只是转出去,组件不必知道它来自协议层。
 */
export { STATUS_TITLES }

/**
 * 「在等 Ben 动手」的那两列。看板上做成醒目样式:
 * 「等我确认」是等他验收,「阻塞」是等他解开——其余五列都不需要他此刻做什么。
 */
export const ATTENTION_STATUSES: readonly TaskStatus[] = ['confirm', 'blocked']

/** 优先级的中文名。高/中/低,不用 P0/P1/P2(Ben 不写代码,记不住哪个更急)。 */
export const PRIORITY_TITLES: Record<TaskPriority, string> = {
  high: '高',
  mid: '中',
  low: '低',
}

/**
 * 执行人的显示名。前四个 key 就是 `AgentId`,与 /state.sessions 里那四家同一套标识;
 * 后两个是 2026-09-22 起能被派活的**接口那两家**(GPT / 豆包,它们没有会话流)。
 *
 * 为什么它们也要有名字:卡上的「负责人」那一格现在可能是 `gpt` —— 电话里说一句
 * 「让 GPT 写个文案」就会落成它。少一格的下场是界面上出现一个 `undefined`。
 *
 * 2026-09-25(卡 N):真身挪到 protocol.ts 的 `ASSIGNEE_NAMES`(服务端拼「这张派给 X 开工?」、早报、手机都用同一套),
 * 多了人那三档(你 / 同事 / 别人);事务官叫「事务官」不叫 DSH(不露内部的东西)。可点的那一排见 `ASSIGNEE_PICKER`。
 */
export const ASSIGNEE_TITLES: Readonly<Record<TaskAssignee, string>> = ASSIGNEE_NAMES

/** 卡上那颗「派给 X」/「交给事务官」给什么字 —— 真身在 protocol.ts(手机子集逐字抄一份),这里转出去。 */
export { driveLabel } from '../protocol.ts'

/**
 * 「只是问了一句」的那一张(2026-09-25,卡 Y):**看板主视图上不占位**。
 *
 * 维护者定的:随手问一句、试一下不算一件事 —— 她答完自己把卡收了(服务端一处判据:
 * `server/casualAsk.ts`,盖在卡上的是 `casual` 那一章)。卡与对话都还在盘上、事务官档「办完」那一摞里
 * 点开就是那段对话,**只是不在看板的格子里占一张卡的位置**:他问「一周有几天」三次,
 * 看板不该因此多出三张卡。
 *
 * 只认服务端盖的那一章,客户端**不自己判**(判据两处必漂)。
 */
export function isCasualAskCard(task: Pick<TaskView, 'casual'>): boolean {
  return task.casual === true
}

/** 卡面上那个来源小标。manual 不显示——手敲是常态,标出来只是噪音。 */
export const SOURCE_LABELS: Record<string, string> = {
  note: '随手记',
  session: '会话',
  file: '文件',
}

/** 交付物四类的中文名。真身在协议层(服务端拒绝时也要用同一批字),这里只转出去。 */
export { DELIVERABLE_TITLES }

/**
 * 卡面上那一格:「派给 Claude(窗口)· 已送出」(2026-09-21)。
 *
 * **服务端那份是同一句话**(`server/dispatchClient.ts` 的 `dispatchBadgeText`),
 * 两处各写一份迟早会漂——但客户端不能 import 服务端的文件,所以两边各有一条用例钉住同一串字。
 *
 * 三档:送成了、送成了并且替他按了发送、没送成。**"在跑 / 等确认 / 完成"不在这一格里** ——
 * 那是关联窗口那几个状态点的事(现查会话,不落盘)。这一格只回答"这段话送到哪儿去了"。
 */
/** 派活小标上那三个字。**与服务端 dispatchNote 同源**(都读 DISPATCH_FAMILY_TITLES)。 */
const AGENT_DISPATCH_STATE_TEXT: Readonly<Record<TaskDispatch['status'], string>> = {
  running: '进行中',
  done: '完成',
  failed: '失败',
  // 她取消、当场收场(2026-10-28 任务书):与卡态同一个词,不另造。
  canceled: '取消',
}

/**
 * 命令行 / 接口那两只手的小标(窗口那只手另有 `dispatchBadgeText`,形状不同)。
 *
 * ★ **只有走接口那一只手才把手写进小标**:`派给 GPT(接口)· 完成`。
 *
 * 为什么另外两只不写:Codex 与 Claude 那几家本来就只有一两只手,写了是噪音;
 * 而**接口这一只花的是他今天的模型额度**(窗口那只手花的是他的订阅,命令行那只手也是)——
 * 同一张卡上"派给 GPT"到底扣没扣额度,是他看一眼就该知道的事,值这两个字。
 *
 * 用「接口」不用 "API":界面上不出现英文缩写(DISPATCH_HAND_TITLES 那条老规矩,
 * 目标用户是半专业个体,不认识 CLI/API)。
 */
export function agentDispatchBadgeText(dispatch: TaskDispatch, name?: string): string {
  // 名字:登记表里那一家的(卡 Z:新接上一家,小标上就是它自己的名字);拿不到退回家名那张表,再退回原样。
  const who = name ?? DISPATCH_FAMILY_TITLES[dispatch.family] ?? dispatch.family
  const hand = dispatch.hand === 'api' ? `(${DISPATCH_HAND_TITLES.api})` : ''
  // 卡 O:他停的 / 到时长上限先停下来的,不写「失败」。
  if (dispatch.stopped !== undefined) return `派给 ${who}${hand} · ${dispatch.stopped === 'cap' ? '到上限停下了' : '你停掉了'}`
  return `派给 ${who}${hand} · ${AGENT_DISPATCH_STATE_TEXT[dispatch.status]}`
}

/**
 * 鼠标停一下看到的那一段:走哪只手、在哪个目录里跑的、以及那句原话。
 *
 * **没有工作目录时那一段整个不出现**(接口那只手不碰文件),而不是写一个
 * 「在 undefined 里跑」——那正是这张卡要防的那种编。
 */
/**
 * 那一段开头「怎么做的」(卡 O,09-25 维护者设计原则:界面上不出现「命令行」,按第一次用的人说)。
 * `DISPATCH_HAND_TITLES` 那份还是技能表里给事务官看的叫法,界面上走这一份。
 */
const HAND_PLAIN: Readonly<Record<'cli' | 'window' | 'api', string>> = {
  cli: '在后台做',
  window: '送进它的窗口里做',
  api: `走${DISPATCH_HAND_TITLES.api}`,
}

export function agentDispatchTitle(dispatch: TaskDispatch): string {
  const where = dispatch.cwd === undefined || dispatch.cwd === ''
    ? '(这只手不碰文件,没有工作目录)'
    : `,在 ${dispatch.cwd} 里跑`
  const note = dispatch.note === undefined || dispatch.note === '' ? '' : ` · ${dispatch.note}`
  // 2026-09-24(卡 F):收回来的回答也挂在这里(全文在卡的交付物「回答」里)。
  const reply = dispatch.reply === undefined || dispatch.reply === '' ? '' : `\n它回来的:${dispatch.reply}`
  return `${HAND_PLAIN[dispatch.hand ?? 'cli']}${where}${note}${reply}`
}

export function dispatchBadgeText(dispatch: TaskClientDispatch, name?: string): string {
  const who = name ?? CLIENT_DISPATCH_TITLES[dispatch.family] ?? dispatch.family
  if (dispatch.status === 'failed') return `派给 ${who}(窗口)· 没送成`
  // 2026-09-28(卡 WR):与服务端 dispatchClient.dispatchBadgeText 逐字相同。
  if (dispatch.status === 'typed') return `派给 ${who}(窗口)· 字写进框里了,没发出去`
  // 2026-09-24(卡 F):工作台自己盯着读回答的那几条多三档。老记录没有 reply_state,一字不变。
  if (dispatch.reply_state === 'done') return `派给 ${who}(窗口)· 回来了`
  if (dispatch.reply_state === 'canceled') return `派给 ${who}(窗口)· 取消了,不等它回答`
  if (dispatch.reply_state === 'unreadable') return `派给 ${who}(窗口)· 已发出,结果在 ${who} 里`
  if (dispatch.reply_state === 'waiting') return `派给 ${who}(窗口)· 已发出,等它回答`
  return dispatch.submitted === true ? `派给 ${who}(窗口)· 已送出并发送` : `派给 ${who}(窗口)· 已送出`
}

/**
 * 鼠标停一下看到的那一段:**送出去的原话**,加上没送成时的原因、认上了哪条会话。
 *
 * 原话必须看得见:我们以他的名义往别人的输入框里写了一段字(卡上的规矩第 4 条)。
 */
export function dispatchTitle(dispatch: TaskClientDispatch): string {
  const lines = [`送出去的原话:${dispatch.text}`]
  if (dispatch.status === 'failed' && dispatch.reason !== undefined) lines.push(`没送成:${dispatch.reason}`)
  if (dispatch.reply !== undefined) lines.push(`它回来的:${dispatch.reply}`)
  if (dispatch.reply_note !== undefined) lines.push(dispatch.reply_note)
  if (dispatch.session_id !== undefined) lines.push(`认上的会话:${dispatch.session_id}`)
  else if (dispatch.match_note !== undefined) lines.push(dispatch.match_note)
  return lines.join('\n')
}

/**
 * 「进了『等我确认』,却没有一件可验收的东西」。
 *
 * 借 Multica 的思路:review 的对象是产物,不是状态(竞品调研 2026-09-09)。但**只提示不阻止**
 * ——转换表一个字没改(protocol.ts),挡住这一步等于替 Ben 判断,而"东西还没交、先把卡挂过去"
 * 本来就是合法的一步。也只在这一列提示:别的列没有交付物是常态,处处提示就成了噪音。
 */
export function needsDeliverable(task: TaskView): boolean {
  return task.status === 'confirm' && (task.deliverables ?? []).length === 0
}

/**
 * 这张卡烧掉多少 token:把它关联的会话在 `/state.tasks.session_usage` 里查得到的那几条加起来。
 *
 * **查不到的会话整条跳过,不当 0**(D13):Kimi 订阅制根本不给 token 级数据、日志还没扫到的
 * 会话也查不到,把它们记成 0 会让这个数字看起来精确其实缺斤少两。一条都查不到就返回
 * undefined,界面整段不显示——这比摆一个 0 诚实。口径 = billedTokens(入 + 缓存写 + 出)。
 */
export function cardSpend(
  task: TaskView,
  sessionUsage: Readonly<Record<string, UsageTotals>>,
): number | undefined {
  let sum = 0
  let hit = false
  for (const link of task.links ?? []) {
    const totals = sessionUsage[`${link.agent}:${link.session_id}`]
    if (totals === undefined) continue
    hit = true
    sum += billedTokens(totals)
  }
  return hit ? sum : undefined
}

/** 「10.0 万 token」/「5000 token」。上万才折成万——三千多个 token 写成「0.3 万」反而看不出量级。 */
export function formatSpend(tokens: number): string {
  return tokens >= 10_000 ? `${(tokens / 10_000).toFixed(1)} 万 token` : `${tokens} token`
}

/**
 * 完成格默认铺几张(2026-08-25 Ben 选的"每条泳道只展最近几张")。
 * **按条数,不按时间**——按时间划线就等于代码里存在一个"多久算旧"的判断,
 * 那正是不可改清单第 5 条延伸约束要挡住的东西。
 */
export const DONE_PREVIEW_COUNT = 3

/**
 * 这条关联指向的会话此刻还在不在。**现查,不落盘**——落盘的状态一定会跟真实会话漂移,
 * 然后开始骗人(与 RepoSignals「算」行永不落盘同一条纪律)。查不到就是查不到,如实说。
 */
export function sessionOfLink(sessions: readonly SessionView[], link: TaskLink): SessionView | undefined {
  return sessions.find(session => session.agent === link.agent && session.session_id === link.session_id)
}

/**
 * 距离某个日期还剩几天(负数 = 已经晚了)。**按本地日切齐**再相减,不按 24 小时整除:
 * 今天 23:00 看"明天到期"应该是"剩 1 天",按毫秒算会得到 0.04 天然后取整成 0。
 */
export function daysLeft(date: string, nowMs: number): number {
  const target = new Date(`${date}T00:00:00`)
  if (Number.isNaN(target.getTime())) return 0
  const today = new Date(nowMs)
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate())
  return Math.round((target.getTime() - startOfToday.getTime()) / 86_400_000)
}

/**
 * 一段区间走过了百分之多少(冲刺时间进度条用)。两头缺一个就没有进度可言,返回 undefined
 * ——界面据此不画那根条,而不是画一根从 0 开始的假条。
 */
export function timeProgress(startsAt: string | undefined, endsAt: string | undefined, nowMs: number): number | undefined {
  if (startsAt === undefined || endsAt === undefined) return undefined
  const start = new Date(`${startsAt}T00:00:00`).getTime()
  const end = new Date(`${endsAt}T00:00:00`).getTime()
  if (Number.isNaN(start) || Number.isNaN(end) || end <= start) return undefined
  return Math.min(100, Math.max(0, Math.round(((nowMs - start) / (end - start)) * 100)))
}

/** 顶部那一排项目标签里的一格。 */
export interface ProjectTab {
  id: string | undefined
  name: string
  priority?: TaskPriority
  assignee?: AgentId
  /** 预期结束时间。取项目自己的 DDL(projects.json),看板不存第二份。 */
  due?: string
  /** 排期风险(2026-09-09)。服务端现算的那一份,看板不自己再算一遍。 */
  risk?: ScheduleRisk
  /** 这个项目下所有功能点的条数,标签上直接显示——不点进去也知道哪个项目堆着事。 */
  count: number
}

/** 「未归项目」这一格的固定 id。undefined 表示卡片没有 project_id。 */
export const UNASSIGNED_PROJECT: { id: undefined, name: string } = { id: undefined, name: '未归项目' }

/**
 * 「未归<项目>」那一格的名字(2026-09-21 布局模板)。「项目」在运营模板里叫「账号」,
 * 这一格跟着改口。**不传就是「项目」**,与加模板之前逐字相同。
 */
export function unassignedProjectName(projectWord = '项目'): string {
  return `未归${projectWord}`
}

/**
 * 顶部项目标签(2026-08-25:项目从左侧泳道挪到顶部当标签——四层展开之后左侧那一列
 * 排不开了,Ben 的原话"放到顶部当标签算了")。
 *
 * 「未归项目」那一格**只在真有无主卡片时出现**:顶部横条上的每一格都占着宽度,
 * 常年空着的一格是纯噪音;左侧泳道那版之所以常驻,是因为它还兼着"随手记一条"的入口,
 * 现在那个入口在模块泳道里。
 */
export function buildProjectTabs(
  projects: readonly WorkbenchProject[],
  tasks: readonly TaskView[],
  meta: readonly ProjectBoardMeta[],
  /** 「项目」在当前模板里叫什么(2026-09-21)。**不传就是「项目」**,行为与加它之前逐字相同。 */
  projectWord = '项目',
): ProjectTab[] {
  const countOf = (id: string | undefined): number =>
    tasks.filter(task => (task.project_id ?? undefined) === id).length

  const tabs: ProjectTab[] = projects.map((project) => {
    const mine = meta.find(entry => entry.project_id === project.id)
    return {
      id: project.id,
      name: project.name,
      ...(mine?.priority === undefined ? {} : { priority: mine.priority }),
      ...(mine?.assignee === undefined ? {} : { assignee: mine.assignee }),
      ...(project.ddl === undefined ? {} : { due: project.ddl.date }),
      ...(project.risk === undefined ? {} : { risk: project.risk }),
      count: countOf(project.id),
    }
  })

  const orphans = countOf(undefined)
  if (orphans > 0) tabs.push({ id: undefined, name: unassignedProjectName(projectWord), count: orphans })
  return tabs
}

/** 某个项目下的冲刺,建的时间早的排前面。 */
export function sprintsOf(sprints: readonly SprintView[], projectId: string | undefined): SprintView[] {
  if (projectId === undefined) return []
  return sprints
    .filter(sprint => sprint.project_id === projectId)
    .sort((left, right) => left.created_at.localeCompare(right.created_at))
}

/** 看板上的一条横向泳道 = 一个模块(或那条兜底的「未归模块」)。 */
export interface Lane {
  id: string | undefined
  name: string
  goal?: string
  /** 这条泳道算哪条组成版本(「客户端」「后端」)。看板上显示成版本徽章。 */
  versionLabel?: string
}

export const UNASSIGNED_LANE: Lane = { id: undefined, name: '未归模块' }

/**
 * 泳道清单:选中冲刺下的模块 + 末尾一条「未归模块」。
 *
 * 「未归模块」**永远在**,跟顶部那排标签的规矩相反——它是三种东西的落脚点:
 * v1 旧存档里那些还没分模块的卡、删掉冲刺/模块之后退回来的卡、以及"先记一条再说"
 * 的随手输入。少了它,那些卡就会从界面上消失(数据还在文件里),那是最坏的一种 bug:
 * 看起来像被系统清理掉了,而这块界面恰恰是不许有清理动作的。
 */
export function buildLanes(modules: readonly BoardModule[], sprintId: string | undefined): Lane[] {
  const mine = sprintId === undefined
    ? []
    : modules
        .filter(module => module.sprint_id === sprintId)
        .sort((left, right) => left.created_at.localeCompare(right.created_at))
        .map(module => ({
          id: module.id,
          name: module.name,
          ...(module.goal === undefined ? {} : { goal: module.goal }),
          ...(module.version_label === undefined ? {} : { versionLabel: module.version_label }),
        }))
  return [...mine, UNASSIGNED_LANE]
}

/**
 * 这条泳道里一张卡都没有(任何状态都算,取消的也算 —— 那也是一张卡)。
 * 空的模块泳道收成一行(名字 + 记一条),不画七个空格子(2026-09-25,卡 N)。
 */
export function laneIsEmpty(
  tasks: readonly TaskView[],
  modules: readonly BoardModule[],
  projectId: string | undefined,
  lane: Lane,
): boolean {
  return TASK_STATUSES.every(status => tasksInCell(tasks, modules, projectId, lane, status).length === 0)
}

/**
 * 真要画出来的泳道(2026-09-25,卡 N;维护者:「底部还有什么未归类模块,都没有内容为什么还要显示」)。
 *
 * 「未归模块」只在两种时候画:这个项目里真有没归模块的卡(它们得有地方待着,不许从界面上消失);
 * 或者这个冲刺一个模块都没有(那时它是唯一记一条的地方)。其余时候空着的它不画 —— 以前它「永远在」,
 * 理由是兜住没归模块的卡与随手记一条;前一样现在照兜(有卡就画),后一样每个模块泳道里都有「记一条」。
 */
export function visibleLanes(
  lanes: readonly Lane[],
  tasks: readonly TaskView[],
  modules: readonly BoardModule[],
  projectId: string | undefined,
): Lane[] {
  const named = lanes.filter(lane => lane.id !== undefined)
  return lanes.filter(lane => lane.id !== undefined || named.length === 0 || !laneIsEmpty(tasks, modules, projectId, lane))
}

/**
 * 落进「当前项目 × 这条泳道 × 这一列」的卡。
 *
 * 「未归模块」那条泳道收两种卡:压根没有 module_id 的,以及 module_id 指向一个
 * **已经不存在的模块**的(归属链断了)。后一种如果不接住,卡会从界面上凭空消失。
 */
export function tasksInCell(
  tasks: readonly TaskView[],
  modules: readonly BoardModule[],
  projectId: string | undefined,
  lane: Lane,
  status: TaskStatus,
): TaskView[] {
  const knownModules = new Set(modules.map(module => module.id))
  const picked = tasks.filter((task) => {
    if (isCasualAskCard(task)) return false
    if ((task.project_id ?? undefined) !== projectId) return false
    if (task.status !== status) return false
    const moduleId = task.module_id !== undefined && knownModules.has(task.module_id) ? task.module_id : undefined
    return moduleId === lane.id
  })

  // 完成格按最后改动倒序(最近完成的在最上面),其余三列保持记录顺序。
  // **只用来排序,不用来判断新旧**:没有任何一条分支会因为"旧"而隐藏、变灰或提示什么。
  return status === 'done'
    ? [...picked].sort((left, right) => right.updated_at.localeCompare(left.updated_at))
    : picked
}

/** 冲刺进度:这个冲刺下(含未归模块里属于本项目的卡)完成了几条、共几条。纯计数,不做任何判断。 */
export function sprintProgress(
  tasks: readonly TaskView[],
  modules: readonly BoardModule[],
  projectId: string | undefined,
  sprintId: string | undefined,
): { done: number, total: number } {
  const mine = new Set(modules.filter(module => module.sprint_id === sprintId).map(module => module.id))
  const scoped = tasks.filter(task => (task.project_id ?? undefined) === projectId
    && task.module_id !== undefined && mine.has(task.module_id))
  return countProgress(scoped)
}

/** 一条泳道自己的完成度(几条完成 / 共几条)。纯计数,不做任何判断。 */
export function laneProgress(
  tasks: readonly TaskView[],
  modules: readonly BoardModule[],
  projectId: string | undefined,
  lane: Lane,
): { done: number, total: number } {
  const all = TASK_STATUSES.flatMap(status => tasksInCell(tasks, modules, projectId, lane, status))
  return countProgress(all)
}

/**
 * 几条完成 / 共几条。**取消掉的卡不进分母**(2026-09-09 七态):「不做了」的事拉低完成率
 * 是在骗人,而这块界面只被允许陈述事实。仍然只是计数,不做任何评价。
 */
function countProgress(scoped: readonly TaskView[]): { done: number, total: number } {
  const counted = scoped.filter(task => task.status !== 'canceled')
  return { done: counted.filter(task => task.status === 'done').length, total: counted.length }
}

/**
 * 「现在有几件在等我动手」:等我确认几条、阻塞几条。冲刺条上常显,免得他挨列去数。
 * 纯计数,不提任何建议(不可改清单第 5 条延伸)。
 * 「等我确认」只数带四类拍板请求的(2026-10-26 卡「事务官页接管队列」;判据 `ownerAskOf`,
 * 与服务端「等你」堆、协作区「现在等你」同一处)——没带的是事务官待核验队列,不算等他动手。
 */
export function attentionCounts(
  tasks: readonly TaskView[],
  projectId: string | undefined,
): { confirm: number, blocked: number } {
  const mine = tasks.filter(task => (task.project_id ?? undefined) === projectId)
  return {
    confirm: mine.filter(task => ownerAskOf(task) !== undefined).length,
    blocked: mine.filter(task => task.status === 'blocked').length,
  }
}

/**
 * 「按状态」那个列轴用:某个项目下、某个状态的全部卡,不分模块泳道。
 *
 * 与 tasksInCell 的区别只在少了泳道那一维——那一维在这个方向上没有意义:
 * 这一屏回答的是"现在各状态各有几件",不是"哪个模块推到哪儿了"。
 * 完成列同样按最后改动倒序,理由与 tasksInCell 逐字相同。
 */
export function tasksInStatus(
  tasks: readonly TaskView[],
  projectId: string | undefined,
  status: TaskStatus,
): TaskView[] {
  const picked = tasks.filter(task => !isCasualAskCard(task) && (task.project_id ?? undefined) === projectId && task.status === status)
  return status === 'done'
    ? [...picked].sort((left, right) => right.updated_at.localeCompare(left.updated_at))
    : picked
}
