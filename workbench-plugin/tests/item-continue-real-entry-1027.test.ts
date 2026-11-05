// @vitest-environment node
/**
 * 真实工作台同事项入口的退修 / 验收主链(2026-10-27 退修批,卡 `t-bd1c04ed`)。
 *
 * root 指出:第一批只测了事务官令牌,不等于真实工作台同事项入口已验通。这一份按
 * **NoteDialog 真实发出的同一组端点、同一顺序、页面身份(Origin)** 走整条链,让
 * 发送 / 执行 / 退修 / 验收每一步都有可见证据:
 *
 *   建事项(★2026-10-29 入口归一:/butler/item 进理解中枢、不再自动开事务官会话 ——
 *     这一张直接带会话建,后续端点与身份门不变)
 *     → 来源清单(GET /butler/item/:id/continue,能续的那条列出来)
 *     → 同事项补充(POST /butler/item/continue,**发送可见**:会话收到原话,回执 sent)
 *     → 验收「改一改」(POST /task/comment verdict + /task/move 回 doing + /butler/item/say
 *        把退修捎回事务官会话 —— **退修回到原执行者可见**)
 *     → 验收「通过」(verdict + 挪 done —— 验收闭环可见)。
 *
 * 不是 mock 结果冒称入口通过:每一步都打在隔离 8791 真 HTTP 上,身份走页面门
 * (与本机安装的事务官页面同一类凭据),不伪造 Origin、不借用户令牌。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ACTOR_TOKEN_HEADER, mintActorTokens } from '../src/server/herself.ts'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { createTasksService } from '../src/server/tasks.ts'

const NOW_SEC = Math.floor(Date.parse('2026-10-27T09:30:00.000Z') / 1000)
const started: WorkbenchServer[] = []
const dirs: string[] = []
afterEach(async () => {
  while (started.length) await started.pop()?.close()
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

const PAGE = { origin: 'http://127.0.0.1:3080' }

interface Harness {
  url: string
  tasks: ReturnType<typeof createTasksService>
  said: { session: string, text: string }[]
  id: string
  sessionId: string
}

async function serve(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'wb-continue-real-'))
  dirs.push(dir)
  let n = 0
  const tasks = createTasksService({ file: join(dir, 'tasks.json'), now: () => NOW_SEC, newId: () => `t-${++n}` })
  const said: { session: string, text: string }[] = []
  const server = await startWorkbenchServer({
    port: 0,
    service: createWorkbenchService({ now: () => NOW_SEC }),
    tickIntervalMs: 0,
    tasks,
    // 与装机同一类身份门:令牌现生,页面走 Origin —— 本用例全部用页面身份(她的真实入口)。
    actorTokens: mintActorTokens(),
    butlerSession: {
      open: async () => 'sess-real-1',
      say: async (session: string, text: string) => { said.push({ session, text }); return true },
    },
  })
  started.push(server)
  return { url: server.url, tasks, said, id: '', sessionId: 'sess-real-1' }
}

async function post(url: string, path: string, body: unknown) {
  const res = await fetch(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...PAGE }, body: JSON.stringify(body) })
  return { status: res.status, body: await res.json().catch(() => ({})) as Record<string, unknown> }
}

async function get(url: string, path: string) {
  const res = await fetch(`${url}${path}`, { headers: PAGE })
  return { status: res.status, body: await res.json().catch(() => ({})) as Record<string, unknown> }
}

describe('工作台同事项入口:补充 → 退修 → 验收,每步可见(真实端点 + 页面身份)', () => {
  it('建事项 → 来源清单 → 补充进会话 → 退修回事务官 → 通过验收', async () => {
    const h = await serve()

    // ① 建事项:带事务官会话的卡(入口归一后会话由中枢的手按需开,这里只钉后续端点链)。
    const made = await h.tasks.create({ title: '把月报整理成两页摘要', direction: 'mine', origin: 'user', conversation: { agent: 'dsh', session_id: 'sess-real-1' } })
    const id = String(made.id)
    expect(id).not.toBe('')
    const card0 = (await h.tasks.list()).tasks.find(one => one.id === id)
    expect(card0?.conversation?.session_id).toBe('sess-real-1')

    // ② 来源清单:同事项入口能续的那条(事务官会话)列得出来(NoteDialog 打开时读的同一条)。
    const sources = await get(h.url, `/butler/item/${id}/continue`)
    expect(sources.status).toBe(200)
    const list = sources.body as { sources: { key: string, title: string, action: { kind: string } }[] }
    expect(list.sources[0]?.action.kind).toBe('butler')

    // ③ 同事项补充:发送可见 —— 原话进会话,回执 sent(不带意图 = 补充,与旧客户端逐字兼容)。
    const sup = await post(h.url, '/butler/item/continue', { id, text: '补充:按新模板分三段' })
    expect(sup.status).toBe(200)
    expect(sup.body).toMatchObject({ ok: true, fact: 'sent' })
    expect(h.said).toContainEqual({ session: 'sess-real-1', text: '补充:按新模板分三段' })

    // ④ 验收「改一改」:NoteDialog 的真实顺序 —— 带结论留言 → 卡挪回「在做」→ 把退修捎回事务官会话。
    const note = '改一改:结论再核实来源'
    const commented = await post(h.url, '/task/comment', { id, text: note, verdict: 'rework' })
    expect(commented.status).toBe(200)
    const moved = await post(h.url, '/task/move', { id, status: 'doing' })
    expect(moved.status).toBe(200)
    const reworkSaid = await post(h.url, '/butler/item/say', { id, text: note })
    expect(reworkSaid.status).toBe(200)
    // 退修回到原执行者可见:会话收到同一句,卡回到「在做」。
    expect(h.said.some(one => one.text === note)).toBe(true)
    const cardMid = (await h.tasks.list()).tasks.find(one => one.id === id)
    expect(cardMid?.status).toBe('doing')

    // ⑤ 验收「通过」:带结论留言 → 挪「做完」—— 验收闭环,不需要原生 DSH / 终端 / UUID。
    const pass = await post(h.url, '/task/comment', { id, text: '通过,来源已核', verdict: 'pass' })
    expect(pass.status).toBe(200)
    const done = await post(h.url, '/task/move', { id, status: 'done' })
    expect(done.status).toBe(200)
    const cardDone = (await h.tasks.list()).tasks.find(one => one.id === id)
    expect(cardDone?.status).toBe('done')
  })

  it('无凭据程序走同一组端点 → 403(A11 不放宽;真实入口的身份门在场)', async () => {
    const h = await serve()
    const made = await fetch(`${h.url}/butler/item`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '整理报告' }),
    })
    expect(made.status).toBe(403)
    const res = await fetch(`${h.url}/butler/item/continue`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 't-1', text: '补充' }),
    })
    expect(res.status).toBe(403)
    expect(h.said).toEqual([])
  })

  it('令牌先认:事务官自己的令牌压过伪造的页面 Origin(不伪造身份进真实入口)', async () => {
    const h = await serve()
    const dir = mkdtempSync(join(tmpdir(), 'wb-continue-token-'))
    dirs.push(dir)
    let n = 0
    const tasks = createTasksService({ file: join(dir, 'tasks.json'), now: () => NOW_SEC, newId: () => `t-${++n}` })
    const said: { session: string, text: string }[] = []
    const tokens = mintActorTokens()
    const server = await startWorkbenchServer({
      port: 0,
      service: createWorkbenchService({ now: () => NOW_SEC }),
      tickIntervalMs: 0,
      tasks,
      actorTokens: tokens,
      butlerSession: {
        open: async () => 'sess-tok',
        say: async (session: string, text: string) => { said.push({ session, text }); return true },
      },
    })
    started.push(server)
    const created = await tasks.create({ title: 'x', status: 'doing' })
    await tasks.update(created.id as string, { conversation: { agent: 'dsh', session_id: 'sess-tok' } })
    // 带 butler 令牌、又伪造 Origin:认出来的仍是事务官(与 herself.ts 同一判据)。
    const r = await fetch(`${server.url}/butler/item/continue`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [ACTOR_TOKEN_HEADER]: tokens.butler, origin: 'http://127.0.0.1:3080' },
      body: JSON.stringify({ id: created.id, text: '补一句' }),
    })
    expect(r.status).toBe(200)
    expect(said).toContainEqual({ session: 'sess-tok', text: '补一句' })
  })
})
