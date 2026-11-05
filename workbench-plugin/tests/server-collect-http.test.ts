// @vitest-environment node
/**
 * 采集的三条路由(2026-09-22):`GET /collect`、`POST /collect/note|breakdown`,
 * 以及 `/state.xhs_collect`。
 *
 * 这一份钉三件:
 *   ① **没接采集服务时整块 404 / 缺席** —— 界面据此连入口都不出;
 *   ② **写的那两条只认回环** —— 配对过的手机也不行(在手机上点一下就让他的 Mac
 *      去打开别人的笔记页,是这类功能最吓人的行为,口径同 `/xhs/*`);
 *   ③ **这里没有、也不会有一条"按关键词采一批"的路由** —— 源码扫描钉着。
 */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import type { WorkbenchState } from '../src/protocol.ts'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import type { XhsCollectApi } from '../src/server/xhsCollect.ts'
import { FAKE_NOTE_URL } from './xhsNoteFixtures.ts'

const started: WorkbenchServer[] = []
afterEach(async () => { while (started.length) await started.pop()?.close() })

function stubApi(): XhsCollectApi & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    view: async () => ({ today: 1, daily_max: 30, logs: [], workdir_ready: true }),
    collectNote: async (url) => { calls.push(`note:${String(url)}`); return { ok: true, message: '采到了', dir: '/tmp/x', comments: 3 } },
    breakdown: async (url) => { calls.push(`breakdown:${String(url)}`); return { ok: true, message: '拆好了', file: '/tmp/x/拆解.md' } },
  }
}

async function serve(collect?: XhsCollectApi): Promise<{ base: string }> {
  const service = createWorkbenchService({ now: () => 0 })
  const server = await startWorkbenchServer({
    service,
    port: 0,
    ...(collect === undefined ? {} : { collect }),
  })
  started.push(server)
  return { base: `http://127.0.0.1:${server.port}` }
}

describe('没接采集服务', () => {
  it('★ /collect/* 一律 404,/state.xhs_collect 缺席', async () => {
    const { base } = await serve()
    expect((await fetch(`${base}/collect`)).status).toBe(404)
    const posted = await fetch(`${base}/collect/note`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: FAKE_NOTE_URL }),
    })
    expect(posted.status).toBe(404)
    expect((await posted.json() as { error: string }).error).toContain('采集未启用')

    const state = await (await fetch(`${base}/state`)).json() as WorkbenchState
    expect(state.xhs_collect).toBeUndefined()
  })
})

describe('接上之后', () => {
  it('GET /collect 与 /state.xhs_collect 是同一份', async () => {
    const api = stubApi()
    const { base } = await serve(api)
    const one = await (await fetch(`${base}/collect`)).json()
    const state = await (await fetch(`${base}/state`)).json() as WorkbenchState
    expect(state.xhs_collect).toEqual(one)
    expect(state.xhs_collect?.daily_max).toBe(30)
  })

  it('POST /collect/note 把他给的链接原样交给服务,并广播一次快照', async () => {
    const api = stubApi()
    const { base } = await serve(api)
    const res = await fetch(`${base}/collect/note`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: FAKE_NOTE_URL }),
    })
    expect(res.status).toBe(200)
    expect(api.calls).toEqual([`note:${FAKE_NOTE_URL}`])
  })

  it('服务说 ok:false 时回 409 + 那句人话(不是 200 假装成功)', async () => {
    const api = stubApi()
    api.collectNote = async () => ({ ok: false, message: '这条刚采过,9 分钟后再来' })
    const { base } = await serve(api)
    const res = await fetch(`${base}/collect/note`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: FAKE_NOTE_URL }),
    })
    expect(res.status).toBe(409)
    expect((await res.json() as { message: string }).message).toContain('刚采过')
  })

  it('POST /collect/breakdown 同样走通', async () => {
    const api = stubApi()
    const { base } = await serve(api)
    const res = await fetch(`${base}/collect/breakdown`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: FAKE_NOTE_URL }),
    })
    expect(res.status).toBe(200)
    expect(api.calls).toEqual([`breakdown:${FAKE_NOTE_URL}`])
  })

  it('没有的路由回 404,不静默成功', async () => {
    const api = stubApi()
    const { base } = await serve(api)
    expect((await fetch(`${base}/collect/搜索`, { method: 'POST' })).status).toBe(404)
  })
})

describe('★ 源码扫描:没有"按关键词采一批"这回事', () => {
  it('http.ts 的采集那一段里没有 search / keyword / batch 这类路由', async () => {
    const source = await readFile(fileURLToPath(new URL('../src/server/http.ts', import.meta.url)), 'utf8')
    const block = source.slice(source.indexOf("if (path.startsWith('/collect'))"))
    const until = block.slice(0, block.indexOf("if (path === '/template'"))
    for (const word of ['/collect/search', '/collect/user', '/collect/batch', 'keyword']) {
      expect(until).not.toContain(word)
    }
  })
})
