/**
 * **开场那一句:念完才起算、音轨掐得断、她开口那一下的字别丢**(2026-10-13,
 * 卡「来电开场」;交接 `docs/交接-1013-来电开场重复与打断.md`)。
 *
 * (这个文件里 **他 / 她接电话的那一位** = 举着听筒的人,**事务官** = 念开场白的那一位 ——
 * 与 bargeIn.ts / backchannel.ts 同一个口径,只是这一通是她接起来的,所以下面写「她」。)
 *
 * ## 现场(维护者 11:40 真机,0.4.118,豆包普通包出题 → 座机响 → 她接起来)
 *
 * ```
 * 来电开场白首段 44 字(固定句)
 * 她接起来 3 秒没吭声:把那件事再说一遍(只一次)
 * 回合计时 #1 {"tts_first_ms":634,"tts_all_ms":3501,"mouth_ms":639,…}
 * 来电开场白(再说一遍)首段 44 字
 * 真打断,把她掐住(他开口 1201ms 之后,他连着说了 1200ms,一个字都没识别出来)
 * 想掐她没掐动:This generation handle does not allow interruptions
 * ```
 *
 * 维护者原话:「有电话出来了,但是…我无力吐槽了」。三处毛病是**同一条链**上的三环:
 *
 *   ① **「3 秒不吭声」从念第一个字就起算**,而那句 44 字要 3.5 秒(`tts_all_ms:3501`)才念完 ——
 *      第一遍还没念完第二遍就接上了,听筒里是两个声音在念同一句话。
 *      → 这一份改成**从那一句真的念完**(框架 `SpeechHandle.waitForPlayout()`:TTS 推完 + 播完)
 *      **再**起算 {@link RING_OPENER_REPEAT_MS};
 *   ② **那条音轨掐不动**:开场白是 `session.say(..., { allowInterruptions: false })` 念的
 *      (`OPENER_SAY_OPTIONS`,09-27 卡 CL:允许打断的那一支要先 `await userSilenceEvent`、
 *      还会在第一帧之前 `reconcilePlayoutPause()` 把播出按住 —— 免提摆在桌上 VAD 一直听见声音,
 *      那道暂停就一直不放,09-27 现场因此 0.7 秒合好、33 秒没出房)。
 *      于是她答题时框架报 `This generation handle does not allow interruptions`,声音盖着她。
 *      → **不动 `say` 那一下的参数**(09-27 那一脚不能再踩),改成**她真的出声了之后**
 *      把那只把手翻成「可打断」({@link OpenerCutIn}:`handle.allowInterruptions = true`,
 *      框架 1.9 的 setter,`speech_handle.d.ts` 第 139 行)。那时第一帧已经转发出去了,
 *      `reconcilePlayoutPause` 与 `userSilenceEvent` 两道都已经过去,翻过来只剩「能掐」这一件;
 *   ③ **她那 1.2 秒的话一个字都没识别出来**:同一格的另一半 ——
 *      `agent_activity.js` 第 1081–1086 行 `shouldDiscardInputAudio()`:当前这一句不许打断时
 *      (`discardAudioIfUninterruptible` 缺省 `true`)**麦克风的帧在进识别之前被换成静音**,
 *      而且 2099 行 `commitUserTurn` 还会把这一回合整个丢掉
 *      (`skipping user input, current speech generation cannot be interrupted`)。
 *      VAD 听得见(所以兜底那只手数到了 1200ms),识别拿到的是一整段静音 ——
 *      来电这一通她说的第一句往往**就是答案**(「茶」「第二个」),那一句丢了整通就白打。
 *      → 同 ② 一处治:那一格每一帧现问一次(1063 行的 TransformStream),
 *      翻成「可打断」的下一帧起她的话就照样送识别、照样成回合。
 *
 * ## 谁掐、谁只管「掐得动」
 *
 * **掐不掐由 bargeIn.ts 那一处判**(应声不算打断那条规矩只有那一份)。这个文件
 * **一次 `interrupt()` 都不调**:她开口(VAD 判到人声,不等 ASR 出字)时只做两件事 ——
 * 把「再说一遍」撤掉、把把手翻成可打断。一声「嗯」照旧不该把开场白掐断,
 * 那个判断不在这儿抄第二份。
 *
 * 纯的:不认识 LiveKit、不认识房间,只认一只有 `allowInterruptions` / `waitForPlayout` 的把手。
 * 时钟与计时器都注入。
 */

/* 「再说一遍」等多久那个数只有 callOut.ts 一份(这里只是把它摆进文档与缺省值)。 */
import { RING_OPENER_REPEAT_MS } from '../callOut.ts'

/**
 * 等「那一句真念完」的上限(毫秒)。到点就当念完了,照旧起算那 3 秒。
 *
 * 为什么要有个顶:`waitForPlayout()` 等的是框架把这一句走完 —— TTS 卡住、
 * 对端把音轨退订了的时候它可能一直不回。那时候她举着听筒听见的是**一片安静**,
 * 所以宁可再说一遍。
 *
 * ## ★ 2026-10-13 下午:从 12 秒改成 20 秒(卡 A 第 7 条)
 *
 * 上一版写的理由是「12 秒 = 42 字那一句最慢也念得完(11:40 那通 3.5 秒)的三倍多」——
 * **那 3.5 秒看错了一格**:`tts_all_ms` 是「所有音频帧推完」,不是「播完」。
 * 一句 44 字的中文念出来本身就有 9~10 秒,再加前导静音与首包,整句走完要 11~13 秒。
 * 真机 14:17 那一通正是这样:
 *
 * ```
 * 来电开场白首段 44 字
 * 开场白等了 12001ms 还没播完,当它念完了起算(TTS 卡住 / 音轨被退订时宁可再说一遍)。
 * 回合计时 #6 {"tts_first_ms":675,"tts_all_ms":3988,"llm_gen_ms":12848,…}   ← 真念完是 12.8 秒
 * ```
 *
 * 也就是说顶**比正常念完还短** —— 这一版那条「念完才起算」在长句上等于没生效,
 * 到点起算的 3 秒有可能正落在她还在念的时候,又变成两个声音念同一句话(这张卡要治的正是它)。
 * 同一通里 14:06 那一句 25 字:`tts_all_ms:1709`,真念完 5897ms —— 同一个比例。
 *
 * 20 秒 = 上限 42 字那一句真念完(13 秒上下)再留一截余量。
 */
export const OPENER_PLAYOUT_CAP_MS = 20_000

/** 框架给的那只「这一句」的把手。只用得上这三样,好让用例不必起一个真的 LiveKit 会话。 */
export interface OpenerSayHandle {
  /** 1.9 起这是个 setter(改成 `true` = 这一句从现在起掐得动)。 */
  allowInterruptions?: boolean
  /** 这一句整段播完(含 TTS 推完)才回。 */
  waitForPlayout?: () => Promise<void>
  /** 这一句已经走完了吗。 */
  done?: () => boolean
}

/**
 * **「她真的出声了」之后把开场那几句翻成可打断**(上面 ②③)。
 *
 * 为什么是「出声了之后」而不是 `say` 那一下:理由在文件头 ②(09-27 卡 CL 那一脚)。
 * 口径取框架的 `agent_state === 'speaking'` —— 它正是第一帧转发出去那一刻
 * (`agent_activity.js` 的 `onFirstFrame` → `tryStartAgentSpeech`),比任何自己数的毫秒都准。
 *
 * **开场那几句都托给它**(来电开场、再说那一遍、提机招呼、固定开场白):四条路同一个毛病,
 * 只修来电那一条的话,她提起听筒抢着说的第一句照旧会被丢掉。
 */
export interface OpenerCutIn {
  /** 这一句是开场那一类的,出声之后要翻。`why` 只进日志。 */
  track: (handle: OpenerSayHandle | undefined, why: string) => void
  /** 事务官真的出声了(`agent_state` → `speaking`):把攒着的都翻过来。 */
  outLoud: () => void
  /** 这一通收了 / 这一句不用管了:攒着的全忘掉(不翻)。 */
  clear: () => void
}

export function createOpenerCutIn(options: { log?: (line: string) => void } = {}): OpenerCutIn {
  const log = options.log ?? (() => {})
  const waiting = new Map<OpenerSayHandle, string>()
  return {
    track(handle, why) {
      if (handle === undefined) return
      if (typeof handle.waitForPlayout !== 'function' && !('allowInterruptions' in handle)) return
      waiting.set(handle, why)
    },
    outLoud() {
      for (const [handle, why] of waiting) {
        waiting.delete(handle)
        try {
          if (handle.done?.() === true) continue
          if (handle.allowInterruptions === true) continue
          handle.allowInterruptions = true
          log(`[channel-worker] ${why}已经出声了:这一句从现在起掐得动(她开口的那几个字也照样进识别)。`)
        }
        catch (err) {
          // 翻不过来(框架换了行为、这一句已经被掐了):如实记一行,不装作翻了。
          log(`[channel-worker] ${why}这一句没能翻成可打断:${(err as Error)?.message ?? '没说原因'}`)
        }
      }
    },
    clear() { waiting.clear() },
  }
}

export interface OpenerRepeatDeps {
  /**
   * 念一遍开场白。回框架那只把手;拿不到(老框架、`say` 抛了)就回 `undefined` ——
   * 那时退回「说出去就算念完了」那条老路(照旧会重复一遍,只是起算点不准)。
   */
  say: (round: 'first' | 'again') => OpenerSayHandle | undefined
  /** 这一通还是她接起的那一通吗(她挂了 / 换了一通 → false)。每次用时现问。 */
  live: () => boolean
  /** 出声之后翻把手那一处(与提机那几句同一个)。 */
  cutIn: OpenerCutIn
  /** 念完之后等多久再说第二遍。缺省 {@link RING_OPENER_REPEAT_MS}。`<= 0` = 不重复。 */
  repeatMs?: number
  /** 等「真念完」的上限,缺省 {@link OPENER_PLAYOUT_CAP_MS}。 */
  playoutCapMs?: number
  now?: () => number
  /** 定时器(测试注入)。回一个「取消它」的函数。 */
  setTimer?: (fn: () => void, ms: number) => () => void
  log?: (line: string) => void
}

export interface OpenerRepeatRun {
  /** 接起那一刻:念第一遍 → 等它真念完 → 没人吭声再念一遍(只一次)。**不抛**。 */
  start: () => Promise<void>
  /**
   * 她开口了(VAD 判到人声,**不等 ASR 出字**):「再说一遍」撤掉,
   * 正在念的那一句翻成可打断(掐不掐由 bargeIn.ts 判)。
   */
  sheSpoke: (why: string) => void
  /** 这一通收了(她挂了 / 换了一通):什么都不再做。 */
  stop: () => void
  /** 用例读的:念了几遍。 */
  rounds: () => number
}

/** 开场那一句的「念完再起算」。一通电话一台,`stop()` 之后不再动。 */
export function createOpenerRepeat(deps: OpenerRepeatDeps): OpenerRepeatRun {
  const log = deps.log ?? (() => {})
  const now = deps.now ?? (() => Date.now())
  const setTimer = deps.setTimer ?? ((fn, ms) => {
    const timer = setTimeout(fn, ms)
    timer.unref?.()
    return () => { clearTimeout(timer) }
  })
  const capMs = Math.floor(deps.playoutCapMs ?? OPENER_PLAYOUT_CAP_MS)
  const repeatMs = Math.floor(deps.repeatMs ?? RING_OPENER_REPEAT_MS)
  let stopped = false
  let rounds = 0
  let cancelRepeat: (() => void) | undefined

  /** 这一句真的念完了吗:`waitForPlayout` 与上限赛跑。**不抛**。 */
  async function playedOut(handle: OpenerSayHandle | undefined): Promise<void> {
    const wait = handle?.waitForPlayout
    if (handle === undefined || typeof wait !== 'function') {
      log('[channel-worker] 开场白:框架没给「这一句念完了」的把手,按说出去那一刻起算(可能早 2~3 秒)。')
      return
    }
    const started = now()
    let cancel: (() => void) | undefined
    const cap = new Promise<'cap'>((resolve) => { cancel = setTimer(() => resolve('cap'), capMs) })
    let how: 'played' | 'cap'
    try { how = await Promise.race([wait.call(handle).then(() => 'played' as const), cap]) }
    catch { how = 'played' }
    finally { try { cancel?.() } catch { /* 取消定时器失败不值得再出一个错 */ } }
    const waitedMs = Math.max(0, now() - started)
    log(how === 'played'
      ? `[channel-worker] 开场白念完了(整句播完用了 ${waitedMs}ms),从这会儿起算 ${repeatMs}ms。`
      : `[channel-worker] 开场白等了 ${waitedMs}ms 还没播完,当它念完了起算(TTS 卡住 / 音轨被退订时宁可再说一遍)。`)
  }

  function armRepeat(): void {
    if (stopped || repeatMs <= 0 || !deps.live()) return
    cancelRepeat = setTimer(() => {
      cancelRepeat = undefined
      if (stopped || !deps.live()) return
      log(`[channel-worker] 她接起来、开场白念完 ${repeatMs}ms 还没吭声:把那件事再说一遍(只一次)`)
      rounds += 1
      deps.cutIn.track(say('again'), '来电开场白(再说一遍)')
    }, repeatMs)
  }

  function say(round: 'first' | 'again'): OpenerSayHandle | undefined {
    try { return deps.say(round) }
    catch (err) {
      log(`[channel-worker] ${round === 'first' ? '开场那一句' : '再说一遍那一句'}没说出去:${(err as Error)?.message ?? '没说原因'}`)
      return undefined
    }
  }

  return {
    async start() {
      if (stopped) return
      rounds += 1
      const first = say('first')
      deps.cutIn.track(first, '来电开场白')
      await playedOut(first)
      /*
       * 这中间她开口了 / 挂了 —— 那一句就不说了。`stopped` 在 `sheSpoke` / `stop` 里置上;
       * 「还是这一通吗」现问一次(等播完这几秒里换了一通的话,第二遍会念错那件事)。
       */
      if (stopped || !deps.live()) return
      armRepeat()
    },
    sheSpoke(why) {
      if (stopped) return
      stopped = true
      try { cancelRepeat?.() } catch { /* 同上 */ }
      cancelRepeat = undefined
      /*
       * 她的声音一到就把把手翻过来(兜一道:`agent_state` 那一下没来 / 来晚了的时候),
       * 于是 bargeIn.ts 判出真打断时 `session.interrupt()` 掐得动。**这里不自己掐**。
       */
      deps.cutIn.outLoud()
      log(`[channel-worker] 她开口了(${why}):开场白不再重复了`)
    },
    stop() {
      stopped = true
      try { cancelRepeat?.() } catch { /* 同上 */ }
      cancelRepeat = undefined
      deps.cutIn.clear()
    },
    rounds: () => rounds,
  }
}
