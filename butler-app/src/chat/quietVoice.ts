/**
 * 免打扰时段里**出不出声**,以及屏上那一行说什么(2026-09-26,卡 QH)。
 *
 * ## 为什么有这一份
 *
 * 09-26 00:19 冷启动 App,首页顶上出现「停止朗读」—— 半夜在念东西。免打扰时段(维护者设的 21:00–08:30)
 * 原来只有座机那条路听得懂:一通电话到点了只发通知不响铃。朗读压根不知道有这回事。
 *
 * 所以判断**不在这里**:工作台服务端算好了摆在 `/state.quiet`(`server/quietHours.ts`),手机只读结论。
 * 这一份只做两件小事,都是纯函数:
 *   1. 这一声**该不该出** —— 分「他刚按下的」与「自己冒出来的」两种;
 *   2. 屏上那一行**说什么** —— 一句人话,不带键名、不带时段以外的术语。
 *
 * ## 两条底线
 *
 * - **界面照常**:免打扰是不出声,不是不告诉他。字幕、气泡、卡片一个都不少,只是不念。
 * - **他按的不拦**:他自己点「重听 / 播放」就是他要听,那不是打扰(维护者原话:「他主动按下
 *   『播放 / 朗读』的,不拦」)。这一份只拦「自己冒出来的那一声」。
 */
import type { QuietView } from '../api/protocol';

/**
 * 此刻在免打扰时段里吗。
 *
 * **缺席 = 能出声**:老工作台没有这一格,那时候一切照旧 —— 宁可多念一句,也不替他把声音关掉
 * 让他以为 App 坏了(同服务端「时段读不出来就不静音」的纪律)。
 */
export function quietActive(quiet: QuietView | undefined): boolean {
  return quiet?.active === true;
}

/**
 * 这一声出不出。`byHim` = 他刚按下了「重听 / 播放」那一类键。
 *
 * 只有「免打扰时段里、又不是他按的」这一种不出声 —— 别的一律照出。
 */
export function mayMakeSound(quiet: QuietView | undefined, byHim: boolean): boolean {
  return byHim || !quietActive(quiet);
}

/**
 * 首页顶上那一行(替掉「停止朗读」的位置)。
 *
 * 「免打扰中 · 08:30 后恢复」—— 说清**此刻为什么没声**和**什么时候会有**。
 * 拿不到「几点恢复」时只说前半句,**不编一个时刻出来**。
 */
export function quietHushLabel(quiet: QuietView | undefined): string {
  const until = quiet?.until;
  return until === undefined || until === '' ? '免打扰中' : `免打扰中 · ${until} 后恢复`;
}

/**
 * 点了那一行之后飘出来的那句话:**为什么不出声、他还能怎么听、去哪儿改**。
 *
 * 点它本身不出声(它不是播放键) —— 这一句就是它全部的作用。
 * 时段两头拿得到就说出来(「晚上 9 点到早上 8 点半」这种他自己设的话最好认);拿不到就不编。
 */
export function quietWhyText(quiet: QuietView | undefined): string {
  const from = quiet?.from;
  const until = quiet?.until ?? quiet?.to;
  const span = from !== undefined && from !== '' && until !== undefined && until !== ''
    ? `${from} 到 ${until}`
    : '免打扰时段里';
  return `${span}不念出声:回答照样出字,想听就点「记录」里的「重听」。时段在设置里改(「座机」那一节)。`;
}
