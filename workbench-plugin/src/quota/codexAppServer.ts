/**
 * Codex 额度的**实时**取数：`codex app-server` 的 `account/rateLimits/read`。
 *
 * 为什么要有这条路——2026-08-24 的教训：
 * 原来只读 `~/.codex/sessions/**\/*.jsonl`（见 codex.ts），而 Codex **只在他真的发请求时**
 * 才把额度快照写进会话文件。他 8/21 之后三天没用 Codex，工作台就一直显示 8/21 那份快照
 * （周 40%、8/27 重置），而真实情况是窗口早已重置（100%、8/31 重置）。
 * codex.ts 里那道闸只拦「resets_at 已经过去」，拦不住「读数只是旧了」——
 * 本机文件根本不可能知道一个它没见证过的重置。
 *
 * app-server 这条路走 Codex 自己的登录态，**我们不经手任何凭据**，也不发模型请求、不花额度。
 * 刷新仍挂在额度那条已批准的定时拉上（PRD §4），不新增常驻扫描器。
 *
 * 注意字段是**驼峰**（`usedPercent`/`windowDurationMins`/`resetsAt`），
 * 跟会话文件里的蛇形（`used_percent`/`window_minutes`/`resets_at`）不是一套，别混用。
 */
import type { QuotaWindow, WindowQuota } from '../protocol.ts'
import { askCodexAppServerOnce } from '../server/engine/adapters/codexAppServerClient.ts'
import { windowLabel } from './codex.ts'

/**
 * 握手 / 读行 / 对 id / 答它反过来问我们的那几问,都在
 * `src/server/engine/adapters/codexAppServerClient.ts` **一处**(2026-10-02,卡「Codex 协议适配器」)。
 * 这里只留「额度这一问怎么翻成界面上那条」。两处各写一遍的那段已经删了。
 */
export { CODEX_APP_BUNDLE_BINARY, resolveCodexBinary } from '../server/engine/adapters/codexAppServerClient.ts'

/** 可注入的取数，测试不碰真实进程。 */
export interface CodexAppServerIo {
  /** 发一次 `account/rateLimits/read`，返回 JSON-RPC 的 result 原文。 */
  readRateLimits: () => Promise<unknown>
}

interface AppServerWindow {
  usedPercent: number
  windowDurationMins: number
  resetsAt?: number
}

function readWindow(value: unknown): AppServerWindow | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  const used = record.usedPercent
  const minutes = record.windowDurationMins
  if (typeof used !== 'number' || typeof minutes !== 'number') return undefined
  return {
    usedPercent: used,
    windowDurationMins: minutes,
    ...(typeof record.resetsAt === 'number' ? { resetsAt: record.resetsAt } : {}),
  }
}

function toQuotaWindow(window: AppServerWindow): QuotaWindow {
  // 统一按剩余显示，方向与余额一致：数字变小＝该慌了（PRD §8.2 规则 1）。
  const left = Math.round((100 - window.usedPercent) * 10) / 10
  return {
    label: windowLabel(window.windowDurationMins),
    left_pct: Math.min(100, Math.max(0, left)),
    // resetsAt 是**秒**，当毫秒用会把重置时刻甩到 1970。
    ...(window.resetsAt === undefined ? {} : { reset_at: new Date(window.resetsAt * 1000).toISOString() }),
  }
}

/**
 * 把 `account/rateLimits/read` 的 result 翻成 WindowQuota。
 *
 * 只取 `rateLimits` 这个向后兼容的单桶视图——它就是界面上那条「周」。
 * `rateLimitsByLimitId` 里还有按模型分的桶（如 `codex_bengalfox`），第一版不展开（YAGNI）。
 */
export function parseAppServerRateLimits(raw: unknown): WindowQuota {
  if (typeof raw !== 'object' || raw === null) throw new Error('Codex app-server 返回的不是对象')
  const snapshot = (raw as Record<string, unknown>).rateLimits
  if (typeof snapshot !== 'object' || snapshot === null) throw new Error('Codex app-server 返回里没有 rateLimits')
  const record = snapshot as Record<string, unknown>

  const windows = [readWindow(record.primary), readWindow(record.secondary)]
    .filter((window): window is AppServerWindow => window !== undefined)
    .sort((left, right) => left.windowDurationMins - right.windowDurationMins)
    .map(toQuotaWindow)

  if (windows.length === 0) throw new Error('Codex app-server 没给出可用窗口，拒绝编造额度')

  return { kind: 'quota', windows }
}

/**
 * 采集一次实时额度。取不到就**抛错**，由调用方决定是否退回本机会话文件——
 * 这里不自己降级成 unknown，免得把「实时路不通」和「彻底没数」混成一句话。
 */
export async function collectCodexAppServerQuota(io: CodexAppServerIo): Promise<WindowQuota> {
  return parseAppServerRateLimits(await io.readRateLimits())
}

/**
 * 默认取数：起一个 `codex app-server`，握手后问一句 `account/rateLimits/read`，拿到就收工。
 *
 * 走 stdio 的 JSON-RPC，一问一答约 1.6 秒。用完就杀掉，不留常驻进程——
 * 常驻推送（`account/rateLimits/updated`）是另一件事，要改规范才做。
 *
 * 起进程 / 握手 / 读行 / 超时那一套在共用客户端里(2026-10-02 收成一处);
 * 送话那条走的是**一个长连接**(要听事件),这条仍然一问一答就收工 —— 两种用法同一份代码。
 */
export const defaultCodexAppServerIo: CodexAppServerIo = {
  readRateLimits: async () => await askCodexAppServerOnce('account/rateLimits/read', {}, { clientName: 'ben-dsh-workbench' }),
}
