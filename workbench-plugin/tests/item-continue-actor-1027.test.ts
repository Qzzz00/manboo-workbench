// @vitest-environment node
/**
 * 同事项续接的合法协调入口(2026-10-27,卡 `t-bd1c04ed` 第一批;
 * 交接 `docs/交接-1027-委托派发机制第一批.md` 设计第 4 条)。
 *
 * 现场:统筹(root)用程序经正常 continue 入口续接受 403「认不出你是谁」—— 那是 A11
 * 身份门正常工作,不是缺陷,不靠放宽门 / 伪造 Origin / 借用户令牌解决。合法受委托的
 * 协调入口 = **事务官自己的进程令牌**(`x-workbench-actor`,只进 8791 子进程 env,
 * 不落盘);root/外部程序没有这把令牌,正路是真实页面入口(维护者已确认的兜底)。
 *
 * 这一份钉:带事务官令牌的 continue 补得进事务官那条会话(补充原话直发、改方向带框),
 * 不带凭据的程序调用照旧 403(A11 不放宽)。
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

const NOW_SEC = Math.floor(Date.parse('2026-10-27T09:00:00.000Z') / 1000)
const started: WorkbenchServer[] = []
const dirs: string[] = []
afterEach(async () => {
  while (started.length) await started.pop()?.close()
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

interface Harness {
  url: string
  tasks: ReturnType<typeof createTasksService>
  said: { session: string, text: string, mode?: string }[]
  id: string
  token: string
}

async function serve(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'wb-continue-actor-'))
  dirs.push(dir)
  let n = 0
  const tasks = createTasksService({ file: join(dir, 'tasks.json'), now: () => NOW_SEC, newId: () => `t-${++n}` })
  const said: { session: string, text: string, mode?: string }[] = []
  const tokens = mintActorTokens()
  const server = await startWorkbenchServer({
    port: 0,
    service: createWorkbenchService({ now: () => NOW_SEC }),
    tickIntervalMs: 0,
    tasks,
    actorTokens: tokens,
    butlerSession: {
      open: async () => 'sess-new',
      say: async (session: string, text: string, _onRejected?: (reason: 'model' | 'host') => void, opts?: { mode?: string }) => {
        said.push({ session, text, ...(opts?.mode === undefined ? {} : { mode: opts.mode }) })
        return true
      },
      clearQueued: async () => ({ removed: [] as string[], remaining: [] as string[], incomplete: false }),
    },
  })
  started.push(server)
  const created = await tasks.create({ title: '机制重设计', status: 'doing' })
  const id = created.id as string
  await tasks.update(id, { conversation: { agent: 'dsh', session_id: 'sess-butler-1' } })
  return { url: server.url, tasks, said, id, token: tokens.butler }
}

async function post(url: string, path: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: await res.json().catch(() => ({})) as Record<string, unknown> }
}

describe('同事项续接:事务官令牌是合法协调入口,无凭据程序照旧 403', () => {
  it('事务官带自己的进程令牌补一句 → 原话直发进它那条会话(不伪造身份、不借用户令牌)', async () => {
    const h = await serve()
    const r = await post(h.url, '/butler/item/continue', { id: h.id, text: '补充:优先级以派发主链为先' }, { [ACTOR_TOKEN_HEADER]: h.token })
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ ok: true, fact: 'sent' })
    expect(h.said).toHaveLength(1)
    expect(h.said[0]).toMatchObject({ session: 'sess-butler-1', text: '补充:优先级以派发主链为先' })
  })

  it('事务官令牌走「改方向」→ 打断模式 + 固定框进会话,旧办法作废交代在框里', async () => {
    const h = await serve()
    const r = await post(h.url, '/butler/item/continue', { id: h.id, text: '先修派发,预算机制第二批再做', intent: 'redirect' }, { [ACTOR_TOKEN_HEADER]: h.token })
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ ok: true, fact: 'redirected' })
    expect(h.said[0]?.session).toBe('sess-butler-1')
    expect(h.said[0]?.mode).toBe('steer')
    expect(h.said[0]?.text).toContain('【改方向')
    expect(h.said[0]?.text).toContain('先修派发,预算机制第二批再做')
    expect(h.said[0]?.text).toContain('作废')
  })

  it('不带凭据的程序(派出去的别家 / 随手 curl)→ 照旧 403,A11 不放宽', async () => {
    const h = await serve()
    const r = await post(h.url, '/butler/item/continue', { id: h.id, text: '补充一句' })
    expect(r.status).toBe(403)
    expect(String(r.body.error ?? '')).toContain('认不出你是谁')
    expect(h.said).toEqual([])
  })
})
