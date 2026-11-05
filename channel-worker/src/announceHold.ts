/**
 * **他拨出去的那一通:先让他安排他的事,挂着的问等他说完再提**
 * (2026-10-13 下午,卡 A 第 4 条;交接 `docs/交接-1013-电话体验.md`)。
 *
 * ## 现场(维护者真机 0.4.119,14:17 那一通)
 *
 * ```
 * 房里开始通话(手机)                                ← 他自己拨出去的
 * 提机开场白已经出声了…
 * 通话里当场说了:等你回答 · 20号发大赛回顾视频(没响铃、没打断这一通)
 * 通话里当场说了:等你回答 · 「20号发大赛回顾视频」问你:到上限了(没响铃、没打断这一通)
 * 她说:老板,我在。
 * 提机开场白首段 108 字
 * 她说:插一句:「20号发大赛回顾视频」这会儿等你一句话:到上限了,先停下来了:花了约 0.51 元 · …
 * 她说:插一句:「「20号发大赛回顾视频」问你:到上限了」这会儿等你一句话:…接着做、停掉,还是换人?
 * ```
 *
 * 他拿起电话是**他有事要说**,结果一接通先被念了 108 字:同一件事两条 key 念了两遍,
 * 还带内部口径(钱 / 分钟 / 步数),他「打断不了」。维护者定的顺序:
 * **他先安排事,事务官再说它的。**
 *
 * ## 这一份管什么
 *
 * 只管**攒着与什么时候放**(纯的:不认识 LiveKit、不认识房间,念那一下是注进来的回调):
 *
 *   · **按 `item_id` 只收一件**:同一件事 8791 可能排两通(标题 / key 不同),只提一遍;
 *   · **一次只放一件**:放完一件,下一件等下一个空档;
 *   · 三种空档 —— ① 他这件事办完了(她那一段话说完、回到听);
 *     ② 他问「有什么事」({@link asksWhatsUp});③ 他一直不开口,空闲到点({@link ANNOUNCE_IDLE_MS})。
 *     ③ 不只管接通那一下:**收下一件就重新开始数** —— 不然「他说完他的事、她答完、
 *     片子这会儿才出来」那一种(10-13 14:19 那一通:工人在这通里插一句,没另响)
 *     会等不到下一个回合,一句话都不说;
 *   · **他正说着话不放**(`heSpeaking`):插在他话上就是抢话。
 *
 * ## 来电那一通不经这里
 *
 * 事务官主动打来的那一通**一开口就说事**(`ringOpener`,维护者 10-13 上午收回 09-23 那一套:
 * 「接起来也不说事,还要我来问」)。接线在 agent.ts:只有**他拨出去**的那一通才攒着。
 */

/** 攒着的一件(`text` 是 `inCallAnnounceText` 拼好的那一句)。 */
export interface HeldAnnounce {
  itemId: string
  text: string
}

/**
 * 他一直不开口,等多久就把挂着的那一件说一句。
 * 8 秒 —— 他拿起电话多半三两秒内就开口;到了 8 秒还没动静,那他是在等她说话。
 */
export const ANNOUNCE_IDLE_MS = 8000

/** 「有什么事」那几句。**只认短句**:长句里问「有什么事」多半是他在说别的。 */
const WHATS_UP: readonly RegExp[] = [
  /^(有)?(什么|啥|咩)事(吗|呀|啊|么|儿)?[??。.!!]?$/u,
  /^(有|是)?(什么|啥)情况[??。.!!]?$/u,
  /^你(找|叫)我[??。.!!]?$/u,
  /^(刚才|刚刚)?(你)?(说|讲)什么[??。.!!]?$/u,
  /^(还)?有(别的|其他|什么)(事|的)?(吗|呀|么)?[??。.!!]?$/u,
]

/** 「有什么事」那一句最长多少字(再长就是他在说别的)。 */
export const WHATS_UP_MAX_CHARS = 10

/** 他这一句是在问「有什么事」吗。 */
export function asksWhatsUp(heard: string): boolean {
  const text = (heard ?? '').trim()
  if (text === '' || [...text].length > WHATS_UP_MAX_CHARS) return false
  return WHATS_UP.some(re => re.test(text))
}

export interface AnnounceHoldDeps {
  /** 真念那一句。回 false = 这会儿没念出去(她不在、会话断了)—— 那就留着下一个空档再放。 */
  say: (one: HeldAnnounce) => boolean
  setTimer?: (fn: () => void, ms: number) => () => void
  idleMs?: number
  log?: (line: string) => void
}

export interface AnnounceHold {
  /**
   * 收下一件(**不念**)。
   *
   * 回 **true = 这一条由我接住了**:调用方(`callOut.ts` 的 `announce`)据此按
   * 「只发了通知」收场,**不排队、不在挂断之后再响一遍**。
   * 同一件事(按 `item_id`)第二条也回 true —— 它就是「只提一遍」那条规矩本身:
   * 不说、也不许它变成一通挂断之后的铃(14:17 那一通同一件事念了两遍,
   * 排队再响只是把「两遍」换个地方发生)。
   *
   * 回 false 只有一种:这一通已经收了(`stop()` 过)—— 那时照旧交给振铃那台机器。
   */
  hold: (one: HeldAnnounce) => boolean
  /** 他说了一句话(识别定稿)。问「有什么事」就当场放一件;别的只是把空闲计时撤掉。 */
  heSaid: (heard: string) => void
  /** 他开口 / 停口(VAD):正说着话不放。 */
  heSpeaking: (speaking: boolean) => void
  /** 他这件事办完了(她那一段说完、回到听)→ 放一件。 */
  thingDone: () => void
  /** 开始数空闲(他一直不开口就先说一件)。{@link AnnounceHold.hold} 自己会调一次。 */
  armIdle: () => void
  /** 这一通收了:攒着的全丢掉(不许串进下一通)。 */
  stop: () => void
  /** 还攒着几件(用例与日志用)。 */
  readonly waiting: number
  /** 这一通里提过哪几件(用例用)。 */
  readonly told: readonly string[]
}

export function createAnnounceHold(deps: AnnounceHoldDeps): AnnounceHold {
  const log = deps.log ?? (() => {})
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => {
    const timer = setTimeout(fn, ms)
    timer.unref?.()
    return () => { clearTimeout(timer) }
  })
  const idleMs = Math.floor(deps.idleMs ?? ANNOUNCE_IDLE_MS)
  /** 攒着的(按进来的顺序)。 */
  const queue: HeldAnnounce[] = []
  /** 这一通里**收过**的那几件(按 item_id):提过的、还攒着的都在里面。 */
  const seen = new Set<string>()
  /** 这一通里真念出去了的那几件。 */
  const told: string[] = []
  let heTalking = false
  let stopped = false
  let cancelIdle: (() => void) | undefined

  function clearIdle(): void {
    try { cancelIdle?.() } catch { /* 取消定时器失败不值得再出一个错 */ }
    cancelIdle = undefined
  }

  /** 放一件(只放一件)。他正说话、没攒着、这一通收了都不放。 */
  function release(why: string): void {
    if (stopped || heTalking) return
    const one = queue[0]
    if (one === undefined) return
    let said = false
    try { said = deps.say(one) === true }
    catch (err) {
      log(`[channel-worker] 挂着的那件事没说出去:${(err as Error)?.message ?? '没说原因'}`)
      said = false
    }
    if (!said) return
    queue.shift()
    told.push(one.itemId)
    clearIdle()
    log(`[channel-worker] 他的事说完了,这才提挂着的那一件(${why}):${one.text}`)
    // 还攒着别的:**一件一次** —— 下一件等下一个空档(他不再开口的话就是空闲那一道)。
    if (queue.length > 0) armIdle()
  }

  /** 开始数空闲。排第二次把第一次撤掉(一通里只数一根)。 */
  function armIdle(): void {
    if (stopped) return
    clearIdle()
    cancelIdle = setTimer(() => {
      cancelIdle = undefined
      release(`他 ${Math.round(idleMs / 1000)} 秒没开口`)
    }, idleMs)
  }

  return {
    hold(one) {
      if (stopped) return false
      /*
       * 认不出是哪一件(`parseRingCall` 要求 `item_id` 非空,所以正常走不到这儿):
       * 按那一句话本身当 key —— 去重宁可松一点,也不要把一条真的通知丢掉。
       */
      const id = (one.itemId ?? '').trim() === '' ? `text:${one.text}` : one.itemId.trim()
      if (seen.has(id)) {
        log(`[channel-worker] 这一件这一通里已经提过了(${id}),不再提一遍,也不在挂断之后再响一遍`)
        return true
      }
      seen.add(id)
      queue.push({ itemId: id, text: one.text })
      log(`[channel-worker] 他拨出来的这一通先让他说:挂着的这一件攒着(${id}),等他这件事办完再提`)
      /*
       * 从这会儿起数空闲:他正说着话 / 这就要说话,`heSpeaking` 与 `heSaid` 会把它撤掉,
       * 由「他这件事办完了」那一道放;他压根不说话(片子在通话中段出来那一种)就靠这根放。
       */
      armIdle()
      return true
    },

    heSaid(heard) {
      if (stopped) return
      clearIdle()
      if (asksWhatsUp(heard)) release('他问有什么事')
    },

    heSpeaking(speaking) {
      heTalking = speaking
      if (speaking) clearIdle()
    },

    thingDone() {
      if (stopped || queue.length === 0) return
      release('她这一段说完了')
    },

    armIdle,

    stop() {
      stopped = true
      clearIdle()
      const left = queue.splice(0)
      if (left.length > 0) {
        // 如实记一行:这几件这一通里没提(台账上它们按「只发了通知」收过场了,8791 那头照旧挂着)。
        log(`[channel-worker] 这一通挂了,还有 ${left.length} 件没提:${left.map(one => one.itemId).join('、')}`)
      }
    },

    get waiting() { return queue.length },
    get told() { return told },
  }
}
