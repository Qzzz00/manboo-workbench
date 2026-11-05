/**
 * 派出去的活,**结果取哪一段**(2026-09-28,卡 RC)。
 *
 * ## 撞出来的事(09-28 10:2x,维护者本机 0.4.51)
 *
 * 他在手机上批了「验证自我迭代能力」派给 Claude(窗口那只手,Claude 桌面新开一条对话)。Claude 做完之后:
 *
 * - 事项 t-eade4c97 `status: confirm`(「办完了,等你确认」),收回的结果是
 *   **「所有核心自我迭代相关的测试全过。再快速扫一眼整套以确认没有破损。」** —— 那是 Claude **中途**的过程话;
 * - 同时「等你」里另有一条孤立的「Claude 在等你点头:落在哪…需要你拍板后另开一张卡」——
 *   Claude 最后其实**在问他**,而那段话根本没进事项。
 *
 * 维护者要的是**一件事一条**:「『验证自我迭代能力』:Claude 测试都过了,但要你定一件事:落在哪…」挂在等你,
 * 他答了能接着让 Claude 做。不是「办完了」+ 另一条孤零零的「在等你点头」。
 *
 * ## 这个文件做什么(全是纯函数,不经模型)
 *
 * 1. **认会话**:窗口那只手派出去的那条对话,只要那一家有会话文件(Claude / Codex / Kimi),
 *    就该认成它的会话 —— 按我们送进去的记号(「工作台派活 xxxxxx」)在会话回合里找,
 *    比"送出之后那边新冒出几条"稳(他自己同时开一条,差集就认不准了);
 * 2. **取最后那一段交代**:认上会话之后,结果从**会话里最后一个回合的完整回答**取,
 *    不取窗口里读到的中途句;读不到会话时才用窗口那一段。
 *
 * 会话文件那一份从哪儿来:`dshSessionFeed.turns(sessionId, limit)`(`/state` 与「等你」用的是同一份,
 * 所以这里取到的和「等你」里那一问必然是同一段话 —— 这正是"一件事一条"的前提)。
 */

/** 会话里的一个回合(只要这两格;`dshSessionFeed` 的 `SessionTurn` 天然对得上)。 */
export interface ResultTurn {
  role: string
  text?: string
}

/** 比对用:只留字母、数字、汉字(同 `dispatchReply.matchKey` 的口径,记号被画成什么样都认得出)。 */
function key(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
}

/**
 * 会话里**最后一个回合的完整回答**(最后那条 assistant 回合的原文)。一条都没有回 undefined。
 *
 * 不截、不改字:截多长是上层的事(卡上那一份走 `REPLY_MAX_CHARS`,念给他听的那一句走 `speakable`)。
 */
export function lastAssistantTurn(turns: readonly ResultTurn[] | undefined): string | undefined {
  for (let i = (turns?.length ?? 0) - 1; i >= 0; i -= 1) {
    const turn = (turns as readonly ResultTurn[])[i] as ResultTurn
    if (turn.role !== 'assistant') continue
    const text = (turn.text ?? '').trim()
    if (text !== '') return text
  }
  return undefined
}

/** 一条候选会话:它的 id 与它的回合(取不到回合的传 undefined —— 认不出就不认,不猜)。 */
export interface MarkerCandidate {
  session_id: string
  turns?: readonly ResultTurn[]
}

/**
 * 我们派出去的那条对话是哪条会话:**按记号认**(「工作台派活 xxxxxx」或「事务官捎话 xxxxxx」)。
 *
 * 判据只有一条:那条会话的某个回合里出现过这个记号(按 `key` 比,markdown 画成什么样都算)。
 * 恰好一条 → 就是它;**多于一条也不认**(同一个记号出现在两条会话里,认不准);一条都没有 → undefined,
 * 调用方退回老办法(送出之后的新会话差集)。
 */
export function sessionByMarker(marker: string, candidates: readonly MarkerCandidate[]): string | undefined {
  const want = key(marker)
  if (want === '') return undefined
  const hits = candidates.filter(one => (one.turns ?? []).some(turn => key(turn.text ?? '').includes(want)))
  return hits.length === 1 ? (hits[0] as MarkerCandidate).session_id : undefined
}

export interface DispatchResult {
  text: string
  /** 这一段从哪儿取的:会话文件里最后一个回合 / 窗口里读回来的那一段。 */
  from: 'session' | 'window'
}

/**
 * 结果取哪一段:**有会话文件就取会话里最后那个回合的完整回答**,没有才用窗口里读回来的那一段。
 *
 * 为什么会话文件优先:窗口那只手读的是辅助功能树,一个回合里几条消息挤在一起,读到哪一条要靠规则去摘
 * (09-28 那一件就摘错成中途句);会话文件里"最后一个回合"是数出来的,没有可摘错的地方。
 */
export function dispatchResultOf(input: { windowReply?: string, turns?: readonly ResultTurn[] }): DispatchResult {
  const last = lastAssistantTurn(input.turns)
  if (last !== undefined) return { text: last, from: 'session' }
  return { text: (input.windowReply ?? '').trim(), from: 'window' }
}
