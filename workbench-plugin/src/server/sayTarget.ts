/**
 * ★ **「这句话指哪张卡」的单一解析器**(2026-10-28,卡「机制退修任务书-接续对题与改派语义」)。
 *
 * 只对**指卡**负责:卡号 / 接续回指按标题对题,对多张如实问、对不上如实说,绝不拿时间最近那张顶。
 * 理解中枢在模型出完命令之后用它核「指哪张卡」(`hub/understand.ts` 的 askIfAmbiguous):
 * 对上了好几张、模型挑了其中一张,那条改成问一句。
 *
 * ★ 2026-10-29 删规矩第一批(A#19):**动作指令解析**(`sayDirectivesOf`:改派 / 改名 / 目标改状态
 * 不经模型)随旧路删除 —— 这些意图全部由中枢命令表出(reassign / rename / goal_status)。
 * 改派的**落地**(`http.ts` 的 applyReassignDispatch,中枢的手)与那几句回话行留在这一侧。
 *
 * 纪律:
 *   - **接续按对题,不按最近**:话题(「手机 App」)在最近 say 账里按标题/关键词对,对一张才落,
 *     对多张/对不上都回一句问,绝不拿时间最近那张顶(09:35 事故根)。
 *   - **明确的卡号必须认**:句里出现 `t-xxxxxxxx` 就按卡号定位,不再翻 say 账「上一件」;
 *     找不到那张卡如实说「没拿着卡」。
 *   - 收不住的句子一律回 none/none,交回模型,不猜。
 */

import { GOAL_STATUS_TITLES } from '../protocol.ts'
import { normalizeCardName } from './sayCards.ts'

/** 判「目标」时用的人话与工具表口径(open / reached / dropped)。 */
export { GOAL_STATUS_TITLES }

/** 卡号:`tasks` 生成的 `t-xxxxxxxx`(8 位小写十六进制;句子里大写也认,归一小写)。 */
export const CARD_ID_PATTERN = /t-[0-9a-f]{8}/iu

/** 从句子里找卡号(第一个),没有回 undefined。 */
export function cardIdMentioned(text: string): string | undefined {
  const hit = CARD_ID_PATTERN.exec(text)
  if (hit === null) return undefined
  // 后面还跟着十六进制字符 = 不是卡号(只是长得像),不认。
  const after = text[hit.index + hit[0].length]
  if (after !== undefined && /[0-9a-f]/iu.test(after)) return undefined
  return hit[0].toLowerCase()
}

export interface ContinuationCue {
  /** 句子里有没有「刚才那件 / 上一件」这类接续回指。 */
  cue: boolean
  /** 回指里带着的话题(「刚才**手机 App** 那件」)。没带 = undefined。 */
  topic?: string
}

const CONTINUATION_WITH_TOPIC = /(?:刚才|方才|之前|前面)\s*([^,，;；。!！?？:：「」]{1,24}?)\s*(?:那件|那个|这活|这件事)/u
const CONTINUATION_BARE = /刚才那件|刚才那个|刚才说的那件|上一件|前面那件|之前那件|那件/u

/**
 * 接续回指认话:有话题摘话题(「刚才手机 App 那件」→「手机 App」),光秃回指只给 cue。
 * 话题收得窄:两个回指词之间、不含标点的那一小段;摘不出来按没带话题走,不猜。
 */
export function continuationOf(text: string): ContinuationCue {
  const withTopic = CONTINUATION_WITH_TOPIC.exec(text)
  if (withTopic !== null) {
    const topic = (withTopic[1] ?? '').trim()
    if (topic !== '' && !/^(?:那|这|它)$/u.test(topic)) return { cue: true, topic }
  }
  return { cue: CONTINUATION_BARE.test(text) }
}

/** 解析目标卡时要的任务格(执行层传 TaskView 的子集,用例造轻量对象)。 */
export interface SayTargetTask { id: string, title: string, title_from?: string, status: string, assignee?: string }

/** say 账一条(结构子集;中枢把上下文包里的 says 换成这个形状传进来,用例造轻量对象)。 */
export interface SayTargetLedgerEntry { at: number, items: readonly { kind?: string, card_id?: string, title: string }[] }

export type SayCardTarget =
  | { kind: 'card', task: SayTargetTask, via: 'card_id' | 'topic' | 'last' }
  | { kind: 'missing_card', id: string }
  | { kind: 'ambiguous', topic: string, candidates: readonly { id: string, title: string }[] }
  | { kind: 'no_match', topic: string }
  | { kind: 'none' }

export interface SayCardTargetInput {
  said: string
  tasks: readonly SayTargetTask[]
  ledger: readonly SayTargetLedgerEntry[]
  nowMs: number
  /** 默认 10 分钟窗(由调用方传入,不第二份定义)。 */
  ledgerWindowMs?: number
}

const DEFAULT_LEDGER_WINDOW_MS = 10 * 60 * 1000

/**
 * 「这句话指哪张卡」——唯一的解析器。**顺序就是判据**:
 *   1. 句里有卡号 → 按卡号定位(找不到 = missing_card,不翻 say 账);
 *   2. 有接续回指 + 话题 → 最近 say 账里按标题/关键词对题:一张才落,多张 ambiguous、
 *      零张 no_match —— 都不许拿时间最近那张顶;
 *   3. 光秃回指(「刚才那件」)→ 退回 say 账最后一件带卡的(旧行为,一字不变);
 *   4. 都不是 → none,交回模型。
 */
export function resolveSayCardTarget(input: SayCardTargetInput): SayCardTarget {
  const windowMs = input.ledgerWindowMs ?? DEFAULT_LEDGER_WINDOW_MS
  const id = cardIdMentioned(input.said)
  if (id !== undefined) {
    const task = input.tasks.find(one => one.id === id)
    return task === undefined ? { kind: 'missing_card', id } : { kind: 'card', task, via: 'card_id' }
  }
  const continuation = continuationOf(input.said)
  if (!continuation.cue) return { kind: 'none' }
  // 账从旧到新,接续从最新往回对。
  const entries = [...input.ledger].reverse()
    .filter(entry => input.nowMs - entry.at <= windowMs)
    .flatMap(entry => entry.items)
    .filter(item => item.card_id !== undefined && item.card_id !== '')
  if (continuation.topic !== undefined) {
    const seen = new Set<string>()
    const candidates: { id: string, title: string }[] = []
    for (const item of entries) {
      const cardId = item.card_id as string
      if (seen.has(cardId)) continue
      seen.add(cardId)
      const task = input.tasks.find(one => one.id === cardId)
      // 对题两边都认:板上现标题,**和 say 账里那一刻的标题**(卡改过名,账里那份才是她说的事)。
      const title = task?.title ?? item.title
      if (titleMatchesTopic(title, continuation.topic) || titleMatchesTopic(item.title, continuation.topic)) {
        candidates.push({ id: cardId, title })
      }
    }
    if (candidates.length === 1 && candidates[0] !== undefined) {
      const task = input.tasks.find(one => one.id === candidates[0]!.id)
      if (task !== undefined) return { kind: 'card', task, via: 'topic' }
    }
    if (candidates.length > 1) return { kind: 'ambiguous', topic: continuation.topic, candidates }
    return { kind: 'no_match', topic: continuation.topic }
  }
  const last = entries[0]
  if (last === undefined) return { kind: 'none' }
  const task = input.tasks.find(one => one.id === last.card_id)
  return task === undefined ? { kind: 'none' } : { kind: 'card', task, via: 'last' }
}

/* ── 回话模板:断言用导出的常量/函数,不逐字抄中文(交接与用例同源)。 ── */

export const REASSIGN_DONE_PREFIX = '已改派给'
export const REASSIGN_SETTLED_PREV = ',原来'
export const REASSIGN_SETTLED_TAIL = '那次已停'

export function reassignSayLine(cardId: string, whoTitle: string, prevTitle: string | undefined, settled: boolean): string {
  const base = `${cardId} ${REASSIGN_DONE_PREFIX}${whoTitle}`
  if (!settled) return `${base}。`
  return `${base}${prevTitle === undefined ? '' : `${REASSIGN_SETTLED_PREV}${prevTitle}`}${REASSIGN_SETTLED_TAIL}。`
}
export function missingCardSayLine(id: string): string {
  return `没拿着卡:板上没有 ${id} 这一张 —— 可能被删了,或号没打对。`
}
export function ambiguousSayLine(topic: string, candidates: readonly { id: string, title: string }[]): string {
  const list = candidates.slice(0, 3).map(one => `${one.title}(${one.id})`).join('、')
  return `「${topic}」对上了 ${candidates.length} 张:${list}${candidates.length > 3 ? ' 等' : ''}。你说卡号,我不猜。`
}
export function noMatchSayLine(topic: string): string {
  return `没找着「${topic}」对得上的那一张,你说卡号或全名,我不拿别的顶替。`
}

/** 话题对题:归一后标题包含话题(或话题包含标题)即对上。 */
function titleMatchesTopic(title: string, topic: string): boolean {
  const t = normalizeCardName(title)
  const p = normalizeCardName(topic)
  if (t === '' || p === '') return false
  return t.includes(p) || (p.length >= 4 && p.includes(t))
}
