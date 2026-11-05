/**
 * 事务官板上工具用例 (docs/卡/事务官的板上工具.md)
 * 1. wb_goal_create / wb_goal_update → /collab/goal/create, /collab/goal/update
 * 2. wb_note_create → /task/create (缺省 backlog, 传 todo 才进待办)
 * 3. wb_note_update / wb_note_move → /task/update, /task/move (按七态转换表)
 * 4. 名片负责人: assignee 可以是 agent:<id> 或家名, 说明里给名片规则
 */
import { describe, expect, it } from 'vitest'
import {
  createChannelTools,
} from '../src/tools.ts'
import { createWorkbenchClient, itemAssigneeOf } from '../src/workbench.ts'

interface FakeTool {
  description?: string
  parameters?: Record<string, unknown>
  execute: (args: Record<string, unknown>, ctx: never) => Promise<unknown>
}

function toolOf(tools: unknown, name: string): FakeTool {
  return (tools as Record<string, FakeTool>)[name] as FakeTool
}

function stubFetch(reply: (path: string, method: string, body: unknown) => { status: number, body: unknown }) {
  const calls: { path: string, method: string, body: unknown }[] = []
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname
    const method = init?.method ?? 'GET'
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : undefined
    calls.push({ path, method, body })
    const result = reply(path, method, body)
    return new Response(JSON.stringify(result.body), {
      status: result.status,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch
  return { impl, calls }
}

describe('④ 名片负责人 (agent:<id>) 与说明', () => {
  it('itemAssigneeOf: 保留 agent:<id> 格式, 允许名片负责人', () => {
    expect(itemAssigneeOf('agent:kimi-coder')).toBe('agent:kimi-coder')
    expect(itemAssigneeOf('agent:Claude_Review_Card')).toBe('agent:Claude_Review_Card')
    expect(itemAssigneeOf('  agent:my-card-123  ')).toBe('agent:my-card-123')
    expect(itemAssigneeOf('Codex')).toBe('codex')
  })

})
