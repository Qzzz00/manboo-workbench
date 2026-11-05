/**
 * **「一扇标准窗口都没有」不是终点 —— 哪一条路上都不是**(2026-10-01,卡 AX / AX2 / AX3)。
 *
 * 这一份只放一件事:**调壳 → 壳说没窗口 → 把那一家的窗真正开出来、等一拍 → 再来一遍**。
 * 它原来住在 `sessionAnswer.ts`(卡 AX2 把窗口上那五条路收成了一条);
 * 2026-10-01 卡 AX3 要把**派活那条路**(`dispatchClient.sendOnce`)也收进同一圈,
 * 而 `dispatchClient` 是 `sessionAnswer` 的上游 —— 于是这一圈搬到这个两边都引得到的小模块里,
 * **仍然只有一份**(`sessionAnswer.ts` 原样 re-export,老的引用一个字不用改)。
 *
 * 归类照旧只问 {@link isNoWindowReason} → `classifyFailure`(一处);壳回包的成败只问 `helperOutcome`(一处)。
 */
import type { ActionGate } from './actionGate.ts'
import { classifyFailure, helperOutcome } from './dispatchClient.ts'

// ───────────── 「一扇标准窗口都没有」:先把窗开出来再送(2026-10-01,卡 AX) ─────────────

/**
 * **撞上「一扇标准窗口都没有」时,再把那一家的窗开出来几回**(2026-10-01,卡 AX)。
 *
 * 现场(维护者 19:5x):同一条 Claude 桌面会话,「等你确认」那条路(`/sessions/answer`)送进去了,
 * 紧接着「最近会话 → 发一句」(`/sessions/relay`)**三次**都停在壳的 `send_text`:
 * 「找不到窗口:com.anthropic.claudefordesktop 在跑,但一扇标准窗口都没有」,然后退回让她到电脑上打字。
 *
 * 根因那一半在这里:从前这只手**叫一次台前就送**,壳回 `no_window` 就当场失败 —— 一次都不等、一次都不重开。
 * 而窗口露出来是要时间的:藏着的 App 辅助功能一扇窗都列不出(卡 MQ2 量过),`unhide` / `open -b` / 换桌面
 * 之后那张清单要**一两秒**才跟上(壳里 `sendText` 只等 250ms)。
 *
 * 口径(维护者 10-01 已拍板:能力通用、不分家):**先用深链 / `open -b` 把窗真正开出来、等它出现再送**,
 * 给个上限,到顶还是没有才如实说。「答」与「捎话」走同一只手、同一套处理。
 */
export const NO_WINDOW_WAKE_TRIES = 3
/** 每回开完等多久让那扇窗露出来(毫秒;比壳里那 250ms 宽,照卡 MQ2 量到的「一两秒」)。 */
export const NO_WINDOW_WAKE_WAIT_MS = 1200
/** 到顶还是一扇窗都没有时,接在壳那句原话后面的实话(**不假装送到了**)。 */
export const NO_WINDOW_GAVE_UP = `又把它的窗开了 ${NO_WINDOW_WAKE_TRIES} 回(深链 / open -b)、每回等了它一下,还是一扇窗都没露出来`

/** 壳回的这句话是不是「一扇标准窗口都没有」那一类(归类只在 `classifyFailure` 一处,不在这儿抄第二份)。 */
export function isNoWindowReason(why: string): boolean {
  return classifyFailure(why) === 'no_window'
}

/** 这一次是用哪样把那扇窗开到前台的。 */
export type FrontHow = 'link' | 'pick' | 'app' | 'none'

/**
 * **这一次怎么开到前台、壳回的窗口状态**(2026-10-01,卡 AX;只为日志那一行能对时间)。
 * 记的是我们做了什么、壳说了什么 —— **不记她那句话**。
 */
export interface FrontTrace {
  how: FrontHow
  /** 撞上 `no_window` 之后又把窗开出来几回(缺席 / 0 = 没撞上)。 */
  woke?: number
  /** 壳回的窗口状态:`ok` 走到了打字那一步;`no_window` 一扇标准窗口都没有;`other` 别的错(原话在 `why` 里)。 */
  window: 'ok' | 'no_window' | 'other'
}

/*
 * ★ **`frontTraceText` 删了**(2026-10-02,卡「引擎接线与删复制品」)。
 *
 * 它是日志那一行的后半截(「,开到前台:深链、又开了 3 回,壳说一扇标准窗口都没有」),
 * 原来由 `http.ts` 那 11 处手拼的日志行各自接上去。那 11 处收成引擎一处之后,
 * 契约里 `JobResult` **没有 `front` 这一格**(窗口适配器那张卡写明了),于是没有调用方了。
 * 「又开了几回窗」那句实话照旧有 —— {@link noWindowWhy} 把它接进 `why`,引擎记的那一行带着它。
 */

// ───────────────────── 没窗口就把窗开出来再来一遍(一条,五条路共用) ─────────────────────

/**
 * 开窗那一下要的那几样(2026-10-01,卡 AX2;维护者 21:0x:「把你说的三种情况赶紧也搞通,能力是通用的」)。
 * 与 {@link WindowHandDeps} 同名的那几格逐字同义 —— 那一份是全集,这一份只是这一圈用得到的子集。
 */
export interface WindowWakeDeps {
  openUrl?: (url: string) => Promise<{ ok: boolean }>
  openApp?: (bundleId: string) => Promise<{ ok: boolean }>
  bringToFront?: (bundleId: string) => Promise<{ ok: boolean }>
  /** 每回开完等多久让那扇窗露出来(毫秒),缺省 {@link NO_WINDOW_WAKE_WAIT_MS}。 */
  wakeWaitMs?: number
  sleep: (ms: number) => Promise<void>
  /**
   * ★ **动作闸**(2026-10-02,卡 AG):开窗是**真把一个 App 的窗弹到她眼前**,所以这一下也要先问一句
   * 「这件事还动不动得那一家」。缺席 = 不过闸(老宿主 / 用例一字不变),但那样跨调用就没有上限了 ——
   * `tries` 只管一次调用,换个包、下一拍、另一条管线又是新的 3 回。闸按「事项 · 家 · 动作」记总数。
   */
  gate?: ActionGate
}

/** 壳那一回的结论(与 `helperOutcome` 同形;reject 也收成这一形)。 */
export type HelperCallOutcome = { ok: true, result: Record<string, unknown> } | { ok: false, error: string }

/**
 * **把那一家的窗真正开出来一回**。深链优先(它能开到那一段对话);没有深链就一定走 `open -b`
 * (零窗口的 App —— 窗关了、只剩菜单栏图标 —— 靠它把窗开回来;`bringToFront` 在窗位叠里有它时
 * 只走 `dock.switchTo`,不保证开窗)。回这一回用上的是哪一样,一样都没开成回 `undefined`。
 */
async function wakeWindowOnce(deps: WindowWakeDeps, req: { bundleId: string, deepLink?: string }): Promise<FrontHow | undefined> {
  if (req.deepLink !== undefined && deps.openUrl !== undefined) {
    const opened = await deps.openUrl(req.deepLink).catch(() => ({ ok: false }))
    return opened.ok ? 'link' : undefined
  }
  const opened = await (deps.openApp ?? deps.bringToFront)?.(req.bundleId).catch(() => ({ ok: false }))
  return opened?.ok === true ? 'app' : undefined
}

/**
 * ★ **「一扇标准窗口都没有」不是终点 —— 哪一条路上都不是**(2026-10-01,卡 AX2)。
 *
 * 卡 AX 只把「打字发送」那一条收进了这一圈,于是替她点框上那一项(`agent_press`)、往提问面板里写字
 * (`agent_write_ask`)、看 / 按权限弹窗(`agent_approval`)撞上「窗没露出来」照旧当场失败。
 * 维护者 21:0x:「把你说的三种情况赶紧也搞通,**能力是通用的**」。所以这一圈收成**一个**函数,
 * 五条路(答 / 捎话 / 点选项 / 写面板 / 批准)全走它,**一条都不许自己抄一份**。
 *
 * 一圈是:调壳 → 壳说没窗口 → 深链 / `open -b` 把窗真正开出来、等一拍 → 再来一遍,
 * 最多 {@link NO_WINDOW_WAKE_TRIES} 回;到顶还是没有,把壳那句原话原样交回去(外层接 {@link NO_WINDOW_GAVE_UP})。
 *
 * **两件事不许含糊**:
 * ① 真壳(`helperChannel`)在 ok:false 时是 **reject 一个 Error**,不是回 `{ok:false}` —— 这里收住 reject
 *    再归类,否则「没窗口」直接落进调用方的 catch、绕过这一圈(10-01 20:57 真机就是这样,见 4505d5da);
 * ② **只在归类为 `no_window` 时重开**。`no_window` = 壳连那扇窗都没找到(`SendTextPolicy.Failure.noWindow`),
 *    所以它一个字都没打、一下都没点 —— 重来不会多打一遍、多点一下。别的失败(输入框没接住、那一项点不下去、
 *    那颗键按不动)是**那扇窗上的事实**:一回都不重开,不然就是重复点击。
 */
export async function withWindowWake(
  deps: WindowWakeDeps,
  req: { bundleId: string, deepLink?: string, how?: FrontHow, tries?: number, job?: string, family?: string },
  op: () => Promise<Record<string, unknown>>,
): Promise<{ outcome: HelperCallOutcome, front: FrontTrace }> {
  const once = async (): Promise<HelperCallOutcome> => {
    try { return helperOutcome(await op()) }
    catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
  }
  const tries = req.tries ?? NO_WINDOW_WAKE_TRIES
  /**
   * ★ **这一下开窗动得动不得**(卡 AG)。闸缺席、或者这一路还没把事项 / 家名带进来 → 照旧开
   * (行为一字不变);闸拦下 → **不开**,这一圈当场收住,外层照「到顶还是没窗口」那一句如实说。
   */
  const mayWake = (): boolean => {
    if (deps.gate === undefined || req.job === undefined || req.family === undefined) return true
    return deps.gate.allow({ job: req.job, family: req.family, action: 'window_wake', bundle_id: req.bundleId }).ok
  }
  let how: FrontHow = req.how ?? 'none'
  let woke = 0
  let got = await once()
  while (!got.ok && isNoWindowReason(got.error) && woke < tries && mayWake()) {
    woke += 1
    const used = await wakeWindowOnce(deps, req)
    if (used !== undefined) how = used
    await deps.sleep(deps.wakeWaitMs ?? NO_WINDOW_WAKE_WAIT_MS)
    got = await once()
  }
  return { outcome: got, front: { how, woke, window: got.ok ? 'ok' : isNoWindowReason(got.error) ? 'no_window' : 'other' } }
}

/**
 * 到顶还是没窗口时该说的那句(**不假装做到了**):壳那句原话 + 「又开了几回」。
 * 没撞上没窗口、或者一回都没重开 → 原话一字不改(老日志、老回包不变)。
 */
export function noWindowWhy(front: FrontTrace, error: string): string {
  return front.window === 'no_window' && (front.woke ?? 0) > 0 ? `${error};${NO_WINDOW_GAVE_UP}` : error
}

/*
 * ★ **`traceOf` 也删了**(2026-10-02,同上):它只为「把 `front` 那一格摆进回包」而存在,
 * 而回包上那一格没有了(契约里 `JobResult` 没有它)。
 */
