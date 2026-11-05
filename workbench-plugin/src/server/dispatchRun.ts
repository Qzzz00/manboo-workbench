import { observeRuntime } from './dispatchRuntime.ts'
import type { DispatchChoicesView, DispatchRuntime, DispatchSelection } from '../protocol.ts'
/**
 * **派活从头到尾由工作台自己跑**(2026-09-24,卡 F「手机远程派活六家」)。
 *
 * 维护者:「通过事务官去下发、通过事务官去验收,这样子的话我其实放不放假没区别」;
 * 「最重要是要能 work」。9/29 起他只带 Pad 离开这台 Mac。
 *
 * ## 为什么把"派"从 DSH 会话收回到工作台(推翻 09-21 那条「真正 spawn 的是事务官」,可推翻)
 *
 * 09-21 的设计是:建事项时开一条 DSH 会话,第一句里点名「按『派活给别家Agent』那一节办」,
 * 由那条会话读 `~/.dsh/AGENTS.md` 的技能段、自己 curl 送话、自己报进度。2026-09-24 实测这条链
 * **一次都走不通**,病在三处,都不是"模型偶尔漏报"那种小毛病:
 *
 * 1. 这台机器上 `~/.dsh/AGENTS.md` 里**根本没有**那一段技能(09-23 从零重装之后,技能段只有
 *    "接上"按钮会写,而那颗按钮界面上一直没做)—— 会话被点名去按一节不存在的规矩办;
 * 2. 窗口那只手把话送进去之后,**回答要有人去读**:那是一个要等几十秒到几十分钟、每几秒看一眼的活,
 *    一条 DSH 会话的一个回合做不了"等",它只能结束 —— 于是卡在「事务官那一轮结束」就进了
 *    「等我确认」,而那家其实还没开始回答(卡 B 在留言里点的就是这个);
 * 3. 为派一句话开一条 DSH 会话,本身就要花掉一轮模型(09-23 那次「记一句话吃掉 35 万 token」)。
 *
 * 所以:**他点了名的活,工作台直接派、直接收**。这一层全是确定的步骤(先开新对话 → 送字 →
 * 按发送 → 盯着那扇窗读回答 → 稳住了收回来 → 挪「等我确认」),没有一步要模型拿主意。
 * DSH 那条会话仍然可以派(技能里只剩一句:调 `POST /dispatch/run`),走的是同一个跑法。
 *
 * **可推翻**:要把"派"还给事务官,把 `http.ts` 里 `/butler/item` 那一支改回开会话即可,这一层不用动。
 *
 * ## 三只手
 *
 * | 手 | 怎么派 | 结果怎么收 |
 * |---|---|---|
 * | `window` | 壳 `send_text`(先按那家菜单里的「新对话」再送,按发送) | 每几秒壳 `read_reply` 读那扇窗里我们那句之后的字,连着两次一样、没有「停止」键 = 说完了 |
 * | `cli` | `codex exec --json -C <目录> -s workspace-write -o <文件>`(只有 Codex) | 进程退出后读 `-o` 那个文件 |
 * | `api` | 中转(GPT / 豆包的备用) | 同步回来 |
 *
 * 收回来之后三只手做的是同一件事:回答写进卡(`reply`)+ 挂一条 `reply` 交付物 + 挪到「等我确认」。
 * 手机首页「等你确认」那一格、看板、电话里念的都是这一份。
 */
import type {
  AgentCard, AgentCardAssignee, AgentDispatchFamily, CapCellView, JobKind, TaskAssignee, TaskBudgetView, TaskClientDispatch, TaskDeliverable, TaskDispatch, TaskDispatchBlock, TaskDispatchLane, TaskDispatchLaneInput,
  TaskLink, TaskStatus, TaskView, NoteReceipt,
} from '../protocol.ts'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { sep } from 'node:path'
import { noteCliDispatchSession } from './cliDispatchSessions.ts'
import { STATUS_TITLES, CARD_CLI_BUDGET_MINUTES, dispatchFamilyTitle, isAgentCardAssignee, isAgentDispatchFamily, isClientDispatchFamily } from '../protocol.ts'
import { dispatchHands, kimiResultOf, pickAgentFile } from './agentDispatch.ts'
import { parseReceipt } from './noteReceipt.ts'
import { handsFor } from './dispatchChoice.ts'
import { quotaBlockOf } from './dispatchChoice.ts'
import type { SkillInstallResult } from './dispatchSkills.ts'
import { canReadSkills, skillsPromptLine, skillsUnreadableWhy } from './dispatchSkills.ts'
import type { JobLog } from './jobLog.ts'
import type { ClientDispatchHelper } from './dispatchClient.ts'
import { CLIENT_DISPATCH_AGENTS, isRealSessionId, matchNewSession } from './dispatchClient.ts'
import type { ClientDispatch } from './dispatchSend.ts'
/**
 * ★ **盯窗读回话走引擎**(2026-10-02,卡「引擎接线与删复制品」):挑哪条通道、挑哪个包、
 * 过 `reply_watch` 那道闸、豆包办公那一路多读一次整扇窗,全在引擎与适配器一处 ——
 * 这一层从此不认识壳的 `read_reply`(审计第二表第 2、3、9、13 条)。
 */
import type { Engine } from './engine/engine.ts'
import { READ_SEEN_EVIDENCE } from './engine/adapter.ts'

/** 引擎读一眼回来的那一份(含「通道堵了」那一格)。 */
type AdapterReadResultLike = Awaited<ReturnType<Engine['read']>>
import { SESSION_SOURCES } from './agentSources.ts'
/** 「收场」只有一张表(`jobKey.SETTLED_TASK_STATUS`):闸、早报、日志、这里都照它。 */
import { SETTLED_TASK_STATUS } from './jobKey.ts'
import type { DispatchTarget } from './dispatchTargets.ts'
import { dispatchReadiness } from './dispatchTargets.ts'
import type { UnreadableApp } from './dispatchTargets.ts'
import {
  DISPATCH_NOTE_TEXT, dispatchMarker, dispatchPrompt, extractReply, instructionOf, promptLeaked, REPLY_MAX_CHARS, replySettled,
} from './dispatchReply.ts'
import type { DispatchRework } from './dispatchReply.ts'
import { dispatchResultOf, lastAssistantTurn, sessionByMarker } from './dispatchResult.ts'
import { sanitizeCardBudget } from './collabStore.ts'
import { askedItemNote, replyAsksHim } from './replyAsks.ts'
import type { TasksService } from './tasks.ts'
import { DISPATCH_QUEUE_LEFT_NOTE } from './tasks.ts'
import type { ExecutionLeaseStore } from './executionLease.ts'
import { featureSlug } from './selfUpdate.ts'
import type { ExecutionStore } from './taskExecutionStore.ts'
import {
  handoffCandidate, importExecutionRecord, newExecutionRecord, reduceExecution, waitUserExecution,
  type ExecutionDispatchRequest, type ExecutionFact, type ExecutionRecord,
} from './taskExecution.ts'

/** 每几秒看一眼那扇窗。 */
export const DISPATCH_POLL_MS = 4000
/** 等回答最多等多久。到点还没读到,就如实写「已发出,结果要你到那家里看」。 */
export const DISPATCH_REPLY_TIMEOUT_MS = 45 * 60 * 1000
/** 送出去之后多久还在对话区里找不到我们那一句,就当"没看到它发出去"(多半是字还在框里)。 */
export const DISPATCH_NOT_SEEN_MS = 3 * 60 * 1000
/**
 * ★ **命令行那只手的活动节流**(2026-10-29,任务书「在跑的事项要数到命令行真在跑的活」):
 * 结果日志每多出一行有效输出最多记一条 `updated`,两条之间至少隔这么久了才再记 ——
 * 不然盯窗那几拍 4 秒一读,长活一小时把账写爆。`RUN_ACTIVE_STALE_MS`(2 分钟)内
 * 有活动就算在跑,30 秒节流保证在跑的活断不了档。
 */
export const CLI_ACTIVITY_THROTTLE_MS = 30_000
/**
 * ★ 插件送到一半被杀:重启后多久之内「没核到那一句」只算「还没露面」(2026-10-21,卡「派活按家隔离」真机)。
 * 壳不跟着插件死 —— 那一下 `send_text` 在壳里照样做完,开新对话、写字、按发送要好几秒;
 * 重启那一刻去核,常常比它早。这一段之内下一拍再核,过了才如实说「不知道送没送进去」。
 */
export const DISPATCH_RECOVER_GRACE_MS = 90_000

export interface DispatchSessionLike {
  agent: string
  session_id: string
  status: string
  summary?: string
}

export interface DispatchRunDeps {
  tasks: Pick<TasksService, 'list' | 'update' | 'move' | 'comment'>
  /**
   * 派活那张选项表。`named` = 这一下是他点名的那一家;`ignoreAssignee` = **别**从卡上负责人推断点名
   * (2026-10-29,任务书「派活智能体文件与起跑换手」③:中枢按默认推荐挑的手,assignee 是中枢刚写上的,
   * 不是她点名)。两格都缺席 = 老行为(由选项表那一层按卡上负责人推断点名)。
   */
  choicesFor?: (taskId: string, input: { text: string, kind?: JobKind, named?: AgentDispatchFamily, ignoreAssignee?: true }) => Promise<DispatchChoicesView | undefined>
  runtimeContext?: (family: string, sessionId: string, cwd: string) => Promise<string | undefined>
  /** 壳(窗口那只手)。没接上时整只手缺席。 */
  helper?: ClientDispatchHelper
  /**
   * 送话那一套(拉起、叫台前、取基线、送)—— 后面是**一条引擎**,三条通道(窗口 / 协议、命令行、接口)都在它里面
   * (2026-10-03,卡「派活三只手收进引擎」:命令行 / 接口那两只手从这里搬进了引擎的登记表,`http.ts` 登的)。
   * 缺席 = 派不出去(如实说「送话那一层没接上」)。
   */
  clientDispatch?: ClientDispatch
  /**
   * ★ **一条引擎**(2026-10-02,卡「引擎接线与删复制品」):盯窗那一拍走 `engine.read` ——
   * **不送、不点、不叫台前、不开窗**,`reply_watch` 那道闸在它里面(闸只接在引擎一处)。
   * 缺席 = 读不回话(这一条如实走「等太久」那一路,不假装它没回)。
   */
  engine?: Pick<Engine, 'read'>
  /**
   * ★ **任务日志**(2026-10-02,卡 AG):在这条管线的关键点写事件(指派 → 投递 → 完成 / 读不到),
   * `GET /jobs/:id/trace` 一眼查四步。缺席 = 不记账(行为一字不变)。
   */
  jobLog?: JobLog
  /** 那个 pid 还活着没有(工作台重启之后接着等用)。 */
  alive?: (pid: number) => boolean
  /**
   * ★ 交回即核验(2026-10-27 交回闭环):CLI 手交回、卡挪进「等你确认」那一刻回调
   * (消费方做验收/留话,fire-and-forget)。缺席 = 交回后没有人核(老行为一字不变)。
   */
  onDelivered?: (taskId: string) => void
  readFile: (file: string) => Promise<string | undefined>
  /**
   * 路径在不在(2026-10-29,任务书「派活智能体文件与起跑换手」):智能体文件解析(先 project.repo 后 cwd、
   * 不存在就不带 `--agent-file`)用。缺席 = 真 `existsSync`。
   */
  exists?: (path: string) => boolean
  /**
   * 用户层目录(2026-10-29,同上):`cwdFixed` 且 cwd 落在它底下的活 = 用户层那条路,
   * 一律不带仓库那份 coder 智能体文件(交代本身已带用户层契约)。缺席 = 无用户层,不拦。
   */
  userLayerDir?: () => string | undefined
  /**
   * ★ 派发基线(2026-10-28,任务书「按产物核三个洞」洞1):派出那一刻 `git rev-parse HEAD` 于工作目录,
   * 记进 `dispatch.base_sha` 给交回核验的 diff 类当比对基线。缺席 = 不记(核验退回 merge-base HEAD main)。
   * 不是 git 仓库 / 读不出 → 回 undefined,不编。
   */
  headSha?: (cwd: string) => Promise<string | undefined>
  /** 目录门(与 `/butler/item/dispatch` 同一道:扫描根底下才许跑)。缺席 = 不拦。 */
  cwdAllowed?: (cwd: string) => Promise<boolean>
  /** 此刻的会话流(认新会话、写 links、读不到窗口时拿摘要兜底)。 */
  sessions: () => readonly DispatchSessionLike[]
  /**
   * 一条会话的那几个回合(2026-09-28,卡 RC;生产:`dshSessionFeed.turns`,与「等你」读的是同一份)。
   *
   * 两处用它,都为了**结果取最后那一段交代**:
   * ① 认会话 —— 派出去那条对话里有我们的记号(`dispatchMarker`),按它认比"新会话差集"稳;
   * ② 收结果 —— 认上会话之后,结果从**最后一个回合的完整回答**取,不取窗口里读到的中途句。
   * 缺席 = 老行为(只按差集认会话、只用窗口那一段)。
   */
  turnsOf?: (sessionId: string) => readonly { role: string, text?: string }[] | undefined
  now: () => Date
  /** 卡变了(生产:推一份快照)。 */
  onChanged?: () => void
  pollMs?: number
  replyTimeoutMs?: number
  notSeenMs?: number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
  /**
   * 他的规矩(2026-09-24,与卡 K「全局自进化」对齐的两个口;缺席 = 不附、不查,行为同没有卡 K)。
   *
   * - `rulesFor`:这件活要守的那几条规矩(卡 K 的 `rules.brief('dispatch', 原话).text`),贴在送出去那段话末尾;
   * - `review`:回答收回来、挪「等我确认」**之前**按规矩自查一遍(卡 K 的 `rules.review`)。没过:
   *   窗口那只手把 `reject_text` 送回**同一条对话**让它改**一次**(只在读回复刚看到我们那一句时送,
   *   保证那扇窗此刻开着的就是这条对话);改完还不过、或者别的手没过 → 卡挂「阻塞」写清没过哪几条,
   *   **不进「等我确认」**(卡 K:「不合格不叫他」)。
   */
  rulesFor?: (input: {
    taskId: string
    said: string
    kind?: JobKind
    /** 派活器已解析的执行上下文；不从请求 body 或配置采信，不提前写卡上负责人。 */
    dispatch?: { family: AgentDispatchFamily, assignee: TaskAssignee, target: 'new' | 'session' }
  }) => Promise<string | undefined>
  /**
   * `instruction` = 我们在他原话之外附上的那些(交代那一句、规矩那一段)。卡 K 拿它查
   * 「回答里夹着我们自己的指令 = 不合格」(2026-09-25)。
   */
  review?: (input: { taskId: string, text: string, taskText: string, instruction?: string }) => Promise<DispatchReview | undefined>
  /**
   * **这件事还有下一步**(2026-10-12,两步接力 `videoChain.ts`):回话照记、盯窗收尾,
   * 但不挪「等你确认」、不按规矩自查(那是给最后交给她的东西用的)—— 收卡的是接力那一层。
   * 缺席 = 没有接力(老行为一字不变)。
   */
  continues?: (taskId: string) => boolean
  /**
   * 这一家此刻「能改本机文件」那一格(2026-09-25,卡 O 的体检)。**写代码的活**派之前先看它:
   * 明确不行(`no`,比如 Claude 命令行没登录)就不派 —— 卡挂「阻塞」、说清为什么、给修法。缺席 = 不看(老行为)。
   */
  editCap?: (family: AgentDispatchFamily) => CapCellView | undefined
  /**
   * 能接活的每一家(2026-09-25,卡 Z:Agent 登记表算出来的 `dispatchTargets`)——
   * 名字、几只手、包标识都从这里取。缺席 = 老宿主 / 用例:退回「写过专门接法的那几家」。
   */
  targets?: () => readonly DispatchTarget[]
  /**
   * **认出是 AI 应用、可那扇窗读不到**的那几家(2026-10-01,卡「派给读不到的那家当场说」)。
   * 派进去一个字都送不到 → 开口之前当场拦下,说一句人话、不走那一串重试。缺席 = 不知道,一字不变。
   */
  unreadable?: () => readonly UnreadableApp[]
  /** 挑不到手时,卡上「换一家」列哪几家(卡 O 的选项表里能做这件活的)。缺席 = 不列。 */
  alternativesFor?: (taskId: string, family: AgentDispatchFamily, kind: JobKind) => Promise<TaskDispatchBlock['alternatives']>
  /**
   * 写代码的活**在哪个目录里干**(2026-09-25,卡 O + 统筹补充):项目是工作台自己时换成为这件事新开的独立工作区
   * (git worktree),**不在他正用着的那份仓库里切分支、改文件**;别的项目原样。开不出来就不派、说清楚。缺席 = 原样。
   * `family` = 解析后的那一家(2026-10-22 卡 D):名片派活的分支名是 `<family>/<这件事>`;非名片派活缺席(老分支名不变)。
   */
  workdirFor?: (task: TaskView, cwd: string, family?: string) => Promise<{ ok: true, cwd: string, note?: string, branch?: string } | { ok: false, why: string }>
  /**
   * 命令行的活也有时长上限(统筹 09-25 拍板 ③:跟「每件事的上限」那一份同一份设置,**这里只管时间** ——
   * 命令行花的是那家自己的额度,不是工作台的钱)。到了先停那个进程,卡上问继续 / 停掉 / 换一家。缺席 = 不管(老行为)。
   */
  cliBudget?: () => { cny: number, minutes: number } | undefined
  /** 到了先停那个进程(同外层「停掉这一件」那一下)。 */
  killPid?: (pid: number) => void
  /**
   * SIGTERM 之后它还不退,补的那一下 SIGKILL(2026-10-28,任务书「取消要收场执行者」)。
   * 生产:`process.kill(pid, 'SIGKILL')`。缺席 = 只发 SIGTERM,不补刀(老调用方一字不变)。
   */
  killPidHard?: (pid: number) => void
  /** 取消收场时 SIGTERM 之后等多久补 SIGKILL(毫秒)。缺省 10 秒。 */
  escalateAfterMs?: number
  /**
   * ★ **同事项执行持久租约**(2026-10-26,卡「事务官机制D」t-ea3ba424):同一张卡/同一棵工作树
   * 同一时刻至多一个活跃写者。写代码的活(cli 手、有工作树)在送之前先claim:
   * 同卡二派、同树另一卡一律拒(给出 holder 真身);同卡人来重派(takeover,holder 已标不确定
   * 且进程没活着的证据)才换租约。缺席 = 没有租约这一层(老行为一字不变)。
   */
  lease?: ExecutionLeaseStore
  /**
   * 把选中的技能拷进任务工作树(2026-10-21,卡 S;生产:`dispatchSkills.installSkills` 配上技能库的位置)。
   * 缺席 = 这台工作台没带技能库:带技能的活不派、说清楚;不带技能的活一字不变。
   */
  installSkills?: (input: { family: string, cwd: string, skills: readonly string[] }) => Promise<SkillInstallResult>
  /**
   * ★ **这一家同一时刻只送一件**(2026-10-21,卡「派活按家隔离」;生产:那一家没有协议那一条通道,只能靠窗口)。
   *
   * 窗口型那几家只有一扇窗:后一件开新对话会把前一件那条对话顶走,前一件的回话再也读不回来。
   * 所以后来的那件**排在前一件后面**(卡上写明排在谁后面),前一件收回 / 失败 / 被取消之后由巡检自动送。
   * 协议 / 命令行那几家各有各的线程与进程,不排。缺席 = 不排(老行为一字不变)。
   */
  exclusive?: (family: string) => boolean
  /**
   * ★ **执行记录的唯一写入口**(2026-10-29,可靠执行闭环第一批第 3 步):派出前经它持久化
   * `dispatching` + attemptId + 候选表 + 授权引用(写不上**不起子进程**);接单写 `running` 登记
   * 执行来源;起跑失败 / 退出 / 回执都先写事实再动卡。缺席 = 老行为(不持久化、不换手的兜底,
   * 只有旧宿主 / 没接推进存储的用例走这一档)。
   */
  execution?: ExecutionStore
}

/** 自查的结论(卡 K `rules.review` 的形状里用得着的那几格)。 */
export interface DispatchReview {
  pass: boolean
  /** 没过的那几条(给人看的原话)。 */
  violations?: readonly string[]
  /** 打回给那一家的原话。 */
  reject_text?: string
}

export interface DispatchStartInput {
  /**
   * 派给哪一家。**也收名片 id**(`agent:…`,2026-10-22 卡 B/D:负责人驱动把任务上的名片 id 原样传进来)——
   * 任务负责人是名片时,用哪一家 / 在哪个仓库 / 带哪个模型,由 `startNow` 按那张名片解析(一处的那个决定)。
   */
  family: AgentDispatchFamily | AgentCardAssignee
  /** 他的原话。 */
  said: string
  /** 活在哪个目录里干(事项挂了项目才有)。 */
  cwd?: string
  /**
   * 这个 `cwd` 是**工作台自己定的落点**,不是她的仓库(2026-10-01,C2「小组件派出去」:
   * 自定义小组件落 `~/.dsh/workbench/modules/<id>/`)。于是两件事跳过:
   *
   * ① **不替它开独立工作区**(`workdirFor`):那个目录不是 git 仓库,开不出来 ——
   *    而「别在她正用的仓库里改」这条顾虑在这儿本来就不存在,那不是任何仓库;
   * ② **不过「在不在你授权的那几个文件夹底下」那道门**(`cwdAllowed`):那道门拦的是
   *    「跑到她的仓库里乱改」,而这一条的落点是工作台自己签给这个模块的目录,
   *    门由**她亲手点的那一下确认**(`POST /devtool/confirm`)顶着。
   *
   * 缺席 = 老行为,一个字不变。**只有造小组件这条路传它**。
   */
  cwdFixed?: boolean
  project?: string
  /**
   * ★ **退修重派那一下**(2026-10-29,可靠执行闭环第 4 步):核验不过、退修给原执行者同一会话。
   * 被闸 / 租约 / 没登录挡下时**不把卡停进「卡住」** —— 卡回「等你确认」,执行记录 `recover` 由
   * 核验交付推进模块带 wakeAt 接着推(不挂 doing / blocked 没人执行,C#9)。缺席 = 老行为一字不变。
   */
  repair?: boolean
  /** 替不替他按发送。缺省 true(他点了名、意图已经明确,见决策记录 A2)。 */
  submit?: boolean
  /**
   * 这是什么活(2026-09-25,卡 O)。`code` = 写代码 / 改文件:**只走能改本机文件的手**(Claude / Codex 的命令行),
   * 挑不到就不派、如实说。缺席 = 老行为(照这一家按顺序的那几只手)。
   */
  kind?: JobKind
  /**
   * 这件活带哪几件技能(2026-10-21,卡 S;`third_party/skills/` 下的目录名,`/dispatch/run` 已校验过名字)。
   * 带了就只走命令行那只手、按「改文件」那一类派:派之前拷进工作树里那一家找技能的位置。
   * 读不了技能目录的那一家当场拒绝、卡一个字不改。缺席或空表 = 老行为一字不变。
   */
  skills?: readonly string[]
  /**
   * **续跑接原会话**(2026-10-23,卡「派活给名片的四处」③):到时长上限他说「继续」那一下
   * (卡面那颗键 → `resumeCli` 带它)。命令行那一次留下过会话号(`dispatch.session_id`)就照原样接着
   * (Kimi `--session` / Claude `--resume`),不从头再读一遍;没有照旧新起。缺席 = 新起(老行为)。
   */
  resume?: boolean
  /**
   * ★ 显式人工接管意图(2026-10-26 合流返工,卡「事务官机制D」缺口 3):只从可信入口
   * (她本人在页面/手机上点重派,/dispatch/run 按 asker 把关)传进来;自动/排队/恢复路
   * 永远不带。带了也不许抢:只有 holder 是这张卡、只剩不确定证据、没有活着的证据才换租约。
   */
  takeover?: boolean
  /**
   * **这一下是她点名的**(2026-10-29,任务书「派活智能体文件与起跑换手」③):只有中枢 `pickHand`
   * 的 named(command.to,或她原话里点了家)才传 true;缺席 = 中枢按默认推荐挑的,选人理由写
   * 「按默认推荐挑的」/「在跑少」,不写「你点名要」(`selectionFor` 一处说了算)。
   */
  named?: boolean
  /**
   * ★ **派发口自己的换手重派**(2026-10-29,可靠执行闭环第一批第 3 步;B#17):上一只起跑失败、
   * 候选里换下一只时带 true —— 这一下**不认卡上名片家**:名片家只在她亲手点名那一次说了算,
   * 换手是派发口按执行记录里的候选表兜底,负责人照实改成新的一家(不再被名片家覆盖回去)。
   */
  handoff?: boolean
}

/**
 * 这件事已经收场(办完 / 取消)时派活那一句(2026-10-03)。**一只手都不试、卡一个字不改** ——
 * 「收场」只有 `jobKey.SETTLED_TASK_STATUS` 一张表,闸、早报、日志、这里都照它。
 */
export const DISPATCH_SETTLED_NOTE = (who: string, status: TaskStatus): string =>
  `这件事已经「${STATUS_TITLES[status]}」了,没再派给 ${who} —— 要再来一次,先把它重新打开`

export interface DispatchStartResult {
  ok: boolean
  hand?: TaskDispatch['hand']
  /** 给人(和电话里的她)念的那一句。 */
  note: string
  /** 挑不到手没派出去时:为什么、怎么修、能换谁(卡上也挂着同一份)。 */
  block?: TaskDispatchBlock
  /**
   * ★ 这一下没派出去是因为电脑锁着屏(2026-10-12)。解锁重派那一下(`lockQueueDispatch`)据此认「还锁着」,
   * 留在队里等下一回,而不是当成送不出去拿掉。
   */
  screen_locked?: true
  /** ★ 这一件排在同一家前一件后面了(2026-10-21):`note` 是那一句「排在 X 后面」。 */
  queued?: true
}

/** 排着的那件卡上那一句(2026-10-21,卡「派活按家隔离」)。 */
export function dispatchQueuedNote(input: { who: string, behind: string }): string {
  return `排在「${input.behind}」后面:${input.who} 同一时刻只送一件,前一件收回来就送这一件`
}

/** 插件中途被杀、重启后在它对话里核不到那一句时卡上那一句(2026-10-21)。 */
export function dispatchInterruptedNote(who: string): string {
  return `插件重启时这一件正在送给 ${who},重启后在 ${who} 的对话里核不到它 —— 不知道送没送进去,为了不送两遍没再送;去 ${who} 里看一眼,没有就点重派`
}

/**
 * ★ **出队前核卡**(2026-10-23,卡「待排的卡不许被派出去」;与 `lockQueueDispatch.stillWanted`
 * 同一个判法,一处共用:**轮到它了不信队里落盘的那份交代,重读卡上的事实**):状态必须仍是
 * 「待办 / 在做」,负责人必须仍是排队时那一家 —— 或者仍是那张名片、而那张名片解析出来还是这一家。
 *
 * 回一句话 = 这件不派了(调用方撤掉排队、把 {@link DISPATCH_QUEUE_LEFT_NOTE} 写到卡上);
 * 回 undefined = 还作数,照派。
 */
export function queuedDispatchLeft(
  task: Pick<TaskView, 'status' | 'assignee'>,
  family: string,
  agentCards?: readonly Pick<AgentCard, 'id' | 'hand' | 'runtime'>[],
): string | undefined {
  if (task.status !== 'todo' && task.status !== 'doing') return DISPATCH_QUEUE_LEFT_NOTE
  if (task.assignee === family) return undefined
  const card = agentCards?.find(one => one.id === task.assignee)
  if (card !== undefined && cardDispatchFamily(card) === family) return undefined
  return DISPATCH_QUEUE_LEFT_NOTE
}

export interface DispatchRunner {
  start: (taskId: string, input: DispatchStartInput) => Promise<DispatchStartResult>
  /** 看一眼所有在等回答的派活。**绝不抛**。回这一拍改了几张卡。 */
  tick: () => Promise<number>
  /** 工作台刚起来:把重启之前没收完的接着收。 */
  resume: () => Promise<void>
  /**
   * ★ **她取消了这张卡:对在跑的那一次派发收场**(2026-10-28,任务书「取消要收场执行者」)。
   * 由 `/task/move` 挪进 `canceled` 那一跳调用(中枢 / 手机 / 板上一个口)。**绝不抛**。
   * 回包里那一句是要加在取消回话末尾的:「在跑的 X 已停」/「没停下来,原因 …」(没有可收场的则缺席)。
   */
  cancel: (taskId: string) => Promise<DispatchCancelResult>
  stop: () => void
}

/** {@link DispatchRunner.cancel} 的结果:`note` = 取消回话要加的那一句(没有可收场的缺席)。 */
export interface DispatchCancelResult {
  settled: boolean
  note?: string
}

/**
 * 几句话拼成一条 note,**同一句只说一遍**(2026-10-13,卡 F;四场景验收第 15 条)。
 *
 * 真机那条 `dispatch_note` 里草稿那句话出现了两遍:卡上那一格与送话那一层的 `confirm_note`
 * 各带了一份。根子在送话那一层已经收掉(`dispatchSend` 不再把它拼进 `confirm_note`),
 * 这一道是拼话这一头的兜底 —— 哪一头多给了一遍,念出来还是一遍。
 */
function joinOnce(lines: readonly string[]): string {
  const out: string[] = []
  for (const one of lines.flatMap(line => line.split(';'))) {
    const piece = one.trim()
    if (piece === '' || out.includes(piece)) continue
    out.push(piece)
  }
  return out.join(';')
}

/** 卡上那句"派出去了"的话。`who` = 那一家叫什么(登记表里的名字;调用方传进来)。 */
function sentNote(who: string, hand: TaskDispatch['hand'], extra = ''): string {
  if (hand === 'window') return `已经送到 ${who} 的窗口里${extra},做完我把结果收回来`
  // 界面上不说「命令行」(统筹 09-25 设计原则:按不懂技术的人说结果)。
  if (hand === 'cli') return `已经让 ${who} 在后台开始做${extra},做完我把结果收回来`
  return `${who} 回来了${extra}`
}

/** 这张卡上**正在等回答**的那一次窗口派活(只认本模块起的:带 `reply_state:'waiting'`)。 */
export function waitingWindowDispatch(task: TaskView): TaskClientDispatch | undefined {
  /*
   * 她已经把卡取消了 / 手动点了完成:不再替它读、更不再把它挪回「等我确认」。
   * ★ 「哪几种状态算收场」**只有一张表**(`jobKey.SETTLED_TASK_STATUS`;2026-10-02,审计第二表第 14 条)——
   * 从前这里与下面那一处各写一遍 `=== 'done' || === 'canceled'`,闸那边又是第三份判法。
   * 这一道留着不是第二份判断,它管的是另一件事:**这一拍还要不要接着跑**(节拍停不停、卡挪不挪)。
   */
  if (SETTLED_TASK_STATUS.includes(task.status)) return undefined
  const d = task.client_dispatch
  if (d === undefined || d.status !== 'sent' || d.reply_state !== 'waiting' || d.marker === undefined) return undefined
  return d
}

/** 这张卡上正在跑的命令行派活(本模块起的:带 `output_file`)。 */
export function runningCliDispatch(task: TaskView): TaskDispatch | undefined {
  if (SETTLED_TASK_STATUS.includes(task.status)) return undefined
  const d = task.dispatch
  if (d === undefined || d.status !== 'running' || d.hand !== 'cli' || d.output_file === undefined) return undefined
  return d
}

/**
 * 名片按哪一家派(2026-10-22 卡 D):`runtime.family` 缺席退回 `hand`;两家都不认得 → undefined(调用方如实说)。
 * 与 `itemDriver.ts` 的判法是同一个决定的两处副本 —— 都只读名片自己那两格,不许第三份。
 */
export function cardDispatchFamily(card: Pick<AgentCard, 'hand' | 'runtime'>): AgentDispatchFamily | undefined {
  const family = card.runtime?.family ?? card.hand
  return isAgentDispatchFamily(family) ? family : undefined
}

/** 任务 `from.ref` 指向 `docs/卡/…` 时,把那张卡的路径带进制令行那只手的说明书(卡 D);否则 undefined。 */
export function cardFileOf(task: Pick<TaskView, 'from'>): string | undefined {
  const ref = task.from?.ref
  return typeof ref === 'string' && ref.startsWith('docs/卡/') ? ref : undefined
}

/**
 * 工作树与分支用的**短名**(2026-10-23,卡「派活给名片的四处」①):`from.ref` 指向 `docs/卡/<卡名>.md`
 * 时用 `<卡名>`(10-22 真跑出来的名字是整条标题:带括号、带路径、几十个字,shell 里要层层引号);
 * 否则取标题前 12 个字(去标点)+ 卡号后四位防重。认不出回 undefined —— 调用方退回老的整条标题 slug,
 * 不编一个。卡名再过一道 {@link featureSlug} 的 git 分支名守卫(卡名里的空白 / 非法字符剥掉)。
 */
export function worktreeSlugOf(task: Pick<TaskView, 'id' | 'title' | 'from'>): string | undefined {
  const ref = task.from?.ref
  const cardName = typeof ref === 'string' && ref.startsWith('docs/卡/') && ref.endsWith('.md')
    ? ref.slice('docs/卡/'.length, -'.md'.length)
    : undefined
  if (cardName !== undefined) {
    const slug = featureSlug(cardName)
    return slug === undefined || slug === '' ? undefined : slug
  }
  const head = [...task.title.replace(/[\p{P}\p{S}]/gu, '').replace(/\s+/g, '')].slice(0, 12).join('')
  if (head === '') return undefined
  const tail = task.id.slice(-4)
  return featureSlug(tail === '' ? head : `${head}-${tail}`)
}

/** `codex exec --json` 的事件流里第一个 thread id(取不到回 undefined)。 */
export function threadIdOf(log: string): string | undefined {
  for (const line of log.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    try {
      const event = JSON.parse(trimmed) as Record<string, unknown>
      const id = event.thread_id ?? (event.msg as Record<string, unknown> | undefined)?.thread_id ?? event.session_id
      if (typeof id === 'string' && id !== '') return id
    }
    catch { /* 半截行跳过 */ }
  }
  return undefined
}

/**
 * 结果日志(每行一个 JSON)里那家留下的**会话号**:从后往前认第一个字符串的 `session_id`
 * (Kimi 的 `session.resume_hint`、Claude 结果 JSON)/ `thread_id`(Codex)。半截行跳过;
 * 认不出回 undefined(续跑退回新起,老行为)。
 */
export function cliSessionIdOfLog(family: string, log: string): string | undefined {
  const key = family === 'codex' ? 'thread_id' : 'session_id'
  const lines = log.split('\n')
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const trimmed = (lines[i] as string).trim()
    if (!trimmed.startsWith('{')) continue
    try {
      const id = (JSON.parse(trimmed) as Record<string, unknown>)[key]
      if (typeof id === 'string' && id !== '') return id
    }
    catch { /* 半截行跳过 */ }
  }
  return undefined
}

/** 命令行失败时给人看的那一句:日志里最后一条像错误的事件,或者退出码。 */
export function cliFailureNote(code: number | null, log: string): string {
  const lines = log.split('\n').map(line => line.trim()).filter(line => line !== '')
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i] as string
    try {
      const event = JSON.parse(line) as Record<string, unknown>
      const message = event.message ?? (event.error as Record<string, unknown> | undefined)?.message
      if ((event.type === 'error' || event.type === 'turn.failed') && typeof message === 'string') return message.slice(0, 300)
    }
    catch {
      if (/error|错误|failed/i.test(line)) return line.slice(0, 300)
    }
  }
  return code === null ? '进程被停掉了' : `退出码 ${code}`
}

/**
 * Claude 命令行 `--output-format json` 的结果(标准输出最后那条 `{"type":"result",…}`)。
 * `error` = 它自己说没做成(`is_error` / 不是 success,比如「Not logged in · Please run /login」),`text` 就是它的原话。
 * 找不到那一条回 undefined(进程被停掉、半截输出)。
 */
export function claudeResultOf(log: string): { text: string, error: boolean, session_id?: string } | undefined {
  const lines = log.split('\n').map(line => line.trim()).filter(line => line.startsWith('{'))
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const event = JSON.parse(lines[i] as string) as Record<string, unknown>
      if (event.type !== 'result') continue
      const text = typeof event.result === 'string' ? event.result.trim() : ''
      const error = event.is_error === true || (typeof event.subtype === 'string' && event.subtype !== 'success')
      return { text, error, ...(typeof event.session_id === 'string' && event.session_id !== '' ? { session_id: event.session_id } : {}) }
    }
    catch { /* 半截行跳过 */ }
  }
  return undefined
}

/**
 * 交回来的话 → 回执那两格(2026-10-21 协作区,设计稿第五节第 5 条)。**只对写了验收的便签判**:
 * 那种便签的派活说明里要过三种开头,认得出就记回执、认不出标「回执不规范」;
 * 没写验收的老卡派活说明里没要过这一条,不给它挂一个它没被要求过的「不规范」。
 */
function receiptPatch(task: Pick<TaskView, 'acceptance' | 'from' | 'assignee'>, reply: string, at: string, by: string): { receipt?: NoteReceipt | null, receiptIrregular?: boolean | null } {
  if ((task.acceptance ?? []).length === 0) return {}
  const hit = parseReceipt(reply)
  return hit === undefined
    ? { receiptIrregular: true }
    : { receipt: { kind: hit.kind, text: hit.text.slice(0, 2000), by: task.assignee ?? by, at, ...(task.from?.kind === 'channel' && task.from.ref !== undefined ? { message_id: task.from.ref } : {}) }, receiptIrregular: null }
}

/** 交回来之后进哪个章:回执说「卡住」进卡住,其余照旧进「等你」(只有他点才进做完)。 */
function landingOf(task: Pick<TaskView, 'acceptance'>, reply: string): TaskStatus {
  if ((task.acceptance ?? []).length === 0) return 'confirm'
  return parseReceipt(reply)?.kind === 'blocked' ? 'blocked' : 'confirm'
}

function appendReply(task: TaskView, reply: string, sessionId?: string): readonly TaskDeliverable[] {
  const ref = reply.length > 2000 ? `${reply.slice(0, 2000)}…` : reply
  return [...(task.deliverables ?? []), { kind: 'reply', ref, ...(sessionId === undefined ? {} : { session_id: sessionId }) }]
}

/**
 * 把那家新开的那条会话挂到卡上(`links`)。**只有有自己会话流的那几家**挂得上
 * (`agentSources.ts` 的 `SESSION_SOURCES`:Claude / Codex / Kimi)—— 别家的「会话」是读窗口读出来的一条,
 * 没有会话 id 可挂,如实不挂(这不是名单,是「有没有会话文件」这件事实)。
 */
function withLink(task: TaskView, agent: string, sessionId: string): readonly TaskLink[] | undefined {
  const binding = SESSION_SOURCES.find(one => one.agent === agent && one.self !== true)
  if (binding === undefined) return undefined
  const links = task.links ?? []
  if (links.some(one => one.session_id === sessionId)) return undefined
  return [...links, { agent: binding.agent as TaskLink['agent'], session_id: sessionId }]
}

export function createDispatchRunner(deps: DispatchRunDeps): DispatchRunner {

  /** 这一家叫什么:登记表那一份(卡 Z)优先,拿不到退回家名那张表,再退回原样。 */
  function targetTitleOf(family: string): string {
    return deps.targets?.().find(one => one.id === family)?.title ?? dispatchFamilyTitle(family)
  }
  const pollMs = deps.pollMs ?? DISPATCH_POLL_MS
  const replyTimeoutMs = deps.replyTimeoutMs ?? DISPATCH_REPLY_TIMEOUT_MS
  const notSeenMs = deps.notSeenMs ?? DISPATCH_NOT_SEEN_MS
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => setInterval(fn, ms))
  const clearTimer = deps.clearTimer ?? ((handle: unknown) => clearInterval(handle as ReturnType<typeof setInterval>))
  /** 上一次读回来的回答(稳住判据用)。只活在内存里:重启之后多读一拍而已。 */
  const lastRead = new Map<string, string>()
  /** 送出去之后第一次在对话区里看到我们那一句的时刻。 */
  const seenAt = new Map<string, number>()
  /** 正在收尾的命令行派活(同一张卡别收两遍)。 */
  // Sending a replacement and collecting its predecessor cannot write the same task concurrently.
  const taskOperations = new Map<string, Promise<void>>()
  async function forTask<T>(id: string, run: () => Promise<T>): Promise<T> {
    const prior = taskOperations.get(id)
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    taskOperations.set(id, held)
    await prior
    try { return await run() }
    finally { release(); if (taskOperations.get(id) === held) taskOperations.delete(id) }
  }
  const finishing = new Set<string>()
  /**
   * ★ **巡检按家分开**(2026-10-21):哪几家这一圈还没巡完(上一圈没完的那一家这一拍跳过,别家照巡)。
   * 从前是一个 `ticking`:一圈里逐张卡顺序等读窗,一家读不动所有别家都没人盯。
   */
  const roundBusy = new Set<string>()
  let cliBusy = false
  /** 这个进程此刻正在送的那几件(家 → 事项)。落盘那一格(`dispatch_lane.sending`)重启后靠它分出「是不是我在送」。 */
  const sendingNow = new Map<string, string>()
  /** 读窗刚从「堵了」通回来的时刻:「没看到那一句」的三分钟从这一刻重新算(堵着的时候读不到不算没看到)。 */
  const jamEndedAt = new Map<string, number>()
  let timer: unknown

  async function findTask(id: string): Promise<TaskView | undefined> {
    try { return (await deps.tasks.list()).tasks.find(one => one.id === id) }
    catch { return undefined }
  }

  /**
   * 挪状态:能直接到就直接到,到不了先过「进行中」(todo → doing → confirm)。
   *
   * ★ **他已经完成 / 取消了的卡,后台一格都不挪**(2026-09-25,卡 fix/confirm-cancel,统筹:「用户取消了的,
   * 任何后台回写都不许把它挪回来」)。「取消」按转换表本来就挪不回「等我确认」,但「完成」→「进行中」是合法的
   * (那是给他亲手重开用的)—— 派活送字 / 等接口回话那几秒里他点了完成,这里要是照走「先过进行中」,
   * 就是后台替他把一件已经收掉的事重新打开。
   */
  async function moveTo(id: string, status: TaskStatus): Promise<void> {
    const task = await findTask(id)
    if (task === undefined || task.status === status) return
    if (task.status === 'done' || task.status === 'canceled') return
    const first = await deps.tasks.move(id, status)
    if (first.ok) return
    if (status !== 'doing') {
      const via = await deps.tasks.move(id, 'doing')
      if (via.ok) await deps.tasks.move(id, status)
    }
  }

  function changed(): void {
    try { deps.onChanged?.() } catch { /* 推快照失败不连累派活 */ }
  }

  function ensureTimer(): void {
    if (timer !== undefined) return
    timer = setTimer(() => { void tick() }, pollMs)
  }

  /* —— 执行记录(第 1 步的推进存储):派发口是唯一的写方;事实先落盘,再动卡。 —— */

  /** 老卡没有记录时从可验证的旧字段导入,再不行给一条新的 ready 记录(调用方再往里提交事实)。 */
  function executionBaseOf(task: TaskView, current: ExecutionRecord | undefined): ExecutionRecord {
    return current ?? importExecutionRecord(task) ?? newExecutionRecord(task.id, task.round ?? 1)
  }

  /** 提交一条事实(best-effort:写不上不连累派发 / 收尾本身;派前那一道不在此列)。回 reduce 后的记录。 */
  async function submitExecutionFact(taskId: string, fact: ExecutionFact): Promise<ExecutionRecord | undefined> {
    if (deps.execution === undefined) return undefined
    try {
      const current = await deps.execution.read(taskId)
      if (current === undefined) return undefined
      const next = reduceExecution(current, fact)
      if (next === current) return current
      if (!await deps.execution.compareAndSet(taskId, current.version, next)) return current
      return next
    }
    catch { return undefined }
  }

  /**
   * ★ **派前持久化**(2026-10-29,可靠执行闭环第一批第 3 步①):送出之前把这一次执行写进记录
   * (`dispatching` + attemptId + 候选表 + 授权引用 + 原交代)。写不上 / 事实被忽略(旧计划、终态)
   * → 回 false,调用方**不起子进程** —— 账里没有这件事,宁可不派,也不派出去一个没法恢复、
   * 没法换手的东西。
   */
  async function persistDispatchPrepared(task: TaskView, family: string, attemptId: string, selection: DispatchSelection, named: boolean | undefined, request: ExecutionDispatchRequest): Promise<boolean> {
    if (deps.execution === undefined) return true
    try {
      const current = await deps.execution.read(task.id)
      const base = executionBaseOf(task, current)
      const fact: ExecutionFact = {
        kind: 'dispatch_prepared', attemptId, planVersion: base.planVersion,
        at: deps.now().toISOString(), family,
        candidates: selection.candidates.filter(one => one.ok).map(one => one.family),
        authorizationRef: named === true ? 'named' : 'delegated',
        request,
      }
      const next = reduceExecution(base, fact)
      if (next === base) return false
      return await deps.execution.compareAndSet(task.id, current?.version ?? 0, next)
    }
    catch { return false }
  }

  /**
   * ★ **起跑失败换手判据**(任务书②,从执行记录读,不再凭内存三张表):已试过的家 =
   * 痕迹里 `startup-failed` 的家(去重,顺序照旧)。记录缺席(老宿主那一档)→ 只认当前这家。
   */
  async function startupFailuresOf(taskId: string, currentFamily: string): Promise<{ tried: readonly string[], reasons: readonly string[], record: ExecutionRecord | undefined }> {
    const record = deps.execution === undefined ? undefined : await deps.execution.read(taskId).catch(() => undefined)
    const failed = (record?.attempts ?? []).filter(one => one.outcome === 'startup-failed')
    const tried = [...new Set([...failed.map(one => one.family), currentFamily])]
    const reasons = failed.map(one => `${targetTitleOf(one.family)}:${one.reason ?? '没起跑'}`)
    return { tried, reasons, record }
  }

  async function start(taskId: string, input: DispatchStartInput): Promise<DispatchStartResult> {
    // 派活是后台跑的(建事项那条路不等它):任何一步抛出来都不许变成一个没人接的异常。
    // ctx 贯通 start 与 startUnlocked:attemptId 供 catch 精确认领;processOut 标「进程真交出去了」
    // (卡「事务官机制D」缺口 5:send 已起进程、写卡失败时,绝不许把还在跑的作者的锁放掉)。
    const ctx: { attemptId?: string, processOut: boolean } = { processOut: false }
    return await forTask(taskId, async () => {
      try { return await startUnlocked(taskId, input, ctx) }
      catch (error) {
        if (sendingNow.get(input.family) === taskId) sendingNow.delete(input.family)
        /*
         * ★ **抛出来的那一次也要写到卡上**(2026-09-30 止血,根子 3)。
         *
         * 以前这里只回一句 `ok:false`,而调用它的那条路(`http.ts` 的 `void started.catch(() => {})`)
         * 把它吞了 —— 卡上一个字都没有、事项停在「待办」,嘴上还说着「正在派」。
         * 现在:卡挂「运行失败」+ 原话(现成的来电规矩据此打一通,见 `callOut.ts` 的 blocked/error 那一档)。
         */
        // ★ 租约兜底(卡「事务官机制D」):**进程已交出去就绝不动锁**(它在跑,退出那一下自己放);
        // 只有确认没起进程,才按 attemptId 放 not-started。宁可留着由人看,不凭异常乱放手。
        if (!ctx.processOut && ctx.attemptId !== undefined) {
          try { await deps.lease?.release({ taskId, runId: ctx.attemptId, evidence: 'not-started', at: deps.now().toISOString() }).catch(() => undefined) }
          catch { /* 兜底失败不盖过原异常 */ }
        }
        const note = `派给 ${targetTitleOf(input.family)} 时出错了:${error instanceof Error ? error.message : String(error)}`
        try {
          await deps.tasks.update(taskId, { note, assignee: input.family, dispatchLane: null })
          // 退修重派那一下(第 4 步)出同样不把车停进「卡住」:卡回「等你确认」,恢复记录接着推。
          if (input.repair !== true) {
            await moveTo(taskId, 'blocked')
            await deps.tasks.update(taskId, { blockReason: 'error' })
          }
          changed()
        }
        catch { /* 连写卡都失败:回包里那一句还是要如实说 */ }
        return { ok: false, note }
      }
    })
  }

  async function selectionFor(taskId: string, family: AgentDispatchFamily, said: string, kind?: JobKind, cardName?: string, named?: boolean): Promise<{ selection: DispatchSelection, quotaBlock?: { why: string } }> {
    /*
     * ★ 点名位(2026-10-29,任务书「派活智能体文件与起跑换手」③):她点名的才把 named 传给选项表
     * (理由里「你点名要 X 做」);中枢按默认推荐挑的(assignee 是中枢刚写上的)传 `ignoreAssignee`,
     * 不许那一层按卡上负责人把这一下误记成点名。
     */
    const evaluated = await deps.choicesFor?.(taskId, {
      text: said, ...(kind === undefined ? {} : { kind }),
      ...(named === true ? { named: family } : { ignoreAssignee: true as const }),
    }).catch(() => undefined)
    /*
     * ★ 派活前额度预检(2026-10-28,演示断点①):这一家额度查实是 0 → 不派。判据与选项表同一处
     * (`dispatchChoice.quotaBlockOf`,「没读到数」不是零、不拦);卡挂「等你处理」、回话建议换一张名片。
     */
    const quotaBlock = evaluated === undefined ? undefined : quotaBlockOf({ family, options: evaluated.options })
    /*
     * 头一句(2026-10-29,同任务书③):她点名的照旧「按本次指定的负责人执行」(点名那句在选项表
     * default_why 里);中枢挑的写「按默认推荐挑的」(= 选项表默认项)或「在跑少」(挑了默认项之外、
     * 在跑少的那只),不写「你点名要」。
     */
    const head = cardName !== undefined
      ? `按你选的名片${cardName}执行`
      : named === true
        ? '按本次指定的负责人执行'
        : evaluated === undefined || evaluated.default === family
          ? '按默认推荐挑的'
          : '在跑少'
    /*
     * 中间那句(选项表的 default_why)也得守点名位:她没点名而选项表仍把这一下标成 named
     * (没认 `ignoreAssignee` 的老接线 / 第三方宿主)时,「你点名要」不许进 reason —— 只留头一句
     * 与额度那一格。她真点名(named:true)或选项表标的不是 named 时,原样用 default_why。
     */
    const middle = evaluated === undefined
      ? ';额度与候选未核实'
      : `;${evaluated.default === family
        ? named === true || evaluated.default_from !== 'named' ? evaluated.default_why : ''
        : '保留这件事的负责人'};${evaluated.options.find(one => one.family === family)?.balance?.text ?? '额度未核实'}`
    return {
      selection: {
        evaluated_at: deps.now().toISOString(), family,
        reason: `${head}${middle}`,
        candidates: (evaluated?.options ?? []).map(one => ({ family: one.family, ok: one.ok, quota: one.balance?.text ?? '额度未核实', level: one.balance?.stale === true ? 'unknown' : one.balance?.level ?? 'unknown', ...(one.balance?.read_at === undefined ? {} : { read_at: one.balance.read_at }) })),
      },
      ...(quotaBlock === undefined ? {} : { quotaBlock }),
    }
  }

  async function startNow(taskId: string, input: DispatchStartInput): Promise<DispatchStartResult> {
    return await start(taskId, input)
  }
  async function startUnlocked(taskId: string, input: DispatchStartInput, ctx?: { attemptId?: string, processOut: boolean }): Promise<DispatchStartResult> {
    const said = input.said.trim()
    if (said === '') return { ok: false, note: '要派的话是空的,没派' }
    // 退修重派那一下(第 4 步):被挡下不把车停进「卡住 / 运行失败」,卡回「等你确认」由恢复记录接着推。
    const park = input.repair !== true
    const listed = await (async () => { try { return await deps.tasks.list() } catch { return undefined } })()
    const task = listed?.tasks.find(one => one.id === taskId)
    if (task === undefined) return { ok: false, note: '没有这个事项' }
    // 下面 afterSend 是函数声明,收窄传不进去;回执与落点读的是这一张(合并 main 的按家隔离时补)。
    const card: TaskView = task
    // 收场了的卡(她点了完成 / 取消)一只手都不试(2026-10-03,审计第二节第 3 条):
    // 从前只在窗口那只手上由闸拦,命令行 / 接口那两只手照走 —— 她已经取消的交代仍可能被执行。
    if (SETTLED_TASK_STATUS.includes(task.status)) return { ok: false, note: DISPATCH_SETTLED_NOTE(targetTitleOf(String(input.family)), task.status) }
    /**
     * 负责人是名片(2026-10-22,卡「名片补四样与Kimi命令行手」B+D):用哪一家 / 在哪个仓库 / 带哪个模型与
     * 智能体文件,都按**那张名片**起(这一处说了算,所有派活入口共用):family 取 runtime.family(缺席退回
     * hand),cwd 取 project.repo(没有才退回任务挂的项目)。名片被删了 / 没写命令行家:不派,卡上说清。
     * ★ 换手重派(handoff,第 3 步 B#17)除外:那一档不认名片 —— 名片家只在她亲手点名那一次说了算,
     * 派发口按候选表换下来的新的一家要照实落卡,不能被名片家覆盖回去。
     */
    const assigneeCard = input.handoff === true ? undefined
      : task.assignee !== undefined && isAgentCardAssignee(task.assignee)
        ? (listed?.agent_cards ?? []).find(one => one.id === task.assignee)
        : undefined
    if (task.assignee !== undefined && isAgentCardAssignee(task.assignee) && assigneeCard === undefined) {
      return await blockDispatch(taskId, input.family as AgentDispatchFamily, input.kind ?? 'chat', '这张便签挂的 Agent 名片已经没有了 —— 在卡上换一张名片,或把负责人改成别家再派', undefined, false, false, task.assignee, undefined, park)
    }
    if (assigneeCard !== undefined && cardDispatchFamily(assigneeCard) === undefined) {
      return await blockDispatch(taskId, input.family as AgentDispatchFamily, input.kind ?? 'chat', `这张名片(${assigneeCard.name})没写能派活的命令行家 —— 在名片里补上「命令行」是哪一家再派`, undefined, false, false, assigneeCard.id, undefined, park)
    }
    const family: AgentDispatchFamily = assigneeCard === undefined
      ? input.family as AgentDispatchFamily
      : cardDispatchFamily(assigneeCard) as AgentDispatchFamily
    /** 派完之后负责人写谁:名片任务保留名片 id(卡 B),其余照旧写家名。 */
    const landed: TaskAssignee = assigneeCard !== undefined && task.assignee !== undefined ? task.assignee : family
    const who = targetTitleOf(family)
    /**
     * 带哪几件技能(2026-10-22,卡「用户层技能生效」B):交代里点名带了(非空)就按点名的;没点名而这张
     * 便签挂的名片勾了技能 → 按名片带。带技能一律按「改文件」那一类派(同 `/dispatch/run` 那一处的规矩),
     * 所以名片勾了技能的活,kind 说 chat 也走 code。
     */
    const skills = input.skills !== undefined && input.skills.length > 0 ? [...input.skills] : [...(assigneeCard?.skills ?? [])]
    const kind = skills.length > 0 ? 'code' : input.kind
    /** 任务 from.ref 指向 docs/卡/… 时,说明书里带卡文件路径(卡 D)。 */
    const cardFile = cardFileOf(task)
    /** 名片给了模型才带(卡 D):命令行那家照它拼参数(claude `--model` / kimi `-m` / codex `-m`)。 */
    const cardModel = (assigneeCard?.model?.name ?? '').trim()
    const cliModel = cardModel === '' ? undefined : cardModel
    /** 名片给的智能体文件原样(解析在 cwd 定下来之后,`pickAgentFile` 一处,2026-10-29 任务书)。 */
    const cardInstructions = (assigneeCard?.instructions ?? '').trim()
    /**
     * 时长上限按名片定(2026-10-23 卡「派活给名片的四处」③):名片写了 `budget.minutes` 按名片;
     * 没写按命令行家缺省 120(`CARD_CLI_BUDGET_MINUTES` —— 全局设置里那 10 分钟把第一张卡读到
     * 一半就停了)。只认 1..1440 的整数,形状不对当没写。派出那一刻记进 `dispatch.budget_minutes`。
     */
    const cardBudgetMinutes = sanitizeCardBudget(assigneeCard?.budget)?.minutes
    /*
     * 续跑接原会话(2026-10-23 卡「派活给名片的四处」③):「继续」那一下(resume:true)且上一次
     * 命令行活留下过会话号,就照原样接着(Kimi `--session` / Claude `--resume`)—— 那家不用从头
     * 再读一遍。会话号缺席照旧新起(老行为一字不变)。
     */
    const previousCli = task.dispatch?.family === family ? task.dispatch : undefined
    const previousClient = task.client_dispatch?.family === family ? task.client_dispatch : undefined
    const previous = previousCli !== undefined && (previousClient === undefined || Date.parse(previousCli.started_at) >= Date.parse(previousClient.at)) ? previousCli : previousClient
    const resumeSessionId = input.resume === true && previous?.session_id !== undefined && previous.session_id !== '' ? previous.session_id : undefined
    /**
     * ★ **重派 / 退修那一段**(2026-10-28,卡「重派派发词带补话与轮次」;0.4.170 真机第二句的机制洞):
     * 同一家重派(restart / 卡上重派键)时,卡上**上一轮派发之后**新落的用户评论(中枢 supplement 落的补话)
     * 原句逐条带上;轮次用卡上 `round`(服务端在 confirm/done → doing 时 +1 的那一份,不另记一本),
     * 拼词这一刻新一轮还没挪状态,所以是 `round + 1`;上一轮交回的可合并号 / 独立工作区分支从卡上
     * 上一次派发记录认。「继续」(resume)接原会话那一轮不带 —— 那是同一轮的延长,不是退修。
     * 首派(卡上没有上一次派发)这一段整个缺席,派发词与改前逐字相同。
     */
    const rework: DispatchRework | undefined = (() => {
      if (previous === undefined || resumeSessionId !== undefined) return undefined
      const startedAt = 'started_at' in previous ? previous.started_at : previous.at
      const since = Date.parse(startedAt)
      const supplements = (task.comments ?? [])
        .filter(one => (one.by === 'user' || one.by === 'me') && !Number.isNaN(since) && Date.parse(one.at) > since)
        .map(one => one.text.trim())
        .filter(one => one !== '')
      const reply = (previous.reply ?? '').trim()
      const merge = /可合并[:：]?\s*([0-9a-f]{6,40})/i.exec(reply)?.[1]
      const branch = 'branch' in previous ? previous.branch : undefined
      const replyHead = reply === '' ? undefined : reply.slice(0, 60)
      if (supplements.length === 0 && merge === undefined && branch === undefined && replyHead === undefined) return undefined
      return {
        round: (task.round ?? 1) + 1,
        ...(merge === undefined ? {} : { merge }),
        ...(branch === undefined ? {} : { branch }),
        ...(replyHead === undefined ? {} : { replyHead }),
        supplements,
      }
    })()
    const { selection, quotaBlock } = await selectionFor(taskId, family, said, kind, assigneeCard?.name, input.named)
    const runtime: DispatchRuntime = {
      attempt_id: randomUUID(), ...(resumeSessionId === undefined ? {} : { session_id: resumeSessionId }), mode: resumeSessionId === undefined ? 'new' : 'resume', started_at: deps.now().toISOString(),
      requested: { ...(cliModel === undefined ? {} : { model: cliModel }), ...(assigneeCard?.model?.effort === undefined ? {} : { effort: assigneeCard.model.effort }) },
      observed: {}, status: 'unverified',
    }
    const selectionLine = `\n\n本次分工依据：${selection.reason}`
    const basePrompt = dispatchPrompt({
      taskId, said,
      ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
      ...(input.project === undefined ? {} : { project: input.project }),
      ...(task.acceptance === undefined ? {} : { acceptance: task.acceptance }),
      ...(kind === 'code' ? { cli: { cardFile } } : {}),
      ...(rework === undefined ? {} : { rework }),
    }) + selectionLine
    /**
     * 他的规矩(卡 K):有就贴在末尾。拿不到不挡派活 —— 规矩是加分项,不是门。
     *
     * ★ 2026-09-27(卡 MS):**只有写代码的活才附**。
     *
     * 21:23 那一通他说「找豆包,让他把这几天我跟他聊的内容总结一下」—— 发给豆包的正文里附了一整段
     * 「他的规矩」:派活分工写着 Claude / Codex / Kimi、构建用 taskpolicy、设计上警惕打补丁……
     * 与这件活一点关系都没有,还把内部口径发到了一家外面的 AI 那里。
     *
     * ★ 2026-09-27(卡 MS):**这件活是哪一类要一起交上去**(`kind`)。聊天 / 问答 / 捎话那一类
     * 只附这件活真沾到的那几块(界面 / 内容),全局那一批一条不附 —— 21:23 那一通发给豆包的正文里
     * 附了派活分工与构建规矩,与「把这几天聊的内容总结一下」毫无关系,还把内部口径发了出去。
     * 挑哪几条在一处判(`rules.ts` 的 `dispatchRulesBlock`),这里只把类别递过去。
     */
    let rulesBlock: string | undefined
    try {
      rulesBlock = (await deps.rulesFor?.({
        taskId, said, ...(input.kind === undefined ? {} : { kind: input.kind }),
        dispatch: { family, assignee: landed, target: resumeSessionId === undefined ? 'new' : 'session' },
      }))?.trim()
    }
    catch { rulesBlock = undefined }
    const prompt = rulesBlock === undefined || rulesBlock === '' ? basePrompt : `${basePrompt}\n\n${rulesBlock}`
    const marker = dispatchMarker(taskId)
    // 这一家按顺序有哪几只手:登记表那一份(卡 Z)优先,拿不到退回「写过专门接法的那几家」。
    const target = deps.targets?.().find(one => one.id === family)
    const hands = kind === undefined
      ? (target?.hands ?? dispatchHands(family))
      : handsFor(target ?? family, kind)
    // 带技能的活(卡 S):窗口与接口那两只手看不到文件夹 —— 不是派不出去,是这件活不该交给它,所以只回一句、卡不动。
    if (skills.length > 0) {
      if (!canReadSkills(family)) return { ok: false, note: skillsUnreadableWhy(who) }
      if (kind !== 'code') return { ok: false, note: '带技能的活要按「改文件」那一类派(kind 是 code),这次没派' }
      if (deps.installSkills === undefined) return { ok: false, note: '这台工作台没带技能库,带技能的活派不了' }
    }
    /*
     * ★ **这台电脑上压根没有这一家 → 当场说,不走那一串重试**(2026-09-28,卡 CF)。
     *
     * 判据是同步的、与建卡那一头同一个函数(`dispatchReadiness`):候选里(登记表 + 本机探测)
     * 找不到它,后面窗口/命令行/接口那三只手一步都不用试。挂的是「等你处理」而不是「运行失败」——
     * 派不出去是在等他换一家 / 装上它,不是出了错;于是也不会再多一通「插一句:没成」
     * (那句话工具已经当场回给她了)。
     */
    const known = deps.targets === undefined
      ? undefined
      : dispatchReadiness({ family, targets: deps.targets(), ...(deps.unreadable === undefined ? {} : { unreadable: deps.unreadable() }) })
    /*
     * ★ 2026-10-01:**读不到它窗口的那一家**(新版 Kimi 这一类)也走这一支。那一句已经是完整的人话
     * (「X 这台读不到它的窗口,派不了 —— 换 … 吗?」),所以卡上那句 note **原样用它**,
     * 不再套「没派给 X:…;也可以先交给 …」那层壳 —— 同一件事说两遍只会更难懂。
     */
    if (known !== undefined && !known.ok) {
      return await blockDispatch(taskId, family, kind ?? 'chat', known.why, undefined, known.unreadable === true, false, landed, undefined, park)
    }
    /*
     * ★ 派活前额度预检(2026-10-28,演示断点①):这一家额度查实是 0 → 不派,卡挂「等你处理」,
     * 回话说清、列能换的几家(与「找不到这一家」同一处置;判据在 `dispatchChoice.quotaBlockOf` 一处)。
     */
    if (quotaBlock !== undefined) {
      return await blockDispatch(taskId, family, kind ?? 'chat', quotaBlock.why, undefined, false, false, landed, 'quota', park)
    }
    let cwd = resumeSessionId === undefined ? input.cwd ?? assigneeCard?.project?.repo : previous?.cwd
    /** 独立工作区的分支(别的项目:`workbench/<名>`;卡 O,统筹拍板 ②;名片派活:`<family>/<名>`,2026-10-22 卡 D)。 */
    let branch: string | undefined = resumeSessionId === undefined || previous === undefined || !('branch' in previous) ? undefined : previous.branch

    // 写代码的活(卡 O):先看这家有没有能改本机文件的手、那只手这会儿能不能用、在哪个目录里改 ——
    // 任何一样不成就**不派**,卡上说清为什么、给修法与能换的几家。不假装派出去。
    if (kind === 'code') {
      if (hands.length === 0) {
        return await blockDispatch(taskId, family, kind, `${who} 只能聊天,改不了你电脑上的文件 —— 写代码的活要派给能改文件的那家`, undefined, false, false, landed, undefined, park)
      }
      const cap = deps.editCap?.(family)
      if (cap !== undefined && cap.state === 'no') return await blockDispatch(taskId, family, kind, cap.note, cap.fix, false, false, landed, undefined, park)
      // 名片写了仓库:活在它底下干(没有才退回任务挂的项目,卡 D)。
      const cardRepo = (assigneeCard?.project?.repo ?? '').trim()
      if (cardRepo !== '' && resumeSessionId === undefined) cwd = cardRepo
      if (cwd === undefined) {
        return await blockDispatch(taskId, family, kind, '这件写代码的活还没归到项目,不知道在哪个仓库里改 —— 先把它归到一个项目再派', undefined, false, false, landed, undefined, park)
      }
      if (deps.workdirFor !== undefined && input.cwdFixed !== true && resumeSessionId === undefined) {
        const workdir = await deps.workdirFor(task, cwd, assigneeCard === undefined ? undefined : family)
        if (!workdir.ok) return await blockDispatch(taskId, family, kind, workdir.why, undefined, false, false, landed, undefined, park)
        cwd = workdir.cwd
        branch = workdir.branch
      }
    }
    // 带技能:拷进最终那个工作目录(独立工作区开出来之后),一件不成就不派。
    if (skills.length > 0 && deps.installSkills !== undefined && cwd !== undefined) {
      const put = await deps.installSkills({ family, cwd, skills })
      if (!put.ok) return await blockDispatch(taskId, family, 'code', put.why, undefined, false, false, landed, undefined, park)
    }
    /*
     * ★ **智能体文件解析**(2026-10-29,任务书「派活智能体文件与起跑换手」①②③,`pickAgentFile` 一处):
     * 相对路径先 project.repo 后任务 cwd,第一个存在的 wins;不存在就不带 `--agent-file` 照样派,
     * 名片给了路径的卡上 note 一句;用户层那条路(cwdFixed 且 cwd 在用户层目录)一律不带。
     * 只认 Kimi 新起那一下 —— 续跑会话里智能体已绑死(带了两样同用 Kimi 直接退),Claude / Codex 不认这一格。
     */
    const cardRepoTrimmed = (assigneeCard?.project?.repo ?? '').trim()
    const layerDir = deps.userLayerDir?.()
    const inUserLayer = input.cwdFixed === true && layerDir !== undefined && layerDir !== '' && cwd !== undefined
      && (cwd === layerDir || cwd.startsWith(`${layerDir}${sep}`))
    const agentPick = family === 'kimi' && resumeSessionId === undefined && cwd !== undefined
      ? pickAgentFile({
        ...(cardInstructions === '' ? {} : { instructions: cardInstructions }),
        ...(cardRepoTrimmed === '' ? {} : { repo: cardRepoTrimmed }),
        cwd,
        ...(inUserLayer ? { userLayer: true } : {}),
        exists: deps.exists ?? existsSync,
      })
      : undefined
    const skillsLine = skills.length > 0 && canReadSkills(family) ? skillsPromptLine(family, skills) : undefined
    const promptFor = (): string => {
      const withRules = (() => {
        if (cwd === input.cwd) return prompt
        const base = dispatchPrompt({
          taskId, said,
          ...(cwd === undefined ? {} : { cwd }),
          ...(input.project === undefined ? {} : { project: input.project }),
          ...(task.acceptance === undefined ? {} : { acceptance: task.acceptance }),
          // 命令行那只手多带三行(卡 D):仓库(独立工作区绝对路径与分支)、卡文件、交回格式。
          ...(kind === 'code' ? { cli: { ...(cwd === undefined ? {} : { worktree: cwd }), ...(branch === undefined ? {} : { branch }), cardFile } } : {}),
          ...(rework === undefined ? {} : { rework }),
        })
        const selectedBase = base + selectionLine
        return rulesBlock === undefined || rulesBlock === '' ? selectedBase : `${selectedBase}\n\n${rulesBlock}`
      })()
      return skillsLine === undefined ? withRules : `${withRules}\n\n${skillsLine}`
    }

    /*
     * ★ **只调一次引擎**(2026-10-03,卡「派活三只手收进引擎」;设计 `docs/设计-派活三只手收进引擎-2026-10-03.md`)。
     *
     * 从前这里是一圈 `for (const hand of hands)`:窗口那只手走引擎,命令行 / 接口两只手在引擎**外面**直接调 ——
     * 换路有两层主人,闸拦住窗口之后外层接着换手(审计第二节第 3 条);账上命令行 / 接口一行都没有。
     * 现在三条通道都在登记表里:按这件活的种类留通道(写代码只走命令行、在电脑上动手只走窗口)、
     * 按备用规矩排(协议 > 窗口 > 命令行 > 接口)、过同一道闸、记同一本账。这里只剩**把结局写到卡上**。
     */
    if (deps.clientDispatch === undefined) return await failDispatch(taskId, family, who, '窗口:工作台的窗口编排壳没接上', undefined, landed, park)
    /*
     * 插件和壳是分开装的:旧壳不认 `new_conversation`,会把话直接打进她正开着的那条对话。
     * 这一家有窗口那条通道时**不送**(读回复也要新壳),说清楚是壳太旧。
     * 从前这一句只拦窗口那只手、别的手照试;现在引擎自己挑通道,这一拦就拦整件 —— 代价写在交接里(旧壳是过渡状态)。
     */
    const supports = deps.helper?.supports
    if (hands.includes('window') && supports !== undefined && deps.helper?.connected() === true && !supports.call(deps.helper, 'new_conversation')) {
      return await failDispatch(taskId, family, who, '窗口:这台电脑上的工作台 App 还是旧版,不会先开新对话 —— 为了不打进你正开着的那条对话,这次没送(装上新版工作台 App 就好)', undefined, landed, park)
    }
    /*
     * ★ **同一家同一时刻只送一件**(2026-10-21,见 {@link DispatchRunDeps.exclusive}):前一件还占着那扇窗,
     * 这一件排在它后面,卡上写明 —— 前一件收回之后巡检自动送。写代码的活只走命令行,不排。
     */
    const laneInput: TaskDispatchLaneInput = {
      said,
      ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
      ...(input.cwdFixed === true ? { cwd_fixed: true } : {}),
      ...(input.resume === true ? { resume: true } : {}),
      ...(input.project === undefined ? {} : { project: input.project }),
      ...(kind === undefined ? {} : { kind }),
      ...(input.submit === undefined ? {} : { submit: input.submit }),
      ...(skills.length === 0 ? {} : { skills }),
    }
    if (kind !== 'code' && hands.includes('window') && deps.exclusive?.(family) === true) {
      const ahead = await occupantOf(family, taskId)
      if (ahead !== undefined || (sendingNow.has(family) && sendingNow.get(family) !== taskId)) {
        return await queueBehind(taskId, family, who, ahead ?? sendingNow.get(family) as string, laneInput, landed)
      }
    }
    /*
     * ★ **派前持久化**(2026-10-29,可靠执行闭环第一批第 3 步①):送出之前先写执行记录
     * (dispatching + attemptId + 候选表 + 授权引用 + 原交代)。写不上**不起子进程** —
     * 宁可不派,不派出去一个账里没有、没法收场的东西。
     */
    const dispatchRequest: ExecutionDispatchRequest = {
      said,
      ...(cwd === undefined ? {} : { cwd }),
      ...(kind === undefined ? {} : { kind }),
      ...(input.project === undefined ? {} : { project: input.project }),
      ...(input.cwdFixed === true ? { cwdFixed: true as const } : {}),
    }
    if (!await persistDispatchPrepared(task, family, runtime.attempt_id, selection, input.named, dispatchRequest)) {
      return { ok: false, note: '这件活的执行记录这会儿写不上,没敢派(账里没有这件事,派出去也没法收场)—— 请在电脑上再点一次派发' }
    }
    /**
     * ★ **执行租约**(2026-10-26,卡「事务官机制D」):写代码的活(cli 手、有工作树)送之前先claim。
     * 同卡二派 / 同树另一卡 → 拒,卡挂「等你处理」写清 holder 真身与时间;只有**同卡**且 holder
     * 只剩「进程号没了」这一格不确定证据时,人的重派(takeover)才换租约 —— 自动路永远不许。
     * claim 在送之前落盘:两个并发 dispatch 进来的那一瞬就一个赢家(串行队列 + 文件)。
     */
    let leaseHeld = false
    if (kind === 'code' && cwd !== undefined && deps.lease !== undefined) {
      // 租约的 run_id = 这一轮的 attempt_id(f92 的轮次身份):释放/旧回调防护两边对的是同一个号。
      const leaseRun = runtime.attempt_id
      if (ctx !== undefined) ctx.attemptId = leaseRun
      let claimResult = await deps.lease.claim({ taskId, cwd, family, runId: leaseRun, at: deps.now().toISOString() })
      if (!claimResult.ok && !('unreadable' in claimResult)) {
        /*
         * ★ 洞7(2026-10-28 第二批,真机 t-b82dadb0):卡上**上一轮派发已收场**(status done、卡上
         * runtime.attempt_id 与挂着的那把锁 run_id 对得上)→ 那把锁就是已收场那一轮的:收尾的释放
         * 可能迟到 / 被迟到的旧回调拒过(真机:进程 2 秒前刚 ended,锁还没放),租约视为已放手 —
         * 不再按进程表判「读不准」把退修重派挡在门外。按 run_id 精确认领放掉、重 claim;放不掉或
         * 再拒 → 落下面的常规拒因,一字不改。到顶(cap)那一路记的是 failed,不在这个口子 —
         * 锁照旧留到真退出证据(缺口 3b 的规矩不动)。
         */
        const stale = claimResult.holder
        const ended = task.dispatch
        if (stale.task_id === taskId && ended?.status === 'done' && ended.runtime?.attempt_id === stale.run_id) {
          await deps.lease.release({ taskId, runId: stale.run_id, evidence: 'process-exit', at: deps.now().toISOString() }).catch(() => undefined)
          claimResult = await deps.lease.claim({ taskId, cwd, family, runId: leaseRun, at: deps.now().toISOString() })
        }
      }
      if (!claimResult.ok) {
        // ★ 缺口 1:租约文件读不清/坏了 —— 拒发并如实说,绝不当「没有租约」放行(第二个写者)。
        if ('unreadable' in claimResult) {
          return await blockDispatch(taskId, family, kind, `这件活的执行租约这会儿读不清(${claimResult.unreadable})—— 没敢派,怕同一个工作区里冒出第二个写者;请到电脑上看看那份租约文件`, undefined, false, false, landed, undefined, park)
        }
        const holder = claimResult.holder
        const aliveMark = holder.pid === undefined ? undefined : deps.alive?.(holder.pid)
        const holderAlive = aliveMark === true
        // ★ 缺口 3:接管必须**显式人工意图**(`input.takeover`,只从可信入口传进来)且 holder 是
        // **这张卡**、只剩不确定证据、并有**明确的「不在」证据**(`aliveMark === false`:有 pid、
        // 有 alive 探针、探针说不在)—— 自动/排队/恢复路永远不带 takeover;alive 探针缺席或
        // holder 没 pid(unknown)**一律拒**,不猜。
        const takeover = input.takeover === true && aliveMark === false && holder.task_id === taskId && holder.uncertain === true
        if (!takeover) {
          const heldBy = `${holder.task_id === taskId ? '这张卡' : `同一工作区里的卡 ${holder.task_id}`}从 ${holder.claimed_at} 起被 ${targetTitleOf(holder.family)} 接着(第 ${holder.run_id.slice(0, 8)} 号)`
          const why = holderAlive
            ? `${heldBy}占着,它还在跑 —— 同一件活不重复派。要它改方向请用「改方向」;它交回或停下之后这件自动能派`
            : aliveMark === undefined && holder.pid !== undefined
              ? `${heldBy}占着,而这台工作台核不了它的进程此刻在不在 —— 不猜、不重复派。请到那张卡看一眼:它真结束了点重派就接上;拿不准就别动它`
              : `${heldBy}占着,而它的进程状态读不准 —— 不凭进程号消失就重复派。请到那张卡看一眼:它真结束了点重派就接上;它还在跑就别动它`
          return await blockDispatch(taskId, family, kind, why, undefined, false, false, landed, undefined, park)
        }
        const second = await deps.lease.claim({ taskId, cwd, family, runId: leaseRun, at: deps.now().toISOString(), takeover: true })
        if (!second.ok) {
          if ('unreadable' in second) {
            return await blockDispatch(taskId, family, kind, `这件活的执行租约这会儿读不清(${second.unreadable})—— 没敢换,稍后再点一次重派`, undefined, false, false, landed, undefined, park)
          }
          return await blockDispatch(taskId, family, kind, `这件活的执行权这会儿接不上(${second.holder.task_id} 还占着)—— 稍后再点一次重派`, undefined, false, false, landed, undefined, park)
        }
      }
      leaseHeld = true
    }
    /**
     * 这一派没跑出要盯的进程(没送成 / 走成接口 / 窗口)就放手,别把树锁着。
     * 真终态证据上的释放见 finishCli / capCli。
     */
    async function abandonLease(): Promise<void> {
      if (!leaseHeld) return
      leaseHeld = false
      try { await deps.lease?.release({ taskId, runId: runtime.attempt_id, evidence: 'not-started', at: deps.now().toISOString() }) } catch { /* 放手失败:租约会留在文件里,claim 拒因是「进程状态读不准」,由人兜底 */ }
    }
    /*
     * ★ **正在送,先落盘**(2026-10-21):插件在送的这几秒里被杀,重启后据这一格核一眼它在不在那家对话里 ——
     * 在就接着等回话,不在就如实说、请她点重派(**不自己再送一遍**,怕送两遍)。送完那一刻清掉。
     */
    runtime.started_at = deps.now().toISOString()
    const sendingText = promptFor()
    const resend = task.client_dispatch?.family === family || task.dispatch?.family === family
    sendingNow.set(family, taskId)
    await deps.tasks.update(taskId, {
      dispatchLane: { family, state: 'sending', since: deps.now().toISOString(), note: `正在送给 ${who}`, marker, text: sendingText, input: laneInput },
    })
    let sent: Awaited<ReturnType<ClientDispatch['send']>>
    try {
      sent = await sendNow()
    }
    finally {
      if (sendingNow.get(family) === taskId) sendingNow.delete(family)
    }
    await deps.tasks.update(taskId, { dispatchLane: null })
    return await afterSend(sent)

    async function sendNow(): Promise<Awaited<ReturnType<ClientDispatch['send']>>> {
    return await (deps.clientDispatch as ClientDispatch).send({
      family, attemptId: runtime.attempt_id,
      // 这一送是为哪一件事(2026-10-02,卡 AG):动作闸靠它查「还动不动得」、数「来过几回」。
      job: taskId,
      /*
       * ★ **这一下是不是「重派」**(2026-10-02,卡 AG2):看**卡上有没有上一次派给这一家**
       * (证据,不看话里有没有「重派」这个词)—— 窗口那一次记在 `client_dispatch`,命令行 / 接口那一次记在 `dispatch`。
       */
      ...(resend ? { resend: true } : {}),
      text: sendingText,
      submit: input.submit !== false,
      newConversation: true,
      // 一家装着两个 App 时按她的原话挑(卡 DP:「豆包工作」= com.work.pc.doubao)。
      ...(said.trim() === '' ? {} : { said }),
      // 发完在它的对话区里核一眼这句话露面了没有(2026-09-28,卡 WR)。
      ...(input.submit === false ? {} : { confirmMarker: marker }),
      // 这件活是哪一种 / 在哪个目录 / 她的原话:引擎按前者挑通道,命令行与接口那两条要后两样。
      work: kind ?? 'chat',
      ...(cwd === undefined ? {} : { cwd }),
      ...(input.project === undefined ? {} : { project: input.project }),
      brief: said,
      // 名片给了模型与智能体文件才带(2026-10-22 卡 D):命令行那家照它拼参数。
      ...(cliModel === undefined ? {} : { model: cliModel }),
      ...(assigneeCard?.model?.effort === undefined ? {} : { effort: assigneeCard.model.effort }),
      // 智能体文件:派发这一层解析过的(绝对路径)原样带;解析出来不带的带 `agentFileOmit` 位,
      // 适配器连缺省那一份也不加(2026-10-29 任务书「派活智能体文件与起跑换手」①②③)。
      ...(agentPick?.agentFile === undefined ? {} : { agentFile: agentPick.agentFile }),
      ...(agentPick?.omit === true ? { agentFileOmit: true } : {}),
      // 续跑接原会话(2026-10-23 卡③):上一次留下的会话号,命令行照它 `--session` / `--resume`。
      ...(resumeSessionId === undefined ? {} : { resumeSessionId }),
      // 锁着屏就排进队、解锁后经 `dispatchItem` 回到这里重派(2026-10-12;只有这一条路带它)。
      waitUnlock: true,
    })
    }

    async function afterSend(sent: Awaited<ReturnType<ClientDispatch['send']>>): Promise<DispatchStartResult> {
    const via = sent.result?.via

    // ── 命令行那一条:进程起来了 = 送到;结果等它退出(`finishCli` 按卡上记的 pid / 结果文件收)。 ──
    if (sent.ok && via === 'cli' && sent.result?.process !== undefined) {
      const run = sent.result.process
      // 租约补上真进程号(释放按它精确认领;迟到的旧退出摘不动)。
      if (leaseHeld) {
        try { await deps.lease?.attachPid({ taskId, runId: runtime.attempt_id, pid: run.pid }) } catch { /* 补不上:释放退回 run_id 认领 */ }
        // ★ 缺口 5:进程**已经交出去**(卡没写上也是事实)—— start 的 catch 兜底绝不动这把锁。
        if (ctx !== undefined) ctx.processOut = true
      }
      // ★ 退出回调**先于写卡**注册(缺口 5):写卡那一下抛了,进程照样在外头跑,
      // 它的退出必须有人收 —— 不然锁永远留着等人工。租约只在**真终态证据**上放:
      // 进程退出(exit 回调)才释放;中途文本不碰租约(卡「事务官机制D」)。
      // attempt_id(f92 的轮次身份)与 pid 一起传:旧回调在租约层(pid/run 对不上)与卡层(attempt 对不上)都摘不动新轮。
      void run.exited.then(result => finishCli(taskId, result.code, runtime.attempt_id, { pid: run.pid, evidence: 'exit-observed' })).catch(() => { void finishCli(taskId, null, runtime.attempt_id, { pid: run.pid, evidence: 'exit-observed' }) })
      // ★ 派发基线(洞1):这一轮的产物核对与「派出去这一刻的 HEAD」比 —— 执行者提交并推分支再交回,
      // 交回那一刻树干净、对 HEAD 比永远「没有改动」(假阴性)。读不出(不是 git 仓库)就不记,核验如实退。
      const baseSha = cwd === undefined ? undefined : await deps.headSha?.(cwd).catch(() => undefined)
      /*
       * ★ **进程起来了 = 真开工**(2026-10-29,任务书「在跑的事项要数到命令行真在跑的活」):
       * 命令行这一路从前只记「派出」(`assigned`/`seen`,引擎记的),开工与活动一条不落,
       * 运行片段于是从头到尾停在 `dispatched` —— 人看着 Kimi 在干活,面板说「没有在跑的事项」。
       * 起进程成功这一刻记一条 `started`(带 pid 与轮次身份);活动与收场见 `observeCli` / `finishCli`。
       */
      deps.jobLog?.append({ job: taskId, step: 'started', family, via: 'cli', pid: run.pid, attempt_id: runtime.attempt_id })
      const dispatch: TaskDispatch = {
        family, status: 'running', hand: 'cli', pid: run.pid, selection, runtime,
        started_at: deps.now().toISOString(), output_file: run.output_file,
        ...(cwd === undefined ? {} : { cwd }),
        ...(kind === undefined ? {} : { kind }),
        ...(branch === undefined ? {} : { branch }),
        ...(baseSha === undefined || baseSha === '' ? {} : { base_sha: baseSha }),
        // 时长上限按名片定(2026-10-23 卡③):名片没写按命令行家缺省 120;巡检(capCli)照这一格停。
        budget_minutes: cardBudgetMinutes ?? CARD_CLI_BUDGET_MINUTES,
      }
      // 接单:执行记录先写事实(running + 执行来源登记),再动卡(第 3 步①)。
      void submitExecutionFact(taskId, { kind: 'started', attemptId: runtime.attempt_id, planVersion: task?.round ?? 1, origin: family, at: deps.now().toISOString() })
      // 起手失败换过手的:前面每只的原因留在卡上(note 记每只为什么),新的一只起跑前不抹掉。
      const failures = await startupFailuresOf(taskId, family)
      const swapNote = failures.reasons.length === 0 ? null : `起跑没跑起来,${failures.reasons.join(';')};换 ${who} 再派`
      await deps.tasks.update(taskId, { dispatch, clientDispatch: null, note: agentPick?.note ?? swapNote, assignee: landed, dispatchBlock: null })
      await moveTo(taskId, 'doing')
      changed()
      // 活动基线从 0 行起数 —— 与 `observeCli` / 起跑失败换手同一把尺(`cliOutputLines`,非空白行)。
      cliObserved.set(taskId, 0)
      ensureTimer()
      const withSkills = skills.length === 0 ? '' : `,带着技能 ${skills.join('、')}`
      return { ok: true, hand: 'cli', note: sentNote(who, 'cli', `${branch === undefined ? `(在 ${cwd ?? ''})` : `(在独立工作区 ${cwd ?? ''},分支 ${branch};不动你那份目录)`}${withSkills}`) }
    }

    // ── 接口那一条:回答当场回来了 → 自查、挂交付物、挪「等我确认」。 ──
    if (sent.ok && via === 'api' && sent.result?.reply !== undefined && sent.result.reply.trim() !== '') {
      await abandonLease()
      const reply = sent.result.reply.trim().slice(0, REPLY_MAX_CHARS)
      const at = deps.now().toISOString()
      const fresh = await findTask(taskId)
      const failed = await reviewFailed(taskId, reply)
      // 交回:执行记录先写事实(returned → verifying),再动卡(第 4 步①:接口手与 CLI / 窗口同一口径)。
      void submitExecutionFact(taskId, { kind: 'returned', attemptId: runtime.attempt_id, planVersion: task?.round ?? 1, receiptId: at })
      await deps.tasks.update(taskId, {
        clientDispatch: null,
        dispatch: { family, selection, runtime, hand: 'api', status: 'done', started_at: at, ended_at: at, reply, ...(kind === undefined ? {} : { kind }) },
        note: failed === undefined ? null : reviewNote(family, failed),
        assignee: landed,
        dispatchBlock: null,
        ...(fresh === undefined ? {} : { deliverables: appendReply(fresh, reply) }),
        ...receiptPatch(card, reply, at, family),
      })
      if (failed === undefined) {
        await moveTo(taskId, landingOf(card, reply))
        // 进「等你确认」即进核验(与 CLI 手的 onDelivered 同一钩;blocked / 自查不过那几档不核)。
        if ((await findTask(taskId))?.status === 'confirm') deps.onDelivered?.(taskId)
      }
      else { await moveTo(taskId, 'blocked'); await deps.tasks.update(taskId, { blockReason: 'error' }) }
      changed()
      return { ok: true, hand: 'api', note: sentNote(who, 'api', failed === undefined ? ',结果在卡上等你看' : ',但按你的规矩自查没过') }
    }

    // ── 窗口 / 协议那一条:原样(卡 WR / DP / DB 那几条规矩一字不动)。 ──
    if (sent.ok && sent.dispatch !== undefined) {
      await abandonLease()
      /*
       * ★ **前两步不在这儿记了**(2026-10-02,卡「引擎接线与删复制品」)。
       *
       * 卡 AG 那一版里这两行是手记的;送话换成引擎之后**引擎自己就记**
       * (`engine.record`:`assigned` + 投递那一格,还带着动作、包标识与那一档证据)。
       * 两边都记的后果在真机那一跑上看得见 —— 一次派活四行账、`assigned` 两条,
       * 「一眼查这件事走到哪一步」于是多出一条没有动作的指派。账只许有一个记的人。
       */
      /**
       * ★ **写进框里了、没发出去 → 这张卡不进「在办」**(2026-09-28,卡 WR;统筹 09-28 10:07 真机)。
       *
       * 那一次 Manus 记的是 `{status:'sent', submitted:false}` + 事项 doing,而那段字停在他的输入框里。
       * 现在:把这一次原样记在卡上(`status:'typed'`,原话看得见),卡挪进「卡住了」并说清
       * 下一步该他做什么 —— **不记 `reply_state:'waiting'`**(没发出去就没有什么回答可等)。
       */
      if (sent.dispatch.status === 'typed') {
        await abandonLease()
        await deps.tasks.update(taskId, {
          clientDispatch: { ...sent.dispatch, ...(sent.bundle_id === undefined ? {} : { bundle_id: sent.bundle_id }), marker },
          assignee: landed,
        })
        const why = sent.dispatch.reason ?? `字写进 ${who} 的输入框了,可没发出去`
        // 他那段草稿让了位就**一定要当场说一句**存哪了(卡 DB;这条路上也不许默默拿走他的东西)。
        const draftLine = sent.dispatch.draft?.note
        return await blockDispatch(
          taskId,
          family,
          kind ?? 'chat',
          `${why} —— 去 ${who} 里按一下发送,或者点这张卡重派一次${draftLine === undefined ? '' : `;${draftLine}`}`,
          undefined,
          false,
          false,
          landed,
          undefined,
          park,
        )
      }
      /*
       * ★ **真送进去的那个包记在卡上**(2026-09-30 止血,根子 1):读回话、核「看见没看见」都按它,
       * 不再按家名回主包(Air 上豆包只装着 `com.work.pc.doubao`,按家名会查到另一扇窗)。
       */
      const record: TaskClientDispatch = {
        ...sent.dispatch, selection, runtime, ...(cwd === undefined ? {} : { cwd }),
        ...(sent.bundle_id === undefined ? {} : { bundle_id: sent.bundle_id }),
        marker,
        reply_state: 'waiting',
      }
      await deps.tasks.update(taskId, { clientDispatch: record, dispatch: null, note: null, assignee: landed, dispatchBlock: null })
      await moveTo(taskId, 'doing')
      ensureTimer()
      changed()
      const opened = record.new_conversation === 'single_thread' ? '(它只有一条对话,送进了那一条)' : '(新开了一条对话)'
      // 他在那家输入框里没发出去的那段字让了位(2026-09-27,卡 DB):**一定要当场说一句**
      // 存在哪了 / 放回去了没有 —— 那是他的东西,不许默默拿走(话由 clientDrafts.draftSavedNote 出)。
      const draftLine = record.draft?.note
      // 按了发送、可这会儿还没在它对话区里看见那句话(2026-09-28,卡 WR):**说一句**,不假装亲眼看见了。
      // 派给了两个同名 App 里的哪一个,也要说一句(卡 DP)。
      const lines = [sentNote(who, 'window', opened), sent.package_note, draftLine, sent.confirm_note].filter(one => one !== undefined)
      return { ok: true, hand: 'window', note: joinOnce(lines) }
    }
    /*
     * ★ **闸拦下的那一下,一条替代的路都不许走**(2026-10-03,审计第二节第 3 条;契约 `JobResult.blocked` 那一段)。
     * 这不是那扇窗上的事实(没窗口 / 输入框没接住),而是工作台**不许**这一下(收场了 / 到顶了)——
     * 现在三条通道都在引擎里,闸在引擎里拦下就不会再有「换到别的手」这件事;这里只把闸那一句原样念给她,卡一个字不改。
     */
    if (sent.kind === 'not_allowed') { await abandonLease(); return { ok: false, note: sent.reason ?? `${who}:这一下工作台没放行` } }
    /*
     * 没派出去。两种是「等她处理」(卡挂「等你处理」,琥珀),不是出错:
     * ★ 电脑锁着屏(2026-10-03):她先得解锁 —— 那句话本身已经是要对她说的一整句,所以 `whyIsTheNote`;
     * ★ 它窗口上弹着一层框挡住了输入框(卡 DP):壳按不到,轮到她去点一下。
     * 别的是「运行失败」:原因由引擎给 —— 它把每条通道为什么用不上接成了一句(`engineNoChannelSay` / `engineUnsupportedSay`),
     * 念给她的只有第一段(嘴那一侧 `plainFailureWhy` 截),卡上照旧是全部(卡 CF 第 8 条)。
     */
    if (sent.screen_locked === true) {
      await abandonLease()
      const blocked = await blockDispatch(taskId, family, kind ?? 'chat', sent.reason ?? '电脑锁着屏,送不进去', undefined, true, sent.lock_queued === true, undefined, undefined, park)
      return { ...blocked, screen_locked: true }
    }
    if (sent.kind === 'modal_in_the_way' || sent.kind === 'tree_shell_only') { await abandonLease(); return await blockDispatch(taskId, family, kind ?? 'chat', sent.reason ?? `${who} 窗口上有一层框挡着,要你去点一下`, undefined, false, false, landed, undefined, park) }
    await abandonLease()
    return await failDispatch(taskId, family, who, sent.reason ?? `${who} 没有能用的手`, via === 'window' || via === undefined ? sent.dispatch : undefined, landed, park)
    }
  }

  /**
   * ★ 这一家此刻被哪一件占着那扇窗(2026-10-21):还在等回话的、正在送的(落盘那一格)、读不动但还开着的。
   * 收场了的不算。排着的不算(它们在后面)。
   */
  async function occupantOf(family: string, exceptId: string): Promise<string | undefined> {
    const list = (await deps.tasks.list()).tasks
    const busy = list.find(one => one.id !== exceptId && !SETTLED_TASK_STATUS.includes(one.status)
      && ((waitingWindowDispatch(one)?.family === family) || (one.dispatch_lane?.family === family && one.dispatch_lane.state !== 'queued')))
    return busy?.id
  }

  /** 排在同一家最后那一件后面:卡上写明、挪「进行中」,巡检轮到它时照落盘那份交代接着派。 */
  async function queueBehind(taskId: string, family: AgentDispatchFamily, who: string, occupant: string, input: TaskDispatchLaneInput, landed?: TaskAssignee): Promise<DispatchStartResult> {
    const list = (await deps.tasks.list()).tasks
    const queued = list
      .filter(one => one.id !== taskId && !SETTLED_TASK_STATUS.includes(one.status) && one.dispatch_lane?.family === family && one.dispatch_lane.state === 'queued')
      .sort((a, b) => Date.parse(a.dispatch_lane?.since ?? '') - Date.parse(b.dispatch_lane?.since ?? ''))
    const behindId = queued.at(-1)?.id ?? occupant
    const behindTitle = list.find(one => one.id === behindId)?.title ?? behindId
    const note = dispatchQueuedNote({ who, behind: behindTitle })
    const lane: TaskDispatchLane = { family, state: 'queued', since: deps.now().toISOString(), note, behind: behindId, input }
    await deps.tasks.update(taskId, { dispatchLane: lane, note, assignee: landed ?? family, dispatchBlock: null })
    await moveTo(taskId, 'doing')
    ensureTimer()
    changed()
    return { ok: true, hand: 'window', note, queued: true }
  }

  /**
   * ★ 轮到排着的那件了(这一家没人占着那扇窗):最早排上的那一件照落盘的交代派出去。
   * 被她取消 / 收掉了的跳过并清掉那一格。派完它那一格还是「排着」(没走到送那一步就停了),也清掉 ——
   * 卡上已经有那一步的原话,不许它永远排在那儿。
   */
  async function promoteQueued(family: string): Promise<boolean> {
    if (sendingNow.has(family)) return false
    const state = await deps.tasks.list()
    const list = state.tasks
    const queued = list
      .filter(one => one.dispatch_lane?.family === family && one.dispatch_lane.state === 'queued')
      .sort((a, b) => Date.parse(a.dispatch_lane?.since ?? '') - Date.parse(b.dispatch_lane?.since ?? ''))
    let touched = false
    for (const one of queued) {
      if (SETTLED_TASK_STATUS.includes(one.status) || one.dispatch_lane?.input === undefined) {
        await deps.tasks.update(one.id, { dispatchLane: null })
        touched = true
        continue
      }
      // ★ 出队前核卡(2026-10-23,卡「待排的卡不许被派出去」):轮到它时它被挪回「待排」、
      // 被改派了 → 撤掉这条排队、卡上写一句,不派(判法与 lockQueueDispatch.stillWanted 同一处)。
      const left = queuedDispatchLeft(one, family, state.agent_cards)
      if (left !== undefined) {
        await deps.tasks.update(one.id, { dispatchLane: null, note: left })
        touched = true
        continue
      }
      if (await occupantOf(family, one.id) !== undefined) return touched
      const lane = one.dispatch_lane
      const input = lane.input as TaskDispatchLaneInput
      await start(one.id, {
        family,
        said: input.said,
        ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
        ...(input.cwd_fixed === true ? { cwdFixed: true } : {}),
        ...(input.resume === true ? { resume: true } : {}),
        ...(input.project === undefined ? {} : { project: input.project }),
        ...(input.kind === undefined ? {} : { kind: input.kind }),
        ...(input.submit === undefined ? {} : { submit: input.submit }),
        ...(input.skills === undefined ? {} : { skills: input.skills }),
      })
      const after = await findTask(one.id)
      if (after?.dispatch_lane?.state === 'queued' && after.dispatch_lane.since === lane.since) {
        await deps.tasks.update(one.id, { dispatchLane: null })
      }
      return true
    }
    return touched
  }

  /**
   * ★ **插件在送的那几秒里被杀了**(2026-10-21):落盘的「正在送」那一格还在、这个进程又不在送它。
   * 在它对话里核一眼那一句:在 → 接着等回话(补上卡上那一次);不在 → 如实说、请她点重派。**不自己再送一遍。**
   * 那扇窗这会儿读不动 → 先不判,下一拍再核。
   */
  async function recoverSending(task: TaskView, lane: TaskDispatchLane): Promise<boolean> {
    if (sendingNow.get(lane.family) === task.id) return false
    if (SETTLED_TASK_STATUS.includes(task.status)) {
      await deps.tasks.update(task.id, { dispatchLane: null })
      return true
    }
    if (task.client_dispatch?.marker === lane.marker && task.client_dispatch?.reply_state !== undefined) {
      await deps.tasks.update(task.id, { dispatchLane: null })
      return true
    }
    const who = targetTitleOf(lane.family)
    const landed = task.assignee !== undefined && isAgentCardAssignee(task.assignee) ? task.assignee : lane.family
    let got: (AdapterReadResultLike) | undefined
    if (deps.engine !== undefined && lane.marker !== undefined) {
      got = await deps.engine.read({
        id: task.id, itemId: task.id, family: lane.family, kind: 'dispatch', target: { kind: 'current' },
        text: lane.text ?? lane.marker, marks: [lane.marker], expect: 'reply',
      }).catch(() => undefined)
    }
    if (got?.jammed === true) return false
    const found = got?.evidence !== undefined && READ_SEEN_EVIDENCE.includes(got.evidence)
    const sinceMs = Date.parse(lane.since)
    if (!found && !Number.isNaN(sinceMs) && deps.now().getTime() - sinceMs < DISPATCH_RECOVER_GRACE_MS) {
      ensureTimer()
      return false
    }
    if (found && lane.marker !== undefined) {
      const record: TaskClientDispatch = {
        hand: 'window', family: lane.family as TaskClientDispatch['family'], status: 'sent', at: lane.since,
        text: lane.text ?? lane.marker, marker: lane.marker, reply_state: 'waiting',
      }
      await deps.tasks.update(task.id, { clientDispatch: record, dispatchLane: null, note: null, assignee: landed })
      await moveTo(task.id, 'doing')
      ensureTimer()
      return true
    }
    const note = dispatchInterruptedNote(who)
    deps.jobLog?.append({ job: task.id, step: 'unreadable', family: lane.family, why: note })
    // ★ 结果不明(第 3 步②):送没送进去不知道 —— 不开第二作者(不自己再送一遍),记录留 reconcile。
    if (deps.execution !== undefined) {
      try {
        const current = await deps.execution.read(task.id)
        if (current !== undefined) {
          const fact: ExecutionFact = { kind: 'outcome_unclear', attemptId: current.attemptId ?? '', planVersion: current.planVersion, reason: 'sending_interrupted', at: deps.now().toISOString() }
          const reduced = reduceExecution(current, fact)
          if (reduced !== current) await deps.execution.compareAndSet(task.id, current.version, reduced)
        }
      }
      catch { /* 记录写不上不连累卡上那一句 */ }
    }
    await deps.tasks.update(task.id, { note, dispatchLane: null, assignee: landed })
    await moveTo(task.id, 'blocked')
    await deps.tasks.update(task.id, { blockReason: 'input' })
    return true
  }

  /**
   * 没派出去:卡挂「阻塞」、原话写清楚,收件箱与首页据此问他一句。**不改派别家**。
   * 窗口那一次没送成的记录(`failedWindow`)照旧写到卡上 —— 卡上要看得见是哪一下没成。
   * `park:false`(退修重派那一下,第 4 步)= 只落原因不动卡:卡回「等你确认」,恢复记录接着推。
   */
  async function failDispatch(taskId: string, family: AgentDispatchFamily, who: string, reason: string, failedWindow: TaskClientDispatch | undefined, landed?: TaskAssignee, park = true): Promise<DispatchStartResult> {
    await deps.tasks.update(taskId, {
      note: `派给 ${who} 没派出去:${reason}`,
      assignee: landed ?? family,
      ...(failedWindow === undefined ? {} : { clientDispatch: failedWindow }),
    })
    if (park) {
      await moveTo(taskId, 'blocked')
      await deps.tasks.update(taskId, { blockReason: 'error' })
    }
    changed()
    return { ok: false, note: `派给 ${who} 没派出去:${reason}` }
  }

  /**
   * 挑不到能做这件活的手(卡 O):**不派**。卡挂「阻塞」,`dispatch_block` 说清为什么、给修法与能换的几家。
   * 卡上那句 note 与回包里的 note 是同一句(电话里她念的也是它)。
   */
  async function blockDispatch(
    taskId: string,
    family: AgentDispatchFamily,
    kind: JobKind,
    why: string,
    fix?: TaskDispatchBlock['fix'],
    /** `why` 本身已经是要对她说的那一整句 → 卡上那句 note 原样用它(2026-10-01,读不到窗口那一类)。 */
    whyIsTheNote?: boolean,
    /** 锁着屏、这一件排上队了:卡上挂「在等你解锁电脑」(`TaskDispatchBlock.unlock`,2026-10-12)。 */
    unlock?: boolean,
    /** 名片派活(2026-10-22 卡 B):负责人保留名片 id,不写成家名。 */
    landed?: TaskAssignee,
    /** 卡上挂的原因(与 SessionWaitReason 同一套 id):额度预检是 'quota',其余照旧 'input'。 */
    blockReason: import('../protocol.ts').WaitReason = 'input',
    /** `false`(退修重派,第 4 步)= 只落 dispatch_block 与那句 note,不把卡停进「卡住」。 */
    park: boolean = true,
  ): Promise<DispatchStartResult> {
    let alternatives: TaskDispatchBlock['alternatives']
    try { alternatives = await deps.alternativesFor?.(taskId, family, kind) } catch { alternatives = undefined }
    const block: TaskDispatchBlock = {
      family,
      kind,
      why,
      ...(fix === undefined ? {} : { fix }),
      ...(alternatives === undefined || alternatives.length === 0 ? {} : { alternatives }),
      ...(unlock === true ? { unlock: true as const } : {}),
      at: deps.now().toISOString(),
    }
    const who = targetTitleOf(family)
    // 能换的几家里只有别家(2026-09-28,卡 BS2:「事务官自己做」那一项拿掉了 —— 事务官不干活)。
    const agents = (alternatives ?? []).map(one => one.title)
    const tail = agents.length > 0 ? `;也可以先交给 ${agents.join('、')} 做` : ''
    const note = whyIsTheNote === true
      ? why
      : `没派给 ${who}:${why}${fix === undefined ? '' : `(点「${fix.label}」)`}${tail}`
    await deps.tasks.update(taskId, { note, assignee: landed ?? family, dispatchBlock: block })
    if (park) {
      await moveTo(taskId, 'blocked')
      // 派不出去不是「出错」:是在等他先修(登录 Claude)或者换一家 —— 按「等你处理」挂(琥珀,不染红)。
      await deps.tasks.update(taskId, { blockReason })
    }
    changed()
    return { ok: false, note, block }
  }

  /**
   * 挪「等我确认」之前按他的规矩自查一遍(卡 K)。回 undefined = 过了(或者根本没接自查);
   * 回一句话 = 没过,那句话写到卡上。自查本身出错不挡:宁可叫他看一眼,也不能把活卡死在这儿。
   */
  async function reviewFailed(taskId: string, text: string, instruction?: string): Promise<DispatchReview | undefined> {
    if (deps.review === undefined) return undefined
    try {
      const task = await findTask(taskId)
      const verdict = await deps.review({
        taskId, text, taskText: task?.desc ?? task?.title ?? '',
        ...(instruction === undefined || instruction.trim() === '' ? {} : { instruction }),
      })
      return verdict === undefined || verdict.pass ? undefined : verdict
    }
    catch { return undefined }
  }

  function reviewNote(family: AgentDispatchFamily, verdict: DispatchReview): string {
    const which = (verdict.violations ?? []).filter(one => one.trim() !== '').join(';')
    return `${targetTitleOf(family)} 交回来的按你的规矩自查没过${which === '' ? '' : `(${which})`},没叫你验收 —— 回答在卡上,要不要让它再改一遍你说一声`
  }

  /**
   * 命令行那只手不存送出去的原文:收结果时按同一个口把「我们附上的」拼回来(交代那一句 + 规矩那一段),
   * 给卡 K 查「回答里夹着我们自己的指令」。规矩拿不到就只有交代那一句。
   */
  async function cliInstruction(task: TaskView): Promise<string> {
    let rules: string | undefined
    try { rules = (await deps.rulesFor?.({ taskId: task.id, said: task.desc ?? task.title }))?.trim() } catch { rules = undefined }
    return [DISPATCH_NOTE_TEXT, ...(rules === undefined || rules === '' ? [] : [rules])].join('\n')
  }

  const cliObserved = new Map<string, number>()
  /** 上一次记 `updated` 的时刻(毫秒):活动事件两条之间至少隔 {@link CLI_ACTIVITY_THROTTLE_MS}。 */
  const cliActivityAt = new Map<string, number>()
  /**
   * ★ **换手痕迹只进执行记录**(2026-10-29,可靠执行闭环第一批第 3 步②;取代内存里的
   * `cliTried / cliTriedWhy / cliRetryInput` 三张表):哪只试过、为什么没起跑、原交代是什么,
   * 全部在卡上的执行记录里 —— 重启之后新进程照记录接续,不凭重启前的内存,也不让她重新交代。
   * 这里只剩「已排还没送出的那一下换手」的定时把;服务收摊(stop)时一并撤掉
   * (插件真死的那一刻定时器随进程没,正是重启恢复要接的那一档)。
   */
  const handoffTimers = new Map<string, ReturnType<typeof setTimeout>>()

  function scheduleHandoff(taskId: string, family: AgentDispatchFamily, request: ExecutionDispatchRequest): void {
    const prior = handoffTimers.get(taskId)
    if (prior !== undefined) clearTimeout(prior)
    handoffTimers.set(taskId, setTimeout(() => {
      handoffTimers.delete(taskId)
      // 同卡重派走送出去那一圈完整的路(核手 / 额度 / 租约 / 派前持久化),但**不许在收尾锁里重入**:
      // 锁按事项串行,排一拍再起。start 自己把任何一步的失败写到卡上。
      void start(taskId, {
        family, said: request.said, handoff: true,
        ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
        ...(request.kind === undefined ? {} : { kind: request.kind as JobKind }),
        ...(request.project === undefined ? {} : { project: request.project }),
        ...(request.cwdFixed === true ? { cwdFixed: true } : {}),
      }).catch(() => undefined)
    }, 0))
  }
  /**
   * ★ **「命令行那只手有没有干活」唯一那把尺**(2026-10-29,两支合流,三处共用):
   * 结果日志(标准输出那一份)里**非空白行**的条数。共用它的三处:
   *   1. `observeCli` —— 每多读出一行记一条 `updated`(30 秒节流),活动账;
   *   2. `finishCliUnlocked` 的起跑失败换手 —— 一条都没有 = 这一只根本没起跑;
   *   3. 派发那一刻的基线 —— `cliObserved` 从这把尺的零点(0 行)起数。
   * 为什么不数事件类型:三家形状各不一样(Kimi `stream-json` 每行带 `role`、Codex `--json` 带
   * `type`、Claude 结果是一大段 JSON),按类型数 Kimi 永远数不到 —— 这正是真机「pid 活着、
   * 面板说没开工」的洞,也是换手那把旧尺(按事件类型数)数不到 Kimi 的根。开工那一条
   * `started` 在起进程那一刻就记了(带 pid 与轮次身份),这把尺只管「干没干活」;
   * `own`(收尾那一拍)只刷新基线不再记活动 —— 收场那一步自己会记 `replied`/`unreadable` + `ended`。
   */
  function cliOutputLines(log: string): number {
    return log.split('\n').filter(line => line.trim() !== '').length
  }
  async function observeCli(task: TaskView, log: string, own = false): Promise<void> {
    const lines = cliOutputLines(log)
    const previous = cliObserved.get(task.id)
    cliObserved.set(task.id, lines)
    if (own) return
    if (previous === undefined || lines <= previous) return
    const nowMs = deps.now().getTime()
    if (nowMs - (cliActivityAt.get(task.id) ?? 0) < CLI_ACTIVITY_THROTTLE_MS) return
    deps.jobLog?.append({ job: task.id, step: 'updated', family: task.dispatch?.family ?? 'unknown', via: 'cli' })
    cliActivityAt.set(task.id, nowMs)
  }

  /**
   * 命令行派活收尾。`evidence`(2026-10-26,卡「事务官机制D」):
   *   - 'exit-observed':**亲眼看到进程退出**(exit 回调)——真终态证据,按 (attemptId|pid) 精确释放租约;
   *   - 'pid-gone':重启巡检发现进程号不在了 —— **不是终态证据**:租约标「不确定」保留,
   *     不凭进程号消失就重派;显式人工接管(takeover)才换。
   * attemptId(f92 的轮次身份)对不上 → 这是**迟到的旧回调**:卡一字不写、租约不动。
   */
  async function finishCli(taskId: string, exitCode: number | null, attemptId?: string, evidence?: { pid?: number | undefined, evidence: 'exit-observed' | 'pid-gone' }): Promise<void> {
    await forTask(taskId, async () => await finishCliUnlocked(taskId, exitCode, attemptId, evidence))
  }
  async function finishCliUnlocked(taskId: string, exitCode: number | null, attemptId?: string, evidence?: { pid?: number | undefined, evidence: 'exit-observed' | 'pid-gone' }): Promise<void> {
    let code = exitCode
    if (finishing.has(taskId)) return
    finishing.add(taskId)
    try {
      const task = await findTask(taskId)
      // list() 交出的是共享快照(2026-10-28,读缓存去 structuredClone 之后的不变量:谁都不许就地改)。
      // 下面要把观测到的 runtime 写进 running,先浅拷一份自己改;卡上的新状态仍只经 tasks.update 落账。
      const found = task === undefined ? undefined : runningCliDispatch(task)
      const running = found === undefined ? undefined : { ...found }
      // ★ 租约(卡「事务官机制D」):**exit-observed 是铁证** —— 进程退出了,先把锁按
      // (attemptId|pid) 放掉;卡对不上是另一件事,不许因此留着锁(到顶被停 = stopped-cap)。
      if (deps.lease !== undefined && evidence !== undefined) {
        try {
          if (evidence.evidence === 'exit-observed') {
            const stoppedByCap = running?.stopped === 'cap'
            await deps.lease.release({
              taskId, ...(attemptId === undefined ? {} : { runId: attemptId }), ...(evidence.pid === undefined ? {} : { pid: evidence.pid }),
              evidence: stoppedByCap ? 'stopped-cap' : code === 0 ? 'process-exit' : 'process-failed', code, at: deps.now().toISOString(),
            })
          }
          else if (evidence.evidence === 'pid-gone' && evidence.pid !== undefined) {
            const active = await deps.lease.activeForTask(taskId)
            if (active !== undefined && (active.pid === evidence.pid || (attemptId !== undefined && active.run_id === attemptId))) {
              await deps.lease.markUncertain({ taskId, runId: active.run_id })
              // ★ 持锁 / 不明都可观察且带对账动作(第 3 步③):进程号没了不是终态证据 —— 锁标不确定保留,
              // 执行记录记 outcome_unclear(reconciling + reconcile),不凭 PID 消失放锁或重派。
              void submitExecutionFact(taskId, {
                kind: 'outcome_unclear', attemptId: attemptId ?? active.run_id, planVersion: task?.round ?? 1,
                reason: 'pid_gone', at: deps.now().toISOString(),
              })
            }
          }
        }
        catch { /* 租约这一格坏了不连累收尾 */ }
      }
      if (task === undefined || running === undefined || running.output_file === undefined) {
        /*
         * ★ **取消后交回,已忽略**(2026-10-28,任务书「取消要收场执行者」):卡已被她取消,
         * 那只手(进程临死前的「做完」)这会儿才退出 → **不进 confirm、不触发核验**,只落一条评论。
         * 租约在上面已按 (attempt|pid) 认领过(cancel 那一下可能先放掉了 → stale-run 不动,无妨)。
         */
        if (task !== undefined && task.status === 'canceled' && (task.dispatch?.status === 'running' || task.dispatch?.status === 'canceled')) {
          try { await deps.tasks.comment(taskId, { by: 'butler', text: '取消后交回,已忽略' }) } catch { /* 评论落不上也不连累收尾 */ }
          cliObserved.delete(taskId)
          changed()
        }
        // 卡上已经没有在跑的命令行派活了:换手那一档没有要送的,残留定时把撤掉。
        const pending = handoffTimers.get(taskId)
        if (pending !== undefined) { clearTimeout(pending); handoffTimers.delete(taskId) }
        return
      }
      // ★ 旧回调防护(f92 轮次身份 + 卡D):这一拍卡上的活跃轮不是我的 attempt → 一字不写
      // (迟到的旧退出不能改新轮的卡,也不能在租约层摘新锁——release 已按 attempt|pid 拒过)。
      if (attemptId !== undefined && running.runtime?.attempt_id !== attemptId) return
      const log = (await deps.readFile(`${running.output_file}.jsonl`)) ?? ''
      await observeCli(task, log, true)
      // Claude / Kimi 命令行(卡 O / 卡 C,写代码的活)把结果打在标准输出的结构化 JSON 里,没有 `-o` 那个文件。
      const structured = running.family === 'claude'
        ? claudeResultOf(log)
        : running.family === 'kimi'
          ? kimiResultOf(log)
          : undefined
      if (structured !== undefined && structured.error) code = code === 0 ? 1 : code
      const reply = structured !== undefined ? (structured.error ? '' : structured.text) : ((await deps.readFile(running.output_file)) ?? '').trim()
      const sessionId = structured?.session_id ?? threadIdOf(log)
      const at = deps.now().toISOString()
      if (running.runtime !== undefined) {
        const context = sessionId === undefined || running.cwd === undefined ? undefined : await deps.runtimeContext?.(running.family, sessionId, running.cwd).catch(() => undefined)
        running.runtime = observeRuntime(running.runtime, { family: running.family, log, ...(sessionId === undefined ? {} : { sessionId }), ...(running.cwd === undefined ? {} : { cwd: running.cwd }), ...(context === undefined ? {} : { context }) })
      }
      // ★ 会话号进 relay 候选池的内存镜像(2026-10-23 深夜,卡 A 硬门槛前置):事实源头仍是卡上的 links。
      if (sessionId !== undefined) noteCliDispatchSession(running.family, sessionId, task.title, at, running.cwd)
      const links = sessionId === undefined ? undefined : withLink(task, running.family, sessionId)
      const terminal = structured !== undefined ? !structured.error : log.split('\n').some(line => { try { return (JSON.parse(line) as { type?: string }).type === 'turn.completed' } catch { return false } })
      const succeeded = (code === 0 || code === null && terminal) && reply !== ''
      if (succeeded) {
        // 交回:执行记录先写事实(returned → verifying,交回 ≠ 交付),再动卡(第 3 步①)。
        void submitExecutionFact(taskId, {
          kind: 'returned', attemptId: attemptId ?? running.runtime?.attempt_id ?? '',
          planVersion: task.round ?? 1, receiptId: sessionId ?? at,
        })
        const text = reply.slice(0, REPLY_MAX_CHARS)
        const failed = await reviewFailed(taskId, text, await cliInstruction(task))
        // 别的项目在独立工作区里改的:改动在那条分支上,他看过再合(不替他合进他那份目录)。
        const onBranch = running.branch === undefined ? null : `${targetTitleOf(running.family)} 改的东西在分支 ${running.branch}(独立工作区 ${running.cwd ?? ''}),你看过再合进去`
        await deps.tasks.update(taskId, {
          dispatch: { ...running, status: 'done', ended_at: at, reply: text, ...(sessionId === undefined ? {} : { session_id: sessionId }) },
          deliverables: appendReply(task, text, sessionId),
          ...(links === undefined ? {} : { links }),
          note: failed === undefined ? onBranch : reviewNote(running.family, failed),
          ...receiptPatch(task, text, at, running.family),
        })
        if (failed === undefined && running.runtime?.status !== 'mismatch') {
          await moveTo(taskId, landingOf(task, text))
          deps.onDelivered?.(taskId)
        }
        else { await moveTo(taskId, 'blocked'); await deps.tasks.update(taskId, { blockReason: 'error' }) }
      }
      else {
        const note = structured?.error === true && structured.text !== ''
          ? structured.text.slice(0, 300)
          : reply === '' && code === 0 ? '跑完了,但一个字的结果都没写出来' : cliFailureNote(code, log)
        /*
         * ★ **起跑失败换手**(2026-10-29,任务书「派活智能体文件与起跑换手」④⑤⑥;可靠执行闭环
         * 第一批第 3 步② 把痕迹收进执行记录):出第一条有效输出之前就退(非 0 / 立刻结束、日志空空
         * ——`cliOutputLines` 数出来一行都没有)= 这一只根本没起跑 —— 不是「做了没做成」。中枢的换手
         * 只看得见派发口同步回的失败,这种异步的起跑失败它看不见,所以在这里换:
         * 先在执行记录里写下 `attempt_failed`(原因原样带),再按**记录里的候选表**(实际能力 ∩
         * 委托许可)换下一只**同一张卡、同一份交代**重派,每只的原因都落卡;
         * 候选走完才 blocked、note 列清每只为什么。**已出输出 / 有改动的不算**(干上活了,照旧走原来的路);
         * 被她停了 / 到上限停下来的也不算(那是「停下来」,不是起跑失败)。
         * 「有没有出输出」与活动账 `observeCli` 同一把尺(`cliOutputLines`,非空白行;按事件类型数
         * 那把旧尺 Kimi `stream-json` 一行都对不上,会把干着活的 Kimi 误判成起跑失败再换走 —— 退修换掉)。
         */
        const startupFailed = running.stopped === undefined && reply === '' && cliOutputLines(log) === 0
        const whyLine = `${targetTitleOf(running.family)}:${note}`
        // 先在执行记录里写下 attempt_failed(身份/计划版本按记录上当前的,迟到的旧轮摘不动)。
        const recordAfter = startupFailed && !SETTLED_TASK_STATUS.includes(task.status) && deps.execution !== undefined
          ? await (async () => {
              const current = await deps.execution?.read(taskId).catch(() => undefined)
              if (current === undefined) return undefined
              const fact: ExecutionFact = {
                kind: 'attempt_failed', attemptId: current.attemptId ?? attemptId ?? running.runtime?.attempt_id ?? '',
                planVersion: current.planVersion, family: running.family, reason: note, at,
              }
              const reduced = reduceExecution(current, fact)
              if (reduced === current) return current
              if (!await deps.execution!.compareAndSet(taskId, current.version, reduced)) return current
              return reduced
            })()
          : undefined
        const tried = recordAfter === undefined ? [running.family]
          : [...new Set((recordAfter.attempts ?? []).filter(one => one.outcome === 'startup-failed').map(one => one.family))]
        const triedWhy = recordAfter === undefined ? []
          : (recordAfter.attempts ?? []).filter(one => one.outcome === 'startup-failed').map(one => `${targetTitleOf(one.family)}:${one.reason ?? '没起跑'}`)
        /*
         * 换手许可:严格点名(authorizationRef === 'named')不可替换 —— 不换、等她,原因写清是
         * 哪一只没起跑(不伪称她点名了替代者)。其余(含中枢按默认推荐挑的)在候选里兜底换下一只。
         */
        const handoffOk = startupFailed && !SETTLED_TASK_STATUS.includes(task.status) && recordAfter?.authorizationRef !== 'named'
        const next = handoffOk ? handoffCandidate(recordAfter ?? { candidates: (running.selection?.candidates ?? []).filter(one => one.ok).map(one => one.family) }, tried) : undefined
        if (next !== undefined && recordAfter?.dispatchRequest !== undefined) {
          const all = [...triedWhy, whyLine]
          await deps.tasks.update(taskId, {
            dispatch: { ...running, status: 'failed', ended_at: at, note, ...(sessionId === undefined ? {} : { session_id: sessionId }) },
            ...(links === undefined ? {} : { links }),
            note: `起跑没跑起来,${all.join(';')};换 ${targetTitleOf(next)} 再派`,
          })
          deps.jobLog?.append({ job: taskId, step: 'unreadable', family: running.family })
          cliObserved.delete(taskId)
          changed()
          scheduleHandoff(taskId, next as AgentDispatchFamily, recordAfter.dispatchRequest)
          return
        }
        // 严格点名没跑起来:执行记录挂「等待本人」,原因写清决定对象(机器可读)。
        if (startupFailed && !SETTLED_TASK_STATUS.includes(task.status) && recordAfter !== undefined && recordAfter.authorizationRef === 'named' && deps.execution !== undefined) {
          try {
            const current = await deps.execution.read(taskId)
            if (current !== undefined) {
              const waiting = waitUserExecution(current, `named_startup_failed:${running.family}`)
              await deps.execution.compareAndSet(taskId, current.version, waiting)
            }
          }
          catch { /* 记录写不上不连累卡上那一句 */ }
        }
        // 候选走完(或干上活了 / 严格点名):照旧挂「运行失败」;之前那几只是起跑失败的,把每只原因都留在 note 里。
        const startupList = [...triedWhy, whyLine]
        const terminalNote = startupFailed
          ? `起跑没跑起来:${startupList.join(';')}`
          : triedWhy.length > 0
            ? `${triedWhy.join(';')};${targetTitleOf(running.family)} 没做成:${note}`
            : `派给 ${targetTitleOf(running.family)} 没做成:${note}`
        await deps.tasks.update(taskId, {
          dispatch: { ...running, status: 'failed', ended_at: at, note, ...(sessionId === undefined ? {} : { session_id: sessionId }) },
          ...(links === undefined ? {} : { links }),
          note: terminalNote,
        })
        await moveTo(taskId, 'blocked')
        await deps.tasks.update(taskId, { blockReason: 'error' })
      }
      deps.jobLog?.append({ job: taskId, step: succeeded ? 'replied' : 'unreadable', family: running.family })
      /*
       * ★ 进程退场记一条 `ended`(2026-10-29,同一任务书):故意**排在** `replied`/`unreadable`
       * 之后 —— `runSegmentsOf` 认第一条收场步,顺序不变口径就不变(`outcome` 仍是 replied 那一格),
       * `ended` 只是「这个进程真的退了」的事实(四步表 / 满了收账都认它)。
       */
      deps.jobLog?.append({ job: taskId, step: 'ended', family: running.family, via: 'cli', ...(running.pid === undefined ? {} : { pid: running.pid }) })
      cliObserved.delete(taskId)
      cliActivityAt.delete(taskId)
      changed()
    }
    catch { /* 收尾失败:下一拍 tick 还会再看一次 */ }
    finally { finishing.delete(taskId) }
  }

  /** 看一眼一张在等回答的窗口派活。回 true = 这张卡改了。 */
  async function checkWindow(task: TaskView, dispatch: TaskClientDispatch, sessions: readonly DispatchSessionLike[]): Promise<boolean> {
    return await forTask(task.id, async () => {
      const current = await findTask(task.id)
      if (current?.client_dispatch === undefined) return false
      if (current.client_dispatch.runtime?.attempt_id !== dispatch.runtime?.attempt_id) return false
      return await checkWindowUnlocked(current ?? task, dispatch, sessions)
    })
  }
  async function checkWindowUnlocked(task: TaskView, dispatch: TaskClientDispatch, sessions: readonly DispatchSessionLike[]): Promise<boolean> {
    const family = dispatch.family
    const now = deps.now()
    const sentAt = Date.parse(dispatch.at)
    const age = Number.isNaN(sentAt) ? 0 : now.getTime() - sentAt
    let next: TaskClientDispatch = dispatch
    let links: readonly TaskLink[] | undefined

    // ① 有会话流的三家:认出那条新会话,links 进卡(首页只数一次)。认不准就空着。
    const agent = CLIENT_DISPATCH_AGENTS[family]
    let session: DispatchSessionLike | undefined
    if (agent !== undefined) {
      /*
       * ★ **送出那一刻协议就报了那条新线程的号**(2026-10-02:`JobResult.sessionId` 落到卡上的
       * `client_dispatch.session_id`)。那一格比这里的差集 / 记号猜硬得多(对端自己报的),所以
       * 认会话那一步跳过 —— 可卡上那条「去看那段对话」的链子还得挂上,不然首页数不到它。
       */
      if (dispatch.session_id !== undefined && (task.links ?? []).every(one => one.session_id !== dispatch.session_id)) {
        links = withLink(task, agent, dispatch.session_id)
      }
      if (dispatch.session_id === undefined && dispatch.match_note === undefined) {
        const claimed = (await deps.tasks.list()).tasks.flatMap(one => [
          ...(one.id === task.id ? [] : (one.links ?? []).map(link => link.session_id)),
          ...(one.id === task.id || one.client_dispatch?.session_id === undefined ? [] : [one.client_dispatch.session_id]),
        ])
        const match = matchNewSession({
          baseline: dispatch.baseline ?? [],
          current: sessions.filter(one => one.agent === agent).map(one => one.session_id).filter(isRealSessionId),
          claimed,
          sentAt: new Date(Number.isNaN(sentAt) ? now.getTime() : sentAt),
          now,
          windowMs: replyTimeoutMs,
        })
        /**
         * ★ 2026-09-28(卡 RC)**先按记号认**:派出去的那条对话里带着「工作台派活 xxxxxx」,
         * 在这一家的会话回合里搜得到它 = 那就是它的会话。比"送出之后新冒出几条"稳
         * (他自己同时开一条,差集就认不准、这一格空着,于是结果只能从窗口里摘 —— 09-28 摘成了中途句)。
         * 记号认不出来才退回差集那条老路。
         */
        const byMarker = dispatch.marker === undefined || deps.turnsOf === undefined
          ? undefined
          : sessionByMarker(dispatch.marker, sessions
              .filter(one => one.agent === agent && isRealSessionId(one.session_id) && !claimed.includes(one.session_id))
              .map((one) => {
                const turns = deps.turnsOf?.(one.session_id)
                return { session_id: one.session_id, ...(turns === undefined ? {} : { turns }) }
              }))
        if (byMarker !== undefined) {
          next = { ...next, session_id: byMarker, matched_at: now.toISOString() }
          links = withLink(task, agent, byMarker)
        }
        else if (match.kind === 'matched') {
          next = { ...next, session_id: match.session_id, matched_at: now.toISOString() }
          links = withLink(task, agent, match.session_id)
        }
        else if (match.kind === 'ambiguous') next = { ...next, match_note: match.note }
      }
      session = next.session_id === undefined ? undefined : sessions.find(one => one.session_id === next.session_id)
    }

    if (next.runtime !== undefined && next.session_id !== undefined && deps.runtimeContext !== undefined) {
      const context = await deps.runtimeContext(family, next.session_id, task.dispatch?.cwd ?? next.cwd ?? '').catch(() => undefined)
      const observed = observeRuntime(next.runtime, { family, sessionId: next.session_id, cwd: task.dispatch?.cwd ?? next.cwd ?? '', log: '', ...(context === undefined ? {} : { context }) })
      if (next.turn_id !== undefined && observed.turn_id !== next.turn_id) {
        observed.status = 'unverified'
        observed.observed = {}
      }
      if (JSON.stringify(observed) !== JSON.stringify(next.runtime)) next = { ...next, runtime: observed }
    }

    /*
     * ② **读一眼那一段此刻的回话** —— 走 `engine.read`(2026-10-02)。
     *
     * 这一下**不送、不点、不叫台前、不开窗**;`reply_watch` 那道闸在引擎里面(闸只接在引擎一处),
     * 拦下的那一拍回「没读到」,与从前 `mayRead === false` 时的效果一样:不改卡,下一拍再看。
     *
     * 从前这里自己拿壳、自己按 `dispatch.bundle_id ?? 家名` 查包、自己 `readRelayEvidence`、
     * 自己 `extractReply` —— 与捎话巡检那一份几乎一样而又不完全一样(超时 15s / 20s / 6s 三种、
     * 豆包那条退路只有一处有)。现在两处同一个 `engine.read`:
     * **送进去那一刻记下的那个包**原样交给引擎(`package`),两个豆包时不会读到另一扇窗。
     */
    let found = false
    let busy = false
    let reply = ''
    let jammed: { why: string } | undefined
    if (deps.engine !== undefined && dispatch.marker !== undefined) {
      const got = await deps.engine.read({
        id: task.id,
        itemId: task.id,
        family,
        kind: 'dispatch',
        target: next.session_id === undefined ? { kind: 'current' } : { kind: 'session', sessionId: next.session_id },
        /*
         * 两格分开:`marks[0]` 是**在对话区里找我们那一句**用的记号(卡上记的那个),
         * `text` 是我们送进去的**那一整段** —— 剥回声要整段(0.2.96 真机那一串被画成了 20 截)。
         */
        text: dispatch.text,
        marks: [dispatch.marker],
        expect: 'reply',
        ...(dispatch.bundle_id === undefined ? {} : { package: dispatch.bundle_id }),
        // 送那一刻对端报的轮号(2026-10-03):协议型只认这一轮,她自己又发了一句也不认错。
        ...(next.turn_id === undefined ? {} : { turnId: next.turn_id }),
      }).catch(() => undefined)
      // 读到了 = 在它那边看见我们那一句了(对话区里 / 协议那条的回执 / 它自己的记录里;判据一处 `READ_SEEN_EVIDENCE`)。
      found = got?.evidence !== undefined && READ_SEEN_EVIDENCE.includes(got.evidence)
      busy = got?.busy === true
      if (busy && found) {
        const events = deps.jobLog?.events(task.id) ?? []
        const lastAssigned = events.findLastIndex(one => one.step === 'assigned')
        const lastStarted = events.slice(lastAssigned < 0 ? 0 : lastAssigned + 1).filter(one => one.step === 'started').at(-1)
        if (lastStarted === undefined || deps.now().getTime() - Date.parse(lastStarted.at) >= 60_000) {
          // 只有引擎读到这条已关联会话当前正忙,才留下真实开工回执;派出/送达/看见都不算。
          deps.jobLog?.append({ job: task.id, step: 'started', family })
        }
      }
      reply = got?.reply ?? ''
      if (got?.jammed === true) jammed = { why: got.why ?? `${targetTitleOf(family)} 的窗口这会儿读不动` }
    }
    /*
     * ★ **那扇窗读不动 = 通道堵了**(2026-10-21,卡「派活按家隔离」):卡上挂那一句(哪家、哪一步、等了多久),
     * 卡一格不挪 —— **不当「没看到这一句」、也不当「它还没回」**。到了总时限(45 分钟)照旧如实收场。
     */
    if (jammed !== undefined && age <= replyTimeoutMs) {
      if (task.dispatch_lane?.state === 'jammed' && task.dispatch_lane.note === jammed.why && next === dispatch) return false
      const lane: TaskDispatchLane = { family, state: 'jammed', since: task.dispatch_lane?.state === 'jammed' ? task.dispatch_lane.since : now.toISOString(), note: jammed.why }
      await deps.tasks.update(task.id, { dispatchLane: lane, ...(next === dispatch ? {} : { clientDispatch: next }), ...(links === undefined ? {} : { links }) })
      return true
    }
    if (jammed === undefined && task.dispatch_lane?.state === 'jammed') {
      jamEndedAt.set(task.id, now.getTime())
      await deps.tasks.update(task.id, { dispatchLane: null })
    }
    if (found && !seenAt.has(task.id)) seenAt.set(task.id, now.getTime())
    /*
     * ★ **在它对话区里亲眼看见我们那一句了** → 落盘(2026-09-30 止血):卡上那一格从
     * 「按了发送,还没在它那边看到」变成「已派出 · 它那边看到了」,顺手把送出时那句「没核上」清掉。
     */
    if (found && next.seen_at === undefined) {
      deps.jobLog?.append({ job: task.id, step: 'seen', family, ...(dispatch.bundle_id === undefined ? {} : { bundle_id: dispatch.bundle_id }) })
      next = { ...next, seen_at: now.toISOString() }
      if (next.confirm_note !== undefined) { const { confirm_note: _drop, ...rest } = next; next = rest }
    }

    const done = found && replySettled({ ...(lastRead.has(task.id) ? { previous: lastRead.get(task.id) as string } : {}), current: reply, busy })
    if (found) lastRead.set(task.id, reply)

    if (done) {
      /**
       * ★ 2026-09-28(卡 RC)**结果取最后那一段交代**:认上会话(有会话文件的那几家)就从
       * 会话里最后一个回合的完整回答取;读不到会话才用窗口里读回来的那一段。
       * 09-28 那一件收回来的是 Claude 中途的过程话,而它最后那段交代(在问他「落在哪」)一个字都没进来。
       */
      const turns = next.session_id === undefined ? undefined : deps.turnsOf?.(next.session_id)
      const picked = dispatchResultOf({ windowReply: reply, ...(turns === undefined ? {} : { turns }) })
      if (picked.text !== '') reply = picked.text
      if (deps.continues?.(task.id) === true) {
        deps.jobLog?.append({ job: task.id, step: 'replied', family })
        await deps.tasks.update(task.id, {
          clientDispatch: { ...next, reply_state: 'done', reply, reply_at: now.toISOString() },
          deliverables: appendReply(task, reply, next.session_id),
          ...(links === undefined ? {} : { links }),
        })
        lastRead.delete(task.id)
        seenAt.delete(task.id)
        return true
      }
      // 读回来的「回答」里夹着我们自己派活指令里的话(2026-09-25,0.2.96 真机 Codex 那一单):
      // 多半是回答和我们那条消息没分开。**不当结果交给他验收、也不打回给那家**(那不是它的错,
      // 打回去只会在它的对话里多一条莫名其妙的话)—— 卡挂「阻塞」写清楚,原文请他去那家窗口里看。
      const leaked = promptLeaked(reply, dispatch.text)
      if (leaked !== undefined) {
        const who = targetTitleOf(family)
        await deps.tasks.update(task.id, {
          clientDispatch: {
            ...next, reply_state: 'done', reply, reply_at: now.toISOString(),
            reply_note: `读回来的这段里夹着我们派活时附的话(「${leaked}」),可能没读对;原文在 ${who} 那扇窗里`,
          },
          ...(links === undefined ? {} : { links }),
          note: `${who} 答完了,但读回来的回答里夹着我们派活时附的话(「${leaked}」),怕读错了没叫你验收 —— 原文在 ${who} 那扇窗里`,
        })
        await moveTo(task.id, 'blocked')
        await deps.tasks.update(task.id, { blockReason: 'error' })
        lastRead.delete(task.id)
        seenAt.delete(task.id)
        return true
      }
      const failed = await reviewFailed(task.id, reply, instructionOf(dispatch.text))
      // 没过、还没返工过、有打回的原话、这家能开口再说一句 → 送回**同一条对话**让它改一次。
      // 这一拍刚在那扇窗里读到我们那一句,说明此刻开着的就是这条对话,所以不开新对话。
      if (failed !== undefined && next.runtime?.status !== 'mismatch' && (next.rework ?? 0) < 1 && failed.reject_text !== undefined && failed.reject_text.trim() !== ''
        && deps.clientDispatch !== undefined) {
        const reworkMarker = `${dispatchMarker(task.id)} 返工`
        const requested = next.runtime?.requested ?? {}
        const controlled = requested.model !== undefined || requested.effort !== undefined
        // A configured run cannot be reworked through an uncontrolled foreground window.
        if (controlled && next.session_id === undefined) {
          await deps.tasks.update(task.id, { note: '原会话还没核实，不能按原模型与思考档返工' })
          await moveTo(task.id, 'blocked')
          return true
        }
        const reworkRuntime: DispatchRuntime = {
          attempt_id: randomUUID(), started_at: now.toISOString(), mode: 'resume', requested, observed: {}, status: 'unverified',
          ...(next.session_id === undefined ? {} : { session_id: next.session_id }),
        }
        const { selection: reworkSelection } = await selectionFor(task.id, family, failed.reject_text.trim())
        const reworkText = `【${reworkMarker}】${failed.reject_text.trim()}\n\n本次分工依据：${reworkSelection.reason}`
        const again = await deps.clientDispatch.send({
          family, job: task.id, resend: true, text: reworkText, submit: true, newConversation: false,
          attemptId: reworkRuntime.attempt_id,
          ...(next.session_id === undefined ? {} : { resumeSessionId: next.session_id }),
          ...(next.cwd === undefined ? {} : { cwd: next.cwd }),
          ...(requested.model === undefined ? {} : { model: requested.model }),
          ...(requested.effort === 'low' || requested.effort === 'medium' || requested.effort === 'high' ? { effort: requested.effort } : {}),
          ...(controlled ? { vias: ['protocol'] as const } : {}),
        })
        if (again.ok) {
          const { turn_id: _previousTurn, ...prior } = next
          await deps.tasks.update(task.id, {
            clientDispatch: { ...prior, runtime: reworkRuntime, selection: reworkSelection, ...(again.result?.turnId === undefined ? {} : { turn_id: again.result.turnId }), marker: reworkMarker, rework: 1, text: reworkText, at: now.toISOString() },
            ...(links === undefined ? {} : { links }),
            note: `${targetTitleOf(family)} 交回来的按你的规矩自查没过,已经打回去让它改一遍`,
          })
          lastRead.delete(task.id)
          seenAt.set(task.id, now.getTime())
          return true
        }
      }
      /**
       * ★ **一件事一条**(2026-09-28,卡 RC):那家最后那段话在问他(卡 MS 的 `replyAsksHim` 判据)——
       * 这一件既不是「办完了等你确认」,也不该在「等你」里另冒一条孤立的会话 ask:
       * 事项本身进「阻塞 · 等你输入」,**要他定的那一句就写在卡上**,他在这一条里答
       * (`casualAsk.carryOnTarget` 那一档认「阻塞 · 等你输入」→ 送回同一条对话,走捎话)。
       */
      const asking = failed === undefined ? replyAsksHim(reply) : undefined
      deps.jobLog?.append({ job: task.id, step: 'replied', family })
      // 交回:执行记录先写事实(returned → verifying),再动卡(第 3 步①)。
      void submitExecutionFact(task.id, {
        kind: 'returned', attemptId: dispatch.runtime?.attempt_id ?? '',
        planVersion: task.round ?? 1, receiptId: next.session_id ?? now.toISOString(),
      })
      await deps.tasks.update(task.id, {
        clientDispatch: { ...next, reply_state: 'done', reply, reply_at: now.toISOString() },
        deliverables: appendReply(task, reply, next.session_id),
        ...(links === undefined ? {} : { links }),
        note: failed !== undefined
          ? reviewNote(family, failed)
          : asking === undefined ? null : askedItemNote({ who: targetTitleOf(family), what: asking.what, text: reply }),
        ...receiptPatch(task, reply, now.toISOString(), family),
      })
      if (failed !== undefined || next.runtime?.status === 'mismatch') { await moveTo(task.id, 'blocked'); await deps.tasks.update(task.id, { blockReason: 'error' }) }
      else if (asking !== undefined) { await moveTo(task.id, 'blocked'); await deps.tasks.update(task.id, { blockReason: 'input' }) }
      else {
        await moveTo(task.id, landingOf(task, reply))
        // 进「等你确认」即进核验(第 4 步①:窗口手与 CLI 同一钩)。
        if ((await findTask(task.id))?.status === 'confirm') deps.onDelivered?.(task.id)
      }
      lastRead.delete(task.id)
      seenAt.delete(task.id)
      return true
    }

    // ③ 读不到窗口,但那家的会话流说它已经答完了:拿会话摘要兜底(只有开头,全文在那家里)。
    const sessionDone = session !== undefined && session.status === 'done' && (session.summary ?? '').trim() !== ''
    if (!found && sessionDone && age > pollMs * 3) {
      /**
       * 2026-09-28(卡 RC):**有会话回合就取最后那一个回合的完整回答**,摘要只是它开头 80 字的那一截。
       * 取到全文时这一格就不用再说「这是开头」。
       */
      const whole = next.session_id === undefined ? undefined : lastAssistantTurn(deps.turnsOf?.(next.session_id))
      const summary = (whole ?? session?.summary ?? '').trim()
      const asking = replyAsksHim(summary)
      // 交回:执行记录先写事实(returned → verifying),与窗口① / CLI 同口径(第 4 步①)。
      void submitExecutionFact(task.id, {
        kind: 'returned', attemptId: dispatch.runtime?.attempt_id ?? '',
        planVersion: task.round ?? 1, receiptId: next.session_id ?? now.toISOString(),
      })
      await deps.tasks.update(task.id, {
        clientDispatch: {
          ...next, reply_state: 'done', reply: summary, reply_at: now.toISOString(),
          ...(whole === undefined
            ? { reply_note: `窗口里读不到全文(那边切到了别的对话),这是它会话里最后那句的开头;全文在 ${targetTitleOf(family)} 里` }
            : {}),
        },
        deliverables: appendReply(task, summary, next.session_id),
        ...(links === undefined ? {} : { links }),
        note: asking === undefined ? null : askedItemNote({ who: targetTitleOf(family), what: asking.what, text: summary }),
        ...receiptPatch(task, summary, now.toISOString(), family),
      })
      if (asking === undefined) {
        await moveTo(task.id, landingOf(task, summary))
        if ((await findTask(task.id))?.status === 'confirm') deps.onDelivered?.(task.id)
      }
      else { await moveTo(task.id, 'blocked'); await deps.tasks.update(task.id, { blockReason: 'input' }) }
      return true
    }

    // ④ 等够了:如实说读不回来,让他到那家里看。**不假装收回来了**。
    const sinceJam = jamEndedAt.has(task.id) ? now.getTime() - (jamEndedAt.get(task.id) as number) : age
    const notSeen = jammed === undefined && !found && !seenAt.has(task.id) && age > notSeenMs && sinceJam > notSeenMs
    if (age > replyTimeoutMs || notSeen) {
      const note = notSeen
        ? `已发出,但在 ${targetTitleOf(family)} 的对话里没看到这一句(多半还在输入框里没发出去)—— 要你到 ${targetTitleOf(family)} 里看一眼`
        : `已发出,等了 ${Math.round(replyTimeoutMs / 60_000)} 分钟没读到它说完 —— 结果要你到 ${targetTitleOf(family)} 里看`
      deps.jobLog?.append({ job: task.id, step: notSeen ? 'unreadable' : 'timeout', family, why: note })
      // ★ 结果不明(第 3 步②):不开第二作者,执行记录记 reconciling + reconcile,先对账。
      void submitExecutionFact(task.id, {
        kind: 'outcome_unclear', attemptId: dispatch.runtime?.attempt_id ?? '',
        planVersion: task.round ?? 1, reason: notSeen ? 'not_seen' : 'reply_timeout', at: now.toISOString(),
      })
      await deps.tasks.update(task.id, {
        clientDispatch: {
          ...next, reply_state: 'unreadable', reply_note: note, ...(reply === '' ? {} : { reply }),
          // 一直没核上的那一次:卡上那一格要说「还没在它那边看到」,所以把这一句留着(不冒充「已派出」)。
          ...(notSeen ? { confirm_note: note } : {}),
        },
        ...(links === undefined ? {} : { links }),
        note,
      })
      /*
       * ★ **超时 / 没看到那一句 = 失败**(2026-09-30 维护者拍板的验收口径:任一步失败都明确报失败)。
       * 以前这两种都挪进「等我确认」—— 看板上跟"办完了等你验收"长得一模一样,而其实什么都没收到。
       * 现在挂「运行失败」:现成的来电规矩(`callOut.ts` blocked + error)会为它打一通,成功那一头照旧不打。
       */
      await moveTo(task.id, 'blocked')
      await deps.tasks.update(task.id, { blockReason: 'error' })
      lastRead.delete(task.id)
      seenAt.delete(task.id)
      return true
    }

    // 还在等。只在认出会话那一拍落一次盘(links / session_id),别的拍什么都不写。
    if (next !== dispatch) {
      await deps.tasks.update(task.id, { clientDispatch: next, ...(links === undefined ? {} : { links }) })
      return true
    }
    return false
  }

  /**
   * 命令行的活到时长上限了没有(统筹 09-25 拍板 ③,与「每件事的上限」同一份设置;钱不算 —— 花的是那家自己的额度)。
   * **上限这件活派出那一刻就按名片定好记下了**(`dispatch.budget_minutes`,2026-10-23 卡「派活给名片
   * 的四处」③):名片写了 `budget.minutes` 按名片,没写按命令行家缺省 120;老记录(没有这一格)
   * 退回全局设置。到了:**先把这一次记成「停下来的」**(收尾那一步看到它不在跑了就不当「没做成」收),
   * 再停那个进程,卡挂「阻塞 · 等你输入」问继续 / 停掉这一件 / 换一家(卡上三颗键 =
   * `POST /butler/item/budget`,同事务官那一套)。停下来那一刻把那家在结果日志里留下的会话号记在卡上 ——
   * 他说「继续」续跑接着原会话才接得上。
   * 回 true = 这张卡改了。
   */
  async function capCli(task: TaskView, dispatch: TaskDispatch): Promise<boolean> {
    const budget = deps.cliBudget?.()
    if (budget === undefined || dispatch.pid === undefined) return false
    const started = Date.parse(dispatch.started_at)
    if (Number.isNaN(started)) return false
    const minutes = dispatch.budget_minutes ?? (budget.minutes > 0 ? budget.minutes : 0)
    if (!(minutes > 0)) return false
    const ranMs = deps.now().getTime() - started
    if (ranMs < minutes * 60_000) return false
    const who = targetTitleOf(dispatch.family)
    const at = deps.now().toISOString()
    const ran = Math.floor(ranMs / 60_000)
    // 那家留下的会话号(续跑接原会话用):结果日志里认,认不出就缺席 —— 续跑退回新起,不编。
    let sessionId: string | undefined
    try {
      const log = dispatch.output_file === undefined || deps.readFile === undefined ? '' : (await deps.readFile(`${dispatch.output_file}.jsonl`)) ?? ''
      sessionId = log === '' ? undefined : cliSessionIdOfLog(dispatch.family, log)
    }
    catch { sessionId = undefined }
    await deps.tasks.update(task.id, {
      dispatch: { ...dispatch, status: 'failed', stopped: 'cap', ended_at: at, note: `到时长上限了(${minutes} 分钟),先停下来了`, ...(sessionId === undefined ? {} : { session_id: sessionId }) },
    })
    // ★ 租约(缺口 3):到顶**只记卡 + 发停**,不在这一刻放锁 —— SIGTERM 可能没把进程停死,
    // 放锁得等**退出证据**:exit 回调来时 finishCli 按 (attempt|pid) 放,证据 = stopped-cap
    // (卡上 `stopped:'cap'` 就是凭证)。kill 缺席/抛错/进程装死,锁都如实留着。
    try { deps.killPid?.(dispatch.pid) }
    catch { /* 进程早就不在了:照样问他 */ }
    let alternatives: TaskDispatchBlock['alternatives']
    try { alternatives = await deps.alternativesFor?.(task.id, dispatch.family, dispatch.kind ?? 'code') }
    catch { alternatives = undefined }
    const other = alternatives?.find(one => one.family !== dispatch.family)
    const where = dispatch.cwd === undefined ? '' : `;改过的东西留在 ${dispatch.cwd}`
    const ask = `到时长上限了:${who} 在后台做了 ${ran} 分钟(上限 ${minutes} 分钟),先停下来了${where}。继续、停掉这一件${other === undefined ? '' : `,还是换 ${other.title} 来做`}?`
    const view: TaskBudgetView = {
      limit_cny: budget.cny > 0 ? budget.cny : 0.5,
      limit_minutes: minutes,
      run_minutes: Math.round(ranMs / 6000) / 10,
      state: 'paused',
      paused_at: at,
      note: ask,
      cli_family: dispatch.family,
      ...(task.budget?.extended === undefined ? {} : { extended: task.budget.extended }),
      ...(other === undefined ? {} : { switch_to: other.title }),
    }
    await deps.tasks.update(task.id, { budget: view, note: ask })
    await moveTo(task.id, 'blocked')
    await deps.tasks.update(task.id, { blockReason: 'input' })
    return true
  }

  /**
   * ★ **卡进 canceled:对在跑的派发收场**(2026-10-28,任务书「取消要收场执行者」;
   * 由 `/task/move` 挪进 `canceled` 那一跳调用 —— 中枢 cancel、手机「取消这件」、板上取消键同一个口)。
   * **绝不抛**:收场那一下坏了不许把取消回话弄挂。
   *
   * 三只手各自的下场:
   * - 命令行:`dispatch.status` 写 `canceled` + `ended_at`,账上记一步 `canceled`
   *   (why `canceled_by_user`),进程 SIGTERM、10 秒没退补 SIGKILL,执行租约当场按
   *   `canceled_by_user` 释放 —— 停它的那一下已发,迟到的退出回调摘不动它、也不再改卡;
   * - 窗口:往那条会话捎一句「这件取消了,停下」(`by:'user'` —— 这是她点取消那一下带出来的,
   *   闸的「收场了就不再动那一家」对它不拦),`reply_state` 记 `canceled`:卡上不再等它交回;
   * - 接口:同步回来,取消这一刻没有在跑的,一字不动。
   *
   * 收场之后再交回来的(进程临死前的「做完」)由 `finishCli` 接住:不进 confirm、不触发核验,
   * 只落一条「取消后交回,已忽略」评论。
   */
  async function cancel(taskId: string): Promise<DispatchCancelResult> {
    return await forTask(taskId, async () => {
      try { return await cancelUnlocked(taskId) }
      catch { return { settled: false } }
    })
  }

  async function cancelUnlocked(taskId: string): Promise<DispatchCancelResult> {
    const task = await findTask(taskId)
    if (task === undefined) return { settled: false }
    const at = deps.now().toISOString()
    // ① 命令行那只手还在跑:先记 canceled(收结果那几步看到它就不再当「在跑」),再停进程、放租约。
    const cli = task.dispatch
    if (cli !== undefined && cli.status === 'running') {
      const who = targetTitleOf(cli.family)
      await deps.tasks.update(taskId, { dispatch: { ...cli, status: 'canceled', ended_at: at, note: '卡取消了,在跑的这一下停在这里' } })
      deps.jobLog?.append({ job: taskId, step: 'canceled', family: cli.family, why: 'canceled_by_user' })
      if (deps.lease !== undefined) {
        try {
          await deps.lease.release({
            taskId,
            ...(cli.runtime?.attempt_id === undefined ? {} : { runId: cli.runtime.attempt_id }),
            ...(cli.pid === undefined ? {} : { pid: cli.pid }),
            evidence: 'canceled_by_user', at,
          })
        }
        catch { /* 放不掉也不连累收场:迟到的退出回调还会按 (attempt|pid) 再认领一次 */ }
      }
      let note = `在跑的 ${who} 已停`
      if (cli.pid !== undefined) {
        try { deps.killPid?.(cli.pid) }
        catch (error) {
          // ESRCH = 进程早退了(它的退出回调会来收尾)——那也算停住了;别的是真没停下。
          if ((error as { code?: string }).code !== 'ESRCH') note = `在跑的 ${who} 没停下来,原因 ${error instanceof Error ? error.message : String(error)}`
        }
        // SIGTERM 10 秒还没退 → SIGKILL 补刀(killPidHard 缺席 = 只发 SIGTERM,老行为一字不变)。
        const pid = cli.pid
        const hard = setTimeout(() => {
          if (deps.alive?.(pid) !== true) return
          try { deps.killPidHard?.(pid) } catch { /* 那一瞬刚好退了 */ }
        }, deps.escalateAfterMs ?? 10_000)
        hard.unref?.()
      }
      changed()
      return { settled: true, note }
    }
    // ② 窗口那只手还在等回答:往那条会话捎一句「这件取消了,停下」,卡上记 canceled、不再等它交回。
    const win = task.client_dispatch
    if (win !== undefined && win.status === 'sent' && win.reply_state === 'waiting') {
      const who = targetTitleOf(win.family)
      const text = '这件取消了,停下'
      let note = `已跟 ${who} 说这件取消了,它停不停由它定`
      if (deps.clientDispatch !== undefined) {
        try {
          const said = await deps.clientDispatch.send({
            family: win.family, job: taskId, text, submit: true, newConversation: false, by: 'user',
            ...(win.session_id === undefined ? {} : { resumeSessionId: win.session_id }),
            ...(win.cwd === undefined ? {} : { cwd: win.cwd }),
          })
          if (!said.ok) note = `没停下来,原因 ${said.reason ?? `${who} 那扇窗这会儿送不进去`}`
        }
        catch { /* 捎话这一下抛了:与「没送成」同一处置,卡照样不再等它 */ }
      }
      await deps.tasks.update(taskId, { clientDispatch: { ...win, reply_state: 'canceled', reply_note: `${text};它再交回来也不收了` } })
      deps.jobLog?.append({ job: taskId, step: 'canceled', family: win.family, why: 'canceled_by_user' })
      changed()
      return { settled: true, note }
    }
    // ③ 没有在跑的派发(接口手同步回来、根本没派出去):一字不动,回话也不加句。
    return { settled: false }
  }


  /**
   * ★ **一家一圈**(2026-10-21,卡「派活按家隔离」):这一家在等回话的那几张卡逐张看一眼,
   * 然后看排着的那件轮不轮得到。一家的这一圈慢(读窗挂死),只拖它自己 —— 别家各巡各的。
   */
  async function familyRound(family: string, waiting: readonly TaskView[], sessions: readonly DispatchSessionLike[]): Promise<number> {
    roundBusy.add(family)
    let count = 0
    try {
      for (const task of waiting) {
        const dispatch = waitingWindowDispatch(task) as TaskClientDispatch
        try { if (await checkWindow(task, dispatch, sessions)) count += 1 }
        catch { /* 一张卡读坏了不连累别的卡 */ }
      }
      try { if (await promoteQueued(family)) count += 1 }
      catch { /* 轮不上就下一拍 */ }
    }
    finally { roundBusy.delete(family) }
    return count
  }

  async function cliRound(clis: readonly TaskView[]): Promise<number> {
    cliBusy = true
    let count = 0
    try {
      // 命令行那只手:进程在本进程里起的,退出时自己会收尾;这里只管**重启之后**那几个 ——
      // 进程还在就接着等,不在了就照结果文件收。
      for (const task of clis) {
        const dispatch = runningCliDispatch(task) as TaskDispatch
        if (dispatch.output_file !== undefined) await observeCli(task, (await deps.readFile(`${dispatch.output_file}.jsonl`)) ?? '')
        if (dispatch.pid !== undefined && deps.alive?.(dispatch.pid) === true) {
          // 还在跑:到时长上限了就先停下来问他(统筹拍板 ③)。
          try { if (await capCli(task, dispatch)) count += 1 }
          catch { /* 这一张没停成:下一拍再看 */ }
          continue
        }
        if (deps.alive === undefined) continue
        // 进程号不在了:收尾按「pid-gone」走 —— 租约标不确定保留,不凭这个就重派(卡「事务官机制D」)。
        // attemptId 缺席(重启后不知道旧轮次号):卡层守卫放行(老行为),租约层只标不确定。
        await finishCli(task.id, null, undefined, { pid: dispatch.pid, evidence: 'pid-gone' })
        count += 1
      }
    }
    finally { cliBusy = false }
    return count
  }

  async function tick(): Promise<number> {
    let changedCount = 0
    try {
      const list = (await deps.tasks.list()).tasks
      const windows = list.filter(task => waitingWindowDispatch(task) !== undefined)
      const clis = list.filter(task => runningCliDispatch(task) !== undefined)
      const lanes = list.filter(task => task.dispatch_lane !== undefined && task.dispatch_lane.state !== 'jammed')
      if (windows.length === 0 && clis.length === 0 && lanes.length === 0) {
        if (timer !== undefined) { clearTimer(timer); timer = undefined }
        return 0
      }
      // 落盘「正在送」、这个进程却没在送它的:插件中途被杀过(见 recoverSending)。
      for (const task of lanes) {
        if (task.dispatch_lane?.state !== 'sending') continue
        try { if (await recoverSending(task, task.dispatch_lane)) changedCount += 1 }
        catch { /* 下一拍再核 */ }
      }
      const sessions = deps.sessions()
      const families = new Set<string>([
        ...windows.map(task => (waitingWindowDispatch(task) as TaskClientDispatch).family as string),
        ...lanes.filter(task => task.dispatch_lane?.state === 'queued').map(task => task.dispatch_lane?.family as string),
      ])
      const rounds: Promise<number>[] = []
      for (const family of families) {
        if (roundBusy.has(family)) continue
        rounds.push(familyRound(family, windows.filter(task => waitingWindowDispatch(task)?.family === family), sessions))
      }
      if (clis.length > 0 && !cliBusy) rounds.push(cliRound(clis))
      for (const one of await Promise.all(rounds)) changedCount += one
      if (changedCount > 0) changed()
    }
    catch { /* 绝不抛 */ }
    return changedCount
  }

  async function resume(): Promise<void> {
    try {
      const list = (await deps.tasks.list()).tasks
      // 重启之前送出去的:当它们"见过了"(内存里那张表重启就空了)。不然读不到的那一拍会被误报成
      // 「没看到这一句发出去」—— 它们其实是在重启之前就发出去了,只是现在那扇窗切走了。
      for (const task of list) {
        const d = waitingWindowDispatch(task)
        if (d !== undefined) seenAt.set(task.id, Date.parse(d.at))
      }
      // ★ 送到一半被杀的那几件(2026-10-21):先核一眼,不丢、也不送第二遍。
      let recovered = false
      for (const task of list) {
        if (task.dispatch_lane?.state !== 'sending') continue
        try { if (await recoverSending(task, task.dispatch_lane)) recovered = true }
        catch { /* 下一拍再核 */ }
      }
      if (recovered) changed()
      const fresh = recovered ? (await deps.tasks.list()).tasks : list
      /*
       * ★ **重启后从执行记录恢复未完动作**(2026-10-29,可靠执行闭环第一批第 3 步⑤):上一只起跑
       * 失败、该换下一只还没送出的那一档(插件死在起跑失败与换手送出之间),新进程照记录接上 —
       * 已试过的不再试(不重复有副作用的派发),原交代在记录里,不让她重新交代。没换过手的未完
       * 动作(在跑的 / 排队中的 / 送一半的)由上面各自的老路接回,这里只接「换手待发」这一档。
       */
      if (deps.execution !== undefined) {
        try {
          const unfinished = await deps.execution.unfinished()
          for (const record of unfinished) {
            if (record.phase !== 'dispatching' || record.next?.kind !== 'dispatch' || record.dispatchRequest === undefined) continue
            const failed = (record.attempts ?? []).filter(one => one.outcome === 'startup-failed').map(one => one.family)
            if (failed.length === 0) continue
            const task = fresh.find(one => one.id === record.taskId)
            if (task === undefined || SETTLED_TASK_STATUS.includes(task.status)) continue
            if (runningCliDispatch(task) !== undefined || waitingWindowDispatch(task) !== undefined) continue
            if (task.dispatch_lane !== undefined) continue
            const next = handoffCandidate(record, failed)
            if (next === undefined) continue
            ensureTimer()
            scheduleHandoff(record.taskId, next as AgentDispatchFamily, record.dispatchRequest)
            changed()
          }
        }
        catch { /* 恢复那一拍坏了不连累别的 */ }
      }
      if (fresh.some(task => waitingWindowDispatch(task) !== undefined || runningCliDispatch(task) !== undefined || task.dispatch_lane !== undefined)) ensureTimer()
    }
    catch { /* 起不来就等下一次派活 */ }
  }

  function stop(): void {
    if (timer !== undefined) { clearTimer(timer); timer = undefined }
    // 已排还没送出的换手一并撤掉(服务收摊;插件真死时定时器随进程没,正是 resume 要接的那一档)。
    for (const pending of handoffTimers.values()) clearTimeout(pending)
    handoffTimers.clear()
  }

  return { start, tick, resume, cancel, stop }
}
