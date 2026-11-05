/**
 * 电话里换「今天的待办」的显示(2026-10-12,周三演示;交接 `docs/交接-1012-演示-切换待办版本.md`)。
 *
 * 她说「把待办改成卡片」→ 复述一句确认 → 她说「对」→ 打 `POST /today/view` → 说「好,改成卡片了」。
 * 「待办改回列表 / 改回去」切回另一版。钉四件:那道复述的门、HTTP 那一层、意图认得出、房间白名单里有这条。
 *
 * ★ 2026-10-13(卡 I)两版改叫**卡片 / 列表**(维护者原话),`by_date` / `flat` 两个值没动;
 * 老说法「按日期汇总 / 不汇总」照旧认得出。
 */
import { describe, expect, it } from 'vitest'
import { TODO_VIEW_TITLES, TOOL_TODO_VIEW, createChannelTools, todoViewConfirmText, todoViewDoneText, todoViewSameText } from '../src/tools.ts'
import { createWorkbenchClient, type WorkbenchClient } from '../src/workbench.ts'
import { toolsForIntents } from '../src/intentTools.ts'
import { routeByRules } from '../src/turnRoute.ts'
import { RPC_ALLOWED } from '../src/rpc.ts'

interface FakeTool { execute: (args: Record<string, unknown>, ctx: never) => Promise<unknown> }

function fakeWorkbench() {
  const calls: string[] = []
  const workbench = {
    todoView: async (view: string) => { calls.push(view); return { ok: true, text: todoViewDoneText(view as 'by_date' | 'flat') } },
  } as unknown as WorkbenchClient
  return { workbench, calls }
}

function toolOf(wb: WorkbenchClient): FakeTool {
  return (createChannelTools({ workbench: wb }) as unknown as Record<string, FakeTool>)[TOOL_TODO_VIEW] as FakeTool
}

describe('wb_todo_view:那道复述的门', () => {
  it('第一次一定不切,只给一句复述', async () => {
    const wb = fakeWorkbench()
    const text = String(await toolOf(wb.workbench).execute({ view: 'by_date' }, {} as never))
    expect(text).toContain(todoViewConfirmText('by_date'))
    expect(text).toContain('confirmed')
    expect(wb.calls).toEqual([])
  })

  it('她说对了(confirmed)才切;回的那句就是「好,改成卡片了」', async () => {
    const wb = fakeWorkbench()
    const text = String(await toolOf(wb.workbench).execute({ view: 'by_date', confirmed: true }, {} as never))
    expect(wb.calls).toEqual(['by_date'])
    expect(text).toContain('好,改成卡片了')
  })

  it('复述与报结果的字(10-13 起是卡片 / 列表)', () => {
    expect(todoViewConfirmText('by_date')).toBe('把待办改成卡片,对吗?')
    expect(todoViewConfirmText('flat')).toBe('把待办改回列表,对吗?')
    expect(todoViewDoneText('by_date')).toBe('好,改成卡片了。')
    expect(todoViewDoneText('flat')).toBe('好,改回列表了。')
    expect(todoViewSameText('flat')).toBe('本来就是列表的,没动。')
    expect(TODO_VIEW_TITLES).toEqual({ by_date: '卡片', flat: '列表' })
  })

  it('认不出的版本:不切,让模型再问', async () => {
    const wb = fakeWorkbench()
    const text = String(await toolOf(wb.workbench).execute({ view: 'grid', confirmed: true }, {} as never))
    expect(wb.calls).toEqual([])
    expect(text).toContain('没切')
    expect(text).toContain('卡片还是列表')
  })
})

function stubFetch(status: number, body: unknown) {
  const calls: { path: string, body: unknown }[] = []
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ path: new URL(String(input)).pathname, body: JSON.parse(String(init?.body ?? '{}')) as unknown })
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
  return { impl, calls }
}

describe('HTTP 那一层', () => {
  it('打 POST /today/view {view}', async () => {
    const stub = stubFetch(200, { ok: true, view: 'by_date', changed: true })
    const client = createWorkbenchClient({ baseUrl: 'http://127.0.0.1:8791', fetchImpl: stub.impl })
    const result = await client.todoView('by_date')
    expect(stub.calls).toEqual([{ path: '/today/view', body: { view: 'by_date' } }])
    expect(result).toEqual({ ok: true, text: todoViewDoneText('by_date') })
  })

  it('本来就是那一版:照实说本来就是', async () => {
    const stub = stubFetch(200, { ok: true, view: 'flat', changed: false })
    const client = createWorkbenchClient({ baseUrl: 'http://127.0.0.1:8791', fetchImpl: stub.impl })
    expect((await client.todoView('flat')).text).toContain(todoViewSameText('flat'))
  })

  it('老工作台没这条路(404):如实说版本旧了', async () => {
    const stub = stubFetch(404, { error: 'not found' })
    const client = createWorkbenchClient({ baseUrl: 'http://127.0.0.1:8791', fetchImpl: stub.impl })
    const result = await client.todoView('by_date')
    expect(result.ok).toBe(false)
    expect(result.text).toContain('版本旧了')
  })
})

describe('意图认得出、手上有这件工具', () => {
  for (const said of [
    '把待办改成卡片', '待办改成卡片式', '待办改回列表', '把今天的待办换成列表',
    '把待办改成按日期汇总', '待办按日期汇总一下', '改回不汇总', '改回去', '待办改回平铺',
  ]) {
    it(`「${said}」`, () => {
      const hit = routeByRules(said)
      expect(hit.route).toBe('act')
      expect(toolsForIntents(hit.intents)).toContain(TOOL_TODO_VIEW)
    })
  }
})

describe('房间白名单', () => {
  it('POST /today/view 在里头(手机出门也能切)', () => {
    expect(RPC_ALLOWED.some(one => one.method === 'POST' && one.path === '/today/view')).toBe(true)
  })
})

describe('对照源头', () => {
  it('两版的字面量与 8791 的 TODAY_VIEWS 一个不差', async () => {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { TODO_VIEWS } = await import('../src/todoView.ts')
    const src = readFileSync(join(import.meta.dirname, '..', '..', 'workbench-plugin', 'src', 'protocol.ts'), 'utf8')
    const m = /export const TODAY_VIEWS = \[([^\]]*)\] as const/u.exec(src)
    expect(m?.[1]?.split(',').map(one => one.trim().replace(/'/gu, ''))).toEqual([...TODO_VIEWS])
  })
})
