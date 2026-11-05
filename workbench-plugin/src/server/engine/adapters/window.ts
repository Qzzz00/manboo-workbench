/**
 * ★ **窗口型那几家只有一个适配器**(2026-10-02,卡「窗口适配器」;
 * 设计 `docs/设计-一条引擎替八条管线-2026-10-02.md` 第三节)。
 *
 * 维护者 10-02 原话:「你现在完全不是站在全局、最优解、从底层机制出发去解决问题,一修一个不吱声,
 * 一修一个不达预期,**嘴上说着不打补丁,结果全是打补丁**。」
 *
 * 打补丁的样子是:「往别家 AI 的窗口里送一句话 / 点一下键」这同一件事,从前写在**四个文件里的八处**:
 *
 * | 原来在哪 | 做什么 |
 * |---|---|
 * | `sessionAnswer.createWindowAnswerHand` 的 `send` | 替她答 / 捎话:叫台前 → 深链 → 侧栏点 → 打字发送 → 读窗核 |
 * | 同一只手的 `press` / `writeAsk` / `stop` / `readApproval` / `pressApproval` | 点选项 / 写面板 / 按停止 / 看批准弹窗 / 按批准弹窗 |
 * | `dispatchClient.sendOnce` | 派活:挑包 → 过闸 → 叫台前 → 打字发送 → 核「看见没看见」 |
 * | `dispatchClient.send` | 送不进去就换同一家另一个装着的包 |
 *
 * 八处各有自己的超时、自己的「成没成」判法、自己的措辞、自己的开窗重试接法 —— 10-01 晚四版都在修
 * 同一个「找不到窗口」,就是因为修了一处另外七处照旧。
 *
 * 这一份把那八处收成**一个** {@link createWindowAdapter}:
 * - **开到那一段**只有一段({@link openTo}):深链(有的话)→ 侧栏点一下(`agent_pick`,壳会的话)
 *   → 叫到台前;**没窗口就开窗**只在这一层(`withWindowWake`,全仓一份);
 * - **送 / 点 / 写 / 停**各一条路,差别按 {@link Job.kind} 走,**不按家走**;
 * - **家与家的差别**收在 `window/families.ts` 那张表里(查实之后只剩「有没有深链」一样会执行);
 * - **重试、次数上限、收场判断、落账一概不在这里**(契约 `../adapter.ts` 写明:那些在引擎一处)。
 *   这一层唯一会说的是「这一下可以再来一次」(`RetryableError`),引擎才决定重不重来。
 *
 * ## 两件真机上栽过的事,这里一个字都不许含糊
 *
 * ① 真壳(`helperChannel`)在 `ok:false` 时是 **reject 一个 Error**,不是回 `{ok:false}`
 *    (10-01 20:57 那次真机 4505d5da:「没窗口」直接落进 catch、绕过了开窗那一圈)。
 *    收住两种形状的只有 `helperOutcome` + `withWindowWake` 里那个 `once()`,所以这里**不自己 try/catch 壳**。
 * ② **只在「一扇标准窗口都没有」时重开 / 换包**。那一类壳连窗都没找到,一个字都没打、一下都没点;
 *    别的失败(输入框没接住、那一项点不下去、弹框挡着)是**那扇窗上的事实** ——
 *    重开只会多打一遍、多点一下,换包只会把话送到她没想到的那扇窗里。
 */
import type { CapCell, CapCellView } from '../../../protocol.ts'
import { dispatchUnreadableSay } from '../../../protocol.ts'
import type { ActionGate, GateAction } from '../../actionGate.ts'
/**
 * **自绘界面那一档**(2026-10-02,卡「适配自绘界面的 Kimi」):
 * `paste_only` = 对话文字读得到、输入框与发送键画成了 `AXUnknown` 认不出 ——
 * 送话靠壳内部那条「点一下 + 粘贴 + 回车」(**壳 op 的字段一格没动**,适配器照现有契约写),
 * 可是**按名字找键的那几下一定找不着**。认法在 `agentJudge.judgeStructure`,这里只把它映射成能力。
 */
import type { StructureMode } from '../../agentJudge.ts'
import { familyAsksInWindow, pickFamilyPackage } from '../../agentSources.ts'
import type { ApprovalPanelRead } from '../../approvalKeys.ts'
import { approvalKeyKind, pickApprovalPanel, resolveApprovalKey } from '../../approvalKeys.ts'
/*
 * `dispatchClient.ts` 里的纯函数原样复用(归类、壳回包成败、读窗找我们那一句、壳原话换人话、永不送的那几家)。
 * **一个字都不往这儿抄** —— 抄一份就是第二处,下次改又漂一次(09-30 根子 5)。
 */
import { CLIENT_DISPATCH_NEVER, classifyFailure, helperOutcome, humanizeFailure, isHelperQuietReason } from '../../dispatchClient.ts'
/** 读整扇窗那条退路要的那三样(豆包办公 `read_reply` 认不出时;判断全在 `agentWindowModel` 一处)。 */
import { windowProgressBusy, inSidebar, parseRead, transcriptRows } from '../../agentWindowModel.ts'
/**
 * **「窗口里读到的那几行 → 一段回答」只有一份**(`dispatchReply.extractReply`):
 * 剥掉我们送进去那一条的回声、读屏播报(`Claude responded:`)、折叠键与界面上的那几个字。
 * 派活盯窗(`dispatchRun`)与捎话巡检(`relayWatch`)用的就是它 —— 这一层照样问它,**不抄第二份**。
 */
import { extractReply } from '../../dispatchReply.ts'
/** 「框里原有的那段字其实是空框的占位符」也只有一份判据(2026-10-13,卡 F)。 */
import { isClientInputPlaceholder } from '../../clientDrafts.ts'
import type { HelperRequest } from '../../helperChannel.ts'
/**
 * ★ **电脑锁着屏那一档**(2026-10-03,卡「锁屏时窗口型的家送不进」):
 * 认壳那句原话、那一句人话,全仓一处在 `../../screenLock.ts`(壳那一侧在
 * `workbench-app/Sources/ScreenLockPolicy.swift`,两边那截字有对照用例)。
 */
import { isScreenLockedReason, screenLockedReadSay, screenLockedSay } from '../../screenLock.ts'
/** 读回话认「我们那一句」用的那截字:与捎话、派活同一份记号函数。 */
import { RELAY_TAG, relayReadMark } from '../../sessionRelay.ts'
import type { FrontHow, WindowWakeDeps } from '../../windowWake.ts'
import { noWindowWhy, withWindowWake } from '../../windowWake.ts'
import type { Adapter, AdapterCapabilities, AdapterReadResult, ApprovalReadResult, Job, JobKind, JobResult } from '../adapter.ts'
import { RetryableError } from '../adapter.ts'
import { windowDeepLink, windowFamilyRow } from './window/families.ts'
import { readablePackagesOf, unreadablePackageHit } from '../../dispatchTargets.ts'

export { WINDOW_FAMILIES, WINDOW_FAMILY_DEFAULT, windowDeepLink, windowFamilyRow } from './window/families.ts'
export type { WindowFamilyRow } from './window/families.ts'

/**
 * **一处超时**(09-30 根子 3 的「4 种超时」就此收口)。每一样都照原来那八处里的值,一个没改:
 * 打字发送 60 秒(壳要开新对话 → 找框 → 写 → 发送 → 核对框空了,机器一忙十几秒是常事),
 * 写面板同;点键 40 秒;侧栏点、按停止 30 秒;读一眼 20 秒。
 */
export const WINDOW_OP_TIMEOUT_MS = {
  send_text: 60_000,
  agent_write_ask: 60_000,
  agent_press: 40_000,
  agent_approval_press: 40_000,
  agent_pick: 30_000,
  agent_stop: 30_000,
  agent_approval: 20_000,
  read_reply: 20_000,
  /** 盯着等回话那一下(与 `relayWatch.pump` / `dispatchRun` 盯窗同一个值)。 */
  read_watch: 15_000,
} as const

/** 开完深链 / 点完侧栏,等那段对话画出来(毫秒)。照窗口那只手原来的缺省。 */
export const WINDOW_SETTLE_MS = 1500

/** 读窗那一下最多看几次、每次隔多久(送完那句话要一拍才画出来;照原来那八处里的值)。 */
export const WINDOW_SEEN_TRIES = 3
export const WINDOW_SEEN_STEP_MS = 700

/**
 * ★ **壳那一送没应声之后,再核一眼窗口才定成败**(2026-10-13,卡 N)。
 *
 * 10-13 17:40:55 派豆包 → 17:42:05 壳那条 `send_text` 整 60 秒没回(`send_text` 的超时),
 * 当场判了 `not_sent`、卡挂 blocked、接力第一步 failed、来电念「没派出去:壳响应超时」——
 * 而豆包窗口里那句「【工作台派活 c43a90】…」**明明送进去了,图也出了**。
 * 病根:贴完字之后壳在核对(读 AX)那一步被正在出图的豆包渲染进程卡住,60 秒没回;
 * 送没送进去这件事**窗口里看得见**,壳回不回话只是我们这一头的事。
 *
 * 所以:等一拍 → 只读地读一眼那扇窗(`seesDelivered`,有它自己的超时)→ 还看不见再等一拍读最后一次。
 * 两拍一共多等约 8 秒 —— 比「当场说一句假话」便宜;真没送进去的那一次照旧 `not_sent`。
 */
export const HELPER_QUIET_RECHECK_WAITS: readonly number[] = [3000, 5000]

/**
 * ★ **送之前那一眼读不出来时,这一单的标记行还算不算「它之前不在那儿」**(2026-10-13,卡 N)。
 *
 * 「送之前没有、送之后出现」是这一档证据的底子(与壳那一侧第三档同一条纪律,见
 * `docs/交接-1013-壳送话核对读太早.md` 第三节)。送之前读得出来、而且没看见(`false`)最硬,一律算。
 *
 * 读不出来(`undefined` —— 豆包那扇窗正忙时就是这样)只有**派活第一回**还算:那一行是这张卡自己的
 * 短 id(`confirmMark`「工作台派活 c43a90」),第一回之前我们从没往那扇窗里送过它,
 * 所以它不可能是上一回留下的。重派(`attempt` 2 起)不算 —— 上一回那一行可能还在;
 * 捎话 / 替她答那一路的记号是她那句话的前 20 字(她自己发过同一句就撞上),也不算。
 */
export function quietProofAllowed(job: Job, seenBefore: boolean | undefined): boolean {
  if (seenBefore !== undefined) return !seenBefore
  return job.kind === 'dispatch' && (job.confirmMark ?? '').trim() !== '' && (job.attempt ?? 1) < 2
}

/**
 * 没核上时那两句人话。**与 `sessionAnswer.ts` 的 `sendUnconfirmedNote` / `sendUnverifiableNote`
 * 逐字相同**,有一条对照测试钉着(`tests/engine-window-notes.test.ts` 读那一份来比)——
 * 第三段把那六只手删掉时那条测试跟着删,这里就是唯一的一份。
 * 不 import 过来是这张卡的纪律:`sessionAnswer.ts` 整个文件第三段要删,新代码不许再长出对它的引用。
 */
export function windowUnconfirmedWhy(agentName: string): string {
  return `按了发送,但没在那条对话里看到这句话 —— 可能发到了别的对话,去${spaced(agentName)}里看一眼`
}

/**
 * 「去 X 里看一眼」那半句里家名两边的空格:**英文名两边空一格**(「去 Claude 里看一眼」),
 * 中文名不空(「去豆包里看一眼」)。一处写 —— 这几句人话都要它。
 */
export function spaced(agentName: string): string {
  const pad = /[A-Za-z0-9]/.test(agentName) ? ' ' : ''
  return `${pad}${agentName}${pad}`
}

export function windowUnverifiableWhy(agentName: string): string {
  return `按了发送,没能核实是不是送到了那条对话 —— 去${spaced(agentName)}里看一眼`
}

/**
 * 微信 / 企微那一句(名单复用 {@link CLIENT_DISPATCH_NEVER})。
 * 往人跟人聊天的窗口里打一行字再按回车,是以她的身份对**真人**说话 —— 跟派活给 Agent 是两件事。
 */
export function neverSendWhy(agentName: string): string {
  return `${agentName}是跟人聊天的,工作台从来不往它窗口里送话 —— 这句话要你自己去说`
}

/** 这一家这会儿一个包都解析不出来时那一句。 */
export function noPackageWhy(agentName: string): string {
  return `这台电脑上还没接上${agentName},这一下没做`
}

/**
 * **壳按了发送、回执没说成**那一句(2026-09-28 Air 维护包:豆包按了发送、回执说没发)。
 *
 * 要紧的是最后半句:**不要重复发送** —— 它多半已经收到了。
 * 从前这一句在 `sessionAnswer.SEND_RECEIPT_UNSURE`,而上一层靠 `why.includes('回执尚未确认')`
 * 把它认回来(审计第二表第 18 条:两处文案还不一样)。现在只有这一句,
 * 而「送到没送到」看的是 `delivered`(`unconfirmed`),不靠认文案。
 */
export const SEND_RECEIPT_UNSURE = '已尝试发送,但回执尚未确认。请查看对话区,不要重复发送;这不代表发送失败'

/** 壳没连上时那一句(八处原来各写一遍,现在一句)。 */
export const HELPER_DOWN_WHY = '工作台 App 没连上(动别家窗口要经过窗口编排壳)'

/** 她要的是「只写进框、不按发送」(A2)那一下的结局那一句:**字进了框,没发出去**。 */
export const TYPED_NOT_SENT = '字写进它的输入框了,没替你按发送(这一下你要的就是不按)—— 去它窗口里按一下'

/** 壳太旧、不会这件本事时那一句(`what` 由调用处填)。 */
export function oldShellWhy(what: string): string {
  return `这台电脑上的工作台 App 还不会${what}(装上新版就能)`
}

/**
 * ★ **电脑锁着屏时这一下为什么不做**(2026-10-03,卡「锁屏时窗口型的家送不进」)。
 *
 * 锁着屏时窗口型那几家**起不出窗**、辅助功能**一扇窗都列不出**(09:04 那一回 Kimi 明明在跑)——
 * 2026-10-03 09:04 真机:7 秒里 `open -b` 五次、一下都没用,最后报「一扇标准窗口都没有」。
 * 所以这一层**一个 op 都不发、一回窗都不开、一个包都不换**(那几下全是白做,还会把她的 App 弹来弹去),
 * 如实回 `not_sent` + 契约那一格 `screenLocked`,由引擎排进等待队列(`engine/lockQueue.ts`)。
 *
 * 跟她说的那句话的**最终版由引擎出**(只有引擎知道排上队没有、这台还有哪几家不靠窗口),
 * 见 `screenLock.screenLockedSay` —— 这里这一句是「没人改写」时的那一份(直接用适配器的脚本 / 用例)。
 */
function screenLockedWhy(agentName: string): string {
  return screenLockedSay({ agentName, queued: false })
}

/** 读不回它的回话时那一句(**不许把「读不到」说成「它还没回」**)。 */
export const READ_FAILED_WHY = '这会儿读不到它的窗口 —— 下一拍再读一次'
/** 它还在写(窗口里停止键还在)时那一句:**还没回,不是读不到**。 */
export const READ_BUSY_WHY = '它还在写'

/**
 * **自绘界面上按名字找键的那几下**(点选项 / 写面板 / 按停止)那一句。
 *
 * 为什么不试一下再说:那几下全靠「辅助功能树里有一行叫这个名字」才点得着,而自绘界面把控件
 * 画成了没名字的 `AXUnknown` —— 试一次只是白在她的窗口上遍历一遍树,还会让界面摆出一颗
 * 点下去说「到电脑上点」的键(D13 那个「点了没反应」)。所以 `capabilities()` 说不行,这里就不试。
 * **送话照样送得进去**(壳内部那条粘贴的退路)。
 */
export function selfDrawnWhy(agentName: string, what: string): string {
  return `${agentName}那扇窗是它自己画的,${what}在辅助功能树里认不出来 —— 这一下得你在电脑上自己来(送话照样送得进去)`
}

/** 适配器要的那份壳(与 `helperChannel` 同形;`supports` 缺席 = 按「不会」算,老壳一字不变)。 */
export interface WindowAdapterHelper {
  connected: () => boolean
  request: (req: HelperRequest, timeoutMs?: number) => Promise<Record<string, unknown>>
  /** 这份壳会不会某件本事(hello 里的 `caps`)。缺席 = 不会。 */
  supports?: (cap: string) => boolean
}

/** 这台电脑上这一家的一个包。 */
export interface WindowPackage {
  bundle_id: string
  /** 这个包自己的显示名(回话里要说清动的是哪一个)。缺席 = 退回家名。 */
  name?: string
  running?: boolean
}

export interface WindowAdapterDeps {
  helper: WindowAdapterHelper
  /**
   * 登记表里这一家的那个包。运行时发现的那几家(Grok Bot / Antigravity)家名就是包标识 ——
   * 家族目录里查不到它们,这一格就是唯一的出处。
   */
  bundleOf?: (family: string) => string | undefined
  /**
   * 这台电脑上这一家**装着**哪几个包、哪个**开着**(家族目录挑包的输入)。
   * 缺席 = 不知道(老宿主 / 用例)→ 家族目录的主包,而且**一个包都不换**;
   * 给了空数组 = 探过、一个都没装 → 如实说没接上。
   */
  installed?: (family: string) => readonly WindowPackage[] | undefined
  /**
   * 深链要的「桌面 App 里的编号」(Claude 的 `local_…`)。缺席 / 读不到 → 这一次没有深链,
   * 退回侧栏点一下 —— **不编一条链**。
   */
  hostIdOf?: (family: string, sessionId: string) => string | undefined
  /** 这一家叫什么(人话里用)。缺席 = 家名。 */
  nameOf?: (family: string) => string
  /**
   * 这一家那扇窗**写得进去到什么程度**:登记表里存着的那一份结构结论
   * (`AgentJudgedAppView.structure.mode`,判在 `agentJudge.judgeStructure`)。
   * 缺席 / `'full'` = 老样子;`'paste_only'` = 自绘界面(见文件头那段 import 的注释)。
   * **一个 App 的名字都不写在这里** —— 哪一家是自绘界面是现查出来的。
   */
  structureMode?: (family: string) => StructureMode | undefined
  /**
   * ★ **认出是 AI 应用、可那扇窗读不到**的那几家(登记表的 `unreadable` 那一截;2026-10-01)。
   *
   * 2026-10-02 收成一份(审计第二表第 7 条):从前只有**派活**那两处查它
   * (`dispatchClient.sendOnce` / `dispatchRun`),答 / 捎话不查 —— 于是同一家 Kimi,
   * 派活当场说「读不到它的窗口,派不了」,而替她答照样叫台前、照样打字、白等一圈。
   * 现在这一格在窗口这一条通道上:读不到的那几家 `capabilities()` 一律 `send:false`,
   * {@link Adapter.unavailable} 说那一句人话 —— 三个入口于是同一句。
   * 缺席 = 不知道(老宿主 / 用例)→ 一字不变。
   */
  unreadable?: () => readonly { id: string, name: string, bundle_id: string }[]
  /**
   * 体检表上**这一家**那几格(`agentCaps.cellsOf`)。{@link Adapter.capabilities} **现查**用它:
   * `chat` 格 = 送得进话、`collect` 格 = 收得回结果。查不到这一家 / 没接(老宿主)→
   * 不拿它否掉壳此刻的事实。
   *
   * ★ **只许问「这一家」,不许问「有哪几家」**(2026-10-03,卡「0.4.87 启动崩溃」;
   * 交接 `docs/交接-1003-0.4.87启动崩溃.md`)。这一格从前是 `caps: () => agentCapsView`(**整张表**),
   * 而整张表的第一件事是算「体检哪几家」—— 那一步会回头问引擎登记处的候选名单
   * (`registry.targetsNow()`),于是:
   *
   * ```
   * targetsNow() → probe() → capabilities() → 整张体检表 → 体检哪几家 → targetsNow()
   * ```
   *
   * 这一格里**一个 `await` 都没有**,所以那是一圈**同步**递归:0.4.87 在维护者那台上
   * 一路爆栈(`RangeError: Maximum call stack size exceeded`),8791 永不响应、launchd 每 5 分钟重启一次。
   * 换成「只问这一家」之后这条边就不存在了 —— **能力现查不许回头问候选名单**。
   */
  capCells?: (family: string) => Readonly<Partial<Record<CapCell, CapCellView>>> | undefined
  /**
   * ★ **这一刻电脑锁着屏没有**(2026-10-03,卡「锁屏时窗口型的家送不进」)。
   *
   * 出处是壳(`ScreenLockPolicy.isLocked` 读 `CGSessionCopyCurrentDictionary()`),
   * 由 `screenLockWatch.ts` 那一拍问来、缓存着 —— 这一层只读这一个事实。
   *
   * **`undefined` = 不知道**(老壳不报那一格 / 还没问到)→ **照旧送**,行为与 2026-10-03 之前一字不差。
   * 为真时这一层**一个 op 都不发**:锁着屏时窗口型那几家起不出窗,送、点、开窗、换包全是白做。
   */
  screenLocked?: () => boolean | undefined
  /** 开一个深链(`open <url>`,不经 shell)。缺席 = 不开深链。 */
  openUrl?: (url: string) => Promise<{ ok: boolean }>
  /** 把那一家的窗**真正开出来**(`open -b <包标识>`)。缺席 = 没有一样能开窗的本事 → 不重开。 */
  openApp?: (bundleId: string) => Promise<{ ok: boolean }>
  /** 把那一家叫到台前(窗位叠里有它就 `dock.switchTo`)。**叫不到不算失败**。 */
  bringToFront?: (bundleId: string) => Promise<{ ok: boolean }>
  /**
   * **没跑就先拉起来**(`open -b <包标识>` + 等它真跑起来;注入的是 `activation.ensureRunningWith` 那一套)。
   *
   * 2026-10-02 从 `dispatchClient.sendOnce` 搬进这一层:冷启动一个 App 可能要好几秒,
   * 而「没窗口就开窗」那一圈每回只等 1.2 秒 × 3 —— 靠那一圈等冷启动会在真机上翻车。
   * 两件事互补:这一下管「它压根没跑」,那一圈管「跑着、可一扇窗都没露出来」。
   * 缺席 = 不拉(行为与 2026-10-02 之前的答 / 捎话一字不差:直接送,壳说没窗口再走那一圈)。
   */
  ensureRunning?: (family: string, bundleId: string) => Promise<{ ok: boolean, reason?: string }>
  /** 开完深链 / 点完侧栏等多久,缺省 {@link WINDOW_SETTLE_MS}。 */
  settleMs?: number
  /** 撞上没窗口之后每回开完等多久,缺省 `windowWake.NO_WINDOW_WAKE_WAIT_MS`。 */
  wakeWaitMs?: number
  sleep?: (ms: number) => Promise<void>
  /**
   * ★ **动作闸**(卡 AG / AG2)。**判断一个字都不在这里**:适配器只问一句 `allow()`。
   *
   * ★ 2026-10-02(卡「引擎接线与删复制品」):这一层**只剩两样**要问 ——
   * - `window_wake`(把她的窗弹到眼前):只存在于这一层,引擎看不见它,不接在这儿就没人数得了那几回;
   * - `approval_read` / `approval`(看 / 按那个权限弹框):`JobKind` 只有一个 `press`,
   *   「这一下是普通选项还是权限弹框」只有这一层分得出来(`windowPressRoute`)。
   *
   * **送话 / 点选项 / 写面板 / 按停止那四样不在这儿过闸了** —— 引擎在 `run` 的入口已经过了一次
   * (`engine.jobGateActionOf`)。两处都问就是**同一个动作数两回**:第二回必然撞上「离上一回太密」
   * (`GATE_LIMITS.answer_send` 的间隔是 1 秒),于是每一次替她答都会被自己拦下。
   * 设计第三节原话:**闸只接在引擎一处**。
   */
  gate?: ActionGate
  /**
   * **框里她没发出去的那段字存哪**(2026-09-27,卡 DB;`clientDrafts.saveClientDraft`)。
   *
   * 2026-10-02 收成一份(审计第二表第 4 条):从前派活与答 / 捎话各存一份、行为还不一样。
   * 接上了这一格,壳那条 `send_text` 才带 `save_draft`(「先存下来再送、送完原样放回」);
   * 缺席 = 不给壳发这一格,壳照旧「框里有草稿就不送」+ 一句人话 —— **存不下来的不许盖掉**。
   */
  saveDraft?: (input: { family: string, text: string, at: string }) => Promise<{ ok: boolean, path?: string, reason?: string }>
  /** 那一段草稿的人话(`clientDrafts.draftSavedNote`)。缺席 = 不说(但也不落盘)。 */
  draftNote?: (input: { who: string, saved: { ok: boolean, path?: string, reason?: string }, returned: boolean, reason?: string }) => string
  /**
   * 闸上「这件事」的键。**定法在引擎一处**(`jobKey.ts`:有事项用事项 id,没有就用会话键)——
   * 适配器不自己拼。缺省 = `job.itemId`;回 `undefined` = 这一下不过闸(老行为一字不变)。
   */
  gateJobOf?: (job: Job) => string | undefined
  now?: () => Date
}

/** 这一次要动的那个包(挑包的结论)。 */
interface PickedPackage {
  bundleId: string
  name: string
  /** 她点名的那一个(点名了就**不许**换)。 */
  said: boolean
  /** 这一家这台电脑上还装着、这件事还没试过的下一个包(没有就没有)。 */
  next?: { bundleId: string, name: string }
}

/** 这件事在这一家上已经试过哪几个包(换包只换没试过的;**这是适配器唯一的记性**)。 */
interface TriedNote {
  tried: Set<string>
  names: string[]
  at: number
}

/** 记性留多久 / 最多几件(一件事送完就没用了,不留着长)。 */
const TRIED_TTL_MS = 10 * 60 * 1000
const TRIED_MAX = 100

/*
 * ★ **「这一种动作在闸上叫什么」那张表不在这一层了**(2026-10-02,卡「引擎接线与删复制品」)。
 *
 * 它搬去了 `engine/engine.ts` 的 `JOB_GATE_ACTION` + `jobGateActionOf`(那里还分得出
 * 「第一次派 / 重派」两档,靠契约的 `Job.attempt`)。这一层只剩两样闸:
 * `window_wake`(只存在于这一层)与 `approval_read` / `approval`(只有这一层分得出
 * 「普通选项还是权限弹框」)。两处都数同一个动作的话,第二处必然撞上「离上一回太密」。
 */

/**
 * ★ **这一下按的是权限弹窗上那颗键,还是它明写的一个选项**(一处判)。
 *
 * 为什么要判:权限弹窗上的键**必须经 `approvalKeys` 把关** —— 「本次会话都允许 / 始终允许」那一类
 * 是替她改了这条会话往后的权限,决策记录里没拍板,一颗都不许按。而它明写的选项(「要 A 还是 B」)
 * 走 `agent_press` 就对了。
 *
 * 三条都成立才走批准那条路:① 带了认那个弹窗用的原话(`marks`);② 这份壳会 `agent_approval`;
 * ③ 要按的那颗键**认得出是批准 / 放宽 / 拒绝**(`approvalKeyKind`)。差一条就是普通选项。
 */
export function windowPressRoute(input: { label: string, marks: readonly string[], canApprove: boolean }): 'approval' | 'option' {
  return input.marks.length > 0 && input.canApprove && approvalKeyKind(input.label) !== undefined ? 'approval' : 'option'
}

/**
 * 「这一下没做成,原因是这句人话」—— 收成一个内部错,`run` 一处翻成 `JobResult`。
 *
 * `via` 说实话:**一个 op 都没发出去**的那几种(壳没连上、认不出这一家、永不送的那几家、
 * 壳太旧、自绘界面上找不着键、闸拦下)回 `'none'`(契约:一条通道都没用上);
 * 真跟壳说过话才回 `'window'`。
 */
class NotSent extends Error {
  readonly unsupported: boolean
  readonly via: JobResult['via']
  /**
   * ★ **这一下没做是因为电脑锁着屏**(2026-10-03):`run` 把它翻成契约上那一格 `screenLocked`,
   * 引擎据此排队、换那句人话。**不是「不支持」**(解锁了就做得到),所以与 `unsupported` 分成两格 ——
   * 合成一格会让引擎去换另一条通道,而另一条通道一样撞上锁屏。
   */
  readonly screenLocked: boolean
  constructor(message: string, unsupported = false, via: JobResult['via'] = 'window', screenLocked = false) {
    super(message)
    this.unsupported = unsupported
    this.via = via
    this.screenLocked = screenLocked
  }
}

/** 这一刻锁着屏没有(`undefined` = 不知道 → 按没锁算,一字不变)。 */
function lockedNow(deps: WindowAdapterDeps): boolean {
  try { return deps.screenLocked?.() === true }
  catch { return false }
}

/** 壳回来的那几块(`agent_approval` 只读那一下),形状不对的那几块丢掉。 */
function approvalPanelsOf(raw: unknown): ApprovalPanelRead[] {
  if (!Array.isArray(raw)) return []
  const out: ApprovalPanelRead[] = []
  for (const one of raw) {
    if (typeof one !== 'object' || one === null) continue
    const rect = (one as { rect?: unknown }).rect as Record<string, unknown> | undefined
    const keys = (one as { keys?: unknown }).keys
    if (rect === undefined || typeof rect !== 'object' || !Array.isArray(keys)) continue
    const [x, y, w, h] = [rect.x, rect.y, rect.w, rect.h]
    if (![x, y, w, h].every(n => typeof n === 'number' && Number.isFinite(n))) continue
    out.push({ rect: { x: x as number, y: y as number, w: w as number, h: h as number }, keys: keys.filter((k): k is string => typeof k === 'string') })
  }
  return out
}

/**
 * 壳读回来的那几块里**有没有一块像权限弹窗**(既有「批准 / 放宽」、又有「拒绝」)。
 *
 * 为什么要这一句:`pickApprovalPanel` 回「不行」有两种意思,而它们的下一步**正好相反** ——
 * ① 一块都不像权限弹窗(壳圈到的是它明写的选项框)→ 该按 `agent_press` 走普通选项;
 * ② 像,但那一块上能批的只有「本次会话都允许」这种放宽的键 → **一颗都不许按**,
 *    退回 `agent_press` 就等于绕过 `approvalKeys` 那道门,替她把这条会话往后的权限放宽了。
 *
 * 判据用的是同一个原子 `approvalKeyKind`(`pickApprovalPanel` 里那个「够格」没有导出)。
 * 两边哪天漂了,`tests/engine-window-press.test.ts` 里「放宽的那一颗不许退回普通选项」那条会红。
 */
function looksLikeApproval(panels: readonly ApprovalPanelRead[]): boolean {
  return panels.some((one) => {
    const kinds = new Set(one.keys.map(approvalKeyKind))
    return (kinds.has('once') || kinds.has('broad')) && kinds.has('deny')
  })
}

/**
 * ★ **「往它那个提问面板里写字」此刻只对认准了的那一家开着**(2026-09-28 卡 AT / AT2 真机定;2026-10-12 起按家族认)。
 *
 * 豆包那个面板是认准了的(2026-09-28 Air 维护包真机:写进去、面板收了、正文里有她那句),豆包一家几个包都算
 * (`agentSources` 里那一家的 `askPanel`,不在这里写包名);别家关着 —— 0.4.60 真机上 Codex 那个提问框其实已经收了,
 * 那句话落进了**底部主输入框**(没发出去),回包却报 `confirmed:true`「已替你答了」。查清之前这一路一律不走。
 *
 * {@link WRITE_ASK_ANY} 打开 = 对每一家都开(查清之后改这一个值,不改判断)。
 */
export const WRITE_ASK_ANY = false

export function writeAskAllowed(bundleId: string | undefined): boolean {
  return WRITE_ASK_ANY || familyAsksInWindow(bundleId)
}

/**
 * **按一截字在那家对话区里找我们那一句**(读回话 / 核「真发出去了」共用这一份;2026-09-28 Air 维护包回源码)。
 *
 * ★ 2026-10-02 从 `dispatchClient.ts` 搬到这儿:那个文件瘦成纯判断 + 类型,而这一下**真去碰壳**,
 * 它的主人就是窗口这一条通道(送话前后比、`read` 那一拍、派活盯窗、捎话巡检用的都是这一份)。
 *
 * 先走壳的 `read_reply`。豆包那一家(几个包都是)常常认不出(右侧摘要区、侧栏混在一起),
 * 于是**只对它**再读一次整扇窗(`agent_read`):只要主对话区那几行(不在侧栏、不在输入框右边那一栏、在输入框上面),
 * 按纵坐标排好,找最后一处带着这截字的,回它和它后面那几行。截字不到 4 个字不认(认不准)。
 */
export async function readRelayEvidence(
  helper: { request: (req: HelperRequest, timeoutMs?: number) => Promise<Record<string, unknown>> },
  bundleId: string,
  marker: string,
  timeoutMs = 6000,
): Promise<{ ok: true, result: Record<string, unknown> } | { ok: false, error?: string }> {
  try {
    const outcome = helperOutcome(await helper.request({ op: 'read_reply', bundle_id: bundleId, index: 0, marker }, timeoutMs))
    if (outcome.ok && outcome.result.found === true) return outcome
    if (!familyAsksInWindow(bundleId)) return outcome
  }
  catch (error) {
    if (!familyAsksInWindow(bundleId)) return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
  try {
    const read = parseRead(await helper.request({ op: 'agent_read', bundle_id: bundleId }, timeoutMs))
    const input = read.input
    if (!read.running || read.window === undefined || input === undefined || read.ax_err !== undefined || [...marker].length < 4) return { ok: false }
    // 主对话区那几行的筛法在 `agentWindowModel.transcriptRows` 一处(卡 C 提出去的,判据一字未改)。
    const transcript = transcriptRows(read)
    let index = -1
    for (let i = transcript.length - 1; i >= 0; i -= 1) {
      if ((transcript[i] as string).includes(marker)) { index = i; break }
    }
    const busy = read.stop.some(row => !inSidebar(row, read.sidebar)) || windowProgressBusy({ bundleId, read, nowMs: Date.now() }).busy
    return { ok: true, result: { found: index >= 0, busy, texts: index < 0 ? [] : transcript.slice(index) } }
  }
  catch { return { ok: false } }
}

/** 抛出来的那句原话(不是 Error 的也说得出)。 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 壳回包里那一句原话(`note`),没有就 undefined。 */
function noteOf(result: Record<string, unknown>): string | undefined {
  return typeof result.note === 'string' && result.note.trim() !== '' ? result.note : undefined
}

/**
 * ★ **窗口型那几家的那一个适配器**(豆包办公 / 豆包 / Kimi / Manus / Muse / Antigravity / Grok Bot,
 * 以及下一家运行时接上的),也给 Codex / Claude 做**协议不支持那几下**(点键 / 写面板 / 批准)的第二条路。
 *
 * 一个实例管一家(契约里 `family` 是只读的一格)。
 */
export function createWindowAdapter(family: string, deps: WindowAdapterDeps): Adapter {
  const sleep = deps.sleep ?? (ms => new Promise<void>(resolve => { setTimeout(resolve, ms).unref?.() }))
  const now = deps.now ?? (() => new Date())
  const name = (): string => deps.nameOf?.(family) ?? family
  const can = (cap: string): boolean => deps.helper.supports?.(cap) ?? false
  const settleMs = deps.settleMs ?? WINDOW_SETTLE_MS
  const gateKeyOf = deps.gateJobOf ?? ((job: Job) => job.itemId)
  /** 这扇窗是自绘的吗(现查;老宿主 / 没判过 → 按老样子算)。 */
  const pasteOnly = (): boolean => deps.structureMode?.(family) === 'paste_only'

  /**
   * ★ **这一家「认出来了、可那扇窗读不到」吗**(审计第二表第 7 条收成的那一处)。
   *
   * 判据与派活、与电话里「能派谁」**同一个函数**(`dispatchTargets.unreadableBlockOf`:
   * 按家名对、按包标识对、同一家还有一条读得到的路就不拦),那一句人话也同一处
   * (`protocol.dispatchUnreadableSay`)。读不出登记表(缺席)= 不知道 → 不拦,一字不变。
   */
  function unreadableWhy(said?: string): string | undefined {
    // 按具体包判,判据在家族目录那条接缝上(`dispatchTargets.unreadablePackageHit`),这里只读。
    const hit = unreadablePackageHit({
      family,
      unreadable: deps.unreadable?.(),
      installed: deps.installed?.(family),
      said,
      resolved: () => resolvePackage({})?.bundleId,
    })
    return hit === undefined ? undefined : dispatchUnreadableSay({ name: hit.name, others: [] })
  }

  /** 「没窗口就把窗开出来再来一遍」那一圈要的那几样(全仓一份,在 `windowWake.ts`)。 */
  const wakeDeps: WindowWakeDeps = {
    ...(deps.openUrl === undefined ? {} : { openUrl: deps.openUrl }),
    ...(deps.openApp === undefined ? {} : { openApp: deps.openApp }),
    ...(deps.bringToFront === undefined ? {} : { bringToFront: deps.bringToFront }),
    ...(deps.wakeWaitMs === undefined ? {} : { wakeWaitMs: deps.wakeWaitMs }),
    sleep,
    ...(deps.gate === undefined ? {} : { gate: deps.gate }),
  }
  /** 一样能开窗的本事都没有 → 那一圈一回都不重开(行为与老宿主一字不差)。 */
  const canWake = deps.openApp !== undefined || deps.openUrl !== undefined

  const tried = new Map<string, TriedNote>()
  function triedOf(jobId: string): TriedNote {
    const nowMs = now().getTime()
    for (const [key, one] of tried) if (nowMs - one.at > TRIED_TTL_MS) tried.delete(key)
    while (tried.size > TRIED_MAX) {
      const oldest = [...tried.entries()].sort((a, b) => a[1].at - b[1].at)[0]
      if (oldest === undefined) break
      tried.delete(oldest[0])
    }
    const had = tried.get(jobId)
    if (had !== undefined) { had.at = nowMs; return had }
    const fresh: TriedNote = { tried: new Set(), names: [], at: nowMs }
    tried.set(jobId, fresh)
    return fresh
  }

  /**
   * ★ **这一次动哪一个包**(一家多包时)。顺序:**她点名的 → 家族目录按装机 / 开着挑 → 登记表那个**。
   * 她点名了(`job.package`)就一个字不换:换了等于违背她的话。
   *
   * `note` 带进来 = 这件事已经试过哪几个(换包那一回用);不带 = 只问「这一家此刻是哪一个包」
   * ({@link Adapter.capabilities} 走这一路,不碰那本记性)。
   */
  function resolvePackage(input: { package?: string | undefined, note?: TriedNote }): PickedPackage | undefined {
    const everyInstalled = deps.installed?.(family)
    // 装着读得到的包就只在它们里面挑(读不到的那个开着也不挑它);一个都读不到 = 老样子,由 unreadableWhy 当场拦。
    const readable = readablePackagesOf(everyInstalled, deps.unreadable?.())
    const installed = readable.length > 0 && everyInstalled !== undefined && readable.length < everyInstalled.length ? readable : everyInstalled
    const all = (installed ?? []).filter(one => one.bundle_id.trim() !== '')
    const nameOfBundle = (bundleId: string): string => all.find(one => one.bundle_id === bundleId)?.name ?? name()
    if (input.package !== undefined && input.package.trim() !== '') {
      return { bundleId: input.package, name: nameOfBundle(input.package), said: true }
    }
    /*
     * 家族目录一处(`pickFamilyPackage`:只装一个 → 那一个;两个都装 → 开着的那一个;都开 / 都没开 → 主包)。
     * 表外的一家(运行时发现的)目录里查不到 → 退回登记表给的那个包。
     */
    const picked = pickFamilyPackage({ family, ...(installed === undefined ? {} : { installed }) })
    /*
     * ★ **运行时发现的那几家:家名**就是**包标识**(`agentSources.entryIdForBundle` 那条规矩)。
     * Grok Bot `com.anysphere.sand`、Antigravity `com.google.antigravity`、可灵 `com.electron.klingai`
     * 从来没进过家族目录,所以上面那几步一个都答不出 —— 退到家名本身,不用再查一张表。
     * (与 `registry.packageFor` 那一处同一条规矩。)
     */
    const byName = family.includes('.') ? family : undefined
    const first = picked?.bundle_id ?? deps.bundleOf?.(family) ?? (all.length === 1 ? all[0]?.bundle_id : undefined) ?? byName
    if (first === undefined) return undefined
    const note = input.note
    if (note === undefined) return { bundleId: first, name: nameOfBundle(first), said: false }
    /*
     * 还没试过的里面挑一个:**在跑的排前面**(没在跑的那个多半也没窗口,但装着就试一下)。
     * `next` 只回答「还有没有下一个」—— 用不用它由引擎那一回决定(见 {@link swapError})。
     */
    const order = [first, ...[...all]
      .sort((a, b) => Number(b.running === true) - Number(a.running === true))
      .map(one => one.bundle_id)]
      .filter((one, index, allOne) => allOne.indexOf(one) === index)
    const bundleId = order.find(one => !note.tried.has(one)) ?? first
    const next = order.find(one => one !== bundleId && !note.tried.has(one))
    return {
      bundleId,
      name: nameOfBundle(bundleId),
      said: false,
      ...(next === undefined ? {} : { next: { bundleId: next, name: nameOfBundle(next) } }),
    }
  }

  /**
   * 这一下过闸(闸缺席 / 没键 = 不过闸,老行为一字不变)。
   * `via` = 拦下的这一刻**已经动过她的窗口没有**(批准那条路的第二道闸在读完之后)。
   */
  function pass(job: Job, bundleId: string, action: GateAction, via: JobResult['via'] = 'none'): void {
    const key = gateKeyOf(job)
    if (deps.gate === undefined || key === undefined) return
    const verdict = deps.gate.allow({ job: key, family, action, bundle_id: bundleId })
    if (!verdict.ok) throw new NotSent(verdict.say, false, via)
  }

  /** 开窗那一圈要的那两格(带上了闸才数得了;缺一样就是老行为)。 */
  function wakeAct(job: Job): { job?: string, family?: string } {
    const key = gateKeyOf(job)
    return key === undefined ? {} : { job: key, family }
  }

  /** 这一下的深链(没有 / 这会儿开不了 = undefined)。 */
  function deepLinkOf(job: Job): string | undefined {
    if (job.target.kind !== 'session') return undefined
    const sessionId = job.target.sessionId
    const hostId = deps.hostIdOf?.(family, sessionId)
    return windowDeepLink(family, { sessionId, ...(hostId === undefined ? {} : { hostId }) })
  }

  /** 窗口里认得出那段对话没有(`read_reply` 只读找记号)。读不出来一律按「认不出」算。 */
  async function sees(bundleId: string, mark: string): Promise<boolean> {
    if (mark === '') return false
    try {
      const read = helperOutcome(await deps.helper.request(
        { op: 'read_reply', bundle_id: bundleId, index: 0, marker: mark },
        WINDOW_OP_TIMEOUT_MS.read_reply,
      ))
      return read.ok && read.result.found === true && read.result.busy !== true
    }
    catch { return false }
  }

  /** 她那句话这会儿在它对话区里有没有(读不了 = `undefined`,**不当成没有**)。 */
  async function seesDelivered(bundleId: string, mark: string): Promise<boolean | undefined> {
    // 旧壳不会读回话 → 这一道缺席(`undefined` = 读不了,**不当成没看见**),也不白发一个它不认的 op。
    if (!can('read_reply')) return undefined
    if ([...mark].length < 4) return undefined
    try {
      const got = await readRelayEvidence(deps.helper, bundleId, mark)
      return got.ok ? got.result.found === true : undefined
    }
    catch { return undefined }
  }

  /**
   * ★ **开到那一段**(这一段只有一份,家与家的差别只在「有哪样用哪样」)。
   *
   * 深链(有的话,能开到某一段对话)→ 侧栏点一下(`agent_pick`,壳会、而且记号还没认出来时)
   * → 叫到台前(兜底,**叫不到不算失败**:壳那条 `send_text` 自己会激活窗口)。
   * 回这一次用的是哪一样、记号认出来没有(卡 AW 的第一档旁证)。
   *
   * `pick` 用的是 `marks[0]`:**约定 `marks[0]` 是这条对话在侧栏里的名字 / 认它用的头一截原话**,
   * 其余几截只用来认。这一条约定由引擎那一处填(契约 `marks` 那一格的注释是「认那一段对话用的几截原话」)。
   */
  async function openTo(req: { bundleId: string, deepLink?: string, mark: string }): Promise<{ how: FrontHow, matched: boolean }> {
    let how: FrontHow = 'none'
    const fronted = await deps.bringToFront?.(req.bundleId).catch(() => ({ ok: false }))
    if (fronted?.ok === true) how = 'app'
    if (req.deepLink !== undefined && deps.openUrl !== undefined) {
      const opened = await deps.openUrl(req.deepLink).catch(() => ({ ok: false }))
      if (opened.ok) { how = 'link'; await sleep(settleMs) }
    }
    let matched = await sees(req.bundleId, req.mark)
    /*
     * **深链没把那一段开到前面 → 在侧栏里点它一下**(窗口型那几家唯一的切法)。
     * 点完**重新认一次**;还认不出也照发 —— 认不出只是少一条旁证,不是不许送(卡 AW)。
     */
    if (!matched && req.mark !== '' && can('agent_pick')) {
      let picked = false
      try {
        const got = helperOutcome(await deps.helper.request(
          { op: 'agent_pick', bundle_id: req.bundleId, title: req.mark },
          WINDOW_OP_TIMEOUT_MS.agent_pick,
        ))
        picked = got.ok && got.result.found === true && got.result.pressed === true
      }
      catch { picked = false }
      if (picked) {
        how = 'pick'
        await sleep(settleMs)
        matched = await sees(req.bundleId, req.mark)
      }
    }
    return { how, matched }
  }

  /**
   * ★ **送不进去 → 换同一家另一个装着的包,还是如实说**(2026-10-01 Air 诊断包 095718)。
   *
   * 现场:Air 上豆包办公在跑、一扇窗都没有,她开着的是 App Store 版豆包;按表的顺序挑中了没窗口的那个,
   * 派活就没出去。
   *
   * **换哪一个包**的决定放在适配器:只有它查得到家族目录、查得到这台电脑上装着哪几个、
   * 这件事已经试过哪几个 —— 引擎不认识「包」这件事。
   * **要不要再来一回**是引擎的事(契约:重试与次数上限在引擎一处)。所以这里只回一个
   * `RetryableError` 让调用处抛出去,**不自己 for 循环换包** —— 自己循环就是第二处重试,又回到打补丁。
   *
   * 三道门,差一道就不换:
   * ① 只有「一扇标准窗口都没有」才换(别的失败是那扇窗上的事实,换一个只会把话送到她没想到的地方);
   * ② 她**点名**了用哪个包就不换(换了等于违背她的话);
   * ③ 这一家还有一个装着、这件事还没试过的包。
   */
  function swapError(job: Job, picked: PickedPackage, why: string, raw: string): Error {
    /*
     * ★ **锁着屏:一回窗都不开、一个包都不换**(2026-10-03)。壳在锁屏时把「一扇标准窗口都没有」
     * 换成了那句人话(`ScreenLockPolicy.decorate`),所以 `classifyFailure` 已经归不出 `no_window`、
     * `withWindowWake` 那一圈也不会再开窗 —— 这一道是**第二重**:万一壳是老版(文案没换),
     * 或者是「锁屏那一刻正好撞上」,这里按壳的原话再认一次,照样不换包、不重试。
     */
    if (isScreenLockedReason(raw) || isScreenLockedReason(why) || lockedNow(deps)) {
      return new NotSent(screenLockedWhy(name()), false, 'window', true)
    }
    const note = triedOf(job.id)
    note.tried.add(picked.bundleId)
    if (!note.names.includes(picked.name)) note.names.push(picked.name)
    const next = picked.next
    /*
     * 归类**按壳那句原话**算(`raw`)—— 「又开了几回」是我们接在后面的话,人话替换(`humanizeFailure`)
     * 也可能把判据那几个字换掉:拿加工过的 `why` 去归类迟早归错(同 `dispatchClient.sendOnce` 那一处口径)。
     */
    if (classifyFailure(raw) === 'no_window' && !picked.said && next !== undefined) {
      return new RetryableError(`「${note.names.join('」「')}」那边没有窗口:${why};这台电脑上还装着「${next.name}」,换那一个再送一回`)
    }
    return new NotSent(note.names.length > 1
      ? `你这台电脑上装着的 ${note.names.length} 个都试了(「${note.names.join('」「')}」),都没送进去:${why}`
      : why)
  }

  /** 每一下之前那几道一样的门:壳连没连上、这一家认不认得出、是不是永不送的那几家。 */
  function packageFor(job: Job): PickedPackage {
    if (!deps.helper.connected()) throw new NotSent(HELPER_DOWN_WHY, false, 'none')
    /*
     * ★ **锁着屏:一个 op 都不发**(2026-10-03,卡「锁屏时窗口型的家送不进」)。
     * 这一道在最前面:锁着屏时窗口型那几家起不出窗,叫台前 / 深链 / 打字 / 点键一下都做不到,
     * 发出去只是让壳白跑一趟,`ensureRunning` 还会 `open -b` 把她的 App 弹来弹去
     * (09:04 真机 7 秒五次就是这么来的)。`via:'none'` = 一条通道都没用上(契约那一格)。
     */
    if (lockedNow(deps)) throw new NotSent(screenLockedWhy(name()), false, 'none', true)
    const picked = resolvePackage({ package: job.package, note: triedOf(job.id) })
    if (picked === undefined) throw new NotSent(noPackageWhy(name()), false, 'none')
    if (CLIENT_DISPATCH_NEVER.includes(picked.bundleId)) throw new NotSent(neverSendWhy(name()), true, 'none')
    // 点名要的那个包读不到:照实拦,不偷换成同家另一个包(她点的就是那一个)。
    const unreadable = picked.said ? unreadableWhy(picked.bundleId) : undefined
    if (unreadable !== undefined) throw new NotSent(unreadable, true, 'none')
    return picked
  }

  /** 送到哪一段(回包上那一格:会话 id 原样带回;新开一条的那一下由引擎认)。 */
  function sessionOf(job: Job): { sessionId?: string } {
    return job.target.kind === 'session' ? { sessionId: job.target.sessionId } : {}
  }

  /**
   * 核上了 / 没核上,两种结局同一套字段(证据这一层只有 `window` 与 `none` 两种)。
   * `bundle_id` 带的是**真动到的那个包**(契约 2026-10-02 加的那一格:回电巡检按它读窗,
   * 两个豆包时按家名会查到另一扇)。
   */
  function verdict(job: Job, picked: PickedPackage, ok: boolean, why: string): JobResult {
    return ok
      ? { delivered: 'confirmed', evidence: 'window', via: 'window', bundle_id: picked.bundleId, ...sessionOf(job) }
      : { delivered: 'unconfirmed', evidence: 'none', via: 'window', bundle_id: picked.bundleId, ...sessionOf(job), why }
  }

  // ───────────────────── 答 / 捎话 / 派活:同一条路 ─────────────────────

  /**
   * ★ **开到那一段 → 贴进她的原话 → 发送 → 按证据核**(替她答 / 捎话 / 派活**只有这一份**)。
   *
   * 维护者 10-01 17:0x:「这个能力不应该是通用的吗,你现在跟我说是 Claude 单独做,下次跟我说 manus 单独做,
   * 你在搞笑吧」。所以**所有家一个样**,三种 `kind` 之间只差两处:派活要先开一条新对话、闸上叫什么名字。
   *
   * 证据按卡 AW 的三档:① `matched`(送之前那段对话确实认在前台了,旁证)② 读窗前后比(送前没这句、
   * 送完有了)③ 记录文件。**第三档不在这一层** —— 窗口型那几家压根没有记录文件;Codex / Claude 的
   * 记录文件由引擎与那两个协议适配器管。所以这里只报 `window` 或 `none`。
   */
  async function send(job: Job): Promise<JobResult> {
    const picked = packageFor(job)
    if (job.text.trim() === '') throw new NotSent('要送的话是空的,没送', false, 'none')
    // 过闸在引擎一处(见 {@link WindowAdapterDeps.gate});这一层只管开窗那几回。
    /*
     * **派活(新开一条)先按它菜单里的「新对话」**(卡 DB)。这一格**不是某一家的差别** ——
     * 每一家都要,不然话会打进她正开着的那条对话。旧壳不会这件本事就**不送**,说清是壳太旧
     * (假装送了比没送糟得多)。
     */
    const newChat = job.kind === 'dispatch' && job.target.kind === 'new'
    if (newChat && !can('new_conversation')) {
      throw new NotSent(oldShellWhy('先开一条新对话 —— 为了不打进你正开着的那条对话,这次没送'), false, 'none')
    }
    const mark = job.marks?.[0] ?? ''
    const deepLink = deepLinkOf(job)
    /*
     * **它压根没跑 → 先拉起来**(2026-10-02 从 `dispatchClient.sendOnce` 搬进这一层)。
     * 与「没窗口就开窗」那一圈互补:那一圈每回只等 1.2 秒,等不住一个 App 的冷启动。
     * 拉不起来**如实说**(壳那条 `send_text` 自己也激活不了一个没跑的 App)。
     */
    if (deps.ensureRunning !== undefined) {
      const running = await deps.ensureRunning(family, picked.bundleId).catch(() => ({ ok: false, reason: undefined }))
      if (!running.ok) {
        const said = running.reason ?? `找不到窗口:${picked.bundleId} 没在运行`
        throw swapError(job, picked, humanizeFailure(said, family), said)
      }
    }
    let how: FrontHow = 'none'
    let matched = false
    if (newChat) {
      // 新开一条:没有「那一段」可开,叫到台前就够(壳自己还会激活窗口)。
      const fronted = await deps.bringToFront?.(picked.bundleId).catch(() => ({ ok: false }))
      if (fronted?.ok === true) how = 'app'
    }
    else {
      const opened = await openTo({ bundleId: picked.bundleId, ...(deepLink === undefined ? {} : { deepLink }), mark })
      how = opened.how
      matched = opened.matched
    }
    /*
     * **送之前先看一眼她那句在不在对话区里**:壳的 `submitted` 回执不总可靠(豆包按了发送、回执说没发),
     * 送前不在、送后出现了才补认。送前就在的不拿来冒充;读不出来不补认。
     */
    /*
     * 核那一眼用哪一截字:**卡上 / 账上记着的那个记号优先**(`job.confirmMark`)——
     * 盯窗那条巡检后来按的就是它,两头按同一截字才对得上(见契约那一格的注释)。
     */
    const deliveryMark = job.confirmMark !== undefined && job.confirmMark.trim() !== ''
      ? job.confirmMark
      : relayReadMark(job.text)
    const seenBefore = await seesDelivered(picked.bundleId, deliveryMark)
    /** 这一下要不要让壳「照送、把框里原来那段字交回来」(见 {@link WindowAdapterDeps.saveDraft})。 */
    const canSaveDraft = deps.saveDraft !== undefined && can('save_draft')
    const { outcome, front } = await withWindowWake(
      wakeDeps,
      {
        bundleId: picked.bundleId,
        how,
        ...(canWake ? {} : { tries: 0 }),
        ...(deepLink === undefined ? {} : { deepLink }),
        ...wakeAct(job),
      },
      async () => await deps.helper.request({
        op: 'send_text',
        bundle_id: picked.bundleId,
        index: 0,
        text: job.text,
        /*
         * ★ **替不替她按发送**(2026-09-22 A2):事务官主动派的按,她自己在界面上点「送进窗口」的不按。
         * 缺席 = 按(今天绝大多数调用方就是这样)。
         */
        submit: job.submit !== false,
        restore_front: false,
        ...(newChat ? { new_conversation: true } : {}),
        /*
         * **框里她没发出去的那段字:照送,把原文交回来**(卡 DB)。两头都在才发这一格 ——
         * 接得住(`deps.saveDraft`)而且这份壳会这件本事。她明说了「盖掉」(`overwrite`)就不存。
         * **`overwrite` 这一层一次也不发**:存不下来的东西不许盖掉(老规矩没动)。
         */
        ...(canSaveDraft ? { save_draft: true } : {}),
      }, WINDOW_OP_TIMEOUT_MS.send_text),
    )
    if (!outcome.ok) {
      const said = outcome.error.trim() === '' ? '壳那边出错了,但没带原因' : outcome.error
      /*
       * ★ **壳这一送没应声:再核一眼窗口再定,别直接判「没派出去」**(2026-10-13,卡 N;
       * 常量与现场见 {@link HELPER_QUIET_RECHECK_WAITS})。
       *
       * 这一类(60 秒没回 / 这一下正走着壳断了)与别的失败**根子不同**:别的失败是那扇窗上的事实
       * (没窗口、输入框没接住、那一项点不下去),这一类是**我们这一头不知道**——
       * 字多半已经贴进去、也按了发送,只是壳在核对那一步被它自己卡住了。
       *
       * 两件事不许含糊:① 判据只认「送之前没有、送之后出现」({@link quietProofAllowed});
       * ② 只用现成的那一份只读核对(`seesDelivered` → `readRelayEvidence`),**一个字都不再往那扇窗里送**。
       * 核不上就如实 `not_sent`,人话那一句由 `humanizeFailure` 出、原因留在分号后面(卡上看得见、嘴上不念)。
       */
      if (isHelperQuietReason(said)) {
        // 她要的是「只写进框、不发出去」(A2)那一种**没有可找的那一行**(一个字都没发出去)—— 不白读两眼。
        if (job.submit !== false && quietProofAllowed(job, seenBefore)) {
          for (const wait of HELPER_QUIET_RECHECK_WAITS) {
            await sleep(wait)
            // 看见了 = 它窗口里真有这一单那一行:按「送到了」记,派活照常往下走。
            if (await seesDelivered(picked.bundleId, deliveryMark) === true) {
              // `verdict` 的第四格(没核上时那句人话)在核上了这一支里用不着。
              return { ...verdict(job, picked, true, ''), submitted: true }
            }
          }
        }
        // 这一类**一个包都不换、一回窗都不重开**:换包只会把同一句话再送一遍到她没想到的那扇窗。
        throw new NotSent(`${humanizeFailure(said, family)};${said}`, false, 'window')
      }
      throw swapError(job, picked, noWindowWhy(front, humanizeFailure(said, family)), said)
    }
    /*
     * 壳把她那段草稿读出来了 → **这里落盘**,并带一句「你没发的那句我存在这里了」。
     * 存不下来也如实说(这一送已经发出去了,瞒着她更糟)。
     */
    let draft: JobResult['draft']
    /*
     * ★ **空框读回来的那句占位符不算草稿**(2026-10-13,卡 F):壳那张 `knownPlaceholders` 没列豆包,
     * 而壳不随插件发版 —— 存了它就是草稿目录里一份假草稿 + 一句不实的话(判据在 `clientDrafts` 一处)。
     */
    if (typeof outcome.result.draft === 'string' && outcome.result.draft !== ''
      && !isClientInputPlaceholder(outcome.result.draft) && deps.saveDraft !== undefined) {
      const saved: { ok: boolean, path?: string, reason?: string }
        = await deps.saveDraft({ family, text: outcome.result.draft, at: now().toISOString() })
          .catch((error: unknown) => ({ ok: false, reason: messageOf(error) }))
      const returned = outcome.result.draft_returned === true
      draft = {
        saved: saved.ok,
        ...(saved.path === undefined ? {} : { saved_to: saved.path }),
        returned,
        note: deps.draftNote?.({
          who: name(),
          saved,
          returned,
          ...(typeof outcome.result.draft_note === 'string' ? { reason: outcome.result.draft_note } : {}),
        }) ?? '',
      }
    }
    /*
     * ② **读窗前后比**。两种情况下才读(读一次窗要几秒,不白读):回执没说成、或者记号没认出那段对话
     * (认不出也发了,总得有个说法)。`undefined` = 读不了 → 如实说核不了。
     */
    let windowSeen: boolean | undefined
    if (seenBefore === false && (outcome.result.submitted !== true || !matched)) {
      for (let attempt = 0; attempt < WINDOW_SEEN_TRIES; attempt += 1) {
        if (attempt > 0) await sleep(WINDOW_SEEN_STEP_MS)
        windowSeen = await seesDelivered(picked.bundleId, deliveryMark)
        if (windowSeen === true) break
      }
    }
    /*
     * ★ **证据按卡 AW 的三档算,而第一档要带上回执**(2026-10-02 接线时查实的一处口径)。
     *
     * `matched`(送之前那段对话确实认在前台了)只是**旁证** —— 卡 AW 的原话是
     * 「送之前那段对话确实认在前台了,**而且回执说发出去了**」。少了后半句就会出真机那个毛病:
     * 豆包按了发送、回执说没发,而那段对话我们认在前台了 → 报成「送到了」。
     * 所以:`matched && 回执说发出去了` 或者 `读窗前后比看见了` 才算核上。
     *
     * 没核上:**一个字不说成送到了**,三句人话分得清是哪一种 ——
     * ① 回执自己说没发出去 → {@link SEND_RECEIPT_UNSURE}(**要紧的是叫她别重发**);
     * ② 读得了那扇窗、却没看见那一句 → 可能发到了别的对话;
     * ③ 两样都没有(旧壳读不回来 / 那句话太短认不准)→ 没能核实。
     */
    /*
     * ★ **替她按掉了她窗口上那层框 → 一定说一句**(卡 DP;审计第二表第 5 条:从前只有派活那一处说)。
     * 原话由壳出(它按的是哪一颗)。`submitted` 原样带上 —— 卡上「字写进框里了,没发出去」那一句的出处。
     */
    const modalClosed = typeof outcome.result.modal_closed === 'string' && outcome.result.modal_closed !== ''
      ? outcome.result.modal_closed
      : undefined
    /*
     * 「新开一条」那一下壳到底怎么开的(菜单项的名字 / `single_thread`)。原样带上来 ——
     * Muse 那种只有一条对话的 App 开不出新的,卡上那句话要说「它只有一条对话,送进了那一条」,
     * 不能对她说「新开了一条对话」。
     */
    const opened = typeof outcome.result.new_conversation === 'string' && outcome.result.new_conversation !== ''
      ? outcome.result.new_conversation
      : undefined
    /** 字是怎么进去的(壳说的:`ax_value` / `paste` / …)。只进卡上那一格与排障。 */
    const method = typeof outcome.result.method === 'string' && outcome.result.method !== ''
      ? outcome.result.method
      : undefined
    /*
     * ★ **她要的是「只写进框、不发出去」**(A2):那一下**没有任何证据可核**(一个字都没发出去),
     * 所以结局一定是「未确证」+ 一句实话 —— 不说成送到了,也不当失败。
     */
    if (job.submit === false) {
      return {
        ...verdict(job, picked, false, TYPED_NOT_SENT),
        submitted: false,
        ...(draft === undefined ? {} : { draft }),
        ...(modalClosed === undefined ? {} : { modalClosed }),
        ...(opened === undefined ? {} : { newConversation: opened }),
        ...(method === undefined ? {} : { method }),
      }
    }
    const receipt = outcome.result.submitted === true
    const out = verdict(
      job,
      picked,
      (matched && receipt) || windowSeen === true,
      !receipt
        ? SEND_RECEIPT_UNSURE
        : windowSeen === false || seenBefore === false ? windowUnconfirmedWhy(name()) : windowUnverifiableWhy(name()),
    )
    return {
      ...out,
      submitted: receipt || windowSeen === true,
      ...(draft === undefined ? {} : { draft }),
      ...(modalClosed === undefined ? {} : { modalClosed }),
      ...(opened === undefined ? {} : { newConversation: opened }),
      ...(method === undefined ? {} : { method }),
    }
  }

  // ───────────────────── 点她那一项 / 批准弹窗 / 写面板 / 停 ─────────────────────

  /** 普通选项:`agent_press`。**点完重读一次,那一项没了才算答上了**。 */
  async function pressOption(job: Job, picked: PickedPackage): Promise<JobResult> {
    if (!can('agent_press')) throw new NotSent(oldShellWhy('替你点那个框上的一项'), true, 'none')
    const deepLink = deepLinkOf(job)
    const options = job.marks === undefined ? undefined : [...job.marks]
    const { outcome, front } = await withWindowWake(
      wakeDeps,
      { bundleId: picked.bundleId, ...(canWake ? {} : { tries: 0 }), ...(deepLink === undefined ? {} : { deepLink }), ...wakeAct(job) },
      async () => await deps.helper.request(
        { op: 'agent_press', bundle_id: picked.bundleId, label: job.text, ...(options === undefined ? {} : { options }) },
        WINDOW_OP_TIMEOUT_MS.agent_press,
      ),
    )
    if (!outcome.ok) throw swapError(job, picked, noWindowWhy(front, outcome.error), outcome.error)
    if (outcome.result.found !== true) throw new NotSent(noteOf(outcome.result) ?? `它窗口里没找到「${job.text}」这一项`)
    if (outcome.result.pressed !== true) throw new NotSent(noteOf(outcome.result) ?? '那一项点不下去')
    return verdict(job, picked, outcome.result.gone === true, `点了「${job.text}」,但没看到它收下 —— 去电脑上的${spaced(name())}看一眼`)
  }

  /**
   * 权限弹窗:先读一眼有哪几块、哪几颗键(`agent_approval` 不带 `press`)→ 挑那一块、挑那一颗
   * (`approvalKeys` 一处判:放宽的那一类一颗都不给)→ 只在那一块里按那一颗 →
   * **按完重读,那颗键没了才算批了**。
   */
  async function pressApproval(job: Job, picked: PickedPackage, marks: readonly string[]): Promise<JobResult> {
    const deepLink = deepLinkOf(job)
    const wake = { bundleId: picked.bundleId, ...(canWake ? {} : { tries: 0 }), ...(deepLink === undefined ? {} : { deepLink }), ...wakeAct(job) }
    /*
     * 按下去之前**先过一次闸**(`approval`:按一颗键是替她做了一个决定)。
     * ★ 这一下**不另算一回 `approval_read`**(2026-10-02):读那一眼是「按下去」的一部分,
     * 而 `approval_read` 的间隔是 1 秒 —— 她刚打开那张卡读过一次键、紧接着点下去,
     * 两下只隔几百毫秒,算两回就会被自己拦下。`approval_read` 只在
     * {@link Adapter.readApproval}(她打开那张卡那一下)算一回。
     */
    pass(job, picked.bundleId, 'approval', 'window')
    const read = await withWindowWake(
      wakeDeps,
      wake,
      async () => await deps.helper.request(
        { op: 'agent_approval', bundle_id: picked.bundleId, marks: [...marks] },
        WINDOW_OP_TIMEOUT_MS.agent_approval,
      ),
    )
    if (!read.outcome.ok) throw swapError(job, picked, noWindowWhy(read.front, read.outcome.error), read.outcome.error)
    const panels = approvalPanelsOf(read.outcome.result.panels)
    const chosen = pickApprovalPanel(panels)
    /*
     * **一块都不像权限弹窗 → 这不是权限弹窗**,按它明写的选项再来一次(`agent_press`)。
     * 认出了弹窗、只是那颗键不给按(放宽的那一类)**不走这条**:那样会绕过 `approvalKeys` 那道门
     * (见 {@link looksLikeApproval} 的注释)。
     */
    if (!chosen.ok) {
      if (!looksLikeApproval(panels) && can('agent_press')) return await pressOption(job, picked)
      throw new NotSent(chosen.why)
    }
    const key = resolveApprovalKey(chosen.keys, job.text)
    if (key === undefined) {
      throw new NotSent(`那个弹窗上的键是「${chosen.keys.map(one => one.label).join('」「')}」,对不上你说的「${job.text}」,一颗都没敢按`)
    }
    const { outcome, front } = await withWindowWake(
      wakeDeps,
      wake,
      async () => await deps.helper.request(
        { op: 'agent_approval', bundle_id: picked.bundleId, marks: [...marks], press: key.label, panel: { ...chosen.panel } },
        WINDOW_OP_TIMEOUT_MS.agent_approval_press,
      ),
    )
    if (!outcome.ok) throw swapError(job, picked, noWindowWhy(front, outcome.error), outcome.error)
    if (outcome.result.found !== true) throw new NotSent(noteOf(outcome.result) ?? `那个弹窗上没找到「${key.label}」`)
    if (outcome.result.pressed !== true) throw new NotSent(noteOf(outcome.result) ?? '那颗键按不下去')
    return verdict(job, picked, outcome.result.gone === true, `按了「${key.label}」,可那个弹窗还在 —— 没按上,去电脑上的${spaced(name())}看一眼`)
  }

  /** 往它的提问面板里写字:**那个面板没了 + 窗口里出现了她那句**,两条都成立才算答上了。 */
  async function writeAsk(job: Job, picked: PickedPackage): Promise<JobResult> {
    if (!can('agent_write_ask')) throw new NotSent(oldShellWhy('往那个框里写字'), true, 'none')
    // 只对认准了的那个包开着(与 `capabilities().writeAsk` 同一处判据,见 {@link writeAskAllowed})。
    if (!writeAskAllowed(picked.bundleId)) {
      throw new NotSent(`${name()}那个提问面板还没在真机上认准,工作台不往里写字 —— 这一句要你自己去说`, true, 'none')
    }
    const marks = job.marks ?? []
    if (marks.length === 0) throw new NotSent('没有一截原话能用来认出它那个提问面板,一个字都没写', false, 'none')
    const deepLink = deepLinkOf(job)
    const { outcome, front } = await withWindowWake(
      wakeDeps,
      { bundleId: picked.bundleId, ...(canWake ? {} : { tries: 0 }), ...(deepLink === undefined ? {} : { deepLink }), ...wakeAct(job) },
      async () => await deps.helper.request(
        { op: 'agent_write_ask', bundle_id: picked.bundleId, text: job.text, marks: [...marks] },
        WINDOW_OP_TIMEOUT_MS.agent_write_ask,
      ),
    )
    if (!outcome.ok) throw swapError(job, picked, noWindowWhy(front, outcome.error), outcome.error)
    if (outcome.result.found !== true) throw new NotSent(noteOf(outcome.result) ?? '它窗口里没找着那个能打字的提问面板')
    if (outcome.result.wrote !== true) throw new NotSent(noteOf(outcome.result) ?? '那一句没写进去')
    if (outcome.result.submitted !== true) throw new NotSent(noteOf(outcome.result) ?? '字写进去了,但没按下发送')
    return verdict(
      job,
      picked,
      outcome.result.gone === true && outcome.result.echoed === true,
      `把「${job.text}」写进去按了发送,但没看到它收下 —— 去电脑上的${spaced(name())}看一眼`,
    )
  }

  /** 按它的停止键。认不出那颗键时壳回 `found:false` —— 原样往上报,**绝不说成「打断了」**。 */
  async function stop(job: Job, picked: PickedPackage): Promise<JobResult> {
    if (!can('agent_stop')) throw new NotSent(oldShellWhy('按那家的停止键'), true, 'none')
    const deepLink = deepLinkOf(job)
    const { outcome, front } = await withWindowWake(
      wakeDeps,
      { bundleId: picked.bundleId, ...(canWake ? {} : { tries: 0 }), ...(deepLink === undefined ? {} : { deepLink }), ...wakeAct(job) },
      async () => await deps.helper.request({ op: 'agent_stop', bundle_id: picked.bundleId }, WINDOW_OP_TIMEOUT_MS.agent_stop),
    )
    if (!outcome.ok) throw swapError(job, picked, noWindowWhy(front, outcome.error), outcome.error)
    if (outcome.result.found !== true) throw new NotSent(noteOf(outcome.result) ?? '认不出它的停止键')
    if (outcome.result.pressed !== true) throw new NotSent(noteOf(outcome.result) ?? '停止键按不下去')
    return verdict(job, picked, outcome.result.stopped === true, `按了它的停止键,但没看出它停下来 —— 去电脑上的${spaced(name())}看一眼`)
  }

  /**
   * ★ **只读一眼那一段此刻的回话**(契约 2026-10-02 加的 `Adapter.read`;「盯着等回话」那条巡检用它)。
   *
   * **不送、不点、不叫台前、不开窗、不过闸** —— 它只读(`read_reply`;豆包办公那一个包认不出时
   * `readRelayEvidence` 里退到读整扇窗 `agent_read`)。巡检一条会话会读几百次,**一次都不许动她的窗口**。
   *
   * 三种结局分得清,**「读不到」不许说成「它还没回」**:
   * ① 读到了、它写完了 → `reply`(由 `extractReply` 剥掉我们那一条的回声与读屏播报);
   * ② 读到了、它还在写(停止键还在)→ 没有 `reply` + {@link READ_BUSY_WHY};
   * ③ 读不到(壳没连上 / 旧壳 / 这一拍失败)→ 没有 `reply` + 一句实话。
   */
  async function read(job: Job): Promise<AdapterReadResult> {
    if (!deps.helper.connected()) return { via: 'none', evidence: 'none', why: HELPER_DOWN_WHY }
    /*
     * ★ **锁着屏:连读都不读**(2026-10-03)。锁屏时辅助功能一扇窗都列不出 —— 读一眼只会得到
     * 「一扇标准窗口都没有」,而这一层**不许把「读不到」说成「它还没回」**(契约那一条纪律)。
     * 这一下也不排队:下一拍她解锁了自然就读到了(巡检本来就是一拍一拍地来)。
     */
    if (lockedNow(deps)) return { via: 'none', evidence: 'none', why: screenLockedReadSay(name()) }
    if (!can('read_reply')) return { via: 'none', evidence: 'none', why: oldShellWhy('读回它的回话') }
    const picked = resolvePackage({ package: job.package })
    if (picked === undefined) return { via: 'none', evidence: 'none', why: noPackageWhy(name()) }
    /*
     * ★ **两格分开**(2026-10-02 接线时查实的一处真差别):
     * - `mark` = **在对话区里找我们那一句**用的那一截:`marks[0]`(调用方记在卡上 / 账上的那个记号,
     *   派活是「工作台派活 xxxxxx」、捎话是她那句原话本身);没给就退回她那句原话本身;
     * - `echo` = **剥回声**用的那一段:我们送进去的**那一整段**(`job.text`)。
     *
     * 为什么不能合成一格:`dispatchReply.extractReply` 的 `prompt` 要的是整段
     * (0.2.96 真机那一串 Codex 把我们的消息画成了 20 截,靠整段才剥得干净);
     * 而「找我们那一句」要的是那个短记号。合成一格就一定有一头是错的。
     */
    const mark = (job.marks?.[0] ?? '').trim() !== '' ? (job.marks?.[0] as string) : relayReadMark(job.text)
    const echo = job.text.trim() === '' ? mark : job.text
    const said = mark
    if ([...said].length < 4) return { via: 'window', evidence: 'none', why: '没有一截能认的字,读不出哪一句是回答' }
    let result: Record<string, unknown>
    try {
      const outcome = await readRelayEvidence(deps.helper, picked.bundleId, said, WINDOW_OP_TIMEOUT_MS.read_watch)
      if (!outcome.ok) return { via: 'window', evidence: 'none', why: READ_FAILED_WHY }
      result = outcome.result
    }
    catch { return { via: 'window', evidence: 'none', why: READ_FAILED_WHY } }
    if (result.found !== true || !Array.isArray(result.texts)) {
      // 还没在对话区里看见我们那一句 —— 这一拍什么都没读到,不编一个「它还没回」。
      return { via: 'window', evidence: 'none', why: READ_FAILED_WHY }
    }
    const busy = result.busy === true
    const texts = result.texts.filter((one): one is string => typeof one === 'string')
    // 老记号(「事务官捎话 xxxxxx」)照旧带括号认;09-28 之后记的是她那句原话本身。
    const reply = extractReply(texts, { family, prompt: said.startsWith(RELAY_TAG) ? `【${said}】` : echo }).text
    if (busy || reply.trim() === '') {
      // 「它还在写」与「读到了、可那一段里没有回答」分开报:前者 `busy`,后者只有证据没有 `reply`。
      return { via: 'window', evidence: 'window', ...(busy ? { busy: true, why: READ_BUSY_WHY } : {}) }
    }
    return { via: 'window', evidence: 'window', reply }
  }

  /**
   * ★ **只看一眼它那个权限弹框上有哪几颗键**(契约 2026-10-02 加的 `Adapter.readApproval`;
   * 接线那张卡把 `sessionAnswer.readApproval` 那只手收到这儿)。**一颗键都不按。**
   *
   * `active:false` = 一下都不动她的窗口(她在电脑前时不抢窗口),所以**那一圈开窗不走**;
   * `active:true` = 允许叫台前 + 深链开到那一段;读到的那几块还是空、而壳会在侧栏里点那一行时,
   * 点一下再读一次(与老的那只手同一个次序)。
   *
   * 闸走 `approval_read`(与真按下去那一颗的 `approval` 分成两样:她每打开那张卡就读一次)。
   */
  async function readApproval(job: Job, options: { active: boolean }): Promise<ApprovalReadResult> {
    const no = (why: string, via: JobResult['via'] = 'none'): ApprovalReadResult => ({ panels: [], via, why })
    if (!deps.helper.connected()) return no(HELPER_DOWN_WHY)
    if (!can('agent_approval')) return no(oldShellWhy('替你看那个批准弹窗'))
    const marks = job.marks ?? []
    if (marks.length === 0) return no('没有一截原话能用来认出它那个权限弹框,一眼都没看')
    let picked: PickedPackage
    try { picked = packageFor(job) }
    catch (error) { return no(error instanceof NotSent ? error.message : messageOf(error)) }
    // 自绘界面上按名字找键一定找不着(与 `capabilities()` 说同一句话,见文件头第 4 条)。
    if (pasteOnly()) return no(selfDrawnWhy(name(), '它那个权限弹框上的键'))
    try { pass(job, picked.bundleId, 'approval_read') }
    catch (error) { return no(error instanceof NotSent ? error.message : messageOf(error)) }
    const deepLink = deepLinkOf(job)
    const readOnce = async (wake: boolean, how: FrontHow): Promise<ApprovalReadResult> => {
      const { outcome, front } = await withWindowWake(
        wakeDeps,
        {
          bundleId: picked.bundleId,
          how,
          ...(wake && canWake ? {} : { tries: 0 }),
          ...(deepLink === undefined ? {} : { deepLink }),
          ...wakeAct(job),
        },
        async () => await deps.helper.request(
          { op: 'agent_approval', bundle_id: picked.bundleId, marks: [...marks] },
          WINDOW_OP_TIMEOUT_MS.agent_approval,
        ),
      )
      if (!outcome.ok) return { panels: [], via: 'window', why: noWindowWhy(front, outcome.error) }
      return { panels: approvalPanelsOf(outcome.result.panels), via: 'window' }
    }
    /*
     * ★ **两步都在这一层**(2026-10-02):先只读一眼(不动她的窗口),读不到再开到前面读一次。
     *
     * 从前这两步在消费方(`sessionAnswer.readApprovalPanel` 连调两回那只手),而那只手每一回都过一次
     * `approval_read` 的闸 —— 两回只隔几毫秒,第二回必然撞上「离上一回太密」(间隔 1 秒),
     * 于是「只读一眼没认出 → 开到前面再读」那条路其实从来没走通过。
     * 收进这一层之后:**一次调用、一回闸**。
     */
    if (!options.active) return await readOnce(false, 'none')
    const passive = await readOnce(false, 'none')
    if (passive.panels.length > 0) return passive
    let how: FrontHow = 'none'
    const fronted = await deps.bringToFront?.(picked.bundleId).catch(() => ({ ok: false }))
    if (fronted?.ok === true) how = 'app'
    if (deepLink !== undefined && deps.openUrl !== undefined) {
      const opened = await deps.openUrl(deepLink).catch(() => ({ ok: false }))
      if (opened.ok) { how = 'link'; await sleep(settleMs) }
    }
    const first = await readOnce(true, how)
    const pickTitle = marks[0] ?? ''
    if (first.panels.length > 0 || first.why !== undefined || pickTitle === '' || !can('agent_pick')) return first
    try {
      const got = helperOutcome(await deps.helper.request(
        { op: 'agent_pick', bundle_id: picked.bundleId, title: pickTitle },
        WINDOW_OP_TIMEOUT_MS.agent_pick,
      ))
      if (!(got.ok && got.result.found === true && got.result.pressed === true)) return first
    }
    catch { return first }
    await sleep(settleMs)
    return await readOnce(true, 'pick')
  }

  return {
    family,
    via: 'window',
    read,
    readApproval,

    /**
     * ★ **「去回答」:把那一段开到她眼前**(契约 2026-10-02 加的 `Adapter.reveal`)。
     *
     * **一个字都不送**:深链(开得到某一段的那两家)→ 侧栏里点那一行 → 叫到台前。
     * 这一下过 `bring_front` 那一样闸 —— 它真的把一个 App 的窗弹到她眼前,
     * 而那一样从卡 AG 立起来一直没有调用方(审计第二表第 13 条点名的那一条)。
     */
    async reveal(job: Job): Promise<{ ok: boolean, how: 'link' | 'pick' | 'app' | 'none', why?: string }> {
      if (!deps.helper.connected() && deps.openUrl === undefined && deps.openApp === undefined && deps.bringToFront === undefined) {
        return { ok: false, how: 'none', why: HELPER_DOWN_WHY }
      }
      const picked = resolvePackage({ package: job.package })
      if (picked === undefined) return { ok: false, how: 'none', why: noPackageWhy(name()) }
      /*
       * ★ **锁着屏:开不到她眼前**(2026-10-03)。锁屏时 `open -b` / 深链都起不出窗
       * (真机 09:04 五次都没用),而且**她这会儿根本看不见屏幕** —— 说实话比弹一下更有用。
       */
      if (lockedNow(deps)) return { ok: false, how: 'none', why: screenLockedWhy(name()) }
      const why = unreadableWhy(picked.said ? picked.bundleId : undefined)
      if (why !== undefined) return { ok: false, how: 'none', why }
      try { pass(job, picked.bundleId, 'bring_front') }
      catch (error) { return { ok: false, how: 'none', why: error instanceof NotSent ? error.message : messageOf(error) } }
      const deepLink = deepLinkOf(job)
      if (deepLink !== undefined && deps.openUrl !== undefined) {
        const opened = await deps.openUrl(deepLink).catch(() => ({ ok: false }))
        if (opened.ok) return { ok: true, how: 'link' }
      }
      const fronted = await deps.bringToFront?.(picked.bundleId).catch(() => ({ ok: false }))
      if (fronted?.ok === true) return { ok: true, how: 'app' }
      const opened = await deps.openApp?.(picked.bundleId).catch(() => ({ ok: false }))
      if (opened?.ok === true) return { ok: true, how: 'app' }
      return { ok: false, how: 'none', why: `这会儿没把${spaced(name())}的窗开到前面` }
    },

    /**
     * ★ **这一条通道此刻为什么用不上**(契约 2026-10-02 加的那一格)。
     *
     * 「壳没连上」与「这台没装它」下一步做的事完全不同(一个去开工作台 App,一个去装那一家),
     * 所以分开说 —— 一条通道都排不上队时引擎把这一句接进 `why`。
     */
    unavailable(): string | undefined {
      if (!deps.helper.connected()) return HELPER_DOWN_WHY
      const bundle = resolvePackage({})
      if (bundle === undefined) return noPackageWhy(name())
      if (CLIENT_DISPATCH_NEVER.includes(bundle.bundleId)) return neverSendWhy(name())
      return unreadableWhy()
    },

    /**
     * 写入靠什么:自绘界面(`judgeStructure` 现查出的 `paste_only`)只能粘贴 + 回车 ——
     * 那条退路在壳内部,适配器这一层只把这一格报上去(候选名单据此标「写入靠粘贴」)。
     */
    async writeMode(): Promise<'full' | 'paste_only'> {
      return pasteOnly() ? 'paste_only' : 'full'
    },

    /**
     * **现查**,不写死:这一家能做哪几样,问这会儿的壳与体检表。
     * `open` 要有一样能把窗开出来 / 叫到台前的本事;`openSession` = 有深链、或者壳会在侧栏里点那一行。
     */
    async capabilities(): Promise<AdapterCapabilities> {
      const bundle = resolvePackage({})
      const known = bundle !== undefined && !CLIENT_DISPATCH_NEVER.includes(bundle.bundleId)
      // 「认出是 AI 应用、可那扇窗读不到」的那几家:这一条通道一样都不会(见 {@link WindowAdapterDeps.unreadable})。
      const live = deps.helper.connected() && known && unreadableWhy() === undefined
      /*
       * 体检表上**这一家**那两格(`agentCaps.cellsOf`;只问这一家的理由见 {@link WindowAdapterDeps.capCells}):
       * `chat` = 送得进话、`collect` = 收得回结果。
       * 查不到这一家 / 没接体检(老宿主)→ **不拿它否掉壳此刻的事实**(`unknown` 不等于「不行」)。
       */
      const cells = deps.capCells?.(family)
      const cell = (key: 'chat' | 'collect'): boolean | undefined => {
        const got = cells?.[key]
        return got === undefined ? undefined : got.state === 'ok'
      }
      const hasDeepLink = windowFamilyRow(family).deepLink !== undefined
      /*
       * ★ **自绘界面那一档**(卡「适配自绘界面的 Kimi」):`paste_only` = 读得到、写入靠粘贴。
       * 送 / 读照旧(壳内部那条粘贴的退路);**按名字找键的那三样一律说不行** ——
       * 点选项、按停止、在侧栏里点那一行都靠「树里有一行叫这个名字」,自绘的控件没有名字。
       * 认错的方向**悲观**(说不行),与那张卡第 3 条同一个纪律。
       */
      const drawn = pasteOnly()
      return {
        /*
         * ★ **「开得到它的窗」不经壳**(2026-10-02 接「去回答」时查实):`open <深链>` / `open -b <包>` /
         * 窗位叠切一格都是工作台自己做的事,壳没连上照样开得出来 —— 所以这一格**不看 `live`**,
         * 只看「认不认得出是哪一家」+「有没有一样能开的本事」。
         * (送 / 读 / 点那几样才真要壳。)
         */
        open: known && unreadableWhy() === undefined && (deps.openApp !== undefined || deps.openUrl !== undefined || deps.bringToFront !== undefined),
        send: live && (cell('chat') ?? true),
        read: live && can('read_reply') && (cell('collect') ?? true),
        /*
         * ★ **「能替她点一下它窗口上的东西」**:它明写的那一项(`agent_press`)**或者**
         * 权限弹框上那一颗(`agent_approval`)。
         *
         * 为什么是「或者」:契约的 `JobKind` 只有一个 `press`,而「这一下按的是普通选项还是权限弹框」
         * 只有这一层分得出来(`windowPressRoute`)。要是这一格只认 `agent_press`,
         * 一份只会 `agent_approval` 的壳就连「替她批准一次」都排不上队(真壳两样报在同一串里,
         * 所以今天看不见这个洞 —— 但契约上它是个洞)。
         * 界面上「它明写的那几项点得下去」那一格因此在那种壳上会是真:**认错的方向是乐观** ——
         * 真点不下去时适配器会如实回 `unsupported`,照旧那句「到电脑上点」。
         */
        press: live && !drawn && (can('agent_press') || can('agent_approval')),
        approve: live && !drawn && can('agent_approval'),
        /*
         * ★ **往那个提问面板里写字:只对认准了的那一家开着**(见 {@link writeAskAllowed})。
         * 这一格从前写在 `sessionAnswer` 那只手的 `canWriteAsk(bundleId)` 上,现在只有这一处。
         */
        writeAsk: live && !drawn && can('agent_write_ask') && writeAskAllowed(bundle?.bundleId),
        stop: live && !drawn && can('agent_stop'),
        openSession: live && (hasDeepLink || (!drawn && can('agent_pick'))),
      }
    },

    /**
     * 做这一件。**这一层只回「送到没送到」**:`expect:'reply'` 那一种不在这儿等它回话 ——
     * 窗口型要等二十分钟、每几秒读一次窗,那是引擎的巡检(第三段把 `relayWatch` 迁过来),
     * 不是一次调用干的事。
     */
    async run(job: Job): Promise<JobResult> {
      try {
        if (job.kind === 'answer' || job.kind === 'relay' || job.kind === 'dispatch') return await send(job)
        const picked = packageFor(job)
        /*
         * ★ **自绘界面上按名字找键的那三样一下都不试**(见 {@link selfDrawnWhy})。
         * `capabilities()` 已经说了不行,这里跟着不试 —— 两处说不一样的话,界面上就会摆出
         * 一颗点下去说「到电脑上点」的键。送话那三种 `kind` 不走这条:它们有粘贴那条退路。
         */
        if (pasteOnly()) {
          const what = job.kind === 'stop' ? '它的停止键' : job.kind === 'write_ask' ? '它那个提问面板' : `「${job.text}」那一项`
          throw new NotSent(selfDrawnWhy(name(), what), true, 'none')
        }
        if (job.kind === 'stop') return await stop(job, picked)
        if (job.kind === 'write_ask') return await writeAsk(job, picked)
        const marks = job.marks ?? []
        return windowPressRoute({ label: job.text, marks, canApprove: can('agent_approval') }) === 'approval'
          ? await pressApproval(job, picked, marks)
          : await pressOption(job, picked)
      }
      catch (error) {
        // 可重试的那一下原样抛出去:**重不重来由引擎定**(契约第 2 段)。
        if (error instanceof RetryableError) throw error
        if (error instanceof NotSent) {
          return {
            delivered: 'not_sent',
            via: error.via,
            ...sessionOf(job),
            why: error.message,
            ...(error.unsupported ? { unsupported: true } : {}),
            /*
             * ★ **锁着屏那一格**(2026-10-03):引擎据此**排队等解锁**、把那句人话换成最终版。
             * **不带 `unsupported`** —— 那一格会让引擎去换另一条通道,而另一条通道一样撞上锁屏。
             */
            ...(error.screenLocked ? { screenLocked: true as const } : {}),
          }
        }
        throw error
      }
    },
  }
}
