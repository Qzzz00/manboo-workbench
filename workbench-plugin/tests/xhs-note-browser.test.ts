// @vitest-environment node
/**
 * ★★ 这一份钉的是**整张卡最值钱的那句话**:「代码里没有一行能点东西」。
 *
 * 它守的不是"界面上没放按钮",是**能力不存在**(同 inbox.ts 与 meeting.ts 的纪律):
 *
 * | 钉什么 | 破了会怎样 |
 * |---|---|
 * | 只发 `Page.navigate` 与 `Runtime.evaluate` 两种调用 | 多出 `Input.` 就是能模拟鼠标键盘了,离"点个赞"只差一个函数调用 |
 * | 表达式就那五条,逐字 | 多一条就是多一件我们没跟用户说过的事 |
 * | 调用里不出现 cookie / localStorage / sessionStorage | 红线第 5 条:一个凭据都不取 |
 * | 滚动只是 `window.scrollTo` | Ben 2026-09-22 B2:承诺维持「不点」,滚动不算点 |
 * | 风控页上**一下都不滚** | 在一堵墙面前反复滚动是最像机器的行为,而且一条也采不到 |
 * | 滚动有上限,不为凑满 100 条一直滚 | 滚动次数就是请求量,请求量就是风险量 |
 *
 * 外加一条**源码扫描**:`xhsNoteBrowser.ts` 与 `xhsCollect.ts` 两个文件里
 * 一个 `Input.` 字样都没有。
 */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  MAX_SCROLL_ROUNDS, NOTE_EXPRESSIONS, STAGNANT_ROUNDS, readNoteWith,
} from '../src/server/xhsNoteBrowser.ts'
import {
  FAKE_BLOCKED_PAGE_TEXT, FAKE_CAPTCHA_PAGE_TEXT, FAKE_NOTE_PAYLOAD, FAKE_NOTE_URL,
  REAL_LOGGED_OUT_EXPLORE_TEXT, REAL_LOGGED_OUT_HREF, REAL_LOGGED_OUT_PAYLOAD,
} from './xhsNoteFixtures.ts'

const nap = async (): Promise<void> => { /* 用例里不真的等 */ }

interface Call { method: string, expression?: string }

/**
 * 一个假的调试会话。
 *
 * `commentsPerRound` 是"每滚一下评论条数变成多少" —— 用它来演"滚到底了"
 * 与"一直滚得动"两种情形。
 */
function session(options: {
  payload?: string
  text?: string
  href?: string
  counts?: number[]
} = {}) {
  const calls: Call[] = []
  const counts = [...(options.counts ?? [10])]
  let scrolled = 0
  const call = async (method: string, params: unknown): Promise<unknown> => {
    const expression = method === 'Runtime.evaluate'
      ? String((params as { expression: string }).expression)
      : undefined
    calls.push({ method, ...(expression === undefined ? {} : { expression }) })
    if (expression === NOTE_EXPRESSIONS.href) return { result: { value: options.href ?? FAKE_NOTE_URL } }
    if (expression === NOTE_EXPRESSIONS.text) return { result: { value: options.text ?? '假标题\n假作者' } }
    if (expression === NOTE_EXPRESSIONS.payload) return { result: { value: options.payload ?? FAKE_NOTE_PAYLOAD } }
    if (expression === NOTE_EXPRESSIONS.scroll) { scrolled++; return { result: { value: '' } } }
    if (expression === NOTE_EXPRESSIONS.count) {
      return { result: { value: String(counts[Math.min(scrolled, counts.length - 1)] ?? 0) } }
    }
    return { result: { value: '' } }
  }
  return { calls, call, scrolls: () => scrolled }
}

describe('★ 只读:这条路能发出去的东西就这些', () => {
  it('只有 Page.navigate 与 Runtime.evaluate 两种方法', async () => {
    const stub = session({ counts: [10, 40, 80, 120] })
    await readNoteWith(stub.call, FAKE_NOTE_URL, { sleep: nap })
    expect([...new Set(stub.calls.map(one => one.method))].sort()).toEqual(['Page.navigate', 'Runtime.evaluate'])
  })

  it('表达式就那五条,逐字,一条不多', async () => {
    const stub = session({ counts: [10, 40, 80, 120] })
    await readNoteWith(stub.call, FAKE_NOTE_URL, { sleep: nap })
    const used = [...new Set(stub.calls.map(one => one.expression).filter((one): one is string => one !== undefined))]
    expect(used.sort()).toEqual([...Object.values(NOTE_EXPRESSIONS)].sort())
  })

  it('★ 调用里不出现 Input. / DOM. / Network.,也不出现任何凭据字样', async () => {
    const stub = session({ counts: [10, 40, 80, 120] })
    await readNoteWith(stub.call, FAKE_NOTE_URL, { sleep: nap })
    const all = stub.calls.map(one => `${one.method} ${one.expression ?? ''}`).join('\n')
    for (const word of ['Input.', 'DOM.', 'Network.', 'cookie', 'localStorage', 'sessionStorage', 'click', 'Runtime.enable']) {
      expect(all).not.toContain(word)
    }
  })

  it('★ 唯一让页面动的那一句就是 window.scrollTo —— 没有第二种', () => {
    expect(NOTE_EXPRESSIONS.scroll).toBe('window.scrollTo(0, document.body.scrollHeight), ""')
    // 另外四条一个副作用都没有:全是读。
    for (const key of ['href', 'text', 'payload', 'count'] as const) {
      expect(NOTE_EXPRESSIONS[key]).not.toContain('scrollTo')
      expect(NOTE_EXPRESSIONS[key]).not.toContain('=')
    }
  })
})

describe('滚动:够了就停,墙上不滚', () => {
  it('评论条数够 100 就不再滚', async () => {
    const stub = session({ counts: [10, 60, 120] })
    const read = await readNoteWith(stub.call, FAKE_NOTE_URL, { sleep: nap })
    expect(read.scrolls).toBe(2)
  })

  it('连着几轮涨不动就停(不是一直滚到上限)', async () => {
    const stub = session({ counts: [10] })
    const read = await readNoteWith(stub.call, FAKE_NOTE_URL, { sleep: nap })
    expect(read.scrolls).toBe(STAGNANT_ROUNDS)
    expect(read.scrolls).toBeLessThan(MAX_SCROLL_ROUNDS)
  })

  it('★ 一直涨得动也有上限 —— 不为凑满 100 条无限滚', async () => {
    // 每一轮都 +1,永远到不了 100。
    const stub = session({ counts: Array.from({ length: 200 }, (_, i) => 10 + i) })
    const read = await readNoteWith(stub.call, FAKE_NOTE_URL, { sleep: nap, maxScrolls: 5 })
    expect(read.scrolls).toBe(5)
  })

  it('★ 未登录:一下都不滚,当场回', async () => {
    const stub = session({ href: 'https://www.xiaohongshu.com/login?redirectPath=x', payload: '' })
    const read = await readNoteWith(stub.call, FAKE_NOTE_URL, { sleep: nap })
    expect(read.scrolls).toBe(0)
    expect(stub.calls.some(one => one.expression === NOTE_EXPRESSIONS.scroll)).toBe(false)
  })

  it('★ 风控页(拿不到 payload):一下都不滚,当场回,并把页面文字交出去让上层判', async () => {
    const stub = session({ payload: '""', text: FAKE_BLOCKED_PAGE_TEXT })
    const read = await readNoteWith(stub.call, FAKE_NOTE_URL, { sleep: nap })
    expect(read.scrolls).toBe(0)
    expect(read.payload).toBe('')
    expect(read.text).toContain('当前笔记暂时无法浏览')
  })

  /**
   * ★★ **回归:2026-09-22 真跑出来的那个 bug。**
   *
   * 不登录打开一条公开笔记链接,站点**没有**把我们跳到 `/login`,而是跳到
   * `/explore` 并盖了一张登录卡片;`noteDetailMap` 那个对象**照样存在**。
   * 当时的判据("URL 里有 /login,或者 payload 是空的")一条都没命中,
   * 于是代码**在一堵登录墙上滚了 3 下** —— 那是承诺里明说不做的事。
   *
   * 夹具是那一趟真抓下来的页面文字(tests/xhsNoteFixtures.ts)。
   */
  it('★★ 未登录被跳到 /explore(不是 /login)、payload 还非空 —— 照样一下都不滚', async () => {
    const stub = session({
      href: REAL_LOGGED_OUT_HREF,
      text: REAL_LOGGED_OUT_EXPLORE_TEXT,
      payload: REAL_LOGGED_OUT_PAYLOAD,
      counts: [0, 10, 20],
    })
    const read = await readNoteWith(stub.call, FAKE_NOTE_URL, { sleep: nap })
    expect(read.scrolls).toBe(0)
    expect(stub.calls.some(one => one.expression === NOTE_EXPRESSIONS.scroll)).toBe(false)
  })

  it('★ 风控页 / 验证码页(payload 非空)同样一下都不滚', async () => {
    for (const text of [FAKE_BLOCKED_PAGE_TEXT, FAKE_CAPTCHA_PAGE_TEXT]) {
      const stub = session({ text, payload: FAKE_NOTE_PAYLOAD, counts: [0, 10, 20] })
      const read = await readNoteWith(stub.call, FAKE_NOTE_URL, { sleep: nap })
      expect(read.scrolls).toBe(0)
    }
  })

  it('滚过之后会把 payload 再读一次(不然拿到的是滚动前那一份)', async () => {
    const stub = session({ counts: [10, 120] })
    await readNoteWith(stub.call, FAKE_NOTE_URL, { sleep: nap })
    const payloadReads = stub.calls.filter(one => one.expression === NOTE_EXPRESSIONS.payload).length
    const scrollAt = stub.calls.findIndex(one => one.expression === NOTE_EXPRESSIONS.scroll)
    const lastPayloadAt = stub.calls.map(one => one.expression).lastIndexOf(NOTE_EXPRESSIONS.payload)
    expect(payloadReads).toBeGreaterThan(1)
    expect(lastPayloadAt).toBeGreaterThan(scrollAt)
  })
})

/**
 * 把注释剥掉再扫。
 *
 * 为什么必须剥:这几个文件的注释里**逐字写着**「不装 stealth、不改 `navigator.webdriver`」——
 * 那正是我们要它们写着的话。不剥注释,这条用例就会因为"文档写得对"而变红,
 * 于是下一个人会去删掉那段注释来让它变绿 —— 那正好是最坏的结果。
 */
function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

describe('★ 源码扫描:这几个文件里不存在"点"这个能力', () => {
  it.each(['xhsNoteBrowser.ts', 'xhsCollect.ts', 'xhsNoteText.ts'])('%s 里没有 Input. 域', async (name) => {
    const source = codeOnly(await readFile(fileURLToPath(new URL(`../src/server/${name}`, import.meta.url)), 'utf8'))
    expect(source).not.toContain('Input.')
    expect(source).not.toMatch(/dispatchMouseEvent|dispatchKeyEvent|dispatchTouchEvent/)
  })

  it('★ 也没有 stealth / 改指纹 / 换 UA / 代理池那一类东西', async () => {
    const source = codeOnly(await readFile(fileURLToPath(new URL('../src/server/xhsNoteBrowser.ts', import.meta.url)), 'utf8'))
    for (const word of ['stealth', 'navigator.webdriver', 'setUserAgentOverride', 'proxy-server', '--headless']) {
      expect(source).not.toContain(word)
    }
  })
})
