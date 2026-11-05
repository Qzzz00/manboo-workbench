/**
 * 「等你」的那一堆 —— 全工作台只有这一个函数数它(2026-09-25,卡 M 追加)。
 *
 * 维护者的硬规矩:「同一件事的数字各处一致」。以前四处各数各的:球下「等你 7」、那一区「还有 2 件要你看」、
 * 手机「等你确认 8」、汇报条「等我确认 6 件」—— 同一刻四个数。现在:
 *   - 服务端拼 /state 时用它算好放进 `state.waiting`(手机只读这一格,不自己数);
 *   - 电脑上球下「等你 n」、那一区「还有 N 件要你看」/「要你看的 N 件」、「事务官」标签上的数与气泡、汇报条,
 *     都读 `state.waiting`(老服务没给这一格时用同一个函数就地算)。
 *
 * 这一堆是什么:**只有他能做的三样**(统筹 09-25 定义)——
 *   - 要他答:事务官在会话里问他的(每一问算一件);
 *   - 要他批:要他批的操作(每一条算一件)、等他点头的单子、等他点头的提议(做个小工具 / 改布局 / 固化下来);
 *   - 要他验收:办完了等他确认的事项(七态里的「等我确认」,收件箱里 kind=confirm 那几条)。
 *   - 要他定(卡 O,统筹 09-25:「阻塞·等你输入」属于只有他能做的就进这一堆):写代码的活派不出去(Claude 命令行没登录 → 登录 / 换一家)、
 *     做到一半到了花费 / 时长上限先停下来了(继续 / 停掉 / 换一家)。同一件已经有一问挂在外层(卡 M 的提问)就不再算一次。
 *     「事务官自己做」那一项 2026-09-28(卡 BS2,设计 C1)拿掉了 —— 事务官不干活。
 * 不算的:「额度还差一步」「还差一个授权」这类装配提醒(不是哪件事停着在等他)、单子落好之后那张回执、正在落的单子(他已经点过头)。
 *
 * 放在 src/ 根上(不在 client/ 里):服务端 import 不了客户端(同 protocol.ts 的 isItemExecuting)。
 */
import type { ApprovalOptionView, PendingApprovalView, PendingQuestionView, SessionView, WaitingItemView, WaitingView, WorkbenchState } from './protocol.ts'
import { DISPATCH_FAMILY_TITLES, registryOnlySession, ownerAskOf } from './protocol.ts'
// 「这条会话」这件事的键只有一处定法(2026-10-03,卡「两条接缝」),见 server/jobKey.ts 文件头。
import { sessionJobId } from './server/jobKey.ts'

/** 截短(按码点),超了加「…」。 */
export function clip(text: string, max: number): string {
  const chars = [...text]
  return chars.length <= max ? text : `${chars.slice(0, max).join('')}…`
}

/** 「这件事」怎么称呼:事项标题截短加书名号;查不到卡就说「事务官」。 */
export function askSubject(taskTitle: string | undefined, max = 16): string {
  const title = taskTitle?.trim() ?? ''
  return title === '' ? '事务官' : `「${clip(title, max)}」`
}

/** 收成一行:「「这个有点问题…」问你:派活前对一遍」。 */
export function questionRowText(question: PendingQuestionView): string {
  const first = question.questions[0]
  const what = first?.header ?? clip((first?.question ?? '').split('\n').find(line => line.trim() !== '') ?? '', 24)
  return `${askSubject(question.task_title)}问你:${what}`
}

/** 收成一行:「「这个有点问题…」要你批:要开一个看不见的浏览器…」。 */
export function approvalRowText(approval: PendingApprovalView): string {
  const what = approval.say ?? approval.reason ?? approval.tool
  return `${askSubject(approval.task_title)}要你批:${clip(what, 28)}`
}

/**
 * 派活那一张批准卡的**脸**(2026-09-28,卡 UX;维护者原话:「那个允许这一次,我点了,但是他发给了 Claude」)。
 *
 * 出事的那一张:正文一整面各家额度(Claude 28% / Muse 97% / Codex 46% / 豆包 99%…),
 * 「哪件事、派给谁」只在最上面一小行灰字 —— 他以为批的是列表里第一行那件事。
 * 现在**大字第一行就是这一问**:「把「验证自我迭代能力」派给 Claude?」;
 * 各家额度默认收起成一行,只显示被选中那家的;「允许」那颗键上带着对象。
 *
 * 电脑与手机各写一份界面,**这一份字只有一处**(手机那边照抄进 butler-app/src/asks/asksModel.ts,
 * 两个目录互不 import —— 同 askSubject 的先例)。
 */
export interface DispatchApprovalFace {
  /** 大字第一行。不是派活那一问时就是原来那句 `say ?? reason ?? tool`。 */
  headline: string
  /** 这次问的那一家(缺席 = 这张不是派活那一问,界面照旧)。 */
  chosen?: ApprovalOptionView
  /** 也能做这件活的其余几家(默认收起)。 */
  others: readonly ApprovalOptionView[]
  /** 收起来那一行:「其他可选:Codex / 豆包」。没有别家时缺席。 */
  othersLine?: string
  /** 「允许」那颗键上的字:带着对象。 */
  yes: string
}

/** 这一家在卡上怎么称呼(选项里只有别家 —— 卡 BS2 拿掉了「事务官自己做」)。 */
export function approvalOptionName(option: Pick<ApprovalOptionView, 'family' | 'title'>): string {
  return option.title
}

export function dispatchApprovalFace(approval: PendingApprovalView): DispatchApprovalFace {
  const say = approval.say ?? approval.reason ?? approval.tool
  const options = approval.options ?? []
  const chosen = options.find(one => one.chosen === true)
  if (chosen === undefined) return { headline: say, others: [], yes: '允许这一次' }
  const others = options.filter(one => one !== chosen)
  const name = approvalOptionName(chosen)
  // 查不到卡时说「这件事」(`askSubject` 那时回的是「事务官」,放这句里就成了「把事务官派给 Claude?」)。
  const what = (approval.task_title ?? '').trim() === '' ? '这件事' : askSubject(approval.task_title, 20)
  return {
    headline: `把${what}派给 ${name}?`,
    chosen,
    others,
    ...(others.length === 0 ? {} : { othersLine: `其他可选:${others.map(approvalOptionName).join(' / ')}` }),
    yes: `允许派给 ${name}`,
  }
}

/** 办完了等他确认的那一件怎么说。 */
export function confirmRowText(title: string): string {
  return `${askSubject(title)}办完了,等你确认`
}

/** 那一家叫什么(会话来源按字符串处理:认得的用名字,认不得的原样用 id —— 不另立「是哪几家」的名单)。 */
export function sessionAgentName(agent: string): string {
  return (DISPATCH_FAMILY_TITLES as Readonly<Record<string, string>>)[agent] ?? agent
}

/**
 * 在等他哪一类 → 一句人话的开头(维护者 09-25:「用一句人话说清是哪家在等、等他做什么」)。
 * 舞台上那张卡(卡 ST)也念这一份 —— 卡上家的名字就在旁边,所以那里只取「在等你选」这一截,不重复写家名。
 */
export const SESSION_ASK_HEAD: Readonly<Record<NonNullable<SessionView['ask']>['kind'], string>> = {
  choose: '在等你选',
  approve: '在等你点头',
  do: '在等你动手',
  review: '在等你看',
}

/**
 * 一条「在等他」的会话要的最少那几格。`agent` **按字符串**(卡 P 的规矩):登记表里运行时新接上的一家
 * (Grok Bot、Antigravity……)id 是它的包标识,不在 `AgentId` 那四家的闭集里。`SessionView` 天然对得上。
 */
export type AskingSession = {
  agent: string
  ask?: SessionView['ask']
  /**
   * 这一家在界面上叫什么(2026-09-26,卡 WS):**登记表里的名字**。缺席才按 `sessionAgentName` 从
   * `DISPATCH_FAMILY_TITLES` 那张表查 —— 而运行时接上的一家(Grok Bot、Antigravity)不在那张表里,
   * 查不到就把 `com.anysphere.sand` 这种包标识摆到他眼前(「Grok Bot 在等你选」才是人话)。
   */
  name?: string
}

/** 在等他的是哪一个:「Claude」;是它底下的子任务(后台任务)就说「Claude 的子任务「整理测试」」(设计第六节:子任务挂在主会话卡里)。 */
export function sessionAskWho(session: AskingSession): string {
  const name = session.name?.trim() || sessionAgentName(session.agent)
  const child = session.ask?.child
  if (child === undefined) return name
  const title = child.title?.trim() ?? ''
  return `${name} 的子任务${title === '' ? '' : `「${clip(title, 12)}」`}`
}

/** 「Codex 在等你选」「Claude 在等你点头」「Claude 的子任务「整理测试」在等你点头」(卡片抬头、气泡里那一行的开头)。 */
export function sessionAskHead(session: AskingSession): string {
  const who = sessionAskWho(session)
  const gap = /[A-Za-z0-9]$/.test(who) ? ' ' : ''
  return session.ask === undefined ? `${who}${gap}在等你` : `${who}${gap}${SESSION_ASK_HEAD[session.ask.kind]}`
}

/**
 * 别家的会话在等他(卡 T):一句人话 ——「Codex 在等你选:用方案 A 还是 B」「Claude 在等你点头:要不要合进 main」
 * 「Kimi 在等你动手:在系统设置里勾上辅助功能」「Codex 在等你看:参赛网页逐屏文案稿」。
 * 问题那一句服务端(waitingForYou.ts)已经洗过、截过;**不贴对方原文**(原话只在卡上「它的原话」里点开看)。
 */
export function sessionAskRowText(session: AskingSession): string {
  const head = sessionAskHead(session)
  const ask = session.ask
  if (ask === undefined) return head
  const what = clip(ask.question.replace(/在等你审$/, '').replace(/[。.]$/, ''), 28)
  return `${head}:${what}`
}

const SESSION_ASK_VERB: Readonly<Record<NonNullable<SessionView['ask']>['kind'], WaitingItemView['verb']>> = {
  choose: '答',
  approve: '批',
  do: '做',
  review: '审',
}

/** 等他点头的单子怎么说(引导落地那一张)。 */
export const PLAN_ROW_TEXT = '「我照你说的摆好了」等你点头'

/* ─────────────── 「等你」只放他不点头就卡住的事(2026-09-27,卡 WY) ─────────────── */

/**
 * 维护者 2026-09-27 原话:「为什么叫等你,是因为**这件事我不点头,不给反馈就卡住**,
 * 而其他的事项是做完了告知我,所以本来就是只放我做判断的部分。」
 *
 * 这句把设计 `docs/设计-等你清单只放真要他判断的事-2026-09-26.md` 第五节 A/B/C 一并定了。
 * 「等你」只收三种(都是他不动那件事就真的停在那儿):
 *   - **验收**:他派出去的活回来了、且事务官核过标了四类拍板请求(带方案与依据,2026-10-26 卡
 *     「事务官页接管队列」)——没标的那几件是事务官待核验队列,不摊给他,未知不自动放行;
 *   - **批**:他发起的动作要他点头才能继续(权限弹窗、等他点头的单子、要做的小工具 / 改布局);
 *   - **答 / 定**:别家 Agent 明确对他问的那一问、派不出去 / 到上限停下来的那一件。
 *
 * **事务官自己的主动提议不进这一堆**,改走「做完告知」那一路(开工汇报 / 下班例程 / 事项卡上的状态):
 *   - 派单提议(`dispatch:<事项 id>`,「这张派给 Claude 开工?」);
 *   - 进度核对要他说一句(`progress:<事项 id>` / `progress:access`);
 *   - 证据里冒出来的「待排」卡(`origin:'evidence'` + `backlog`,从前标题写成「要加上吗:…」)。
 * 它们本身**没被撤掉**(事务官那一页照旧摆得出、答得了),只是不再占「等你」、不再让座机响。
 *
 * 边界(09-27 一并定):小工具 / 改布局那两条提议**留在「等你」** —— 那是他自己开口要的东西,
 * 他不点头它就不做;自进化的「要不要固化下来」同理挂在他这里,数量天然只有一条。
 */
export const BUTLER_PROPOSAL_ASK_PREFIXES: readonly string[] = ['dispatch:', 'progress:']

/** 这一问是不是事务官自己的提议(按外层提问的 `session_id` 前缀认,同 butlerAsks.ts 的 `ASK_TASK_PREFIXES`)。 */
export function isButlerProposalAsk(sessionId: string | undefined): boolean {
  const id = sessionId ?? ''
  return BUTLER_PROPOSAL_ASK_PREFIXES.some(prefix => id.startsWith(prefix))
}

/** 从前那个问句标题。新造的卡不再这么写(标题只许名词短语),老账上挂着的照这条撤出来。 */
export const PROPOSAL_TITLE_PREFIX = '要加上吗:'

/** 收件箱里这一条是不是「证据里冒出来、等他点头要不要加」的那种(不是办完了等他验收的)。 */
export function isProposalConfirmItem(item: { kind: string, title?: string, status?: string }): boolean {
  if (item.kind !== 'confirm') return false
  return item.status === 'backlog' || (item.title ?? '').startsWith(PROPOSAL_TITLE_PREFIX)
}

/** 老服务端算好的那一份里,这一行是不是该撤出去的(只能按那一行的话认 —— 那边只发了文字)。 */
const STALE_WAITING_TEXTS: readonly RegExp[] = [
  /问你:进度要你说一句/,
  /要你批:这张派给/,
  /^「要加上吗:/,
]

/**
 * 把一份算好的「等你」里不该在的撤出来(2026-09-27,卡 WY)。
 *
 * 为什么要这一道:他机器上此刻正挂着这类条目(09-26 晚手机首页与座机上那两条「进度要你说一句」),
 * 服务端换新之前两端读到的还是老那一份 —— **不该要他手动清**。一条都没撤时原样返回同一个对象,
 * 「两端读同一份账」这条规矩不因为多了一道筛子而破。
 */
export function blockingOnly(view: WaitingView): WaitingView {
  const items = view.items.filter(item => !STALE_WAITING_TEXTS.some(re => re.test(item.text)))
  return items.length === view.items.length ? view : { count: items.length, items }
}

export type WaitingSource = Pick<WorkbenchState, 'questions' | 'approvals' | 'materialize' | 'dev_tool' | 'layout_ask' | 'evolve' | 'butler_inbox'>
  & Partial<Pick<WorkbenchState, 'sessions' | 'tasks' | 'agent_registry'>>

/**
 * 停着在等他的**那几条会话**(2026-09-26,卡 WS)。两路合起来,不重不漏:
 * - `state.sessions`:有会话文件的那几家(Claude / Codex / Kimi),`ask` 由 `overlayWaiting` 叠好;
 * - 登记表里 `via: 'window'` 的那几条:**读窗口读出来的**窗口型 Agent(Grok Bot、Antigravity、Muse……),
 *   `ask` 由 `waitingService.askOf` 判好、`agentRegistry.windowSession` 挂上。
 *
 * **只取 `via: 'window'` 那几条**:登记表里文件型那几家的会话是 `state.sessions` 的副本(`feedSession`),
 * 两边都数就成了双份。老服务端没有登记表时这一路是空的,行为与从前一字不差。
 */
function waitingSessions(state: WaitingSource): (AskingSession & { session_id: string })[] {
  const out: (AskingSession & { session_id: string })[] = []
  for (const session of state.sessions ?? []) out.push(session)
  for (const entry of state.agent_registry?.entries ?? []) {
    // 名字从登记表来:那几家的 id 是包标识,`sessionAgentName` 查不到它。
    for (const session of entry.sessions) if (registryOnlySession(session)) out.push({ ...session, name: entry.name })
  }
  return out
}

/**
 * 要他定的那一件怎么说(卡 O):派不出去 / 到上限停下来了。**一句定死的短话**(不截那家的原因:截到半截的原因比不说还难懂),
 * 原因与那几颗键在点开之后的卡上。
 */
export function decideRowText(task: { title: string, dispatch_block?: { family: string, fix?: { kind: string } }, budget?: { state: string } }): string {
  const block = task.dispatch_block
  if (block !== undefined) {
    const who = (DISPATCH_FAMILY_TITLES as Readonly<Record<string, string | undefined>>)[block.family] ?? block.family
    return block.fix?.kind === 'login_cli'
      ? `${askSubject(task.title)}派给 ${who} 还差一步,要你接上或者先交给别家`
      : `${askSubject(task.title)}派不出去,要你定交给谁`
  }
  return `${askSubject(task.title)}到上限先停下来了,继续还是停`
}

/**
 * 这件事身上挂着哪几条会话(2026-09-28,卡 RC):派活认上的那一条、关联窗口那几条、事项自己那一条。
 * 「一件事一条」靠它:这几条会话的 ask 不再另算一条。
 */
export function sessionIdsOfTask(task: {
  conversation?: { session_id: string }
  client_dispatch?: { session_id?: string }
  links?: readonly { session_id: string }[]
}): string[] {
  const out: string[] = []
  if (task.conversation !== undefined) out.push(task.conversation.session_id)
  if (task.client_dispatch?.session_id !== undefined) out.push(task.client_dispatch.session_id)
  for (const link of task.links ?? []) out.push(link.session_id)
  return out
}

/**
 * 算「等你」的那一堆。顺序就是两端摆的顺序:问你的 → 要你批的 → **别家会话在等你的**(卡 T)→ 单子 → 提议 → 办完了等你确认的
 * (越靠前越急:前几样那件事正停着等他,最后一样事情已经办完了)。
 */
export function waitingOnHim(state: WaitingSource): WaitingView {
  const items: WaitingItemView[] = []
  for (const question of state.questions ?? []) {
    // 事务官自己的提议(派单提议 / 进度要你说一句)不进这一堆:它不点头也没有谁停着(卡 WY)。
    if (isButlerProposalAsk(question.session_id)) continue
    items.push({ key: `question:${question.id}`, kind: 'question', verb: '答', text: questionRowText(question), ...(question.task_id === undefined ? {} : { task_id: question.task_id }) })
  }
  // 要他定的(卡 O):派不出去、到上限停下来了。那件事已经有一问挂在外层(到上限走的就是卡 M 的提问)就不再算一次。
  const asked = new Set((state.questions ?? []).map(question => question.task_id).filter((id): id is string => id !== undefined))
  /**
   * ★ **一件事一条**(2026-09-28,卡 RC):派出去的那条对话最后在问他 → 事项进「阻塞 · 等你输入」、
   * 要他定的那一句写在卡上。那条会话的 ask 就**不再另算一条** —— 09-28 上午他看到的正是
   * 「办完了等你确认」+ 另一条孤立的「Claude 在等你点头:落在哪…」,同一件事摆了两条、两条都不完整。
   * 这里把那条会话记下来,下面数会话 ask 时跳过它。
   */
  const mergedSessions = new Set<string>()
  for (const task of state.tasks?.tasks ?? []) {
    if (task.status === 'done' || task.status === 'canceled' || asked.has(task.id)) continue
    const blocked = task.status === 'blocked' && task.dispatch_block !== undefined
    const paused = task.budget?.state === 'paused'
    // 「阻塞 · 等你输入」:那家答完了最后在问他(卡 MS / 卡 RC)。卡上那句话就是要他定的那一句。
    const askingBack = task.status === 'blocked' && task.block_reason === 'input' && (task.note ?? '').trim() !== ''
    if (askingBack) {
      for (const id of sessionIdsOfTask(task)) mergedSessions.add(id)
      items.push({ key: `decide:${task.id}`, kind: 'decide', verb: '答', text: `${askSubject(task.title)}:${clip((task.note as string).trim(), 40)}`, task_id: task.id })
      continue
    }
    if (!blocked && !paused) continue
    items.push({ key: `decide:${task.id}`, kind: 'decide', verb: '答', text: decideRowText(task), task_id: task.id })
  }
  for (const approval of state.approvals ?? []) {
    // 事务官自己的提议(「这张派给 X 开工?」)不进这一堆(卡 WY;判据从认那句话改成认 `proposal` 那一格,2026-09-28 卡 UX)。
    if (approval.proposal === true) continue
    items.push({ key: `approval:${approval.id}`, kind: 'approval', verb: '批', text: approvalRowText(approval), ...(approval.task_id === undefined ? {} : { task_id: approval.task_id }) })
  }
  // 别家的会话停着在等他(卡 T;服务端叠好的 `ask`)。事务官自己的会话不在这里 —— 她问他的走上面那两样,已经数过了。
  // 两路:会话文件那几家 + 读窗口读出来的窗口型那几家(卡 WS),见 {@link waitingSessions}。
  for (const session of waitingSessions(state)) {
    if (session.agent === 'dsh' || session.ask === undefined) continue
    // 这条会话就是上面那件事(派出去的那条对话)——同一件事只摆一条(卡 RC)。
    if (mergedSessions.has(session.session_id)) continue
    items.push({ key: sessionJobId(session.agent, session.session_id), kind: 'session', verb: SESSION_ASK_VERB[session.ask.kind], text: sessionAskRowText(session) })
  }
  const plan = state.materialize
  if (plan !== undefined && plan.status === 'pending') {
    items.push({ key: `laid:${plan.id}`, kind: 'plan', verb: '批', text: PLAN_ROW_TEXT })
  }
  for (const proposal of state.dev_tool?.pending ?? []) {
    items.push({ key: `dev:${proposal.id}`, kind: 'proposal', verb: '批', text: `要做个小工具:${clip((proposal.restate || proposal.request).trim(), 40)}` })
  }
  for (const ask of state.layout_ask?.pending ?? []) {
    items.push({ key: `layout:${ask.id}`, kind: 'proposal', verb: '批', text: `要改布局:${clip((ask.restate || ask.request).trim(), 40)}` })
  }
  for (const proposal of state.evolve?.pending ?? []) {
    items.push({ key: `evolve:${proposal.id}`, kind: 'proposal', verb: '批', text: clip(proposal.ask.replaceAll('**', '').trim(), 48) })
  }
  // 办完了等他验收的那一档(卡「事务官页接管队列」2026-10-26 收窄):**只有事务官核过、标了四类拍板请求
  // (带方案与依据)的那几件才进「等你」**;没带的是事务官待核验队列,不摊给本人(未知不自动放行)。
  // 判据唯一:`protocol.ts` 的 `ownerAskOf`,协作区「现在等你」、冲刺条「等我确认」同一处读它。
  const taskById = new Map((state.tasks?.tasks ?? []).map(task => [task.id, task]))
  for (const item of state.butler_inbox?.items ?? []) {
    if (item.kind !== 'confirm') continue
    // 「待排」那几张(证据里冒出来的下一步)是提议,不是办完了等他验收(卡 WY)。
    if (isProposalConfirmItem(item)) continue
    const taskId = item.task_id ?? item.id
    // 快照里找得到卡就用唯一判据;找不到(老快照没有任务表)照旧摆 —— 旧服务端行为一字不变。
    const task = taskById.get(taskId)
    if (task !== undefined && ownerAskOf(task) === undefined) continue
    items.push({ key: `confirm:${taskId}`, kind: 'confirm', verb: '验收', text: confirmRowText(item.title), task_id: taskId })
  }
  return { count: items.length, items }
}

/** 两端读的那一份:服务端给了就用它(手机与电脑同一份),老服务没给就用同一个函数就地算。 */
export function waitingOf(state: WaitingSource & Pick<WorkbenchState, 'waiting'>): WaitingView {
  // 老服务端给的那一份里可能还挂着事务官自己的提议:读的时候撤掉(卡 WY),不要他手动清。
  return state.waiting === undefined ? waitingOnHim(state) : blockingOnly(state.waiting)
}
