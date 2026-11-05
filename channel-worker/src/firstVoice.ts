/**
 * **这一回合的第一句话,现生一句贴这件事的**(2026-10-03,卡「首声提速」乙;
 * 决策记录 10-03 早 ⑥丙)。
 *
 * ## 为什么
 *
 * Air 诊断包 10-02:act 路真回答的首声 p95 **3762ms**、真回答中位 **7860ms**,
 * 于是多数回合先垫一句**固定**的「我想想 / 稍等一下 / 让我看看」,再等好几秒。
 * 业界的尺子(`docs/设计-活人感标准与前端差距-2026-10-02.md` 第一节):
 * 500–1200ms 是自然窗,>1500ms 听着像没在听。
 *
 * 固定那几句的毛病不是慢,是**没有内容**:她说「让豆包查一下国庆放几天假」,
 * 听到的是「我想想」—— 一个真人这时候说的是「好,我这就去问豆包」。
 *
 * 所以这一层:act 路在真回答开始之前,**用一次又小又短的模型调用**出一句话,
 * 立刻念出去,真回答接在后面(插进去的路照旧是垫场那一条,见 workerFiller.ts)。
 *
 * ## 这一句话的边界(整件事最要紧的一节)
 *
 * 它是**在真回答之前**说的,那时候一件工具都还没跑过 —— 所以它**什么事实都不知道**。
 * 于是四条硬规矩,由 {@link cleanFirstVoice} 逐条当场检查(**不靠模型自觉**):
 *
 *   ① **只说「在办什么」,不说结果**:「我这就去问豆包」可以,「豆包说放八天」不行;
 *   ② **不许有数字**:进度、剩多少、几天、几点一律不许出现 —— 那些只能来自工具结果
 *      (AGENTS.md「不经模型的地方坚决不经模型」在这一层的样子);
 *   ③ **不许反问、不许自问自答**:这一句之后紧跟着的是真回答,一个问号会让她
 *      「问完自己答」(10-02 那张卡刚治过的毛病);
 *   ④ **不许念系统里的名词**(卡 / 事项 / 看板 / 栏位 / 等你确认 / 会话)——
 *      与 10-02「只说她关心的」同一份词。
 *
 * 一条不过就**整句作废**,这一回合退回固定那几句(宁可说「我想想」,也不说一句编出来的话)。
 *
 * ## 不许和后面矛盾
 *
 * 这一句进不了对话历史(垫场那条路的性质),真回答那一轮**不知道它说过什么** ——
 * 所以靠的不是「告诉模型别重复」,而是**让这一句本身没有可矛盾的内容**:
 * 它只说「我接下来去做什么」,而那件事正是模型那一轮要去做的事。
 *
 * 纯的:这个文件只认一个「去问一句」的函数({@link FirstVoiceAsk})与一个时钟,
 * 不认识 OpenAI、不认识 LiveKit、不认识 TTS。接线在 agent.ts。
 */

/**
 * 这一句最多几个字。超了就**作废**(不截断 —— 截一半的句子念出来更怪)。
 *
 * 14 个字:它念出来约两秒,而真回答排在它后面(workerFiller.ts 的 `FillerClip.whole`:
 * 首句不许被掐断)——
 * 也就是说这个数就是「她多等多久才听到真回答」的上限。固定那句「我想想。」是四个字,
 * 这一句贴着事情说,十个字上下够了(「好,我这就去问豆包。」正好十个字)。
 */
export const FIRST_VOICE_MAX_CHARS = 14

/** 问那一句最多等多久(毫秒)。到点就当没有,这一回合垫固定那句。 */
export const FIRST_VOICE_TIMEOUT_MS = 1_200

/** 让它最多吐几个 token。短输出本身就是这一层快的一半原因。 */
export const FIRST_VOICE_MAX_TOKENS = 40

/**
 * 给小模型看的那一段话。**短是它的全部意义** —— 电话人设有 3000 多字,
 * 这一段只有两百来字,少掉的那几千字就是省下来的首字时间。
 */
export const FIRST_VOICE_SYSTEM = [
  '你是她的事务官,正在跟她打电话。她刚说完一句话,你要在真正动手之前先应一句。',
  '只说一句话,最多 14 个字,像人说话,不要书面语。',
  '只说你接下来打算做什么(例:「好,我这就去问豆包。」「行,我去看一眼那条。」)。',
  '不许说任何结果、进度、数字;不许反问、不许带问号;不许提卡、事项、看板、会话这些词。',
  '只输出那一句话本身,不要引号、不要解释。',
].join('\n')

/** 办的是哪件事 → 给小模型的一句提示(认不出意图就不提)。只说**门类**,不替她编内容。 */
const INTENT_HINTS: Readonly<Record<string, string>> = {
  remember: '她要你记一笔。',
  dispatch: '她要你把一件事派出去。',
  relay: '她要你给某一家 AI 捎句话或者派件事。',
  operate: '她要你让电脑上某一家 AI 动手做一件事。',
  change: '她要你改一样东西。',
  pick: '她在挑一个。',
  callout: '她要你稍后给她打电话。',
  address: '她在说怎么称呼。',
  voice: '她要换嗓子。',
  file: '她在说文件。',
  find: '她要你去查一件事。',
  status: '她要你去看一眼状态。',
  lookup: '她在问你手上的事。',
}

/** 这一次要问什么。`said` 是她那一句的**原话**(识别结果),`intent` 是分流判出来的意图。 */
export interface FirstVoiceAskInput {
  said: string
  intent?: string
}

/** 问一句:给这两段话,回那一句(或者 undefined = 没问到)。**不许抛**由调用方保证。 */
export type FirstVoiceAsk = (input: { system: string, user: string }) => Promise<string | undefined>

/** 拼给小模型的那两段。 */
export function firstVoicePrompt(input: FirstVoiceAskInput): { system: string, user: string } {
  const hint = input.intent === undefined ? undefined : INTENT_HINTS[input.intent]
  const said = input.said.trim().slice(0, 200)
  return {
    system: FIRST_VOICE_SYSTEM,
    user: `${hint === undefined ? '' : `${hint}\n`}她刚说:「${said}」\n你先应的那一句:`,
  }
}

/**
 * 一句话里不许出现的系统名词。**以插件为源头,只许多不许少**(2026-10-22,卡「契约对照测试补齐」):
 * `workbench-plugin/src/server/channel.ts` 人设里「不念系统里的名词」那份,由
 * `channel-worker/tests/worker-protocol-shapes-sync.test.ts` 读插件源码比对(漂了那条红给你看)。
 * `item` 是工人这边多拦的英文系统词,不碍事。
 */
export const FIRST_VOICE_BANNED: readonly string[] = [
  '卡', '事项', '待办', '在办', '看板', '栏位', '状态', '状态栏', '等你确认', '未确认', '会话', '任务 id', 'item',
]

/**
 * 一句话里不许出现的「已经办好了」的话。这一句说在工具之前,**它不可能知道结果**。
 * (「好的」「行」不在这张表里 —— 那是语气,不是结果。)
 */
export const FIRST_VOICE_RESULT_WORDS: readonly string[] = [
  '已经', '办好', '办完', '做完', '完成', '查到', '问到', '收到回复', '回复了', '成了', '失败',
  '没成', '剩', '还有', '结果是', '一共', '搞定',
]

/** 过不了关的那几种(进日志那一格,一个词,数得出来)。 */
export type FirstVoiceReject =
  | 'empty'
  | 'too-long'
  | 'asking'
  | 'digits'
  | 'result'
  | 'banned'

export type FirstVoiceCheck =
  | { ok: true, text: string }
  | { ok: false, why: FirstVoiceReject }

/**
 * 模型吐回来的字 → 能不能念。**一条不过就整句作废**(文件头那四条)。
 *
 * 清洗只做「把它包装的壳剥掉」:前后空白、引号、markdown 的星号、多行只取第一行。
 * **一个字都不改写、不替它补标点** —— 改写就等于我们替它编了一句话。
 */
export function cleanFirstVoice(raw: string | undefined): FirstVoiceCheck {
  const firstLine = (raw ?? '').split('\n').map(one => one.trim()).find(one => one !== '') ?? ''
  const text = firstLine
    .replace(/^[*＊#\s]+/u, '')
    .replace(/[*＊\s]+$/u, '')
    .replace(/^["'「『“”]+/u, '')
    .replace(/["'」』“”]+$/u, '')
    .trim()
  if (text === '') return { ok: false, why: 'empty' }
  if ([...text].length > FIRST_VOICE_MAX_CHARS) return { ok: false, why: 'too-long' }
  // 反问:**全角与半角都认**(2026-10-03,卡 fix/voice-route-zh)。模型吐中文,
  // 吐出来的问号就是全角的 —— 只认 ASCII 等于这一条压根没开(审计 voice.md 第 1 条「同类旁证」)。
  if (/[?？]/u.test(text) || /(?:吗|呢)[。.!！、,，]?$/u.test(text)) return { ok: false, why: 'asking' }
  /*
   * 数字:阿拉伯的、以及**「一」以外**的汉字数字。
   *
   * 「一」故意放过:中文里它多半不是一个数,而是「一下 / 一眼 / 一句 / 一声」里的那个一
   * (「好,我去看一眼」是这一层最想要的句子)。「八天」「三成」「十分钟」「两个」那种
   * 一律作废 —— 它们只可能是编出来的,工具还一件都没跑过。
   */
  if (/[0-9０-９二三四五六七八九十百千万亿两零〇]/u.test(text)) return { ok: false, why: 'digits' }
  if (FIRST_VOICE_RESULT_WORDS.some(word => text.includes(word))) return { ok: false, why: 'result' }
  if (FIRST_VOICE_BANNED.some(word => text.includes(word))) return { ok: false, why: 'banned' }
  return { ok: true, text }
}

/** 这一回合首句的结局(进 `回合计时` 那一行与日志,一个词)。 */
export type FirstVoiceOutcome =
  /** 念出去了。 */
  | 'said'
  /** 合好了,但已经垫过 / 已经出过真声 —— 扔掉了。 */
  | 'late'
  /** 问了,模型没回话(超时 / 出错)。 */
  | 'failed'
  /** 回了话,但过不了那四条。 */
  | 'rejected'
  /** 合不出声音(8792 没答应 / 换音色撞上了)。 */
  | 'unvoiced'

/**
 * **这一拍还算不算数**(2026-10-03,卡 fix/voice-route-zh;审计 voice.md 附证 A)。
 *
 * 为什么 `speak` 要收它:合成那一句要几百毫秒到一两秒,而她在这段时间里完全可能又说了一句。
 * 轮号在**问之前**与**问回来之后**各比过一次,中间少的就是这一次 —— 合成回来、
 * 交给共享的那条垫场路**之前**。少了它,上一回合的首句会垫进新回合
 * (她听见的是「我已改口,她仍在回答上一件事」)。
 */
export interface FirstVoiceGuard {
  /** 真 = 这一拍还是当前那一回合。假 = 整句扔掉(回 `late`)。 */
  current: () => boolean
}

export interface FirstVoiceOptions {
  ask: FirstVoiceAsk
  /**
   * 把那一句合成成音频、交给垫场那条路。回的就是结局里那三种之一:
   * `said` 念出去了 / `late` 来晚了(已经垫过或已经出过真声)/ `unvoiced` 合不出声音。
   *
   * `guard` 是**合成完之后**那一道关口(见 {@link FirstVoiceGuard}):交出去之前问一声
   * 「这一拍还算不算数」,不算就回 `late`,一帧都不许进新回合。
   */
  speak: (text: string, guard: FirstVoiceGuard) => Promise<Extract<FirstVoiceOutcome, 'said' | 'late' | 'unvoiced'>>
  timeoutMs?: number
  now?: () => number
  log?: (line: string) => void
  /** 这一回合的结局(计时那一行读它)。 */
  onDone?: (result: { outcome: FirstVoiceOutcome, ms: number, text?: string, why?: FirstVoiceReject }) => void
}

/**
 * 一回合一次:问一句 → 查四条 → 交给垫场那条路念出去。
 *
 * 三条纪律:
 *   ① **绝不抛**。首句是好意,不是主线 —— 它坏掉的样子必须是「这一回合垫固定那句」;
 *   ② **一回合只问一次**({@link start} 带轮号,对不上的那一拍整个丢掉)。轮号在**三处**比:
 *      问回来、查完四条、**以及合成完交给垫场那条路之前**({@link FirstVoiceGuard});
 *      回合收尾时另有 {@link cancel}(下一回合可能压根不 start);
 *   ③ **到点不等**:{@link FIRST_VOICE_TIMEOUT_MS} 一过就当没有。
 */
export class FirstVoice {
  readonly #options: FirstVoiceOptions
  readonly #timeoutMs: number
  readonly #now: () => number
  readonly #log: (line: string) => void
  #seq = 0

  constructor(options: FirstVoiceOptions) {
    this.#options = options
    this.#timeoutMs = options.timeoutMs ?? FIRST_VOICE_TIMEOUT_MS
    this.#now = options.now ?? (() => Date.now())
    this.#log = options.log ?? (() => {})
  }

  /** 第几次(轮号;测试与「这一拍过时了」用)。 */
  get seq(): number { return this.#seq }

  /**
   * 开一句(**不等**)。再开一句就把上一句**作废**(她又说了一句 = 新的一回合,
   * 上一拍问出来的那句话已经对不上她刚说的了)。
   * 回一个 Promise 只为让用例等得到,生产里**不 await**。
   */
  start(input: FirstVoiceAskInput): Promise<void> {
    this.#seq += 1
    const mine = this.#seq
    return this.#run(input, mine).catch(() => { /* 见纪律 ① */ })
  }

  /**
   * **这一回合完了,在飞的那一句作废**(2026-10-03,卡 fix/voice-route-zh;审计附证 A)。
   *
   * 为什么不能只靠 {@link start} 推轮号:下一回合**可能压根不会 start**
   * (判成闲聊的回合不现生首句),那时轮号不动,还在合成的那一句回来之后
   * 看上去仍然「算数」,就垫进了新回合。接线在 agent.ts 回合收尾那一处(与 `routing.end()` 同一处)。
   *
   * 它**不启动新的一问** —— 只把轮号推走。
   */
  cancel(): void {
    this.#seq += 1
  }

  async #run(input: FirstVoiceAskInput, mine: number): Promise<void> {
    const began = this.#now()
    const done = (outcome: FirstVoiceOutcome, extra: { text?: string, why?: FirstVoiceReject } = {}): void => {
      const ms = this.#now() - began
      try { this.#options.onDone?.({ outcome, ms, ...extra }) }
      catch { /* 记一笔失败不值得再出一个错 */ }
      const what = extra.text === undefined ? '' : `「${extra.text}」`
      const why = extra.why === undefined ? '' : `(${extra.why})`
      this.#log(`[channel-worker] 这一回合的首句:${outcome}${what}${why},${ms}ms`)
    }

    let raw: string | undefined
    try { raw = await this.#withTimeout(this.#options.ask(firstVoicePrompt(input))) }
    catch { raw = undefined }
    if (mine !== this.#seq) return
    if (raw === undefined) { done('failed'); return }

    const checked = cleanFirstVoice(raw)
    if (!checked.ok) { done('rejected', { why: checked.why }); return }
    if (mine !== this.#seq) return

    let spoken: Extract<FirstVoiceOutcome, 'said' | 'late' | 'unvoiced'> = 'unvoiced'
    try { spoken = await this.#options.speak(checked.text, { current: () => mine === this.#seq }) }
    catch { spoken = 'unvoiced' }
    if (mine !== this.#seq) return
    done(spoken, { text: checked.text })
  }

  async #withTimeout(pending: Promise<string | undefined>): Promise<string | undefined> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), this.#timeoutMs)
      timer.unref?.()
    })
    try { return await Promise.race([pending, timeout]) }
    finally { if (timer !== undefined) clearTimeout(timer) }
  }
}
