/**
 * 「她那段回答其实是在问他」(2026-09-27,卡 MS)。
 *
 * ## 撞出来的事
 *
 * 维护者 21:17 让事务官给 Manus 捎句话。那条 DSH 会话什么都没发出去,最后在电脑上列了四条:
 * 「①Minus 是哪一家 ②怎么发 ③回了怎么给你 ④怎么算做完 —— 哪条不对说一下,都对我就开工」。
 *
 * 然后这件事**被记成了「完成」**,note 写着「只是问了一句」,界面上却还显示「进行中」。
 * 维护者:「你看,要确认,但是却没打电话给我,那怎么确认?」「这个事项又要出问题,根本禁不起查验」。
 *
 * 两处错叠在一起:
 *
 * 1. 「只是问了一句」那一章(卡 Y,`casualAsk.ts`)的三问数的是**他有没有交代一件事**
 *    (派出去了 / 改了文件 / 交回了东西)。会话只回了一段话 → 三问全否 → 收掉。
 *    可这一段话不是答案,**是一个问题**:它在等他。收掉等于把「要你定」藏起来。
 * 2. 在等他,却只把那段字挂在电脑界面上 —— 他人在电话里、在手机上,根本看不见。
 *
 * ## 这个文件做什么
 *
 * 一件纯活:**这段回答是在问他吗**。是 → 那张卡不是「完成」也不是「等我确认」,
 * 是「阻塞 · 等你输入」(「等你」那一堆,`src/waiting.ts` 第四条),而且从他来的那一端问回去
 * (电话来的回电,`server/callOut.ts` 的 `taskCallOutEvent`)。
 *
 * **不经模型**:判据是**她自己写下的那几个字**(确认点的抬头、「哪条不对」「都对我就开工」、
 * 结尾的问号)。数的是她的话,不是猜她的意图。宁可漏认(那张卡照旧进「等我确认」,他照样会被叫)
 * 也不错认(把一段结论判成一个问题,会让一件办完的事永远停在「等你」)。
 */

import { speakable } from './waitingForYou.ts'

/**
 * 她在问他的那几种写法。**只认确凿的**:这几句话只有在"我列了几条等你拍板"的时候才写得出来。
 * 「你觉得怎么样」这种客套不在里面 —— 那句话后面通常已经有结论了。
 */
const ASK_MARKS: readonly { readonly word: string, readonly what: string }[] = [
  { word: '要确认的', what: '她列了几条要你确认' },
  { word: '确认点', what: '她列了几条要你确认' },
  { word: '需要确认', what: '她列了几条要你确认' },
  { word: '哪条不对', what: '她列了几条要你确认' },
  { word: '哪一条不对', what: '她列了几条要你确认' },
  { word: '都对我就开工', what: '她列了几条要你确认' },
  { word: '都对就开工', what: '她列了几条要你确认' },
  { word: '你说的是哪一条', what: '她没认出你说的是哪一条' },
  { word: '是哪一条', what: '她没认出你说的是哪一条' },
  { word: '是哪一家', what: '她没认出你说的是哪一家' },
  { word: '没认出', what: '她没认出你说的是哪一个' },
  { word: '你确认一下', what: '她要你确认一下' },
  { word: '请确认', what: '她要你确认一下' },
  { word: '要不要', what: '她在问你要不要' },
  { word: '你看行吗', what: '她在问你行不行' },
  { word: '行不行', what: '她在问你行不行' },
  { word: '可以吗', what: '她在问你行不行' },
  { word: '对吗', what: '她在问你对不对' },
]

/** 结尾那一句是问句吗(问号收尾;英文问号也算)。 */
function endsWithQuestion(text: string): boolean {
  const tail = text.trimEnd()
  return tail.endsWith('?') || tail.endsWith('?')
}

/** 她那段回答在问他吗。`what` 是卡面上那一句(**从事实拼,不经模型**)。 */
export function replyAsksHim(text: string | undefined): { what: string } | undefined {
  const said = (text ?? '').trim()
  if (said === '') return undefined
  for (const mark of ASK_MARKS) {
    if (said.includes(mark.word)) return { what: mark.what }
  }
  // 整段最后一句就是一个问号收尾的问句 —— 她把话停在了一个问题上。
  if (endsWithQuestion(said)) return { what: '她最后那一句是在问你' }
  return undefined
}

/** 卡面上那一句:她在等他回话。**不说「办完了」、不说「只是问了一句」**。 */
export function waitingOnHimNote(what: string): string {
  return `${what},在等你回话`
}

/* ─────────── 派出去的那条对话最后在问他(2026-09-28,卡 RC:一件事一条) ─────────── */

/**
 * 那段回答里**在问他的是哪一句**(给事项卡上那一行用的人话)。
 *
 * 取法:按句切开,从后往前找第一句"在问他"的(问号收尾,或命中 {@link ASK_MARKS});
 * 找到就把它洗成给人看的一句(`speakable`:去掉记号、网址,**路径换成可读的占位** —— 卡 RC 第三条:
 * 脱敏不许把句子挖空)。洗完没剩什么意思 → undefined,调用方退回 {@link waitingOnHimNote} 那句概括。
 */
export function askedQuestion(text: string | undefined, max = 48): string | undefined {
  const said = (text ?? '').trim()
  if (said === '') return undefined
  const sentences = said.split(/(?<=[。！？!?；;])|\n/).map(one => one.trim()).filter(one => one !== '')
  for (let i = sentences.length - 1; i >= 0; i -= 1) {
    const one = sentences[i] as string
    const asks = endsWithQuestion(one) || ASK_MARKS.some(mark => one.includes(mark.word))
    if (!asks) continue
    const clean = speakable(one, max)
    if (clean !== undefined) return clean
  }
  return undefined
}

/**
 * 事项卡上那一行:**这一件做完了,但最后有一件要他定**(卡 RC 的「一件事一条」)。
 *
 * 一条话说三件事:谁做的、做到哪儿了、要他定什么。要他定的那一句取自那家自己的话(`askedQuestion`),
 * 取不出来就退回「…,在等你回话」那句概括 —— **不编一个问题**。
 */
export function askedItemNote(input: { who: string, what: string, text?: string }): string {
  const question = askedQuestion(input.text)
  if (question === undefined) return waitingOnHimNote(input.what)
  return `${input.who} 做完了,但要你定一件事:${question}`
}
