/**
 * **四个演示场景的固定流程表**(2026-10-13,卡「三个入口一套管线」;周三 10-14 演示)。
 *
 * 维护者 10-13 早的原话:
 *
 * > 「抽象一下现在的 4 个演示场景,专门做一个策略:事务官接到这 4 个场景就得进入最丝滑最高效的模式,
 * >   演示不是展示生产,最好是触发固定流程。」
 *
 * ## 这个文件是什么
 *
 * **只有数据 + 匹配**:哪几句话算这四个场景、认出来之后嘴里说哪一句。
 * 「认出来之后干什么」在 `understand.ts`(那一处才知道要打哪条路),
 * 落盘与办事在各自那一层(`videoChain.ts` / `/today/view` / `publishPlan.ts` / `/asks/voice`)。
 * 这里一行 I/O 都没有,也不藏逻辑 —— 看完这张表就知道台上说哪几句话会走固定流程。
 *
 * ## 三条纪律
 *
 *   ① **只认句式,不认模板、不认机器**。任何人、任何时候说这几句都走固定流程 ——
 *      「演示模式」不是一个开关,是「这句话我有把握,不用再问」;
 *   ② **说的话都短**({@link DEMO_SAY_MAX_CHARS} 字一句)。10-13 早真机上一句长话被 TTS 流卡住截断,
 *      而固定流程里这几句是我们自己写的,没有理由写长;
 *   ③ **固定流程里没有先应、没有垫场、没有兜底句**。那三样都是为「要等模型」造的,
 *      这几句话 0 毫秒就有,再垫一句只是啰嗦(接线在 `channel-worker/src/agent.ts`)。
 */
import { TODAY_VIEW_TITLES, type TodayViewStyle } from '../protocol.ts'

/** 四个场景。`understand.ts` 的 `kind` 用的就是这几个名字。 */
export type DemoScene = 'video' | 'today_view' | 'publish_plan' | 'answer_ask'

/** 固定流程里一句话最多这么长(字)。写新句子时对着它量一眼。 */
export const DEMO_SAY_MAX_CHARS = 25

/**
 * 这张表**只给人看**(交接、彩排页、用例里的清单都照它);代码读的是下面那几个函数。
 * 每一行是:台上说什么 → 认在哪 → 嘴里回哪一句。
 */
export const DEMO_PLAYBOOK: readonly { scene: DemoScene, said: string, judged: string, reply: string }[] = [
  {
    scene: 'video',
    said: '帮我做一个 XXX 的视频',
    judged: 'videoChain.ts 的 videoChainPlan(认不出就不走)',
    reply: '好,做 XXX 的视频。先让豆包出参考图,图出来我放进可灵。',
  },
  {
    scene: 'today_view',
    said: '把待办改成卡片 / 待办改回列表',
    judged: '本文件的 todayViewAsked(照 channel-worker 的 wb_todo_view 那几句句式)',
    reply: '好,改成卡片了。/ 好,改回列表了。',
  },
  {
    scene: 'publish_plan',
    said: '计划 18 号发一条关于 XXX 的视频',
    judged: 'publishPlan.ts 的 publishPlanOf(日子说不清就回问一句,不猜)',
    reply: '好,记进发布计划了:10 月 18 号,XXX 的视频',
  },
  {
    scene: 'answer_ask',
    said: '(座机念过豆包那道题之后)绿茶 / 第二个',
    judged: '此刻挂着的那一问 + 这一句不是新的意图(understand.ts)',
    reply: '好了,替你选上了。',
  },
]

/* ──────────────────────── ② 切待办版本 ──────────────────────── */

/** 「今天的待办」那一格。别的句子里也有「待办」两个字,所以要配着下面几张词表用。 */
const TODO_WORDS = /待办|今天的事|事项清单/u
/**
 * ★ **两版现在叫「卡片」与「列表」**(2026-10-13,维护者:「改成按列表展示或按卡片展示」)。
 * 这两张词表要**配着 {@link CHANGE_WORDS} 用**:「待办列表」是她在说那一格本身(念给我听),
 * 不是要我换版面 —— 说了「改 / 切 / 换」才算。
 */
const CARD_WORDS = /卡片|卡式/u
const LIST_WORDS = /列表|清单式/u
/** 老说法:「按日期汇总」= 现在的卡片版(10-12 到 10-13 这两天她习惯的那一句,继续认)。 */
const BY_DATE_WORDS = /(?:按日期|按天|按日子)\s*(?:汇总|分组|归类|合并|排)?/u
/** 老说法:**明说**不汇总 = 现在的列表版(说了这几个词就不用再提「待办」)。 */
const FLAT_SAID = /不\s*汇总|别\s*汇总|不要汇总|取消汇总|平铺|不\s*分组/u
/** 「改回去 / 换回去 / 恢复」—— 它自己说不清改成哪一版,要么明说不汇总,要么提到待办那一格。 */
const BACK_WORDS = /改回|换回|恢复/u
/**
 * ★ 「改 / 切 / 换」(2026-10-13 下午)。真机那一句「改回那个按日期吧」没认出来 ——
 * 词表原先要求同时说到「待办」或「汇总」,而她上一句刚说完待办,这一句只说方向。
 * **说了「按日期 / 平铺」又说了要改**,指的就是刚才那一格。
 */
const CHANGE_WORDS = /改|切|换|变/u
/** 这几句不是在切版面:问话、说别人怎么汇总。 */
const NOT_A_VIEW = /[?？]\s*$/u
/**
 * ★ 说的是**别的那一格**(2026-10-13 下午):「把发布计划改成按日期排」不该切「今天的待办」。
 * 这几个界面名出现而又没提「待办」时一律不认 —— 宁可漏认(同这张表的老规矩)。
 */
const OTHER_CELLS = /发布计划|月历|日历|看板|收件箱|随手记|消耗|项目区|素材/u

/**
 * 「把待办改成卡片」/「待办改回列表」→ 要切成哪一版。认不出就 `undefined`(照老路走,不硬套)。
 *
 * **顺序就是判据**:先看有没有说「卡片 / 列表」(配着「改 / 切 / 换」),
 * 再认老说法「按日期汇总」/「不汇总 / 平铺」(10-12 那两天的句子,映射到卡片 / 列表),
 * 最后才是光秃秃的「改回去」(那一句要同时提到待办那一格才算 —— 不然「改回去」什么都能指)。
 *
 * 一句里两个词都在(「从卡片改成列表」):**后说的那个算**,她说的方向在句子后半截。
 *
 * 2026-10-13 下午放宽一格:「按日期 / 平铺」**配上「改 / 切 / 换」就算**(她刚切过这一格,
 * 下一句只说方向 —— 真机那句「改回那个按日期吧」);光一句「改回去」仍不认。
 *
 * 句式照 `channel-worker/src/tools.ts` 里 `wb_todo_view` 的说明书写的(那边列的就是这几句),
 * 词表没抄第二份:工人那边照旧只管把这一句送过来。
 */
export function todayViewAsked(said: string): TodayViewStyle | undefined {
  const text = said.trim()
  if (text === '' || text.length > 60 || NOT_A_VIEW.test(text)) return undefined
  const aboutTodo = TODO_WORDS.test(text)
  if (!aboutTodo && OTHER_CELLS.test(text)) return undefined
  const card = text.search(CARD_WORDS)
  const list = text.search(LIST_WORDS)
  if ((card >= 0 || list >= 0) && CHANGE_WORDS.test(text)) return card > list ? 'by_date' : 'flat'
  if (BY_DATE_WORDS.test(text) && (aboutTodo || /汇总|分组|归类/u.test(text) || CHANGE_WORDS.test(text))) return 'by_date'
  if (FLAT_SAID.test(text)) return 'flat'
  if (BACK_WORDS.test(text) && aboutTodo) return 'flat'
  return undefined
}

/**
 * ★ **「这一句说的是别的那件事」那张词表**(2026-10-13 晚,卡 P;给 `followUp.ts` 那道门用)。
 *
 * 演示机 20:30 那一通:「帮我把待办的组件改为。」落在做视频那件事的窗口里,被当成补细节
 * 记上了卡、并进了可灵提示词。补细节是一句**描述**,句子里出现这几个字就不是 ——
 * 交给后面的认法(固定流程 / 派活 / 模型)。
 *
 * **上面那几张词表原样复用**(待办 / 卡片 / 列表 / 平铺 / 发布计划 / 日历 … 不抄第二份),
 * 后面几行补的是这张表要管而上面没有的那几格。
 *
 * 「挂」只认「挂断 / 挂了 / 挂掉」:光一个「挂」会错伤真的细节(「挂在树上的秋千」)。
 */
export const OTHER_BUSINESS_WORDS = new RegExp([
  TODO_WORDS.source, CARD_WORDS.source, LIST_WORDS.source, FLAT_SAID.source, OTHER_CELLS.source,
  '组件|小组件|版面|布局|页签',
  '汇总|分组|归类',
  '发布|上线|上传',
  '会议|开会|纪要|日程',
  '音色|嗓子|语速',
  '电话|来电|挂断|挂了|挂掉|打给',
].join('|'), 'u')

/* ──────────────────────── 嘴里那几句 ──────────────────────── */

/**
 * ① 做视频那一句。**两句话**:前一句说清要做什么(她能当场听出我没听错),
 * 后一句说接下来两步 —— 拆成两句是为了每句都短(见 {@link DEMO_SAY_MAX_CHARS});
 * 内容与统筹定的那一句一字不差。
 */
export function demoVideoSay(subject: string): string {
  return `好,做${subject.trim()}的视频。先让豆包出参考图,图出来我放进可灵。`
}

/** ② 切待办版本那一句。「改成 / 改回」照着她说的方向说,不念「版面」「小组件」。 */
export function demoTodayViewSay(view: TodayViewStyle): string {
  return view === 'by_date' ? '好,改成卡片了。' : '好,改回列表了。'
}

/** ② 本来就是这一版(没切)时那一句。**不许说成改了**。 */
export function demoTodayViewSameSay(view: TodayViewStyle): string {
  return `本来就是${TODAY_VIEW_TITLES[view]}的,没动。`
}

/** ④ 替她在别家那个面板上选上之后那一句。 */
export const DEMO_ANSWER_ASK_SAY = '好了,替你选上了。'

/** 补细节(「七八岁,穿小碎花连衣裙」)并进在办那件事之后那一句。 */
export function demoAppendSay(said: string): string {
  const text = said.trim().replace(/[。.!!??]+$/u, '')
  return `加上了:${text}。`
}

/**
 * ★ **这一句落在哪**(2026-10-13,卡 G):视频接力那一件是 `skipSession` 建的,没有会话 ——
 * 这句话改记在卡上(接力还在豆包那一步时连可灵那句提示词一起带上)。
 * 两句都在 {@link DEMO_SAY_MAX_CHARS} 之内:工人认不出别的话时念的就是它。
 */
export const DEMO_APPEND_ON_CARD = '记在卡上了'
export const DEMO_APPEND_ON_CARD_AND_PROMPT = '记在卡上,可灵提示词也带上了'
