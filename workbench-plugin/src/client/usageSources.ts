/**
 * 「消耗数据」那一格(运营模板那一版面板 `client/air/usage.js`)**摆哪几家工具**。
 *
 * ★ 2026-10-03 维护者原话:「我看到他的现在消耗数据应该是他机器的,不是我的……
 * 消耗数据都是写死的,显示哪些模型也是写死的,这个我们自己先修。」
 *
 * 他那一版面板里这一行是写死的:
 *
 * ```js
 * const sources=[{id:"dsh",name:"DeepSeek",…},{id:"codex",name:"Codex",…}]
 * ```
 *
 * 写死的后果不是"数字是假的"(数本来就来自 `/state.usage`),而是**这台机器上真有、
 * 采集器真数过的那几家,少掉的那几家连格子都没有** —— 维护者机器上采集器名册是
 * `claude` / `codex` / `dsh`(见 `usage/collector.ts` 的 `sources`),他那一格只摆了后两家,
 * 于是 Claude 那一整份用量在界面上**压根不存在**。这正是「每一个人电脑装的东西都不一样,
 * 千万不能写死」(维护者 2026-09-25,见 protocol.ts `agent_registry` 那一段)。
 *
 * 所以名册**由数据说了算**:`/state.usage.sources` 的键(= 采集器这一轮真的去数过的那几家)
 * 为准,再并上只在 `days[].by_source` 里出现过的那几家(采集器名册里没有、可是历史数里有)。
 * 读不到用量(`{ error }` / 缺席)时**一家都不摆** —— 那时候我们连"这台机器上有哪几家"
 * 都不知道,摆一排「未接入」是编出来的名册。
 *
 * **这个文件不放在 `air/` 里**:`air/` 那六份是他交来的原件(只做过机械替换),
 * 这一份是我们写的。
 */
import type { UsageState } from '../protocol.ts'
import { AGENT_IDS, type AgentId } from '../protocol.ts'
import { label } from './sessionFeed.ts'

/**
 * 工作台本体的点缀色令牌(`client/neutralStyle.ts` 把它重定义成主文字色)。
 * 2026-10-03 维护者:「这个紫色的点缀色真是太丑了」—— 他那一格 DeepSeek 原来是 `#9d94f4`。
 */
export const USAGE_ACCENT_COLOR = 'var(--dsw-alias-state-business-primary)'

/**
 * 认得的那几家各自一个颜色。**不是写死名册** —— 名册由数据给,这里只回答"这一家画什么色"。
 * 除了 DeepSeek 那一个紫换成点缀色令牌,其余三个都是他自己那一版里用过的值。
 */
const COLORS: Readonly<Record<string, string>> = {
  dsh: USAGE_ACCENT_COLOR,
  codex: '#4ebbb1',
  claude: '#d18db0',
  kimi: '#52ada9',
}

/** 认不出是哪一家时按出现顺序轮着取(同样都是他那一版里用过的值)。 */
const SPARE_COLORS: readonly string[] = ['#d2ad72', '#52ada9', '#4ebbb1', '#d18db0']

/**
 * 那一格底下那行小字:**这一家的数是从哪儿数出来的**。
 * 一家一句,照 `usage/collector.ts` 里真正扫的东西写;认不出的那一家**不编一句**(缺席)。
 */
const NOTES: Readonly<Record<string, string>> = {
  dsh: '工作台会话',
  codex: '本机 Codex 日志',
  claude: '本机 Claude 会话日志',
  kimi: '本机 Kimi 日志',
}

export interface AirUsageSource {
  /** `/state.usage.sources` 的键,同时是 `days[].by_source` 的键。 */
  id: string
  /** 界面上那几个字。认得的那几家走本体那一份名字表(`client/sessionFeed.ts` 的 `label`)。 */
  name: string
  color: string
  /** 数据从哪儿来的那一句。认不出的那一家缺席 —— 不编。 */
  note?: string
}

function isAgentId(id: string): id is AgentId {
  return (AGENT_IDS as readonly string[]).includes(id)
}

/**
 * 这台机器此刻**真有数**的那几家,按采集器名册的顺序。
 *
 * 顺序:先 `usage.sources` 的键序(采集器自己的顺序,稳定),再补只在 `days` 里出现过的。
 * 去重按 id。
 */
export function airUsageSources(
  usage: UsageState | { error: string } | undefined,
): readonly AirUsageSource[] {
  if (usage === undefined || 'error' in usage) return []
  const ids: string[] = []
  const push = (id: string): void => { if (!ids.includes(id)) ids.push(id) }
  for (const id of Object.keys(usage.sources ?? {})) push(id)
  for (const day of usage.days ?? []) for (const id of Object.keys(day.by_source ?? {})) push(id)
  return ids.map((id, index) => {
    const note = NOTES[id]
    return {
      id,
      name: isAgentId(id) ? label(id) : id,
      color: COLORS[id] ?? SPARE_COLORS[index % SPARE_COLORS.length] ?? USAGE_ACCENT_COLOR,
      ...(note === undefined ? {} : { note }),
    }
  })
}
