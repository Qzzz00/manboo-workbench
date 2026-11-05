/** 同事项的草稿与未确认动作。请求先持久化，再发送；确认只清它对应的版本。 */
import type { NoteMessageIntent } from '../../protocol.ts'
export interface ReplyTarget { kind: 'message' | 'comment' | 'receipt', id?: string, by: string, text: string, at: string }
export interface PendingNote {
  revision: number
  reply?: ReplyTarget | undefined
  body: { task_id: string, client_msg_id: string, text: string, intent: NoteMessageIntent, mentions?: string[], reply_to?: string }
  error?: string
}
export interface NoteComposer { version: 1, revision: number, text: string, reply?: ReplyTarget | undefined, pending: PendingNote[] }
export const composerKey = (taskId: string): string => `ben-wb.note-draft.${taskId}`
const EVENT = 'ben-wb.note-composer'
export function readComposer(taskId: string): NoteComposer {
  const empty: NoteComposer = { version: 1, revision: 0, text: '', pending: [] }
  try {
    const raw = window.localStorage.getItem(composerKey(taskId))
    if (raw === null) return empty
    const saved = JSON.parse(raw) as unknown
    if (typeof saved === 'string') return { ...empty, text: saved }
    if (saved !== null && typeof saved === 'object') {
      const value = saved as NoteComposer
      if (value.version === 1 && Number.isSafeInteger(value.revision) && typeof value.text === 'string' && Array.isArray(value.pending)) return value
    }
  } catch { /* 老草稿不可读不伪造待确认请求。 */ }
  return empty
}
export function changeComposer(taskId: string, change: (current: NoteComposer) => NoteComposer): NoteComposer {
  const next = change(readComposer(taskId))
  // 写不下时抛错：不能在没保住请求身份的情况下启动副作用。
  window.localStorage.setItem(composerKey(taskId), JSON.stringify(next))
  window.dispatchEvent(new window.CustomEvent(EVENT, { detail: taskId }))
  return next
}
export function watchComposer(taskId: string, changed: () => void): () => void {
  const local = (event: Event): void => { if ((event as CustomEvent<string>).detail === taskId) changed() }
  const storage = (event: StorageEvent): void => { if (event.key === composerKey(taskId) || event.key === null) changed() }
  window.addEventListener(EVENT, local)
  window.addEventListener('storage', storage)
  return () => { window.removeEventListener(EVENT, local); window.removeEventListener('storage', storage) }
}
