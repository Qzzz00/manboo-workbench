/**
 * 窗位槽 / 系统文件夹里那行红字(2026-09-18)。
 *
 * 在这一版之前,这两处各自拼一句:窗位槽是「未接入:辅助功能未授权」,系统文件夹是
 * 「贴不了 Finder:辅助功能未授权」—— 两句都只是把壳报来的 `helper.reason` 原样接在
 * 一个前缀后面,而那个 reason 是**一个词**,既没说要怎么办,也不知道 Ben 这台机器上
 * 真正发生的是"记录旧了"而不是"没给过"。任务卡:「窗位槽红字与『去授权』按钮同一句」。
 *
 * 所以这一版:前缀各留各的(两块区域可能同时不可用,两条一模一样的横幅并排出现时
 * 读者分不清是谁在说话 —— 09-09 那条老注释),**后半句与那颗按钮跟顶上那条横幅共用**
 * 同一份 accessNotice。
 *
 * 类名独占 `ben-wb__accessnote*`(见 accessNoteStyle.ts),不蹭 `ben-wb__needbar*`:
 * 那是顶上那条细横幅的排布,这一句长在红框里。
 */
import type { AccessNotice } from './accessNotice.ts'

export function AccessWarn({ prefix, notice, onAuthorize, error }: {
  /** 「未接入」/「贴不了 Finder」—— 这一句是谁在说话。 */
  prefix: string
  notice: AccessNotice
  /** 「去授权」按下去。**不给就不画按钮**(那句话照出)—— 同 EmptyState 的先例:
   *  画一颗按下去什么也办不成的按钮就是骗人。 */
  onAuthorize?: () => void
  /** 打不开系统设置时的原因原文。 */
  error?: string | null
}) {
  return (
    <p className="ben-wb__slot-warn ben-wb__accessnote" role="status" data-kind={notice.kind}>
      <span className="ben-wb__accessnote-line">{prefix}:{notice.line}</span>
      {onAuthorize !== undefined && (
        <button type="button" className="ben-wb__accessnote-go" onClick={onAuthorize}>{notice.action}</button>
      )}
      {error !== undefined && error !== null && <span className="ben-wb__accessnote-err">{error}</span>}
    </p>
  )
}
