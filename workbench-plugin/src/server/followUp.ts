/**
 * **「她这一句是接着上一句说的吗」的判据**(2026-10-13 晚,卡 P;
 * 交接 `docs/交接-1013-补细节不吞别的话.md`)。
 *
 * ## 为什么单独一个文件
 *
 * 这几样判据有两个主人要用:`understand.ts` 的第 ⑤ 档「补细节」,
 * 以及 `videoChain.ts` 的 `promptWithDetail` / `amendPrompt`(并进可灵那句提示词之前再兜一道)。
 * 而 `understand.ts` 本来就要问 `videoChain.ts` 认视频那一句 —— 判据留在 `understand.ts` 里
 * 就是两个文件互相 import。判据下沉到这一层,两边都只往下看:
 * `understand.ts → followUp.ts`、`videoChain.ts → followUp.ts`,没有环。
 *
 * 原先这几样(应声表、`looksLikeFollowUp`)住在 `understand.ts`,**内容一字没动**地搬到这里;
 * `understand.ts` 照旧把它们 re-export 出去(`callSummary.ts` 与用例读的是那一处)。
 *
 * ## 为什么要收紧(演示机 2026-10-13 20:30 真机)
 *
 * 诊断包 `日志/channel-worker.log` 里那四句:
 *
 * ```
 * 帮我生成一个小女孩在路边奔跑的视频。 → video/demo
 * 帮我把待办的组件改为。             → append  ← 一句切待办的话被 ASR 切成两段
 * 的形式。                           → append  ← 两段都当成了「补细节」
 * 改为卡片的形式,要平铺。            → today_view
 * ```
 *
 * 两段都记在了做视频那张卡上,还并进了可灵那句提示词 ——
 * 可灵拿到的提示词里夹着「帮我把待办的组件改为。的形式。」。
 *
 * 所以「补细节」从此要像**一句描述**:不是吩咐、不是半句话、不短到听不出补的是什么、
 * 也不说着别的那件事。对不上就**交给后面的认法**(认不出是 `none`、交给模型),不当 append。
 */
import { OTHER_BUSINESS_WORDS, todayViewAsked } from './demoPlaybook.ts'
import { publishPlanOf } from './publishPlan.ts'

/** 补细节 / 答挂着那一问的那句话最长这么多字 —— 再长就是一件新的事。 */
export const FOLLOW_UP_MAX_CHARS = 20

/**
 * 这一句**不是**在补细节 / 答那一问:里头带着办事的动词,那是一件新的事。
 * 10-13 早真机那句「我是说记一下,哎呀。」就靠「记一下」落在这张表上(她在纠正,不是在补细节)。
 */
const NOT_A_FOLLOW_UP = /记一下|记下|记住|派|交给|安排|打开|关掉|取消|删|查一下|搜|找一下|发给|发到|改成|改回|换成|换个|提醒|打电话|汇报/u

/**
 * 光一句应答(「好的」「对」「算了」)—— 不当细节记,也不替她拿去答那一问。
 *
 * **应答词这一张表只在这一处**:通话纪要那一句摘要(`callSummary.ts`:「这一句算不算聊了什么」)
 * 读的是同一张,不抄第二份。
 *
 * 2026-10-13 下午起另有一张更宽的 {@link PLAIN_ACK}(带语气词的应声、叠字、光一个感叹词),
 * **只给 {@link looksLikeAck} 用** —— 纪要那一处照旧只读这一张(放宽它会改掉纪要里记哪几句)。
 */
export const PLAIN_ANSWER = /^(?:好|好的|好吧|对|对的|是|是的|嗯+|行|行吧|可以|没错|收到|知道了|明白|懂了|不对|不是|没有|还没|不用|算了|不要|随便|都行|你定)[。,.,!！?？]?$/u

/**
 * ★ **光一句应声 / 感叹 / 闲话**(2026-10-13 下午,卡 C;验收交接第三节第 19 条)。
 *
 * 14:3x 那一通:卡 t-86856ebb 撞上限、挂着一问,他说「看见了,嗯」—— 旧判据只排掉
 * {@link PLAIN_ANSWER} 那一张(整句就那几个字),「看见了,嗯」漏了进去,于是 `/asks/voice`
 * 替他「答」了那一问、她说「好了,替你选上了」,而那张卡仍然 blocked。
 *
 * 这一张收的是**同一类东西的另几种写法**:带语气词的应声(「嗯,看见了」)、叠字
 * (「好好好」「行行行」)、光一个感叹词(「哦」「哎」)。判法与 {@link PLAIN_ANSWER} 一样:
 * **整句就这几个字才算** —— 「看见了,那就停掉」里有实话,不在这张表上。
 */
export const PLAIN_ACK = /^(?:[嗯啊哦噢诶哎呃]+|看见了|看到了|听见了|听到了|我看见了|我看到了|知道了|明白了|懂了|了解|好了|是这样|原来是这样|没事|没什么|继续说|你说|我在听)[。,.,!！~]*$/u

/** 叠字那几种(「好好好」「对对对」「行行行」)。 */
const DOUBLED_ACK = /^(好|对|行|嗯|是|哦|啊)\1+$/u

/** 应声那几句之间的那几个标点(「看见了,嗯」是**两段**应声,不是一句实话)。 */
const ACK_SPLIT = /[,,。.!！??、;;\s]+/u

/**
 * ★ **这一句只是应声 / 感叹 / 闲话**(卡 C)。
 *
 * **拆成几段,每一段都是应声才算** —— 14:3x 真机那一句「看见了,嗯」正是两段应声拼起来的;
 * 而「看见了,那就停掉」里第二段是实话,不算应声(她真的在答)。
 */
export function looksLikeAck(said: string): boolean {
  const parts = (said ?? '').trim().split(ACK_SPLIT).filter(one => one !== '')
  if (parts.length === 0) return false
  return parts.every(one => PLAIN_ANSWER.test(one) || DOUBLED_ACK.test(one) || PLAIN_ACK.test(one))
}

/** 问句(她在反问,不是在答) */
export const ASKING = /[?？]\s*$|吗[。.!！]?\s*$|呢[。.!！]?\s*$/u

/**
 * 这一句能不能当「补细节 / 答那一问」。短、不是应声、不是反问、不带办事的动词。
 * 应声那一道自 2026-10-13 下午起走 {@link looksLikeAck}(「看见了,嗯」那一类也拦住)。
 *
 * **答那一问**那一档读的就是它({@link ASKING} 之外没有别的门);
 * **补细节**那一档自 2026-10-13 晚起还要再过 {@link looksLikeAppendDetail} 那四道。
 */
export function looksLikeFollowUp(said: string): boolean {
  const text = said.trim()
  if (text === '') return false
  if ([...text].length > FOLLOW_UP_MAX_CHARS) return false
  if (looksLikeAck(text)) return false
  if (ASKING.test(text)) return false
  return !NOT_A_FOLLOW_UP.test(text)
}

/* ──────────────────────── 补细节那道门(卡 P) ──────────────────────── */

/**
 * 去掉标点之后至少这么多字才听得出补的是什么(演示机那一句「的形式」= 3 个字)。
 */
export const APPEND_MIN_CHARS = 4

/**
 * ★ **话没说完就断在这儿的那几个词**(连接词 / 介词 / 还没带上宾语的动词)。
 *
 * 演示机那一句「帮我把待办的组件改为。」断在「改为」上 —— ASR 把一句话切成了两段,
 * 补细节那道门要认得出这是**半句话**:等她把那一句说完,别拿半句去改卡、改提示词。
 */
export const APPEND_DANGLING_TAIL = /(?:改为|改成|改到|换成|换到|变成|做成|弄成|叫做|把|将|的|地|给|让|叫|要|想|和|跟|与|或|还有|而且|然后|接着|再|就|是|有|用|加|减|放|比|像|从|到|在|向|往|对|被|并|且)[。.,,、!!??~…\s]*$/u

/**
 * ★ **以办事的动词起头 = 一句吩咐**,不是在说细节。
 *
 * 补细节是「七八岁吧,穿小碎花连衣裙」这种**描述**;「帮我…」「把…」是又交代了一件事,
 * 该交给后面的认法(固定流程 / 派活 / 模型),不许并进刚才那一件。
 */
export const APPEND_ORDER_HEAD = /^(?:帮我|帮忙|帮|请|麻烦|给我|替我|让|叫|你去|去|把|将)/u

/**
 * ★ **这一句算不算「给刚开始那件事补细节」**(2026-10-13 晚,卡 P)。
 *
 * 回 `undefined` = 算;回一句话 = **不算**,那句话就是理由(日志与 `understand().why` 读它)。
 *
 * 五道,顺序就是判据:
 *   ① 不像在接着说({@link looksLikeFollowUp}:太长 / 应声 / 反问 / 带着办事的动词);
 *   ② 太短({@link APPEND_MIN_CHARS});
 *   ③ 半句话({@link APPEND_DANGLING_TAIL});
 *   ④ 一句吩咐({@link APPEND_ORDER_HEAD});
 *   ⑤ 说的是别的那件事 / 对得上别的固定流程(词表与认法都**复用**那几处,不抄第二份:
 *      `demoPlaybook.ts` 的 {@link OTHER_BUSINESS_WORDS} 与 `todayViewAsked`、
 *      `publishPlan.ts` 的 `publishPlanOf`)。
 *
 * **做视频那一句**不在这里认:`understand()` 里视频(第 ②)排在补细节(第 ⑤)前面,
 * 对得上就按视频走、永远到不了这一档;而这个文件认视频就又成了环(文件头那一段)。
 *
 * `at.nowMs` 缺席时跳过发布计划那一支(「20 号」要靠这一刻才算得出是哪天);
 * 别的四道照旧 —— 「发布 / 日历 / 发布计划」这几个字本来就在 ⑤ 那张词表上。
 */
export function notAppendDetailWhy(said: string, at?: { nowMs?: number }): string | undefined {
  const text = (said ?? '').trim()
  if (text === '') return '空的一句'
  if (!looksLikeFollowUp(text)) return '不像在接着说(太长 / 应声 / 反问 / 带着办事的动词)'
  const bare = text.replace(/[\p{P}\p{S}\s]/gu, '')
  if ([...bare].length < APPEND_MIN_CHARS) return `太短(「${text}」),听不出补的是什么`
  const dangling = APPEND_DANGLING_TAIL.exec(text)
  if (dangling !== null) return `半句话(断在「${dangling[0].trim()}」),等她说完`
  const order = APPEND_ORDER_HEAD.exec(text)
  if (order !== null) return `这是一句吩咐(「${order[0]}」起头),不是在说细节`
  const other = OTHER_BUSINESS_WORDS.exec(text)
  if (other !== null) return `说的是别的那件事(「${other[0]}」)`
  if (todayViewAsked(text) !== undefined) return '这一句在切「今天的待办」那一格'
  if (at?.nowMs !== undefined && publishPlanOf(text, at.nowMs) !== undefined) return '这一句在排发布计划'
  return undefined
}

/** 见 {@link notAppendDetailWhy}:算不算一句补细节。 */
export function looksLikeAppendDetail(said: string, at?: { nowMs?: number }): boolean {
  return notAppendDetailWhy(said, at) === undefined
}

/* ──────────────────────── 只认紧跟着那件事之后的第一句 ──────────────────────── */

export interface AppendGate {
  /**
   * 这一句是不是「那件事之后的第一句」。**每一句都要问一次**(问一次就记一笔)。
   * 同一句再问一遍(工人重问 / 重试)答案不变。
   */
  firstAfter: (open: { item_id: string, at_ms: number }, said: string) => boolean
}

/**
 * ★ **补细节只认紧跟着那件事之后的第一句**(2026-10-13 晚,卡 P)。
 *
 * 演示机那一通里,中间已经插过一句切待办的话了,后面那半句「的形式。」还是并到了做视频那一件上。
 * 工人那头的 `openThing` 只在「这一句真落在某一件上」时才换(`channel-worker/src/agent.ts`),
 * 插进来的那一句要是打的别的路(比如 `/today/view`,它不回 `id`),`open` 就原封不动地带着
 * 上一件的时刻又来一遍 —— 单看那一份 `open` 分不出中间插过话没有。
 *
 * 所以数在 8791 这一侧:`/butler/understand` **每一句都问一次**这道闸
 * (`item_id` + `at_ms` 认那一件事的那一拍)。换了那一拍(工人把这一句落在了那件事上、
 * 或者换了另一件事)就重新算第一句;同一拍上的第二句起一律不算。
 *
 * 一通电话一道闸即可:`at_ms` 是毫秒时刻,两通电话撞不上同一拍。
 */
export function createAppendGate(): AppendGate {
  let last: { item: string, at: number, said: string, first: boolean } | undefined
  return {
    firstAfter(open, said) {
      const text = (said ?? '').trim()
      if (last !== undefined && last.item === open.item_id && last.at === open.at_ms) {
        // 同一句再问一遍:还是那个答案(别让一次重试把这扇门关掉)。
        if (last.said === text) return last.first
        last = { item: open.item_id, at: open.at_ms, said: text, first: false }
        return false
      }
      last = { item: open.item_id, at: open.at_ms, said: text, first: true }
      return true
    },
  }
}
