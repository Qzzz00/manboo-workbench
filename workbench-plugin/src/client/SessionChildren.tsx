/**
 * 一条会话底下的后台任务 —— 主卡里多一层(2026-09-25,卡 Q;维护者:「这种后台任务,事务官是看不到的,我其实也不建议
 * 分开展示,卡片会非常多,事务官的卡片里可以改成一张卡片里有后台任务的说明,就是多一层的意思」)。
 *
 * 一行「内含 3 项后台任务 · 在跑 2 · 等你 1」;点「展开」才一项一行:派它时的那句描述 + 在跑 / 办完了 · 在做什么 · 几分钟前。
 * 不露它的 id、型号这类东西(维护者规矩第 3 条)。手机上同一套说法(butler-app 的 SessionDetail)。
 */
import { useState } from 'react'
import type { SessionChildView } from '../protocol.ts'
import { sessionChildLine, sessionChildrenLine } from '../protocol.ts'

export function SessionChildren({ items, now }: { items: readonly SessionChildView[] | undefined, now: string }) {
  const [open, setOpen] = useState(false)
  const line = sessionChildrenLine(items)
  if (items === undefined || line === undefined) return null
  return (
    <section className="ben-wb__session-children" aria-label="后台任务">
      <p className="ben-wb__session-children-line">
        <span>{line}</span>
        <button type="button" className="ben-wb__laid-link" aria-expanded={open} onClick={() => setOpen(value => !value)}>
          {open ? '收起' : '展开'}
        </button>
      </p>
      {open && (
        <ol className="ben-wb__session-children-list">
          {items.map(child => (
            <li key={child.id} data-status={child.status}>
              <span className="ben-wb__session-child-title">{child.title}</span>
              <small>{sessionChildLine(child, now)}</small>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}
