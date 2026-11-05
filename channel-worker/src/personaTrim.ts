/**
 * **这一回合的人设只带用得上的那几段**(2026-10-03,卡「chat 路人设按意图裁」,维护者拍板「做」)。
 *
 * ## 为什么
 *
 * Air 诊断包 10-02 那 326 个回合:chat 路**一件工具都不带**,首声 p95 仍然 **1934ms** ——
 * 那 1.9 秒全在「长人设 + 模型本身 + 跨境一跳」上(交接-1003-首声提速第一节末那句
 * 「chat < 1s 这一半这张卡一件事都没做」)。那份人设 **3159 字**,每一个回合整份重发;
 * 其中「你能做什么」那十来条工具说明(1012 字)、「听不准的时候」、「文件」、
 * 「她手上的事」那份快照 —— 闲聊回合**一条都用不上**。
 *
 * ## 谁是主人:段与标记在工作台,裁在这儿
 *
 * 人设由 8791 下发(`GET /channel/persona`,`workbench-plugin/src/server/channel.ts` 拼的),
 * 所以**标记的主人是工作台**:它把那一整段拆成一段一段
 * (`channelPersonaSections`),每段带上「哪些意图 / 哪件工具用得上它」。
 * 这个文件只做一件事:按**这一回合**的意图与手上那几件工具把用不上的段摘掉。
 *
 * 两头为什么这么分:
 *   · 意图↔工具那张表在工人手上(`intentTools.ts`),工作台不该再抄一份 ——
 *     所以讲某一件工具的那几段按**工具名**标({@link PersonaSection.tool}),
 *     工人拿「这一回合真送出去的那几件」一比就完。说明书与手上那几件天生对齐,
 *     不可能出现「说明书讲了一件手上没有的工具」;
 *   · 与具体哪一件工具无关、但闲聊回合用不上的那几段(工具的成败怎么说、听不准名字怎么办、
 *     她手上的事)按**意图**标({@link PersonaSection.intents},id 与 `intentTools.ts` 同一套)。
 *
 * ## 三条纪律
 *
 *   ① **必带段一段都不许少**:身份(「只有一个我」)、底线(「说话的规矩」)、语气、
 *      **澄清环节**(「拿不准的时候怎么问」—— 它在不可改清单上,PRD §9)。
 *      这几段由工作台标 `always`,这儿只认不判;
 *   ② **看不懂就带整份**({@link personaForTurn} 回 `undefined`)。一段没有任何标记
 *      = 这是我们不认得的一份人设(更新了工作台、工人还是老的,或者反过来),
 *      那就一个字都不裁 —— 「不漏规矩」比「省几百字」贵;
 *   ③ **裁在这一次的上下文副本上**({@link withTrimmedPersona}),不走 `updateInstructions`:
 *      那是异步的、抢不赢回合提交(真机 `commit_ms` 5~40ms),而且会把裁过的人设
 *      **留到下一回合**。与 `turnRoute.ts` 的 `withTurnNote` 同一条道理。
 *
 * 纯的:不认识 LiveKit、不认识房间。换上下文里那条消息要造一条新消息,
 * 造法由调用方注入({@link WithTrimmedPersonaOptions.replace})—— 这个文件不 import 框架。
 */

/**
 * 人设的一段 + 「这一回合用不用得上它」那个标记。
 * **与 `workbench-plugin/src/server/channel.ts` 的 `ChannelPersonaSection` 逐字相同**
 * (两个仓库不互相 import,见 workbench.ts 文件头那条老规矩;有对照用例读源头比对段名)。
 */
export interface PersonaSection {
  /** 段名(从来不念给她听,只给日志与用例认)。 */
  name: string
  /** 这一段的原文。按顺序拼起来逐字就是 `persona.system_message`。 */
  text: string
  /** 任何回合都得带。 */
  always?: true
  /** 哪些意图用得上它(id 与 `intentTools.ts` 同一套)。 */
  intents?: readonly string[]
  /** 这一段讲的是哪一件工具:这一回合手上有它才带。 */
  tool?: string
  /** 这一段是一组的头:组里有别的段带上了才带它。 */
  head?: string
  /** 这一段属于哪一组。 */
  group?: string
}

/** 这一回合是什么样的一回合。 */
export interface PersonaTurn {
  /** 命中的意图(闲聊回合是空的 —— 分流那边 chat 的判定压根没有这一格)。 */
  intents?: readonly string[]
  /** 这一回合**真送给模型**的那几件工具的名字。 */
  tools?: readonly string[]
}

export interface PersonaTrimResult {
  /** 这一回合真交出去的那一份人设。 */
  text: string
  /** 带上了哪几段(段名,日志与用例用)。 */
  kept: readonly string[]
  /** 摘掉了哪几段。 */
  dropped: readonly string[]
}

/**
 * 这一回合的人设。**看不懂的形状一律回 `undefined` = 带整份**(文件头第 ② 条)。
 *
 * 回 `undefined` 的四种情况,意思都一样「照旧整份」:
 *   · 工作台没下发分段(老工作台 / 这一格缺席);
 *   · 下发了但一段都没有;
 *   · **有一段四种标记一个都没有** —— 那是我们不认得的一份人设;
 *   · 裁完一段都不剩(不该发生:必带段至少有一段。兜在这儿免得交一份空人设出去)。
 */
export function personaForTurn(
  sections: readonly PersonaSection[] | undefined,
  turn: PersonaTurn,
): PersonaTrimResult | undefined {
  if (sections === undefined || sections.length === 0) return undefined
  const intents = new Set(turn.intents ?? [])
  const tools = new Set(turn.tools ?? [])
  /** 先判不是「组的头」的那些;头要等组里有没有人带上才知道。 */
  const verdicts = new Map<PersonaSection, boolean | undefined>()
  for (const one of sections) {
    if (one.always === true) { verdicts.set(one, true); continue }
    if (one.tool !== undefined) { verdicts.set(one, tools.has(one.tool)); continue }
    if (one.intents !== undefined) {
      verdicts.set(one, one.intents.some(id => intents.has(id)))
      continue
    }
    if (one.head !== undefined) { verdicts.set(one, undefined); continue }
    // 四种标记一个都没有:这份人设我们看不懂,一个字都不裁。
    return undefined
  }
  // 组的头:组里有别的段带上了才带它。
  for (const one of sections) {
    if (verdicts.get(one) !== undefined) continue
    const group = one.head as string
    const any = sections.some(other => other.head === undefined && other.group === group && verdicts.get(other) === true)
    verdicts.set(one, any)
  }
  const kept = sections.filter(one => verdicts.get(one) === true)
  if (kept.length === 0) return undefined
  return {
    text: kept.map(one => one.text).join('\n'),
    kept: kept.map(one => one.name),
    dropped: sections.filter(one => verdicts.get(one) !== true).map(one => one.name),
  }
}

/**
 * 8791 下发的那一格认不认(`GET /channel/persona` 的 `persona_sections`)。
 *
 * **两道门,过不了就整格缺席**(= 照旧每回合整份,和这一版之前一字不差):
 *   ① 形状:非空数组,每一段 `name` / `text` 都是字符串,`name` 不是空的,
 *      几个标记该是什么类型就得是什么类型 —— 多出来的键原样丢掉(不认得的格不留着);
 *   ② **拼回去要逐字等于整份人设**。裁出来的那一份要去替掉上下文里整份人设那一段
 *      ({@link withTrimmedPersona}),对不上就说明两边不是同一份东西 ——
 *      那时候宁可一个字都不裁。
 */
export function personaSectionsOf(value: unknown, systemMessage: string): readonly PersonaSection[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined
  const out: PersonaSection[] = []
  for (const raw of value) {
    if (raw === null || typeof raw !== 'object') return undefined
    const one = raw as Record<string, unknown>
    if (typeof one.name !== 'string' || one.name.trim() === '') return undefined
    if (typeof one.text !== 'string') return undefined
    const intents = one.intents
    if (intents !== undefined
      && (!Array.isArray(intents) || intents.some(id => typeof id !== 'string' || id.trim() === ''))) return undefined
    if (one.always !== undefined && one.always !== true) return undefined
    for (const key of ['tool', 'head', 'group'] as const) {
      if (one[key] !== undefined && (typeof one[key] !== 'string' || (one[key] as string).trim() === '')) return undefined
    }
    out.push({
      name: one.name,
      text: one.text,
      ...(one.always === true ? { always: true as const } : {}),
      ...(intents === undefined ? {} : { intents: (intents as string[]).slice() }),
      ...(one.tool === undefined ? {} : { tool: one.tool as string }),
      ...(one.head === undefined ? {} : { head: one.head as string }),
      ...(one.group === undefined ? {} : { group: one.group as string }),
    })
  }
  if (out.map(one => one.text).join('\n') !== systemMessage) return undefined
  return out
}

/** 上下文里的一条消息。**只认我们要读的那两格**,不 import 框架的类型。 */
export interface PersonaChatItem {
  type?: string
  role?: string
  content?: readonly unknown[]
}

/** 这一次调模型的上下文。只认 `copy` 与 `items`(与 turnRoute.ts 的 `AckChatContext` 同一条分寸)。 */
export interface PersonaChatContext {
  copy(): PersonaChatContext
  items: PersonaChatItem[]
}

export interface WithTrimmedPersonaOptions {
  /** 整份人设(`persona.system_message`)—— 在上下文里就按这一段找。 */
  full: string
  /** 这一回合那一份(`personaForTurn` 算出来的)。 */
  trimmed: string
  /**
   * 造一条换上去的消息。**不原地改那条旧消息**:框架的 `ChatContext.copy()` 是**浅**的
   * (`dist/llm/chat_context.js` 第 509–533 行,原样 `items.push(item)`),
   * 原地改会把对话历史里那一条也改掉 —— 裁过的人设于是留到了下一回合。
   */
  replace: (like: PersonaChatItem, text: string) => PersonaChatItem
  /** 找不着那条人设消息时说一句(只进日志)。 */
  log?: (line: string) => void
}

/**
 * 把这一次上下文**副本**里那条人设消息换成裁过的那一份。
 *
 * 找法:第一条「`content` 就是一段字、而且那段字里有整份人设」的消息。
 * 为什么按内容找而不按框架那个 id(`lk.agent_task.instructions`)找:那个 id 是上游的内部约定,
 * 而整份人设是**我们自己给出去的**那一段 —— 比对自己的东西不会认错。
 *
 * **找不着就原样返回**(连副本都不造):那说明这一通的提示词不是我们认得的样子
 * (引导、来电那两套提示词走的是别的路,压根不到这儿),一个字都不该动。
 */
export function withTrimmedPersona<T extends PersonaChatContext>(ctx: T, options: WithTrimmedPersonaOptions): T {
  if (options.full === '' || options.trimmed === options.full) return ctx
  const at = ctx.items.findIndex(one => onlyText(one)?.includes(options.full) === true)
  if (at < 0) {
    options.log?.('[channel-worker] 这一次的上下文里找不到那份人设:按整份走(一个字没裁)')
    return ctx
  }
  const item = ctx.items[at] as PersonaChatItem
  const text = (onlyText(item) as string).replace(options.full, options.trimmed)
  const copy = ctx.copy() as T
  copy.items[at] = options.replace(item, text)
  return copy
}

/** 这条消息的内容「就是一段字」吗(识别那条路造出来的人设消息就是它)。不是就回 undefined。 */
function onlyText(item: PersonaChatItem | undefined): string | undefined {
  const content = item?.content
  if (!Array.isArray(content) || content.length !== 1) return undefined
  const one = content[0]
  return typeof one === 'string' ? one : undefined
}
