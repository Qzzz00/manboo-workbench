/**
 * 捎话:他点名的**任何一条会话**,不限于挂在事项上的那些(2026-09-26,卡 BR)。
 *
 * ## 撞出来的事
 *
 * 维护者 16:41 在电话里说:「给那个 Claude,现在正在做统筹交接的那个会话窗口,发个信息问一下:
 * 现在进行到什么情况,大概什么时候能处理完」。事务官答:「那条统筹交接是客户端里跑着的会话,
 * 不挂在看板事项上,这边捎不进话去。它归哪件事?」—— 他把这算作 bug:**「它不能给你发信息」**。
 *
 * 病不在"没有送话的手"(卡 T 的 {@link import('./sessionAnswer.ts').SessionAnswerService.answer} 就是那只手),
 * 而在**两道门都只认"挂在事项上的活"**:
 *
 * 1. `POST /sessions/answer` 要求那条会话此刻**正在等他**(`ask` 挂着),否则 409「这一问已经不在了」。
 *    统筹交接那条会话在**跑**,它没在问他 —— 送话的路当场关着。
 * 2. 通话那条路(`channel-worker` 的 `wb_ask_butler`)只能顺着**某条事项**问到本体,没有事项 id 就回
 *    「先调 wb_list_doing 挑一条」—— 于是电话里听到的是「它归哪件事」。那是**把自己的限制推给他**。
 *
 * ## 这一层做什么
 *
 * 只做**认人**与**记号**两件纯活,一个字节都不落盘:
 *
 * - {@link matchRelaySession}:他那句话("统筹交接那条 / Claude 刚才那条正在跑的 / Codex 那条")
 *   对上 `/state.sessions` 里的哪一条。**认不准不猜**:并列的几条一起交回去,由事务官念给他选。
 * - {@link relayMark} / {@link relayPrompt}:送进去那句话前面的记号(`【事务官捎话 a1b2c3】`),
 *   与派活那套(`dispatchReply.ts` 的 `工作台派活 xxxxxx`)同一个形状、同一个用处:
 *   读回话时靠它在那扇窗里找到我们送进去的那一句,他在那家的对话列表里也认得出这句是谁捎的。
 *   `sessionDigest` 的 `stripLeadingTags` 本来就剥行首的 `【…】`,所以它不会被当成他说的话。
 *
 * 真把字送进那条会话的是 `sessionAnswer.relay`(同一张「哪一家走哪条路」的表,同一套壳原语);
 * 门与人话在 `http.ts` 的 `POST /sessions/relay`。
 *
 * ## 纪律
 *
 * - **只认他自己说的话**当捎话内容:`text` 原样送,不改写成需求、不替他补一句"请回报进度"。
 * - **认不准不猜**:候选念给他选;一条都对不上就说一条都对不上(不挑"最像的那条"送进去 ——
 *   送错窗口比送不到糟得多,同卡 T 那条纪律)。
 * - **工作台自己起的会话**(`selfcheck`)与**事务官自己的会话**(`dsh`)不在候选里:
 *   前者不是他的会话(卡 V),后者就是事务官本人 —— 她要说的话直接说,不用捎。
 */
import type { SessionStatus, SessionView } from '../protocol.ts'
import { agoLabel, sessionDisplayTitle } from '../protocol.ts'
import { matchSpokenFamily, stripSpokenFamily, type SpokenFamily } from './spokenFamily.ts'

/** 送进去那句话前面那个记号的名字。派活是「工作台派活」,捎话是这一个。 */
export const RELAY_TAG = '事务官捎话'

/**
 * 记号:`事务官捎话 a1b2c3`。**同一条会话的同一次捎话永远同一个记号**(取那条会话 id 的前 6 位)——
 * 读回话时靠它找我们那一句。形状照 `dispatchMarker`(那边取事项 id 前 6 位)。
 */
export function relayMark(sessionId: string): string {
  const short = sessionId.replace(/[^0-9a-zA-Z]/g, '').slice(0, 6)
  return `${RELAY_TAG} ${short === '' ? sessionId.slice(0, 6) : short}`
}

/**
 * 真送进那条会话的那段话。**他的原话一个字不改**,前面只加一个记号 ——
 * 派活那边还会补一句工作目录与交代,捎话**什么都不补**:他要那条会话回答的是他问的那一句,
 * 我们替他补的每一句都会被那家当成要求的一部分。
 */
export function relayPrompt(input: { sessionId: string, said: string }): string {
  // ★ 2026-09-28 20:5x 维护者:送进去的只要她那句原话 —— 「事务官捎话 xxxxxx」那个前缀不要了。
  // 读回话改认她那句本身(见 {@link relayReadMark})。`sessionId` 留着:调用方不用跟着改。
  void input.sessionId
  return input.said.trim()
}

/**
 * 读回话时认「我们那一句」用的那截字(2026-09-28 20:5x,前缀拿掉之后):就是她那句原话的第一行,最多 30 个字。
 * 很短的话(「停下」)在窗口里可能不止一处,读回话认不准就如实说读不到 —— 不为了好认往她话里加字。
 */
export function relayReadMark(said: string): string {
  const first = said.trim().split('\n')[0] ?? ''
  return [...first.trim()].slice(0, 30).join('')
}

/** 候选里的一条(念给他听的那一行 + 调 `/sessions/answer` / `/sessions/relay` 要带的那两个字段)。 */
/**
 * 认名字、念候选只用到这几格 —— **`agent` 放宽成字符串**(2026-09-28,卡 WR)。
 *
 * 窗口型各家(Manus / 豆包办公 / Muse / Grok Bot / Antigravity)在登记表里的 id 是那一条的 id
 * (多数就是包标识),不是写死的 `AgentId` 那几家;而它们的已有对话现在也是捎话的候选
 * (`http.ts` 的 `relaySessionPool`)。别的格与 {@link SessionView} 逐字相同。
 */
export type RelaySessionView = Omit<SessionView, 'agent'> & { agent: string }

export interface RelayCandidate {
  agent: string
  session_id: string
  /** 界面上怎么叫它(`sessionDisplayTitle`)。 */
  title: string
  status: SessionStatus
  /** 念给他听的一行:「Claude「Desktop-workbench 统筹交接」(在跑 · 3 分钟前)」。 */
  line: string
  /**
   * 这一条得了多少分(见下面那张表,2026-09-27 卡 LK 加)。只给**同一句话在两份会话池里认两次**
   * 的调用方比大小用(`sessionLookup.ts`:先在「在跑 / 等你」里认,认得更准的那一份才作数)。
   * 念给他听的话里不出现它。
   */
  score: number
}

export type RelayMatch =
  /** 唯一命中:直接送。 */
  | { kind: 'one', target: RelayCandidate }
  /** 几条都对得上:念给他选,**不猜**。 */
  | { kind: 'many', candidates: readonly RelayCandidate[], line: string }
  /**
   * 一条都对不上。`family` 有值 = **认出他点的是哪一家了,是这一家没有会话**
   * (2026-09-28,卡 FX):调用方据此答「X 这会儿没有在跑的对话」,而不是念一串别家的。
   */
  | { kind: 'none', line: string, family?: { id: string, title: string } }

/** 会话此刻是什么状态,一个字的说法(念给他听;与会话卡上那几个词同一套)。 */
const STATUS_TEXT: Readonly<Record<SessionStatus, string>> = {
  running: '在跑',
  waiting: '停着在等你',
  done: '说完了',
  error: '出错了',
  offline: '断了',
}

/** 他嘴里的状态词 → 会话状态。命中而状态不符的那几条**扣分**(「正在跑的那条」就不该把做完的那条认出来)。 */
const STATUS_WORDS: readonly { readonly words: readonly string[], readonly status: readonly SessionStatus[] }[] = [
  { words: ['正在跑', '在跑', '跑着', '正在做', '在做', '进行中', '还在'], status: ['running'] },
  { words: ['停住', '停着', '在等我', '等我回', '等着我', '卡住'], status: ['waiting'] },
  { words: ['做完', '办完', '完成了', '结束了', '说完了'], status: ['done'] },
  { words: ['出错', '报错', '失败了'], status: ['error'] },
]

/** 「刚才那条」「最近那条」:并列时取**最近动过**的那一条(不再念一串候选让他挑)。 */
const RECENT_WORDS = ['刚才', '刚刚', '最近', '最新', '刚开', '刚起'] as const

/** 认字用的归一化:去掉空白与常见标点,英文转小写(「Claude Code」与「claude code」是同一个词)。 */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\s　]+/g, '')
    .replace(/[,,。.、;;::!!??「」『』"'"'()()【】\[\]<>《》~~—\-_/\\|]+/g, '')
}

/** 连续 n 元组(认标题用:他很少把整个标题念全,但总会念中间那两三个字)。 */
function ngrams(text: string, n: number): readonly string[] {
  const chars = [...text]
  if (chars.length < n) return chars.length === 0 ? [] : [chars.join('')]
  const out: string[] = []
  for (let i = 0; i + n <= chars.length; i += 1) out.push(chars.slice(i, i + n).join(''))
  return out
}

/** 够格当候选的最低分:光认出家名(15 分)也算 —— 「给 Claude 发个信息」,只有一条 Claude 会话时那就是它。 */
const MIN_SCORE = 15

/**
 * 能被点名的那些会话:工作台自己起的(`selfcheck`)与事务官本人(`dsh`)不算。
 * 两条路(捎话、看一眼)用同一份池子。
 */
export function relayPool(sessions: readonly RelaySessionView[]): readonly RelaySessionView[] {
  return sessions.filter(one => one.selfcheck === undefined && one.agent !== 'dsh')
}

/** 先认家的结果:认出了哪一家(没认出就 `undefined`)+ 该在哪几条会话里接着认。 */
export interface FamilyPick {
  family?: { id: string, title: string }
  /** 认出某一家时 = **只有这一家的会话**(可能是空的:这一家此刻没有会话);没认出时 = 全池。 */
  pool: readonly RelaySessionView[]
  /**
   * 认标题该用他那句话里的哪一截:**家名切掉之后剩下的那半句**
   * (没认出家时就是他整句原话)。见 {@link stripSpokenFamily} —— 不切的话家名的字母
   * 会去撞标题的二元组(真机上「Claude」撞上了「Fix f**la**ky **cl**ient-dock…」)。
   */
  said: string
}

/**
 * **先认家、再在这家里认对话**(2026-09-28,卡 FX)。
 *
 * 真机上「Kimi」认成了 claude 的一条、「minus」也认成了 claude 的一条 ——
 * 因为家名只值 15 分,别家标题的碎片轻易就赢了过去。点了名的那一家,
 * 就**绝不该答别家的对话**:认出是某一家 → 候选只剩这一家的会话(空着也照样只剩空的)。
 *
 * 读音近似与别名走 {@link matchSpokenFamily}(与工人 `agentName.ts` 同一套判据),
 * 候选家只取本机真装的那几家(`spokenFamilies`)。**两家都像 / 一家都不像时什么都不做** ——
 * 那时他说的很可能是标题,照旧在全池里按标题认。
 */
export function pickFamily(input: {
  sessions: readonly RelaySessionView[]
  who: string
  agentName: (agent: string) => string
  families?: readonly SpokenFamily[] | undefined
}): FamilyPick {
  const pool = relayPool(input.sessions)
  const families = input.families ?? []
  if (families.length === 0) return { pool, said: input.who }
  const spoken = matchSpokenFamily(input.who, families)
  if (spoken.kind !== 'one') return { pool, said: input.who }
  const found = families.find(one => one.id === spoken.id) ?? { id: spoken.id, title: spoken.title }
  const title = normalize(spoken.title)
  const mine = pool.filter(one => one.agent === spoken.id || normalize(input.agentName(one.agent)) === title)
  return {
    family: { id: spoken.id, title: spoken.title },
    pool: mine,
    said: stripSpokenFamily(input.who, found),
  }
}

/**
 * 他那句话对上哪一条会话。**纯函数**:只看 `/state.sessions` 这一份(与气泡、会话列表同一份账)。
 *
 * 打分(写明每一项,验收时看得见靠什么认出来的):
 * | 对上什么 | 加多少 |
 * |---|---|
 * | 会话 id 的前几位(他念了编号) | 100 |
 * | 整个标题都在他那句话里 | 60 |
 * | 标题的二元组过半命中 | 40 |
 * | 标题的二元组命中 ≥ 2 个(「统筹交接」对上「Desktop-workbench 统筹交接」) | 20 |
 * | 家名(Claude / Codex / 事务官…) | 15 |
 * | 状态词与这条会话的状态相符 | 10 |
 * | 状态词与这条会话的状态**不符** | −20 |
 */
export function matchRelaySession(input: {
  sessions: readonly RelaySessionView[]
  /** 他点名那一句的原话。 */
  who: string
  /** 那一家叫什么(`sessionAgentName`)。 */
  agentName: (agent: string) => string
  /** 算「3 分钟前」用的此刻(ISO)。缺省不写那一截。 */
  now?: string
  /**
   * 认家名用的候选表(2026-09-28,卡 FX)。传了就**先认家、再只在这家里认对话**;
   * 不传就是这一版之前的行为(全池一起打分)。
   */
  families?: readonly SpokenFamily[] | undefined
}): RelayMatch {
  const picked = pickFamily({ sessions: input.sessions, who: input.who, agentName: input.agentName, families: input.families })
  /** 认标题只看**家名切掉之后**那半句(`picked.said`;没认出家时就是他整句原话)。 */
  const asked = normalize(picked.said)
  const pool = picked.pool
  if (pool.length === 0) {
    const family = picked.family
    if (family !== undefined) {
      return { kind: 'none', family, line: `${family.title} 这会儿没有开着的对话。` }
    }
    return { kind: 'none', line: '这会儿一条别家的会话都没有 —— 没有能捎话的地方。' }
  }
  /** 他整句都是空的才算"没说清";**家名切完剩下空的不算**(「给 Claude 捎句话」照旧往下认)。 */
  if (normalize(input.who) === '') {
    return { kind: 'none', line: '没说清要给哪一条会话捎话。问他一句是哪一条,别猜。' }
  }

  const wantsRecent = RECENT_WORDS.some(word => input.who.includes(word))
  const scored = pool.map((session) => {
    const title = sessionDisplayTitle(session, input.agentName(session.agent))
    const titleKey = normalize(session.title ?? '')
    let score = 0
    const idKey = normalize(session.session_id)
    if (idKey.length >= 4 && asked.includes(idKey.slice(0, 6))) score += 100
    if (titleKey !== '') {
      if (asked.includes(titleKey)) score += 60
      else {
        const grams = ngrams(titleKey, 2)
        const hit = grams.filter(gram => asked.includes(gram)).length
        if (grams.length > 0 && hit * 2 >= grams.length) score += 40
        else if (hit >= 2) score += 20
      }
    }
    const family = normalize(input.agentName(session.agent))
    /**
     * 家名那 15 分:池子已经按家筛过时**照样给**(2026-09-28,卡 FX)——
     * 家是认准了的,只是那个名字已经从 `asked` 里切掉了(不然它的字母会去撞标题的二元组)。
     */
    if (picked.family !== undefined || (family !== '' && asked.includes(family))) score += 15
    for (const row of STATUS_WORDS) {
      if (!row.words.some(word => asked.includes(normalize(word)))) continue
      score += row.status.includes(session.status) ? 10 : -20
    }
    return { session, title, score }
  })

  const best = Math.max(...scored.map(one => one.score))
  /**
   * 认出了是哪一家(`picked.family`)就**不走这条退路**:池子里剩下的全是这一家的会话,
   * 一条就是它,几条就在**这一家里面**问他是哪一条(2026-09-28,卡 FX)——
   * 「minus」这种听错的名字对不上任何字面,分数是 0,但家是认准的。
   */
  if (best < MIN_SCORE && picked.family === undefined) {
    return {
      kind: 'none',
      line: `没认出他说的是哪一条会话(这会儿有 ${pool.length} 条)。念几条给他听、问他是哪一条,别挑一条送进去。`,
    }
  }
  let top = best < MIN_SCORE ? scored : scored.filter(one => one.score === best)
  // 「刚才那条 / 最近那条」:并列时取最近动过的那一条。
  if (top.length > 1 && wantsRecent) {
    const newest = top.reduce((a, b) => (Date.parse(b.session.updated_at) > Date.parse(a.session.updated_at) ? b : a))
    top = [newest]
  }
  const candidates = top.map(one => ({
    agent: one.session.agent,
    session_id: one.session.session_id,
    title: one.title,
    status: one.session.status,
    line: candidateLine(one.session, one.title, input.agentName(one.session.agent), input.now),
    score: one.score,
  }))
  const first = candidates[0]
  if (candidates.length === 1 && first !== undefined) return { kind: 'one', target: first }
  return {
    kind: 'many',
    candidates,
    line: `有 ${candidates.length} 条都对得上:${candidates.map((one, index) => `${index + 1}. ${one.line}`).join(';')}。问他是哪一条。`,
  }
}

/** 念给他听的那一行:「Claude「Desktop-workbench 统筹交接」(在跑 · 3 分钟前)」。 */
function candidateLine(session: RelaySessionView, title: string, family: string, now: string | undefined): string {
  const ago = now === undefined ? undefined : agoLabel(session.updated_at, now)
  const gap = /[A-Za-z0-9]$/.test(family) ? ' ' : ''
  const when = ago === undefined ? '' : ` · ${ago}`
  return `${family}${gap}「${title}」(${STATUS_TEXT[session.status]}${when})`
}
