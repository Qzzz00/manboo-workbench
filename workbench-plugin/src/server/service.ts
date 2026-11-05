/**
 * 工作台内存服务：把会话状态机（sessions.ts）、响铃判定（ring.ts）和来源汇总
 * 拼成一份可随时查询的快照。
 *
 * 两条硬约束刻在这里：
 * - C1（PRD §4.1）：上游掉线只置 stale，绝不清空已知快照——看板宁可显示旧数据也不能空白。
 * - PRD §2.2：不落库、不起后台扫描器。状态全在内存，进程重启即丢，这是接受的代价。
 */
import type {
  AgentId,
  AgentView,
  QuotaEntry,
  SelfcheckView,
  SessionActivity,
  SessionMetrics,
  SessionView,
  WorkbenchEvent,
  WorkbenchState,
} from '../protocol.ts'
import { AGENT_IDS } from '../protocol.ts'
import type { RingLog, RingSignal } from './ring.ts'
import { collectRings } from './ring.ts'
import type { SessionStore } from './sessions.ts'
import {
  applyEvent as applyEventToStore,
  applyQuotaOverlay,
  emptySessionStore,
  markRead as markRecordRead,
  sessionKey,
  setDetail as setRecordDetail,
  setMetrics as setRecordMetrics,
  toSessionViews,
  pruneSessionStore,
} from './sessions.ts'

export interface WorkbenchServiceOptions {
  /** 当前 Unix 秒。测试传可控时钟，生产用真实时间。 */
  now?: () => number
  /**
   * 已读簿(2026-09-02 Ben 点名的待办;实现见 readMarks.ts)。
   *
   * 会话表只活在内存里是对的——会话随 agent 生灭,重启后各家 feed/hook 会重报一遍。
   * 但"我已经看过它了"是**用户的判断**,不该随进程蒸发:修之前每次重启,他早就看过的
   * 完成会话统统变回未读蓝点(applyEvent 里 `done` 一律置 unread=true),当天重启七八次,
   * 这条格外刺眼。
   *
   * **不传就是从前的行为**(既有调用方与测试零改动)。
   */
  readMarks?: {
    has: (agent: AgentId, sessionId: string) => boolean
    add: (agent: AgentId, sessionId: string) => void
  }
  /**
   * 「在等你」叠一层(2026-09-25,卡 T;waitingService.overlay):出视图时按「在等你 > 在跑 > 空闲」重摆状态、挂上 `ask`。
   * 不写进会话记录(同额度叠加)。**响铃不看它**:tick 用的是没叠过的视图(按内容判出来的在等你不响铃,规则写死的)。
   */
  overlay?: (views: readonly SessionView[], nowSec: number) => readonly SessionView[]
}

export interface WorkbenchService {
  /** 当前完整快照（GET /state 的响应体）。 */
  getState: () => WorkbenchState
  /**
   * 会话表**没叠过**的那一份(2026-09-25,卡 T):「在等你」按各家自己报的状态判,不能拿自己叠过的结果再判一遍。
   */
  rawSessions: () => SessionView[]
  /** 吃进一条上报。调用方负责校验字段合法性。 */
  applyEvent: (event: WorkbenchEvent) => void
  /** 标记「刚完成」已读。会话不存在返回 false，供 HTTP 层回 404。 */
  markRead: (agent: AgentId, sessionId: string) => boolean
  /**
   * 写一条会话行上的数字(DSH 会话的上下文/缓存命中/改了几个文件)。
   *
   * **刻意不触发广播**:这些数字每秒可能变几十次(投影随每条事件重算),
   * 每次都推一份 WS 快照就是自造风暴。界面本来就在 1 秒轮询 GET /state,
   * 下一拍自然带走——延迟最多一秒,换来的是零额外推送。
   */
  setSessionMetrics: (agent: AgentId, sessionId: string, metrics: SessionMetrics) => void
  /**
   * 补一条会话的标题 / 最近在做什么(2026-09-25,卡 P)。不建行、不动状态;返回「变了没有」
   * (变了调用方推一份快照 —— 标题与在做什么一两分钟才变一次,不是 metrics 那种每秒几十次)。
   */
  setSessionDetail: (agent: AgentId, sessionId: string, detail: { title?: string, activity?: SessionActivity, selfcheck?: SelfcheckView }) => boolean
  /** 上游（Agent 层）掉线：保留快照，只置 stale 并把已接入来源标成离线。 */
  markUpstreamOffline: () => void
  /** 走一拍响铃判定，返回这一拍该响的会话。 */
  tick: () => RingSignal[]
  /** 写入某来源的额度信息，未写入前一律是 unknown（界面据此标"未实测"）。 */
  setQuota: (agent: AgentId, entry: QuotaEntry) => void
  /**
   * 标记某一家「额度见底」(2026-09-09 傍晚拍板第 4 条)。由额度采集器调用——
   * 什么算见底是采集器的判断(quota/collector.ts 的 quotaExhausted),这里只记住结论。
   *
   * **不写进会话记录**:额度是会话之外的环境量,写进去就要有人负责在回血时清掉它,
   * 而那个"清"一定会漏。出视图时叠一层(applyQuotaOverlay),回血的下一拍自然消失。
   */
  setQuotaExhausted: (agent: AgentId, exhausted: boolean) => void
  /**
   * 会话表的版本号(8791 第六轮第 3 轮):每次会话表/额度被写就 +1,读侧(composeState 的
   * 按拍缓存)拿它当便宜的变化判据。可选 —— 假服务没有 = 缓存键退化成只看拍与引用。
   */
  version?: () => number
}

/** 单个来源的接入状态。connected 是"曾经接上过"，online 是"此刻还活着"。 */
interface AgentLiveness {
  connected: boolean
  online: boolean
}

function defaultNow(): number {
  return Math.floor(Date.now() / 1000)
}

/** 会话表多久收一次(秒)。一分钟:丢的是 7 天前的东西,不急。 */
export const SESSION_STORE_PRUNE_EVERY_SEC = 60

export function createWorkbenchService(options: WorkbenchServiceOptions = {}): WorkbenchService {
  const now = options.now ?? defaultNow

  let sessions: SessionStore = emptySessionStore()
  /** 上一次收会话表是几点(Unix 秒)。 */
  let lastPruneSec = now()
  let ringLog: RingLog = {}
  let upstreamOffline = false
  /** 此刻额度见底的那几家(见 setQuotaExhausted)。 */
  const quotaExhausted = new Set<AgentId>()
  const liveness: Record<AgentId, AgentLiveness> = Object.fromEntries(
    AGENT_IDS.map(id => [id, { connected: false, online: false }]),
  ) as Record<AgentId, AgentLiveness>
  const quota: Partial<Record<AgentId, QuotaEntry>> = Object.fromEntries(
    AGENT_IDS.map(id => [id, { kind: 'unknown' } satisfies QuotaEntry]),
  ) as Partial<Record<AgentId, QuotaEntry>>

  function agentViews(views: readonly SessionView[]): AgentView[] {
    return AGENT_IDS.map((id): AgentView => {
      const mine = views.filter(view => view.agent === id)
      return {
        id,
        connected: liveness[id].connected,
        online: liveness[id].online,
        waiting: mine.filter(view => view.status === 'waiting').length,
        running: mine.filter(view => view.status === 'running').length,
      }
    })
  }

  /**
   * **同一拍只算一份**(2026-10-21 急修「8791 空转」)。一次 `/state` 里派活对象表、登记表、「在等你」各自回头问会话表,
   * 每家 × 每条会话 × 再问一次,每次都连「在等你」那一层重算 —— 真机采样里这一处占了组装 `/state` 的一半。
   * 复用的条件:同一段同步执行(下一个微任务就作废,异步判完的「在等你」下一拍看得见)、同一秒、中间没改过会话表。
   * 拿到的那一份大家共用,调用方一律只读(全仓都是展开 / map / filter 的写法)。
   */
  let memo: { nowSec: number, version: number, state: WorkbenchState } | undefined
  let version = 0
  function touched(): void {
    version += 1
    memo = undefined
  }
  return {
    version() { return version },
    getState() {
      const nowSec = now()
      if (memo !== undefined && memo.nowSec === nowSec && memo.version === version) return memo.state
      // 先叠「在等你」、再叠额度:在等他的会话挂上「等你输入 / 等审批」之后,额度那一层不盖它(applyQuotaOverlay 的第 1 条边界)。
      const base = toSessionViews(sessions, nowSec)
      const views = applyQuotaOverlay(options.overlay === undefined ? base : options.overlay(base, nowSec), quotaExhausted)
      const state: WorkbenchState = {
        agents: agentViews(views),
        sessions: [...views],
        quota,
        now: new Date(nowSec * 1000).toISOString(),
        // 一个来源都没接入过时不算"掉线"，那是"还没开始"，界面不该报警。
        stale: upstreamOffline && AGENT_IDS.some(id => liveness[id].connected),
      }
      const mine = { nowSec, version, state }
      memo = mine
      queueMicrotask(() => { if (memo === mine) memo = undefined })
      return state
    },

    rawSessions() {
      return toSessionViews(sessions, now())
    },

    applyEvent(event) {
      touched()
      sessions = applyEventToStore(sessions, event, now(), options.readMarks?.has)
      liveness[event.agent] = { connected: true, online: event.type !== 'offline' }
      // 收到任何上报都说明上游还活着。
      upstreamOffline = false
    },

    markRead(agent, sessionId) {
      if (!(sessionKey(agent, sessionId) in sessions)) return false
      touched()
      sessions = markRecordRead(sessions, agent, sessionId)
      // 落进已读簿,下次重启才认得(见 WorkbenchServiceOptions.readMarks 的理由)。
      options.readMarks?.add(agent, sessionId)
      return true
    },

    setSessionMetrics(agent, sessionId, metrics) {
      touched()
      sessions = setRecordMetrics(sessions, agent, sessionId, metrics)
    },

    setSessionDetail(agent, sessionId, detail) {
      const next = setRecordDetail(sessions, agent, sessionId, detail)
      if (next === sessions) return false
      touched()
      sessions = next
      return true
    },

    markUpstreamOffline() {
      // C1：只翻标志位，sessions 一个字节都不动。
      touched()
      upstreamOffline = true
      for (const id of AGENT_IDS) {
        if (liveness[id].connected) liveness[id].online = false
      }
    },

    tick() {
      const nowSec = now()
      /**
       * 收一次会话表(2026-10-19):一分钟一次,结束了的会话超过 7 天 / 每家超过 200 条的丢。
       * 挂在这根既有的 1 秒节拍上;响铃判定在它后面,所以丢掉的都是本来就不会响的。
       */
      if (nowSec - lastPruneSec >= SESSION_STORE_PRUNE_EVERY_SEC) {
        lastPruneSec = nowSec
        const pruned = pruneSessionStore(sessions, nowSec)
        if (pruned !== sessions) { touched(); sessions = pruned }
      }
      // **响铃判定不看额度叠加**(拍板第 4 条:响铃规则不变)。ring.ts 只认
      // waiting + permission_prompt,叠不叠 wait_reason 都影响不到它;
      // 这里直接用未叠加的视图,免得日后有人误以为额度能改变响不响。
      const result = collectRings(toSessionViews(sessions, nowSec), ringLog, nowSec)
      ringLog = result.ringLog
      return result.rings
    },

    setQuota(agent, entry) {
      touched()
      quota[agent] = entry
    },

    setQuotaExhausted(agent, exhausted) {
      touched()
      if (exhausted) quotaExhausted.add(agent)
      else quotaExhausted.delete(agent)
    },
  }
}
