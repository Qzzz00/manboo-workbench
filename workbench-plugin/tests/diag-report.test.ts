// @vitest-environment node
/**
 * 自动上报的限频与合并(2026-09-22)。
 *
 * 要钉死的四件事:
 *   ① 开关关着就一条都不发,**但编号照样有、本机日志照样写** ——
 *      「关掉上报」不等于「关掉排障」;
 *   ② 没登录(取不到设备令牌)不发、不排队、不落盘;
 *   ③ 一小时 20 条封顶,超了**合并计数**而不是丢掉;
 *   ④ 窗口滑过去之后,攒着的那一条带着次数发出去。
 */
import { describe, expect, it, vi } from 'vitest'

import { createDiagReporter, DIAG_HOURLY_LIMIT } from '../src/server/diagnostics/report.ts'

const T0 = Date.parse('2026-09-22T10:00:00.000Z')

function harness(options: { enabled?: boolean, linked?: boolean, status?: number } = {}) {
  let at = T0
  const sent: Record<string, unknown>[] = []
  const logged: string[] = []
  const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
    const status = options.status ?? 200
    return new Response(JSON.stringify({ id: 'x' }), { status })
  }) as unknown as typeof fetch
  const reporter = createDiagReporter({
    link: async () => (options.linked === false ? undefined : { relayUrl: 'https://api.example.cn', token: 'wb_假的假的假的假的' }),
    enabled: async () => options.enabled !== false,
    version: '0.2.54',
    now: () => at,
    fetchImpl,
    log: line => logged.push(line),
  })
  return {
    reporter,
    sent,
    logged,
    fetchImpl,
    tick: (ms: number) => { at += ms },
    boom: (message = '出事了') => reporter.report({ component: 'plugin', kind: 'unhandled', message }),
  }
}

describe('开关', () => {
  it('开着就发,body 里该有的都有', async () => {
    const h = harness()
    const out = await h.boom()
    expect(out.sent).toBe(true)
    expect(out.code).toMatch(/^WB-\d{6}$/)
    expect(h.sent[0]).toMatchObject({
      version: '0.2.54', component: 'plugin', kind: 'unhandled', merged: 1, code: out.code,
    })
  })

  it('关着一条都不发 —— 但编号照样有、本机日志照样写', async () => {
    const h = harness({ enabled: false })
    const out = await h.boom()
    expect(out.sent).toBe(false)
    expect(out.code).toMatch(/^WB-\d{6}$/)
    expect(h.sent.length).toBe(0)
    expect(h.logged[0]).toContain(out.code)
    expect(out.why).toContain('关着')
  })

  it('本机日志那一行里,编号在最前面(Ben 念的就是它)', async () => {
    const h = harness()
    const out = await h.boom('读 app.json 失败')
    expect(h.logged[0]).toBe(`[诊断] ${out.code} plugin/unhandled:读 app.json 失败`)
  })
})

describe('没登录', () => {
  it('取不到设备令牌就不发,而且说人话', async () => {
    const h = harness({ linked: false })
    const out = await h.boom()
    expect(out.sent).toBe(false)
    expect(out.why).toContain('还没连上服务器')
    expect(h.sent.length).toBe(0)
  })
})

describe('脱敏', () => {
  it('报错正文与栈里的路径用户名、令牌都擦过才出门', async () => {
    const h = harness()
    await h.reporter.report({
      component: 'worker',
      kind: 'crash_restart',
      message: '读 /Users/example/.dsh/workbench/app.json 失败',
      stack: ['at load (/Users/example/x.ts:1)', 'Bearer wb_zzzzzzzzzzzz'],
      log: ['dsh web: http://127.0.0.1:3080/?token=abcdefghijklmnop'],
    })
    const body = JSON.stringify(h.sent[0])
    expect(body).not.toContain('/Users/example')
    expect(body).not.toContain('wb_zzzz')
    expect(body).not.toContain('abcdefghijklmnop')
    expect(body).toContain('/Users/<用户>')
  })

  it('栈取前 20 行,日志取后 50 行', async () => {
    const h = harness()
    await h.reporter.report({
      component: 'plugin',
      kind: 'unhandled',
      message: 'x',
      stack: Array.from({ length: 50 }, (_, i) => `frame-${i}`),
      log: Array.from({ length: 200 }, (_, i) => `line-${i}`),
    })
    const body = h.sent[0] as { stack: string[], log: string[] }
    expect(body.stack.length).toBe(20)
    expect(body.stack[0]).toBe('frame-0')
    expect(body.log.length).toBe(50)
    expect(body.log[49]).toBe('line-199')
  })
})

describe('限频与合并', () => {
  it(`一小时 ${DIAG_HOURLY_LIMIT} 条封顶`, async () => {
    const h = harness()
    for (let i = 0; i < DIAG_HOURLY_LIMIT; i += 1) expect((await h.boom(`第 ${i} 次`)).sent).toBe(true)
    const over = await h.boom('同一个错')
    expect(over.sent).toBe(false)
    expect(over.why).toContain('合并计数')
    expect(h.sent.length).toBe(DIAG_HOURLY_LIMIT)
  })

  it('超了之后**合并而不是丢**:同一个错报 5 次,合并计数就是 5', async () => {
    const h = harness()
    for (let i = 0; i < DIAG_HOURLY_LIMIT; i += 1) await h.boom(`第 ${i} 次`)
    for (let i = 0; i < 5; i += 1) await h.boom('同一个错')
    expect(h.reporter.view().pending_merged).toBe(5)
  })

  it('窗口滑过去之后 pump 把攒着的那一条带着次数发出去', async () => {
    const h = harness()
    for (let i = 0; i < DIAG_HOURLY_LIMIT; i += 1) await h.boom(`第 ${i} 次`)
    for (let i = 0; i < 137; i += 1) await h.boom('崩溃循环')
    expect(h.sent.length).toBe(DIAG_HOURLY_LIMIT)

    h.tick(3_600_001)
    h.reporter.pump()
    await vi.waitFor(() => expect(h.sent.length).toBe(DIAG_HOURLY_LIMIT + 1))
    const merged = h.sent[DIAG_HOURLY_LIMIT] as { merged: number, message: string }
    expect(merged.merged).toBe(137)
    expect(merged.message).toBe('崩溃循环')
  })

  it('合并时留住**最早那个编号** —— Ben 念的多半是他第一次看见的那个', async () => {
    const h = harness()
    for (let i = 0; i < DIAG_HOURLY_LIMIT; i += 1) await h.boom(`第 ${i} 次`)
    const first = await h.boom('同一个错')
    h.tick(1000)
    const second = await h.boom('同一个错')
    expect(second.code).toBe(first.code)
  })

  it('不同的错各算一类,不会被合成一条', async () => {
    const h = harness()
    for (let i = 0; i < DIAG_HOURLY_LIMIT; i += 1) await h.boom(`第 ${i} 次`)
    await h.boom('错 A')
    await h.boom('错 B')
    expect(h.reporter.view().pending_merged).toBe(2)
  })

  it('view 说得出这一小时报了几条', async () => {
    const h = harness()
    await h.boom()
    await h.boom('另一个')
    expect(h.reporter.view()).toMatchObject({ sent_this_hour: 2, hourly_limit: DIAG_HOURLY_LIMIT })
  })
})

describe('发不出去的时候', () => {
  it('服务器 429 就说"服务器说满了",不抛', async () => {
    const h = harness({ status: 429 })
    const out = await h.boom()
    expect(out.sent).toBe(false)
    expect(out.why).toContain('报满')
  })

  it('网络炸了也不抛 —— 上报失败不该再引发一次上报', async () => {
    let at = T0
    const reporter = createDiagReporter({
      link: async () => ({ relayUrl: 'https://api.example.cn', token: 'wb_假的假的假的假的' }),
      enabled: async () => true,
      version: '0.2.54',
      now: () => at,
      fetchImpl: (async () => { throw new Error('ENOTFOUND /Users/example') }) as unknown as typeof fetch,
    })
    at += 1
    const out = await reporter.report({ component: 'plugin', kind: 'unhandled', message: 'x' })
    expect(out.sent).toBe(false)
    // 连失败原因里的路径都擦过
    expect(out.why).not.toContain('/Users/example')
  })
})
