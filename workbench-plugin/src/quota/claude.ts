/**
 * Claude Code 额度采集（PRD §8.2）。
 *
 * Claude Code ≥2.1.x 会把额度随 statusLine 的 stdin JSON 一起交出来（官方文档 statusline 一节）：
 *
 * ```json
 * "rate_limits": {
 *   "five_hour": { "used_percentage": 23.5, "resets_at": 1738425600 },
 *   "seven_day": { "used_percentage": 41.2, "resets_at": 1738857600 }
 * }
 * ```
 *
 * 这条路是**推送**：Claude Code 主动把数据喂给 statusLine 命令，工作台不轮询、不读凭据、
 * 不调未公开接口。社区另有 `api.anthropic.com/api/oauth/usage` 那条 OAuth 路子，本项目不走——
 * 它未公开、随时会变，且要动 `~/.claude` 里的凭据，与"不展示或写入 Token"的约束贴得太近。
 *
 * 本文件只负责解析，不负责传输：statusLine 脚本把整份 stdin POST 到本地服务，
 * 服务端调用 parseClaudeStatusLine 存成最后已知值。
 */
import type { QuotaWindow, WindowQuota } from '../protocol.ts'

/** statusLine 的窗口名 → 界面标签。顺序即展示顺序：短窗口在前。 */
const WINDOWS: readonly (readonly [string, string])[] = [
  ['five_hour', '5h'],
  ['seven_day', '周'],
]

/**
 * 「已用百分比」翻成界面要的「剩余百分比」。
 *
 * 单独抽出来是因为拉取那条路（claudeDesktop.ts）拿到的也是"已用"，两条路必须用同一套
 * 换算和取整——否则同一个窗口在推送和拉取之间会差个零点几，看起来像数字在跳。
 */
export function windowFromUsedPercentage(
  used: number,
  label: string,
  resetsAtSeconds?: number,
): QuotaWindow {
  // 先乘再除，避免 100 - 41.2 留下 58.799999999999994 这种尾巴。
  const left = Math.round((100 - used) * 10) / 10
  return {
    label,
    left_pct: Math.min(100, Math.max(0, left)),
    ...(typeof resetsAtSeconds === 'number'
      ? { reset_at: new Date(resetsAtSeconds * 1000).toISOString() }
      : {}),
  }
}

function readWindow(value: unknown, label: string): QuotaWindow {
  const record = value as Record<string, unknown>
  const used = record.used_percentage
  // 字段在但不是数字，说明形状变了。宁可抛错标"未接入"，也不猜一个数出来。
  if (typeof used !== 'number' || !Number.isFinite(used)) {
    throw new Error(`Claude 额度窗口 ${label} 的 used_percentage 不是数字`)
  }

  return windowFromUsedPercentage(
    used,
    label,
    typeof record.resets_at === 'number' ? record.resets_at : undefined,
  )
}

/**
 * 从 statusLine 的 stdin JSON 里取出额度。
 *
 * 只取 rate_limits，payload 里的 transcript_path、session 内容等一概不带走——
 * 这份数据会推给展示台，展示台不该拿到会话内容。
 */
export function parseClaudeStatusLine(payload: unknown, at?: Date): WindowQuota {
  if (typeof payload !== 'object' || payload === null) throw new Error('statusLine 数据不是对象')

  const limits = (payload as Record<string, unknown>).rate_limits
  if (typeof limits !== 'object' || limits === null) {
    throw new Error('statusLine 数据里没有 rate_limits：需要 Claude Code 2.1 及以上并配置 statusLine')
  }

  const record = limits as Record<string, unknown>
  const windows = WINDOWS
    .filter(([key]) => typeof record[key] === 'object' && record[key] !== null)
    .map(([key, label]) => readWindow(record[key], label))

  if (windows.length === 0) throw new Error('statusLine 的 rate_limits 里没有可用窗口')

  /**
   * `as_of` = **收到这一份的时刻**(2026-10-02,卡 QA)。推送是实时的,所以这里就是这一刻 ——
   * 但它必须写下来:这一份会落盘(quota/persist.ts),重启之后顶回界面时可能已经几天前了
   * (真机 `~/.dsh/workbench/last-quota.json` 2026-09-26 22:10 那一份挂到了 10-02)。
   * 时刻由调用方给,不在这里 `new Date()` —— 那样用例钉不住。
   */
  return {
    kind: 'quota',
    windows,
    ...(at === undefined ? {} : { as_of: at.toISOString() }),
    source: CLAUDE_STATUSLINE_SOURCE,
  }
}

/** 这个数哪来的(界面上「截至 04:27」旁边那半句)。 */
export const CLAUDE_STATUSLINE_SOURCE = 'Claude Code 状态栏报上来的'
