/**
 * 「用那份专用档案打开一页,把页面上看得见的字读回来」(2026-09-21)。
 *
 * 这是整张卡唯一真的碰网络的地方,所以风控自保的每一条都落在这个文件里:
 *
 * 1. **同一个浏览器档案**(`~/.dsh/workbench/login-profile-xhs_creator`),真人登录过的那个。
 *    复用的是 Kimi 网页登录那套(server/webLogin.ts 的 `openProfileWindow`),
 *    连档案目录的命名都一样。
 * 2. **只读页面,只有一个例外**:这里发两种 DevTools 调用 —— `Page.navigate` 与
 *    `Runtime.evaluate`;`Runtime.evaluate` 里的表达式只有四个:
 *    `location.href`、`document.title`、`document.body.innerText`,
 *    加上 2026-09-22 新增的**那一下范围切换的点击**(`rangeSwitchExpression`)。
 *    **不填任何表单、不调它的私有接口、不发一条 XHR。**
 *    真正取数的那一句仍然是 `document.body.innerText` —— 读的是**他自己屏幕上本来就有的字**。
 *
 *    那一下点击为什么仍然算"只读":点的是**他自己后台上的一颗范围切换按钮**
 *    (近7日 ↔ 近30日,同一页上的两颗按钮,地址栏一个字不变),
 *    不产生任何对外可见的行为、不给任何人发通知、不改他账号上的任何东西。
 *    「采集类三项」那条「不点」的承诺管的是**别人的**笔记与评论区,不是这里。
 *    边界写在 docs/决策记录.md 2026-09-22「技术选择」那一节。
 * 3. **低频**:频率闸在 xhsCreator.ts(每天早报前一次 + 他点刷新一次,两次之间至少 10 分钟)。
 * 4. **凭据一个字不带走**:这里没有一行读 cookie / localStorage / sessionStorage。
 *    登录态自始至终只在 Chrome 自己的档案目录里,我们连它的键名都没问过。
 *    (对比 webLogin.ts:Kimi 那条路要把 refresh_token 取回来,这条路**不取任何东西**。)
 *
 * ## 窗口开着 vs 没开着
 *
 * 取数要连的是那个档案的**远程调试口**,而调试口只在那个 Chrome 进程活着时存在。
 * 所以:连不上 = 「那个登录窗口没开着」,如实说,**不偷偷替他再开一个**
 * (悄悄弹出一个浏览器窗口是这类功能最吓人的行为)。要不要开,是 xhsCreator 那层
 * 按「用户点了刷新」还是「例程到点了」分别决定的。
 */
import { periodLineOf } from './xhsMetrics.ts'
import { openProfileWindow, readDevToolsPort } from './webLogin.ts'

/** 从一页读回来的东西。 */
export interface XhsPageRead {
  /** 读完时页面真正停在哪(被跳到 /login 就是没登录)。 */
  href: string
  title: string
  /** `document.body.innerText` —— 页面上看得见的字。 */
  text: string
  /** 要求切范围时:那颗按钮**找到并点着了没有**。没要求切就缺席。 */
  switch_clicked?: boolean
  /**
   * 要求切范围时:点完之后「统计周期 …」那一行**真的变了没有**。
   * ★ 这是"这一份到底是不是 30 日那一份"的**唯一硬证据**。
   * false = 没切成 → 上层**不存这一份**(见 xhsCreator.ts)。
   */
  switch_confirmed?: boolean
}

/** 取数用的浏览器。抽成接口是为了让 xhsCreator 的编排逻辑不开 Chrome 就能测。 */
export interface XhsBrowser {
  /** 开一个专用档案的窗口(他自己在里面登录)。回调试端口。 */
  openWindow: (profileDir: string, url: string) => Promise<number>
  /**
   * 用已经开着的那个窗口打开一页,把可见文字读回来。
   * `switchTo` 传了就在读之前点一下那颗范围切换按钮(见 readPageWith 文件内注释)。
   */
  readPage: (profileDir: string, url: string, switchTo?: readonly string[]) => Promise<XhsPageRead>
  /**
   * 那个窗口此刻开着哪几个地址(2026-09-30)。**只看、不跳转、不点** —— 他可能正在里面输验证码。
   * 连不上就抛「登录窗口没开着」。缺席 = 这一份浏览器不会看(老用例),登录后就不自己取。
   */
  currentUrls?: (profileDir: string) => Promise<string[]>
}

/**
 * 点那颗范围切换按钮的表达式。
 *
 * ## ★ 这是这条路上**唯一**一个会改变页面的动作,边界写在这里
 *
 * 「采集类三项」对 Ben 的承诺是「只采集、不点」—— 那条承诺管的是**别人的**笔记与评论区
 * (不点赞、不关注、不评论)。这里点的是**他自己的创作者后台上的一颗范围切换按钮**,
 * 与他自己伸手点一下没有区别:不产生任何对外可见的行为,不给任何人发通知,
 * 也不改他账号上的任何东西。两件事的边界记在 docs/决策记录.md 2026-09-22 那一节。
 *
 * 即便如此,这个表达式仍然是**收紧到不能再紧**的:
 *
 * - 只认 `textContent.trim()` **完全等于**候选文字的元素(不是 includes ——
 *   「近30日」用 includes 会撞上「近30日数据」这类长句);
 * - 只点**看得见**的(`getClientRects().length > 0`);
 * - 一个都没找到就回 `'no-button'`,**不退而求其次点个差不多的**;
 * - 点完之后必须看见「统计周期」那一行变了才算数(见 readPageWith)。
 */
export function rangeSwitchExpression(labels: readonly string[]): string {
  return `(() => { const want = ${JSON.stringify([...labels])};`
    + ` const all = Array.from(document.querySelectorAll('button, a, li, span, div'));`
    + ` const hit = all.filter(el => want.indexOf((el.textContent || '').trim()) >= 0 && el.getClientRects().length > 0);`
    + ` const el = hit[hit.length - 1]; if (!el) return 'no-button'; el.click(); return 'clicked'; })()`
}

/** 一条 DevTools 协议调用。与 webLogin.ts 的 CdpCall 同形。 */
type CdpCall = (method: string, params: unknown) => Promise<unknown>

function valueOf(result: unknown): string {
  const value = (result as { result?: { value?: unknown } }).result?.value
  return typeof value === 'string' ? value : ''
}

/**
 * 在一个已经连上的调试会话里打开一页并读回文字(纯逻辑,可测)。
 *
 * 等页面**稳下来**的办法是"连着两拍读到的文字一样长就算稳了",而不是死等一个固定秒数:
 * 创作者中心这类看板的数字是异步填进去的,固定 2 秒常常读到一页骨架屏(那会被解析成
 * 「页面变了」——一个假警报)。最多等 `maxWaitMs`,等不稳就把此刻读到的交出去,
 * 由解析器去判它到底是骨架屏还是真页面。
 */
export async function readPageWith(
  call: CdpCall,
  url: string,
  sleep: (ms: number) => Promise<void> = ms => new Promise(done => setTimeout(done, ms)),
  maxWaitMs = 12_000,
  switchTo?: readonly string[],
): Promise<XhsPageRead> {
  const readText = async (): Promise<string> => valueOf(await call('Runtime.evaluate', {
    expression: 'document.body ? document.body.innerText : ""',
    returnByValue: true,
  }))

  await call('Page.navigate', { url })

  let last = ''
  let stable = 0
  const deadline = maxWaitMs
  let waited = 0
  for (;;) {
    await sleep(800)
    waited += 800
    const text = await readText()
    // 两拍一样就算稳了。空文本不算稳(那是还没渲染)。
    if (text !== '' && text === last) stable++
    else stable = 0
    last = text
    if (stable >= 1 || waited >= deadline) break
  }

  /**
   * 切范围(2026-09-22)。「近7日」「近30日」是**同一页上的两颗按钮**,地址栏一个字不变,
   * 所以只能点一下、再等「统计周期 …」那一行变了才算切成功。
   * 等不到就如实回 `switch_confirmed: false` —— 上层据此**不存这一份**。
   */
  let switched: { clicked: boolean, confirmed: boolean } | undefined
  if (switchTo !== undefined && switchTo.length > 0) {
    const before = periodLineOf(last)
    const clicked = valueOf(await call('Runtime.evaluate', {
      expression: rangeSwitchExpression(switchTo),
      returnByValue: true,
    })) === 'clicked'
    let confirmed = false
    if (clicked) {
      let spent = 0
      while (spent < deadline) {
        await sleep(800)
        spent += 800
        const text = await readText()
        if (text === '') continue
        last = text
        const after = periodLineOf(text)
        // 原来就没有「统计周期」那一行的话,这一次切没法确认 —— 那就是没确认。
        if (before !== undefined && after !== undefined && after !== before) { confirmed = true; break }
      }
    }
    switched = { clicked, confirmed }
  }

  const href = valueOf(await call('Runtime.evaluate', { expression: 'location.href', returnByValue: true }))
  const title = valueOf(await call('Runtime.evaluate', { expression: 'document.title', returnByValue: true }))
  return {
    href,
    title,
    text: last,
    ...(switched === undefined ? {} : { switch_clicked: switched.clicked, switch_confirmed: switched.confirmed }),
  }
}

/** 连上那个档案的调试口,跑一段,然后断开。连不上就抛「登录窗口没开着」。 */
async function withCdp<T>(profileDir: string, fn: (call: CdpCall) => Promise<T>): Promise<T> {
  const { default: WebSocket } = await import('ws')

  // 端口文件是 Chrome 自己写的;它不在 = 那个档案此刻没有 Chrome 活着。
  const port = await readDevToolsPort(profileDir, Date.now() + 3_000)
    .catch(() => { throw new Error('登录窗口没开着') })
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as
    { type?: string, webSocketDebuggerUrl?: string }[]
  const page = list.find(item => item.type === 'page' && item.webSocketDebuggerUrl !== undefined)
  const wsUrl = page?.webSocketDebuggerUrl
  if (wsUrl === undefined) throw new Error('登录窗口没开着')

  return await new Promise<T>((resolve, reject) => {
    const socket = new WebSocket(wsUrl)
    let id = 0
    const pending = new Map<number, (result: unknown) => void>()
    const call: CdpCall = (method, params) => new Promise((done) => {
      const next = ++id
      pending.set(next, done)
      socket.send(JSON.stringify({ id: next, method, params }))
    })
    const finish = (fn2: () => void): void => {
      try { socket.close() } catch { /* 已经关了 */ }
      fn2()
    }
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
    socket.on('error', (error: Error) => { finish(() => reject(error)) })
    socket.on('open', () => {
      void fn(call)
        .then(value => finish(() => resolve(value)))
        .catch((error: Error) => finish(() => reject(error)))
    })
  })
}

/** 真家伙。生产接线用这一个;用例里换成桩。 */
export function createXhsBrowser(chromePath?: string): XhsBrowser {
  return {
    openWindow: async (profileDir, url) => await openProfileWindow(profileDir, url, chromePath),
    currentUrls: async (profileDir) => {
      const port = await readDevToolsPort(profileDir, Date.now() + 3_000)
        .catch(() => { throw new Error('登录窗口没开着') })
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as { type?: string, url?: string }[]
      return list.filter(item => item.type === 'page' && typeof item.url === 'string').map(item => item.url as string)
    },
    readPage: async (profileDir, url, switchTo) => await withCdp(
      profileDir,
      async call => await readPageWith(call, url, undefined, undefined, switchTo),
    ),
  }
}
