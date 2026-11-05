/**
 * **每件事的花费 / 时长上限,与「停掉这一件」**(2026-09-25,卡 O;设计第一节第 6 条)。
 *
 * 维护者:「让事务官自己改代码太坑了,一个显示问题修了半小时,还没修好」。那一件(事项 t-a8934b2a)
 * DSH 会话 37 分钟、120 次模型、约 1.6 元,按这个速度一个半小时就烧完当天 5 元额度 —— 之后她整天答不了话、
 * 电话也接不了;而工作台外层**没有**「停掉这一件」,只能到底层 DSH 页按停止键。
 *
 * 现在:
 *
 * ★ **2026-10-04:上限只看钱**(维护者拍板,经工作台捎话「开」;为什么、那次事故、与 10-02 的关系,
 * 整段写在 `budgetPolicy.ts` 文件头)。**步数那条线(`BUTLER_STEP_LIMIT = 15`)整条去掉了** ——
 * 10-04 早她在手机上让它发一份文件,三轮全是撞**步数**线停的,钱远没到。时间那条线**保留现状**,
 * 去不去是一处开关:`budgetPolicy.BUDGET_MINUTES_LINE`。
 *
 * - **每件事一个上限**(默认 0.5 元、10 分钟,先到哪个算哪个;两个数都在设置里可改,
 *   存 `~/.dsh/workbench/budget.json`)。
 *   只管**事务官自己在办**的那几件(卡上挂着一条 DSH 会话);派给别家的活花的是那家的额度,不在这里算。
 * - **钱**:那条会话自己的 token × 工作台模型服务的价目 —— 与中转 `relay/server/pricing.cjs` **同一套算法**
 *   (缓存命中 / 未命中 / 输出三档,按高峰价,认不出的 DeepSeek 名字按 Pro,宁可多算)。
 * - **时间**:那条会话**在跑**的时间(一回合开始到结束;等他批的那一段不算)。
 * - **到了**:先停(`sessionController.cancel` —— 就是 DSH 底层页右下那颗停止键用的那一个),卡挂「阻塞 · 等你输入」,
 *   在外层问他:**继续**(再给一档,到了再问)/ **停掉这一件** / **换 X 来做**(按规矩挑写代码的那家)。
 *   问法走卡 M 那套外层卡(`OuterAsker`,没接时卡上三颗键);两边哪边先答算哪边。
 *   ★ 那一问里**带着「卡在哪」那半句与已经花了多少钱**(2026-10-04 第 2 条):卡在哪由事务官自己报
 *   (`POST /butler/item/stuck` → {@link ItemBudget.stuck} → `budget.stuck`),没报就照实说「它没说卡在哪」。
 * - **撞线记一条**(2026-10-04 第 3 条):{@link ItemBudgetDeps.onLimit} 往现成的那本任务账上追
 *   一条 `budget_stop`(`jobLog.ts`)。**不自动调高线**;同一类事反复撞线由日结提一句
 *   (`budgetPolicy.budgetRepeatLine`)。
 * - **停掉这一件**(外层那颗键):事务官自己在办的 → 停那条 DSH 会话;派给别家命令行的 → 杀那个进程;
 *   派进窗口的 → 不再等它的回答(那家窗口里那一句我们停不了,如实说)。卡回「待办」,写清花了多少。
 *
 * 停下来那一刻 DSH 会报一次「这一回合被停了」(turn/end aborted),事项生命周期(`butlerLifecycle.ts`)
 * 默认会把卡挪回待办、写「你停了它」—— 这里先登记「这一次是我停的、该去哪、写什么」(`expectedAbort`),
 * 生命周期那一层照这张单子办,不会把「到上限了,等你说」盖成「你停了它」。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { AgentDispatchFamily, ItemBudgetConfig, TaskBudgetView, TaskStatus, TaskView, WaitReason } from '../protocol.ts'
import { DEFAULT_ITEM_BUDGET, DISPATCH_FAMILY_TITLES } from '../protocol.ts'
import type { DshSessionUsage, DshTokenUsage } from './dshSessionFeed.ts'
import type { TasksService } from './tasks.ts'
import type { BudgetLine } from './budgetPolicy.ts'
import { BUDGET_MINUTES_LINE, budgetAskLine, yuan } from './budgetPolicy.ts'

export { yuan } from './budgetPolicy.ts'

// ───────────────────────── 价目(与中转同一套)─────────────────────────

/**
 * 元 / 百万 tokens,[缓存命中, 缓存未命中, 输出]。**与 `relay/server/pricing.cjs` 的 DEFAULT_PRICES_CNY 逐字相同**
 * (DeepSeek 官方高峰价,2026-09-23 核对)—— 工作台模型服务按它记账,这里按它估,两边不许不一样
 * (`tests/server-item-budget.test.ts` 读那份文件钉着)。
 */
export const ITEM_PRICES_CNY: Readonly<Record<'deepseek-flash' | 'deepseek-pro', readonly [number, number, number]>> = {
  'deepseek-flash': [0.04, 2, 8],
  'deepseek-pro': [0.3, 9, 27],
}

/** 模型名 → 价目档。只有明写 flash 的按 Flash 价,别的一律按 Pro(同中转:宁可多算)。 */
export function priceTierOfModel(model: string | undefined): 'deepseek-flash' | 'deepseek-pro' {
  return (model ?? '').toLowerCase().includes('flash') ? 'deepseek-flash' : 'deepseek-pro'
}

/**
 * 一条会话到现在花了约多少元。缓存命中按命中价、没命中(含缓存写)按未命中价、输出按输出价。
 * 没有 token 数就 undefined(不编一个 0 出来)。
 */
export function costCnyOf(usage: DshTokenUsage | undefined, model: string | undefined): number | undefined {
  if (usage === undefined) return undefined
  const n = (value: number | undefined): number => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0)
  const [hit, miss, output] = ITEM_PRICES_CNY[priceTierOfModel(model)]
  const micro = n(usage.cacheReadTokens) * hit + (n(usage.uncachedInputTokens) + n(usage.cacheWriteTokens)) * miss + n(usage.outputTokens) * output
  return Math.ceil(micro - 1e-9) / 1_000_000
}

// ───────────────────────── 配置(设置里改的那两个数)─────────────────────────

export function defaultBudgetFile(home: string): string {
  return join(home, '.dsh', 'workbench', 'budget.json')
}

/**
 * 只读上限里的钱那一格(元)。卡 N 的进度评估、卡 T 的「在等你」判断都要它,三张卡同一份设置、同一个键
 * (合并卡 W 09-25 收成一份:原来 `progress.ts`、`waitingService.ts` 各有一份一模一样的)。读不到按缺省 0.5 元。
 */
export async function readBudgetCny(file: string, fallback = 0.5): Promise<number> {
  try {
    const raw = JSON.parse(await readFile(file, 'utf8')) as { cny?: unknown }
    return typeof raw.cny === 'number' && Number.isFinite(raw.cny) && raw.cny > 0 ? raw.cny : fallback
  }
  catch { return fallback }
}

/** 形状不对的一律退回默认(上限配坏了宁可按默认停,不许变成「不设上限」)。 */
export function parseBudgetConfig(raw: unknown): ItemBudgetConfig {
  const obj = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  const cny = typeof obj.cny === 'number' && Number.isFinite(obj.cny) && obj.cny > 0 && obj.cny <= 100 ? obj.cny : DEFAULT_ITEM_BUDGET.cny
  const minutes = typeof obj.minutes === 'number' && Number.isFinite(obj.minutes) && obj.minutes >= 1 && obj.minutes <= 24 * 60 ? Math.round(obj.minutes) : DEFAULT_ITEM_BUDGET.minutes
  return { cny: Math.round(cny * 100) / 100, minutes }
}

export interface BudgetStore {
  get: () => ItemBudgetConfig
  load: () => Promise<ItemBudgetConfig>
  save: (next: unknown) => Promise<{ ok: true, value: ItemBudgetConfig } | { ok: false, error: string }>
}

export function createBudgetStore(file: string): BudgetStore {
  let current: ItemBudgetConfig = { ...DEFAULT_ITEM_BUDGET }
  return {
    get: () => current,
    async load() {
      try { current = parseBudgetConfig(JSON.parse(await readFile(file, 'utf8'))) }
      catch { current = { ...DEFAULT_ITEM_BUDGET } }
      return current
    },
    async save(next) {
      const obj = (typeof next === 'object' && next !== null ? next : {}) as Record<string, unknown>
      const cny = obj.cny
      const minutes = obj.minutes
      if (typeof cny !== 'number' || !Number.isFinite(cny) || cny <= 0 || cny > 100) return { ok: false, error: '钱的上限要是 0 到 100 元之间的数' }
      if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes < 1 || minutes > 24 * 60) return { ok: false, error: '时间上限要是 1 到 1440 分钟之间的数' }
      const value = parseBudgetConfig({ cny, minutes })
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
      current = value
      return { ok: true, value }
    },
  }
}

// ───────────────────────── 判:到没到 ─────────────────────────

/*
 * ★ **步数那条线 2026-10-04 整条去掉了**(`BUTLER_STEP_LIMIT = 15`,2026-09-28 卡 BS2 加的)。
 *
 * 为什么:10-04 早维护者在手机上让事务官发一份文件,三轮全是撞**步数**线停的 ——
 * 第一轮 14 步在 grep 源码找路、第 15 步撞线,她点继续 → 30 步又撞、再点 → 45 步才办完。
 * **钱一次都没到**。维护者 09-23 的尺子是「用户不在乎一通电话花了多少 Tokens,只在乎花了多少钱」:
 * 步数是我们的内部度量,不该变成她眼前的闸。止损这件事交还给**钱**那条线。整段在 `budgetPolicy.ts` 文件头。
 *
 * 落盘里老卡上那一格 `TaskBudgetView.limit_steps` **读得懂、不再用**(`tasks.ts` 的 `sanitizeBudget`
 * 照旧收它,老数据不坏),但这一侧既不判它、也不再往卡上写它。
 *
 * 「走了 N 步」照旧写在卡上那一句里({@link spentLine}) —— 那是**事实**,不是闸。
 */

export interface BudgetVerdict {
  view: TaskBudgetView
  over: boolean
  /** 到了的话是哪一样到了(「花了约 0.52 元」/「跑了 11 分钟」)。 */
  why?: string
  /** 撞的哪条线(账上记这一格)。没到就缺席。 */
  line?: BudgetLine
}

/** 这张卡是事务官自己在办的吗(挂着 DSH 会话、没办完)。 */
export function butlerOwned(task: TaskView): boolean {
  return task.conversation?.session_id !== undefined && task.status !== 'done' && task.status !== 'canceled'
}

/**
 * 一件事此刻的上限视图 + 到没到。纯函数。
 * 上限:卡上记着的(他说过继续就加过档)优先,没有就用设置里的。
 */
export function budgetVerdict(task: TaskView, config: ItemBudgetConfig, usage: DshSessionUsage | undefined): BudgetVerdict {
  const stored = task.budget
  const limitCny = stored?.limit_cny ?? config.cny
  const limitMinutes = stored?.limit_minutes ?? config.minutes
  const spent = costCnyOf(usage?.tokenUsage, usage?.model)
  const minutes = usage === undefined ? undefined : Math.floor(usage.run_ms / 60_000 * 10) / 10
  const view: TaskBudgetView = {
    limit_cny: limitCny,
    limit_minutes: limitMinutes,
    // ★ 2026-10-04:`limit_steps` **不再往视图里写**(老卡上有这一格也不读进来)—— 那条线不存在了。
    ...(spent === undefined ? (stored?.spent_cny === undefined ? {} : { spent_cny: stored.spent_cny }) : { spent_cny: spent }),
    ...(minutes === undefined ? (stored?.run_minutes === undefined ? {} : { run_minutes: stored.run_minutes }) : { run_minutes: minutes }),
    ...(usage === undefined ? (stored?.requests === undefined ? {} : { requests: stored.requests }) : { requests: usage.steps }),
    ...((usage?.model ?? stored?.model) === undefined ? {} : { model: (usage?.model ?? stored?.model) as string }),
    state: stored?.state ?? 'running',
    ...(stored?.extended === undefined ? {} : { extended: stored.extended }),
    ...(stored?.note === undefined ? {} : { note: stored.note }),
    ...(stored?.paused_at === undefined ? {} : { paused_at: stored.paused_at }),
    ...(stored?.switch_to === undefined ? {} : { switch_to: stored.switch_to }),
    ...(stored?.cli_family === undefined ? {} : { cli_family: stored.cli_family }),
    // 事务官自己报的「卡在哪」(2026-10-04):原样带着,问她那一句里要用它。
    ...(stored?.stuck === undefined ? {} : { stuck: stored.stuck }),
    ...(stored?.stuck_at === undefined ? {} : { stuck_at: stored.stuck_at }),
  }
  if (view.state !== 'running') return { view, over: false }
  // 命令行那一种(统筹拍板 ③)的时间由派活那一层按那个进程起的时刻算,这里不按事务官那条会话算。
  if (view.cli_family !== undefined) return { view, over: false }
  // ★ 2026-10-04:**钱排第一,而且只剩它与时间两条**(步数那条整条去掉了,见上面那段)。
  if (spent !== undefined && spent >= limitCny) return { view, over: true, why: `花了约 ${yuan(spent)} 元`, line: 'money' }
  // 时间那条线**保留现状**;要去掉它只改 `budgetPolicy.BUDGET_MINUTES_LINE` 那一个值(就这一处读它)。
  if (BUDGET_MINUTES_LINE && minutes !== undefined && minutes >= limitMinutes) return { view, over: true, why: `跑了 ${Math.floor(minutes)} 分钟`, line: 'time' }
  return { view, over: false }
}

/**
 * 卡上那一句「花了约 0.52 元 · 跑了 11 分钟 · 走了 15 步(上限 0.5 元 / 10 分钟)」。
 *
 * 「走了 N 步」留着 —— 它是**事实**(她在屏幕上看得到花了多少、跑了多久、走了几步);
 * 上限那一串里 2026-10-04 起**没有步数**:那条线不存在了,写上去就是骗她还有一条闸。
 */
export function spentLine(view: TaskBudgetView): string {
  const parts = [
    view.spent_cny === undefined ? '' : `花了约 ${yuan(view.spent_cny)} 元`,
    view.run_minutes === undefined ? '' : `跑了 ${Math.floor(view.run_minutes)} 分钟`,
    view.requests === undefined ? '' : `走了 ${view.requests} 步`,
  ].filter(one => one !== '')
  const limits = [`${view.limit_cny} 元`, ...(BUDGET_MINUTES_LINE ? [`${view.limit_minutes} 分钟`] : [])]
  return `${parts.length === 0 ? '还没算出花了多少' : parts.join(' · ')}(上限 ${limits.join(' / ')})`
}

// ───────────────────────── 外层问他(卡 M 那套)─────────────────────────

/**
 * 外层提问的端口。**形状照卡 M 的 `QuestionBroker.ask` 抄**(`server/butlerAsks.ts`,它合进来之后直接把它传进来):
 * 挂一问,电脑球下那张卡 + 手机「等你确认」一行,他答了 resolve;`signal` 取消就以 cancelled 收场。
 */
export interface OuterAsker {
  ask: (req: {
    sessionId: string
    questions: readonly { id: string, question: string, header?: string, detail?: string, options?: readonly { label: string, description?: string }[] }[]
    signal?: AbortSignal
    /**
     * 这一问**第一次**问他是什么时候(`QuestionBroker.ask` 的同名可选项,卡 U8 加的)。
     * 只有重启后照卡上那一格挂回来的那一问传它(= `budget.paused_at`);不传就是现在。
     */
    at?: string
  }) => { id: string, answer: Promise<{ kind: 'answer', answers: readonly { id: string, selected: readonly string[], custom?: string }[] } | { kind: 'cancelled' }> }
}

/**
 * ★ **「到上限了」那一问的 id**(2026-10-13,卡 C 提出来当常量)。
 *
 * 挂出去、认回答、以及 `/asks/voice` 上那道「只能选一项」的门(见 {@link CHOICE_ONLY_ASK_IDS})
 * 都认这一个字符串,三处别各写一遍。
 */
export const BUDGET_ASK_ID = 'budget'

/**
 * ★ **「只能选一项」的那几问**(2026-10-13 下午,卡 C;验收交接第三节第 19 条)。
 *
 * 这几问的下游**只认那几个选项**(「到上限了」那一问靠 {@link budgetChoiceOf} 认,
 * 认不出就一个动作都不发生)。于是电话里「我自己说」那一档对它们是一句空话:
 * `/asks/voice` 回 ok、她说「替你选上了」,而那件事仍然停着 —— 14:3x 那一通正是这样。
 *
 * 所以 `/asks/voice` 对这几问**听不出是哪一项就 400**(工人照 `askElsewhereSay` 说
 * 「这一问得在电脑上答」)。要加第二种问,加进这张表、并在那一问的下游写明它怎么认回答。
 */
export const CHOICE_ONLY_ASK_IDS: readonly string[] = [BUDGET_ASK_ID]

/** 这一问是不是「只能选一项」的那几种(见 {@link CHOICE_ONLY_ASK_IDS})。 */
export function choiceOnlyAsk(id: string | undefined): boolean {
  return id !== undefined && CHOICE_ONLY_ASK_IDS.includes(id)
}

export type BudgetChoice = 'continue' | 'stop' | 'switch'

export const BUDGET_CHOICE_LABELS: Readonly<Record<Exclude<BudgetChoice, 'switch'>, string>> = {
  continue: '继续',
  stop: '停掉这一件',
}

/** 外层那一问的选项名 → 选择。认不出回 undefined(「我自己说」那一种交给她读)。 */
export function budgetChoiceOf(label: string | undefined): BudgetChoice | undefined {
  if (label === undefined) return undefined
  if (label === BUDGET_CHOICE_LABELS.continue) return 'continue'
  if (label === BUDGET_CHOICE_LABELS.stop) return 'stop'
  if (label.startsWith('换 ') && label.endsWith(' 来做')) return 'switch'
  return undefined
}

// ───────────────────────── 服务 ─────────────────────────

/** 这一次是我们停的:会话报「被停了」时,生命周期照这张单子办,不写「你停了它」。 */
export interface ExpectedAbort {
  status: TaskStatus
  note: string
  blockReason?: WaitReason
}

export interface ItemBudgetDeps {
  tasks: Pick<TasksService, 'list' | 'update' | 'move'>
  config: () => ItemBudgetConfig
  usage: (sessionId: string) => DshSessionUsage | undefined
  /**
   * 停掉那条会话正在跑的这一回合(生产:`sessionController.cancel({ sessionId })`,DSH 底层页右下那颗停止键用的就是它)。
   * 回 `running:false` = 那条会话这会儿本来就没在跑(没有要停的)。缺席 = 停不了(老宿主),如实说。
   */
  cancelSession?: (sessionId: string) => Promise<{ ok: boolean, running?: boolean, why?: string }>
  /** 往那条会话里再说一句(他说「继续」时)。 */
  say?: (sessionId: string, text: string) => Promise<boolean>
  /** 卡 M 的外层提问。缺席 = 只挂卡上那三颗键。 */
  asker?: OuterAsker
  /** 「换 X 来做」那一家(卡 O 的挑手:写代码的活按规矩挑;`exclude` = 不要这一家,命令行那件换一家时用)。拿不到就不给这个选项。 */
  switchCandidate?: (taskId: string, exclude?: AgentDispatchFamily) => Promise<{ family: AgentDispatchFamily, title: string, note?: string } | undefined>
  /**
   * 派给那家命令行的活到时长上限停下来了,他说「继续」:再派一次、接着做(同一个目录;统筹拍板 ③)。
   * 缺席 = 接不上(如实说)。
   */
  resumeCli?: (taskId: string, family: AgentDispatchFamily) => Promise<{ ok: boolean, note: string }>
  /** 真换过去(卡 O 的派活:`dispatchItem(…, { kind })`)。 */
  switchTo?: (taskId: string, family: AgentDispatchFamily) => Promise<{ ok: boolean, note: string }>
  /** 杀一个派活子进程(命令行那只手)。 */
  killPid?: (pid: number) => void
  now: () => Date
  onChanged?: () => void
  /** 多久看一眼(只在有会话在跑时转)。缺省 15 秒。 */
  pollMs?: number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
  /** 过一会儿再做一次(停了会话却一直没等到「被停了」那一下时兜底)。缺省 setTimeout。 */
  later?: (fn: () => void, ms: number) => void
  /**
   * **撞线了,记一条**(2026-10-04 第 3 条)。生产接的是现成的那本任务账
   * (`jobLog.append({ step: 'budget_stop', … })`,见 `server/http.ts` 那一处接线)——
   * **不另起一个数据库**。这里只报事实,「哪类事」由接线那一侧按标题现判(`dispatchChoice.jobKindOf`)。
   *
   * 缺席 = 这台工作台没接那本账(用例 / 老宿主):照旧停、照旧问,只是没人记 —— 不拦停。
   */
  onLimit?: (input: { taskId: string, title: string, line: BudgetLine, why: string, stuck?: string }) => void
}

export interface ItemBudget {
  /** 一张卡此刻的上限视图(/state 组装用;不是事务官自己在办的回 undefined)。 */
  viewOf: (task: TaskView) => TaskBudgetView | undefined
  /** 看一眼所有事务官自己在办的,到了就停下来问。回这一拍停了几件。**绝不抛**。 */
  tick: () => Promise<number>
  /** 会话动了一下(DSH feed 的 onActivity):马上看一眼,并确保计时器在转。 */
  nudge: (sessionId: string) => void
  /** 他答了那一问(外层卡 / 卡上的键)。 */
  choose: (taskId: string, choice: BudgetChoice) => Promise<{ ok: boolean, note: string }>
  /**
   * **事务官报「我卡在哪」**(2026-10-04 第 2 条;`POST /butler/item/stuck`)。
   *
   * 它在干活的过程里随时报一句(「我在找 X,试了 A、B,还差 C」),记在这件事的上限那一格上;
   * 撞线停下来时工作台把它原样放进问她那一句里。**只记最后一句**(卡上只放得下一句,
   * 而她要的是「现在卡在哪」,不是一本日记)。空字符串 = 撤掉(它自己说清不卡了)。
   *
   * 不是事务官自己在办的那几件没有这一格(回 `ok:false`,如实说)。
   */
  stuck: (taskId: string, text: string) => Promise<{ ok: boolean, note: string }>
  /** 外层「停掉这一件」。 */
  stopItem: (taskId: string) => Promise<{ ok: boolean, note: string, status?: number }>
  /** 生命周期问:这一次「被停了」是我们停的吗(是就回该去哪、写什么,并销掉这张单子)。 */
  expectedAbort: (sessionId: string) => ExpectedAbort | undefined
  /**
   * 起服务时把重启前「到上限了,先停下来了」那几问**原样挂回**外层(2026-09-26;跟卡 U8 进度那几问同一个形状)。
   * 账已经在卡上(`budget.state === 'paused'` + `note` + `paused_at`),不另落文件;只读看板一眼、只挂问 ——
   * 不停会话、不写卡、不重算到没到。回挂回了几问;只跑一次,再叫是空操作。**绝不抛**。
   */
  resume: () => Promise<number>
  stop: () => void
}

export function createItemBudget(deps: ItemBudgetDeps): ItemBudget {
  const pollMs = deps.pollMs ?? 15_000
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => setInterval(fn, ms))
  const clearTimer = deps.clearTimer ?? ((handle: unknown) => clearInterval(handle as ReturnType<typeof setInterval>))
  const later = deps.later ?? ((fn: () => void, ms: number) => { setTimeout(fn, ms) })
  const aborts = new Map<string, ExpectedAbort>()
  const asks = new Map<string, AbortController>()
  let timer: unknown
  /** 正在跑的那一拍。再叫一次就等同一拍(会话动静与计时器同时来时,叫的人拿到的是算完的那一拍,不是一句「正忙」)。 */
  let inflight: Promise<number> | undefined

  function changed(): void {
    try { deps.onChanged?.() } catch { /* 推快照失败不连累上限 */ }
  }

  async function findTask(id: string): Promise<TaskView | undefined> {
    try { return (await deps.tasks.list()).tasks.find(one => one.id === id) }
    catch { return undefined }
  }

  async function moveTo(id: string, status: TaskStatus): Promise<void> {
    const first = await deps.tasks.move(id, status)
    if (first.ok) return
    if (status !== 'doing') {
      const via = await deps.tasks.move(id, 'doing')
      if (via.ok) await deps.tasks.move(id, status)
    }
  }

  function ensureTimer(): void {
    if (timer !== undefined) return
    timer = setTimer(() => { void tick() }, pollMs)
  }

  /** 照「这一次是我们停的」那张单子把卡挪好、写好。 */
  async function applyAbort(taskId: string, expect: ExpectedAbort): Promise<void> {
    const task = await findTask(taskId)
    if (task === undefined || task.status === 'done' || task.status === 'canceled') return
    await deps.tasks.update(taskId, { note: expect.note })
    if (task.status !== expect.status) await moveTo(taskId, expect.status)
    if (expect.blockReason !== undefined) await deps.tasks.update(taskId, { blockReason: expect.blockReason })
  }

  /**
   * 停那条会话正在跑的这一回合,并登记「这一次是我们停的」(生命周期收到「被停了」时照单子办)。
   * 没在跑 / 停不了 → 不会有那一下,当场自己把卡挪好;停成了但 5 秒内没等到那一下 → 兜底自己挪。
   */
  async function haltSession(taskId: string, sessionId: string, expect: ExpectedAbort): Promise<{ stopped: boolean, why?: string }> {
    aborts.set(sessionId, expect)
    let result: { ok: boolean, running?: boolean, why?: string } = { ok: false, why: '这台工作台停不了 DSH 会话' }
    try { result = await deps.cancelSession?.(sessionId) ?? result }
    catch (error) { result = { ok: false, why: error instanceof Error ? error.message : String(error) } }
    if (!result.ok || result.running === false) {
      if (aborts.get(sessionId) === expect) aborts.delete(sessionId)
      await applyAbort(taskId, expect)
      return { stopped: false, ...(result.ok ? {} : { why: result.why ?? '没停成' }) }
    }
    later(() => {
      if (aborts.get(sessionId) !== expect) return
      aborts.delete(sessionId)
      void applyAbort(taskId, expect).then(changed).catch(() => undefined)
    }, 5000)
    return { stopped: true }
  }

  function viewOf(task: TaskView): TaskBudgetView | undefined {
    if (!butlerOwned(task) && task.budget === undefined) return undefined
    const sessionId = task.conversation?.session_id
    return budgetVerdict(task, deps.config(), sessionId === undefined ? undefined : deps.usage(sessionId)).view
  }

  /**
   * 把「到上限了」那一问挂到外层(卡 M 那套):电脑球下那张卡 + 手机「等你确认」一行,他答了走 `choose(…, { fromAsk })`。
   * 停下来那一刻挂一次(`pause`);重启后照卡上那一格再挂一次(`resume`,`at` = 第一次停下来的时刻)。
   * 回挂没挂出去(没接外层 / 外层问不出去 → 只有卡上那三颗键)。
   */
  function hangAsk(task: TaskView, sessionId: string, ask: string, candidate: { title: string, note?: string } | undefined, at?: string): boolean {
    if (deps.asker === undefined) return false
    const controller = new AbortController()
    asks.get(task.id)?.abort()
    asks.set(task.id, controller)
    const options = [
      /*
       * ★ 2026-10-02(卡「语音交代慢与老问上限」):选项上那一句**不再念消耗额度**
       * (「再给 0.5 元 / 10 分钟 / 15 步」)。她的原话:播报消耗额度这种比较多余。
       * 花了多少照旧在卡上(`spentLine` 写进 `budget.note` 与卡面 note),看得到 ≠ 念给她听。
       */
      { label: BUDGET_CHOICE_LABELS.continue, description: '接着做' },
      { label: BUDGET_CHOICE_LABELS.stop, description: '卡回「待办」,改过的东西留着' },
      ...(candidate === undefined ? [] : [{ label: `换 ${candidate.title} 来做`, ...(candidate.note === undefined ? {} : { description: candidate.note }) }]),
    ]
    try {
      const asked = deps.asker.ask({
        sessionId,
        // `ask` 已经是**整一句**(`budgetPolicy.budgetAskLine`,带着她那件事的标题):这里不再往前拼一遍标题。
        questions: [{ id: BUDGET_ASK_ID, header: '到上限了', question: ask, options }],
        signal: controller.signal,
        ...(at === undefined ? {} : { at }),
      })
      void asked.answer.then(async (outcome) => {
        if (outcome.kind !== 'answer') return
        const choice = budgetChoiceOf(outcome.answers.find(one => one.id === BUDGET_ASK_ID)?.selected[0])
        if (choice !== undefined) await choose(task.id, choice, { fromAsk: true })
      }).catch(() => undefined)
      return true
    }
    catch { return false /* 外层问不出去:卡上那三颗键还在 */ }
  }

  /**
   * 到上限了:**停一次、问一句**(2026-10-04 起只有钱与时间两条,哪一条都一样)。
   *
   * 2026-10-02 那天先加过一条「只撞步数线就自动续两档」,当天**又撤掉了** ——
   * 维护者:「不要从调整配置这种修补丁的角度去想」。10-04 把步数线整条去掉之后,
   * 那半边逻辑连「不再生效的分支」都不剩。为什么,写在 `budgetPolicy.ts` 文件头那一节里。
   *
   * ★ 这一下还做两件 10-04 加的事:**问话里带「卡在哪」与已经花了多少钱**;**往账上记一条撞线**。
   */
  async function pause(task: TaskView, verdict: BudgetVerdict): Promise<boolean> {
    const sessionId = task.conversation?.session_id as string
    const at = deps.now().toISOString()
    const candidate = await deps.switchCandidate?.(task.id).catch(() => undefined)
    // 卡上那一句照旧写清花了多少(她在屏幕上看得到);问她那一句另算,见下面 `ask`。
    const note = `到上限了,先停下来了:${spentLine(verdict.view)}。继续、停掉这一件${candidate === undefined ? '' : `,还是换 ${candidate.title} 来做`}?`
    // ★ 问她那一句(2026-10-04):卡在哪 + 已经花了多少钱 + 让她挑。事务官没报卡在哪就照实说「它没说卡在哪」。
    const stuck = verdict.view.stuck
    const ask = budgetAskLine({
      title: task.title,
      ...(candidate === undefined ? {} : { candidateTitle: candidate.title }),
      ...(stuck === undefined ? {} : { stuck }),
      ...(verdict.view.spent_cny === undefined ? {} : { spentCny: verdict.view.spent_cny }),
    })
    // ★ 撞线记一条(2026-10-04 第 3 条)。记坏了不连累停这件事。
    if (verdict.line !== undefined) {
      try {
        deps.onLimit?.({
          taskId: task.id,
          title: task.title,
          line: verdict.line,
          why: verdict.why ?? '',
          ...(stuck === undefined ? {} : { stuck }),
        })
      }
      catch { /* 账记不上不拦停 */ }
    }
    const view: TaskBudgetView = { ...verdict.view, state: 'paused', paused_at: at, note, ...(candidate === undefined ? {} : { switch_to: candidate.title }) }
    // 先把上限这一格落盘(state = paused):下一拍 tick 就不会再停一次、问第二遍。
    await deps.tasks.update(task.id, { budget: view, note })
    await haltSession(task.id, sessionId, { status: 'blocked', blockReason: 'input', note })
    changed()
    hangAsk(task, sessionId, ask, candidate)
    return true
  }

  let resumed = false

  /**
   * 起服务时把重启前挂着的「到上限了」那几问**原样挂回**(2026-09-26;交接-0926 第四节第 1 条)。
   *
   * `pause()` 把卡上那一格落成 paused 之后,下一拍 tick 一律 `over:false`、不会再问第二遍(对的,防重复);
   * 可提问经纪人只在内存里,重启后那一问就永远不在球下「等你」与手机「等你确认」里了 —— 卡上那三颗键还在,
   * 但「等你 n」会少一件,他眼里是「看到的问题凭空消失了」。
   *
   * 账就是卡上那一格(`state === 'paused'` + `note` 是原话 + `paused_at` 是第一次问他的时刻),不另落文件:
   * 多一个文件就多一处「和真相不同步」的地方。这一趟只读看板一眼、只挂问 —— 不停会话(早停了)、不写卡、不重算到没到。
   * 「换 X 来做」那一家照卡上记的名字;那家的余额那一句现取(还是它就带上,不是它了就只留名字)。
   * 命令行那种到时长上限停下来的(`cli_family`,统筹拍板 ③)本来就只挂卡上三颗键、没问过外层,这里也不问。
   * 只跑一次;哪儿出了岔子都不拦起服务。
   */
  async function resume(): Promise<number> {
    if (resumed) return 0
    resumed = true
    if (deps.asker === undefined) return 0
    let list: readonly TaskView[]
    try { list = (await deps.tasks.list()).tasks }
    catch { return 0 }
    let hung = 0
    for (const task of list) {
      const stored = task.budget
      if (stored?.state !== 'paused' || stored.note === undefined || stored.cli_family !== undefined) continue
      if (!butlerOwned(task)) continue
      const sessionId = task.conversation?.session_id as string
      try {
        let candidate: { title: string, note?: string } | undefined
        if (stored.switch_to !== undefined) {
          const fresh = await deps.switchCandidate?.(task.id).catch(() => undefined)
          candidate = fresh?.title === stored.switch_to ? fresh : { title: stored.switch_to }
        }
        /*
         * 挂回来那一问也走同一句(2026-10-04 的形状):卡在哪 + 已经花了多少钱 + 让她挑。
         * 两样都照**卡上那一格**记的(重启后 usage 读不到了,卡上那一格才是当时的账);
         * 卡上记的那一句(`stored.note`)照旧原样留在卡上 —— 挂回外层的只是问她那一句。
         */
        const ask = budgetAskLine({
          title: task.title,
          ...(stored.switch_to === undefined ? {} : { candidateTitle: stored.switch_to }),
          ...(stored.stuck === undefined ? {} : { stuck: stored.stuck }),
          ...(stored.spent_cny === undefined ? {} : { spentCny: stored.spent_cny }),
        })
        if (hangAsk(task, sessionId, ask, candidate, stored.paused_at)) hung += 1
      }
      catch { /* 一张卡挂不上不连累别的卡 */ }
    }
    return hung
  }

  async function tick(): Promise<number> {
    if (inflight !== undefined) return await inflight
    inflight = runTick().finally(() => { inflight = undefined })
    return await inflight
  }

  async function runTick(): Promise<number> {
    let paused = 0
    let running = false
    try {
      const list = (await deps.tasks.list()).tasks
      for (const task of list) {
        if (!butlerOwned(task)) continue
        const sessionId = task.conversation?.session_id as string
        const usage = deps.usage(sessionId)
        if (usage?.running === true) running = true
        const verdict = budgetVerdict(task, deps.config(), usage)
        if (!verdict.over) continue
        // 自动续的那一下不算「停了一件」(它没停、也没问她)—— 回的数照旧是**真停下来问她**的件数。
        try { if (await pause(task, verdict)) paused += 1 }
        catch { /* 一张卡停坏了不连累别的卡 */ }
      }
    }
    catch { /* 绝不抛 */ }
    // 没有一条会话在跑:计时器停下(不在没人干活时空转);下一次会话动了再起。
    if (!running && timer !== undefined) { clearTimer(timer); timer = undefined }
    return paused
  }

  function nudge(_sessionId: string): void {
    ensureTimer()
    void tick()
  }

  async function choose(taskId: string, choice: BudgetChoice, from: { fromAsk?: boolean } = {}): Promise<{ ok: boolean, note: string }> {
    const task = await findTask(taskId)
    if (task === undefined) return { ok: false, note: '没有这个事项' }
    if (from.fromAsk !== true) { asks.get(taskId)?.abort(); asks.delete(taskId) }
    else asks.delete(taskId)
    const view = viewOf(task)
    if (view === undefined) return { ok: false, note: '这件不是事务官自己在办的,没有上限可说' }
    // 派给那家命令行的活到时长上限停下来的(统筹拍板 ③):三颗键各走各的(没有事务官那条会话可说话)。
    if (view.cli_family !== undefined) return await chooseCli(task, view, choice)
    const sessionId = task.conversation?.session_id
    const config = deps.config()
    if (choice === 'continue') {
      const extended = (view.extended ?? 0) + 1
      const next: TaskBudgetView = {
        ...view,
        state: 'running',
        extended,
        limit_cny: Math.round((view.limit_cny + config.cny) * 100) / 100,
        limit_minutes: view.limit_minutes + config.minutes,
        // ★ 2026-10-04:**步数那一半整条拆掉了**(卡 BS2 那条「步数也加一档」)。
        // 既不再判它、也不再加它 —— 不留一个不再生效的分支;老卡上那一格 `limit_steps` 跟着
        // `budgetVerdict` 一起不进视图,这里也就不会把它写回去。
      }
      delete next.note
      delete next.paused_at
      delete next.switch_to
      // 「卡在哪」是上一轮撞线那一刻的实情:接着做就过期了,留着下一次会拿旧话当新话用。
      delete next.stuck
      delete next.stuck_at
      await deps.tasks.update(taskId, { budget: next, note: null })
      if (task.status !== 'doing') await moveTo(taskId, 'doing')
      const limitsText = `${next.limit_cny} 元${BUDGET_MINUTES_LINE ? ` / ${next.limit_minutes} 分钟` : ''}`
      const said = sessionId === undefined || deps.say === undefined
        ? false
        : await deps.say(sessionId, `他说继续刚才那件「${task.title}」。上限加了一档(到 ${limitsText}),接着做;到了还会先停下来问他 —— 停之前把你卡在哪报一句(POST /butler/item/stuck)。`).catch(() => false)
      changed()
      return { ok: true, note: said ? `接着做了,上限加到 ${limitsText}` : `上限加到 ${limitsText}了,但没能叫她接着做 —— 在卡上再说一句` }
    }
    if (choice === 'stop') return stopItem(taskId)
    const candidate = await deps.switchCandidate?.(taskId).catch(() => undefined)
    if (candidate === undefined || deps.switchTo === undefined) return { ok: false, note: '这会儿没有能换的那一家(写代码的活要能改本机文件的)' }
    const result = await deps.switchTo(taskId, candidate.family)
    await deps.tasks.update(taskId, { budget: { ...view, state: 'stopped', note: `换给 ${candidate.title} 做了` } })
    changed()
    return result.ok ? { ok: true, note: `换给 ${candidate.title} 做了:${result.note}` } : { ok: false, note: result.note }
  }

  /**
   * **事务官报「我卡在哪」**(2026-10-04 第 2 条)。只写上限那一格的 `stuck` / `stuck_at`,
   * **不动卡的状态、不动备注、不触发判上限** —— 报一句不是一次动作,只是把实情先摆好,
   * 真撞线那一刻 `pause()` 拿它去问她。
   */
  async function stuck(taskId: string, text: string): Promise<{ ok: boolean, note: string }> {
    const task = await findTask(taskId)
    if (task === undefined) return { ok: false, note: '没有这个事项' }
    const view = viewOf(task)
    if (view === undefined) return { ok: false, note: '这件不是事务官自己在办的,没有上限可说(卡在哪记在卡的备注里就行)' }
    const trimmed = text.trim()
    const next: TaskBudgetView = { ...view }
    if (trimmed === '') {
      delete next.stuck
      delete next.stuck_at
    }
    else {
      next.stuck = trimmed
      next.stuck_at = deps.now().toISOString()
    }
    await deps.tasks.update(taskId, { budget: next })
    changed()
    return trimmed === ''
      ? { ok: true, note: '记下了:这会儿不卡了' }
      : { ok: true, note: '记下了;到上限先停下来时我把这一句原样告诉她' }
  }

  /** 命令行那件到时长上限停下来之后,他点了哪颗键。 */
  async function chooseCli(task: TaskView, view: TaskBudgetView, choice: BudgetChoice): Promise<{ ok: boolean, note: string }> {
    const family = view.cli_family as AgentDispatchFamily
    const who = DISPATCH_FAMILY_TITLES[family]
    if (view.state !== 'paused') return { ok: false, note: `${who} 那件这会儿没停在上限上` }
    if (choice === 'continue') {
      const next: TaskBudgetView = { ...view, state: 'running', extended: (view.extended ?? 0) + 1 }
      delete next.note
      delete next.paused_at
      delete next.switch_to
      await deps.tasks.update(task.id, { budget: next, note: null })
      const resumed = await deps.resumeCli?.(task.id, family).catch(() => undefined)
      changed()
      if (resumed === undefined) return { ok: false, note: `没能叫 ${who} 接着做 —— 在卡上再交代一句` }
      return resumed.ok
        ? { ok: true, note: `又派给 ${who} 接着做了(再给 ${view.limit_minutes} 分钟,到了还会先停下来问你):${resumed.note}` }
        : { ok: false, note: resumed.note }
    }
    if (choice === 'stop') return await stopPausedCli(task, view)
    const candidate = await deps.switchCandidate?.(task.id, family).catch(() => undefined)
    if (candidate === undefined || deps.switchTo === undefined) return { ok: false, note: '这会儿没有能换的那一家(写代码的活要能改本机文件的)' }
    const result = await deps.switchTo(task.id, candidate.family)
    await deps.tasks.update(task.id, { budget: { ...view, state: 'stopped', note: `换给 ${candidate.title} 做了` } })
    changed()
    return result.ok ? { ok: true, note: `换给 ${candidate.title} 做了:${result.note}` } : { ok: false, note: result.note }
  }

  /** 停在时长上限上的那件命令行活,他说「停掉这一件」:那个进程早就停了,卡回「待办」、写清改过的东西在哪。 */
  async function stopPausedCli(task: TaskView, view: TaskBudgetView): Promise<{ ok: boolean, note: string }> {
    const who = DISPATCH_FAMILY_TITLES[view.cli_family as AgentDispatchFamily]
    const where = task.dispatch?.cwd === undefined ? '' : `,改过的东西留在 ${task.dispatch.cwd}`
    const note = `你停掉了这一件:${who} 在后台到时长上限停下的那一次就算完了${where};要接着做就在卡上再交代一句`
    await deps.tasks.update(task.id, {
      budget: { ...view, state: 'stopped', note },
      note,
      ...(task.dispatch === undefined ? {} : { dispatch: { ...task.dispatch, stopped: 'user' } }),
    })
    if (task.status !== 'todo') await moveTo(task.id, 'todo')
    changed()
    return { ok: true, note: `停了:${who} 那件不再接着做${where}` }
  }

  async function stopItem(taskId: string): Promise<{ ok: boolean, note: string, status?: number }> {
    const task = await findTask(taskId)
    if (task === undefined) return { ok: false, note: '没有这个事项', status: 404 }
    if (task.status === 'done' || task.status === 'canceled') return { ok: false, note: '这件已经办完 / 取消了,没有在跑的可停', status: 409 }
    // 命令行那件停在时长上限上(等他回话):外层「停掉这一件」= 那三颗键里的「停掉这一件」。
    if (task.budget?.cli_family !== undefined && task.budget.state === 'paused') {
      const paused = viewOf(task)
      if (paused !== undefined) return await stopPausedCli(task, paused)
    }
    asks.get(taskId)?.abort()
    asks.delete(taskId)
    const parts: string[] = []
    let stoppedSomething = false
    // ① 事务官自己在办的那条 DSH 会话。
    const sessionId = task.conversation?.session_id
    const view = viewOf(task)
    const spentParts = view === undefined ? [] : [
      view.spent_cny === undefined ? '' : `花了约 ${yuan(view.spent_cny)} 元`,
      view.run_minutes === undefined ? '' : `跑了 ${Math.floor(view.run_minutes)} 分钟`,
    ].filter(one => one !== '')
    const note = `你停掉了这一件${spentParts.length === 0 ? '' : `:${spentParts.join('、')}`}。改过的东西留着;要接着做就在卡上再交代一句`
    // 上限那一格先记成「停了」:之后 tick 不会再把它当成在跑的去停、去问。
    if (view !== undefined) await deps.tasks.update(taskId, { budget: { ...view, state: 'stopped', note } })
    let sessionHalted = false
    if (sessionId !== undefined) {
      const halted = await haltSession(taskId, sessionId, { status: 'todo', note })
      if (halted.stopped) { stoppedSomething = true; sessionHalted = true; parts.push('停了事务官那条会话') }
      else if (halted.why !== undefined) parts.push(`事务官那条会话没停成(${halted.why})`)
    }
    // ② 派给别家命令行的那个进程。
    const cli = task.dispatch
    if (cli !== undefined && cli.status === 'running' && cli.pid !== undefined && deps.killPid !== undefined) {
      // **先**记成「他停的」(不是没做成),再停进程:进程一退,收尾那一步看到它不在跑了就不当「没做成」收;
      // 界面不染红、收件箱不问「要我自己来吗」。
      await deps.tasks.update(taskId, { dispatch: { ...cli, status: 'failed', stopped: 'user', ended_at: deps.now().toISOString(), note: `你停掉了它(pid ${cli.pid})` } })
      try { deps.killPid(cli.pid); stoppedSomething = true; parts.push(`停了 ${DISPATCH_FAMILY_TITLES[cli.family]} 在后台做的那一件`) }
      catch (error) {
        const gone = (error as { code?: string }).code === 'ESRCH'
        parts.push(gone ? `${DISPATCH_FAMILY_TITLES[cli.family]} 在后台那一件早就停了` : `${DISPATCH_FAMILY_TITLES[cli.family]} 在后台那一件没停成`)
      }
    }
    // ③ 派进窗口、还在等回答的:不再等。那家窗口里那一句我们停不了。
    const win = task.client_dispatch
    if (win !== undefined && win.reply_state === 'waiting') {
      const who = DISPATCH_FAMILY_TITLES[win.family]
      await deps.tasks.update(taskId, {
        clientDispatch: { ...win, reply_state: 'unreadable', reply_note: `你停掉了这一件;${who} 那扇窗里那一句我们停不了,它可能还会答完 —— 答了也不收了` },
      })
      stoppedSomething = true
      parts.push(`不再等 ${who} 的回答(它那扇窗里那一句我们停不了)`)
    }
    if (!stoppedSomething && parts.length === 0 && sessionId === undefined) {
      return { ok: false, note: '这件这会儿没有在做的(没人在做,也没在等谁的回答)', status: 409 }
    }
    // 事务官那条会话停成了的由生命周期照单子挪(它会收到「被停了」;等不到有兜底);别的自己挪回待办、写清停了什么。
    if (!sessionHalted) {
      const fresh = await findTask(taskId)
      if (fresh !== undefined && fresh.status !== 'done' && fresh.status !== 'canceled') {
        await deps.tasks.update(taskId, { note: parts.length === 0 ? note : `你停掉了这一件:${parts.join(';')}` })
        if (fresh.status !== 'todo') await moveTo(taskId, 'todo')
      }
    }
    changed()
    return { ok: true, note: parts.length === 0 ? '停了(它这会儿本来就没在跑)' : `停了:${parts.join(';')}` }
  }

  return {
    viewOf,
    tick,
    nudge,
    choose: (taskId, choice) => choose(taskId, choice),
    stuck,
    stopItem,
    expectedAbort(sessionId) {
      const one = aborts.get(sessionId)
      if (one !== undefined) aborts.delete(sessionId)
      return one
    },
    resume,
    stop() {
      if (timer !== undefined) { clearTimer(timer); timer = undefined }
      for (const controller of asks.values()) controller.abort()
      asks.clear()
    },
  }
}
