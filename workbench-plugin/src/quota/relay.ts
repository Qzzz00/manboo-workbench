/**
 * 走工作台中转时,DeepSeek 那一格说的是什么(2026-09-18)。
 *
 * ## 为什么必须有这一层
 *
 * Ben 09-18 真机:清空凭据之后面板上还挂着「¥ 2.26 · 今日 2.26」。查下来他那台机器上
 * `model.json` 是 `mode:'relay'` 且**已经领到令牌**(真正在花的是工作台的中转),
 * 而 `~/.dsh/.env` 里还留着一把私人 DeepSeek Key —— 采集循环拿它去问官方余额,
 * 于是屏幕上那笔钱既不是中转的用量,也不是他此刻在花的账户。
 *
 * 所以规矩是**走中转就一次都不问官方余额**:不是"优先显示中转",是那条路整个不走。
 * 只要还去问一次,那个数字就会在某个分支里漏到界面上(这次就是这么漏的)。
 *
 * ## 为什么用窗口型而不是新造一种 kind
 *
 * 展示台有自己一份协议副本(`display-client/src/holo/workbenchProtocol.ts`),它对
 * `QuotaEntry` 只认 unknown / balance / quota 三种;多一种 kind 会让它走进
 * "当成窗口型去读 windows"的分支。中转给的是「今日上限 / 今日已用」——**有分母**,
 * 天然就是一条窗口:`{ label: '今日', left_pct: 剩余 }`,展示台照现有代码画出来就是对的。
 */
import type { QuotaEntry } from '../protocol.ts'

/** 中转那边的今日用量。形状同 `/model` 的 usage(server/modelConfig.ts),这里只读不写。 */
export interface RelayUsage {
  day: string
  used_tokens: number
  daily_token_limit: number
  remaining_tokens: number
  /** 2026-09-23 起中转按元算额度;老中转没有这三格,那时回退按 token 算。 */
  used_cny?: number
  daily_cost_limit_cny?: number
  remaining_cny?: number
}

/** 取一次用量的结果。**失败不抛**:取不到只是"今天看不到",要在界面上说清原因。 */
export type RelayUsageResult =
  | { ok: true, usage: RelayUsage }
  | { ok: false, error: string }

/**
 * 采集循环每轮现读一次的「此刻走不走中转」。
 *
 * `ready` 的定义跟设置里那一节完全一致(modelConfig.ts 的 `modelEndpointOf`):
 * **mode 是 relay 且已经领到令牌**。只写着 relay 却没领到令牌时不算 —— 那种状态下
 * 他其实一条请求都发不出去,面板该说的是"还没接上",不是"用量 0"。
 */
export interface RelayView {
  ready: boolean
  /** 取今日用量。`ready` 为真时才会被调用;不给就当"计量还没接线"。 */
  usage?: () => Promise<RelayUsageResult>
}

/** 中转那条窗口的标签。整家共用(relay 下只有这一条路),见 collector.ts 的见底判据。 */
export const RELAY_WINDOW_LABEL = '今日'

/** 一句前缀,三条分支共用 —— 界面上这一格必须一眼看出"这说的是工作台的服务"。 */
const PREFIX = '工作台提供的服务'

/**
 * 中转用量 → 那一格。
 *
 * 三条分支都**不编数**(D13):
 * - 取到了、也有今日上限 → 一条窗口,`left_pct` 是**剩余**(条长＝剩余,跟别家同向);
 * - 取到了但没有今日上限 → 算不出"还剩多少",如实说算不出,不拿 0 或 100 充数;
 * - 取不到 → 把中转给的那句原因原样带上(它已经是人话了,见 fetchRelayUsage)。
 */
export function relayQuotaEntry(result: RelayUsageResult): QuotaEntry {
  if (!result.ok) {
    return { kind: 'unknown', note: `${PREFIX} · 今日用量还没接上(${result.error})` }
  }

  // 中转说了元就按元(额度就是按它拦的);老中转回退按 token。
  const byCny = result.usage.daily_cost_limit_cny !== undefined
  const limit = byCny ? result.usage.daily_cost_limit_cny ?? 0 : result.usage.daily_token_limit
  const remaining = byCny ? result.usage.remaining_cny ?? 0 : result.usage.remaining_tokens
  if (!Number.isFinite(limit) || limit <= 0) {
    return { kind: 'unknown', note: `${PREFIX} · 中转没说今日上限,算不出还剩多少` }
  }

  // 用超了会回负数;界面上一个 -12% 只会让人以为程序坏了,夹到 0~100。
  const left = Math.round((Math.max(0, remaining) / limit) * 100)
  return { kind: 'quota', windows: [{ label: RELAY_WINDOW_LABEL, left_pct: Math.min(100, left) }] }
}

export interface RelayViewDeps {
  /** `~/.dsh/workbench/model.json` 的内容;读不到回 undefined(**不抛**)。 */
  readModelFile: () => Promise<string | undefined>
  /** 真正去问中转。注入的是 modelConfig.ts 的 fetchRelayUsage,测试注桩。 */
  fetchUsage: (options: { relayUrl: string, token: string }) => Promise<RelayUsageResult>
}

interface RawModel {
  mode?: unknown
  relay_url?: unknown
  relay_token?: unknown
}

/**
 * 现读一次 model.json,回一份「此刻走不走中转」。
 *
 * **只读、不建、不校验**(同 server/modelMode.ts 那条注释):这个文件归模型服务那张卡所有。
 * 读坏了 / 没有文件 → `ready:false`,照官方余额那条老路走 —— 它是"还没配过"的真实状态。
 *
 * 令牌只在这个函数里停留一下,不进日志、不进返回值、不进 /state(AGENTS.md 的凭据纪律)。
 */
export async function readRelayView(deps: RelayViewDeps): Promise<RelayView> {
  let raw: RawModel
  try {
    const text = await deps.readModelFile()
    if (text === undefined) return { ready: false }
    const parsed = JSON.parse(text) as unknown
    if (typeof parsed !== 'object' || parsed === null) return { ready: false }
    raw = parsed as RawModel
  }
  catch {
    return { ready: false }
  }

  // mode 缺省是 relay(modelConfig.ts 的 parseModelConfig 同样这么读:默认就用我们的服务),
  // 但**没领到令牌就不算 ready** —— 那时候官方余额那条路也还轮不到,见 RelayView 的注释。
  const relay = raw.mode !== 'own'
  const token = typeof raw.relay_token === 'string' && raw.relay_token.trim() !== '' ? raw.relay_token.trim() : undefined
  if (!relay || token === undefined) return { ready: false }

  const url = typeof raw.relay_url === 'string' && raw.relay_url.trim() !== ''
    ? raw.relay_url.trim().replace(/\/+$/, '')
    : undefined
  if (url === undefined) return { ready: false }

  return {
    ready: true,
    usage: () => deps.fetchUsage({ relayUrl: url, token }),
  }
}
