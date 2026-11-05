/**
 * **某家会话真在等他答 / 等他批 → 座机响**(2026-09-28,卡 WQ)。
 *
 * 维护者 16:1x 原话:「为什么有需要确认的,事务官都读到了,但是不给我打电话,而且这个会话的东西
 * 没有进入到待确认的抽屉,这可是核心功能啊。」
 *
 * 现场:他在 Codex 里让它发一道选项题(「你最喜欢哪种菜系?」川 / 粤 / 湘 / 江浙),Codex 弹了框。
 * 工作台**读到了** —— `/state.waiting` 里有这一条(`kind:'session'`、`verb:'答'`)、电脑上那张卡也画出来了 ——
 * 可 `call-out.json` 里一条都没有。根因就在 callOut 那一层的事实源:
 * `callOutEventsOf` 只从看板 tasks 与例程出事件,`askEvents` 只从事务官自己的提问 / 审批经纪人出事件
 * (`butlerAsks.askCallOutEvents`)。**不挂事项卡的会话 ask 永远不打电话**。
 *
 * 卡 UX(决策记录 09-28 10:1x C)定的是「派活要批、执行中停下来问他(ask)要响」——
 * 会话自己停下来在等他答,同样属于「他不点头就卡住」,按同一条口径响。
 *
 * ## 判据:只认卡 KM 那套**真证据**(`ask.by === 'form'`)
 *
 * 卡 KM(决策记录 09-28 11:xx)已经拍过一次:「Kimi 每次都是待确认」——它一轮说完就记 `blocked`,
 * 照字面算的后果是每条会话都被说成「停下来等你确认」。所以那一层现在要证据:那家自己的弹窗、
 * 记录里明写的待批 / 待答(`by:'form'`)才算形式上的在等你;按内容读出来的(`by:'rules'`)
 * 只挂 `ask`、不改运行状态。**座机认同一条线**:
 *   - `by:'form'` → 真的有个框停在他面前,他不点它就一直停着 → 响;
 *   - `by:'rules'` / `by:'model'` → 它这一轮说完了、顺口问了他一句(KM 那个场景)→ 一条事件都不出。
 *     那一问照旧在「等你」那一堆里、在界面上摆着,只是不为它响铃。
 * 「不经模型的地方坚决不经模型」:`by:'model'` 是问模型问出来的,更不该拿去响铃。
 *
 * ## 三条不重复
 *
 * 1. **事务官自己那条会话不在这里**(`agent === 'dsh'`):她问他的走 `butlerAsks.askCallOutEvents`,已经数过了;
 * 2. **事项已经认走的会话不再另出一条**(卡 RC「一件事一条」):派出去的那条对话最后在问他 → 事项进
 *    「阻塞 · 等你输入」、`taskCallOutEvent` 已经为它出了一条 `ask`。那条会话的 ask 就不再出第二条;
 * 3. **同一件只打一次**:key = 会话 id + 这一问的 `since`(`ask:session:<会话 id>:<since>`)。
 *    同一条会话下一问是新的 `since` → 新的一件(5 分钟合并窗照旧管它响不响,见 callOut.ts 的 `CALL_OUT_ASK_WINDOW_MS`)。
 *
 * 电话里念的那一句由代码从事实拼(`sessionAskRowText`:「Codex 在等你选:你最喜欢哪种菜系?」),**不经模型**;
 * 送不回去的(`reply:'desk'`)把「得在电脑上的 Codex 里回答」原样带进 `note` —— 电话里如实说,不假装替他点了。
 *
 * 全是纯函数:对象进、对象出。
 */
import type { CallOutEvent } from './callOut.ts'
import { SESSION_JOB_PREFIX, legacySessionOfJob, sessionJobId, sessionOfJob } from './jobKey.ts'
import type { SessionView, TaskView } from '../protocol.ts'
import { type AskingSession, sessionAskRowText, sessionAskWho, sessionIdsOfTask } from '../waiting.ts'

/**
 * 会话那一路的 `item_id` 前缀(同 `relay:<轻账 id>` 的先例:台账上一眼看得出是哪一路)。
 * ★ 2026-10-03 起**只在 `jobKey.ts` 一处定义**(卡「两条接缝」):这里只是转一个名字出去,
 * 免得消费方为了一个前缀去 import 闸那一侧。
 */
export const SESSION_ASK_ITEM_PREFIX = SESSION_JOB_PREFIX

/**
 * ★ **这一问的事项 id**(2026-10-03,卡「两条接缝」;决策记录 10-03 早 ⑦ 第二条)。
 *
 * 从前是 `session:<会话 id>` —— **没有家名**,于是闸那一侧(`jobPhaseOf`)对它永远答「查不出」,
 * 「这件事早就收场了还在动那一家」那一条在座机这一路上压根不生效(审计第二表第 15 条)。
 * 现在与闸、账、`/state.waiting` 同一个定法:`jobKey.sessionJobId(家, 会话 id)`。
 *
 * 落了盘的老行由 `callOutMigrate.ts` 启动时迁一次。
 */
export function sessionAskItemId(agent: string, sessionId: string): string {
  return sessionJobId(agent, sessionId)
}

/** 台账上这一条是不是会话那一路的(`/asks/voice` 据此如实说「这一问得去那家里点」)。 */
export function isSessionAskItem(itemId: string): boolean {
  return itemId.startsWith(SESSION_ASK_ITEM_PREFIX)
}

/**
 * 这一条台账行说的是哪条会话。新格式(`session:<家>/<会话 id>`)拆出家与会话 id;
 * **迁不动的老行**(`session:<会话 id>`,家名认不出来)照旧读得出会话 id、`agent` 缺席 ——
 * 电话里那一问照旧答得进去,只是闸对它答「查不出」(放行),与 10-03 之前一字不差。
 */
export function sessionAskRef(itemId: string): { agent?: string, sessionId: string } | undefined {
  if (!isSessionAskItem(itemId)) return undefined
  return sessionOfJob(itemId) ?? legacySessionOfJob(itemId, { withAgent: false })
}

/** 这一条台账行说的是哪条会话(只要会话 id;不是这一路的回 undefined)。 */
export function sessionAskSessionId(itemId: string): string | undefined {
  return sessionAskRef(itemId)?.sessionId
}

/**
 * 「同一件只打一次」认的那个 key:**会话 id + 这一问的 `since`**。
 * 用 since 而不是问题正文:同一句话它可能重画好几次(窗口重读、重启后再判一遍),
 * 而 `since` 是那个框出现的时刻 —— 同一个框永远是同一个 key。
 */
export function sessionAskCallKey(sessionId: string, since: string): string {
  return `ask:session:${sessionId}:${since}`
}

/**
 * 这一问**有没有真证据**(卡 KM)。判据一处,只有这里。
 * `by:'form'` = 那家自己的弹窗 / 记录里明写的待批待答;别的都是读出来的,不响。
 */
export function sessionAskHasEvidence(ask: Pick<NonNullable<SessionView['ask']>, 'by'>): boolean {
  return ask.by === 'form'
}

/** 这一条会话要的那几格(比 `SessionView` 窄:用例造起来轻,窗口型那几条也对得上)。 */
export type AskingSessionRef = AskingSession & { session_id: string, updated_at?: string }

/**
 * ★ **超过一天没动的那条会话里的弹窗不响铃**(2026-10-13,统筹定;维护者 10-13 上午那几通
 * 正是 10-04、10-12 的旧会话弹窗打来的)。
 *
 * 为什么要这一条:窗口型那几家的弹窗**只要窗口还开着就一直读得到**,而她早就不在那件事上了 ——
 * 一个四天前的框半夜把座机打响,她接起来听的是一件自己都想不起来的事。
 * 阈值 **24 小时**(统筹定):当天与隔夜的照响(真在等她),再老的只在界面上摆着。
 *
 * 判据顺序:这一问出现的时刻(`ask.since`)→ 这条会话最后动过的时刻(`updated_at`)。
 * **两样都读不出来就照响**(宁可响:漏响的代价是一件真卡住的事没人管)。
 */
export const SESSION_ASK_STALE_MS = 24 * 60 * 60 * 1000

/**
 * ★ **一问刚挂上不到 20 秒不响铃**(2026-10-13,卡 H,统筹定的数)。
 *
 * 为什么要这一条:自动模式下的权限提示**几秒就自己过了**,座机却照响 —— 10-13 14:4x 统筹开了五个
 * Claude 子任务,「Claude 要提交改动,等你批准」与「Claude 的子任务「卡 A…」在等你点头」被当成
 * 「等你点头」连着打了四通(台账 14:44–14:47,一条 ringing、三条 missed)。
 * 维护者原话:「你的子任务又在给我疯狂打电话了」。
 *
 * 门槛 **20 秒**(统筹定):挂满 20 秒还在那儿的才是真停住了;`composeState` 每隔几秒跑一次,
 * 下一拍它还挂着就照旧出事件 —— 这一条只推迟,不丢。24 小时那一条管另一头(太老的不响)。
 */
export const SESSION_ASK_MIN_AGE_MS = 20 * 1000

/**
 * 这一问挂了多久(毫秒):**这一问出现的时刻(`ask.since`)→ 这条会话最后动过的时刻(`updated_at`)**。
 * 两道门(刚挂上 / 太老)读同一处同一种来源;两样都读不出来 → `undefined`(由调用方按「宁可响」放行)。
 */
function sessionAskAgeMs(session: Pick<AskingSessionRef, 'ask' | 'updated_at'>, nowMs: number): number | undefined {
  const at = (one: string | undefined): number | undefined => {
    if (typeof one !== 'string' || one.trim() === '') return undefined
    const ms = Date.parse(one)
    return Number.isFinite(ms) ? ms : undefined
  }
  const since = at(session.ask?.since) ?? at(session.updated_at)
  return since === undefined ? undefined : nowMs - since
}

/** 这一问是不是来自一条超过一天没动的会话。读不出时刻 → `false`(照响)。 */
export function sessionAskTooOld(
  session: Pick<AskingSessionRef, 'ask' | 'updated_at'>,
  nowMs: number,
  staleMs: number = SESSION_ASK_STALE_MS,
): boolean {
  const age = sessionAskAgeMs(session, nowMs)
  if (age === undefined) return false
  return age > staleMs
}

/**
 * 这一问是不是**刚挂上、还没满门槛**({@link SESSION_ASK_MIN_AGE_MS})。
 * 读不出时刻 → `false`(照响);时刻比此刻还晚(钟不对)= 这个时刻不可信,也照响 ——
 * 与 24 小时那一条同一取舍:漏响的代价是一件真卡住的事没人管。
 */
export function sessionAskTooFresh(
  session: Pick<AskingSessionRef, 'ask' | 'updated_at'>,
  nowMs: number,
  minAgeMs: number = SESSION_ASK_MIN_AGE_MS,
): boolean {
  const age = sessionAskAgeMs(session, nowMs)
  if (age === undefined || age < 0) return false
  return age < minAgeMs
}

/** 事项那一头要的那几格(认走了哪几条会话)。 */
export type TaskSessionRef = Pick<TaskView, 'status' | 'block_reason'> & Parameters<typeof sessionIdsOfTask>[0]

export interface SessionAskCallInput {
  /** 此刻的会话表(叠过「在等你」的那一份:要有 `ask`)。 */
  sessions: readonly AskingSessionRef[]
  /**
   * 此刻的看板。**只用来认「这条会话已经被事项认走了」**(卡 RC 一件事一条):
   * 事项停在「阻塞 · 等你输入」时 `taskCallOutEvent` 已经为它出了一条 `ask`。缺席 = 不认,谁都不跳过。
   */
  tasks?: readonly TaskSessionRef[]
  /**
   * 这一刻(毫秒)。给两道时间门用:**刚挂上不到 20 秒不响**({@link sessionAskTooFresh})、
   * **超过一天没动的会话不响**({@link sessionAskTooOld})。
   * 缺席 = 不按时间筛(与这两道门之前逐字相同)。
   */
  nowMs?: number
}

/**
 * 此刻**该为哪几条会话打电话**。不管打没打过(那一层在 `planCallOuts` 的台账里)。
 *
 * `item_id` 是 `session:<会话 id>`(不是事项 id:这几条压根不挂在看板上),
 * 所以它照旧过 `callOutRings`(`ask` → 真响)、过夜间静默、过 5 分钟合并窗、过「一件一通」——
 * 座机那一套规矩一条都不用改。
 */
export function sessionAskCallOutEvents(input: SessionAskCallInput): CallOutEvent[] {
  /** 事项已经认走的那几条会话(它们那一问由事项那一条 `ask` 事件代表)。 */
  const merged = new Set<string>()
  for (const task of input.tasks ?? []) {
    if (task.status !== 'blocked' || task.block_reason !== 'input') continue
    for (const id of sessionIdsOfTask(task)) merged.add(id)
  }
  const out: CallOutEvent[] = []
  const done = new Set<string>()
  for (const session of input.sessions) {
    const ask = session.ask
    if (ask === undefined) continue
    // 事务官自己那条会话:她问他的走 butlerAsks 那一路(提问 / 审批经纪人),这里不重复。
    if (session.agent === 'dsh') continue
    // 说完一轮顺口问了一句(卡 KM 那个场景)—— 不响。那一问照旧在「等你」里摆着。
    if (!sessionAskHasEvidence(ask)) continue
    /*
     * ★ 两道时间门(2026-10-13):刚挂上不到 20 秒的不响(自动模式下的权限提示几秒就自己过了,
     * 下一拍它还挂着才出事件)、超过一天没动的那条会话里的框也不响。两样时刻都读不出来 → 照响。
     * 被拦下的那一问照旧在「等你」里、在界面上摆着,只是不为它响铃。
     * 子任务那一类(`ask.child`)与权限弹窗那一类走的就是这条路,同受这两道门管。
     */
    if (input.nowMs !== undefined && sessionAskTooFresh(session, input.nowMs)) continue
    if (input.nowMs !== undefined && sessionAskTooOld(session, input.nowMs)) continue
    if (merged.has(session.session_id)) continue
    const key = sessionAskCallKey(session.session_id, ask.since)
    if (done.has(key)) continue
    done.add(key)
    /**
     * 电话里念的那一句:与「等你」那一堆里那一行**逐字相同**(`sessionAskRowText`)——
     * 他在手机上看到的、她在电话里说的是同一句话。不经模型。
     */
    const title = sessionAskRowText(session)
    /**
     * 补一句上下文:它明写的那几个选项 + 送不回去时**如实说去哪儿答**。
     * `where` 是服务端写好的那句人话(「这一问得在电脑上的 Codex 里回答(它那边弹了个框等你点)」),
     * 原样带走 —— 电话里她照这一句说,不假装能替他点。
     */
    const options = (ask.options ?? []).map(one => one.label).filter(one => one.trim() !== '')
    /**
     * 权限弹窗那一问(2026-10-01,卡 AP):这一路看得到 / 按得到那个弹窗(`permission` 不是空的)→
     * 电话里她说「批准 / 拒绝」就替她按(`/asks/voice` 走同一条路)。看不到(旧壳)照旧如实说去哪儿点。
     */
    const permission = ask.permission
    const voiceApprove = permission !== undefined && (permission.keys !== undefined || permission.readable === true || permission.why !== undefined)
    const note = voiceApprove
      ? '电话里说「批准」或「拒绝」,我替你按它弹窗上那颗键'
      : [
          options.length === 0 ? '' : `选项:${options.join(' / ')}`,
          ask.reply === 'window' || ask.reply === 'cli' || ask.press === true ? '' : (ask.where ?? '这一问得在电脑上那家自己的窗口里回答'),
        ].filter(part => part !== '').join(' · ')
    /*
     * 那家明写的题(2026-10-12):工人接起来逐字念「谁在问 + 问题 + 选项」。
     *
     * ★ **2026-10-13:权限弹窗那一种也带上这一格**(维护者 10-13 上午:「接起来也不说事,还要我来问」)。
     * 从前这里对 `voiceApprove` 故意不带 —— 理由是「她答的是批 / 不批,不用念选项」,
     * 结果开场只剩一句「有件事要问你一下」,那件事到底是什么还要她自己问一声(要等模型 8 秒)。
     * 现在一律带;**要不要念选项由工人按 `permission` 判**(权限弹窗那一种念的是「批准还是拒绝?」)。
     */
    const question = ask.question.trim()
    out.push({
      key,
      reason: 'ask',
      item_id: sessionAskItemId(session.agent, session.session_id),
      title,
      ...(note === '' ? {} : { note }),
      ...(question === ''
        ? {}
        : { ask: { from: sessionAskWho(session), question, options, ...(voiceApprove ? { permission: true as const } : {}) } }),
      at: ask.since,
    })
  }
  return out
}
