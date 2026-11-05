// @vitest-environment node
/**
 * `POST /dispatch/api` —— 把这件事经中转发给 GPT / 豆包(2026-09-22)。
 *
 * 写法对齐 `server-dispatch-client-http.test.ts`,但上游这一头是**真起一个假中转**
 * (一个会说 OpenAI 方言的 http 服务器):这条路最容易出问题的地方在"发出去的那条请求
 * 长什么样、回来的东西怎么落到卡上",mock 掉 fetch 就验不到 ——
 * 与 relay 那边「不 mock fetch」是同一条理由。
 *
 * 钉四样:① 门(只认回环、模型服务没接就 404、参数校验);② 记到卡上;
 * ③ 失败也记(**不假装成功**);④ 项目上下文真被拼进去了。
 */
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { createTasksService } from '../src/server/tasks.ts'

const started: WorkbenchServer[] = []
const relays: (() => Promise<void>)[] = []

afterEach(async () => {
  while (started.length) await started.pop()?.close()
  while (relays.length) await relays.pop()?.()
})

/** 一个假中转。记下收到的每一条请求体,回一句写死的话。 */
async function fakeRelay(reply: unknown = {
  choices: [{ message: { content: '给你三个标题:一、二、三' } }],
  usage: { total_tokens: 88 },
}, status = 200) {
  const bodies: Record<string, unknown>[] = []
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => { raw += chunk })
    req.on('end', () => {
      try { bodies.push(JSON.parse(raw) as Record<string, unknown>) } catch { /* 记不下就算了 */ }
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(reply))
    })
  })
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  const port = (server.address() as AddressInfo).port
  relays.push(() => new Promise<void>(done => { server.close(() => done()) }))
  return { baseUrl: `http://127.0.0.1:${port}/v1`, bodies }
}

/** 只把 `endpoint()` 接上 —— 这条路用到的就这一样。 */
function fakeModel(baseUrl: string, over: Record<string, unknown> = {}) {
  return {
    endpoint: () => Promise.resolve({ mode: 'relay', baseUrl, key: 'wb_token_x', ready: true, ...over }),
  } as unknown as NonNullable<Parameters<typeof startWorkbenchServer>[0]['model']>
}

async function tasksService() {
  const file = join(await mkdtemp(join(tmpdir(), 'dispatch-api-tasks-')), 'tasks.json')
  return createTasksService({ file })
}

async function serve(extra: Partial<Parameters<typeof startWorkbenchServer>[0]> = {}) {
  const server = await startWorkbenchServer({
    port: 0,
    service: createWorkbenchService(),
    tickIntervalMs: 0,
    ...extra,
  })
  started.push(server)
  return server.url
}

async function post(url: string, path: string, body: unknown) {
  const res = await fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: await res.json() as Record<string, unknown> }
}

describe('门', () => {
  it('★ 模型服务没接进来就 404,不假装发得出去', async () => {
    const url = await serve()
    expect((await post(url, '/dispatch/api', { app: 'gpt', text: 'x' })).status).toBe(404)
  })

  it('★ 老三家走不了这只手 —— 400,并且说清它们该走哪儿', async () => {
    const relay = await fakeRelay()
    const url = await serve({ model: fakeModel(relay.baseUrl) })
    const res = await post(url, '/dispatch/api', { app: 'codex', text: 'x' })
    expect(res.status).toBe(400)
    expect(String(res.body.error)).toContain('gpt / doubao')
    expect(relay.bodies).toHaveLength(0)
  })

  it('正文空的就 400,一个字节都不发出去', async () => {
    const relay = await fakeRelay()
    const url = await serve({ model: fakeModel(relay.baseUrl) })
    expect((await post(url, '/dispatch/api', { app: 'gpt', text: '  ' })).status).toBe(400)
    expect(relay.bodies).toHaveLength(0)
  })
})

describe('真发一次', () => {
  it('回包里带着它写的那段话与卡上那句小标', async () => {
    const relay = await fakeRelay()
    const url = await serve({ model: fakeModel(relay.baseUrl) })
    const res = await post(url, '/dispatch/api', { app: 'gpt', text: '给这条笔记写三个标题' })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.reply).toBe('给你三个标题:一、二、三')
    expect(res.body.note).toBe('派给 GPT,完成')
    expect(res.body.tokens).toBe(88)
    // 发过去的那条:默认模型 + system/user 两条。
    expect(relay.bodies[0]?.model).toBe('gpt-4o')
    expect((relay.bodies[0]?.messages as unknown[])).toHaveLength(2)
  })

  it('★ 带 item_id 就记到卡上:hand=api、状态 done、note 是回答的开头', async () => {
    const relay = await fakeRelay()
    const tasks = await tasksService()
    const created = await tasks.create({ title: '写标题' })
    const url = await serve({ model: fakeModel(relay.baseUrl), tasks })
    await post(url, '/dispatch/api', { app: 'gpt', text: '给这条笔记写三个标题', item_id: created.id })
    const stored = (await tasks.list()).tasks.find(one => one.id === created.id)
    expect(stored?.dispatch?.hand).toBe('api')
    expect(stored?.dispatch?.family).toBe('gpt')
    expect(stored?.dispatch?.status).toBe('done')
    expect(stored?.dispatch?.note).toContain('三个标题')
    // ★ 这只手不碰文件,所以卡上那一格没有工作目录 —— 不编一个出来。
    expect(stored?.dispatch?.cwd).toBeUndefined()
  })

  it('★ 没成也记到卡上,原话一个字不改(不假装成功)', async () => {
    const relay = await fakeRelay(
      { error: { message: '服务器没配 OpenAI(缺 RELAY_OPENAI_KEY),这条请求发不出去。', code: 'openai_not_configured' } },
      503,
    )
    const tasks = await tasksService()
    const created = await tasks.create({ title: '写标题' })
    const url = await serve({ model: fakeModel(relay.baseUrl), tasks })
    const res = await post(url, '/dispatch/api', { app: 'gpt', text: 'x', item_id: created.id })
    expect(res.body.ok).toBe(false)
    expect(res.body.kind).toBe('not_configured')
    const stored = (await tasks.list()).tasks.find(one => one.id === created.id)
    expect(stored?.dispatch?.status).toBe('failed')
    expect(stored?.dispatch?.note).toContain('服务器没配 OpenAI')
    expect(String(res.body.note)).toContain('派给 GPT,失败')
  })

  it('豆包走的是同一条路,模型名前缀是 doubao-', async () => {
    const relay = await fakeRelay()
    const url = await serve({ model: fakeModel(relay.baseUrl) })
    const res = await post(url, '/dispatch/api', { app: 'doubao', text: '把这段润色一下' })
    expect(res.body.ok).toBe(true)
    expect(String(relay.bodies[0]?.model).startsWith('doubao-')).toBe(true)
    expect(res.body.note).toBe('派给 豆包办公,完成')
  })

  it('★ 用自己的 DeepSeek Key 时如实拦下,不把 gpt-4o 发出去', async () => {
    const relay = await fakeRelay()
    const url = await serve({ model: fakeModel(relay.baseUrl, { mode: 'own' }) })
    const res = await post(url, '/dispatch/api', { app: 'gpt', text: 'x' })
    expect(res.body.ok).toBe(false)
    expect(res.body.kind).toBe('not_relay')
    expect(relay.bodies).toHaveLength(0)
  })
})
