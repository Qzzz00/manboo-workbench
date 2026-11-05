/**
 * Codex 额度采集（PRD §8.2）。
 *
 * Codex CLI 把每次请求后的额度快照写进 `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`，
 * 形如：
 *
 * ```json
 * "rate_limits":{"limit_id":"codex",
 *   "primary":{"used_percent":100.0,"window_minutes":10080,"resets_at":1787196780},
 *   "secondary":null,"credits":{...},"plan_type":"prolite"}
 * ```
 *
 * 于是这一家不需要网络、不需要凭据：读本机文件即可。刷新靠额度那条已批准的定时拉
 * （PRD §4 架构图「余额 ──定时拉──> 本地服务」），不新增常驻扫描器。
 *
 * 纪律：文件里读不到就如实降级成 unknown 并写明原因，绝不补 0——
 * 显示 0 会被误读成"额度耗尽"（PRD §8.2）。
 */
import type { QuotaEntry, QuotaWindow, WindowQuota } from '../protocol.ts'

/** 一份会话文件及其最后写入时间。 */
export interface CodexSessionFile {
  path: string
  /** 最后修改时间（毫秒）。用它排序，**不能用文件名**，见 collectCodexQuota 的说明。 */
  mtimeMs: number
}

/** 可注入的文件读取，测试不碰真实磁盘。 */
export interface CodexIo {
  listSessionFiles: (codexHome: string) => Promise<readonly CodexSessionFile[]>
  readFile: (file: string) => Promise<string>
}

export interface CodexQuotaOptions {
  codexHome: string
  io?: CodexIo
  /** 判断读数是否已过期的基准时刻。 */
  now?: Date
}

interface CodexWindow {
  used_percent: number
  window_minutes: number
  resets_at?: number
}

/** 把 window_minutes 翻成界面上的窗口名。 */
export function windowLabel(minutes: number): string {
  if (minutes === 10080) return '周'
  if (minutes === 43200) return '月'
  if (minutes % 60 === 0) return `${minutes / 60}h`
  return `${minutes}分钟`
}

/** 深度受限地找出对象里的 rate_limits——它嵌在 info 之类的壳里，层级随版本变过。 */
function findRateLimits(value: unknown, depth = 0): unknown {
  if (depth > 6 || typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  if ('rate_limits' in record && typeof record.rate_limits === 'object' && record.rate_limits !== null) {
    return record.rate_limits
  }
  for (const nested of Object.values(record)) {
    const found = findRateLimits(nested, depth + 1)
    if (found !== undefined) return found
  }
  return undefined
}

/**
 * 从一份 session 的所有行里取**最后**一条 rate_limits。
 * 同一份 session 会反复写入，只有最后一条是现值。坏行跳过，不能让整份文件作废。
 */
export function pickLatestRateLimits(lines: Iterable<string>): unknown {
  let latest: unknown
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    }
    catch {
      continue
    }
    const found = findRateLimits(parsed)
    if (found !== undefined) latest = found
  }
  return latest
}

function readWindow(value: unknown): CodexWindow | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  const used = record.used_percent
  const minutes = record.window_minutes
  if (typeof used !== 'number' || typeof minutes !== 'number') return undefined
  return {
    used_percent: used,
    window_minutes: minutes,
    ...(typeof record.resets_at === 'number' ? { resets_at: record.resets_at } : {}),
  }
}

function toQuotaWindow(window: CodexWindow): QuotaWindow {
  // 统一按剩余显示，方向与余额一致：数字变小＝该慌了（PRD §8.2 规则 1）。
  const left = Math.round((100 - window.used_percent) * 10) / 10
  return {
    label: windowLabel(window.window_minutes),
    left_pct: Math.min(100, Math.max(0, left)),
    ...(window.resets_at === undefined ? {} : { reset_at: new Date(window.resets_at * 1000).toISOString() }),
  }
}

/**
 * 把一条 rate_limits 翻成 WindowQuota。两个窗口都读不出来就抛错，由调用方降级。
 *
 * @param now 用来判断这条读数是不是已经过期。Codex 的额度只在**他实际用 Codex 时**
 *   才写进会话文件；一旦过了 resets_at，文件里那个数说的是重置**之前**的情况，
 *   继续显示「周 0%」会让人以为额度还没恢复——而实际上早就满血了。
 *   这种情况下宁可标"未知"，也不给一个已经不成立的数。
 */
export function parseCodexQuota(raw: unknown, now: Date = new Date()): WindowQuota {
  if (typeof raw !== 'object' || raw === null) throw new Error('Codex 额度记录不是对象')
  const record = raw as Record<string, unknown>

  const windows = [readWindow(record.primary), readWindow(record.secondary)]
    .filter((window): window is CodexWindow => window !== undefined)
    .sort((left, right) => left.window_minutes - right.window_minutes)
    .map(toQuotaWindow)

  if (windows.length === 0) throw new Error('Codex 额度记录里没有可用的窗口，拒绝编造额度')

  // 最靠后的那个重置时刻都已经过去了 = 整条读数都是上一轮的，不能再用。
  const latestReset = Math.max(...windows
    .map(window => (window.reset_at === undefined ? 0 : Date.parse(window.reset_at))))
  if (latestReset > 0 && latestReset <= now.getTime()) {
    throw new Error('Codex 额度读数已过重置时刻，是上一轮的旧数')
  }

  return { kind: 'quota', windows }
}

/** 这个数哪来的(界面上「截至 04:27」旁边那半句)。 */
export const CODEX_SESSION_SOURCE = '本机 Codex 会话记录'

/** 默认实现：递归列出 sessions 下的 rollout-*.jsonl。 */
const defaultIo: CodexIo = {
  listSessionFiles: async (codexHome) => {
    const { readdir, stat } = await import('node:fs/promises')
    const { join } = await import('node:path')
    const root = join(codexHome, 'sessions')
    const entries = await readdir(root, { recursive: true })
    const files = entries.filter(entry => entry.endsWith('.jsonl')).map(entry => join(root, entry))
    return await Promise.all(files.map(async (path) => {
      try {
        return { path, mtimeMs: (await stat(path)).mtimeMs }
      }
      catch {
        return { path, mtimeMs: 0 }
      }
    }))
  },
  // 只读文件尾 4MB(2026-09-11):额度记录随每轮追加在末尾,pickLatestRateLimits 取的也是最后一条;
  // 整份读会在 1GB 的 rollout 上撞字符串上限。被截断的半行 JSON.parse 失败即跳过,不影响取值。
  readFile: async (file) => {
    const { open } = await import('node:fs/promises')
    const tailBytes = 4 * 1024 * 1024
    const handle = await open(file, 'r')
    try {
      const { size } = await handle.stat()
      if (size <= tailBytes) return await handle.readFile('utf8')
      const buffer = Buffer.alloc(tailBytes)
      await handle.read(buffer, 0, tailBytes, size - tailBytes)
      return buffer.toString('utf8')
    }
    finally {
      await handle.close()
    }
  },
}

/**
 * 采集一次 Codex 额度。
 *
 * **按最后修改时间排，不能按文件名。** 文件名里的时间戳是会话**创建**时刻，
 * 而他经常恢复一个早先的会话继续用——那份文件名靠后，却是最近在写的。
 * 2026-08-20 真机实证：按文件名排读到的是 14:38 创建、14:43 停写的那份（周 93%），
 * 而他实际在用的是 11:44 创建、14:46 仍在写的那份（周 91%），
 * 于是展示台一直比客户端慢一截。
 *
 * 找到第一份含额度记录的就返回，不必把几百份历史 session 全读完。
 */
export async function collectCodexQuota(options: CodexQuotaOptions): Promise<QuotaEntry> {
  const io = options.io ?? defaultIo

  let files: readonly CodexSessionFile[]
  try {
    files = await io.listSessionFiles(options.codexHome)
  }
  catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return { kind: 'unknown', note: `读不到 Codex 会话目录：${reason}` }
  }

  const newestFirst = [...files].sort((left, right) => right.mtimeMs - left.mtimeMs)
  for (const { path: file, mtimeMs } of newestFirst) {
    let content: string
    try {
      content = await io.readFile(file)
    }
    catch {
      continue
    }

    const raw = pickLatestRateLimits(content.split('\n'))
    if (raw === undefined) continue

    try {
      /**
       * `as_of` 是**那份会话文件最后写过的时刻**(2026-10-02,卡 QA),不是我们读它的这一刻。
       *
       * 这条路的数只在**他真的用 Codex 时**才写进文件:2026-08-24 屏上就挂过三天前的读数
       * (周 40%)当现值。拿读文件的时刻当截至时刻等于把它说新了 —— 与 Claude 桌面端那条路同病。
       */
      return {
        ...parseCodexQuota(raw, options.now ?? new Date()),
        ...(mtimeMs > 0 ? { as_of: new Date(mtimeMs).toISOString(), source: CODEX_SESSION_SOURCE } : {}),
      }
    }
    catch (error) {
      // 过期是"读到了但不能用"，跟"这份文件里没有额度"是两回事，要分开说。
      if (error instanceof Error && error.message.includes('重置时刻')) {
        return {
          kind: 'unknown',
          note: 'Codex 额度已过重置时刻，等你再用一次 Codex 才会有新读数',
        }
      }
      continue
    }
  }

  return { kind: 'unknown', note: 'Codex 会话记录里未找到额度信息' }
}
