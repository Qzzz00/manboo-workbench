import type { UsageRecord } from './types.ts'

/**
 * Kimi 命令行与桌面版本机 Agent 的 wire 用量(2026-10-27 重新接上,任务书
 * `docs/任务书-Kimi用量接进消耗面板-2026-10-27.md`)。
 *
 * 数据源是两棵 layout 相同的树:
 * - 命令行:`~/.kimi-code/sessions/<wd_xxx>/<session_xxx>/agents/<agent>/wire.jsonl`
 * - 桌面版本机 Agent:`~/Library/Application Support/kimi-desktop/daimon-share/daimon/runtime/kimi-code/home/sessions/…`
 *
 * 每行一个 JSON。`type == "usage.record"` 的行带 `model`、毫秒时间戳 `time`、`usageScope`
 * 与 `usage` 下的 `{inputOther, inputCacheRead, inputCacheCreation, output}` 四字段。
 *
 * 三条口径(与任务书验收表一致):
 * 1. **只算 `usageScope == "turn"`** —— `"session"` 是累计值,加了会重复。
 * 2. **按 model 分家,不按工具分家** —— Kimi 会话里跑过 `volcengine-coding-plan/deepseek-v4-flash`,
 *    那份归 DeepSeek(source `dsh`),不能算进 Kimi。
 * 3. 口径对齐 Claude:新输入 = inputOther,缓存读 = inputCacheRead,缓存写 = inputCacheCreation;
 *    计费与吞吐的算式在 protocol.ts 的 billedTokens / 面板那一份,这里只负责归字段。
 *
 * 与 2026-09-02 摘掉的那版(CLI 纯文本日志,只有 outputTokens)不同,新版四字段齐全,
 * 不再走 `partial` 排除;缓存命中率、输入占比按全口径正常算。
 */
export const KIMI_USAGE_MARKER = 'usage.record'

/** 归 Kimi 的模型名(取 provider 前缀后的名字;`kimi-code/kimi-for-coding` 与裸名都认)。 */
const KIMI_MODEL_NAMES = new Set(['kimi-for-coding', 'k3-agent', 'k3-agent-swarm', 'k2d6-agent', 'k2d8-preview'])

/**
 * model → 按 model 分家(2026-10-27,任务书)。`volcengine-coding-plan/deepseek-v4-flash` 归
 * DeepSeek(火山);Kimi 模型(含认不出但明显是 Kimi 系的新名,如将来的 k4-*)归 Kimi ——
 * 这是 Kimi 引擎写出的 wire 日志,不是 Kimi 模型的用量不该出现在这里。
 */
export function kimiFamilyOf(model: string): 'kimi' | 'dsh' {
  const name = model.slice(model.lastIndexOf('/') + 1)
  if (name.startsWith('deepseek')) return 'dsh'
  if (KIMI_MODEL_NAMES.has(name) || name.startsWith('kimi')) return 'kimi'
  return 'kimi'
}

/** 一行解析的上下文:去重键按「文件路径 + 行号」(任务书),项目与会话由目录结构给。 */
export interface KimiWireContext {
  /** wire 文件绝对路径(去重键前半)。 */
  path: string
  /** 行号(文件内第几行,从 0 数)。 */
  lineNo: number
  /** 会话目录名(`session_<uuid>` / `conv-…`),sessionTotals 的键是它。 */
  session: string
  /** 已归拢的项目名(collector 从 wd 映射 + rollupProject 得来)。 */
  project: string
}

const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)

/**
 * 解析一行 wire 日志。不是 turn 级用量记录的返回 undefined(调用方靠 marker 预筛,
 * 但 session 累计值与其余 type 仍在这里按字段判);缺 time / model 的不猜,整条不计。
 */
export function parseKimiWireLine(line: string, ctx: KimiWireContext): UsageRecord | undefined {
  if (!line.includes(KIMI_USAGE_MARKER)) return undefined
  let row: any
  try {
    row = JSON.parse(line)
  }
  catch {
    return undefined
  }
  if (typeof row !== 'object' || row === null) return undefined
  if (row.type !== 'usage.record') return undefined
  if (row.usageScope !== 'turn') return undefined
  if (typeof row.model !== 'string' || row.model === '') return undefined
  const time = typeof row.time === 'number' ? row.time : Number(row.time)
  if (!Number.isFinite(time)) return undefined
  const usage = row.usage
  if (typeof usage !== 'object' || usage === null) return undefined

  return {
    ts: new Date(time).toISOString(),
    project: ctx.project,
    model: row.model,
    source: kimiFamilyOf(row.model),
    input: num(usage.inputOther),
    output: num(usage.output),
    cache_read: num(usage.inputCacheRead),
    cache_write: num(usage.inputCacheCreation),
    session: ctx.session,
    key: `kimi:${ctx.path}:${ctx.lineNo}`,
  }
}
