/**
 * 通话的每回合计时,最近 20 条(2026-09-23,Ben 真机:「延迟有点高」)。
 *
 * **真相在工人那边**,这儿只是个转手的柜台:工人每收一回合往 `POST /channel/latency`
 * 报一条(channel-worker/src/latency.ts 算的),这里留最近 {@link LATENCY_KEEP} 条,
 * 好让体检页和统筹有东西可看 —— 8791 自己不进房,量不到任何一段。
 *
 * 三条纪律,和在线设备表(deviceDirectory.ts)同源:
 *
 *   ① **只存工人报上来的**。路由那一层把门:写只认回环,读给本机与已配对的设备。
 *   ② **没测到的那一段是 `null`,不是 0**。这是整张卡最要紧的一条 ——
 *      卡上那句「不编数」在代码里唯一能被机器检查的形式就是它。
 *      所以 `parseTurnLatency` 遇到读不懂的值一律落成 null,**绝不补一个 0**。
 *   ③ **只在内存里**。它是给人看的最近记录,不是账本;8791 重启就该从头来。
 *
 * 纯数据结构,不认识 http、不认识 node —— 单测直接跑。
 */

/** 留最近几条。与 channel-worker/src/latency.ts 的 `LATENCY_KEEP` 同一个数。 */
export const LATENCY_KEEP = 20

/** 成绩单里那几段的字段名。**顺序就是一回合里发生的顺序**,体检页按它排列。 */
export const LATENCY_SEGMENTS = [
  'asr_ms',
  'commit_ms',
  'llm_first_ms',
  'llm_gen_ms',
  'tts_first_ms',
  'publish_ms',
  'tts_all_ms',
  'mouth_ms',
  'total_ms',
] as const

export type LatencySegment = typeof LATENCY_SEGMENTS[number]

/**
 * 一回合走的哪条路(2026-09-23,channel-worker/src/turnRoute.ts):
 * `chat` = 那一回合没带工具、也没垫缓冲语;`act` = 带了全套工具、垫了场。
 */
export const LATENCY_ROUTES = ['chat', 'act'] as const
export type LatencyRoute = typeof LATENCY_ROUTES[number]

/**
 * 一回合。形状与工人那边的 `TurnLatency` 一字不差。
 *
 * `route` / `router` 是 2026-09-23 加的两格,**可以缺席** —— 缺席就是「这一回合没判过」
 * (开场白那种没有识别结果的),不是「按闲聊走」。老工人报上来的没有这两格,照收。
 */
export type TurnLatency = { round: number, at: number, route?: LatencyRoute, router?: string, filler?: true }
  & Record<LatencySegment, number | null>

/** 人话名字。体检页与将来的诊断包都用它,免得两处各写一套。 */
export const LATENCY_SEGMENT_TITLES: Record<LatencySegment, string> = {
  asr_ms: '识别',
  commit_ms: '判停',
  llm_first_ms: '模型首字',
  llm_gen_ms: '模型说完',
  tts_first_ms: '合成首句',
  publish_ms: '发包',
  tts_all_ms: '合成全程',
  mouth_ms: '首字到出声',
  total_ms: '停说到出声',
}

/** 读得懂就是那个数,读不懂就是 null。**负数也算读不懂** —— 时钟倒过来的数没有意义。 */
function msOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : null
}

/**
 * 工人报上来的一条 → 一条成绩单。形状不对回 `undefined`(由路由回 400),
 * **绝不猜一条出来**:一条编的延迟比没有延迟更害人。
 *
 * `round` 与 `at` 是仅有的两个必填项:没有它们这条记录既排不了序也认不出是哪一回合。
 */
export function parseTurnLatency(value: unknown): TurnLatency | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const row = value as Record<string, unknown>
  const round = msOf(row.round)
  const at = msOf(row.at)
  if (round === null || at === null || at === 0) return undefined
  const segments = {} as Record<LatencySegment, number | null>
  for (const name of LATENCY_SEGMENTS) segments[name] = msOf(row[name])
  // 分流那两格:**认得的才留,读不懂就当没有**(和「没测到写 null」同一条纪律 ——
  // 这里的「没有」比「猜一个 act」诚实)。
  const route = typeof row.route === 'string' && (LATENCY_ROUTES as readonly string[]).includes(row.route)
    ? row.route as LatencyRoute
    : undefined
  const router = typeof row.router === 'string' && row.router.trim() !== '' ? row.router.trim().slice(0, 24) : undefined
  return {
    round,
    at,
    ...(route === undefined ? {} : { route }),
    ...(router === undefined ? {} : { router }),
    // 这一回合工人垫过一句(2026-09-23 晚):`speaking` 那一刻是垫场出声,不是真声 —— 读的人要分得清。
    ...(row.filler === true ? { filler: true as const } : {}),
    ...segments,
  }
}

/** 那两格的人话。 */
export const LATENCY_ROUTE_TITLES: Record<LatencyRoute, string> = {
  chat: '闲聊(没带工具)',
  act: '办事(带了工具)',
}

/**
 * 一条能直接念出来的摘要。体检页上那一行就是它。
 *
 * **没量到就说「没量到」**,不显示 0 —— 屏幕上一个「0ms」会让人以为这一段不花时间,
 * 而真相是这一回合没测到(工人关了计时、或者那一段根本没发生)。
 */
export function latencySummary(rows: readonly TurnLatency[]): string {
  const latest = rows[0]
  if (latest === undefined) return '还没有量到过通话延迟(打一通电话就有了)。'
  const parts = (['total_ms', 'mouth_ms', 'tts_first_ms'] as const).map((name) => {
    const value = latest[name]
    return `${LATENCY_SEGMENT_TITLES[name]} ${value === null ? '没量到' : `${value}ms`}`
  })
  // 这一回合是闲聊还是办事(2026-09-23):**两种回合的延迟不该放在一起读** ——
  // 闲聊回合没带工具,模型首字本来就该短;不写出来,体检页上那一行就说不清省下来的是哪一秒。
  const how = latest.route === undefined
    ? ''
    : ` · ${LATENCY_ROUTE_TITLES[latest.route]}${latest.router === undefined ? '' : `,${latest.router} 判的`}`
  return `最近一回合(共 ${rows.length} 条):${parts.join(' · ')}${how}`
}

export interface ChannelLatencyStore {
  /** 工人报一条。形状不对回 undefined —— 路由据此回 400,不静默丢掉。 */
  add: (value: unknown) => TurnLatency | undefined
  /** 最近的在前。回的是拷贝。 */
  recent: () => readonly TurnLatency[]
}

export function createChannelLatencyStore(keep: number = LATENCY_KEEP): ChannelLatencyStore {
  const limit = Number.isFinite(keep) && keep >= 1 ? Math.floor(keep) : LATENCY_KEEP
  let rows: TurnLatency[] = []
  return {
    add(value) {
      const row = parseTurnLatency(value)
      if (row === undefined) return undefined
      rows.push(row)
      if (rows.length > limit) rows = rows.slice(-limit)
      return row
    },
    recent() {
      return [...rows].reverse()
    },
  }
}
