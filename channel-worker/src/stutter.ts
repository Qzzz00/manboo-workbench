/**
 * 去掉模型输出里的「结巴」(2026-09-24 真机第五轮)。
 *
 * 那一句:「……更像是做产品研发,还是做自媒体运营?营?我按这个给你把工作台摆好。」—— 「营?」出了两遍。
 *
 * 查过的几处(交接-0924-第五轮引导对话与扫描 第三节):
 *   - 日志里「她说:」那一行是框架 `ConversationItemAdded` 的 textContent,就是模型吐出来的原文,
 *     **不经** 分句器(ChineseSentenceTokenizer 只切送去合成的那一份,不改字)、也不经先应那句
 *     (引导里不分流、不先应,routedLlmNode 第一行就放行了);
 *   - 那一轮框架没有打「retrying」那行警告,不是重试把前半段重放了一遍;
 *   - 中转(relay/server/sse.cjs)只嗅 usage,字节原样转。
 * 所以是模型流本身吐了重复的一小段。修在**流上**:字幕、合成、对话历史走的都是这一条,一处改三处都干净。
 *
 * 只收一种形状:**紧挨着重复的一小段、以句末标点收尾**(「营?营?」「对。对。」)。
 * 「好好」「哈哈」这种没有标点隔开的叠字不动;隔了别的字的重复不动。
 */

/** 句末标点(问号、叹号、句号,全角半角)。 */
const END = '?？!！。'
/** 一小段:最多这么多字(不含收尾标点),都不是标点 / 空白。 */
const MAX_FRAGMENT = 6
const REPEAT = new RegExp(`([^\\s,，、。?？!！;；:：]{1,${MAX_FRAGMENT}}[${END}])\\1+`, 'g')
/** 句末标点后面紧跟的这么多字先压一压,等看清是不是重复再放出去。 */
const HOLD_TAIL = new RegExp(`[${END}]([^\\s,，、。?？!！;；:：]{1,${MAX_FRAGMENT}})$`)
/** 已经放出去的留多少字做比对。 */
const TAIL_KEEP = 16

export function collapseStutter(text: string): string {
  return text.replace(REPEAT, '$1')
}

/** 流式版:一段一段喂,回这一次可以放出去的字;最后 `flush()` 把压着的放完。 */
export class StutterFilter {
  #tail = ''
  #hold = ''

  push(text: string): string {
    if (text === '') return ''
    const combined = collapseStutter(this.#tail + this.#hold + text)
    // 折叠只会去掉后面那一遍;万一动到了已经放出去的那段,就不折叠(宁可放过,不吞字)。
    const fresh = combined.startsWith(this.#tail)
      ? combined.slice(this.#tail.length)
      : this.#hold + text
    const held = HOLD_TAIL.exec(this.#tail + fresh)
    const holdLength = held === null ? 0 : Math.min(held[1]!.length, fresh.length)
    const out = fresh.slice(0, fresh.length - holdLength)
    this.#hold = fresh.slice(fresh.length - holdLength)
    this.#tail = (this.#tail + out).slice(-TAIL_KEEP)
    return out
  }

  flush(): string {
    const out = this.#hold
    this.#hold = ''
    this.#tail = (this.#tail + out).slice(-TAIL_KEEP)
    return out
  }
}

/**
 * 包 `llmNode` 的输出(字符串或 ChatChunk)。工具调用、usage 原样过;
 * 带字的 chunk 换成过滤后的字(被压住的那几个字在下一块或流末尾放出)。
 */
export function withoutStutter<T>(base: ReadableStream<T>): ReadableStream<T> {
  const filter = new StutterFilter()
  return base.pipeThrough(new TransformStream<T, T>({
    transform(chunk, controller) {
      if (typeof chunk === 'string') {
        if (chunk === '') { controller.enqueue(chunk); return }
        const out = filter.push(chunk)
        if (out !== '') controller.enqueue(out as T)
        return
      }
      const delta = (chunk as { delta?: { content?: unknown, toolCalls?: unknown[] } } | null)?.delta
      if (delta === undefined || typeof delta.content !== 'string' || delta.content === '') {
        controller.enqueue(chunk)
        return
      }
      const out = filter.push(delta.content)
      const hasTools = Array.isArray(delta.toolCalls) && delta.toolCalls.length > 0
      if (out === '' && !hasTools) return
      controller.enqueue({ ...(chunk as object), delta: { ...delta, content: out } } as T)
    },
    flush(controller) {
      const rest = filter.flush()
      if (rest !== '') controller.enqueue(rest as T)
    },
  }))
}
