/**
 * ★ **按「送进去那句」在会话记录里找那一轮,收尾了才取正文**(2026-10-12,卡「Claude与Kimi收回答读记录」;
 * 根治方案 `docs/设计-各家在不在跑以它自己的记录为准-2026-10-08.md` 第一级,接法照千问那张卡)。
 *
 * 有会话记录文件的那几家(Claude 的 `<id>.jsonl`、Kimi 的 `wire.jsonl`),派活 / 捎话收回答从这里判与取:
 * 窗口被窗口槽藏起来时读窗读到的是旧画面,记录文件不受这件事影响。
 *
 * - **解析只有一份**:`sessionDigest.turnsOf`(会话流、「等你」、完整对话读的都是它);这里只在它的输出上判;
 * - **那一句** = 她说的(`ask`)里含记号的最新一句;**那一轮** = 它之后、她下一句之前的那几段回话;
 * - **收尾** = 那一轮里有一段是最终回答(`final`:Claude `end_turn`、Kimi 这一步 `end_turn`)→ 取那一段;
 *   她后来又说了一句 / 记录停在掐断、报错上 → 收了、`stopped`,有字给最后那段;否则 = 在跑,不给半截;
 * - 判断里不写包名、不写家名:哪一家、读哪几条会话由 `agentRecords.RECORD_SOURCES` 那一行交进来。
 */
import type { AgentRecordReply } from './agentRecords.ts'
import { readHeadTail, turnsOf, type SessionMark, type SessionTurn, type SessionTurns } from './sessionDigest.ts'
import type { SessionFileRef } from './sessionHistory.ts'
import { countSaid } from './sessionSaid.ts'

/** 读尾巴读多长:一轮里工具输出很长时,我们那一句也得还在窗口里。 */
export const TRANSCRIPT_REPLY_TAIL_BYTES = 1024 * 1024
/** 读开头读多长:派活开的新对话,那一句就在开头。 */
export const TRANSCRIPT_REPLY_HEAD_BYTES = 256 * 1024
/** 没指名会话时,最多翻这一家最近动过的几条。 */
export const TRANSCRIPT_REPLY_CANDIDATES = 8

/** 会话流里的一条(`/state.sessions` 的子集)。 */
export interface TranscriptSessionLike {
  agent: string
  session_id: string
  updated_at?: string
}

/** 读会话记录要的两样:这一家此刻有哪几条会话、按会话号找记录文件。 */
export interface TranscriptAccess {
  sessions: () => readonly TranscriptSessionLike[]
  locate: (agent: string, sessionId: string) => Promise<SessionFileRef | undefined>
}

/**
 * 我们那一句**之后**的那几条原文 → 这一轮收了没有、正文是什么。
 * `mark` 是整份记录最后停在哪儿,只在这一轮就是最后一轮时才算数。
 */
export function turnReplyOf(after: readonly SessionTurn[], mark: SessionMark | undefined): Extract<AgentRecordReply, { found: true }> {
  const nextAsk = after.findIndex(one => one.k === 'ask')
  const replies = (nextAsk < 0 ? after : after.slice(0, nextAsk)).filter(one => one.k === 'reply')
  const final = [...replies].reverse().find(one => one.final === true)?.text.trim()
  if (final !== undefined && final !== '') return { found: true, status: 'done', reply: final }
  const last = replies.at(-1)?.text.trim()
  const text = last === undefined || last === '' ? {} : { reply: last }
  if (nextAsk >= 0 || mark === 'aborted' || mark === 'failed') return { found: true, status: 'done', stopped: true, ...text }
  if (mark === 'ended') return { found: true, status: 'done', ...text }
  return { found: true, status: 'running' }
}

/**
 * 这一句里有没有那个记号。两种都认:原文里就有(派活的记号本身就是行首那个「【工作台派活 xxxxxx】」,
 * 核「收下没有」那套洗法会把它剥掉);洗过之后对得上(捎话的记号是她那句的头一截)。
 */
export function holdsMark(text: string, marker: string): boolean {
  const want = marker.replace(/\s+/gu, ' ').trim()
  if (want === '') return false
  return text.replace(/\s+/gu, ' ').includes(want) || countSaid([text], marker) > 0
}

/** 在一份原文回合里按记号找那一轮。没有这一句 → `found:false`。 */
export function replyOfTurns(turns: Pick<SessionTurns, 'turns' | 'mark'>, marker: string): AgentRecordReply {
  const list = turns.turns
  let at = -1
  for (let i = list.length - 1; i >= 0; i--) {
    const one = list[i] as SessionTurn
    if (one.k === 'ask' && holdsMark(one.text, marker)) { at = i; break }
  }
  if (at < 0) return { found: false }
  return turnReplyOf(list.slice(at + 1), turns.mark)
}

/**
 * 在这一家的会话记录里找那一轮。指名了会话就只读那一条;没指名就翻它最近动过的几条。
 * 一条都读不了 → undefined(读不了,不是「还没有」);读到了却没有这一句 → `found:false`。绝不抛。
 */
export async function readTranscriptReply(input: {
  agent: string
  marker: string
  sessionId?: string
  access: TranscriptAccess
}): Promise<AgentRecordReply | undefined> {
  if (input.marker.trim() === '') return undefined
  const ids = input.sessionId !== undefined && input.sessionId !== ''
    ? [input.sessionId]
    : [...input.access.sessions()]
        .filter(one => one.agent === input.agent)
        .sort((a, b) => (Date.parse(b.updated_at ?? '') || 0) - (Date.parse(a.updated_at ?? '') || 0))
        .slice(0, TRANSCRIPT_REPLY_CANDIDATES)
        .map(one => one.session_id)
  let readable = false
  for (const id of ids) {
    const ref = await input.access.locate(input.agent, id).catch(() => undefined)
    if (ref === undefined) continue
    const got = await readHeadTail(ref, { headBytes: TRANSCRIPT_REPLY_HEAD_BYTES, maxHeadBytes: TRANSCRIPT_REPLY_HEAD_BYTES, tailBytes: TRANSCRIPT_REPLY_TAIL_BYTES })
    if (got === undefined) continue
    const tail = turnsOf(ref.format, { head: got.head, tail: got.tail, fallbackAt: got.fallbackAt })
    const reply = replyOfTurns(tail, input.marker)
    if (reply.found) return reply
    if (got.head === got.tail) { readable = true; continue }
    /*
     * 派活开的新对话:那一句是开头第一句,之后一干就是几 MB(真机 10-12:5 条里 4 条只有一句她的话、离文件尾 1.6–2.2MB),
     * 尾巴窗口里看不到它。开头里有这一句、尾巴里又没有她别的话 → 尾巴整段都是这一轮的;
     * 尾巴里她说过别的 → 中间那段归谁分不清,这一条当读不到(退窗口),不乱认。
     */
    const head = turnsOf(ref.format, { head: got.head, tail: got.head, fallbackAt: got.fallbackAt })
    if (!head.turns.some(one => one.k === 'ask' && holdsMark(one.text, input.marker))) { readable = true; continue }
    if (tail.turns.some(one => one.k === 'ask')) continue
    return turnReplyOf(tail.turns, tail.mark)
  }
  return readable ? { found: false } : undefined
}
