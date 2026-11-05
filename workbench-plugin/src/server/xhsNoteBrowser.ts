/**
 * 用那份专用 Chrome 档案打开**一条笔记页**,把笔记与评论读回来(2026-09-22)。
 *
 * 这是采集类三项里**唯一真的碰网络**的地方,所以红线逐条落在这个文件:
 *
 * | 红线 | 落在哪一行 |
 * |---|---|
 * | 只从用户自己给的链接进 | 这里不拼任何地址:`url` 是 `xhsNoteText.parseNoteLink` 认过的那一条,原样用 |
 * | **不点任何东西** | 这个文件里只发两种 DevTools 调用:`Page.navigate` 与 `Runtime.evaluate`。**没有 `Input.` 域**,连 import 都没有。表达式清单见 {@link NOTE_EXPRESSIONS} |
 * | 不做反检测伪装 | 不开 `Runtime.enable`、不改 `navigator.webdriver`、不换 UA、不装 stealth、不用代理。就是他自己那个 Chrome |
 * | 一个凭据都不取 | 没有一行读 cookie / localStorage / sessionStorage。登录态自始至终只在 Chrome 档案目录里 |
 * | 遇到验证码/风控就停 | 判据在 `xhsNoteText.wallOf`,这里只负责把页面文字原样交出去 |
 *
 * ## ★ 滚动这件事,写明白
 *
 * 小红书的评论是懒加载的:不滚动,页面上就没有第 11 条以后的评论
 * (预研第 3.3 节)。Ben 2026-09-22 定:**承诺维持「不点」,只采集,滚动不算点**。
 *
 * 所以这里的滚动是 `Runtime.evaluate` 里跑一句 `window.scrollTo(...)` ——
 * **协议上仍然只发 `Runtime.evaluate`,一个 `Input.` 域的调用都没有**,
 * 也就是说"代码里没有一行能点东西"这句话仍然是真的:
 * 这份代码连"点"这个动作的 API 都不认识。
 *
 * 滚动到什么时候停:评论条数不再涨(连着 {@link STAGNANT_ROUNDS} 轮)、
 * 或者已经够 {@link COMMENT_MAX} 条、或者到了 {@link MAX_SCROLL_ROUNDS} 轮上限。
 * **绝不为了凑满 100 条一直滚下去** —— 滚动次数就是请求量,请求量就是风险量。
 *
 * ## 为什么读 `__INITIAL_STATE__` 而不是只读 `innerText`
 *
 * 数据复盘那条路只读 `document.body.innerText`,因为它要的就是屏幕上那八个数。
 * 这里不行:**源视频直链、图片直链、发布时间戳、每条评论的赞数,
 * 在 innerText 里根本不存在**。它们在同一个页面的一个 JS 全局变量里
 * (`window.__INITIAL_STATE__`,yt-dlp 的 `XiaoHongShuIE` 与
 * `xiaohongshu-mcp` 的 `extractFeedDetail` 读的都是它)。
 *
 * 这仍然是**只读**:不调它的私有接口、不算签名、不发一条我们自己的 XHR ——
 * 读的是他那个浏览器**已经下载到本地、已经渲染在他眼前**的那一页的内存。
 * 但它确实比"页面上看得见的字"多一点,所以**设置界面上那段承诺里逐字写了这一句**
 * (client/CredentialPanel.tsx 的采集类那一段),不藏着。
 */
import { openProfileWindow, readDevToolsPort } from './webLogin.ts'
import { COMMENT_MAX, wallOf } from './xhsNoteText.ts'

/** 滚动最多几轮。够 100 条评论通常十来轮,给 30 轮封顶 —— 不为凑满一直滚。 */
export const MAX_SCROLL_ROUNDS = 30

/** 连着几轮评论条数不涨就算到底了。 */
export const STAGNANT_ROUNDS = 3

/** 每滚一下等多久(毫秒)。比人手快,但不是机枪。 */
export const SCROLL_WAIT_MS = 900

/**
 * 这条路一共会发的 `Runtime.evaluate` 表达式,**就这五条**。
 *
 * 逐字写在这里(而不是散在函数体里)是为了让用例能一行钉死:
 * 多出来第六条、或者哪条里混进 `click` / `cookie`,当场红。
 */
export const NOTE_EXPRESSIONS = {
  /** 页面此刻停在哪(被跳到 /login 就是没登录)。 */
  href: 'location.href',
  /** 页面上看得见的字 —— 判风控墙、判验证码用的就是它。 */
  text: 'document.body ? document.body.innerText : ""',
  /**
   * 笔记与评论那一份。**只读,不改一个字节**。
   * 字段形状见 xhsNoteText.ts 文件头(借自 xiaohongshu-mcp,Apache-2.0)。
   */
  payload: 'JSON.stringify((window.__INITIAL_STATE__ && window.__INITIAL_STATE__.note && window.__INITIAL_STATE__.note.noteDetailMap) || "")',
  /** 此刻页面上已经加载出来多少条评论。滚不滚得动看它。 */
  count: 'String((((window.__INITIAL_STATE__||{}).note||{}).noteDetailMap ? Object.values(window.__INITIAL_STATE__.note.noteDetailMap).reduce(function(n,v){return n+((v&&v.comments&&v.comments.list||[]).length)},0) : 0))',
  /**
   * ★ 滚一下。**这是这条路唯一会让页面动的一句**,而它只是滚动 ——
   * 不是点击、不是输入、不是提交。Ben 2026-09-22:滚动不算点。
   */
  scroll: 'window.scrollTo(0, document.body.scrollHeight), ""',
} as const

/** 从一条笔记页读回来的东西。**只有这四样**。 */
export interface NotePageRead {
  href: string
  /** `document.body.innerText`。 */
  text: string
  /** `JSON.stringify(noteDetailMap)` 的原文。读不到是空串。 */
  payload: string
  /** 一共滚了几下。**写进采集记录**,让他看得见我们让页面动了多少次。 */
  scrolls: number
}

type CdpCall = (method: string, params: unknown) => Promise<unknown>

function valueOf(result: unknown): string {
  const value = (result as { result?: { value?: unknown } }).result?.value
  return typeof value === 'string' ? value : ''
}

export interface ReadNoteOptions {
  sleep?: (ms: number) => Promise<void>
  maxScrolls?: number
  /** 够这么多条就不滚了。缺省 100(白板:单次 ≤100 条)。 */
  wantComments?: number
}

/**
 * 在一个已经连上的调试会话里打开一条笔记页并读回来(纯逻辑,可测)。
 *
 * 顺序刻意是「先读一次 → 发现是墙就立刻回」:**风控页上不滚动**。
 * 在一堵墙面前反复滚动是最像机器的行为,而且一次也采不到。
 */
export async function readNoteWith(
  call: CdpCall,
  url: string,
  options: ReadNoteOptions = {},
): Promise<NotePageRead> {
  const sleep = options.sleep ?? (ms => new Promise<void>(done => { setTimeout(done, ms) }))
  const maxScrolls = options.maxScrolls ?? MAX_SCROLL_ROUNDS
  const want = options.wantComments ?? COMMENT_MAX

  await call('Page.navigate', { url })

  const read = async (expression: string): Promise<string> =>
    valueOf(await call('Runtime.evaluate', { expression, returnByValue: true }))

  // 等页面把数据填进来:连着两拍读到的 payload 一样长就算稳了(同 xhsBrowser 的做法)。
  let payload = ''
  for (let round = 0; round < 8; round++) {
    await sleep(SCROLL_WAIT_MS)
    const next = await read(NOTE_EXPRESSIONS.payload)
    if (next !== '' && next !== '""' && next === payload) break
    payload = next
  }

  let href = await read(NOTE_EXPRESSIONS.href)
  let text = await read(NOTE_EXPRESSIONS.text)

  /**
   * ★ 是墙就到此为止:**一下都不滚**,不重试,不绕。
   *
   * 判据用的是 `xhsNoteText.wallOf` 那一份(登录 / 风控 / 验证码三种),**不是只看 URL 里有没有 `/login`**。
   *
   * 这一条是 2026-09-22 真跑出来的:不登录打开一条公开笔记链接,站点**并没有**把我们跳到
   * `/login`,而是跳到了 `/explore`(发现流)并在上面盖了一张登录卡片;
   * 而 `__INITIAL_STATE__.note.noteDetailMap` 那个对象**照样存在**(只是里面没有这条笔记)。
   * 于是"URL 里有 /login 或者 payload 是空的"这两条判据一条都不成立,
   * 代码一路走进滚动循环,**在一堵登录墙上滚了 3 下**——
   * 那是我们写在承诺里明说不做的事(墙上不动页面),而且一条也采不到。
   *
   * 编排层那一层当时是判对了的(它看的是页面文字),但"判对了"不等于"没做过"。
   * 所以判据挪到这里,滚动之前。
   */
  const wall = wallOf(href, text)
  if (wall !== undefined || payload === '' || payload === '""') {
    return { href, text, payload: payload === '""' ? '' : payload, scrolls: 0 }
  }

  // —— 滚动加载评论 ——
  let scrolls = 0
  let seen = Number(await read(NOTE_EXPRESSIONS.count)) || 0
  let stagnant = 0
  while (scrolls < maxScrolls && seen < want && stagnant < STAGNANT_ROUNDS) {
    await read(NOTE_EXPRESSIONS.scroll)
    scrolls++
    await sleep(SCROLL_WAIT_MS)
    const now = Number(await read(NOTE_EXPRESSIONS.count)) || 0
    if (now > seen) { seen = now; stagnant = 0 }
    else stagnant++
  }

  if (scrolls > 0) {
    payload = await read(NOTE_EXPRESSIONS.payload)
    href = await read(NOTE_EXPRESSIONS.href)
    text = await read(NOTE_EXPRESSIONS.text)
  }
  return { href, text, payload: payload === '""' ? '' : payload, scrolls }
}

/** 采集用的浏览器。抽成接口是为了让编排逻辑不开 Chrome 就能测。 */
export interface XhsNoteBrowser {
  openWindow: (profileDir: string, url: string) => Promise<number>
  readNote: (profileDir: string, url: string) => Promise<NotePageRead>
}

/** 连上那个档案的调试口,跑一段,然后断开。连不上就抛「登录窗口没开着」。 */
async function withCdp<T>(profileDir: string, fn: (call: CdpCall) => Promise<T>): Promise<T> {
  const { default: WebSocket } = await import('ws')

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
    const finish = (after: () => void): void => {
      try { socket.close() } catch { /* 已经关了 */ }
      after()
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
export function createXhsNoteBrowser(chromePath?: string): XhsNoteBrowser {
  return {
    openWindow: async (profileDir, url) => await openProfileWindow(profileDir, url, chromePath),
    readNote: async (profileDir, url) => await withCdp(profileDir, call => readNoteWith(call, url)),
  }
}
