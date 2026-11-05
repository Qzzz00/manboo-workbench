/**
 * 「点登录，工作台自己取」——Ben 明确要的形态，替代手工粘 Cookie。
 *
 * 做法：用一个**独立 profile** 起一个 Chrome 窗口打开目标页，他自己登录，
 * 我们拦下网页端自己发的那个用量请求，把它的 `authorization` 头取回来。
 *
 * 为什么抓请求头而不是 cookie：这个接口**光有 cookie 会 401**，真正的凭证在
 * authorization 里（2026-08-20 实抓确认，之前按 cookie 做一直失败）。
 * 抓活的请求还顺带保证了"他确实登录成功了"——没登录时页面根本发不出这个请求，
 * 比按 cookie 名猜可靠得多（那条路真机上判定错过一次：他登完了界面还说未登录）。
 *
 * 边界：
 * - **登录由他本人完成**，这里只开窗口和拦结果，绝不代填账号密码。
 * - 只取 authorization 一项，其余请求头（cookie、设备 id 等）一概不带走。
 * - 取到的值和 API Key 同一套保管规矩：0600、永不回显、不进日志与错误信息。
 * - profile 目录留着，下次多半不用重登。
 */
export interface LoginTarget {
  /** 打开哪个页面让他登录。 */
  url: string
  /** 网页端把长期凭据放在 localStorage 的哪个键上。2026-08-20 实抓确认。 */
  tokenKey: string
}

/**
 * 只有 Kimi 走登录。
 *
 * Claude 不在这里：它的额度由 Claude Code 的 statusLine 推上来，是文档支持的正路。
 * 我之前加过 claude_web 登录按钮，那是条死路——抓了 cookie 却没有对应的取数实现，
 * 点了也没用，已删。DeepSeek 也不在：官方只开放 API Key 一条路。
 */
export const LOGIN_TARGETS: Record<'kimi_web', LoginTarget> = {
  kimi_web: {
    url: 'https://www.kimi.com/user/subscription',
    // 网页端自己就把长期凭据放在这里（实抓：572 字节，与 access_token 并列）。
    tokenKey: 'refresh_token',
  },
}

/** 一次登录抓取的进展，供界面轮询显示。凭证本身绝不出现在这里。 */
export interface LoginProgress {
  provider: 'kimi_web'
  state: 'opening' | 'waiting' | 'done' | 'failed'
  message: string
}

export interface CaptureOptions {
  target: LoginTarget
  /** 独立 profile 目录。留着，下次多半不用重登。 */
  profileDir: string
  chromePath?: string
}

const DEFAULT_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

/**
 * 这台电脑上没装 Chrome 时那一句(2026-09-30,止血第 5 条)。
 * Kimi 网页登录、小红书那两处都拿它当失败原因往上报 —— **不崩进程、不假装开了窗口**。
 */
export const NO_CHROME_NOTE = '这台电脑上没装 Chrome,登录窗口开不了'

/** 起过的那几个登录窗口(pid)。插件收摊时 `closeProfileWindows()` 收掉还活着的。 */
const spawnedWindows = new Set<number>()

/**
 * 收摊:把我们起过的登录窗口收掉(2026-09-30,止血第 5 条 ——「无头 Chrome 不记 pid」那一条)。
 *
 * 窗口是 `detached` 起的,插件退出并不会带走它;不收就会在她桌面上留一个谁也认不出来的
 * Chrome 窗口(还占着那个专用档案目录的锁,下一次开窗口就开不成)。
 * 收不掉(她自己已经关了)不算错。
 */
export function closeProfileWindows(kill: (pid: number) => void = pid => process.kill(pid, 'SIGTERM')): void {
  for (const pid of spawnedWindows) {
    try { kill(pid) }
    catch { /* 早就没了 */ }
  }
  spawnedWindows.clear()
}

/** 开窗口要的那几样,测试注入(生产全走 node 内置)。 */
export interface OpenWindowDeps {
  exists?: (path: string) => Promise<boolean>
  mkdir?: (dir: string) => Promise<void>
  spawn?: (command: string, args: readonly string[]) => {
    pid?: number
    unref: () => void
    on: (event: string, handler: (err: Error) => void) => void
  }
  readPort?: (profileDir: string, deadline: number) => Promise<number>
}

/**
 * 读 Chrome 写在 profile 目录里的 DevToolsActivePort，比猜端口可靠。
 *
 * 2026-09-21 起导出：数据复盘那条路(server/xhsCreator.ts)要连的是**另一个**专用档案的
 * 调试口，连法与这里逐字一样。写第二份只会让两处悄悄走漂。
 */
export async function readDevToolsPort(profileDir: string, deadline: number): Promise<number> {
  const { readFile } = await import('node:fs/promises')
  const { join } = await import('node:path')
  const file = join(profileDir, 'DevToolsActivePort')

  while (Date.now() < deadline) {
    try {
      const first = (await readFile(file, 'utf8')).split('\n')[0]?.trim()
      const port = Number(first)
      if (Number.isInteger(port) && port > 0) return port
    }
    catch {
      // 还没写出来，等下一拍。
    }
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  throw new Error('Chrome 起来了但没写出调试端口')
}

/**
 * 开一个**独立 profile** 的 Chrome 窗口，返回它的调试端口。窗口留给他自己关。
 *
 * 2026-09-21 从 openLoginWindow 里抽出来：数据复盘要开的是另一个档案
 * (`login-profile-xhs_creator`)的窗口，开法与这里逐字一样 ——
 * **"怎么开一个带调试口的专用档案窗口"这件事只该有一个地方说得出口**。
 * Kimi 那条路的行为一个字没变(openLoginWindow 现在就是这个函数加一句取 url)。
 */
export async function openProfileWindow(
  profileDir: string,
  url: string,
  chromePath?: string,
  deps: OpenWindowDeps = {},
): Promise<number> {
  const exists = deps.exists ?? (async (path: string) => {
    const { access } = await import('node:fs/promises')
    try { await access(path); return true }
    catch { return false }
  })
  const mkdirAt = deps.mkdir ?? (async (dir: string) => {
    const { mkdir } = await import('node:fs/promises')
    await mkdir(dir, { recursive: true })
  })
  const spawnImpl = deps.spawn ?? await (async () => {
    const { spawn } = await import('node:child_process')
    return (command: string, args: readonly string[]) =>
      spawn(command, args as string[], { detached: true, stdio: 'ignore' })
  })()
  const readPort = deps.readPort ?? readDevToolsPort

  /*
   * ★ 2026-09-30(止血第 5 条):**先看在不在**。没装 Chrome 时 spawn 一个不存在的路径,
   * Node 把它抛成子进程的 `error` 事件 —— 原来没人接,于是它成了进程级未捕获错误,
   * 整个工作台跟着走(新 Mac 上必撞)。现在:不在就如实回一句,一次 spawn 都不做。
   */
  if (!await exists(chromePath ?? DEFAULT_CHROME)) throw new Error(NO_CHROME_NOTE)

  await mkdirAt(profileDir)

  // 不是无头：他要在这个窗口里自己登录。
  const child = spawnImpl(chromePath ?? DEFAULT_CHROME, [
    `--user-data-dir=${profileDir}`,
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    '--new-window',
    url,
  ])
  child.unref()
  // 记下 pid:收摊时(closeProfileWindows)把还活着的窗口收掉。
  if (typeof child.pid === 'number') spawnedWindows.add(child.pid)

  /*
   * spawn 自己失败(权限不对、包坏了)也走这条 `error` —— **必须有人接**,
   * 不接就是进程级崩溃。接住之后它跟「等不到调试端口」同一个下场:一次 reject。
   */
  const failed = new Promise<never>((_resolve, reject) => {
    child.on('error', (err: Error) => reject(err instanceof Error ? err : new Error(String(err))))
  })
  return await Promise.race([readPort(profileDir, Date.now() + 30_000), failed])
}

/** 开一个登录窗口，返回它的调试端口。窗口留给他自己关。 */
export async function openLoginWindow(options: CaptureOptions): Promise<number> {
  return await openProfileWindow(options.profileDir, options.target.url, options.chromePath)
}

/**
 * 取网页端的 **refresh token**（长期凭据），而不是那个只活 15 分钟的 access token。
 *
 * ★为什么改：原来抓的是网页端某个请求上的 authorization 头。那个值是 access token，
 * 它自己的 JWT 里写着 typ:"access"、exp - iat = 900 秒——存下来只能用 15 分钟。
 * 现象就是 Ben 报的「重新登录后能显示几分钟，然后又变成登录态失效」。
 * 真正耐久的是 localStorage.refresh_token（网页端自己就放在那儿），
 * 采集器每轮拿它换一个新的 access token 用。
 *
 * 它同时还是「有没有登录成功」的判据：没登录时这个键根本不存在，
 * 跟原来"能不能拦到一个真实请求"一样可靠，而且不用等页面发请求。
 */
/** 一条 DevTools 协议调用(方法名 + 参数 → 结果)。抽出来是为了让轮询逻辑可以不开 Chrome 就测。 */
export type CdpCall = (method: string, params: unknown) => Promise<unknown>

/**
 * 在登录窗口里等 refresh_token 出现(纯逻辑,可测)。
 *
 * ★2026-09-07 真机反馈「登录窗自己总是刷新,刚扫码就没了」的根因就在这里:原来每一轮
 * 抓取都无条件 `Page.navigate` 到目标页,而 http.ts 每 5 秒起一轮——二维码页每 5 秒被
 * 重置一次,手机上点了登录,电脑这边的页面早已不是那一页。现在先问页面"你在哪",
 * **已经在目标站点上就绝不再导航**(localStorage 按源隔离,只要同源就读得到),
 * 只有停在别处(about:blank、被跳走)才导航一次。
 * @param call - DevTools 调用
 * @param target - 登录目标
 * @param sleep - 两次读取之间的等待(测试里换成假时钟)
 * @param cancelled - 外层超时/取消后返回 true,循环据此退出
 * @returns refresh_token;被取消则 undefined
 */
export async function pollRefreshToken(
  call: CdpCall,
  target: LoginTarget,
  sleep: (ms: number) => Promise<void> = ms => new Promise(done => setTimeout(done, ms)),
  cancelled: () => boolean = () => false,
): Promise<string | undefined> {
  const origin = new URL(target.url).origin
  const where = await call('Runtime.evaluate', { expression: 'location.origin', returnByValue: true }) as
    { result?: { value?: unknown } }
  if (where.result?.value !== origin) await call('Page.navigate', { url: target.url })
  // 登录成功后 refresh_token 才会出现;隔一会儿看一次,直到外层超时把我们打断。
  for (;;) {
    if (cancelled()) return undefined
    await sleep(700)
    if (cancelled()) return undefined
    const result = await call('Runtime.evaluate', {
      expression: `localStorage.getItem(${JSON.stringify(target.tokenKey)}) || ''`,
      returnByValue: true,
    }) as { result?: { value?: unknown } }
    const value = result.result?.value
    if (typeof value === 'string' && value !== '') return value
  }
}

/**
 * 取网页端的 **refresh token**(长期凭据),而不是那个只活 15 分钟的 access token。
 *
 * ★为什么改:原来抓的是网页端某个请求上的 authorization 头。那个值是 access token,
 * 它自己的 JWT 里写着 typ:"access"、exp - iat = 900 秒——存下来只能用 15 分钟。
 * 现象就是 Ben 报的「重新登录后能显示几分钟,然后又变成登录态失效」。
 * 真正耐久的是 localStorage.refresh_token(网页端自己就放在那儿),
 * 采集器每轮拿它换一个新的 access token 用。
 *
 * 它同时还是「有没有登录成功」的判据:没登录时这个键根本不存在,
 * 跟原来"能不能拦到一个真实请求"一样可靠,而且不用等页面发请求。
 * 轮询与"要不要导航"的判断在 pollRefreshToken,这里只负责接上 DevTools 和超时。
 */
export async function captureRefreshToken(
  profileDir: string,
  target: LoginTarget,
  timeoutMs = 20_000,
): Promise<string> {
  const { default: WebSocket } = await import('ws')

  const port = await readDevToolsPort(profileDir, Date.now() + 3_000)
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as
    { type?: string, webSocketDebuggerUrl?: string }[]
  const page = list.find(target_ => target_.type === 'page' && target_.webSocketDebuggerUrl !== undefined)
  const wsUrl = page?.webSocketDebuggerUrl
  if (wsUrl === undefined) throw new Error('登录窗口没在了')

  return await new Promise<string>((resolve, reject) => {
    const socket = new WebSocket(wsUrl)
    let id = 0
    let stopped = false
    const pending = new Map<number, (result: unknown) => void>()
    const call: CdpCall = (method, params) => new Promise((done) => {
      const next = ++id
      pending.set(next, done)
      socket.send(JSON.stringify({ id: next, method, params }))
    })
    const finish = (fn: () => void): void => {
      stopped = true
      try { socket.close() } catch { /* 已经关了 */ }
      fn()
    }
    const timer = setTimeout(
      () => finish(() => reject(new Error('还没读到登录态(还没登录完?)'))),
      timeoutMs,
    )

    socket.on('message', (raw) => {
      let message: { id?: number, result?: unknown }
      try { message = JSON.parse(String(raw)) as typeof message }
      catch { return }
      if (message.id === undefined) return
      const done = pending.get(message.id)
      if (done === undefined) return
      pending.delete(message.id)
      done(message.result)
    })
    socket.on('error', (error: Error) => { clearTimeout(timer); finish(() => reject(error)) })

    socket.on('open', () => {
      void (async () => {
        const value = await pollRefreshToken(call, target, undefined, () => stopped)
        if (value === undefined) return // 已被超时/错误收尾,那边已经 reject 过了
        clearTimeout(timer)
        finish(() => resolve(value))
      })().catch((error: Error) => { clearTimeout(timer); finish(() => reject(error)) })
    })
  })
}

