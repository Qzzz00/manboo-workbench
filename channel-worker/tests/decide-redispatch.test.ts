/**
 * 电话里对一件「派活没成」的事说「重做一次」→ **真的再派一次**(2026-10-01 Air 诊断包 095718)。
 *
 * 现场:派给豆包没成 → 来电 → 她问「要不要让它重做一次」→ 他说「嗯,重做一次」→ 工人调了打回去
 * (`decideItem redo` → `POST /task/move doing`),嘴上说「事务官会接着做」—— 可一下都没再派,
 * 卡停在「豆包办公 在做(没看到它在跑)」。按维护者口径(任一步失败都要明说),这是一句做不到的承诺。
 *
 * 守:
 * ① 负责人是某家 AI、上一次派活没成 → 走 `POST /dispatch/run`(派活的唯一入口),来源记 `call`;
 *    这次派成了就照工作台那句说,又没成就**照实说又没成 + 原因**,不说「接着做」;
 * ② 别的事项照旧挪回进行中(老行为不变);
 * ③ 读不到看板时不猜,照旧挪(并且不许说成重派了)。
 */
import { describe, expect, it } from 'vitest'
import { createWorkbenchClient } from '../src/workbench.ts'

interface Call { path: string, body?: unknown }

function harness(task: Record<string, unknown> | undefined, run: { ok: boolean, note: string } = { ok: true, note: '派给 豆包办公 了(窗口),它那边看到了' }) {
  const calls: Call[] = []
  const fetchImpl = (async (url: string, init?: { body?: string }) => {
    const path = new URL(url).pathname
    calls.push({ path, ...(init?.body === undefined ? {} : { body: JSON.parse(init.body) as unknown }) })
    if (path === '/state') return new Response(JSON.stringify({ tasks: { tasks: task === undefined ? [] : [task] } }))
    if (path === '/dispatch/run') return new Response(JSON.stringify(run))
    if (path === '/task/move') return new Response(JSON.stringify({ ok: true }))
    return new Response('{}')
  }) as unknown as typeof fetch
  return { calls, workbench: createWorkbenchClient({ baseUrl: 'http://127.0.0.1:8791', fetchImpl }) }
}

const FAILED_DOUBAO = {
  id: 't-6366cfcd',
  title: '让豆包说明今天深圳的天气',
  status: 'blocked',
  block_reason: 'error',
  assignee: 'doubao',
  client_dispatch: { hand: 'window', family: 'doubao', status: 'failed', at: '2026-10-01T01:37:03.555Z', text: 'x', reason: '找不到窗口' },
}

describe('派活没成的那件,电话里说「重做一次」', () => {
  it('★真的再派一次:走 /dispatch/run(app = 负责人,来源 call),不只是挪卡', async () => {
    const h = harness(FAILED_DOUBAO)
    const got = await h.workbench.decideItem('t-6366cfcd', 'redo')
    expect(h.calls.find(one => one.path === '/dispatch/run')?.body).toEqual({ item_id: 't-6366cfcd', app: 'doubao', source: 'call' })
    expect(h.calls.some(one => one.path === '/task/move')).toBe(false)
    expect(got.ok).toBe(true)
    expect(got.text).toContain('它那边看到了')
    expect(got.text).not.toContain('事务官会接着做')
  })

  it('★又没派出去:照实说又没成和原因,ok:false,不许说成重做了', async () => {
    const h = harness(FAILED_DOUBAO, { ok: false, note: '派给 豆包办公 没派出去:窗口:找不到窗口' })
    const got = await h.workbench.decideItem('t-6366cfcd', 'redo')
    expect(got.ok).toBe(false)
    expect(got.text).toContain('又没派出去')
    expect(got.text).toContain('找不到窗口')
  })

  it('按了发送没核上(typed)也算没成,同样重派', async () => {
    const h = harness({ ...FAILED_DOUBAO, client_dispatch: { ...FAILED_DOUBAO.client_dispatch, status: 'typed' } })
    await h.workbench.decideItem('t-6366cfcd', 'redo')
    expect(h.calls.some(one => one.path === '/dispatch/run')).toBe(true)
  })

  it('等她验收的那件(派成了、交回来了)打回去:照旧挪回进行中', async () => {
    const h = harness({ ...FAILED_DOUBAO, status: 'confirm', block_reason: undefined, client_dispatch: { ...FAILED_DOUBAO.client_dispatch, status: 'sent', reply_state: 'done' } })
    const got = await h.workbench.decideItem('t-6366cfcd', 'redo')
    expect(h.calls.find(one => one.path === '/task/move')?.body).toEqual({ id: 't-6366cfcd', status: 'doing' })
    expect(h.calls.some(one => one.path === '/dispatch/run')).toBe(false)
    expect(got.ok).toBe(true)
  })

  it('事务官自己的事 / 没负责人的:照旧挪', async () => {
    const h = harness({ ...FAILED_DOUBAO, assignee: 'dsh' })
    await h.workbench.decideItem('t-6366cfcd', 'redo')
    expect(h.calls.some(one => one.path === '/dispatch/run')).toBe(false)
    expect(h.calls.some(one => one.path === '/task/move')).toBe(true)
  })

  it('看板上找不到这件:照旧挪,不说成重派了', async () => {
    const h = harness(undefined)
    const got = await h.workbench.decideItem('t-6366cfcd', 'redo')
    expect(h.calls.some(one => one.path === '/dispatch/run')).toBe(false)
    expect(got.text).not.toContain('派')
  })
})
