/**
 * 「她要跟你聊的那一条资讯」——— 电话那一侧怎么知道(2026-10-13,卡「播客页重做」★3)。
 *
 * 维护者原话:「我点击之后,可以打断正在播放的播客,我可以与事务官针对这条信息进行深入挖掘和
 * 交流,文字和语音两种选项,语音可以是按住说话的那种,**也可以是通话**」。
 *
 * 文字与按住说话走的是 `POST /feed/dig`(8791 这边答),通话走的是现成那条应用内通话 ——
 * 而电话里接话的是**电话工人**,它不读 `/feed`,所以要有个地方告诉它「这一通是为哪条资讯打的」。
 *
 * **接哪条缝**:工人每通电话现取一次人设(`GET /channel/persona` → `refreshSelfBrief`),
 * 所以这一格只要进那份人设,**工人一行都不用改**(不碰房间协议、不碰工人的契约)。
 * 她点「打电话聊」时手机先打一下 `POST /feed/dig/call`,这里记住;下一通电话的人设里
 * 多一段「她要跟你聊的那一条」。
 *
 * **为什么带过期**:记住了却没打电话(她改成打字了、按错了),这一格留着的话下一通
 * **不相干的电话**会凭空多出一段「她要聊某条资讯」—— 那比没有更坏。过了
 * {@link FEED_DIG_TTL_MS} 就当没有;一通电话取过之后也当场清掉(一次只管这一通)。
 *
 * 只在内存里:它描述的是「这十分钟之内她想干什么」,重启之后这件事已经不成立了。
 */

/** 记住多久。十分钟 —— 与 `casualAsk.ts` 的「他还在这件事上」取同一个数,不另立一个。 */
export const FEED_DIG_TTL_MS = 10 * 60 * 1000

/** 人设里那一段的段名(日志与用例认它,电话里从来不念段名)。 */
export const FEED_DIG_SECTION = '她要跟你聊的那一条资讯'

export interface FeedDigSubject {
  title: string
  url: string
  source?: string
  why?: string
  project_name?: string
  /** 她在手机上已经就这条聊过的几句(打字 / 按住说话那几轮),让电话接着聊,不从头问一遍。 */
  said?: readonly string[]
}

export interface FeedDigContext {
  /** 她点了「打电话聊」:记住这一条。 */
  set(subject: FeedDigSubject): void
  /** 这会儿还有没有(过期 / 取过了就没有)。 */
  peek(): FeedDigSubject | undefined
  /** 忘掉(她挂了、或者换成打字聊)。 */
  clear(): void
  /**
   * 人设里那一段。没有 / 过期就 `undefined`(整段不出现)。
   * **取一次就清掉**:这一格管的是接下来那一通,不是从此以后每一通。
   */
  takeBlock(): string | undefined
}

export function createFeedDigContext(opts: { now?: () => number } = {}): FeedDigContext {
  const now = opts.now ?? (() => Date.now())
  let subject: FeedDigSubject | undefined
  let at = 0

  const live = (): FeedDigSubject | undefined => {
    if (subject === undefined) return undefined
    if (now() - at > FEED_DIG_TTL_MS) { subject = undefined; return undefined }
    return subject
  }

  return {
    set(next) { subject = next; at = now() },
    peek: live,
    clear() { subject = undefined; at = 0 },
    takeBlock() {
      const one = live()
      if (one === undefined) return undefined
      subject = undefined
      const said = (one.said ?? []).filter(text => text.trim() !== '')
      return [
        '',
        `【${FEED_DIG_SECTION}】`,
        '- 这一通电话是她在资讯页上点「打电话聊」打过来的:她要跟你聊**这一条**,别从「有什么吩咐」重新问一遍。',
        `- 标题:《${one.title}》`,
        ...(one.source === undefined || one.source === '' ? [] : [`- 来源:${one.source}`]),
        ...(one.project_name === undefined || one.project_name === '' ? [] : [`- 跟她哪个项目有关:${one.project_name}`]),
        ...(one.why === undefined || one.why === '' ? [] : [`- 你当初给她的那句「跟你有什么关系」:${one.why}`]),
        ...(said.length === 0 ? [] : ['- 她在手机上已经就这条说过:', ...said.map(text => `  · ${text.trim()}`)]),
        '- 开口就从这条说起(一句话说清这是什么、然后问她想往哪儿挖)。',
        '- 链接与 id 不要念出来 —— 用耳朵听不懂;资讯里没有的事实不要编。',
      ].join('\n')
    },
  }
}
