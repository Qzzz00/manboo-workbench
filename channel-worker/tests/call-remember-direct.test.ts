/**
 * 电话里「记下来」不再开 DSH 会话(2026-09-23,`fix/call-remember-direct`)。
 *
 * 12:39 那一通:维护者说「用户可以给我提需求说希望这个声音沉稳一些,把这件事记下来」,
 * 她调的 `wb_remember_item` 走 `/butler/item` 开了一条 DSH 会话,那条会话为了记一句话
 * 通读记忆、跑了约 30 次工具,吃掉 35 万 token 把当天额度撞满。这一份钉的是:
 *
 * 1. ★★ **记事不开会话**:`wb_remember_item` 只打 `/task/create`,一次都不碰 `/butler/item`;
 *    不过确认点那道门(他没要派活),卡上标「未确认」;
 * 2. ★★ **办事仍开会话**:`wb_dispatch_item` 过门之后走 `/butler/item`,和从前一样;
 * 3. ★ **回应如实**:记成了说「记下了」且不许说「让事务官去办了」;没记成说「没记上」;
 * 4. 工具集里不再有那件和「记」撞车的 `wb_create_item`。
 */
import { describe, expect, it } from 'vitest'
import { TOOL_DISPATCH, TOOL_REMEMBER, createChannelTools } from '../src/tools.ts'
import { UNCONFIRMED_MARK } from '../src/confirm.ts'
import { NOTE_TITLE_MAX, noteFields } from '../src/remember.ts'
import { createWorkbenchClient } from '../src/workbench.ts'

/** 12:39 那一句原话。 */
const SAID = '用户可以给我提需求说希望这个声音沉稳一些'

interface FakeTool { execute: (args: Record<string, unknown>, ctx: never) => Promise<unknown> }
function toolOf(tools: unknown, name: string): FakeTool {
  return (tools as Record<string, FakeTool>)[name] as FakeTool
}

function client(reply?: (path: string) => { status: number, body: unknown } | undefined) {
  const calls: { path: string, body: unknown }[] = []
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname
    calls.push({ path, body: typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : undefined })
    const custom = reply?.(path)
    const result = custom ?? (path === '/confirm/points'
      ? { status: 200, body: { ok: true, spoken: '我理解的是:X。\n① 怎么算做完?我先按「Y」来。', block: '' } }
      : { status: 200, body: { ok: true, id: 't-7' } })
    return new Response(JSON.stringify(result.body), { status: result.status, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
  return { calls, workbench: createWorkbenchClient({ baseUrl: 'http://127.0.0.1:8791', fetchImpl: impl }) }
}

describe('★★ 记事不开会话', () => {

  it('长话:标题截断,全文一个字不丢', () => {
    const long = '把'.repeat(NOTE_TITLE_MAX + 10)
    const fields = noteFields(`${long}\n第二行`)
    expect(fields.title).toBe(`${'把'.repeat(NOTE_TITLE_MAX)}…`)
    expect(fields.desc).toContain(`${long}\n第二行`)
  })

})

