/**
 * 一条会话此刻**到底是什么状态**(2026-09-25,卡 V「会话状态说真话」)。
 *
 * ## 撞出来的事
 *
 * 09-25 21:00 维护者截图:事务官舞台上三张 Claude 卡都写「进行中」。实际**只有一条在跑**(统筹会话);
 * 另外两张「What is 2+2?Reply w…」·「Not logged in · Please run」分别挂了 53 分钟和 18 分钟 ——
 * 那是能力体检用 `claude -p` 探的一句,命令行没登录,一条记录就结束了。窗口槽 Claude 标签上的
 * 「3」跟着错。维护者原话:「实际一个会话在跑,从事务官的卡片,再到气泡,都不对」。
 *
 * ## 根因(两条,都在「猜」上)
 *
 * 1. **状态按会话文件最近有没有改动猜**:`claudeSessionRecover.looksRunning` 只看末尾那条
 *    `stop_reason !== 'end_turn'` 就算「在跑」。而报错那条记录的 `stop_reason` 是 `stop_sequence`,
 *    于是「登录失败、一句话就完了」被读成「还在干活」,一直挂到 2 小时空闲清扫才落下去。
 * 2. **一次性命令行运行没有钩子回报「结束」**:`claude -p` 不进 `~/.claude/sessions/<pid>.json`
 *    (那份只记「此刻开着的会话」),原来只对 `entrypoint === 'claude-desktop'` 的会话认「不在那份里 = 已关」,
 *    别的一概退回猜。
 *
 * ## 现在怎么判(两条证据,谁都不猜)
 *
 * - **文件说它停在哪儿**(`SessionMark`,见 sessionDigest.ts):说完了 / 报错了 / 被掐断 / 在干活 / 他刚说完话;
 * - **进程表说还有没有人在写**(`writerAlive`):有进程在写,「在干活」就是真在跑;没有进程在写,
 *   「在干活」就是**中断** —— 它停在半路,没人会再往下写了。
 *
 * 合起来:
 *
 * | 文件停在哪儿 | 还有人在写 | 结论 |
 * |---|---|---|
 * | 说完了 | 不管 | `done` 这一轮说完了(它忙着 = `running`,见下) |
 * | 报错了 | 不管 | `error` 出错(人话由 src/humanError.ts 翻) |
 * | 被掐断 | 不管 | `offline` + `interrupted` 中断 |
 * | 在干活 / 他刚说完 | 有(且忙) | `running` 进行中 |
 * | 在干活 / 他刚说完 | 有(空闲) | `done` 这一轮说完了 —— 进程在、不忙,就是在等他下一句 |
 * | 在干活 / 他刚说完 | 没有 | `offline` + `interrupted` **中断**,不是「进行中」 |
 * | 在干活 / 他刚说完 | 查不到 | 记录还在长 → `running`;`stallMs` 没长过 → `interrupted` |
 * | 认不出 | 不管 | 不下结论(`undefined`),谁也不动 |
 *
 * **「停下来等他下一句」不是「待确认」**(2026-09-25 维护者:「待确认也是错的,那个黄色的,哪有要确认的」):
 * 一轮说完了在等下一句 = **空闲**(`done`),不进 waiting 档、不出琥珀色气泡、不进「等你」。
 * `waiting` 只留给两种:**形式上的**(权限弹窗、提问弹窗、等批准 —— 有直接信号才算)和**内容上的**
 * (最后一轮在问他 / 让他选 / 让他去做 —— 那一半归卡 T,这里只把 `formal_wait` 和最后一轮原文摆出来,**不自己判内容**)。
 */
import type { EventReason, SessionStatus } from '../protocol.ts'
import type { SessionMark } from './sessionDigest.ts'

/** 多久没长就算「中断」(默认 10 分钟)。只在**查不到还有没有进程在写**的时候才用得上。 */
export const STALL_MS = 600_000

export interface OutcomeEvidence {
  /** 文件最后一条可认记录停在哪儿。缺席 = 一条可认记录都没有 → 不下结论。 */
  mark?: SessionMark
  /**
   * 还有进程在写这个文件吗:`true` 有、`false` 查过了没有、缺席 = 查不了(这版客户端不记「此刻开着的会话」)。
   * **「查不到」与「没有」是两件事**:查不到时退回看记录还在不在长,不敢直接说中断。
   */
  writerAlive?: boolean
  /** 那个进程此刻忙不忙(Claude `~/.claude/sessions/<pid>.json` 的 `busy` / `idle`)。查不到就缺席。 */
  writerBusy?: boolean
  /** 记录里明写着停下来在等人(Kimi `ApprovalRequest` / `QuestionRequest`)。Claude 的权限弹窗不写进文件。 */
  formalWait?: 'approval' | 'question'
  /** 最后一条可认记录的时刻(毫秒)。 */
  lastAtMs?: number
  /** 文件修改时刻(毫秒)。`lastAtMs` 读不到时用它 —— 记录里没时刻的那几种格式(Kimi 老文件)。 */
  mtimeMs?: number
  /** 此刻(毫秒)。 */
  nowMs: number
  /** 上一轮看到的文件大小 / 修改时刻还是不是这一个:`true` = 这一轮长了。缺席 = 不知道。 */
  growing?: boolean
  stallMs?: number
}

export interface SessionOutcome {
  status: SessionStatus
  /** `offline` 那一档必须说清是「中断」还是别的:界面据此写「中断」而不是「掉线」。 */
  reason?: EventReason
  /** 判成这样的依据,一句话。进服务端日志与 `/state`,验收时看它。 */
  why: string
}

/** 中断:`offline` + `interrupted`。不是 `error` —— 红字只留给真错误(维护者规矩)。 */
function interrupted(why: string): SessionOutcome {
  return { status: 'offline', reason: 'interrupted', why }
}

/**
 * 判一条会话此刻是什么状态。**纯函数**,不读文件、不看时钟(此刻由调用方传)。
 * 判不出来回 `undefined` —— 拿不准就不下结论,谁也不动(维护者规矩「不编一个数」)。
 */
export function judgeSessionOutcome(evidence: OutcomeEvidence): SessionOutcome | undefined {
  const { mark } = evidence
  if (mark === undefined) return undefined

  // ① 文件自己说清「这一轮没好好结束」的两种:报错了 / 被掐断。这两种盖过一切 ——
  //    一条报错收场的会话不会同时「在等他批」。
  if (mark === 'failed') return { status: 'error', why: '最后一条记录是报错' }
  if (mark === 'aborted') return interrupted('最后一条记录是被掐断')

  /**
   * ② **形式上停下来在等人** —— 直接证据,盖过下面所有的推断。
   *
   * 放在 `ended` 前面(2026-09-25 收尾时调的次序):权限弹窗本该发生在一轮中间(那时 mark 是 `working`),
   * 但「文件写到哪儿」与「pid 文件此刻怎么说」是两个来源、两个时刻,真机上难保不错拍。
   * 直接证据先于推断 —— 它明写着在等人,就别自己去猜它是不是说完了。
   */
  if (evidence.formalWait !== undefined) {
    return { status: 'waiting', reason: evidence.formalWait === 'approval' ? 'permission_prompt' : 'idle_prompt', why: '记录里明写着停下来在等人' }
  }

  // ③ 说完了。进程忙不忙都不改这个结论 —— 除了一种:进程又忙起来了(他刚说了下一句,新记录还没落盘)。
  if (mark === 'ended') {
    if (evidence.writerAlive === true && evidence.writerBusy === true) {
      return { status: 'running', why: '上一轮说完了,进程又忙起来了' }
    }
    return { status: 'done', why: '最后一条记录是最终回答' }
  }

  // ④ 文件停在半路(它在干活 / 他刚说完话)。到底是在跑还是中断,看还有没有人在写。
  const half = mark === 'asked' ? '他刚说完话、它还没开口' : '最后一条记录是它在干活'

  if (evidence.writerAlive === true) {
    // 进程在,但它说自己空闲:这一轮说完了,在等他下一句 —— **空闲,不是待确认**。
    if (evidence.writerBusy === false) return { status: 'done', why: `${half},而进程说自己空闲` }
    return { status: 'running', why: `${half},进程还在` }
  }
  if (evidence.writerAlive === false) {
    return interrupted(`${half},而写它的进程已经没了`)
  }

  // 查不到有没有进程在写(老版本客户端):退回看记录还在不在长。
  if (evidence.growing === true) return { status: 'running', why: `${half},记录还在长` }
  const at = evidence.lastAtMs ?? evidence.mtimeMs
  const stallMs = evidence.stallMs ?? STALL_MS
  if (at !== undefined && evidence.nowMs - at >= stallMs) {
    return interrupted(`${half},已经 ${Math.floor((evidence.nowMs - at) / 60_000)} 分钟没动过`)
  }
  return { status: 'running', why: `${half},刚刚还动过` }
}
