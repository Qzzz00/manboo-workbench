/**
 * 声纹球与两侧卡片堆的纯函数(2026-09-11,Ben 拍板:「点到事务官的时候,就留中间一个圆球
 * 就好了,然后事项在旁边堆几个卡片」;设计见 docs/设计-事务官完整材料.md §5.1 与附录 A3)。
 *
 * 组件(ButlerInbox.tsx / Orb.tsx)只管画,判断全在这里——球是什么状态、下面那一行写什么、
 * 一堆卡片露几张、每张卡的点是什么颜色,都是可单测的纯函数(先例:client/butlerInbox.ts)。
 *
 * 不编数(D13):「在办 n · 等你 m」两个数任一取不到,整行不显示;卡上的项目名查不到就不带。
 */
import type { ButlerInboxItem, ButlerInboxAgent, ButlerInboxHabit, ButlerInboxTopic, TaskView, WorkbenchState } from '../protocol.ts'
import { BUTLER_NO_SESSION_NOTE, STATUS_TITLES, WAIT_REASON_TITLES, taskWaitLabel } from '../protocol.ts'
import { mineGroups } from './butlerInbox.ts'
// 「等你」那一堆全工作台一份(卡 M 的 waitingOnHim / waitingOf)。卡 V 2026-09-25:球这儿也读它。
import { waitingOf } from '../waiting.ts'
import type { Proposal } from './proposals.ts'

/**
 * 球的四态(设计 §5.1 的表):待命=静止微呼吸;聆听=外圈随输入起伏;在办=缓慢脉动;
 * 需要你=转琥珀色。本期电脑没有收音,「聆听」= 输入框聚焦或有字。
 */
export type OrbState = 'idle' | 'listening' | 'busy' | 'needs-you'

export const ORB_STATE_TITLES: Record<OrbState, string> = {
  'idle': '待命',
  'listening': '聆听',
  'busy': '在办',
  'needs-you': '需要你',
}

export interface OrbSignals {
  /** 有「等我确认」的卡。 */
  needsYou: boolean
  /** 输入框聚焦或有字。 */
  listening: boolean
  /** 有我交给它、还没办完的事项。 */
  busy: boolean
}

/**
 * 四态映射,优先级写死:需要你 > 聆听 > 在办 > 待命。
 * 「需要你」压过一切——它是纯净模式里唯一的提示(Ben 09-11),不能被"正在打字"盖掉。
 */
export function orbState(signals: OrbSignals): OrbState {
  if (signals.needsYou) return 'needs-you'
  if (signals.listening) return 'listening'
  if (signals.busy) return 'busy'
  return 'idle'
}

/**
 * 有没有事停着在等他 —— 球变琥珀色的唯一依据。
 *
 * **2026-09-25(卡 V;统筹在升级评估里顺手发现的,正是「各处一个数」这件事)**:这里原来只数收件箱里
 * `kind: 'confirm'` 那一类,而「等你」那一堆(`src/waiting.ts` 的 `waitingOnHim`)是**三样**:
 * 要他答的、要他批的、要他验收的。于是他被问了一句话、或者有一条要他批的操作时,球**不变色** ——
 * 同一件事各处一个说法,正是维护者那条硬规矩(「同一件事的数字各处一致」)要治的。现在读同一份。
 */
export function needsYou(state: WorkbenchState): boolean {
  return waitingOf(state).count > 0
}

export interface OrbCounts {
  /** 在办:我交给事务官、还没办完的(待排/待办/进行中/阻塞)。 */
  working: number
  /** 等你:「等你」那一堆的件数 —— **与球下「等你 n」、汇报条、手机同一个数**(src/waiting.ts)。 */
  waiting: number
}

/**
 * 球下那一行的两个数。**tasks 或 butler_inbox 任一缺席就返回 undefined**——那说明任务板
 * 或收件箱没接上,这时候写「在办 0」是编数(0 会被读成"没事",而真相是"不知道")。
 *
 * 2026-09-25(卡 V):`waiting` 改成读 `waitingOf(state)`(服务端算好的那一格,没给就用同一个函数就地算),
 * 不再自己数 `confirm` 一类。
 */
export function orbCounts(state: WorkbenchState): OrbCounts | undefined {
  if (state.tasks === undefined || state.butler_inbox === undefined) return undefined
  return {
    working: mineGroups(state.tasks).open.length,
    waiting: waitingOf(state).count,
  }
}

export function orbCountsLine(counts: OrbCounts): string {
  return `在办 ${counts.working} · 等你 ${counts.waiting}`
}

/** 一堆最多露几张,其余折成「还有 n 件」(附录 A3:「最多露三张,再多折成还有 n 件」)。 */
export const STACK_VISIBLE_MAX = 3

export function foldStack<T>(items: readonly T[], max = STACK_VISIBLE_MAX): { shown: T[], rest: number } {
  return { shown: items.slice(0, max), rest: Math.max(0, items.length - max) }
}

/**
 * 卡上的状态点(与窗位叠标签的徽章同一套色义):
 * 白=在办(进行中)、黄=要我看一眼(等审批/等输入/哨兵命中/排期赶不上/阻塞)、
 * 蓝=办完待我验收(等我确认)、灰=还没动/已结束/待拍板。
 */
export type CardDot = 'white' | 'yellow' | 'blue' | 'gray'

export interface StackCard {
  id: string
  kind: 'inbox' | 'mine' | 'proposal'
  title: string
  /** 项目名/上下文一句(查得到才带)。 */
  context?: string
  dot: CardDot
  /** 状态字(七态里的那一格,或「待拍板」)。 */
  label?: string
  /** 等待原因的中文。 */
  waitLabel?: string
  /** 补一句(「会话未开」「会话已归档」「1 件交付物」)。 */
  note?: string
  /** 发生/最后改动的时刻(ISO)。没有就没有。 */
  at?: string
  /** 点得开的会话。没有就画成静态卡。 */
  sessionId?: string
  /** 「等我确认」卡的 task_id——有它才画确认键。 */
  confirmTaskId?: string
  /**
   * 选题建议那一档带回来的几样(2026-09-22)。**有它才画「加入选题池 / 不要」两颗键**;
   * 别的卡上不会有(服务端只给 `kind:'topic'` 的条目填,见 protocol.ButlerInboxItem.topic)。
   */
  topic?: ButlerInboxTopic
  /**
   * Agent 登记表那一档(2026-09-25,卡 Q)。**有它才画「接上 / 知道了 / 这不是 Agent」那几颗键**;
   * 服务端只给 `kind:'agent'` 的条目填。
   */
  agent?: ButlerInboxAgent
  /** 会议那一档(2026-10-09)。`retryable` 在才画「重新整理」(服务端只给 `kind:'meeting'` 的条目填)。 */
  meeting?: { id: string, retryable?: true, ask_outcome?: string }
  /** 「新学到一条」那一档(2026-10-10)。**有它才画「撤掉 / 知道了」**;服务端只给 `kind:'habit'` 的条目填。 */
  habit?: ButlerInboxHabit
}

export function inboxCard(item: ButlerInboxItem): StackCard {
  return {
    id: item.id,
    kind: 'inbox',
    title: item.title,
    ...(item.note === undefined ? {} : { note: item.note }),
    dot: item.kind === 'confirm' ? 'blue' : 'yellow',
    ...(item.status === undefined ? {} : { label: STATUS_TITLES[item.status] }),
    ...(item.wait_reason === undefined ? {} : { waitLabel: WAIT_REASON_TITLES[item.wait_reason] }),
    ...(item.at === undefined ? {} : { at: item.at }),
    ...(item.conversation === undefined ? {} : { sessionId: item.conversation.session_id }),
    ...(item.kind === 'confirm' && item.task_id !== undefined ? { confirmTaskId: item.task_id } : {}),
    ...(item.kind === 'topic' && item.topic !== undefined ? { topic: item.topic } : {}),
    ...(item.kind === 'agent' && item.agent !== undefined ? { agent: item.agent } : {}),
    ...(item.kind === 'meeting' && item.meeting !== undefined ? { meeting: item.meeting } : {}),
    ...(item.kind === 'habit' && item.habit !== undefined ? { habit: item.habit } : {}),
  }
}

function mineDot(task: TaskView): CardDot {
  if (task.status === 'doing') return 'white'
  if (task.status === 'blocked') return 'yellow'
  return 'gray'
}

export function mineCard(task: TaskView, projects: readonly { id: string, name: string }[] = []): StackCard {
  const sessionId = task.conversation?.session_id
  const project = task.project_id === undefined ? undefined : projects.find(p => p.id === task.project_id)
  // 服务端记在卡上的那句话优先(2026-09-16):「你停了它」「会话未开」「出错原话」——它比这里推断的更具体。
  // 看板上写了负责人的那种事项(2026-09-25 卡 N,不是他交给事务官的):本来就没有事务官那条会话,不写「会话未开」,
  // 写「现在该谁动」那一句(「等你点头派给 Codex」「你来 · 截止 9/28」「等同事 · 9/29 回来写」)。
  const note = task.note ?? (task.direction !== 'mine'
    ? task.mover?.line
    : sessionId === undefined
      ? BUTLER_NO_SESSION_NOTE
      : task.conversation?.archived_at === undefined ? undefined : '会话已归档')
  return {
    id: task.id,
    kind: 'mine',
    title: task.title,
    ...(project === undefined ? {} : { context: project.name }),
    dot: mineDot(task),
    label: STATUS_TITLES[task.status],
    ...(taskWaitLabel(task) === undefined ? {} : { waitLabel: taskWaitLabel(task) as string }),
    ...(note === undefined ? {} : { note }),
    at: task.updated_at,
    ...(sessionId === undefined ? {} : { sessionId }),
  }
}

/** 提议(PRD §5.6):灰点、待拍板。门槛已经在 proposals.ts 过了,这里只画。 */
export function proposalCard(proposal: Proposal): StackCard {
  return { id: `proposal:${proposal.id}`, kind: 'proposal', title: proposal.text, dot: 'gray', label: '待拍板' }
}

/** 左堆「事务官交给我的」:收件箱四档(服务端已按优先级排好,原样)+ 提议排在后面。 */
export function leftStack(state: WorkbenchState, proposals: readonly Proposal[]): StackCard[] {
  return [
    ...(state.butler_inbox?.items ?? []).map(inboxCard),
    ...proposals.map(proposalCard),
  ]
}

/** 右堆「我交给事务官的」:在办在前、办完在后,各自从新到旧(mineGroups 已排好)。 */
export function rightStack(state: WorkbenchState, projects: readonly { id: string, name: string }[] = []): StackCard[] {
  const groups = mineGroups(state.tasks)
  return [...groups.open, ...groups.finished].map(task => mineCard(task, projects))
}

/** 卡上的时刻,HH:MM;解析不出来就不显示。 */
export function cardTime(iso: string | undefined): string | undefined {
  if (iso === undefined) return undefined
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return undefined
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

/**
 * 「进行中 · 12 分钟」里那一段(2026-09-16 第 4 条):从 `fromIso` 到 `nowIso` 过了多久。
 * 不到 1 分钟说「刚开始」;整分钟;过 1 小时带小时。任一时刻解析不出、或 from 在 now 之后(时钟没对上)就不显示——不编。
 */
export function elapsedLabel(fromIso: string | undefined, nowIso: string): string | undefined {
  if (fromIso === undefined) return undefined
  const from = Date.parse(fromIso)
  const now = Date.parse(nowIso)
  if (Number.isNaN(from) || Number.isNaN(now) || now < from) return undefined
  const minutes = Math.floor((now - from) / 60_000)
  if (minutes < 1) return '刚开始'
  if (minutes < 60) return `${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0 ? `${hours} 小时` : `${hours} 小时 ${rest} 分钟`
}
