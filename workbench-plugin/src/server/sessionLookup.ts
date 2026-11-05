/**
 * 「X 在干什么 / 去看一眼 X」= **只读**(2026-09-27,卡 LK)。
 *
 * ## 撞出来的事
 *
 * 维护者 21:2x 打电话:「你告诉我现在 Codex 现在是什么状态?他正在跑那个参赛网页那个东西」。
 * 事务官答的是**看板上的旧事项**(「参赛网页架构收尾」,Codex 9/25 交回的那句话);
 * 他纠正「不是那个会话,他现在跑的是整理 Spotlight 参赛材料与网页」,事务官又去
 * **给 Codex 捎话**(`wb_relay_to_session`);他明说「不要给他发信息,就看一眼」,
 * 答回来的还是旧事项。他挂了电话。
 *
 * 两个病:
 * 1. 问「某一家现在什么状态」被当成了「问某件事的进度」(`wb_item_progress` 那条路,
 *    核的是看板上的事项);他问的是**那一家此刻正开着的那条对话**。
 * 2. 「看一眼」被当成了「去说一声」——**没让发就发了**。
 *
 * ## 这一层做什么
 *
 * 一件纯活:他那句点名的话 → `/state.sessions` 里**那一家此刻正在跑的那条对话**
 * → 一句能直接念的话:**在跑还是停了 · 最后一次动静是多久前 · 最后一句在干什么**。
 *
 * - 认人复用捎话那一套({@link matchRelaySession}):同一份账、同一套打分,
 *   两条路认出来的永远是同一条会话(不然「看一眼」和「捎话」会指到两条不同的对话上)。
 * - **只读**:一个字节都不送出去、不落盘。时长用 {@link agoSpokenLabel}(人话,不念「228 分钟」)。
 * - 「最后一句在干什么」用 `/state.sessions` 里已经有的 `activity` ——
 *   它本来就是会话记录尾巴读出来的那一句人话(`sessionDigest`),
 *   **不必再开一次会话原文**,所以这条路不碰 `read_session_content` 那道门。
 * - 读不到就说读不到(`SESSION_ACTIVITY_UNKNOWN`),不编一句。
 */
import type { SessionStatus, SessionView } from '../protocol.ts'
import { SESSION_ACTIVITY_UNKNOWN, agoSpokenLabel, sessionDisplayTitle } from '../protocol.ts'
import { matchRelaySession, pickFamily, type RelayCandidate, type RelayMatch, type RelaySessionView } from './sessionRelay.ts'
import type { SpokenFamily } from './spokenFamily.ts'

/** 一次认人得了多少分(认不出算负无穷:任何认出来的都比它准)。 */
function scoreOf(match: RelayMatch): number {
  if (match.kind === 'none') return Number.NEGATIVE_INFINITY
  return match.kind === 'one' ? match.target.score : (match.candidates[0]?.score ?? Number.NEGATIVE_INFINITY)
}

/** 这一刻是什么状态,念给他听的说法。**「在跑」与「停了」分得开**是他要的那一半答案。 */
const STATUS_SPOKEN: Readonly<Record<SessionStatus, string>> = {
  running: '还在跑',
  waiting: '停下来在等你',
  done: '这一轮说完了',
  error: '出错停了',
  offline: '那条对话已经结束了',
}

export type SessionLookup =
  /** 认出一条:`line` 直接念。 */
  | { kind: 'one', agent: string, session_id: string, title: string, status: SessionStatus, line: string }
  /** 几条都对得上:念候选让他选(同捎话,不猜)。 */
  | { kind: 'many', candidates: readonly RelayCandidate[], line: string }
  /** 一条都对不上。 */
  | { kind: 'none', line: string }

/**
 * 他那句「Codex 现在什么状态 / 去看一眼整理参赛材料那条」→ 一句能念的话。
 *
 * 排在前面的是**在跑的那条**(`preferRunning`,缺省开):他问「现在什么状态」问的总是
 * 此刻正开着的那一条,不是三天前做完的那条。同分时按「最近动过的」取一条。
 */
export function lookupSession(input: {
  sessions: readonly RelaySessionView[]
  /** 他点名那一句的原话。 */
  who: string
  agentName: (agent: string) => string
  /** 此刻(ISO)。 */
  now: string
  /** 关掉「先看在跑的那条」(默认开)。 */
  preferRunning?: boolean
  /**
   * 认家名用的候选表(2026-09-28,卡 FX):**先认家、再在这家里认对话**。
   * 只取本机真装的那几家(`spokenFamilies`)。不传就是这一版之前的行为。
   */
  families?: readonly SpokenFamily[] | undefined
}): SessionLookup {
  const prefer = input.preferRunning !== false
  /**
   * ★ **先认家**(2026-09-28,卡 FX)。真机上「Kimi」答了 claude 的一条、「minus」也答了
   * claude 的一条、「Manus」「豆包」答的是「没认出是哪一条(这会儿有 4 条)」——
   * 都是因为一池子会话一起打分:家名只值 15 分,输给了别家标题的碎片。
   *
   * 认出是某一家 → 只在这一家的会话里找;这一家**此刻没有在跑 / 在等的对话** →
   * 就照实说这一句(有过的话补一句最近那条叫什么、多久前),**绝不跨家挑一条**。
   */
  const picked = pickFamily({ sessions: input.sessions, who: input.who, agentName: input.agentName, families: input.families })
  const family = picked.family
  if (family !== undefined) {
    const mine = picked.pool
    const live = mine.filter(one => one.status === 'running' || one.status === 'waiting')
    if (live.length === 0) return { kind: 'none', line: noLiveLine(family.title, mine, input.agentName, input.now) }
    const match = matchInFamily({ ...input, live, mine, prefer })
    return fromMatch(match, input)
  }
  /**
   * **先只在「在跑 / 停着等你」这两种里认**(2026-09-27,卡 LK):他嘴里那个名字
   * 常常同时对上一条旧的做完了的会话(现场就是这样:旧事项「参赛网页架构收尾」)。
   * 这两种里一条都认不出来,再退回全部会话里认一次 —— 那时答「那条已经做完了」也是真话。
   */
  const live = input.sessions.filter(one => one.status === 'running' || one.status === 'waiting')
  return fromMatch(matchInFamily({ ...input, live, mine: input.sessions, prefer }), input)
}

/**
 * 在给定的两份池子里认(全池那一份 `mine`、在跑/等你那一份 `live`)。
 * 认出某一家时这两份都已经只剩这一家的会话 —— **跨家一条都进不来**。
 */
function matchInFamily(input: {
  who: string
  agentName: (agent: string) => string
  now: string
  families?: readonly SpokenFamily[] | undefined
  live: readonly RelaySessionView[]
  mine: readonly RelaySessionView[]
  prefer: boolean
}): RelayMatch {
  const inLive = input.prefer && input.live.length > 0
    ? matchRelaySession({ sessions: input.live, who: input.who, agentName: input.agentName, now: input.now, families: input.families })
    : undefined
  const inAll = matchRelaySession({ sessions: input.mine, who: input.who, agentName: input.agentName, now: input.now, families: input.families })
  /**
   * **认得更准的那一份作数**:他要是明明白白念了一条做完了的会话的标题
   * (「那条参赛网页架构收尾做完了没」),全池那一份的分会明显更高 —— 那就答那一条,
   * 「先看在跑的」这条偏好只在两边一样准的时候起作用(平手时答在跑的那条)。
   */
  return inLive !== undefined && inLive.kind !== 'none' && scoreOf(inAll) <= scoreOf(inLive) ? inLive : inAll
}

/** 认人的结果 → 念给他听的那一句。 */
function fromMatch(match: RelayMatch, input: { sessions: readonly RelaySessionView[], agentName: (agent: string) => string, now: string }): SessionLookup {
  if (match.kind === 'none') return { kind: 'none', line: match.line }
  if (match.kind === 'many') return { kind: 'many', candidates: match.candidates, line: match.line }

  const target = match.target
  const view = input.sessions.find(one => one.agent === target.agent && one.session_id === target.session_id)
  return {
    kind: 'one',
    agent: target.agent,
    session_id: target.session_id,
    title: target.title,
    status: target.status,
    line: lookupLine(view, input.agentName(target.agent), input.now),
  }
}

/**
 * 认出是这一家、但这一家**此刻没有在跑 / 在等的对话**时,念给他听的那一句
 * (2026-09-28,卡 FX)。
 *
 * 「Manus 这会儿没有在跑的对话。」—— 这就是全部答案;这一家有过别的会话(做完了 / 断了)
 * 就再补一句**最近那条叫什么、多久前**(数出来的,取不到时长就不写那一截,不编)。
 */
export function noLiveLine(
  title: string,
  mine: readonly RelaySessionView[],
  agentName: (agent: string) => string,
  now: string,
): string {
  const head = `${title}${/[A-Za-z0-9]$/.test(title) ? ' ' : ''}这会儿没有在跑的对话。`
  if (mine.length === 0) return head
  const last = mine.reduce((a, b) => (Date.parse(b.updated_at) > Date.parse(a.updated_at) ? b : a))
  const ago = agoSpokenLabel(last.updated_at, now)
  const when = ago === undefined ? '' : `,${ago === '刚刚' ? '刚刚' : ago}`
  return `${head}最近一条是「${sessionDisplayTitle(last, agentName(last.agent))}」${when}。`
}

/**
 * 念给他听的那一句:「Codex「整理参赛材料与网页」还在跑 · 最后一次动静 3 分钟前 · 在跑测试」。
 *
 * 三样各自可缺:读不到「在做什么」就写 {@link SESSION_ACTIVITY_UNKNOWN},
 * 算不出时刻就整段不写(**不写「未知」这种占位话**)。
 */
export function lookupLine(view: RelaySessionView | undefined, family: string, now: string): string {
  if (view === undefined) return '这条对话刚才还在,这会儿从会话表里消失了 —— 说不清它现在什么状态。'
  const title = sessionDisplayTitle(view, family)
  const gap = /[A-Za-z0-9]$/.test(family) ? ' ' : ''
  const parts = [`${family}${gap}「${title}」${STATUS_SPOKEN[view.status]}`]
  const ago = agoSpokenLabel(view.updated_at, now)
  if (ago !== undefined) parts.push(ago === '刚刚' ? '刚刚还在动' : `最后一次动静是${ago}`)
  parts.push(view.activity === undefined || view.activity.line.trim() === ''
    ? SESSION_ACTIVITY_UNKNOWN
    : `最后一句是${view.activity.line}`)
  return `${parts.join(' · ')}。`
}
