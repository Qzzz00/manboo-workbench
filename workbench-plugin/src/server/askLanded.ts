/**
 * **替她答完,到底办成了没有 —— 看结果,不看回执**(2026-10-13 下午,卡 C;
 * 傍晚卡 J 补了判漏的两处,交接 `docs/交接-1013-替她答判漏与可灵提示词.md`)。
 *
 * ## 为什么要这一层(14:17 真机那一通)
 *
 * ```
 * press_option · not_sent · 它窗口里没找到「咖啡」这一项
 * answer_send  · sent     · 已尝试发送,但回执尚未确认
 * /asks/voice → confirmed:false
 * 她说:我替你点了咖啡,没看到它选上,你在电脑上的豆包办公里点一下。
 * ```
 *
 * —— 而**电脑上的豆包已经收到并回了**。普通包工作模式下「点选项」从来没点上过,真正办成的
 * 一直是打字那一送;而打字那一送**壳的三档一档都成立不了**:
 * 框里读回来是占位符(①)、写之前框里不是同一段字(②)、
 * 「咖啡」**送之前就在屏上当选项**(③ 只认「送之前没有、送之后出现」)。
 *
 * ## 这个文件的判据(两条,成立一条就算办成)
 *
 * ① **新冒出来的行**:送之前那几行与送完那几行**按集合差**比(不按条数)——
 *    新冒出来的行里提到那个答案(她自己那句气泡),或者是它回的「收到…」,就是真送进去了。
 *    **16:33 那一通按条数判漏了**:答完面板一收,面板上「咖啡」那一行跟着没了,
 *    提到答案的行**反而变少**,按「多没多出来」永远不成立;
 * ② **那个提问面板整块没了**:送之前面板那几行(选项 + 它那一句原话)画在屏上、送完一行都不剩 ——
 *    那一问就是答掉了(它那句回话常要 2–5 秒才冒出来,面板却是当场收的)。
 *    **答案那一项本身不作凭据**:她点的那一项多半原样成了对话里的一个气泡,照旧画着。
 *
 * 两头有一头读不到就**如实说不知道**(`landed:false` + 一句为什么):
 * 宁可说「你看一眼」,也不替它说「选上了」。
 *
 * 纯的:一行 I/O 都没有。读窗那一下由调用方拿**现成的只读壳 op**(`agent_read`)去做,
 * **一秒一拍地轮询**也在调用方(`sessionJobs.landedInWindow`),分寸是下面那三个常量。
 */

/** 并掉空白与常见标点,好比两行说的是不是同一句(同 `butlerAsks.normSaid` 的分寸,各管一处)。 */
export function flatLine(text: string): string {
  return (text ?? '').replace(/[\s,。,.!！??、::;;「」『』“”"'()()[\]【】\-—…·]/gu, '')
}

/** 这一行提到她那个答案了吗(并过空白与标点之后包含它)。 */
export function mentionsAnswer(line: string, answer: string): boolean {
  const needle = flatLine(answer)
  return needle !== '' && flatLine(line).includes(needle)
}

export interface AskLandedInput {
  /** 送之前那一刻主对话区那几行。**缺席 = 没量到底子**(那就判不出哪一行是新的)。 */
  before?: readonly string[]
  /** 送完再读一次那几行。**缺席 = 这一下读不到**。 */
  after?: readonly string[]
  /** 替她答进去的那几个字。 */
  answer: string
  /**
   * 送之前那个提问面板在窗口里画着的那几行(选项原字 + 它那一句原话,`askPanelMarksOf` 那一份)。
   * 缺席 = 不认面板这一条,只按新冒出来的行判(行为与卡 C 那一版一样)。
   */
  panel?: readonly string[]
}

export interface AskLandedVerdict {
  /** 真送进去了(窗口里冒出了新行,或者那个提问面板整块没了)。 */
  landed: boolean
  /** 凭哪一条判的:`new_line` 新冒出来的行 / `panel_gone` 面板没了。`landed` 为假时缺席。 */
  by?: 'new_line' | 'panel_gone'
  /** 新冒出来、算得上凭据的那几行(日志与那句话用;最多三行)。 */
  lines: readonly string[]
  /** 送之前提到答案的有几行。 */
  before: number
  /** 送完提到答案的有几行。 */
  after: number
  /** 凭什么这么判的(日志那一行;`landed` 为假时就是「为什么不敢说办成了」)。 */
  why: string
}

/** 回几行给日志 / 那句话看(多了没意义)。 */
export const ASK_LANDED_LINES_MAX = 3

/**
 * 面板那几行至少看见过这么多行,才敢把「它们没了」当凭据:
 * 一行走丢可能是滚动或者读数抖了一下,**整块没了**才是答掉了。
 */
export const ASK_LANDED_PANEL_MIN = 2

/** 它回的那一句常以这两个字开头(「收到:咖啡」)—— 认不出答案原字时这一句就是凭据。 */
export const ASK_LANDED_ECHO_PREFIX = '收到'

/** 送完每隔这么久读一拍(豆包那句回话 2–5 秒才冒出来,送完立刻读一次什么都看不到)。 */
export const ASK_LANDED_POLL_MS = 1000

/** 最多读这么多拍。 */
export const ASK_LANDED_POLL_TRIES = 6

/** 轮询总共不超过这么久(电话里她在听着,等太久比说「你看一眼」更糟)。 */
export const ASK_LANDED_POLL_BUDGET_MS = 6000

/** 送完比送之前多出来的那几行(按多重集合差:同一句出现两遍也算多了一条)。 */
function freshLines(before: readonly string[], after: readonly string[]): readonly string[] {
  const left = new Map<string, number>()
  for (const one of before) {
    const key = flatLine(one)
    left.set(key, (left.get(key) ?? 0) + 1)
  }
  const fresh: string[] = []
  for (const one of after) {
    const key = flatLine(one)
    const n = left.get(key) ?? 0
    if (n > 0) left.set(key, n - 1)
    else fresh.push(one)
  }
  return fresh
}

/** 这几行里有没有一行就是这一截记号(整行相等 —— 面板上那一项是单独一行)。 */
function hasRow(lines: readonly string[], mark: string): boolean {
  const key = flatLine(mark)
  return key !== '' && lines.some(one => flatLine(one) === key)
}

export function askLanded(input: AskLandedInput): AskLandedVerdict {
  const answer = (input.answer ?? '').trim()
  const no = (why: string): AskLandedVerdict => ({ landed: false, lines: [], before: 0, after: 0, why })
  if (flatLine(answer) === '') return no('答进去的那几个字是空的,没法认')
  if (input.before === undefined) return no('送之前没量到窗口里那几行,判不出哪一行是新冒出来的')
  if (input.after === undefined) return no('送完那一下读不到它的窗口')
  const before = input.before
  const after = input.after
  const was = before.filter(one => mentionsAnswer(one, answer)).length
  const now = after.filter(one => mentionsAnswer(one, answer)).length
  /**
   * ① 新冒出来的行里算凭据的那几条:提到那个答案的(她自己那句气泡、它回的「收到:咖啡」),
   * 或者**以「收到」开头**的(它把答案换了个说法写回来,比如「收到:第三个」)。
   */
  const told = freshLines(before, after)
    .filter(one => mentionsAnswer(one, answer) || flatLine(one).startsWith(ASK_LANDED_ECHO_PREFIX))
  if (told.length > 0) {
    return {
      landed: true,
      by: 'new_line',
      lines: told.slice(0, ASK_LANDED_LINES_MAX),
      before: was,
      after: now,
      why: `它窗口里冒出了${told.length}行新的字(「${told[0] as string}」)`,
    }
  }
  /**
   * ② 面板那几行**答案那一项除外**:她点的那一项照旧画在屏上(成了对话里的气泡),
   * 拿它判「面板还在不在」一定判错。
   */
  const marks = (input.panel ?? []).filter(one => !mentionsAnswer(one, answer))
  const shown = marks.filter(one => hasRow(before, one))
  const measured = shown.length >= ASK_LANDED_PANEL_MIN
  if (measured && !shown.some(one => hasRow(after, one))) {
    return {
      landed: true,
      by: 'panel_gone',
      lines: [],
      before: was,
      after: now,
      why: `它窗口上那个提问面板没了(送之前还摆着「${shown.slice(0, ASK_LANDED_LINES_MAX).join('」「')}」)—— 那一问答掉了`,
    }
  }
  return {
    landed: false,
    lines: [],
    before: was,
    after: now,
    why: `它窗口里提到「${answer}」的字没多出来(送之前 ${was} 行,送完 ${now} 行)${measured ? ',那个提问面板也还摆在屏上' : ''}`,
  }
}
