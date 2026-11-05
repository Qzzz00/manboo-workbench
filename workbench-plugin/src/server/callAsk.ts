/**
 * **电话里要不要先问一句**(2026-10-12,维护者拍板「电话里只在拿不准时先确认」)。
 *
 * 维护者:「跟事务官电话好啰嗦,是因为她每次都要和我确认一遍,即使很清晰很简单的需求也要复述一遍」。
 * 从此电话里交代的事**说清了就直接办**,只在三种情况先问一句:
 *
 *   ① 没说派给谁、又有几家都能做;
 *   ② 撤不回或对外的事(发版、删东西、替她发消息、花钱);
 *   ③ 这句话明显有两种理解。
 *
 * 她说「先跟我确认 / 先问我」时照旧问。「先记着」只建卡不派那一支在电话那头(模型填 `hold`),不在这里。
 *
 * **判断只在这一处,用规则不用模型**(同 `prefs.ts`、`confirmPoints.ts` 那条分寸):她问没问、为什么问,
 * 必须复得现。电话那头走 `POST /confirm/points` 拿这一格(`call`)。**判不准按「问」**:
 * 派活选项表拿不到(①)就问;电话那头拿不到这一格(老工作台 / 连不上)也按问。
 *
 * ① 的家数从派活挑手那张选项表(`dispatchChoices`)来,不另写一张表:能派出去的(`ok`)有两家以上、
 * 默认那家又不是她点的名 / 她的规矩 / 学出来的默认分派,才算「几家都能做、没说给谁」。
 *
 * 纯函数。
 */
import type { AgentDispatchFamily, DispatchDefaultFrom, JobKind } from '../protocol.ts'

/** 电话里哪一件工具在问(兄弟路各管哪几条,见 {@link callAskVerdict})。 */
export type CallAskFor = 'dispatch' | 'feature' | 'hand' | 'layout' | 'file'

export const CALL_ASK_FOR: readonly CallAskFor[] = ['dispatch', 'feature', 'hand', 'layout', 'file']

export const CALL_ASK_WHY = {
  /** 说清了,直接办。 */
  clear: 'clear',
  /** 她说了「先跟我确认」。 */
  asked: 'asked',
  /** ② 撤不回或对外。 */
  irreversible: 'irreversible',
  /** ③ 明显两种理解。 */
  ambiguous: 'ambiguous',
  /** ① 没说派给谁、几家都能做。 */
  unassigned: 'unassigned',
  /** ① 想数家数却拿不到选项表:判不准,按问。 */
  unsure: 'unsure',
} as const

export type CallAskWhy = typeof CALL_ASK_WHY[keyof typeof CALL_ASK_WHY]

export interface CallAskView {
  ask: boolean
  why: CallAskWhy
  /** 要问时念的那一句。缺席 = 用确认点那一句(`spoken`)。 */
  spoken?: string
  /** 给模型看的一句(③:她哪几个字能听成两样)。 */
  hint?: string
}

/** ① 要的那几样(派活选项表 `DispatchChoicesView` 的子集)。 */
export interface CallAskPick {
  kind: JobKind
  default?: AgentDispatchFamily
  default_from?: DispatchDefaultFrom
  options: readonly { family: AgentDispatchFamily, title: string, ok: boolean }[]
}

/** 她要先确认。 */
export const ASK_FIRST_WORDS: readonly string[] = [
  '先跟我确认', '先和我确认', '跟我确认一下', '和我确认一下', '先确认一下', '确认一下再', '先问我', '先问问我', '问我一下再',
  '先给我看', '给我过一眼', '我看过再', '我点头再', '等我说了再',
]
/** 「不用跟我确认」「别问我了」那一类:不算要先确认。 */
const ASK_FIRST_NOT = /(?:不用|不必|别|无需|甭|不需要)(?:再)?(?:先)?(?:跟我|和我|问我|确认)/

/**
 * ② 撤不回或对外的那几类。**分类名就是念给她听的那几个字**(「这件要发版上线,做了收不回来」)。
 * 认错了的代价是多问一句;漏认的代价是一件收不回的事没问就做了 —— 所以词宁宽。
 */
export const IRREVERSIBLE_WORDS: Readonly<Record<string, readonly string[]>> = {
  发版上线: ['发版', '发个版', '发一版', '发布', '上线', '部署', '推到线上', '推送到', 'push', '合并到 main', '合进 main', '合到 main'],
  删东西: ['删', '清空', '卸载', '覆盖掉', '重置', '格式化', '抹掉'],
  替你发出去: ['发给', '发消息', '发信息', '发邮件', '发短信', '发微信', '回复', '回他', '回她', '回邮件', '回消息', '转发', '发朋友圈', '发微博', '发帖', '投稿'],
  花钱: ['付款', '支付', '付钱', '买', '下单', '充值', '订阅', '续费', '转账', '花钱', '打钱'],
}
/** 带着 ② 那几个字、其实说的是工作台里一格的名字(「放进发布计划」)。先抹掉再认。 */
const IRREVERSIBLE_NOT: readonly string[] = ['发布计划', '发布日', '发布时间', '发布节奏']

/**
 * ③ 明显两种理解:指代不明(电话里没有屏幕,「那个东西」指什么她知道、电话那头不知道),
 * 或者她自己给了两条路(「或者」「要么」)。**只收明显的**:「还是」也常是「仍然」,不收。
 */
export const AMBIGUOUS_WORDS: readonly string[] = [
  '那个东西', '这个东西', '那玩意', '那个事', '那件事', '上次那个', '之前那个', '刚才那个', '或者', '要么',
]

/** 选项表里几家能派、几家报名字(① 那一句最多念三家)。 */
const NAMES_MAX = 3

function said(input: { text: string, said?: string }): string {
  return [input.text, input.said ?? ''].join('\n')
}

function askedFirst(text: string): boolean {
  if (ASK_FIRST_NOT.test(text)) return false
  return ASK_FIRST_WORDS.some(word => text.includes(word))
}

function irreversibleOf(text: string): string | undefined {
  let cleaned = text
  for (const word of IRREVERSIBLE_NOT) cleaned = cleaned.split(word).join('')
  const lower = cleaned.toLowerCase()
  for (const [label, words] of Object.entries(IRREVERSIBLE_WORDS)) {
    if (words.some(word => lower.includes(word.toLowerCase()))) return label
  }
  return undefined
}

function ambiguousOf(text: string): string | undefined {
  return AMBIGUOUS_WORDS.find(word => text.includes(word))
}

/** ① 那一句:「Claude、Codex 都能做,派给哪个?我先按 Claude。」 */
export function unassignedSpoken(pick: CallAskPick): string {
  const ok = pick.options.filter(one => one.ok)
  const names = ok.slice(0, NAMES_MAX).map(one => one.title).join('、')
  const fallback = ok.find(one => one.family === pick.default) ?? ok[0]
  return `${names}都能做,派给哪个?${fallback === undefined ? '' : `我先按 ${fallback.title}。`}`
}

/** ② 那一句。 */
export function irreversibleSpoken(label: string): string {
  return `这件要${label},做了收不回来 —— 现在就办吗?`
}

/**
 * 要不要先问一句。次序:她说先确认 → ② → ③ → ①(只派活那一件看)。
 *
 * - `dispatch`(交给谁去办):四条都看;
 * - `feature`(派需求卡,卡上另有文字那一路确认点)/ `hand`(给在办的事补一句,派给谁早定了):不看 ①;
 * - `layout`(改版面,能「撤销」)/ `file`(传到她自己的设备,是一份拷贝):撤得回、不对外,
 *   只在她说「先跟我确认」时问。
 *
 * `pick`:`'none'` = 这台工作台这一回不按家派(没接派活 / 「只出方案」档 / 明说只聊),① 不适用;
 * 缺席 = 想数却没拿到 → 判不准,按问。`named`:她点了名(含点名事务官自己)。
 */
export function callAskVerdict(input: {
  for: CallAskFor
  text: string
  /** 她刚说的原话(电话那头识别出来的那一句)。模型填的 `text` 会被它改写,「先跟我确认」常常就丢在改写里。 */
  said?: string
  named?: boolean
  pick?: CallAskPick | 'none'
}): CallAskView {
  const all = said(input)
  if (askedFirst(all)) return { ask: true, why: CALL_ASK_WHY.asked }
  if (input.for === 'layout' || input.for === 'file') return { ask: false, why: CALL_ASK_WHY.clear }

  const label = irreversibleOf(input.text)
  if (label !== undefined) return { ask: true, why: CALL_ASK_WHY.irreversible, spoken: irreversibleSpoken(label) }

  const vague = ambiguousOf(input.text)
  if (vague !== undefined) {
    return { ask: true, why: CALL_ASK_WHY.ambiguous, hint: `她说的「${vague}」能听成两样,问的就是这一处(用她的话问,带上你更倾向的那个)。` }
  }

  if (input.for !== 'dispatch' || input.named === true || input.pick === 'none') return { ask: false, why: CALL_ASK_WHY.clear }
  const pick = input.pick
  if (pick === undefined) return { ask: true, why: CALL_ASK_WHY.unsure }
  // 聊天的活没点名不派(事务官自己答);她的规矩 / 学出来的默认已经说了归谁。
  if (pick.kind === 'chat') return { ask: false, why: CALL_ASK_WHY.clear }
  if (pick.default_from === 'rule' || pick.default_from === 'project_rule' || pick.default_from === 'learned') {
    return { ask: false, why: CALL_ASK_WHY.clear }
  }
  if (pick.options.filter(one => one.ok).length < 2) return { ask: false, why: CALL_ASK_WHY.clear }
  return { ask: true, why: CALL_ASK_WHY.unassigned, spoken: unassignedSpoken(pick) }
}

export function isCallAskFor(value: unknown): value is CallAskFor {
  return typeof value === 'string' && (CALL_ASK_FOR as readonly string[]).includes(value)
}
