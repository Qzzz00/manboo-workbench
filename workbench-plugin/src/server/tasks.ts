import { sanitizeDispatchEvidence } from './dispatchEvidence.ts'
/**
 * 任务看板的事实源(设计稿 §3.5 + 2026-08-25 Ben 补的四层收敛)。
 * 落盘 ~/.dsh/workbench/tasks.json。
 *
 * 在这之前系统里**根本没有「任务」这个数据实体**——protocol.ts 一个 task 结构都没有。
 * 所以这个文件既是存储也是定义:项目下面的冲刺/模块/功能点各长什么样,由这里说了算。
 *
 * ```
 * 项目(projects.json 的既有实体)
 *   └ 冲刺 sprint(冲刺目标 + 组成版本号)
 *       └ 模块 module(模块目标)   ← 看板一条横向泳道
 *           └ 功能点 task         ← 看板上那张卡
 * ```
 *
 * 原子写(tmp + rename)与容错读(文件缺失/损坏都返回空、不抛)照抄 projects.ts 的先例;
 * 写队列串行化照抄 projectsService/scenes——load→改→save 不排队会丢更新。
 *
 * ## 不可改清单第 5 条的延伸约束(PRD §9,设计稿 §3.5)
 *
 * 事务层永远只问"卡在哪、需要什么帮助",**不得建议删除待办**。这条在这里是靠
 * **不存在**来保证的:整个文件没有一个函数会自己改动数据——没有定时器,没有"陈旧"
 * 判定,没有 archive/cleanup/prune/sweep 之类的入口。任何变化都只因为 Ben 亲手点了
 * 什么。`TASKS_SERVICE_METHODS` 把这份能力清单钉成常量,tests/server-tasks.test.ts 用
 * **精确相等**断言守着它:将来谁想加一个自动清理能力,必须先改那条断言,改的时候人
 * 一定看得见(先例:acceptance.v5.test.ts 对 MODULE_IDS 的同款守卫)。
 *
 * 删冲刺/删模块也遵守同一条:**只删那一层本身,底下的卡一张不动**,失去归属的卡退回
 * 「未归模块」泳道继续在看板上待着。级联删除等于系统替 Ben 扔掉了他没说要扔的待办。
 */
import { parseReceipt } from './noteReceipt.ts'
import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type {
  LanChannelMessage,
  LanChannelSourcePolicy,
  AgentId,
  BoardModule,
  TaskConversation,
  TaskDeliverable,
  TaskDirection,
  TaskDispatch,
  TaskSelfShip,
  SelfShipStepView,
  TaskLink,
  TaskAssignee,
  ProjectBoardMeta,
  SprintVersion,
  SprintView,
  TaskPriority,
  TaskSource,
  TaskStatus,
  TaskView,
  TaskKind,
  TasksState,
  TopicContentType,
  TopicStage,
  FeatureStage,
  WaitReason,
  TaskClientDispatch,
  ComposerMode,
  TaskAttachment,
  TaskCallMeta,
  TaskOrigin,
  TaskBudgetView,
  TaskDispatchBlock,
  TaskDispatchLane,
  TaskDispatchLaneInput,
  CapFixView,
  AgentCard,
  CollabGoal,
  CollabSprint,
  NoteComment,
  NoteEvaluation,
  NoteFrom,
  NoteReceipt,
  OwnerAsk,
  ProjectRepo,
  ProjectResource,
  CollabSquad,
  CollabTimer,
  CollabTimerRun,
  CollabTimerTemplate,
  CollabTimerTrigger,
  CollabMcpEntry,
  WorkType,
  GoalCondition,
  LanIdentity,
  LanMember,
  MessageDelivery,
  NoteMessage,
  NoteMessageIntent,
  TaskRelation,
  TaskRelationKind,
} from '../protocol.ts'
import {
  isComposerMode, isTaskOrigin, isCapFamily, isJobKind, isTaskAssigneeValue,
  AGENT_IDS, DISPATCH_HANDS, DISPATCH_STATUSES, TASK_DIRECTIONS, TASK_PRIORITIES, TASK_STATUSES, WAIT_REASONS, canTransition, isAgentDispatchFamily, isClientDispatchFamily, TASK_DELIVERABLE_KINDS,
  TASK_KINDS, TOPIC_CONTENT_TYPES, TOPIC_STAGES, DEFAULT_TOPIC_STAGE, isFeatureStage, isPublishDay, nextTopicStage,
  GOAL_CONDITIONS_MIN, GOAL_CONDITIONS_MAX, NOTE_MESSAGES_MAX, NOTE_COMMENTS_MAX, NOTE_TRANSITIONS_MAX, conditionStateOf,
} from '../protocol.ts'
import { randomBytes } from 'node:crypto'
import type { ExecutionRoleFact } from '../protocol.ts'
import { executionRoleOf, sanitizeExecutionRole } from '../protocol.ts'
import {
  migrateSprintsToGoals, rollbackGoalMigration, sanitizeAcceptance, sanitizeAgentCard, sanitizeComments, sanitizeEvaluation,
  sanitizeFrom, sanitizeGoal, sanitizeGoalCondition, sanitizeGoalSprint, sanitizeLanIdentity, sanitizeLanMember,
  sanitizeMigration, sanitizeNoteFields, sanitizeNoteMessage, sanitizeOwnerAsk,
  sanitizeProps, sanitizeLanMessage, sanitizeLanSourcePolicy, sanitizeReceipt, sanitizeRepos, sanitizeResources, sanitizeStrings, sanitizeTaskRelation, type CollabMigrationRecord,
  isoTime, sanitizeMcp, sanitizeSquad, sanitizeTimer, sanitizeTimerTrigger, SECRET_NAME, TIMER_RUNS_MAX,
} from './collabStore.ts'
import { GOAL_STATUSES } from '../protocol.ts'
import { lanMemberSnapshot, lanMembersIncomplete, lanNameConflict } from './collabLan.ts'
import { downstreamTasks, staleUpstreamTasks } from './collabRelations.ts'
import {
  importExecutionRecord,
  isTerminalPhase,
  restoreExecution,
  sanitizeExecutionRecord,
  type ExecutionRecord,
} from './taskExecution.ts'

export { migrateSprintsToGoals }

export type StoredTask = TaskView
export type StoredSprint = SprintView
export type StoredModule = BoardModule

export interface TasksFile {
  /** 2 = 加了冲刺/模块两层。读到 1(只有 tasks 的平铺版)会就地升级,见 loadTasksFile。 */
  version: 2
  tasks: StoredTask[]
  sprints: StoredSprint[]
  modules: StoredModule[]
  project_meta: ProjectBoardMeta[]
  /** 协作区(2026-10-21)的目标、冲刺、名片。缺席 = 还没有。 */
  goals?: CollabGoal[]
  goal_sprints?: CollabSprint[]
  agent_cards?: AgentCard[]
  /** 老冲刺 → 目标那一次迁移的账(回退照它撤)。缺席 = 没迁过 / 回退过。 */
  collab_migration?: CollabMigrationRecord
  /** 他说过「不挂」的那几条会话(`<家>:<id>`),「挂到哪个目标?」不再提它们。 */
  collab_dismissed?: string[]
  /**
   * 只有一个目标时事务官直接放进去的那几条会话(`<家>:<id>`;10-22 第三轮 4 维护者定),
   * 「等你」里留一行已办的说明,他换过目标 / 撤掉 / 点开看过就从这里划掉。
   */
  collab_placed?: string[]
  /**
   * ★ **会话记录回流建的便签被删过的那几条**(`<家>:<会话 id>`;2026-10-23,卡「待排的卡不许被派出去」④)。
   * 删过 = 这条会话记录不再回流建卡(`placeSession` 认这一张表,重启后仍有效);
   * 与 `collab_dismissed`(他说过「不挂」)是两张表,两件事不混。
   */
  collab_session_removed?: string[]
  /** 小队、定时派活、工作室 MCP 库的条目(2026-10-21 协作区全量;MCP 的密钥值不在这里,只在本机另一份文件)。 */
  squads?: CollabSquad[]
  timers?: CollabTimer[]
  mcp?: CollabMcpEntry[]
  /**
   * 任务之间的关系(2026-10-24 契约 §3,父子不走这里:父子用卡上的 `children`)。
   * 存在与否不影响任何自动执行——画了线不自动执行。
   */
  relations?: TaskRelation[]
  /**
   * 局域网身份与成员注册表(2026-10-24 契约 §5):没有常驻 LAN 发现服务,
   * reachable / last_seen 只在 UI 显式 refresh=1 时按需 ping。**relay 名单不在这里**。
   */
  lan_messages?: StoredLanMessage[]
  lan_source_policies?: LanChannelSourcePolicy[]
  lan_identity?: LanIdentity
  lan_members?: LanMember[]
}

type LanTransportReceipt = { message_id: string, member_id: string, at: string }
type StoredLanMessage = LanChannelMessage & { transport_receipt?: LanTransportReceipt }

function sanitizeStoredLanMessage(value: unknown, selfId: string | undefined): StoredLanMessage | undefined {
  const message = sanitizeLanMessage(value)
  if (message === undefined) return undefined
  const receipt = (value as Record<string, unknown>).transport_receipt as Partial<LanTransportReceipt> | null | undefined
  if (receipt === null || typeof receipt !== 'object' || receipt.message_id !== message.id || typeof receipt.member_id !== 'string'
    || receipt.member_id !== selfId || typeof receipt.at !== 'string' || !Number.isFinite(Date.parse(receipt.at))) return message
  return { ...message, transport_receipt: { message_id: message.id, member_id: receipt.member_id, at: receipt.at } }
}

export function defaultTasksFile(home = process.env.HOME ?? ''): string {
  return `${home}/.dsh/workbench/tasks.json`
}

export function emptyTasksFile(): TasksFile {
  return { version: 2, tasks: [], sprints: [], modules: [], project_meta: [] }
}

function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === 'string' && (TASK_STATUSES as readonly string[]).includes(value)
}

function isPriority(value: unknown): value is TaskPriority {
  return typeof value === 'string' && (TASK_PRIORITIES as readonly string[]).includes(value)
}

function isWaitReason(value: unknown): value is WaitReason {
  return typeof value === 'string' && (WAIT_REASONS as readonly string[]).includes(value)
}

function isTaskKind(value: unknown): value is TaskKind {
  return typeof value === 'string' && (TASK_KINDS as readonly string[]).includes(value)
}

function isContentType(value: unknown): value is TopicContentType {
  return typeof value === 'string' && (TOPIC_CONTENT_TYPES as readonly string[]).includes(value)
}

function isTopicStage(value: unknown): value is TopicStage {
  return typeof value === 'string' && (TOPIC_STAGES as readonly string[]).includes(value)
}

/**
 * ★ **撤掉排队时卡上那一句**(2026-10-23,卡「待排的卡不许被派出去」;断言照常量,不逐字抄中文)。
 * 10-22 事故:卡被挪回「待排」、负责人被换掉之后,同一家排队的派活出队时只看「没结案」,
 * 待排的卡还是一张张被派出去。挪回「待排」撤队(`move`)与出队前核卡(`dispatchRun`
 * 的 `queuedDispatchLeft`)写的是同一句。
 */
export const DISPATCH_QUEUE_LEFT_NOTE = '排队时你把它挪走了,没派'
export const INVITATION_UNCONFIRMED_NOTE = '邀请已认领,投递结果尚未确认;中断后请查看执行事项,不要重复邀请'

/**
 * 「推进一步」从「发布」往「复盘」走时,实际发布日还空着说的那一句。
 *
 * ★ **这一句是运营同学(Air)写的那一句,逐字**(原件
 * `contrib/air-20261002/patches/index.patch` 的 `index-01`,2026-10-03 换成她的原文)。
 * 10-02 那张卡当时自己另写了一句,现在按维护者「原封不动」的拍板换回她的。
 *
 * **界面与服务端共用这一份**:服务端把它当 `reason` 回出去,界面原样显示(D13 —— 拒绝的
 * 理由是服务端给的,界面不自己编第二句)。用例也断言这一份,不逐字抄中文。
 */
export const TOPIC_PUBLISH_DAY_FIRST = '请先确认已发布并填写实际发布日，再进入复盘'

function isDirection(value: unknown): value is TaskDirection {
  return typeof value === 'string' && (TASK_DIRECTIONS as readonly string[]).includes(value)
}

/** 关联窗口那一格的家:**只有 `AgentId`**(它指向一条真实会话,gpt / 豆包没有会话流)。 */
function isAssignee(value: unknown): value is AgentId {
  return typeof value === 'string' && (AGENT_IDS as readonly string[]).includes(value)
}

/**
 * 卡上「负责人」那一格(2026-09-22 起比 `AgentId` 宽:多了走接口那两家)。
 *
 * **与 `isAssignee` 分开**,不是重复:那一个把的是「关联窗口」,而窗口必须对得上
 * 一条真实会话;这一个把的是「这条归谁做」,派给 GPT 是一句说得通的话。
 * 合成一个的下场是 `links` 里会出现一个永远点不开的 `gpt` 窗口。
 */
function isTaskAssignee(value: unknown): value is TaskAssignee {
  // 2026-09-25(卡 N):多了人那三档(他 / 同事 / 别人)。判据收在 protocol 的 isTaskAssigneeValue,HTTP 入口同用它。
  return isAssignee(value) || isAgentDispatchFamily(value) || isTaskAssigneeValue(value)
}

/** 负责人那一格的补充最多多长(「9/29 回来写」这种一句话;长了就不是补充了)。 */
export const ASSIGNEE_NOTE_MAX = 40

/** 负责人补充的体检:去头尾空白,空 = 没有,长了截断(不整条拒:它只是一句附注)。 */
export function sanitizeAssigneeNote(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.replace(/\s+/g, ' ').trim()
  if (text === '') return undefined
  const chars = [...text]
  return chars.length <= ASSIGNEE_NOTE_MAX ? text : chars.slice(0, ASSIGNEE_NOTE_MAX).join('')
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * 单条记录的体检。**逐条挑,不是整份丢**:一条写坏了不该连累其余几十条——
 * 与 loadProjectsFile "整份坏了当空"是两个层级的容错,这里多一层是因为这些是
 * 一条一条独立的用户数据,而项目文件那几个字段是互相咬合的。
 */
function sanitizeTask(value: unknown): StoredTask | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as Record<string, unknown>
  if (typeof raw.id !== 'string' || raw.id === '') return undefined
  if (typeof raw.title !== 'string') return undefined
  // 老数据兼容(2026-09-09 七态):**没有 status 的卡按待办读出来**,不再整条丢掉。
  // 四层收敛之前的存档、以及外部工具写进来的半条记录都可能缺这个字段,而一条待办
  // 从界面上消失是最坏的一种失真——看起来像被系统清理掉了(不可改清单第 5 条延伸)。
  // 认得出但写错的值(`'已归档'` 这种)仍然整条挑掉:那不是"老格式",那是坏数据,
  // 猜一个状态给它等于替 Ben 编一句话(D13)。
  const missingStatus = raw.status === undefined || raw.status === null
  if (!missingStatus && !isTaskStatus(raw.status)) return undefined
  const status: TaskStatus = missingStatus ? 'todo' : raw.status as TaskStatus

  const source = raw.source as Record<string, unknown> | undefined
  const kind = source?.kind
  // 2026-09-21 多一个 'meeting'(会议模式):纪要里那几条待办建成的卡带它。**additive** ——
  // 旧存档里没有这个值,读进来一个字不变;认不出的值照旧退回 'manual',不抛。
  const sourceKind = kind === 'note' || kind === 'session' || kind === 'file' || kind === 'meeting' ? kind : 'manual'
  const ref = str(source?.ref)

  return {
    id: raw.id,
    title: raw.title,
    // 卡名来源(2026-10-23,卡 A)。只认这两个值,认不出挑掉这个字段(卡本身留着)。
    ...(raw.title_from === 'session' || raw.title_from === 'custom' ? { title_from: raw.title_from } : {}),
    // 「落地」口回话(2026-10-24,卡 1a):手机上优先显示它。只认非空字符串。
    ...(str(raw.say_note) === undefined ? {} : { say_note: raw.say_note as string }),
    ...(str(raw.desc) === undefined ? {} : { desc: raw.desc as string }),
    status,
    ...(sanitizeExecutionRole(raw.execution_role) === undefined ? {} : { execution_role: sanitizeExecutionRole(raw.execution_role) as ExecutionRoleFact }),
    ...(str(raw.project_id) === undefined ? {} : { project_id: raw.project_id as string }),
    ...(str(raw.module_id) === undefined ? {} : { module_id: raw.module_id as string }),
    // 选题那三样(2026-09-21)。**认不出只挑掉这个字段,卡本身留着** —— 同 block_reason /
    // direction 的老取舍:它们是"这张卡是不是一条选题、走到哪一段"的标记,不是卡的骨架,
    // 为它整条丢卡就是让一条待办从界面上消失(不可改清单第 5 条延伸)。
    // 字段整个缺席 = 普通事项,「做产品」模板下永远走这一支。
    ...(isTaskKind(raw.kind) ? { kind: raw.kind } : {}),
    ...(isContentType(raw.content_type) ? { content_type: raw.content_type } : {}),
    ...(isTopicStage(raw.stage) ? { stage: raw.stage } : {}),
    // 需求卡走到哪一态(2026-09-22)。**认不出只挑掉这个字段**,卡本身留着 —— 同 kind / stage。
    ...(isFeatureStage(raw.feature_stage) ? { feature_stage: raw.feature_stage } : {}),
    ...(isPriority(raw.priority) ? { priority: raw.priority } : {}),
    ...(isTaskAssignee(raw.assignee) ? { assignee: raw.assignee } : {}),
    // 管理(2026-10-27):与负责人同一套判据,认不出只挑掉这个字段。
    ...(isTaskAssignee(raw.manager) ? { manager: raw.manager } : {}),
    // 负责人那一格的补充(2026-09-25,卡 N)。认不出只挑掉这个字段。
    ...(sanitizeAssigneeNote(raw.assignee_note) === undefined ? {} : { assignee_note: sanitizeAssigneeNote(raw.assignee_note) as string }),
    ...(str(raw.due) === undefined ? {} : { due: raw.due as string }),
    // 发布计划那两个日期(2026-09-22 两状态)。**形状不对只挑掉这个字段,卡本身留着**
    // (同 kind / stage 的老取舍)。为什么这两个要把关而 `due` 不把关:见 protocol.ts
    // isPublishDay 顶上那段 —— 它们唯一的用处是把卡摆进月历的某一格,形状不对就永远落不进去。
    ...(isPublishDay(raw.planned_at) ? { planned_at: raw.planned_at } : {}),
    ...(isPublishDay(raw.published_at) ? { published_at: raw.published_at } : {}),
    // 认不出的阻塞原因**只挑掉这个字段**(卡本身留着):它是一句附注,不是卡的骨架——
    // 为它整条丢卡就是让一张待办从界面上消失(与上面 status 的取舍互补)。
    ...(isWaitReason(raw.block_reason) ? { block_reason: raw.block_reason } : {}),
    ...(sanitizeLinks(raw.links).length === 0 ? {} : { links: sanitizeLinks(raw.links) }),
    // 方向与会话(2026-09-10 事项收件箱)。认不出的方向**只挑掉这个字段**,卡本身留着——
    // 它是"这张卡是不是一条事项"的标记,不是卡的骨架(同 block_reason 的取舍)。
    ...(isDirection(raw.direction) ? { direction: raw.direction } : {}),
    // 谁写下的(2026-09-25)与通话纪要那一通。同 direction 的取舍:**认不出只挑掉这个字段**,卡本身留着。
    ...(isTaskOrigin(raw.origin) ? { origin: raw.origin } : {}),
    // 「只是问了一句」那一章(2026-09-25,卡 Y)。**只认 true**,别的值当没盖章 —— 那张卡就照常是一件事。
    // 宁可多算一件(他看得见、能自己收掉)也不能少算一件:少算就是一件事从界面上消失。
    ...(raw.casual === true ? { casual: true } : {}),
    // 演示用的那几张(2026-10-13,`server/demoSeed.ts`)。**只认 true**,别的值当没记号 ——
    // 那张卡就照常是她自己的一条(同 `casual` 的取舍:宁可少一个记号,不替她把一条真事当演示数据清掉)。
    ...(raw.demo === true ? { demo: true } : {}),
    /**
     * ★ **她看过这件事的结果了**(2026-10-04,卡 `claude/answer-comes-to-her`)。同 `casual` 的取舍:
     * **认不出只挑掉这个字段**,卡本身留着 —— 那张卡就照常再在首页「刚办完」里摆一次。
     * 宁可让她多看一眼(她划一下就收)也不能少看一眼:少看就是一个结果从她面前消失。
     */
    ...(typeof raw.seen_result_at === 'string' && Number.isFinite(Date.parse(raw.seen_result_at))
      ? { seen_result_at: raw.seen_result_at }
      : {}),
    ...(sanitizeCallMeta(raw.call) === undefined ? {} : { call: sanitizeCallMeta(raw.call) as TaskCallMeta }),
    ...(sanitizeConversation(raw.conversation) === undefined
      ? {}
      : { conversation: sanitizeConversation(raw.conversation) as TaskConversation }),
    ...(sanitizeDeliverables(raw.deliverables).length === 0 ? {} : { deliverables: sanitizeDeliverables(raw.deliverables) }),
    // 最近一次送话进客户端窗口(2026-09-21)。认不出只挑掉这个字段。
    ...(sanitizeClientDispatch(raw.client_dispatch) === undefined
      ? {}
      : { client_dispatch: sanitizeClientDispatch(raw.client_dispatch) as TaskClientDispatch }),
    // 工作台记的那句话(2026-09-16):会话怎么结束的。空串等于没有。
    ...(str(raw.note) === undefined ? {} : { note: raw.note as string }),
    // 派活记录(2026-09-21)。同 block_reason 的取舍:**认不出只挑掉这个字段**,卡本身留着。
    ...(sanitizeDispatch(raw.dispatch) === undefined
      ? {}
      : { dispatch: sanitizeDispatch(raw.dispatch) as TaskDispatch }),
    // ★ 执行记录(2026-10-29,可靠执行闭环第一批第 1 步):认不出只挑掉这个字段,卡本身留着。
    ...(sanitizeExecutionRecord(raw.execution) === undefined
      ? {}
      : { execution: sanitizeExecutionRecord(raw.execution) as ExecutionRecord }),
    // 「改工作台自己」那条闭环(2026-09-23)。同 dispatch 的取舍:认不出**只挑掉这个字段**,卡本身留着。
    ...(sanitizeSelfShip(raw.self_ship) === undefined
      ? {}
      : { self_ship: sanitizeSelfShip(raw.self_ship) as TaskSelfShip }),
    ...(str(raw.done_at) === undefined ? {} : { done_at: raw.done_at as string }),
    // 派活挑不到手、花费上限(2026-09-25,卡 O)。同 dispatch 的取舍:认不出只挑掉这个字段,卡本身留着。
    ...(sanitizeDispatchBlock(raw.dispatch_block) === undefined ? {} : { dispatch_block: sanitizeDispatchBlock(raw.dispatch_block) as TaskDispatchBlock }),
    ...(sanitizeBudget(raw.budget) === undefined ? {} : { budget: sanitizeBudget(raw.budget) as TaskBudgetView }),
    // 窗口通道里排着 / 正送着 / 读不动(2026-10-21)。认不出只挑掉这个字段。
    ...(sanitizeDispatchLane(raw.dispatch_lane) === undefined ? {} : { dispatch_lane: sanitizeDispatchLane(raw.dispatch_lane) as TaskDispatchLane }),
    // 统一输入框(2026-09-24):交办时的档与附件。认不出只挑掉这个字段。
    ...(isComposerMode(raw.mode) ? { mode: raw.mode } : {}),
    ...(sanitizeAttachments(raw.attachments).length === 0 ? {} : { attachments: sanitizeAttachments(raw.attachments) }),
    // 协作区那几格(2026-10-21;要本人拍板的 owner_ask 也在其中,2026-10-26)。同上面的取舍:认不出只挑掉那一格。
    ...(sanitizeNoteFields(raw) as Partial<StoredTask>),
    source: { kind: sourceKind, ...(ref === undefined ? {} : { ref }) },
    created_at: typeof raw.created_at === 'string' ? raw.created_at : '',
    updated_at: typeof raw.updated_at === 'string' ? raw.updated_at : '',
  }
}

/**
 * 通话纪要那一通的体检(2026-09-25)。kind 认不出、摘要空 —— 整条丢掉(卡照留)。
 * 摘要最多 120 字:这里放的是**一句话**,全文在 desc 里(引导那通连全文都不放)。
 */
export function sanitizeCallMeta(value: unknown): TaskCallMeta | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as Record<string, unknown>
  if (raw.kind !== 'onboarding' && raw.kind !== 'call') return undefined
  if (typeof raw.summary !== 'string' || raw.summary.trim() === '') return undefined
  const seconds = raw.duration_seconds
  return {
    kind: raw.kind,
    summary: raw.summary.trim().slice(0, CALL_SUMMARY_MAX),
    ...(typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0 ? { duration_seconds: Math.round(seconds) } : {}),
  }
}

/** 通话摘要那一句最多几个字。 */
export const CALL_SUMMARY_MAX = 120

/** 卡上附件的体检:只留 `{name, image}`,名字空的丢掉,最多 20 个。 */
export function sanitizeAttachments(value: unknown): TaskAttachment[] {
  if (!Array.isArray(value)) return []
  const out: TaskAttachment[] = []
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue
    const raw = item as Record<string, unknown>
    if (typeof raw.name !== 'string' || raw.name.trim() === '') continue
    out.push({ name: raw.name, image: raw.image === true })
    if (out.length >= 20) break
  }
  return out
}

/**
 * 派活记录的体检(2026-09-21)。认不出家、认不出状态 —— 整条丢掉。
 *
 * 为什么这两样一样都不能少:小标上写的是「派给 X · 进行中」,缺一样这句话就拼不出来;
 * 而拼不出来时界面能做的只有编一个 —— 那正是 D13 要挡住的。`pid` 可以没有(事务官没报),
 * 那时卡面上不画「停掉」按钮。
 *
 * ★ **工作目录从"必须有"改成"看是哪只手"**(2026-09-22):命令行与窗口那两只手真在某个
 * 目录里动东西,少了它这条记录就不完整;而**接口那只手不碰文件**(它只回一段字),
 * 「让 GPT 写条文案」这种活根本没有仓库 —— 那时要么整条丢掉(卡上什么都不显示,
 * 等于这次派活白派了),要么编一个目录。两条都不对,所以按手分。
 */
export function sanitizeDispatch(value: unknown): TaskDispatch | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as Record<string, unknown>
  if (!isAgentDispatchFamily(raw.family)) return undefined
  if (!(DISPATCH_STATUSES as readonly unknown[]).includes(raw.status)) return undefined
  // 认不出的手**按缺席读**(= cli),不整条丢掉:手是"怎么送的",不是这条记录的骨架。
  const hand = (DISPATCH_HANDS as readonly unknown[]).includes(raw.hand) ? raw.hand as TaskDispatch['hand'] : undefined
  const cwd = str(raw.cwd)
  if (cwd === undefined && hand !== 'api') return undefined
  const pid = typeof raw.pid === 'number' && Number.isInteger(raw.pid) && raw.pid > 0 ? raw.pid : undefined
  const endedAt = str(raw.ended_at)
  const note = str(raw.note)
  // 2026-09-24(卡 F):收回来的回答、命令行的结果文件、那家的会话 id。都是可缺的加法,老记录一字不变。
  const reply = str(raw.reply)
  const outputFile = str(raw.output_file)
  const sessionId = str(raw.session_id)
  // 2026-09-25(卡 O):停下来的(他按的 / 到时长上限)、活的类型、独立工作区的分支。都是可缺的加法。
  const stopped = raw.stopped === 'user' || raw.stopped === 'cap' ? raw.stopped : undefined
  const kind = isJobKind(raw.kind) ? raw.kind : undefined
  const branch = str(raw.branch)
  // 2026-10-23(卡「派活给名片的四处」③):这件活的时长上限(分钟),派出那一刻按名片/缺省解析好记下。
  const budgetMinutes = typeof raw.budget_minutes === 'number' && Number.isFinite(raw.budget_minutes) && raw.budget_minutes >= 1 && raw.budget_minutes <= 24 * 60 ? Math.round(raw.budget_minutes) : undefined
  // 2026-10-28(任务书「按产物核三个洞」洞1):这一轮的派发基线,交回核验的 diff 类拿它当比对基线。
  const baseSha = str(raw.base_sha)
  return {
    family: raw.family,
    ...sanitizeDispatchEvidence(raw),
    status: raw.status as TaskDispatch['status'],
    ...(hand === undefined ? {} : { hand }),
    ...(cwd === undefined ? {} : { cwd }),
    ...(pid === undefined ? {} : { pid }),
    started_at: typeof raw.started_at === 'string' ? raw.started_at : '',
    ...(endedAt === undefined ? {} : { ended_at: endedAt }),
    ...(note === undefined ? {} : { note }),
    ...(reply === undefined ? {} : { reply }),
    ...(outputFile === undefined ? {} : { output_file: outputFile }),
    ...(sessionId === undefined ? {} : { session_id: sessionId }),
    ...(stopped === undefined ? {} : { stopped }),
    ...(kind === undefined ? {} : { kind }),
    ...(branch === undefined ? {} : { branch }),
    ...(budgetMinutes === undefined ? {} : { budget_minutes: budgetMinutes }),
    ...(baseSha === undefined ? {} : { base_sha: baseSha }),
  }
}

/** 「改自己」那条闭环的四种样子。 */
const SELF_SHIP_STATUSES: readonly string[] = ['branched', 'running', 'ok', 'failed']

/**
 * 「改工作台自己」那条记录的体检(2026-09-23)。
 *
 * `status` 认不出 —— **整条丢掉**:卡上那一行写的就是"在哪条分支上、跑到哪了",
 * 缺了它这句话拼不出来,而拼不出来时界面能做的只有编一个(D13)。
 *
 * 八步那个数组**逐条过门,坏的挑掉**:一条坏的步骤记录不该让整条线消失
 * (同 `审核记录.jsonl` 里"一行坏字跳过这一行"的分寸)。
 */
function sanitizeFix(value: unknown): CapFixView | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as Record<string, unknown>
  // 2026-09-30:「把那家叫到台前」那一档删了(维护者拍板),老卡上存着的那种 fix 从此认不出 → 整格丢掉。
  const kinds = ['login_cli', 'grant_ax', 'update_shell']
  if (typeof raw.kind !== 'string' || !kinds.includes(raw.kind) || !isCapFamily(raw.family) || str(raw.label) === undefined) return undefined
  return {
    kind: raw.kind as CapFixView['kind'],
    family: raw.family,
    label: raw.label as string,
    ...(str(raw.hint) === undefined ? {} : { hint: raw.hint as string }),
    ...(raw.desk_only === true ? { desk_only: true } : {}),
  }
}

/** 派活挑不到手那一格(2026-09-25,卡 O)。家认不出、没有原因 → 整格丢掉(卡照留)。 */
export function sanitizeDispatchBlock(value: unknown): TaskDispatchBlock | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as Record<string, unknown>
  if (!isAgentDispatchFamily(raw.family) || !isJobKind(raw.kind) || str(raw.why) === undefined) return undefined
  const fix = sanitizeFix(raw.fix)
  const alternatives = Array.isArray(raw.alternatives)
    ? (raw.alternatives as unknown[]).flatMap((one) => {
        if (typeof one !== 'object' || one === null) return []
        const alt = one as Record<string, unknown>
        if (!(alt.family === 'dsh' || isAgentDispatchFamily(alt.family)) || str(alt.title) === undefined) return []
        return [{ family: alt.family as NonNullable<TaskDispatchBlock['alternatives']>[number]['family'], title: alt.title as string, ...(str(alt.note) === undefined ? {} : { note: alt.note as string }) }]
      }).slice(0, 8)
    : []
  return {
    family: raw.family,
    kind: raw.kind,
    why: raw.why as string,
    ...(fix === undefined ? {} : { fix }),
    ...(alternatives.length === 0 ? {} : { alternatives }),
    ...(raw.unlock === true ? { unlock: true as const } : {}),
    at: typeof raw.at === 'string' ? raw.at : '',
  }
}

/** 窗口通道那一格(2026-10-21,卡「派活按家隔离」)。家 / 状态 / 时刻 / 那句话缺一样就整格丢掉(卡照留)。 */
export function sanitizeDispatchLane(value: unknown): TaskDispatchLane | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as Record<string, unknown>
  if (!isAgentDispatchFamily(raw.family)) return undefined
  if (raw.state !== 'queued' && raw.state !== 'sending' && raw.state !== 'jammed') return undefined
  if (str(raw.since) === undefined || str(raw.note) === undefined) return undefined
  const input = sanitizeDispatchLaneInput(raw.input)
  return {
    family: raw.family,
    state: raw.state,
    since: raw.since as string,
    note: raw.note as string,
    ...(str(raw.behind) === undefined ? {} : { behind: raw.behind as string }),
    ...(str(raw.step) === undefined ? {} : { step: raw.step as string }),
    ...(typeof raw.waited_ms === 'number' && Number.isFinite(raw.waited_ms) && raw.waited_ms >= 0 ? { waited_ms: raw.waited_ms } : {}),
    ...(input === undefined ? {} : { input }),
    ...(str(raw.marker) === undefined ? {} : { marker: raw.marker as string }),
    ...(str(raw.text) === undefined ? {} : { text: raw.text as string }),
  }
}

function sanitizeDispatchLaneInput(value: unknown): TaskDispatchLaneInput | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as Record<string, unknown>
  if (str(raw.said) === undefined) return undefined
  const skills = Array.isArray(raw.skills) ? (raw.skills as unknown[]).filter((one): one is string => typeof one === 'string' && one !== '') : []
  return {
    ...(raw.resume === true ? { resume: true } : {}),
    said: raw.said as string,
    ...(str(raw.cwd) === undefined ? {} : { cwd: raw.cwd as string }),
    ...(raw.cwd_fixed === true ? { cwd_fixed: true } : {}),
    ...(str(raw.project) === undefined ? {} : { project: raw.project as string }),
    ...(isJobKind(raw.kind) ? { kind: raw.kind } : {}),
    ...(typeof raw.submit === 'boolean' ? { submit: raw.submit } : {}),
    ...(skills.length === 0 ? {} : { skills }),
  }
}

/** 花费 / 时长上限那一格(2026-09-25,卡 O)。上限不是正数、状态认不出 → 整格丢掉(卡照留)。 */
export function sanitizeBudget(value: unknown): TaskBudgetView | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as Record<string, unknown>
  const positive = (one: unknown): one is number => typeof one === 'number' && Number.isFinite(one) && one > 0
  const nonNegative = (one: unknown): one is number => typeof one === 'number' && Number.isFinite(one) && one >= 0
  if (!positive(raw.limit_cny) || !positive(raw.limit_minutes)) return undefined
  if (raw.state !== 'running' && raw.state !== 'paused' && raw.state !== 'stopped') return undefined
  return {
    limit_cny: raw.limit_cny,
    limit_minutes: raw.limit_minutes,
    /*
     * ★ 步数那条线 2026-10-04 **去掉了**(卡「事务官上限只看钱」)。这一格**只为老数据留着**:
     * 落盘里老卡上有它就照旧读得懂、不把整格丢掉(老数据不坏),但工作台既不判它也不再写它
     * (`itemBudget.budgetVerdict` 不把它放进视图)。
     */
    ...(positive(raw.limit_steps) ? { limit_steps: Math.round(raw.limit_steps) } : {}),
    ...(nonNegative(raw.spent_cny) ? { spent_cny: raw.spent_cny } : {}),
    ...(nonNegative(raw.run_minutes) ? { run_minutes: raw.run_minutes } : {}),
    ...(nonNegative(raw.requests) ? { requests: Math.round(raw.requests) } : {}),
    ...(str(raw.model) === undefined ? {} : { model: raw.model as string }),
    state: raw.state,
    ...(nonNegative(raw.extended) ? { extended: Math.round(raw.extended) } : {}),
    ...(str(raw.note) === undefined ? {} : { note: raw.note as string }),
    ...(str(raw.paused_at) === undefined ? {} : { paused_at: raw.paused_at as string }),
    ...(str(raw.switch_to) === undefined ? {} : { switch_to: raw.switch_to as string }),
    ...(isAgentDispatchFamily(raw.cli_family) ? { cli_family: raw.cli_family } : {}),
    // 事务官自己报的「卡在哪」(2026-10-04)。空字符串 = 它撤了这一句 → 缺席。
    ...(str(raw.stuck) === undefined ? {} : { stuck: raw.stuck as string }),
    ...(str(raw.stuck_at) === undefined ? {} : { stuck_at: raw.stuck_at as string }),
  }
}

export function sanitizeSelfShip(value: unknown): TaskSelfShip | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as Record<string, unknown>
  if (typeof raw.status !== 'string' || !SELF_SHIP_STATUSES.includes(raw.status)) return undefined
  const steps = Array.isArray(raw.steps)
    ? (raw.steps as unknown[]).flatMap((one) => {
        if (typeof one !== 'object' || one === null) return []
        const step = one as Record<string, unknown>
        if (typeof step.id !== 'string' || typeof step.title !== 'string') return []
        if (typeof step.status !== 'string') return []
        return [{
          id: step.id as SelfShipStepView['id'],
          title: step.title,
          status: step.status as SelfShipStepView['status'],
          ...(str(step.note) === undefined ? {} : { note: step.note as string }),
          ...(str(step.at) === undefined ? {} : { at: step.at as string }),
        }]
      })
    : []
  return {
    status: raw.status as TaskSelfShip['status'],
    ...(str(raw.branch) === undefined ? {} : { branch: raw.branch as string }),
    ...(str(raw.worktree) === undefined ? {} : { worktree: raw.worktree as string }),
    ...(str(raw.stopped_at) === undefined
      ? {}
      : { stopped_at: raw.stopped_at as NonNullable<TaskSelfShip['stopped_at']> }),
    ...(str(raw.note) === undefined ? {} : { note: raw.note as string }),
    ...(str(raw.version) === undefined ? {} : { version: raw.version as string }),
    ...(str(raw.previous_version) === undefined ? {} : { previous_version: raw.previous_version as string }),
    ...(steps.length === 0 ? {} : { steps }),
    started_at: typeof raw.started_at === 'string' ? raw.started_at : '',
    ...(str(raw.ended_at) === undefined ? {} : { ended_at: raw.ended_at as string }),
  }
}

/**
 * 关联窗口的体检。认不出 agent 的整条丢掉——界面会拿它去 /state.sessions 里现查状态,
 * 一个不存在的来源查出来永远是"没有",那比不显示更容易误导。
 */
function sanitizeLinks(value: unknown): TaskLink[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null) return []
    const raw = entry as Record<string, unknown>
    if (!isAssignee(raw.agent)) return []
    const sessionId = str(raw.session_id)
    if (sessionId === undefined) return []
    const note = str(raw.note)
    return [{ agent: raw.agent, session_id: sessionId, ...(note === undefined ? {} : { note }),
      ...(sanitizeExecutionRole(raw.execution_role) === undefined ? {} : { execution_role: sanitizeExecutionRole(raw.execution_role) as ExecutionRoleFact }) }]
  })
}

/**
 * 事项那段对话的体检(2026-09-10)。**只认 `agent:'dsh'`**:一事项一会话开的是我们自己的
 * DSH 会话;别家的窗口走 links,混进这里的话界面会拿一个 DSH 里不存在的 id 去 open,点了没反应。
 */
export function sanitizeConversation(value: unknown): TaskConversation | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as Record<string, unknown>
  if (raw.agent !== 'dsh') return undefined
  const sessionId = str(raw.session_id)
  if (sessionId === undefined) return undefined
  const archivedAt = str(raw.archived_at)
  return { agent: 'dsh', session_id: sessionId, ...(archivedAt === undefined ? {} : { archived_at: archivedAt }) }
}

/**
 * 送话那一次的体检(2026-09-21)。**认不出只挑掉这个字段,卡本身留着**——
 * 它是卡上一句"这段话送到哪儿去了",不是卡的骨架(同 block_reason / direction 的取舍)。
 *
 * `text` 一个字都不改地留着:卡面要把送出去的原话显示出来(卡上的规矩第 4 条)。
 */
export function sanitizeClientDispatch(value: unknown): TaskClientDispatch | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as Record<string, unknown>
  if (raw.hand !== 'window') return undefined
  if (!isClientDispatchFamily(raw.family)) return undefined
  // `typed` = 字写进框里了但没发出去(2026-09-28,卡 WR)。
  if (raw.status !== 'sent' && raw.status !== 'typed' && raw.status !== 'failed') return undefined
  const at = str(raw.at)
  if (at === undefined) return undefined
  if (typeof raw.text !== 'string' || raw.text === '') return undefined
  const baseline = Array.isArray(raw.baseline)
    ? raw.baseline.filter((v): v is string => typeof v === 'string')
    : undefined
  const draft = sanitizeClientDraft(raw.draft)
  return {
    hand: 'window',
    ...sanitizeDispatchEvidence(raw),
    ...(str(raw.cwd) === undefined ? {} : { cwd: raw.cwd as string }),
    family: raw.family,
    status: raw.status,
    at,
    text: raw.text,
    ...(str(raw.method) === undefined ? {} : { method: raw.method as string }),
    ...(typeof raw.submitted === 'boolean' ? { submitted: raw.submitted } : {}),
    ...(str(raw.reason) === undefined ? {} : { reason: raw.reason as string }),
    ...(str(raw.session_id) === undefined ? {} : { session_id: raw.session_id as string }),
    ...(str(raw.matched_at) === undefined ? {} : { matched_at: raw.matched_at as string }),
    ...(str(raw.match_note) === undefined ? {} : { match_note: raw.match_note as string }),
    // 2026-10-03:送进去的是它的哪一轮(协议型报的);盯窗读回话只认这一轮。白名单漏了它,卡上就永远记不住。
    ...(str(raw.turn_id) === undefined ? {} : { turn_id: raw.turn_id as string }),
    ...(baseline === undefined ? {} : { baseline }),
    // 2026-09-24(卡 F):读回答那一套。认不出的收回状态只挑掉这一格(当成老记录,不再去读)。
    ...(str(raw.marker) === undefined ? {} : { marker: raw.marker as string }),
    ...(str(raw.new_conversation) === undefined ? {} : { new_conversation: raw.new_conversation as string }),
    ...(raw.reply_state === 'waiting' || raw.reply_state === 'done' || raw.reply_state === 'unreadable' || raw.reply_state === 'canceled'
      ? { reply_state: raw.reply_state }
      : {}),
    ...(str(raw.reply) === undefined ? {} : { reply: raw.reply as string }),
    ...(str(raw.reply_at) === undefined ? {} : { reply_at: raw.reply_at as string }),
    ...(str(raw.reply_note) === undefined ? {} : { reply_note: raw.reply_note as string }),
    ...(typeof raw.rework === 'number' && Number.isInteger(raw.rework) && raw.rework > 0 ? { rework: raw.rework } : {}),
    // 2026-09-30 止血:真送进去的那个包 / 亲眼看见那一句的时刻 / 没核上时那一句(卡上「派出去了没有」那一格的原料)。
    ...(str(raw.bundle_id) === undefined ? {} : { bundle_id: raw.bundle_id as string }),
    ...(str(raw.seen_at) === undefined ? {} : { seen_at: raw.seen_at as string }),
    ...(str(raw.confirm_note) === undefined ? {} : { confirm_note: raw.confirm_note as string }),
    ...(draft === undefined ? {} : { draft }),
  }
}

/** 让了位的草稿那一格(卡 DB):形状不对整格挑掉 —— 半截的"存哪了"比没有更误导。 */
function sanitizeClientDraft(value: unknown): TaskClientDispatch['draft'] {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as Record<string, unknown>
  if (typeof raw.saved !== 'boolean' || typeof raw.returned !== 'boolean' || typeof raw.note !== 'string') return undefined
  if (raw.saved_to !== undefined && typeof raw.saved_to !== 'string') return undefined
  return {
    saved: raw.saved,
    ...(raw.saved_to === undefined ? {} : { saved_to: raw.saved_to }),
    returned: raw.returned,
    note: raw.note,
  }
}

/**
 * 交付物的体检(2026-09-09)。认不出 kind、或 ref 为空的那条丢掉——一条「不知道是什么的空东西」
 * 摆在「交付物」下面,会让「等我确认」那列看起来有东西可验,其实没有。repo 只在非空时保留。
 */
export function sanitizeDeliverables(value: unknown): TaskDeliverable[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null) return []
    const raw = entry as Record<string, unknown>
    const kind = raw.kind
    if (typeof kind !== 'string' || !(TASK_DELIVERABLE_KINDS as readonly string[]).includes(kind)) return []
    const ref = typeof raw.ref === 'string' ? raw.ref.trim() : ''
    if (ref === '') return []
    const repo = typeof raw.repo === 'string' ? raw.repo.trim() : ''
    // 依据(2026-09-16):reply 那一类带它出自哪条会话。别的类没有,有也丢掉——别的类的依据是 ref 本身。
    const sessionId = kind === 'reply' && typeof raw.session_id === 'string' ? raw.session_id.trim() : ''
    return [{ kind: kind as TaskDeliverable['kind'], ref, ...(repo === '' ? {} : { repo }), ...(sessionId === '' ? {} : { session_id: sessionId }) }]
  })
}

function sanitizeVersions(value: unknown): SprintVersion[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null) return []
    const raw = entry as Record<string, unknown>
    const label = str(raw.label)
    const version = str(raw.version)
    // 半条版本号(只有"客户端"没有号,或反过来)在界面上是一句读不懂的话,不留。
    return label === undefined || version === undefined ? [] : [{ label, version }]
  })
}

function sanitizeSprint(value: unknown): StoredSprint | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as Record<string, unknown>
  if (typeof raw.id !== 'string' || raw.id === '') return undefined
  if (typeof raw.project_id !== 'string' || raw.project_id === '') return undefined
  if (typeof raw.name !== 'string' || raw.name === '') return undefined
  return {
    id: raw.id,
    project_id: raw.project_id,
    name: raw.name,
    ...(str(raw.goal) === undefined ? {} : { goal: raw.goal as string }),
    versions: sanitizeVersions(raw.versions),
    ...(str(raw.starts_at) === undefined ? {} : { starts_at: raw.starts_at as string }),
    ...(str(raw.ends_at) === undefined ? {} : { ends_at: raw.ends_at as string }),
    created_at: typeof raw.created_at === 'string' ? raw.created_at : '',
    updated_at: typeof raw.updated_at === 'string' ? raw.updated_at : '',
  }
}

function sanitizeModule(value: unknown): StoredModule | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as Record<string, unknown>
  if (typeof raw.id !== 'string' || raw.id === '') return undefined
  if (typeof raw.sprint_id !== 'string' || raw.sprint_id === '') return undefined
  if (typeof raw.name !== 'string' || raw.name === '') return undefined
  return {
    id: raw.id,
    sprint_id: raw.sprint_id,
    name: raw.name,
    ...(str(raw.goal) === undefined ? {} : { goal: raw.goal as string }),
    ...(str(raw.version_label) === undefined ? {} : { version_label: raw.version_label as string }),
    created_at: typeof raw.created_at === 'string' ? raw.created_at : '',
    updated_at: typeof raw.updated_at === 'string' ? raw.updated_at : '',
  }
}

function sanitizeMeta(value: unknown): ProjectBoardMeta | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as Record<string, unknown>
  if (typeof raw.project_id !== 'string' || raw.project_id === '') return undefined
  return {
    project_id: raw.project_id,
    ...(isPriority(raw.priority) ? { priority: raw.priority } : {}),
    // 项目负责人**只认 AgentId**(不跟事项的负责人一起放宽,理由见 protocol 的 ProjectBoardMeta)。
    ...(isAssignee(raw.assignee) ? { assignee: raw.assignee } : {}),
    ...(sanitizeRepos(raw.repos).length === 0 ? {} : { repos: sanitizeRepos(raw.repos) }),
    ...(sanitizeResources(raw.resources).length === 0 ? {} : { resources: sanitizeResources(raw.resources) }),
  }
}

/**
 * tasks.json 读不出来时,一切写入都抛这个(2026-10-21)。
 *
 * 读坏了当空账、下一次建卡把「空账 + 一张」写回去,原文件里的卡就一张不剩 —— 工程师移交审查
 * 在临时目录复现过。所以只读的地方照旧拿空看板(不把 /state 拖挂),**写一律拒绝**,原文件原样留着。
 * 8791 把它翻成 409 + 这句人话(http.ts 兜底那一段),不当「内部错误」上报。
 */
export class TasksFileUnreadableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TasksFileUnreadableError'
  }
}

export type TasksFileRead =
  | { ok: true, data: TasksFile }
  | { ok: false, data: TasksFile, problem: string }

/** 给人看的那一句。/state.tasks.problem 与拒写的 409 是同一句。 */
export function tasksFileProblemLine(why: string, kept?: string): string {
  return `任务看板的文件 tasks.json ${why},看板先空着、改动暂不写入,免得把原来的内容盖掉。`
    + `原文件没动${kept === undefined ? '' : `,另存了一份 ${kept}`};修好或换回备份后自动恢复。`
}

/**
 * 同一份坏内容只另存一次:/state 每拍都读,不能每读一次多一份。
 * 记的是**进行中的那一次另存**(同步登记,在第一个 await 之前):/state 与后台刷新同时读到坏文件时,
 * 后到的等同一个结果,不会各存一份、各报一个文件名。
 */
const keptCopies = new Map<string, { raw: Buffer, name: Promise<string | undefined> }>()

function keepCorruptCopy(file: string, raw: Buffer): Promise<string | undefined> {
  const memo = keptCopies.get(file)
  if (memo !== undefined && memo.raw.equals(raw)) return memo.name
  const name = saveCorruptCopy(file, raw)
  keptCopies.set(file, { raw, name })
  // 另存失败就忘掉这一次,下一拍再试。
  void name.then((saved) => {
    if (saved === undefined && keptCopies.get(file)?.name === name) keptCopies.delete(file)
  })
  return name
}

async function saveCorruptCopy(file: string, raw: Buffer): Promise<string | undefined> {
  const dir = dirname(file)
  const prefix = `${basename(file)}.corrupt-`
  try {
    // 重启之后内存里没有了,再看一眼目录里是不是已经存过同一份。
    for (const name of await readdir(dir)) {
      if (!name.startsWith(prefix)) continue
      const old = await readFile(join(dir, name)).catch(() => undefined)
      if (old !== undefined && old.equals(raw)) return name
    }
    const name = `${prefix}${new Date().toISOString().replace(/[:.]/g, '-')}`
    await writeFile(join(dir, name), raw, { flag: 'wx' })
    return name
  }
  catch {
    // 另存失败(目录不可写)不改变结论:照样拒写,原文件照样没动,只是那句话里少半句。
    return undefined
  }
}

function parseTasksText(text: string): TasksFile | undefined {
  let parsed: Record<string, unknown> | null
  try { parsed = JSON.parse(text) as Record<string, unknown> | null }
  catch { return undefined }
  if (typeof parsed !== 'object' || parsed === null || !Array.isArray(parsed.tasks)) return undefined
  return {
    version: 2,
    tasks: parsed.tasks.map(sanitizeTask).filter((task): task is StoredTask => task !== undefined),
    sprints: (Array.isArray(parsed.sprints) ? parsed.sprints : [])
      .map(sanitizeSprint).filter((sprint): sprint is StoredSprint => sprint !== undefined),
    modules: (Array.isArray(parsed.modules) ? parsed.modules : [])
      .map(sanitizeModule).filter((module): module is StoredModule => module !== undefined),
    project_meta: (Array.isArray(parsed.project_meta) ? parsed.project_meta : [])
      .map(sanitizeMeta).filter((meta): meta is ProjectBoardMeta => meta !== undefined),
    ...collabParts(parsed),
  }
}

/**
 * 读盘,并说清读没读成。v1(只有一个平铺 tasks 数组)原地升级成 v2:卡片原样留着,只是暂时没有
 * 模块归属,在看板上落进各自项目的「未归模块」泳道——**一张不丢**。
 *
 * 不存在、空文件 = 空账(里面没有能丢的东西);读不出来、不是 JSON、不是任务账的样子 = `ok: false`,
 * 坏内容另存一份 `tasks.json.corrupt-<时间>`。单条写坏只挑掉那一条,不算整份坏。
 */
type TasksReadCache = { raw?: Buffer, data?: TasksFile }
export async function readTasksFile(file: string, cache?: TasksReadCache, purpose: 'list' | 'write' | 'other' = cache === undefined ? 'other' : 'list'): Promise<TasksFileRead> {
  let raw: Buffer
  try {
    raw = await readFile(file)
  }
  catch (error) {
    const code = (error as { code?: string }).code
    if (code === 'ENOENT') return { ok: true, data: emptyTasksFile() }
    return { ok: false, data: emptyTasksFile(), problem: tasksFileProblemLine(`读不出来(${code ?? '原因不明'})`) }
  }
  // Read the actual bytes on every request: external edits and revocation-related task changes
  // are visible immediately. Only the expensive JSON validation is reused for identical bytes.
  // 命中直接返回缓存里那一份,不做 structuredClone:全仓消费方审计过,list() 返回的账没有任何
  // 就地改(要改的地方都走 tasks.update/move 写口或先自拷),写口又另读一份落盘 —— 省下的
  // 是每拍最多 4 次整账深拷贝。这条"无人就地改"是不变量,动消费方时先核它。
  if (cache?.raw?.equals(raw) && cache.data !== undefined) return { ok: true, data: cache.data }
  const text = raw.toString('utf8')
  if (text.trim() === '') return { ok: true, data: emptyTasksFile() }
  const started = process.env.WORKBENCH_TASK_IO_DIAGNOSTICS === '1' ? performance.now() : undefined
  const data = parseTasksText(text)
  if (started !== undefined) console.info(`[task-io] ${JSON.stringify({ operation: 'parse', caller: purpose,
    bytes: raw.byteLength, duration_ms: Math.round((performance.now() - started) * 100) / 100,
    task_count: data?.tasks.length ?? 0 })}`)
  if (data !== undefined) {
    if (cache !== undefined) { cache.raw = raw; cache.data = data }
    return { ok: true, data }
  }
  return { ok: false, data: emptyTasksFile(), problem: tasksFileProblemLine('内容坏了、读不出来', await keepCorruptCopy(file, raw)) }
}

/** 只读用:读不成就是空看板(那是此刻能显示的全部)。要写的地方走服务里的 loadForWrite。 */
export async function loadTasksFile(file: string): Promise<TasksFile> {
  return (await readTasksFile(file)).data
}

/** 协作区那几块(目标 / 冲刺 / 名片 / 迁移账)。整块缺席就不写这个键,老文件读回来一字不变。 */
function collabParts(parsed: Record<string, unknown>): Partial<TasksFile> {
  const list = <T>(value: unknown, pick: (one: unknown) => T | undefined): T[] =>
    (Array.isArray(value) ? value : []).map(pick).filter((one): one is T => one !== undefined)
  const migration = sanitizeMigration(parsed.collab_migration)
  const lanIdentity = sanitizeLanIdentity(parsed.lan_identity)
  return {
    ...(Array.isArray(parsed.goals) ? { goals: list(parsed.goals, sanitizeGoal) } : {}),
    ...(Array.isArray(parsed.goal_sprints) ? { goal_sprints: list(parsed.goal_sprints, sanitizeGoalSprint) } : {}),
    ...(Array.isArray(parsed.agent_cards) ? { agent_cards: list(parsed.agent_cards, sanitizeAgentCard) } : {}),
    ...(migration === undefined ? {} : { collab_migration: migration }),
    ...(Array.isArray(parsed.collab_dismissed) ? { collab_dismissed: sanitizeStrings(parsed.collab_dismissed, 500) } : {}),
    ...(Array.isArray(parsed.collab_placed) ? { collab_placed: sanitizeStrings(parsed.collab_placed, 50) } : {}),
    ...(Array.isArray(parsed.collab_session_removed) ? { collab_session_removed: sanitizeStrings(parsed.collab_session_removed, 500) } : {}),
    ...(Array.isArray(parsed.squads) ? { squads: list(parsed.squads, sanitizeSquad) } : {}),
    ...(Array.isArray(parsed.timers) ? { timers: list(parsed.timers, sanitizeTimer) } : {}),
    ...(Array.isArray(parsed.mcp) ? { mcp: list(parsed.mcp, sanitizeMcp) } : {}),
    ...(Array.isArray(parsed.relations) ? { relations: list(parsed.relations, sanitizeTaskRelation) } : {}),
    ...(Array.isArray(parsed.lan_messages) ? { lan_messages: list(parsed.lan_messages, one => sanitizeStoredLanMessage(one, lanIdentity?.member_id)) } : {}),
    ...(Array.isArray(parsed.lan_source_policies) ? { lan_source_policies: list(parsed.lan_source_policies, sanitizeLanSourcePolicy) } : {}),
    ...(lanIdentity === undefined ? {} : { lan_identity: lanIdentity }),
    ...(Array.isArray(parsed.lan_members) ? { lan_members: list(parsed.lan_members, sanitizeLanMember) } : {}),
  }
}

export async function saveTasksFile(file: string, data: TasksFile, cause = 'other'): Promise<void> {
  const started = process.env.WORKBENCH_TASK_IO_DIAGNOSTICS === '1' ? performance.now() : undefined
  // Numeric caller coordinate only; the diagnostic never prints source paths or task contents.
  const site = started === undefined ? undefined : /:(\d+):(\d+)\)?$/.exec((new Error().stack ?? '').split('\n')[2] ?? '')
  await mkdir(dirname(file), { recursive: true })
  // tmp 名带随机后缀:同一 file 上可能有多次写入并发跑,固定 `${file}.tmp` 会互相
  // 覆盖临时文件本身(理由与 projects.ts saveProjectsFile 逐字同源)。
  const tmp = `${file}.${randomUUID()}.tmp`
  const raw = `${JSON.stringify(data, null, 2)}\n`
  await writeFile(tmp, raw)
  await rename(tmp, file)
  if (started !== undefined) console.info(`[task-io] ${JSON.stringify({ operation: 'save', caller: 'write', cause,
    site_line: Number(site?.[1] ?? 0), site_column: Number(site?.[2] ?? 0),
    bytes: Buffer.byteLength(raw), duration_ms: Math.round((performance.now() - started) * 100) / 100, task_count: data.tasks.length })}`)
}

export interface CreateTaskInput {
  executionRole?: ExecutionRoleFact
  title: string
  /**
   * 卡名来源(2026-10-23,卡 A):`'session'` = 这张卡的标题借自来源会话的名(placeSession),
   * 来源会话改名时卡跟着改。人建的卡不传。
   */
  titleFrom?: 'session' | 'custom'
  /** 「落地」口回话(2026-10-24,卡 1a):执行后写在卡上,手机/电脑同源显示。 */
  sayNote?: string
  desc?: string
  status?: TaskStatus
  projectId?: string
  moduleId?: string
  /** 这是哪一种事项。**不传就是普通事项**——既有调用方一个都不用改。 */
  kind?: TaskKind
  /** 选题的内容类型(图文 / 视频)。 */
  contentType?: TopicContentType
  /** 选题的创作进度。不传 = 盘上不写这个字段(界面按「灵感」摆,但不替他写一个他没选过的值)。 */
  stage?: TopicStage
  /** 需求卡的那一态。不传 = 盘上不写(界面按「梳理」摆,同 stage 那条分寸)。 */
  featureStage?: FeatureStage
  priority?: TaskPriority
  assignee?: TaskAssignee
  /** 管理(2026-10-27):建卡那一方是事务官时传 `'dsh'`;人自己建的不传。 */
  manager?: TaskAssignee
  /** 负责人那一格的补充(2026-09-25,卡 N):「9/29 回来写」。 */
  assigneeNote?: string
  due?: string
  /** 选题的计划发布日(`YYYY-MM-DD`)。形状不对**当没传**——不把一个月历读不出来的日期写上卡。 */
  plannedAt?: string
  /** 选题的实际发布日(`YYYY-MM-DD`)。同上。建卡时一般不传:还没发就是还没发。 */
  publishedAt?: string
  links?: readonly TaskLink[]
  deliverables?: readonly TaskDeliverable[]
  source?: TaskSource
  /** 事项方向(2026-09-10)。只有从收件箱建出来的那批带 `mine`;看板上手建的卡不带。 */
  direction?: TaskDirection
  /** 谁写下的(2026-09-25):他亲口交代 / 通话纪要 / 引导排的 / 会议来的。见 protocol.ts TaskOrigin。 */
  origin?: TaskOrigin
  /** 通话纪要那一通(2026-09-25)。只在 `/butler/call/record` 落的卡上有。 */
  call?: TaskCallMeta
  /** 这条事项底下那段 DSH 会话。开不出会话时不传——**不留一个空壳**(界面据此显示「会话未开」)。 */
  conversation?: TaskConversation
  /**
   * 这张卡是演示用的(2026-10-13,`server/demoSeed.ts`)。**只有 `POST /demo/seed` 传它**;
   * HTTP 的 `/task/create` 不接这个字段 —— 她在界面上建的卡永远是真的那一种。
   */
  demo?: boolean
  /* 协作区那几格(2026-10-21)。都可缺;四样的门在 HTTP 层(`server/noteGate.ts`),这里只管存。 */
  goalId?: string
  from?: NoteFrom
  acceptance?: readonly string[]
  labels?: readonly string[]
  children?: readonly string[]
  watchers?: readonly string[]
  props?: Readonly<Record<string, string>>
  module?: string
  version?: string
  start?: string
  end?: string
  workType?: WorkType
  collaborators?: readonly string[]
  squadId?: string
  pullRequests?: readonly string[]
}

/** 传 null 一律表示"清掉这一项";不传表示"不动"。两者必须能区分,所以不用 undefined 兼任。 */
export interface UpdateTaskInput {
  executionRole?: ExecutionRoleFact
  /** 阻塞原因(2026-09-09 拍板第 4 条),与会话等待原因同一套 id。 */
  blockReason?: WaitReason | null
  title?: string
  /**
   * 卡名来源(2026-10-23,卡 A)。**HTTP 的 /task/update 不传这个字段**:
   * 人改标题,服务端正好看见 `title` 变了就把它盖成 `'custom'`,不用人惦记。
   * 传 `'session'` 的只有一件事 —— `syncBorrowedCardTitles` 跟着来源改名那一档:
   * 不这么传,同步一次就会被自己的「人改过」盖死。
   */
  titleFrom?: 'session' | 'custom'
  /** 「落地」口回话(2026-10-24,卡 1a)。传 null 清掉。 */
  sayNote?: string | null
  /**
   * ★ 借名同步的**同事务复核**(2026-10-23 复审 Important 4):同步先 list 再 update 是两拍,
   * 这中间用户可能已手动改过名(custom 已落盘)。写的那一刻必须再核一遍 —— 这张卡现在仍借着
   * `titleSyncFrom` 这条来源的名,才许跟;否则这一下是空操作(手改先到,迟到的同步不得盖回去)。
   * 只有服务端自己传;HTTP 不进。
   */
  titleSyncFrom?: string
  desc?: string | null
  projectId?: string | null
  moduleId?: string | null
  /** 选题的内容类型。null = 清掉。**kind 不在这里**:见 UpdateTaskInput 顶上那段。 */
  contentType?: TopicContentType | null
  /** 选题的创作进度。手改(拖到别的一列)走这里;「推进一步」走 advanceTopic。 */
  stage?: TopicStage | null
  /**
   * 需求卡的那一态。null = 清掉。**需求卡的「推进一步」就走这里**(不另开 advanceFeature):
   * 四态是线性的、卡上那颗按钮已经算好了下一态,再加一条路由等于同一件事两处能改。
   */
  featureStage?: FeatureStage | null
  priority?: TaskPriority | null
  assignee?: TaskAssignee | null
  /** 管理(2026-10-27)。null = 清掉。 */
  manager?: TaskAssignee | null
  /** 负责人那一格的补充(2026-09-25,卡 N)。null = 清掉。 */
  assigneeNote?: string | null
  due?: string | null
  /** 计划发布日。null = 清掉(他把排期撤了);形状不对当没传,不动盘上那一个。 */
  plannedAt?: string | null
  /** 实际发布日。null = 清掉(退回「未发布」那一个状态);形状不对当没传。 */
  publishedAt?: string | null
  /** 整组替换(不是增量):交接时客户端把"原来那几条 + 新的一条"一起给回来。 */
  links?: readonly TaskLink[]
  /**
   * 事项底下那段 DSH 会话(2026-09-10)。**只由建事项那条路径写**(先建卡拿到 id,
   * 再把开出来的会话记回来);null = 清掉。归档章由 move 自己盖,不从这里传。
   */
  conversation?: TaskConversation | null
  /** 同 links:整组替换,空数组 = 清空。 */
  deliverables?: readonly TaskDeliverable[]
  /**
   * 工作台记在卡上的一句话(2026-09-16 事项生命周期闭环)。**只有服务端自己写**(会话结束、会话未开),
   * HTTP 的 /task/update 不接这个字段——它是事实的转述,不是给人编辑的。null = 清掉。
   */
  note?: string | null
  /**
   * 派活记录(2026-09-21)。**只有服务端自己写**(POST /butler/item/dispatch —— 事务官报什么存什么),
   * HTTP 的 /task/update 不接这个字段:它是事实的转述,不是给人编辑的(同 note)。null = 清掉。
   */
  dispatch?: TaskDispatch | null
  /**
   * 「改工作台自己」那条闭环(2026-09-23)。**只有服务端自己写**
   * (`POST /feature/branch` 与 `POST /feature/ship`),HTTP 的 `/task/update` 不接这个字段
   * —— 它是事实的转述,不是给人编辑的(同 `note` / `dispatch`)。null = 清掉。
   */
  selfShip?: TaskSelfShip | null
  /**
   * 「客户端窗口」那只手(`hand:'window'`)最近一次把话送进去的记录(2026-09-21)。
   * 同样**只有服务端自己写**(`POST /dispatch/client` 与会话匹配那一步)。null = 清掉。
   *
   * 为什么不并进上面那个 `dispatch`:那条记录的骨架是 `cwd` + `pid` + running/done/failed,
   * 而送话进窗口**没有工作目录、没有子进程**,状态也只有"送进去了 / 没送成"两档 ——
   * 之后的在跑/等确认/完成由会话流现查(见 protocol 里 TaskClientDispatch 的注释)。
   * 硬塞进同一个结构,就得给 cwd 编一个值。
   */
  clientDispatch?: TaskClientDispatch | null
  /** 交办时的档(2026-09-24)。**只有服务端自己写**(POST /butler/item)。null = 清掉。 */
  mode?: ComposerMode | null
  /** 交办时的附件(同上)。空表 = 清掉。 */
  attachments?: readonly TaskAttachment[]
  /** 通话纪要那一通(2026-09-25)。同一通两边都报、后到的字幕更全时连摘要一起换。只由服务端写。 */
  call?: TaskCallMeta
  /**
   * 「只是问了一句」那一章(2026-09-25,卡 Y)。**只有服务端自己写**(会话结束那一步,`butlerLifecycle.ts`);
   * HTTP 的 `/task/update` 不接这个字段 —— 它是事实的转述,不是给人编辑的(同 `note` / `dispatch`)。
   * null = 擦掉(他把卡从「完成」拖回「进行中」时 `move` 自己会擦)。
   */
  casual?: boolean | null
  /**
   * ★ **她看过这件事的结果了**(2026-10-04,卡 `claude/answer-comes-to-her`;ISO 时刻)。
   * 只由 `POST /task/seen-result` 那一条路写(`/task/update` 不接这个字段 —— 它是事实,不是给人编辑的)。
   * null = 擦掉(她把卡挪出「完成」时 `move` 自己会擦)。
   */
  seenResultAt?: string | null
  /** 派活挑不到手(2026-09-25,卡 O)。只由服务端写;null = 清掉(重新派出去了)。 */
  dispatchBlock?: TaskDispatchBlock | null
  /** 窗口通道里排着 / 正送着 / 读不动(2026-10-21)。只由服务端写;null = 清掉。 */
  dispatchLane?: TaskDispatchLane | null
  /** 花费 / 时长上限(2026-09-25,卡 O)。只由服务端写;null = 清掉。 */
  budget?: TaskBudgetView | null
  /* 协作区那几格(2026-10-21)。数组整组替换、空数组 = 清掉;null = 清掉。 */
  goalId?: string | null
  from?: NoteFrom | null
  acceptance?: readonly string[]
  labels?: readonly string[]
  children?: readonly string[]
  watchers?: readonly string[]
  props?: Readonly<Record<string, string>> | null
  /**
   * 要本人拍板的结构化请求(2026-10-26,卡「事务官页接管队列」)。**只由 `POST /task/owner-ask`
   * 那一条路写**(事务官核验后标四类;人自己在页上标也行),`/task/update` 不接这个字段。
   * null = 清掉。离开「等我确认」时 `move` 自己清。
   */
  ownerAsk?: OwnerAsk | null
  module?: string | null
  version?: string | null
  evaluation?: NoteEvaluation | null
  /** 回执。**只由服务端写**(派活读回 / `POST /task/receipt`),`/task/update` 不接。null = 清掉。 */
  receipt?: NoteReceipt | null
  receipts?: readonly NoteReceipt[]
  /** 回执认不出三种之一。只由服务端写;null / false = 擦掉。 */
  receiptIrregular?: boolean | null
  /** 开始 / 结束时刻(ISO)。null = 清掉。**改时间只走这两格**,拖动不碰它们。 */
  start?: string | null
  end?: string | null
  workType?: WorkType | null
  collaborators?: readonly string[]
  squadId?: string | null
  pullRequests?: readonly string[]
}

export interface SquadInput {
  id?: string
  name?: string
  leader?: string
  members?: readonly string[]
}

export interface TimerInput {
  id?: string
  name?: string
  trigger?: CollabTimerTrigger
  assignee?: string
  template?: CollabTimerTemplate
  enabled?: boolean
}

export interface McpInput {
  id?: string
  name?: string
  url_template?: string
  secret_names?: readonly string[]
}

export interface CreateGoalInput {
  title: string
  why?: string
  due?: string
  projectId?: string
  version?: string
  /** 能力条件(2026-10-24 契约 §1):给了就必须 3–7 条,缺了走 `/collab/goal/condition/save` 补。 */
  conditions?: readonly { text: string, taskId?: string, evidence?: readonly string[] }[]
}

export interface UpdateGoalInput {
  title?: string
  why?: string | null
  status?: CollabGoal['status']
  due?: string | null
  projectId?: string | null
  version?: string | null
}

/** 存一条能力条件(2026-10-24 契约 §1);有 id = 改那一条(保留核验历史),没有 = 新存。 */
export interface GoalConditionInput {
  goalId: string
  id?: string
  text: string
  taskId?: string
  evidence?: readonly string[]
}

/** 核验一条条件;`round` 由服务端记任务当前轮次,调用方不传。 */
export interface VerifyGoalConditionInput {
  by: string
  pass: boolean
  note?: string
}

/** 一条留言 / 邀请(2026-10-24 契约 §2)。deliveries 由服务端按 mention 现建,调用方不传。 */
export interface NoteMessageInput {
  clientMsgId?: string
  by?: string
  text: string
  intent: NoteMessageIntent
  mentions?: readonly string[]
  replyTo?: string
}

/** 存一条任务关系(2026-10-24 契约 §3);round 由服务端记,调用方不传。 */
export interface TaskRelationInput {
  fromId: string
  toId: string
  kind: TaskRelationKind
  note?: string
}

/** 改本机局域网身份(2026-10-24 契约 §5);version 由服务端 +1,调用方只带 expected_version 把关。 */
export interface SaveLanIdentityInput {
  name: string
  /** null = 清掉头像。 */
  avatar?: string | null
  expectedVersion?: number
  /** 兼容旧请求字段;名称范围始终按服务端实际探测结果判断,不采信此声明。 */
  membersRefreshed?: boolean
}

export interface GoalSprintInput {
  id?: string
  title?: string
  start?: string | null
  end?: string | null
  goalIds?: readonly string[]
}

export interface AgentCardInput {
  /** 有 id = 改那一张;没有 = 登记一张新的。 */
  id?: string
  name?: string
  hand?: string
  /** 命令行那一家;null = 清掉(2026-10-22 四样,下同)。 */
  runtime?: AgentCard['runtime'] | null
  /** 仓库本地路径;null = 清掉。 */
  project?: AgentCard['project'] | null
  /** 模型名与强度;null = 清掉。 */
  model?: AgentCard['model'] | null
  /** 智能体文件(相对仓库);null = 清掉。 */
  instructions?: string | null
  /** 每件事的时长上限(分钟);null = 清掉(2026-10-23 卡「派活给名片的四处」③)。 */
  budget?: AgentCard['budget'] | null
  goodAt?: string | null
  skills?: readonly string[]
  mcp?: readonly string[]
  shared?: AgentCard['shared']
}

export interface CommentInput {
  by: string
  text: string
  verdict?: NoteComment['verdict']
  /** 这句带着意图递的(2026-10-26,卡「事务官机制A」):卡上四意图可区分。 */
  intent?: NoteComment['intent']
}

export interface CreateSprintInput {
  projectId: string
  name: string
  goal?: string
  versions?: readonly SprintVersion[]
  startsAt?: string
  endsAt?: string
}

export interface UpdateSprintInput {
  name?: string
  goal?: string | null
  versions?: readonly SprintVersion[]
  startsAt?: string | null
  endsAt?: string | null
}

export interface CreateModuleInput {
  sprintId: string
  name: string
  goal?: string
  versionLabel?: string
}

export interface UpdateModuleInput {
  name?: string
  goal?: string | null
  versionLabel?: string | null
}

export interface SetProjectMetaInput {
  priority?: TaskPriority | null
  assignee?: AgentId | null
  /** 整组替换,空数组 = 清掉(2026-10-21 协作区)。 */
  repos?: readonly ProjectRepo[]
  resources?: readonly ProjectResource[]
}

export interface TasksService {
  /** 当前整份看板(GET /state 的 tasks 那一块)。 */
  list: () => Promise<TasksState>
  /** 新建一个功能点。标题空白直接拒绝,不建空卡。 */
  create: (input: CreateTaskInput) => Promise<{ ok: boolean, id?: string, reason?: string }>
  /**
   * 改状态——拖拽、弹窗里那排状态格、HTTP 的 /task/move 走的是同一个口。
   *
   * 按 protocol.ts 的转换表把关:**非法转换拒绝并回一句原因**(D13),卡上什么都不动
   * (连 updated_at 都不动——什么都没发生就不算改过)。
   * 卡不存在时 `{ ok: false }` 且没有 reason,HTTP 层据此回 404 而不是 409。
   */
  move: (id: string, status: TaskStatus) => Promise<{ ok: boolean, reason?: string }>
  /** 改标题/描述/归属/优先级/执行人/预期结束时间。 */
  update: (id: string, input: UpdateTaskInput) => Promise<boolean>
  /** Atomic source receipt insertion; replay restores a cleared current cursor without a new return. */
  recordReceipt: (id: string, receipt: NoteReceipt, current?: boolean) => Promise<{ ok: boolean, fresh: boolean }>
  /**
   * 写成功的订阅(8791 第六轮,2026-10-29):`create` / `move` / `update` / `recordReceipt` 落盘成功后
   * 通知一次,执行对账(http.ts 的执行事实 reconciler)据此事件驱动,不再靠每拍 `GET /state` 触发。
   * 订阅本身一行不看板都不动;**可选** —— 用例里的假账可以没有(对账退化成只到期驱动)。
   */
  onMutated?: (fn: () => void) => () => void
  /** 删掉一个功能点。**只有 Ben 手点会走到这里**,服务端自己永远不调它。 */
  remove: (id: string) => Promise<boolean>
  /**
   * 「推进一步」(2026-09-21 选题池;运营同事原话「每完成一步可推进一下直到最终发布」)。
   *
   * 六段里往后走**一格**,只往后不往前(想退回去就在卡上手改 stage,走 update)。
   * 三种回答分得清清楚楚,与 move 同一套口径:
   * - 卡不存在 → `{ ok: false }`,**没有 reason**,HTTP 层据此回 404;
   * - 不是选题 / 已经在「复盘」→ `{ ok: false, reason }`,HTTP 层 409 + 原话(D13);
   *   **拒绝时连盘都不落**,连 updated_at 都不动 —— "什么都没发生"必须是真的什么都没发生。
   *
   * ★ 2026-10-02(运营同学 Air 那一版):**推进一步不再往 `published_at` 上写任何日期**。
   * 原来进 / 离「发布」那一段时会把当天记成实际发布日 —— 那是**我们替她断言"这条已经发到
   * 平台上了"**,而推进按钮只知道她在界面上点了一下。她的原话口径:实际发布日要她自己确认。
   * 于是改成一道闸:从「发布」往「复盘」走时,`published_at` 还空着就**拒绝**,
   * 回 `TOPIC_PUBLISH_DAY_FIRST` 那一句,请她先在卡上填实际发布日(走 update)。
   * `planned_at` 照旧一个字不碰。这个方法现在**一个副作用都没有**,只改 stage。
   */
  advanceTopic: (id: string) => Promise<{ ok: boolean, stage?: TopicStage, reason?: string }>
  createSprint: (input: CreateSprintInput) => Promise<{ ok: boolean, id?: string, reason?: string }>
  updateSprint: (id: string, input: UpdateSprintInput) => Promise<boolean>
  /** 删冲刺。**底下的模块与卡一张不动**,只是失去归属退回「未归模块」。 */
  removeSprint: (id: string) => Promise<boolean>
  createModule: (input: CreateModuleInput) => Promise<{ ok: boolean, id?: string, reason?: string }>
  updateModule: (id: string, input: UpdateModuleInput) => Promise<boolean>
  /** 删模块。同上,卡退回「未归模块」,不跟着消失。 */
  removeModule: (id: string) => Promise<boolean>
  /** 项目的优先级与执行人(预期结束时间用项目自己的 DDL,不在这儿存第二份)。 */
  setProjectMeta: (projectId: string, input: SetProjectMetaInput) => Promise<boolean>
  /* —— 协作区(2026-10-21)。全是他(或替他办事的事务官 / 命令行)亲手做的动作,没有一个会自己跑。 —— */
  createGoal: (input: CreateGoalInput) => Promise<{ ok: boolean, id?: string, reason?: string }>
  /** 改目标。**没有删目标**:不要了就把状态改成 `dropped`(不可改清单第 5 条)。 */
  updateGoal: (id: string, input: UpdateGoalInput) => Promise<boolean>
  saveGoalSprint: (input: GoalSprintInput) => Promise<{ ok: boolean, id?: string, reason?: string }>
  saveAgentCard: (input: AgentCardInput) => Promise<{ ok: boolean, id?: string, reason?: string }>
  comment: (taskId: string, input: CommentInput) => Promise<{ ok: boolean, id?: string, reason?: string }>
  /** 标已解决(`by` 是谁标的);`by: null` = 取消已解决。 */
  resolveComment: (taskId: string, commentId: string, by: string | null) => Promise<boolean>
  /** 老冲刺 → 目标(一次性;迁之前把整份账备份到 `<文件>.pre-collab.json`)。已经迁过回 `ok:true, already:true`。 */
  migrateToGoals: () => Promise<{ ok: boolean, already?: boolean, goals: number, tasks: number, backup?: string }>
  /** 回退那一次迁移(照迁移账撤,迁完之后他自己改挂的不动)。 */
  rollbackGoals: () => Promise<{ ok: boolean, goals: number, tasks: number }>
  /** 「这条会话不挂」:记下,不再提(`<家>:<id>`;最多记 500 条,满了丢最老的)。 */
  dismissProposal: (key: string) => Promise<boolean>
  /** 他说过不挂的那几条(组装「挂到哪个目标?」时用)。 */
  dismissedProposals: () => Promise<string[]>
  /** 直接放进去的那条会话要不要在「等你」里留那行说明(on = 留;最多记 50 条)。 */
  setPlacedNotice: (key: string, on: boolean) => Promise<boolean>
  placedNotices: () => Promise<string[]>
  /** 会话回流建的便签被删过的那几条 `<家>:<会话 id>`(2026-10-23;`placeSession` 据此不再登)。 */
  removedSessionCards: () => Promise<string[]>
  /* 小队 / 定时派活 / MCP 库条目(2026-10-21 协作区全量)。这几样不是待办:删掉它们不动任何便签。 */
  saveSquad: (input: SquadInput) => Promise<{ ok: boolean, id?: string, reason?: string }>
  removeSquad: (id: string) => Promise<boolean>
  saveTimer: (input: TimerInput) => Promise<{ ok: boolean, id?: string, reason?: string }>
  removeTimer: (id: string) => Promise<boolean>
  /** 记一次运行(新的在后,最多 20 条)。 */
  recordTimerRun: (id: string, run: CollabTimerRun) => Promise<boolean>
  saveMcp: (input: McpInput) => Promise<{ ok: boolean, id?: string, reason?: string }>
  removeMcp: (id: string) => Promise<boolean>
  /* —— 协作区事实层(2026-10-24 契约 B/C/D2):条件与动态验收、留言 / 邀请、任务关系。全是手动动作。 —— */
  /** 存一条能力条件。目标不存在 `{ok:false}` 无 reason(404);text 空白 / 超 7 条回 reason(409)。 */
  saveGoalCondition: (input: GoalConditionInput) => Promise<{ ok: boolean, id?: string, reason?: string }>
  /** 只删条件,不动任务。目标或条件不存在返回 false(404)。 */
  removeGoalCondition: (goalId: string, conditionId: string) => Promise<boolean>
  /** 人工核验。条件不存在 `{ok:false}` 无 reason(404);任务不在 confirm/done 回 reason(409,没有成果可验)。 */
  verifyGoalCondition: (goalId: string, conditionId: string, input: VerifyGoalConditionInput) => Promise<{ ok: boolean, reason?: string }>
  /** 记交付时刻。条件不存在 404;只有本轮 verified 才许交付,否则 reason(409)。 */
  deliverGoalCondition: (goalId: string, conditionId: string) => Promise<{ ok: boolean, reason?: string }>
  /**
   * 一条留言 / 邀请。`client_msg_id` 幂等:同一张卡内重复 → 原样返回已有消息(`duplicated`),
   * 不新建、不重复派活。task 不存在 `{ok:false}` 无 reason(404);ask 无 mentions / text 空白回 reason(409)。
   */
  prepareInvitation: (taskId: string, messageId: string, to: string) => Promise<{ taskId?: string, fresh: boolean }>
  finishInvitation: (taskId: string, messageId: string, to: string, result: { ok: boolean, note: string }) => Promise<void>
  message: (taskId: string, input: NoteMessageInput) => Promise<{ ok: boolean, message?: NoteMessage, duplicated?: boolean, reason?: string }>
  /**
   * 存一条任务关系。卡不存在 `{ok:false}` 无 reason(404);自连 / 完全重复 / depends_on 成环 /
   * handoff 与 rejected_back 缺 note,回 reason(409)。rejected_back 记目标卡当前轮次。
   */
  saveRelation: (input: TaskRelationInput) => Promise<{ ok: boolean, id?: string, reason?: string }>
  removeRelation: (id: string) => Promise<boolean>
  /** 全部任务关系(读取侧现算 stale 用)。 */
  listRelations: () => Promise<TaskRelation[]>
  /* —— 局域网身份与成员(2026-10-24 契约 §5)。注册表是手动登记 + 按需 refresh,不是后台扫描。 —— */
  /** 本机身份;第一次读时自动生成(member_id=randomUUID、名=事务官、version=1)并落盘。 */
  lanChannel: (projectId: string) => Promise<LanChannelMessage[]>
  lanSourcePolicies: () => Promise<LanChannelSourcePolicy[]>
  saveLanSourcePolicy: (input: Omit<LanChannelSourcePolicy, 'version' | 'updated_at'> & { expected_version: number }) => Promise<{ ok: boolean, policy?: LanChannelSourcePolicy, reason?: string }>
  saveLanMessage: (message: LanChannelMessage, received?: boolean) => Promise<{ ok: boolean, duplicated?: boolean, receipt?: LanTransportReceipt }>
  lanIdentity: () => Promise<LanIdentity>
  /**
   * 改展示名 / 头像。归一后与已知成员重名 → `{ok:false, reason, conflict_with}`;
   * expected_version 不符 → `{ok:false, reason, identity}`(回包带服务端当前副本);
   * 成员列表不完整(有成员从没 refresh 过)且本次也没 refresh 数据 → `{ok:false, reason, availability:'unknown'}`。
   */
  saveLanIdentity: (input: SaveLanIdentityInput) => Promise<{ ok: true, identity: LanIdentity } | { ok: false, reason?: string, conflict_with?: string, identity?: LanIdentity, availability?: 'unknown' }>
  /** 成员注册表(没 refresh 过的成员 reachable 缺席,不说在线)。 */
  lanMembers: () => Promise<LanMember[]>
  /** 整组换掉注册表(refresh 结果写回用)。 */
  saveLanMembers: (members: readonly LanMember[]) => Promise<boolean>
  /** 配对 / 见面时登记或更新:按 member_id 归并,改名不丢(保留 reachable / last_seen)。 */
  rememberLanMember: (input: { memberId: string, name: string, host: string, port: number }) => Promise<boolean>
  /* —— 执行身份与恢复记录(2026-10-29 可靠执行闭环第一批第 1 步)。记录挂在卡上一格,串行比较版本写入。 —— */
  /** 读这张卡的执行记录;老卡没有时从可验证的旧字段(dispatch / client_dispatch / receipt)导入,导不出返回 undefined。 */
  readExecution: (id: string) => Promise<ExecutionRecord | undefined>
  /**
   * 比较版本写入(唯一推进职责的落盘口):当前版本 === expectedVersion 才写,版本 +1;
   * 卡上还没有记录时只认 expectedVersion = 0(建记录)。失败返回 false,调用方重读再决。
   */
  writeExecution: (id: string, next: ExecutionRecord, expectedVersion: number) => Promise<boolean>
  /** 全部未完成的执行记录(非终态;读到残缺的投影成 reconciling + reconcile,先对账不盲重派)。 */
  unfinishedExecutions: () => Promise<ExecutionRecord[]>
}

/**
 * 这个服务允许存在的全部能力。**精确清单,不是示例**——多一个就说明有人加了
 * 一条能自动改动看板的路径,那正是不可改清单第 5 条延伸约束要挡住的东西。
 */
export const TASKS_SERVICE_METHODS = [
  'list', 'create', 'move', 'update', 'remove', 'advanceTopic',
  'createSprint', 'updateSprint', 'removeSprint',
  'createModule', 'updateModule', 'removeModule',
  'setProjectMeta',
  // 2026-10-21 协作区:目标、冲刺、名片、留言、迁移与回退。都是手动动作(迁移只在起服务时跑一次,且是格式升级)。
  'createGoal', 'updateGoal', 'saveGoalSprint', 'saveAgentCard', 'comment', 'resolveComment', 'recordReceipt',
  'migrateToGoals', 'rollbackGoals', 'dismissProposal', 'dismissedProposals',
  // 10-22 第三轮 4(维护者定):只有一个目标时直接放进去,这两样只管「等你」里那行说明,本身不动便签。
  'setPlacedNotice', 'placedNotices',
  // 2026-10-23 卡「待排的卡不许被派出去」④:只读「删过」那张小表(写发生在 remove 里)。
  'removedSessionCards',
  // 2026-10-21 协作区全量:小队、定时派活、MCP 库条目(都不是待办;删它们不删便签)。
  'saveSquad', 'removeSquad', 'saveTimer', 'removeTimer', 'recordTimerRun', 'saveMcp', 'removeMcp',
  // 2026-10-24 协作区事实层(契约 B/C/D2):条件与动态验收、留言 / 邀请、任务关系。全是手动动作,没有一个会自己跑。
  'saveGoalCondition', 'removeGoalCondition', 'verifyGoalCondition', 'deliverGoalCondition',
  'message', 'saveRelation', 'removeRelation', 'listRelations',
  // 2026-10-24 契约 §5:局域网身份与成员注册表。登记与改名都是手动动作;refresh 是 UI 显式触发,不是后台扫描。
  'prepareInvitation', 'finishInvitation',
  'lanChannel', 'saveLanMessage', 'lanIdentity', 'saveLanIdentity', 'lanMembers', 'saveLanMembers', 'rememberLanMember',
  // 2026-10-29 可靠执行闭环第一批第 1 步:执行身份与恢复记录。串行比较版本写入,不自动改别的格。
  'readExecution', 'writeExecution', 'unfinishedExecutions',
  'lanSourcePolicies', 'saveLanSourcePolicy',
  // 2026-10-29(8791 第六轮):写成功订阅 —— 只发通知、一行不看板都不动,驱动执行对账用(见 TasksService.onMutated)。
  'onMutated',
] as const

export interface TasksServiceOptions {
  file: string
  /** 当前 Unix 秒。测试传可控时钟,生产用真实时间(先例见 scenes.ts)。 */
  now?: () => number
  /** 新 id 生成器。测试注入固定值,生产用 randomUUID。 */
  newId?: () => string
}

/** 协作区那几格的改法(null / 空 = 清掉,undefined = 不动,有值过同一道体检)。 */
function applyNoteUpdate(next: StoredTask, input: UpdateTaskInput): void {
  const text = (value: string | null | undefined, key: 'goal_id' | 'module' | 'version'): void => {
    if (value === undefined) return
    const cleaned = value === null ? undefined : value.trim()
    if (cleaned === undefined || cleaned === '') delete next[key]
    else next[key] = cleaned
  }
  text(input.goalId, 'goal_id')
  text(input.module, 'module')
  text(input.version, 'version')
  if (input.from === null) delete next.from
  else if (input.from !== undefined) {
    const cleaned = sanitizeFrom(input.from)
    if (cleaned !== undefined) next.from = cleaned
  }
  const list = (value: readonly string[] | undefined, key: 'labels' | 'children' | 'watchers' | 'acceptance'): void => {
    if (value === undefined) return
    const cleaned = key === 'acceptance' ? sanitizeAcceptance(value) : sanitizeStrings(value)
    if (cleaned.length === 0) delete next[key]
    else next[key] = cleaned
  }
  list(input.acceptance, 'acceptance')
  list(input.labels, 'labels')
  list(input.children, 'children')
  list(input.watchers, 'watchers')
  if (input.props === null) delete next.props
  else if (input.props !== undefined) {
    const cleaned = sanitizeProps(input.props)
    if (cleaned === undefined) delete next.props
    else next.props = cleaned
  }
  if (input.evaluation === null) delete next.evaluation
  else if (input.evaluation !== undefined) {
    const cleaned = sanitizeEvaluation(input.evaluation)
    if (cleaned !== undefined) next.evaluation = cleaned
  }
  if (input.receipt === null) delete next.receipt
  else if (input.receipt !== undefined) {
    const cleaned = sanitizeReceipt(input.receipt)
    if (cleaned !== undefined) next.receipt = cleaned
  }
  if (input.receipts !== undefined) {
    const cleaned = input.receipts.map(sanitizeReceipt).filter((one): one is NoteReceipt => one !== undefined)
    if (cleaned.length === 0) delete next.receipts
    else next.receipts = cleaned
  }
  if (input.receiptIrregular === true) next.receipt_irregular = true
  else if (input.receiptIrregular === false || input.receiptIrregular === null) delete next.receipt_irregular
  // 时间:两格一起过同一道门(结束早于开始就丢结束,同读盘那一处)。
  if (input.start !== undefined || input.end !== undefined) {
    const start = input.start === undefined ? next.start : input.start === null ? undefined : isoTime(input.start)
    const end = input.end === undefined ? next.end : input.end === null ? undefined : isoTime(input.end)
    if (input.start !== undefined && input.start !== null && start === undefined) { /* 写坏的开始当没传 */ }
    else {
      delete next.start
      delete next.end
      const cleaned = sanitizeNoteFields({ start, end })
      if (typeof cleaned.start === 'string') next.start = cleaned.start
      if (typeof cleaned.end === 'string') next.end = cleaned.end
    }
  }
  if (input.workType === null) delete next.work_type
  else if (input.workType !== undefined) {
    const cleaned = sanitizeNoteFields({ work_type: input.workType })
    if (cleaned.work_type !== undefined) next.work_type = cleaned.work_type as WorkType
  }
  if (input.collaborators !== undefined) {
    const cleaned = sanitizeStrings(input.collaborators)
    if (cleaned.length === 0) delete next.collaborators
    else next.collaborators = cleaned
  }
  if (input.squadId === null || input.squadId === '') delete next.squad_id
  else if (input.squadId !== undefined) next.squad_id = input.squadId.trim()
  if (input.pullRequests !== undefined) {
    const cleaned = sanitizeNoteFields({ pull_requests: input.pullRequests }).pull_requests as string[] | undefined
    if (cleaned === undefined) delete next.pull_requests
    else next.pull_requests = cleaned
  }
}

/** Agent 名片的 id:`agent:<本机前缀>:<随机>`。前缀阶段一固定 `local`(阶段二换成主人设备前缀)。 */
function newAgentCardId(): AgentCard['id'] {
  return `agent:local:${randomBytes(5).toString('hex')}`
}

export function createTasksService(opts: TasksServiceOptions): TasksService {
  const readCache: TasksReadCache = {}
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000))
  const newId = opts.newId ?? (() => `t-${randomUUID().slice(0, 8)}`)
  const stamp = (): string => new Date(now() * 1000).toISOString()
  const newLanIdentity = (): LanIdentity => sanitizeLanIdentity({ member_id: randomUUID(), name: '事务官', version: 1, updated_at: stamp() }) as LanIdentity

  function invalidateConditions(data: TasksFile, affected: ReadonlySet<string>, at: string, reopenedTask?: string): void {
    for (const goal of data.goals ?? []) for (const condition of goal.conditions ?? []) {
      if (condition.task_id === undefined || !affected.has(condition.task_id)) continue
      delete condition.delivered_at
      condition.updated_at = at
      goal.updated_at = at
      // 本卡已有 round 可判旧证据;下游没重开执行,追加作废留痕,防止删除旧关系后旧通过复活。
      if (condition.task_id !== reopenedTask && condition.verifications.length > 0) {
        condition.verifications = [...condition.verifications, { by: 'system', at, pass: false,
          round: data.tasks.find(t => t.id === condition.task_id)?.round ?? 1, note: '上游成果已重开,需要重新核验' }]
      }
    }
  }

  function invalidateRound(data: TasksFile, task: StoredTask, at: string): void {
    if (task.receipt !== undefined) {
      const old = { ...task.receipt, task_round: task.round ?? 1 }
      if (!(task.receipts ?? []).some(one => one.source_session_id === old.source_session_id
        && one.source_round === old.source_round && (one.task_round ?? 1) === old.task_round)) task.receipts = [...(task.receipts ?? []), old]
      delete task.receipt
      delete task.receipt_irregular
    }
    task.round = (task.round ?? 1) + 1
    invalidateConditions(data, downstreamTasks([task.id], data.relations ?? []), at, task.id)
  }

  // 写队列,先例见 projectsService/scenes:load→改→save 不排队会丢更新。
  let writeQueue: Promise<void> = Promise.resolve()
  function enqueueWrite<T>(task: () => Promise<T>): Promise<T> {
    const result = writeQueue.then(task)
    writeQueue = result.then(() => undefined, () => undefined)
    return result
  }

  /**
   * 写成功订阅(8791 第六轮):create / move / update(mutate)/ recordReceipt 落盘成功后各通知一次。
   * 监听方(执行对账)抛了不连累记账;服务自己没有任何定时器 ——「放着不动的卡多久都不会自己变」那条照旧。
   */
  const mutationListeners = new Set<() => void>()
  function notifyMutated(): void {
    for (const fn of [...mutationListeners]) {
      try { fn() } catch { /* 订阅方自己负责 */ }
    }
  }

  /** 找到那一条就改、改完落盘;找不到返回 false 让 HTTP 层回 404。 */
  function mutate<T extends { id: string, updated_at: string }>(
    pick: (data: TasksFile) => T[],
    id: string,
    change: (item: T) => T,
  ): Promise<boolean> {
    return enqueueWrite(async () => {
      const data = await loadForWrite()
      const list = pick(data)
      const index = list.findIndex(item => item.id === id)
      if (index === -1) return false
      list[index] = { ...change(list[index] as T), updated_at: stamp() }
      await saveTasksFile(opts.file, data, 'mutation')
      notifyMutated()
      return true
    })
  }

  /** 可选字段的三态落笔:null=清掉,undefined=不动,有值=写上。 */
  function put<T extends object, K extends keyof T>(target: T, key: K, value: T[K] | null | undefined): void {
    if (value === null) delete target[key]
    else if (value !== undefined) target[key] = value
  }

  /** 每一次写都从这里读:读不成就拒绝,绝不拿空账去盖原文件。 */
  async function loadForWrite(): Promise<TasksFile> {
    const read = await readTasksFile(opts.file, undefined, 'write')
    if (!read.ok) throw new TasksFileUnreadableError(read.problem)
    return read.data
  }

  /** 这张卡的执行记录:卡上有就体检后读,没有就从可验证的旧字段导入(导入不写盘,读时投影)。 */
  function executionOf(task: StoredTask): ExecutionRecord | undefined {
    const stored = sanitizeExecutionRecord(task.execution)
    if (stored !== undefined) return stored
    return importExecutionRecord(task)
  }

  return {
    onMutated(fn) {
      mutationListeners.add(fn)
      return () => { mutationListeners.delete(fn) }
    },

    async list(): Promise<TasksState> {
      const read = await readTasksFile(opts.file, readCache)
      const data = read.data
      return {
        tasks: data.tasks,
        sprints: data.sprints,
        modules: data.modules,
        project_meta: data.project_meta,
        ...(read.ok ? {} : { problem: read.problem }),
        goals: data.goals ?? [],
        goal_sprints: data.goal_sprints ?? [],
        agent_cards: data.agent_cards ?? [],
        squads: data.squads ?? [],
        timers: data.timers ?? [],
        mcp: data.mcp ?? [],
      }
    },

    create(input: CreateTaskInput): Promise<{ ok: boolean, id?: string, reason?: string }> {
      return enqueueWrite(async () => {
        const title = input.title.trim()
        // 空标题的卡在看板上是一格看不出是什么的白条,而且删不删又是个问题——不建。
        if (title === '') return { ok: false, reason: '功能点标题不能为空' }

        const data = await loadForWrite()
        const at = stamp()
        const id = newId()
        data.tasks.push({
          id,
          title,
          ...(input.titleFrom === 'session' || input.titleFrom === 'custom' ? { title_from: input.titleFrom } : {}),
          ...(input.sayNote === undefined || input.sayNote === '' ? {} : { say_note: input.sayNote }),
          ...(input.desc === undefined || input.desc === '' ? {} : { desc: input.desc }),
          status: input.status ?? 'todo',
          ...(input.projectId === undefined || input.projectId === '' ? {} : { project_id: input.projectId }),
          ...(input.moduleId === undefined || input.moduleId === '' ? {} : { module_id: input.moduleId }),
          ...(input.kind === undefined ? {} : { kind: input.kind }),
          ...(input.contentType === undefined ? {} : { content_type: input.contentType }),
          ...(input.stage === undefined ? {} : { stage: input.stage }),
          ...(input.featureStage === undefined ? {} : { feature_stage: input.featureStage }),
          ...(input.priority === undefined ? {} : { priority: input.priority }),
          ...(input.assignee === undefined ? {} : { assignee: input.assignee }),
          ...(isTaskAssignee(input.manager) ? { manager: input.manager } : {}),
          ...(sanitizeAssigneeNote(input.assigneeNote) === undefined ? {} : { assignee_note: sanitizeAssigneeNote(input.assigneeNote) as string }),
          ...(input.due === undefined || input.due === '' ? {} : { due: input.due }),
          ...(isPublishDay(input.plannedAt) ? { planned_at: input.plannedAt } : {}),
          ...(isPublishDay(input.publishedAt) ? { published_at: input.publishedAt } : {}),
          ...(input.links === undefined || input.links.length === 0 ? {} : { links: [...input.links] }),
          ...(input.deliverables === undefined || input.deliverables.length === 0
            ? {}
            : { deliverables: sanitizeDeliverables(input.deliverables) }),
          ...(input.direction === undefined ? {} : { direction: input.direction }),
          ...(isTaskOrigin(input.origin) ? { origin: input.origin } : {}),
          ...(sanitizeCallMeta(input.call) === undefined ? {} : { call: sanitizeCallMeta(input.call) as TaskCallMeta }),
          ...(input.conversation === undefined ? {} : { conversation: input.conversation }),
          // 演示用的记号(2026-10-13)。只认 true,别的值当没传(同 sanitizeTask 那一处)。
          ...(input.demo === true ? { demo: true } : {}),
          ...(sanitizeNoteFields({
            goal_id: input.goalId, from: input.from, acceptance: input.acceptance, labels: input.labels,
            children: input.children, watchers: input.watchers, props: input.props, module: input.module, version: input.version,
            start: input.start, end: input.end, work_type: input.workType, collaborators: input.collaborators,
            squad_id: input.squadId, pull_requests: input.pullRequests,
          }) as Partial<StoredTask>),
          source: input.source ?? { kind: 'manual' },
          execution_role: sanitizeExecutionRole(input.executionRole) ?? executionRoleOf({ source: input.source ?? { kind: 'manual' },
            ...(input.from === undefined ? {} : { from: input.from }), ...(input.direction === undefined ? {} : { direction: input.direction }) }),
          created_at: at,
          updated_at: at,
        })
        await saveTasksFile(opts.file, data, 'create')
        notifyMutated()
        return { ok: true, id }
      })
    },

    move(id: string, status: TaskStatus): Promise<{ ok: boolean, reason?: string }> {
      return enqueueWrite(async () => {
        const data = await loadForWrite()
        const task = data.tasks.find(candidate => candidate.id === id)
        if (task === undefined) return { ok: false }

        const checked = canTransition(task.status, status)
        // 非法就原样退回去,连盘都不落——"拒绝"必须是真的什么都没发生,
        // 否则界面下一拍拉回来的快照会和刚才那句拒绝自相矛盾。
        if (!checked.ok) return { ok: false, reason: checked.reason }
        // 原地不动是合法的空操作(拖回原处):不改 updated_at,免得看板上凭空冒出一条"刚动过"。
        if (task.status === status) return { ok: true }

        const from = task.status
        task.status = status
        // ★ **挪回「待排」即撤队**(2026-10-23,卡「待排的卡不许被派出去」):卡上还排着
        // 的派活(`dispatch_lane.state === 'queued'`)此刻清掉 —— 她把它挪走就是说这件先不办;
        // 卡上那句「排在 X 后面」已经不成立了,换成「排队时你把它挪走了,没派」。
        // 正在送 / 堵着的那一格是别的事实(那一次的进展),不动;正在等回话的窗口派活记在
        // `client_dispatch`,本来也不在队里。
        if (status === 'backlog' && task.dispatch_lane?.state === 'queued') {
          delete task.dispatch_lane
          task.note = DISPATCH_QUEUE_LEFT_NOTE
        }
        // **离开「阻塞」列就把原因清掉**:它说的是"为什么卡住",卡不再卡住时它就是陈旧信息,
        // 留着会在下一次卡住时冒充新原因(同 sessions.ts 不沿用 wait_reason 的理由)。
        if (status !== 'blocked') delete task.block_reason
        task.updated_at = stamp()
        // 状态经手记录(2026-10-24 契约 §2 活动流):只追加,cap 50。move 是唯一的写口。
        task.transitions = [...(task.transitions ?? []), { from, to: status, at: task.updated_at }].slice(-NOTE_TRANSITIONS_MAX)
        /*
         * 已提交成果离开 confirm/done、回到未完成状态时开启新轮,包括先阻塞或取消再恢复。
         * 核验与交接都按轮次对账:轮次不符的旧核验/旧交付自动失效(条件状态读侧现算回 rework,
         * 见 protocol.ts 的 conditionStateOf)。交付时刻作废(delivered_at 清掉),verifications 历史留痕不删。
         */
        const submitted = from === 'confirm' || from === 'done'
        // 旧版本可能已把「同轮通过」留在未完成卡上;恢复提交前也须作废,不能靠再次 confirm 复活。
        const legacyVerification = !submitted && (data.goals ?? []).some(goal => (goal.conditions ?? []).some(condition => {
          const last = condition.verifications.at(-1)
          return condition.task_id === id && last?.pass === true && last.round === (task.round ?? 1)
        }))
        if (submitted && status !== 'done' && status !== 'confirm' || legacyVerification) invalidateRound(data, task, task.updated_at)
        // 完成时刻(2026-09-09 排期风险):进 done 盖章,离开 done(重开)清掉。
        // 不拿 updated_at 顶——完成之后改个标题它就变了,速度会跟着虚高。
        if (status === 'done') task.done_at = task.updated_at
        else delete task.done_at
        // 「只是问了一句」那一章(2026-09-25,卡 Y):**他把卡挪出「完成」就擦掉**——
        // 他亲手把它拖回「进行中」,等于说"这是一件事",那它就是一件事(人改过的以人为准,同 block_reason / done_at)。
        if (status !== 'done') delete task.casual
        // 同一条规矩给「她看过结果了」(卡 `claude/answer-comes-to-her`):她把卡拖回「进行中」=
        // 这件事又活了,上一轮那个结果看过没看过都不再算数;下次办完照旧在首页摆一次。
        if (status !== 'done') delete task.seen_result_at
        /**
         * 要本人拍板的那一问跟着「等我确认」走(2026-10-26,卡「事务官页接管队列」):离开这一格
         * (通过 / 退回 / 阻塞 / 取消)就是被拍板或退回答掉了,请求本身擦掉;怎么答的留在
         * transitions / 轮次 / 留言里,不删历史。
         */
        if (from === 'confirm' && status !== 'confirm') delete task.owner_ask
        // 事项完结(完成/取消)**不删会话,只标归档**(2026-09-10 事项收件箱):DSH 那边的
        // 对话原样留着,点开还能看;收件箱据此把它从"在办"挪到"办完"。重开就把章擦掉——
        // 归档说的是"这条事项结束了",事项又活过来时它就是陈旧信息(同 block_reason / done_at)。
        if (task.conversation !== undefined) {
          const archived = status === 'done' || status === 'canceled'
          task.conversation = archived
            ? { ...task.conversation, archived_at: task.updated_at }
            : (() => { const next = { ...task.conversation as TaskConversation }; delete next.archived_at; return next })()
        }
        await saveTasksFile(opts.file, data, 'move')
        notifyMutated()
        return { ok: true }
      })
    },

    recordReceipt(id, receipt, current = true) {
      return enqueueWrite(async () => {
        const data = await loadForWrite()
        const task = data.tasks.find(one => one.id === id)
        if (task === undefined) return { ok: false, fresh: false }
        const clean = sanitizeReceipt(receipt)
        if (clean === undefined) return { ok: false, fresh: false }
        const prior = clean.source_session_id === undefined ? undefined : (task.receipts ?? []).find(one =>
          one.source_session_id === clean.source_session_id && one.source_round === clean.source_round)
        const kept = prior ?? clean
        if (prior !== undefined && (!current || task.receipt !== undefined || (kept.task_round ?? 1) !== (task.round ?? 1))) return { ok: true, fresh: false }
        if (prior === undefined && clean.source_session_id !== undefined) task.receipts = [...(task.receipts ?? []), clean]
        if (current && (kept.task_round ?? 1) === (task.round ?? 1) && (prior === undefined || task.receipt === undefined)) { task.receipt = kept; delete task.receipt_irregular }
        await saveTasksFile(opts.file, data, 'receipt')
        notifyMutated()
        return { ok: true, fresh: prior === undefined }
      })
    },

    update(id: string, input: UpdateTaskInput): Promise<boolean> {
      const title = input.title?.trim()
      // 空标题同 create:宁可拒绝也不留一张看不出是什么的卡。
      if (input.title !== undefined && title === '') return Promise.resolve(false)
      return mutate(data => data.tasks, id, (task) => {
        const next: StoredTask = { ...task }
        const role = sanitizeExecutionRole(input.executionRole)
        if (role !== undefined) next.execution_role = role
        if (title !== undefined) {
          if (input.titleFrom === 'session') {
            // ★ 借名同步的同事务复核(复审 Important 4):list 与 update 之间用户可能已改过头。
            // 只有这张卡**此刻仍借着** input.titleSyncFrom 这条来源的名,才许跟;手改先到 = 空操作。
            const stillBorrowed = task.title_from === 'session'
              && task.source?.kind === 'session'
              && task.source.ref !== undefined
              && task.source.ref === input.titleSyncFrom
            if (!stillBorrowed) return task
          }
          next.title = title
          // ★ 卡名来源(2026-10-23,卡 A):人改标题(或调用方没明说是来源同步)= 自定,从此来源改名不再覆盖;
          // 只有 syncBorrowedCardTitles 那一档带着 titleFrom:'session' 进来(并在上面复核过仍借名)。
          next.title_from = input.titleFrom ?? 'custom'
        }
        put(next, 'desc', input.desc)
        // 「落地」口回话(2026-10-24,卡 1a):null 清掉,空串当没传。
        if (input.sayNote === null) delete next.say_note
        else if (input.sayNote !== undefined && input.sayNote !== '') put(next, 'say_note', input.sayNote)
        put(next, 'project_id', input.projectId)
        put(next, 'module_id', input.moduleId)
        put(next, 'content_type', input.contentType)
        put(next, 'stage', input.stage)
        put(next, 'feature_stage', input.featureStage)
        put(next, 'priority', input.priority)
        put(next, 'assignee', input.assignee)
        put(next, 'manager', input.manager)
        // 负责人补充(2026-09-25,卡 N):null 清掉;有值过一道体检(空串 = 清掉)。
        if (input.assigneeNote === null) delete next.assignee_note
        else if (input.assigneeNote !== undefined) {
          const note = sanitizeAssigneeNote(input.assigneeNote)
          if (note === undefined) delete next.assignee_note
          else next.assignee_note = note
        }
        put(next, 'due', input.due)
        // 两个日期:null 照常清掉,**形状不对当没传**(不动盘上原来那一个)——
        // 把一个读不出来的日期写上去,月历上看起来就是"这条排期消失了"。
        if (input.plannedAt === null || isPublishDay(input.plannedAt)) put(next, 'planned_at', input.plannedAt)
        if (input.publishedAt === null || isPublishDay(input.publishedAt)) put(next, 'published_at', input.publishedAt)
        put(next, 'block_reason', input.blockReason)
        put(next, 'conversation', input.conversation)
        put(next, 'note', input.note)
        // 「只是问了一句」那一章(卡 Y)。`false` 与 null 一样擦掉:盘上不留一个"明确不是随手问"的假字段。
        if (input.casual === false) delete next.casual
        else put(next, 'casual', input.casual)
        // 「她看过结果了」那一格(卡 `claude/answer-comes-to-her`)。认不出的时刻当没传:
        // 写一个读不出来的时刻上去,那张卡就**永远**从「刚办完」里消失了(比多摆一次坏得多)。
        if (input.seenResultAt === null) delete next.seen_result_at
        else if (input.seenResultAt !== undefined && Number.isFinite(Date.parse(input.seenResultAt))) {
          next.seen_result_at = input.seenResultAt
        }
        put(next, 'dispatch', input.dispatch)
        if (role === undefined && executionRoleOf(next).kind === 'unclassified'
          && (input.dispatch?.status === 'running' || input.clientDispatch?.status === 'sent')) next.execution_role = { kind: 'business', origin: 'delegation' }
        // 要本人拍板的那一格(2026-10-26,卡「事务官页接管队列」):null 清掉;有值过一道体检
        // (服务端自己拼的也过同一道门,坏形状永远进不了盘)。
        if (input.ownerAsk === null) delete next.owner_ask
        else if (input.ownerAsk !== undefined) {
          const cleaned = sanitizeOwnerAsk(input.ownerAsk)
          if (cleaned !== undefined) next.owner_ask = cleaned
        }
        if (input.mode === null) delete next.mode
        else if (isComposerMode(input.mode)) next.mode = input.mode
        if (input.attachments !== undefined) {
          const cleaned = sanitizeAttachments(input.attachments)
          if (cleaned.length === 0) delete next.attachments
          else next.attachments = cleaned
        }
        if (input.call !== undefined) {
          const cleaned = sanitizeCallMeta(input.call)
          if (cleaned !== undefined) next.call = cleaned
        }
        // 卡 O 那两格:服务端自己拼的也过同一道门(坏形状永远进不了盘)。
        if (input.dispatchBlock === null) delete next.dispatch_block
        else if (input.dispatchBlock !== undefined) {
          const cleaned = sanitizeDispatchBlock(input.dispatchBlock)
          if (cleaned !== undefined) next.dispatch_block = cleaned
        }
        if (input.dispatchLane === null) delete next.dispatch_lane
        else if (input.dispatchLane !== undefined) {
          const cleaned = sanitizeDispatchLane(input.dispatchLane)
          if (cleaned !== undefined) next.dispatch_lane = cleaned
        }
        if (input.budget === null) delete next.budget
        else if (input.budget !== undefined) {
          const cleaned = sanitizeBudget(input.budget)
          if (cleaned !== undefined) next.budget = cleaned
        }
        // 与 client_dispatch 同一条:服务端自己拼的那份也要过同一道门(坏形状永远进不了盘)。
        if (input.selfShip === null) delete next.self_ship
        else if (input.selfShip !== undefined) {
          const cleaned = sanitizeSelfShip(input.selfShip)
          if (cleaned !== undefined) next.self_ship = cleaned
        }
        // 体检在写入这一侧也做一次:服务端自己拼的那份也得过同一道门(坏形状永远进不了盘)。
        if (input.clientDispatch === null) delete next.client_dispatch
        else if (input.clientDispatch !== undefined) {
          const cleaned = sanitizeClientDispatch(input.clientDispatch)
          if (cleaned !== undefined) next.client_dispatch = cleaned
        }
        if (input.links !== undefined) {
          if (input.links.length === 0) delete next.links
          else next.links = [...input.links]
        }
        if (input.deliverables !== undefined) {
          const cleaned = sanitizeDeliverables(input.deliverables)
          if (cleaned.length === 0) delete next.deliverables
          else next.deliverables = cleaned
        }
        applyNoteUpdate(next, input)
        return next
      })
    },

    advanceTopic(id: string): Promise<{ ok: boolean, stage?: TopicStage, reason?: string }> {
      return enqueueWrite(async () => {
        const data = await loadForWrite()
        const task = data.tasks.find(candidate => candidate.id === id)
        if (task === undefined) return { ok: false }
        // **不顺手把普通事项变成选题**:一条卡是不是选题由他建的时候决定,
        // 点一下「推进」就改了这张卡是什么东西,那是替他做了他没说要做的事。
        if (task.kind !== 'topic') return { ok: false, reason: '这条不是选题,推不动' }

        const from = task.stage ?? DEFAULT_TOPIC_STAGE
        const to = nextTopicStage(from)
        if (to === undefined) return { ok: false, reason: '已经到「复盘」了,后面没有下一步' }

        /*
         * ★ 从「发布」往「复盘」走之前,实际发布日必须已经填了(2026-10-02 运营同学那一版)。
         *
         * 上一版在这里**自动写当天**。那一下看着方便,实际上是我们替她说了一句她没说过的话:
         * 「这条已经发到平台上了,就在今天」。工作台从来没有发布过任何东西,也没去平台上核过 ——
         * 这一条与「取不到就缺席、不编一个数」是同一条规矩,只是这里编的不是数,是一个日期。
         *
         * 所以:**拒绝**,连盘都不落(同上面两条拒绝),让她先在卡上填实际发布日(走 update)。
         * 手改 stage 直接跳进「发布」的那条卡也走这一道 —— 它同样没有实际发布日可言。
         */
        if (from === '发布' && (task.published_at === undefined || task.published_at === '')) {
          return { ok: false, reason: TOPIC_PUBLISH_DAY_FIRST }
        }

        task.stage = to
        task.updated_at = stamp()
        await saveTasksFile(opts.file, data)
        return { ok: true, stage: to }
      })
    },

    remove(id: string): Promise<boolean> {
      return enqueueWrite(async () => {
        const data = await loadForWrite()
        const dropped = data.tasks.find(task => task.id === id)
        const before = data.tasks.length
        data.tasks = data.tasks.filter(task => task.id !== id)
        if (data.tasks.length === before) return false
        // ★ 会话记录回流建的便签被删过(2026-10-23,卡「待排的卡不许被派出去」④):记下
        // `<家>:<会话 id>` —— 这条会话记录以后不再回流建卡(重启后仍有效;最多 500 条,
        // 与「他说过不挂」那张表同一份分寸)。手建的便签没有 `from:session`,不记。
        const droppedRef = dropped?.from?.kind === 'session' ? dropped.from.ref : undefined
        if (typeof droppedRef === 'string' && droppedRef !== '') {
          data.collab_session_removed = [...(data.collab_session_removed ?? []).filter(one => one !== droppedRef), droppedRef].slice(-500)
        }
        await saveTasksFile(opts.file, data)
        return true
      })
    },

    createSprint(input: CreateSprintInput): Promise<{ ok: boolean, id?: string, reason?: string }> {
      return enqueueWrite(async () => {
        const name = input.name.trim()
        if (name === '') return { ok: false, reason: '冲刺名不能为空' }
        if (input.projectId.trim() === '') return { ok: false, reason: '冲刺必须属于一个项目' }

        const data = await loadForWrite()
        const at = stamp()
        const id = newId()
        data.sprints.push({
          id,
          project_id: input.projectId,
          name,
          ...(input.goal === undefined || input.goal === '' ? {} : { goal: input.goal }),
          versions: [...(input.versions ?? [])],
          ...(input.startsAt === undefined || input.startsAt === '' ? {} : { starts_at: input.startsAt }),
          ...(input.endsAt === undefined || input.endsAt === '' ? {} : { ends_at: input.endsAt }),
          created_at: at,
          updated_at: at,
        })
        await saveTasksFile(opts.file, data)
        return { ok: true, id }
      })
    },

    updateSprint(id: string, input: UpdateSprintInput): Promise<boolean> {
      const name = input.name?.trim()
      if (input.name !== undefined && name === '') return Promise.resolve(false)
      return mutate(data => data.sprints, id, (sprint) => {
        const next: StoredSprint = { ...sprint }
        if (name !== undefined) next.name = name
        put(next, 'goal', input.goal)
        put(next, 'starts_at', input.startsAt)
        put(next, 'ends_at', input.endsAt)
        if (input.versions !== undefined) next.versions = [...input.versions]
        return next
      })
    },

    removeSprint(id: string): Promise<boolean> {
      return enqueueWrite(async () => {
        const data = await loadForWrite()
        const before = data.sprints.length
        data.sprints = data.sprints.filter(sprint => sprint.id !== id)
        if (data.sprints.length === before) return false

        // **不级联删卡**(不可改清单第 5 条延伸):属于这个冲刺的模块跟着退休,
        // 但挂在那些模块下的功能点一张不动,只是 module_id 被摘掉,退回「未归模块」
        // 泳道继续在看板上待着。删一个冲刺就顺手扔掉几十条待办,那是系统替 Ben
        // 做了他没说要做的清理。
        const orphaned = new Set(data.modules.filter(module => module.sprint_id === id).map(module => module.id))
        data.modules = data.modules.filter(module => module.sprint_id !== id)
        data.tasks = data.tasks.map(task => (
          task.module_id !== undefined && orphaned.has(task.module_id)
            ? (() => { const next = { ...task }; delete next.module_id; return next })()
            : task
        ))
        await saveTasksFile(opts.file, data)
        return true
      })
    },

    createModule(input: CreateModuleInput): Promise<{ ok: boolean, id?: string, reason?: string }> {
      return enqueueWrite(async () => {
        const name = input.name.trim()
        if (name === '') return { ok: false, reason: '模块名不能为空' }
        if (input.sprintId.trim() === '') return { ok: false, reason: '模块必须属于一个冲刺' }

        const data = await loadForWrite()
        const at = stamp()
        const id = newId()
        data.modules.push({
          id,
          sprint_id: input.sprintId,
          name,
          ...(input.goal === undefined || input.goal === '' ? {} : { goal: input.goal }),
          ...(input.versionLabel === undefined || input.versionLabel === ''
            ? {}
            : { version_label: input.versionLabel }),
          created_at: at,
          updated_at: at,
        })
        await saveTasksFile(opts.file, data)
        return { ok: true, id }
      })
    },

    updateModule(id: string, input: UpdateModuleInput): Promise<boolean> {
      const name = input.name?.trim()
      if (input.name !== undefined && name === '') return Promise.resolve(false)
      return mutate(data => data.modules, id, (module) => {
        const next: StoredModule = { ...module }
        if (name !== undefined) next.name = name
        put(next, 'goal', input.goal)
        put(next, 'version_label', input.versionLabel)
        return next
      })
    },

    removeModule(id: string): Promise<boolean> {
      return enqueueWrite(async () => {
        const data = await loadForWrite()
        const before = data.modules.length
        data.modules = data.modules.filter(module => module.id !== id)
        if (data.modules.length === before) return false
        // 同 removeSprint:卡不跟着走,只是退回「未归模块」。
        data.tasks = data.tasks.map(task => (
          task.module_id === id
            ? (() => { const next = { ...task }; delete next.module_id; return next })()
            : task
        ))
        await saveTasksFile(opts.file, data)
        return true
      })
    },

    setProjectMeta(projectId: string, input: SetProjectMetaInput): Promise<boolean> {
      return enqueueWrite(async () => {
        if (projectId.trim() === '') return false
        const data = await loadForWrite()
        const existing = data.project_meta.find(meta => meta.project_id === projectId)
        const next: ProjectBoardMeta = { ...(existing ?? { project_id: projectId }) }
        put(next, 'priority', input.priority)
        put(next, 'assignee', input.assignee)
        if (input.repos !== undefined) {
          const cleaned = sanitizeRepos(input.repos)
          if (cleaned.length === 0) delete next.repos
          else next.repos = cleaned
        }
        if (input.resources !== undefined) {
          const cleaned = sanitizeResources(input.resources)
          if (cleaned.length === 0) delete next.resources
          else next.resources = cleaned
        }

        data.project_meta = [...data.project_meta.filter(meta => meta.project_id !== projectId), next]
        await saveTasksFile(opts.file, data)
        return true
      })
    },

    createGoal(input: CreateGoalInput): Promise<{ ok: boolean, id?: string, reason?: string }> {
      return enqueueWrite(async () => {
        const title = input.title.trim()
        if (title === '') return { ok: false, reason: '目标要有一句话' }
        // 条件(契约 §1):给了就必须 3–7 条、每条一句话——那是「做到什么算完」的口径,不是 TODO。
        if (input.conditions !== undefined) {
          if (input.conditions.length < GOAL_CONDITIONS_MIN || input.conditions.length > GOAL_CONDITIONS_MAX) {
            return { ok: false, reason: `条件要 ${GOAL_CONDITIONS_MIN} 到 ${GOAL_CONDITIONS_MAX} 条` }
          }
          if (input.conditions.some(one => one.text.trim() === '')) return { ok: false, reason: '条件要写清「做成什么样」(text 不能空)' }
        }
        const data = await loadForWrite()
        const at = stamp()
        const id = newId()
        const goal = sanitizeGoal({
          id, title, why: input.why, owner: 'me', status: 'open', due: input.due, project_id: input.projectId,
          version: input.version, created_at: at, updated_at: at,
          conditions: input.conditions?.map((one, index) => ({
            id: `gc-${randomBytes(4).toString('hex')}-${index}`, text: one.text,
            ...(one.taskId === undefined || one.taskId === '' ? {} : { task_id: one.taskId }),
            ...(one.evidence === undefined ? {} : { evidence: one.evidence }),
            verifications: [], created_at: at, updated_at: at,
          })),
        }) as CollabGoal
        data.goals = [...(data.goals ?? []), goal]
        await saveTasksFile(opts.file, data)
        return { ok: true, id }
      })
    },

    updateGoal(id: string, input: UpdateGoalInput): Promise<boolean> {
      const title = input.title?.trim()
      if (input.title !== undefined && title === '') return Promise.resolve(false)
      if (input.status !== undefined && !GOAL_STATUSES.includes(input.status)) return Promise.resolve(false)
      return mutate(data => (data.goals ??= []), id, (goal) => {
        const next: CollabGoal = { ...goal }
        if (title !== undefined) next.title = title
        if (input.status !== undefined) next.status = input.status
        put(next, 'why', input.why === '' ? null : input.why)
        put(next, 'due', input.due === '' ? null : input.due)
        put(next, 'project_id', input.projectId === '' ? null : input.projectId)
        put(next, 'version', input.version === '' ? null : input.version)
        return next
      })
    },

    saveGoalSprint(input: GoalSprintInput): Promise<{ ok: boolean, id?: string, reason?: string }> {
      return enqueueWrite(async () => {
        const data = await loadTasksFile(opts.file)
        const list = data.goal_sprints ?? []
        const at = stamp()
        const have = input.id === undefined ? undefined : list.find(one => one.id === input.id)
        if (input.id !== undefined && have === undefined) return { ok: false, reason: '没有这个冲刺' }
        const title = (input.title ?? have?.title ?? '').trim()
        if (title === '') return { ok: false, reason: '冲刺要有名字' }
        const id = have?.id ?? newId()
        const next = sanitizeGoalSprint({
          id, title,
          start: input.start === undefined ? have?.start : input.start,
          end: input.end === undefined ? have?.end : input.end,
          goal_ids: input.goalIds ?? have?.goal_ids ?? [],
          created_at: have?.created_at ?? at, updated_at: at,
        }) as CollabSprint
        data.goal_sprints = [...list.filter(one => one.id !== id), next]
        await saveTasksFile(opts.file, data)
        return { ok: true, id }
      })
    },

    saveAgentCard(input: AgentCardInput): Promise<{ ok: boolean, id?: string, reason?: string }> {
      return enqueueWrite(async () => {
        const data = await loadTasksFile(opts.file)
        const list = data.agent_cards ?? []
        const at = stamp()
        const have = input.id === undefined ? undefined : list.find(one => one.id === input.id)
        if (input.id !== undefined && have === undefined) return { ok: false, reason: '没有这张名片' }
        const name = (input.name ?? have?.name ?? '').trim()
        const hand = (input.hand ?? have?.hand ?? '').trim()
        if (name === '') return { ok: false, reason: '名片要有名字' }
        if (hand === '') return { ok: false, reason: '要选哪只手(Agent 登记表里的一家)' }
        const id = have?.id ?? newAgentCardId()
        const goodAt = input.goodAt === null ? undefined : (input.goodAt ?? have?.good_at)
        // 四样(2026-10-22):没给保持老卡那一份,给了 null 清掉,给了值换新(同 goodAt 的三态)。
        const runtime = input.runtime === null ? undefined : (input.runtime ?? have?.runtime)
        const project = input.project === null ? undefined : (input.project ?? have?.project)
        const model = input.model === null ? undefined : (input.model ?? have?.model)
        const instructions = input.instructions === null ? undefined : (input.instructions ?? have?.instructions)
        const budget = input.budget === null ? undefined : (input.budget ?? have?.budget)
        const card = sanitizeAgentCard({
          id, name, hand, owner: have?.owner ?? 'me',
          good_at: goodAt, skills: input.skills ?? have?.skills, mcp: input.mcp ?? have?.mcp, shared: input.shared ?? have?.shared ?? { to: 'none' },
          runtime, project, model, instructions, budget,
          created_at: have?.created_at ?? at, updated_at: at,
        })
        if (card === undefined) return { ok: false, reason: '名片的字段不对' }
        data.agent_cards = [...list.filter(one => one.id !== id), card]
        await saveTasksFile(opts.file, data)
        return { ok: true, id }
      })
    },

    comment(taskId: string, input: CommentInput): Promise<{ ok: boolean, id?: string, reason?: string }> {
      return enqueueWrite(async () => {
        const text = input.text.trim()
        if (text === '') return { ok: false, reason: '留言是空的' }
        const data = await loadTasksFile(opts.file)
        const task = data.tasks.find(one => one.id === taskId)
        if (task === undefined) return { ok: false }
        const at = stamp()
        const id = `c-${randomBytes(4).toString('hex')}`
        task.comments = sanitizeComments([...(task.comments ?? []), { id, by: input.by, text, at, verdict: input.verdict, ...(input.intent === undefined ? {} : { intent: input.intent }) }])
        task.updated_at = at
        await saveTasksFile(opts.file, data)
        return { ok: true, id }
      })
    },

    resolveComment(taskId: string, commentId: string, by: string | null): Promise<boolean> {
      return mutate(data => data.tasks, taskId, (task) => {
        const at = stamp()
        const comments = (task.comments ?? []).map((one) => {
          if (one.id !== commentId) return one
          const next = { ...one }
          if (by === null) { delete next.resolved_by; delete next.resolved_at }
          else { next.resolved_by = by; next.resolved_at = at }
          return next
        })
        return { ...task, comments }
      })
    },

    migrateToGoals() {
      return enqueueWrite(async () => {
        const data = await loadTasksFile(opts.file)
        if (data.collab_migration !== undefined) return { ok: true, already: true, goals: 0, tasks: 0 }
        // 没有老冲刺 = 没东西可迁:一个字节都不写(新装的机器、用例里的临时账都走这一支)。
        if (data.sprints.length === 0) return { ok: true, goals: 0, tasks: 0 }
        // 迁之前整份留一份(只在还没有备份时写:回退再迁不覆盖最早那一份)。
        const backup = `${opts.file}.pre-collab.json`
        await mkdir(dirname(opts.file), { recursive: true })
        try { await writeFile(backup, `${JSON.stringify(data, null, 2)}\n`, { flag: 'wx' }) }
        catch (error) { if ((error as { code?: string }).code !== 'EEXIST') throw error }
        const next = migrateSprintsToGoals(data, stamp(), newId)
        await saveTasksFile(opts.file, next)
        const record = next.collab_migration as CollabMigrationRecord
        return { ok: true, goals: record.goal_ids.length, tasks: Object.keys(record.tasks).length, backup }
      })
    },

    dismissProposal(key: string): Promise<boolean> {
      return enqueueWrite(async () => {
        const text = key.trim()
        if (text === '') return false
        const data = await loadTasksFile(opts.file)
        data.collab_dismissed = [...(data.collab_dismissed ?? []).filter(one => one !== text), text].slice(-500)
        await saveTasksFile(opts.file, data)
        return true
      })
    },

    async dismissedProposals(): Promise<string[]> {
      return (await readTasksFile(opts.file, readCache)).data.collab_dismissed ?? []
    },

    setPlacedNotice(key: string, on: boolean): Promise<boolean> {
      return enqueueWrite(async () => {
        const text = key.trim()
        if (text === '') return false
        const data = await loadTasksFile(opts.file)
        const rest = (data.collab_placed ?? []).filter(one => one !== text)
        data.collab_placed = (on ? [...rest, text] : rest).slice(-50)
        await saveTasksFile(opts.file, data)
        return true
      })
    },

    async placedNotices(): Promise<string[]> {
      return (await readTasksFile(opts.file, readCache)).data.collab_placed ?? []
    },

    async removedSessionCards(): Promise<string[]> {
      return (await readTasksFile(opts.file, readCache)).data.collab_session_removed ?? []
    },

    saveSquad(input: SquadInput) {
      return enqueueWrite(async () => {
        const data = await loadTasksFile(opts.file)
        const list = data.squads ?? []
        const have = input.id === undefined ? undefined : list.find(one => one.id === input.id)
        if (input.id !== undefined && have === undefined) return { ok: false, reason: '没有这个小队' }
        const at = stamp()
        const id = have?.id ?? newId()
        const squad = sanitizeSquad({
          id, name: input.name ?? have?.name, leader: input.leader ?? have?.leader, members: input.members ?? have?.members ?? [],
          created_at: have?.created_at ?? at, updated_at: at,
        })
        if (squad === undefined) return { ok: false, reason: '小队要有名字和组长' }
        data.squads = [...list.filter(one => one.id !== id), squad]
        await saveTasksFile(opts.file, data)
        return { ok: true, id }
      })
    },

    removeSquad(id: string) {
      return enqueueWrite(async () => {
        const data = await loadTasksFile(opts.file)
        const before = (data.squads ?? []).length
        data.squads = (data.squads ?? []).filter(one => one.id !== id)
        if (data.squads.length === before) return false
        await saveTasksFile(opts.file, data)
        return true
      })
    },

    saveTimer(input: TimerInput) {
      return enqueueWrite(async () => {
        const data = await loadTasksFile(opts.file)
        const list = data.timers ?? []
        const have = input.id === undefined ? undefined : list.find(one => one.id === input.id)
        if (input.id !== undefined && have === undefined) return { ok: false, reason: '没有这条定时派活' }
        if (input.trigger !== undefined && sanitizeTimerTrigger(input.trigger) === undefined) {
          return { ok: false, reason: '触发写得不对:定时要五段「分 时 日 月 周」,每段只认 * / 数字 / 逗号 / */n;或者选 webhook' }
        }
        const at = stamp()
        const id = have?.id ?? newId()
        const timer = sanitizeTimer({
          id, name: input.name ?? have?.name, trigger: input.trigger ?? have?.trigger, assignee: input.assignee ?? have?.assignee,
          template: input.template ?? have?.template, enabled: input.enabled ?? have?.enabled ?? true, runs: have?.runs ?? [],
          created_at: have?.created_at ?? at, updated_at: at,
        })
        if (timer === undefined) return { ok: false, reason: '要有名字、派给谁,模板要有标题和 1–3 条「做到什么算完」' }
        data.timers = [...list.filter(one => one.id !== id), timer]
        await saveTasksFile(opts.file, data)
        return { ok: true, id }
      })
    },

    removeTimer(id: string) {
      return enqueueWrite(async () => {
        const data = await loadTasksFile(opts.file)
        const before = (data.timers ?? []).length
        data.timers = (data.timers ?? []).filter(one => one.id !== id)
        if (data.timers.length === before) return false
        await saveTasksFile(opts.file, data)
        return true
      })
    },

    recordTimerRun(id: string, run: CollabTimerRun) {
      return enqueueWrite(async () => {
        const data = await loadTasksFile(opts.file)
        const timer = (data.timers ?? []).find(one => one.id === id)
        if (timer === undefined) return false
        timer.runs = [...timer.runs, run].slice(-TIMER_RUNS_MAX)
        await saveTasksFile(opts.file, data)
        return true
      })
    },

    saveMcp(input: McpInput) {
      return enqueueWrite(async () => {
        const data = await loadTasksFile(opts.file)
        const list = data.mcp ?? []
        const have = input.id === undefined ? undefined : list.find(one => one.id === input.id)
        if (input.id !== undefined && have === undefined) return { ok: false, reason: '没有这一条' }
        if ((input.secret_names ?? []).some(one => !SECRET_NAME.test(one))) return { ok: false, reason: '密钥名只许字母、数字、下划线(会当环境变量名用)' }
        const at = stamp()
        const id = have?.id ?? newId()
        const entry = sanitizeMcp({
          id, name: input.name ?? have?.name, url_template: input.url_template ?? have?.url_template,
          secret_names: input.secret_names ?? have?.secret_names ?? [], created_at: have?.created_at ?? at, updated_at: at,
        })
        if (entry === undefined) return { ok: false, reason: '要有名字和地址模板' }
        data.mcp = [...list.filter(one => one.id !== id), entry]
        await saveTasksFile(opts.file, data)
        return { ok: true, id }
      })
    },

    removeMcp(id: string) {
      return enqueueWrite(async () => {
        const data = await loadTasksFile(opts.file)
        const before = (data.mcp ?? []).length
        data.mcp = (data.mcp ?? []).filter(one => one.id !== id)
        if (data.mcp.length === before) return false
        await saveTasksFile(opts.file, data)
        return true
      })
    },

    /* —— 协作区事实层(2026-10-24 契约 B/C/D2)。写口全在这里,HTTP 层只解析与回码。 —— */

    saveGoalCondition(input: GoalConditionInput) {
      return enqueueWrite(async () => {
        const text = input.text.trim()
        if (text === '') return { ok: false, reason: '条件要写清「做成什么样」(text 不能是空的)' }
        const data = await loadForWrite()
        const goal = (data.goals ?? []).find(one => one.id === input.goalId)
        if (goal === undefined) return { ok: false }
        const conditions = goal.conditions ?? []
        const have = input.id === undefined ? undefined : conditions.find(one => one.id === input.id)
        if (input.id !== undefined && have === undefined) return { ok: false }
        if (have === undefined && conditions.length >= GOAL_CONDITIONS_MAX) {
          return { ok: false, reason: `一个目标最多 ${GOAL_CONDITIONS_MAX} 条条件` }
        }
        const at = stamp()
        const id = have?.id ?? `gc-${randomBytes(4).toString('hex')}`
        const next = sanitizeGoalCondition({
          id, text,
          ...(input.taskId === undefined ? have?.task_id === undefined ? {} : { task_id: have.task_id } : input.taskId === '' ? {} : { task_id: input.taskId }),
          ...(input.evidence === undefined ? have?.evidence === undefined ? {} : { evidence: have.evidence } : { evidence: input.evidence }),
          verifications: have?.verifications ?? [],
          ...(have?.delivered_at === undefined ? {} : { delivered_at: have.delivered_at }),
          created_at: have?.created_at ?? at,
          updated_at: at,
        })
        if (next === undefined) return { ok: false, reason: '条件没存上' }
        if (have !== undefined && have.verifications.length > 0 && (next.text !== have.text || next.task_id !== have.task_id || JSON.stringify(next.evidence) !== JSON.stringify(have.evidence))) {
          delete next.delivered_at
          next.verifications = [...next.verifications, { by: 'system', at, pass: false, round: data.tasks.find(t => t.id === next.task_id)?.round ?? 1, note: '条件或证据已修改,需要重新核验' }]
        }
        goal.conditions = [...conditions.filter(one => one.id !== id), next]
        goal.updated_at = at
        await saveTasksFile(opts.file, data)
        return { ok: true, id }
      })
    },

    removeGoalCondition(goalId: string, conditionId: string) {
      return enqueueWrite(async () => {
        const data = await loadForWrite()
        const goal = (data.goals ?? []).find(one => one.id === goalId)
        if (goal === undefined) return false
        const conditions = goal.conditions ?? []
        if (!conditions.some(one => one.id === conditionId)) return false
        goal.conditions = conditions.filter(one => one.id !== conditionId)
        goal.updated_at = stamp()
        await saveTasksFile(opts.file, data)
        return true
      })
    },

    verifyGoalCondition(goalId: string, conditionId: string, input: VerifyGoalConditionInput) {
      return enqueueWrite(async () => {
        const data = await loadForWrite()
        const goal = (data.goals ?? []).find(one => one.id === goalId)
        if (goal === undefined) return { ok: false }
        const condition = (goal.conditions ?? []).find(one => one.id === conditionId)
        if (condition === undefined) return { ok: false }
        const task = condition.task_id === undefined ? undefined : data.tasks.find(one => one.id === condition.task_id)
        // 没有成果可验:不在「等我确认」或「完成」的任务,拒绝(D13 说清为什么)。
        if (task === undefined) return { ok: false, reason: '这条条件还没安排承接任务,没有成果可验' }
        if (task.status !== 'confirm' && task.status !== 'done') {
          return { ok: false, reason: '承接任务不在「等我确认」或「完成」,没有成果可验' }
        }
        if (input.pass && staleUpstreamTasks(data.tasks, data.relations ?? []).has(task.id)) return { ok: false, reason: '上游成果已重开,请先复核并更新成果承接关系' }
        if (input.pass && (condition.evidence ?? []).length === 0 && (task.receipt?.evidence ?? []).length === 0 && (task.deliverables ?? []).length === 0) return { ok: false, reason: '没有成果证据,不能核验通过;请补充产物或验收记录' }
        if (!input.pass && (input.note ?? '').trim() === '') return { ok: false, reason: '验收退回要写明修改要求' }
        const at = stamp()
        condition.verifications = [...condition.verifications, {
          by: input.by, at, pass: input.pass, round: task.round ?? 1,
          ...(input.note === undefined || input.note.trim() === '' ? {} : { note: input.note.trim() }),
        }]
        if (!input.pass) {
          const from = task.status
          task.status = 'doing'
          invalidateRound(data, task, at)
          task.updated_at = at
          delete task.done_at
          delete task.seen_result_at
          delete task.block_reason
          if (task.conversation !== undefined) delete task.conversation.archived_at
          task.transitions = [...(task.transitions ?? []), { from, to: 'doing' as const, at }].slice(-NOTE_TRANSITIONS_MAX)
          task.comments = [...(task.comments ?? []), { id: `c-${randomBytes(4).toString('hex')}`, by: input.by, text: input.note!.trim(), verdict: 'rework' as const, at }].slice(-NOTE_COMMENTS_MAX)
        }
        condition.updated_at = at
        goal.updated_at = at
        await saveTasksFile(opts.file, data)
        return { ok: true }
      })
    },

    deliverGoalCondition(goalId: string, conditionId: string) {
      return enqueueWrite(async () => {
        const data = await loadForWrite()
        const goal = (data.goals ?? []).find(one => one.id === goalId)
        if (goal === undefined) return { ok: false }
        const condition = (goal.conditions ?? []).find(one => one.id === conditionId)
        if (condition === undefined) return { ok: false }
        const task = condition.task_id === undefined ? undefined : data.tasks.find(one => one.id === condition.task_id)
        // 只有本轮验收通过才许记交付;状态是现算的,不另存一份会漂的字段。
        if (conditionStateOf(condition, task) !== 'verified' || task !== undefined && staleUpstreamTasks(data.tasks, data.relations ?? []).has(task.id)) {
          return { ok: false, reason: '只有本轮验收通过的条件才能记交付' }
        }
        const at = stamp()
        condition.delivered_at = at
        condition.updated_at = at
        goal.updated_at = at
        await saveTasksFile(opts.file, data)
        return { ok: true }
      })
    },

    prepareInvitation(taskId: string, messageId: string, to: string) {
      return enqueueWrite(async () => {
        const data = await loadForWrite()
        const parent = data.tasks.find(one => one.id === taskId)
        const message = parent?.messages?.find(one => one.id === messageId)
        const delivery = message?.deliveries?.find(one => one.to === to)
        if (parent === undefined || message === undefined || delivery === undefined) return { fresh: false }
        if (delivery.task_id !== undefined) return { taskId: delivery.task_id, fresh: false }
        if (delivery.status !== 'pending' || !(data.agent_cards ?? []).some(one => one.id === to)) return { fresh: false }
        const id = `t-${randomBytes(4).toString('hex')}`
        const at = stamp()
        const child: StoredTask = {
          // 认领事务与运输不是同一事务。dispatch 尚未留下事实时,普通 todo 驱动不能抢走或在重启后暗中重派。
          id, title: message.text.slice(0, 120), desc: message.text, status: 'blocked', block_reason: 'input', note: INVITATION_UNCONFIRMED_NOTE,
          source: { kind: 'manual' }, from: { kind: 'channel', ref: message.id, quote: parent.title },
          assignee: to as AgentCard['id'], acceptance: parent.acceptance ?? ['按邀请说明交回成果与证据'],
          ...(parent.goal_id === undefined ? {} : { goal_id: parent.goal_id }),
          ...(parent.project_id === undefined ? {} : { project_id: parent.project_id }),
          created_at: at, updated_at: at,
        }
        data.tasks.push(child)
        parent.children = [...new Set([...(parent.children ?? []), id])]
        parent.messages = parent.messages!.map(one => one.id !== messageId ? one : { ...one, deliveries: one.deliveries!.map(d => d.to !== to ? d : { ...d, task_id: id, error: INVITATION_UNCONFIRMED_NOTE }) })
        await saveTasksFile(opts.file, data)
        return { taskId: id, fresh: true }
      })
    },
    finishInvitation(taskId: string, messageId: string, to: string, result: { ok: boolean, note: string }) {
      return enqueueWrite(async () => {
        const data = await loadForWrite()
        const parent = data.tasks.find(one => one.id === taskId)
        if (parent === undefined) return
        parent.messages = (parent.messages ?? []).map(one => one.id !== messageId ? one : { ...one, deliveries: (one.deliveries ?? []).map(d => {
          if (d.to !== to) return d
          const { error: _oldError, ...clean } = d
          return { ...clean, at: stamp(), status: result.ok ? 'delivered' as const : 'failed' as const, ...(result.ok ? {} : { error: result.note }) }
        }) })
        await saveTasksFile(opts.file, data)
      })
    },

    message(taskId: string, input: NoteMessageInput) {
      return enqueueWrite(async () => {
        const text = input.text.trim()
        if (text === '') return { ok: false, reason: '留言是空的' }
        const intent: NoteMessageIntent = input.intent === 'ask' ? 'ask' : 'record'
        const mentions = sanitizeStrings(input.mentions, 30)
        if (intent === 'ask' && mentions.length === 0) {
          return { ok: false, reason: '邀请(intent 是 ask)至少要 @ 一个人或一张名片(mentions)' }
        }
        const data = await loadForWrite()
        const task = data.tasks.find(one => one.id === taskId)
        if (task === undefined) return { ok: false }
        /*
         * ★ **幂等**(契约 §2):断网重发带同一个 client_msg_id,原样返回已有消息 ——
         * 不新建留言、不重复派活。只认同一张卡内的去重。
         */
        const clientMsgId = input.clientMsgId?.trim()
        if (clientMsgId !== undefined && clientMsgId !== '') {
          const dup = (task.messages ?? []).find(one => one.client_msg_id === clientMsgId)
          if (dup !== undefined) return { ok: true, message: dup, duplicated: true }
        }
        const at = stamp()
        const id = `m-${randomBytes(4).toString('hex')}`
        const cards = new Set((data.agent_cards ?? []).map(one => one.id))
        // 局域网成员(`member:<member_id>`,注册表里有的;契约 §5):真实可及性以 refresh 为准,先记 pending。
        const lanMembers = new Set((data.lan_members ?? []).map(one => `member:${one.member_id}`))
        // 投递语义:me 立即 delivered;名片 / 成员有效 → pending(回执到了读取侧升级 accepted);
        // 找不到名片 / 成员 → failed 带真实原因,不当作已邀请。
        const deliveries: MessageDelivery[] = intent === 'ask'
          ? mentions.map((to): MessageDelivery => {
              if (to === 'me') return { to, status: 'delivered', at }
              if (cards.has(to as AgentCard['id'])) return { to, status: 'pending', at }
              if (lanMembers.has(to)) return { to, status: 'pending', at }
              return { to, status: 'failed', at, error: `unknown target: ${to}` }
            })
          : []
        const saved = sanitizeNoteMessage({
          id,
          ...(clientMsgId === undefined ? {} : { client_msg_id: clientMsgId }),
          by: input.by ?? 'me',
          text, at, intent,
          ...(mentions.length === 0 ? {} : { mentions }),
          ...(input.replyTo === undefined || input.replyTo === '' ? {} : { reply_to: input.replyTo }),
          ...(deliveries.length === 0 ? {} : { deliveries }),
        })
        if (saved === undefined) return { ok: false, reason: '留言没存上' }
        task.messages = [...(task.messages ?? []), saved].slice(-NOTE_MESSAGES_MAX)
        task.updated_at = at
        // 被邀请者(mentions)进 collaborators(去重);负责人 assignee 一个都不动 —— 协作者不抢负责人。
        if (intent === 'ask') task.collaborators = [...new Set([...(task.collaborators ?? []), ...mentions])]
        await saveTasksFile(opts.file, data)
        return { ok: true, message: saved }
      })
    },

    saveRelation(input: TaskRelationInput) {
      return enqueueWrite(async () => {
        const data = await loadForWrite()
        const from = data.tasks.find(one => one.id === input.fromId)
        const to = data.tasks.find(one => one.id === input.toId)
        if (from === undefined || to === undefined) return { ok: false }
        if (input.fromId === input.toId) return { ok: false, reason: '不能给自己连关系' }
        const note = input.note?.trim()
        if ((input.kind === 'handoff' || input.kind === 'rejected_back') && (note === undefined || note === '')) {
          return { ok: false, reason: input.kind === 'handoff' ? '交接(handoff)要写一句交回什么、谁接收(note)' : '退回(rejected_back)要写一句修改要求(note)' }
        }
        const relations = data.relations ?? []
        if (relations.some(one => one.from_id === input.fromId && one.to_id === input.toId && one.kind === input.kind)) {
          return { ok: false, reason: '这两张卡之间已经有同样的一条关系了' }
        }
        if (input.kind === 'depends_on') {
          /*
           * 拒环(契约 §3):沿 depends_on 边 DFS,新边 from→to 成环当且仅当 to 已经到得了 from。
           * rejected_back 不参与(验收退回回到原制作是有意义的流程环,与依赖环分开)。
           */
          const nexts = new Map<string, string[]>()
          for (const one of relations) {
            if (one.kind !== 'depends_on') continue
            nexts.set(one.from_id, [...(nexts.get(one.from_id) ?? []), one.to_id])
          }
          const reached = new Set<string>()
          const reachesFrom = (at: string): boolean => {
            if (at === input.fromId) return true
            if (reached.has(at)) return false
            reached.add(at)
            for (const next of nexts.get(at) ?? []) if (reachesFrom(next)) return true
            return false
          }
          if (reachesFrom(input.toId)) return { ok: false, reason: '依赖(depends_on)连下去会成环' }
        }
        const at = stamp()
        const id = `r-${randomBytes(4).toString('hex')}`
        const relation = sanitizeTaskRelation({
          id, from_id: input.fromId, to_id: input.toId, kind: input.kind,
          ...(note === undefined || note === '' ? {} : { note }),
          /*
           * round(契约 §3):rejected_back 记目标卡(原制作卡)当前轮次;handoff / derived 记来源卡建关系时
           * 的轮次 —— 读取侧现算 stale:来源卡轮次涨过 = 上游重开,下游别拿旧交接当数。
           */
          ...((input.kind === 'rejected_back'
            ? { round: to.round ?? 1 }
            : input.kind === 'handoff' || input.kind === 'derived'
              ? { round: from.round ?? 1 }
              : {})),
          created_at: at,
        })
        if (relation === undefined) return { ok: false, reason: '关系没存上' }
        data.relations = [...relations, relation]
        await saveTasksFile(opts.file, data)
        return { ok: true, id }
      })
    },

    removeRelation(id: string) {
      return enqueueWrite(async () => {
        const data = await loadForWrite()
        const relations = data.relations ?? []
        const removed = relations.find(one => one.id === id)
        if (removed === undefined) return false
        // 升级前可能已有 stale 关系但未作废下游核验;删边也不能让那次旧通过复活。
        if (staleUpstreamTasks(data.tasks, relations).has(removed.to_id)) invalidateConditions(data, downstreamTasks([removed.to_id], relations), stamp())
        data.relations = relations.filter(one => one.id !== id)
        await saveTasksFile(opts.file, data)
        return true
      })
    },

    async listRelations() {
      return (await readTasksFile(opts.file, readCache)).data.relations ?? []
    },

    /* —— 局域网身份与成员(2026-10-24 契约 §5)。写口全在这里,探测(collabLan.ts 的 ping)在路由层。 —— */

    async lanChannel(projectId: string) {
      return ((await readTasksFile(opts.file, readCache)).data.lan_messages ?? [])
        .filter(one => one.project_id === projectId).map(({ transport_receipt: _receipt, ...message }) => message)
    },
    async lanSourcePolicies() { return (await readTasksFile(opts.file, readCache)).data.lan_source_policies ?? [] },
    saveLanSourcePolicy(input) {
      return enqueueWrite(async () => {
        const data = await loadForWrite()
        if (!data.tasks.some(t => t.project_id === input.project_id) && !(data.goals ?? []).some(g => g.project_id === input.project_id)) return { ok: false, reason: '这台未加入该项目' }
        const policies = data.lan_source_policies ?? [], old = policies.find(p => p.project_id === input.project_id)
        if (input.expected_version !== (old?.version ?? 0)) return { ok: false, reason: '来源发布策略版本冲突,原策略已保留', ...(old === undefined ? {} : { policy: old }) }
        const policy = sanitizeLanSourcePolicy({ ...input, version: (old?.version ?? 0) + 1, updated_at: stamp() })
        if (policy === undefined) return { ok: false, reason: '来源发布策略不完整' }
        data.lan_source_policies = [...policies.filter(p => p.project_id !== input.project_id), policy]
        await saveTasksFile(opts.file, data)
        return { ok: true, policy }
      })
    },
    saveLanMessage(message: LanChannelMessage, received = false) {
      return enqueueWrite(async () => {
        const data = await loadForWrite()
        const clean = sanitizeLanMessage(message)
        if (clean === undefined || clean.kind === 'report' && parseReceipt(clean.text) === undefined) return { ok: false }
        const makeReceipt = (): LanTransportReceipt => {
          data.lan_identity ??= newLanIdentity()
          return { message_id: clean.id, member_id: data.lan_identity.member_id, at: stamp() }
        }
        const messages = data.lan_messages ?? []
        // 同一来源、同一 message id 只能有一条。传输重试不重写对端内容。
        const index = messages.findIndex(m => m.id === clean.id && m.author.member_id === clean.author.member_id)
        if (index >= 0) {
          const { deliveries: _oldDelivery, transport_receipt: storedReceipt, ...original } = messages[index]!
          const { deliveries: _newDelivery, ...retry } = clean
          if (JSON.stringify(original) !== JSON.stringify(retry)) return { ok: false }
          // 重放不重新应用报告副作用;本机发送端仅可更新同一封消息的运输状态。
          if (received) {
            const receipt = storedReceipt ?? makeReceipt()
            // 旧文件没有保存运输回执:首次升级后确认时补记,不猜测之前的接收时间或重做业务。
            if (storedReceipt === undefined) {
              messages[index] = { ...messages[index]!, transport_receipt: receipt }
              await saveTasksFile(opts.file, data)
            }
            return { ok: true, duplicated: true, receipt }
          }
          if (clean.author.member_id !== data.lan_identity?.member_id) return { ok: true, duplicated: true }
          messages[index] = { ...clean, ...(storedReceipt === undefined ? {} : { transport_receipt: storedReceipt }) }
          data.lan_messages = messages
          await saveTasksFile(opts.file, data)
          return { ok: true, duplicated: true }
        }
        const receipt = received ? makeReceipt() : undefined
        messages.push({ ...clean, ...(receipt === undefined ? {} : { transport_receipt: receipt }) })
        if (clean.kind === 'report' && clean.reply_to !== undefined) {
          const receipt: NoteReceipt = { kind: parseReceipt(clean.text)!.kind, text: clean.text, by: `member:${clean.author.member_id}`, message_id: clean.reply_to, at: clean.at }
          for (const original of messages) if (original.id === clean.reply_to && original.project_id === clean.project_id) {
            original.deliveries = (original.deliveries ?? []).map(d => d.to !== clean.author.member_id ? d : { ...d, status: 'accepted', receipt, at: clean.at })
          }
          for (const task of data.tasks) if (task.project_id === clean.project_id) task.messages = (task.messages ?? []).map(m => m.id !== clean.reply_to ? m : { ...m, deliveries: (m.deliveries ?? []).map(d => d.to !== receipt.by ? d : { ...d, status: 'accepted' as const, receipt, at: clean.at }) })
        }
        data.lan_messages = messages.slice(-1000)
        await saveTasksFile(opts.file, data)
        return { ok: true, ...(receipt === undefined ? {} : { receipt }) }
      })
    },
    lanIdentity(): Promise<LanIdentity> {
      return enqueueWrite(async () => {
        const data = await loadForWrite()
        const have = sanitizeLanIdentity(data.lan_identity)
        if (have !== undefined) return have
        // 第一次要身份:现场发一个。member_id 是稳定 UUID,以后改名不换。
        const made = newLanIdentity()
        data.lan_identity = made
        await saveTasksFile(opts.file, data)
        return made
      })
    },

    saveLanIdentity(input: SaveLanIdentityInput) {
      return enqueueWrite(async () => {
        const name = input.name.trim()
        if (name === '') return { ok: false as const, reason: '名字不能是空的' }
        const data = await loadForWrite()
        const current = sanitizeLanIdentity(data.lan_identity) ?? newLanIdentity()
        const members = data.lan_members ?? []
        /*
         * 先查**已知**冲突(归一名):跟认得的成员重名,名单再不完整也是 409 冲突、说得出跟谁撞。
         * 不与任何认得的成员冲突、但名单不完整(有成员从没 refresh 过,远处可能坐着一个同名的人)
         * → 不动名,409 availability:'unknown'(契约 §5)。空注册表不拦 —— 无成员 = 无冲突。
         */
        const conflict = lanNameConflict(name, members)
        if (conflict !== undefined) {
          return { ok: false as const, reason: '名称与已知成员重复(归一后)', conflict_with: conflict }
        }
        if (lanMembersIncomplete(members, now() * 1000)) {
          return { ok: false as const, reason: '成员列表不完整,名称可用性未知', availability: 'unknown' as const }
        }
        if (input.expectedVersion !== undefined && input.expectedVersion !== current.version) {
          return { ok: false as const, reason: '版本对不上(有人刚改过),用回包里的当前副本重试', identity: current }
        }
        const at = stamp()
        const next = sanitizeLanIdentity({
          member_id: current.member_id, name,
          ...(input.avatar === undefined ? {} : input.avatar === null ? {} : { avatar: input.avatar }),
          version: current.version + 1,
          updated_at: at,
        }) as LanIdentity
        data.lan_identity = next
        await saveTasksFile(opts.file, data)
        return { ok: true as const, identity: next }
      })
    },

    async lanMembers(): Promise<LanMember[]> {
      return ((await readTasksFile(opts.file, readCache)).data.lan_members ?? []).map(member => lanMemberSnapshot(member, now() * 1000))
    },

    saveLanMembers(members: readonly LanMember[]) {
      return enqueueWrite(async () => {
        const data = await loadForWrite()
        const cleaned = members.map(sanitizeLanMember).filter((one): one is LanMember => one !== undefined)
        if (cleaned.length === 0) delete data.lan_members
        else data.lan_members = cleaned
        await saveTasksFile(opts.file, data)
        return true
      })
    },

    rememberLanMember(input: { memberId: string, name: string, host: string, port: number }) {
      return enqueueWrite(async () => {
        const data = await loadForWrite()
        const members = data.lan_members ?? []
        const have = members.find(one => one.member_id === input.memberId)
        // 按 member_id 归并:登记过的 reachable / last_seen 保留(那是 refresh 出来的事实,改名不丢)。
        const next = sanitizeLanMember({
          member_id: input.memberId, name: input.name, host: input.host, port: input.port,
          ...(have?.last_seen === undefined ? {} : { last_seen: have.last_seen }),
          ...(have?.reachable === undefined ? {} : { reachable: have.reachable }),
        })
        if (next === undefined) return false
        data.lan_members = [...members.filter(one => one.member_id !== input.memberId), next]
        await saveTasksFile(opts.file, data)
        return true
      })
    },

    /* —— 执行身份与恢复记录(2026-10-29 第一批第 1 步)。 —— */
    async readExecution(id: string): Promise<ExecutionRecord | undefined> {
      const read = await readTasksFile(opts.file, readCache)
      const task = read.data.tasks.find(one => one.id === id)
      if (task === undefined) return undefined
      return executionOf(task)
    },

    writeExecution(id: string, next: ExecutionRecord, expectedVersion: number) {
      return enqueueWrite(async () => {
        const data = await loadForWrite()
        const task = data.tasks.find(one => one.id === id)
        if (task === undefined) return false
        const current = executionOf(task)
        // 卡上还没有记录:只认 expectedVersion = 0 的那一下建记录,否则无从比较、不算成功。
        if (current === undefined) {
          if (expectedVersion !== 0) return false
          task.execution = { ...next, taskId: id, version: 1 }
        } else {
          if (current.version !== expectedVersion) return false
          task.execution = { ...next, taskId: id, version: expectedVersion + 1 }
        }
        await saveTasksFile(opts.file, data, 'execution')
        return true
      })
    },

    async unfinishedExecutions(): Promise<ExecutionRecord[]> {
      const read = await readTasksFile(opts.file, readCache)
      const out: ExecutionRecord[] = []
      for (const task of read.data.tasks) {
        const record = executionOf(task)
        // 结果不明一律带 reconcile 动作(restoreExecution 是纯投影,盘上仍是原版本)。
        if (record !== undefined && !isTerminalPhase(record.phase)) out.push(restoreExecution(record))
      }
      return out
    },

    rollbackGoals() {
      return enqueueWrite(async () => {
        const data = await loadTasksFile(opts.file)
        if (data.collab_migration === undefined) return { ok: false, goals: 0, tasks: 0 }
        const back = rollbackGoalMigration(data)
        await saveTasksFile(opts.file, back.data)
        return { ok: true, goals: back.goals, tasks: back.tasks }
      })
    },
  }
}
