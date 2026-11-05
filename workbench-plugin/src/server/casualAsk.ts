/**
 * 「随手问一句不算一件事」(2026-09-25,卡 Y;`docs/决策记录.md` 同名那一节)。
 *
 * 维护者撞到的:在输入框里问一句「你是什么模型」,看板上多一张卡、办完还进「等你确认」、还要他验收。
 * 他定的(「你说的3个按你推荐的来」):
 *   1. 随手问一句、试一下**不算一件事**:办完**没派出去、没改文件、没有要交回的东西** → 卡自己收掉,只留在对话记录里;
 *   2. 谁来分:**照旧建卡,她答完自己判断**(输入框那头不预判,宁可看板上闪一下「进行中」也要判得准);
 *   3. 办完打电话要他验收的只有**派给别家、交回了东西**的(卡 M 已做,判据在 callOut.ts `taskCallOutEvent`)。
 *
 * 判断的唯一一处,而且是纯函数({@link casualAskVerdict}):会话结束那一步用(`butlerLifecycle.ts`)。
 * 「接着说算同一件」(carryOnTarget)与十分钟续进窗 2026-10-29 删规矩第一批随旧路删除(A#22)——
 * 所有入口进了理解中枢,续还是新由模型按上下文判(supplement / 新 dispatch)。
 *
 * **不经模型**:判据全是数出来的事实(卡上的派活记录、会话改过的文件数、卡上的交付物),
 * 没有一处是"看这句话像不像在问问题"。第九节查清的那条「只是问一件事就直接答」只是给她看的提示语,
 * 不是判据 —— 提示语管她**怎么答**,这里管**这张卡去哪**,两件事不许互相冒充。
 */
import type { TaskView } from '../protocol.ts'

/** 卡面上那一句:这一轮只是问了一句。**不说「办完了」**——她什么也没办,只是答了话。 */
export const CASUAL_ASK_NOTE = '只是问了一句'

/**
 * 会话那头能数出来的事实。缺席按 0 / 不知道处理,**不猜**。
 */
export interface CasualAskSignals {
  /**
   * ★ **她那段回答是在问他**(2026-09-27,卡 MS;判据在 `replyAsks.ts` 的 `replyAsksHim`)。
   *
   * 21:17 那一通:会话什么都没发出去,最后列了四条确认点等他点头 —— 三问全否,于是被收成
   * 「完成 · 只是问了一句」。维护者:「要确认,但是却没打电话给我,那怎么确认?」
   *
   * 在等他 = **一定算一件事**(而且不是「等我确认」,是「等你」那一堆 —— 见 `butlerLifecycle.ts`)。
   * 缺席 = 不知道,按老行为。
   */
  asksHim?: boolean
  /**
   * 这条会话到此刻用写类工具改过几个文件(`dshSessionFeed.ts` 的 `filesChanged`,
   * 与 dsh-context 同一份白名单:write / edit / str_replace_editor)。
   *
   * **已知缺口**:`bash` 改的文件数不出来(从命令行里猜不出改了哪个,D13 宁可少数也不猜),
   * 所以「只用 bash 动了文件」的那一轮会被判成随手问。卡还在、对话还在、可以拖回去,
   * 不是丢东西 —— 但这一条要写在交接里,别当成它不存在。
   */
  filesChanged?: number
}

/**
 * 「这一轮办完算不算一件事」的三问。每一问都是**卡上或会话上数得出来的事实**。
 *
 * 任何一问为是 → 算一件事,照旧进「等我确认」等他验收。三问全否 → 只是问了一句。
 */
export interface CasualAskVerdict {
  /** 算不算一件事。 */
  real: boolean
  /** 派出去了:卡上有派活记录 / 送话进窗口的记录 / 自发版那条闭环,或者他点了名要别家做。 */
  dispatched: boolean
  /** 改了文件:这条会话用写类工具动过盘上的文件。 */
  touchedFiles: boolean
  /** 有要交回的东西:交付物里除了「一段回答」之外还有别的(文件、链接、提交这些)。 */
  madeSomething: boolean
  /** 她在等他回话(2026-09-27,卡 MS):**回答里其实是一个问题**。等他的事一定算一件事。 */
  asksHim: boolean
}

/**
 * 派出去了没。五样任一:
 * - `dispatch`:事务官在它那条会话里派给别家、或工作台直接派(`dispatchRun.ts`)留下的记录;
 * - `client_dispatch`:把话送进那家客户端窗口的记录;
 * - `self_ship`:「改工作台自己」那条闭环(建分支、发版);
 * - `dispatch_block`:派活挑不到能做这件活的手(卡 O)—— **没派成也算一件事**:它正等他去修
 *   (登录那家 / 换一家),收掉这张卡等于把「要你修」藏起来;
 * - `assignee` 不是事务官:他点了名(「把 X 派给 Codex」),或者这件事归他 / 归同事(卡 N 的人那三档)。
 *   **点了名就算派出去** —— 派没派成是另一件事,不能因为那一步还没落记录就把这张卡收掉。
 */
function wasDispatched(task: TaskView): boolean {
  if (task.dispatch !== undefined || task.client_dispatch !== undefined || task.self_ship !== undefined) return true
  if (task.dispatch_block !== undefined) return true
  return task.assignee !== undefined && task.assignee !== 'dsh'
}

/**
 * 有要交回的东西没。`kind:'reply'` 是**一段回答**,不算东西 —— 会话结束那一步给每张卡都会挂一条
 * (「她说了什么」),拿它当"交回了东西"等于所有卡都算一件事,这条判据就白写了。
 * 文件、链接、提交、分支这些才算(判据与 `callOut.ts` 里那一行 `madeSomething` 逐字相同)。
 */
function madeSomethingOf(task: TaskView): boolean {
  return (task.deliverables ?? []).some(one => one.kind !== 'reply')
}

/** 三问的答案。纯函数,没有时钟、没有 I/O。 */
export function casualAskVerdict(task: TaskView, signals?: CasualAskSignals): CasualAskVerdict {
  const dispatched = wasDispatched(task)
  const touchedFiles = (signals?.filesChanged ?? 0) > 0
  const madeSomething = madeSomethingOf(task)
  const asksHim = signals?.asksHim === true
  return {
    real: dispatched || touchedFiles || madeSomething || asksHim,
    dispatched,
    touchedFiles,
    madeSomething,
    asksHim,
  }
}

/** 这一轮只是问了一句吗(三问全否)。 */
export function isCasualAsk(task: TaskView, signals?: CasualAskSignals): boolean {
  return !casualAskVerdict(task, signals).real
}
