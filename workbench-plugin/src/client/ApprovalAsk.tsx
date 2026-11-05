/**
 * 事务官要做一件得你批的事 —— 说人话的那一张(2026-09-25,卡 M)。
 *
 * 维护者 09-25:「现在它有很多要我给权限的,它也不弹出来……」;卡上写的是
 * 「escalate sandbox to danger-full-access: headless Chrome 要写……」—— 底层原话。现在服务端翻好了:
 *   - 她要做什么(`say`)、为什么(`why`,术语换成人话)、放开到多大(`scope`,维护者:「要提档到最高的,仍然要问,且说清范围」);
 *   - 三颗键:「不行」「允许这一次」,分得出类的再多一颗「这件事里<那一类>都允许」(同一件事里同类的不再一条条问,在事项里能收回);
 *   - 底层原话与那条命令收进「看原始」(开发者用,平时收着)。
 * 服务端老版本没有 `say` 时退回 `reason ?? tool`(老样子)。
 */
import { useState } from 'react'
import type { PendingApprovalView } from '../protocol.ts'
import { answerApprovalScoped } from './askApi.ts'
import { approvalRowText, askSubject, dispatchApprovalFace } from './askModel.ts'

export interface ApprovalAskProps {
  approval: PendingApprovalView
  baseUrl: string
  fetchImpl: typeof fetch
  variant?: 'card' | 'row' | 'inline'
  onExpand?: () => void
  onReceipt?: (text: string) => void
}

export function ApprovalAsk({ approval, baseUrl, fetchImpl, variant = 'card', onExpand, onReceipt }: ApprovalAskProps) {
  const [busy, setBusy] = useState(false)
  const [rawOpen, setRawOpen] = useState(false)
  // 各家额度默认收起(卡 UX):展开才一家一行。只显示被选中那家的那一格。
  const [quotaOpen, setQuotaOpen] = useState(false)
  if (variant === 'row') {
    return (
      <>
        <span className="ben-wb__askrow-text">{approvalRowText(approval)}</span>
        {onExpand !== undefined && <button type="button" className="ben-wb__laid-link ben-wb__askrow-open" onClick={onExpand}>展开</button>}
      </>
    )
  }
  const answer = (allow: boolean, scope?: 'kind'): void => {
    if (busy) return
    setBusy(true)
    void answerApprovalScoped(baseUrl, fetchImpl, approval.id, allow, scope).then((result) => {
      setBusy(false)
      if (!result.ok) { onReceipt?.(result.error); return }
      if (scope === 'kind') {
        const merged = result.merged !== undefined && result.merged > 0 ? `,同类的另外 ${result.merged} 条也一起放行了` : ''
        onReceipt?.(`记下了:这件事里${result.granted ?? '同类的'}都允许${merged}。后面同类的不再问你,在这件事里能收回。`)
        return
      }
      onReceipt?.(allow ? '批了,接着办' : '没批,它会换个办法,或者停下来问你')
    })
  }
  /** 大字第一行、收起来那一行、「允许」那颗键上的字(卡 UX,2026-09-28):字在 src/waiting.ts,电脑与手机同一句。 */
  const face = dispatchApprovalFace(approval)
  const say = face.headline
  const raw = approval.raw
  const hasRaw = raw !== undefined && (raw.reason !== undefined || raw.command !== undefined)
  return (
    <div className="ben-wb__aask" data-variant={variant} role="group" aria-label={`${askSubject(approval.task_title)}要你批一件事`}>
      {variant === 'card' && <p className="ben-wb__aask-head">{askSubject(approval.task_title, 24)}要你批一件事</p>}
      <p className="ben-wb__aask-say" data-head={face.chosen !== undefined ? 'true' : undefined}>{say}</p>
      {approval.why !== undefined && <p className="ben-wb__aask-why">为什么:{approval.why}</p>}
      {approval.scope !== undefined && <p className="ben-wb__aask-scope">{approval.scope}</p>}
      {/*
        派活前那一问(卡 O):能派给的几家。**默认只摆这次问的那一家**(卡 UX,2026-09-28):
        从前一整面各家额度压在正文里,「派给谁」只剩最上面一小行灰字 —— 他照着列表第一行那件事点了「允许这一次」。
        别家收起成一行,点「展开看额度」才一家一行(一个字没少,只是不再抢这一问的位置)。
      */}
      {face.chosen !== undefined && (
        <ul className="wb-approvals__options" aria-label="这次问的那一家">
          <li data-state={face.chosen.state} data-chosen data-stale={face.chosen.stale === true ? 'true' : undefined}>
            <b>{face.chosen.family === 'dsh' ? '事务官自己做' : face.chosen.title}</b>
            <span>{face.chosen.quota}</span>
          </li>
        </ul>
      )}
      {face.othersLine !== undefined && (
        <p className="ben-wb__aask-others">
          {face.othersLine}{' '}
          <button type="button" className="ben-wb__aask-raw-toggle" aria-expanded={quotaOpen} onClick={() => setQuotaOpen(open => !open)}>
            {quotaOpen ? '收起额度' : '展开看额度'}
          </button>
        </p>
      )}
      {quotaOpen && face.others.length > 0 && (
        <ul className="wb-approvals__options" aria-label="能派给的几家">
          {face.others.map(option => (
            <li key={option.family} data-state={option.state} data-stale={option.stale === true ? 'true' : undefined}>
              <b>{option.family === 'dsh' ? '事务官自己做' : option.title}</b>
              <span>{option.quota}</span>
            </li>
          ))}
        </ul>
      )}
      {face.chosen === undefined && approval.options !== undefined && approval.options.length > 0 && (
        <ul className="wb-approvals__options" aria-label="能派给的几家">
          {approval.options.map(option => (
            <li key={option.family} data-state={option.state} data-stale={option.stale === true ? 'true' : undefined}>
              <b>{option.family === 'dsh' ? '事务官自己做' : option.title}</b>
              <span>{option.quota}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="ben-wb__aask-acts">
        <button type="button" className="ben-wb__aask-yes" disabled={busy} onClick={() => answer(true)}>{face.yes}</button>
        {approval.kind !== undefined && (
          <button type="button" className="ben-wb__aask-kind" disabled={busy} onClick={() => answer(true, 'kind')}>这件事里{approval.kind.title}都允许</button>
        )}
        <button type="button" className="ben-wb__aask-no" disabled={busy} onClick={() => answer(false)}>不行</button>
        {hasRaw && (
          <button type="button" className="ben-wb__aask-raw-toggle" aria-expanded={rawOpen} onClick={() => setRawOpen(open => !open)}>
            {rawOpen ? '收起原始' : '看原始'}
          </button>
        )}
      </div>
      {rawOpen && hasRaw && (
        <pre className="ben-wb__aask-raw" aria-label="原始请求(开发者用)">{[raw?.reason, raw?.command].filter((line): line is string => line !== undefined).join('\n\n')}</pre>
      )}
    </div>
  )
}
