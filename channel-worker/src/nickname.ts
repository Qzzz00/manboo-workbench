/**
 * 问称呼那一轮(2026-09-25,卡 fix/call-under-load-and-name)。
 *
 * 维护者:「为什么总是第一次听名字的时候听不清」。最近四次引导问称呼,第一遍识别分别是
 * 「教我变就可以了」「编辑」「叫我变就了」(他说的是英文名 Ben),第二遍说成整句才对。
 *
 * 两件事,都只在「还没记下称呼」的那一段起作用:
 *   ① **问话当上下文交给火山**({@link NICKNAME_ASR_CONTEXT}):火山大模型流式识别的
 *      `corpus.context` 收对话上下文(dialog_ctx)。它知道上一句是「怎么称呼你」,
 *      接下来那个音就更可能是一个名字(包括英文名),而不是「变」「编辑」;
 *   ② **没把握就请他打字**({@link nicknameDoubt}):识别出来的称呼只有一个字、开头把「叫我」
 *      听成了「教我」、或者剥掉「叫我 … 就可以了」之后一个字都不剩,就在这一轮的上下文里补一行提示,让她请他在手机屏幕下面的
 *      输入框里打出来 —— **不再说「没听清,再说一遍」**:再说一遍还是同一个口音、同一个识别,
 *      对不对全凭运气;打出来的字是准的。
 *
 * 「不像个名字」(例如整句只有「编辑」两个字)这种判断**交给模型**(提示词里写了例子),
 * 这里只判几种一眼就能看出来的,宁可少判不可错判 —— 错判的代价是他说得清清楚楚也被要求打字。
 *
 * 纯函数,不认识 LiveKit;接线在 agent.ts。
 */
import type { OnboardingBrief } from './onboarding.ts'

/**
 * 问称呼那一轮带给火山的对话上下文。第一条是她那句问话(开场白的最后一句,
 * 见 onboarding.ts 的 ONBOARDING_OPENING_LINE);第二条是场景说明 ——
 * 火山文档里的例子本身就有「当前环境信息: …」这种一行说明。
 */
export const NICKNAME_ASR_CONTEXT: readonly string[] = [
  '你希望我怎么称呼你?',
  '当前场景:电话里第一次认识,对方接下来会说希望被怎么称呼,可能是中文名、英文名或昵称。',
]

/** 这会儿是不是还在等他的称呼(引导第一段,称呼还没记下)。 */
export function awaitingNickname(brief: (Pick<OnboardingBrief, 'stage' | 'nickname'> & { answered?: OnboardingBrief['answered'] }) | undefined): boolean {
  if (brief === undefined || brief.stage !== 'opening') return false
  if (brief.answered?.opening?.includes('nickname') === true) return false
  return brief.nickname === undefined || brief.nickname.trim() === ''
}

/** 标点、空白与口头的「呃 / 嗯」。 */
function plain(text: string): string {
  return text.normalize('NFKC').replace(/[\s,.!?;:、,。!?;:~…—\-"'“”‘’()()《》【】]/g, '').replace(/^(?:呃|嗯|额|啊|那个)+/, '')
}

/** 句首把「叫我」听岔了的几种(「教我」「交我」「找我」……)。 */
const MISHEARD_CALL_ME = /^(?:你)?(?:就)?(教|交|较|觉|搅|找|照|跳)我/

/** 「叫我 X 就可以了」里的 X。拿不出来回去掉标点之后的整句。 */
export function nicknameCandidate(heard: string): string {
  let text = plain(heard)
  text = text.replace(/^(?:你|以后|平时|就|直接|都)*(?:叫我|喊我|称呼我|我叫|我是|叫|喊|教我|交我|较我|觉我|搅我|找我|照我|跳我)/, '')
  // 句尾那几个「就可以了 / 就行 / 吧」可能叠着来(「就行了吧」),剥到剥不动为止。
  let before = ''
  while (before !== text) {
    before = text
    text = text.replace(/(?:就可以了|就可以|可以了|就行了|就行|就好了|就好|就是了|就了|吧|啊|呀|哈|哦|嘛|了|就)$/, '')
  }
  return text
}

/**
 * 这句称呼**像没听准**吗?像就回一句原因(进提示与日志),不像回 undefined。
 *
 * 只判一眼能看出来的:
 *   - 里面有拉丁字母(「叫我 Ben」)→ 火山已经按英文名听出来了,**信它**;
 *   - 句首「教我 / 交我 / 找我……」→ 「叫我」听岔了,后面那个名字多半也岔了;
 *   - 名字只剩一个字(「变」「本」)→ 英文名被听成单字的典型样子,中文称呼也极少是一个字;
 *   - 名字一个字都没剩(整句都是「就可以了」之类)。
 */
export function nicknameDoubt(heard: string): string | undefined {
  const text = plain(heard)
  if (text === '') return undefined
  if (/[A-Za-z]/.test(text)) return undefined
  const misheard = MISHEARD_CALL_ME.exec(text)
  const name = nicknameCandidate(heard)
  if (misheard !== null) return `开头的「${misheard[1] ?? ''}我」像是把「叫我」听岔了,后面的「${name}」多半也不准`
  if (name === '') return '没听出名字'
  if ([...name].length === 1) return `称呼只听出一个字「${name}」`
  return undefined
}

/** 这一轮上下文里补的那一行。**只进这一次调模型的副本**,不进对话历史(同 turnRoute.ts 的 withAckedTurn)。 */
export function nicknameDoubtNote(reason: string): string {
  return `【识别提示】他这句称呼像没听准(${reason})。别猜着记,也**别请他再说一遍**:`
    + '一句话请他在手机屏幕下面的输入框里把名字打出来(「我怕听错,你在屏幕下面把名字打一下吧。」);他打出来的就是准的,直接记。'
}

/** 与 turnRoute.ts 的 AckChatContext 同一个最小接口:只认 `copy` / `addMessage`,不 import 框架类型。 */
export interface HintChatContext {
  copy(): HintChatContext
  addMessage(params: { role: 'system', content: string }): unknown
}

export function withNicknameDoubt<T extends HintChatContext>(ctx: T, reason: string): T {
  const copy = ctx.copy() as T
  copy.addMessage({ role: 'system', content: nicknameDoubtNote(reason) })
  return copy
}
