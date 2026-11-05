/**
 * 通话纪要的**一句话摘要**(2026-09-25,卡 feat/first-look-orb-top)。
 *
 * 手机首页「最近一次通话」那一格要的是一句话,不是一整段字幕。维护者 09-24 晚用手机语音走了 27 分钟引导,
 * 挂断后那一格还写着「还没有通过电话」—— 引导那一通**从来不落纪要**(怕看板上多一张卡),
 * 而平时那几通落的是整段字幕。这里把两种都收成一句:
 *
 * - **引导那一通**:按阶段机走到哪说(走完了 / 聊到哪一步),项目名照他确认的写。**不落全文** ——
 *   二十几分钟的字幕塞进一张卡谁都不会看,答案本来就在引导存档与记忆文件里。
 * - **平时那一通**:**聊了什么**(2026-10-13 换的口径,见 {@link plainCallSummary})。
 *
 * **2026-10-22 起这一句写在通话记录上,不再是卡的标题**(决策记录同日「通电话是记录不是事项」:
 * 一通电话落成 `server/callRecords.ts` 的一份记录,不建卡)。「写聊了什么」(10-13 维护者:
 * 「你得写出来聊了什么啊」)那一半照旧:手机「通话记录」与「最近一次通话」那一行就是它。
 *
 * **不经模型**(AGENTS.md「不经模型的地方坚决不经模型」):全部从事实拼。零 I/O,纯函数。
 */
import type { CallUtterance } from './rtcCall.ts'
import { PLAIN_ANSWER } from './understand.ts'

/** 引导各阶段在摘要里的短名(「②′ 项目(A 授权线∥访谈线 / B 从零)」那种全名念出来太长)。 */
const STAGE_SHORT: Record<string, string> = {
  opening: '称呼',
  template: '布局',
  branch: '在做什么',
  projects: '项目',
  authorization: '授权',
  habits: '习惯',
  persona: '对话风格',
  naming: '取名',
  wrapup: '收尾',
}

/** 走完 / 走到一半时列「记下了什么」只列这几段(开场、分岔、布局太碎,收尾不是内容)。 */
const RECAP_STAGES = ['projects', 'authorization', 'habits', 'persona', 'naming'] as const

export interface OnboardingSummaryInput {
  done: boolean
  /** 此刻停在哪一段(阶段 id)。 */
  stage: string
  /** 阶段 → 答过的 key(onboarding.detail().answered 同形)。 */
  answered: Readonly<Record<string, readonly string[]>>
  /** 他确认过的项目名(onboarding.json answers.projects.project 的键)。 */
  projects: readonly string[]
}

/** 摘要里一件事最多几个字(2026-10-13 起摘要摆的是「聊了什么」,不再只是开口第一句)。 */
export const FIRST_LINE_MAX = 28

function recapParts(input: OnboardingSummaryInput): string[] {
  const parts: string[] = []
  for (const stage of RECAP_STAGES) {
    if ((input.answered[stage]?.length ?? 0) === 0) continue
    if (stage === 'projects' && input.projects.length > 0) {
      const names = input.projects.slice(0, 3).join('、')
      parts.push(`项目(${names}${input.projects.length > 3 ? ' 等' : ''})`)
      continue
    }
    parts.push(STAGE_SHORT[stage] ?? stage)
  }
  return parts
}

/** 引导那一通的一句话。 */
export function onboardingCallSummary(input: OnboardingSummaryInput): string {
  const parts = recapParts(input)
  if (input.done) return parts.length === 0 ? '引导走完了' : `引导走完了:${parts.join('、')}都记下了`
  const at = STAGE_SHORT[input.stage] ?? input.stage
  return parts.length === 0
    ? `引导聊到「${at}」,下次接着聊`
    : `引导聊到「${at}」,已记下${parts.join('、')},下次接着聊`
}

/* ──────────────── 平时那一通:摘要 = 聊了什么(2026-10-13) ──────────────── */

/** 摘要那一句的开头。**不是**老纪要卡标题那个前缀(`CALL_RECORD_TITLE_PREFIX = '和事务官通了'`)。 */
export const CALL_TITLE_PREFIX = '电话里:'
/** 摘要里最多摆几件事,其余只报件数(那一行不许长成一整段)。 */
export const CALL_TITLE_TOPICS = 2
/** 一句字幕都没有时如实说的那一句。 */
export const CALL_NO_TRANSCRIPT_SUMMARY = '这通没有留下字幕'
/** 两边都只有应声词时如实说的那一句(**不编一件事**)。 */
export const CALL_ONLY_BACKCHANNEL_SUMMARY = '电话里只应了几句,没说什么事'

/**
 * 电话里的开场应声(「喂」「在呢」)。
 *
 * 她那一句算不算「聊了什么」还要过 `understand.ts` 的 {@link PLAIN_ANSWER} —— 应答词那张表
 * **只在那一处**(改它会同时改掉「补细节」的判法),这里只补电话特有的这几句。
 */
const CALL_HELLO = /^(?:喂+|在|在的|在呢|哦+|噢+|啊+|呃+|你好|哈喽|hello|hi)[。,.,!！?？~…\s]*$/iu

/** 这一句说了一件事吗(光应一声、光打招呼都不算)。 */
function saysSomething(text: string): boolean {
  const said = text.trim()
  if (said === '') return false
  return !PLAIN_ANSWER.test(said) && !CALL_HELLO.test(said)
}

/** 这一通里谁说了哪几件事(按原顺序,已经去掉应声与招呼)。 */
function topicsOf(transcript: readonly CallUtterance[], who: CallUtterance['who']): string[] {
  return transcript.filter(line => line.who === who && saysSomething(line.text)).map(line => line.text.trim())
}

function cut(said: string): string {
  return [...said].length > FIRST_LINE_MAX ? `${[...said].slice(0, FIRST_LINE_MAX).join('')}…` : said
}

/**
 * 平时那一通的一句话 = **聊了什么**(2026-10-13;维护者:「你得写出来聊了什么啊」)。
 *
 * 从前这一句写的是「你先说的是『…』,一共 N 句」,看不出聊了什么。
 *
 * 取的先后(**不经模型**,全从字幕拼):
 *   ① 她说的那几件事(应声词与招呼不算)—— 前 {@link CALL_TITLE_TOPICS} 件,其余只报件数;
 *   ② 她一句实质的都没说 → 说**事务官说了什么**(来电那一通的价值正在这一句);
 *   ③ 两边都只有应声 → 如实说没说什么事;一句字幕都没有 → 如实说没留下字幕。
 */
export function plainCallSummary(transcript: readonly CallUtterance[]): string {
  const lines = transcript.filter(line => line.text.trim() !== '')
  if (lines.length === 0) return CALL_NO_TRANSCRIPT_SUMMARY
  const mine = topicsOf(lines, 'me')
  if (mine.length > 0) {
    const head = mine.slice(0, CALL_TITLE_TOPICS).map(cut).join(';')
    const rest = mine.length - CALL_TITLE_TOPICS
    return `${CALL_TITLE_PREFIX}${head}${rest > 0 ? `;还说了 ${rest} 件` : ''}`
  }
  const hers = topicsOf(lines, 'butler')
  const first = hers[0]
  if (first !== undefined) return `${CALL_TITLE_PREFIX}事务官说「${cut(first)}」`
  return CALL_ONLY_BACKCHANNEL_SUMMARY
}
