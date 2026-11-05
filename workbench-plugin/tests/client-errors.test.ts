/**
 * 页面自己报错(2026-09-25,卡 V)。
 *
 * 09-25 晚维护者点「事务官」没反应、页面卡死 —— 而**没有任何地方记录**。壳是 WKWebView,
 * 那个控制台他打不开、统筹也看不到,第二天只能靠他复述。
 */
import { describe, expect, it, vi } from 'vitest'
import { CLIENT_ERROR_KEEP, CLIENT_ERROR_STACK_LINES, createClientErrorStore } from '../src/server/clientErrors.ts'
import { MAX_PER_KEY, MAX_TOTAL, installClientErrorReporter } from '../src/client/reportClientError.ts'

const AT = '2026-09-25T13:00:00.000Z'

describe('服务端那只盒子', () => {
  it('记一条:一句话 + 栈的前几行 + 在哪一页 + 哪一头', () => {
    const store = createClientErrorStore()
    const entry = store.record({ message: '点「事务官」没反应', stack: 'at Butler\nat Overlay\nat App', view: 'butler', where: 'desktop' }, AT)
    expect(entry).toMatchObject({ at: AT, where: 'desktop', message: '点「事务官」没反应', view: 'butler', count: 1 })
    expect(store.list()).toHaveLength(1)
  })

  it('往日志里写一行(统筹 grep 得到)', () => {
    const lines: string[] = []
    const store = createClientErrorStore({ log: line => lines.push(line) })
    store.record({ message: 'Cannot read properties of undefined', stack: 'at sceneProgressLine', where: 'phone' }, AT)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('[client-error]')
    expect(lines[0]).toContain('phone')
    expect(lines[0]).toContain('Cannot read properties of undefined')
  })

  it('★同一条折叠成一行、只加计数 —— 一条死循环不许冲掉别的', () => {
    const store = createClientErrorStore({ keep: 3 })
    for (let i = 0; i < 40; i++) store.record({ message: '每帧都抛', stack: 'at Orb' }, AT)
    store.record({ message: '另一条', stack: 'at Inbox' }, AT)
    expect(store.list()).toHaveLength(2)
    expect(store.list().find(one => one.message === '每帧都抛')?.count).toBe(40)
  })

  it('只留最近几条,环形替换', () => {
    const store = createClientErrorStore({ keep: 3 })
    for (const n of [1, 2, 3, 4, 5]) store.record({ message: `第 ${n} 条`, stack: `at f${n}` }, AT)
    expect(store.list().map(one => one.message)).toEqual(['第 5 条', '第 4 条', '第 3 条'])
  })

  it('默认留 20 条', () => {
    const store = createClientErrorStore()
    for (let n = 0; n < 40; n++) store.record({ message: `第 ${n} 条`, stack: `at f${n}` }, AT)
    expect(store.list()).toHaveLength(CLIENT_ERROR_KEEP)
  })

  it('截过再存:一句话与栈都有上限(不把 /state 撑大到手机上拉不动)', () => {
    const store = createClientErrorStore()
    const entry = store.record({ message: 'x'.repeat(2000), stack: Array.from({ length: 50 }, (_, i) => `at f${i}`).join('\n') }, AT)
    expect([...(entry?.message ?? '')].length).toBeLessThanOrEqual(241)
    expect((entry?.stack ?? '').split('\n')).toHaveLength(CLIENT_ERROR_STACK_LINES)
  })

  it('连一句话都凑不出来:不记一条空的(D13)', () => {
    const store = createClientErrorStore()
    expect(store.record({}, AT)).toBeUndefined()
    expect(store.record({ message: '   ' }, AT)).toBeUndefined()
    expect(store.list()).toHaveLength(0)
  })

  it('认不出的 where 一律按电脑算(不猜出第三种)', () => {
    const store = createClientErrorStore()
    expect(store.record({ message: '一条', where: 'moon' }, AT)?.where).toBe('desktop')
  })
})

describe('客户端那两个口子', () => {
  function fakeWindow() {
    const listeners = new Map<string, (event: unknown) => void>()
    return {
      target: {
        addEventListener: (type: string, listener: (event: unknown) => void) => { listeners.set(type, listener) },
        removeEventListener: (type: string) => { listeners.delete(type) },
      },
      fire: (type: string, event: unknown) => listeners.get(type)?.(event),
      has: (type: string) => listeners.has(type),
    }
  }

  it('window.onerror → 报一条(带栈)', async () => {
    const win = fakeWindow()
    const fetchImpl = vi.fn(async () => new Response('{"ok":true}'))
    installClientErrorReporter({ baseUrl: 'http://x', fetchImpl: fetchImpl as unknown as typeof fetch, view: () => 'butler' }, win.target)
    const error = new Error('点「事务官」没反应')
    error.stack = 'Error: 点「事务官」没反应\n    at Butler'
    win.fire('error', { error, message: error.message })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('http://x/client/error')
    const body = JSON.parse(String(init.body)) as Record<string, unknown>
    expect(body).toMatchObject({ message: '点「事务官」没反应', view: 'butler', where: 'desktop' })
    expect(String(body.stack)).toContain('at Butler')
  })

  it('unhandledrejection → 也报一条', () => {
    const win = fakeWindow()
    const fetchImpl = vi.fn(async () => new Response('{}'))
    installClientErrorReporter({ baseUrl: 'http://x', fetchImpl: fetchImpl as unknown as typeof fetch }, win.target)
    win.fire('unhandledrejection', { reason: new Error('取状态失败') })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(JSON.parse(String((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body))).toMatchObject({ message: '取状态失败' })
  })

  it('★报错这一发失败了不许再报 —— 否则一次网络抖动就能打成死循环', async () => {
    const win = fakeWindow()
    const fetchImpl = vi.fn(async () => { throw new Error('network down') })
    installClientErrorReporter({ baseUrl: 'http://x', fetchImpl: fetchImpl as unknown as typeof fetch }, win.target)
    win.fire('error', { message: '第一条' })
    await Promise.resolve()
    await Promise.resolve()
    // 只发了一次:那一次失败被吞掉,没有再触发一轮。
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('★同一条最多报几次(每帧都抛的那种)', () => {
    const win = fakeWindow()
    const fetchImpl = vi.fn(async () => new Response('{}'))
    installClientErrorReporter({ baseUrl: 'http://x', fetchImpl: fetchImpl as unknown as typeof fetch }, win.target)
    for (let i = 0; i < 30; i++) win.fire('error', { message: '每帧都抛' })
    expect(fetchImpl).toHaveBeenCalledTimes(MAX_PER_KEY)
  })

  it('一共不超过上限', () => {
    const win = fakeWindow()
    const fetchImpl = vi.fn(async () => new Response('{}'))
    installClientErrorReporter({ baseUrl: 'http://x', fetchImpl: fetchImpl as unknown as typeof fetch }, win.target)
    for (let i = 0; i < MAX_TOTAL + 20; i++) win.fire('error', { message: `第 ${i} 条` })
    expect(fetchImpl).toHaveBeenCalledTimes(MAX_TOTAL)
  })

  it('连一句话都凑不出来的事件:不发', () => {
    const win = fakeWindow()
    const fetchImpl = vi.fn(async () => new Response('{}'))
    installClientErrorReporter({ baseUrl: 'http://x', fetchImpl: fetchImpl as unknown as typeof fetch }, win.target)
    win.fire('error', {})
    win.fire('unhandledrejection', { reason: undefined })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('dispose 拆掉两个口子', () => {
    const win = fakeWindow()
    const reporter = installClientErrorReporter({ baseUrl: 'http://x', fetchImpl: (async () => new Response('{}')) as unknown as typeof fetch }, win.target)
    expect(win.has('error')).toBe(true)
    reporter.dispose()
    expect(win.has('error')).toBe(false)
    expect(win.has('unhandledrejection')).toBe(false)
  })
})
