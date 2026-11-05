/**
 * 诊断包多要的那一样 I/O:**只读一个文件的尾巴**(2026-09-22)。
 *
 * 为什么不能用 `SetupIo.readFile`:它把整份文件读成一个字符串。日志文件在一台
 * 跑了几个月的机器上可以是几百兆(`~/.dsh/logs/web.stdout.log` 没有任何轮转,
 * 这正是这张卡要顺手治的第四件事)。为了取最后 50 行而把 300MB 读进内存,
 * 是会把整个 DSH 进程带走的那种做法。
 *
 * 所以这里开一个 fd、`seek` 到尾巴、只读最后那几 MB。第一行多半是半截,
 * 调用方把它丢掉(`dropFirstPartialLine`)—— 半截 JSON 比没有更糟。
 */
import { open, stat as fsStat, truncate as fsTruncate } from 'node:fs/promises'
import type { SetupIo } from '../setup/io.ts'

export interface DiagTail {
  text: string
  /** 文件比要的那几 MB 大,前面被砍掉了。清单里要如实写这一句。 */
  truncated: boolean
  /** 文件的真实大小(字节)。 */
  size: number
  /** 最后修改时间(毫秒)。「最近 7 天」按它筛。 */
  mtimeMs: number
}

export interface DiagIo extends SetupIo {
  /** 读一个文件的最后 `maxBytes` 字节。读不到(不存在、没权限)回 undefined,不抛。 */
  readTail: (path: string, maxBytes: number) => Promise<DiagTail | undefined>
  /**
   * 把一个文件**原地**截到指定长度。轮转靠它 —— 理由见 rotate.ts 的文件头:
   * launchd 与工人拿着这些文件的 fd,`rename` 之后它们会继续往那个已经改名的 inode 里写,
   * 于是"轮转"变成了"从此再也没有新日志"。原地截断没有这个问题。
   */
  truncate: (path: string, size: number) => Promise<void>
}

export function nodeDiagIo(base: SetupIo): DiagIo {
  return {
    ...base,
    async readTail(path, maxBytes) {
      let handle
      try {
        const info = await fsStat(path)
        if (!info.isFile()) return undefined
        const size = info.size
        const want = Math.min(size, Math.max(0, maxBytes))
        if (want === 0) return { text: '', truncated: size > 0, size, mtimeMs: info.mtimeMs }
        handle = await open(path, 'r')
        const buffer = Buffer.allocUnsafe(want)
        await handle.read(buffer, 0, want, size - want)
        return { text: buffer.toString('utf8'), truncated: want < size, size, mtimeMs: info.mtimeMs }
      }
      catch {
        return undefined
      }
      finally {
        await handle?.close().catch(() => {})
      }
    },
    async truncate(path, size) {
      try { await fsTruncate(path, size) }
      catch { /* 文件不在 / 没权限:轮转不成不该让别的事情跟着失败 */ }
    },
  }
}

/**
 * 掐掉开头那半截行。**只在真的截断过时做** —— 没截断的时候第一行是完整的,
 * 掐掉就是白丢一行。
 */
export function dropFirstPartialLine(text: string, truncated: boolean): string {
  if (!truncated) return text
  const at = text.indexOf('\n')
  return at < 0 ? '' : text.slice(at + 1)
}
