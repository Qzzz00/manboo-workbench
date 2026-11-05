/**
 * 壳模式探测(spec W2):工作台.app 的 WKWebView 以 ?ben-workbench=app 加载 DSH 页面。
 * DSH 客户端路由可能吃掉 search,所以 hash 也认——两条只要有一条命中就算在壳里。
 *
 * 评审补(2026-08-25):hash 那一半以前是 `hash.includes('ben-workbench=app')` 子串匹配——
 * `#ben-workbench=applesauce` 这种 value 只是碰巧以 'app' 开头的合法 hash 会被误判成壳内
 * 页面。改成按 URLSearchParams 精确解析 key=value:先剥掉开头的 '#',DSH 路由可能是
 * `#/route?ben-workbench=app` 这种"路径+查询串"形态,取 `?` 之后的部分当查询串;没有 `?`
 * 就整段当查询串(兼容既有先例的裸 `#ben-workbench=app` 格式)。跟 search 那一半用同一套
 * URLSearchParams 语义,不再是"子串出现就算数"。
 */
export function inShellApp(search: string, hash: string): boolean {
  if (new URLSearchParams(search).get('ben-workbench') === 'app') return true
  const withoutHashMark = hash.startsWith('#') ? hash.slice(1) : hash
  const query = withoutHashMark.includes('?') ? withoutHashMark.slice(withoutHashMark.indexOf('?') + 1) : withoutHashMark
  return new URLSearchParams(query).get('ben-workbench') === 'app'
}

/**
 * W4 套娃防护:工作台自己是 DSH 的 `shell.overlay` 插件。「事务官」标签内嵌的是同源的
 * DSH 页面,那个页面会**再把工作台 overlay 挂一遍**(store 的 init 是 open:true),
 * 那个工作台又渲染一个 iframe……无限递归。
 *
 * 主防线就是这一条:**overlay 只在顶层窗口挂载**。不依赖 URL 参数——别人怎么 iframe
 * 都套不进来。壳的 WKWebView 与浏览器标签页都是顶层帧,不受影响。
 *
 * 参数取 unknown 而不是 Window:测试里传两个普通对象就能覆盖三种情形,不必造 Window。
 * 拿不到 top(理论上只在跨源时发生)按"不是顶层"处理——宁可这一层不渲染工作台,
 * 也不冒无限套娃把浏览器卡死的险。
 */
export function isTopFrame(self: unknown, top: unknown): boolean {
  if (top === undefined || top === null) return false
  return self === top
}

/**
 * 壳的加载占位(2026-09-23 维护者从零重装:壳加载插件时露出上游的「HARNESS / Loading plugins…」)。
 *
 * 上游那一屏不改(C3 锁版本、上游仓库保持干净)。做法在壳里:WKWebView 上面先盖一层工作台自己的
 * 「正在打开工作台…」,**等工作台这一层真的挂上了**(这里发的 ready)才揭开。
 * 通道是壳注册的 WKScriptMessageHandler `benWorkbenchShell`;浏览器里没有这个 handler,什么都不做。
 * 这条消息只有一个作用(揭开占位),不带任何数据,页面伪造了也只是早揭开一下。
 */
export const SHELL_READY_HANDLER = 'benWorkbenchShell'
interface ShellBridgeWindow { webkit?: { messageHandlers?: Record<string, { postMessage: (message: unknown) => void } | undefined> } }

/**
 * 往壳发一条消息(2026-09-25 卡 TB 从 notifyShellReady 里抽出来)。壳只注册**一条**通道
 * (`benWorkbenchShell`),按 body 里的 `type` 分流:`ready` 揭开加载占位、`titlebar_*` 拖窗口
 * (壳那侧 Sources/TitleBar.swift)。浏览器里没有这个 handler,原地返回 false,什么都不做 ——
 * 调用方据此决定还要不要走网页自己那条路。
 */
export function postToShell(win: unknown, message: { type: string }): boolean {
  const handler = (win as ShellBridgeWindow | undefined)?.webkit?.messageHandlers?.[SHELL_READY_HANDLER]
  if (handler === undefined || typeof handler.postMessage !== 'function') return false
  try {
    handler.postMessage(message)
    return true
  }
  catch {
    return false
  }
}

export function notifyShellReady(win: unknown): boolean {
  return postToShell(win, { type: 'ready' })
}
