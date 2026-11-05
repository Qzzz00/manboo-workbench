/**
 * 界面读 Agent 登记表(2026-09-25,卡 Q「Agent 自动发现与统一接入」)。
 *
 * 维护者:「我发现新增的muse、manus、豆包都没有气泡,也不统计会话标题内容还有额度」;
 * 「要是写死了就很糟糕了……你得想个机制,后面检测到是 Agent,有会话窗口的这种都得能有气泡和会话状态、标题、内容」。
 * 所以顶栏小灯、窗口槽标签的圆点与气泡、会话列表、事务官舞台、「执行」这类计数,**都从这里取「有哪几家」**,
 * 界面代码里不再有「dsh / claude / codex / kimi」那种写死的表。一家在登记表里,它就出现在所有这些地方;
 * 他说「这不是 Agent」撤掉,它就从所有这些地方消失。
 *
 * 纯函数,不碰网络。服务端没带 `agent_registry`(老版本)时,退回会话流里出现过的那几家,名字就用它的 id ——
 * 不为这种过渡情况再存一张名字表。
 */
import type { AgentBlockedView, AgentEntryView, AgentSessionView, SessionView, WorkbenchState } from '../protocol.ts'
import { AGENT_NEUTRAL_COLOR, AGENT_NEVER_READ, AGENT_READ_SCOPE, ASSIGNEE_PICKER_PEOPLE, ASSIGNEE_PICKER_TAIL, agentNotOpenWhy, registryOnlySession } from '../protocol.ts'

export type RegistryState = Pick<WorkbenchState, 'agent_registry' | 'sessions'> & { dock?: WorkbenchState['dock'] }

/** 老服务端(没有登记表)时:按会话流里出现过的那几家拼出最小的条目,名字就是 id。 */
function entriesFromSessions(sessions: readonly SessionView[]): AgentEntryView[] {
  const ids = [...new Set(sessions.map(one => one.agent))]
  return ids.map((id) => {
    const mine: AgentSessionView[] = sessions.filter(one => one.agent === id).map(one => ({ ...one, via: 'sessions' as const }))
    const running = mine.filter(one => one.status === 'running').length
    const waiting = mine.filter(one => one.status === 'waiting').length
    return {
      id,
      name: id,
      ...(id === 'dsh' ? { self: true } : {}),
      color: AGENT_NEUTRAL_COLOR,
      found: { how: 'sessions', at: '', basis: '' },
      sources: [],
      status: running > 0 ? 'running' : waiting > 0 ? 'waiting' : 'idle',
      gaps: {},
      sessions: mine,
      counts: { running, waiting, unread: mine.filter(one => one.status === 'done' && one.unread).length },
    }
  })
}

/** 接上了的那几家(事务官自己在最前)。 */
export function registryEntries(state: RegistryState): readonly AgentEntryView[] {
  return state.agent_registry?.entries ?? entriesFromSessions(state.sessions)
}

/**
 * **开着的排在前面,没开的排在后面**(2026-10-01)。装着、没开的那几家照旧摆出来(她要一眼看见
 * 这台电脑上有哪几家),但不该跟开着的混在一起 —— 服务端那一份顺序(事务官自己最前、其余按认出来的先后)
 * 在**各自那一段里**一字不动,这里只把「没开」整段挪到后面。
 *
 * 「没开」只认服务端明说的 `app_running === false`:没有这一格(只走会话文件的那几家、老服务端)
 * **不算没开** —— 不猜(D13)。
 */
export function entriesByRunning(entries: readonly AgentEntryView[]): readonly AgentEntryView[] {
  const closed = (entry: AgentEntryView): boolean => entry.self !== true && entry.app_running === false
  return [...entries.filter(one => !closed(one)), ...entries.filter(closed)]
}

/** 这一家明说没开(灰着画、后面排,那一句就写「没开」)。 */
export function entryClosed(entry: AgentEntryView): boolean {
  return entry.self !== true && entry.app_running === false
}

/** 所有家的会话摊平:气泡、会话列表、「执行」数都数它。 */
export function registrySessions(state: RegistryState): AgentSessionView[] {
  return registryEntries(state).flatMap(entry => entry.sessions)
}

/**
 * 那一家的颜色(2026-09-25,卡 Q):登记表里算好的那一格(从它 App 图标的主色来,深色底上提亮过)。
 * 不在表里 / 老服务端没给 → 中性灰,不猜。会话卡的小头像、事务官舞台、顶栏小灯都取这里。
 */
export function agentColorOf(state: RegistryState | undefined, id: string): string {
  if (state === undefined) return AGENT_NEUTRAL_COLOR
  return registryEntries(state).find(entry => entry.id === id)?.color ?? AGENT_NEUTRAL_COLOR
}

/** 那一家叫什么:登记表里的名字;不在表里就原样用它的 id(同卡 P 的规矩:不收窄成固定几家)。 */
export function agentName(state: RegistryState | undefined, id: string): string {
  if (state === undefined) return id
  return registryEntries(state).find(entry => entry.id === id)?.name ?? id
}

/**
 * 一家在卡面上的**名字 + 颜色**(2026-09-25,卡 Z;卡 Q 交接里欠的那一样:看板卡上派活的小头像没改色,
 * 因为那一层拿不到登记表)。看板卡、卡片弹窗按这一份给 `FxAvatar`;登记表里没有这一家就只给名字,
 * 颜色交给头像自带的那个(不猜一个颜色)。
 */
export function agentFaceOf(entries: readonly AgentEntryView[] | undefined, id: string): { name?: string, color?: string } {
  const entry = entries?.find(one => one.id === id)
  if (entry === undefined) return {}
  return { name: entry.name, ...(entry.color === undefined ? {} : { color: entry.color }) }
}

/**
 * 卡片弹窗里那排可点的负责人(2026-09-25,卡 Z)。**几家 AI 从登记表插进来** ——
 * 原来 `ASSIGNEE_PICKER` 里写死着 claude / codex / kimi / muse / manus / doubao,新接上一家就点不到它。
 * 顺序:你 → 事务官 → 登记表里的每一家(事务官自己那条不重复)→ 同事 → 别人;
 * 卡上已经写着一家不在这排里的(电话里点名的 GPT、他撤掉的那一家),也摆在最后,免得看不出选的是谁。
 */
export function assigneePicker(entries: readonly AgentEntryView[] | undefined, current?: string): readonly string[] {
  const agents = (entries ?? []).filter(one => one.self !== true && one.id !== 'dsh').map(one => one.id)
  const out = [...ASSIGNEE_PICKER_PEOPLE, ...agents, ...ASSIGNEE_PICKER_TAIL] as string[]
  if (current !== undefined && current !== '' && !out.includes(current)) out.push(current)
  return out
}

/**
 * 事务官自己那一条(2026-09-26,卡 LG2)。坞上「事务官」那一格的图标用它 ——
 * 登记表里 `self` 那条的图**就是工作台自己的图标**(`agentDiscovery.icon` 把 self 换成
 * 工作台的包标识),所以那一格不必另开一条取图的路。
 * 一条都没有(老服务端、登记表没接)就 undefined,那一格画中性小方块。
 */
export function registrySelf(state: RegistryState | undefined): AgentEntryView | undefined {
  if (state === undefined) return undefined
  const entries = registryEntries(state)
  return entries.find(entry => entry.self === true) ?? entries.find(entry => entry.id === 'dsh')
}

/** 窗口槽里那一格对上的那一家:按包标识(`dock.bundles`)对;老服务端没有这一格时按键名对。 */
export function entryForDockTab(state: RegistryState, tab: { key: string }): AgentEntryView | undefined {
  const entries = registryEntries(state)
  const bundle = state.dock?.bundles?.[tab.key]
  if (bundle !== undefined) {
    const byBundle = entries.find(entry => entry.bundle_id === bundle)
    if (byBundle !== undefined) return byBundle
  }
  return entries.find(entry => entry.id === tab.key)
}

export type EntryLamp = 'teal' | 'amber' | 'off'

/** 顶栏那颗小灯:有一条在等你 = 黄;有一条在跑 = 绿;别的灰(同原来 agentLamp 的口径)。 */
export function entryLamp(entry: AgentEntryView): EntryLamp {
  if (entry.counts.waiting > 0 || entry.status === 'waiting') return 'amber'
  if (entry.counts.running > 0 || entry.status === 'running') return 'teal'
  return 'off'
}

/**
 * 顶栏小灯点开那一张(2026-09-25,卡 Q;统筹:「这不是 Agent」要好找,读了什么要说清)。
 * 第一行它此刻怎样(「在跑 · 周报怎么写」,读不到就是「没接上:…」),再是最新一句、读的范围,最后「这不是 Agent」(那颗键 TopBar 画)。
 */
export interface LampDetail {
  state: string
  latest?: string
  /** 整家一句说明(「Muse 没开,显示的是 15:20 最后一次读到的」)。 */
  note?: string
  /** 读什么、不读什么(读窗口那一路才有;专门读法的几家各有各的说法,这里不替它们说)。 */
  reads?: string
}

const STATUS_WORD: Record<AgentEntryView['status'], string> = { running: '在跑', waiting: '在等你', idle: '空闲', unknown: '读不到' }

export function lampDetail(entry: AgentEntryView): LampDetail {
  const head = entry.status === 'unknown'
    ? entry.gaps.status ?? `没接上:读不到 ${entry.name} 在不在跑`
    : `${STATUS_WORD[entry.status]}${entry.title === undefined ? '' : ` · ${entry.title}`}`
  // 读窗口、读它自己记录的那几家都是同一句承诺(只看在不在跑、标题、最新一句)。
  const byWindow = entry.sources.some(one => one.kind === 'window' || one.kind === 'records') && !entry.sources.some(one => one.kind === 'sessions')
  return {
    state: head,
    ...(entry.latest === undefined ? {} : { latest: entry.latest }),
    ...(entry.note === undefined ? {} : { note: entry.note }),
    ...(byWindow ? { reads: `${AGENT_READ_SCOPE}${AGENT_NEVER_READ}` } : {}),
  }
}

/**
 * 顶栏那一排小灯:一家一颗(事务官自己在最前),名字、灯色、最近冒的那一句、点开那一张都从登记表来。
 * 事务官自己那颗不点开(没有「这不是 Agent」可说,它在忙什么球下那一整页都是)。
 */
export function registryLamps(state: RegistryState): { id: string, name: string, color: EntryLamp, tint: string, icon: boolean, dim?: boolean, why?: string, bubble?: string, detail?: LampDetail }[] {
  // 没开的那几家排到这一排最后、灰着(2026-10-01):开着的先看见,装着没开的也不藏起来。
  return entriesByRunning(registryEntries(state)).map(entry => ({
    id: entry.id,
    name: entry.name,
    color: entryLamp(entry),
    // 还没接上的那几家(读不到它在不在跑)**灰着画在这一排里**(2026-09-26,卡 TB2;维护者:
    // 「这两个明显重叠了…这能整合的吧」)—— 原来它们只在「N 家 Agent 客户端」那条单独的排里出现,
    // 那条排跟这一排说的是同一批家,于是那条排整块退休,候选家并进来、灰着、悬停说清为什么。
    // 事务官自己不算「没接上」(它就在这儿跑着,没有窗口可读这回事)。
    // 没开的那一家:灰着,那一句就写「没开」(2026-10-01)—— 不许再说成「开着,但一扇窗都没有」。
    ...(entryClosed(entry)
      ? { dim: true, why: `${entry.name}:${agentNotOpenWhy(entry.name)}` }
      : entry.self === true || entryConnected(entry) ? {} : { dim: true, why: `${entry.name}:${entry.gaps.status ?? '还没接上'}` }),
    // 这一家自己的颜色(名字用它写):与会话卡上的小头像、手机上同一个色。
    tint: entry.color ?? AGENT_NEUTRAL_COLOR,
    // 它的 logo 取到了没(2026-09-26,卡 LG):取到了这颗灯就是那张图,状态那颗点叠在图的右下角 ——
    // **状态语义一点没丢**,只是不再靠一颗点独自表示"这是哪一家"。
    icon: entry.icon === true,
    ...(entry.bubble === undefined ? {} : { bubble: entry.bubble.text }),
    ...(entry.self === true ? {} : { detail: lampDetail(entry) }),
  }))
}

// ───────────────────── 这台电脑上有几家 Agent 客户端(2026-09-26,卡 LG) ─────────────────────

/**
 * 「这台电脑上 N 家 Agent 客户端」那一条上的一家。
 * 维护者原话:「增加一个功能,就是现在电脑上有多少个 Agent 客户端,把对应的 logo 也搞上」。
 */
export interface RegistryCountItem {
  id: string
  name: string
  /** 事务官自己(没有「这不是 Agent」可说)。 */
  self: boolean
  /** 它的 logo 取到了没(没取到画色点)。 */
  icon: boolean
  /** 这一家自己的颜色(退回色点时用)。 */
  tint: string
  /** 真接上了(读得到它在不在跑)。假 = 灰着画。 */
  connected: boolean
  /** 那一家此刻怎样 / 为什么还没接上 —— 悬停时说这一句。 */
  why: string
}

export interface RegistryCount {
  /**
   * 几家。**只数 `/state.agent_registry.entries`**(卡 Q 那张运行时的登记表),不写死名单 ——
   * 哪天多接上一家,这个数自己就变了,一行代码都不用改。事务官自己也在里面(它一直在登记表最前,
   * 同样是这台电脑上跑着的一家)。
   */
  total: number
  /** 「这台电脑上 9 家 Agent 客户端」。 */
  text: string
  /**
   * 小灯那一排最前面那一小格上写的字(2026-09-26,卡 TB2):就「9 家」两个字 ——
   * 整句话(`text`)是它的悬停与读屏名,顶栏上不再占一长条。
   */
  label: string
  items: readonly RegistryCountItem[]
  /**
   * 拿不准的那几家(2026-09-26,卡 TB2 追加;维护者:「每一个下面都有一个『这不是 Agent』的按钮,这很蠢」)。
   * 登记表面板里**只有这几行常显「接上 / 不是」两颗键** —— 那是真要他判断的事;已经接上的那几家
   * 默认一颗键都不显(「这不是 Agent」收进那一行的「⋯」里)。来源是 `agent_registry.asking`,
   * 它们不算进 `total`(还没接上,不是「这台电脑上的一家」)。
   */
  candidates: readonly { id: string, name: string, why: string }[]
  /**
   * **认出是 AI 应用、可它那扇窗读不到**的那几家(2026-10-01;Air:新版 Kimi、可灵、App Store 版豆包)。
   * 不算进 `total`(确实没接上),但也不许默默不列 —— 灰着摆一行,说清工作台替不了她往里发话。
   */
  unreadable: readonly { id: string, name: string, why: string, detail: string }[]
}

/** 这一家算不算真接上了:最要紧的那一样「它在不在跑」读得到就算(`gaps.status` 正是「没接上:…」那一句)。 */
function entryConnected(entry: AgentEntryView): boolean {
  return entry.status !== 'unknown' && entry.gaps.status === undefined
}

const COUNT_STATUS_WORD: Record<AgentEntryView['status'], string> = { running: '在跑', waiting: '在等你', idle: '空闲', unknown: '读不到' }

/**
 * 顶栏左端那一小条(2026-09-26,卡 LG):N + 一排各家的小 logo。
 * 还没接上的那几家照样摆出来、**灰着**,悬停说清「没接上:为什么」——
 * 一眼看见「有哪几家、哪几家还差点什么」,而不是只剩接上了的那几家。
 */
export function registryCount(state: RegistryState): RegistryCount {
  // 数的是这台电脑上的**客户端**:事务官自己(`self`,登记表里排最前的那条)不算一家(统筹 2026-09-26 定)。
  const entries = entriesByRunning(registryEntries(state)).filter(entry => entry.self !== true && entry.id !== 'dsh')
  return {
    total: entries.length,
    text: `这台电脑上 ${entries.length} 家 Agent 客户端`,
    label: `${entries.length} 家`,
    candidates: (state.agent_registry?.asking ?? []).map(ask => ({ id: ask.id, name: ask.name, why: ask.basis })),
    // 认出来了、窗口读不到的那几家(服务端 `agentRegistry.unreadableApps` 算好的,原话用)。
    unreadable: (state.agent_registry?.unreadable ?? []).map(one => ({ id: one.id, name: one.name, why: one.why, detail: one.detail })),
    items: entries.map((entry) => {
      // ★ 没开的那一家**不算接上着**(2026-10-01;维护者:「我已关闭后台但依旧挂在事务官处」)——
      // 登记表上它的状态是「显示的是上次读到的」,照着念成「空闲」就等于说它还在那儿候着。
      const connected = !entryClosed(entry) && entryConnected(entry)
      return {
        id: entry.id,
        name: entry.name,
        self: entry.self === true,
        icon: entry.icon === true,
        tint: entry.color ?? AGENT_NEUTRAL_COLOR,
        connected,
        why: connected
          ? `${entry.name}:${COUNT_STATUS_WORD[entry.status]}${entry.title === undefined ? '' : ` · ${entry.title}`}`
          // 没开就说没开(2026-10-01);其余那几句登记表已经写成人话了,原样用。
          : entryClosed(entry) ? `${entry.name}:${agentNotOpenWhy(entry.name)}` : `${entry.name}:${entry.gaps.status ?? '还没接上'}`,
      }
    }),
  }
}

/**
 * 小灯那一排后面那一句(2026-09-25,卡 Q;统筹:没给壳辅助功能授权时「得是一句能懂的话,加上一键去开的入口,不许空白」)。
 * `authorize` = 这一句带不带「去打开」(没授权才带;壳是旧版的那一句没有能一键做的事)。
 */
export function registryHint(state: Pick<WorkbenchState, 'agent_registry'>): { text: string, authorize: boolean } | undefined {
  const blocked: AgentBlockedView | undefined = state.agent_registry?.blocked
  if (blocked === undefined) return undefined
  return { text: blocked.text, authorize: blocked.kind === 'accessibility' }
}

/** 这一条会话看过了:只在登记表里的(读窗口 / 读它自己记录的)走登记表那条路,专门读法的走原来的 `/read`。 */
export function markReadRequest(session: Pick<AgentSessionView, 'agent' | 'session_id' | 'via'>): { path: string, body: Record<string, string> } {
  return registryOnlySession(session)
    ? { path: '/agents/read', body: { id: session.agent } }
    : { path: '/read', body: { agent: session.agent, session_id: session.session_id } }
}
