/**
 * 座机主动来电在**工人这一侧**的那一半(2026-09-21)。
 *
 * 8791 决定「该不该打、打哪一件」(workbench-plugin/src/server/callOut.ts);
 * 这个文件只管**响铃那一段**:往房里广播一条 `ring`、等手机说「接起来了」、
 * 60 秒没人接就记未接。接起来之后说什么、怎么落决定,在 agent.ts 里接线。
 *
 * ## 为什么「先响,等接起,再开口」,而不是进房就说
 *
 * 一通电话和一条通知的区别全在这儿。工人是**常驻**房间的,手机也可能一直在房里
 * (座机模式),所以「房里有人」根本不等于「他在听」——他可能在厨房、手机扣在桌上。
 * 进房就说等于对着空屋子念一段话,而且 09-18 已经踩过一次同款
 * (`session.say(welcome)` 排在音频队列里,等下一台手机进来才出声,于是引导前先听见「你说」)。
 *
 * 所以:**广播 ring → 手机响 → 他按「接起」→ 手机回一条 answer → 这才开口**。
 * 中间没有任何时间窗可赌。
 *
 * ## 这个文件里没有 LiveKit
 *
 * 发一条消息是一个 `send(line: string)` 回调,计时是一个可注入的 setTimeout。
 * 所以振铃状态机可以在单测里跑完「接起 / 超时 / 取消」三条路,不用起房间。
 */

import { plainFailureWhy } from './spokenSafe.ts'

/** 振铃多久没人接就算未接。60 秒 —— 和一台真座机差不多,再长他会以为手机坏了。 */
export const RING_TIMEOUT_MS = 60_000

/**
 * 打电话的理由。与 workbench-plugin/src/protocol.ts 的 `CallOutReason` **逐字相同**。
 * `ask`(2026-09-25,卡 M):事务官在 DSH 会话里问他一件事 / 要他批一件事,那件事正停着等他。
 */
export type RingReason = 'confirm' | 'failed' | 'done' | 'ask' | 'relay'

/**
 * 界面与电话里那一行。与 workbench-plugin 的 `CALL_OUT_REASON_TITLES` **逐字相同** ——
 * 两端各写一份迟早会漂,而这几个字同时出现在她的嘴里和他的屏幕上。
 * (两个仓库不互相 import,这是本仓库既有的做法,见 rpc.ts 顶部那几个 topic 常量。)
 */
export const RING_REASON_TITLES: Record<RingReason, string> = {
  confirm: '等你确认',
  failed: '运行失败',
  done: '完成',
  ask: '等你回答',
  relay: '回话来了',
}

/**
 * **通话里当场说的那一句**(2026-09-27,卡 MS)。
 *
 * 21:23 那一通:派给豆包没派出去,8791 排了一通「运行失败 · 只发通知」,工人把它当成一通来电广播进房,
 * **正在进行的那通电话就被收了场** —— 他还举着听筒,结果这一条他一个字都没听到。
 * 维护者:「通话中出了结果(成功或失败)要在这通电话里直接说,绝不能结束当前通话」。
 *
 * 这一句**由代码从事实拼**(不经模型、不编):理由 + 事项名,**一句短话**。
 * 它接在她正说的话后面,是一句插话,所以要短。
 *
 * ## ★ 2026-10-13 下午(卡 A 第 3、4 条):去掉字面「插一句:」,`note` 不再原样接上
 *
 * 维护者两次点名(09-29「又来一个什么插一句」、10-13「总是说插一句」):那三个字是**写法上的占位**,
 * 真人插话不会先报一声「插一句」。现在直接说那件事(`relay` 那一支留着「对了,」—— 它本来就是口语的转折)。
 *
 * `note` 是 8791 写给**界面**的一行(「…已经推到你手机上,接起来就能看;存在选题「…」的素材文件夹里」、
 * 「到上限了,先停下来了:花了约 0.51 元 · 跑了 6 分钟 · 走了 51 步」)。接在嘴里就是把内部口径念出去,
 * 所以这一版**只从 `note` 认几个事实**({@link atBudgetLimit} / {@link pushedToPhone}),一个字都不抄。
 * 代价写清楚:他在通话里听到的比从前少,细节要他问一句 —— 那比听一段界面文案强。
 */
export function inCallAnnounceText(call: RingCall): string {
  /** 这件事怎么称:标题里的事项名优先,格式字眼与书名号在 `plainRingSubject` 一处剥掉。 */
  const { subject, what } = plainRingSubject(call.title)
  const thing = subject === undefined || subject === '' ? what : subject
  switch (call.reason) {
    case 'relay': {
      /*
       * 2026-09-28 22:1x(Air 维护包):超时的跟踪也走这一句,不再一律说「它回了」。
       * **2026-10-13 一个字没动**:它本来就没有「插一句:」那三个字,而那段回话正文
       * (`note`)正是这一通要带给他的东西 —— 这一支不在今天的毛病里。
       */
      const what = call.note === undefined || call.note.trim() === '' ? '' : `:${call.note.trim()}`
      return `对了,${call.title} 的跟踪结果${what || ':暂时没有可读结果'}。`
    }
    /*
     * ★ **没成那一句只念一句人话**(2026-09-28,卡 CF 第 6、8 条)。
     *
     * 真机上念出来的是:「插一句:『让豆包工作帮我查一下国庆节放几天假;① 归豆包工作办 ② …』没成:
     * 派给 豆包办公 没派出去:窗口:这台电脑上还没接上 doub」—— 整条标题(连三条确认点)+ 内部前缀
     * + 截断的包标识。维护者:「太啰嗦了……又来一个什么插一句」。
     *
     * 现在:**有原因就只说原因**(`plainFailureWhy` 收拾成一句人话),标题一个字都不念;
     * 一句原因都拿不到时才退回标题(那时标题是唯一说得出的东西)。
     */
    case 'failed': {
      const why = plainFailureWhy(call.note)
      return why === undefined
        ? `${sayWithThing(thing, '没成。', 3)}你说下一步怎么办。`
        : `${why}。你说下一步怎么办。`
    }
    case 'ask':
      /*
       * ★ **预算到上限那一种说成人话**(2026-10-13 下午,卡 A 第 4 条)。
       * 14:17 那一通念出去的是:「插一句:「20号发大赛回顾视频」这会儿等你一句话:到上限了,
       * 先停下来了:花了约 0.51 元 · 跑了 6 分钟 · 走了 51 步(上限 0.5 元 / 10 分钟)」——
       * 钱、分钟、步数是**内部口径**(看板上给他看的那一行),不念给听筒。
       */
      if (atBudgetLimit(call.note)) return `${sayWithThing(thing, BUDGET_STOPPED_TAIL, [...BUDGET_STOPPED_TAIL].length)}${BUDGET_ASK_TAIL}`
      // 别的「等你一句话」:同样不念 `note`(那一格是写给界面的)。他问细节再往下说。
      return sayWithThing(thing, '等你一句话。', 6)
    case 'confirm':
      /*
       * ★ **办完了那一句固定成一句短的**(2026-10-13 下午,卡 A 第 3 条)。
       * 14:22 那一通念出去的是:「…办完了,等你验收:视频好了,已经推到你手机上,**接起来就能看**;
       * 存在选题「…」的素材文件夹里」—— 「接起来就能看」是写给来电页的话,人在通话里听着不通;
       * 标题还套了两层书名号。
       */
      return pushedToPhone(call.note)
        ? `${sayWithThing(thing, '办完了。', 4)}${PUSHED_TO_PHONE_TAIL}`
        : sayWithThing(thing, '办完了。', 4)
    default:
      return sayWithThing(thing, '办完了。', 4)
  }
}

/**
 * 通话里插的那一句最长多少字(每句单独算)。25 —— 与固定流程那条纪律同一个数
 * (插件 `demoPlaybook.ts` 的 `DEMO_SAY_MAX_CHARS`;两个仓库不互相 import,所以这里一份)。
 * 超了**只掐事项名**,固定那半句一个字不动:掐掉「你说下一步怎么办」比掐掉事项名更坏。
 */
export const IN_CALL_SAY_MAX_CHARS = 25

/** 「「<事项>」+ 固定那半句」。事项名掐到让这一句不超上限;没有事项名就只说固定那半句。 */
function sayWithThing(thing: string, tail: string, tailChars: number): string {
  const name = (thing ?? '').trim()
  if (name === '') return tail
  // 「」两个字 + 固定那半句,剩下的才是事项名能占的。
  const room = IN_CALL_SAY_MAX_CHARS - tailChars - 2
  if (room < 4) return tail
  const chars = [...name]
  const said = chars.length <= room ? name : `${chars.slice(0, room - 1).join('')}…`
  return `「${said}」${tail}`
}

/** 一句话掐到上限(没有事项名可掐的那几句)。 */
function clipSay(line: string): string {
  const chars = [...line.replace(/\s+/g, ' ').trim()]
  return chars.length <= IN_CALL_SAY_MAX_CHARS ? chars.join('') : `${chars.slice(0, IN_CALL_SAY_MAX_CHARS - 1).join('')}…`
}

/** 预算到上限那一种,说的两句。拆两句是为了每句都短(见 {@link IN_CALL_SAY_MAX_CHARS})。 */
const BUDGET_STOPPED_TAIL = '花到上限先停了。'
const BUDGET_ASK_TAIL = '接着做、停掉,还是换人?'
/** 片子已经推到手机上那一种,补的那半句。 */
const PUSHED_TO_PHONE_TAIL = '片子在你手机上了。'

/**
 * 这一条是「跑到预算上限停下来了」吗。**只认 note 里那几个字**,一分钱都不念出去
 * (8791 那头把钱 / 分钟 / 步数拼在同一行里,见 14:17 那一通)。
 */
export function atBudgetLimit(note: string | undefined): boolean {
  const said = (note ?? '').trim()
  return said !== '' && /到(了)?上限|超(出|过)?预算|上限.*(先)?停/u.test(said)
}

/** 这一条是「片子已经推到他手机上了」吗(同上:只认那几个字,不念 note)。 */
export function pushedToPhone(note: string | undefined): boolean {
  const said = (note ?? '').trim()
  return said !== '' && /(推到|推送到|送到|已经在)你?手机/u.test(said)
}

/** 8791 交下来的一通。字段是 `CallOutEntry` 的一个子集(工人只要念得出来的那几样)。 */
export interface RingCall {
  id: string
  reason: RingReason
  item_id: string
  title: string
  note?: string
  at: string
  /**
   * 排出来就不响的:手机收到只发通知,**不响铃、不弹来电页**。
   * 两个来源(夜间静默时段、「完成」那一类 —— 2026-09-22 Ben 定的 A1),
   * **工人不区分**:它只管响不响。为什么不响记在 8791 的台账里(`silent_reason`)。
   */
  silent: boolean
  /**
   * 并进这一通的其它几件:「完成」那一类 5 分钟里的几件;「等你回答」那一类 5 分钟里接连来的几问
   * (2026-09-25,卡 M 追加:接连几问只响一次,电话里一问一问答下去)。
   */
  merged?: readonly { item_id: string, title: string }[]
  /**
   * 别家窗口里那道题的原话(2026-10-12;与 workbench-plugin `CallOutEntry.ask` 同形)。
   * 有它 = 开场逐字念「谁在问 + 问题 + 选项」;老 8791 不带,照旧那一句。
   */
  ask?: RingAskText
}

export interface RingAskText {
  from: string
  question: string
  options: readonly string[]
  /**
   * ★ **这是一个权限弹窗**(2026-10-13;与 `CallOutAskText.permission` 同形)。
   * 她答的是「批准 / 拒绝」,不是选项里的某一条 —— 开场那一句照这一格收尾。
   */
  permission?: true
}

/** 工人 → 手机,广播:**电话来了**。 */
export interface RingSignal {
  type: 'ring'
  call_id: string
  reason: RingReason
  item_id: string
  title: string
  note?: string
  at: string
  silent: boolean
  merged?: readonly { item_id: string, title: string }[]
  /** 响到什么时候为止(毫秒时间戳)。手机据此自己也能倒计时,不必只等工人那条 ring_end。 */
  until: number
}

/**
 * 一通电话的收场。与 8791 的 `POST /call/ack` 认的那几个词**逐字相同**:
 * `notified` 是只发通知那一种(夜间静默,或者「完成」那一类)—— 它没响过,
 * 所以既不是「接了」也不是「没接」。
 *
 * **`hung_up` 不在这里面**,见下面 {@link RingHangupOutcome}:它不是一通电话的收场。
 */
export type RingOutcome = 'answered' | 'missed' | 'canceled' | 'notified'

/**
 * **这通已接的电话结束了**(2026-09-22,待拍板 E1「话筒挂机让工人广播一条信号」)。
 *
 * 为什么要它:座机形态下接电话的可能是树莓派上那只实体话筒,而屏在手机上
 * (决策记录 2026-09-21「座机形态」)。话筒挂机时工人以前只是把自己这一侧停了,
 * **一个字都不广播** —— 于是手机上那面「字幕 + 挂断」一直留着,要他伸手按一下才收。
 * 而座机的整个意思正是「手不用碰手机」。
 *
 * 为什么另起一个词而不复用 `canceled`:`canceled` 的意思是「这一通没打成」(掉线、
 * 工人退出),台账上记成 `failed`。一通接起来、聊完了、放下听筒的电话不是没打成的电话 ——
 * 把两件事写成同一个词,台账上就会出现一条与事实不符的记录(D13)。
 *
 * **它只活在广播里,不进台账**:这一通在接起来那一刻就已经 ack 成 `answered` 了,
 * 8791 的 `/call/ack` 压根不认识 `hung_up`,所以这条路上不再 ack 第二次。
 */
export type RingHangupOutcome = 'hung_up'

/**
 * **房里那台设备是什么**(2026-09-22 晚)。与 rpc.ts 的 `ParticipantKind` 逐字相同 ——
 * 两个文件不互相 import(callOut.ts 刻意不认识 LiveKit,那是它能被单测跑完的前提)。
 *
 * 它出现在两处:**谁接的**(`answer`)与**谁挂的**(`hangup`)。
 */
export type RingDeviceKind = 'phone' | 'handset'

/**
 * 挂断是谁发起的(2026-09-22)。三条路各走各的:
 *
 * - `phone`:**手机自己按的挂断**。它本来就知道,广播回去只是一条回声 —— **不发**。
 * - `handset`:树莓派上那只实体话筒挂机(叉簧压回去)。手机不知道,**要发**。
 * - `worker`:工人自己补的那一刀(房里没人了,见 agent.ts 的 relinkSpeaker)。**要发** ——
 *   房里通常已经没人听了,但一条如实的广播不该看有没有人听才发。
 */
export type RingHangupBy = RingDeviceKind | 'worker' | 'butler'

/**
 * `butler`(2026-09-23 晚,维护者真机 0.2.73「说了拜拜之后没有真的拜拜」):**她道过别、由她挂的**。
 * 工人这一侧的第四条路(模型调了 `wb_end_call`,等她那句道别播完才挂,见 farewell.ts)。
 *
 * **线上它不是一个新词**:老手机(0.2.73 包)的解析只认 `phone`/`handset`/`worker`,
 * 认不得的整条丢掉 —— 那样话筒那一面就收不掉了。所以:
 *   - `ring_end{hung_up}` 上**不带 `by`**(同 `worker`:她不是一台设备),只换那一句人话;
 *   - `call_state{idle}` 上写 `by:'worker'`(见 {@link createCallState} 的 `leave`)。
 * 「是她挂的」由那句人话与工人日志说清楚。
 */

/** 广播 `hung_up` 时附的那一句人话。原样显示,手机不套一层。 */
/**
 * 这一通在**别的房间**先接起了(2026-10-22,局域网主路 M6):本机房间与云房间各一条工人、同一通两边都响,
 * 后到的那一边收铃时房里那条 `ring_end{canceled}` 带的一句话。手机与听筒收到 `canceled` 都回待机。
 */
export const ANSWERED_ELSEWHERE_TEXT = '在别处接起了'

export const RING_HANGUP_TEXTS: Record<Exclude<RingHangupBy, 'phone'>, string> = {
  handset: '听筒放回去了,这一通结束了',
  worker: '房里没人了,这一通结束了',
  butler: '她道过别,挂了',
}

/** 工人 → 手机,广播:**这一通完了**(他接了 / 没接 / 被取消 / 挂了)。手机据此收掉来电页。 */
export interface RingEndSignal {
  type: 'ring_end'
  call_id: string
  /**
   * `notified` **不会出现在这条消息里** —— 只发通知那一通压根没响过,
   * 手机收到的是 ring 里的 `silent:true`,从来没有一个来电页要收掉。
   *
   * `hung_up` 反过来**只**出现在这条消息里(见 {@link RingHangupOutcome}):
   * 同一个 `call_id` 上它排在 `answered` 之后 —— 先「接起来了」,后「挂了」。
   */
  outcome: Exclude<RingOutcome, 'notified'> | RingHangupOutcome
  /**
   * **是谁接的 / 是谁挂的**(2026-09-22 晚,Ben:「响铃应该是手机发出,话筒自己是用来对话的」)。
   *
   * 0921 那版**刻意没有这一格**(交接-0921 第十节第 5 条:「手机能推断,够用」)——
   * 手机拿「我自己还在响着却收到 answered」推断「那是别人接的」。今天这条推断不够用了:
   * 手机据此还要决定**自己的扬声器开不开、麦克风推不推**,而一条推断出来的结论
   * 一旦推错,后果是「他对着话筒说话,声音却从手机里出来」——那正是 Ben 20:50 在真机上
   * 看到的那一幕。所以这一格明着写出来:**谁接的,就归谁说话**。
   *
   * 老手机(还没换包的那个版本)收到它只是多一个读不懂的字段,照旧走那条推断。
   */
  by?: RingDeviceKind
  /**
   * **接起的那一台的房间身份**(2026-09-23 晚,维护者真机「手机接起来没声」)。只在 `answered` 上带。
   *
   * 这一条广播**先于**给接起那台的 RPC 回话到达(同一条通道按序读),手机只凭 `by:'phone'`
   * 分不清「是我自己」还是「房里另一台手机」。带上 identity,它一比就知道。
   * 老手机不认这一格也不坏(多一个字段)。
   */
  by_identity?: string
  /** 一句人话(未接、他按了稍后、工人要退出了、听筒放回去了)。原样显示,不套一层。 */
  text?: string
}

/**
 * **这会儿房里在不在通话中**(2026-09-23,Ben 12:45 真机 0.2.68 的原话:
 * 「我拿起话筒确实是打出去了,但是手机上没有变化,这不对,打过来和打过去
 * 都应该是显示同一个页面。」)。
 *
 * ## 为什么 `ring` 那一族不够用
 *
 * 来电那条路本来就是齐的:`ring` → 话筒接 → `ring_end{answered, by:'handset'}` →
 * 手机进「话筒通话中 · 挂断」那一面。**拨出那条一个字都没广播**:待机提机走的是
 * `call/start` → `greet()`,工人只是开了个场,房里没有任何信号,于是手机什么都不知道。
 *
 * 那两条不能靠 `ring_end` 凑齐:`ring_end` 说的是「**那一通铃**是怎么收场的」,
 * 而他自己拨出去的这一通**压根没有铃**,也没有 `call_id`。硬给它编一个 `ring_end`
 * 就是在台账口径上说假话(同 `hung_up` 另起一个词的理由,D13)。
 *
 * 所以另起一条**只说一件事**的信号:**这会儿在不在通话里、是哪一台在通话**。
 * 三个时刻各广播一次:话筒拨出接通、话筒接起来电、这一通挂断(谁挂的都算,
 * 含超时与掉线那一刀)。`ring` / `ring_end` 一个字没改 —— 来电那条路照旧走它们,
 * 老手机(还没换包的那个版本)收到 `call_state` 只是多一条读不懂的消息。
 */
export interface CallStateSignal {
  type: 'call_state'
  /** `in_call` = 这会儿有人在跟她通话;`idle` = 刚才那一通结束了。 */
  state: 'in_call' | 'idle'
  /**
   * 通话的 / 挂断的是哪一台。`worker` 只出现在 `idle` 上(房里没人了、工人退出),
   * 它不是一台设备 —— 同 {@link RingHangupBy} 那条。
   */
  by: RingDeviceKind | 'worker'
  /** 来电沿用振铃编号；主动拨出时保留调用方传来的编号，旧调用方未传时缺席。 */
  call_id?: string
  /** 这一通从什么时候起(毫秒)。手机上那行「从 HH:MM 起」读的正是它。 */
  started_at: number
  /** 通话的那一台的房间身份(只在 `in_call` 上、知道时才带)。同 {@link RingEndSignal.by_identity}。 */
  by_identity?: string
}

export function encodeRingSignal(signal: RingSignal | RingEndSignal | CallStateSignal): string {
  return JSON.stringify(signal)
}

export interface CallStateDeps {
  /** 往房里广播一行 JSON。发不出去只记日志 —— 同振铃状态机那条。 */
  send: (line: string) => void
  now?: () => number
  log?: (line: string) => void
}

export interface CallStateBroadcaster {
  /**
   * **有人开始跟她通话了**。返回真的广播了没有。
   *
   * **已经在通话里就一条都不发**(幂等):同一通电话被宣布两遍,手机那一面就会
   * 收一次、重画一次 —— 而他正看着字幕。`call/start` 与 `call/answer` 两条路
   * 都可能落到同一通上(提机的那一下先到、接起那一条随后到),所以这道门必须在这儿。
   */
  enter: (by: RingDeviceKind, callId?: string, identity?: string) => boolean
  /** **这一通结束了**。没有在通话里就一条都不发 —— 不能凭空宣布一通电话挂了。 */
  leave: (by: RingHangupBy) => boolean
  /** 这会儿在通话里的是哪一通(没有就 undefined)。 */
  current: () => { by: RingDeviceKind, callId?: string, startedAt: number } | undefined
}

export function createCallState(deps: CallStateDeps): CallStateBroadcaster {
  const now = deps.now ?? (() => Date.now())
  const log = deps.log ?? (() => {})
  let live: { by: RingDeviceKind, callId?: string, startedAt: number } | undefined

  /** 发一条。**抛了就当没发出去**:房间那条路随时可能断,而一次抛能把工人带走。 */
  function send(signal: CallStateSignal): boolean {
    try { deps.send(encodeRingSignal(signal)) }
    catch (err) {
      log(`[channel-worker] 通话状态没广播出去:${(err as Error)?.message ?? '没说原因'}`)
      return false
    }
    return true
  }

  return {
    enter(by, callId, identity) {
      // 已经在通话里:一个字都不再发(见 CallStateBroadcaster.enter 上那一段)。
      if (live !== undefined) return false
      const startedAt = now()
      const ok = send({
        type: 'call_state',
        state: 'in_call',
        by,
        ...(callId === undefined || callId === '' ? {} : { call_id: callId }),
        started_at: startedAt,
        ...(identity === undefined || identity === '' ? {} : { by_identity: identity }),
      })
      // 没发出去就**不记成已宣布**:下一次还能再宣布一遍,而不是永远卡在「广播过了」。
      if (!ok) return false
      live = { by, ...(callId === undefined || callId === '' ? {} : { callId }), startedAt }
      log(`[channel-worker] 房里开始通话(${by === 'handset' ? '话筒' : '手机'})${callId === undefined ? '' : `:${callId}`}`)
      return true
    },

    leave(by) {
      const call = live
      if (call === undefined) return false
      live = undefined
      const ok = send({
        type: 'call_state',
        state: 'idle',
        // 她道别挂的那一种在线上写成 `worker`:老手机只认那三个词(见 RingHangupBy 上那一段)。
        by: by === 'butler' ? 'worker' : by,
        ...(call.callId === undefined ? {} : { call_id: call.callId }),
        // 起始时刻带的是**这一通**的(不是此刻)——手机上那行「从 HH:MM 起」对得上。
        started_at: call.startedAt,
      })
      if (!ok) return false
      log(`[channel-worker] 房里这一通结束了${by === 'butler' ? '(她道过别,由她挂的)' : ''}`)
      return true
    },

    current: () => live,
  }
}

/** 8791 回来的一条 → RingCall。**读不懂就 undefined**,绝不抛(它跨进程来)。 */
export function parseRingCall(raw: unknown): RingCall | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const value = raw as Record<string, unknown>
  if (typeof value.id !== 'string' || value.id === '') return undefined
  if (typeof value.item_id !== 'string' || value.item_id === '') return undefined
  if (typeof value.title !== 'string') return undefined
  const reason = value.reason
  if (reason !== 'confirm' && reason !== 'failed' && reason !== 'done' && reason !== 'ask' && reason !== 'relay') return undefined
  const merged = Array.isArray(value.merged)
    ? value.merged.flatMap((one) => {
        const row = (one ?? {}) as Record<string, unknown>
        return typeof row.item_id === 'string' && typeof row.title === 'string'
          ? [{ item_id: row.item_id, title: row.title }]
          : []
      })
    : []
  const ask = parseRingAsk(value.ask)
  return {
    id: value.id,
    reason,
    item_id: value.item_id,
    title: value.title,
    ...(typeof value.note === 'string' && value.note !== '' ? { note: value.note } : {}),
    at: typeof value.at === 'string' ? value.at : '',
    silent: value.silent === true,
    ...(merged.length === 0 ? {} : { merged }),
    ...(ask === undefined ? {} : { ask }),
  }
}

function parseRingAsk(raw: unknown): RingAskText | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const value = raw as Record<string, unknown>
  const from = typeof value.from === 'string' ? value.from.trim() : ''
  const question = typeof value.question === 'string' ? value.question.trim() : ''
  if (from === '' || question === '' || !Array.isArray(value.options)) return undefined
  const options = value.options.filter((one): one is string => typeof one === 'string' && one.trim() !== '').map(one => one.trim())
  return { from, question, options, ...(value.permission === true ? { permission: true as const } : {}) }
}

/**
 * **别家那道题,逐字念**(2026-10-12,维护者周三演示:「事务官问的就是豆包那道题、念出那几个选项」)。
 *
 * 09-23 定的「开场不念标题、不摆选项」说的是**我们自己写的标题**(写给眼睛看的公文)。别家问她的那道题不一样:
 * 那是对方的原话,她要照着它答、答案要落回对方那个框里 —— 转述改一个字,她就对不上屏幕上的选项。
 * 所以这一种开场就是题本身:谁在问 + 问题原话 + 选项,最后一句「你选哪个?」。
 */
export function askOpenerText(who: string, ask: RingAskText): string {
  const question = ask.question.trim()
  const head = `${who},${ask.from}在问你:${question}`
  const sepOf = (): string => (/[？?。!！]$/u.test(question) ? '' : '。')
  /*
   * ★ **权限弹窗那一种**(2026-10-13):她答的是批 / 不批,**不念选项**(那两颗键就是「允许 / 拒绝」)。
   * 从前 8791 对这一种压根不带 `ask`,于是开场只剩一句「有件事要问你一下」——
   * 维护者 10-13 上午:「接起来也不说事,还要我来问」。现在同一句就把事说清。
   */
  if (ask.permission === true) return `${head}${sepOf()}等你批,行不行?`
  if (ask.options.length === 0) return `${head}${/[？?]$/u.test(question) ? '' : '。'}你怎么回它?`
  const sep = sepOf()
  const list = ask.options.length === 1
    ? ask.options[0]
    : `${ask.options.slice(0, -1).join('、')},还是${ask.options[ask.options.length - 1]}`
  return `${head}${sep}有这几个:${list}。你选哪个?`
}

/**
 * 这一通该不该真响(2026-09-27,卡 WY)。
 *
 * 维护者 09-27 原话:「为什么叫等你,是因为**这件事我不点头,不给反馈就卡住**,而其他的事项是做完了告知我。」
 * 座机只为「等你」响,而「等你」只放卡住的事 —— 事务官自己的提议(「这张派给 X 开工?」「进度要你说一句」
 * 「要加上吗:…」)不在其中。判断在 8791(workbench-plugin/src/waiting.ts 与 `askCallOutEvents`),
 * 这里是**兜底的那一道**:手机 / 工人先于工作台升级时,老 8791 照旧会把这几通交下来,不该让座机替它响。
 *
 * 判据只认那一行**话**(工人拿到的就是 `title` / `note`,没有会话 id),所以写得很死:多认一条都可能吞掉真的。
 * 不响 = 当它没发生过(不进未接来电):那不是一通他错过的电话,是一条本来就不该打的。
 */
const PROPOSAL_RING_TITLES: readonly RegExp[] = [
  /问你:进度要你说一句/,
  /要你批:这张派给/,
  /^「?要加上吗[:：]/,
]

export function shouldRing(call: Pick<RingCall, 'reason' | 'title'>): boolean {
  if (call.reason !== 'ask' && call.reason !== 'confirm') return true
  return !PROPOSAL_RING_TITLES.some(re => re.test(call.title))
}

/**
 * 接起来那一刻她说的第一句。**由工人逐字念,不经模型** —— 同开场白那一条(交接-0918 第二节):
 * 定死的一句话不需要等模型,而这一句正好是电话里最要紧的一句。
 *
 * ## ★ 2026-10-13:开场同一句就把事说清(维护者收回 09-23 那一套)
 *
 * 维护者 10-13 上午原话:
 *
 * > 「接起来也不说事,还要我来问,问完她垫了一句我想想,我气笑了。」
 *
 * 09-23 她定的是「开场只说一句『有个事要跟你确认一下』,那件事等他接话再由模型用人话说」——
 * 理由是「念标题就是公文」。真机跑下来的样子是:她接起来听见一句没有内容的话,**得自己问一声**
 * 「什么事?」,而那一问要等模型(act 回合中位 8 秒),中间还垫一句「我想想」。
 * 一通电话从头到尾三个来回才说出是什么事。
 *
 * 所以这一版:**称呼 + 这件事是什么 + 她要做什么,一句话说完,不经模型、不垫场。**
 * 「不念公文」那条规矩留着 —— 办法是把标题里的格式字眼(`「…」`、`要你批:`、`问你:`)
 * **拆开再按理由拼成人话**({@link plainRingSubject}),而不是把整行标题念出去。
 * 代价写清楚:这一句比从前长(上限 {@link RING_OPENER_MAX_CHARS} 字),拼得难看的时候
 * 她听到的是一句有点生硬的话 —— 那比听一句没有内容的话强。
 *
 * 称呼由 {@link RingOpenerOptions.address} 给(人设里那张称呼表轮出来的,见 address.ts);
 * 不给就用表上第一个,**绝不直呼其名**。
 */
export interface RingOpenerOptions {
  /** 这一通叫他什么(`nextAddress` 的结果)。不给就是「老板」。 */
  address?: string
}

/** 开场那一句最长这么多字(连称呼)。TTS 流在长句上卡过(10-13 早真机),写长了不如说不清。 */
export const RING_OPENER_MAX_CHARS = 42

/**
 * 把一行标题拆成「哪件事 + 她要做什么」。**格式字眼只在这一处认**:
 * `「<事项标题>」要你批:<做什么>` / `「<事项标题>」问你:<什么>`(`butlerAsks.ts` 的 `askCallOutEvents` 拼的就是这两种)。
 *
 * 认不出格式就整行当 `what`(那时它已经是一句人话了,比如「豆包 在等你选」)。
 */
export function plainRingSubject(title: string): { subject?: string, what: string, gate?: 'approve' | 'answer' } {
  const text = (title ?? '').trim()
  const head = /^「([^」]{1,40})」\s*/u.exec(text)
  const subject = head?.[1]?.trim()
  const rest = head === null ? text : text.slice(head[0].length)
  const approve = /^要你批[::]\s*/u.exec(rest)
  if (approve !== null) {
    return { ...(subject === undefined ? {} : { subject }), what: rest.slice(approve[0].length).trim(), gate: 'approve' }
  }
  const answer = /^问你[::]\s*/u.exec(rest)
  if (answer !== null) {
    return { ...(subject === undefined ? {} : { subject }), what: rest.slice(answer[0].length).trim(), gate: 'answer' }
  }
  return { ...(subject === undefined ? {} : { subject }), what: rest === '' ? (subject ?? '') : rest }
}

/** 一句话掐到上限(连称呼一起算),宁可截尾也不念一长串。 */
function clipOpener(line: string): string {
  const flat = line.replace(/\s+/g, ' ').trim()
  return [...flat].length <= RING_OPENER_MAX_CHARS ? flat : `${[...flat].slice(0, RING_OPENER_MAX_CHARS - 1).join('')}…`
}

export function ringOpener(call: RingCall, options?: RingOpenerOptions): string {
  const who = options?.address?.trim() === undefined || options.address.trim() === ''
    ? '老板'
    : options.address.trim()
  const { subject, what, gate } = plainRingSubject(call.title)
  /** 「这件事」怎么称:标题前面那个事项名优先(她认得出是哪一件),没有就用后半截。 */
  const thing = subject === undefined || subject === '' ? what : subject
  switch (call.reason) {
    case 'confirm':
      // 「老板,〈事项〉办完了,等你验收。」
      return clipOpener(thing === '' ? `${who},有件事办完了,等你验收。` : `${who},${thing}办完了,等你验收。`)
    case 'failed': {
      // 原因能说清就说原因(`plainFailureWhy` 收拾成一句人话,同 `inCallAnnounceText`),说不清才说哪件事卡住了。
      const why = plainFailureWhy(call.note)
      return clipOpener(why === undefined
        ? `${who},${thing === '' ? '有件事' : thing}卡住了,你说下一步怎么办。`
        : `${who},${why},你说下一步怎么办。`)
    }
    case 'ask': {
      // 别家明写的那道题(2026-10-12):逐字念,见 askOpenerText —— 它本来就把事说清了。
      if (call.ask !== undefined) return askOpenerText(who, call.ask)
      // 「老板,Claude 要看一个文件,等你批,行不行?」
      if (gate === 'approve') return clipOpener(`${who},${subject === undefined ? '' : `${subject} `}${what},等你批,行不行?`)
      if (gate === 'answer') return clipOpener(`${who},${subject === undefined ? '' : `${subject} `}${what},你说一句。`)
      if (thing === '') return clipOpener(`${who},有件事等你一句话。`)
      /*
       * 这一行本来就是一句人话(`sessionAskRowText`:「豆包 在等你选:你喜欢喝什么饮料?」)——
       * 后面再接「,等你一句话」就是把同一个意思说两遍。
       */
      if (/在等你/u.test(thing)) return clipOpener(`${who},${thing.replace(/[。.,,]+$/u, '')}`)
      return clipOpener(`${who},${thing},等你一句话。`)
    }
    case 'relay': {
      /*
       * 他让事务官捎进某条会话的那句话,那边回了(2026-09-27,卡 CB)。
       * 2026-10-13:开场就说清**是哪一条回的**;回话正文仍留给下一句(它可能很长)。
       */
      return clipOpener(thing === '' ? `${who},你让我问的那件事有回音了。` : `${who},${thing}回话了。`)
    }
    default:
      /*
       * 「完成」这一类**正常不会响铃**(8791 把它排成 `silent`,2026-09-22 Ben 定的 A1)。
       * 真出现了也只说这一件,不报数(「另外还有 3 件也完成了」是汇报,不是打招呼)。
       */
      return clipOpener(thing === '' ? `${who},跟你说一声,有事办完了。` : `${who},${thing}办完了。`)
  }
}

/**
 * ★ **她 3 秒不吭声就把那件事再说一遍**(2026-10-13,维护者:「接起来也不说事,还要我来问」)。
 *
 * 听筒从耳边到开口有一段路,而这一句是定死的、0 毫秒出口 —— 她没听清的时候,
 * 再说一遍比等她问一声快得多(问一声要等模型 8 秒)。
 * **只一次**:说两遍是提醒,说三遍是催。
 */
export const RING_OPENER_REPEAT_MS = 3000

/**
 * 接起来之后换上的那一段系统提示。**只补这一件事的上下文,不替换人设** ——
 * 她还是她,只是这通电话有个明确的来意。
 *
 * 为什么把「说了什么就调什么工具」写死在这儿:电话里最坏的失真是「答应了但其实没办」(D13)。
 * 所以提示词里把三句人话与三个 decision 一一对上,不留给模型自由发挥。
 *
 * ## 「只问一次」(2026-09-23,Ben 第四通真机:「它的回复我不是很满意」)
 *
 * 那一通的来意是「等你确认」,开场问了「批准、打回、还是先放着」,他没接这个话茬 ——
 * 她**又追了两轮**(「那条事项本身你要怎么给」「不是必须的,你不用照着这三个选项回答」)。
 * 前一版提示词里那句「听不清、他说的不是这三类,就**再问一遍**」正是这个毛病的出处。
 *
 * 一通电话不是一张要填完的表。改成:**开场问一次,他没接就顺着他聊,挂断前也不重提**;
 * 他真给了说法才落。代价写清楚:他本来打算确认、聊岔了忘了说,那件事就还留在原处 ——
 * 那比被追问三遍强,而且下一次它还会再打来。
 */
export function ringInstructions(base: string, call: RingCall, options?: RingOpenerOptions): string {
  const merged = call.merged === undefined || call.merged.length === 0
    ? ''
    : call.reason === 'ask'
      ? `\n这一通里不止这一问,后面还有:${call.merged.map(one => one.title).join('、')}。`
      : `\n同一通里还有这几件也完成了:${call.merged.map(one => one.title).join('、')}。`
  /** 「只问一次」那一段。三类理由**同一个口径**,只是要落的东西不一样。 */
  const askOnce = [
    '**这个问题只问一次。** 他没接这个话茬、说的是别的,就顺着他这会儿说的聊:',
    '不要追问、不要把选项再报一遍、不要换个说法绕回来问,**挂断之前也不要再提它**。',
    '他要是问起「那件事你要我怎么办」,再照实说一次也行 —— 那是他自己开的口,不算追问。',
  ].join('\n')
  /**
   * 他接话之后那一句(2026-09-23)。开场白里已经不念标题了,所以这里要说清**怎么讲**:
   * 用人话复述,不念标题原文 —— Ben 的原话是「把标题念了一遍」就是套公式。
   */
  const sayWhat = [
    ...(call.reason === 'relay'
      /**
       * 捎话的回音(2026-09-27,卡 CB):这一通里**该说出那是哪一家回的**
       * (「Claude 回了」——他问的时候点的就是那一家),再把那段回话讲给他。
       * 「别念标题」那条对它不适用:这里的「标题」就是那条会话本身。
       */
      ? [
          `他「嗯?」一声或者问是什么回音的时候,先说清是**哪一条会话**回的(${call.title}),`,
          '再照着工作台记的那一句把回话说给他听 —— **长的先说要点**,他要细节再往下念;不要念 id、不要念路径。',
        ]
      : call.reason === 'ask' && call.ask !== undefined
        /*
         * 别家那道题(2026-10-12):开场已经逐字念过了。不再转述 —— 她这会儿要的是答,不是再听一遍。
         */
        ? [
            `开场那一句已经把 ${call.ask.from} 的原题${call.ask.permission === true ? '' : '和选项'}一字不差地念给他了(题:${call.ask.question};${call.ask.permission === true ? '这是一个权限弹窗,他答的是批准 / 拒绝' : `选项:${call.ask.options.length === 0 ? '没有,自由回答' : call.ask.options.join(' / ')}`})。`,
            '**不要再转述、不要再报一遍选项**;他问「刚才说什么」再照原题念一次。',
          ]
      : [
          /*
           * ★ 2026-10-13:开场那一句**已经把事说清了**(ringOpener 从标题按理由拼的人话)。
           * 所以这里不再叫她「等他问再说」—— 他问细节才往下说。
           */
          `开场那一句已经把这件事说给他了(这一通是:${call.title})。**不要再重复一遍**;`,
          '他问细节的时候再往下说,用**一句人话**,不要把标题原样念出来,不要念 id、不要念路径。',
        ]),
    call.reason === 'relay'
      ? '说完**不用问他要什么决定** —— 这一通只是把回话带给他。'
      : call.reason === 'confirm'
      ? '说完顺口问一次他的意思(批准 / 打回去重做 / 先放着),**一次就够**。'
      : call.reason === 'failed'
        ? '说完顺口问一次(让它重做一次,还是先放着),**一次就够**。'
        : call.reason === 'ask' && call.ask !== undefined
          ? '他说了选哪个(说选项原话、说「第二个」、说个意思都算),**当场**交上去;交完照工具回话说一声「好了,替你选上了」或照实说没成。'
        : call.reason === 'ask'
          ? '说完顺口问一次他的意思,**一次就够**;选项别一条条念(最多提一句「你是要…还是…」),也可以跟他说手机上「等你确认」里点一下就行。'
          : '他不追问就不用展开。',
  ].join('\n')
  /**
   * 「等你回答」那一通(2026-09-25,卡 M):他当场说了意思,就原话交给工作台(`wb_answer_ask`),
   * 工作台认得出是哪个选项就选它、认不准就把原话交上去,**你不替他挑**。
   */
  const answerAsk = [
    '他**给了说法**的时候,当场用 wb_answer_ask 把他的**原话**交上去(item_id 用上面这件事的),不要改写、不要替他挑选项;',
    '即使他的回答也是一句问题（例如“月饼哪个品类好吃”），也是交回原应用的自由回答。直接用 wb_answer_ask，不是让你自己回答知识问题，不要问要不要代问，也不要用 wb_relay_to_session 重新挑会话。',
    '要批的那种,他说「可以 / 批」「不行 / 先别」才交;他说「我去手机上看」「等会儿」就什么都不交,那一问照旧在手机和电脑上等他。',
    /**
     * 接连几问只响一次(2026-09-25,卡 M 追加):交完一问,工具回话里要是带着「下一问」,就接着问那一问
     * (item_id 用回话里给的那个),一问一问答下去;他说「先这样」「别的回头再说」就停,剩下的照旧在手机和电脑上等他。
     */
    '交完一问,工具回话里要是说还有下一问,就接着用一句人话问那一问(交的时候 item_id 用回话里给的那个),一问一问答下去;',
    '他说「先这样」「剩下的回头再说」就停,不再往下问 —— 剩下的照旧在手机「等你确认」和电脑上等他。',
    askOnce,
  ].join('\n')
  /**
   * 捎话的回音(2026-09-27,卡 CB)。**只转述,不落任何状态** ——
   * 这一通不是要他决定什么:他在手机上让事务官去问了一句,这是把答案带回来。
   * 他听完要接着让那边做点什么,那是另一件事(用捎话那件工具再捎一句),不在这一通里替他办。
   */
  const relayBack = [
    '这一通只是把那边的回话带给他,**不要**替他改任何状态、**不要**问他批不批。',
    '他要是让你「再去问一句 / 回它一句」,用捎话那件工具把他的**原话**捎回那条会话,别自己组织语言;',
    '他要是问「它原话怎么说的」,照着工作台记的那一句念,**不要改写、不要替它圆**;那一句要是写着还没回,就如实说还没回,不猜它在干嘛。',
    askOnce,
  ].join('\n')
  /**
   * ★ **没调工具就不许说「我去重派一次」,派成了也不许说「有结果打电话告诉你」**
   * (2026-10-01,Air 09-29 那通电话的日志:她说「我去重派一次,有结果打电话告诉你」,
   * 这一回合里**只调了查进度那件工具** —— 一下都没再派,也没有任何东西会在有结果时打回来)。
   *
   * 两件事分开说清:
   * - **再派一次**只有一条路:`wb_decide_item` 的 `decision=redo`。调了、而且工具回话说成了,才算派出去了;
   *   回话说没成就照实说没成。在调它**之前**不许把它说成已经在做。
   * - **回电**不是派活带的(维护者 2026-09-30 定:派出去成了只记在看板上、不打电话)。
   *   所以**成了**那一头永远不许许诺一通电话;真会打回来的只有「卡住了 / 要问你」那两类,
   *   而那是工作台决定的,不是她在电话里答应的。
   */
  const noPromise = [
    '**不许说没做的事**:「我去重派一次」只有在你**真调了** wb_decide_item(decision=redo)、而且它回话说派出去了之后才能说;',
    '调之前不许说成已经在做,工具回话说没派成就照实说没派成 —— 查一下进度不是派活。',
    '**不许许诺回电**:派出去成了只会记在看板上,**不会**有人给他打电话报结果;想知道结果他自己看看板,或者下次再问你。',
  ].join('\n')
  const decide = call.reason === 'relay' ? relayBack : call.reason === 'ask' ? answerAsk : call.reason === 'done'
    ? [
        '这一通只是汇报,**不要**替他改任何状态;他要你做别的事再用别的工具。',
        askOnce,
      ].join('\n')
    : [
        '他**给了说法**的时候,要**当场落到那条事项上**,用 wb_decide_item:',
        '- 「批准」「可以」「过了」→ decision=approve',
        '- 「不行」「重做」「打回去」→ decision=redo',
        '- 「稍后」「等会儿再说」「先放着」→ decision=later(不改状态,只记一句)',
        '他说的不是这三类,就**什么都不落**,那条事项照旧留在原处 —— 绝不自己挑一个。',
        noPromise,
        askOnce,
      ].join('\n')
  return [
    base,
    '',
    '——— 这一通电话 ———',
    call.reason === 'relay'
      // 捎话那一通没有事项(它不挂在看板上,item_id 是轻账里的那条):**别念 id**,只说是哪条会话回的。
      ? `是你主动打给他的。理由:${RING_REASON_TITLES[call.reason]}。他让你捎话的那条会话:${call.title}。`
      : `是你主动打给他的。理由:${RING_REASON_TITLES[call.reason]}。事项:${call.title}(id ${call.item_id})。`,
    ...(call.note === undefined ? [] : [`工作台记的一句:${call.note}`]),
    merged,
    `开场那一句(「${ringOpener(call, options)}」)已经由系统念给他了,**一个字都不要重复**;`
    + '**不要自我介绍**(这个电话只有你会打给他,他知道是你),**不要说「我打给你是因为」**。',
    sayWhat,
    decide,
    '他要是想聊别的,照常聊 —— 这通电话不是审讯。',
  ].filter(line => line !== '').join('\n')
}

// ———————————————————————— 振铃状态机 ————————————————————————

export interface RingTimerHandle { cancel: () => void }

export interface RingMachineDeps {
  /** 往房里广播一行 JSON。发不出去只记日志 —— 一条消息丢了不该把工人带走。 */
  send: (line: string) => void
  /**
   * **点名发给房里某一位**(2026-09-23)。只给 {@link RingMachine.resendRingTo} 用。
   *
   * 不接这一格(老调用方、用例)= 「补发这件事不做」。为什么不退回用 `send` 兜底:
   * 广播会把同一条 `ring` 再送给**已经在响**的那几台,而这条路上真正没收到的只有一台。
   */
  sendTo?: (identity: string, line: string) => void
  /** 他接起来了:该开口了。**这个回调里才允许说话**。 */
  onAnswered: (call: RingCall) => void
  /**
   * **这会儿正在通话里吗**(2026-09-27,卡 MS)。
   *
   * 机器状态里的 `live` 只认「响了、他接起来了」这一种;他自己拨来的那一通、话筒提机那一通
   * 走的是另一套(`createCallState`),这台机器压根不知道。于是 21:23 那一通里派活失败的
   * 「只发通知」照样广播了一条 `ring` 进房 —— 手机那一侧收到来电就把**正在进行的这通电话**收了场
   * (日志:`座机响了:运行失败…(只发通知,没响铃)` → `这一通收场:notified` → `房里这一通结束了` → 挂断)。
   * 维护者:通话中出了结果要在这通电话里直接说,绝不能结束当前通话。
   *
   * 缺席 = 老行为(只认 `live`)。
   */
  inCall?: () => boolean
  /**
   * **通话里当场说一句**(2026-09-27,卡 MS)。正在通话中来的这一通不响铃、**一个字都不往房里广播**,
   * 交给它在这通电话里说出来。回 true = 说了(这一通就按「只发了通知」收场,不排队、不重拨);
   * 回 false / 没接这一格 = 说不出去,那就照老样子排着,等这通电话挂了再响。
   */
  onAnnounce?: (call: RingCall) => boolean
  /** 这一通收场了(接了 / 没接 / 取消)。agent.ts 拿它去 ack 8791。 */
  onSettled: (call: RingCall, outcome: RingOutcome, text?: string) => void
  /**
   * 这一通在别的房间先接起了、这边的铃收掉了(2026-10-22,卡 M6;{@link RingMachine.answeredElsewhere})。
   * 不走 `onSettled`:那不是这边的一种收场(没接 / 取消都不对),agent.ts 只回 8791 一句「这间房回过话了」。
   */
  onAnsweredElsewhere?: (call: RingCall, text: string) => void
  now?: () => number
  timeoutMs?: number
  setTimer?: (fn: () => void, ms: number) => RingTimerHandle
  log?: (line: string) => void
}

export interface RingMachine {
  /** 开始响一通。**同一时刻只响一通** —— 正响着又来一通,后来的排队(座机就是这样)。 */
  ring: (call: RingCall) => void
  /**
   * 手机 / 话筒说「接起来了」。
   *
   * `by` 是**接的那台是什么**(2026-09-22 晚),由凭证里签的 `wb_kind` 定,不是设备自称的。
   * 它原样进那条 `ring_end{outcome:'answered'}` 广播:房里另外那台据此知道
   * 「这一通不归我说话」,于是不放她的声音、也不推自己的麦克风。
   * 不给(老的调用方、用例)就照旧不带 —— 手机那一侧还有那条老推断兜着。
   */
  answer: (callId: string, by?: RingDeviceKind, identity?: string) => { ok: boolean, error?: string }
  /** 手机说「稍后」:当未接记,**不重拨**。 */
  later: (callId: string) => { ok: boolean, error?: string }
  /** 正在响的那一通是哪个(没有就 undefined)。 */
  current: () => RingCall | undefined
  /** 这一通已经接起来了吗(agent.ts 据此知道现在是不是一通来电中的电话)。 */
  answered: () => RingCall | undefined
  /**
   * 他把这通电话挂了。**排着的下一通这就开始响** —— 一台座机就是这样:
   * 你放下听筒,下一个电话立刻进来。
   *
   * `by` 说的是**哪条路**(2026-09-22,见 {@link RingHangupBy}):手机自己挂的不广播,
   * 话筒挂机与工人补刀要广播一条 `ring_end{outcome:'hung_up'}`,手机据此收掉屏上那一面。
   * 缺省是 `worker` —— 没说是谁的时候,就是工人自己这一侧在收场。
   */
  hangup: (by?: RingHangupBy) => void
  /**
   * **把正响着的那条 `ring` 补发给晚进房的那一位**(2026-09-23 真机那一条)。
   *
   * 真机 10:27 的那一幕:工人刚重启(8791 热更新之后拉起),一进房就排了一通铃 ——
   * 那一刻房里只有座机话筒,手机几秒之后才(重新)出现。`ring` 是**一次性广播**,
   * 发出去就没了,于是手机从头到尾一声没响,60 秒后台账上记了一条「未接」。
   * 那正是这类状态机最坏的失真:台账说他错过了一通电话,而他的手机根本没响过(D13)。
   *
   * 补的是**同一条**:同一个 `call_id`、**同一个 `until`** —— 重新算一次 until
   * 等于偷偷把这一通的 60 秒延长,手机那根倒计时会比工人那根晚到点,
   * 于是出现「手机还在响,工人已经记了未接」。所以这里发的是 {@link start} 当时
   * 编好的**那一行原文**,一个字节都不重新编。
   *
   * **点名发**(`sendTo`),不全房重播:已经在响的那几台不该再收一条。
   * 手机那一侧对同一 `call_id` 的重复 `ring` 是幂等的(butler-app 的 `reduceIncoming`
   * 在非 `idle` 时原样返回)—— 那是兜底,不是这条路的借口。
   *
   * 返回**有没有真的发出去一条**:没在响、没接 `sendTo` 都是 false。
   * 「响过谁了」不在这儿记(它不知道谁离开过房间),那一份在 agent.ts 里。
   */
  resendRingTo: (identity: string) => boolean
  /** 工人要退出了 / 掉线了:正响着的和排着的一律取消。**不按未接记**(那不是他错过的)。 */
  cancel: (text?: string) => void
  /**
   * **这一通在别的房间先接起了**(2026-10-22,局域网主路 M6):正响着的收铃(房里广播 `ring_end{canceled}`,
   * 手机与听筒回待机),排着的悄悄撤掉;下一通照排。这边已经接起的、不认识的不动,回 false。
   */
  answeredElsewhere: (callId: string, text?: string) => boolean
}

function defaultTimer(fn: () => void, ms: number): RingTimerHandle {
  const handle = setTimeout(fn, ms)
  return { cancel: () => clearTimeout(handle) }
}

export function createRingMachine(deps: RingMachineDeps): RingMachine {
  const now = deps.now ?? (() => Date.now())
  const timeoutMs = deps.timeoutMs ?? RING_TIMEOUT_MS
  const setTimer = deps.setTimer ?? defaultTimer
  const log = deps.log ?? (() => {})
  /** 正在响的那一通。 */
  let ringing: RingCall | undefined
  /**
   * 正响着的那条 `ring` 的**原文**(2026-09-23)。补发时逐字重发这一行,
   * 于是 `call_id` 与 `until` 必然和当初广播的那一条一模一样(见 resendRingTo)。
   * `ringing` 是 undefined 时它也是 undefined —— 两者同生同灭。
   */
  let ringLine: string | undefined
  /** 已经接起来、这会儿正在通话的那一通。 */
  let live: RingCall | undefined
  let timer: RingTimerHandle | undefined
  /** 正响着时又来的那几通。座机的做法:排队,不叠着一起响。 */
  const queue: RingCall[] = []

  function clearTimer(): void {
    timer?.cancel()
    timer = undefined
  }

  function settle(call: RingCall, outcome: Exclude<RingOutcome, 'notified'>, text?: string): void {
    clearTimer()
    ringing = undefined
    ringLine = undefined
    deps.send(encodeRingSignal({ type: 'ring_end', call_id: call.id, outcome, ...(text === undefined ? {} : { text }) }))
    try { deps.onSettled(call, outcome, text) }
    catch (err) { log(`[channel-worker] 这一通的收场没记上:${(err as Error)?.message ?? '没说原因'}`) }
    startNext()
  }

  /** 排着的下一通。**正在通话里就不响** —— 她说着话时来一阵铃是最糟的。 */
  function startNext(): void {
    // `inCall`:他自己拨的 / 话筒提机的那一通也算在通话里(卡 MS)。
    if (live !== undefined || ringing !== undefined || deps.inCall?.() === true) return
    const next = queue.shift()
    if (next !== undefined) start(next)
  }

  function start(call: RingCall): void {
    ringing = call
    const until = now() + timeoutMs
    // 留着这一行原文:晚进房的那一位要补发的正是**它**(同 call_id、同 until,见 resendRingTo)。
    ringLine = encodeRingSignal({
      type: 'ring',
      call_id: call.id,
      reason: call.reason,
      item_id: call.item_id,
      title: call.title,
      ...(call.note === undefined ? {} : { note: call.note }),
      at: call.at,
      silent: call.silent,
      ...(call.merged === undefined ? {} : { merged: call.merged }),
      until,
    })
    deps.send(ringLine)
    log(`[channel-worker] 座机响了:${RING_REASON_TITLES[call.reason]} · ${call.title}${call.silent ? '(只发通知,没响铃)' : ''}`)
    /**
     * **只发通知的那一通不等人接**。它压根没响 —— 手机收到它只会弹一条通知。
     * 等 60 秒再记一条「未接」是在说假话:没有人错过任何一次响铃。
     */
    if (call.silent) { settleSilent(call); return }
    timer = setTimer(() => {
      if (ringing?.id !== call.id) return
      settle(call, 'missed', `响了 ${Math.round(timeoutMs / 1000)} 秒没人接`)
    }, timeoutMs)
  }

  function settleSilent(call: RingCall): void {
    clearTimer()
    ringing = undefined
    ringLine = undefined
    // 为什么只发通知(夜间静默 / 「完成」那一类)是 8791 那头决定的,工人只看见 `silent`。
    try { deps.onSettled(call, 'notified', '只发了通知,没有响铃') }
    catch (err) { log(`[channel-worker] 这一通的收场没记上:${(err as Error)?.message ?? '没说原因'}`) }
    startNext()
  }

  /**
   * 通话里当场说(卡 MS)。**不广播 `ring`** —— 那一条正是把手机那一面掀翻、把这通电话收场的那只手。
   * 说出去了就按「只发了通知」收场(台账上和夜里只通知那一种同一档:没有人错过任何一次响铃)。
   */
  function announce(call: RingCall): boolean {
    let said = false
    try { said = deps.onAnnounce?.(call) === true }
    catch (err) { log(`[channel-worker] 通话里没说出这一条:${(err as Error)?.message ?? '没说原因'}`); said = false }
    if (!said) return false
    /*
     * 「交给她了」而不是「说了」(2026-10-13 下午,卡 A 第 4 条):他拨出去的那一通里
     * `onAnnounce` 会先**攒着**,等他把他的事说完才真念出来(announceHold.ts)——
     * 那一下自己有一行日志。这一行只说「这一条不走响铃了」。
     */
    log(`[channel-worker] 通话里这一条交给她带进这通电话:${RING_REASON_TITLES[call.reason]} · ${call.title}(没响铃、没打断这一通)`)
    try { deps.onSettled(call, 'notified', '通话里当场说了,没有另外响铃') }
    catch (err) { log(`[channel-worker] 这一通的收场没记上:${(err as Error)?.message ?? '没说原因'}`) }
    return true
  }

  return {
    ring(call) {
      // 通话归档不是任务结果；兼容服务端修复前已经排队的记录。
      if (call.reason === 'done' && /^和事务官通了(?:个|一次)电话/.test(call.title)) {
        deps.onSettled(call, 'notified', '通话记录已保存，不播报')
        return
      }
      // 已经在通话里(上一通接起来了、或者他自己拨的那一通正开着)就**不响**:
      // 能当场说的就当场说(卡 MS),说不出去的排着 —— 她正说着话,不该被下一通铃打断。
      if (ringing !== undefined || live !== undefined || deps.inCall?.() === true) {
        if (announce(call)) return
        queue.push(call)
        return
      }
      start(call)
    },

    answer(callId, by, identity) {
      if (ringing === undefined) return { ok: false, error: '这会儿没有电话在响' }
      if (ringing.id !== callId) return { ok: false, error: '正在响的不是这一通' }
      const call = ringing
      clearTimer()
      ringing = undefined
      ringLine = undefined
      live = call
      deps.send(encodeRingSignal({
        type: 'ring_end',
        call_id: call.id,
        outcome: 'answered',
        // 谁接的原样带上(见 RingEndSignal.by)。没说是谁就不编一个。
        ...(by === undefined ? {} : { by }),
        // 以及是哪一台(2026-09-23 晚):这条广播先于回话到,手机靠它认出「是我自己接的」。
        ...(identity === undefined || identity === '' ? {} : { by_identity: identity }),
      }))
      try { deps.onSettled(call, 'answered') }
      catch (err) { log(`[channel-worker] 这一通的收场没记上:${(err as Error)?.message ?? '没说原因'}`) }
      // 开口排在最后:记账失败也要让她说话,他已经把电话拿起来了。
      deps.onAnswered(call)
      return { ok: true }
    },

    later(callId) {
      if (ringing === undefined) return { ok: false, error: '这会儿没有电话在响' }
      if (ringing.id !== callId) return { ok: false, error: '正在响的不是这一通' }
      settle(ringing, 'missed', '他按了「稍后」')
      return { ok: true }
    },

    current: () => ringing,
    answered: () => live,

    resendRingTo(identity) {
      // 不在响就什么都不发:他没有一通电话可接,补一条 ring 过去等于凭空造一通。
      if (ringing === undefined || ringLine === undefined) return false
      if (deps.sendTo === undefined) return false
      deps.sendTo(identity, ringLine)
      log(`[channel-worker] 把正响着的这一通补发给刚进房的 ${identity}:${ringing.title}`)
      return true
    },

    hangup(by = 'worker') {
      const call = live
      live = undefined
      /**
       * **话筒挂机 / 工人补刀这两条路要广播一条 `hung_up`**(2026-09-22,待拍板 E1)。
       *
       * 手机自己按的那一条不发:它已经把屏收掉了,再收一条回声只会让状态机多走一遍
       * (同 `answer()` 那条回声的道理,butler-app/src/call/incomingModel.ts 第 2 条边角)。
       *
       * **不再 ack 8791**:这一通在接起来那一刻就记成 `answered` 了,
       * 「他聊完挂了」不是一个新的收场,台账上不该多出一行。
       */
      if (call !== undefined && by !== 'phone') {
        deps.send(encodeRingSignal({
          type: 'ring_end',
          call_id: call.id,
          outcome: 'hung_up',
          // `worker` 不是一台设备(那是工人自己补的一刀),所以只有听筒那一支带 by。
          ...(by === 'handset' ? { by: 'handset' as const } : {}),
          text: RING_HANGUP_TEXTS[by],
        }))
        log(`[channel-worker] 这一通挂了(${RING_HANGUP_TEXTS[by]}):${call.title}`)
      }
      startNext()
    },

    answeredElsewhere(callId, text = ANSWERED_ELSEWHERE_TEXT) {
      const elsewhere = (call: RingCall): void => {
        try { deps.onAnsweredElsewhere?.(call, text) }
        catch (err) { log(`[channel-worker] 这一通的收场没记上:${(err as Error)?.message ?? '没说原因'}`) }
      }
      if (ringing?.id === callId) {
        const call = ringing
        clearTimer()
        ringing = undefined
        ringLine = undefined
        deps.send(encodeRingSignal({ type: 'ring_end', call_id: call.id, outcome: 'canceled', text }))
        log(`[channel-worker] 这一通${text},这边收铃:${call.title}`)
        elsewhere(call)
        startNext()
        return true
      }
      const index = queue.findIndex(one => one.id === callId)
      if (index < 0) return false
      const [waiting] = queue.splice(index, 1)
      // 排着的那一通这边还没响过:房里不用发任何东西。
      if (waiting !== undefined) elsewhere(waiting)
      return true
    },

    cancel(text) {
      live = undefined
      const call = ringing
      // 排着的那几通一并取消:工人要退出了,它们不会有人接。
      const waiting = queue.splice(0)
      if (call !== undefined) {
        clearTimer()
        ringing = undefined
        ringLine = undefined
        deps.send(encodeRingSignal({ type: 'ring_end', call_id: call.id, outcome: 'canceled', text: text ?? '这一通取消了' }))
        try { deps.onSettled(call, 'canceled', text ?? '这一通取消了') }
        catch { /* 见上 */ }
      }
      for (const one of waiting) {
        deps.send(encodeRingSignal({ type: 'ring_end', call_id: one.id, outcome: 'canceled', text: text ?? '这一通取消了' }))
        try { deps.onSettled(one, 'canceled', text ?? '这一通取消了') }
        catch { /* 见上 */ }
      }
    },
  }
}
