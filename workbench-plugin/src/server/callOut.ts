/**
 * 座机响铃 / 事务官主动来电的**决定权那一半**(2026-09-21)。
 *
 * Ben 的原话:「待确认 / 运行失败 / 完成提醒时座机响铃,用户接起来处理事务」。
 * 手机装在 3D 打印外壳里当座机 —— 它不是「一个装了 App 的手机」,是一台会响的电话。
 *
 * ## 这个文件回答的只有一个问题:**这会儿该不该打电话,打哪一件事**
 *
 * 真的去响铃、去说话在工人那边(channel-worker/src/callOut.ts);手机上的来电界面在
 * butler-app/src/call/。这里既不认识 LiveKit 也不认识手机,只跟两样东西打交道:
 * 一份**已有的**事实源(看板 tasks + 例程 routines),和一本**自己的**台账(call-out.json)。
 *
 * ## 三类事件的事实源(复用现有的,一条都不新造)
 *
 * | 理由 | 判据 | 谁写的 |
 * |---|---|---|
 * | `confirm` 等你确认 | 事项 `direction:'mine'` 且 `status==='confirm'` 且带四类拍板请求(`ownerAskOf`) | 七态里这一格 + 事务官核验后标(2026-10-26 卡「事务官页接管队列」);多数由 butlerLifecycle 的 done→confirm 写,标请求走 `POST /task/owner-ask` |
 * | `failed` 运行失败 | 事项 `direction:'mine'` 且 `status==='blocked'` 且 `block_reason==='error'`;或某条例程 `status==='failed'` | butlerLifecycle 的 error 分支 / routines.ts |
 * | `done` 完成 | 事项 `direction:'mine'` 且 `status==='done'`;或某条例程 `status==='ok'/'no_session'` | 人点的 / routines.ts |
 *
 * **只认交给事务官的卡**(`butlerItem.delegatedToButler`:`direction:'mine'`,或看板上负责人是事务官、
 * 挂着她那条 DSH 会话的)。他自己 / 同事的待办不算:给他自己的待办打电话等于「你刚才自己点的那一下,
 * 我打个电话通知你一声」,那不是座机,那是骚扰。上表里写的 `direction:'mine'` 都按这一条读。
 *
 * ## 四条规矩(都在纯函数里,可单测)
 *
 * 1. **等确认、失败 → 立刻响**;**完成 → 等一个合并窗(缺省 5 分钟)、而且缺省只发通知不响铃**
 *    (2026-09-22 Ben 定,A1:「『完成』类只发通知不打电话;早报也只通知,用户自己点开」)。
 *    理由:前两类各自是一件要他决定的事,晚一分钟就是晚一分钟;「完成」是一条汇报,
 *    天然成串(一轮活干完好几件),一件一个电话就是让座机变成闹钟。
 *    开关在 `/call/config` 的 `done_call`(缺省 false),手机设置页「座机」那一节看得到。
 * 2. **夜间静默时段(缺省 23:00–8:00)只发通知不响铃**。那一通照样进台账、照样发给手机,
 *    只是带着 `silent` —— 手机收到它就**发一条通知**而不是全屏响铃。
 *    **不是「不打」**:第二天早上他该看见昨晚有什么,而不是什么都没发生过。
 * 3. **同一件事的同一个理由只打一次**(`seen` 台账,按 `<reason>:<item_id>` 记)。
 *    外加一条:**这件事已经因为「等确认」或「运行失败」打过电话了,它后来变成「完成」就不再打**
 *    —— 那通电话里他已经处理过这件事了,再打一次是在为自己刚才的动作邀功。
 * 4. **没接就记「未接来电」**,不重拨。重拨要么是打扰,要么是在赌他这会儿方便接,
 *    两样都不该由代码替他决定;手机回到前台会把未接的列出来,点一条就回拨。
 * 5. **同一件事的同一个理由,同一时刻只能有一通没收场的**(2026-09-22)。上一通还排着或者还在响,
 *    再要一通就如实拒掉 —— 座机一次只响一通,排进去的会一通接一通地响。
 *    收场(未接 / 已接 / 只发了通知)之后他再点「回拨」,照旧排得出来:那是他亲口要的第二次。
 * 6. **「完成」有时效**(缺省 6 小时,见 {@link CALL_OUT_DONE_MAX_AGE_MS}):
 *    两天前办完的事今天第一次被看见,记下来但不打电话。`confirm` / `failed` 没有时效上限。
 *
 * 7. **未接来电收得掉**(2026-09-22):手机上按一下「清空」,那几条记上 `dismissed_at`,
 *    `view()` 的 `missed` 不再数它们。**台账一条不删** —— 那本记的是发生过的事,
 *    「读没读过」是另一回事(座机页「最近一次通话」照旧要看得见)。
 *
 * 第 5、6 两条与「手动那条也过 A1」是 2026-09-22 从真机台账上倒推出来的,根因与验法写在
 * `docs/交接-0922-完成类来电与重复排通.md`;第 7 条见 `docs/交接-0922-未接来电清空与折叠.md`。
 *
 * ## 台账落 `~/.dsh/workbench/call-out.json`,与 dock / notes / tasks 同一套目录规格
 *
 * 为什么这一份**要**落盘(而收件箱 butlerInbox.ts 是现拼不落盘的):
 * 「打没打过」是一件**发生过的事**,不是从别处能算出来的状态。重启一次就忘了打过没有,
 * 等于重启一次他的手机就再响一遍 —— 那正是 D13 里最坏的那种失真(系统说的话和事实对不上)。
 *
 * 除 `createCallOutService` 外全是纯函数:对象进、对象出,不碰磁盘。
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { CallOutAskText, CallOutConfigView, CallOutEntry, CallOutReason, CallOutSilentReason, CallOutState, CallOutView, RoutineRun, RoutinesView, TaskView, TasksState, CallOutFailKind, TellKind, TellScopeView, AgentCard } from '../protocol.ts'
import { CALL_OUT_REASONS, CALL_OUT_SILENT_REASONS, ROUTINE_TITLES, CALL_OUT_FAIL_KINDS, callOutFailKindOf, TELL_SCOPE_DEFAULT, isAgentDispatchFamily, isAgentCardAssignee, ownerAskOf } from '../protocol.ts'
import { delegatedToButler } from './butlerItem.ts'
import { casualAskVerdict } from './casualAsk.ts'
import { CALL_RECORD_TITLE } from './materialize.ts'
import { inQuietHours, parseClock } from './quietHours.ts'

// ———————————————————————— 常量 ————————————————————————

/** 「完成」那一类的合并窗:5 分钟。窗里再来的「完成」并进同一通,不另打。 */
export const CALL_OUT_MERGE_WINDOW_MS = 5 * 60 * 1000

/**
 * 「等你回答」那一类的合并窗:5 分钟(2026-09-25,卡 M 追加;统筹:「几分钟内接连几问只响一次,
 * 电话里一问一问答下去;超过窗口的新问题再响」)。
 *
 * 窗从**上一次真响的那一通**算起(不是滑动的:一问接一问地来,不会把窗一直往后推、永远不再响):
 *   - 那一通还排着 / 正在响 → 新的这一问**并进那一通**(`merged`),电话里答完一问工人会拿到下一问接着问;
 *   - 那一通已经收场(接了 / 没接)但还在窗里 → 新的这一问**只发通知**(`silent_reason:'ask'`),
 *     手机「等你确认」、电脑球下照样摆着;他要是还在那通电话里,答完一问工人照样拿到它;
 *   - 过了窗 → 再响。
 * 夜里只通知的规矩照旧(静默时段里每一问都只发通知)。5 分钟是定的(可推翻):她连着问几件通常在一两分钟里。
 *
 * **上一通里的问都答完了,这一窗就不算**(2026-10-12 晚,维护者拍板:「现在演示等五分钟要死人的」):
 * 那一通的主角与并进来的几问此刻一个都不在等了 → 新的一问照响;还有在等的 → 窗照旧只通知(见 {@link askStillOpen})。
 */
export const CALL_OUT_ASK_WINDOW_MS = 5 * 60 * 1000

/**
 * 他刚对某件事动过手(答、批、点确认 / 取消、交代它、接着说),之后 **10 分钟**里同一件事的后续
 * (「等你确认」「等你回答」)**不打电话**,只在界面和通知上出现(2026-09-25,卡 M 补;统筹真壳:他在电脑上点完选项,
 * 手机马上为同一件事又响了一次 —— 人就在电脑前,刚刚才点过)。在手机上答的同理。10 分钟是统筹倾向的值,可推翻。
 */
export const CALL_OUT_TOUCH_QUIET_MS = 10 * 60 * 1000

/** 夜间静默时段的缺省两头(本机时间,24 小时制)。跨零点,所以 from > to 是正常的。 */
export const CALL_OUT_DEFAULT_QUIET_FROM = '23:00'
export const CALL_OUT_DEFAULT_QUIET_TO = '08:00'

/**
 * 工人领走一通之后多久还没回话,就当它死了(进程被杀、掉线)。
 * 振铃上限是 60 秒(工人那边),这里给三倍的余量 —— 宁可晚一点记成未接,
 * 也不要在他正对着响铃的手机时把这一通判死。
 */
export const CALL_OUT_RING_STALE_MS = 3 * 60 * 1000

/**
 * 「完成」那一类**缺省不打电话,只发通知**(2026-09-22,Ben 定:A1)。
 *
 * 原话:「『完成』类只发通知不打电话;早报也只通知,用户自己点开。」
 * 这一条正是交接第十一节里留给他拍的那件事,他选了②。开关在 `/call/config` 的 `done_call`,
 * 手机设置页「座机」那一节看得到 —— **不写死**:哪天他嫌通知不够醒目,打开就响。
 *
 * **`done_call` 是整条策略的唯一开关**:自动那条(`planCallOuts`)与手动那条(`request`)
 * 都过它。2026-09-22 之前手动那条是个例外,结果就是真机台账上那七通「下班例程」——
 * 见 `docs/交接-0922-完成类来电与重复排通.md`。
 */
export const CALL_OUT_DEFAULT_DONE_CALL = false

/**
 * 「完成」那一类的**时效上限:6 小时**(2026-09-22)。超过这个岁数的完成事件不再排电话。
 *
 * 为什么只管「完成」:`confirm`(等你确认)与 `failed`(运行失败)说的是**此刻仍然成立的状态**
 * —— 那张卡两天前进了「等我确认」,今天还在等,该响;而「完成」说的是**某一刻发生过的事**,
 * 过了半个工作日再通知他「办完了」,他得回头去翻两天前的事,那不是汇报,是骚扰。
 *
 * 真机上逮到的样子:`routine:evening:2026-09-20` 这一通的 `at` 是 09-20T10:30Z、
 * `queued_at` 却是 09-21T09:39Z —— 隔了 23 小时。事实源(`routines.last`)记的是
 * 「最近一次跑的结果」,那一格会在那儿挂很多天;挡住重复的只有台账里那一条记号,
 * 于是**任何一次台账里还没有它的记号**(工作台重启后第一拍、换机器、台账重建)都会把它排出来。
 *
 * 6 小时是定的,不是算出来的(可推翻):下班例程 18:30 跑完,当晚 24:30 之前通知他还算「今天的事」;
 * 第二天早上再说就不是了。要改就改这个常数 —— 判据(`callOutEventsOf` 那一层)一个字都不用动。
 */
export const CALL_OUT_DONE_MAX_AGE_MS = 6 * 60 * 60 * 1000

/**
 * **座机只为「他不点头就卡住」的那几件响**(2026-09-28,卡 UX;维护者:「那 18 条我看着都像垃圾短信,
 * 实际上真事没几个」)。判据一处:{@link callOutRings}。
 *
 * 响的三样(与卡 WY / 卡 CB 已拍板的口径逐字对应):
 *   - `ask` —— 派活要批、执行中停下来问他(事务官自己的提议不在这里:那一路在 butlerAsks.ts 就筛掉了);
 *   - `relay` —— 捎话回来了(卡 CB);
 *   - `failed` 且**不是例程** —— 那件事卡住了,他不管它就一直卡着。
 * 不响、只进列表与通知的:`confirm`(办完了等你验收)、`done`(做完了)、任何**例程**那一条
 * (例程播报:早报 / 下班 / 知识 lint,跑完与跑挂了都算)。
 *
 * `confirm` / `done` 照旧过 `done_call` 那一个开关 —— 他嫌通知不够醒目,打开就两类都响(**不写死**)。
 */
export function isRoutineItem(itemId: string): boolean {
  return itemId.startsWith('routine:')
}

/** 这一通该真响,还是只发一条通知(不含夜间静默、刚动过手那几条另算的规矩)。 */
export function callOutRings(event: Pick<CallOutEvent, 'reason' | 'item_id'>, doneCall: boolean): boolean {
  if (isRoutineItem(event.item_id)) return false
  if (event.reason === 'ask' || event.reason === 'relay') return true
  if (event.reason === 'failed') return true
  // 「办完了等你验收」与「做完了」是同一件事的两头,同一个开关。
  return doneCall
}

/** 台账里留多少通。座机一天响不了几次,200 通够看很久;超出的从最早的丢。 */
export const CALL_OUT_LOG_MAX = 200

/**
 * 「打过了」的记号留多少条。它和 log 是**两件事**:log 是给人看的清单(会被裁),
 * 这一份是「同一件事只打一次」的依据(裁掉就会重打)。所以它更长、而且只存一个字符串。
 */
export const CALL_OUT_SEEN_MAX = 1000

// ———————————————————————— 事件 ————————————————————————

/** 一件「值得打个电话」的事。由 {@link callOutEventsOf} 从已有事实源现算,不落盘。 */
export interface CallOutEvent {
  /** `<reason>:<item_id>`。同一件事的同一个理由永远是同一个 key —— 「只打一次」认的就是它。 */
  key: string
  reason: CallOutReason
  /** 事实源上那一条的 id:事项是卡 id,例程是 `routine:<name>:<date>`。 */
  item_id: string
  /** 电话里念的那一句。由代码从事实拼,不经模型。 */
  title: string
  /** 补一句上下文(交付物几件、失败的原话)。没有就没有,不占位。 */
  note?: string
  /** 别家窗口里那道题的原话(会话那一路才有;见 `CallOutEntry.ask`)。 */
  ask?: CallOutAskText
  /** 这件事发生的时刻(ISO)。 */
  at: string
  /**
   * 事实上这一件**只是一段回答**(2026-09-25,卡 M 补):没派给别家、交回来的只有一段话(没有文件、链接这些东西)。
   * 维护者定之前的默认:**只有派出去的活、他明确交代要东西的事,办完了才打电话要他验收**;只是一段回答的,只在界面和通知上出现。
   */
  quiet?: 'chat'
}

export function callOutKey(reason: CallOutReason, itemId: string): string {
  return `${reason}:${itemId}`
}

/** 「等我确认」的卡上有几件可验收的东西。与 butlerInbox.ts 那一句逐字相同。 */
function deliverableNote(count: number): string {
  return count === 0 ? '没有可验收的东西' : `${count} 件交付物`
}

/**
 * 这张卡办完属于哪一类(通知范围开关按这个归类;认不出 = 不出事件,与 2026-10-23 之前一致):
 *   - `meeting` —— 会上落下的待办(`origin:'meeting'`,本来就是交给事务官的,单独一档勾);
 *   - `mine` —— 交给事务官办的卡(收件箱建的 + 看板上交给她、挂着她会话的;`delegatedToButler` 那一处判据,不另写一份);
 *   - `dispatch` —— 派给别家 AI 的活。判据与负责人驱动(`itemDriver.ts`)**同一个**:负责人是家名
 *     (`isAgentDispatchFamily`),或是一张 Agent 名片(`isAgentCardAssignee`)而那张名片按
 *     `runtime.family`(缺席退回 `hand`)认得出是 AI —— **不靠闭集家名**,真实板上现有派活全走名片
 *     (`agent:local:…`,卡「名片补四样与Kimi命令行手」起)。名片被删 / 名片表没传时退回卡上的
 *     派活记录(`task.dispatch`,「派给了别家」那一格就是接缝源头的那一份,只由服务端写):
 *     派出去过 = 派活,一条记录都没有 = 认不出。
 */
export function tellKindOfTask(
  task: Pick<TaskView, 'origin' | 'direction' | 'assignee' | 'kind' | 'conversation' | 'dispatch'>,
  cards?: readonly Pick<AgentCard, 'id' | 'hand' | 'runtime'>[],
): TellKind | undefined {
  if (task.origin === 'meeting') return 'meeting'
  if (delegatedToButler(task)) return 'mine'
  const who = task.assignee
  if (typeof who === 'string' && isAgentDispatchFamily(who)) return 'dispatch'
  if (typeof who === 'string' && isAgentCardAssignee(who)) {
    const card = cards?.find(one => one.id === who)
    // 与 itemDriver 一致:名片还在,按 runtime.family(缺席退回 hand)认是不是 AI;认不出的退回派活记录。
    if (card !== undefined) return isAgentDispatchFamily(card.runtime?.family ?? card.hand) ? 'dispatch' : undefined
    return task.dispatch !== undefined ? 'dispatch' : undefined
  }
  return task.dispatch !== undefined ? 'dispatch' : undefined
}

/** 一张卡 → 一条事件(不该打电话的回 undefined)。开关 `scope` 挡「哪几类出得了事件」,判定逻辑一字不动。 */
export function taskCallOutEvent(task: TaskView, scope: TellScopeView = TELL_SCOPE_DEFAULT, cards?: readonly Pick<AgentCard, 'id' | 'hand' | 'runtime'>[]): CallOutEvent | undefined {
  /*
   * 一通电话的纪要不是一件办完的事(2026-09-28 Air 维护包:电话里播「和事务官通了个电话(36 秒)」)。
   * 电话里交代出来的真事项(origin:'call' 但不是纪要本身)照旧提醒。
   *
   * **2026-10-02 补一条判据**(卡「电话里像个活人」):09-28 那一版只认 `call.kind === 'call'`,
   * 而更早版本落下的纪要卡**没有 `call` 那一格**(只有 `origin:'call'` 和那个标题)——
   * 于是 Air 10-02 的通话里仍然念出了「插一句:『和事务官通了个电话(5 秒)』办完了」。
   * 标题那一条正则只有一份(materialize.ts 的 `CALL_RECORD_TITLE`),**不另写一份**。
   * 2026-10-22 起通话不再建卡(落成 `server/callRecords.ts` 的记录),这一条只剩拦存量老卡。
   */
  if (task.origin === 'call' && (task.call?.kind === 'call' || CALL_RECORD_TITLE.test(task.title.trim()))) return undefined
  /*
   * ★ **按事项类型过「办完要不要告诉她」那道开关**(2026-10-23,卡「分层第二刀一」;开关在设置里,
   * 缺省照之前的行为)。她 10-03 在产物上扩大了通知范围,这里把它收成一个范围开关:
   * 判定(算不算失败、谁的会话收尾)一个字没动,只在「出不出的了事件」这一层挡。
   */
  const kind = tellKindOfTask(task, cards)
  if (kind === undefined) return undefined
  if (kind === 'dispatch') {
    // 派出去的活:2026-10-23 之前一条事件都不出(现状);勾上「派活」才出,出的那几种与交给事务官的同口径。
    if (!scope.dispatch) return undefined
    const at = task.status === 'done' ? (task.done_at ?? task.updated_at) : task.updated_at
    if (task.status === 'confirm') {
      // 2026-10-26(卡「事务官页接管队列」):只有事务官标了四类拍板请求的那几件才通知 / 响;
      // 待核验队列不摊给他,未知不自动放行。判据与「等你」队列同一处(`ownerAskOf`)。
      if (ownerAskOf(task) === undefined) return undefined
      return { key: callOutKey('confirm', task.id), reason: 'confirm', item_id: task.id, title: task.title, note: deliverableNote(task.deliverables?.length ?? 0), at }
    }
    if (task.status === 'blocked' && task.block_reason === 'input') {
      return { key: callOutKey('ask', task.id), reason: 'ask', item_id: task.id, title: task.title, ...(task.note === undefined || task.note === '' ? {} : { note: task.note }), at }
    }
    if (task.status === 'blocked' && task.block_reason === 'error') {
      return { key: callOutKey('failed', task.id), reason: 'failed', item_id: task.id, title: task.title, ...(task.note === undefined || task.note === '' ? {} : { note: task.note }), at }
    }
    if (task.status === 'done') {
      return { key: callOutKey('done', task.id), reason: 'done', item_id: task.id, title: task.title, at }
    }
    return undefined
  }
  if (kind === 'meeting' ? !scope.meeting : !scope.mine) return undefined
  /**
   * 「只是问了一句」的那一张(2026-09-25,卡 Y):**一条事件都不出** —— 不打电话,连「办完了」那条通知也不发。
   * 她答完就把卡收了,他从头到尾没交代过一件要办的事,通知他「办完了」是在替一次闲聊制造一件事。
   */
  if (task.casual === true) return undefined
  const at = task.status === 'done' ? (task.done_at ?? task.updated_at) : task.updated_at
  if (task.status === 'confirm') {
    /**
     * 「派出去了 / 交回了东西」这一问**与卡 Y 那条判据同一个函数**(`casualAsk.ts` 的 `casualAskVerdict`):
     * 两处各写一份的话,「哪种事该打电话」和「哪种事算一件事」迟早对不上。
     * 这里没有会话那头的文件数(卡 Y 那条路在会话结束那一刻就把只回一段话的收掉了),
     * 所以只问卡上那两样 —— 走到这一步还在 `confirm` 的,要么派出去过、交回了东西(照响),
     * 要么是他自己把卡拖进「等我确认」的(只通知,`quiet:'chat'`)。
     *
     * 2026-10-26(卡「事务官页接管队列」):先过 `ownerAskOf` 那一道 —— 只有事务官标了
     * 四类拍板请求(带方案与依据)的那几件才通知 / 响;待核验队列不摊给他,未知不自动放行。
     */
    if (ownerAskOf(task) === undefined) return undefined
    const verdict = casualAskVerdict(task)
    return {
      key: callOutKey('confirm', task.id),
      reason: 'confirm',
      item_id: task.id,
      title: task.title,
      note: deliverableNote(task.deliverables?.length ?? 0),
      at,
      ...(verdict.real ? {} : { quiet: 'chat' as const }),
    }
  }
  /**
   * ★ **她停在一个问题上,而他不在电脑前**(2026-09-27,卡 MS)。
   *
   * 21:17 那一件:会话最后列了四条确认点等他点头,那段字只挂在电脑界面上 —— 他人在电话里。
   * 维护者:「你看,要确认,但是却没打电话给我,那怎么确认?」
   *
   * 「阻塞 · 等你输入」是「等你」那一堆里的一档(`src/waiting.ts` 第四条),以前**一条来电事件都不出**:
   * 派不出去、到上限停下来、她在问他,全都只在屏幕上。现在与「等你回答」同一档(白天响、
   * 免打扰只通知、一件一通),事项来自哪一端不影响这一通 —— 他在哪儿接都是同一件事。
   */
  if (task.status === 'blocked' && task.block_reason === 'input') {
    return {
      key: callOutKey('ask', task.id),
      reason: 'ask',
      item_id: task.id,
      title: task.title,
      // 卡上那句 note 就是「她在等你回话」那一句(butlerLifecycle / itemBudget 写的)。原样带走。
      ...(task.note === undefined || task.note === '' ? {} : { note: task.note }),
      at,
    }
  }
  if (task.status === 'blocked' && task.block_reason === 'error') {
    return {
      key: callOutKey('failed', task.id),
      reason: 'failed',
      item_id: task.id,
      title: task.title,
      // 卡上那句 note 就是 DSH 给的原话(butlerLifecycle 写的)。**原样带走,不改写**。
      ...(task.note === undefined || task.note === '' ? {} : { note: task.note }),
      at,
    }
  }
  if (task.status === 'done') {
    return { key: callOutKey('done', task.id), reason: 'done', item_id: task.id, title: task.title, at }
  }
  return undefined
}

/** 一次例程 → 一条事件。`skipped` 不打电话(DSH 不在线是常事,不是「出了事」)。 */
export function routineCallOutEvent(run: RoutineRun): CallOutEvent | undefined {
  const itemId = `routine:${run.name}:${run.date}`
  const title = ROUTINE_TITLES[run.name]
  if (run.status === 'failed') {
    return {
      key: callOutKey('failed', itemId),
      reason: 'failed',
      item_id: itemId,
      title,
      ...(run.note === undefined || run.note === '' ? {} : { note: run.note }),
      at: run.started_at,
    }
  }
  if (run.status === 'ok' || run.status === 'no_session') {
    return {
      key: callOutKey('done', itemId),
      reason: 'done',
      item_id: itemId,
      title,
      ...(run.note === undefined || run.note === '' ? {} : { note: run.note }),
      at: run.started_at,
    }
  }
  return undefined
}

export interface CallOutEventsInput {
  /** 看板整块。没接任务板时缺省 —— 那一类事件一条都不出,**不为了凑数编一条**(D13)。 */
  tasks?: TasksState | undefined
  /** 例程最近一次的结果。没接例程时缺省。 */
  routines?: RoutinesView | undefined
  /**
   * 哪几类事项办完要告诉她(2026-10-23,卡「分层第二刀一」;设置里的勾,`server/dispatchPrefs.ts`)。
   * 缺席 = 缺省范围,照 2026-10-23 之前的行为。
   */
  scope?: TellScopeView | undefined
}

/**
 * 此刻**所有**够得上「该打个电话」的事。**不管打没打过** —— 那一层在 {@link planCallOuts} 里。
 *
 * 为什么分两层:这一层只回答「事实是什么」,可以随时重算、重算多少遍都一样;
 * 「打没打过」是台账里的事。搅在一起的话,一个 bug 就能让同一件事天天响。
 */
export function callOutEventsOf(input: CallOutEventsInput): readonly CallOutEvent[] {
  const out: CallOutEvent[] = []
  const scope = input.scope ?? TELL_SCOPE_DEFAULT
  const cards = input.tasks?.agent_cards
  for (const task of input.tasks?.tasks ?? []) {
    const event = taskCallOutEvent(task, scope, cards)
    if (event !== undefined) out.push(event)
  }
  for (const name of ['morning', 'evening', 'lint'] as const) {
    const run = input.routines?.last[name]
    if (run === undefined) continue
    if (!scope.routine) continue
    const event = routineCallOutEvent(run)
    if (event !== undefined) out.push(event)
  }
  return out
}

// ———————————————————————— 静默时段 ————————————————————————

/**
 * 时段判断**不在这里**:2026-09-26(卡 QH)搬进了 `server/quietHours.ts`,整个产品只有那一处。
 *
 * 为什么搬:这两个函数原来只有座机那条路用,于是「晚上 9 点以后不想被打扰」这条规矩就只有电话听得懂 ——
 * 09-26 00:19 手机冷启动,朗读在半夜念东西(它压根不知道有免打扰这回事)。现在服务端把结论摆在
 * `/state.quiet`,来电、朗读、提示音都读同一格。**这里的行为一个字没改**(同一个函数,只是换了个家),
 * 原地重新导出是为了不动 callOut 自己那一套调用点与用例。
 */
export { inQuietHours, parseClock }

// ———————————————————————— 排一通电话 ————————————————————————

export interface CallOutPlanInput {
  events: readonly CallOutEvent[]
  /** 已经打过的那些 key。 */
  seen: ReadonlySet<string>
  /** 还没交给工人、正等着合并窗的那几通(只有 `done` 会有)。 */
  waiting: readonly CallOutEntry[]
  now: number
  quiet: { from: string, to: string }
  /**
   * 「完成」那一类要不要真打电话(2026-09-22 A1)。**缺省 false = 只发通知**。
   * 不影响 `confirm` / `failed`,也不影响进不进台账 —— 只决定这一通响不响。
   */
  doneCall?: boolean
  mergeWindowMs?: number
  /** 「完成」过了多久就不再排(缺省 {@link CALL_OUT_DONE_MAX_AGE_MS})。测试注入短的。 */
  doneMaxAgeMs?: number
  /**
   * 上一次真响的那一通「等你回答」是什么时候排出来的(毫秒;没有就缺席)。窗见 {@link CALL_OUT_ASK_WINDOW_MS}。
   * 由服务从台账里找(接了的、没接的、还排着 / 在响的都算;没打出去的不算 —— 那一通他根本没听见)。
   */
  lastAskRingAt?: number
  /**
   * 上一次真响的那一通本身(key / item_id / merged;2026-10-12 晚,维护者:「现在演示等五分钟要死人的」):
   * 它里面的问**一个都不在等了**(都答掉了)→ 窗作废,新的一问照响;还有在等的 → 窗照旧。
   * 缺席(老台账 / 没传)= 当还在等,行为与以前相同。
   */
  lastAskRing?: Pick<CallOutEntry, 'key' | 'item_id' | 'merged'>
  askWindowMs?: number
  /** 他最近一次对哪件事动过手(事项 id → 毫秒)。窗见 {@link CALL_OUT_TOUCH_QUIET_MS}。 */
  touchedAt?: ReadonlyMap<string, number>
  touchQuietMs?: number
  /** 造 id。测试注入固定的。 */
  newId?: () => string
  /**
   * 从行为账里学到的「这个时段不打电话、改发消息」(2026-10-09,`habits.ts` 的 `quietNow`):此刻落在里面就回那条习惯的 id。
   * 只改**本来要响**的那几通(理由记 `habit`),本来就只发通知的不算用上。
   */
  habitQuiet?: (nowMs: number) => string | undefined
}

/**
 * 这一件事的这一个理由,此刻有没有一通**还没收场**的电话(排着 / 正在响)。
 *
 * `missed` / `answered` / `notified` / `failed` 都是收场了的,不算 —— 他自己点「回拨」
 * 要的正是「上一通没接着,再来一次」。挡住的只是**上一通还在响的时候再排一通**:
 * 座机一次只响一通,排进去的那几通会一通接一通地响,真机上那五秒五通就是这么来的。
 */
export function liveCallFor(log: readonly CallOutEntry[], reason: CallOutReason, itemId: string): CallOutEntry | undefined {
  return log.find(entry =>
    (entry.state === 'queued' || entry.state === 'ringing')
    && entry.reason === reason
    && entry.item_id === itemId)
}

/**
 * 「未接来电清空」的那一半纯逻辑(2026-09-22):把**还没收过的未接**都记上 `dismissed_at`。
 *
 * 三条纪律:
 * 1. **只标记,不删**:回的每一条都还在,状态一个字不动 —— 收的是「他看过了」,
 *    不是「这通没发生过」。座机页「最近一次通话」读的是同一本台账。
 * 2. **只碰 `missed`**:排着的、正在响的、已接的、只发了通知的都不该被一颗「清空」收掉。
 * 3. **收过的不刷新时刻**:`dismissed_at` 记的是他第一次看过那一下。
 *
 * 一条都没得收时**原样回同一个数组**(调用方据此决定要不要落盘 —— 按两下不该写两次盘)。
 */
export function dismissMissedEntries(
  log: readonly CallOutEntry[],
  at: number,
): { log: readonly CallOutEntry[], dismissed: number } {
  const stamp = new Date(at).toISOString()
  let dismissed = 0
  const next = log.map((entry) => {
    if (entry.state !== 'missed' || entry.dismissed_at !== undefined) return entry
    dismissed += 1
    return { ...entry, dismissed_at: stamp }
  })
  return dismissed === 0 ? { log, dismissed: 0 } : { log: next, dismissed }
}

// ———————————————————————— 已经答了就不打了 ————————————————————————

/**
 * 撤掉一通「等你答」时记在台账上那一句(2026-09-28,卡 AQ)。
 *
 * 状态用 `failed`(「没打出去」)—— 与桌面上按「停铃」撤掉一通排着的电话是同一个先例
 * (`http.ts` 的 `toggleTestCall`):那一通**确实没打出去**,而为什么没打出去就写在这一句里。
 * 不新开一档状态:手机、工人、台账那一行读的都是同一套六档。
 */
export const CALL_OUT_MOOT_ASK_ERROR = '他已经答了,这一通没打出去'

/** 桌面上按「停铃」撤掉排着的那一通(`http.ts` 试铃那颗键)。`fail_kind: 'declined'`。 */
export const CALL_OUT_STOP_RING_ERROR = '桌面上按了「停铃」'

/** 只发通知的那一条,工人领了却没回话。`fail_kind: 'tech'`。 */
export const CALL_OUT_WORKER_SILENT_ERROR = '电脑上的工人没回话,这一条通知按没发出去记'

export interface MootAskInput {
  log: readonly CallOutEntry[]
  /** 此刻**所有**够得上打电话的事(同 `planCallOuts` 的 events)。取不全的时候不许调这个函数。 */
  events: readonly CallOutEvent[]
}

/**
 * **那一问已经不在了,排着的那一通撤掉**(2026-09-28,卡 AQ)。纯函数:回该撤的那几条。
 *
 * 现场:Codex 那道选项题她在电脑上答掉了(`confirmed:true`),可 `call-out.json` 里那一通还挂着
 * `queued` —— 当时房里没有在线手机,没响。等手机上线它就要为一个**已经答掉的问**打过去,
 * 电话里那句「Codex 在等你选:你最喜欢哪种菜系?」是句假话:它不等了。
 *
 * 判据只有一条:**这一通的 key 还在不在此刻的事件里**。于是三种情形一并收进来 ——
 * 会话不再 waiting、`ask.since` 变了(同一条会话换了一问:老 key 没了、新 key 另排一通)、
 * 经 `/asks/answer` 答上了;事项那一路(卡停在「阻塞 · 等你输入」)是同一个 `reason:'ask'`,
 * 规矩照走,不另写一份。
 *
 * 四条纪律:
 * 1. **只撤「等你答」那一档**(`reason:'ask'`)。`confirm` / `done` / `failed` / `relay` 说的是
 *    「发生过的事 / 此刻仍然成立的状态」,不归这条规矩管;
 * 2. **只撤排着的**(`queued`)。已经被工人领走的(`ringing`)撤不回来 —— 8791 与工人之间没有
 *    「把那通掐了」的路(callOut.ts 文件头),硬记一笔就是在假装撤掉了;
 * 3. **没有 key 的那几条不动**(09-28 之前的台账):宁可多响一次,也不按猜测撤一通;
 * 4. **并进这一通的另一问还在等 → 不撤**:那一通里还有正事(合并窗把几问打成一通)。
 *
 * 调用方那一侧还有一条:**事实源这一拍取不到就别调**(读不到看板 ≠ 那一问没了)。
 */
export function mootQueuedAsks(input: MootAskInput): readonly CallOutEntry[] {
  const liveKeys = new Set<string>()
  const liveItems = new Set<string>()
  for (const event of input.events) {
    if (event.reason !== 'ask') continue
    liveKeys.add(event.key)
    liveItems.add(event.item_id)
  }
  return input.log.filter((entry) => {
    if (entry.reason !== 'ask' || entry.state !== 'queued') return false
    if (entry.key === undefined || entry.key === '') return false
    if (liveKeys.has(entry.key)) return false
    // 合并进来的那几问还有一个在等 → 这一通照打(它不是一句假话)。
    return !(entry.merged ?? []).some(one => liveItems.has(one.item_id))
  })
}

/** 这条「完成」事件是不是已经老得不值得再通知了。时刻读不出来就**不算老**(不知道就别丢)。 */
function staleDone(event: CallOutEvent, now: number, maxAgeMs: number): boolean {
  if (event.reason !== 'done') return false
  const at = Date.parse(event.at)
  if (Number.isNaN(at)) return false
  return now - at > maxAgeMs
}

export interface CallOutPlan {
  /** 新开的几通。 */
  created: readonly CallOutEntry[]
  /**
   * 并进已有那一通的:`{ id, event }`。`lead` = 那一通还排着没响,**新的这一问当主角**、原来那件排到后面
   * (2026-10-12:房里一直没手机,旧的一问排了几个钟头,她刚在豆包里问出的那道题反倒成了配角)。
   */
  merged: readonly { id: string, event: CallOutEvent, lead?: true }[]
  /** 这一拍新认下的 key(不管开没开新的一通,都要记上,否则下一拍又来一遍)。 */
  seen: readonly string[]
  /** 学到的时段让哪几通改成了只发通知(习惯那边记「用上了」)。 */
  habitApplied?: readonly { id: string, item_id: string }[]
}

/** 一条事件 → 一通电话的台账条目。 */
function entryOf(input: {
  event: CallOutEvent
  now: number
  silent: boolean
  /** 只发通知的那一通为什么不响(响的那几通不带这一格)。 */
  silentReason?: CallOutSilentReason
  dueAt: number
  id: string
}): CallOutEntry {
  const nowIso = new Date(input.now).toISOString()
  return {
    id: input.id,
    // 卡 AQ:把这条事件的 key 一起记下 —— 「这一通说的那件事还在不在」按 key 问才问得准。
    key: input.event.key,
    reason: input.event.reason,
    item_id: input.event.item_id,
    title: input.event.title,
    ...(input.event.note === undefined ? {} : { note: input.event.note }),
    ...(input.event.ask === undefined ? {} : { ask: input.event.ask }),
    at: input.event.at,
    state: 'queued',
    silent: input.silent,
    ...(input.silent && input.silentReason !== undefined ? { silent_reason: input.silentReason } : {}),
    queued_at: nowIso,
    due_at: new Date(input.dueAt).toISOString(),
  }
}

/**
 * 这一拍要打哪几通。**纯函数** —— 台账怎么存、谁去响铃都不在这里。
 *
 * 五条规矩按顺序落:①「打过了」跳过;②「等确认 / 失败 打过了,后来完成了」跳过;
 * ③「完成」过了时效(缺省 6 小时)跳过;④ 这一件这一个理由还有一通没收场的,跳过;
 * ⑤「完成」进合并窗,别的立刻。静默时段只改 `silent` 那一格,**不改打不打**。
 */
export function planCallOuts(input: CallOutPlanInput): CallOutPlan {
  const newId = input.newId ?? (() => randomUUID())
  const mergeWindowMs = input.mergeWindowMs ?? CALL_OUT_MERGE_WINDOW_MS
  const doneMaxAgeMs = input.doneMaxAgeMs ?? CALL_OUT_DONE_MAX_AGE_MS
  const quiet = inQuietHours(new Date(input.now), input.quiet.from, input.quiet.to)
  const habitId = quiet ? undefined : input.habitQuiet?.(input.now)
  const habitApplied: { id: string, item_id: string }[] = []
  const doneCall = input.doneCall === true
  const created: CallOutEntry[] = []
  const merged: { id: string, event: CallOutEvent, lead?: true }[] = []
  const seen: string[] = []
  /** 这一拍里新开的那通「完成」——同一拍里的几条完成也要并进同一通。 */
  let doneBucket = input.waiting.find(entry => entry.reason === 'done' && entry.state === 'queued')
  const askWindowMs = input.askWindowMs ?? CALL_OUT_ASK_WINDOW_MS
  /** 还排着 / 正在响的那一通「等你回答」(真响的那种):窗里新来的一问并进它。 */
  let askLive = input.waiting.find(entry => entry.reason === 'ask' && !entry.silent && (entry.state === 'queued' || entry.state === 'ringing'))
  let askRingAt = input.lastAskRingAt
  const touchQuietMs = input.touchQuietMs ?? CALL_OUT_TOUCH_QUIET_MS
  /** 他刚对这件事动过手(卡 M 补):后续的「等你确认」「等你回答」只发通知。 */
  const justTouched = (itemId: string): boolean => {
    const at = input.touchedAt?.get(itemId)
    return at !== undefined && input.now - at >= 0 && input.now - at < touchQuietMs
  }

  // 按事件时刻排,让最早发生的那一件当这一通的「主角」。
  const ordered = [...input.events].sort((a, b) => a.at.localeCompare(b.at))
  for (const event of ordered) {
    if (input.seen.has(event.key) || seen.includes(event.key)) continue
    /**
     * 「等你回答」(卡 M 追加):几分钟内接连几问只响一次。先于下面「同一件一通」那条 ——
     * 同一件事里接连两问是两问,不能因为第一问那通还在响就把第二问吞了。
     */
    if (event.reason === 'ask') {
      seen.push(event.key)
      if (!quiet && askLive !== undefined) {
        /*
         * 那一通还排着、没交给工人(房里没手机、她还没听见)→ 新的这一问领开场:她此刻等的就是它。
         * 已经在响 / 她正听着 → 照旧排到后面,不改正在说的那件。这一拍才排出来的那通不换(同一拍里最早的那一问当主角)。
         */
        const lead = askLive.state === 'queued' && input.waiting.includes(askLive)
        merged.push(lead ? { id: askLive.id, event, lead: true } : { id: askLive.id, event })
        continue
      }
      // 上一通里的问都答完了,窗就不算(2026-10-12 晚)。这一拍才响的那通不在此列:它的问还在。
      const rangThisTick = askRingAt !== input.lastAskRingAt
      const inWindow = askRingAt !== undefined && input.now - askRingAt < askWindowMs
        && (rangThisTick || askStillOpen(input.lastAskRing, input.events))
      const touched = justTouched(event.item_id)
      const byHabit = habitId !== undefined && !quiet && !touched && !inWindow
      if (byHabit) habitApplied.push({ id: habitId, item_id: event.item_id })
      const entry = entryOf({
        event,
        now: input.now,
        silent: quiet || touched || inWindow || byHabit,
        ...(quiet ? { silentReason: 'quiet' as const } : touched ? { silentReason: 'touched' as const } : inWindow ? { silentReason: 'ask' as const } : byHabit ? { silentReason: 'habit' as const } : {}),
        dueAt: input.now,
        id: newId(),
      })
      created.push(entry)
      if (!entry.silent) { askLive = entry; askRingAt = input.now }
      continue
    }
    // ② 这件事已经因为「等确认」或「运行失败」打过电话了 —— 那通电话里他已经处理过它。
    if (event.reason === 'done'
      && (input.seen.has(callOutKey('confirm', event.item_id)) || input.seen.has(callOutKey('failed', event.item_id)))) {
      seen.push(event.key)
      continue
    }
    // ③ 两天前办完的事今天才第一次被看见 —— 记下来,但别为它打电话(2026-09-22)。
    if (staleDone(event, input.now, doneMaxAgeMs)) {
      seen.push(event.key)
      continue
    }
    // ④ 这一件这一个理由还有一通没收场的(排着 / 正在响)——不叠第二通上去。
    if (liveCallFor(input.waiting, event.reason, event.item_id) !== undefined) {
      seen.push(event.key)
      continue
    }
    seen.push(event.key)
    if (event.reason === 'done' && doneBucket !== undefined) {
      merged.push({ id: doneBucket.id, event })
      continue
    }
    /**
     * 响不响。两个各自独立的理由,**夜间在前**:
     * 夜里那一通就算他把「完成也打给我」打开也不该响,而他明天想知道的是"夜里静着"。
     */
    // 卡 UX(2026-09-28):只有「他不点头就卡住」的那几件真响(判据一处,见 callOutRings)。
    const notifyOnly = !callOutRings(event, doneCall)
    const notifyWhy = !notifyOnly
      ? undefined
      : isRoutineItem(event.item_id) ? ('routine' as const) : event.reason === 'confirm' ? ('confirm' as const) : ('done' as const)
    // 卡 M 补:他刚对这件事动过手 → 这一通只发通知;只是一段回答的「等你确认」→ 也只发通知(维护者定之前的默认)。
    const touched = event.reason === 'confirm' && justTouched(event.item_id)
    const chatOnly = event.reason === 'confirm' && event.quiet === 'chat'
    // 学到的时段(她这个钟点总不接):只拦本来要响的那一通,理由排在最后。
    const byHabit = habitId !== undefined && !quiet && !notifyOnly && !touched && !chatOnly
    if (byHabit) habitApplied.push({ id: habitId, item_id: event.item_id })
    const entry = entryOf({
      event,
      now: input.now,
      silent: quiet || notifyOnly || touched || chatOnly || byHabit,
      // 几个理由同时成立时按「说得最多的」排:夜里 > 他刚动过手 > 只是一段回答 > 这一类本来就不响。
      ...(quiet
        ? { silentReason: 'quiet' as const }
        : touched
          ? { silentReason: 'touched' as const }
          : chatOnly
            ? { silentReason: 'chat' as const }
            : notifyWhy !== undefined ? { silentReason: notifyWhy } : byHabit ? { silentReason: 'habit' as const } : {}),
      // 「完成」等一个合并窗再打;别的立刻。
      dueAt: event.reason === 'done' ? input.now + mergeWindowMs : input.now,
      id: newId(),
    })
    created.push(entry)
    if (event.reason === 'done') doneBucket = entry
  }
  return { created, merged, seen, ...(habitApplied.length === 0 ? {} : { habitApplied }) }
}

/** 并一条进去(纯函数,不改原对象)。 */
export function mergeIntoEntry(entry: CallOutEntry, event: CallOutEvent): CallOutEntry {
  return {
    ...entry,
    merged: [...(entry.merged ?? []), { item_id: event.item_id, title: event.title, key: event.key }],
  }
}

/** 新的这一问当主角、原来那件排到后面(纯函数;`lead` 那一种,见 {@link CallOutPlan.merged})。 */
export function leadWithEvent(entry: CallOutEntry, event: CallOutEvent): CallOutEntry {
  const { note: _note, ask: _ask, ...rest } = entry
  return {
    ...rest,
    key: event.key,
    item_id: event.item_id,
    title: event.title,
    ...(event.note === undefined ? {} : { note: event.note }),
    ...(event.ask === undefined ? {} : { ask: event.ask }),
    at: event.at,
    merged: [{ item_id: entry.item_id, title: entry.title, ...(entry.key === undefined ? {} : { key: entry.key }) }, ...(entry.merged ?? [])],
  }
}

/**
 * **主角那一问没了、并进来的还有一问在等 → 让还在的那一问当主角**(2026-10-12)。纯函数:回换过主角的那几条。
 *
 * `mootQueuedAsks` 的第 4 条让这种一通照打(里面还有正事),可开场念的仍是主角那一问 —— 一个已经答掉的问。
 * 只动排着的 `ask`(在响的撤不回、改不了);主角的 key 还在的不动;并进来的那几问一个都不在的交给 `mootQueuedAsks` 撤。
 */
export function promoteLiveAsks(log: readonly CallOutEntry[], events: readonly CallOutEvent[]): CallOutEntry[] {
  const live = events.filter(event => event.reason === 'ask')
  const out: CallOutEntry[] = []
  for (const entry of log) {
    if (entry.reason !== 'ask' || entry.state !== 'queued' || entry.key === undefined || entry.key === '') continue
    if (live.some(event => event.key === entry.key)) continue
    const rest = entry.merged ?? []
    const index = rest.findIndex(one => live.some(event => event.item_id === one.item_id))
    if (index < 0) continue
    const event = live.find(one => one.item_id === (rest[index] as { item_id: string }).item_id) as CallOutEvent
    const { note: _note, ask: _ask, ...base } = entry
    out.push({
      ...base,
      key: event.key,
      item_id: event.item_id,
      title: event.title,
      ...(event.note === undefined ? {} : { note: event.note }),
      ...(event.ask === undefined ? {} : { ask: event.ask }),
      at: event.at,
      merged: rest.filter((_, i) => i !== index),
    })
  }
  return out
}

// ———————————————————————— 落盘 ————————————————————————

export interface CallOutFile {
  version: 1
  config: CallOutConfigView
  seen: string[]
  log: CallOutEntry[]
  /**
   * ★ **跑过哪几支迁移**(2026-10-03,卡「两条接缝」;见 `callOutMigrate.ts`)。
   * 读的时候原样带回、写的时候原样写回 —— 不然下一次保存会把标记抹掉,迁移每次启动都跑一遍。
   */
  migrated?: readonly string[]
}

export function defaultCallOutFile(home = process.env.HOME ?? ''): string {
  return `${home}/.dsh/workbench/call-out.json`
}

export function defaultCallOutConfig(): CallOutConfigView {
  return {
    enabled: true,
    quiet_from: CALL_OUT_DEFAULT_QUIET_FROM,
    quiet_to: CALL_OUT_DEFAULT_QUIET_TO,
    done_call: CALL_OUT_DEFAULT_DONE_CALL,
  }
}

export function emptyCallOutFile(): CallOutFile {
  return { version: 1, config: defaultCallOutConfig(), seen: [], log: [] }
}

const STATES: readonly CallOutState[] = ['queued', 'ringing', 'answered', 'missed', 'notified', 'failed']

/**
 * 房间名像不像样(2026-10-21):工人报上来的、台账里读回来的都过这一道。
 * 本机房间 `wb-local-…`、云房间 `wb-<16 位>`、老缺省 `workbench`,都在 `[A-Za-z0-9_-]{1,64}` 里。
 */
export function isCallRoom(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value)
}

function roomsOf(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const rooms = value.filter(isCallRoom)
  return rooms.length === 0 ? undefined : [...new Set(rooms)]
}

function sanitizeEntry(raw: unknown): CallOutEntry | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const value = raw as Record<string, unknown>
  if (typeof value.id !== 'string' || value.id === '') return undefined
  if (typeof value.item_id !== 'string' || value.item_id === '') return undefined
  if (typeof value.title !== 'string') return undefined
  if (!(CALL_OUT_REASONS as readonly string[]).includes(value.reason as string)) return undefined
  if (!(STATES as readonly string[]).includes(value.state as string)) return undefined
  const merged = Array.isArray(value.merged)
    ? value.merged.flatMap((one) => {
        const row = (one ?? {}) as Record<string, unknown>
        return typeof row.item_id === 'string' && typeof row.title === 'string'
          ? [{ item_id: row.item_id, title: row.title }]
          : []
      })
    : []
  return {
    id: value.id,
    // 卡 AQ:排它出来的那条事件的 key。老台账里没有这一格 —— 它们一通都不撤(见 `mootQueuedAsks`)。
    ...(typeof value.key === 'string' && value.key !== '' ? { key: value.key } : {}),
    reason: value.reason as CallOutReason,
    item_id: value.item_id,
    title: value.title,
    ...(typeof value.note === 'string' && value.note !== '' ? { note: value.note } : {}),
    at: typeof value.at === 'string' ? value.at : '',
    state: value.state as CallOutState,
    silent: value.silent === true,
    // 认哪几档只问 CALL_OUT_SILENT_REASONS 一处 —— 手写一串 `===` 曾经漏掉新加的两档(见那个常量的说明)。
    ...((CALL_OUT_SILENT_REASONS as readonly string[]).includes(value.silent_reason as string)
      ? { silent_reason: value.silent_reason as CallOutSilentReason }
      : {}),
    queued_at: typeof value.queued_at === 'string' ? value.queued_at : '',
    due_at: typeof value.due_at === 'string' ? value.due_at : '',
    ...(typeof value.ringing_at === 'string' ? { ringing_at: value.ringing_at } : {}),
    ...(typeof value.ended_at === 'string' ? { ended_at: value.ended_at } : {}),
    ...(typeof value.dismissed_at === 'string' && value.dismissed_at !== '' ? { dismissed_at: value.dismissed_at } : {}),
    ...(typeof value.error === 'string' && value.error !== '' ? { error: value.error } : {}),
    ...(merged.length === 0 ? {} : { merged }),
    // 按房间领那几格(2026-10-21,局域网主路):看不懂的房间名丢掉,不整条作废。
    ...(roomsOf(value.rooms) === undefined ? {} : { rooms: roomsOf(value.rooms) as string[] }),
    ...(roomsOf(value.rooms_done) === undefined ? {} : { rooms_done: roomsOf(value.rooms_done) as string[] }),
    ...(isCallRoom(value.answered_room) ? { answered_room: value.answered_room } : {}),
    ...(typeof value.answered_device === 'string' && value.answered_device !== '' ? { answered_device: value.answered_device } : {}),
    // `failed` 是哪一种(2026-10-12):记了的照记的;老台账没有这一格的按 error 原话补,认不出 `unknown`。别的状态不带。
    ...(() => {
      const kind = callOutFailKindOf({
        state: value.state as CallOutState,
        ...(typeof value.error === 'string' ? { error: value.error } : {}),
        ...((CALL_OUT_FAIL_KINDS as readonly string[]).includes(value.fail_kind as string) ? { fail_kind: value.fail_kind as CallOutFailKind } : {}),
      })
      return kind === undefined ? {} : { fail_kind: kind }
    })(),
  }
}

export function sanitizeCallOutConfig(raw: unknown, base: CallOutConfigView): CallOutConfigView {
  const value = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  const from = parseClock(value.quiet_from)
  const to = parseClock(value.quiet_to)
  return {
    enabled: typeof value.enabled === 'boolean' ? value.enabled : base.enabled,
    // 写坏了的时刻**一律回上一份**,不回一个 0 点(那会把整晚静音,而他看不出来为什么)。
    quiet_from: from === undefined ? base.quiet_from : String(value.quiet_from).trim(),
    quiet_to: to === undefined ? base.quiet_to : String(value.quiet_to).trim(),
    // 同上:不是布尔就当他没改这一项(`'是'` 不该被读成"打开")。
    done_call: typeof value.done_call === 'boolean' ? value.done_call : base.done_call,
  }
}

/** 容错读:文件缺失 / 坏了都回空,**绝不抛**(照抄 tasks.ts 的先例)。 */
export async function loadCallOutFile(file: string): Promise<CallOutFile> {
  let text: string
  try { text = await readFile(file, 'utf8') }
  catch { return emptyCallOutFile() }
  let raw: unknown
  try { raw = JSON.parse(text) }
  catch { return emptyCallOutFile() }
  if (typeof raw !== 'object' || raw === null) return emptyCallOutFile()
  const value = raw as Record<string, unknown>
  const log = Array.isArray(value.log) ? value.log.flatMap(one => sanitizeEntry(one) ?? []) : []
  const seen = Array.isArray(value.seen) ? value.seen.filter((one): one is string => typeof one === 'string' && one !== '') : []
  // 迁移标记原样带回(见 `CallOutFile.migrated`)。
  const migrated = Array.isArray(value.migrated)
    ? value.migrated.filter((one): one is string => typeof one === 'string' && one !== '')
    : undefined
  return {
    version: 1,
    config: sanitizeCallOutConfig(value.config, defaultCallOutConfig()),
    seen: seen.slice(-CALL_OUT_SEEN_MAX),
    log: log.slice(-CALL_OUT_LOG_MAX),
    ...(migrated === undefined || migrated.length === 0 ? {} : { migrated }),
  }
}

/** 原子写(tmp + rename),同 tasks.ts。 */
export async function saveCallOutFile(file: string, data: CallOutFile): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
  await rename(tmp, file)
}

// ———————————————————————— 服务 ————————————————————————

export interface CallOutService {
  load: () => Promise<void>
  /** 走一拍:现算事件 → 排电话 → 落台账。挂在 http.ts 那根既有的 1 秒节拍上,自己不起定时器。 */
  pump: () => Promise<void>
  /**
   * 手动 / 例程点名要打一通(手机上「回拨」走的就是它)。
   * **绕过「只打一次」**(他明说要打),但照旧认静默时段、认 A1 的完成策略,
   * 而且**上一通还没收场时不再排第二通**(2026-09-22)。
   */
  request: (input: { reason: CallOutReason, item_id: string, title?: string, note?: string }) => Promise<{ ok: boolean, entry?: CallOutEntry, error?: string }>
  /** 工人来领活:到点的那几通,领走即转「振铃中」。 */
  claim: (now?: number) => Promise<readonly CallOutEntry[]>
  /**
   * **按房间领**(2026-10-21,局域网主路 M2;设计稿第三节「工人的那一份」)。
   *
   * 到点的那几通转「振铃中」并记下这间房;**已经在别的房间响着、还没人接的**也交给这间房 ——
   * 工人在本机房间与云房间各一条时(卡 M6),同一通两间房都响。每间房每通只领一次。
   * 老路(`claim()`,不带房间)领走的那几通没有房间记号,不再交给按房间来领的。
   *
   * `answered_elsewhere`:这间房领过、已在**别的**房间接起、这间房还没回过话的那几通 —— 工人据此收掉自己房里的铃。
   */
  claimRoom: (room: string, now?: number) => Promise<{ calls: readonly CallOutEntry[], answered_elsewhere: readonly { id: string, room: string }[] }>
  /**
   * **先接先得**(2026-10-21):工人报「这间房里有人接起了这一通」。第一个报的定下来(`first: true`,出声);
   * 后到的回 `first: false` 与先接的那一间,工人挂掉自己这边。同一间房重报是同一个答案。
   */
  answered: (input: { id: string, room: string, device_id?: string }) => Promise<
    { ok: true, first: boolean, room?: string, device_id?: string } | { ok: false, error: string }
  >
  /** 工人回话:这通怎么收场的。 */
  /**
   * `fail_kind`(2026-10-12):`failed` 是哪一种,工人取消那一通报 `tech`、桌面停铃报 `declined`。
   * 没报就按 `error` 原话认({@link callOutFailKindOf}),认不出记 `unknown`。别的收场不带这一格。
   *
   * `room`(2026-10-21):按房间领的工人回话带上自己那间房。`answered` 等于报接起;别的收场只算**这间房**收了场,
   * 领到的房全收了场才落最终状态;已经接起的那一通不被后到的「没接」改掉。不带 `room` = 老路,一个字不变。
   */
  ack: (input: { id: string, result: 'answered' | 'missed' | 'notified' | 'failed', error?: string, fail_kind?: CallOutFailKind, room?: string }) => Promise<{ ok: boolean, error?: string }>
  /**
   * **这件事他已经答了 → 排着的那一通撤掉**(2026-09-28,卡 AQ)。`/asks/answer` 答上之后当场叫一次,
   * 不等下一拍:那家窗口重读回来之前,那一问在事实源里还挂着,而她已经答了。
   *
   * 只撤**排着的**(`queued`);正在响的撤不回来,如实回 `dropped: 0`(见 {@link mootQueuedAsks} 第 2 条)。
   * 一条都没得撤就**不写盘**(同「清空未接」那条先例)。
   */
  drop: (input: { reason: CallOutReason, item_id: string }) => Promise<{ ok: boolean, dropped: number }>
  /**
   * 手机上那颗「清空」(2026-09-22):**把眼前这几条未接收起来**。
   * 只给它们记一个 `dismissed_at`,台账一条不删 —— 见文件头第 7 条规矩。
   */
  dismissMissed: () => Promise<{ ok: boolean, dismissed: number }>
  view: () => CallOutView
  config: () => CallOutConfigView
  setConfig: (patch: unknown) => Promise<CallOutConfigView>
  /**
   * 他刚对这件事动过手(答、批、点确认 / 取消、交代、接着说;电脑上、手机上都算)—— 之后 10 分钟里同一件事的
   * 「等你确认」「等你回答」只发通知不响(卡 M 补)。只在内存里:重启之后最坏是多响一次。
   */
  touch?: (itemId: string, at?: number) => void
}

export interface CallOutServiceOptions {
  file: string
  /** 看板。没接就只剩例程那一类事件。 */
  tasks?: { list: () => Promise<TasksState> }
  /** 例程最近一次。没接就只剩事项那一类。 */
  routines?: () => RoutinesView | undefined
  now?: () => number
  mergeWindowMs?: number
  /** 「等你回答」的合并窗(缺省 {@link CALL_OUT_ASK_WINDOW_MS})。测试注入短的。 */
  askWindowMs?: number
  /** 他刚动过手之后多久不响(缺省 {@link CALL_OUT_TOUCH_QUIET_MS})。测试注入短的。 */
  touchQuietMs?: number
  newId?: () => string
  /** 台账变了就叫一声(生产:推一份快照)。 */
  onChanged?: () => void
  /** 一通收场了(工人回话的、没回话按未接记的都算)。生产:记进行为账(接没接)。不许抛。 */
  onSettled?: (entry: CallOutEntry) => void
  /** 学到的「这个时段不打电话」(`habits.quietNow`)。缺席 = 没学。 */
  habitQuiet?: (nowMs: number) => string | undefined
  /** 那一通因为学到的时段改成了只发通知(`habits.applied`)。不许抛。 */
  onHabitApplied?: (id: string, itemId: string) => void
  /**
   * 事务官在 DSH 会话里问他的话、要他批的事(2026-09-25,卡 M):现算的 `ask` 那一类事件。
   * 每一问 / 每一条一个 key(`ask:question:<id>` / `ask:approval:<id>`),`item_id` 是它挂的那张卡。缺席 = 没有这一类。
   */
  askEvents?: () => Promise<readonly CallOutEvent[]>
  /**
   * 哪几类事项办完要告诉她(2026-10-23,卡「分层第二刀一」;`dispatchPrefs.ts` 那份偏好的 `tell_scope`)。
   * 每一拍现取一次 —— 她在设置里改了勾,下一拍就照新的。缺席 / 抛错 = 缺省范围(照旧行为)。
   */
  tellScope?: () => TellScopeView
  /**
   * **这台机器装好了没有**(2026-09-23 从零重装验收第 3 件,与 routines.ts 的同名那一格是同一个判据)。
   * 回一句话 = 还没好:**自动那条一通都不排**(看板与例程的事件先不看,也不记「打过了」——
   * 装好之后该响的照响,「完成」那一类有 6 小时时效兜着,不会翻出老账)。
   * 他亲手点「回拨 / 试铃」(`request`)不拦。缺席 = 不设门。
   */
  setupGate?: () => string | undefined
}

/**
 * 上一次真响的那一通「等你回答」是什么时候排出来的(卡 M 追加)。只发了通知的、没打出去的不算。
 * 台账是按时间往后追加的,从后往前找第一条。
 */
export function lastAskRing(log: readonly CallOutEntry[]): number | undefined {
  const entry = lastAskRingEntry(log)
  return entry === undefined ? undefined : Date.parse(entry.queued_at)
}

/** 上一次真响的那一通「等你回答」本身(2026-10-12 晚;{@link lastAskRing} 只回它的时刻)。 */
export function lastAskRingEntry(log: readonly CallOutEntry[]): CallOutEntry | undefined {
  for (let i = log.length - 1; i >= 0; i -= 1) {
    const entry = log[i] as CallOutEntry
    if (entry.reason !== 'ask' || entry.silent || entry.state === 'failed' || entry.state === 'notified') continue
    if (!Number.isNaN(Date.parse(entry.queued_at))) return entry
  }
  return undefined
}

/**
 * 上一通里的问还有没有在等的(2026-10-12 晚,维护者:「现在演示等五分钟要死人的」)。纯函数。
 * 主角与并进来的几问按 key 认(同一条会话换了一问是新 key);老台账里没记 key 的按 item_id 兜底;
 * 不知道上一通是哪一通 → 当还在等(照旧的 5 分钟窗)。
 */
export function askStillOpen(rang: Pick<CallOutEntry, 'key' | 'item_id' | 'merged'> | undefined, events: readonly CallOutEvent[]): boolean {
  if (rang === undefined) return true
  const live = events.filter(event => event.reason === 'ask')
  const open = (key: string | undefined, itemId: string): boolean =>
    key === undefined ? live.some(event => event.item_id === itemId) : live.some(event => event.key === key)
  if (open(rang.key, rang.item_id)) return true
  return (rang.merged ?? []).some(one => open(one.key, one.item_id))
}

export function createCallOutService(options: CallOutServiceOptions): CallOutService {
  const now = options.now ?? (() => Date.now())
  let data: CallOutFile = emptyCallOutFile()
  let loaded = false
  /** 写队列:load→改→save 不排队会丢更新(照抄 tasks.ts / scenes.ts 的先例)。 */
  let queue: Promise<unknown> = Promise.resolve()
  /** 同一拍不并发(pump 挂在 1 秒节拍上,读看板要 I/O)。 */
  let pumping = false
  /** 他最近一次对哪件事动过手(卡 M 补,只在内存里)。 */
  const touched = new Map<string, number>()

  function enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = queue.then(fn, fn)
    queue = next.then(() => undefined, () => undefined)
    return next
  }

  async function persist(): Promise<void> {
    data = {
      ...data,
      seen: data.seen.slice(-CALL_OUT_SEEN_MAX),
      log: data.log.slice(-CALL_OUT_LOG_MAX),
    }
    try { await saveCallOutFile(options.file, data) }
    catch { /* 落不了盘只是这一次没记上,不能把整条节拍带走 */ }
    options.onChanged?.()
  }

  function settled(entry: CallOutEntry): void {
    try { options.onSettled?.(entry) }
    catch { /* 记账不能拖垮台账 */ }
  }

  /** 领了活却再没回话的那几通(工人被杀、掉线)→ 记未接。 */
  function sweepStale(at: number): boolean {
    let changed = false
    for (let i = 0; i < data.log.length; i += 1) {
      const entry = data.log[i] as CallOutEntry
      if (entry.state !== 'ringing') continue
      const started = Date.parse(entry.ringing_at ?? entry.queued_at)
      if (Number.isNaN(started) || at - started < CALL_OUT_RING_STALE_MS) continue
      /**
       * **只发通知那几条不记未接**(2026-09-28,卡 UX):它压根没响过,记成「未接来电」是在编一通
       * 没发生的电话 —— 真机 09-28 那 18 条里就有一条是这么来的。没打出去记 `failed` + 那句人话。
       */
      data.log[i] = entry.silent
        ? { ...entry, state: 'failed', ended_at: new Date(at).toISOString(), error: CALL_OUT_WORKER_SILENT_ERROR, fail_kind: 'tech' }
        : { ...entry, state: 'missed', ended_at: new Date(at).toISOString(), error: '电脑上的工人没回话,这一通按未接记' }
      settled(data.log[i] as CallOutEntry)
      changed = true
    }
    return changed
  }

  return {
    async load() {
      await enqueue(async () => {
        data = await loadCallOutFile(options.file)
        loaded = true
      })
    },

    touch(itemId, at) {
      if (itemId.trim() === '') return
      touched.set(itemId, at ?? now())
      // 只留最近一小时的(窗只有 10 分钟,留长了没用)。
      const cutoff = now() - 60 * 60 * 1000
      for (const [id, when] of touched) if (when < cutoff) touched.delete(id)
    },

    async pump() {
      if (!loaded || pumping || !data.config.enabled) return
      pumping = true
      try {
        await enqueue(async () => {
          const at = now()
          let changed = sweepStale(at)
          // 还没装好(没注册 / 引导没走完):只收拾领了活没回话的那几通,不排新的。
          if (options.setupGate?.() !== undefined) {
            if (changed) await persist()
            return
          }
          let tasks: TasksState | undefined
          /**
           * **这一拍的事实取全了没有**(2026-09-28,卡 AQ)。取不全时照旧排电话(那一层只看「有什么」),
           * 但**一通都不撤** —— 「读不到看板」跟「那一问没了」是两回事,按前者撤一通就是把一件
           * 还在等她的事悄悄抹掉。
           */
          let factsOk = true
          try { tasks = options.tasks === undefined ? undefined : await options.tasks.list() }
          catch { tasks = undefined; factsOk = false }
          const routines = options.routines?.()
          let asks: readonly CallOutEvent[] = []
          try { asks = (await options.askEvents?.()) ?? [] }
          catch { asks = []; factsOk = false }
          // 两头都没接的话「等你答」那一类压根算不出来,也就无从判断它还在不在。
          if (options.tasks === undefined && options.askEvents === undefined) factsOk = false
          let tellScope: TellScopeView | undefined
          try { tellScope = options.tellScope?.() } catch { tellScope = undefined }
          const events = [
            ...callOutEventsOf({
              ...(tasks === undefined ? {} : { tasks }),
              ...(routines === undefined ? {} : { routines }),
              ...(tellScope === undefined ? {} : { scope: tellScope }),
            }),
            ...asks,
          ]
          const askRing = lastAskRingEntry(data.log)
          const plan = planCallOuts({
            events,
            seen: new Set(data.seen),
            touchedAt: touched,
            ...(options.touchQuietMs === undefined ? {} : { touchQuietMs: options.touchQuietMs }),
            ...(askRing === undefined ? {} : { lastAskRingAt: Date.parse(askRing.queued_at), lastAskRing: askRing }),
            ...(options.askWindowMs === undefined ? {} : { askWindowMs: options.askWindowMs }),
            // 「还没收场的那几通」:排着的(合并窗要用)+ 正在响的(别在上面叠第二通)。
            waiting: data.log.filter(entry => entry.state === 'queued' || entry.state === 'ringing'),
            now: at,
            quiet: { from: data.config.quiet_from, to: data.config.quiet_to },
            doneCall: data.config.done_call,
            ...(options.mergeWindowMs === undefined ? {} : { mergeWindowMs: options.mergeWindowMs }),
            ...(options.newId === undefined ? {} : { newId: options.newId }),
            ...(options.habitQuiet === undefined ? {} : { habitQuiet: options.habitQuiet }),
          })
          for (const used of plan.habitApplied ?? []) {
            try { options.onHabitApplied?.(used.id, used.item_id) }
            catch { /* 记一笔「用上了」出错不连累来电 */ }
          }
          if (plan.seen.length > 0) { data.seen = [...data.seen, ...plan.seen]; changed = true }
          if (plan.created.length > 0) { data.log = [...data.log, ...plan.created]; changed = true }
          for (const one of plan.merged) {
            const index = data.log.findIndex(entry => entry.id === one.id)
            if (index < 0) continue
            data.log[index] = one.lead === true
              ? leadWithEvent(data.log[index] as CallOutEntry, one.event)
              : mergeIntoEntry(data.log[index] as CallOutEntry, one.event)
            changed = true
          }
          /**
           * **那一问已经不在了 → 排着的那一通撤掉**(2026-09-28,卡 AQ)。放在排完之后:
           * 这一拍新排的那几通 key 就在 `events` 里,不会自己撤自己。
           */
          if (factsOk) {
            const stamp = new Date(at).toISOString()
            // 主角那一问没了、并进来的还在等 → 先换主角(换过的就不再算「没了」,下面不撤它)。
            for (const promoted of promoteLiveAsks(data.log, events)) {
              const index = data.log.findIndex(entry => entry.id === promoted.id)
              if (index < 0) continue
              data.log[index] = promoted
              changed = true
            }
            for (const moot of mootQueuedAsks({ log: data.log, events })) {
              const index = data.log.findIndex(entry => entry.id === moot.id)
              if (index < 0) continue
              data.log[index] = { ...moot, state: 'failed', ended_at: stamp, error: CALL_OUT_MOOT_ASK_ERROR, fail_kind: 'moot' }
              changed = true
            }
          }
          if (changed) await persist()
        })
      }
      finally { pumping = false }
    },

    async request(input) {
      if (!loaded) return { ok: false, error: '来电台账还没读进来' }
      if (!(CALL_OUT_REASONS as readonly string[]).includes(input.reason)) {
        return { ok: false, error: `不认识这个理由:${String(input.reason)}` }
      }
      const itemId = input.item_id.trim()
      if (itemId === '') return { ok: false, error: '缺 item_id,不知道要为哪件事打' }
      /**
       * 手动这条**也过 A1 那道门**(2026-09-22 改)。原来放它过去的理由是
       * 「未接来电上点『回拨』是他此刻亲口要的一通电话」,但真机上那个口子把整条 A1 绕过去了:
       * 台账上七通 `reason:'done'` 全是从这儿排出去的,一分钟一通响了六分钟。
       * **拒得出声**,不是静音成一条通知 —— 他按了那颗键,得知道为什么没响,以及开关在哪。
       */
      return enqueue(async () => {
        if (input.reason === 'done' && !data.config.done_call) {
          return { ok: false, error: '「完成」这一类现在只发通知、不打电话;要它也响,到手机 设置 → 座机 打开「办完了也打电话给我」' }
        }
        /**
         * 上一通还排着 / 还在响就不再排一通(真机上五秒排了五通)。
         * **这道检查在写队列里面做** —— 连点五下是五个并发请求,在外面查就是五个都查到"没有"。
         */
        const live = liveCallFor(data.log, input.reason, itemId)
        if (live !== undefined) {
          return { ok: false, error: live.state === 'ringing' ? '这一件正在响,没有再排一通' : '这一件已经排着了,没有再排一通' }
        }
        const at = now()
        // 标题优先用现场的(手动触发多半不带),取不到就退回 id —— **不编一个标题**。
        let title = input.title?.trim() ?? ''
        if (title === '') {
          try {
            const state = options.tasks === undefined ? undefined : await options.tasks.list()
            title = state?.tasks.find(task => task.id === itemId)?.title ?? ''
          }
          catch { title = '' }
        }
        /**
         * 看板上找不到这一件时,**退回台账上同一件的上一通**(2026-09-27,卡 CB)。
         * 手机上那颗「回拨」只送 `reason` + `item_id`,而捎话回电那一类(`relay:<轻账 id>`)
         * 压根不在看板上 —— 不接这一条,回拨出去的那一通标题就是 `relay:r-1a2b3c`、
         * 一句转述也没有,等于让她照着 id 念。note 同理(那一段就是要转述给他的回话)。
         */
        let note = input.note?.trim() ?? ''
        if (title === '' || note === '') {
          for (let i = data.log.length - 1; i >= 0; i -= 1) {
            const old = data.log[i] as CallOutEntry
            if (old.item_id !== itemId || old.reason !== input.reason) continue
            if (title === '') title = old.title
            if (note === '') note = old.note ?? ''
            break
          }
        }
        const entry = entryOf({
          event: {
            key: callOutKey(input.reason, itemId),
            reason: input.reason,
            item_id: itemId,
            title: title === '' ? itemId : title,
            ...(note === '' ? {} : { note }),
            at: new Date(at).toISOString(),
          },
          now: at,
          /**
           * 手动那一通**只认夜间静默**,不认「完成只通知」那条策略(2026-09-22 A1)——
           * 未接来电上点「回拨」走的就是这一条:那是他此刻亲口要的一通电话,
           * 再把它静音成一条通知,他按下去就是按了个寂寞。
           */
          /*
           * 捎话那条路也走这儿(回电巡检排的那一通):**不用再问「这一通该不该响」** ——
           * 她没勾「回了打电话给我」的那一句压根不登记、不盯(2026-10-04),
           * 排得出来的每一通都是她要的。所以这儿只剩免打扰时段这一条。
           */
          silent: inQuietHours(new Date(at), data.config.quiet_from, data.config.quiet_to),
          silentReason: 'quiet',
          // 手动那一通**不进合并窗**:他此刻点了「打给我」,等五分钟等于没反应。
          dueAt: at,
          id: options.newId?.() ?? randomUUID(),
        })
        data.log = [...data.log, entry]
        // 手动打过也算「打过了」,不然下一拍自动那一条又来一遍(按 key 记,不是按这一通的 id)。
        const key = callOutKey(input.reason, itemId)
        if (!data.seen.includes(key)) data.seen = [...data.seen, key]
        await persist()
        return { ok: true, entry }
      })
    },

    async claim(at) {
      if (!loaded) return []
      return enqueue(async () => {
        const stamp = at ?? now()
        const iso = new Date(stamp).toISOString()
        const taken: CallOutEntry[] = []
        for (let i = 0; i < data.log.length; i += 1) {
          const entry = data.log[i] as CallOutEntry
          if (entry.state !== 'queued') continue
          const due = Date.parse(entry.due_at)
          if (!Number.isNaN(due) && due > stamp) continue
          const next: CallOutEntry = { ...entry, state: 'ringing', ringing_at: iso }
          data.log[i] = next
          taken.push(next)
        }
        if (taken.length > 0) await persist()
        return taken
      })
    },

    async claimRoom(room, at) {
      if (!loaded || !isCallRoom(room)) return { calls: [], answered_elsewhere: [] }
      return enqueue(async () => {
        const stamp = at ?? now()
        const iso = new Date(stamp).toISOString()
        const taken: CallOutEntry[] = []
        const elsewhere: { id: string, room: string }[] = []
        for (let i = 0; i < data.log.length; i += 1) {
          const entry = data.log[i] as CallOutEntry
          if (entry.state === 'queued') {
            const due = Date.parse(entry.due_at)
            if (!Number.isNaN(due) && due > stamp) continue
            const next: CallOutEntry = { ...entry, state: 'ringing', ringing_at: iso, rooms: [room] }
            data.log[i] = next
            taken.push(next)
            continue
          }
          const rooms = entry.rooms
          if (rooms === undefined) continue
          // 别的房间正响着、还没人接、这间房还没领过:也交给这间房(两间房都响)。
          if (entry.state === 'ringing' && entry.answered_room === undefined && !rooms.includes(room)) {
            const next: CallOutEntry = { ...entry, rooms: [...rooms, room] }
            data.log[i] = next
            taken.push(next)
            continue
          }
          /*
           * 只发通知的那一通(夜里 / 「完成」那一类,`silent`)每间房都该收到那条通知(2026-10-22,卡 M6):
           * 先领的那间房一领就收了场(`notified`),不能因此替别的房把通知吞了 —— 出门的手机在云房间、听筒在本机房间。
           * 通话里当场说了的那种也是 `notified`,但不是 `silent`:她已经听见了,另一间房不再响。几分钟之后进房的不再补。
           */
          if (entry.state === 'notified' && entry.silent && !rooms.includes(room)) {
            const ended = Date.parse(entry.ended_at ?? entry.ringing_at ?? entry.queued_at)
            if (Number.isNaN(ended) || stamp - ended <= CALL_OUT_RING_STALE_MS) {
              const next: CallOutEntry = { ...entry, rooms: [...rooms, room] }
              data.log[i] = next
              taken.push(next)
            }
            continue
          }
          // 在别处接起了、这间房领过还没回话:告诉它收掉自己的铃(只在铃还可能响着的那几分钟里提)。
          if (entry.state === 'answered' && entry.answered_room !== undefined && entry.answered_room !== room
            && rooms.includes(room) && !(entry.rooms_done ?? []).includes(room)) {
            const ended = Date.parse(entry.ended_at ?? entry.ringing_at ?? entry.queued_at)
            if (Number.isNaN(ended) || stamp - ended <= CALL_OUT_RING_STALE_MS) elsewhere.push({ id: entry.id, room: entry.answered_room })
          }
        }
        if (taken.length > 0) await persist()
        return { calls: taken, answered_elsewhere: elsewhere }
      })
    },

    async answered(input) {
      if (!loaded) return { ok: false, error: '来电台账还没读进来' }
      if (!isCallRoom(input.room)) return { ok: false, error: '房间名不像样' }
      return enqueue(async () => {
        const index = data.log.findIndex(entry => entry.id === input.id)
        if (index < 0) return { ok: false as const, error: '没有这一通' }
        const entry = data.log[index] as CallOutEntry
        if (entry.answered_room !== undefined) {
          return {
            ok: true as const,
            first: entry.answered_room === input.room,
            room: entry.answered_room,
            ...(entry.answered_device === undefined ? {} : { device_id: entry.answered_device }),
          }
        }
        if (entry.state === 'queued') return { ok: false as const, error: '这一通还没响' }
        // 已经收了场(老路接起的、两间房都没接的):后到的这一下不算先接。
        if (entry.state !== 'ringing') return { ok: true as const, first: false }
        const device = typeof input.device_id === 'string' && input.device_id.trim() !== '' ? input.device_id.trim().slice(0, 128) : undefined
        const next: CallOutEntry = {
          ...entry,
          state: 'answered',
          ended_at: new Date(now()).toISOString(),
          rooms: (entry.rooms ?? []).includes(input.room) ? entry.rooms ?? [input.room] : [...(entry.rooms ?? []), input.room],
          answered_room: input.room,
          ...(device === undefined ? {} : { answered_device: device }),
        }
        delete next.fail_kind
        data.log[index] = next
        settled(next)
        await persist()
        return { ok: true as const, first: true, room: input.room, ...(device === undefined ? {} : { device_id: device }) }
      })
    },

    async ack(input) {
      if (!loaded) return { ok: false, error: '来电台账还没读进来' }
      return enqueue(async () => {
        const index = data.log.findIndex(entry => entry.id === input.id)
        if (index < 0) return { ok: false, error: '没有这一通' }
        const entry = data.log[index] as CallOutEntry
        /**
         * 按房间回话(2026-10-21)。只在这一通是按房间领的(有 `rooms`)时走这条;否则照老路。
         * 「接了」等于报接起(先接先得那一道);别的收场只记这间房收了场 —— 另一间房可能还响着。
         */
        if (input.room !== undefined && isCallRoom(input.room) && entry.rooms !== undefined) {
          const room = input.room
          if (entry.state === 'ringing' && input.result === 'answered' && entry.answered_room === undefined) {
            const next: CallOutEntry = {
              ...entry,
              state: 'answered',
              ended_at: new Date(now()).toISOString(),
              answered_room: room,
              rooms: entry.rooms.includes(room) ? entry.rooms : [...entry.rooms, room],
            }
            delete next.fail_kind
            data.log[index] = next
            settled(next)
            await persist()
            return { ok: true }
          }
          const done = (entry.rooms_done ?? []).includes(room) ? entry.rooms_done ?? [] : [...(entry.rooms_done ?? []), room]
          if (entry.state !== 'ringing' || input.result === 'answered') {
            // 已经收了场(多半是别处接起了):只记这间房也回过话了,状态不动。
            data.log[index] = { ...entry, rooms_done: done }
            await persist()
            return { ok: true }
          }
          const allDone = entry.rooms.every(one => done.includes(one))
          if (!allDone) {
            data.log[index] = { ...entry, rooms_done: done }
            await persist()
            return { ok: true }
          }
          const closing: CallOutEntry = {
            ...entry,
            rooms_done: done,
            state: input.result,
            ended_at: new Date(now()).toISOString(),
            ...(input.error === undefined || input.error === '' ? {} : { error: input.error }),
          }
          delete closing.fail_kind
          const closingKind = callOutFailKindOf({ ...closing, ...(input.fail_kind === undefined ? {} : { fail_kind: input.fail_kind }) })
          if (closingKind !== undefined) closing.fail_kind = closingKind
          data.log[index] = closing
          settled(closing)
          await persist()
          return { ok: true }
        }
        const next: CallOutEntry = {
          ...entry,
          state: input.result,
          ended_at: new Date(now()).toISOString(),
          ...(input.error === undefined || input.error === '' ? {} : { error: input.error }),
        }
        delete next.fail_kind
        const failKind = callOutFailKindOf({ ...next, ...(input.fail_kind === undefined ? {} : { fail_kind: input.fail_kind }) })
        if (failKind !== undefined) next.fail_kind = failKind
        data.log[index] = next
        settled(data.log[index] as CallOutEntry)
        await persist()
        return { ok: true }
      })
    },

    /**
     * 他已经答了这一件 → 排着的那一通撤掉(卡 AQ)。只碰 `queued`;正在响的如实回 0。
     * 台账一条不删,记成「没打出去」+ 那一句人话 —— 同桌面上按「停铃」那个先例。
     */
    async drop(input) {
      if (!loaded) return { ok: false, dropped: 0 }
      const itemId = input.item_id.trim()
      if (itemId === '') return { ok: false, dropped: 0 }
      return enqueue(async () => {
        const stamp = new Date(now()).toISOString()
        let dropped = 0
        for (let i = 0; i < data.log.length; i += 1) {
          const entry = data.log[i] as CallOutEntry
          if (entry.state !== 'queued' || entry.reason !== input.reason || entry.item_id !== itemId) continue
          data.log[i] = { ...entry, state: 'failed', ended_at: stamp, error: CALL_OUT_MOOT_ASK_ERROR, fail_kind: 'moot' }
          dropped += 1
        }
        // 一条都没得撤就不写盘、不推快照(他一道题一道题地答时,这一路每答一道都会来一次)。
        if (dropped === 0) return { ok: true, dropped: 0 }
        await persist()
        return { ok: true, dropped }
      })
    },

    async dismissMissed() {
      if (!loaded) return { ok: false, dismissed: 0 }
      return enqueue(async () => {
        const result = dismissMissedEntries(data.log, now())
        // 一条都没得收就**不写盘**:他按两下不该换来两次落盘、两次推快照。
        if (result.dismissed === 0) return { ok: true, dismissed: 0 }
        data.log = [...result.log]
        await persist()
        return { ok: true, dismissed: result.dismissed }
      })
    },

    view() {
      // 最近的在前:界面上「刚刚那一通」永远在第一条。
      const entries = [...data.log].reverse()
      return {
        config: data.config,
        entries,
        /**
         * **收过的不数**(2026-09-22):条目照旧在 entries 里,只是不再挂在他眼前。
         * **只发过通知的也不数**(2026-09-28,卡 UX):「未接来电 N」数的必须是**真打过、他没接**的那几通;
         * 一条只弹了通知的进这个数,他看到的就是一个不存在的来电。台账一条不删,entries 里照旧看得见。
         */
        missed: entries.filter(entry => entry.state === 'missed' && !entry.silent && entry.dismissed_at === undefined).length,
      }
    },

    config: () => data.config,

    async setConfig(patch) {
      return enqueue(async () => {
        data.config = sanitizeCallOutConfig(patch, data.config)
        await persist()
        return data.config
      })
    },
  }
}
