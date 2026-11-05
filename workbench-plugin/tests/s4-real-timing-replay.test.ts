// @vitest-environment node
// 原 normal-run-3 的离线重放；不访问模型、Swift 或真实电话。
// A2(2026-10-28)起电话进理解中枢:模型回的是命令表形状,这里用同一句话译成的命令(记 + 派 Claude)重放;
// 那份录下来的旧形状正文仍留在验收目录里作历史。音色那半句命令表里没有,不再出现在这一句的结果里。
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { startWorkbenchServer, type WorkbenchServer } from '../src/server/http.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { createTasksService } from '../src/server/tasks.ts'
import { createClientKeyLedger } from '../src/server/clientKeys.ts'
import { ACTOR_TOKEN_HEADER, mintActorTokens } from '../src/server/herself.ts'
import type { HelperRequest } from '../src/server/helperChannel.ts'
import { engineHarness } from './helpers/engineHarness.ts'

const raw = { finish_reason: 'stop', content: JSON.stringify({ commands: [
  { name: 'note', title: '周四下午给客户发样片', status: 'todo' },
  { name: 'dispatch', new: { title: '把样片剪一版' }, to: 'claude', text: '把样片派给 Claude 剪一版' },
] }) }
const text = '帮我建一个待办:周四下午给客户发样片,再把样片派给 Claude 剪一版,然后换个女声'
const dirs: string[] = [], servers: WorkbenchServer[] = []
afterEach(async () => {
  while (servers.length) await servers.pop()!.close()
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

it.each([false, true])('同raw三项完成与原号结果保留，两个HTTP等待中止=%s（仅本地重放）', async abort => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-s4-timing-')); dirs.push(dir)
  const tasks = createTasksService({ file: join(dir, 'tasks.json') })
  const tokens = mintActorTokens(), ledger = createClientKeyLedger({ file: join(dir, 'results.json'), abortReleaseMs: 1000 })
  const events: string[] = [], sends: HelperRequest[] = []
  let release!: () => void, entered!: () => void, finished!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const sending = new Promise<void>(resolve => { entered = resolve })
  const recorded = new Promise<void>(resolve => { finished = resolve })
  let modelCalls = 0, begins = 0, voiceWrites = 0
  const request = async (req: HelperRequest): Promise<Record<string, unknown>> => {
    if (req.op !== 'send_text') return { found: false, busy: false }
    sends.push(req); events.push('send-start'); entered()
    await gate
    events.push('submitted')
    return { submitted: req.submit === true, method: 'ax_value', new_conversation: 'New Session' }
  }
  const engine = engineHarness({ helper: { connected: () => true, supports: () => true, request } })
  const server = await startWorkbenchServer({
    port: 0, tickIntervalMs: 0, heartbeatMs: 0, tasks, actorTokens: tokens,
    service: createWorkbenchService({}), engine: engine.engine,
    helper: { attach: () => {}, view: () => ({ connected: true, authorized: true }) as never, connected: () => true, onChange: () => {}, onEvent: () => {}, request },
    runCommand: async () => ({ ok: true, stdout: '"pid"=123' }), appInstalled: () => true,
    projects: { getProjectsState: async () => ({ projects: [{ id: 'sample', name: '样片', path: dir }] }) } as never,
    model: { endpoint: async () => ({ baseUrl: 'http://fixture.invalid/v1', key: 'fixture', model: 'deepseek-v4-flash', ready: true }) } as never,
    fetchImpl: (async () => {
      modelCalls++; events.push('model-visible-response')
      return new Response(JSON.stringify({ choices: [{ finish_reason: raw.finish_reason, message: { content: raw.content } }] }))
    }) as typeof fetch,
    butler: { view: async () => ({}), proxy: async ({ method }: { method: string }) => {
      if (method === 'PUT') { voiceWrites++; events.push('voice-updated') }
      return { status: 200, body: Buffer.from(JSON.stringify({ voices: [{ id: 'fixture-female', gender: '女', speaks_chinese: true }] })) }
    } } as never,
    clientKeys: { flush: ledger.flush, begin: async (scope, key) => {
      begins++
      const got = await ledger.begin(scope, key)
      return got.kind === 'replay' ? got : { ...got, finish: (status, body) => {
        got.finish(status, body); events.push('http-result-recorded'); finished()
      } }
    } },
  })
  servers.push(server)
  const post = (signal?: AbortSignal) => fetch(server.url + '/butler/say', {
    method: 'POST', headers: { 'content-type': 'application/json', [ACTOR_TOKEN_HEADER]: tokens.worker },
    body: JSON.stringify({ text, entrance: 'phone', ctx: { in_call: true }, client_key: 'local-raw-replay' }),
    ...(signal ? { signal } : {}),
  })
  const controller = new AbortController()
  const first = post(controller.signal).catch(() => undefined)
  await sending
  expect((await tasks.list()).tasks).toHaveLength(2)
  if (abort) {
    controller.abort(); expect(await first).toBeUndefined()
    const next = new AbortController(), retry = post(next.signal).catch(() => undefined)
    await expect.poll(() => begins).toBe(2)
    next.abort(); expect(await retry).toBeUndefined()
    events.push('both-clients-aborted')
  }
  release()
  await recorded
  if (!abort) expect((await first)?.status).toBe(200)
  await ledger.flush()
  const response = await post(), reply = await response.json()
  expect(response.status).toBe(200)
  expect(reply.replayed).toBe(true)
  expect(reply.items.map((x: { kind: string, status: string }) => [x.kind, x.status])).toEqual([['记', 'done'], ['办', 'done']])
  expect(reply.say.spoken).toContain('周四下午给客户发样片')
  expect(reply.say.spoken).toMatch(/claude/i)
  const stored = JSON.parse(readFileSync(join(dir, 'results.json'), 'utf8'))
  expect(stored.entries).toHaveLength(1)
  expect(JSON.parse(stored.entries[0].body).say).toEqual(reply.say)
  expect(modelCalls).toBe(1); expect(voiceWrites).toBe(0); expect(sends).toHaveLength(1)
  expect(sends[0]).toMatchObject({ bundle_id: 'com.anthropic.claudefordesktop', submit: true, new_conversation: true })
  const cards = (await tasks.list()).tasks
  expect(cards).toHaveLength(2)
  expect(events.indexOf('submitted')).toBeLessThan(events.indexOf('http-result-recorded'))
  if (abort) expect(events.indexOf('both-clients-aborted')).toBeLessThan(events.indexOf('submitted'))
})
