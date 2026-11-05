// @vitest-environment node
/**
 * 采集器那五条路由 + 小组件白名单第七条(2026-09-23,用户层)。
 *
 * 钉三件:
 * 1. `/collector/*` 只认回环、只认 POST;没接服务时一律 404、`/state.collectors` 缺席;
 * 2. `GET /module/data?name=` **模块身份**(sandbox 之后 origin 是 null + 模块令牌)打得通,
 *    而同一身份打 `/collector/add` 是 403 —— 用户层里的小组件只能读,不能建、不能采;
 * 3. `/state.collectors` 跟着增删采变。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { WorkbenchState } from '../src/protocol.ts'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { createCustomModulesService } from '../src/server/modules.ts'
import { createModuleTokens } from '../src/server/moduleOrigin.ts'
import { COLLECTORS_DIR, createCollectorsService, type CollectorBrowser } from '../src/server/collectors.ts'

const NOW = Date.parse('2026-09-23T09:00:00+08:00')
const started: WorkbenchServer[] = []
const dirs: string[] = []
afterEach(async () => {
  while (started.length) await started.pop()?.close()
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

async function serve(opts: { withCollectors?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wb-collectors-http-'))
  dirs.push(dir)
  const workdir = join(dir, '运营')
  mkdirSync(workdir, { recursive: true })
  const modulesDir = join(dir, 'modules')
  mkdirSync(join(modulesDir, 'shop'), { recursive: true })
  writeFileSync(join(modulesDir, 'shop', 'module.json'), JSON.stringify({ version: 1, id: 'shop', name: '店铺', created_at: '2026-09-23T10:00:00+08:00' }), 'utf8')
  writeFileSync(join(modulesDir, 'shop', 'index.html'), '<!doctype html><html><body>店铺</body></html>', 'utf8')
  const calls: string[] = []
  const browser: CollectorBrowser = {
    openWindow: async (_dir, url) => { calls.push(`open ${url}`); return 9222 },
    readPage: async (_dir, url) => { calls.push(`read ${url}`); return { href: url, title: '店铺后台', text: '成交金额 ¥1,234.00\n访客数 88' } },
  }
  let t = NOW
  // 定义的真源是用户层那一格(2026-10-26 切割收尾);这里没接老位置迁移,defsDir 直接用工作目录下那一格,行为同旧。
  const collectors = createCollectorsService({ workdir: () => workdir, defsDir: join(workdir, COLLECTORS_DIR), profileRoot: join(dir, 'wb'), browser, now: () => t })
  await collectors.load()
  const tokens = createModuleTokens({ now: () => t })
  const server = await startWorkbenchServer({
    port: 0,
    service: createWorkbenchService({ now: () => Math.floor(NOW / 1000) }),
    tickIntervalMs: 0,
    modules: createCustomModulesService({ dir: modulesDir, now: () => t }),
    moduleOrigin: { port: 0, tokens },
    ...(opts.withCollectors === false ? {} : { collectors }),
  })
  started.push(server)
  return { url: server.url, workdir, calls, tokens, tick: (ms: number) => { t += ms } }
}

const post = async (url: string, path: string, body: unknown, headers: Record<string, string> = {}) => {
  const res = await fetch(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
  return { status: res.status, body: await res.json() as Record<string, any> }
}
const state = async (url: string) => await (await fetch(`${url}/state`)).json() as WorkbenchState
const asModule = (token: string) => ({ origin: 'null', authorization: `Bearer ${token}` })

describe('没接采集器', () => {
  it('★/collector/* 与 /module/data 一律 404,/state.collectors 缺席', async () => {
    const { url } = await serve({ withCollectors: false })
    expect((await state(url)).collectors).toBeUndefined()
    expect((await fetch(`${url}/collector`)).status).toBe(404)
    expect((await post(url, '/collector/add', { name: '店铺', url: 'https://x.y/' })).status).toBe(404)
    expect((await fetch(`${url}/module/data?name=店铺`)).status).toBe(404)
  })
})

describe('接上之后', () => {
  it('★建 → 登录 → 采 → /state.collectors 跟着变 → 撤', async () => {
    const h = await serve()
    expect((await state(h.url)).collectors).toEqual({ items: [] })

    const added = await post(h.url, '/collector/add', { name: '店铺', url: 'https://ark.xiaohongshu.com/app/data', note: '我开店了' })
    expect(added.status).toBe(200)
    expect(added.body.collector.name).toBe('店铺')
    expect((await post(h.url, '/collector/add', { name: '店铺', url: 'https://x.y/' })).status).toBe(400)

    const login = await post(h.url, '/collector/login', { name: '店铺' })
    expect(login.status).toBe(200)
    expect(String(login.body.note)).toContain('自己在里面登录')
    expect(h.calls).toEqual(['open https://ark.xiaohongshu.com/app/data'])

    const ran = await post(h.url, '/collector/run', { name: '店铺' })
    expect(ran.status).toBe(200)
    expect(ran.body.record.status).toBe('ok')
    const items = (await state(h.url)).collectors?.items ?? []
    expect(items[0]?.name).toBe('店铺')
    expect(items[0]?.latest_at).toBe(ran.body.record.at)
    expect(items[0]?.today).toBe(1)

    // 十分钟内再采:409 + 原话;浏览器没被再叫。
    const again = await post(h.url, '/collector/run', { name: '店铺' })
    expect(again.status).toBe(409)
    expect(String(again.body.error)).toContain('分钟')
    expect(h.calls.filter(one => one.startsWith('read'))).toHaveLength(1)

    const removed = await post(h.url, '/collector/remove', { name: '店铺' })
    expect(removed.status).toBe(200)
    expect((await state(h.url)).collectors?.items).toEqual([])
    expect((await post(h.url, '/collector/run', { name: '店铺' })).status).toBe(409)
  })

  it('★GET /collector 是清单;写路只认 POST;没有这条路由 404', async () => {
    const h = await serve()
    expect((await (await fetch(`${h.url}/collector`)).json())).toEqual({ items: [] })
    expect((await fetch(`${h.url}/collector/add`)).status).toBe(404)
    expect((await post(h.url, '/collector/什么', {})).status).toBe(404)
  })

  it('★小组件(模块身份)读得到 /module/data,却建不了、采不了、撤不了', async () => {
    const h = await serve()
    await post(h.url, '/collector/add', { name: '店铺', url: 'https://ark.xiaohongshu.com/app/data' })
    const token = h.tokens.issue('shop')

    // 还没采成过:200、text 空(没有 ≠ 错)。
    const empty = await fetch(`${h.url}/module/data?name=${encodeURIComponent('店铺')}`, { headers: asModule(token) })
    expect(empty.status).toBe(200)
    expect(await empty.json()).toMatchObject({ ok: true, name: '店铺', text: '' })

    await post(h.url, '/collector/run', { name: '店铺' })
    const got = await fetch(`${h.url}/module/data?name=${encodeURIComponent('店铺')}`, { headers: asModule(token) })
    expect(got.status).toBe(200)
    expect(got.headers.get('access-control-allow-origin')).toBe('null')
    const body = await got.json() as { ok: boolean, text: string, at?: string, last?: { status: string } }
    expect(body.text).toContain('访客数 88')
    expect(body.at).toBeDefined()
    expect(body.last?.status).toBe('ok')

    // 没有的采集器 404;名字拐弯也是 404(路径闸在服务里),读不到别的文件。
    expect((await fetch(`${h.url}/module/data?name=${encodeURIComponent('../账号')}`, { headers: asModule(token) })).status).toBe(404)
    expect((await fetch(`${h.url}/module/data`, { headers: asModule(token) })).status).toBe(404)

    // 同一身份打写路:白名单之外 403,一个字都不办。
    for (const path of ['/collector/add', '/collector/run', '/collector/remove', '/collector/login']) {
      const res = await post(h.url, path, { name: '店铺', url: 'https://x.y/' }, asModule(token))
      expect(res.status, path).toBe(403)
    }
    expect((await fetch(`${h.url}/collector`, { headers: asModule(token) })).status).toBe(403)
    // 不带令牌 401。
    expect((await fetch(`${h.url}/module/data?name=${encodeURIComponent('店铺')}`, { headers: { origin: 'null' } })).status).toBe(401)
  })
})
