/**
 * 捎完话、那家回了,**回电话给他**(2026-09-27,卡 CB)。
 *
 * ## 维护者那一句(2026-09-27 拍板,原话)
 *
 * 「我在手机上问了事务官,理论上事务官去问了对应的 AI 之后,**事务官得回电话给我**。」
 *
 * 捎话那条路(卡 BR,`sessionRelay.ts` + `sessionAnswer.relay` + `POST /sessions/relay`)09-26 就通了:
 * 他点名一条正在跑的会话,事务官把他的原话送进去、前面带一个记号(`【事务官捎话 a1b2c3】`)。
 * **缺的是回程**:卡 BR 第三节把它留成两条备选 —— ① 记一条轻账、按记号读回话、读到了主动冒出来;
 * ② 只在他问的时候现读。维护者 09-27 定 ①,而且「冒到他眼前」的方式是**回电话**。
 *
 * ## 这个文件做什么
 *
 * 一本**轻账**加一条**巡检**,三步:
 *
 * 1. **记一条**({@link RelayWatchService.remember}):捎进去的那一刻,记下哪条会话、什么记号、
 *    几点、从哪一端问的。`POST /sessions/relay` 送成了才记(送不到的那几种一个字不记)。
 * 2. **按记号读回话**({@link RelayWatchService.pump}):几秒看一眼那扇窗,用的是**派活那一套**
 *    (壳 `read_reply` 按记号找我们送进去的那一句 + `dispatchReply.extractReply` 把界面字摘掉),
 *    连着两次读回来一字不差、那家没在生成(`replySettled`)才算它说完了。
 * 3. **回电话**:读到了 → `callOut.request({ reason: 'relay' })` 排一通;等过了
 *    {@link RELAY_WAIT_MAX_MS} 还没回 → 也排一通,说「X 还没回」。
 *    **等太久就沉默是最坏的一种**:他在手机上问了一句,然后什么都没有,他不知道是没送到还是没人理。
 *
 * ## 为什么走 `callOut.request` 而不是另造一条通知
 *
 * 那条路上「电话该怎么响」的规矩已经全在了,一条都不用重写:
 * **免打扰时段只发通知不响铃**(`inQuietHours` → `silent`,卡 QH 的规矩)、上一通还没收场不叠第二通、
 * 没接就进未接来电、手机上能回拨。这里只负责**什么时候该有一通**。
 *
 * ## 三条纪律
 *
 * - **不落他的原话**。轻账里只有「哪条会话、记号、几点、从哪一端」,**没有他捎进去那句话** ——
 *   卡 BR 定的「他的话只送进那条会话,不落盘」这一条没有因为要回电就松掉。
 *   (按记号找我们那一句用的是记号本身,不需要原话;见 `dispatchReply.ts` 的 `ownMessageEnd`。)
 * - **读到什么说什么**。电话里念的那一段是 `read_reply` 原样读回来、只摘掉界面字的那一段,
 *   不经模型改写、不摘要成「它说进展顺利」。长了截断({@link RELAY_NOTE_MAX}),截了就明说截了。
 * - **一条捎话最多一通电话**。排出去就记下那通的 id;排不出来(上一通还在响)下一拍再试。
 *
 * ## ★ 2026-10-04:**这本账里有一条 = 她要那一通电话**(卡 `claude/relay-call-optin`
 * → 同日卡 `claude/relay-nocall-noread` 收到底)
 *
 * 维护者原话:「现在每次我在手机里给你发信息,你回信息他就给我打电话……不是每次都要的,
 * 能不能给个勾选,勾了才需要盯和打电话」。当天追问「不勾的时候要不要干脆别读那扇窗」,
 * 她回**「可以不读」**。
 *
 * 于是开关整个在**发出那一刻**(手机上框旁边那个勾选 / 电话里她明说「回了打给我」):
 * **没勾的压根不登记进来** —— 没有这一条,这一层就没有巡检、没有读窗、没有通知、没有电话,
 * 她那句话照旧送进去,回话留在那条会话里(手机「各家对话」里看得到)。
 * 勾了的那一路(盯着 → 读到回话真响一通 → 等过头也回个电话说一声)一个字没改。
 *
 * 所以这一层**没有「要不要响」那一格**:进了这本账的每一条都是她要那一通。
 * 「等太久也说一声」那条 09-27 的纪律因此只对勾了的生效(她拍的)。
 */
import { relayWaitJobId, sessionJobId } from './jobKey.ts'
import type { JobLog } from './jobLog.ts'
import type { CallOutReason } from '../protocol.ts'
import { replySettled } from './dispatchReply.ts'
import type { Engine } from './engine/engine.ts'
import type { AdapterReadResult, Job } from './engine/adapter.ts'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

/** 几秒看一眼那扇窗(读一次窗口是一次辅助功能树遍历,别太密)。 */
export const RELAY_POLL_MS = 8000
/**
 * ★ **一拍里最多等读窗多久**(2026-10-21,卡「派活按家隔离」)。各家的读窗并行起;这一拍只等这么久 ——
 * 没读完的那一家接着读(下一拍跳过它),别家的回话照常落账、照常回电。一家读不动只拖它自己。
 */
export const RELAY_READ_BUDGET_MS = 3000

/**
 * **等多久还没回就回个电话说「还没回」**(卡 CB 要求定一个上限,写进交接)。
 *
 * 20 分钟。定这个数的理由:他在手机上问的多半是「现在到哪了 / 大概还要多久」——
 * 那种话正常几十秒就有回音;20 分钟还没有,说明要么那家卡住了、要么字没真送进去,
 * 两种他都该知道。再长(比如派活那条的 45 分钟)他早就把这件事放下了,回电就成了打扰。
 */
export const RELAY_WAIT_MAX_MS = 20 * 60 * 1000

/** 巡检那一拍落不了盘时记的那一行(**不带她那句话**;断言照这个常量,不逐字抄)。 */
export const RELAY_PERSIST_FAILED_LOG = '[relay] 台账落盘失败,这一拍没记上盘(下一拍再试)'

/** 电话里念的那一段最多留多少字(长的先说要点,全文在那家自己的窗口里)。 */
export const RELAY_NOTE_MAX = 600

/**
 * 捎到了之后许的那一句:**勾了**「回了打电话给我」(2026-10-04,卡 `claude/relay-call-optin`)。
 * 断言照这个常量,不逐字抄中文。
 */
export const RELAY_PROMISE_CALL = '它回了我打电话告诉你。'

/**
 * 捎到了之后许的那一句:**没勾**(缺省)。2026-10-04 维护者拍板「不勾可以不读」之后,
 * 这一句改成了实话 —— **不盯、不读、没有通知**,回话就在那条会话里。
 * 不许说成「我打电话告诉你」,也不许说成「我给你发条通知」(那一档从此没人走了);
 * 一声不吭也不行 —— 她得知道回话会到哪儿去,以及要那一通电话该怎么要。
 */
export const RELAY_PROMISE_NOWATCH = '我不盯着它回话 —— 它回的那句就留在那条会话里,你在「各家对话」里看得到(要回电,发的时候勾上「回了打电话给我」)。'

/** 没当场核上那一档的两句尾巴(口径同上,只是多一句「没看见它收下」)。 */
export const RELAY_PROMISE_CALL_UNSURE = '我盯着,读到回话打电话告诉你,一直看不到也会打电话说一声。'
export const RELAY_PROMISE_NOWATCH_UNSURE = '我也不盯着 —— 去那条会话里看一眼这句话进没进去,它回的那句也在那儿(要回电,发的时候勾上「回了打电话给我」)。'

/** 这一条捎话是从哪一端问的(记下来只为了说得清「你手机上让我捎的那句」,**不影响响不响**)。 */
export type RelayFrom = 'phone' | 'call' | 'desk'

const RELAY_FROM_TEXT: Readonly<Record<RelayFrom, string>> = {
  phone: '手机上',
  call: '电话里',
  desk: '电脑上',
}

/** 轻账里的一条。**没有他捎进去那句话**(见文件头第一条纪律)。 */
export interface RelayWait {
  id: string
  agent: string
  session_id: string
  /** 那条会话在界面上叫什么(念给他听:「Claude『统筹交接』回了」)。 */
  title: string
  /** 送进去时那个记号(`事务官捎话 a1b2c3`),读回话靠它。 */
  mark: string
  /** 捎进去的时刻(ISO)。 */
  at: string
  from: RelayFrom
  /** `waiting` 等回话 · `replied` 它回了 · `timeout` 等太久了 */
  state: 'waiting' | 'replied' | 'timeout'
  /** 读回来的那一段(只有 `replied` 有,原样、只摘了界面字)。 */
  reply?: string
  /** 截断过(全文在那家窗口里)。 */
  truncated?: true
  replied_at?: string
  /** 已经为这一条排过电话了 —— 那一通的 id。缺席 = 还没排出去,下一拍再试。 */
  call_id?: string
  /**
   * **真送进去的那个包**(2026-09-30 晚,故障 ③):一台机器装两个豆包时,按家名查到的是主包那扇窗,
   * 回话在另一扇里,永远读不到。送的那一刻记下来,读窗就用它;缺席(老账、捎进已有会话那一路)照旧按家名查。
   */
  bundle_id?: string
  /** 按了发送、当场没在对话区里核上(`typed`;故障 ②)。读到了就算核上;等过头时回电要明说没核实到发出去。 */
  unconfirmed?: true
  /**
   * 登记那一刻 `session_id` 是**占位的**(新开一条 / 只盯不发,还认不出它开的是哪条对话)。
   * 闸与账的键因此不拼成会话键(见 {@link relayJobOf}),免得被「这家有别的会话、这条不在」判成收场。
   */
  session_placeholder?: true
  /**
   * 送那一刻对端报的**轮号**(Codex turn id;2026-10-03)。巡检读回话时原样交给引擎(`Job.turnId`),
   * 协议型只认这一轮 —— 她自己又在那条线程里发了一句也不认错。窗口型 / 老账缺席 = 认最后一轮。
   */
  turn_id?: string
  /**
   * ★ **这条捎话归哪一件事**(2026-10-02,卡 AG2;事项 id)。
   *
   * 交接第二节 D 末尾那件「要定的一件事」:从前这本账上**没有事项 id**,于是动作闸的第一条规矩
   * (「收场了就不再动那一家」)在这条巡检上退化成只管次数 —— 她在别处把这件收了,
   * 这边照旧每 8 秒去读那一家的窗。现在:有卡认领了这条会话就记下那张卡
   * (判法在 `jobKey.itemOfSession` 一处),闸就按卡的状态算;真没有卡**不硬造一张**
   * (卡 BR 第三节:为了捎一句话偷偷建卡正是「先归档」那个毛病)—— 那一条用会话当键,
   * 闸按那条会话收没收场判(见 {@link relayJobOf})。
   */
  item_id?: string
  /*
   * ★ **这里没有「要不要回电」那一格**(2026-10-04,卡 `claude/relay-nocall-noread`)。
   *
   * 维护者那天先说「给个勾选,勾了才需要盯和打电话」,再追一句「(不勾的时候)可以不读」——
   * 于是不勾的那一句**压根不登记进这本账**(判在 `http.ts` / `relayNewConversation.ts` /
   * `index.ts` 解锁重送那三处)。**进了这本账就是她要那一通**,这一层不用再问第二遍。
   */
}

export interface RelayWatchFile {
  version: 1
  waits: RelayWait[]
}

export function emptyRelayWatchFile(): RelayWatchFile {
  return { version: 1, waits: [] }
}

export function defaultRelayWatchFile(home = process.env.HOME ?? ''): string {
  return `${home}/.dsh/workbench/relay.json`
}

/** 台账里最多留多少条(老的就是老的,留着只会越读越慢)。 */
export const RELAY_WAIT_MAX = 100

/**
 * 满了先丢谁(2026-09-30 止血 ②)。以前是 `slice(-100)` —— 老的先丢**包括还在等回话的那几条**:
 * 那一条一被丢掉,巡检再也读不到它,他等的那通电话永远不来,而且没有一个地方说过「不来了」。
 * 现在:**还在等的一条都不丢**(哪怕比上限还多),超出的部分只从**已收场**(replied / timeout)里、按老的先丢。
 */
export function trimRelayWaits(waits: readonly RelayWait[], max = RELAY_WAIT_MAX): RelayWait[] {
  if (waits.length <= max) return [...waits]
  const waiting = waits.filter(one => one.state === 'waiting').length
  // 已收场的这次要丢掉几条(还在等的占满了上限就一条已收场的都不留)。
  let drop = Math.min(waits.length - max, waits.length - waiting)
  return waits.filter((one) => {
    if (one.state === 'waiting' || drop <= 0) return true
    drop -= 1
    return false
  })
}

/**
 * ★ **锁着屏排队、解锁重送之后,要不要为这件活补登记一条回电**(2026-10-04,
 * 卡 `claude/relay-nocall-noread`;接线在 `index.ts` 的 `screenLockWatch.drain.after`)。
 *
 * 判据只有三样,全是这件活自己身上的事实:
 * ① 是捎话(`kind:'relay'`)、② 点名了某条会话(`target.kind:'session'` —— 只有这一种登记得出来)、
 * ③ **她当初勾了**「回了打电话给我」({@link Job.callOnReply},跟着这件活过了一次落盘)。
 *
 * 第 ③ 条是这张卡加的:不勾 = 这本账里压根没有这一条,排队重送那一路也不许偷偷补一条回来。
 */
export function relayWatchOnDrain(job: Pick<Job, 'kind' | 'target' | 'callOnReply'>): boolean {
  return job.kind === 'relay' && job.target.kind === 'session' && job.callOnReply === true
}

/**
 * 这一通电话为哪件事打的。**不是看板上的事项** —— 捎话不挂卡(为了捎一句话偷偷建一张卡
 * 正是「先归档」那个毛病,卡 BR 第三节写明了不硬造)。所以给它一个自己的 id 空间。
 */
export function relayCallItemId(id: string): string {
  return `relay:${id}`
}

/**
 * ★ **这条捎话在动作闸 / 任务日志上的键**(2026-10-02,卡 AG2)。**一处写**:
 * 有事项就用事项 id(她在看板上把那件收了,这条巡检立刻停手);
 * 没有就用会话键(那条对话关掉了 / 认不出来了也算收场,判在 `jobKey.jobPhaseOf`)。
 *
 * 为什么不用账上这一条自己的 id:那个 id 只有这本账认得,看板上查不到它收没收场 ——
 * 闸于是永远只能答「查不出」,那正是 10-02 留下的那个口子。
 */
export function relayJobOf(wait: Pick<RelayWait, 'id' | 'agent' | 'session_id'> & { item_id?: string, session_placeholder?: boolean }): string {
  if (wait.item_id !== undefined) return wait.item_id
  // 占位的会话 id 不冒充会话键(2026-10-02 统筹盘点查出的回归):这家只要有别的会话,会话键会被判成「收场」。
  if (wait.session_placeholder === true) return relayWaitJobId(wait.id)
  return sessionJobId(wait.agent, wait.session_id)
}

/** `relay:xxx` 里的那个 xxx;不是这种就 undefined。 */
export function relayIdOfItem(itemId: string): string | undefined {
  return itemId.startsWith('relay:') && itemId.length > 'relay:'.length ? itemId.slice('relay:'.length) : undefined
}

/**
 * 来电界面上那一行、电话里她要讲的那件事:`Claude「Desktop-workbench 统筹交接」`。
 * **不把「回了」写进标题**:理由那一格(`CALL_OUT_REASON_TITLES.relay` =「回话来了」)已经是它,
 * 手机上那一行会写成「回话来了 Claude「统筹交接」」——同一个词不写两遍。
 */
export function relayCallTitleOf(wait: RelayWait, agentName: (agent: string) => string): string {
  const family = agentName(wait.agent)
  const gap = /[A-Za-z0-9]$/.test(family) ? ' ' : ''
  return wait.title.trim() === '' ? family : `${family}${gap}「${wait.title.trim()}」`
}

/** 念多少字。截了就明说(**不假装这就是全部**)。 */
export function relayNoteBody(reply: string): { text: string, truncated: boolean } {
  const plain = reply.trim()
  if (plain.length <= RELAY_NOTE_MAX) return { text: plain, truncated: false }
  return { text: `${plain.slice(0, RELAY_NOTE_MAX)}…`, truncated: true }
}

/**
 * 工作台记的那一句(电话里她照着它讲人话;手机未接来电那一行也写它)。
 * 两种:回了 → 它回的原话;等太久 → 如实说还没回、捎进去多久了。
 */
export function relayCallNoteOf(wait: RelayWait, now: number): string {
  const where = RELAY_FROM_TEXT[wait.from]
  if (wait.state === 'replied') {
    const body = relayNoteBody(wait.reply ?? '')
    if (body.text === '') return `你${where}让我捎的那句话,它回了,但读回来是空的 —— 原话在它那扇窗里。`
    return `你${where}让我捎的那句话,它回了。它的原话:${body.text}${body.truncated ? '(后面还有,全文在它那扇窗里)' : ''}`
  }
  const at = Date.parse(wait.at)
  const waited = Number.isNaN(at) ? undefined : Math.max(1, Math.round((now - at) / 60000))
  if (wait.unconfirmed === true) return unconfirmedTimeoutNote(where, waited)
  return waited === undefined
    ? `你${where}让我捎的那句话,到这会儿它还没回。`
    : `你${where}让我捎的那句话,捎进去 ${waited} 分钟了,它还没回。`
}

/**
 * 没核上的那条等过头了(故障 ②):一直没在它对话区里读到这句话 —— **可能根本没发出去**,不能说成「它还没回」。
 */
function unconfirmedTimeoutNote(where: string, waited: number | undefined): string {
  return `你${where}让我捎的那句话,我按了发送,可${waited === undefined ? '到这会儿' : ` ${waited} 分钟了`}一直没在它对话区里看到这句话,也没读到回话 —— 可能没发出去,去它窗口里看一眼是不是还停在输入框里。`
}

/** 电话里「看一眼」时带上的那条捎话,只看这么久以内的(再老的她早放下了)。 */
export const RELAY_LEDGER_RECENT_MS = 3 * 60 * 60 * 1000

/**
 * 电话里「看一眼 / 它回了没」时,**捎话账上这一家最近那一条**原样说一句(2026-09-30 晚,故障 ③):
 * 窗口型那几家(豆包)读不出对话,可我们捎进去的那句、读回来的那段回话在账上 —— 不经模型,读到什么说什么。
 * 没有这一家的、或都是 3 小时前的 → undefined(调用方就不加这一句)。
 */
export function relayLedgerLineOf(waits: readonly RelayWait[], isFamily: (agent: string) => boolean, now: number): string | undefined {
  let latest: RelayWait | undefined
  let latestAt = -Infinity
  for (const one of waits) {
    if (!isFamily(one.agent)) continue
    const at = Date.parse(one.at)
    if (Number.isNaN(at) || now - at > RELAY_LEDGER_RECENT_MS || at < latestAt) continue
    latest = one
    latestAt = at
  }
  if (latest === undefined) return undefined
  const where = RELAY_FROM_TEXT[latest.from]
  const ago = Math.max(1, Math.round((now - latestAt) / 60000))
  const head = `你${where}让我捎的那句(${ago} 分钟前送进去的)`
  if (latest.state === 'replied') {
    const body = relayNoteBody(latest.reply ?? '')
    if (body.text === '') return `${head},它回了,但读回来是空的 —— 原话在它那扇窗里。`
    return `${head},它回了。它的原话:${body.text}${body.truncated ? '(后面还有,全文在它那扇窗里)' : ''}`
  }
  if (latest.state === 'timeout') return `${head},一直没读到它回话${latest.unconfirmed === true ? ',发的时候也没在它对话区里看见这句话 —— 可能没发出去' : ''}。`
  return `${head},还没读到它回话,我盯着${latest.unconfirmed === true ? '(发的时候没在它对话区里看见这句话,先别重发)' : ''}。`
}

export interface RelayPlan {
  /** 这一拍要去窗口里读的那几条。 */
  poll: readonly RelayWait[]
  /** 等过头了:转 `timeout`,然后也打一通说「还没回」。 */
  timeout: readonly RelayWait[]
  /** 该排电话的那几条(回了 / 等过头了,而且还没排过)。 */
  call: readonly RelayWait[]
}

/** 这一拍要做什么。**纯函数** —— 谁去读窗口、谁去排电话都不在这里。 */
export function planRelayWatch(input: { waits: readonly RelayWait[], now: number, timeoutMs?: number }): RelayPlan {
  const timeoutMs = input.timeoutMs ?? RELAY_WAIT_MAX_MS
  const poll: RelayWait[] = []
  const timeout: RelayWait[] = []
  for (const wait of input.waits) {
    if (wait.state !== 'waiting') continue
    const at = Date.parse(wait.at)
    if (!Number.isNaN(at) && input.now - at >= timeoutMs) timeout.push(wait)
    else poll.push(wait)
  }
  const call = input.waits.filter(one => one.state !== 'waiting' && one.call_id === undefined)
  return { poll, timeout, call: [...call, ...timeout] }
}

// ———————————————————————— 读那扇窗(壳那一套) ————————————————————————

export interface RelayReadResult {
  /** 窗口里找到我们送进去的那一句了。 */
  found: boolean
  /** 那家还在生成(有「停止」键)。 */
  busy: boolean
  /** 我们那一句之后的字,摘掉界面字之后的那一段。 */
  text: string
}

export interface RelayReader {
  /**
   * `bundleId`:轻账上记着真送进去的那个包就用它(见 {@link RelayWait.bundle_id})。
   * `waitId` / `placeholder` / `itemId`:**这件事的键**要与登记那一刻一模一样(闸按它数、按它判收场),
   * 拼法在 `jobKey.relayJobOf` 一处 —— 这里只把那三格原样交下去。
   */
  read: (req: {
    agent: string
    sessionId: string
    mark: string
    bundleId?: string
    waitId?: string
    placeholder?: boolean
    itemId?: string
    /** 送那一刻报的轮号(账上 `turn_id`):协议型只认这一轮。 */
    turnId?: string
  }) => Promise<RelayReadResult>
}

export interface RelayReaderDeps {
  /**
   * 一条引擎(`engine/wire.ts` 造的那一份)。**这一层从此不认识壳**:
   * 挑哪条通道(协议 > 窗口)、挑哪个包、过 `reply_watch` 那道闸、豆包办公那一路多读一次整扇窗,
   * 全在引擎与适配器一处。
   */
  engine: Pick<Engine, 'read'>
}

/**
 * ★ **读那一段此刻的回话:走引擎的 `read`**(2026-10-02,卡「引擎接线与删复制品」)。
 *
 * 从前这里是 `createHelperRelayReader`:自己拿壳、自己按家名查包、自己 `read_reply`、自己摘界面字 ——
 * 与派活盯窗(`dispatchRun.checkWindow`)那一份几乎一样,两处的包、超时、豆包那条退路各漂各的
 * (审计第二表第 2、3、9 条)。现在两处都调同一个 `engine.read`。
 *
 * **这一层只剩「这一拍读到了什么」这一个翻译**:
 * ① 读到了、写完了 → `found:true` + 那一段;② 读到了、它还在写 → `found:true, busy:true`;
 * ③ 读不到 / 闸拦下 → `found:false`(**「读不到」不是「它还没回」** —— 这一条照旧只是「这一拍没读到」,
 * 等过头那一路会如实回电说「它还没回」)。
 */
export function createEngineRelayReader(deps: RelayReaderDeps): RelayReader {
  return {
    async read(req) {
      /*
       * 这一件事的键要与登记那一刻**一模一样**(闸按它数、按它判收场):
       * 有卡就是卡,占位的那一条用它自己的 id,别的用会话键 —— 拼法在 `jobKey.ts` 一处,
       * 这里只是把它摆成引擎认得的形状(`engineJobKey` 会算出同一个字符串)。
       */
      const job: Job = {
        id: relayWaitJobId(req.waitId ?? ''),
        family: req.agent,
        kind: 'relay',
        target: req.placeholder === true ? { kind: 'current' } : { kind: 'session', sessionId: req.sessionId },
        // 读那一下认「我们那一句」用的就是这个记号(`text` 空 → 适配器取 `marks[0]`)。
        text: '',
        marks: [req.mark],
        expect: 'reply',
        ...(req.itemId === undefined ? {} : { itemId: req.itemId }),
        ...(req.bundleId === undefined ? {} : { package: req.bundleId }),
        ...(req.turnId === undefined ? {} : { turnId: req.turnId }),
      }
      const got: AdapterReadResult = await deps.engine.read(job).catch(() => ({ via: 'none' as const, evidence: 'none' as const }))
      const reply = got.reply ?? ''
      if (got.busy === true) return { found: true, busy: true, text: reply }
      if (reply.trim() !== '') return { found: true, busy: false, text: reply }
      return { found: false, busy: false, text: '' }
    },
  }
}

// ———————————————————————— 服务 ————————————————————————

export interface RelayWatchService {
  load: () => Promise<void>
  /**
   * 捎进去了,记一条。**送成了才记**。
   *
   * `watch_only`:★ 2026-10-03(卡「接缝清理」第 1 条)—— 这一条是「只盯不发」
   * (她自己发的那句,我们只核到它在对话区里看得见),账上记 `seen` 不记 `sent`。
   */
  remember: (input: { agent: string, session_id: string, title: string, mark: string, from: RelayFrom, bundle_id?: string, unconfirmed?: boolean, session_placeholder?: boolean, watch_only?: boolean, item_id?: string, turn_id?: string }) => Promise<RelayWait>
  /** 走一拍:读回话 → 该打的排电话。挂在 http.ts 那根既有的 1 秒节拍上,内部限频。 */
  pump: () => Promise<void>
  /** 台账(他问「我让你捎的那句回了吗」时看得见;不进 /state)。 */
  list: () => readonly RelayWait[]
}

export interface RelayWatchOptions {
  file: string
  reader: RelayReader
  /** 排电话那条路(`callOut.request`)。缺席 = 只读回话、不打电话。 */
  callOut?: {
    request: (input: { reason: CallOutReason, item_id: string, title?: string, note?: string }) => Promise<{ ok: boolean, entry?: { id: string }, error?: string }>
  }
  /** 家名(「Claude」)。缺席就用 agent 原样。 */
  agentName?: (agent: string) => string
  now?: () => number
  newId?: () => string
  pollMs?: number
  timeoutMs?: number
  /*
   * ★ **动作闸不在这一层了**(2026-10-02,卡「引擎接线与删复制品」)。
   *
   * 卡 AG 把闸接在这条巡检上(每一条读之前问一句),卡 AG2 又接到了另外七处 ——
   * 于是「这件事还动不动得」散在七八个地方,漏一处就又会在事情收场之后接着碰那一家。
   * 现在闸**只接在引擎一处**:这条巡检调 `engine.read`,`reply_watch` 那道闸在它里面。
   * 拦下的那一拍 `read` 回「没读到」(`blocked`),与从前 `continue` 的效果一样 ——
   * 不读窗、不改账,为什么拦下闸自己记了。
   */
  /**
   * ★ **这条会话归哪一件事**(2026-10-02,卡 AG2):记一条的时候问一次,记下事项 id
   * (`jobKey.itemOfSession` 从看板上数出来)。缺席 / 数不出来 → 这一条用会话键(见 {@link relayJobOf})。
   */
  itemOf?: (agent: string, sessionId: string) => string | undefined
  /**
   * ★ **任务日志**(2026-10-02,卡 AG):这条管线的关键点也写事件(投递 → 回了 / 等过头 → 已打电话),
   * 于是「捎出去的那句到哪一步了」也能从落盘以外的一本账里查回来。缺席 = 不记账(行为一字不变)。
   */
  jobLog?: JobLog
}

export function createRelayWatchService(options: RelayWatchOptions): RelayWatchService {
  const now = options.now ?? (() => Date.now())
  const newId = options.newId ?? (() => `r-${randomUUID().slice(0, 8)}`)
  const agentName = options.agentName ?? (agent => agent)
  const pollMs = options.pollMs ?? RELAY_POLL_MS
  let data: RelayWatchFile = emptyRelayWatchFile()
  let loaded = false
  let pumping = false
  let lastPoll: number | undefined
  /** 哪几家这会儿还在读(上一拍没读完的那一家这一拍跳过,别家照读)。 */
  const reading = new Map<string, Promise<void>>()
  /** 上一拍落盘坏了没(连着坏只记一行日志)。 */
  let persistWarned = false
  /** 上一拍读回来的那一段(判「稳住了没有」用;只在内存里,重启最坏是多等一轮)。 */
  const lastRead = new Map<string, string>()
  let queue: Promise<unknown> = Promise.resolve()

  function enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = queue.then(fn, fn)
    queue = next.then(() => undefined, () => undefined)
    return next
  }

  /**
   * **落不了盘就抛**(2026-09-30 止血 ①)。以前这里一律吞掉,于是 `remember` 永远「成功」,
   * 上一层照着回一句「它回了我打电话告诉你」—— 账上一个字都没有,那通电话永远不来。
   * 现在:记一条那一路让它抛(调用方如实说「回电没登记上」);巡检那一路自己接住、只记一行日志。
   */
  async function persist(): Promise<void> {
    data = { ...data, waits: trimRelayWaits(data.waits) }
    await mkdir(dirname(options.file), { recursive: true })
    const tmp = `${options.file}.tmp`
    await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
    await rename(tmp, options.file)
  }

  function patch(id: string, next: Partial<RelayWait>): void {
    const index = data.waits.findIndex(one => one.id === id)
    if (index < 0) return
    data.waits[index] = { ...(data.waits[index] as RelayWait), ...next }
  }

  /** 为这一条排一通电话。排不出来(上一通还没收场)就什么都不记,下一拍再试。 */
  async function ring(wait: RelayWait, at: number): Promise<boolean> {
    if (options.callOut === undefined) return false
    const result = await options.callOut.request({
      reason: 'relay',
      item_id: relayCallItemId(wait.id),
      title: relayCallTitleOf(wait, agentName),
      note: relayCallNoteOf(wait, at),
      /*
       * ★ **这儿不问「响不响」**(2026-10-04,卡 `claude/relay-nocall-noread`):
       * 账上有这一条就是她那一句上勾过「回了打电话给我」,不勾的根本没登记进来。
       * 响不响剩下的唯一变数是免打扰时段,那一条在 `callOut` 自己那层。
       */
    })
    if (!result.ok || result.entry === undefined) return false
    patch(wait.id, { call_id: result.entry.id })
    options.jobLog?.append({ job: relayJobOf(wait), step: 'called', family: wait.agent })
    return true
  }

  return {
    async load() {
      await enqueue(async () => {
        try { data = sanitizeRelayWatchFile(JSON.parse(await readFile(options.file, 'utf8')) as unknown) }
        catch { data = emptyRelayWatchFile() }
        loaded = true
      })
    },

    async remember(input) {
      // 这条会话归哪一件事:调用方说了就听它,没说就问一次(数不出来就缺席 —— 不硬造一张卡)。
      const itemId = input.item_id ?? options.itemOf?.(input.agent, input.session_id)
      const wait: RelayWait = {
        id: newId(),
        agent: input.agent,
        session_id: input.session_id,
        title: input.title,
        mark: input.mark,
        at: new Date(now()).toISOString(),
        from: input.from,
        state: 'waiting',
        ...(input.bundle_id === undefined || input.bundle_id === '' ? {} : { bundle_id: input.bundle_id }),
        ...(input.unconfirmed === true ? { unconfirmed: true as const } : {}),
        ...(input.session_placeholder === true ? { session_placeholder: true as const } : {}),
        ...(itemId === undefined || itemId === '' ? {} : { item_id: itemId }),
        ...(input.turn_id === undefined || input.turn_id === '' ? {} : { turn_id: input.turn_id }),
      }
      // 同一家、同一句、还在等的那一条已经有了 → 不再记第二条(电话里说两遍「盯着」只排一通;2026-09-28 Air 维护包)。
      // **落不了盘就抛**(2026-09-30 止血 ①):内存里那一条留着(下一拍还能读、还能补落盘),
      // 但调用方拿到的是失败 —— 宁可少许一句承诺,也不许许一通不会来的电话。
      let existing: RelayWait | undefined
      await enqueue(async () => {
        existing = data.waits.find(one => one.agent === input.agent && one.mark === input.mark && one.state === 'waiting')
        if (existing !== undefined) return
        data.waits = [...data.waits, wait]
        await persist()
        /*
         * 四步里的「指派 + 投递」(2026-10-02,卡 AG):捎话是**送成了才记一条**,所以这两步一起记。
         *
         * ★ 2026-10-02(卡「引擎接线与删复制品」)只在**占位**那两路记了:
         * 「只盯不发」与「新开一条」这一刻还认不出是哪条对话,键是这一条自己的
         * (`relayWaitJobId`),引擎在那个键上一条都没记过 —— 不补就查不到这件事派给了谁。
         * 而**点名某条会话捎话**那一路,键与引擎送话那一下**是同一个**
         * (`sessionJobId` / 事项 id),引擎已经把指派与投递连着证据记上了;
         * 两边都记的后果在真机那一跑的 `GET /jobs/<id>/trace` 上看得见:
         * 一次送话四行账、两条 `assigned`,其中一条没有动作、没有包标识。账只许有一个记的人。
         *
         * ★ 2026-10-03(卡「接缝清理」第 1 条,决策记录「2026-10-03 早」⑦):投递那一步
         * **「只盯不发」记 `seen`、新开一条记 `sent`**。前者那句话是她自己发的,我们只核到
         * 「它在对话区里看得见」—— 一个字都没送,记成 `sent` 与「一个字不说成送到了」擦边
         * (交接 1002 第六节 ⑤ 留的那一条)。`seen` 在四步表上照旧算「投递」,所以不会从此显示成「没送」。
         */
        if (wait.session_placeholder === true) {
          options.jobLog?.append({ job: relayJobOf(wait), step: 'assigned', family: wait.agent })
          options.jobLog?.append({
            job: relayJobOf(wait),
            step: input.watch_only === true ? 'seen' : 'sent',
            family: wait.agent,
            ...(wait.bundle_id === undefined ? {} : { bundle_id: wait.bundle_id }),
          })
        }
      })
      return existing ?? wait
    },

    async pump() {
      /** 读一眼一条;读到了、稳住了就落账(这一条这会儿已经不在等了 —— 别的路收掉了 —— 就不动它)。 */
      async function readOne(wait: RelayWait, at: number): Promise<void> {
        const read = await options.reader.read({
          agent: wait.agent,
          sessionId: wait.session_id,
          mark: wait.mark,
          waitId: wait.id,
          ...(wait.session_placeholder === true ? { placeholder: true } : {}),
          ...(wait.item_id === undefined ? {} : { itemId: wait.item_id }),
          ...(wait.bundle_id === undefined ? {} : { bundleId: wait.bundle_id }),
          ...(wait.turn_id === undefined ? {} : { turnId: wait.turn_id }),
        })
        if (!read.found) return
        if (data.waits.find(one => one.id === wait.id)?.state !== 'waiting') return
        // 在它对话区里读到我们那一句了 = 真发出去了(没核上的那条到这里才算核上)。
        if (wait.unconfirmed === true) {
          const index = data.waits.findIndex(one => one.id === wait.id)
          const { unconfirmed: _seen, ...rest } = data.waits[index] ?? wait
          void _seen
          if (index >= 0) data.waits[index] = rest
        }
        const previous = lastRead.get(wait.id)
        const settled = replySettled({ ...(previous === undefined ? {} : { previous }), current: read.text, busy: read.busy })
        lastRead.set(wait.id, read.text)
        if (!settled) return
        const body = relayNoteBody(read.text)
        options.jobLog?.append({ job: relayJobOf(wait), step: 'replied', family: wait.agent })
        patch(wait.id, {
          state: 'replied',
          reply: read.text,
          ...(body.truncated ? { truncated: true as const } : {}),
          replied_at: new Date(at).toISOString(),
        })
        lastRead.delete(wait.id)
      }
      if (!loaded || pumping) return
      const at = now()
      if (lastPoll !== undefined && at - lastPoll < pollMs) return
      const plan = planRelayWatch({
        waits: data.waits,
        now: at,
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      })
      if (plan.poll.length === 0 && plan.call.length === 0) return
      lastPoll = at
      pumping = true
      try {
        // ① 等过头的:转 timeout(读窗口之前就转 —— 这一拍就该回电说「还没回」)。
        for (const wait of plan.timeout) {
          patch(wait.id, { state: 'timeout' })
          options.jobLog?.append({ job: relayJobOf(wait), step: 'timeout', family: wait.agent })
        }
        // ② 还在等的:读一眼那一段(闸在 `engine.read` 里 —— 拦下的那一拍回「没读到」,不读窗、不改账)。
        // ★ 2026-10-21:**按家分开读**,同一家逐条、不同家并行;一家还没读完,这一拍跳过它(见 RELAY_READ_BUDGET_MS)。
        const byFamily = new Map<string, RelayWait[]>()
        for (const wait of plan.poll) byFamily.set(wait.agent, [...(byFamily.get(wait.agent) ?? []), wait])
        for (const [family, waits] of byFamily) {
          if (reading.has(family)) continue
          const run = (async () => { for (const wait of waits) await readOne(wait, at) })()
            .catch(() => { /* 一条读坏了不连累别的 */ })
            .finally(() => { reading.delete(family) })
          reading.set(family, run)
        }
        let budget: ReturnType<typeof setTimeout> | undefined
        await Promise.race([
          Promise.all([...reading.values()]),
          new Promise<void>((resolve) => { budget = setTimeout(resolve, RELAY_READ_BUDGET_MS); budget.unref?.() }),
        ])
        if (budget !== undefined) clearTimeout(budget)
        // ③ 该打的打(回了的 + 刚转成 timeout 的;排不出来下一拍再试)。
        for (const wait of [...data.waits]) {
          if (wait.state === 'waiting' || wait.call_id !== undefined) continue
          await ring(wait, at)
        }
        // 巡检这一拍落不了盘:**不能把整条节拍带走**(下一拍照读照打),但也不许一声不吭 —— 记一行。
        // 日志里只有「记不上」这件事,**没有她那句话、没有记号**(卡 BR 那条纪律)。
        // 连着坏就只记第一行(8 秒一拍,刷满一屏日志帮不了任何人);写成了再坏会再记一行。
        await enqueue(async () => {
          try { await persist(); persistWarned = false }
          catch {
            if (!persistWarned) console.warn(RELAY_PERSIST_FAILED_LOG)
            persistWarned = true
          }
        })
      }
      finally { pumping = false }
    },

    list: () => [...data.waits],
  }
}

/** 读盘:读不懂的那几条丢掉(它跨重启,不能让一条坏记录把整本账带走)。 */
export function sanitizeRelayWatchFile(raw: unknown): RelayWatchFile {
  if (typeof raw !== 'object' || raw === null) return emptyRelayWatchFile()
  const value = raw as Record<string, unknown>
  const waits = Array.isArray(value.waits) ? value.waits.flatMap(one => sanitizeWait(one) ?? []) : []
  return { version: 1, waits: trimRelayWaits(waits) }
}

function sanitizeWait(raw: unknown): RelayWait | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const value = raw as Record<string, unknown>
  const text = (key: string): string => (typeof value[key] === 'string' ? value[key] as string : '')
  const id = text('id')
  const agent = text('agent')
  const sessionId = text('session_id')
  const mark = text('mark')
  if (id === '' || agent === '' || sessionId === '' || mark === '') return undefined
  const state = value.state
  const from = value.from
  return {
    id,
    agent,
    session_id: sessionId,
    title: text('title'),
    mark,
    at: text('at'),
    from: from === 'phone' || from === 'call' || from === 'desk' ? from : 'desk',
    state: state === 'replied' || state === 'timeout' ? state : 'waiting',
    ...(typeof value.reply === 'string' && value.reply !== '' ? { reply: value.reply } : {}),
    ...(value.truncated === true ? { truncated: true as const } : {}),
    ...(typeof value.replied_at === 'string' && value.replied_at !== '' ? { replied_at: value.replied_at } : {}),
    ...(typeof value.call_id === 'string' && value.call_id !== '' ? { call_id: value.call_id } : {}),
    ...(typeof value.bundle_id === 'string' && value.bundle_id !== '' ? { bundle_id: value.bundle_id } : {}),
    ...(value.unconfirmed === true ? { unconfirmed: true as const } : {}),
    ...(value.session_placeholder === true ? { session_placeholder: true as const } : {}),
    ...(typeof value.item_id === 'string' && value.item_id !== '' ? { item_id: value.item_id } : {}),
    ...(typeof value.turn_id === 'string' && value.turn_id !== '' ? { turn_id: value.turn_id } : {}),
    /*
     * 老账里那一格(2026-10-04 上一张卡短暂写过的 `call_on_reply`)**原地丢掉**:
     * 账上留着的每一条现在一律算「她要那一通」。热更新那一刻还在等回话的那几条照旧响
     * —— 它们当初登记进来就是因为她要(不勾的从此不登记)。
     */
  }
}
