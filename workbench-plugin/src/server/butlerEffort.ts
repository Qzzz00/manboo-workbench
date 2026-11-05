/**
 * 思考档:哪件事用哪档(2026-09-28,卡 BS;`docs/设计-事务官做什么不做什么与思考分档-2026-09-28.md` 6.2)。
 *
 * ## 为什么要有这一份
 *
 * 09-28 实测(`docs/设计-…-思考分档` 第〇节):一天 150 万字思考,输出里 74% 是思考,
 * 而思考**按输出计价**(Flash 输出 8 元 / 百万 token,缓存命中的输入 0.04 元,差 200 倍)。
 * 在这之前我们那条中转路由一个思考参数都没声明,DSH 压根不发 —— 于是一律走 DeepSeek 默认的「开着想」:
 * 「给 Minus 发个信息问国庆放几天」也想了 1.7 万字。
 *
 * ## 规矩
 *
 * - **全局默认 = 关**。`BUTLER_EFFORT` 里查不到的、没填档的,都是关。
 * - **一个会话一个档,中途不切**。DeepSeek 多轮带工具时要把思考内容回放回去
 *   (`requiresReasoningContentOnAssistantMessages`),中途切档容易出事。
 * - **每条会话都明写档位**,不靠全局默认:DSH 的 `selectModel` 会顺手把这次的选择记成全局默认
 *   (上游 `saveSelection`),所以「上一条会话开了 high」会漏给下一条。
 * - 档位只管事务官**自己**想多久;派出去的那几家在自己的进程里、用自己的订阅,不经这里。
 *
 * 线上那几档怎么落到 YAML 里(provider 的 `compat` + 每个模型的 `reasoningEfforts`),
 * 见 `dshModelSettings.ts` 的 `RELAY_THINKING_LEVELS`。
 */

import { relayThinkingLevels } from './dshModelSettings.ts'

/** 能选的四档。`off` = 发 `thinking: { type: 'disabled' }`。 */
export type ButlerEffort = 'off' | 'low' | 'high' | 'max'

/** 查不到、没填、填错,都回这一档。 */
export const BUTLER_EFFORT_DEFAULT: ButlerEffort = 'off'

/**
 * 事务官的活分成这几类(设计第二节 A1–A10 的归并,按「要想多久」而不是按接口分)。
 * 名字是给读代码的人看的,不出现在界面上。
 */
export type ButlerJob =
  /** A1 分拣:一句话 → 是一件事还是随手一问,挂到哪个项目。 */
  | 'intake'
  /** A3 她点了名:直接派那家,不用挑。 */
  | 'dispatchNamed'
  /** A3 她没点名:按活的种类、各家体检、额度窗口、她的偏好挑一家,带一句理由。 */
  | 'dispatchChoose'
  /** A4 写交代 + A5 跟进核证据(同一条会话里常连着做)。 */
  | 'brief'
  /** A6 捎话:把她的话送进某家正在跑的会话。 */
  | 'relay'
  /** A7 开工汇报:念变化,有人在等。 */
  | 'morning'
  /** A8 下班例程的「关于你的观察」:真判断,错了会学歪。 */
  | 'evening'
  /** A8 每周知识 lint 的综合提案(通读那几个子任务是它自己开的,见下面那段注释)。 */
  | 'lint'
  /** A7 引导/落地单里的对答:她正坐在那儿等回话。 */
  | 'onboarding'
  /** C4 截图验收:只判「跟交代对不对得上」。 */
  | 'screenshotCheck'

/**
 * 设计 6.2 那张表。**没列进来的一律是关**。
 *
 * lint 只有一条 `high`:通读那 11 个子任务(设计 C3,应当是 low)是事务官在它自己那条会话里
 * 开出来的子会话,**不经工作台的开会话口**,我们这一层管不到 —— 交接里记了这一条待办。
 */
export const BUTLER_EFFORT: Readonly<Record<ButlerJob, ButlerEffort>> = {
  intake: 'off',
  dispatchNamed: 'off',
  relay: 'off',
  morning: 'off',
  onboarding: 'off',
  dispatchChoose: 'low',
  brief: 'low',
  screenshotCheck: 'low',
  evening: 'high',
  lint: 'high',
}

/** 这件事该用哪档。 */
export function effortFor(job: ButlerJob): ButlerEffort {
  return BUTLER_EFFORT[job] ?? BUTLER_EFFORT_DEFAULT
}

/**
 * 这个模型**真的有**这一档吗;没有就往上挪一档(`deepseek-v4-pro` 线上没有 low → 用 high)。
 *
 * 为什么往上而不是往下:要 low 的那几件事(挑一家、写交代、核证据)是**要它想一点**的,
 * 掉到关等于把这件事的判断去掉;而往上只是贵一点,而且 pro 本来就不是默认模型、极少被选中。
 * 模型名不认识时原样返回 —— 他切回了自己的 Key 走的是别人的路由,那边有哪几档我们不知道,
 * 由 DSH 那边拒掉(`selectModel` 抛错 → 会话照开,走它的默认)。
 */
export function resolveEffort(modelId: string | undefined, effort: ButlerEffort): ButlerEffort {
  if (modelId === undefined || modelId === '') return effort
  const levels = relayThinkingLevels(modelId).map(one => one.level)
  if (levels.includes(effort)) return effort
  const order: ButlerEffort[] = ['off', 'low', 'high', 'max']
  const from = order.indexOf(effort)
  for (let i = from + 1; i < order.length; i += 1) {
    const up = order[i] as ButlerEffort
    if (levels.includes(up)) return up
  }
  return BUTLER_EFFORT_DEFAULT
}
