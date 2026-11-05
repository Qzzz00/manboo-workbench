// @vitest-environment node
/**
 * 布局模板的三条路由(2026-09-21):`GET /template`、`POST /template/apply`、`POST /template/restore`。
 *
 * 除了三条路由本身,这一份还钉两件跟「不重启工作台」直接相关的事:
 *   ① apply 成功要**广播一次快照** —— 界面每秒轮询一次 /state,不需要 reload;
 *   ② `/state.template` 里的模块标题、素材目录、网页应用在下一次 GET 就是新的。
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import type { LiveMessage, WorkbenchLayout, WorkbenchState } from '../src/protocol.ts'
import type { WorkbenchServer } from '../src/server/http.ts'
import { startWorkbenchServer } from '../src/server/http.ts'
import { createWorkbenchService } from '../src/server/service.ts'
import { createTemplateService } from '../src/server/templateStore.ts'
import { DEFAULT_LANDSCAPE_MODULES } from '../src/client/layout.ts'
import { PRODUCT_TEMPLATE } from '../src/templates.ts'
import { loadStarterLayoutTemplate } from './helpers/starterLayer.ts'

const OPS_TEMPLATE = await loadStarterLayoutTemplate()

const NOW_SEC = Math.floor(Date.parse('2026-09-21T02:00:00Z') / 1000)
const started: WorkbenchServer[] = []
const dirs: string[] = []

afterEach(async () => {
  while (started.length) await started.pop()?.close()
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wb-tpl-http-'))
  dirs.push(dir)
  return dir
}

async function serve(opts: { cwd?: string, withTemplate?: boolean } = {}) {
  const dir = tmpDir()
  let layout: WorkbenchLayout | undefined = {
    modules: [],
    butler: { corner: 'br', min: false },
    landscape: { modules: DEFAULT_LANDSCAPE_MODULES.map(m => ({ ...m })) },
  }
  // 2026-10-23(分层二刀二):ops 模板的内容在用户层起步层,本体只剩 product —— 用例里注入这一份。
  // templatesRef 可换:模拟「用户层那份 ops.json 没了 / 修好了」(真实机上由 scan() 每拍刷新快照)。
  const templatesRef: { list: readonly import('../src/templates.ts').WorkbenchTemplate[] } = { list: [OPS_TEMPLATE] }
  const template = createTemplateService({
    file: join(dir, 'template.json'),
    backupsDir: join(dir, 'backups'),
    readLayout: () => Promise.resolve(layout),
    writeLayout: (next) => { layout = next; return Promise.resolve() },
    templates: () => templatesRef.list,
    ...(opts.cwd === undefined ? {} : { butlerCwd: () => opts.cwd }),
  })
  await template.load()
  const service = createWorkbenchService({ now: () => NOW_SEC })
  const server = await startWorkbenchServer({
    port: 0,
    service,
    tickIntervalMs: 0,
    // 项目区桩:只提供 getLayout / setLayout 两件(模板卡本身不扫描项目;/state.layout 的退回要用它)。
    projects: {
      getProjectsState: () => Promise.resolve({ projects: [], pending: [], scan_errors: [], scanned_at: new Date(NOW_SEC * 1000).toISOString() }),
      confirmStatus: () => Promise.resolve(false),
      setDdl: () => Promise.resolve(false),
      addRule: () => Promise.resolve(),
      getLayout: () => Promise.resolve(layout),
      setLayout: (next) => { layout = next; return Promise.resolve() },
      invalidateScanCache: () => {},
    },
    ...(opts.withTemplate === false ? {} : { template }),
  })
  started.push(server)
  return { url: server.url, dir, template, layout: () => layout, templatesRef }
}

async function post(url: string, path: string, body: unknown) {
  const res = await fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: await res.json() as Record<string, unknown> }
}

async function getJson(url: string, path: string) {
  const res = await fetch(`${url}${path}`)
  return { status: res.status, body: await res.json() as Record<string, unknown> }
}

async function live(url: string) {
  const ws = new WebSocket(`${url.replace('http://', 'ws://')}/live`)
  const messages: LiveMessage[] = []
  ws.on('message', raw => messages.push(JSON.parse(String(raw)) as LiveMessage))
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve())
    ws.once('error', reject)
  })
  return {
    messages,
    close: () => ws.close(),
    async waitFor(n: number) {
      const deadline = Date.now() + 2000
      while (messages.length < n) {
        if (Date.now() > deadline) throw new Error(`只收到 ${messages.length} 条,期望 ${n} 条`)
        await new Promise(r => setTimeout(r, 10))
      }
      return messages
    },
  }
}

describe('GET /template', () => {
  it('两张卡片 + 当前是哪个', async () => {
    const { url } = await serve()
    const got = await getJson(url, '/template')
    expect(got.status).toBe(200)
    expect(got.body.current).toBe('product')
    expect((got.body.templates as { id: string }[]).map(t => t.id)).toEqual(['product', 'ops'])
  })

  it('没接模板服务 → 404「布局模板未启用」', async () => {
    const { url } = await serve({ withTemplate: false })
    const got = await getJson(url, '/template')
    expect(got.status).toBe(404)
    expect(String(got.body.error)).toContain('布局模板未启用')
  })
})

describe('POST /template/apply', () => {
  it('切到 ops:200,布局换了,当前模板落盘', async () => {
    const { url, dir, layout } = await serve()
    const applied = await post(url, '/template/apply', { id: 'ops' })
    expect(applied.status).toBe(200)
    expect(applied.body.ok).toBe(true)
    expect(layout()?.landscape?.modules).toEqual(OPS_TEMPLATE.landscape)
    expect(JSON.parse(readFileSync(join(dir, 'template.json'), 'utf8')).id).toBe('ops')
  })

  it('认不出的 id → 400(请求写错了),不是 200 + ok:false', async () => {
    const { url } = await serve()
    const bad = await post(url, '/template/apply', { id: '我编的' })
    expect(bad.status).toBe(400)
    expect(String(bad.body.error)).toContain('没有这个模板')
  })

  it('坏 JSON → 400', async () => {
    const { url } = await serve()
    const res = await fetch(`${url}/template/apply`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{',
    })
    expect(res.status).toBe(400)
  })

  it('没接模板服务 → 404', async () => {
    const { url } = await serve({ withTemplate: false })
    expect((await post(url, '/template/apply', { id: 'ops' })).status).toBe(404)
  })

  it('**切完广播一次快照** —— 界面下一拍就换,不用 reload、不用重启', async () => {
    const { url } = await serve()
    const socket = await live(url)
    try {
      await socket.waitFor(1) // 连上那一刻的第一份快照
      await post(url, '/template/apply', { id: 'ops' })
      const messages = await socket.waitFor(2)
      const last = messages[messages.length - 1]
      expect(last?.kind).toBe('snapshot')
      expect((last as { state: WorkbenchState }).state.template?.id).toBe('ops')
    }
    finally {
      socket.close()
    }
  })
})

describe('/state.template', () => {
  it('切之前是做产品那一套文案', async () => {
    const { url } = await serve()
    const state = (await getJson(url, '/state')).body as unknown as WorkbenchState
    expect(state.template).toMatchObject({
      id: 'product', name: '做产品', project_word: '项目', has_backup: false,
    })
    expect(state.template?.module_titles.files).toBe('图谱')
    expect(state.template?.board_lanes).toEqual([])
  })

  it('切完:标题换了、看板列有了、网页应用有了、备份有了', async () => {
    const { url } = await serve()
    await post(url, '/template/apply', { id: 'ops' })
    const state = (await getJson(url, '/state')).body as unknown as WorkbenchState
    expect(state.template?.id).toBe('ops')
    expect(state.template?.project_word).toBe('账号')
    expect(state.template?.module_titles.files).toBe('素材管理')
    expect(state.template?.module_titles.projects).toBe('账号')
    expect(state.template?.board_lanes.length).toBe(8)
    expect(state.template?.web_apps?.map(app => app.label)).toEqual(['可灵', '小红书', '可画'])
    expect(state.template?.has_backup).toBe(true)
  })

  it('配了工作目录才有素材那几个绝对路径', async () => {
    const cwd = tmpDir()
    const { url } = await serve({ cwd })
    await post(url, '/template/apply', { id: 'ops' })
    const state = (await getJson(url, '/state')).body as unknown as WorkbenchState
    expect(state.template?.asset_dirs?.脚本).toBe(`${cwd}/素材/脚本`)
  })

  it('没接模板服务 → /state.template 整块缺席', async () => {
    const { url } = await serve({ withTemplate: false })
    const state = (await getJson(url, '/state')).body as unknown as WorkbenchState
    expect(state.template).toBeUndefined()
  })

  /**
   * 2026-10-23(分层二刀二):她删了 / 改坏了 用户层/布局/ops.json → 模板的横竖网格跟着退回
   * product 那一份(不只补个 today 格),皮肤那边也没有可注入的(客户端用例钉)。
   * 修好(来源重新认得 ops)→ 下一拍自己回来。
   */
  it('★盘上记的模板认不出来 → /state.template 是 product,横竖 modules 是 product 那一份;修好恢复', async () => {
    const { url, templatesRef, layout } = await serve()
    await post(url, '/template/apply', { id: 'ops' })
    expect(((await getJson(url, '/state')).body as unknown as WorkbenchState).template?.id).toBe('ops')
    // 用户层那份 ops.json 没了(清单里认不出 ops)。
    templatesRef.list = []
    const fallen = (await getJson(url, '/state')).body as unknown as WorkbenchState
    expect(fallen.template?.id).toBe('product')
    expect(fallen.layout?.modules).toEqual(PRODUCT_TEMPLATE.portrait)
    expect(fallen.layout?.landscape?.modules).toEqual(PRODUCT_TEMPLATE.landscape)
    // 读路径的退回不反写她盘上的布局:盘里那份还是运营网格(来源恢复后照旧用)。
    expect(layout()?.modules).toEqual(OPS_TEMPLATE.portrait)
    // 修好(放回去 / 改好)→ 下一拍 template 与网格自己回来。
    templatesRef.list = [OPS_TEMPLATE]
    const back = (await getJson(url, '/state')).body as unknown as WorkbenchState
    expect(back.template?.id).toBe('ops')
    expect(back.layout?.modules).toEqual(OPS_TEMPLATE.portrait)
  })
})

describe('POST /template/restore', () => {
  it('回退:布局与当前模板一起还原,并广播一次', async () => {
    const { url, layout } = await serve()
    await post(url, '/template/apply', { id: 'ops' })
    const socket = await live(url)
    try {
      await socket.waitFor(1)
      const restored = await post(url, '/template/restore', {})
      expect(restored.status).toBe(200)
      expect(restored.body).toMatchObject({ ok: true, template_id: 'product' })
      expect(layout()?.landscape?.modules).toEqual(DEFAULT_LANDSCAPE_MODULES)
      const messages = await socket.waitFor(2)
      expect(messages[messages.length - 1]?.kind).toBe('snapshot')
    }
    finally {
      socket.close()
    }
  })

  it('没切过就回退:**200 + ok:false + 一句人话**(业务拒绝不是接口出错)', async () => {
    const { url } = await serve()
    const restored = await post(url, '/template/restore', {})
    expect(restored.status).toBe(200)
    expect(restored.body.ok).toBe(false)
    expect(String(restored.body.reason)).toContain('没有可回退')
  })
})
