// @vitest-environment node
/**
 * **豆包办公在跑,工作台却说它做完了**(2026-09-28,Air 本机热修复并回源码)。
 *
 * 现场:豆包办公(`com.work.pc.doubao`)跑任务时那颗停止键是个没字的图标,壳读不进 `stop`;
 * 窗口上明明写着「正在写入文件 / 正在思考 / 正在执行代码」,可 `nextWindowState` 只看 `summary.busy`
 * → 判空闲 → 映射成做完。气泡和事务官卡片读的是同一份状态,两处一起没了。
 *
 * 补法(只补豆包办公这一个包,别家一行不动):
 * - 输入框上方、对话区**最后一行**逐字是一句执行进度 → 算在跑;
 * - 侧栏里的、按钮里的、输入框里的字不算;
 * - 之前已经看见它在跑,两步之间那一下空档**再等 30 秒**才算做完(同一条对话才等,换了对话不等);
 * - 从没看见它在跑,普通空闲对话的字怎么变都不凭空起一件事。
 */
import { describe, expect, it } from 'vitest'
import { summarizeRead, windowProgressBusy, type WindowRead } from '../src/server/agentWindowModel.ts'

const DOUBAO = 'com.work.pc.doubao'
const INPUT = { x: 300, y: 700, w: 600, h: 80 }
const SIDEBAR = { x: 0, y: 0, w: 240, h: 900 }

function read(tail: WindowRead['tail'], extra: Partial<WindowRead> = {}): WindowRead {
  return { running: true, window: { w: 1100, h: 900 }, input: INPUT, sidebar: SIDEBAR, stop: [], tail, side: [], ...extra }
}
const row = (t: string, y: number, more: { ctl?: boolean, x?: number } = {}) => ({ x: more.x ?? 320, y, w: 400, h: 20, t, ...(more.ctl ? { ctl: true } : {}) })

const T0 = 1_000_000

describe('豆包办公:窗口上写着「正在…」就是在跑', () => {
  it('★最后一行是「正在写入文件」→ 在跑', () => {
    const got = windowProgressBusy({ bundleId: DOUBAO, read: read([row('帮我查国庆放假安排', 200), row('正在写入文件', 640)]), title: '国庆节放假安排咨询', nowMs: T0 })
    expect(got.busy).toBe(true)
    expect(got.seen).toMatchObject({ at: T0, title: '国庆节放假安排咨询' })
  })

  it('「正在思考…」「正在执行代码」也算', () => {
    for (const t of ['正在思考…', '正在执行代码', '正在思考...']) {
      expect(windowProgressBusy({ bundleId: DOUBAO, read: read([row(t, 640)]), nowMs: T0 }).busy).toBe(true)
    }
  })

  // 10-08 起各家都认(原来只认 Air 上的 com.work.pc.doubao —— 本机的豆包、千问办公都漏了)。
  it('★别家的窗上写着同样的进度 → 一样算在跑', () => {
    for (const bundleId of ['im.manus.desktop', 'com.bot.pc.doubao', 'cn.qwenwork.desktop.mac']) {
      expect(windowProgressBusy({ bundleId, read: read([row('正在写入文件', 640)]), nowMs: T0 }).busy).toBe(true)
    }
  })

  it('★千问办公:「正在思考」「...」「7.3s」三块排在同一行 → 拼成一行再认', () => {
    const qwen = read([
      row('你看', 248, { x: 874 }),
      { x: 339, y: 642, w: 49, h: 15, t: '正在思考' },
      { x: 387, y: 642, w: 12, h: 15, t: '...' },
      { x: 872, y: 643, w: 30, h: 14, t: '7.3s' },
    ])
    expect(windowProgressBusy({ bundleId: 'cn.qwenwork.desktop.mac', read: qwen, nowMs: T0 }).busy).toBe(true)
  })

  it('★千问办公另一种写法:「处理中」「...」「0.8s」→ 在跑;「思考中…」「生成中」也算', () => {
    for (const t of ['处理中', '思考中…', '生成中']) {
      const qwen = read([{ x: 339, y: 642, w: 49, h: 15, t }, { x: 872, y: 643, w: 30, h: 14, t: '0.8s' }])
      expect(windowProgressBusy({ bundleId: 'cn.qwenwork.desktop.mac', read: qwen, nowMs: T0 }).busy).toBe(true)
    }
  })

  it('「正在」后面是一整句话(回答里的一句)→ 不算', () => {
    expect(windowProgressBusy({ bundleId: 'cn.qwenwork.desktop.mac', read: read([row('正在为你整理三段产品介绍,先说第一段的思路。', 640)]), nowMs: T0 }).busy).toBe(false)
  })

  it('英文进度(Thinking… / Working 12s)也算', () => {
    for (const t of ['Thinking…', 'Working 12s', 'Generating...']) {
      expect(windowProgressBusy({ bundleId: 'x.y', read: read([row(t, 640)]), nowMs: T0 }).busy).toBe(true)
    }
  })

  it('按钮里的字、侧栏里的字、输入框里的字 → 都不算', () => {
    expect(windowProgressBusy({ bundleId: DOUBAO, read: read([row('正在写入文件', 640, { ctl: true })]), nowMs: T0 }).busy).toBe(false)
    expect(windowProgressBusy({ bundleId: DOUBAO, read: read([row('正在写入文件', 640, { x: 20 })]), nowMs: T0 }).busy).toBe(false)
    expect(windowProgressBusy({ bundleId: DOUBAO, read: read([row('正在写入文件', 720)]), nowMs: T0 }).busy).toBe(false)
  })

  it('不是最后一行(后面已经有最终回答)→ 不算;只是句子里带着这几个字 → 不算', () => {
    expect(windowProgressBusy({ bundleId: DOUBAO, read: read([row('正在写入文件', 400), row('2026 年国庆放假 10 月 1 日至 8 日,共 8 天。', 640)]), nowMs: T0 }).busy).toBe(false)
    expect(windowProgressBusy({ bundleId: DOUBAO, read: read([row('我刚才正在写入文件的时候出了错', 640)]), nowMs: T0 }).busy).toBe(false)
  })

  it('读不到窗口 → 不算', () => {
    expect(windowProgressBusy({ bundleId: DOUBAO, read: { running: true, ax_err: -25204, stop: [], tail: [], side: [] }, nowMs: T0 }).busy).toBe(false)
  })
})

describe('两步之间那一下空档:看见过在跑,再等 30 秒才算做完', () => {
  const seen = { at: T0, title: '国庆节放假安排咨询' }
  const between = read([row('帮我查国庆放假安排', 200), row('已写入 holiday.md', 640)])

  it('★同一条对话、空档不到 30 秒 → 还算在跑', () => {
    const got = windowProgressBusy({ bundleId: DOUBAO, read: between, title: '国庆节放假安排咨询', nowMs: T0 + 12_000, seen })
    expect(got.busy).toBe(true)
    expect(got.seen).toEqual(seen)
  })

  it('★满 30 秒还没新的进度 → 做完了', () => {
    const got = windowProgressBusy({ bundleId: DOUBAO, read: between, title: '国庆节放假安排咨询', nowMs: T0 + 30_000, seen })
    expect(got.busy).toBe(false)
    expect(got.seen).toBeUndefined()
  })

  it('换了一条对话 → 不等', () => {
    expect(windowProgressBusy({ bundleId: DOUBAO, read: between, title: '别的对话', nowMs: T0 + 5_000, seen }).busy).toBe(false)
  })

  it('★从没看见过它在跑 → 空闲对话的字怎么变都不算', () => {
    expect(windowProgressBusy({ bundleId: DOUBAO, read: between, title: '国庆节放假安排咨询', nowMs: T0 }).busy).toBe(false)
  })
})

/**
 * **藏在后台的 Chromium 窗不刷新**(2026-10-08 千问办公真机):她切走之后窗被 ⌘H 藏着,辅助功能树停在藏起那一刻 ——
 * 「规划中 ... 13.7s」挂了三分钟,秒表一下没动;放出来一读,进度条早没了、回答已经在了。
 * 秒表停住 = 读到的是一张停住的画面,不再凭它算在跑(10 秒);进度行也不当「最新一句」。
 */
describe('秒表停住了:读到的是停住的画面', () => {
  const frozen = (timer: string) => read([
    row('但是总感觉有点智商税呢', 109),
    { x: 339, y: 642, w: 37, h: 15, t: '规划中' },
    { x: 375, y: 642, w: 12, h: 15, t: '...' },
    { x: 872, y: 643, w: 37, h: 14, t: timer },
  ])

  it('★同一条对话、秒表 10 秒没动 → 不算在跑', () => {
    const first = windowProgressBusy({ bundleId: 'cn.qwenwork.desktop.mac', read: frozen('13.7s'), title: 'A', nowMs: T0 })
    expect(first.busy).toBe(true)
    const mid = windowProgressBusy({ bundleId: 'cn.qwenwork.desktop.mac', read: frozen('13.7s'), title: 'A', nowMs: T0 + 5_000, ...(first.seen === undefined ? {} : { seen: first.seen }) })
    expect(mid.busy).toBe(true)
    const late = windowProgressBusy({ bundleId: 'cn.qwenwork.desktop.mac', read: frozen('13.7s'), title: 'A', nowMs: T0 + 11_000, ...(mid.seen === undefined ? {} : { seen: mid.seen }) })
    expect(late.busy).toBe(false)
    // 再读还是那张画面:照旧不算(不因「看见过在跑」的空档又续上)。
    const again = windowProgressBusy({ bundleId: 'cn.qwenwork.desktop.mac', read: frozen('13.7s'), title: 'A', nowMs: T0 + 16_000, ...(late.seen === undefined ? {} : { seen: late.seen }) })
    expect(again.busy).toBe(false)
  })

  it('秒表在走 → 一直算在跑', () => {
    let seen = windowProgressBusy({ bundleId: 'q', read: frozen('1.0s'), title: 'A', nowMs: T0 }).seen
    for (const [i, t] of ['12.0s', '40.0s', '70.0s'].entries()) {
      const got = windowProgressBusy({ bundleId: 'q', read: frozen(t), title: 'A', nowMs: T0 + (i + 1) * 30_000, ...(seen === undefined ? {} : { seen }) })
      expect(got.busy).toBe(true)
      seen = got.seen
    }
  })

  it('★进度行不当「最新一句」', () => {
    const got = summarizeRead({ ...frozen('13.7s'), title: '千问办公' }, '千问办公', [])
    expect(got.latest).toBe('但是总感觉有点智商税呢')
  })
})

describe('带秒表的进度条消失就是做完(10-08 千问办公)', () => {
  it('★看见过「处理中 ... 3.2s」,下一拍进度条没了 → 当场不算在跑(不等 30 秒空档)', () => {
    const bar = read([row('帮我写三段介绍', 200), { x: 339, y: 642, w: 49, h: 15, t: '处理中' }, { x: 872, y: 643, w: 30, h: 14, t: '3.2s' }])
    const seen = windowProgressBusy({ bundleId: 'q', read: bar, title: 'A', nowMs: T0 }).seen
    const after = read([row('帮我写三段介绍', 200), row('第一段:……', 400)])
    expect(windowProgressBusy({ bundleId: 'q', read: after, title: 'A', nowMs: T0 + 5_000, ...(seen === undefined ? {} : { seen }) }).busy).toBe(false)
  })
})
