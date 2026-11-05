/**
 * 「XX 像是个 Agent,要接上吗?」—— 挂进卡 M 的提问经纪人(2026-09-25,卡 Q;统筹:这一问算「只有他能做的」)。
 *
 * 自动发现两道都判不出的那一家(`agentDiscovery.ts` 的 askAbout)**一个字都不读它**,只在外层问他一句。
 * 这一句不另起一套摆法,走卡 M 的现成做法:
 *   - 挂进 {@link QuestionBroker} → `/state.questions` → `src/waiting.ts` 的 `waitingOnHim` 数进「等你」那一堆、那一个数;
 *   - 电脑球下那一区一张(`QuestionAsk.tsx`)、手机「等你确认」一行(`butler-app/src/asks`),点一个选项就交;
 *   - 答案走 `POST /questions/answer`,回到这里翻成 接上 / 不是 Agent / 先不管;
 *   - 工作台不在前台时弹一条系统通知(卡 M 的 notify);**不打电话**(`askCallOutEvents` 只打挂在事项上的那几问)。
 *
 * 这一问不属于哪条 DSH 会话,会话号用 {@link AGENT_ASK_SESSION}(对不上任何事项,所以摆出来是「事务官问你」)。
 */
import type { QuestionAnswerItem } from '../protocol.ts'
import { AGENT_READ_SCOPE } from '../protocol.ts'
import type { DiscoveryAsker } from './agentDiscovery.ts'
import { ASK_SNOOZE_MS } from './agentDiscovery.ts'
import type { AskQuestionItem, QuestionBroker, QuestionOutcome } from './butlerAsks.ts'
import { clip } from './butlerAsks.ts'

/** 这一问挂在哪条「会话」上:不是 DSH 的会话,对不上任何事项。 */
export const AGENT_ASK_SESSION = 'workbench:agent-discovery'

/** 这一问里那一问的 id(答的时候原样带回来)。 */
export const AGENT_ASK_ITEM_ID = 'agent-connect'

/** 三个选项:**交回来的是这几个字**,改字要连着 {@link agentAnswerOf} 一起改。 */
export const AGENT_ASK_YES = '接上'
export const AGENT_ASK_NO = '不是 Agent'
export const AGENT_ASK_LATER = '先不管'

/** 「先不管」之后几天再问(按 agentDiscovery 的 ASK_SNOOZE_MS 算,一处定)。 */
export const AGENT_ASK_SNOOZE_DAYS = Math.round(ASK_SNOOZE_MS / 86_400_000)

/** 这一问摆出来什么样。`basis` 是登记表里记的判据(窗口里有什么、模型怎么说),截短放在小字里。 */
export function agentQuestion(input: { name: string, basis: string }): AskQuestionItem {
  const basis = input.basis.trim()
  return {
    id: AGENT_ASK_ITEM_ID,
    header: `${input.name} 像是个 Agent`,
    question: `要接上吗?接上以后${AGENT_READ_SCOPE}`,
    ...(basis === '' ? {} : { detail: `为什么这么看:${clip(basis, 120)}` }),
    options: [
      { label: AGENT_ASK_YES, description: '顶上多一颗它的灯,会话列表里看得到它在忙什么' },
      { label: AGENT_ASK_NO, description: '以后不判、不读它' },
      { label: AGENT_ASK_LATER, description: `先不接,${AGENT_ASK_SNOOZE_DAYS} 天后再问` },
    ],
  }
}

/**
 * 他在「我自己说」里写的那一句 → 接不接。只认得很明白的几种说法,**认不准就当「先不管」**(不替他定、也不当他说了不是)。
 */
export function agentAnswerFromText(text: string): 'yes' | 'no' | 'skip' {
  const n = text.toLowerCase().replace(/[\s,。,.!!??、::;;「」“”"'()()\-—…·~～]/g, '')
  if (n === '') return 'skip'
  // 「是不是……我也不知道」里也有「不是」:先把拿不准的说法挑出去。
  if (/是不是|不知道|不确定|说不好|再说|以后|回头/.test(n)) return 'skip'
  if (/不是|不算|别接|不接|不要接|不用接/.test(n)) return 'no'
  if (/^接上/.test(n) || /^(接|要|好|好的|可以|行|是|是的|对|嗯)(吧|啊|呀|了|的)?$/.test(n)) return 'yes'
  return 'skip'
}

/** 经纪人交回来的 → 接 / 不接 / 先不管。撤掉了(他在别处答了、工作台要停了)也回「先不管」—— 撤的那一方自己知道。 */
export function agentAnswerOf(outcome: QuestionOutcome): 'yes' | 'no' | 'skip' {
  if (outcome.kind !== 'answer') return 'skip'
  const mine: QuestionAnswerItem | undefined = outcome.answers.find(one => one.id === AGENT_ASK_ITEM_ID) ?? outcome.answers[0]
  if (mine === undefined) return 'skip'
  if (mine.selected.includes(AGENT_ASK_YES)) return 'yes'
  if (mine.selected.includes(AGENT_ASK_NO)) return 'no'
  if (mine.selected.includes(AGENT_ASK_LATER)) return 'skip'
  return mine.custom === undefined ? 'skip' : agentAnswerFromText(mine.custom)
}

/** 自动发现的「问他一句」接到卡 M 的提问经纪人上。 */
export function createBrokerAsker(broker: Pick<QuestionBroker, 'ask'>): DiscoveryAsker {
  return {
    async ask(input) {
      const asked = broker.ask({
        sessionId: AGENT_ASK_SESSION,
        questions: [agentQuestion({ name: input.name, basis: input.basis })],
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      })
      return agentAnswerOf(await asked.answer)
    },
  }
}
