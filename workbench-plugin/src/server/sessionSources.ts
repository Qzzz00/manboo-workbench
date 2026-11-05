/**
 * Codex 会话源:读 `~/.codex/sessions` 下各层 `.jsonl` 文件首行拿 payload.cwd,喂给项目区归属(spec D5)。
 *
 * 纪律(D13):逐文件 try/catch,一份文件解析失败只计入 errors——不能让整批归属因为一份坏文件跟着崩。
 * 生产 deps 按 R6 实测(497 个文件 1.13s)可接受,不加缓存;更进一步的加速留给 Task 7。
 */
import { isInteractiveCodexSource } from './codexRollout.ts'

export interface CodexSessionSourceDeps {
  listFiles: (dir: string) => Promise<string[]>
  readFirstLine: (f: string) => Promise<string>
}

export interface CodexSessionCwdItem {
  cwd: string
  at?: string
}

export interface CodexSessionCwdsResult {
  items: CodexSessionCwdItem[]
  errors: number
}

export async function codexSessionCwds(
  codexHome: string,
  deps: CodexSessionSourceDeps,
): Promise<CodexSessionCwdsResult> {
  /*
   * ★ 整批缺席不陪葬(2026-10-23 夜,卡 A 验收定位):`~/.codex/sessions` 不存在
   * (没装 Codex 的机器 / 隔离 profile)时 listFiles 一抛,整轮项目扫描跟着塌、项目区永远空白。
   * 这一支是可选来源 —— 读不到 = 缺席(空表、零错),与逐文件「坏一份不崩整批」同一道纪律。
   */
  let files: string[]
  try {
    files = await deps.listFiles(codexHome)
  }
  catch {
    return { items: [], errors: 0 }
  }
  const items: CodexSessionCwdItem[] = []
  let errors = 0
  for (const file of files) {
    try {
      const firstLine = await deps.readFirstLine(file)
      const parsed = JSON.parse(firstLine) as {
        type?: unknown
        payload?: { cwd?: unknown, timestamp?: unknown, source?: unknown }
      }
      if (parsed.type !== 'session_meta' || !isInteractiveCodexSource(parsed.payload?.source)) continue
      const cwd = parsed.payload?.cwd
      if (typeof cwd !== 'string') {
        errors += 1
        continue
      }
      const timestamp = parsed.payload?.timestamp
      items.push(typeof timestamp === 'string' ? { cwd, at: timestamp } : { cwd })
    }
    catch {
      errors += 1
    }
  }
  return { items, errors }
}

/**
 * 首行读一次就记住(2026-10-21 急修「8791 空转」)。项目区 30 秒一轮,原来每轮把每份 rollout 的开头读 64KB
 * (维护者那台 1099 份,一轮 70MB);rollout 只往后追加,首行写下就不会变。
 * 只记**读完整了的**那一行(窗口里见到了换行,或者窗口读满了 —— 那一段截断结果也是定的);
 * 文件变短(另起一份同名文件)就重读;读不到照旧抛,也不留那一条。
 */
export function createFirstLineCache(options: {
  windowBytes: number
  /** 记下来之前收一收(只留调用方要的那几格):Codex 的首行平均 22KB,一千多份原样记着就是 25MB。 */
  keep?: (line: string) => string
  onRead?: () => void
}): { read: (file: string) => Promise<string> } {
  const known = new Map<string, { size: number, line: string }>()
  return {
    async read(file) {
      const { open } = await import('node:fs/promises')
      let handle: Awaited<ReturnType<typeof open>>
      try { handle = await open(file, 'r') }
      catch (error) { known.delete(file); throw error }
      try {
        const { size } = await handle.stat()
        const had = known.get(file)
        if (had !== undefined && size >= had.size) return had.line
        options.onRead?.()
        const buffer = Buffer.alloc(options.windowBytes)
        const { bytesRead } = await handle.read(buffer, 0, options.windowBytes, 0)
        const text = buffer.subarray(0, bytesRead).toString('utf8')
        const newline = text.indexOf('\n')
        const line = newline === -1 ? text : text.slice(0, newline)
        if (newline !== -1 || bytesRead >= options.windowBytes) known.set(file, { size, line: options.keep?.(line) ?? line })
        else known.delete(file)
        return line
      }
      finally {
        await handle.close()
      }
    },
  }
}

/**
 * 只留 {@link codexSessionCwds} 读的那几格(type / payload 的 cwd、timestamp、source);解不开的原样留(它会按坏行算)。
 * 这一份只给会话归属用,不是通用的「首行」。
 */
export function keepSessionMetaFields(line: string): string {
  let parsed: unknown
  try { parsed = JSON.parse(line) }
  catch { return line }
  if (typeof parsed !== 'object' || parsed === null) return line
  const row = parsed as { type?: unknown, payload?: { cwd?: unknown, timestamp?: unknown, source?: unknown } }
  const payload = typeof row.payload === 'object' && row.payload !== null
    ? { cwd: row.payload.cwd, timestamp: row.payload.timestamp, source: row.payload.source }
    : row.payload
  return JSON.stringify({ type: row.type, payload })
}

const codexFirstLines = createFirstLineCache({ windowBytes: 64 * 1024, keep: keepSessionMetaFields })

/**
 * 生产用 deps:递归列出 `sessions/` 下的 `*.jsonl`,读文件首行(读过的记住,见 {@link createFirstLineCache})。
 */
export const defaultCodexSessionSourceDeps: CodexSessionSourceDeps = {
  listFiles: async (codexHome) => {
    const { readdir } = await import('node:fs/promises')
    const { join } = await import('node:path')
    const root = join(codexHome, 'sessions')
    const entries = await readdir(root, { recursive: true })
    return entries.filter(entry => entry.endsWith('.jsonl')).map(entry => join(root, entry))
  },
  // 只读文件头一个窗口(2026-09-11):session_meta 是首行、几百字节;原先整份 readFile,
  // 撞上 1GB 的 rollout 就抛 "Invalid string length",项目区跟着挂一条「1 个会话文件解析失败」。
  readFirstLine: async (file) => await codexFirstLines.read(file),
}

/** 读文件开头 `windowBytes` 内的第一行;首行比窗口还长就把窗口整段返回(调用方按坏行处理)。 */
export async function readFirstLineBounded(file: string, windowBytes: number): Promise<string> {
  const { open } = await import('node:fs/promises')
  const handle = await open(file, 'r')
  try {
    const buffer = Buffer.alloc(windowBytes)
    const { bytesRead } = await handle.read(buffer, 0, windowBytes, 0)
    const text = buffer.subarray(0, bytesRead).toString('utf8')
    const newline = text.indexOf('\n')
    return newline === -1 ? text : text.slice(0, newline)
  }
  finally {
    await handle.close()
  }
}
