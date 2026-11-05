// @vitest-environment node
/**
 * 派不派由模型出的命令决定(2026-10-29 入口归一退修 1;本文件 2026-10-27 的派发回退语义已随旧路删除)。
 *
 * `/butler/item` 不再有「派发意图 / 分工默认 / 词表回退」任何一条旧路 —— 一律进理解中枢:
 *   - 模型出 note / chat(不出 dispatch)→ 不派:卡照建、不设负责人、窗口零发送 —— 哪怕原话里点到了家
 *     (旧「命令 / 否定 / 背景句」本地词表分支已删,派不派只看模型命令);
 *   - 模型出 dispatch(to 点名)→ 当场派:卡上写负责人、窗口那只手真送话;body 里她点的名只作为
 *     事实进上下文包(「这条请求点了名「kimi」」),由模型按命令点名那一家,不反问接收者;
 *   - 模型没接成 → 503 如实回,一张卡不建、一家不派 —— 旧「未知档:建卡 + 开事务官会话」回退
 *     随旧路删除;话里点没点到家都一样待遇(不再有分工兜底)。
 *
 * 这不是 mock 冒称通过:每个断言都打在隔离 8791 真 HTTP 上,假模型经 fetchImpl 注入,
 * 表外的句子回 503 —— 不许悄悄冒称听懂。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { HelperRequest } from '../src/server/helperChannel.ts'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { createTasksService } from '../src/server/tasks.ts'
import { engineHarness } from './helpers/engineHarness.ts'
import { fakeHubModel, type FakeHubModel } from './helpers/fakeHubModel.ts'

const started: WorkbenchServer[] = []
const dirs: string[] = []
afterEach(async () => {
  while (started.length) await started.pop()?.close()
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

const PAGE = { origin: 'http://127.0.0.1:3080' }

async function serve(model?: FakeHubModel) {
  const dir = mkdtempSync(join(tmpdir(), 'wb-fallback-http-'))
  dirs.push(dir)
  let n = 0
  const tasks = createTasksService({ file: join(dir, 'tasks.json'), newId: () => `t-${++n}` })
  const helperCalls: HelperRequest[] = []
  const request = async (req: HelperRequest): Promise<Record<string, unknown>> => {
    helperCalls.push(req)
    if (req.op === 'send_text') return { method: 'ax_value', submitted: req.submit === true, new_conversation: '新聊天' }
    return { found: false, busy: false }
  }
  const engine = engineHarness({ helper: { connected: () => true, supports: () => true, request } })
  const server = await startWorkbenchServer({
    port: 0,
    service: createWorkbenchService({}),
    tickIntervalMs: 0,
    heartbeatMs: 0,
    tasks,
    engine: engine.engine,
    engineRegistry: engine.registry,
    helper: {
      attach: () => {},
      view: () => ({ connected: true, authorized: true }) as never,
      connected: () => true,
      onChange: () => {},
      onEvent: () => {},
      request,
    },
    runCommand: async () => ({ ok: true, stdout: '"pid"=123' }),
    appInstalled: () => true,
    ...(model === undefined
      // 模型必然连不上(本机 127.0.0.1:19)→ 走「没接成」那一档。
      ? { model: { endpoint: async () => ({ baseUrl: 'http://127.0.0.1:19/v1', key: 'qa', model: 'qa', ready: true }) } as never }
      : { model: model.service as never, fetchImpl: model.fetchImpl }),
  })
  started.push(server)
  return { url: server.url, tasks, helperCalls }
}

async function post(url: string, path: string, body: unknown) {
  const res = await fetch(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...PAGE }, body: JSON.stringify(body) })
  return { status: res.status, body: await res.json().catch(() => ({})) as Record<string, unknown> }
}

describe('模型出 note(不出 dispatch)→ 不派:卡照建、不设负责人、窗口零发送(原句回归)', () => {
  it.each([
    '不要让 Claude 处理，这次交给 Kimi',
    '昨天让 Claude 做了，今天交给 Kimi',
    '不能再让 Codex 碰这个，交给 Kimi',
  ])('命令/否定/背景句(模型不派):不设负责人、零发送 —— %s', async (text) => {
    const model = fakeHubModel({ [text]: [{ name: 'note', title: text, status: 'todo' }] })
    const h = await serve(model)
    const r = await post(h.url, '/butler/item', { text })
    expect(r.status).toBe(200)
    expect(r.body.ok).toBe(true)
    const card = (await h.tasks.list()).tasks[0]
    expect(card?.assignee).toBeUndefined()
    expect(h.helperCalls.filter(one => one.op === 'send_text')).toEqual([])
  })
})

describe('模型出 dispatch → 当场派:卡上写负责人、窗口那只手真送话', () => {
  it('没点名:执行层挑手照派,不因为话里没带家被吞', async () => {
    const text = '用一句话总结这篇资讯'
    const model = fakeHubModel({ [text]: [{ name: 'dispatch', new: { title: '总结这篇资讯' }, text }] })
    const h = await serve(model)
    const r = await post(h.url, '/butler/item', { text })
    expect(r.status).toBe(200)
    expect(r.body.dispatch_ok).toBe(true)
    const card = (await h.tasks.list()).tasks[0]
    expect(card?.assignee).toBeDefined()
    expect(h.helperCalls.filter(one => one.op === 'send_text')).toHaveLength(1)
  })

  it('显式 assignee(界面选 / 电话直填)+ 模型出 dispatch to 那家:直接派,点名作为事实进上下文包、不反问接收者', async () => {
    const text = '让 Kimi 用一句话总结这篇资讯'
    const model = fakeHubModel({ [text]: [{ name: 'dispatch', new: { title: '总结这篇资讯' }, to: 'kimi', text }] })
    const h = await serve(model)
    const r = await post(h.url, '/butler/item', { text, assignee: 'kimi', source: 'call' })
    expect(r.status).toBe(200)
    expect(r.body.dispatch_ok).toBe(true)
    expect((await h.tasks.list()).tasks[0]?.assignee).toBe('kimi')
    expect(h.helperCalls.filter(one => one.op === 'send_text')).toHaveLength(1)
    // 她点的名作为事实进了上下文包(模型读的提示里看得见),不是 body 自报直接生效。
    expect(String(model.seen.prompts.at(-1) ?? '')).toContain('点了名「kimi」')
  })
})

describe('模型没接成 → 503 如实回:一张卡不建、一家不派(旧「未知档」回退已删)', () => {
  it('话里点到家也一样:%s', async () => {
    const h = await serve()
    const r = await post(h.url, '/butler/item', { text: '把这个任务交给 Claude 改一下' })
    expect(r.status).toBe(503)
    expect((await h.tasks.list()).tasks).toHaveLength(0)
    expect(h.helperCalls.filter(one => one.op === 'send_text')).toEqual([])
    expect(String(r.body.error ?? '')).toContain('没接上')
  })

  it('没点到家也一样(不再有分工默认兜底)', async () => {
    const h = await serve()
    const r = await post(h.url, '/butler/item', { text: '把这份整理成表格发给客户' })
    expect(r.status).toBe(503)
    expect((await h.tasks.list()).tasks).toHaveLength(0)
    expect(h.helperCalls.filter(one => one.op === 'send_text')).toEqual([])
  })
})
