// @vitest-environment node
/**
 * 任务书 1029「中枢派到窗口手不按发送」的端到端用例(hub 执行口 → 派活 → 引擎 → 假壳)。
 *
 * ① 中枢 dispatch 到窗口手:发给壳的 send_text submit:true(来源按派活者记成 'hub');
 *    电话工人(已验证身份)照旧 submit:true;入口自报 call 但不是工人的仍只填字。
 * ② 窗口手按了发送:壳回执 submitted → 卡记 sent;回执没按成 → 卡记 typed + 「字写进框里了,没发出去」。
 * 真壳一次也不激活:发出去的每一条 op 都断得到(写法对齐 say-phone-submit-http)。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { ACTOR_TOKEN_HEADER, mintActorTokens } from '../src/server/herself.ts'
import { startWorkbenchServer, type WorkbenchServer } from '../src/server/http.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { createTasksService } from '../src/server/tasks.ts'
import type { HelperRequest } from '../src/server/helperChannel.ts'
import type { TaskClientDispatch } from '../src/protocol.ts'
import type { ApiDispatchInput } from '../src/server/dispatchApi.ts'
import { dispatchBadgeText } from '../src/server/dispatchClient.ts'
import { engineHarness } from './helpers/engineHarness.ts'

const servers: WorkbenchServer[] = []
const dirs: string[] = []
afterEach(async () => {
  while (servers.length) await servers.pop()!.close()
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

const DISPATCH_TEXT = '把样片剪一版'
const DISPATCH_TITLE = '把样片剪一版'

/** 真 HTTP / 中枢执行口 / 派活 / 引擎 / 假壳;只替换壳回执,不启动窗口。 */
async function serve(receipt = true) {
  const dir = mkdtempSync(join(tmpdir(), 'wb-dispatch-send-hub-'))
  dirs.push(dir)
  const tokens = mintActorTokens()
  const tasks = createTasksService({ file: join(dir, 'tasks.json') })
  const calls: HelperRequest[] = []
  const apiCalls: ApiDispatchInput[] = []
  const request = async (req: HelperRequest): Promise<Record<string, unknown>> => {
    calls.push(req)
    if (req.op === 'send_text') return { method: 'ax_value', submitted: req.submit === true && receipt, new_conversation: '新聊天' }
    return { found: false, busy: false }
  }
  const h = engineHarness({
    helper: { connected: () => true, supports: () => true, request },
    installed: family => family === 'gpt' ? [] : undefined,
    api: { send: async input => {
      apiCalls.push(input)
      return { ok: true, reply: '受控 API 回包', dispatch: { family: input.family, hand: 'api', status: 'done', started_at: '2026-10-29T00:00:00Z' } }
    } },
  })
  const server = await startWorkbenchServer({
    port: 0, tickIntervalMs: 0, heartbeatMs: 0,
    service: createWorkbenchService({}), tasks, actorTokens: tokens,
    engine: h.engine,
    helper: { attach: () => {}, view: () => ({ connected: true, authorized: true }) as never, connected: () => true, onChange: () => {}, onEvent: () => {}, request },
    runCommand: async () => ({ ok: true, stdout: '"pid"=123' }),
    appInstalled: () => true,
    relayProviders: { view: () => ({ openai: true, deepseek: true, doubao: false }), pump: () => {}, read: async () => undefined, refresh: () => {} },
    projects: { getProjectsState: async () => ({ projects: [{ id: 'p-sample', name: '样片', path: dir }] }) } as never,
    model: { endpoint: async () => ({ baseUrl: 'http://fixture.invalid/v1', key: 'fixture', model: 'fixture', ready: true }) } as never,
  })
  servers.push(server)
  async function hub(body: Record<string, unknown>, actor: 'worker' | 'page' | 'none' = 'page') {
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (actor === 'worker') headers[ACTOR_TOKEN_HEADER] = tokens.worker
    if (actor === 'page') headers.origin = server.url
    const res = await fetch(server.url + '/butler/hub/execute', { method: 'POST', headers, body: JSON.stringify(body) })
    return { status: res.status, body: await res.json() as Record<string, any> }
  }
  async function settledDispatch() {
    for (let i = 0; i < 100; i++) {
      const card = (await tasks.list()).tasks.find(one => one.title === DISPATCH_TITLE)
      if (card?.client_dispatch !== undefined) return card.client_dispatch
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    throw new Error('派活状态没有收敛:' + JSON.stringify((await tasks.list()).tasks))
  }
  return { hub, tasks, settledDispatch, sends: () => calls.filter(one => one.op === 'send_text'), apiCalls }
}

const dispatchCommand = { name: 'dispatch', new: { title: DISPATCH_TITLE }, to: 'kimi', text: DISPATCH_TEXT }

it('① 电脑入口中枢 dispatch 到窗口手(Kimi):送话的 submit:true,卡记 sent、submitted 核到', async () => {
  const h = await serve()
  const out = await h.hub({ entrance: 'desktop', said: `把样片剪一版派给 Kimi`, commands: [dispatchCommand] })
  expect(out.status).toBe(200)
  expect(h.sends()).toHaveLength(1)
  expect(h.sends()[0]).toMatchObject({ op: 'send_text', bundle_id: 'com.moonshot.kimichat', submit: true, new_conversation: true })
  const dispatch = await h.settledDispatch()
  expect(dispatch).toMatchObject({ hand: 'window', family: 'kimi', status: 'sent', submitted: true })
  expect(String(dispatch.text)).toContain(DISPATCH_TEXT)
  expect((out.body.results as { ok: boolean, who?: string }[])[0]).toMatchObject({ ok: true, who: 'Kimi' })
})

it('② 按了发送、壳回执说没按成:卡记 typed,那句「字写进框里了,没发出去」一个字不变', async () => {
  const h = await serve(false)
  const out = await h.hub({ entrance: 'desktop', said: `把样片剪一版派给 Kimi`, commands: [dispatchCommand] })
  expect(out.status).toBe(200)
  expect(h.sends()).toHaveLength(1)
  expect(h.sends()[0]).toMatchObject({ submit: true })
  const dispatch = await h.settledDispatch()
  expect(dispatch).toMatchObject({ hand: 'window', family: 'kimi', status: 'typed', submitted: false })
  expect(String(dispatch.reason)).toContain('回执尚未确认')
  expect(dispatchBadgeText(dispatch as TaskClientDispatch)).toBe('派给 Kimi(窗口)· 字写进框里了,没发出去')
})

it('① 电话工人(已验证身份)走中枢执行口照旧 submit:true(来源还是「电话」那一种)', async () => {
  const h = await serve()
  const out = await h.hub({ entrance: 'call', said: `把样片剪一版派给 Kimi`, commands: [dispatchCommand] }, 'worker')
  expect(out.status).toBe(200)
  expect(h.sends()).toHaveLength(1)
  expect(h.sends()[0]).toMatchObject({ submit: true })
  expect(await h.settledDispatch()).toMatchObject({ status: 'sent', submitted: true })
})

it('① 入口自报 call 但不是已验证工人:不授予电话来源,仍只填字(来源自报不能升级)', async () => {
  const h = await serve()
  const out = await h.hub({ entrance: 'call', said: `把样片剪一版派给 Kimi`, commands: [dispatchCommand] }, 'page')
  expect(out.status).toBe(200)
  expect(h.sends()).toHaveLength(1)
  expect(h.sends()[0]).toMatchObject({ submit: false })
  expect(await h.settledDispatch()).toMatchObject({ status: 'sent', submitted: false })
})
