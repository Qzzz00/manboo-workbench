/**
 * 界面上「相对日子」的参考时刻,只有这一个主人(2026-10-02,卡 claude/phone-clock)。
 *
 * 口径 2026-10-01 已拍板(docs/交接-1002-手机事项页今天分组.md):**凡是在屏上写
 * 「今天 / 昨天 / 几分钟前」的,参考的都是电脑的钟** —— `/state.now`,工作台每一拍填的
 * `new Date().toISOString()`;不是这台手机的墙钟。手机时区不同、钟歪了,同一屏上
 * 日分组的抬头和它底下每一行的时刻就会各说一套(那就是「办完 · 今天」隔天就红的根因)。
 *
 * 反过来,**参考系本来就是手机自己的那些不走这里**:手势计时、录音时长、重试窗口、
 * 手机文件系统的 mtime、凭证什么时候该换(判断用的就是手机的钟)。哪几处、为什么,
 * 见 docs/交接-1002-手机相对日子按工作台的钟.md 的清单。
 *
 * 读不出来才退回手机的钟:还没连上时 `emptyState().now` 是空字符串,总得有个参考 ——
 * 但这条退路只在「还没连上」那一瞬成立,不该是任何一处的常态。
 */

/** `/state.now` 是字符串;毫秒数与 `Date` 是为了测试与老调用方。 */
export type NowRef = string | number | Date | undefined;

export function clockOf(now: NowRef): Date {
  if (now === undefined) return new Date();
  const at = now instanceof Date ? now : new Date(now);
  return Number.isNaN(at.getTime()) ? new Date() : at;
}
