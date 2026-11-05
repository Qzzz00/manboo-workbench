/**
 * 电话里问「X 现在什么状态 / 你去看一眼」= **只读**(2026-09-27,卡 LK)。
 *
 * 现场(维护者 21:2x,他自己的 Mac):「你告诉我现在 Codex 现在是什么状态?他正在跑那个参赛网页那个东西」
 * → 事务官答**看板上的旧事项**;他纠正「不是那个会话」→ 事务官**去给 Codex 捎话**;
 * 他明说「不要给他发信息,就看一眼」→ 还是答旧事项。他挂了电话。
 *
 * 这一份钉的是:
 * 1. ★★ **没让发就不许发**:他那一句是「看一眼 / 什么状态 / 在干什么」,捎话那件工具在**工具层**挡下
 *    (代码判,不靠模型自觉),并指到 `wb_session_status`;
 * 2. ★★ **他真让捎的时候照旧捎**:「跟 Codex 那条说一句……」一个字不改地送进去;
 * 3. ★ `wb_session_status` 走 `GET /sessions/lookup`,**一次都不碰** `/sessions/relay` 与 `/progress/ask`;
 * 4. ★ 时长照工作台那句念,不换算成分钟数。
 */
import { describe, expect, it } from 'vitest'
import { TOOL_RELAY_SESSION, TOOL_SESSION_STATUS, createChannelTools } from '../src/tools.ts'
import { looksLikeLookupOnly, looksLikeRelay } from '../src/butlerRoute.ts'
import { createWorkbenchClient } from '../src/workbench.ts'

interface FakeTool { execute: (args: Record<string, unknown>, ctx: never) => Promise<unknown> }
function toolOf(tools: unknown, name: string): FakeTool {
  return (tools as Record<string, FakeTool>)[name] as FakeTool
}

function client(body: unknown = { ok: true, note: 'Codex「整理参赛材料与网页」还在跑 · 最后一次动静是 3 分钟前 · 最后一句是在跑测试。' }) {
  const calls: { path: string, search: string, body: unknown }[] = []
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    calls.push({ path: url.pathname, search: url.search, body: typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : undefined })
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
  return { calls, workbench: createWorkbenchClient({ baseUrl: 'http://127.0.0.1:8791', fetchImpl: impl }) }
}

describe('★★ 「看一眼」不许捎话', () => {
  /** 他那一通里真说过的四句。 */
  const LOOKUP_LINES = [
    '你告诉我现在 Codex 现在是什么状态',
    '不是那个会话,他现在跑的是整理 Spotlight 参赛材料与网页',
    '你去看一眼',
    '不要给他发信息,就看一眼',
  ]

  it('规则认得出这几句是只读的,也认不出它们是捎话', () => {
    // 第二句本身只是纠正名字,不带「看」的意思 —— 那一句归模型继续查,不在这道门里。
    for (const said of [LOOKUP_LINES[0], LOOKUP_LINES[2], LOOKUP_LINES[3]]) {
      expect(looksLikeLookupOnly(said as string)).toBe(true)
      expect(looksLikeRelay(said as string)).toBe(false)
    }
  })

  it('他说「你去看一眼」时,捎话那件工具在工具层被挡下,一次都不打 /sessions/relay', async () => {
    const { calls, workbench } = client()
    const tools = createChannelTools({ workbench, lastSaid: () => '你去看一眼' })
    const text = String(await toolOf(tools, TOOL_RELAY_SESSION).execute(
      { who: '整理 Spotlight 参赛材料与网页那条', text: '现在进行到什么情况' },
      {} as never,
    ))
    expect(calls).toEqual([])
    expect(text).toContain('没捎')
    expect(text).toContain(TOOL_SESSION_STATUS)
  })

  it('他明说「不要给他发信息,就看一眼」时同样挡下', async () => {
    const { calls, workbench } = client()
    const tools = createChannelTools({ workbench, lastSaid: () => '不要给他发信息,就看一眼' })
    await toolOf(tools, TOOL_RELAY_SESSION).execute({ who: 'Codex', text: '到哪了' }, {} as never)
    expect(calls).toEqual([])
  })

  it('★★ 他真让捎的时候照旧捎,原话一个字不改', async () => {
    const { calls, workbench } = client({ ok: true, note: '捎到了。' })
    const tools = createChannelTools({ workbench, lastSaid: () => '跟 Codex 那条说一句:先停下等我' })
    await toolOf(tools, TOOL_RELAY_SESSION).execute({ who: 'Codex 那条', text: '先停下等我' }, {} as never)
    expect(calls.map(one => one.path)).toEqual(['/sessions/relay'])
    expect((calls[0]?.body as { text?: string }).text).toBe('先停下等我')
  })

  it('拿不到他的原话时那道门不拦(宁可少一道门,不可拦掉真该捎的那一次)', async () => {
    const { calls, workbench } = client({ ok: true, note: '捎到了。' })
    const tools = createChannelTools({ workbench })
    await toolOf(tools, TOOL_RELAY_SESSION).execute({ who: 'Codex', text: '先停下' }, {} as never)
    expect(calls.map(one => one.path)).toEqual(['/sessions/relay'])
  })
})

describe('★ wb_session_status 只读', () => {
  it('走 GET /sessions/lookup,带上他点名那一句;不碰 /sessions/relay、不碰 /progress/ask', async () => {
    const { calls, workbench } = client()
    const tools = createChannelTools({ workbench, lastSaid: () => '你去看一眼' })
    const text = String(await toolOf(tools, TOOL_SESSION_STATUS).execute({ who: '正在跑的那个 Codex' }, {} as never))
    expect(calls).toHaveLength(1)
    expect(calls[0]?.path).toBe('/sessions/lookup')
    expect(decodeURIComponent(calls[0]?.search ?? '')).toContain('正在跑的那个 Codex')
    expect(calls[0]?.body).toBeUndefined()
    expect(text).toContain('还在跑')
    expect(text).toContain('3 分钟前')
    // 时长照工作台那句念,别自己换算。
    expect(text).toContain('不要换成分钟数')
  })

  it('认不准就把候选念给他选,不自己挑一条', async () => {
    const { workbench } = client({ ok: false, where: 'pick', note: '有 2 条都对得上:1. …;2. …。问他是哪一条。' })
    const tools = createChannelTools({ workbench })
    const text = String(await toolOf(tools, TOOL_SESSION_STATUS).execute({ who: 'Codex' }, {} as never))
    expect(text).toContain('问他是哪一条')
  })

  it('旧版工作台没有这条路(404)时如实说看不到,不编一个状态', async () => {
    const impl = (async () => new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch
    const workbench = createWorkbenchClient({ baseUrl: 'http://127.0.0.1:8791', fetchImpl: impl })
    const text = String(await toolOf(createChannelTools({ workbench }), TOOL_SESSION_STATUS).execute({ who: 'Codex' }, {} as never))
    expect(text).toContain('看不到')
    expect(text).toContain('别凭印象答')
  })
})
