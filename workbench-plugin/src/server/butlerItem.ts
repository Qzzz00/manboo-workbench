/**
 * 「我交给事务官」的事项:建事项 = 建一张卡 + 在 DSH 里开一条会话,把事项文本作为
 * 第一条 user 消息发出去(一事项一会话,docs/设计-事务官形态-Siri式与手机.md §六 6.1)。
 *
 * 这个文件只有**纯函数与一个端口定义**:真正怎么开会话是 host 那边的事
 * (src/index.ts 用 DSH 的 sessionController 接线),HTTP 层只认这个端口。
 * 这样单测里注入一个桩就能把"开出来了""开不出来"两条路都走一遍,不用起 DSH。
 *
 * **开不出会话时事项照常建**(Ben 2026-09-10 的要求:不假装)。收件箱那一条会显示
 * 「会话未开」,状态留在待办——而不是伪装成"事务官在办"。这与 D13 是同一条:
 * 降级要如实说出来,不静默丢掉。
 */
import type { ComposerMode, TaskAssignee, TaskConversation, TaskView } from '../protocol.ts'
import type { ButlerBriefFacts } from './butlerBrief.ts'
import { butlerBriefBlock } from './butlerBrief.ts'
import type { ButlerEffort } from './butlerEffort.ts'
import type { ModelCatalogLike } from './composer.ts'
import { BUTLER_NO_SESSION_NOTE, DISPATCH_FAMILY_TITLES, isPersonAssignee } from '../protocol.ts'

export { BUTLER_NO_SESSION_NOTE }

/** 只按宿主错误 code 分类；会话确实不存在才允许旧的新建降级。 */
export function butlerSayFailureOf(error: unknown): 'model' | 'session' | 'host' {
  const code = (error as { code?: unknown } | null)?.code
  if (code === 'session/not-found') return 'session'
  if (code === 'model_alignment_failed' || code === 'session/model-unavailable') return 'model'
  return 'host'
}

/**
 * 开会话的端口。**绝不抛**是实现方的责任;HTTP 层这边仍然再兜一层 try/catch
 * (端口是外部实现,兜底不能只写在注释里)。
 */
export interface ButlerSessionOpener {
  /**
   * 开一条 DSH 会话并把 `firstMessage` 作为第一条 user 消息发出去。
   * 返回会话 id;开不出来返回 undefined(没有第二种表达"没开成"的方式)。
   */
  open: (firstMessage: string, extras?: ButlerOpenExtras) => Promise<string | undefined>
  /**
   * DSH 此刻能用的模型表(2026-09-24 统一输入框「模型」下拉)。拿不到回 undefined。缺席 = 老实现。
   */
  catalog?: () => Promise<ModelCatalogLike | undefined>
  /**
   * DSH 那头此刻接上了没(sessionController 注入进来了没)。给例程判「DSH 不在线就跳过」用:
   * 不在线 ≠ 开不出会话——前者是整条通道没有,跳过并记一条 note;后者是通道在但这次没开成,
   * 事项照建、如实标「会话未开」。缺席按「在线」处理(老实现只有 open 一个口)。
   */
  available?: () => boolean
  /**
   * 往一条**已经开着的**会话里再说一句(2026-09-16,手机端引导:用户在手机上打的字 / 说的话)。
   * 回 true = 模型对齐后排进原会话;false = 会话或模型未就绪,未发送。缺席 = 老实现,只能开不能续。
   * onRejected 按本次调用区分 model/host,供消费者准确报告;会话不存在仍只回 false。
   * 2026-10-26(卡「事务官机制A」)第四参:缺省 `{mode:'queue'}`(旧调用逐字不变);
   * 'steer' = 打断正在跑的轮次、这句在最近的 step 进(改方向 / 加速);撤回先走 cancel 再清队列、不进会话。
   * `taskId` 给了就嵌进 requestId(`workbench-<taskId>-<uuid>`,落盘为 source.rpcId)——
   * 清队列按它**精确**认这条事项自己的句,不靠前缀猜;别的事项与旧格式的句一律保留。
   */
  say?: (
    sessionId: string,
    text: string,
    onRejected?: (reason: 'model' | 'host') => void,
    opts?: { mode?: 'queue' | 'steer', taskId?: string },
  ) => Promise<boolean>
  /**
   * 这条会话此刻在不在跑(2026-10-26,卡「事务官机制A」):回执里「打断 / 没在跑」要照实说。
   * true/false = 在跑 / 没在跑;undefined = 读不出来(老宿主),不许编。
   */
  running?: (sessionId: string) => boolean | undefined
  /**
   * 清掉这条会话队列里**这条事项自己**、还没被执行的整句(2026-10-26,卡「事务官机制A」):
   * 改方向 / 撤回前先把这条事项的旧队列作废(旧队列不复活),**同会话里别的事项的句子和
   * 没有事项号的旧格式句(workbench-<uuid>)一律保留**;被作废句子的原文进 `removed` —
   * 调用方留在卡上,一句不丢。
   *
   * 返回真结果(区别于能力缺席):`removed`=真摘掉,`remaining`=想摘没摘成(updateQueue
   * 中途抛错),`incomplete`=没摘干净 —— 调用方据 incomplete 拒发(stale-queue),但回执必须
   * 照实说摘掉了几句、几句没动,已摘的原文照样留卡(重试只清剩下的,重启动安全:证据在卡上)。
   * `refused:'evidence'` = 动手前先留证没写进卡,**一条都没摘**(队列原样,原文在 remaining 里)。
   * undefined = 这版宿主读不动投影 / 没有 updateQueue —— 调用方据此拒发,不静默。
   */
  clearQueued?: (
    sessionId: string,
    taskId: string,
    /** 动手前把将要作废的原文写牢(durable);回 false / 抛错 = 证据没落盘,clearQueued 必须取消、一条不摘。 */
    evidence: (texts: readonly string[]) => Promise<boolean>,
  ) => Promise<ItemQueueClearResult | undefined>
  /**
   * 停掉一条会话**正在跑的这一回合**(2026-09-25,卡 O「停掉这一件」/ 到上限先停下来)。
   * 走的是 DSH `sessionController.cancel({ sessionId })` —— **DSH 底层页右下那颗停止键用的就是它**
   * (上游 `ui-conversation` 的 `conversation.cancel()` → `session.cancel`)。
   * 回 `running:false` = 那条会话这会儿本来就没在跑(没有要停的);`ok:false` = 停不了(会话不在 / 老宿主),`why` 是原因。
   */
  cancel?: (sessionId: string) => Promise<{ ok: boolean, running?: boolean, why?: string }>
  /**
   * 给一条**已在跑的**会话换 provider/model(2026-10-23 运行时 P1:模型设置变更后,
   * 把受控会话重指到新目标,同一会话接着聊)。走 DSH `sessionController.selectModel`
   * (`selectForNextRequest`,下一条请求生效,上游源码核实)。回 true = 换上了;
   * false = 没换成(模型此刻不可用 / 会话没了),不抛。缺席 = 老实现,不重指。
   */
  retarget?: (sessionId: string, provider: string, model: string) => Promise<boolean>
  /**
   * 往一条会话 say **之前**,把它的 provider/model 对齐到此刻的模型设置
   * (2026-10-23 运行时 P1 的竞态闭环):PUT /model 返回后立刻续聊,后台那次重指可能还没
   * 跑到、catalog 也可能没热加载完;DSH 重启后登记表是空的,carryOnTarget 却能接上历史会话。
   * 所以在 say 前对**这一条**再判一次,该搬先搬(selectModel)。
   * 失败会抛出并阻止发送；共用 say 自己也执行同一对齐契约，调用方不能绕过。
   */
  alignModel?: (sessionId: string) => Promise<void>
}

/**
 * 清队列的真结果(2026-10-26 验收修复,卡「事务官机制A」):部分失败也要把原文证据带回来,
 * 调用方照实回执、留卡;undefined 另表「整条能力缺席」,与本结果分开。
 * 证据先落盘、后动手:证据写不进时 opener 一条都不摘,以 `refused:'evidence'` 回来。
 */
export interface ItemQueueClearResult {
  /** 真摘掉的句子原文(一句不丢,调用方留在卡上)。 */
  removed: readonly string[]
  /** 想摘没摘成的句子原文(updateQueue 中途抛错,或证据被拒后保下来的全部原文);重试只清这些。 */
  remaining: readonly string[]
  /** true = 没摘干净:调用方拒发(stale-queue),回执照实说进度。 */
  incomplete: boolean
  /** 'evidence' = 动手前先留证没写进卡:**一条都没摘**(removed 为空、remaining 是保下的原文)。 */
  refused?: 'evidence'
}

/**
 * 开会话时顺带的三件(2026-09-24 统一输入框)。**每一件都是尽力而为**:
 * 模型切不过去、权限切不过去、图片被模型拒了 —— 会话照开、原话照发(图片在原话里另有路径),
 * 不因为一个附加项把他交代的事丢掉。
 */
export interface ButlerOpenExtras {
  /** 直接放进第一条消息的图片(模型能看图时才有)。 */
  images?: readonly { mediaType: string, data: string, name?: string }[]
  /** 模式 → 权限预设(+ 只出方案时进 /plan)。 */
  mode?: ComposerMode
  /** 这条会话用哪个模型(DSH 的 selectModel 同时把它记成默认 —— 维护者拍板:改默认)。 */
  model?: { provider: string, id: string }
  /**
   * 这条会话想多久(2026-09-28,卡 BS)。缺席 = 关。
   * **每条会话都明写**:`selectModel` 会顺手改全局默认,靠默认会把上一条的档漏给下一条。
   * 哪件事用哪档在 `butlerEffort.ts`。
   */
  effort?: ButlerEffort
}

/** 卡面标题的字数上限。超了就截断并把全文留在描述里——**一个字都不丢**。 */
const MAX_TITLE = 40

export interface ButlerItemFields {
  title: string
  /** 全文。标题已经等于全文时整个字段缺席(不存第二份一模一样的话)。 */
  desc?: string
}

/**
 * 一句话 → 一张卡的标题与描述。
 *
 * 收件箱底部那个输入框里 Ben 可能敲一句话,也可能贴一整段。标题只取第一行、超长截断
 * ——一整段话当标题,在收件箱里是一坨读不断句的黑字;但**全文必须留下**,
 * 那是他交代的事,截断只是显示上的事。
 */
export function butlerItemFields(text: string): ButlerItemFields {
  const full = text.trim()
  const firstLine = (full.split('\n')[0] ?? '').trim()
  const title = firstLine.length > MAX_TITLE ? `${firstLine.slice(0, MAX_TITLE)}…` : firstLine
  return { title, ...(full === title ? {} : { desc: full }) }
}

/**
 * 第一条 user 消息。
 *
 * 事项原文在前(那是他要说的话),我们的那一句在后——顺序反过来的话,模型先读到的是
 * 我们的交代,容易把它当成任务本身。附上事项 id 是为了将来在会话里能回指到这张卡。
 *
 * 读记忆那一句原来是「动手之前先按 SKILL.md 读一遍记忆」(docs/设计-事务官的主动性.md §四 A 案)。
 * 2026-09-23 改成**按需**(`fix/call-remember-direct`):12:39 那一通里一件「记一句话」的小事,
 * 会话照这句先把记忆索引、授权、决策记录、tasks.json 通读了一遍,约 30 次工具、35 万 token,
 * 把中转当天额度撞满。现在只指路、不命令通读;记忆怎么读写的规矩仍在 SKILL.md,一个字没动。
 * 内容由代码从固定模板拼出,**不经模型、不编**。
 */
export const BUTLER_MEMORY_HINT = '要背景时再按 .dsh/skills/记忆/SKILL.md 查跟这件事有关的那一条,别为它把记忆通读一遍;小事直接办。'

export function butlerFirstMessage(
  text: string,
  taskId: string,
  assignee?: TaskAssignee,
  tail?: string,
  facts?: ButlerBriefFacts,
): string {
  // 统一输入框(2026-09-24):模式那句、附件路径、引用拼在原话后面、我们的交代前面。
  const said = tail === undefined || tail === '' ? text.trim() : `${text.trim()}\n\n${tail}`
  /**
   * 2026-10-02(卡「事务官为什么要跑这么多步」):给了事实就摆事实,不再只给一个 id 让它自己查。
   * **缺席 = 老实现**(老宿主、既有用例):照旧 `(工作台事项 id)` + 按需读记忆那一句,一个字不变。
   * 为什么要改见 `butlerBrief.ts` 文件头:两件简单事 34 次工具调用、一次都不在干活。
   */
  const base = facts === undefined
    ? `${said}\n\n(工作台事项 ${taskId})${BUTLER_MEMORY_HINT}`
    : `${said}\n\n${butlerBriefBlock(facts)}`
  // 派给别家(2026-09-21):**点了名才加这一句**,而且只在真派得出去的那三家上加。
  // `dsh` = 它自己办,加一句「派给 DSH」只会让它去找一个不存在的命令行。
  if (assignee === undefined || assignee === 'dsh') return base
  // 负责人是人(他 / 同事 / 别人,2026-09-25 卡 N):不是派活,不加那一句 —— 这件由那个人做,事务官只跟进。
  if (isPersonAssignee(assignee)) return base
  return `${base}\n他点名要 ${DISPATCH_FAMILY_TITLES[assignee]} 做这件事 —— 按「派活给别家Agent」那一节办。`
}

/** 开成了的那条会话怎么记回卡上。形状沿用 TaskLink(agent + session_id),不另造。 */
export function butlerConversation(sessionId: string): TaskConversation {
  return { agent: 'dsh', session_id: sessionId }
}

/**
 * 这张卡是**交给事务官办的**吗 —— 会话结束收尾(`butlerLifecycle`)与通知(`callOut`)同用这一处。
 *
 * - 收件箱建的(`direction:'mine'`):老口径;
 * - 看板上负责人是事务官、而且挂着她那条 DSH 会话(负责人驱动 `startButlerOnItem` 落下的形状)——
 *   没有 mine 那一格,从前会话办完了卡一直停在「进行中」(运营维护包审计末节第三项)。
 *
 * 不用 `isTrackedItem`:那会把「我自己的待办」「同事的」也拉进收尾与来电。选题池的卡照旧只按 mine 算。
 */
export function delegatedToButler(task: Pick<TaskView, 'direction' | 'assignee' | 'kind' | 'conversation'>): boolean {
  if (task.direction === 'mine') return true
  if (task.kind === 'topic') return false
  return task.assignee === 'dsh' && task.conversation?.agent === 'dsh'
}
