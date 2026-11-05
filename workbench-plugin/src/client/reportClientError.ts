/**
 * 页面上出的错报给服务端(2026-09-25,卡 V)。
 *
 * 09-25 晚维护者点「事务官」没反应、页面卡死 —— 而**没有任何地方记录**。壳是 WKWebView,
 * 那个控制台他打不开、统筹也看不到;于是第二天只能靠他复述「点了没反应」。
 *
 * 这一份挂两个口子(`window.onerror` / `unhandledrejection`)→ `POST /client/error`。
 * 服务端写一行日志 + 记进 `/state.client_errors`(最近 20 条),事务官在设置里看得到、统筹 `curl` 查得到。
 *
 * 四条纪律(报错这条路**绝不给页面添一个新的失败**):
 * 1. **它自己失败了不许再报**:发请求失败一概吞掉(`catch(() => {})`),否则一次网络抖动就能触发
 *    `unhandledrejection` → 再报一次 → 再失败……打不住的循环;
 * 2. **同一条只报几次**:同一句话 + 栈的第一行最多报 `MAX_PER_KEY` 次(每帧抛一次的 React 错误
 *    几秒就能打上千条),之后这一条闭嘴;
 * 3. **一共不超过 MAX_TOTAL 条**:到顶就整个闭嘴(服务端那头也有折叠,这里是第一道闸);
 * 4. **不动原来的行为**:两个口子都返回 `false` / 不 `preventDefault`,该在控制台红的照旧红。
 */

/** 同一条错误最多报几次。 */
export const MAX_PER_KEY = 3
/** 这一次页面打开一共最多报几条。 */
export const MAX_TOTAL = 50

export interface ReportErrorDeps {
  /** 服务端地址(同页面别处用的那一个)。 */
  baseUrl: string
  fetchImpl?: typeof fetch
  /** 哪一头:电脑页面 `desktop`,手机 `phone`。 */
  where?: 'desktop' | 'phone'
  /** 此刻在哪一块(`butler` / `settings` / …)。缺省不填。 */
  view?: () => string | undefined
}

export interface ClientErrorReporter {
  /** 报一条(两个口子都走它;也可以在 try/catch 里手动叫)。 */
  report: (input: { message: unknown, stack?: unknown }) => void
  /** 拆掉两个口子(测试与热更新用)。 */
  dispose: () => void
}

function messageOf(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (value instanceof Error) return value.message || value.name
  if (value === null || value === undefined) return undefined
  try {
    const text = typeof value === 'object' ? JSON.stringify(value) : String(value)
    return text === '{}' || text === '' ? undefined : text
  }
  catch {
    return undefined
  }
}

function stackOf(value: unknown): string | undefined {
  if (value instanceof Error && typeof value.stack === 'string') return value.stack
  return typeof value === 'string' ? value : undefined
}

/**
 * 挂上两个口子。返回的 `dispose` 拆掉它们。
 * `target` 缺省是 `globalThis`(测试里传一个假的 window)。
 */
export function installClientErrorReporter(deps: ReportErrorDeps, target: {
  addEventListener: (type: string, listener: (event: unknown) => void) => void
  removeEventListener: (type: string, listener: (event: unknown) => void) => void
} = globalThis as never): ClientErrorReporter {
  const fetchImpl = deps.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args))
  const seen = new Map<string, number>()
  let total = 0

  function report(input: { message: unknown, stack?: unknown }): void {
    if (total >= MAX_TOTAL) return
    const message = messageOf(input.message)
    if (message === undefined) return // 连一句话都凑不出来:不报一条空的
    const stack = stackOf(input.stack)
    const key = `${message}|${stack?.split('\n')[0] ?? ''}`
    const times = seen.get(key) ?? 0
    if (times >= MAX_PER_KEY) return
    seen.set(key, times + 1)
    total += 1
    const view = deps.view?.()
    void fetchImpl(`${deps.baseUrl}/client/error`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        message,
        ...(stack === undefined ? {} : { stack }),
        ...(view === undefined ? {} : { view }),
        where: deps.where ?? 'desktop',
      }),
      // 报错这一发不许再抛:失败就算了(纪律 1)。
    }).catch(() => {})
  }

  const onError = (event: unknown): void => {
    const e = event as { message?: unknown, error?: unknown, filename?: unknown, lineno?: unknown }
    // 有 Error 对象就用它的栈;只有 `message` 的(跨源脚本)退回「文件 + 行号」。
    const stack = e.error instanceof Error ? e.error.stack : typeof e.filename === 'string' ? `${e.filename}:${String(e.lineno ?? '')}` : undefined
    report({ message: e.error instanceof Error ? e.error : e.message, stack })
  }
  const onRejection = (event: unknown): void => {
    const reason = (event as { reason?: unknown }).reason
    report({ message: reason, stack: reason })
  }

  target.addEventListener('error', onError)
  target.addEventListener('unhandledrejection', onRejection)

  return {
    report,
    dispose() {
      target.removeEventListener('error', onError)
      target.removeEventListener('unhandledrejection', onRejection)
    },
  }
}
