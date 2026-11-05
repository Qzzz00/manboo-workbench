/**
 * **答案往哪送 —— 全工作台只有这一个文件算它**(2026-10-04,卡 `claude/answer-comes-to-her`;
 * 做法照 `orbCell.ts` / `waiting.ts` / `running.ts`:服务端算好一格,两端只显示)。
 *
 * 维护者 10-04 原话(经工作台捎话):「我刚给事务官发信息,好消息是信息准确,回复也很快,
 * 坏消息是信息直接从正在办切到办完了,我是自己追过去点开查看的……这个交互你得想想咋整」。
 *
 * 病根:她问一句 → 工作台照旧建一张卡 → 事务官答完 → `casualAsk` 判出「只是问了一句」→
 * 卡盖 `casual` 章、进「完成」。于是**那张卡在她眼前存在了两三秒**(正在办 → 办完),
 * 答案本身**一个字都没主动送到她面前** —— 要看得自己追到「办完」那一摞里点开。
 *
 * 她点头的两条(统筹 10-04 提、她回「开」):
 *
 * 1. **问一句不当成事项**:答案**直接出现在她提问的那个地方** —— 手机球下那一行字幕、
 *    电脑事务官页同一处(她在哪问就在哪答);App 在后台时发一条通知,**通知正文就是答案本身**,
 *    不是「有回复了」。不进「正在办 / 办完」卡片,不会「一闪就办完」。
 * 2. **交代一件事照旧是事项,但办完的结果先摆到她面前**:办完不直接沉进「办完」,
 *    首页先挂一张「刚办完 · 结果一句话」,她点开看过或划掉才收进去。
 *
 * ## 判「问一句 / 交代一件事」还是那一处,但它管的事换了
 *
 * `server/casualAsk.ts` 的 `casualAskVerdict`(三问 + 第四问回执)**一个字没动,还是一处主人**。
 * 换的是它的**用处**:从前它决定「这张卡算不算办完」,现在它只决定「**答案往哪送**」——
 * 三问全否 = 问一句 → 答案进这本账(字幕 + 通知正文);任一为是 = 交代一件事 → 照旧是事项,
 * 办完先挂「刚办完」。
 *
 * 判错时两头都不丢(卡里写明的兜底):
 * - **问一句被当成了事项** → 它照第 2 条走:办完先挂「刚办完 · 结果一句话」,答案照样在她眼前;
 * - **事项被当成了问一句** → 答案进这本账、照样到她面前,卡也还在盘上(`casual` 那一章没撤),
 *   她能从「办完」里把它拖回「进行中」。
 *
 * ## 这个文件里一行 I/O 都没有
 *
 * 账本(谁答了什么、她看过没有)在 `server/directAnswer.ts`,落盘在 `server/directAnswerFile.ts`。
 * 这里只有投影:账 + 看板 → `/state.answers` / `/state.fresh_results`。
 */
import type { AnswerView, AnswersView, FreshResultView, FreshResultsView, TaskView, WorkbenchState } from './protocol.ts'

/**
 * 「刚办完」那一张在首页上挂多久(**24 小时**)。
 *
 * 为什么有上限:她出门两天回来,首页不该挂着十几张「刚办完」等她一张张划掉 ——
 * 那就从「答案来找她」变成了又一摞待办。过了这个窗它自己沉进「办完」,
 * **一个字都没丢**(卡、对话、交付物全在),只是不再往她面前摆。
 *
 * 取 24 小时跟交付回执台账那一本同一个数(`fileDelivery.ts` 的 `DELIVERY_NEED_TTL_MS`),
 * 不另立一个 —— 同一个「这件事还新鲜」的直觉,两处用两个数,解释起来就是两套规矩。
 */
export const FRESH_RESULT_TTL_MS = 24 * 60 * 60 * 1000

/** 首页最多挂几张「刚办完」。再多的收在「还有 N 件」后面(界面那一侧的事),这里只定个顶。 */
export const FRESH_RESULT_MAX = 6

/** 回答留几条(字幕只摆最新那一条;留几条是为了她点开「刚才答过什么」看得到前一条)。 */
export const ANSWER_KEEP = 20

/** 看过了的那一条还留多久在 `/state.answers` 里(**10 分钟**):她点开看过之后字幕不该立刻空掉。 */
export const ANSWER_SEEN_LINGER_MS = 10 * 60 * 1000

/**
 * 这件事**办完了**吗 —— 「刚办完」只认 `done`。
 *
 * 为什么不含 `confirm`(等我确认):那一档**本来就摆在她面前**(「等你确认」那一张卡、
 * 球下那一行、电话里那一通),再挂一张「刚办完」就是同一件事在一屏上出现两回。
 * 为什么不含 `canceled`:取消不是一个要她看的结果。
 */
function isDone(task: TaskView): boolean {
  return task.status === 'done'
}

/**
 * 结果一句话。两处取,**都取不到就缺席**(「取不到就缺席,不编一个」):
 *
 * 1. 交付物里最后那条 `reply`(会话结束那一步挂上去的那段回答 —— 事务官自己说的话);
 * 2. 卡上那句 `note`(「只是问了一句」这类转述)。
 *
 * **不自己拼一句**「这件事办完了」:那是一句没有信息的话,她读完还得点开,
 * 等于这张卡白挂一次。摆标题就够了。
 */
export function resultLineOf(task: TaskView): string | undefined {
  const replies = (task.deliverables ?? []).filter(one => one.kind === 'reply')
  const last = replies[replies.length - 1]
  const text = last?.ref ?? task.note ?? undefined
  if (typeof text !== 'string') return undefined
  const trimmed = text.trim()
  return trimmed === '' ? undefined : trimmed
}

export type FreshResultSource = Pick<Partial<WorkbenchState>, 'tasks'>

/**
 * 「刚办完 · 结果一句话」那几张 —— **两端都读这一份**。
 *
 * 四道门:办完了(`done`)、**她还没看过**(`seen_result_at` 缺席)、办完不超过
 * {@link FRESH_RESULT_TTL_MS}、而且**不是「只是问了一句」那一张**(那一条的答案走
 * `/state.answers`,在字幕上;两处都摆就是同一句话在一屏上出现两回)。
 *
 * 新的在前(她最想看的是刚刚那一件);认不出办完时刻的那一张排最后,**不丢掉**。
 */
export function freshResultsOf(state: FreshResultSource, nowMs: number): FreshResultsView {
  const items: FreshResultView[] = []
  for (const task of state.tasks?.tasks ?? []) {
    if (!isDone(task)) continue
    if (task.seen_result_at !== undefined) continue
    if (task.casual === true) continue
    const at = Date.parse(task.updated_at)
    if (Number.isFinite(at) && nowMs - at > FRESH_RESULT_TTL_MS) continue
    const result = resultLineOf(task)
    items.push({ task_id: task.id, title: task.title, done_at: task.updated_at, ...(result === undefined ? {} : { result }) })
  }
  items.sort((a, b) => {
    const left = Date.parse(a.done_at)
    const right = Date.parse(b.done_at)
    if (!Number.isFinite(left)) return 1
    if (!Number.isFinite(right)) return -1
    return right - left
  })
  return { items: items.slice(0, FRESH_RESULT_MAX) }
}

/**
 * `/state.answers` 那一格 —— **两端都读这一份**。
 *
 * 新的在前;看过了的留 {@link ANSWER_SEEN_LINGER_MS} 再从这一格里掉出去
 * (她点开看过之后字幕不该当场空掉);`unseen` 就是两端那一行的数,**两端不自己数**。
 */
export function answersCellOf(answers: readonly AnswerView[], nowMs: number): AnswersView {
  const kept = answers
    .filter((one) => {
      if (one.seen_at === undefined) return true
      const seen = Date.parse(one.seen_at)
      return !Number.isFinite(seen) || nowMs - seen <= ANSWER_SEEN_LINGER_MS
    })
    .slice()
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, ANSWER_KEEP)
  return { items: kept, unseen: kept.filter(one => one.seen_at === undefined).length }
}

/**
 * 字幕 / 电脑事务官页那一处摆哪一条(**一次只摆一条**:最新的那一条还没看过的)。
 * 一条没看过的都没有 → 缺席(字幕让位给原来那一条事项字幕)。
 */
export function answerToShow(view: AnswersView | undefined): AnswerView | undefined {
  return view?.items.find(one => one.seen_at === undefined)
}

/**
 * 这条回答要不要推一次通知。**电话里问的那一条不推** —— 她刚在电话里听过了
 * (卡里写明:「电话里问一句本来就当场答,确认不重复再推一次通知」)。
 * 已经看过的也不推。
 */
export function answerWorthNotifying(answer: AnswerView): boolean {
  if (answer.seen_at !== undefined) return false
  return answer.where !== 'call'
}
