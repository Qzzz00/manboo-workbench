/**
 * 派活的第一段:**把一段话直接送进窗口槽里那家客户端的输入框**(2026-09-21)。
 *
 * Ben 纠正过派活的定义:「派活是直接操作对应的 Agent 客户端」——用户手里是订阅,不是 API Key。
 * 三段拆开:① 把话送进去(这个文件 + 壳的 `send_text` 原语);② 知道它做完没(气泡,现成的);
 * ③ 把回复读回来(会话文件,现成的)。**这里只做 ①**,②③ 一行都不重写,
 * 只把送出去的这件事和那家**新冒出来的那条会话**关联上(`matchNewSession`)。
 *
 * 这个文件里绝大多数是纯函数(白名单、失败归因、会话匹配),真去碰窗口的只有 `createClientDispatch`
 * 那一段,而它的每一样外部能力都是注入的——用例里一次也不会激活 Ben 真的窗口。
 */
import type { ClientDispatchFamily, TaskClientDispatch } from '../protocol.ts'
import { dispatchFamilyTitle, isClientDispatchFamily } from '../protocol.ts'
import { FAMILY_SOURCES, pickFamilyPackage } from './agentSources.ts'
import type { ClientDraftSaved } from './clientDrafts.ts'
import { draftSavedNote } from './clientDrafts.ts'
import type { DispatchTarget } from './dispatchTargets.ts'
import { dispatchReadiness, fallbackTargets } from './dispatchTargets.ts'
import type { UnreadableApp } from './dispatchTargets.ts'
import type { HelperRequest } from './helperChannel.ts'
/** 「壳没应声」那两句原话:判据一处在那个文件里(2026-10-13,卡 N)。 */
import { HELPER_GONE_REASON, HELPER_TIMEOUT_REASON } from './helperChannel.ts'
/** 「电脑锁着屏」那一截字(壳那一侧同一个常量,有对照用例);2026-10-03。 */
import { isScreenLockedReason } from './screenLock.ts'
import { windowProgressBusy, inSidebar, parseRead } from './agentWindowModel.ts'
/*
 * 「没窗口就把窗开出来再来一遍」那一圈(卡 AX / AX2)**只有一份**,在 `windowWake.ts` 里 ——
 * 2026-10-01 卡 AX3 把派活这条路也接进它(从前它只有自己那套「换同一家另一个包」,一回都不重开)。
 */
import { NO_WINDOW_WAKE_WAIT_MS, noWindowWhy, withWindowWake } from './windowWake.ts'
import type { FrontTrace, WindowWakeDeps } from './windowWake.ts'
/** 动作闸(2026-10-02,卡 AG):对别家 App 的每一个自动动作先过它一处。 */
import type { ActionGate } from './actionGate.ts'

/*
 * ★ **「家 → 包」那张表删了**(2026-10-02,卡「引擎接线与删复制品」;审计第二表第 9 条)。
 *
 * 这里原来有 `CLIENT_DISPATCH_BUNDLES`(家名 → **主包**),`http.ts` 还从它拼了一张反查表。
 * 一家装着两个包时(Air 上的豆包)它只认得主包,于是同一个 App 在两处被说成两家。
 * 现在只问家族目录一处:`agentSources.bindingForBundle` / `packagesOf` / `pickFamilyPackage`
 * ——它们本来就认一家的**全部**包。
 */

/**
 * **永远不许送的那几家**。微信 / 企业微信是 IM:往聊天窗口里打一行字再按回车,
 * 是以 Ben 的身份对**真人**说话,跟"派活给 Agent"是两件事。
 *
 * 判定走的是上面那张白名单(不在表里就是不行),这张黑名单只为让用例能指着它们说
 * 「这几家永远不行」——白名单哪天手滑加错了,红的是这条用例。
 */
export const CLIENT_DISPATCH_NEVER: readonly string[] = [
  'com.tencent.xinWeChat',
  'com.tencent.WeWorkMac',
]

/**
 * 窗位叠里那家的键(`dock.switchTo` 认的是 registry 键,不是 bundle id)。
 * 豆包没有进过基础七应用那张表,所以它没有键——叫不到台前时如实说,不瞎编一个键去切。
 */
export const CLIENT_DISPATCH_DOCK_KEYS: Readonly<Record<string, string | undefined>> = Object.fromEntries(
  FAMILY_SOURCES.map(one => [one.agent, one.dockKey]),
)

/*
 * ★ **2026-09-25(卡 Z)`CLIENT_DISPATCH_OPEN_COMMANDS` 删了**。原来这里一家一行写着
 * `open -a Claude` / `open -a ChatGPT` / …,加一家就得多一行。现在拉起哪一家由
 * `agentSources.ts` 的 `openCommandFor` 回答:**一律按包标识拉**(`open -b <包标识>`,与 `apps.ts` 的
 * `APP_COMMANDS` 逐字相同)—— 运行时新接上的一家不改代码也拉得起来,也不假定 App 在这台机器上叫什么。
 */

/**
 * 那家的会话在会话流里挂在哪个 agent 下(②③ 用的是现成的会话流,这里只是对上号)。
 * 豆包**没有会话流**:它不是 Agent 客户端那一类,读不到会话文件——认不上就如实说。
 */
export const CLIENT_DISPATCH_AGENTS: Readonly<Record<string, string | undefined>> = Object.fromEntries(
  FAMILY_SOURCES.map(one => [one.agent, one.feed === true ? one.agent : undefined]),
)

/** 卡面上那句话:「派给 Claude(窗口)· 已送出」。 */
/**
 * 这一次送话是**谁发起的**(2026-09-22,Ben 定的 A2)。
 *
 * 原话:「送话进窗口:事务官主动派的替按回车,用户手点的不按。」
 * 「事务官主动派的」有三个来源,它们共同点是**意图已经明确**:他在电话里说了「让 Claude 看看 X」、
 * 或者在事项/收件箱上把一件事交办给了某一家 —— 这时话送进去还停在框里等他再按一下,
 * 那条链就不是自动的,而他刚刚已经说过一次了。
 *
 * - `item`  事项卡上交办的(卡上写着派给谁)
 * - `call`  电话里说的(工人 → 事务官 → 这一条)
 * - `inbox` 收件箱里交办的
 * - `ui`    **他自己在界面上点了「送进窗口」** —— 这一种不按:他点的是"送进去",
 *           不是"发出去";这两件事在他眼里本来就是两下。
 * - `hub`   **事务官(理解中枢)派的**(2026-10-29,任务书「中枢派到窗口手不按发送」):
 *           电脑对话框 / 电话 / 手机进来的话,由中枢决定派给谁 —— 意图已经明确,替按。
 */
export const CLIENT_DISPATCH_SOURCES = ['item', 'call', 'inbox', 'ui', 'hub'] as const
export type ClientDispatchSource = typeof CLIENT_DISPATCH_SOURCES[number]

/** 认来源。认不出回 undefined —— 调用方传错名字要当场知道,不能悄悄按缺省走。 */
export function clientDispatchSource(value: unknown): ClientDispatchSource | undefined {
  return typeof value === 'string' && (CLIENT_DISPATCH_SOURCES as readonly string[]).includes(value)
    ? value as ClientDispatchSource
    : undefined
}

/**
 * 这个来源要不要替他按回车。**没来源 = 不按**(老调用方一个字不用改;
 * 而且送错一句话是撤不回来的,缺省永远站在"不按"那一边)。
 */
export function submitForSource(source: ClientDispatchSource | undefined): boolean {
  return source === 'item' || source === 'call' || source === 'inbox' || source === 'hub'
}

export function dispatchBadgeText(dispatch: TaskClientDispatch): string {
  const who = dispatchFamilyTitle(dispatch.family)
  if (dispatch.status === 'failed') return `派给 ${who}(窗口)· 没送成`
  // 2026-09-28(卡 WR):字进了框、没发出去 —— 这一句在卡上、电话里、收件箱里都不许说成「已发出」。
  if (dispatch.status === 'typed') return `派给 ${who}(窗口)· 字写进框里了,没发出去`
  // 2026-09-24(卡 F):与客户端 boardModel 那一份逐字相同(两边各有用例钉着)。
  if (dispatch.reply_state === 'done') return `派给 ${who}(窗口)· 回来了`
  if (dispatch.reply_state === 'unreadable') return `派给 ${who}(窗口)· 已发出,结果在 ${who} 里`
  if (dispatch.reply_state === 'waiting') return `派给 ${who}(窗口)· 已发出,等它回答`
  return dispatch.submitted === true ? `派给 ${who}(窗口)· 已送出并发送` : `派给 ${who}(窗口)· 已送出`
}

/**
 * 失败要说得出是**哪一步**断的(卡上的规矩:不假装成功)。
 *
 * 壳回来的是一句人话(见 `SendTextPolicy.Failure.message`),这里再归一次类,
 * 是为了让界面与收件箱能按类型说下一句该干什么 —— **归不出类就归 `other`,
 * 并把原话原样带走**,绝不为了让分类好看而猜。
 */
export type DispatchFailureKind = 'not_allowed' | 'no_window' | 'screen_locked' | 'ax_disabled' | 'no_input' | 'not_typed' | 'helper_down' | 'helper_timeout' | 'draft_in_the_way' | 'modal_in_the_way' | 'tree_shell_only' | 'other'

export function classifyFailure(reason: string): DispatchFailureKind {
  /*
   * ★ 2026-10-03(卡「锁屏时窗口型的家送不进」):**电脑锁着屏**。
   *
   * 这一条**排在「没窗口」前面**,而且必须是独立的一类:锁屏时壳报的本来就是
   * 「一扇标准窗口都没有」,归成 `no_window` 的下一步是「把它的窗开出来再送 / 换同一家另一个包」——
   * 而那两下在锁屏时一次都不该做(2026-10-03 09:04 真机:7 秒 `open -b` 五次,一下都没用)。
   * 判据只有那一截字(`screenLock.SCREEN_LOCK_MARK`),与壳那一侧同一个常量。
   */
  if (isScreenLockedReason(reason)) return 'screen_locked'
  /*
   * ★ 2026-10-13(卡 N):**op 发出去了、壳没应声**(60 秒没回,或者这一下正走着壳断了)。
   *
   * 与 `helper_down`(壳压根没连上 —— 一个 op 都没发出去)必须分成两类:这一类**可能已经做到了**。
   * 10-13 17:42 真机:豆包窗口里那句「【工作台派活 c43a90】…」明明送进去了、图也出了,壳那一送却
   * 整 60 秒没回 —— 归成 `other` 的后果是当场判「没派出去」,还把「壳响应超时」四个字念给了她。
   * 排在这里(锁屏之后、「没窗口」之前):锁屏那一档的下一步是排队等解锁,比这一档更该先认;
   * 而这一类**一回窗都不重开、一个包都不换**,所以不能落到 `no_window` 那条路上。
   * 判据那两句原话在 `helperChannel` 一处导出,这里不逐字抄。
   */
  if (reason.includes(HELPER_TIMEOUT_REASON) || reason.includes(HELPER_GONE_REASON)) return 'helper_timeout'
  // 2026-09-27(卡 MS):输入框里有他没发出去的字。以前归 `other`(「没送成」),
  // 于是念给他听的是壳那句带包标识和 `overwrite` 的原话 —— 那不是人话,也没说下一步。
  if (reason.includes('输入框里有你没发出去的字')) return 'draft_in_the_way'
  /*
   * ★ 2026-09-28(卡 DP):**它窗口上弹着一层框挡住了输入框**,壳按不到纯关闭的键。
   * 这两类要与「找不到输入框」分开:后者是这家客户端的事实(没有输入框),
   * 前者她去点一下就好,所以事项该挂「等你处理」、话里要说下一步(见 `humanizeFailure`)。
   */
  if (reason.includes('弹了个框挡着')) return 'modal_in_the_way'
  if (reason.includes('网页那一层没长出来')) return 'tree_shell_only'
  if (reason.includes('白名单')) return 'not_allowed'
  // 「辅助功能通道」这几个字是判据 —— 壳那句原话 09-28 换了措辞(-25204 不是权限没给),归类不许跟着漂。
  if (reason.includes('辅助功能通道') || reason.includes('25211') || reason.includes('25204') || reason.includes('辅助功能未授权')) return 'ax_disabled'
  if (reason.includes('输入框没找到') || reason.includes('输入框没接住')) return 'no_input'
  if (reason.includes('读回来对不上') || reason.includes('剪贴板')) return 'not_typed'
  if (reason.includes('找不到窗口') || reason.includes('未在运行') || reason.includes('一扇标准窗口都没有')) return 'no_window'
  /*
   * 2026-10-02 补上「没连上」这一种说法:窗口适配器那一句是 `HELPER_DOWN_WHY`
   * (「工作台 App 没连上…」),而这里原来只认「未运行 / 断开」—— 归不出类就落进 `other`,
   * 于是 `FAILURE_HINTS.helper_down`(「工作台的窗口编排壳没接上」)那条路再也到不了。
   */
  if (reason.includes('工作台 App 未运行') || reason.includes('工作台 App 没连上')) return 'helper_down'
  return 'other'
}

/**
 * ★ **这一下壳没应声**(2026-10-13,卡 N):op 已经发给壳了,它做没做到**我们不知道**。
 *
 * 送话那一层据此**不立刻判没派** —— 等一会儿再读一眼那扇窗(只读),看得见这一单的标记行就按
 * 「它窗口里看见了」记。归类只在 {@link classifyFailure} 一处,这里不抄第二份判据。
 */
export function isHelperQuietReason(reason: string): boolean {
  return classifyFailure(reason) === 'helper_timeout'
}

/** 给人看的那一句(收件箱里问「要我自己来吗」时用它开头)。 */
export const FAILURE_HINTS: Readonly<Record<DispatchFailureKind, string>> = {
  not_allowed: '这个应用不在可派活的名单里',
  no_window: '那家客户端此刻没有窗口',
  /** 2026-10-03:**电脑锁着屏** —— 不是那一家坏了,窗口型的家在锁屏时一扇窗都列不出来。 */
  screen_locked: '电脑锁着屏,窗口型的家这会儿送不进',
  ax_disabled: '那家客户端的辅助功能通道关着',
  no_input: '找到了窗口,但没找到能写字的输入框',
  not_typed: '字没能留在输入框里',
  helper_down: '工作台的窗口编排壳没接上',
  /** 2026-10-13(卡 N):op 发出去了、壳没应声 —— 不是那一家坏了,是电脑那边这一下没回话。 */
  helper_timeout: '电脑那边没应声',
  draft_in_the_way: '那家的输入框里有你没发出去的字',
  modal_in_the_way: '那家窗口上弹着一个框挡住了输入框',
  tree_shell_only: '那家的窗口里只读到窗口本身,读不到里面的内容',
  other: '没送成',
}

/**
 * 壳那句原话 → **给他听的人话 + 下一步**(2026-09-27,卡 MS)。
 *
 * 21:23 那一通派给豆包,卡上与电话里说的是:
 * 「没送:com.bot.pc.doubao 的输入框里有你没发出去的字,覆盖掉就找不回来了(要覆盖得明着说 overwrite)」。
 * 维护者:这是给机器看的话 —— 包标识他不认,`overwrite` 是我们自己的开关(工作台这头压根送不了它),
 * 而且**没有下一步**。这里只换说法、不改判断:归不出类的一律原话带走(D13)。
 */
export function humanizeFailure(reason: string, family: string): string {
  const kind = classifyFailure(reason)
  /*
   * ★ 2026-10-13(卡 N):**壳没应声**那一句。10-13 17:42 真机上她听到的是
   * 「派给 豆包办公 没派出去:壳响应超时,你说下一步怎么办」——「壳」是我们自己的词,
   * 「响应超时」是机器话,而她要听的是:电脑那边没回话、我去那扇窗里看过了、没看见。
   *
   * 「没看到送进去」说的是**我们手上没有送到的凭据**:替她按发送那一种走到这一句之前,送话那一层
   * 已经只读地核过两回窗(看见了就不是失败);她要的只是「写进框、不发出去」那一种压根没有
   * 可找的那一行 —— 两种都是实话。原因(壳那句原话)由调用方接在分号后面留在卡上:
   * 嘴那一侧 `plainFailureWhy` 只念第一个分号之前那半句,内部口径就不会被念出去。
   */
  if (kind === 'helper_timeout') return `电脑那边没应声,${dispatchFamilyTitle(family)}里没看到送进去`
  /*
   * ★ 2026-09-28(卡 DP):**被一层弹框挡住**那两句也换成人话。壳那句原话里带着包标识
   * (`com.bot.pc.doubao`)与「AX 树」——她不认;而她要听的只有三件:哪一家、什么框、下一步做什么。
   * 现场那个框是豆包的「手机控制电脑 · 随时用手机,继续电脑上的任务」,
   * 左边一颗「开始体验」、右上角一个 × —— 壳只按纯关闭的键,这个按不到就轮到她去点。
   */
  if (kind === 'modal_in_the_way') {
    // 壳那句里框上那话是用全角括号 +「」裹着的(`弹了个框挡着(「手机控制电脑」)`),取里面那一段。
    const what = /弹了个框挡着[^「]{0,2}(「[^」]*」)/.exec(reason)?.[1] ?? ''
    return `${dispatchFamilyTitle(family)}那边弹了个框挡着${what === '' ? '' : `(${what})`},我关不掉 —— 去点一下再叫我派`
  }
  if (kind === 'tree_shell_only') {
    /*
     * ★ 2026-10-13 夜(卡 U,演示机 Codex 排障日志):这一类的壳原话是「网页那一层没长出来」,**没有**「看见了框」的证据 ——
     * 从前这句把它说成「被一层框盖住」,人就去找框、找不到。演示机 21:11 与 22:1x 两次都是把那家关掉重开才读得到内容。
     */
    return `${dispatchFamilyTitle(family)}那扇窗里只读到窗口本身,里面的内容读不到(不一定是有框)—— 把它关掉重开,再叫我派`
  }
  if (kind !== 'draft_in_the_way') return reason
  const who = dispatchFamilyTitle(family)
  // ★ 2026-09-27(卡 DB)改了口径:**「先存下来再发」现在是自动的**(壳把那段原文读出来、
  // 工作台落盘、送完原样放回;见 `clientDrafts.ts`)。所以走到这一句就只剩一种情形 ——
  // **那段字存不下来**(框里读不回内容,或者这台电脑上的工作台 App 还是旧版、不会读回草稿)。
  // 存不下来的东西不许覆盖,于是不送;但要给下一步。
  return `${who}的输入框里有你没发出去的字,我没能把它存下来 —— 存不下来的我不敢覆盖。你把那句发掉或清掉,我马上重派`
}

/**
 * 送出去之后,**哪条会话是这件事的会话**。
 *
 * 规则(写死在这里,交接里逐字抄一份):
 * 1. 送出**那一刻**先取一份基线:那家此刻所有会话 id 的集合;
 * 2. 之后每次来问,拿当前集合跟基线做**差集**;
 * 3. 差集**恰好一条** → 就是它;
 * 4. 差集**多于一条** → 认不准,**一条都不认**(宁可这一格空着,也不能把 Ben 手动开的
 *    另一个对话认成我们派的活),记一句「同时冒出 N 条,认不准」,并且**不再重试**——
 *    再等下去也分不清,只会越等越多;
 * 5. 差集**空** → 还没等到,继续等,直到超时(缺省 30 分钟)。**超时不是错**:
 *    我们默认只把字送进框里、不替他按回车(见卡上第 5 条),他没按之前那边根本不会开新会话;
 * 6. 已经被别的事项认走的会话 id **不参与**(`claimed`),避免两件事抢同一条会话。
 *
 * 为什么按 id 差集而不按时间戳:会话视图里**没有开始时刻**(`SessionView` 只有 `elapsed_sec`
 * 与 `updated_at`,而 `elapsed_sec` 在状态变化时会归零,它不是会话年龄)。拿 `updated_at`
 * 当"开始时间"去比大小,第一条被人动过的老会话就会被认成新的。
 */
export interface SessionMatchInput {
  /** 送出那一刻那家的会话 id(基线)。 */
  baseline: readonly string[]
  /** 现在那家的会话 id。 */
  current: readonly string[]
  /** 已经被别的事项认走的会话 id。 */
  claimed?: readonly string[]
  /** 送出时刻与现在,用来判超时。 */
  sentAt: Date
  now: Date
  /** 等多久(毫秒),缺省 30 分钟。 */
  windowMs?: number
}

export type SessionMatch =
  | { kind: 'matched', session_id: string }
  | { kind: 'waiting' }
  | { kind: 'ambiguous', note: string }
  | { kind: 'timeout', note: string }

export const SESSION_MATCH_WINDOW_MS = 30 * 60 * 1000

/**
 * 哨兵会话不算数:DSH 那个桶里混着 `sentinel:` 开头的探活会话,它不是任何人派的活。
 * (这条对 claude/codex/kimi 三家其实不会命中,留着是因为将来把 dsh 也当一只"手"时会踩到。)
 */
export function isRealSessionId(id: string): boolean {
  return !id.startsWith('sentinel:')
}

export function matchNewSession(input: SessionMatchInput): SessionMatch {
  const baseline = new Set(input.baseline)
  const claimed = new Set(input.claimed ?? [])
  const fresh = input.current.filter(id => isRealSessionId(id) && !baseline.has(id) && !claimed.has(id))
  const only = fresh[0]
  if (fresh.length === 1 && only !== undefined) return { kind: 'matched', session_id: only }
  if (fresh.length > 1) {
    return { kind: 'ambiguous', note: `送出之后那边同时冒出 ${fresh.length} 条新会话,认不准是哪一条——这一格空着` }
  }
  const windowMs = input.windowMs ?? SESSION_MATCH_WINDOW_MS
  if (input.now.getTime() - input.sentAt.getTime() > windowMs) {
    return { kind: 'timeout', note: '一直没等到那边开新会话(多半是那段话还在输入框里,等你按回车)' }
  }
  return { kind: 'waiting' }
}

/**
 * 还在等会话的那几张卡。
 *
 * 三个条件都要:送成了(`sent`)、还没认上会话(没有 `session_id`)、还没放弃(没有 `match_note`)。
 * 没送成的那张不等 —— 它根本没往外送出去任何东西。
 */
export interface PendingDispatchTask {
  id: string
  dispatch: TaskClientDispatch
}

export function pendingDispatchTasks(
  tasks: readonly { id: string, client_dispatch?: TaskClientDispatch }[],
): PendingDispatchTask[] {
  return tasks.flatMap((task) => {
    const dispatch = task.client_dispatch
    if (dispatch === undefined) return []
    if (dispatch.status !== 'sent') return []
    if (dispatch.session_id !== undefined) return []
    if (dispatch.match_note !== undefined) return []
    // 2026-09-24(卡 F):`dispatchRun.ts` 起的派活(带 reply_state)由它自己认会话、自己写卡。
    // 这里再拿一份 /state 快照去写,会把它刚写上的「回答收回来了」盖回旧样子。
    if (dispatch.reply_state !== undefined) return []
    return [{ id: task.id, dispatch }]
  })
}

/** 已经被别人认走的会话 id:别的卡的 `client_dispatch.session_id`,以及卡上原有的关联窗口。 */
export function claimedSessionIds(
  tasks: readonly { client_dispatch?: TaskClientDispatch, links?: readonly { session_id: string }[] }[],
): string[] {
  const out: string[] = []
  for (const task of tasks) {
    const sid = task.client_dispatch?.session_id
    if (sid !== undefined) out.push(sid)
    for (const link of task.links ?? []) out.push(link.session_id)
  }
  return out
}

/** 一次匹配的结论:该把这张卡的那一格改成什么(`undefined` = 还在等,什么都别写)。 */
export function dispatchAfterMatch(
  dispatch: TaskClientDispatch,
  sessionIds: readonly string[],
  claimed: readonly string[],
  now: Date,
  windowMs?: number,
): TaskClientDispatch | undefined {
  const agent = CLIENT_DISPATCH_AGENTS[dispatch.family]
  if (agent === undefined) {
    // 豆包这一档:根本没有会话流可认。**一次就放弃**,并说清是为什么 ——
    // 一张永远在"等会话"的卡比没有这一格更糟。
    return { ...dispatch, match_note: `${dispatchFamilyTitle(dispatch.family)} 没有会话流,认不出它开没开新对话` }
  }
  const sentAt = new Date(dispatch.at)
  if (Number.isNaN(sentAt.getTime())) return undefined
  const match = matchNewSession({
    baseline: dispatch.baseline ?? [],
    current: sessionIds,
    claimed,
    sentAt,
    now,
    ...(windowMs === undefined ? {} : { windowMs }),
  })
  switch (match.kind) {
    case 'matched':
      return { ...dispatch, session_id: match.session_id, matched_at: now.toISOString() }
    case 'ambiguous':
    case 'timeout':
      return { ...dispatch, match_note: match.note }
    case 'waiting':
      return undefined
  }
}

// MARK: - 真去送话的那一段

export interface ClientDispatchHelper {
  connected: () => boolean
  request: (req: HelperRequest, timeoutMs?: number) => Promise<Record<string, unknown>>
  /** 这份壳会不会某件新本事(见 helperChannel 的 `supports`)。缺席 = 按"会"处理(老的假件)。 */
  supports?: (cap: string) => boolean
}

/**
 * 会话匹配的那层薄接线(判断全在上面那几个纯函数里)。
 *
 * **请求驱动 + 限频**,不新开轮询:`/state` 本来就被页面每秒问一次,这里搭在那一拍上,
 * 只有"确实有卡在等会话"时才做事,而且 10 秒内最多一次(先例:`claudeSessionRecover`
 * 的 15 秒限频)。V8 纪律里禁的是"没人看也在转"的定时器,不是这种顺手一算。
 */
export interface DispatchMatcherDeps {
  update: (id: string, dispatch: TaskClientDispatch) => Promise<unknown>
  now: () => Date
  minIntervalMs?: number
  windowMs?: number
}

export interface DispatchMatcher {
  /** 回这一拍改了几张卡。**绝不抛**:认会话失败不该把 /state 带塌。 */
  reconcile: (
    tasks: readonly { id: string, client_dispatch?: TaskClientDispatch, links?: readonly { session_id: string }[] }[],
    sessions: readonly { agent: string, session_id: string }[],
  ) => Promise<number>
}

export const MATCH_MIN_INTERVAL_MS = 10_000

export function createDispatchMatcher(deps: DispatchMatcherDeps): DispatchMatcher {
  const minIntervalMs = deps.minIntervalMs ?? MATCH_MIN_INTERVAL_MS
  let lastRunMs = 0

  async function reconcile(
    tasks: readonly { id: string, client_dispatch?: TaskClientDispatch, links?: readonly { session_id: string }[] }[],
    sessions: readonly { agent: string, session_id: string }[],
  ): Promise<number> {
    try {
      const pending = pendingDispatchTasks(tasks)
      if (pending.length === 0) return 0
      const now = deps.now()
      if (now.getTime() - lastRunMs < minIntervalMs) return 0
      lastRunMs = now.getTime()

      const claimed = claimedSessionIds(tasks)
      let changed = 0
      for (const item of pending) {
        const agent = CLIENT_DISPATCH_AGENTS[item.dispatch.family]
        const ids = agent === undefined
          ? []
          : sessions.filter(s => s.agent === agent).map(s => s.session_id)
        const next = dispatchAfterMatch(item.dispatch, ids, claimed, now, deps.windowMs)
        if (next === undefined) continue
        await deps.update(item.id, next)
        if (next.session_id !== undefined) claimed.push(next.session_id)
        changed += 1
      }
      return changed
    }
    catch {
      return 0
    }
  }

  return { reconcile }
}

/**
 * 壳回来的那一包**到底成没成**(2026-09-25,真机上查出来的病根)。
 *
 * `helperChannel.request()` 的约定是:壳回 `ok:true` → **resolve 的是 `result` 本身**(不带 `ok`);
 * 壳回 `ok:false` → reject 一个 `Error(壳的原话)`。别的调用方(dock / orchestrator / scenes)都是这么用的。
 * 09-21 这一条写成了"resolve 的是整包 `{ok, result}`"——用例里的假壳也照这个错的形状回,于是全绿;
 * 真机上**每一次送成了都被判成没送成**,原因写成一句「壳没说为什么,只说没送成」
 * (09-24 22:53 那一次:Kimi 那边其实已经收到、也答完了)。
 *
 * 现在两种形状都认:带布尔 `ok` 的按它说的(老的假件);不带的就是真通道 resolve 出来的 result。
 * 失败**必须带原因**:壳没给原话时,把回包里有哪几格写出来,不写"没说为什么"。
 */
export function helperOutcome(raw: unknown): { ok: true, result: Record<string, unknown> } | { ok: false, error: string } {
  const obj = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  if (typeof obj.ok === 'boolean') {
    if (obj.ok) {
      return { ok: true, result: (typeof obj.result === 'object' && obj.result !== null ? obj.result : {}) as Record<string, unknown> }
    }
    const keys = Object.keys(obj).filter(key => key !== 'ok')
    return {
      ok: false,
      error: typeof obj.error === 'string' && obj.error.trim() !== ''
        ? obj.error
        : `壳回了失败,但回包里没有原因(只有:${keys.length === 0 ? '什么都没有' : keys.join('、')})`,
    }
  }
  return { ok: true, result: obj }
}
