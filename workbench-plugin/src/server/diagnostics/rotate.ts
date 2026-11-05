/**
 * 日志轮转与总量封顶(2026-09-22)。
 *
 * ## 现状(改之前)
 *
 * | 文件 | 谁写 | 轮转 |
 * |---|---|---|
 * | `~/.dsh/logs/web.stdout.log` / `web.stderr.log` | launchd 重定向 DSH 的 stdout | **没有** |
 * | `~/.dsh/logs/butler.stdout.log` / `butler.stderr.log` | launchd 重定向语音后端 | **没有** |
 * | `~/.dsh/workbench/logs/channel-worker.log` | 插件把工人的 stdout 接过去 | 有一半:**下次启动时**超 8MB 就 `truncate(0)`(channelWorker.ts) |
 *
 * 也就是说:一台一直开着的机器,前四份日志**只涨不落**。新 Mac 上脱机跑几个月,
 * 它们就是那台机器上最大的几个文件。而工人那一份的做法虽然有封顶,却是"到点全扔" ——
 * 崩溃现场往往就在被扔掉的那一段里。
 *
 * ## 改成什么
 *
 * **按天轮转 + 总量封顶**:
 *
 * 1. 每天(或者单份超过 `ROTATE_AT_BYTES` 时)把活着那份的尾巴抄到
 *    `<名字>.<YYYY-MM-DD>`,然后把原文件**原地截断**;
 * 2. 轮转出来的那些按新到旧留着,**总量超过 `MAX_TOTAL_BYTES`(默认 200MB)
 *    就从最老的开始删**,并且超过 `KEEP_DAYS` 天的一律删。
 *
 * ## 为什么是「原地截断」而不是 rename
 *
 * 这一条是整块里唯一一个会真出事的地方。launchd 把 DSH 的 stdout 接到
 * `web.stdout.log` 时拿的是一个 **fd**;工人那份也是(channelWorker.ts 把 fd 交给子进程)。
 * `rename` 只改目录项,不动 inode —— 改完之后那些进程仍然写着同一个 inode,
 * 也就是写进了那份"已经轮转走"的文件里,而新的 `web.stdout.log` 永远是空的。
 * 这类故障最难查,因为一切看起来都正常。
 *
 * 原地截断没有这个问题:launchd 是 `O_APPEND` 打开的,截断之后下一次写落在新的文件尾。
 * 代价是截断与抄写之间那一瞬写进来的行会丢 —— 一台机器上一天丢掉零点几秒的日志,
 * 换掉一个"日志静默消失"的故障,这笔账划算。
 *
 * ## 抄的是尾巴,不是全文
 *
 * 一份已经涨到 300MB 的日志,抄全文要 300MB 内存和 300MB 磁盘。抄尾部
 * `ROTATE_KEEP_BYTES`(默认 8MB)—— 再往前的东西早就超出"最近 7 天"这个排障视野了,
 * 而且**丢掉多少写在返回值里**,不静悄悄地丢。
 */
import type { SetupPaths } from '../setup/paths.ts'
import type { DiagIo } from './io.ts'
import { logSourcesOf } from './pack.ts'

/** 单份超过它就轮转,不等到第二天。 */
export const ROTATE_AT_BYTES = 8 * 1024 * 1024

/** 轮转时从活着那份抄走的尾巴。 */
export const ROTATE_KEEP_BYTES = 8 * 1024 * 1024

/** 所有日志(活着的 + 轮转的)加起来的上限。 */
export const MAX_TOTAL_BYTES = 200 * 1024 * 1024

/** 轮转出来的最多留几天。 */
export const KEEP_DAYS = 14

/** 轮转状态:每份日志上一次轮转是哪一天。放在 `~/.dsh/workbench/log-rotate.json`。 */
export interface RotateState { version: 1, last: Record<string, string> }

export function rotateStateFile(paths: SetupPaths): string {
  return `${paths.dshHome}/workbench/log-rotate.json`
}

export function parseRotateState(text: string | undefined): RotateState {
  if (text === undefined) return { version: 1, last: {} }
  try {
    const parsed = JSON.parse(text) as { last?: unknown }
    if (typeof parsed !== 'object' || parsed === null) return { version: 1, last: {} }
    const last: Record<string, string> = {}
    for (const [key, value] of Object.entries((parsed.last ?? {}) as Record<string, unknown>)) {
      if (typeof value === 'string') last[key] = value
    }
    return { version: 1, last }
  }
  catch { return { version: 1, last: {} } }
}

/** 本地日期 `YYYY-MM-DD`。「按天」按 Ben 的天算,不按 UTC 的天算。 */
export function dayKeyOf(atMs: number, tzOffsetMinutes: number): string {
  return new Date(atMs + tzOffsetMinutes * 60_000).toISOString().slice(0, 10)
}

export interface RotateOutcome {
  /** 这一轮转走了哪几份。 */
  rotated: readonly { file: string, to: string, kept_bytes: number, dropped_bytes: number }[]
  /** 删掉了哪几份轮转文件。 */
  removed: readonly { file: string, bytes: number, why: string }[]
  /** 收拾完之后所有日志加起来多少字节。 */
  total_bytes: number
}

export interface RotateDeps {
  io: DiagIo
  paths: SetupPaths
  now: () => number
  /** 分钟偏移(`-new Date().getTimezoneOffset()`)。注入的,测试才断言得了。 */
  tzOffsetMinutes: number
  rotateAtBytes?: number
  keepBytes?: number
  maxTotalBytes?: number
  keepDays?: number
}

/**
 * 收拾一次。**幂等**:同一天里再调一次,什么都不会动(state 里记着今天已经转过了)。
 * 任何一份出错都只影响它自己,别的照转 —— 日志收拾是后台活,不该因为一个文件没权限就整个罢工。
 */
export async function rotateDiagLogs(deps: RotateDeps): Promise<RotateOutcome> {
  const io = deps.io
  const at = deps.now()
  const today = dayKeyOf(at, deps.tzOffsetMinutes)
  const rotateAt = deps.rotateAtBytes ?? ROTATE_AT_BYTES
  const keepBytes = deps.keepBytes ?? ROTATE_KEEP_BYTES
  const maxTotal = deps.maxTotalBytes ?? MAX_TOTAL_BYTES
  const keepDays = deps.keepDays ?? KEEP_DAYS

  const stateFile = rotateStateFile(deps.paths)
  const state = parseRotateState(await io.readFile(stateFile))
  const rotated: { file: string, to: string, kept_bytes: number, dropped_bytes: number }[] = []
  const removed: { file: string, bytes: number, why: string }[] = []

  for (const source of logSourcesOf(deps.paths)) {
    const info = await io.stat(source.path)
    if (info === undefined || !info.isFile || info.size === 0) continue
    const lastDay = state.last[source.name]
    const tooBig = info.size >= rotateAt
    const newDay = lastDay !== undefined && lastDay !== today
    // 第一次见到这份日志:只记一天,不转 —— 不然装完当天就先转一次空转。
    if (lastDay === undefined) { state.last[source.name] = today; continue }
    if (!tooBig && !newDay) continue

    const tail = await io.readTail(source.path, keepBytes)
    if (tail === undefined) continue
    const to = `${source.path}.${lastDay}`
    await io.writeFile(to, tail.text)
    await io.truncate(source.path, 0)
    state.last[source.name] = today
    rotated.push({
      file: source.path,
      to,
      kept_bytes: Buffer.byteLength(tail.text, 'utf8'),
      dropped_bytes: Math.max(0, tail.size - Buffer.byteLength(tail.text, 'utf8')),
    })
  }
  await io.writeFile(stateFile, `${JSON.stringify(state, null, 2)}\n`)

  /* ── 封顶:先删过期的,再从最老的删到总量达标 ─────────────────────── */
  const all = await listLogFiles(io, deps.paths)
  const cutoff = at - keepDays * 86_400_000
  let total = all.reduce((sum, item) => sum + item.size, 0)
  // 只删**轮转出来的**(名字里带日期后缀那些)。活着的那几份由截断管,不删。
  const rotatedFiles = all.filter(item => item.rotated).sort((a, b) => a.mtimeMs - b.mtimeMs)
  for (const item of rotatedFiles) {
    const expired = item.mtimeMs < cutoff
    if (!expired && total <= maxTotal) continue
    await io.rmrf(item.path)
    total -= item.size
    removed.push({ file: item.path, bytes: item.size, why: expired ? `超过 ${keepDays} 天` : `总量超过 ${Math.round(maxTotal / 1024 / 1024)}MB` })
  }

  return { rotated, removed, total_bytes: total }
}

interface LogFileInfo { path: string, size: number, mtimeMs: number, rotated: boolean }

/** 所有日志文件(活着的 + 轮转出来的)。体检页那一格「日志占了多少」也用它。 */
export async function listLogFiles(io: DiagIo, paths: SetupPaths): Promise<readonly LogFileInfo[]> {
  const out: LogFileInfo[] = []
  const seen = new Set<string>()
  for (const source of logSourcesOf(paths)) {
    const dir = source.path.slice(0, source.path.lastIndexOf('/'))
    const listing = await io.readdir(dir)
    if (!listing.ok) continue
    for (const name of listing.names) {
      if (name !== source.name && !name.startsWith(`${source.name}.`)) continue
      const path = `${dir}/${name}`
      if (seen.has(path)) continue
      seen.add(path)
      const info = await io.stat(path)
      if (info === undefined || !info.isFile) continue
      out.push({ path, size: info.size, mtimeMs: info.mtimeMs, rotated: name !== source.name })
    }
  }
  return out
}
