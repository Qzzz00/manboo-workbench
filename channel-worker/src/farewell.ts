/**
 * **他道别 → 她回一句 → 由她挂**(2026-09-23 晚,维护者真机 0.2.73:「说了拜拜之后没有真的拜拜」)。
 *
 * ## 已拍板(维护者)
 *
 * 他说「拜拜 / 再见 / 先这样 / 没事了挂了吧」这类**明确结束**的话 → 她回一句简短道别 →
 * **由她挂断**,而且**等她那句道别真正播完**再挂(话没说完就断不行)。
 * 「拜拜」出现在转述里(「他跟我说了拜拜」)、或者他道别之后紧接着又说了新的事,**不能挂**。
 *
 * ## 谁决定「要挂」:模型,不是关键词
 *
 * 模型通过一件工具 {@link TOOL_END_CALL} 说「要挂」;工人记下来,**等她这一段话收尾**
 * (框架把 agent_state 落回 `listening`)再多等一小截输出队列({@link FAREWELL_TAIL_MS}),才真挂。
 *
 * 关键词在这里只干两件**往「不挂」那边偏**的小事,不替模型拍板:
 *   1. **闲聊回合要不要把这件工具递给她**({@link offersEndCall})。回合分流把「拜拜」「再见」判成闲聊,
 *      闲聊回合一件工具都不给(turnRoute.ts)—— 不递这一件,模型就是想挂也挂不了。
 *      所以闲聊回合**只在像道别时**多给这一件,别的闲聊照旧零工具、照旧快。
 *   2. **一票否决**({@link endCallVeto}):他这一回合的原话里,道别词是转述的、是「别挂」、
 *      或者道别之后还跟着一件新的事 —— 模型就算调了,也回一句「没挂」让她接着聊。
 *      没有道别词**不否决**(「好嘞,就到这吧」由模型判);否决只会让她少挂,不会让她多挂。
 *
 * ## 这个文件里没有 LiveKit
 *
 * 状态机({@link createFarewellHangup})只吃三样:她的状态、他在不在说话、他说了什么;
 * 真挂那一下是注进来的回调(agent.ts 里复用挂断那一条路:`ring.hangup` / `callState.leave` /
 * `callRecord.finish`)。所以误挂的几条边都能在单测里走完。
 */

/** 那件工具的名字。 */
export const TOOL_END_CALL = 'wb_end_call'

/**
 * 像道别的词。**只拿来递工具、拿来否决**,不拿来直接挂(见文件头)。
 * 「挂了 / 挂吧 / 挂电话」是他明说要挂;「没事了」多半跟在「好」后面收尾。
 */
export const FAREWELL_WORDS: readonly string[] = [
  '拜拜', '再见', '先这样', '就这样吧', '就这样了', '没事了', '挂了', '挂吧', '挂电话', '挂掉',
  '回头聊', '回头再说', '下次聊', '晚安', 'bye',
]

/**
 * 道别词后面跟着**也不算新事**的那些:语气词、客气话、再说一遍拜拜。
 * 长的排前面(先吃「谢谢你」再吃「谢谢」)。
 */
const TRAILING_POLITE: readonly string[] = [
  '辛苦了', '谢谢你', '谢谢啦', '谢谢', '谢了', '好的', '好嘞', '老板', '拜拜', '再见', '晚安', 'bye',
  '啦', '了', '哈', '呀', '啊', '吧', '哦', '喔', '嘛', '咯', '嗯', '哟', '呗', '噢', '你',
]

/** 标点与空白:算「什么都没说」。 */
const PUNCT = /[\s,.!?~，。！？、;；:：…—\-'"“”‘’「」()（）]/u

/** 转述:「他跟我说了拜拜」「她说再见」「叫我挂了」—— 道别词前面紧挨着一个「说 / 讲 / 叫 / 让」。 */
const REPORTED = /(说|讲|叫|让|喊)(我|你|他|她|我们|他们)?(了)?(一声|一句|句|声)?[「“"'‘]?$/u

/** 「别挂」「不挂了」「先别挂」「不要挂」—— 道别词里带「挂」、前面紧挨着否定。 */
const NEGATED = /(别|不|不要|不用|先别|没)$/u
/** 「先别挂」这种一个道别词都不含的,整句里找。 */
const DONT_HANG = /(别|不要|不用|先别|不)挂/u

function lower(text: string): string {
  return text.toLowerCase()
}

/** 他这句话里**最后一个**道别词在哪儿(找不到就 undefined)。 */
function lastFarewell(text: string): { word: string, at: number } | undefined {
  const t = lower(text)
  let best: { word: string, at: number } | undefined
  for (const word of FAREWELL_WORDS) {
    const at = t.lastIndexOf(word)
    if (at < 0) continue
    // 同一处命中取更长的那个(「挂电话」比「挂」长,「就这样吧」比「就这样」长)。
    if (best === undefined || at > best.at || (at === best.at && word.length > best.word.length)) best = { word, at }
  }
  return best
}

/** 道别词后面还剩下的「正经话」(语气词、客气话、标点都吃掉之后)。 */
function trailingContent(rest: string): string {
  let left = lower(rest)
  for (;;) {
    const before = left
    left = left.replace(/^\s+/u, '')
    while (left.length > 0 && PUNCT.test(left[0]!)) left = left.slice(1)
    for (const polite of TRAILING_POLITE) {
      if (left.startsWith(polite)) { left = left.slice(polite.length); break }
    }
    if (left === before) return left
  }
}

/**
 * **一票否决**:他这一回合的原话说明「这不是在跟她道别」。回一句给模型看的理由;不否决回 undefined。
 *
 * - 原话是空的(没识别结果、打字那条路)→ **不否决**,由模型判;
 * - 一个道别词都没有 → **不否决**,由模型判(「好嘞,就到这吧」);
 * - 任何一个道别词是**转述**(前面紧挨着「说 / 讲 / 叫 / 让」)→ 否决;
 * - 「挂」字那几个前面紧挨着**否定**(「别挂了」「不挂了」)→ 否决;
 * - **最后一个**道别词后面还有正经话(「拜拜,对了明天提醒我开会」)→ 否决。
 */
export function endCallVeto(heard: string): string | undefined {
  const text = heard.trim()
  if (text === '') return undefined
  const t = lower(text)
  if (DONT_HANG.test(t)) return `没挂:他说的是别挂(「${text.slice(0, 40)}」)。接着跟他聊。`
  let any = false
  for (const word of FAREWELL_WORDS) {
    let from = 0
    for (;;) {
      const at = t.indexOf(word, from)
      if (at < 0) break
      any = true
      const before = t.slice(Math.max(0, at - 6), at)
      if (REPORTED.test(before)) return `没挂:他是在转述别人的话(「${text.slice(0, 40)}」),不是在跟你道别。接着跟他聊,别说再见。`
      if (word.startsWith('挂') && NEGATED.test(before)) return `没挂:他说的是别挂(「${text.slice(0, 40)}」)。接着跟他聊。`
      from = at + word.length
    }
  }
  if (!any) return undefined
  const last = lastFarewell(text)
  if (last === undefined) return undefined
  const more = trailingContent(text.slice(last.at + last.word.length))
  if (more !== '') {
    return `没挂:他道别之后又说了别的事(「${more.slice(0, 30)}」)。先把这件事接住,别说再见;`
      + '他办完这件再道别时再挂。'
  }
  return undefined
}

/**
 * **闲聊回合要不要把挂断那件工具递给她**。像道别、而且没被一票否决才递。
 * 要办事的回合(`act`)本来就带全套工具,不看这个。
 */
export function offersEndCall(heard: string): boolean {
  const text = heard.trim()
  if (text === '') return false
  if (lastFarewell(text) === undefined) return false
  return endCallVeto(text) === undefined
}

/* ──────────────────── 道别进固定流程(2026-10-13 下午,卡 A 第 2 条) ──────────────────── */

/**
 * ★ **道别不进模型:认出来就固定一句,然后挂**(2026-10-13 下午,维护者真机 0.4.119)。
 *
 * ## 现场(`~/.dsh/workbench/logs/channel-worker.log`,14:02 那一通)
 *
 * ```
 * 他说(ASR):好了，告诉我，拜拜。
 * 8791 听懂了:append/normal → 打 /butler/item/say(补进刚开始那件事「…云南瓦剌猫…」)
 * 固定流程 append → /butler/item/say:没办成,说「这件事的会话没开,说不进去」
 * 她说:这件事的会话没开,说不进去                      ← 道别被当成补细节,念了接口的字
 * ```
 *
 * 同一天另一通走的是模型那条路:模型正文先说「拜拜。」,调 `wb_end_call` 之后又说
 * 「好,拜拜。」—— **一通里道别了两遍**(工具说明里写着「说过道别就别再说」,模型没听)。
 *
 * 所以这一句从今天起**排在「听懂」那一问之前**:认出来 → 不问 8791、不问模型 →
 * 固定一句 {@link FAREWELL_FIXED_SAY} → 走现有那台挂断状态机({@link createFarewellHangup})。
 *
 * ## 为什么要比 `offersEndCall` 更紧
 *
 * `offersEndCall` 是给**模型递不递那件工具**用的 —— 递错了还有模型兜着。
 * 这一条是**直接挂电话**,所以多一道门:**整句要短**({@link FAREWELL_SAY_MAX_CHARS} 字)。
 * 「帮我做个视频,然后就这样吧」里也有道别词,可他先交代了一件事 —— 那种照旧交给模型
 * (`wb_end_call` 与 {@link endCallVeto} 在那条路上一个字没动)。
 */
export const FAREWELL_FIXED_SAY = '好,拜拜。'

/**
 * 走固定流程的那句道别最长多少字(连标点)。12 —— 今天那句「好了,告诉我,拜拜。」是 10 字,
 * 而「帮我做个视频,然后就这样吧」13 字:再长就先当他有事要说,交给模型。
 */
export const FAREWELL_SAY_MAX_CHARS = 12

/**
 * 他这一回合的原话是**一句干净的道别**吗(固定流程那一道的判据)。
 * 是 → 回 {@link FAREWELL_FIXED_SAY};不是 → `undefined`(照老路:8791 → 模型)。
 */
export function farewellFixedSay(heard: string): string | undefined {
  const text = (heard ?? '').trim()
  if (text === '') return undefined
  if ([...text].length > FAREWELL_SAY_MAX_CHARS) return undefined
  return offersEndCall(text) ? FAREWELL_FIXED_SAY : undefined
}

/** 工具回给模型的那一句(同意挂)。 */
export const END_CALL_ACCEPTED_TEXT = '好,系统会在你说完道别之后替你挂断。现在只说一句简短的道别'
  + '(比如「好,拜拜」「好的老板,回头见」),不要再问问题、不要再提别的事。'
  + '你这一步如果已经说过道别了,就什么都不要再说。'

/** 工具说明(模型看的)。**转述与「道别后又说新事」两条写在前面** —— 否决只是兜底。 */
export const END_CALL_DESCRIPTION = '他**明确要结束这通电话**时调用:「拜拜」「再见」「先这样」「没事了,挂了吧」。'
  + '调用之后系统会在你说完道别**之后**替你挂断,你不用自己说「我挂了」。'
  + '**这几种不要调**:他在转述别人说的话(「他跟我说了拜拜」);他道别之后紧接着又说了新的事'
  + '(「拜拜,哦对了明天提醒我开会」—— 先办那件事);他说「别挂」;你拿不准他是不是要走。'
  + '调完只说一句**简短**的道别,别再问问题。'

// ———————————————————————— 状态机 ————————————————————————

/** 她那一段话收尾之后再等多久才挂(毫秒):音频输出队列 ~200ms + 房间到听筒 / 手机那一跳。 */
export const FAREWELL_TAIL_MS = 800

/**
 * 他在她道别时**出过声**(被打断、或者只是噪声)之后,再等多久(毫秒)。
 * 要给识别结果留出时间:他真说了话,最终结果到了就取消;只是噪声,到点照挂。
 */
export const FAREWELL_USER_TAIL_MS = 2000

/**
 * 从模型说「要挂」起最多等多久(毫秒)。她的状态一直没回到 `listening`(框架卡住)时的保险丝;
 * **他正在说话时不挂**,到点也不挂。
 */
export const FAREWELL_MAX_WAIT_MS = 20_000

export interface FarewellTimer { cancel: () => void }

export interface FarewellDeps {
  /** 真挂。**只会被调一次**(每次 `request` 至多一次)。 */
  hangup: () => void
  setTimer?: (fn: () => void, ms: number) => FarewellTimer
  log?: (line: string) => void
  tailMs?: number
  userTailMs?: number
  maxWaitMs?: number
}

export interface FarewellHangup {
  /** 模型调了挂断那件工具。**已经在等就不重来**(回 false)。 */
  request: () => boolean
  /** 她的状态(`initializing`/`listening`/`thinking`/`speaking`/`idle`)。 */
  agentState: (state: string) => void
  /** 他开口 / 停口(框架的 user_state)。 */
  userSpeaking: (speaking: boolean) => void
  /** 他说的一句最终识别结果。**等挂的时候他又说了话 → 不挂了**。 */
  heard: (text: string) => void
  /** 这一通已经由别的路收场了(他自己挂、掉线、人走了):忘掉,别再挂一次。 */
  reset: () => void
  /** 这会儿是不是在等着挂。 */
  readonly pending: boolean
}

export function createFarewellHangup(deps: FarewellDeps): FarewellHangup {
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => {
    const handle = setTimeout(fn, ms)
    return { cancel: () => clearTimeout(handle) }
  })
  const log = deps.log ?? (() => {})
  const tailMs = deps.tailMs ?? FAREWELL_TAIL_MS
  const userTailMs = deps.userTailMs ?? FAREWELL_USER_TAIL_MS
  const maxWaitMs = deps.maxWaitMs ?? FAREWELL_MAX_WAIT_MS

  let pending = false
  /** 她这一段还没收尾。`request` 那一刻**一律当她还在这一回合里**(工具就是在回合里调的)。 */
  let busy = false
  let userOn = false
  /** 等挂的时候他出过声。 */
  let userStirred = false
  let tail: FarewellTimer | undefined
  let guard: FarewellTimer | undefined

  function clearTail(): void { tail?.cancel(); tail = undefined }
  function clearAll(): void {
    clearTail()
    guard?.cancel()
    guard = undefined
  }

  function fire(why: string): void {
    if (!pending) return
    pending = false
    clearAll()
    log(`[channel-worker] 她道过别了,挂断(${why})`)
    try { deps.hangup() }
    catch (err) { log(`[channel-worker] 挂断那一下出错了:${(err as Error)?.message ?? '没说原因'}`) }
  }

  function evaluate(): void {
    if (!pending) return
    if (busy || userOn) { clearTail(); return }
    if (tail !== undefined) return
    tail = setTimer(() => { tail = undefined; fire('她那一段说完了') }, userStirred ? userTailMs : tailMs)
  }

  return {
    request() {
      if (pending) return false
      pending = true
      busy = true
      userStirred = false
      guard = setTimer(() => {
        guard = undefined
        if (!pending) return
        if (userOn) { log('[channel-worker] 等挂等到了上限,但他正在说话:不挂'); return }
        fire('等她说完等到了上限')
      }, maxWaitMs)
      log('[channel-worker] 她说要挂了:等她这句道别播完再挂')
      return true
    },

    agentState(state) {
      busy = state === 'thinking' || state === 'speaking'
      evaluate()
    },

    userSpeaking(speaking) {
      userOn = speaking
      if (speaking && pending) userStirred = true
      evaluate()
    },

    heard(text) {
      if (!pending) return
      const said = text.trim()
      if (said === '') return
      pending = false
      clearAll()
      log(`[channel-worker] 等挂的时候他又说话了(「${said.slice(0, 40)}」):不挂了,接着聊`)
    },

    reset() {
      pending = false
      busy = false
      userStirred = false
      clearAll()
    },

    get pending() { return pending },
  }
}
