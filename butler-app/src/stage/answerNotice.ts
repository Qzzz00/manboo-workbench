/**
 * ★ **App 在后台时那一条通知 —— 正文就是答案本身**(2026-10-04,卡 `claude/answer-comes-to-her`)。
 *
 * 维护者 10-04(经工作台捎话):「我刚给事务官发信息,好消息是信息准确,回复也很快,
 * 坏消息是信息直接从正在办切到办完了,我是自己追过去点开查看的」。
 *
 * 她点头的那一条写得很清楚:「App 在后台时发一条通知,**通知正文就是回答本身**,
 * 不是『有回复了』」。「有回复了」还得她点进来再找一遍,等于没治。
 *
 * ## 走的是现成那条通道
 *
 * 后台来电那张卡(2026-10-03)已经把通知权限与原生插件做齐了,而那件插件的
 * `startRinging({ silent: true })` 本来就是「**只发一条普通通知,不响铃、不拉起来电页**」
 * (夜间静默时段用的那一档,见 `deskphone/deskPhone.ts` 与 `DeskPhonePlugin.java` 的 `silent` 分支:
 * CHANNEL_DESK、CATEGORY_MESSAGE、PRIORITY_LOW、不震动、不是常驻通知)。
 * 一条答案通知要的正是这些。
 *
 * 2026-10-09 起 `silent` 那一路走原生 `postNotice`,`callId`(`answer:<id>`)当通知的 tag:
 * 每条答案各占一条,不盖静默来电、不盖座机常驻那条。老手机包没有 `postNotice` 时退回老路,
 * 那时同一时刻只摆得下一条(答案本身在 `/state.answers` 里一个字没丢)。
 *
 * ## 这个文件里一行 I/O 都没有
 *
 * 判「这一条该不该推」是纯函数({@link answerNoticeFor}),推那一下在 `useAnswerNotice`。
 */
import type { AnswersView } from '../api/protocol';

/** 通知那一条抬头里的缺省话(她问的那一句丢了的老账)。 */
export const ANSWER_NOTICE_TITLE = '事务官答你';

export interface AnswerNotice {
  /** 哪一条(推过就不再推;与 `/answers/seen` 用的是同一个 id)。 */
  id: string;
  /** 抬头:她问的那一句。 */
  title: string;
  /** 正文:**答案原文**。 */
  body: string;
}

/**
 * 这一拍该不该推一条通知,推哪一条。
 *
 * 四道门,少一道都会让她烦:
 * 1. **App 在前台就不推** —— 答案已经在她眼前的字幕上了(推了就是同一句话说两遍);
 * 2. **只推最新那条还没看过的**(与字幕摆的那一条**同一条**:`answerCaptionOf` 同一条规矩);
 * 3. **电话里问的那一条不推** —— 她刚在电话里听过了(工作台那一侧 `answerWorthNotifying`
 *    也不会给电脑推,两端同一条口径);
 * 4. **推过的不再推** —— 同一条答案不许在她通知栏里响第二次。
 */
export function answerNoticeFor(input: {
  answers: AnswersView | undefined;
  /** App 这会儿在前台吗。 */
  foreground: boolean;
  /** 已经推过的那几条。 */
  notified: ReadonlySet<string>;
}): AnswerNotice | undefined {
  if (input.foreground) return undefined;
  const one = input.answers?.items.find((item) => item.seen_at === undefined);
  if (one === undefined) return undefined;
  if (one.where === 'call') return undefined;
  if (input.notified.has(one.id)) return undefined;
  return {
    id: one.id,
    title: one.question === '' ? ANSWER_NOTICE_TITLE : one.question,
    // **一个字不截**:截多长由系统的通知栏决定(下拉展开看得到整段),我们不替它裁。
    body: one.answer,
  };
}
