/**
 * **电话里只在拿不准时先确认**(2026-10-12,维护者拍板;交接 `docs/交接-1012-电话只在拿不准时确认.md`)。
 *
 * 维护者:「跟事务官电话好啰嗦,是因为她每次都要和我确认一遍,即使很清晰很简单的需求也要复述一遍」。
 * 以前派活 / 建需求卡第一次调用**一定**不办;现在问 8791 一句(`/confirm/points` 的 `call` 那一格,判据在
 * `workbench-plugin/src/server/callAsk.ts`),说清了第一次就真办,工具回话让模型一句报结果。
 * 拿不到那一格(老工作台 / 连不上)= 判不准 → 照旧先问。
 *
 * 对照用例(卡上第 5 条):
 *   清楚简单的派活 → 第一次就调 /butler/item;没点名且多家可做 → 先问;
 *   发版 / 删除 / 替她发消息 → 先问;说「先跟我确认」→ 先问;「先记着」→ 只建卡。
 */
import { describe, expect, it } from 'vitest'
import { TOOL_DISPATCH, TOOL_HAND, TOOL_LAYOUT, TOOL_REMEMBER, TOOL_SEARCH_FILES, TOOL_SEND_FILE, createChannelTools,
} from '../src/tools.ts'
import type { DeviceFilesPort } from '../src/tools.ts'
import type { DeviceInfo } from '../src/files/devices.ts'
import type { WorkbenchClient } from '../src/workbench.ts'
import { DIRECT_DONE_NOTE, UNCONFIRMED_MARK } from '../src/confirm.ts'
import { createWorkbenchClient } from '../src/workbench.ts'

interface FakeTool { execute: (args: Record<string, unknown>, ctx: never) => Promise<unknown> }
function toolOf(tools: unknown, name: string): FakeTool {
  return (tools as Record<string, FakeTool>)[name] as FakeTool
}

type Call = { ask: boolean, why: string, spoken?: string, hint?: string }

/** 假 8791:`/confirm/points` 回的 `call` 由用例给(就是 8791 那头 `callAskVerdict` 会给的那几种)。 */
function client(call: Call | undefined) {
  const calls: { path: string, body: Record<string, unknown> | undefined }[] = []
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname
    calls.push({ path, body: typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : undefined })
    const body = path === '/confirm/points'
      ? { ok: true, spoken: '怎么算做完?我按「你照着走一遍、结果跟你说的一样」办。', ...(call === undefined ? {} : { call }) }
      : path === '/butler/item'
        ? { ok: true, id: 't-9', dispatch_note: '正在派给 Codex', dispatch_ok: true }
        : { ok: true, id: 't-9' }
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
  return { calls, workbench: createWorkbenchClient({ baseUrl: 'http://127.0.0.1:8791', fetchImpl: impl }) }
}

const CLEAR: Call = { ask: false, why: 'clear' }

describe('改版面:撤得回,说清了直接改', () => {
  it('★ 第一次就改,回话里留着「撤销」那条退路', async () => {
    const { calls, workbench } = client(CLEAR)
    const text = String(await toolOf(createChannelTools({ workbench, lastSaid: () => '把随手记藏起来' }), TOOL_LAYOUT)
      .execute({ orientation: 'portrait', kind: 'hide', module: 'notes' }, {} as never))
    expect(calls.map(one => one.path)).toEqual(['/confirm/points', '/layout/act'])
    expect(calls[0]?.body).toMatchObject({ for: 'layout', said: '把随手记藏起来' })
    expect(text).toContain('撤销')
  })

  it('她说「先跟我确认」→ 照旧先复述一句', async () => {
    const { calls, workbench } = client({ ask: true, why: 'asked' })
    const text = String(await toolOf(createChannelTools({ workbench }), TOOL_LAYOUT)
      .execute({ orientation: 'portrait', kind: 'hide', module: 'notes' }, {} as never))
    expect(calls.map(one => one.path)).toEqual(['/confirm/points'])
    expect(text).toContain('还没改')
  })
})

describe('传文件到她自己的手机:一份拷贝、不对外,说清了直接传', () => {
  const mac: DeviceInfo = { identity: 'wb-channel-worker', device_id: 'mac-a', name: '书房 Mac', kind: 'mac' }
  const phone: DeviceInfo = { identity: 'wb-phone-d1', device_id: 'd1', name: 'Ben 的手机', kind: 'phone' }
  function setup(call: Call) {
    const sends: string[] = []
    const asked: unknown[] = []
    const port: DeviceFilesPort = {
      devices: () => [mac, phone],
      self: () => mac,
      caller: () => phone,
      search: async () => [{ device: mac, files: [{ path: '/repo/README.md', name: 'README.md', size: 10 }], total: 1, truncated: false }],
      send: async ({ path }) => { sends.push(path); return { ok: true, name: 'README.md', bytes: 10 } },
    }
    const workbench = {
      confirmPoints: async (text: string, who?: string, opts?: unknown) => { asked.push(opts); return { ok: true, spoken: '', call } },
    } as unknown as WorkbenchClient
    const tools = createChannelTools({ workbench, deviceFiles: port }) as unknown as Record<string, FakeTool>
    return { tools, sends, asked }
  }

  it('★ 第一次就传', async () => {
    const { tools, sends, asked } = setup(CLEAR)
    await tools[TOOL_SEARCH_FILES]!.execute({ query: 'README' }, {} as never)
    const text = String(await tools[TOOL_SEND_FILE]!.execute({ file: '1' }, {} as never))
    expect(sends).toEqual(['/repo/README.md'])
    expect(asked[0]).toMatchObject({ for: 'file' })
    expect(text).toContain('发过去了')
  })

  it('她说「先跟我确认」→ 先复述', async () => {
    const { tools, sends } = setup({ ask: true, why: 'asked' })
    await tools[TOOL_SEARCH_FILES]!.execute({ query: 'README' }, {} as never)
    const text = String(await tools[TOOL_SEND_FILE]!.execute({ file: '1' }, {} as never))
    expect(sends).toEqual([])
    expect(text).toContain('对吗')
  })
})
