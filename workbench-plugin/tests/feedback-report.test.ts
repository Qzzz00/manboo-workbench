// @vitest-environment node
/**
 * 「反馈给开发者」那一条发出去长什么样(2026-09-28,卡 FB)。
 *
 * 这一组盯三件事:
 *   ① **走的是自动上报那条路** —— `POST /v1/diag/report`、带设备令牌、`kind: 'feedback'`;
 *   ② **字段是那几格、不多一格** —— 原话 + 一句整理 + 版本 + 模板 / 布局;不含对话全文、不含凭据;
 *   ③ **脱敏在发之前** —— 她原话里粘进来的 Key / 令牌 / 家目录一个都不许出这台机器。
 */
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import { createFeedbackService } from '../src/server/diagnostics/feedback.ts'
import type { DiagReportBody } from '../src/diag.ts'

async function harness(options: { link?: boolean, status?: number, context?: string } = {}) {
  const dir = await mkdtemp(`${tmpdir()}/wb-feedback-`)
  const file = `${dir}/feedback.json`
  const sent: DiagReportBody[] = []
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body)) as DiagReportBody)
    return new Response(JSON.stringify({ id: 'x' }), { status: options.status ?? 200 })
  }) as unknown as typeof fetch
  let n = 0
  const service = createFeedbackService({
    file,
    version: '0.4.51',
    now: () => Date.parse('2026-09-28T01:23:45.000Z'),
    link: async () => (options.link === false ? undefined : { relayUrl: 'https://relay.example', token: 'wb_abcdefghijklmn' }),
    ...(options.context === undefined ? {} : { context: async () => options.context }),
    fetchImpl,
    newId: () => `fb-${(n += 1)}`,
  })
  await service.load()
  return { service, sent, file, calls: fetchImpl as unknown as ReturnType<typeof vi.fn> }
}

describe('发出去那一条', () => {
  it('走 /v1/diag/report、带设备令牌、kind 是 feedback', async () => {
    const { service, sent, calls } = await harness({ context: '模板:自媒体运营;竖屏:账号、选题池、发布计划' })
    const entry = await service.add({ said: '发布计划那里没有标记今天是哪一天,这个不方便', note: '工作台「发布计划」:发布计划那里没有标记今天是哪一天,这个不方便', ui: '发布计划' })
    expect(entry.status).toBe('sent')
    const [url, init] = (calls.mock.calls[0] ?? []) as [string, RequestInit]
    expect(url).toBe('https://relay.example/v1/diag/report')
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer wb_abcdefghijklmn')
    const body = sent[0] as DiagReportBody
    expect(body.kind).toBe('feedback')
    expect(body.component).toBe('plugin')
    expect(body.version).toBe('0.4.51')
    expect(body.said).toContain('没有标记今天')
    expect(body.message).toContain('发布计划')
    expect(body.context).toContain('自媒体运营')
    // 报错那一类才有的两格在反馈里是空的:这一条不是崩溃现场,不该捎带日志。
    expect(body.stack).toEqual([])
    expect(body.log).toEqual([])
    expect(body.code).toMatch(/^WB-\d{6}$/)
  })

  it('原话里的 Key / 令牌 / 家目录在发出去之前就擦掉了', async () => {
    const { service, sent } = await harness()
    await service.add({
      said: '我在 /Users/arong/Desktop 那个截图里贴了 sk-abcdefgh12345678,顺便说设置里不对',
      note: '工作台「设置里」:设置里不对',
    })
    const body = sent[0] as DiagReportBody
    expect(body.said).not.toContain('arong')
    expect(body.said).not.toContain('sk-abcdefgh12345678')
    expect(body.said).toContain('/Users/<用户>')
  })

  it('没登录:不发、如实落本机,并说清为什么', async () => {
    const { service, sent } = await harness({ link: false })
    const entry = await service.add({ said: '顶栏时间不对', note: '工作台「顶栏」:顶栏时间不对' })
    expect(sent.length).toBe(0)
    expect(entry.status).toBe('local')
    expect(entry.why).toContain('还没连上服务器')
  })

  it('服务器没收:落本机、写 HTTP 码,不抛', async () => {
    const { service } = await harness({ status: 500 })
    const entry = await service.add({ said: '随手记那格太小', note: '工作台「随手记」:随手记那格太小' })
    expect(entry.status).toBe('local')
    expect(entry.why).toContain('500')
  })
})

describe('「我反馈过的问题」那一行', () => {
  it('发了几条 = 状态 sent 的那几条;落盘之后重开还在', async () => {
    const { service, file } = await harness()
    await service.add({ said: '顶栏时间不对', note: 'a' })
    await service.add({ said: '随手记太小', note: 'b' })
    const view = await service.list()
    expect(view.items.length).toBe(2)
    expect(view.sent).toBe(2)
    const onDisk = JSON.parse(await readFile(file, 'utf8')) as { items: unknown[] }
    expect(onDisk.items.length).toBe(2)
  })

  it('拿不准那一条先挂着不发;她说「是本体」才发,说「不是」就撤掉', async () => {
    const { service, sent } = await harness()
    const asked = await service.add({ said: '发布计划那块你优化一下', note: 'c', status: 'asking' })
    expect(asked.status).toBe('asking')
    expect(sent.length).toBe(0)

    const settled = await service.settle(asked.id, 'product')
    expect(settled?.status).toBe('sent')
    expect(sent.length).toBe(1)

    const second = await service.add({ said: '顶栏不对', note: 'd', status: 'asking' })
    const dropped = await service.settle(second.id, 'hers')
    expect(dropped?.status).toBe('local')
    expect(await service.find(second.id)).toBeUndefined()
    expect(sent.length).toBe(1)
  })

  it('文件读不懂不抛,当一条都没有', async () => {
    const { service } = await harness()
    await service.load()
    expect((await service.list()).items).toEqual([])
  })
})
