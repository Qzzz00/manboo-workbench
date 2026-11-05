/**
 * 一道**并发闸**:同一时刻最多放几个人进去,其余排队,先到先得。
 *
 * 为什么会有这么一层(2026-09-20,Ben 真机第二轮「十分钟断线」):
 * 框架把一段话按句切开之后是**并发**送去合成的(见 speechOrder.ts 那段注释:
 * 最短那句往往最先合完)。开场白拆成四小块 = 四条 `POST /api/tts` 同时打出去 =
 * 火山那边同一瞬间四条合成请求。他那台机器的 `~/.dsh/logs/butler.stderr.log` 里
 * 逐字写着结果:
 *
 *     volcengine TTS HTTP 429 code=3001 quota exceeded for types: concurrency
 *
 * 也就是说 8792 回的那个 502 **不是火山挂了,是我们自己把自己挤爆了**。
 * 排成队之后这一条就不会再发生:第一小块照样立刻开合成(首字延迟一个字节都没变),
 * 后面几块在前一块**合成**完之后才开始 —— 而一块合成只要几百毫秒,一块**播放**要好几秒,
 * 所以排队的那点时间全部藏在前一块的播放里,听不出来。
 *
 * 纯数据结构,不认识 HTTP 也不认识 LiveKit。
 */

/** 同一时刻最多几条合成。1 = 严格排队。见文件头:火山的并发配额是按账号算的。 */
export const TTS_MAX_CONCURRENT = 1

export class Gate {
  readonly max: number
  #active = 0
  readonly #waiting: (() => void)[] = []

  constructor(max: number = TTS_MAX_CONCURRENT) {
    // 0 或负数会把整条链路锁死 —— 那是配错了,不是一种用法。按 1 处理并往下走。
    this.max = Number.isFinite(max) && max >= 1 ? Math.floor(max) : 1
  }

  /** 此刻有几个人在里面(测试与诊断用)。 */
  get active(): number { return this.#active }

  /** 此刻有几个人在排队。 */
  get waiting(): number { return this.#waiting.length }

  /**
   * 进闸。回一个**只放行一次**的 release —— 调用方必须在 finally 里调它,
   * 否则后面排队的永远进不来(比合成失败糟得多:那是整条嘴哑掉)。
   */
  async acquire(): Promise<() => void> {
    if (this.#active < this.max) this.#active += 1
    else await new Promise<void>(resolve => this.#waiting.push(resolve))
    let released = false
    return () => {
      if (released) return
      released = true
      const next = this.#waiting.shift()
      // 让位给下一个:名额从他手里直接转给排头,中间不经过「空出来」那一瞬间,
      // 免得第三个人插队进到前面去(先到先得是这道闸唯一的承诺)。
      if (next !== undefined) next()
      else this.#active -= 1
    }
  }
}
