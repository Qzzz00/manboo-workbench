/**
 * 便签来往速览(2026-10-24,小K collab-desktop-1024;设计 3.6「悬浮可速览,点击可详情」)。
 *
 * 悬浮这一层和便签详情(NoteDialog)挂同一个 `NoteTalk` —— 同一份活动记录、同一个
 * localStorage 草稿键,不存在两套留言。这里多给一行最近回执,和「打开详情」的入口。
 */
import { RECEIPT_TITLES } from '../../protocol.ts'
import type { TaskView } from '../../protocol.ts'
import type { CollabApi } from './collabApi.ts'
import type { RailCard } from './collabModel.ts'
import { receiptBody } from './collabModel.ts'
import { NoteTalk } from './NoteTalk.tsx'

export function NoteQuickView({ task, cards, api, onOpen, onClose, onOpenTask }: {
  task: TaskView
  cards: readonly RailCard[]
  api: CollabApi
  /** 打开完整详情(同一张便签)。 */
  onOpen: (task: TaskView) => void
  onClose: () => void
  onOpenTask?: ((id: string) => void) | undefined
}) {
  const count = (task.messages?.length ?? 0) + (task.comments?.length ?? 0)
  return (
    <div className="ben-cl__quickview" role="dialog" aria-label={`${task.title} 的来往速览`}>
      <div className="ben-cl__quickview-head">
        <b>{task.title}</b>
        {task.receipt !== undefined && <small className="ben-cl__muted">最近回执 · {RECEIPT_TITLES[task.receipt.kind]}:{receiptBody(task.receipt.text)}</small>}
        <span className="ben-cl__spacer" />
        <button type="button" className="ben-cl__link" onClick={() => onOpen(task)}>打开详情</button>
        <button type="button" aria-label="关上速览" onClick={onClose}>✕</button>
      </div>
      {count === 0 && <p className="ben-cl__muted">还没有来往;写一句,发前看得见请谁处理。</p>}
      <NoteTalk task={task} cards={cards} api={api} onReceipt={() => {}} onOpenTask={onOpenTask} />
    </div>
  )
}
