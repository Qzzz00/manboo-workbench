/**
 * 卡片弹窗里「停在哪」那一块(2026-10-12,卡「没办完的事项说清楚」)。
 *
 * 只转述 /state 上那一格(`TaskView.standing`,服务端按证据现算,`server/itemStanding.ts`):
 * 最后一条证据(什么 · 来源 · 时刻)、在等谁、下一步。四种要分开说的那几种带「继续 / 关掉 / 重派」,
 * 各走哪个现有入口由 protocol 的 `itemStandingRequest` 一处定(手机同一张表)。
 * 「继续」在那几种里是「打开这件」—— 弹窗里她已经在这件里了,那颗不画;没接线的那颗也不画(D13)。
 */
import { useState } from 'react'
import type { ItemStandingAction, TaskStatus, TaskView } from '../protocol.ts'
import {
  ITEM_EVIDENCE_SOURCE_TITLES, ITEM_STANDING_ACTION_TITLES, ITEM_STANDING_CASE_TITLES,
  assigneeName, friendlyWhen, itemStandingRequest, standingWaitingText,
} from '../protocol.ts'

export function StandingBlock({ task, now, onMove, drive }: {
  task: TaskView
  now?: string | undefined
  onMove?: ((id: string, status: TaskStatus) => void) | undefined
  drive?: ((id: string) => Promise<string>) | undefined
}) {
  const [busy, setBusy] = useState(false)
  const [receipt, setReceipt] = useState<string | undefined>(undefined)
  const standing = task.standing
  if (standing === undefined) return null

  const buttons = (standing.actions ?? []).flatMap((action: ItemStandingAction) => {
    const request = itemStandingRequest(task.id, standing.case, action)
    if ('open' in request) return []
    if (request.path === '/task/move') {
      if (onMove === undefined) return []
      const status = request.body.status
      return [{ action, run: () => onMove(task.id, status) }]
    }
    if (drive === undefined) return []
    return [{
      action,
      run: () => {
        setBusy(true)
        setReceipt(undefined)
        void drive(task.id)
          .then(text => setReceipt(text))
          .catch(() => setReceipt('工作台服务没应答,稍后再试'))
          .finally(() => setBusy(false))
      },
    }]
  })
  const last = standing.last
  const at = last === undefined ? '' : friendlyWhen(last.at, now)

  return (
    <section className="ben-wb__item-standing" aria-label="停在哪" data-case={standing.case}>
      <h4>停在哪:{ITEM_STANDING_CASE_TITLES[standing.case]}{standing.stalled === true && standing.idle_days !== undefined ? ` · 停了 ${standing.idle_days} 天` : ''}</h4>
      {last === undefined
        ? <p className="ben-wb__item-when">还没有能说清它停在哪的记录</p>
        : <p className="ben-wb__item-line">最后一条:{last.what}({ITEM_EVIDENCE_SOURCE_TITLES[last.source]}{at === '' ? '' : ` · ${at}`})</p>}
      <p className="ben-wb__item-mover">{standingWaitingText(standing, standing.agent === undefined ? undefined : assigneeName(standing.agent))}</p>
      <p className="ben-wb__item-line">下一步:{standing.next}</p>
      {buttons.length > 0 && (
        <div className="ben-wb__item-acts">
          {buttons.map(one => (
            <button key={one.action} type="button" disabled={busy} data-primary={one.action === 'continue' ? 'true' : undefined} onClick={one.run}>
              {ITEM_STANDING_ACTION_TITLES[one.action]}
            </button>
          ))}
        </div>
      )}
      {receipt !== undefined && <p className="ben-wb__item-when" role="status">{receipt}</p>}
    </section>
  )
}
