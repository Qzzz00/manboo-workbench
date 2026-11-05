/**
 * **会话那几条路的纯判断与回包形状**(2026-09-25 卡 T 起;2026-10-02 卡「引擎接线与删复制品」瘦成这一份)。
 *
 * ## 这个文件现在只剩两样:纯判断函数 + 类型
 *
 * 到 10-02 为止这里还住着「替她答 / 捎话 / 点选项 / 写面板 / 看按权限弹框 / 停止」六只手:
 * 每一只自己叫台前、自己开深链、自己打字、自己读窗核实、自己接开窗重试、自己翻回包。
 * 那正是维护者 10-02 说的那件事:「嘴上说着不打补丁,结果全是打补丁」——
 * 同一件事(往别家 AI 的窗口里送一句话)在四个文件的八处各写一遍,每撞一次真机就在**那一条**上加一层。
 *
 * 现在那八处是**一个** `engine/adapters/window.ts`,上面是**一条** `engine/engine.ts`
 * (过闸、落账、重试、换路、三档证据),会话那几条路的接线在 `sessionJobs.ts`。
 * 对照表:`docs/交接-1002-窗口适配器.md` 第二节(原来在哪 → 现在在哪)。
 *
 * 剩在这里的只有:
 *
 * | 留下的 | 是什么 |
 * |---|---|
 * | {@link answerPlanOf} | 这条会话答了往哪送、「去回答」能不能把它调到前面(纯判断) |
 * | {@link answerMarkerOf} / {@link pickMarkerOf} / {@link relayMarkersOf} / {@link askPanelMarksOf} | 在窗口里认那段对话 / 那个面板用哪几截原话(纯判断) |
 * | {@link SessionAnswerService} 与那几种结果类型 | 回包形状(手机 / 电话工人 / 展示台认的就是它们,一个字没改) |
 *
 * 纪律没变:**认不出那段对话也照发**(卡 AW),送完按证据核;核不上如实说
 * 「可能发到了别的对话」,**不说成答上了,也不当没送**。她答的原话只送进那家那段对话,不落盘、不进 /state。
 */
import type { SessionAskView, SessionView } from '../protocol.ts'
import { bindingFor, bundleForEntry } from './agentSources.ts'
import type { ApprovalKey } from './approvalKeys.ts'
import type { JobVia } from './engine/adapter.ts'
import { windowDeepLink } from './engine/adapters/window/families.ts'
import type { RelaySessionView } from './sessionRelay.ts'

export type AnswerRoute = NonNullable<SessionAskView['reply']>

/** Claude 桌面 App 开的会话(Code 标签):entrypoint 是这几种。 */
const CLAUDE_DESKTOP_ENTRIES = new Set(['claude-desktop', 'claude-desktop-3p', 'local-agent'])
/** Codex 桌面 App 开的会话:source 是这两种。 */
const CODEX_DESKTOP_SOURCES = new Set(['vscode', 'appServer'])
/** 只有协议那只手够得着(见 {@link answerViasOf})。 */
const PROTOCOL_ONLY: readonly JobVia[] = ['protocol']

export interface AnswerPlan {
  route: AnswerRoute
  /** 窗口那条路找哪个 App。 */
  bundleId?: string
  /** 「去回答」开的深链(能开到那一段对话的才有)。 */
  deepLink?: string
  /** 送不回去时那句人话(「这一问得在电脑上的 Claude 里回答」)。 */
  why?: string
  /** 「去回答」能不能把那段对话 / 那个 App 调到前面(终端里开的、VS Code 里的调不了 —— 那颗键就不摆)。 */
  revealable: boolean
  /** 这条会话只许走这几条通道(见 {@link answerViasOf});缺席 = 不限。 */
  vias?: readonly JobVia[]
}

/**
 * ★ **这条会话只有哪几只手够得着**(2026-10-20,卡 D;**纯函数**,缺席 = 不限)。
 *
 * 终端 / VS Code 里开的 Claude 会话、终端里开的 Codex 会话:**只有协议那只手**(socket / `thread/resume`)。
 * 窗口那只手开的是桌面 App,认不出那段对话也照发(卡 AW)—— 让它接手就是把她的话打进 App 里别的对话。
 * 探针 13e2bf20(`docs/交接-1019-claude捎话探针.md`)量过终端会话登记表里一样有 socket、收得到、照样回话;
 * Codex 终端会话与 App 线程同一份 rollout、同一把写锁(`docs/交接-1019-codex续线程探针.md`),
 * 它开着时撞锁 → 协议说「此刻做不了」→ 没有下一只手 → 照 deskWhy 说话。
 *
 * Codex `exec`(派活起的那条)不在这里:App 用深链 `codex://threads/<id>` 开得到它,窗口那只手是一条真退路。
 */
export function answerViasOf(agent: string, entry: string | undefined): readonly JobVia[] | undefined {
  if (entry === undefined) return undefined
  if (agent === 'claude' && !CLAUDE_DESKTOP_ENTRIES.has(entry)) return PROTOCOL_ONLY
  if (agent === 'codex' && entry !== 'exec' && !CODEX_DESKTOP_SOURCES.has(entry)) return PROTOCOL_ONLY
  return undefined
}

/**
 * 这条会话答了往哪送(**纯函数**)。`hands.window` = 这一家此刻送得进话没有
 * (2026-10-02 起只有一处答案:`registry.knownCaps(family).send`,适配器现查)。
 *
 * 认不出从哪开的(entry 缺席)按桌面 App 算:三家的会话绝大多数是桌面 App 开的,
 * 而「认不出那段对话也照发、送完按证据核」(卡 AW)之后,认错了也不会把话送到她没想到的地方不吭声。
 *
 * ★ 2026-10-02 两处改法:
 * - **包与深链不再写死在这个文件里**:包问家族目录(`agentSources`),深链问窗口型那张差异表
 *   (`engine/adapters/window/families.ts` 的 `windowDeepLink`)—— 原来这里有一份 `WINDOW_APPS`
 *   (claude / codex / kimi 三家),那是「四份家→包表」里的一份,删掉了;
 * - **命令行那条路删了**:`codex exec resume` 那只手从来没接进生产(`index.ts` 一次都没传 `cli`),
 *   留着只会让这张表看起来有一条不存在的路。Codex 命令行起的那种会话照旧「去电脑上的 Codex 里答」+ 深链。
 *
 * ★ 2026-10-03(卡「接缝清理」第 3 条):`hands` 里那一格 `cli?` 也删了 ——
 * 三个调用方一律传 `cli: false`,函数体里**一次都没读过它**(那只手删掉之后剩下的壳)。
 */
export function answerPlanOf(
  agent: string,
  sessionId: string,
  entry: string | undefined,
  hands: { window: boolean },
  hostId?: string,
  /**
   * 送不进去时那句人话的口气。`ask` = 那条会话在等她答(卡 T 的原话,一个字没动);
   * `relay` = 她要往那条会话里**捎一句话**(不是回答某一问)。路由、深链、能不能调到前面三样**完全一样**,
   * 只有这一句话不同 —— 「这句话得你到电脑上的 Claude 里自己说」。
   */
  kind: 'ask' | 'relay' = 'ask',
): AnswerPlan {
  const binding = bindingFor(agent)
  const bundleId = binding?.bundle_id
  const name = binding?.name
  // 英文名后面空一格:「这一问得在电脑上的 Claude 里回答」。
  const desk = (where: string, revealable: boolean): AnswerPlan => ({
    route: 'desk',
    why: kind === 'relay'
      ? `这句话得你到${where}${/[A-Za-z0-9]$/.test(where) ? ' ' : ''}里自己说`
      : `这一问得在${where}${/[A-Za-z0-9]$/.test(where) ? ' ' : ''}里回答`,
    revealable,
  })
  const link = windowDeepLink(agent, { sessionId, ...(hostId === undefined ? {} : { hostId }) })
  const withLink = link === undefined ? {} : { deepLink: link }
  /*
   * ★ 2026-10-20(卡 D):终端 / VS Code 里开的会话**不再按 entry 先拒** —— 与桌面 App 开的走同一支
   * (`hands.window ? window : desk`)。entry 只定两样:「去回答」能不能调到前面(调不到那个终端,不摆那颗键、不给深链)
   * 与只许哪只手({@link answerViasOf},窗口那只手不接)。送不送得进去由引擎现查。
   */
  const vias = answerViasOf(agent, entry)
  if (vias !== undefined) {
    const where = agent === 'codex'
      ? '电脑上开着 Codex 的那个终端窗口'
      : entry === 'claude-vscode' ? '电脑上 VS Code 里的 Claude' : '电脑上开着 Claude 的那个终端窗口'
    return hands.window ? { route: 'window', revealable: false, vias } : { ...desk(where, false), vias }
  }
  if (agent === 'claude') {
    return hands.window
      ? { route: 'window', bundleId: bundleId as string, ...withLink, revealable: true }
      : { ...desk('电脑上的 Claude', true), ...withLink }
  }
  if (agent === 'codex') {
    /*
     * 派活起的 exec 按 App 线程办(卡 D;探针 55b38005:同一份 rollout、同一把写锁,`thread/resume` 960 ms 续上)。
     * App 握着那条线程时协议回 `CODEX_THREAD_TAKEN_WHY`,引擎照既有规矩换窗口那只手(深链开到那一段)。
     */
    return hands.window
      ? { route: 'window', bundleId: bundleId as string, ...withLink, revealable: true }
      : { ...desk('电脑上的 Codex', true), ...withLink }
  }
  const known = bundleId ?? (agent.includes('.') ? bundleForEntry(agent) : undefined)
  if (known !== undefined) {
    return hands.window
      ? { route: 'window', bundleId: known, ...withLink, revealable: true }
      : desk(`电脑上的 ${name ?? agent}`, true)
  }
  return desk('电脑上那个 App', false)
}

/**
 * 在窗口里认那段对话的记号:那一问的原话里挑一截(去掉 `**` 这类记号 —— 窗口里画出来的字没有它们;
 * 截在第一个换行 / 记号前,最多 20 个字)。太短(不到 6 个字)认不准,不用。
 */
export function answerMarkerOf(quote: string | undefined): string | undefined {
  if (quote === undefined) return undefined
  const plain = quote.replace(/\*\*|__|`/g, '').split('\n')[0]!.trim()
  const chars = Array.from(plain)
  if (chars.length < 6) return undefined
  return chars.slice(0, 20).join('')
}

/**
 * **点完那条对话之后,拿哪一截字认回它**(2026-09-28,卡 WR)。
 *
 * 与 {@link answerMarkerOf} 的差别只有一条:**不要 6 个字那道门**。那道门是给
 * 「没切过去、只凭一截字在窗里碰运气」立的;这里是我们**亲手把那一条点到了前面**,
 * 再读一次只为确认「点着了没有」—— 两个字的对话名(「周报」)照样认得回来。
 * 最多取 20 个字(同上),空的不算。
 */
export function pickMarkerOf(title: string): string | undefined {
  const plain = title.replace(/\*\*|__|`/g, '').split('\n')[0]!.trim()
  const chars = Array.from(plain)
  if (chars.length < 2) return undefined
  return chars.slice(0, 20).join('')
}

/**
 * 这一问的来路:弹窗还是按内容判的;是不是子任务的。
 * `kind` / `since` / `quote`(2026-10-01,卡 AP):权限弹窗那一问要据此挂 `permission`、认得出读过的那几颗键还算不算数。
 */
export type AskOrigin = Pick<NonNullable<SessionView['ask']>, 'by' | 'child'> & Partial<Pick<NonNullable<SessionView['ask']>, 'kind' | 'since' | 'quote'>>

/**
 * 捎话时**在窗口里认那段对话**用哪几截字,按可靠度排序(2026-09-26,卡 BR):
 *
 * 1. 调用方给的那几截(`markersOf` —— 那条会话最后几行的**原文**,最靠得住:一定画在对话区末尾);
 * 2. 它刚说的那一句(`ask.quote`,那条会话正在等她时才有);
 * 3. 会话标题(在不在辅助功能树里每家不一样 —— 最后才试)。
 *
 * 每一截都过 {@link answerMarkerOf} 那道门(太短的认不准,不用),去重,最多三截。
 */
export function relayMarkersOf(
  /** 只看这两格(`title` 允许显式 undefined:安全门那一处要问「除了标题还有别的吗」)。 */
  view: { ask?: SessionView['ask'], title?: string | undefined },
  extra?: readonly string[],
): readonly string[] {
  const out: string[] = []
  for (const raw of [...(extra ?? []), view.ask?.quote, view.title]) {
    const marker = answerMarkerOf(raw ?? undefined)
    if (marker !== undefined && !out.includes(marker)) out.push(marker)
  }
  return out.slice(0, 3)
}

/**
 * **认那个提问面板用哪几截原话**(2026-09-28,卡 AT)。壳靠它们找「含问句 / 选项的那个容器」——
 * 找不着就一处不动,所以这几截给全:它明写的每个选项 + 它那一句原话(`quote`,窗口里逐字画着的)
 * + 洗过的那句问题(洗过的多半对不上,对上了算白得一截)。
 *
 * 去重、去空,最多 8 截(壳那一侧每截字都要在几千个节点上比一遍)。
 */
export function askPanelMarksOf(ask: SessionView['ask']): readonly string[] {
  if (ask === undefined) return []
  const out: string[] = []
  for (const raw of [...(ask.options ?? []).map(one => one.label), ask.quote, ask.question]) {
    const mark = raw?.trim()
    if (mark === undefined || mark === '' || out.includes(mark)) continue
    out.push(mark)
  }
  return out.slice(0, 8)
}

// ───────────────────────────── 回包形状(只有类型) ─────────────────────────────

/**
 * 替她点那个框上一项的结果(2026-09-28,卡 WQ)。
 * `confirmed` = 点完重读一次、那一问真的没了。**`confirmed:false` 不许说成答上了**。
 */
export type PressResult =
  /** `approved`(卡 AP)= 按的是权限弹窗上的那一颗:批准这一次 / 拒绝(回包那句话据此说)。 */
  | { ok: true, label: string, confirmed: boolean, note?: string, approved?: 'once' | 'deny' }
  | { ok: false, status: 400 | 404 | 409, error: string }
  | { ok: false, status: 200, where: 'desk', why: string, reveal: boolean }

/**
 * 把她自己那句话写进那个提问面板的结果(2026-09-28,卡 AT)。与 {@link PressResult} 同形,
 * 只是回的是**她那句原文**:`confirmed` = 核实过两条(那个面板没了 + 窗口里出现了她那句)。
 * **`confirmed:false` 不许说成答上了。**
 */
export type WriteAskResult =
  | { ok: true, text: string, confirmed: boolean, note?: string }
  | { ok: false, status: 400 | 404 | 409, error: string }
  | { ok: false, status: 200, where: 'desk', why: string, reveal: boolean }

export type AnswerResult =
  /**
   * 送进去了。`confirmed` = 核实过没有:弹框那一问替她写进面板那一路看窗口(卡 AT),
   * 打字送回会话那一路看**窗口里出现了没有 / 那条会话的记录文件里多没多出她那句**(卡 AW)。
   * **`confirmed:false` 不许说成答上了。**
   */
  // ★ 2026-10-03:这一格从前是 `'window' | 'cli'` 写在这儿 —— 同一个产不出来的 `'cli'`,
  // 改成与捎话同一份 {@link RelayRoute}(今天只有 `window`)。回包形状一个字没改。
  | { ok: true, route: RelayRoute, confirmed?: boolean, note?: string }
  | { ok: false, status: 400 | 404 | 409, error: string }
  /**
   * 送不回去:明说,电脑上给「去回答」。`permission`(卡 AP)= 撞上的是**权限弹窗**:
   * 打字批不了它,界面据此收起输入框、切到「批准 / 拒绝」那几颗键。
   */
  | { ok: false, status: 200, where: 'desk', why: string, reveal: boolean, permission?: true }

/**
 * 读那个批准弹窗上有哪几颗键的结果(2026-10-01,卡 AP)。`keys` 只有「批准一次 / 拒绝」;
 * `held` = 认出来、但不替她按的放宽那几颗(本次会话都允许……)。
 */
export type ApprovalReadResult =
  | { ok: true, keys: readonly ApprovalKey[], held: readonly string[] }
  | { ok: false, status: 404 | 409, error: string }
  | { ok: false, status: 200, where: 'desk', why: string, reveal: boolean }

/**
 * 这一句是走哪条路送进去的。
 *
 * ★ 2026-10-03(卡「接缝清理」第 3 条;决策记录「2026-10-03 早」⑦):**`'cli'` 删了**。
 * `codex exec resume` 那只手从来没接进生产(`index.ts` 一次都没传 `cli`),2026-10-02 整只删掉之后
 * 这个值**没有任何产出点**,于是 `http.ts` 里那道「命令行那一路不登记回电」的门恒为真、写不出用例走它
 * (交接 1002 第六节 ⑥)。留一个产不出来的值,门就只能一直是死代码。
 *
 * 保住的纪律没变:**没有那条路,就不会为它登记回电**。改成由
 * {@link RELAY_ROUTES} 钉着 —— 哪天真接上第二条路(命令行 / 接口),加进这张表时那条用例会红,
 * 到那时必须明说这一条登不登记回电。回包形状一个字没改(`route` 那一格照旧有,值只有 `window`)。
 */
export type RelayRoute = 'window'

/**
 * **今天真产得出来的那几种路**(断言照这张表,不逐字写 `'window'`)。
 *
 * 唯一的产出点是 `sessionJobs.relay`(窗口那一条)。加一种路要同时:
 * ① 加进 {@link RelayRoute};② 加进这张表;③ 回答 `/sessions/relay` 里「这一路登不登记回电」。
 */
export const RELAY_ROUTES: readonly RelayRoute[] = ['window']

/**
 * 捎话的结果(2026-09-26,卡 BR)。与 {@link AnswerResult} 的差别只有两处:
 * **没有 409**(捎话不要求那条会话此刻在等她),送成了带回那个记号(读回话时要用它)。
 */
export type RelayResult =
  | {
    ok: true
    route: RelayRoute
    mark: string
    /** 真送进去的那个包(一台机器装两个同名 App 时,读回话只能按它读)。 */
    bundle_id?: string
    /** 它正在跑、这句话是**排进去**的(它跑完自己会看到)。 */
    queued?: true
    /** 送之前**替她按了那家的停止键**、而且真停下了(「打断再发」)。 */
    interrupted?: true
    /**
     * **这一下替她做的、必须当场说一句的事**(今天只有两种:替她按掉了她窗口上那层框,卡 DP;
     * 以及 2026-10-23 卡「捎话留言等它醒」的**留言排上队** —— 那条会话没开着,这一句留着了)。
     * 2026-10-02 补上(审计第二表第 5 条):从前只有派活那一处说,捎话压根不读壳那一格。
     */
    note?: string
    /** 送进去的是它的哪一轮(协议型对端报的;2026-10-03)。登记回电带上,巡检只认这一轮。 */
    turn_id?: string
    /**
     * ★ **这一句没送进那条会话,留言排上队等它醒**(2026-10-23,卡「捎话到没开着的会话留言等它醒」)。
     * `note` 就是那句完整的话(「那条会话没开着,这句我留着,它一开就送进去」)—— 上一层照它说,
     * **不套「捎到了 / 送进了」的框、不登记回电**(醒来重送那一下才补,见 `index.ts` 的 drain.after)。
     */
    sessionClosed?: true
  }
  | { ok: false, status: 400 | 404, error: string }
  /**
   * 捎不进去:三种(这一家没有一条送得进话的通道 / 那家的窗口没开 / 认不出是哪一段对话),`why` 里说清是哪一种。
   *
   * **`unconfirmed` 那一档不是「没送到」**(2026-09-30 止血 ③):按了发送、当场没核上 ——
   * 它多半已经收到了。上一层照新开会话那条路办:登记回电、回 ok、说清「没看见它收下,先别重发」。
   * 带上 `mark` / `bundle_id` 是为了登记那一条能读回话。
   */
  | {
    ok: false
    status: 200
    where: 'desk'
    why: string
    reveal: boolean
    unconfirmed?: true
    route?: RelayRoute
    mark?: string
    bundle_id?: string
    turn_id?: string
  }

/**
 * 「这条会话现在能不能捎话」(2026-09-27,卡 PS)。手机点开某家在跑的那条会话,卡片下面要不要摆输入框看它:
 * 送不进去的会话**不摆**(摆了就是摆设),换一行 `why` 说清为什么。`why` 与真捎话回的那一句同一个出处。
 */
export type RelayReady =
  | {
    can: true
    /** 它此刻在跑没(手机卡片据此摆不摆「打断并发送」那颗次级键)。 */
    running?: boolean
    /** 能不能替她打断(在跑、而且这一路按得到停止键)。不能就带一句人话,界面照它说,不摆那颗键。 */
    interrupt?: { can: boolean, why?: string }
  }
  | { can: false, why: string, reveal?: boolean }

export interface SessionAnswerService {
  /**
   * 这条会话答了往哪送(给 `SessionAskView.reply` / `where` / `reveal`)。`ask` 是这一问的来路:
   * 弹窗(`by: 'form'`)和子任务的那一问打字送不进去(得在那家里点),一律到电脑上回答。
   */
  replyOf: (view: SessionView, ask?: AskOrigin) => {
    reply: AnswerRoute
    where?: string
    reveal?: true
    press?: true
    write?: true
    /** 权限弹窗那一问(卡 AP):不摆输入框;读得了 / 读到的那几颗键 / 上次没读成的那句话。 */
    permission?: NonNullable<SessionView['ask']>['permission']
  }
  answer: (agent: string, sessionId: string, text: string) => Promise<AnswerResult>
  /**
   * **替她点那家弹的框上的一项**(2026-09-28,卡 WQ)。`label` 必须是那一问**原样**的某个选项
   * (不是就 400:绝不替她挑、也不模糊匹配)。
   */
  press: (agent: string, sessionId: string, label: string) => Promise<PressResult>
  /** **替她把她自己那句话写进那家提问面板的自由作答框**(2026-09-28,卡 AT)。她那句**原文一字不改**。 */
  writeAsk: (agent: string, sessionId: string, text: string) => Promise<WriteAskResult>
  /**
   * **往那条会话里捎一句话**(2026-09-26,卡 BR):她点名的任何一条会话,不要求它此刻在等她。
   * **她的原话一个字不改**(前面只加一个 `【事务官捎话 xxxxxx】` 记号)。
   */
  relay: (agent: string, sessionId: string, text: string, opts?: {
    /** **先打断它再说这句话**。缺省 false = 「补一句」。两处入口都要她明着要。 */
    interrupt?: boolean
    /** 她明说了「盖掉」。缺省 false:框里有她的字先存草稿。 */
    overwrite?: boolean
    /**
     * ★ **她勾了「回了打电话给我」**(2026-10-04,卡 `claude/relay-call-optin`)。缺省 false = 不回电。
     * 这一层只把它挂上这件活({@link Job.callOnReply}),好让锁屏排队重送那一路也登记得对;
     * 真「响不响」在轻账与座机台账上(`relayWatch.ts`)。
     */
    callOnReply?: boolean
  }) => Promise<RelayResult>
  /** **现在能不能往这条会话里捎话**(2026-09-27,卡 PS)。与 {@link relay} 走同一道门,**一只手都不碰**。 */
  relayReady: (agent: string, sessionId: string) => RelayReady
  /** **读那家权限弹窗上有哪几颗键**(2026-10-01,卡 AP)。认不准 / 读不到如实说,一颗键都不给。 */
  approvalRead: (agent: string, sessionId: string) => Promise<ApprovalReadResult>
  /** 「去回答」:把那段对话调到前面(深链开到那一段;开不了就把那一家叫到前面)。 */
  reveal: (agent: string, sessionId: string) => Promise<{ ok: boolean, how: 'link' | 'app' | 'none', why?: string }>
  /** 「不用管这条」:判错了、或者她知道了不想回。弹窗那种点不掉(那家真停着,只能去那家里答)。 */
  dismiss: (agent: string, sessionId: string) => Promise<{ ok: true } | { ok: false, status: 404 | 409, error: string }>
}

export type { RelaySessionView }
