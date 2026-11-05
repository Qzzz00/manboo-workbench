/**
 * 会话状态机（纯函数）。
 *
 * 只做三件事：吃进一条上报、算出界面要的四种状态、维护「刚完成」的未读位。
 * 不碰网络、不碰时钟——当前时刻一律由调用方传进来，这样响铃与计时都能在测试里精确复现。
 */
import type {
  AgentId, EventReason, HumanErrorView, SelfcheckView, SessionActivity, SessionMetrics, SessionStatus, SessionView, WaitReason, WorkbenchEvent,
} from '../protocol.ts'

/** project 与 cwd 都拿不到时的占位。宁可标"未归类"，也不编一个项目名（PRD §5.3）。 */
export const UNKNOWN_PROJECT = '未归类'

/** 服务端内部的一条会话。与 SessionView 的差别是这里存绝对时刻，视图才换算成秒数。 */
export interface SessionRecord {
  agent: AgentId
  session_id: string
  project: string
  cwd?: string
  status: SessionStatus
  reason?: EventReason
  /** 来源自己判出的等待原因(见 protocol.ts 的 WaitReason)。判不出就缺席。 */
  wait_reason?: WaitReason
  title?: string
  summary?: string
  /** 最近在做什么(2026-09-25,卡 P)。同 title/summary 沿用上一次已知值。 */
  activity?: SessionActivity
  /** 进入当前状态的时刻（Unix 秒），elapsed_sec 由它算出来。 */
  status_since: number
  /** 最近一次收到上报的时刻（Unix 秒）。 */
  last_output_at: number
  /** 仅「刚完成」用：置上以后只有显式已读才清（PRD §5.3）。 */
  unread: boolean
  /** 会话行上的几个数字(目前只有 DSH 会话有,见 setMetrics)。 */
  metrics?: SessionMetrics
  /**
   * 这条会话是工作台自己起的(2026-09-25,卡 V)。**沿用上一次已知值**:
   * 探针的记号是这条会话的属性(它从生到死都是探针),不像「等待原因」那样是「此刻为什么停」。
   */
  selfcheck?: SelfcheckView
  /** 出错那一档的人话 + 一键入口。**不沿用**:回到在跑的会话不该还挂着上一次的报错。 */
  human_error?: HumanErrorView
  /** 判成这个状态的依据,一句话。同上不沿用。 */
  status_why?: string
  /** 记录里明写着停下来在等人(形式信号)。同 wait_reason 不沿用 —— 它说的是「此刻」。 */
  formal_wait?: 'approval' | 'question'
}

export type SessionStore = Readonly<Record<string, SessionRecord>>

export function emptySessionStore(): SessionStore {
  return {}
}

/**
 * 会话表留多久(2026-10-19,卡「插件内存增长与 GC 抖动」)。
 *
 * 这张表从前**只进不出**:每条上报过的会话(DSH / Claude / Codex / Kimi)都留着,`/state.sessions`
 * 每一拍整块重算、整块广播;进程跑上四五天,表里就是这几天的每一条会话。
 * 7 天:「刚完成」的蓝点(PRD §5.3)按天算早该看过了;会话记录本身在各家的文件里(`sessionHistory`),
 * 这张表只是「此刻在跑 / 在等 / 刚完成」的状态,不是档案。
 */
export const SESSION_STORE_KEEP_SEC = 7 * 86_400

/**
 * 不在跑的会话每家最多留几条(同一张卡)。第二道上限:一天里开几百条会话的机器,7 天也能攒几千条。
 * 在跑 / 在等的**一条都不丢**(它们是此刻的事实),只从结束了的里面按最老的先丢。
 */
export const SESSION_STORE_MAX_SETTLED_PER_AGENT = 200

/** 这条会话「结束了」:不在跑、不在等(done / error / offline 一类)。 */
function settled(record: SessionRecord): boolean {
  return record.status !== 'running' && record.status !== 'waiting'
}

/**
 * 收一次会话表:结束了的会话,最后一次动静超过 `keepSec` 的丢;每家结束了的超过 `maxSettledPerAgent` 条,
 * 按最后一次动静最老的先丢。在跑 / 在等的一条不动。**没有要丢的就原样返回**(调用方据此判断变没变)。
 */
export function pruneSessionStore(
  store: SessionStore,
  nowSec: number,
  options: { keepSec?: number, maxSettledPerAgent?: number } = {},
): SessionStore {
  const keepSec = options.keepSec ?? SESSION_STORE_KEEP_SEC
  const maxSettled = options.maxSettledPerAgent ?? SESSION_STORE_MAX_SETTLED_PER_AGENT
  const drop = new Set<string>()
  const settledByAgent = new Map<string, { key: string, at: number }[]>()
  for (const [key, record] of Object.entries(store)) {
    if (!settled(record)) continue
    if (nowSec - record.last_output_at > keepSec) { drop.add(key); continue }
    const list = settledByAgent.get(record.agent) ?? []
    list.push({ key, at: record.last_output_at })
    settledByAgent.set(record.agent, list)
  }
  for (const list of settledByAgent.values()) {
    if (list.length <= maxSettled) continue
    list.sort((a, b) => a.at - b.at)
    for (const one of list.slice(0, list.length - maxSettled)) drop.add(one.key)
  }
  if (drop.size === 0) return store
  return Object.fromEntries(Object.entries(store).filter(([key]) => !drop.has(key)))
}

/** 会话主键。不同 agent 可能撞 session_id，必须带上来源。 */
export function sessionKey(agent: AgentId, sessionId: string): string {
  return `${agent}:${sessionId}`
}

/** project 缺失时按 cwd 末段推断项目名；推不出来就返回 undefined，不编造。 */
export function inferProject(cwd?: string): string | undefined {
  if (!cwd) return undefined
  const segments = cwd.split(/[\\/]/).filter(Boolean)
  return segments.at(-1)
}

/**
 * 状态指纹。waiting 的两种成因（等审批 / 等你下一句）是两回事，
 * 成因变了也算重新进入状态，计时要归零，否则响铃判定会用错时长。
 */
function statusFingerprint(status: SessionStatus, reason?: EventReason): string {
  return `${status}|${reason ?? ''}`
}

function optional<K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>)
}

/** 吃进一条上报，返回新的 store。receivedAtSec 用于 event.ts 缺省时兜底。 */
export function applyEvent(
  store: SessionStore,
  event: WorkbenchEvent,
  receivedAtSec: number,
  /**
   * 这条会话是不是**早就被标过已读**(2026-09-02,已读簿 readMarks.ts)。
   * 缺省即从前的行为。用来挡住"重启后 done 一律重新变未读"——会话表随进程蒸发,
   * 而"我看过了"这个判断不该跟着蒸发。
   */
  alreadyRead?: (agent: WorkbenchEvent['agent'], sessionId: string) => boolean,
): SessionStore {
  const key = sessionKey(event.agent, event.session_id)
  const prev = store[key]

  // 幽灵 SessionEnd：从没见过这个会话，第一条事件就是 offline，说明它是一次性的
  // 后台/辅助进程（headless 探针之类），生平只发过这一条 SessionEnd。给它建一行毫无
  // 信息量——没有 project、没有正常状态流转，界面上就是一条 cwd=/Users/example、
  // transcript 不存在的纯噪音。"结束一个不存在的东西"本来就该是空操作，直接丢弃，
  // store 原样返回。已经见过的会话收到 offline 照旧正常流转（下面的逻辑不变）。
  if (prev === undefined && event.type === 'offline') return store

  const ts = typeof event.ts === 'number' && Number.isFinite(event.ts)
    ? Math.floor(event.ts)
    : receivedAtSec

  const entered = !prev
    || statusFingerprint(prev.status, prev.reason) !== statusFingerprint(event.type, event.reason)

  const record: SessionRecord = {
    agent: event.agent,
    session_id: event.session_id,
    project: event.project?.trim() || inferProject(event.cwd) || prev?.project || UNKNOWN_PROJECT,
    status: event.type,
    status_since: entered ? ts : prev.status_since,
    /**
     * 「最后一次动静」**与「进入这个状态」分开算**(2026-09-27,卡 LK)。
     * 来源报了 `output_ts` 就用它(见 protocol.ts 那一格的注释:一条在跑的对话不会再报一次
     * `task_started`,但每一步都在写文件);没报就照旧用 `ts`。只进不退,避免闪。
     */
    last_output_at: Math.max(
      ts,
      typeof event.output_ts === 'number' && Number.isFinite(event.output_ts) ? Math.floor(event.output_ts) : ts,
      prev?.last_output_at ?? ts,
    ),
    // 完成即标未读；已经未读的保持未读，后续消息刷不掉它（PRD §5.3）。
    // 例外:已读簿里记着这条(上一条命里他标过已读)→ 不再翻回未读。
    unread: event.type === 'done'
      ? !(alreadyRead?.(event.agent, event.session_id) ?? false)
      : prev?.unread ?? false,
    // 数字同理沿用:状态上报里从来不带它们(它们走 setMetrics 那条独立的路),
    // 不沿用的话每来一条状态就把行上的三个数字擦一次,看起来像在闪。
    ...optional('metrics', prev?.metrics),
    // title / summary 沿用上一次已知值：进度上报不带这两项，擦掉会让界面失去判断依据。
    ...optional('cwd', event.cwd ?? prev?.cwd),
    ...optional('reason', event.reason),
    // **不沿用上一条的等待原因**:它说的是"此刻为什么停",不是会话的属性。
    // 沿用的话,一条刚从"等审批"回到"在跑"的会话会一直挂着「等审批」,那就是骗人。
    ...optional('wait_reason', event.wait_reason),
    ...optional('title', event.title ?? prev?.title),
    ...optional('summary', event.summary ?? prev?.summary),
    ...optional('activity', event.activity ?? prev?.activity),
    // 探针的记号**沿用**:它是这条会话的属性(从生到死都是探针),下一拍读不到不该把记号弄丢
    // ——弄丢了那一拍它就会跳上舞台、把气泡多加一个,正是卡 V 要修的那件事。
    ...optional('selfcheck', event.selfcheck ?? prev?.selfcheck),
    // 下面三样说的都是「此刻」,**不沿用**(同 wait_reason 的理由:一条从出错回到在跑的会话
    // 不该还挂着上一次那句「Claude 命令行还没登录」)。
    ...optional('human_error', event.human_error),
    ...optional('status_why', event.status_why),
    ...optional('formal_wait', event.formal_wait),
  }

  return { ...store, [key]: record }
}

/**
 * 补一条会话的标题 / 最近在做什么(2026-09-25,卡 P)。与 setMetrics 同一条纪律:
 * **会话不在就原样返回**(不凭空建行)、**不动状态与计时**(hook 在管状态的会话,读会话文件那一路只补这两样)。
 * 值没变也原样返回,调用方据此判断要不要推一份快照。
 */
export function setDetail(
  store: SessionStore,
  agent: AgentId,
  sessionId: string,
  detail: { title?: string, activity?: SessionActivity, selfcheck?: SelfcheckView },
): SessionStore {
  const key = sessionKey(agent, sessionId)
  const prev = store[key]
  if (!prev) return store
  const title = detail.title ?? prev.title
  const activity = detail.activity ?? prev.activity
  // 探针记号只加不抹(2026-09-26 晚,统筹):钩子在管的会话也要能被认成工作台自己起的。
  const selfcheck = prev.selfcheck ?? detail.selfcheck
  if (title === prev.title && activity?.line === prev.activity?.line && activity?.at === prev.activity?.at && selfcheck === prev.selfcheck) return store
  return { ...store, [key]: { ...prev, ...optional('title', title), ...optional('activity', activity), ...optional('selfcheck', selfcheck) } }
}

/** 把某条会话标成已读。会话不存在或本来就已读时原样返回，方便调用方判断是否变化。 */
export function markRead(store: SessionStore, agent: AgentId, sessionId: string): SessionStore {
  const key = sessionKey(agent, sessionId)
  const prev = store[key]
  if (!prev || !prev.unread) return store
  return { ...store, [key]: { ...prev, unread: false } }
}

/**
 * 写一条会话行上的数字(2026-09-09,DSH 会话的「上下文/缓存命中/改了几个文件」)。
 *
 * **会话不在就原样返回**——数字是状态的附属物,不该凭空创建一行会话:
 * 投影值可能比第一条状态事件先到(实测:permission/preset 引起的投影变化排在 turn/start 之前),
 * 那时候建一行只有数字、没有状态的幽灵会话,界面上就是一条说不清是什么的东西。
 *
 * 合并而不是替换:三个数字各有各的到达时机(文件数来自事件流,另两个来自投影),
 * 后到的那个不该把先到的擦掉。
 */
export function setMetrics(
  store: SessionStore,
  agent: AgentId,
  sessionId: string,
  metrics: SessionMetrics,
): SessionStore {
  const key = sessionKey(agent, sessionId)
  const prev = store[key]
  if (!prev) return store
  const merged = { ...prev.metrics, ...metrics }
  const unchanged = prev.metrics !== undefined
    && Object.keys(merged).length === Object.keys(prev.metrics).length
    && Object.entries(merged).every(([name, value]) => (prev.metrics as Record<string, unknown>)[name] === value)
  if (unchanged) return store
  return { ...store, [key]: { ...prev, metrics: merged } }
}

/**
 * 额度不足的叠加(2026-09-09 傍晚拍板第 4 条)。
 *
 * 「额度不足」与另外三种原因来路不同:等审批/等你输入/出错都是**来源报上来的**,
 * 而额度是采集器在会话之外量到的(quota 面板那条路)。所以它不进 applyEvent,
 * 而是出视图时叠一层——额度回血的下一拍它自己就消失,不必谁去清。
 *
 * 三条边界:
 * 1. **只盖没原因的那些**。来源判出的等审批/等你输入是直接证据,额度只是环境;
 *    盖掉直接证据会把"它在等你点同意"说成"它没额度了",反而误导。
 *    (`error` 会被盖:一条因为额度打光而失败的会话,说「额度不足」比「出错」有用得多。)
 * 2. **只盖停下来的会话**(waiting / error / done)。running 就是没被额度挡住,
 *    offline 已经结束了——给它们打标只是噪音。
 * 3. 没有一家见底时**返回同一个数组引用**,调用方零成本。
 */
export function applyQuotaOverlay(
  views: readonly SessionView[],
  exhausted: ReadonlySet<AgentId>,
): readonly SessionView[] {
  if (exhausted.size === 0) return views
  const overlaid: readonly SessionStatus[] = ['waiting', 'error', 'done']
  return views.map((view) => {
    if (!exhausted.has(view.agent)) return view
    if (!overlaid.includes(view.status)) return view
    if (view.wait_reason === 'approval' || view.wait_reason === 'input') return view
    return { ...view, wait_reason: 'quota' }
  })
}

/** 排序权重：等你确认置顶，其次是没点过的「刚完成」（PRD §5.3 / §7.1）。 */
function rank(record: SessionRecord): number {
  if (record.status === 'waiting') return 0
  if (record.status === 'done') return record.unread ? 1 : 4
  if (record.status === 'error') return 2
  if (record.status === 'running') return 3
  return 5
}

/** 把内部记录换算成界面用的视图，秒数按传入的 nowSec 现算。 */
export function toSessionViews(store: SessionStore, nowSec: number): SessionView[] {
  return Object.values(store)
    .map((record): SessionView => ({
      agent: record.agent,
      session_id: record.session_id,
      project: record.project,
      status: record.status,
      elapsed_sec: Math.max(0, nowSec - record.status_since),
      last_output_sec: Math.max(0, nowSec - record.last_output_at),
      unread: record.unread,
      updated_at: new Date(record.last_output_at * 1000).toISOString(),
      ...optional('cwd', record.cwd),
      ...optional('metrics', record.metrics),
      ...optional('reason', record.reason),
      ...optional('wait_reason', record.wait_reason),
      ...optional('title', record.title),
      ...optional('summary', record.summary),
      ...optional('activity', record.activity),
      ...optional('selfcheck', record.selfcheck),
      ...optional('human_error', record.human_error),
      ...optional('status_why', record.status_why),
      ...optional('formal_wait', record.formal_wait),
    }))
    .sort((a, b) => {
      const byRank = rank(store[sessionKey(a.agent, a.session_id)]!)
        - rank(store[sessionKey(b.agent, b.session_id)]!)
      if (byRank !== 0) return byRank
      if (a.elapsed_sec !== b.elapsed_sec) return b.elapsed_sec - a.elapsed_sec
      return a.session_id.localeCompare(b.session_id)
    })
}
