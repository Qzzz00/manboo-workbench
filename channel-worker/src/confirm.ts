/**
 * 电话里的确认点(2026-09-23,维护者 13:05:「不能假装自己搞懂了」)。
 *
 * 那天的例子发生在**电话里**:他说「把音色改成可配置、通话中能改」,一路传下来被做成了
 * 「念三个名字让他挑」。电话是这条链路上最容易失真的一段 —— 没有屏幕、没有回看,
 * 她说「好的我记下了」他就只能信。所以这道门必须由嘴来做。
 *
 * ## 这个文件只管两件事
 *
 * 1. **那一段话长什么样**(纯拼字,不经模型);
 * 2. **那道门怎么开**:要问的那一次不建卡、不派活,只回一句让模型照着问的话;
 *    他点头之后带 `confirmed: true` 再调一次才真办。
 *
 * ## 2026-10-12 起:只在拿不准时关门
 *
 * 维护者:「跟事务官电话好啰嗦……即使很清晰很简单的需求也要复述一遍」。从此**要不要问由 8791 说了算**
 * (`/confirm/points` 回包的 `call` 那一格,判据在 `workbench-plugin/src/server/callAsk.ts`):
 * 说清了第一次就真办,回话后面接 {@link DIRECT_DONE_NOTE};只在没说派给谁又几家都能做 / 撤不回或对外 /
 * 明显两种理解 / 她说「先跟我确认」时关门。**拿不到那一格(老工作台、连不上)按问** —— 判不准就问。
 *
 * ## 规则不在这里
 *
 * 「问哪几条」是 8791 的 `POST /confirm/points` 说了算(`workbench.confirmPoints`)。
 * 顶层各子目录互不 import(AGENTS.md),但那不是"各写一份"的理由:这里再写一份规则,
 * 电话里问的和卡上问的就会是两套,而"她到底确认了什么"是这条规矩里唯一说得清的部分。
 *
 * 问不到那张表时(旧版工作台 404 / 8791 没起来)**不装作问过了**:
 * 回一句兜底(见 {@link FALLBACK_ASK}),让她至少问「怎么算做完」,并如实说这一次没拿到表。
 */

/** 卡上那个记号。他说「先记着」时写进 desc —— 看板上一眼看得出这张卡还不能派。 */
export const UNCONFIRMED_MARK = '未确认'

/**
 * 电话里最多念几条。**2026-10-02 从 3 改成 1**(卡「电话里像个活人」)——
 * 8791 那边的 `CONFIRM_POINT_SPOKEN_MAX` 同日同改,两边对不上时以回包为准。
 * 为什么见 workbench-plugin/src/server/confirmPoints.ts 那一处的注释。
 */
export const SPOKEN_MAX = 1

/** 一条确认点(只取电话里用得着的那两个字段)。 */
export interface CallConfirmPoint {
  ask: string
  guess: string
}

/** 问不到那张表时至少要问的那一条。**验收永远不能省**。 */
export const FALLBACK_ASK = '怎么算做完'

/**
 * 他说「先记着」了吗。**一条规则,不交给模型**(同 `prefs.ts` 那条分寸):
 * 模型每次判得不一样,而「卡派没派出去」必须是一件说得清的事。
 *
 * 这几句都是"先别动手"的意思 —— 他没否决这件事,只是这会儿不想过确认点。
 */
const HOLD_WORDS: readonly string[] = ['先记着', '先记下', '先记一下', '记着就行', '先放着', '先别动', '回头再说', '晚点再说']

export function isHoldPhrase(text: string): boolean {
  const said = typeof text === 'string' ? text : ''
  return HOLD_WORDS.some(word => said.includes(word))
}

/**
 * 电话里念的那一段。**最多三条、每条一句**(维护者第 4 条逐字)。
 *
 * 8791 回包里的 `spoken` 就是这一段;这个函数是**兜底的那一份**:问不到那张表时
 * 也得有话可念。两份拼法保持同形 —— 同一件事在电话里不该有两种口气。
 */
export function spokenPoints(input: { understanding: string, points: readonly CallConfirmPoint[] }): string {
  // 2026-10-02:就一句,不复述、不列条(与 8791 的 `spokenConfirmBlock` 同形)。
  const one = input.points.slice(0, SPOKEN_MAX)[0]
  if (one === undefined) return `${input.understanding.trim()},我这就去办。`
  return `${one.ask}?我按「${one.guess}」办。`
}

/**
 * 第一次调用回给模型的那一句:**还没办**,先照这段问他一遍。
 *
 * 形状照抄 `layoutConfirmPrompt` / `confirmPrompt`:先说"没办",再给要念的原话,
 * 最后说清"他怎么答、我下一步怎么调"。三件事缺一件,模型就会在某一次跳过这道门。
 */
export function confirmGateText(input: { spoken: string, doing: string }): string {
  // 2026-10-02:**就问这一句**。「最多念三条 / 逐条纠正」那几行本身就是她听到的经书(卡「电话里像个活人」)。
  return [
    `还没${input.doing}。**就问这一句**(一句,不要复述、不要列条):`,
    `「${input.spoken}」`,
    '',
    '她说「对 / 都对 / 就这样 / 去吧」→ 再调用一次这件工具,把 confirmed 填 true。',
    '她改了内容 → 把她的**原话**补进要办的那句话里,再调用一次并把 confirmed 填 true。',
    `她说「先记着 / 回头再说」→ 把 hold 填 true:那样只记下来、**不派活**,标「${UNCONFIRMED_MARK}」。`,
    '**她没答之前不要说「我记下了」「这就去办」** —— 这一刻什么都还没发生。',
  ].join('\n')
}

/**
 * **简单的事那一档**(2026-09-28,卡 CF 第 6 条)。
 *
 * 维护者第二通:「太啰嗦了,我只是提交了一个简单的事情,确认一次……念了一遍经书」。
 * 点了名、一句话说得清的打听(「让豆包工作查国庆放几天假」)→ 念**一句**就够,
 * 上面那一段里「最多念三条」「逐条纠正」那几行一个字都不出现 —— 那几行本身就是他听到的经书。
 */
export function confirmGateTextSimple(input: { spoken: string, doing: string }): string {
  return [
    `还没${input.doing}。**就问这一句**(一句,不要列条):`,
    `「${input.spoken}」`,
    '',
    '他说「对 / 都对 / 就这样 / 开工」→ 再调用一次这件工具,把 confirmed 填 true。',
    '他改了内容 → 把他的**原话**补进要办的那句话里,再调用一次并把 confirmed 填 true。',
    `他说「先记着 / 回头再说」→ 把 hold 填 true:只建一张卡、**不派活**,卡上标「${UNCONFIRMED_MARK}」。`,
    '**他没答之前不要说「我记下了」「这就去办」。**',
  ].join('\n')
}

/** 同上,但这件工具没有「先记着」那一支(比如给已在办的事补一句)。 */
export function confirmGateTextNoHold(input: { spoken: string, doing: string }): string {
  return [
    `还没${input.doing}。**就问这一句**(一句,不要复述、不要列条):`,
    `「${input.spoken}」`,
    '',
    '她说「对 / 都对 / 就这样」→ 再调用一次这件工具,把 confirmed 填 true。',
    '她改了内容 → 把她的**原话**补进要说的那句话里,再调用一次并把 confirmed 填 true。',
    '**她没答之前不要说「送出去了」** —— 这一刻这句话一个字都还没送出去。',
  ].join('\n')
}

/** 问不到那张表时念的那一段。**如实说这一次没拿到表**,不装作问过了。 */
export function fallbackSpoken(understanding: string): string {
  return spokenPoints({
    understanding,
    points: [{ ask: FALLBACK_ASK, guess: '你照着走一遍、结果跟你说的一样,就算做完' }],
  })
}

/**
 * 他说「先记着」之后卡上那句 desc。**原话在前、记号在后** ——
 * 记号是我们加的,他的话才是这张卡的内容。
 */
export function unconfirmedDesc(text: string): string {
  const said = text.trim()
  return `${said}\n\n(${UNCONFIRMED_MARK}:还没跟他过确认点,先别派活。)`
}

/**
 * 只建了卡、没派活时回给模型的那一句(他说「先记着」那一支)。
 *
 * 最后那半句是这条里最要紧的:**不许说「我让事务官去办了」** ——
 * 09-23 那一通里最刺眼的一处就是她说了一件没发生的事。
 */
export function heldText(input: { what?: string }): string {
  const what = input.what === undefined || input.what.trim() === '' ? '卡' : input.what.trim()
  // 2026-10-02:回给模型的这一句不念系统词(卡 / 看板),也不把自己说成第三个人。
  return `${what}记下了,但**没派活**,标了「${UNCONFIRMED_MARK}」。`
    + '跟她说一句「先记下了,你想开工说一声」就收 —— **不要说「我去办了」**,也别念「看板」「卡」。'
}

/**
 * 说清了、没先问就办了的那一次,回话后面接这一句(2026-10-12)。
 * 工作台那句回执说的是「派出去了 / 记下了」,这一句管的是**别再绕回去确认** —— 不复述她的原话、不再问「对吗」。
 */
export const DIRECT_DONE_NOTE = '(她说清了,没先问就直接办了。)**一句报结果就收**:不复述她的话、不再问「对吗」。'

/** 8791 说要问时,为什么问(与 `callAsk.ts` 的 `CALL_ASK_WHY` 同一组字)。 */
export interface CallAsk {
  ask: boolean
  why: string
  spoken?: string
  hint?: string
}

/**
 * 要问的那一次,门后面补的那一行(按为什么问)。
 * ① 没说派给谁:她点了哪家要带进 assignee,不然第二次还是没点名;③ 两种理解:告诉模型问的是哪一处。
 */
export function askReasonLine(call: CallAsk | undefined): string | undefined {
  if (call === undefined) return undefined
  if (call.why === 'unassigned') return '她点了哪一家 → 再调用时把 assignee 填成那一家,并把 confirmed 填 true;她说「你定」→ 按你说的默认那家填。'
  if (call.why === 'ambiguous' && call.hint !== undefined) return call.hint
  return undefined
}
