/**
 * ★ **电脑锁着屏时,窗口型的家送不进 —— 认出来、如实说、排队等解锁**(2026-10-03,
 * 卡「锁屏时窗口型的家送不进」;设计 `docs/设计-一条引擎替八条管线-2026-10-02.md` 第二节那张表)。
 *
 * 现场(维护者那台,2026-10-03 09:04):她在手机「等你确认」里给 Kimi 那条会话回了一句。
 * 工作台日志 7 秒内 `[开App] com.moonshot.kimichat ← open -b` **五次**,最后一句
 * `not_sent · answer_send · 找不到窗口:com.moonshot.kimichat 在跑,但一扇标准窗口都没有`。
 * 10:30 她人在电脑前再试就成了;10:38 把 Kimi 藏到后台(`isHidden=true`)再捎一句也 6 秒送到。
 * **唯一的差别是 09:04 那会儿电脑锁着屏**(`pmset displaysleep 10` + 显示器一睡就锁)。
 *
 * 所以这一份只放三样,**全仓一处**:
 * ① 壳那句原话是不是「锁着屏」那一类({@link isScreenLockedReason});
 * ② 跟她说的那**一句**人话({@link screenLockedSay})—— 手机「等你确认」/「最近会话」的回包、
 *    电话里那句、`jobs.jsonl` 账上那一行,**三处同一个常量**(卡上第 3 条);
 * ③ 这件事排队时账上记哪一步(`jobLog` 的 `waiting`,不是 `not_sent` ——
 *    记 `not_sent` 会让四步表上出现一个不是事实的收场,闸还会据此判「收场了不动」,
 *    解锁之后那一下就再也送不出去了)。
 *
 * **排队的那一本在 `engine/lockQueue.ts`**(落盘、原顺序、重启不丢);
 * **问壳「这一刻锁没锁」的那一拍在 `screenLockWatch.ts`**;
 * **壳那一侧**认锁屏、换文案、带 `screen_locked` 那一格在 `workbench-app/Sources/ScreenLockPolicy.swift`。
 */

/**
 * ★ **壳那句话里认得出「锁着屏」的那一截字**。
 *
 * 与壳 `ScreenLockPolicy.marker` **同一个字符串**(`tests/screen-lock-shell-text.test.ts`
 * 读那个 Swift 文件比对 —— 不写「逐字相同」的注释代替测试)。
 *
 * 为什么靠一截字认、而不是靠回包上那一格:`helperChannel` 在 `ok:false` 时**reject 一个 Error**,
 * 回包里别的格一个都带不过来 —— 服务端这一侧收到的只有 `error` 那句原话。
 * 口径同 `dispatchClient.classifyFailure`(那一处本来就是按壳的原话归类的)。
 */
export const SCREEN_LOCK_MARK = '电脑锁着屏'

/** 壳这一句是不是「锁着屏,窗口型的家送不进」那一类。 */
export function isScreenLockedReason(reason: string): boolean {
  return reason.includes(SCREEN_LOCK_MARK)
}

/**
 * ★ **跟她说的那一句**(手机、电话、账上那一行**同一个出处**)。
 *
 * 三件事一句话说清,缺一件她就得自己猜:
 * ① **为什么没送**:电脑锁着屏 —— 不是那一家坏了(09:04 她看到的那句「一扇标准窗口都没有」
 *    会让她去查 Kimi,这是误导);
 * ② **接下来怎么办**:排上了 / 还没排上两种说法不一样 —— **许了才说得出「我会送」**;
 * ③ **现在就要办的话走哪条路**:协议型那几家不经窗口,锁着屏照样送得进。
 *    那几家的名字**由登记处现查**(`registry.all()` 里 `via:'protocol'` 的那几条)——
 *    这个文件里一个 App 的名字都不写死(同窗口适配器那条纪律)。
 */
export function screenLockedSay(input: {
  /** 这一家叫什么(人话;「豆包办公」而不是 `com.work.pc.doubao`)。 */
  agentName: string
  /** 这一件**真排上队了**没有(排上了才许说「解锁了我就送」)。 */
  queued: boolean
  /**
   * 排着的是什么:她那句话(缺省)还是一件派活(2026-10-12 派活也排队)。
   * 只换一个说法 ——「这句送进去」放在派活上不是实话(解锁后是整件重派,不是把一句话塞进某段对话)。
   */
  what?: 'say' | 'dispatch'
  /** 这台电脑上**不靠窗口**的那几家(人话名;空 = 这句不说)。 */
  protocols?: readonly string[]
}): string {
  const next = !input.queued ? '解锁了再叫我一次' : input.what === 'dispatch' ? '解锁了我就把这件派出去' : '解锁了我就把这句送进去'
  const others = (input.protocols ?? []).filter(one => one.trim() !== '')
  const tail = others.length === 0 ? '' : `;要现在就办,只能${others.join(' / ')}这种不靠窗口的家`
  /*
   * ★ 只说**量到的**那一件事:锁着屏的时候那扇窗列不出来。
   * **不许说「它还在跑」** —— 这一下是在碰壳之前就拦下的(一个 op 都没发),
   * 那一家开着没开着我们这会儿压根不知道(D13:不编一个)。
   */
  return `${SCREEN_LOCK_MARK},窗口型的家这会儿送不进 —— 锁着屏的时候${input.agentName}的窗口一扇都列不出来。${next}${tail}`
}

/**
 * **只读那几下**撞上锁屏时说的那一句(读回话 / 看权限弹框 / 把那段开到她眼前)。
 *
 * 与上面那一句分开:读不到**不许说成「它还没回」**(契约 `AdapterReadResult` 那一条纪律),
 * 而且读一眼这件事没有「排队等解锁」可言 —— 下一拍她解锁了自然就读到了。
 */
export function screenLockedReadSay(agentName: string): string {
  return `${SCREEN_LOCK_MARK},读不到${agentName}的窗口(锁屏时辅助功能一扇窗都列不出来)—— 不是它没回`
}

/**
 * 壳回包里那一格的名字(`screen_info` / `app_info` 那几个只读 op 不管锁没锁都带着它;
 * 与壳 `ScreenLockPolicy.field` 同一个字符串,有对照用例)。
 */
export const SCREEN_LOCKED_FIELD = 'screen_locked'

/**
 * 壳那一条只读回包里「这一刻锁没锁」。
 * **缺席 = 不知道**(老壳不认这一格)→ `undefined`,按「没锁」办事(一字不变,不编一个)。
 */
export function screenLockedOf(result: Record<string, unknown> | undefined): boolean | undefined {
  const value = result?.[SCREEN_LOCKED_FIELD]
  return typeof value === 'boolean' ? value : undefined
}
