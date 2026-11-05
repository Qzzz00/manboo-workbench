/**
 * 分流:这句话要改的是**工作台本体**,还是**用户层**(2026-09-28,卡 FB)。
 *
 * ## 为什么要这一层
 *
 * 2026-09-27 17:15/17:20 拍板(`docs/决策记录.md`):开发活可以派给她机器上的任一家 Agent,
 * 但**她和她的 Agent 不能改本体** —— 派活只派「用户层」(技能、小组件、采集器、布局、偏好);
 * 本体(界面 / 功能 / bug)的毛病事务官**不派任何一家**,整理成一条「反馈给开发者」发回来,
 * 我们修、发版,她点更新。
 *
 * 09-28 早上那一幕就是这条规矩缺位的样子:他在新 Air 上说「发布计划那里没有标记今天是哪一天,
 * 这个不方便,安排 Codex 去处理吧」,事务官准备「派 Codex 在工作台自己的独立工作区里改」,
 * 还说「这台机器上只找到装好的工作台 0.4.49,没找到它的源码目录」—— 派活之前先分流,这一幕不会发生。
 *
 * ## 判据由代码做,不由模型做
 *
 * 同 `layoutWords.ts` 的三个理由(认不出的不猜 / 复述必须是他自己的话 / 各入口同一份判据):
 * 整个文件没有一行 I/O,输入一个字符串、输出一档结论。**工作台里有哪几块**不写死 ——
 * `uiWords()` 从 `templates.ts` 的两套模板标题 + `DEFAULT_MODULE_TITLES` 长出来
 * (旁边那条用例把两套模板的标题逐个查一遍:以后谁加一个模块、改一个标题,词表没跟上就当场红),
 * 再加一张「不是模块、但也是本体」的表(顶栏、粒子球、看板、座机、展示台……)。
 *
 * ## 三档,拿不准就问一句
 *
 * - `product` 本体 —— 提到本体里的某一块 + 「改 / 不对 / 不方便 / 加个…」这类话。不派人,回一句话 + 发一条反馈。
 * - `hers` 用户层 / 她自己的事 —— 照旧往下走(派活、建卡),**这一档是默认**:宁可漏认,
 *   也不能把一件她要交办的活拦成一条反馈(拦错了她那件事就没人办了)。
 * - `unsure` 拿不准 —— 提到本体里的某一块,可动词含糊(「弄一下」「优化优化」)。**问一句**
 *   「这是要改工作台本身,还是给你做个小工具?」,等她答。
 */
import { allTemplates, DEFAULT_MODULE_TITLES } from './templates.ts'

/** 事务官那句回话。**唯一定义处** —— http 那条岔路、手机卡片、电话里念的都是这一句。 */
export const FEEDBACK_REPLY_LINE = '这是工作台本身的问题,我已经反馈给开发者了,修好会随更新到你这。'

/** 拿不准时那一问。 */
export const FEEDBACK_ASK_LINE = '这是要改工作台本身,还是给你做个小工具?'

/**
 * 不是模块、但也是本体的那几块。**只收她真会说出口的**(同 layoutWords 的纪律:
 * 一个泛词命中的代价是把一句本该放过去的话拦成了反馈)。
 *
 * 没收「窗口」「页面」「按钮」这类泛词:它们在小工具里也成立(「给我的小工具加个按钮」)。
 */
const EXTRA_UI_WORDS: readonly string[] = [
  '工作台', '首页', '顶栏', '侧栏', '粒子球', '悬浮窗', '看板', '设置页', '设置里', '体检与修复', '体检页',
  '早报', '日结', '事务官', '收件箱', '窗位叠', '月历', '安装包', '安装器', '更新', '展示台', '座机', '手机上的卡片',
]

/**
 * 本体里有哪几块。**由代码算**:两套模板的标题 + 默认标题 + 上面那张额外表,
 * 按长度倒序(「发布计划」必须先于「发布」命中,同 layoutWords 的 MODULE_ENTRIES)。
 */
export function uiWords(): readonly string[] {
  const words = new Set<string>(EXTRA_UI_WORDS)
  for (const title of Object.values(DEFAULT_MODULE_TITLES)) words.add(title)
  for (const template of allTemplates()) {
    for (const title of Object.values(template.module_titles)) words.add(title)
  }
  return [...words].sort((left, right) => right.length - left.length)
}

/** 这句话提到了本体里的哪一块。都没提到回 undefined。 */
export function uiWordIn(text: string): string | undefined {
  for (const word of uiWords()) {
    if (text.includes(word)) return word
  }
  return undefined
}

/**
 * 一听就是「用户层」的那几个说法。**优先于本体那一档** ——
 * 「给我的发布计划做个小工具」要的是一个小工具,不是改发布计划。
 */
const HERS_WORDS = /小工具|小组件|自定义模块|采集器|采集一下|技能|偏好|我的习惯|布局|窗位|做个工具|写个脚本|做一个工具/

/** 「这里不对 / 这里得改」那一档。命中 + 提到本体里的某一块 = 本体的毛病。 */
const CHANGE_WORDS = new RegExp([
  '不对|不方便|不好用|难用|不合理|别扭|没法用|用不了',
  '|没有标|没标|标不出|看不到|看不见|显示不出|显示不全|错位|对不上|挤在一起|太小|太大',
  '|bug|报错|出错|崩了|崩溃|坏了|失灵|卡住|点不动|没反应|打不开',
  '|改一下|改成|改掉|改改|得改|要改|修一下|修掉|修好',
  '|加个|加一个|加上|添个|添一个|多一个|能不能加|希望有|为什么不|为什么没',
].join(''), 'i')

/** 含糊的那一档:提到了本体里的某一块,可到底要干什么没说清。**问一句**,不猜。 */
const VAGUE_WORDS = /弄一下|弄弄|搞一下|搞搞|优化一下|优化优化|优化下|调整一下|调一下|看一下|看看|能不能弄|想想办法|处理一下|处理下/

export type FeedbackVerdict = 'product' | 'hers' | 'unsure'

export interface FeedbackTriage {
  verdict: FeedbackVerdict
  /** 命中的那一块(「发布计划」)。没命中缺席。 */
  ui?: string
  /** 为什么这么判。**说给她听的一句人话**,也写进反馈里。 */
  why: string
  /** `unsure` 时那一问;别的档缺席。 */
  question?: string
}

/**
 * 分流。派活之前调它 —— `product` 那一档一家都不派。
 *
 * `ctx.explicit` 让调用方(她刚回答了那一问)直接定档,不再认字。
 */
export function triageRequest(text: string, ctx: { explicit?: FeedbackVerdict } = {}): FeedbackTriage {
  if (ctx.explicit !== undefined) {
    return {
      verdict: ctx.explicit,
      why: ctx.explicit === 'product' ? '你说了这是要改工作台本身' : '你说了这是你自己那一层的事',
    }
  }
  const said = text.trim()
  if (HERS_WORDS.test(said)) return { verdict: 'hers', why: '说的是小工具 / 采集器 / 布局这些你自己那一层的东西' }
  const ui = uiWordIn(said)
  if (ui === undefined) return { verdict: 'hers', why: '没提到工作台里的哪一块' }
  if (CHANGE_WORDS.test(said)) return { verdict: 'product', ui, why: `说的是工作台「${ui}」这一块不对 / 要改` }
  if (VAGUE_WORDS.test(said)) return { verdict: 'unsure', ui, why: `提到了「${ui}」,但没说清要改工作台本身还是另做一个`, question: FEEDBACK_ASK_LINE }
  return { verdict: 'hers', why: `提到了「${ui}」,但不像是在说它不对` }
}

/** 一句整理最多多长。反馈列表一行放得下,服务器那边也不必存长篇。 */
export const MAX_FEEDBACK_NOTE = 120

/**
 * 事务官那「一句整理」。**从她自己那句话里切出来**,一个字都不是生成的
 * (同 `devTool.ts` 的 devToolRestate:整理最忌讳整理出她没说过的意思)——
 * 格式只是把命中的那一块提到前面,让统筹一眼看出是哪一格。
 */
export function feedbackNote(said: string, ui?: string): string {
  const body = said.trim().replace(/\s+/g, ' ')
  const head = ui === undefined ? '工作台' : `工作台「${ui}」`
  const line = `${head}:${body}`
  return line.length <= MAX_FEEDBACK_NOTE ? line : `${line.slice(0, MAX_FEEDBACK_NOTE - 1)}…`
}
