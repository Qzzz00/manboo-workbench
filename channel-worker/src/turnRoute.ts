/**
 * 回合分流:**这一句要不要带着工具去调模型**(2026-09-23)。
 *
 * ## 为什么有这个文件(Ben 2026-09-23 12:40,真机 0.2.68)
 *
 * > 「现在不管说什么都要说『我想想』……我问他是谁,也要想想,我觉得这里是不是可以把 Jev 接进来啊。」
 *
 * 那一通的 `GET /channel/latency` 逐字摆在这儿:带工具的回合 `llm_first_ms` 2253 / 3435,
 * 闲聊回合 830–1175。缓冲语的门是 0.7 秒(butler-app 的 `FILLER_WAIT_MS`),
 * 于是**每一个回合都过了门**,连「你是谁」也垫一句「我想想」。
 *
 * 病根不在缓冲语,在**分流发生得太晚**:以前每一回合都把全部工具塞给模型,
 * 由模型自己决定这一轮要不要用。工具的说明书进了提示词、首字就慢,
 * 而他那一句其实只是「你是谁」。
 *
 * 所以这一版把判断挪到**调模型之前**:
 *
 *   - `chat`(闲聊、问她是谁、寒暄、应答)→ **一件工具都不给**,不垫缓冲语;
 *   - `act`(查事项、记东西、派单、换音色、问记忆、问进度)→ 照旧给全套工具、垫缓冲语。
 *
 * **拿不准按 `act`**(卡上原话:宁可慢别错)。少给一件工具的代价是「她本来能办的事办不了」,
 * 那比慢一秒难收拾得多。
 *
 * ## 两件实现,同一个接口
 *
 *   - {@link RulesTurnRouter} —— 关键词表,**默认就是它**。0 毫秒、0 成本、判据能一条条数出来。
 *   - `JevTurnRouter`(jevRouter.ts)—— 云端决策模型,**没有 key 时整个模块都不加载**
 *     (见 {@link createTurnRouter} 里的动态 import)。接不接由离线对照跑出来的数说了算,
 *     不由「听起来更聪明」说了算(docs/设计-事务官自进化闭环-2026-09-23.md 2.4)。
 *
 * 选谁:`WORKBENCH_CHANNEL_TURN_ROUTER=rules|jev`,缺省 `rules`。
 *
 * 纯数据结构 + 一个 fetch(在 jevRouter.ts 里):这个文件不认识 LiveKit、不认识 session。
 * 接线在 agent.ts 的 `llmNode`(调模型前的最后一道关口)。
 */
import type { CallRoute } from './butlerRoute.ts'
import { classifyCallTurn } from './butlerRoute.ts'

/** 这一回合归哪条路。 */
export type TurnRoute =
  /** 闲聊:工人自己的小模型直接答,**不带工具**,不垫缓冲语。 */
  | 'chat'
  /** 要办事:带全套工具,垫缓冲语。 */
  | 'act'

/** 一次判定的结果。**每一格都要能说出口** —— 日志、体检页、离线评估读的都是它。 */
export interface TurnDecision {
  route: TurnRoute
  /** 谁判的:`rules` / `jev` / `none`(压根没判,例如开场白那种没有识别结果的回合)。 */
  router: string
  /** 凭什么判的。人话一句,写进日志 —— 「她为什么没带工具」必须查得出来。 */
  reason: string
  /** 判这一次花了多久(毫秒)。规则法是 0~1,Jev 是一次跨境 HTTP。 */
  ms: number
  /** 有多确信(0–1)。规则法不给(缺席);Jev 给它自己那个 confidence。 */
  confidence?: number
  /**
   * 办的是哪件事({@link ACT_INTENTS} 的 `id`)。**只有 `act` 的回合才可能有**,
   * 认不出意图时缺席。
   */
  intent?: string
  /**
   * 这一句命中的**全部**意图(2026-10-03,卡 fix/voice-route-zh)。
   *
   * 为什么要这一格:10-03 早上起 `intent` 不再只决定「先应哪一句」,它还决定
   * **这一回合手上有哪几件工具**(intentTools.ts)。只留第一个命中的意图时,
   * 「把文件发给我,再换个音色」这一句手上只剩换音色那一件 —— 她嘴上应了,文件没发。
   *
   * 所以工具按这一格的**并集**下发({@link intentsOf} 的顺序),
   * 而 `intent` 那一格**还是第一个** —— 她先说哪一句、`回合计时` 那一行一个字没改。
   */
  intents?: readonly string[]
  /**
   * 调模型之前**先应的那一句**(2026-09-23 下午,维护者:「我说我想换音色,她还是说了『我想想』」)。
   * 缺席 = 认不出意图,退回原来的垫场(「我想想」类)。
   */
  ack?: string
  /**
   * **这一句是补进一件还没办完的事里的**(2026-10-12,卡「通话补一句不丢事」)。值是那件事前面几句的原话。
   * 有它 = 意图与工具沿用那件事、不再先应一句;llmNode 补一行 {@link followUpNote}。见 {@link TurnRouting.start}。
   */
  followUp?: string
  /** **这一句是在接着刚办过 / 刚问过的那件事答话**(2026-10-12)。值是那件事的原话;llmNode 补一行 {@link carryNote}。 */
  carriedFrom?: string
  /**
   * **马上能答**(2026-10-12,电话先应收窄):这一句命中的意图全在 {@link QUICK_INTENTS} 里。
   * 这样的回合不先应、不现生首句、不垫场,交给模型直接答 —— 见 {@link turnOpening}。
   */
  quick?: true
}

/**
 * 判这一句时**这一刻的处境**(2026-10-02)。只有一格,而且是数出来的,不经模型。
 *
 * 为什么要它:同样一句「可以」,事务官刚问完一句时是**批准**(要工具),
 * 刚报完一个结果时只是**应答**(不要工具)。差别不在那句话里,在上一句里。
 */
export interface TurnContext {
  /** 上一回合事务官挂着一问,正等她回话。见 {@link RulesOptions.pendingAsk}。 */
  pendingAsk?: boolean
  /** 这一通正在介绍模式里(她问过「你是谁 / 介绍一下自己」)。见 {@link RulesOptions.introMode}。 */
  introMode?: boolean
  /**
   * **紧挨着的上一回合办过的那件事**(2026-10-12)。由 {@link TurnRouting} 填,调用方不用管。
   * 见 {@link RulesOptions.carry}。
   */
  thing?: CarriedThing
}

/** 刚办过 / 刚问过的那件事:原话 + 判出来的意图(承接用)。 */
export interface CarriedThing {
  text: string
  intent?: string
  intents?: readonly string[]
}

/** 一件分流实现。**同步还是异步由实现自己决定**,调用方一律 await。 */
export interface TurnRouter {
  /** 叫什么(进日志与体检页的那一格)。 */
  readonly name: string
  /**
   * 这一句该走哪条路。**不许抛** —— 判不出来是一回事,把电话带走是另一回事。
   * `context` 缺席 = 不知道上一句是什么(第一句、补话),实现自己兜。
   */
  route: (text: string, context?: TurnContext) => Promise<TurnDecision>
}

/**
 * 事务官上一句是**问句**吗(2026-10-02)。一条规则,不经模型 ——
 * 「上一句是不是在问她」必须是一件数得出来、复得现的事。
 *
 * 认三种:问号、结尾的「吗 / 呢 / 吧」、以及「A 还是 B」「哪一条」这种选择问。
 * 认不出就回 false(按「没挂问」处理):真要办事的那几句另有 {@link FOLLOW_ACT_WORDS} 兜着。
 *
 * **全角与半角都认**(2026-10-03,卡 fix/voice-route-zh;审计 voice.md 第 1 条):
 * 这几条当时只有 ASCII 的 `?` `!` `,`,而事务官嘴里出来的、ASR 听回来的中文标点
 * **一律是全角** —— 于是「我帮你取消吗?」整句没判成问句,她接下来那句「好的」
 * 被当成应答、零工具,听着像「口头应承、实际没动」。
 */
export function looksLikeAsking(said: string | undefined): boolean {
  const text = typeof said === 'string' ? said.trim() : ''
  if (text === '') return false
  if (/[?？]/.test(text)) return true
  if (/(?:吗|呢|吧|行不|对不对|好不好)[。.!！、,，]?$/u.test(text)) return true
  return /(?:还是|哪一?[个条家件样])[^。.!！?？]{0,12}$/u.test(text)
}

/**
 * **事务官上一句把这件事留着开口吗**(2026-10-12,卡「通话补一句不丢事」第 2 条)。
 *
 * 问句({@link looksLikeAsking})之外,**先应那一句**也算:「好,我挑几个给你听」说完,
 * 这件事明明还开着、正等着办,10-12 真机上她紧跟着那句「要女生的」却因为上一句不是问句被判成闲聊。
 * 先应那几句是定死的({@link ACK_LINES}),逐字比,不猜。
 */
export function butlerLeftOpen(said: string | undefined): boolean {
  const text = typeof said === 'string' ? said.trim() : ''
  if (text === '') return false
  return looksLikeAsking(text) || ACK_LINES.includes(text)
}

// ———————————————————————— 规则实现 ————————————————————————

/**
 * ——— 「办的是哪件事」与**先应的那一句**(2026-09-23 下午)———
 *
 * 维护者 14:20 真机原话:「我说我想换音色,她还是说了『我想想』。」
 *
 * 「我想想」是**认不出意图**时才该说的话。他说的是「换音色」,该听见的是
 * 「好,我挑几个给你听」—— 一句话就把「我听懂了、我这就去办」说清楚了,
 * 而「我想想」只说明她还在想。
 *
 * 所以这张表把「要办事的词」按**意图**分了组,每组带一句**先应的话**:
 *
 *   - 这张表**就是** {@link ACT_WORDS}(下面 flatMap 出来的,不是另抄一份)——
 *     分流判哪条路、先应哪一句,共用同一份词。抄成两份必然各自漂;
 *   - **顺序就是判据**:`find` 从上往下,第一个命中的说了算。所以顺序没动过
 *     (记东西 → 派活 → 换音色 → 交给事务官 → 文件),改顺序等于改行为;
 *   - 应的那一句**按当前音色预合成**(tts/greeting.ts 的 `GreetingCache`,与开场白同一张缓存),
 *     换音色时跟着整张重合成。**没合好就一句都不应**,退回原来的垫场(「我想想」)——
 *     现合成要一两秒,那时候说这一句只会撞上她真正的回答。
 */
export interface ActIntent {
  /** 进日志与体检页的那一格。 */
  readonly id: string
  /**
   * 先应的那一句。**缺席 = 认不出意图**,退回原来的垫场(「我想想」类)。
   * 维护者 的原话:「认不出意图才用『我想想』类。」
   */
  readonly ack?: string
  /** 命中这一组的词。一句话里出现就算。 */
  readonly words: readonly string[]
}

export const ACT_INTENTS: readonly ActIntent[] = [
  {
    // 记东西(prefs.ts 判「以后都算数」是下一步的事,这里只管「他要我记」)。
    // 2026-10-12 起不先应:记一笔是本机工具、马上就好,「好,我记一下」+「记下了」是两句说一件事。
    id: 'remember',
    /*
     * 2026-10-13 下午(卡 B′):「你帮我记到日历上面去啊」原先一个词都不命中 →
     * 判成闲聊、**零工具**,而她要的那一条就没了下文(那一通里模型自己编了一件
     * `wb_calendar_add`,再拿派活那件去建卡)。「记到日历 / 记进发布计划」这几个字
     * 归「记一笔」这一组 —— 那一组手上有 `wb_publish_plan`(intentTools.ts 的 NOTE_BUNDLE)。
     */
    words: [
      '记下', '记一下', '记住', '记着', '记录一下', '记个',
      '记到日历', '记进日历', '记在日历', '加到日历', '记到月历', '记进发布计划', '排进发布计划', '记到发布计划',
    ],
  },
  {
    // 派活
    id: 'dispatch',
    ack: '好,我去安排。',
    words: ['派单', '派个', '派一张', '派给', '需求卡', '开一张', '建一张', '建个事项', '加一张'],
  },
  {
    // 换音色(他在电话里当场换,交接-0923-通话交回本体 第四节)——**维护者 14:20 点名的那一条**
    id: 'voice',
    ack: '好,我挑几个给你听。',
    words: ['换音色', '换个音色', '换一个音色', '换个声音', '换一个声音', '换嗓子', '换个嗓子'],
  },
  {
    // 交给事务官本尊 = 派给本体,和上面那一组是同一件事的两种说法,所以应的也是同一句
    id: 'dispatch',
    ack: '好,我去安排。',
    words: ['交给事务官', '告诉事务官', '让事务官', '问事务官'],
  },
  {
    /**
     * 文件。**故意没有 `ack`**:维护者 那四条里没有这一类,这里不替他编一句。
     * 认不出意图 = 退回「我想想」,和这一版之前一字不差。要给它一句,加一行 `ack` 就是了
     * (决策记录同日,**可推翻**)。
     */
    id: 'file',
    words: ['发给我', '找一下文件', '把文件'],
  },
]

/**
 * 「要办事」的词。**一句话里出现就算**。
 *
 * 这是一张**数据表**,不是一串 if:加一个词不该改一行逻辑。
 * 从 {@link ACT_INTENTS} 摊平而来(**同一份词**,不另抄一份);
 * 事项与记忆那两类也没有重抄 —— 它们在 butlerRoute.ts 里,
 * 那张表同时管着「这一句该不该交回本体」,两处同一份词才不会各自漂。
 */
export const ACT_WORDS: readonly string[] = ACT_INTENTS.flatMap(one => [...one.words])

/**
 * 「查进度 / 问事项 / 问记忆」那一类(短句问事与 butlerRoute 那两类共用)。
 * 2026-10-12 起**没有先应句**:查一眼马上能答,「我看一眼」之后紧跟答案就是两句。
 */
export const LOOKUP_INTENT: ActIntent = { id: 'lookup', words: [] }

/**
 * 「给某条会话捎句话」那一类(2026-10-03,卡「首声提速」甲)。
 *
 * 2026-10-03 之前这一类和 {@link LOOKUP_INTENT} 共用一个意图 id(`lookup`)——
 * **先应的那一句一个字没改**(照旧「我看一眼。」,所以她嘴里听不出任何差别),
 * 分出一个 id 只为一件事:捎话手上该有的那几件工具与「查一眼」不是同一组
 * (`intentTools.ts` 的对照表)。
 */
export const RELAY_INTENT: ActIntent = { id: 'relay', ack: '我看一眼。', words: [] }

/**
 * ——— **马上能答的意图**(2026-10-12,维护者:「跟事务官电话真的好啰嗦」)———
 *
 * 先应只留给**真要动手、而且要等好几秒**的事(派活、换音色、捎话:要调别家、要合成试听)。
 * 下面这几类工具都在本机、一来一回就有结果,先应一句再报结果等于一件事说两句;
 * 它们也不现生首句、不垫场 —— 交给模型直接答。
 *
 * 一句话里**全是**这几类才算快(「看一下进度,然后把窗口关掉」不算);
 * 认不出意图的回合不算快(照旧现生首句 / 垫场)。
 */
export const QUICK_INTENTS: ReadonlySet<string> = new Set(['remember', 'lookup', 'find', 'status', 'address'])

/** 这一句命中的意图是不是全都马上能答。一个都没命中 = 不知道,不算快。 */
export function isQuickTurn(intents: readonly string[] | undefined): boolean {
  return intents !== undefined && intents.length > 0 && intents.every(one => QUICK_INTENTS.has(one))
}

/**
 * 这一回合开口怎么开(agent.ts 照这一格走,不在那边按意图另判):
 *   - `ack`:先应那一句预合成好的话(定死的三句,见 {@link ACK_LINES});
 *   - `filler`:要办事但没有先应句 → **固定的中性垫场**(「嗯,我看看。」那一类,filler.ts);
 *   - `none`:闲聊、或者马上能答 → 一个字都不先说,交给模型。
 *
 * ★ **2026-10-13:`first-voice`(现生首句)关了**(维护者 10-13 早原话:「现生首句三次许愿
 * 『好,我这就去弄 / 问问豆包 / 跟它说』而没动」)。那一句是小模型现编的,它许的愿常常
 * 没有发生 —— 定死的垫场句说的是「我在看」,不许愿,所以不会变成假话。
 * 现生首句那一层(firstVoice.ts)**代码还在**、用例还钉着,只是 act 回合不再起它
 * (`WORKBENCH_CHANNEL_FIRST_VOICE` 那个开关只管那一层自己)。
 */
export function turnOpening(decision: Pick<TurnDecision, 'route' | 'ack' | 'quick'>): 'ack' | 'filler' | 'none' {
  if (decision.route !== 'act' || decision.quick === true) return 'none'
  return decision.ack === undefined ? 'filler' : 'ack'
}

/**
 * 要预合成哪几句先应的话。**去重**(「好,我去安排。」被两组共用)。
 * agent.ts 把它连同开场白一起丢进同一张缓存里预热。
 */
export const ACK_LINES: readonly string[] = [...new Set(
  [...ACT_INTENTS, LOOKUP_INTENT, RELAY_INTENT].map(one => one.ack).filter((one): one is string => one !== undefined),
)]

/**
 * 「这一句你已经应过了」。带着它去调模型,否则她的第一句话十有八九是
 * 把「好,我挑几个给你听」再说一遍 —— 他刚听完一模一样的那句。
 *
 * 和开场白那一行(tts/greeting.ts 的 `greetedNote`)是同一条规矩,只是这一条
 * **一个回合就过期**,所以它不走提示词(`updateInstructions` 是异步的、抢不赢回合提交),
 * 走的是 `llmNode` 里那份 chatCtx 的副本。接线在 agent.ts。
 */
export function ackedNote(line: string): string {
  return `你刚刚已经应了他一句「${line}」(系统替你念出去了,他听见了)。`
    + '接着直接去办、或者直接说结果,**不要再应一次**、不要说「我想想」「稍等」之类的话。'
    // 2026-10-12(维护者:「电话好啰嗦」):那一句已经占了这一轮的额度,结果要一句话说完 —— 多的会被掐掉。
    + '这一轮你只剩一句话:把结果用一句话说完,别铺垫、别复述他的话。'
}

/**
 * 这一次调模型的上下文 + 那一行(**在副本上**加,原来那一份一个字不动)。
 *
 * 这里**只认两个方法**(`copy` / `addMessage`),不 import 框架的类型 ——
 * 这个文件仍然不认识 LiveKit,而用例可以拿一个十行的假上下文把这一条钉住。
 */
export interface AckChatContext {
  copy(): AckChatContext
  addMessage(params: { role: 'system', content: string }): unknown
}

export function withAckedTurn<T extends AckChatContext>(ctx: T, line: string): T {
  const said = line.trim()
  if (said === '') return ctx
  return withTurnNote(ctx, ackedNote(said))
}

/**
 * **只对这一回合算数的一行**,补在上下文的**副本**上(2026-10-03 从 {@link withAckedTurn}
 * 里提出来 —— 工具按意图下发那一条也要补这样一行,见 `intentTools.ts` 的 `intentToolNote`)。
 *
 * 为什么不走提示词:`updateInstructions` 是异步的,抢不赢回合提交(真机 `commit_ms` 5~40ms),
 * 而且它会留到下一回合、还会往对话历史里塞一条系统消息。空话不补。
 */
export function withTurnNote<T extends AckChatContext>(ctx: T, note: string): T {
  if (note.trim() === '') return ctx
  const copy = ctx.copy() as T
  copy.addMessage({ role: 'system', content: note })
  return copy
}

/**
 * 「就是说说话」的词。**只在没命中 {@link ACT_WORDS} 时才看**。
 *
 * 分两半:
 *   - {@link GREETING_WORDS}:短句寒暄(整句就那么几个字才算,否则
 *     「你好,上周那件事怎么样了」会被当成寒暄);
 *   - 下面这一张:长句里也算数的 —— 应答、否定、评价、问她自己。
 *     他 09-23 那一通里大半句子是**在点评她**(「你像个机器人」「非常套公式」),
 *     那些话要的是一句回应,不是一次工具调用。
 */
export const CHAT_WORDS: readonly string[] = [
  /*
   * 收尾。**应答那几个词 2026-10-02 挪去了 {@link ANSWER_WORDS}**
   * (「明白」「知道了」「好的」「好吧」「行吧」)—— 它们要过 `pendingAsk` 那道闸:
   * 事务官刚问完一句的时候,「好的」是批准,不是应答。收尾这几个不用过闸:
   * 「挂了」「再见」在任何上下文里都不是批准。
   */
  '没事了', '先这样', '挂了', '再见', '拜拜',
  '你讲', '你说吧', '继续说',
  // 问她自己那几句 2026-10-13 夜挪去了 {@link INTRO_WORDS}(还是闲聊,但要带「介绍自己」那份材料)。
  // 否定与纠正(这一通里最多的一类)
  '不是的', '不对', '我不是说', '我的意思是',
]

/**
 * **短句**才算数的「要办事」词。整句 {@link SHORT_ACT_MAX_CHARS} 字以内命中才算。
 *
 * 为什么要分出这一张表:真机那一通里「什么事啊?」(五个字)是他在问她手上有什么事,
 * 她当场调了 `wb_list_doing`;而同一个「什么事」出现在
 * 「先说有什么事要我确认,然后……」那种**点评**长句里时,他根本没让她去查。
 * 一个词在短句里是问话、在长句里只是半截定语 —— 这张表就是这件事在代码里的样子。
 */
export const SHORT_ACT_WORDS: readonly string[] = ['什么事', '有什么', '忙什么', '什么进展']

/** 短句「要办事」的长度上限(字)。 */
export const SHORT_ACT_MAX_CHARS = 12

/** 短句寒暄。整句 {@link GREETING_MAX_CHARS} 字以内命中才算。 */
/**
 * ★ **问她自己**(2026-10-13 夜,卡 V;维护者经工作台捎话:「识别到对方问『能够介绍一下自己吗』就触发这个模式,记住,是通话中」)。
 *
 * 还是闲聊路(零工具、不垫场),但这一回合要带上人设里那一段【介绍自己】(8791 下发、标 `intro` 意图),
 * 她只按那份材料说。Ben 09-23 那句「我问他是谁,也要想想」原来就在 CHAT_WORDS 里,整组挪到这儿。
 * 命中之后这一通进「介绍模式」(`agent.ts`):接下来的闲聊回合也带那一段,直到她要办事或挂断。
 */
export const INTRO_WORDS: readonly string[] = [
  '介绍一下自己', '介绍下自己', '介绍一下你自己', '介绍下你自己', '介绍你自己', '自我介绍', '介绍一下你', '介绍介绍你',
  '你是谁', '你叫什么', '你是什么', '你能做什么', '你会什么', '你能干什么', '你是干什么的', '你是做什么的', '你能帮我做什么',
]
/** 介绍自己那一类的意图 id(与工作台 `introKnowledge.ts` 的 `INTRO_INTENT`、`intentTools.ts` 那一行同一个字)。 */
export const INTRO_INTENT = 'intro'
/**
 * ★ **介绍模式里接着问她自己的话**(卡 Z)。两档:
 * - 强记号(介绍 / 你自己 / 区别 / 机制 / 学习 / 协作 / 原理 / 做什么 / 干什么 / 做到什么…):命中就是在问她,哪怕句里有「让」「帮」这类动作词;
 * - 弱记号(你能 / 你会 / 你是 / 你们 / 你跟…):只在句里没有动作词时才算 —— 「你能帮我做个视频吗」是交代,不是问她。
 */
export const INTRO_FOLLOWUP_STRONG_RE = /介绍|你自己|自我|区别|不同|机制|原理|学习|协作|配合|做什么|干什么|做到什么|能做到|帮我做到|会什么|什么能力|是什么/u
export const INTRO_FOLLOWUP_WEAK_RE = /你(?:能|会|是|们|跟|和|与|有什么|怎么)/u

export const GREETING_WORDS: readonly string[] = [
  '喂', '你好', '在吗', '听得见', '听得到', 'hello', 'hi', '哈喽', '嗯', '啊', '哦', '谢谢', '辛苦了',
]

/** 短句寒暄的长度上限(字)。 */
export const GREETING_MAX_CHARS = 8

/**
 * ——— 「她在试线」(2026-10-02,卡「电话里像个活人」)———
 *
 * 「你能听到我吗?」「听到吗?」「有声音吗?」**不是要办事**,是她在确认这通电话通没通。
 * Air 那 326 个回合里这一类走的全是 act:带全套工具、垫一句「我想想」,
 * 然后花八秒告诉她「有,听得见」。
 *
 * 这一张**不受 {@link GREETING_MAX_CHARS} 那条短句门管**(「你能听到我说话吗?」九个字),
 * 也**不受 {@link RulesOptions.pendingAsk} 管**:她在试线的时候,上一句是不是问句都不相干。
 */
export const HEARING_WORDS: readonly string[] = [
  '听到吗', '听得到吗', '听得见吗', '听到我', '听得到我', '听得见我', '有声音吗', '有没有声音', '能听见吗',
]

/**
 * ——— 应答 / 确认(2026-10-02,卡「电话里像个活人」)———
 *
 * 维护者:「啰嗦,自言自语,答非所问」。Air 那 326 个回合里 **89% 走 act**,
 * 多数是「接着上一回合那件事(承接)」—— 而她那一句常常只是「对。」「好的。」「是的。」。
 * 带全套工具 + 垫场 + 八秒,换回来一句「嗯」。
 *
 * 所以这一张表是**纯应答**:点头、摇头、随便、收到。整句 {@link ANSWER_MAX_CHARS} 字以内才算
 * (「对,把那条挪到发布计划里」不是应答,它前面那个「对」只是语气)。
 *
 * **一道闸**:上一回合事务官挂着一问(`pendingAsk`)时这一张表不算数 —— 那时候的
 * 「好的」「可以」就是**批准**,收走工具等于她说了「可以」而事情没动。
 * 这条闸和 agent.ts 里「来电接起的那一通不分流」是同一条道理,只是把判据从「哪一通」
 * 收窄到「上一句是不是问句」。
 */
export const ANSWER_WORDS: readonly string[] = [
  // 点头 / 收到
  '对', '对的', '是的', '是啊', '没错', '好', '好的', '好啊', '可以', '行', '收到', '知道了', '明白', '明白了', '懂了',
  '看见了', '听到了', '嗯', '嗯嗯', '哦', '噢',
  // 摇头
  '不是', '不对', '没有', '还没', '不用', '不用了', '算了', '不要',
  // 随便 / 你定
  '都行', '都可以', '随便', '你定', '你决定', '你看着办',
  // 09-23 起本来在 CHAT_WORDS 里的那几个:挪过来是为了过 `pendingAsk` 那道闸
  '好吧', '行吧',
]

/** 应答那一类的长度上限(字)。 */
export const ANSWER_MAX_CHARS = 12

/**
 * 「这是一句交代事情的长句」的门槛(字)。超过它、又一个词都没命中 → 按要办事走。
 *
 * 24 字:她在 Air 那 326 个回合里**平均 12 字**,一半的句子在 8 字以内;
 * 真正交代一件事的句子都是长的。这个数是「宁可慢别错」最后落脚的地方 ——
 * 短句里什么都不沾的那几十句(「国庆。」「茶。」「泄露。」)不该再花八秒。
 */
export const LONG_TURN_CHARS = 24

/**
 * ——— 承接要有「动作」(2026-10-02,卡「电话里像个活人」)———
 *
 * 09-23 的承接是:上一回合是 act、这一句没命中寒暄词 → 还是 act。Air 那 326 个回合里
 * **158 个**(48%)是这么来的,里头一大半是「对。」「是的。」「国庆。」「你休息了吗?」
 * 这种根本不用动手的话。承接本来是为「换音色的第二步」造的,结果变成了**整通电话的默认值**。
 *
 * 这一版把承接收窄:**只有这一句真的要求做一件新的动作时才接**。判据是下面这张表 ——
 * 一张**动词表**,不是一串 if。没命中、上一回合又没挂着一问 → 走闲聊,工人自己的小模型
 * 一句话答完(不带工具、不垫场)。
 *
 * 这张表为什么敢收窄(两种错里哪一种贵):漏判的代价是「她本来能办的事办不了」,
 * 以前因此一律按 act。现在把那条代价挪到了另外两道闸上 ——
 *   · **她这句真要动手** → 这张表里有那个动词;
 *   · **她在回答事务官挂着的那一问**(`pendingAsk`)→ 不看这张表,照旧 act。
 * 两道闸都不沾的那一句,它要的本来就只是一句回应。
 */
/**
 * ★ 动作词**按意图分了组**(2026-10-03,卡「首声提速」甲)。
 *
 * 10-02 那一版这里是一张平表(`FOLLOW_ACT_WORDS`),命中之后只知道「这一句要动手」、
 * 不知道**要动哪一种手**。Air 那 215 个 act 回合里 **124 个**是从这张表进来的 ——
 * 也就是说「带哪几件工具」这件事以前在七成的回合上压根没有依据,只能带全套 9544 字。
 *
 * 这一版把注释里本来就分着的那几块**变成代码里的组**,每组一个意图 id;
 * 哪个意图配哪几件工具在 `intentTools.ts`(**对照表只有那一处**)。
 *
 * 两条没变的:
 *   · **词与顺序一个字没动** —— `FOLLOW_ACT_WORDS` 还是从这张表摊平出来的,
 *     `find` 从上往下第一个命中的说了算,所以分组**不改任何一句话的去向**
 *     (`tests/turn-route.test.ts` 逐字钉着这张表摊平后的样子);
 *   · **这几组故意都没有 `ack`**:它们只决定手上有哪几件工具,不决定她先说哪一句。
 *     给它们配一句先应的话等于改她的嘴,那是另一件事(10-02 那张卡定的四句照旧)。
 */
export const FOLLOW_ACT_INTENTS: readonly ActIntent[] = [
  {
    // 在电脑上动手(她自己不动手 —— 09-28 拍板,所以一律是让能做的那一家去做)
    id: 'operate',
    words: [
      '打开', '关掉', '关闭', '关上', '盖掉', '撤掉', '删掉', '删除', '取消', '清掉', '点击', '点一下',
      '新开', '开一条', '开一个', '开新',
    ],
  },
  {
    /*
     * 换一个 / 改一下 / 挪到 —— **最含糊的一组**。同一个「挪到」可能是看板上的事
     * (「把那条挪到发布计划里」),也可能是屏幕上的版面(「把消耗数据挪到项目区下面」);
     * 「换个」可能是换一家,也可能是换个女声。词分不开,所以那一组工具宁可宽
     * (intentTools.ts 的 `change` 那一行写明了)。
     */
    id: 'change',
    words: [
      '换成', '换一个', '换个', '换吧', '换一下', '改成', '改一下',
      '挪到', '放进', '加进', '加一个', '做一个',
      // 2026-10-12 周三演示:「待办按日期汇总一下」「改回不汇总 / 改回去」(换「今天的待办」那一格的显示)
      '改回', '按日期', '不汇总', '平铺',
      // 2026-10-13:两版改叫「卡片 / 列表」(维护者原话),只加词;老的四个照旧认
      '卡片', '列表',
    ],
  },
  {
    // 再跑一遍 / 播放 / 发布 / 导出 / 安装 —— 还是「让别家在电脑上动手」那一类
    id: 'operate',
    words: [
      '跑一遍', '再跑', '重试', '再试', '再问', '播放', '暂停', '停掉',
      '发布', '导出', '上传', '下载', '安装', '更新', '显示', '制作', '接入', '盖',
    ],
  },
  {
    // 派活 / 捎话
    id: 'relay',
    words: [
      '派', '让', '叫他', '叫她', '问一下', '问问', '问他', '问她', '问清', '告诉', '转告', '通知', '催',
      '发消息', '发一条', '发个信息', '发给', '送去', '接通', '安排', '干活', '去办', '去做', '去吧', '快去', '开工', '开始吧',
    ],
  },
  {
    // 「来一个」那一类(真机换音色的第二步:「那给我来个调皮公主」)
    id: 'pick',
    words: ['来个', '来一个', '给我来', '要个', '要一个'],
  },
  {
    // 打电话 / 提醒
    id: 'callout',
    words: ['打电话', '给我打', '提醒我', '汇报'],
  },
  {
    // 改称呼 / 改名字(真机那句「你叫小笨蛋」当时调的就是记称呼那件工具)
    id: 'address',
    words: ['以后叫', '你叫', '叫我', '叫自己', '改名'],
  },
  {
    // 查(要工具才拿得到的)
    id: 'find',
    words: ['查', '搜', '找一下', '找到', '看一下', '看看', '总结', '统计', '核对'],
  },
  {
    // 问状态(要工具才拿得到的)
    id: 'status',
    words: ['还剩', '剩多少', '额度', '进度', '做完了', '跑完', '在跑', '有几个', '有哪', '哪一家', '天气'],
  },
]

/**
 * 动作词那一张平表。**从 {@link FOLLOW_ACT_INTENTS} 摊平而来**(同一份词、同一个顺序,
 * 不另抄一份)——「顺序就是判据」这句话在这里和 {@link ACT_WORDS} 是同一个意思。
 */
export const FOLLOW_ACT_WORDS: readonly string[] = FOLLOW_ACT_INTENTS.flatMap(one => [...one.words])

/** 这个动作词归哪一组(认不出就缺席 —— 那就按「没有意图」走全量工具)。 */
export function followIntentOf(word: string): string | undefined {
  return FOLLOW_ACT_INTENTS.find(one => one.words.includes(word))?.id
}

/**
 * 一组词 → 一条正则。**词表还是那一份**(现算出来的,不另抄一份)。
 *
 * 为什么不逐词 `includes`:判路那两处第一个命中就返回,而 {@link intentsOf} 要把
 * **全部** 14 组 136 个词都扫一遍。逐词扫一句话 6.8μs、一条正则 0.95μs,
 * 而这个文件在「等回合」那条路径上(`tests/turn-route.test.ts` 的「不许偷偷变慢」盯着它)。
 */
function wordsRegExp(words: readonly string[]): RegExp {
  if (words.length === 0) return /(?!)/u
  return new RegExp(words.map(one => one.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('|'), 'u')
}

const ACT_GROUP_TESTS: readonly { id: string, re: RegExp }[] =
  ACT_INTENTS.map(one => ({ id: one.id, re: wordsRegExp(one.words) }))
const FOLLOW_GROUP_TESTS: readonly { id: string, re: RegExp }[] =
  FOLLOW_ACT_INTENTS.map(one => ({ id: one.id, re: wordsRegExp(one.words) }))
const SHORT_ACT_RE = wordsRegExp(SHORT_ACT_WORDS)

/**
 * ★ **这一句命中的全部意图**(2026-10-03,卡 fix/voice-route-zh;审计 voice.md 第 3 条)。
 *
 * 为什么不是一个:`routeByRules` 判路的时候**第一个命中就够了**(它只要回答「带不带工具」),
 * 而 10-03 早上起意图还决定**手上有哪几件工具** —— 那时候「第一个」就不够了:
 * 「把文件发给我,再换个音色」只留下 voice,文件那两件直接消失。
 *
 * 顺序 = 三张表的顺序(与 {@link routeByRules} 的 ① → ④ 同一个顺序,去重):
 * {@link ACT_INTENTS} → 短句问事 / butlerRoute 那三类 → {@link FOLLOW_ACT_INTENTS}。
 * 所以 `intents[0]` 永远等于那一句的 `intent`(用例钉着)。
 *
 * `asked` 是调用方已经算过的那一份 butlerRoute 判定(别算第二遍;缺席就自己算)。
 */
export function intentsOf(text: string, asked?: CallRoute): readonly string[] {
  const trimmed = text.trim()
  if (trimmed === '') return []
  const ids: string[] = []
  const add = (id: string): void => { if (!ids.includes(id)) ids.push(id) }
  for (const one of ACT_GROUP_TESTS) {
    if (one.re.test(trimmed)) add(one.id)
  }
  if (trimmed.length <= SHORT_ACT_MAX_CHARS && SHORT_ACT_RE.test(trimmed)) add(LOOKUP_INTENT.id)
  const route = asked ?? classifyCallTurn(trimmed)
  if (route === 'relay') add(RELAY_INTENT.id)
  for (const one of FOLLOW_GROUP_TESTS) {
    if (one.re.test(trimmed)) add(one.id)
  }
  return ids
}

/** 判定里那一格:命中了就带上,一个都没命中就缺席(= 全量工具)。 */
function intentsHit(text: string, asked?: CallRoute): { intents?: readonly string[] } {
  const ids = intentsOf(text, asked)
  return ids.length === 0 ? {} : { intents: ids }
}

/** 这一次判定的凭据(只给日志与离线评估看)。 */
export interface RulesHit {
  route: TurnRoute
  reason: string
  /** 命中的那个词(没命中任何词时缺席)。 */
  word?: string
  /** 办的是哪件事({@link ACT_INTENTS} 的 `id`)。**认不出意图时缺席**。 */
  intent?: string
  /**
   * 这一句命中的**全部**意图,按 {@link intentsOf} 的顺序去重。
   * `intents[0]` 就是上面那个 `intent`;工具按**并集**下发(intentTools.ts)。
   */
  intents?: readonly string[]
  /** 先应哪一句。**缺席 = 认不出意图**,退回原来的垫场(「我想想」类)。 */
  ack?: string
  /** 马上能答(见 {@link QUICK_INTENTS})。 */
  quick?: true
  /** 靠「上一回合是 act」接下来的(见 {@link routeByRules})。 */
  carried?: true
  /** 承接的是哪件事(原话)。只有接上了 {@link RulesOptions.carry} 时才有。 */
  carriedFrom?: string
}

/** 判不出来时落到哪一边。缺省 `act`(卡上原话:宁可慢别错)。 */
export type RulesFallback = TurnRoute

export interface RulesOptions {
  /** 上一回合走的哪条路(承接用,见下)。第一句没有上一回合。 */
  previous?: TurnRoute
  /**
   * **上一回合事务官挂着一问**(2026-10-02)。真 = 它刚问了她一句、正等她回话。
   *
   * 这一格是「应答走快路」那条规矩的闸:事务官刚问完
   * 「要我派豆包还是 Codex?」的时候,她那句「豆包」「可以」「去吧」**是批准**,
   * 要工具才办得成;事务官刚报完一个结果的时候,同样那几个字只是「嗯,收到」。
   * 两者的差别全在上一句是不是问句 —— 所以判据放在这里,**由调用方数出来**
   * (agent.ts 看事务官上一句的末尾,不经模型)。
   *
   * 缺席 = 不知道上一句是什么(第一句、补话)→ 按「没挂问」处理:
   * 真要办事的那几句另有 {@link FOLLOW_ACT_WORDS} 兜着。
   */
  pendingAsk?: boolean
  /**
   * **紧挨着的上一回合办过 / 问过的那件事**(2026-10-12,卡「通话补一句不丢事」第 2 条)。
   *
   * 10-12 真机:音色列完、派活问完「给谁」,她答「要女生的」「给 Claude」——
   * 这几句一个动作词都没有,10-02 那条承接(只看这一句自己)把它们判成闲聊、零工具。
   * 有了这一格:她在回答挂着的那一问(⑤)、或者说了一句不沾快路的短句(⑦),
   * 就**按那件事的意图走、带那件事的工具**;这一句自己有动作词(④)时两边的意图并起来。
   *
   * 应答 / 寒暄那几条快路(②③③')**照旧在前面**:报完结果之后的「好的」「对」仍是闲聊 ——
   * 10-02 那道门是量出来的(Air 那 326 个回合),这一格不拆它。
   * 缺席 = 上一回合不是办事、或者中间隔了一回合(只接紧挨着的那一句)。
   */
  carry?: CarriedThing
  /** 一个词都没命中时落到哪一边。缺省 `act`。 */
  fallback?: RulesFallback
  /**
   * ★ **这一通正在介绍模式里**(2026-10-14 凌晨,卡 Z;维护者真机「自我介绍的测试,不达预期」)。
   *
   * 0.4.129 那一通:「记什么?我们不是在让你介绍你自己吗?」一个「让」字命中动作词 → 办事路、退出介绍模式;
   * 「你是通过什么样的机制去学习和我协作的?」没带知识库;「那你跟其他家的那种智能体有什么区别?听上去都一样。」
   * 超过 24 字按长句兜底走了办事路 + 垫场 + 闸改写,答成「回电我还没安排上」。
   * 介绍模式里**接着问她自己的话**({@link INTRO_FOLLOWUP_RE})一律闲聊 + 带知识库、不进闸;真要办事的句子照旧走办事路(并退出介绍模式)。
   */
  introMode?: boolean
}

/**
 * 关键词判一句话。**纯函数**,离线评估脚本吃的也是它。
 *
 * 顺序(顺序本身就是判据的一部分,改顺序等于改行为):
 *
 *   ① **要办事的词**先走。**它必须排在寒暄前面**:真机那一句「什么事啊?」只有五个字、
 *      末尾一个「啊」,先看寒暄就会把它判成闲聊,而她当时调的是 `wb_list_doing`
 *      —— 那是漏判,是两种错里贵的那一种;
 *   ②' **她在试线**(2026-10-02):「你能听到我吗?」—— 不受短句门与 `pendingAsk` 管;
 *   ② **短句寒暄**:整句就几个字的「喂」「嗯」;
 *   ③ **闲聊的词**(长句里也算);
 *   ③' **应答 / 确认**(2026-10-02):短句的「对」「好的」「是的」→ 闲聊。
 *
 *      ★ ② ③ ③' 这三条是「按句子的样子判闲聊」的捷径,**两种情形一律跳过**
 *      (2026-10-03,卡 fix/voice-route-zh):这一句里有动作词({@link FOLLOW_ACT_WORDS}),
 *      或者她在回答事务官挂着的那一问({@link RulesOptions.pendingAsk})——
 *      「嗯,取消吧」要的是取消,不是一句寒暄;
 *   ④ **承接**(2026-10-02 收窄):上一回合是 `act`,而且**这一句真要求做一件新的动作**
 *      ({@link FOLLOW_ACT_WORDS})、或者她正在回答事务官挂着的那一问 → 还是 `act`;
 *      两样都不沾 → 闲聊。
 *      09-23 那一版只看「上一回合是 act」,结果 Air 那 326 个回合里 48% 是这么被拉进 act 的,
 *      里头一大半是「对。」「是的。」—— 承接从一条例外变成了默认值,这一版把它改回例外。
 *   ⑤ 都不沾 → {@link RulesOptions.fallback}(缺省 `act`)。
 */
/** 一个意图 → 判定里那两格(意图 id + 先应的那一句;没有先应句就只有 id)。 */
function intentHit(intent: ActIntent): { intent: string, ack?: string } {
  return { intent: intent.id, ...(intent.ack === undefined ? {} : { ack: intent.ack }) }
}

/** 「查一下」那一类的意图与应答句(短句问事、问事项、问记忆共用 {@link LOOKUP_INTENT})。 */
function lookupHit(): { intent: string, ack?: string } {
  return intentHit(LOOKUP_INTENT)
}

/** 两份意图并起来(去重、保序)。任一边缺席(= 全量工具)时那一边按「没有」算。 */
export function unionIntents(...lists: (readonly string[] | undefined)[]): readonly string[] {
  return [...new Set(lists.flatMap(one => [...(one ?? [])]))]
}

/** 那件事的意图(一份 `intents`;只有单个 `intent` 时就是它)。 */
function thingIntents(thing: CarriedThing): readonly string[] | undefined {
  if (thing.intents !== undefined && thing.intents.length > 0) return thing.intents
  return thing.intent === undefined ? undefined : [thing.intent]
}

/**
 * 只是查一眼 / 问状态的那几个意图(2026-10-12)。刚查过一眼之后的短句不算「那件事的下一步」
 * (⑦' 不接它);claimGuard.ts 也拿它认「这一回合在报以前的事,不拦」。
 */
export const REPORT_INTENTS: readonly string[] = [LOOKUP_INTENT.id, 'find', 'status']

/** 那件事是不是一件要动手的事(认得出意图,而且不只是查一眼)。 */
function isDoingThing(thing: CarriedThing): boolean {
  const intents = thingIntents(thing)
  return intents !== undefined && intents.some(one => !REPORT_INTENTS.includes(one))
}

/** 承接那件事时判定里的那几格(意图沿用那件事的;那件事本来就没意图 = 全量工具)。 */
function carryHit(thing: CarriedThing): Pick<RulesHit, 'intent' | 'intents' | 'carriedFrom'> {
  const intents = thingIntents(thing)
  return {
    ...(thing.intent === undefined ? {} : { intent: thing.intent }),
    ...(intents === undefined ? {} : { intents }),
    carriedFrom: thing.text,
  }
}

export function routeByRules(text: string, options: RulesOptions = {}): RulesHit {
  const hit = routeByWords(text, options)
  return hit.route === 'act' && isQuickTurn(hit.intents) ? { ...hit, quick: true } : hit
}

function routeByWords(text: string, options: RulesOptions): RulesHit {
  const trimmed = text.trim()
  if (trimmed === '') return { route: 'chat', reason: '空的识别结果,当没说话' }
  const lower = trimmed.toLowerCase()

  /*
   * ⓪ ★ 介绍模式里接着问她自己(卡 Z):闲聊 + 带知识库,不进闸、不垫场。排在要办事的词前面 ——
   * 「我们不是在让你介绍你自己吗」那个「让」不该把她拽去办事路。真要办事的句子(强记号一个没有、又命中动作词)照旧往下走。
   */
  if (options.introMode === true) {
    const strong = INTRO_FOLLOWUP_STRONG_RE.test(trimmed) || INTRO_WORDS.some(word => trimmed.includes(word))
    const hasAct = ACT_WORDS.some(word => trimmed.includes(word)) || FOLLOW_ACT_WORDS.some(word => trimmed.includes(word))
    if (strong || (!hasAct && INTRO_FOLLOWUP_WEAK_RE.test(trimmed))) {
      return { route: 'chat', reason: '介绍模式里接着问她自己', intent: INTRO_INTENT, intents: [INTRO_INTENT] }
    }
  }

  // ① 要办事。**按意图分组走**,组内顺序与组间顺序都没动(顺序就是判据)。
  for (const intent of ACT_INTENTS) {
    const act = intent.words.find(word => trimmed.includes(word))
    if (act === undefined) continue
    // 先应的是这一句里**第一件有先应句的事**:「换个音色,再记一下」排在前面的「记」不先应,换音色要应。
    const ack = ACT_INTENTS.find(one => one.ack !== undefined && one.words.some(word => trimmed.includes(word)))?.ack
    return {
      route: 'act',
      reason: `要办事的词「${act}」`,
      word: act,
      intent: intent.id,
      ...intentsHit(trimmed),
      ...(ack === undefined ? {} : { ack }),
    }
  }
  // 事项、记忆、捎话那三类共用 butlerRoute 的表(「进度」「做到哪」「我以前说过」、「给那条会话发个信息」…)。
  // 算在这儿只为一件事:下面那几格的 `intents` 别把同一张表再判一遍。
  const asked = classifyCallTurn(trimmed)
  if (trimmed.length <= SHORT_ACT_MAX_CHARS) {
    const short = SHORT_ACT_WORDS.find(word => trimmed.includes(word))
    if (short !== undefined) {
      return { route: 'act', reason: `短句问事「${short}」`, word: short, ...lookupHit(), ...intentsHit(trimmed, asked) }
    }
  }
  if (asked === 'relay') {
    return {
      route: 'act',
      reason: '给某条会话捎话(butlerRoute)',
      ...intentHit(RELAY_INTENT),
      ...intentsHit(trimmed, asked),
    }
  }

  // ②' 她在试线(「你能听到我吗?」)。不受短句门与 pendingAsk 管。
  const hearing = HEARING_WORDS.find(word => trimmed.includes(word))
  if (hearing !== undefined) return { route: 'chat', reason: `她在试线「${hearing}」`, word: hearing }

  const follow = FOLLOW_ACT_WORDS.find(word => trimmed.includes(word))
  /*
   * ——— ★ 「按句子的样子判闲聊」那三条捷径,两种情形一律跳过 ———
   * (2026-10-03,卡 fix/voice-route-zh;审计 voice.md 第 2 条)
   *
   *   · **这一句里有动作词** —— 「嗯,取消吧」「不对,删除这条」「我的意思是换成女声」:
   *     前缀是寒暄或纠正,真正要办的事在后半句。10-02 只把这道闸加在 ③' 上,
   *     ② 与 ③ 照旧先返回 chat,于是越是用自然口语纠正越办不成事;
   *   · **她在回答事务官挂着的那一问**(`pendingAsk`)—— 那时候「好的」「不对」「嗯」
   *     都是对那一问的答复,要工具才办得成(注释里本来就写着这一条,10-02 也只落在 ③' 上)。
   *
   * ②'(她在试线)**不在这三条里**:她确认电话通没通的时候,上一句是不是问句不相干。
   */
  if (options.pendingAsk !== true && follow === undefined) {
    // ② 短句寒暄
    if (trimmed.length <= GREETING_MAX_CHARS) {
      const hit = GREETING_WORDS.find(word => lower.includes(word))
      if (hit !== undefined) return { route: 'chat', reason: `短句寒暄「${hit}」`, word: hit }
    }

    // ③⁰ 问她自己(2026-10-13 夜,卡 V):闲聊路,但带「介绍自己」那个意图,人设里那份材料跟着带上。
    const intro = INTRO_WORDS.find(word => trimmed.includes(word))
    // `intent` 也填(对照用例「intents[0] 永远等于 intent」);它不在 ACT_INTENTS 里,所以不会先应、不会带工具。
    if (intro !== undefined) return { route: 'chat', reason: `问她自己「${intro}」:介绍自己`, word: intro, intent: INTRO_INTENT, intents: [INTRO_INTENT] }

    // ③ 闲聊
    const chat = CHAT_WORDS.find(word => trimmed.includes(word))
    if (chat !== undefined) return { route: 'chat', reason: `闲聊的词「${chat}」`, word: chat }

    // ③' 应答 / 确认(2026-10-02)。短句的「对」「好的」「是的」→ 闲聊:不带工具、不垫场。
    if (trimmed.length <= ANSWER_MAX_CHARS) {
      const answer = ANSWER_WORDS.find(word => trimmed.includes(word))
      if (answer !== undefined) return { route: 'chat', reason: `应答「${answer}」`, word: answer }
    }
  }

  /*
   * ④ **这一句要求做一件新的动作**(2026-10-02 的承接)。
   *
   * 09-23 的承接看的是「上一回合是不是 act」;这一版看的是**这一句自己**。
   * `carried` 那一格仍按老意思填(上一回合是 act 时才算「接着上一件事」)——
   * 离线评估与体检页读的是它。
   */
  if (follow !== undefined) {
    const intent = followIntentOf(follow)
    const own = intentsHit(trimmed, asked)
    /*
     * 2026-10-12:接着刚办过的那件事说「换成第二个」—— 自己那组(change)之外,那件事的工具(voice)也得在手上。
     * 那件事本来就是全量工具(没意图)时不并:并上去反而把它收窄了。
     */
    const carried = options.carry === undefined ? undefined : thingIntents(options.carry)
    return {
      route: 'act',
      reason: options.previous === 'act' ? `接着上一回合那件事,这句要动手「${follow}」(承接)` : `这句要动手「${follow}」`,
      word: follow,
      // 2026-10-03:动作词也带意图了(只为挑工具,**不配先应句**,见 FOLLOW_ACT_INTENTS)。
      ...(intent === undefined ? {} : { intent }),
      ...(options.carry === undefined || carried === undefined ? own : { intents: unionIntents(own.intents, carried), carriedFrom: options.carry.text }),
      ...(options.previous === 'act' ? { carried: true as const } : {}),
    }
  }

  // ⑤ 她在回答事务官挂着的那一问 —— 那句「可以」「豆包」是批准,要工具才办得成。
  if (options.pendingAsk === true) {
    return {
      route: 'act',
      reason: options.carry === undefined ? '她在回答事务官挂着的那一问' : `她在回答事务官挂着的那一问(承接「${options.carry.text}」)`,
      // 2026-10-12:答的是哪件事的那一问,就带那件事的工具(以前这里没意图 = 全套 18 件)。
      ...(options.carry === undefined ? {} : carryHit(options.carry)),
      ...(options.previous === 'act' ? { carried: true as const } : {}),
    }
  }

  /*
   * ⑥ **长句兜底**(2026-10-02)。一句话长过 {@link LONG_TURN_CHARS} 字、又一个词都没命中
   * → 按要办事走(宁可慢别错)。
   *
   * 为什么拿长短当判据:她平均 **12 字**(Air 326 个回合),而真正交代一件事的句子
   * 都是长的(「我想请你直接根据我跟你的对话,然后派初代修复现在工作台上小组件」)。
   * 短句里什么都不沾的那些是「国庆。」「茶。」「泄露。」—— 答一句就完的话,
   * 以前每一句都要带全套工具、垫一声「我想想」、再等八秒。
   */
  if ([...trimmed].length > LONG_TURN_CHARS) {
    const fallback = options.fallback ?? 'act'
    return {
      route: fallback,
      reason: fallback === 'act'
        ? `一个词都没命中,但这句长过 ${LONG_TURN_CHARS} 字,按要办事走(宁可慢别错)`
        : '一个词都没命中,按闲聊走',
    }
  }

  /*
   * ⑦' **短回答承接刚办过的那件事**(2026-10-12)。音色刚列完几个,她说「要女生的」「第二个」——
   * 一个动作词都没有,却是那件事的下一步。只接紧挨着的那一回合(`carry` 由 TurnRouting 按这个口径填),
   * 而且只接**认得出意图、要动手**的那件事:没意图的(长句兜底、挂问兜底)接过来也只是全套工具,
   * 查一眼之后的短句多半是闲话;她自己反问的一句(「怎么会没开成呢?」)也不是在答那件事 ——
   * Air 回放上不收窄时多出 20 个白带工具的回合(交接-1012 第三节)。
   */
  if (options.carry !== undefined && isDoingThing(options.carry) && [...trimmed].length <= SHORT_ACT_MAX_CHARS && !looksLikeAsking(trimmed)) {
    return {
      route: 'act',
      reason: `短回答,接着刚办的那件事「${options.carry.text}」(承接)`,
      ...carryHit(options.carry),
      carried: true,
    }
  }

  // ⑦ 短句、什么都不沾:一句回应就够。
  return { route: 'chat', reason: '短句,没要求做新的动作,也不是在回答挂着的问话' }
}

/**
 * 规则分流。**默认就是它**:0 毫秒、0 成本、判据能一条条数出来。
 *
 * 它**记着上一回合走的哪条路**(承接,见 {@link routeByRules} 第 ④ 条)——
 * 所以它是有状态的,一通电话一个实例。
 */
export class RulesTurnRouter implements TurnRouter {
  readonly name = 'rules'
  readonly #fallback: RulesFallback
  #previous: TurnRoute | undefined

  constructor(options: { fallback?: RulesFallback } = {}) {
    this.#fallback = options.fallback ?? 'act'
  }

  /** 上一回合走的哪条路(测试与日志用)。 */
  get previous(): TurnRoute | undefined { return this.#previous }

  /** 忘掉上一回合(挂断了,下一通从头来)。 */
  reset(): void { this.#previous = undefined }

  route(text: string, context?: TurnContext): Promise<TurnDecision> {
    const hit = routeByRules(text, {
      ...(this.#previous === undefined ? {} : { previous: this.#previous }),
      ...(context?.pendingAsk === undefined ? {} : { pendingAsk: context.pendingAsk }),
      ...(context?.thing === undefined ? {} : { carry: context.thing }),
      ...(context?.introMode === true ? { introMode: true } : {}),
      fallback: this.#fallback,
    })
    this.#previous = hit.route
    return Promise.resolve({
      route: hit.route,
      router: this.name,
      reason: hit.reason,
      ms: 0,
      ...(hit.intent === undefined ? {} : { intent: hit.intent }),
      ...(hit.intents === undefined ? {} : { intents: hit.intents }),
      ...(hit.ack === undefined ? {} : { ack: hit.ack }),
      ...(hit.carriedFrom === undefined ? {} : { carriedFrom: hit.carriedFrom }),
      ...(hit.quick === true ? { quick: true as const } : {}),
    })
  }
}

// ———————————————————————— 一回合的判定 ————————————————————————

/**
 * 判定最多等多久(毫秒)。到点还没回来就**按 `act` 走**,不把模型晾着。
 *
 * 300ms:规则法根本用不着它;Jev 的公开实测 P50 是 0.30–0.33 秒、国内 0.7–0.9 秒
 * (设计-事务官自进化闭环 2.4),也就是说**跨境那一跳本身就可能比它省下来的还多** ——
 * 这条超时就是那件事在代码里的记号。
 */
export const ROUTE_BUDGET_MS = 300

/** 压根没判过的那一回合(开场白、来电的第一句)。**按 `act`**:工具都在,行为和以前一字不差。 */
export const NO_DECISION: TurnDecision = {
  route: 'act',
  router: 'none',
  reason: '这一回合没有识别结果(开场白/补话),按要办事走',
  ms: 0,
}

export interface TurnRoutingOptions {
  router: TurnRouter
  /** 判定最多等多久。缺省 {@link ROUTE_BUDGET_MS}。 */
  budgetMs?: number
  now?: () => number
  log?: (line: string) => void
  /** 等超时用的定时器(测试注入)。 */
  setTimer?: (fn: () => void, ms: number) => void
}

/** 一件要办的事(TurnRouting 记着的那一份)。 */
interface OpenThing {
  /** 哪一回合判的(并进来的那几句会把它挪到最后一句)。 */
  seq: number
  /** 他交代这件事的原话(补过几句就是几句连起来)。 */
  text: string
  decision: TurnDecision
  /** 办了没有(见 {@link TurnRouting.noteHandled})。 */
  handled: boolean
}

/** {@link TurnRouting.start} 当场回的那一格。 */
export interface TurnStart {
  /** 第几次判定(同 {@link TurnRouting.seq})。 */
  seq: number
  /** 这一句并进了一件没办完的事:那件事前面几句的原话。缺席 = 新的一句。 */
  followUp?: string
}

/** 一个判定里「办的是哪件事」那几格(承接时交给分流的就是它)。 */
function thingOf(decision: TurnDecision): Omit<CarriedThing, 'text'> {
  return {
    ...(decision.intent === undefined ? {} : { intent: decision.intent }),
    ...(decision.intents === undefined ? {} : { intents: decision.intents }),
  }
}

/**
 * **把补的那一句并进还没办完的那件事**(2026-10-12)。纯函数。
 *
 *   · 路一律 `act`:那件事要工具,补一句不改变这一点(补的是「算了」也要工具 —— 撤回也是办);
 *   · 意图沿用那件事的;这一句自己判出了别的意图,**并起来**(「顺便记一下」)。
 *     那件事本来就没意图(全量工具)→ 照旧全量,不因为补的那句有个意图就收窄;
 *   · **不再先应**(那件事已经应过了;再应一句就是两句「好」);
 *   · `followUp` 记着前面几句原话,llmNode 拿它补一行 {@link followUpNote}。
 */
export function mergeIntoThing(decision: TurnDecision, open: { text: string, decision: TurnDecision }): TurnDecision {
  const before = thingOf(open.decision)
  const earlier = before.intents ?? (before.intent === undefined ? undefined : [before.intent])
  const mine = decision.route === 'act' ? (decision.intents ?? (decision.intent === undefined ? undefined : [decision.intent])) : []
  const intents = earlier === undefined ? undefined : unionIntents(earlier, mine)
  const intent = before.intent ?? (intents === undefined ? undefined : intents[0])
  return {
    route: 'act',
    router: decision.router,
    reason: `补一句,并进还没办完的那件事「${open.text}」(这句自己判的是:${decision.reason})`,
    ms: decision.ms,
    ...(decision.confidence === undefined ? {} : { confidence: decision.confidence }),
    ...(intent === undefined ? {} : { intent }),
    ...(intents === undefined || intents.length === 0 ? {} : { intents }),
    followUp: open.text,
  }
}

/** 并进来的那一回合补的那一行(一个回合就过期,同 {@link ackedNote})。 */
export function followUpNote(earlier: string): string {
  return `他这一句是接着他前面那句「${earlier}」补的,两句是同一件事。`
    + '前面那件事你还没办(工具还没调),这一次把他补的这句并进去,一起办掉;办之前不许说成已经办了。'
}

/** 承接那一回合补的那一行。 */
export function carryNote(thing: string): string {
  return `他这一句是在接着刚才那件事「${thing}」答你,按那件事接着办(要动手就调工具)。`
}

/**
 * 一回合的判定:**识别结果一到手就开判,调模型之前把它等回来**。
 *
 * 为什么不在识别结果那一刻同步判完就算:规则法确实同步,但 Jev 要一次 HTTP。
 * 把「开判」和「用判定」分开,慢的那一件才能和框架的端点检测**并行**跑
 * (真机上识别最终文本 → 回合提交之间有 5~40ms,Jev 那一跳藏不进去,但至少不是纯串行)。
 *
 * 四条纪律:
 *   ① **判不出来、超时、抛了,一律 `act`**(= 和这一版之前一模一样的行为);
 *   ② **一回合只判一次**。模型在一个回合里调完工具会再回来一次(`llmNode` 会被调第二次),
 *      那时用的必须是**同一个判定** —— 中途把工具收走等于把它正在办的事掐断;
 *   ③ **回合结束就忘掉**,下一个没有识别结果的回合走 {@link NO_DECISION},不沿用上一回合的 ——
 *      **除非那件事还没办完**(2026-10-12,见 ④);
 *   ④ **一件事没办完之前,它的判定一直算数**(2026-10-12,卡「通话补一句不丢事」)。
 *      「办完」= 这一件调过工具,或者模型完整说完了一段话(被掐断的不算),由调用方 {@link noteHandled} 报。
 *      10-12 真机:先应那句一念完、状态回到「听」,`end()` 就把「换音色」的判定清了,
 *      框架补交上来的那次调用只能走 none(全套工具、没意图、人设按「没有意图」裁);
 *      她紧接着插的「要女生的」又被当成新的一句、判成闲聊、零工具 —— 一件事被拆成了两个都办不成的回合。
 *      所以:没办完时 `end()` 不清;没办完时她插的话**并进同一件事**(意图与工具沿用,见 {@link mergeIntoThing});
 *      办完了,紧挨着的下一句把那件事当 {@link TurnContext.thing} 交给分流(短回答承接)。
 */
export class TurnRouting {
  readonly #router: TurnRouter
  readonly #budgetMs: number
  readonly #now: () => number
  readonly #log: (line: string) => void
  readonly #setTimer: (fn: () => void, ms: number) => void
  #seq = 0
  #pending: Promise<TurnDecision> | undefined
  #decision: TurnDecision | undefined
  /** 最近一件要办的事(最近一个判成 `act` 的回合)。闲聊回合把它清掉(承接只接紧挨着的那一句)。 */
  #thing: OpenThing | undefined

  constructor(options: TurnRoutingOptions) {
    this.#router = options.router
    this.#budgetMs = options.budgetMs ?? ROUTE_BUDGET_MS
    this.#now = options.now ?? (() => Date.now())
    this.#log = options.log ?? (() => {})
    this.#setTimer = options.setTimer ?? ((fn, ms) => { setTimeout(fn, ms).unref?.() })
  }

  /** 第几次判定(轮号,给 {@link whenDecided} 对号用)。 */
  get seq(): number { return this.#seq }

  /** 判好了没有。没判好是 undefined —— **不是** `act`。 */
  get decision(): TurnDecision | undefined { return this.#decision }

  /**
   * 识别最终文本到手:开判(不等)。
   * `context`(2026-10-02)是**这一刻的处境**(事务官上一句是不是问句),见 {@link TurnContext}。
   */
  start(text: string, context?: TurnContext): TurnStart {
    this.#seq += 1
    const seq = this.#seq
    this.#decision = undefined
    const began = this.#now()
    /*
     * 上一件事的处境(2026-10-12)。**同步算好**:调用方要当场知道这一句是不是补进去的
     * (补进去的那一句不再先应、不清「已经应过」那一格,见 agent.ts 的 hearFinalText)。
     */
    const prior = this.#thing
    const unfinished = prior !== undefined && !prior.handled ? prior : undefined
    const recent = prior !== undefined && prior.handled && prior.seq === seq - 1 ? prior : undefined
    const routed = recent === undefined
      ? context
      : { ...context, thing: { text: recent.text, ...thingOf(recent.decision) } }
    const pending = this.#ask(text, routed).then((decision) => {
      const merged = unfinished === undefined ? decision : mergeIntoThing(decision, unfinished)
      // 这一拍已经过时了(他又说了一句)就丢掉,**不许把旧判定写进新回合**。
      if (seq !== this.#seq) return merged
      const settled = { ...merged, ms: merged.ms > 0 ? merged.ms : this.#now() - began }
      this.#decision = settled
      this.#thing = settled.route === 'act'
        ? { seq, text: unfinished === undefined ? text.trim() : `${unfinished.text}${text.trim()}`, decision: settled, handled: false }
        : undefined
      return settled
    })
    this.#pending = pending
    // 判定本身失败不该变成一条没人接的 rejection。
    void pending.catch(() => {})
    return { seq, ...(unfinished === undefined ? {} : { followUp: unfinished.text }) }
  }

  /** Reserve an ASR turn owned by /butler/say without running the legacy phone intent router. */
  startExternal(): TurnStart {
    this.#seq += 1
    this.#decision = undefined
    this.#pending = undefined
    this.#thing = undefined
    return { seq: this.#seq }
  }

  /**
   * **这一件办了**(2026-10-12):这一回合调过工具,或者模型完整说完了一段话(被掐断的不算)。
   * 之后 `end()` 照旧清判定,下一句不再并进来、只按「刚办过」承接。
   */
  noteHandled(): void {
    if (this.#thing !== undefined && this.#thing.seq === this.#seq) this.#thing.handled = true
  }

  /** 挂断了:没办完的那件事也忘掉(下一通的第一句不许并进上一通)。 */
  forget(): void {
    this.#thing = undefined
    this.#pending = undefined
    this.#decision = undefined
  }

  /**
   * 判好了叫一声。`seq` 对不上(他又说了一句、这一回合早完了)就**不叫** ——
   * 缓冲语接的就是这里:一条迟到的信号会让手机垫一句没人要的话。
   */
  whenDecided(seq: number, callback: (decision: TurnDecision) => void): void {
    const pending = this.#pending
    if (pending === undefined) { callback(NO_DECISION); return }
    void pending.then((decision) => {
      if (seq !== this.#seq) return
      try { callback(decision) }
      catch { /* 叫一声失败不值得再出一个错 */ }
    })
  }

  /**
   * 调模型之前:把判定等回来。**最多等 {@link ROUTE_BUDGET_MS}**,到点按 `act`。
   * 这一回合判过了就直接回那一个(第 ② 条)。
   */
  async settle(): Promise<TurnDecision> {
    if (this.#decision !== undefined) return this.#decision
    const pending = this.#pending
    if (pending === undefined) return NO_DECISION
    const timeout = new Promise<TurnDecision>((resolve) => {
      this.#setTimer(() => resolve({
        ...NO_DECISION,
        router: this.#router.name,
        reason: `判定超过 ${this.#budgetMs}ms 没回来,按要办事走`,
        ms: this.#budgetMs,
      }), this.#budgetMs)
    })
    return await Promise.race([pending, timeout])
  }

  /**
   * 这一回合结束了。下一个没有识别结果的回合按 {@link NO_DECISION} 走 ——
   * **这一件还没办完就不清**(第 ④ 条):框架补交上来的那一次调用还得用它。
   */
  end(): void {
    const open = this.#thing
    if (open !== undefined && !open.handled && open.seq === this.#seq) return
    this.#pending = undefined
    this.#decision = undefined
  }

  async #ask(text: string, context?: TurnContext): Promise<TurnDecision> {
    try { return await this.#router.route(text, context) }
    catch (err) {
      const why = (err as Error)?.message ?? '没说原因'
      this.#log(`[channel-worker] 分流判定出错(${this.#router.name}):${why} —— 这一回合按要办事走`)
      return { ...NO_DECISION, router: this.#router.name, reason: `判定出错:${why}` }
    }
  }
}

// ———————————————————————— 用哪一件 ————————————————————————

/** 一句话说清这一回合怎么判的(日志那一行)。 */
export function describeDecision(decision: TurnDecision): string {
  const what = decision.route === 'chat' ? '闲聊 → 不带工具、不垫场' : '要办事 → 带工具、垫场'
  const confidence = decision.confidence === undefined ? '' : `,把握 ${decision.confidence.toFixed(2)}`
  const intent = decision.intent === undefined ? '' : `,意图 ${decision.intent}`
  const ack = decision.ack === undefined ? '' : `,先应「${decision.ack}」`
  const quick = decision.quick === true ? ',马上能答:不先应、不垫场' : ''
  return `这一回合按${what}(${decision.router}:${decision.reason},${decision.ms}ms${confidence}${intent}${ack}${quick})`
}

export interface CreateRouterOptions {
  env?: Record<string, string | undefined>
  log?: (line: string) => void
}

/**
 * 按环境变量挑一件实现。**缺省 `rules`**。
 *
 * `jev` 那一件是**动态 import** 的:没选它、或者没有 `JEV_API_KEY` 的时候
 * jevRouter.ts **一行都不会加载** —— 卡上那句「没有 key 时整个实现不加载」的字面意思。
 * 选了 jev 却没有 key:**退回 rules 并如实说一句**,不静默、也不让电话打不出去。
 */
export async function createTurnRouter(options: CreateRouterOptions = {}): Promise<TurnRouter> {
  const env = options.env ?? process.env
  const log = options.log ?? (() => {})
  const fallbackEnv = env.WORKBENCH_CHANNEL_TURN_ROUTER_FALLBACK?.trim().toLowerCase()
  const fallback: RulesFallback = fallbackEnv === 'chat' ? 'chat' : 'act'
  const rules = (): TurnRouter => new RulesTurnRouter({ fallback })

  const pick = env.WORKBENCH_CHANNEL_TURN_ROUTER?.trim().toLowerCase()
  if (pick === undefined || pick === '' || pick === 'rules') return rules()
  if (pick !== 'jev') {
    log(`[channel-worker] 不认识的分流实现「${pick}」,用规则法(WORKBENCH_CHANNEL_TURN_ROUTER=rules|jev)`)
    return rules()
  }
  const key = env.JEV_API_KEY?.trim()
  if (key === undefined || key === '') {
    log('[channel-worker] 选了 jev 分流,但环境里没有 JEV_API_KEY —— 用规则法。(凭据只从环境变量读,不落盘)')
    return rules()
  }
  try {
    const { JevTurnRouter } = await import('./jevRouter.ts')
    log('[channel-worker] 分流用 Jev(云端)。他在电话里说的话会发到第三方 —— 数据出境见交接-0923-回合分流与Jev评估。')
    return new JevTurnRouter({
      apiKey: key,
      ...(env.JEV_API_URL?.trim() === undefined || env.JEV_API_URL.trim() === '' ? {} : { baseUrl: env.JEV_API_URL.trim() }),
      log,
    })
  }
  catch (err) {
    log(`[channel-worker] Jev 分流没装上(${(err as Error)?.message ?? '没说原因'}),用规则法`)
    return rules()
  }
}
