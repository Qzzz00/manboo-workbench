/**
 * 开场那一句**等对端真的能听见了再出口**(2026-09-27,卡 CL)。
 *
 * ## 现场(维护者 21:3x,手机打给事务官)
 *
 * > 「我打过去一上来就听到『吩咐』两个字,『吩』字还是尾巴,前面估计被吃了。」
 *
 * 开场白是「老板,有什么吩咐?」—— 他听见的是这一句的**后半截**,前面
 * 半秒多没进他的耳朵。工人那边的日志没有半点异常:`房里开始通话(手机)` →
 * `普通通话招呼 ← wb-phone-…:说了` → 700ms → `她说:老板,有什么吩咐?`,
 * 一帧都没少发。**少的不是发,是对端那一侧的起播**:
 *
 *   · **手机**:它常驻房间(不常驻电话打不进来),不通话时那个 `<audio>` 是
 *     **静音 + 暂停**的(butler-app/src/channel/roomLink.ts 的 `applySpeaker`)。
 *     接通那一下才 `play()` —— Android WebView 从 `play()` 到扬声器真出声要
 *     几百毫秒(要重开一次 AudioTrack),这期间到的帧在抖动缓冲里过期就被丢掉。
 *     09-27 那通:工人 21:16:13 起就在房里、手机十七分钟前就订上了音轨,
 *     所以「等订阅」救不了这一通 —— 救它的是**前导静音**(greeting.ts)。
 *   · **座机(树莓派)**:它一订上工人音轨就把 `aplay` 那根管子开着不关
 *     (phone-bridge/room_link.py `_to_earpiece` 文件注里那句「重开一次 aplay
 *     在派上要几百毫秒,开头会吃掉一个字」),所以座机这一路本来就不吃字 ——
 *     它吃的是**另一种**:刚开机 / 刚重连、订阅还没落地就开口。
 *
 * ## 这一份管哪一半
 *
 * 这一份只管「**订上了没有**」那一半:工人自己那条音轨**有人订**了才开口,
 * 到点(缺省 1.5 秒)还没订上就照旧开口 —— **不能因为等而让人举着听筒干等**,
 * 那正是 09-23 那张卡在治的毛病。
 *
 * 「有人订了」用的是 LiveKit 自己的 `LocalTrackPublication.waitForSubscription()`
 * ——服务端把「有人订了你的轨」告诉发布方那一条(rtc-node 的 `localTrackSubscribed`)。
 * **它只认第一位订阅者**(SDK 里那个 promise 一旦 resolve 就一直是 resolved),
 * 所以这道闸真正救的是「工人刚进房、第一通电话」那一类;同一台手机第二通打来时
 * 它当场就开 —— 那一类由前导静音接着兜。两条合起来才是完整的一句开场白。
 *
 * 另一半(**前导静音**)在 greeting.ts:`openerSpeech` 给缓存那一条在前面垫
 * 约 260ms 静音,对端起播那几百毫秒吃掉的就是这段静音,第一个字整着到。
 */
import { TrackKind } from '@livekit/rtc-node'

/**
 * 等对端订上工人音轨的上限(毫秒)。到点照旧开口。
 *
 * 1.5 秒是这么来的:提机 / 接起到贴耳那一段路本身就有 700ms(`DEFAULT_GREETING_DELAY_MS`),
 * 订阅落地慢过这一段还要再等 1.5 秒的话,他已经举着一只安静的听筒两秒多了 ——
 * 那时候宁可让第一个字有风险,也不能一片安静。
 */
export const OPENER_SUBSCRIBE_WAIT_MS = 1500

/** 这道闸怎么开的。日志与用例看这一个。 */
export type OpenerGateResult =
  /** 对端订上了(等了 waitedMs 毫秒)。 */
  | 'subscribed'
  /** 到点还没订上,照旧开口。 */
  | 'timeout'
  /** 没东西可等(还没发布音轨、这台 SDK 不给这个能力、上限设成了 0):照旧开口。 */
  | 'skipped'

/** 一条本地发布(只用到这两样,好让用例不必造一个真的 LiveKit 房间)。 */
export interface OpenerPublicationLike {
  kind?: TrackKind | number | undefined
  waitForSubscription?: () => Promise<void>
}

/**
 * 本地发布里那条音轨。没有就 undefined(工人还没 `session.start()` 完的那一瞬)。
 *
 * **不抛**:遍历一个坏掉的 Map、读一个 getter 都可能抛,而这条路上唯一的后果
 * 应该是「这一通不等订阅」,不该是提机打不通。
 */
export function audioPublicationOf(
  publications: Iterable<OpenerPublicationLike> | undefined,
): OpenerPublicationLike | undefined {
  if (publications === undefined) return undefined
  try {
    for (const one of publications) {
      if (one?.kind === TrackKind.KIND_AUDIO && typeof one.waitForSubscription === 'function') return one
    }
  }
  catch { return undefined }
  return undefined
}

export interface OpenerGateOptions {
  /**
   * 每次开闸时现取那条音轨发布(现取而不是构造时取:工人常驻,
   * 音轨可能在第一通电话之前被重新发布过 —— 满重连时 SDK 会自己再发一次)。
   */
  publication: () => OpenerPublicationLike | undefined
  /** 上限,缺省 {@link OPENER_SUBSCRIBE_WAIT_MS}。`<= 0` = 不等(逐字回到 09-23 那一版)。 */
  timeoutMs?: number
  /** 现在几点(测试注入)。 */
  now?: () => number
  /** 定时器(测试注入)。回一个「取消它」的函数。 */
  setTimer?: (fn: () => void, ms: number) => () => void
  log?: (line: string) => void
}

/** 等一等的结果连着等了多久(日志要报这个数,它就是这张卡的证据)。 */
export interface OpenerGateOutcome {
  how: OpenerGateResult
  waitedMs: number
}

/**
 * 「等对端订上工人音轨」这一下。回一个 `() => Promise<OpenerGateOutcome>`:
 * **绝不抛、绝不吊死** —— 最坏也是 `timeout` 之后照旧开口。
 */
export function createOpenerGate(options: OpenerGateOptions): () => Promise<OpenerGateOutcome> {
  const timeoutMs = Math.floor(options.timeoutMs ?? OPENER_SUBSCRIBE_WAIT_MS)
  const now = options.now ?? (() => Date.now())
  const setTimer = options.setTimer ?? ((fn, ms) => {
    const timer = setTimeout(fn, ms)
    timer.unref?.()
    return () => { clearTimeout(timer) }
  })
  const log = options.log ?? (() => {})
  return async () => {
    const started = now()
    if (timeoutMs <= 0) return { how: 'skipped', waitedMs: 0 }
    let publication: OpenerPublicationLike | undefined
    try { publication = options.publication() }
    catch { publication = undefined }
    const wait = publication?.waitForSubscription
    if (wait === undefined) {
      log('[channel-worker] 开场白:这会儿还没有自己的音轨发布(或这台 SDK 不给「有人订了」这个信号),不等订阅,照旧开口。')
      return { how: 'skipped', waitedMs: 0 }
    }
    let cancelTimer: (() => void) | undefined
    const timeout = new Promise<'timeout'>((resolve) => {
      cancelTimer = setTimer(() => resolve('timeout'), timeoutMs)
    })
    let how: OpenerGateResult
    try {
      how = await Promise.race([
        wait.call(publication).then(() => 'subscribed' as const),
        timeout,
      ])
    }
    catch {
      // 等订阅这一下抛了(SDK 换了行为、房间断了):不许因此没了开场白。
      how = 'skipped'
    }
    finally { try { cancelTimer?.() } catch { /* 取消定时器失败不值得再出一个错 */ } }
    const waitedMs = Math.max(0, now() - started)
    if (how === 'subscribed') {
      // 0ms 的那一条也要留着:它正是「这一通不是等订阅救的,是前导静音救的」的证据。
      log(`[channel-worker] 开场白:对端订上工人音轨了(等了 ${waitedMs}ms),开口。`)
    }
    else if (how === 'timeout') {
      log(`[channel-worker] 开场白:等了 ${waitedMs}ms 对端还没订上工人音轨,照旧开口`
        + '(第一个字可能被吃;改上限:WORKBENCH_CHANNEL_OPENER_SUBSCRIBE_MS)。')
    }
    return { how, waitedMs }
  }
}
