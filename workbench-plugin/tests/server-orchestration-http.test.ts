// @vitest-environment node
/**
 * 窗口编排路由(spec W1–W9,Task 6):/snap /unsnap /scene/* + /state.scenes /state.snap。
 *
 * 起真服务实例(port 0)+ 假 orchestrator/scenes(记录调用、回预设值)，写法对齐
 * server-projects-http.test.ts / server-credentials.test.ts 的既有先例。
 */
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { HelperRect, SceneView, WorkbenchState } from '../src/protocol.ts'
import type { Orchestrator } from '../src/server/orchestrator.ts'
import type { RestoreReport, ScenesService } from '../src/server/scenes.ts'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { createAppsRegistry } from '../src/server/appsRegistry.ts'

const started: WorkbenchServer[] = []

/** 真实 appsRegistry 用的临时落盘位置(先例见 server-scenes.test.ts 的 tmpFile)。 */
async function tmpAppsFile(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), 'apps-registry-http-')), 'apps.json')
}

afterEach(async () => {
  while (started.length) await started.pop()?.close()
})

interface Call { fn: string, args: readonly unknown[] }

/** 假 orchestrator:记录调用,snapView() 按最近一次 snap/unsnap 自行维护(仿真实实现的语义)。 */
function fakeOrchestrator() {
  const calls: Call[] = []
  let snapResult: { ok: boolean, reason?: string } = { ok: true }
  let unsnapResult: { ok: boolean, reason?: string } = { ok: true }
  let view: ReturnType<Orchestrator['snapView']>

  const orchestrator: Orchestrator = {
    async snap(app: string, rect: HelperRect) {
      calls.push({ fn: 'snap', args: [app, rect] })
      view = snapResult.ok
        ? { app, state: 'snapped' }
        : { app, state: 'failed', ...(snapResult.reason === undefined ? {} : { reason: snapResult.reason }) }
      return snapResult
    },
    async unsnap() {
      calls.push({ fn: 'unsnap', args: [] })
      view = undefined
      return unsnapResult
    },
    snapView() {
      return view
    },
  }

  return {
    orchestrator,
    calls,
    setSnapResult: (r: { ok: boolean, reason?: string }) => { snapResult = r },
    setUnsnapResult: (r: { ok: boolean, reason?: string }) => { unsnapResult = r },
  }
}

/** 假 scenes:记录调用,各方法回预设值;list() 可配成抛错以测 tryCall 纪律。 */
function fakeScenes() {
  const calls: Call[] = []
  let listResult: SceneView[] = []
  let listThrows = false
  let saveResult: { ok: boolean, reason?: string } = { ok: true }
  let createResult: { ok: boolean, id?: string, reason?: string } = { ok: true, id: 's-new' }
  let renameResult = true
  let removeResult = true
  let restoreResult: RestoreReport = { ok: true, apps: [] }

  const scenes: ScenesService = {
    async list() {
      calls.push({ fn: 'list', args: [] })
      if (listThrows) throw new Error('scenes 文件读坏了')
      return listResult
    },
    async save(id: string) {
      calls.push({ fn: 'save', args: [id] })
      return saveResult
    },
    async create(name: string) {
      calls.push({ fn: 'create', args: [name] })
      return createResult
    },
    async rename(id: string, name: string) {
      calls.push({ fn: 'rename', args: [id, name] })
      return renameResult
    },
    async remove(id: string) {
      calls.push({ fn: 'remove', args: [id] })
      return removeResult
    },
    async restore(id: string) {
      calls.push({ fn: 'restore', args: [id] })
      return restoreResult
    },
  }

  return {
    scenes,
    calls,
    setListResult: (r: SceneView[]) => { listResult = r },
    setListThrows: (v: boolean) => { listThrows = v },
    setSaveResult: (r: { ok: boolean, reason?: string }) => { saveResult = r },
    setCreateResult: (r: { ok: boolean, id?: string, reason?: string }) => { createResult = r },
    setRenameResult: (r: boolean) => { renameResult = r },
    setRemoveResult: (r: boolean) => { removeResult = r },
    setRestoreResult: (r: RestoreReport) => { restoreResult = r },
  }
}

/** 假 appsRegistry(spec S4):记录调用,list()/add()/remove() 回预设值。 */
function fakeRegistry() {
  const calls: Call[] = []
  let listResult: { key: string, label: string }[] = [{ key: 'claude', label: 'Claude' }]
  let addResult: { ok: boolean, key?: string, reason?: string } = { ok: true, key: 'c-notion' }
  let removeResult: { ok: boolean, reason?: string } = { ok: true }

  const registry = {
    async list() {
      calls.push({ fn: 'list', args: [] })
      return listResult
    },
    async listAll() {
      calls.push({ fn: 'listAll', args: [] })
      return listResult
    },
    async enable(keys: readonly string[]) {
      calls.push({ fn: 'enable', args: [...keys] })
      return { enabled: [...keys], already: [], unknown: [] }
    },
    async commandFor(key: string) {
      calls.push({ fn: 'commandFor', args: [key] })
      return undefined
    },
    async bundleFor(key: string) {
      calls.push({ fn: 'bundleFor', args: [key] })
      return undefined
    },
    async keyFor(bundleId: string) {
      calls.push({ fn: 'keyFor', args: [bundleId] })
      return undefined
    },
    async add(name: string, label?: string) {
      calls.push({ fn: 'add', args: [name, label] })
      return addResult
    },
    async remove(key: string) {
      calls.push({ fn: 'remove', args: [key] })
      return removeResult
    },
    async addResolved(info: { bundle_id: string, name: string }) {
      calls.push({ fn: 'addResolved', args: [info.bundle_id, info.name] })
      return { ok: true, key: 'c-resolved' }
    },
  }

  return {
    registry,
    calls,
    setListResult: (r: { key: string, label: string }[]) => { listResult = r },
    setAddResult: (r: { ok: boolean, key?: string, reason?: string }) => { addResult = r },
    setRemoveResult: (r: { ok: boolean, reason?: string }) => { removeResult = r },
  }
}

async function post(url: string, path: string, body: unknown) {
  const res = await fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: await res.json() as Record<string, unknown> }
}

async function serve(extra: Partial<Parameters<typeof startWorkbenchServer>[0]> = {}) {
  const service = createWorkbenchService()
  const server = await startWorkbenchServer({ port: 0, service, tickIntervalMs: 0, ...extra })
  started.push(server)
  return { server, service, url: server.url }
}

const RECT: HelperRect = { x: 0, y: 0, w: 640, h: 480 }

describe('窗口编排路由', () => {
  it('POST /snap 校验 body:app 非空字符串、rect 四项有限数字;缺一样 400', async () => {
    const { orchestrator } = fakeOrchestrator()
    const { url } = await serve({ orchestrator })

    // app 缺失
    expect((await post(url, '/snap', { rect: RECT })).status).toBe(400)
    // app 是空字符串
    expect((await post(url, '/snap', { app: '', rect: RECT })).status).toBe(400)
    // app 不是字符串
    expect((await post(url, '/snap', { app: 123, rect: RECT })).status).toBe(400)
    // rect 缺失
    expect((await post(url, '/snap', { app: 'claude' })).status).toBe(400)
    // rect 缺一项
    expect((await post(url, '/snap', { app: 'claude', rect: { x: 0, y: 0, w: 640 } })).status).toBe(400)
    // rect 某一项不是有限数字
    expect((await post(url, '/snap', { app: 'claude', rect: { x: 0, y: 0, w: 640, h: Number.NaN } })).status).toBe(400)
    expect((await post(url, '/snap', { app: 'claude', rect: { x: 0, y: 0, w: 640, h: '480' } })).status).toBe(400)
  })

  it('POST /snap 转呼 orchestrator.snap(app, rect) 并原样回结果;成功后 /state.snap 反映', async () => {
    const fake = fakeOrchestrator()
    const { url } = await serve({ orchestrator: fake.orchestrator })

    const res = await post(url, '/snap', { app: 'claude', rect: RECT })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
    expect(fake.calls).toEqual([{ fn: 'snap', args: ['claude', RECT] }])

    const state = await (await fetch(`${url}/state`)).json() as WorkbenchState
    expect(state.snap).toEqual({ app: 'claude', state: 'snapped' })
  })

  it('POST /snap 业务失败(orchestrator 回 ok:false)时 HTTP 层仍是 200,原样透传 reason', async () => {
    const fake = fakeOrchestrator()
    fake.setSnapResult({ ok: false, reason: '贴合失败:窗口没有落到槽位' })
    const { url } = await serve({ orchestrator: fake.orchestrator })

    const res = await post(url, '/snap', { app: 'claude', rect: RECT })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: false, reason: '贴合失败:窗口没有落到槽位' })

    const state = await (await fetch(`${url}/state`)).json() as WorkbenchState
    expect(state.snap).toEqual({ app: 'claude', state: 'failed', reason: '贴合失败:窗口没有落到槽位' })
  })

  it('POST /unsnap 转呼 orchestrator.unsnap;/state.snap 变缺省', async () => {
    const fake = fakeOrchestrator()
    const { url } = await serve({ orchestrator: fake.orchestrator })

    // 先贴合一次,让 /state.snap 有值。
    await post(url, '/snap', { app: 'claude', rect: RECT })
    expect((await (await fetch(`${url}/state`)).json() as WorkbenchState).snap).toBeDefined()

    const res = await post(url, '/unsnap', {})
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
    expect(fake.calls.at(-1)).toEqual({ fn: 'unsnap', args: [] })

    const state = await (await fetch(`${url}/state`)).json() as WorkbenchState
    expect(state.snap).toBeUndefined()
  })

  it('POST /scene/restore 回完整 RestoreReport(含逐应用成败)', async () => {
    const fake = fakeScenes()
    const report: RestoreReport = {
      ok: false,
      apps: [
        { app: 'claude', ok: true },
        { app: 'codex', ok: false, reason: '窗口数不符:存了 2 个,现在只有 1 个,已尽力摆' },
      ],
    }
    fake.setRestoreResult(report)
    const { url } = await serve({ scenes: fake.scenes })

    const res = await post(url, '/scene/restore', { id: 'work' })
    expect(res.status).toBe(200)
    expect(res.body).toEqual(report)
    // 成功后 broadcast 会走 composeState()→scenes.list() 组装 /state.scenes,这里只关心业务调用本身。
    expect(fake.calls.filter(c => c.fn !== 'list')).toEqual([{ fn: 'restore', args: ['work'] }])
  })

  it('POST /scene/restore 缺 id 时 400,不转呼', async () => {
    const fake = fakeScenes()
    const { url } = await serve({ scenes: fake.scenes })

    const res = await post(url, '/scene/restore', {})
    expect(res.status).toBe(400)
    expect(fake.calls).toEqual([])
  })

  describe('/scene/save·create·rename·delete 各自校验与转呼;/state.scenes 反映 list()', () => {
    it('POST /scene/save:缺 id 400;有 id 转呼 scenes.save(id) 并原样回结果', async () => {
      const fake = fakeScenes()
      fake.setSaveResult({ ok: false, reason: '当前没有可保存的窗口' })
      const { url } = await serve({ scenes: fake.scenes })

      expect((await post(url, '/scene/save', {})).status).toBe(400)

      const res = await post(url, '/scene/save', { id: 'work' })
      expect(res.status).toBe(200)
      expect(res.body).toEqual({ ok: false, reason: '当前没有可保存的窗口' })
      expect(fake.calls.filter(c => c.fn !== 'list')).toEqual([{ fn: 'save', args: ['work'] }])
    })

    it('POST /scene/create:name 必须是字符串,否则 400;转呼 scenes.create(name)', async () => {
      const fake = fakeScenes()
      fake.setCreateResult({ ok: true, id: 's-abcd1234' })
      const { url } = await serve({ scenes: fake.scenes })

      expect((await post(url, '/scene/create', {})).status).toBe(400)
      expect((await post(url, '/scene/create', { name: 123 })).status).toBe(400)

      const res = await post(url, '/scene/create', { name: '摸鱼' })
      expect(res.status).toBe(200)
      expect(res.body).toEqual({ ok: true, id: 's-abcd1234' })
      expect(fake.calls.filter(c => c.fn !== 'list')).toEqual([{ fn: 'create', args: ['摸鱼'] }])
    })

    it('POST /scene/rename:缺 id 或 name 400;转呼 scenes.rename(id, name),没有这个场景回 404', async () => {
      const fake = fakeScenes()
      const { url } = await serve({ scenes: fake.scenes })

      expect((await post(url, '/scene/rename', { id: 'work' })).status).toBe(400)
      expect((await post(url, '/scene/rename', { name: '新名字' })).status).toBe(400)

      const ok = await post(url, '/scene/rename', { id: 'work', name: '新名字' })
      expect(ok.status).toBe(200)
      expect(ok.body).toEqual({ ok: true })
      expect(fake.calls.filter(c => c.fn !== 'list')).toEqual([{ fn: 'rename', args: ['work', '新名字'] }])

      fake.setRenameResult(false)
      const missing = await post(url, '/scene/rename', { id: '不存在', name: 'x' })
      expect(missing.status).toBe(404)
    })

    it('POST /scene/delete:缺 id 400;转呼 scenes.remove(id),没有这个场景回 404', async () => {
      const fake = fakeScenes()
      const { url } = await serve({ scenes: fake.scenes })

      expect((await post(url, '/scene/delete', {})).status).toBe(400)

      const ok = await post(url, '/scene/delete', { id: 'work' })
      expect(ok.status).toBe(200)
      expect(ok.body).toEqual({ ok: true })
      expect(fake.calls.filter(c => c.fn !== 'list')).toEqual([{ fn: 'remove', args: ['work'] }])

      fake.setRemoveResult(false)
      const missing = await post(url, '/scene/delete', { id: '不存在' })
      expect(missing.status).toBe(404)
    })

    it('/state.scenes 反映 scenes.list() 的当前结果', async () => {
      const fake = fakeScenes()
      const list: SceneView[] = [
        { id: 'work', name: '干活', app_count: 3, saved_at: '2026-08-21T00:00:00.000Z' },
        { id: 'talk', name: '沟通', app_count: 0 },
      ]
      fake.setListResult(list)
      const { url } = await serve({ scenes: fake.scenes })

      const state = await (await fetch(`${url}/state`)).json() as WorkbenchState
      expect(state.scenes).toEqual(list)
    })
  })

  describe('/apps/add·remove(spec S4:窗口槽应用增删)', () => {
    it('POST /apps/add:缺 name 400;转呼 registry.add(name, label) 并原样回结果', async () => {
      const fake = fakeRegistry()
      const { url } = await serve({ registry: fake.registry })

      expect((await post(url, '/apps/add', {})).status).toBe(400)
      expect((await post(url, '/apps/add', { name: '' })).status).toBe(400)

      const res = await post(url, '/apps/add', { name: 'Notion', label: '笔记' })
      expect(res.status).toBe(200)
      expect(res.body).toEqual({ ok: true, key: 'c-notion' })
      // broadcast 会走 composeState()→registry.list() 组装 /state.apps,这里只关心业务调用本身。
      expect(fake.calls.filter(c => c.fn !== 'list')).toEqual([{ fn: 'add', args: ['Notion', '笔记'] }])
    })

    it('POST /apps/add 业务失败(registry 回 ok:false)时 HTTP 层仍是 200,原样透传 reason', async () => {
      const fake = fakeRegistry()
      fake.setAddResult({ ok: false, reason: '找不到应用:不存在的App' })
      const { url } = await serve({ registry: fake.registry })

      const res = await post(url, '/apps/add', { name: '不存在的App' })
      expect(res.status).toBe(200)
      expect(res.body).toEqual({ ok: false, reason: '找不到应用:不存在的App' })
    })

    it('POST /apps/remove:缺 key 400;转呼 registry.remove(key) 并原样回结果', async () => {
      const fake = fakeRegistry()
      const { url } = await serve({ registry: fake.registry })

      expect((await post(url, '/apps/remove', {})).status).toBe(400)

      const res = await post(url, '/apps/remove', { key: 'c-notion' })
      expect(res.status).toBe(200)
      expect(res.body).toEqual({ ok: true })
      expect(fake.calls.filter(c => c.fn !== 'list')).toEqual([{ fn: 'remove', args: ['c-notion'] }])
    })

    it('POST /apps/remove 业务失败(registry 回 ok:false)时 HTTP 层仍是 200,原样透传 reason', async () => {
      const fake = fakeRegistry()
      fake.setRemoveResult({ ok: false, reason: '没有这个应用' })
      const { url } = await serve({ registry: fake.registry })

      const res = await post(url, '/apps/remove', { key: 'c-nope' })
      expect(res.status).toBe(200)
      expect(res.body).toEqual({ ok: false, reason: '没有这个应用' })
    })

    it('POST /apps/remove 基础应用:用真实 registry(非假的)—— A5 起改为可删(退出清单),ok:true', async () => {
      const registry = createAppsRegistry({ file: await tmpAppsFile(), runOsascript: async () => ({ ok: false, stdout: '' }) })
      const { url } = await serve({ registry })

      const res = await post(url, '/apps/remove', { key: 'claude' })
      expect(res.status).toBe(200)
      expect(res.body).toEqual({ ok: true })

      const state = await (await fetch(`${url}/state`)).json() as WorkbenchState
      expect(state.apps?.some(app => app.key === 'claude')).toBe(false)
    })

    it('/state.apps 反映 registry.list()', async () => {
      const fake = fakeRegistry()
      const list = [{ key: 'claude', label: 'Claude' }, { key: 'c-notion', label: 'Notion' }]
      fake.setListResult(list)
      const { url } = await serve({ registry: fake.registry })

      const state = await (await fetch(`${url}/state`)).json() as WorkbenchState
      expect(state.apps).toEqual(list)
    })
  })

  describe('orchestrator/scenes/registry 未接线:对应路由 404「窗口编排未启用」', () => {
    it('未传 orchestrator:/snap /unsnap 404', async () => {
      const { url } = await serve()

      const snap = await post(url, '/snap', { app: 'claude', rect: RECT })
      expect(snap.status).toBe(404)
      expect(snap.body).toEqual({ error: '窗口编排未启用' })

      const unsnap = await post(url, '/unsnap', {})
      expect(unsnap.status).toBe(404)
      expect(unsnap.body).toEqual({ error: '窗口编排未启用' })
    })

    it('未传 scenes:/scene/save·create·restore·rename·delete 均 404', async () => {
      const { url } = await serve()

      for (const [path, body] of [
        ['/scene/save', { id: 'work' }],
        ['/scene/create', { name: 'x' }],
        ['/scene/restore', { id: 'work' }],
        ['/scene/rename', { id: 'work', name: 'y' }],
        ['/scene/delete', { id: 'work' }],
      ] as const) {
        const res = await post(url, path, body)
        expect(res.status).toBe(404)
        expect(res.body).toEqual({ error: '窗口编排未启用' })
      }
    })

    it('未传 registry:/apps/add /apps/remove 均 404', async () => {
      const { url } = await serve()

      const add = await post(url, '/apps/add', { name: 'Notion' })
      expect(add.status).toBe(404)
      expect(add.body).toEqual({ error: '窗口编排未启用' })

      const remove = await post(url, '/apps/remove', { key: 'c-notion' })
      expect(remove.status).toBe(404)
      expect(remove.body).toEqual({ error: '窗口编排未启用' })
    })

    it('未接线时 /state 不带 scenes/snap/apps 字段', async () => {
      const { url } = await serve()
      const state = await (await fetch(`${url}/state`)).json() as WorkbenchState
      expect(state.scenes).toBeUndefined()
      expect(state.snap).toBeUndefined()
      expect(state.apps).toBeUndefined()
    })
  })

  describe('非回环来源(isLoopback: () => false):全部编排写路由 403', () => {
    it('/snap /unsnap /scene/* /apps/* 全部 403,且不转呼任何服务', async () => {
      const fakeOrch = fakeOrchestrator()
      const fakeScn = fakeScenes()
      const fakeReg = fakeRegistry()
      const { url } = await serve({
        orchestrator: fakeOrch.orchestrator,
        scenes: fakeScn.scenes,
        registry: fakeReg.registry,
        isLoopback: () => false,
      })

      const snap = await post(url, '/snap', { app: 'claude', rect: RECT })
      expect(snap.status).toBe(403)
      const unsnap = await post(url, '/unsnap', {})
      expect(unsnap.status).toBe(403)

      for (const [path, body] of [
        ['/scene/save', { id: 'work' }],
        ['/scene/create', { name: 'x' }],
        ['/scene/restore', { id: 'work' }],
        ['/scene/rename', { id: 'work', name: 'y' }],
        ['/scene/delete', { id: 'work' }],
      ] as const) {
        const res = await post(url, path, body)
        expect(res.status).toBe(403)
      }

      const appsAdd = await post(url, '/apps/add', { name: 'Notion' })
      expect(appsAdd.status).toBe(403)
      const appsRemove = await post(url, '/apps/remove', { key: 'c-notion' })
      expect(appsRemove.status).toBe(403)
      expect(fakeReg.calls).toEqual([])

      expect(fakeOrch.calls).toEqual([])
      expect(fakeScn.calls).toEqual([])
    })
  })

  it('scenes.list() 抛错时 /state 照常返回,只缺 scenes 字段(tryCall 纪律)', async () => {
    const fake = fakeScenes()
    fake.setListThrows(true)
    const { url } = await serve({ scenes: fake.scenes })

    const res = await fetch(`${url}/state`)
    expect(res.status).toBe(200)
    const state = await res.json() as WorkbenchState
    expect(state.scenes).toBeUndefined()
    // 其余字段照常在,不被这一个可选服务的异常拖垮。
    expect(state.sessions).toEqual([])
  })
})
