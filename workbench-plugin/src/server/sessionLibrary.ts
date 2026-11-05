/**
 * 手机读对话的那几个口,拼成一个(2026-10-01,手机读对话卡):
 *
 *   GET /sessions/history      各家最近的对话(sessionHistory.ts)
 *   GET /sessions/transcript   一条对话的完整内容,往上翻分页(sessionTranscript.ts)
 *   GET /sessions/attachment   对话里的附件,按需取、分块(sessionAttachments.ts)
 *
 * 门同 `/sessions/digest`(本机或已配对的手机);都是**当场读**会话记录,不经模型、不落盘、不进 /state
 * (设计-重构-接缝与技术债:别往 /state 里塞大块数据)。
 */
import type { SessionAttachmentChunk, SessionAttachmentInfo, SessionHistoryView, SessionTranscriptView } from '../protocol.ts'
import type { AttachmentFile, AttachmentQuery } from './sessionAttachments.ts'
import type { SessionHistoryQuery } from './sessionHistory.ts'
import type { TranscriptQuery } from './sessionTranscript.ts'

export type LibraryResult<T> = { ok: true, value: T } | { ok: false, status: number, error: string }

export interface SessionLibrary {
  history: (query: SessionHistoryQuery) => Promise<SessionHistoryView>
  transcript?: (query: TranscriptQuery) => Promise<LibraryResult<SessionTranscriptView>>
  attachment?: (query: AttachmentQuery) => Promise<LibraryResult<SessionAttachmentInfo | SessionAttachmentChunk>>
  /**
   * `view=keep`:这个附件在电脑上的那个文件,交给取件单那一套存到手机上(2026-10-04)。
   * 压缩包、设计稿、几百 MB 的视频这一类在手机上看不了全的,她点一下就能把原件拿到手机里。
   */
  attachmentFile?: (query: Pick<AttachmentQuery, 'agent' | 'id' | 'ref'>) => Promise<LibraryResult<AttachmentFile>>
}
