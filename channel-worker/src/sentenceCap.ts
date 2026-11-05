/**
 * 每轮最多几句(2026-09-24 晚,卡 K;desktop-workbench docs/设计-全局自进化-2026-09-24.md)。
 *
 * 他的规矩 ④:「电话每轮不超过两句」。以前只写在提示词里,模型一啰嗦就念出三四句 ——
 * 规矩里**能机器执行的就机器执行**:这一条在流上掐,字幕、合成、对话历史走的都是这一条(同 stutter.ts)。
 *
 * - 上限由 8791 从规矩表算出来(`GET /channel/persona` 的 `max_sentences`):他把这条规矩删了,这里就不掐;
 * - **一个回合一份预算**:他说完一句(识别 final)就重来。模型调完工具再开口,用的是同一回合剩下的额度 ——
 *   不然「好,我记一下。记下了。已经派出去了。等它做完告诉你。」就又是四句;
 * - 只数句末标点(。!?!?),「……」不算;数到上限那一句的标点为止,后面的字丢掉;**工具调用、usage 原样过**。
 * - 引导那一通不掐:引导的提示词自己限「两句 + 一问」,在流上掐会把那一问掐掉(他就不知道该答什么)。
 */

/** 句末标点。 */
const END = /[。!?\uFF01\uFF1F]/u

export class SentenceBudget {
  #spent = 0

  /** 新的一回合(他又说了一句)。 */
  reset(): void { this.#spent = 0 }

  /**
   * **系统替她说出去的固定话**也记进这一回合(2026-10-12,维护者:「跟事务官电话,真的好啰嗦」)。
   * 先应「好,我去安排。」、垫场「等我一下。」、现生的首句,以前都不进额度 —— 一轮叠出四五句。
   * 一句固定话至少算一句(「我想想」没标点也是一句);**最多记到 `limit - 1`**:
   * 模型那一句结果永远有位置,不然她只会说「好的」不说办得怎样。`limit` 缺席(规矩删了)= 不记。
   */
  charge(text: string, limit: number | undefined): void {
    if (limit === undefined || !Number.isInteger(limit) || limit <= 0) return
    if (text.trim() === '') return
    let sentences = 0
    for (const char of text) if (END.test(char)) sentences += 1
    this.#spent = Math.min(limit - 1, this.#spent + Math.max(1, sentences))
  }

  get spent(): number { return this.#spent }

  /**
   * 这一段字里能放出去多少(上限 `limit` 句,跨段累计)。回放得出去的那一截;
   * 已经到顶时回空串。
   */
  take(text: string, limit: number): string {
    if (this.#spent >= limit) return ''
    let out = ''
    for (const char of text) {
      out += char
      if (END.test(char)) {
        this.#spent += 1
        if (this.#spent >= limit) break
      }
    }
    return out
  }
}

/**
 * 包 `llmNode` 的输出(字符串或 ChatChunk)。带字的那几块按预算放;工具调用、usage 原样过。
 * `limit` 缺席或不是正数 = 不掐(原样返回)。
 */
export function withSentenceCap<T>(base: ReadableStream<T>, budget: SentenceBudget, limit: number | undefined): ReadableStream<T> {
  if (limit === undefined || !Number.isInteger(limit) || limit <= 0) return base
  return base.pipeThrough(new TransformStream<T, T>({
    transform(chunk, controller) {
      if (typeof chunk === 'string') {
        if (chunk === '') { controller.enqueue(chunk); return }
        const out = budget.take(chunk, limit)
        if (out !== '') controller.enqueue(out as T)
        return
      }
      const delta = (chunk as { delta?: { content?: unknown, toolCalls?: unknown[] } } | null)?.delta
      if (delta === undefined || typeof delta.content !== 'string' || delta.content === '') {
        controller.enqueue(chunk)
        return
      }
      const out = budget.take(delta.content, limit)
      const hasTools = Array.isArray(delta.toolCalls) && delta.toolCalls.length > 0
      if (out === '' && !hasTools) return
      controller.enqueue({ ...(chunk as object), delta: { ...delta, content: out } } as T)
    },
  }))
}
