/**
 * 事项生命周期闭环(2026-09-16):**会话结束 → 事项过渡**。
 *
 * 真机现象(Ben 2026-09-16):两条「我交给事务官」的事项各开了一条 DSH 会话,会话早已 done,
 * 事项却仍是 doing——事务官档「进行中 02」,球却待命、没连线。卡与会话之间缺的正是这一步:
 * 一事项一会话(docs/交接-0910-事项收件箱.md)建事项时把卡 move 到 doing,之后再没人碰它。
 *
 * 三条映射(docs/设计-事务官完整材料.md §4.1 时序图:turn/end completed → 卡片「完成待验收」蓝点):
 *
 * | 会话怎么结束 | 事项去哪 | 卡上留什么 |
 * |---|---|---|
 * | done(turn/end completed) | `confirm` 等我确认 | 交付物挂一条 `reply`:有摘要用摘要,没有就「会话已结束,去看对话」;依据 = 会话 id |
 * | done **且这件事要送一个文件、回执还没到** | `blocked` 阻塞,block_reason=input / error | note = 「找到了 X,但还没送到你手机:…」(2026-10-04,卡 `claude/phone-file-send-loop`) |
 * | done **且只是问了一句** | `done` 完成 + `casual` 章 | 同上挂回答,note = 「只是问了一句」(2026-09-25,卡 Y);**答案另送一份到她面前**(2026-10-04,卡 `claude/answer-comes-to-her`:字幕 + 通知正文) |
 * | done **且那段回答是在问他** | `blocked` 阻塞,block_reason=input(「等你」那一堆) | 同上挂回答,note = 「…,在等你回话」(2026-09-27,卡 MS) |
 * | error(error / max-tokens) | `blocked` 阻塞,block_reason=error | note = DSH 给的原话;没原话就「会话出错」 |
 * | aborted(他按了停) | `todo` 待办 | note = 「你停了它」 |
 *
 * 第二行是 2026-09-25 维护者拍的板(「随手问一句不算一件事」):**她答完自己判**这一轮算不算一件事 ——
 * 没派出去、没改文件、没有要交回的东西 → 卡收掉,不进「等我确认」、不要他验收、不打电话,
 * 对话记录照留。判据只有一处:`casualAsk.ts` 的 `casualAskVerdict`(三问全是数出来的事实,不经模型)。
 *
 * 两条不动的边界:
 * - 只对交给她的卡(`butlerItem.delegatedToButler`)、有 `conversation` 的卡生效,且只从 `doing` 出发——已经是
 *   confirm/done/canceled 的不倒退,todo/blocked 的不越级(那是人摆的位置)。
 * - **人改过的以人为准**:卡的 `updated_at` 晚于会话结束那一秒,说明他在会话结束之后动过这张卡
 *   (比如从 confirm 拖回 doing 想接着聊),这一条结束就不算数了。
 *
 * 纯函数 + 一层薄接线:判断在 itemTransitionOnSessionEnd 里(可单测),I/O 在 createButlerLifecycle 里
 * (找卡、update、move、通知),后者挂在 DSH 事件回调上,**绝不抛**。
 */
import type { TaskStatus, TaskView, WaitReason } from '../protocol.ts'
import type { DshSessionEnd } from './dshSessionFeed.ts'
import type { TasksService, UpdateTaskInput } from './tasks.ts'
import { CASUAL_ASK_NOTE, isCasualAsk } from './casualAsk.ts'
import { notDeliveredNote } from './fileDelivery.ts'
import { replyAsksHim, waitingOnHimNote } from './replyAsks.ts'
import { delegatedToButler } from './butlerItem.ts'

export { CASUAL_ASK_NOTE }

/** 会话答完了但一句摘要都拿不到时挂上去的那句话——不编一句摘要,让他去看对话。 */
export const SESSION_ENDED_NOTE = '会话已结束,去看对话'
/** 他自己按了停止。既不是出错也不是完成,卡回待办、留这一句。 */
export const STOPPED_NOTE = '你停了它'
/** 出错但 DSH 没给原话。 */
export const SESSION_ERROR_NOTE = '会话出错'

export interface ItemTransition {
  status: TaskStatus
  update: UpdateTaskInput
  /**
   * ★ **这一轮是「问一句」:答案要送到她面前**(2026-10-04,卡 `claude/answer-comes-to-her`)。
   *
   * 维护者 10-04:「信息直接从正在办切到办完了,我是自己追过去点开查看的」。
   * 从前这一支只做一件事(卡盖 `casual` 章进「完成」),答案就留在那张卡里等她去找。
   * 现在它**多报一句**:这段话要进回答账(`server/directAnswer.ts`)—— 手机球下那一行字幕、
   * 电脑事务官页同一处、以及一条**正文就是答案本身**的通知。
   *
   * 卡与 `casual` 那一章**一个字没改**(她照旧能从「办完」里把它拖回「进行中」);
   * 判「问一句 / 交代一件事」也还是 `casualAsk.ts` 那一处 —— 换的只是它管的事:
   * 从「这张卡算不算办完」变成「**答案往哪送**」。
   *
   * 纯函数这一头只报事实,记账与推通知在 `createButlerLifecycle` 里(那里才有 I/O)。
   */
  answer?: { question: string, answer: string, session_id?: string }
}

/**
 * 人在会话结束之后改过这张卡吗。比的是**秒**:事件时刻是 feed 的时钟(整秒),卡的 updated_at 是毫秒 ISO;
 * 同一秒之内的改动(建事项那条路自己 move 到 doing 时盖的章)不算人改过,晚一秒以上才算。
 */
export function editedAfter(task: TaskView, ts: number): boolean {
  const updated = Date.parse(task.updated_at)
  if (Number.isNaN(updated)) return false
  return updated >= (ts + 1) * 1000
}

/**
 * ★ **这件事要把一个文件送到她手机上,回执还没到**(2026-10-04,卡 `claude/phone-file-send-loop`;
 * 判据与登记在 `fileDelivery.ts`)。
 *
 * 10-04 早那一件(`t-63a9291b`):事务官把文件拷进了事务官文件夹、回了一句「你再说一遍就能收到」,
 * 卡随即「完成 · 只是问了一句」—— 她手机上什么都没有。`casualAsk` 的三问全是照事实判的
 * (没派活、bash 改的文件数不出来、交付物只有一段回答),所以三问没错,**缺的是这一问**。
 *
 * 排在「在问他」之后、「只是问了一句」之前:她在等回话时那一问优先(谁等谁更要紧),
 * 而只要回执没到,这件事**既不是完成、也不许被当成一次闲聊收掉**。
 */
export interface PendingDelivery {
  what?: string
  why: string
  /** 卡已经摆在她手机上、只差她点一下 —— 那是「等你输入」;推失败了才是「出错」。 */
  waitingTap: boolean
}

export function itemTransitionOnSessionEnd(
  task: TaskView,
  end: DshSessionEnd,
  summary?: string,
  pendingDelivery?: PendingDelivery,
): ItemTransition | undefined {
  if (!delegatedToButler(task) || task.conversation === undefined) return undefined
  if (task.status !== 'doing') return undefined
  if (editedAfter(task, end.ts)) return undefined

  if (end.kind === 'done') {
    const text = summary === undefined || summary.trim() === '' ? SESSION_ENDED_NOTE : summary.trim()
    const deliverables = [...(task.deliverables ?? []), { kind: 'reply' as const, ref: text, session_id: task.conversation.session_id }]
    /**
     * 她答完自己判这一轮算不算一件事(2026-09-25,卡 Y)。**回答照样挂上去**——
     * 收掉的是"要他验收的那一件",不是她说的那段话:卡在「完成」里、点开就是那段对话。
     */
    /**
     * ★ **她这段回答是在问他**(2026-09-27,卡 MS):既不是「完成」也不是「等我确认」——
     * 是「阻塞 · 等你输入」,进「等你」那一堆(`src/waiting.ts` 第四条,手机上看得见、答得了),
     * 而且从他来的那一端问回去(电话来的回电:`callOut.ts` 的 `taskCallOutEvent`)。
     *
     * 21:17 那一件就是这一种:什么都没发出去,最后列了四条确认点,却被记成「完成 · 只是问了一句」。
     * 维护者:「要确认,但是却没打电话给我,那怎么确认?」
     *
     * 排在「只是问了一句」**前面**:那一章问的是"他交代过一件事吗",这一条问的是"这会儿谁在等谁"。
     * 在等他的时候,前一问答什么都不重要。
     */
    const asking = replyAsksHim(text)
    if (asking !== undefined) {
      return { status: 'blocked', update: { deliverables, blockReason: 'input', note: waitingOnHimNote(asking.what) } }
    }
    if (pendingDelivery !== undefined) {
      return {
        status: 'blocked',
        update: {
          deliverables,
          blockReason: pendingDelivery.waitingTap ? 'input' : 'error',
          note: notDeliveredNote(pendingDelivery.what, pendingDelivery.why),
        },
      }
    }
    // 「只是问了一句」只对收件箱里随口说的那批:看板上摆着、交给她的卡本来就是一件事。
    if (task.direction === 'mine' && isCasualAsk(task, { ...(end.filesChanged === undefined ? {} : { filesChanged: end.filesChanged }) })) {
      return {
        status: 'done',
        update: { deliverables, note: CASUAL_ASK_NOTE, casual: true },
        /**
         * ★ 答案往她那儿送(2026-10-04;见 {@link ItemTransition.answer})。
         * 问的那一句用**卡的标题**(她那句原话落下来的地方);答的那一句是 `text` ——
         * 与挂上去的那条 `reply` 交付物**逐字同一段**,不另洗一遍。
         */
        answer: {
          question: task.title,
          answer: text,
          session_id: task.conversation.session_id,
        },
      }
    }
    return {
      status: 'confirm',
      update: {
        deliverables,
        // 答完了,卡上那句"怎么结束的"就该让位给交付物里的回答。
        note: null,
      },
    }
  }
  if (end.kind === 'error') {
    return { status: 'blocked', update: { blockReason: 'error', note: end.detail ?? SESSION_ERROR_NOTE } }
  }
  /**
   * ★ **这一轮被打断(aborted)也要问一句「送到没有」**(2026-10-04 午后统筹定,
   * 卡 `claude/three-small-1004`;出处 `docs/交接-1004-手机要文件一条路走通.md` 第六节「没查」第二条)。
   *
   * 从前这一支一律回「待办 · 你停了它」—— 那一句**没骗人**(aborted 本来就没宣称办完),
   * 可她看到的是一张待办卡,而「文件还没到你手机上」这件事一个字都没写。10-04 早那两轮正是
   * `aborted`:她看到的只是「阻塞了两次」,从卡上读不出差的是什么。
   *
   * 所以:回执还没到的时候这一支也进「阻塞」,卡面照台账那一句如实写。
   * 不是「完成」(没办完)、不是「待办」(差的那一下说得出来)。
   */
  if (pendingDelivery !== undefined) {
    return {
      status: 'blocked',
      update: {
        blockReason: pendingDelivery.waitingTap ? 'input' : 'error',
        note: `${STOPPED_NOTE};${notDeliveredNote(pendingDelivery.what, pendingDelivery.why)}`,
      },
    }
  }
  return { status: 'todo', update: { note: STOPPED_NOTE } }
}

export interface ButlerLifecycleOptions {
  tasks: Pick<TasksService, 'list' | 'update' | 'move'>
  /** 会话此刻的摘要(service 里那条会话的 summary)。拿不到就 undefined,交付物写「会话已结束,去看对话」。 */
  summaryOf?: (sessionId: string) => string | undefined
  /** 真改了一张卡之后叫一声(生产:推一份快照)。没改就不叫。 */
  onChanged?: () => void
  /**
   * 这件活**按他的规矩自查没过、已打回给那家**吗(2026-09-24 晚,卡 K;server/rules.ts 的 `heldBack`)。
   * 是就回卡上那一句:会话答完了也**不进「等我确认」**(合格才叫他),只把卡上那句话换成它。缺席 = 老行为。
   */
  heldBack?: (taskId: string) => string | undefined
  /**
   * 这一次「被停了」是**工作台自己停的**吗(2026-09-25,卡 O:到上限先停下来问 / 他在外层点了「停掉这一件」)。
   * 是就回该去哪、写什么(`itemBudget.ts` 的 `expectedAbort`,取一次就销掉),照它办 —— 不写「你停了它」、
   * 也不看「人在会话结束之后改过卡」那一条(卡正是我们刚改的)。缺席 = 老行为。
   */
  expectedAbort?: (sessionId: string) => { status: TaskStatus, note: string, blockReason?: WaitReason } | undefined
  /**
   * 这张卡**要把一个文件送到她手机上,而回执还没到**吗(2026-10-04;`fileDelivery.ts` 的 `pending`)。
   * 回了就照它写卡、进「阻塞」,**不许 done、不许「只是问了一句」**。缺席 = 老行为。
   */
  pendingDelivery?: (taskId: string) => PendingDelivery | undefined
  /**
   * ★ **把这一条回答送到她面前**(2026-10-04,卡 `claude/answer-comes-to-her`)。
   *
   * 接的是 `directAnswer.record`(记一条)+ 推通知那一下。**绝不抛**(挂在 DSH 事件回调上);
   * 缺席 = 老行为(答案照旧只留在那张卡里,与 0.4.97 一字不差)。
   */
  deliverAnswer?: (input: { taskId: string, question: string, answer: string, sessionId?: string }) => void
}

export interface ButlerLifecycle {
  /** 一条 DSH 会话的一个 turn 结束了。找到它底下那张事项卡并过渡;找不到就什么都不做。 */
  handleSessionEnd: (sessionId: string, end: DshSessionEnd) => Promise<void>
}

export function createButlerLifecycle(options: ButlerLifecycleOptions): ButlerLifecycle {
  return {
    async handleSessionEnd(sessionId, end) {
      try {
        const { tasks } = await options.tasks.list()
        // 一事项一会话:同一条会话最多挂在一张交给她的卡上;只认卡上**当前那条**会话(links 里的旧会话不算这张卡的结果)。真出现两张(不该),按建卡先后各自判一遍。
        const owners = tasks.filter(task => delegatedToButler(task) && task.conversation?.session_id === sessionId)
        let changed = false
        const expected = end.kind === 'aborted' ? options.expectedAbort?.(sessionId) : undefined
        if (expected !== undefined) {
          for (const task of owners) {
            if (task.status === 'done' || task.status === 'canceled') continue
            /**
             * ★ **撞上限 / 她在外层点了停,那一问照旧优先,但「文件还没到」要说出口**(2026-10-04)。
             * 那一问本身就是「等你回答」,不抢它的位置 —— 只在它后面接一句实话。
             */
            const owed = task.status === 'doing' ? options.pendingDelivery?.(task.id) : undefined
            await options.tasks.update(task.id, {
              note: owed === undefined ? expected.note : `${expected.note};${notDeliveredNote(owed.what, owed.why)}`,
            })
            if (task.status !== expected.status) {
              const moved = await options.tasks.move(task.id, expected.status)
              if (!moved.ok && expected.status !== 'doing') {
                // 转换表不许直达(比如 todo → blocked)就先过「进行中」。
                const via = await options.tasks.move(task.id, 'doing')
                if (via.ok) await options.tasks.move(task.id, expected.status)
              }
            }
            if (expected.blockReason !== undefined) await options.tasks.update(task.id, { blockReason: expected.blockReason })
            changed = true
          }
          if (changed) options.onChanged?.()
          return
        }
        for (const task of owners) {
          const held = end.kind === 'done' && task.status === 'doing' ? options.heldBack?.(task.id) : undefined
          if (held !== undefined) {
            if (task.note !== held) { await options.tasks.update(task.id, { note: held }); changed = true }
            continue
          }
          const next = itemTransitionOnSessionEnd(
            task,
            end,
            options.summaryOf?.(sessionId),
            /**
             * 答完那一刻问一次,**被打断那一刻同样问一次**(2026-10-04):
             * 「还差一个回执」与它这一轮是怎么收的无关。
             */
            task.status === 'doing' && (end.kind === 'done' || end.kind === 'aborted')
              ? options.pendingDelivery?.(task.id)
              : undefined,
          )
          if (next === undefined) continue
          // 先写卡面(交付物 / 原话),再挪状态:move 会盖 updated_at,顺序反了 update 又盖一次。
          await options.tasks.update(task.id, next.update)
          const moved = await options.tasks.move(task.id, next.status)
          if (moved.ok) changed = true
          /**
           * ★ **答案往她那儿送**(2026-10-04)。排在卡写完之后:先把事实落下来,再去找她 ——
           * 顺序反了的话,她点开通知时那张卡可能还是「正在办」。
           *
           * 卡没挪成(转换表不许)也照样送:她问的那一句**已经答了**,答案不该因为
           * 一张卡的状态没挪动就停在服务端里 —— 那正是这张卡要治的病。
           */
          if (next.answer !== undefined) {
            try {
              options.deliverAnswer?.({
                taskId: task.id,
                question: next.answer.question,
                answer: next.answer.answer,
                ...(next.answer.session_id === undefined ? {} : { sessionId: next.answer.session_id }),
              })
            }
            catch { /* 送不出去不该把这一步整个作废:卡已经写对了 */ }
          }
        }
        if (changed) options.onChanged?.()
      }
      catch {
        // 挂在 DSH 事件回调上:落盘失败只能是"这一步没走成",不能往外抛。
      }
    },
  }
}
