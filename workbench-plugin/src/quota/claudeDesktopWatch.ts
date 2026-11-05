/**
 * 盯着 Claude 桌面端那份用量记录，它一落新样本就立刻重采。
 *
 * 为什么必须有这个——把「Claude 那一栏慢」拆开看，慢分成两段：
 *
 * | 段 | 来源 | 大小 |
 * |---|---|---|
 * | 桌面端多久落一个样本 | 它自己的采样器，我们改不动 | 实测 15 分钟（见下） |
 * | 样本落了之后我们多久才读到 | 采集循环的 `DEFAULT_INTERVAL_MS` | 最坏 5 分钟 |
 *
 * 第二段是**白白多出来的**：数字早就躺在磁盘上了，只是没人去看。Codex 那一格
 * 2026-08-20 已经因为同样的抱怨（「客户端 90%、展示台还挂着 91%」）加过文件监听
 * （见 codexWatch.ts），Claude 这一格当时漏了。这里补上。
 *
 * 补完之后 Claude 那一栏的延迟就等于桌面端的采样间隔本身，多一秒都没有。
 * 要再往下压只能换数据源（响应头），那不是这个文件的事。
 *
 * 与 codexWatch 的两点不同，都是这份文件的位置逼出来的：
 *
 * 1. **监听目录而不是文件。** `~/Library/Application Support/Claude/` 底下桌面端是
 *    整份重写这个 json 的，原子写会换 inode，盯着文件的监听在第一次重写之后就哑了。
 * 2. **不看事件里的文件名，只看 mtime 有没有变。** 那个目录很吵（Cookies、leveldb、
 *    各种 Cache 每秒都在写），而原子写报上来的文件名可能是临时名。与其去猜桌面端
 *    的写法，不如每来一个事件就 stat 一次——stat 是微秒级的，比猜错便宜得多。
 *
 * 漏事件不用兜底：采集循环那五分钟一轮还在，最坏也就退回今天的表现。
 */
import { statSync, watch, type FSWatcher } from 'node:fs'
import { dirname } from 'node:path'

export interface WatchClaudeDesktopUsageOptions {
  /** 合并窗口。默认 300ms：桌面端一次落样本只写一遍，这里只为把原子写的几个事件并掉。 */
  debounceMs?: number
}

/** 读一次 mtime；文件还不存在（桌面端没装/没跑过）也不抛，当成"没变"。 */
function mtimeOf(file: string): number | undefined {
  try {
    return statSync(file).mtimeMs
  }
  catch {
    return undefined
  }
}

/**
 * @param file 用量记录的完整路径（`defaultClaudeDesktopUsageFile()`）。
 * @returns 停止监听的函数。插件卸载时必须调用，否则会留一个监听在后台。
 */
export function watchClaudeDesktopUsage(
  file: string,
  onChange: () => void,
  options: WatchClaudeDesktopUsageOptions = {},
): () => void {
  const debounceMs = options.debounceMs ?? 300
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = false
  let watcher: FSWatcher | undefined
  // 起始基准。文件不存在时是 undefined，等它第一次出现就算"变了"。
  let lastMtime = mtimeOf(file)

  try {
    // 同步建立监听：晚一拍建立的话，紧随其后的写入就漏掉了。
    watcher = watch(dirname(file), () => {
      if (stopped) return
      const mtime = mtimeOf(file)
      if (mtime === undefined || mtime === lastMtime) return
      lastMtime = mtime
      if (timer !== undefined) clearTimeout(timer)
      timer = setTimeout(() => { if (!stopped) onChange() }, debounceMs)
    })
    // 别让监听把 DSH 进程钉住不退出。
    watcher.unref?.()
  }
  catch {
    // 桌面端没装，或那个目录还没建。不是错误：那一格本来就会显示"未接入"。
  }

  return () => {
    stopped = true
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    watcher?.close()
    watcher = undefined
  }
}
