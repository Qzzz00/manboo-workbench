/**
 * 电话里那件 `wb_layout`(2026-09-22「用自然语言改布局」)。
 *
 * 两层各测各的:
 *   ① **工具行为层** —— 那道复述确认的门:第一次一定不改,只回一句让模型照着问的话;
 *      他点头(`confirmed: true`)之后才真调工作台。形状照抄 `wb_send_file` 那一份。
 *   ② **HTTP 客户端层** —— 打的是 `POST /layout/act`(**不是** `POST /layout`:那条会把
 *      整份布局覆盖掉),老版本工作台回 404 时如实说"版本旧了",绝不退回去拼 /layout。
 */
import { describe, expect, it } from 'vitest'
import { TOOL_LAYOUT, createChannelTools, layoutConfirmText } from '../src/tools.ts'
import { createWorkbenchClient, type WorkbenchClient } from '../src/workbench.ts'

interface FakeTool { execute: (args: Record<string, unknown>, ctx: never) => Promise<unknown> }
function toolOf(value: unknown): FakeTool {
  return (value as Record<string, FakeTool>)[TOOL_LAYOUT] as FakeTool
}

/** 一个记账的假工作台客户端:只认这张卡要用的两件。 */
function fakeWorkbench() {
  const acts: unknown[] = []
  let undos = 0
  const workbench = {
    layoutAct: async (input: unknown) => { acts.push(input); return { ok: true, text: '挪好了,不合适说「撤销」。' } },
    layoutUndo: async () => { undos += 1; return { ok: true, text: '回到上一步了。' } },
  } as unknown as WorkbenchClient
  return { workbench, acts, undoCount: () => undos }
}

/** 一个记账的假 fetch(照抄 tests/net.test.ts 那一份)。 */
function stubFetch(reply: (path: string) => { status: number, body: unknown }) {
  const calls: { path: string, body: unknown }[] = []
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname
    calls.push({ path, body: typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : undefined })
    const result = reply(path)
    return new Response(JSON.stringify(result.body), {
      status: result.status, headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch
  return { impl, calls }
}

describe('wb_layout:那道复述确认的门', () => {
  it('第一次调用**一定不改**,只给一句复述', async () => {
    const wb = fakeWorkbench()
    const tool = toolOf(createChannelTools({ workbench: wb.workbench }))
    const text = String(await tool.execute(
      { orientation: 'landscape', kind: 'region', module: 'usage', region: 'side' }, {} as never,
    ))
    expect(text).toContain('把「usage」挪到右侧栏、项目区下面,对吗?')
    expect(text).toContain('confirmed')
    expect(wb.acts).toEqual([])
  })

  it('他点头之后(confirmed)才真调 /layout/act', async () => {
    const wb = fakeWorkbench()
    const tool = toolOf(createChannelTools({ workbench: wb.workbench }))
    const text = String(await tool.execute(
      { orientation: 'landscape', kind: 'region', module: 'usage', region: 'side', confirmed: true }, {} as never,
    ))
    expect(text).toContain('撤销')
    expect(wb.acts).toHaveLength(1)
    expect(wb.acts[0]).toMatchObject({
      orientation: 'landscape',
      actions: [{ kind: 'region', module: 'usage', region: 'side' }],
    })
  })

  it('撤销**不走那道门**:他刚被告知可以说「撤销」,再问一遍就成了绕圈', async () => {
    const wb = fakeWorkbench()
    const tool = toolOf(createChannelTools({ workbench: wb.workbench }))
    const text = String(await tool.execute({ orientation: 'portrait', undo: true }, {} as never))
    expect(text).toContain('上一步')
    expect(wb.undoCount()).toBe(1)
    expect(wb.acts).toEqual([])
  })

  it('认不出的 kind → 让模型再问一遍,不挑一个顶上', async () => {
    const wb = fakeWorkbench()
    const tool = toolOf(createChannelTools({ workbench: wb.workbench }))
    const text = String(await tool.execute(
      { orientation: 'portrait', kind: 'delete', module: 'notes', confirmed: true }, {} as never,
    ))
    expect(text).toContain('不认识这种改动')
    expect(wb.acts).toEqual([])
  })

  it('没说是哪一格 → 不改', async () => {
    const wb = fakeWorkbench()
    const tool = toolOf(createChannelTools({ workbench: wb.workbench }))
    const text = String(await tool.execute({ orientation: 'portrait', kind: 'hide', confirmed: true }, {} as never))
    expect(text).toContain('没说是哪一格')
    expect(wb.acts).toEqual([])
  })

  it('每一种 kind 都拼得出一句人话的复述', () => {
    const says = [
      layoutConfirmText({ kind: 'move', module: 'notes', dir: 'up' }),
      layoutConfirmText({ kind: 'region', module: 'usage', region: 'deck' }),
      layoutConfirmText({ kind: 'hide', module: 'notes' }),
      layoutConfirmText({ kind: 'show', module: 'notes' }),
      layoutConfirmText({ kind: 'rename', module: 'projects', title: '账号' }),
      layoutConfirmText({ kind: 'swap', module: 'notes', other: 'files' }),
      layoutConfirmText({ kind: 'resize', module: 'deck', axis: 'height', delta: 6 }),
      layoutConfirmText({ kind: 'resize', module: 'usage', axis: 'width', delta: -6 }),
    ]
    for (const say of says) expect(say.endsWith('对吗?')).toBe(true)
    expect(says[4]).toContain('账号')
    expect(says[6]).toContain('调高一点')
    expect(says[7]).toContain('调窄一点')
  })
})

describe('WorkbenchClient.layoutAct / layoutUndo', () => {
  it('打的是 POST /layout/act,**不是** POST /layout', async () => {
    const stub = stubFetch(() => ({ status: 200, body: { ok: true, note: '挪好了,不合适说「撤销」。' } }))
    const client = createWorkbenchClient({ baseUrl: 'http://127.0.0.1:8791', fetchImpl: stub.impl })
    const result = await client.layoutAct({
      orientation: 'landscape', actions: [{ kind: 'hide', module: 'notes' }], reason: '把「notes」藏起来,对吗?',
    })
    expect(result.ok).toBe(true)
    expect(stub.calls[0]?.path).toBe('/layout/act')
    expect(stub.calls[0]?.body).toEqual({
      orientation: 'landscape',
      actions: [{ kind: 'hide', module: 'notes' }],
      reason: '把「notes」藏起来,对吗?',
    })
  })

  it('服务端那句 note 原样带走(快照没存下时它会说「撤不回来」)', async () => {
    const stub = stubFetch(() => ({ status: 200, body: { ok: true, note: '改好了。这台机器没接布局快照,这次改完撤不回来。' } }))
    const client = createWorkbenchClient({ baseUrl: 'http://127.0.0.1:8791', fetchImpl: stub.impl })
    const result = await client.layoutAct({ orientation: 'portrait', actions: [{ kind: 'hide', module: 'notes' }] })
    expect(result.text).toContain('撤不回来')
  })

  it('老版本的工作台(404)→ 如实说版本旧了,**不退回去拼 /layout**', async () => {
    const stub = stubFetch(() => ({ status: 404, body: {} }))
    const client = createWorkbenchClient({ baseUrl: 'http://127.0.0.1:8791', fetchImpl: stub.impl })
    const result = await client.layoutAct({ orientation: 'portrait', actions: [{ kind: 'hide', module: 'notes' }] })
    expect(result.ok).toBe(false)
    expect(result.text).toContain('版本旧了')
    expect(stub.calls.every(call => call.path !== '/layout')).toBe(true)
  })

  it('400 里那句中文原样带走', async () => {
    const stub = stubFetch(() => ({ status: 400, body: { error: '没有「不存在」这一格。' } }))
    const client = createWorkbenchClient({ baseUrl: 'http://127.0.0.1:8791', fetchImpl: stub.impl })
    const result = await client.layoutAct({ orientation: 'portrait', actions: [{ kind: 'hide', module: '不存在' }] })
    expect(result.text).toContain('没有「不存在」这一格。')
  })

  it('8791 连不上 → 如实说"布局一格没动"', async () => {
    const impl = (async () => { throw new Error('ECONNREFUSED') }) as unknown as typeof fetch
    const client = createWorkbenchClient({ baseUrl: 'http://127.0.0.1:8791', fetchImpl: impl })
    const result = await client.layoutAct({ orientation: 'portrait', actions: [{ kind: 'hide', module: 'notes' }] })
    expect(result.ok).toBe(false)
    expect(result.text).toContain('一格没动')
  })

  it('一条动作都没有 → 不发请求', async () => {
    const stub = stubFetch(() => ({ status: 200, body: { ok: true } }))
    const client = createWorkbenchClient({ baseUrl: 'http://127.0.0.1:8791', fetchImpl: stub.impl })
    const result = await client.layoutAct({ orientation: 'portrait', actions: [] })
    expect(result.ok).toBe(false)
    expect(stub.calls).toEqual([])
  })

  it('撤销打的是 POST /layout/undo;没得撤时把服务端那句话带出来', async () => {
    const ok = stubFetch(() => ({ status: 200, body: { ok: true } }))
    const client = createWorkbenchClient({ baseUrl: 'http://127.0.0.1:8791', fetchImpl: ok.impl })
    expect((await client.layoutUndo()).ok).toBe(true)
    expect(ok.calls[0]?.path).toBe('/layout/undo')

    const none = stubFetch(() => ({ status: 409, body: { error: '没有可回退的布局备份(还没切过模板)。' } }))
    const client2 = createWorkbenchClient({ baseUrl: 'http://127.0.0.1:8791', fetchImpl: none.impl })
    const failed = await client2.layoutUndo()
    expect(failed.ok).toBe(false)
    expect(failed.text).toContain('没有可回退的布局备份')
  })
})
