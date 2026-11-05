/**
 * 右下角的小对话气泡(设计稿 3.7;维护者 10-21:「像网页上的客服,也可以放大」)。
 *
 * **不建第二个聊天窗**:这就是今天的事务官输入口,多带一样东西 —— 当前便签。
 * - 选中的便签挂着事务官那条还开着的会话 → `/butler/item/say`(捎进那条会话);
 * - 否则 → `/butler/item`,带 `refs:[{kind:'item', id}]`(统一输入框的「引用」,事务官第一句里就有这张便签的标题与状态);
 * - 什么都没选 → 就是一句普通的交代。
 * 她能做的就是今天事务官能做的(建便签、改章、改负责人、派活、挪目标),走今天的接口,不开新的写入口。
 * 「放大」= 打开这张便签的弹窗,滚到留言与等你的那两块。
 */
import { useState } from 'react'
import type { TaskView } from '../../protocol.ts'
import type { CollabApi } from './collabApi.ts'

export function ChatBubble({ note, api, onReceipt, onExpand, onClose }: {
  note?: TaskView | undefined
  api: CollabApi
  onReceipt: (text: string) => void
  onExpand?: (() => void) | undefined
  /** 收起(开关在底栏那颗「跟事务官说一件事」上)。 */
  onClose: () => void
}) {
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const send = async (): Promise<void> => {
    const said = text.trim()
    if (said === '' || sending) return
    setSending(true)
    const live = note?.conversation !== undefined && note.conversation.archived_at === undefined
    const got = note !== undefined && live
      ? await api.post('/butler/item/say', { id: note.id, text: said })
      : await api.post('/butler/item', { text: said, ...(note === undefined ? {} : { refs: [{ kind: 'item', id: note.id }] }) })
    setSending(false)
    // 没建下来不清掉他打的字:那句话还在他手里(同事务官档输入框的老纪律)。
    if (!got.ok) { onReceipt(got.error ?? '没送到事务官那里'); return }
    setText('')
    onReceipt(typeof got.body.note === 'string' ? got.body.note : '交给事务官了')
  }
  return (
    <div className="ben-cl__bubble" role="dialog" aria-label="跟事务官说">
      <div className="ben-cl__bubble-head">
        <span>{note === undefined ? '正在说:整块板' : `正在说:${note.title}`}</span>
        {note !== undefined && onExpand !== undefined && <button type="button" onClick={onExpand}>放大</button>}
        <button type="button" aria-label="收起" onClick={onClose}>✕</button>
      </div>
      <textarea
        aria-label="对事务官说"
        value={text}
        rows={3}
        placeholder={note === undefined ? '交代一件事,或者问一句' : '对这张便签说一句:改章、换人、派出去、补验收……'}
        onChange={event => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void send() }
        }}
      />
      <button type="button" className="ben-cl__bubble-send ben-cl__primary" disabled={text.trim() === '' || sending} onClick={() => { void send() }}>
        {sending ? '在送' : '发给事务官'}
      </button>
    </div>
  )
}
