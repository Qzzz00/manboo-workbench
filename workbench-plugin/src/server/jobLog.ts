/**
 * **一本只追加的任务日志**(2026-10-02,卡 AG)。
 *
 * 来由:`docs/设计-重构-接缝与技术债-2026-09-30.md` 根子 3 ——「指派 → 投递 → 完成 → 电话」
 * 今天**没有一条管线能从落盘数据完整查回来**,于是每条路各自猜「这件事还动不动得那一家」,
 * 猜错了就接着动(10-02 真机:事情办完了,还有管线在读那一家的窗、在把它的窗开出来)。
 * 第 1 段 B 的起步就是这一本:**先只在现有管线的关键点写事件**,让 {@link ../actionGate.ts 动作闸} 读它。
 *
 * 三条纪律:
 * ① **只追加**。写进去的那一条谁都不许改、不许删;满了只从**最老的**丢,而且数得出丢了几条
 *    (`dropped()` —— 丢了就说,不装作没丢)。
 * ② **四步查得回来**。`traceOf` 从事件里数出指派 / 投递 / 完成 / 已打电话;数不出来的那一格**缺席**,不编一个。
 * ③ **账上没有她的话**。一条事件只有:时刻、事项、哪一家、哪个包、什么动作、为什么。
 *    她那句原话、送进窗口的正文,一个字都不进来(与 `relayWatch.ts` 同一条纪律)。
 *
 * ★ **2026-10-02(卡 AG2)落盘了**:一行一条 JSON(`jsonl`),**只往文件末尾追加**。
 * 为什么不等那个「JSON 存盘助手」:只追加的账不需要它那套读改写 —— 追加本身就是原子的那一类,
 * 读坏了的那一行单独丢掉(整本账不受它带累)。三条规矩:
 *
 * - **写盘失败不许吞**(根子 3「回电台账落盘失败被吞」那条教训):第一次坏记一行日志
 *   ({@link JOB_LOG_PERSIST_FAILED_LOG}),{@link JobLog.persistError} 一直说得出坏在哪,
 *   `GET /jobs/:id/trace` 的回包里原样带上 —— 不装作记上了;{@link JobLog.flush} 则直接抛。
 * - **重启还查得到**:起服务时 {@link JobLog.load} 把文件读回内存(读不懂的行丢掉、数得出丢了几行)。
 * - **体量有上限,但不截还没收场的**({@link trimJobEvents}):满了只丢**已经收场**那几件的事件
 *   (口径同 `relayWatch.trimRelayWaits`:还在等的一条都不丢)—— 一件事还没收场就把它的账截掉,
 *   等于把「这件事还动不动得」的依据扔了,而那正是这本账存在的理由。
 */

import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { VIA_TEXT, type JobVia } from './engine/adapter.ts'

/** 账上记得下的那几步。 */
export type JobStep =
  /** 指派:这件事交给了哪一家。 */
  | 'assigned'
  /** 投递:那段交代**我们送进**它窗口了。 */
  | 'sent'
  /**
   * 投递:在它对话区里**亲眼看见**那一句了。
   *
   * 两种情形都是这一步:① 我们送完、核上了(引擎的 `confirmed`,见 `engine.JOB_LOG_STEP`);
   * ② ★ **「只盯不发」**(`/sessions/relay {watch_only:true}`,2026-10-03 卡「接缝清理」第 1 条):
   * 那句话是**她自己发的**,我们只核到它在对话区里看得见,**一个字都没送** ——
   * 所以不许记 `sent`(与「一个字不说成送到了」同一条纪律;交接 1002 第六节 ⑤ 留的那一条)。
   * 四步表上这一步照旧算「投递」({@link traceOf} 的 `DELIVERED`),所以那一类的活不会显示成「没送」。
   */
  | 'seen'
  /** 对端执行源确认已开始处理;不同于派出/投递/看见。 */
  | 'started'
  | 'updated'
  | 'ended'
  | 'interrupted'
  | 'source_unknown'
  | 'source_observed'
  /** 完成:它交回来了。 */
  | 'replied'
  /** 完成:等过头了。 */
  | 'timeout'
  /**
   * 完成:**她取消了这张卡,在跑的那一次被当场收场**(2026-10-28,任务书「取消要收场执行者」)。
   * `why` 记 `canceled_by_user`。进程临死前的「交回」不再记 `replied` —— 那一下只落一条卡上评论。
   */
  | 'canceled'
  /** 完成:它那扇窗读不到,这条到此为止。 */
  | 'unreadable'
  /**
   * 完成:**一个字都没送出去**(2026-10-02,接线那张卡补的那一步)。
   *
   * 从前引擎把三种结局里的 `not_sent` 暂借 `unreadable` 记(交接「引擎核心」第六节第 3 条),
   * 于是账上看不出「那扇窗读不到」与「这一家压根没这条通道 / 壳没连上 / 她的话是空的」的差别 ——
   * 四步表的「完成」那一格两种都写着「读不到」,而下一步该做的事正相反。
   */
  | 'not_sent'
  /**
   * ★ **等着:这一下没送出去,可它排上队了**(2026-10-03,卡「锁屏时窗口型的家送不进」)。
   *
   * 今天只有一种:**电脑锁着屏**,窗口型那几家起不出窗 —— 这一件排进
   * `engine/lockQueue.ts`,她一解锁就按原顺序重送。
   *
   * **为什么不能记 `not_sent`**(这是硬的):`not_sent` 在 {@link isFinishStep} 里算**收场**,
   * 于是 ① 四步表的「完成」那一格会摆出一个不是事实的收场;
   * ② `trimJobEvents` 会把它当「已收场」的事,满了先丢它的事件;
   * ③ 最要紧的是**闸**:`jobKey.jobPhaseOf` + `actionGate` 第一条是「收场了就不再动那一家」,
   *    一旦记成收场,解锁之后那一下重送会被自己拦下 —— 等于这张卡白做。
   *
   * 所以这一步**既不算投递、也不算收场**:账上看得见「它在等」,而这件事还开着。
   */
  | 'waiting'
  /** 完成:她自己把卡收了(办完 / 取消)。 */
  | 'done'
  /** 已打电话。 */
  | 'called'
  /** 按规矩不打(静音时段、她说过别打……)—— 说得出为什么。 */
  | 'no_call'
  /** 动作闸放行了一个动作。 */
  | 'gate_pass'
  /** 动作闸拦下了一个动作。 */
  | 'gate_block'
  /**
   * **到上限了,先停下来问她**(2026-10-04,卡「事务官上限只看钱」第 3 条)。
   *
   * 维护者:「把撞线的事记下来 —— 每次撞线记一条(哪件事、哪类事、撞的哪条线、卡在哪那句话)」,
   * 落在**现成的**这本账上,不另起一个数据库。四样对应:`job` = 哪件事、`kind` = 哪类事、
   * `action` = 撞的哪条线(`money` / `time`)、`why` = 事务官报的「卡在哪」那句话(它没报就是那句如实话)。
   *
   * **这一条不算「收场」**(`isFinishStep` 里没有它):到上限只是先停下来问她一句,这件事还没完。
   * 账上那条「没有她的话」的纪律照旧 —— `why` 里是**事务官自己**说它卡在哪,不是她说的话。
   */
  | 'budget_stop'
  /**
   * ★ **通道堵了**(2026-10-21,卡「派活按家隔离」):这一家的窗口这一下超了硬上限(`familyLanes.ts`),
   * 那一下作废、通道放开。`why` = 哪一步、等了多久那句人话。**不算收场**:这件事还开着,下一拍还会探。
   */
  | 'jammed'
  /**
   * ★ **重置了这一家的通道**(2026-10-21,同上):她点了「重置这一家」—— 清闸计数、撤排着的读、重开那扇窗。
   * 记在这一家每件还开着的事上(`job` = 那件事),外加一行 `family:<id>`(这一下本身)。**不算收场**。
   */
  | 'lane_reset'
  /**
   * ★ **统一执行事件的历史输出口**(2026-10-29,可靠执行闭环第一批第 1 步;
   * {@link appendExecutionEvent}):推进职责(`taskExecution.ts`)把提交过的事实留一行在这本账上。
   * **只记历史,不当恢复账** —— 未完成委托的恢复依据是卡上的执行记录(`TaskView.execution`),
   * 这本满了会裁(`JOB_LOG_MAX`),不能反过来靠它答「下一步该谁做」。
   * **不算投递、也不算收场**(同 `waiting` 的取舍):记了这一行,这件事该怎么动仍只看执行记录。
   */
  | 'execution'

/** 账上的一条。**没有她的话**。 */
export interface JobEvent {
  /** 时刻(ISO)。 */
  at: string
  /** 哪一件事(事项 id / 捎话轻账那一条的 id)。 */
  job: string
  step: JobStep
  /** 哪一家(登记表里那个 id)。 */
  family?: string
  /** 真动到的那个包。 */
  bundle_id?: string
  /** 哪一种动作(动作闸那几样,见 `actionGate.ts` 的 `GateAction`)。 */
  action?: string
  /**
   * 走的哪条通道(2026-10-03,卡「派活三只手收进引擎」):协议 / 窗口 / 命令行 / 接口。
   * 引擎记的那几行才有;换过路在账上看得出来(两条 `assigned` 各带一条 via)。念法只在 {@link VIA_TEXT}。
   */
  via?: JobVia
  /**
   * 哪类事(`JobKind`:`code` 写代码 / `chat` 聊天问答 / `desk` 要在她电脑上动手)。
   * 2026-10-04 为 {@link JobStep 'budget_stop'} 加的 —— 日结要数「同一类事反复撞线」
   * (`budgetPolicy.budgetRepeatLine`)。数不出来就缺席,不猜一类。
   */
  kind?: string
  /** 为什么(拦下的原因、不打电话的原因……)。 */
  why?: string
  /** Stable execution origin. These fields are metadata only; source text and paths never enter this log. */
  agent?: string
  session_id?: string
  /**
   * 命令行派发那一次的进程号 / 轮次身份(2026-10-29,任务书「在跑的事项要数到命令行真在跑的活」):
   * `started` 那一条带上,重派 / 重启之后按它们分清哪一段是哪一次派发。纯元数据。
   */
  pid?: number
  attempt_id?: string
  source_round?: string
  source_event_id?: string
  occurred_at?: string
  observed_at?: string
  task_round?: number
  source_state?: 'running' | 'returned' | 'ended' | 'interrupted' | 'unknown'
  /**
   * 统一执行事件那一行带上的计划版本(2026-10-29,第 1 步;只有 {@link appendExecutionEvent} 写它)。
   * 纯元数据,只用于排障对时间线。
   */
  plan_version?: number
}

/** 统一执行事件的历史输出口要记的那几格(2026-10-29,第 1 步)。**没有她的话**,与整本账同一条纪律。 */
export interface ExecutionLogFact {
  job: string
  /** 事实种类(`ExecutionFact.kind`:`started` / `returned` / `verification_missing` / `cancel_requested`)。 */
  fact: string
  attempt_id?: string
  plan_version?: number
  /** 判据原文(如 `missing_test_output`);没有就不占位置。 */
  reason?: string
  at?: string
}

/**
 * 把一条执行事实追加进这本账(历史输出口,**唯一新增写法**:只是 `append` 的一种用法,
 * 现有写入与裁剪一行不动)。满了的裁剪口径照旧 —— 未收场的一条都不丢,所以恢复记录
 * 不在这本账上也不受它裁剪影响(用例钉在 tests/task-execution-store.test.ts ④)。
 */
export function appendExecutionEvent(log: JobLog, event: ExecutionLogFact): JobEvent {
  return log.append({
    job: event.job,
    step: 'execution',
    action: event.fact,
    ...(event.attempt_id === undefined ? {} : { attempt_id: event.attempt_id }),
    ...(event.plan_version === undefined ? {} : { plan_version: event.plan_version }),
    ...(event.reason === undefined || event.reason === '' ? {} : { why: event.reason }),
    ...(event.at === undefined ? {} : { at: event.at }),
  })
}

/** 账上最多留多少条。满了从最老的丢(丢了几条 `dropped()` 说得出)。 */
export const JOB_LOG_MAX = 4000

/** 一件事的四步。数不出来的那一格**缺席**。 */
export interface JobTrace {
  job: string
  /** 指派。 */
  assigned?: JobEvent
  /** 投递(送进去那一下;`seen` 比 `sent` 更实,但四步表上记的是**最早**那一次投递)。 */
  delivered?: JobEvent
  /** 收场(回了 / 超时 / 读不到 / 她自己收了)。 */
  finished?: JobEvent
  /** 电话(打了 / 按规矩没打)。 */
  called?: JobEvent
  /** 这件事的全部事件,先后顺序。 */
  events: readonly JobEvent[]
}

export interface JobLog {
  /**
   * 记一条(`at` 缺席就用 `now()`)。回记上的那一条。
   * **落盘是排在后面的**(这一下不等盘):写进内存、把这一条排进落盘队列。
   * 排队那一下坏了不许吞 —— 见 {@link persistError} / {@link flush}。
   */
  append: (event: Omit<JobEvent, 'at'> & { at?: string }) => JobEvent
  /** 起服务时把盘上那本读回来(没有文件 = 空账)。不接文件的那一份(用例 / 老宿主)什么都不做。 */
  load: () => Promise<void>
  /** 等落盘队列走完;**上一次写盘坏了就抛**(调用方要说实话的那几处用它)。 */
  flush: () => Promise<void>
  /** 上一次写盘坏在哪(原话)。`undefined` = 盘上这本是全的。 */
  persistError: () => string | undefined
  /** 读盘时丢掉了几行读不懂的(丢了就说)。 */
  unreadable: () => number
  /** 这件事的全部事件(副本)。 */
  events: (job: string) => readonly JobEvent[]
  /** 这件事的四步。 */
  trace: (job: string) => JobTrace
  /** 整本账(副本)。 */
  all: () => readonly JobEvent[]
  /** 满了丢掉过几条(丢了就说)。 */
  dropped: () => number
  /**
   * 记上一条之后告诉谁(2026-10-21 协作区:Agent 小鼠标由账上的事件推,见 `collabPresence.ts`)。
   * 回一个退订函数。听的那一方抛了不连累记账。可选:用例里的假账可以没有。
   */
  listen?: (fn: (event: JobEvent) => void) => () => void
  /**
   * 账的代数(8791 第六轮,2026-10-29):`append` 各 +1、`load` 整体换账也 +1。
   * 读侧按 (代数, 拍) 缓存派生视图(运行片段)时不比内容、只看代数。可选:假账没有 = 不缓存。
   */
  revision?: () => number
}

const DELIVERED: readonly JobStep[] = ['sent', 'seen']
const FINISHED: readonly JobStep[] = ['replied', 'ended', 'interrupted', 'timeout', 'canceled', 'unreadable', 'not_sent', 'done']
const CALLED: readonly JobStep[] = ['called', 'no_call']

/** 这一步算不算「这件事收场了」(四步表里「完成」那一格同一份判据)。 */
export function isFinishStep(step: JobStep): boolean {
  return FINISHED.includes(step)
}

/** 落盘坏了时记的那一行(**不带她的话**;断言照这个常量,不逐字抄中文)。 */
export const JOB_LOG_PERSIST_FAILED_LOG = '[任务] 账落不了盘,这几条只在内存里(下一条再试)'

/**
 * ★ **满了丢谁:只丢已经收场那几件的**(2026-10-02,卡 AG2;口径同 `relayWatch.trimRelayWaits`)。
 *
 * 一件事还没收场(账上没有 `replied`/`timeout`/`canceled`/`unreadable`/`done` 那一格)就把它的事件截掉,
 * 等于把「这件事还动不动得」「来过几回」的依据扔了 —— 而那正是这本账存在的理由。
 * 所以:**还没收场的一条都不丢**(哪怕比上限还多),超出的部分只从**已收场**那几件里、按老的先丢。
 */
export function trimJobEvents(events: readonly JobEvent[], max = JOB_LOG_MAX): JobEvent[] {
  if (events.length <= max) return [...events]
  const settled = new Set<string>()
  for (const one of events) if (one.session_id === undefined && isFinishStep(one.step)) settled.add(one.job)
  // Source events and old rounds are historical evidence: preserve them even when the task ledger compacts.
  const sourceEvent = (one: JobEvent): boolean => one.session_id !== undefined && one.source_round !== undefined && one.source_event_id !== undefined
  const open = events.filter(one => sourceEvent(one) || !settled.has(one.job)).length
  // 已收场的这次要丢掉几条(还没收场的占满了上限就一条已收场的都不留)。
  let drop = Math.min(events.length - max, events.length - open)
  return events.filter((one) => {
    if (sourceEvent(one) || !settled.has(one.job) || drop <= 0) return true
    drop -= 1
    return false
  })
}

/** 盘上那一行 → 一条事件。读不懂(不是对象 / 没有 `job` / `step` 不认得)就 undefined,整本账不受它带累。 */
export function parseJobEventLine(line: string): JobEvent | undefined {
  const text = line.trim()
  if (text === '') return undefined
  let raw: unknown
  try { raw = JSON.parse(text) }
  catch { return undefined }
  if (typeof raw !== 'object' || raw === null) return undefined
  const value = raw as Record<string, unknown>
  const str = (key: string): string | undefined => (typeof value[key] === 'string' && value[key] !== '' ? value[key] as string : undefined)
  const job = str('job')
  const step = str('step')
  const at = str('at')
  if (job === undefined || step === undefined || at === undefined || !JOB_STEPS.includes(step as JobStep)) return undefined
  return {
    at,
    job,
    step: step as JobStep,
    ...(str('family') === undefined ? {} : { family: str('family') as string }),
    ...(str('bundle_id') === undefined ? {} : { bundle_id: str('bundle_id') as string }),
    ...(str('action') === undefined ? {} : { action: str('action') as string }),
    // 通道那一格只认得出的那几种(认不出的当没写:老账 / 写坏的行不连累别的格)。
    ...(str('via') !== undefined && Object.hasOwn(VIA_TEXT, str('via') as string) ? { via: str('via') as JobVia } : {}),
    ...(str('kind') === undefined ? {} : { kind: str('kind') as string }),
    ...(str('why') === undefined ? {} : { why: str('why') as string }),
    ...(str('agent') === undefined ? {} : { agent: str('agent') as string }),
    ...(str('session_id') === undefined ? {} : { session_id: str('session_id') as string }),
    // 命令行派发那两格(2026-10-29):整数进程号与非空轮次身份才认,形状不对当没写。
    ...(typeof value.pid === 'number' && Number.isInteger(value.pid) && value.pid >= 0 ? { pid: value.pid } : {}),
    ...(str('attempt_id') === undefined ? {} : { attempt_id: str('attempt_id') as string }),
    ...(str('source_round') === undefined ? {} : { source_round: str('source_round') as string }),
    ...(str('source_event_id') === undefined ? {} : { source_event_id: str('source_event_id') as string }),
    ...(str('occurred_at') === undefined ? {} : { occurred_at: str('occurred_at') as string }),
    ...(str('observed_at') === undefined ? {} : { observed_at: str('observed_at') as string }),
    ...(typeof value.task_round === 'number' && Number.isInteger(value.task_round) && value.task_round >= 1 ? { task_round: value.task_round } : {}),
    ...(['running', 'returned', 'ended', 'interrupted', 'unknown'].includes(String(value.source_state)) ? { source_state: value.source_state as NonNullable<JobEvent['source_state']> } : {}),
    // 统一执行事件那一格(2026-10-29):整数计划版本才认,形状不对当没写。
    ...(typeof value.plan_version === 'number' && Number.isInteger(value.plan_version) && value.plan_version >= 1 ? { plan_version: value.plan_version } : {}),
  }
}

/** 账上记得下的那几步(读盘时认它;新加一步要加进这张表,不然读回来会被当成读不懂的行丢掉)。 */
export const JOB_STEPS: readonly JobStep[] = [
  'assigned', 'sent', 'seen', 'started', 'updated', 'ended', 'interrupted', 'source_unknown', 'source_observed', 'replied', 'timeout', 'canceled', 'unreadable', 'not_sent', 'waiting', 'done', 'called', 'no_call', 'gate_pass', 'gate_block',
  // 2026-10-04:到上限先停下来问她(卡「事务官上限只看钱」)。
  'budget_stop',
  // 2026-10-21:通道堵了 / 重置了这一家(卡「派活按家隔离」)。
  'jammed', 'lane_reset',
  // 2026-10-29:统一执行事件的历史输出口(可靠执行闭环第一批第 1 步);只记历史,不算投递也不算收场。
  'execution',
]

/** 这本账落在哪(与捎话轻账、看板同一个目录)。 */
export function defaultJobLogFile(home = process.env.HOME ?? ''): string {
  return `${home}/.dsh/workbench/jobs.jsonl`
}

/**
 * 从事件里数出四步。**纯函数**,一个字都不编:
 * 指派 = 第一条 `assigned`;投递 = 第一条 `sent`/`seen`;收场 = 第一条 `replied`/`timeout`/`canceled`/`unreadable`/`done`;
 * 电话 = 第一条 `called`/`no_call`。没有那一条就那一格缺席。
 */
export function traceOf(job: string, events: readonly JobEvent[]): JobTrace {
  const mine = events.filter(one => one.job === job)
  const first = (steps: readonly JobStep[]): JobEvent | undefined => mine.find(one => steps.includes(one.step))
  const assigned = first(['assigned'])
  const delivered = first(DELIVERED)
  const finished = first(FINISHED)
  const called = first(CALLED)
  return {
    job,
    ...(assigned === undefined ? {} : { assigned }),
    ...(delivered === undefined ? {} : { delivered }),
    ...(finished === undefined ? {} : { finished }),
    ...(called === undefined ? {} : { called }),
    events: mine,
  }
}

/** 日志那一行(排障时要能对时间)。缺席的那几格不占位置。 */
export function jobLogLine(event: JobEvent): string {
  const parts = [
    event.at,
    event.job,
    event.step,
    ...(event.action === undefined ? [] : [event.action]),
    ...(event.family === undefined ? [] : [event.family]),
    ...(event.via === undefined ? [] : [VIA_TEXT[event.via]]),
    ...(event.bundle_id === undefined ? [] : [event.bundle_id]),
    ...(event.kind === undefined ? [] : [event.kind]),
    ...(event.why === undefined || event.why === '' ? [] : [event.why]),
  ]
  return `[任务] ${parts.join(' · ')}`
}

/**
 * 落盘那几下(用例里换掉,真跑时是 `node:fs/promises`)。**只有三样**:追加一行、整本重写、读回来。
 * 整本重写只在「满了要丢掉已收场那几条」时走一回 —— 平时一律是追加。
 */
export interface JobLogIo {
  append: (file: string, line: string) => Promise<void>
  rewrite: (file: string, text: string) => Promise<void>
  read: (file: string) => Promise<string | undefined>
  /** 读到坏行时,重写之前把原本另存一份(缺席 = 不另存;真盘那一份存成 `<file>.corrupt-<时间>`)。 */
  keep?: (file: string, text: string) => Promise<void>
}

export function createJobLog(options?: {
  now?: () => Date
  max?: number
  /** 落在哪(缺席 = 只在内存里,行为与 2026-10-02 卡 AG 那一版一字不差)。 */
  file?: string
  io?: JobLogIo
  /** 落盘坏了那一行往哪记(缺席 = `console.warn`)。 */
  warn?: (line: string) => void
}): JobLog {
  const now = options?.now ?? (() => new Date())
  const max = options?.max ?? JOB_LOG_MAX
  const file = options?.file
  const io = options?.io ?? nodeJobLogIo()
  const warn = options?.warn ?? ((line: string) => { console.warn(line) })
  /** 只追加:这个数组只 push、满了只按 {@link trimJobEvents} 丢**已收场**那几条,**一条都不就地改**。 */
  let events: JobEvent[] = []
  const sourceEventIndex = new Map<string, JobEvent>()
  const eventsByJob = new Map<string, JobEvent[]>()
  const sourceKey = (one: Pick<JobEvent, 'job' | 'session_id' | 'source_round' | 'source_event_id'>): string | undefined =>
    one.session_id === undefined || one.source_round === undefined || one.source_event_id === undefined
      ? undefined : JSON.stringify([one.job, one.session_id, one.source_round, one.source_event_id])
  const rebuildSourceIndex = () => {
    sourceEventIndex.clear()
    eventsByJob.clear()
    for (const one of events) {
      const rows = eventsByJob.get(one.job) ?? []
      rows.push(one); eventsByJob.set(one.job, rows)
      const key = sourceKey(one)
      if (key !== undefined && !sourceEventIndex.has(key)) sourceEventIndex.set(key, one)
    }
  }
  const trimInterval = Math.max(1, Math.ceil(max / 4))
  let nextTrimAt = max + trimInterval + 1
  let dropped = 0
  let unreadable = 0
  /** 账的代数:append/load 各 +1,读侧缓存键用(见 JobLog.revision)。 */
  let revision = 0
  /**
   * 盘上那本没读成(不是「没有这个文件」)。这时内存里只有这次起来之后的几条,
   * 收账重写就等于拿它们盖掉整本旧账 —— 所以只追加,不重写(2026-10-21)。
   */
  let loadFailed = false
  /** 上一次写盘坏在哪(原话)。坏了之后每一条都接着试,但只记第一行日志。 */
  let persistError: string | undefined
  let warned = false
  /** 落盘排一条队:顺序进盘(只追加的账,顺序就是账)。 */
  let queue: Promise<void> = Promise.resolve()
  const listeners = new Set<(event: JobEvent) => void>()
  function tell(event: JobEvent): void {
    for (const fn of listeners) {
      try { fn({ ...event }) }
      catch { /* 听的那一方坏了不连累记账 */ }
    }
  }

  /** 把这一下排进落盘队列。**坏了不吞**:记下原话 + 第一次记一行日志。 */
  function enqueue(fn: () => Promise<void>): void {
    if (file === undefined) return
    queue = queue.then(fn).then(
      () => { persistError = undefined; warned = false },
      (error: unknown) => {
        persistError = error instanceof Error ? error.message : String(error)
        if (!warned) warn(JOB_LOG_PERSIST_FAILED_LOG)
        warned = true
      },
    )
  }

  return {
    append(input) {
      const key = sourceKey(input)
      const recorded = key === undefined ? undefined : sourceEventIndex.get(key)
      if (recorded !== undefined) return recorded
      const event: JobEvent = { ...input, at: input.at ?? now().toISOString() }
      events.push(event)
      revision += 1
      const rows = eventsByJob.get(event.job) ?? []
      rows.push(event); eventsByJob.set(event.job, rows)
      if (key !== undefined) sourceEventIndex.set(key, event)
      /*
       * ★ **留一截余量再收**(2026-10-02,卡 AG2):收一次要把整本重写一遍,
       * 一满就收等于**每记一条重写一次**(盯窗那几条路 4~8 秒一拍,一小时上千条)。
       * 所以涨过 max 的四分之一才收,一次收回到 max —— 重写因此是摊薄的。
       */
      if (events.length >= nextTrimAt || events.length > max && event.session_id === undefined && isFinishStep(event.step)) {
        const kept = trimJobEvents(events, max)
        dropped += events.length - kept.length
        const changed = kept.length !== events.length
        events = kept
        if (changed) rebuildSourceIndex()
        // Unfinished jobs and source evidence cannot be trimmed. Retry after another bounded
        // increment rather than scanning the growing ledger on every subsequent append.
        nextTrimAt = Math.max(max + trimInterval + 1, events.length + trimInterval)
        // 丢过东西才重写整本(平时一律只追加这一行)。原本没读成就不重写,见 loadFailed。
        if (changed && !loadFailed) {
          enqueue(async () => { await io.rewrite(file as string, `${events.map(one => JSON.stringify(one)).join('\n')}\n`); if (event.source_event_id !== undefined) tell(event) })
          if (event.source_event_id === undefined || file === undefined) tell(event)
          return event
        }
      }
      enqueue(async () => { await io.append(file as string, `${JSON.stringify(event)}\n`); if (event.source_event_id !== undefined) tell(event) })
      if (event.source_event_id === undefined || file === undefined) tell(event)
      return event
    },
    listen(fn) {
      listeners.add(fn)
      return () => { listeners.delete(fn) }
    },
    async load() {
      if (file === undefined) return
      const text = await io.read(file).catch((error: unknown) => {
        persistError = error instanceof Error ? error.message : String(error)
        loadFailed = true
        return undefined
      })
      if (text === undefined || text === '') return
      const read: JobEvent[] = []
      for (const line of text.split('\n')) {
        if (line.trim() === '') continue
        const one = parseJobEventLine(line)
        if (one === undefined) { unreadable += 1; continue }
        read.push(one)
      }
      // 读不懂的行重写时会丢,先把原本原样另存一份(另存失败只记一行,不挡启动)。
      if (unreadable > 0 && io.keep !== undefined) {
        await io.keep(file, text).catch((error: unknown) => {
          warn(`[任务日志] 另存读不懂的原本失败:${error instanceof Error ? error.message : String(error)}`)
        })
      }
      const kept = trimJobEvents([...read, ...events], max)
      dropped += read.length + events.length - kept.length
      events = kept
      rebuildSourceIndex()
      revision += 1
      nextTrimAt = Math.max(max + trimInterval + 1, events.length + trimInterval)
    },
    async flush() {
      await queue
      if (persistError !== undefined) throw new Error(persistError)
    },
    persistError() { return persistError },
    unreadable() { return unreadable },
    revision() { return revision },
    events(job) { return (eventsByJob.get(job) ?? []).map(one => ({ ...one })) },
    trace(job) { return traceOf(job, events.map(one => ({ ...one }))) },
    all() { return events.map(one => ({ ...one })) },
    dropped() { return dropped },
  }
}

/** 真落盘那一份:`appendFile` 一行(目录不在就先建)。**不读改写** —— 只追加的账不需要。 */
export function nodeJobLogIo(): JobLogIo {
  return {
    async append(file, line) {
      await mkdir(dirname(file), { recursive: true })
      await appendFile(file, line, 'utf8')
    },
    async rewrite(file, text) {
      await mkdir(dirname(file), { recursive: true })
      const tmp = `${file}.tmp`
      await writeFile(tmp, text, 'utf8')
      await rename(tmp, file)
    },
    async keep(file, text) {
      await writeFile(`${file}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`, text, { encoding: 'utf8', flag: 'wx' })
    },
    async read(file) {
      try { return await readFile(file, 'utf8') }
      catch (error) {
        // 没有这个文件 = 空账(第一次起服务),别的错原样抛(写不进也读不出要说实话)。
        if ((error as { code?: string }).code === 'ENOENT') return undefined
        throw error
      }
    },
  }
}
