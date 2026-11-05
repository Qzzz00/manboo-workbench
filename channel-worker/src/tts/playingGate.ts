/**
 * 开场那一句**等手机说「我这边在放了」再出口**(2026-09-28,卡 CF 第 4 条)。
 *
 * ## 为什么卡 CL 那道闸不够
 *
 * 卡 CL 等的是「**对端订上工人音轨了没有**」(`tts/openerGate.ts`)。真机日志
 * (工作台诊断包-20260928-155543)里每一通都是同一行:
 *
 * > 开场白:对端订上工人音轨了(等了 0ms),开口。
 *
 * 手机**常驻房间**(不常驻电话打不进来),它十几分钟前就订上了那条轨 —— 那道闸当场就开。
 * 而它真正开始出声要晚得多:接通那一下才 `play()`,Android WebView 要切通话音频路由、
 * 重开一次 AudioTrack,这期间到的帧在抖动缓冲里过期就被丢掉。于是维护者听到的还是
 * 「……吩咐」——「老板,有什么」那一截进了黑洞。前面垫的 260ms 静音(`greeting.ts`)
 * 只够挡一小部分。
 *
 * ## 判据换成手机自己说的那一句
 *
 * 手机在**本地真的开始播远端音轨**之后,经数据通道发一条 `{type:'call',action:'playing'}`
 * (butler-app/src/call/playbackReady.ts 判「真的在放」:`<audio>` 报出播放进度,
 * 或者同时起的那个 AudioContext 时钟真的在走)。工人等到它再开口。
 *
 * 四条纪律(缺一条就会变成新的毛病):
 *
 * 1. **等不到有上限**(缺省 {@link PLAYING_WAIT_MS} = 2.5s):到点照旧说,并在日志里记一行 ——
 *    宁可第一个字有风险,也不能让他举着一只安静的听筒(09-23 那张卡治的就是这个)。
 * 2. **老手机不发这一条就一个字都不等**:它接起时没说过「我会报」(`expect` 没被调用过),
 *    这道闸整个 `skipped`,逐字回到卡 CL 那一版。
 * 3. **一通一份**:接起时 `expect(这一通说话的那一台)`,结束/挂断时 `reset()`。
 *    报的不是这一台(房里还有别的手机、那只听筒)不算 —— 谁说话等谁。
 * 4. **先到的记着**(2026-09-28,卡 OP)。**他从手机打出去**那一路的顺序是反的:
 *    手机先开喇叭、先把输出烘热,那一条 `playing` 比带 `reports_playing` 的 `call.start`
 *    **先到**。卡 CF 那一版里先到的被丢掉、随后 `expect()` 又把 `arrived` 抹成 false,
 *    于是每通拨出都白等到 2.5s 上限(真机日志里连一行「在放了」都没有)。
 *    现在先到的记一笔:**同一台 + 在 {@link PLAYING_PRE_ARRIVAL_MS} 之内**才认 ——
 *    换一台不认、过了期不认、`reset()` 之后不认(那一下不属于这一通)。
 *
 * 纯逻辑、可注入时钟;**绝不抛、绝不吊死**,最坏也是到点照旧开口。
 */

/** 等手机说「在放了」的上限(毫秒)。到点照旧开口。 */
export const PLAYING_WAIT_MS = 2500

/**
 * 先到的那一条「在放了」**多久之内还算这一通的**(毫秒,2026-09-28,卡 OP)。
 *
 * 拨出那一路里它只比 `call.start` 早几十到几百毫秒(开喇叭 → 烘热 → 请工人接起),
 * 5 秒是宽宽的富余。过了这个数就不认:手机崩了、没发挂断,上一通那一下不许算到下一通头上。
 */
export const PLAYING_PRE_ARRIVAL_MS = 5000

/** 这道闸怎么开的。 */
export type PlayingGateResult =
  /** 手机说它在放了。 */
  | 'playing'
  /** 到点还没说,照旧开口。 */
  | 'timeout'
  /** 没东西可等(这台手机不报 / 上限设成了 0 / 这一通已经清掉了)。 */
  | 'skipped'

export interface PlayingGateOutcome {
  how: PlayingGateResult
  waitedMs: number
}

export interface PlayingGateOptions {
  /** 上限,缺省 {@link PLAYING_WAIT_MS}。`<= 0` = 不等。 */
  timeoutMs?: number
  /** 先到的那一条还算这一通的窗口,缺省 {@link PLAYING_PRE_ARRIVAL_MS}。 */
  preArrivalMs?: number
  now?: () => number
  /** 定时器(测试注入)。回一个「取消它」的函数。 */
  setTimer?: (fn: () => void, ms: number) => () => void
  log?: (line: string) => void
}

export interface PlayingGate {
  /** 这一通那台手机说了「接起之后我会告诉你我在放了」(它发的 `start`/`answer` 带着那一格)。 */
  expect: (identity: string) => void
  /**
   * 它说「我这边在放了」。`warmMs` 是**它自己烘热输出等了多久**(新包带,老包没有)——
   * 只进日志,给统筹真机核那一行(凭什么开口、各等了多少)。
   */
  arrived: (identity: string, warmMs?: number) => void
  /** 这一通结束 / 挂断:清掉,别把上一通那一下算到下一通头上。 */
  reset: (why?: string) => void
  /** 等这一下(开场白排到点之后调它)。 */
  wait: () => Promise<PlayingGateOutcome>
}

export function createPlayingGate(options: PlayingGateOptions = {}): PlayingGate {
  const timeoutMs = Math.floor(options.timeoutMs ?? PLAYING_WAIT_MS)
  const preArrivalMs = Math.max(0, Math.floor(options.preArrivalMs ?? PLAYING_PRE_ARRIVAL_MS))
  const now = options.now ?? (() => Date.now())
  const setTimer = options.setTimer ?? ((fn, ms) => {
    const timer = setTimeout(fn, ms)
    timer.unref?.()
    return () => { clearTimeout(timer) }
  })
  const log = options.log ?? (() => {})

  /** 这一通等谁报(缺席 = 这台手机不报,或者这一通已经清了)。 */
  let expected: string | undefined
  /** 它报过了没有。 */
  let arrived = false
  /** 它自己烘热输出等了多久(只进日志)。 */
  let warmedMs: number | undefined
  /**
   * **比 `expect` 先到的那一条**(卡 OP):拨出那一路里它一定先到。记下是哪一台、什么时候,
   * `expect()` 再决定认不认。
   */
  let early: { identity: string, at: number, warmMs?: number } | undefined
  /** 正在等的那一趟:报到了就叫醒它。 */
  let wake: (() => void) | undefined

  /** 这一下报的烘热数写成一句(没有就不写,绝不编一个数)。 */
  const warmedText = (): string => (warmedMs === undefined ? '' : `,它自己烘热输出等了 ${Math.round(warmedMs)}ms`)

  return {
    expect(identity) {
      expected = identity
      /*
       * 先到的那一条认不认(卡 OP):同一台、在窗口之内才认。认了就不用再等 ——
       * 它的判据(输出真的在消化音频)本身就成立在「请她开口」之前,那正是这一路要的顺序。
       */
      const ok = early !== undefined && early.identity === identity && now() - early.at <= preArrivalMs
      arrived = ok
      warmedMs = ok ? early?.warmMs : undefined
      if (early !== undefined && !ok) {
        log(`[channel-worker] 开场白:先到的那条「在放了」不认(${early.identity === identity ? '过期了' : `是 ${early.identity} 报的`}),照旧等这一通自己那一下。`)
      }
      early = undefined
    },
    arrived(identity, warmMs) {
      /*
       * **还没收到这一通的接起**(拨出那一路的常态):记着,别丢 —— 丢了就是每通白等到上限。
       * 认不认由 `expect()` 判(同一台 + 没过期)。
       */
      if (expected === undefined) {
        early = { identity, at: now(), ...(warmMs === undefined ? {} : { warmMs }) }
        log(`[channel-worker] 开场白:${identity} 先说了「我这边在放了」(还没收到这一通的接起,记着)${warmMs === undefined ? '' : `,它自己烘热输出等了 ${Math.round(warmMs)}ms`}。`)
        return
      }
      // 报的不是这一通说话的那一台 → 不算(房里可能还有另一台手机、那只听筒)。
      if (identity !== expected) {
        log(`[channel-worker] 开场白:${identity} 说它在放了,可这一通说话的是 ${expected} —— 不算。`)
        return
      }
      arrived = true
      if (warmMs !== undefined) warmedMs = warmMs
      const resume = wake
      wake = undefined
      if (resume !== undefined) { try { resume() } catch { /* 叫醒失败不值得再出一个错 */ } }
    },
    reset(why) {
      if (expected !== undefined && why !== undefined) log(`[channel-worker] 开场白那道「在放了」的闸清掉了(${why})`)
      expected = undefined
      arrived = false
      warmedMs = undefined
      // 上一通那一下先到的也清掉:不许算到下一通头上。
      early = undefined
      const resume = wake
      wake = undefined
      // 正在等的那一趟当场放走:挂断之后不许还有人在等一句永远不来的话。
      if (resume !== undefined) { try { resume() } catch { /* 见上 */ } }
    },
    async wait() {
      const started = now()
      if (expected === undefined || timeoutMs <= 0) return { how: 'skipped', waitedMs: 0 }
      if (arrived) {
        log(`[channel-worker] 开场白:手机在请她开口之前就说它这边在放了(等了 0ms${warmedText()}),开口。`)
        return { how: 'playing', waitedMs: 0 }
      }
      let cancelTimer: (() => void) | undefined
      await new Promise<void>((resolve) => {
        wake = resolve
        cancelTimer = setTimer(() => { wake = undefined; resolve() }, timeoutMs)
      })
      try { cancelTimer?.() } catch { /* 取消定时器失败不值得再出一个错 */ }
      const waitedMs = Math.max(0, now() - started)
      if (arrived) {
        log(`[channel-worker] 开场白:手机说它这边在放了(等了 ${waitedMs}ms${warmedText()}),开口。`)
        return { how: 'playing', waitedMs }
      }
      if (expected === undefined) return { how: 'skipped', waitedMs }
      log(`[channel-worker] 开场白:等了 ${waitedMs}ms 手机还没说它这边在放了,照旧开口`
        + '(第一个字可能被吃;改上限:WORKBENCH_CHANNEL_OPENER_PLAYING_MS)。')
      return { how: 'timeout', waitedMs }
    },
  }
}
