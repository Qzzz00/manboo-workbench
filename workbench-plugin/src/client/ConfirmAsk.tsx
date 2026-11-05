/**
 * 办完了等他确认的那一件 —— 摆在球下那一区,与问你的、要你批的同一张表(2026-09-25,卡 M 追加)。
 *
 * 统筹:「还有 N 件要你看」「等你 n」「事务官」标签上的数、手机「等你确认」数的必须是同一堆、同一个数
 * (只有他能做的:要他答、要他批、要他验收确认)。以前球下那一区只摆前两样,「等你 n」却连待确认的一起数 ——
 * 真机上「等你 7」底下写着「还有 2 件要你看」。现在待确认的也进这一区:一句话 +「确认收下」+「看看」(在工作台里摊开那一件)。
 *
 * 两种摆法:`card` 整张;`row` 收成一行(「「…」办完了,等你确认 · 看看」)。
 */
import type { ReactNode } from 'react'
import { confirmRowText } from './askModel.ts'
import type { OwnerAsk } from '../protocol.ts'
import { OWNER_ASK_TITLES } from '../protocol.ts'

export interface ConfirmAskProps {
  taskId: string
  title: string
  /** 「1 件交付物」这类(收件箱里那一句)。 */
  note?: string | undefined
  /**
   * 事务官标好的四类拍板请求(2026-10-26,卡「事务官页接管队列」):类别 + 方案 + 依据。
   * 有它这张卡才带「确认收下」;缺席说明还在事务官核验队列,不该摆到这一区(服务端「等你」堆已滤过)。
   */
  ask?: OwnerAsk | undefined
  variant?: 'card' | 'row'
  onConfirm(taskId: string): void
  onLook(taskId: string): void
}

export function ConfirmAsk({ taskId, title, note, ask, variant = 'card', onConfirm, onLook }: ConfirmAskProps): ReactNode {
  if (variant === 'row') {
    return (
      <>
        <span className="ben-wb__askrow-text">{confirmRowText(title)}</span>
        <button type="button" className="ben-wb__laid-link ben-wb__askrow-open" onClick={() => onLook(taskId)}>看看</button>
      </>
    )
  }
  return (
    <div className="ben-wb__cask" role="group" aria-label={`「${title}」办完了,等你确认`}>
      <p className="ben-wb__cask-head">办完了,等你确认</p>
      <p className="ben-wb__cask-title">{title}</p>
      {note !== undefined && note !== '' && <p className="ben-wb__cask-note">{note}</p>}
      {ask !== undefined && (
        <div className="ben-wb__cask-ask">
          <p><small>要拍板</small>{OWNER_ASK_TITLES[ask.kind]}</p>
          <p><small>方案</small>{ask.proposal}</p>
          <p><small>依据</small>{ask.basis}</p>
        </div>
      )}
      <div className="ben-wb__cask-acts">
        <button type="button" className="ben-wb__cask-yes" aria-label={`确认收下「${title}」`} onClick={() => onConfirm(taskId)}>确认收下</button>
        <button type="button" className="ben-wb__cask-look" onClick={() => onLook(taskId)}>看看</button>
      </div>
    </div>
  )
}
