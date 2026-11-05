// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { WorkbenchState } from '../src/protocol.ts'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { createTasksService } from '../src/server/tasks.ts'

const NOW_SEC = Math.floor(Date.parse('2026-10-21T09:00:00Z') / 1000)
const DEVICE = 'dev-secret-token'
const started: WorkbenchServer[] = []
const dirs: string[] = []
afterEach(async () => {
  while (started.length) await started.pop()?.close()
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})
const PAGE = { origin: 'http://127.0.0.1:3080' }

function fakeRelay() {
  const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status })
  return (async (input: string, init?: RequestInit) => {
    const p = new URL(String(input)).pathname
    const method = init?.method ?? 'GET'
    if (p === '/v1/workspace/me') return json({ workspace: null })
    if (p === '/v1/workspace/invite') return json({ code: 'INV12345', workspace_id: 'ws1', expires_at: '2026-10-22T00:00:00Z' })
    if (p === '/v1/wecom/bindings' && method === 'POST') return json({ code: 'BIND1234', expires_at: '2026-10-21T09:30:00Z', say: '绑定 BIND1234' })
    return json({ error: { message: 'nope' } }, 404)
  }) as typeof fetch
}

async function serve(link: 'none' | 'device' | 'both' = 'both') {
  const dir = mkdtempSync(join(tmpdir(), 'wb-collab-relay-http-'))
  dirs.push(dir)
  let n = 0
  const tasks = createTasksService({ file: join(dir, 'tasks.json'), now: () => NOW_SEC, newId: () => `t-${++n}` })
  const server = await startWorkbenchServer({
    port: 0, service: createWorkbenchService({ now: () => NOW_SEC }), tickIntervalMs: 0, tasks,
    collabRelay: {
      link: async () => (link === 'none' ? undefined : { relayUrl: 'https://relay.test', deviceToken: DEVICE, ...(link === 'both' ? { sessionToken: 'sess' } : {}) }),
      fetchImpl: fakeRelay(),
      inboxFile: join(dir, 'relay-inbox.json'),
      borrowFile: join(dir, 'collab-borrows.json'),
    },
  })
  started.push(server)
  return { url: server.url }
}

async function post(url: string, path: string, body: unknown, headers: Record<string, string> = PAGE) {
  const res = await fetch(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
  return { status: res.status, body: await res.json() as Record<string, unknown> }
}

describe('/collab/relay/*', () => {
  it('studio 三种状态;/state 带 relay_asks 与 relay_tick', async () => {
    expect(await (await fetch(`${(await serve('none')).url}/collab/relay/studio`)).json()).toMatchObject({ state: 'unwired' })
    const { url } = await serve()
    const body = await (await fetch(`${url}/collab/relay/studio`)).json()
    expect(body).toEqual({ state: 'none' })
    expect(JSON.stringify(body)).not.toContain(DEVICE)
    const state = await (await fetch(`${url}/state`)).json() as WorkbenchState
    expect(state.tasks?.relay_asks).toBe(0)
    expect(state.tasks?.relay_tick).toBe(0)
    expect((await (await fetch(`${url}/collab/relay/asks`)).json())).toEqual({ asks: [] })
  })

  it('邀请回 {ok, invite:{code, expires_at}};企微码平铺', async () => {
    const { url } = await serve()
    expect((await post(url, '/collab/relay/studio/invite', {})).body).toEqual({ ok: true, invite: { code: 'INV12345', expires_at: '2026-10-22T00:00:00Z' } })
    expect((await post(url, '/collab/relay/wecom/code', { channel_id: 'ws:ws1/ch:main' })).body).toEqual({ ok: true, code: 'BIND1234', expires_at: '2026-10-21T09:30:00Z' })
  })

  it('没有会话令牌 409;不是页面点的 403', async () => {
    const { url } = await serve('device')
    const out = await post(url, '/collab/relay/studio/invite', {})
    expect(out.status).toBe(409)
    expect(String(out.body.error)).toContain('登录')
    expect((await post(url, '/collab/relay/studio/invite', {}, {})).status).toBe(403)
  })

  it('批一条不存在的待批 404;缺字段 400', async () => {
    const { url } = await serve()
    expect((await post(url, '/collab/relay/asks/answer', { request_id: 'r9', approve: true })).status).toBe(404)
    expect((await post(url, '/collab/relay/asks/answer', { request_id: 'r9' })).status).toBe(400)
    expect((await post(url, '/collab/relay/borrow', { object_id: 'a' })).status).toBe(400)
  })
})
