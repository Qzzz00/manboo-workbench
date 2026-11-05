/**
 * **没调成工具,不许说办了**(2026-10-12,卡「通话补一句不丢事」第 3 条;纪律同 D13:不说没发生的事)。
 *
 * 10-12 真机:他插了一句「有回音的打给我。」,那一回合判成闲聊、手上一件工具都没有,
 * 她回「好,派给 Claude 查为什么通话中换不了音色。有回音打给你。」—— jobs.jsonl 里一条派活都没有。
 * 人设与 `intentToolNote` 里早就写着「一个结果都不许说成已经办了」,模型照样说;
 * 能机器执行的规矩就机器执行(同 sentenceCap.ts 那条),所以在流上拦。
 *
 * 判法(一句一判,纯的):
 *   · 这一句里有一个「办事的动词」({@link CLAIM_VERBS}:派给 / 换成 / 记下 / 发给你 / 捎过去 / 打给你 …);
 *   · 而且说的是**办了 / 正在办**:带「了 / 好了 / 已经 / 这就 / 马上」,或者整句以「好 / 行 / 可以」起头
 *     (真机那句「好,派给 Claude 查……」一个「了」都没有);许诺回电那一类(「有回音打给你」)本身就算;
 *   · 不算的:问句、动词前面紧挨着「没 / 不 / 别」、说的是之前的事(「刚才 / 上午 / 已经在」)、假设(「如果 / 要是」)。
 *
 * 流上(一回合里**没有一件工具办成**、而且这一步模型也没调工具时):
 *   · 不说办了的句子逐句照放,不憋;
 *   · 从第一句说办了的那句起**整段憋住**;这一步里跟着出现了工具调用 → 原样放(「好,我派给 Claude。」+ 真调);
 *     流结束都没有 → 换成一句如实的问话({@link honestLine}),后面的字不念。
 *   换成问句是故意的:她下一句「好」就是对这一问的批准,分流那边会带着工具去办(turnRoute.ts 的 `pendingAsk`)。
 *
 * 纯的:不认识 LiveKit。agent.ts 告诉它两件事 —— 这一回合拦不拦、有没有一件工具办成了。
 */
import { REPORT_INTENTS, looksLikeAsking } from './turnRoute.ts'

/** 说办了的是哪一类事(决定换成哪一句如实的话)。 */
export type ClaimKind = 'dispatch' | 'relay' | 'voice' | 'remember' | 'file' | 'callout' | 'layout'

/** 一类事一组「办事的动词」。**只认动词带结果补语的那几种写法**,「我去安排」「我记一下」这种打算不在里面。 */
export const CLAIM_VERBS: readonly { kind: ClaimKind, re: RegExp }[] = [
  { kind: 'dispatch', re: /派(?:给|了|好|出去|过去|下去)|安排(?:了|好|给|上)|交给了|转给了/u },
  { kind: 'relay', re: /捎(?:给|了|过去|到|好)|转告了|(?:话|消息|信息)(?:已经)?(?:发|传)(?:过去|到)/u },
  { kind: 'voice', re: /换(?:成|好|了|上|过来|到)/u },
  { kind: 'remember', re: /记(?:下|好|住|上|了|进)/u },
  { kind: 'file', re: /(?:发|传)(?:给你|过去了|好了)/u },
  { kind: 'callout', re: /打给你|给你打|回你电话|提醒你/u },
  { kind: 'layout', re: /挪(?:到|好|了|过去)|放到了|改好了/u },
]

/** 说的是「办了 / 正在办」的那几个记号。 */
const DONE_MARK = /了|已经|这就|马上|现在就|正在|给你(?:换|派|记|发)/u
/** 整句以应承起头(「好,派给 Claude 查……」)。 */
const AGREE_HEAD = /^(?:好的?|行|可以|嗯|收到|没问题|ok)[,，、 ]?/iu
/** 动词前紧挨着的否定(三个字以内)。 */
const NEGATED = /[没不别未]|无法/u
/**
 * ★ **整句以否认 / 只是起头**(2026-10-13,卡「三个入口一套管线」第 ④ 处)。
 *
 * 10-13 早真机:她诚实地说「没派,我只记了」——「记了」命中记一笔那个动词,
 * 而「没」在句首、不在动词前三个字里,于是这一句被换成了
 * 「我还没记下,要我现在记吗?」(她刚说的就是这个意思,被换成了一句废话)。
 *
 * 所以:**整句以否认起头的一律放行**。她在否认或者在说「我只做了 X」时,
 * 那一句本身就是如实的 —— 这道闸是为「她说办了而其实没办」造的,不是为诚实的话造的。
 */
const DENIAL_HEAD = /^(?:[我她他它]?(?:没有|没|不是|不|并没有|并没|并不|只是|只|仅|仅仅|压根|根本))/u
/** 说的是之前的事 / 假设 —— 那不是这一回合「办了」。 */
const NOT_NOW = /刚才|刚刚|之前|上午|下午|早上|昨天|前面|上次|那会|已经在|如果|要是|的话/u
/** 句首的语气标签(「[平静]」),手机拿它驱动表情;判句子时不算,换话时留着。 */
const TONE_TAG = /^\s*\[[^\]\n]{1,8}\]/u

/** 这一句在说「办了」吗。说了就回是哪一类,没说回 `undefined`。 */
export function claimOf(sentence: string): { kind: ClaimKind } | undefined {
  const text = sentence.replace(TONE_TAG, '').trim()
  if (text === '') return undefined
  if (looksLikeAsking(text)) return undefined
  if (NOT_NOW.test(text)) return undefined
  // 2026-10-13:她在否认 / 在说「我只做了 X」—— 那一句是如实的,放行(见 DENIAL_HEAD)。
  if (DENIAL_HEAD.test(text)) return undefined
  let best: { kind: ClaimKind, at: number } | undefined
  for (const verb of CLAIM_VERBS) {
    const hit = verb.re.exec(text)
    if (hit === null) continue
    const before = text.slice(Math.max(0, hit.index - 3), hit.index)
    if (NEGATED.test(before)) continue
    if (best === undefined || hit.index < best.at) best = { kind: verb.kind, at: hit.index }
  }
  if (best === undefined) return undefined
  if (best.kind === 'callout' || DONE_MARK.test(text) || AGREE_HEAD.test(text)) return { kind: best.kind }
  return undefined
}

/** 换成的那一句如实的话。**一律是问句**(理由见文件头)。 */
export function honestLine(kind: ClaimKind): string {
  return {
    dispatch: '我还没派出去,要我现在去派吗？',
    relay: '话我还没捎过去,要我现在去捎吗？',
    voice: '音色我还没换,要我现在换吗？',
    remember: '我还没记下,要我现在记吗？',
    file: '文件我还没发,要我现在发吗？',
    callout: '回电我还没安排上,要我现在安排吗？',
    layout: '版面我还没改,要我现在改吗？',
  }[kind]
}

/** 这一回合拦不拦。闲聊拦;要办事的拦,除非这一句只是在查一眼(`REPORT_INTENTS`:那里的「已经派了」是在报以前的事)。 */
export function guardsTurn(decision: { route: 'chat' | 'act', intents?: readonly string[] }): boolean {
  /*
   * ★ 介绍自己那一回合不拦(2026-10-14 凌晨,卡 Z):她在**描述**能做什么(「把发布计划记进日历,这些现在就能做」),
   * 不是在许愿;0.4.129 真机那一通被改写成「我还没记下,要我现在记吗?」。意图 id 与工作台 `introKnowledge.ts` 同一个字。
   */
  if ((decision.intents ?? []).includes('intro')) return false
  if (decision.route === 'chat') return true
  const intents = decision.intents ?? []
  if (intents.length === 0) return true
  return intents.some(one => !REPORT_INTENTS.includes(one))
}

/** 句末(含换行):到这儿算一句。 */
const END = /[。!?！？\n]/u

export interface HonestClaimsOptions {
  /** 这一回合拦不拦(闲聊 / 要办事 / 只查一眼,见 {@link guardsTurn});不拦就原样返回那条流。 */
  active: boolean
  /** 这一回合**已经有一件工具办成了**(那时的「办了」是在报结果)。每一句现问一次。 */
  mayClaim: () => boolean
  /**
   * ★ **这一通里这一类已经换过一次了吗**(2026-10-13,卡「三个入口一套管线」第 ④ 处)。
   *
   * 10-13 早真机:同一通里「我还没记下,要我现在记吗?」说了**三次**(其中一次在已经记下之后)。
   * 换一次是「如实说一句、问她要不要办」;换三次就是复读机。换过一次之后这一类**放行** ——
   * 她那句话由她自己负责,日志里那一行还在。缺席 = 不记次数(行为与 10-12 那一版相同)。
   */
  alreadyRewrote?: (kind: ClaimKind) => boolean
  /** 真换了一句的时候记一笔(与 {@link alreadyRewrote} 配着用)。 */
  noteRewrote?: (kind: ClaimKind) => void
  /**
   * ★ **按真实状态说**(2026-10-13)。这一回合有工具跑过**而且自己报了没成**时,
   * 换上的那一句该说「那一下没成:<原因>」,而不是「我还没派出去」(那是两种不同的事实)。
   * 回 `undefined` = 没有更真的话可说 → 用 {@link honestLine}。
   */
  insteadOf?: (kind: ClaimKind) => string | undefined
  /** 换了一句,记一行(她原话、换成什么)。 */
  onRewrite?: (said: string, instead: string) => void
}

/** 真实状态那一句:工具跑过、它自己说没成。 */
export function failedLine(why: string): string {
  const flat = why.replace(/\s+/g, ' ').trim()
  return `那一下没成:${flat.length > 60 ? `${flat.slice(0, 60)}…` : flat}`
}

/**
 * 包 `llmNode` 的输出(字符串或 ChatChunk,同 sentenceCap.ts)。判法与憋 / 放的规矩见文件头。
 * 工具调用与 usage 那几块原样过(先把憋着的字放出去,顺序不乱)。
 */
export function withHonestClaims<T>(base: ReadableStream<T>, options: HonestClaimsOptions): ReadableStream<T> {
  if (!options.active) return base
  let pending = ''
  let held: string | undefined
  let open = false
  let lastWasString = true
  let lastId = 'honest'
  const emit = (controller: TransformStreamDefaultController<T>, text: string): void => {
    if (text === '') return
    controller.enqueue((lastWasString ? text : { id: lastId, delta: { role: 'assistant', content: text } }) as T)
  }
  /** 这一步不用再拦了(调了工具 / 已经办成过):憋着的、半句的都放出去。 */
  const release = (controller: TransformStreamDefaultController<T>): void => {
    open = true
    emit(controller, `${held ?? ''}${pending}`)
    held = undefined
    pending = ''
  }
  const take = (controller: TransformStreamDefaultController<T>, text: string): void => {
    if (open || options.mayClaim()) { release(controller); emit(controller, text); return }
    if (held !== undefined) { held += text; return }
    pending += text
    for (;;) {
      const at = pending.search(END)
      if (at < 0) return
      const sentence = pending.slice(0, at + 1)
      const claim = claimOf(sentence)
      // 2026-10-13:这一类这一通里已经换过一次了 → 放行(换三次就成了复读机,见 `alreadyRewrote`)。
      if (claim !== undefined && options.alreadyRewrote?.(claim.kind) === true) {
        release(controller)
        emit(controller, pending)
        pending = ''
        return
      }
      if (claim !== undefined) {
        held = pending
        pending = ''
        return
      }
      emit(controller, sentence)
      pending = pending.slice(at + 1)
    }
  }
  return base.pipeThrough(new TransformStream<T, T>({
    transform(chunk, controller) {
      if (typeof chunk === 'string') { lastWasString = true; take(controller, chunk); return }
      const one = chunk as { id?: unknown, delta?: { content?: unknown, toolCalls?: unknown[] } } | null
      if (typeof one?.id === 'string') lastId = one.id
      const delta = one?.delta
      const hasTools = Array.isArray(delta?.toolCalls) && delta.toolCalls.length > 0
      if (delta !== undefined && typeof delta.content === 'string' && delta.content !== '') {
        lastWasString = false
        take(controller, delta.content)
        if (hasTools) {
          release(controller)
          controller.enqueue({ ...(chunk as object), delta: { ...delta, content: '' } } as T)
        }
        return
      }
      if (hasTools) release(controller)
      controller.enqueue(chunk)
    },
    flush(controller) {
      if (open || options.mayClaim()) { release(controller); return }
      if (held === undefined && pending !== '' && claimOf(pending) !== undefined) {
        held = pending
        pending = ''
      }
      if (held === undefined) { emit(controller, pending); return }
      const said = held
      const firstEnd = said.search(END)
      const claim = claimOf(firstEnd < 0 ? said : said.slice(0, firstEnd + 1))
      const kind = claim?.kind ?? 'dispatch'
      // 2026-10-13:换过一次就不再换(同上面那一处)。
      if (options.alreadyRewrote?.(kind) === true) { emit(controller, said); return }
      const tag = TONE_TAG.exec(said)?.[0].trim() ?? ''
      // 2026-10-13:有更真的话可说就说那一句(工具跑过、它自己报没成),没有才回到那一问。
      const instead = `${tag}${options.insteadOf?.(kind) ?? honestLine(kind)}`
      try { options.noteRewrote?.(kind) }
      catch { /* 记一笔失败不许把这一句带走 */ }
      try { options.onRewrite?.(said, instead) }
      catch { /* 记一行失败不许把这一句带走 */ }
      emit(controller, instead)
    },
  }))
}
