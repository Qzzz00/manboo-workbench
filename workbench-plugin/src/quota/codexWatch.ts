/**
 * 盯着 Codex 的会话目录，一有新记录就立刻重采额度。
 *
 * 为什么必须有这个：Codex 的额度写在它自己的会话文件里，是**实时**的；
 * 而工作台原来每 5 分钟才去读一次，于是 Ben 在客户端看到 90%、展示台还挂着 91%。
 * 额度这种数字"更新不及时"比"没有"更吓人——他会据此判断还能不能开新任务。
 *
 * 这是**文件事件订阅（FSEvents/inotify），不是轮询**：空闲时零开销，
 * Codex 一写就回调。和 PRD §8.1 说的「hook 推送不算扫描」是同一类东西——
 * 我们不定期去翻别人的日志，是别人写了系统来通知我们。
 *
 * 防抖是必需的：Codex 一轮对话会往文件里写几十行，不合并的话会触发几十次采集。
 */
import { watch, type FSWatcher } from 'node:fs'
import { join } from 'node:path'

export interface WatchOptions {
  /** 合并窗口。默认 800ms：足够把一轮写入合并掉，又不至于让人觉得慢。 */
  debounceMs?: number
}

/**
 * @returns 停止监听的函数。插件卸载时必须调用，否则会留一个监听在后台。
 */
export function watchCodexSessions(
  codexHome: string,
  onChange: () => void,
  options: WatchOptions = {},
): () => void {
  const debounceMs = options.debounceMs ?? 800
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = false
  let watcher: FSWatcher | undefined

  // 同步建立监听：晚一拍建立的话，紧随其后的写入就漏掉了。
  try {
    // recursive 在 macOS 上走 FSEvents，能盖住 sessions/YYYY/MM/DD 整棵树。
    watcher = watch(join(codexHome, 'sessions'), { recursive: true }, () => {
      if (stopped) return
      if (timer !== undefined) clearTimeout(timer)
      timer = setTimeout(() => { if (!stopped) onChange() }, debounceMs)
    })
    // 别让监听把 DSH 进程钉住不退出。
    watcher.unref?.()
  }
  catch {
    // 他可能压根没装 Codex，或目录还没建。不是错误：那一格本来就会显示"未接入"。
  }

  return () => {
    stopped = true
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    watcher?.close()
    watcher = undefined
  }
}
