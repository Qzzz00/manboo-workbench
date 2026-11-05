/**
 * 会话区的纯数据投影：排序、分组、灯色、额度摘要，以及读快照时的降级。
 *
 * 逻辑都放在这里而不是组件里，是为了能单独测——尤其"服务挂了界面不能白屏"（架构约束 C1）
 * 这种事，靠肉眼在浏览器里看是验不住的。
 */
import type {
  AgentEntryView, AgentId, AgentSessionView, AgentView, QuotaEntry, SessionMetrics, SessionView, WorkbenchState,
} from '../protocol.ts'
import { AGENT_IDS } from '../protocol.ts'

/** 状态的排序权重：等你确认最急，其次刚完成（未读要被看见），最后在跑。 */
const STATUS_RANK: Record<string, number> = {
  waiting: 0,
  done: 1,
  running: 2,
  error: 3,
  offline: 4,
}

/** 等你确认置顶；同档内等得越久越靠前。 */
export function sortSessions<T extends Pick<SessionView, 'status' | 'elapsed_sec'>>(sessions: readonly T[]): T[] {
  return [...sessions].sort((left, right) => {
    const byStatus = (STATUS_RANK[left.status] ?? 9) - (STATUS_RANK[right.status] ?? 9)
    if (byStatus !== 0) return byStatus
    return right.elapsed_sec - left.elapsed_sec
  })
}

export interface AgentGroup {
  /** 登记表里的 id。 */
  agent: string
  /** 登记表里的名字。 */
  name: string
  /** 这一家的颜色(登记表里的,从它 App 图标来;卡 Q)。老服务端没给就缺席。 */
  color?: string
  sessions: readonly AgentSessionView[]
  waiting: number
  running: number
}

/**
 * 按 agent 分组(PRD §5.3:分组维度是 agent,不是项目)。**哪几家 = Agent 登记表里接上了的那几家**(2026-09-25,卡 Q),
 * 不再是写死的四家:新发现的一家接上就多一组,他说「这不是 Agent」就少一组。
 * 接上了、此刻没会话的那家也出现(组头折叠成一行灰字)—— 空着比消失好。
 */
export function groupByAgent(entries: readonly (Pick<AgentEntryView, 'id' | 'name' | 'sessions'> & { color?: string })[]): AgentGroup[] {
  return entries.map((entry) => {
    const mine = sortSessions(entry.sessions)
    return {
      agent: entry.id,
      name: entry.name,
      ...(entry.color === undefined ? {} : { color: entry.color }),
      sessions: mine,
      waiting: mine.filter(session => session.status === 'waiting').length,
      running: mine.filter(session => session.status === 'running').length,
    }
  })
}

export type LampColor = 'teal' | 'amber' | 'red' | 'blue' | 'off'

/** 顶条灯色：有等待=黄，纯在跑=绿，离线或无会话=灰。 */
export function agentLamp(agent: AgentView): LampColor {
  if (!agent.online) return 'off'
  if (agent.waiting > 0) return 'amber'
  if (agent.running > 0) return 'teal'
  return 'off'
}

/** 单条会话的左侧色条。 */
export function sessionLamp(session: Pick<SessionView, 'status'>): LampColor {
  if (session.status === 'waiting') return 'red'
  if (session.status === 'done') return 'blue'
  if (session.status === 'running') return 'teal'
  return 'off'
}

/** 一条额度的短摘要。窗口型只报最紧那条，避免顶条被堆满。 */
function entrySummary(agent: AgentId, entry: QuotaEntry): string {
  if (entry.kind === 'balance') {
    return entry.available ? `${label(agent)} ¥${entry.total}` : `${label(agent)} 不可用`
  }
  if (entry.kind === 'quota') {
    const tightest = [...entry.windows].sort((a, b) => a.left_pct - b.left_pct)[0]
    return tightest === undefined ? '' : `${label(agent)} ${tightest.label} ${tightest.left_pct}%`
  }
  // unknown：取数方式待实测。绝不用 0 冒充——0 会被读成"额度耗尽"。
  return ''
}

const LABELS: Record<AgentId, string> = {
  dsh: 'DeepSeek',
  claude: 'Claude',
  codex: 'Codex',
  kimi: 'Kimi',
}

export function label(agent: AgentId): string {
  return LABELS[agent]
}

/** 顶条那行额度提词（PRD §5.1：这里只作提词，展示台上才是大模块）。 */
export function quotaSummary(quota: Partial<Record<AgentId, QuotaEntry>>): string {
  // 卡 HC(2026-09-27):**只念 quota 里真有的那几家**。服务端已经按探测把这份筛过了
  // (没装的一家连额度格都没有),照 AGENT_IDS 遍历等于把写死的四家又请回来一遍。
  // 顺序仍按 AGENT_IDS 里出现过的那几个排,免得每一拍抖一次。
  return AGENT_IDS
    .flatMap((agent) => {
      const entry = quota[agent]
      return entry === undefined ? [] : [entrySummary(agent, entry)]
    })
    .filter(text => text !== '')
    .join(' · ')
}

/**
 * 服务读不到时用的兜底快照。
 *
 * 架构约束 C1：Agent 层挂掉时看板必须继续显示并明示"Agent 掉线"，
 * 不允许"AI 一卡，整个桌面就死"。所以这里返回 stale 快照而不是抛错。
 */
export function offlineState(): WorkbenchState {
  return {
    /**
     * **一家都不编**(2026-09-27,卡 HC)。原来这里造四条 `connected:false` 的假行 ——
     * 服务都读不到,凭什么知道这台电脑上装着 Claude 和 Kimi?维护者在只装了豆包办公与 Codex 的
     * 全新 Air 上看到的那两家,一部分就是从这类占位里来的。空着就是真话:
     * 界面本来就会打出「Agent 掉线」(架构约束 C1 要的是看板别死,不是凑几行出来)。
     */
    agents: [],
    sessions: [],
    quota: {},
    now: new Date().toISOString(),
    stale: true,
  }
}

/** 读一次 GET /state。任何失败都降级成 stale 快照，绝不把异常抛给界面。 */
export async function fetchState(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<WorkbenchState> {
  try {
    const res = await fetchImpl(`${baseUrl}/state`)
    if (!res.ok) return offlineState()
    return await res.json() as WorkbenchState
  } catch {
    return offlineState()
  }
}

/** 标记「刚完成」已读。失败静默——这是个便利操作，不值得打断用户。 */
export async function markRead(
  baseUrl: string,
  agent: AgentId,
  sessionId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const res = await fetchImpl(`${baseUrl}/read`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent, session_id: sessionId }),
    })
    return res.ok
  } catch {
    return false
  }
}

/**
 * 会话区点击激活应传给哪个 app（PRD §5.3 深链退化路径）。
 * 各家映射自己(登记表 id);dsh 是工作台自身，行上无独立可激活的 app，返回 null。
 */
export function activationTarget(agent: string): string | null {
  return agent === 'dsh' ? null : agent
}

export interface ChipView {
  app: string
  label: string
  /** null＝未接入（badges 里缺省该 key 或显式 null），0＝已接入但无消息，>0＝原样显示。 */
  value: number | null
}

const PEOPLE_APPS: readonly { app: string, label: string }[] = [
  { app: 'wechat', label: '微信' },
  { app: 'wecom', label: '企业微信' },
]

/**
 * 「人找我」两家角标（spec §3：微信/企业微信），由 GET /state 的 badges 驱动。
 * 微信双开假设作废：不另列一个「微信2」chip——点它会去激活一个不存在的应用，白白报错。
 * 点这两枚一律按包标识拉起（`apps.ts`），不假定 App 在这台机器上叫什么。
 */
export function peopleChips(badges: Record<string, number | null | undefined>): ChipView[] {
  return PEOPLE_APPS.map(({ app, label }) => ({ app, label, value: badges[app] ?? null }))
}

/**
 * 上下文 token 数说成人话:8805 → 8.8k、125400 → 125k。
 * 上万之后不留小数——那一位在会话行上只是噪音,一眼看的是量级。
 */
export function humanTokens(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return ''
  if (tokens >= 10_000) return `${Math.round(tokens / 1000)}k`
  return `${(Math.round(tokens / 100) / 10).toFixed(1)}k`
}

/**
 * 会话行上的三个数字,按固定顺序排成几段(2026-09-09,目前只有 DSH 会话有)。
 *
 * **拿不到的那个整段不出现**:0、占位、「未知」都会被读成一个有意义的数值
 * (「缓存命中 0%」= 一次没命中,而真相往往是还没有可判断的请求)。取数与实测形状见
 * docs/superpowers/research/2026-09-09-DSH会话投影可读性.md。
 */
export function metricParts(metrics: SessionMetrics | undefined): string[] {
  if (metrics === undefined) return []
  const parts: string[] = []
  if (typeof metrics.context_tokens === 'number' && metrics.context_tokens > 0) {
    parts.push(`上下文 ${humanTokens(metrics.context_tokens)}`)
  }
  if (typeof metrics.cache_hit_pct === 'number') parts.push(`缓存命中 ${metrics.cache_hit_pct}%`)
  if (typeof metrics.files_changed === 'number' && metrics.files_changed > 0) {
    parts.push(`改了 ${metrics.files_changed} 个文件`)
  }
  return parts
}

/** 把秒数说成人话：4 分 12 秒 / 12 分钟 / 2 小时 8 分。 */
export function humanDuration(sec: number): string {
  if (sec < 60) return `${Math.max(0, Math.floor(sec))} 秒`
  const minutes = Math.floor(sec / 60)
  if (minutes < 60) {
    const rest = Math.floor(sec % 60)
    return rest === 0 ? `${minutes} 分钟` : `${minutes} 分 ${rest} 秒`
  }
  const hours = Math.floor(minutes / 60)
  const restMin = minutes % 60
  return restMin === 0 ? `${hours} 小时` : `${hours} 小时 ${restMin} 分`
}
