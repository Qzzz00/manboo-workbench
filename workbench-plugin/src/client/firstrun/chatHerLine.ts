/**
 * 对话屏上「她最近那一句」字幕取哪一句(2026-09-24,维护者真机:称呼问了两遍)。
 *
 * 那次的经过:点「已经有在做的事」→ 称呼屏(「……首先,你希望我怎么称呼你?」)→ 填 Ben、点「就这么叫」→
 * 进对话屏,字幕**还是那句问称呼**。原因:开会话时模型照念了开场种子句(问称呼),而称呼与分岔是按钮流
 * 通过 `/onboarding/answer` 交的,模型这时还没开口说下一句 —— 回合表里最后一条事务官回合就是那句旧问题,
 * 对话屏照原样把它当「她最近一句」摆了出来,看上去就是又问一遍;他于是在对话框里又答了一遍。
 *
 * 规矩:**整个首次流程里同一个问题只出现一次**。最后一条事务官回合如果是**已经过去的阶段**的问题
 * (照念的种子句 `kind:'seed'`,或者就是问称呼那一句),而当前阶段已经换了种子句 → 显示当前阶段的种子句
 * (跟手机开会话时自己先摆出种子句是同一个做法)。一条事务官回合都没有 → 也显示当前种子句。
 */
import type { OnboardingTurnView } from './firstRunApi.ts'

/** 与服务端 onboardingTurns.speechKey 同口径:去掉空白与标点,只比字。 */
export function speechKeyOf(text: string): string {
  return text.replace(/[\s\p{P}\p{S}]/gu, '')
}

/** 问称呼那一问的核心字(开场白后半句,Ben 亲笔)。模型照念时会改标点、偶尔加字,只认这几个字。 */
const ASK_NAME_KEY = speechKeyOf('你希望我怎么称呼你')

export function chatHerLine(turns: readonly OnboardingTurnView[], seed: string | undefined): string | undefined {
  let her: OnboardingTurnView | undefined
  for (const turn of turns) {
    if (turn.role === 'assistant' && turn.kind !== 'error') her = turn
  }
  if (her === undefined) return seed
  if (seed === undefined || seed === '') return her.text
  const key = speechKeyOf(her.text)
  const seedKey = speechKeyOf(seed)
  if (key === seedKey) return her.text
  const pastQuestion = her.kind === 'seed' || (key.includes(ASK_NAME_KEY) && !seedKey.includes(ASK_NAME_KEY))
  return pastQuestion ? seed : her.text
}
