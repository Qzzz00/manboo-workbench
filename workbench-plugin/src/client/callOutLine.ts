/**
 * 「这件事给他打过电话吗、他接了没有」(2026-09-21,座机主动来电)。
 *
 * 一个纯函数,给事务官面板上那张卡用。**只转述台账,不自己判断** ——
 * 「打没打过」是服务端 `/state.call_out` 里记着的事实(server/callOut.ts),
 * 界面再算一遍就会有两份真相,而只有其中一份是对的。
 *
 * 缺席的三种情况**都不写字**(D13:不知道就不填):
 *   - 这台工作台没接主动来电(`call_out` 整块缺省);
 *   - 这件事没打过电话;
 *   - 那一通还排着(`queued`)—— 「即将打电话」不是一件发生过的事。
 */
import type { CallOutEntry, WorkbenchState } from '../protocol.ts'
import { CALL_OUT_FAIL_KIND_TITLES, CALL_OUT_STATE_TITLES, callOutFailKindOf } from '../protocol.ts'

function hhmm(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

/** 这件事最近那一通(台账最近的在前,所以第一条就是)。没打过就 undefined。 */
export function lastCallOut(state: WorkbenchState, itemId: string | undefined): CallOutEntry | undefined {
  if (itemId === undefined || itemId === '') return undefined
  return (state.call_out?.entries ?? []).find(entry =>
    entry.item_id === itemId || (entry.merged ?? []).some(one => one.item_id === itemId))
}

/**
 * 卡上那一行。「打过电话:已接 14:03」/「打过电话:未接 14:03」。
 *
 * 「正在响」也写(`ringing`):那一刻他的座机就在他面前响着,电脑上跟着说一句是对的。
 * 「排队中」不写 —— 见文件头。
 */
export function callOutLine(state: WorkbenchState, itemId: string | undefined): string | undefined {
  const entry = lastCallOut(state, itemId)
  if (entry === undefined || entry.state === 'queued') return undefined
  const at = hhmm(entry.ended_at ?? entry.ringing_at ?? entry.queued_at)
  /**
   * 只发了通知的那一通**不说「打过电话」**(2026-09-22,A1 之后这是常态:
   * 「完成」那一类缺省就走通知)。它压根没响过 —— 写成「打过电话:只发了通知」
   * 是在说一件没发生的事,而他会去找那通没接到的电话。
   */
  if (entry.state === 'notified') return `只发了通知${at === '' ? '' : ` ${at}`}`
  /**
   * 「没打出去」只说技术失败那一种(2026-10-12)。她停了铃、已无需再打、认不出的,各说各的,
   * 也都不说「打过电话」—— 那几通压根没响。
   */
  const failKind = callOutFailKindOf(entry)
  if (failKind !== undefined && failKind !== 'tech') return `${CALL_OUT_FAIL_KIND_TITLES[failKind]}${at === '' ? '' : ` ${at}`}`
  return `打过电话:${CALL_OUT_STATE_TITLES[entry.state]}${at === '' ? '' : ` ${at}`}`
}
