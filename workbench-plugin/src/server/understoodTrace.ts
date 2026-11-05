/**
 * **固定流程直接办掉的那几件,在事务官那里留一行**(2026-10-13,卡「固定流程办的事留痕」)。
 *
 * ## 为什么(维护者 10-13 原话)
 *
 * > 「场景二我也没看到事务官那里有什么记录啊」
 *
 * 她在手机 / 电脑 / 电话里说「把待办改成按日期汇总」,屏幕上那一格真换了,
 * 可事务官面板 / 收件箱 / 记录里**一行字都没有** —— 像什么都没发生。
 * `understand()` 认下来直接办掉的那几件(切待办版本、记发布计划、做视频起步、补细节)
 * 都是「不建卡」的(切版面不是一件事),于是它们在看板上没有任何落处。
 *
 * ## 留在哪一摞
 *
 * 留在**现成那本回答账**(`server/directAnswer.ts` → `/state.answers`,2026-10-04 卡
 * `claude/answer-comes-to-her`)——那本账本来就是「她问的那一句 + 结果一句话」,
 * 电脑事务官页球下那一处与手机球下那一行字幕**都已经在读它**,所以:
 *
 *   · **协议一个字没改**(`AnswerView` 本来就有 `question` / `answer` / `at` / `where`);
 *   · 两端都显示、两端「看过了」同步(`POST /answers/seen`);
 *   · 落盘 24 小时(`direct-answers.json`),重启还在。
 *
 * **不建事项卡**:切版面、补一句细节都不是一件要办的事,建卡会在看板上多出一件没人办的东西
 * (同 `/butler/item` 上改布局那条岔路的分寸)。
 *
 * ## 这个文件里一行 I/O 都没有
 *
 * 纯函数:一件办掉的事 → 账上那一行的 id 与两句话。记进账那一下在 `server/http.ts`(`noteUnderstood`)。
 * **不经模型**:她那句原话照抄,「办了什么」用的是 8791 自己回的那一句(`understanding.say.start` 那一套)。
 */
import type { ButlerRuleChannel } from '../protocol.ts'

/**
 * 哪几件要留痕 —— **只有「办掉了却不建卡」的那几件**。
 *
 * 落在外头的几种各有各的落处,不在这里重复一遍:
 *   · `answer_ask`(替她选上了)—— 那一问从「等你」里消失了,行为账也记了那次拍板;
 *   · `meeting_plan` / `file` / `dispatch` / `remember` —— 各自有卡、有会话、有那张「要文件」的卡。
 */
export const UNDERSTOOD_TRACE_KINDS = ['today_view', 'publish_plan', 'video', 'append'] as const

export type UnderstoodTraceKind = typeof UNDERSTOOD_TRACE_KINDS[number]

export function isUnderstoodTraceKind(kind: unknown): kind is UnderstoodTraceKind {
  return typeof kind === 'string' && (UNDERSTOOD_TRACE_KINDS as readonly string[]).includes(kind)
}

/**
 * 来源那几个字。**与行为账的 `BehaviorEnd` 同一组词**(电话 / 手机 / 电脑),不另造一套说法;
 * 别的几档(`review` / `settings` …)不是她说话的入口,认不出就不写来源。
 */
export const UNDERSTOOD_TRACE_WHERE: Partial<Record<ButlerRuleChannel, string>> = {
  call: '电话',
  phone: '手机',
  desk: '电脑',
}

/** 她那一句在这一行里最多几个字(再长截尾 —— 这一行是给她扫一眼的,全文在字幕 / 纪要里)。 */
export const UNDERSTOOD_TRACE_SAID_MAX = 40

/** 「你说」那两个字:两端显示的是 `question` 那一行,它得读得出这是**她说的**。 */
export const UNDERSTOOD_TRACE_ASK = '你说'

export interface UnderstoodTrace {
  /** 账上那一条的 id。**同一句同一件事只有一个 id** —— 重复说不重复记(判在调用处)。 */
  id: string
  /** 上面那一行:「你说(电话):把待办改成卡片」。 */
  question: string
  /** 下面那一行:办了什么(8791 自己回的那一句,不另编)。 */
  answer: string
}

/** id 里那一截:去掉空白与标点、截短 —— 同一句话说两遍(标点不同)算同一句。 */
function keyOf(said: string): string {
  const bare = said.replace(/[\s。,.,!！?？;;::、…~"'「」『』()()]/gu, '')
  return [...bare].slice(0, UNDERSTOOD_TRACE_SAID_MAX).join('')
}

/**
 * 一件办掉的事 → 账上那一行。**办不成 / 取不到那一句一律缺席**(回 `undefined`)——
 * 「取不到就缺席,不编一个」:没办成就不该在她眼前留一行「办了」。
 */
export function understoodTrace(input: {
  /** `understand().kind`。不在 {@link UNDERSTOOD_TRACE_KINDS} 里的一律缺席。 */
  kind: string
  /** 她那一句原话。 */
  said: string
  /** 办了什么(`understanding.say.start` / 8791 回的那一句)。 */
  done: string
  /** 她在哪说的。 */
  where?: ButlerRuleChannel
}): UnderstoodTrace | undefined {
  if (!isUnderstoodTraceKind(input.kind)) return undefined
  const said = typeof input.said === 'string' ? input.said.trim() : ''
  const done = typeof input.done === 'string' ? input.done.trim() : ''
  if (said === '' || done === '') return undefined
  const key = keyOf(said)
  if (key === '') return undefined
  const from = input.where === undefined ? undefined : UNDERSTOOD_TRACE_WHERE[input.where]
  const shown = [...said].length > UNDERSTOOD_TRACE_SAID_MAX
    ? `${[...said].slice(0, UNDERSTOOD_TRACE_SAID_MAX).join('')}…`
    : said
  return {
    id: `understood:${input.kind}:${key}`,
    question: `${UNDERSTOOD_TRACE_ASK}${from === undefined ? '' : `(${from})`}:${shown}`,
    answer: done,
  }
}
